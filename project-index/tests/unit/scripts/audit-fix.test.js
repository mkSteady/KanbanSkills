import { promises as fs } from 'fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  promises: {
    readFile: vi.fn(),
    readdir: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn()
  }
}));

vi.mock('../../../scripts/batch-llm-runner.js', () => ({
  runCodeagent: vi.fn()
}));

vi.mock('../../../scripts/shared.js', () => ({
  readJsonSafe: vi.fn(),
  writeJsonSafe: vi.fn(),
  fileExists: vi.fn(),
  loadConfig: vi.fn(),
  parseArgs: vi.fn()
}));

/** @type {import('../../../scripts/audit-fix.js')} */
let auditFix;

beforeEach(async () => {
  vi.clearAllMocks();
  auditFix = await import('../../../scripts/audit-fix.js');
});

describe('parseAuditFile', () => {
  it('parses multiple issues, including code snippet, and sets fixable based on type and severity', async () => {
    fs.readFile.mockResolvedValueOnce(`# Audit

## Issues

### [LOW] Add JSDoc for foo
- **File**: src/foo.js:12
- **Description**: Missing JSDoc for exported function.
- **Suggestion**: Add docs

\`\`\`javascript
function foo() {}
\`\`\`

### [CRITICAL] Remove console.log
- **File**: src/bar.js:5
- **Description**: Uses console.log in production
- **Suggestion**: Remove logging
`);

    const result = await auditFix.parseAuditFile('/repo/module/AUDIT.md');

    expect(fs.readFile).toHaveBeenCalledTimes(1);
    expect(fs.readFile).toHaveBeenCalledWith('/repo/module/AUDIT.md', 'utf-8');
    expect(result).toEqual(
      expect.objectContaining({
        modulePath: '/repo/module',
        issues: expect.any(Array)
      })
    );
    expect(result.issues).toHaveLength(2);

    expect(result.issues[0]).toEqual(
      expect.objectContaining({
        id: 'issue-0',
        severity: 'LOW',
        title: 'Add JSDoc for foo',
        file: 'src/foo.js',
        line: 12,
        description: 'Missing JSDoc for exported function.',
        suggestion: 'Add docs',
        type: 'missing_jsdoc',
        fixable: true
      })
    );
    expect(result.issues[0].codeSnippet).toContain('```javascript');
    expect(result.issues[0].codeSnippet).toContain('function foo()');

    expect(result.issues[1]).toEqual(
      expect.objectContaining({
        id: 'issue-1',
        severity: 'CRITICAL',
        title: 'Remove console.log',
        file: 'src/bar.js',
        line: 5,
        type: 'console_log',
        fixable: false
      })
    );
  });

  it('handles missing fields and invalid line numbers', async () => {
    fs.readFile.mockResolvedValueOnce(`# Audit

### [MEDIUM] Something unclear
- **File**: src/no-line.js
- **Description**: Unknown issue type

### [HIGH] Bad line number
- **File**: src/weird.js:abc
`);

    const result = await auditFix.parseAuditFile('/repo/module/AUDIT.md');

    expect(result.issues).toHaveLength(2);
    expect(result.issues[0]).toEqual(
      expect.objectContaining({
        severity: 'MEDIUM',
        file: 'src/no-line.js',
        line: 0,
        suggestion: '',
        codeSnippet: '',
        type: 'unknown',
        fixable: false
      })
    );
    expect(result.issues[1]).toEqual(
      expect.objectContaining({
        severity: 'HIGH',
        file: 'src/weird.js',
        line: 0,
        description: '',
        suggestion: '',
        type: 'unknown',
        fixable: false
      })
    );
  });

  it('ignores blocks that do not match the expected issue header format', async () => {
    fs.readFile.mockResolvedValueOnce(`# Audit

## Issues
### [low] Not recognized (lowercase severity)
- **File**: src/a.js:1

### [LOW] Valid issue
- **File**: src/b.js:2
- **Description**: TODO: fix later
`);

    const result = await auditFix.parseAuditFile('/repo/module/AUDIT.md');

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toEqual(
      expect.objectContaining({
        severity: 'LOW',
        file: 'src/b.js',
        line: 2,
        type: 'todo_fixme',
        fixable: true
      })
    );
  });

  it('returns empty issues when no valid issue blocks exist', async () => {
    fs.readFile.mockResolvedValueOnce(`# Audit

## Issues

- No issues listed yet
`);

    const result = await auditFix.parseAuditFile('/repo/module/AUDIT.md');
    expect(result.issues).toEqual([]);
  });

  it('propagates fs.readFile errors', async () => {
    fs.readFile.mockRejectedValueOnce(new Error('read failed'));
    await expect(auditFix.parseAuditFile('/repo/module/AUDIT.md')).rejects.toThrow('read failed');
  });
});

describe('inferIssueType', () => {
  it('classifies known issue types (case-insensitive)', () => {
    expect(auditFix.inferIssueType('Add JSDoc', '')).toBe('missing_jsdoc');
    expect(auditFix.inferIssueType('', 'Update documentation for module')).toBe('missing_jsdoc');
    expect(auditFix.inferIssueType('Remove console.log', '')).toBe('console_log');
    expect(auditFix.inferIssueType('', 'Avoid console.warn in prod')).toBe('console_log');
    expect(auditFix.inferIssueType('TODO: refactor', '')).toBe('todo_fixme');
    expect(auditFix.inferIssueType('Fixme in code', '')).toBe('todo_fixme');
    expect(auditFix.inferIssueType('Magic number in code', '')).toBe('magic_number');
    expect(auditFix.inferIssueType('', 'Hardcoded value in request')).toBe('magic_number');
    expect(auditFix.inferIssueType('Event naming mismatch', '')).toBe('event_naming');
    expect(auditFix.inferIssueType('Missing export', '')).toBe('export_missing');
    expect(auditFix.inferIssueType('Unused import detected', '')).toBe('unused_import');
    expect(auditFix.inferIssueType('Missing error handling', '')).toBe('missing_error_handling');
    expect(auditFix.inferIssueType('Deprecated API usage', '')).toBe('deprecated_api');
  });

  it('returns unknown when no rules match', () => {
    expect(auditFix.inferIssueType('', '')).toBe('unknown');
    expect(auditFix.inferIssueType('Improve performance', 'Consider caching')).toBe('unknown');
  });

  it('uses rule order when multiple patterns match', () => {
    expect(auditFix.inferIssueType('Export and unused import', 'unused import in file')).toBe('export_missing');
  });
});

