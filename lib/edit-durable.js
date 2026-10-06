/**
 * The durable half of the hybrid: an edit written into the session log.
 *
 * A replacement event is an ordinary event. It flows to disk unchanged, survives a
 * restart, is inherited by forks, and reaches every consumer at once — which is why
 * this is the branch to prefer whenever the core permits it.
 *
 * It is permitted **today** for two carriers. A `user/message` replacement may rewrite
 * the user message in place. A `tool/result` replacement may shadow exactly one current
 * result while changing ONLY `event.data.message.content`; its envelope, message identity,
 * pairing ids, error state, provenance, and every other field must remain identical. Both
 * replacements occupy the slot of the node they shadow, so nothing after the edit is cut.
 *
 * An `assistant/message` carrier is different: the shipped core refuses its replacement
 * outright, twice over (`docs/dsh-core.md` §3.4), so edits of assistant text, thinking,
 * tool calls, and nested tool results remain wire overlays until that ban is lifted.
 *
 * What this module deliberately does NOT do: remove a tool call while editing its arguments,
 * detach a result from its call, or remove a screenshot beside edited words. Every replacement
 * keeps each block and field it was not asked to change. {@link blockTargets} offers only
 * blocks that genuinely carry canonical editable text.
 *
 * @module dsh-context-kit/edit-durable
 */

import {
  applyEditToMessage,
  messageAnchor,
  canonicalTexts,
  cursorBlockIndex,
  directHumanSource,
  editableTextOf,
  planWireRewrite,
  reasoningHasSignature,
  signedReasoningRefusal
} from './edit.js';

/** The surface event type a durable user edit lands on. */
const USER_EVENT = 'user/message';
/** The content-only surface event type a durable tool-result edit lands on. */
export const TOOL_EVENT = 'tool/result';
/** The node type whose edits cannot be written into the log at all. */
const ASSISTANT_EVENT = 'assistant/message';
/** Replaced in the log, in place. */
export const DURABLE_BRANCH = 'durable';
/** Recorded in the store and applied to the outgoing request. */
export const WIRE_BRANCH = 'wire';

/**
 * The text of a message: the joined text blocks, or a bare string.
 *
 * A reply that says nothing but its REASONING — the shape a DeepSeek turn takes before
 * a tool call — has no text block at all, and the reasoning is then the only thing it
 * says, so it is used. It is used ALONE and only in that case: joining reasoning and
 * text into one string would produce a value matching no single block, and the commit
 * would refuse with "the message does not contain the text this edit was aimed at"
 * after the panel had already shown that string as the text to edit. A reply that has
 * both is edited through its text, and its thinking is left alone.
 */
function textOfMessage(message) {
  if (typeof message?.content === 'string') return message.content;
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const texts = blocks
    .filter((block) => block?.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
  if (texts.length > 0) return texts;
  return blocks
    .filter((block) => block?.type === 'reasoning')
    .map((block) => block.text ?? '')
    .join('');
}

/**
 * Canonical editable text only when the block genuinely carries its text field.
 *
 * `editableTextOf` already returns `undefined` for a nested `tool-result` with no real
 * text item. The explicit structural guard keeps that target rule visible here as well:
 * an image-only or malformed result must never acquire a synthetic editor target. Once a
 * real nested text block exists, the shared canonicaliser remains the single definition.
 */
function genuineEditableText(block) {
  if (block?.type === 'tool-result') {
    const nested = Array.isArray(block.content) ? block.content : [];
    if (!nested.some((item) => item?.type === 'text' && typeof item.text === 'string')) return undefined;
  }
  return editableTextOf(block);
}

/** Whether a message would reach the provider at all. */
function isVisible(message) {
  if (typeof message?.content === 'string') return true;
  if (!Array.isArray(message?.content)) return false;
  if (message.content.length > 0) return true;
  // `deriveEventMessage` (`dsh-session/lib/index.js:209-219`) nulls an empty
  // assistant/system payload; a `tool/result` with empty content still arrives.
  return message.role !== 'assistant' && message.role !== 'system';
}

/**
 * Every user message of a session, as the provider sees it.
 *
 * `index` counts **every** message in the request, so it is the same number the other
 * mechanisms use for an anchor. `userIndex` counts only user messages, which is the
 * number a person typing `/edit 0` means. Both are reported because the two are easy to
 * confuse and confusing them edits the wrong turn.
 *
 * @param session - the live session.
 * @returns an array of `{ seq, id, index, userIndex, role, turn, step, text, blocks, event }`,
 *   where `turn`/`step` are the assistant envelope's position markers when the event
 *   carries them and `undefined` otherwise.
 */
export function editableIndex(session) {
  const nodes = session?.surface?.nodes;
  if (!Array.isArray(nodes)) return [];
  const entries = [];
  let index = 0;
  let userIndex = 0;
  for (const seq of nodes) {
    const event = session.eventAt?.(seq) ?? session.log?.[seq];
    if (event === undefined || event === null) continue;
    const message = event.type === USER_EVENT
      ? event.data
      : (event.data?.message);
    if (message === undefined || message === null) continue;
    if (!isVisible(message)) continue;
    // WHERE A REPLY LIVES, for the surfaces that cannot name it by id. An
    // `assistant/message` envelope carries `{ turn, step, message, stream, usage? }`
    // (`dsh-agent-loop/lib/index.js:1108-1114`), and the GUI's transcript row for a
    // reply is keyed `<flow>:assistant-step<turn>:<step>` — the id is not in that
    // row at all, while the turn and the step are. Both numbers are therefore
    // carried on the entry, so a row can be matched to the reply it shows without
    // anyone guessing. Undefined rather than 0 when the envelope has none: 0 is a
    // number a row could legitimately be matched against, `undefined` is not.
    const envelope = event.data ?? {};
    const entry = {
      seq,
      type: event.type,
      role: message.role,
      id: message.id,
      index,
      userIndex: event.type === USER_EVENT ? userIndex : undefined,
      turn: Number.isInteger(envelope.turn) ? envelope.turn : undefined,
      step: Number.isInteger(envelope.step) ? envelope.step : undefined,
      text: textOfMessage(message),
      blocks: canonicalTexts(message).length,
      sourceKind: message.source?.kind,
      directUser: event.type === USER_EVENT && directHumanSource(message.source?.kind),
      message
    };
    entries.push(entry);
    index += 1;
    if (event.type === USER_EVENT) userIndex += 1;
  }
  return entries;
}

/** JSON-value equality without depending on object key insertion order. */
function sameJsonValue(left, right) {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, at) => sameJsonValue(value, right[at]));
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => (
    Object.prototype.hasOwnProperty.call(right, key) && sameJsonValue(left[key], right[key])
  ));
}

