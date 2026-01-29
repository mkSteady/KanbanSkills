/**
 * Task manager - Centralized task management
 * Tracks running tasks, supports cancellation and retry
 */

import { promises as fs } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { readJsonSafe, writeJsonSafe } from '../shared.js';
import { getCachePath, loadContext } from '../context.js';

/** @typedef {import('../types.js').ProjectConfig} ProjectConfig */

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(THIS_DIR, '../../cli.js');

/**
 * Available task types
 */
export const TASK_TYPES = {
  'module-analyzer': {
    command: 'pi module analyze',
    description: '文档更新 + 代码审计',
    args: {
      '--stale': '仅过期模块 (默认)',
      '--missing': '仅缺失文档/审计',
      '--all': '过期 + 缺失',
      '--force': '强制刷新全部大目录',
      '--no-kanban': '不创建 Kanban 任务',
      '--no-doc': '跳过文档更新',
      '--no-audit': '跳过审计',
      '--dry-run': '只预览，不执行',
      '--concurrency': '并发数 (默认 6)'
    }
  },
  'update-bg': {
    command: 'pi update --bg --daemon',
    description: '后台增量更新',
    args: {
      '--interval': '轮询间隔 (ms, 默认 60000)',
      '--only': '仅更新 deps|test|doc',
      '--force': '强制刷新 (忽略缓存时间)'
    }
  },
  'check-stale': {
    command: 'pi doc check',
    description: '检测过期模块',
    args: {
      '--type': '类型: doc|claude|audit|test|all',
      '--json': 'JSON 输出',
      '--stale-only': '只显示过期/缺失'
    }
  },
  'test-status': {
    command: 'pi test status',
    description: '测试覆盖率分析',
    args: {
      '--json': 'JSON 输出'
    }
  },
  'test-analyzer': {
    command: 'pi test analyze',
    description: '测试质量检测',
    args: {
      '--summary': '只显示摘要',
      '--fix': '显示修复建议',
      '--json': 'JSON 输出'
    }
  },
  'scan': {
    command: 'pi doc scan',
    description: '扫描项目结构',
    args: {
      '--type': '类型: doc|claude|audit|test|all',
      '--json': 'JSON 输出',
      '--stale-only': '只显示过期/缺失'
    }
  },
  'generate': {
    command: 'pi doc generate --force',
    description: '生成 CLAUDE.md (基础模板)',
    args: {
      '--dry-run': '只预览，不执行'
    }
  },
  'test-fix': {
    command: 'pi test fix',
    description: '测试错误自动修复',
    args: {
      '--dry-run': '只预览，不执行',
      '--concurrency': '并发数 (默认 5)',
      '--limit': '最多修复 N 个文件',
      '--llm': '启用 LLM 模式'
    }
  },
  'test-generator': {
    command: 'pi test generate',
    description: '批量生成测试文件',
    args: {
      '--dry-run': '只预览，不执行',
      '--concurrency': '并发数 (默认 3)',
      '--llm': '启用 LLM 模式'
    }
  },
  'audit-fix': {
    command: 'pi audit fix',
    description: '审计问题自动修复',
    args: {
      '--dry-run': '只预览，不执行',
      '--severity': '只修复指定级别 (LOW/MEDIUM/HIGH/CRITICAL)',
      '--module': '只修复指定模块',
      '--concurrency': '并发数 (默认 3)'
    }
  },
  'test-result': {
    command: 'pi test result',
    description: '测试结果提取',
    args: {
      '--json': 'JSON 输出'
    }
  },
  'deps-build': {
    command: 'pi deps build',
    description: 'Build dependency graph',
    args: {}
  },
  'audit-scan': {
    command: 'pi audit scan',
    description: 'Code audit scan',
    args: {
      '--severity': 'Min severity level'
    }
  }
};

/**
 * Task Manager class
 */
