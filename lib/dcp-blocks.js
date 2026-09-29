/**
 * DCP compression state, ported from upstream `lib/state/*`.
 *
 * THE ARCHITECTURAL POINT. Upstream never edits the conversation: its README
 * says "Your session history is never modified — DCP replaces pruned content
 * with placeholders before sending requests to your LLM". Concretely, its
 * `createChatMessageTransformHandler` (`lib/hooks.ts`) receives the OUTGOING
 * message array of every request and rewrites that array in place — the stored
 * session is untouched, and the summary lives in DCP's own state
 * (`state.prune.messages.blocksById`), injected as a synthetic user message at
 * the block's anchor.
 *
 * This module is that state, expressed for DSH:
 *
 *   - a block is `{ blockId, topic, summary, anchorMessageId, shadowedMessageIds }`;
 *   - every id is a DURABLE message id (DSH brands every message with one, and
 *     the same id rides the session event, the derived history and the request),
 *     so addressing survives a surface rewrite, a compaction and a restart —
 *     exactly what upstream gets from `byMessageId` / `activeByAnchorMessageId`;
 *   - the whole state is persisted per session as JSON, upstream's
 *     `lib/state/persistence.ts`.
 *
 * Addressing by message id rather than by position is the reason a compression
 * stays valid after the session changes underneath it: nothing is re-derived
 * from offsets that later shift.
 *
 * @module dsh-context-kit/dcp-blocks
 */

import { randomUUID } from 'node:crypto';
import { SessionSeq, adoptSessionEvent } from '@deepseek-ai/dsh-session';
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values';
import { formatMessageRef, parseMessageRef } from './dcp-message-ids.js';

export const DCP_STATE_VERSION = 4;

function restoredStats(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const number = (key) => typeof source[key] === 'number' && Number.isFinite(source[key]) && source[key] >= 0 ? source[key] : 0;
  return {
    deduplicationRuns: number('deduplicationRuns'),
    deduplicationNodes: number('deduplicationNodes'),
    purgeErrorRuns: number('purgeErrorRuns'),
    purgeErrorNodes: number('purgeErrorNodes'),
    sweepRuns: number('sweepRuns'),
    sweepNodes: number('sweepNodes'),
    compressions: number('compressions'),
    compressionNodes: number('compressionNodes')
  };
}

function restoredNudges(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const strings = (value) => new Set(Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : []);
  return {
    calls: Number.isInteger(source.calls) && source.calls >= 0 ? source.calls : 0,
    count: Number.isInteger(source.count) && source.count >= 0 ? source.count : 0,
    lastDecision: source.lastDecision !== null && typeof source.lastDecision === 'object' ? source.lastDecision : undefined,
    lastText: typeof source.lastText === 'string' ? source.lastText : undefined,
    suppressNext: source.suppressNext === true,
    contextAnchors: strings(source.contextAnchors),
    turnAnchors: strings(source.turnAnchors),
    iterationAnchors: strings(source.iterationAnchors)
  };
}

/**
 * The text that replaces a pruned tool output.
 *
 * Upstream `lib/messages/prune.ts:9`. Byte-for-byte the same string, because the
 * model reads it: it is the only account of what used to be there, and the
 * summary/placeholder vocabulary the compress prompt teaches is built on it.
 */
export const PRUNED_TOOL_OUTPUT_REPLACEMENT =
  '[Output removed to save context - information superseded or no longer needed]';

/** The text that replaces every string input of a FAILED tool call (upstream line 11). */
export const PRUNED_TOOL_ERROR_INPUT_REPLACEMENT = '[input removed due to failed tool call]';

/** The text that replaces an answered question's prompt (upstream line 12). */
export const PRUNED_QUESTION_INPUT_REPLACEMENT = "[questions removed - see output for user's answers]";

/**
 * Tools whose completed output is NEVER content-pruned.
 *
 * Upstream `pruneToolOutputs` (line 90) skips `question`, `edit` and `write`:
 * a question's answer is context the model must keep, and an edit/write result
 * is the record of a change that was actually made. For `question` upstream goes
 * further and prunes the ANSWERED QUESTION's input instead
 * (`pruneToolInputs`, line 99) — the prompt is dropped and the answer kept,
 * because the answer is what the model has to remember.
 *
 * The port names the harness equivalents: `ask_user_question` for `question`,
 * and the same `edit`/`write`.
 */
const OUTPUT_PRUNE_EXEMPT_TOOLS = new Set(['edit', 'write', 'ask_user_question']);

/**
 * The tool whose INPUT is pruned once it has been answered, upstream's `question`.
 * Kept as a named constant because the two halves — exempt the output, prune the
 * input — must name the same tool or the transcript loses the answer.
 */
const QUESTION_TOOL = 'ask_user_question';

/**
 * The registry of compression blocks plus the tool-prune manifest.
 *
 * Shape mirrors upstream's `prune.messages` AND `prune.tools`: a map of blocks by
 * id, a list of ACTIVE ids, a map from anchor message id to the block injected
 * there, and a manifest of pruned tool-call ids. `active` is what makes
 * `decompress` possible without losing the block's text: an inactive block keeps
 * its entry and simply stops participating in the outgoing rewrite.
 *
 * THE MANIFEST IS A MAP, NOT A SET. Upstream stores `state.prune.tools` as
 * `Map<callId, tokenCount>` (`lib/strategies/deduplication.ts:90`) — the count is
 * what `/dcp stats` and the sweep report quote as "tokens saved". Keeping only a
 * set would mean re-measuring the pruned outputs on every report, from messages
 * that may no longer be on the surface at all.
 */
export class DcpBlockState {
  constructor(seed = {}) {
    /** Blocks by string id, active or not. */
    this.blocksById = new Map();
    /** Block id injected at each anchor message id, in insertion order. */
    this.activeByAnchorMessageId = new Map();
    /** Pruned tool-call ids -> the tokens their output was worth. Upstream's `prune.tools`. */
    this.prunedToolIds = new Map();
    /** Pruned tool-call id -> the surface node its placeholder occupies. */
    this.prunedNodes = new Map();
    /** Pruned tool-call id -> provider/materialization action. */
    this.prunedToolKinds = new Map();
    /** Next block id to mint. Persisted, so ids never repeat across restarts. */
    this.nextBlockId = 1;
    this.nextRunId = 1;
    /** Stable aliases for raw message ids, scoped to this session. */
    this.messageIds = { byRawId: new Map(), byRef: new Map(), nextRef: 1 };
    this.version = DCP_STATE_VERSION;
    this.stats = restoredStats(seed.stats);
    this.nudges = restoredNudges(seed.nudges);
    this.manualPermit = seed.manualPermit === true;
    this.manualModeOverride = typeof seed.manualModeOverride === 'boolean' ? seed.manualModeOverride : undefined;
    this.lastCompaction = Number.isInteger(seed.lastCompaction) && seed.lastCompaction >= 0 ? seed.lastCompaction : 0;
    this.requestModelKey = typeof seed.requestModelKey === 'string' ? seed.requestModelKey : '';
    this.modelContextLimit = typeof seed.modelContextLimit === 'number' && Number.isFinite(seed.modelContextLimit) ? seed.modelContextLimit : undefined;
    if (Number.isInteger(seed.nextBlockId) && seed.nextBlockId > 0) this.nextBlockId = seed.nextBlockId;
    if (Number.isInteger(seed.nextRunId) && seed.nextRunId > 0) this.nextRunId = seed.nextRunId;
    this.restoreMessageIds(seed.messageIds);
    this.restorePrunedTools(seed.prunedToolIds);
    this.restorePrunedToolKinds(seed.prunedToolKinds);
    this.restorePrunedNodes(seed.prunedNodes);
    for (const block of Array.isArray(seed.blocks) ? seed.blocks : []) this.restore(block);
  }

