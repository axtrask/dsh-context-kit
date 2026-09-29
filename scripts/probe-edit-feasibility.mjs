/**
 * CAN A PAST TURN BE EDITED, AND IF NOT, WHERE IS THE WALL?
 *
 * The user asked for exactly this: change their own words and the assistant's
 * words in earlier turns, and get the model to behave as if the change was
 * always there. This probe answers it against REAL `@deepseek-ai/dsh-session`,
 * not against reasoning about the docs, because reasoning about the docs is what
 * produced the `llm/stream` no-op this port already had to unlearn.
 *
 * Four questions, each answered by an actual `append` and then by reading
 * `session.deriveMessages()` - the array the harness really sends:
 *
 *   1. edit YOUR OWN text alone,
 *   2. edit the ASSISTANT's text alone,
 *   3. regenerate: shadow the assistant reply and its tail with a fresh one,
 *   4. rewrite a whole turn from your message onward with one edited message.
 *
 * Recorded so the answer outlives the conversation: the numbers below are the
 * wall, and every branch says WHY it holds or breaks.
 *
 * Run:  node scripts/probe-edit-feasibility.mjs
 *
 * @module dsh-context-kit/scripts/probe-edit-feasibility
 */

import { Session, SessionId, foldSurface } from '@deepseek-ai/dsh-session';
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm';

let counter = 0;
const nextId = () => `probe-edit-${process.pid}-${(counter += 1)}`;

/** A session holding one real turn: user says A, assistant answers B via a tool call. */
function turnSession() {
  const session = Session.create(SessionId(nextId()));
  session.append('turn/start', { turn: 1 });
  const userSeq = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'ORIGINAL-A' }],
    source: { kind: 'user' }
  }), { surfaceOp: 'append' }).seq;
  const assistantSeq = session.append('assistant/message', {
    turn: 1,
    step: 1,
    stream: [],
    message: createAssistantMessage({
      content: [
        { type: 'text', text: 'ORIGINAL-B' },
        { type: 'tool-call', id: ToolCallId('c1'), name: 'bash', arguments: '{"command":"ls"}' }
      ],
      source: { kind: 'model', provider: 'probe', model: 'probe' }
    })
  }, { surfaceOp: 'append' }).seq;
  const resultSeq = session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId: ToolCallId('c1'),
      content: [{ type: 'text', text: 'TOOL-BODY' }],
      isError: false
    })
  }, { surfaceOp: 'append' }).seq;
  return { session, userSeq, assistantSeq, resultSeq };
}

/**
 * Findings that did not hold.
 *
 * This file used to print `OK`/`BAD` and always exit 0, which made it unfalsifiable: a
 * flipped expectation still produced a green run, and the suite counts a file green unless
 * it exits non-zero. Two independent auditors falsified it by blinding the comparison, so
 * it now owns its exit code. `docs/edit-feature.md` cites this probe as the evidence for
 * the refusal cases, and evidence that cannot fail is not evidence.
 */