export class TaskManager {
  /**
   * @param {{root: string, config: ProjectConfig}} ctx
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.pidsPath = getCachePath(ctx.config, ctx.root, '.task-pids.json');
    /** @type {Map<string, Map<string, number>>} */
    this.runningPids = new Map();
  }

  /**
   * Get tasks file path for a task name
   */
  getTasksFile(name) {
    return getCachePath(this.ctx.config, this.ctx.root, `.${name}-tasks.json`);
  }

  /**
   * Get tasks file path in project root (legacy fallback)
   */
  getRootTasksFile(name) {
    return path.join(this.ctx.root, `.${name}-tasks.json`);
  }

  /**
   * Load running PIDs from file
   * Supports legacy flat format: { [taskId]: pid }
   * Current format: { [name]: { [taskId]: pid } }
   */
  async loadPids() {
    const data = await readJsonSafe(this.pidsPath, {});
    const entries = data && typeof data === 'object' ? Object.entries(data) : [];

    const next = new Map();

    // Legacy flat: values are numbers
    const looksFlat = entries.length > 0 && entries.every(([, v]) => typeof v === 'number' || typeof v === 'string');
    if (looksFlat) {
      const knownNames = Object.keys(TASK_TYPES).sort((a, b) => b.length - a.length);

      for (const [taskId, rawPid] of entries) {
        const pid = Number(rawPid);
        if (!Number.isFinite(pid) || pid <= 0) continue;

        const idStr = String(taskId);
        const inferred = knownNames.find((n) => idStr === n || idStr.startsWith(`${n}-`));
        const name = inferred || idStr.split('-')[0] || 'unknown';
        if (!next.has(name)) next.set(name, new Map());
        next.get(name).set(idStr, pid);
      }
      this.runningPids = next;
      await this.savePids(); // migrate forward
      return;
    }

    // Nested: name -> { taskId: pid }
    for (const [name, pids] of entries) {
      if (!pids || typeof pids !== 'object') continue;
      const map = new Map();
      for (const [taskId, rawPid] of Object.entries(pids)) {
        const pid = Number(rawPid);
        if (!Number.isFinite(pid) || pid <= 0) continue;
        map.set(String(taskId), pid);
      }
      next.set(String(name), map);
    }

    this.runningPids = next;
  }

  /**
   * Save PIDs to file
   */
  async savePids() {
    const data = {};
    for (const [name, pids] of this.runningPids) {
      data[name] = Object.fromEntries(pids);
    }
    await writeJsonSafe(this.pidsPath, data);
  }

  /**
   * Register a running task's PID
   * @param {string} name
   * @param {string} taskId
   * @param {number} pid
   */
  async registerPid(name, taskId, pid) {
    if (!this.runningPids.has(name)) {
      this.runningPids.set(name, new Map());
    }
    this.runningPids.get(name).set(taskId, pid);
    await this.savePids();
  }

  /**
   * Unregister a task's PID
   * @param {string} name
   * @param {string} taskId
   */
  async unregisterPid(name, taskId) {
    const bucket = this.runningPids.get(name);
    if (!bucket) return;
    bucket.delete(taskId);
    if (bucket.size === 0) this.runningPids.delete(name);
    await this.savePids();
  }

  /**
   * Read task status data
   * @param {string} name
   */
  async getTaskStatus(name) {
    const cacheFile = this.getTasksFile(name);
    const cacheData = await readJsonSafe(cacheFile, null);
    if (cacheData) return cacheData;

    const rootFile = this.getRootTasksFile(name);
    return await readJsonSafe(rootFile, null);
  }

  /**
   * @param {any} data
   * @returns {{key: 'tasks'|'items', tasks: any[]}}
   */
  getTasksArray(data) {
    if (Array.isArray(data?.tasks)) return { key: 'tasks', tasks: data.tasks };
    if (Array.isArray(data?.items)) return { key: 'items', tasks: data.items };
    return { key: 'tasks', tasks: [] };
  }

  /**
   * @param {any[]} tasks
   */
  buildSummary(tasks) {
    const list = Array.isArray(tasks) ? tasks : [];
    return {
      total: list.length,
      pending: list.filter(t => t.status === 'pending').length,
      running: list.filter(t => t.status === 'running').length,
      completed: list.filter(t => t.status === 'completed').length,
      failed: list.filter(t => t.status === 'failed').length,
      timeout: list.filter(t => t.status === 'timeout').length,
      cancelled: list.filter(t => t.status === 'cancelled').length
    };
  }

  /**
   * Update task state in file
   * @param {string} name
   * @param {string} taskId
   * @param {Record<string, any>} updates
   */
  async updateTaskState(name, taskId, updates) {
    const cacheFile = this.getTasksFile(name);
    const rootFile = this.getRootTasksFile(name);

    const cacheData = await readJsonSafe(cacheFile, null);
    const rootData = cacheData ? null : await readJsonSafe(rootFile, null);

    const tasksFile = cacheData ? cacheFile : (rootData ? rootFile : cacheFile);
    const data = cacheData || rootData || { tasks: [] };

    const bucket = this.getTasksArray(data);
    const taskIndex = bucket.tasks.findIndex(t => t.id === taskId);
    if (taskIndex === -1) {
      return { success: false, error: 'Task not found' };
    }

    bucket.tasks[taskIndex] = { ...bucket.tasks[taskIndex], ...updates };
    data[bucket.key] = bucket.tasks;
    data.summary = this.buildSummary(bucket.tasks);
    data.updatedAt = new Date().toISOString();

    await writeJsonSafe(tasksFile, data);
    return { success: true };
  }

  /**
   * Delete a task from state
   * @param {string} name
   * @param {string} taskId
   */
  async deleteTask(name, taskId) {
    const cacheFile = this.getTasksFile(name);
    const rootFile = this.getRootTasksFile(name);

    const cacheData = await readJsonSafe(cacheFile, null);
    const rootData = cacheData ? null : await readJsonSafe(rootFile, null);

    const tasksFile = cacheData ? cacheFile : (rootData ? rootFile : cacheFile);
    const data = cacheData || rootData || { tasks: [] };

    const bucket = this.getTasksArray(data);
    const taskIndex = bucket.tasks.findIndex(t => t.id === taskId);
    if (taskIndex === -1) {
      return { success: false, error: 'Task not found' };
    }

    const task = bucket.tasks[taskIndex];
    if (task?.status === 'running') {
      return { success: false, error: 'Cannot delete running task, cancel first' };
    }

    bucket.tasks.splice(taskIndex, 1);
    data[bucket.key] = bucket.tasks;
    data.summary = this.buildSummary(bucket.tasks);
    data.updatedAt = new Date().toISOString();

    await writeJsonSafe(tasksFile, data);
    return { success: true };
  }

  /**
   * Delete all completed tasks
   * @param {string} name
   */
  async deleteCompletedTasks(name) {
    const cacheFile = this.getTasksFile(name);
    const rootFile = this.getRootTasksFile(name);

    const cacheData = await readJsonSafe(cacheFile, null);
    const rootData = cacheData ? null : await readJsonSafe(rootFile, null);

    const tasksFile = cacheData ? cacheFile : (rootData ? rootFile : cacheFile);
    const data = cacheData || rootData || { tasks: [] };

    const bucket = this.getTasksArray(data);

    const before = bucket.tasks.length;
    const next = bucket.tasks.filter(t => t.status !== 'completed');
    const deleted = before - next.length;

    data[bucket.key] = next;
    data.summary = this.buildSummary(next);
    data.updatedAt = new Date().toISOString();

    await writeJsonSafe(tasksFile, data);
    return { success: true, deleted };
  }

  /**
   * Cancel a running task (dashboard API)
   * - If PID is tracked, send SIGTERM and unregister it
   * - Mark task as cancelled in the task state file
   *
   * @param {string} name
   * @param {string} taskId
   */
  async cancelTask(name, taskId) {
    await this.loadPids();

    const bucket = this.runningPids.get(name);
    const pid = bucket?.get(taskId);

    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch (err) {
        // Process may already be gone
        if (err?.code !== 'ESRCH') throw err;
      }
      await this.unregisterPid(name, taskId);
    }

    return await this.updateTaskState(name, taskId, {
      status: 'cancelled',
      completedAt: new Date().toISOString(),
      error: 'Cancelled by user'
    });
  }

  /**
   * Get list of failed/timeout tasks for retry
   * @param {string} name
   */
  async getFailedTasks(name) {
    const data = await this.getTaskStatus(name);
    const bucket = this.getTasksArray(data);
    return bucket.tasks.filter(t =>
      t.status === 'failed' || t.status === 'timeout' || t.status === 'cancelled'
    );
  }

  /**
   * Start a task
   * @param {string} taskType
   * @param {string[]} args
   * @returns {Promise<{taskId: string, pid: number}>}
   */
  async start(taskType, args = []) {
    const taskDef = TASK_TYPES[taskType];
    if (!taskDef) {
      throw new Error(`Unknown task type: ${taskType}`);
    }

    const taskId = `${taskType}-${Date.now()}`;
    const [cmd, ...cmdArgs] = taskDef.command.split(' ');
    const resolved = cmd === 'pi'
      ? { cmd: process.execPath, args: [CLI_PATH, ...cmdArgs] }
      : { cmd, args: cmdArgs };

    const child = spawn(resolved.cmd, [...resolved.args, ...args], {
      cwd: this.ctx.root,
      stdio: 'inherit',
      detached: true
    });

    child.unref();

    await this.loadPids();
    await this.registerPid(taskType, taskId, child.pid);

    return { taskId, pid: child.pid };
  }

  /**
   * Cancel a running task
   * @param {string} taskId
   */
  async cancel(taskId) {
    await this.loadPids();
    let found = null;
    for (const [name, pids] of this.runningPids) {
      if (pids.has(taskId)) {
        found = { name, pid: pids.get(taskId) };
        break;
      }
    }

    if (!found?.pid) {
      throw new Error(`Task not found: ${taskId}`);
    }

    try {
      process.kill(found.pid, 'SIGTERM');
      await this.unregisterPid(found.name, taskId);
      return true;
    } catch (err) {
      if (err.code === 'ESRCH') {
        // Process already gone
        await this.unregisterPid(found.name, taskId);
        return true;
      }
      throw err;
    }
  }

  /**
   * List running tasks
   */
  async list() {
    await this.loadPids();
    const tasks = [];

    /** @type {Array<{name: string, taskId: string}>} */
    const dead = [];

    for (const [name, pids] of this.runningPids) {
      for (const [taskId, pid] of pids) {
        let running = false;
        try {
          process.kill(pid, 0); // Check if running
          running = true;
        } catch {
          // Not running
        }
        tasks.push({ name, taskId, pid, running });
        if (!running) dead.push({ name, taskId });
      }
    }

    // Clean up dead tasks
    for (const t of dead) {
      const bucket = this.runningPids.get(t.name);
      if (!bucket) continue;
      bucket.delete(t.taskId);
      if (bucket.size === 0) this.runningPids.delete(t.name);
    }
    if (dead.length > 0) await this.savePids();

    return tasks.filter(t => t.running);
  }

  /**
   * Get task types
   */
  getTypes() {
    return TASK_TYPES;
  }

  /**
   * Launch a task type from GUI (detached background)
   * @param {string} type
   * @param {string[]} args
   * @param {string} cwd
   */
  async launchTask(type, args = [], cwd = this.ctx?.root || process.cwd()) {
    const taskDef = TASK_TYPES[type];
    if (!taskDef) {
      return {
        success: false,
        pid: null,
        type,
        args,
        message: `Unknown task type: ${type}`,
        error: `Unknown task type: ${type}`
      };
    }

    try {
      await fs.access(CLI_PATH);
    } catch {
      return {
        success: false,
        pid: null,
        type,
        args,
        message: 'CLI entry not found',
        error: `CLI entry not found: ${CLI_PATH}`
      };
    }

    const [cmd, ...cmdArgs] = taskDef.command.split(' ');
    const resolved = cmd === 'pi'
      ? { cmd: process.execPath, args: [CLI_PATH, ...cmdArgs] }
      : { cmd, args: cmdArgs };

    const child = spawn(resolved.cmd, [...resolved.args, ...args], {
      cwd,
      detached: true,
      stdio: 'ignore'
    });
    child.unref();

    return {
      success: true,
      pid: child.pid,
      type,
      args,
      message: `Started ${type} (PID: ${child.pid})`
    };
  }

  /**
   * Get available task types (GUI-friendly list)
   */
  getTaskTypes() {
    return Object.entries(TASK_TYPES).map(([name, def]) => ({
      name,
      command: def.command,
      description: def.description,
      args: def.args
    }));
  }
}

