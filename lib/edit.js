/**
 * Editing chat history — the shared half of the hybrid.
 *
 * The requirement: edit the user's own messages **and** the assistant's replies,
 * so the edited text is what the provider receives, **without deleting what
 * follows**. In opencode an edit cuts the tail; that is not acceptable here, and
 * in DSH it is free — the surface fold is positional
 * (`dsh-session/lib/types/surface.js:370-377`), so replacing one slot leaves the
 * rest of the ordered list alone.
 *
 * Two ways to land an edit, one code path (see `docs/edit-feature.md` §2b):
 *
 * - **durable (`commitDurableInPlace`)** — an ordinary replacement event in the
 *   session log. Legal for a `user/message` carrier today; legal for an
 *   `assistant/message` carrier only when the core ban is lifted (patched or
 *   rebuilt `dsh-session`). Survives restart, forks and export.
 * - **wire overlay (`planWireRewrite`, below)** — the request is rebuilt on its
 *   way to the provider through the `llm/stream` waterfall. Works for both roles
 *   on the **unpatched** core because it never touches a node carrier. The log
 *   stays byte-identical, so the edit lives in plugin state and must be persisted
 *   here, exactly the model upstream DCP uses.
 *
 * What is shared by both: the edit record, the anchor that finds the message
 * again, the validation that refuses an impossible edit, and the diff.
 *
 * ANCHORS ARE PROVISIONAL. A raw message index is wrong the moment the surface
 * changes (a compress landing above the edit, a prune materializing, `decompress`
 * re-appending a tail, a new turn). So an anchor records what was at the index —
 * role and the exact block shape — and {@link findAnchoredIndex} re-finds it by
 * comparing text. If the comparison fails, the edit is **refused and reported**,
 * never applied to whatever now sits at that index. Silent misapplication is the
 * failure mode this file exists to prevent.
 *
 * The rewrite is deliberately additive in strictness: an edit may only replace the
 * text of block kinds `text`, `tool-call` and `tool-result`, and may never change
 * the number of blocks, their order, their kinds or a `toolCallId`. That is what
 * keeps tool pairing intact
 * (`dsh-compaction/lib/types/tool-pairing.js` throws
 * `tool/result at surface seq N has no matching tool-call (corrupt surface)`
 * otherwise) — the invariant is structural here, not a rule someone has to
 * remember.
 *
 * @module dsh-context-kit/edit
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dshHome } from './common.js';

/* --------------------------------------------------------------- vocabulary */

/**
 * The block kinds an edit may rewrite the text of.
 *
 * `reasoning` is the model's own chain of thought. Signed, non-redacted reasoning is
 * editable: rewriting its text also removes stale signature metadata from the visible
 * and replay-state blocks. Redacted reasoning remains uneditable because its visible
 * text is not the payload the provider received; {@link signedReasoningRefusal} enforces
 * that restriction at both the record and apply ends.
 */
export const EDITABLE_BLOCK_KINDS = ['text', 'tool-call', 'tool-result', 'reasoning'];

/** What a single edit changes. */
export const EDIT_SCOPE = { TEXT: 'text', ARGS: 'toolArguments' };

/** Persisted wire-overlay record that removes one complete conversational turn. */
export const DELETE_TURN_KIND = 'delete-turn';

/** Persisted wire-overlay record that removes one assistant envelope and its tool results. */
export const DELETE_MESSAGE_KIND = 'delete-message';

/** Persisted wire-overlay record that keeps one user message and removes everything after it. */
export const TRUNCATE_AFTER_KIND = 'truncate-after';

/* ------------------------------------------------------------- text blocks */

/**
 * The single editable text of a block, or `undefined` when the block is not
 * editable. A `tool-call` carries its `arguments` string; a `tool-result` carries
 * the concatenation of every string-valued nested text item. A result with no such
 * item has no editable text, rather than pretending to contain an empty string.
 *
 * @param block - a content block from an outgoing message.
 * @returns the current text when the block may be edited.
 */
export function editableTextOf(block) {
  if (block === null || typeof block !== 'object') return undefined;
  if (block.type === 'text') return typeof block.text === 'string' ? block.text : undefined;
  // The model's thinking, as the harness carries it: one text field, exactly like a
  // text block. Whether this PARTICULAR block may be rewritten is a separate question
  // with a separate answer ({@link signedReasoningRefusal}) — "what text does this
  // block hold" and "is that text available rather than redacted" are not the same
  // question, and merging them here would report an uneditable block as an empty one.
  if (block.type === 'reasoning') return typeof block.text === 'string' ? block.text : undefined;
  if (block.type === 'tool-call') {
    return typeof block.arguments === 'string' ? block.arguments : undefined;
  }
  if (block.type === 'tool-result') {
    const nested = Array.isArray(block.content)
      ? block.content.filter((item) => item?.type === 'text' && typeof item.text === 'string')
      : [];
    return nested.length === 0 ? undefined : nested.map((item) => item.text).join('');
  }
  return undefined;
}

/** The fields a signed reasoning block may carry ON THE BLOCK ITSELF. */
const REASONING_SIGNATURE_FIELDS = ['signature', 'thinkingSignature', 'thoughtSignature', 'textSignature'];

/** Whether a block carries a signature field of its own. */
function blockHasSignature(block) {
  return REASONING_SIGNATURE_FIELDS.some((field) => typeof block?.[field] === 'string' && block[field].length > 0);
}

/** Whether a block carries unavailable provider state rather than editable reasoning text. */
function blockIsRedacted(block) {
  return block?.redacted !== undefined && block.redacted !== false;
}

/** Whether one reasoning block has signed or redacted provider state, on either carrier. */
export function reasoningHasSignature(message, blockIndex) {
  const block = Array.isArray(message?.content) ? message.content[blockIndex] : undefined;
  if (block?.type !== 'reasoning') return false;
  const replay = Array.isArray(message?.source?.replayState?.blocks)
    ? message.source.replayState.blocks[blockIndex]
    : undefined;
  return blockIsRedacted(block) || blockHasSignature(block)
    || (replay?.type === 'reasoning' && (blockIsRedacted(replay) || blockHasSignature(replay)));
}

/**
 * Why one reasoning block cannot be rewritten safely.
 *
 * Provider signatures are stale as soon as their reasoning text changes, so the rewrite
 * removes them from both the visible block and the matching replay-state block. Redacted
 * reasoning is different: its visible text is not the payload the provider received, and
 * no safe replacement can be constructed from it. Only that shape remains uneditable.
 *
 * @param message - the message the block belongs to (its `source.replayState` matters).
 * @param blockIndex - the block cursor the edit would land on.
 * @returns the reason it may not be edited, or `undefined` when it may.
 */
export function signedReasoningRefusal(message, blockIndex) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const block = blocks[blockIndex];
  if (block?.type !== 'reasoning') return undefined;
  const replay = message?.source?.replayState;
  const at = Array.isArray(replay?.blocks) ? replay.blocks[blockIndex] : undefined;
  if (blockIsRedacted(block) || (at?.type === 'reasoning' && blockIsRedacted(at))) {
    return 'this reply\'s thinking is redacted, so its text is not what the provider receives';
  }
  return undefined;
}

/**
 * Which block of a message holds the text a surface asked to edit.
 *
 * The same selection {@link createEdit} performs with `expected`, exposed so a caller can
 * name the block an edit will land on BEFORE recording it: the wire branch has to inspect
 * the cursor block for redacted provider state ({@link signedReasoningRefusal}), and
 * inspecting the first block of a message instead of the block the edit will rewrite
 * would clear an edit of one block on the strength of another.
 *
 * @param message - the outgoing message.
 * @param text - the text the caller aims at, or `undefined` for the first editable one.
 * @returns the block index, or -1 when no block of the message holds that text.
 */
export function cursorBlockIndex(message, text) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const candidates = blocks
    .map((block, position) => ({ position, text: editableTextOf(block) }))
    .filter((entry) => entry.text !== undefined);
  if (candidates.length === 0) return -1;
  const found = text === undefined ? candidates[0] : candidates.find((entry) => entry.text === text);
  return found === undefined ? -1 : found.position;
}

/** The payload fields every block carries that identify it and must survive. */
function blockIdentity(block) {
  return {
    type: block.type,
    ...(block.id === undefined ? {} : { id: String(block.id) }),
    ...(block.toolCallId === undefined ? {} : { toolCallId: String(block.toolCallId) }),
    // Keep signature presence as audit metadata without persisting the signature itself.
    // It is deliberately not part of identity: signed, non-redacted reasoning is editable,
    // and its stale signature is stripped when the text is rewritten.
    ...(block.type === 'reasoning' ? { signed: blockHasSignature(block) } : {})
  };
}

function identityKey(block) {
  const id = blockIdentity(block);
  return `${id.type}|${id.id ?? ''}|${id.toolCallId ?? ''}`;
}

/** A plain-text message with no blocks at all, addressed as one implicit text. */
function isBareTextMessage(message) {
  return typeof message?.content === 'string';
}

