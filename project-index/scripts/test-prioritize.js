#!/usr/bin/env node
/**
 * Test Prioritize - 智能测试修复排序器
 *
 * 功能：
 * - 分析失败测试与依赖关系，输出最优修复顺序
 *
 * 读取（project root）：
 * - .dep-graph.json（必需，dependency-graph.js 生成）
 * - .test-map.json（推荐，test-mapper.js 生成）
 * - .project-index/.test-result.json（默认失败测试来源，由 test-result.js --save 生成）
 *
 * CLI：
 *   node test-prioritize.js
 *   node test-prioritize.js --from-file <result.json>
 *   node test-prioritize.js --failing <test1> <test2>...
 *   node test-prioritize.js --json
 */

import path from 'path';
import {
  fileExists,
  findProjectRoot,
  parseArgs,
  readJsonSafe
} from './shared.js';

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
 * @property {Record<string, any>} [modules]
 * @property {string[][]} [cycles]
 */

/**
 * @typedef {object} TestMapFileEntry
 * @property {string} path
 * @property {string} status
 * @property {string[]} tests
 */

/**
 * @typedef {object} TestMapModule
 * @property {Record<string, TestMapFileEntry>} files
 */

/**
 * @typedef {object} TestMap
 * @property {number} version
 * @property {Record<string, TestMapModule>} modules
 */

/**
 * @typedef {object} Candidate
 * @property {string} file - project-relative source file path
 * @property {string} key - graph key (relative to depGraph.root)
 * @property {number} dependents - direct reverse deps count (importedBy)
 * @property {string[]} failingTests - failing tests directly mapped to this source
 * @property {number} potentialFixes - failing tests potentially resolved by fixing this file
 */

/**
 * Convert a path to posix separators for stable keys.
 * @param {string} p
 * @returns {string}
 */
function toPosixPath(p) {
  return String(p || '').replace(/\\/g, '/');
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
 * Convert a project-relative file path (or graph-root-relative) into a depGraph key.
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
 * Convert a depGraph key into a project-relative path.
 * @param {string} key
 * @param {string} graphRoot
 * @returns {string}
 */
function toProjectRel(key, graphRoot) {
  return joinRel(graphRoot || '.', normalizeRelInput(key));
}

/**
 * Normalize a path that may be absolute (best-effort) into a project-relative path.
 * @param {string} p
 * @param {string} projectRoot
 * @returns {string}
 */
function normalizeMaybeAbsPath(p, projectRoot) {
  const s = String(p || '').trim();
  if (!s) return '';
  if (path.isAbsolute(s)) {
    const rel = path.relative(projectRoot, s);
    const normalized = normalizeRelInput(rel);
    if (!normalized || normalized === '.' || normalized.startsWith('..')) return '';
    return normalized;
  }
  const normalized = normalizeRelInput(s);
  if (!normalized || normalized === '.' || normalized.startsWith('..')) return '';
  return normalized;
}

/**
 * @param {Iterable<string>} list
 * @returns {string[]}
 */
function uniqueSorted(list) {
  return Array.from(new Set(Array.from(list || []).filter(Boolean)))
    .map(normalizeRelInput)
    .filter(p => p && p !== '.' && !p.startsWith('..'))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Support `--flag value` style for selected flags while still using shared.parseArgs().
 *
 * - `--from-file <path>`
 * - `--failing <t1> <t2> ...`
 *
 * @param {string[]} argv
 * @returns {string[]}
 */
function normalizeArgv(argv) {
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--from-file' && i + 1 < argv.length) {
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        out.push(`--from-file=${next}`);
        i++;
        continue;
      }
    }

    if (arg === '--failing') {
      /** @type {string[]} */
      const tests = [];
      while (i + 1 < argv.length) {
        const next = argv[i + 1];
        if (!next || next.startsWith('-')) break;
        tests.push(next);
        i++;
      }
      out.push(`--failing=${tests.join(',')}`);
      continue;
    }

    out.push(arg);
  }
  return out;
}

/**
 * Build test->sources lookup from .test-map.json.
 * @param {TestMap} testMap
 * @returns {Map<string, Set<string>>} Map testFile -> Set(sourceFile)
 */
