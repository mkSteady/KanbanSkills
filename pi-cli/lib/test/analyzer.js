/**
 * Test analyzer - Detect test quality issues
 * Finds pseudo tests, weak assertions, flaky patterns, etc.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { readJsonSafe, writeJsonSafe, matchesPattern } from '../shared.js';
import { getCachePath } from '../context.js';

/** @typedef {import('../types.js').ProjectConfig} ProjectConfig */

/**
 * @typedef {'pseudo' | 'weak' | 'skipped' | 'commented' | 'empty' | 'flaky'} IssueType
 */

/**
 * @typedef {object} TestIssue
 * @property {IssueType} type
 * @property {string} file
 * @property {number} line
 * @property {string} testName
 * @property {string} description
 * @property {string} [suggestion]
 */

/**
 * Issue detection patterns
 */
const PATTERNS = {
  weak: [
    { pattern: /expect\s*\(\s*true\s*\)\s*\.toBe\s*\(\s*true\s*\)/g, desc: 'expect(true).toBe(true) - meaningless' },
    { pattern: /expect\s*\(\s*false\s*\)\s*\.toBe\s*\(\s*false\s*\)/g, desc: 'expect(false).toBe(false) - meaningless' },
    { pattern: /expect\s*\([^)]+\)\s*\.toMatchObject\s*\(\s*\{\s*\}\s*\)/g, desc: 'toMatchObject({}) - empty match' },
    { pattern: /expect\s*\([^)]+\)\s*\.toBeDefined\s*\(\s*\)/g, desc: 'toBeDefined() - weak assertion' },
    { pattern: /expect\s*\([^)]+\)\s*\.toBeTruthy\s*\(\s*\)/g, desc: 'toBeTruthy() - weak assertion' }
  ],
  skipped: [
    { pattern: /(?:test|it|describe)\.skip\s*\(/g, desc: 'Skipped test' },
    { pattern: /(?:test|it|describe)\.todo\s*\(/g, desc: 'TODO test' },
    { pattern: /x(?:test|it|describe)\s*\(/g, desc: 'x-prefixed skip' }
  ],
  commented: [
    { pattern: /\/\/\s*(?:test|it|describe)\s*\(/g, desc: 'Commented test' }
  ],
  flaky: [
    { pattern: /setTimeout\s*\([^,]+,\s*\d+\s*\)/g, desc: 'setTimeout - may cause flakiness' },
    { pattern: /Date\.now\s*\(\s*\)/g, desc: 'Date.now() - time-dependent' },
    { pattern: /Math\.random\s*\(\s*\)/g, desc: 'Math.random() - non-deterministic' },
    { pattern: /new Date\s*\(\s*\)/g, desc: 'new Date() - time-dependent' }
  ]
};

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

/**
 * Analyze test quality
 * @param {{root: string, config: ProjectConfig}} ctx
 * @param {object} args
 */
export async function analyzeTests(ctx, args) {
  const { root, config } = ctx;

  // Find test files
  const testFiles = await findTestFiles(root, config);

  console.log(`Analyzing ${testFiles.length} test files...`);

  /** @type {TestIssue[]} */
  const issues = [];

  for (const file of testFiles) {
    const fileIssues = await analyzeFile(path.join(root, file), file);
    issues.push(...fileIssues);
  }

  // Group by type
  const byType = {};
  for (const issue of issues) {
    if (!byType[issue.type]) byType[issue.type] = [];
    byType[issue.type].push(issue);
  }

  const result = {
    timestamp: new Date().toISOString(),
    totalFiles: testFiles.length,
    totalIssues: issues.length,
    byType: Object.fromEntries(
      Object.entries(byType).map(([k, v]) => [k, v.length])
    ),
    issues
  };

  // Save
  const cachePath = getCachePath(config, root, '.test-analyzer-result.json');
  await writeJsonSafe(cachePath, result);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (args.summary) {
    console.log(`Test Quality Analysis:`);
    console.log(`  Files: ${result.totalFiles}`);
    console.log(`  Issues: ${result.totalIssues}`);
    for (const [type, count] of Object.entries(result.byType)) {
      console.log(`    ${type}: ${count}`);
    }
  } else {
    console.log(`Found ${issues.length} issues:\n`);
    for (const [type, items] of Object.entries(byType)) {
      console.log(`${type.toUpperCase()} (${items.length}):`);
      for (const item of items.slice(0, 5)) {
        console.log(`  ${item.file}:${item.line} - ${item.description}`);
      }
      if (items.length > 5) console.log(`  ... +${items.length - 5} more\n`);
    }

    if (args.fix) {
      console.log('\nFix Suggestions:');
      console.log('  pseudo: Add meaningful assertions');
      console.log('  weak: Replace with specific value checks');
      console.log('  skipped: Remove skip or implement test');
      console.log('  flaky: Mock time/random functions');
    }
  }

  return result;
}

/**
 * Analyze a single test file
 * @param {string} absPath
 * @param {string} relPath
 * @returns {Promise<TestIssue[]>}
 */
async function analyzeFile(absPath, relPath) {
  const issues = [];

  let content;
  try {
    content = await fs.readFile(absPath, 'utf8');
  } catch {
    return issues;
  }

  const lines = content.split('\n');

  // Check each pattern type
  for (const [type, patterns] of Object.entries(PATTERNS)) {
    for (const { pattern, desc } of patterns) {
      let match;
      const re = new RegExp(pattern.source, pattern.flags);
      while ((match = re.exec(content)) !== null) {
        const line = getLineNumber(content, match.index);
        issues.push({
          type,
          file: relPath,
          line,
          testName: extractTestName(lines[line - 1] || ''),
          description: desc
        });
      }
    }
  }

  // Check for pseudo tests (no assertions)
  const testBlocks = findTestBlocks(content);
  for (const block of testBlocks) {
    if (!hasAssertion(block.body)) {
      issues.push({
        type: 'pseudo',
        file: relPath,
        line: block.line,
        testName: block.name,
        description: 'Test has no assertions',
        suggestion: 'Add expect() or assert() calls'
      });
    }
  }

  return issues;
}

/**
 * Find test blocks in content
 */
function findTestBlocks(content) {
  const blocks = [];
  const testRe = /(?:test|it)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  let match;

  while ((match = testRe.exec(content)) !== null) {
    const startLine = getLineNumber(content, match.index);

    // Try to find the test body (simplified)
    const afterMatch = content.slice(match.index);
    const bodyMatch = afterMatch.match(/,\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/);

    if (bodyMatch) {
      const bodyStart = match.index + bodyMatch.index + bodyMatch[0].length;
      const bodyEnd = findMatchingBrace(content, bodyStart - 1);
      const body = content.slice(bodyStart, bodyEnd);

      blocks.push({
        name: match[1],
        line: startLine,
        body
      });
    }
  }

  return blocks;
}

/**
 * Find matching closing brace
 */
function findMatchingBrace(content, start) {
  let depth = 1;
  let i = start + 1;

  while (i < content.length && depth > 0) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}') depth--;
    i++;
  }

  return i;
}

/**
 * Check if block has assertions
 */
function hasAssertion(body) {
  return /expect\s*\(|assert\.|should\./.test(body);
}

/**
 * Get line number from position
 */
function getLineNumber(content, position) {
  return content.substring(0, position).split('\n').length;
}

/**
 * Extract test name from line
 */
function extractTestName(line) {
  const match = line.match(/(?:test|it|describe)\s*\(\s*['"`]([^'"`]+)['"`]/);
  return match ? match[1] : 'unknown';
}

/**
 * Find all test files
 */
async function findTestFiles(root, config) {
  const files = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        if (entry.name.includes('.test.') || entry.name.includes('.spec.')) {
          files.push(path.relative(root, path.join(dir, entry.name)).replace(/\\/g, '/'));
        }
      }
    }
  }

  for (const testDir of config.test.dirs) {
    await walk(path.join(root, testDir));
  }

  return files;
}
