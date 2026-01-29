import { promises as fs } from 'fs';
import path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn()
  }
}));

vi.mock('../../../scripts/shared.js', () => ({
  parseArgs: vi.fn(),
  fileExists: vi.fn()
}));

import { parseArgs, fileExists } from '../../../scripts/shared.js';

/** @type {import('../../../scripts/audit-archive.js')} */
let auditArchive;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.useRealTimers();
  auditArchive = await import('../../../scripts/audit-archive.js');
});

function stubExit() {
  return vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`process.exit:${code}`);
  });
}

function sampleAuditMd({ severity = 'HIGH', issues = [] } = {}) {
  const issueBlocks = issues
    .map((i) => `### ${i.id}. ${i.title}\n${i.content}`)
    .join('\n\n');

  return [
    '# Audit - demo',
    `Severity: **${severity}**`,
    '',
    'Intro line',
    '',
    '## Summary',
    'Summary text',
    '',
    `## Issues (${issues.length})`,
    issueBlocks
  ]
    .filter(Boolean)
    .join('\n')
    .trimEnd() + '\n';
}

describe('parseAuditMd', () => {
  it('parses header (pre-summary), severity, summary, and issues', () => {
    const content = [
      '# Audit - demo',
      'Severity: **HIGH**',
      '',
      'Intro line',
      '',
      '## Summary',
      'Summary text',
      '',
      '## Issues (2)',
      '### 1. First issue',
      'First content',
      '',
      '### 2. Second issue',
      'Second content',
      ''
    ].join('\n');

    const res = auditArchive.parseAuditMd(content);

    expect(res.severity).toBe('HIGH');
    expect(res.summary).toBe('Summary text');
    expect(res.header).toBe(['# Audit - demo', 'Severity: **HIGH**', '', 'Intro line', ''].join('\n'));
    expect(res.issues).toEqual([
      { id: 1, title: 'First issue', content: 'First content' },
      { id: 2, title: 'Second issue', content: 'Second content' }
    ]);
  });

  it('defaults severity to UNKNOWN when missing', () => {
    const content = [
      '# Audit - demo',
      '',
      '## Summary',
      'S',
      '',
      '## Issues (1)',
      '### 1. A',
      'B'
    ].join('\n');

    const res = auditArchive.parseAuditMd(content);
    expect(res.severity).toBe('UNKNOWN');
  });

  it('extracts summary until the next h2 section (not just Issues)', () => {
    const content = [
      '# Audit - demo',
      'Severity: **LOW**',
      '',
      '## Summary',
      'Line 1',
      '',
      '## Appendix',
      'Should not be in summary',
      '',
      '## Issues (0)',
      'No current issues'
    ].join('\n');

    const res = auditArchive.parseAuditMd(content);
    expect(res.summary).toBe('Line 1');
  });

  it('returns empty header/summary/issues when sections are missing', () => {
    const content = '# Only a title\n';
    const res = auditArchive.parseAuditMd(content);
    expect(res.header).toBe('');
    expect(res.summary).toBe('');
    expect(res.issues).toEqual([]);
    expect(res.severity).toBe('UNKNOWN');
  });
});