  restorePrunedToolKinds(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return;
    for (const [callId, kind] of Object.entries(raw)) {
      if (!this.prunedToolIds.has(callId)) continue;
      if (kind === 'output' || kind === 'error-input' || kind === 'question-input' || kind === 'protected-output') this.prunedToolKinds.set(callId, kind);
    }
    for (const callId of this.prunedToolIds.keys()) {
      if (!this.prunedToolKinds.has(callId)) this.prunedToolKinds.set(callId, 'output');
    }
  }

  restoreMessageIds(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return;
    const byRawId = raw.byRawId;
    if (byRawId !== null && typeof byRawId === 'object' && !Array.isArray(byRawId)) {
      for (const [rawId, ref] of Object.entries(byRawId)) {
        const index = typeof ref === 'string' ? parseMessageRef(ref) : null;
        if (rawId.length === 0 || index === null) continue;
        const normalized = formatMessageRef(index);
        if (this.messageIds.byRef.has(normalized)) continue;
        this.messageIds.byRawId.set(rawId, normalized);
        this.messageIds.byRef.set(normalized, rawId);
      }
    }
    const highest = [...this.messageIds.byRef.keys()].reduce((max, ref) => Math.max(max, parseMessageRef(ref) ?? 0), 0);
    this.messageIds.nextRef = Number.isInteger(raw.nextRef) && raw.nextRef > highest ? raw.nextRef : highest + 1;
    if (this.messageIds.nextRef > 9999 && highest < 9999) this.messageIds.nextRef = highest + 1;
  }

  /**
   * Rebuild the placeholder-node map from persisted JSON.
   *
   * Tolerated rather than trusted, like the manifest: a hand-edited file must not
   * be able to throw on the request path. A malformed record is dropped, which
   * costs `decompress` the ability to reverse that one prune — never correctness.
   *
   * @param raw - `{callId: {seq, note?}}`.
   */
  restorePrunedNodes(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return;
    for (const [callId, entry] of Object.entries(raw)) {
      if (callId.length === 0 || entry === null || typeof entry !== 'object') continue;
      const seq = Number(entry.seq);
      if (!Number.isInteger(seq)) continue;
      this.prunedNodes.set(callId, { seq, ...(typeof entry.note === 'string' ? { note: entry.note } : {}) });
    }
  }

  /**
   * Rebuild the prune manifest from persisted JSON.
   *
   * Two shapes are accepted: upstream's record (`{callId: tokens}`) and the bare
   * id list an earlier version of this port wrote. A hand-edited file must not
   * be able to throw here — a malformed manifest would take down the request
   * rewrite, which is on the critical path of every model call.
   *
   * @param raw - the persisted manifest, in either shape.
   */
  restorePrunedTools(raw) {
    if (raw === null || raw === undefined) return;
    if (Array.isArray(raw)) {
      for (const id of raw) if (typeof id === 'string' && id.length > 0) this.prunedToolIds.set(id, 0);
      return;
    }
    if (typeof raw !== 'object') return;
    for (const [id, tokens] of Object.entries(raw)) {
      if (id.length === 0) continue;
      this.prunedToolIds.set(id, typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : 0);
    }
  }

