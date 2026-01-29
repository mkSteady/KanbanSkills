#!/usr/bin/env node
/**
 * Dependency Graph - Build file/module-level dependency graph for JS projects
 *
 * Usage:
 *   node dependency-graph.js                 # Scan current project (uses include from config)
 *   node dependency-graph.js --module js/agents  # Scan a specific directory (relative to project root)
 *   node dependency-graph.js --json          # Output JSON to stdout
 *   node dependency-graph.js --check <file>  # Query a single file's deps + reverse deps
 *
 * Output file (project root):
 *   .dep-graph.json
 */

import { promises as fs } from 'fs';
import path from 'path';
import {
  loadConfig,
  shouldProcess,
  parseArgs,
  readJsonSafe,
  writeJsonSafe,
  findProjectRoot
} from './shared.js';

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
  'venv', '.venv', 'target', 'vendor', '.cache', 'coverage',
  '.turbo', '.nuxt', '.output', 'out', '.project-index'
]);

/** @typedef {0 | 1 | 2} DfsColor 0=white, 1=gray, 2=black */

/**
 * @typedef {object} FileNode
 * @property {string[]} imports - Imported file paths (relative to root)
 * @property {string[]} importedBy - Reverse dependencies (relative to root)
 * @property {string[]} exports - Exported symbol names
 */

/**
 * @typedef {object} ModuleStats
 * @property {number} files
 * @property {number} inDegree
 * @property {number} outDegree
 */

/**
 * @typedef {object} DepGraph
 * @property {1} version
 * @property {string} generated
 * @property {string} root
 * @property {Record<string, FileNode>} files
 * @property {Record<string, ModuleStats>} modules
 * @property {string[][]} cycles
 */

/**
 * Convert a path to posix separators for stable JSON keys.
 * @param {string} p
 * @returns {string}
 */
function toPosixPath(p) {
  return p.replace(/\\/g, '/');
}

/**
 * Normalize a relative path-like input:
 * - remove leading "./"
 * - remove trailing "/"
 * - normalize separators to "/"
 *
 * @param {string} input
 * @returns {string}
 */
function normalizeRelInput(input) {
  const normalized = toPosixPath(path.normalize(input));
  const trimmed = normalized.replace(/^\.\/+/, '').replace(/\/+$/, '');
  return trimmed || '.';
}

/**
 * Preprocess argv to support `--flag value` style for selected flags,
 * while still reusing shared.parseArgs().
 *
 * @param {string[]} argv
 * @returns {string[]}
 */
function normalizeArgv(argv) {
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--module' || arg === '--check') && i + 1 < argv.length) {
      const next = argv[i + 1];
      if (!next.startsWith('-')) {
        out.push(`${arg}=${next}`);
        i++;
        continue;
      }
    }
    out.push(arg);
  }
  return out;
}

/**
 * Strip JS comments while preserving string literals (best-effort).
 * This reduces false positives for regex-based parsing.
 *
 * @param {string} input
 * @returns {string}
 */
function stripComments(input) {
  /** @type {string[]} */
  const out = [];

  /** @type {'normal'|'single'|'double'|'template'|'lineComment'|'blockComment'} */
  let state = 'normal';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = input[i + 1];

    if (state === 'normal') {
      if (ch === "'") { state = 'single'; out.push(ch); continue; }
      if (ch === '"' ) { state = 'double'; out.push(ch); continue; }
      if (ch === '`' ) { state = 'template'; out.push(ch); continue; }
      if (ch === '/' && next === '/') { state = 'lineComment'; out.push(' '); i++; continue; }
      if (ch === '/' && next === '*') { state = 'blockComment'; out.push(' '); i++; continue; }
      out.push(ch);
      continue;
    }

    if (state === 'lineComment') {
      if (ch === '\n') {
        state = 'normal';
        out.push('\n');
      } else {
        out.push(' ');
      }
      continue;
    }

    if (state === 'blockComment') {
      if (ch === '*' && next === '/') {
        state = 'normal';
        out.push(' ');
        i++;
      } else {
        out.push(ch === '\n' ? '\n' : ' ');
      }
      continue;
    }

    // Strings: keep content but correctly handle escapes for ' and "
    if (state === 'single') {
      out.push(ch);
      if (ch === '\\' && next) { out.push(next); i++; continue; }
      if (ch === "'") state = 'normal';
      continue;
    }
    if (state === 'double') {
      out.push(ch);
      if (ch === '\\' && next) { out.push(next); i++; continue; }
      if (ch === '"') state = 'normal';
      continue;
    }
    if (state === 'template') {
      out.push(ch);
      if (ch === '\\' && next) { out.push(next); i++; continue; }
      if (ch === '`') state = 'normal';
      continue;
    }
  }

  return out.join('');
}