/**
 * Validate an intended edit against the message it targets.
 *
 * Everything that can make an edit impossible is refused here, with a reason,
 * rather than half-applied later: an unknown index, a target that carries no
 * text, a block-structure change, or an attempt to remove tool calls.
 *
 * @param message - the outgoing message the edit targets.
 * @param edit - the edit record.
 * @returns `{ ok: true, blockIndex }` or `{ ok: false, reason }`.
 */
export function validateEdit(message, edit) {
  if (message === null || typeof message !== 'object') return { ok: false, reason: 'no message at the anchor' };
  if (edit.anchor.role !== message.role) {
    return { ok: false, reason: `role changed: expected ${edit.anchor.role}, found ${message.role}` };
  }
  if (isBareTextMessage(message)) {
    if (edit.anchor.blocks.length !== 0) {
      return { ok: false, reason: 'the message lost its block structure (now plain text)' };
    }
    if (message.content !== edit.before) {
      return { ok: false, reason: 'the text is not the text this edit replaced' };
    }
    return { ok: true, blockIndex: -1 };
  }
  const blocks = Array.isArray(message.content) ? message.content : [];
  if (blocks.length === 0) {
    // An empty message never reaches the provider — `projectMessage` drops it — so an
    // edit anchored to one could never be applied. Refuse at both ends.
    return { ok: false, reason: 'the message is empty and is not part of the request' };
  }
  if (blocks.length !== edit.anchor.blocks.length) {
    return {
      ok: false,
      reason: `block count changed: expected ${edit.anchor.blocks.length}, found ${blocks.length}`
    };
  }
  const at = edit.cursor.block;
  if (!Number.isInteger(at) || at < 0 || at >= blocks.length) {
    return { ok: false, reason: `no block at cursor ${String(at)}` };
  }
  for (let index = 0; index < blocks.length; index += 1) {
    if (identityKey(blocks[index]) !== identityKey(edit.anchor.blocks[index])) {
      return { ok: false, reason: `block ${index} is no longer ${identityKey(edit.anchor.blocks[index])}` };
    }
  }
  const block = blocks[at];
  if (!EDITABLE_BLOCK_KINDS.includes(block.type)) {
    return { ok: false, reason: `a ${block.type} block has no editable text` };
  }
  // Asking "may this be edited" before "is this the text" is deliberate: redacted
  // reasoning is refused for what it IS, and reporting it as changed text would send
  // the user looking for a difference that is not there.
  const reasoningRefusal = signedReasoningRefusal(message, at);
  if (reasoningRefusal !== undefined) return { ok: false, reason: reasoningRefusal };
  if (editableTextOf(block) !== edit.before) {
    return { ok: false, reason: `the text at block ${at} is not the text this edit replaced` };
  }
  if (typeof edit.after !== 'string' || edit.after.length === 0) {
    return { ok: false, reason: 'an edit may not empty a message' };
  }
  return { ok: true, blockIndex: at };
}

/**
 * Apply the edit to one message, returning a NEW message whose content array is
 * new and whose untouched blocks are shared. The input is never mutated: DSH
 * deep-freezes the messages it hands to the waterfall.
 *
 * `tool-call` blocks keep `name` and `id`; `tool-result` blocks keep `toolCallId`
 * and `isError`. Only the text is new, so pairing cannot break.
 *
 * @param message - the outgoing message.
 * @param edit - the edit record.
 * @param blockIndex - the index {@link validateEdit} approved, or -1 for a plain string.
 * @param appliedAt - logical position in this request, recorded for the report.
 * @returns the replacement message, or `undefined` when nothing changed.
 */
export function applyEditToMessage(message, edit, blockIndex, appliedAt) {
  if (blockIndex === -1) {
    // A bare-string message. Spreading it would be a trap: `{ ..."text" }` is an object
    // with one property per character, not a message — the edit would look applied and
    // the provider would receive garbage.
    return { ...message, content: edit.after, appliedAt };
  }
  const blocks = message.content;
  const replay = message.source?.replayState;
  const replayBlockAt = Array.isArray(replay?.blocks) ? replay.blocks[blockIndex] : undefined;
  const target = blocks[blockIndex];
  const signedReasoning = target?.type === 'reasoning'
    && (blockHasSignature(target)
      || (replayBlockAt?.type === 'reasoning' && blockHasSignature(replayBlockAt)));
  if (target?.type === 'tool-result') {
    const inner = Array.isArray(target.content) ? target.content : [];
    if (!inner.some((item) => item?.type === 'text' && typeof item.text === 'string')) return undefined;
  }
  const next = blocks.map((block, index) => {
    if (index !== blockIndex) return block;
    if (block.type === 'text') return { ...block, text: edit.after };
    if (block.type === 'reasoning') {
      // A signature authenticates the old reasoning. Once its text changes, represent
      // the replacement as ordinary assistant text: every provider can replay that,
      // while some APIs silently drop an unsigned native reasoning item.
      if (signedReasoning) return { type: 'text', text: edit.after };
      const rewritten = { ...block, text: edit.after };
      for (const field of REASONING_SIGNATURE_FIELDS) delete rewritten[field];
      return rewritten;
    }
    if (block.type === 'tool-call') return { ...block, arguments: edit.after };
    const inner = Array.isArray(block.content) ? block.content : [];
    let replaced = false;
    const content = [];
    for (const item of inner) {
      if (item?.type !== 'text') {
        content.push(item);
      } else if (!replaced) {
        content.push({ ...item, text: edit.after });
        replaced = true;
      }
    }
    return { ...block, content };
  });
  const replacement = { ...message, content: next, appliedAt };
  if (blocks[blockIndex]?.type !== 'reasoning') return replacement;
  if (!Array.isArray(replay?.blocks) || replayBlockAt === undefined) return replacement;
  const replayBlock = signedReasoning ? { type: 'text' } : { ...replayBlockAt };
  for (const field of REASONING_SIGNATURE_FIELDS) delete replayBlock[field];
  const replayBlocks = replay.blocks.map((block, index) => (index === blockIndex ? replayBlock : block));
  return {
    ...replacement,
    source: { ...message.source, replayState: { ...replay, blocks: replayBlocks } }
  };
}

/* ---------------------------------------------------------------- recording */

/**
 * Build an edit record for a message at `index` in the outgoing request.
 *
 * `expected` picks the block by its TEXT and `blockAt` picks it by its POSITION. The
 * position wins when both are given, and the text is then still checked against it, so
 * a stale panel is refused instead of obeyed. Both exist because neither is enough:
 * a reply of `[reasoning, text]` whose thinking and answer happen to read the same
 * string has that string in two blocks, and `cursorBlockIndex` — which takes the first
 * match — would then rewrite the thinking when the caller aimed at the answer.
 *
 * @param options - session id, the outgoing message, the new text, and optionally
 *   `expected` (the text the edit is aimed at) and `blockAt` (the block index it is
 *   aimed at).
 * @returns `{ ok: true, edit }` or `{ ok: false, reason }`.
 */
export function createEdit({ sessionId, index, message, newText, at, expected, blockAt }) {
  if (typeof newText !== 'string' || newText.length === 0) return { ok: false, reason: 'the new text is empty' };
  if (isBareTextMessage(message)) {
    const before = message.content;
    if (before === newText) return { ok: false, reason: 'the text is unchanged' };
    if (expected !== undefined && before !== expected) {
      return { ok: false, reason: 'the message is not the text this edit was aimed at' };
    }
    return {
      ok: true,
      edit: {
        id: `e${(at ?? 0).toString(36)}`,
        parent: null,
        scope: EDIT_SCOPE.TEXT,
        cursor: { message: index, block: -1 },
        before,
        after: newText,
        at: at ?? 0,
        anchor: messageAnchor(message, index)
      }
    };
  }
  const blocks = Array.isArray(message.content) ? message.content : [];
  if (blocks.length === 0) return { ok: false, reason: 'the message is empty and carries no editable text' };
  const candidates = blocks
    .map((block, position) => ({ position, text: editableTextOf(block) }))
    .filter((entry) => entry.text !== undefined);
  if (candidates.length === 0) return { ok: false, reason: 'the message carries no editable text' };
  // The cursor is chosen by {@link cursorBlockIndex}, which is the same rule the panel's
  // surface consults before it offers the edit — one selection, so the block the panel
  // inspected is the block this commit rewrites. A caller that knows WHICH block it
  // opened names it, and that selection is used instead: by text alone the first block
  // holding the string wins, and two blocks may hold it.
  let position = cursorBlockIndex(message, expected);
  if (Number.isInteger(blockAt)) {
    const explicit = candidates.find((entry) => entry.position === blockAt);
    if (explicit === undefined) return { ok: false, reason: `block ${blockAt} of this message holds no editable text` };
    if (expected !== undefined && explicit.text !== expected) {
      return { ok: false, reason: `the text at block ${blockAt} is not the text this edit was aimed at` };
    }
    position = blockAt;
  }
  if (position === -1) return { ok: false, reason: 'the message does not contain the text this edit was aimed at' };
  // Refused at the RECORD end as well as at the apply end: a store that accepts an edit
  // the wire will refuse produces a saved change that silently never happens.
  const signed = signedReasoningRefusal(message, position);
  if (signed !== undefined) return { ok: false, reason: signed };
  const found = candidates.find((entry) => entry.position === position);
  if (found.text === newText) return { ok: false, reason: 'the text is unchanged' };
  return {
    ok: true,
    edit: {
      id: `e${(at ?? 0).toString(36)}`,
      parent: null,
      scope: EDIT_SCOPE.TEXT,
      cursor: { message: index, block: found.position },
      before: found.text,
      after: newText,
      at: at ?? 0,
      anchor: messageAnchor(message, index)
    }
  };
}

