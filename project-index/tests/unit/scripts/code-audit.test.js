import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';

const CODE_AUDIT_IMPORT = '../../../scripts/code-audit.js';
const CODE_AUDIT_ABS = fileURLToPath(new URL(CODE_AUDIT_IMPORT, import.meta.url));
const SCRIPTS_DIR = path.dirname(CODE_AUDIT_ABS);
const CODE_AUDIT_RESULT_FILE = path.join(SCRIPTS_DIR, '.code-audit-result.json');

const { fsMocks, batchState } = vi.hoisted(() => {
  const fsMocks = {
    access: vi.fn(),
    readdir: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn()
  };

  const batchState = {
    instances: [],
    runCalls: [],
    runImpl: vi.fn(async () => undefined)
  };

  return { fsMocks, batchState };
});

vi.mock('fs', () => ({ promises: fsMocks }));

vi.mock('../../../scripts/batch-llm-runner.js', () => {
  class BatchRunner {
    constructor(options) {
      this.options = options;
      batchState.instances.push(this);
    }

    async run(tasks, options) {
      batchState.runCalls.push({ tasks, options });
      return batchState.runImpl(tasks, options);
    }
  }

  return { BatchRunner };
});

function direntFile(name) {
  return {
    name,
    isFile: () => true,
    isDirectory: () => false
  };
}

function direntDir(name) {
  return {
    name,
    isFile: () => false,
    isDirectory: () => true
  };
}

async function tick() {
  await Promise.resolve();
}

async function importCodeAuditWithArgs(args = []) {
  process.argv = ['node', 'code-audit.js', ...args];
  await import(CODE_AUDIT_IMPORT);
  await tick();
}

async function getRunnerTasks() {
  expect(batchState.runCalls.length).toBe(1);
  return batchState.runCalls[0].tasks;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();

  fsMocks.access.mockReset();
  fsMocks.readdir.mockReset();
  fsMocks.readFile.mockReset();
  fsMocks.writeFile.mockReset();

  batchState.instances.length = 0;
  batchState.runCalls.length = 0;
  batchState.runImpl.mockReset();
  batchState.runImpl.mockImplementation(async () => undefined);

  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'cwd').mockReturnValue('/project');
  process.argv = ['node', 'code-audit.js'];
});

describe('scripts/code-audit.js (CLI main)', () => {
  describe('--status', () => {
    it('prints saved audit result when present', async () => {
      fsMocks.readFile.mockImplementation(async (filePath, encoding) => {
        expect(encoding).toBe('utf-8');
        expect(filePath).toBe(CODE_AUDIT_RESULT_FILE);
        return '{"ok":true}';
      });

      await importCodeAuditWithArgs(['--status']);

      expect(console.log).toHaveBeenCalledWith('{"ok":true}');
      expect(batchState.instances).toHaveLength(0);
      expect(batchState.runCalls).toHaveLength(0);
    });

    it('prints fallback message when audit result is missing', async () => {
      fsMocks.readFile.mockRejectedValue(new Error('ENOENT'));

      await importCodeAuditWithArgs(['--status']);

      expect(fsMocks.readFile).toHaveBeenCalledWith(CODE_AUDIT_RESULT_FILE, 'utf-8');
      expect(console.log).toHaveBeenCalledWith('No audit result found.');
      expect(batchState.runCalls).toHaveLength(0);
    });
  });

  describe('BatchRunner wiring', () => {
    it('creates BatchRunner with expected config and calls run()', async () => {
      await importCodeAuditWithArgs([]);

      expect(batchState.instances).toHaveLength(1);
      expect(batchState.instances[0].options).toEqual({
        name: 'code-audit',
        concurrency: 8,
        timeout: 120000,
        stateDir: SCRIPTS_DIR
      });

      expect(batchState.runCalls).toHaveLength(1);
      const { tasks, options } = batchState.runCalls[0];
      expect(typeof tasks.scan).toBe('function');
      expect(typeof tasks.buildPrompt).toBe('function');
      expect(typeof tasks.handleResult).toBe('function');
      expect(options).toEqual({ resume: false, cwd: '/project' });
    });

    it('passes resume=true when --resume is provided', async () => {
      await importCodeAuditWithArgs(['--resume']);
      expect(batchState.runCalls).toHaveLength(1);
      expect(batchState.runCalls[0].options).toEqual({ resume: true, cwd: '/project' });
    });

    it('logs errors when runner.run rejects', async () => {
      batchState.runImpl.mockImplementation(async () => {
        throw new Error('boom');
      });

      await importCodeAuditWithArgs([]);

      expect(console.error).toHaveBeenCalled();
      const [err] = console.error.mock.calls[0] || [];
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe('boom');
    });
  });
});

