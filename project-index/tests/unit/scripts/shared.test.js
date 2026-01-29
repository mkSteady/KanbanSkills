import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';

vi.mock('fs', () => ({
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn()
  }
}));

import {
  DEFAULT_MAX_LINES,
  CRASH_THRESHOLD_MINUTES,
  DEFAULT_TIMEOUT,
  DEFAULT_CONCURRENCY,
  readFileSafe,
  loadConfig,
  matchesPattern,
  shouldProcess,
  readJsonSafe,
  writeJsonSafe,
  unlinkSafe
} from '../../../scripts/shared.js';

beforeEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});

describe('DEFAULT_MAX_LINES', () => {
  it('should be 100', () => {
    expect(DEFAULT_MAX_LINES).toBe(100);
  });
});

describe('CRASH_THRESHOLD_MINUTES', () => {
  it('should be 35', () => {
    expect(CRASH_THRESHOLD_MINUTES).toBe(35);
  });
});

describe('DEFAULT_TIMEOUT', () => {
  it('should be 1800000', () => {
    expect(DEFAULT_TIMEOUT).toBe(1800000);
  });
});

describe('DEFAULT_CONCURRENCY', () => {
  it('should be 6', () => {
    expect(DEFAULT_CONCURRENCY).toBe(6);
  });
});

describe('readFileSafe', () => {
  it('should return full content when line count is within maxLines', async () => {
    fs.readFile.mockResolvedValueOnce('a\nb');

    const res = await readFileSafe('/abs/file.txt', 10);

    expect(fs.readFile).toHaveBeenCalledWith('/abs/file.txt', 'utf-8');
    expect(res).toBe('a\nb');
  });

  it('should not truncate when line count equals maxLines', async () => {
    const content = ['l1', 'l2', 'l3'].join('\n');
    fs.readFile.mockResolvedValueOnce(content);

    const res = await readFileSafe('/abs/file.txt', 3);

    expect(res).toBe(content);
  });

  it('should truncate content and append ellipsis when line count exceeds maxLines', async () => {
    const content = ['l1', 'l2', 'l3'].join('\n');
    fs.readFile.mockResolvedValueOnce(content);

    const res = await readFileSafe('/abs/file.txt', 2);

    expect(res).toBe('l1\nl2\n... (1 more lines)');
  });

  it('should use DEFAULT_MAX_LINES when maxLines is not provided', async () => {
    const lines = Array.from({ length: DEFAULT_MAX_LINES + 1 }, (_, i) => `line-${i + 1}`);
    const content = lines.join('\n');
    fs.readFile.mockResolvedValueOnce(content);

    const res = await readFileSafe('/abs/file.txt');

    const expected =
      lines.slice(0, DEFAULT_MAX_LINES).join('\n') + `\n... (${lines.length - DEFAULT_MAX_LINES} more lines)`;
    expect(res).toBe(expected);
  });

  it('should return null on read error', async () => {
    fs.readFile.mockRejectedValueOnce(new Error('read failed'));

    const res = await readFileSafe('/abs/file.txt', 10);

    expect(res).toBeNull();
  });
});

describe('loadConfig', () => {
  it('should load and parse config JSON from .project-index/.stale-config.json', async () => {
    fs.readFile.mockResolvedValueOnce(JSON.stringify({ include: ['src'] }));
    const cwd = '/repo';

    const res = await loadConfig(cwd);

    expect(fs.readFile).toHaveBeenCalledWith(path.join(cwd, '.project-index', '.stale-config.json'), 'utf-8');
    expect(res).toEqual({ include: ['src'] });
  });

  it('should return empty object when file does not exist or cannot be read', async () => {
    fs.readFile.mockRejectedValueOnce(new Error('ENOENT'));

    const res = await loadConfig('/repo');

    expect(res).toEqual({});
  });

  it('should return empty object when JSON is invalid', async () => {
    fs.readFile.mockResolvedValueOnce('{ invalid json');

    const res = await loadConfig('/repo');

    expect(res).toEqual({});
  });
});

