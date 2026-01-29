import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let fsPromisesMock;
let shouldProcessMock;

vi.mock('fs', () => ({ promises: fsPromisesMock }));
vi.mock('../../../scripts/shared.js', () => ({
  shouldProcess: (...args) => shouldProcessMock(...args)
}));

function fileDirent(name) {
  return { name, isFile: () => true, isDirectory: () => false };
}

function dirDirent(name) {
  return { name, isFile: () => false, isDirectory: () => true };
}

function date(isoString) {
  return new Date(isoString);
}

function makeFsMock({ readdirMap = {}, statMap = {}, readFileMap = {} } = {}) {
  const readdir = vi.fn(async (dir) => {
    if (!(dir in readdirMap)) throw new Error(`ENOENT: readdir ${dir}`);
    return readdirMap[dir];
  });

  const stat = vi.fn(async (filePath) => {
    if (!(filePath in statMap)) throw new Error(`ENOENT: stat ${filePath}`);
    return { mtime: statMap[filePath] };
  });

  const readFile = vi.fn(async (filePath) => {
    if (!(filePath in readFileMap)) throw new Error(`ENOENT: readFile ${filePath}`);
    return readFileMap[filePath];
  });

  const access = vi.fn(async (filePath) => {
    if (filePath in statMap) return;
    throw new Error(`ENOENT: access ${filePath}`);
  });

  const utimes = vi.fn(async () => {});

  return { readdir, stat, readFile, access, utimes };
}

async function flushAsync() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

async function runCli(args) {
  process.argv = ['node', 'check-stale.js', ...args];
  await import('../../../scripts/check-stale.js');
  await flushAsync();
}

const ORIGINAL_ARGV = process.argv.slice();

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  process.argv = ORIGINAL_ARGV.slice();
  shouldProcessMock = vi.fn(() => true);
  fsPromisesMock = makeFsMock();
});

afterEach(() => {
  process.argv = ORIGINAL_ARGV.slice();
});

