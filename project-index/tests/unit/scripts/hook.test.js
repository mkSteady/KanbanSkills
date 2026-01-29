import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  promises: {
    access: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
  },
}));

vi.mock('os', () => ({
  default: {
    homedir: vi.fn(() => '/home/test'),
  },
}));

import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';

import {
  exists,
  readSettings,
  writeSettings,
  loadStaleConfig,
  hasHook,
  getInstalledHooks,
  installHook,
  removeHook,
  init,
  list,
  toggle,
  status,
  uninstall,
  main,
} from '../../../scripts/hook.js';

const ORIGINAL_ARGV = process.argv.slice();

const memFiles = new Map();
const memDirs = new Set();

function setFile(filePath, content) {
  memFiles.set(filePath, content);
  memDirs.add(path.dirname(filePath));
}

function getJson(filePath) {
  return JSON.parse(memFiles.get(filePath));
}

beforeEach(() => {
  process.argv = ORIGINAL_ARGV.slice();
  memFiles.clear();
  memDirs.clear();

  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  fs.access.mockImplementation(async (p) => {
    if (memFiles.has(p) || memDirs.has(p)) return;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });

  fs.readFile.mockImplementation(async (p) => {
    if (!memFiles.has(p)) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }
    return memFiles.get(p);
  });

  fs.writeFile.mockImplementation(async (p, content) => {
    memFiles.set(p, content);
    memDirs.add(path.dirname(p));
  });

  fs.mkdir.mockImplementation(async (dirPath) => {
    memDirs.add(dirPath);
  });
});

describe('exists', () => {
  it('returns true when path is accessible', async () => {
    setFile('/tmp/a.txt', 'x');
    await expect(exists('/tmp/a.txt')).resolves.toBe(true);
    expect(fs.access).toHaveBeenCalledWith('/tmp/a.txt');
  });

  it('returns false when path is not accessible', async () => {
    await expect(exists('/tmp/missing.txt')).resolves.toBe(false);
    expect(fs.access).toHaveBeenCalledWith('/tmp/missing.txt');
  });
});

describe('readSettings', () => {
  it('returns empty object when settings file does not exist', async () => {
    const settings = await readSettings('/proj/.claude/settings.json');
    expect(settings).toEqual({});
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('parses JSON when settings file exists', async () => {
    setFile('/proj/.claude/settings.json', JSON.stringify({ hooks: { a: 1 } }));
    const settings = await readSettings('/proj/.claude/settings.json');
    expect(settings).toEqual({ hooks: { a: 1 } });
  });

  it('throws when settings content is invalid JSON', async () => {
    setFile('/proj/.claude/settings.json', '{not json}');
    await expect(readSettings('/proj/.claude/settings.json')).rejects.toThrow();
  });
});

describe('writeSettings', () => {
  it('creates parent directory when missing, then writes JSON', async () => {
    await writeSettings('/proj/.claude/settings.json', { a: 1 });
    expect(fs.mkdir).toHaveBeenCalledWith('/proj/.claude', { recursive: true });
    expect(getJson('/proj/.claude/settings.json')).toEqual({ a: 1 });
  });

  it('does not create parent directory when it exists', async () => {
    memDirs.add('/proj/.claude');
    await writeSettings('/proj/.claude/settings.json', { a: 1 });
    expect(fs.mkdir).not.toHaveBeenCalled();
    expect(getJson('/proj/.claude/settings.json')).toEqual({ a: 1 });
  });

  it('propagates write errors', async () => {
    memDirs.add('/proj/.claude');
    fs.writeFile.mockRejectedValueOnce(new Error('disk full'));
    await expect(writeSettings('/proj/.claude/settings.json', { a: 1 })).rejects.toThrow('disk full');
  });
});

describe('loadStaleConfig', () => {
  it('returns parsed config when .stale-config.json exists', async () => {
    const stalePath = path.join(process.cwd(), '.stale-config.json');
    setFile(stalePath, JSON.stringify({ notify: { onSessionStart: false } }));
    await expect(loadStaleConfig()).resolves.toEqual({ notify: { onSessionStart: false } });
    expect(fs.readFile).toHaveBeenCalledWith(stalePath, 'utf-8');
  });

  it('returns empty object when .stale-config.json does not exist', async () => {
    await expect(loadStaleConfig()).resolves.toEqual({});
  });

  it('returns empty object when config is invalid JSON', async () => {
    const stalePath = path.join(process.cwd(), '.stale-config.json');
    setFile(stalePath, '{not json}');
    await expect(loadStaleConfig()).resolves.toEqual({});
  });
});

describe('hasHook', () => {
  it('returns false for unknown hook name', () => {
    expect(hasHook({}, 'unknown')).toBe(false);
  });

  it('returns false when hook type list is missing or has no project-index sub-hook', () => {
    expect(hasHook({}, 'post-commit')).toBe(false);
    expect(
      hasHook(
        { hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'node ./other.js' }] }] } },
        'post-commit',
      ),
    ).toBe(false);
  });

  it('returns true when any sub-hook command contains project-index', () => {
    expect(
      hasHook(
        { hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'node ~/.claude/skills/project-index/x.js' }] }] } },
        'post-commit',
      ),
    ).toBe(true);
  });
});