  /**
   * Add tool calls to the prune manifest.
   *
   * ONE-WAY, as upstream is: a call already in the manifest keeps its original
   * token count, so a second strategy pass cannot inflate the reported saving.
   *
   * @param entries - `[{ callId, tokens }]`, in discovery order.
   * @returns the ids that were newly added.
   */
  pruneTools(entries) {
    const added = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
      const id = typeof entry?.callId === 'string' && entry.callId.length > 0 ? entry.callId : undefined;
      if (id === undefined || this.prunedToolIds.has(id)) continue;
      const tokens = typeof entry.tokens === 'number' && Number.isFinite(entry.tokens) ? entry.tokens : 0;
      this.prunedToolIds.set(id, tokens);
      this.prunedToolKinds.set(id, ['output', 'error-input', 'question-input', 'protected-output'].includes(entry.kind) ? entry.kind : 'output');
      added.push(id);
    }
    return added;
  }

  /** Whether any tool call is pruned, upstream's `prune.tools.size > 0`. */
  get prunedToolCount() {
    return this.prunedToolIds.size;
  }

  /**
   * Remember the surface node a prune landed at, so it can be reversed.
   *
   * A prune is now a session replacement, not a request-time filter: the
   * placeholder occupies a real node, and undoing it means replacing THAT node
   * with the original content again. Without this the plugin would know a call
   * was pruned but not where its placeholder lives, and `decompress` could only
   * describe what was lost rather than restore it.
   *
   * @param callId - the pruned tool call.
   * @param seq - the seq of the replacement node.
   * @param note - the text the replacement carries, for diagnostics.
   */
  recordPrunedNode(callId, seq, note) {
    if (typeof callId !== 'string' || !Number.isInteger(seq)) return;
    this.prunedNodes.set(callId, { seq, ...(typeof note === 'string' ? { note } : {}) });
  }

  /** The replacement node for one pruned call, or `undefined`. */
  prunedNodeFor(callId) {
    return this.prunedNodes.get(String(callId));
  }

  /** The total tokens the manifest claims, upstream's `getTotalToolTokens`. */
  get prunedToolTokens() {
    let total = 0;
    for (const tokens of this.prunedToolIds.values()) total += tokens;
    return total;
  }

  /** Mint the next block id, as a string. */
  mintBlockId() {
    const id = String(this.nextBlockId);
    this.nextBlockId += 1;
    return id;
  }

  mintRunId() {
    const id = this.nextRunId;
    this.nextRunId += 1;
    return id;
  }

  /** How many blocks exist, active or not (upstream's `blocksById.size`). */
  get size() {
    return this.blocksById.size;
  }

  /** One block by id. */
  get(blockId) {
    return this.blocksById.get(String(blockId));
  }

  /** Every block, active or not, oldest insertion first. */
  values() {
    return this.blocksById.values();
  }

  /** Every block id, oldest insertion first. */
  keys() {
    return this.blocksById.keys();
  }

  /** Whether a block id exists. */
  has(blockId) {
    return this.blocksById.has(String(blockId));
  }

  /** Store (or replace) one block and, when active, claim its anchor. */
  put(block) {
    this.blocksById.set(String(block.blockId), block);
    if (block.active !== false) this.activeByAnchorMessageId.set(String(block.anchorMessageId), String(block.blockId));
    else this.activeByAnchorMessageId.delete(String(block.anchorMessageId));
  }

  /**
   * Rebuild a block from persisted JSON, tolerating a hand-edited file.
   *
   * A malformed entry is dropped rather than trusted: every field below is
   * consumed by the outgoing rewrite, and a half-restored block would silently
   * delete conversation instead of replacing it with its summary.
   *
   * @param raw - one persisted block record.
   * @returns the stored block, or `undefined` when the record is unusable.
   */
  restore(raw) {
    if (raw === null || typeof raw !== 'object') return undefined;
    if (typeof raw.blockId !== 'string' && typeof raw.blockId !== 'number') return undefined;
    if (typeof raw.summary !== 'string' || raw.summary.length === 0) return undefined;
    if (typeof raw.anchorMessageId !== 'string' || raw.anchorMessageId.length === 0) return undefined;
    const shadowedMessageIds = Array.isArray(raw.shadowedMessageIds)
      ? raw.shadowedMessageIds.filter((id) => typeof id === 'string' && id.length > 0)
      : [];
    if (shadowedMessageIds.length === 0) return undefined;
    const shadowedSeqs = Array.isArray(raw.shadowedSeqs)
      ? raw.shadowedSeqs.filter((seq) => Number.isInteger(seq))
      : [];
    const explicitChildren = Array.isArray(raw.childBlockIds)
      ? raw.childBlockIds.map(String).filter((id) => id.length > 0)
      : undefined;
    const legacyChildren = [...new Set([
      ...(Array.isArray(raw.consumedBlockIds) ? raw.consumedBlockIds : []),
      ...(Array.isArray(raw.appendedBlockIds) ? raw.appendedBlockIds : [])
    ].map(String).filter((id) => id.length > 0))];
    const childBlockIds = explicitChildren ?? legacyChildren;
    const explicitPreserved = Array.isArray(raw.preservedBlockIds)
      ? raw.preservedBlockIds.map(String).filter((id) => childBlockIds.includes(id))
      : undefined;
    const explicitAbsorbed = Array.isArray(raw.absorbedBlockIds)
      ? raw.absorbedBlockIds.map(String).filter((id) => childBlockIds.includes(id))
      : undefined;
    const preservedBlockIds = [...new Set(explicitPreserved ?? childBlockIds)];
    const preservedSet = new Set(preservedBlockIds);
    const absorbedBlockIds = [...new Set(explicitAbsorbed ?? [])].filter((id) => !preservedSet.has(id));
    const classified = new Set([...preservedBlockIds, ...absorbedBlockIds]);
    for (const childBlockId of childBlockIds) if (!classified.has(childBlockId)) absorbedBlockIds.push(childBlockId);
    const block = {
      blockId: String(raw.blockId),
      runId: Number.isInteger(raw.runId) && raw.runId > 0 ? raw.runId : Number.parseInt(String(raw.blockId), 10),
      ...(typeof raw.operationId === 'string' && raw.operationId.length > 0 ? { operationId: raw.operationId } : {}),
      ...(typeof raw.batchId === 'string' && raw.batchId.length > 0 ? { batchId: raw.batchId } : {}),
      topic: typeof raw.topic === 'string' ? raw.topic : '(untitled)',
      summary: raw.summary,
      anchorMessageId: raw.anchorMessageId,
      shadowedMessageIds,
      // The range by sequence is how a LATER compression recognises the span an
      // existing block already stands for; the ids are how the request rewrite
      // shadows it. Both are needed, and both survive the round trip.
      ...(shadowedSeqs.length > 0 ? { shadowedSeqs } : {}),
      // THE NODE THE SUMMARY OCCUPIES, which is how a live surface node is
      // recognized as a block at all. Persisted because a restart re-creates the
      // state from this file and the node keeps its seq: without it, every block
      // came back invisible to `blockAtSeq`, and a range that began or ended on
      // one resolved against the wrong nodes.
      ...(Number.isInteger(raw.nodeSeq) ? { nodeSeq: raw.nodeSeq } : {}),
      ...(Number.isInteger(raw.start) ? { start: raw.start } : {}),
      ...(Number.isInteger(raw.end) ? { end: raw.end } : {}),
      active: raw.active !== false,
      // WHO TURNED IT OFF. Upstream records this (`state/types.ts:37`,
      // `compress/state.ts:116`) because the two ways a block goes inactive are not
      // the same thing: `/dcp decompress` is the USER asking for the text back, and
      // only that is reversible. A block the engine deactivated — because a later
      // compression absorbed it, or because the harness compacted over it — must
      // not come back just because someone typed `/dcp recompress`.
      deactivatedByUser: raw.deactivatedByUser === true,
      ...(typeof raw.deactivatedAt === 'string' ? { deactivatedAt: raw.deactivatedAt } : {}),
      summaryChars: typeof raw.summaryChars === 'number' ? raw.summaryChars : raw.summary.length,
      summaryTokens: typeof raw.summaryTokens === 'number' && Number.isFinite(raw.summaryTokens)
        ? Math.max(0, raw.summaryTokens)
        : Math.ceil(raw.summary.length / 4),
      restoredSeqs: Array.isArray(raw.restoredSeqs) ? raw.restoredSeqs.map(Number).filter(Number.isInteger) : [],
      childBlockIds,
      preservedBlockIds,
      absorbedBlockIds,
      ...(explicitChildren === undefined && childBlockIds.length > 0 ? { lineageSemantics: 'legacy-unknown' } : {}),
      parentBlockIds: Array.isArray(raw.parentBlockIds) ? raw.parentBlockIds.map(String).filter((id) => id.length > 0) : [],
      ...(raw.deactivatedByBlockId !== undefined ? { deactivatedByBlockId: String(raw.deactivatedByBlockId) } : {}),
      ...(typeof raw.inlinedInto === 'string' ? { inlinedInto: raw.inlinedInto } : {})
    };
    const numeric = Number.parseInt(block.blockId, 10);
    if (Number.isInteger(numeric) && numeric >= this.nextBlockId) this.nextBlockId = numeric + 1;
    if (Number.isInteger(block.runId) && block.runId >= this.nextRunId) this.nextRunId = block.runId + 1;
    this.put(block);
    return block;
  }

  /** Every active block, oldest first. */
  active() {
    return [...this.activeByAnchorMessageId.values()]
      .map((id) => this.blocksById.get(id))
      .filter((block) => block !== undefined);
  }

  /**
   * Forget every block, upstream's `resetOnCompaction` half for the registry.
   *
   * A block is addressed by seq — its own node, the span it covers, the message
   * ids it shadows — and a harness compaction rewrites the surface, so after one
   * of those none of those numbers can be trusted. Keeping the blocks is worse
   * than dropping them: `blockAtSeq` would recognise an unrelated node as a
   * compressed block and report a span that no longer exists.
   *
   * The PRUNE MANIFEST is deliberately untouched: it is keyed by tool-call ids,
   * which survive a compaction, and re-exposing output the user already removed is
   * not a reset, it is a regression.
   *
   * @returns how many blocks were forgotten.
   */
  clear() {
    const count = this.blocksById.size;
    this.blocksById.clear();
    this.activeByAnchorMessageId.clear();
    return count;
  }

  /** Reset every address tied to the pre-compaction surface. */
  resetForCompaction(marker = this.lastCompaction) {
    const count = this.blocksById.size;
    this.blocksById.clear();
    this.activeByAnchorMessageId.clear();
    this.nextBlockId = 1;
    this.nextRunId = 1;
    this.prunedToolIds.clear();
    this.prunedToolKinds.clear();
    this.prunedNodes.clear();
    this.messageIds.byRawId.clear();
    this.messageIds.byRef.clear();
    this.messageIds.nextRef = 1;
    this.nudges = restoredNudges({});
    this.manualPermit = false;
    this.lastCompaction = Number.isInteger(Number(marker)) ? Number(marker) : 0;
    this.requestModelKey = '';
    this.modelContextLimit = undefined;
    return count;
  }

  /**
   * Deactivate a block: its text stays, it stops being injected.
   *
   * `byUser` is what upstream's `deactivatedByUser` records, and it is not
   * bookkeeping: `/dcp recompress` refuses a block the ENGINE turned off
   * (`lib/commands/recompress.ts:172-178` — "is not user-decompressed"). Without
   * the flag the two states are indistinguishable once persisted, and a
   * recompress would resurrect a block whose span a later compression already
   * absorbed.
   *
   * @param blockId - the block to deactivate.
   * @param options - `byUser` marks it as a user decompress; `at` is the stamp.
   * @returns the block, or undefined when there is no such block.
   */
  deactivate(blockId, options = {}) {
    const block = this.blocksById.get(String(blockId));
    if (block === undefined) return undefined;
    block.active = false;
    block.deactivatedByUser = options.byUser === true;
    if (options.byUser === true) block.deactivatedAt = options.at ?? new Date().toISOString();
    else delete block.deactivatedAt;
    if (options.byBlockId !== undefined) block.deactivatedByBlockId = String(options.byBlockId);
    else if (options.byUser === true) delete block.deactivatedByBlockId;
    this.activeByAnchorMessageId.delete(String(block.anchorMessageId));
    return block;
  }

  /** Re-activate a block, upstream's `/dcp recompress`. */
  reactivate(blockId) {
    const block = this.blocksById.get(String(blockId));
    if (block === undefined) return undefined;
    block.active = true;
    block.deactivatedByUser = false;
    delete block.deactivatedAt;
    delete block.deactivatedByBlockId;
    this.activeByAnchorMessageId.set(String(block.anchorMessageId), String(block.blockId));
    return block;
  }

  /** The set of message ids shadowed by every ACTIVE block. */
  shadowedMessageIds() {
    const ids = new Set();
    for (const block of this.active()) for (const id of block.shadowedMessageIds) ids.add(id);
    return ids;
  }

  /** Serialise for disk, upstream's `serializePruneMessagesState`. */
  toJSON() {
    return {
      version: DCP_STATE_VERSION,
      nextBlockId: this.nextBlockId,
      nextRunId: this.nextRunId,
      messageIds: {
        nextRef: this.messageIds.nextRef,
        byRawId: Object.fromEntries(this.messageIds.byRawId)
      },
      // A record, not a list: upstream persists `prune.tools` as
      // `Record<callId, tokenCount>` and the numbers are what a report quotes.
      prunedToolIds: Object.fromEntries(this.prunedToolIds),
      prunedToolKinds: Object.fromEntries(this.prunedToolKinds),
      prunedNodes: Object.fromEntries(this.prunedNodes),
      stats: this.stats,
      nudges: {
        calls: this.nudges.calls,
        count: this.nudges.count,
        lastDecision: this.nudges.lastDecision,
        lastText: this.nudges.lastText,
        suppressNext: this.nudges.suppressNext,
        contextAnchors: [...this.nudges.contextAnchors],
        turnAnchors: [...this.nudges.turnAnchors],
        iterationAnchors: [...this.nudges.iterationAnchors]
      },
      manualPermit: this.manualPermit,
      manualModeOverride: this.manualModeOverride,
      lastCompaction: this.lastCompaction,
      requestModelKey: this.requestModelKey,
      modelContextLimit: this.modelContextLimit,
      // `deactivatedByUser` rides along on the block objects. It is written
      // explicitly rather than left to chance, because a state file that loses it
      // makes every engine-deactivated block look user-decompressed, and
      // `/dcp recompress` would then resurrect text a later compression absorbed.
      blocks: [...this.blocksById.values()].map((block) => ({
        ...block,
        deactivatedByUser: block.active === false ? block.deactivatedByUser === true : false
      }))
    };
  }
}

