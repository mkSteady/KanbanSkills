/**
 * Module analyzer - Combined doc update + audit in one pass
 *
 * Supports:
 * - stale/missing/all/force module selection
 * - Kanban task creation from audit issues
 * - LLM batch processing with DAG scheduling (child modules before parents)
 * - SAFETY_PROMPT_PREFIX injection for all LLM prompts
 */

import { promises as fs } from 'fs';
import path from 'path';
import { writeJsonSafe, parallelMap, matchesIgnoreInclude, getDirectoryRule } from '../shared.js';
import { getCachePath } from '../context.js';
import { runBatch } from '../llm/batch.js';

/** @typedef {import('../types.js').ProjectConfig} ProjectConfig */

const KANBAN_API = process.env.KANBAN_URL || 'http://127.0.0.1:3007/api/v1';

/**
 * Safety prompt prefix for all LLM calls.
 * Mirrors project-index/scripts/shared.js to reduce the chance of unsafe actions.
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

const CODE_EXTENSIONS = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.rb', '.php',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.swift', '.vue', '.svelte'
]);

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
  'venv', '.venv', 'target', 'vendor', '.cache', 'coverage',
  '.turbo', '.nuxt', '.output', 'out'
]);

const LARGE_THRESHOLD = { files: 5, lines: 200 };

function boolFlag(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === '' || s === '0') return false;
    if (['false', 'no', 'off', 'disabled'].includes(s)) return false;
    return true;
  }
  return Boolean(v);
}

function normalizeModulePath(modulePath) {
  if (!modulePath || modulePath === '.') return '.';
  return String(modulePath)
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '') || '.';
}

function normalizePathInput(input) {
  if (!input) return null;
  const normalized = path.normalize(String(input)).replace(/\\/g, '/');
  const trimmed = normalized.replace(/^\.\/+/, '').replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed || '.';
}

function getDepth(p) {
  return normalizeModulePath(p).split(/[\\/]+/).filter(Boolean).length;
}

function sortModules(modules) {
  return modules.sort((a, b) => {
    const depthA = getDepth(a.path);
    const depthB = getDepth(b.path);
    if (depthA !== depthB) return depthB - depthA; // deeper (children) first
    return a.path.localeCompare(b.path);
  });
}

function matchesPathFilter(modulePath, filterPath) {
  if (!filterPath) return true;
  const moduleNormalized = normalizeModulePath(modulePath) || '.';
  const filterNormalized = normalizePathInput(filterPath) || '.';
  if (filterNormalized === '.' || filterNormalized === '') return true;
  return moduleNormalized === filterNormalized || moduleNormalized.startsWith(`${filterNormalized}/`);
}

function mergeModules(...lists) {
  const merged = new Map();

  for (const list of lists) {
    for (const item of list) {
      const key = normalizeModulePath(item.path);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { ...item, path: key });
        continue;
      }

      const existingChanged = existing.changedFiles || [];
      const incomingChanged = item.changedFiles || [];
      merged.set(key, {
        ...existing,
        ...item,
        path: key,
        changedFiles: existingChanged.length > 0 ? existingChanged : incomingChanged
      });
    }
  }

  return Array.from(merged.values());
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readFileSafe(filePath, maxLines = 80) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.split('\n');
    return lines.slice(0, maxLines).join('\n');
  } catch {
    return '';
  }
}

function isCodeFile(name) {
  const ext = path.extname(name).toLowerCase();
  if (!CODE_EXTENSIONS.has(ext)) return false;
  if (name.includes('.test.') || name.includes('.spec.')) return false;
  return true;
}

async function listCodeFiles(dir, maxFiles) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter(e => e.isFile())
    .map(e => e.name)
    .filter(isCodeFile)
    .slice(0, maxFiles);
}

function resolveChangedFileAbs(root, modulePath, fileEntry) {
  const rel = typeof fileEntry === 'string' ? fileEntry : fileEntry?.path;
  if (!rel) return null;
  if (path.isAbsolute(rel)) return rel;
  const normalizedRel = String(rel).replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');

  // Prefer root-relative when it matches module path prefix.
  if (modulePath !== '.' && (normalizedRel === modulePath || normalizedRel.startsWith(modulePath + '/'))) {
    return path.join(root, normalizedRel);
  }

  // Otherwise treat as module-relative.
  return path.join(root, modulePath === '.' ? '' : modulePath, normalizedRel);
}

/**
 * Read code files from a module directory (prefers changed files)
 * @param {string} root - Project root
 * @param {string} modulePath - Module path (project-relative)
 * @param {Array<{path: string, mtime?: number}|string>} changedFiles
 * @param {number} [maxFiles=5]
 * @param {number} [maxLines=60]
 * @returns {Promise<string>}
 */