/**
 * Build a persisted tombstone for one human turn.
 *
 * A tombstone is always evaluated against the effective provider history. It keeps
 * the complete text vector as well as the ordinary structural anchor, so a stale
 * panel cannot delete a same-shaped message whose contents changed in the meantime.
 */
export function createTurnDeletion({ messages, index, at, expected }) {
  const list = Array.isArray(messages) ? messages : [];
  const message = list[index];
  if (!startsHumanTurn(message)) return { ok: false, reason: 'only a direct user message can anchor a turn deletion' };
  const texts = canonicalTexts(message);
  const before = texts.join('');
  if (texts.length === 0 || before.length === 0) {
    return { ok: false, reason: 'the user message is empty and cannot anchor a turn deletion' };
  }
  if (expected !== undefined && expected !== before) {
    return { ok: false, reason: 'the message is not the text this deletion was aimed at' };
  }
  let end = index + 1;
  while (end < list.length && !startsHumanTurn(list[end])) end += 1;
  const members = [];
  for (let cursor = index; cursor < end; cursor += 1) {
    const member = deletionSnapshot(list[cursor]);
    if (member === undefined) {
      return { ok: false, reason: `message ${cursor} in this turn has no stable id` };
    }
    members.push(member);
  }
  const next = end < list.length ? deletionSnapshot(list[end]) : null;
  if (end < list.length && next === undefined) {
    return { ok: false, reason: 'the next user message has no stable id' };
  }
  const closure = validateToolClosure(list, index, end);
  if (closure !== undefined) return { ok: false, reason: closure };
  return {
    ok: true,
    edit: {
      kind: DELETE_TURN_KIND,
      id: `d${(at ?? 0).toString(36)}`,
      parent: null,
      basis: 'effective',
      before,
      texts,
      members,
      next,
      at: at ?? 0,
      anchor: messageAnchor(message, index)
    }
  };
}

/**
 * Build a persisted tombstone for exactly one assistant envelope.
 *
 * Tool calls belong to that envelope, so its immediately following tool-result
 * envelopes travel with it. Any missing, duplicated, interleaved, or crossing
 * interaction is refused instead of leaving an invalid provider history.
 */
export function createAssistantDeletion({ messages, index, at, expected }) {
  const list = Array.isArray(messages) ? messages : [];
  const message = list[index];
  if (message?.role !== 'assistant') {
    return { ok: false, reason: 'only an assistant message can anchor a message deletion' };
  }
  const texts = canonicalTexts(message);
  const before = texts.join('');
  if (texts.length === 0 || before.length === 0) {
    return { ok: false, reason: 'the assistant message is empty and cannot anchor a message deletion' };
  }
  if (expected !== undefined && expected !== before) {
    return { ok: false, reason: 'the message is not the text this deletion was aimed at' };
  }
  const group = assistantDeletionEnd(list, index);
  if (group.reason !== undefined) return { ok: false, reason: group.reason };
  const members = [];
  for (let cursor = index; cursor < group.end; cursor += 1) {
    const member = deletionSnapshot(list[cursor]);
    if (member === undefined) {
      return { ok: false, reason: `message ${cursor} in this assistant group has no stable id` };
    }
    members.push(member);
  }
  const next = group.end < list.length ? deletionSnapshot(list[group.end]) : null;
  if (group.end < list.length && next === undefined) {
    return { ok: false, reason: 'the next message boundary has no stable id' };
  }
  return {
    ok: true,
    edit: {
      kind: DELETE_MESSAGE_KIND,
      id: `m${(at ?? 0).toString(36)}`,
      parent: null,
      basis: 'effective',
      before,
      texts,
      members,
      next,
      at: at ?? 0,
      anchor: messageAnchor(message, index)
    }
  };
}

/** Build a tombstone that keeps one direct-user message and removes the whole suffix. */
export function createTruncateAfterDeletion({ messages, index, at, expected }) {
  const list = Array.isArray(messages) ? messages : [];
  const message = list[index];
  if (!startsHumanTurn(message)) {
    return { ok: false, reason: 'only a direct user message can anchor a history truncation' };
  }
  const texts = canonicalTexts(message);
  const before = texts.join('');
  if (texts.length === 0 || before.length === 0) {
    return { ok: false, reason: 'the user message is empty and cannot anchor a history truncation' };
  }
  if (expected !== undefined && expected !== before) {
    return { ok: false, reason: 'the message is not the text this truncation was aimed at' };
  }
  if (index + 1 >= list.length) return { ok: false, reason: 'there is no later history to hide' };
  const members = [];
  for (let cursor = index + 1; cursor < list.length; cursor += 1) {
    const member = deletionSnapshot(list[cursor]);
    if (member === undefined) return { ok: false, reason: `message ${cursor} in the suffix has no stable id` };
    members.push(member);
  }
  const closure = validateToolClosure(list, index + 1, list.length);
  if (closure !== undefined) return { ok: false, reason: closure };
  return {
    ok: true,
    edit: {
      kind: TRUNCATE_AFTER_KIND,
      id: `t${(at ?? 0).toString(36)}`,
      parent: null,
      basis: 'effective',
      before,
      texts,
      members,
      next: null,
      at: at ?? 0,
      anchor: messageAnchor(message, index)
    }
  };
}

/**
 * The provisional anchor for a message: where it was, what role it had, and the
 * identity of every block in order. This is what lets a later request be searched
 * for the same message instead of trusting a stale index.
 *
 * EVERY block is recorded, the model's reasoning included — a reasoning block is part
 * of the shape of the reply, and a message that lost or gained one is not the message
 * the edit was made against. A reasoning block also records whether its visible carrier
 * was signed as audit metadata ({@link blockIdentity}); the signature itself is deliberately
 * not copied, and signature presence is not part of identity.
 */
export function messageAnchor(message, index) {
  const blocks = isBareTextMessage(message) || !Array.isArray(message.content)
    ? []
    : message.content.map(blockIdentity);
  return { index, role: message?.role, blocks };
}

/**
 * The editable texts of a message, canonicalised for comparison.
 *
 * Reasoning counts as text here, and that is what makes two checks agree. The anchor
 * counts BLOCKS, so a reply of [reasoning, text] has an anchor of length 2; before
 * reasoning was editable this function returned 1 for that reply, `findAnchoredIndex`
 * compared the two numbers, and an edit of such a reply could only ever be found at the
 * index it was recorded at — a compress landing above it was enough to lose it.
 */
export function canonicalTexts(message) {
  if (isBareTextMessage(message)) return [message.content];
  if (!Array.isArray(message.content)) return [];
  return message.content.map(editableTextOf).filter((text) => text !== undefined);
}

function anchorMatches(anchor, message) {
  if (anchor.role !== message?.role) return false;
  const texts = canonicalTexts(message);
  return texts.length === anchor.blocks.length;
}

/**
 * How many of an anchor's block identities appear, in order, in a message. Used
 * only when the strict comparison fails, to tell "the message changed above the
 * edit" (recoverable: the cursor block is still there) from "this is a different
 * message" (not recoverable).
 */
function anchorSimilarity(anchor, message) {
  const blocks = isBareTextMessage(message) || !Array.isArray(message.content) ? [] : message.content;
  let shared = 0;
  for (let index = 0; index < Math.min(blocks.length, anchor.blocks.length); index += 1) {
    if (identityKey(blocks[index]) === identityKey(anchor.blocks[index])) shared += 1;
  }
  return { shared, total: anchor.blocks.length };
}

/**
 * Re-find the message an edit targets inside a request, without trusting indices.
 *
 * Two rules, in order:
 *
 * 1. **The recorded index is trusted only when it still holds** the role, block
 *    count and `before` text the edit was made against. That covers both the common
 *    case and the layered case (editing a message that an earlier edit already
 *    rewrote), where the `before` text no longer exists anywhere in the request.
 * 2. Otherwise the request is searched for a message that claims the edit, and the
 *    search must be **unambiguous**: exactly one candidate, or none. When the same
 *    text appears twice — two identical questions in one conversation — the edit is
 *    refused rather than applied to a guess.
 *
 * @param messages - the outgoing request.
 * @param edit - the edit record.
 * @returns `{ index, recovered }` or `{ reason }`.
 */