describe('matchesPattern', () => {
  it('should return false when patterns is missing or empty', () => {
    expect(matchesPattern('src/index.js')).toBe(false);
    expect(matchesPattern('src/index.js', [])).toBe(false);
  });

  it('should match single-segment * patterns', () => {
    expect(matchesPattern('src/foo.js', ['src/*.js'])).toBe(true);
    expect(matchesPattern('src/foo.ts', ['src/*.js'])).toBe(false);
    expect(matchesPattern('src/foo/bar.js', ['src/*.js'])).toBe(false);
  });

  it('should treat patterns as anchored prefixes (match directory roots too)', () => {
    expect(matchesPattern('src', ['src'])).toBe(true);
    expect(matchesPattern('src/utils/a.js', ['src'])).toBe(true);
    expect(matchesPattern('scripts/shared.js', ['src'])).toBe(false);
  });

  it('should escape "." so it matches a literal dot', () => {
    expect(matchesPattern('foo.bar', ['foo.bar'])).toBe(true);
    expect(matchesPattern('fooXbar', ['foo.bar'])).toBe(false);
    expect(matchesPattern('foo.bar/baz', ['foo.bar'])).toBe(true);
  });

  it('should support "**" patterns based on the current glob-to-regex conversion', () => {
    expect(matchesPattern('src/a/b/c.js', ['src/**'])).toBe(true);
    expect(matchesPattern('src/a/b.js', ['src/**/*.js'])).toBe(true);
    expect(matchesPattern('src/a.js', ['src/**/*.js'])).toBe(false);
    expect(matchesPattern('src/a/b/c.js', ['src/**/*.js'])).toBe(false);
  });
});

describe('shouldProcess', () => {
  it('should return true when include/ignore are not provided', () => {
    expect(shouldProcess('any/file.js', {})).toBe(true);
  });

  it('should require a match when include is defined', () => {
    expect(shouldProcess('docs/readme.md', { include: ['src'] })).toBe(false);
    expect(shouldProcess('src/index.js', { include: ['src'] })).toBe(true);
  });

  it('should exclude a match when ignore is defined', () => {
    expect(shouldProcess('node_modules/pkg/index.js', { ignore: ['node_modules'] })).toBe(false);
    expect(shouldProcess('src/index.js', { ignore: ['node_modules'] })).toBe(true);
  });

  it('should apply ignore even when include matches', () => {
    expect(shouldProcess('src/ignore.js', { include: ['src'], ignore: ['src/ignore.js'] })).toBe(false);
  });

  it('should treat empty include/ignore arrays as not defined', () => {
    expect(shouldProcess('any/file.js', { include: [] })).toBe(true);
    expect(shouldProcess('any/file.js', { ignore: [] })).toBe(true);
    expect(shouldProcess('any/file.js', { include: [], ignore: [] })).toBe(true);
  });
});

describe('readJsonSafe', () => {
  it('should return parsed JSON on success', async () => {
    fs.readFile.mockResolvedValueOnce('{"a":1}');

    const res = await readJsonSafe('/abs/data.json');

    expect(fs.readFile).toHaveBeenCalledWith('/abs/data.json', 'utf-8');
    expect(res).toEqual({ a: 1 });
  });

  it('should return defaultValue when file cannot be read', async () => {
    fs.readFile.mockRejectedValueOnce(new Error('ENOENT'));

    const res = await readJsonSafe('/abs/data.json', { fallback: true });

    expect(res).toEqual({ fallback: true });
  });

  it('should return defaultValue when JSON is invalid', async () => {
    fs.readFile.mockResolvedValueOnce('{not json');

    const res = await readJsonSafe('/abs/data.json', []);

    expect(res).toEqual([]);
  });

  it('should default defaultValue to null', async () => {
    fs.readFile.mockRejectedValueOnce(new Error('boom'));

    const res = await readJsonSafe('/abs/data.json');

    expect(res).toBeNull();
  });
});

describe('writeJsonSafe', () => {
  it('should write pretty-printed JSON and return true on success', async () => {
    fs.writeFile.mockResolvedValueOnce();

    const res = await writeJsonSafe('/abs/out.json', { a: 1 });

    expect(fs.writeFile).toHaveBeenCalledWith('/abs/out.json', '{\n  "a": 1\n}');
    expect(res).toBe(true);
  });

  it('should return false on write error', async () => {
    fs.writeFile.mockRejectedValueOnce(new Error('EACCES'));

    const res = await writeJsonSafe('/abs/out.json', { a: 1 });

    expect(res).toBe(false);
  });
});

describe('unlinkSafe', () => {
  it('should delete file and return true on success', async () => {
    fs.unlink.mockResolvedValueOnce();

    const res = await unlinkSafe('/abs/to-delete.txt');

    expect(fs.unlink).toHaveBeenCalledWith('/abs/to-delete.txt');
    expect(res).toBe(true);
  });

  it('should return false on error (including missing file)', async () => {
    fs.unlink.mockRejectedValueOnce(new Error('ENOENT'));

    const res = await unlinkSafe('/abs/to-delete.txt');

    expect(res).toBe(false);
  });
});

