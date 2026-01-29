#!/usr/bin/env node
/**
 * Acceptance Gate - Module-based batch validation for git changes
 *
 * Groups changed files by module using .test-map.json, then validates
 * each module as a batch with ONE LLM request per module.
 *
 * Usage:
 *   node acceptance-gate.js [options]
 *
 * Options:
 *   --dry-run        Preview only, no commits
 *   --concurrency=N  Override concurrency (default 8)
 *   --commit         Auto-commit validated files
 *   --status         Show last result
 *   --help           Show help
 */

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { BatchRunner } from './batch-llm-runner.js';
import { loadConfig, parseArgs, SAFETY_PROMPT_PREFIX, readJsonSafe } from './shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Get modified files from git
 */
async function getGitChanges(cwd) {
  try {
    const staged = execSync('git diff --cached --name-status', {
      encoding: 'utf-8', cwd, timeout: 30000
    }).trim();

    const unstaged = execSync('git diff --name-status', {
      encoding: 'utf-8', cwd, timeout: 30000
    }).trim();

    const changes = new Map();
    for (const line of [...staged.split('\n'), ...unstaged.split('\n')]) {
      if (!line.trim()) continue;
      const [status, ...pathParts] = line.split('\t');
      const filePath = pathParts.join('\t');
      if (filePath && !changes.has(filePath)) {
        changes.set(filePath, { path: filePath, status: status.charAt(0) });
      }
    }

    return Array.from(changes.values()).filter(f =>
      f.path.endsWith('.js') || f.path.endsWith('.mjs') || f.path.endsWith('.ts')
    );
  } catch (e) {
    console.error('Failed to get git changes:', e.message);
    return [];
  }
}

/**
 * Group files by module using .test-map.json
 * @param {string} cwd
 * @param {Array<{path: string, status: string}>} files
 * @returns {Promise<Map<string, Array<{path: string, status: string}>>>}
 */
async function groupByModule(cwd, files) {
  const testMap = await readJsonSafe(path.join(cwd, '.test-map.json'));
  const modules = new Map();

  // Build reverse lookup: file path -> module
  const fileToModule = new Map();
  if (testMap?.modules) {
    for (const [modulePath, moduleData] of Object.entries(testMap.modules)) {
      if (moduleData?.files) {
        for (const [fileName, fileData] of Object.entries(moduleData.files)) {
          const srcPath = fileData?.path;
          if (srcPath) {
            fileToModule.set(srcPath, modulePath);
            // Also map test files to same module
            for (const testPath of fileData.tests || []) {
              fileToModule.set(testPath, modulePath);
            }
          }
        }
      }
    }
  }

  // Group files
  for (const f of files) {
    // Try direct lookup
    let module = fileToModule.get(f.path);

    // Fallback: infer module from path
    if (!module) {
      if (f.path.startsWith('tests/unit/')) {
        // tests/unit/agents/core/... -> js/agents/core
        const parts = f.path.replace('tests/unit/', 'js/').split('/');
        module = parts.slice(0, 3).join('/'); // js/agents/core
      } else if (f.path.startsWith('tests/integration/')) {
        module = 'tests/integration';
      } else if (f.path.startsWith('js/')) {
        const parts = f.path.split('/');
        module = parts.slice(0, 3).join('/'); // js/agents/core
      } else {
        module = 'other';
      }
    }

    if (!modules.has(module)) {
      modules.set(module, []);
    }
    modules.get(module).push(f);
  }

  return modules;
}

/**
 * Read file content safely (truncated)
 */
async function readFileSafe(filePath, maxLines = 100) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    return lines.slice(0, maxLines).join('\n');
  } catch {
    return '';
  }
}

/**
 * Commit validated files safely
 */
