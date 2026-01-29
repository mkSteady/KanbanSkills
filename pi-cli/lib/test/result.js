/**
 * Test result utilities - collect/parse/analyze test execution results
 *
 * Focus: Vitest/Jest JSON output (report file or stdout JSON blob)
 *
 * Public API:
 * - collectResults(ctx, args)
 * - parseTestOutput(output, framework)
 * - analyzeErrors(errors)
 * - getResultSummary(ctx, args)
 */

import { promises as fs } from 'fs';
import path from 'path';
import { getCachePath } from '../context.js';
import { readJsonSafe, runCommand, truncate, writeJsonSafe } from '../shared.js';

/** @typedef {import('../types.js').ProjectConfig} ProjectConfig */

const RESULT_FILE = '.test-result.json';
const REPORT_FILE = '.test-report.json';

/**
 * Run tests and collect results (Vitest/Jest JSON supported).
 *
 * Notes:
 * - Uses config.test.cmd by default.
 * - Attempts to force JSON output via reporter flags, writing a report file to cache dir.
 * - Falls back to parsing stdout/stderr when report file is missing/unparseable.
 *
 * @param {{root: string, config: ProjectConfig}} ctx
 * @param {any} args
 * @returns {Promise<any>}
 */
export async function collectResults(ctx, args = {}) {
  const { root, config } = ctx;

  const framework = String(args.framework || config?.test?.framework || 'unknown').toLowerCase();
  const testCmd = String(args.cmd || config?.test?.cmd || '');

  if (!testCmd) {
    console.error('No test command configured. Set test.cmd in .pi-config.json');
    process.exitCode = 1;
    return null;
  }

  const [cmd, ...cmdArgs] = testCmd.split(/\s+/);

  const reportPath = getCachePath(config, root, REPORT_FILE);
  const resultPath = getCachePath(config, root, RESULT_FILE);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });

  const reporterArgs = getReporterArgs(framework, reportPath);

  // CLI positional args are: [command, subcommand, ...files]
  const files = Array.isArray(args._) ? args._.slice(2) : [];
  const allArgs = [...cmdArgs, ...reporterArgs, ...files];

  console.error(`Running: ${cmd} ${allArgs.join(' ')}`);

  const startedAt = Date.now();
  const exec = await runCommand(cmd, allArgs, { cwd: root });
  const duration = Date.now() - startedAt;

  // Prefer report file; fall back to stdout/stderr parsing.
  const report = await readJsonSafe(reportPath, null);
  const output = `${exec.stdout || ''}\n${exec.stderr || ''}`.trim();

  const parsed = report
    ? parseTestOutput(report, framework)
    : parseTestOutput(output, framework);

  const errors = (parsed.errors || []).map(e => normalizeError(e, root));

  const result = {
    framework,
    total: parsed.total ?? (parsed.passed || 0) + (parsed.failed || 0) + (parsed.skipped || 0),
    passed: parsed.passed || 0,
    failed: parsed.failed || 0,
    skipped: parsed.skipped || 0,
    duration,
    timestamp: new Date().toISOString(),
    errors,
    analysis: analyzeErrors(errors),
    // Keep a small tail for debugging when JSON parsing fails.
    rawOutput: parsed.parseMode === 'text-fallback' ? truncate(output, 3000) : undefined,
    parseMode: parsed.parseMode || (report ? 'report-file' : 'stdout')
  };

  await writeJsonSafe(resultPath, result);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatSummary(result));
  }

  // Non-zero exit indicates failures, but we still cache structured results.
  if (exec.code !== 0 && result.failed === 0 && result.errors.length === 0) {
    process.exitCode = exec.code;
  }

  return result;
}

/**
 * Parse test output to structured result.
 *
 * Supports:
 * - vitest: reporter=json output (stdout JSON blob or report JSON)
 * - jest: --json output (stdout JSON blob or outputFile JSON)
 *
 * @param {any} output - string output or parsed JSON object
 * @param {string} framework
 * @returns {{total?: number, passed?: number, failed?: number, skipped?: number, errors: any[], parseMode?: string}}
 */
export function parseTestOutput(output, framework) {
  const fw = String(framework || '').toLowerCase();

  if (fw !== 'vitest' && fw !== 'jest') {
    // Still try to parse as Jest-like JSON (Vitest uses a very similar shape).
    const report = coerceJsonReport(output);
    if (report) return parseJestLikeReport(report);
    return parseTextFallback(String(output || ''));
  }

  const report = coerceJsonReport(output);
  if (!report) return parseTextFallback(String(output || ''));

  return parseJestLikeReport(report);
}

/**
 * Analyze error patterns.
 * - Group by error type (TypeError, ReferenceError, SyntaxError, AssertionError, ...)
 * - Detect common patterns (import failures, mock issues, env issues, timeouts, ...)
 *
 * @param {any[]} errors
 * @returns {{total: number, byType: Record<string, number>, patterns: Record<string, number>}}
 */
