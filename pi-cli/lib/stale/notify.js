/**
 * Stale notification system
 * Notifies about stale modules on session start
 */

import { promises as fs } from 'fs';
import path from 'path';
import { matchesIgnoreInclude, readJsonSafe, writeJsonSafe } from '../shared.js';
import { getCachePath, loadStaleConfig } from '../context.js';

/** @typedef {import('../types.js').ProjectConfig} ProjectConfig */

/**
 * Notify about stale modules
 * @param {{root: string, config: ProjectConfig}} ctx
 * @param {object} args
 */
export async function notify(ctx, args) {
  const { root, config } = ctx;
  const staleConfig = ctx.staleConfig || await loadStaleConfig(root, config);
  const notifyConfig = staleConfig?.notify || {};
  const configEnabled = notifyConfig.enabled !== false;
  const threshold = Number.isFinite(notifyConfig.threshold) ? notifyConfig.threshold : 3;

  const statePath = getCachePath(config, root, '.stale-notify-state.json');
  const state = await readJsonSafe(statePath, {
    enabled: configEnabled,
    lastCheck: null,
    lastStaleCount: 0
  });

  // Check enable/disable commands
  if (args.enable) {
    state.enabled = true;
    await writeJsonSafe(statePath, state);
    console.log('Stale notifications enabled.');
    return;
  }

  if (args.disable) {
    state.enabled = false;
    await writeJsonSafe(statePath, state);
    console.log('Stale notifications disabled.');
    return;
  }

  if (args.status) {
    console.log(`Enabled (config): ${configEnabled}`);
    console.log(`Enabled (state): ${state.enabled}`);
    console.log(`Enabled (effective): ${configEnabled && state.enabled}`);
    console.log(`Threshold: ${threshold}`);
    console.log(`Last check: ${state.lastCheck || 'never'}`);
    console.log(`Last stale count: ${state.lastStaleCount}`);
    return;
  }

  if (args.reset) {
    state.lastStaleCount = 0;
    await writeJsonSafe(statePath, state);
    console.log('Reset stale count to 0.');
    return;
  }

  // Check if enabled
  if (!configEnabled || !state.enabled) {
    return;
  }

  // Get current stale count
  const staleData = await getStaleModules(ctx);
  const currentCount = staleData.length;

  // Check if change exceeds threshold
  const change = Math.abs(currentCount - state.lastStaleCount);

  if (change >= threshold || (currentCount > 0 && state.lastStaleCount === 0)) {
    // Notify
    outputNotification(staleData, currentCount, state.lastStaleCount);
  }

  // Update state
  state.lastCheck = new Date().toISOString();
  state.lastStaleCount = currentCount;
  await writeJsonSafe(statePath, state);
}

/**
 * Get stale modules
 */
async function getStaleModules(ctx) {
  const { root, config } = ctx;

  // Check for cached stale data
  const stalePath = getCachePath(config, root, '.stale-modules.json');
  const cached = await readJsonSafe(stalePath);

  if (cached && cached.timestamp) {
    const age = Date.now() - new Date(cached.timestamp).getTime();
    if (age < 5 * 60 * 1000) { // 5 minutes
      return cached.stale || [];
    }
  }

  // Scan for stale modules
  const stale = await scanStaleModules(ctx);

  // Cache result
  await writeJsonSafe(stalePath, {
    timestamp: new Date().toISOString(),
    stale
  });

  return stale;
}

/**
 * Scan for stale modules
 * Uses module-analyzer-tasks.json as source of truth for module list
 */
async function scanStaleModules(ctx) {
  const { root, config } = ctx;
  const staleConfig = ctx.staleConfig || await loadStaleConfig(root, config);
  const ignore = staleConfig?.ignore || [];
  const include = staleConfig?.include || [];
  const stale = [];

  // Read analyzed modules from tasks file
  const tasksPath = getCachePath(config, root, '.module-analyzer-tasks.json');
  const tasksData = await readJsonSafe(tasksPath, { tasks: [] });
  const modules = tasksData.tasks || [];

  for (const mod of modules) {
    const modPath = mod.context?.modulePath || mod.module || mod.id;
    if (!modPath) continue;

    const modRel = String(modPath).replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
    if (!matchesIgnoreInclude(modRel, ignore, include)) continue;

    const absModPath = path.join(root, modPath);
    const docPath = path.join(absModPath, 'CLAUDE.md');

    try {
      const docStat = await fs.stat(docPath);

      // Find newest source file in module
      const newest = await findNewestFile(absModPath);

      if (newest && newest.mtimeMs > docStat.mtimeMs) {
        stale.push({
          path: modRel,
          docAge: Date.now() - docStat.mtimeMs,
          newestFile: newest.file,
          type: 'outdated'
        });
      }
    } catch {
      // No CLAUDE.md file - counts as stale if enableDoc is true
      if (mod.context?.enableDoc) {
        stale.push({
          path: modRel,
          missing: true,
          type: 'missing'
        });
      }
    }
  }

  return stale;
}

/**
 * Find newest file in directory
 */
async function findNewestFile(dir) {
  let newest = null;

  async function walk(d) {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        await walk(path.join(d, entry.name));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!['.js', '.ts', '.py', '.go', '.rs'].includes(ext)) continue;

        const filePath = path.join(d, entry.name);
        const stat = await fs.stat(filePath);

        if (!newest || stat.mtimeMs > newest.mtimeMs) {
          newest = {
            file: path.relative(dir, filePath),
            mtimeMs: stat.mtimeMs
          };
        }
      }
    }
  }

  await walk(dir);
  return newest;
}

/**
 * Output notification
 */
function outputNotification(staleData, current, previous) {
  const change = current - previous;
  const direction = change > 0 ? 'increased' : 'decreased';

  console.log(`\n📋 Stale modules ${direction}: ${previous} → ${current}\n`);

  if (staleData.length > 0) {
    const tree = buildTree(staleData.map(s => s.path));
    console.log('Stale modules:');
    printTree(tree, '  ');

    console.log('\nRun "pi doc generate" to update documentation.');
  }
}

/**
 * Build tree structure from paths
 */
function buildTree(paths) {
  const tree = {};

  for (const p of paths) {
    const parts = p.split('/');
    let current = tree;

    for (const part of parts) {
      if (!current[part]) current[part] = {};
      current = current[part];
    }
  }

  return tree;
}

/**
 * Print tree structure
 */
function printTree(tree, prefix = '') {
  const entries = Object.entries(tree);

  for (let i = 0; i < entries.length; i++) {
    const [name, children] = entries[i];
    const isLast = i === entries.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = isLast ? '    ' : '│   ';

    console.log(`${prefix}${connector}${name}`);

    if (Object.keys(children).length > 0) {
      printTree(children, prefix + childPrefix);
    }
  }
}