async function safeCommit(cwd, files, message) {
  if (files.length === 0) return { success: false, error: 'No files to commit' };

  try {
    for (const file of files) {
      execSync(`git add "${file}"`, { cwd, encoding: 'utf-8' });
    }
    execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
      cwd, encoding: 'utf-8'
    });
    return { success: true, files: files.length };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function printHelp() {
  console.log(`Usage:
  node acceptance-gate.js [options]

Options:
  --dry-run        Preview only, no commits
  --concurrency=N  Override concurrency (default 8)
  --commit         Auto-commit validated files
  --status         Show last result
  --help           Show help

Examples:
  node acceptance-gate.js --dry-run
  node acceptance-gate.js --commit --concurrency=16
`);
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const cwd = process.cwd();

  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    printHelp();
    return;
  }

  const args = parseArgs(rawArgs, {
    dryRun: false,
    commit: false,
    status: false
  });

  if (args.status) {
    const resultPath = path.join(cwd, '.project-index', '.acceptance-gate-result.json');
    try {
      const result = await fs.readFile(resultPath, 'utf-8');
      console.log(result);
    } catch {
      console.log('No result found.');
    }
    return;
  }

  const concurrency = args.concurrency ? parseInt(args.concurrency, 10) : 8;

  console.log('Scanning git changes...');
  const changes = await getGitChanges(cwd);

  if (changes.length === 0) {
    console.log('No modified JS/TS files found.');
    return;
  }

  console.log(`Found ${changes.length} modified files`);

  // Group by module
  console.log('Grouping by module...');
  const moduleGroups = await groupByModule(cwd, changes);
  console.log(`Grouped into ${moduleGroups.size} modules`);

  if (args.dryRun) {
    console.log('\nDry run - modules to validate:');
    for (const [module, files] of moduleGroups) {
      console.log(`\n  ${module} (${files.length} files):`);
      for (const f of files.slice(0, 5)) {
        console.log(`    - ${f.path}`);
      }
      if (files.length > 5) {
        console.log(`    ... and ${files.length - 5} more`);
      }
    }
    return;
  }

  const runner = new BatchRunner({
    name: 'acceptance-gate',
    concurrency,
    timeout: 300000, // 5 min per module batch
    stateDir: cwd,
    silent: true
  });

  // Convert module groups to batch tasks
  const moduleTasks = Array.from(moduleGroups.entries()).map(([module, files]) => ({
    id: module,
    module,
    files,
    filePaths: files.map(f => f.path)
  }));

  await runner.run({
    scan: async () => moduleTasks,

    buildPrompt: async function (item) {
      // Build file summaries for batch validation
      const fileSummaries = [];
      for (const f of item.files.slice(0, 20)) { // Limit to 20 files per batch
        const content = await readFileSafe(path.join(cwd, f.path), 50);
        if (content) {
          fileSummaries.push(`### ${f.path}\n\`\`\`javascript\n${content}\n\`\`\``);
        }
      }

      return `${SAFETY_PROMPT_PREFIX}你是一个代码质量专家。请对以下模块的文件进行批量验收评估。

## 模块信息
模块: ${item.module}
文件数: ${item.files.length}

## 文件内容

${fileSummaries.join('\n\n')}

${item.files.length > 20 ? `\n(还有 ${item.files.length - 20} 个文件未显示)\n` : ''}

## 验收标准

请对每个文件进行四维评估（代码质量、测试覆盖、功能正确性、安全审计），然后给出整体判断。

## 输出格式

请严格按照以下 JSON 格式输出评估结果：

\`\`\`json
{
  "module": "${item.module}",
  "overall": "PASS|FAIL",
  "passedFiles": ["file1.js", "file2.js"],
  "failedFiles": [
    { "path": "file3.js", "reason": "简短原因" }
  ],
  "summary": "整体评估说明"
}
\`\`\`

如果所有文件都通过，overall 为 PASS，failedFiles 为空数组。`;
    },

    handleResult: async function (item, result) {
      // Extract output from LLM response
      if (result && typeof result === 'object') {
        if ('output' in result) result = result.output;
        else if ('text' in result) result = result.text;
        else if ('content' in result) result = result.content;
        else result = JSON.stringify(result);
      }

      if (typeof result !== 'string') {
        return {
          status: 'error',
          success: false,
          error: `Invalid result type: ${typeof result}`,
          item,
          passedFiles: [],
          failedFiles: item.filePaths
        };
      }

      // Extract JSON from response
      const jsonMatch = result.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
      if (!jsonMatch || !jsonMatch[1]) {
        return {
          status: 'error',
          success: false,
          error: 'No JSON block found in response',
          item,
          passedFiles: [],
          failedFiles: item.filePaths
        };
      }

      let evaluation;
      try {
        evaluation = JSON.parse(jsonMatch[1].trim());
      } catch (e) {
        return {
          status: 'error',
          success: false,
          error: `Invalid JSON: ${e.message}`,
          item,
          passedFiles: [],
          failedFiles: item.filePaths
        };
      }

      const passed = evaluation.overall === 'PASS';
      const passedFiles = evaluation.passedFiles || [];
      const failedFiles = (evaluation.failedFiles || []).map(f =>
        typeof f === 'string' ? f : f.path
      );

      return {
        status: passed ? 'success' : 'error',
        success: passed,
        error: passed ? null : evaluation.summary || 'Some files failed validation',
        evaluation,
        item,
        passedFiles,
        failedFiles
      };
    }
  }, { cwd });

  console.log('\nValidation complete.');

  // Collect results from tasks file (has evaluation data)
  const tasksPath = path.join(cwd, '.project-index', '.acceptance-gate-tasks.json');
  let savedResult;
  try {
    savedResult = JSON.parse(await fs.readFile(tasksPath, 'utf-8'));
  } catch {
    console.log('No tasks file found.');
    return;
  }

  const allPassedFiles = [];
  const allFailedFiles = [];

  for (const task of savedResult.tasks || []) {
    const evaluation = task.result?.evaluation;
    if (evaluation?.passedFiles) {
      allPassedFiles.push(...evaluation.passedFiles);
    }
    if (evaluation?.failedFiles) {
      for (const f of evaluation.failedFiles) {
        allFailedFiles.push({ path: typeof f === 'string' ? f : f.path, module: task.item?.module });
      }
    }
  }

  console.log(`\n=== Validation Summary ===`);
  console.log(`Modules: ${moduleGroups.size}`);
  console.log(`Passed files: ${allPassedFiles.length}`);
  console.log(`Failed files: ${allFailedFiles.length}`);

  if (allFailedFiles.length > 0) {
    console.log('\nFailed files:');
    for (const f of allFailedFiles.slice(0, 15)) {
      console.log(`  - ${f.path} (${f.module})`);
    }
    if (allFailedFiles.length > 15) {
      console.log(`  ... and ${allFailedFiles.length - 15} more`);
    }
  }

  // Commit if requested
  if (args.commit && allPassedFiles.length > 0) {
    console.log(`\nCommitting ${allPassedFiles.length} validated files...`);
    const commitResult = await safeCommit(
      cwd,
      allPassedFiles,
      `chore: validated ${allPassedFiles.length} files via acceptance-gate`
    );
    if (commitResult.success) {
      console.log(`Committed ${commitResult.files} files`);
    } else {
      console.log(`Commit failed: ${commitResult.error}`);
    }
  } else if (allPassedFiles.length > 0) {
    console.log(`\nRun with --commit to commit ${allPassedFiles.length} validated files`);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