/** The message carried by one event kind whose durable replacement provenance is supported. */
function provenanceMessage(event) {
  if (event?.type === USER_EVENT) return event.data;
  if (event?.type === TOOL_EVENT) return event.data?.message;
  return undefined;
}

/**
 * Follow one proven single-node durable replacement edge, or stop at an unsafe edge.
 *
 * User provenance keeps its original editor-source rule exactly. A host `tool/result`
 * has no spare provenance field: the core permits the replacement only when every value
 * outside `data.message.content` is identical, so that content-only identity is its safe
 * discriminator here as well.
 */
function durableReplacementSource(session, event) {
  const sources = event?.sourceEventSeqs;
  const sourceSeq = Array.isArray(sources) && sources.length === 1 ? sources[0] : undefined;
  if (!Number.isInteger(event?.seq) || !Number.isInteger(sourceSeq) || sourceSeq < 0 || sourceSeq >= event.seq
    || event.surfaceOp?.op !== 'replace'
    || event.surfaceOp.startSeq !== sourceSeq || event.surfaceOp.endSeq !== sourceSeq) return undefined;
  const source = session.eventAt?.(sourceSeq) ?? session.log?.[sourceSeq];
  if (source?.seq !== sourceSeq) return undefined;

  if (event.type === USER_EVENT) {
    if (event.data?.role !== 'user'
      || !['plugin:edit', 'plugin:context-kit-editor'].includes(event.data?.source?.kind)
      || source.type !== USER_EVENT || source.data?.role !== 'user') return undefined;
    return source;
  }

  if (event.type !== TOOL_EVENT || source.type !== TOOL_EVENT
    || hostToolResultRefusal(event) !== undefined || hostToolResultRefusal(source) !== undefined) return undefined;
  const currentData = { ...event.data, message: { ...event.data.message, content: null } };
  const sourceData = { ...source.data, message: { ...source.data.message, content: null } };
  return sameJsonValue(currentData, sourceData) ? source : undefined;
}