/**
 * The four event types that can occupy a surface node.
 *
 * Copied here because the harness does not export its set
 * (`F\dsh-session\lib\types\surface.js:13-18` is a private module-level `Set`, and
 * `types.d.ts` merges the union at the type level only — see `docs/dsh-core.md`
 * §1). Re-appending anything else would be accepted by the log and then silently
 * produce no message, which is the failure mode that makes a restore look
 * successful while the model reads nothing back.
 */
const SURFACE_EVENT_TYPES = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result']);

/** Coordinates required by durable v3 system messages. */
function latestMessageCoordinates(session) {
  let turn = 0;
  let step = 0;
  for (let seq = 0; seq < Number(session?.seq ?? 0); seq += 1) {
    const data = session.eventAt?.(seq)?.data;
    if (Number.isSafeInteger(data?.turn) && data.turn > turn) turn = data.turn;
    if (Number.isSafeInteger(data?.step) && data.step > step) step = data.step;
  }
  return { turn: Math.max(1, turn), step: Math.max(1, step) };
}

/**
 * Put a compression's shadowed messages back, by re-appending copies of them.
 *
 * THE SUMMARY NODE IS THE PROBLEM, and it is why deactivating a block was not
 * enough. Materializing a compression REPLACES a surface range with the summary,
 * and the surface is durable: flipping `block.active` changes what a request
 * REWRITE would do (upstream's mechanism, which this port cannot use) but leaves
 * the summary exactly where it is, so the model went on reading the summary after
 * `/dcp decompress` reported success.
 *
 * The repair is the copy-tail recipe run backwards, and it is the only shape the
 * core allows:
 *
 *   1. append fresh copies of the shadowed events, then copies of every live tail
 *      node after the summary;
 *   2. collapse the old summary plus old tail into one invisible node. The new
 *      copies are now the tail, ordered as restored span then original tail.
 *
 * Cost, recorded rather than hidden: the session grows by one event per restored
 * message plus one, and every restored message gets a NEW id — anything that
 * addressed the old ones by id (a later compression's `shadowedMessageIds`) is
 * stale. That is why this refuses to run when a later block already absorbed this
 * one: the text is inside that block now, and re-appending it would send it twice.
 *
 * @param session - the live session to extend.
 * @param block - the compression block to undo.
 * @param meter - DSH token meter used to price the old surface being collapsed.
 * @returns restoration details, or `undefined` when nothing could.
 */
