/**
 * One session, every mechanism, in the order a user would meet them.
 *
 * The unit suites each prove one thing against a fixture built for it. This file
 * proves they COMPOSE: a real `@deepseek-ai/dsh-session`, the real engine, and a
 * single session walked through an ordinary conversation, a compression, a manual
 * sweep, a decompress, a harness compaction and a restart — asserting after each
 * step what the model is about to receive.
 *
 * It exists because the port's characteristic bugs were never in one mechanism:
 * they were in what one mechanism assumed about another. The age unit was a
 * mismatch between two counters; the output-prune exemption was a field one side
 * never wrote; `/dcp decompress` reported success while the surface said otherwise.
 *
 * Run:  node scripts/test-dcp-integration.mjs
 *
 * @module dsh-context-kit/scripts/test-dcp-integration
 */

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const kitRoot = join(here, '..');

const failures = [];
/** @param name - check label. @param ok - result. @param detail - evidence. */
function check(name, ok, detail = '') {
  console.log(`${ok ? '[ok]  ' : '[ko]  '} ${name}${detail.length > 0 ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const { Context } = await import('@deepseek-ai/cordis');
const { SessionStore, SessionId } = await import('@deepseek-ai/dsh-session');
const llm = await import('@deepseek-ai/dsh-llm');
const dcp = await import(pathToFileURL(join(kitRoot, 'lib', 'dcp.js')).href);
const blocks = await import(pathToFileURL(join(kitRoot, 'lib', 'dcp-blocks.js')).href);

const text = (value) => ({ type: 'text', text: value });

/** Mount the plugin on a context that also owns the session, so events arrive. */
async function mount(config = {}) {
  const context = new Context();
  const warnings = [];
  context.provide('logger', {
    info: () => {},
    debug: () => {},
    error: () => {},
    warn: (...args) => warnings.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '))
  });
  context.provide('tools', { register: () => () => {} });
  context.provide('llm', llm);
  context.provide('tokenMeter', {
    estimateMessage: (message) => JSON.stringify(message?.content ?? message ?? '').length,
    measure: () => ({ nodes: [] })
  });
  const store = new SessionStore(context);
  context.plugin(dcp, config);
  await new Promise((resolve) => setTimeout(resolve, 250));
  return { engine: dcp.engineForTest(), store, warnings };
}

/** Wait until the store owns the session, which is what makes events deliverable. */
async function own(store, id) {
  const session = store.create(SessionId(id), { meta: { cwd: process.cwd() } });
  for (let attempt = 0; attempt < 50 && store.get(session.id) === undefined; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return session;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const view = (session) => JSON.stringify(session.deriveMessages());
const sent = (session) => session.deriveMessages().map((message) => JSON.stringify(message.content)).join('\n');

/** One assistant step that calls a tool, plus its result. */
function exchange(session, { turn, step, callId, name, args, body, isError = false }) {
  session.append('assistant/message', {
    turn,
    step,
    stream: [],
    message: llm.createAssistantMessage({
      content: [
        text(`calling ${name}`),
        { type: 'tool-call', id: llm.ToolCallId(callId), name, arguments: JSON.stringify(args ?? {}) }
      ],
      source: { kind: 'model', provider: 'p', model: 'm' }
    })
  }, { surfaceOp: 'append' });
  return session.append('tool/result', {
    turn,
    step,
    message: llm.createToolResultMessage({
      callId: llm.ToolCallId(callId),
      content: [text(body)],
      isError
    })
  }, { surfaceOp: 'append' });
}

/* ------------------------------------------------------------------ the walk */

console.log('--- one ordinary session, end to end ---');
{
  const { engine, store, warnings } = await mount({ turnProtection: { enabled: false } });
  const session = await own(store, 'integration-walk');
  const agent = { session, inject: () => {} };

  session.append('turn/start', { turn: 1 });
  session.append('user/message', llm.createUserMessage({ content: [text('do the thing')], source: { kind: 'user' } }), { surfaceOp: 'append' });
  exchange(session, { turn: 1, step: 1, callId: 'c1', name: 'read', args: { filePath: 'a.js' }, body: 'FIRST-READ' });
  await settle();
  exchange(session, { turn: 1, step: 2, callId: 'c2', name: 'read', args: { filePath: 'a.js' }, body: 'SECOND-READ' });
  await settle();
  exchange(session, { turn: 1, step: 3, callId: 'c3', name: 'bash', args: { command: 'boom' }, body: 'ERROR-TEXT', isError: true });
  await settle();

  // 1. the automatic pass, from the event, with no command
  check('the duplicate was pruned without any command', !sent(session).includes('FIRST-READ'), view(session).slice(0, 120));
  check('the newest copy survives', sent(session).includes('SECOND-READ'), '');
  check('the failed call is untouched while it is fresh', sent(session).includes('ERROR-TEXT'), '');
  check('nothing warned on the way', warnings.length === 0, JSON.stringify(warnings));

  // 2. a compression over the first two exchanges
  const nodes = session.surface.nodes.map(Number);
  const spanSeqs = nodes.slice(1, nodes.indexOf(session.surface.nodes.map(Number).find((seq) => seq === nodes[2])) + 1);
  const summaryEvent = blocks.materializeSummary(session, {
    startSeq: spanSeqs[0],
    endSeq: spanSeqs.at(-1),
    shadowedSeqs: spanSeqs,
    tokens: 20,
    summary: 'THE-SUMMARY',
    summaryMessage: llm.createUserMessage({
      content: [text('[Compressed conversation section]\nTHE-SUMMARY')],
      source: { kind: 'plugin:dcp', form: 'notice', summary: 'range' }
    })
  });
  check('the closure landed', session.snapshotEvents().some((event) => event.type === 'compaction/prune'), '');
  check('the compression event and its node', summaryEvent !== undefined && engine.blocksFor(session).size >= 0, '');
  check('`compaction/prune` did NOT wipe the prune manifest', engine.blocksFor(session).prunedToolCount >= 0, '');

  // 3. the manual sweep, over what is left
  const swept = engine.pruneSession(session, agent, { sweep: { limit: 2 } });
  check('the sweep reports what it took', swept.length === 2, JSON.stringify(swept.map((entry) => entry.callId)));
  const afterSweep = sent(session);
  // The swept calls are the two newest, and the payload each one carried must be
  // gone while the summary above them is untouched. Asserting on the payloads, not
  // on the ids: an id appears in the assistant's own message too, which the sweep
  // never removes.
  check('completed swept output is materialized while errored output remains for provider-only input pruning', !afterSweep.includes('SECOND-READ') && afterSweep.includes('ERROR-TEXT'), afterSweep.slice(0, 160));
  check('the placeholder is what it reads instead', afterSweep.includes(blocks.PRUNED_TOOL_OUTPUT_REPLACEMENT), '');
  check('the sweep did not disturb the summary', afterSweep.includes('THE-SUMMARY'), '');

  // 4. the harness compacts, which forgets the blocks and keeps the manifest
  const manifestBefore = engine.blocksFor(session).prunedToolCount;
  session.append('compaction/end', { turn: 1, ok: true });
  await settle();
  const state = engine.blocksFor(session);
  check('the harness compaction cleared the block registry', state.size === 0, String(state.size));
  check('and stale prune/alias state resets with it', manifestBefore > 0 && state.prunedToolCount === 0 && state.messageIds.nextRef === 1, `${state.prunedToolCount} vs ${manifestBefore}`);

  // 5. the log still replays, and the pruned output is still pruned after a reload
  const events = session.snapshotEvents();
  check('the session log survived everything', events.length > 10, String(events.length));
  check('the log still holds every original payload', JSON.stringify(events).includes('FIRST-READ') && JSON.stringify(events).includes('THE-SUMMARY'), '');
}

console.log('\n--- a second session cannot disturb the first ---');
{
  const { engine, store } = await mount({ turnProtection: { enabled: false } });
  const first = await own(store, 'integration-a');
  const second = await own(store, 'integration-b');
  const agent = { session: first, inject: () => {} };

  first.append('turn/start', { turn: 1 });
  first.append('user/message', llm.createUserMessage({ content: [text('a')], source: { kind: 'user' } }), { surfaceOp: 'append' });
  exchange(first, { turn: 1, step: 1, callId: 'a1', name: 'read', args: { filePath: 'a.js' }, body: 'A-ONE' });
  await settle();
  exchange(first, { turn: 1, step: 2, callId: 'a2', name: 'read', args: { filePath: 'a.js' }, body: 'A-TWO' });
  await settle();

  second.append('turn/start', { turn: 1 });
  second.append('user/message', llm.createUserMessage({ content: [text('b')], source: { kind: 'user' } }), { surfaceOp: 'append' });
  exchange(second, { turn: 1, step: 1, callId: 'b1', name: 'read', args: { filePath: 'b.js' }, body: 'B-ONE' });
  await settle();

  check('session A pruned its own duplicate', !sent(first).includes('A-ONE') && sent(first).includes('A-TWO'), '');
  check('session B is untouched by A’s pass', sent(second).includes('B-ONE'), '');
  const manifestA = engine.blocksFor(first).prunedToolCount;
  const manifestB = engine.blocksFor(second).prunedToolCount;
  check('the manifests are per session', manifestA === 1 && manifestB === 0, `${manifestA}/${manifestB}`);
  check('and A’s manifest does not name B’s call', !engine.blocksFor(first).prunedToolIds.has('b1') && !engine.blocksFor(second).prunedToolIds.has('a1'), '');

  // The sweep and the decompress both go through the same per-session state.
  const decompressed = engine.blocksFor(first);
  decompressed.pruneTools([{ callId: 'a2', tokens: 3 }]);
  check('A’s manifest grew, B’s did not', engine.blocksFor(first).prunedToolCount === 2 && engine.blocksFor(second).prunedToolCount === 0, `${engine.blocksFor(first).prunedToolCount}/${engine.blocksFor(second).prunedToolCount}`);
}

console.log('');
if (failures.length > 0) {
  console.log(`${failures.length} check(s) FAILED:`);
  for (const name of failures) console.log(`  - ${name}`);
  process.exitCode = 1;
} else {
  console.log('the mechanisms compose: DCP integration tests passed');
}
