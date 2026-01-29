#!/usr/bin/env node
/**
 * Stale Propagation - detect changed (stale) source files and propagate via dependency graph.
 *
 * Reads (from project root):
 *   - .dep-graph.json (required)
 *   - .test-map.json (optional, with --tests)
 *
 * Usage:
 *   node stale-propagate.js
 *   node stale-propagate.js --json
 *   node stale-propagate.js --depth 2
 *   node stale-propagate.js --tests
 *   node stale-propagate.js --changed core/a.js --changed core/b.js
 *   node stale-propagate.js --changed=core/a.js,core/b.js
 */

import path from 'path';
import { fileExists, findProjectRoot, getMtime, parseArgs, readJsonSafe } from './shared.js';

const DEFAULT_DEPTH = 2;
const MAX_DEPTH = 25; // Safety guard for accidental huge traversals

/**
 * @typedef {object} FileNode
 * @property {string[]} imports
 * @property {string[]} importedBy
 * @property {string[]} exports
 */

/**
 * @typedef {object} DepGraph
 * @property {1} version
 * @property {string} generated
 * @property {string} root
 * @property {Record<string, FileNode>} files
 */

/**
 * @typedef {{file: string, mtime: string|null}} DirectStaleItem
 * @typedef {{file: string, level: number, source: string}} PropagatedStaleItem
 * @typedef {{
 *   directStale: DirectStaleItem[],
 *   propagatedStale: PropagatedStaleItem[],
 *   summary: Record<string, number>,
 *   testsToRun?: string[]
 * }} OutputJson
 */

/**
 * Convert a path to posix separators for stable keys.
 * @param {string} p
 * @returns {string}
 */
function toPosixPath(p) {
  return p.replace(/\\/g, '/');
}

/**
 * Normalize a relative path-like input:
 * - normalize separators to "/"
 * - remove leading "./"
 * - remove trailing "/"
 *
 * @param {string} input
 * @returns {string}
 */
function normalizeRelInput(input) {
  const normalized = toPosixPath(path.normalize(String(input || '')));
  const trimmed = normalized.replace(/^\.\/+/, '').replace(/\/+$/, '');
  return trimmed || '.';
}

/**
 * Join two relative paths (posix-ish) while keeping "." semantics stable.
 * @param {string} a
 * @param {string} b
 * @returns {string}
 */
function joinRel(a, b) {
  const aa = normalizeRelInput(a);
  const bb = normalizeRelInput(b);
  if (!aa || aa === '.') return bb;
  if (!bb || bb === '.') return aa;
  return normalizeRelInput(`${aa}/${bb}`);
}

/**
 * Convert a project-relative file path (or graph-root-relative) into a graph key.
 * Accepts either:
 *  - "core/a.js" (graph-root-relative)
 *  - "js/agents/core/a.js" (project-relative; will strip graph.root prefix)
 *
 * @param {string} input
 * @param {string} graphRoot
 * @returns {string}
 */
function toGraphKey(input, graphRoot) {
  const root = normalizeRelInput(graphRoot || '.');
  const rel = normalizeRelInput(input);
  if (root !== '.' && rel.startsWith(root + '/')) {
    return rel.slice(root.length + 1);
  }
  return rel;
}

/**
 * Support `--flag value` style for selected flags while still using shared.parseArgs().
 * @param {string[]} argv
 * @returns {string[]}
 */
function normalizeArgv(argv) {
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--depth' || arg === '--changed') && i + 1 < argv.length) {
      const next = argv[i + 1];
      if (!next.startsWith('-')) {
        out.push(`${arg}=${next}`);
        i++;
        continue;
      }
    }
    out.push(arg);
  }
  return out;
}

/**
 * Collect all occurrences of `--changed=...` from argv.
 * @param {string[]} argv
 * @returns {string[]}
 */