export function restoreBlockMessages(session, block, meter) {
  const surfaceNodes = session?.surface?.nodes;
  if (!Array.isArray(surfaceNodes) || block === undefined) return undefined;
  const nodes = [...surfaceNodes];
  const summarySeq = Number(block.nodeSeq);
  const summaryIndex = nodes.findIndex((seq) => Number(seq) === summarySeq);
  if (!Number.isInteger(summarySeq) || summaryIndex < 0) return undefined;

  // The span the summary stands for, by SEQ — the durable address. `shadowedSeqs`
  // is empty on a block from an older build, in which case the message ids are the
  // only fallback and they are matched against the log's own derivation.
  const wanted = Array.isArray(block.shadowedSeqs) ? block.shadowedSeqs.map(Number).filter(Number.isInteger) : [];
  if (wanted.length === 0) return undefined;
  if (typeof meter?.estimateMessage !== 'function') throw new Error('restoring a compression requires the token meter');
  const collapsed = nodes.slice(summaryIndex).map(Number);
  const collapsedTokens = assertPrice(collapsed.reduce((total, seq) => {
    const message = session.deriveEventMessage(session.eventAt(SessionSeq(seq)));
    return total + (message === null ? 0 : meter.estimateMessage(message));
  }, 0));
  const restoredSeqs = [];
  const copiedSeqByOriginal = new Map();
  const copiedMessageIdByOriginal = new Map();
  const appendFreshCopy = (seq) => {
    const event = session.eventAt?.(seq);
    if (event === undefined || !SURFACE_EVENT_TYPES.has(event.type)) return undefined;
    const data = structuredClone(event.data);
    const message = data?.message ?? data;
    if (typeof message?.id === 'string' && message.id.length > 0) {
      const originalId = message.id;
      message.id = randomUUID();
      copiedMessageIdByOriginal.set(originalId, message.id);
    }
    const appended = session.append(event.type, data, { surfaceOp: 'append' });
    copiedSeqByOriginal.set(seq, Number(appended.seq));
    return appended;
  };
  for (const seq of wanted) {
    if (seq === summarySeq) continue;
    const appended = appendFreshCopy(seq);
    if (appended === undefined) continue;
    restoredSeqs.push(Number(appended.seq));
  }
  if (restoredSeqs.length === 0) return undefined;

  const oldTail = nodes.slice(summaryIndex + 1).map(Number);
  for (const seq of oldTail) {
    appendFreshCopy(seq);
  }

  const endSeq = collapsed.at(-1);

  session.append('compaction/prune', {
    shadowedRange: { start: summarySeq, end: endSeq },
    shadowedSeqs: collapsed,
    shadowedTokenCount: collapsedTokens,
    summary: block.summary
  });
  session.append('system/message', {
    ...latestMessageCoordinates(session),
    message: {
      id: `restored-${block.blockId}-${randomUUID()}`,
      role: 'system',
      source: { kind: 'system-prompt' },
      content: []
    }
  }, {
    surfaceOp: { op: 'replace', startSeq: summarySeq, endSeq },
    sourceEventSeqs: collapsed
  });
  block.restoredSeqs = restoredSeqs;
  return { restoredCount: restoredSeqs.length, restoredSeqs, summarySeq, copiedSeqByOriginal, copiedMessageIdByOriginal };
}

/** Replace one user-restored span with its saved summary again. */
export function rematerializeBlockSummary(session, block, entry) {
  const restoredSeqs = Array.isArray(block?.restoredSeqs) ? block.restoredSeqs.map(Number).filter(Number.isInteger) : [];
  const nodes = session?.surface?.nodes?.map(Number);
  if (restoredSeqs.length === 0 || !Array.isArray(nodes)) return undefined;
  const indexes = restoredSeqs.map((seq) => nodes.indexOf(seq));
  if (indexes.some((index) => index < 0)) return undefined;
  const first = indexes[0];
  if (!indexes.every((index, offset) => index === first + offset)) return undefined;
  const summaryEvent = materializeSummary(session, {
    startSeq: restoredSeqs[0],
    endSeq: restoredSeqs.at(-1),
    shadowedSeqs: restoredSeqs,
    tokens: entry.tokens,
    summary: block.summary,
    summaryMessage: entry.summaryMessage
  });
  block.nodeSeq = Number(summaryEvent.seq);
  block.restoredSeqs = [];
  return summaryEvent;
}

/* ------------------------------------------------- the tool-prune rewrite half */

/**
 * PRUNING IS A SESSION EVENT — the only channel that reaches the model.
 *
 * `llm/stream` cannot substitute a request: cordis's `waterfall` discards
 * arguments passed to `next(...)` (its `next` closes over the waterfall's own
 * args array), the request envelope and its message array arrive deep-frozen
 * from `dsh-agent-loop`'s `buildRequest`, and the type definition says so
 * outright — listeners "read it, never rewrite it". Nothing a plugin computes
 * there is ever sent.
 *
 * DSH's sanctioned channel is the SURFACE, and it gives exactly the property DCP
 * is built on: `session.append(type, data, { surfaceOp: { op: 'replace', startSeq,
 * endSeq }, sourceEventSeqs })` shadow-mounts a replacement over the range,
 * `deriveMessages()` folds the new surface into the request, and the ORIGINAL
 * events stay in the append-only log forever — `isAppendSurfaceEvent`, "the
 * model-visible surface deliberately shadows replaced ranges, so it is the wrong
 * source for a human transcript". The shipped tool-result pruner and the
 * compaction engine use this and nothing else.
 *
 * So the port materializes: a `compaction/prune` event records the price (the
 * protocol `dsh-compaction-tool-result-pruner` follows), and a replacement node
 * carries the placeholder. The session is not modified — it is extended, and the
 * extension is what the model sees.
 */

