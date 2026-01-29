/**
 * Hook manager - Install/manage Claude Code hooks
 * Supports post-commit and stale-notify hooks
 */

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

/**
 * Available hook definitions
 */
const HOOKS = {
  'post-commit': {
    type: 'PostToolUse',
    config: {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'pi doc check --silent' }]
    },
    description: 'Check stale docs after git commit'
  },
  'stale-notify': {
    type: 'UserPromptSubmit',
    config: {
      hooks: [{ type: 'command', command: 'pi stale notify' }]
    },
    description: 'Notify stale modules on session start'
  },
  'pre-push': {
    type: 'PreToolUse',
    config: {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'pi test run --affected' }]
    },
    description: 'Run affected tests before push'
  }
};

/**
 * Read settings file
 */
async function readSettings(settingsPath) {
  try {
    const content = await fs.readFile(settingsPath, 'utf8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

/**
 * Write settings file
 */
async function writeSettings(settingsPath, settings) {
  const dir = path.dirname(settingsPath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
}

/**
 * Get project settings path
 */
function getProjectSettingsPath(root) {
  return path.join(root, '.claude', 'settings.json');
}

/**
 * Check if hook is installed
 */
function hasHook(settings, hookName) {
  const hookDef = HOOKS[hookName];
  if (!hookDef) return false;

  const hookList = settings.hooks?.[hookDef.type] || [];
  return hookList.some(h => {
    const subHooks = h.hooks || [];
    return subHooks.some(sh => sh.command?.includes('pi '));
  });
}

/**
 * Install a hook
 * @param {{root: string, config: any}} ctx
 * @param {object} args
 */
export async function install(ctx, args) {
  const { root } = ctx;
  const hookName = args._[3]; // pi hook install <name>
  const isGlobal = args.global;

  if (!hookName) {
    console.log('Available hooks:');
    for (const [name, def] of Object.entries(HOOKS)) {
      console.log(`  ${name}: ${def.description}`);
    }
    console.log('\nUsage: pi hook install <name> [--global]');
    return;
  }

  const hookDef = HOOKS[hookName];
  if (!hookDef) {
    console.error(`Unknown hook: ${hookName}`);
    console.error(`Available: ${Object.keys(HOOKS).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const settingsPath = isGlobal ? CLAUDE_SETTINGS_PATH : getProjectSettingsPath(root);
  const settings = await readSettings(settingsPath);

  if (hasHook(settings, hookName)) {
    console.log(`Hook '${hookName}' already installed.`);
    return;
  }

  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks[hookDef.type]) settings.hooks[hookDef.type] = [];

  settings.hooks[hookDef.type].push(hookDef.config);

  await writeSettings(settingsPath, settings);
  console.log(`✓ Installed hook '${hookName}' (${hookDef.description})`);
}

/**
 * Uninstall a hook
 */
export async function uninstall(ctx, args) {
  const { root } = ctx;
  const hookName = args._[3];
  const isGlobal = args.global;

  if (!hookName) {
    console.error('Usage: pi hook uninstall <name> [--global]');
    process.exitCode = 1;
    return;
  }

  const hookDef = HOOKS[hookName];
  if (!hookDef) {
    console.error(`Unknown hook: ${hookName}`);
    process.exitCode = 1;
    return;
  }

  const settingsPath = isGlobal ? CLAUDE_SETTINGS_PATH : getProjectSettingsPath(root);
  const settings = await readSettings(settingsPath);

  const hookList = settings.hooks?.[hookDef.type] || [];
  const filtered = hookList.filter(h => {
    const subHooks = h.hooks || [];
    return !subHooks.some(sh => sh.command?.includes('pi '));
  });

  if (filtered.length === hookList.length) {
    console.log(`Hook '${hookName}' not found.`);
    return;
  }

  settings.hooks[hookDef.type] = filtered;
  await writeSettings(settingsPath, settings);
  console.log(`✓ Uninstalled hook '${hookName}'`);
}

/**
 * List installed hooks
 */
export async function list(ctx, args) {
  const { root } = ctx;
  const isGlobal = args.global;

  const settingsPath = isGlobal ? CLAUDE_SETTINGS_PATH : getProjectSettingsPath(root);
  const settings = await readSettings(settingsPath);

  console.log(`Installed hooks (${isGlobal ? 'global' : 'project'}):\n`);

  let found = false;
  for (const [name, def] of Object.entries(HOOKS)) {
    if (hasHook(settings, name)) {
      console.log(`  ✓ ${name}: ${def.description}`);
      found = true;
    }
  }

  if (!found) {
    console.log('  (none)');
  }

  console.log('\nAvailable:');
  for (const [name, def] of Object.entries(HOOKS)) {
    if (!hasHook(settings, name)) {
      console.log(`  - ${name}: ${def.description}`);
    }
  }
}

/**
 * Initialize all recommended hooks
 */
export async function init(ctx, args) {
  const { root } = ctx;
  const isGlobal = args.global;

  console.log('Installing recommended hooks...\n');

  for (const hookName of ['post-commit', 'stale-notify']) {
    await install(ctx, { ...args, _: ['hook', 'install', hookName] });
  }

  console.log('\nHooks initialized.');
}

/**
 * Show hook status
 */
export async function status(ctx, args) {
  console.log('Project hooks:');
  await list(ctx, { ...args, global: false });

  console.log('\nGlobal hooks:');
  await list(ctx, { ...args, global: true });
}
