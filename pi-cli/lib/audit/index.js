/**
 * Audit module index
 */

import { promises as fs } from 'fs';
import path from 'path';
import { runCommand, truncate } from '../shared.js';

export { scan } from './scan.js';
export { fix, parseAuditFile, inferIssueType } from './fix.js';

/**
 * Show audit status across module AUDIT.md files.
 *
 * Features:
 * - Reads each module's AUDIT.md
 * - Counts issues by severity: critical/error/warning/info
 * - Shows fix progress (fixed/total) based on `[FIXED]` markers (and checked boxes `- [x]`)
 * - Supports `--module <name>` and `--severity <level>`
 * - Outputs either a human-readable table or JSON (`--json`)
 *
 * @param {{root: string, config: import('../types.js').ProjectConfig}} ctx
 * @param {Record<string, any>} args
 */
export async function status(ctx, args) {
  const { root } = ctx;

  const moduleFilter = typeof args.module === 'string' && args.module.trim() ? args.module.trim() : null;
  const severityFilter = normalizeSeverity(args.severity);

  const auditFiles = await findAuditMdFiles(root);

  /** @type {Array<{module: string, auditPath: string, counts: Record<string, number>, fixed: number, total: number}>} */
  const modules = [];

  /** @type {Record<'critical'|'error'|'warning'|'info', number>} */
  const totals = { critical: 0, error: 0, warning: 0, info: 0 };
  let totalFixed = 0;
  let totalIssues = 0;

  for (const auditPath of auditFiles) {
    const modulePathAbs = path.dirname(auditPath);
    const modulePathRel = path.relative(root, modulePathAbs).replace(/\\/g, '/') || '.';

    if (moduleFilter && !matchesModuleFilter(modulePathRel, moduleFilter)) continue;

    let content = '';
    try {
      content = await fs.readFile(auditPath, 'utf-8');
    } catch {
      continue;
    }

    const issues = parseAuditIssues(content);
    const filteredIssues = severityFilter
      ? issues.filter(i => i.severity === severityFilter)
      : issues;

    /** @type {Record<'critical'|'error'|'warning'|'info', number>} */
    const counts = { critical: 0, error: 0, warning: 0, info: 0 };
    let fixed = 0;

    for (const issue of filteredIssues) {
      if (issue.fixed) {
        fixed++;
        continue; // fixed issues don't contribute to "current" severity counts
      }
      counts[issue.severity]++;
    }

    const total = filteredIssues.length;
    if (total === 0 && severityFilter) continue; // hide modules with no matching severity

    for (const k of /** @type {const} */(['critical', 'error', 'warning', 'info'])) totals[k] += counts[k];
    totalFixed += fixed;
    totalIssues += total;

    modules.push({
      module: modulePathRel,
      auditPath,
      counts,
      fixed,
      total
    });
  }

  modules.sort((a, b) => {
    const aOpen = a.total - a.fixed;
    const bOpen = b.total - b.fixed;
    if (aOpen !== bOpen) return bOpen - aOpen;
    return a.module.localeCompare(b.module);
  });

  if (args.json) {
    console.log(JSON.stringify({
      filters: {
        module: moduleFilter,
        severity: severityFilter
      },
      totals: {
        ...totals,
        fixed: totalFixed,
        total: totalIssues
      },
      modules: modules.map(m => ({
        module: m.module,
        auditPath: path.relative(root, m.auditPath).replace(/\\/g, '/'),
        counts: m.counts,
        fixed: m.fixed,
        total: m.total
      }))
    }, null, 2));
    return;
  }

  // Human-readable table
  const rows = modules.map(m => ({
    module: m.module,
    critical: String(m.counts.critical),
    error: String(m.counts.error),
    warning: String(m.counts.warning),
    info: String(m.counts.info),
    progress: `${m.fixed}/${m.total}`
  }));

  const footer = {
    module: 'TOTAL',
    critical: String(totals.critical),
    error: String(totals.error),
    warning: String(totals.warning),
    info: String(totals.info),
    progress: `${totalFixed}/${totalIssues}`
  };

  printTable(
    [
      { key: 'module', header: 'Module' },
      { key: 'critical', header: 'Critical', align: 'right' },
      { key: 'error', header: 'Error', align: 'right' },
      { key: 'warning', header: 'Warning', align: 'right' },
      { key: 'info', header: 'Info', align: 'right' },
      { key: 'progress', header: 'Fixed/Total', align: 'right' }
    ],
    rows,
    footer
  );
}