function buildTestToSourcesFromTestMap(testMap) {
  /** @type {Map<string, Set<string>>} */
  const out = new Map();
  const modules = testMap?.modules && typeof testMap.modules === 'object' ? testMap.modules : {};

  for (const modKey of Object.keys(modules)) {
    const mod = modules[modKey];
    const files = mod?.files && typeof mod.files === 'object' ? mod.files : {};
    for (const fileKey of Object.keys(files)) {
      const entry = files[fileKey];
      const source = normalizeRelInput(entry?.path || '');
      if (!source || source === '.' || source.startsWith('..')) continue;
      const tests = Array.isArray(entry?.tests) ? entry.tests : [];
      for (const t of tests) {
        const testFile = normalizeRelInput(t);
        if (!testFile || testFile === '.' || testFile.startsWith('..')) continue;
        if (!out.has(testFile)) out.set(testFile, new Set());
        out.get(testFile)?.add(source);
      }
    }
  }

  return out;
}

/**
 * Build fallback test->sources lookup from cached errors (less accurate).
 * @param {any[]} errors
 * @param {string} projectRoot
 * @returns {Map<string, Set<string>>}
 */
function buildTestToSourcesFromErrors(errors, projectRoot) {
  /** @type {Map<string, Set<string>>} */
  const out = new Map();
  for (const e of Array.isArray(errors) ? errors : []) {
    const testFile = normalizeMaybeAbsPath(e?.testFile, projectRoot);
    if (!testFile) continue;

    const sourceFile = normalizeMaybeAbsPath(e?.sourceFile, projectRoot) || normalizeRelInput(e?.sourceFile || '');
    const src = sourceFile && sourceFile !== '.' && !sourceFile.startsWith('..') ? normalizeRelInput(sourceFile) : '';
    if (!src) continue;

    if (!out.has(testFile)) out.set(testFile, new Set());
    out.get(testFile)?.add(src);
  }
  return out;
}

/**
 * Extract failing test files from either:
 * - cached test-result format: { errors: [{ testFile, sourceFile, ... }, ...] }
 * - reporter JSON format: { testResults: [{ name, assertionResults: [...] }, ...] }
 *
 * @param {any} json
 * @param {string} projectRoot
 * @returns {{ failingTests: string[], fallbackTestToSources: Map<string, Set<string>> }}
 */
function extractFailingFromJson(json, projectRoot) {
  // Preferred: cached test-result.json format
  if (json && Array.isArray(json.errors)) {
    const failing = uniqueSorted(json.errors.map(e => normalizeMaybeAbsPath(e?.testFile, projectRoot)).filter(Boolean));
    const fallback = buildTestToSourcesFromErrors(json.errors, projectRoot);
    return { failingTests: failing, fallbackTestToSources: fallback };
  }

  // Reporter JSON (jest-like) format
  /** @type {string[]} */
  const failingFiles = [];
  const testResults = Array.isArray(json?.testResults) ? json.testResults : [];
  for (const fileRes of testResults) {
    const name = fileRes?.name || fileRes?.file || fileRes?.path || fileRes?.filepath || '';
    const filePath = normalizeMaybeAbsPath(name, projectRoot);
    if (!filePath) continue;

    const assertions = Array.isArray(fileRes?.assertionResults) ? fileRes.assertionResults : null;
    let hasFailed = false;
    if (assertions) {
      hasFailed = assertions.some(t => String(t?.status || '').toLowerCase() === 'failed' || String(t?.status || '').toLowerCase() === 'fail');
    } else if (typeof fileRes?.numFailingTests === 'number') {
      hasFailed = fileRes.numFailingTests > 0;
    } else if (typeof fileRes?.status === 'string') {
      hasFailed = String(fileRes.status).toLowerCase() === 'failed' || String(fileRes.status).toLowerCase() === 'fail';
    }

    if (hasFailed) failingFiles.push(filePath);
  }

  return { failingTests: uniqueSorted(failingFiles), fallbackTestToSources: new Map() };
}

/**
 * Collect all downstream dependents (transitive) using importedBy edges.
 * @param {DepGraph} depGraph
 * @param {string} startKey
 * @returns {Set<string>}
 */
