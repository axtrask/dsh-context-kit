/**
 * The GUI half of the history editor: a button in the page and a channel for it.
 *
 * ## Host and client integration
 *
 * `webServer.tapIndex` inserts the host element and the script from edit-panel.js.
 * `webServer.register` mounts the POST routes using the edit-route.js envelope.
 * Services are resolved through an injected scope, including late mounting.
 *
 * The installed client-module registry also loads this package's `./client`
 * export. That small module reads the public, tab-local `sessions.list` service;
 * the panel refuses editing without its bridge instead of guessing from shared
 * localStorage. No frontend rebuild or replacement of the stock Chat renderer
 * is needed. See docs/editor-effective-view.md for the current boundaries.
 *
 * ## The wire contract
 *
 * `POST /ctxkit.edit/<method>` with `content-type: application/json`:
 *
 * ```json
 * { "type": "client-request", "rpcId": "1", "method": "contextKit.edit.list", "payload": { "sessionId": "session-id" } }
 * ```
 *
 * The response is `{ type: "server-response", rpcId, result: { ok: true, value } }`
 * or `{ ok: false, error: { code, message, details } }`. Six methods exist:
 * `list` (the editable messages), `commit` (apply one replacement), `deleteTurn`
 * (hide one complete human turn), `deleteMessage` (hide one assistant message and
 * its tool-result envelopes), `truncateAfter` (retain one user message and hide the
 * later suffix), and `status` (config + counts). The panel also refreshes on session and transcript changes
 * so closed-panel Chat projections can display the effective text.
 *
 * ## What it deliberately does not do
 *
 * User text and host tool results use durable replacements; supported assistant
 * blocks use the wire store. Each branch keeps its existing editability checks. Lists and commits
 * share the effective projection, while the original audit log is preserved.
 *
 * @module dsh-context-kit/edit-gui
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { engineFor as engineFromBridge } from './edit-bridge.js';
import { createChannelHandler } from './edit-route.js';
import { blockTargets, editableIndex, effectiveEditableIndex, commitToolResultEdit, commitUserEdit, editability, renderEditableList, DURABLE_BRANCH, TOOL_EVENT, WIRE_BRANCH } from './edit-durable.js';
import { cursorBlockIndex, editableTextOf } from './edit.js';
import { editStoreFor } from './edit-bridge.js';
import { createPanelScript } from './edit-panel.js';

/** Log prefix, matching the other modules the kit mounts. */
const PLUGIN_ID = 'edit-gui';

/**
 * File the panel leaves its mounting trail in.
 *
 * WHY A FILE AND NOT ONLY `ctx.logger.warn`. The button shipped invisible TWICE,
 * and both times the diagnosis stalled on the same wall: the server's output goes
 * to a terminal nobody but the user can read, so "it logged a warning" was not a
 * fact anyone could check afterwards. This file is written on every start, is
 * small, and is read with one command:
 *
 *     Get-Content $env:USERPROFILE\.dsh\context-kit\edit-gui.log -Tail 40
 *
 * A diagnostic that cannot be read after the fact is not a diagnostic.
 */
const PANEL_LOG = 'edit-gui.log';

/**
 * Browser channel path.
 *
 * One path segment after the leading slash and nothing else: the host's
 * `CHANNEL_PATTERN` is `/^\/[A-Za-z0-9._~-]+$/`, so a second slash — as in
 * `/ctxkit/edit` — throws `invalid or reserved RPC channel` from
 * `connection.rpc.handle`, and because that happens while the loader entry is
 * being applied, the whole `dcp` row fails to mount and every session on the
 * preset dies at resume. A dot carries the same meaning and is allowed.
 */
export const EDIT_CHANNEL = '/ctxkit.edit';

/** Element id of the host the injected script mounts into. */
const HOST_ID = 'dsh-context-kit-editor';

/** The six methods the browser side may call. */
export const EDIT_METHODS = Object.freeze({
  list: 'contextKit.edit.list',
  commit: 'contextKit.edit.commit',
  deleteTurn: 'contextKit.edit.deleteTurn',
  deleteMessage: 'contextKit.edit.deleteMessage',
  truncateAfter: 'contextKit.edit.truncateAfter',
  status: 'contextKit.edit.status'
});

/**
 * The rules the panel shows and enforces, as data so the label and the check
 * cannot drift apart.
 */
export const EDIT_DOCTRINE = Object.freeze([
  'Your own messages are edited in place: the model receives the new text at the very position the old text had, and every later message stays where it was.',
  'The original stays in the session log. This rewrites what the model is sent, not the record of what happened.',
  'Tool calls and tool results keep their carrier shape and call identity: assistant blocks use the wire overlay, while host tool results use a durable content-only replacement.',
  // This line used to say the assistant branch was "not reachable from this button
  // yet", which was true and is not any more: `commitValue` routes a reply to the wire
  // store, and the overlay applies it to the request the provider is about to see.
  // A promise the panel does not keep is worse than no promise, so it names the
  // difference instead: the reply's edit is real for the model and absent from the log.
  'A reply of the model is applied on the wire: the next request carries your text, while the session log keeps the reply exactly as it was.'
]);

/**
 * Resolve the live session for one browser request.
 *
 * The browser knows which session is on screen, so it sends the id; the server
 * does not guess. `ctx.sessions.get(id)` is the same lookup the shipped agent
 * loop uses (`dsh-agent-loop/lib/index.js:1602`).
 *
 * @param ctx - the plugin context.
 * @param sessionId - the id the browser is displaying.
 * @returns the session, or `undefined`.
 */
function sessionById(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
  const sessions = ctx.get?.('sessions');
  return sessions?.get?.(sessionId);
}