/**
 * Archive fixed issues from AUDIT.md into AUDIT_HISTORY.md.
 *
 * - Moves issues marked `[FIXED]` (and checked boxes `- [x]`) into AUDIT_HISTORY.md
 * - Adds archive timestamp and git commit hash (when available)
 * - Rewrites AUDIT.md to keep only unresolved issues
 * - Supports `--dry-run` to preview without modifying files
 *
 * @param {{root: string, config: import('../types.js').ProjectConfig}} ctx
 * @param {Record<string, any>} args
 */
export async function archive(ctx, args) {
  const { root } = ctx;
  const dryRun = Boolean(args['dry-run']);
  const moduleFilter = typeof args.module === 'string' && args.module.trim() ? args.module.trim() : null;

  const auditFiles = await findAuditMdFiles(root);

  const now = new Date();
  const timestamp = now.toISOString();
  const date = timestamp.split('T')[0];
  const commitHash = await getGitCommitHash(root);

  let totalArchived = 0;
  let touchedFiles = 0;

  for (const auditPath of auditFiles) {
    const moduleDir = path.dirname(auditPath);
    const moduleRel = path.relative(root, moduleDir).replace(/\\/g, '/') || '.';

    if (moduleFilter && !matchesModuleFilter(moduleRel, moduleFilter)) continue;

    let content = '';
    try {
      content = await fs.readFile(auditPath, 'utf-8');
    } catch {
      continue;
    }

    const { archivedIssues, updatedContent, format } = archiveFromAuditContent(content);

    if (archivedIssues.length === 0) continue;

    totalArchived += archivedIssues.length;
    touchedFiles++;

    const historyPath = path.join(moduleDir, 'AUDIT_HISTORY.md');
    const historyPatch = buildHistorySection({
      date,
      timestamp,
      commitHash,
      moduleName: path.basename(moduleDir),
      modulePath: moduleRel,
      issues: archivedIssues
    });

    if (dryRun) {
      console.log(`[dry-run] ${moduleRel}: would archive ${archivedIssues.length} issue(s) (${format})`);
      for (const issue of archivedIssues.slice(0, 20)) {
        console.log(`  - ${truncate(issue.title, 120)}`);
      }
      if (archivedIssues.length > 20) {
        console.log(`  ... +${archivedIssues.length - 20} more`);
      }
      continue;
    }

    // Write history (prepend after header delimiter when possible)
    await appendHistory(historyPath, historyPatch, moduleDir);

    // Write updated AUDIT.md
    await fs.writeFile(auditPath, updatedContent);

    console.log(`${moduleRel}: archived ${archivedIssues.length} issue(s)`);
  }

  if (dryRun) {
    console.log(`\n[dry-run] Total: would archive ${totalArchived} issue(s) across ${touchedFiles} module(s).`);
  } else {
    console.log(`\nTotal: archived ${totalArchived} issue(s) across ${touchedFiles} module(s).`);
  }
}

/**
 * @typedef {{title: string, content: string, severity?: string, fixed: boolean}} ParsedIssue
 */

