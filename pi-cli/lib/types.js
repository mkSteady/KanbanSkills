/**
 * Type definitions for project-index
 * @fileoverview JSDoc type definitions
 */

/**
 * @typedef {object} SourceConfig
 * @property {string[]} dirs - Source directories
 * @property {string} pattern - Glob pattern for source files
 * @property {string[]} [ignore] - Patterns to ignore
 */

/**
 * @typedef {object} TestConfig
 * @property {string[]} dirs - Test directories
 * @property {string} pattern - Glob pattern for test files
 * @property {string} cmd - Command to run tests
 * @property {string} framework - Test framework (vitest, jest, pytest, go, cargo, etc.)
 */

/**
 * @typedef {object} Conventions
 * @property {string} [testNaming] - Test file naming pattern, e.g. "{name}.test.js"
 * @property {string} [moduleSystem] - Module system: "esm", "commonjs", "mixed"
 * @property {string} [eventFormat] - Event naming format, e.g. "domain:action"
 * @property {string} [importStyle] - Import style: "relative", "absolute", "alias"
 */

/**
 * @typedef {object} LLMConfig
 * @property {string} [provider] - LLM provider (anthropic, openai, etc.)
 * @property {string} [model] - Model name
 * @property {string} [fixPrompt] - Custom prompt for test fixing
 * @property {string} [auditPrompt] - Custom prompt for code audit
 * @property {string} [docPrompt] - Custom prompt for doc generation
 */

/**
 * @typedef {object} ProjectConfig
 * @property {string} name - Project name
 * @property {string} language - Primary language (javascript, typescript, python, go, rust, etc.)
 * @property {SourceConfig} src - Source configuration
 * @property {TestConfig} test - Test configuration
 * @property {string} cache - Cache directory path
 * @property {Conventions} [conventions] - Project conventions (AI-fillable)
 * @property {LLMConfig} [llm] - LLM configuration
 */

/**
 * @typedef {object} DependencyNode
 * @property {string} file - File path
 * @property {string[]} imports - Files this file imports
 * @property {string[]} importedBy - Files that import this file
 * @property {number} [depth] - Depth in dependency tree
 */

/**
 * @typedef {object} DependencyGraph
 * @property {Map<string, DependencyNode>} nodes - All nodes
 * @property {string[]} roots - Root files (no importers)
 * @property {string[]} leaves - Leaf files (no imports)
 * @property {string[][]} cycles - Detected cycles
 */

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {number} skipped - Number of skipped tests
 * @property {TestError[]} errors - Error details
 * @property {number} duration - Total duration in ms
 */

/**
 * @typedef {object} TestError
 * @property {string} testFile - Test file path
 * @property {string} test - Test name
 * @property {string} message - Error message
 * @property {string} [expected] - Expected value
 * @property {string} [actual] - Actual value
 * @property {string} [stack] - Stack trace
 */

/**
 * @typedef {object} TestPriority
 * @property {string} file - Source file
 * @property {number} dependents - Number of files that depend on this
 * @property {string[]} failingTests - Tests that fail because of this file
 * @property {number} potentialFixes - Estimated tests fixed if this is fixed
 */

/**
 * @typedef {object} AuditIssue
 * @property {string} file - File path
 * @property {number} line - Line number
 * @property {string} severity - 'error' | 'warning' | 'info'
 * @property {string} rule - Rule identifier
 * @property {string} message - Issue description
 * @property {string} [suggestion] - Suggested fix
 */

/**
 * @typedef {object} StaleFile
 * @property {string} file - File path
 * @property {string} type - 'source' | 'test' | 'doc'
 * @property {number} mtime - Last modified time
 * @property {string[]} dependsOn - Files this depends on
 * @property {string[]} staleReason - Why it's stale
 */

export {};
