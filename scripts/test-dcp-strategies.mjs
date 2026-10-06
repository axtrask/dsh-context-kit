/**
 * Behaviour of the deterministic strategies — end to end, through the ENGINE.
 *
 * WHAT THIS FILE EXISTS FOR.
 *
 * The previous suite tested `planDeduplication` / `planPurgeErrors` as pure
 * functions and stopped there, so it never noticed the property that actually
 * matters to a user: what happens to the conversation. The old planners returned
 * whole-STEP replacements (the assistant message plus every result it produced),
 * which the caller landed by appending a shadow node — destroying the original
 * and every sibling result in the batch. Every check in the old file passed while
 * that was true.
 *
 * So these checks do not look at a plan. They build a session, run the ENGINE's
 * strategy pass on it, compute the request the port would actually send with
 * `rewriteOutgoingMessages`, and assert on THAT:
 *
 *   - the pruned payload is gone from the request;
 *   - the tool call and its result are still there, in order;
 *   - every sibling result of the same batch is intact;
 *   - the session itself is byte-identical, because the whole design is that
 *     pruning is a property of the request and never of the history.
 *
 * Run:  node scripts/test-dcp-strategies.mjs
 *
 * @module dsh-context-kit/scripts/test-dcp-strategies
 */

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const kitRoot = join(here, '..');
const stateHome = mkdtempSync(join(tmpdir(), 'dcp-strategies-'));
process.env.DSH_HOME = stateHome;

