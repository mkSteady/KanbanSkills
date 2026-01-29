/**
 * Documentation generator
 * Generates CLAUDE.md index files for modules
 */

import { promises as fs } from 'fs';
import path from 'path';
import { matchesIgnoreInclude, matchesPattern } from '../shared.js';
import { loadStaleConfig } from '../context.js';

/** @typedef {import('../types.js').ProjectConfig} ProjectConfig */

/**
 * Generate documentation for modules
 * @param {{root: string, config: ProjectConfig}} ctx
 * @param {object} args
 */
export async function generate(ctx, args) {
  const { root, config } = ctx;
  const staleConfig = ctx.staleConfig || await loadStaleConfig(root, config);
  const ignore = staleConfig?.ignore || [];
  const include = staleConfig?.include || [];

  const targetDir = args._[2] || config.src.dirs[0];
  if (!targetDir) {
    console.error('No target directory. Specify one or set src.dirs in config.');
    process.exitCode = 1;
    return;
  }

  const absDir = path.join(root, targetDir);

  // Scan for modules (subdirectories)
  const modules = await scanModules(absDir, root, config, ignore, include);

  console.log(`Found ${modules.length} modules in ${targetDir}`);

  // Generate index for each module
  for (const mod of modules) {
    const docPath = path.join(mod.path, 'CLAUDE.md');
    const content = generateModuleDoc(mod, config, staleConfig);

    if (!args.dryRun) {
      await fs.writeFile(docPath, content);
      console.log(`  Generated: ${path.relative(root, docPath)}`);
    } else {
      console.log(`  Would generate: ${path.relative(root, docPath)}`);
    }
  }

  // Generate root index
  const rootDocPath = path.join(absDir, 'CLAUDE.md');
  const rootContent = generateRootDoc(modules, targetDir, config, staleConfig);

  if (!args.dryRun) {
    await fs.writeFile(rootDocPath, rootContent);
    console.log(`Generated root: ${path.relative(root, rootDocPath)}`);
  }
}

/**
 * Scan for modules in directory
 * @param {string} dir
 * @param {string} root
 * @param {ProjectConfig} config
 * @param {string[]} ignore
 * @param {string[]} include
 * @returns {Promise<{name: string, path: string, files: string[]}[]>}
 */
async function scanModules(dir, root, config, ignore, include) {
  const modules = [];
  const ignoreDirs = new Set(['node_modules', '.git', 'dist', '__pycache__', '.cache']);

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return modules;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (ignoreDirs.has(entry.name)) continue;
    if (entry.name.startsWith('.')) continue;

    const modPath = path.join(dir, entry.name);
    const modRel = path.relative(root, modPath).replace(/\\/g, '/') || '.';
    if (!matchesIgnoreInclude(modRel, ignore, include)) continue;

    const files = await scanFiles(modPath, root, config, ignore, include);

    if (files.length > 0) {
      modules.push({
        name: entry.name,
        path: modPath,
        files
      });
    }
  }

  return modules;
}

/**
 * Scan files in a module
 * @param {string} dir
 * @param {string} root
 * @param {ProjectConfig} config
 * @param {string[]} ignore
 * @param {string[]} include
 * @returns {Promise<string[]>}
 */
async function scanFiles(dir, root, config, ignore, include) {
  const files = [];
  const pattern = config.src.pattern || '**/*';

  async function walk(d) {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(d, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const rel = path.relative(dir, fullPath).replace(/\\/g, '/');
        const relToRoot = path.relative(root, fullPath).replace(/\\/g, '/');
        if (!matchesIgnoreInclude(relToRoot, ignore, include)) continue;
        if (matchesPattern(pattern, rel)) {
          files.push(rel);
        }
      }
    }
  }

  await walk(dir);
  return files;
}

/**
 * Generate documentation for a module
 * @param {{name: string, path: string, files: string[]}} mod
 * @param {ProjectConfig} config
 * @param {any} staleConfig
 * @returns {string}
 */