export function analyzeErrors(errors = []) {
  const list = Array.isArray(errors) ? errors : [];

  /** @type {Record<string, number>} */
  const byType = {};
  /** @type {Record<string, number>} */
  const patterns = {};

  for (const err of list) {
    const msg = String(err?.message || '');
    const stk = String(err?.stack || '');

    const type = extractErrorType(msg, stk);
    byType[type] = (byType[type] || 0) + 1;

    for (const p of detectPatterns(msg, stk)) {
      patterns[p] = (patterns[p] || 0) + 1;
    }
  }

  return {
    total: list.length,
    byType: sortCountMap(byType),
    patterns: sortCountMap(patterns)
  };
}

/**
 * Read cached .test-result.json and print a summary (human or JSON).
 *
 * @param {{root: string, config: ProjectConfig}} ctx
 * @param {any} args
 * @returns {Promise<any>}
 */
export async function getResultSummary(ctx, args = {}) {
  const { root, config } = ctx;
  const resultPath = getCachePath(config, root, RESULT_FILE);
  const cached = await readJsonSafe(resultPath, null);

  if (!cached) {
    console.error('No cached test results. Run tests and collect results first.');
    process.exitCode = 1;
    return null;
  }

  const errors = Array.isArray(cached.errors) ? cached.errors : [];
  const analysis = cached.analysis || analyzeErrors(errors);

  const summary = {
    framework: cached.framework,
    total: cached.total ?? (cached.passed || 0) + (cached.failed || 0) + (cached.skipped || 0),
    passed: cached.passed || 0,
    failed: cached.failed || 0,
    skipped: cached.skipped || 0,
    duration: cached.duration || 0,
    timestamp: cached.timestamp,
    errorCount: errors.length,
    analysis
  };

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(formatSummary(summary));
    const topTypes = Object.entries(summary.analysis.byType || {}).slice(0, 3);
    const topPatterns = Object.entries(summary.analysis.patterns || {}).slice(0, 3);

    if (topTypes.length) {
      console.log('\nTop error types:');
      for (const [t, n] of topTypes) console.log(`  ${t}: ${n}`);
    }
    if (topPatterns.length) {
      console.log('\nCommon patterns:');
      for (const [p, n] of topPatterns) console.log(`  ${p}: ${n}`);
    }
  }

  return summary;
}

function getReporterArgs(framework, reportPath) {
  switch (String(framework || '').toLowerCase()) {
    case 'vitest':
      return ['--reporter=json', `--outputFile=${reportPath}`];
    case 'jest':
      return ['--json', `--outputFile=${reportPath}`];
    default:
      return [];
  }
}

function coerceJsonReport(output) {
  if (!output) return null;

  if (typeof output === 'object') return output;

  const text = String(output).trim();
  if (!text) return null;

  // 1) Direct JSON
  try {
    return JSON.parse(text);
  } catch {
    // continue
  }

  // 2) Extract a JSON blob that looks like a Jest/Vitest report
  const jsonMatch = text.match(/\{[\s\S]*"testResults"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      // continue
    }
  }

  return null;
}

function parseJestLikeReport(report) {
  const errors = [];

  let passed = report.numPassedTests ?? 0;
  let failed = report.numFailedTests ?? 0;
  let skipped = (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0);
  let total = report.numTotalTests ?? 0;

  // If counts are missing, derive them from assertionResults.
  if (!total && Array.isArray(report.testResults)) {
    passed = 0;
    failed = 0;
    skipped = 0;

    for (const file of report.testResults) {
      for (const t of file?.assertionResults || []) {
        const st = String(t?.status || '').toLowerCase();
        if (st === 'passed') passed++;
        else if (st === 'failed') failed++;
        else if (st === 'pending' || st === 'skipped' || st === 'skip' || st === 'todo') skipped++;
      }
    }
    total = passed + failed + skipped;
  }

  for (const file of report.testResults || []) {
    const fileName = file?.name || '';
    const assertionResults = Array.isArray(file?.assertionResults) ? file.assertionResults : [];

    // Suite-level failure (no individual tests recorded).
    if (file?.status === 'failed' && assertionResults.length === 0) {
      const suiteMsg = String(file?.message || file?.failureMessage || '').trim();
      if (suiteMsg) {
        errors.push({
          testFile: fileName,
          test: '(suite)',
          message: firstLine(suiteMsg),
          stack: suiteMsg
        });
      }
      continue;
    }

    for (const t of assertionResults) {
      const status = String(t?.status || '').toLowerCase();
      if (status !== 'failed') continue;

      const title = t?.fullName || t?.title || '';
      const ancestorTitles = Array.isArray(t?.ancestorTitles) ? t.ancestorTitles : [];
      const testName = title || (ancestorTitles.length ? `${ancestorTitles.join(' > ')} > (unknown)` : '(unknown)');

      const failureMessages = Array.isArray(t?.failureMessages) ? t.failureMessages : [];
      const raw = failureMessages.filter(Boolean).join('\n').trim();

      errors.push({
        testFile: fileName,
        test: testName,
        message: firstLine(raw || String(file?.message || 'Test failed')),
        stack: raw || String(file?.message || '')
      });
    }
  }

  return {
    total,
    passed,
    failed,
    skipped,
    errors,
    parseMode: 'json'
  };
}