const failures = [];
/** @param name - check label. @param ok - result. @param detail - evidence. */
function check(name, ok, detail = '') {
  console.log(`${ok ? '[ok]  ' : '[FAIL]'} ${name}${detail.length > 0 ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const dcp = await import(pathToFileURL(join(kitRoot, 'lib', 'dcp.js')).href);
const { Config } = dcp;
const {
  PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
  PRUNED_TOOL_OUTPUT_REPLACEMENT,
  DcpBlockState,
  rewriteOutgoingMessages
} = await import(pathToFileURL(join(kitRoot, 'lib', 'dcp-blocks.js')).href);
const { filePathsOf, matchesGlob } = await import(pathToFileURL(join(kitRoot, 'lib', 'session.js')).href);

/* ------------------------------------------------------------- harness mount */

/** Sessions a `/llm/stream` invocation can resolve by id. */
const liveSessions = new Map();

/**
 * Mount ONE isolated plugin instance, with the services its row injects.
 *
 * Isolation is per-CASE and per-SESSION, and both halves are needed:
 *
 *   - a fresh mount means the block registry and prune manifest start empty, so
 *     a case cannot inherit another case's pruning;
 *   - a fresh session id means the state file on disk is a different file, so a
 *     case cannot inherit its predecessor's pruning either. Without this the
 *     manifest persisted by one case silently pruned the next one's fixtures —
 *     the failure mode this whole design would have in production if the state
 *     were keyed on anything but the session.
 *
 * @param config - the plugin row configuration.
 * @returns the mounted engine plus the token meter it saw.
 */
async function mountEngine(config, options = {}) {
  const { Context } = await import('@deepseek-ai/cordis');
  const { SessionStore } = await import('@deepseek-ai/dsh-session');
  // THE CONTEXT IS SHARED WITH THE SESSION STORE when a case provides one.
  // `session/event` reaches the plugin through cordis, so a store built on its own
  // root never notifies a plugin mounted on another - the session looks live, the
  // pass never runs, and the case fails while testing nothing.
  const root = options.context ?? new Context();
  root.provide('tools', { register: () => () => {} });
  root.provide('llm', await import('@deepseek-ai/dsh-llm'));
  const meter = {
    estimateMessage: (message) => JSON.stringify(message?.content ?? message ?? '').length,
    measure: () => ({ nodes: [] })
  };
  root.provide('tokenMeter', meter);
  // The `sessions` service is what the automatic pass reads a live session from.
  // Published here because the port must work with it present AND absent: an
  // embedding without it loses the discovery step but must still rewrite. A case
  // that needs sessions which actually EMIT `session/event` passes a real
  // `SessionStore`, which registers the service itself on the shared context - and
  // a second `provide` for one service name is an error, not a no-op.
  if (options.sessions === undefined) {
    root.provide('sessions', {
      get: (id) => liveSessions.get(String(id)),
      list: () => [...liveSessions.values()]
    });
  }
  root.plugin(dcp, config ?? {});
  await new Promise((resolve) => setTimeout(resolve, 250));
  return { engine: dcp.engineForTest(), meter, root, store: options.store };
}

/**
 * Run one request through the `llm/stream` waterfall, as the harness does.
 *
 * Returns whether the waterfall actually reached its callback. The previous form returned
 * the list alone, INITIALISED to the input array — so a handler that never fired, or a
 * waterfall that never ran its callback, compared that array with itself and passed. An
 * auditor flagged the check that relied on it; `fired` is what makes it falsifiable.
 *
 * @param root - the mounted context.
 * @param sessionId - the session the request belongs to.
 * @param messages - the outgoing message list.
 * @returns `{ seen, fired }` — the list let through, and whether the callback ran.
 */
const requestThrough = (root, sessionId, messages) => {
  let seen = messages;
  let fired = false;
  root.waterfall('llm/stream', { sessionId, messages }, (final) => {
    fired = true;
    seen = Array.isArray(final?.messages) ? final.messages : messages;
    return final;
  });
  return { seen, fired };
};

/* ---------------------------------------------------------------- fixtures */

let runCounter = 0;
const uniqueSessionId = () => `strategy-test-${process.pid}-${(runCounter += 1)}`;

const text = (value) => ({ type: 'text', text: value });

const assistantCall = (calls) => ({
  content: calls.map((call) => ({
    type: 'tool-call',
    id: call.id,
    name: call.name,
    arguments: JSON.stringify(call.arguments ?? {})
  }))
});

const toolResult = (callId, body, isError = false, name = 'read') => ({
  role: 'user',
  content: [{ type: 'tool-result', toolCallId: callId, content: [text(body)], isError }],
  source: { kind: 'tool', callId, name }
});

/**
 * Build a session fixture from a flat event list.
 *
 * The shape follows the harness: an event log, a derived surface, and a
 * `deriveEventMessage` that mints the SAME durable id for the same event every
 * time it is called — which is what the rewrite addresses messages by.
 *
 * APPEND AND THE SURFACE FOLD ARE REAL. A pruning pass is no longer just a
 * manifest write: it MATERIALIZES a replacement node over the tool result it
 * prunes, and the manifest is reconciled against the surface on the next pass.
 * A fixture whose `append` discarded the event therefore could not tell a landed
 * prune from a forgotten one — `pruneSession` returned the same call id on every
 * pass and the idempotence check certified a no-op. Modelling the fold is what
 * makes those checks mean anything:
 *
 *   - `append` records the event;
 *   - `surfaceOp: 'replace'` splices the replacement into the shadowed span;
 *   - `surface.nodes` is read from that array.
 *
 * The harness's VALIDATION (balanced edges, source-event coverage, the
 * tool-result rewrite rule) is not reproduced here — it lives in
 * `test-dcp-materialization.mjs`, which runs a real `@deepseek-ai/dsh-session`.
 * This fixture is for the strategy decisions and the manifest.
 *
 * @param events - `[type, data]` pairs appended in order.
 * @returns the session, plus a fingerprint of its stored messages.
 */
function fakeSession(events) {
  const ids = new Map();
  let nextId = 0;
  const idOf = (seq) => {
    if (!ids.has(seq)) ids.set(seq, `msg-${(nextId += 1)}`);
    return ids.get(seq);
  };
  const log = events.map(([type, data], seq) => ({ type, seq, time: seq, data }));
  const bySeq = new Map(log.map((event) => [event.seq, event]));
  const surfaceTypes = new Set(['user/message', 'assistant/message', 'tool/result', 'system/message']);
  const nodes = log.filter((event) => surfaceTypes.has(event.type)).map((event) => event.seq);
  const deriveEventMessage = (event) => {
    if (event === undefined) return null;
    if (event.type === 'assistant/message') {
      const message = event.data.message;
      if (message === undefined || message.content.length === 0) return null;
      return { id: idOf(event.seq), role: 'assistant', content: message.content, source: { kind: 'model', provider: 'p', model: 'm' } };
    }
    if (event.type === 'user/message') return { id: idOf(event.seq), role: 'user', content: event.data.content, source: { kind: 'plugin:test' } };
    if (event.type === 'tool/result') return { ...event.data.message, id: idOf(event.seq), role: 'user' };
    return null;
  };
  const session = {
    id: uniqueSessionId(),
    header: { origin: 'user', delegationDepth: 0 },
    seq: log.length,
    surface: { nodes, replaceGeneration: 0 },
    eventAt: (seq) => bySeq.get(seq),
    deriveEventMessage,
    /** The append-only log, in seq order. */
    snapshotEvents: () => [...log],
    /**
     * Append one event, folding its surface operation.
     *
     * @param type - the event type.
     * @param data - the event payload.
     * @param options - `surfaceOp` as a marker or `{op, startSeq, endSeq}`.
     * @returns the recorded event.
     */
    append(type, data, options = {}) {
      // `seq` IS THE POSITION THE EVENT IS ABOUT TO TAKE, so it is read BEFORE the
      // push. Reading it after gave every event the index of its successor: the
      // log still looked right, but `eventAt(seq)` returned the NEXT event, and a
      // surface replacement recorded `startSeq: 2` for the event at 3 - so the
      // splice matched the wrong node and the prune never reached the model.
      const seq = log.length;
      const event = { type, seq, time: seq, data };
      log.push(event);
      bySeq.set(seq, event);
      session.seq = log.length;
      const marker = typeof options.surfaceOp === 'string' ? options.surfaceOp : options.surfaceOp?.op;
      if (marker === 'append' && surfaceTypes.has(type)) {
        nodes.push(seq);
      } else if (marker === 'replace' && options.surfaceOp !== null && typeof options.surfaceOp === 'object') {
        const from = nodes.indexOf(options.surfaceOp.startSeq);
        const to = nodes.indexOf(options.surfaceOp.endSeq);
        if (from !== -1 && to !== -1) nodes.splice(from, to - from + 1, seq);
        session.surface.replaceGeneration += 1;
      }
      return event;
    }
  };
  return session;
}

/** The request the port would send for this session, through the REAL rewrite. */
const requestFor = (session, engine) => {
  const outgoing = session.surface.nodes
    .map((seq) => session.deriveEventMessage(session.eventAt(seq)))
    .filter((message) => message !== null);
  return rewriteOutgoingMessages(outgoing, engine.blocksFor(session));
};

/**
 * Every text fragment in a request, so a check can assert on what the model reads.
 *
 * The walk is RECURSIVE on purpose: a tool result carries its text one level
 * deeper, inside `content[0].content`. A flat walk sees an empty string for
 * every result, which makes "the payload is gone" pass vacuously — the failure
 * mode a pruning test must never have.
 *
 * Tool-call ARGUMENTS are deliberately NOT included: the strategies prune outputs
 * and (for failures) inputs, and a check about one must not be satisfied or
 * broken by the other.
 */
const requestText = (messages) => messages.map((message) => textOf(message.content ?? [])).join('\n');

/** The tool-call arguments in a request, as one string. */
const requestArguments = (messages) => messages
  .flatMap((message) => (message.content ?? []).filter((block) => block?.type === 'tool-call'))
  .map((block) => block.arguments ?? '')
  .join('\n');

/** The text of one content-block list, at any depth. */
function textOf(blocks) {
  const parts = [];
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block?.type === 'tool-result') parts.push(textOf(block.content ?? []));
  }
  return parts.join('');
}

/**
 * A fingerprint of the session that a prune may NOT change: the append-only log.
 *
 * The SURFACE legitimately changes — a prune is a replacement node — so a check
 * that reads the surface cannot say "nothing was modified". What must survive is
 * the LOG: every original event, in order, with its payload intact. That is the
 * durable record `decompress` reads and an audit compares against.
 *
 * @param session - the session to fingerprint.
 * @returns the log's length and its full text.
 */
const storedBefore = (session) => ({ events: session.snapshotEvents().length, text: JSON.stringify(session.snapshotEvents()) });

/**
 * The event log of one REAL turn, in the shape `dsh-agent-loop` writes it.
 *
 * The shape is not decoration, it is the thing the age policies read:
 * `dsh-agent-loop\lib\index.js:919-1007` writes `turn/start {turn}` once per user
 * turn, then per iteration of its inner loop `step/start {turn, step}`,
 * `step/end {turn, step}`, and finally `turn/end`. `turn` is assigned per USER
 * turn (`index.js:924,930`) — so it is monotonic but NOT a step counter — which
 * is why the port's age unit is the count of `step/start`, matching upstream's
 * increment on every `step-start` part.
 *
 * Every fixture whose calls are aged by a policy has to be built from these
 * events. A fixture that marks turns and nothing else has a step age of ZERO for
 * everything in it, so `turnProtection` protects all of it — the suite then
 * measures protection while believing it measures age, which is exactly the trap
 * the age-unit bug hid in for the whole life of the port.
 *
 * @param steps - one entry per step. A step is ONE assistant message, so `calls`
 *   is the set of invocations batched into it — the port groups the surface the
 *   same way (`readSteps`: one step per `assistant/message`). `body` is the
 *   result text of the step's calls, and a call may override it with its own.
 * @returns `[type, data]` pairs for `fakeSession`.
 */
function stepsSession(steps) {
  const events = [['turn/start', { turn: 1 }]];
  steps.forEach((step, index) => {
    const position = index + 1;
    events.push(['step/start', { turn: 1, step: position }]);
    events.push(['assistant/message', { message: assistantCall(step.calls) }]);
    for (const call of step.calls) {
      // BOTH fields fall back to the STEP, because a step whose single call fails
      // is the common shape and the call-level override is the exception. Reading
      // only `call.isError` here silently dropped a step-level error flag — the
      // failed call arrived at the strategies as a SUCCESSFUL one, `purgeErrors`
      // skipped it, and the fixture looked like it had proved something about
      // age while testing nothing at all.
      const body = call.body ?? step.body ?? `${call.id}-body`;
      events.push(['tool/result', {
        message: toolResult(call.id, body, (call.isError ?? step.isError) === true, call.name)
      }]);
    }
    events.push(['step/end', { turn: 1, step: position }]);
  });
  events.push(['turn/end', { turn: 1, reason: 'stop' }]);
  return events;
}

/** A duplicate pair: the same call twice, two steps apart, in one turn. */
const duplicatePair = (name, args, body) => stepsSession([
  { calls: [{ id: 'c1', name, arguments: args }], body },
  { calls: [{ id: 'c2', name, arguments: args }], body }
]);

/* ------------------------------------------------------------------- dedup */
{
  // The two bodies DIFFER on purpose. With one shared body the fixture cannot
  // tell "the older copy was pruned" from "nothing was pruned at all", so the
  // check would pass for the wrong reason.
  const { engine } = await mountEngine({});
  const session = fakeSession(stepsSession([
    { calls: [{ id: 'c1', name: 'bash', arguments: { command: 'ls' } }], body: 'OLDER-COPY' },
    { calls: [{ id: 'c2', name: 'bash', arguments: { command: 'ls' } }], body: 'NEWER-COPY' }
  ]));
  const before = storedBefore(session);

  const added = engine.pruneSession(session);
  check('dedup: the older duplicate enters the manifest', added.length === 1 && added[0].callId === 'c1', JSON.stringify(added.map((entry) => entry.callId)));

  const request = requestFor(session, engine);
  const sent = requestText(request);
  check('dedup: the pruned payload is gone from the request', !sent.includes('OLDER-COPY'), sent.slice(0, 120));
  check('dedup: the placeholder is what the model reads instead', sent.includes(PRUNED_TOOL_OUTPUT_REPLACEMENT), '');
  check(
    'dedup: the tool CALL survives — the transcript keeps its shape',
    request.some((message) => (message.content ?? []).some((block) => block.type === 'tool-call' && block.id === 'c1')),
    ''
  );
  check(
    'dedup: the tool RESULT survives as a node (only its payload was replaced)',
    request.some((message) => (message.content ?? []).some((block) => block.type === 'tool-result' && block.toolCallId === 'c1')),
    ''
  );
  check('dedup: the newest duplicate keeps its payload', sent.includes('NEWER-COPY'), '');
  // THE LOG IS EXTENDED, NEVER REWRITTEN. A prune materializes a replacement
  // node over the tool result, so the session grows - but the ORIGINAL event is
  // still in the append-only log, byte for byte, which is what makes the payload
  // recoverable and what upstream means by "your session history is never
  // modified". Asserting that the session is unchanged would now be asserting
  // that the prune never happened.
  check('dedup: the original event survives in the log', JSON.stringify(session.snapshotEvents()).includes('OLDER-COPY'), '');
  check('dedup: the log kept every earlier event', before.text.length > 0 && session.snapshotEvents().length > before.events, `${before.events} -> ${session.snapshotEvents().length}`);
}

{
  // Same invocation, same turn: only ONE of the two may be pruned, or a sweep
  // would leave the model with no copy of the output at all.
  const { engine } = await mountEngine({});
  const session = fakeSession(stepsSession([
    { calls: [{ id: 'c1', name: 'bash', arguments: { command: 'ls' } }], body: 'OLDER-COPY' },
    { calls: [{ id: 'c2', name: 'bash', arguments: { command: 'ls' } }], body: 'NEWER-COPY' }
  ]));
  const added = engine.pruneSession(session);
  const sent = requestText(requestFor(session, engine));
  check('dedup: only the EARLIER call is pruned, the newest keeps its payload', added.length === 1 && sent.includes('NEWER-COPY') && !sent.includes('OLDER-COPY'), `manifest=${added.length}`);
}

{
  const { engine } = await mountEngine({});
  const session = fakeSession(stepsSession([
    { calls: [{ id: 'c1', name: 'bash', arguments: { command: 'ls' } }], body: 'ok' },
    { calls: [{ id: 'c2', name: 'bash', arguments: { command: 'ls -la' } }], body: 'ok' }
  ]));
  const added = engine.pruneSession(session);
  check('dedup: different arguments are not duplicates', added.length === 0, '');
}

{
  const { engine } = await mountEngine({});
  const session = fakeSession(duplicatePair('skill', { name: 'x' }, 'skill body'));
  const added = engine.pruneSession(session);
  check('dedup: command/compress defaults do not leak into automatic strategies', added.length === 1 && added[0].callId === 'c1', JSON.stringify(added.map((entry) => entry.callId)));
}

{
  const { engine } = await mountEngine({ protectedFilePatterns: ['*.env'] });
  const session = fakeSession(duplicatePair('read', { filePath: '.env' }, 'SECRET=1'));
  const added = engine.pruneSession(session);
  check('dedup: a protected file glob (*.env) is never pruned', added.length === 0, '');
}

{
  check('protected patterns normalize Windows separators', matchesGlob('src\\nested\\a.env', '**/*.env'));
  check('protected patterns do not invent a basename fallback', !matchesGlob('src/nested/a.env', '*.env'));
  check('protected patterns remain case-sensitive', !matchesGlob('SRC/a.env', 'src/*.env'));
  const patchPaths = filePathsOf({ patchText: '*** Begin Patch\n*** Update File: src/a.js\n*** Add File: src/b.js\n*** End Patch' }, 'apply_patch');
  check('apply_patch paths are extracted exactly once', JSON.stringify(patchPaths) === '["src/a.js","src/b.js"]', JSON.stringify(patchPaths));
  const editPaths = filePathsOf({ filePath: 'src/a.js', edits: [{ filePath: 'src/b.js' }] }, 'multiedit');
  check('multiedit top-level and nested paths are extracted', JSON.stringify(editPaths) === '["src/a.js","src/b.js"]', JSON.stringify(editPaths));
}

{
  // A TOOL-NAME GLOB. Upstream splits `protectedTools` into exact names and globs
  // (`lib/protected-patterns.ts:113-132`) and tries the exact set first; the port
  // compared with `Array.includes`, so a pattern like `mcp_*` matched nothing and
  // silently protected nothing.
  const { engine } = await mountEngine({ strategies: { deduplication: { protectedTools: ['mcp_*'] } } });
  const session = fakeSession(duplicatePair('mcp_filesystem_read', { filePath: 'a.js' }, 'body'));
  const added = engine.pruneSession(session);
  check('dedup: a protected tool GLOB is honoured', added.length === 0, JSON.stringify(added.map((entry) => entry.callId)));

  // The control: a name the glob does NOT cover is still pruned, so the check
  // above cannot pass by having disabled the strategy.
  const control = fakeSession(duplicatePair('mcpq_read', { filePath: 'a.js' }, 'body'));
  const pruned = engine.pruneSession(control);
  check('dedup: a name the glob does not cover is still pruned', pruned.length === 1, JSON.stringify(pruned.map((entry) => entry.callId)));

  // And an exact name still compares literally rather than as a pattern.
  const exactEngine = (await mountEngine({ strategies: { deduplication: { protectedTools: ['read.all'] } } })).engine;
  const literal = fakeSession(duplicatePair('readXall', { filePath: 'a.js' }, 'body'));
  check('dedup: an exact protected name is not a pattern', exactEngine.pruneSession(literal).length === 1, '');
  const dotted = fakeSession(duplicatePair('read.all', { filePath: 'a.js' }, 'body'));
  check('dedup: and it does match itself', exactEngine.pruneSession(dotted).length === 0, '');
}

{
  // A batch that only PARTLY repeats: the batch must never be split, and the
  // repeated call inside it must still be handled. The old design could not
  // express this — its unit was the step, so it either took the whole batch or
  // nothing.
  const { engine } = await mountEngine({});
  const session = fakeSession(stepsSession([
    {
      calls: [
        { id: 'c1', name: 'read', arguments: { filePath: 'a.js' }, body: 'FIRST-READ-OF-A' },
        { id: 'c2', name: 'read', arguments: { filePath: 'b.js' }, body: 'contents of b.js' }
      ]
    },
    { calls: [{ id: 'c3', name: 'read', arguments: { filePath: 'a.js' } }], body: 'SECOND-READ-OF-A' }
  ]));
  const added = engine.pruneSession(session);
  const request = requestFor(session, engine);
  const sent = requestText(request);
  check('dedup: the repeated call inside a batch IS pruned', added.length === 1 && added[0].callId === 'c1', JSON.stringify(added.map((entry) => entry.callId)));
  check('dedup: the batch’s SIBLING result survives intact', sent.includes('contents of b.js'), '');
  check('dedup: the repeated payload is gone', !sent.includes('FIRST-READ-OF-A'), '');
  check('dedup: the replacement copy is untouched', sent.includes('SECOND-READ-OF-A'), '');
  check(
    'dedup: batch order is preserved (a.js call, then b.js result)',
    request.findIndex((message) => (message.content ?? []).some((block) => block.toolCallId === 'c1'))
      < request.findIndex((message) => (message.content ?? []).some((block) => block.toolCallId === 'c2')),
    ''
  );
}

{
  // Two identical calls in ONE assistant message. Upstream's grouping is a flat
  // list, so the first of the two is a duplicate of the second.
  const { engine } = await mountEngine({});
  const session = fakeSession(stepsSession([
    {
      calls: [
        { id: 'c1', name: 'read', arguments: { filePath: 'a.js' }, body: 'first' },
        { id: 'c2', name: 'read', arguments: { filePath: 'a.js' }, body: 'second' }
      ]
    }
  ]));
  const added = engine.pruneSession(session);
  check('dedup: two identical calls in one message deduplicate against each other', added.length === 1 && added[0].callId === 'c1', JSON.stringify(added.map((entry) => entry.callId)));
}

{
  // The tool name is part of the signature: same arguments, different tools.
  const { engine } = await mountEngine({});
  const session = fakeSession(stepsSession([
    { calls: [{ id: 'c1', name: 'read', arguments: { filePath: 'a.js' } }], body: 'x' },
    { calls: [{ id: 'c2', name: 'grep', arguments: { filePath: 'a.js' } }], body: 'y' }
  ]));
  const added = engine.pruneSession(session);
  check('dedup: the tool name is part of the signature', added.length === 0, '');
}

{
  // A null argument field must not make two invocations look different: upstream
  // drops empty fields before comparing.
  const { engine } = await mountEngine({});
  const session = fakeSession(stepsSession([
    { calls: [{ id: 'c1', name: 'read', arguments: { filePath: 'a.js', limit: null } }], body: 'x' },
    { calls: [{ id: 'c2', name: 'read', arguments: { filePath: 'a.js' } }], body: 'x' }
  ]));
  const added = engine.pruneSession(session);
  check('dedup: a null argument field is ignored when comparing', added.length === 1, JSON.stringify(added.map((entry) => entry.callId)));
}

{
  // KEY ORDER IS NOT PART OF AN INVOCATION. Upstream sorts the keys recursively
  // before it compares (`lib/strategies/deduplication.ts:118-127`), and an
  // unordered comparison would leave a duplicate in context whenever a model
  // emitted the same arguments in a different order — or whenever one side came
  // from a resumed log. The nested object is the part a top-level sort misses.
  //
  // The tool is `read`, not `edit`/`write`: those two are in the default
  // `protectedTools` list for this strategy, so a fixture built on them would be
  // filtered out before the signature was ever computed and the check would fail
  // while the sorting worked.
  const { engine } = await mountEngine({});
  const session = fakeSession(stepsSession([
    { calls: [{ id: 'c1', name: 'read', arguments: { filePath: 'a.js', options: { z: 1, a: { deep: true, deep2: 2 } }, line: 3 } }], body: 'OLDER-' },
    { calls: [{ id: 'c2', name: 'read', arguments: { line: 3, options: { a: { deep2: 2, deep: true }, z: 1 }, filePath: 'a.js' } }], body: 'NEWER-' }
  ]));
  const added = engine.pruneSession(session);
  check(
    'dedup: the same arguments in a different key order are duplicates, at every depth',
    added.length === 1 && added[0].callId === 'c1',
    JSON.stringify(added.map((entry) => entry.callId))
  );
}

{
  // A second pass must not re-prune, and must not change what is already there.
  const { engine } = await mountEngine({});
  const session = fakeSession(duplicatePair('bash', { command: 'ls' }, 'out'));
  const first = engine.pruneSession(session);
  const second = engine.pruneSession(session);
  check('dedup: a second pass adds nothing (the manifest is one-way)', first.length === 1 && second.length === 0, `first=${first.length} second=${second.length}`);
  check('dedup: the manifest still holds exactly one call', engine.blocks.prunedToolCount === 1, String(engine.blocks.prunedToolCount));
}

{
  // Disabled strategy means no manifest, and therefore no rewrite.
  const { engine } = await mountEngine({ strategies: { deduplication: { enabled: false } } });
  const session = fakeSession(duplicatePair('bash', { command: 'ls' }, 'out'));
  const added = engine.pruneSession(session);
  const sent = requestText(requestFor(session, engine));
  check('dedup: strategies.deduplication.enabled=false disables it', added.length === 0 && sent.includes('out'), '');
}

{
  // Manual mode with automaticStrategies off: upstream refuses to run.
  const { engine } = await mountEngine({ manualMode: true, automaticStrategies: false });
  const session = fakeSession(duplicatePair('bash', { command: 'ls' }, 'out'));
  const added = engine.pruneSession(session);
  check('dedup: manual mode with automaticStrategies=false refuses to prune', added.length === 0, '');
}

/* -------------------------------------------------------------- purgeErrors */

/**
 * One failed `bash` call, `age` steps before the end of the session.
 *
 * `currentTurn` is the count of `step/start`, so the call's age is exactly
 * `total - 1` with the call in step 1 — a deterministic quantity to assert a
 * threshold against, which a turn-shaped fixture cannot express at all.
 *
 * @param total - how many steps the session holds.
 * @param age - how old the failed call is, in steps (0 = the newest step).
 * @param outcome - `'error'` fails the call.
 * @returns `[type, data]` pairs for `fakeSession`.
 */
function erroredCallAged(total, age, outcome = 'error') {
  const spec = Array.from({ length: total }, (_, index) => ({
    calls: [{ id: `c${index + 1}`, name: 'bash', arguments: { command: `cmd-${index + 1}` } }],
    body: `BODY-${index + 1}`
  }));
  const oldest = total - 1 - age;
  spec[oldest].calls[0].isError = outcome === 'error';
  return stepsSession(spec);
}

{
  const { engine } = await mountEngine({});
  // Steps, not turns: the default `purgeErrors.turns` is 4 and the age unit is a
  // STEP, so the fixture has to be a session with real `step/start` events. The
  // old fixture here marked only two turns, which the step rule rightly reads as
  // an age of 2 — the assertion was measuring the wrong quantity.
  const session = fakeSession(oneTurnWithSteps(5, { outcome: 'error' }));
  const before = storedBefore(session);
  const added = engine.pruneSession(session);
  const request = requestFor(session, engine);
  const sent = requestText(request);
  check('purgeErrors: an old errored call enters the manifest', added.length === 1 && added[0].callId === 'c1', JSON.stringify(added.map((entry) => entry.callId)));
  check('purgeErrors: the errored output is preserved', sent.includes('FIRST-BODY'), sent.slice(0, 200));
  check('purgeErrors: the note is not the completed-output placeholder', !sent.includes(PRUNED_TOOL_OUTPUT_REPLACEMENT), '');
  check('purgeErrors: the provider projection strips the top-level string input', requestArguments(request).includes('input removed due to failed tool call'), requestArguments(request));
  // The ERROR TEXT survives in the log: upstream blanks the call's inputs and
  // keeps the error, and the port can only blank the output — so this is the one
  // half of upstream's intent that is fully reachable, and it must hold. The
  // fixture's failed body is 'FIRST-BODY', so checking a literal like "command not
  // found" would assert something the fixture never contained (it passed by
  // reading a different fixture's text out of the whole log dump).
  check('purgeErrors: the ERROR ITSELF stays in the log', before.text.includes('FIRST-BODY'), '');
  check('purgeErrors: provider-only pruning does not grow the durable log', session.snapshotEvents().length === before.events, `${before.events} -> ${session.snapshotEvents().length}`);
}

{
  // Age 3 against the default threshold of 4: too fresh, and it is the AGE that
  // has to leave it alone here — the default turn window is 3, so a call three
  // steps old is protected as well. The next case separates the two.
  const { engine } = await mountEngine({});
  const session = fakeSession(erroredCallAged(4, 3));
  const added = engine.pruneSession(session);
  check('purgeErrors: a fresh error is left alone (threshold 4 steps)', added.length === 0, JSON.stringify(added.map((entry) => entry.callId)));
}

{
  // The AGE arm alone: `turnProtection.turns` is set below the age, so protection
  // cannot be the reason this call is skipped.
  const { engine } = await mountEngine({ strategies: { purgeErrors: { turns: 4 } }, turnProtection: { enabled: true, turns: 2 } });
  const session = fakeSession(erroredCallAged(6, 5));
  const added = engine.pruneSession(session);
  check(
    'purgeErrors: strategies.purgeErrors.turns decides — a five-step-old error is purged when it is not protected',
    added.length === 1 && added[0].callId === 'c1',
    JSON.stringify(added.map((entry) => entry.callId))
  );
}

{
  // A SUCCESSFUL call is never input-purged, however old it is.
  const { engine } = await mountEngine({ strategies: { purgeErrors: { turns: 1 } } });
  const session = fakeSession(erroredCallAged(9, 8, 'ok'));
  const added = engine.pruneSession(session);
  const request = requestFor(session, engine);
  check(
    'purgeErrors: a successful call keeps its input',
    added.length === 0 && requestArguments(request).includes('cmd-1'),
    `added=${added.length}`
  );
}

{
  const { engine } = await mountEngine({ strategies: { purgeErrors: { turns: 1, protectedTools: ['bash'] } } });
  const session = fakeSession(erroredCallAged(9, 8));
  const added = engine.pruneSession(session);
  check('purgeErrors: strategies.purgeErrors.protectedTools is honoured', added.length === 0, '');
}

/* ------------------------------------------------------- the manual sweep */

/**
 * Four steps, four DISTINCT calls, so `sweep N` has an unambiguous answer.
 *
 * Distinct on purpose: with repeated calls the strategies would prune some of
 * them, and the sweep would then be measured over fewer candidates than the
 * fixture appears to hold. Turn protection is off in these cases for the same
 * reason — the sweep's question is "which calls did the user ask for", not "which
 * ones are old enough".
 */
const sweepSession = () => stepsSession([
  { calls: [{ id: 'c1', name: 'read', arguments: { filePath: 'a.js' } }], body: 'BODY-ONE' },
  { calls: [{ id: 'c2', name: 'read', arguments: { filePath: 'b.js' } }], body: 'BODY-TWO' },
  { calls: [{ id: 'c3', name: 'read', arguments: { filePath: 'c.js' } }], body: 'BODY-THREE' },
  { calls: [{ id: 'c4', name: 'read', arguments: { filePath: 'd.js' } }], body: 'BODY-FOUR' }
]);

{
  // Upstream: `/dcp sweep N` takes the last N from `state.toolIdList`
  // (`lib/commands/sweep.ts:148-150`).
  const { engine } = await mountEngine({ turnProtection: { enabled: false } });
  const session = fakeSession(sweepSession());
  const added = engine.pruneSession(session, undefined, { sweep: { limit: 2 } });
  check(
    'sweep: the last N calls are the ones swept',
    added.length === 2 && added.map((entry) => entry.callId).join(',') === 'c3,c4',
    JSON.stringify(added.map((entry) => entry.callId))
  );
  check(
    'sweep: the swept entries carry the sweep label',
    added.length > 0 && added.every((entry) => entry.strategy === 'sweep'),
    `${added.length} entr(ies): ${JSON.stringify(added.map((entry) => entry.strategy))}`
  );
  const sent = requestText(requestFor(session, engine));
  check('sweep: the swept outputs are gone from what the model receives', !sent.includes('BODY-THREE') && !sent.includes('BODY-FOUR'), '');
  check('sweep: the untouched outputs are still there', sent.includes('BODY-ONE') && sent.includes('BODY-TWO'), '');
  check('sweep: the placeholder is what the model reads instead', sent.includes(PRUNED_TOOL_OUTPUT_REPLACEMENT), '');
}

{
  // Without a number, upstream sweeps everything after the last user message.
  const { engine } = await mountEngine({ turnProtection: { enabled: false } });
  const session = fakeSession([
    ['turn/start', { turn: 1 }],
    ['user/message', { content: [text('go')] }],
    ...sweepSession().slice(1)
  ]);
  const added = engine.pruneSession(session, undefined, { sweep: { sinceUserMessage: true } });
  check('sweep: with no count, everything after the last user message goes', added.length === 4, JSON.stringify(added.map((entry) => entry.callId)));
}

{
  // PROTECTION IS THE POINT OF `commands.protectedTools`, and upstream reports the
  // skips separately rather than letting them shrink the number silently.
  const { engine } = await mountEngine({
    turnProtection: { enabled: false },
    commands: { protectedTools: ['read'] }
  });
  const session = fakeSession(sweepSession());
  const added = engine.pruneSession(session, undefined, { sweep: { limit: 4 } });
  check('sweep: a protected tool is not swept', added.length === 0, JSON.stringify(added.map((entry) => entry.callId)));
  check('sweep: and the skip is counted, not swallowed', engine.lastSweep?.skippedProtected === 4, JSON.stringify(engine.lastSweep?.skippedProtected));
}

{
  const { engine } = await mountEngine({ turnProtection: { enabled: false } });
  const session = fakeSession(stepsSession([
    { calls: [{ id: 'c1', name: 'skill', arguments: { name: 'x' } }], body: 'SKILL-BODY' }
  ]));
  const added = engine.pruneSession(session, undefined, { sweep: { limit: 1 } });
  check('sweep: mapped upstream command defaults still protect skill', added.length === 0 && engine.lastSweep?.skippedProtected === 1, JSON.stringify(added));
}

{
  // A sweep REPLACES the automatic pass for that call: the strategy list must not
  // run beside it, or "sweep the last 2" would quietly prune other calls too.
  const { engine } = await mountEngine({ turnProtection: { enabled: false } });
  const session = fakeSession(stepsSession([
    { calls: [{ id: 'c1', name: 'read', arguments: { filePath: 'a.js' } }], body: 'OLDER-COPY' },
    { calls: [{ id: 'c2', name: 'read', arguments: { filePath: 'a.js' } }], body: 'NEWER-COPY' },
    { calls: [{ id: 'c3', name: 'read', arguments: { filePath: 'z.js' } }], body: 'UNRELATED' }
  ]));
  // The two identical calls would be deduplicated by an automatic pass.
  const added = engine.pruneSession(session, undefined, { sweep: { limit: 1 } });
  check(
    'sweep: the automatic strategies do not also run',
    added.length === 1 && added[0].callId === 'c3',
    JSON.stringify(added.map((entry) => entry.callId))
  );
  const sent = requestText(requestFor(session, engine));
  check('sweep: so the duplicate is left alone', sent.includes('OLDER-COPY') && !sent.includes('UNRELATED'), '');
}

{
  // Idempotence, as with every other path: a second sweep of the same calls adds
  // nothing, because the manifest already names them.
  const { engine } = await mountEngine({ turnProtection: { enabled: false } });
  const session = fakeSession(sweepSession());
  const first = engine.pruneSession(session, undefined, { sweep: { limit: 4 } });
  const second = engine.pruneSession(session, undefined, { sweep: { limit: 4 } });
  check('sweep: a second sweep of the same range adds nothing', first.length === 4 && second.length === 0, `first=${first.length} second=${second.length}`);
}

/* ---------------------------------------------------------- turnProtection */

/**
 * Four steps whose deduplication answer depends on ONE thing: the window.
 *
 * `c1` and `c2` are the same invocation, so dedup prunes the OLDER copy — and
 * "older" is exactly what the protection window filters out. `c1` is three steps
 * old, `c2` two, and the last two steps hold unique calls.
 *
 * THE TWO TRAILING STEPS ARE THE POINT. `isTurnProtected` is
 * `currentTurn - turn < turns` and `currentTurn` is the TOTAL step count, so the
 * newest call is protected by ANY window of 1 or more whenever it sits in the
 * last step — a session like that has no deduplication candidate at all, and a
 * check asserting "nothing was pruned" on it proves nothing about the window. The
 * newest copy of a prunable pair has to be at least `turns` steps from the end.
 *
 * @returns `[type, data]` pairs for `fakeSession`.
 */
const windowProbeSession = () => stepsSession([
  { calls: [{ id: 'c1', name: 'bash', arguments: { command: 'same-command' } }], body: 'OLDEST-COPY' },
  { calls: [{ id: 'c2', name: 'bash', arguments: { command: 'same-command' } }], body: 'NEWEST-COPY' },
  { calls: [{ id: 'c3', name: 'read', arguments: { filePath: 'unique.js' } }], body: 'MIDDLE-UNIQUE' },
  { calls: [{ id: 'c4', name: 'read', arguments: { filePath: 'trailing.js' } }], body: 'TRAILING' }
]);

/**
 * The age the fixture above gives each call, and the window each needs.
 *
 * `currentTurn` = 4; `c1` is 3 steps old, `c2` 2, `c3` 1, `c4` 0.
 */
{
  // c1 (age 3) and c2 (age 2) are both inside a window of 3: no copy is eligible,
  // so the pair is left alone — and so is everything else in the log.
  const { engine } = await mountEngine({ turnProtection: { enabled: true, turns: 3 } });
  const session = fakeSession(windowProbeSession());
  const added = engine.pruneSession(session);
  const sent = requestText(requestFor(session, engine));
  check(
    'turnProtection: a call inside the protected window is never recorded',
    added.length === 0,
    JSON.stringify(added.map((entry) => entry.callId))
  );
  check('turnProtection: the protected window leaves the payloads alone', sent.includes('OLDEST-COPY') && sent.includes('MIDDLE-UNIQUE'), '');
}

{
  // The same log, one narrower window. Now c1 (age 3) is eligible while c2 (age 2)
  // is not, so the pair is pruned down to its protected copy — nothing but the
  // window changed, so the window is what decided it.
  const { engine } = await mountEngine({ turnProtection: { enabled: true, turns: 1 } });
  const session = fakeSession(windowProbeSession());
  const added = engine.pruneSession(session);
  const sent = requestText(requestFor(session, engine));
  check(
    'turnProtection: a call OUTSIDE the window is prunable',
    added.length === 1 && added[0].callId === 'c1',
    JSON.stringify(added.map((entry) => entry.callId))
  );
  check(
    'turnProtection: the protected copy keeps its payload while the older copy loses it',
    !sent.includes('OLDEST-COPY') && sent.includes('NEWEST-COPY') && sent.includes('MIDDLE-UNIQUE'),
    ''
  );
}

/* ------------------------------------------- the age unit is a STEP, not a turn */

/**
 * One user turn holding `steps` steps, each with one call and one result.
 *
 * `outcome: 'error'` fails the FIRST call (`bash`) only, so the checks can tell
 * "the errored call was handled" from "every call was".
 *
 * @param steps - how many steps the turn takes.
 * @param options - `caller` (tool of the first call) and `outcome`.
 * @returns `[type, data]` pairs for `fakeSession`.
 */
function oneTurnWithSteps(steps, { caller = 'bash', outcome = 'ok' } = {}) {
  return stepsSession(Array.from({ length: steps }, (_, index) => {
    const position = index + 1;
    const first = position === 1;
    return {
      calls: [{
        id: `c${position}`,
        name: first ? caller : 'read',
        arguments: { path: `f${position}`, command: `c${position}` }
      }],
      body: first ? 'FIRST-BODY' : `BODY-${position}`,
      isError: first && outcome === 'error'
    };
  }));
}

{
  // The whole point of the unit: a call six steps old inside ONE user turn is
  // outside a four-step window, so it is pruned. While the port counted
  // `turn/start` events instead, its age inside a single turn was zero and
  // protection swallowed it — which is what the audits measured on the user's own
  // session log (`turn/start` = 36 against `step/start` = 1503).
  const { engine } = await mountEngine({ turnProtection: { enabled: true, turns: 4 } });
  const added = engine.pruneSession(fakeSession(oneTurnWithSteps(6, { outcome: 'error' })));
  check(
    'turnProtection: the window counts STEPS, so a six-step-old call inside one turn is pruned',
    added.length === 1 && added[0].callId === 'c1',
    JSON.stringify(added.map((entry) => entry.callId))
  );
}

{
  // The same arithmetic must govern purgeErrors, whose threshold is
  // `Math.max(1, turns)` against `currentTurn - metadata.turn`.
  const { engine } = await mountEngine({ strategies: { purgeErrors: { enabled: true, turns: 4 } } });
  const session = fakeSession(oneTurnWithSteps(5, { outcome: 'error' }));
  const added = engine.pruneSession(session);
  const sent = requestText(requestFor(session, engine));
  // The outcome, not a field: `pruneSession`'s report is what it PRUNED
  // (strategy, callId, tokens, label) and it has never carried the manifest's
  // `prune` half — asserting `added[0].prune === 'inputs'` compared `undefined`
  // against a string. That the note for a FAILED call went out instead of the
  // completed-output placeholder is the observable form of the same fact.
  check(
    'purgeErrors: a five-step-old errored call inside one turn is purged',
    added.length === 1 && added[0].callId === 'c1' && added[0].kind === 'error-input' && sent.includes('FIRST-BODY') && !sent.includes(PRUNED_TOOL_OUTPUT_REPLACEMENT),
    JSON.stringify(added.map((entry) => entry.callId))
  );
}

{
  // The window must still protect: five steps against a window of six.
  const { engine } = await mountEngine({ turnProtection: { enabled: true, turns: 6 } });
  const added = engine.pruneSession(fakeSession(oneTurnWithSteps(5, { outcome: 'error' })));
  check('turnProtection: a five-step-old call is still protected by a six-step window', added.length === 0, JSON.stringify(added.map((entry) => entry.callId)));
}

/* ------------------------------------------------------ the manifest itself */

{
  const { engine } = await mountEngine({});
  const session = fakeSession(duplicatePair('bash', { command: 'ls' }, 'out'));
  engine.pruneSession(session);
  const persisted = engine.blocks.toJSON();
  check(
    'manifest: persisted as a record of callId -> tokens (upstream `prune.tools`)',
    persisted.prunedToolIds !== null && typeof persisted.prunedToolIds === 'object'
      && !Array.isArray(persisted.prunedToolIds)
      && Object.keys(persisted.prunedToolIds).includes('c1'),
    JSON.stringify(persisted.prunedToolIds).slice(0, 120)
  );

  const restored = new DcpBlockState(JSON.parse(JSON.stringify(persisted)));
  check('manifest: survives a restart (serialize -> restore)', restored.prunedToolCount === engine.blocks.prunedToolCount, `${restored.prunedToolCount} vs ${engine.blocks.prunedToolCount}`);
  check('manifest: the restored manifest still rewrites the request', restored.prunedToolIds.has('c1'), '');

  const legacy = new DcpBlockState({ prunedToolIds: ['legacy-1', 'legacy-2'] });
  check('manifest: the legacy bare-list shape still loads', legacy.prunedToolCount === 2, String(legacy.prunedToolCount));

  const junk = new DcpBlockState({ prunedToolIds: { good: 12, bad: 'nope' } });
  check('manifest: a non-numeric token count degrades to 0 instead of throwing', junk.prunedToolIds.get('good') === 12 && junk.prunedToolIds.get('bad') === 0, '');
}

/* ------------------------------------------------------------ nothing to do */

{
  const { engine } = await mountEngine({});
  const session = fakeSession(stepsSession([
    { calls: [{ id: 'c1', name: 'read', arguments: { filePath: 'a.js' } }], body: 'unique body' }
  ]));
  const added = engine.pruneSession(session);
  const request = requestFor(session, engine);
  check('no-op: nothing prunable means no manifest entry', added.length === 0, '');
  check('no-op: the request is returned unchanged when nothing is pruned', requestText(request).includes('unique body'), '');
}

{
  // An in-flight call (no result yet) must never be pruned: upstream has no
  // metadata for it, and a call whose result has not arrived cannot be replaced.
  const { engine } = await mountEngine({});
  const session = fakeSession([
    ...stepsSession([{ calls: [{ id: 'c1', name: 'read', arguments: { filePath: 'a.js' } }], body: 'one' }]),
    // The second call's RESULT never lands, and its arguments differ so the dedup
    // signature cannot be what spares it — only "no result on the surface" can.
    ['step/start', { turn: 1, step: 2 }],
    ['assistant/message', { message: assistantCall([{ id: 'c2', name: 'read', arguments: { filePath: 'b.js' } }]) }]
  ]);
  const added = engine.pruneSession(session);
  check('in-flight: a call with no result on the surface is never pruned', added.length === 0, JSON.stringify(added.map((entry) => entry.callId)));
}

/* -------------------------------------------------------------- subagent ban */

{
  const { engine } = await mountEngine({ experimental: { allowSubAgents: false } });
  const session = fakeSession(duplicatePair('bash', { command: 'ls' }, 'out'));
  session.header = { origin: 'subagent', delegationDepth: 1 };
  const added = engine.pruneSession(session);
  check('subagent: experimental.allowSubAgents=false refuses a delegated session', added.length === 0, '');
}

{
  const { engine } = await mountEngine({ experimental: { allowSubAgents: true } });
  const session = fakeSession(duplicatePair('bash', { command: 'ls' }, 'out'));
  session.header = { origin: 'subagent', delegationDepth: 1 };
  const added = engine.pruneSession(session);
  check('subagent: experimental.allowSubAgents=true permits it', added.length === 1, '');
}

/* ------------------------------------------------- on the live request path */

console.log('\n--- the passes run by themselves, on every session event ---');
{
  // THE PROPERTY THAT MAKES THIS A PRODUCT RATHER THAN A COMMAND. Upstream runs
  // the strategies from its chat transform, so a user who never calls `compress`
  // still gets repeated tool output pruned. The port hangs the same discovery on
  // `session/event`: a `tool/result` landing is the moment a duplicate can exist,
  // and the pass is DEFERRED to a microtask because `Session.append` throws when
  // it is re-entered from inside its own observer.
  //
  // This case therefore uses a REAL session and drives the real seam. Two facts
  // make it work, and both were learned the hard way:
  //
  //   - `session/event` is delivered through the STORE's entry for a session, so a
  //     detached `Session.create()` notifies nobody. The store here is created
  //     lazily by `mountEngine` and handed to the plugin as its `sessions` service;
  //   - `create()` enters the session inside a cordis effect, and delivery exists
  //     only once the entry does, so the fixture waits for the store to own it.
  const { Context } = await import('@deepseek-ai/cordis');
  const { SessionStore } = await import('@deepseek-ai/dsh-session');
  const llm = await import('@deepseek-ai/dsh-llm');
  const context = new Context();
  // The store is built on the SAME context the plugin is mounted on, which is the
  // only arrangement in which `session/event` reaches the plugin at all.
  const store = new SessionStore(context);
  const { engine, meter } = await mountEngine({}, { context, sessions: store, store });
  let estimateCalls = 0;
  const estimateMessage = meter.estimateMessage;
  meter.estimateMessage = (message) => {
    estimateCalls += 1;
    return estimateMessage(message);
  };
  const session = store.create(undefined, { meta: { cwd: process.cwd() } });
  for (let attempt = 0; attempt < 50 && store.get(session.id) === undefined; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  check('the store owns the session before anything is appended', store.get(session.id) !== undefined, String(session.id));
  session.append('turn/start', { turn: 1 });
  session.append('user/message', llm.createUserMessage({ content: [text('go')], source: { kind: 'user' } }), { surfaceOp: 'append' });
  // The assistant's own text must NOT repeat the tool output: a fixture whose two
  // halves share a string cannot tell "the result was pruned" from "nothing was",
  // and the "gone from what the model receives" check would fail on the assistant
  // message while the prune had in fact landed.
  const exchange = (turn, step, callId, body) => {
    session.append('assistant/message', {
      turn, step, stream: [],
      message: llm.createAssistantMessage({
        content: [text(`calling ${callId}`), { type: 'tool-call', id: llm.ToolCallId(callId), name: 'read', arguments: JSON.stringify({ filePath: 'a.js' }) }],
        source: { kind: 'model', provider: 'p', model: 'm' }
      })
    }, { surfaceOp: 'append' });
    session.append('tool/result', {
      turn, step,
      message: llm.createToolResultMessage({ callId: llm.ToolCallId(callId), content: [text(body)], isError: false })
    }, { surfaceOp: 'append' });
  };
  exchange(1, 1, 'c1', 'OLD-READ-BODY');
  exchange(2, 1, 'c2', 'NEW-READ-BODY');

  // ONE microtask turn is all the deferral costs, so this is not a sleep.
  await new Promise((resolve) => setTimeout(resolve, 0));

  const state = engine.blocksFor(session);
  const view = JSON.stringify(session.deriveMessages());
  check('a landed tool result triggers the pass with no compress call', state.prunedToolCount === 1, String(state.prunedToolCount));
  check('the duplicate is gone from what the model receives', !view.includes('OLD-READ-BODY'), view.slice(0, 160));
  check('the surviving copy is untouched', view.includes('NEW-READ-BODY'), '');
  check('the placeholder is what the model reads instead', view.includes(PRUNED_TOOL_OUTPUT_REPLACEMENT), '');
  check('the pruned call was materialized on the surface', state.prunedNodeFor('c1') !== undefined, JSON.stringify(state.prunedNodeFor('c1') ?? null));
  check('a synchronous result burst schedules one automatic pass', engine.guardCounts.automaticScheduled === 1 && engine.guardCounts.automaticCoalesced === 1 && engine.guardCounts.automaticExecuted === 1, JSON.stringify(engine.guardCounts));
  check('default planners share one measured tool snapshot', engine.guardCounts.planningSnapshots === 1 && estimateCalls === 2, `${engine.guardCounts.planningSnapshots} snapshot(s), ${estimateCalls} estimate(s)`);

  const skippedBefore = engine.guardCounts.automaticSkippedClean;
  engine.runAutomaticPrune(session, undefined, 'pre-step');
  check('an unchanged pre-step does not rescan history', engine.guardCounts.automaticSkippedClean === skippedBefore + 1 && estimateCalls === 2, JSON.stringify(engine.guardCounts));

  const flushedBefore = engine.guardCounts.automaticFlushed;
  const executedBeforeFlush = engine.guardCounts.automaticExecuted;
  engine.scheduleAutomaticPrune(session, session.seq);
  engine.runAutomaticPrune(session, undefined, 'pre-step');
  await Promise.resolve();
  check('pre-step flushes pending work before its queued callback', engine.guardCounts.automaticFlushed === flushedBefore + 1 && engine.guardCounts.automaticExecuted === executedBeforeFlush + 1, JSON.stringify(engine.guardCounts));

  const canceledBefore = engine.guardCounts.automaticCanceled;
  const executedBeforeDispose = engine.guardCounts.automaticExecuted;
  engine.scheduleAutomaticPrune(session, session.seq);
  engine.disposeSession(session);
  await Promise.resolve();
  check('disposed sessions cancel queued automatic work', engine.guardCounts.automaticCanceled === canceledBefore + 1 && engine.guardCounts.automaticExecuted === executedBeforeDispose, JSON.stringify(engine.guardCounts));
  check('disposed sessions release in-memory state only', !engine._blocksBySession.has(String(session.id)) && !engine._automaticPrunes.has(String(session.id)) && !engine._wireEstimates.has(String(session.id)), String(session.id));

  const reusedId = `reused-${process.pid}`;
  const oldObject = { id: reusedId, seq: 0, surface: { nodes: [] }, eventAt: () => undefined, snapshotEvents: () => [] };
  const replacementObject = { ...oldObject, surface: { nodes: [] } };
  engine.scheduleAutomaticPrune(oldObject, 0);
  engine.blocksFor(oldObject);
  const canceledBeforeReuse = engine.guardCounts.automaticCanceled;
  const replacementState = engine.blocksFor(replacementObject);
  const replacementJournal = { owner: replacementObject };
  const replacementEstimate = { inputTokens: 12 };
  const replacementNudge = { text: 'replacement' };
  const replacementGeneration = replacementState.mutationVersion;
  engine._compressionJournals.set(reusedId, replacementJournal);
  engine._compressionLandingLocks.add(reusedId);
  engine._wireEstimates.set(reusedId, replacementEstimate);
  engine._nudgePrompt ??= new Map();
  engine._nudgePrompt.set(reusedId, replacementNudge);
  engine._persistedBlockVersions.set(reusedId, replacementGeneration);
  engine._lastSession = replacementObject;
  engine.disposeSession(oldObject);
  check('a blocksFor owner change cancels the old object’s queued work', engine.guardCounts.automaticCanceled === canceledBeforeReuse + 1 && !engine._automaticPrunes.has(reusedId), JSON.stringify(engine.guardCounts));
  check(
    'late disposal cannot erase replacement state after only a blocksFor touch',
    engine._sessionOwners.get(reusedId) === replacementObject
      && engine._blocksBySession.get(reusedId) === replacementState
      && engine._compressionJournals.get(reusedId) === replacementJournal
      && engine._compressionLandingLocks.has(reusedId)
      && engine._wireEstimates.get(reusedId) === replacementEstimate
      && engine._nudgePrompt.get(reusedId) === replacementNudge
      && engine._persistedBlockVersions.get(reusedId) === replacementGeneration
      && engine._blocksSessionId === reusedId
      && engine._lastSession === replacementObject,
    reusedId
  );
  engine.disposeSession(replacementObject);
  await Promise.resolve();

  const scheduleOnlyId = `schedule-only-reused-${process.pid}`;
  const scheduleOnlyOld = { id: scheduleOnlyId, seq: 0, surface: { nodes: [] }, eventAt: () => undefined, snapshotEvents: () => [] };
  const scheduleOnlyReplacement = { ...scheduleOnlyOld, surface: { nodes: [] } };
  engine.blocksFor(scheduleOnlyOld);
  const canceledBeforeScheduleOnlyDispose = engine.guardCounts.automaticCanceled;
  const executedBeforeScheduleOnlyDispose = engine.guardCounts.automaticExecuted;
  engine.scheduleAutomaticPrune(scheduleOnlyReplacement, 0);
  check(
    'a schedule-only replacement claims ownership before its queued pass',
    engine._sessionOwners.get(scheduleOnlyId) === scheduleOnlyReplacement
      && engine._automaticPrunes.get(scheduleOnlyId)?.session === scheduleOnlyReplacement,
    scheduleOnlyId
  );
  engine.disposeSession(scheduleOnlyReplacement);
  await Promise.resolve();
  check(
    'disposing a schedule-only replacement cancels its queued pass and releases reused-id state',
    engine.guardCounts.automaticCanceled === canceledBeforeScheduleOnlyDispose + 1
      && engine.guardCounts.automaticExecuted === executedBeforeScheduleOnlyDispose
      && !engine._sessionOwners.has(scheduleOnlyId)
      && !engine._automaticPrunes.has(scheduleOnlyId)
      && !engine._blocksBySession.has(scheduleOnlyId),
    JSON.stringify(engine.guardCounts)
  );

  // Idempotence: a further event must not re-prune or re-materialize anything.
  const nodesAfterFirst = session.surface.nodes.length;
  session.append('turn/start', { turn: 3 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('a later event does not prune again', state.prunedToolCount === 1, String(state.prunedToolCount));
  check('a later event does not grow the surface with a second placeholder', session.surface.nodes.length === nodesAfterFirst, `${nodesAfterFirst} -> ${session.surface.nodes.length}`);
}

console.log('\n--- unchanged state skips serialization and disk comparison ---');
{
  const { engine } = await mountEngine({});
  const session = fakeSession([]);
  const state = engine.blocksFor(session);
  const before = { ...engine.guardCounts };
  engine.saveBlocks(session);
  engine.saveBlocks(session);
  state.manualPermit = true;
  state.markDirty();
  engine.saveBlocks(session);
  check('three save requests serialize only first and dirty generations', engine.guardCounts.saveCalls - before.saveCalls === 3 && engine.guardCounts.saveSerializations - before.saveSerializations === 2 && engine.guardCounts.saveSkippedClean - before.saveSkippedClean === 1, JSON.stringify(engine.guardCounts));
  check('dirty wire-visible state is durable before save returns', engine.guardCounts.saveWrites - before.saveWrites === 2, JSON.stringify(engine.guardCounts));

  state.stats.compressions = 1n;
  state.markDirty();
  let strictFailed = false;
  try {
    engine.saveBlocksStrict(session, state);
  } catch {
    strictFailed = true;
  }
  const retryStayedDirty = engine._persistedBlockVersions.get(String(session.id)) !== state.mutationVersion;
  state.stats.compressions = 0;
  engine.saveBlocksStrict(session, state);
  check('a failed strict save keeps the dirty generation retryable', strictFailed && retryStayedDirty && engine._persistedBlockVersions.get(String(session.id)) === state.mutationVersion, JSON.stringify(engine.guardCounts));
}

console.log('\n--- the harness compacting the session resets stale DCP addresses ---');
{
  // Upstream's `resetOnCompaction` (`state/utils.ts:331-345`) fires when a new
  // compaction appears. A block is addressed by SEQ — its own node, the span it
  // covers, the ids it shadows — and a compaction rewrites the surface, so none of
  // those numbers can be trusted afterwards: `blockAtSeq` would recognise an
  // unrelated node as a compressed block.
  const { Context } = await import('@deepseek-ai/cordis');
  const { SessionStore, SessionId } = await import('@deepseek-ai/dsh-session');
  const llm = await import('@deepseek-ai/dsh-llm');
  const context = new Context();
  const store = new SessionStore(context);
  const { engine } = await mountEngine({}, { context, sessions: store, store });
  // A NAMED session id, not the generated `session-1`. The engine keys its block
  // state by session id, and the case above already made a `session-1` in ITS
  // store — so a generated id silently inherited that session's prune manifest and
  // this fixture saw two entries where it had written one.
  const session = store.create(SessionId('strategy-compaction-reset'), { meta: { cwd: process.cwd() } });
  for (let attempt = 0; attempt < 50 && store.get(session.id) === undefined; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  session.append('turn/start', { turn: 1 });
  session.append('user/message', llm.createUserMessage({ content: [text('go')], source: { kind: 'user' } }), { surfaceOp: 'append' });

  const state = engine.blocksFor(session);
  state.restore({
    blockId: '1',
    topic: 'a compressed span',
    summary: 'SUMMARY-BODY',
    anchorMessageId: 'anchor-1',
    shadowedMessageIds: ['anchor-1'],
    shadowedSeqs: [1],
    start: 1,
    end: 2,
    nodeSeq: 2
  });
  // A manifest entry beside it is stale after native compaction, exactly as
  // upstream's resetOnCompaction specifies.
  state.pruneTools([{ callId: 'kept-call', tokens: 7 }]);
  check('the fixture really holds a block and a manifest entry', state.size === 1 && state.prunedToolCount === 1, `${state.size}/${state.prunedToolCount}`);

  session.append('compaction/end', { turn: 1, ok: true });
  await new Promise((resolve) => setTimeout(resolve, 0));

  check('a harness compaction forgets the compression blocks', state.size === 0, String(state.size));
  check('and the prune manifest is reset with the aliases', state.prunedToolCount === 0 && state.messageIds.nextRef === 1, JSON.stringify([...state.prunedToolIds.keys()]));

  // The port's OWN prune leaves a `compaction/prune`, never a `compaction/end`,
  // which is what keeps this listener from wiping the registry on every prune.
  state.restore({
    blockId: '2',
    topic: 'another span',
    summary: 'BODY-2',
    anchorMessageId: 'anchor-2',
    shadowedMessageIds: ['anchor-2'],
    shadowedSeqs: [1],
    start: 1,
    end: 2,
    nodeSeq: 2
  });
  session.append('compaction/prune', { shadowedRange: { start: 1, end: 1 }, shadowedSeqs: [1], shadowedTokenCount: 3 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('the port’s own prune does not forget anything', state.size === 1, String(state.size));
}

{
  // The pass is skipped, not fatal, when the embedding publishes no `sessions`
  // service: the request must still go through with whatever the manifest held.
  const { Context } = await import('@deepseek-ai/cordis');
  const root = new Context();
  root.provide('tools', { register: () => () => {} });
  root.provide('llm', await import('@deepseek-ai/dsh-llm'));
  root.provide('tokenMeter', { estimateMessage: () => 5, measure: () => ({ nodes: [] }) });
  root.plugin(dcp, {});
  await new Promise((resolve) => setTimeout(resolve, 250));
  const session = fakeSession([
    ['turn/start', { turn: 1 }],
    ['user/message', { content: [text('hello')] }]
  ]);
  const outgoing = session.surface.nodes
    .map((seq) => session.deriveEventMessage(session.eventAt(seq)))
    .filter((message) => message !== null);
  const through = requestThrough(root, session.id, outgoing);
  check('the request really went through the waterfall', through.fired === true, String(through.fired));
  check(
    'a missing `sessions` service does not break the request',
    Array.isArray(through.seen) && through.seen.length === outgoing.length,
    `${through.seen.length} of ${outgoing.length}`
  );
}

/* --------------------------------------------------------------- the result */

console.log('');
if (failures.length > 0) {
  console.log(`${failures.length} check(s) FAILED:`);
  for (const name of failures) console.log(`  - ${name}`);
  process.exitCode = 1;
} else {
  console.log('all DCP strategy behaviour tests passed');
}
rmSync(stateHome, { recursive: true, force: true });
