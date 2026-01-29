/**
 * Update module
 * - Manual update of caches/docs
 * - Background polling updater
 * - Staleness detection
 */

import { promises as fs } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

import { getCachePath } from '../context.js';
import { matchesPattern, readJsonSafe } from '../shared.js';

/** @typedef {import('../types.js').ProjectConfig} ProjectConfig */

const DEFAULT_INTERVAL_MS = 60_000;

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(THIS_DIR, '../../cli.js');

const DEFAULT_IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '__pycache__',
  'venv',
  '.venv',
  'target',
  'vendor',
  '.cache',
  'coverage',
  '.turbo',
  '.nuxt',
  '.output',
  'out',
  '.project-index'
]);

/**
 * @param {unknown} v
 * @param {number} fallback
 * @returns {number}
 */
function toPositiveInt(v, fallback) {
  const n = typeof v === 'number' ? v : Number(String(v || '').trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * @param {string} s
 * @returns {'deps'|'test'|'doc'|null}
 */
function normalizeOnlyTarget(s) {
  const v = String(s || '').trim().toLowerCase();
  if (!v) return null;
  if (v === 'deps' || v === 'dep') return 'deps';
  if (v === 'test' || v === 'tests') return 'test';
  if (v === 'doc' || v === 'docs') return 'doc';
  return null;
}

/**
 * @param {string} filePath
 * @returns {Promise<import('fs').Stats|null>}
 */
async function statSafe(filePath) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

/**
 * Prefer cache JSON "generated" field; fallback to file mtime.
 * @param {string} filePath
 * @returns {Promise<{timeMs: number|null, source: 'json'|'mtime'|'missing'}>}
 */
async function getGeneratedTimeMs(filePath) {
  const st = await statSafe(filePath);
  if (!st) return { timeMs: null, source: 'missing' };

  const json = await readJsonSafe(filePath, null);
  const generated = json && typeof json === 'object' ? json.generated : null;
  if (typeof generated === 'string') {
    const t = Date.parse(generated);
    if (Number.isFinite(t)) return { timeMs: t, source: 'json' };
  }

  return { timeMs: st.mtimeMs, source: 'mtime' };
}

/**
 * Recursively scan directories and find the newest mtime among matching files.
 *
 * @param {object} params
 * @param {string} params.rootAbs
 * @param {string[]} params.dirs
 * @param {string} params.pattern
 * @param {string[]} params.ignore
 * @returns {Promise<{maxMtimeMs: number, maxFile: string|null, scannedFiles: number}>}
 */
async function scanNewestMtime({ rootAbs, dirs, pattern, ignore }) {
  let maxMtimeMs = 0;
  /** @type {string|null} */
  let maxFile = null;
  let scannedFiles = 0;

  /**
   * @param {string} absDir
   */
  async function walk(absDir) {
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absPath = path.join(absDir, entry.name);
      const relPath = path.relative(rootAbs, absPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        if (DEFAULT_IGNORE_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith('.')) continue;
        if (ignore?.some(p => matchesPattern(p, entry.name))) continue;
        if (ignore?.some(p => matchesPattern(p, relPath))) continue;
        await walk(absPath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (!matchesPattern(pattern, relPath)) continue;
      if (ignore?.some(p => matchesPattern(p, relPath))) continue;

      const st = await statSafe(absPath);
      if (!st) continue;
      scannedFiles++;
      if (st.mtimeMs > maxMtimeMs) {
        maxMtimeMs = st.mtimeMs;
        maxFile = relPath;
      }
    }
  }

  for (const d of dirs || []) {
    const abs = path.join(rootAbs, d);
    await walk(abs);
  }

  return { maxMtimeMs, maxFile, scannedFiles };
}

/**
 * Copy cache file to project root for compatibility with legacy scripts/UI.
 * @param {{root: string, config: ProjectConfig}} ctx
 * @param {string} name
 */
async function mirrorCacheToRoot(ctx, name) {
  const cachePath = getCachePath(ctx.config, ctx.root, name);
  const rootPath = path.join(ctx.root, name);

  if (path.resolve(cachePath) === path.resolve(rootPath)) return;

  const st = await statSafe(cachePath);
  if (!st) return;

  await fs.copyFile(cachePath, rootPath);
}

/**
 * @param {string} pidPath
 * @returns {Promise<number|null>}
 */
async function readPidSafe(pidPath) {
  try {
    const raw = await fs.readFile(pidPath, 'utf8');
    const pid = Number(String(raw || '').trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
function isPidRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check stale status for deps/test/doc targets.
 *
 * @param {{root: string, config: ProjectConfig}} ctx
 * @param {Record<string, any>} args
 * @returns {Promise<{
 *   timestamp: string,
 *   staleTargets: Array<'deps'|'test'|'doc'>,
 *   targets: {
 *     deps: any,
 *     test: any,
 *     doc: any
 *   }
 * }>}
 */
export async function checkStale(ctx, args = {}) {
  const { root, config } = ctx;
  const only = normalizeOnlyTarget(args.only);

  const cfgPath = path.join(root, '.pi-config.json');
  const cfgStat = await statSafe(cfgPath);
  const cfgMtimeMs = cfgStat ? cfgStat.mtimeMs : 0;

  /**
   * @param {string} name
   */
  function cachePaths(name) {
    const cachePath = getCachePath(config, root, name);
    const rootPath = path.join(root, name);
    return { cachePath, rootPath };
  }

  /**
   * @param {string} name
   * @returns {Promise<{generatedAtMs: number|null, generatedFrom: string, chosenPath: string|null, paths: {cachePath: string, rootPath: string}}>}
   */
  async function getBestGenerated(name) {
    const paths = cachePaths(name);
    const candidates = [paths.cachePath, paths.rootPath].filter((v, i, arr) => arr.indexOf(v) === i);

    /** @type {Array<{path: string, timeMs: number|null, source: string}>} */
    const times = [];
    for (const p of candidates) {
      const t = await getGeneratedTimeMs(p);
      times.push({ path: p, timeMs: t.timeMs, source: t.source });
    }

    const existing = times.filter(t => typeof t.timeMs === 'number' && Number.isFinite(t.timeMs));
    if (existing.length === 0) {
      return { generatedAtMs: null, generatedFrom: 'missing', chosenPath: null, paths };
    }

    existing.sort((a, b) => (b.timeMs - a.timeMs));
    return {
      generatedAtMs: existing[0].timeMs,
      generatedFrom: existing[0].source,
      chosenPath: existing[0].path,
      paths
    };
  }

  /**
   * @param {object} params
   * @param {'deps'|'test'} params.key
   * @param {string} params.cacheName
   * @param {string[]} params.dirs
   * @param {string} params.pattern
   * @param {string[]} params.ignore
   */
  async function checkCacheTarget({ key, cacheName, dirs, pattern, ignore }) {
    const enabled = Array.isArray(dirs) && dirs.length > 0 && typeof pattern === 'string' && pattern.trim() !== '';

    if (!enabled) {
      return {
        enabled: false,
        stale: false,
        reason: 'missing_config',
        cacheName
      };
    }

    const best = await getBestGenerated(cacheName);
    const { maxMtimeMs, maxFile, scannedFiles } = await scanNewestMtime({
      rootAbs: root,
      dirs,
      pattern,
      ignore
    });

    const newestSourceMs = Math.max(maxMtimeMs, cfgMtimeMs);
    const newestSource = maxMtimeMs >= cfgMtimeMs
      ? (maxFile ? { type: 'file', path: maxFile, mtimeMs: maxMtimeMs } : { type: 'none', path: null, mtimeMs: 0 })
      : { type: 'config', path: '.pi-config.json', mtimeMs: cfgMtimeMs };

    if (!best.generatedAtMs) {
      return {
        enabled: true,
        stale: true,
        reason: 'cache_missing',
        cacheName,
        cache: { ...best },
        source: { newest: newestSource, scannedFiles }
      };
    }

    const stale = newestSourceMs > best.generatedAtMs;
    return {
      enabled: true,
      stale,
      reason: stale ? 'source_newer_than_cache' : 'fresh',
      cacheName,
      cache: {
        ...best,
        generatedAtMs: best.generatedAtMs
      },
      source: { newest: newestSource, scannedFiles }
    };
  }

  /**
   * @returns {Promise<any>}
   */
  async function checkDocTarget() {
    const enabled = Array.isArray(config.src?.dirs) && config.src.dirs.length > 0;
    if (!enabled) {
      return {
        enabled: false,
        stale: false,
        reason: 'missing_config'
      };
    }

    const targetDir = config.src.dirs[0];
    const rootDocPath = path.join(root, targetDir, 'CLAUDE.md');
    const rootDocStat = await statSafe(rootDocPath);
    const generatedAtMs = rootDocStat ? rootDocStat.mtimeMs : null;

    const { maxMtimeMs, maxFile, scannedFiles } = await scanNewestMtime({
      rootAbs: root,
      // doc.generate() defaults to `config.src.dirs[0]`, so staleness should align with that scope.
      dirs: [targetDir],
      pattern: config.src.pattern || '**/*',
      ignore: config.src.ignore || []
    });

    const newestSourceMs = Math.max(maxMtimeMs, cfgMtimeMs);
    const newestSource = maxMtimeMs >= cfgMtimeMs
      ? (maxFile ? { type: 'file', path: maxFile, mtimeMs: maxMtimeMs } : { type: 'none', path: null, mtimeMs: 0 })
      : { type: 'config', path: '.pi-config.json', mtimeMs: cfgMtimeMs };

    if (!generatedAtMs) {
      return {
        enabled: true,
        stale: true,
        reason: 'doc_missing',
        docPath: path.relative(root, rootDocPath).replace(/\\/g, '/'),
        source: { newest: newestSource, scannedFiles }
      };
    }

    const stale = newestSourceMs > generatedAtMs;
    return {
      enabled: true,
      stale,
      reason: stale ? 'source_newer_than_doc' : 'fresh',
      docPath: path.relative(root, rootDocPath).replace(/\\/g, '/'),
      docMtimeMs: generatedAtMs,
      source: { newest: newestSource, scannedFiles }
    };
  }

  const targets = {
    deps: only && only !== 'deps' ? { enabled: false, stale: false, reason: 'filtered' } : await checkCacheTarget({
      key: 'deps',
      cacheName: '.dep-graph.json',
      dirs: config.src?.dirs || [],
      pattern: config.src?.pattern || '**/*',
      ignore: config.src?.ignore || []
    }),
    test: only && only !== 'test' ? { enabled: false, stale: false, reason: 'filtered' } : await (async () => {
      // Test map depends on both src + test directories.
      const dirs = [
        ...(config.src?.dirs || []),
        ...(config.test?.dirs || [])
      ];
      const enabled = Array.isArray(config.src?.dirs) && config.src.dirs.length > 0
        && Array.isArray(config.test?.dirs) && config.test.dirs.length > 0
        && typeof config.test?.pattern === 'string' && config.test.pattern.trim() !== '';

      if (!enabled) {
        return { enabled: false, stale: false, reason: 'missing_config', cacheName: '.test-map.json' };
      }

      // Use test.pattern to scope "test-side" files, but include src-side files too.
      // We approximate with a broad scan using '**/*' and src ignores; this keeps stale detection simple.
      const best = await getBestGenerated('.test-map.json');

      // Scan newest across src files
      const srcScan = await scanNewestMtime({
        rootAbs: root,
        dirs: config.src.dirs,
        pattern: config.src.pattern || '**/*',
        ignore: config.src.ignore || []
      });
      // Scan newest across test files
      const testScan = await scanNewestMtime({
        rootAbs: root,
        dirs: config.test.dirs,
        pattern: config.test.pattern,
        ignore: [] // test ignores not standardized in config yet
      });

      const maxMtimeMs = Math.max(srcScan.maxMtimeMs, testScan.maxMtimeMs);
      const maxFile = srcScan.maxMtimeMs >= testScan.maxMtimeMs ? srcScan.maxFile : testScan.maxFile;
      const scannedFiles = srcScan.scannedFiles + testScan.scannedFiles;

      const newestSourceMs = Math.max(maxMtimeMs, cfgMtimeMs);
      const newestSource = maxMtimeMs >= cfgMtimeMs
        ? (maxFile ? { type: 'file', path: maxFile, mtimeMs: maxMtimeMs } : { type: 'none', path: null, mtimeMs: 0 })
        : { type: 'config', path: '.pi-config.json', mtimeMs: cfgMtimeMs };

      if (!best.generatedAtMs) {
        return {
          enabled: true,
          stale: true,
          reason: 'cache_missing',
          cacheName: '.test-map.json',
          cache: best,
          source: { newest: newestSource, scannedFiles }
        };
      }

      const stale = newestSourceMs > best.generatedAtMs;
      return {
        enabled: true,
        stale,
        reason: stale ? 'source_newer_than_cache' : 'fresh',
        cacheName: '.test-map.json',
        cache: best,
        source: { newest: newestSource, scannedFiles }
      };
    })(),
    doc: only && only !== 'doc' ? { enabled: false, stale: false, reason: 'filtered' } : await checkDocTarget()
  };

  /** @type {Array<'deps'|'test'|'doc'>} */
  const staleTargets = [];
  for (const k of /** @type {const} */(['deps', 'test', 'doc'])) {
    if (targets[k]?.enabled && targets[k]?.stale) staleTargets.push(k);
  }

  return {
    timestamp: new Date().toISOString(),
    staleTargets,
    targets
  };
}

/**
 * Manual update entrypoint.
 *
 * - deps: build dependency graph
 * - test: build test map
 * - doc: generate CLAUDE.md docs
 *
 * Supports:
 * - --only <deps|test|doc>
 * - --force (re-generate regardless of stale status)
 *
 * @param {{root: string, config: ProjectConfig}} ctx
 * @param {Record<string, any>} args
 */
export async function update(ctx, args = {}) {
  const only = normalizeOnlyTarget(args.only);
  if (args.only && !only) {
    throw new Error(`Invalid --only target: ${args.only} (expected deps|test|doc)`);
  }

  const force = Boolean(args.force);
  const stale = await checkStale(ctx, { only });

  /** @type {Array<'deps'|'test'|'doc'>} */
  const allTargets = only ? [only] : ['deps', 'test', 'doc'];
  const targetsToRun = force ? allTargets : allTargets.filter(t => stale.staleTargets.includes(t));

  if (targetsToRun.length === 0) {
    console.log('Up to date.');
    return { updated: [], skipped: allTargets, stale };
  }

  console.log(`Updating: ${targetsToRun.join(', ')}`);

  for (const target of targetsToRun) {
    if (target === 'deps') {
      if (!Array.isArray(ctx.config.src?.dirs) || ctx.config.src.dirs.length === 0) {
        throw new Error('Config missing required field: src.dirs (needed for deps)');
      }
      const { buildGraph } = await import('../deps/index.js');
      await buildGraph(ctx, { ...args, json: false });
      await mirrorCacheToRoot(ctx, '.dep-graph.json');
      continue;
    }

    if (target === 'test') {
      if (!Array.isArray(ctx.config.src?.dirs) || ctx.config.src.dirs.length === 0) {
        throw new Error('Config missing required field: src.dirs (needed for test map)');
      }
      if (!Array.isArray(ctx.config.test?.dirs) || ctx.config.test.dirs.length === 0) {
        throw new Error('Config missing required field: test.dirs (needed for test map)');
      }
      if (typeof ctx.config.test?.pattern !== 'string' || !ctx.config.test.pattern.trim()) {
        throw new Error('Config missing required field: test.pattern (needed for test map)');
      }
      const { buildTestMap } = await import('../test/index.js');
      await buildTestMap(ctx, { ...args, json: false });
      await mirrorCacheToRoot(ctx, '.test-map.json');
      continue;
    }

    if (target === 'doc') {
      if (!Array.isArray(ctx.config.src?.dirs) || ctx.config.src.dirs.length === 0) {
        throw new Error('Config missing required field: src.dirs (needed for doc generate)');
      }
      const { generate } = await import('../doc/index.js');
      await generate(ctx, { ...args, json: false });
      continue;
    }
  }

  return { updated: targetsToRun, skipped: allTargets.filter(t => !targetsToRun.includes(t)), stale };
}

/**
 * Background updater - polls for staleness and updates when needed.
 *
 * Supports:
 * - --interval <ms> (default 60000)
 *
 * @param {{root: string, config: ProjectConfig}} ctx
 * @param {Record<string, any>} args
 */
export async function scheduleBackground(ctx, args = {}) {
  const intervalMs = toPositiveInt(args.interval, DEFAULT_INTERVAL_MS);
  const logPath = path.join(ctx.root, '.update-bg.log');
  const pidPath = path.join(ctx.root, '.update-bg.pid');

  // Default behavior: daemonize like the legacy `scripts/update-bg.js`.
  if (!args.daemon) {
    const existingPid = await readPidSafe(pidPath);
    if (existingPid && isPidRunning(existingPid)) {
      console.log(`Background update already running (PID: ${existingPid})`);
      console.log(`Log: ${logPath}`);
      return { running: true, pid: existingPid, logPath, intervalMs };
    }

    const childArgs = [
      CLI_PATH,
      'update',
      '--bg',
      '--daemon',
      `--interval=${intervalMs}`
    ];

    if (args.only) childArgs.push(`--only=${String(args.only)}`);
    if (args.force) childArgs.push('--force');

    const child = spawn(process.execPath, childArgs, {
      cwd: ctx.root,
      detached: true,
      stdio: 'ignore'
    });
    child.unref();

    await fs.writeFile(pidPath, String(child.pid));

    console.log(`Started background update (PID: ${child.pid})`);
    console.log(`Log: ${logPath}`);
    return { started: true, pid: child.pid, logPath, intervalMs };
  }

  /**
   * @param {string} msg
   */
  async function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    await fs.appendFile(logPath, line);
  }

  // daemon mode
  await fs.writeFile(pidPath, String(process.pid));
  await log(`Background update started (interval=${intervalMs}ms, pid=${process.pid})`);

  let running = false;
  /** @type {string|null} */
  let lastStateKey = null;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const stale = await checkStale(ctx, args);
      if (stale.staleTargets.length === 0) {
        if (lastStateKey !== 'clean') {
          await log('All targets fresh.');
          lastStateKey = 'clean';
        }
        return;
      }

      const key = stale.staleTargets.join(',');
      if (lastStateKey !== key) {
        await log(`Detected stale targets: ${stale.staleTargets.join(', ')}`);
        lastStateKey = key;
      }

      await update(ctx, { ...args, force: Boolean(args.force), only: args.only }); // update() already filters by --only
      await log('Update completed.');
      lastStateKey = null; // Recompute next tick (in case update didn't fully refresh)
    } catch (err) {
      await log(`Error: ${err?.message || String(err)}`);
    } finally {
      running = false;
    }
  };

  // Run once immediately, then on interval.
  await tick();

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  const stop = async (signal) => {
    clearInterval(timer);
    await log(`Background update stopped (${signal})`);
    try {
      await fs.unlink(pidPath);
    } catch {}
    // Give the append a chance to flush.
    process.exit(0);
  };

  process.on('SIGINT', () => { void stop('SIGINT'); });
  process.on('SIGTERM', () => { void stop('SIGTERM'); });

  // Keep process alive.
  return { intervalMs, logPath, pidPath, pid: process.pid };
}