describe('getInstalledHooks', () => {
  it('returns empty list when no project-index hooks are installed', () => {
    expect(getInstalledHooks({})).toEqual([]);
  });

  it('returns installed hooks with name/type/config', () => {
    const settings = {
      hooks: {
        PostToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'node ~/.claude/skills/project-index/scripts/update.js' }] },
        ],
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'node ~/.claude/skills/project-index/scripts/stale-notify.js' }] },
        ],
      },
    };

    const installed = getInstalledHooks(settings);
    expect(installed.map((h) => h.name)).toEqual(['post-commit', 'stale-notify']);
    expect(installed[0]).toEqual({
      name: 'post-commit',
      type: 'PostToolUse',
      config: settings.hooks.PostToolUse[0],
    });
    expect(installed[1]).toEqual({
      name: 'stale-notify',
      type: 'UserPromptSubmit',
      config: settings.hooks.UserPromptSubmit[0],
    });
  });
});

describe('installHook', () => {
  it('returns false and prints available hooks for unknown hook', async () => {
    await expect(installHook('nope', 'project')).resolves.toBe(false);
    expect(console.log).toHaveBeenCalledWith('Unknown hook: nope');
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('installs hook into project settings when not present', async () => {
    const projectSettingsPath = path.join(process.cwd(), '.claude', 'settings.json');

    await expect(installHook('post-commit', 'project')).resolves.toBe(true);

    const written = getJson(projectSettingsPath);
    expect(written.hooks.PostToolUse).toHaveLength(1);
    expect(written.hooks.PostToolUse[0]).toMatchObject({
      matcher: 'Bash',
      hooks: [{ type: 'command', command: expect.stringContaining('project-index') }],
    });
  });

  it('installs hook into global settings when scope is global', async () => {
    const globalSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');

    await expect(installHook('stale-notify', 'global')).resolves.toBe(true);

    const written = getJson(globalSettingsPath);
    expect(written.hooks.UserPromptSubmit).toHaveLength(1);
    expect(written.hooks.UserPromptSubmit[0]).toMatchObject({
      hooks: [{ type: 'command', command: expect.stringContaining('project-index') }],
    });
  });

  it('does not rewrite settings when hook is already installed', async () => {
    const projectSettingsPath = path.join(process.cwd(), '.claude', 'settings.json');
    setFile(
      projectSettingsPath,
      JSON.stringify({
        hooks: {
          PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node ~/.claude/skills/project-index/a.js' }] }],
        },
      }),
    );

    await expect(installHook('post-commit', 'project')).resolves.toBe(true);
    expect(fs.writeFile).not.toHaveBeenCalled();
  });
});

describe('removeHook', () => {
  it('returns false for unknown hook', async () => {
    await expect(removeHook('unknown', 'project')).resolves.toBe(false);
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('returns false when hook type list is missing', async () => {
    await expect(removeHook('post-commit', 'project')).resolves.toBe(false);
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('returns false when no project-index hook is present', async () => {
    const projectSettingsPath = path.join(process.cwd(), '.claude', 'settings.json');
    setFile(
      projectSettingsPath,
      JSON.stringify({
        hooks: {
          PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node ./something-else.js' }] }],
        },
      }),
    );

    await expect(removeHook('post-commit', 'project')).resolves.toBe(false);
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('removes project-index hooks and writes updated settings', async () => {
    const projectSettingsPath = path.join(process.cwd(), '.claude', 'settings.json');
    setFile(
      projectSettingsPath,
      JSON.stringify({
        hooks: {
          PostToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'node ~/.claude/skills/project-index/a.js' }] },
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'node ./other.js' }] },
          ],
        },
      }),
    );

    await expect(removeHook('post-commit', 'project')).resolves.toBe(true);

    const written = getJson(projectSettingsPath);
    expect(written.hooks.PostToolUse).toHaveLength(1);
    expect(written.hooks.PostToolUse[0]).toMatchObject({
      hooks: [{ command: 'node ./other.js' }],
    });
  });
});

describe('init', () => {
  it('installs recommended hooks and creates default .stale-config.json when missing', async () => {
    const projectSettingsPath = path.join(process.cwd(), '.claude', 'settings.json');
    const stalePath = path.join(process.cwd(), '.stale-config.json');

    await init('project');

    const settings = getJson(projectSettingsPath);
    expect(settings.hooks.PostToolUse).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);

    const config = getJson(stalePath);
    expect(config).toMatchObject({
      notify: { enabled: true, threshold: 3, onSessionStart: true },
      concurrency: 6,
    });
  });

  it('respects notify.onSessionStart=false and does not install stale-notify', async () => {
    const stalePath = path.join(process.cwd(), '.stale-config.json');
    const projectSettingsPath = path.join(process.cwd(), '.claude', 'settings.json');

    const existingConfig = JSON.stringify({ notify: { onSessionStart: false } });
    setFile(stalePath, existingConfig);

    await init('project');

    expect(memFiles.get(stalePath)).toBe(existingConfig);
    const settings = getJson(projectSettingsPath);
    expect(settings.hooks.PostToolUse).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit || []).toHaveLength(0);
  });
});

