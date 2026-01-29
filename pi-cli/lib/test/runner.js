/**
 * Test runner - execute tests and collect results
 * Supports multiple test frameworks
 */

import { promises as fs } from 'fs';
import path from 'path';
import { runCommand, readJsonSafe, writeJsonSafe } from '../shared.js';
import { getCachePath } from '../context.js';

/** @typedef {import('../types.js').ProjectConfig} ProjectConfig */
/** @typedef {import('../types.js').TestResult} TestResult */

/**
 * Run tests and collect results
 * @param {{root: string, config: ProjectConfig}} ctx
 * @param {object} args
 */
export async function runTests(ctx, args) {
  const { root, config } = ctx;
  const testCmd = config.test.cmd;

  if (!testCmd) {
    console.error('No test command configured. Set test.cmd in .pi-config.json');
    process.exitCode = 1;
    return;
  }

  // Build command
  const [cmd, ...cmdArgs] = testCmd.split(/\s+/);

  // Add reporter flags for JSON output if supported
  const framework = config.test.framework;
  const reporterArgs = getReporterArgs(framework, root);

  // Add file filter if provided
  const files = args._.slice(2);
  const allArgs = [...cmdArgs, ...reporterArgs, ...files];

  console.error(`Running: ${cmd} ${allArgs.join(' ')}`);

  const result = await runCommand(cmd, allArgs, { cwd: root });

  // Parse results based on framework
  const testResult = await parseTestResult(framework, result, root);

  // Save results
  const cachePath = getCachePath(config, root, '.test-result.json');
  await writeJsonSafe(cachePath, testResult);

  if (args.json) {
    console.log(JSON.stringify(testResult, null, 2));
  } else {
    console.log(`Tests: ${testResult.passed} passed, ${testResult.failed} failed, ${testResult.skipped} skipped`);
    if (testResult.errors.length > 0) {
      console.log(`\nFirst ${Math.min(5, testResult.errors.length)} errors:`);
      for (const err of testResult.errors.slice(0, 5)) {
        console.log(`  ${err.testFile}:`);
        console.log(`    ${err.test}: ${err.message.slice(0, 80)}`);
      }
    }
  }

  return testResult;
}

/**
 * Get reporter arguments for framework
 * @param {string} framework
 * @param {string} root
 * @returns {string[]}
 */
function getReporterArgs(framework, root) {
  const reportPath = path.join(root, '.project-index', '.test-report.json');

  switch (framework) {
    case 'vitest':
      return ['--reporter=json', `--outputFile=${reportPath}`];
    case 'jest':
      return ['--json', `--outputFile=${reportPath}`];
    case 'pytest':
      return [`--json-report`, `--json-report-file=${reportPath}`];
    case 'go':
      return ['-json'];
    default:
      return [];
  }
}

/**
 * Parse test results from command output or report file
 * @param {string} framework
 * @param {{code: number, stdout: string, stderr: string}} result
 * @param {string} root
 * @returns {Promise<TestResult>}
 */
async function parseTestResult(framework, result, root) {
  const reportPath = path.join(root, '.project-index', '.test-report.json');

  switch (framework) {
    case 'vitest':
      return parseVitestResult(reportPath, result);
    case 'jest':
      return parseJestResult(reportPath, result);
    case 'pytest':
      return parsePytestResult(reportPath, result);
    case 'go':
      return parseGoResult(result);
    default:
      return parseGenericResult(result);
  }
}

/**
 * Parse Vitest JSON result
 * @param {string} reportPath
 * @param {{code: number, stdout: string, stderr: string}} result
 * @returns {Promise<TestResult>}
 */
