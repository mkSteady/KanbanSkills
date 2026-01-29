/**
 * Test fixer - uses LLM to fix failing tests
 * Integrates with batch LLM runner for parallel execution
 */

import { promises as fs } from 'fs';
import path from 'path';
import { readJsonSafe, writeJsonSafe, parallelMap } from '../shared.js';
import { getCachePath } from '../context.js';
import { runBatch } from '../llm/batch.js';

/** @typedef {import('../types.js').ProjectConfig} ProjectConfig */

/**
 * Safety prompt prefix for all LLM calls.
 * Mirrors project-index/scripts/shared.js to reduce the chance of the model doing unsafe actions.
 * @type {string}
 */
const SAFETY_PROMPT_PREFIX = `## ⛔ 严禁操作 (CRITICAL)
**绝对禁止执行以下命令：**
- git checkout / git reset / git restore / git clean / git stash drop
- rm -rf / find -delete / 任何删除文件的命令
- 任何会修改或删除用户文件的 shell 命令

**你的任务是纯分析或生成代码文本，不要执行任何 shell 命令。**

---

`;

/**
 * Fix failing tests using LLM
 * @param {{root: string, config: ProjectConfig}} ctx
 * @param {object} args
 */
export async function fixTests(ctx, args) {
  const { root, config } = ctx;

  const resultPath = getCachePath(config, root, '.test-result.json');
  const testResult = await readJsonSafe(resultPath);

  if (!testResult || testResult.errors?.length === 0) {
    console.log('No failing tests to fix.');
    return;
  }

  // Get test files to fix
  let testFiles = args._.slice(2);

  if (testFiles.length === 0) {
    // Get from test results
    const uniqueFiles = [...new Set(testResult.errors.map(e => e.testFile))];
    const limit = Math.max(1, Number(args.limit) || 10);
    testFiles = uniqueFiles.slice(0, limit);
  }

  testFiles = [...new Set(testFiles.map(f => normalizeTestFileArg(f, root)).filter(Boolean))];

  const concurrency = Math.max(1, Number(args.concurrency) || 5);
  const llmMode = Boolean(args.llm);

  console.log(`Fixing ${testFiles.length} test files (concurrency: ${concurrency}${llmMode ? ', llm: on' : ''})...`);

  // Prepare fix tasks
  const tasks = testFiles.map(testFile => ({
    testFile,
    errors: testResult.errors.filter(e => e.testFile === testFile)
  }));

  /** @type {Array<{testFile: string, success: boolean, error?: string, mode?: string}>} */
  let results = [];

  if (llmMode) {
    results = await fixWithBatchLLM(tasks, ctx, {
      ...args,
      concurrency
    });
  } else {
    // Fallback: keep the existing simple per-file LLM call.
    results = await parallelMap(tasks, async (task, idx) => {
      try {
        const result = await fixSingleTest(task, ctx, args);
        console.log(`[${idx + 1}/${tasks.length}] ${result.success ? '✓' : '✗'} ${task.testFile}`);
        return result;
      } catch (err) {
        console.error(`[${idx + 1}/${tasks.length}] ✗ ${task.testFile}: ${err.message}`);
        return { testFile: task.testFile, success: false, error: err.message };
      }
    }, concurrency);
  }

  // Summary
  const succeeded = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  console.log(`\nResults: ${succeeded} fixed, ${failed} failed`);

  // Save fix results
  const fixResultPath = getCachePath(config, root, '.test-fix-result.json');
  await writeJsonSafe(fixResultPath, {
    timestamp: new Date().toISOString(),
    mode: llmMode ? 'llm-batch' : 'simple',
    results,
    summary: { succeeded, failed, total: results.length }
  });

  return results;
}

/**
 * LLM fix mode: build a prompt per failing test file and run with lib/llm/batch.js.
 *
 * Safety:
 * - We only ever write the (single) target test file.
 * - The prompt explicitly forbids modifying implementation code or adding shim files.
 *
 * @param {{testFile: string, errors: any[]}[]} tasks
 * @param {{root: string, config: ProjectConfig}} ctx
 * @param {any} args
 * @returns {Promise<Array<{testFile: string, success: boolean, error?: string, mode?: string}>>}
 */