const failures = [];
/** @param name - what was expected. @param ok - whether it held. @param detail - evidence. */
function settle(name, ok, detail = '') {
  console.log(`  ${ok ? 'OK  ' : 'BAD '} ${name}${detail.length > 0 ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

/** Print the surface as seqs plus the exact role/text order the provider would receive. */
function report(label, session, expect) {
  const surface = session.surface.nodes.join(',');
  const messages = session.deriveMessages();
  const text = messages.map((message) => JSON.stringify(message)).join('\n');
  const present = (needle) => text.includes(needle);
  console.log(`\n=== ${label}`);
  console.log(`  surface: [${surface}]`);
  console.log(`  provider receives, in order:`);
  for (const message of messages) {
    const body = Array.isArray(message.content)
      ? message.content.map((block) => {
        if (block.type === 'text') return block.text;
        if (block.type === 'tool-call') return `<call ${block.name}>`;
        if (block.type === 'tool-result') return `<result ${JSON.stringify(block.content)}>`;
        return `<${block.type}>`;
      }).join(' ')
      : '<no content>';
    console.log(`    ${message.role.padEnd(9)} ${body}`);
  }
  for (const [needle, want] of Object.entries(expect)) {
    const got = present(needle);
    settle(`${label}: ${needle}`, got === want, `present=${got} wanted=${want}`);
  }
}

/**
 * Run one edit attempt and report whether the session accepted it.
 *
 * @param label - the case name.
 * @param build - the attempt; must return `{ session, expect }`.
 * @param options - `refused: true` when the core is EXPECTED to reject the attempt.
 */
function attempt(label, build, options = {}) {
  const wantRefusal = options.refused === true;
  try {
    const { session, ...rest } = build();
    console.log(`\n=== ${label}`);
    if (wantRefusal) {
      settle(`${label}: the core refuses this`, false, 'it was ACCEPTED, so the documented refusal no longer holds');
      return;
    }
    report(label, session, rest.expect);
  } catch (error) {
    console.log(`\n=== ${label}`);
    console.log(`  REFUSED: ${error.message}`);
    settle(
      `${label}: the core refuses this`,
      wantRefusal,
      wantRefusal ? error.message : 'unexpected refusal — this case is supposed to work'
    );
  }
}
console.log('Question: can a past turn be rewritten through the session API?');

/* ---------- 1. your own words, alone ---------- */
attempt('1. replace YOUR text with different text', () => {
  const { session, userSeq } = turnSession();
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'NEW-A' }],
    source: { kind: 'user' }
  }), { surfaceOp: { op: 'replace', startSeq: userSeq, endSeq: userSeq }, sourceEventSeqs: [userSeq] });
  return { session, expect: { 'NEW-A': true, 'ORIGINAL-A': false, 'ORIGINAL-B': true, 'TOOL-BODY': true } };
});

/* ---------- 1b. the same edit, then a new turn: does the tail survive? ---------- */
attempt('1b. edit your text, then continue the conversation', () => {
  const { session, userSeq } = turnSession();
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'NEW-A' }],
    source: { kind: 'user' }
  }), { surfaceOp: { op: 'replace', startSeq: userSeq, endSeq: userSeq }, sourceEventSeqs: [userSeq] });
  session.append('turn/start', { turn: 2 });
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'NEXT-A' }],
    source: { kind: 'user' }
  }), { surfaceOp: 'append' });
  return { session, expect: { 'NEW-A': true, 'ORIGINAL-A': false, 'ORIGINAL-B': true, 'TOOL-BODY': true, 'NEXT-A': true } };
});

/* ---------- 1c. does the edit survive a replay of the log? ---------- */
{
  const { session, userSeq } = turnSession();
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'NEW-A' }],
    source: { kind: 'user' }
  }), { surfaceOp: { op: 'replace', startSeq: userSeq, endSeq: userSeq }, sourceEventSeqs: [userSeq] });
  const replayed = foldSurface(session.snapshotEvents());
  const text = session.snapshotEvents()
    .filter((event) => replayed.nodes.includes(event.seq))
    .map((event) => (event.type === 'user/message' ? event.data.content[0].text : event.type))
    .join(' | ');
  console.log('\n=== 1c. replay of the log (what a restart would rebuild)');
  console.log(`  surface after fold: [${replayed.nodes.join(',')}]`);
  console.log(`  visible nodes: ${text}`);
  const ok = !text.includes('ORIGINAL-A') && text.includes('NEW-A');
  settle('1c. the edit is part of the log, so a restart rebuilds it', ok, text);
}

/* ---------- 2. the assistant's words, alone ---------- */
attempt("2. replace the ASSISTANT's text with different text", () => {
  const { session, assistantSeq } = turnSession();
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    stream: [],
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'NEW-B' }],
      source: { kind: 'model', provider: 'probe', model: 'probe' }
    })
  }, { surfaceOp: { op: 'replace', startSeq: assistantSeq, endSeq: assistantSeq }, sourceEventSeqs: [assistantSeq] });
  return { session, expect: { 'NEW-B': true, 'ORIGINAL-B': false } };
}, { refused: true });

/* ---------- 3. regenerate: shadow the reply, its result, and the tail ---------- */
attempt('3. regenerate: one assistant message shadows [assistant, tool/result]', () => {
  const { session, assistantSeq, resultSeq } = turnSession();
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    stream: [],
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'NEW-B' }],
      source: { kind: 'model', provider: 'probe', model: 'probe' }
    })
  }, {
    surfaceOp: { op: 'replace', startSeq: assistantSeq, endSeq: resultSeq },
    sourceEventSeqs: [assistantSeq, resultSeq]
  });
  return { session, expect: { 'NEW-B': true, 'ORIGINAL-B': false, 'TOOL-BODY': false, 'ORIGINAL-A': true } };
}, { refused: true });

/* ---------- 5. can a shadowed range be REPLACED but end up later? ---------- */
attempt('5. anchor: replace [your msg .. mine .. result .. next-your-msg] with one edited message', () => {
  const { session, userSeq } = turnSession();
  session.append('turn/start', { turn: 2 });
  const nextSeq = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'NEXT-A' }],
    source: { kind: 'user' }
  }), { surfaceOp: 'append' }).seq;
  const endSeq = session.surface.nodes.at(-1);
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'NEW-A' }],
    source: { kind: 'user' }
  }), {
    surfaceOp: { op: 'replace', startSeq: userSeq, endSeq },
    sourceEventSeqs: session.surface.nodes.slice()
  });
  void nextSeq;
  return { session, expect: { 'NEW-A': true, 'ORIGINAL-A': false, 'ORIGINAL-B': false, 'TOOL-BODY': false, 'NEXT-A': false } };
});

/* ---------- 6. edit YOUR LAST message, then send a new one ---------- */
attempt('6. edit your last message (the tail), then continue', () => {
  const session = Session.create(SessionId(nextId()));
  session.append('turn/start', { turn: 1 });
  const seq = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'ORIGINAL-A' }],
    source: { kind: 'user' }
  }), { surfaceOp: 'append' }).seq;
  session.append('turn/start', { turn: 2 });
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'NEW-A' }],
    source: { kind: 'user' }
  }), { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] });
  session.append('turn/start', { turn: 3 });
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'AFTER' }],
    source: { kind: 'user' }
  }), { surfaceOp: 'append' });
  return { session, expect: { 'ORIGINAL-A': false, 'NEW-A': true, 'AFTER': true } };
});

/* ---------- 4. rewrite the whole turn from your message onward ---------- */
attempt('4. rewrite the turn: an edited user message shadows [user, assistant, result]', () => {
  const { session, userSeq, resultSeq } = turnSession();
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'NEW-A' }],
    source: { kind: 'user' }
  }), {
    surfaceOp: { op: 'replace', startSeq: userSeq, endSeq: resultSeq },
    sourceEventSeqs: session.surface.nodes.slice()
  });
  return { session, expect: { 'NEW-A': true, 'ORIGINAL-A': false, 'ORIGINAL-B': false, 'TOOL-BODY': false } };
});

/* ------------------------------------------------------------------ verdict */

console.log('');
if (failures.length === 0) {
  console.log('all feasibility cases held: the user\'s own messages are editable, an assistant carrier is refused');
} else {
  console.log(`${failures.length} FAILURES: ${failures.join('; ')}`);
  process.exitCode = 1;
}
