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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dshHome } from './common.js';

/* --------------------------------------------------------------- vocabulary */

/**
 * The block kinds an edit may rewrite the text of.
 *
 * `reasoning` is the model's own chain of thought. It is editable ONLY where the
 * provider does not hold a signature over that text — DeepSeek passes reasoning back
 * as plain text — and {@link signedReasoningRefusal} is what enforces it, at both the
 * record and the apply end. See that function for why a signed block is refused rather
 * than rewritten with its signature dropped.
 */
export const EDITABLE_BLOCK_KINDS = ['text', 'tool-call', 'tool-result', 'reasoning'];

/** What a single edit changes. */
export const EDIT_SCOPE = { TEXT: 'text', ARGS: 'toolArguments' };

/* ------------------------------------------------------------- text blocks */

/**
 * The single editable text of a block, or `undefined` when the block is not
 * editable. One block carries exactly one piece of text — a `tool-call` its
 * `arguments` string, a `tool-result` the text of its first nested content block
 * — so "replace the text" has no ambiguity and this function is the whole rule.
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
  // block hold" and "is that text safe to replace" are not the same question, and
  // merging them here would report an uneditable block as an empty one.
  if (block.type === 'reasoning') return typeof block.text === 'string' ? block.text : undefined;
  if (block.type === 'tool-call') {
    return typeof block.arguments === 'string' ? block.arguments : undefined;
  }
  if (block.type === 'tool-result') {
    const nested = Array.isArray(block.content) ? block.content.filter((item) => item?.type === 'text') : [];
    if (nested.length === 0) return '';
    return nested.map((item) => item.text ?? '').join('');
  }
  return undefined;
}

/** The fields a signed reasoning block may carry ON THE BLOCK ITSELF. */
const REASONING_SIGNATURE_FIELDS = ['signature', 'thinkingSignature', 'thoughtSignature'];

/** Whether a block carries a signature field of its own. */
function blockHasSignature(block) {
  return REASONING_SIGNATURE_FIELDS.some((field) => typeof block?.[field] === 'string' && block[field].length > 0);
}

/**
 * Why rewriting one reasoning block would send a signature that does not match it.
 *
 * A chain of thought is not always free text. `dsh-llm-pi-ai` (the Anthropic-family
 * adapter) records an opaque `thinkingSignature` for every thinking block and re-attaches
 * it from the message's durable replay state on the way out
 * (`dsh-llm-pi-ai/lib/index.js:198-203`: `thinking: block.text` plus
 * `replay.thinkingSignature`). The signature is computed by the provider over the
 * thinking text, and the adapter compares NOTHING: it takes whatever `text` the harness
 * holds and whatever signature the replay state holds, and sends the pair.
 *
 * So a rewrite of signed thinking is refused here rather than performed, in the one place
 * both ends consult. Dropping the signature instead would be just as broken in the other
 * direction — Anthropic rejects a thinking block with no signature at all — and choosing
 * between two provider errors on the user's behalf is not this plugin's call. DeepSeek
 * signs nothing, carries no replay state, and is unaffected: for it this returns
 * `undefined` and the reasoning is editable.
 *
 * @param message - the message the block belongs to (its `source.replayState` matters).
 * @param blockIndex - the block cursor the edit would land on.
 * @returns the reason it may not be edited, or `undefined` when it may.
 */
export function signedReasoningRefusal(message, blockIndex) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const block = blocks[blockIndex];
  if (block?.type !== 'reasoning') return undefined;
  if (blockHasSignature(block)) {
    return `the reasoning block carries a signature of its own (${REASONING_SIGNATURE_FIELDS.filter((field) => typeof block[field] === 'string').join(', ')})`;
  }
  // The signature that matters lives beside the message, not on the block: the replay
  // state is indexed position by position against the assistant content.
  const replay = message?.source?.replayState;
  const at = Array.isArray(replay?.blocks) ? replay.blocks[blockIndex] : undefined;
  if (at?.type === 'reasoning' && typeof at.thinkingSignature === 'string' && at.thinkingSignature.length > 0) {
    return 'this reply\'s thinking is signed by the provider (thinkingSignature in its replay state)';
  }
  if (at?.type === 'reasoning' && at.redacted !== undefined) {
    return 'this reply\'s thinking is redacted, so its text is not what the provider receives';
  }
  return undefined;
}

