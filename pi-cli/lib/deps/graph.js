/**
 * Dependency graph builder and analyzer
 * Language-agnostic with pluggable parsers
 */

import { promises as fs } from 'fs';
import path from 'path';
import { readJsonSafe, writeJsonSafe, matchesPattern, runCommand, parallelMap } from '../shared.js';
import { getCachePath } from '../context.js';

/** @typedef {import('../types.js').ProjectConfig} ProjectConfig */
/** @typedef {import('../types.js').DependencyGraph} DependencyGraph */

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
  'venv', '.venv', 'target', 'vendor', '.cache', 'coverage',
  '.turbo', '.nuxt', '.output', 'out', '.project-index'
]);

/**
 * Language-specific import parsers
 */
const IMPORT_PARSERS = {
  javascript: parseJsImports,
  typescript: parseJsImports,
  python: parsePythonImports,
  go: parseGoImports,
  rust: parseRustImports
};

/**
 * Parse JS/TS imports from file content
 * @param {string} content
 * @returns {string[]}
 */
function parseJsImports(content) {
  const stripped = stripJsComments(content);
  const specs = new Set();

  const patterns = [
    /\bimport\s+(?:type\s+)?[\w*\s{},$]+\sfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]\s*;?/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bexport\s*\{[\s\S]*?\}\s*from\s*['"]([^'"]+)['"]/g,
    /\bexport\s*\*\s*from\s*['"]([^'"]+)['"]/g,
    /\bexport\s*\*\s*as\s*[\w$]+\s*from\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ];

  for (const re of patterns) {
    let m;
    while ((m = re.exec(stripped)) !== null) {
      const spec = m[1]?.trim();
      if (spec) specs.add(spec);
    }
  }

  return [...specs];
}

/**
 * Parse Python imports
 * @param {string} content
 * @returns {string[]}
 */
function parsePythonImports(content) {
  const specs = new Set();

  // import foo, from foo import bar
  const patterns = [
    /^\s*import\s+([\w.]+)/gm,
    /^\s*from\s+([\w.]+)\s+import/gm
  ];

  for (const re of patterns) {
    let m;
    while ((m = re.exec(content)) !== null) {
      specs.add(m[1]);
    }
  }

  return [...specs];
}

/**
 * Parse Go imports
 * @param {string} content
 * @returns {string[]}
 */
function parseGoImports(content) {
  const specs = new Set();

  // Single import
  const singleRe = /^\s*import\s+"([^"]+)"/gm;
  let m;
  while ((m = singleRe.exec(content)) !== null) {
    specs.add(m[1]);
  }

  // Block import
  const blockRe = /import\s*\(([\s\S]*?)\)/g;
  while ((m = blockRe.exec(content)) !== null) {
    const block = m[1];
    const lineRe = /"([^"]+)"/g;
    let lm;
    while ((lm = lineRe.exec(block)) !== null) {
      specs.add(lm[1]);
    }
  }

  return [...specs];
}

/**
 * Parse Rust imports (use statements)
 * @param {string} content
 * @returns {string[]}
 */
function parseRustImports(content) {
  const specs = new Set();
  const useRe = /\buse\s+([\w:]+)/g;
  let m;
  while ((m = useRe.exec(content)) !== null) {
    specs.add(m[1].split('::')[0]); // Get crate name
  }
  return [...specs];
}

/**
 * Strip JS comments (simplified)
 * @param {string} input
 * @returns {string}
 */
