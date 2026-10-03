/**
 * THE ASSERTION THAT MATTERS: does the port change what the MODEL receives?
 *
 * WHY THIS FILE EXISTS, AND WHY THE OLD SUITE COULD NOT CATCH THE BUG IT CAUGHT.
 *
 * The port used to do its pruning in an `llm/stream` listener and return
 * `next({ ...options, messages: rewritten })`. That is a no-op: cordis's
 * `waterfall` discards arguments passed to `next(...)`, and the request envelope
 * plus its message array arrive deep-frozen from `dsh-agent-loop`'s
 * `buildRequest` - the contract in `dsh-llm`'s own types is that listeners "read
 * it, never rewrite it". Every summary and every placeholder was computed,
 * counted in `/dcp stats`, and never sent.
 *
 * The suite was green throughout, because it called `rewriteOutgoingMessages`
 * directly and asserted on its RETURN VALUE. A test that feeds a pure function
 * its own input and checks the output certifies the function, not the product -
 * and it will happily certify a function nobody calls.
 *
 * So this file does the only thing that can falsify a pruning claim: it builds a
 * REAL `@deepseek-ai/dsh-session` Session, appends real events, runs the plugin,
 * and reads `session.deriveMessages()` - the array the harness actually sends.
 * If a prune does not change that array, these checks fail.
 *
 * Run:  node scripts/test-dcp-materialization.mjs
 *
 * @module dsh-context-kit/scripts/test-dcp-materialization
 */

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const kitRoot = join(here, '..');

