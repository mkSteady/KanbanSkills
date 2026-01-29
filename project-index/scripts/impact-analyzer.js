#!/usr/bin/env node
/**
 * Impact Analyzer - analyze downstream files affected by a set of changed files
 *
 * Reads (from project root):
 *   - .dep-graph.json (required)
 *   - .test-map.json (optional)
 *
 * Usage:
 *   node impact-analyzer.js <file1> [file2...]
 *   node impact-analyzer.js --since <commit>
 *   node impact-analyzer.js --staged
 *
 * Options:
 *   --depth <n>   Propagation depth (0-2, default 2)
 *   --json        JSON output
 *   --help        Show help
 */

import path from 'path';
import { execFileSync } from 'child_process';
import { fileExists, findProjectRoot, matchesPattern, parseArgs, readJsonSafe } from './shared.js';

const DEFAULT_DEPTH = 2;
const MAX_DEPTH = 2; // Spec: up to 2 layers (L1 + L2)
const DEFAULT_RISK_THRESHOLD = 50;
const DEFAULT_RISK_TOP = 10;

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
 * @typedef {{ file: string, affectedCount: number }} HighRiskItem
 */

/**
 * @typedef {object} ImpactJson
 * @property {string[]} changed
 * @property {{ L1: string[], L2: string[], total: number }} impact
 * @property {HighRiskItem[]} highRisk
 * @property {Record<string, number>} moduleBreakdown
 * @property {string[]} [testFiles]
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
 * Support `--flag value` style for selected flags while still using shared.parseArgs().
 * @param {string[]} argv
 * @returns {string[]}
 */
function normalizeArgv(argv) {
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--since' || arg === '--depth' || arg === '--ignore') && i + 1 < argv.length) {
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
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trimEnd();
}

/**
 * @param {string} output
 * @returns {string[]}
 */
function splitLines(output) {
  return String(output || '')
    .split(/\r?\n/)
    .filter(s => s.length > 0);
}

/**
 * Resolve user-provided file arguments (absolute or relative-to-cwd) into project-relative paths.
 * @param {string} projectRoot
 * @param {string} cwd
 * @param {string[]} inputs
 * @returns {string[]}
 */
function resolveUserInputsToRel(projectRoot, cwd, inputs) {
  /** @type {string[]} */
  const out = [];
  for (const input of inputs || []) {
    const abs = path.isAbsolute(input) ? input : path.resolve(cwd, input);
    const rel = path.relative(projectRoot, abs);
    if (!rel || rel === '.') continue;
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    out.push(normalizeRelInput(rel));
  }
  return out;
}

/**
 * Normalize git output paths (already relative to repo root).
 * @param {string[]} paths
 * @returns {string[]}
 */
function normalizeGitPaths(paths) {
  /** @type {string[]} */
  const out = [];
  for (const p of paths || []) {
    const rel = normalizeRelInput(p);
    if (!rel || rel === '.') continue;
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    out.push(rel);
  }
  return out;
}

/**
 * @param {string[]} list
 * @returns {string[]}
 */
function uniqueSorted(list) {
  return Array.from(new Set(list || [])).sort((a, b) => a.localeCompare(b));
}

/**
 * BFS from changed files upwards via importedBy.
 * L1: direct importers
 * L2: transitive importers (2nd hop)
 *
 * @param {DepGraph} depGraph
 * @param {string[]} changedFiles
 * @param {number} depth
 * @returns {{ L1: Set<string>, L2: Set<string>, affected: Set<string> }}
 */
