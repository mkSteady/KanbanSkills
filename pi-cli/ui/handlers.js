/**
 * Dashboard API handlers - Status functions
 */

import path from 'path';
import { promises as fs } from 'fs';
import { getDirectoryRule, matchesIgnoreInclude, readJsonSafe } from '../lib/shared.js';
import { getCachePath } from '../lib/context.js';

/** @typedef {import('../lib/types.js').ProjectConfig} ProjectConfig */

/**
 * Get test status with file-level coverage
 */
export async function getTestStatus(ctx) {
  const { root, config } = ctx;
  const cacheDir = config.cache || path.join(root, '.project-index');
  const testingPolicy = ctx.staleConfig?.testing || {};
  const ignore = ctx.staleConfig?.ignore || [];
  const include = ctx.staleConfig?.include || [];

  // Try to read test-status.json (file-level coverage from test-status.js)
  const testStatusFile = await readJsonSafe(path.join(cacheDir, '.test-status.json'), null);

  if (testStatusFile && (testStatusFile.summary || testStatusFile.stats)) {
    const filesAll = Array.isArray(testStatusFile.files) ? testStatusFile.files : [];
    const files = filesAll.filter(f => matchesIgnoreInclude(f?.source, ignore, include));

    // Prefer recalculating from file-level data. Fall back to summary for older cache formats.
    const summary = testStatusFile.summary || {
      total: testStatusFile.total,
      covered: testStatusFile.stats?.covered,
      untested: testStatusFile.stats?.untested,
      stale: testStatusFile.stats?.stale
    };

    const total = filesAll.length > 0 ? files.length : (Number(summary?.total) || 0);
    const covered = filesAll.length > 0 ? files.filter(f => f.status === 'covered').length : (Number(summary?.covered) || 0);
    const untested = filesAll.length > 0 ? files.filter(f => f.status === 'untested').length : (Number(summary?.untested) || 0);
    const stale = filesAll.length > 0 ? files.filter(f => f.status === 'stale').length : (Number(summary?.stale) || 0);
    const coveragePercent = total > 0 ? (covered / total) * 100 : 0;

    return {
      total,
      coveragePercent,
      stats: {
        covered,
        untested,
        stale
      },
      modulesWithTests: covered, // Compatibility for frontend display
      totalModules: total,
      indexFilesAnalyzed: testStatusFile.indexFilesAnalyzed || 0,
      files,  // Include file-level data for dep-tree (scoped by ignore/include)
      policy: {
        coverage: testingPolicy.coverage || {},
        qualityRules: Array.isArray(testingPolicy.qualityRules) ? testingPolicy.qualityRules : []
      }
    };
  }

  // Fallback to test-result.json (test execution results)
  const result = await readJsonSafe(path.join(cacheDir, '.test-result.json'));
  if (!result) {
    return {
      passed: 0,
      failed: 0,
      total: 0,
      coveragePercent: 0,
      stats: { covered: 0, untested: 0, stale: 0 },
      modulesWithTests: 0,
      totalModules: 0,
      policy: { coverage: testingPolicy.coverage || {} }
    };
  }

  return {
    passed: result.passed,
    failed: result.failed,
    skipped: result.skipped,
    duration: result.duration,
    timestamp: result.timestamp,
    errors: result.errors,
    total: 0,
    testCaseTotal: result.total,
    coveragePercent: 0,
    stats: { covered: 0, untested: 0, stale: 0 },
    modulesWithTests: 0,
    totalModules: 0,
    note: 'Run "pi test status" to calculate file-level coverage',
    policy: { coverage: testingPolicy.coverage || {} }
  };
}

/**
 * Get audit status with doc/audit coverage
 */
