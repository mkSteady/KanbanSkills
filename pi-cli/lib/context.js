/**
 * Project context loader
 * Loads and validates .pi-config.json, provides project-aware defaults
 */

import { promises as fs } from 'fs';
import path from 'path';
import { findProjectRoot, readJsonSafe, writeJsonSafe } from './shared.js';

/** @typedef {import('./types.js').ProjectConfig} ProjectConfig */

const CONFIG_FILE = '.pi-config.json';
const DEFAULT_CACHE_DIR = '.project-index';
const STALE_CONFIG_FILE = '.stale-config.json';

/**
 * Default config template (minimal skeleton)
 * @returns {ProjectConfig}
 */
export function createDefaultConfig() {
  return {
    name: '',
    language: 'unknown',
    src: {
      dirs: [],
      pattern: '**/*',
      ignore: ['node_modules', 'dist', '.git', 'vendor', '__pycache__']
    },
    test: {
      dirs: [],
      pattern: '',
      cmd: '',
      framework: 'unknown'
    },
    cache: DEFAULT_CACHE_DIR,
    conventions: {},
    llm: {}
  };
}

/**
 * Detect project language from files
 * @param {string} projectRoot
 * @returns {Promise<{language: string, hints: object}>}
 */
export async function detectLanguage(projectRoot) {
  const markers = [
    { file: 'package.json', language: 'javascript', framework: 'node' },
    { file: 'tsconfig.json', language: 'typescript', framework: 'node' },
    { file: 'pyproject.toml', language: 'python', framework: 'poetry' },
    { file: 'setup.py', language: 'python', framework: 'setuptools' },
    { file: 'requirements.txt', language: 'python', framework: 'pip' },
    { file: 'go.mod', language: 'go', framework: 'go' },
    { file: 'Cargo.toml', language: 'rust', framework: 'cargo' },
    { file: 'pom.xml', language: 'java', framework: 'maven' },
    { file: 'build.gradle', language: 'java', framework: 'gradle' },
    { file: 'Gemfile', language: 'ruby', framework: 'bundler' },
    { file: 'composer.json', language: 'php', framework: 'composer' }
  ];

  const hints = { files: [], packageManager: null, testFramework: null };

  for (const m of markers) {
    try {
      await fs.access(path.join(projectRoot, m.file));
      hints.files.push(m.file);

      // First match wins for language
      if (!hints.language) {
        hints.language = m.language;
        hints.framework = m.framework;
      }
    } catch {
      // file not found
    }
  }

  // Detect package manager for JS
  if (hints.language === 'javascript' || hints.language === 'typescript') {
    const pmFiles = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'package-lock.json'];
    for (const pm of pmFiles) {
      try {
        await fs.access(path.join(projectRoot, pm));
        hints.packageManager = pm.split('-')[0].split('.')[0]; // pnpm, yarn, bun, package -> npm
        if (hints.packageManager === 'package') hints.packageManager = 'npm';
        break;
      } catch {
        // continue
      }
    }
  }

  return {
    language: hints.language || 'unknown',
    hints
  };
}

/**
 * Detect test framework from config files
 * @param {string} projectRoot
 * @param {string} language
 * @returns {Promise<{framework: string, cmd: string, pattern: string}>}
 */
export async function detectTestFramework(projectRoot, language) {
  const detectors = {
    javascript: [
      { file: 'vitest.config.js', framework: 'vitest', cmd: 'vitest run', pattern: '**/*.test.js' },
      { file: 'vitest.config.ts', framework: 'vitest', cmd: 'vitest run', pattern: '**/*.test.ts' },
      { file: 'jest.config.js', framework: 'jest', cmd: 'jest', pattern: '**/*.test.js' },
      { file: 'jest.config.ts', framework: 'jest', cmd: 'jest', pattern: '**/*.test.ts' }
    ],
    typescript: [
      { file: 'vitest.config.ts', framework: 'vitest', cmd: 'vitest run', pattern: '**/*.test.ts' },
      { file: 'jest.config.ts', framework: 'jest', cmd: 'jest', pattern: '**/*.test.ts' }
    ],
    python: [
      { file: 'pytest.ini', framework: 'pytest', cmd: 'pytest', pattern: '**/test_*.py' },
      { file: 'pyproject.toml', framework: 'pytest', cmd: 'pytest', pattern: '**/test_*.py' },
      { file: 'setup.cfg', framework: 'pytest', cmd: 'pytest', pattern: '**/test_*.py' }
    ],
    go: [
      { file: 'go.mod', framework: 'go', cmd: 'go test ./...', pattern: '**/*_test.go' }
    ],
    rust: [
      { file: 'Cargo.toml', framework: 'cargo', cmd: 'cargo test', pattern: '**/tests/**/*.rs' }
    ]
  };

  const checks = detectors[language] || [];

  for (const check of checks) {
    try {
      await fs.access(path.join(projectRoot, check.file));
      return {
        framework: check.framework,
        cmd: check.cmd,
        pattern: check.pattern
      };
    } catch {
      // continue
    }
  }

  return { framework: 'unknown', cmd: '', pattern: '' };
}

/**
 * Initialize a new config file
 * @param {string} projectRoot
 * @param {object} options
 * @returns {Promise<ProjectConfig>}
 */
