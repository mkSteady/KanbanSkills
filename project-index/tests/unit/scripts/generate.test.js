import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

let memFs;

class MemFs {
  constructor() {
    this.files = new Map();
    this.dirs = new Map();
    this.readdirErrors = new Map();
    this.readFileErrors = new Map();
    this.accessErrors = new Map();
    this.writes = new Map();

    this.addDir(path.parse(process.cwd()).root || '/');
  }

  normalize(p) {
    return path.resolve(p);
  }

  addDir(dirPath) {
    const normalized = this.normalize(dirPath);
    const root = path.parse(normalized).root || '/';
    const parts = normalized
      .slice(root.length)
      .split(path.sep)
      .filter(Boolean);

    let current = root;
    if (!this.dirs.has(current)) this.dirs.set(current, new Map());

    for (const part of parts) {
      const next = path.join(current, part);
      if (!this.dirs.has(next)) this.dirs.set(next, new Map());
      const children = this.dirs.get(current);
      if (children && !children.has(part)) children.set(part, 'dir');
      current = next;
    }

    return normalized;
  }

  addFile(filePath, content = '') {
    const normalized = this.normalize(filePath);
    const parent = path.dirname(normalized);
    this.addDir(parent);
    this.files.set(normalized, content);
    const children = this.dirs.get(parent);
    if (children) children.set(path.basename(normalized), 'file');
    return normalized;
  }

  setReaddirError(dirPath, err = new Error('readdir failed')) {
    this.readdirErrors.set(this.normalize(dirPath), err);
  }

  setReadFileError(filePath, err = new Error('readFile failed')) {
    this.readFileErrors.set(this.normalize(filePath), err);
  }

  setAccessError(targetPath, err = new Error('access failed')) {
    this.accessErrors.set(this.normalize(targetPath), err);
  }

  async access(targetPath) {
    const normalized = this.normalize(targetPath);
    const forced = this.accessErrors.get(normalized);
    if (forced) throw forced;

    if (this.files.has(normalized) || this.writes.has(normalized) || this.dirs.has(normalized)) return;
    const err = new Error(`ENOENT: no such file or directory, access '${normalized}'`);
    err.code = 'ENOENT';
    throw err;
  }

  async readFile(filePath) {
    const normalized = this.normalize(filePath);
    const forced = this.readFileErrors.get(normalized);
    if (forced) throw forced;

    if (this.files.has(normalized)) return this.files.get(normalized);
    if (this.writes.has(normalized)) return this.writes.get(normalized);
    const err = new Error(`ENOENT: no such file or directory, open '${normalized}'`);
    err.code = 'ENOENT';
    throw err;
  }

  async writeFile(filePath, data) {
    const normalized = this.normalize(filePath);
    const parent = path.dirname(normalized);
    this.addDir(parent);
    this.writes.set(normalized, String(data));
    const children = this.dirs.get(parent);
    if (children) children.set(path.basename(normalized), 'file');
  }

  async readdir(dirPath) {
    const normalized = this.normalize(dirPath);
    const forced = this.readdirErrors.get(normalized);
    if (forced) throw forced;

    const children = this.dirs.get(normalized);
    if (!children) {
      const err = new Error(`ENOENT: no such file or directory, scandir '${normalized}'`);
      err.code = 'ENOENT';
      throw err;
    }

    return Array.from(children.entries()).map(([name, kind]) => ({
      name,
      isFile: () => kind === 'file',
      isDirectory: () => kind === 'dir',
    }));
  }
}

function lines(count) {
  return Array.from({ length: count }, (_, i) => `line${i + 1}`).join('\n');
}

const fsPromisesMock = {
  access: vi.fn((p) => memFs.access(p)),
  readFile: vi.fn((p, _encoding) => memFs.readFile(p)),
  readdir: vi.fn((p, _options) => memFs.readdir(p)),
  writeFile: vi.fn((p, data) => memFs.writeFile(p, data)),
};

vi.mock('fs', () => ({ promises: fsPromisesMock }));
vi.mock('child_process', () => ({ execSync: vi.fn() }));

beforeEach(() => {
  memFs = new MemFs();
  vi.clearAllMocks();
  vi.resetModules();
});