/** One entry as the panel needs it — text, position, and why it may be refused. */
export function panelEntry(entry) {
  const text = typeof entry.text === 'string' ? entry.text : '';
  // THE PREDICATE IS NOT RE-DERIVED HERE. It used to be, from `entry.blocks`, which
  // `editableIndex` fills with the NUMBER of editable texts — so `Array.isArray` was
  // false for every message and the panel refused all of them, its own kind included.
  // `editability` is the same function the commit calls, so what the panel offers and
  // what the log accepts cannot disagree.
  const allowed = editability(entry);
  const targets = (entry.targets ?? blockTargets(entry)).map((target) => ({
    edited: false, changed: false, editStatus: 'none', ...target
  }));
  const hasEditableTarget = targets.some((target) => target.editable === true);
  const editable = allowed.ok === true || hasEditableTarget;
  return {
    seq: entry.seq,
    id: entry.id,
    originSeq: entry.originSeq ?? entry.seq,
    originId: entry.originSeq === undefined ? entry.id : entry.originId,
    edited: entry.edited === true,
    changed: entry.changed === true,
    editStatus: entry.editStatus ?? 'none',
    index: entry.index,
    userIndex: entry.userIndex,
    // The assistant's reply cannot be named by an id in the transcript — the shell's
    // row for it carries `<turn>:<step>` and nothing else — so the browser is told
    // the position as well. Both are `undefined` for a message whose event has no
    // envelope, which is what makes the row-matching test in scripts/test-edit-gui.mjs
    // able to refuse a match instead of inventing one at 0:0.
    turn: entry.turn,
    step: entry.step,
    type: entry.type,
    sourceKind: entry.sourceKind ?? entry.message?.source?.kind,
    directUser: entry.directUser === true,
    text,
    chars: text.length,
    textBlocks: entry.blocks,
    // ONE MESSAGE, SEVERAL EDITABLE BLOCKS. A reply of [reasoning, text] says two things
    // and each of them can be rewritten, so the browser is handed a target per block: the
    // block index, the kind, the words to show and the verdict for that very block. The
    // transcript draws a pencil per target and the row's picker lists them; without this
    // the thinking of such a reply was unreachable from the GUI.
    targets,
    editable,
    branch: allowed.ok === true
      ? allowed.branch
      : (hasEditableTarget ? (entry.type === 'assistant/message' ? WIRE_BRANCH : DURABLE_BRANCH) : undefined),
    reason: editable ? undefined : (targets.find((target) => typeof target.reason === 'string')?.reason ?? allowed.reason)
  };
}

/**
 * The payload every method answers with, plus the doctrine and the config, so the
 * panel needs one call to render itself and its rules.
 *
 * @param ctx - the plugin context.
 * @param engine - the DCP engine (for the resolved editor config).
 * @param sessionId - the session the browser is displaying.
 * @returns the list value.
 */
// Legacy preset engines remain readable while existing installations migrate.
const editorConfig = runtime => runtime?.editorConfig ?? runtime?.dcpConfig?.editor;

/** Host-authoritative mutation gate. Missing agent services are valid on a standalone Host editor. */
function idleRefusal(ctx, engine, sessionId) {
  let agent;
  try { agent = ctx.get?.('agents')?.get?.(sessionId); } catch { agent = undefined; }
  // Legacy preset compositions can expose the scoped agent directly. The Host
  // registry is primary because an engine context is not itself an agent scope.
  if (agent === undefined) {
    try { agent = engine?.ctx?.get?.('agent'); } catch { agent = undefined; }
  }
  return agent?.status !== undefined && agent.status !== 'idle'
    ? 'Generation is running. Stop generation before editing or deleting history.'
    : undefined;
}

