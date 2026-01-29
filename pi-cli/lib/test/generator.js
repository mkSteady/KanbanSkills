/**
 * Test generator - Generate test files from source using LLM
 * Includes scaffold generation and AI prompt building
 */

import { promises as fs } from 'fs';
import path from 'path';
import { getDirectoryRule, matchesIgnoreInclude, matchesPattern, parallelMap, readJsonSafe, writeJsonSafe } from '../shared.js';
import { getCachePath, loadStaleConfig } from '../context.js';

/** @typedef {import('../types.js').ProjectConfig} ProjectConfig */

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'tests', '__tests__']);

/**
 * Generate test files for untested/stale source files
 * @param {{root: string, config: ProjectConfig}} ctx
 * @param {object} args
 */
export async function generateTests(ctx, args) {
  const { root, config } = ctx;
  const staleConfig = ctx.staleConfig || await loadStaleConfig(root, config);
  const ignore = staleConfig?.ignore || [];
  const include = staleConfig?.include || [];
  const ctxWithStale = ctx.staleConfig ? ctx : { ...ctx, staleConfig };

  // Get test status first
  const statusPath = getCachePath(config, root, '.test-status.json');
  let status = await readJsonSafe(statusPath);

  if (!status) {
    status = await analyzeTestStatus(ctxWithStale, args);
  }

  // Filter files based on mode
  let targets = [];
  if (args.untested || (!args.stale && !args.all)) {
    targets = status.files?.filter(f => f.status === 'untested') || [];
  }
  if (args.stale || args.all) {
    const staleFiles = status.files?.filter(f => f.status === 'stale') || [];
    targets = targets.concat(staleFiles);
  }

  // Apply path filter if provided (skip command/subcommand in args._)
  const filterPattern = args.filter || (args._.length > 2 ? args._[2] : null);
  if (filterPattern) {
    targets = targets.filter(t => t.source.includes(filterPattern));
  }

  // Apply global ignore/include filter (covers cached status)
  targets = targets.filter(t => matchesIgnoreInclude(t.source, ignore, include));

  if (targets.length === 0) {
    console.log('No files need test generation.');
    return;
  }

  console.log(`Found ${targets.length} files for test generation`);

  if (args.dryRun || args['dry-run']) {
    for (const t of targets.slice(0, 20)) {
      console.log(`  ${t.status}: ${t.source} -> ${t.expectedTest}`);
    }
    if (targets.length > 20) console.log(`  ... +${targets.length - 20} more`);
    return;
  }

  // Load dependency graph for mock info
  const graphPath = getCachePath(config, root, '.dep-graph.json');
  const graph = await readJsonSafe(graphPath);
  if (graph) {
    console.log(`Loaded dep graph (${Object.keys(graph.files || {}).length} files)`);
  }

  const concurrency = args.concurrency || 3;

  const results = await parallelMap(targets, async (target, idx) => {
    try {
      // Extract dependency info for this specific file
      const depInfo = graph?.files?.[target.source] || null;
      const result = await generateSingleTest(target, ctxWithStale, args, depInfo);
      console.log(`[${idx + 1}/${targets.length}] ${result.success ? '✓' : '✗'} ${target.source}`);
      return result;
    } catch (err) {
      console.error(`[${idx + 1}/${targets.length}] ✗ ${target.source}: ${err.message}`);
      return { source: target.source, success: false, error: err.message };
    }
  }, concurrency);

  const succeeded = results.filter(r => r.success).length;
  console.log(`\nGenerated: ${succeeded}/${results.length}`);

  // Save results
  const resultPath = getCachePath(config, root, '.test-generator-result.json');
  await writeJsonSafe(resultPath, {
    timestamp: new Date().toISOString(),
    results,
    summary: { succeeded, failed: results.length - succeeded }
  });
}

/**
 * Generate test for single source file
 * @param {{source: string, expectedTest: string, actualTest?: string}} target
 * @param {{root: string, config: ProjectConfig}} ctx
 * @param {object} args
 * @param {object} [depInfo] - Dependency info from graph
 */