function parseTextFallback(text) {
  const output = String(text || '');

  const failedMatch = output.match(/(\d+)\s+failed\b/i);
  const passedMatch = output.match(/(\d+)\s+passed\b/i);
  const skippedMatch = output.match(/(\d+)\s+skipped\b/i);

  const passed = passedMatch ? parseInt(passedMatch[1], 10) : 0;
  const failed = failedMatch ? parseInt(failedMatch[1], 10) : 0;
  const skipped = skippedMatch ? parseInt(skippedMatch[1], 10) : 0;

  return {
    total: passed + failed + skipped,
    passed,
    failed,
    skipped,
    errors: [],
    parseMode: 'text-fallback'
  };
}

function normalizeError(err, root) {
  const testFile = normalizeTestFile(err?.testFile, root);
  const test = String(err?.test || '(unknown)');
  const message = String(err?.message || 'Unknown error').slice(0, 2000);
  const stack = String(err?.stack || '').slice(0, 8000);

  return { testFile, test, message, stack };
}

function normalizeTestFile(testFile, root) {
  const tf = String(testFile || '');
  if (!tf) return tf;

  // Preserve already-relative paths. Convert absolute paths under root to relative.
  const abs = path.isAbsolute(tf) ? tf : path.join(root, tf);
  const rel = path.relative(root, abs);
  const relPosix = rel.replace(/\\/g, '/');

  // If file is outside the project root, keep original (but normalize slashes).
  if (!relPosix || relPosix.startsWith('..')) return tf.replace(/\\/g, '/');
  return relPosix;
}

function extractErrorType(message, stack) {
  const haystack = `${message}\n${stack}`.trim();

  const match = haystack.match(/\b(TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError|AggregateError|AssertionError)\b/);
  if (match) return match[1];

  // Common Jest/Vitest assertion outputs without explicit "AssertionError"
  if (/\bexpect\(.+\)\./i.test(haystack) || /\btoBe\b|\btoEqual\b|\btoMatch\b/i.test(haystack)) {
    return 'AssertionError';
  }

  if (/\bError\b/.test(haystack)) return 'Error';
  return 'Unknown';
}

function detectPatterns(message, stack) {
  const haystack = `${message}\n${stack}`.toLowerCase();
  /** @type {string[]} */
  const found = [];

  // Import / resolution failures
  if (
    haystack.includes('cannot find module') ||
    haystack.includes('cannot resolve') ||
    haystack.includes('failed to resolve import') ||
    haystack.includes('err_module_not_found') ||
    haystack.includes('module not found') ||
    haystack.includes('cannot find package')
  ) {
    found.push('import_failure');
  }

  // Mocking-related failures
  if (
    haystack.includes('jest.mock') ||
    haystack.includes('vi.mock') ||
    haystack.includes('mockimplementation') ||
    haystack.includes('is not a mock function') ||
    haystack.includes('cannot spyon') ||
    /\bmock\b/.test(haystack)
  ) {
    found.push('mock_issue');
  }

  // Environment (jsdom/node) mismatch
  if (
    haystack.includes('window is not defined') ||
    haystack.includes('document is not defined') ||
    haystack.includes('localstorage is not defined')
  ) {
    found.push('env_missing_globals');
  }

  // Timeouts
  if (haystack.includes('exceeded timeout') || haystack.includes('timeout') || haystack.includes('timed out')) {
    found.push('timeout');
  }

  if (found.length === 0) found.push('other');
  return found;
}

function sortCountMap(map) {
  return Object.fromEntries(
    Object.entries(map).sort((a, b) => b[1] - a[1])
  );
}

function firstLine(text) {
  const s = String(text || '').trim();
  const idx = s.indexOf('\n');
  return (idx === -1 ? s : s.slice(0, idx)).trim();
}

function formatSummary(result) {
  const total = result.total ?? (result.passed || 0) + (result.failed || 0) + (result.skipped || 0);
  const status = (result.failed || 0) > 0 ? 'FAIL' : 'PASS';
  return `${status}: ${result.passed || 0}/${total} passed, ${result.failed || 0} failed, ${result.skipped || 0} skipped`;
}

