import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import path from 'path';

vi.mock('child_process', () => ({
  spawn: vi.fn()
}));

vi.mock('../../../scripts/shared.js', () => ({
  readJsonSafe: vi.fn(),
  writeJsonSafe: vi.fn(),
  unlinkSafe: vi.fn(),
  createLogger: vi.fn(() => ({ log: vi.fn(async () => { }) })),
  DEFAULT_CONCURRENCY: 6,
  DEFAULT_TIMEOUT: 1800000
}));

function createMockChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    write: vi.fn(),
    end: vi.fn()
  };
  child.kill = vi.fn();
  return child;
}

async function flushMicrotasks() {
  await Promise.resolve();
}

const originalBackend = process.env.CODEAGENT_BACKEND;

let runCodeagent;
let runWithRetry;
let BatchRunner;
let spawn;
let shared;

beforeEach(async () => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.resetModules();

  if (originalBackend === undefined) {
    delete process.env.CODEAGENT_BACKEND;
  } else {
    process.env.CODEAGENT_BACKEND = originalBackend;
  }

  ({ spawn } = await import('child_process'));
  shared = await import('../../../scripts/shared.js');
  ({ runCodeagent, runWithRetry, BatchRunner } = await import('../../../scripts/batch-llm-runner.js'));
});

describe('runCodeagent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('spawns codeagent-wrapper with default backend and writes prompt to stdin', async () => {
    const child = createMockChild();
    spawn.mockReturnValue(child);

    const promise = runCodeagent('PROMPT', '/workdir', 123);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      'codeagent-wrapper',
      ['--backend', 'codex', '-'],
      expect.objectContaining({
        cwd: '/workdir',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: expect.objectContaining({ CODEX_TIMEOUT: '123' })
      })
    );

    expect(child.stdin.write).toHaveBeenCalledTimes(1);
    expect(child.stdin.write).toHaveBeenCalledWith('PROMPT');
    expect(child.stdin.end).toHaveBeenCalledTimes(1);

    child.stderr.emit('data', Buffer.from('SESSION_ID: 123e4567-e89b-12d3-a456-426614174000\n'));
    child.stdout.emit('data', Buffer.from('  hello world  \n'));
    child.emit('close', 0);

    const result = await promise;
    expect(result).toEqual({
      success: true,
      output: 'hello world',
      sessionId: '123e4567-e89b-12d3-a456-426614174000',
      error: null,
      isRateLimited: false
    });
  });

  it('uses CODEAGENT_BACKEND when set', async () => {
    process.env.CODEAGENT_BACKEND = 'gemini';

    const child = createMockChild();
    spawn.mockReturnValue(child);

    const promise = runCodeagent('PROMPT', '/workdir', 50);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      'codeagent-wrapper',
      ['--backend', 'gemini', '-'],
      expect.any(Object)
    );

    child.stdout.emit('data', Buffer.from('ok'));
    child.emit('close', 0);

    const result = await promise;
    expect(result.success).toBe(true);
    expect(result.output).toBe('ok');
  });

  it('fails with empty output when exit code is 0 but stdout is blank', async () => {
    const child = createMockChild();
    spawn.mockReturnValue(child);

    const promise = runCodeagent('PROMPT', '/workdir', 50);

    child.stdout.emit('data', Buffer.from('   \n\t'));
    child.emit('close', 0);

    const result = await promise;
    expect(result).toEqual({
      success: false,
      output: '',
      sessionId: null,
      error: 'empty output',
      isRateLimited: false
    });
  });

  it('fails with exit code message on non-zero exit', async () => {
    const child = createMockChild();
    spawn.mockReturnValue(child);

    const promise = runCodeagent('PROMPT', '/workdir', 50);

    child.stdout.emit('data', Buffer.from(' some output '));
    child.emit('close', 2);

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.output).toBe('some output');
    expect(result.error).toBe('exit code 2');
    expect(result.isRateLimited).toBe(false);
  });

  it('marks rate limit when exit code is 429', async () => {
    const child = createMockChild();
    spawn.mockReturnValue(child);

    const promise = runCodeagent('PROMPT', '/workdir', 50);

    child.stderr.emit('data', Buffer.from('too many requests'));
    child.emit('close', 429);

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.error).toBe('exit code 429');
    expect(result.isRateLimited).toBe(true);
  });

  it('marks rate limit when stderr includes 429 pattern', async () => {
    const child = createMockChild();
    spawn.mockReturnValue(child);

    const promise = runCodeagent('PROMPT', '/workdir', 50);

    child.stderr.emit('data', Buffer.from('Error 429: rate limit exceeded'));
    child.emit('close', 1);

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.error).toBe('exit code 1');
    expect(result.isRateLimited).toBe(true);
  });

  it('marks rate limit when stderr includes transient 400/no available account', async () => {
    const child = createMockChild();
    spawn.mockReturnValue(child);

    const promise = runCodeagent('PROMPT', '/workdir', 50);

    child.stderr.emit('data', Buffer.from('HTTP 400: No available account'));
    child.emit('close', 1);

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.error).toBe('exit code 1');
    expect(result.isRateLimited).toBe(true);
  });

  it('resolves with error message when spawn emits error', async () => {
    const child = createMockChild();
    spawn.mockReturnValue(child);

    const promise = runCodeagent('PROMPT', '/workdir', 50);

    child.emit('error', new Error('spawn failed'));
    const result = await promise;

    expect(result).toEqual({
      success: false,
      output: '',
      sessionId: null,
      error: 'spawn failed',
      isRateLimited: false
    });
  });

  it('times out, kills child, and returns partial stdout without trimming', async () => {
    const child = createMockChild();
    spawn.mockReturnValue(child);

    const promise = runCodeagent('PROMPT', '/workdir', 25);

    child.stdout.emit('data', Buffer.from(' partial '));
    child.stderr.emit('data', Buffer.from('SESSION_ID: 123e4567-e89b-12d3-a456-426614174000\n'));

    await vi.advanceTimersByTimeAsync(25);
    const result = await promise;

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(result).toEqual({
      success: false,
      output: ' partial ',
      sessionId: '123e4567-e89b-12d3-a456-426614174000',
      error: 'timeout',
      isRateLimited: false
    });

    // Late close should not change the already-resolved promise
    child.stdout.emit('data', Buffer.from('ignored'));
    child.emit('close', 0);
    await flushMicrotasks();
  });
});