/**
 * Walk the project tree and return all AUDIT.md file paths.
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function findAuditMdFiles(root) {
  const results = [];
  const ignoreDirs = new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    'coverage',
    '.next',
    '.nuxt',
    '.output',
    'out',
    '__pycache__',
    '.venv',
    'venv',
    '.cache',
    '.turbo'
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
      if (entry.isDirectory()) {
        if (ignoreDirs.has(entry.name)) continue;
        if (entry.name.startsWith('.')) continue;
        await walk(fullPath);
      } else if (entry.isFile() && entry.name === 'AUDIT.md') {
        results.push(fullPath);
      }
    }
  }

  await walk(root);
  return results;
}

/**
 * @param {string} modulePathRel
 * @param {string} filter
 */
function matchesModuleFilter(modulePathRel, filter) {
  const needle = filter.toLowerCase();
  return modulePathRel.toLowerCase().includes(needle);
}

/**
 * Normalize various severity labels into: critical|error|warning|info.
 * @param {any} raw
 * @returns {'critical'|'error'|'warning'|'info'|null}
 */
function normalizeSeverity(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;

  // Accept common aliases.
  if (s === 'critical' || s === 'crit') return 'critical';
  if (s === 'error' || s === 'err') return 'error';
  if (s === 'warning' || s === 'warn') return 'warning';
  if (s === 'info') return 'info';

  // Map older scheme -> current.
  if (s === 'high') return 'error';
  if (s === 'medium') return 'warning';
  if (s === 'low') return 'info';

  return null;
}

/**
 * Parse issues from AUDIT.md content (best-effort; supports multiple historical formats).
 * @param {string} content
 * @returns {Array<{title: string, content: string, severity: 'critical'|'error'|'warning'|'info', fixed: boolean}>}
 */
function parseAuditIssues(content) {
  const fileSeverity = getFileSeverity(content);

  // Prefer parsing under a dedicated "## Issues" section when present.
  const issuesHeaderMatch = /^##\s+Issues\b.*$/im.exec(content);
  if (issuesHeaderMatch) {
    const section = content.slice(issuesHeaderMatch.index);
    const parsed = parseIssuesFromHeadingBlocks(section, fileSeverity);
    if (parsed.length > 0) return parsed;
  }

  // Fallback: checklist-style (module analyzer output)
  const checklist = parseIssuesFromChecklist(content, fileSeverity);
  if (checklist.length > 0) return checklist;

  // Last resort: try to parse any ### blocks.
  return parseIssuesFromHeadingBlocks(content, fileSeverity);
}

/**
 * Parse issues from "### ..." blocks.
 * @param {string} content
 * @param {'critical'|'error'|'warning'|'info'|null} fileSeverity
 */
function parseIssuesFromHeadingBlocks(content, fileSeverity) {
  const lines = content.split('\n');
  /** @type {Array<{header: string, body: string}>} */
  const blocks = [];

  let currentHeader = null;
  let body = [];

  for (const line of lines) {
    if (line.startsWith('### ')) {
      if (currentHeader) {
        blocks.push({ header: currentHeader, body: body.join('\n').trim() });
      }
      currentHeader = line.slice(4).trim();
      body = [];
      continue;
    }
    if (currentHeader) body.push(line);
  }

  if (currentHeader) {
    blocks.push({ header: currentHeader, body: body.join('\n').trim() });
  }

  /** @type {Array<{title: string, content: string, severity: 'critical'|'error'|'warning'|'info', fixed: boolean}>} */
  const issues = [];
  for (const b of blocks) {
    const rawTitle = b.header.replace(/^\d+\.\s*/, '').trim();
    const title = rawTitle.replace(/\[FIXED\]\s*/ig, '').trim();
    const fixed = isFixedMarkerPresent(b.header, b.body);
    const explicit = detectSeverity(`${b.header}\n${b.body}`);
    const severity = explicit || fileSeverity || 'info';
    issues.push({ title, content: b.body, severity, fixed });
  }

  return issues;
}

/**
 * Parse issues from checklist lines: "- [ ] ..." / "- [x] ..."
 * Uses the nearest preceding "## <SEVERITY>" heading when present.
 * @param {string} content
 * @param {'critical'|'error'|'warning'|'info'|null} fileSeverity
 */
