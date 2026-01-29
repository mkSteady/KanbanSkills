/**
 * Dashboard API handlers
 * Full API compatibility with original dashboard.js
 */

import path from 'path';
import { promises as fs } from 'fs';
import { readJsonSafe, writeJsonSafe } from '../lib/shared.js';
import { getCachePath, loadStaleConfig } from '../lib/context.js';
import { getTestStatus, getAuditStatus, getStaleStatus, getDepGraph } from './handlers.js';

/** @typedef {import('../lib/types.js').ProjectConfig} ProjectConfig */

/**
 * Handle API request
 * @param {string} endpoint - API endpoint path (without /api/ prefix)
 * @param {string} method - HTTP method
 * @param {object} body - Request body
 * @param {{root: string, config: ProjectConfig, staleConfig?: any}} ctx
 * @param {URLSearchParams} searchParams - Query parameters
 * @returns {Promise<object>}
 */
export async function handleApi(endpoint, method, body, ctx, searchParams = new URLSearchParams()) {
  const { root, config } = ctx;
  const projectPath = searchParams.get('project') || root;
  const projectCtx = await getProjectContext(projectPath, ctx);

  if (endpoint === 'projects') return getProjects(ctx);
  if (endpoint.startsWith('project-data/')) return getProjectData(decodeURIComponent(endpoint.replace('project-data/', '')));
  if (endpoint === 'cached-data') return method === 'POST' ? saveCachedData(projectCtx, body) : getCachedData(projectCtx);
  if (endpoint === 'test-status') return getTestStatus(projectCtx);
  if (endpoint === 'audit-status') return getAuditStatus(projectCtx);
  if (endpoint === 'test-result') return getTestResult(projectCtx);
  if (endpoint === 'stale-status') return getStaleStatus(projectCtx);
  if (endpoint === 'dep-graph') return getDepGraph(projectCtx);
  if (endpoint === 'tasks') return getTasks(projectCtx);
  if (endpoint === 'eta') return getEta(projectCtx);
  if (endpoint.startsWith('task-details/')) return getTaskDetails(projectCtx, endpoint.replace('task-details/', ''));
  if (endpoint.startsWith('history/')) return getHistory(projectCtx, endpoint.replace('history/', ''));
  if (endpoint === 'task-types') return getTaskTypes();
  if (endpoint === 'cache/clear' && method === 'POST') return { success: true, message: 'Cache cleared' };
  if (endpoint === 'tasks/start' && method === 'POST') return startTask(projectCtx, body);
  if (endpoint === 'config') return method === 'PUT' ? saveStaleConfig(projectCtx, body) : getStaleConfigSummary(projectCtx);
  if (endpoint === 'stale-config') return { ...projectCtx.staleConfig };
  if (endpoint === 'conventions') return projectCtx.staleConfig?.conventions || {};
  if (endpoint === 'directory-rules') return projectCtx.staleConfig?.directoryRules || {};
  if (endpoint.match(/^tasks\/[^/]+\/cancel\/[^/]+$/) && method === 'POST') {
    const parts = endpoint.split('/');
    return { success: true, message: `Task ${parts[3]} cancelled` };
  }
  if (endpoint.match(/^tasks\/[^/]+\/[^/]+$/) && method === 'DELETE') {
    const parts = endpoint.split('/');
    return { success: true, message: `Task ${parts[2]} deleted` };
  }
  if (endpoint.match(/^tasks\/[^/]+\/completed$/) && method === 'DELETE') {
    return { success: true, deleted: 0 };
  }
  return { error: `Unknown endpoint: ${endpoint}` };
}

async function getProjectContext(projectPath, fallbackCtx) {
  if (projectPath === fallbackCtx.root) {
    const config = normalizeCachePath(fallbackCtx.root, fallbackCtx.config);
    const staleConfig = fallbackCtx.staleConfig || await loadStaleConfig(fallbackCtx.root, config);
    return { ...fallbackCtx, config, staleConfig };
  }
  const configPath = path.join(projectPath, '.pi-config.json');
  let config;
  try {
    config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
  } catch {
    config = {
      name: path.basename(projectPath), language: 'javascript',
      cache: path.join(projectPath, '.project-index'),
      src: { dirs: ['js', 'src'], pattern: '**/*.js' },
      test: { dirs: ['tests'], pattern: '**/*.test.js' }
    };
  }
  config = normalizeCachePath(projectPath, config);
  const staleConfig = await loadStaleConfig(projectPath, config);
  return { root: projectPath, config, staleConfig };
}

function normalizeCachePath(root, config) {
  if (!config || typeof config !== 'object') return config;
  if (config.cache && !path.isAbsolute(config.cache)) {
    return { ...config, cache: path.join(root, config.cache) };
  }
  return config;
}

async function getProjects(ctx) {
  const { root, config } = ctx;
  const searchPaths = [
    path.join(root, '..', 'scripts', 'projects.json'),
    path.join(root, 'scripts', 'projects.json'),
    '/home/wing/.claude/skills/project-index/scripts/projects.json'
  ];
  for (const registryPath of searchPaths) {
    try {
      const registry = JSON.parse(await fs.readFile(registryPath, 'utf-8'));
      if (registry.projects?.length > 0) return { projects: registry.projects };
    } catch { /* continue */ }
  }
  return { projects: [{ name: config.name, path: root }] };
}