describe('scan (via BatchRunner.run tasks)', () => {
  it('returns only large dirs and respects ignore + depth limits', async () => {
    await importCodeAuditWithArgs([]);
    const { scan } = await getRunnerTasks();

    const tree = new Map([
      ['/project', [
        direntFile('root.js'),
        direntDir('small'),
        direntDir('large'),
        direntDir('nested'),
        direntDir('node_modules'),
        direntDir('lvl1')
      ]],
      ['/project/small', [direntFile('s1.js'), direntFile('s1.test.js'), direntFile('note.md')]],
      ['/project/large', [
        direntFile('l1.js'),
        direntFile('l2.js'),
        direntFile('l3.js'),
        direntFile('l4.js'),
        direntFile('l5.js')
      ]],
      ['/project/nested', [direntDir('deep')]],
      ['/project/nested/deep', [direntFile('d1.js')]],
      ['/project/lvl1', [direntDir('lvl2')]],
      ['/project/lvl1/lvl2', [direntDir('lvl3')]],
      ['/project/lvl1/lvl2/lvl3', [direntDir('lvl4')]],
      ['/project/lvl1/lvl2/lvl3/lvl4', [direntFile('tooDeep.js')]]
    ]);

    const files = new Map([
      ['/project/root.js', 'console.log("hi")'],
      ['/project/small/s1.js', 'a\nb\nc'],
      ['/project/small/s1.test.js', 'should be ignored by getDirStats'],
      ['/project/large/l1.js', 'x'],
      ['/project/large/l2.js', 'x'],
      ['/project/large/l3.js', 'x'],
      ['/project/large/l4.js', 'x'],
      ['/project/large/l5.js', 'x'],
      ['/project/nested/deep/d1.js', `${'line\n'.repeat(199)}line`],
      ['/project/lvl1/lvl2/lvl3/lvl4/tooDeep.js', 'x']
    ]);

    fsMocks.readdir.mockImplementation(async (dirPath, options) => {
      expect(options).toEqual({ withFileTypes: true });
      if (!tree.has(dirPath)) throw new Error(`ENOENT: ${dirPath}`);
      return tree.get(dirPath);
    });

    fsMocks.readFile.mockImplementation(async (filePath, encoding) => {
      expect(encoding).toBe('utf-8');
      if (!files.has(filePath)) throw new Error(`ENOENT: ${filePath}`);
      return files.get(filePath);
    });

    const largeDirs = await scan('/project');
    const normalized = largeDirs
      .map(d => ({ id: d.id, path: d.path }))
      .sort((a, b) => a.id.localeCompare(b.id));

    expect(normalized).toEqual([
      { id: 'large', path: '/project/large' },
      { id: 'nested/deep', path: '/project/nested/deep' }
    ]);

    expect(fsMocks.readdir).not.toHaveBeenCalledWith('/project/node_modules', expect.anything());
    expect(normalized.find(d => d.id.includes('lvl1'))).toBeUndefined();
  });

  it('handles unreadable directories without throwing', async () => {
    await importCodeAuditWithArgs([]);
    const { scan } = await getRunnerTasks();

    fsMocks.readdir.mockRejectedValue(new Error('EACCES'));

    await expect(scan('/project')).resolves.toEqual([]);
  });
});

describe('buildPrompt (via BatchRunner.run tasks)', () => {
  it('builds prompt without small-subdir section when none qualify', async () => {
    await importCodeAuditWithArgs([]);
    const { buildPrompt } = await getRunnerTasks();

    fsMocks.readdir.mockImplementation(async (dirPath, options) => {
      expect(options).toEqual({ withFileTypes: true });
      if (dirPath === '/project/large') {
        return [direntFile('a.js'), direntFile('b.py')];
      }
      return [];
    });

    fsMocks.readFile.mockImplementation(async (filePath, encoding) => {
      expect(encoding).toBe('utf-8');
      if (filePath === '/project/large/a.js') return 'const a = 1;\n';
      if (filePath === '/project/large/b.py') return 'print("b")\n';
      throw new Error('ENOENT');
    });

    const prompt = await buildPrompt({ id: 'large', path: '/project/large' });

    expect(prompt).toContain('目录: large');
    expect(prompt).toContain('--- a.js ---');
    expect(prompt).toContain('--- b.py ---');
    expect(prompt).not.toContain('未独立审计的小子目录');
    expect(prompt).toContain('"severity": "low|medium|high|critical"');
  });

  it('includes unaudited small subdirs and attaches limited subdir code', async () => {
    await importCodeAuditWithArgs([]);
    const { buildPrompt } = await getRunnerTasks();

    const tree = new Map([
      ['/project/large', [
        direntFile('a.js'),
        direntDir('childSmall'),
        direntDir('.hidden'),
        direntDir('node_modules')
      ]],
      ['/project/large/childSmall', [direntFile('c.js')]]
    ]);

    const files = new Map([
      ['/project/large/a.js', 'root file\n'],
      ['/project/large/childSmall/c.js', 'c1\nc2']
    ]);

    fsMocks.readdir.mockImplementation(async (dirPath, options) => {
      expect(options).toEqual({ withFileTypes: true });
      return tree.get(dirPath) || [];
    });

    fsMocks.readFile.mockImplementation(async (filePath, encoding) => {
      expect(encoding).toBe('utf-8');
      if (!files.has(filePath)) throw new Error(`ENOENT: ${filePath}`);
      return files.get(filePath);
    });

    fsMocks.access.mockImplementation(async (filePath) => {
      if (filePath === '/project/large/childSmall/AUDIT.md') throw new Error('ENOENT');
      return;
    });

    const prompt = await buildPrompt({ id: 'large', path: '/project/large' });

    expect(prompt).toContain('## 未独立审计的小子目录');
    expect(prompt).toContain('- childSmall (1 文件, 2 行)');
    expect(prompt).toContain('--- c.js ---');
    expect(prompt).not.toContain('.hidden');
    expect(prompt).not.toContain('node_modules');
  });
});