function generateModuleDoc(mod, config, staleConfig) {
  const lines = [];

  lines.push(`# ${mod.name}\n`);
  lines.push(`Module documentation for \`${mod.name}\`\n`);

  const conventionLines = formatConventions(staleConfig?.conventions);
  if (conventionLines.length > 0) {
    lines.push('## Conventions\n');
    lines.push(...conventionLines);
    lines.push('');
  }

  lines.push('## Files\n');
  lines.push(`| File | Description |`);
  lines.push(`|------|-------------|`);

  for (const file of mod.files.slice(0, 50)) {
    lines.push(`| \`${file}\` | |`);
  }

  if (mod.files.length > 50) {
    lines.push(`| ... | +${mod.files.length - 50} more files |`);
  }

  lines.push('\n## Usage\n');
  lines.push('```javascript');
  lines.push(`import { ... } from './${mod.name}';`);
  lines.push('```\n');

  return lines.join('\n');
}

/**
 * Generate root documentation
 * @param {{name: string, path: string, files: string[]}[]} modules
 * @param {string} targetDir
 * @param {ProjectConfig} config
 * @param {any} staleConfig
 * @returns {string}
 */
function generateRootDoc(modules, targetDir, config, staleConfig) {
  const lines = [];

  lines.push(`# ${config.name || targetDir}\n`);
  lines.push(`Documentation index for \`${targetDir}\`\n`);

  const conventionLines = formatConventions(staleConfig?.conventions);
  if (conventionLines.length > 0) {
    lines.push('## Conventions\n');
    lines.push(...conventionLines);
    lines.push('');
  }

  lines.push('## Modules\n');
  lines.push(`| Module | Files | Description |`);
  lines.push(`|--------|:---:|-------------|`);

  for (const mod of modules) {
    lines.push(`| [\`${mod.name}\`](./${mod.name}/CLAUDE.md) | ${mod.files.length} | |`);
  }

  lines.push(`\n**Total**: ${modules.length} modules, ${modules.reduce((s, m) => s + m.files.length, 0)} files\n`);

  return lines.join('\n');
}

/**
 * Check for stale documentation
 * @param {{root: string, config: ProjectConfig}} ctx
 * @param {object} args
 */
export async function checkStale(ctx, args) {
  const { root, config } = ctx;
  const staleConfig = ctx.staleConfig || await loadStaleConfig(root, config);
  const ignore = staleConfig?.ignore || [];
  const include = staleConfig?.include || [];

  const normalizedType = normalizeCheckType(args.type);
  if (!normalizedType) {
    console.error(`Invalid --type value: ${args.type}. Expected doc|claude|audit|test|all.`);
    process.exitCode = 1;
    return;
  }
  const typesToCheck = normalizedType === 'all'
    ? ['claude', 'audit', 'test']
    : [normalizedType];

  const staleOnly = Boolean(args['stale-only']);

  const targetDir = args._[2] || config.src.dirs[0];
  if (!targetDir) {
    console.error('No target directory specified.');
    process.exitCode = 1;
    return;
  }

  const absDir = path.join(root, targetDir);

  const results = {};

  for (const type of typesToCheck) {
    if (type === 'test') {
      const testMap = await loadTestMap(root, config);
      if (!testMap) {
        results.test = [];
        continue;
      }
      results.test = await testMapToStaleResults(testMap, {
        root,
        config,
        ignore,
        include,
        scopeDir: targetDir,
        scopeAbsDir: absDir
      });
      continue;
    }

    const docName = DOC_TYPES[type];
    results[type] = await collectDocResults(absDir, root, docName, ignore, include);
  }

  // Apply --stale-only filtering (test includes missing, docs only stale)
  for (const type of Object.keys(results)) {
    if (!staleOnly) continue;
    if (type === 'test') {
      results[type] = results[type].filter(r => r.status !== 'fresh');
    } else {
      results[type] = results[type].filter(r => r.status === 'stale');
    }
  }

  const report = buildStaleReport({ results, typesToCheck, staleOnly, scope: targetDir });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }

  // Human-readable output
  if (typesToCheck.length === 1) {
    const t = typesToCheck[0];
    if (t === 'test') {
      displayTestResults(results.test || [], absDir);
    } else {
      displayDocResults(results[t] || [], DOC_TYPES[t], absDir);
    }
    return report;
  }

  const sections = [
    { type: 'claude', title: DOC_TYPES.claude },
    { type: 'audit', title: DOC_TYPES.audit },
    { type: 'test', title: 'Test Coverage' }
  ];

  for (const section of sections) {
    if (!typesToCheck.includes(section.type)) continue;
    console.log(`=== ${section.title} ===`);
    if (section.type === 'test') {
      displayTestResults(results.test || [], absDir);
    } else {
      displayDocResults(results[section.type] || [], DOC_TYPES[section.type], absDir);
    }
    console.log('');
  }

  return report;
}

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
  'venv', '.venv', 'target', 'vendor', '.cache', 'coverage',
  '.turbo', '.nuxt', '.output', 'out'
]);