describe('findDirsNeedingIndex', () => {
  it('detects dirs needing update/create and sorts by priority', async () => {
    const rootPath = path.resolve('/repo');
    memFs.addDir(rootPath);
    memFs.addDir(path.join(rootPath, 'modules'));

    // Parent with CLAUDE.md and multiple unindexed small subdirs
    const parentDir = path.join(rootPath, 'modules', 'parent');
    memFs.addDir(parentDir);
    memFs.addFile(path.join(parentDir, 'CLAUDE.md'), '# parent index');

    const child1 = path.join(parentDir, 'child1');
    memFs.addDir(child1);
    memFs.addFile(path.join(child1, 'a.js'), lines(1));

    const child2 = path.join(parentDir, 'child2');
    memFs.addDir(child2);
    memFs.addFile(path.join(child2, 'b.ts'), lines(2));

    // Large child without CLAUDE.md (should be in needsCreate),
    // and it contains a small unindexed subdir (should count toward parent's smallChildren)
    const childLarge = path.join(parentDir, 'childLarge');
    memFs.addDir(childLarge);
    for (let i = 1; i <= 5; i++) {
      memFs.addFile(path.join(childLarge, `f${i}.js`), lines(1));
    }
    const tiny = path.join(childLarge, 'tiny');
    memFs.addDir(tiny);
    memFs.addFile(path.join(tiny, 'c.jsx'), lines(3));

    // Another parent with fewer unindexed small subdirs
    const otherParent = path.join(rootPath, 'modules', 'other');
    memFs.addDir(otherParent);
    memFs.addFile(path.join(otherParent, 'CLAUDE.md'), '# other index');
    const otherChild = path.join(otherParent, 'child');
    memFs.addDir(otherChild);
    memFs.addFile(path.join(otherChild, 'x.js'), lines(1));

    // Large dirs without CLAUDE.md
    const hugeDir = path.join(rootPath, 'modules', 'huge');
    memFs.addDir(hugeDir);
    memFs.addFile(path.join(hugeDir, 'huge.js'), lines(300));

    const exactLinesDir = path.join(rootPath, 'modules', 'lineExact');
    memFs.addDir(exactLinesDir);
    memFs.addFile(path.join(exactLinesDir, 'exact.js'), lines(200));

    // Directory with only test/spec files should not count as code
    const testOnly = path.join(rootPath, 'modules', 'testOnly');
    memFs.addDir(testOnly);
    memFs.addFile(path.join(testOnly, 'a.test.js'), lines(999));
    memFs.addFile(path.join(testOnly, 'b.spec.ts'), lines(999));

    const { findDirsNeedingIndex } = await import('../../../scripts/generate.js');
    const { needsUpdate, needsCreate } = await findDirsNeedingIndex(rootPath, 'modules');

    expect(needsUpdate.map((d) => d.path)).toEqual([
      path.join('modules', 'parent'),
      path.join('modules', 'other'),
    ]);
    expect(needsUpdate[0]).toMatchObject({
      path: path.join('modules', 'parent'),
      reason: 'has_small_children',
      smallChildren: 3,
    });
    expect(needsUpdate[1]).toMatchObject({
      path: path.join('modules', 'other'),
      reason: 'has_small_children',
      smallChildren: 1,
    });

    expect(needsCreate.map((d) => d.path)).toEqual([
      path.join('modules', 'huge'),
      path.join('modules', 'lineExact'),
      path.join('modules', 'parent', 'childLarge'),
    ]);
    expect(needsCreate[0]).toMatchObject({
      path: path.join('modules', 'huge'),
      fileCount: 1,
      lineCount: 300,
    });
    expect(needsCreate[1]).toMatchObject({
      path: path.join('modules', 'lineExact'),
      fileCount: 1,
      lineCount: 200,
    });
    expect(needsCreate[2]).toMatchObject({
      path: path.join('modules', 'parent', 'childLarge'),
      fileCount: 5,
      lineCount: 5,
    });
    expect(needsCreate.some((d) => d.path.includes('testOnly'))).toBe(false);
  });

  it('returns empty lists when scanPath does not exist', async () => {
    const rootPath = path.resolve('/repo');
    memFs.addDir(rootPath);

    const { findDirsNeedingIndex } = await import('../../../scripts/generate.js');
    await expect(findDirsNeedingIndex(rootPath, 'missing')).resolves.toEqual({
      needsUpdate: [],
      needsCreate: [],
    });
  });

  it('swallows filesystem errors and continues scanning other dirs', async () => {
    const rootPath = path.resolve('/repo');
    memFs.addDir(rootPath);
    memFs.addDir(path.join(rootPath, 'modules'));

    const okLarge = path.join(rootPath, 'modules', 'okLarge');
    memFs.addDir(okLarge);
    memFs.addFile(path.join(okLarge, 'ok.js'), lines(250));

    const brokenLarge = path.join(rootPath, 'modules', 'brokenLarge');
    memFs.addDir(brokenLarge);
    memFs.addFile(path.join(brokenLarge, 'broken.js'), lines(250));
    memFs.setReaddirError(brokenLarge, new Error('EACCES'));

    const { findDirsNeedingIndex } = await import('../../../scripts/generate.js');
    const { needsCreate } = await findDirsNeedingIndex(rootPath, 'modules');

    expect(needsCreate.map((d) => d.path)).toEqual([path.join('modules', 'okLarge')]);
  });
});

