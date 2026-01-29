#!/usr/bin/env node
/**
 * Test Plan Generator - 一键生成测试修复落地计划
 *
 * 整合 test-prioritize.js + test-result.js 数据，输出 Markdown 表格
 *
 * Usage:
 *   node test-plan.js              # 生成 Markdown 表格
 *   node test-plan.js --json       # JSON 输出
 *   node test-plan.js --refresh    # 强制刷新测试结果
 *   node test-plan.js --output plan.md  # 输出到文件
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { findProjectRoot, parseArgs, readJsonSafe } from './shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_RESULT_SCRIPT = path.join(__dirname, 'test-result.js');
const TEST_PRIORITIZE_SCRIPT = path.join(__dirname, 'test-prioritize.js');

/**
 * Run a node script and get JSON output
 * @param {string} script
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<any>}
 */
async function runScript(script, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });

    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Exit code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`Failed to parse JSON: ${e?.message || String(e)}`));
      }
    });
  });
}

/**
 * Normalize path for display
 * @param {string} p
 * @returns {string}
 */
function normPath(p) {
  return String(p || '')
    .replace(/^.*?js\/agents\//, '')
    .replace(/^.*?tests\//, 'tests/');
}

/**
 * Truncate string
 * @param {string} s
 * @param {number} max
 * @returns {string}
 */
function trunc(s, max = 60) {
  const str = String(s || '');
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

/**
 * Build error summary by test file
 * @param {any[]} errors
 * @returns {Map<string, {count: number, mainType: string, samples: {test: string, error: string}[]}>}
 */
function buildErrorSummary(errors) {
  const byFile = new Map();

  for (const e of errors || []) {
    const key = normPath(e.testFile);
    if (!byFile.has(key)) {
      byFile.set(key, { count: 0, types: {}, samples: [] });
    }
    const entry = byFile.get(key);
    entry.count++;

    const msg = e.message || '';
    const type = msg.match(/^(TypeError|ReferenceError|AssertionError|Error|SyntaxError)/)?.[0] || 'Other';
    entry.types[type] = (entry.types[type] || 0) + 1;

    if (entry.samples.length < 2) {
      entry.samples.push({
        test: trunc(e.test || '', 50),
        error: trunc(e.expected || msg.split('\n')[0] || '', 70)
      });
    }
  }

  // Compute mainType for each
  for (const [, entry] of byFile) {
    entry.mainType = Object.entries(entry.types)
      .sort((a, b) => b[1] - a[1])[0]?.[0] || 'Unknown';
  }

  return byFile;
}

/**
 * Generate markdown output
 * @param {any} priority
 * @param {Map<string, any>} errorSummary
 * @param {number} totalFailed
 * @param {number} totalTests
 * @returns {string}
 */
function generateMarkdown(priority, errorSummary, totalFailed, totalTests) {
  const lines = [];

  lines.push('## 测试修复落地计划\n');
  lines.push(`**测试框架**: \`pnpm vitest run\` / \`npm run test:agents\``);
  lines.push(`**当前状态**: ${totalFailed} 失败 / ${totalTests} 总测试`);
  lines.push(`**源文件**: ${priority.sourceFiles || 0} 个涉及\n`);
  lines.push('---\n');

  // Phase 1: Root Causes
  const rootPhase = priority.phases?.find(p => p.name === 'rootCauses');
  lines.push('### Phase 1: Root Causes（先修）\n');
  lines.push('| 优先级 | 源文件 | 依赖数 | 失败测试数 | 解锁潜力 | 主要错误类型 | 典型错误 |');
  lines.push('|:---:|--------|:---:|:---:|:---:|-------------|----------|');

  if (rootPhase?.items?.length) {
    rootPhase.items.forEach((item, i) => {
      const srcFile = normPath(item.file);
      const tests = item.failingTests || [];
      const firstTestErr = tests.length > 0 ? errorSummary.get(normPath(tests[0])) : null;
      const errType = firstTestErr?.mainType || '-';
      const errSample = trunc(firstTestErr?.samples?.[0]?.error || '-', 50);

      lines.push(`| ${i + 1} | \`${srcFile}\` | ${item.dependents} | ${tests.length} | ${item.potentialFixes} | ${errType} | ${errSample} |`);
    });
  } else {
    lines.push('| - | (无) | - | - | - | - | - |');
  }

  lines.push('\n**Phase 1 关联测试**:');
  lines.push('```');
  const rootTests = new Set();
  rootPhase?.items?.forEach(item => {
    (item.failingTests || []).forEach(t => rootTests.add(normPath(t)));
  });
  [...rootTests].slice(0, 10).forEach(t => lines.push(t));
  if (rootTests.size > 10) lines.push(`... +${rootTests.size - 10} more`);
  lines.push('```\n');
  lines.push('---\n');

  // Phase 2: Independent
  const indepPhase = priority.phases?.find(p => p.name === 'independent');
  lines.push('### Phase 2: Independent（可并行）\n');
  lines.push('| 批次 | 源文件 | 关联测试数 | 主要错误类型 |');
  lines.push('|:---:|--------|:---:|-------------|');

  if (indepPhase?.batches?.length) {
    indepPhase.batches.forEach((batch, bi) => {
      const batchLabel = String.fromCharCode(65 + bi); // A, B, C...
      (batch.files || []).forEach(file => {
        lines.push(`| ${batchLabel} | \`${normPath(file)}\` | ${batch.tests || '-'} | - |`);
      });
    });
  } else {
    lines.push('| - | (无) | - | - |');
  }
  lines.push('\n---\n');

  // Phase 3: Leaf Nodes
  const leafPhase = priority.phases?.find(p => p.name === 'leafNodes');
  lines.push('### Phase 3: Leaf Nodes（最后修）\n');
  lines.push('| 源文件 | 失败数 | 主要错误类型 |');
  lines.push('|--------|:---:|-------------|');

  if (leafPhase?.items?.length) {
    leafPhase.items.slice(0, 15).forEach(item => {
      lines.push(`| \`${normPath(item.file)}\` | ${item.tests || 0} | - |`);
    });
    if (leafPhase.items.length > 15) {
      lines.push(`| ... | +${leafPhase.items.length - 15} | - |`);
    }
  } else {
    lines.push('| (无) | - | - |');
  }
  lines.push('\n---\n');

  // High frequency failing files
  lines.push('### 高频失败文件（按失败数排序）\n');
  lines.push('| 测试文件 | 失败数 | 主要错误类型 | 典型错误 |');
  lines.push('|----------|:---:|-------------|----------|');

  const sorted = [...errorSummary.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 12);

  for (const [file, info] of sorted) {
    const errSample = trunc(info.samples?.[0]?.error || '-', 50);
    lines.push(`| \`${file}\` | **${info.count}** | ${info.mainType} | ${errSample} |`);
  }
  lines.push('\n---\n');

  // Error type summary
  lines.push('### 错误分类汇总\n');
  lines.push('| 错误类型 | 数量 | 修复策略 |');
  lines.push('|----------|:---:|---------|');

  const typeCounts = {};
  for (const [, info] of errorSummary) {
    for (const [type, count] of Object.entries(info.types)) {
      typeCounts[type] = (typeCounts[type] || 0) + count;
    }
  }

  const strategies = {
    'Error': '检查 import 路径、模块是否存在',
    'AssertionError': 'API 变更、事件名变更、返回值结构变更',
    'TypeError': 'undefined 属性访问，检查 mock 或源码',
    'ReferenceError': '变量未定义，检查导入',
    'Other': '检查具体错误信息'
  };

  Object.entries(typeCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([type, count]) => {
      lines.push(`| **${type}** | ~${count} | ${strategies[type] || '-'} |`);
    });

  lines.push('\n---\n');

  // Suggested commands
  lines.push('### 建议执行命令\n');
  lines.push('```bash');
  lines.push('# Phase 1: Root Causes');
  if (rootPhase?.items?.length) {
    const rootFiles = rootPhase.items.map(i => normPath(i.failingTests?.[0] || '')).filter(Boolean).slice(0, 5);
    if (rootFiles.length) {
      lines.push(`node ~/.claude/skills/project-index/scripts/test-fix.js \\`);
      rootFiles.forEach((f, i) => {
        lines.push(`  ${f}${i < rootFiles.length - 1 ? ' \\' : ''}`);
      });
    }
  }
  lines.push('');
  lines.push('# Phase 2: Parallel batch');
  lines.push('node ~/.claude/skills/project-index/scripts/test-fix.js --concurrency=40 --limit=50');
  lines.push('');
  lines.push('# Verify');
  lines.push('pnpm vitest run tests/unit/agents');
  lines.push('```');

  return lines.join('\n');
}

/**
 * Generate JSON output
 * @param {any} priority
 * @param {Map<string, any>} errorSummary
 * @param {number} totalFailed
 * @param {number} totalTests
 * @returns {object}
 */
function generateJson(priority, errorSummary, totalFailed, totalTests) {
  const highFreq = [...errorSummary.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 20)
    .map(([file, info]) => ({
      file,
      count: info.count,
      mainType: info.mainType,
      samples: info.samples
    }));

  return {
    summary: {
      totalFailed,
      totalTests,
      sourceFiles: priority.sourceFiles || 0
    },
    phases: priority.phases || [],
    suggestedOrder: priority.suggestedOrder || [],
    highFrequencyFailures: highFreq
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    json: false,
    refresh: false,
    output: null,
    help: false
  });

  if (args.help) {
    console.log(`
Test Plan Generator - 一键生成测试修复落地计划

Usage:
  node test-plan.js              # 生成 Markdown 表格
  node test-plan.js --json       # JSON 输出
  node test-plan.js --refresh    # 强制刷新测试结果
  node test-plan.js --output plan.md  # 输出到文件
`);
    return;
  }

  const projectRoot = await findProjectRoot(process.cwd());
  const resultPath = path.join(projectRoot, '.project-index', '.test-result.json');

  // Check if we need to refresh
  let needRefresh = args.refresh;
  if (!needRefresh) {
    try {
      const stat = await fs.stat(resultPath);
      const ageMs = Date.now() - stat.mtimeMs;
      // Refresh if older than 10 minutes
      needRefresh = ageMs > 10 * 60 * 1000;
    } catch {
      needRefresh = true;
    }
  }

  if (needRefresh) {
    console.error('Running tests to collect results...');
    try {
      await runScript(TEST_RESULT_SCRIPT, ['--save'], projectRoot);
    } catch (err) {
      console.error('Warning: test-result.js failed:', err.message);
    }
  }

  // Load test results
  const testResult = await readJsonSafe(resultPath, { errors: [], passed: 0, failed: 0 });
  const errors = testResult.errors || [];
  const totalFailed = testResult.failed || errors.length;
  const totalTests = (testResult.passed || 0) + totalFailed;

  if (totalFailed === 0) {
    console.log('No failing tests detected.');
    return;
  }

  // Run prioritize
  let priority;
  try {
    priority = await runScript(TEST_PRIORITIZE_SCRIPT, ['--json'], projectRoot);
  } catch (err) {
    console.error('Warning: test-prioritize.js failed:', err.message);
    priority = { phases: [], sourceFiles: 0, suggestedOrder: [] };
  }

  // Build error summary
  const errorSummary = buildErrorSummary(errors);

  if (args.json) {
    const json = generateJson(priority, errorSummary, totalFailed, totalTests);
    const output = JSON.stringify(json, null, 2);
    if (args.output) {
      await fs.writeFile(args.output, output);
      console.error(`Wrote: ${args.output}`);
    } else {
      console.log(output);
    }
    return;
  }

  const md = generateMarkdown(priority, errorSummary, totalFailed, totalTests);
  if (args.output) {
    await fs.writeFile(args.output, md);
    console.log(`Wrote: ${args.output}`);
  } else {
    console.log(md);
  }
}

main().catch(err => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