export async function initConfig(projectRoot, options = {}) {
  const configPath = path.join(projectRoot, CONFIG_FILE);

  // Check if already exists
  const existing = await readJsonSafe(configPath);
  if (existing && !options.force) {
    return existing;
  }

  const config = createDefaultConfig();
  config.name = path.basename(projectRoot);

  // Auto-detect language
  const { language, hints } = await detectLanguage(projectRoot);
  config.language = language;

  // Auto-detect test framework
  const testInfo = await detectTestFramework(projectRoot, language);
  config.test.framework = testInfo.framework;
  config.test.pattern = testInfo.pattern;

  // Add package manager prefix for JS
  if (hints.packageManager && testInfo.cmd) {
    config.test.cmd = `${hints.packageManager} ${testInfo.cmd}`;
  } else {
    config.test.cmd = testInfo.cmd;
  }

  // Save minimal config (AI will fill in the rest)
  await writeJsonSafe(configPath, config);

  return config;
}

/**
 * Load project config
 * @param {string} [startDir]
 * @returns {Promise<{root: string, config: ProjectConfig, configPath: string}>}
 */
export async function loadContext(startDir = process.cwd()) {
  const root = await findProjectRoot(startDir);
  const configPath = path.join(root, CONFIG_FILE);

  let config = await readJsonSafe(configPath);

  if (!config) {
    // No config found, return defaults with detected info
    config = createDefaultConfig();
    config.name = path.basename(root);
    const { language } = await detectLanguage(root);
    config.language = language;
  }

  // Ensure cache dir is absolute
  if (config.cache && !path.isAbsolute(config.cache)) {
    config.cache = path.join(root, config.cache);
  }

  const staleConfig = await loadStaleConfig(root, config);

  return { root, config, configPath, staleConfig };
}

/**
 * Update config file (merge with existing)
 * @param {string} configPath
 * @param {Partial<ProjectConfig>} updates
 * @returns {Promise<ProjectConfig>}
 */
export async function updateConfig(configPath, updates) {
  const existing = await readJsonSafe(configPath, {});
  const merged = deepMerge(existing, updates);
  await writeJsonSafe(configPath, merged);
  return merged;
}

/**
 * Deep merge objects
 * @param {object} target
 * @param {object} source
 * @returns {object}
 */
function deepMerge(target, source) {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }

  return result;
}

/**
 * Validate config has required fields for an operation
 * @param {ProjectConfig} config
 * @param {string} operation
 * @returns {{valid: boolean, missing: string[]}}
 */
export function validateConfig(config, operation) {
  const requirements = {
    test: ['test.dirs', 'test.cmd', 'test.pattern'],
    deps: ['src.dirs', 'src.pattern'],
    audit: ['src.dirs'],
    doc: ['src.dirs']
  };

  const required = requirements[operation] || [];
  const missing = [];

  for (const field of required) {
    const parts = field.split('.');
    let value = config;
    for (const p of parts) {
      value = value?.[p];
    }
    if (!value || (Array.isArray(value) && value.length === 0)) {
      missing.push(field);
    }
  }

  return { valid: missing.length === 0, missing };
}

/**
 * Get cache file path
 * @param {ProjectConfig} config
 * @param {string} root
 * @param {string} name
 * @returns {string}
 */
export function getCachePath(config, root, name) {
  const cacheDir = config.cache || path.join(root, DEFAULT_CACHE_DIR);
  return path.join(cacheDir, name);
}

/**
 * Default stale config template (compatible with .project-index/.stale-config.json)
 * @returns {any}
 */
function createDefaultStaleConfig() {
  return {
    ignore: [],
    include: [],
    features: {},
    notify: {
      enabled: true,
      threshold: 3,
      onSessionStart: true
    },
    conventions: {},
    security: {
      severity: ['critical', 'high', 'medium', 'low'],
      critical: [],
      high: [],
      medium: [],
      low: [],
      browserSpecific: [],
      maxCyclomatic: 12
    },
    testing: {
      coverage: { target: 0, minimum: 0, focus: [] },
      qualityRules: [],
      antiPatterns: [],
      boundaryConditions: [],
      mustTest: []
    },
    directoryRules: {},
    concurrency: 0,
    timeout: 0
  };
}

/**
 * Load stale config from "{cache}/.stale-config.json" with root fallback.
 * @param {string} root
 * @param {ProjectConfig} config
 * @returns {Promise<any>}
 */
export async function loadStaleConfig(root, config) {
  const defaults = createDefaultStaleConfig();

  const cacheDirRaw = config?.cache || DEFAULT_CACHE_DIR;
  const cacheDir = path.isAbsolute(cacheDirRaw)
    ? cacheDirRaw
    : path.join(root, cacheDirRaw);

  // Try cache dir first, then fallback to root (compatible with project-index)
  const candidates = [
    path.join(cacheDir, STALE_CONFIG_FILE),
    path.join(root, STALE_CONFIG_FILE)
  ];

  for (const stalePath of candidates) {
    const loaded = await readJsonSafe(stalePath);
    if (loaded && typeof loaded === 'object') {
      return deepMerge(defaults, loaded);
    }
  }

  return defaults;
}