/**
 * Which block of a message holds the text a surface asked to edit.
 *
 * The same selection {@link createEdit} performs with `expected`, exposed so a caller can
 * name the block an edit will land on BEFORE recording it: the wire branch has to inspect
 * the cursor block for a signature ({@link signedReasoningRefusal}), and inspecting the
 * first block of a message instead of the block the edit will rewrite would clear an edit
 * of one block on the strength of another.
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
    // WHETHER A REASONING BLOCK IS SIGNED IS PART OF WHAT IT IS. Two thinking blocks with
    // the same text and different provenance are not interchangeable: one may be rewritten
    // and the other may not ({@link signedReasoningRefusal}). Recorded as a flag rather
    // than as the signature itself, so an anchor stays small and carries no provider
    // secret into the edit state file.
    ...(block.type === 'reasoning' ? { signed: blockHasSignature(block) } : {})
  };
}

function identityKey(block) {
  const id = blockIdentity(block);
  return `${id.type}|${id.id ?? ''}|${id.toolCallId ?? ''}|${id.signed ?? ''}`;
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
  // Asking "may this be edited" before "is this the text" is deliberate: a signed
  // reasoning block is refused for what it IS, and reporting it as changed text would
  // send the user looking for a difference that is not there.
  const signed = signedReasoningRefusal(message, at);
  if (signed !== undefined) return { ok: false, reason: signed };
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
  const next = blocks.map((block, index) => {
    if (index !== blockIndex) return block;
    if (block.type === 'text') return { ...block, text: edit.after };
    // A reasoning block is the model's own thinking, and the harness carries its text
    // here as `{ type: 'reasoning', text }` — the shape every consumer reads is the SAME
    // field a text block uses, so the rewrite is the same one line.
    //
    // THIS BRANCH HAD TO EXIST BEFORE `reasoning` JOINED `EDITABLE_BLOCK_KINDS`, and the
    // order is not cosmetic: without it the block falls through to the tool-result branch
    // below and comes back carrying a `content` array it never had, so the edit would
    // look applied while the thinking text the provider receives never changed. A wrong
    // edit that reports success is the one failure this file exists to prevent.
    if (block.type === 'reasoning') return { ...block, text: edit.after };
    if (block.type === 'tool-call') return { ...block, arguments: edit.after };
    const inner = Array.isArray(block.content) ? block.content : [];
    const firstText = inner.findIndex((item) => item?.type === 'text');
    const content = firstText === -1
      ? [...inner, { type: 'text', text: edit.after }]
      : inner.map((item, position) => (position === firstText ? { ...item, text: edit.after } : item));
    return { ...block, content };
  });
  return { ...message, content: next, appliedAt };
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
 * The provisional anchor for a message: where it was, what role it had, and the
 * identity of every block in order. This is what lets a later request be searched
 * for the same message instead of trusting a stale index.
 *
 * EVERY block is recorded, the model's reasoning included — a reasoning block is part
 * of the shape of the reply, and a message that lost or gained one is not the message
 * the edit was made against. What a reasoning block contributes is its type and, since
 * the passback is not always free text, whether the block is signed
 * ({@link blockIdentity}); the signature itself is deliberately not copied here.
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
  if (pending.length === 0) return { ok: true, messages: list, applied: [], refused: [], changed: false };

  const refused = [];
  const applied = [];
  const next = [...list];
  for (const edit of pending) {
    // Only new, opt-in records chain from earlier edits. Persisted v1 records
    // without a basis keep their original-message guards and last-write behavior.
    const basis = edit.basis === 'effective' ? next : list;
    const found = findAnchoredIndex(basis, edit);
    if (found.reason !== undefined) {
      refused.push({ id: edit.id, reason: found.reason, after: edit.after });
      options.onRefused?.(edit, found.reason);
      continue;
    }
    if (basis[found.index]?.id !== undefined && edit.messageId !== undefined
      && String(basis[found.index].id) !== String(edit.messageId)) {
      // Same content, different message identity: the id is the strongest anchor
      // available and disagreeing with it means the request was rebuilt.
      refused.push({ id: edit.id, reason: `message id changed: expected ${edit.messageId}, found ${basis[found.index].id}`, after: edit.after });
      continue;
    }
    const validated = validateEdit(basis[found.index], edit);
    if (!validated.ok) {
      refused.push({ id: edit.id, reason: validated.reason, after: edit.after });
      options.onRefused?.(edit, validated.reason);
      continue;
    }
    next[found.index] = applyEditToMessage(next[found.index], edit, validated.blockIndex, found.index);
    applied.push({
      id: edit.id,
      index: found.index,
      block: validated.blockIndex,
      recovered: found.recovered,
      before: edit.before,
      after: edit.after
    });
  }

  const changed = applied.length > 0;
  return { ok: refused.length === 0, messages: changed ? next : list, applied, refused, changed };
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
 * @param options - `onApplied` / `onRefused` observers, and `active` to disable.
 * @returns a disposer removing the listener.
 */
export function installWireOverlay(root, store, options = {}) {
  return registerWireTransform(root, (messages, request) => {
    if (options.active?.() === false) return messages;
    const sessionId = request?.sessionId;
    if (typeof sessionId !== 'string') return messages;
    const edits = store.editsFor(sessionId);
    if (edits.length === 0) return messages;
    const plan = planWireRewrite(messages, edits, options);
    for (const entry of plan.applied) options.onApplied?.(sessionId, entry);
    return plan.messages;
  }, { order: 100, onError: options.onError });
}

/* --------------------------------------------------------------- persistence */

export const EDIT_STATE_VERSION = 1;