describe('runWithRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('retries on rate limited results and returns the first success', async () => {
    const children = [];
    spawn.mockImplementation(() => {
      const child = createMockChild();
      children.push(child);
      return child;
    });

    const promise = runWithRetry('PROMPT', '/cwd', 1000, 2, 10);

    expect(spawn).toHaveBeenCalledTimes(1);

    children[0].stderr.emit('data', Buffer.from('rate limit'));
    children[0].emit('close', 429);
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(9);
    expect(spawn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(spawn).toHaveBeenCalledTimes(2);

    children[1].stdout.emit('data', Buffer.from('ok'));
    children[1].emit('close', 0);

    const result = await promise;
    expect(result.success).toBe(true);
    expect(result.output).toBe('ok');
  });

  it('uses exponential backoff between retries', async () => {
    const children = [];
    spawn.mockImplementation(() => {
      const child = createMockChild();
      children.push(child);
      return child;
    });

    const promise = runWithRetry('PROMPT', '/cwd', 1000, 2, 10);

    expect(spawn).toHaveBeenCalledTimes(1);

    children[0].stderr.emit('data', Buffer.from('some transient error'));
    children[0].emit('close', 1);
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(10);
    expect(spawn).toHaveBeenCalledTimes(2);

    children[1].stderr.emit('data', Buffer.from('still failing'));
    children[1].emit('close', 1);
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(19);
    expect(spawn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(spawn).toHaveBeenCalledTimes(3);

    children[2].stdout.emit('data', Buffer.from('recovered'));
    children[2].emit('close', 0);

    const result = await promise;
    expect(result.success).toBe(true);
    expect(result.output).toBe('recovered');
  });

  it('does not retry on non-rate-limited empty output', async () => {
    const children = [];
    spawn.mockImplementation(() => {
      const child = createMockChild();
      children.push(child);
      return child;
    });

    const promise = runWithRetry('PROMPT', '/cwd', 1000, 3, 10);

    expect(spawn).toHaveBeenCalledTimes(1);

    children[0].stdout.emit('data', Buffer.from('   \n'));
    children[0].emit('close', 0);

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.error).toBe('empty output');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('stops after maxRetries and returns last failure', async () => {
    const children = [];
    spawn.mockImplementation(() => {
      const child = createMockChild();
      children.push(child);
      return child;
    });

    const promise = runWithRetry('PROMPT', '/cwd', 1000, 2, 10);

    expect(spawn).toHaveBeenCalledTimes(1);

    children[0].emit('close', 429);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(10);
    expect(spawn).toHaveBeenCalledTimes(2);

    children[1].emit('close', 429);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(20);
    expect(spawn).toHaveBeenCalledTimes(3);

    children[2].emit('close', 429);

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.error).toBe('exit code 429');
    expect(result.isRateLimited).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(3);
  });
});