describe('generateAuditMd', () => {
  it('updates severity in header (case-insensitive) and preserves summary/issues', () => {
    const data = {
      header: '# Audit - demo\nSeverity: **low**\n',
      severity: 'high',
      summary: 'S',
      issues: [{ id: 9, title: 'T', content: 'C' }]
    };

    const out = auditArchive.generateAuditMd(data);

    expect(out).toContain('Severity: **HIGH**');
    expect(out).toContain('## Summary\nS\n');
    expect(out).toContain('## Issues (1)\n### 1. T\nC\n');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('renders a clean AUDIT.md when issues are empty', () => {
    const data = {
      header: '# Audit - demo\nSeverity: **HIGH**\n',
      severity: 'NONE',
      summary: 'All good',
      issues: []
    };

    const out = auditArchive.generateAuditMd(data);

    expect(out).toContain('Severity: **NONE**');
    expect(out).toContain('## Issues (0)');
    expect(out).toContain('No current issues. All previously identified issues have been resolved and archived to AUDIT_HISTORY.md.');
  });

  it('renumbers issues sequentially starting at 1', () => {
    const data = {
      header: '# Audit - demo\nSeverity: **MEDIUM**\n',
      severity: 'MEDIUM',
      summary: 'S',
      issues: [
        { id: 10, title: 'A', content: 'CA' },
        { id: 42, title: 'B', content: 'CB' }
      ]
    };

    const out = auditArchive.generateAuditMd(data);

    expect(out).toContain('## Issues (2)');
    expect(out).toContain('### 1. A\nCA\n');
    expect(out).toContain('### 2. B\nCB\n');
    expect(out).not.toContain('### 10.');
    expect(out).not.toContain('### 42.');
  });
});

describe('appendToHistory', () => {
  it('creates a new history file when missing and inserts the archived section after the header delimiter', async () => {
    vi.useFakeTimers();
    const fixed = new Date('2020-01-02T03:04:05.000Z');
    vi.setSystemTime(fixed);

    const historyPath = '/repo/mod/AUDIT_HISTORY.md';
    const modulePath = 'mods/foo';
    const archivedIssues = [{ id: 1, title: 'Issue A', content: 'Details A' }];

    fs.readFile.mockRejectedValueOnce(new Error('ENOENT'));
    fs.writeFile.mockResolvedValueOnce();

    await auditArchive.appendToHistory(historyPath, archivedIssues, modulePath);

    const timestamp = fixed.toISOString();
    const expectedHeader = `# Audit History - foo\n\nArchived issues from security audits.\n\n---\n\n`;
    const expectedSection =
      `## Archived: 2020-01-02\n\n` +
      `### [RESOLVED] Issue A\n` +
      `*Archived: ${timestamp}*\n\n` +
      `Details A\n\n` +
      `---\n\n`;

    expect(fs.readFile).toHaveBeenCalledWith(historyPath, 'utf-8');
    expect(fs.writeFile).toHaveBeenCalledWith(historyPath, expectedHeader + expectedSection);
  });

  it('inserts a new archived section after the first header delimiter when the file already exists', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2020-01-02T03:04:05.000Z'));

    const historyPath = '/repo/mod/AUDIT_HISTORY.md';
    const modulePath = 'mods/foo';
    const archivedIssues = [{ id: 1, title: 'New', content: 'New content' }];

    const existing =
      `# Audit History - foo\n\nArchived issues from security audits.\n\n---\n\n` +
      `## Archived: 2019-01-01\n\nOld\n\n---\n\n`;

    fs.readFile.mockResolvedValueOnce(existing);
    fs.writeFile.mockResolvedValueOnce();

    await auditArchive.appendToHistory(historyPath, archivedIssues, modulePath);

    const written = fs.writeFile.mock.calls[0][1];
    expect(written.indexOf('## Archived: 2020-01-02')).toBeGreaterThan(0);
    expect(written.indexOf('## Archived: 2020-01-02')).toBeLessThan(written.indexOf('## Archived: 2019-01-01'));
  });

  it('appends when existing content has no header delimiter', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2020-01-02T03:04:05.000Z'));

    const historyPath = '/repo/mod/AUDIT_HISTORY.md';
    const modulePath = 'mods/foo';
    const archivedIssues = [{ id: 1, title: 'New', content: 'New content' }];

    const existing = `# Audit History - foo\n(no delimiter)\n`;

    fs.readFile.mockResolvedValueOnce(existing);
    fs.writeFile.mockResolvedValueOnce();

    await auditArchive.appendToHistory(historyPath, archivedIssues, modulePath);

    const written = fs.writeFile.mock.calls[0][1];
    expect(written.startsWith(existing)).toBe(true);
    expect(written).toContain('## Archived: 2020-01-02');
  });

  it('propagates fs.writeFile errors', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2020-01-02T03:04:05.000Z'));

    fs.readFile.mockRejectedValueOnce(new Error('ENOENT'));
    fs.writeFile.mockRejectedValueOnce(new Error('EACCES'));

    await expect(
      auditArchive.appendToHistory('/repo/mod/AUDIT_HISTORY.md', [{ id: 1, title: 'T', content: 'C' }], 'mods/foo')
    ).rejects.toThrow('EACCES');
  });
});