async function generateSingleTest(target, ctx, args, depInfo = null) {
  const { root, config } = ctx;
  const { source, expectedTest, actualTest } = target;
  const staleConfig = ctx.staleConfig || await loadStaleConfig(root, config);
  const directoryRule = getDirectoryRule(source, staleConfig?.directoryRules);

  // Read source file
  const sourcePath = path.join(root, source);
  let sourceContent;
  try {
    sourceContent = await fs.readFile(sourcePath, 'utf8');
  } catch {
    return { source, success: false, error: 'Cannot read source file' };
  }

  // Read existing test if updating (stale)
  let existingTest = '';
  if (actualTest) {
    try {
      existingTest = await fs.readFile(path.join(root, actualTest), 'utf8');
    } catch {
      // No existing test
    }
  }

  // Extract exports
  const exports = extractExports(sourceContent, config.language);

  // Build prompt with dependency info
  const prompt = buildTestPrompt(source, sourceContent, exports, config, {
    depInfo,
    existingTest,
    isUpdate: !!actualTest,
    staleConfig,
    directoryRule
  });

  // Call LLM using batch module
  const { runBatch } = await import('../llm/batch.js');
  const results = await runBatch([{ id: source, prompt }], {
    config,
    workdir: root,
    concurrency: 1,
    maxRetries: 2
  });

  const result = results[0];
  if (!result?.success || !result?.output) {
    return { source, success: false, error: result?.error || 'LLM returned empty response' };
  }

  // Extract code from response
  const code = extractCode(result.output);
  if (!code) {
    return { source, success: false, error: 'No code in LLM response' };
  }

  // Write test file
  const testPath = path.join(root, expectedTest);
  await fs.mkdir(path.dirname(testPath), { recursive: true });
  await fs.writeFile(testPath, code);

  return { source, success: true, testPath: expectedTest };
}

/**
 * Extract exports from source code
 * @param {string} content
 * @param {string} language
 * @returns {string[]}
 */
function extractExports(content, language) {
  const exports = [];

  if (language === 'javascript' || language === 'typescript') {
    // Named exports
    const namedRe = /export\s+(function|const|let|var|class|async\s+function)\s+(\w+)/g;
    let m;
    while ((m = namedRe.exec(content))) exports.push(m[2]);

    // Re-exports
    const reexportRe = /export\s*\{\s*([^}]+)\s*\}/g;
    while ((m = reexportRe.exec(content))) {
      m[1].split(',').forEach(s => {
        const asMatch = s.trim().match(/(\w+)\s+as\s+(\w+)/);
        exports.push(asMatch ? asMatch[2] : s.trim());
      });
    }

    // Default
    if (/export\s+default/.test(content)) exports.push('default');
  } else if (language === 'python') {
    // def/class at module level
    const defRe = /^(def|class)\s+(\w+)/gm;
    let m;
    while ((m = defRe.exec(content))) exports.push(m[2]);
  }

  return [...new Set(exports)].filter(Boolean);
}

/**
 * Build test generation prompt
 * @param {string} source
 * @param {string} content
 * @param {string[]} exports
 * @param {ProjectConfig} config
 * @param {object} [extra]
 * @param {object} [extra.depInfo] - Dependency info { imports, importedBy }
 * @param {string} [extra.existingTest] - Existing test content (for updates)
 * @param {boolean} [extra.isUpdate] - Whether updating existing test
 * @returns {string}
 */