describe('BatchRunner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));

    shared.readJsonSafe.mockImplementation(async (_filePath, defaultValue) => defaultValue);
    shared.writeJsonSafe.mockResolvedValue(true);
    shared.unlinkSafe.mockResolvedValue(true);
  });

  it('constructs with defaults and initializes file paths under .project-index', () => {
    const runner = new BatchRunner({
      name: 'unit-test',
      stateDir: '/tmp/state',
      silent: true
    });

    expect(runner.name).toBe('unit-test');
    expect(runner.concurrency).toBe(shared.DEFAULT_CONCURRENCY);
    expect(runner.timeout).toBe(shared.DEFAULT_TIMEOUT);
    expect(runner.maxRetries).toBe(3);
    expect(runner.retryDelay).toBe(5000);

    expect(runner.stateDir).toBe(path.join('/tmp/state', '.project-index'));
    expect(runner.logFile).toBe(path.join('/tmp/state', '.project-index', '.unit-test.log'));
    expect(runner.progressFile).toBe(path.join('/tmp/state', '.project-index', '.unit-test-progress.json'));
    expect(runner.resultFile).toBe(path.join('/tmp/state', '.project-index', '.unit-test-result.json'));
    expect(runner.tasksFile).toBe(path.join('/tmp/state', '.project-index', '.unit-test-tasks.json'));

    expect(shared.createLogger).toHaveBeenCalledTimes(1);
    expect(shared.createLogger).toHaveBeenCalledWith(runner.logFile, true);
  });

  it('loads task states into a Map keyed by id', async () => {
    shared.readJsonSafe.mockResolvedValueOnce({
      tasks: [
        { id: 'a', status: 'pending' },
        { id: 'b', status: 'completed' }
      ]
    });

    const runner = new BatchRunner({ name: 'load', stateDir: '/tmp/state', silent: true });
    const map = await runner.loadTaskStates();

    expect(shared.readJsonSafe).toHaveBeenCalledWith(runner.tasksFile, { tasks: [] });
    expect(map).toBeInstanceOf(Map);
    expect(map.get('a')).toEqual({ id: 'a', status: 'pending' });
    expect(map.get('b')).toEqual({ id: 'b', status: 'completed' });
    expect(runner.taskStates.size).toBe(2);
  });

  it('saves task states with accurate summary counts', async () => {
    const runner = new BatchRunner({ name: 'save', stateDir: '/tmp/state', silent: true });
    runner.taskStates = new Map([
      ['p', { id: 'p', status: 'pending' }],
      ['r', { id: 'r', status: 'running' }],
      ['c', { id: 'c', status: 'completed' }],
      ['f', { id: 'f', status: 'failed' }],
      ['t', { id: 't', status: 'timeout' }]
    ]);

    await runner.saveTaskStates();

    expect(shared.writeJsonSafe).toHaveBeenCalledTimes(1);
    const [, payload] = shared.writeJsonSafe.mock.calls[0];
    expect(payload).toEqual({
      name: 'save',
      updatedAt: '2020-01-01T00:00:00.000Z',
      summary: {
        total: 5,
        pending: 1,
        running: 1,
        completed: 1,
        failed: 1,
        timeout: 1
      },
      tasks: [
        { id: 'p', status: 'pending' },
        { id: 'r', status: 'running' },
        { id: 'c', status: 'completed' },
        { id: 'f', status: 'failed' },
        { id: 't', status: 'timeout' }
      ]
    });
  });

  it('updates a task state by merging fields and persists changes', async () => {
    const runner = new BatchRunner({ name: 'update', stateDir: '/tmp/state', silent: true });
    runner.taskStates.set('t1', { id: 't1', status: 'pending', context: { x: 1 } });

    await runner.updateTaskState('t1', { status: 'running', error: null });

    expect(runner.taskStates.get('t1')).toEqual({
      id: 't1',
      status: 'running',
      context: { x: 1 },
      error: null
    });
    expect(shared.writeJsonSafe).toHaveBeenCalledTimes(1);

    await runner.updateTaskState('t2', { status: 'failed', error: 'boom' });
    expect(runner.taskStates.get('t2')).toEqual({ id: 't2', status: 'failed', error: 'boom' });
    expect(shared.writeJsonSafe).toHaveBeenCalledTimes(2);
  });

  it('returns never_run status when tasks file is missing', async () => {
    shared.readJsonSafe.mockResolvedValueOnce(null);
    const runner = new BatchRunner({ name: 'status', stateDir: '/tmp/state', silent: true });

    const status = await runner.getStatus();

    expect(shared.readJsonSafe).toHaveBeenCalledWith(runner.tasksFile, null);
    expect(status).toEqual({ status: 'never_run', name: 'status' });
  });

  it('returns stored status object when tasks file exists', async () => {
    shared.readJsonSafe.mockResolvedValueOnce({ name: 'status', summary: { total: 1 } });
    const runner = new BatchRunner({ name: 'status', stateDir: '/tmp/state', silent: true });

    const status = await runner.getStatus();

    expect(status).toEqual({ name: 'status', summary: { total: 1 } });
  });

  it('loads progress with default shape and clears progress file', async () => {
    const runner = new BatchRunner({ name: 'progress', stateDir: '/tmp/state', silent: true });

    const progress = await runner.loadProgress();
    expect(shared.readJsonSafe).toHaveBeenCalledWith(runner.progressFile, {
      status: 'idle',
      items: [],
      completed: [],
      results: []
    });
    expect(progress).toEqual({
      status: 'idle',
      items: [],
      completed: [],
      results: []
    });

    await runner.clearProgress();
    expect(shared.unlinkSafe).toHaveBeenCalledWith(runner.progressFile);
  });
});

