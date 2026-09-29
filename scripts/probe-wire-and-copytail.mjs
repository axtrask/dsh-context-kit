/**
 * INDEPENDENT VERIFICATION of the two bypasses two auditors reported.
 *
 * Both auditors contradicted an earlier conclusion of this port ("no plugin can
 * change what the provider receives except through session materialization"), so
 * neither claim is accepted on report. Each is re-derived here from scratch:
 *
 *   R2 - rewrite on the wire: an `llm/stream` listener that does NOT do
 *        `next(rewritten)` (cordis discards those arguments - proven in
 *        `scripts/probe-seam.mjs`) but re-enters the public `LlmRuntime.stream`
 *        with a rebuilt request. Claim: the adapter receives the rebuilt
 *        messages while the session log stays byte-identical.
 *   R3 - copy-tail recipe: append the edited message, re-append copies of the
 *        tail, then collapse the whole original range into an INVISIBLE
 *        `system/message` with empty content. Claim: the provider view is
 *        rewritten with roles, order and tool pairing intact, and the log is
 *        still reloadable.
 *
 * Run:  node scripts/probe-wire-and-copytail.mjs
 *
 * @module dsh-context-kit/scripts/probe-wire-and-copytail
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const checkout = process.env.DSH_CHECKOUT ?? 'C:/Users/pro100noob/AppData/Local/npm-cache/_npx/1e7f6d9597241db0';
const dsh = join(checkout, 'node_modules/@deepseek-ai');

void dirname(fileURLToPath(import.meta.url));

const { Context } = await import('@deepseek-ai/cordis');
const llm = await import('@deepseek-ai/dsh-llm');
const { Session, SessionId, foldSurface } = await import('@deepseek-ai/dsh-session');
const { toolPairingBalancedAfter } = await import('@deepseek-ai/dsh-compaction');

const failures = [];
/** @param label - what is being asserted. @param ok - outcome. @param detail - evidence. */
function check(label, ok, detail = '') {
  console.log(`${ok ? '[ok]  ' : '[FAIL]'} ${label}${detail.length > 0 ? ` - ${detail}` : ''}`);
  if (!ok) failures.push(label);
}
const hr = (title) => console.log(`\n=== ${title}`);

/* ------------------------------------------------------------------ fixtures */

let counter = 0;
const nextId = () => `probe-wire-${process.pid}-${(counter += 1)}`;

/** The provider-side view: role plus rendered text, in order. */
const providerView = (messages) => messages.map((message) => [message.role, message.content.map((block) => (
  block.type === 'text' ? block.text : block.type === 'tool-call' ? `<call ${block.name}>` : `<${block.type}>`
)).join(' ')]);

/** A session: prompt, your question, my text+call answer, the tool result, my closing line. */
function richSession() {
  const session = Session.create(SessionId(nextId()));
  session.append('system/message', {
    message: { id: 'sys', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'SYS' }] }
  }, { surfaceOp: 'append' });
  const userSeq = session.append('user/message', {
    id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Q1' }]
  }, { surfaceOp: 'append' }).seq;
  const assistantSeq = session.append('assistant/message', {
    turn: 1,
    step: 1,
    stream: [],
    message: {
      id: 'a1',
      role: 'assistant',
      source: { kind: 'model', provider: 'stub', model: 'stub' },
      content: [{ type: 'text', text: 'A1-OLD' }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }]
    }
  }, { surfaceOp: 'append' }).seq;
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: {
      id: 'r1',
      role: 'user',
      source: { kind: 'tool', callId: 'c1' },
      content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'BODY' }], isError: false }]
    }
  }, { surfaceOp: 'append' });
  session.append('assistant/message', {
    turn: 1,
    step: 2,
    stream: [],
    message: {
      id: 'a2',
      role: 'assistant',
      source: { kind: 'model', provider: 'stub', model: 'stub' },
      content: [{ type: 'text', text: 'A2-FINAL' }]
    }
  }, { surfaceOp: 'append' });
  const tailSeq = session.append('user/message', {
    id: 'u2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Q2' }]
  }, { surfaceOp: 'append' }).seq;
  return { session, userSeq, assistantSeq, tailSeq };
}

