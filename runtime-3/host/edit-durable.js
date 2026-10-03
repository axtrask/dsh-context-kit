/**
 * The durable half of the hybrid: an edit written into the session log.
 *
 * A replacement event is an ordinary event. It flows to disk unchanged, survives a
 * restart, is inherited by forks, and reaches every consumer at once — which is why
 * this is the branch to prefer whenever the core permits it.
 *
 * It is permitted **today** for a `user/message` carrier: the edited node occupies the
 * very slot of the node it replaces, so nothing after the edit is cut (the fold is
 * positional — `dsh-session/lib/types/surface.js:370-377`). For an `assistant/message`
 * carrier the shipped core refuses the replacement outright, twice over
 * (`docs/dsh-core.md` §3.4), so that branch belongs to the wire overlay until the ban
 * is lifted.
 *
 * What this module deliberately does NOT do: edit a message that carries tool calls by
 * removing them, or edit a screenshot by removing it. The replacement keeps every block it
 * is not asked to change — an image beside the words stays, which is why such a message is
 * editable at all ({@link editability}) — and {@link editableIndex} only ever offers
 * messages whose text can be replaced in place.
 *
 * @module dsh-context-kit/edit-durable
 */

import {
  messageAnchor,
  canonicalTexts,
  cursorBlockIndex,
  directHumanSource,
  editableTextOf,
  planWireRewrite,
  signedReasoningRefusal
} from './edit.js';

/** The surface event type a durable user edit lands on. */
const USER_EVENT = 'user/message';
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

