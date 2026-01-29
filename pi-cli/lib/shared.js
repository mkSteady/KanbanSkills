#!/usr/bin/env node
/**
 * Shared utilities for project-index
 * Pure functions, no project-specific logic
 */

import { promises as fs } from 'fs';
import path from 'path';

/**
 * Find project root by walking up to find marker files
 * @param {string} startDir
 * @param {string[]} markers - Files that indicate project root
 * @returns {Promise<string>}
 */
export async function findProjectRoot(startDir, markers = ['package.json', '.git', '.pi-config.json', '.stale-config.json']) {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;

  while (dir !== root) {
    for (const marker of markers) {
      try {
        await fs.access(path.join(dir, marker));
        return dir;
      } catch {
        // continue
      }
    }
    dir = path.dirname(dir);
  }
  return startDir;
}

/**
 * Read JSON file safely
 * @param {string} filePath
 * @param {any} fallback
 * @returns {Promise<any>}
 */
export async function readJsonSafe(filePath, fallback = null) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch {
    return fallback;
  }
}

/**
 * Write JSON file with pretty print
 * @param {string} filePath
 * @param {any} data
 * @returns {Promise<void>}
 */
export async function writeJsonSafe(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Parse CLI arguments
 * @param {string[]} args
 * @param {Record<string, any>} defaults
 * @returns {Record<string, any>}
 */
export function parseArgs(args, defaults = {}) {
  const result = { ...defaults, _: [] };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const [key, val] = arg.slice(2).split('=');
      if (val !== undefined) {
        result[key] = isNaN(Number(val)) ? val : Number(val);
      } else if (typeof defaults[key] === 'boolean') {
        result[key] = true;
      } else if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        result[key] = args[++i];
      } else {
        result[key] = true;
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      const key = arg[1];
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        result[key] = args[++i];
      } else {
        result[key] = true;
      }
    } else {
      result._.push(arg);
    }
  }
  return result;
}

/**
 * Glob pattern matching (simple implementation)
 * @param {string} pattern
 * @param {string} str
 * @returns {boolean}
 */
export function matchesPattern(pattern, str) {
  const regex = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/{{GLOBSTAR}}/g, '.*');
  return new RegExp(`^${regex}$`).test(str);
}

/**
 * Check whether a path should be processed based on ignore/include globs.
 *
 * Semantics:
 * - If `include` is non-empty, the path must match at least one include pattern.
 * - If the path matches any ignore pattern, it is excluded.
 * - Patterns without "/" are matched against the basename (so "*.test.js" works anywhere).
 *
 * @param {string} filePath - Project-relative path (posix separators recommended)
 * @param {string[]|undefined|null} ignore
 * @param {string[]|undefined|null} include
 * @returns {boolean}
 */
export function matchesIgnoreInclude(filePath, ignore, include) {
  const rel = String(filePath || '')
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');

  if (!rel) return false;

  const includeList = Array.isArray(include) ? include.filter(Boolean) : [];
  const ignoreList = Array.isArray(ignore) ? ignore.filter(Boolean) : [];

  const matchOne = (pattern) => {
    const normalizedPattern = String(pattern || '')
      .replace(/\\/g, '/')
      .replace(/^\.\/+/, '')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
    if (!normalizedPattern) return false;

    const target = normalizedPattern.includes('/')
      ? rel
      : path.posix.basename(rel);

    // Support common glob intent where "dir/**" should also match "dir".
    if (normalizedPattern.endsWith('/**')) {
      const prefix = normalizedPattern.slice(0, -3);
      if (rel === prefix || rel.startsWith(prefix + '/')) return true;
    }

    return matchesPattern(normalizedPattern, target);
  };

  if (includeList.length > 0) {
    const allowed = includeList.some(matchOne);
    if (!allowed) return false;
  }

  if (ignoreList.length > 0) {
    const ignored = ignoreList.some(matchOne);
    if (ignored) return false;
  }

  return true;
}

/**
 * Get the most specific directory rule for a given path.
 *
 * Directory rules are matched by prefix: "a/b" applies to "a/b/..." and "a/b".
 * The longest matching prefix wins.
 *
 * @param {string} filePath - Project-relative path (posix separators recommended)
 * @param {Record<string, any>|undefined|null} directoryRules
 * @returns {{path: string, rule: any} | null}
 */
export function getDirectoryRule(filePath, directoryRules) {
  if (!directoryRules || typeof directoryRules !== 'object') return null;

  const rel = String(filePath || '')
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');

  if (!rel) return null;

  /** @type {{path: string, rule: any} | null} */
  let best = null;

  for (const [rawKey, rule] of Object.entries(directoryRules)) {
    const key = String(rawKey || '')
      .replace(/\\/g, '/')
      .replace(/^\.\/+/, '')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
    if (!key) continue;

    if (rel === key || rel.startsWith(key + '/')) {
      if (!best || key.length > best.path.length) {
        best = { path: key, rule };
      }
    }
  }

  return best;
}

/**
 * Run command and capture output
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} options
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
export async function runCommand(cmd, args, options = {}) {
  const { spawn } = await import('child_process');

  return new Promise((resolve) => {
    const hasInput = options.input !== undefined;
    const child = spawn(cmd, args, {
      cwd: options.cwd || process.cwd(),
      stdio: [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      shell: options.shell || false,
      timeout: options.timeout
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', d => { stdout += d; });
    child.stderr?.on('data', d => { stderr += d; });

    // Write stdin if provided
    if (hasInput && child.stdin) {
      child.stdin.write(options.input);
      child.stdin.end();
    }

    child.on('close', code => {
      resolve({ code: code || 0, stdout, stderr });
    });

    child.on('error', err => {
      resolve({ code: 1, stdout, stderr: err.message });
    });
  });
}

/**
 * Truncate string with ellipsis
 * @param {string} str
 * @param {number} max
 * @returns {string}
 */
export function truncate(str, max = 60) {
  const s = String(str || '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * Format relative time
 * @param {number} ms
 * @returns {string}
 */
export function formatRelativeTime(ms) {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

/**
 * Debounce function
 * @param {Function} fn
 * @param {number} delay
 * @returns {Function}
 */
export function debounce(fn, delay) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

/**
 * Simple hash for cache keys
 * @param {string} str
 * @returns {string}
 */
export function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Parallel map with concurrency limit
 * @template T, R
 * @param {T[]} items
 * @param {(item: T, index: number) => Promise<R>} fn
 * @param {number} concurrency
 * @returns {Promise<R[]>}
 */
export async function parallelMap(items, fn, concurrency = 10) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array(Math.min(concurrency, items.length))
    .fill(null)
    .map(() => worker());

  await Promise.all(workers);
  return results;
}