const CODE_EXTENSIONS = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.rb', '.php',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.swift', '.vue', '.svelte'
]);

const DOC_FILENAMES = new Set(['CLAUDE.md', 'AUDIT.md']);

const DOC_TYPES = {
  claude: 'CLAUDE.md',
  audit: 'AUDIT.md'
};

/**
 * @typedef {'fresh' | 'stale' | 'missing'} StaleStatus
 * @typedef {{path: string, mtime: Date}} FileInfo
 * @typedef {{
 *   path: string,
 *   status: StaleStatus,
 *   docMtime?: Date|null,
 *   codeMtime?: Date|null,
 *   newestFile?: string|null,
 *   changedFiles?: FileInfo[]
 * }} DocCheckResult
 *
 * @typedef {{
 *   path: string,
 *   status: StaleStatus,
 *   coverage: string,
 *   stats: {covered: number, stale: number, untested: number, total: number},
 *   changedFiles: Array<{path: string, mtime: any}>,
 *   untestedFiles: Array<{path: string, mtime: any}>
 * }} TestCheckResult
 */

function normalizeCheckType(typeArg) {
  if (!typeArg) return 'claude';
  const normalized = String(typeArg).trim().toLowerCase();
  if (normalized === 'doc' || normalized === 'claude') return 'claude';
  if (normalized === 'audit') return 'audit';
  if (normalized === 'test') return 'test';
  if (normalized === 'all') return 'all';
  return null;
}

function normalizeRel(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function isWithinScope(relPath, scopeDir) {
  const rel = normalizeRel(relPath);
  const scope = normalizeRel(scopeDir);
  if (!scope || scope === '.') return true;
  return rel === scope || rel.startsWith(scope + '/');
}

async function findDocDirs(dirAbs, root, docName, ignore, include) {
  const results = [];

  let entries;
  try {
    entries = await fs.readdir(dirAbs, { withFileTypes: true });
  } catch {
    return results;
  }

  let hasDoc = false;
  for (const entry of entries) {
    if (entry.isFile() && entry.name === docName) {
      hasDoc = true;
      break;
    }
  }

  if (hasDoc) {
    const dirRel = path.relative(root, dirAbs).replace(/\\/g, '/') || '.';
    if (matchesIgnoreInclude(dirRel, ignore, include)) {
      results.push(dirAbs);
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (IGNORE_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith('.')) continue;

    const fullPath = path.join(dirAbs, entry.name);
    const dirRel = path.relative(root, fullPath).replace(/\\/g, '/') || '.';
    if (!matchesIgnoreInclude(dirRel, ignore, [])) continue;

    const sub = await findDocDirs(fullPath, root, docName, ignore, include);
    results.push(...sub);
  }

  return results;
}

async function getMaxCodeMtime(dirAbs, docMtime, root, ignore, include, docName) {
  let maxMtime = null;
  let maxFile = null;
  /** @type {FileInfo[]} */
  const changedFiles = [];

  let entries;
  try {
    entries = await fs.readdir(dirAbs, { withFileTypes: true });
  } catch {
    return { mtime: null, file: null, changedFiles };
  }

  for (const entry of entries) {
    const fullPath = path.join(dirAbs, entry.name);

    if (entry.isFile()) {
      if (DOC_FILENAMES.has(entry.name)) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!CODE_EXTENSIONS.has(ext)) continue;

      const relToRoot = path.relative(root, fullPath).replace(/\\/g, '/');
      if (!matchesIgnoreInclude(relToRoot, ignore, include)) continue;

      const stat = await fs.stat(fullPath).catch(() => null);
      if (!stat) continue;

      if (!maxMtime || stat.mtime > maxMtime) {
        maxMtime = stat.mtime;
        maxFile = fullPath;
      }

      if (docMtime && stat.mtime > docMtime) {
        changedFiles.push({ path: relToRoot, mtime: stat.mtime });
      }

      continue;
    }

    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.')) continue;

      const dirRel = path.relative(root, fullPath).replace(/\\/g, '/') || '.';
      if (!matchesIgnoreInclude(dirRel, ignore, [])) continue;

      // If subdir has its own doc, it is tracked separately.
      const subDocPath = path.join(fullPath, docName);
      try {
        await fs.access(subDocPath);
        continue;
      } catch {
        // continue
      }

      const sub = await getMaxCodeMtime(fullPath, docMtime, root, ignore, include, docName);
      if (sub.mtime && (!maxMtime || sub.mtime > maxMtime)) {
        maxMtime = sub.mtime;
        maxFile = sub.file;
      }
      changedFiles.push(...sub.changedFiles);
    }
  }

  return { mtime: maxMtime, file: maxFile, changedFiles };
}