function collectDownstreamKeys(depGraph, startKey) {
  const start = normalizeRelInput(startKey);
  /** @type {Set<string>} */
  const visited = new Set();
  /** @type {string[]} */
  const queue = [];

  if (!start || start === '.' || start.startsWith('..')) return visited;
  visited.add(start);
  queue.push(start);

  while (queue.length > 0) {
    const cur = queue.shift();
    if (!cur) break;
    const node = depGraph.files?.[cur];
    const importedBy = Array.isArray(node?.importedBy) ? node.importedBy : [];
    for (const parent of importedBy) {
      const p = normalizeRelInput(parent);
      if (!p || p === '.' || p.startsWith('..')) continue;
      if (visited.has(p)) continue;
      visited.add(p);
      queue.push(p);
    }
  }

  return visited;
}

/**
 * Build fix-order graph among involved nodes.
 * depGraph stores edges: file -> imports (dependencies).
 * For fixing order, we want: dependency -> dependent (so dep fixed first).
 *
 * @param {DepGraph} depGraph
 * @param {Set<string>} involvedKeys
 * @returns {{
 *   adj: Map<string, Set<string>>,
 *   indegree: Map<string, number>,
 *   outdegree: Map<string, number>
 * }}
 */
function buildFixGraph(depGraph, involvedKeys) {
  /** @type {Map<string, Set<string>>} */
  const adj = new Map();
  /** @type {Map<string, number>} */
  const indegree = new Map();
  /** @type {Map<string, number>} */
  const outdegree = new Map();

  for (const k of involvedKeys) {
    adj.set(k, new Set());
    indegree.set(k, 0);
    outdegree.set(k, 0);
  }

  for (const fileKey of involvedKeys) {
    const node = depGraph.files?.[fileKey];
    const imports = Array.isArray(node?.imports) ? node.imports : [];
    for (const dep of imports) {
      const depKey = normalizeRelInput(dep);
      if (!involvedKeys.has(depKey)) continue;
      // depKey must be fixed before fileKey
      const edges = adj.get(depKey);
      if (!edges || edges.has(fileKey)) continue;
      edges.add(fileKey);
      indegree.set(fileKey, (indegree.get(fileKey) || 0) + 1);
      outdegree.set(depKey, (outdegree.get(depKey) || 0) + 1);
    }
  }

  return { adj, indegree, outdegree };
}

/**
 * Tarjan SCC over adjacency map.
 * @param {Map<string, Set<string>>} adj
 * @param {Iterable<string>} nodes
 * @returns {string[][]} Components in discovery order
 */
function stronglyConnectedComponents(adj, nodes) {
  /** @type {Map<string, number>} */
  const index = new Map();
  /** @type {Map<string, number>} */
  const lowlink = new Map();
  /** @type {string[]} */
  const stack = [];
  /** @type {Set<string>} */
  const onStack = new Set();
  /** @type {string[][]} */
  const comps = [];
  let nextIndex = 0;

  /**
   * @param {string} v
   */
  function strongConnect(v) {
    index.set(v, nextIndex);
    lowlink.set(v, nextIndex);
    nextIndex += 1;
    stack.push(v);
    onStack.add(v);

    const edges = adj.get(v) || new Set();
    for (const w of edges) {
      if (!index.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v) || 0, lowlink.get(w) || 0));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v) || 0, index.get(w) || 0));
      }
    }

    if ((lowlink.get(v) || 0) === (index.get(v) || 0)) {
      /** @type {string[]} */
      const comp = [];
      while (stack.length > 0) {
        const w = stack.pop();
        if (!w) break;
        onStack.delete(w);
        comp.push(w);
        if (w === v) break;
      }
      comps.push(comp);
    }
  }

  for (const v of nodes) {
    if (!index.has(v)) strongConnect(v);
  }

  return comps;
}

/**
 * Topologically sort nodes using SCC condensation to be cycle-safe.
 * @param {Map<string, Set<string>>} adj
 * @param {Iterable<string>} nodes
 * @returns {{ order: string[], sccs: string[][] }}
 */
