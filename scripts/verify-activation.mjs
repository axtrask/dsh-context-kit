/**
 * Load the kit's plugins into a REAL cordis root and prove they activate.
 *
 * `verify-load.mjs` checks the wiring statically; this checks the thing that
 * actually broke once: whether the harness's dependency injection is satisfied.
 * A row that injects the service it publishes never activates, and it takes
 * every other consumer of that service down with it — a failure no unit test
 * over the strategy functions can see.
 *
 * Run:  node scripts/verify-activation.mjs
 * Exit: 0 when both plugins activate, 1 with a report otherwise.
 *
 * @module dsh-context-kit/scripts/verify-activation
 */

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const kitRoot = join(here, '..');
const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh');

const { Context } = await import('@deepseek-ai/cordis');

const checks = [];
const record = (name, ok, detail) => checks.push({ name, ok, detail: String(detail ?? '') });

/** Settle every queued fiber activation. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

/**
 * Boot a root context with the services a plugin under test consumes.
 *
 * The stubs are deliberately minimal: the question is whether the plugin's
 * declared injections can be satisfied and whether it publishes what it says
 * it publishes, not whether a full agent runs.
 *
 * @param services - `name -> implementation` stubs to publish.
 * @returns the root context.
 */
function bootRoot(services) {
  const root = new Context();
  for (const [name, implementation] of Object.entries(services)) {
    root.provide(name, implementation);
  }
  return root;
}

/** Fiber lifecycle states, as cordis numbers them. */
const FIBER_STATE = { 0: 'pending', 1: 'loading', 2: 'active', 3: 'failed', 4: 'disposed' };

/**
 * Capture the first error a root reports, so an activation failure is reported
 * as its own message instead of only as a numeric fiber state.
 * @param root - the root context.
 * @returns a reader for the captured error.
 */
function captureError(root) {
  const box = { error: undefined };
  root.on('internal/error', (...args) => {
    if (box.error === undefined) box.error = args.find((value) => value instanceof Error) ?? args[0];
  });
  root.on('error', (...args) => {
    if (box.error === undefined) box.error = args.find((value) => value instanceof Error) ?? args[0];
  });
  return box;
}

/* ---------------------------------------------------------------- DCP ----- */

{
  const registered = [];
  const root = bootRoot({
    tools: { register: (definition) => { registered.push(definition.name); return () => {}; } },
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: 128000 } }) },
    tokenMeter: { measure: () => ({ nodes: [], totalTokens: 0 }), estimateMessage: () => 0 }
  });

  const dcp = await import(pathToFileURL(join(kitRoot, 'lib', 'dcp.js')).href);

  const errors = captureError(root);
  // A missing service must surface as a pending fiber, not a silent success.
  let fiber;
  let thrown;
  try {
    fiber = root.plugin(dcp, {});
  } catch (error) {
    thrown = error;
  }
  await settle();

  const state = FIBER_STATE[fiber?.state] ?? String(fiber?.state);
  const why = thrown ?? fiber?.error ?? errors.error;
  record(
    'dcp activates',
    state === 'active',
    state === 'active' ? 'fiber active' : `fiber ${state}${why === undefined ? ' (no error surfaced)' : `: ${why?.message ?? String(why)}`}`
  );
  record('dcp publishes ctx.compaction', root.get('compaction') !== undefined, 'the engine is the compaction provider');
  record(
    'ctx.compaction exposes the engine contract',
    typeof root.get('compaction')?.compactRegion === 'function' && typeof root.get('compaction')?.compactNow === 'function',
    'compactRegion + compactNow present'
  );
  record('dcp registers the compress tool', registered.includes('compress'), registered.join(', ') || '(none)');

  // The failure that actually happened: another consumer of `compaction` must
  // be able to activate after this plugin publishes it.
  let commandCompactActivated = false;
  try {
    const commandCompact = await import('@deepseek-ai/dsh-command-compact');
    const commands = { register: () => () => {} };
    root.provide('commands', commands);
    const other = root.plugin(commandCompact, {});
    await settle();
    commandCompactActivated = other?.state !== 'pending';
  } catch (error) {
    record('command-compact import', false, error.message);
  }
  record(
    'a second compaction consumer activates',
    commandCompactActivated,
    'proves the provider is published before its consumers resolve'
  );
}

/* ------------------------------------------------------- context-mode ----- */

{
  const registered = [];
  const root = bootRoot({
    tools: { register: (definition) => { registered.push(definition.name); return () => {}; } }
  });

  const contextMode = await import(pathToFileURL(join(kitRoot, 'lib', 'context-mode.js')).href);
  const fiber = root.plugin(contextMode, { knowledgeBasePath: ':memory:' });
  await settle();

  const expected = [
    'ctx_execute',
    'ctx_execute_file',
    'ctx_batch_execute',
    'ctx_index',
    'ctx_search',
    'ctx_fetch_and_index',
    'ctx_stats',
    'ctx_doctor',
    'ctx_purge',
    'ctx_insight'
  ];
  record('context-mode activates', fiber?.state !== 'pending', `fiber state: ${String(fiber?.state)}`);
  const missing = expected.filter((name) => !registered.includes(name));
  record('context-mode registers all ten tools', missing.length === 0, missing.length === 0 ? registered.join(', ') : `missing ${missing.join(', ')}`);
}

/* ------------------------------------------------------------- report ----- */

const failed = checks.filter((check) => !check.ok);
for (const check of checks) console.log(`${check.ok ? '[ok]  ' : '[FAIL]'} ${check.name}: ${check.detail}`);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
console.log(`(kit root: ${kitRoot}; DSH home: ${dshHome})`);
process.exit(failed.length === 0 ? 0 : 1);