export function findAnchoredIndex(messages, edit) {
  const { anchor } = edit;
  const claims = (message) => {
    if (anchor.role !== message?.role) return false;
    const texts = canonicalTexts(message);
    if (anchor.blocks.length > 0 && texts.length !== anchor.blocks.length) return false;
    return texts.includes(edit.before);
  };
  const at = anchor.index;
  if (Number.isInteger(at) && at >= 0 && at < messages.length && claims(messages[at])) {
    return { index: at, recovered: false };
  }
  const hits = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (claims(messages[index])) hits.push(index);
  }
  if (hits.length === 1) return { index: hits[0], recovered: true };
  if (hits.length > 1) {
    return { reason: `the replaced text now appears in ${hits.length} messages (${hits.join(', ')}); refusing to guess` };
  }
  // Nothing claims the edit. Distinguish the two reasons a legitimate edit can stop
  // matching, because the user has to be told which one happened.
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== anchor.role) continue;
    const { shared } = anchorSimilarity(anchor, message);
    if (shared > 0) {
      return {
        reason: `the message at index ${index} kept ${shared}/${anchor.blocks.length} block(s) but no longer contains the text this edit replaced`
      };
    }
  }
  return { reason: 'the message this edit replaced is no longer part of the request' };
}

function deletionSnapshot(message) {
  if (message?.id === undefined || message?.id === null || String(message.id).length === 0) return undefined;
  return {
    id: message.id,
    role: message.role,
    sourceKind: message.source?.kind,
    blocks: messageAnchor(message, 0).blocks
  };
}

function sameDeletionSnapshot(message, snapshot) {
  const actual = deletionSnapshot(message);
  if (actual === undefined || snapshot === null || typeof snapshot !== 'object') return false;
  return String(actual.id) === String(snapshot.id)
    && actual.role === snapshot.role
    && actual.sourceKind === snapshot.sourceKind
    && actual.blocks.length === snapshot.blocks?.length
    && actual.blocks.every((block, index) => identityKey(block) === identityKey(snapshot.blocks[index]));
}

function hasToolPairingId(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function invalidToolPairing(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  for (const block of blocks) {
    if (block?.type === 'tool-call' && !hasToolPairingId(block.id)) {
      return 'a tool-call block has no pairing id';
    }
    if (block?.type === 'tool-result' && !hasToolPairingId(block.toolCallId)) {
      return 'a tool-result block has no pairing id';
    }
  }
  const hasNestedResult = blocks.some((block) => block?.type === 'tool-result');
  if (message?.role === 'tool') {
    const hasTopLevelId = message.toolCallId !== undefined && message.toolCallId !== null;
    if ((hasTopLevelId && !hasToolPairingId(message.toolCallId)) || (!hasTopLevelId && !hasNestedResult)) {
      return 'a tool-result envelope has no pairing id';
    }
  }
  return undefined;
}

function messageToolCallIds(message) {
  return (Array.isArray(message?.content) ? message.content : [])
    .filter((block) => block?.type === 'tool-call' && hasToolPairingId(block.id))
    .map((block) => block.id);
}

function messageToolResultIds(message) {
  const ids = [];
  if (message?.role === 'tool' && hasToolPairingId(message.toolCallId)) ids.push(message.toolCallId);
  for (const block of (Array.isArray(message?.content) ? message.content : [])) {
    if (block?.type === 'tool-result' && hasToolPairingId(block.toolCallId)) ids.push(block.toolCallId);
  }
  return ids;
}

function isToolResultEnvelope(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  if (message?.role === 'tool' && hasToolPairingId(message.toolCallId)) {
    return !blocks.some((block) => block?.type === 'tool-call');
  }
  return message?.source?.kind === 'tool' && blocks.length > 0
    && blocks.every((block) => block?.type === 'tool-result');
}

function assistantDeletionEnd(messages, start) {
  const invalidCall = invalidToolPairing(messages[start]);
  if (invalidCall !== undefined) return { reason: invalidCall };
  const callIds = messageToolCallIds(messages[start]);
  if (new Set(callIds).size !== callIds.length) {
    return { reason: 'the assistant message has duplicate tool-call ids' };
  }
  let end = start + 1;
  const pending = new Set(callIds);
  while (pending.size > 0) {
    if (end >= messages.length || !isToolResultEnvelope(messages[end])) {
      return { reason: `tool interaction ${[...pending][0]} has no contiguous result` };
    }
    const invalidResult = invalidToolPairing(messages[end]);
    if (invalidResult !== undefined) return { reason: invalidResult };
    const resultIds = messageToolResultIds(messages[end]);
    if (resultIds.length === 0) return { reason: 'a tool-result envelope has no pairing id' };
    for (const id of resultIds) {
      if (!pending.has(id)) return { reason: `tool interaction ${id} is unrelated or ambiguous` };
      pending.delete(id);
    }
    end += 1;
  }
  const closure = validateToolClosure(messages, start, end);
  return closure === undefined ? { end } : { reason: closure };
}

function validateToolClosure(messages, start, end) {
  const calls = new Map();
  const results = new Map();
  const addPosition = (map, id, index) => {
    const positions = map.get(id) ?? [];
    positions.push(index);
    map.set(id, positions);
  };
  for (const [index, message] of messages.entries()) {
    if (index >= start && index < end) {
      const invalid = invalidToolPairing(message);
      if (invalid !== undefined) return invalid;
    }
    // Current DSH projects a tool/result event as a role=tool message whose pairing
    // id is top-level. Older request shapes carry a nested tool-result block instead.
    // Deletion validates the provider-facing surface, so both shapes must close the
    // same interaction before a whole turn may disappear.
    if (message?.role === 'tool' && typeof message.toolCallId === 'string') {
      addPosition(results, message.toolCallId, index);
    }
    for (const block of (Array.isArray(message?.content) ? message.content : [])) {
      if (block?.type === 'tool-call' && typeof block.id === 'string') {
        addPosition(calls, block.id, index);
      }
      if (block?.type === 'tool-result' && typeof block.toolCallId === 'string') {
        addPosition(results, block.toolCallId, index);
      }
    }
  }
  for (const id of new Set([...calls.keys(), ...results.keys()])) {
    const callPositions = calls.get(id) ?? [];
    const resultPositions = results.get(id) ?? [];
    const callInside = callPositions.some((index) => index >= start && index < end);
    const resultInside = resultPositions.some((index) => index >= start && index < end);
    if (!callInside && !resultInside) continue;
    if (callPositions.length !== 1 || resultPositions.length !== 1) {
      return `tool interaction ${id} is missing or ambiguous`;
    }
    if (callInside !== resultInside) return `tool interaction ${id} crosses the deletion boundary`;
  }
  return undefined;
}

function deletionClaims(edit, message) {
  const rightRole = edit.kind === DELETE_MESSAGE_KIND ? message?.role === 'assistant' : startsHumanTurn(message);
  if (!rightRole) return false;
  if (edit.kind === TRUNCATE_AFTER_KIND) {
    const blocks = messageAnchor(message, 0).blocks;
    if (blocks.length !== edit.anchor.blocks.length
      || !blocks.every((block, index) => identityKey(block) === identityKey(edit.anchor.blocks[index]))) return false;
  } else if (!sameDeletionSnapshot(message, edit.members?.[0])) {
    return false;
  }
  const texts = canonicalTexts(message);
  return texts.length === edit.texts.length && texts.every((text, index) => text === edit.texts[index]);
}

function findDeletionIndex(messages, edit) {
  const at = edit.anchor.index;
  if (Number.isInteger(at) && at >= 0 && at < messages.length && deletionClaims(edit, messages[at])) {
    return { index: at, recovered: false };
  }
  const hits = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (deletionClaims(edit, messages[index])) hits.push(index);
  }
  if (hits.length === 1) return { index: hits[0], recovered: true };
  if (hits.length > 1) {
    return { reason: `the deleted text now appears in ${hits.length} matching messages (${hits.join(', ')}); refusing to guess` };
  }
  return {
    reason: edit.kind === TRUNCATE_AFTER_KIND
      ? 'the retained anchor changed or is no longer part of the request'
      : 'the message this deletion targeted is no longer part of the request'
  };
}

