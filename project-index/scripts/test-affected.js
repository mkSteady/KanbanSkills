#!/usr/bin/env node
/**
 * Test Affected - 智能测试运行器：只运行受变更影响的测试
 *
 * References:
 * - stale-propagate.js: 获取受影响测试列表（基于 .dep-graph.json + .test-map.json）
 * - test-prioritize.js: 可选排序（root cause 先）
 * - shared.js: 工具函数
 *
 * CLI:
 *   node test-affected.js
 *   node test-affected.js --since HEAD~3
 *   node test-affected.js --staged
 *   node test-affected.js --changed core/event-bus.js
 *   node test-affected.js --dry-run
 *   node test-affected.js --prioritized
 */

import { execFileSync, spawn } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  archiveToHistory,
  fileExists,
  findProjectRoot,
  formatDuration,
  parseArgs,
  readJsonSafe
} from './shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STALE_PROPAGATE = path.join(__dirname, 'stale-propagate.js');
const TEST_PRIORITIZE = path.join(__dirname, 'test-prioritize.js');

const HISTORY_FILE = '.test-affected-history.json';
const HISTORY_MAX_ENTRIES = 20;
const OUTPUT_MAX_TESTS = 40;
const OUTPUT_MAX_CHANGED = 50;
const OUTPUT_TAIL_CHARS = 20000;

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
 * @param {string[]} list
 * @returns {string[]}
 */
function uniqueSorted(list) {
  return Array.from(new Set(Array.from(list || []).filter(Boolean)))
    .map(normalizeRelInput)
    .filter(p => p && p !== '.' && !p.startsWith('..') && !path.isAbsolute(p))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * De-duplicate while preserving order.
 * @param {string[]} list
 * @returns {string[]}
 */
function uniqueInOrder(list) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const out = [];

  for (const item of list || []) {
    const p = normalizeRelInput(item);
    if (!p || p === '.' || p.startsWith('..') || path.isAbsolute(p)) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }

  return out;
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
    if ((arg === '--since' || arg === '--depth' || arg === '--changed') && i + 1 < argv.length) {
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
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
 * Supports comma-separated: --changed=a,b,c
 *
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
    for (const part of String(r).split(',')) {
      const s = part.trim();
      if (s) out.push(s);
    }
  }
  return out;
}

/**
 * Normalize a user-provided path into a project-relative path (best-effort).
 *
 * Rules:
 * - absolute -> relative to projectRoot (if inside)
 * - startsWith "." or ".." -> resolve from cwd then relative to projectRoot
 * - otherwise -> treat as project-relative
 *
 * @param {string} projectRoot
 * @param {string} cwd
 * @param {string} input
 * @returns {string}
 */
function normalizeUserPathToProjectRel(projectRoot, cwd, input) {
  const s = String(input || '').trim();
  if (!s) return '';

  if (path.isAbsolute(s)) {
    const rel = path.relative(projectRoot, s);
    const normalized = normalizeRelInput(rel);
    if (!normalized || normalized === '.' || normalized.startsWith('..') || path.isAbsolute(normalized)) return '';
    return normalized;
  }

  if (s.startsWith('.') || s.startsWith('..')) {
    const abs = path.resolve(cwd, s);
    const rel = path.relative(projectRoot, abs);
    const normalized = normalizeRelInput(rel);
    if (!normalized || normalized === '.' || normalized.startsWith('..') || path.isAbsolute(normalized)) return '';
    return normalized;
  }

  const normalized = normalizeRelInput(s);
  if (!normalized || normalized === '.' || normalized.startsWith('..') || path.isAbsolute(normalized)) return '';
  return normalized;
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
 * Run a node script and parse JSON from stdout.
 * @param {string} scriptPath
 * @param {string[]} args
 * @param {{cwd: string}} options
 * @returns {Promise<any>}
 */
async function runNodeJson(scriptPath, args, options) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      if (code !== 0) {
        const msg = stderr.trim() || stdout.trim() || `exit code ${code}`;
        reject(new Error(msg));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`Failed to parse JSON from ${path.basename(scriptPath)} stdout: ${e?.message || String(e)}`));
      }
    });
  });
}

