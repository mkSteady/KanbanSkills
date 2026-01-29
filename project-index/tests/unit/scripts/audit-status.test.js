import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';

const fsMock = vi.hoisted(() => ({
  readdir: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
  access: vi.fn(),
  mkdir: vi.fn()
}));

const sharedMock = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  parseArgs: vi.fn(),
  readJsonSafe: vi.fn(),
  shouldProcess: vi.fn(),
  writeJsonSafe: vi.fn(),
  findProjectRoot: vi.fn()
}));

vi.mock('fs', () => ({ promises: fsMock }));
vi.mock('../../../scripts/shared.js', () => sharedMock);

function normalizePosix(p) {
  const normalized = path.posix.normalize(p);
  if (normalized.length > 1 && normalized.endsWith('/')) return normalized.slice(0, -1);
  return normalized;
}

function createVfs(seed) {
  const files = new Map();
  const dirs = new Set();
  const children = new Map(); // dir -> Map<name, 'file'|'dir'>

  function ensureDir(dirPath) {
    const dir = normalizePosix(dirPath);
    if (dirs.has(dir)) return;
    dirs.add(dir);
    if (!children.has(dir)) children.set(dir, new Map());

    const parent = normalizePosix(path.posix.dirname(dir));
    if (dir !== parent) {
      ensureDir(parent);
      const parentChildren = children.get(parent);
      if (parentChildren) parentChildren.set(path.posix.basename(dir), 'dir');
    }
  }

  function addFile(filePath, { content = '', mtime = new Date(0) } = {}) {
    const fullPath = normalizePosix(filePath);
    ensureDir(path.posix.dirname(fullPath));
    files.set(fullPath, { content, mtime });

    const parent = normalizePosix(path.posix.dirname(fullPath));
    const parentChildren = children.get(parent);
    if (parentChildren) parentChildren.set(path.posix.basename(fullPath), 'file');
  }

  ensureDir('/');
  for (const [filePath, meta] of Object.entries(seed.files || {})) {
    addFile(filePath, meta);
  }
  for (const dirPath of seed.dirs || []) {
    ensureDir(dirPath);
  }

  function getChildren(dirPath) {
    const dir = normalizePosix(dirPath);
    if (!dirs.has(dir)) {
      const err = new Error(`ENOENT: no such file or directory, scandir '${dir}'`);
      // @ts-ignore
      err.code = 'ENOENT';
      throw err;
    }

    const dirChildren = children.get(dir) || new Map();
    return Array.from(dirChildren.entries()).map(([name, kind]) => ({
      name,
      isFile: () => kind === 'file',
      isDirectory: () => kind === 'dir'
    }));
  }

  function getFile(filePath) {
    const fullPath = normalizePosix(filePath);
    const file = files.get(fullPath);
    if (!file) {
      const err = new Error(`ENOENT: no such file or directory, open '${fullPath}'`);
      // @ts-ignore
      err.code = 'ENOENT';
      throw err;
    }
    return file;
  }

  return {
    async readdir(dirPath) {
      return getChildren(dirPath);
    },
    async stat(filePath) {
      const fullPath = normalizePosix(filePath);
      if (files.has(fullPath)) {
        const { mtime } = getFile(fullPath);
        return { mtime };
      }
      if (dirs.has(fullPath)) {
        return { mtime: new Date(0) };
      }
      const err = new Error(`ENOENT: no such file or directory, stat '${fullPath}'`);
      // @ts-ignore
      err.code = 'ENOENT';
      throw err;
    },
    async readFile(filePath) {
      return getFile(filePath).content;
    },
    async access(filePath) {
      const fullPath = normalizePosix(filePath);
      if (files.has(fullPath) || dirs.has(fullPath)) return;
      const err = new Error(`ENOENT: no such file or directory, access '${fullPath}'`);
      // @ts-ignore
      err.code = 'ENOENT';
      throw err;
    },
    async mkdir(dirPath) {
      ensureDir(dirPath);
    }
  };
}

async function waitForAsyncWork() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

async function runAuditStatusModule() {
  await import('../../../scripts/audit-status.js');
  await waitForAsyncWork();
}

