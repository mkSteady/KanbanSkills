/**
 * Dashboard web server
 * Single-file dashboard (inline CSS/JS) + JSON APIs + SSE
 */

import http from 'http';
import path from 'path';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { matchesIgnoreInclude, readJsonSafe, writeJsonSafe } from '../lib/shared.js';
import { getCachePath, loadStaleConfig } from '../lib/context.js';
import { TaskManager, TASK_TYPES } from '../lib/task/manager.js';
import { checkStale as checkStaleStatus } from '../lib/update/index.js';

/** @typedef {import('../lib/types.js').ProjectConfig} ProjectConfig */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_CACHE = new Map();
const CACHE_TTL_MS = {
  status: 1000,
  modules: 2000,
  tasks: 1000,
  deps: 5000,
  staleStatus: 30000,
  taskDetails: 1000,
  history: 5000
};

/**
 * @param {string} input
 * @returns {string}
 */
function normalizeRelPath(input) {
  return String(input || '')
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

/**
 * @param {any} err
 * @returns {string}
 */
function toErrorMessage(err) {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message || String(err);
  const msg = err?.message;
  return typeof msg === 'string' && msg.trim() ? msg : String(err);
}

/**
 * Cache helper: returns cached data immediately; refreshes in background when stale.
 * @template T
 * @param {string} key
 * @param {number} ttlMs
 * @param {() => Promise<T>} fetcher
 * @returns {Promise<T>}
 */
async function cachedFetch(key, ttlMs, fetcher) {
  const now = Date.now();
  const cached = API_CACHE.get(key);

  if (cached?.data && now - cached.time < ttlMs) {
    return cached.data;
  }

  if (cached?.data) {
    if (!cached.promise) {
      const promise = (async () => {
        try {
          return await fetcher();
        } catch (err) {
          return /** @type {any} */ ({ error: toErrorMessage(err) });
        }
      })().then((data) => {
        API_CACHE.set(key, { data, time: Date.now() });
        return data;
      });
      API_CACHE.set(key, { ...cached, promise });
    }
    return cached.data;
  }

  if (cached?.promise) {
    return cached.promise;
  }

  const promise = (async () => {
    try {
      return await fetcher();
    } catch (err) {
      return /** @type {any} */ ({ error: toErrorMessage(err) });
    }
  })();

  API_CACHE.set(key, { promise });
  const data = await promise;
  API_CACHE.set(key, { data, time: Date.now() });
  return data;
}

/**
 * Remove cachedFetch entries whose key starts with prefix.
 * @param {string} prefix
 */
function invalidateApiCache(prefix) {
  for (const key of Array.from(API_CACHE.keys())) {
    if (String(key).startsWith(prefix)) API_CACHE.delete(key);
  }
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {any} data
 */
function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {string} html
 */
function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(html);
}

/**
 * @param {http.ServerResponse} res
 * @param {string} event
 * @param {any} data
 */
function sseSend(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * @param {{root: string, config: ProjectConfig, staleConfig?: any}} ctx
 * @returns {{root: string, config: ProjectConfig, staleConfig?: any}}
 */
function normalizeCtx(ctx) {
  const root = ctx?.root ? String(ctx.root) : process.cwd();
  const config = { ...(ctx?.config || /** @type {any} */({})) };
  if (config.cache && !path.isAbsolute(config.cache)) {
    config.cache = path.join(root, String(config.cache));
  }
  return { ...ctx, root, config };
}

/**
 * Read modules list from cache.
 * @param {{root: string, config: ProjectConfig, staleConfig?: any}} ctx
 */
async function readModules(ctx) {
  const cachePath = getCachePath(ctx.config, ctx.root, '.module-analyzer-tasks.json');
  const tasksFile = await readJsonSafe(cachePath, null);
  const tasks = Array.isArray(tasksFile?.tasks) ? tasksFile.tasks : (Array.isArray(tasksFile?.items) ? tasksFile.items : []);

  const ignore = ctx.staleConfig?.ignore || [];
  const include = ctx.staleConfig?.include || [];

  /** @type {Array<{id: string, path: string, enableDoc: boolean, enableAudit: boolean}>} */
  const modules = [];

  for (const t of tasks) {
    const context = t?.context || t || {};
    const modulePath = normalizeRelPath(context.modulePath || context.fullPath || t.module || t.id);
    if (!modulePath) continue;
    if (!matchesIgnoreInclude(modulePath, ignore, include)) continue;
    modules.push({
      id: modulePath,
      path: modulePath,
      enableDoc: Boolean(context.enableDoc),
      enableAudit: Boolean(context.enableAudit)
    });
  }

  modules.sort((a, b) => a.path.localeCompare(b.path));

  return {
    cachePath,
    timestamp: tasksFile?.timestamp || null,
    modules
  };
}

/**
 * @param {{root: string, config: ProjectConfig}} ctx
 */
async function readStaleModules(ctx) {
  const cachePath = getCachePath(ctx.config, ctx.root, '.stale-modules.json');
  const data = await readJsonSafe(cachePath, null);
  const list = Array.isArray(data?.stale) ? data.stale : [];
  /** @type {Map<string, any>} */
  const byPath = new Map();
  for (const item of list) {
    const p = normalizeRelPath(item?.path);
    if (!p) continue;
    byPath.set(p, item);
  }
  return {
    cachePath,
    timestamp: data?.timestamp || null,
    byPath
  };
}

/**
 * @param {{root: string, config: ProjectConfig, staleConfig?: any}} ctx
 */
async function readTestStatus(ctx) {
  const cachePath = getCachePath(ctx.config, ctx.root, '.test-status.json');
  const data = await readJsonSafe(cachePath, null);
  const files = Array.isArray(data?.files) ? data.files : [];

  const ignore = ctx.staleConfig?.ignore || [];
  const include = ctx.staleConfig?.include || [];
  const filteredFiles = files.filter(f => matchesIgnoreInclude(f?.source, ignore, include));

  const summaryRaw = data?.summary || {};
  const summaryFromFiles = {
    total: filteredFiles.length,
    covered: filteredFiles.filter(f => f.status === 'covered').length,
    untested: filteredFiles.filter(f => f.status === 'untested').length,
    stale: filteredFiles.filter(f => f.status === 'stale').length
  };

  // Prefer recalculating from file-level data (scoped by ignore/include); fall back to summary for older cache formats.
  const summary = files.length > 0 ? summaryFromFiles : {
    total: Number.isFinite(summaryRaw.total) ? summaryRaw.total : 0,
    covered: Number.isFinite(summaryRaw.covered) ? summaryRaw.covered : 0,
    untested: Number.isFinite(summaryRaw.untested) ? summaryRaw.untested : 0,
    stale: Number.isFinite(summaryRaw.stale) ? summaryRaw.stale : 0
  };

  return {
    cachePath,
    timestamp: data?.timestamp || null,
    files: filteredFiles,
    summary
  };
}

/**
 * @param {{root: string, config: ProjectConfig}} ctx
 */
async function readDepGraph(ctx) {
  const cachePath = getCachePath(ctx.config, ctx.root, '.dep-graph.json');
  const rootPath = path.join(ctx.root, '.dep-graph.json');
  let graph = await readJsonSafe(cachePath, null);
  let usedPath = cachePath;
  if (!graph) {
    graph = await readJsonSafe(rootPath, null);
    usedPath = rootPath;
  }
  return { graph, usedPath };
}

/**
 * @param {{root: string, config: ProjectConfig, staleConfig?: any}} ctx
 */
async function apiStatus(ctx) {
  const modulesData = await readModules(ctx);
  const stale = await readStaleModules(ctx);
  const test = await readTestStatus(ctx);
  const deps = await readDepGraph(ctx);

  const modules = modulesData.modules;

  const staleDocModules = modules.filter(m => m.enableDoc && stale.byPath.has(m.path)).length;
  const staleAuditModules = modules.filter(m => m.enableAudit && stale.byPath.has(m.path)).length;

  const totalDocModules = modules.filter(m => m.enableDoc).length;
  const totalAuditModules = modules.filter(m => m.enableAudit).length;

  const coveragePercent = test.summary.total > 0
    ? Math.round((test.summary.covered / test.summary.total) * 100)
    : 0;

  const manager = new TaskManager(ctx);
  const running = await manager.list();

  const depStats = deps.graph?.stats || null;

  return {
    updatedAt: new Date().toISOString(),
    project: {
      name: ctx.config?.name || path.basename(ctx.root),
      root: ctx.root,
      language: ctx.config?.language || 'unknown',
      cache: ctx.config?.cache || null
    },
    stale: {
      doc: {
        stale: staleDocModules,
        fresh: Math.max(0, totalDocModules - staleDocModules),
        total: totalDocModules,
        source: { file: stale.cachePath, timestamp: stale.timestamp }
      },
      audit: {
        stale: staleAuditModules,
        fresh: Math.max(0, totalAuditModules - staleAuditModules),
        total: totalAuditModules,
        source: { file: stale.cachePath, timestamp: stale.timestamp }
      },
      test: {
        stale: test.summary.stale,
        untested: test.summary.untested,
        covered: test.summary.covered,
        total: test.summary.total,
        coveragePercent,
        source: { file: test.cachePath, timestamp: test.timestamp }
      }
    },
    modules: {
      total: modules.length,
      source: { file: modulesData.cachePath, timestamp: modulesData.timestamp }
    },
    tasks: {
      running: running.length,
      runningTasks: running
    },
    deps: deps.graph
      ? { available: true, generated: deps.graph.generated || null, stats: depStats }
      : { available: false, error: 'No dependency graph found. Run "pi deps build" first.' }
  };
}

/**
 * @param {{root: string, config: ProjectConfig, staleConfig?: any}} ctx
 * @param {URLSearchParams} searchParams
 */
async function apiModules(ctx, searchParams) {
  const wantPathRaw = searchParams.get('path');
  const wantPath = wantPathRaw ? normalizeRelPath(wantPathRaw) : null;

  const modulesData = await readModules(ctx);
  const stale = await readStaleModules(ctx);
  const test = await readTestStatus(ctx);

  const modules = modulesData.modules;

  const modulePathsDesc = modules
    .map(m => m.path)
    .sort((a, b) => b.length - a.length || a.localeCompare(b));

  /** @type {Map<string, {covered: number, untested: number, stale: number, total: number}>} */
  const testByModule = new Map();
  for (const p of modulePathsDesc) {
    testByModule.set(p, { covered: 0, untested: 0, stale: 0, total: 0 });
  }

  for (const f of test.files) {
    const source = normalizeRelPath(f?.source);
    if (!source) continue;

    let matched = null;
    for (const modPath of modulePathsDesc) {
      if (source === modPath || source.startsWith(modPath + '/')) {
        matched = modPath;
        break;
      }
    }
    if (!matched) continue;

    const bucket = testByModule.get(matched);
    if (!bucket) continue;
    bucket.total += 1;
    if (f.status === 'covered') bucket.covered += 1;
    else if (f.status === 'untested') bucket.untested += 1;
    else if (f.status === 'stale') bucket.stale += 1;
  }

  const rows = modules.map(m => {
    const staleDoc = m.enableDoc && stale.byPath.has(m.path);
    const staleAudit = m.enableAudit && stale.byPath.has(m.path);
    const testCounts = testByModule.get(m.path) || { covered: 0, untested: 0, stale: 0, total: 0 };

    return {
      id: m.id,
      path: m.path,
      enableDoc: m.enableDoc,
      enableAudit: m.enableAudit,
      stale: {
        doc: staleDoc,
        audit: staleAudit,
        test: testCounts.stale > 0
      },
      test: testCounts,
      staleInfo: stale.byPath.get(m.path) || null
    };
  });

  if (wantPath) {
    const mod = rows.find(r => r.path === wantPath) || null;
    if (!mod) {
      return { error: `Module not found: ${wantPath}`, module: null };
    }

    const auditPath = path.join(ctx.root, mod.path, 'AUDIT.md');
    const docPath = path.join(ctx.root, mod.path, 'CLAUDE.md');
    const auditStat = await fs.stat(auditPath).catch(() => null);
    const docStat = await fs.stat(docPath).catch(() => null);

    const testFiles = test.files.filter(f => {
      const src = normalizeRelPath(f?.source);
      return src === mod.path || src.startsWith(mod.path + '/');
    });

    return {
      updatedAt: new Date().toISOString(),
      module: mod,
      files: {
        doc: docStat ? { exists: true, mtime: new Date(docStat.mtimeMs).toISOString() } : { exists: false },
        audit: auditStat ? { exists: true, mtime: new Date(auditStat.mtimeMs).toISOString() } : { exists: false }
      },
      tests: {
        summary: mod.test,
        stale: testFiles.filter(f => f.status === 'stale').slice(0, 200),
        untested: testFiles.filter(f => f.status === 'untested').slice(0, 200)
      }
    };
  }

  const moduleTestTotals = rows.reduce(
    (acc, m) => {
      acc.total += m.test.total;
      acc.covered += m.test.covered;
      acc.untested += m.test.untested;
      acc.stale += m.test.stale;
      return acc;
    },
    { total: 0, covered: 0, untested: 0, stale: 0 }
  );

  return {
    updatedAt: new Date().toISOString(),
    summary: {
      total: rows.length,
      staleDoc: rows.filter(r => r.stale.doc).length,
      staleAudit: rows.filter(r => r.stale.audit).length,
      staleTestModules: rows.filter(r => r.stale.test).length,
      testFiles: moduleTestTotals
    },
    modules: rows
  };
}

/**
 * @param {{root: string, config: ProjectConfig}} ctx
 */
async function apiTasks(ctx) {
  const manager = new TaskManager(ctx);
  const running = await manager.list();

  const cacheDir = ctx.config.cache || path.join(ctx.root, '.project-index');
  const auditFixTasks = await readJsonSafe(path.join(cacheDir, '.audit-fix-tasks.json'), null);
  const auditFixResult = await readJsonSafe(path.join(cacheDir, '.audit-fix-result.json'), null);

  const auditFix = (() => {
    const tasks = Array.isArray(auditFixTasks?.tasks) ? auditFixTasks.tasks : [];
    const byStatus = {};
    for (const t of tasks) {
      const s = String(t?.status || 'unknown');
      byStatus[s] = (byStatus[s] || 0) + 1;
    }
    return {
      startedAt: auditFixTasks?.startedAt || null,
      total: tasks.length,
      byStatus,
      sample: tasks.slice(0, 50),
      lastResult: auditFixResult || null
    };
  })();

  return {
    updatedAt: new Date().toISOString(),
    running,
    types: TASK_TYPES,
    batch: {
      auditFix
    }
  };
}

/**
 * @param {Record<string, any>} files
 */
function buildEdges(files) {
  /** @type {Array<{source: string, target: string}>} */
  const edges = [];
  for (const [from, node] of Object.entries(files || {})) {
    const imports = Array.isArray(node?.imports) ? node.imports : [];
    for (const to of imports) {
      edges.push({ source: from, target: String(to) });
    }
  }
  return edges;
}

/**
 * @param {{root: string, config: ProjectConfig}} ctx
 * @param {URLSearchParams} searchParams
 */
async function apiDeps(ctx, searchParams) {
  const focusRaw = searchParams.get('focus');
  const moduleRaw = searchParams.get('module');
  const depthRaw = searchParams.get('depth');
  const maxNodesRaw = searchParams.get('maxNodes');

  const focus = focusRaw ? normalizeRelPath(focusRaw) : null;
  const modulePath = moduleRaw ? normalizeRelPath(moduleRaw) : null;
  const depth = Number.isFinite(Number(depthRaw)) ? Math.max(0, Math.min(10, Number(depthRaw))) : 2;
  const maxNodes = Number.isFinite(Number(maxNodesRaw)) ? Math.max(50, Math.min(5000, Number(maxNodesRaw))) : 2000;

  const { graph } = await readDepGraph(ctx);
  if (!graph?.files) {
    return { error: 'No dependency graph found. Run "pi deps build" first.' };
  }

  const files = graph.files || {};

  /** @type {Set<string>} */
  const keep = new Set();

  if (modulePath) {
    for (const file of Object.keys(files)) {
      const rel = normalizeRelPath(file);
      if (rel === modulePath || rel.startsWith(modulePath + '/')) {
        keep.add(rel);
      }
    }
  } else if (focus) {
    if (!files[focus]) {
      return { error: `File not found in graph: ${focus}` };
    }

    /** @type {Array<{id: string, d: number}>} */
    const queue = [{ id: focus, d: 0 }];
    keep.add(focus);

    for (let i = 0; i < queue.length; i++) {
      const { id, d } = queue[i];
      if (d >= depth) continue;
      const node = files[id];
      const outs = Array.isArray(node?.imports) ? node.imports : [];
      const ins = Array.isArray(node?.importedBy) ? node.importedBy : [];
      for (const next of outs.concat(ins)) {
        const n = normalizeRelPath(next);
        if (!n || keep.has(n)) continue;
        keep.add(n);
        queue.push({ id: n, d: d + 1 });
        if (keep.size >= maxNodes) break;
      }
      if (keep.size >= maxNodes) break;
    }
  } else {
    for (const file of Object.keys(files)) {
      keep.add(normalizeRelPath(file));
      if (keep.size >= maxNodes) break;
    }
  }

  if (keep.size >= maxNodes) {
    return {
      error: `Graph too large to return (${keep.size}+ nodes). Use ?focus=... or ?module=... to filter.`,
      stats: graph.stats || null
    };
  }

  /** @type {Record<string, any>} */
  const subFiles = {};
  for (const id of keep) {
    if (files[id]) subFiles[id] = files[id];
  }

  const edgesAll = buildEdges(subFiles);
  const edges = edgesAll.filter(e => keep.has(normalizeRelPath(e.source)) && keep.has(normalizeRelPath(e.target)));

  const nodes = Array.from(keep).sort().map((id) => {
    const n = files[id] || {};
    return {
      id,
      label: path.posix.basename(id),
      imports: Array.isArray(n.imports) ? n.imports.length : 0,
      importedBy: Array.isArray(n.importedBy) ? n.importedBy.length : 0
    };
  });

  return {
    updatedAt: new Date().toISOString(),
    generated: graph.generated || null,
    stats: graph.stats || null,
    focus,
    module: modulePath,
    nodes,
    edges,
    cycles: Array.isArray(graph.cycles) ? graph.cycles : []
  };
}

/**
 * Inline dashboard HTML (no external assets).
 * @param {{root: string, config: ProjectConfig}} ctx
 */
function getDashboardHtml(ctx) {
  const name = String(ctx.config?.name || 'pi-cli Dashboard');
  const root = String(ctx.root || '');

  // NOTE: keep this HTML self-contained (inline CSS + JS only).
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(name)} - Dashboard</title>
  <style>
    :root{
      --bg:#0b1020;
      --panel:#101a33;
      --panel2:#0f1730;
      --text:#e8eefc;
      --muted:#a9b7de;
      --border:rgba(255,255,255,.08);
      --brand:#5b8cff;
      --good:#22c55e;
      --warn:#f59e0b;
      --bad:#ef4444;
      --chip:#1b2a55;
      --shadow: 0 10px 30px rgba(0,0,0,.35);
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      --sans: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji";
    }
    *{box-sizing:border-box}
    html,body{height:100%}
    body{
      margin:0;
      font-family:var(--sans);
      background: radial-gradient(1200px 600px at 30% -10%, rgba(91,140,255,.25), transparent 60%),
                  radial-gradient(900px 500px at 110% 0%, rgba(34,197,94,.12), transparent 55%),
                  radial-gradient(900px 500px at 0% 110%, rgba(245,158,11,.12), transparent 55%),
                  var(--bg);
      color:var(--text);
    }
    a{color:inherit; text-decoration:none}
    .wrap{max-width:1200px; margin:0 auto; padding:20px}
    .topbar{
      display:flex; gap:12px; align-items:center; justify-content:space-between;
      padding:14px 16px; border:1px solid var(--border); border-radius:14px;
      background:linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.03));
      box-shadow:var(--shadow);
      position:sticky; top:12px; z-index:10;
      backdrop-filter: blur(10px);
    }
    .title{display:flex; gap:10px; align-items:center; min-width:0}
    .title h1{font-size:15px; margin:0; letter-spacing:.2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
    .title .sub{font-size:12px; color:var(--muted); font-family:var(--mono); overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
    .nav{display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end}
    .tab{
      border:1px solid var(--border);
      background:rgba(255,255,255,.03);
      color:var(--muted);
      padding:8px 10px;
      border-radius:10px;
      font-size:13px;
      cursor:pointer;
      user-select:none;
    }
    .tab.active{
      color:var(--text);
      border-color:rgba(91,140,255,.4);
      background:rgba(91,140,255,.14);
    }
    .row{display:grid; grid-template-columns: repeat(12, 1fr); gap:14px; margin-top:14px}
    .card{
      grid-column: span 3;
      padding:14px 14px;
      border-radius:14px;
      border:1px solid var(--border);
      background:linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.02));
      box-shadow:var(--shadow);
      min-height:92px;
    }
    .card.full{grid-column: span 12}
    .card h3{margin:0 0 8px 0; font-size:12px; color:var(--muted); font-weight:600}
    .metric{display:flex; gap:10px; align-items:baseline; justify-content:space-between}
    .metric .big{font-size:28px; font-weight:800; letter-spacing:-.4px}
    .metric .small{font-size:12px; color:var(--muted); font-family:var(--mono)}
    .pill{display:inline-flex; align-items:center; gap:6px; padding:6px 10px; border-radius:999px; border:1px solid var(--border); background:rgba(255,255,255,.03); color:var(--muted); font-size:12px}
    .dot{width:8px;height:8px;border-radius:99px;background:var(--muted)}
    .dot.on{background:var(--good)}
    .panel{
      grid-column: span 12;
      border-radius:14px;
      border:1px solid var(--border);
      background:linear-gradient(180deg, rgba(255,255,255,.05), rgba(255,255,255,.02));
      box-shadow:var(--shadow);
      overflow:hidden;
    }
    .panel .hd{
      display:flex; align-items:center; justify-content:space-between;
      padding:12px 14px;
      border-bottom:1px solid var(--border);
      background:rgba(0,0,0,.12);
    }
    .panel .hd .left{display:flex; gap:10px; align-items:center}
    .panel .hd h2{margin:0; font-size:13px}
    .panel .bd{padding:14px}
    .muted{color:var(--muted)}
    .btn{
      border:1px solid var(--border);
      background:rgba(255,255,255,.03);
      color:var(--text);
      padding:8px 10px;
      border-radius:10px;
      font-size:13px;
      cursor:pointer;
    }
    .btn:hover{border-color:rgba(255,255,255,.16)}
    .input{
      width:100%;
      border:1px solid var(--border);
      background:rgba(0,0,0,.18);
      color:var(--text);
      padding:9px 10px;
      border-radius:10px;
      font-size:13px;
      outline:none;
    }
    .input:focus{border-color:rgba(91,140,255,.45)}
    .textarea{
      width:100%;
      min-height:420px;
      border:1px solid var(--border);
      background:rgba(0,0,0,.18);
      color:var(--text);
      padding:10px 12px;
      border-radius:12px;
      font-size:13px;
      outline:none;
      resize:vertical;
    }
    .textarea:focus{border-color:rgba(91,140,255,.45)}
    input[type="checkbox"]{ accent-color: var(--brand); }
    table{width:100%; border-collapse:separate; border-spacing:0}
    th,td{padding:10px 10px; border-bottom:1px solid var(--border); vertical-align:top}
    th{font-size:12px; text-align:left; color:var(--muted); font-weight:700; background:rgba(0,0,0,.10)}
    tr:hover td{background:rgba(255,255,255,.02)}
    .mono{font-family:var(--mono)}
    .badge{
      display:inline-flex; align-items:center; gap:6px;
      padding:4px 8px; border-radius:999px;
      font-size:12px; border:1px solid var(--border);
      background:rgba(255,255,255,.03); color:var(--muted);
    }
    .badge.good{color:#d9fbe5; border-color:rgba(34,197,94,.35); background:rgba(34,197,94,.14)}
    .badge.warn{color:#fff7e6; border-color:rgba(245,158,11,.35); background:rgba(245,158,11,.14)}
    .badge.bad{color:#ffe7ea; border-color:rgba(239,68,68,.35); background:rgba(239,68,68,.14)}
    .grid2{display:grid; grid-template-columns: 1fr 1fr; gap:14px}
    @media (max-width: 980px){
      .card{grid-column: span 6}
      .grid2{grid-template-columns: 1fr}
    }
    @media (max-width: 620px){
      .card{grid-column: span 12}
      .topbar{flex-direction:column; align-items:stretch}
      .nav{justify-content:flex-start}
    }
    .hidden{display:none !important}
    .graph{
      width:100%;
      height:520px;
      border-radius:12px;
      border:1px solid var(--border);
      background:rgba(0,0,0,.22);
      overflow:hidden;
      position:relative;
    }
    .graph svg{width:100%; height:100%; display:block}
    .toast{
      position:fixed; right:18px; bottom:18px; z-index:100;
      padding:10px 12px; border-radius:12px;
      border:1px solid var(--border);
      background:rgba(16,26,51,.92);
      box-shadow:var(--shadow);
      color:var(--text);
      font-size:13px;
      max-width:420px;
    }
    .toast.hidden{display:none}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="topbar">
      <div class="title">
        <div class="pill" title="Live connection">
          <span class="dot" id="connDot"></span>
          <span id="connText">SSE: 连接中…</span>
        </div>
        <div style="min-width:0">
          <h1>${escapeHtml(name)}</h1>
          <div class="sub">${escapeHtml(root)}</div>
        </div>
      </div>
      <div class="nav">
        <div class="tab" data-tab="overview">总览</div>
        <div class="tab" data-tab="modules">模块</div>
        <div class="tab" data-tab="tasks">任务</div>
        <div class="tab" data-tab="launch">启动</div>
        <div class="tab" data-tab="config">配置</div>
        <div class="tab" data-tab="deps">依赖图</div>
      </div>
    </div>

    <div class="row" id="cards">
      <div class="card">
        <h3>Doc stale（模块）</h3>
        <div class="metric"><div class="big" id="docStale">-</div><div class="small" id="docStaleDetail">-</div></div>
      </div>
      <div class="card">
        <h3>Audit stale（模块）</h3>
        <div class="metric"><div class="big" id="auditStale">-</div><div class="small" id="auditStaleDetail">-</div></div>
      </div>
      <div class="card">
        <h3>Test stale（文件）</h3>
        <div class="metric"><div class="big" id="testStale">-</div><div class="small" id="testStaleDetail">-</div></div>
      </div>
      <div class="card">
        <h3>Tasks（运行中）</h3>
        <div class="metric"><div class="big" id="tasksRunning">-</div><div class="small" id="tasksRunningDetail">-</div></div>
      </div>
    </div>

    <!-- Overview -->
    <div class="panel" id="page-overview" style="margin-top:14px">
      <div class="hd">
        <div class="left">
          <h2>项目状态</h2>
          <span class="badge" id="statusBadge">加载中…</span>
        </div>
        <div class="left">
          <button class="btn" id="btnRefresh">刷新</button>
        </div>
      </div>
      <div class="bd grid2">
        <div>
          <div class="muted" style="margin-bottom:8px">缓存来源</div>
          <div class="mono" id="sources" style="line-height:1.55">-</div>
        </div>
        <div>
          <div class="muted" style="margin-bottom:8px">依赖图</div>
          <div id="depsSummary">-</div>
          <div style="margin-top:10px">
            <button class="btn" id="btnOpenDeps">打开依赖图视图</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Modules -->
    <div class="panel hidden" id="page-modules" style="margin-top:14px">
      <div class="hd">
        <div class="left">
          <h2>模块列表</h2>
          <span class="badge" id="modulesBadge">-</span>
        </div>
        <div class="left" style="gap:8px">
          <input class="input mono" id="moduleFilter" placeholder="过滤（包含路径子串）" style="max-width:360px" />
          <button class="btn" id="btnReloadModules">刷新</button>
        </div>
      </div>
      <div class="bd">
        <div class="muted" id="modulesHint" style="margin-bottom:10px"></div>
        <div style="overflow:auto; border:1px solid var(--border); border-radius:12px">
          <table>
            <thead>
              <tr>
                <th style="width:44%">模块</th>
                <th>Doc</th>
                <th>Audit</th>
                <th>Tests</th>
                <th class="mono">flags</th>
              </tr>
            </thead>
            <tbody id="modulesTable">
              <tr><td colspan="5" class="muted">加载中…</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Module Detail -->
    <div class="panel hidden" id="page-module" style="margin-top:14px">
      <div class="hd">
        <div class="left">
          <button class="btn" id="btnBackModules">← 模块</button>
          <h2 class="mono" id="moduleTitle">-</h2>
        </div>
        <div class="left">
          <span class="badge" id="moduleBadge">-</span>
        </div>
      </div>
      <div class="bd grid2">
        <div>
          <div class="muted" style="margin-bottom:8px">文件状态</div>
          <div id="moduleFiles" class="mono" style="line-height:1.6">-</div>
          <div class="muted" style="margin:14px 0 8px">Test status（最多展示 200 条 stale/untested）</div>
          <div id="moduleTests" style="max-height:260px; overflow:auto; border:1px solid var(--border); border-radius:12px; padding:10px"></div>
        </div>
        <div>
          <div class="muted" style="margin-bottom:8px">依赖子图（module 范围）</div>
          <div class="graph"><svg id="moduleGraph"></svg></div>
          <div class="muted" style="margin-top:10px" id="moduleGraphHint"></div>
        </div>
      </div>
    </div>

    <!-- Tasks -->
    <div class="panel hidden" id="page-tasks" style="margin-top:14px">
      <div class="hd">
        <div class="left">
          <h2>任务</h2>
          <span class="badge" id="tasksBadge">-</span>
        </div>
        <div class="left">
          <button class="btn" id="btnReloadTasks">刷新</button>
        </div>
      </div>
      <div class="bd">
        <div class="grid2">
          <div>
            <div class="muted" style="margin-bottom:8px">运行中（PID）</div>
            <div id="runningTasks" class="mono" style="line-height:1.6">-</div>
          </div>
          <div>
            <div class="muted" style="margin-bottom:8px">Batch 状态（audit-fix）</div>
            <div id="batchAuditFix" class="mono" style="line-height:1.6">-</div>
          </div>
        </div>

        <div style="margin-top:14px">
          <div class="muted" style="margin-bottom:8px">任务详情</div>
          <div class="row" id="taskTypeCards" style="margin-top:0"></div>
        </div>
      </div>
    </div>

    <!-- Launch -->
    <div class="panel hidden" id="page-launch" style="margin-top:14px">
      <div class="hd">
        <div class="left">
          <h2>启动任务</h2>
          <span class="badge" id="launchBadge">-</span>
        </div>
        <div class="left">
          <button class="btn" id="btnReloadLaunch">刷新</button>
        </div>
      </div>
      <div class="bd">
        <div class="muted" style="margin-bottom:10px">选择任务类型并启动（参数用 checkbox 勾选）。</div>
        <div class="row" id="launchTypes" style="margin-top:0"></div>
        <div style="margin-top:14px">
          <div class="muted" style="margin-bottom:8px">最近启动</div>
          <div id="launchRecent" class="mono" style="line-height:1.6">-</div>
        </div>
      </div>
    </div>

    <!-- Config -->
    <div class="panel hidden" id="page-config" style="margin-top:14px">
      <div class="hd">
        <div class="left">
          <h2>配置</h2>
          <span class="badge" id="configBadge">-</span>
        </div>
        <div class="left" style="gap:8px">
          <button class="btn" id="btnResetConfig">重置</button>
          <button class="btn" id="btnSaveConfig">保存</button>
        </div>
      </div>
      <div class="bd">
        <div class="muted" style="margin-bottom:10px">编辑 <span class="mono">.stale-config.json</span>（保存后会影响 stale 判定与模块列表）。</div>
        <textarea class="textarea mono" id="configText" placeholder="加载中…"></textarea>
        <div id="configMsg" style="margin-top:10px"></div>
      </div>
    </div>

    <!-- Deps -->
    <div class="panel hidden" id="page-deps" style="margin-top:14px">
      <div class="hd">
        <div class="left">
          <h2>依赖图</h2>
          <span class="badge" id="depsBadge">-</span>
        </div>
        <div class="left" style="gap:8px; align-items:center">
          <input class="input mono" id="depsFocus" placeholder="focus: 输入文件路径（如 lib/deps/graph.js）" style="max-width:420px" />
          <button class="btn" id="btnRenderDeps">渲染</button>
        </div>
      </div>
      <div class="bd">
        <div class="muted" id="depsHint" style="margin-bottom:10px"></div>
        <div class="graph"><svg id="depsGraph"></svg></div>
        <div class="muted" style="margin-top:10px">提示：使用 ?focus=...&depth=2 只加载局部子图；大型项目建议聚焦查看。</div>
      </div>
    </div>

  </div>

  <div class="toast hidden" id="toast"></div>

  <script>
    const state = {
      status: null,
      modules: null,
      tasks: null,
      config: null,
      taskTypes: null,
      taskDetails: {},
      taskOpen: {},
      recentLaunches: [],
      deps: null,
      sse: null,
      lastToastAt: 0
    };

    function $(id){ return document.getElementById(id); }

    function escapeHtml(s){
      return String(s || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('\"', '&quot;')
        .replaceAll(\"'\", '&#39;');
    }

    function toast(msg){
      const now = Date.now();
      if (now - state.lastToastAt < 800) return;
      state.lastToastAt = now;
      const el = $('toast');
      el.textContent = String(msg || '');
      el.classList.remove('hidden');
      setTimeout(() => el.classList.add('hidden'), 2200);
    }

    async function api(path, opts){
      opts = opts || {};
      const method = opts.method || 'GET';
      const headers = { 'Accept': 'application/json' };
      /** @type {RequestInit} */
      const init = { method, headers };
      if (Object.prototype.hasOwnProperty.call(opts, 'body')) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(opts.body);
      }

      const res = await fetch('/api' + path, init);
      const data = await res.json().catch(() => ({ error: 'Invalid JSON' }));
      if (!res.ok) {
        throw new Error(data && data.error ? data.error : ('HTTP ' + res.status));
      }
      if (data && data.error && typeof data.error === 'string') {
        throw new Error(data.error);
      }
      return data;
    }

    function setConn(ok){
      const dot = $('connDot');
      const text = $('connText');
      dot.classList.toggle('on', !!ok);
      text.textContent = ok ? 'SSE: 已连接' : 'SSE: 断开（重试中…）';
    }

    function setTab(tab){
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
      ['overview','modules','module','tasks','launch','config','deps'].forEach(p => {
        const el = $('page-' + p);
        if (el) el.classList.toggle('hidden', p !== tab);
      });
    }

    function navigate(tab, opts){
      opts = opts || {};
      if (tab === 'module') {
        const p = opts.path ? String(opts.path) : '';
        history.pushState({ tab: 'module', path: p }, '', '/module?path=' + encodeURIComponent(p));
      } else {
        history.pushState({ tab }, '', tab === 'overview' ? '/' : ('/' + tab));
      }
      onRoute();
    }

    function onRoute(){
      const p = location.pathname.replace(/\\/+$/, '') || '/';
      let tab = 'overview';
      if (p === '/' || p === '') tab = 'overview';
      else if (p === '/modules') tab = 'modules';
      else if (p === '/tasks') tab = 'tasks';
      else if (p === '/launch') tab = 'launch';
      else if (p === '/config') tab = 'config';
      else if (p === '/deps') tab = 'deps';
      else if (p === '/module') tab = 'module';

      setTab(tab);

      // Lazy load per-page content.
      if (tab === 'module') loadModuleDetail().catch(() => {});
      if (tab === 'tasks') loadTasks().catch(() => {});
      if (tab === 'launch') {
        loadTaskTypes(false).catch(() => {});
        loadLaunchRecent().catch(() => {});
      }
      if (tab === 'config') loadConfig().catch(() => {});
    }

    function renderStatus(data){
      state.status = data;
      const s = data.stale || {};
      $('docStale').textContent = (s.doc && Number.isFinite(s.doc.stale)) ? s.doc.stale : '-';
      $('docStaleDetail').textContent = (s.doc && Number.isFinite(s.doc.total)) ? (s.doc.fresh + '/' + s.doc.total + ' fresh') : '-';
      $('auditStale').textContent = (s.audit && Number.isFinite(s.audit.stale)) ? s.audit.stale : '-';
      $('auditStaleDetail').textContent = (s.audit && Number.isFinite(s.audit.total)) ? (s.audit.fresh + '/' + s.audit.total + ' fresh') : '-';
      $('testStale').textContent = (s.test && Number.isFinite(s.test.stale)) ? s.test.stale : '-';
      $('testStaleDetail').textContent = (s.test && Number.isFinite(s.test.total))
        ? (s.test.covered + '/' + s.test.total + ' covered · ' + s.test.coveragePercent + '%')
        : '-';

      const t = data.tasks || {};
      $('tasksRunning').textContent = Number.isFinite(t.running) ? t.running : '-';
      $('tasksRunningDetail').textContent = (t.runningTasks && Array.isArray(t.runningTasks))
        ? (t.runningTasks.slice(0,2).map(x => x.taskId).join(' · ') || '—')
        : '—';

      const badge = $('statusBadge');
      badge.textContent = 'updated: ' + (data.updatedAt || '-');
      badge.className = 'badge';

      const sources = [];
      if (data.modules && data.modules.source) {
        sources.push('modules: ' + (data.modules.source.file || '-') + ' @ ' + (data.modules.source.timestamp || '-'));
      }
      if (s.doc && s.doc.source) {
        sources.push('stale: ' + (s.doc.source.file || '-') + ' @ ' + (s.doc.source.timestamp || '-'));
      }
      if (s.test && s.test.source) {
        sources.push('tests: ' + (s.test.source.file || '-') + ' @ ' + (s.test.source.timestamp || '-'));
      }
      $('sources').innerHTML = sources.map(x => '<div>' + escapeHtml(x) + '</div>').join('') || '-';

      const deps = data.deps || {};
      if (deps.available) {
        const st = deps.stats || {};
        $('depsSummary').innerHTML =
          '<div class=\"mono\">files: ' + (st.totalFiles || 0) + ' · edges: ' + (st.totalEdges || 0) + ' · cycles: ' + (st.cycleCount || 0) + '</div>' +
          '<div class=\"muted\" style=\"margin-top:6px\">generated: ' + escapeHtml(deps.generated || '-') + '</div>';
        $('depsBadge').textContent = 'OK';
        $('depsBadge').className = 'badge good';
      } else {
        $('depsSummary').innerHTML = '<div class=\"badge bad\">' + escapeHtml(deps.error || 'No dep graph') + '</div>';
        $('depsBadge').textContent = 'MISSING';
        $('depsBadge').className = 'badge bad';
      }
    }

    function renderModules(data){
      state.modules = data;
      const sum = data.summary || {};
      $('modulesBadge').textContent = (Number.isFinite(sum.total) ? (sum.total + ' modules') : '-');
      $('modulesHint').textContent =
        'doc stale: ' + (sum.staleDoc || 0) +
        ' · audit stale: ' + (sum.staleAudit || 0) +
        ' · stale tests(mod): ' + (sum.staleTestModules || 0) +
        ' · test files: ' + ((sum.testFiles && sum.testFiles.total) ? sum.testFiles.total : 0);

      const filter = String($('moduleFilter').value || '').trim().toLowerCase();

      const rows = (data.modules || []).filter(m => !filter || String(m.path).toLowerCase().includes(filter));
      $('modulesTable').innerHTML = rows.map(m => {
        const docBadge = m.enableDoc
          ? (m.stale.doc ? '<span class=\"badge bad\">stale</span>' : '<span class=\"badge good\">fresh</span>')
          : '<span class=\"badge\">off</span>';
        const auditBadge = m.enableAudit
          ? (m.stale.audit ? '<span class=\"badge bad\">stale</span>' : '<span class=\"badge good\">fresh</span>')
          : '<span class=\"badge\">off</span>';
        const testBadge = (m.test && m.test.total > 0)
          ? (m.test.stale > 0 ? '<span class=\"badge warn\">stale ' + m.test.stale + '</span>' : '<span class=\"badge good\">ok</span>')
          : '<span class=\"badge\">-</span>';
        const flags = [];
        if (m.enableDoc) flags.push('doc');
        if (m.enableAudit) flags.push('audit');
        return '<tr style=\"cursor:pointer\" data-path=\"' + escapeHtml(m.path) + '\">' +
          '<td class=\"mono\"><a href=\"#\" onclick=\"return openModule(\\'' + escapeHtml(m.path) + '\\')\">' + escapeHtml(m.path) + '</a></td>' +
          '<td>' + docBadge + '</td>' +
          '<td>' + auditBadge + '</td>' +
          '<td>' + testBadge + '</td>' +
          '<td class=\"mono muted\">' + escapeHtml(flags.join(',')) + '</td>' +
        '</tr>';
      }).join('') || '<tr><td colspan=\"5\" class=\"muted\">无匹配</td></tr>';
    }

    function renderTasks(data){
      state.tasks = data;
      const running = Array.isArray(data.running) ? data.running : [];
      $('tasksBadge').textContent = running.length + ' 运行中';

      $('runningTasks').innerHTML = running.length === 0
        ? '<div class=\"muted\">无</div>'
        : running.map(t => '<div>' + escapeHtml(t.taskId) + '（PID ' + t.pid + '）</div>').join('');

      const auditFix = data.batch && data.batch.auditFix ? data.batch.auditFix : null;
      if (!auditFix) {
        $('batchAuditFix').innerHTML = '<div class=\"muted\">无数据</div>';
      } else {
        const by = auditFix.byStatus || {};
        const parts = Object.keys(by).sort().map(k => k + ':' + by[k]);
        const last = auditFix.lastResult || null;
        $('batchAuditFix').innerHTML =
          '<div>startedAt: ' + escapeHtml(auditFix.startedAt || '-') + '</div>' +
          '<div>total: ' + escapeHtml(auditFix.total || 0) + ' · ' + escapeHtml(parts.join(' · ') || '-') + '</div>' +
          (last ? ('<div style=\"margin-top:8px\">last: ' + escapeHtml(last.completedAt || last.timestamp || '-') + ' · fixed ' + escapeHtml(last.fixed || 0) + '/' + escapeHtml(last.fixable || 0) + '</div>') : '');
      }

      ensureTaskTypeCards(data.types || {});
      renderLaunchRecent();
    }

    function safeId(input){
      return String(input || '').replace(/[^a-zA-Z0-9_-]/g, '_');
    }

    function getTaskItems(data){
      if (Array.isArray(data?.tasks)) return data.tasks;
      if (Array.isArray(data?.items)) return data.items;
      return [];
    }

    function summarizeTaskItems(items){
      const list = Array.isArray(items) ? items : [];
      const sum = { total: list.length, pending: 0, running: 0, completed: 0, failed: 0, timeout: 0, cancelled: 0, unknown: 0 };
      for (const t of list) {
        const s = String(t?.status || 'unknown');
        if (s === 'pending') sum.pending++;
        else if (s === 'running') sum.running++;
        else if (s === 'completed') sum.completed++;
        else if (s === 'failed') sum.failed++;
        else if (s === 'timeout') sum.timeout++;
        else if (s === 'cancelled') sum.cancelled++;
        else sum.unknown++;
      }
      return sum;
    }

    function statusLabel(status){
      const s = String(status || 'unknown');
      if (s === 'pending') return '待执行';
      if (s === 'running') return '运行中';
      if (s === 'completed') return '已完成';
      if (s === 'failed') return '失败';
      if (s === 'timeout') return '超时';
      if (s === 'cancelled') return '已取消';
      return '未知';
    }

    function statusToBadge(status){
      const s = String(status || 'unknown');
      const cls =
        s === 'completed' ? 'good'
        : (s === 'running' ? 'warn'
        : ((s === 'failed' || s === 'timeout' || s === 'cancelled') ? 'bad' : ''));
      const label = statusLabel(s);
      return '<span class=\"badge ' + cls + '\" title=\"' + escapeHtml(s) + '\">' + escapeHtml(label) + '</span>';
    }

    function renderTaskSummaryBadges(sum){
      if (!sum) return '<span class=\"badge\">-</span>';
      const parts = [];
      parts.push('<span class=\"badge\">总计 ' + sum.total + '</span>');
      if (sum.running) parts.push('<span class=\"badge warn\">运行中 ' + sum.running + '</span>');
      if (sum.pending) parts.push('<span class=\"badge\">待执行 ' + sum.pending + '</span>');
      if (sum.failed) parts.push('<span class=\"badge bad\">失败 ' + sum.failed + '</span>');
      if (sum.timeout) parts.push('<span class=\"badge bad\">超时 ' + sum.timeout + '</span>');
      if (sum.cancelled) parts.push('<span class=\"badge bad\">已取消 ' + sum.cancelled + '</span>');
      if (sum.completed) parts.push('<span class=\"badge good\">已完成 ' + sum.completed + '</span>');
      if (sum.unknown) parts.push('<span class=\"badge\">未知 ' + sum.unknown + '</span>');
      return parts.join(' ');
    }

    function ensureTaskTypeCards(types){
      const el = $('taskTypeCards');
      if (!el) return;

      const obj = (types && typeof types === 'object') ? types : {};
      const names = Object.keys(obj).sort((a, b) => String(a).localeCompare(String(b)));
      const sig = names.join('|');

      if (state.__taskTypeSig === sig) {
        // Update summary badges from cached details (if any).
        names.forEach((name) => updateTaskTypeSummaryDom(name));
        return;
      }

      state.__taskTypeSig = sig;

      el.innerHTML = names.map((name) => {
        const def = obj[name] || {};
        const sid = safeId(name);
        const open = !!state.taskOpen[name];
        const cached = state.taskDetails && state.taskDetails[name] ? state.taskDetails[name] : null;
        const items = cached ? getTaskItems(cached) : [];
        const summary = cached && !cached.error ? summarizeTaskItems(items) : null;
        const badgeHtml = cached && cached.error
          ? ('<span class=\"badge bad\">' + escapeHtml(cached.error) + '</span>')
          : (summary ? renderTaskSummaryBadges(summary) : '<span class=\"badge\">点击展开加载详情</span>');
        const desc = def.description || def.command || '';

        return '' +
          '<div class=\"card full\" data-name=\"' + escapeHtml(name) + '\">' +
            '<div style=\"display:flex; gap:12px; align-items:flex-start; justify-content:space-between\">' +
              '<div style=\"min-width:0\">' +
                '<div class=\"mono\" style=\"font-weight:800; font-size:14px; margin-bottom:4px\">' + escapeHtml(name) + '</div>' +
                '<div class=\"muted\" style=\"font-size:12px; line-height:1.4\">' + escapeHtml(desc || '-') + '</div>' +
                '<div id=\"taskTypeBadge-' + sid + '\" style=\"margin-top:8px\">' + badgeHtml + '</div>' +
              '</div>' +
              '<div style=\"display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end\">' +
                '<button class=\"btn\" data-action=\"toggle-task-details\" data-name=\"' + escapeHtml(name) + '\">' + (open ? '收起' : '展开') + '</button>' +
                '<button class=\"btn\" data-action=\"delete-completed\" data-name=\"' + escapeHtml(name) + '\">批量删除已完成</button>' +
              '</div>' +
            '</div>' +
            '<div id=\"taskDetailsWrap-' + sid + '\" class=\"' + (open ? '' : 'hidden') + '\" style=\"margin-top:12px\">' +
              (open ? (cached ? renderTaskDetailsHtml(name, cached) : '<div class=\"muted\">加载中…</div>') : '') +
            '</div>' +
          '</div>';
      }).join('') || '<div class=\"muted\">无可用任务类型</div>';
    }

    function updateTaskTypeSummaryDom(name){
      const sid = safeId(name);
      const el = $('taskTypeBadge-' + sid);
      if (!el) return;

      const cached = state.taskDetails && state.taskDetails[name] ? state.taskDetails[name] : null;
      if (!cached) return;
      if (cached.error) {
        el.innerHTML = '<span class=\"badge bad\">' + escapeHtml(cached.error) + '</span>';
        return;
      }

      el.innerHTML = renderTaskSummaryBadges(summarizeTaskItems(getTaskItems(cached)));
    }

    function renderTaskDetailsHtml(name, data){
      const type = String(name || '');
      const items = getTaskItems(data);
      const summary = summarizeTaskItems(items);

      const header =
        '<div style=\"display:flex; gap:10px; align-items:center; justify-content:space-between; margin-bottom:10px\">' +
          '<div class=\"mono muted\">更新时间: ' + escapeHtml(data?.updatedAt || data?.startedAt || '-') + '</div>' +
          '<div>' +
            '<button class=\"btn\" data-action=\"refresh-task-details\" data-name=\"' + escapeHtml(type) + '\">刷新详情</button>' +
          '</div>' +
        '</div>';

      if (data && data.error) {
        return header + '<div class=\"badge bad\">' + escapeHtml(data.error) + '</div>';
      }

      if (!items || items.length === 0) {
        return header + '<div class=\"muted\">无任务记录</div>';
      }

      const rows = items.slice(0, 200).map((t) => {
        const id = t && (t.id || t.taskId || t.name) ? String(t.id || t.taskId || t.name) : '';
        const status = String(t?.status || 'unknown');

        const infoParts = [];
        const module = t && (t.module || t.modulePath) ? String(t.module || t.modulePath) : '';
        const p = t && t.path ? String(t.path) : '';
        const title = t && t.title ? String(t.title) : '';
        const file = t && t.file ? String(t.file) : '';
        if (module) infoParts.push('模块: ' + module);
        else if (p) infoParts.push('路径: ' + p);
        else if (title) infoParts.push('标题: ' + title);
        else if (file) infoParts.push('文件: ' + file);

        const err = t && t.error ? String(t.error) : '';
        const ts = t && (t.completedAt || t.updatedAt || t.startedAt) ? String(t.completedAt || t.updatedAt || t.startedAt) : '';

        const actions = [];
        if (id) {
          if (status === 'running') actions.push('<button class=\"btn\" data-action=\"task-cancel\" data-name=\"' + escapeHtml(type) + '\" data-id=\"' + escapeHtml(id) + '\">取消</button>');
          if (status !== 'running') actions.push('<button class=\"btn\" data-action=\"task-delete\" data-name=\"' + escapeHtml(type) + '\" data-id=\"' + escapeHtml(id) + '\">删除</button>');
          if (status === 'failed' || status === 'timeout') actions.push('<button class=\"btn\" data-action=\"task-retry\" data-name=\"' + escapeHtml(type) + '\" data-id=\"' + escapeHtml(id) + '\">重试失败</button>');
        } else {
          actions.push('<span class=\"muted\">无 id</span>');
        }

        return '' +
          '<tr>' +
            '<td class=\"mono\">' + escapeHtml(id || '-') + '</td>' +
            '<td>' + statusToBadge(status) + '</td>' +
            '<td>' +
              (infoParts.length ? ('<div class=\"mono\">' + escapeHtml(infoParts.join(' · ')) + '</div>') : '<div class=\"muted\">-</div>') +
              (ts ? ('<div class=\"muted\" style=\"margin-top:4px\">' + escapeHtml(ts) + '</div>') : '') +
              (err ? ('<div class=\"muted\" style=\"margin-top:4px\">错误: ' + escapeHtml(err) + '</div>') : '') +
            '</td>' +
            '<td style=\"white-space:nowrap\">' + actions.join(' ') + '</td>' +
          '</tr>';
      }).join('');

      return header +
        '<div style=\"margin-bottom:10px\">' + renderTaskSummaryBadges(summary) + '</div>' +
        '<div style=\"overflow:auto; border:1px solid var(--border); border-radius:12px\">' +
          '<table>' +
            '<thead>' +
              '<tr>' +
                '<th style=\"width:28%\">ID</th>' +
                '<th style=\"width:16%\">状态</th>' +
                '<th>信息</th>' +
                '<th style=\"width:22%\">操作</th>' +
              '</tr>' +
            '</thead>' +
            '<tbody>' + rows + '</tbody>' +
          '</table>' +
        '</div>' +
        (items.length > 200 ? ('<div class=\"muted\" style=\"margin-top:10px\">仅展示前 200 条</div>') : '');
    }

    async function loadTaskDetails(name){
      const type = String(name || '').trim();
      if (!type) return null;

      const sid = safeId(type);
      const wrap = $('taskDetailsWrap-' + sid);
      if (wrap && state.taskOpen[type]) {
        wrap.innerHTML = '<div class=\"muted\">加载中…</div>';
      }

      let data = null;
      try {
        data = await api('/task-details/' + encodeURIComponent(type));
      } catch (e) {
        data = { error: e && e.message ? e.message : String(e) };
      }

      state.taskDetails[type] = data;
      updateTaskTypeSummaryDom(type);

      if (wrap && state.taskOpen[type]) {
        wrap.innerHTML = renderTaskDetailsHtml(type, data);
      }

      return data;
    }

    async function cancelTask(name, id){
      const type = String(name || '').trim();
      const taskId = String(id || '').trim();
      if (!type || !taskId) return;
      await api('/tasks/' + encodeURIComponent(type) + '/cancel/' + encodeURIComponent(taskId), { method: 'POST' });
      toast('已取消');
      await loadTasks().catch(() => {});
      await loadTaskDetails(type).catch(() => {});
    }

    async function deleteTask(name, id){
      const type = String(name || '').trim();
      const taskId = String(id || '').trim();
      if (!type || !taskId) return;
      await api('/tasks/' + encodeURIComponent(type) + '/delete/' + encodeURIComponent(taskId), { method: 'DELETE' });
      toast('已删除');
      await loadTasks().catch(() => {});
      await loadTaskDetails(type).catch(() => {});
    }

    async function retryTask(name, id){
      const type = String(name || '').trim();
      const taskId = String(id || '').trim();
      if (!type || !taskId) return;
      await api('/tasks/' + encodeURIComponent(type) + '/retry/' + encodeURIComponent(taskId), { method: 'POST' });
      toast('已触发重试');
      await loadTasks().catch(() => {});
      await loadTaskDetails(type).catch(() => {});
    }

    async function deleteCompletedTasks(name){
      const type = String(name || '').trim();
      if (!type) return;
      const res = await api('/tasks/' + encodeURIComponent(type) + '/completed', { method: 'DELETE' });
      toast('已删除已完成: ' + (res && typeof res.deleted === 'number' ? res.deleted : '-'));
      await loadTasks().catch(() => {});
      await loadTaskDetails(type).catch(() => {});
    }

    // === Launch page ===
    function loadRecentLaunches(){
      try {
        const raw = localStorage.getItem('piDashboard.recentLaunches') || '[]';
        const arr = JSON.parse(raw);
        state.recentLaunches = Array.isArray(arr) ? arr.slice(0, 12) : [];
      } catch {
        state.recentLaunches = [];
      }
    }

    function saveRecentLaunches(){
      try {
        localStorage.setItem('piDashboard.recentLaunches', JSON.stringify(state.recentLaunches.slice(0, 12)));
      } catch {}
    }

    function addRecentLaunch(entry){
      const item = entry && typeof entry === 'object' ? entry : {};
      const next = [{
        type: String(item.type || ''),
        args: Array.isArray(item.args) ? item.args.map(String) : [],
        pid: item.pid || null,
        at: item.at || new Date().toISOString()
      }].concat(state.recentLaunches || []);
      state.recentLaunches = next.filter(x => x && x.type).slice(0, 12);
      saveRecentLaunches();
    }

    function renderLaunchRecent(){
      const el = $('launchRecent');
      if (!el) return;

      const list = Array.isArray(state.recentLaunches) ? state.recentLaunches : [];
      if (list.length === 0) {
        el.innerHTML = '<div class=\"muted\">无</div>';
        return;
      }

      el.innerHTML = list.map((it) => {
        const type = String(it?.type || '');
        const args = Array.isArray(it?.args) ? it.args : [];
        const cached = state.taskDetails && state.taskDetails[type] ? state.taskDetails[type] : null;
        const summary = cached && !cached.error ? summarizeTaskItems(getTaskItems(cached)) : null;
        const statusText = cached && cached.error
          ? ('<span class=\"badge bad\">' + escapeHtml(cached.error) + '</span>')
          : (summary ? renderTaskSummaryBadges(summary) : '<span class=\"badge\">-</span>');

        return '' +
          '<div style=\"display:flex; gap:10px; align-items:flex-start; justify-content:space-between; padding:8px 10px; border:1px solid var(--border); border-radius:12px; background:rgba(0,0,0,.14); margin-bottom:10px\">' +
            '<div style=\"min-width:0\">' +
              '<div class=\"mono\" style=\"font-weight:700\">' + escapeHtml(type) + (it.pid ? ('（PID ' + escapeHtml(it.pid) + '）') : '') + '</div>' +
              '<div class=\"muted\" style=\"margin-top:4px\">' + escapeHtml(it.at || '-') + (args.length ? (' · 参数: ' + escapeHtml(args.join(' '))) : '') + '</div>' +
            '</div>' +
            '<div style=\"text-align:right\">' + statusText + '</div>' +
          '</div>';
      }).join('');
    }

    async function loadTaskTypes(force){
      if (!force && state.taskTypes) {
        renderLaunchTypes(state.taskTypes);
        return state.taskTypes;
      }

      $('launchBadge').textContent = '加载中…';
      $('launchBadge').className = 'badge';

      let types = null;
      try {
        const data = await api('/task-types');
        types = (data && data.types && typeof data.types === 'object') ? data.types : {};
      } catch (e) {
        $('launchBadge').textContent = '错误';
        $('launchBadge').className = 'badge bad';
        $('launchTypes').innerHTML = '<div class=\"muted\">' + escapeHtml(e.message) + '</div>';
        return null;
      }

      state.taskTypes = types;
      renderLaunchTypes(types);

      const count = Object.keys(types || {}).length;
      $('launchBadge').textContent = count ? (count + ' 种') : '0';
      $('launchBadge').className = 'badge ' + (count ? 'good' : '');

      return types;
    }

    function renderLaunchTypes(types){
      const el = $('launchTypes');
      if (!el) return;

      const obj = (types && typeof types === 'object') ? types : {};
      const names = Object.keys(obj).sort((a, b) => String(a).localeCompare(String(b)));
      if (names.length === 0) {
        el.innerHTML = '<div class=\"muted\">无可用任务类型</div>';
        return;
      }

      el.innerHTML = names.map((name) => {
        const def = obj[name] || {};
        const desc = def.description || def.command || '';
        const args = def.args && typeof def.args === 'object' ? def.args : {};
        const argKeys = Object.keys(args);

        const argHtml = argKeys.length === 0
          ? '<div class=\"muted\">无可选参数</div>'
          : argKeys.map((k) => {
              const d = args[k];
              return '' +
                '<label style=\"display:flex; gap:10px; align-items:flex-start; padding:6px 8px; border:1px solid var(--border); border-radius:12px; background:rgba(0,0,0,.14); margin-bottom:8px; cursor:pointer\">' +
                  '<input type=\"checkbox\" class=\"launch-arg\" data-type=\"' + escapeHtml(name) + '\" value=\"' + escapeHtml(k) + '\" style=\"margin-top:2px\" />' +
                  '<div style=\"min-width:0\">' +
                    '<div class=\"mono\" style=\"font-size:12px; font-weight:700\">' + escapeHtml(k) + '</div>' +
                    '<div class=\"muted\" style=\"font-size:12px; line-height:1.4\">' + escapeHtml(d || '-') + '</div>' +
                  '</div>' +
                '</label>';
            }).join('');

        return '' +
          '<div class=\"card\" data-name=\"' + escapeHtml(name) + '\">' +
            '<div style=\"display:flex; gap:12px; align-items:flex-start; justify-content:space-between\">' +
              '<div style=\"min-width:0\">' +
                '<div class=\"mono\" style=\"font-weight:800; font-size:14px; margin-bottom:4px\">' + escapeHtml(name) + '</div>' +
                '<div class=\"muted\" style=\"font-size:12px; line-height:1.4\">' + escapeHtml(desc || '-') + '</div>' +
              '</div>' +
              '<div>' +
                '<button class=\"btn\" data-action=\"launch-task\" data-type=\"' + escapeHtml(name) + '\">启动</button>' +
              '</div>' +
            '</div>' +
            '<div style=\"margin-top:10px; max-height:240px; overflow:auto\">' + argHtml + '</div>' +
          '</div>';
      }).join('');
    }

    async function launchTask(type){
      const t = String(type || '').trim();
      if (!t) return;

      // task type names are safe (a-z/0-9/-), so a simple attribute selector is OK here.
      const args = Array.from(document.querySelectorAll('input.launch-arg[data-type=\"' + t + '\"]:checked')).map((cb) => cb.value);

      const btn = document.querySelector('button[data-action=\"launch-task\"][data-type=\"' + t + '\"]');
      if (btn) {
        btn.disabled = true;
        btn.textContent = '启动中…';
      }

      try {
        const res = await api('/tasks/start', { method: 'POST', body: { type: t, args } });
        if (res && res.success) {
          addRecentLaunch({ type: t, args, pid: res.pid || null, at: new Date().toISOString() });
          toast('已启动：' + t);
          await loadTasks().catch(() => {});
          await loadLaunchRecent().catch(() => {});
        } else {
          toast('启动失败：' + (res && res.error ? res.error : 'unknown'));
        }
      } catch (e) {
        toast('启动失败：' + (e && e.message ? e.message : String(e)));
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = '启动';
        }
      }
    }

    async function loadLaunchRecent(){
      loadRecentLaunches();
      renderLaunchRecent();

      // Refresh task-details for recently launched types (best effort).
      const types = Array.from(new Set((state.recentLaunches || []).map(x => x && x.type).filter(Boolean))).slice(0, 6);
      for (const t of types) {
        await loadTaskDetails(t).catch(() => {});
      }
      renderLaunchRecent();
    }

    // === Config page ===
    function setConfigMsg(kind, msg){
      const el = $('configMsg');
      if (!el) return;
      const m = String(msg || '').trim();
      if (!m) {
        el.innerHTML = '';
        return;
      }
      const cls = kind === 'bad' ? 'bad' : (kind === 'good' ? 'good' : '');
      el.innerHTML = '<span class=\"badge ' + cls + '\">' + escapeHtml(m) + '</span>';
    }

    async function loadConfig(){
      $('configBadge').textContent = '加载中…';
      $('configBadge').className = 'badge';
      setConfigMsg('', '');

      try {
        const data = await api('/config');
        state.config = data;
        $('configText').value = JSON.stringify(data || {}, null, 2);
        $('configBadge').textContent = '已加载';
        $('configBadge').className = 'badge good';
      } catch (e) {
        $('configBadge').textContent = '错误';
        $('configBadge').className = 'badge bad';
        $('configText').value = '{}';
        setConfigMsg('bad', e && e.message ? e.message : String(e));
      }
    }

    async function saveConfig(){
      setConfigMsg('', '');

      let parsed = null;
      const raw = String($('configText').value || '');
      try {
        parsed = raw.trim() ? JSON.parse(raw) : {};
      } catch (e) {
        setConfigMsg('bad', 'JSON 格式错误: ' + (e && e.message ? e.message : String(e)));
        return;
      }

      $('btnSaveConfig').disabled = true;
      $('btnResetConfig').disabled = true;
      $('configBadge').textContent = '保存中…';
      $('configBadge').className = 'badge';

      try {
        await api('/config', { method: 'PUT', body: parsed });
        $('configBadge').textContent = '已保存';
        $('configBadge').className = 'badge good';
        setConfigMsg('good', '已保存');
        toast('配置已保存');
        // Refresh dependent pages.
        loadStatus().catch(() => {});
        loadModules().catch(() => {});
      } catch (e) {
        $('configBadge').textContent = '错误';
        $('configBadge').className = 'badge bad';
        setConfigMsg('bad', e && e.message ? e.message : String(e));
      } finally {
        $('btnSaveConfig').disabled = false;
        $('btnResetConfig').disabled = false;
      }
    }

    function clearSvg(svg){
      while (svg.firstChild) svg.removeChild(svg.firstChild);
    }

    function renderGraph(svgId, graph, focusId){
      const svg = typeof svgId === 'string' ? $(svgId) : svgId;
      if (!svg) return;
      clearSvg(svg);

      if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
        const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        t.setAttribute('x', '16');
        t.setAttribute('y', '28');
        t.setAttribute('fill', 'rgba(255,255,255,.65)');
        t.setAttribute('font-size', '13');
        t.textContent = '无可视化数据（先运行 pi deps build）';
        svg.appendChild(t);
        return;
      }

      const nodes = graph.nodes.slice(0);
      const edges = Array.isArray(graph.edges) ? graph.edges.slice(0) : [];
      const byId = new Map(nodes.map(n => [n.id, n]));
      const out = new Map();
      const inc = new Map();
      nodes.forEach(n => { out.set(n.id, []); inc.set(n.id, []); });
      edges.forEach(e => {
        if (!out.has(e.source)) out.set(e.source, []);
        if (!inc.has(e.target)) inc.set(e.target, []);
        out.get(e.source).push(e.target);
        inc.get(e.target).push(e.source);
      });

      // Layout: focus-centered levels (incoming on left, outgoing on right)
      const focus = focusId && byId.has(focusId) ? focusId : (graph.focus && byId.has(graph.focus) ? graph.focus : nodes[0].id);
      const level = new Map();
      level.set(focus, 0);

      function bfs(start, dir){
        const q = [{ id: start, d: 0 }];
        const seen = new Set([start]);
        for (let i = 0; i < q.length; i++) {
          const cur = q[i];
          if (cur.d >= 2) continue;
          const nexts = dir === 'out' ? (out.get(cur.id) || []) : (inc.get(cur.id) || []);
          nexts.forEach(nid => {
            if (seen.has(nid)) return;
            seen.add(nid);
            const lv = dir === 'out' ? (cur.d + 1) : -(cur.d + 1);
            if (!level.has(nid) || Math.abs(lv) < Math.abs(level.get(nid))) level.set(nid, lv);
            q.push({ id: nid, d: cur.d + 1 });
          });
        }
      }
      bfs(focus, 'out');
      bfs(focus, 'in');

      const groups = {};
      nodes.forEach(n => {
        const lv = level.has(n.id) ? level.get(n.id) : 0;
        if (!groups[lv]) groups[lv] = [];
        groups[lv].push(n);
      });

      const levels = Object.keys(groups).map(Number).sort((a,b) => a-b);
      const xGap = 240;
      const yGap = 44;
      const marginX = 40;
      const centerY = 260;

      /** @type {Map<string, {x:number,y:number,lv:number}>} */
      const pos = new Map();
      levels.forEach((lv) => {
        const arr = groups[lv].slice(0).sort((a,b) => String(a.id).localeCompare(String(b.id)));
        const x = marginX + (lv - levels[0]) * xGap;
        const total = arr.length;
        arr.forEach((n, idx) => {
          const y = centerY + (idx - (total - 1) / 2) * yGap;
          pos.set(n.id, { x, y, lv });
        });
      });

      // defs
      const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
      defs.innerHTML =
        '<marker id=\"arrow\" viewBox=\"0 0 10 10\" refX=\"10\" refY=\"5\" markerWidth=\"7\" markerHeight=\"7\" orient=\"auto-start-reverse\">' +
        '<path d=\"M 0 0 L 10 5 L 0 10 z\" fill=\"rgba(255,255,255,.35)\"></path>' +
        '</marker>';
      svg.appendChild(defs);

      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      svg.appendChild(g);

      // edges
      edges.forEach(e => {
        if (!pos.has(e.source) || !pos.has(e.target)) return;
        const a = pos.get(e.source);
        const b = pos.get(e.target);
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', String(a.x + 140));
        line.setAttribute('y1', String(a.y));
        line.setAttribute('x2', String(b.x));
        line.setAttribute('y2', String(b.y));
        line.setAttribute('stroke', 'rgba(255,255,255,.18)');
        line.setAttribute('stroke-width', '1');
        line.setAttribute('marker-end', 'url(#arrow)');
        g.appendChild(line);
      });

      // nodes
      nodes.forEach(n => {
        if (!pos.has(n.id)) return;
        const p = pos.get(n.id);
        const nodeG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        nodeG.setAttribute('transform', 'translate(' + p.x + ',' + (p.y - 14) + ')');
        nodeG.style.cursor = 'pointer';

        const isFocus = n.id === focus;
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('width', '140');
        rect.setAttribute('height', '28');
        rect.setAttribute('rx', '10');
        rect.setAttribute('fill', isFocus ? 'rgba(91,140,255,.28)' : 'rgba(255,255,255,.06)');
        rect.setAttribute('stroke', isFocus ? 'rgba(91,140,255,.65)' : 'rgba(255,255,255,.14)');
        nodeG.appendChild(rect);

        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', '10');
        text.setAttribute('y', '18');
        text.setAttribute('fill', 'rgba(255,255,255,.86)');
        text.setAttribute('font-size', '12');
        text.setAttribute('font-family', 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace');
        text.textContent = n.label || n.id;
        nodeG.appendChild(text);

        nodeG.addEventListener('click', () => {
          $('depsFocus').value = n.id;
          loadDeps(n.id);
        });

        g.appendChild(nodeG);
      });

      // basic pan/zoom
      let panX = 0, panY = 0, scale = 1;
      let dragging = false, lastX = 0, lastY = 0;
      function apply(){
        g.setAttribute('transform', 'translate(' + panX + ',' + panY + ') scale(' + scale + ')');
      }
      apply();
      svg.addEventListener('wheel', (ev) => {
        ev.preventDefault();
        const delta = ev.deltaY > 0 ? 0.92 : 1.08;
        scale = Math.max(0.35, Math.min(2.8, scale * delta));
        apply();
      }, { passive: false });
      svg.addEventListener('pointerdown', (ev) => {
        dragging = true;
        lastX = ev.clientX;
        lastY = ev.clientY;
        svg.setPointerCapture(ev.pointerId);
      });
      svg.addEventListener('pointermove', (ev) => {
        if (!dragging) return;
        panX += (ev.clientX - lastX);
        panY += (ev.clientY - lastY);
        lastX = ev.clientX;
        lastY = ev.clientY;
        apply();
      });
      svg.addEventListener('pointerup', (ev) => {
        dragging = false;
        try { svg.releasePointerCapture(ev.pointerId); } catch {}
      });
    }

    async function loadStatus(){
      const data = await api('/status');
      renderStatus(data);
    }

    async function loadModules(){
      const data = await api('/modules');
      renderModules(data);
    }

    async function openModule(modulePath){
      navigate('module', { path: modulePath });
      return false;
    }
    window.openModule = openModule;

    async function loadModuleDetail(){
      const sp = new URLSearchParams(location.search || '');
      const p = sp.get('path') || '';
      if (!p) {
        $('moduleTitle').textContent = '-';
        $('moduleBadge').textContent = 'missing path';
        $('moduleBadge').className = 'badge bad';
        return;
      }
      $('moduleTitle').textContent = p;
      $('moduleBadge').textContent = 'loading…';
      $('moduleBadge').className = 'badge';

      try {
        const data = await api('/modules?path=' + encodeURIComponent(p));
        const m = data.module;
        if (!m) throw new Error('No module data');
        $('moduleBadge').textContent = (m.stale.doc || m.stale.audit || m.stale.test) ? 'stale' : 'ok';
        $('moduleBadge').className = 'badge ' + ((m.stale.doc || m.stale.audit || m.stale.test) ? 'warn' : 'good');

        const f = data.files || {};
        const lines = [];
        lines.push('CLAUDE.md: ' + (f.doc && f.doc.exists ? ('OK @ ' + f.doc.mtime) : 'missing'));
        lines.push('AUDIT.md : ' + (f.audit && f.audit.exists ? ('OK @ ' + f.audit.mtime) : 'missing'));
        if (m.staleInfo && m.staleInfo.type) {
          lines.push('stale: ' + m.staleInfo.type + (m.staleInfo.newestFile ? (' · newest=' + m.staleInfo.newestFile) : ''));
        }
        $('moduleFiles').innerHTML = lines.map(x => '<div>' + escapeHtml(x) + '</div>').join('');

        const tests = data.tests || {};
        const tParts = [];
        tParts.push('<div class=\"muted\" style=\"margin-bottom:6px\">summary: total ' + (tests.summary ? tests.summary.total : 0) + ' · stale ' + (tests.summary ? tests.summary.stale : 0) + ' · untested ' + (tests.summary ? tests.summary.untested : 0) + '</div>');
        const staleList = Array.isArray(tests.stale) ? tests.stale : [];
        const untestedList = Array.isArray(tests.untested) ? tests.untested : [];
        if (staleList.length === 0 && untestedList.length === 0) {
          tParts.push('<div class=\"badge good\">No stale/untested tests</div>');
        } else {
          staleList.slice(0, 100).forEach(item => {
            tParts.push('<div class=\"mono\" style=\"margin-bottom:6px\">stale: ' + escapeHtml(item.source) + ' → ' + escapeHtml(item.actualTest || item.expectedTest || '-') + '</div>');
          });
          untestedList.slice(0, 100).forEach(item => {
            tParts.push('<div class=\"mono\" style=\"margin-bottom:6px\">untested: ' + escapeHtml(item.source) + ' → ' + escapeHtml(item.expectedTest || '-') + '</div>');
          });
        }
        $('moduleTests').innerHTML = tParts.join('');

        // deps subgraph for module
        $('moduleGraphHint').textContent = '加载中…';
        const sub = await api('/deps?module=' + encodeURIComponent(p) + '&maxNodes=1200');
        if (sub && sub.nodes) {
          renderGraph('moduleGraph', sub, sub.focus || null);
          $('moduleGraphHint').textContent =
            'nodes: ' + sub.nodes.length + ' · edges: ' + (sub.edges ? sub.edges.length : 0) +
            (sub.error ? (' · ' + sub.error) : '');
        } else {
          $('moduleGraphHint').textContent = '无 dep graph 数据';
        }
      } catch (e) {
        $('moduleBadge').textContent = 'error';
        $('moduleBadge').className = 'badge bad';
        $('moduleFiles').textContent = String(e && e.message ? e.message : e);
        $('moduleTests').textContent = '';
      }
    }

    async function loadTasks(){
      const data = await api('/tasks');
      renderTasks(data);
    }

    async function loadDeps(focus){
      const q = focus ? ('?focus=' + encodeURIComponent(focus) + '&depth=2&maxNodes=900') : ('?maxNodes=900');
      const data = await api('/deps' + q);
      state.deps = data;
      $('depsHint').textContent = data.error ? data.error : ('nodes: ' + (data.nodes ? data.nodes.length : 0) + ' · edges: ' + (data.edges ? data.edges.length : 0));
      renderGraph('depsGraph', data, data.focus || null);
    }

    function bindUI(){
      document.querySelectorAll('.tab').forEach(t => {
        t.addEventListener('click', () => navigate(t.dataset.tab));
      });
      $('btnRefresh').addEventListener('click', async () => {
        try { await loadStatus(); toast('已刷新'); } catch (e) { toast(e.message); }
      });
      $('btnOpenDeps').addEventListener('click', () => navigate('deps'));
      $('btnReloadModules').addEventListener('click', async () => { try { await loadModules(); } catch (e) { toast(e.message); } });
      $('moduleFilter').addEventListener('input', () => { if (state.modules) renderModules(state.modules); });
      $('btnBackModules').addEventListener('click', () => navigate('modules'));
      $('btnReloadTasks').addEventListener('click', async () => { try { await loadTasks(); } catch (e) { toast(e.message); } });
      $('btnReloadLaunch').addEventListener('click', async () => { try { await loadTaskTypes(true); toast('已刷新'); } catch (e) { toast(e.message); } });
      $('btnResetConfig').addEventListener('click', async () => { try { await loadConfig(); toast('已重置'); } catch (e) { toast(e.message); } });
      $('btnSaveConfig').addEventListener('click', async () => { try { await saveConfig(); } catch (e) { toast(e.message); } });

      // Launch page: start task
      $('launchTypes').addEventListener('click', (ev) => {
        const btn = ev.target && ev.target.closest ? ev.target.closest('button[data-action=\"launch-task\"]') : null;
        if (!btn) return;
        const type = btn.dataset.type || '';
        launchTask(type).catch((e) => toast(e.message));
      });

      // Tasks page: details + actions
      $('taskTypeCards').addEventListener('click', (ev) => {
        const btn = ev.target && ev.target.closest ? ev.target.closest('button[data-action]') : null;
        if (!btn) return;
        const action = btn.dataset.action || '';
        const name = btn.dataset.name || '';
        const id = btn.dataset.id || '';

        if (action === 'toggle-task-details') {
          const open = !state.taskOpen[name];
          state.taskOpen[name] = open;

          const sid = safeId(name);
          const wrap = $('taskDetailsWrap-' + sid);
          if (wrap) {
            wrap.classList.toggle('hidden', !open);
            if (open) {
              // Render cached first, then refresh from API.
              const cached = state.taskDetails && state.taskDetails[name] ? state.taskDetails[name] : null;
              wrap.innerHTML = cached ? renderTaskDetailsHtml(name, cached) : '<div class=\"muted\">加载中…</div>';
              loadTaskDetails(name).catch(() => {});
            }
          }
          btn.textContent = open ? '收起' : '展开';
          return;
        }

        if (action === 'refresh-task-details') {
          loadTaskDetails(name).catch((e) => toast(e.message));
          return;
        }

        if (action === 'delete-completed') {
          if (!confirm('确认批量删除已完成任务？')) return;
          deleteCompletedTasks(name).catch((e) => toast(e.message));
          return;
        }

        if (action === 'task-cancel') {
          cancelTask(name, id).catch((e) => toast(e.message));
          return;
        }

        if (action === 'task-delete') {
          if (!confirm('确认删除该任务记录？')) return;
          deleteTask(name, id).catch((e) => toast(e.message));
          return;
        }

        if (action === 'task-retry') {
          retryTask(name, id).catch((e) => toast(e.message));
          return;
        }
      });

      $('btnRenderDeps').addEventListener('click', async () => {
        const focus = String($('depsFocus').value || '').trim();
        try { await loadDeps(focus || null); } catch (e) { toast(e.message); }
      });
      window.addEventListener('popstate', onRoute);
    }

    function connectSse(){
      try {
        if (state.sse) state.sse.close();
      } catch {}
      const sse = new EventSource('/api/events');
      state.sse = sse;
      setConn(false);

      sse.addEventListener('open', () => setConn(true));
      sse.addEventListener('error', () => setConn(false));
      sse.addEventListener('update', async (ev) => {
        try {
          const payload = JSON.parse(ev.data || '{}');
          if (payload.status) renderStatus(payload.status);
          if (payload.tasks) renderTasks(payload.tasks);
          // If user is on modules/module page, refresh modules at a low rate.
          const p = location.pathname.replace(/\\/+$/, '') || '/';
          if (p === '/modules' || p === '/module') {
            if (!state.__nextModuleRefresh || Date.now() > state.__nextModuleRefresh) {
              state.__nextModuleRefresh = Date.now() + 3000;
              loadModules().catch(() => {});
              if (p === '/module') loadModuleDetail().catch(() => {});
            }
          }
        } catch {}
      });
    }

    async function boot(){
      bindUI();
      onRoute();
      try { await loadStatus(); } catch (e) { toast(e.message); }
      try { await loadModules(); } catch (e) { $('modulesTable').innerHTML = '<tr><td colspan=\"5\" class=\"muted\">' + escapeHtml(e.message) + '</td></tr>'; }
      try { await loadTasks(); } catch (e) { /* ignore */ }
      try { await loadDeps(null); } catch (e) { /* ignore */ }
      if (location.pathname === '/module') {
        await loadModuleDetail().catch(() => {});
      }
      connectSse();
    }

    boot();
  </script>
</body>
</html>`;
}

/**
 * @param {string} input
 * @returns {string}
 */
function escapeHtml(input) {
  return String(input || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * @param {http.IncomingMessage} req
 * @returns {Promise<any>}
 */
async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Start dashboard server
 * @param {{root: string, config: ProjectConfig}} ctx
 * @param {number} port
 */
export async function startServer(ctx, port = 3008) {
  const normalizedCtx = normalizeCtx(ctx);
  const { root, config } = normalizedCtx;

  /** @type {Set<http.ServerResponse>} */
  const sseClients = new Set();

  let sseTimer = null;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const pathname = url.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive'
        });
        res.write('\n');
        sseClients.add(res);

        req.on('close', () => {
          sseClients.delete(res);
        });

        // Lazy-start broadcaster
        if (!sseTimer) {
          sseTimer = setInterval(async () => {
            if (sseClients.size === 0) return;
            const status = await cachedFetch(`status:${root}`, CACHE_TTL_MS.status, () => apiStatus(normalizedCtx));
            const tasks = await cachedFetch(`tasks:${root}`, CACHE_TTL_MS.tasks, () => apiTasks(normalizedCtx));
            const payload = { status, tasks, ts: Date.now() };
            for (const client of sseClients) {
              try {
                sseSend(client, 'update', payload);
              } catch {
                sseClients.delete(client);
              }
            }
          }, 1000);
        }

        // immediate push
        const status = await cachedFetch(`status:${root}`, CACHE_TTL_MS.status, () => apiStatus(normalizedCtx));
        const tasks = await cachedFetch(`tasks:${root}`, CACHE_TTL_MS.tasks, () => apiTasks(normalizedCtx));
        sseSend(res, 'update', { status, tasks, ts: Date.now() });
        return;
      }

      // API routes
      if (pathname === '/api/status') {
        const data = await cachedFetch(`status:${root}`, CACHE_TTL_MS.status, () => apiStatus(normalizedCtx));
        sendJson(res, 200, data);
        return;
      }
      if (pathname === '/api/modules') {
        const key = `modules:${root}:${url.search}`;
        const data = await cachedFetch(key, CACHE_TTL_MS.modules, () => apiModules(normalizedCtx, url.searchParams));
        sendJson(res, 200, data);
        return;
      }
      if (pathname === '/api/tasks') {
        const data = await cachedFetch(`tasks:${root}`, CACHE_TTL_MS.tasks, () => apiTasks(normalizedCtx));
        sendJson(res, 200, data);
        return;
      }
      if (pathname === '/api/deps') {
        const key = `deps:${root}:${url.search}`;
        const data = await cachedFetch(key, CACHE_TTL_MS.deps, () => apiDeps(normalizedCtx, url.searchParams));
        sendJson(res, 200, data);
        return;
      }

      // === Task management APIs (dashboard.js compatible) ===
      if (req.method === 'GET' && pathname === '/api/task-types') {
        const manager = new TaskManager(normalizedCtx);
        sendJson(res, 200, { types: manager.getTypes() });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/tasks/start') {
        let body = null;
        try {
          body = await parseBody(req);
        } catch (err) {
          sendJson(res, 400, { error: toErrorMessage(err) });
          return;
        }

        const type = String(body?.type || '').trim();
        if (!type) {
          sendJson(res, 400, { error: 'Missing required field: type' });
          return;
        }

        const args = Array.isArray(body?.args) ? body.args.map((a) => String(a)) : [];
        const projectRaw = body?.project;
        const project = typeof projectRaw === 'string' && projectRaw.trim()
          ? (path.isAbsolute(projectRaw) ? projectRaw : path.join(root, projectRaw))
          : root;

        const manager = new TaskManager(normalizedCtx);
        const result = await manager.launchTask(type, args, project);

        // Best-effort cache invalidation; background refresh will fill in again.
        API_CACHE.delete(`tasks:${root}`);
        API_CACHE.delete(`status:${root}`);
        invalidateApiCache(`task-details:${root}:`);
        invalidateApiCache(`history:${root}:`);

        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'POST' && pathname.match(/^\/api\/tasks\/[^/]+\/cancel\/[^/]+$/)) {
        const [, , , rawName, , rawId] = pathname.split('/');
        const name = decodeURIComponent(rawName || '');
        const id = decodeURIComponent(rawId || '');

        const manager = new TaskManager(normalizedCtx);
        const result = await manager.cancelTask(name, id);

        API_CACHE.delete(`tasks:${root}`);
        API_CACHE.delete(`status:${root}`);
        invalidateApiCache(`task-details:${root}:${name}`);
        invalidateApiCache(`history:${root}:${name}`);

        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'POST' && pathname.match(/^\/api\/tasks\/[^/]+\/retry\/[^/]+$/)) {
        const [, , , rawName] = pathname.split('/');
        const name = decodeURIComponent(rawName || '');

        const manager = new TaskManager(normalizedCtx);
        const result = await manager.launchTask(name, ['--retry-failed'], root);

        API_CACHE.delete(`tasks:${root}`);
        API_CACHE.delete(`status:${root}`);
        invalidateApiCache(`task-details:${root}:${name}`);
        invalidateApiCache(`history:${root}:${name}`);

        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'DELETE' && pathname.match(/^\/api\/tasks\/[^/]+\/delete\/[^/]+$/)) {
        const [, , , rawName, , rawId] = pathname.split('/');
        const name = decodeURIComponent(rawName || '');
        const id = decodeURIComponent(rawId || '');

        const manager = new TaskManager(normalizedCtx);
        const result = await manager.deleteTask(name, id);

        API_CACHE.delete(`tasks:${root}`);
        API_CACHE.delete(`status:${root}`);
        invalidateApiCache(`task-details:${root}:${name}`);
        invalidateApiCache(`history:${root}:${name}`);

        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'DELETE' && pathname.match(/^\/api\/tasks\/[^/]+\/completed$/)) {
        const [, , , rawName] = pathname.split('/');
        const name = decodeURIComponent(rawName || '');

        const manager = new TaskManager(normalizedCtx);
        const result = await manager.deleteCompletedTasks(name);

        API_CACHE.delete(`tasks:${root}`);
        API_CACHE.delete(`status:${root}`);
        invalidateApiCache(`task-details:${root}:${name}`);
        invalidateApiCache(`history:${root}:${name}`);

        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'GET' && pathname.startsWith('/api/task-details/')) {
        const rawName = pathname.slice('/api/task-details/'.length);
        const name = decodeURIComponent(rawName || '');

        const key = `task-details:${root}:${name}`;
        const data = await cachedFetch(key, CACHE_TTL_MS.taskDetails, async () => {
          const manager = new TaskManager(normalizedCtx);
          return await manager.getTaskStatus(name) || { error: 'No data' };
        });

        sendJson(res, 200, data);
        return;
      }

      if (req.method === 'GET' && pathname.startsWith('/api/history/')) {
        const rawName = pathname.slice('/api/history/'.length);
        const name = decodeURIComponent(rawName || '');

        const key = `history:${root}:${name}`;
        const data = await cachedFetch(key, CACHE_TTL_MS.history, async () => {
          const cachePath = getCachePath(config, root, `.${name}-history.json`);
          const rootPath = path.join(root, `.${name}-history.json`);

          const raw = await readJsonSafe(cachePath, null) ?? await readJsonSafe(rootPath, []);
          const entries = Array.isArray(raw)
            ? raw
            : (Array.isArray(raw?.history) ? raw.history : (Array.isArray(raw?.entries) ? raw.entries : []));

          return { history: entries.slice(-10).reverse() };
        });

        sendJson(res, 200, data);
        return;
      }

      // === Config APIs ===
      if (req.method === 'GET' && pathname === '/api/config') {
        const cachePath = getCachePath(config, root, '.stale-config.json');
        const rootPath = path.join(root, '.stale-config.json');
        const data = await readJsonSafe(cachePath, null) ?? await readJsonSafe(rootPath, {});
        sendJson(res, 200, data || {});
        return;
      }

      if (req.method === 'PUT' && pathname === '/api/config') {
        let body = null;
        try {
          body = await parseBody(req);
        } catch (err) {
          sendJson(res, 400, { error: toErrorMessage(err) });
          return;
        }

        const configPath = getCachePath(config, root, '.stale-config.json');
        await writeJsonSafe(configPath, body || {});

        // Refresh in-memory staleConfig so subsequent APIs (modules/status) reflect changes.
        normalizedCtx.staleConfig = await loadStaleConfig(root, config);

        // Invalidate data that depends on staleConfig.
        API_CACHE.delete(`status:${root}`);
        invalidateApiCache(`modules:${root}:`);

        sendJson(res, 200, { success: true });
        return;
      }

      // === Cache APIs ===
      if (req.method === 'POST' && pathname === '/api/cache/clear') {
        API_CACHE.clear();
        sendJson(res, 200, { success: true, message: 'Cache cleared' });
        return;
      }

      // === Stale status APIs ===
      if (req.method === 'GET' && pathname === '/api/stale-status') {
        const only = url.searchParams.get('only') || undefined;
        const key = `stale-status:${root}:${url.search}`;
        const data = await cachedFetch(key, CACHE_TTL_MS.staleStatus, () => checkStaleStatus(normalizedCtx, { only }));
        sendJson(res, 200, data);
        return;
      }

      if (pathname.startsWith('/api/')) {
        const body = req.method === 'GET' ? null : await parseBody(req).catch(() => ({}));
        sendJson(res, 404, { error: `Unknown API endpoint: ${pathname}`, ...(body ? { body } : {}) });
        return;
      }

      // HTML pages (single-file, inline assets)
      if (req.method === 'GET') {
        const html = getDashboardHtml(normalizedCtx);
        sendHtml(res, 200, html);
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      sendJson(res, 500, { error: toErrorMessage(err) });
    }
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log(`Port ${port} in use, trying ${port + 1}...`);
      server.close();
      server.listen(++port);
    } else {
      console.error(e);
      process.exitCode = 1;
    }
  });

  server.on('listening', () => {
    console.log(`\nDashboard running at http://localhost:${port}`);
    console.log(`Project: ${config.name} (${root})`);
    console.log(`Cache: ${config.cache || '(default)'}\n`);
  });

  server.on('close', () => {
    if (sseTimer) clearInterval(sseTimer);
    sseTimer = null;
    for (const res of sseClients) {
      try {
        res.end();
      } catch {}
    }
    sseClients.clear();
  });

  server.listen(port);
}

/**
 * Get server info
 */
export function getServerInfo() {
  return {
    version: '2.0.0',
    features: [
      'api/status',
      'api/modules',
      'api/tasks',
      'api/task-types',
      'api/tasks/start',
      'api/tasks/:name/cancel/:id',
      'api/tasks/:name/retry/:id',
      'api/tasks/:name/delete/:id',
      'api/tasks/:name/completed',
      'api/task-details/:name',
      'api/history/:name',
      'api/config',
      'api/cache/clear',
      'api/stale-status',
      'api/deps',
      'sse'
    ]
  };
}