async function readCodeFiles(root, modulePath, changedFiles, maxFiles = 5, maxLines = 60) {
  const fullDir = path.join(root, modulePath);
  let filesToRead = Array.isArray(changedFiles) ? changedFiles.slice(0, maxFiles) : [];

  if (filesToRead.length === 0) {
    filesToRead = await listCodeFiles(fullDir, maxFiles);
  }

  let content = '';
  for (const f of filesToRead) {
    const absPath = resolveChangedFileAbs(root, modulePath, f);
    if (!absPath) continue;
    const relPath = typeof f === 'string'
      ? path.relative(fullDir, absPath).replace(/\\/g, '/')
      : (f.path || path.relative(fullDir, absPath).replace(/\\/g, '/'));

    const fileContent = await readFileSafe(absPath, maxLines);
    if (!fileContent) continue;
    content += `\n--- ${relPath} ---\n${fileContent}\n`;
  }

  return content;
}

/**
 * Analyze a directory's direct code files (non-recursive).
 * @param {string} dir
 * @returns {Promise<{fileCount: number, lineCount: number, isLarge: boolean}>}
 */
async function analyzeDir(dir) {
  let fileCount = 0;
  let lineCount = 0;

  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { fileCount: 0, lineCount: 0, isLarge: false };
  }

  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!isCodeFile(e.name)) continue;

    fileCount++;
    if (fileCount >= LARGE_THRESHOLD.files) {
      return { fileCount, lineCount, isLarge: true };
    }

    try {
      const content = await fs.readFile(path.join(dir, e.name), 'utf8');
      lineCount += content.split('\n').length;
      if (lineCount >= LARGE_THRESHOLD.lines) {
        return { fileCount, lineCount, isLarge: true };
      }
    } catch {
      // ignore read errors
    }
  }

  return {
    fileCount,
    lineCount,
    isLarge: fileCount >= LARGE_THRESHOLD.files || lineCount >= LARGE_THRESHOLD.lines
  };
}

async function findDocDirs(rootPath, scanPath, docName) {
  const start = path.join(rootPath, scanPath || '.');
  /** @type {string[]} */
  const results = [];

  async function walk(dir) {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isFile() && entry.name === docName) {
        results.push(dir);
        continue;
      }
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      if (IGNORE_DIRS.has(entry.name)) continue;
      await walk(path.join(dir, entry.name));
    }
  }

  await walk(start);
  return results;
}

/**
 * Get max mtime of code files in directory (recursive), excluding submodules with their own doc file.
 * @param {string} dir
 * @param {Date|null} docMtime
 * @param {string} rootPath
 * @param {string} docName
 * @returns {Promise<{mtime: Date|null, newestFile: string|null, changedFiles: Array<{path: string, mtime: number}>}>}
 */
async function getMaxCodeMtime(dir, docMtime, rootPath, docName = 'CLAUDE.md') {
  /** @type {Date|null} */
  let maxMtime = null;
  /** @type {string|null} */
  let maxFile = null;
  /** @type {Array<{path: string, mtime: number}>} */
  const changedFiles = [];

  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { mtime: null, newestFile: null, changedFiles: [] };
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isFile()) {
      if (entry.name === 'CLAUDE.md' || entry.name === 'AUDIT.md') continue;
      if (!isCodeFile(entry.name)) continue;

      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        continue;
      }

      if (!maxMtime || stat.mtime > maxMtime) {
        maxMtime = stat.mtime;
        maxFile = fullPath;
      }

      if (docMtime && stat.mtime > docMtime) {
        changedFiles.push({
          path: path.relative(rootPath, fullPath).replace(/\\/g, '/'),
          mtime: stat.mtimeMs
        });
      }

      continue;
    }

    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (IGNORE_DIRS.has(entry.name)) continue;

    // Skip submodule boundaries.
    const subDocPath = path.join(fullPath, docName);
    if (await fileExists(subDocPath)) continue;

    const sub = await getMaxCodeMtime(fullPath, docMtime, rootPath, docName);
    if (sub.mtime && (!maxMtime || sub.mtime > maxMtime)) {
      maxMtime = sub.mtime;
      maxFile = sub.newestFile;
    }
    if (sub.changedFiles.length > 0) changedFiles.push(...sub.changedFiles);
  }

  // newest first for prompt
  changedFiles.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));

  return { mtime: maxMtime, newestFile: maxFile ? path.relative(rootPath, maxFile).replace(/\\/g, '/') : null, changedFiles };
}

/**
 * 获取过期模块（CLAUDE.md mtime < 代码 mtime）
 * @param {string} cwd
 * @param {string} [scanPath='.']
 * @returns {Promise<Array<{path: string, status: string, changedFiles: Array<{path: string, mtime: number}>}>>}
 */