function stripJsComments(input) {
  return input
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Scan directory for source files
 * @param {string} rootAbs
 * @param {ProjectConfig} config
 * @returns {Promise<Map<string, string>>}
 */
async function scanFiles(rootAbs, config) {
  const results = new Map();
  const pattern = config.src.pattern || '**/*';
  const ignore = config.src.ignore || [];

  const extensions = getExtensions(config.language);

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(rootAbs, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        if (ignore.some(p => matchesPattern(p, entry.name))) continue;
        await walk(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (!extensions.includes(ext)) continue;

      if (!matchesPattern(pattern, relPath)) continue;
      if (ignore.some(p => matchesPattern(p, relPath))) continue;

      results.set(relPath, fullPath);
    }
  }

  await walk(rootAbs);
  return results;
}

/**
 * Get file extensions for language
 * @param {string} language
 * @returns {string[]}
 */
function getExtensions(language) {
  const exts = {
    javascript: ['.js', '.mjs', '.cjs', '.jsx'],
    typescript: ['.ts', '.tsx', '.mts', '.cts'],
    python: ['.py'],
    go: ['.go'],
    rust: ['.rs'],
    java: ['.java'],
    ruby: ['.rb'],
    php: ['.php']
  };
  return exts[language] || ['.js'];
}

/**
 * Resolve import specifier to file path
 * @param {string} spec
 * @param {string} fromFile
 * @param {string} rootAbs
 * @param {Map<string, string>} knownFiles
 * @param {string} language
 * @returns {string|null}
 */
function resolveImport(spec, fromFile, rootAbs, knownFiles, language) {
  if (!spec.startsWith('.')) return null;

  const fromAbs = path.join(rootAbs, fromFile);
  const base = path.resolve(path.dirname(fromAbs), spec);

  const exts = getExtensions(language);
  const candidates = [];

  if (path.extname(base)) {
    candidates.push(base);
  } else {
    for (const ext of exts) {
      candidates.push(`${base}${ext}`);
    }
    candidates.push(path.join(base, `index${exts[0]}`));
  }

  for (const abs of candidates) {
    const rel = path.relative(rootAbs, abs).replace(/\\/g, '/');
    if (rel.startsWith('..')) continue;
    if (knownFiles.has(rel)) return rel;
  }

  return null;
}

/**
 * Build dependency graph
 * @param {{root: string, config: ProjectConfig}} ctx
 * @param {object} args
 */
export async function buildGraph(ctx, args) {
  const { root, config } = ctx;
  const parser = IMPORT_PARSERS[config.language] || parseJsImports;

  /** @type {Record<string, {imports: string[], importedBy: string[]}>} */
  const files = {};
  const edges = new Map();

  // Scan all source directories
  const allFiles = new Map();
  for (const srcDir of config.src.dirs) {
    const srcAbs = path.join(root, srcDir);
    const scanned = await scanFiles(srcAbs, config);
    for (const [rel, abs] of scanned) {
      const fullRel = path.join(srcDir, rel).replace(/\\/g, '/');
      allFiles.set(fullRel, abs);
    }
  }

  // Parse imports for each file
  for (const [relPath, absPath] of allFiles) {
    let content;
    try {
      content = await fs.readFile(absPath, 'utf8');
    } catch {
      continue;
    }

    const imports = parser(content);
    const resolvedImports = [];

    for (const spec of imports) {
      const resolved = resolveImport(spec, relPath, root, allFiles, config.language);
      if (resolved) resolvedImports.push(resolved);
    }

    files[relPath] = { imports: resolvedImports, importedBy: [] };
    edges.set(relPath, new Set(resolvedImports));
  }

  // Build reverse dependencies
  for (const [file, node] of Object.entries(files)) {
    for (const imp of node.imports) {
      if (files[imp]) {
        files[imp].importedBy.push(file);
      }
    }
  }

  // Detect cycles
  const cycles = detectCycles(edges);

  const graph = {
    version: 1,
    generated: new Date().toISOString(),
    root: root,
    language: config.language,
    files,
    cycles,
    stats: {
      totalFiles: Object.keys(files).length,
      totalEdges: [...edges.values()].reduce((sum, s) => sum + s.size, 0),
      cycleCount: cycles.length
    }
  };

  // Save to cache
  const cachePath = getCachePath(config, root, '.dep-graph.json');
  await writeJsonSafe(cachePath, graph);

  if (args.json) {
    console.log(JSON.stringify(graph, null, 2));
  } else {
    console.log(`Built dependency graph: ${graph.stats.totalFiles} files, ${graph.stats.totalEdges} edges`);
    if (cycles.length > 0) {
      console.log(`Warning: ${cycles.length} cycles detected`);
    }
  }
}

/**
 * Detect cycles using DFS
 * @param {Map<string, Set<string>>} edges
 * @returns {string[][]}
 */
function detectCycles(edges) {
  const nodes = [...edges.keys()].sort();
  const color = new Map(nodes.map(n => [n, 0])); // 0=white, 1=gray, 2=black
  const stack = [];
  const cycles = [];
  const seen = new Set();

  function dfs(u) {
    color.set(u, 1);
    stack.push(u);

    for (const v of edges.get(u) || []) {
      if (color.get(v) === 1) {
        // Back edge - cycle found
        const cycleStart = stack.indexOf(v);
        const cycle = stack.slice(cycleStart);
        const key = [...cycle].sort().join('|');
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      } else if (color.get(v) === 0) {
        dfs(v);
      }
    }

    stack.pop();
    color.set(u, 2);
  }

  for (const node of nodes) {
    if (color.get(node) === 0) {
      dfs(node);
    }
  }

  return cycles;
}

const DEFAULT_IMPACT_DEPTH = 2;
const MAX_IMPACT_DEPTH = 2; // Spec: up to 2 layers (L1 + L2)
const DEFAULT_RISK_THRESHOLD = 50;
const DEFAULT_RISK_TOP = 10;
const DEFAULT_STALE_DEPTH = 2;
const MAX_STALE_DEPTH = 25;

/**
 * Convert a path to posix separators for stable keys.
 * @param {string} p
 * @returns {string}
 */
function toPosixPath(p) {
  return String(p || '').replace(/\\/g, '/');
}

/**
 * Normalize a relative path-like input:
 * - normalize separators to "/"
 * - remove leading "./"
 * - remove trailing "/"
 *
 * @param {string} input
 * @returns {string}
 */
function normalizeRelInput(input) {
  const normalized = toPosixPath(path.normalize(String(input || '')));
  const trimmed = normalized.replace(/^\.\/+/, '').replace(/\/+$/, '');
  return trimmed || '.';
}

/**
 * @param {string} output
 * @returns {string[]}
 */
function splitLines(output) {
  return String(output || '')
    .split(/\r?\n/)
    .filter(s => s.length > 0);
}

/**
 * Normalize git output paths (already relative to repo root).
 * @param {string[]} paths
 * @returns {string[]}
 */
function normalizeGitPaths(paths) {
  /** @type {string[]} */
  const out = [];
  for (const p of paths || []) {
    const rel = normalizeRelInput(p);
    if (!rel || rel === '.') continue;
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    out.push(rel);
  }
  return out;
}

/**
 * @param {string[]} list
 * @returns {string[]}
 */
function uniqueSorted(list) {
  return Array.from(new Set(list || [])).sort((a, b) => a.localeCompare(b));
}

/**
 * @param {any} input
 * @returns {number}
 */
function clampImpactDepth(input) {
  const n = Number.parseInt(String(input), 10);
  const depth = Number.isFinite(n) ? n : DEFAULT_IMPACT_DEPTH;
  return Math.max(0, Math.min(MAX_IMPACT_DEPTH, depth));
}

/**
 * @param {any} input
 * @returns {number}
 */
function clampStaleDepth(input) {
  const n = Number.parseInt(String(input), 10);
  const depth = Number.isFinite(n) ? n : DEFAULT_STALE_DEPTH;
  return Math.max(0, Math.min(MAX_STALE_DEPTH, depth));
}

/**
 * L1: direct importers
 * L2: transitive importers (2nd hop)
 *
 * @param {DependencyGraph} depGraph
 * @param {string[]} changedFiles
 * @param {number} depth
 * @returns {{ depth: number, L1: Set<string>, L2: Set<string>, affected: Set<string> }}
 */
function analyzeImpactLayers(depGraph, changedFiles, depth) {
  const clampedDepth = clampImpactDepth(depth);

  /** @type {Set<string>} */
  const visited = new Set(changedFiles);
  /** @type {Set<string>} */
  let frontier = new Set(changedFiles);

  /** @type {Set<string>} */
  const L1 = new Set();
  /** @type {Set<string>} */
  const L2 = new Set();

  for (let d = 1; d <= clampedDepth; d++) {
    /** @type {Set<string>} */
    const next = new Set();

    for (const file of frontier) {
      const node = depGraph.files?.[file];
      const importedBy = Array.isArray(node?.importedBy) ? node.importedBy : [];
      for (const parent of importedBy) {
        const rel = normalizeRelInput(parent);
        if (!rel || rel === '.' || visited.has(rel)) continue;
        visited.add(rel);
        next.add(rel);
        if (d === 1) L1.add(rel);
        else L2.add(rel);
      }
    }

    frontier = next;
    if (frontier.size === 0) break;
  }

  /** @type {Set<string>} */
  const affected = new Set([...L1, ...L2]);
  return { depth: clampedDepth, L1, L2, affected };
}

/**
 * Count all downstream affected files for a single changed file (unbounded BFS).
 * Used for "high-risk" scoring (independent of --depth).
 *
 * @param {DependencyGraph} depGraph
 * @param {string} start
 * @returns {number}
 */
function countAllAffected(depGraph, start) {
  const s = normalizeRelInput(start);
  if (!s || s === '.' || !depGraph.files?.[s]) return 0;

  /** @type {Set<string>} */
  const visited = new Set([s]);
  /** @type {string[]} */
  const queue = [s];

  while (queue.length > 0) {
    const file = queue.shift();
    const node = file ? depGraph.files?.[file] : null;
    const importedBy = Array.isArray(node?.importedBy) ? node.importedBy : [];

    for (const parent of importedBy) {
      const rel = normalizeRelInput(parent);
      if (!rel || rel === '.' || visited.has(rel)) continue;
      visited.add(rel);
      queue.push(rel);
    }
  }

  return Math.max(0, visited.size - 1);
}

/**
 * @param {string} relPath
 * @returns {string}
 */
function moduleName(relPath) {
  const p = normalizeRelInput(relPath);
  const idx = p.indexOf('/');
  if (idx === -1) return '(root)';
  return p.slice(0, idx) || '(root)';
}

/**
 * @param {string[]} affectedFiles
 * @returns {Record<string, number>}
 */
function buildModuleBreakdown(affectedFiles) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const f of affectedFiles || []) {
    const mod = moduleName(f);
    out[mod] = (out[mod] || 0) + 1;
  }
  return out;
}