/* =============================== R2: rewrite on the wire =============================== */

hr('R2 - rewrite on the wire, log untouched');

const root = new Context();
const runtime = new llm.LlmRuntime(root);

/**
 * EVERY request that reaches the adapter, in order.
 *
 * An auditor falsified the previous single-slot version: they added an earlier provider
 * call carrying the original text and `check('the adapter no longer receives the original
 * text')` still passed, because it only ever looked at the final capture. A leak check that
 * cannot see an earlier call is not a leak check.
 */
const adapterCalls = [];

class CaptureAdapter extends llm.LlmAdapter {
  /** @param provider - provider id. @param model - model id. @param signal - abort signal. */
  async prepareCall(provider, model, signal) {
    return { model: await this.resolveModel(provider, model, signal), stream: (options) => this.stream(options) };
  }

  /** @param options - the request the runtime hands the adapter. */
  async *stream(options) {
    captured = options;
    adapterCalls.push(JSON.stringify(options));
    yield { type: 'text', delta: 'x' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

let captured = null;
runtime.registerAdapter(['stub'], new CaptureAdapter());

const { session } = richSession();
const boundary = session.deriveMessages();
console.log('  boundary messages: ' + JSON.stringify(boundary.map((message) => ({
  role: message.role,
  contentIsArray: Array.isArray(message.content),
  content: message.content
}))));
const logBefore = JSON.stringify(session.snapshotEvents());

const seen = [];
const reentered = new WeakSet();
root.on('llm/stream', function onStream(options, next) {
  seen.push(options.messages.length);
  if (reentered.has(options)) return next();
  const messages = Object.freeze(options.messages.map((message) => (message.role === 'assistant' && message.content.some((b) => b.type === 'text' && b.text === 'A1-OLD')
    ? Object.freeze({
      ...message,
      content: Object.freeze(message.content.map((block) => (block.type === 'text' ? Object.freeze({ ...block, text: 'A1-EDITED' }) : block)))
    })
    : message)));
  const rewritten = Object.freeze({ ...options, messages });
  reentered.add(rewritten);
  return this.stream(rewritten);
});

const request = llm.markAgentLoopRequest(Object.freeze({
  provider: 'stub',
  model: 'stub',
  messages: boundary,
  sessionId: String(session.id),
  signal: undefined
}));
let streamed = 0;
try {
  for await (const _chunk of runtime.stream(request)) {
    streamed += 1;
    console.log(`  chunk ${streamed}: ${JSON.stringify(_chunk).slice(0, 300)}`);
  }
} catch (error) {
  console.log(`  stream threw: ${error.constructor.name}: ${error.message}`);
}
console.log(`  chunks=${streamed} captured=${captured === null ? 'null' : 'set'} providers=${JSON.stringify(runtime.listProviders().map((p) => p.id))}`);

check('the listener ran once for the loop request and once for its own rewrite', seen.length === 2, `listener calls=${seen.length}, message counts per call=${JSON.stringify(seen)}`);
check('the ADAPTER receives the edited text', providerView(captured.messages).some(([, text]) => text.includes('A1-EDITED')), JSON.stringify(providerView(captured.messages)));
// Scanned over the WHOLE serialized request of EVERY adapter call, not over a projection that
// renders only text blocks and call names: the original could otherwise hide in a tool-result
// body or in a tool-call's arguments and this probe would call it gone.
check(
  'no adapter call, in any position, carries the original text',
  adapterCalls.length > 0 && adapterCalls.every((call) => !call.includes('A1-OLD')),
  `adapter calls=${adapterCalls.length}, containing the original=${adapterCalls.filter((call) => call.includes('A1-OLD')).length}`
);
check(
  'the leak scan is not vacuous: the same scan DOES find the text the model still has',
  adapterCalls.some((call) => call.includes('A1-EDITED')),
  ''
);
check('the session log is unchanged after the swap (serialized in-memory events, not on-disk bytes)', JSON.stringify(session.snapshotEvents()) === logBefore);
check('session.deriveMessages() still shows the ORIGINAL text', providerView(session.deriveMessages()).some(([, text]) => text.includes('A1-OLD')));
check('the tool call survived the swap', providerView(captured.messages).some(([, text]) => text.includes('<call bash>')));

/* ============================ R3: copy-tail recipe ============================ */

hr('R3 - copy-tail recipe, durable in the log');

const { session: s2, assistantSeq } = richSession();
const before = providerView(s2.deriveMessages());
const nodes = [...s2.surface.nodes];
const range = nodes.slice(nodes.indexOf(assistantSeq));

// 1. the edited reply, appended
s2.append('assistant/message', {
  turn: 1,
  step: 1,
  stream: [],
  message: {
    id: 'a1-edit',
    role: 'assistant',
    source: { kind: 'model', provider: 'stub', model: 'stub' },
    content: [{ type: 'text', text: 'A1-EDITED' }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }]
  }
}, { surfaceOp: 'append' });

// 2. copies of everything that followed, in order
for (const seq of range.slice(1)) {
  const event = s2.eventAt(seq);
  s2.append(event.type, JSON.parse(JSON.stringify(event.data)), { surfaceOp: 'append' });
}

// 3. one invisible node swallows the whole original range
s2.append('system/message', {
  message: { id: 'void', role: 'system', source: { kind: 'system-prompt' }, content: [] }
}, { surfaceOp: { op: 'replace', startSeq: range[0], endSeq: range.at(-1) }, sourceEventSeqs: range });

const after = providerView(s2.deriveMessages());
console.log('  before:');
for (const [role, text] of before) console.log(`    ${role.padEnd(9)} ${text}`);
console.log('  after:');
for (const [role, text] of after) console.log(`    ${role.padEnd(9)} ${text}`);

check('the provider view is the same length', after.length === before.length, `${after.length} vs ${before.length}`);
check('roles are identical position by position', after.every(([role], index) => role === before[index][0]));
check('the edited text replaced the original', after.some(([, text]) => text.includes('A1-EDITED')) && !after.some(([, text]) => text.includes('A1-OLD')));
check('the tail survived', after.at(-1)[1].includes('Q2') && after.some(([, text]) => text.includes('A2-FINAL')));
// The invisible node is on the SURFACE — it holds the position of the range it swallowed, which
// is why it sits in the middle of the node list rather than at its end — and the fold drops it
// from the request. The old form of this check (`no rendered message is empty`) could not fail,
// because deriveMessages drops empty payloads whatever the recipe did; an auditor proved it by
// appending the node and watching the check still pass. So it is split into the two facts it
// was trying to express, and the node is FOUND rather than assumed to be last.
const voidSeq = s2.surface.nodes.find((seq) => s2.eventAt(seq)?.data?.message?.content?.length === 0);
const voidPosition = s2.surface.nodes.indexOf(voidSeq);
check(
  'the invisible node IS on the surface, holding the swallowed position',
  voidSeq !== undefined && s2.eventAt(voidSeq).type === 'system/message' && voidPosition < s2.surface.nodes.length - 1,
  `seq ${voidSeq} at position ${voidPosition} of ${s2.surface.nodes.length}`
);
check(
  'and it projects to no message, so the provider never sees it',
  s2.deriveMessages().length === after.length && !s2.deriveMessages().some((message) => (message.content ?? []).length === 0),
  `${s2.deriveMessages().length} messages, ${after.length} rendered`
);

const reloaded = Session.create(SessionId(nextId()), JSON.parse(JSON.stringify(s2.snapshotEvents())));
check('the log reloads and replays to the same provider view', JSON.stringify(providerView(reloaded.deriveMessages())) === JSON.stringify(after));
check('the folded surface matches the live surface', foldSurface(s2.snapshotEvents()).nodes.join(',') === s2.surface.nodes.join(','), `fold=[${foldSurface(s2.snapshotEvents()).nodes.join(',')}] live=[${s2.surface.nodes.join(',')}]`);
check('tool pairing stays balanced after the recipe', toolPairingBalancedAfter(s2, s2.surface.nodes.at(-1)) === true);

console.log(`\n${failures.length === 0 ? 'all checks passed' : `${failures.length} FAILURES: ${failures.join('; ')}`}`);
process.exitCode = failures.length === 0 ? 0 : 1;