export async function getStaleModules(cwd, scanPath = '.') {
  const docDirs = await findDocDirs(cwd, scanPath, 'CLAUDE.md');
  const results = [];

  for (const dir of docDirs) {
    const relPath = normalizeModulePath(path.relative(cwd, dir) || '.');
    let docStat;
    try {
      docStat = await fs.stat(path.join(dir, 'CLAUDE.md'));
    } catch {
      continue;
    }

    const { mtime: codeMtime, changedFiles } = await getMaxCodeMtime(dir, docStat.mtime, cwd, 'CLAUDE.md');
    if (!codeMtime) continue;
    if (codeMtime > docStat.mtime) {
      results.push({ path: relPath, status: 'stale', changedFiles });
    }
  }

  return results;
}

/**
 * 查找缺失 CLAUDE.md 的目录（仅返回“足够大”的目录，避免噪音）
 * @param {string} cwd
 * @param {string} scanPath
 * @returns {Promise<Array<{path: string, status: string, changedFiles: any[]}>>}
 */
export async function findMissingDocs(cwd, scanPath) {
  const fullScanPath = path.join(cwd, scanPath || '.');
  /** @type {Array<{path: string, status: string, changedFiles: any[]}>} */
  const missing = [];

  async function scan(dir) {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const hasClaude = await fileExists(path.join(dir, 'CLAUDE.md'));
    const stats = await analyzeDir(dir);
    const relPath = normalizeModulePath(path.relative(cwd, dir) || '.');

    if (!hasClaude && stats.fileCount > 0 && stats.isLarge) {
      missing.push({ path: relPath, status: 'missing_doc', changedFiles: [] });
    }

    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.')) continue;
      if (IGNORE_DIRS.has(e.name)) continue;
      await scan(path.join(dir, e.name));
    }
  }

  await scan(fullScanPath);
  missing.sort((a, b) => getDepth(b.path) - getDepth(a.path));
  return missing;
}

/**
 * 查找缺失 AUDIT.md 的目录（以已有 CLAUDE.md 的目录为模块边界）
 * @param {string} cwd
 * @param {string} [scanPath='.']
 * @returns {Promise<Array<{path: string, status: string, changedFiles: any[]}>>}
 */
export async function findMissingAudits(cwd, scanPath = '.') {
  const docDirs = await findDocDirs(cwd, scanPath, 'CLAUDE.md');
  const missing = [];

  for (const dir of docDirs) {
    const relPath = normalizeModulePath(path.relative(cwd, dir) || '.');
    const auditPath = path.join(dir, 'AUDIT.md');
    if (!(await fileExists(auditPath))) {
      missing.push({ path: relPath, status: 'missing_audit', changedFiles: [] });
    }
  }

  return missing;
}

async function findLargeDirs(cwd, scanPath) {
  const fullScanPath = path.join(cwd, scanPath || '.');
  const results = [];

  async function scan(dir) {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const stats = await analyzeDir(dir);
    const relPath = normalizeModulePath(path.relative(cwd, dir) || '.');

    if (stats.fileCount > 0 && stats.isLarge) {
      results.push({ path: relPath, status: 'force', changedFiles: [] });
    }

    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.')) continue;
      if (IGNORE_DIRS.has(e.name)) continue;
      await scan(path.join(dir, e.name));
    }
  }

  await scan(fullScanPath);
  results.sort((a, b) => getDepth(b.path) - getDepth(a.path));
  return results;
}

/**
 * 按模式获取模块列表
 * mode: 'stale' | 'missing' | 'all' | 'force'
 * @param {{mode: string, cwd: string, scanPath: string, enableDoc: boolean, enableAudit: boolean}} opts
 * @returns {Promise<Array<{path: string, status?: string, changedFiles?: any[]}>>}
 */
export async function getModulesByMode({ mode, cwd, scanPath, enableDoc, enableAudit }) {
  const effectiveScan = scanPath || '.';

  if (mode === 'stale') {
    return await getStaleModules(cwd, effectiveScan);
  }

  if (mode === 'missing') {
    const missingDocs = enableDoc ? await findMissingDocs(cwd, effectiveScan) : [];
    const missingAudits = enableAudit ? await findMissingAudits(cwd, effectiveScan) : [];
    return mergeModules(missingDocs, missingAudits);
  }

  if (mode === 'all') {
    const stale = await getStaleModules(cwd, effectiveScan);
    const missingDocs = enableDoc ? await findMissingDocs(cwd, effectiveScan) : [];
    const missingAudits = enableAudit ? await findMissingAudits(cwd, effectiveScan) : [];
    return mergeModules(stale, missingDocs, missingAudits);
  }

  if (mode === 'force') {
    return await findLargeDirs(cwd, effectiveScan);
  }

  return [];
}

/**
 * Detect current project from Kanban
 * @param {string} cwd
 * @returns {Promise<{id: string, name: string, path: string}|null>}
 */