function buildTestPrompt(source, content, exports, config, extra = {}) {
  const framework = config.test?.framework || 'vitest';
  const naming = config.conventions?.testNaming || '{name}.test.js';
  const { depInfo, existingTest, isUpdate, staleConfig, directoryRule } = extra;

  const lines = [];

  // Header
  if (isUpdate) {
    lines.push(`Update the existing test file for the following source file.`);
    lines.push(`The source has changed and tests may need updating.`);
  } else {
    lines.push(`Generate a comprehensive test file for the following source file.`);
  }
  lines.push('');

  // Metadata
  lines.push(`## Source File: ${source}`);
  lines.push(`## Exports: ${exports.join(', ') || 'default export only'}`);
  lines.push(`## Test Framework: ${framework}`);
  lines.push(`## Test Naming: ${naming}`);
  lines.push('');

  const testing = staleConfig?.testing || {};
  const coverage = testing.coverage || {};
  const coverageFocus = Array.isArray(coverage.focus) ? coverage.focus : [];
  const qualityRules = Array.isArray(testing.qualityRules) ? testing.qualityRules : [];
  const antiPatterns = Array.isArray(testing.antiPatterns) ? testing.antiPatterns : [];
  const boundaryConditions = Array.isArray(testing.boundaryConditions) ? testing.boundaryConditions : [];
  const mustTest = Array.isArray(testing.mustTest) ? testing.mustTest : [];
  const directoryTestFocus = Array.isArray(directoryRule?.rule?.testFocus) ? directoryRule.rule.testFocus : [];

  if (
    Number.isFinite(coverage.target) ||
    Number.isFinite(coverage.minimum) ||
    coverageFocus.length > 0 ||
    qualityRules.length > 0 ||
    antiPatterns.length > 0 ||
    boundaryConditions.length > 0 ||
    mustTest.length > 0 ||
    directoryTestFocus.length > 0
  ) {
    lines.push(`## Testing Policy (.stale-config.json)`);
    if (Number.isFinite(coverage.target) || Number.isFinite(coverage.minimum) || coverageFocus.length > 0) {
      const target = Number.isFinite(coverage.target) ? `${coverage.target}%` : 'n/a';
      const minimum = Number.isFinite(coverage.minimum) ? `${coverage.minimum}%` : 'n/a';
      lines.push(`- Coverage: target ${target}, minimum ${minimum}`);
      if (coverageFocus.length > 0) {
        lines.push(`- Coverage focus:`);
        for (const item of coverageFocus) lines.push(`  - ${item}`);
      }
    }
    if (directoryTestFocus.length > 0) {
      lines.push(`- Directory test focus:`);
      for (const item of directoryTestFocus) lines.push(`  - ${item}`);
    }
    if (qualityRules.length > 0) {
      lines.push(`- Quality rules:`);
      for (const item of qualityRules) lines.push(`  - ${item}`);
    }
    if (antiPatterns.length > 0) {
      lines.push(`- Avoid anti-patterns:`);
      for (const item of antiPatterns) lines.push(`  - ${item}`);
    }
    if (boundaryConditions.length > 0) {
      lines.push(`- Include boundary conditions:`);
      for (const item of boundaryConditions) lines.push(`  - ${item}`);
    }
    if (mustTest.length > 0) {
      lines.push(`- Must cover:`);
      for (const item of mustTest) lines.push(`  - ${item}`);
    }
    lines.push('');
  }

  // Dependency info - crucial for knowing what to mock
  if (depInfo) {
    if (depInfo.imports?.length > 0) {
      lines.push(`## Dependencies (imports) - MUST mock these:`);
      for (const imp of depInfo.imports.slice(0, 15)) {
        lines.push(`- \`${imp}\``);
      }
      if (depInfo.imports.length > 15) {
        lines.push(`- ... +${depInfo.imports.length - 15} more`);
      }
      lines.push('');
    }

    if (depInfo.importedBy?.length > 0) {
      lines.push(`## Dependents (${depInfo.importedBy.length} files depend on this)`);
      lines.push(`This is a core module - test thoroughly.`);
      lines.push('');
    }
  }

  // Source code
  lines.push(`## Source Code`);
  lines.push('```' + config.language);
  lines.push(content.slice(0, 6000));
  lines.push('```');
  lines.push('');

  // Existing test (for updates)
  if (existingTest && isUpdate) {
    lines.push(`## Existing Test (update this)`);
    lines.push('```' + config.language);
    lines.push(existingTest.slice(0, 4000));
    lines.push('```');
    lines.push('');
  }

  // Requirements
  lines.push(`## Requirements`);
  lines.push(`1. Import all exports from the source file`);
  lines.push(`2. Test each exported function/class`);
  lines.push(`3. Include edge cases and error cases`);
  lines.push(`4. Use descriptive test names`);

  if (depInfo?.imports?.length > 0) {
    lines.push(`5. Mock ALL imports listed above using vi.mock() or equivalent`);
    lines.push(`6. Never import real implementations of dependencies`);
  } else {
    lines.push(`5. Mock any external dependencies`);
  }

  if (isUpdate) {
    lines.push(`7. Preserve working tests, only fix/update what's needed`);
  }

  lines.push('');
  lines.push(`Output the complete test file wrapped in a code block.`);

  return lines.join('\n');
}