/** Pure GUI projection; the raw index and the session log remain untouched. */
export function effectiveEditableIndex(session, edits = [], rawEntries) {
  const entries = Array.isArray(rawEntries) ? rawEntries : editableIndex(session);
  const plan = planWireRewrite(entries.map((entry) => entry.message), edits);
  const applied = new Map(plan.applied.map((edit) => [edit.id, edit]));
  const refused = new Set(plan.refused.map((edit) => edit.id));
  const entryOriginsByMessageId = new Map();
  for (const [originIndex, entry] of entries.entries()) {
    if (entry.id === undefined) continue;
    const key = String(entry.id);
    const origins = entryOriginsByMessageId.get(key) ?? [];
    origins.push(originIndex);
    entryOriginsByMessageId.set(key, origins);
  }
  const historyByOrigin = new Map();
  for (const edit of edits) {
    if (['delete-turn', 'delete-message', 'truncate-after'].includes(edit.kind)) continue;
    const origins = new Set();
    const appliedOrigin = applied.get(edit.id)?.originIndex;
    if (Number.isInteger(appliedOrigin)) origins.add(appliedOrigin);
    if (edit.messageId !== undefined) {
      for (const originIndex of entryOriginsByMessageId.get(String(edit.messageId)) ?? []) origins.add(originIndex);
    }
    for (const originIndex of origins) {
      const history = historyByOrigin.get(originIndex) ?? [];
      history.push(edit);
      historyByOrigin.set(originIndex, history);
    }
  }
  return plan.origins.map((originIndex, index) => {
    const entry = entries[originIndex];
    let originSeq = entry.seq;
    let origin = entry.message;
    let event = session.eventAt?.(originSeq) ?? session.log?.[originSeq];
    const durableBlocks = new Set();
    // A suffix is not provenance. Follow only a proven single-node editor-user edge or
    // an exact content-only host-result edge, stopping at foreign/malformed history.
    while (event?.seq === originSeq) {
      const source = durableReplacementSource(session, event);
      if (source === undefined) break;
      const currentMessage = provenanceMessage(event);
      const sourceMessage = provenanceMessage(source);
      const blocks = Array.isArray(currentMessage?.content) ? currentMessage.content : [];
      const sourceBlocks = Array.isArray(sourceMessage?.content) ? sourceMessage.content : [];
      for (let at = 0; at < Math.max(blocks.length, sourceBlocks.length); at += 1) {
        if (editableTextOf(blocks[at]) !== editableTextOf(sourceBlocks[at])) durableBlocks.add(at);
      }
      originSeq = source.seq;
      origin = sourceMessage;
      event = source;
    }
    const durable = originSeq !== entry.seq;
    const history = historyByOrigin.get(originIndex) ?? [];
    const message = plan.messages[index];
    const metadata = (at) => {
      const here = at === undefined ? history : history.filter((edit) => edit.cursor.block === at);
      const durableHere = at === undefined ? durable : durableBlocks.has(at);
      const didApply = durableHere || here.some((edit) => applied.has(edit.id));
      const didRefuse = here.some((edit) => refused.has(edit.id));
      return {
        originalText: at !== undefined && origin.content?.[at]?.type === message.content?.[at]?.type
          ? editableTextOf(origin.content[at]) : undefined,
        edited: durableHere || here.length > 0,
        changed: at === undefined
          ? JSON.stringify(message.content) !== JSON.stringify(origin.content)
          : editableTextOf(message.content?.[at]) !== editableTextOf(origin.content?.[at]),
        editStatus: didRefuse ? (didApply ? 'mixed' : 'refused') : (didApply ? 'applied' : 'none')
      };
    };
    const effective = {
      ...entry,
      effectiveIndex: index,
      message,
      text: textOfMessage(message),
      blocks: canonicalTexts(message).length,
      sourceKind: message.source?.kind,
      originSeq,
      originId: origin.id,
      originSourceKind: origin.source?.kind,
      directUser: entry.type === USER_EVENT && directHumanSource(origin.source?.kind),
      ...metadata()
    };
    return { ...effective, targets: blockTargets(effective).map((target) => ({ ...target, ...metadata(target.at) })) };
  });
}

/**
 * The user messages an edit may target, in order — each with the message object that
 * `validateEdit` and the anchor machinery expect.
 */
export function userMessages(session) {
  return editableIndex(session).filter((entry) => entry.type === USER_EVENT);
}

/**
 * Resolve a target a person named.
 *
 * A negative number counts back from the end (`-1` is the last user message), which is
 * what someone who just typed a message means. A non-negative number is a `userIndex`.
 * A string is matched against message ids, exactly, with a single-character prefix
 * accepted when it is unambiguous — ids are long and nobody types them in full.
 *
 * @param session - the live session.
 * @param target - `-1`, `0`, `"3"` or an id (or id prefix).
 * @returns `{ entry }` or `{ reason, choices }`.
 */
export function resolveTarget(session, target) {
  const users = userMessages(session);
  if (users.length === 0) return { reason: 'this session has no user messages yet' };
  const raw = String(target ?? '').trim();
  if (/^-\d+$/.test(raw)) {
    const back = Number(raw);
    const entry = users[users.length + back];
    if (entry === undefined) {
      return { reason: `there is no user message ${back} from the end (${users.length} available)` };
    }
    return { entry };
  }
  if (/^\d+$/.test(raw)) {
    const wanted = Number(raw);
    const entry = users.find((candidate) => candidate.userIndex === wanted);
    if (entry === undefined) return { reason: `there is no user message #${wanted} (${users.length} available)` };
    return { entry };
  }
  const exact = users.find((candidate) => String(candidate.id) === raw);
  if (exact !== undefined) return { entry: exact };
  const prefixed = users.filter((candidate) => String(candidate.id).startsWith(raw));
  if (prefixed.length === 1) return { entry: prefixed[0] };
  if (prefixed.length === 0) return { reason: `no user message has an id starting with ${JSON.stringify(raw)}` };
  return { reason: `id prefix ${JSON.stringify(raw)} matches ${prefixed.length} messages`, choices: prefixed };
}