async function checkDocStaleness(dirAbs, root, docName, ignore, include) {
  const docPath = path.join(dirAbs, docName);
  const dirRel = path.relative(root, dirAbs).replace(/\\/g, '/') || '.';

  try {
    const docStat = await fs.stat(docPath);
    const { mtime: codeMtime, file: newestFile, changedFiles } = await getMaxCodeMtime(
      dirAbs,
      docStat.mtime,
      root,
      ignore,
      include,
      docName
    );

    if (!codeMtime) {
      return {
        path: dirRel,
        status: 'fresh',
        docMtime: docStat.mtime,
        codeMtime: null,
        newestFile: null,
        changedFiles: []
      };
    }

    const isStale = codeMtime > docStat.mtime;
    changedFiles.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    return {
      path: dirRel,
      status: isStale ? 'stale' : 'fresh',
      docMtime: docStat.mtime,
      codeMtime,
      newestFile: newestFile ? path.relative(root, newestFile).replace(/\\/g, '/') : null,
      changedFiles
    };
  } catch {
    return {
      path: dirRel,
      status: 'missing',
      docMtime: null,
      codeMtime: null,
      newestFile: null,
      changedFiles: []
    };
  }
}

async function collectDocResults(scopeAbsDir, root, docName, ignore, include) {
  const docDirs = await findDocDirs(scopeAbsDir, root, docName, ignore, include);
  /** @type {DocCheckResult[]} */
  const results = [];

  for (const dirAbs of docDirs) {
    const dirRel = path.relative(root, dirAbs).replace(/\\/g, '/') || '.';
    if (!matchesIgnoreInclude(dirRel, ignore, include)) continue;
    results.push(await checkDocStaleness(dirAbs, root, docName, ignore, include));
  }

  results.sort((a, b) => {
    const order = { stale: 0, missing: 1, fresh: 2 };
    return order[a.status] - order[b.status];
  });

  return results;
}

async function loadTestMap(root, config) {
  const candidates = [path.join(root, '.test-map.json')];
  const cacheDirRaw = config?.cache || '.project-index';
  const cacheDir = path.isAbsolute(cacheDirRaw) ? cacheDirRaw : path.join(root, cacheDirRaw);
  candidates.push(path.join(cacheDir, '.test-map.json'));

  for (const p of candidates) {
    try {
      const content = await fs.readFile(p, 'utf8');
      return JSON.parse(content);
    } catch {
      // try next
    }
  }
  return null;
}

async function testMapToStaleResults(testMap, { root, config, ignore, include, scopeDir, scopeAbsDir }) {
  if (testMap?.modules && typeof testMap.modules === 'object') {
    return testMapModulesToResults(testMap, { ignore, include, scopeDir });
  }
  return testMapFlatToResults(testMap, { root, config, ignore, include, scopeDir, scopeAbsDir });
}