function topoSortWithScc(adj, nodes) {
  const nodeList = Array.from(nodes || []);
  const sccs = stronglyConnectedComponents(adj, nodeList);

  /** @type {Map<string, number>} */
  const compOf = new Map();
  for (let i = 0; i < sccs.length; i++) {
    for (const n of sccs[i]) compOf.set(n, i);
  }

  /** @type {Map<number, Set<number>>} */
  const compAdj = new Map();
  /** @type {Map<number, number>} */
  const compIndeg = new Map();
  for (let i = 0; i < sccs.length; i++) {
    compAdj.set(i, new Set());
    compIndeg.set(i, 0);
  }

  for (const u of nodeList) {
    const cu = compOf.get(u);
    if (cu === undefined) continue;
    const edges = adj.get(u) || new Set();
    for (const v of edges) {
      const cv = compOf.get(v);
      if (cv === undefined || cv === cu) continue;
      const set = compAdj.get(cu);
      if (set && !set.has(cv)) {
        set.add(cv);
        compIndeg.set(cv, (compIndeg.get(cv) || 0) + 1);
      }
    }
  }

  /** @type {number[]} */
  const ready = [];
  for (const [cid, deg] of compIndeg.entries()) {
    if ((deg || 0) === 0) ready.push(cid);
  }
  ready.sort((a, b) => a - b);

  /** @type {number[]} */
  const compOrder = [];
  while (ready.length > 0) {
    const cid = ready.shift();
    if (cid === undefined) break;
    compOrder.push(cid);
    for (const next of compAdj.get(cid) || []) {
      compIndeg.set(next, (compIndeg.get(next) || 0) - 1);
      if ((compIndeg.get(next) || 0) === 0) {
        ready.push(next);
        ready.sort((a, b) => a - b);
      }
    }
  }

  /** @type {string[]} */
  const order = [];
  for (const cid of compOrder) {
    const comp = sccs[cid] || [];
    for (const n of comp) order.push(n);
  }

  return { order, sccs };
}

/**
 * Create topo layers (batches) from fixGraph for maximum parallelism at each step.
 * @param {Map<string, Set<string>>} adj
 * @param {Set<string>} nodes
 * @returns {string[][]}
 */
function topoBatches(adj, nodes) {
  const list = Array.from(nodes || []);

  /** @type {Map<string, number>} */
  const indeg = new Map();
  for (const n of list) indeg.set(n, 0);
  for (const u of list) {
    for (const v of adj.get(u) || []) {
      if (!nodes.has(v)) continue;
      indeg.set(v, (indeg.get(v) || 0) + 1);
    }
  }

  /** @type {Set<string>} */
  const remaining = new Set(list);
  /** @type {string[][]} */
  const batches = [];

  while (remaining.size > 0) {
    const ready = Array.from(remaining).filter(n => (indeg.get(n) || 0) === 0).sort((a, b) => a.localeCompare(b));
    if (ready.length === 0) {
      // Cycle fallback: pick the smallest indegree node(s) to break.
      let min = Infinity;
      for (const n of remaining) min = Math.min(min, indeg.get(n) || 0);
      const pick = Array.from(remaining).filter(n => (indeg.get(n) || 0) === min).sort((a, b) => a.localeCompare(b));
      batches.push(pick.slice(0, 1));
      for (const n of pick.slice(0, 1)) remaining.delete(n);
      for (const next of adj.get(pick[0]) || []) {
        if (!remaining.has(next)) continue;
        indeg.set(next, Math.max(0, (indeg.get(next) || 0) - 1));
      }
      continue;
    }

    batches.push(ready);
    for (const n of ready) remaining.delete(n);
    for (const u of ready) {
      for (const v of adj.get(u) || []) {
        if (!remaining.has(v)) continue;
        indeg.set(v, Math.max(0, (indeg.get(v) || 0) - 1));
      }
    }
  }

  return batches;
}

/**
 * Select root causes by inDegree (dependents) while maximizing coverage of failing tests.
 * @param {{ file: string, key: string, dependents: number, failingTests: string[], potentialSet: Set<string> }[]} enriched
 * @param {number} totalFailing
 * @returns {string[]} Selected keys
 */
function selectRootCauseKeys(enriched, totalFailing) {
  const sorted = enriched
    .slice()
    .sort((a, b) =>
      (b.dependents - a.dependents) ||
      (b.potentialSet.size - a.potentialSet.size) ||
      (b.failingTests.length - a.failingTests.length) ||
      a.file.localeCompare(b.file)
    );

  const target = Math.max(1, Math.ceil(totalFailing * 0.7));
  const maxItems = Math.min(8, Math.max(2, Math.ceil(sorted.length * 0.25)));

  /** @type {Set<string>} */
  const covered = new Set();
  /** @type {string[]} */
  const selected = [];

  for (const item of sorted) {
    if (selected.length >= maxItems) break;
    const before = covered.size;
    for (const t of item.potentialSet) covered.add(t);
    const added = covered.size - before;
    if (added <= 0) continue;
    selected.push(item.key);
    if (selected.length >= 2 && covered.size >= target) break;
  }

  if (selected.length === 0 && sorted.length > 0) selected.push(sorted[0].key);
  return selected;
}