/**
 * Collect test files to rerun from .test-map.json (if present).
 * Supports the project-index cache format:
 *   { srcToTest: Record<string,string>, testToSrc: Record<string,string> }
 *
 * @param {any} testMap
 * @param {string[]} files
 * @returns {string[]}
 */
function collectTestFilesFromMap(testMap, files) {
  const srcToTest = testMap?.srcToTest && typeof testMap.srcToTest === 'object' ? testMap.srcToTest : {};
  const testToSrc = testMap?.testToSrc && typeof testMap.testToSrc === 'object' ? testMap.testToSrc : {};

  /** @type {Set<string>} */
  const out = new Set();

  for (const file of files || []) {
    const rel = normalizeRelInput(file);
    if (!rel || rel === '.') continue;

    const mapped = srcToTest?.[rel];
    if (typeof mapped === 'string' && mapped) {
      out.add(normalizeRelInput(mapped));
      continue;
    }

    // If the changed file itself is a test file, rerun it.
    if (typeof testToSrc?.[rel] === 'string' && testToSrc[rel]) {
      out.add(rel);
    }
  }

  return uniqueSorted(Array.from(out));
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<string>}
 */
async function git(cwd, args) {
  const res = await runCommand('git', args, { cwd });
  if (res.code !== 0) {
    const message = String(res.stderr || '').trim() || `git ${args.join(' ')}`;
    throw new Error(message);
  }
  return String(res.stdout || '').trimEnd();
}