describe('findLargeDirs', () => {
  it('returns large dirs with relative paths sorted by lineCount desc', async () => {
    const rootPath = path.resolve('/repo');
    memFs.addDir(rootPath);

    const srcDir = path.join(rootPath, 'src');
    memFs.addDir(srcDir);

    // Make src large via file count threshold (exactly 5)
    for (let i = 1; i <= 5; i++) {
      memFs.addFile(path.join(srcDir, `file${i}.js`), lines(1));
    }

    // Should be ignored by analyzer
    memFs.addFile(path.join(srcDir, 'ignored.test.js'), lines(999));
    memFs.addFile(path.join(srcDir, 'ignored.spec.ts'), lines(999));
    memFs.addFile(path.join(srcDir, 'README.md'), lines(999));

    const bigDir = path.join(srcDir, 'big');
    memFs.addDir(bigDir);
    memFs.addFile(path.join(bigDir, 'main.ts'), lines(250));

    const exactDir = path.join(srcDir, 'exact');
    memFs.addDir(exactDir);
    memFs.addFile(path.join(exactDir, 'mod.js'), lines(200));

    const smallDir = path.join(srcDir, 'small');
    memFs.addDir(smallDir);
    memFs.addFile(path.join(smallDir, 'one.js'), lines(10));
    memFs.addFile(path.join(smallDir, 'two.js'), lines(10));

    const ignoredDir = path.join(srcDir, 'node_modules');
    memFs.addDir(ignoredDir);
    memFs.addFile(path.join(ignoredDir, 'ignored.js'), lines(999));

    const hiddenDir = path.join(srcDir, '.hidden');
    memFs.addDir(hiddenDir);
    memFs.addFile(path.join(hiddenDir, 'h.js'), lines(999));

    const { findLargeDirs } = await import('../../../scripts/generate.js');
    const results = await findLargeDirs(rootPath, 'src');

    expect(results.map((r) => r.path)).toEqual([
      path.join('src', 'big'),
      path.join('src', 'exact'),
      'src',
    ]);
    expect(results[0]).toMatchObject({ path: path.join('src', 'big'), fileCount: 1, lineCount: 250 });
    expect(results[1]).toMatchObject({ path: path.join('src', 'exact'), fileCount: 1, lineCount: 200 });
    expect(results[2]).toMatchObject({ path: 'src', fileCount: 5, lineCount: 5 });
    expect(results.some((r) => r.path.includes('node_modules'))).toBe(false);
    expect(results.some((r) => r.path.includes('.hidden'))).toBe(false);
    expect(results.some((r) => r.path.includes('small'))).toBe(false);
  });

  it('does not throw on readdir/readFile errors and still detects other large dirs', async () => {
    const rootPath = path.resolve('/repo');
    memFs.addDir(rootPath);

    const srcDir = path.join(rootPath, 'src');
    memFs.addDir(srcDir);

    // Large via file count; one file read error should not prevent counting as large.
    for (let i = 1; i <= 5; i++) {
      const filePath = path.join(srcDir, `f${i}.js`);
      memFs.addFile(filePath, lines(1));
      if (i === 3) memFs.setReadFileError(filePath, new Error('boom'));
    }

    const brokenDir = path.join(srcDir, 'broken');
    memFs.addDir(brokenDir);
    memFs.addFile(path.join(brokenDir, 'x.js'), lines(250));
    memFs.setReaddirError(brokenDir, new Error('EACCES'));

    const okDir = path.join(srcDir, 'ok');
    memFs.addDir(okDir);
    memFs.addFile(path.join(okDir, 'y.js'), lines(250));

    const { findLargeDirs } = await import('../../../scripts/generate.js');
    const results = await findLargeDirs(rootPath, 'src');

    expect(results.map((r) => r.path)).toEqual([path.join('src', 'ok'), 'src']);
    expect(results.find((r) => r.path === 'src')).toMatchObject({ path: 'src', fileCount: 5, lineCount: 4 });
  });

  it('returns empty array when scanPath does not exist', async () => {
    const rootPath = path.resolve('/repo');
    memFs.addDir(rootPath);

    const { findLargeDirs } = await import('../../../scripts/generate.js');
    await expect(findLargeDirs(rootPath, 'missing')).resolves.toEqual([]);
  });
});

