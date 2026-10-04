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
const { convertResponsesMessages } = await import('@earendil-works/pi-ai/api/openai-responses-shared');

const failures = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? '[ok]  ' : '[FAIL]'} ${name}${detail.length > 0 ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const text = (value) => ({ type: 'text', text: value });
const call = (id, name, args) => ({ type: 'tool-call', id, name, arguments: args });
const result = (callId, body) => ({ type: 'tool-result', toolCallId: callId, content: [text(body)], isError: false });
const userMessage = (id, ...blocks) => ({ id, role: 'user', content: blocks, source: { kind: 'user' } });
const assistantMessage = (id, ...blocks) => ({ id, role: 'assistant', content: blocks, source: { kind: 'model' } });
const resultMessage = (id, callId, body) => ({
  id, role: 'user', content: [result(callId, body)], source: { kind: 'tool', callId }
});
const hostResultMessage = (id, callId, body) => ({
  id, role: 'tool', toolCallId: callId, isError: false, content: [text(body)], source: { kind: 'tool', callId }
});

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
const compositeResult = {
  type: 'tool-result', toolCallId: 'composite', isError: false, providerMeta: { keep: true },
  content: [
    { type: 'image', data: 'before' },
    { type: 'text', text: 'FIRST', mediaType: 'text/plain' },
    { type: 'json', value: { untouched: true } },
    { type: 'text', text: 'SECOND' }
  ]
};
check(
  'a tool-result exposes the aggregate of every nested text string',
  edit.editableTextOf(compositeResult) === 'FIRSTSECOND',
  String(edit.editableTextOf(compositeResult))
);
const compositeRewrite = edit.applyEditToMessage(
  { id: 'tool-envelope', role: 'user', content: [compositeResult], envelopeMeta: 'keep' },
  { before: 'FIRSTSECOND', after: 'ONE REPLACEMENT' },
  0,
  0
);
const rewrittenNested = compositeRewrite?.content?.[0]?.content ?? [];
check(
  'editing an aggregate tool-result leaves exactly one text item at the first text position',
  rewrittenNested.filter((item) => item?.type === 'text').length === 1
    && rewrittenNested[1]?.type === 'text'
    && rewrittenNested[1]?.text === 'ONE REPLACEMENT',
  JSON.stringify(rewrittenNested)
);
check(
  'editing a tool-result preserves every non-text item and outer metadata',
  rewrittenNested[0] === compositeResult.content[0]
    && rewrittenNested[2] === compositeResult.content[2]
    && compositeRewrite.envelopeMeta === 'keep'
    && compositeRewrite.content[0].providerMeta.keep === true
    && compositeRewrite.content[0].isError === false,
  JSON.stringify(compositeRewrite)
);
const nonTextResult = {
  type: 'tool-result', toolCallId: 'binary-only', content: [{ type: 'image', data: 'only-image' }], marker: 'keep'
};
const nonTextRewrite = edit.applyEditToMessage(
  { role: 'user', content: [nonTextResult] },
  { before: '', after: 'MUST NOT APPEAR' },
  0,
  0
);
check('a non-text-only tool-result exposes no editable text', edit.editableTextOf(nonTextResult) === undefined);
check('editing a non-text-only tool-result does not invent text', nonTextRewrite === undefined, JSON.stringify(nonTextRewrite));
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
check('clearing removes persisted state instead of resurrecting it after restart',
  !existsSync(edit.editStatePath('undo-test')) && edit.createEditStore().editsFor('undo-test').length === 0);

let rejectWrites = true;
const transactionalStore = edit.createEditStore({
  restore: false,
  save: () => {
    if (rejectWrites) throw new Error('simulated persistence failure');
  }
});
let persistenceFailure;
try {
  transactionalStore.record('transactional', userMessage('u-tx', text('before')), 'after', { messageIndex: 0 });
} catch (error) {
  persistenceFailure = error;
}
check('a persistence failure does not publish an edit in memory',
  /simulated persistence failure/u.test(String(persistenceFailure))
    && transactionalStore.editsFor('transactional').length === 0,
  JSON.stringify(transactionalStore.editsFor('transactional')));
rejectWrites = false;
const retriedTransaction = transactionalStore.record(
  'transactional', userMessage('u-tx', text('before')), 'after', { messageIndex: 0 }
);
check('a failed save consumes neither ordering nor edit ids',
  retriedTransaction.ok === true
    && retriedTransaction.edit?.at === 1
    && retriedTransaction.edit?.id === 'transact-e1',
  JSON.stringify(retriedTransaction));
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

// A reasoning block is the model's chain of thought. Some providers attach signatures to
// the visible or replay-state block. Rewriting signed, non-redacted text is safe only when
// every stale signature is removed; redacted thinking is still refused. The signed and
// unsigned paths are both asserted because the failure mode is silent: a rewrite can report
// success while leaving either the text or stale provider metadata in place.

const reasoning = (value) => ({ type: 'reasoning', text: value });
const deepseekReply = assistantMessage('r1', reasoning('THE THINKING'), text('THE ANSWER'));
const signedReply = {
  ...assistantMessage('r2', {
    ...reasoning('SIGNED THINKING'),
    signature: 'VISIBLE-SIGNATURE',
    thoughtSignature: 'VISIBLE-THOUGHT-SIGNATURE',
    textSignature: 'VISIBLE-TEXT-SIGNATURE'
  }),
  source: {
    kind: 'model',
    provider: 'pi',
    model: 'claude',
    replayState: {
      response: { kind: 'pi-ai', version: 2, api: 'anthropic-messages', provider: 'pi', model: 'claude', stopReason: 'stop' },
      blocks: [{
        type: 'reasoning',
        thinkingSignature: 'SIG-over-the-old-thinking',
        textSignature: 'TEXT-SIG-over-the-old-thinking'
      }]
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
check('recording an edit over SIGNED non-redacted thinking succeeds', signedRecord.ok === true, JSON.stringify(signedRecord.reason ?? signedRecord.edit?.id ?? ''));
check('the signed reasoning cursor is recorded', signedRecord.edit?.cursor.block === 0, String(signedRecord.edit?.cursor.block));
const signedPlan = edit.planWireRewrite([signedReply], [signedRecord.edit]);
const signedBlock = signedPlan.messages[0]?.content?.[0];
const signedReplayBlock = signedPlan.messages[0]?.source?.replayState?.blocks?.[0];
check('the wire rewrite applies an edit of signed thinking', signedPlan.changed === true && signedPlan.refused.length === 0 && signedBlock?.text === 'SIGNED THINKING, CORRECTED', JSON.stringify(signedPlan.refused.map((r) => r.reason)));
check(
  'signed reasoning is downgraded to replayable ordinary text without stale signatures',
  signedBlock?.type === 'text'
    && signedBlock?.signature === undefined
    && signedBlock?.thinkingSignature === undefined
    && signedBlock?.thoughtSignature === undefined
    && signedBlock?.textSignature === undefined,
  JSON.stringify(signedBlock)
);
check(
  'the replay-state carrier is downgraded with the signed reasoning',
  signedReplayBlock?.type === 'text'
    && signedReplayBlock?.signature === undefined
    && signedReplayBlock?.thinkingSignature === undefined
    && signedReplayBlock?.thoughtSignature === undefined
    && signedReplayBlock?.textSignature === undefined,
  JSON.stringify(signedReplayBlock)
);
check(
  'the signed source message remains immutable',
  signedReply.content[0].signature === 'VISIBLE-SIGNATURE'
    && signedReply.content[0].thoughtSignature === 'VISIBLE-THOUGHT-SIGNATURE'
    && signedReply.content[0].textSignature === 'VISIBLE-TEXT-SIGNATURE'
    && signedReply.source.replayState.blocks[0].thinkingSignature === 'SIG-over-the-old-thinking'
    && signedReply.source.replayState.blocks[0].textSignature === 'TEXT-SIG-over-the-old-thinking',
  JSON.stringify(signedReply)
);
const textSignatureOnly = edit.applyEditToMessage(
  assistantMessage('text-signature-only', { ...reasoning('OLD'), textSignature: 'VISIBLE-ONLY' }),
  { before: 'OLD', after: 'NEW' },
  0,
  0
);
check(
  'textSignature alone marks visible reasoning as signed and is stripped on conversion',
  textSignatureOnly?.content?.[0]?.type === 'text'
    && textSignatureOnly.content[0].text === 'NEW'
    && textSignatureOnly.content[0].textSignature === undefined,
  JSON.stringify(textSignatureOnly)
);
const replayTextSignatureOnly = edit.applyEditToMessage({
  ...assistantMessage('replay-text-signature-only', reasoning('OLD REPLAY')),
  source: { replayState: { blocks: [{ type: 'reasoning', textSignature: 'REPLAY-ONLY' }] } }
}, { before: 'OLD REPLAY', after: 'NEW REPLAY' }, 0, 0);
check(
  'same-index replay textSignature alone triggers signed conversion and is stripped',
  replayTextSignatureOnly?.content?.[0]?.type === 'text'
    && replayTextSignatureOnly.source.replayState.blocks[0].type === 'text'
    && replayTextSignatureOnly.source.replayState.blocks[0].textSignature === undefined,
  JSON.stringify(replayTextSignatureOnly)
);

const openAiSignedReply = {
  ...assistantMessage('r-openai-signed', reasoning('OPENAI SIGNED THINKING')),
  source: {
    kind: 'model', provider: 'openai', model: 'gpt-5',
    replayState: {
      response: {
        kind: 'pi-ai', version: 2, api: 'openai-responses', provider: 'openai', model: 'gpt-5', stopReason: 'stop'
      },
      blocks: [{
        type: 'reasoning',
        thinkingSignature: JSON.stringify({ type: 'reasoning', id: 'rs_old', summary: [] })
      }]
    }
  }
};
const openAiRecord = signedStore.record(
  'cot-openai-signed', openAiSignedReply, 'OPENAI SIGNED THINKING, CORRECTED',
  { messageIndex: 0, expected: 'OPENAI SIGNED THINKING' }
);
const openAiPlan = openAiRecord.ok
  ? edit.planWireRewrite([openAiSignedReply], [openAiRecord.edit])
  : { messages: [] };
const openAiWireBlock = openAiPlan.messages[0]?.content?.[0];
const openAiInput = openAiWireBlock?.type === 'text'
  ? convertResponsesMessages({
    provider: 'openai', api: 'openai-responses', id: 'gpt-5', input: ['text'], output: ['text'], reasoning: true, compat: {}
  }, {
    messages: [{
      role: 'assistant', content: [{ type: 'text', text: openAiWireBlock.text }],
      api: 'openai-responses', provider: 'openai', model: 'gpt-5', stopReason: 'stop', timestamp: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
    }]
  }, new Set(['openai']))
  : [];
check(
  'edited signed OpenAI reasoning survives the Responses serializer as ordinary assistant text',
  openAiRecord.ok === true
    && openAiWireBlock?.type === 'text'
    && openAiInput.some((item) => item?.type === 'message'
      && item.content?.some((part) => part?.text === 'OPENAI SIGNED THINKING, CORRECTED')),
  JSON.stringify({ record: openAiRecord.reason, block: openAiWireBlock, input: openAiInput })
);

const explicitlyUnredactedReply = {
  ...signedReply,
  id: 'r2-explicitly-unredacted',
  content: [{ ...signedReply.content[0], redacted: false }],
  source: {
    ...signedReply.source,
    replayState: {
      ...signedReply.source.replayState,
      blocks: [{ ...signedReply.source.replayState.blocks[0], redacted: false }]
    }
  }
};
const explicitlyUnredactedRecord = signedStore.record(
  'cot-signed-explicitly-unredacted',
  explicitlyUnredactedReply,
  'EXPLICITLY UNREDACTED THINKING, CORRECTED',
  { messageIndex: 0, expected: 'SIGNED THINKING' }
);
const explicitlyUnredactedPlan = explicitlyUnredactedRecord.ok
  ? edit.planWireRewrite([explicitlyUnredactedReply], [explicitlyUnredactedRecord.edit])
  : { changed: false, refused: [{ reason: explicitlyUnredactedRecord.reason }], messages: [] };
check(
  'redacted false is editable rather than treated as redacted provider state',
  explicitlyUnredactedRecord.ok === true
    && explicitlyUnredactedPlan.changed === true
    && explicitlyUnredactedPlan.refused.length === 0
    && explicitlyUnredactedPlan.messages[0]?.content?.[0]?.text === 'EXPLICITLY UNREDACTED THINKING, CORRECTED',
  JSON.stringify(explicitlyUnredactedPlan.refused)
);
const redactedReply = {
  ...assistantMessage('r-redacted', reasoning('VISIBLE PLACEHOLDER')),
  source: { replayState: { blocks: [{ type: 'reasoning', redacted: 'OPAQUE PROVIDER STATE' }] } }
};
const redactedRecord = signedStore.record('cot-redacted', redactedReply, 'SHOULD NOT APPLY', { messageIndex: 0, expected: 'VISIBLE PLACEHOLDER' });
check('recording an edit over redacted thinking is refused', redactedRecord.ok === false, JSON.stringify(redactedRecord));
check('the redacted refusal names the unavailable provider text', /redacted|not what the provider receives/u.test(String(redactedRecord.reason)), String(redactedRecord.reason));
const handMade = signedRecord.edit;
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

/* ----------------------------------------------- whole-turn deletion overlay */

const turnMessages = freezeRequest([
  { id: 'sys', role: 'system', content: 'SYSTEM' },
  userMessage('u1', text('First question')),
  assistantMessage('a1-call', text('Checking'), call('turn-call', 'read', '{}')),
  resultMessage('r1', 'turn-call', 'TOOL BODY'),
  assistantMessage('a1-final', text('First answer')),
  userMessage('u2', text('Second question')),
  assistantMessage('a2', text('Second answer')),
  userMessage('u3', text('Third question'))
], 'delete-turns').messages;

let deleteStore = edit.createEditStore({ restore: false });
const firstDelete = deleteStore.deleteTurn('delete-first', turnMessages, {
  messageIndex: 1, messageId: 'u1', expected: 'First question'
});
check('a user turn deletion is recorded as an effective tombstone', firstDelete.ok === true
  && firstDelete.edit?.kind === 'delete-turn' && firstDelete.edit?.basis === 'effective');
const firstPlan = edit.planWireRewrite(turnMessages, deleteStore.editsFor('delete-first'));
check('deleting the first turn removes its complete assistant and tool group',
  firstPlan.messages.map((message) => message.id).join(',') === 'sys,u2,a2,u3',
  firstPlan.messages.map((message) => message.id).join(','));
check('turn deletion reports stable provenance for every removed message',
  firstPlan.applied[0]?.originIndex === 1
    && firstPlan.applied[0]?.removedOrigins?.join(',') === '1,2,3,4'
    && firstPlan.origins.join(',') === '0,5,6,7', JSON.stringify(firstPlan));

// The live Host projects a tool result as a role=tool message whose pairing id is
// top-level. The older nested tool-result shape above remains valid, but it cannot be
// the only shape closure validation understands.
const hostToolTurn = freezeRequest([
  { id: 'host-sys', role: 'system', content: 'SYSTEM' },
  userMessage('host-u1', text('Run the live tool')),
  assistantMessage('host-a1-call', text('Running'), call('host-call', 'ctx_execute', '{}')),
  hostResultMessage('host-r1', 'host-call', 'smoke-ok'),
  assistantMessage('host-a1-final', text('done')),
  userMessage('host-u2', text('Keep this turn'))
], 'delete-host-tool-turn').messages;
const hostToolStore = edit.createEditStore({ restore: false });
const hostToolDelete = hostToolStore.deleteTurn('delete-host-tool-turn', hostToolTurn, {
  messageIndex: 1, messageId: 'host-u1', expected: 'Run the live tool'
});
const hostToolPlan = edit.planWireRewrite(hostToolTurn, hostToolStore.editsFor('delete-host-tool-turn'));
check('a live Host top-level tool result closes the deleted interaction',
  hostToolDelete.ok === true
    && hostToolPlan.messages.map((message) => message.id).join(',') === 'host-sys,host-u2',
  JSON.stringify({ deletion: hostToolDelete, refused: hostToolPlan.refused }));

const persistedDelete = edit.createEditStore().editsFor('delete-first');
const persistedPlan = edit.planWireRewrite(turnMessages, persistedDelete);
check('a deletion tombstone survives store reload', persistedDelete.length === 1
  && persistedDelete[0]?.kind === 'delete-turn'
  && persistedPlan.messages.map((message) => message.id).join(',') === 'sys,u2,a2,u3');

const middleStore = edit.createEditStore({ restore: false });
middleStore.deleteTurn('delete-middle', turnMessages, { messageIndex: 5, messageId: 'u2', expected: 'Second question' });
const middlePlan = edit.planWireRewrite(turnMessages, middleStore.editsFor('delete-middle'));
check('deleting a middle turn stops immediately before the next human user message',
  middlePlan.messages.map((message) => message.id).join(',') === 'sys,u1,a1-call,r1,a1-final,u3');

const lastStore = edit.createEditStore({ restore: false });
lastStore.deleteTurn('delete-last', turnMessages, { messageIndex: 7, messageId: 'u3', expected: 'Third question' });
const lastPlan = edit.planWireRewrite(turnMessages, lastStore.editsFor('delete-last'));
check('deleting the last turn removes through the end of the request',
  lastPlan.messages.map((message) => message.id).join(',') === 'sys,u1,a1-call,r1,a1-final,u2,a2');

const finalHistory = [...turnMessages, assistantMessage('a3', text('Third answer'))];
const finalStore = edit.createEditStore({ restore: false });
finalStore.deleteTurn('delete-final-stable', finalHistory, { messageIndex: 7, messageId: 'u3', expected: 'Third question' });
const withFuturePrompt = [...finalHistory, userMessage('u4', text('Future question'))];
const futurePlan = edit.planWireRewrite(withFuturePrompt, finalStore.editsFor('delete-final-stable'));
check('a final-turn tombstone never expands onto a future user prompt',
  futurePlan.messages.map((message) => message.id).join(',') === 'sys,u1,a1-call,r1,a1-final,u2,a2,u4');

const syntheticUser = {
  id: 'goal-continue', role: 'user', content: [text('Continue toward the goal')], source: { kind: 'goal' }
};
const syntheticHistory = [
  userMessage('direct-1', text('Do the work')),
  assistantMessage('model-1', text('Part one')),
  syntheticUser,
  assistantMessage('model-2', text('Part two')),
  userMessage('direct-2', text('A new human request'))
];
const syntheticStore = edit.createEditStore({ restore: false });
syntheticStore.deleteTurn('delete-synthetic', syntheticHistory, {
  messageIndex: 0, messageId: 'direct-1', expected: 'Do the work'
});
const syntheticPlan = edit.planWireRewrite(syntheticHistory, syntheticStore.editsFor('delete-synthetic'));
check('synthetic user-role continuations stay inside the deleted human turn',
  syntheticPlan.messages.map((message) => message.id).join(',') === 'direct-2');

const durableEditedHistory = turnMessages.map((message) => message.id === 'u1'
  ? { ...message, content: [text('First question, edited')], source: { kind: 'plugin:context-kit-editor' } }
  : message);
const durableEditedStore = edit.createEditStore({ restore: false });
const durableEditedDelete = durableEditedStore.deleteTurn('delete-durable-user', durableEditedHistory, {
  messageIndex: 1, messageId: 'u1', expected: 'First question, edited'
});
const durableEditedPlan = edit.planWireRewrite(durableEditedHistory, durableEditedStore.editsFor('delete-durable-user'));
check('a durably edited human message remains a turn-deletion boundary', durableEditedDelete.ok === true
  && durableEditedPlan.messages.map((message) => message.id).join(',') === 'sys,u2,a2,u3');

const durableBoundaryHistory = turnMessages.map((message) => message.id === 'u1'
  ? { ...message, content: [text('First question, edited')], source: { kind: 'plugin:context-kit-editor' } }
  : message.id === 'u2'
    ? { ...message, content: [text('Second question, edited')], source: { kind: 'plugin:edit' } }
    : message);
const durableBoundaryStore = edit.createEditStore({ restore: false });
const durableBoundaryDelete = durableBoundaryStore.deleteTurn('delete-durable-boundaries', durableBoundaryHistory, {
  messageIndex: 1, messageId: 'u1', expected: 'First question, edited'
});
const durableBoundaryProblems = [];
const restoredBoundaryStore = edit.createEditStore({
  onProblem: (_sessionId, problem) => durableBoundaryProblems.push(problem)
});
const restoredBoundaryEdits = restoredBoundaryStore.editsFor('delete-durable-boundaries');
const restoredBoundaryPlan = edit.planWireRewrite(durableBoundaryHistory, restoredBoundaryEdits);
check('edited anchor and next-boundary provenance survives save, reload, and replan',
  durableBoundaryDelete.ok === true
    && durableBoundaryProblems.length === 0
    && restoredBoundaryEdits.length === 1
    && restoredBoundaryPlan.messages.map((message) => message.id).join(',') === 'sys,u2,a2,u3',
  JSON.stringify({ problems: durableBoundaryProblems, edits: restoredBoundaryEdits, plan: restoredBoundaryPlan }));

const changedMembers = [...finalHistory];
changedMembers.splice(8, 0, assistantMessage('inserted', text('Unexpected insertion')));
const changedMemberPlan = edit.planWireRewrite(changedMembers, finalStore.editsFor('delete-final-stable'));
check('an inserted member makes the whole deletion refuse atomically',
  changedMemberPlan.applied.length === 0 && changedMemberPlan.refused.length === 1
    && changedMemberPlan.messages.length === changedMembers.length);

const incompleteToolTurn = [
  userMessage('tool-user', text('Run it')),
  assistantMessage('orphan-call', call('orphan', 'read', '{}'))
];
const incompleteDelete = edit.createEditStore({ restore: false }).deleteTurn('delete-incomplete-tool', incompleteToolTurn, {
  messageIndex: 0, messageId: 'tool-user', expected: 'Run it'
});
check('a deletion with an unpaired tool call is refused before persistence',
  incompleteDelete.ok === false && /missing or ambiguous/u.test(String(incompleteDelete.reason)));

const staleDelete = edit.createEditStore({ restore: false }).deleteTurn('delete-stale', turnMessages, {
  messageIndex: 1, messageId: 'u1', expected: 'Old question text'
});
check('a stale delete coordinate is refused before persistence', staleDelete.ok === false && /aimed at/u.test(String(staleDelete.reason)));
const renamedDeleteTarget = turnMessages.map((message) => message.id === 'u1' ? { ...message, id: 'foreign-u1' } : message);
const renamedDeletePlan = edit.planWireRewrite(renamedDeleteTarget, persistedDelete);
check('a deletion never moves onto a same-text message with a different id',
  renamedDeletePlan.applied.length === 0 && renamedDeletePlan.refused.length === 1
    && renamedDeletePlan.messages.length === turnMessages.length);

const mixedStore = edit.createEditStore({ restore: false });
mixedStore.deleteTurn('delete-then-edit', turnMessages, { messageIndex: 1, messageId: 'u1', expected: 'First question' });
mixedStore.record('delete-then-edit', turnMessages[6], 'Second answer edited', {
  messageIndex: 2, messageId: 'a2', expected: 'Second answer', basis: 'effective'
});
const mixedDeletePlan = edit.planWireRewrite(turnMessages, mixedStore.editsFor('delete-then-edit'));
check('an effective edit after deletion uses the compacted index but keeps original provenance',
  mixedDeletePlan.messages[2]?.id === 'a2'
    && mixedDeletePlan.messages[2]?.content?.[0]?.text === 'Second answer edited'
    && mixedDeletePlan.applied[1]?.index === 2 && mixedDeletePlan.applied[1]?.originIndex === 6,
  JSON.stringify(mixedDeletePlan.applied));

/* ------------------------------------------ one-assistant deletion overlay */

const assistantHistory = freezeRequest([
  { id: 'assistant-sys', role: 'system', content: 'SYSTEM' },
  userMessage('assistant-u1', text('First question')),
  assistantMessage('assistant-call', text('Checking'), call('assistant-tool', 'read', '{}')),
  resultMessage('assistant-result', 'assistant-tool', 'TOOL BODY'),
  assistantMessage('assistant-final', text('First answer')),
  userMessage('assistant-u2', text('Second question')),
  assistantMessage('assistant-a2', text('Second answer')),
  userMessage('assistant-u3', text('Third question'))
], 'delete-assistant').messages;

const messageStore = edit.createEditStore({ restore: false });
const messageDelete = messageStore.deleteMessage('delete-assistant-call', assistantHistory, {
  messageIndex: 2, messageId: 'assistant-call', expected: 'Checking{}'
});
const messagePlan = edit.planWireRewrite(assistantHistory, messageStore.editsFor('delete-assistant-call'));
check('assistant deletion is a distinct effective message tombstone', messageDelete.ok === true
  && messageDelete.edit?.kind === 'delete-message' && messageDelete.edit?.basis === 'effective');
check('deleting a tool-calling assistant removes only it and its contiguous result',
  messagePlan.messages.map((message) => message.id).join(',')
    === 'assistant-sys,assistant-u1,assistant-final,assistant-u2,assistant-a2,assistant-u3',
  messagePlan.messages.map((message) => message.id).join(','));
check('assistant deletion reports stable provenance for its complete closure',
  messagePlan.applied[0]?.originIndex === 2
    && messagePlan.applied[0]?.removedOrigins?.join(',') === '2,3'
    && messagePlan.applied[0]?.removedIds?.join(',') === 'assistant-call,assistant-result',
  JSON.stringify(messagePlan.applied));

const finalAnswerStore = edit.createEditStore({ restore: false });
finalAnswerStore.deleteMessage('delete-assistant-final', assistantHistory, {
  messageIndex: 4, messageId: 'assistant-final', expected: 'First answer'
});
const finalAnswerPlan = edit.planWireRewrite(assistantHistory, finalAnswerStore.editsFor('delete-assistant-final'));
check('deleting a final answer keeps the completed tool exchange before it',
  finalAnswerPlan.messages.map((message) => message.id).join(',')
    === 'assistant-sys,assistant-u1,assistant-call,assistant-result,assistant-u2,assistant-a2,assistant-u3');

const toolFreeStore = edit.createEditStore({ restore: false });
toolFreeStore.deleteMessage('delete-assistant-tool-free', assistantHistory, {
  messageIndex: 6, messageId: 'assistant-a2', expected: 'Second answer'
});
const toolFreePlan = edit.planWireRewrite(assistantHistory, toolFreeStore.editsFor('delete-assistant-tool-free'));
check('a tool-free assistant deletion removes exactly one envelope',
  toolFreePlan.applied[0]?.removedIds?.join(',') === 'assistant-a2');
check('consecutive direct-user messages remain provider-valid after assistant deletion',
  toolFreePlan.messages.slice(-2).every((message) => message.role === 'user')
    && toolFreePlan.messages.slice(-2).map((message) => message.id).join(',') === 'assistant-u2,assistant-u3');

const hostAssistantHistory = freezeRequest([
  userMessage('host-assistant-u', text('Run the tool')),
  assistantMessage('host-assistant-call', call('host-assistant-tool', 'ctx_execute', '{}')),
  hostResultMessage('host-assistant-result', 'host-assistant-tool', 'done'),
  assistantMessage('host-assistant-final', text('Finished'))
], 'delete-host-assistant').messages;
const hostAssistantStore = edit.createEditStore({ restore: false });
const hostAssistantDelete = hostAssistantStore.deleteMessage('delete-host-assistant', hostAssistantHistory, {
  messageIndex: 1, messageId: 'host-assistant-call', expected: '{}'
});
const hostAssistantPlan = edit.planWireRewrite(hostAssistantHistory, hostAssistantStore.editsFor('delete-host-assistant'));
check('assistant deletion closes a live Host top-level tool result', hostAssistantDelete.ok === true
  && hostAssistantPlan.messages.map((message) => message.id).join(',') === 'host-assistant-u,host-assistant-final');

const nestedRoleToolHistory = freezeRequest([
  userMessage('nested-role-tool-u', text('Run the tool')),
  assistantMessage('nested-role-tool-call', call('nested-role-tool', 'ctx_execute', '{}')),
  {
    id: 'nested-role-tool-result',
    role: 'tool',
    content: [result('nested-role-tool', 'done')],
    source: { kind: 'tool' }
  },
  assistantMessage('nested-role-tool-final', text('Finished'))
], 'delete-nested-role-tool').messages;
const nestedRoleToolStore = edit.createEditStore({ restore: false });
const nestedRoleToolDelete = nestedRoleToolStore.deleteMessage('delete-nested-role-tool', nestedRoleToolHistory, {
  messageIndex: 1, messageId: 'nested-role-tool-call', expected: '{}'
});
const nestedRoleToolPlan = edit.planWireRewrite(nestedRoleToolHistory, nestedRoleToolStore.editsFor('delete-nested-role-tool'));
check('assistant deletion accepts a nested pairing id on a role=tool result', nestedRoleToolDelete.ok === true
  && nestedRoleToolPlan.messages.map((message) => message.id).join(',') === 'nested-role-tool-u,nested-role-tool-final');

const twoCallHistory = freezeRequest([
  userMessage('two-u', text('Run both')),
  assistantMessage('two-call', call('call-a', 'read', '{"a":1}'), call('call-b', 'read', '{"b":2}')),
  resultMessage('two-result-a', 'call-a', 'A'),
  hostResultMessage('two-result-b', 'call-b', 'B'),
  assistantMessage('two-final', text('Both done'))
], 'delete-two-calls').messages;
const twoCallStore = edit.createEditStore({ restore: false });
twoCallStore.deleteMessage('delete-two-calls', twoCallHistory, {
  messageIndex: 1, messageId: 'two-call', expected: '{"a":1}{"b":2}'
});
const twoCallPlan = edit.planWireRewrite(twoCallHistory, twoCallStore.editsFor('delete-two-calls'));
check('all contiguous results of one multi-call assistant travel with it',
  twoCallPlan.messages.map((message) => message.id).join(',') === 'two-u,two-final');

const assistantRefusal = (name, messages, pattern) => {
  const answer = edit.createEditStore({ restore: false }).deleteMessage(name, messages, {
    messageIndex: 1, messageId: messages[1]?.id
  });
  check(name, answer.ok === false && pattern.test(String(answer.reason)), String(answer.reason));
};
assistantRefusal('assistant deletion refuses a missing tool result', [
  userMessage('missing-u', text('Run')),
  assistantMessage('missing-call', call('missing-tool', 'read', '{}')),
  assistantMessage('missing-final', text('No result'))
], /no contiguous result/u);
assistantRefusal('assistant deletion refuses an interleaved tool result', [
  userMessage('interleaved-u', text('Run')),
  assistantMessage('interleaved-call', call('interleaved-tool', 'read', '{}')),
  userMessage('interleaved-boundary', text('Do not cross')),
  resultMessage('interleaved-result', 'interleaved-tool', 'late')
], /no contiguous result/u);
assistantRefusal('assistant deletion refuses an unrelated result envelope', [
  userMessage('unrelated-u', text('Run')),
  assistantMessage('unrelated-call', call('wanted-tool', 'read', '{}')),
  resultMessage('unrelated-result', 'foreign-tool', 'wrong')
], /unrelated or ambiguous/u);
assistantRefusal('assistant deletion refuses a tool-call block without a pairing id', [
  userMessage('missing-call-id-u', text('Run')),
  assistantMessage('missing-call-id-a', text('Checking'), { type: 'tool-call', name: 'read', arguments: '{}' }),
  resultMessage('missing-call-id-r', 'unclaimed-tool', 'done')
], /tool-call block has no pairing id/u);
assistantRefusal('assistant deletion refuses a mixed tool-result envelope with an unpaired block', [
  userMessage('missing-result-id-u', text('Run')),
  assistantMessage('missing-result-id-a', call('paired-tool', 'read', '{}')),
  {
    id: 'missing-result-id-r',
    role: 'user',
    content: [result('paired-tool', 'done'), { type: 'tool-result', content: [text('orphan')] }],
    source: { kind: 'tool' }
  }
], /tool-result block has no pairing id/u);
assistantRefusal('assistant deletion refuses an empty top-level result pairing id', [
  userMessage('empty-result-id-u', text('Run')),
  assistantMessage('empty-result-id-a', call('paired-nested-tool', 'read', '{}')),
  {
    id: 'empty-result-id-r',
    role: 'tool',
    toolCallId: '',
    content: [result('paired-nested-tool', 'done')],
    source: { kind: 'tool' }
  }
], /tool-result envelope has no pairing id/u);
assistantRefusal('assistant deletion refuses duplicate tool-call ids', [
  userMessage('duplicate-call-u', text('Run')),
  assistantMessage('duplicate-call-a', call('duplicate-tool', 'read', '{}'), call('duplicate-tool', 'write', '{}')),
  resultMessage('duplicate-call-r', 'duplicate-tool', 'done')
], /duplicate tool-call ids/u);
assistantRefusal('assistant deletion refuses duplicate tool results anywhere in history', [
  userMessage('duplicate-result-u', text('Run')),
  assistantMessage('duplicate-result-a', call('duplicate-result-tool', 'read', '{}')),
  resultMessage('duplicate-result-r1', 'duplicate-result-tool', 'first'),
  resultMessage('duplicate-result-r2', 'duplicate-result-tool', 'second')
], /missing or ambiguous/u);
assistantRefusal('assistant deletion refuses a tool interaction crossing its boundary', [
  userMessage('cross-u', text('Run')),
  assistantMessage('cross-a', result('cross-tool', 'result inside target')),
  assistantMessage('cross-call', call('cross-tool', 'read', '{}'))
], /crosses the deletion boundary/u);

const reloadedMessageStore = edit.createEditStore().editsFor('delete-assistant-call');
const reloadedMessagePlan = edit.planWireRewrite(assistantHistory, reloadedMessageStore);
check('an assistant-message tombstone survives reload and replay', reloadedMessageStore.length === 1
  && reloadedMessageStore[0]?.kind === 'delete-message'
  && reloadedMessagePlan.messages.map((message) => message.id).join(',')
    === 'assistant-sys,assistant-u1,assistant-final,assistant-u2,assistant-a2,assistant-u3');

const changedAssistantOrder = [...assistantHistory];
changedAssistantOrder[3] = { ...changedAssistantOrder[3], id: 'replacement-result' };
const changedAssistantPlan = edit.planWireRewrite(changedAssistantOrder, reloadedMessageStore);
check('assistant deletion refuses a changed tool-result identity or order',
  changedAssistantPlan.applied.length === 0 && changedAssistantPlan.refused.length === 1);
const changedAssistantBoundary = [...assistantHistory];
changedAssistantBoundary[4] = { ...changedAssistantBoundary[4], id: 'replacement-final' };
const changedBoundaryPlan = edit.planWireRewrite(changedAssistantBoundary, reloadedMessageStore);
check('assistant deletion refuses a changed following-message boundary',
  changedBoundaryPlan.applied.length === 0 && changedBoundaryPlan.refused.length === 1);
const ambiguousAssistantHistory = [
  { id: 'inserted', role: 'system', content: 'INSERTED' },
  ...assistantHistory,
  assistantHistory[2], assistantHistory[3]
];
const ambiguousAssistantPlan = edit.planWireRewrite(ambiguousAssistantHistory, reloadedMessageStore);
check('assistant deletion refuses duplicate matching identities after its index moves',
  ambiguousAssistantPlan.applied.length === 0 && /refusing to guess/u.test(ambiguousAssistantPlan.refused[0]?.reason));

const layeredAssistantHistory = [
  userMessage('layered-u', text('Question')),
  assistantMessage('layered-a', text('Original answer')),
  userMessage('layered-next', text('Next'))
];
const layeredAssistantStore = edit.createEditStore({ restore: false });
layeredAssistantStore.record('layered-assistant-delete', layeredAssistantHistory[1], 'Edited answer', {
  messageIndex: 1, messageId: 'layered-a', expected: 'Original answer', basis: 'effective'
});
const editedAssistantHistory = edit.planWireRewrite(layeredAssistantHistory,
  layeredAssistantStore.editsFor('layered-assistant-delete')).messages;
layeredAssistantStore.deleteMessage('layered-assistant-delete', editedAssistantHistory, {
  messageIndex: 1, messageId: 'layered-a', expected: 'Edited answer'
});
const layeredAssistantPlan = edit.planWireRewrite(layeredAssistantHistory,
  layeredAssistantStore.editsFor('layered-assistant-delete'));
check('assistant deletion chains after an effective edit and removes the edited envelope',
  layeredAssistantPlan.ok && layeredAssistantPlan.applied.length === 2
    && layeredAssistantPlan.messages.map((message) => message.id).join(',') === 'layered-u,layered-next',
  JSON.stringify(layeredAssistantPlan));

/* --------------------------------------- prepared truncate-anchor transactions */

const transactionHistory = (prefix, anchorText = 'Retained question') => [
  userMessage(`${prefix}-anchor`, text(anchorText)),
  assistantMessage(`${prefix}-answer`, text('Answer to remove')),
  userMessage(`${prefix}-next`, text('Later turn'))
];
const replacementFor = (id, body) => ({
  id,
  role: 'user',
  content: [text(body)],
  source: { kind: 'plugin:context-kit-editor' }
});
const eventSession = (id, messages) => ({
  id,
  snapshotEvents() {
    return messages.map((message, seq) => ({ seq, data: message }));
  }
});

const realTransactionSession = 'prepared-real-files';
const realHistory = transactionHistory('prepared-real');
const realStore = edit.createEditStore();
const realTruncate = realStore.truncateAfter(realTransactionSession, realHistory, {
  messageIndex: 0,
  messageId: realHistory[0].id,
  expected: 'Retained question'
});
const realMainPath = edit.editStatePath(realTransactionSession);
const realJournalPath = edit.editTransactionPath(realTransactionSession);
const realBaseDocument = readFileSync(realMainPath, 'utf8');
const realReplacement = replacementFor('prepared-real-replacement', 'Edited retained question');
const realPrepared = realStore.prepareTruncateAnchorRebase(
  realTransactionSession,
  realHistory[0].id,
  realReplacement
);
check('preparing a real rebase writes a separate journal', realTruncate.ok === true
  && realPrepared.ok === true && existsSync(realJournalPath));
check('preparing keeps the real main edit document and memory on the old state',
  readFileSync(realMainPath, 'utf8') === realBaseDocument
    && realStore.editsFor(realTransactionSession)[0]?.messageId === realHistory[0].id);

const restartedRealStore = edit.createEditStore();
check('restart hydration exposes the old side until recovery',
  restartedRealStore.editsFor(realTransactionSession)[0]?.messageId === realHistory[0].id);
const realRecovery = restartedRealStore.recoverPrepared(
  realTransactionSession,
  eventSession(realTransactionSession, [realReplacement])
);
const recoveredRealDocument = JSON.parse(readFileSync(realMainPath, 'utf8'));
check('restart recovery commits when the replacement is durable', realRecovery.ok === true
  && realRecovery.action === 'committed'
  && recoveredRealDocument.edits[0]?.messageId === realReplacement.id
  && restartedRealStore.editsFor(realTransactionSession)[0]?.messageId === realReplacement.id
  && !existsSync(realJournalPath));

const rollbackTransactionSession = 'prepared-real-rollback';
const rollbackHistory = transactionHistory('prepared-rollback');
const rollbackStore = edit.createEditStore();
rollbackStore.truncateAfter(rollbackTransactionSession, rollbackHistory, {
  messageIndex: 0,
  messageId: rollbackHistory[0].id,
  expected: 'Retained question'
});
const rollbackMainPath = edit.editStatePath(rollbackTransactionSession);
const rollbackBaseDocument = JSON.parse(readFileSync(rollbackMainPath, 'utf8'));
const rollbackReplacement = replacementFor('prepared-rollback-replacement', 'Uncommitted question');
rollbackStore.prepareTruncateAnchorRebase(
  rollbackTransactionSession,
  rollbackHistory[0].id,
  rollbackReplacement
);
const restartedRollbackStore = edit.createEditStore();
const rollbackRecovery = restartedRollbackStore.recoverPrepared(
  rollbackTransactionSession,
  eventSession(rollbackTransactionSession, [])
);
check('restart recovery rolls back when the replacement is absent', rollbackRecovery.ok === true
  && rollbackRecovery.action === 'rolled-back'
  && JSON.stringify(JSON.parse(readFileSync(rollbackMainPath, 'utf8')).edits)
    === JSON.stringify(rollbackBaseDocument.edits)
  && restartedRollbackStore.editsFor(rollbackTransactionSession)[0]?.messageId === rollbackHistory[0].id
  && !existsSync(edit.editTransactionPath(rollbackTransactionSession)));

const unreadableHistory = transactionHistory('unreadable');
const unreadableStore = edit.createEditStore({
  restore: false,
  save() {},
  savePrepared() {},
  clearPrepared() { return true; }
});
unreadableStore.truncateAfter('prepared-unreadable', unreadableHistory, {
  messageIndex: 0,
  messageId: unreadableHistory[0].id,
  expected: 'Retained question'
});
const unreadablePrepared = unreadableStore.prepareTruncateAnchorRebase(
  'prepared-unreadable',
  unreadableHistory[0].id,
  replacementFor('unreadable-replacement', 'Unreadable replacement')
);
const unreadableRecovery = unreadableStore.recoverPrepared('prepared-unreadable', {
  id: 'prepared-unreadable',
  surface: { nodes: [0] }
});
check('recovery refuses a surface whose events cannot be inspected', unreadableRecovery.ok === false
  && /neither a readable surface nor an enumerable event log/u.test(unreadableRecovery.reason)
  && unreadableStore.clear('prepared-unreadable').ok === false);
check('an unreadable recovery leaves the prepared transaction available to its owner',
  unreadablePrepared.rollback().ok === true);

const memoryMain = new Map();
const memoryJournals = new Map();
const memoryStore = edit.createEditStore({
  restore: false,
  save(sessionId, state) { memoryMain.set(sessionId, { edits: [...state.edits] }); },
  savePrepared(sessionId, transaction) {
    if (memoryJournals.has(sessionId)) throw new Error('duplicate prepared transaction');
    memoryJournals.set(sessionId, transaction);
  },
  loadPrepared(sessionId) {
    return { transaction: memoryJournals.get(sessionId), problems: [], present: memoryJournals.has(sessionId) };
  },
  clearPrepared(sessionId, transactionId) {
    if (memoryJournals.get(sessionId)?.id !== transactionId) return false;
    memoryJournals.delete(sessionId);
    return true;
  }
});
const observerSession = 'prepared-observer';
const observerHistory = transactionHistory('observer');
const observerTruncate = memoryStore.truncateAfter(observerSession, observerHistory, {
  messageIndex: 0,
  messageId: observerHistory[0].id,
  expected: 'Retained question'
});
const observerReplacement = replacementFor('observer-replacement', 'Observer-safe question');
const observerPrepared = memoryStore.prepareTruncateAnchorRebase(
  observerSession,
  observerHistory[0].id,
  observerReplacement
);
const observerRefusals = [
  memoryStore.record(observerSession, observerHistory[0], 'mutated', { messageIndex: 0 }),
  memoryStore.deleteTurn(observerSession, observerHistory, { messageIndex: 0 }),
  memoryStore.deleteMessage(observerSession, observerHistory, { messageIndex: 1 }),
  memoryStore.truncateAfter(observerSession, observerHistory, { messageIndex: 0 }),
  memoryStore.prepareTruncateAnchorRebase(observerSession, observerHistory[0].id, observerReplacement),
  memoryStore.rebaseTruncateAnchors(observerSession, observerHistory[0].id, observerReplacement),
  memoryStore.remove(observerSession, observerTruncate.edit?.id),
  memoryStore.clear(observerSession),
  memoryStore.recordApplied(observerSession, [{ id: 'observer-write' }])
];
const unrelatedObserverWrite = memoryStore.record(
  'prepared-unrelated',
  userMessage('unrelated-message', text('Unrelated original')),
  'Unrelated edit',
  { messageIndex: 0, messageId: 'unrelated-message' }
);
check('a synchronous append observer is refused by every same-session mutator',
  observerPrepared.ok === true && observerRefusals.every((answer) => answer?.ok === false
    && /pending recovery/u.test(answer.reason)), JSON.stringify(observerRefusals));
check('a pending transaction does not block another session', unrelatedObserverWrite.ok === true);
const observerCommit = observerPrepared.commit();
check('observer reentrancy cannot cause a lost rebase update', observerCommit.ok === true
  && memoryStore.editsFor(observerSession).length === 1
  && memoryStore.editsFor(observerSession)[0]?.messageId === observerReplacement.id);

const secondReplacement = replacementFor('observer-replacement-2', 'Second observer-safe question');
const secondPrepared = memoryStore.prepareTruncateAnchorRebase(
  observerSession,
  observerReplacement.id,
  secondReplacement
);
const staleCommit = observerPrepared.commit();
const staleRollback = observerPrepared.rollback();
check('stale transaction closures cannot settle a newer transaction', secondPrepared.ok === true
  && staleCommit.ok === false && staleRollback.ok === false
  && memoryJournals.get(observerSession)?.id === secondPrepared.transactionId
  && memoryStore.editsFor(observerSession)[0]?.messageId === observerReplacement.id);
check('the current transaction can still settle after stale attempts', secondPrepared.rollback().ok === true
  && !memoryJournals.has(observerSession));

let failCandidateSave = false;
const failureMain = new Map();
const failureJournals = new Map();
const failureStore = edit.createEditStore({
  restore: false,
  save(sessionId, state) {
    if (failCandidateSave) throw new Error('injected main persistence failure');
    failureMain.set(sessionId, { edits: [...state.edits] });
  },
  savePrepared(sessionId, transaction) { failureJournals.set(sessionId, transaction); },
  loadPrepared(sessionId) {
    return { transaction: failureJournals.get(sessionId), problems: [], present: failureJournals.has(sessionId) };
  },
  clearPrepared(sessionId, transactionId) {
    if (failureJournals.get(sessionId)?.id !== transactionId) return false;
    failureJournals.delete(sessionId);
    return true;
  }
});
const failureSession = 'prepared-persistence-failure';
const failureHistory = transactionHistory('failure');
failureStore.truncateAfter(failureSession, failureHistory, {
  messageIndex: 0,
  messageId: failureHistory[0].id,
  expected: 'Retained question'
});
const failureReplacement = replacementFor('failure-replacement', 'Durable replacement');
const failurePrepared = failureStore.prepareTruncateAnchorRebase(
  failureSession,
  failureHistory[0].id,
  failureReplacement
);
failCandidateSave = true;
let candidateSaveError;
try {
  failurePrepared.commit();
} catch (error) {
  candidateSaveError = error;
}
check('candidate persistence failure leaves old memory and the journal pending',
  /injected main persistence failure/u.test(candidateSaveError?.message ?? '')
    && failureStore.editsFor(failureSession)[0]?.messageId === failureHistory[0].id
    && failureJournals.has(failureSession));
check('candidate persistence failure keeps same-session writes locked',
  failureStore.clear(failureSession).ok === false);
failCandidateSave = false;
const recoveredFailure = failureStore.recoverPrepared(
  failureSession,
  eventSession(failureSession, [failureReplacement])
);
check('a failed candidate persistence can be recovered from the durable replacement',
  recoveredFailure.ok === true && recoveredFailure.action === 'committed'
    && failureStore.editsFor(failureSession)[0]?.messageId === failureReplacement.id
    && failureMain.get(failureSession)?.edits[0]?.messageId === failureReplacement.id
    && !failureJournals.has(failureSession));

const cleanupProblems = [];
const cleanupHistory = transactionHistory('cleanup');
const cleanupStore = edit.createEditStore({
  restore: false,
  save() {},
  savePrepared() {},
  clearPrepared() { throw new Error('injected rollback cleanup failure'); },
  onProblem(_sessionId, problem) { cleanupProblems.push(problem); }
});
cleanupStore.truncateAfter('prepared-cleanup', cleanupHistory, {
  messageIndex: 0,
  messageId: cleanupHistory[0].id,
  expected: 'Retained question'
});
const cleanupPrepared = cleanupStore.prepareTruncateAnchorRebase(
  'prepared-cleanup',
  cleanupHistory[0].id,
  replacementFor('cleanup-replacement', 'Cleanup replacement')
);
let cleanupResult;
let cleanupThrew = false;
try {
  cleanupResult = cleanupPrepared.rollback();
} catch {
  cleanupThrew = true;
}
check('rollback cleanup failure is reported without masking an append failure', !cleanupThrew
  && cleanupResult.ok === false
  && /cleanup failure/u.test(cleanupProblems[0] ?? '')
  && cleanupStore.editsFor('prepared-cleanup')[0]?.messageId === cleanupHistory[0].id
  && cleanupStore.recordApplied('prepared-cleanup', []).ok === false);

const wireMain = new Map();
const wireJournals = new Map();
const wireStore = edit.createEditStore({
  restore: false,
  save(sessionId, state) { wireMain.set(sessionId, { edits: [...state.edits] }); },
  savePrepared(sessionId, transaction) { wireJournals.set(sessionId, transaction); },
  loadPrepared(sessionId) {
    return { transaction: wireJournals.get(sessionId), problems: [], present: wireJournals.has(sessionId) };
  },
  clearPrepared(sessionId, transactionId) {
    if (wireJournals.get(sessionId)?.id !== transactionId) return false;
    wireJournals.delete(sessionId);
    return true;
  }
});
const wireSessionId = 'prepared-wire-recovery';
const wireHistory = transactionHistory('wire');
wireStore.truncateAfter(wireSessionId, wireHistory, {
  messageIndex: 0,
  messageId: wireHistory[0].id,
  expected: 'Retained question'
});
const wireReplacement = replacementFor('wire-replacement', 'Wire replacement');
wireStore.prepareTruncateAnchorRebase(wireSessionId, wireHistory[0].id, wireReplacement);
let wireListener;
const fakeWireRoot = {
  on(event, listener) {
    if (event === 'llm/stream') wireListener = listener;
    return () => { wireListener = undefined; };
  }
};
const disposeWire = edit.installWireOverlay(fakeWireRoot, wireStore);
let rewrittenWireRequest;
const wireResult = wireListener.call({
  stream(request) {
    rewrittenWireRequest = request;
    return 'wire-rewritten';
  }
}, {
  sessionId: wireSessionId,
  session: eventSession(wireSessionId, [wireReplacement]),
  messages: [wireReplacement, wireHistory[1], wireHistory[2]]
}, () => 'wire-unchanged');
disposeWire();
check('wire overlay recovers a prepared journal before reading edits', wireResult === 'wire-rewritten'
  && rewrittenWireRequest?.messages.length === 1
  && rewrittenWireRequest.messages[0]?.id === wireReplacement.id
  && wireStore.editsFor(wireSessionId)[0]?.messageId === wireReplacement.id
  && !wireJournals.has(wireSessionId));

console.log(`\n${failures.length === 0 ? 'all edit behaviour tests passed' : `${failures.length} FAILURES: ${failures.join('; ')}`}`);
process.exit(failures.length === 0 ? 0 : 1);