describe('main', () => {
  it('exits with usage when module path is missing', async () => {
    const exitSpy = stubExit();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    parseArgs.mockReturnValueOnce({ all: false, show: false, history: false, _: [] });

    await expect(auditArchive.main()).rejects.toThrow('process.exit:1');
    expect(errorSpy).toHaveBeenCalledWith(
      'Usage: node audit-archive.js <module-path> [issue-ids...] [--all] [--show] [--history]'
    );

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('exits when AUDIT.md does not exist', async () => {
    const exitSpy = stubExit();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    parseArgs.mockReturnValueOnce({ all: false, show: false, history: false, _: ['mod'] });

    const absPath = path.resolve('mod');
    const auditPath = path.join(absPath, 'AUDIT.md');
    fileExists.mockResolvedValueOnce(false);

    await expect(auditArchive.main()).rejects.toThrow('process.exit:1');
    expect(errorSpy).toHaveBeenCalledWith(`No AUDIT.md found at: ${auditPath}`);

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('shows current issues with --show and does not write files', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    parseArgs.mockReturnValueOnce({ all: false, show: true, history: false, _: ['mod'] });

    const absPath = path.resolve('mod');
    const auditPath = path.join(absPath, 'AUDIT.md');
    fileExists.mockResolvedValueOnce(true);
    fs.readFile.mockResolvedValueOnce(
      sampleAuditMd({
        severity: 'HIGH',
        issues: [
          { id: 1, title: 'First', content: 'A' },
          { id: 2, title: 'Second', content: 'B' }
        ]
      })
    );

    await auditArchive.main();

    expect(fs.readFile).toHaveBeenCalledWith(auditPath, 'utf-8');
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining(['Module: mod', 'Severity: HIGH', 'Issues: 2\n', '  1. First', '  2. Second'])
    );

    logSpy.mockRestore();
  });

  it('shows archive history with --history (and prints a message when missing)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    parseArgs.mockReturnValueOnce({ all: false, show: false, history: true, _: ['mod'] });

    const absPath = path.resolve('mod');
    const auditPath = path.join(absPath, 'AUDIT.md');
    const historyPath = path.join(absPath, 'AUDIT_HISTORY.md');

    fileExists.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    fs.readFile.mockResolvedValueOnce(sampleAuditMd({ issues: [{ id: 1, title: 'T', content: 'C' }] }));

    await auditArchive.main();

    expect(fs.readFile).toHaveBeenCalledWith(auditPath, 'utf-8');
    expect(fileExists).toHaveBeenCalledWith(historyPath);
    expect(logSpy).toHaveBeenCalledWith('No archive history found.');

    logSpy.mockRestore();
  });

  it('exits when no issue IDs are specified (and prints current issues)', async () => {
    const exitSpy = stubExit();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    parseArgs.mockReturnValueOnce({ all: false, show: false, history: false, _: ['mod'] });

    const absPath = path.resolve('mod');
    const auditPath = path.join(absPath, 'AUDIT.md');
    fileExists.mockResolvedValueOnce(true);
    fs.readFile.mockResolvedValueOnce(
      sampleAuditMd({
        issues: [
          { id: 1, title: 'First', content: 'A' },
          { id: 2, title: 'Second', content: 'B' }
        ]
      })
    );

    await expect(auditArchive.main()).rejects.toThrow('process.exit:1');

    expect(errorSpy).toHaveBeenCalledWith(
      'No issue IDs specified. Use --all to archive all issues, or specify issue numbers.'
    );
    expect(logSpy.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining(['\nCurrent issues:', '  1. First', '  2. Second'])
    );
    expect(fs.readFile).toHaveBeenCalledWith(auditPath, 'utf-8');
    expect(fs.writeFile).not.toHaveBeenCalled();

    exitSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('exits when specified IDs do not match any issues', async () => {
    const exitSpy = stubExit();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    parseArgs.mockReturnValueOnce({ all: false, show: false, history: false, _: ['mod', '99'] });

    fileExists.mockResolvedValueOnce(true);
    fs.readFile.mockResolvedValueOnce(
      sampleAuditMd({
        issues: [
          { id: 1, title: 'First', content: 'A' },
          { id: 2, title: 'Second', content: 'B' }
        ]
      })
    );

    await expect(auditArchive.main()).rejects.toThrow('process.exit:1');
    expect(errorSpy).toHaveBeenCalledWith('No matching issues found for the specified IDs.');

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('archives all issues with --all and cleans AUDIT.md (severity becomes NONE)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2020-01-02T03:04:05.000Z'));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    parseArgs.mockReturnValueOnce({ all: true, show: false, history: false, _: ['mod'] });

    const absPath = path.resolve('mod');
    const auditPath = path.join(absPath, 'AUDIT.md');
    const historyPath = path.join(absPath, 'AUDIT_HISTORY.md');

    fileExists.mockResolvedValueOnce(true);

    const auditContent = sampleAuditMd({
      severity: 'HIGH',
      issues: [
        { id: 1, title: 'First', content: 'A' },
        { id: 2, title: 'Second', content: 'B' }
      ]
    });

    fs.readFile.mockImplementation(async (p) => {
      if (p === auditPath) return auditContent;
      if (p === historyPath) throw new Error('ENOENT');
      throw new Error(`unexpected read: ${p}`);
    });
    fs.writeFile.mockResolvedValue();

    await auditArchive.main();

    const writes = fs.writeFile.mock.calls;
    const auditWrite = writes.find(([p]) => p === auditPath)?.[1];
    const historyWrite = writes.find(([p]) => p === historyPath)?.[1];

    expect(historyWrite).toContain('## Archived: 2020-01-02');
    expect(historyWrite).toContain('### [RESOLVED] First');
    expect(historyWrite).toContain('### [RESOLVED] Second');

    expect(auditWrite).toContain('Severity: **NONE**');
    expect(auditWrite).toContain('## Issues (0)');
    expect(auditWrite).toContain('No current issues. All previously identified issues have been resolved and archived to AUDIT_HISTORY.md.');

    expect(logSpy).toHaveBeenCalledWith('Archived 2 issue(s) to AUDIT_HISTORY.md');

    logSpy.mockRestore();
  });

  it('archives selected issues by ID and keeps remaining issues', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2020-01-02T03:04:05.000Z'));

    parseArgs.mockReturnValueOnce({ all: false, show: false, history: false, _: ['mod', '1'] });

    const absPath = path.resolve('mod');
    const auditPath = path.join(absPath, 'AUDIT.md');
    const historyPath = path.join(absPath, 'AUDIT_HISTORY.md');

    fileExists.mockResolvedValueOnce(true);

    const auditContent = sampleAuditMd({
      severity: 'HIGH',
      issues: [
        { id: 1, title: 'First', content: 'A' },
        { id: 2, title: 'Second', content: 'B' }
      ]
    });

    fs.readFile.mockImplementation(async (p) => {
      if (p === auditPath) return auditContent;
      if (p === historyPath) throw new Error('ENOENT');
      throw new Error(`unexpected read: ${p}`);
    });
    fs.writeFile.mockResolvedValue();

    await auditArchive.main();

    const writes = fs.writeFile.mock.calls;
    const auditWrite = writes.find(([p]) => p === auditPath)?.[1];
    const historyWrite = writes.find(([p]) => p === historyPath)?.[1];

    expect(historyWrite).toContain('### [RESOLVED] First');
    expect(historyWrite).not.toContain('### [RESOLVED] Second');

    expect(auditWrite).toContain('## Issues (1)');
    expect(auditWrite).toContain('### 1. Second\nB\n');
    expect(auditWrite).not.toContain('First\nA\n');
    expect(auditWrite).toContain('Severity: **HIGH**');
  });

  it('propagates write errors (e.g., when updating AUDIT.md)', async () => {
    parseArgs.mockReturnValueOnce({ all: true, show: false, history: false, _: ['mod'] });
    fileExists.mockResolvedValueOnce(true);

    const absPath = path.resolve('mod');
    const auditPath = path.join(absPath, 'AUDIT.md');
    const historyPath = path.join(absPath, 'AUDIT_HISTORY.md');
    const auditContent = sampleAuditMd({
      issues: [
        { id: 1, title: 'First', content: 'A' },
        { id: 2, title: 'Second', content: 'B' }
      ]
    });

    fs.readFile.mockImplementation(async (p) => {
      if (p === auditPath) return auditContent;
      if (p === historyPath) throw new Error('ENOENT');
      throw new Error(`unexpected read: ${p}`);
    });

    fs.writeFile.mockImplementation(async (p) => {
      if (p === historyPath) return;
      if (p === auditPath) throw new Error('EACCES');
      throw new Error(`unexpected write: ${p}`);
    });

    await expect(auditArchive.main()).rejects.toThrow('EACCES');
  });
});
