/**
 * Batch LLM runner with concurrency control, retry logic, and DAG scheduling
 * Supports multiple providers: claude-cli, anthropic API, openai API, codeagent-wrapper
 */

import { spawn } from 'child_process';
import { runCommand, parallelMap } from '../shared.js';

/**
 * @typedef {'pending' | 'running' | 'completed' | 'failed'} TaskStatus
 */

/**
 * @callback OnStatusChange
 * @param {string} taskId
 * @param {TaskStatus} status
 * @param {object} [info]
 */

/** @typedef {import('../types.js').ProjectConfig} ProjectConfig */

/**
 * @typedef {object} LLMTask
 * @property {string} id - Task identifier
 * @property {string} prompt - The prompt to send
 * @property {string[]} [dependencies] - DAG dependencies (task IDs that must complete first)
 * @property {object} [context] - Additional context (workdir, dependencies, etc.)
 */

/**
 * @typedef {object} LLMResult
 * @property {string} id - Task identifier
 * @property {boolean} success
 * @property {string} [output] - LLM response
 * @property {string} [error] - Error message if failed
 * @property {number} retries - Number of retries used
 */

/**
 * Run LLM tasks in batch with concurrency control and DAG scheduling
 * @param {LLMTask[]} tasks
 * @param {object} options
 * @param {number} [options.concurrency=5]
 * @param {number} [options.maxRetries=3]
 * @param {number} [options.retryDelay=1000]
 * @param {ProjectConfig} [options.config]
 * @param {string} [options.workdir] - Working directory for codeagent
 * @param {OnStatusChange} [options.onStatusChange] - Status callback
 * @returns {Promise<LLMResult[]>}
 */
export async function runBatch(tasks, options = {}) {
  const {
    concurrency = 5,
    maxRetries = 3,
    retryDelay = 1000,
    config,
    workdir,
    onStatusChange
  } = options;

  const provider = config?.llm?.provider || 'claude-cli';
  const backend = config?.llm?.backend || 'codex';

  // Check if any task has dependencies (DAG mode)
  const hasDependencies = tasks.some(t =>
    (Array.isArray(t.dependencies) && t.dependencies.length > 0) ||
    (Array.isArray(t.context?.dependencies) && t.context.dependencies.length > 0)
  );

  // For codeagent providers with many tasks and no dependencies, use parallel mode
  const isCodeagent = ['codeagent', 'codeagent-wrapper', 'codex', 'gemini'].includes(provider);
  if (isCodeagent && tasks.length > 3 && !hasDependencies) {
    return runBatchParallel(tasks, {
      backend: provider === 'codeagent' || provider === 'codeagent-wrapper' ? backend : provider,
      workdir: workdir || config?.root || process.cwd(),
      timeout: config?.llm?.timeout || 600000,
      onStatusChange
    });
  }

  console.log(`Running ${tasks.length} LLM tasks (concurrency: ${concurrency}, provider: ${provider}${hasDependencies ? ', DAG mode' : ''})`);

  const providerOptions = {
    backend,
    workdir: workdir || config?.root || process.cwd(),
    timeout: config?.llm?.timeout || 600000
  };

  // Use DAG scheduling
  const results = await runWithConcurrency(
    tasks,
    concurrency,
    async (task) => {
      const result = await runWithRetry(task, provider, maxRetries, retryDelay, providerOptions);
      return result;
    },
    onStatusChange
  );

  // Summary
  const succeeded = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  console.log(`\nCompleted: ${succeeded} succeeded, ${failed} failed`);

  return results;
}

/**
 * Run single task with retry
 * @param {LLMTask} task
 * @param {string} provider
 * @param {number} maxRetries
 * @param {number} retryDelay
 * @param {object} [providerOptions] - Options passed to provider
 * @returns {Promise<LLMResult>}
 */