export async function detectProject(cwd = process.cwd()) {
  try {
    const res = await fetch(`${KANBAN_API}/projects`);
    if (!res.ok) return null;
    const data = await res.json();

    for (const project of data.items || []) {
      if (project.path === cwd || cwd.startsWith(project.path + path.sep) || cwd.startsWith(project.path + '/')) {
        return project;
      }
    }
  } catch { }
  return null;
}

/**
 * Create Kanban task (single issue)
 * @param {string} projectId
 * @param {{title: string, description?: string, priority?: number, tags?: string[]}} task
 * @returns {Promise<string|null>}
 */
export async function createKanbanTask(projectId, task) {
  try {
    const res = await fetch(`${KANBAN_API}/projects/${projectId}/tasks/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: task.title,
        description: task.description || '',
        status: 'todo',
        priority: task.priority ?? 2,
        tags: task.tags || [],
        dueDate: null,
        worktreeId: null
      })
    });

    if (res.ok) {
      const data = await res.json();
      return data.item?.id || null;
    }
  } catch { }
  return null;
}

/**
 * Create Kanban tasks for audit issues (one task per issue)
 * @param {string} projectId
 * @param {string} modulePath
 * @param {{severity?: string, issues?: any[], summary?: string}} audit
 * @returns {Promise<{taskIds: string[]}>}
 */
export async function createAuditTasks(projectId, modulePath, audit) {
  const { severity, issues, summary } = audit || {};
  if (!issues || issues.length === 0) return { taskIds: [] };

  const priorityMap = { critical: 0, high: 1, medium: 2, low: 3 };
  const basePriority = priorityMap[String(severity || '').toLowerCase()] ?? 2;
  const taskIds = [];

  for (const issue of issues) {
    const issueSeverity = String(issue?.severity || '').toLowerCase();
    const task = {
      title: `[AUDIT/${String(severity || 'unknown').toUpperCase()}] ${modulePath}: ${issue?.type || 'issue'}`,
      description: `## 问题描述
${issue?.description || 'N/A'}

## 位置
- **模块**: ${modulePath}
- **文件**: ${issue?.file || 'N/A'}
- **行号**: ${issue?.line || 'N/A'}

## 代码上下文
\`\`\`
${issue?.context || 'N/A'}
\`\`\`

## 修复建议
${issue?.suggestion || '待分析'}

## 审计摘要
${summary || 'N/A'}

---
*由 pi module analyze 自动创建*`,
      priority: priorityMap[issueSeverity] ?? basePriority,
      tags: ['audit', severity, issue?.type].filter(Boolean)
    };

    const taskId = await createKanbanTask(projectId, task);
    if (taskId) taskIds.push(taskId);
  }

  return { taskIds };
}

/**
 * Analyze modules for documentation and code quality
 * @param {{root: string, config: ProjectConfig}} ctx
 * @param {object} args
 */