export async function getAuditStatus(ctx) {
  const { root, config } = ctx;
  const cacheDir = config.cache || path.join(root, '.project-index');
  const securityPolicy = ctx.staleConfig?.security || {};
  const directoryRules = ctx.staleConfig?.directoryRules || {};
  const ignore = ctx.staleConfig?.ignore || [];
  const include = ctx.staleConfig?.include || [];

  const tasksFile = await readJsonSafe(path.join(cacheDir, '.module-analyzer-tasks.json'), { tasks: [] });
  const allModulesUnfiltered = tasksFile.tasks || [];
  const allModules = allModulesUnfiltered.filter(mod => {
    const modPath = mod.context?.modulePath || mod.context?.fullPath || mod.module || mod.id;
    if (!modPath) return false;
    const rel = String(modPath).replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
    return matchesIgnoreInclude(rel, ignore, include);
  });
  const totalModules = allModules.length;

  const docEnabledModules = allModules.filter(t => t.context?.enableDoc).length;
  const auditEnabledModules = allModules.filter(t => t.context?.enableAudit).length;
  const docCoveragePercent = totalModules > 0 ? Math.round((docEnabledModules / totalModules) * 100) : 0;

  const auditFiles = ['.audit-result.json', '.audit-history.json'];
  let auditResult = null;
  for (const file of auditFiles) {
    auditResult = await readJsonSafe(path.join(cacheDir, file));
    if (auditResult) break;
  }

  let totalIssues = 0, totalResolved = 0, modules = [];
  let severityCounts = { critical: 0, high: 0, medium: 0, low: 0 };

  if (auditResult?.snapshots?.length > 0) {
    const latest = auditResult.snapshots[auditResult.snapshots.length - 1];
    totalIssues = latest.total || 0;
    totalResolved = auditResult.snapshots.reduce((sum, s) => sum + (s.resolved || 0), 0);
    modules = Object.entries(latest.modules || {})
      .map(([p, count]) => ({ path: p, issueCount: count }))
      .filter(m => matchesIgnoreInclude(m.path, ignore, include));
    // Keep totals scoped when possible.
    totalIssues = modules.reduce((sum, m) => sum + (Number(m.issueCount) || 0), 0);
    severityCounts = { critical: 0, high: 0, medium: Math.floor(totalIssues * 0.3), low: Math.floor(totalIssues * 0.7) };
  } else if (auditResult?.issues) {
    const issuesAll = Array.isArray(auditResult.issues) ? auditResult.issues : [];
    const issues = issuesAll.filter(i => matchesIgnoreInclude(i?.file, ignore, include));
    totalIssues = issues.length;
    for (const issue of issues) {
      const raw = String(issue.severity || 'low').toLowerCase();
      const mapped = raw === 'error' ? 'high'
        : raw === 'warning' ? 'medium'
        : raw === 'info' ? 'low'
        : raw;
      const sev = mapped;
      if (severityCounts[sev] !== undefined) severityCounts[sev]++;
    }
  }

  // Prefer structured severity distribution from audit-fix if available.
  const auditFixResult = await readJsonSafe(path.join(cacheDir, '.audit-fix-result.json'), null);
  if (auditFixResult?.bySeverity && typeof auditFixResult.bySeverity === 'object') {
    const by = auditFixResult.bySeverity;
    severityCounts = {
      critical: Number(by.CRITICAL || by.critical || severityCounts.critical || 0),
      high: Number(by.HIGH || by.high || severityCounts.high || 0),
      medium: Number(by.MEDIUM || by.medium || severityCounts.medium || 0),
      low: Number(by.LOW || by.low || severityCounts.low || 0)
    };
    if (!totalIssues && Number.isFinite(auditFixResult.totalIssues)) {
      totalIssues = auditFixResult.totalIssues;
    }
    if (!totalResolved && Number.isFinite(auditFixResult.fixed)) {
      totalResolved = auditFixResult.fixed;
    }
  }

  const auditCoveragePercent = totalModules > 0 ? Math.round((auditEnabledModules / totalModules) * 100) : 0;
  const completedModules = allModules.filter(t => t.status === 'completed').length;
  const readyPercent = totalModules > 0 ? Math.round((completedModules / totalModules) * 100) : 0;

  // Directory coverage (by most-specific directoryRules match).
  /** @type {Record<string, {audited: number, discovered: number, coveragePercent: number}>} */
  const dirCoverage = {};
  for (const mod of allModules) {
    const modPath = mod.context?.modulePath || mod.context?.fullPath || mod.module || mod.id;
    if (!modPath) continue;
    const rel = String(modPath).replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
    const dirRule = getDirectoryRule(rel, directoryRules);
    const key = dirRule?.path || '.';
    if (!dirCoverage[key]) dirCoverage[key] = { audited: 0, discovered: 0, coveragePercent: 0 };
    dirCoverage[key].discovered += 1;
    if (mod.context?.enableAudit) dirCoverage[key].audited += 1;
  }
  for (const [k, v] of Object.entries(dirCoverage)) {
    v.coveragePercent = v.discovered > 0 ? Math.round((v.audited / v.discovered) * 100) : 0;
    dirCoverage[k] = v;
  }

  return {
    totalIssues, resolved: totalResolved,
    total: auditEnabledModules, totalFiles: auditEnabledModules, totalDiscoveredFiles: totalModules,
    coveragePercent: auditCoveragePercent, docCoveragePercent, readyPercent, severityCounts, modules,
    stats: { fresh: completedModules, stale: totalModules - completedModules, clean: completedModules, never: 0 },
    history: { totalResolved },
    policy: { security: securityPolicy },
    dirCoverage
  };
}

/**
 * Get stale status from scan results
 */
export async function getStaleStatus(ctx) {
  const { root, config } = ctx;
  const cacheDir = config.cache || path.join(root, '.project-index');
  const notifyConfig = ctx.staleConfig?.notify || {};
  const notifyEnabledByConfig = notifyConfig.enabled !== false;
  const threshold = Number.isFinite(notifyConfig.threshold) ? notifyConfig.threshold : 3;

  const staleModules = await readJsonSafe(path.join(cacheDir, '.stale-modules.json'), { stale: [] });
  const staleState = await readJsonSafe(path.join(cacheDir, '.stale-notify-state.json'), null);
  const tasksFile = await readJsonSafe(path.join(cacheDir, '.module-analyzer-tasks.json'), { tasks: [] });
  const modules = tasksFile.tasks || [];

  const claudeModules = modules.filter(t => t.context?.enableDoc);
  const auditModules = modules.filter(t => t.context?.enableAudit);
  const staleList = staleModules.stale || [];
  const staleCount = staleList.length;

  const claudeStale = staleCount;
  const claudeFresh = claudeModules.length - claudeStale;
  const auditStale = staleCount;
  const auditFresh = auditModules.length - auditStale;

  return {
    claude: { fresh: Math.max(0, claudeFresh), stale: claudeStale },
    audit: { fresh: Math.max(0, auditFresh), stale: auditStale },
    lastCheck: staleState?.lastCheck || staleModules.timestamp || null,
    notify: {
      enabled: notifyEnabledByConfig && (staleState?.enabled !== false),
      threshold,
      onSessionStart: notifyConfig.onSessionStart !== false,
      state: staleState || { enabled: notifyEnabledByConfig, lastCheck: null, lastStaleCount: 0 }
    },
    stale: staleList
  };
}

/**
 * Get dependency graph
 */
export async function getDepGraph(ctx) {
  const { root } = ctx;
  const depGraphPath = path.join(root, '.dep-graph.json');
  const depGraph = await readJsonSafe(depGraphPath, null);

  if (depGraph) return depGraph;
  return { error: 'No dependency graph found. Run "pi deps build" first.', files: {}, modules: {} };
}