async function parseVitestResult(reportPath, result) {
  const report = await readJsonSafe(reportPath, null);

  if (!report) {
    return parseGenericResult(result);
  }

  const errors = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const file of report.testResults || []) {
    for (const test of file.assertionResults || []) {
      if (test.status === 'passed') passed++;
      else if (test.status === 'failed') {
        failed++;
        errors.push({
          testFile: file.name,
          test: test.title || test.fullName,
          message: test.failureMessages?.[0] || 'Unknown error',
          stack: test.failureMessages?.[0] || ''
        });
      } else if (test.status === 'skipped' || test.status === 'pending') {
        skipped++;
      }
    }
  }

  return {
    passed,
    failed,
    skipped,
    errors,
    duration: report.startTime ? Date.now() - report.startTime : 0
  };
}

/**
 * Parse Jest JSON result
 * @param {string} reportPath
 * @param {{code: number, stdout: string, stderr: string}} result
 * @returns {Promise<TestResult>}
 */
async function parseJestResult(reportPath, result) {
  const report = await readJsonSafe(reportPath, null);

  if (!report) {
    return parseGenericResult(result);
  }

  const errors = [];

  for (const file of report.testResults || []) {
    for (const test of file.assertionResults || []) {
      if (test.status === 'failed') {
        errors.push({
          testFile: file.name,
          test: test.fullName || test.title,
          message: test.failureMessages?.[0] || 'Unknown error',
          stack: test.failureMessages?.[0] || ''
        });
      }
    }
  }

  return {
    passed: report.numPassedTests || 0,
    failed: report.numFailedTests || 0,
    skipped: report.numPendingTests || 0,
    errors,
    duration: (report.testResults || []).reduce((sum, t) => sum + (t.endTime - t.startTime), 0)
  };
}

/**
 * Parse pytest JSON result
 * @param {string} reportPath
 * @param {{code: number, stdout: string, stderr: string}} result
 * @returns {Promise<TestResult>}
 */
async function parsePytestResult(reportPath, result) {
  const report = await readJsonSafe(reportPath, null);

  if (!report) {
    return parseGenericResult(result);
  }

  const errors = [];

  for (const test of report.tests || []) {
    if (test.outcome === 'failed') {
      errors.push({
        testFile: test.nodeid?.split('::')[0] || '',
        test: test.nodeid || '',
        message: test.call?.longrepr || 'Unknown error',
        stack: test.call?.longrepr || ''
      });
    }
  }

  return {
    passed: report.summary?.passed || 0,
    failed: report.summary?.failed || 0,
    skipped: report.summary?.skipped || 0,
    errors,
    duration: report.duration || 0
  };
}

/**
 * Parse Go test JSON output
 * @param {{code: number, stdout: string, stderr: string}} result
 * @returns {TestResult}
 */
function parseGoResult(result) {
  const lines = result.stdout.split('\n').filter(Boolean);
  const errors = [];
  let passed = 0;
  let failed = 0;

  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.Action === 'pass' && event.Test) passed++;
      else if (event.Action === 'fail' && event.Test) {
        failed++;
        errors.push({
          testFile: event.Package || '',
          test: event.Test,
          message: event.Output || 'Test failed',
          stack: ''
        });
      }
    } catch {
      // Not JSON, skip
    }
  }

  return { passed, failed, skipped: 0, errors, duration: 0 };
}

/**
 * Parse generic test output (fallback)
 * @param {{code: number, stdout: string, stderr: string}} result
 * @returns {TestResult}
 */
function parseGenericResult(result) {
  const output = result.stdout + result.stderr;

  // Try to extract pass/fail counts from common patterns
  const passMatch = output.match(/(\d+)\s*(?:passing|passed|ok)/i);
  const failMatch = output.match(/(\d+)\s*(?:failing|failed|error)/i);
  const skipMatch = output.match(/(\d+)\s*(?:skipped|pending|ignored)/i);

  return {
    passed: passMatch ? parseInt(passMatch[1], 10) : 0,
    failed: failMatch ? parseInt(failMatch[1], 10) : (result.code !== 0 ? 1 : 0),
    skipped: skipMatch ? parseInt(skipMatch[1], 10) : 0,
    errors: result.code !== 0 ? [{
      testFile: '',
      test: 'unknown',
      message: output.slice(0, 500),
      stack: ''
    }] : [],
    duration: 0
  };
}