/**
 * The price a prune claims, or a throw when it cannot be computed.
 *
 * A MISSING PRICE IS A SILENT, DURABLE DEFECT, and it was one: `shadowedTokenCount`
 * fell back to `0`, and the harness's context-pressure projection SUBTRACTS that
 * claim (`dsh-token-meter`, `contextPressure`), so a span that was really a few
 * thousand tokens was reported as free — forever, including after a restart,
 * because the number is persisted in the log. Nothing downstream validates it
 * either (the compaction invariant only demands a non-negative safe integer), so
 * this is the one place that can catch it. A caller with no meter is a caller
 * that must not prune.
 *
 * @param tokens - the measured price.
 * @returns the price.
 * @throws when it is not a finite non-negative number.
 */
function assertPrice(tokens) {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) {
    throw new Error(`prune price must be a finite non-negative number, got ${JSON.stringify(tokens)} — a zero or missing price makes the context bar report the shadowed span as free forever`);
  }
  return tokens;
}

/**
 * Emit one positional replacement, upstream's `pruneToolOutputs` as a surface op.
 *
 * The harness validates this: a `tool/result` replacement must shadow exactly ONE
 * current `tool/result` and "may change only content" — the message id, its
 * source, the block's `toolCallId` and `isError` must be byte-identical to the
 * original. That is what keeps the transcript valid: the assistant's call is
 * still answered by the same call id, so no provider sees a dangling tool call.
 *
 * @param session - the session to extend.
 * @param entry - `{ seq, event, replacement, tokens }` — `event` is the original
 *   `tool/result` log event and `replacement` the identified message that keeps
 *   everything about it except the content.
 * @returns the appended replacement event.
 */
export function materializeToolResultPrune(session, entry) {
  const seq = SessionSeq(entry.seq);
  const price = assertPrice(entry.tokens);
  session.append('compaction/prune', {
    shadowedRange: { start: seq, end: seq },
    shadowedSeqs: [seq],
    shadowedTokenCount: price
  });
  // ADJACENT, ALWAYS. The harness's `foldSurfaceProjection` prices a claim by the
  // events BETWEEN the price event and the replacement that consumes it, and it
  // reports a delta of 0 with NO error when anything else lands in between. The
  // session layer does not enforce adjacency, so nothing else can catch it.
  return session.append('tool/result', { ...entry.event.data, message: entry.replacement }, {
    surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
    sourceEventSeqs: [seq]
  });
}

/**
 * Emit one summary over a range, upstream's `filterCompressedRanges` as a surface op.
 *
 * The range is replaced by ONE `user/message` carrying the summary. The surface
 * shrinks by (N-1) nodes and every later node keeps its own seq — a replacement
 * is spliced into the shadowed position, so seqs AFTER the range do not move.
 * Seqs INSIDE the range stop being surface nodes, which is why every seq the
 * model is handed must be re-read from the live surface rather than remembered.
 *
 * @param session - the session to extend.
 * @param entry - `{ startSeq, endSeq, shadowedSeqs, tokens, summaryMessage }`.
 * @returns the appended summary event.
 */
export function prepareSummaryMaterialization(session, entry) {
  const start = SessionSeq(entry.startSeq);
  const end = SessionSeq(entry.endSeq);
  const nodes = session.surface.nodes;
  const startIdx = nodes.indexOf(start);
  const endIdx = nodes.indexOf(end);
  if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
    throw new Error(`summary range ${start}..${end} must follow current surface order with both endpoints present`);
  }

  // Snapshot only the proposed data, not the session/history. The public core
  // validator checks message shape and dense, unique, earlier source sequences.
  const prepared = snapshotJsonValue({
    message: entry.summaryMessage,
    shadowedSeqs: entry.shadowedSeqs,
    tokens: assertPrice(entry.tokens),
    ...(typeof entry.summary === 'string' ? { summary: entry.summary } : {})
  });
  if (prepared === undefined) throw new Error('summary data, price and provenance must be losslessly JSON-serializable');
  const replacement = adoptSessionEvent({
    type: 'user/message',
    // Validate against the log BEFORE the prune: it cannot be its own source.
    seq: SessionSeq(session.seq),
    time: Date.now(),
    data: prepared.message,
    surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
    sourceEventSeqs: prepared.shadowedSeqs
  });
  const shadowedSeqs = replacement.sourceEventSeqs;
  if (shadowedSeqs.length !== endIdx - startIdx + 1) {
    throw new Error('summary shadowedSeqs must list every selected node in surface order');
  }
  for (let index = startIdx; index <= endIdx; index += 1) {
    const event = session.eventAt(nodes[index]);
    // DCP excludes ALL system messages, including empty nodes and a rewritten
    // head whose seq is newer than the rest of the selected surface.
    if (event === undefined || event.type === 'system/message') {
      throw new Error(`summary cannot replace missing or system/message node ${nodes[index]}`);
    }
    // This list also prices compaction/prune, so extra or reordered provenance
    // is not a valid claim even if it would be legal on a replacement alone.
    if (shadowedSeqs[index - startIdx] !== nodes[index]) {
      throw new Error('summary shadowedSeqs must list every selected node in surface order');
    }
  }

  return {
    start,
    end,
    prepared,
    replacement,
    shadowedSeqs: [...shadowedSeqs],
    surfaceFingerprint: nodes.map(Number).join(',')
  };
}

/** Land a fully preflighted summary while keeping prune and replacement adjacent. */
export function materializeSummary(session, entry) {
  const plan = entry.preparedMaterialization ?? prepareSummaryMaterialization(session, entry);
  const nodes = session.surface.nodes;
  const startIdx = nodes.indexOf(plan.start);
  const endIdx = nodes.indexOf(plan.end);
  if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
    throw new Error(`summary range ${plan.start}..${plan.end} changed after preflight`);
  }
  const current = nodes.slice(startIdx, endIdx + 1);
  if (current.length !== plan.shadowedSeqs.length || current.some((seq, index) => seq !== plan.shadowedSeqs[index])) {
    throw new Error(`summary range ${plan.start}..${plan.end} changed after preflight`);
  }

  session.append('compaction/prune', {
    shadowedRange: { start: plan.shadowedSeqs[0], end: plan.shadowedSeqs[plan.shadowedSeqs.length - 1] },
    shadowedSeqs: plan.shadowedSeqs,
    shadowedTokenCount: plan.prepared.tokens,
    ...(plan.prepared.summary !== undefined ? { summary: plan.prepared.summary } : {})
  });
  return session.append('user/message', plan.replacement.data, {
    surfaceOp: plan.replacement.surfaceOp,
    sourceEventSeqs: plan.shadowedSeqs
  });
}