/**
 * Render human-readable output.
 * @param {{
 *   totalFailing: number,
 *   sourceFiles: number,
 *   rootCauses: Candidate[],
 *   batches: { files: { file: string, tests: number }[], tests: number }[],
 *   leafNodes: { file: string, tests: number }[],
 *   suggestedOrder: string[]
 * }} view
 */
function printHuman(view) {
  console.log('=== Test Repair Priority ===\n');
  console.log(`Total failing: ${view.totalFailing} tests`);
  console.log(`Source files involved: ${view.sourceFiles} files\n`);

  console.log('Phase 1 - Root causes (fix these first):');
  if (view.rootCauses.length === 0) {
    console.log('  (none)\n');
  } else {
    for (let i = 0; i < view.rootCauses.length; i++) {
      const item = view.rootCauses[i];
      console.log(`  Priority ${i + 1}: ${item.file}`);
      console.log(`    - 被 ${item.dependents} 文件依赖`);
      console.log(`    - 关联 ${item.failingTests.length} 个失败测试`);
      console.log(`    - 修复后可能解决: ${item.potentialFixes} 个测试\n`);
    }
  }

  console.log('Phase 2 - Independent (can fix in parallel):');
  if (view.batches.length === 0) {
    console.log('  (none)\n');
  } else {
    for (let i = 0; i < view.batches.length; i++) {
      const batch = view.batches[i];
      const header = i === 0
        ? `  Batch ${i + 1} (no deps between them):`
        : `  Batch ${i + 1} (depends on batch ${i}):`;
      console.log(header);
      for (const f of batch.files) {
        console.log(`    - ${f.file} (${f.tests} tests)`);
      }
      console.log('');
    }
  }

  console.log('Phase 3 - Leaf nodes (fix last):');
  if (view.leafNodes.length === 0) {
    console.log('  (none)\n');
  } else {
    for (const f of view.leafNodes) {
      console.log(`  - ${f.file} (${f.tests} test${f.tests === 1 ? '' : 's'})`);
    }
    console.log('');
  }

  console.log('Suggested command:');
  if (view.rootCauses.length > 0) {
    console.log('  # Fix root causes first');
    console.log(`  node scripts/test-fix.js ${view.rootCauses.map(x => x.file).join(' ')}`);
    console.log('');
  }

  if (view.batches.length > 0) {
    console.log('  # Then parallel batch');
    for (const batch of view.batches) {
      console.log(`  node scripts/test-fix.js --parallel ${batch.files.map(x => x.file).join(' ')}`);
    }
    console.log('');
  }
}

/**
 * @param {string[]} argv
 */
function printHelp(argv) {
  const cmd = path.basename(argv?.[1] || 'test-prioritize.js');
  console.log(`
Test Prioritize - 智能测试修复排序器

Usage:
  node ${cmd}
  node ${cmd} --from-file <result.json>
  node ${cmd} --failing <test1> <test2>...
  node ${cmd} --json

Notes:
  - 默认从 project root 的 .project-index/.test-result.json 读取失败测试（由 test-result.js --save 生成）
  - 依赖图来自 .dep-graph.json（dependency-graph.js 生成）
  - 映射来自 .test-map.json（test-mapper.js 生成）
`);
}