async function fixWithBatchLLM(tasks, ctx, args) {
  const { root, config } = ctx;
  const concurrency = args.concurrency || 5;
  const dryRun = Boolean(args.dryRun || args['dry-run']);

  const scratchDir = path.join('/tmp', 'pi-cli-test-fix');
  await fs.mkdir(scratchDir, { recursive: true });

  const historyPath = getCachePath(config, root, 'TEST_FIX_HISTORY.md');
  await ensureHistoryHeader(historyPath);

  /** @type {Array<{id: string, prompt: string, context?: any}>} */
  const llmTasks = [];

  /** @type {Map<string, {testPath: string, testContent: string, errors: any[], sourceFile?: string}>} */
  const taskContext = new Map();

  /** @type {Array<{testFile: string, success: boolean, error?: string, mode?: string}>} */
  const preResults = [];

  // Optional: best-effort map from test->src file, but do NOT include implementation content.
  const mapPath = getCachePath(config, root, '.test-map.json');
  const testMap = await readJsonSafe(mapPath, null);

  for (const task of tasks) {
    const testFile = task.testFile;

    const testPath = path.isAbsolute(testFile)
      ? testFile
      : path.join(root, testFile);

    let testContent = '';
    try {
      testContent = await fs.readFile(testPath, 'utf8');
    } catch (err) {
      preResults.push({ testFile, success: false, error: `Cannot read: ${err.message}`, mode: 'llm-batch' });
      await recordFixLog(historyPath, {
        testFile,
        ok: false,
        mode: 'llm-batch',
        provider: config?.llm?.provider,
        note: `Cannot read test file: ${err.message}`,
        errors: task.errors
      });
      taskContext.set(testFile, { testPath, testContent: '', errors: task.errors });
      continue;
    }

    const sourceFile = testMap?.testToSrc?.[testFile];

    const prompt = buildLLMFixPrompt({
      testFile,
      sourceFile,
      testContent,
      errors: task.errors,
      config
    });

    llmTasks.push({
      id: testFile,
      prompt,
      // Use scratch dir so codeagent-style providers can't modify the real repo.
      context: { workdir: scratchDir }
    });
    taskContext.set(testFile, { testPath, testContent, errors: task.errors, sourceFile });
  }

  // NOTE: runBatch() may switch to runBatchParallel() for codeagent-style providers when tasks.length > 3.
  // runBatchParallel() cannot reliably attribute a combined stdout blob back to each file, so for those
  // providers we run one task per runBatch() call (still concurrently), ensuring output->file mapping is safe.
  const provider = config?.llm?.provider || 'claude-cli';
  const isCodeagent = ['codeagent', 'codeagent-wrapper', 'codex', 'gemini'].includes(provider);

  /** @type {Array<{id: string, success: boolean, output?: string, error?: string, retries: number}>} */
  const llmResults = isCodeagent && llmTasks.length > 3
    ? await parallelMap(llmTasks, async (t) => {
      const out = await runBatch([t], { concurrency: 1, config, workdir: scratchDir });
      return out?.[0] || { id: t.id, success: false, error: 'LLM returned no result', retries: 0 };
    }, concurrency)
    : await runBatch(llmTasks, { concurrency, config, workdir: scratchDir });

  const results = [...preResults];

  for (const llmResult of llmResults) {
    const testFile = llmResult.id;
    const ctxItem = taskContext.get(testFile);

    // Should not happen, but keep it robust.
    const testPath = ctxItem?.testPath || (path.isAbsolute(testFile) ? testFile : path.join(root, testFile));
    const errors = ctxItem?.errors || [];
    const sourceFile = ctxItem?.sourceFile;

    if (!llmResult.success) {
      const error = llmResult.error || 'LLM task failed';
      results.push({ testFile, success: false, error, mode: 'llm-batch' });
      await recordFixLog(historyPath, {
        testFile,
        ok: false,
        mode: 'llm-batch',
        provider: config?.llm?.provider,
        note: error,
        errors,
        sourceFile
      });
      continue;
    }

    const output = String(llmResult.output || '');
    const code = extractCode(output);

    if (!code) {
      const error = 'No code block in LLM response';
      results.push({ testFile, success: false, error, mode: 'llm-batch' });
      await recordFixLog(historyPath, {
        testFile,
        ok: false,
        mode: 'llm-batch',
        provider: config?.llm?.provider,
        note: error,
        errors,
        sourceFile,
        llmOutputPreview: output.slice(0, 4000)
      });
      continue;
    }

    if (!dryRun) {
      await fs.writeFile(testPath, code.endsWith('\n') ? code : code + '\n');
    }

    results.push({ testFile, success: true, mode: 'llm-batch' });
    await recordFixLog(historyPath, {
      testFile,
      ok: true,
      mode: 'llm-batch',
      provider: config?.llm?.provider,
      note: 'Applied LLM-generated test fix',
      errors,
      sourceFile,
      llmOutputPreview: output.slice(0, 800)
    });
  }

  // Include any tasks that were skipped because we couldn't read them.
  for (const task of tasks) {
    if (results.some(r => r.testFile === task.testFile)) continue;
    const ctxItem = taskContext.get(task.testFile);
    const testPath = ctxItem?.testPath || (path.isAbsolute(task.testFile) ? task.testFile : path.join(root, task.testFile));
    const error = 'Skipped (unable to build LLM prompt)';
    results.push({ testFile: task.testFile, success: false, error, mode: 'llm-batch' });
    await recordFixLog(historyPath, {
      testFile: task.testFile,
      ok: false,
      mode: 'llm-batch',
      provider: config?.llm?.provider,
      note: `${error}: ${testPath}`,
      errors: task.errors
    });
  }

  // Print per-file status in the same style as simple mode.
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    console.log(`[${i + 1}/${results.length}] ${r.success ? '✓' : '✗'} ${r.testFile}`);
  }

  return results;
}