/**
 * CLI handler for task commands
 */
export async function handleTask(subcommand, args, ctx) {
  const manager = new TaskManager(ctx);

  switch (subcommand) {
    case 'list': {
      const tasks = await manager.list();
      if (tasks.length === 0) {
        console.log('No running tasks.');
      } else {
        console.log('Running tasks:');
        for (const t of tasks) {
          console.log(`  ${t.taskId} (PID: ${t.pid})`);
        }
      }
      break;
    }

    case 'start': {
      const taskType = args._[3];
      if (!taskType) {
        console.log('Available tasks:');
        for (const [name, def] of Object.entries(TASK_TYPES)) {
          console.log(`  ${name}: ${def.description}`);
        }
        console.log('\nUsage: pi task start <type> [args...]');
        return;
      }

      const taskArgs = args._.slice(4);
      const { taskId, pid } = await manager.start(taskType, taskArgs);
      console.log(`Started task ${taskId} (PID: ${pid})`);
      break;
    }

    case 'cancel': {
      const taskId = args._[3];
      if (!taskId) {
        console.error('Usage: pi task cancel <taskId>');
        process.exitCode = 1;
        return;
      }

      await manager.cancel(taskId);
      console.log(`Cancelled task ${taskId}`);
      break;
    }

    case 'types': {
      console.log('Available task types:');
      for (const [name, def] of Object.entries(TASK_TYPES)) {
        console.log(`\n${name}: ${def.description}`);
        for (const [arg, desc] of Object.entries(def.args)) {
          console.log(`  ${arg}: ${desc}`);
        }
      }
      break;
    }

    default:
      console.error(`Unknown task subcommand: ${subcommand}`);
      console.error('Available: list, start, cancel, types');
      process.exitCode = 1;
  }
}