/**
 * Parse import-like dependencies from file content.
 * Enhancements vs test-mapper:
 * - dynamic import: import('...')
 * - re-export: export { x } from '...'
 * - export * from '...'
 *
 * @param {string} content - File content (comments stripped recommended)
 * @returns {string[]} Module specifiers
 */
function parseImports(content) {
  /** @type {Set<string>} */
  const specs = new Set();

  // import ... from '...'
  const importFromRegex = /\bimport\s+(?:type\s+)?[\w*\s{},$]+\sfrom\s*['"]([^'"]+)['"]/g;
  // import '...'
  const importSideEffectRegex = /\bimport\s*['"]([^'"]+)['"]\s*;?/g;
  // dynamic import('...')
  const dynamicImportRegex = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  // export { x } from '...'
  const exportFromNamedRegex = /\bexport\s*\{[\s\S]*?\}\s*from\s*['"]([^'"]+)['"]/g;
  // export * from '...'
  const exportStarFromRegex = /\bexport\s*\*\s*from\s*['"]([^'"]+)['"]/g;
  // export * as ns from '...'
  const exportStarAsFromRegex = /\bexport\s*\*\s*as\s*[\w$]+\s*from\s*['"]([^'"]+)['"]/g;

  for (const re of [
    importFromRegex,
    importSideEffectRegex,
    dynamicImportRegex,
    exportFromNamedRegex,
    exportStarFromRegex,
    exportStarAsFromRegex
  ]) {
    let m;
    while ((m = re.exec(content)) !== null) {
      const spec = m[1]?.trim();
      if (spec) specs.add(spec);
    }
  }

  return [...specs];
}

/**
 * Parse exported symbol names from a JS file.
 *
 * @param {string} content - File content (comments stripped recommended)
 * @returns {string[]} Exported symbols (best-effort)
 */
function parseExports(content) {
  /** @type {Set<string>} */
  const exports = new Set();

  // export default ...
  if (/\bexport\s+default\b/.test(content)) {
    exports.add('default');
  }

  // export function foo / export async function foo
  {
    const re = /\bexport\s+(?:async\s+)?function\s+([\w$]+)\b/g;
    let m;
    while ((m = re.exec(content)) !== null) exports.add(m[1]);
  }

  // export class Foo
  {
    const re = /\bexport\s+class\s+([\w$]+)\b/g;
    let m;
    while ((m = re.exec(content)) !== null) exports.add(m[1]);
  }

  // export const a = 1, b = 2;
  {
    const re = /\bexport\s+(?:const|let|var)\s+([^;]+);?/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      const decl = m[1];
      const idRe = /(?:^|,)\s*([A-Za-z_$][\w$]*)\s*(?==|,|$)/g;
      let idm;
      while ((idm = idRe.exec(decl)) !== null) exports.add(idm[1]);
    }
  }

  // export { a, b as c } [from '...'];
  {
    const re = /\bexport\s*\{([^}]+)\}\s*(?:from\s*['"][^'"]+['"])?/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      const list = m[1]
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

      for (const item of list) {
        const asMatch = item.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
        if (asMatch) {
          exports.add(asMatch[2]);
        } else {
          // export { default } is valid; keep as-is if it's identifier-ish
          const idMatch = item.match(/^([\w$]+)$/);
          if (idMatch) exports.add(idMatch[1]);
        }
      }
    }
  }

  // export * as ns from '...';
  {
    const re = /\bexport\s*\*\s*as\s*([\w$]+)\s*from\s*['"][^'"]+['"]/g;
    let m;
    while ((m = re.exec(content)) !== null) exports.add(m[1]);
  }

  // export * from '...'; (unknown names; keep a marker for visibility)
  if (/\bexport\s*\*\s*from\s*['"][^'"]+['"]/.test(content)) {
    exports.add('*');
  }

  return [...exports];
}

/**
 * Infer a reasonable root directory from include globs.
 * Example: ["js/agents/**"] -> "js/agents"
 *
 * @param {string[]|undefined} include
 * @returns {string}
 */