function parseIssuesFromChecklist(content, fileSeverity) {
  const lines = content.split('\n');
  let currentSeverity = /** @type {'critical'|'error'|'warning'|'info'} */(fileSeverity || 'info');

  /** @type {Array<{title: string, content: string, severity: 'critical'|'error'|'warning'|'info', fixed: boolean}>} */
  const issues = [];

  for (const line of lines) {
    const h = /^##\s+([A-Za-z]+)\b/.exec(line);
    if (h) {
      currentSeverity = normalizeSeverity(h[1]) || currentSeverity;
      continue;
    }

    const cb = /^\s*-\s*\[([ xX])\]\s*(.+)$/.exec(line);
    if (cb) {
      const checked = cb[1].toLowerCase() === 'x';
      const rest = cb[2].trim();
      const fixed = checked || /\[FIXED\]/i.test(rest);
      const title = rest.replace(/\[FIXED\]\s*/ig, '').trim();
      const severity = detectSeverity(rest) || currentSeverity;
      issues.push({ title, content: '', severity, fixed });
      continue;
    }

    // Also support "- [FIXED] ..." bullet style.
    const bullet = /^\s*-\s+(.+)$/.exec(line);
    if (bullet && /\[FIXED\]/i.test(bullet[1])) {
      const rest = bullet[1].trim();
      const title = rest.replace(/\[FIXED\]\s*/ig, '').trim();
      const severity = detectSeverity(rest) || currentSeverity;
      issues.push({ title, content: '', severity, fixed: true });
    }
  }

  return issues;
}

/**
 * @param {string} header
 * @param {string} body
 */
function isFixedMarkerPresent(header, body) {
  if (/\[FIXED\]/i.test(header) || /\[FIXED\]/i.test(body)) return true;
  if (/^\s*-\s*\[[xX]\]\s+/m.test(body)) return true;
  return false;
}

/**
 * Detect normalized severity from text (returns null when absent).
 * @param {string} text
 * @returns {'critical'|'error'|'warning'|'info'|null}
 */
function detectSeverity(text) {
  const s = String(text || '');

  // Prefer explicit bracket tags.
  const tag = /\[(critical|error|warning|info|high|medium|low)\]/i.exec(s);
  if (tag) return normalizeSeverity(tag[1]);

  // Also accept explicit severity fields.
  const sev = /Severity:\s*(?:\*\*)?(\w+)(?:\*\*)?/i.exec(s);
  if (sev) return normalizeSeverity(sev[1]);

  // Or section headings.
  const head = /^##\s+(critical|error|warning|info|high|medium|low)\b/im.exec(s);
  if (head) return normalizeSeverity(head[1]);

  return null;
}

/**
 * Extract a file-level severity if present (used as a fallback when issues don't carry their own severity).
 * @param {string} content
 * @returns {'critical'|'error'|'warning'|'info'|null}
 */
