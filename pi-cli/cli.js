#!/usr/bin/env node
/**
 * project-index CLI
 * Unified entry point for all project-index operations
 *
 * Usage:
 *   pi init                    # Initialize .pi-config.json
 *   pi deps build|impact|propagate|query
 *   pi test map|run|plan|fix|affected|prioritize|generate|analyze|status|result
 *   pi doc generate|check
 *   pi update [--only deps|test|doc] [--force]
 *   pi update --bg [--interval 60000]
 *   pi audit scan|fix|status|archive
 *   pi ui                      # Start dashboard
 */

import { parseArgs } from './lib/shared.js';
import { loadContext, initConfig, validateConfig } from './lib/context.js';

const VERSION = '2.0.0';

const COMMANDS = {
  init: {
    desc: 'Initialize .pi-config.json',
    usage: 'pi init [--force]'
  },
  deps: {
    desc: 'Dependency analysis',
    subs: ['build', 'impact', 'propagate', 'query'],
    usage: 'pi deps <build|impact|propagate|query> [options]'
  },
  test: {
    desc: 'Test operations',
    subs: ['map', 'run', 'plan', 'fix', 'affected', 'prioritize', 'generate', 'analyze', 'status', 'result'],
    usage: 'pi test <subcommand> [options]'
  },
  doc: {
    desc: 'Documentation',
    subs: ['generate', 'check', 'scan'],
    usage: 'pi doc <generate|check|scan> [options]'
  },
  audit: {
    desc: 'Code audit',
    subs: ['scan', 'fix', 'status', 'archive'],
    usage: 'pi audit <scan|fix|status|archive> [options]'
  },
  module: {
    desc: 'Module analysis',
    subs: ['analyze'],
    usage: 'pi module analyze [options]'
  },
  hook: {
    desc: 'Claude Code hooks',
    subs: ['init', 'install', 'uninstall', 'list', 'status'],
    usage: 'pi hook <subcommand> [name] [--global]'
  },
  task: {
    desc: 'Task management',
    subs: ['list', 'start', 'cancel', 'types'],
    usage: 'pi task <subcommand> [options]'
  },
  stale: {
    desc: 'Stale notifications',
    subs: ['notify', 'status'],
    usage: 'pi stale <notify|status> [options]'
  },
  update: {
    desc: 'Incremental cache/doc updates',
    usage: 'pi update [--only deps|test|doc] [--force] [--bg] [--interval <ms>]'
  },
  ui: {
    desc: 'Start web dashboard',
    usage: 'pi ui [--port=3008]'
  }
};