const failures = [];
/** @param name - check label. @param ok - result. @param detail - evidence. */
function check(name, ok, detail = '') {
  console.log(`${ok ? '[ok]  ' : '[FAIL]'} ${name}${detail.length > 0 ? ` - ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const { Context } = await import('@deepseek-ai/cordis');
const { Session, SessionId, foldSurface } = await import('@deepseek-ai/dsh-session');
const { assertV4RowAdmission } = await import('@deepseek-ai/dsh-session-format-v3-to-v4');
const llm = await import('@deepseek-ai/dsh-llm');
const dcp = await import(pathToFileURL(join(kitRoot, 'lib', 'dcp.js')).href);
const blocks = await import(pathToFileURL(join(kitRoot, 'lib', 'dcp-blocks.js')).href);

const { createUserMessage, createAssistantMessage, createToolResultMessage, ToolCallId } = llm;

/* ------------------------------------------------------------------- mounting */

/**
 * Mount one isolated plugin instance.
 *
 * A fresh mount per case keeps the block registry and prune manifest empty, and
 * every case builds its OWN session, so no case can inherit another's pruning
 * through the persisted state file.
 */
async function mountEngine(config) {
  const root = new Context();
  const warned = [];
  root.provide('logger', {
    info: () => {},
    debug: () => {},
    error: () => {},
    warn: (...args) => warned.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '))
  });
  root.provide('tools', { register: () => () => {} });
  root.provide('llm', llm);
  root.provide('tokenMeter', {
    estimateMessage: (message) => JSON.stringify(message?.content ?? message ?? '').length,
    measure: () => ({ nodes: [] })
  });
  root.plugin(dcp, config ?? {});
  await new Promise((resolve) => setTimeout(resolve, 250));
  return { engine: dcp.engineForTest(), warned };
}

let sessionCounter = 0;
/** A unique session id per case, so persisted state cannot leak between cases. */
const nextSessionId = () => `materialize-${process.pid}-${Date.now()}-${(sessionCounter += 1)}`;

/* ------------------------------------------------------------------ fixtures */

/** One assistant step that calls `name` with `args`, plus its result. */
function appendExchange(session, { turn, step, callId, name, args, body, isError = false }) {
  session.append('assistant/message', {
    turn,
    step,
    stream: [],
    message: createAssistantMessage({
      content: [
        { type: 'text', text: `step ${turn}` },
        { type: 'tool-call', id: ToolCallId(callId), name, arguments: JSON.stringify(args ?? {}) }
      ],
      source: { kind: 'model', provider: 'probe', model: 'probe' }
    })
  }, { surfaceOp: 'append' });
  return session.append('tool/result', {
    turn,
    step,
    message: createToolResultMessage({
      callId: ToolCallId(callId),
      content: [{ type: 'text', text: body }],
      isError
    })
  }, { surfaceOp: 'append' });
}

/**
 * A real session holding two identical calls, each with a DIFFERENT body.
 *
 * Different bodies on purpose: with one shared body the checks could not tell
 * "the older copy was pruned" from "nothing was pruned at all".
 */
function duplicateSession() {
  const session = Session.create(SessionId(nextSessionId()));
  session.append('turn/start', { turn: 1 });
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
  session.append('turn/start', { turn: 2 });
  const first = appendExchange(session, { turn: 1, step: 1, callId: 'c1', name: 'bash', args: { command: 'ls' }, body: 'OLDER-COPY' });
  session.append('turn/start', { turn: 3 });
  const second = appendExchange(session, { turn: 2, step: 1, callId: 'c2', name: 'bash', args: { command: 'ls' }, body: 'NEWER-COPY' });
  return { session, first, second };
}

/** The text of everything the model would receive. */
const modelView = (session) => JSON.stringify(session.deriveMessages());

/** A real system head, three selected messages, and an untouched tail. */
function summaryFixture({ headAtZero = false, replaceHead = false, middleSystem = false } = {}) {
  const session = Session.create(SessionId(nextSessionId()));
  if (!headAtZero) session.append('turn/start', { turn: 1 });
  const systemData = {
    message: {
      id: 'system-head', role: 'system', source: { kind: 'system-prompt' },
      content: [{ type: 'text', text: 'KEEP-SYSTEM' }]
    }
  };
  let head = session.append('system/message', systemData, { surfaceOp: 'append' });
  if (headAtZero) session.append('turn/start', { turn: 1 });
  const appendUser = (text) => session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }], source: { kind: 'user' }
  }), { surfaceOp: 'append' });
  const first = appendUser('SELECTED-FIRST');
  if (middleSystem) session.append('system/message', {
    message: { ...systemData.message, id: 'invisible-system', content: [] }
  }, { surfaceOp: 'append' });
  const middle = appendUser('SELECTED-MIDDLE');
  const last = appendUser('SELECTED-LAST');
  const tail = appendUser('KEEP-TAIL');
  if (replaceHead) head = session.append('system/message', systemData, {
    surfaceOp: { op: 'replace', startSeq: head.seq, endSeq: head.seq }, sourceEventSeqs: [head.seq]
  });
  return {
    session, head, first, middle, last, tail,
    entry: {
      startSeq: first.seq, endSeq: last.seq, shadowedSeqs: session.surface.nodes.slice(1, -1),
      tokens: 12, summary: 'SAFE-SUMMARY',
      summaryMessage: createUserMessage({
        content: [{ type: 'text', text: 'SAFE-SUMMARY' }],
        source: { kind: 'plugin:dcp', form: 'notice', summary: 'range' }
      })
    }
  };
}

console.log('--- format-v4 producer source admission ---');
{
  const row = (source) => ({
    type: 'user/message',
    seq: 0,
    time: 0,
    data: createUserMessage({ content: [{ type: 'text', text: 'SUMMARY' }], source })
  });
  let retiredError;
  try { assertV4RowAdmission(row({ kind: 'plugin', plugin: 'dcp' })); } catch (error) { retiredError = error; }
  check('the retired plugin wrapper is rejected by v4 persistence',
    retiredError?.message === 'format v4 message requires a producer-owned source kind', retiredError?.message ?? 'accepted');
  let currentError;
  try { assertV4RowAdmission(row({ kind: 'plugin:dcp', form: 'notice' })); } catch (error) { currentError = error; }
  check('the DCP producer kind is accepted by v4 persistence', currentError === undefined, currentError?.message ?? 'accepted');
}