function setupHappyPathVfs(root = '/project') {
  const t1 = new Date('2020-01-01T00:00:00Z');
  const t2 = new Date('2020-01-02T00:00:00Z');
  const t3 = new Date('2020-01-03T00:00:00Z');
  const t4 = new Date('2020-01-04T00:00:00Z');

  const vfs = createVfs({
    files: {
      [path.posix.join(root, 'CLAUDE.md')]: { content: '# Root', mtime: t1 },
      [path.posix.join(root, 'a.js')]: { content: 'console.log(1);\\n', mtime: t1 },
      [path.posix.join(root, 'a.test.js')]: { content: 'test', mtime: t1 },
      [path.posix.join(root, 'AUDIT.md')]: {
        content: 'Severity: **High**\\n\\n## Issues (2)\\n',
        mtime: t2
      },

      [path.posix.join(root, 'pkg', 'CLAUDE.md')]: { content: '# Pkg', mtime: t1 },
      [path.posix.join(root, 'pkg', 'b.js')]: { content: 'export const b = 1;\\n', mtime: t3 },
      [path.posix.join(root, 'pkg', 'AUDIT.md')]: {
        content: 'Severity: **Medium**\\n\\n## Issues (1)\\n',
        mtime: t2
      },

      [path.posix.join(root, 'lib', 'CLAUDE.md')]: { content: '# Lib', mtime: t1 },
      [path.posix.join(root, 'lib', 'c.js')]: { content: 'export const c = 1;\\n', mtime: t1 },
      [path.posix.join(root, 'lib', 'AUDIT.md')]: {
        content: 'Severity: **Low**\\n\\n## Issues (0)\\n',
        mtime: t4
      },

      [path.posix.join(root, 'never', 'CLAUDE.md')]: { content: '# Never', mtime: t1 },
      [path.posix.join(root, 'never', 'd.js')]: { content: 'export const d = 1;\\n', mtime: t1 }
    }
  });

  fsMock.readdir.mockImplementation(vfs.readdir);
  fsMock.stat.mockImplementation(vfs.stat);
  fsMock.readFile.mockImplementation(vfs.readFile);
  fsMock.access.mockImplementation(vfs.access);
  fsMock.mkdir.mockImplementation(vfs.mkdir);

  sharedMock.loadConfig.mockResolvedValue({ ignore: [], include: [] });
  sharedMock.shouldProcess.mockReturnValue(true);
  sharedMock.findProjectRoot.mockResolvedValue(root);
  sharedMock.readJsonSafe.mockResolvedValue({ snapshots: [] });
  sharedMock.writeJsonSafe.mockResolvedValue();

  return { root };
}