function testMapModulesToResults(testMap, { ignore, include, scopeDir }) {
  if (!testMap?.modules) return [];

  /** @type {TestCheckResult[]} */
  const results = [];

  for (const [modulePathRaw, data] of Object.entries(testMap.modules)) {
    const modulePath = normalizeRel(modulePathRaw);
    if (!isWithinScope(modulePath, scopeDir)) continue;
    if (!matchesIgnoreInclude(modulePath, ignore, include)) continue;

    const filesObj = (data && typeof data === 'object') ? (data.files || {}) : {};

    const staleFiles = Object.entries(filesObj)
      .filter(([, f]) => f && f.status === 'stale')
      .map(([, f]) => ({ path: normalizeRel(f.path), mtime: null }));

    const untestedFiles = Object.entries(filesObj)
      .filter(([, f]) => f && f.status === 'untested')
      .map(([, f]) => ({ path: normalizeRel(f.path), mtime: null }));

    const covered = Number(data?.covered || 0);
    const stale = Number(data?.stale || 0);
    const untested = Number(data?.untested || 0);
    const total = Number(data?.total || 0);

    const isStale = stale > 0;
    const isMissing = untested > 0 && covered === 0;

    results.push({
      path: modulePath,
      status: isMissing ? 'missing' : (isStale ? 'stale' : 'fresh'),
      coverage: String(data?.coverage || '0.0%'),
      stats: { covered, stale, untested, total },
      changedFiles: staleFiles,
      untestedFiles
    });
  }

  results.sort((a, b) => {
    const order = { missing: 0, stale: 1, fresh: 2 };
    return order[a.status] - order[b.status];
  });

  return results;
}

async function testMapFlatToResults(testMap, { root, config, ignore, include, scopeDir, scopeAbsDir }) {
  const srcToTest = testMap?.srcToTest && typeof testMap.srcToTest === 'object'
    ? testMap.srcToTest
    : {};

  // Collect source files within scope, then classify as covered/stale/untested.
  const scopeSources = await scanFiles(scopeAbsDir, root, config, ignore, include);
  const sourceFiles = scopeSources
    .map(rel => path.relative(root, path.join(scopeAbsDir, rel)).replace(/\\/g, '/'))
    .filter(rel => rel && !rel.includes('.test.') && !rel.includes('.spec.'));

  const statCache = new Map();
  async function getMtimeMs(absPath) {
    if (statCache.has(absPath)) return statCache.get(absPath);
    const stat = await fs.stat(absPath).catch(() => null);
    const val = stat ? stat.mtimeMs : null;
    statCache.set(absPath, val);
    return val;
  }

  /** @type {Map<string, {total: number, covered: number, stale: number, untested: number, staleFiles: any[], untestedFiles: any[]}>} */
  const perModule = new Map();

  const scopePrefix = normalizeRel(scopeDir);

  for (const srcRel of sourceFiles) {
    if (!isWithinScope(srcRel, scopePrefix)) continue;
    if (!matchesIgnoreInclude(srcRel, ignore, include)) continue;

    const modulePath = inferModulePath(srcRel, scopePrefix);
    const bucket = perModule.get(modulePath) || {
      total: 0,
      covered: 0,
      stale: 0,
      untested: 0,
      staleFiles: [],
      untestedFiles: []
    };
    bucket.total++;

    const testRelRaw = srcToTest[srcRel];
    const testRel = typeof testRelRaw === 'string' ? normalizeRel(testRelRaw) : null;

    if (!testRel) {
      bucket.untested++;
      bucket.untestedFiles.push({ path: srcRel, mtime: null });
      perModule.set(modulePath, bucket);
      continue;
    }

    const srcMtime = await getMtimeMs(path.join(root, srcRel));
    const testMtime = await getMtimeMs(path.join(root, testRel));

    if (testMtime === null) {
      bucket.untested++;
      bucket.untestedFiles.push({ path: srcRel, mtime: null });
      perModule.set(modulePath, bucket);
      continue;
    }

    if (srcMtime !== null && srcMtime > testMtime) {
      bucket.stale++;
      bucket.staleFiles.push({ path: srcRel, mtime: null });
    } else {
      bucket.covered++;
    }

    perModule.set(modulePath, bucket);
  }

  /** @type {TestCheckResult[]} */
  const results = [];
  for (const [modulePath, stats] of perModule) {
    const coverage = stats.total > 0
      ? `${((stats.covered / stats.total) * 100).toFixed(1)}%`
      : '0.0%';
    const status = (stats.untested > 0 && stats.covered === 0)
      ? 'missing'
      : (stats.stale > 0 ? 'stale' : 'fresh');

    results.push({
      path: modulePath,
      status,
      coverage,
      stats: { covered: stats.covered, stale: stats.stale, untested: stats.untested, total: stats.total },
      changedFiles: stats.staleFiles,
      untestedFiles: stats.untestedFiles
    });
  }

  results.sort((a, b) => {
    const order = { missing: 0, stale: 1, fresh: 2 };
    return order[a.status] - order[b.status];
  });

  return results;
}