export async function analyzeModules(ctx, args) {
  const { root, config } = ctx;

  const dryRun = boolFlag(args?.dryRun) || boolFlag(args?.['dry-run']);

  // Feature toggles (CLI overrides config)
  const features = config.features || {};
  const enableDoc = !boolFlag(args?.['no-doc']) && features.doc !== false;
  const enableAudit = !boolFlag(args?.['no-audit']) && features.audit !== false;
  const enableKanban = !boolFlag(args?.['no-kanban']) && features.kanban !== false;
  const effectiveKanban = enableKanban && enableAudit;

  if (!enableDoc && !enableAudit) {
    console.log('Nothing to do: doc and audit are both disabled.');
    return [];
  }

  // Module selection mode
  const requestedModes = [];
  if (boolFlag(args?.stale)) requestedModes.push('stale');
  if (boolFlag(args?.missing)) requestedModes.push('missing');
  if (boolFlag(args?.all)) requestedModes.push('all');
  if (boolFlag(args?.force)) requestedModes.push('force');
  if (requestedModes.length > 1) {
    throw new Error('Only one mode can be selected: --stale | --missing | --all | --force.');
  }
  const mode = requestedModes.length === 0 ? 'stale' : requestedModes[0];

  // Optional scan path (positional)
  const scanArg = args?._?.[2] || '.';
  const scanPath = normalizePathInput(scanArg) || '.';

  // Module list (mode-driven)
  const modules = await getModulesByMode({ mode, cwd: root, scanPath, enableDoc, enableAudit });

  // Apply ignore/include filters (prefer staleConfig, fallback to config.src.ignore)
  const staleCfg = ctx.staleConfig || null;
  const ignore = staleCfg?.ignore || config?.src?.ignore || [];
  const include = staleCfg?.include || [];

  const filtered = sortModules(modules.filter(m => {
    const p = normalizeModulePath(m.path);
    if (!matchesPathFilter(p, scanPath)) return false;
    // allow module directories by ignore/include globs (directory matching)
    return matchesIgnoreInclude(p, ignore, include);
  }));

  if (dryRun) {
    console.log(`Dry run: ${filtered.length} modules (mode: ${mode}, scope: ${scanPath})`);
    for (const mod of filtered) console.log(`- ${mod.path}`);
    return filtered;
  }

  if (filtered.length === 0) {
    console.log('No modules to process.');
    return [];
  }

  const concurrency = Math.max(1, Number(args?.concurrency) || config?.concurrency || 6);
  const llmMode = boolFlag(args?.llm) || boolFlag(args?.smart);

  console.log(`Modules: ${filtered.length} (mode: ${mode}, scope: ${scanPath})`);
  console.log(`Features: doc=${enableDoc}, audit=${enableAudit}, kanban=${effectiveKanban}, llm=${llmMode}`);

  // Kanban project detection (only when audit+kanban enabled)
  let projectId = null;
  if (effectiveKanban) {
    const project = await detectProject(root);
    if (project) {
      projectId = project.id;
      console.log(`Kanban project: ${project.name} (${project.id})`);
    } else {
      console.log('Kanban: project not found, tasks will not be created');
    }
  }

  if (llmMode) {
    const results = await analyzeModulesWithLLM(filtered, {
      root,
      config,
      concurrency,
      enableDoc,
      enableAudit,
      enableKanban: effectiveKanban,
      projectId
    });

    const succeeded = results.filter(r => r.success).length;
    const resultPath = getCachePath(config, root, '.module-analyzer-result.json');
    await writeJsonSafe(resultPath, {
      timestamp: new Date().toISOString(),
      mode,
      scanPath,
      llm: true,
      results,
      summary: { succeeded, failed: results.length - succeeded }
    });
    return results;
  }

  // Fallback: static analysis (legacy)
  const skipDoc = !enableDoc;
  const skipAudit = !enableAudit;

  const staticResults = await parallelMap(filtered, async (mod, idx) => {
    try {
      const result = await analyzeSingleModuleStatic(mod, ctx, { skipDoc, skipAudit });
      console.log(`[${idx + 1}/${filtered.length}] ✓ ${mod.path}`);
      return result;
    } catch (err) {
      console.error(`[${idx + 1}/${filtered.length}] ✗ ${mod.path}: ${err.message}`);
      return { path: mod.path, success: false, error: err.message };
    }
  }, concurrency);

  const succeeded = staticResults.filter(r => r.success).length;
  console.log(`\nAnalyzed: ${succeeded}/${staticResults.length}`);

  const resultPath = getCachePath(config, root, '.module-analyzer-result.json');
  await writeJsonSafe(resultPath, {
    timestamp: new Date().toISOString(),
    mode,
    scanPath,
    llm: false,
    results: staticResults,
    summary: { succeeded, failed: staticResults.length - succeeded }
  });

  return staticResults;
}

/**
 * Build direct-child dependencies to enforce: children before parent.
 * @param {string[]} allPaths
 * @param {string} parent
 */
function getDirectChildren(allPaths, parent) {
  const parentPath = normalizeModulePath(parent);
  const paths = allPaths.map(p => normalizeModulePath(p));

  if (parentPath === '.') {
    return paths.filter(p =>
      p !== '.' &&
      !paths.some(other => other !== '.' && other !== p && p.startsWith(other + '/'))
    );
  }

  return paths.filter(p =>
    p !== parentPath &&
    p.startsWith(parentPath + '/') &&
    !paths.some(other =>
      other !== p &&
      other !== parentPath &&
      p.startsWith(other + '/') &&
      other.startsWith(parentPath + '/')
    )
  );
}

function buildConventionsSection(conventions) {
  if (!conventions || typeof conventions !== 'object') return '';
  const lines = [];
  lines.push('## 项目约定');

  for (const [k, v] of Object.entries(conventions)) {
    if (v == null) continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      lines.push(`- ${k}:`);
      for (const item of v.slice(0, 20)) {
        if (typeof item === 'string' && item.trim()) lines.push(`  - ${item.trim()}`);
      }
      continue;
    }
    if (typeof v === 'string' && v.trim()) lines.push(`- ${k}: ${v.trim()}`);
  }

  return lines.length > 1 ? lines.join('\n') + '\n' : '';
}