/** Whether a message is one of DSH's tool-result messages. */
function toolResultMessage(message) {
  if (message?.role !== 'user') return undefined;
  const block = message.content?.[0];
  if (block?.type !== 'tool-result') return undefined;
  return block;
}

/**
 * Rebuild one tool-result message with its payload replaced.
 *
 * Returns a NEW identified message: same `id`, same `source`, same
 * `toolCallId`, same `isError` — only `content[0].content` differs. That is
 * exactly the freedom the harness grants a `tool/result` replacement, and it is
 * why the transcript stays valid: the assistant's call is still answered by the
 * same call id.
 *
 * @param message - the original tool-result message.
 * @param text - the placeholder text.
 * @returns the replacement message.
 */
export function prunedToolResultMessage(message, text) {
  const block = toolResultMessage(message);
  if (block === undefined) return undefined;
  let clone;
  try {
    clone = structuredClone(message);
  } catch {
    return undefined;
  }
  clone.content[0].content = [{ type: 'text', text }];
  return clone;
}

/** Whether a message is an assistant message, whose content may carry tool calls. */
function isAssistantMessage(message) {
  return message?.role === 'assistant' && Array.isArray(message.content);
}

/**
 * Copy a frozen message with one field replaced.
 *
 * DSH hands the loop's own messages, and `freezeMessage` deep-froze them: a
 * content rewrite cannot be an in-place assignment. A copy is built from the
 * message's own JSON shape, which is what `structuredClone` handles exactly;
 * anything it refuses is returned unchanged, because failing to prune one output
 * must never fail the request.
 *
 * @param message - the frozen message to rewrite.
 * @param mutate - receives the detached clone, returns nothing.
 * @returns the rewritten copy, or the original when it cannot be copied.
 */
function rewrittenCopy(message, mutate) {
  let clone;
  try {
    clone = typeof structuredClone === 'function' ? structuredClone(message) : JSON.parse(JSON.stringify(message));
  } catch {
    return message;
  }
  try {
    mutate(clone);
  } catch {
    return message;
  }
  return clone;
}

/**
 * Replace the payload of one pruned tool result, upstream's `pruneToolOutputs`.
 *
 * The call and its result STAY in the transcript: only the output is replaced.
 * That is the whole difference between this and deleting the step — the model
 * still sees that the tool ran and in what order, and the transcript keeps the
 * assistant-tool-call / tool-result pairing every provider requires.
 *
 * @param message - the tool-result message.
 * @param block - its `tool-result` content block.
 * @returns the rewritten message.
 */
function pruneToolOutput(message, block) {
  return rewrittenCopy(message, (clone) => {
    clone.content[0].content = [{ type: 'text', text: PRUNED_TOOL_OUTPUT_REPLACEMENT }];
  });
}

/**
 * Strip every string input of a pruned, FAILED tool call, upstream's `pruneToolErrors`.
 *
 * Upstream rewrites `part.state.input[key]` for each string field, keeping the
 * error text. DSH carries the same inputs as the `arguments` JSON string on the
 * tool-call block, so the fields are parsed, rewritten and re-serialized — the
 * call keeps its name and its non-string arguments, exactly as upstream does.
 *
 * @param message - the assistant message carrying the call.
 * @param ids - the pruned call ids.
 * @returns the rewritten message, or the original when nothing was pruned.
 */