/**
 * Fix a single test file
 * @param {{testFile: string, errors: any[]}} task
 * @param {{root: string, config: ProjectConfig}} ctx
 * @param {object} args
 * @returns {Promise<{testFile: string, success: boolean, error?: string}>}
 */
async function fixSingleTest(task, ctx, args) {
  const { root, config } = ctx;
  const { testFile, errors } = task;

  // Read test file
  const testPath = path.isAbsolute(testFile)
    ? testFile
    : path.join(root, testFile);

  let testContent;
  try {
    testContent = await fs.readFile(testPath, 'utf8');
  } catch (err) {
    return { testFile, success: false, error: `Cannot read: ${err.message}` };
  }

  // Read source file if mapped
  const mapPath = getCachePath(config, root, '.test-map.json');
  const testMap = await readJsonSafe(mapPath);
  const srcFile = testMap?.testToSrc?.[testFile];

  let srcContent = '';
  if (srcFile) {
    try {
      srcContent = await fs.readFile(path.join(root, srcFile), 'utf8');
    } catch {
      // Source file not found, continue without it
    }
  }

  // Build prompt
  const prompt = buildFixPrompt(testContent, srcContent, errors, config);

  // Call LLM (placeholder - integrate with actual LLM module)
  const fixedContent = await callLLM(prompt, config);

  if (!fixedContent) {
    return { testFile, success: false, error: 'LLM returned empty response' };
  }

  // Extract code from response
  const code = extractCode(fixedContent);

  if (!code) {
    return { testFile, success: false, error: 'No code block in response' };
  }

  // Write back if not dry run
  if (!(args.dryRun || args['dry-run'])) {
    await fs.writeFile(testPath, code.endsWith('\n') ? code : code + '\n');
  }

  return { testFile, success: true };
}

/**
 * Build fix prompt
 * @param {string} testContent
 * @param {string} srcContent
 * @param {any[]} errors
 * @param {ProjectConfig} config
 * @returns {string}
 */
function buildFixPrompt(testContent, srcContent, errors, config) {
  const customPrompt = config.llm?.fixPrompt || '';

  const errorSummary = errors.slice(0, 5).map(e =>
    `- ${e.test}: ${e.message?.slice(0, 100)}`
  ).join('\n');

  return `${customPrompt}

Fix the following failing test file.

## Errors
${errorSummary}

## Test File
\`\`\`${config.language}
${testContent.slice(0, 8000)}
\`\`\`

${srcContent ? `## Source File
\`\`\`${config.language}
${srcContent.slice(0, 4000)}
\`\`\`` : ''}

Output the complete fixed test file wrapped in a code block.
`;
}

/**
 * Build LLM prompt for batch mode (args.llm).
 *
 * The LLM is explicitly constrained to:
 * - ONLY update the test file content
 * - NEVER modify implementation/source code
 * - NEVER create shim/bridge files to "make imports work"
 *
 * @param {{testFile: string, sourceFile?: string, testContent: string, errors: any[], config: ProjectConfig}} input
 * @returns {string}
 */
function buildLLMFixPrompt({ testFile, sourceFile, testContent, errors, config }) {
  const customPrompt = String(config?.llm?.fixPrompt || '').trim();

  const errorsSection = errors
    .slice(0, 10)
    .map((e, i) => {
      const header = `### Error ${i + 1}: ${String(e?.test || '(unknown)')}`;
      const msg = String(e?.message || '').slice(0, 2000);
      const stk = String(e?.stack || '').slice(0, 4000);
      return [
        header,
        'Message:',
        '```',
        msg || '(no message)',
        '```',
        stk ? ['Stack:', '```', stk, '```'].join('\n') : ''
      ].filter(Boolean).join('\n');
    })
    .join('\n\n');

  const testSnippet = String(testContent || '').slice(0, 12000);

  const sourceHint = sourceFile
    ? `- Related source file (read-only): ${sourceFile}`
    : '- Related source file: (unknown)';

  return `${SAFETY_PROMPT_PREFIX}${customPrompt ? customPrompt + '\n\n' : ''}You are fixing a failing test file.

## Task
Fix the test so it matches the CURRENT behavior of the implementation.

## Strict safety constraints (MUST follow)
- You may ONLY change the TEST FILE content.
- You MUST NOT modify any implementation/source files.
- You MUST NOT create any new shim/bridge/re-export files to satisfy imports.
- If the failure is caused by a behavior mismatch, update assertions/mocks/import paths in the test.

## Target
- Test file: ${testFile}
${sourceHint}

## Failures
${errorsSection || '(no error details)'}

## Current test file content
\`\`\`${config?.language || ''}
${testSnippet}
\`\`\`

## Output format (STRICT)
Return the COMPLETE fixed test file content wrapped in a single markdown code block. Do not include diffs or instructions.`;
}