function inferModulePath(sourceRel, scopePrefix) {
  const rel = normalizeRel(sourceRel);
  const scope = normalizeRel(scopePrefix);

  if (!scope || scope === '.') {
    const parts = rel.split('/');
    return parts.length > 1 ? parts[0] : '.';
  }

  if (!rel.startsWith(scope + '/')) return scope;
  const rest = rel.slice(scope.length + 1);
  if (!rest.includes('/')) return scope; // file directly under scope
  const first = rest.split('/')[0];
  return `${scope}/${first}`;
}

function formatDate(date) {
  if (!date) return 'N/A';
  try {
    return new Date(date).toISOString().split('T')[0];
  } catch {
    return 'N/A';
  }
}

function buildStaleReport({ results, typesToCheck, staleOnly, scope }) {
  const summary = {};

  for (const t of typesToCheck) {
    const arr = results[t] || [];
    if (t === 'test') {
      const stale = arr.filter(r => r.status === 'stale').length;
      const missing = arr.filter(r => r.status === 'missing').length;
      const fresh = arr.filter(r => r.status === 'fresh').length;

      const totalFiles = arr.reduce((sum, r) => sum + (r.stats?.total || 0), 0);
      const coveredFiles = arr.reduce((sum, r) => sum + (r.stats?.covered || 0), 0);
      const staleFiles = arr.reduce((sum, r) => sum + (r.stats?.stale || 0), 0);
      const untestedFiles = arr.reduce((sum, r) => sum + (r.stats?.untested || 0), 0);

      summary[t] = {
        modules: arr.length,
        stale,
        missing,
        fresh,
        files: {
          total: totalFiles,
          covered: coveredFiles,
          stale: staleFiles,
          untested: untestedFiles
        }
      };
      continue;
    }

    summary[t] = {
      total: arr.length,
      stale: arr.filter(r => r.status === 'stale').length,
      fresh: arr.filter(r => r.status === 'fresh').length,
      missing: arr.filter(r => r.status === 'missing').length
    };
  }

  return {
    timestamp: new Date().toISOString(),
    scope: normalizeRel(scope) || '.',
    staleOnly: Boolean(staleOnly),
    types: typesToCheck,
    results,
    summary
  };
}