/**
 * Whether one entry can be rewritten in place at all, and why not when it cannot.
 *
 * THIS IS THE ONLY COPY OF THE RULE, and that is the point: the commit and every
 * surface that promises an edit both call it, so a panel can never offer a Save
 * the durable branch will refuse. It used to live only inside
 * {@link commitUserEdit}, and the panel re-derived it from a field it had
 * misread — `entry.blocks` is the NUMBER of editable texts
 * (`editableIndex`, below), not the block array, so the panel's
 * `Array.isArray(entry.blocks)` was false for every message and its list said
 * "cannot be edited here" about every message of every session, including the
 * user's own plain text. One rule, one place, one answer.
 *
 * WHICH BLOCK THE ANSWER IS ABOUT is the second argument. Without it the answer is
 * about the block `entry.text` belongs to — the block {@link cursorBlockIndex} selects
 * for the commit — and that is the meaning this function has always had, unchanged.
 * With a block index the checks apply to THAT block: a reply of `[reasoning, text]` is
 * asked about its thinking by passing `0`. Signed thinking is editable because commit
 * strips stale signatures; redacted thinking is refused even though the same reply's
 * text block is perfectly editable and its message-level answer is `ok`.
 *
 * CARRYING MORE THAN TEXT IS NOT A REFUSAL. A user message that holds a pasted screenshot
 * beside its words is editable like any other: the block the edit is aimed at is rewritten
 * and the screenshot is copied into the replacement untouched, so nothing is deleted and
 * nothing has to be refused on the person's behalf. What is refused is a message with no
 * text block at all — there is then no words for the replacement to say — and a selected
 * block that is not text, because a durable edit rewrites text.
 *
 * @param entry - an entry from {@link editableIndex}.
 * @param at - the block index the question is about, or `undefined` for the default.
 * @returns `{ ok: true, branch }`, or `{ ok: false, reason }` in the words the surfaces show.
 */
export function editability(entry, at) {
  if (entry === undefined || entry === null) return { ok: false, reason: 'no message to edit' };
  const blocks = Array.isArray(entry.message?.content) ? entry.message.content : [];
  const selected = Number.isInteger(at) ? at : undefined;
  if (entry.type === ASSISTANT_EVENT) {
    // The WIRE branch. The log cannot hold this edit - an assistant node embeds its
    // own source stream and the core refuses a replacement for it - so the edit is
    // recorded in the store and applied to the outgoing request instead. What the
    // overlay needs is a message that carries the text it is aimed at; the anchor
    // matches role and block identity, so a reply that also carries reasoning or a
    // tool call is editable as long as one block holds text.
    //
    // WHICH BLOCK, exactly, is `entry.text`'s block - the same selection the commit
    // performs ({@link cursorBlockIndex}) - and it is checked HERE rather than "is there
    // any text block anywhere". A reply of [reasoning, text] is edited through its text
    // and its thinking stays untouched; a reply of [reasoning] alone is edited through
    // the reasoning. A signed reasoning rewrite is safe because the wire replacement
    // strips the stale signature from both visible and replay-state blocks. Redacted
    // reasoning is refused because its visible text is not the provider payload.
    const cursor = selected === undefined ? cursorBlockIndex(entry.message, entry.text) : selected;
    if (cursor === -1) {
      return { ok: false, reason: 'this reply carries no text block to rewrite' };
    }
    if (cursor < 0 || cursor >= blocks.length) {
      return { ok: false, reason: `this reply has no block ${cursor} to rewrite` };
    }
    // Redaction is permanent provider state, not merely a block with a missing text field.
    // Report that specific reason before the generic no-text refusal so an opaque thinking
    // block remains explainable even when it has no display text at all.
    const reasoningRefusal = signedReasoningRefusal(entry.message, cursor);
    if (reasoningRefusal !== undefined) {
      return {
        ok: false,
        reason: `this reply's thinking cannot be rewritten: ${reasoningRefusal}`
      };
    }
    if (genuineEditableText(blocks[cursor]) === undefined) {
      return { ok: false, reason: `a ${String(blocks[cursor]?.type)} block has no editable text` };
    }
    return { ok: true, branch: WIRE_BRANCH };
  }
  if (entry.type === TOOL_EVENT) {
    // The core has one narrow durable seam for tool results: replace one current result
    // while changing its message content and nothing else. The selected block is checked
    // here with the same canonical text rule the wire editor uses; commitToolResultEdit
    // later rebuilds ONLY the containing `message.content` array.
    const cursor = selected === undefined ? cursorBlockIndex(entry.message, entry.text) : selected;
    if (cursor === -1) return { ok: false, reason: 'this tool result carries no editable text block' };
    if (cursor < 0 || cursor >= blocks.length) {
      return { ok: false, reason: `this tool result has no block ${cursor} to rewrite` };
    }
    const reasoningRefusal = signedReasoningRefusal(entry.message, cursor);
    if (reasoningRefusal !== undefined) {
      return {
        ok: false,
        reason: `this tool result's thinking cannot be rewritten: ${reasoningRefusal}`
      };
    }
    if (genuineEditableText(blocks[cursor]) === undefined) {
      return { ok: false, reason: `a ${String(blocks[cursor]?.type)} block has no editable text` };
    }
    if (reasoningHasSignature(entry.message, cursor)) {
      return {
        ok: false,
        reason: 'signed thinking cannot be rewritten by a content-only tool-result replacement'
      };
    }
    return { ok: true, branch: DURABLE_BRANCH };
  }
  if (entry.type !== USER_EVENT) {
    return {
      ok: false,
      reason: `a ${entry.type} node has no supported durable or wire edit branch`
    };
  }
  // A selected block must be text, because the text is what a durable edit rewrites.
  if (selected !== undefined) {
    if (selected < 0 || selected >= blocks.length) {
      return { ok: false, reason: `this message has no block ${selected} to rewrite` };
    }
    if (blocks[selected]?.type !== 'text') {
      return {
        ok: false,
        reason: `block ${selected} of this message is a ${String(blocks[selected]?.type)} block, and a durable edit rewrites the text blocks`
      };
    }
  }
  // A MESSAGE IS NOT REFUSED FOR CARRYING MORE THAN TEXT. It used to be: the replacement was
  // assembled as a single text block, so an image beside the words would have been dropped
  // with it, and a refusal was the honest way to keep that promise. The replacement is built
  // the other way round now — every block the edit is not about is copied into it untouched
  // (`commitUserEdit`) — so a pasted screenshot is no reason to withhold the editor, and the
  // only message that cannot be rewritten durably is one whose text has nothing to rewrite.
  // A message with no block array at all is a bare string, and a durable edit replaces it.
  if (blocks.length === 0) return { ok: true, branch: DURABLE_BRANCH };
  if (!blocks.some((block) => block?.type === 'text')) {
    return {
      ok: false,
      reason: 'this message carries no text block, and a durable edit rewrites the text of a message'
    };
  }
  return { ok: true, branch: DURABLE_BRANCH };
}