/**
 * Extract code from LLM response
 * @param {string} response
 * @returns {string|null}
 */
function extractCode(response) {
  const match = response.match(/```(?:\w+)?\n([\s\S]*?)```/);
  return match ? match[1].trim() : null;
}

/**
 * Analyze test status (coverage analysis)
 * @param {{root: string, config: ProjectConfig}} ctx
 * @param {object} args
 */
export async function analyzeTestStatus(ctx, args) {
  const { root, config } = ctx;
  const staleConfig = ctx.staleConfig || await loadStaleConfig(root, config);
  const ignore = staleConfig?.ignore || [];
  const include = staleConfig?.include || [];

  // Scan source files
  const sources = await scanSourceFiles(root, config, ignore, include);

  // Scan test files
  const tests = await scanTestFiles(root, config, ignore, include);

  // Build status
  const files = [];

  for (const source of sources) {
    const expectedTest = sourceToTestPath(source, config);
    const actualTest = tests.find(t => t.includes(path.parse(source).name));

    let status = 'untested';
    if (actualTest) {
      const srcStat = await fs.stat(path.join(root, source)).catch(() => null);
      const testStat = await fs.stat(path.join(root, actualTest)).catch(() => null);

      if (srcStat && testStat) {
        status = srcStat.mtimeMs > testStat.mtimeMs ? 'stale' : 'covered';
      } else {
        status = 'covered';
      }
    }

    files.push({ source, expectedTest, actualTest, status });
  }

  const result = {
    timestamp: new Date().toISOString(),
    files,
    summary: {
      total: files.length,
      covered: files.filter(f => f.status === 'covered').length,
      untested: files.filter(f => f.status === 'untested').length,
      stale: files.filter(f => f.status === 'stale').length
    }
  };

  // Save
  const statusPath = getCachePath(config, root, '.test-status.json');
  await writeJsonSafe(statusPath, result);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Test Status: ${result.summary.covered} covered, ${result.summary.untested} untested, ${result.summary.stale} stale`);
  }

  return result;
}

/**
 * Scan source files
 */
async function scanSourceFiles(root, config, ignore, include) {
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
        const dirRel = path.relative(root, path.join(dir, entry.name)).replace(/\\/g, '/') || '.';
        if (!matchesIgnoreInclude(dirRel, ignore, [])) continue;
        await walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const rel = path.relative(root, path.join(dir, entry.name)).replace(/\\/g, '/');
        if (!matchesIgnoreInclude(rel, ignore, include)) continue;
        if (matchesPattern(config.src.pattern, rel)) {
          if (!rel.includes('.test.') && !rel.includes('.spec.')) {
            files.push(rel);
          }
        }
      }
    }
  }

  for (const srcDir of config.src.dirs) {
    await walk(path.join(root, srcDir));
  }

  return files;
}

/**
 * Scan test files
 */
async function scanTestFiles(root, config, ignore, include) {
  const files = [];

  // Transform include patterns for test directories
  // e.g., js/agents/** -> tests/unit/agents/** and tests/integration/agents/**
  const testInclude = transformIncludeForTests(include, config);

  // Filter out test directory patterns from ignore list
  // (ignore is meant for source files, not test files)
  const testIgnore = (ignore || []).filter(pattern => {
    const p = String(pattern || '');
    // Remove patterns that would block test directories
    return !p.startsWith('tests/') && !p.startsWith('test/') &&
           !p.includes('*.test.') && !p.includes('*.spec.');
  });

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
        const dirRel = path.relative(root, path.join(dir, entry.name)).replace(/\\/g, '/') || '.';
        if (!matchesIgnoreInclude(dirRel, testIgnore, [])) continue;
        await walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const rel = path.relative(root, path.join(dir, entry.name)).replace(/\\/g, '/');
        if (!matchesIgnoreInclude(rel, testIgnore, testInclude)) continue;
        if (matchesPattern(config.test.pattern, rel)) {
          files.push(rel);
        }
      }
    }
  }

  for (const testDir of config.test.dirs) {
    await walk(path.join(root, testDir));
  }

  return files;
}

/**
 * Transform include patterns for test directories
 * js/agents/** -> tests/unit/agents/**, tests/integration/agents/**
 */
function transformIncludeForTests(include, config) {
  if (!include || include.length === 0) return [];

  const testPatterns = [];
  const srcDirs = config.src?.dirs || ['js', 'src'];
  const testDirs = config.test?.dirs || ['tests'];
  const unitDir = config.test?.unitDir || 'tests/unit';
  const integrationDir = config.test?.integrationDir || 'tests/integration';

  for (const pattern of include) {
    for (const srcDir of srcDirs) {
      if (pattern.startsWith(srcDir + '/')) {
        const suffix = pattern.slice(srcDir.length + 1);
        // Add both unit and integration test patterns
        testPatterns.push(`${unitDir}/${suffix}`);
        testPatterns.push(`${integrationDir}/${suffix}`);
        // Also add generic test dir pattern
        for (const testDir of testDirs) {
          testPatterns.push(`${testDir}/${suffix}`);
        }
      }
    }
  }

  // If no transformations, use original (for backward compat)
  return testPatterns.length > 0 ? testPatterns : include;
}

/**
 * Convert source path to test path
 */
function sourceToTestPath(source, config) {
  const naming = config.conventions?.testNaming || '{name}.test.js';
  const parsed = path.parse(source);

  // Remove src prefix
  let rel = source;
  for (const srcDir of config.src.dirs) {
    if (source.startsWith(srcDir)) {
      rel = source.slice(srcDir.length + 1);
      break;
    }
  }

  // Use unitDir if configured, otherwise fall back to tests/unit or tests
  let testDir = config.test.dirs[0] || 'tests';
  if (config.test.unitDir) {
    testDir = config.test.unitDir;
  } else if (testDir === 'tests') {
    // Auto-detect: check if tests/unit exists in common patterns
    testDir = 'tests/unit';
  }

  const testName = naming.replace('{name}', parsed.name);

  return path.join(testDir, path.dirname(rel), testName).replace(/\\/g, '/');
}

/**
 * Generate scaffold prompt (AI-friendly output)
 * @param {{root: string, config: ProjectConfig}} ctx
 * @param {object} args
 */
export async function generateScaffold(ctx, args) {
  const status = await analyzeTestStatus(ctx, { json: false });

  const missing = status.files.filter(f => f.status === 'untested');
  const stale = status.files.filter(f => f.status === 'stale');

  const lines = [];
  lines.push('<test-scaffold>');
  lines.push('');
  lines.push('## Summary');
  lines.push(`- Total sources: ${status.summary.total}`);
  lines.push(`- Covered: ${status.summary.covered}`);
  lines.push(`- Untested: ${status.summary.untested}`);
  lines.push(`- Stale: ${status.summary.stale}`);
  lines.push('');

  if (missing.length > 0) {
    lines.push('## Missing Tests');
    for (const m of missing.slice(0, 15)) {
      lines.push(`- \`${m.source}\` -> \`${m.expectedTest}\``);
    }
    if (missing.length > 15) lines.push(`- ... +${missing.length - 15} more`);
    lines.push('');
  }

  if (stale.length > 0) {
    lines.push('## Stale Tests (source newer)');
    for (const s of stale.slice(0, 10)) {
      lines.push(`- \`${s.source}\` -> \`${s.actualTest}\``);
    }
    if (stale.length > 10) lines.push(`- ... +${stale.length - 10} more`);
  }

  lines.push('</test-scaffold>');

  console.log(lines.join('\n'));
}