describe('handleResult (via BatchRunner.run tasks)', () => {
  it('returns llm_error when LLM call fails', async () => {
    await importCodeAuditWithArgs([]);
    const { handleResult } = await getRunnerTasks();

    const res = await handleResult(
      { id: 'x', path: '/project/x' },
      { success: false, output: '', error: 'exit code 1', sessionId: 'sid-1' }
    );

    expect(res).toEqual({ status: 'llm_error', reason: 'exit code 1', sessionId: 'sid-1' });
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
  });

  it('parses JSON, writes AUDIT.md, and returns audited status', async () => {
    await importCodeAuditWithArgs([]);
    const { handleResult } = await getRunnerTasks();

    fsMocks.writeFile.mockImplementation(async () => {});

    const item = { id: 'large', path: '/project/large' };
    const result = {
      success: true,
      output: 'prefix { "severity": "high", "issues": [{"type":"X","description":"D","file":"f.js","line":12}], "summary":"S" } suffix',
      error: null,
      sessionId: 'sid-2'
    };

    const res = await handleResult(item, result);
    expect(res).toEqual({ status: 'audited', severity: 'high', issueCount: 1 });

    expect(fsMocks.writeFile).toHaveBeenCalledWith(
      path.join('/project/large', 'AUDIT.md'),
      expect.any(String)
    );

    const content = fsMocks.writeFile.mock.calls[0][1];
    expect(content).toContain('# Code Audit - large');
    expect(content).toContain('## Severity: high');
    expect(content).toContain('## Summary');
    expect(content).toContain('S');
    expect(content).toContain('- **X** (f.js:12): D');
  });

  it('returns critical status when severity is critical', async () => {
    await importCodeAuditWithArgs([]);
    const { handleResult } = await getRunnerTasks();

    fsMocks.writeFile.mockImplementation(async () => {});

    const res = await handleResult(
      { id: 'm', path: '/project/m' },
      { success: true, output: '{ "severity": "critical", "issues": [], "summary": "ok" }', error: null, sessionId: 'sid-3' }
    );

    expect(res).toEqual({ status: 'critical', severity: 'critical', issueCount: 0 });
  });

  it('returns parse_error when output JSON is invalid', async () => {
    await importCodeAuditWithArgs([]);
    const { handleResult } = await getRunnerTasks();

    const res = await handleResult(
      { id: 'm', path: '/project/m' },
      { success: true, output: '{ "severity": "high", }', error: null, sessionId: 'sid-4' }
    );

    expect(res).toEqual({ status: 'parse_error', sessionId: 'sid-4' });
  });

  it('returns unclear when output contains no severity JSON', async () => {
    await importCodeAuditWithArgs([]);
    const { handleResult } = await getRunnerTasks();

    const res = await handleResult(
      { id: 'm', path: '/project/m' },
      { success: true, output: 'no json here', error: null, sessionId: 'sid-5' }
    );

    expect(res).toEqual({ status: 'unclear', sessionId: 'sid-5' });
  });

  it('returns parse_error when AUDIT.md write fails', async () => {
    await importCodeAuditWithArgs([]);
    const { handleResult } = await getRunnerTasks();

    fsMocks.writeFile.mockRejectedValue(new Error('EACCES'));

    const res = await handleResult(
      { id: 'm', path: '/project/m' },
      { success: true, output: '{ "severity": "low", "summary": "ok" }', error: null, sessionId: 'sid-6' }
    );

    expect(res).toEqual({ status: 'parse_error', sessionId: 'sid-6' });
  });

  it('formats issues as "None found" when issues are missing', async () => {
    await importCodeAuditWithArgs([]);
    const { handleResult } = await getRunnerTasks();

    fsMocks.writeFile.mockImplementation(async () => {});

    const res = await handleResult(
      { id: 'm', path: '/project/m' },
      { success: true, output: '{ "severity": "low", "summary": "ok" }', error: null, sessionId: 'sid-7' }
    );

    expect(res).toEqual({ status: 'audited', severity: 'low', issueCount: 0 });
    const content = fsMocks.writeFile.mock.calls[0][1];
    expect(content).toContain('## Issues');
    expect(content).toContain('None found');
  });
});