/** Pure GUI projection; the raw index and the session log remain untouched. */
export function effectiveEditableIndex(session, edits = []) {
  const entries = editableIndex(session);
  const plan = planWireRewrite(entries.map((entry) => entry.message), edits);
  const applied = new Map(plan.applied.map((edit) => [edit.id, edit]));
  const refused = new Set(plan.refused.map((edit) => edit.id));
  return plan.origins.map((originIndex, index) => {
    const entry = entries[originIndex];
    let originSeq = entry.seq;
    let origin = entry.message;
    let event = session.eventAt?.(originSeq) ?? session.log?.[originSeq];
    const durableBlocks = new Set();
    // A suffix is not provenance. Follow only single-user editor replacements,
    // stopping at any DCP/foreign edge or missing/malformed source event.
    while (event?.seq === originSeq && event.type === USER_EVENT && event.data?.role === 'user'
      && ['plugin:edit', 'plugin:context-kit-editor'].includes(event.data?.source?.kind)) {
      const sources = event.sourceEventSeqs;
      const sourceSeq = Array.isArray(sources) && sources.length === 1 ? sources[0] : undefined;
      if (!Number.isInteger(sourceSeq) || sourceSeq < 0 || sourceSeq >= originSeq
        || event.surfaceOp?.op !== 'replace'
        || event.surfaceOp.startSeq !== sourceSeq || event.surfaceOp.endSeq !== sourceSeq) break;
      const source = session.eventAt?.(sourceSeq) ?? session.log?.[sourceSeq];
      if (source?.seq !== sourceSeq || source.type !== USER_EVENT || source.data?.role !== 'user') break;
      const blocks = Array.isArray(event.data.content) ? event.data.content : [];
      for (let at = 0; at < blocks.length; at += 1) {
        if (editableTextOf(blocks[at]) !== editableTextOf(source.data.content?.[at])) durableBlocks.add(at);
      }
      originSeq = sourceSeq;
      origin = source.data;
      event = source;
    }
    const durable = originSeq !== entry.seq;
    const history = edits.filter((edit) => edit.kind !== 'delete-turn' && edit.kind !== 'delete-message'
      && (applied.get(edit.id)?.originIndex === originIndex
        || (edit.messageId !== undefined && entry.id !== undefined && String(edit.messageId) === String(entry.id))));
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
 * With a block index the checks apply to THAT block, its signature included: a reply of
 * `[reasoning, text]` is asked about its thinking by passing `0`, and a signed thinking
 * block is then refused for what it is, even though the same reply's text block is
 * perfectly editable and its message-level answer is `ok`.
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
    // the reasoning; and a reply whose thinking is SIGNED is refused, because the
    // provider's signature is over the old thinking and the adapter re-attaches it to
    // whatever text it is given (`dsh-llm-pi-ai/lib/index.js:198-203`).
    const cursor = selected === undefined ? cursorBlockIndex(entry.message, entry.text) : selected;
    if (cursor === -1) {
      return { ok: false, reason: 'this reply carries no text block to rewrite' };
    }
    if (cursor < 0 || cursor >= blocks.length) {
      return { ok: false, reason: `this reply has no block ${cursor} to rewrite` };
    }
    // A block whose kind carries no text at all cannot be rewritten, and saying so
    // before the text comparison keeps the refusal about what the block IS.
    if (editableTextOf(blocks[cursor]) === undefined) {
      return { ok: false, reason: `a ${String(blocks[cursor]?.type)} block has no editable text` };
    }
    const signed = signedReasoningRefusal(entry.message, cursor);
    if (signed !== undefined) {
      return {
        ok: false,
        reason: `this reply's thinking cannot be rewritten: ${signed}, and the provider would then receive a signature computed over different text`
      };
    }
    return { ok: true, branch: WIRE_BRANCH };
  }
  if (entry.type !== USER_EVENT) {
    return {
      ok: false,
      reason: `a ${entry.type} node cannot be replaced durably on this core; the assistant branch needs the wire overlay`
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
 * Only `text` and `reasoning` blocks become targets: those are the two kinds a message
 * SAYS something with, and the two a person means by "the answer" and "the thinking".
 * Tool calls and tool results are editable on the wire but are not answers, so they are
 * not offered as one.
 *
 * `signed` is why the target may be refused rather than how to refuse it, and it is true
 * for a block whose text the provider holds a signature over — including a redacted
 * thinking block, whose text is not what the provider received
 * ({@link signedReasoningRefusal}). `editable` is the answer the commit will give for
 * this very block, so a surface never draws a control that can only be refused.
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
    const kind = block?.type === 'text' ? 'text' : (block?.type === 'reasoning' ? 'reasoning' : undefined);
    if (kind === undefined) continue;
    const value = editableTextOf(block);
    if (typeof value !== 'string') continue;
    const refusal = signedReasoningRefusal(entry.message, at);
    const allowed = editability(entry, at);
    targets.push({
      at,
      kind,
      label: kind === 'text' ? (entry.role === 'user' ? 'Message' : 'Answer') : 'Thinking',
      text: value,
      chars: value.length,
      signed: refusal !== undefined,
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
  if (options.dryRun === true) return { ok: true, report };

  const appended = session.append(USER_EVENT, replacement, {
    surfaceOp: { op: 'replace', startSeq: entry.seq, endSeq: entry.seq },
    sourceEventSeqs: [entry.seq]
  });
  report.newSeq = appended.seq;
  return { ok: true, report };
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
 * @param options - `session`, `agent`, `config` (`{ enabled, requireIdle }`) and `rawInput`.
 * @returns a command result: `{ kind: 'success' | 'error', text }`.
 */
export function runEditCommand({ session, agent, config, rawInput }) {
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
  if (config?.requireIdle === true && agent?.status !== undefined && agent.status !== 'idle') {
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
  const committed = commitUserEdit(session, entry, newText);
  if (!committed.ok) return { kind: 'error', text: committed.reason };
  return {
    kind: 'success',
    text: `Edited user message #${entry.userIndex} at seq ${entry.seq}. `
      + `The model now receives ${JSON.stringify(committed.report.after)} where it used to receive `
      + `${JSON.stringify(committed.report.before)}; everything after it is untouched and the original stays in the log.`
  };
}