function validateDeletionSlice(messages, edit, anchorIndex) {
  const members = edit.members;
  const start = edit.kind === TRUNCATE_AFTER_KIND ? anchorIndex + 1 : anchorIndex;

  if (edit.kind === DELETE_TURN_KIND) {
    // The surface snapshot cannot know every provider-only steering or intermediate envelope that
    // may be inserted later. Keep every recorded member as an ordered identity guard, but derive the
    // live end from the next direct-human boundary so those extra envelopes travel with the turn.
    let end = start + 1;
    while (end < messages.length && !startsHumanTurn(messages[end])) end += 1;
    let cursor = start;
    for (let offset = 0; offset < members.length; offset += 1) {
      while (cursor < end && !sameDeletionSnapshot(messages[cursor], members[offset])) cursor += 1;
      if (cursor >= end) {
        return { reason: `message ${offset} of the recorded turn changed identity, order, or boundary` };
      }
      cursor += 1;
    }
    if (edit.next !== null && !sameDeletionSnapshot(messages[end], edit.next)) {
      return { reason: 'the next user-message boundary changed' };
    }
    const closure = validateToolClosure(messages, start, end);
    return closure === undefined ? { start, end } : { reason: closure };
  }

  const end = start + members.length;
  const unit = edit.kind === DELETE_MESSAGE_KIND ? 'assistant group' : 'history suffix';
  if (end > messages.length) return { reason: `the recorded ${unit} is no longer complete` };
  for (let offset = 0; offset < members.length; offset += 1) {
    if (!sameDeletionSnapshot(messages[start + offset], members[offset])) {
      return {
        reason: edit.kind === TRUNCATE_AFTER_KIND
          ? `suffix member ${offset} changed identity or order`
          : `message ${offset} of the recorded ${unit} changed identity or order`
      };
    }
  }
  if (edit.next !== null && !sameDeletionSnapshot(messages[end], edit.next)) {
    return { reason: `the next ${edit.kind === DELETE_MESSAGE_KIND ? 'message' : 'user-message'} boundary changed` };
  }
  if (edit.kind === DELETE_MESSAGE_KIND) {
    const group = assistantDeletionEnd(messages, start);
    if (group.reason !== undefined) return group;
    if (group.end !== end) return { reason: 'the assistant tool-result boundary changed' };
  }
  const closure = validateToolClosure(messages, start, end);
  return closure === undefined ? { start, end } : { reason: closure };
}

const DIRECT_HUMAN_SOURCE_KINDS = new Set(['user', 'plugin:edit', 'plugin:context-kit-editor']);

/** Whether a user-role message starts a direct human turn, including verified editor replacements. */
export function directHumanSource(kind) {
  return DIRECT_HUMAN_SOURCE_KINDS.has(kind);
}

function startsHumanTurn(message) {
  // Durable user edits replace the original surface node with a message owned by
  // this editor. They remain human turn boundaries: both source kinds are reserved
  // for single-source replacements whose ancestry is verified by edit-durable.js.
  return message?.role === 'user' && directHumanSource(message?.source?.kind);
}

function snapshotStartsHumanTurn(snapshot) {
  return snapshot?.role === 'user' && directHumanSource(snapshot?.sourceKind);
}

/**
 * The wire overlay: rebuild a request so that stored edits are what the provider
 * receives.
 *
 * Pure — no cordis, no session, no I/O — so it can be tested with a plain array.
 * The caller re-enters `LlmRuntime.stream()` with the result.
 *
 * @param messages - the outgoing message array (deep-frozen; never mutated).
 * @param edits - the edit records for this session, oldest first.
 * @param options - `onRefused` to observe edits that could not be applied.
 * @returns `{ ok, messages, applied, refused, changed }`.
 */
export function planWireRewrite(messages, edits, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const pending = Array.isArray(edits) ? edits.filter((edit) => edit !== null && typeof edit === 'object') : [];
  const origins = list.map((_message, index) => index);
  if (pending.length === 0) {
    return { ok: true, messages: list, origins, applied: [], refused: [], changed: false };
  }

  const refused = [];
  const applied = [];
  const next = [...list];
  const refuse = (edit, reason) => {
    refused.push({ id: edit.id, kind: edit.kind, reason, after: edit.after });
    options.onRefused?.(edit, reason);
  };
  for (const edit of pending) {
    const deletion = edit.kind === DELETE_TURN_KIND || edit.kind === DELETE_MESSAGE_KIND
      || edit.kind === TRUNCATE_AFTER_KIND;
    // Only new, opt-in records chain from earlier edits. Persisted v1 records
    // without a basis keep their original-message guards and last-write behavior.
    const effectiveBasis = deletion || edit.basis === 'effective';
    const basis = effectiveBasis ? next : list;
    const found = deletion ? findDeletionIndex(basis, edit) : findAnchoredIndex(basis, edit);
    if (found.reason !== undefined) {
      refuse(edit, found.reason);
      continue;
    }
    const currentIndex = effectiveBasis ? found.index : origins.indexOf(found.index);
    if (currentIndex < 0 || currentIndex >= next.length) {
      refuse(edit, 'the message this edit targeted was removed by an earlier deletion');
      continue;
    }
    if (basis[found.index]?.id !== undefined && edit.messageId !== undefined
      && String(basis[found.index].id) !== String(edit.messageId)) {
      // Same content, different message identity: the id is the strongest anchor
      // available and disagreeing with it means the request was rebuilt.
      refuse(edit, `message id changed: expected ${edit.messageId}, found ${basis[found.index].id}`);
      continue;
    }
    if (deletion) {
      const slice = validateDeletionSlice(next, edit, currentIndex);
      if (slice.reason !== undefined) {
        refuse(edit, slice.reason);
        continue;
      }
      const removedOrigins = origins.slice(slice.start, slice.end);
      const removedIds = next.slice(slice.start, slice.end).map((message) => message?.id).filter((id) => id !== undefined);
      next.splice(slice.start, slice.end - slice.start);
      origins.splice(slice.start, slice.end - slice.start);
      applied.push({
        id: edit.id,
        kind: edit.kind,
        index: slice.start,
        originIndex: removedOrigins[0],
        removedOrigins,
        removedIds,
        removed: removedOrigins.length,
        messageId: edit.messageId,
        recovered: found.recovered,
        before: edit.before
      });
      continue;
    }
    const validated = validateEdit(basis[found.index], edit);
    if (!validated.ok) {
      refuse(edit, validated.reason);
      continue;
    }
    next[currentIndex] = applyEditToMessage(next[currentIndex], edit, validated.blockIndex, currentIndex);
    applied.push({
      id: edit.id,
      index: currentIndex,
      originIndex: origins[currentIndex],
      block: validated.blockIndex,
      recovered: found.recovered,
      before: edit.before,
      after: edit.after
    });
  }

  const changed = applied.length > 0;
  return { ok: refused.length === 0, messages: changed ? next : list, origins, applied, refused, changed };
}

/* ------------------------------------------------------------ wire listener */

const wireCoordinators = new WeakMap();

/**
 * Share one `llm/stream` re-entry across every outgoing-message transform.
 *
 * A transformed request is intentionally not marked as an agent-loop request:
 * that marker promises byte-for-byte reconstruction from the session log, which
 * is no longer true after an editor or DCP transform. Global prepend listeners
 * still observe the original marked request before this local coordinator.
 *
 * @param root - a context carrying `llm/stream`.
 * @param transform - `(messages, request) => messages`.
 * @param options - stable transform order and an error observer.
 * @returns a disposer for this transform.
 */
export function registerWireTransform(root, transform, options = {}) {
  const key = root?.root ?? root;
  let coordinator = wireCoordinators.get(key);
  if (coordinator === undefined) {
    const rewritten = new WeakSet();
    const stages = new Set();
    const listener = function (request, next) {
      if (rewritten.has(request) || !Array.isArray(request?.messages)) return next();
      let messages = request.messages;
      for (const stage of [...stages].sort((a, b) => a.order - b.order)) {
        try {
          const transformed = stage.transform(messages, request);
          if (Array.isArray(transformed)) messages = transformed;
        } catch (error) {
          stage.onError?.(error);
        }
      }
      if (messages === request.messages) return next();
      const copy = { ...request, messages };
      rewritten.add(copy);
      return this.stream(copy);
    };
    const disposeListener = key.on('llm/stream', listener);
    coordinator = { disposeListener, stages };
    wireCoordinators.set(key, coordinator);
  }
  const stage = {
    transform,
    order: Number.isFinite(options.order) ? Number(options.order) : 100,
    onError: options.onError
  };
  coordinator.stages.add(stage);
  return () => {
    coordinator.stages.delete(stage);
    if (coordinator.stages.size > 0) return;
    coordinator.disposeListener();
    wireCoordinators.delete(key);
  };
}

/**
 * Install the wire overlay on a cordis root.
 *
 * The shared coordinator re-enters the public `LlmRuntime.stream()` once after all
 * registered transforms have run. This editor is ordered before DCP message tags,
 * so anchors always compare against the original text.
 *
 * There is no state to race: the rewrite is a pure function of the request, so this
 * path needs no idle gate. The durable path does (`docs/edit-feature.md` §4.4).
 *
 * @param root - the cordis root or context carrying `llm/stream`.
 * @param store - the edit store.
 * @param options - `onApplied` / `onRefused` observers, `sessionFor` to resolve a
 *   live session, and `active` to disable.
 * @returns a disposer removing the listener.
 */
export function installWireOverlay(root, store, options = {}) {
  const disposeWire = registerWireTransform(root, (messages, request) => {
    if (options.active?.() === false) return messages;
    const sessionId = request?.sessionId;
    if (typeof sessionId !== 'string') return messages;
    let session = request?.session;
    if (session === undefined) session = options.sessionFor?.(sessionId, request);
    if (session === undefined) {
      try {
        session = root?.get?.('sessions')?.get?.(sessionId);
      } catch {
        session = undefined;
      }
    }
    const recovered = store.recoverPrepared?.(sessionId, session);
    if (recovered?.ok === false) throw new Error(recovered.reason);
    const edits = store.editsFor(sessionId);
    if (edits.length === 0) return messages;
    const plan = planWireRewrite(messages, edits, options);
    for (const entry of plan.applied) options.onApplied?.(sessionId, entry);
    return plan.messages;
  }, { order: 100, onError: options.onError });
  const disposeEviction = typeof root?.on === 'function'
    ? root.on('session/disposed', (session) => store.evict?.(session?.id))
    : undefined;
  return () => {
    disposeEviction?.();
    disposeWire?.();
  };
}