function displayDocResults(results, docName, scopeAbsDir) {
  const scopeDisplay = scopeAbsDir;
  console.log(`Checking ${docName} freshness in: ${scopeDisplay}\n`);

  const staleCount = results.filter(r => r.status === 'stale').length;
  const freshCount = results.filter(r => r.status === 'fresh').length;
  const missingCount = results.filter(r => r.status === 'missing').length;

  for (const r of results) {
    const pathDisplay = String(r.path).padEnd(40);

    if (r.status === 'stale') {
      console.log(`STALE   ${pathDisplay} (code: ${formatDate(r.codeMtime)}, doc: ${formatDate(r.docMtime)})`);
      if (Array.isArray(r.changedFiles) && r.changedFiles.length > 0) {
        const maxShow = 5;
        const files = r.changedFiles.slice(0, maxShow);
        for (const f of files) {
          console.log(`        - ${f.path} (${formatDate(f.mtime)})`);
        }
        if (r.changedFiles.length > maxShow) {
          console.log(`        - ... and ${r.changedFiles.length - maxShow} more files`);
        }
      }
    } else if (r.status === 'fresh') {
      console.log(`FRESH   ${pathDisplay} (doc: ${formatDate(r.docMtime)})`);
    } else {
      console.log(`MISSING ${pathDisplay}`);
    }
  }

  console.log(`\n${'-'.repeat(60)}`);
  console.log(`Total: ${results.length} | Stale: ${staleCount} | Fresh: ${freshCount} | Missing: ${missingCount}`);
}

function displayTestResults(results, scopeAbsDir) {
  const scopeDisplay = scopeAbsDir;
  console.log(`Checking test coverage in: ${scopeDisplay}\n`);

  const staleCount = results.filter(r => r.status === 'stale').length;
  const missingCount = results.filter(r => r.status === 'missing').length;
  const freshCount = results.filter(r => r.status === 'fresh').length;

  for (const r of results) {
    const pathDisplay = String(r.path).padEnd(35);
    const stats = r.stats || {};

    if (r.status === 'missing') {
      console.log(`MISSING ${pathDisplay} ${r.coverage} (untested: ${stats.untested || 0})`);
    } else if (r.status === 'stale') {
      console.log(`STALE   ${pathDisplay} ${r.coverage} (stale: ${stats.stale || 0}, untested: ${stats.untested || 0})`);
      if (Array.isArray(r.changedFiles) && r.changedFiles.length > 0) {
        const maxShow = 3;
        const files = r.changedFiles.slice(0, maxShow);
        for (const f of files) {
          console.log(`        - ${path.basename(String(f.path))}`);
        }
        if (r.changedFiles.length > maxShow) {
          console.log(`        - ... +${r.changedFiles.length - maxShow} more stale`);
        }
      }
    } else {
      console.log(`FRESH   ${pathDisplay} ${r.coverage} (covered: ${stats.covered || 0}/${stats.total || 0})`);
    }
  }

  const totalStale = results.reduce((sum, r) => sum + (r.stats?.stale || 0), 0);
  const totalUntested = results.reduce((sum, r) => sum + (r.stats?.untested || 0), 0);
  const totalCovered = results.reduce((sum, r) => sum + (r.stats?.covered || 0), 0);
  const totalFiles = results.reduce((sum, r) => sum + (r.stats?.total || 0), 0);

  console.log(`\n${'-'.repeat(60)}`);
  console.log(`Modules: ${results.length} | Stale: ${staleCount} | Missing: ${missingCount} | Fresh: ${freshCount}`);
  console.log(`Files: ${totalFiles} | Covered: ${totalCovered} | Stale: ${totalStale} | Untested: ${totalUntested}`);
}

/**
 * Render conventions object into markdown lines.
 * @param {any} conventions
 * @returns {string[]}
 */
function formatConventions(conventions) {
  if (!conventions || typeof conventions !== 'object') return [];

  const lines = [];

  const scalarKeys = [
    ['language', 'Language'],
    ['runtime', 'Runtime'],
    ['moduleSystem', 'Module System']
  ];

  for (const [key, label] of scalarKeys) {
    const val = conventions[key];
    if (typeof val === 'string' && val.trim()) {
      lines.push(`- ${label}: ${val.trim()}`);
    }
  }

  const listKeys = [
    ['codeStyle', 'Code Style'],
    ['jsDocRules', 'JSDoc Rules'],
    ['errorHandling', 'Error Handling']
  ];

  for (const [key, label] of listKeys) {
    const items = conventions[key];
    if (!Array.isArray(items) || items.length === 0) continue;
    lines.push(`- ${label}:`);
    for (const item of items) {
      if (typeof item === 'string' && item.trim()) {
        lines.push(`  - ${item.trim()}`);
      }
    }
  }

  return lines;
}