function collectChangedArgs(argv) {
  const prefix = '--changed=';
  /** @type {string[]} */
  const raw = [];
  for (const a of argv) {
    if (a.startsWith(prefix)) raw.push(a.slice(prefix.length));
  }

  /** @type {string[]} */
  const out = [];
  for (const r of raw) {
    // Allow comma-separated lists: --changed=a,b,c
    for (const part of String(r).split(',')) {
      const s = part.trim();
      if (s) out.push(s);
    }
  }
  return out;
}

/**
 * @param {string[]} list
 * @returns {string[]}
 */
function uniqueSorted(list) {
  return Array.from(new Set(list || []))
    .map(normalizeRelInput)
    .filter(p => p && p !== '.')
    .sort((a, b) => a.localeCompare(b));
}

/**
 * @param {string} file
 * @param {Date|null} mtime
 * @returns {DirectStaleItem}
 */
function toDirectItem(file, mtime) {
  return {
    file: normalizeRelInput(file),
    mtime: mtime ? mtime.toISOString() : null
  };
}

/**
 * @param {Date|null} date
 * @returns {string}
 */
function formatDay(date) {
  if (!date) return 'N/A';
  return date.toISOString().split('T')[0];
}

/**
 * Multi-source BFS propagate stale status via reverse deps (importedBy).
 * For each discovered file, record:
 *  - level: 1..depth
 *  - source: the immediate stale dependency at previous level
 *
 * @param {DepGraph} depGraph
 * @param {string[]} directKeys - graph keys (relative to depGraph.root)
 * @param {number} depth
 * @returns {{ propagated: PropagatedStaleItem[], levelCounts: Map<number, number> }}
 */
function propagate(depGraph, directKeys, depth) {
  const maxDepth = Math.max(0, Math.min(MAX_DEPTH, Number.isFinite(depth) ? Math.floor(depth) : DEFAULT_DEPTH));

  /** @type {Map<string, number>} */
  const visitedLevel = new Map();
  /** @type {Map<string, string>} */
  const cause = new Map();

  /** @type {{file: string, level: number}[]} */
  const queue = [];
  for (const f of uniqueSorted(directKeys)) {
    visitedLevel.set(f, 0);
    queue.push({ file: f, level: 0 });
  }

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    if (item.level >= maxDepth) continue;

    const node = depGraph.files?.[item.file];
    const importedBy = Array.isArray(node?.importedBy) ? node.importedBy : [];
    const parents = importedBy.map(normalizeRelInput).filter(p => p && p !== '.').sort((a, b) => a.localeCompare(b));

    for (const parent of parents) {
      const nextLevel = item.level + 1;
      if (visitedLevel.has(parent)) continue;
      visitedLevel.set(parent, nextLevel);
      // immediate cause for human-friendly arrows
      cause.set(parent, item.file);
      queue.push({ file: parent, level: nextLevel });
    }
  }

  /** @type {PropagatedStaleItem[]} */
  const propagated = [];
  /** @type {Map<number, number>} */
  const levelCounts = new Map();

  for (const [file, level] of visitedLevel.entries()) {
    if (level <= 0) continue;
    const src = cause.get(file);
    if (!src) continue;
    propagated.push({ file, level, source: src });
    levelCounts.set(level, (levelCounts.get(level) || 0) + 1);
  }

  propagated.sort((a, b) => (a.level - b.level) || a.file.localeCompare(b.file));
  return { propagated, levelCounts };
}

/**
 * Build a source-path -> tests lookup from .test-map.json (if present).
 * @param {any} testMap
 * @returns {Map<string, string[]>}
 */
function buildTestLookup(testMap) {
  /** @type {Map<string, string[]>} */
  const lookup = new Map();
  const modules = testMap?.modules && typeof testMap.modules === 'object' ? testMap.modules : {};

  for (const modKey of Object.keys(modules)) {
    const mod = modules[modKey];
    const files = mod?.files && typeof mod.files === 'object' ? mod.files : {};
    for (const fileKey of Object.keys(files)) {
      const entry = files[fileKey];
      const srcPath = typeof entry?.path === 'string' ? normalizeRelInput(entry.path) : null;
      if (!srcPath) continue;
      const tests = Array.isArray(entry?.tests) ? entry.tests.map(normalizeRelInput).filter(Boolean) : [];
      lookup.set(srcPath, uniqueSorted(tests));
    }
  }

  return lookup;
}