function getFileSeverity(content) {
  const m1 = content.match(/Severity:\s*\*\*(\w+)\*\*/i);
  if (m1) return normalizeSeverity(m1[1]);
  const m2 = content.match(/##\s*Severity:\s*(\w+)/i);
  if (m2) return normalizeSeverity(m2[1]);
  const m3 = content.match(/Severity:\s*(\w+)/i);
  if (m3) return normalizeSeverity(m3[1]);
  return null;
}

/**
 * Archive `[FIXED]` issues from an AUDIT.md content string.
 * @param {string} content
 * @returns {{archivedIssues: ParsedIssue[], updatedContent: string, format: string}}
 */
function archiveFromAuditContent(content) {
  // Format 1: numbered issues (scripts/audit-archive.js)
  if (/##\s+Issues\s*\(\d+\)/i.test(content) && /^###\s+\d+\.\s+/m.test(content)) {
    const parsed = parseNumberedAuditMd(content);
    const toArchive = parsed.issues.filter(i => isFixedMarkerPresent(i.title, i.content));
    const remaining = parsed.issues.filter(i => !isFixedMarkerPresent(i.title, i.content));
    if (toArchive.length === 0) {
      return { archivedIssues: [], updatedContent: content, format: 'numbered' };
    }
    const normalizedArchived = toArchive.map(i => ({
      title: i.title.replace(/\[FIXED\]\s*/ig, '').trim(),
      content: i.content,
      severity: detectSeverity(`${i.title}\n${i.content}`) || normalizeSeverity(parsed.severity) || 'info',
      fixed: true
    }));
    const updated = generateNumberedAuditMd({
      ...parsed,
      severity: remaining.length === 0 ? 'NONE' : parsed.severity,
      issues: remaining
    });
    return { archivedIssues: normalizedArchived, updatedContent: updated, format: 'numbered' };
  }

  // Format 2: "### [SEVERITY] ..." blocks (audit-fix style)
  if (/^###\s*\[[A-Za-z]+\]/m.test(content)) {
    const { archivedIssues, updatedContent } = archiveFromBracketHeadings(content);
    return { archivedIssues, updatedContent, format: 'brackets' };
  }

  // Format 3: checklist style "- [x] ..." under severity headings
  if (/^\s*-\s*\[[ xX]\]\s+/m.test(content)) {
    const { archivedIssues, updatedContent } = archiveFromChecklist(content);
    return { archivedIssues, updatedContent, format: 'checklist' };
  }

  // Unknown: don't modify content (safe default).
  return { archivedIssues: [], updatedContent: content, format: 'unknown' };
}

/**
 * Parse numbered AUDIT.md format used by scripts/audit-archive.js.
 * @param {string} content
 */
function parseNumberedAuditMd(content) {
  const lines = content.split('\n');

  // Header is everything before "## Summary" (keeps original title/date/etc.)
  const summaryHeaderIdx = lines.findIndex(l => l.startsWith('## Summary'));
  const header = summaryHeaderIdx > 0 ? lines.slice(0, summaryHeaderIdx).join('\n') : '';

  // Severity (optional)
  const severityMatch = content.match(/Severity:\s*\*\*(\w+)\*\*/i);
  const severity = severityMatch ? severityMatch[1] : 'UNKNOWN';

  // Summary
  const summaryMatch = content.match(/## Summary\n([\s\S]*?)(?=\n## Issues|\n##[^#]|$)/);
  const summary = summaryMatch ? summaryMatch[1].trim() : '';

  // Issues (numbered headings)
  /** @type {Array<{id: number, title: string, content: string}>} */
  const issues = [];
  const issueRegex = /### (\d+)\. ([^\n]+)\n([\s\S]*?)(?=\n### \d+\.|$)/g;

  let match;
  while ((match = issueRegex.exec(content)) !== null) {
    issues.push({
      id: parseInt(match[1], 10),
      title: match[2].trim(),
      content: match[3].trim()
    });
  }

  return { header, severity, summary, issues };
}

/**
 * Generate numbered AUDIT.md content.
 * @param {{header: string, severity: string, summary: string, issues: Array<{id: number, title: string, content: string}>}} data
 */
function generateNumberedAuditMd(data) {
  const { header, severity, summary, issues } = data;

  // Preserve header but update severity marker if present.
  let updatedHeader = (header || '').trim();
  if (severity && updatedHeader) {
    updatedHeader = updatedHeader.replace(/Severity:\s*\*\*\w+\*\*/i, `Severity: **${String(severity).toUpperCase()}**`);
  }

  let out = updatedHeader ? `${updatedHeader}\n\n` : '';
  out += `## Summary\n${summary}\n\n`;

  if (issues.length === 0) {
    out += `## Issues (0)\n\nNo current issues. All previously identified issues have been resolved and archived to AUDIT_HISTORY.md.\n`;
    return out.trim() + '\n';
  }

  out += `## Issues (${issues.length})\n`;
  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    out += `### ${i + 1}. ${issue.title}\n${issue.content}\n\n`;
  }

  return out.trim() + '\n';
}

/**
 * Archive `[FIXED]` issues from "### [SEVERITY] ..." style blocks.
 * @param {string} content
 */
function archiveFromBracketHeadings(content) {
  /** @type {ParsedIssue[]} */
  const archivedIssues = [];

  // Split into blocks starting with "###".
  const blocks = content.split(/(?=^###\s)/m);
  const kept = [];

  for (const block of blocks) {
    if (!block.startsWith('###')) {
      kept.push(block);
      continue;
    }

    const firstLine = block.split('\n', 1)[0];
    const body = block.slice(firstLine.length).trim();
    const titleRaw = firstLine.replace(/^###\s*/, '').trim();

    if (isFixedMarkerPresent(titleRaw, body)) {
      archivedIssues.push({
        title: titleRaw.replace(/\[FIXED\]\s*/ig, '').trim(),
        content: body.trim(),
        severity: detectSeverity(`${titleRaw}\n${body}`) || 'info',
        fixed: true
      });
    } else {
      kept.push(block);
    }
  }

  if (archivedIssues.length === 0) {
    return { archivedIssues, updatedContent: content };
  }

  // Clean up excessive blank lines after removals.
  const updatedContent = kept.join('').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  return { archivedIssues, updatedContent };
}

/**
 * Archive checked checklist items (`- [x]`) or lines containing `[FIXED]`.
 * @param {string} content
 */
function archiveFromChecklist(content) {
  const lines = content.split('\n');
  let currentSeverityHeading = '';

  /** @type {ParsedIssue[]} */
  const archivedIssues = [];
  const keptLines = [];

  for (const line of lines) {
    const h = /^##\s+(.+)$/.exec(line);
    if (h) {
      currentSeverityHeading = h[1].trim();
      keptLines.push(line);
      continue;
    }

    const cb = /^\s*-\s*\[([ xX])\]\s*(.+)$/.exec(line);
    if (cb) {
      const checked = cb[1].toLowerCase() === 'x';
      const rest = cb[2].trim();
      const fixed = checked || /\[FIXED\]/i.test(rest);

      if (fixed) {
        archivedIssues.push({
          title: rest.replace(/\[FIXED\]\s*/ig, '').trim(),
          content: currentSeverityHeading ? `Section: ${currentSeverityHeading}` : '',
          severity: detectSeverity(`${currentSeverityHeading}\n${rest}`) || 'info',
          fixed: true
        });
        continue; // remove from AUDIT.md
      }

      keptLines.push(line);
      continue;
    }

    const bullet = /^\s*-\s+(.+)$/.exec(line);
    if (bullet && /\[FIXED\]/i.test(bullet[1])) {
      const rest = bullet[1].trim();
      archivedIssues.push({
        title: rest.replace(/\[FIXED\]\s*/ig, '').trim(),
        content: currentSeverityHeading ? `Section: ${currentSeverityHeading}` : '',
        severity: detectSeverity(`${currentSeverityHeading}\n${rest}`) || 'info',
        fixed: true
      });
      continue; // remove
    }

    keptLines.push(line);
  }

  if (archivedIssues.length === 0) {
    return { archivedIssues, updatedContent: content };
  }

  // Remove empty severity sections (best-effort): if a heading is immediately followed by another heading/EOF.
  const pruned = [];
  for (let i = 0; i < keptLines.length; i++) {
    const line = keptLines[i];
    const isHeading = /^##\s+/.test(line);
    if (!isHeading) {
      pruned.push(line);
      continue;
    }

    // Look ahead for the next non-empty line.
    let j = i + 1;
    while (j < keptLines.length && keptLines[j].trim() === '') j++;
    const next = keptLines[j] || '';
    const headingHasContent = next && !/^##\s+/.test(next);
    if (headingHasContent) {
      pruned.push(line);
    }
  }

  const updatedContent = pruned.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  return { archivedIssues, updatedContent };
}

/**
 * @param {{date: string, timestamp: string, commitHash: string|null, moduleName: string, modulePath: string, issues: ParsedIssue[]}} params
 */
function buildHistorySection(params) {
  const { date, timestamp, commitHash, moduleName, modulePath, issues } = params;

  let section = `## Archived: ${date}\n\n`;
  section += `*Archived: ${timestamp}*\n`;
  section += `*Module: ${moduleName} (${modulePath})*\n`;
  if (commitHash) section += `*Commit: ${commitHash}*\n`;
  section += '\n';

  for (const issue of issues) {
    section += `### [FIXED] ${issue.title}\n`;
    section += `*Fixed: ${timestamp}*`;
    if (commitHash) section += `  *Commit: ${commitHash}*`;
    section += '\n\n';
    if (issue.content) section += `${issue.content.trim()}\n\n`;
  }

  section += '---\n\n';
  return section;
}

/**
 * Append a history patch to AUDIT_HISTORY.md, preserving an optional header delimiter.
 * Mirrors scripts/audit-archive.js insertion strategy.
 * @param {string} historyPath
 * @param {string} patch
 * @param {string} moduleDir
 */
async function appendHistory(historyPath, patch, moduleDir) {
  let existing = '';
  try {
    existing = await fs.readFile(historyPath, 'utf-8');
  } catch {
    existing = `# Audit History - ${path.basename(moduleDir)}\n\nArchived issues from audits.\n\n---\n\n`;
  }

  const headerEndIdx = existing.indexOf('---\n\n');
  if (headerEndIdx >= 0) {
    const header = existing.slice(0, headerEndIdx + 5);
    const rest = existing.slice(headerEndIdx + 5);
    await fs.writeFile(historyPath, header + patch + rest);
    return;
  }

  await fs.writeFile(historyPath, existing + '\n' + patch);
}

/**
 * Resolve current git commit hash (short) when inside a git work tree.
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
async function getGitCommitHash(cwd) {
  const inside = await runCommand('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
  if (inside.code !== 0) return null;
  if (inside.stdout.trim() !== 'true') return null;

  const hash = await runCommand('git', ['rev-parse', '--short', 'HEAD'], { cwd });
  if (hash.code !== 0) return null;
  const out = hash.stdout.trim();
  return out || null;
}

/**
 * @param {Array<{key: string, header: string, align?: 'left'|'right'}>} columns
 * @param {Array<Record<string, string>>} rows
 * @param {Record<string, string>} [footer]
 */
function printTable(columns, rows, footer) {
  const widths = {};
  for (const col of columns) {
    widths[col.key] = col.header.length;
  }
  for (const row of rows) {
    for (const col of columns) {
      const v = String(row[col.key] ?? '');
      if (v.length > widths[col.key]) widths[col.key] = v.length;
    }
  }
  if (footer) {
    for (const col of columns) {
      const v = String(footer[col.key] ?? '');
      if (v.length > widths[col.key]) widths[col.key] = v.length;
    }
  }

  const line = columns.map(col => '-'.repeat(widths[col.key])).join('  ');
  const header = columns.map(col => pad(col.header, widths[col.key], col.align)).join('  ');

  console.log(header);
  console.log(line);
  for (const row of rows) {
    console.log(columns.map(col => pad(String(row[col.key] ?? ''), widths[col.key], col.align)).join('  '));
  }
  if (footer) {
    console.log(line);
    console.log(columns.map(col => pad(String(footer[col.key] ?? ''), widths[col.key], col.align)).join('  '));
  }
}

/**
 * @param {string} s
 * @param {number} width
 * @param {'left'|'right'|undefined} align
 */
function pad(s, width, align) {
  if (align === 'right') return s.padStart(width);
  return s.padEnd(width);
}