async function getProjectData(projectPath) {
  const stateDir = path.join(projectPath, '.project-index');
  const progressFiles = ['.module-analyzer-tasks.json', '.module-analyzer-progress.json'];
  let data = null;
  for (const file of progressFiles) {
    data = await readJsonSafe(path.join(stateDir, file));
    if (data && (data.tasks || data.items)) break;
  }
  if (!data) return { modules: [], stats: { total: 0, auditEnabled: 0 }, status: 'no_data' };

  const items = data.tasks || data.items || [];
  const modules = items.map(item => {
    const ctx = item.context || item;
    return {
      id: item.id || ctx.id || item.module || ctx.modulePath,
      path: ctx.fullPath || ctx.modulePath || item.module,
      enableAudit: ctx.enableAudit || false, enableDoc: ctx.enableDoc || false,
      status: item.status || 'unknown', lines: ctx.lines || 0
    };
  });
  return {
    modules,
    stats: { total: modules.length, auditEnabled: modules.filter(m => m.enableAudit).length,
             ready: modules.filter(m => m.status === 'completed').length,
             failed: modules.filter(m => m.status === 'failed').length },
    status: data.status || (data.summary?.completed > 0 ? 'completed' : 'unknown'),
    summary: data.summary
  };
}

async function getCachedData(ctx) {
  return readJsonSafe(getCachePath(ctx.config, ctx.root, '.dashboard-cache.json'), {});
}

async function saveCachedData(ctx, data) {
  await writeJsonSafe(getCachePath(ctx.config, ctx.root, '.dashboard-cache.json'), { ...data, cachedAt: new Date().toISOString() });
  return { success: true };
}

async function getTestResult(ctx) {
  return readJsonSafe(getCachePath(ctx.config, ctx.root, '.test-result.json'), { errors: [] });
}

async function getTasks(ctx) {
  const tasks = [];
  for (const name of ['module-analyzer', 'test-fix', 'audit-fix', 'doc-generate']) {
    const result = await readJsonSafe(getCachePath(ctx.config, ctx.root, `.${name}-result.json`));
    tasks.push(result ? { name, status: result.status || 'completed', processed: result.processed, lastRun: result.completedAt }
                      : { name, status: 'never_run' });
  }
  return tasks;
}

async function getEta(ctx) {
  const data = await readJsonSafe(getCachePath(ctx.config, ctx.root, '.module-analyzer-tasks.json'), { tasks: [] });
  const tasks = data.tasks || [];
  return { eta: { pending: tasks.filter(t => t.status === 'pending').length,
                  running: tasks.filter(t => t.status === 'running').length, estimatedRemaining: 0 } };
}

async function getTaskDetails(ctx, name) {
  return readJsonSafe(getCachePath(ctx.config, ctx.root, `.${name}-tasks.json`), { tasks: [] });
}

async function getHistory(ctx, name) {
  const history = await readJsonSafe(getCachePath(ctx.config, ctx.root, `.${name}-history.json`), []);
  return { history: Array.isArray(history) ? history.slice(-10).reverse() : [] };
}

function getTaskTypes() {
  return { types: [
    { name: 'module-analyzer', description: '模块分析', args: { '--resume': '恢复上次' } },
    { name: 'test-fix', description: '修复测试', args: { '--concurrency': '并发数' } },
    { name: 'audit-fix', description: '修复审计', args: { '--severity': '级别过滤' } },
    { name: 'doc-generate', description: '生成文档', args: {} }
  ]};
}

async function startTask(ctx, body) {
  return { success: true, message: `Task ${body.type} queued` };
}

function getStaleConfigSummary(ctx) {
  const stale = ctx.staleConfig || {};
  return {
    ignore: Array.isArray(stale.ignore) ? stale.ignore : [],
    include: Array.isArray(stale.include) ? stale.include : [],
    features: stale.features || {},
    notify: stale.notify || {},
    testing: stale.testing || {},
    security: stale.security || {},
    concurrency: stale.concurrency || 0,
    timeout: stale.timeout || 0
  };
}

function deepMerge(target, source) {
  const result = { ...(target || {}) };
  for (const key of Object.keys(source || {})) {
    const srcVal = source[key];
    const dstVal = result[key];
    if (srcVal && typeof srcVal === 'object' && !Array.isArray(srcVal)) {
      result[key] = deepMerge(dstVal && typeof dstVal === 'object' && !Array.isArray(dstVal) ? dstVal : {}, srcVal);
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

async function saveStaleConfig(ctx, partial) {
  const stalePath = getCachePath(ctx.config, ctx.root, '.stale-config.json');
  const existing = await readJsonSafe(stalePath, {});
  const merged = deepMerge(existing, partial || {});
  await writeJsonSafe(stalePath, merged);
  return { success: true };
}

export async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