/**
 * Analyze impact of a file change
 * @param {{root: string, config: ProjectConfig}} ctx
 * @param {object} args
 */
export async function analyzeImpact(ctx, args) {
  const { root, config } = ctx;
  const cachePath = getCachePath(config, root, '.dep-graph.json');
  const graph = await readJsonSafe(cachePath);

  if (!graph) {
    console.error('No dependency graph found. Run "pi deps build" first.');
    process.exitCode = 1;
    return;
  }

  if (args.since && args.staged) {
    console.error('Error: --since and --staged are mutually exclusive.');
    process.exitCode = 1;
    return;
  }

  /** @type {string[]} */
  let changed = [];

  if (args.since) {
    try {
      const out = await git(root, ['diff', '--name-only', String(args.since)]);
      changed = normalizeGitPaths(splitLines(out));
    } catch (err) {
      console.error(`Error: failed to run git diff --name-only ${args.since}`);
      console.error(err?.message || String(err));
      process.exitCode = 1;
      return;
    }
  } else if (args.staged) {
    try {
      const out = await git(root, ['diff', '--name-only', '--cached']);
      changed = normalizeGitPaths(splitLines(out));
    } catch (err) {
      console.error('Error: failed to run git diff --name-only --cached');
      console.error(err?.message || String(err));
      process.exitCode = 1;
      return;
    }
  } else {
    changed = (args._ || []).slice(2).map(normalizeRelInput).filter(p => p && p !== '.');
  }

  changed = uniqueSorted(changed);

  if (changed.length === 0) {
    console.error('No changed files found. Provide file paths or use --since/--staged.');
    console.error('Usage: pi deps impact <file1> [file2...] [--since <commit> | --staged] [--depth <0-2>] [--json]');
    process.exitCode = 1;
    return;
  }

  const { depth, L1, L2, affected } = analyzeImpactLayers(graph, changed, args.depth);

  const l1Arr = uniqueSorted(Array.from(L1));
  const l2Arr = uniqueSorted(Array.from(L2));
  const affectedArr = uniqueSorted(Array.from(affected));
  const moduleBreakdown = buildModuleBreakdown(affectedArr);

  const highRisk = changed
    .map(file => ({ file, affectedCount: countAllAffected(graph, file) }))
    .filter(item => item.affectedCount >= DEFAULT_RISK_THRESHOLD)
    .sort((a, b) => (b.affectedCount - a.affectedCount) || a.file.localeCompare(b.file))
    .slice(0, DEFAULT_RISK_TOP);

  const testMapPath = getCachePath(config, root, '.test-map.json');
  const testMap = await readJsonSafe(testMapPath);
  const hasTestMap = Boolean(testMap && typeof testMap === 'object');
  const fileUniverse = uniqueSorted([...changed, ...affectedArr]);
  const testFiles = hasTestMap ? collectTestFilesFromMap(testMap, fileUniverse) : [];

  const single = changed.length === 1 ? normalizeRelInput(changed[0]) : null;
  const directDependents = single && graph.files?.[single]
    ? (graph.files[single]?.importedBy?.length || 0)
    : undefined;

  const result = {
    ...(single ? { file: single, directDependents } : {}),
    changed,
    depth,
    impact: { L1: l1Arr, L2: l2Arr, total: affected.size },
    highRisk,
    moduleBreakdown,
    ...(hasTestMap ? { testFiles } : {}),
    totalAffected: affected.size,
    affected: affectedArr
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Changed: ${changed.length} files`);
    for (const f of changed.slice(0, 50)) console.log(`  - ${f}`);
    if (changed.length > 50) console.log(`  ... and ${changed.length - 50} more`);

    console.log('\nImpact Analysis:');
    console.log(`  Depth: ${depth}`);
    console.log(`  L1 (direct): ${l1Arr.length} files`);
    console.log(`  L2 (transitive): ${l2Arr.length} files`);
    console.log(`  Total affected: ${affected.size} files`);

    if (highRisk.length > 0) {
      console.log('\nHigh-risk changes:');
      for (const item of highRisk) {
        console.log(`  ! ${item.file} affects ${item.affectedCount} files`);
      }
    }

    const modules = Object.entries(moduleBreakdown)
      .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));

    if (modules.length > 0) {
      console.log('\nModules affected:');
      for (const [mod, count] of modules) {
        console.log(`  - ${mod}: ${count} files`);
      }
    }

    if (hasTestMap && testFiles.length > 0) {
      console.log('\nTests to rerun:');
      for (const t of testFiles) console.log(`  - ${t}`);
    }

    if (affectedArr.length > 0 && affectedArr.length <= 20) {
      console.log('\nAffected files:');
      for (const f of affectedArr) console.log(`  - ${f}`);
    }
  }
}

/**
 * Propagate staleness through dependency graph
 * @param {{root: string, config: ProjectConfig}} ctx
 * @param {object} args
 */
export async function propagateStale(ctx, args) {
  const { root, config } = ctx;
  const cachePath = getCachePath(config, root, '.dep-graph.json');
  const rootPath = path.join(root, '.dep-graph.json');

  /** @type {any} */
  let graph = await readJsonSafe(cachePath);
  /** @type {string} */
  let graphPath = cachePath;
  if (!graph) {
    graph = await readJsonSafe(rootPath);
    graphPath = rootPath;
  }

  if (!graph) {
    console.error('No dependency graph found. Run "pi deps build" first.');
    process.exitCode = 1;
    return;
  }

  /**
   * @param {string} input
   * @returns {string[]}
   */
  function splitCommaList(input) {
    return String(input || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
  }

  /**
   * Convert an input path into a safe project-relative path key.
   * @param {string} rootAbs
   * @param {string} input
   * @returns {string|null}
   */
  function toProjectRelPath(rootAbs, input) {
    const raw = String(input || '').trim();
    if (!raw) return null;

    if (path.isAbsolute(raw)) {
      const rel = path.relative(rootAbs, raw);
      const normalized = normalizeRelInput(rel);
      if (!normalized || normalized === '.') return null;
      if (normalized.startsWith('..') || path.isAbsolute(normalized)) return null;
      return normalized;
    }

    const normalized = normalizeRelInput(raw);
    if (!normalized || normalized === '.') return null;
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) return null;
    return normalized;
  }

  /**
   * Collect all occurrences of `--changed` from raw argv.
   * Supports:
   *  - --changed <file>
   *  - --changed=<file>
   *  - repeated --changed
   *  - comma-separated lists
   *
   * @param {string[]} argv
   * @returns {string[]}
   */
  function collectChangedFromArgv(argv) {
    const out = [];
    const prefix = '--changed=';
    for (let i = 0; i < (argv || []).length; i++) {
      const a = String(argv[i] || '');
      if (a === '--changed') {
        const next = i + 1 < argv.length ? String(argv[i + 1] || '') : '';
        if (next && !next.startsWith('-')) {
          out.push(next);
          i++;
        }
        continue;
      }
      if (a.startsWith(prefix)) out.push(a.slice(prefix.length));
    }
    return out.flatMap(splitCommaList);
  }

  /**
   * @param {string} absPath
   * @returns {Promise<Date|null>}
   */
  async function getMtimeSafe(absPath) {
    try {
      const st = await fs.stat(absPath);
      return st?.mtime || null;
    } catch {
      return null;
    }
  }

  /**
   * @param {string} file
   * @param {Date|null} mtime
   * @returns {{file: string, mtime: string|null}}
   */
  function toDirectItem(file, mtime) {
    return { file: normalizeRelInput(file), mtime: mtime ? mtime.toISOString() : null };
  }

  /**
   * @param {Date|null} date
   * @returns {string}
   */
  function formatDay(date) {
    if (!date) return 'N/A';
    return date.toISOString().split('T')[0];
  }

  /**
   * Multi-source BFS propagate stale status via reverse deps (importedBy).
   * For each discovered file, record:
   *  - level: 1..depth
   *  - source: the immediate stale dependency at previous level
   *
   * @param {any} depGraph
   * @param {string[]} directKeys
   * @param {number} depth
   * @returns {{ propagated: {file: string, level: number, source: string}[], levelCounts: Map<number, number> }}
   */
  function propagate(depGraph, directKeys, depth) {
    const maxDepth = clampStaleDepth(depth);

    /** @type {Map<string, number>} */
    const visitedLevel = new Map();
    /** @type {Map<string, string>} */
    const cause = new Map();

    /** @type {{file: string, level: number}[]} */
    const queue = [];
    for (const f of uniqueSorted(directKeys.map(normalizeRelInput)).filter(p => p && p !== '.')) {
      visitedLevel.set(f, 0);
      queue.push({ file: f, level: 0 });
    }

    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      if (item.level >= maxDepth) continue;

      const node = depGraph.files?.[item.file];
      const importedBy = Array.isArray(node?.importedBy) ? node.importedBy : [];
      const parents = importedBy
        .map(normalizeRelInput)
        .filter(p => p && p !== '.' && !p.startsWith('..') && !path.isAbsolute(p))
        .sort((a, b) => a.localeCompare(b));

      for (const parent of parents) {
        if (visitedLevel.has(parent)) continue;
        const nextLevel = item.level + 1;
        visitedLevel.set(parent, nextLevel);
        cause.set(parent, item.file);
        queue.push({ file: parent, level: nextLevel });
      }
    }

    /** @type {{file: string, level: number, source: string}[]} */
    const propagated = [];
    /** @type {Map<number, number>} */
    const levelCounts = new Map();

    for (const [file, level] of visitedLevel.entries()) {
      if (level <= 0) continue;
      const src = cause.get(file);
      if (!src) continue;
      propagated.push({ file, level, source: src });
      levelCounts.set(level, (levelCounts.get(level) || 0) + 1);
    }

    propagated.sort((a, b) => (a.level - b.level) || a.file.localeCompare(b.file));
    return { propagated, levelCounts };
  }

  const depth = clampStaleDepth(args.depth);

  const generatedAt = (() => {
    const d = new Date(graph.generated);
    return Number.isFinite(d.getTime()) ? d : null;
  })() || (await getMtimeSafe(graphPath));

  if (!generatedAt) {
    console.error(`Error: cannot determine generated time from ${graphPath}`);
    process.exitCode = 1;
    return;
  }

  const positional = (args._ || []).slice(2);
  const changedFromArgs = Array.isArray(args.changed)
    ? args.changed.flatMap(splitCommaList)
    : typeof args.changed === 'string'
    ? splitCommaList(args.changed)
    : [];

  const changedFromArgv = Array.isArray(args._) && args._[0] === 'deps' && args._[1] === 'propagate'
    ? collectChangedFromArgv(process.argv.slice(2))
    : [];

  const explicitChanged = uniqueSorted([
    ...positional.flatMap(splitCommaList),
    ...changedFromArgs,
    ...changedFromArgv
  ])
    .map(s => toProjectRelPath(root, s))
    .filter(p => p && p !== '.' && !p.startsWith('..') && !path.isAbsolute(p));

  const hasExplicitChanged = explicitChanged.length > 0;

  /** @type {string[]} */
  let directKeys = [];
  /** @type {Map<string, Date|null>} */
  const directMtimes = new Map();

  if (hasExplicitChanged) {
    directKeys = uniqueSorted(explicitChanged);
    await Promise.all(directKeys.map(async (k) => {
      const abs = path.join(root, k);
      directMtimes.set(k, await getMtimeSafe(abs));
    }));
  } else {
    const allKeys = uniqueSorted(Object.keys(graph.files || {}).map(normalizeRelInput))
      .filter(k => k && k !== '.' && !k.startsWith('..') && !path.isAbsolute(k));

    const mtimes = await parallelMap(
      allKeys,
      async (k) => {
        const abs = path.join(root, k);
        return { key: k, mtime: await getMtimeSafe(abs) };
      },
      25
    );

    for (const item of mtimes) {
      if (!item?.mtime) continue;
      if (item.mtime > generatedAt) {
        directKeys.push(item.key);
        directMtimes.set(item.key, item.mtime);
      }
    }

    directKeys = uniqueSorted(directKeys);
  }

  /** @type {string[]} */
  const directInGraph = [];
  /** @type {string[]} */
  const notInGraph = [];
  for (const k of directKeys) {
    const rel = normalizeRelInput(k);
    if (!rel || rel === '.' || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (graph.files?.[rel]) directInGraph.push(rel);
    else notInGraph.push(rel);
  }

  if (notInGraph.length > 0) {
    for (const f of notInGraph.slice(0, 50)) {
      console.error(`WARN not in dep graph: ${f}`);
    }
    if (notInGraph.length > 50) {
      console.error(`WARN ... +${notInGraph.length - 50} more`);
    }
  }

  const directStale = directKeys.map(k => toDirectItem(k, directMtimes.get(k) || null));
  const { propagated, levelCounts } = propagate(graph, directInGraph, depth);

  /** @type {Record<string, number>} */
  const summary = {
    direct: directStale.length,
    propagated: propagated.length,
    total: directStale.length + propagated.length
  };

  for (let lvl = 1; lvl <= depth; lvl++) {
    summary[`L${lvl}`] = levelCounts.get(lvl) || 0;
  }

  const propagatedFiles = propagated.map(p => p.file);
  const staleFiles = uniqueSorted([...directKeys, ...propagatedFiles]);

  /** @type {string[]|null} */
  let testsToRun = null;
  if (args.tests) {
    const testMapPath = getCachePath(config, root, '.test-map.json');
    const testMap = await readJsonSafe(testMapPath);
    const hasTestMap = Boolean(testMap && typeof testMap === 'object');
    if (!hasTestMap) {
      console.error(`WARN missing test map: ${testMapPath} (run "pi test map")`);
      testsToRun = [];
    } else {
      const fileUniverse = uniqueSorted([...directKeys, ...propagatedFiles]);
      testsToRun = collectTestFilesFromMap(testMap, fileUniverse);
    }
  }

  const result = {
    depth,
    generatedAt: generatedAt.toISOString(),
    directStale,
    propagatedStale: propagated,
    summary,
    ...(args.tests ? { testsToRun: testsToRun || [] } : {}),
    // Back-compat fields
    changedFiles: directKeys,
    staleFiles,
    totalStale: staleFiles.length,
    ...(notInGraph.length > 0 ? { ignoredChanged: uniqueSorted(notInGraph) } : {})
  };

  if (args.quiet) {
    return result;
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result;
  }

  console.log('=== Stale Propagation Analysis ===\n');

  console.log('Direct stale (source changed):');
  if (directStale.length === 0) {
    console.log('  (none)\n');
  } else {
    for (const item of directStale) {
      const day = item.mtime ? formatDay(new Date(item.mtime)) : 'N/A';
      console.log(`  ${item.file} (${day})`);
    }
    console.log('');
  }

  console.log('Propagated stale (dependency changed):');
  if (propagated.length === 0) {
    console.log('  (none)\n');
  } else {
    for (const item of propagated) {
      console.log(`  L${item.level}: ${item.file} <- ${item.source}`);
    }
    console.log('');
  }

  const levelParts = [];
  for (let lvl = 1; lvl <= depth; lvl++) {
    const count = summary[`L${lvl}`] || 0;
    if (count > 0) levelParts.push(`L${lvl}: ${count}`);
  }

  console.log('Summary:');
  console.log(`  Direct: ${summary.direct} files`);
  console.log(`  Propagated: ${summary.propagated} files${levelParts.length > 0 ? ` (${levelParts.join(', ')})` : ''}`);
  console.log(`  Total affected: ${summary.total} files\n`);

  if (testsToRun) {
    console.log(`Tests to re-run: ${testsToRun.length} files`);
    const maxShow = 25;
    for (const t of testsToRun.slice(0, maxShow)) console.log(`  - ${t}`);
    if (testsToRun.length > maxShow) console.log(`  ... +${testsToRun.length - maxShow} more`);
  }

  return result;
}

/**
 * Query file dependencies (both directions, with depth)
 * @param {{root: string, config: ProjectConfig}} ctx
 * @param {object} args
 */
export async function queryDeps(ctx, args) {
  const { root, config } = ctx;

  // Try cache path first, then root directory
  let graph = await readJsonSafe(getCachePath(config, root, '.dep-graph.json'));
  if (!graph) {
    graph = await readJsonSafe(path.join(root, '.dep-graph.json'));
  }

  if (!graph) {
    console.error('No dependency graph found. Run "pi deps build" first.');
    process.exitCode = 1;
    return;
  }

  const targetFile = args._[2]; // pi deps query <file>
  const maxDepth = parseInt(args.depth) || 3;

  if (!targetFile) {
    console.error('Usage: pi deps query <file> [--depth=N] [--json]');
    console.error('  --depth=N  Max depth to traverse (default: 3)');
    console.error('  --json     Output as JSON');
    process.exitCode = 1;
    return;
  }

  // Find matching file(s)
  const matches = Object.keys(graph.files).filter(f =>
    f === targetFile || f.endsWith(targetFile) || f.includes(targetFile)
  );

  if (matches.length === 0) {
    console.error(`File not found in graph: ${targetFile}`);
    console.error('Available files (sample):');
    Object.keys(graph.files).slice(0, 10).forEach(f => console.error(`  ${f}`));
    process.exitCode = 1;
    return;
  }

  if (matches.length > 1 && !args.all) {
    console.log(`Multiple matches found for "${targetFile}":`);
    matches.slice(0, 20).forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    if (matches.length > 20) console.log(`  ... and ${matches.length - 20} more`);
    console.log('\nUse full path or --all to query all matches');
    return;
  }

  const filesToQuery = args.all ? matches : [matches[0]];

  for (const file of filesToQuery) {
    const node = graph.files[file];

    // Collect imports chain (what this file depends on)
    const importsChain = [];
    const visitedImports = new Set([file]);
    function collectImports(fileId, depth) {
      if (depth > maxDepth) return;
      const n = graph.files[fileId];
      if (!n) return;
      for (const imp of n.imports) {
        if (visitedImports.has(imp)) continue;
        visitedImports.add(imp);
        importsChain.push({ file: imp, depth, via: fileId });
        collectImports(imp, depth + 1);
      }
    }
    collectImports(file, 1);

    // Collect importedBy chain (what depends on this file)
    const importedByChain = [];
    const visitedImportedBy = new Set([file]);
    function collectImportedBy(fileId, depth) {
      if (depth > maxDepth) return;
      const n = graph.files[fileId];
      if (!n) return;
      for (const by of n.importedBy) {
        if (visitedImportedBy.has(by)) continue;
        visitedImportedBy.add(by);
        importedByChain.push({ file: by, depth, via: fileId });
        collectImportedBy(by, depth + 1);
      }
    }
    collectImportedBy(file, 1);

    const result = {
      file,
      imports: {
        direct: node.imports,
        chain: importsChain,
        totalUnique: new Set(importsChain.map(x => x.file)).size
      },
      importedBy: {
        direct: node.importedBy,
        chain: importedByChain,
        totalUnique: new Set(importedByChain.map(x => x.file)).size
      }
    };

    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\n📄 ${file}`);
      console.log('─'.repeat(60));

      console.log(`\n→ Imports (depends on): ${node.imports.length} direct, ${result.imports.totalUnique} total`);
      if (node.imports.length > 0) {
        for (const imp of node.imports.slice(0, 15)) {
          console.log(`  └─ ${imp}`);
        }
        if (node.imports.length > 15) console.log(`  ... and ${node.imports.length - 15} more`);
      }

      console.log(`\n← ImportedBy (depended by): ${node.importedBy.length} direct, ${result.importedBy.totalUnique} total`);
      if (node.importedBy.length > 0) {
        for (const by of node.importedBy.slice(0, 15)) {
          console.log(`  └─ ${by}`);
        }
        if (node.importedBy.length > 15) console.log(`  ... and ${node.importedBy.length - 15} more`);
      }

      // Show dependency tree
      if (importsChain.length > 0 && !args.noTree) {
        console.log(`\n→ Import chain (depth ${maxDepth}):`);
        const byDepth = {};
        for (const item of importsChain) {
          if (!byDepth[item.depth]) byDepth[item.depth] = [];
          byDepth[item.depth].push(item.file);
        }
        for (let d = 1; d <= maxDepth; d++) {
          if (byDepth[d]) {
            const files = [...new Set(byDepth[d])];
            console.log(`  Level ${d}: ${files.slice(0, 5).map(f => f.split('/').pop()).join(', ')}${files.length > 5 ? ` (+${files.length - 5})` : ''}`);
          }
        }
      }
    }
  }
}