/**
 * Call LLM API
 * @param {string} prompt
 * @param {ProjectConfig} config
 * @returns {Promise<string>}
 */
async function callLLM(prompt, config) {
  const provider = config.llm?.provider;
  const { runCommand } = await import('../shared.js');

  if (provider === 'codex') {
    // Use codex-wrapper with HEREDOC for complex prompts
    const timeout = config.llm?.timeout || 7200000;
    const result = await runCommand('codex-wrapper', ['-'], {
      cwd: process.cwd(),
      timeout,
      input: prompt
    });
    return result.stdout;
  }

  if (provider === 'claude-cli') {
    const result = await runCommand('claude', ['-p', prompt], { cwd: process.cwd() });
    return result.stdout;
  }

  if (provider === 'gemini') {
    const result = await runCommand('gemini', ['-p', prompt], { cwd: process.cwd() });
    return result.stdout;
  }

  // Default: return null to indicate no LLM available
  console.error('No LLM configured. Set llm.provider in .pi-config.json');
  return null;
}

/**
 * Extract code from LLM response
 * @param {string} response
 * @returns {string|null}
 */
function extractCode(response) {
  const text = String(response || '');

  // Prefer the largest fenced block, as some models output multiple snippets.
  const re = /```(?:[a-zA-Z0-9_-]+)?\r?\n([\s\S]*?)```/g;
  /** @type {{code: string, len: number} | null} */
  let best = null;

  for (;;) {
    const m = re.exec(text);
    if (!m) break;
    const code = String(m[1] || '').trim();
    if (!code) continue;
    if (!best || code.length > best.len) best = { code, len: code.length };
  }

  return best ? best.code : null;
}

/**
 * Ensure history file exists with a header.
 * @param {string} historyPath
 */
async function ensureHistoryHeader(historyPath) {
  try {
    await fs.mkdir(path.dirname(historyPath), { recursive: true });
    await fs.access(historyPath);
  } catch {
    await fs.writeFile(historyPath, '# Test Fix History\n');
  }
}

/**
 * Append a single entry to the fix history file.
 * @param {string} historyPath
 * @param {{testFile: string, ok: boolean, mode: string, provider?: string, note?: string, errors?: any[], sourceFile?: string, llmOutputPreview?: string}} entry
 */
async function recordFixLog(historyPath, entry) {
  const date = new Date().toISOString().split('T')[0];
  const errors = Array.isArray(entry.errors) ? entry.errors : [];
  const topErrors = errors.slice(0, 3).map(e => `- ${String(e?.test || '(unknown)')}: ${String(e?.message || '').slice(0, 120)}`).join('\n');

  const block = `
## ${date} - ${entry.testFile}

- Status: ${entry.ok ? 'FIXED' : 'FAILED'}
- Mode: ${entry.mode}
- Provider: ${entry.provider || 'unknown'}
${entry.sourceFile ? `- Related source (read-only): ${entry.sourceFile}` : ''}
${entry.note ? `- Note: ${String(entry.note).slice(0, 400)}` : ''}
${topErrors ? `\n### Errors (top)\n${topErrors}\n` : ''}
${entry.llmOutputPreview ? `\n### LLM Output (preview)\n\`\`\`\n${String(entry.llmOutputPreview).slice(0, 2000)}\n\`\`\`\n` : ''}
`;

  try {
    await fs.appendFile(historyPath, block);
  } catch (e) {
    // Don't fail the whole run due to logging issues.
    console.warn(`Failed to record fix history: ${e.message}`);
  }
}

/**
 * Normalize a test file arg for matching cached test results.
 *
 * - Convert absolute paths under root to a root-relative posix path.
 * - Keep absolute paths outside the root as-is.
 * - Normalize slashes to "/" for stable matching with cached errors.
 *
 * @param {string} testFile
 * @param {string} root
 * @returns {string}
 */
function normalizeTestFileArg(testFile, root) {
  const tf = String(testFile || '').trim();
  if (!tf) return '';

  const abs = path.isAbsolute(tf) ? tf : path.join(root, tf);
  const rel = path.relative(root, abs).replace(/\\/g, '/');
  if (rel && !rel.startsWith('..')) return rel;
  return tf.replace(/\\/g, '/');
}