function pruneToolErrorInputs(message, ids) {
  if (!isAssistantMessage(message)) return message;
  if (!message.content.some((block) => block?.type === 'tool-call' && ids.has(block.id))) return message;
  return rewrittenCopy(message, (clone) => {
    for (const block of clone.content) {
      if (block?.type !== 'tool-call' || !ids.has(block.id)) continue;
      if (typeof block.arguments !== 'string') continue;
      let parsed;
      try {
        parsed = JSON.parse(block.arguments);
      } catch {
        parsed = undefined;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      for (const key of Object.keys(parsed)) {
        if (typeof parsed[key] === 'string') parsed[key] = PRUNED_TOOL_ERROR_INPUT_REPLACEMENT;
      }
      block.arguments = JSON.stringify(parsed);
    }
  });
}

/**
 * Strip the prompt of a pruned, ANSWERED question, upstream's `pruneToolInputs`.
 *
 * Upstream replaces `part.state.input.questions` with
 * `[questions removed - see output for user's answers]` and keeps the answer:
 * once the user has replied, the wording of the question is dead weight and the
 * reply is what the model has to carry forward.
 *
 * @param message - the assistant message carrying the call.
 * @param ids - the pruned call ids.
 * @returns the rewritten message, or the original when nothing was pruned.
 */
function pruneToolQuestionInputs(message, ids) {
  if (!isAssistantMessage(message)) return message;
  const targets = message.content.filter((block) => block?.type === 'tool-call' && ids.has(block.id) && block.name === QUESTION_TOOL);
  if (targets.length === 0) return message;
  return rewrittenCopy(message, (clone) => {
    for (const block of clone.content) {
      if (block?.type !== 'tool-call' || !ids.has(block.id) || block.name !== QUESTION_TOOL) continue;
      if (typeof block.arguments !== 'string') continue;
      let parsed;
      try {
        parsed = JSON.parse(block.arguments);
      } catch {
        continue;
      }
      if (parsed === null || typeof parsed !== 'object' || parsed.questions === undefined) continue;
      parsed.questions = PRUNED_QUESTION_INPUT_REPLACEMENT;
      block.arguments = JSON.stringify(parsed);
    }
  });
}

/**
 * Apply the prune manifest to the outgoing list, upstream's `prune()` after
 * `filterCompressedRanges`.
 *
 * Upstream's order is: rewrite tool outputs, then question inputs, then errored
 * inputs — each guarded by "the message is not inside a compressed range"
 * (`isMessageCompacted`). The guard is kept: a shadowed message is about to be
 * dropped, and rewriting it first would be wasted work on the request path.
 *
 * @param messages - the outgoing messages, possibly already filtered.
 * @param state - the state holding the manifest.
 * @returns the rewritten list.
 */
export function applyToolPruning(messages, state) {
  if (state.prunedToolIds.size === 0) return messages;
  const ids = state.prunedToolIds;
  const outputIds = new Set([...ids.keys()].filter((id) => (state.prunedToolKinds.get(id) ?? 'output') === 'output'));
  const errorInputIds = new Set([...ids.keys()].filter((id) => state.prunedToolKinds.get(id) === 'error-input'));
  const questionInputIds = new Set([...ids.keys()].filter((id) => state.prunedToolKinds.get(id) === 'question-input'));
  const shadowed = state.shadowedMessageIds();
  // WHICH TOOL THE RESULT BELONGS TO, resolved from the CALL — because the result
  // does not carry it.
  //
  // Upstream keeps the name on the tool part itself (`part.tool`), so
  // `pruneToolOutputs` can skip `question`/`edit`/`write` results
  // (`lib/messages/prune.ts:90-92`). DSH does not: a real `tool/result` message
  // carries `toolCallId` and nothing else — measured on a live session log, every
  // result's source is exactly `{ kind: "tool", callId }` with no `name`. Reading
  // `message.source?.name` therefore ALWAYS yielded `''`, the exemption never
  // fired, and a failed `write`'s result could be replaced by the failure note —
  // the record of a change that was actually made, thrown away.
  //
  // The call is in the request: an assistant message with a `tool-call` block
  // whose `name` is the tool. One pass builds the map, then the rewrite uses it.
  const toolNameByCallId = new Map();
  for (const message of messages) {
    if (!isAssistantMessage(message)) continue;
    for (const entry of message.content) {
      if (entry?.type === 'tool-call' && typeof entry.id === 'string' && typeof entry.name === 'string') {
        toolNameByCallId.set(entry.id, entry.name);
      }
    }
  }
  let changed = false;
  const result = messages.map((message) => {
    const id = typeof message?.id === 'string' ? message.id : undefined;
    if (id === undefined || shadowed.has(id)) return message;
    const block = toolResultMessage(message);
    if (block !== undefined && outputIds.has(block.toolCallId) && block.isError !== true) {
      // The completed-output pass (upstream `pruneToolOutputs`). The tool's own
      // name exempts it: an edit or a write result is the record of a change that
      // was made, and an answered question's output IS the answer.
      const toolName = toolNameByCallId.get(block.toolCallId) ?? '';
      if (OUTPUT_PRUNE_EXEMPT_TOOLS.has(toolName)) return message;
      changed = true;
      return pruneToolOutput(message, block);
    }
    if (isAssistantMessage(message) && message.content.some((entry) => entry?.type === 'tool-call' && (errorInputIds.has(entry.id) || questionInputIds.has(entry.id)))) {
      // The errored-input pass (upstream `pruneToolErrors`), then the
      // question-input pass (upstream `pruneToolInputs`). Both run over the
      // ASSISTANT message, because that is the half that carries the arguments.
      const question = pruneToolQuestionInputs(message, questionInputIds);
      if (question !== message) {
        changed = true;
        return question;
      }
      const next = pruneToolErrorInputs(message, errorInputIds);
      if (next !== message) {
        changed = true;
        return next;
      }
    }
    return message;
  });
  return changed ? result : messages;
}

/**
 * Rewrite the OUTGOING message list, upstream's `prune()`.
 *
 * The algorithm is upstream's, in its order:
 *
 *   1. drop every message whose id is shadowed by an active block, and inject
 *      the block's summary as a synthetic user message at the anchor — before
 *      the anchor message when it survives, otherwise before the first
 *      surviving message that followed the shadowed span (upstream's
 *      `filterCompressedRanges`);
 *   2. apply the tool-prune manifest: replace the output of a pruned call, and
 *      strip the arguments of a pruned call that errored (upstream's
 *      `pruneToolOutputs` / `pruneToolErrors`).
 *
 * Both halves are content rewrites of a request, never of the session: the
 * stored message is untouched, so `decompress` can hand its text back and an
 * audit reads the original alongside the placeholder the model received.
 *
 * The input array is never mutated: DSH hands the loop's own array and its
 * messages are deep-frozen, so this returns a NEW array. That is the DSH form of
 * upstream's `messages.length = 0; messages.push(...result)`, and it keeps the
 * session's durable history untouched by construction.
 *
 * @param messages - the outgoing message list for one request.
 * @param state - the block state and prune manifest.
 * @param options - `buildSummaryMessage` to create the injected message.
 * @returns the rewritten list.
 *
 * NOT THE LIVE PATH. Nothing in `lib/` calls this: DCP lands its prunes on the SESSION
 * (a replacement event per pruned result), so what the model receives comes from
 * `session.deriveMessages()`, never from a request-side rewrite. This function is upstream's
 * algorithm kept runnable for comparison, and `test-dcp-strategies.mjs` drives the strategies
 * through it because it is the cheapest honest way to feed them a request — which is exactly
 * why an auditor was right to warn that the strategies suite's green result says nothing
 * about the live path by itself. The live path's own proof is `test-dcp-materialization.mjs`
 * (the real surface changes) and `test-dcp-integration.mjs` (every mechanism in order).
 */
export function rewriteOutgoingMessages(messages, state, options = {}) {
  const shadowed = state.shadowedMessageIds();
  const active = state.active().filter((block) => block.active !== false);
  if (active.length === 0 && state.prunedToolIds.size === 0) return messages;

  // WHERE EACH SUMMARY GOES, decided before anything is filtered.
  //
  // The anchor is the FIRST message of the span being compressed, so in the new
  // list it usually no longer exists — the replacement belongs where that
  // message used to be. The position is therefore: the anchor itself when it
  // survives, otherwise the first message after the shadowed span. Deciding this
  // up front is what makes the result deterministic; injecting during the walk
  // and appending whatever was left over put the summary at the END of the
  // request for exactly the ordinary case, which the assertions on the outgoing
  // list caught.
  const position = new Map();
  for (const block of active) {
    const firstShadowedIndex = messages.findIndex((message) => message?.id === block.anchorMessageId);
    if (firstShadowedIndex === -1) continue;
    let index = firstShadowedIndex;
    while (index < messages.length && shadowed.has(messages[index]?.id)) index += 1;
    // `index === messages.length` means the span ran to the end of the request.
    // The summary still goes there: at that position it REPLACES the span,
    // which is exactly what the caller asked for, and appending it cannot split
    // a tool pair because nothing follows.
    position.set(index, [...(position.get(index) ?? []), block]);
  }

  const result = [];
  for (let index = 0; index <= messages.length; index += 1) {
    for (const block of position.get(index) ?? []) {
      const summary = options.buildSummaryMessage?.(block);
      if (summary !== undefined) result.push(summary);
    }
    if (index === messages.length) break;
    const message = messages[index];
    const id = typeof message?.id === 'string' ? message.id : undefined;
    if (id !== undefined && shadowed.has(id)) continue;
    result.push(message);
  }
  return applyToolPruning(result, state);
}