/** Where a session's edits live — beside the DCP block state, one file per session. */
export function editStatePath(sessionId) {
  return join(dshHome(), 'context-kit', 'edits', `${encodeURIComponent(sessionId)}.json`);
}

/**
 * Persist one session's edits.
 *
 * Atomic in the only way that matters here: the whole document is written at once,
 * so a crash leaves either the old file or the new one. The wire overlay has no
 * other home — the session log deliberately keeps the original text — so this file
 * is the entire durability story for a wire-level edit.
 *
 * @param sessionId - the session the edits belong to.
 * @param state - the store's state for that session.
 * @returns the path written, or `undefined` when there is nothing to write.
 */
export function saveEdits(sessionId, state) {
  const edits = state?.edits ?? [];
  const path = editStatePath(sessionId);
  if (edits.length === 0) return undefined;
  mkdirSync(join(dshHome(), 'context-kit', 'edits'), { recursive: true });
  const document = {
    version: EDIT_STATE_VERSION,
    sessionId,
    savedAt: new Date().toISOString(),
    edits
  };
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  return path;
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

function describeMalformedEdit(edit) {
  if (edit === null || typeof edit !== 'object') return 'not an object';
  if (typeof edit.id !== 'string' || edit.id.length === 0) return 'no id';
  if (edit.messageId !== undefined && typeof edit.messageId !== 'string' && !Number.isFinite(edit.messageId)) return 'invalid message id';
  if (typeof edit.before !== 'string') return 'no before text';
  if (typeof edit.after !== 'string' || edit.after.length === 0) return 'no after text';
  if (edit.basis !== undefined && edit.basis !== 'effective') return 'unknown edit basis';
  if (!Number.isInteger(edit.at) || edit.at < 0) return 'no ordering cursor';
  if (edit.cursor === null || typeof edit.cursor !== 'object') return 'no cursor';
  if (!Number.isInteger(edit.cursor.block)) return 'no block cursor';
  const anchor = edit.anchor;
  if (anchor === null || typeof anchor !== 'object') return 'no anchor';
  if (typeof anchor.role !== 'string' || anchor.role.length === 0) return 'anchor has no role';
  if (!Array.isArray(anchor.blocks)) return 'anchor has no block list';
  if (!Number.isInteger(anchor.index) || anchor.index < 0) return 'anchor has no index';
  if (anchor.blocks.length === 0 ? edit.cursor.block !== -1 : edit.cursor.block < 0 || edit.cursor.block >= anchor.blocks.length) {
    return 'block cursor outside anchor block list';
  }
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

/**
 * Create the store that both mechanisms share.
 *
 * @param options - `restore` (default true) to read each session's file on first
 *   use, and `onProblem` to observe refused records.
 * @returns the store.
 */
export function createEditStore(options = {}) {
  const sessions = new Map();
  let counter = 0;

  const stateOf = (sessionId) => {
    const key = String(sessionId);
    let state = sessions.get(key);
    if (state === undefined) {
      const restored = options.restore === false ? { edits: [], problems: [] } : loadEdits(key);
      for (const problem of restored.problems) options.onProblem?.(key, problem);
      counter = restored.edits.reduce((latest, edit) => Math.max(latest, edit.at), counter);
      state = { sessionId: key, edits: restored.edits, nextId: restored.edits.length + 1, applied: [] };
      sessions.set(key, state);
    }
    return state;
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
      counter += 1;
      const created = createEdit({
        sessionId: state.sessionId,
        index: extras.messageIndex ?? 0,
        message,
        newText,
        at: counter,
        expected: extras.expected,
        blockAt: extras.blockAt
      });
      if (!created.ok) return created;
      if (extras.basis === 'effective') created.edit.basis = 'effective';
      created.edit.messageId = extras.messageId;
      created.edit.id = `${state.sessionId.slice(0, 8)}-e${state.nextId}`;
      state.nextId += 1;
      state.edits = [...state.edits, created.edit];
      saveEdits(state.sessionId, state);
      return created;
    },

    /** Forget one edit (the UI's "undo"), persisting the result. */
    remove(sessionId, editId) {
      const state = stateOf(sessionId);
      const before = state.edits.length;
      state.edits = state.edits.filter((edit) => edit.id !== editId);
      if (state.edits.length === before) return { ok: false, reason: `no edit ${editId}` };
      saveEdits(state.sessionId, state);
      return { ok: true, remaining: state.edits.length };
    },

    /** Drop every edit for a session, deleting the file. */
    clear(sessionId) {
      const state = stateOf(sessionId);
      const removed = state.edits.length;
      state.edits = [];
      const path = editStatePath(state.sessionId);
      saveEdits(state.sessionId, { edits: [] });
      return { ok: true, removed, path };
    },

    /** What the provider was last told, for the UI to report honestly. */
    recordApplied(sessionId, entries) {
      const state = stateOf(sessionId);
      state.applied = entries;
    },

    /** The last rewrite's outcome for a session. */
    lastApplied(sessionId) {
      return stateOf(sessionId).applied;
    }
  };
}