/**
 * @param {Map<string, string[]>} testLookup
 * @param {string[]} files
 * @returns {string[]}
 */
function collectTestFiles(testLookup, files) {
  /** @type {Set<string>} */
  const out = new Set();
  for (const f of files || []) {
    const tests = testLookup.get(normalizeRelInput(f));
    if (!tests) continue;
    for (const t of tests) out.add(normalizeRelInput(t));
  }
  return uniqueSorted(Array.from(out));
}

function printHelp() {
  console.log(`Stale Propagation Analysis

Usage:
  node stale-propagate.js
  node stale-propagate.js --json
  node stale-propagate.js --depth 2
  node stale-propagate.js --tests
  node stale-propagate.js --changed <file> [--changed <file> ...]

Notes:
  - Direct stale is detected by comparing file mtime vs .dep-graph.json generated time.
  - Propagation walks reverse deps (importedBy) with BFS.
`);
}

/**
 * @param {DirectStaleItem[]} direct
 * @param {PropagatedStaleItem[]} propagated
 * @param {Map<number, number>} levelCounts
 * @param {string[]|null} testsToRun
 */
function printHuman(direct, propagated, levelCounts, testsToRun) {
  console.log('=== Stale Propagation Analysis ===\n');

  console.log('Direct stale (source changed):');
  if (direct.length === 0) {
    console.log('  (none)\n');
  } else {
    for (const item of direct) {
      const day = item.mtime ? formatDay(new Date(item.mtime)) : 'N/A';
      console.log(`  ${item.file} (${day})`);
    }
    console.log('');
  }

  console.log('Propagated stale (dependency changed):');
  if (propagated.length === 0) {
    console.log('  (none)\n');
  } else {
    for (const item of propagated) {
      console.log(`  L${item.level}: ${item.file} <- ${item.source}`);
    }
    console.log('');
  }

  const directCount = direct.length;
  const propagatedCount = propagated.length;
  const total = directCount + propagatedCount;

  const levelParts = Array.from(levelCounts.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([lvl, count]) => `L${lvl}: ${count}`)
    .join(', ');

  console.log('Summary:');
  console.log(`  Direct: ${directCount} files`);
  console.log(`  Propagated: ${propagatedCount} files${levelParts ? ` (${levelParts})` : ''}`);
  console.log(`  Total affected: ${total} files\n`);

  if (testsToRun) {
    console.log(`Tests to re-run: ${testsToRun.length} files`);
    const maxShow = 25;
    for (const t of testsToRun.slice(0, maxShow)) console.log(`  - ${t}`);
    if (testsToRun.length > maxShow) console.log(`  ... +${testsToRun.length - maxShow} more`);
  }
}