describe('scripts/check-stale.js (CLI entry)', () => {
  it('exits with code 1 on invalid --type value', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    await runCli(['--type=not-a-valid-type']);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(String(errorSpy.mock.calls[0]?.[0] ?? '')).toContain('Invalid --type value');
  });

  it('defaults to CLAUDE check and outputs JSON results', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    fsPromisesMock = makeFsMock({
      readdirMap: {
        '/repo': [fileDirent('CLAUDE.md'), fileDirent('index.js'), dirDirent('src')],
        '/repo/src': [fileDirent('CLAUDE.md'), fileDirent('c.js')]
      },
      statMap: {
        '/repo/CLAUDE.md': date('2020-01-01T00:00:00.000Z'),
        '/repo/index.js': date('2021-01-01T00:00:00.000Z'),
        '/repo/src/CLAUDE.md': date('2022-01-01T00:00:00.000Z'),
        '/repo/src/c.js': date('2023-01-01T00:00:00.000Z')
      }
    });

    await runCli(['/repo', '--json']);

    const printed = logSpy.mock.calls.map((c) => c[0]).find((v) => typeof v === 'string');
    const parsed = JSON.parse(String(printed));

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.map((r) => r.path)).toEqual(['.', 'src']);
    expect(parsed.map((r) => r.status)).toEqual(['stale', 'stale']);

    expect(parsed[0].newestFile).toBe('index.js');
    expect(parsed[0].changedFiles.map((f) => f.path)).toEqual(['index.js']);

    expect(parsed[1].newestFile).toBe('src/c.js');
    expect(parsed[1].changedFiles.map((f) => f.path)).toEqual(['src/c.js']);
  });

  it('respects ignore patterns from config when determining staleness', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    fsPromisesMock = makeFsMock({
      readdirMap: {
        '/repo': [fileDirent('CLAUDE.md'), dirDirent('ignored')],
        '/repo/ignored': [fileDirent('x.js')]
      },
      statMap: {
        '/repo/CLAUDE.md': date('2020-01-01T00:00:00.000Z'),
        '/repo/ignored/x.js': date('2021-01-01T00:00:00.000Z')
      },
      readFileMap: {
        '/repo/.project-index/.stale-config.json': JSON.stringify({ ignore: ['ignored/**'] })
      }
    });

    await runCli(['/repo', '--json']);

    const printed = logSpy.mock.calls.map((c) => c[0]).find((v) => typeof v === 'string');
    const parsed = JSON.parse(String(printed));

    expect(parsed).toHaveLength(1);
    expect(parsed[0].path).toBe('.');
    expect(parsed[0].status).toBe('fresh');
    expect(parsed[0].codeMtime).toBe(null);
    expect(parsed[0].changedFiles).toEqual([]);
  });

  it('filters doc results via shouldProcess(config)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    shouldProcessMock = vi.fn((relativePath) => relativePath === '.');

    fsPromisesMock = makeFsMock({
      readdirMap: {
        '/repo': [fileDirent('CLAUDE.md'), fileDirent('index.js'), dirDirent('src')],
        '/repo/src': [fileDirent('CLAUDE.md'), fileDirent('c.js')]
      },
      statMap: {
        '/repo/CLAUDE.md': date('2020-01-01T00:00:00.000Z'),
        '/repo/index.js': date('2021-01-01T00:00:00.000Z'),
        '/repo/src/CLAUDE.md': date('2022-01-01T00:00:00.000Z'),
        '/repo/src/c.js': date('2023-01-01T00:00:00.000Z')
      }
    });

    await runCli(['/repo', '--json']);

    const printed = logSpy.mock.calls.map((c) => c[0]).find((v) => typeof v === 'string');
    const parsed = JSON.parse(String(printed));

    expect(parsed.map((r) => r.path)).toEqual(['.']);
    expect(shouldProcessMock).toHaveBeenCalled();
  });

  it('touch-all updates mtimes of stale docs', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'cwd').mockReturnValue('/repo');

    fsPromisesMock = makeFsMock({
      readdirMap: {
        '/repo': [fileDirent('CLAUDE.md'), fileDirent('index.js')]
      },
      statMap: {
        '/repo/CLAUDE.md': date('2020-01-01T00:00:00.000Z'),
        '/repo/index.js': date('2021-01-01T00:00:00.000Z')
      }
    });

    await runCli(['--touch-all', '--type', 'claude']);

    expect(fsPromisesMock.utimes).toHaveBeenCalledTimes(1);
    expect(fsPromisesMock.utimes.mock.calls[0][0]).toBe('/repo/CLAUDE.md');
    expect(fsPromisesMock.utimes.mock.calls[0][1]).toBeInstanceOf(Date);
    expect(fsPromisesMock.utimes.mock.calls[0][2]).toBeInstanceOf(Date);

    const messages = logSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('touched: ./CLAUDE.md'))).toBe(true);
    expect(messages.some((m) => m.includes('file(s) touched'))).toBe(true);
  });

  it('type=test outputs converted .test-map.json results in JSON mode', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    fsPromisesMock = makeFsMock({
      readdirMap: { '/repo': [] },
      statMap: {},
      readFileMap: {
        '/repo/.test-map.json': JSON.stringify({
          modules: {
            'js/agents/a': {
              coverage: '0%',
              covered: 0,
              stale: 0,
              untested: 2,
              total: 2,
              files: {
                a1: { status: 'untested', path: 'js/agents/a/a1.js' },
                a2: { status: 'untested', path: 'js/agents/a/a2.js' }
              }
            },
            'js/agents/b': {
              coverage: '50%',
              covered: 1,
              stale: 1,
              untested: 1,
              total: 2,
              files: {
                b1: { status: 'stale', path: 'js/agents/b/b1.js' },
                b2: { status: 'untested', path: 'js/agents/b/b2.js' }
              }
            },
            'js/agents/c': {
              coverage: '100%',
              covered: 2,
              stale: 0,
              untested: 0,
              total: 2,
              files: { c1: { status: 'covered', path: 'js/agents/c/c1.js' } }
            }
          }
        })
      }
    });

    await runCli(['/repo', '--json', '--type=test']);

    const printed = logSpy.mock.calls.map((c) => c[0]).find((v) => typeof v === 'string');
    const parsed = JSON.parse(String(printed));

    expect(parsed.map((r) => r.status)).toEqual(['missing', 'stale', 'fresh']);
    expect(parsed.map((r) => r.path)).toEqual(['js/agents/a', 'js/agents/b', 'js/agents/c']);

    expect(parsed[0].untestedFiles.map((f) => f.path)).toEqual(['js/agents/a/a1.js', 'js/agents/a/a2.js']);
    expect(parsed[0].changedFiles).toEqual([]);

    expect(parsed[1].changedFiles.map((f) => f.path)).toEqual(['js/agents/b/b1.js']);
    expect(parsed[1].untestedFiles.map((f) => f.path)).toEqual(['js/agents/b/b2.js']);

    expect(parsed[2].changedFiles).toEqual([]);
    expect(parsed[2].untestedFiles).toEqual([]);
  });

  it('type=test prints a warning and returns empty results when .test-map.json is missing', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    fsPromisesMock = makeFsMock({
      readdirMap: { '/repo': [] },
      statMap: {},
      readFileMap: {}
    });

    await runCli(['/repo', '--json', '--type', 'test']);

    const messages = logSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('Warning: .test-map.json not found'))).toBe(true);
    expect(messages.some((m) => m.trim() === '[]')).toBe(true);
  });
});