/**
 * The editable targets of a message, one per block, in block order.
 *
 * A message is not one editable thing. A reply of `[reasoning, text]` says two things,
 * and until this function existed the panel could only reach the text: the thinking was
 * offered by {@link editability} only for a reply that had no text at all. A surface that
 * wants a control per block — the pencil beside the transcript row, the target picker in
 * the panel — asks here, and gets the same selection the commit performs
 * ({@link cursorBlockIndex} by default, the block index when one is named).
 *
 * `text`, `reasoning`, `tool-call`, and legacy nested `tool-result` blocks become
 * targets when they genuinely carry canonical editable text. Opaque redacted reasoning
 * is the deliberate exception: it stays visible with empty display text so the surface
 * can show its permanent redaction refusal instead of silently hiding it. Their labels
 * are Message or Answer, Thinking, Tool call, and Tool result. A host `tool/result`
 * event carries ordinary top-level text blocks, but those blocks are labelled Tool result
 * because that is the surface a person is editing.
 *
 * `signed` reports provider metadata independently of editability. It is true for a
 * signed block, whose stale signature is stripped on rewrite, and for a redacted block,
 * whose text is not what the provider received and is therefore refused
 * ({@link signedReasoningRefusal}). `editable` is the answer the commit will give for
 * this very block, so a surface can disable it and explain the refusal without hiding it.
 *
 * @param entry - an entry from {@link editableIndex}.
 * @returns an array of `{ at, kind, label, text, chars, signed, editable, reason }`, in
 *   block order; empty when the message says nothing editable.
 */
export function blockTargets(entry) {
  const blocks = Array.isArray(entry?.message?.content) ? entry.message.content : [];
  const targets = [];
  for (let at = 0; at < blocks.length; at += 1) {
    const block = blocks[at];
    const kind = ['text', 'reasoning', 'tool-call', 'tool-result'].includes(block?.type)
      ? block.type
      : undefined;
    if (kind === undefined) continue;
    const value = genuineEditableText(block);
    const redaction = kind === 'reasoning' ? signedReasoningRefusal(entry.message, at) : undefined;
    if (typeof value !== 'string' && redaction === undefined) continue;
    const displayText = typeof value === 'string' ? value : '';
    const allowed = editability(entry, at);
    const label = kind === 'reasoning'
      ? 'Thinking'
      : kind === 'tool-call'
        ? 'Tool call'
        : kind === 'tool-result' || entry.type === TOOL_EVENT
          ? 'Tool result'
          : (entry.role === 'user' ? 'Message' : 'Answer');
    targets.push({
      at,
      kind,
      label,
      text: displayText,
      chars: displayText.length,
      signed: reasoningHasSignature(entry.message, at),
      editable: allowed.ok === true,
      reason: allowed.ok === true ? undefined : allowed.reason
    });
  }
  return targets;
}

/**
 * Write an edit into the log.
 *
 * The replacement cites the node it shadows through `sourceEventSeqs`, which is not
 * optional: the fold refuses a replacement that does not account for every node in the
 * range it claims (this is the same contract `compaction/prune` uses). The report tells
 * the caller what to expect, and `{ dryRun: true }` computes everything without
 * appending — the honest way for a UI to show a diff before committing.
 *
 * @param session - the live session.
 * @param entry - an entry from {@link userMessages}.
 * @param newText - the replacement text.
 * @param options - `dryRun`, `source`, and optional `blockAt` to replace only that text block.
 * @returns `{ ok, report }` or `{ ok: false, reason }`.
 */