function buildAuditMarkdown(modulePath, audit) {
  const now = new Date().toISOString();
  const severity = String(audit?.severity || 'none').toLowerCase();
  const issues = Array.isArray(audit?.issues) ? audit.issues : [];
  const summary = audit?.summary || 'N/A';

  const lines = [];
  lines.push(`# Security Audit - ${modulePath}`);
  lines.push('');
  lines.push(`Generated: ${now}`);
  lines.push(`Severity: **${severity.toUpperCase()}**`);
  lines.push('');
  lines.push('## Summary');
  lines.push(summary);
  lines.push('');
  lines.push(`## Issues (${issues.length})`);
  lines.push('');

  if (issues.length === 0) {
    lines.push('No issues found.');
    lines.push('');
    return lines.join('\n') + '\n';
  }

  for (let i = 0; i < issues.length; i++) {
    const it = issues[i] || {};
    lines.push(`### ${i + 1}. ${it.type || 'Issue'}`);
    lines.push(`- **Severity**: ${it.severity || 'unknown'}`);
    lines.push(`- **File**: ${it.file || 'N/A'}${it.line ? `:${it.line}` : ''}`);
    lines.push(`- **Description**: ${it.description || 'N/A'}`);
    lines.push(`- **Suggestion**: ${it.suggestion || 'N/A'}`);
    if (it.context) {
      lines.push('');
      lines.push('```');
      lines.push(String(it.context).slice(0, 2000));
      lines.push('```');
    }
    lines.push('');
  }

  return lines.join('\n') + '\n';
}

