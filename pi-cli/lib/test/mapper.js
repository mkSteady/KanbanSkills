/**
 * Test mapper - builds source-to-test file mappings
 * Uses naming conventions and import analysis
 */

import { promises as fs } from 'fs';
import path from 'path';
import { readJsonSafe, writeJsonSafe, matchesPattern } from '../shared.js';
import { getCachePath } from '../context.js';

/** @typedef {import('../types.js').ProjectConfig} ProjectConfig */

/**
 * Build test map based on naming conventions
 * @param {{root: string, config: ProjectConfig}} ctx
 * @param {object} args
 */
export async function buildTestMap(ctx, args) {
  const { root, config } = ctx;
  const testNaming = config.conventions?.testNaming || '{name}.test.js';

  // Scan source files
  const sourceFiles = await scanDir(root, config.src.dirs, config.src.pattern, config.src.ignore);

  // Scan test files
  const testFiles = await scanDir(root, config.test.dirs, config.test.pattern, []);

  // Build mappings
  const srcToTest = new Map();
  const testToSrc = new Map();

  for (const srcFile of sourceFiles) {
    const testFile = inferTestFile(srcFile, testNaming, config);
    if (testFiles.has(testFile)) {
      srcToTest.set(srcFile, testFile);
      testToSrc.set(testFile, srcFile);
    }
  }

  // Also analyze imports to find additional mappings
  for (const testFile of testFiles) {
    if (testToSrc.has(testFile)) continue;

    const absPath = path.join(root, testFile);
    let content;
    try {
      content = await fs.readFile(absPath, 'utf8');
    } catch {
      continue;
    }

    const imports = parseImports(content, config.language);
    for (const imp of imports) {
      const resolved = resolveImport(imp, testFile, root, sourceFiles, config.language);
      if (resolved && !testToSrc.has(testFile)) {
        testToSrc.set(testFile, resolved);
        if (!srcToTest.has(resolved)) {
          srcToTest.set(resolved, testFile);
        }
      }
    }
  }

  const map = {
    version: 1,
    generated: new Date().toISOString(),
    testNaming,
    srcToTest: Object.fromEntries(srcToTest),
    testToSrc: Object.fromEntries(testToSrc),
    stats: {
      sourceFiles: sourceFiles.size,
      testFiles: testFiles.size,
      mappedPairs: srcToTest.size,
      unmappedTests: testFiles.size - testToSrc.size
    }
  };

  const cachePath = getCachePath(config, root, '.test-map.json');
  await writeJsonSafe(cachePath, map);

  if (args.json) {
    console.log(JSON.stringify(map, null, 2));
  } else {
    console.log(`Test map: ${map.stats.mappedPairs} pairs (${map.stats.sourceFiles} src, ${map.stats.testFiles} tests)`);
    if (map.stats.unmappedTests > 0) {
      console.log(`  ${map.stats.unmappedTests} tests without source mapping`);
    }
  }

  return map;
}

/**
 * Scan directories for files matching pattern
 * @param {string} root
 * @param {string[]} dirs
 * @param {string} pattern
 * @param {string[]} ignore
 * @returns {Promise<Set<string>>}
 */
async function scanDir(root, dirs, pattern, ignore) {
  const files = new Set();
  const ignoreSet = new Set([
    'node_modules', '.git', 'dist', 'build', '__pycache__',
    'venv', '.venv', 'target', 'vendor', '.cache'
  ]);

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(root, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        if (ignoreSet.has(entry.name)) continue;
        if (ignore?.some(p => matchesPattern(p, entry.name))) continue;
        await walk(fullPath);
      } else if (entry.isFile()) {
        if (matchesPattern(pattern, relPath)) {
          if (!ignore?.some(p => matchesPattern(p, relPath))) {
            files.add(relPath);
          }
        }
      }
    }
  }

  for (const d of dirs || []) {
    await walk(path.join(root, d));
  }

  return files;
}

/**
 * Infer test file path from source file
 * @param {string} srcFile
 * @param {string} naming
 * @param {ProjectConfig} config
 * @returns {string}
 */
function inferTestFile(srcFile, naming, config) {
  const parsed = path.parse(srcFile);
  const baseName = parsed.name;

  // Apply naming pattern
  const testName = naming
    .replace('{name}', baseName)
    .replace('{ext}', parsed.ext.slice(1));

  // Map src dir to test dir
  let testPath = srcFile;
  for (const srcDir of config.src.dirs) {
    if (srcFile.startsWith(srcDir)) {
      const relativePath = srcFile.slice(srcDir.length + 1);
      const testDir = config.test.dirs[0] || 'tests';
      testPath = path.join(testDir, path.dirname(relativePath), testName).replace(/\\/g, '/');
      break;
    }
  }

  return testPath;
}

/**
 * Parse imports from content
 * @param {string} content
 * @param {string} language
 * @returns {string[]}
 */
function parseImports(content, language) {
  const specs = new Set();

  if (language === 'javascript' || language === 'typescript') {
    const patterns = [
      /\bimport\s+(?:type\s+)?[\w*\s{},$]+\sfrom\s*['"]([^'"]+)['"]/g,
      /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(content)) !== null) {
        if (m[1]) specs.add(m[1]);
      }
    }
  } else if (language === 'python') {
    const patterns = [
      /^\s*from\s+([\w.]+)\s+import/gm,
      /^\s*import\s+([\w.]+)/gm
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(content)) !== null) {
        if (m[1]) specs.add(m[1]);
      }
    }
  }

  return [...specs];
}

/**
 * Resolve import to source file
 * @param {string} spec
 * @param {string} fromFile
 * @param {string} root
 * @param {Set<string>} sourceFiles
 * @param {string} language
 * @returns {string|null}
 */
function resolveImport(spec, fromFile, root, sourceFiles, language) {
  if (!spec.startsWith('.')) return null;

  const fromAbs = path.join(root, fromFile);
  const base = path.resolve(path.dirname(fromAbs), spec);

  const exts = language === 'typescript'
    ? ['.ts', '.tsx', '.js', '.jsx']
    : language === 'python'
    ? ['.py']
    : ['.js', '.mjs', '.jsx'];

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
    const rel = path.relative(root, abs).replace(/\\/g, '/');
    if (sourceFiles.has(rel)) return rel;
  }

  return null;
}