export function commitUserEdit(session, entry, newText, options = {}) {
  if (typeof newText !== 'string' || newText.trim().length === 0) {
    return { ok: false, reason: 'the replacement text is empty' };
  }
  const at = options.blockAt;
  if (at !== undefined && !Number.isInteger(at)) return { ok: false, reason: 'blockAt is not a block index' };
  const allowed = editability(entry, at);
  if (allowed.ok !== true) return allowed;
  if (allowed.branch !== DURABLE_BRANCH) {
    // THIS function is the durable branch. An assistant node is editable, but only
    // on the wire, so accepting it here would append a replacement the fold refuses
    // ("assistant/message embeds its source stream and cannot carry sourceEventSeqs").
    return {
      ok: false,
      reason: `a ${entry.type} node cannot be replaced durably on this core; the assistant branch needs the wire overlay`
    };
  }
  if (entry.type !== USER_EVENT) {
    // `tool/result` has its own much narrower content-only replacement. Keeping the
    // functions separate prevents this user-message branch from changing its id, role,
    // source, or any other field the core requires a result rewrite to preserve.
    return {
      ok: false,
      reason: `a ${entry.type} node must be committed through commitToolResultEdit`
    };
  }
  const before = entry.message;
  const blocks = Array.isArray(before.content) ? before.content : [];
  const beforeText = at === undefined ? textOfMessage(before) : editableTextOf(blocks[at]);
  if (beforeText === newText) return { ok: false, reason: 'the text is unchanged' };
  // AN EDIT TOUCHES THE TEXT AND NOTHING ELSE. The block the edit is aimed at is rewritten
  // in place; when the whole message is the subject, every text block is, and every block
  // that is not text — a pasted screenshot, a file — is copied into the replacement exactly
  // as it stands. The branch that used to build a bare one-block replacement for a message
  // with a single text block existed only to make the old refusal at `editability` true,
  // and it went with the refusal.
  const rewrite = (block) => (block?.type === 'text' ? { ...block, text: newText } : block);
  const content = blocks.length === 0
    ? [{ type: 'text', text: newText }]
    : (at !== undefined
      ? blocks.map((block, index) => (index === at ? { ...block, text: newText } : block))
      : blocks.map(rewrite));

  const replacement = {
    ...before,
    id: `${String(before.id ?? 'message')}-edited`,
    role: 'user',
    content,
    source: options.source ?? { kind: 'plugin:edit' }
  };

  const anchor = messageAnchor(before, entry.index);
  const report = {
    seq: entry.seq,
    messageId: before.id,
    replacementId: replacement.id,
    index: entry.index,
    userIndex: entry.userIndex,
    before: beforeText,
    after: newText,
    ...(at === undefined ? {} : { block: at }),
    anchor,
    dryRun: options.dryRun === true
  };
  if (options.dryRun === true) return { ok: true, report, replacement };

  const appended = session.append(USER_EVENT, replacement, {
    surfaceOp: { op: 'replace', startSeq: entry.seq, endSeq: entry.seq },
    sourceEventSeqs: [entry.seq]
  });
  report.newSeq = appended.seq;
  return { ok: true, report, replacement };
}

function nonEmptyToolId(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validate the immutable identity and pairing fields of a host `tool/result`.
 *
 * The session core performs the final deep content-only assertion when the replacement
 * is appended. These earlier checks turn malformed and unpaired inputs into ordinary
 * refusals instead of asking the fold to diagnose an editor target after the fact.
 */
function hostToolResultRefusal(event) {
  const data = event?.data;
  const message = data?.message;
  if (event?.type !== TOOL_EVENT) return 'the current surface node is not a tool/result';
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return 'the tool result has no event data envelope';
  }
  if (!Number.isSafeInteger(data.turn) || !Number.isSafeInteger(data.step)) {
    return 'the tool result has no valid turn and step';
  }
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return 'the tool result has no message';
  }
  if (message.role !== 'tool') return 'the tool result message does not have role tool';
  if (!nonEmptyToolId(message.id)) return 'the tool result message has no identity';
  if (!Array.isArray(message.content)) return 'the tool result message has no content block array';
  if (typeof message.isError !== 'boolean') return 'the tool result message has no error state';
  if (!nonEmptyToolId(message.toolCallId)) return 'the tool result message has no pairing id';
  if (message.source === null || typeof message.source !== 'object' || message.source.kind !== 'tool') {
    return 'the tool result message has no canonical tool source';
  }
  if (!nonEmptyToolId(message.source.callId)) return 'the tool result source has no pairing id';
  if (message.toolCallId !== message.source.callId) {
    return 'the tool result message and source pairing ids do not match';
  }
  return undefined;
}

/** Count current assistant tool calls paired to one result before its surface slot. */
function precedingToolCallCount(session, targetAt, callId) {
  let matches = 0;
  for (let at = 0; at < targetAt; at += 1) {
    const event = session.eventAt?.(session.surface.nodes[at]);
    if (event?.type !== ASSISTANT_EVENT) continue;
    const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
    for (const block of blocks) {
      if (block?.type === 'tool-call' && nonEmptyToolId(block.id) && block.id === callId) matches += 1;
    }
  }
  return matches;
}

/**
 * Durably rewrite one selected block of a current host `tool/result`.
 *
 * This is intentionally separate from {@link commitUserEdit}. The core permits this
 * replacement only when exactly one current result is shadowed and every field except
 * `event.data.message.content` is deep-equal to the original. Shared
 * {@link applyEditToMessage} supplies the canonical block transform (including legacy
 * nested `tool-result` content); only its `content` is retained, so helper metadata and
 * replay-state changes cannot leak into the durable event.
 *
 * @param session - the live session.
 * @param entry - a current `tool/result` entry from {@link editableIndex}.
 * @param newText - non-empty replacement text.
 * @param options - `dryRun` and optional `blockAt` (the selected content block).
 * @returns `{ ok, report, replacement, data }` or `{ ok: false, reason }`.
 */