// Standalone CLI interface (for dashboard integrations)
async function main() {
  const argv = process.argv.slice(2);
  const managerCtx = await loadContext();
  const manager = new TaskManager(managerCtx);

  if (argv[0] === '--list-types') {
    console.log(JSON.stringify(manager.getTaskTypes(), null, 2));
    return;
  }

  if (argv[0] === '--cancel' && argv[1] && argv[2]) {
    const name = argv[1];
    const id = argv[2];
    await manager.loadPids();
    const pids = manager.runningPids.get(name);
    const pid = pids?.get(id);
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
      await manager.unregisterPid(name, id);
    }
    const result = await manager.updateTaskState(name, id, {
      status: 'cancelled',
      completedAt: new Date().toISOString(),
      error: 'Cancelled by user'
    });
    console.log(JSON.stringify(result));
    return;
  }

  if (argv[0] === '--delete' && argv[1] && argv[2]) {
    const result = await manager.deleteTask(argv[1], argv[2]);
    console.log(JSON.stringify(result));
    return;
  }

  if (argv[0] === '--delete-completed' && argv[1]) {
    const result = await manager.deleteCompletedTasks(argv[1]);
    console.log(JSON.stringify(result));
    return;
  }

  if (argv[0] === '--launch' && argv[1]) {
    const taskArgs = argv.slice(2);
    const result = await manager.launchTask(argv[1], taskArgs, managerCtx.root);
    console.log(JSON.stringify(result));
    return;
  }

  console.log(`Task Manager - Dashboard Task Operations

Usage:
  node lib/task/manager.js --list-types              List available task types
  node lib/task/manager.js --cancel <name> <id>      Cancel running task
  node lib/task/manager.js --delete <name> <id>      Delete task record
  node lib/task/manager.js --delete-completed <name> Delete all completed tasks
  node lib/task/manager.js --launch <type> [args]    Launch a task
`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err?.stack || err?.message || String(err));
    process.exitCode = 1;
  });
}