describe('list', () => {
  it('prints (none) when no hooks are installed', async () => {
    await list();
    const lines = console.log.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain('  (none)');
    expect(lines.some((l) => l.includes('Available hooks:'))).toBe(true);
    expect(lines.some((l) => l.includes('○ post-commit - Update CLAUDE.md after git commit'))).toBe(true);
  });

  it('prints project section when project hooks are installed', async () => {
    const projectSettingsPath = path.join(process.cwd(), '.claude', 'settings.json');
    setFile(
      projectSettingsPath,
      JSON.stringify({
        hooks: {
          PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node ~/.claude/skills/project-index/a.js' }] }],
        },
      }),
    );

    await list();
    const lines = console.log.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain('Project (.claude/settings.json):');
    expect(lines.some((l) => l.includes('✓ post-commit (PostToolUse)'))).toBe(true);
  });
});

describe('toggle', () => {
  it('prints usage for unknown hook and makes no changes', async () => {
    await toggle('nope', undefined, 'project');
    expect(console.log).toHaveBeenCalledWith('Unknown hook: nope');
    expect(memFiles.size).toBe(0);
  });

  it('installs when state is undefined and hook is not installed', async () => {
    const projectSettingsPath = path.join(process.cwd(), '.claude', 'settings.json');
    await toggle('post-commit', undefined, 'project');
    expect(memFiles.has(projectSettingsPath)).toBe(true);
  });

  it('removes when state is undefined and hook is installed', async () => {
    const projectSettingsPath = path.join(process.cwd(), '.claude', 'settings.json');
    setFile(
      projectSettingsPath,
      JSON.stringify({
        hooks: {
          PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node ~/.claude/skills/project-index/a.js' }] }],
        },
      }),
    );

    await toggle('post-commit', undefined, 'project');
    const settings = getJson(projectSettingsPath);
    expect(settings.hooks.PostToolUse || []).toHaveLength(0);
  });
});

describe('status', () => {
  it('prints missing config message when .stale-config.json is absent', async () => {
    await status();
    const lines = console.log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('No .stale-config.json found'))).toBe(true);
  });

  it('prints notify config when .stale-config.json exists', async () => {
    const stalePath = path.join(process.cwd(), '.stale-config.json');
    setFile(stalePath, JSON.stringify({ notify: { onSessionStart: false, threshold: 9 } }));

    await status();
    const lines = console.log.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain('  notify.onSessionStart: false');
    expect(lines).toContain('  notify.threshold: 9');
  });
});

describe('uninstall', () => {
  it('prints "No hooks found." when nothing is installed', async () => {
    await uninstall('project');
    expect(console.log).toHaveBeenCalledWith('No hooks found.');
  });

  it('removes all known hooks and reports count', async () => {
    const projectSettingsPath = path.join(process.cwd(), '.claude', 'settings.json');
    setFile(
      projectSettingsPath,
      JSON.stringify({
        hooks: {
          PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node ~/.claude/skills/project-index/a.js' }] }],
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node ~/.claude/skills/project-index/b.js' }] }],
        },
      }),
    );

    await uninstall('project');
    expect(console.log).toHaveBeenCalledWith('\n2 hook(s) removed.');

    const settings = getJson(projectSettingsPath);
    expect(settings.hooks.PostToolUse || []).toHaveLength(0);
    expect(settings.hooks.UserPromptSubmit || []).toHaveLength(0);
  });
});

describe('main', () => {
  it('prints usage when called with no command', async () => {
    process.argv = ['node', 'hook.js'];
    await main();
    expect(console.log).toHaveBeenCalledWith('Usage:');
    expect(console.log.mock.calls.some((c) => String(c[0]).includes('Hooks:'))).toBe(true);
  });

  it('installs default post-commit hook for install command', async () => {
    const projectSettingsPath = path.join(process.cwd(), '.claude', 'settings.json');
    process.argv = ['node', 'hook.js', 'install'];
    await main();
    const settings = getJson(projectSettingsPath);
    expect(settings.hooks.PostToolUse).toHaveLength(1);
  });

  it('installs provided hook into global scope when --global is used', async () => {
    const globalSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    process.argv = ['node', 'hook.js', 'install', 'stale-notify', '--global'];
    await main();
    const settings = getJson(globalSettingsPath);
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
  });
});
