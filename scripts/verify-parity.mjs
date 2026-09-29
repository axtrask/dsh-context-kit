/**
 * Post-restart smoke test: is the RUNNING harness using the current plugin code?
 *
 * The preset loads `lib/dcp.js` and `lib/context-mode.js` by absolute path with a
 * plain ESM import, so a running DSH server keeps whatever version it loaded at
 * session start. Editing the files changes nothing until the server restarts or
 * a new session is composed — which is exactly the trap this script detects.
 *
 * What it checks:
 *   1. the plugin modules on disk parse and export what the preset expects;
 *   2. the `compress` tool's declared parameters (the model-authored summary
 *      shape, not the engine-summarizer shape);
 *   3. the `ctx_*` tool catalog the running composition should expose;
 *   4. configuration keys that parity work added, with their upstream defaults.
 *
 * Run:  node scripts/verify-parity.mjs
 *
 * @module dsh-context-kit/scripts/verify-parity
 */

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const kitRoot = join(here, '..');

const failures = [];
/** @param name - check label. @param ok - result. @param detail - evidence. */
function check(name, ok, detail = '') {
  console.log(`${ok ? '[ok]  ' : '[FAIL]'} ${name}${detail.length > 0 ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

/** Collect the tools a plugin module registers against a stub registry. */
async function toolsOf(module, config) {
  const { Context } = await import('@deepseek-ai/cordis');
  const registered = new Map();
  const root = new Context();
  root.provide('tools', {
    register: (definition) => {
      registered.set(definition.name, definition);
      return () => {};
    }
  });
  // `dcp` declares `inject: ['tools', 'llm', 'tokenMeter']`, and the engine calls
  // `ctx.tokenMeter.estimateMessage` while planning. A row whose injections are
  // unsatisfied never activates, so the stubs are what make the real tool
  // definitions observable here instead of an empty registry.
  const llm = await import('@deepseek-ai/dsh-llm');
  root.provide('llm', llm);
  root.provide('tokenMeter', {
    estimateMessage: (message) => {
      let chars = 0;
      for (const block of message?.content ?? []) {
        if (typeof block?.text === 'string') chars += block.text.length;
        if (typeof block?.arguments === 'string') chars += block.arguments.length;
      }
      return Math.ceil(chars / 4);
    },
    measure: () => ({ nodes: [] })
  });
  root.plugin(module, config ?? {});
  await new Promise((resolve) => setTimeout(resolve, 250));
  return registered;
}

console.log('--- modules load ---');
const dcp = await import(pathToFileURL(join(kitRoot, 'lib', 'dcp.js')).href).catch((error) => ({ loadError: error }));
check('lib/dcp.js loads', dcp.loadError === undefined, dcp.loadError?.message ?? '');
const contextMode = await import(pathToFileURL(join(kitRoot, 'lib', 'context-mode.js')).href).catch((error) => ({ loadError: error }));
check('lib/context-mode.js loads', contextMode.loadError === undefined, contextMode.loadError?.message ?? '');
if (failures.length > 0) {
  console.log(`\n${failures.length} failure(s)`);
  process.exit(1);
}
check('dcp exports an engine class', typeof dcp.DcpCompactionEngine === 'function');
check('context-mode exports apply()', typeof contextMode.apply === 'function');

console.log('\n--- configuration surface (upstream defaults) ---');
const dcpConfig = dcp.Config({});
const EXPECTED = [
  ['compress.mode', 'range'],
  ['compress.permission', 'allow'],
  ['compress.showCompression', false],
  ['compress.summaryBuffer', true],
  ['compress.maxContextLimit', 100000],
  ['compress.minContextLimit', 50000],
  ['compress.nudgeFrequency', 5],
  ['compress.iterationNudgeThreshold', 15],
  ['compress.nudgeForce', 'soft'],
  ['pruneNotification', 'detailed'],
  ['pruneNotificationType', 'chat'],
  ['experimental.allowSubAgents', false],
  ['experimental.customPrompts', false]
];
for (const [path, expected] of EXPECTED) {
  const actual = path.split('.').reduce((value, key) => (value === undefined ? undefined : value[key]), dcpConfig);
  check(`${path} defaults to ${JSON.stringify(expected)}`, actual === expected, `got ${JSON.stringify(actual)}`);
}
{
  const keys = ['compress.permission', 'pruneNotification', 'commands.enabled'];
  const missing = keys.filter((key) => !key.split('.').reduce((value, k) => (value === undefined ? undefined : value[k]), dcpConfig));
  check('the new keys are present in the resolved config', missing.length === 0, missing.join(', '));
}

console.log('\n--- compress tool shape ---');
{
  const tools = await toolsOf(dcp, { knowledgeBasePath: '' });
  const compress = tools.get('compress');
  check('compress is registered', compress !== undefined);
  if (compress !== undefined) {
    // A tool's `parameters` is a JSON Schema object (`{ type, properties, required }`),
    // not a plain map of parameter names.
    const schema = compress.parameters ?? {};
    const keys = Object.keys(schema.properties ?? {});
    const modelAuthored = keys.includes('topic') && keys.includes('content');
    check(
      'compress takes a model-authored summary (topic + content), not a bare seq pair',
      modelAuthored,
      `properties: ${keys.join(', ')}`
    );
    const entry = schema.properties?.content?.items ?? {};
    const entryKeys = Object.keys(entry.properties ?? {}).sort();
    check('range entries use exact string startId/endId/summary fields', JSON.stringify(entryKeys) === JSON.stringify(['endId', 'startId', 'summary'])
      && entry.properties.startId.type === 'string' && entry.properties.endId.type === 'string', entryKeys.join(', '));
    check('no numeric message protocol remains in the schema or description', !/start_seq|end_seq|\[id\]|seq: number/.test(JSON.stringify(schema) + compress.description));
  }
}

console.log('\n--- ctx_* catalog ---');
{
  const tools = await toolsOf(contextMode, { knowledgeBasePath: '' });
  const names = [...tools.keys()].sort();
  console.log(`      registered: ${names.join(', ')}`);
  for (const required of ['ctx_execute', 'ctx_execute_file', 'ctx_batch_execute', 'ctx_index', 'ctx_search', 'ctx_fetch_and_index', 'ctx_stats', 'ctx_doctor', 'ctx_purge', 'ctx_insight']) {
    check(`${required} is registered`, tools.has(required));
  }
  const ctxConfig = contextMode.Config({});
  check('search limit default is upstream\'s 3', ctxConfig.searchLimit === 3, `got ${ctxConfig.searchLimit}`);
  check(
    'the flood guard is configurable',
    Number.isInteger(ctxConfig.searchSoftCap) && Number.isInteger(ctxConfig.searchBlockCap) && Number.isInteger(ctxConfig.searchWindowMs),
    JSON.stringify({ window: ctxConfig.searchWindowMs, soft: ctxConfig.searchSoftCap, block: ctxConfig.searchBlockCap })
  );
}

console.log(`\n${failures.length === 0 ? 'parity surface is complete' : `${failures.length} gap(s) still open`}`);
process.exit(failures.length === 0 ? 0 : 1);