/**
 * Build a source-path -> tests lookup from .test-map.json.
 * @param {any} testMap
 * @returns {Map<string, string[]>}
 */
function buildSourceToTests(testMap) {
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
 * Build a test-file -> source-files lookup from .test-map.json.
 * @param {any} testMap
 * @returns {Map<string, Set<string>>}
 */
function buildTestToSources(testMap) {
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
 * @param {number} level
 * @returns {string}
 */
function levelTag(level) {
  const n = Number.isFinite(level) ? Math.max(1, Math.floor(level)) : 99;
  return `L${n}`;
}

/**
 * @param {string} s
 * @returns {string}
 */
function formatEstimateString(s) {
  const m = String(s).trim().match(/^([0-9.]+)(ms|s|min|h)$/);
  if (!m) return String(s).trim();
  let num = m[1];
  const unit = m[2];
  if (num.endsWith('.0')) num = num.slice(0, -2);
  return `${num} ${unit}`;
}

/**
 * @param {any[]} history
 * @param {number} testFiles
 * @returns {number|null} Estimated duration in ms
 */
function estimateDurationMs(history, testFiles) {
  const n = Number.isFinite(testFiles) ? Math.max(0, Math.floor(testFiles)) : 0;
  if (n <= 0) return null;

  const entries = Array.isArray(history) ? history : [];
  const perFile = entries
    .map(e => ({
      files: Number(e?.testFiles || e?.tests || e?.files || 0),
      ms: Number(e?.durationMs || e?.duration || 0)
    }))
    .filter(x => Number.isFinite(x.files) && x.files > 0 && Number.isFinite(x.ms) && x.ms > 0)
    .map(x => x.ms / x.files);

  if (perFile.length === 0) return null;

  const avg = perFile.reduce((a, b) => a + b, 0) / perFile.length;
  return Math.round(avg * n);
}

/**
 * Parse Vitest output (best-effort) to extract per-test-file pass/fail counts.
 * @param {string} outputTail
 * @returns {{ passed: number|null, failed: number|null }}
 */
function parseVitestFileSummary(outputTail) {
  const text = String(outputTail || '');

  // Try: "Test Files  38 passed (40) | 2 failed"
  const re1 = /Test Files\s+(\d+)\s+passed\s+\((\d+)\)(?:\s*\|\s*(\d+)\s+failed)?/g;
  let m;
  /** @type {{passed: number, total: number, failed: number} | null} */
  let last = null;
  // eslint-disable-next-line no-cond-assign
  while ((m = re1.exec(text)) !== null) {
    const passed = parseInt(m[1], 10);
    const total = parseInt(m[2], 10);
    const failed = m[3] ? parseInt(m[3], 10) : Math.max(0, total - passed);
    if (Number.isFinite(passed) && Number.isFinite(total) && Number.isFinite(failed)) {
      last = { passed, total, failed };
    }
  }
  if (last) return { passed: last.passed, failed: last.failed };

  // Try: "Test Files  2 failed | 38 passed (40)" (rare)
  const re2 = /Test Files\s+(\d+)\s+failed\s*\|\s*(\d+)\s+passed\s+\((\d+)\)/g;
  // eslint-disable-next-line no-cond-assign
  while ((m = re2.exec(text)) !== null) {
    const failed = parseInt(m[1], 10);
    const passed = parseInt(m[2], 10);
    if (Number.isFinite(passed) && Number.isFinite(failed)) return { passed, failed };
  }

  return { passed: null, failed: null };
}

function printHelp(argv) {
  const cmd = path.basename(argv?.[1] || 'test-affected.js');
  console.log(`
Test Affected - 智能测试运行器（只跑受影响测试）

Usage:
  node ${cmd}
  node ${cmd} --since HEAD~3
  node ${cmd} --staged
  node ${cmd} --changed <file> [--changed <file> ...]
  node ${cmd} --dry-run
  node ${cmd} --prioritized

Options:
  --since <ref>      分析 git 变更（git diff --name-only <ref>）
  --staged           分析 staged 变更（git diff --name-only --cached）
  --changed <path>   指定变更文件（可重复，或逗号分隔）
  --dry-run          只显示会运行哪些测试，不执行
  --prioritized      按优先级排序（root cause 先）
  --help             显示帮助

Notes:
  - 依赖 .dep-graph.json（dependency-graph.js 生成）
  - 依赖 .test-map.json（test-mapper.js 生成）
`);
}

/**
 * @param {string[]} changedFiles
 * @param {{ file: string, level: number }[]} tests
 * @param {number|null} estimatedMs
 */
function printDryRun(changedFiles, tests, estimatedMs) {
  console.log('=== Affected Tests ===\n');

  console.log(`Changed files: ${changedFiles.length}`);
  if (changedFiles.length === 0) {
    console.log('  (none)');
  } else {
    for (const f of changedFiles.slice(0, OUTPUT_MAX_CHANGED)) console.log(`  - ${f}`);
    if (changedFiles.length > OUTPUT_MAX_CHANGED) console.log(`  ... +${changedFiles.length - OUTPUT_MAX_CHANGED} more`);
  }

  console.log(`\nTests to run: ${tests.length} files`);
  if (tests.length === 0) {
    console.log('  (none)');
  } else {
    for (const t of tests.slice(0, OUTPUT_MAX_TESTS)) {
      console.log(`  [${levelTag(t.level)}] ${t.file}`);
    }
    if (tests.length > OUTPUT_MAX_TESTS) console.log(`  ... +${tests.length - OUTPUT_MAX_TESTS} more`);
  }

  if (estimatedMs !== null) {
    const s = formatEstimateString(formatDuration(estimatedMs));
    console.log(`\nEstimated time: ~${s} (based on previous runs)`);
  }

  console.log('\nRun with: npx vitest run <files>');
}

/**
 * @param {string} projectRoot
 * @param {string[]} testFiles
 * @returns {Promise<{ exitCode: number, durationMs: number, passed: number|null, failed: number|null }>}
 */
async function runVitest(projectRoot, testFiles) {
  const args = ['vitest', 'run', '--reporter=dot', ...testFiles];

  console.log('=== Running Affected Tests ===\n');
  console.log(`Tests: ${testFiles.length} files`);
  console.log('Running: npx vitest run --reporter=dot ...\n');

  const start = Date.now();

  return await new Promise((resolve) => {
    const child = spawn('npx', args, {
      cwd: projectRoot,
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: process.platform === 'win32'
    });

    let tail = '';
    const onData = (stream, data) => {
      const s = data.toString();
      stream.write(s);
      tail = (tail + s).slice(-OUTPUT_TAIL_CHARS);
    };

    child.stdout.on('data', (d) => onData(process.stdout, d));
    child.stderr.on('data', (d) => onData(process.stderr, d));

    child.on('close', (code) => {
      const durationMs = Date.now() - start;
      const { passed, failed } = parseVitestFileSummary(tail);
      resolve({ exitCode: typeof code === 'number' ? code : 1, durationMs, passed, failed });
    });
  });
}

async function main() {
  const cwd = process.cwd();
  const projectRoot = await findProjectRoot(cwd);

  const argv = normalizeArgv(process.argv.slice(2));
  const args = parseArgs(argv, {
    since: null,
    staged: false,
    dryRun: false,
    prioritized: false,
    depth: null,
    help: false
  });

  if (args.help) {
    printHelp(process.argv);
    return;
  }

  if (args.since && args.staged) {
    console.error('Error: --since and --staged are mutually exclusive.');
    process.exitCode = 1;
    return;
  }

  const changedArgs = collectChangedArgs(argv);
  const positional = Array.isArray(args._) ? args._ : [];
  const hasExplicitChanged = changedArgs.length > 0 || positional.length > 0;

  if ((args.since || args.staged) && hasExplicitChanged) {
    console.error('Error: --since/--staged cannot be combined with explicit changed files.');
    process.exitCode = 1;
    return;
  }

  /** @type {string[]} */
  let explicitChanged = [];

  const explicitMode = Boolean(args.since || args.staged || hasExplicitChanged);

  if (args.since) {
    try {
      const out = git(projectRoot, ['diff', '--name-only', String(args.since)]);
      explicitChanged = uniqueSorted(normalizeGitPaths(splitLines(out)));
    } catch (err) {
      console.error(`Error: failed to run git diff --name-only ${args.since}`);
      console.error(err?.message || String(err));
      process.exitCode = 1;
      return;
    }
  } else if (args.staged) {
    try {
      const out = git(projectRoot, ['diff', '--name-only', '--cached']);
      explicitChanged = uniqueSorted(normalizeGitPaths(splitLines(out)));
    } catch (err) {
      console.error('Error: failed to run git diff --name-only --cached');
      console.error(err?.message || String(err));
      process.exitCode = 1;
      return;
    }
  } else if (hasExplicitChanged) {
    const raw = [...changedArgs, ...positional.map(String)];
    explicitChanged = uniqueSorted(raw.map(r => normalizeUserPathToProjectRel(projectRoot, cwd, r)).filter(Boolean));
  }

  // In explicit mode, an empty changed set should not fall back to stale auto-detect.
  if (explicitMode && explicitChanged.length === 0) {
    if (args.dryRun) {
      printDryRun([], [], null);
      return;
    }
    console.log('No changed files found.');
    return;
  }

  const depGraphPath = path.join(projectRoot, '.dep-graph.json');
  if (!(await fileExists(depGraphPath))) {
    console.error(`Error: missing ${depGraphPath}`);
    console.error('Generate it first: node scripts/dependency-graph.js');
    process.exitCode = 1;
    return;
  }

  const testMapPath = path.join(projectRoot, '.test-map.json');
  if (!(await fileExists(testMapPath))) {
    console.error(`Error: missing ${testMapPath}`);
    console.error('Generate it first: node scripts/test-mapper.js');
    process.exitCode = 1;
    return;
  }

  // Compute affected tests via stale-propagate.js
  /** @type {string[]} */
  const staleArgs = ['--json', '--tests'];
  if (args.depth !== null && args.depth !== undefined && args.depth !== '') {
    staleArgs.push(`--depth=${args.depth}`);
  }
  for (const f of explicitChanged) staleArgs.push(`--changed=${f}`);

  /** @type {{directStale: {file: string}[], propagatedStale: {file: string, level: number}[], testsToRun?: string[]}} */
  let stale;
  try {
    stale = await runNodeJson(STALE_PROPAGATE, staleArgs, { cwd: projectRoot });
  } catch (err) {
    console.error('Error: stale-propagate failed.');
    console.error(err?.message || String(err));
    process.exitCode = 1;
    return;
  }

  /** @type {any|null} */
  const depGraph = await readJsonSafe(depGraphPath, null);
  const graphRoot = normalizeRelInput(depGraph?.root || '.');

  const changedFiles = uniqueSorted((stale.directStale || []).map(d => joinRel(graphRoot, d.file)));
  const testsToRun = uniqueSorted(Array.isArray(stale.testsToRun) ? stale.testsToRun : []);

  if (testsToRun.length === 0) {
    if (args.dryRun) {
      printDryRun(changedFiles, [], null);
      return;
    }
    console.log('No affected tests detected.');
    return;
  }

  const testMap = await readJsonSafe(testMapPath, null);
  const sourceToTests = buildSourceToTests(testMap);
  const testToSources = buildTestToSources(testMap);

  /** @type {Map<string, number>} */
  const affectedSourceLevel = new Map();
  for (const d of stale.directStale || []) {
    const src = normalizeRelInput(joinRel(graphRoot, d.file));
    if (!src || src === '.' || src.startsWith('..')) continue;
    affectedSourceLevel.set(src, 1);
  }
  for (const p of stale.propagatedStale || []) {
    const src = normalizeRelInput(joinRel(graphRoot, p.file));
    if (!src || src === '.' || src.startsWith('..')) continue;
    const lvl = Number.isFinite(p.level) ? Math.max(1, Math.floor(p.level) + 1) : 2;
    const prev = affectedSourceLevel.get(src);
    if (!prev || lvl < prev) affectedSourceLevel.set(src, lvl);
  }

  /** @type {Map<string, number>} */
  const testLevel = new Map();
  for (const [src, lvl] of affectedSourceLevel.entries()) {
    const tests = sourceToTests.get(normalizeRelInput(src));
    if (!tests) continue;
    for (const t of tests) {
      const key = normalizeRelInput(t);
      if (!key || key === '.' || key.startsWith('..')) continue;
      const prev = testLevel.get(key);
      if (!prev || lvl < prev) testLevel.set(key, lvl);
    }
  }

  /** @type {{ file: string, level: number, rank: number }[]} */
  let tests = testsToRun.map(t => ({
    file: normalizeRelInput(t),
    level: testLevel.get(normalizeRelInput(t)) || 99,
    rank: Number.POSITIVE_INFINITY
  }));

  // Optional prioritization via test-prioritize.js (tie-break inside same level)
  if (args.prioritized) {
    try {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-affected-'));
      const tmpJson = path.join(tmpDir, 'failing.json');
      const payload = { errors: testsToRun.map(t => ({ testFile: t })) };
      await fs.writeFile(tmpJson, JSON.stringify(payload, null, 2));

      const priorityJson = await runNodeJson(TEST_PRIORITIZE, [`--from-file=${tmpJson}`, '--json'], { cwd: projectRoot });

      // Cleanup best-effort
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { });

      const phases = Array.isArray(priorityJson?.phases) ? priorityJson.phases : [];
      const rootPhase = phases.find(p => p?.name === 'rootCauses');
      const rootCauseFiles = Array.isArray(rootPhase?.items) ? rootPhase.items.map(i => i?.file).filter(Boolean) : [];
      const suggested = Array.isArray(priorityJson?.suggestedOrder) ? priorityJson.suggestedOrder : [];

      const orderedSources = uniqueInOrder([
        ...rootCauseFiles.map(normalizeRelInput),
        ...suggested.map(normalizeRelInput)
      ]);

      /** @type {Map<string, number>} */
      const sourceRank = new Map();
      for (let i = 0; i < orderedSources.length; i++) {
        if (!sourceRank.has(orderedSources[i])) sourceRank.set(orderedSources[i], i);
      }

      for (const t of tests) {
        const sources = testToSources.get(t.file) || new Set();
        let best = Number.POSITIVE_INFINITY;
        for (const s of sources) {
          const r = sourceRank.get(normalizeRelInput(s));
          if (typeof r === 'number' && r < best) best = r;
        }
        t.rank = best;
      }

      tests.sort((a, b) => {
        const ra = Number.isFinite(a.rank) ? a.rank : 1e9;
        const rb = Number.isFinite(b.rank) ? b.rank : 1e9;
        return (a.level - b.level) || (ra - rb) || a.file.localeCompare(b.file);
      });
    } catch {
      // Fall back to level-only ordering
      tests.sort((a, b) => (a.level - b.level) || a.file.localeCompare(b.file));
    }
  } else {
    tests.sort((a, b) => a.file.localeCompare(b.file));
  }

  const historyPath = path.join(projectRoot, '.project-index', HISTORY_FILE);
  const history = await readJsonSafe(historyPath, []);
  const estimateMs = estimateDurationMs(history, tests.length);

  if (args.dryRun) {
    printDryRun(changedFiles, tests.map(t => ({ file: t.file, level: t.level })), estimateMs);
    return;
  }

  const result = await runVitest(projectRoot, tests.map(t => t.file));

  console.log('\nSummary:');
  if (typeof result.passed === 'number' && typeof result.failed === 'number') {
    console.log(`  Passed: ${result.passed}`);
    console.log(`  Failed: ${result.failed}`);
  } else {
    console.log(`  Exit code: ${result.exitCode}`);
  }
  console.log(`  Time: ${formatEstimateString(formatDuration(result.durationMs))}`);

  await fs.mkdir(path.join(projectRoot, '.project-index'), { recursive: true }).catch(() => { });
  await archiveToHistory(historyPath, {
    testFiles: tests.length,
    durationMs: result.durationMs,
    passedFiles: result.passed,
    failedFiles: result.failed,
    exitCode: result.exitCode
  }, HISTORY_MAX_ENTRIES);

  process.exitCode = result.exitCode;
}

main().catch(err => {
  console.error(err?.stack || err?.message || String(err));
  process.exitCode = 1;
});