export function commitToolResultEdit(session, entry, newText, options = {}) {
  if (typeof newText !== 'string' || newText.trim().length === 0) {
    return { ok: false, reason: 'the replacement text is empty' };
  }
  const requestedAt = options.blockAt;
  if (requestedAt !== undefined && !Number.isInteger(requestedAt)) {
    return { ok: false, reason: 'blockAt is not a block index' };
  }
  if (entry?.type !== TOOL_EVENT) {
    return { ok: false, reason: 'commitToolResultEdit requires a tool/result entry' };
  }
  if (!Number.isSafeInteger(entry.seq)) {
    return { ok: false, reason: 'the tool result entry has no valid event sequence' };
  }

  const nodes = session?.surface?.nodes;
  if (!Array.isArray(nodes)) return { ok: false, reason: 'the session has no current surface' };
  const positions = [];
  for (let index = 0; index < nodes.length; index += 1) {
    if (nodes[index] === entry.seq) positions.push(index);
  }
  if (positions.length !== 1) {
    return {
      ok: false,
      reason: positions.length === 0
        ? 'the tool result is no longer a current surface node'
        : 'the tool result appears more than once on the current surface'
    };
  }

  const event = session.eventAt?.(entry.seq);
  const malformed = hostToolResultRefusal(event);
  if (malformed !== undefined) return { ok: false, reason: malformed };
  const currentMessage = event.data.message;
  const pairingCount = precedingToolCallCount(session, positions[0], currentMessage.toolCallId);
  if (pairingCount !== 1) {
    return {
      ok: false,
      reason: pairingCount === 0
        ? `the tool result is unpaired: no preceding current tool call has id ${currentMessage.toolCallId}`
        : `the tool result is ambiguous: ${pairingCount} preceding current tool calls have id ${currentMessage.toolCallId}`
    };
  }

  const selectedAt = requestedAt === undefined
    ? cursorBlockIndex(entry.message, entry.text)
    : requestedAt;
  const allowed = editability(entry, selectedAt);
  if (allowed.ok !== true) return allowed;
  if (allowed.branch !== DURABLE_BRANCH) {
    return { ok: false, reason: 'the selected tool result block is not on the durable branch' };
  }

  const entryBlocks = Array.isArray(entry.message?.content) ? entry.message.content : [];
  const currentBlocks = currentMessage.content;
  const before = genuineEditableText(entryBlocks[selectedAt]);
  const currentText = genuineEditableText(currentBlocks[selectedAt]);
  if (typeof currentText !== 'string') {
    return { ok: false, reason: `the current tool result has no editable text at block ${selectedAt}` };
  }
  if (before !== currentText) {
    return { ok: false, reason: 'the selected tool result block is stale' };
  }
  const currentAllowed = editability({
    ...entry,
    type: TOOL_EVENT,
    text: textOfMessage(currentMessage),
    message: currentMessage
  }, selectedAt);
  if (currentAllowed.ok !== true) return currentAllowed;
  if (currentText === newText) return { ok: false, reason: 'the text is unchanged' };

  const rewritten = applyEditToMessage(
    currentMessage,
    { before: currentText, after: newText },
    selectedAt,
    entry.index
  );
  if (rewritten === undefined || !Array.isArray(rewritten.content)) {
    return { ok: false, reason: 'the selected tool result block could not be rewritten' };
  }
  const replacement = { ...currentMessage, content: rewritten.content };
  const data = { ...event.data, message: replacement };
  const report = {
    branch: DURABLE_BRANCH,
    type: TOOL_EVENT,
    seq: entry.seq,
    messageId: currentMessage.id,
    index: entry.index,
    before: currentText,
    after: newText,
    block: selectedAt,
    anchor: messageAnchor(currentMessage, entry.index),
    dryRun: options.dryRun === true
  };
  if (options.dryRun === true) return { ok: true, report, replacement, data };

  const appended = session.append(TOOL_EVENT, data, {
    surfaceOp: { op: 'replace', startSeq: entry.seq, endSeq: entry.seq },
    sourceEventSeqs: [entry.seq]
  });
  report.newSeq = appended.seq;
  return { ok: true, report, replacement, data };
}

/**
 * Render the user messages of a session as a numbered list, for a command reply.
 *
 * Truncated on purpose: a reply that echoes whole conversations is the failure this
 * plugin exists to prevent.
 *
 * @param session - the live session.
 * @param options - `limit` (default 12), `width` (default 80), and optional projected `entries`.
 * @returns the listing text.
 */
export function renderEditableList(session, options = {}) {
  const users = (options.entries ?? editableIndex(session)).filter((entry) => entry.type === USER_EVENT);
  if (users.length === 0) return 'no user messages yet';
  const limit = options.limit ?? 12;
  const width = options.width ?? 80;
  const shown = users.slice(-limit);
  const lines = shown.map((entry) => {
    const flat = entry.text.replace(/\s+/g, ' ').trim();
    const body = flat.length > width ? `${flat.slice(0, width)}…` : flat;
    const marker = entry.userIndex === users.length - 1 ? ' (last)' : '';
    return `  [${entry.userIndex}] seq ${entry.seq} id ${String(entry.id).slice(0, 8)} — ${body}${marker}`;
  });
  const head = users.length > shown.length
    ? `${users.length} user message(s), last ${shown.length}:`
    : `${users.length} user message(s):`;
  return [head, ...lines, '', 'Edit one with: /edit <#|id|-1> <new text>'].join('\n');
}