function inferRootFromInclude(include) {
  if (!include || include.length === 0) return '.';

  /** @type {string[][]} */
  const prefixes = include
    .map(p => {
      const raw = String(p);
      const cut = raw.split('*')[0]; // drop glob part
      const trimmed = cut.replace(/\/+$/, '');
      const normalized = normalizeRelInput(trimmed || '.');
      return normalized === '.' ? [] : normalized.split('/');
    })
    .filter(parts => parts.length > 0);

  if (prefixes.length === 0) return '.';

  // Longest common prefix by segment
  const minLen = Math.min(...prefixes.map(p => p.length));
  /** @type {string[]} */
  const common = [];
  for (let i = 0; i < minLen; i++) {
    const seg = prefixes[0][i];
    if (prefixes.every(p => p[i] === seg)) common.push(seg);
    else break;
  }

  return common.length > 0 ? common.join('/') : '.';
}

/**
 * Resolve a `--module` input to a project-root-relative directory.
 *
 * @param {string} moduleArg
 * @param {string} projectRoot
 * @returns {Promise<string>}
 */
async function resolveModuleRoot(moduleArg, projectRoot) {
  const input = normalizeRelInput(moduleArg);
  const abs = path.isAbsolute(moduleArg) ? moduleArg : path.resolve(projectRoot, input);
  const rel = toPosixPath(path.relative(projectRoot, abs));

  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path is outside project root: ${moduleArg}`);
  }

  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    throw new Error(`Module path not found: ${moduleArg}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Module path is not a directory: ${moduleArg}`);
  }

  return normalizeRelInput(rel);
}

/**
 * Recursively scan a directory for .js files.
 *
 * @param {string} rootAbs - Absolute path to scan root
 * @param {string} projectRoot - Absolute project root (for config-relative filtering)
 * @param {{include?: string[], ignore?: string[]}} config
 * @returns {Promise<Map<string,string>>} Map<rootRelativePath, absolutePath>
 */
async function scanJsFiles(rootAbs, projectRoot, config) {
  /** @type {Map<string,string>} */
  const results = new Map();

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        await walk(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (path.extname(entry.name).toLowerCase() !== '.js') continue;

      const relToProject = toPosixPath(path.relative(projectRoot, fullPath));
      if (!shouldProcess(relToProject, config)) continue;

      const relToRoot = toPosixPath(path.relative(rootAbs, fullPath));
      if (relToRoot.startsWith('..')) continue;
      results.set(relToRoot, fullPath);
    }
  }

  await walk(rootAbs);
  return results;
}

/**
 * Resolve an import specifier to a root-relative file path if it points to a scanned file.
 *
 * @param {string} spec
 * @param {string} fromAbs - Absolute path of the importing file
 * @param {string} rootAbs - Absolute scan root
 * @param {Map<string,string>} knownFiles - Map of known root-relative files
 * @returns {string|null}
 */
function resolveToRootFile(spec, fromAbs, rootAbs, knownFiles) {
  const s = spec.trim();
  if (!s.startsWith('.')) return null;

  const base = path.resolve(path.dirname(fromAbs), s);
  /** @type {string[]} */
  const candidates = [];

  if (path.extname(base)) {
    candidates.push(base);
  } else {
    candidates.push(`${base}.js`);
    candidates.push(path.join(base, 'index.js'));
  }

  for (const abs of candidates) {
    const rel = toPosixPath(path.relative(rootAbs, abs));
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (knownFiles.has(rel)) return rel;
  }

  return null;
}

/**
 * Determine "module" as the first-level subdirectory under scan root.
 *
 * @param {string} rootRelativeFile - File path relative to scan root (posix)
 * @returns {string}
 */
function detectModule(rootRelativeFile) {
  const parts = rootRelativeFile.split('/');
  return parts.length > 1 ? parts[0] : '.';
}

/**
 * Find cycles in a directed graph using DFS coloring (white/gray/black).
 *
 * @param {Map<string, Set<string>>} edges - adjacency list
 * @returns {string[][]} Cycles (canonicalized, deterministic)
 */
function detectCycles(edges) {
  /** @type {string[]} */
  const nodes = [...edges.keys()].sort();
  /** @type {Map<string, string[]>} */
  const adj = new Map();

  for (const n of nodes) {
    adj.set(n, [...(edges.get(n) || new Set())].sort());
  }

  /** @type {Map<string, DfsColor>} */
  const color = new Map(nodes.map(n => [n, 0]));
  /** @type {string[]} */
  const stack = [];
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[][]} */
  const cycles = [];

  /**
   * @param {string[]} cycle
   * @returns {string[]}
   */
  function canonicalizeCycle(cycle) {
    if (cycle.length <= 1) return cycle.slice();
    // rotate to lexicographically smallest start for stable identity
    let minIdx = 0;
    for (let i = 1; i < cycle.length; i++) {
      if (cycle[i] < cycle[minIdx]) minIdx = i;
    }
    return cycle.slice(minIdx).concat(cycle.slice(0, minIdx));
  }

  /**
   * @param {string} u
   */
  function dfs(u) {
    color.set(u, 1);
    stack.push(u);

    for (const v of adj.get(u) || []) {
      const c = color.get(v) ?? 0;
      if (c === 0) {
        dfs(v);
      } else if (c === 1) {
        const idx = stack.indexOf(v);
        if (idx >= 0) {
          const cycle = stack.slice(idx);
          const canon = canonicalizeCycle(cycle);
          const key = canon.join('|');
          if (!seen.has(key)) {
            seen.add(key);
            cycles.push(canon);
          }
        }
      }
    }

    stack.pop();
    color.set(u, 2);
  }

  for (const n of nodes) {
    if ((color.get(n) ?? 0) === 0) dfs(n);
  }

  cycles.sort((a, b) => a.join('|').localeCompare(b.join('|')));
  return cycles;
}

/**
 * Build dependency graph from a scan root.
 *
 * @param {string} projectRoot
 * @param {string} rootRel
 * @param {{include?: string[], ignore?: string[]}} config
 * @returns {Promise<{graph: DepGraph, warnings: string[]}>}
 */
async function buildGraph(projectRoot, rootRel, config) {
  const rootAbs = path.resolve(projectRoot, rootRel === '.' ? '' : rootRel);
  const filesMap = await scanJsFiles(rootAbs, projectRoot, config);

  /** @type {Map<string, {imports: Set<string>, importedBy: Set<string>, exports: Set<string>}>} */
  const nodes = new Map();
  /** @type {string[]} */
  const warnings = [];

  // Initialize nodes for all scanned files (even if parsing fails)
  for (const rel of filesMap.keys()) {
    nodes.set(rel, { imports: new Set(), importedBy: new Set(), exports: new Set() });
  }

  for (const [rel, abs] of filesMap) {
    let content;
    try {
      content = await fs.readFile(abs, 'utf-8');
    } catch (err) {
      warnings.push(`read failed: ${rel} (${/** @type {Error} */(err)?.message || 'unknown'})`);
      continue;
    }

    try {
      const stripped = stripComments(content);
      const specs = parseImports(stripped);
      const exp = parseExports(stripped);

      const node = nodes.get(rel);
      if (!node) continue;

      for (const spec of specs) {
        const resolved = resolveToRootFile(spec, abs, rootAbs, filesMap);
        if (resolved) node.imports.add(resolved);
      }

      for (const e of exp) node.exports.add(e);
    } catch (err) {
      warnings.push(`parse failed: ${rel} (${/** @type {Error} */(err)?.message || 'unknown'})`);
    }
  }

  // Reverse edges
  for (const [rel, node] of nodes) {
    for (const dep of node.imports) {
      const target = nodes.get(dep);
      if (target) target.importedBy.add(rel);
    }
  }

  // Module stats
  /** @type {Map<string, number>} */
  const moduleFileCounts = new Map();
  /** @type {Map<string, Set<string>>} */
  const moduleEdges = new Map();

  for (const [rel, node] of nodes) {
    const mod = detectModule(rel);
    moduleFileCounts.set(mod, (moduleFileCounts.get(mod) || 0) + 1);
    if (!moduleEdges.has(mod)) moduleEdges.set(mod, new Set());

    for (const dep of node.imports) {
      const depMod = detectModule(dep);
      if (!moduleEdges.has(depMod)) moduleEdges.set(depMod, new Set());
      if (depMod !== mod) moduleEdges.get(mod).add(depMod);
    }
  }

  /** @type {Map<string, Set<string>>} */
  const moduleInEdges = new Map();
  for (const mod of moduleEdges.keys()) moduleInEdges.set(mod, new Set());
  for (const [from, tos] of moduleEdges) {
    for (const to of tos) {
      if (!moduleInEdges.has(to)) moduleInEdges.set(to, new Set());
      moduleInEdges.get(to).add(from);
    }
  }

  /** @type {Record<string, FileNode>} */
  const filesOut = {};
  for (const rel of [...nodes.keys()].sort()) {
    const n = nodes.get(rel);
    filesOut[rel] = {
      imports: [...n.imports].sort(),
      importedBy: [...n.importedBy].sort(),
      exports: [...n.exports].sort()
    };
  }

  /** @type {Record<string, ModuleStats>} */
  const modulesOut = {};
  for (const mod of [...moduleEdges.keys()].sort()) {
    modulesOut[mod] = {
      files: moduleFileCounts.get(mod) || 0,
      inDegree: moduleInEdges.get(mod)?.size || 0,
      outDegree: moduleEdges.get(mod)?.size || 0
    };
  }

  const cycles = detectCycles(moduleEdges);

  /** @type {DepGraph} */
  const graph = {
    version: 1,
    generated: new Date().toISOString(),
    root: normalizeRelInput(rootRel),
    files: filesOut,
    modules: modulesOut,
    cycles
  };

  return { graph, warnings };
}

/**
 * Print a single-file check result.
 *
 * @param {DepGraph} graph
 * @param {string} fileArg
 * @param {boolean} asJson
 */
function printCheck(graph, fileArg, asJson) {
  const root = normalizeRelInput(graph.root || '.');
  const inNorm = normalizeRelInput(fileArg);

  // Accept either "core/a.js" (root-relative) or "js/agents/core/a.js" (project-relative)
  const key = inNorm.startsWith(root + '/') ? inNorm.slice(root.length + 1) : inNorm;
  const node = graph.files[key];

  if (!node) {
    const msg = `File not found in graph: ${key}`;
    if (asJson) {
      process.stdout.write(JSON.stringify({ error: msg }, null, 2) + '\n');
    } else {
      console.error(msg);
    }
    process.exitCode = 1;
    return;
  }

  const result = {
    file: key,
    imports: node.imports || [],
    importedBy: node.importedBy || [],
    exports: node.exports || []
  };

  if (asJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  console.log(`File: ${result.file}`);
  console.log(`Imports (${result.imports.length}):`);
  for (const i of result.imports) console.log(`  - ${i}`);
  console.log(`ImportedBy (${result.importedBy.length}):`);
  for (const i of result.importedBy) console.log(`  - ${i}`);
  console.log(`Exports (${result.exports.length}):`);
  for (const e of result.exports) console.log(`  - ${e}`);
}

/**
 * Join a graph-root and a graph key into a project-relative path.
 *
 * @param {string} graphRoot
 * @param {string} key
 * @returns {string}
 */
function toProjectRel(graphRoot, key) {
  const root = normalizeRelInput(graphRoot || '.');
  const k = normalizeRelInput(key);
  if (!root || root === '.') return k;
  if (!k || k === '.') return root;
  return normalizeRelInput(`${root}/${k}`);
}

/**
 * Compute orphan files (no imports, no importedBy).
 *
 * @param {DepGraph} graph
 * @returns {string[]}
 */
function listOrphans(graph) {
  const out = [];
  const files = graph?.files && typeof graph.files === 'object' ? graph.files : {};
  for (const [key, node] of Object.entries(files)) {
    const imports = Array.isArray(node?.imports) ? node.imports : [];
    const importedBy = Array.isArray(node?.importedBy) ? node.importedBy : [];
    if (imports.length === 0 && importedBy.length === 0) {
      out.push(toProjectRel(graph.root || '.', key));
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * Print health checks: cycles/orphans.
 *
 * @param {DepGraph} graph
 * @param {{ cycles: boolean, orphans: boolean }} checks
 * @param {boolean} asJson
 */
function printHealthChecks(graph, checks, asJson) {
  const cycles = Array.isArray(graph?.cycles) ? graph.cycles : [];
  const orphans = listOrphans(graph);

  /** @type {{root: string, counts: {cycles: number, orphans: number}, cycles?: string[][], orphans?: string[]}} */
  const payload = {
    root: normalizeRelInput(graph?.root || '.'),
    counts: { cycles: cycles.length, orphans: orphans.length },
    ...(checks.cycles ? { cycles } : {}),
    ...(checks.orphans ? { orphans } : {})
  };

  const hasCycles = checks.cycles && cycles.length > 0;
  const hasOrphans = checks.orphans && orphans.length > 0;
  if (hasCycles || hasOrphans) process.exitCode = 1;

  if (asJson) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return;
  }

  console.log('=== Dependency Graph Checks ===\n');

  if (checks.cycles) {
    console.log(`Cycles: ${cycles.length}`);
    if (cycles.length === 0) console.log('  (none)\n');
    else {
      for (const c of cycles.slice(0, 50)) {
        const closed = c.length > 1 && c[c.length - 1] !== c[0]
          ? `${c.join(' → ')} → ${c[0]}`
          : c.join(' → ');
        console.log(`  - ${closed}`);
      }
      if (cycles.length > 50) console.log(`  ... +${cycles.length - 50} more`);
      console.log('');
    }
  }

  if (checks.orphans) {
    console.log(`Orphans: ${orphans.length}`);
    if (orphans.length === 0) console.log('  (none)\n');
    else {
      for (const o of orphans.slice(0, 50)) console.log(`  - ${o}`);
      if (orphans.length > 50) console.log(`  ... +${orphans.length - 50} more`);
      console.log('');
    }
  }
}

/**
 * Main entry point.
 * @returns {Promise<void>}
 */
async function main() {
  const normalizedArgs = normalizeArgv(process.argv.slice(2));
  const args = parseArgs(normalizedArgs, {
    module: null,
    all: false,
    json: false,
    check: null,
    checkCycles: false,
    checkOrphans: false,
    help: false
  });

  if (args.help) {
    console.log(`
Dependency Graph - Build file/module dependency graph for .js files

Usage:
  node dependency-graph.js
  node dependency-graph.js --all
  node dependency-graph.js --module js/agents
  node dependency-graph.js --json
  node dependency-graph.js --check <file>
  node dependency-graph.js --check-cycles
  node dependency-graph.js --check-orphans
`);
    return;
  }

  if (args.module && args.all) {
    console.error('Error: --module and --all are mutually exclusive.');
    process.exitCode = 1;
    return;
  }

  const projectRoot = await findProjectRoot(process.cwd());
  // Prefer skill-managed config; fallback to legacy root-level .stale-config.json if present.
  let config = await loadConfig(projectRoot);
  if (!config || Object.keys(config).length === 0) {
    config = await readJsonSafe(path.join(projectRoot, '.stale-config.json'), {});
  }

  let rootRel;
  /** @type {{include?: string[], ignore?: string[]}} */
  let effectiveConfig = config;

  if (args.module) {
    rootRel = await resolveModuleRoot(String(args.module), projectRoot);
    // Explicit module scan should not be constrained by include patterns.
    effectiveConfig = { ...config };
    delete effectiveConfig.include;
  } else if (args.all) {
    rootRel = '.';
    effectiveConfig = { ...config };
    delete effectiveConfig.include;
  } else {
    rootRel = inferRootFromInclude(config.include);
  }

  const { graph, warnings } = await buildGraph(projectRoot, rootRel, effectiveConfig);

  // Persist to project root
  const outPath = path.join(projectRoot, '.dep-graph.json');
  const ok = await writeJsonSafe(outPath, graph);
  if (!ok && !args.json) {
    console.error(`Failed to write: ${outPath}`);
  }

  // Warnings always go to stderr to keep --json stdout clean.
  if (warnings.length > 0) {
    for (const w of warnings.slice(0, 50)) console.error(`WARN ${w}`);
    if (warnings.length > 50) console.error(`WARN ... +${warnings.length - 50} more`);
  }

  if (args.check) {
    // If we couldn't persist, try reading existing graph to still support check.
    let g = graph;
    if (!ok) {
      const existing = await readJsonSafe(outPath, null);
      if (existing && existing.version === 1 && existing.files) g = existing;
    }
    printCheck(g, String(args.check), Boolean(args.json));
    return;
  }

  if (args.checkCycles || args.checkOrphans) {
    // If we couldn't persist, try reading existing graph to still support check.
    let g = graph;
    if (!ok) {
      const existing = await readJsonSafe(outPath, null);
      if (existing && existing.version === 1 && existing.files) g = existing;
    }
    printHealthChecks(
      g,
      { cycles: Boolean(args.checkCycles), orphans: Boolean(args.checkOrphans) },
      Boolean(args.json)
    );
    return;
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(graph, null, 2) + '\n');
    return;
  }

  const fileCount = Object.keys(graph.files).length;
  const moduleCount = Object.keys(graph.modules).length;
  const cycleCount = graph.cycles.length;
  console.log(`Root: ${graph.root}`);
  console.log(`Files: ${fileCount}`);
  console.log(`Modules: ${moduleCount}`);
  console.log(`Cycles: ${cycleCount}`);
  console.log(`Wrote: ${outPath}`);
}

main().catch(err => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
