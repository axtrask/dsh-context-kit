/**
 * The history editor's shared half: anchors, validation, the wire rewrite.
 *
 * Everything here is runnable without a live server. The point of the suite is the
 * set of cases that must be REFUSED, not the happy path: an editor that silently
 * applies an edit to the wrong message, or that strips a tool call and orphans its
 * result, is worse than no editor at all.
 *
 * Run:  node scripts/test-edit.mjs
 *
 * @module dsh-context-kit/scripts/test-edit
 */

import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const kitRoot = join(here, '..');
const scratchHome = join(kitRoot, '.suite-state', 'edit-test');
if (!statSync(dirname(scratchHome)).isDirectory()) throw new Error('missing suite parent');
rmSync(scratchHome, { recursive: true, force: true });
process.env.DSH_HOME = scratchHome;
process.env.XDG_CONFIG_HOME = join(scratchHome, 'xdg');
process.env.OPENCODE_CONFIG_DIR = join(scratchHome, 'opencode');

const edit = await import(`${new URL('../lib/edit.js', import.meta.url).href}`);

const failures = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? '[ok]  ' : '[FAIL]'} ${name}${detail.length > 0 ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const text = (value) => ({ type: 'text', text: value });
const call = (id, name, args) => ({ type: 'tool-call', id, name, arguments: args });
const result = (callId, body) => ({ type: 'tool-result', toolCallId: callId, content: [text(body)], isError: false });
const userMessage = (id, ...blocks) => ({ id, role: 'user', content: blocks });
const assistantMessage = (id, ...blocks) => ({ id, role: 'assistant', content: blocks });
const resultMessage = (id, callId, body) => ({ id, role: 'user', content: [result(callId, body)] });

/** A frozen request, the way `dsh-agent-loop` hands it to the waterfall. */
function freezeRequest(messages, sessionId = 'edit-test') {
  for (const message of messages) {
    Object.freeze(message.content);
    Object.freeze(message);
  }
  return Object.freeze({ messages: Object.freeze(messages), sessionId, provider: 'p', model: 'm' });
}

/**
 * Indices of every message that could be the one an edit targets, computed WITHOUT
 * the module under test. The ambiguity check asserts against this, so a broken
 * `findAnchoredIndex` cannot make its own ambiguity test pass.
 */
function ambiguityProbe(messages, record) {
  const textsOf = (message) => (typeof message?.content === 'string'
    ? [message.content]
    : (Array.isArray(message?.content) ? message.content : [])
      .map((block) => (block?.type === 'text' ? block.text : block?.type === 'tool-call' ? block.arguments : undefined))
      .filter((value) => value !== undefined));
  const hits = [];
  for (const [index, message] of messages.entries()) {
    if (message?.role !== record.anchor.role) continue;
    if (textsOf(message).includes(record.before)) hits.push(index);
  }
  return hits;
}

const store = edit.createEditStore({ restore: false });

/* ---------------------------------------------------- 1. what may be edited */

check(
  'a text block exposes its text',
  edit.editableTextOf(text('hello')) === 'hello',
  edit.editableTextOf(text('hello'))
);
check(
  'a tool-call exposes its arguments string',
  edit.editableTextOf(call('c1', 'read', '{"a":1}')) === '{"a":1}',
  edit.editableTextOf(call('c1', 'read', '{"a":1}'))
);
check(
  'a tool-result exposes its nested text',
  edit.editableTextOf(result('c1', 'BODY')) === 'BODY',
  edit.editableTextOf(result('c1', 'BODY'))
);
check('an image block exposes nothing', edit.editableTextOf({ type: 'image', data: 'x' }) === undefined);
check('a null block exposes nothing', edit.editableTextOf(null) === undefined);

/* --------------------------------------------------------- 2. recording */

const own = userMessage('m1', text('Question one'));
const made = store.record('sess-own', own, 'Question one, corrected', { messageIndex: 1, expected: 'Question one' });
check('a user message can be edited', made.ok === true, JSON.stringify(made.reason ?? made.edit.id));
check('the record keeps the old text', made.edit?.before === 'Question one', String(made.edit?.before));
check('the record keeps the new text', made.edit?.after === 'Question one, corrected', String(made.edit?.after));
check('the record anchors on the message index', made.edit?.anchor.index === 1, String(made.edit?.anchor.index));
check('the record anchors on the cursor block', made.edit?.cursor.block === 0, String(made.edit?.cursor.block));

const empty = store.record('sess-own', own, '', { messageIndex: 1 });
check('an empty replacement is refused', empty.ok === false && /empty/.test(empty.reason), String(empty.reason));
const same = store.record('sess-own', own, 'Question one', { messageIndex: 1 });
check('an unchanged text is refused', same.ok === false && /unchanged/.test(same.reason), String(same.reason));
const wrong = store.record('sess-own', own, 'nope', { messageIndex: 1, expected: 'a different text' });
check(
  'aiming at text the message does not contain is refused',
  wrong.ok === false && /aimed at/.test(wrong.reason),
  String(wrong.reason)
);

const callOnly = assistantMessage('m2', call('c1', 'bash', '{"cmd":"ls"}'));
const callEdit = store.record('sess-call', callOnly, '{"cmd":"ls -la"}', { messageIndex: 2, expected: '{"cmd":"ls"}' });
check('the arguments of a tool call can be edited', callEdit.ok === true, JSON.stringify(callEdit.reason ?? ''));
check('the edited block is the call', callEdit.edit?.cursor.block === 0, String(callEdit.edit?.cursor.block));

const noText = assistantMessage('m3', { type: 'image', data: 'x' });
const refusedNoText = store.record('sess-img', noText, 'text', { messageIndex: 3 });
check(
  'a message with no editable text is refused',
  refusedNoText.ok === false && /no editable text/.test(refusedNoText.reason),
  String(refusedNoText.reason)
);

/* -------------------------------------------- 3. the rewrite, happy path */

const request = freezeRequest([
  { id: 's0', role: 'system', content: 'SYSTEM' },
  userMessage('m1', text('Question one')),
  assistantMessage('m2', text('Answer one'), call('c1', 'bash', '{"cmd":"ls"}')),
  resultMessage('m3', 'c1', 'BODY'),
  userMessage('m4', text('Question two'))
]);

const ownEdit = store.record('wire-a', request.messages[1], 'Question one FIXED', { messageIndex: 1, messageId: 'm1' });
const assistantEdit = store.record('wire-a', request.messages[2], 'Answer one REWRITTEN', { messageIndex: 2, messageId: 'm2' });
const plan = edit.planWireRewrite(request.messages, store.editsFor('wire-a'));

check('the rewrite succeeds', plan.ok === true, JSON.stringify(plan.refused));
check('two edits were applied', plan.applied.length === 2, String(plan.applied.length));
check('the provider view keeps its length', plan.messages.length === 5, String(plan.messages.length));
check(
  'the user text is the edited one',
  plan.messages[1].content[0].text === 'Question one FIXED',
  plan.messages[1].content[0].text
);
check(
  'the assistant text is the edited one',
  plan.messages[2].content[0].text === 'Answer one REWRITTEN',
  plan.messages[2].content[0].text
);
check(
  'the original user text is gone from every position',
  !JSON.stringify(plan.messages).includes('Question one"') && !plan.messages.some((m) => JSON.stringify(m).includes('Question one,')),
  ''
);
check(
  'the original assistant text is gone',
  !JSON.stringify(plan.messages).includes('"Answer one"'),
  ''
);
check('the tail after both edits is intact', plan.messages[4].content[0].text === 'Question two', '');
check('the tool result is untouched', plan.messages[3].content[0].content[0].text === 'BODY', '');
check(
  'the tool call survived with its id and name',
  plan.messages[2].content[1].id === 'c1' && plan.messages[2].content[1].name === 'bash',
  JSON.stringify(plan.messages[2].content[1]).slice(0, 60)
);
check('the request messages were not mutated', request.messages[2].content[0].text === 'Answer one', request.messages[2].content[0].text);
check(
  'the untouched messages are the same objects',
  plan.messages[0] === request.messages[0] && plan.messages[4] === request.messages[4],
  ''
);
check('both edits report their position', plan.applied.every((entry) => entry.index >= 1), JSON.stringify(plan.applied.map((e) => e.index)));

/* ------------------------------------------- 4. what the rewrite refuses */

// The message the edit replaced is gone: an earlier compress swallowed it.
const vanished = edit.planWireRewrite(request.messages.filter((message) => message.id !== 'm2'), store.editsFor('wire-a'));
check('an edit whose message vanished is refused', vanished.ok === false, JSON.stringify(vanished.refused.map((r) => r.id)));
check('the refusal names the reason', /no longer part of the request/.test(vanished.refused[0]?.reason ?? ''), String(vanished.refused[0]?.reason));
check('the rest of the request still goes out', vanished.messages.length === 4, String(vanished.messages.length));
check(
  'the surviving edit was still applied',
  vanished.messages.some((message) => JSON.stringify(message).includes('Question one FIXED')),
  ''
);

// The text was rewritten by something else underneath the edit.
const hijacked = request.messages.map((message) =>
  message.id === 'm1' ? userMessage('m1', text('Someone else replaced this')) : message
);
const conflict = edit.planWireRewrite(hijacked, store.editsFor('wire-a'));
check('an edit over changed text is refused', conflict.ok === false, JSON.stringify(conflict.refused.map((r) => r.id)));
check(
  'the refusal explains which message changed',
  /kept 1\/1 block/.test(conflict.refused[0]?.reason ?? ''),
  String(conflict.refused[0]?.reason)
);

// The same text now appears twice: guessing would corrupt the wrong turn.
//
// The edit was recorded against the only copy that existed at the time, at index 0.
// The request that arrives later has that text in TWO places and something else at
// index 0, so positional trust is impossible and the search must refuse.
const ambiguousAnchorMessage = userMessage('x-anchor', text('Question one'));
const ambiguityStore = edit.createEditStore({ restore: false });
const ambiguousEdit = ambiguityStore.record('wire-b', ambiguousAnchorMessage, 'FIXED', { messageIndex: 0 });
check('the ambiguity fixture recorded its edit', ambiguousEdit.ok === true, JSON.stringify(ambiguousEdit.reason ?? ''));
const ambiguousRequest = freezeRequest([
  userMessage('x0', text('a different question')),
  userMessage('x1', text('Question one')),
  userMessage('x2', text('Question one'))
], 'wire-b');
const guess = edit.planWireRewrite(ambiguousRequest.messages, ambiguityStore.editsFor('wire-b'));
check('an ambiguous anchor is refused', guess.ok === false, JSON.stringify(guess.refused.map((r) => r.id)));
check(
  'the refusal refuses to guess',
  /refusing to guess/.test(guess.refused[0]?.reason ?? ''),
  String(guess.refused[0]?.reason)
);
check('nothing is rewritten when the anchor is ambiguous', guess.changed === false, String(guess.changed));
check(
  'the ambiguity is real: two messages claim the edit',
  JSON.stringify(ambiguityProbe(ambiguousRequest.messages, ambiguousEdit.edit)) === '[1,2]',
  JSON.stringify(ambiguityProbe(ambiguousRequest.messages, ambiguousEdit.edit))
);

// A tool call was removed from the message the edit targets, while the text survives.
// The block count is what refuses this one — the edit cannot silently drop a call.
const stripped = request.messages.map((message) =>
  message.id === 'm2'
    ? assistantMessage('m2', text('Answer one REWRITTEN'), call('c1', 'bash', '{"cmd":"ls"}'), text('trailing'))
    : message
);
const brokenPair = edit.planWireRewrite(stripped, [store.editsFor('wire-a')[1]]);
check('a changed block shape is refused', brokenPair.ok === false, JSON.stringify(brokenPair.refused.map((r) => r.id)));
check(
  'the refusal reports how much of the message survived',
  /kept 2\/2 block\(s\)/.test(brokenPair.refused[0]?.reason ?? ''),
  String(brokenPair.refused[0]?.reason)
);
// The block-count guard itself, called directly: this is the refusal that keeps an edit
// from dropping a tool call and orphaning its result. A change that removes this check
// must fail here rather than pass everywhere else.
const callBearing = assistantMessage('c1', text('Answer one'), call('c1', 'bash', '{}'));
const grownEdit = store.record('guard', callBearing, 'edited', { messageIndex: 0, expected: 'Answer one' });
const grown = edit.validateEdit(
  assistantMessage('c1', text('Answer one'), call('c1', 'bash', '{}'), text('extra')),
  grownEdit.edit
);
check('the block-count guard fires on a grown message', grown.ok === false, JSON.stringify(grown));
check(
  'the block-count guard names both counts',
  /block count changed: expected 2, found 3/.test(grown.reason ?? ''),
  String(grown.reason)
);
const shrunk = edit.validateEdit(assistantMessage('c1', text('Answer one')), grownEdit.edit);
check(
  'the block-count guard fires on a message that lost its call',
  shrunk.ok === false && /expected 2, found 1/.test(shrunk.reason ?? ''),
  String(shrunk.reason)
);
const kept = edit.validateEdit(callBearing, grownEdit.edit);
check('the same message passes the guard untouched', kept.ok === true && kept.blockIndex === 0, JSON.stringify(kept));

// The block at the cursor is no longer the same block.
const reordered = request.messages.map((message) =>
  message.id === 'm2' ? assistantMessage('m2', call('c1', 'bash', '{"cmd":"ls"}'), text('Answer one')) : message
);
const moved = edit.planWireRewrite(reordered, [store.editsFor('wire-a')[1]]);
check('an edit whose block moved is refused', moved.ok === false, JSON.stringify(moved.refused.map((r) => r.id)));
check(
  'the refusal reports the block identity',
  /block 0 is no longer/.test(moved.refused[0]?.reason ?? ''),
  String(moved.refused[0]?.reason)
);

// A message id that disagrees with the anchor.
const renamed = request.messages.map((message) => (message.id === 'm1' ? { ...message, id: 'm1-new' } : message));
const idMismatch = edit.planWireRewrite(renamed, [store.editsFor('wire-a')[0]]);
check('a changed message id is refused', idMismatch.ok === false, JSON.stringify(idMismatch.refused.map((r) => r.id)));
check(
  'the refusal quotes both ids',
  /message id changed: expected m1, found m1-new/.test(idMismatch.refused[0]?.reason ?? ''),
  String(idMismatch.refused[0]?.reason)
);

/* ------------------------------------------- 5. anchors survive a shift */

// A compress landed ABOVE the edit, so the target moved by one position: the recorded
// index 1 now holds the inserted message. Finding the edit again is the anchor search's
// job, and it must report that it recovered rather than found.
const shifted = freezeRequest([
  { id: 's0', role: 'system', content: 'SYSTEM' },
  userMessage('inserted', text('a new turn compressed above the edit')),
  userMessage('m1-copy', text('Question one')),
  assistantMessage('m2-copy', text('Answer one'), call('c1', 'bash', '{"cmd":"ls"}')),
  resultMessage('m3-copy', 'c1', 'BODY'),
  userMessage('m4-copy', text('Question two'))
]);
const replayed = edit.planWireRewrite(
  shifted.messages,
  store.editsFor('wire-a').map((record) => ({ ...record, messageId: undefined }))
);
check('an edit still lands after the request is rebuilt', replayed.ok === true, JSON.stringify(replayed.refused));
check('the rebuilt request found both edits', replayed.applied.length === 2, String(replayed.applied.length));
check(
  'the shift was reported as recovery',
  replayed.applied.every((entry) => entry.recovered === true),
  JSON.stringify(replayed.applied.map((e) => e.recovered))
);
check(
  'the recovered edit wrote the edited text in the new position',
  replayed.messages[3].content[0].text === 'Answer one REWRITTEN',
  replayed.messages[3].content[0].text
);

/* ------------------------------------------------------- 6. persistence */

const file = edit.editStatePath('wire-a');
check('the state file exists after a record', existsSync(file), file);
const document = JSON.parse(readFileSync(file, 'utf8'));
check('the file is versioned', document.version === edit.EDIT_STATE_VERSION, String(document.version));
check('the file holds both edits', document.edits.length === 2, String(document.edits.length));

const reloaded = edit.createEditStore();
const afterRestart = reloaded.editsFor('wire-a');
check('a fresh store restores the edits', afterRestart.length === 2, String(afterRestart.length));
const replayAfterRestart = edit.planWireRewrite(request.messages, afterRestart);
check('a restored edit still rewrites the request', replayAfterRestart.ok === true, JSON.stringify(replayAfterRestart.refused));
check(
  'the restored text is the edited one',
  replayAfterRestart.messages[2].content[0].text === 'Answer one REWRITTEN',
  replayAfterRestart.messages[2].content[0].text
);

// A corrupted record is dropped, not trusted.
const corrupted = JSON.parse(readFileSync(file, 'utf8'));
corrupted.edits.push({ id: 'broken', before: 'x' });
const { writeFileSync } = await import('node:fs');
writeFileSync(file, JSON.stringify(corrupted), 'utf8');
let reported = [];
const guarded = edit.createEditStore({ onProblem: (_session, problem) => reported.push(problem) });
check('a malformed record is dropped', guarded.editsFor('wire-a').length === 2, String(guarded.editsFor('wire-a').length));
check('the drop is reported', reported.length === 1 && /edit 2: no after text/.test(reported[0]), JSON.stringify(reported));
writeFileSync(file, JSON.stringify(document), 'utf8');

// Malformed anchors must be dropped individually, not crash a whole projection.
const validRecord = document.edits[1];
const malformedRecords = [
  { anchor: { ...validRecord.anchor, blocks: [null] } },
  ...[[], 'text', 7, {}, { type: 7 }, { type: '' }, { type: 'text', id: {} },
    { type: 'text', toolCallId: [] }, { type: 'reasoning', signed: 'yes' }]
    .map((block) => ({ anchor: { ...validRecord.anchor, blocks: [block, validRecord.anchor.blocks[1]] } })),
  { cursor: { ...validRecord.cursor, block: -2 } },
  { cursor: { ...validRecord.cursor, block: validRecord.anchor.blocks.length } },
  { anchor: { ...validRecord.anchor, blocks: [] } },
  { anchor: { ...validRecord.anchor, index: -1 } },
  { messageId: { toString: null } }
].map((fields, i) => ({ ...validRecord, ...fields, id: `malformed-anchor-${i}` }));
writeFileSync(file, JSON.stringify({ ...document, edits: [...document.edits, ...malformedRecords] }), 'utf8');
const corruptFileBefore = readFileSync(file, 'utf8');
const anchorProblems = [];
const anchorStore = edit.createEditStore({ onProblem: (_session, problem) => anchorProblems.push(problem) });
const safeRecords = anchorStore.editsFor('wire-a');
check('malformed anchor fields are dropped while valid v1 records survive', safeRecords.length === document.edits.length);
check('each dropped anchor is diagnosed', anchorProblems.length === malformedRecords.length, JSON.stringify(anchorProblems));
let safePlan;
let projectionError;
try { safePlan = edit.planWireRewrite(request.messages, safeRecords); } catch (error) { projectionError = error; }
check('restored malformed anchors cannot throw in the planner', projectionError === undefined, String(projectionError ?? ''));
check('valid edits still apply beside malformed persisted anchors', safePlan?.ok === true && safePlan?.applied.length === 2
  && safePlan.messages[2].content[0].text === 'Answer one REWRITTEN');
check('loading preserves valid audit records and never rewrites the state file', JSON.stringify(safeRecords) === JSON.stringify(document.edits)
  && readFileSync(file, 'utf8') === corruptFileBefore);
writeFileSync(file, JSON.stringify(document), 'utf8');

/* ---------------------------------------------------------- 7. the store */

const store2 = edit.createEditStore({ restore: false });
store2.record('undo-test', userMessage('u1', text('one')), 'two', { messageIndex: 0 });
const only = store2.editsFor('undo-test')[0];
const removed = store2.remove('undo-test', only.id);
check('an edit can be removed', removed.ok === true && removed.remaining === 0, JSON.stringify(removed));
check('removing an unknown edit is refused', store2.remove('undo-test', 'nope').ok === false, '');
store2.record('undo-test', userMessage('u1', text('one')), 'two', { messageIndex: 0 });
const cleared = store2.clear('undo-test');
check('a session can be cleared', cleared.ok === true && cleared.removed === 1, JSON.stringify(cleared));
check('the store tracks sessions separately', store2.editsFor('other-session').length === 0, '');
check('the store counts its sessions', store2.sessionCount() === 2, String(store2.sessionCount()));

/* --------------------------------------------- 8. an edit on top of an edit */

// Editing an already-edited message. The first record's `before` text is gone from the
// request by construction, so positional trust is what applies it — and the newest text
// must win, in the order the user typed them. The superseded record is then refused as
// stale BELOW the newer one, which is correct (its text is no longer the message's text)
// and is asserted so the behaviour is pinned rather than assumed.
const layered = edit.createEditStore({ restore: false });
const original = userMessage('m1', text('first'));
layered.record('layers', original, 'second', { messageIndex: 0 });
const second = userMessage('m1', text('second'));
layered.record('layers', second, 'third', { messageIndex: 0 });
const layeredPlan = edit.planWireRewrite([second], layered.editsFor('layers'));
check('the newest edit of a message is applied', layeredPlan.applied.length === 1, JSON.stringify(layeredPlan.applied.map((a) => a.after)));
check('the newest text wins', layeredPlan.messages[0].content[0].text === 'third', layeredPlan.messages[0].content[0].text);
check(
  'the superseded edit is reported rather than applied quietly',
  layeredPlan.refused.length === 1 && /no longer contains the text/.test(layeredPlan.refused[0].reason),
  JSON.stringify(layeredPlan.refused.map((r) => r.reason))
);

/* ------------------------------------------------------------- 9. no edits */

const untouched = edit.planWireRewrite(request.messages, []);
check('no edits leaves the request alone', untouched.changed === false && untouched.messages === request.messages, '');
check('no edits reports nothing applied', untouched.applied.length === 0 && untouched.refused.length === 0, '');

/* ------------------------------------------------ 10. a plain text message */

// `deriveEventMessage` (`dsh-session/lib/index.js:209-219`) returns the payload of a
// `user/message` verbatim — only `system/message` and `assistant/message` with an EMPTY
// content array project to null. So the one thing that shifts indices in a request is an
// empty assistant node, which is exactly what a compress leaves behind and what
// `decompress` re-appends a tail around. Verified here against that real shape.
const plainMessages = [
  { id: 's0', role: 'system', content: 'SYSTEM' },
  { id: 'hole', role: 'assistant', content: [] },
  { id: 'p1', role: 'user', content: 'bare string' }
];
const plainStore = edit.createEditStore({ restore: false });
const plainEdit = plainStore.record('plain', plainMessages[2], 'bare string, edited', { messageIndex: 3 });
check('a bare-string message can be edited', plainEdit.ok === true, JSON.stringify(plainEdit.reason ?? ''));
check('a bare-string edit has no block cursor', plainEdit.edit?.cursor.block === -1, String(plainEdit.edit?.cursor.block));

// A model of the fold that decides which messages reach the provider, kept honest by the
// check below. `deriveEventMessage` only nulls an EMPTY assistant/system payload, so an
// empty user message would still be emitted; the filter here is deliberately blunter (it
// drops any empty content array), which is the conservative direction: it can only make the
// anchor search look for a message one position later, never earlier.
const foldOf = (messages) => messages
  .filter((message) => !(Array.isArray(message.content) && message.content.length === 0));
const visible = foldOf(plainMessages);
check('the empty assistant node really is gone from the provider view', visible.length === 2, String(visible.length));
check(
  'the fold drops an empty user message too, so an editor must not rely on it surviving',
  foldOf([{ id: 'u', role: 'user', content: [] }]).length === 0,
  'the conservative direction: anchors are searched, never assumed'
);
const plainPlan = edit.planWireRewrite(visible, plainStore.editsFor('plain'));
check(
  'the bare string is replaced',
  plainPlan.messages[1]?.content === 'bare string, edited',
  JSON.stringify(plainPlan.messages[1]?.content ?? null)
);
check(
  'a bare-string rewrite stays a string, not an object of characters',
  typeof plainPlan.messages[1]?.content === 'string',
  typeof plainPlan.messages[1]?.content
);
check('the dropped-message shift was reported', plainPlan.applied[0]?.recovered === true, JSON.stringify(plainPlan.applied.map((a) => a.recovered)));

// The same edit aimed at a message that is NOT there must be refused.
const absent = edit.planWireRewrite([{ id: 'other', role: 'user', content: 'something else' }], plainStore.editsFor('plain'));
check('an edit whose message is absent is refused', absent.ok === false, JSON.stringify(absent.refused.map((r) => r.reason)));
check('the request survives the refusal', absent.messages.length === 1, String(absent.messages.length));

/* ------------------------------------------- 11. the model's own thinking (CoT) */

// A reasoning block is the model's chain of thought. DeepSeek passes it back as plain
// text, so rewriting it is safe there; the Anthropic-family adapter signs it and checks
// nothing, so rewriting a signed one is refused. Both halves are asserted here, because
// the failure mode of getting this wrong is silent: the wrong branch of
// `applyEditToMessage` reports a successful edit and changes nothing the provider reads.

const reasoning = (value) => ({ type: 'reasoning', text: value });
const deepseekReply = assistantMessage('r1', reasoning('THE THINKING'), text('THE ANSWER'));
const signedReply = {
  ...assistantMessage('r2', reasoning('SIGNED THINKING')),
  source: {
    kind: 'model',
    provider: 'pi',
    model: 'claude',
    replayState: {
      response: { kind: 'pi-ai', version: 2, api: 'anthropic-messages', provider: 'pi', model: 'claude', stopReason: 'stop' },
      blocks: [{ type: 'reasoning', thinkingSignature: 'SIG-over-the-old-thinking' }]
    }
  }
};

check('a reasoning block exposes its text like a text block', edit.editableTextOf(reasoning('THOUGHTS')) === 'THOUGHTS', edit.editableTextOf(reasoning('THOUGHTS')));
check('reasoning is one of the editable kinds', edit.EDITABLE_BLOCK_KINDS.includes('reasoning'), JSON.stringify(edit.EDITABLE_BLOCK_KINDS));
// THE ORDER TRAP, asserted directly. Without its own branch the block falls through to the
// tool-result branch and comes back with a `content` array the provider never sent, while
// `text` stays as it was - an edit that reports success and changes nothing.
const thinkingRewritten = edit.applyEditToMessage(
  { role: 'assistant', content: [reasoning('OLD THINKING')] },
  { before: 'OLD THINKING', after: 'NEW THINKING' },
  0,
  0
);
check('a reasoning block is rewritten through its own text field', thinkingRewritten.content[0].text === 'NEW THINKING', JSON.stringify(thinkingRewritten.content[0]));
check(
  'and it does not grow a content array it never had',
  thinkingRewritten.content[0].content === undefined && Object.keys(thinkingRewritten.content[0]).join(',') === 'type,text',
  JSON.stringify(thinkingRewritten.content[0])
);

const thinkingStore = edit.createEditStore({ restore: false });
const thinkingEdit = thinkingStore.record('cot', deepseekReply, 'THE THINKING, CORRECTED', { messageIndex: 0, expected: 'THE THINKING' });
check('an unsigned reasoning block can be edited', thinkingEdit.ok === true, JSON.stringify(thinkingEdit.reason ?? ''));
check('the cursor points at the reasoning block', thinkingEdit.edit?.cursor.block === 0, String(thinkingEdit.edit?.cursor.block));
// The panel edits the message's TEXT when it has one; the thinking is only the cursor when
// the reply has nothing else to say. `cursorBlockIndex` is the one selection both ends use.
check(
  'the cursor rule and the panel aim at the same block',
  edit.cursorBlockIndex(deepseekReply, 'THE ANSWER') === 1 && edit.cursorBlockIndex(deepseekReply, 'THE THINKING') === 0,
  `${edit.cursorBlockIndex(deepseekReply, 'THE ANSWER')}, ${edit.cursorBlockIndex(deepseekReply, 'THE THINKING')}`
);
check(
  'the anchor counts the thinking as part of the message',
  edit.canonicalTexts(deepseekReply).length === 2 && edit.messageAnchor(deepseekReply, 0).blocks.length === 2,
  `${edit.canonicalTexts(deepseekReply).length} texts, ${edit.messageAnchor(deepseekReply, 0).blocks.length} blocks`
);

const signedStore = edit.createEditStore({ restore: false });
const signedRecord = signedStore.record('cot-signed', signedReply, 'SIGNED THINKING, CORRECTED', { messageIndex: 0, expected: 'SIGNED THINKING' });
check('recording an edit over SIGNED thinking is refused', signedRecord.ok === false, JSON.stringify(signedRecord.reason ?? signedRecord.edit?.id ?? ''));
check('the refusal names the signature', /signed|signature/u.test(String(signedRecord.reason)), String(signedRecord.reason));
// And the apply end refuses too, so a hand-written or restored record cannot get in.
const handMade = {
  id: 'hand-made',
  scope: 'text',
  cursor: { message: 0, block: 0 },
  before: 'SIGNED THINKING',
  after: 'SIGNED THINKING, CORRECTED',
  at: 1,
  anchor: edit.messageAnchor(signedReply, 0)
};
const handPlan = edit.planWireRewrite([signedReply], [handMade]);
check('the wire rewrite refuses an edit of signed thinking', handPlan.changed === false && handPlan.refused.length === 1, JSON.stringify(handPlan.refused.map((r) => r.reason)));
check('and the refusal is reported, not empty', /signature|signed/u.test(String(handPlan.refused[0]?.reason)), String(handPlan.refused[0]?.reason));
// The same hand-made record against unsigned thinking of the same shape must go through -
// otherwise the check above would pass for the wrong reason. Its anchor is built from THIS
// message: an anchor of the signed one describes a different shape and would be refused
// for the block count instead of for the signature.
const unsignedHandMade = {
  ...handMade,
  before: 'THE THINKING',
  after: 'THE THINKING, CORRECTED',
  anchor: edit.messageAnchor(deepseekReply, 0)
};
const unsignedPlan = edit.planWireRewrite([deepseekReply], [unsignedHandMade]);
check(
  'the same rewrite on UNSIGNED thinking is applied',
  unsignedPlan.changed === true && unsignedPlan.messages[0].content[0].text === 'THE THINKING, CORRECTED',
  JSON.stringify(unsignedPlan.messages[0].content[0])
);
check('and the rest of that reply is untouched', unsignedPlan.messages[0].content[1].text === 'THE ANSWER', '');

/* ------------------------------------ 12. aiming at a BLOCK, not at a string */

// A message may carry the SAME string twice, and then the text alone cannot say which one
// an edit means: `[reasoning('SAME WORDS'), text('SAME WORDS')]` is a reply whose thinking
// and answer read alike. `createEdit` picks the FIRST block holding the text, so a caller
// that knows WHICH block it opened must be able to say so - `blockAt` is that, and without
// it an edit aimed at the answer rewrites the thinking.

const sameBoth = assistantMessage('r3', reasoning('SAME WORDS'), text('SAME WORDS'));
check(
  'the text-only selection takes the FIRST block holding the string',
  edit.cursorBlockIndex(sameBoth, 'SAME WORDS') === 0,
  String(edit.cursorBlockIndex(sameBoth, 'SAME WORDS'))
);

// The reasoning block on its own, with the text it holds: the plain case, through the plan.
const byBlockStore = edit.createEditStore({ restore: false });
const reasoningByBlock = byBlockStore.record('cot-block', deepseekReply, 'THE THINKING, BY BLOCK', { messageIndex: 0, expected: 'THE THINKING', blockAt: 0 });
check('a block index records the block it names', reasoningByBlock.ok === true && reasoningByBlock.edit?.cursor.block === 0, JSON.stringify(reasoningByBlock.reason ?? reasoningByBlock.edit?.cursor));
const reasoningPlan = edit.planWireRewrite([deepseekReply], [reasoningByBlock.edit]);
check(
  'the wire plan rewrites the reasoning through its own text field',
  reasoningPlan.changed === true && reasoningPlan.messages[0].content[0].text === 'THE THINKING, BY BLOCK',
  JSON.stringify(reasoningPlan.messages[0].content[0])
);
check('and the answer of that reply stays as it was', reasoningPlan.messages[0].content[1].text === 'THE ANSWER', JSON.stringify(reasoningPlan.messages[0].content[1]));

// The ambiguous reply, both ways round. This is the case the block index exists for.
const toThinking = byBlockStore.record('cot-block', sameBoth, 'THINKING, REWRITTEN', { messageIndex: 0, expected: 'SAME WORDS', blockAt: 0 });
check('an edit aimed at block 0 records the reasoning block', toThinking.ok === true && toThinking.edit?.cursor.block === 0, JSON.stringify(toThinking.reason ?? toThinking.edit?.cursor));
const toAnswer = byBlockStore.record('cot-block', sameBoth, 'ANSWER, REWRITTEN', { messageIndex: 0, expected: 'SAME WORDS', blockAt: 1 });
check('an edit aimed at block 1 records the text block', toAnswer.ok === true && toAnswer.edit?.cursor.block === 1, JSON.stringify(toAnswer.reason ?? toAnswer.edit?.cursor));

const thinkingPlan = edit.planWireRewrite([sameBoth], [toThinking.edit]);
check(
  'the wire plan rewrites the THINKING of a reply whose answer reads the same',
  thinkingPlan.changed === true && thinkingPlan.messages[0].content[0].text === 'THINKING, REWRITTEN',
  JSON.stringify(thinkingPlan.messages[0].content[0])
);
check('and leaves the identical answer alone', thinkingPlan.messages[0].content[1].text === 'SAME WORDS', JSON.stringify(thinkingPlan.messages[0].content[1]));

const answerPlan = edit.planWireRewrite([sameBoth], [toAnswer.edit]);
check(
  'the same string aimed at the ANSWER rewrites the answer',
  answerPlan.changed === true && answerPlan.messages[0].content[1].text === 'ANSWER, REWRITTEN',
  JSON.stringify(answerPlan.messages[0].content[1])
);
check('leaving the thinking alone', answerPlan.messages[0].content[0].text === 'SAME WORDS', JSON.stringify(answerPlan.messages[0].content[0]));

// A block index that does not hold what the edit was aimed at is REFUSED, not obeyed: the
// panel may have been open across a compress that rebuilt the reply underneath it.
const outside = byBlockStore.record('cot-block', sameBoth, 'anything', { messageIndex: 0, expected: 'SAME WORDS', blockAt: 7 });
check('a block index outside the message is refused', outside.ok === false && /holds no editable text/u.test(String(outside.reason)), String(outside.reason));
const mismatched = byBlockStore.record('cot-block', deepseekReply, 'anything', { messageIndex: 0, expected: 'THE ANSWER', blockAt: 0 });
check('a block whose text is not the expected text is refused', mismatched.ok === false && /aimed at/u.test(String(mismatched.reason)), String(mismatched.reason));
// The old payload shape keeps its old meaning: no block named, the text selection decides.
const byText = byBlockStore.record('cot-block', deepseekReply, 'ANSWER, BY TEXT', { messageIndex: 0, expected: 'THE ANSWER' });
check('a payload without a block still edits through the text', byText.ok === true && byText.edit?.cursor.block === 1, JSON.stringify(byText.reason ?? byText.edit?.cursor));

/* ------------------------------------------ explicit effective-basis chains */

const chainOriginal = assistantMessage('chain-message', text('A'));
const legacy = edit.createEditStore({ restore: false });
legacy.record('legacy-chain', chainOriginal, 'B', { messageIndex: 0, messageId: chainOriginal.id });
legacy.record('legacy-chain', chainOriginal, 'C', { messageIndex: 0, messageId: chainOriginal.id });
const legacyBefore = JSON.stringify(legacy.editsFor('legacy-chain'));
const legacyRestored = edit.createEditStore().editsFor('legacy-chain');
const legacyPlan = edit.planWireRewrite([chainOriginal], legacyRestored);
check('persisted v1 A->B, A->C still validates both against the original', legacyPlan.ok && legacyPlan.applied.length === 2 && legacyPlan.messages[0].content[0].text === 'C');
check('legacy audit records are never migrated or rewritten', JSON.stringify(legacyRestored) === legacyBefore && legacyRestored.every((record) => record.basis === undefined));

let chainStore = edit.createEditStore({ restore: false });
chainStore.record('effective-chain', chainOriginal, 'B', { messageIndex: 0, messageId: chainOriginal.id, basis: 'effective' });
chainStore = edit.createEditStore();
const chainSecond = chainStore.record('effective-chain', assistantMessage(chainOriginal.id, text('B')), 'C', {
  messageIndex: 0, messageId: chainOriginal.id, basis: 'effective', expected: 'B'
});
chainStore = edit.createEditStore();
chainStore.record('effective-chain', assistantMessage(chainOriginal.id, text('C')), 'A', {
  messageIndex: 0, messageId: chainOriginal.id, basis: 'effective', expected: 'C'
});
const chainRecords = edit.createEditStore().editsFor('effective-chain');
const chainPlan = edit.planWireRewrite(Object.freeze([Object.freeze(chainOriginal)]), chainRecords);
check('new records persist the explicit effective basis', chainSecond.edit?.basis === 'effective');
check('reload then record keeps strictly increasing audit order', chainRecords.every((record, i) => i === 0 || record.at > chainRecords[i - 1].at));
check('effective A->B->C->A applies sequentially after reload', chainPlan.ok && chainPlan.applied.length === 3 && chainPlan.messages[0].content[0].text === 'A', JSON.stringify(chainPlan.refused));
check('the effective chain preserves every before text', chainRecords.map((record) => record.before).join(',') === 'A,B,C');
const mixedRecords = [...legacyRestored, { ...chainSecond.edit, before: 'C', after: 'D', basis: 'effective' }];
const mixedPlan = edit.planWireRewrite([chainOriginal], mixedRecords);
check('effective records can follow legacy original-basis records', mixedPlan.ok && mixedPlan.messages[0].content[0].text === 'D');
const unmarked = edit.planWireRewrite([chainOriginal], [legacyRestored[0], { ...chainSecond.edit, basis: undefined }]);
check('an absent basis never silently enables chain validation', unmarked.refused.length === 1 && unmarked.messages[0].content[0].text === 'B');
const noPredecessor = edit.planWireRewrite([chainOriginal], [{ ...chainSecond.edit, basis: 'effective' }]);
check('a chain with a missing predecessor is refused', noPredecessor.applied.length === 0 && noPredecessor.refused.length === 1);
const foreignChain = edit.planWireRewrite([{ ...chainOriginal, id: 'other-message' }], chainRecords);
check('effective chains preserve message identity guards', foreignChain.applied.length === 0 && foreignChain.refused.length === chainRecords.length);

console.log(`\n${failures.length === 0 ? 'all edit behaviour tests passed' : `${failures.length} FAILURES: ${failures.join('; ')}`}`);
process.exit(failures.length === 0 ? 0 : 1);