/**
 * The whole `/edit` behaviour, as one function so a test can drive it.
 *
 * Kept out of the command registration on purpose: a handler that can only be reached
 * through a live slash command is a handler nobody tests, and the refused cases below are
 * the ones that matter. The command layer supplies the session, the agent and the config.
 *
 * @param options - `session`, optional `agent` and overlay `store`, `config` (`{ enabled }`), and `rawInput`.
 * @returns a command result, or a promise for one while a durable append is flushed.
 */
function sessionsService(agent) {
  for (const context of [agent?.ctx, agent?.ctx?.root]) {
    try {
      const sessions = context?.get?.('sessions');
      if (sessions !== undefined) return sessions;
    } catch {
      // Try the root scope when the agent scope cannot publish Host services.
    }
  }
  return undefined;
}

async function settleCommandRebase(agent, session, rebase, success) {
  try {
    const sessions = sessionsService(agent);
    if (typeof sessions?.flush !== 'function') {
      return { kind: 'error', text: 'The edit was appended, but session durability could not be confirmed. Recovery is still required.' };
    }
    const flushed = await sessions.flush(session);
    if (flushed !== true) {
      return { kind: 'error', text: 'The edit was appended, but no session persistence listener confirmed it. Recovery is still required.' };
    }
  } catch (error) {
    return {
      kind: 'error',
      text: `The edit was appended, but session persistence failed: ${String(error?.message ?? error)}. Recovery is still required.`
    };
  }
  try {
    const committed = rebase.commit();
    if (committed?.ok === false) {
      return {
        kind: 'error',
        text: `The edit was appended, but its prepared rebase could not be committed: ${committed.reason}. Recovery is still required.`
      };
    }
  } catch (error) {
    return {
      kind: 'error',
      text: `The edit was appended, but its prepared rebase could not be committed: ${String(error?.message ?? error)}. Recovery is still required.`
    };
  }
  return success;
}

export function runEditCommand({ session, agent, store, config, rawInput }) {
  if (config?.enabled !== true) {
    return {
      kind: 'error',
      text: 'The history editor is off. Set `editor.enabled: true` in the plugin config to turn it on '
        + '(the durable branch is tested; the wire branch for assistant replies is still being proven).'
    };
  }
  const raw = String(rawInput ?? '').trim();
  if (raw.length === 0) return { kind: 'success', text: renderEditableList(session) };

  const target = raw.split(/\s+/, 1)[0];
  const newText = raw.slice(target.length).replace(/^\s+/, '');
  const resolved = resolveTarget(session, target);
  if (resolved.entry === undefined) {
    const choices = (resolved.choices ?? [])
      .map((entry) => `  [${entry.userIndex}] seq ${entry.seq} id ${String(entry.id).slice(0, 8)} — ${entry.text.slice(0, 60)}`)
      .join('\n');
    return { kind: 'error', text: [resolved.reason, choices].filter((line) => line.length > 0).join('\n') };
  }
  const entry = resolved.entry;
  if (newText.length === 0) {
    return {
      kind: 'success',
      text: [
        `user message #${entry.userIndex} (seq ${entry.seq}, id ${String(entry.id).slice(0, 8)}):`,
        `  now: ${entry.text}`,
        '',
        `Replace it with: /edit ${target} <new text>`
      ].join('\n')
    };
  }
  if (agent?.status !== undefined && agent.status !== 'idle') {
    return {
      kind: 'error',
      text: `The agent is ${String(agent.status)}. Wait for it to finish before editing history: a written edit `
        + 'changes what the next request is built from, and landing one mid-step desynchronizes the loop.'
    };
  }
  // Dry run first, so a refusal is reported before anything is written. The two calls share
  // every check; the only difference is the append, and this way the reply cannot describe
  // a change that did not happen.
  const preview = commitUserEdit(session, entry, newText, { dryRun: true });
  if (!preview.ok) return { kind: 'error', text: preview.reason };
  const rebase = store?.prepareTruncateAnchorRebase?.(session?.id, entry.id, preview.replacement);
  if (rebase?.ok === false) return { kind: 'error', text: rebase.reason };
  let committed;
  try {
    committed = commitUserEdit(session, entry, newText);
  } catch (error) {
    rebase?.rollback?.();
    throw error;
  }
  if (!committed.ok) {
    rebase?.rollback?.();
    return { kind: 'error', text: committed.reason };
  }
  const success = {
    kind: 'success',
    text: `Edited user message #${entry.userIndex} at seq ${entry.seq}. `
      + `The model now receives ${JSON.stringify(committed.report.after)} where it used to receive `
      + `${JSON.stringify(committed.report.before)}; everything after it is untouched and the original stays in the log.`
  };
  return rebase === undefined ? success : settleCommandRebase(agent, session, rebase, success);
}