function extractJsonPayload(output) {
  const text = String(output || '');
  const match = text.match(/\{[\s\S]*"doc"[\s\S]*"audit"[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch { }
  }

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    try { return JSON.parse(text.slice(first, last + 1)); } catch { }
  }

  return null;
}

async function analyzeModulesWithLLM(modules, options) {
  const {
    root,
    config,
    concurrency,
    enableDoc,
    enableAudit,
    enableKanban,
    projectId
  } = options;

  const allPaths = modules.map(m => normalizeModulePath(m.path));

  const tasks = modules.map(m => {
    const modulePath = normalizeModulePath(m.path);
    const deps = getDirectChildren(allPaths, modulePath);
    return {
      id: modulePath,
      dependencies: deps,
      prompt: '' // filled later
    };
  });

  // Build prompts (child-first order already in `modules`)
  for (const task of tasks) {
    const modulePath = task.id;
    const fullPath = path.join(root, modulePath);
    const claudeMdPath = path.join(fullPath, 'CLAUDE.md');
    const claudeContent = await readFileSafe(claudeMdPath, 120) || '(无现有文档)';
    const codeContent = await readCodeFiles(root, modulePath, modules.find(m => normalizeModulePath(m.path) === modulePath)?.changedFiles || [], 5, 80);

    const conventionsSection = buildConventionsSection(config?.conventions);
    const directoryRule = getDirectoryRule(modulePath, config?.directoryRules)?.rule || null;
    const dirSection = directoryRule
      ? `## 该目录特别关注 (priority: ${directoryRule.priority || 'medium'})
${Array.isArray(directoryRule.focus) ? directoryRule.focus.map(f => `- ${f}`).join('\n') : ''}
`
      : '';

    const wantDoc = enableDoc ? '启用' : '禁用';
    const wantAudit = enableAudit ? '启用' : '禁用';

    task.prompt = `${SAFETY_PROMPT_PREFIX}你是一个代码分析专家。

请针对 **模块路径** \`${modulePath}\` 完成以下任务（doc=${wantDoc}, audit=${wantAudit}）：

## 任务 1: 更新模块文档 (CLAUDE.md)
- 如果需要更新，返回完整新内容
- 如果不需要更新，返回 needsUpdate=false

## 任务 2: 安全/质量审计 (AUDIT.md)
- 输出 severity: none|low|medium|high|critical
- issues 列表中每项包含：type, severity, description, file, line, context, suggestion

${conventionsSection}${dirSection}
---
当前 CLAUDE.md:
\`\`\`markdown
${claudeContent.slice(0, 4000)}
\`\`\`

相关代码片段（节选）:
${codeContent.slice(0, 6000)}

---
请以 **纯 JSON** 返回（不要包裹代码块）：
{
  "doc": {
    "needsUpdate": true/false,
    "reason": "简要说明",
    "content": "如需更新，完整的新 CLAUDE.md 内容"
  },
  "audit": {
    "severity": "none|low|medium|high|critical",
    "issues": [{"type": "类型", "severity": "critical|high|medium|low", "description": "描述", "file": "文件", "line": 123, "context": "相关代码片段", "suggestion": "建议"}],
    "summary": "审计总结"
  }
}`;
  }

  const results = await runBatch(tasks, {
    concurrency,
    config,
    workdir: root
  });

  /** @type {Array<{path: string, success: boolean, error?: string, doc?: any, audit?: any, kanban?: any}>} */
  const handled = [];

  for (const r of results) {
    const modulePath = normalizeModulePath(r.id);
    const fullPath = path.join(root, modulePath);

    if (!r.success) {
      handled.push({ path: modulePath, success: false, error: r.error || 'llm_error' });
      continue;
    }

    const parsed = extractJsonPayload(r.output);
    if (!parsed) {
      handled.push({ path: modulePath, success: false, error: 'parse_error' });
      continue;
    }

    const now = new Date();
    const claudeMdPath = path.join(fullPath, 'CLAUDE.md');
    const auditMdPath = path.join(fullPath, 'AUDIT.md');

    let docStatus = 'skipped';
    let auditStatus = 'skipped';
    let kanbanInfo = null;

    // Doc
    if (enableDoc) {
      const hasContent = typeof parsed.doc?.content === 'string' && parsed.doc.content.trim().length > 20;
      const needsUpdate = boolFlag(parsed.doc?.needsUpdate) || !(await fileExists(claudeMdPath));

      if (hasContent && needsUpdate) {
        await fs.writeFile(claudeMdPath, parsed.doc.content.trimEnd() + '\n');
        docStatus = 'updated';
      } else if (await fileExists(claudeMdPath)) {
        try {
          await fs.utimes(claudeMdPath, now, now);
          docStatus = 'touched';
        } catch {
          docStatus = 'touched_failed';
        }
      } else if (hasContent) {
        await fs.writeFile(claudeMdPath, parsed.doc.content.trimEnd() + '\n');
        docStatus = 'created';
      } else {
        // Last resort: create a minimal placeholder to avoid repeated "missing"
        const name = modulePath === '.' ? path.basename(root) : path.basename(modulePath);
        await fs.writeFile(claudeMdPath, `# ${name}\n\nModule: \`${modulePath}\`\n\nTODO: describe this module.\n`);
        docStatus = 'created_min';
      }
    }

    // Audit
    if (enableAudit) {
      const audit = parsed.audit || { severity: 'none', issues: [], summary: '' };
      const auditContent = buildAuditMarkdown(modulePath, audit);

      // Write when missing, or when model reported anything (including none)
      const missingAudit = !(await fileExists(auditMdPath));
      const hasIssues = Array.isArray(audit?.issues) && audit.issues.length > 0;
      const severity = String(audit?.severity || 'none').toLowerCase();

      if (missingAudit || hasIssues || severity !== 'none') {
        await fs.writeFile(auditMdPath, auditContent);
        auditStatus = severity;
      } else {
        try {
          await fs.utimes(auditMdPath, now, now);
          auditStatus = 'touched';
        } catch {
          auditStatus = 'touched_failed';
        }
      }

      // Kanban tasks
      if (enableKanban && projectId && hasIssues) {
        const { taskIds } = await createAuditTasks(projectId, modulePath, audit);
        if (taskIds.length > 0) {
          kanbanInfo = { taskCount: taskIds.length, taskIds };
        }
      }
    }

    handled.push({
      path: modulePath,
      success: true,
      doc: docStatus,
      audit: auditStatus,
      issueCount: Array.isArray(parsed.audit?.issues) ? parsed.audit.issues.length : 0,
      kanban: kanbanInfo
    });
  }

  return handled;
}

/**
 * Analyze single module (static / legacy)
 */
async function analyzeSingleModuleStatic(mod, ctx, options) {
  const { root, config } = ctx;
  const { skipDoc, skipAudit } = options;

  const modulePath = normalizeModulePath(mod.path);
  const absModuleDir = path.join(root, modulePath);
  const files = Array.isArray(mod.files) ? mod.files : await findCodeFiles(absModuleDir);

  const analysis = {
    path: modulePath,
    success: true,
    files: files.length,
    exports: [],
    jsdocCoverage: 0,
    issues: []
  };

  // Analyze each file
  for (const file of files) {
    const absPath = path.join(absModuleDir, file);
    let content;
    try {
      content = await fs.readFile(absPath, 'utf8');
    } catch {
      continue;
    }

    // Extract exports
    const exports = extractExports(content, config.language);
    analysis.exports.push(...exports.map(e => ({ file, name: e })));

    // Check JSDoc coverage
    const jsdoc = analyzeJSDoc(content, exports);
    analysis.jsdocCoverage += jsdoc.coverage;

    // Find issues
    if (!skipAudit) {
      const issues = findCodeIssues(content, file);
      analysis.issues.push(...issues);
    }
  }

  // Calculate average coverage
  if (files.length > 0) {
    analysis.jsdocCoverage = Math.round(analysis.jsdocCoverage / files.length);
  }

  // Generate CLAUDE.md if not skipped
  if (!skipDoc) {
    const docPath = path.join(absModuleDir, 'CLAUDE.md');
    const docContent = generateModuleDoc({ path: modulePath }, analysis, config);
    await fs.writeFile(docPath, docContent);
  }

  // Generate AUDIT.md if issues found
  if (!skipAudit && analysis.issues.length > 0) {
    const auditPath = path.join(absModuleDir, 'AUDIT.md');
    const auditContent = generateAuditDoc({ path: modulePath }, analysis);
    await fs.writeFile(auditPath, auditContent);
  }

  return analysis;
}

/**
 * Extract exports from code
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
        const name = s.trim().split(/\s+as\s+/).pop().trim();
        if (name) exports.push(name);
      });
    }

    if (/export\s+default/.test(content)) exports.push('default');
  } else if (language === 'python') {
    const defRe = /^(def|class)\s+(\w+)/gm;
    let m;
    while ((m = defRe.exec(content))) exports.push(m[2]);
  }

  return [...new Set(exports)];
}

/**
 * Analyze JSDoc coverage
 */
function analyzeJSDoc(content, exports) {
  let documented = 0;

  for (const exp of exports) {
    // Check if there's a JSDoc comment before the export
    const pattern = new RegExp(`\\/\\*\\*[\\s\\S]*?\\*/\\s*(?:export\\s+)?(?:function|const|let|var|class|async\\s+function)\\s+${exp}\\b`);
    if (pattern.test(content)) {
      documented++;
    }
  }

  return {
    total: exports.length,
    documented,
    coverage: exports.length > 0 ? Math.round((documented / exports.length) * 100) : 100
  };
}

/**
 * Find code issues (security, quality)
 */
function findCodeIssues(content, file) {
  const issues = [];
  const lines = content.split('\n');

  const patterns = [
    { re: /\beval\s*\(/g, type: 'security', severity: 'high', msg: 'eval() usage' },
    { re: /\bconsole\.(log|debug)\s*\(/g, type: 'quality', severity: 'low', msg: 'console statement' },
    { re: /\bdebugger\b/g, type: 'quality', severity: 'medium', msg: 'debugger statement' },
    { re: /(password|secret|api_key)\s*[=:]\s*['"][^'"]+['"]/gi, type: 'security', severity: 'high', msg: 'Hardcoded secret' },
    { re: /TODO|FIXME|HACK|XXX/g, type: 'todo', severity: 'info', msg: 'TODO comment' }
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { re, type, severity, msg } of patterns) {
      if (re.test(line)) {
        issues.push({ file, line: i + 1, type, severity, message: msg });
        re.lastIndex = 0; // Reset regex
      }
    }
  }

  return issues;
}

/**
 * Generate module documentation
 */
function generateModuleDoc(mod, analysis, config) {
  const lines = [];
  lines.push(`# ${path.basename(mod.path)}\n`);
  lines.push(`Module: \`${mod.path}\`\n`);

  lines.push('## Statistics\n');
  lines.push(`- Files: ${analysis.files}`);
  lines.push(`- Exports: ${analysis.exports.length}`);
  lines.push(`- JSDoc Coverage: ${analysis.jsdocCoverage}%`);
  lines.push(`- Issues: ${analysis.issues.length}`);
  lines.push('');

  lines.push('## Files\n');
  lines.push('| File | Exports |');
  lines.push('|------|---------|');
  const fileExports = {};
  for (const exp of analysis.exports) {
    if (!fileExports[exp.file]) fileExports[exp.file] = [];
    fileExports[exp.file].push(exp.name);
  }
  for (const [file, exps] of Object.entries(fileExports)) {
    lines.push(`| \`${file}\` | ${exps.slice(0, 5).join(', ')}${exps.length > 5 ? '...' : ''} |`);
  }
  lines.push('');

  lines.push('## Usage\n');
  lines.push('```javascript');
  lines.push(`import { ... } from './${path.basename(mod.path)}';`);
  lines.push('```\n');

  return lines.join('\n');
}

/**
 * Generate audit documentation
 */
function generateAuditDoc(mod, analysis) {
  const lines = [];
  lines.push(`# Audit: ${path.basename(mod.path)}\n`);
  lines.push(`Generated: ${new Date().toISOString()}\n`);

  // Group by severity
  const bySeverity = { high: [], medium: [], low: [], info: [] };
  for (const issue of analysis.issues) {
    bySeverity[issue.severity]?.push(issue);
  }

  for (const sev of ['high', 'medium', 'low', 'info']) {
    const items = bySeverity[sev];
    if (items.length === 0) continue;

    lines.push(`## ${sev.toUpperCase()} (${items.length})\n`);
    for (const item of items.slice(0, 20)) {
      lines.push(`- [ ] \`${item.file}:${item.line}\` - ${item.message}`);
    }
    if (items.length > 20) lines.push(`- ... +${items.length - 20} more`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Find code files in directory (recursive)
 */
async function findCodeFiles(dir) {
  const files = [];

  async function walk(d, prefix = '') {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        await walk(path.join(d, entry.name), path.join(prefix, entry.name));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (CODE_EXTENSIONS.has(ext)) {
          files.push(path.join(prefix, entry.name).replace(/\\/g, '/'));
        }
      }
    }
  }

  await walk(dir);
  return files;
}