async function main() {
  const normalizedArgs = normalizeArgv(process.argv.slice(2));
  const args = parseArgs(normalizedArgs, {
    fromFile: null,
    failing: null,
    json: false,
    help: false
  });

  if (args.help) {
    printHelp(process.argv);
    return;
  }

  const projectRoot = await findProjectRoot(process.cwd());

  // Load dependency graph
  const depPath = path.join(projectRoot, '.dep-graph.json');
  if (!(await fileExists(depPath))) {
    console.error('Error: .dep-graph.json not found. Generate it first: node scripts/dependency-graph.js');
    process.exit(1);
  }
  /** @type {DepGraph|null} */
  const depGraph = await readJsonSafe(depPath, null);
  if (!depGraph || depGraph.version !== 1 || !depGraph.files) {
    console.error('Error: invalid .dep-graph.json format.');
    process.exit(1);
  }

  // Determine failing tests
  /** @type {string[]} */
  let failingTests = [];
  /** @type {Map<string, Set<string>>} */
  let fallbackTestToSources = new Map();

  if (typeof args.failing === 'string' && args.failing.trim()) {
    failingTests = uniqueSorted(args.failing.split(',').map(s => normalizeMaybeAbsPath(s.trim(), projectRoot)));
  } else if (typeof args.fromFile === 'string' && args.fromFile.trim()) {
    const abs = path.isAbsolute(args.fromFile) ? args.fromFile : path.resolve(process.cwd(), args.fromFile);
    const json = await readJsonSafe(abs, null);
    const extracted = extractFailingFromJson(json, projectRoot);
    failingTests = extracted.failingTests;
    fallbackTestToSources = extracted.fallbackTestToSources;
  } else {
    const cachedPath = path.join(projectRoot, '.project-index', '.test-result.json');
    if (!(await fileExists(cachedPath))) {
      console.error('Error: no cached vitest result found.');
      console.error('  Run: node scripts/test-result.js --save');
      console.error('  Or use: node test-prioritize.js --from-file <result.json>');
      console.error('  Or use: node test-prioritize.js --failing <test1> <test2>...');
      process.exit(1);
    }
    const json = await readJsonSafe(cachedPath, null);
    const extracted = extractFailingFromJson(json, projectRoot);
    failingTests = extracted.failingTests;
    fallbackTestToSources = extracted.fallbackTestToSources;
  }

  if (failingTests.length === 0) {
    if (args.json) {
      console.log(JSON.stringify({ totalFailing: 0, sourceFiles: 0, phases: [], suggestedOrder: [] }, null, 2));
    } else {
      console.log('No failing tests detected.');
    }
    return;
  }

  // Load test map (preferred)
  const testMapPath = path.join(projectRoot, '.test-map.json');
  /** @type {TestMap|null} */
  const testMap = await readJsonSafe(testMapPath, null);

  /** @type {Map<string, Set<string>>} */
  let testToSources = new Map();
  if (testMap && typeof testMap === 'object' && testMap.modules) {
    testToSources = buildTestToSourcesFromTestMap(testMap);
  } else {
    testToSources = fallbackTestToSources;
  }

  // failing test -> source files
  /** @type {Map<string, Set<string>>} */
  const sourceToFailingTests = new Map();
  /** @type {Set<string>} */
  const involvedSources = new Set();
  for (const t of failingTests) {
    const sources = testToSources.get(t) || new Set();
    for (const s of sources) {
      const src = normalizeRelInput(s);
      if (!src || src === '.' || src.startsWith('..')) continue;
      involvedSources.add(src);
      if (!sourceToFailingTests.has(src)) sourceToFailingTests.set(src, new Set());
      sourceToFailingTests.get(src)?.add(t);
    }
  }

  // If mapping is missing, fall back to "tests are sources" heuristic (still gives usable ordering).
  if (involvedSources.size === 0) {
    for (const t of failingTests) {
      involvedSources.add(t);
      sourceToFailingTests.set(t, new Set([t]));
    }
  }

  // Build involved keys and key->failing-tests lookup
  const graphRoot = depGraph.root || '.';
  /** @type {Set<string>} */
  const involvedKeys = new Set();
  /** @type {Map<string, string>} */
  const keyToFile = new Map();
  /** @type {Map<string, Set<string>>} */
  const keyToFailingTests = new Map();

  for (const sourceFile of involvedSources) {
    const key = normalizeRelInput(toGraphKey(sourceFile, graphRoot));
    involvedKeys.add(key);
    const display = normalizeRelInput(sourceFile);
    keyToFile.set(key, display);
    keyToFailingTests.set(key, new Set(sourceToFailingTests.get(display) || []));
  }

  // Compute candidate stats
  /** @type {{ file: string, key: string, dependents: number, failingTests: string[], potentialSet: Set<string>, potentialFixes: number }[]} */
  const enriched = [];
  for (const key of involvedKeys) {
    const file = keyToFile.get(key) || toProjectRel(key, graphRoot);
    const node = depGraph.files?.[key];
    const importedBy = Array.isArray(node?.importedBy) ? node.importedBy : [];
    const dependents = importedBy.length;
    const failingSet = keyToFailingTests.get(key) || new Set();

    const downstream = collectDownstreamKeys(depGraph, key);
    /** @type {Set<string>} */
    const potential = new Set();
    for (const dk of downstream) {
      const set = keyToFailingTests.get(dk);
      if (!set) continue;
      for (const t of set) potential.add(t);
    }

    enriched.push({
      file,
      key,
      dependents,
      failingTests: uniqueSorted(failingSet),
      potentialSet: potential,
      potentialFixes: potential.size
    });
  }

  const rootCauseKeys = new Set(selectRootCauseKeys(enriched, failingTests.length));

  // Build fix graph among involved keys and derive leaf nodes
  const { adj, outdegree } = buildFixGraph(depGraph, involvedKeys);
  const leafKeys = new Set(Array.from(involvedKeys).filter(k => (outdegree.get(k) || 0) === 0 && !rootCauseKeys.has(k)));

  // Phase 1: root causes (sorted by dependents desc)
  /** @type {Candidate[]} */
  const rootCauses = enriched
    .filter(x => rootCauseKeys.has(x.key))
    .sort((a, b) => (b.dependents - a.dependents) || b.potentialFixes - a.potentialFixes || a.file.localeCompare(b.file))
    .map(x => ({
      file: x.file,
      key: x.key,
      dependents: x.dependents,
      failingTests: x.failingTests,
      potentialFixes: x.potentialFixes
    }));

  // Phase 2: independent batches (middle nodes)
  const phase2Keys = new Set(Array.from(involvedKeys).filter(k => !rootCauseKeys.has(k) && !leafKeys.has(k)));
  const batchesKeys = topoBatches(adj, phase2Keys);

  const batches = batchesKeys.map(batchKeys => {
    /** @type {Set<string>} */
    const batchTests = new Set();
    const files = batchKeys
      .map(k => {
        const file = keyToFile.get(k) || toProjectRel(k, graphRoot);
        const tests = keyToFailingTests.get(k) || new Set();
        for (const t of tests) batchTests.add(t);
        return { file, tests: tests.size };
      })
      .sort((a, b) => (b.tests - a.tests) || a.file.localeCompare(b.file));
    return { files, tests: batchTests.size };
  }).filter(b => b.files.length > 0);

  // Phase 3: leaf nodes
  const leafNodes = Array.from(leafKeys)
    .map(k => {
      const file = keyToFile.get(k) || toProjectRel(k, graphRoot);
      const tests = keyToFailingTests.get(k) || new Set();
      return { file, tests: tests.size };
    })
    .sort((a, b) => (b.tests - a.tests) || a.file.localeCompare(b.file));

  // Suggested order: topo sort (dependency-first) over all involved keys.
  const topo = topoSortWithScc(adj, involvedKeys);
  const orderKeys = topo.order;
  const suggestedOrder = orderKeys.map(k => keyToFile.get(k) || toProjectRel(k, graphRoot));

  const jsonOut = {
    totalFailing: failingTests.length,
    sourceFiles: involvedKeys.size,
    phases: [
      {
        name: 'rootCauses',
        description: 'Fix these first - highest impact',
        items: rootCauses.map(x => ({
          file: x.file,
          dependents: x.dependents,
          failingTests: x.failingTests,
          potentialFixes: x.potentialFixes
        }))
      },
      {
        name: 'independent',
        description: 'Can fix in parallel',
        batches: batches.map(b => ({
          files: b.files.map(f => f.file),
          tests: b.tests
        }))
      },
      {
        name: 'leafNodes',
        description: 'Fix last',
        items: leafNodes.map(x => ({
          file: x.file,
          tests: x.tests
        }))
      }
    ],
    suggestedOrder
  };

  if (args.json) {
    console.log(JSON.stringify(jsonOut, null, 2));
    return;
  }

  printHuman({
    totalFailing: failingTests.length,
    sourceFiles: involvedKeys.size,
    rootCauses,
    batches,
    leafNodes,
    suggestedOrder
  });
}

main().catch(err => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