console.log('--- summary refusals must happen BEFORE the price append ---');
const refusedSummaries = [
  ['system head at seq zero', (f) => {
    f.entry.startSeq = f.head.seq;
    f.entry.shadowedSeqs.unshift(f.head.seq);
  }, { headAtZero: true }],
  ['system head at nonzero seq', (f) => {
    f.entry.startSeq = f.head.seq;
    f.entry.shadowedSeqs.unshift(f.head.seq);
  }],
  ['system head replaced at newer seq', (f) => {
    f.entry.startSeq = f.head.seq;
    f.entry.shadowedSeqs.unshift(f.head.seq);
  }, { replaceHead: true }],
  ['stale start', (f) => {
    f.session.append('user/message', f.entry.summaryMessage, {
      surfaceOp: { op: 'replace', startSeq: f.first.seq, endSeq: f.first.seq }, sourceEventSeqs: [f.first.seq]
    });
  }],
  ['stale end', (f) => {
    f.session.append('user/message', f.entry.summaryMessage, {
      surfaceOp: { op: 'replace', startSeq: f.last.seq, endSeq: f.last.seq }, sourceEventSeqs: [f.last.seq]
    });
  }],
  ['backwards surface range', (f) => {
    [f.entry.startSeq, f.entry.endSeq] = [f.entry.endSeq, f.entry.startSeq];
  }],
  ['missing provenance', (f) => { delete f.entry.shadowedSeqs; }],
  ['missing provenance on one node', (f) => {
    f.entry.endSeq = f.entry.startSeq;
    delete f.entry.shadowedSeqs;
  }],
  ['non-array provenance', (f) => { f.entry.shadowedSeqs = 'invalid'; }],
  ['empty provenance', (f) => { f.entry.shadowedSeqs = []; }],
  ['missing selected middle node', (f) => { f.entry.shadowedSeqs.splice(1, 1); }],
  ['duplicate provenance', (f) => { f.entry.shadowedSeqs.splice(1, 0, f.first.seq); }],
  ['sparse provenance', (f) => { delete f.entry.shadowedSeqs[1]; }],
  ['reordered provenance', (f) => { f.entry.shadowedSeqs.reverse(); }],
  ['extra unselected provenance', (f) => { f.entry.shadowedSeqs.push(f.tail.seq); }],
  ['provenance cites pending prune', (f) => { f.entry.shadowedSeqs.push(f.session.seq); }],
  ['provenance cites pending summary', (f) => { f.entry.shadowedSeqs.push(f.session.seq + 1); }],
  ['future provenance', (f) => { f.entry.shadowedSeqs.push(f.session.seq + 100); }],
  ...[undefined, null, '2', -1, -0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((seq, index) => [
    `invalid provenance value ${index}`, (f) => { f.entry.shadowedSeqs[1] = seq; }
  ]),
  ['missing summary message', (f) => { delete f.entry.summaryMessage; }],
  ['null summary message', (f) => { f.entry.summaryMessage = null; }],
  ['wrapped summary message', (f) => { f.entry.summaryMessage = { message: f.entry.summaryMessage }; }],
  ['unidentified summary message', (f) => { f.entry.summaryMessage = { ...f.entry.summaryMessage, id: '' }; }],
  ['wrong summary role', (f) => { f.entry.summaryMessage = { ...f.entry.summaryMessage, role: 'system' }; }],
  ['invalid summary source', (f) => { f.entry.summaryMessage = { ...f.entry.summaryMessage, source: {} }; }],
  ['invalid summary content', (f) => { f.entry.summaryMessage = { ...f.entry.summaryMessage, content: 'text' }; }],
  ['non-JSON summary message', (f) => { f.entry.summaryMessage = { ...f.entry.summaryMessage, extra: () => {} }; }],
  ['lossy JSON summary message', (f) => { f.entry.summaryMessage = { ...f.entry.summaryMessage, extra: NaN }; }],
  ['sparse summary content', (f) => { f.entry.summaryMessage = { ...f.entry.summaryMessage, content: new Array(1) }; }],
  ...[undefined, null, '12', -1, -0, NaN, Infinity].map((tokens, index) => [
    `invalid summary price ${index}`, (f) => { f.entry.tokens = tokens; }
  ])
];
for (const [name, arrange, options] of refusedSummaries) {
  const fixture = summaryFixture(options);
  arrange(fixture);
  const { session, entry } = fixture;
  const snapshot = () => JSON.stringify({
    seq: session.seq, events: session.snapshotEvents(), nodes: session.surface.nodes,
    generation: session.surface.replaceGeneration, view: modelView(session)
  });
  const before = snapshot();
  const append = session.append.bind(session);
  let appendCalls = 0;
  session.append = (...args) => { appendCalls += 1; return append(...args); };
  let error;
  try { blocks.materializeSummary(session, entry); } catch (caught) { error = caught; }
  check(`${name}: refused`, error instanceof Error, error?.message ?? 'accepted');
  check(`${name}: no append attempted`, appendCalls === 0, String(appendCalls));
  check(`${name}: log and surface unchanged`, snapshot() === before);
}

console.log('\n--- valid summaries after a system head preserve order, price, and replay ---');
for (const [name, options, replaceFirst, tokens] of [
  ['ordinary range', {}, false, 12],
  ['newer system head', { replaceHead: true }, false, 0],
  ['historical system update', { middleSystem: true }, false, 12],
  ['nonascending replacement ids', {}, true, 12.5]
]) {
  const { session, entry, head, first, tail } = summaryFixture(options);
  if (replaceFirst) {
    const newer = session.append('user/message', first.data, {
      surfaceOp: { op: 'replace', startSeq: first.seq, endSeq: first.seq }, sourceEventSeqs: [first.seq]
    });
    entry.startSeq = newer.seq;
    entry.shadowedSeqs = session.surface.nodes.slice(1, -1);
    check(`${name}: fixture follows surface, not numeric order`, entry.startSeq > entry.endSeq);
  }
  entry.tokens = tokens;
  const beforeSeq = session.seq;
  const beforeEntry = JSON.stringify(entry);
  const result = blocks.materializeSummary(session, entry);
  const appended = session.snapshotEvents(beforeSeq);
  check(`${name}: exactly adjacent price then summary`, appended.length === 2
    && appended[0].type === 'compaction/prune' && appended[1] === result && result.type === 'user/message'
    && result.seq === beforeSeq + 1);
  check(`${name}: exact price and matching range`, appended[0].data.shadowedTokenCount === tokens
    && appended[0].data.shadowedRange.start === entry.startSeq && appended[0].data.shadowedRange.end === entry.endSeq
    && JSON.stringify(appended[0].data.shadowedSeqs) === JSON.stringify(entry.shadowedSeqs)
    && JSON.stringify(result.sourceEventSeqs) === JSON.stringify(entry.shadowedSeqs));
  check(`${name}: replaces only selected nodes`, JSON.stringify(session.surface.nodes) === JSON.stringify([head.seq, result.seq, tail.seq])
    && modelView(session).includes('KEEP-SYSTEM') && modelView(session).includes('KEEP-TAIL')
    && modelView(session).includes('SAFE-SUMMARY') && !modelView(session).includes('SELECTED-'));
  check(`${name}: caller input unchanged`, JSON.stringify(entry) === beforeEntry);
  const events = JSON.parse(JSON.stringify(session.snapshotEvents()));
  const replay = Session.create(SessionId(nextSessionId()), events);
  check(`${name}: public core fold and session replay agree`, JSON.stringify(foldSurface(events).nodes) === JSON.stringify(session.surface.nodes)
    && JSON.stringify(replay.surface.nodes) === JSON.stringify(session.surface.nodes) && modelView(replay) === modelView(session));
}

console.log('--- the seam: a prune must change what the model receives ---');
{
  const { engine, warned } = await mountEngine({});
  const { session } = duplicateSession();
  const before = modelView(session);
  check('the fixture really shows both bodies before pruning', before.includes('OLDER-COPY') && before.includes('NEWER-COPY'), '');

  engine.pruneSession(session, undefined, { nudge: false });

  const after = modelView(session);
  check('the pruned payload is GONE from the model view', !after.includes('OLDER-COPY'), after.slice(0, 160));
  check('the placeholder is what the model reads instead', after.includes(blocks.PRUNED_TOOL_OUTPUT_REPLACEMENT), '');
  check('the surviving copy is untouched', after.includes('NEWER-COPY'), '');
  check('the harness accepted the replacement (no warning)', warned.length === 0, JSON.stringify(warned));
  check('a compaction/prune event records the price', session.snapshotEvents().some((event) => event.type === 'compaction/prune'), '');
  check('the original is STILL in the append-only log', session.snapshotEvents().some((event) => JSON.stringify(event).includes('OLDER-COPY')), '');
  check('the replacement node is on the surface', session.surface.nodes.some((seq) => Number(seq) === engine.blocks.prunedNodeFor('c1')?.seq), String(engine.blocks.prunedNodeFor('c1')?.seq));
  check(
    'the transcript stays valid: the call is still answered by the same call id',
    session.deriveMessages().filter((message) => message.content?.[0]?.type === 'tool-result').some((message) => String(message.content[0].toolCallId) === 'c2')
      && session.deriveMessages().filter((message) => message.content?.[0]?.type === 'tool-result').length === 2,
    ''
  );
}

console.log('\n--- idempotence: a second pass must not prune again ---');
{
  const { engine } = await mountEngine({});
  const { session } = duplicateSession();
  engine.pruneSession(session, undefined, { nudge: false });
  const nodesAfterFirst = session.surface.nodes.length;
  const added = engine.pruneSession(session, undefined, { nudge: false });
  check('a second pass adds nothing', added.length === 0, JSON.stringify(added.map((entry) => entry.callId)));
  check('the surface did not grow again', session.surface.nodes.length === nodesAfterFirst, `${session.surface.nodes.length} vs ${nodesAfterFirst}`);
}

console.log('\n--- a manifest entry is not proof the session carries the event ---');
{
  // The state file is durable and the session may be older than it. A pass that
  // trusts the manifest to mean "already done" would leave a session that never
  // received the replacement permanently unpruned - which is exactly what the
  // first version of this code did, and it is how the end-to-end probe found it.
  const { engine } = await mountEngine({});
  const { session } = duplicateSession();
  const state = engine.blocksFor(session);
  state.pruneTools([{ callId: 'c1', tokens: 99 }]);

  engine.pruneSession(session, undefined, { nudge: false });

  check('a call the manifest already claims is still materialized', !modelView(session).includes('OLDER-COPY'), modelView(session).slice(0, 160));
}

console.log('\n--- a failed call keeps its error and loses the input ---');
{
  const { engine, warned } = await mountEngine({ strategies: { purgeErrors: { turns: 1 } } });
  const session = Session.create(SessionId(nextSessionId()));
  session.append('turn/start', { turn: 1 });
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
  // THE AGE IS COUNTED IN STEPS, so the fixture has to take real steps. A session
  // that only opens a later `turn/start` has a step age of ZERO — `turn` is
  // assigned per USER turn (`dsh-agent-loop\lib\index.js:924,930`), which is why
  // the age unit is the number of `step/start` events. With the call one step old
  // against a threshold of 1 it is not yet old enough, and the pass rightly does
  // nothing: the earlier version of this fixture asserted a prune that the age
  // rule forbids, and only the removed turn-shaped fallback made it pass.
  session.append('step/start', { turn: 1, step: 1 });
  appendExchange(session, { turn: 1, step: 1, callId: 'e1', name: 'bash', args: { command: 'x'.repeat(400) }, body: 'command not found', isError: true });
  session.append('step/end', { turn: 1, step: 1 });
  session.append('turn/end', { turn: 1, reason: 'stop' });
  // Five more steps of ordinary work, so the failed call is five steps old.
  session.append('turn/start', { turn: 2 });
  for (let step = 1; step <= 5; step += 1) {
    session.append('step/start', { turn: 2, step });
    appendExchange(session, { turn: 2, step, callId: `f${step}`, name: 'read', args: { filePath: `f${step}.js` }, body: `BODY-${step}` });
    session.append('step/end', { turn: 2, step });
  }
  session.append('turn/end', { turn: 2, reason: 'stop' });
  session.append('turn/start', { turn: 3 });

  const surfaceBefore = JSON.stringify(session.surface.nodes);
  engine.pruneSession(session, undefined, { nudge: false });

  const view = modelView(session);
  check('the errored call is pruned', engine.blocks.prunedToolCount === 1, String(engine.blocks.prunedToolCount));
  check('the errored result is not durably replaced', view.includes('command not found') && JSON.stringify(session.surface.nodes) === surfaceBefore, view.slice(0, 200));
  check('the durable arguments remain original for audit', view.includes('x'.repeat(400)), 'provider-only pruning runs on the shared wire transform');
  check('the manifest records provider-only input pruning', engine.blocks.prunedToolKinds.get('e1') === 'error-input');
  check('the harness accepted it', warned.length === 0, JSON.stringify(warned));
}

console.log('\n--- a protected tool is never touched (and the protection is real) ---');
{
  const { engine } = await mountEngine({});
  const session = Session.create(SessionId(nextSessionId()));
  session.append('turn/start', { turn: 1 });
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
  appendExchange(session, { turn: 1, step: 1, callId: 'e1', name: 'edit', args: { filePath: 'a.js' }, body: 'EDIT-RESULT' });
  session.append('turn/start', { turn: 2 });
  appendExchange(session, { turn: 2, step: 1, callId: 'e2', name: 'edit', args: { filePath: 'a.js' }, body: 'EDIT-RESULT' });

  engine.pruneSession(session, undefined, { nudge: false });
  check('an edit result is never pruned', modelView(session).includes('EDIT-RESULT'), '');
}

console.log('\n--- compression materializes a summary over a range ---');
{
  const { engine } = await mountEngine({});
  const session = Session.create(SessionId(nextSessionId()));
  session.append('turn/start', { turn: 1 });
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
  const first = appendExchange(session, { turn: 1, step: 1, callId: 's1', name: 'bash', args: { command: 'ls' }, body: 'SPAN-BODY-ONE' });
  const nodes = session.surface.nodes.map(Number);
  const startSeq = nodes[1];
  const endSeq = Number(first.seq);

  const summary = createUserMessage({
    content: [{ type: 'text', text: '[Compressed conversation section]\nMATERIALIZED-SUMMARY' }],
    source: { kind: 'plugin:dcp', form: 'notice', summary: 'range' }
  });
  blocks.materializeSummary(session, {
    startSeq,
    endSeq,
    shadowedSeqs: session.surface.nodes.map(Number).slice(1),
    tokens: 10,
    summary: 'MATERIALIZED-SUMMARY',
    summaryMessage: summary
  });

  const view = modelView(session);
  check('the summary is in the model view', view.includes('MATERIALIZED-SUMMARY'), view.slice(0, 200));
  check('the shadowed span is out of the model view', !view.includes('SPAN-BODY-ONE'), '');
  check('the log still holds the shadowed events', session.snapshotEvents().some((event) => JSON.stringify(event).includes('SPAN-BODY-ONE')), '');
  check('the surface shrank rather than grew', session.surface.nodes.length < nodes.length, `${session.surface.nodes.length} vs ${nodes.length}`);
}

console.log('\n--- `/dcp decompress` puts the shadowed messages BACK ---');
{
  // The command used to flip a flag and report success. The flag only changes what
  // a request REWRITE injects, and this port's request path is the durable SURFACE,
  // so the model went on reading the summary: the command was a lie. The repair is
  // the copy-tail recipe run backwards — re-append the shadowed events as ordinary
  // nodes and collapse the summary node alone into an invisible `system/message`.
  const { engine } = await mountEngine({});
  const session = Session.create(SessionId(nextSessionId()));
  session.append('turn/start', { turn: 1 });
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
  appendExchange(session, { turn: 1, step: 1, callId: 'r1', name: 'bash', args: { command: 'ls' }, body: 'RESTORE-ME-ONE' });
  appendExchange(session, { turn: 1, step: 2, callId: 'r2', name: 'read', args: { filePath: 'a.js' }, body: 'RESTORE-ME-TWO' });

  const nodes = session.surface.nodes.map(Number);
  const startSeq = nodes[1];
  const endSeq = nodes.at(-1);
  const shadowedSeqs = nodes.slice(1);
  const summaryEvent = blocks.materializeSummary(session, {
    startSeq,
    endSeq,
    shadowedSeqs,
    tokens: 10,
    summary: 'GONE-FROM-VIEW',
    summaryMessage: createUserMessage({
      content: [{ type: 'text', text: '[Compressed conversation section]\nGONE-FROM-VIEW' }],
      source: { kind: 'plugin:dcp', form: 'notice', summary: 'range' }
    })
  });

  const compressed = modelView(session);
  check('the fixture really compressed the span', compressed.includes('GONE-FROM-VIEW') && !compressed.includes('RESTORE-ME-ONE'), compressed.slice(0, 160));
  const originalSpanMessageIds = new Set(shadowedSeqs.map((seq) => session.eventAt(seq)?.data?.message?.id ?? session.eventAt(seq)?.data?.id).filter(Boolean));

  const block = {
    blockId: '1',
    topic: 'the span',
    summary: 'GONE-FROM-VIEW',
    anchorMessageId: 'anchor',
    shadowedMessageIds: [],
    shadowedSeqs,
    nodeSeq: Number(summaryEvent.seq),
    start: startSeq,
    end: endSeq,
    active: true
  };
  const estimateMessage = (message) => JSON.stringify(message?.content ?? message ?? '').length;
  const collapsedTokens = session.surface.nodes.slice(session.surface.nodes.indexOf(summaryEvent.seq))
    .reduce((total, seq) => total + estimateMessage(session.deriveEventMessage(session.eventAt(seq))), 0);
  const restored = blocks.restoreBlockMessages(session, block, { estimateMessage });
  const view = modelView(session);

  check('the restore reports how many messages came back', restored?.restoredCount === shadowedSeqs.length, `${restored?.restoredCount} of ${shadowedSeqs.length}`);
  check('the shadowed payloads are back in the model view', view.includes('RESTORE-ME-ONE') && view.includes('RESTORE-ME-TWO'), view.slice(0, 200));
  check('the summary is gone from the model view', !view.includes('GONE-FROM-VIEW'), '');
  check('the summary event is still in the log', session.snapshotEvents().some((event) => JSON.stringify(event).includes('GONE-FROM-VIEW')), '');
  const restoredMessageIds = session.deriveMessages().slice(1).map((message) => message.id);
  check('restored copies have fresh unique message ids', new Set(restoredMessageIds).size === restoredMessageIds.length
    && restoredMessageIds.every((id) => !originalSpanMessageIds.has(id)), restoredMessageIds.join(', '));
  const invisible = session.snapshotEvents().find((event) => event.type === 'system/message' && event.data?.message?.id?.startsWith('restored-1-'));
  check('the durable invisible node carries required v3 coordinates', invisible?.data?.turn === 1 && invisible?.data?.step === 2, JSON.stringify(invisible?.data));
  check('the invisible node produced no message', !session.deriveMessages().some((message) => JSON.stringify(message?.content ?? []).trim() === '[]' || message?.content?.length === 0), '');
  const restorePrice = session.snapshotEvents().findLast((event) => event.type === 'compaction/prune')?.data?.shadowedTokenCount;
  check('the restore prices the collapsed old surface exactly', restorePrice === collapsedTokens, `${restorePrice} vs ${collapsedTokens}`);
  check('the view is back to the same LENGTH as before the compression', session.deriveMessages().length === nodes.length, `${session.deriveMessages().length} vs ${nodes.length}`);
  check('tool pairing stays balanced', (await import('@deepseek-ai/dsh-compaction')).toolPairingBalancedAfter(session, session.surface.nodes.at(-1)) === true);

  // The originals were re-appended as COPIES, so the log grew and the ids are new.
  check('the restoration is durable: the log replays to the same view', (() => {
    const reloaded = Session.create(SessionId(nextSessionId()), JSON.parse(JSON.stringify(session.snapshotEvents())));
    return JSON.stringify(reloaded.deriveMessages().map((message) => JSON.stringify(message.content))) === JSON.stringify(session.deriveMessages().map((message) => JSON.stringify(message.content)));
  })(), '');

  // And the engine's own command path uses it: a second restore must refuse rather
  // than append the same messages twice.
  const again = blocks.restoreBlockMessages(session, block, { estimateMessage });
  check('restoring twice is refused, not duplicated', again === undefined, String(again));
}

console.log('\n--- a replacement is rejected loudly when the range is gone ---');
{
  // The harness validates a replacement at the append site, so a stale plan must
  // fail visibly rather than shadow the wrong content. This is the dangerous
  // case: a range that is accepted but WRONG would destroy context the user
  // wanted to keep.
  const session = Session.create(SessionId(nextSessionId()));
  session.append('turn/start', { turn: 1 });
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
  const result = appendExchange(session, { turn: 1, step: 1, callId: 'z1', name: 'bash', args: {}, body: 'BODY' });
  const originalSeq = Number(result.seq);

  // First replacement succeeds and takes the node out of the surface.
  const replacement = blocks.prunedToolResultMessage(result.data.message, blocks.PRUNED_TOOL_OUTPUT_REPLACEMENT);
  blocks.materializeToolResultPrune(session, { seq: originalSeq, event: result, replacement, tokens: 1 });
  check('the first replacement landed', modelView(session).includes(blocks.PRUNED_TOOL_OUTPUT_REPLACEMENT), '');

  // A second replacement over the SAME original seq must be refused.
  let threw = false;
  try {
    blocks.materializeToolResultPrune(session, { seq: originalSeq, event: result, replacement, tokens: 1 });
  } catch {
    threw = true;
  }
  check('a stale range is refused, not silently applied', threw, '');
  check('the placeholder still occupies exactly one node', session.deriveMessages().filter((message) => JSON.stringify(message).includes(blocks.PRUNED_TOOL_OUTPUT_REPLACEMENT)).length === 1, '');
}

console.log('\n--- the output-prune exemption reads the CALL, because the result has no tool name ---');
{
  // Upstream skips the OUTPUT prune for `question`/`edit`/`write`
  // (`lib/messages/prune.ts:90-92`): a write's result is the record of a change
  // that was made, and an answered question's output IS the answer. Upstream has
  // the name on the tool part (`part.tool`); DSH does not. Measured on a live
  // session log, EVERY `tool/result` message's source is exactly
  // `{ kind: "tool", callId }` — no `name` — so reading `message.source?.name`
  // always produced `''` and the exemption never fired for anyone.
  const { engine } = await mountEngine({});
  const { session } = duplicateSession();
  engine.blocks.pruneTools([{ callId: 'c1', tokens: 5 }]);

  const outgoing = session.deriveMessages();
  const assistant = outgoing.find((message) => (message.content ?? []).some((block) => block.type === 'tool-call' && block.id === 'c1'));
  const result = outgoing.find((message) => message.content?.[0]?.toolCallId === 'c1');
  check('the fixture really is a result whose source carries only a callId', assistant !== undefined && result !== undefined && result.source?.name === undefined, JSON.stringify(result?.source));

  const asEdit = blocks.applyToolPruning(
    [{ ...assistant, content: assistant.content.map((block) => (block.type === 'tool-call' && block.id === 'c1' ? { ...block, name: 'edit' } : block)) }, result],
    engine.blocks
  );
  check('an edit result keeps its output', !JSON.stringify(asEdit).includes(blocks.PRUNED_TOOL_OUTPUT_REPLACEMENT), JSON.stringify(asEdit[1]).slice(0, 160));

  const asWrite = blocks.applyToolPruning(
    [{ ...assistant, content: assistant.content.map((block) => (block.type === 'tool-call' && block.id === 'c1' ? { ...block, name: 'write' } : block)) }, result],
    engine.blocks
  );
  check('a write result keeps its output', !JSON.stringify(asWrite).includes(blocks.PRUNED_TOOL_OUTPUT_REPLACEMENT), '');

  // The control: the SAME result, with a tool that is not exempt, IS pruned. Without
  // this the two checks above would also pass if the pruning were simply broken.
  const asRead = blocks.applyToolPruning(
    [{ ...assistant, content: assistant.content.map((block) => (block.type === 'tool-call' && block.id === 'c1' ? { ...block, name: 'read' } : block)) }, result],
    engine.blocks
  );
  check('a non-exempt result is still pruned', JSON.stringify(asRead).includes(blocks.PRUNED_TOOL_OUTPUT_REPLACEMENT), '');
}

console.log('');
if (failures.length > 0) {
  console.log(`${failures.length} check(s) FAILED:`);
  for (const name of failures) console.log(`  - ${name}`);
  process.exitCode = 1;
} else {
  console.log('all DCP materialization tests passed');
}
