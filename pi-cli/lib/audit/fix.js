/**
 * Audit Fix - LLM-based issue resolution
 * Parses AUDIT.md, generates fixes, applies them, archives to AUDIT_HISTORY.md
 */

import { promises as fs } from 'fs';
import path from 'path';
import { getDirectoryRule, matchesIgnoreInclude, readJsonSafe, writeJsonSafe } from '../shared.js';
import { getCachePath, loadStaleConfig } from '../context.js';

/** @typedef {import('../types.js').ProjectConfig} ProjectConfig */

const Severity = { LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH', CRITICAL: 'CRITICAL' };

const FIXABLE_TYPES = new Set([
  'missing_jsdoc', 'console_log', 'todo_fixme', 'magic_number',
  'hardcoded_string', 'missing_error_handling', 'event_naming',
  'export_missing', 'unused_import', 'deprecated_api'
]);

/**
 * Parse AUDIT.md file
 * @param {string} filePath
 * @returns {Promise<{modulePath: string, issues: Array}>}
 */
export async function parseAuditFile(filePath) {
  const content = await fs.readFile(filePath, 'utf-8');
  const issues = [];

  const issueBlocks = content.split(/(?=###\s*\[)/);

  for (const block of issueBlocks) {
    if (!block.startsWith('###')) continue;

    const headerMatch = block.match(/###\s*\[(LOW|MEDIUM|HIGH|CRITICAL)\]\s*(.+)/);
    if (!headerMatch) continue;

    const severity = headerMatch[1];
    const title = headerMatch[2].trim();

    const fileMatch = block.match(/\*\*File\*\*:\s*([^\n]+)/);
    const descMatch = block.match(/\*\*Description\*\*:\s*([^\n]+)/);
    const suggestionMatch = block.match(/\*\*Suggestion\*\*:\s*([^\n]+)/);
    const codeMatch = block.match(/```[\s\S]*?```/);

    const filePart = fileMatch ? fileMatch[1].trim() : '';
    const [file, lineStr] = filePart.split(':');
    const line = parseInt(lineStr) || 0;

    const type = inferIssueType(title, descMatch?.[1] || '');

    issues.push({
      id: `issue-${issues.length}`,
      severity,
      title,
      file: file?.trim() || '',
      line,
      description: descMatch?.[1]?.trim() || '',
      suggestion: suggestionMatch?.[1]?.trim() || '',
      codeSnippet: codeMatch?.[0] || '',
      type,
      fixable: FIXABLE_TYPES.has(type) && severity !== Severity.CRITICAL
    });
  }

  return { modulePath: path.dirname(filePath), issues };
}

/**
 * Infer issue type from title and description
 */
export function inferIssueType(title, description) {
  const text = (title + ' ' + description).toLowerCase();

  if (text.includes('jsdoc') || text.includes('documentation')) return 'missing_jsdoc';
  if (text.includes('console.log') || text.includes('console.')) return 'console_log';
  if (text.includes('todo') || text.includes('fixme')) return 'todo_fixme';
  if (text.includes('magic number') || text.includes('hardcoded')) return 'magic_number';
  if (text.includes('event') && text.includes('naming')) return 'event_naming';
  if (text.includes('export')) return 'export_missing';
  if (text.includes('import') && text.includes('unused')) return 'unused_import';
  if (text.includes('error') && text.includes('handling')) return 'missing_error_handling';
  if (text.includes('deprecated')) return 'deprecated_api';

  return 'unknown';
}

/**
 * Find all AUDIT.md files in a directory
 */
async function findAuditMdFiles(dir) {
  const results = [];

  async function walk(currentDir) {
    try {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          await walk(fullPath);
        } else if (entry.name === 'AUDIT.md') {
          results.push(fullPath);
        }
      }
    } catch { }
  }

  await walk(dir);
  return results;
}

/**
 * Generate fix for an issue using LLM
 */
async function generateFix(issue, cwd, llmRunner) {
  const staleConfig = issue.__staleConfig || null;
  const directoryRule = issue.__directoryRule || null;

  const filePath = path.join(cwd, issue.file);

  let sourceContent = '';
  try {
    sourceContent = await fs.readFile(filePath, 'utf-8');
  } catch {
    return { success: false, fix: null, error: 'Cannot read source file' };
  }

  const lines = sourceContent.split('\n');
  const startLine = Math.max(0, issue.line - 10);
  const endLine = Math.min(lines.length, issue.line + 10);
  const context = lines.slice(startLine, endLine).join('\n');

  const prompt = `Fix this audit issue:

File: ${issue.file}
Line: ${issue.line}
Severity: ${issue.severity}
Type: ${issue.type}
Title: ${issue.title}
Description: ${issue.description}
Suggestion: ${issue.suggestion}

${directoryRule ? `Directory Rule: ${directoryRule.path}
Directory Priority: ${directoryRule.rule?.priority || 'n/a'}
Directory Focus:
${Array.isArray(directoryRule.rule?.focus) && directoryRule.rule.focus.length > 0 ? directoryRule.rule.focus.map(f => `- ${f}`).join('\n') : '- (none)'}
` : ''}

${staleConfig?.security ? `Security Policy Notes:
${Array.isArray(staleConfig.security[String(issue.severity || '').toLowerCase()]) ? staleConfig.security[String(issue.severity || '').toLowerCase()].map(r => `- ${r}`).join('\n') : '- (no rules for this severity)'}
${Array.isArray(staleConfig.security.browserSpecific) && staleConfig.security.browserSpecific.length > 0 ? `\nBrowser-specific checks:\n${staleConfig.security.browserSpecific.map(r => `- ${r}`).join('\n')}` : ''}
${Number.isFinite(staleConfig.security.maxCyclomatic) ? `\nMax cyclomatic complexity: ${staleConfig.security.maxCyclomatic}` : ''}
` : ''}

Context (lines ${startLine + 1}-${endLine}):
\`\`\`javascript
${context}
\`\`\`

Provide the fix. Output JSON:
{
  "analysis": "Brief explanation",
  "canFix": true/false,
  "changes": [
    {
      "lineStart": number,
      "lineEnd": number,
      "oldCode": "exact text to replace",
      "newCode": "replacement text"
    }
  ]
}`;

  try {
    const result = await llmRunner(prompt, cwd, 90000);
    if (result.success) {
      const json = JSON.parse(result.output);
      return { success: true, fix: json };
    }
  } catch (e) {
    console.warn(`LLM fix generation failed: ${e.message}`);
  }

  return { success: false, fix: null };
}

/**
 * Apply fix to a file
 */
async function applyFix(fix, filePath) {
  if (!fix.canFix || !fix.changes || fix.changes.length === 0) {
    return false;
  }

  try {
    let content = await fs.readFile(filePath, 'utf-8');

    const sortedChanges = [...fix.changes].sort((a, b) => b.lineStart - a.lineStart);

    for (const change of sortedChanges) {
      if (change.oldCode && change.newCode) {
        content = content.replace(change.oldCode, change.newCode);
      }
    }

    await fs.writeFile(filePath, content);
    return true;
  } catch (e) {
    console.error(`Failed to apply fix: ${e.message}`);
    return false;
  }
}

/**
 * Archive fixed issue to AUDIT_HISTORY.md
 */
async function archiveIssue(issue, modulePath) {
  const historyFile = path.join(modulePath, 'AUDIT_HISTORY.md');

  const entry = `
## ${new Date().toISOString().split('T')[0]} - [${issue.severity}] ${issue.title}

- **File**: ${issue.file}:${issue.line}
- **Type**: ${issue.type}
- **Resolution**: Auto-fixed by audit-fix
- **Description**: ${issue.description}
`;

  try {
    const existing = await fs.readFile(historyFile, 'utf-8').catch(() => '# Audit History\n\nArchive of resolved audit issues.\n');
    await fs.writeFile(historyFile, existing + entry);
  } catch (e) {
    console.warn(`Failed to archive issue: ${e.message}`);
  }
}

/**
 * Remove fixed issue from AUDIT.md
 */
async function removeFromAudit(auditFile, issue) {
  try {
    let content = await fs.readFile(auditFile, 'utf-8');

    const escapeRegex = str => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
      `###\\s*\\[${issue.severity}\\]\\s*${escapeRegex(issue.title)}[\\s\\S]*?(?=###|## |$)`,
      'g'
    );

    content = content.replace(pattern, '');
    content = content.replace(/\n{3,}/g, '\n\n');

    await fs.writeFile(auditFile, content);
  } catch (e) {
    console.warn(`Failed to update AUDIT.md: ${e.message}`);
  }
}

/**
 * Fix audit issues
 * @param {{root: string, config: ProjectConfig}} ctx
 * @param {object} args
 */
export async function fix(ctx, args) {
  const { root, config } = ctx;
  const staleConfig = ctx.staleConfig || await loadStaleConfig(root, config);
  const ignore = staleConfig?.ignore || [];
  const include = staleConfig?.include || [];
  const directoryRules = staleConfig?.directoryRules || {};

  const dryRun = args['dry-run'] || false;
  const severityFilter = args.severity?.toUpperCase();
  const moduleFilter = args.module;
  const concurrency = parseInt(args.concurrency) || 3;

  const stateDir = getCachePath(config, root, '');
  const tasksFile = path.join(stateDir, '.audit-fix-tasks.json');
  const resultFile = path.join(stateDir, '.audit-fix-result.json');

  const stats = {
    modulesScanned: 0,
    totalIssues: 0,
    fixable: 0,
    fixed: 0,
    skipped: 0,
    failed: 0,
    bySeverity: { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 }
  };

  // Find AUDIT.md files
  const auditFilesAll = await findAuditMdFiles(root);
  const auditFiles = auditFilesAll.filter((auditFile) => {
    const moduleRel = path.relative(root, path.dirname(auditFile)).replace(/\\/g, '/') || '.';
    return matchesIgnoreInclude(moduleRel, ignore, include);
  });

  console.log(`Found ${auditFiles.length} AUDIT.md files`);

  // Parse all audit files
  const allIssues = [];

  for (const auditFile of auditFiles) {
    const { modulePath, issues } = await parseAuditFile(auditFile);
    stats.modulesScanned++;

    let filtered = issues;

    if (moduleFilter && !modulePath.includes(moduleFilter)) continue;
    if (severityFilter) {
      filtered = filtered.filter(i => i.severity === severityFilter);
    }

    for (const issue of filtered) {
      const fileRel = String(issue.file || '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
      const dirRule = getDirectoryRule(fileRel, directoryRules) || getDirectoryRule(path.relative(root, modulePath).replace(/\\/g, '/'), directoryRules);

      allIssues.push({
        ...issue,
        auditFile,
        modulePath,
        directoryRule: dirRule?.path || null,
        priority: dirRule?.rule?.priority || null,
        focus: Array.isArray(dirRule?.rule?.focus) ? dirRule.rule.focus : null
      });
    }
  }

  stats.totalIssues = allIssues.length;
  stats.fixable = allIssues.filter(i => i.fixable).length;

  console.log(`Total issues: ${stats.totalIssues}, Fixable: ${stats.fixable}`);

  // Save task state
  const tasks = allIssues.map((issue, i) => ({
    id: issue.id || `issue-${i}`,
    module: issue.modulePath,
    status: 'pending',
    severity: issue.severity,
    type: issue.type,
    title: issue.title,
    fixable: issue.fixable
  }));
  await writeJsonSafe(tasksFile, { tasks, startedAt: new Date().toISOString() });

  // Check for LLM runner
  let llmRunner = null;
  try {
    const { runCodeagent } = await import('../llm/batch.js');
    llmRunner = runCodeagent;
  } catch {
    console.log('LLM runner not available. Manual fixes required.');
    return;
  }

  // Process fixable issues
  const fixableIssues = allIssues
    .filter(i => i.fixable)
    .sort((a, b) => {
      const sevOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
      const priOrder = { critical: 0, high: 1, medium: 2, low: 3 };

      const sevCmp = (sevOrder[a.severity] ?? 99) - (sevOrder[b.severity] ?? 99);
      if (sevCmp !== 0) return sevCmp;

      const priA = priOrder[String(a.priority || '').toLowerCase()] ?? 99;
      const priB = priOrder[String(b.priority || '').toLowerCase()] ?? 99;
      if (priA !== priB) return priA - priB;

      const fileCmp = String(a.file || '').localeCompare(String(b.file || ''));
      if (fileCmp !== 0) return fileCmp;
      return (a.line || 0) - (b.line || 0);
    });

  for (let i = 0; i < fixableIssues.length; i += concurrency) {
    const batch = fixableIssues.slice(i, i + concurrency);

    const results = await Promise.all(
      batch.map(async (issue) => {
        stats.bySeverity[issue.severity]++;

        console.log(`Processing: [${issue.severity}] ${issue.title}`);

        const fileRel = String(issue.file || '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
        const dirRule = getDirectoryRule(fileRel, directoryRules);

        const issueForFix = {
          ...issue,
          __staleConfig: staleConfig,
          __directoryRule: dirRule
        };

        const { success, fix: fixData } = await generateFix(issueForFix, root, llmRunner);

        if (!success || !fixData?.canFix) {
          console.log(`  Cannot auto-fix: ${fixData?.analysis || 'LLM failed'}`);
          stats.skipped++;
          return { issue, success: false };
        }

        if (dryRun) {
          console.log(`  [dry-run] Would fix with ${fixData.changes?.length || 0} changes`);
          return { issue, success: true, dryRun: true };
        }

        const filePath = path.join(root, issue.file);
        const applied = await applyFix(fixData, filePath);

        if (applied) {
          console.log(`  Fixed!`);
          await archiveIssue(issue, issue.modulePath);
          await removeFromAudit(issue.auditFile, issue);
          stats.fixed++;
          return { issue, success: true };
        } else {
          console.log(`  Failed to apply fix`);
          stats.failed++;
          return { issue, success: false };
        }
      })
    );

    // Update task statuses
    for (const result of results) {
      const task = tasks.find(t => t.id === result.issue.id);
      if (task) {
        task.status = result.success ? 'completed' : 'failed';
      }
    }
    await writeJsonSafe(tasksFile, { tasks, startedAt: new Date().toISOString() });
  }

  // Final result
  const result = {
    success: stats.fixed > 0 || stats.totalIssues === 0,
    ...stats,
    completedAt: new Date().toISOString()
  };

  await writeJsonSafe(resultFile, result);

  console.log(`\n=== Summary ===`);
  console.log(`Modules scanned: ${stats.modulesScanned}`);
  console.log(`Total issues: ${stats.totalIssues}`);
  console.log(`Fixable: ${stats.fixable}`);
  console.log(`Fixed: ${stats.fixed}`);
  console.log(`Skipped: ${stats.skipped}`);
  console.log(`Failed: ${stats.failed}`);
}