function showHelp() {
  console.log(`
project-index v${VERSION}
Unified project analysis and maintenance toolkit

Usage: pi <command> [subcommand] [options]

Commands:`);

  for (const [cmd, info] of Object.entries(COMMANDS)) {
    const subs = info.subs ? ` <${info.subs.join('|')}>` : '';
    console.log(`  ${cmd.padEnd(10)}${subs.padEnd(30)} ${info.desc}`);
  }

  console.log(`
Options:
  --help, -h      Show help
  --version, -v   Show version
  --json          Output as JSON
  --verbose       Verbose output

Examples:
  pi init                    # Create .pi-config.json
  pi deps build              # Build dependency graph
  pi update                  # Update deps/test/doc caches if stale
  pi update --bg             # Start background updater (polling)
  pi test plan               # Generate test fix plan
  pi test result             # Show cached test result summary
  pi test fix --concurrency=20
  pi audit scan --severity=error
  pi ui --port=3008
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    help: false,
    h: false,
    version: false,
    v: false,
    json: false,
    verbose: false
  });

  if (args.version || args.v) {
    console.log(VERSION);
    return;
  }

  if (args.help || args.h || args._.length === 0) {
    showHelp();
    return;
  }

  const command = args._[0];
  const subcommand = args._[1];

  if (!COMMANDS[command]) {
    console.error(`Unknown command: ${command}`);
    console.error('Run "pi --help" for usage');
    process.exitCode = 1;
    return;
  }

  // Handle init specially (no context needed)
  if (command === 'init') {
    const config = await initConfig(process.cwd(), { force: args.force });
    console.log(`Created .pi-config.json for "${config.name}" (${config.language})`);
    console.log('AI can now analyze the project and fill in conventions.');
    return;
  }

  // Load context for all other commands
  const { root, config, configPath, staleConfig } = await loadContext();

  if (args.verbose) {
    console.error(`Project: ${config.name} (${root})`);
  }

  // Validate config for operation
  const validation = validateConfig(config, command);
  if (!validation.valid) {
    console.error(`Config missing required fields for "${command}": ${validation.missing.join(', ')}`);
    console.error(`Edit ${configPath} or let AI fill in the missing fields.`);
    process.exitCode = 1;
    return;
  }

  // Route to command handler
  try {
    switch (command) {
      case 'deps':
        await handleDeps(subcommand, args, { root, config, staleConfig });
        break;
      case 'test':
        await handleTest(subcommand, args, { root, config, staleConfig });
        break;
      case 'doc':
        await handleDoc(subcommand, args, { root, config, staleConfig });
        break;
      case 'audit':
        await handleAudit(subcommand, args, { root, config, staleConfig });
        break;
      case 'module':
        await handleModule(subcommand, args, { root, config, staleConfig });
        break;
      case 'hook':
        await handleHook(subcommand, args, { root, config, staleConfig });
        break;
      case 'task':
        await handleTask(subcommand, args, { root, config, staleConfig });
        break;
      case 'stale':
        await handleStale(subcommand, args, { root, config, staleConfig });
        break;
      case 'update':
        await handleUpdate(args, { root, config, staleConfig });
        break;
      case 'ui':
        await handleUI(args, { root, config, staleConfig });
        break;
      default:
        console.error(`Command "${command}" not implemented yet`);
        process.exitCode = 1;
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    if (args.verbose) {
      console.error(err.stack);
    }
    process.exitCode = 1;
  }
}

/**
 * Handle deps subcommands
 */
async function handleDeps(sub, args, ctx) {
  const { buildGraph, analyzeImpact, propagateStale, queryDeps } = await import('./lib/deps/index.js');

  switch (sub) {
    case 'build':
      await buildGraph(ctx, args);
      break;
    case 'impact':
      await analyzeImpact(ctx, args);
      break;
    case 'propagate':
      await propagateStale(ctx, args);
      break;
    case 'query':
      await queryDeps(ctx, args);
      break;
    default:
      console.error(`Unknown deps subcommand: ${sub}`);
      console.error('Available: build, impact, propagate, query');
      process.exitCode = 1;
  }
}

/**
 * Handle test subcommands
 */
async function handleTest(sub, args, ctx) {
  const mod = await import('./lib/test/index.js');

  switch (sub) {
    case 'map':
      await mod.buildTestMap(ctx, args);
      break;
    case 'run':
      await mod.runTests(ctx, args);
      break;
    case 'plan':
      await mod.generatePlan(ctx, args);
      break;
    case 'fix':
      await mod.fixTests(ctx, args);
      break;
    case 'affected':
      await mod.findAffected(ctx, args);
      break;
    case 'prioritize':
      await mod.prioritize(ctx, args);
      break;
    case 'generate':
      await mod.generateTests(ctx, args);
      break;
    case 'analyze':
      await mod.analyzeTests(ctx, args);
      break;
    case 'status':
      await mod.analyzeTestStatus(ctx, args);
      break;
    case 'result':
      await mod.getResultSummary(ctx, args);
      break;
    default:
      console.error(`Unknown test subcommand: ${sub}`);
      console.error('Available: map, run, plan, fix, affected, prioritize, generate, analyze, status, result');
      process.exitCode = 1;
  }
}

/**
 * Handle doc subcommands
 */
async function handleDoc(sub, args, ctx) {
  const mod = await import('./lib/doc/index.js');

  switch (sub) {
    case 'generate':
      console.error('⚠️  doc generate is deprecated - it only creates empty templates without LLM analysis.');
      console.error('');
      console.error('Use module-analyzer.js instead for intelligent doc generation:');
      console.error('  node scripts/module-analyzer.js --stale        # Update stale docs');
      console.error('  node scripts/module-analyzer.js --all          # Update all docs');
      console.error('');
      console.error('Or use --force to generate basic templates anyway (not recommended).');
      if (!args.force) {
        process.exitCode = 1;
        return;
      }
      await mod.generate(ctx, args);
      break;
    case 'check':
    case 'scan':
      await mod.checkStale(ctx, args);
      break;
    default:
      console.error(`Unknown doc subcommand: ${sub}`);
      console.error('Available: generate, check, scan');
      process.exitCode = 1;
  }
}

/**
 * Handle audit subcommands
 */
async function handleAudit(sub, args, ctx) {
  const mod = await import('./lib/audit/index.js');

  switch (sub) {
    case 'scan':
      await mod.scan(ctx, args);
      break;
    case 'fix':
      await mod.fix(ctx, args);
      break;
    case 'status':
      await mod.status(ctx, args);
      break;
    case 'archive':
      await mod.archive(ctx, args);
      break;
    default:
      console.error(`Unknown audit subcommand: ${sub}`);
      console.error('Available: scan, fix, status, archive');
      process.exitCode = 1;
  }
}

/**
 * Handle UI command
 */
async function handleUI(args, ctx) {
  const { startServer } = await import('./ui/server.js');
  const port = args.port || 3008;
  await startServer(ctx, port);
}

/**
 * Handle module subcommands
 */
async function handleModule(sub, args, ctx) {
  const { analyzeModules } = await import('./lib/module/index.js');

  switch (sub) {
    case 'analyze':
      await analyzeModules(ctx, args);
      break;
    default:
      console.error(`Unknown module subcommand: ${sub}`);
      console.error('Available: analyze');
      process.exitCode = 1;
  }
}

/**
 * Handle hook subcommands
 */
async function handleHook(sub, args, ctx) {
  const hooks = await import('./lib/hooks/index.js');

  switch (sub) {
    case 'init':
      await hooks.init(ctx, args);
      break;
    case 'install':
      await hooks.install(ctx, args);
      break;
    case 'uninstall':
      await hooks.uninstall(ctx, args);
      break;
    case 'list':
      await hooks.list(ctx, args);
      break;
    case 'status':
      await hooks.status(ctx, args);
      break;
    default:
      console.error(`Unknown hook subcommand: ${sub}`);
      console.error('Available: init, install, uninstall, list, status');
      process.exitCode = 1;
  }
}

/**
 * Handle task subcommands
 */
async function handleTask(sub, args, ctx) {
  const { handleTask: taskHandler } = await import('./lib/task/index.js');
  await taskHandler(sub, args, ctx);
}

/**
 * Handle stale subcommands
 */
async function handleStale(sub, args, ctx) {
  const { notify } = await import('./lib/stale/index.js');

  switch (sub) {
    case 'notify':
      await notify(ctx, args);
      break;
    case 'status':
      await notify(ctx, { ...args, status: true });
      break;
    default:
      console.error(`Unknown stale subcommand: ${sub}`);
      console.error('Available: notify, status');
      process.exitCode = 1;
  }
}

/**
 * Handle update command
 */
async function handleUpdate(args, ctx) {
  const mod = await import('./lib/update/index.js');
  if (args.bg) {
    await mod.scheduleBackground(ctx, args);
  } else {
    await mod.update(ctx, args);
  }
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
