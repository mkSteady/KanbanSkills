/**
 * Test prioritizer - determine fix order based on dependency graph
 * Uses SCC (Strongly Connected Components) for topological sorting
 */

import path from 'path';
import { spawn } from 'child_process';
import { getDirectoryRule, readJsonSafe, runCommand, writeJsonSafe } from '../shared.js';
import { getCachePath, loadStaleConfig } from '../context.js';
import { propagateStale } from '../deps/graph.js';

/** @typedef {import('../types.js').ProjectConfig} ProjectConfig */

/**
 * Prioritize test fixes based on dependency graph
 * @param {{root: string, config: ProjectConfig}} ctx
 * @param {object} args
 */
export async function prioritize(ctx, args) {
  const { root, config } = ctx;
  const staleConfig = ctx.staleConfig || await loadStaleConfig(root, config);
  const directoryRules = staleConfig?.directoryRules || {};

  // Load dependency graph and test results
  const graphPath = getCachePath(config, root, '.dep-graph.json');
  const resultPath = getCachePath(config, root, '.test-result.json');
  const mapPath = getCachePath(config, root, '.test-map.json');

  const [graph, testResult, testMap] = await Promise.all([
    readJsonSafe(graphPath),
    readJsonSafe(resultPath),
    readJsonSafe(mapPath)
  ]);

  if (!graph) {
    console.error('No dependency graph. Run "pi deps build" first.');
    process.exitCode = 1;
    return;
  }

  if (!testResult) {
    console.error('No test results. Run "pi test run" first.');
    process.exitCode = 1;
    return;
  }

  // Get failing test files
  const failingTests = new Set(testResult.errors?.map(e => e.testFile) || []);

  // Map failing tests to source files
  const failingSourceFiles = new Map(); // sourceFile -> [testFiles]

  for (const testFile of failingTests) {
    const srcFile = testMap?.testToSrc?.[testFile];
    if (srcFile) {
      if (!failingSourceFiles.has(srcFile)) {
        failingSourceFiles.set(srcFile, []);
      }
      failingSourceFiles.get(srcFile).push(testFile);
    }
  }

  // Build priority based on dependency count
  const priorities = [];

  for (const [srcFile, tests] of failingSourceFiles) {
    const node = graph.files?.[srcFile];
    const dependents = node?.importedBy?.length || 0;

    // Calculate potential fixes (how many other failures might be fixed)
    let potentialFixes = 0;
    for (const dep of node?.importedBy || []) {
      if (failingSourceFiles.has(dep)) {
        potentialFixes += failingSourceFiles.get(dep).length;
      }
    }

    const dirRule = getDirectoryRule(srcFile, directoryRules);
    const testFocus = Array.isArray(dirRule?.rule?.testFocus) ? dirRule.rule.testFocus : null;

    priorities.push({
      file: srcFile,
      dependents,
      failingTests: tests,
      potentialFixes,
      directoryRule: dirRule?.path || null,
      priority: dirRule?.rule?.priority ? String(dirRule.rule.priority) : null,
      testFocus
    });
  }

  // Sort by: dependents (desc) -> potentialFixes (desc) -> failing tests (desc)
  priorities.sort((a, b) => {
    if (b.dependents !== a.dependents) return b.dependents - a.dependents;
    if (b.potentialFixes !== a.potentialFixes) return b.potentialFixes - a.potentialFixes;
    return b.failingTests.length - a.failingTests.length;
  });

  // Group into phases
  const phases = {
    rootCauses: { name: 'rootCauses', items: [] },
    independent: { name: 'independent', batches: [] },
    leafNodes: { name: 'leafNodes', items: [] }
  };

  // Root causes: files with dependents > 0
  phases.rootCauses.items = priorities
    .filter(p => p.dependents > 0)
    .slice(0, 10);

  // Leaf nodes: files with no dependents
  phases.leafNodes.items = priorities
    .filter(p => p.dependents === 0)
    .map(p => ({ file: p.file, tests: p.failingTests.length, directoryRule: p.directoryRule || null, testFocus: p.testFocus || null }));

  // Independent: can be batched
  const independentFiles = priorities
    .filter(p => p.dependents === 0)
    .map(p => p.file);

  // Batch independent files (5 per batch)
  const batchSize = 5;
  for (let i = 0; i < independentFiles.length; i += batchSize) {
    phases.independent.batches.push({
      files: independentFiles.slice(i, i + batchSize),
      tests: independentFiles.slice(i, i + batchSize).reduce((sum, f) => {
        return sum + (failingSourceFiles.get(f)?.length || 0);
      }, 0)
    });
  }

  const result = {
    totalFailing: failingTests.size,
    sourceFiles: failingSourceFiles.size,
    phases: [phases.rootCauses, phases.independent, phases.leafNodes],
    suggestedOrder: priorities.slice(0, 20).map(p => p.file)
  };

  // Save
  const cachePath = getCachePath(config, root, '.test-priority.json');
  await writeJsonSafe(cachePath, result);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Test priority analysis:`);
    console.log(`  Failing tests: ${result.totalFailing}`);
    console.log(`  Source files: ${result.sourceFiles}`);
    console.log(`\nPhase 1 (Root Causes): ${phases.rootCauses.items.length} files`);
    for (const item of phases.rootCauses.items.slice(0, 5)) {
      console.log(`    ${item.file} (${item.dependents} dependents)`);
    }
    console.log(`\nPhase 2 (Independent): ${phases.independent.batches.length} batches`);
    console.log(`Phase 3 (Leaf Nodes): ${phases.leafNodes.items.length} files`);
  }

  return result;
}

/**
 * Find tests affected by changed files
 * @param {{root: string, config: ProjectConfig}} ctx
 * @param {object} args
 */
export async function findAffected(ctx, args) {
  const { root, config } = ctx;

  const cacheGraphPath = getCachePath(config, root, '.dep-graph.json');
  const rootGraphPath = path.join(root, '.dep-graph.json');
  const cacheMapPath = getCachePath(config, root, '.test-map.json');
  const rootMapPath = path.join(root, '.test-map.json');

  const [graph, testMap] = await Promise.all([
    readJsonSafe(cacheGraphPath).then(g => g || readJsonSafe(rootGraphPath)),
    readJsonSafe(cacheMapPath).then(m => m || readJsonSafe(rootMapPath))
  ]);

  if (!graph || !testMap) {
    console.error('Missing graph or test map. Run "pi deps build" and "pi test map" first.');
    process.exitCode = 1;
    return;
  }

  /**
   * @param {string[]} list
   * @returns {string[]}
   */
  function uniqueSorted(list) {
    return Array.from(new Set((list || []).filter(Boolean)))
      .sort((a, b) => a.localeCompare(b));
  }

  /**
   * @param {string} input
   * @returns {string[]}
   */
  function splitCommaList(input) {
    return String(input || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
  }

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
   * Convert an input path into a safe project-relative path key.
   * @param {string} rootAbs
   * @param {string} input
   * @returns {string|null}
   */
  function toProjectRelPath(rootAbs, input) {
    const raw = String(input || '').trim();
    if (!raw) return null;

    if (path.isAbsolute(raw)) {
      const rel = path.relative(rootAbs, raw);
      const normalized = normalizeRelInput(rel);
      if (!normalized || normalized === '.') return null;
      if (normalized.startsWith('..') || path.isAbsolute(normalized)) return null;
      return normalized;
    }

    const normalized = normalizeRelInput(raw);
    if (!normalized || normalized === '.') return null;
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) return null;
    return normalized;
  }

  /**
   * Collect all occurrences of `--changed` from raw argv.
   * Supports:
   *  - --changed <file>
   *  - --changed=<file>
   *  - repeated --changed
   *  - comma-separated lists
   *
   * @param {string[]} argv
   * @returns {string[]}
   */
  function collectChangedFromArgv(argv) {
    const out = [];
    const prefix = '--changed=';
    for (let i = 0; i < (argv || []).length; i++) {
      const a = String(argv[i] || '');
      if (a === '--changed') {
        const next = i + 1 < argv.length ? String(argv[i + 1] || '') : '';
        if (next && !next.startsWith('-')) {
          out.push(next);
          i++;
        }
        continue;
      }
      if (a.startsWith(prefix)) out.push(a.slice(prefix.length));
    }
    return out.flatMap(splitCommaList);
  }

  /**
   * @param {string} output
   * @returns {string[]}
   */
  function splitLines(output) {
    return String(output || '')
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean);
  }

  /**
   * Normalize git output paths (already relative to repo root).
   * @param {string[]} paths
   * @returns {string[]}
   */
  function normalizeGitPaths(paths) {
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
   * @param {string[]} argv
   * @returns {string[]}
   */
  function normalizeArgvForParseArgs(argv) {
    const out = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if ((a === '--since' || a === '--changed' || a === '--depth') && i + 1 < argv.length) {
        const next = argv[i + 1];
        if (next && !next.startsWith('-')) {
          out.push(`${a}=${next}`);
          i++;
          continue;
        }
      }
      out.push(a);
    }
    return out;
  }

  /**
   * @param {string} cwd
   * @param {string[]} gitArgs
   * @returns {Promise<string[]>}
   */
  async function gitNameOnly(cwd, gitArgs) {
    const res = await runCommand('git', gitArgs, { cwd });
    if (res.code !== 0) {
      const message = String(res.stderr || '').trim() || `git ${gitArgs.join(' ')}`;
      throw new Error(message);
    }
    return normalizeGitPaths(splitLines(res.stdout || ''));
  }

  /**
   * @param {any} input
   * @returns {boolean}
   */
  function boolFlag(input) {
    return input === true || input === 'true' || input === 1 || input === '1';
  }

  const argv = normalizeArgvForParseArgs(process.argv.slice(2));
  const changedFromArgv = Array.isArray(args?._) && args._[0] === 'test' && args._[1] === 'affected'
    ? collectChangedFromArgv(argv)
    : [];

  const json = boolFlag(args?.json);
  const dryRun = boolFlag(args?.['dry-run']) || boolFlag(args?.dryRun);
  const prioritized = boolFlag(args?.prioritized);
  const since = args?.since ? String(args.since) : null;
  const staged = boolFlag(args?.staged);
  const depth = args?.depth ?? null;

  if (since && staged) {
    console.error('Error: --since and --staged are mutually exclusive.');
    process.exitCode = 1;
    return;
  }

  const positionalChanged = Array.isArray(args?._) ? args._.slice(2).map(String) : [];
  const changedFromArgs = Array.isArray(args?.changed)
    ? args.changed.flatMap(splitCommaList)
    : typeof args?.changed === 'string'
    ? splitCommaList(args.changed)
    : [];

  const hasExplicitChanged = positionalChanged.length > 0 || changedFromArgs.length > 0 || changedFromArgv.length > 0;
  const explicitMode = Boolean(since || staged || hasExplicitChanged);

  if ((since || staged) && hasExplicitChanged) {
    console.error('Error: --since/--staged cannot be combined with explicit changed files.');
    process.exitCode = 1;
    return;
  }

  /** @type {string[]} */
  let changedFiles = [];

  if (since) {
    try {
      changedFiles = await gitNameOnly(root, ['diff', '--name-only', since]);
    } catch (err) {
      console.error(`Error: failed to run git diff --name-only ${since}`);
      console.error(err?.message || String(err));
      process.exitCode = 1;
      return;
    }
  } else if (staged) {
    try {
      changedFiles = await gitNameOnly(root, ['diff', '--name-only', '--cached']);
    } catch (err) {
      console.error('Error: failed to run git diff --name-only --cached');
      console.error(err?.message || String(err));
      process.exitCode = 1;
      return;
    }
  } else {
    const raw = [...positionalChanged, ...changedFromArgs, ...changedFromArgv];
    changedFiles = raw
      .map(s => toProjectRelPath(root, s))
      .filter(p => p && p !== '.' && !p.startsWith('..') && !path.isAbsolute(p));
  }

  changedFiles = uniqueSorted(changedFiles.map(normalizeRelInput).filter(p => p && p !== '.'));

  if (!explicitMode) {
    console.error('Usage: pi test affected [--since <commit> | --staged | --changed <file>] [file1 file2 ...] [--dry-run] [--prioritized]');
    process.exitCode = 1;
    return;
  }

  if (changedFiles.length === 0) {
    const empty = {
      changedFiles: [],
      affectedSourceFiles: [],
      affectedTests: [],
      stats: { changed: 0, affectedSrc: 0, affectedTests: 0 },
      ...(prioritized ? { prioritized: true } : {}),
      ...(dryRun ? { dryRun: true } : {}),
      ...(since ? { since } : {}),
      ...(staged ? { staged: true } : {}),
      ...(depth !== null && depth !== undefined ? { depth } : {})
    };

    if (json) {
      console.log(JSON.stringify(empty, null, 2));
      return empty;
    }

    if (dryRun) {
      console.log('Affected by 0 changed files:');
      console.log('  Source files: 0');
      console.log('  Tests: 0');
      return empty;
    }

    console.log('No changed files found.');
    return empty;
  }

  /**
   * Compute source-file priorities (root causes first) given a test file set.
   * @param {any} depGraph
   * @param {any} map
   * @param {Set<string>} testFiles
   * @returns {{ file: string, dependents: number, failingTests: string[], potentialFixes: number }[]}
   */
  function computeSourcePriorities(depGraph, map, testFiles) {
    const failingSourceFiles = new Map(); // sourceFile -> [testFiles]
    const testToSrc = map?.testToSrc && typeof map.testToSrc === 'object' ? map.testToSrc : {};

    for (const testFile of testFiles || []) {
      const srcFile = testToSrc?.[testFile];
      if (!srcFile) continue;
      if (!failingSourceFiles.has(srcFile)) failingSourceFiles.set(srcFile, []);
      failingSourceFiles.get(srcFile)?.push(testFile);
    }

    /** @type {{ file: string, dependents: number, failingTests: string[], potentialFixes: number }[]} */
    const priorities = [];

    for (const [srcFile, tests] of failingSourceFiles) {
      const node = depGraph.files?.[srcFile];
      const dependents = node?.importedBy?.length || 0;

      let potentialFixes = 0;
      for (const dep of node?.importedBy || []) {
        if (failingSourceFiles.has(dep)) {
          potentialFixes += failingSourceFiles.get(dep)?.length || 0;
        }
      }

      priorities.push({ file: srcFile, dependents, failingTests: tests, potentialFixes });
    }

    priorities.sort((a, b) => {
      if (b.dependents !== a.dependents) return b.dependents - a.dependents;
      if (b.potentialFixes !== a.potentialFixes) return b.potentialFixes - a.potentialFixes;
      return b.failingTests.length - a.failingTests.length;
    });

    return priorities;
  }

  /** @type {any} */
  let stale;
  try {
    stale = await propagateStale(ctx, {
      quiet: true,
      tests: true,
      ...(depth !== null && depth !== undefined ? { depth } : {}),
      changed: changedFiles
    });
  } catch (err) {
    console.error('Error: stale propagation failed.');
    console.error(err?.message || String(err));
    process.exitCode = 1;
    return;
  }

  const directStale = Array.isArray(stale?.directStale) ? stale.directStale : [];
  const propagatedStale = Array.isArray(stale?.propagatedStale) ? stale.propagatedStale : [];
  const affectedSourceFiles = Array.isArray(stale?.staleFiles) ? stale.staleFiles : [];
  const testsToRun = Array.isArray(stale?.testsToRun) ? stale.testsToRun : [];

  /** @type {Map<string, number>} */
  const sourceLevel = new Map();
  for (const item of directStale) {
    const file = normalizeRelInput(item?.file || '');
    if (!file || file === '.' || file.startsWith('..') || path.isAbsolute(file)) continue;
    sourceLevel.set(file, 1);
  }
  for (const item of propagatedStale) {
    const file = normalizeRelInput(item?.file || '');
    if (!file || file === '.' || file.startsWith('..') || path.isAbsolute(file)) continue;
    const lvl = Number.isFinite(item?.level) ? Math.max(2, Math.floor(item.level) + 1) : 2;
    const prev = sourceLevel.get(file);
    if (!prev || lvl < prev) sourceLevel.set(file, lvl);
  }

  const orderedTests = (() => {
    const testSet = new Set(testsToRun.map(normalizeRelInput).filter(p => p && p !== '.'));

    /** @type {{file: string, level: number, rank: number}[]} */
    let tests = Array.from(testSet).map(file => ({ file, level: 99, rank: Number.POSITIVE_INFINITY }));

    const testToSrc = testMap?.testToSrc && typeof testMap.testToSrc === 'object' ? testMap.testToSrc : {};

    for (const t of tests) {
      const src = normalizeRelInput(testToSrc?.[t.file] || '');
      const candidates = [];
      if (src && src !== '.' && !src.startsWith('..') && !path.isAbsolute(src)) candidates.push(src);
      candidates.push(t.file);

      let best = 99;
      for (const c of candidates) {
        const lvl = sourceLevel.get(normalizeRelInput(c));
        if (typeof lvl === 'number' && lvl < best) best = lvl;
      }
      t.level = best;
    }

    if (!prioritized) {
      tests.sort((a, b) => a.file.localeCompare(b.file));
      return tests;
    }

    const priorities = computeSourcePriorities(graph, testMap, testSet);
    const sourceRank = new Map(priorities.map((p, idx) => [normalizeRelInput(p.file), idx]));

    for (const t of tests) {
      const src = normalizeRelInput(testToSrc?.[t.file] || '');
      const r = src ? sourceRank.get(src) : undefined;
      t.rank = typeof r === 'number' ? r : Number.POSITIVE_INFINITY;
    }

    tests.sort((a, b) => {
      const ra = Number.isFinite(a.rank) ? a.rank : 1e9;
      const rb = Number.isFinite(b.rank) ? b.rank : 1e9;
      return (a.level - b.level) || (ra - rb) || a.file.localeCompare(b.file);
    });

    return tests;
  })();

  const affectedTests = orderedTests.map(t => t.file);

  const result = {
    changedFiles: uniqueSorted(changedFiles),
    affectedSourceFiles: uniqueSorted(affectedSourceFiles.map(normalizeRelInput).filter(p => p && p !== '.')),
    affectedTests,
    stats: {
      changed: changedFiles.length,
      affectedSrc: affectedSourceFiles.length,
      affectedTests: affectedTests.length
    },
    ...(prioritized ? { prioritized: true } : {}),
    ...(dryRun ? { dryRun: true } : {}),
    ...(since ? { since } : {}),
    ...(staged ? { staged: true } : {}),
    ...(depth !== null && depth !== undefined ? { depth } : {})
  };

  if (!json) {
    console.log(`Affected by ${changedFiles.length} changed files:`);
    console.log(`  Source files: ${result.affectedSourceFiles.length}`);
    console.log(`  Tests: ${result.affectedTests.length}`);

    if (result.affectedTests.length > 0 && result.affectedTests.length <= 40) {
      console.log('\nAffected tests:');
      for (const t of result.affectedTests) {
        const meta = orderedTests.find(x => x.file === t);
        const lvl = meta?.level;
        const tag = Number.isFinite(lvl) && lvl !== 99 ? ` [L${lvl}]` : '';
        console.log(`  ${t}${tag}`);
      }
    }
  }

  if (dryRun || result.affectedTests.length === 0) {
    if (!json && result.affectedTests.length === 0) {
      console.log('\nNo affected tests detected.');
    }
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    }
    return result;
  }

  if (!config.test?.cmd) {
    const msg = 'No test command configured. Set test.cmd in .pi-config.json';
    if (json) {
      console.log(JSON.stringify({ ...result, error: msg }, null, 2));
      process.exitCode = 1;
      return { ...result, error: msg };
    }
    console.error(msg);
    process.exitCode = 1;
    return result;
  }

  const [cmd, ...cmdArgs] = String(config.test.cmd).split(/\s+/);
  const testArgs = [...cmdArgs, ...result.affectedTests];

  if (!json) {
    console.log('\nRunning affected tests...\n');
    console.log(`Running: ${cmd} ${testArgs.join(' ')}`);
  }

  const start = Date.now();
  const exitCode = await new Promise((resolve) => {
    const child = spawn(cmd, testArgs, {
      cwd: root,
      stdio: json ? ['ignore', 'ignore', 'ignore'] : 'inherit',
      shell: process.platform === 'win32'
    });

    child.on('close', (code) => resolve(typeof code === 'number' ? code : 1));
    child.on('error', () => resolve(1));
  });
  const durationMs = Date.now() - start;

  if (!json) {
    console.log(`\nDone. Exit code: ${exitCode}. Time: ${(durationMs / 1000).toFixed(1)}s`);
  }

  const historyPath = getCachePath(config, root, '.test-affected-history.json');
  const history = await readJsonSafe(historyPath, []);
  const next = Array.isArray(history) ? history : [];

  next.unshift({
    ts: new Date().toISOString(),
    changedFiles: result.changedFiles.length,
    affectedSourceFiles: result.affectedSourceFiles.length,
    affectedTests: result.affectedTests.length,
    exitCode,
    durationMs,
    ...(since ? { since } : {}),
    ...(staged ? { staged: true } : {}),
    ...(prioritized ? { prioritized: true } : {}),
    ...(depth !== null && depth !== undefined ? { depth } : {})
  });

  await writeJsonSafe(historyPath, next.slice(0, 20));

  process.exitCode = exitCode;
  const finalResult = { ...result, run: { exitCode, durationMs } };
  if (json) {
    console.log(JSON.stringify(finalResult, null, 2));
  }
  return finalResult;
}

/**
 * Generate test fix plan (markdown)
 * @param {{root: string, config: ProjectConfig}} ctx
 * @param {object} args
 */
export async function generatePlan(ctx, args) {
  const { root, config } = ctx;

  const resultPath = getCachePath(config, root, '.test-result.json');
  const priorityPath = getCachePath(config, root, '.test-priority.json');

  const [testResult, priority] = await Promise.all([
    readJsonSafe(resultPath),
    readJsonSafe(priorityPath)
  ]);

  if (!testResult) {
    console.error('No test results. Run "pi test run" first.');
    process.exitCode = 1;
    return;
  }

  if (!priority) {
    // Run prioritize first
    await prioritize(ctx, { json: false });
    return generatePlan(ctx, args);
  }

  // Build error summary
  const errorsByFile = new Map();
  for (const err of testResult.errors || []) {
    const key = err.testFile;
    if (!errorsByFile.has(key)) {
      errorsByFile.set(key, { count: 0, types: {}, samples: [] });
    }
    const entry = errorsByFile.get(key);
    entry.count++;

    const type = err.message?.match(/^(\w+Error)/)?.[1] || 'Other';
    entry.types[type] = (entry.types[type] || 0) + 1;

    if (entry.samples.length < 2) {
      entry.samples.push({
        test: err.test?.slice(0, 50),
        error: err.message?.slice(0, 70)
      });
    }
  }

  // Generate markdown
  const lines = [];
  lines.push('## Test Fix Plan\n');
  lines.push(`**Framework**: \`${config.test.cmd}\``);
  lines.push(`**Status**: ${testResult.failed} failed / ${testResult.passed + testResult.failed} total\n`);
  lines.push('---\n');

  // Phase 1
  const rootPhase = priority.phases?.find(p => p.name === 'rootCauses');
  lines.push('### Phase 1: Root Causes\n');
  lines.push('| Priority | Source File | Dependents | Failing Tests |');
  lines.push('|:---:|--------|:---:|:---:|');

  for (const [i, item] of (rootPhase?.items || []).entries()) {
    lines.push(`| ${i + 1} | \`${item.file}\` | ${item.dependents} | ${item.failingTests?.length || 0} |`);
  }

  lines.push('\n---\n');

  // Phase 2
  lines.push('### Phase 2: Independent (parallel)\n');
  const indepPhase = priority.phases?.find(p => p.name === 'independent');
  lines.push(`${indepPhase?.batches?.length || 0} batches available for parallel execution\n`);

  lines.push('---\n');

  // High frequency failures
  lines.push('### High Frequency Failures\n');
  lines.push('| Test File | Failures | Main Error |');
  lines.push('|----------|:---:|----------|');

  const sorted = [...errorsByFile.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10);

  for (const [file, info] of sorted) {
    const mainType = Object.entries(info.types)
      .sort((a, b) => b[1] - a[1])[0]?.[0] || 'Unknown';
    lines.push(`| \`${file.slice(0, 60)}\` | **${info.count}** | ${mainType} |`);
  }

  const md = lines.join('\n');

  if (args.output) {
    const { promises: fs } = await import('fs');
    await fs.writeFile(args.output, md);
    console.log(`Wrote: ${args.output}`);
  } else if (args.json) {
    console.log(JSON.stringify({ markdown: md, priority, errorsByFile: Object.fromEntries(errorsByFile) }, null, 2));
  } else {
    console.log(md);
  }
}