async function main() {
  const cwd = process.cwd();
  const projectRoot = await findProjectRoot(cwd);

  const argv = normalizeArgv(process.argv.slice(2));
  const args = parseArgs(argv, { depth: DEFAULT_DEPTH, json: false, tests: false, help: false });

  if (args.help) {
    printHelp();
    return;
  }

  const depGraphPath = path.join(projectRoot, '.dep-graph.json');
  if (!(await fileExists(depGraphPath))) {
    console.error(`Error: missing ${depGraphPath}`);
    console.error('Generate it first: node scripts/dependency-graph.js');
    process.exitCode = 1;
    return;
  }

  /** @type {DepGraph|null} */
  const depGraph = await readJsonSafe(depGraphPath, null);
  if (!depGraph || typeof depGraph !== 'object' || depGraph.version !== 1 || !depGraph.files) {
    console.error(`Error: invalid ${depGraphPath}`);
    process.exitCode = 1;
    return;
  }

  const graphRoot = normalizeRelInput(depGraph.root || '.');
  const generatedAt = (() => {
    const d = new Date(depGraph.generated);
    return Number.isFinite(d.getTime()) ? d : null;
  })() || (await getMtime(depGraphPath));

  if (!generatedAt) {
    console.error(`Error: cannot determine generated time from ${depGraphPath}`);
    process.exitCode = 1;
    return;
  }

  /** @type {string[]} */
  const changedInputs = collectChangedArgs(argv);
  const positional = Array.isArray(args._) ? args._ : [];
  const hasExplicitChanged = changedInputs.length > 0 || positional.length > 0;

  /** @type {string[]} */
  let directKeys = [];
  /** @type {Map<string, Date|null>} */
  const directMtimes = new Map();

  if (hasExplicitChanged) {
    const raw = changedInputs.length > 0 ? changedInputs : positional.map(String);
    const keys = uniqueSorted(raw.map(r => toGraphKey(r, graphRoot)));

    /** @type {string[]} */
    const inGraph = [];
    /** @type {string[]} */
    const notInGraph = [];
    for (const k of keys) {
      if (depGraph.files?.[k]) inGraph.push(k);
      else notInGraph.push(k);
    }

    if (notInGraph.length > 0) {
      // Keep JSON stdout clean.
      for (const f of notInGraph.slice(0, 50)) {
        console.error(`WARN not in dep graph: ${f}`);
      }
      if (notInGraph.length > 50) console.error(`WARN ... +${notInGraph.length - 50} more`);
    }

    directKeys = inGraph;
    for (const k of directKeys) {
      const abs = path.join(projectRoot, graphRoot === '.' ? '' : graphRoot, k);
      directMtimes.set(k, await getMtime(abs));
    }
  } else {
    // Auto-detect direct stale by comparing source mtime against dep-graph generated time.
    for (const k of Object.keys(depGraph.files || {})) {
      const key = normalizeRelInput(k);
      if (!key || key === '.') continue;
      const abs = path.join(projectRoot, graphRoot === '.' ? '' : graphRoot, key);
      const mtime = await getMtime(abs);
      if (!mtime) continue;
      if (mtime > generatedAt) {
        directKeys.push(key);
        directMtimes.set(key, mtime);
      }
    }
    directKeys = uniqueSorted(directKeys);
  }

  const directStale = directKeys.map(k => toDirectItem(k, directMtimes.get(k) || null));

  const requestedDepth = Number.isFinite(args.depth) ? args.depth : DEFAULT_DEPTH;
  const { propagated, levelCounts } = propagate(depGraph, directKeys, requestedDepth);

  /** @type {string[]|null} */
  let testsToRun = null;
  if (args.tests) {
    const testMapPath = path.join(projectRoot, '.test-map.json');
    if (await fileExists(testMapPath)) {
      const testMap = await readJsonSafe(testMapPath, null);
      if (testMap && typeof testMap === 'object') {
        const lookup = buildTestLookup(testMap);
        const affectedProjectRel = uniqueSorted([
          ...directKeys.map(k => joinRel(graphRoot, k)),
          ...propagated.map(p => joinRel(graphRoot, p.file))
        ]);
        testsToRun = collectTestFiles(lookup, affectedProjectRel);
      } else {
        console.error(`WARN invalid ${testMapPath}`);
        testsToRun = [];
      }
    } else {
      console.error(`WARN missing ${testMapPath}`);
      testsToRun = [];
    }
  }

  /** @type {Record<string, number>} */
  const summary = {
    direct: directStale.length,
    propagated: propagated.length,
    total: directStale.length + propagated.length
  };
  for (const [lvl, count] of Array.from(levelCounts.entries()).sort((a, b) => a[0] - b[0])) {
    summary[`L${lvl}`] = count;
  }

  if (args.json) {
    /** @type {OutputJson} */
    const out = {
      directStale,
      propagatedStale: propagated,
      summary,
      ...(args.tests ? { testsToRun: testsToRun || [] } : {})
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }

  printHuman(directStale, propagated, levelCounts, testsToRun);
}

main().catch(err => {
  console.error(err?.stack || err?.message || String(err));
  process.exitCode = 1;
});