/* --------------------------------------------------------------- persistence */

export const EDIT_STATE_VERSION = 1;
export const EDIT_REBASE_TRANSACTION_VERSION = 1;

let atomicWriteSerial = 0;

/** Write a complete file beside its destination, then atomically rename it into place. */
function writeFileAtomic(path, contents) {
  const temporary = `${path}.${process.pid}.${atomicWriteSerial += 1}.tmp`;
  try {
    writeFileSync(temporary, contents, 'utf8');
    renameSync(temporary, path);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // The original write/rename error is the useful one.
    }
    throw error;
  }
}

/** Where a session's edits live — beside the DCP block state, one file per session. */
export function editStatePath(sessionId) {
  return join(dshHome(), 'context-kit', 'edits', `${encodeURIComponent(sessionId)}.json`);
}

/** Durable journal for one prepared truncate-anchor rebase. */
export function editTransactionPath(sessionId) {
  return join(dshHome(), 'context-kit', 'edits', `${encodeURIComponent(sessionId)}.rebase.json`);
}

/**
 * Persist one session's edits with a same-directory temporary file and atomic rename.
 * The wire overlay has no other home — the session log deliberately keeps the original
 * text — so an interrupted replacement must leave either the previous complete document
 * or the next one, never a partially written JSON document.
 *
 * @param sessionId - the session the edits belong to.
 * @param state - the store's state for that session.
 * @returns the path written or removed.
 */
export function saveEdits(sessionId, state) {
  const edits = state?.edits ?? [];
  const path = editStatePath(sessionId);
  if (edits.length === 0) {
    rmSync(path, { force: true });
    return path;
  }
  mkdirSync(join(dshHome(), 'context-kit', 'edits'), { recursive: true });
  const document = {
    version: EDIT_STATE_VERSION,
    sessionId,
    savedAt: new Date().toISOString(),
    edits
  };
  writeFileAtomic(path, `${JSON.stringify(document, null, 2)}\n`);
  return path;
}

/** Persist a prepared rebase without changing the main edit document. */
export function savePreparedRebase(sessionId, transaction) {
  const path = editTransactionPath(sessionId);
  if (existsSync(path)) {
    throw new Error(`a prepared truncate-anchor rebase already exists for session ${String(sessionId)}`);
  }
  mkdirSync(join(dshHome(), 'context-kit', 'edits'), { recursive: true });
  const document = {
    version: EDIT_REBASE_TRANSACTION_VERSION,
    sessionId: String(sessionId),
    savedAt: new Date().toISOString(),
    transaction
  };
  writeFileAtomic(path, `${JSON.stringify(document, null, 2)}\n`);
  return path;
}

/** Remove only the journal belonging to `transactionId`; a stale owner cannot clear a newer one. */
export function clearPreparedRebase(sessionId, transactionId) {
  const path = editTransactionPath(sessionId);
  if (!existsSync(path)) return true;
  let document;
  try {
    document = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return false;
  }
  if (document?.transaction?.id !== transactionId) return false;
  rmSync(path, { force: true });
  return true;
}

/**
 * Load one session's edits, refusing anything malformed.
 *
 * A refused record is dropped with a reason rather than trusted: a corrupted edit
 * applied to the wrong message is worse than a lost edit, because it is invisible.
 *
 * @param sessionId - the session to load.
 * @returns `{ edits, problems }`.
 */
export function loadEdits(sessionId) {
  const path = editStatePath(sessionId);
  const problems = [];
  if (!existsSync(path)) return { edits: [], problems };
  let document;
  try {
    document = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { edits: [], problems: [`unreadable: ${error.message}`] };
  }
  if (document?.version !== EDIT_STATE_VERSION) {
    problems.push(`unknown version ${String(document?.version)}; ignoring the file`);
    return { edits: [], problems };
  }
  const edits = [];
  for (const [index, edit] of (Array.isArray(document.edits) ? document.edits : []).entries()) {
    const problem = describeMalformedEdit(edit);
    if (problem !== undefined) {
      problems.push(`edit ${index}: ${problem}`);
      continue;
    }
    edits.push(edit);
  }
  edits.sort((left, right) => left.at - right.at);
  return { edits, problems };
}

function malformedPreparedRebase(transaction) {
  if (transaction === null || typeof transaction !== 'object') return 'no transaction';
  if (transaction.kind !== 'truncate-anchor-rebase') return 'unknown transaction kind';
  if (typeof transaction.id !== 'string' || transaction.id.length === 0) return 'transaction has no id';
  if (transaction.previousMessageId === undefined || transaction.previousMessageId === null) {
    return 'transaction has no previous message id';
  }
  if (transaction.replacementId === undefined || transaction.replacementId === null) {
    return 'transaction has no replacement message id';
  }
  if (!Number.isInteger(transaction.rebased) || transaction.rebased < 1) return 'transaction has no rebase count';
  for (const label of ['base', 'candidate']) {
    const state = transaction[label];
    if (state === null || typeof state !== 'object' || !Array.isArray(state.edits)) {
      return `transaction has no ${label} edit list`;
    }
    for (const [index, edit] of state.edits.entries()) {
      const problem = describeMalformedEdit(edit);
      if (problem !== undefined) return `${label} edit ${index}: ${problem}`;
    }
  }
  if (transaction.base.edits.length !== transaction.candidate.edits.length) {
    return 'transaction changes the number of edit records';
  }
  return undefined;
}

/** Load the durable prepared-rebase journal for one session. */
export function loadPreparedRebase(sessionId) {
  const path = editTransactionPath(sessionId);
  const problems = [];
  if (!existsSync(path)) return { transaction: undefined, problems, present: false };
  let document;
  try {
    document = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { transaction: undefined, problems: [`unreadable prepared rebase: ${error.message}`], present: true };
  }
  if (document?.version !== EDIT_REBASE_TRANSACTION_VERSION) {
    return {
      transaction: undefined,
      problems: [`unknown prepared rebase version ${String(document?.version)}`],
      present: true
    };
  }
  if (String(document?.sessionId) !== String(sessionId)) {
    return { transaction: undefined, problems: ['prepared rebase belongs to another session'], present: true };
  }
  const problem = malformedPreparedRebase(document.transaction);
  if (problem !== undefined) return { transaction: undefined, problems: [problem], present: true };
  return { transaction: document.transaction, problems, present: true };
}

function malformedAnchor(anchor) {
  if (anchor === null || typeof anchor !== 'object') return 'no anchor';
  if (typeof anchor.role !== 'string' || anchor.role.length === 0) return 'anchor has no role';
  if (!Array.isArray(anchor.blocks)) return 'anchor has no block list';
  if (!Number.isInteger(anchor.index) || anchor.index < 0) return 'anchor has no index';
  // The planner reads every block identity, including blocks not selected for editing.
  for (const [index, block] of anchor.blocks.entries()) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)
      || typeof block.type !== 'string' || block.type.length === 0) return `anchor block ${index} has no type`;
    if (['id', 'toolCallId'].some((field) => block[field] !== undefined && typeof block[field] !== 'string')) {
      return `anchor block ${index} has invalid identity`;
    }
    if (block.signed !== undefined && typeof block.signed !== 'boolean') return `anchor block ${index} has invalid signed flag`;
  }
  return undefined;
}

function malformedDeletionSnapshot(snapshot, label) {
  if (snapshot === null || typeof snapshot !== 'object') return `${label} is not an object`;
  if (snapshot.id === undefined || snapshot.id === null || String(snapshot.id).length === 0) return `${label} has no id`;
  if (typeof snapshot.role !== 'string' || snapshot.role.length === 0) return `${label} has no role`;
  if (snapshot.sourceKind !== undefined && typeof snapshot.sourceKind !== 'string') return `${label} has invalid source kind`;
  return malformedAnchor({ role: snapshot.role, blocks: snapshot.blocks, index: 0 });
}