/** Recover or discard an interrupted anchor rebase before reading or mutating its store. */
function recoverStore(store, sessionId, session) {
  try {
    const recovered = store?.recoverPrepared?.(sessionId, session);
    return recovered?.ok === false
      ? recovered.reason ?? 'the interrupted history edit could not be recovered'
      : undefined;
  } catch (error) {
    return `the interrupted history edit could not be recovered: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function listValue(ctx, engine, sessionId, storeOverride) {
  const session = sessionById(ctx, sessionId);
  if (session === undefined) {
    return { ok: false, reason: `no live session ${JSON.stringify(sessionId)}; the server does not have it open` };
  }
  const store = storeOverride ?? editStoreFor(sessionId);
  const recovered = recoverStore(store, sessionId, session);
  if (recovered !== undefined) return { ok: false, reason: recovered };
  const edits = editorConfig(engine)?.enabled === true ? store?.editsFor(sessionId) ?? [] : [];
  const rawEntries = editableIndex(session);
  const effectiveEntries = effectiveEditableIndex(session, edits, rawEntries);
  const survivingSeqs = new Set(effectiveEntries.flatMap((entry) => [entry.seq, entry.originSeq]).filter(Number.isInteger));
  const hiddenSeqs = new Set(rawEntries.filter((entry) => !survivingSeqs.has(entry.seq)).map((entry) => entry.seq));
  const deletedTurnSeqs = new Set();
  for (let start = 0; start < rawEntries.length; start += 1) {
    if (rawEntries[start].directUser !== true || !hiddenSeqs.has(rawEntries[start].seq)) continue;
    let end = start + 1;
    while (end < rawEntries.length && rawEntries[end].directUser !== true) end += 1;
    const members = rawEntries.slice(start, end);
    if (members.every((entry) => hiddenSeqs.has(entry.seq))) {
      for (const entry of members) deletedTurnSeqs.add(entry.seq);
    }
    start = end - 1;
  }
  const hiddenIds = new Set(rawEntries.filter((entry) => hiddenSeqs.has(entry.seq) && entry.id !== undefined)
    .map((entry) => String(entry.id)));
  const truncatedIds = new Set();
  for (const edit of edits.filter((candidate) => candidate.kind === 'truncate-after')) {
    const members = Array.isArray(edit.members) ? edit.members : [];
    if (members.length > 0 && members.every((member) => hiddenIds.has(String(member.id)))) {
      for (const member of members) truncatedIds.add(String(member.id));
    }
  }
  const hidden = rawEntries.filter((entry) => hiddenSeqs.has(entry.seq)).map((entry) => ({
    type: entry.type,
    id: entry.id,
    originId: entry.id,
    turn: entry.turn,
    step: entry.step,
    directUser: entry.directUser === true,
    text: typeof entry.text === 'string' ? entry.text : '',
    truncated: entry.id !== undefined && truncatedIds.has(String(entry.id)),
    deletedTurn: deletedTurnSeqs.has(entry.seq),
    deletedMessage: !deletedTurnSeqs.has(entry.seq) && entry.type === 'assistant/message'
  }));
  const entries = effectiveEntries.map(panelEntry);
  const editable = entries.filter((entry) => entry.editable);
  return {
    ok: true,
    sessionId,
    editor: { ...editorConfig(engine) },
    counts: { total: entries.length, editable: editable.length },
    doctrine: EDIT_DOCTRINE,
    /** The last few messages, oldest first, so the panel opens on the live end. */
    entries: entries.slice(-40),
    /** Chat projections include old edited rows outside the panel's window. */
    transcript: entries,
    /** Native Chat rows covered by applied deletion tombstones. */
    hidden,
    listing: renderEditableList(session, { entries })
  };
}

/**
 * Apply one replacement.
 *
 * The browser sends the target it saw (`seq` and `id`) rather than an index, and
 * the entry is re-resolved from the live session here: a stale panel must not be
 * able to edit a different message than the one it displayed. It also sends the
 * BLOCK it opened, when the message offers more than one: `seq` names the message,
 * `block` names which of its blocks is being rewritten.
 *
 * @param ctx - the plugin context.
 * @param engine - the DCP engine.
 * @param payload - `{ sessionId, seq, id, block?, expected?, text?, restore? }`.
 * @returns the commit value, or a promise while a durable append is flushed.
 */
function finishDurableRebase(rebase, success) {
  try {
    const committed = rebase.commit();
    if (committed?.ok === false) {
      return {
        ok: false,
        appended: true,
        reason: `the edit was appended, but its prepared rebase could not be committed: ${committed.reason}; recovery is still required`
      };
    }
    return success;
  } catch (error) {
    return {
      ok: false,
      appended: true,
      reason: `the edit was appended, but its prepared rebase could not be committed: ${String(error?.message ?? error)}; recovery is still required`
    };
  }
}

async function settleDurableRebase(ctx, session, rebase, success) {
  try {
    const sessions = ctx?.get?.('sessions');
    if (typeof sessions?.flush !== 'function') {
      return { ok: false, appended: true, reason: 'the edit was appended, but session durability could not be confirmed; recovery is still required' };
    }
    const flushed = await sessions.flush(session);
    if (flushed !== true) {
      return { ok: false, appended: true, reason: 'the edit was appended, but no session persistence listener confirmed it; recovery is still required' };
    }
  } catch (error) {
    return {
      ok: false,
      appended: true,
      reason: `the edit was appended, but session persistence failed: ${String(error?.message ?? error)}; recovery is still required`
    };
  }
  return finishDurableRebase(rebase, success);
}

function commitValue(ctx, engine, payload, storeOverride) {
  const config = editorConfig(engine);
  if (config?.enabled !== true) {
    return { ok: false, reason: 'the history editor is disabled; enable History Editor in Settings > Plugins' };
  }
  const busy = idleRefusal(ctx, engine, payload?.sessionId);
  if (busy !== undefined) return { ok: false, reason: busy };
  const session = sessionById(ctx, payload?.sessionId);
  if (session === undefined) return { ok: false, reason: `no live session ${JSON.stringify(payload?.sessionId)}` };
  const store = storeOverride ?? editStoreFor(payload?.sessionId);
  const recovered = recoverStore(store, payload?.sessionId, session);
  if (recovered !== undefined) return { ok: false, reason: recovered };
  const entries = effectiveEditableIndex(session, store?.editsFor(payload?.sessionId) ?? []);
  const entry = entries.find((candidate) => Number(candidate.seq) === Number(payload?.seq));
  if (entry === undefined) {
    return { ok: false, reason: `message seq ${String(payload?.seq)} is not on the surface any more; reload the list` };
  }
  if (payload?.id !== undefined && String(entry.id) !== String(payload.id)) {
    return { ok: false, reason: `seq ${String(payload.seq)} now holds a different message (${String(entry.id)}); reload the list` };
  }
  // WHICH BLOCK. A message may offer several targets - a reply of [reasoning, text] offers
  // its thinking and its answer - so the browser names the one it opened the editor on, and
  // the rule is applied to THAT block ({@link editability} with a block index), including
  // its provider-state checks. A payload without `block` keeps the old meaning exactly: the block
  // `entry.text` belongs to, which is the one the panel used to prefill from.
  if (payload?.block !== undefined && payload?.block !== null) {
    if (!Number.isInteger(payload.block) || payload.block < 0) {
      return { ok: false, reason: `block ${JSON.stringify(payload.block)} is not a block index; reload the list` };
    }
  }
  const at = payload?.block === undefined || payload?.block === null ? undefined : payload.block;
  if (payload?.restore === true && (at === undefined || typeof payload.expected !== 'string')) {
    return { ok: false, reason: 'restoring requires an explicit block and the expected current text' };
  }
  const allowed = editability(entry, at);
  if (allowed.ok !== true) return { ok: false, reason: allowed.reason };
  // The text the edit is aimed at is READ OFF THE SELECTED BLOCK, not taken from
  // `entry.text`: for a message with two targets those are different strings, and the
  // store compares this value with the block it rewrites. The default selection is the
  // same `cursorBlockIndex` the store would compute, so the two cannot disagree.
  const blocks = Array.isArray(entry.message?.content) ? entry.message.content : [];
  const cursor = at === undefined ? cursorBlockIndex(entry.message, entry.text) : at;
  const selectedText = editableTextOf(blocks[cursor]);
  const expected = typeof selectedText === 'string' ? selectedText : entry.text;
  if (payload?.expected !== undefined && payload.expected !== expected) {
    return { ok: false, reason: 'the selected text changed since the editor opened; reload the list before saving' };
  }
  // Resolve the origin on the server; a client cannot substitute its own "original".
  const text = payload?.restore === true
    ? entry.targets.find((target) => target.at === cursor)?.originalText
    : payload?.text;
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, reason: payload?.restore === true ? 'the original text is unavailable or empty' : 'the replacement text is empty' };
  }
  if (payload?.restore === true && text === expected) return { ok: false, reason: 'the original text is already restored' };
  if (allowed.branch === WIRE_BRANCH) {
    // The assistant's replies go to the wire store, not the log. Which message the
    // edit is aimed at is named twice on purpose: `messageIndex`/`messageId` are the
    // position it had, and `expected` is the text itself, so a request that has moved
    // on since the panel loaded is refused instead of rewritten at the wrong spot.
    // `blockAt` is the third name, and the one that survives two blocks holding the
    // same string: the store must rewrite the block the panel opened, not the first
    // one whose text matches.
    if (store === undefined) {
      return { ok: false, reason: 'no wire store is mounted for this session, so an assistant edit has nowhere to go; reload the server' };
    }
    const recorded = store.record(String(payload?.sessionId), entry.message, text, {
      messageIndex: entry.effectiveIndex ?? entry.index,
      messageId: entry.id,
      expected,
      blockAt: cursor,
      basis: 'effective'
    });
    if (recorded?.ok !== true) return { ok: false, reason: recorded?.reason ?? 'the wire branch refused the edit' };
    return {
      ok: true,
      report: {
        branch: WIRE_BRANCH,
        seq: entry.seq,
        messageId: entry.id,
        editId: recorded.edit?.id,
        block: cursor,
        before: expected,
        after: text,
        note: 'applied to the next request the provider sees; the session log keeps the original'
      }
    };
  }
  if (entry.type === TOOL_EVENT) {
    // Host tool results have a core-supported, content-only replacement. They are
    // never truncate anchors (only direct user rows are), so this branch must not
    // touch the anchor journal or any other overlay state.
    const result = commitToolResultEdit(session, entry, text, { blockAt: at });
    return result?.ok === true
      ? { ok: true, report: { ...result.report, branch: DURABLE_BRANCH } }
      : { ok: false, reason: result?.reason ?? 'the durable tool-result branch refused the edit' };
  }
  const durableOptions = { blockAt: at, source: { kind: 'plugin:context-kit-editor' } };
  const preview = commitUserEdit(session, entry, text, { ...durableOptions, dryRun: true });
  if (preview?.ok !== true) return { ok: false, reason: preview?.reason ?? 'the durable branch refused the edit' };
  const rebase = store?.prepareTruncateAnchorRebase?.(payload?.sessionId, entry.id, preview.replacement);
  if (rebase?.ok === false) return { ok: false, reason: rebase.reason };
  let result;
  try {
    result = commitUserEdit(session, entry, text, durableOptions);
  } catch (error) {
    rebase?.rollback?.();
    throw error;
  }
  if (result?.ok !== true) {
    rebase?.rollback?.();
    return { ok: false, reason: result?.reason ?? 'the durable branch refused the edit' };
  }
  const success = { ok: true, report: { ...result.report, branch: DURABLE_BRANCH } };
  return rebase === undefined ? success : settleDurableRebase(ctx, session, rebase, success);
}

/** Record an effective-history tombstone for one direct human message and its complete turn. */
function deleteTurnValue(ctx, engine, payload, storeOverride) {
  const config = editorConfig(engine);
  if (config?.enabled !== true) {
    return { ok: false, reason: 'the history editor is disabled; enable History Editor in Settings > Plugins' };
  }
  const busy = idleRefusal(ctx, engine, payload?.sessionId);
  if (busy !== undefined) return { ok: false, reason: busy };
  const session = sessionById(ctx, payload?.sessionId);
  if (session === undefined) return { ok: false, reason: `no live session ${JSON.stringify(payload?.sessionId)}` };
  const store = storeOverride ?? editStoreFor(payload?.sessionId);
  if (store === undefined) {
    return { ok: false, reason: 'no wire store is mounted for this session, so the turn cannot be deleted; reload the server' };
  }
  const recovered = recoverStore(store, payload?.sessionId, session);
  if (recovered !== undefined) return { ok: false, reason: recovered };
  const entries = effectiveEditableIndex(session, store.editsFor(payload?.sessionId) ?? []);
  const at = entries.findIndex((candidate) => Number(candidate.seq) === Number(payload?.seq));
  if (at < 0) {
    return { ok: false, reason: `message seq ${String(payload?.seq)} is not on the surface any more; reload the list` };
  }
  const entry = entries[at];
  if (payload?.id !== undefined && String(entry.id) !== String(payload.id)) {
    return { ok: false, reason: `seq ${String(payload.seq)} now holds a different message (${String(entry.id)}); reload the list` };
  }
  if (entry.directUser !== true) return { ok: false, reason: 'only a direct user message can anchor a turn deletion' };
  if (payload?.expected !== undefined && payload.expected !== entry.text) {
    return { ok: false, reason: 'the selected message changed since deletion was requested; reload the list' };
  }
  const messages = entries.map((candidate) => candidate.message);
  const recorded = store.deleteTurn(String(payload.sessionId), messages, {
    messageIndex: at,
    messageId: entry.id,
    expected: entry.text
  });
  if (recorded?.ok !== true) return { ok: false, reason: recorded?.reason ?? 'the turn deletion was refused' };
  return {
    ok: true,
    report: {
      branch: WIRE_BRANCH,
      seq: entry.seq,
      messageId: entry.id,
      editId: recorded.edit?.id,
      removedIds: recorded.edit?.members?.map((member) => member.id) ?? [],
      note: 'hidden from the next request the provider sees; the session log keeps the original turn'
    }
  };
}

/** Record an effective-history tombstone for one assistant message and its tool results. */
function deleteMessageValue(ctx, engine, payload, storeOverride) {
  const config = editorConfig(engine);
  if (config?.enabled !== true) {
    return { ok: false, reason: 'the history editor is disabled; enable History Editor in Settings > Plugins' };
  }
  const busy = idleRefusal(ctx, engine, payload?.sessionId);
  if (busy !== undefined) return { ok: false, reason: busy };
  const session = sessionById(ctx, payload?.sessionId);
  if (session === undefined) return { ok: false, reason: `no live session ${JSON.stringify(payload?.sessionId)}` };
  const store = storeOverride ?? editStoreFor(payload?.sessionId);
  if (store === undefined) {
    return { ok: false, reason: 'no wire store is mounted for this session, so the message cannot be deleted; reload the server' };
  }
  const recovered = recoverStore(store, payload?.sessionId, session);
  if (recovered !== undefined) return { ok: false, reason: recovered };
  const entries = effectiveEditableIndex(session, store.editsFor(payload?.sessionId) ?? []);
  const at = entries.findIndex((candidate) => Number(candidate.seq) === Number(payload?.seq));
  if (at < 0) {
    return { ok: false, reason: `message seq ${String(payload?.seq)} is not on the surface any more; reload the list` };
  }
  const entry = entries[at];
  if (payload?.id !== undefined && String(entry.id) !== String(payload.id)) {
    return { ok: false, reason: `seq ${String(payload.seq)} now holds a different message (${String(entry.id)}); reload the list` };
  }
  if (entry.type !== 'assistant/message' || entry.message?.role !== 'assistant') {
    return { ok: false, reason: 'only an assistant message can be deleted with this action' };
  }
  if (payload?.expected !== undefined && payload.expected !== entry.text) {
    return { ok: false, reason: 'the selected message changed since deletion was requested; reload the list' };
  }
  const messages = entries.map((candidate) => candidate.message);
  const recorded = store.deleteMessage(String(payload.sessionId), messages, {
    messageIndex: at,
    messageId: entry.id
  });
  if (recorded?.ok !== true) return { ok: false, reason: recorded?.reason ?? 'the message deletion was refused' };
  return {
    ok: true,
    report: {
      branch: WIRE_BRANCH,
      seq: entry.seq,
      messageId: entry.id,
      editId: recorded.edit?.id,
      removedIds: recorded.edit?.members?.map((member) => member.id) ?? [],
      note: 'hidden from the next request the provider sees; the session log keeps the original message'
    }
  };
}

/** Record a tombstone for the complete effective-history suffix after one retained human message. */
function truncateAfterValue(ctx, engine, payload, storeOverride) {
  const config = editorConfig(engine);
  if (config?.enabled !== true) {
    return { ok: false, reason: 'the history editor is disabled; enable History Editor in Settings > Plugins' };
  }
  const busy = idleRefusal(ctx, engine, payload?.sessionId);
  if (busy !== undefined) return { ok: false, reason: busy };
  const session = sessionById(ctx, payload?.sessionId);
  if (session === undefined) return { ok: false, reason: `no live session ${JSON.stringify(payload?.sessionId)}` };
  const store = storeOverride ?? editStoreFor(payload?.sessionId);
  if (store === undefined) {
    return { ok: false, reason: 'no wire store is mounted for this session, so later history cannot be hidden; reload the server' };
  }
  const recovered = recoverStore(store, payload?.sessionId, session);
  if (recovered !== undefined) return { ok: false, reason: recovered };
  const entries = effectiveEditableIndex(session, store.editsFor(payload?.sessionId) ?? []);
  const at = entries.findIndex((candidate) => Number(candidate.seq) === Number(payload?.seq));
  if (at < 0) {
    return { ok: false, reason: `message seq ${String(payload?.seq)} is not on the surface any more; reload the list` };
  }
  const entry = entries[at];
  if (payload?.id !== undefined && String(entry.id) !== String(payload.id)) {
    return { ok: false, reason: `seq ${String(payload.seq)} now holds a different message (${String(entry.id)}); reload the list` };
  }
  if (entry.directUser !== true) return { ok: false, reason: 'only a direct user message can be the retained history boundary' };
  if (payload?.expected !== undefined && payload.expected !== entry.text) {
    return { ok: false, reason: 'the retained message changed since truncation was requested; reload the list' };
  }
  const messages = entries.map((candidate) => candidate.message);
  const recorded = store.truncateAfter(String(payload.sessionId), messages, {
    messageIndex: at,
    messageId: entry.id,
    expected: entry.text
  });
  if (recorded?.ok !== true) return { ok: false, reason: recorded?.reason ?? 'the history truncation was refused' };
  return {
    ok: true,
    report: {
      branch: WIRE_BRANCH,
      seq: entry.seq,
      messageId: entry.id,
      editId: recorded.edit?.id,
      removedIds: recorded.edit?.members?.map((member) => member.id) ?? [],
      note: 'kept this message and hid all later history from the next request the provider sees; the session log is unchanged'
    }
  };
}

/**
 * Mount the channel and the button.
 *
 * ## Why this waits for the services instead of reading them once
 *
 * The first version read `ctx.get('connection')` and `ctx.get('webServer')`
 * immediately and returned `undefined` when either was missing. It was written
 * against a live server where `ctx.get('commands')` resolved, so reading a
 * service looked like it always works. It does not: this row is a preset ROW,
 * and a preset is mounted while the deployment is still starting, so the two
 * host services can be absent at that instant. `ctx.get` returns `undefined`
 * for a service that is not (yet) provided — it does not throw and it does not
 * retry — so the guard took the "headless composition" branch on a Web server
 * and the button silently did not exist: no route (the channel path answered
 * 405 from the static fallback) and no tap (the served page never contained the
 * host element). Nothing in any log pointed at this module.
 *
 * `ctx.inject([names], callback)` (`cordis/lib/index.js:1599`) is the seam that
 * removes the race: it starts a CHILD fiber whose declared services must all be
 * present, and cordis runs the callback when they are — immediately when they
 * already are, and again if a provider reloads. The child fiber belongs to the
 * caller's fiber, so it is disposed with the plugin.
 *
 * Both services stay OPTIONAL: a deployment with no Web surface (headless, ACP)
 * provides neither, the injected fiber stays inactive forever, and there is no
 * button. That is the same outcome as before, reached without assuming the
 * question "is there a Web surface?" can be answered at mount time.
 *
 * ## Two ways in, one of them without an engine
 *
 * Mounted from inside the `dcp` row (an agent preset), this call resolves nothing:
 * the measured trail ends at `inject:asking` and the injected callback never runs,
 * because the Web-plane services are not reachable from a preset's realm. That is
 * why the button is mounted by a HOST-PLANE row instead — see
 * `lib/edit-host.js` and `lib/edit-bridge.js`. In that mode there is no engine to
 * pass, and every request resolves one through the bridge.
 *
 * @param ctx - the plugin context.
 * @param engine - the DCP engine, when the caller has one; otherwise `undefined`
 *   and engines are resolved per request.
 * @param editStore - the caller's shared store, when the engine is bound directly.
 * @returns a disposer, or `undefined` when nothing was mounted synchronously.
 */
export function installEditGui(ctx, engine, editStore) {
  // The disposer is registered through a FUNCTION rather than through a context
  // object, because the injected context is a service proxy: cordis's `get` trap
  // answers only for the services named in `inject` and throws
  // `cannot get property "…" without inject` for everything else — including a
  // core method like `effect`. Passing the raw context (or its own `effect`) in
  // keeps the registration on a real Context, where the method exists.
  //
  // `owner` IS NOT INTERCHANGEABLE WITH `ctx`, AND THAT COST A BOOT. The channel is
  // registered by `connection.rpc.handle`, which does
  // `owner.effect(() => owner.webServer.register(route))`
  // (`dsh-client-connection/lib/index.js:618`) where `owner` is the context that
  // READ the connection. An owner that cannot itself see `webServer` throws
  // `cannot get property "webServer" without inject` out of the registration, and
  // because that happens while the loader entry is applied, the whole plugin tree
  // fails to load. So the owner must be a context where BOTH services are visible —
  // the injected scope when there is one, the raw context when the caller already
  // had them.
  const mount = (register, owner, connection, webServer) => {
    // The channel is registered on the SERVER directly, not through
    // `connection.rpc.handle` — see `lib/edit-route.js` for the three boot failures
    // that made that seam unusable from a plugin row. The wire contract is the
    // same one the connection speaks, built from the schemas it exports.
    void owner;
    const disposeChannel = webServer.register({
      kind: 'prefix',
      path: EDIT_CHANNEL,
      handler: createChannelHandler(EDIT_CHANNEL, (method, payload) => {
      const sessionId = payload?.sessionId;
      if (method === EDIT_METHODS.list) return listValue(ctx, requestEngine(sessionId), sessionId, requestStore(sessionId));
      if (method === EDIT_METHODS.commit) return commitValue(ctx, requestEngine(sessionId), payload, requestStore(sessionId));
      if (method === EDIT_METHODS.deleteTurn) return deleteTurnValue(ctx, requestEngine(sessionId), payload, requestStore(sessionId));
      if (method === EDIT_METHODS.deleteMessage) return deleteMessageValue(ctx, requestEngine(sessionId), payload, requestStore(sessionId));
      if (method === EDIT_METHODS.truncateAfter) return truncateAfterValue(ctx, requestEngine(sessionId), payload, requestStore(sessionId));
      if (method === EDIT_METHODS.status) {
        const active = requestEngine(sessionId);
        const session = sessionById(ctx, sessionId);
        return {
          ok: true,
          enabled: editorConfig(active)?.enabled === true,
          requireIdle: true,
          engine: 'mounted',
          messages: session === undefined ? 0 : editableIndex(session).length
        };
      }
      return { ok: false, reason: `unknown method ${JSON.stringify(method)}` };
      }, connection)
    });

    const disposeTap = webServer.tapIndex((html) => injectEditor(html));
    // The channel already owns an `owner.effect`, so releasing it needs no
    // second registration; the tap is a plain disposer. One effect releases both
    // and is itself the mount's disposer, so a reload of this plugin takes the
    // channel switch and the button away together.
    return register('context-kit: history editor GUI', () => {
      try { disposeChannel?.(); } catch { /* already released with the fiber */ }
      try { disposeTap?.(); } catch { /* already released with the fiber */ }
    });
  };

  const register = (label, disposer) => ctx.effect(() => disposer, label);
  // `usable*` rather than a bare `!== undefined`: a name that resolves to
  // something which cannot carry a channel or a tap is the same situation as a
  // name that resolves to nothing, and both must fall through to the injected
  // path instead of throwing inside `mount`.
  const connection = usableConnection(probeService(ctx, 'connection'));
  const webServer = usableWebServer(probeService(ctx, 'webServer'));
  // THE ENGINE IS RESOLVED PER REQUEST, NOT CAPTURED HERE.
  //
  // This module is mounted from two different places. When the composition can
  // see the Web services (the top level of a Web profile), `engine` is the engine
  // the mounting row was given. When it cannot (inside an agent preset, which is
  // where the DCP row lives), the panel is mounted by a host-plane row that has no
  // engine of its own and gets it from `lib/edit-bridge.js` — the one channel two
  // realms share, because both import the same module file.
  //
  // A request that arrives before any engine is published is REFUSED, not guessed
  // at: the panel must never edit a conversation it cannot name.
  const requestEngine = (sessionId) => {
    const bound = engine;
    if (bound !== undefined) return bound;
    const bridged = engineFromBridge(sessionId);
    if (bridged === undefined) {
      throw new Error(`History Editor is not mounted for session ${JSON.stringify(sessionId)}; enable its plugin in this profile`);
    }
    return bridged;
  };
  const requestStore = (sessionId) => editStore ?? editStoreFor(sessionId);
  record(ctx, 'install', {
    connection: connection === undefined ? 'no' : 'yes',
    webServer: webServer === undefined ? 'no' : 'yes',
    canInject: typeof ctx?.inject === 'function'
  });
  if (connection !== undefined && webServer !== undefined) return mount(register, ctx, connection, webServer);
  // Not a Web composition, or the host services are still coming up. Injecting on
  // a child fiber answers the second case: the callback runs the moment all of
  // them are provided, which for a Web server is immediately after startup, and
  // never in a composition that has no Web surface at all.
  //
  // THE CALLER MUST TREAT THIS AS OPTIONAL. `ctx.inject` resolves its
  // requirements against the scope this row is mounted in, and this row lives
  // inside an agent preset's realm — where the Web-plane services are not
  // reachable. The requirement then fails the child fiber and reports
  // `cannot get property "webServer" without inject`, which would fail the whole
  // `dcp` loader entry and leave every session on the preset unable to mount. The
  // services are therefore read from the context cordis hands the callback, and
  // the call site in `dcp.js` keeps a guard so a dead panel can never be a dead
  // engine.
  if (typeof ctx?.inject === 'function') {
    record(ctx, 'inject:asking');
    ctx.inject(['connection', 'webServer'], (injected) => {
      const injectedConnection = usableConnection(serviceOn(injected, 'connection'));
      const injectedWebServer = usableWebServer(serviceOn(injected, 'webServer'));
      record(ctx, 'inject:ran', {
        connection: injectedConnection === undefined ? 'no' : 'yes',
        webServer: injectedWebServer === undefined ? 'no' : 'yes'
      });
      // The direct HTTP route still delegates Host and browser-auth policy to the
      // connection service before it reads the request body.
      if (injectedConnection === undefined || injectedWebServer === undefined) {
        warn(ctx, 'the injected scope did not expose connection and webServer, so there is no button');
        return;
      }
      try {
        mount(register, injected, injectedConnection, injectedWebServer);
        record(ctx, 'mount:done');
      } catch (error) {
        warn(ctx, `the mount failed: ${String(error?.message ?? error)}`);
      }
    });
  }
  // A no-op disposer, NOT `undefined`. The caller is a `yield` inside a cordis
  // generator effect, and `Fiber._execute` rejects a non-null, non-function yield
  // with `TypeError: Invalid effect` (`cordis/lib/index.js:1139`) — which would fail
  // the whole effect and take the DCP commands down with it. Nothing is mounted
  // yet, so there is nothing to release here; the injected child fiber owns
  // whatever the deferred mount registers, and disposing the plugin disposes it.
  return () => {};
}

/**
 * Probe for a service on a context where reading it may THROW.
 *
 * `ctx.get(name)` is a service resolution, not a lookup: outside the scope that
 * owns the service, cordis answers it with `cannot get property "name" without
 * inject` rather than `undefined`. Probing therefore has to treat "cannot see
 * it" and "not there" as the same answer — otherwise the probe itself becomes
 * the failure it was written to avoid.
 *
 * `get` is tried first because it is the shape a real context and every test
 * double share; the property read is the fallback for a plain object with a
 * service attached.
 *
 * @param ctx - the plugin context.
 * @param name - the service name.
 * @returns the service, or `undefined` when this context cannot see it.
 */
function probeService(ctx, name) {
  try {
    const viaGet = ctx?.get?.(name);
    if (viaGet !== undefined) return viaGet;
  } catch {
    return undefined;
  }
  try {
    return ctx?.[name];
  } catch {
    return undefined;
  }
}

/**
 * Read one service from a context handed back by `ctx.inject`.
 *
 * @param injected - the context the injected callback received, if any.
 * @param name - the service name.
 * @returns the service, or `undefined` when this context cannot see it.
 */
function serviceOn(injected, name) {
  return injected === undefined ? undefined : probeService(injected, name);
}

/**
 * A `connection` that can actually carry the panel's channel.
 *
 * The panel needs one method, and asking for it by name is the difference between
 * a refusal it can explain and a `TypeError` about `undefined.rpc` that reads like
 * a bug in this module. A service that resolves to something else entirely — a
 * number, a proxy that answers for every key — is not a connection.
 *
 * @param value - whatever the scope answered with.
 * @returns the connection, or `undefined` when it cannot carry a channel.
 */
function usableConnection(value) {
  return typeof value?.requestRejection === 'function' ? value : undefined;
}

/**
 * The owner the connection's channel registration needs.
 *
 * `register` ends with `owner.effect(() => owner.webServer.register(route))`, so
 * the owner has to answer three things through a cordis context: `effect`, and
 * `webServer` **from inside that effect body**. Getting there took three failed
 * boots, each a different symptom of the same mismatch:
 *
 * - the loader entry's own context answers `effect` but not `webServer`
 *   (`cannot get property "webServer" without inject`);
 * - the injected scope answers `webServer` but not `effect`;
 * - the connection's own context answers neither (`cannot get property "register"
 *   without inject`, because a service is only reachable from a scope that
 *   publishes it — and `get('webServer')` on a foreign context bypasses that).
 *
 * This object is that owner, and it is deliberately small: `effect` runs the body
 * immediately and collects whatever it returns as the disposer. That is what
 * cordis does for a synchronous effect (`Fiber._execute`,
 * `cordis/lib/index.js:1134-1152`), minus the fiber bookkeeping — and the
 * registration does not need the bookkeeping, because the disposer it returns is
 * the same one the panel releases when the plugin goes away.
 *
 * @param webServer - the web server service, read from a context that can see it.
 * @returns an owner for `connection.rpc.handle`.
 */
function registerService(webServer) {
  return {
    webServer,
    effect: (body) => {
      const dispose = body();
      return typeof dispose === 'function' ? dispose : () => {};
    }
  };
}

/**
 * A `webServer` that can actually take an index tap.
 *
 * @param value - whatever the scope answered with.
 * @returns the web server, or `undefined` when it cannot take a tap.
 */
function usableWebServer(value) {
  return typeof value?.tapIndex === 'function' ? value : undefined;
}

/**
 * The channel registry, read so that the connection resolves its OWN services.
 *
 * `connection.rpc` is a getter whose body is `const owner = this.ctx` — the
 * context that READ the service — and the registration then does
 * `owner.effect(() => owner.webServer.register(route))`
 * (`dsh-client-connection/lib/index.js:540-546`, `:618`). Read through the
 * traceable wrapper cordis hands a consumer, `this.ctx` is the CONSUMER's
 * context, so `owner.webServer` is resolved against a scope that may not declare
 * it; the result is `cannot get property "webServer" without inject` thrown out of
 * the registration, which fails the whole loader entry.
 *
 * Reading the getter with the service itself as `this` keeps the registration on
 * the provider's own context — the one that owns both the channel registry and
 * the server the route is mounted on.
 *
 * @param connection - the connection service, wrapped or raw.
 * @param fallbackOwner - the context to use when the raw service is unreachable.
 * @returns an object with `handle`, or a stub that throws when neither works.
 */
function connectionRpc(connection, fallbackOwner) {
  // `connection.ctx` is a plain property that cordis's traceable wrapper answers
  // with the context the getter should run against — the provider's own. Reading
  // `rpc` with that as `this` is what keeps the channel on the web server the
  // connection was built for.
  const raw = connection?.ctx;
  try {
    if (raw !== undefined) {
      const viaRaw = Reflect.get(connection, 'rpc', raw);
      if (typeof viaRaw?.handle === 'function') return viaRaw;
    }
  } catch {
    /* fall through to the wrapped read */
  }
  try {
    const wrapped = connection?.rpc;
    if (typeof wrapped?.handle === 'function') return wrapped;
  } catch {
    /* fall through to the refusal below */
  }
  void fallbackOwner;
  throw new Error('the connection service does not expose an rpc channel registry');
}

/**
 * Say why there is no button, without becoming the reason there is none.
 *
 * This module has twice shipped a button that did not exist and reported nothing,
 * and both times the silence cost a release: a lambda cordis never called, and a
 * service the row's realm could not reach. A missing button is an acceptable
 * outcome; an unexplained one is not. The logger is reached through the plugin
 * context, and the call is wrapped because a diagnostic must never throw.
 *
 * @param ctx - the plugin context.
 * @param reason - one sentence, shown as-is.
 */
function warn(ctx, reason) {
  try {
    ctx?.logger?.warn?.(`${PLUGIN_ID}: the history editor panel is unavailable — ${reason}`);
  } catch {
    /* a diagnostic must not become the failure */
  }
  record(ctx, 'unavailable', { reason });
}

/**
 * Append one line to the panel's trail, and never throw while doing it.
 *
 * @param ctx - the plugin context, for the harness home and the logger.
 * @param stage - where the panel is: `install`, `inject:asking`, `inject:ran`,
 *   `mount:done`, `unavailable`.
 * @param detail - flat facts about that stage.
 */
function record(ctx, stage, detail) {
  const line = `${new Date().toISOString()} ${stage} ${JSON.stringify(detail ?? {})}\n`;
  try {
    const home = ctx?.get?.('dshHome') ?? process.env.DSH_HOME;
    if (typeof home === 'string' && home.length > 0) {
      const dir = join(home, 'context-kit');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, PANEL_LOG), line);
    }
  } catch {
    /* the trail must never be the reason the panel fails */
  }
}

/**
 * Insert the launcher host into the boot page.
 *
 * Pure html-to-html, as `tapIndex` requires. The script is inline rather than a
 * separate route on purpose: one artifact to keep consistent, and it means the
 * button cannot be half-loaded when the page is served from cache.
 *
 * @param html - the rendered index body.
 * @returns the body with the host inserted, or the body unchanged when it is not html.
 */
export function injectEditor(html) {
  if (typeof html !== 'string' || html.length === 0) return html;
  if (html.includes(HOST_ID)) return html; // idempotent: a second tap must not double-mount
  if (!/<\/body>/iu.test(html)) return html;
  return html.replace(/<\/body>/iu, `${editorHost()}</body>`);
}

/** The host element plus the panel script, as one string. */
function editorHost() {
  return `<div id="${HOST_ID}" data-context-kit="editor"></div>\n<script type="module">${PANEL_SCRIPT}</script>\n`;
}

/**
 * The browser half.
 *
 * Written as one closed-shadow-root component so it cannot collide with the
 * app's own CSS and cannot be styled by it. No framework and no import: the boot
 * page is served without a module map for this code, so anything else would be a
 * second failure mode on top of the feature itself.
 */
const PANEL_SCRIPT = createPanelScript(EDIT_CHANNEL);

/**
 * Where the browser shell keeps the session it is displaying.
 *
 * Verified live in the running GUI: the page stays on `/`, so the id is not a path
 * segment, and `window.localStorage['dsh.sessions.current']` holds a bare uuid that
 * changes when the sidebar selection changes. Exported as the one place to change
 * if the shell ever moves it.
 */
export const SESSION_KEY = 'dsh.sessions.current';