function analyzeImpact(depGraph, changedFiles, depth) {
  const clampedDepth = Math.max(0, Math.min(MAX_DEPTH, Number.isFinite(depth) ? depth : DEFAULT_DEPTH));

  /** @type {Set<string>} */
  const visited = new Set(changedFiles);
  /** @type {Set<string>} */
  let frontier = new Set(changedFiles);

  /** @type {Set<string>} */
  const L1 = new Set();
  /** @type {Set<string>} */
  const L2 = new Set();

  for (let d = 1; d <= clampedDepth; d++) {
    /** @type {Set<string>} */
    const next = new Set();

    for (const file of frontier) {
      const node = depGraph.files?.[file];
      const importedBy = Array.isArray(node?.importedBy) ? node.importedBy : [];
      for (const parent of importedBy) {
        const rel = normalizeRelInput(parent);
        if (!rel || visited.has(rel)) continue;
        visited.add(rel);
        next.add(rel);
        if (d === 1) L1.add(rel);
        else L2.add(rel);
      }
    }

    frontier = next;
    if (frontier.size === 0) break;
  }

  /** @type {Set<string>} */
  const affected = new Set([...L1, ...L2]);
  return { L1, L2, affected };
}

/**
 * Count all downstream affected files for a single changed file (unbounded BFS).
 * Used for "high-risk" scoring (independent of --depth).
 *
 * @param {DepGraph} depGraph
 * @param {string} start
 * @returns {number}
 */
function countAllAffected(depGraph, start) {
  if (!depGraph.files?.[start]) return 0;

  /** @type {Set<string>} */
  const visited = new Set([start]);
  /** @type {string[]} */
  const queue = [start];

  while (queue.length > 0) {
    const file = queue.shift();
    const node = file ? depGraph.files?.[file] : null;
    const importedBy = Array.isArray(node?.importedBy) ? node.importedBy : [];

    for (const parent of importedBy) {
      const rel = normalizeRelInput(parent);
      if (!rel || visited.has(rel)) continue;
      visited.add(rel);
      queue.push(rel);
    }
  }

  return Math.max(0, visited.size - 1);
}

/**
 * @param {string} relPath
 * @returns {string}
 */
function moduleName(relPath) {
  const p = normalizeRelInput(relPath);
  const idx = p.indexOf('/');
  if (idx === -1) return '(root)';
  return p.slice(0, idx) || '(root)';
}

/**
 * @param {string[]} affectedFiles
 * @returns {Record<string, number>}
 */
function buildModuleBreakdown(affectedFiles) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const f of affectedFiles || []) {
    const mod = moduleName(f);
    out[mod] = (out[mod] || 0) + 1;
  }
  return out;
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
  console.log(`Impact Analyzer

Usage:
  node impact-analyzer.js <file1> [file2...]
  node impact-analyzer.js --since <commit>
  node impact-analyzer.js --staged

Options:
  --depth <n>   Propagation depth (0-2, default ${DEFAULT_DEPTH})
  --ignore <p>  Ignore globs (comma-separated), e.g. "docs/**,**/*.md"
  --json        JSON output
  --help        Show help
`);
}

/**
 * @param {ImpactJson} result
 */
function printHuman(result) {
  console.log(`Changed: ${result.changed.length} files`);
  for (const f of result.changed) console.log(`  - ${f}`);

  console.log('\nImpact Analysis:');
  console.log(`  L1 (direct): ${result.impact.L1.length} files`);
  console.log(`  L2 (transitive): ${result.impact.L2.length} files`);
  console.log(`  Total affected: ${result.impact.total} files`);

  if (result.highRisk.length > 0) {
    console.log('\nHigh-risk changes:');
    for (const item of result.highRisk) {
      console.log(`  ! ${item.file} affects ${item.affectedCount} files`);
    }
  }

  const modules = Object.entries(result.moduleBreakdown)
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));

  if (modules.length > 0) {
    console.log('\nModules affected:');
    for (const [mod, count] of modules) {
      console.log(`  - ${mod}: ${count} files`);
    }
  }

  if (Array.isArray(result.testFiles) && result.testFiles.length > 0) {
    console.log('\nTests to rerun:');
    for (const t of result.testFiles) console.log(`  - ${t}`);
  }
}

/**
 * @param {ImpactJson} result
 */