describe('scripts/audit-status.js', () => {
  let logs = [];
  let errors = [];
  let logSpy;
  let errorSpy;
  let exitSpy;

  beforeEach(() => {
    logs = [];
    errors = [];

    vi.resetModules();
    fsMock.readdir.mockReset();
    fsMock.stat.mockReset();
    fsMock.readFile.mockReset();
    fsMock.access.mockReset();
    fsMock.mkdir.mockReset();

    sharedMock.loadConfig.mockReset();
    sharedMock.parseArgs.mockReset();
    sharedMock.readJsonSafe.mockReset();
    sharedMock.shouldProcess.mockReset();
    sharedMock.writeJsonSafe.mockReset();
    sharedMock.findProjectRoot.mockReset();

    logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.map(String).join(' '));
    });
    errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args.map(String).join(' '));
    });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy?.mockRestore();
    errorSpy?.mockRestore();
    exitSpy?.mockRestore();
  });

  it('produces a correct JSON report (mixed statuses)', async () => {
    const { root } = setupHappyPathVfs('/project');

    sharedMock.parseArgs.mockReturnValue({
      _: [root],
      json: true,
      never: false,
      stale: false,
      summary: false
    });

    await runAuditStatusModule();

    expect(errors).toEqual([]);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(logs).toHaveLength(1);

    const report = JSON.parse(logs[0]);
    expect(report.total).toBe(4);
    expect(report.totalIssues).toBe(3);
    expect(report.stats).toEqual({ never: 1, stale: 1, fresh: 1, clean: 1 });
    expect(report.severityCounts).toEqual({ critical: 0, high: 1, medium: 1, low: 1 });
    expect(report.coveragePercent).toBe(100);
    expect(report.docCoveragePercent).toBe(100);
    expect(report.uncoveredFiles).toBe(0);

    expect(report.modules.map(m => m.path)).toEqual(['never', 'pkg', '.', 'lib']);
    expect(report.modules.find(m => m.path === '.').status).toBe('fresh');
    expect(report.modules.find(m => m.path === 'pkg').status).toBe('stale');
    expect(report.modules.find(m => m.path === 'lib').status).toBe('clean');
    expect(report.modules.find(m => m.path === 'never').status).toBe('never');

    expect(sharedMock.writeJsonSafe).toHaveBeenCalledTimes(1);
    const [historyPath, history] = sharedMock.writeJsonSafe.mock.calls[0];
    expect(historyPath).toBe(path.join(root, '.project-index', '.audit-history.json'));
    expect(history.snapshots).toHaveLength(1);
    expect(history.snapshots[0]).toEqual(
      expect.objectContaining({
        total: 3,
        new: 3,
        resolved: 0,
        modules: expect.any(Object),
        date: expect.stringMatching(/^\\d{4}-\\d{2}-\\d{2}$/)
      })
    );
  });

  it('filters modules when --never is set (JSON output)', async () => {
    const { root } = setupHappyPathVfs('/project');

    sharedMock.parseArgs.mockReturnValue({
      _: [root],
      json: true,
      never: true,
      stale: false,
      summary: false
    });

    await runAuditStatusModule();

    const report = JSON.parse(logs[0]);
    expect(report.total).toBe(4);
    expect(report.modules).toHaveLength(1);
    expect(report.modules[0]).toEqual(expect.objectContaining({ status: 'never', path: 'never' }));
  });

  it('prints a summary-only report when --summary is set', async () => {
    const { root } = setupHappyPathVfs('/project');

    sharedMock.parseArgs.mockReturnValue({
      _: [root],
      json: false,
      never: false,
      stale: false,
      summary: true
    });

    await runAuditStatusModule();

    expect(logs.join('\n')).toContain('Total Modules: 4');
    expect(logs.join('\n')).toContain('Never audited: 1');
    expect(logs.join('\n')).toContain('Stale (code changed): 1');
    expect(logs.join('\n')).toContain('Fresh (up-to-date): 1');
    expect(logs.join('\n')).toContain('Clean (0 issues): 1');
    expect(logs.join('\n')).toContain('Total Issues: 3');
    expect(logs.join('\n')).toContain('Critical: 0, High: 1, Medium: 1, Low: 1');
  });

  it('prints a full human-readable report by default', async () => {
    const { root } = setupHappyPathVfs('/project');

    sharedMock.parseArgs.mockReturnValue({
      _: [root],
      json: false,
      never: false,
      stale: false,
      summary: false
    });

    await runAuditStatusModule();

    const output = logs.join('\n');
    expect(output).toContain(`Scanning: ${root}`);
    expect(output).toContain('=== ⚫ NEVER AUDITED (1) ===');
    expect(output).toContain('  ○ never');
    expect(output).toContain('=== 🟤 STALE - Code Modified Since Audit (1) ===');
    expect(output).toContain('  ◐ pkg (1 issues) [b.js]');
    expect(output).toContain('=== 🟠 HIGH (1) ===');
    expect(output).toContain('  ● . (2 issues)');
    expect(output).toContain('=== ✅ CLEAN - All Issues Resolved (1) ===');
    expect(output).toContain('  ✓ lib');
    expect(output).toContain('Total: 4 | Never: 1 | Stale: 1 | Fresh: 1 | Clean: 1 | Issues: 3');
  });

  it('handles unreadable roots without crashing', async () => {
    const root = '/project';

    fsMock.readdir.mockRejectedValue(new Error('EACCES'));
    fsMock.mkdir.mockResolvedValue();

    sharedMock.parseArgs.mockReturnValue({
      _: [root],
      json: true,
      never: false,
      stale: false,
      summary: false
    });
    sharedMock.loadConfig.mockResolvedValue({ ignore: [], include: [] });
    sharedMock.findProjectRoot.mockResolvedValue(root);
    sharedMock.readJsonSafe.mockResolvedValue({ snapshots: [] });
    sharedMock.writeJsonSafe.mockResolvedValue();
    sharedMock.shouldProcess.mockReturnValue(true);

    await runAuditStatusModule();

    expect(errors).toEqual([]);
    expect(exitSpy).not.toHaveBeenCalled();

    const report = JSON.parse(logs[0]);
    expect(report.total).toBe(0);
    expect(report.totalDiscoveredFiles).toBe(0);
    expect(report.totalDiscoveredDirs).toBe(0);
    expect(report.coveragePercent).toBe(0);
    expect(report.docCoveragePercent).toBe(0);
    expect(report.modules).toEqual([]);
  });

  it('prints error + exits when main throws', async () => {
    const root = '/project';

    sharedMock.parseArgs.mockReturnValue({
      _: [root],
      json: true,
      never: false,
      stale: false,
      summary: false
    });
    sharedMock.loadConfig.mockRejectedValue(new Error('boom'));

    await runAuditStatusModule();

    expect(logs).toEqual([]);
    expect(errors.join('\n')).toContain('Error: boom');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

