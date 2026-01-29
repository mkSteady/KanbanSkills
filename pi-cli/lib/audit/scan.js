/**
 * Code audit scanner
 * Scans for common issues: security, performance, style
 */

import { promises as fs } from 'fs';
import path from 'path';
import { getDirectoryRule, matchesIgnoreInclude, matchesPattern, readJsonSafe, writeJsonSafe } from '../shared.js';
import { getCachePath, loadStaleConfig } from '../context.js';

/** @typedef {import('../types.js').ProjectConfig} ProjectConfig */
/** @typedef {import('../types.js').AuditIssue} AuditIssue */

/**
 * Rule definitions by language
 */
const RULES = {
  javascript: [
    { id: 'no-eval', pattern: /\beval\s*\(/, severity: 'error', message: 'Avoid eval() - security risk' },
    { id: 'no-console', pattern: /\bconsole\.(log|debug|info)\s*\(/, severity: 'warning', message: 'Remove console statements in production' },
    { id: 'no-debugger', pattern: /\bdebugger\b/, severity: 'error', message: 'Remove debugger statements' },
    { id: 'no-alert', pattern: /\balert\s*\(/, severity: 'warning', message: 'Avoid alert() in production' },
    { id: 'no-var', pattern: /\bvar\s+\w/, severity: 'info', message: 'Use const/let instead of var' },
    { id: 'todo-fixme', pattern: /\b(TODO|FIXME|HACK|XXX)\b/, severity: 'info', message: 'Unresolved TODO/FIXME' },
    { id: 'no-secret', pattern: /(password|secret|api_key|apikey)\s*[=:]\s*['"][^'"]+['"]/i, severity: 'error', message: 'Possible hardcoded secret' }
  ],
  typescript: [
    { id: 'no-any', pattern: /:\s*any\b/, severity: 'warning', message: 'Avoid using any type' },
    { id: 'no-ts-ignore', pattern: /@ts-ignore/, severity: 'warning', message: 'Avoid @ts-ignore' }
  ],
  python: [
    { id: 'no-eval', pattern: /\beval\s*\(/, severity: 'error', message: 'Avoid eval() - security risk' },
    { id: 'no-exec', pattern: /\bexec\s*\(/, severity: 'error', message: 'Avoid exec() - security risk' },
    { id: 'no-print', pattern: /\bprint\s*\(/, severity: 'info', message: 'Consider using logging instead of print' },
    { id: 'todo-fixme', pattern: /\b(TODO|FIXME|HACK|XXX)\b/, severity: 'info', message: 'Unresolved TODO/FIXME' }
  ]
};

/**
 * Scan code for issues
 * @param {{root: string, config: ProjectConfig}} ctx
 * @param {object} args
 */
export async function scan(ctx, args) {
  const { root, config } = ctx;
  const staleConfig = ctx.staleConfig || await loadStaleConfig(root, config);
  const ignore = staleConfig?.ignore || [];
  const include = staleConfig?.include || [];
  const directoryRules = staleConfig?.directoryRules || {};
  const securityPolicy = staleConfig?.security || {};

  const severity = args.severity || 'warning'; // error, warning, info
  const severityOrder = { error: 0, warning: 1, info: 2 };
  const minSeverity = severityOrder[severity] ?? 1;
  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };

  // Get rules for language
  const langRules = RULES[config.language] || RULES.javascript;
  const tsRules = config.language === 'typescript' ? RULES.typescript : [];
  const allRules = [...langRules, ...tsRules];

  // Scan files
  const issues = [];

  for (const srcDir of config.src.dirs) {
    const files = await scanDir(path.join(root, srcDir), config);

    for (const file of files) {
      const projectRel = path.join(srcDir, file).replace(/\\/g, '/');
      if (!matchesIgnoreInclude(projectRel, ignore, include)) continue;

      const absPath = path.join(root, srcDir, file);
      let content;
      try {
        content = await fs.readFile(absPath, 'utf8');
      } catch {
        continue;
      }

      const dirRule = getDirectoryRule(projectRel, directoryRules);
      const rulePriority = dirRule?.rule?.priority ? String(dirRule.rule.priority) : null;
      const ruleFocus = Array.isArray(dirRule?.rule?.focus) ? dirRule.rule.focus : null;

      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        for (const rule of allRules) {
          if (severityOrder[rule.severity] > minSeverity) continue;

          if (rule.pattern.test(line)) {
            issues.push({
              file: projectRel,
              line: i + 1,
              severity: rule.severity,
              rule: rule.id,
              message: rule.message,
              snippet: line.trim().slice(0, 80),
              directoryRule: dirRule?.path || null,
              priority: rulePriority,
              focus: ruleFocus
            });
          }
        }
      }
    }
  }

  // Sort by severity, then directory priority
  issues.sort((a, b) => {
    const sevCmp = severityOrder[a.severity] - severityOrder[b.severity];
    if (sevCmp !== 0) return sevCmp;
    const priA = priorityOrder[String(a.priority || '').toLowerCase()] ?? 99;
    const priB = priorityOrder[String(b.priority || '').toLowerCase()] ?? 99;
    if (priA !== priB) return priA - priB;
    if (a.file !== b.file) return String(a.file).localeCompare(String(b.file));
    return (a.line || 0) - (b.line || 0);
  });

  // Save results
  const cachePath = getCachePath(config, root, '.audit-result.json');
  await writeJsonSafe(cachePath, {
    timestamp: new Date().toISOString(),
    issues,
    stats: {
      total: issues.length,
      errors: issues.filter(i => i.severity === 'error').length,
      warnings: issues.filter(i => i.severity === 'warning').length,
      info: issues.filter(i => i.severity === 'info').length
    },
    policy: {
      ignore,
      include,
      directoryRules,
      security: securityPolicy
    }
  });

  if (args.json) {
    console.log(JSON.stringify({ issues, stats: { total: issues.length } }, null, 2));
  } else {
    console.log(`Audit found ${issues.length} issues:\n`);

    const grouped = {};
    for (const issue of issues) {
      if (!grouped[issue.severity]) grouped[issue.severity] = [];
      grouped[issue.severity].push(issue);
    }

    for (const sev of ['error', 'warning', 'info']) {
      const items = grouped[sev] || [];
      if (items.length === 0) continue;

      console.log(`${sev.toUpperCase()} (${items.length}):`);
      for (const item of items.slice(0, 10)) {
        console.log(`  ${item.file}:${item.line} - ${item.message}`);
      }
      if (items.length > 10) {
        console.log(`  ... +${items.length - 10} more\n`);
      } else {
        console.log('');
      }
    }
  }

  return issues;
}

/**
 * Scan directory for source files
 * @param {string} dir
 * @param {ProjectConfig} config
 * @returns {Promise<string[]>}
 */
async function scanDir(dir, config) {
  const files = [];
  const ignore = new Set(['node_modules', '.git', 'dist', '__pycache__']);

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
        if (!ignore.has(entry.name)) await walk(fullPath);
      } else if (entry.isFile()) {
        const rel = path.relative(dir, fullPath).replace(/\\/g, '/');
        if (matchesPattern(config.src.pattern, rel)) {
          files.push(rel);
        }
      }
    }
  }

  await walk(dir);
  return files;
}

/**
 * Fix audit issues (placeholder for LLM-based fixing)
 * @param {{root: string, config: ProjectConfig}} ctx
 * @param {object} args
 */
export async function fix(ctx, args) {
  console.error('⚠️  audit fix via CLI is not implemented.');
  console.error('');
  console.error('Use one of these alternatives:');
  console.error('  1. module-analyzer.js generates AUDIT.md with issues and suggestions');
  console.error('     node scripts/module-analyzer.js --stale');
  console.error('');
  console.error('  2. audit-fix.js for LLM-based auto-fix (scripts directory)');
  console.error('     node scripts/audit-fix.js [module-path]');
  console.error('');
  console.error('  3. Manual fix based on AUDIT.md content');
  process.exitCode = 1;
}

/**
 * Show audit status
 * @param {{root: string, config: ProjectConfig}} ctx
 * @param {object} args
 */
export async function status(ctx, args) {
  const { root, config } = ctx;

  const resultPath = getCachePath(config, root, '.audit-result.json');
  const auditResult = await readJsonSafe(resultPath);

  if (!auditResult) {
    console.log('No audit results. Run "pi audit scan" first.');
    return;
  }

  if (args.json) {
    console.log(JSON.stringify(auditResult.stats, null, 2));
  } else {
    console.log(`Audit Status (${auditResult.timestamp}):`);
    console.log(`  Errors:   ${auditResult.stats.errors}`);
    console.log(`  Warnings: ${auditResult.stats.warnings}`);
    console.log(`  Info:     ${auditResult.stats.info}`);
    console.log(`  Total:    ${auditResult.stats.total}`);
  }
}

/**
 * Archive fixed audit issues
 * @param {{root: string, config: ProjectConfig}} ctx
 * @param {object} args
 */
export async function archive(ctx, args) {
  const { root, config } = ctx;

  const resultPath = getCachePath(config, root, '.audit-result.json');
  const historyPath = getCachePath(config, root, '.audit-history.json');

  const auditResult = await readJsonSafe(resultPath);
  const history = await readJsonSafe(historyPath, { entries: [] });

  if (!auditResult) {
    console.log('No audit results to archive.');
    return;
  }

  // Add to history
  history.entries.push({
    timestamp: auditResult.timestamp,
    stats: auditResult.stats
  });

  // Keep last 100 entries
  if (history.entries.length > 100) {
    history.entries = history.entries.slice(-100);
  }

  await writeJsonSafe(historyPath, history);
  console.log(`Archived audit result from ${auditResult.timestamp}`);
}