function printJson(result) {
  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  const cwd = process.cwd();
  const projectRoot = await findProjectRoot(cwd);

  const args = parseArgs(normalizeArgv(process.argv.slice(2)), {
    depth: DEFAULT_DEPTH,
    json: false,
    ignore: null
  });

  if (args.help) {
    printHelp();
    return;
  }

  if (args.since && args.staged) {
    console.error('Error: --since and --staged are mutually exclusive.');
    process.exitCode = 1;
    return;
  }

  /** @type {string[]} */
  let changed = [];

  if (args.since) {
    try {
      const out = git(projectRoot, ['diff', '--name-only', String(args.since)]);
      changed = normalizeGitPaths(splitLines(out));
    } catch (err) {
      console.error(`Error: failed to run git diff --name-only ${args.since}`);
      console.error(err?.message || String(err));
      process.exitCode = 1;
      return;
    }
  } else if (args.staged) {
    try {
      const out = git(projectRoot, ['diff', '--name-only', '--cached']);
      changed = normalizeGitPaths(splitLines(out));
    } catch (err) {
      console.error('Error: failed to run git diff --name-only --cached');
      console.error(err?.message || String(err));
      process.exitCode = 1;
      return;
    }
  } else {
    const positional = Array.isArray(args._) ? args._ : [];
    changed = resolveUserInputsToRel(projectRoot, cwd, positional);
  }

  changed = uniqueSorted(changed);

  const ignorePatterns = typeof args.ignore === 'string'
    ? String(args.ignore).split(',').map(s => s.trim()).filter(Boolean)
    : [];

  if (ignorePatterns.length > 0) {
    changed = changed.filter(p => !matchesPattern(p, ignorePatterns));
  }

  if (changed.length === 0) {
    const extra = ignorePatterns.length > 0 ? ' (all were filtered by --ignore)' : '';
    console.error(`No changed files found${extra}. Provide file paths or use --since/--staged.`);
    process.exitCode = 1;
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
  if (!depGraph || typeof depGraph !== 'object' || !depGraph.files) {
    console.error(`Error: invalid ${depGraphPath}`);
    process.exitCode = 1;
    return;
  }

  const requestedDepth = Number.isFinite(args.depth) ? args.depth : DEFAULT_DEPTH;
  const { L1, L2, affected } = analyzeImpact(depGraph, changed, requestedDepth);

  const isIgnored = (p) => ignorePatterns.length > 0 && matchesPattern(p, ignorePatterns);

  const l1Arr = uniqueSorted(Array.from(L1)).filter(p => !isIgnored(p));
  const l2Arr = uniqueSorted(Array.from(L2)).filter(p => !isIgnored(p));
  const affectedArr = uniqueSorted([...l1Arr, ...l2Arr]);
  const totalAffected = affectedArr.length;

  const highRisk = changed
    .map(file => ({ file, affectedCount: countAllAffected(depGraph, file) }))
    .filter(item => item.affectedCount >= DEFAULT_RISK_THRESHOLD)
    .sort((a, b) => (b.affectedCount - a.affectedCount) || a.file.localeCompare(b.file))
    .slice(0, DEFAULT_RISK_TOP);

  const moduleBreakdown = buildModuleBreakdown(affectedArr);

  const testMapPath = path.join(projectRoot, '.test-map.json');
  /** @type {string[]|undefined} */
  let testFiles;
  let hasTestMap = false;
  if (await fileExists(testMapPath)) {
    const testMap = await readJsonSafe(testMapPath, null);
    if (testMap && typeof testMap === 'object') {
      hasTestMap = true;
      const testLookup = buildTestLookup(testMap);
      const fileUniverse = uniqueSorted([...changed, ...affectedArr]);
      testFiles = collectTestFiles(testLookup, fileUniverse);
    }
  }

  /** @type {ImpactJson} */
  const result = {
    changed,
    impact: { L1: l1Arr, L2: l2Arr, total: totalAffected },
    highRisk,
    moduleBreakdown,
    ...(hasTestMap ? { testFiles: testFiles || [] } : {})
  };

  if (args.json) printJson(result);
  else printHuman(result);
}

main().catch(err => {
  console.error(err?.message || String(err));
  process.exitCode = 1;
});