function describeMalformedEdit(edit) {
  if (edit === null || typeof edit !== 'object') return 'not an object';
  if (typeof edit.id !== 'string' || edit.id.length === 0) return 'no id';
  if (edit.messageId !== undefined && typeof edit.messageId !== 'string' && !Number.isFinite(edit.messageId)) return 'invalid message id';
  if (typeof edit.before !== 'string') return 'no before text';
  if (edit.kind === DELETE_TURN_KIND || edit.kind === DELETE_MESSAGE_KIND || edit.kind === TRUNCATE_AFTER_KIND) {
    const messageDeletion = edit.kind === DELETE_MESSAGE_KIND;
    const truncation = edit.kind === TRUNCATE_AFTER_KIND;
    const label = messageDeletion ? 'message deletion' : (truncation ? 'history truncation' : 'turn deletion');
    if (!Number.isInteger(edit.at) || edit.at < 0) return 'no ordering cursor';
    const anchorProblem = malformedAnchor(edit.anchor);
    if (anchorProblem !== undefined) return anchorProblem;
    if (edit.basis !== 'effective') return `${label} is not effective-basis`;
    if (edit.anchor.role !== (messageDeletion ? 'assistant' : 'user')) return `${label} anchor has the wrong role`;
    if (!Array.isArray(edit.texts) || edit.texts.length === 0
      || edit.texts.some((text) => typeof text !== 'string')) return `${label} has no text vector`;
    if (edit.texts.join('') !== edit.before) return `${label} text vector disagrees with before text`;
    if (!Array.isArray(edit.members) || edit.members.length === 0) return `${label} has no member list`;
    const ids = new Set();
    for (const [index, member] of edit.members.entries()) {
      const problem = malformedDeletionSnapshot(member, `${messageDeletion ? 'message' : (truncation ? 'suffix' : 'turn')} member ${index}`);
      if (problem !== undefined) return problem;
      const id = String(member.id);
      if (ids.has(id)) return `${label} has duplicate member ids`;
      ids.add(id);
    }
    if (edit.next !== null) {
      if (truncation) return 'history truncation has an unexpected next boundary';
      const problem = malformedDeletionSnapshot(edit.next, `next ${messageDeletion ? 'message' : 'turn'} boundary`);
      if (problem !== undefined) return problem;
      if (!messageDeletion && !snapshotStartsHumanTurn(edit.next)) return 'next turn boundary is not a direct user message';
      if (ids.has(String(edit.next.id))) return `${label} boundary duplicates a member id`;
    }
    if (messageDeletion) {
      if (edit.members[0]?.role !== 'assistant') return 'first message member is not an assistant message';
      if (edit.members.slice(1).some((member) => member?.sourceKind !== 'tool' && member?.role !== 'tool')) {
        return 'message deletion contains a non-tool member after the assistant';
      }
    } else if (!truncation && !snapshotStartsHumanTurn(edit.members[0])) {
      return 'first turn member is not a direct user message';
    }
    return undefined;
  }
  if (edit.kind !== undefined) return 'unknown edit kind';
  if (typeof edit.after !== 'string' || edit.after.length === 0) return 'no after text';
  if (edit.basis !== undefined && edit.basis !== 'effective') return 'unknown edit basis';
  if (!Number.isInteger(edit.at) || edit.at < 0) return 'no ordering cursor';
  if (edit.cursor === null || typeof edit.cursor !== 'object') return 'no cursor';
  if (!Number.isInteger(edit.cursor.block)) return 'no block cursor';
  const anchorProblem = malformedAnchor(edit.anchor);
  if (anchorProblem !== undefined) return anchorProblem;
  if (edit.anchor.blocks.length === 0 ? edit.cursor.block !== -1
    : edit.cursor.block < 0 || edit.cursor.block >= edit.anchor.blocks.length) {
    return 'block cursor outside anchor block list';
  }
  return undefined;
}

function messageIdOfEvent(event) {
  const message = event?.data?.role === undefined ? event?.data?.message : event?.data;
  return message?.id;
}

/** Inspect both the current surface and the enumerable event log for a durable message id. */
function durableReplacementPresence(session, replacementId) {
  let readable = false;
  const matches = (event) => String(messageIdOfEvent(event)) === String(replacementId);
  const surface = session?.surface?.nodes;
  const surfaceEventAt = typeof session?.eventAt === 'function'
    ? (seq) => session.eventAt(seq)
    : (session?.log !== undefined && session?.log !== null ? (seq) => session.log[seq] : undefined);
  if (Array.isArray(surface) && surfaceEventAt !== undefined) {
    readable = true;
    for (const seq of surface) {
      if (matches(surfaceEventAt(seq))) return { readable, found: true };
    }
  }
  if (typeof session?.snapshotEvents === 'function') {
    const events = session.snapshotEvents();
    if (Array.isArray(events)) {
      readable = true;
      if (events.some(matches)) return { readable, found: true };
    }
  } else if (Array.isArray(session?.log)) {
    readable = true;
    if (session.log.some(matches)) return { readable, found: true };
  }
  return { readable, found: false };
}

/**
 * Create the store that both mechanisms share.
 *
 * @param options - `restore` (default true), `onProblem`, and injectable `save`/`load`
 *   plus `savePrepared`/`loadPrepared`/`clearPrepared` persistence hooks for tests.
 * @returns the store.
 */