async function runWithRetry(task, provider, maxRetries, retryDelay, providerOptions = {}) {
  let lastError = '';

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const output = await callProvider(task.prompt, provider, providerOptions);

      if (output) {
        return {
          id: task.id,
          success: true,
          output,
          retries: attempt
        };
      }

      lastError = 'Empty response';
    } catch (err) {
      lastError = err.message || String(err);

      // Check for rate limiting
      if (isRateLimited(lastError)) {
        const delay = retryDelay * Math.pow(2, attempt);
        await sleep(delay);
        continue;
      }

      // Non-retryable error
      if (isNonRetryable(lastError)) {
        break;
      }
    }

    if (attempt < maxRetries) {
      await sleep(retryDelay);
    }
  }

  return {
    id: task.id,
    success: false,
    error: lastError,
    retries: maxRetries
  };
}

/**
 * Call LLM provider
 * @param {string} prompt
 * @param {string} provider
 * @param {object} [options] - Provider-specific options
 * @returns {Promise<string>}
 */
async function callProvider(prompt, provider, options = {}) {
  switch (provider) {
    case 'claude-cli':
      return callClaudeCli(prompt);

    case 'anthropic':
      return callAnthropicApi(prompt);

    case 'openai':
      return callOpenAiApi(prompt);

    case 'codeagent':
    case 'codeagent-wrapper':
      return callCodeagent(prompt, options);

    case 'codex':
      return callCodeagent(prompt, { ...options, backend: 'codex' });

    case 'gemini':
      return callCodeagent(prompt, { ...options, backend: 'gemini' });

    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

/**
 * Call Claude CLI
 * @param {string} prompt
 * @returns {Promise<string>}
 */
async function callClaudeCli(prompt) {
  const result = await runCommand('claude', ['-p', prompt], {
    cwd: process.cwd()
  });

  if (result.code !== 0) {
    throw new Error(result.stderr || `Exit code ${result.code}`);
  }

  return result.stdout;
}

/**
 * Call Anthropic API (placeholder)
 * @param {string} prompt
 * @returns {Promise<string>}
 */
async function callAnthropicApi(prompt) {
  // This would use the Anthropic SDK
  // For now, fall back to CLI
  console.warn('Anthropic API not implemented, falling back to CLI');
  return callClaudeCli(prompt);
}

/**
 * Call OpenAI API (placeholder)
 * @param {string} prompt
 * @returns {Promise<string>}
 */
async function callOpenAiApi(prompt) {
  // This would use the OpenAI SDK
  throw new Error('OpenAI provider not implemented');
}

/**
 * Call codeagent-wrapper
 * @param {string} prompt
 * @param {object} [options]
 * @param {string} [options.backend='codex'] - Backend: codex, claude, gemini
 * @param {string} [options.workdir] - Working directory
 * @param {number} [options.timeout=600000] - Timeout in ms
 * @returns {Promise<string>}
 */
async function callCodeagent(prompt, options = {}) {
  const {
    backend = 'codex',
    workdir = process.cwd(),
    timeout = 600000
  } = options;

  // Use stdin input for codeagent-wrapper
  const result = await runCommand('codeagent-wrapper',
    ['--backend', backend, '-', workdir],
    { cwd: workdir, timeout, input: prompt }
  );

  if (result.code !== 0) {
    throw new Error(result.stderr || `codeagent-wrapper exit code ${result.code}`);
  }

  return result.stdout;
}

/**
 * Run batch with codeagent-wrapper parallel mode
 * More efficient for large batches - sends all tasks at once
 * @param {LLMTask[]} tasks
 * @param {object} options
 * @param {string} [options.backend='codex']
 * @param {string} [options.workdir]
 * @param {number} [options.timeout=600000]
 * @returns {Promise<LLMResult[]>}
 */
export async function runBatchParallel(tasks, options = {}) {
  const {
    backend = 'codex',
    workdir = process.cwd(),
    timeout = 600000
  } = options;

  if (tasks.length === 0) {
    return [];
  }

  console.log(`Running ${tasks.length} tasks via codeagent-wrapper --parallel (backend: ${backend})`);

  // Build parallel task format
  const taskBlocks = tasks.map(task => {
    const lines = ['---TASK---'];
    lines.push(`id: ${task.id}`);
    if (task.context?.workdir || workdir) {
      lines.push(`workdir: ${task.context?.workdir || workdir}`);
    }
    if (task.context?.dependencies) {
      lines.push(`dependencies: ${task.context.dependencies.join(', ')}`);
    }
    lines.push('---CONTENT---');
    lines.push(task.prompt);
    return lines.join('\n');
  }).join('\n');

  // Use stdin for parallel mode
  const result = await runCommand('codeagent-wrapper',
    ['--parallel', '--backend', backend],
    { cwd: workdir, timeout, input: taskBlocks }
  );

  // Parse results
  const results = [];
  const outputLines = result.stdout.split('\n');

  // Simple parsing - look for task completion markers
  let currentTaskId = null;
  let currentOutput = [];

  for (const line of outputLines) {
    const taskMatch = line.match(/^\[(\d+)\/\d+\]\s*([✓✗])\s*(.+)$/);
    if (taskMatch) {
      if (currentTaskId) {
        results.push({
          id: currentTaskId,
          success: true,
          output: currentOutput.join('\n'),
          retries: 0
        });
      }
      currentTaskId = taskMatch[3];
      currentOutput = [];
    } else {
      currentOutput.push(line);
    }
  }

  // Handle last task
  if (currentTaskId) {
    results.push({
      id: currentTaskId,
      success: result.code === 0,
      output: currentOutput.join('\n'),
      retries: 0
    });
  }

  // If parsing failed, create results based on task list
  if (results.length === 0) {
    for (const task of tasks) {
      results.push({
        id: task.id,
        success: result.code === 0,
        output: result.stdout,
        error: result.code !== 0 ? result.stderr : undefined,
        retries: 0
      });
    }
  }

  const succeeded = results.filter(r => r.success).length;
  console.log(`\nCompleted: ${succeeded}/${results.length} succeeded`);

  return results;
}

/**
 * Check if error is rate limit related
 * @param {string} error
 * @returns {boolean}
 */
function isRateLimited(error) {
  const patterns = [
    /rate.?limit/i,
    /too.?many.?requests/i,
    /429/,
    /overloaded/i,
    /capacity/i
  ];
  return patterns.some(p => p.test(error));
}

/**
 * Check if error is non-retryable
 * @param {string} error
 * @returns {boolean}
 */
function isNonRetryable(error) {
  const patterns = [
    /invalid.?api.?key/i,
    /unauthorized/i,
    /401/,
    /403/,
    /not.?found/i,
    /404/
  ];
  return patterns.some(p => p.test(error));
}

/**
 * Sleep for ms
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create tasks from file list
 * @param {string[]} files
 * @param {(file: string) => string} promptBuilder
 * @returns {LLMTask[]}
 */
export function createTasksFromFiles(files, promptBuilder) {
  return files.map(file => ({
    id: file,
    prompt: promptBuilder(file)
  }));
}

/**
 * Concurrency pool for parallel execution with DAG dependency support.
 *
 * Tasks with `dependencies` array will wait until all dependency IDs complete.
 * When no tasks declare dependencies, execution order matches input order.
 *
 * @param {LLMTask[]} tasks
 * @param {number} concurrency - Max concurrent tasks
 * @param {function} handler - Task handler (task) => Promise<result>
 * @param {OnStatusChange} [onStatusChange] - Status change callback
 * @returns {Promise<LLMResult[]>} Results in input order
 */
async function runWithConcurrency(tasks, concurrency, handler, onStatusChange) {
  const effectiveConcurrency = Math.max(1, Number(concurrency) || 1);
  const results = new Map(); // id -> result
  const completed = new Set(); // completed task IDs
  const taskIds = new Set(tasks.map(t => t.id));
  const pending = [...tasks]; // queue of pending tasks
  const executing = new Map(); // promise -> taskId
  let counter = 0;

  // Get dependencies from task (support both formats)
  const getDeps = (task) => (task.dependencies || task.context?.dependencies || []);

  // Check if task can start (all dependencies completed)
  const canStart = (task) => {
    const deps = getDeps(task);
    if (!deps.length) return true;
    // Allow dependencies outside this run to be treated as satisfied
    return deps.every(dep => completed.has(dep) || !taskIds.has(dep));
  };

  while (pending.length > 0 || executing.size > 0) {
    const capacity = effectiveConcurrency - executing.size;

    // Find ready tasks (dependencies satisfied, room in pool)
    const ready = [];
    if (capacity > 0) {
      for (let i = 0; i < pending.length && ready.length < capacity;) {
        if (canStart(pending[i])) {
          ready.push(pending.splice(i, 1)[0]);
          continue; // keep i (array shifted)
        }
        i++;
      }
    }

    // Start ready tasks
    for (const task of ready) {
      const taskNum = ++counter;
      const promise = (async () => {
        onStatusChange?.(task.id, 'running', { index: taskNum, total: tasks.length });
        try {
          const result = await handler(task);
          results.set(task.id, result);
          const status = result.success ? '✓' : '✗';
          console.log(`[${taskNum}/${tasks.length}] ${status} ${task.id}`);
          onStatusChange?.(task.id, result.success ? 'completed' : 'failed', { result });
          return result;
        } finally {
          completed.add(task.id);
          executing.delete(promise);
        }
      })();
      executing.set(promise, task.id);
    }

    // Wait for any task to complete
    if (executing.size > 0) {
      await Promise.race(executing.keys());
    } else if (pending.length > 0) {
      // Tasks pending but none can start - circular dependency
      const blocked = pending
        .map(t => ({
          id: t.id,
          waitingFor: getDeps(t).filter(dep => taskIds.has(dep) && !completed.has(dep))
        }))
        .filter(t => t.waitingFor.length > 0);

      const detail = blocked.length > 0
        ? `Blocked tasks:\n${blocked.map(b => `- ${b.id} waiting for: ${b.waitingFor.join(', ')}`).join('\n')}`
        : `Blocked tasks: ${pending.map(t => t.id).join(', ')}`;

      throw new Error(`Circular dependency detected (or unmet dependencies).\n${detail}`);
    }
  }

  // Return results in original task order
  return tasks.map(t => results.get(t.id));
}

/**
 * Run codeagent-wrapper with spawn, capture session_id
 * @param {string} prompt
 * @param {string} cwd
 * @param {number} timeout
 * @returns {Promise<{success: boolean, output: string, sessionId: string|null, error: string|null, isRateLimited: boolean}>}
 */
export async function runCodeagent(prompt, cwd, timeout = 120000) {
  return new Promise((resolve) => {
    const backend = process.env.CODEAGENT_BACKEND || 'codex';
    const args = ['--backend', backend, '-'];

    const child = spawn('codeagent-wrapper', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CODEX_TIMEOUT: String(timeout)
      }
    });

    let stdout = '';
    let stderr = '';
    let sessionId = null;
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill('SIGTERM');
        resolve({
          success: false,
          output: stdout,
          sessionId,
          error: 'timeout',
          isRateLimited: false
        });
      }
    }, timeout);

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      const match = chunk.match(/SESSION_ID:\s*([a-f0-9-]+)/i);
      if (match) sessionId = match[1];
    });

    child.on('close', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);

      const trimmedOutput = stdout.trim();
      const isSuccess = code === 0 && trimmedOutput;
      const isRateLimitedErr = !isSuccess && isRateLimitError(code, stderr);

      if (isSuccess) {
        resolve({
          success: true,
          output: trimmedOutput,
          sessionId,
          error: null,
          isRateLimited: false
        });
        return;
      }

      resolve({
        success: false,
        output: trimmedOutput,
        sessionId,
        error: code === 0 ? 'empty output' : `exit code ${code}`,
        isRateLimited: isRateLimitedErr
      });
    });

    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({
        success: false,
        output: '',
        sessionId,
        error: err.message,
        isRateLimited: false
      });
    });

    // Write prompt to stdin and close
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Check if error indicates rate limiting
 * @param {number} code
 * @param {string} stderr
 * @returns {boolean}
 */
function isRateLimitError(code, stderr) {
  if (code === 429) return true;
  if (!stderr) return false;
  if (/\b429\b/.test(stderr) || /rate limit|too many requests/i.test(stderr)) {
    return true;
  }
  if (/\b400\b/.test(stderr) && /no available|account/i.test(stderr)) {
    return true;
  }
  return false;
}
