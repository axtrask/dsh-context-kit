/**
 * The wire branch of the editor, driven through the PRODUCTION mount path.
 *
 * The claim under test is not "the overlay works when a test installs it" — that was
 * already true of `scripts/probe-wire-and-copytail.mjs`, and it was exactly the reason
 * the feature could be dead for weeks: the overlay was written, tested in isolation,
 * and never mounted. The claim here is the one that failed before: **`apply()` mounts
 * it**, on a real cordis root, for a real session, with the config the plugin resolves.
 * Nothing in this file calls `installWireOverlay`; if `apply` stops calling it, every
 * positive check below fails.
 *
 * The second thing it pins is what the two halves of the feature promise. After an
 * assistant edit is recorded:
 *
 *  - the ADAPTER receives the edited text (the provider's view changed);
 *  - the session log is byte-identical and `deriveMessages()` still shows the original
 *    (the record did not change).
 *
 * A counterfactual runs in the same process, on a second root with no plugin: the same
 * edit in a store nobody installed changes nothing at the adapter. Without it, the
 * positive checks could be passing for a reason that has nothing to do with the overlay.
 *
 * Run:  node scripts/test-edit-wire.mjs
 *
 * @module dsh-context-kit/scripts/test-edit-wire
 */

import { rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const kitRoot = join(here, '..');
// Its own home, wiped first: the store persists a recorded edit under
// `$DSH_HOME/context-kit/edits/`, and a leftover file from an earlier run would make
// this test's result depend on which test ran before it.
const scratchHome = join(kitRoot, '.suite-state', 'edit-wire-test');
if (!statSync(dirname(scratchHome)).isDirectory()) throw new Error('missing suite parent');
rmSync(scratchHome, { recursive: true, force: true });
process.env.DSH_HOME = scratchHome;
process.env.XDG_CONFIG_HOME = join(scratchHome, 'xdg');
process.env.OPENCODE_CONFIG_DIR = join(scratchHome, 'opencode');

const failures = [];
/** @param name - what is being asserted. @param ok - outcome. @param detail - evidence. */
function check(name, ok, detail = '') {
  console.log(`${ok ? '[ok]  ' : '[FAIL]'} ${name}${detail.length > 0 ? ` - ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const { Context } = await import('@deepseek-ai/cordis');
const llm = await import('@deepseek-ai/dsh-llm');
const { Session, SessionStore, SessionId } = await import('@deepseek-ai/dsh-session');
const dcp = await import(`${new URL('../lib/dcp.js', import.meta.url).href}`);
const bridge = await import(`${new URL('../lib/edit-bridge.js', import.meta.url).href}`);
const durable = await import(`${new URL('../lib/edit-durable.js', import.meta.url).href}`);
const edit = await import(`${new URL('../lib/edit.js', import.meta.url).href}`);
const gui = await import(`${new URL('../lib/edit-gui.js', import.meta.url).href}`);

const text = (value) => ({ type: 'text', text: value });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const withoutDcpTag = (value) => typeof value === 'string'
  ? value.replace(/\n\n<dcp-message-id>m(?:\d{4}|[1-9]\d{4})<\/dcp-message-id>\s*$/u, '')
  : value;

/**
 * A root with an `LlmRuntime` on it, whose adapter records EVERY request it is handed.
 *
 * Every call, not the last one: a leak that happens on an earlier provider call is
 * exactly the kind of leak a single-slot capture cannot see. The runtime is created
 * FIRST and publishes the `llm` service itself, so the harness must not provide one.
 *
 * @returns the root, its runtime, and the serialized requests that reached the adapter.
 */
function makeRoot() {
  const context = new Context();
  const runtime = new llm.LlmRuntime(context);
  const calls = [];
  class CaptureAdapter extends llm.LlmAdapter {
    /** @param provider - provider id. @param model - model id. @param signal - abort signal. */
    async prepareCall(provider, model, signal) {
      return { model: await this.resolveModel(provider, model, signal), stream: (options) => this.stream(options) };
    }

    /** @param options - the request the runtime hands the adapter. */
    async *stream(options) {
      calls.push(JSON.stringify(options));
      yield { type: 'text', delta: 'x' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  runtime.registerAdapter(['stub'], new CaptureAdapter());
  return { context, runtime, calls };
}

/** A request the agent loop would make, marked the way the loop marks it. */
const requestFor = (session) => llm.markAgentLoopRequest(Object.freeze({
  provider: 'stub',
  model: 'stub',
  messages: session.deriveMessages(),
  sessionId: String(session.id),
  signal: undefined
}));

/** Drain a stream, counting nothing but making sure it completes. */
async function drain(runtime, request) {
  let chunks = 0;
  for await (const _chunk of runtime.stream(request)) chunks += 1;
  return chunks;
}

/** A context with the plugin mounted exactly as a preset row mounts it. */
async function mountPlugin(rowConfig) {
  const { context, runtime, calls } = makeRoot();
  const infos = [];
  const warnings = [];
  // The logger is SHADOWED, not provided. `context.provide('logger', ...)` does not
  // work here: cordis installs a `LoggerService` as an own property of every root
  // (`cordis/lib/index.js:1687`), `provide` does not replace it, and every captured
  // line goes to the real sink instead - so a check reading the capture array passes
  // on an empty array and proves nothing. Assigning onto the instance is what
  // actually intercepts `ctx.logger.info`.
  context.logger.info = (...args) => infos.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
  context.logger.warn = (...args) => warnings.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
  context.provide('tools', { register: () => () => {} });
  context.provide('tokenMeter', {
    estimateMessage: (message) => JSON.stringify(message?.content ?? message ?? '').length,
    measure: () => ({ nodes: [] })
  });
  const store = new SessionStore(context);
  const fiber = context.plugin(dcp, rowConfig);
  await new Promise((resolve) => setTimeout(resolve, 250));
  return { context, runtime, calls, store, fiber, infos, warnings };
}

/**
 * How many listeners are registered for an event on the root.
 *
 * `events._hooks` is private, and it is read here on purpose: the claim under test is
 * "apply() registers a listener", and the honest way to observe a registration is to
 * look at the registry rather than to infer it from behaviour that another component
 * could also produce. The count is only ever compared with itself across a dispose.
 *
 * @param context - the root context.
 * @param name - the event name.
 * @returns the number of registered listeners.
 */
function listenerCount(context, name) {
  const hooks = context?.events?._hooks?.[name];
  return Array.isArray(hooks) ? hooks.length : -1;
}

/** A live session with one question and one reply, as the loop writes them. */
async function fixture(store, id, replyBlocks = [text('REPLY-ORIGINAL')], userBlocks = [text('QUESTION')]) {
  const session = store.create(SessionId(id), { meta: { cwd: process.cwd() } });
  for (let attempt = 0; attempt < 50 && store.get(session.id) === undefined; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  session.append('turn/start', { turn: 1 });
  session.append('user/message', llm.createUserMessage({ content: userBlocks, source: { kind: 'user' } }), { surfaceOp: 'append' });
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    stream: [],
    message: llm.createAssistantMessage({
      content: replyBlocks,
      source: { kind: 'model', provider: 'stub', model: 'stub' }
    })
  }, { surfaceOp: 'append' });
  await tick();
  return session;
}

/* --------------------------------------------------- the production mount path */

console.log('--- the plugin mounts the overlay by itself ---');

const { context, runtime, calls, store, infos, warnings, fiber } = await mountPlugin({ editor: { enabled: true, requireIdle: false } });
const session = await fixture(store, 'edit-wire-live');
const sessionId = String(session.id);

check(
  'the row config reached the engine, so the editor is on',
  dcp.engineForTest()?.dcpConfig?.editor?.enabled === true,
  JSON.stringify(dcp.engineForTest()?.dcpConfig?.editor ?? null)
);
// THE CHECK THAT WOULD HAVE CAUGHT THE DEAD OVERLAY. It was written, unit-tested and
// never mounted; the registry is where a mount is visible and code review is not.
const mountedListeners = listenerCount(context, 'llm/stream');
check('apply mounted a listener on llm/stream', mountedListeners >= 1, `listeners=${mountedListeners}`);
check('the plugin published a wire store for the panel', bridge.publishedStores() === 1, String(bridge.publishedStores()));
const wireStore = bridge.editStoreFor(sessionId);
check('the store is reachable by session id, which is how the panel finds it', wireStore !== undefined, wireStore === undefined ? 'no store published' : 'store found');

const entries = durable.editableIndex(session);
const reply = entries.find((entry) => entry.type === 'assistant/message');
check('the reply is on the index', reply !== undefined, JSON.stringify(entries.map((entry) => entry.type)));
check(
  'and the shared rule sends it to the wire, not to the log',
  reply !== undefined && durable.editability(reply).branch === 'wire',
  JSON.stringify(reply === undefined ? null : durable.editability(reply))
);

const recorded = wireStore.record(sessionId, reply.message, 'REPLY-EDITED-ON-THE-WIRE', {
  messageIndex: reply.index,
  messageId: reply.id,
  expected: reply.text
});
check('the store records the edit', recorded.ok === true, JSON.stringify(recorded.reason ?? recorded.edit?.id ?? ''));
check('and the edit is held for THIS session only', wireStore.editsFor('some-other-session').length === 0, '');

/* ------------------------------------------------------ the provider's view */

console.log('--- the adapter is handed the edited text ---');

const logBefore = JSON.stringify(session.snapshotEvents());
const messagesBefore = JSON.stringify(session.deriveMessages());
check('the request the session derives still carries the ORIGINAL reply', messagesBefore.includes('REPLY-ORIGINAL'), '');

const chunks = await drain(runtime, requestFor(session));
await tick();

check('the stream completed', chunks > 0, `chunks=${chunks}`);
check(
  'the ADAPTER receives the edited text',
  calls.some((call) => call.includes('REPLY-EDITED-ON-THE-WIRE')),
  `adapter calls=${calls.length}`
);
check(
  'and no adapter call carries the original reply text',
  calls.length > 0 && calls.every((call) => !call.includes('REPLY-ORIGINAL')),
  `calls containing the original=${calls.filter((call) => call.includes('REPLY-ORIGINAL')).length}`
);
// The positive checks above would also pass if some OTHER listener rewrote the request.
// This is the plugin's own observer, called from the listener `apply` installed.
check(
  'the listener that did it is the plugin\'s own, and it reported the edit',
  infos.some((line) => /assistant edit applied on the wire/.test(line)),
  JSON.stringify(infos.filter((line) => /wire/.test(line)).slice(0, 3))
);
check('the overlay reported no error', !warnings.some((line) => /wire overlay failed/.test(line)), JSON.stringify(warnings.slice(0, 3)));

/* ------------------------------------------------------- what did NOT change */

console.log('--- the session log is untouched ---');

check('the log did not gain a single event', JSON.stringify(session.snapshotEvents()) === logBefore, `${logBefore.length} -> ${JSON.stringify(session.snapshotEvents()).length} bytes`);
check('the surface still holds the original node', JSON.stringify(session.deriveMessages()) === messagesBefore, '');
check(
  'the reply the session reports is still the original, word for word',
  durable.editableIndex(session).find((entry) => entry.type === 'assistant/message')?.text === 'REPLY-ORIGINAL',
  durable.editableIndex(session).find((entry) => entry.type === 'assistant/message')?.text ?? ''
);
check(
  'the edit is persisted where the overlay reads it from, so a restart keeps it',
  wireStore.editsFor(sessionId)[0]?.after === 'REPLY-EDITED-ON-THE-WIRE',
  JSON.stringify(wireStore.editsFor(sessionId)[0]?.after ?? null)
);

/* ---------------------------------------------- the chain of thought, on the wire */

console.log('--- a reply that says nothing but its thinking ---');

// A DeepSeek turn before a tool call carries no text block at all, so the THINKING is the
// only thing such a reply says and the only thing an edit can target. This is the case the
// CoT branch of `applyEditToMessage` exists for: without it the block falls through to the
// tool-result branch and the adapter receives the ORIGINAL thinking under a report of success.
const cotSession = await fixture(store, 'edit-wire-cot', [{ type: 'reasoning', text: 'THINKING-BEFORE-TOOL' }]);
const cotId = String(cotSession.id);
const cotReply = durable.editableIndex(cotSession).find((entry) => entry.type === 'assistant/message');
check(
  'the thinking-only reply carries its thinking as the text to edit',
  cotReply?.text === 'THINKING-BEFORE-TOOL',
  String(cotReply?.text)
);
check(
  'and the shared rule offers it on the wire',
  cotReply !== undefined && durable.editability(cotReply).branch === 'wire',
  JSON.stringify(cotReply === undefined ? null : durable.editability(cotReply))
);
const cotRecorded = wireStore.record(cotId, cotReply.message, 'THINKING-EDITED-ON-THE-WIRE', {
  messageIndex: cotReply.index,
  messageId: cotReply.id,
  expected: cotReply.text
});
check('the store records an edit of the thinking', cotRecorded.ok === true, JSON.stringify(cotRecorded.reason ?? cotRecorded.edit?.id ?? ''));

const cotBefore = calls.length;
await drain(runtime, requestFor(cotSession));
await tick();
check(
  'the ADAPTER receives the edited thinking',
  calls.slice(cotBefore).some((call) => call.includes('THINKING-EDITED-ON-THE-WIRE')),
  `calls=${calls.length - cotBefore}`
);
check(
  'and no adapter call carries the original thinking',
  calls.slice(cotBefore).length > 0 && calls.slice(cotBefore).every((call) => !call.includes('THINKING-BEFORE-TOOL')),
  ''
);
check(
  'the session still reports the original thinking',
  durable.editableIndex(cotSession).find((entry) => entry.type === 'assistant/message')?.text === 'THINKING-BEFORE-TOOL',
  ''
);

/* ------------------------------------- a reply that thinks AND answers */

console.log('--- a reply that thinks and answers: the NAMED block is the one that changes ---');

// A DeepSeek turn that says both things. `entry.text` is the ANSWER - the only block a
// single pencil could reach - so the thinking of such a reply was unreachable from the
// panel. It is reachable by BLOCK now, and the two blocks are given the SAME string on
// purpose: by text alone the store rewrites the FIRST block holding it, which is the
// thinking, so an edit aimed at the answer would land on the thinking and report success.
const bothSession = await fixture(store, 'edit-wire-cot-both', [{ type: 'reasoning', text: 'SAME WORDS' }, text('SAME WORDS')]);
const bothId = String(bothSession.id);
const bothReply = durable.editableIndex(bothSession).find((entry) => entry.type === 'assistant/message');

const bothTargets = durable.blockTargets(bothReply);
check(
  'the reply offers two targets, the thinking and the answer',
  bothTargets.length === 2,
  JSON.stringify(bothTargets.map((target) => [target.at, target.kind, target.label]))
);
check(
  'the thinking is block 0 and the answer is block 1',
  bothTargets[0]?.kind === 'reasoning' && bothTargets[1]?.kind === 'text',
  JSON.stringify(bothTargets.map((target) => target.kind))
);
check(
  'both are offered as editable',
  bothTargets.every((target) => target.editable === true),
  JSON.stringify(bothTargets.map((target) => target.reason ?? null))
);
check('the message-level text is still the answer', bothReply?.text === 'SAME WORDS', String(bothReply?.text));
check(
  'and by text alone the FIRST block would win, which is the thinking',
  edit.cursorBlockIndex(bothReply?.message, bothReply?.text) === 0,
  String(edit.cursorBlockIndex(bothReply?.message, bothReply?.text))
);

const thinkingRecorded = wireStore.record(bothId, bothReply.message, 'THINKING-EDITED-BY-BLOCK', {
  messageIndex: bothReply.index,
  messageId: bothReply.id,
  expected: bothTargets[0].text,
  blockAt: bothTargets[0].at
});
check(
  'the store records the edit of block 0',
  thinkingRecorded.ok === true && thinkingRecorded.edit?.cursor.block === 0,
  JSON.stringify(thinkingRecorded.reason ?? thinkingRecorded.edit?.cursor)
);

/** The assistant message one adapter call carried, or `undefined`. */
const sentReply = (call) => (call.messages ?? []).find((message) => message?.role === 'assistant'
  && Array.isArray(message.content) && message.content.length === 2
  && message.content.some((block) => block?.type === 'reasoning'));

const bothBefore = calls.length;
await drain(runtime, requestFor(bothSession));
await tick();
const bothSent = calls.slice(bothBefore)
  .map((call) => JSON.parse(call))
  .map(sentReply)
  .find((message) => message !== undefined);

check('the adapter receives the reply', bothSent !== undefined, `calls=${calls.length - bothBefore}`);
check(
  'the THINKING is the text that changed',
  bothSent?.content?.[0]?.text === 'THINKING-EDITED-BY-BLOCK',
  JSON.stringify(bothSent?.content?.[0] ?? null)
);
check(
  'and the ANSWER block was not touched',
  withoutDcpTag(bothSent?.content?.[1]?.text) === 'SAME WORDS',
  JSON.stringify(bothSent?.content?.[1] ?? null)
);
check(
  'the two blocks kept their kinds and order',
  bothSent?.content?.[0]?.type === 'reasoning' && bothSent?.content?.[1]?.type === 'text',
  JSON.stringify((bothSent?.content ?? []).map((block) => block?.type))
);
check(
  'the plugin reported the block it rewrote',
  infos.some((line) => /assistant edit applied on the wire/u.test(line) && /block 0/u.test(line)),
  JSON.stringify(infos.filter((line) => /wire/u.test(line)).slice(-2))
);

// The other direction, on a session of its own: the SAME text aimed at block 1 must change
// the answer and leave the thinking alone. Without this the check above would pass for an
// overlay that always rewrote block 0.
const answerSession = await fixture(store, 'edit-wire-cot-answer', [{ type: 'reasoning', text: 'SAME WORDS' }, text('SAME WORDS')]);
const answerId = String(answerSession.id);
const answerReply = durable.editableIndex(answerSession).find((entry) => entry.type === 'assistant/message');
const answerRecorded = wireStore.record(answerId, answerReply.message, 'ANSWER-EDITED-BY-BLOCK', {
  messageIndex: answerReply.index,
  messageId: answerReply.id,
  expected: 'SAME WORDS',
  blockAt: 1
});
check(
  'the store records the edit of block 1',
  answerRecorded.ok === true && answerRecorded.edit?.cursor.block === 1,
  JSON.stringify(answerRecorded.reason ?? answerRecorded.edit?.cursor)
);
const answerBefore = calls.length;
await drain(runtime, requestFor(answerSession));
await tick();
const answerSent = calls.slice(answerBefore)
  .map((call) => JSON.parse(call))
  .map(sentReply)
  .find((message) => message !== undefined);
check(
  'the ANSWER is the text that changed',
  withoutDcpTag(answerSent?.content?.[1]?.text) === 'ANSWER-EDITED-BY-BLOCK',
  JSON.stringify(answerSent?.content?.[1] ?? null)
);
check(
  'and the thinking is still the original words',
  answerSent?.content?.[0]?.text === 'SAME WORDS',
  JSON.stringify(answerSent?.content?.[0] ?? null)
);
check(
  'the session still reports the original reply, word for word',
  durable.editableIndex(answerSession).find((entry) => entry.type === 'assistant/message')?.text === 'SAME WORDS',
  ''
);

/* ------------------------------------------------------------ counterfactual */

console.log('--- registered GUI saves chain into the production request overlay ---');
const chainSession = await fixture(store, 'edit-wire-gui-chain');
const chainId = String(chainSession.id);
const chainReply = durable.editableIndex(chainSession).find((entry) => entry.type === 'assistant/message');
let route;
const disposeGui = gui.installEditGui({
  get: (key) => key === 'sessions' ? store : key === 'connection' ? { rpc: { handle() {} } } : key === 'webServer' ? {
    register: (value) => { route = value; return () => {}; }, tapIndex: () => () => {}
  } : undefined,
  effect: (body) => body()
}, dcp.engineForTest());
const callThroughRoute = async (method, payload) => {
  const body = JSON.stringify({ type: 'client-request', rpcId: 'chain', method, payload });
  let answer;
  await route.handler({
    url: `${gui.EDIT_CHANNEL}/${method}`, method: 'POST', headers: { 'content-type': 'application/json' },
    on(event, handler) { if (event === 'data') handler(Buffer.from(body)); if (event === 'end') handler(); return this; }, destroy() {}
  }, { writeHead() { return this; }, end(chunk) { answer = JSON.parse(chunk); } });
  return answer.result.value;
};
const chainLog = JSON.stringify(chainSession.snapshotEvents());
const chainTarget = { sessionId: chainId, seq: chainReply.seq, id: chainReply.id, block: 0 };
const saveB = await callThroughRoute(gui.EDIT_METHODS.commit, { ...chainTarget, expected: 'REPLY-ORIGINAL', text: 'GUI-B' });
const saveC = await callThroughRoute(gui.EDIT_METHODS.commit, { ...chainTarget, expected: 'GUI-B', text: 'GUI-C' });
check('both GUI saves succeeded and second audit starts at B', saveB.ok && saveC.ok && saveC.report?.before === 'GUI-B', JSON.stringify(saveC));
const beforeChain = calls.length;
await drain(runtime, requestFor(chainSession));
check('production adapter receives C, never original or B', calls.length > beforeChain && calls.slice(beforeChain).every((call) => call.includes('GUI-C') && !call.includes('GUI-B') && !call.includes('REPLY-ORIGINAL')));
check('GUI saves leave the real session log unchanged', JSON.stringify(chainSession.snapshotEvents()) === chainLog);
const persistedChain = edit.createEditStore().editsFor(chainId);
check('GUI chain replays from disk through the same wire planner', edit.planWireRewrite(chainSession.deriveMessages(), persistedChain).messages[chainReply.index].content[0].text === 'GUI-C');

console.log('--- registered GUI selects one durable user block, not the whole message ---');
const multi = await fixture(store, 'edit-gui-user-blocks', [text('TAIL ANSWER')], [text('A'), text('B')]);
const multiId = String(multi.id);
const multiOriginal = durable.userMessages(multi)[0];
const multiEvents = multi.snapshotEvents();
const multiLog = JSON.stringify(multiEvents);
let shownUser = (await callThroughRoute(gui.EDIT_METHODS.list, { sessionId: multiId })).entries.find((entry) => entry.type === 'user/message');
check('the real GUI route offers both user block targets', shownUser.targets.length === 2 && shownUser.targets.every((target) => target.editable)
  && shownUser.targets.map((target) => target.text).join(',') === 'A,B');
const firstBlock = await callThroughRoute(gui.EDIT_METHODS.commit, { sessionId: multiId, seq: shownUser.seq, id: shownUser.id, block: 0, expected: 'A', text: 'X' });
check('GUI block 0 reports the selected durable A->X', firstBlock?.ok && firstBlock.report?.branch === 'durable'
  && firstBlock.report?.before === 'A' && firstBlock.report?.after === 'X' && firstBlock.report?.block === 0);
shownUser = (await callThroughRoute(gui.EDIT_METHODS.list, { sessionId: multiId })).entries.find((entry) => entry.type === 'user/message');
check('GUI list after block 0 keeps the other target B', shownUser.targets.map((target) => target.text).join(',') === 'X,B'
  && shownUser.text === 'XB' && shownUser.targets[1].edited === false);
const staleLog = JSON.stringify(multi.snapshotEvents());
const wrongExpected = await callThroughRoute(gui.EDIT_METHODS.commit, { sessionId: multiId, seq: shownUser.seq, id: shownUser.id, block: 0, expected: 'A', text: 'STALE' });
const wrongBlockExpected = await callThroughRoute(gui.EDIT_METHODS.commit, { sessionId: multiId, seq: shownUser.seq, id: shownUser.id, block: 1, expected: 'NOT B', text: 'STALE' });
const oldIdentity = await callThroughRoute(gui.EDIT_METHODS.commit, { sessionId: multiId, seq: multiOriginal.seq, id: multiOriginal.id, block: 1, expected: 'B', text: 'STALE' });
check('stale expected and replaced identity are refused before durable append', wrongExpected?.ok === false && wrongBlockExpected?.ok === false
  && oldIdentity?.ok === false && JSON.stringify(multi.snapshotEvents()) === staleLog);
const secondBlock = await callThroughRoute(gui.EDIT_METHODS.commit, { sessionId: multiId, seq: shownUser.seq, id: shownUser.id, block: 1, expected: 'B', text: 'Y' });
check('GUI block 1 reports the selected durable B->Y', secondBlock?.ok && secondBlock.report?.before === 'B'
  && secondBlock.report?.after === 'Y' && secondBlock.report?.block === 1);
shownUser = (await callThroughRoute(gui.EDIT_METHODS.list, { sessionId: multiId })).entries.find((entry) => entry.type === 'user/message');
check('GUI list after both saves contains [X,Y]', shownUser.text === 'XY' && shownUser.targets.map((target) => target.text).join(',') === 'X,Y');
check('durable GUI saves preserve original audit and never enter the wire store', JSON.stringify(multi.snapshotEvents().slice(0, multiEvents.length)) === multiLog
  && bridge.editStoreFor(multiId).editsFor(multiId).length === 0);
const multiReplay = Session.create(multi.id, multi.snapshotEvents());
const replayUser = durable.effectiveEditableIndex(multiReplay)[0];
check('GUI block edits replay with the original origin chain', replayUser.originId === multiOriginal.id && replayUser.originSeq === multiOriginal.seq
  && replayUser.seq === secondBlock?.report?.newSeq && replayUser.text === 'XY');
const beforeMultiCall = calls.length;
await drain(runtime, requestFor(multiReplay));
check('the real adapter receives [X,Y] after durable replay', calls.length > beforeMultiCall && calls.slice(beforeMultiCall).every((call) => {
  const user = JSON.parse(call).messages.find((message) => message.id === replayUser.id);
  return user?.content?.map((block) => withoutDcpTag(block.text)).join(',') === 'X,Y' && call.includes('TAIL ANSWER');
}));

for (const [id, userBlocks, block] of [
  ['omitted', [text('A'), text('B')], undefined],
  ['implicit-cursor', [text('A'), text('')], undefined],
  ['null', [text('A'), text('B')], null],
  ['bare', 'BARE', undefined]
]) {
  const legacySession = await fixture(store, `edit-gui-user-${id}`, [text('TAIL')], userBlocks);
  const legacyUser = durable.userMessages(legacySession)[0];
  const legacySave = await callThroughRoute(gui.EDIT_METHODS.commit, {
    sessionId: String(legacySession.id), seq: legacyUser.seq, id: legacyUser.id, block, text: 'WHOLE'
  });
  const after = durable.userMessages(legacySession)[0];
  check(`legacy GUI ${id} selection keeps whole-message behavior`, legacySave?.ok && legacySave.report?.block === undefined
    && legacySave.report?.before === legacyUser.text && after.message.content.every((part) => part.text === 'WHOLE')
    && after.message.content.length === (Array.isArray(userBlocks) ? userBlocks.length : 1));
}
disposeGui();

console.log('--- the listener belongs to the plugin: dispose it and the rewrite stops ---');

// The positive checks show that SOMETHING rewrote the request. This narrows it to the
// thing `apply` installed: the plugin owns the listener (`ctx.on` registers it on the
// plugin's fiber), so unloading the plugin must take the rewrite away, with the stored
// edit still in place. If the rewrite came from anywhere else, it would survive.
const beforeDispose = listenerCount(context, 'llm/stream');
fiber.dispose();
await tick();
const afterDispose = listenerCount(context, 'llm/stream');
const afterCalls = calls.length;
await drain(runtime, requestFor(session));
await tick();

check(
  'the plugin\'s listener leaves the registry with the plugin',
  beforeDispose >= 1 && afterDispose === beforeDispose - 1,
  `${beforeDispose} -> ${afterDispose}`
);
check(
  'and the request is then handed to the adapter UNCHANGED',
  calls.length > afterCalls && calls.slice(afterCalls).every((call) => call.includes('REPLY-ORIGINAL') && !call.includes('REPLY-EDITED-ON-THE-WIRE')),
  `calls after dispose=${calls.length - afterCalls}`
);

console.log('--- the same edit, with nothing installed, changes nothing ---');

const bare = makeRoot();
const bareStore = edit.createEditStore({ restore: false });
const bareRecorded = bareStore.record(sessionId, reply.message, 'REPLY-EDITED-ON-THE-WIRE', {
  messageIndex: reply.index,
  messageId: reply.id,
  expected: reply.text
});
await drain(bare.runtime, requestFor(session));
await tick();

check('the store alone accepts the same edit', bareRecorded.ok === true, JSON.stringify(bareRecorded.reason ?? ''));
check(
  'without the overlay the adapter receives the ORIGINAL text',
  bare.calls.length > 0 && bare.calls.every((call) => !call.includes('REPLY-EDITED-ON-THE-WIRE')) && bare.calls.some((call) => call.includes('REPLY-ORIGINAL')),
  `bare adapter calls=${bare.calls.length}`
);

/* ------------------------------------------- and it is off when the editor is off */

console.log('--- the overlay obeys the same switch as the durable branch ---');

const offRoot = await mountPlugin({ editor: { enabled: false } });
const offSession = await fixture(offRoot.store, 'edit-wire-off');
const offId = String(offSession.id);
const offReply = durable.editableIndex(offSession).find((entry) => entry.type === 'assistant/message');
bridge.editStoreFor(offId).record(offId, offReply.message, 'REPLY-EDITED-WHILE-OFF', {
  messageIndex: offReply.index,
  messageId: offReply.id,
  expected: offReply.text
});
const { runtime: offRuntime, calls: offCalls } = offRoot;
await drain(offRuntime, requestFor(offSession));
await tick();

check(
  'a disabled editor leaves the provider view alone',
  offCalls.length > 0 && offCalls.every((call) => !call.includes('REPLY-EDITED-WHILE-OFF')),
  `off adapter calls=${offCalls.length}`
);

console.log(`\n${failures.length === 0 ? 'all wire edit tests passed' : `${failures.length} FAILURES: ${failures.join('; ')}`}`);
process.exit(failures.length === 0 ? 0 : 1);