export function createEditStore(options = {}) {
  const sessions = new Map();
  const pending = new Map();
  const awaitingDurability = new WeakSet();
  const checkedPrepared = new Set();
  const persist = options.save ?? saveEdits;
  const restore = options.load ?? loadEdits;
  const persistPrepared = options.savePrepared ?? savePreparedRebase;
  const restorePrepared = options.loadPrepared ?? loadPreparedRebase;
  const discardPrepared = options.clearPrepared ?? clearPreparedRebase;
  let counter = 0;
  let transactionCounter = 0;

  const hydratePrepared = (state, force = false) => {
    if (!force && checkedPrepared.has(state.sessionId)) return pending.get(state.sessionId);
    checkedPrepared.add(state.sessionId);
    const loaded = restorePrepared(state.sessionId) ?? {};
    for (const problem of (loaded.problems ?? [])) options.onProblem?.(state.sessionId, problem);
    if (loaded.transaction !== undefined) {
      pending.set(state.sessionId, loaded.transaction);
      // Until the live log decides the outcome, expose the old side of the journal.
      state.edits = loaded.transaction.base.edits;
      state.nextId = state.edits.length + 1;
      counter = state.edits.reduce((latest, edit) => Math.max(latest, edit.at), counter);
    } else if (loaded.present === true) {
      pending.set(state.sessionId, {
        kind: 'invalid-prepared-rebase',
        problems: loaded.problems ?? ['the prepared rebase journal is malformed']
      });
    }
    return pending.get(state.sessionId);
  };

  const stateOf = (sessionId) => {
    const key = String(sessionId);
    let state = sessions.get(key);
    if (state === undefined) {
      const restored = options.restore === false ? { edits: [], problems: [] } : restore(key);
      for (const problem of restored.problems) options.onProblem?.(key, problem);
      counter = restored.edits.reduce((latest, edit) => Math.max(latest, edit.at), counter);
      state = { sessionId: key, edits: restored.edits, nextId: restored.edits.length + 1, applied: [] };
      sessions.set(key, state);
      if (options.restore === false) checkedPrepared.add(key);
      else hydratePrepared(state);
    }
    return state;
  };

  const pendingRefusal = (state) => {
    const active = pending.get(state.sessionId);
    if (active === undefined) return undefined;
    const id = typeof active.id === 'string' ? ` ${active.id}` : '';
    return {
      ok: false,
      reason: `truncate-anchor rebase${id} is pending recovery for this session`
    };
  };

  const appendCreated = (state, created, prefix, extras = {}) => {
    if (!created.ok) return created;
    const at = counter + 1;
    created.edit.at = at;
    if (extras.basis === 'effective') created.edit.basis = 'effective';
    created.edit.messageId = extras.messageId;
    created.edit.id = `${state.sessionId.slice(0, 8)}-${prefix}${state.nextId}`;
    const candidate = {
      ...state,
      nextId: state.nextId + 1,
      edits: [...state.edits, created.edit]
    };
    persist(state.sessionId, candidate);
    state.nextId = candidate.nextId;
    state.edits = candidate.edits;
    counter = at;
    return created;
  };

  const prepareTruncateAnchorRebase = (sessionId, previousMessageId, replacement) => {
    const state = stateOf(sessionId);
    const blocked = pendingRefusal(state);
    if (blocked !== undefined) return blocked;
    if (previousMessageId === undefined || replacement?.id === undefined) {
      return { ok: false, reason: 'the durable replacement has no stable message id' };
    }
    const texts = canonicalTexts(replacement);
    if (texts.length === 0 || texts.join('').length === 0) {
      return { ok: false, reason: 'the durable replacement has no stable anchor text' };
    }
    let rebased = 0;
    const edits = state.edits.map((edit) => {
      if (edit.kind !== TRUNCATE_AFTER_KIND || String(edit.messageId) !== String(previousMessageId)) return edit;
      rebased += 1;
      return {
        ...edit,
        messageId: replacement.id,
        before: texts.join(''),
        texts,
        anchor: messageAnchor(replacement, edit.anchor.index)
      };
    });
    if (rebased === 0) {
      return {
        ok: true,
        rebased,
        commit() { return { ok: true, rebased }; },
        rollback() { return { ok: true, rebased }; }
      };
    }
    const transaction = {
      kind: 'truncate-anchor-rebase',
      id: `${state.sessionId.slice(0, 8)}-r${Date.now().toString(36)}-${transactionCounter += 1}`,
      preparedAt: Date.now(),
      previousMessageId,
      replacementId: replacement.id,
      rebased,
      base: { edits: state.edits },
      candidate: { edits }
    };
    // The journal is the PREPARED state. The main edit document and in-memory edit
    // list deliberately remain on `base` until the caller confirms append success.
    persistPrepared(state.sessionId, transaction);
    pending.set(state.sessionId, transaction);
    // Recovery may inspect a reloaded session after restart, but the store that just
    // appended the replacement must wait for its caller to confirm Session persistence.
    awaitingDurability.add(transaction);
    const isCurrent = () => pending.get(state.sessionId) === transaction;
    return {
      ok: true,
      rebased,
      transactionId: transaction.id,
      commit() {
        if (!isCurrent()) return { ok: false, reason: 'the prepared rebase transaction is stale' };
        // Calling commit is the caller's proof that Session.flush() confirmed the append.
        // Unlock recovery first so a main-document write failure can be retried safely.
        awaitingDurability.delete(transaction);
        persist(state.sessionId, { ...state, edits: transaction.candidate.edits });
        state.edits = transaction.candidate.edits;
        const cleared = discardPrepared(state.sessionId, transaction.id);
        if (cleared !== true) {
          return { ok: false, reason: 'the committed rebase journal could not be cleared; recovery is still required' };
        }
        pending.delete(state.sessionId);
        return { ok: true, rebased };
      },
      rollback() {
        if (!isCurrent()) return { ok: false, reason: 'the prepared rebase transaction is stale' };
        try {
          const cleared = discardPrepared(state.sessionId, transaction.id);
          if (cleared !== true) {
            return { ok: false, reason: 'the rebase journal could not be cleared; recovery is still required' };
          }
        } catch (error) {
          // This method is commonly called from an append-error catch. Never replace
          // that primary failure with cleanup I/O; report it and leave the lock intact.
          options.onProblem?.(state.sessionId, `prepared rebase rollback cleanup failed: ${error.message}`);
          return {
            ok: false,
            reason: 'the rebase journal could not be cleared; recovery is still required',
            cleanupError: error
          };
        }
        awaitingDurability.delete(transaction);
        pending.delete(state.sessionId);
        return { ok: true, rebased };
      }
    };
  };

  /**
   * Recover one durable prepared rebase from live session events.
   *
   * Signature: `recoverPrepared(sessionId, session)`.
   * Returns `{ ok: true, recovered: false, action: 'none' }` when no journal exists;
   * `{ ok: true, recovered: true, action: 'committed' | 'rolled-back', ... }` after
   * settling one; or `{ ok: false, reason }` while an unreadable/malformed journal or
   * inadequate live session access keeps the session locked. Main/journal persistence
   * and `session.snapshotEvents()` errors are allowed to throw so callers can surface or
   * retry them; a failed settlement keeps the transaction pending.
   */
  const recoverPrepared = (sessionId, session) => {
    const state = stateOf(sessionId);
    let transaction = pending.get(state.sessionId);
    if (transaction === undefined) transaction = hydratePrepared(state);
    if (transaction === undefined) return { ok: true, recovered: false, action: 'none' };
    if (transaction.kind !== 'truncate-anchor-rebase') {
      return {
        ok: false,
        reason: `the prepared rebase journal is malformed: ${(transaction.problems ?? []).join('; ')}`
      };
    }
    if (session?.id !== undefined && String(session.id) !== state.sessionId) {
      return { ok: false, reason: 'the live session does not match the prepared rebase session' };
    }
    const presence = durableReplacementPresence(session, transaction.replacementId);
    if (!presence.readable) {
      return { ok: false, reason: 'the live session exposes neither a readable surface nor an enumerable event log' };
    }
    if (awaitingDurability.has(transaction)) {
      return {
        ok: false,
        reason: 'the prepared rebase is still awaiting session durability confirmation; recovery requires a reloaded session'
      };
    }
    const action = presence.found ? 'committed' : 'rolled-back';
    const edits = presence.found ? transaction.candidate.edits : transaction.base.edits;
    persist(state.sessionId, { ...state, edits });
    state.edits = edits;
    state.nextId = edits.length + 1;
    const cleared = discardPrepared(state.sessionId, transaction.id);
    if (cleared !== true) {
      return { ok: false, reason: 'the recovered rebase journal could not be cleared; recovery is still required' };
    }
    pending.delete(state.sessionId);
    return {
      ok: true,
      recovered: true,
      action,
      rebased: transaction.rebased,
      transactionId: transaction.id
    };
  };

  return {
    /** Every edit recorded for a session, oldest first. */
    editsFor(sessionId) {
      return stateOf(sessionId).edits;
    },

    /** How many sessions this store has touched. */
    sessionCount() {
      return sessions.size;
    },

    /** Forget an inactive session only when no prepared recovery data is pending. */
    evict(sessionId) {
      const key = String(sessionId);
      if (pending.has(key)) return false;
      sessions.delete(key);
      checkedPrepared.delete(key);
      return true;
    },

    recoverPrepared,

    /**
     * Record an edit for a message of a session.
     *
     * @param sessionId - the session the edit belongs to.
     * @param message - the outgoing message being edited, as the provider saw it.
     * @param newText - the replacement text.
     * @param extras - `messageIndex`, `messageId`, `expected` (the text the edit is
     *   aimed at, when the caller knows which block it is editing) and `blockAt` (the
     *   block index it is aimed at, which is what tells two blocks with the same text
     *   apart).
     * @returns `{ ok: true, edit }` or `{ ok: false, reason }`.
     */
    record(sessionId, message, newText, extras = {}) {
      const state = stateOf(sessionId);
      const blocked = pendingRefusal(state);
      if (blocked !== undefined) return blocked;
      const created = createEdit({
        sessionId: state.sessionId,
        index: extras.messageIndex ?? 0,
        message,
        newText,
        at: counter + 1,
        expected: extras.expected,
        blockAt: extras.blockAt
      });
      return appendCreated(state, created, 'e', extras);
    },

    /** Record a wire-overlay tombstone for one complete user turn. */
    deleteTurn(sessionId, messages, extras = {}) {
      const state = stateOf(sessionId);
      const blocked = pendingRefusal(state);
      if (blocked !== undefined) return blocked;
      const created = createTurnDeletion({
        messages,
        index: extras.messageIndex ?? 0,
        at: counter + 1,
        expected: extras.expected
      });
      return appendCreated(state, created, 'd', extras);
    },

    /** Record a wire-overlay tombstone for one assistant message and its tool results. */
    deleteMessage(sessionId, messages, extras = {}) {
      const state = stateOf(sessionId);
      const blocked = pendingRefusal(state);
      if (blocked !== undefined) return blocked;
      const created = createAssistantDeletion({
        messages,
        index: extras.messageIndex ?? 0,
        at: counter + 1,
        expected: extras.expected
      });
      return appendCreated(state, created, 'm', extras);
    },

    /** Record a wire-overlay tombstone for every message after one retained user anchor. */
    truncateAfter(sessionId, messages, extras = {}) {
      const state = stateOf(sessionId);
      const blocked = pendingRefusal(state);
      if (blocked !== undefined) return blocked;
      const created = createTruncateAfterDeletion({
        messages,
        index: extras.messageIndex ?? 0,
        at: counter + 1,
        expected: extras.expected
      });
      return appendCreated(state, created, 't', extras);
    },

    /**
     * Follow a durable replacement of a retained truncate-after anchor.
     *
     * The suffix snapshot remains immutable: only the one visible boundary message
     * changes identity and text. Rebasing by the previous stable id prevents the
     * tombstone from matching an unrelated same-shaped user message.
     */
    prepareTruncateAnchorRebase,

    rebaseTruncateAnchors(sessionId, previousMessageId, replacement) {
      const prepared = prepareTruncateAnchorRebase(sessionId, previousMessageId, replacement);
      if (!prepared.ok) return prepared;
      const committed = prepared.commit();
      return committed?.ok === false ? committed : { ok: true, rebased: prepared.rebased };
    },

    /** Forget one edit (the UI's "undo"), persisting the result. */
    remove(sessionId, editId) {
      const state = stateOf(sessionId);
      const blocked = pendingRefusal(state);
      if (blocked !== undefined) return blocked;
      const edits = state.edits.filter((edit) => edit.id !== editId);
      if (edits.length === state.edits.length) return { ok: false, reason: `no edit ${editId}` };
      persist(state.sessionId, { ...state, edits });
      state.edits = edits;
      return { ok: true, remaining: edits.length };
    },

    /** Drop every edit for a session, deleting the file. */
    clear(sessionId) {
      const state = stateOf(sessionId);
      const blocked = pendingRefusal(state);
      if (blocked !== undefined) return blocked;
      const removed = state.edits.length;
      const path = editStatePath(state.sessionId);
      persist(state.sessionId, { ...state, edits: [] });
      state.edits = [];
      return { ok: true, removed, path };
    },

    /** What the provider was last told, for the UI to report honestly. */
    recordApplied(sessionId, entries) {
      const state = stateOf(sessionId);
      const blocked = pendingRefusal(state);
      if (blocked !== undefined) return blocked;
      state.applied = entries;
      return { ok: true };
    },

    /** The last rewrite's outcome for a session. */
    lastApplied(sessionId) {
      return stateOf(sessionId).applied;
    }
  };
}
