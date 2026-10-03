/**
 * DCP — Dynamic Context Pruning — ported to DeepSeek Harness.
 *
 * The upstream plugin (Opencode-DCP/opencode-dynamic-context-pruning) does two
 * things: it hands the model a `compress` tool that replaces closed history with a
 * summary the model itself writes, and it runs deterministic cleanups
 * (deduplicate repeated tool calls, purge the inputs of failed ones) that cost no
 * model call. This port keeps both, expressed in harness vocabulary.
 *
 * THERE IS ONE SEAM, AND IT IS THE SESSION SURFACE. Upstream rewrites the outgoing
 * message array on every request; DSH has no hook for that (`docs/dsh-core.md` §2.6
 * — `llm/stream` discards what a listener passes to `next`), so the port
 * MATERIALIZES instead, through DSH's own compaction protocol:
 *
 * - a compression appends `compaction/prune` and then the summary as a
 *   `user/message` replacing the span, so the append-only log keeps every original
 *   and `deriveMessages()` renders the summary plus the live tail;
 * - a prune appends `compaction/prune` and a `tool/result` replacement whose only
 *   changed field is `content[0].content` — the one rewrite the core sanctions.
 *
 * Anything in `lib/dcp-blocks.js` that rewrites a MESSAGE ARRAY
 * (`rewriteOutgoingMessages`) is upstream's algorithm kept honest for comparison;
 * nothing on the live path calls it, and no code should be added that assumes it
 * runs.
 *
 * The strategies are pure functions over the session surface, so their cost is a
 * log walk and their result is reproducible. Protection rules (per-tool name or
 * glob, per-file glob, per-turn window counted in STEPS) are ported one-for-one,
 * including DCP's default protected tool list. They run on `session/event` as a
 * node lands and again on `agent/pre-step`, where upstream's chat transform sits.
 *
 * Configuration is DCP's own file, read from (in order) `<home>/dcp.jsonc`,
 * `<cwd>/.dsh/dcp.jsonc`, then `$DSH_HOME/dcp.jsonc`, with later files
 * overriding earlier ones and the preset's row configuration as the base. The
 * schema carries upstream's defaults, and the deprecated top-level
 * `maxContextLimit`/`minContextLimit` aliases are migrated onto `compress` rather
 * than accepted and ignored.
 *
 * @module dsh-context-kit/dcp
 */

import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';

import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionSeq } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { dshHome as resolveHome, errorLine, isRecord, readTextIfPresent } from './common.js';
import { compressLimitFor, migrateLegacyLimits, readConfigFiles, resolveConfiguration } from './dcp-config.js';
import {
  DcpBlockState,
  PRUNED_QUESTION_INPUT_REPLACEMENT,
  PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
  PRUNED_TOOL_OUTPUT_REPLACEMENT,
  materializeToolResultPrune,
  prepareSummaryMaterialization,
  prunedToolResultMessage,
  rematerializeBlockSummary,
  restoreBlockMessages
} from './dcp-blocks.js';
import {
  blockRef,
  classifyAndExpandBlockPlaceholders,
  numericBlockId,
  wrapBlockSummary
} from './dcp-block-placeholders.js';
import {
  appendCompressionPrune,
  appendCompressionReplacement,
  CompressionOperationJournal,
  compressionOperationEvidence,
  writeDurableJson
} from './dcp-compression-ops.js';
import { collectMessageReferences, injectMessageReferences, parseBoundaryId, sanitizeMessageReferences } from './dcp-message-ids.js';
import {
  appendGuidanceToDcpTag,
  buildCompressedBlockGuidance,
  buildProtectedToolsExtension,
  editablePromptDefault,
  formatExtension,
  renderSystemPrompt,
  COMPRESS_MESSAGE,
  COMPRESS_RANGE,
  CONTEXT_LIMIT_NUDGE,
  EDITABLE_PROMPTS,
  ITERATION_NUDGE,
  TURN_NUDGE
} from './dcp-prompts.js';
import {
  DEFAULT_COMPRESS_PROTECTED_TOOLS,
  DEFAULT_PROTECTED_TOOLS,
  liveTurn,
  planDeduplication,
  planPurgeErrors,
  planSweep,
  readToolCalls,
  resolveStrategyConfig
} from './dcp-strategies.js';
import {
  commitUserEdit,
  renderEditableList,
  resolveTarget,
  runEditCommand,
  userMessages
} from './edit-durable.js';
import { installEditGui } from './edit-gui.js';
import { publishEditStore, publishEngine } from './edit-bridge.js';
import { createEditStore, installWireOverlay, registerWireTransform } from './edit.js';
import { compilePathMatcher, compileToolNameMatcher, filePathsOf, invocationOf, readSteps, turnsFor } from './session.js';

export const name = 'dcp';
/**
 * Services this plugin CONSUMES.
 *
 * `compaction` is deliberately absent: this plugin PROVIDES it (the engine
 * subclasses `CompactionEngine`), and a row that injects the service it
 * publishes waits on itself forever — which in turn stalls every other
 * consumer, `command-compact` included. The engine reaches its own published
 * service through `this.ctx.compaction`. `sessions` is absent for the same
 * reason: the inherited `compactNow` already flushes through the context.
 */
export const inject = ['tools', 'llm', 'tokenMeter'];

/** The plugin identity recorded on every message and prune event it appends. */
const PLUGIN_ID = 'dcp';
/** Format-v4 producer kind for DCP-authored user messages. */
const PLUGIN_SOURCE_KIND = `plugin:${PLUGIN_ID}`;

/* ------------------------------------------------- compression state on disk */

/**
 * Where a session's compression state lives.
 *
 * Upstream persists to `<XDG_DATA_HOME>/opencode/storage/plugin/dcp/<sessionId>.json`
 * (`lib/state/persistence.ts:45-61`). This is the same file, in the harness's own
 * home, and the same name — one JSON document per session.
 *
 * @param sessionId - the session the state belongs to.
 * @returns the absolute file path.
 */
function blockStatePath(sessionId) {
  return join(resolveHome(), 'context-kit', 'dcp-state', `${sessionId}.json`);
}

/**
 * Read a session's persisted compression state, tolerating anything.
 *
 * A missing file is the normal first run, and a corrupt one must not take the
 * plugin down: the state is an optimisation over the log, and {@link DcpBlockState}
 * drops individual unusable records on the way in.
 *
 * @param ctx - plugin context, for the logger.
 * @param sessionId - the session to load.
 * @returns the seed object for a fresh {@link DcpBlockState}.
 */
function readBlockState(ctx, sessionId) {
  const raw = readTextIfPresent(blockStatePath(sessionId));
  if (raw === undefined) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    ctx.logger?.warn?.(`${PLUGIN_ID}: ignoring unreadable compression state for ${sessionId}: ${errorLine(error)}`);
    return {};
  }
}

/**
 * Persist a session's compression state.
 *
 * Written to a temporary file and renamed, so a crash mid-write cannot leave a
 * half-document that the next start would read as "this session had no
 * compressions" — which would silently un-prune everything.
 *
 * @param ctx - plugin context, for the logger.
 * @param sessionId - the session the state belongs to.
 * @param state - the block state to store.
 */
function writeBlockState(ctx, sessionId, state, { strict = false } = {}) {
  try {
    writeDurableJson(blockStatePath(sessionId), state.toJSON());
  } catch (error) {
    ctx.logger?.warn?.(`${PLUGIN_ID}: could not persist compression state for ${sessionId}: ${errorLine(error)}`);
    if (strict) throw error;
  }
}

function latestCompactionMarker(session) {
  let marker = 0;
  if (typeof session?.snapshotEvents !== 'function') return marker;
  for (const event of session.snapshotEvents()) {
    if (event?.type !== 'compaction/end' || event.data?.error !== undefined) continue;
    marker = Math.max(marker, Number(event.seq) || 0);
  }
  return marker;
}

function latestSessionSeq(session) {
  if (typeof session?.snapshotEvents !== 'function') return 0;
  return session.snapshotEvents().reduce((highest, event) => Math.max(highest, Number(event?.seq) || 0), 0);
}

function compressionOperationPredatesCompaction(session, operation) {
  const marker = latestCompactionMarker(session);
  if (marker <= 0) return false;
  const plannedAtSeq = Number(operation?.plannedAtSeq);
  if (Number.isInteger(plannedAtSeq)) return plannedAtSeq < marker;
  for (const candidate of [operation?.replacementSeq, operation?.pruneSeq]) {
    const landedSeq = Number(candidate);
    if (Number.isInteger(landedSeq)) return landedSeq < marker;
  }
  // Legacy journals did not record the plan's surface revision. Fail closed when
  // every selected node predates native compaction rather than replaying stale
  // append intent onto a rewritten surface.
  const plannedSeqs = operation?.plan?.materialization?.shadowedSeqs ?? [];
  const lastPlannedSeq = plannedSeqs.reduce((highest, seq) => Math.max(highest, Number(seq) || 0), 0);
  return lastPlannedSeq > 0 && lastPlannedSeq < marker;
}

function visibleMessage(event) {
  return event?.data?.message ?? event?.data;
}

function visibleText(message) {
  return (message?.content ?? [])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

export const DCP_WIRE_STATUS_LABEL = 'DCP context status';
export const DCP_WIRE_STATUS_MAX_CHARS = 512;
const DCP_STATUS_OPEN = '<' + 'dcp-status>';
const DCP_STATUS_CLOSE = '<' + '/dcp-status>';
const DCP_WIRE_STATUS_REGEX = new RegExp(`(?:\\r?\\n)?${DCP_STATUS_OPEN}[\\s\\S]*?${DCP_STATUS_CLOSE}`, 'gi');
const TERMINAL_DCP_MESSAGE_ID_REGEX = /(\n<dcp-message-id(?:\s[^>]*)?>(?:m(?:000[1-9]|00[1-9]\d|0[1-9]\d{2}|[1-9]\d{3,4})|b[1-9]\d*)<\/dcp-message-id>\s*)$/i;
const DCP_STATUS_EXPLANATION = 'DCP \u0437\u0430\u043c\u0435\u043d\u044f\u0435\u0442 \u0437\u0430\u0432\u0435\u0440\u0448\u0451\u043d\u043d\u044b\u0435 \u0447\u0430\u0441\u0442\u0438 \u0434\u0438\u0430\u043b\u043e\u0433\u0430 \u043a\u043e\u0440\u043e\u0442\u043a\u0438\u043c\u0438 \u0441\u0432\u043e\u0434\u043a\u0430\u043c\u0438. \u0427\u0438\u0441\u043b\u0430 \u043f\u0440\u0438\u043c\u0435\u0440\u043d\u044b\u0435.';
const DCP_STATUS_REQUEST = '\u0421\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u044f \u0432 \u0437\u0430\u043f\u0440\u043e\u0441\u0435:';
const DCP_STATUS_LAST = '\u041f\u043e\u0441\u043b\u0435\u0434\u043d\u0435\u0435 \u0441\u0436\u0430\u0442\u0438\u0435:';
const DCP_STATUS_SPAN = '\u0443\u0447\u0430\u0441\u0442\u043e\u043a';
const DCP_STATUS_SUMMARY = '\u0441\u0432\u043e\u0434\u043a\u0430';
const DCP_STATUS_FREED = '\u041e\u0441\u0432\u043e\u0431\u043e\u0436\u0434\u0435\u043d\u043e:';
const DCP_STATUS_NEVER = '\u0435\u0449\u0451 \u043d\u0435 \u0432\u044b\u043f\u043e\u043b\u043d\u044f\u043b\u043e\u0441\u044c';
const DCP_STATUS_UNAVAILABLE = '\u043d\u0435\u0434\u043e\u0441\u0442\u0443\u043f\u043d\u043e';

function compactTokenCount(value) {
  const amount = Math.round(Number(value));
  if (!Number.isFinite(amount)) return DCP_STATUS_UNAVAILABLE;
  const compact = (divisor, suffix) => `${(amount / divisor).toFixed(1).replace(/\.0$/, '')}${suffix}`;
  if (Math.abs(amount) >= 1_000_000) return compact(1_000_000, 'M');
  if (Math.abs(amount) >= 1_000) return compact(1_000, 'K');
  return String(amount);
}

function validCompressionTelemetry(value) {
  return value !== null && typeof value === 'object'
    && typeof value.beforeEstimate === 'number' && Number.isFinite(value.beforeEstimate) && value.beforeEstimate >= 0
    && typeof value.afterEstimate === 'number' && Number.isFinite(value.afterEstimate) && value.afterEstimate >= 0
    && typeof value.estimatedFreed === 'number' && Number.isFinite(value.estimatedFreed);
}

function wireStatusText(estimate, lastCompression) {
  const lines = [
    DCP_STATUS_OPEN,
    DCP_STATUS_EXPLANATION,
    `${DCP_STATUS_REQUEST} ${Number.isFinite(estimate) ? `~${compactTokenCount(estimate)}` : DCP_STATUS_UNAVAILABLE}`
  ];
  if (validCompressionTelemetry(lastCompression)) {
    const percent = lastCompression.beforeEstimate > 0
      ? ` (${Math.round(lastCompression.estimatedFreed / lastCompression.beforeEstimate * 100)}%)`
      : '';
    lines.push(`${DCP_STATUS_LAST} ${DCP_STATUS_SPAN} ${compactTokenCount(lastCompression.beforeEstimate)} \u2192 ${DCP_STATUS_SUMMARY} ${compactTokenCount(lastCompression.afterEstimate)}`);
    lines.push(`${DCP_STATUS_FREED} ~${compactTokenCount(lastCompression.estimatedFreed)}${percent}`);
  } else {
    lines.push(`${DCP_STATUS_LAST} ${DCP_STATUS_NEVER}`);
  }
  lines.push(DCP_STATUS_CLOSE);
  const status = `\n${lines.join('\n')}`;
  if (status.length <= DCP_WIRE_STATUS_MAX_CHARS) return status;
  return `\n${DCP_STATUS_OPEN}\n${DCP_STATUS_LAST} ${DCP_STATUS_NEVER}\n${DCP_STATUS_CLOSE}`;
}

/** Remove every wire-only status before measuring or replacing it. */
export function stripDcpWireStatuses(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return { messages, stripped: 0 };
  let stripped = 0;
  const next = messages.map((message) => {
    if (!Array.isArray(message?.content)) return message;
    let changed = false;
    const content = message.content.map((part) => {
      if (part?.type !== 'text' || typeof part.text !== 'string') return part;
      const text = part.text.replace(DCP_WIRE_STATUS_REGEX, () => {
        stripped += 1;
        return '';
      });
      if (text === part.text) return part;
      changed = true;
      return { ...part, text };
    });
    return changed ? { ...message, content } : message;
  });
  return { messages: stripped > 0 ? next : messages, stripped };
}

function insertDcpWireStatus(messages, status) {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (message?.role !== 'user' || !Array.isArray(message.content)) continue;
    for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.content[partIndex];
      if (part?.type !== 'text' || typeof part.text !== 'string') continue;
      const match = part.text.match(TERMINAL_DCP_MESSAGE_ID_REGEX);
      let text;
      if (match === null || match.index === undefined) {
        text = `${part.text}${status}`;
      } else {
        const before = part.text.slice(0, match.index);
        // The sentinel owns no surrounding whitespace. Removing it therefore
        // reconstructs the exact status-free projection byte for byte.
        text = `${before}${status}${match[1]}`;
      }
      const content = [...message.content];
      content[partIndex] = { ...part, text };
      const next = [...messages];
      next[messageIndex] = { ...message, content };
      return { messages: next, messageIndex };
    }
  }
  return { messages, messageIndex: -1 };
}

function requiredCompressionMessageEstimate(meter, message) {
  if (typeof meter?.estimateMessage !== 'function') {
    throw new Error('token meter cannot estimate compression messages');
  }
  const estimate = meter.estimateMessage(message);
  if (typeof estimate !== 'number' || !Number.isFinite(estimate) || estimate < 0) {
    throw new Error('token meter returned an invalid compression message estimate');
  }
  return Math.ceil(estimate);
}

/** Validate every state-independent field before loading or reconciling session state. */
function validateCompressionArgumentShape(args, messageMode) {
  const topic = typeof args?.topic === 'string' ? args.topic.trim() : '';
  if (messageMode && topic.length === 0) {
    throw new Error('topic is required and must be a non-empty string');
  }
  if (!Array.isArray(args?.content) || args.content.length === 0) {
    throw new Error('content is required and must be a non-empty array');
  }
  for (let index = 0; index < args.content.length; index += 1) {
    const entry = args.content[index] ?? {};
    if (typeof entry.summary !== 'string' || entry.summary.trim().length === 0) {
      throw new Error(`content[${index}].summary is required and must be a non-empty string`);
    }
    if (messageMode) {
      if (typeof entry.messageId !== 'string' || entry.messageId.trim().length === 0) {
        throw new Error(`content[${index}].messageId is required and must be a non-empty string`);
      }
      if (typeof entry.topic !== 'string' || entry.topic.trim().length === 0) {
        throw new Error(`content[${index}].topic is required and must be a non-empty string`);
      }
      continue;
    }
    if (typeof entry.startId !== 'string' || entry.startId.trim().length === 0) {
      throw new Error(`content[${index}].startId is required and must be a non-empty string`);
    }
    if (typeof entry.endId !== 'string' || entry.endId.trim().length === 0) {
      throw new Error(`content[${index}].endId is required and must be a non-empty string`);
    }
  }
  if (messageMode || topic.length > 0) return topic;
  const compatibilityTopics = [...new Set(args.content
    .map((entry) => typeof entry?.topic === 'string' ? entry.topic.trim() : '')
    .filter((entryTopic) => entryTopic.length > 0))];
  if (compatibilityTopics.length === 0) {
    throw new Error('topic is required and must be a non-empty string');
  }
  if (compatibilityTopics.length > 1) {
    throw new Error('top-level topic is required when content[].topic values differ');
  }
  return compatibilityTopics[0];
}

function estimateWireMessages(meter, messages) {
  if (typeof meter?.estimateMessage !== 'function') return undefined;
  let total = 0;
  for (const message of messages) {
    const estimate = meter.estimateMessage(message);
    if (typeof estimate !== 'number' || !Number.isFinite(estimate) || estimate < 0) return undefined;
    total += estimate;
    if (!Number.isFinite(total)) return undefined;
  }
  return Math.ceil(total);
}

/** Finalize the provider-bound projection with one non-persistent estimate status. */
export function finalizeDcpWireContext(messages, meter, options = {}) {
  const statusFree = stripDcpWireStatuses(messages);
  if (options.enabled !== true) {
    return {
      messages: statusFree.messages,
      statusFreeEstimate: undefined,
      finalizedEstimate: undefined,
      statusCost: 0,
      visible: false,
      stripped: statusFree.stripped
    };
  }
  let statusFreeEstimate;
  try {
    statusFreeEstimate = estimateWireMessages(meter, statusFree.messages);
  } catch {
    statusFreeEstimate = undefined;
  }

  if (statusFree.messages.length === 0) {
    return {
      messages: statusFree.messages,
      statusFreeEstimate,
      finalizedEstimate: statusFreeEstimate,
      statusCost: 0,
      visible: false,
      stripped: statusFree.stripped
    };
  }

  if (statusFreeEstimate === undefined) {
    const fallback = insertDcpWireStatus(statusFree.messages, wireStatusText(undefined, options.lastCompression));
    return {
      messages: fallback.messages,
      statusFreeEstimate: undefined,
      finalizedEstimate: undefined,
      statusCost: undefined,
      visible: fallback.messageIndex >= 0,
      stripped: statusFree.stripped
    };
  }

  const provisional = insertDcpWireStatus(statusFree.messages, wireStatusText(statusFreeEstimate, options.lastCompression));
  if (provisional.messageIndex < 0) {
    return {
      messages: statusFree.messages,
      statusFreeEstimate,
      finalizedEstimate: statusFreeEstimate,
      statusCost: 0,
      visible: false,
      stripped: statusFree.stripped
    };
  }

  let advertisedEstimate;
  try {
    advertisedEstimate = estimateWireMessages(meter, provisional.messages);
  } catch {
    advertisedEstimate = undefined;
  }
  if (advertisedEstimate === undefined) {
    const fallback = insertDcpWireStatus(statusFree.messages, wireStatusText(undefined, options.lastCompression));
    return {
      messages: fallback.messages,
      statusFreeEstimate: undefined,
      finalizedEstimate: undefined,
      statusCost: undefined,
      visible: true,
      stripped: statusFree.stripped
    };
  }

  // One provisional measurement prices the status. The displayed approximation is
  // not recursively regenerated if its own digits alter that price.
  const finalized = insertDcpWireStatus(statusFree.messages, wireStatusText(advertisedEstimate, options.lastCompression));
  let finalizedEstimate = advertisedEstimate;
  try {
    finalizedEstimate = estimateWireMessages(meter, finalized.messages) ?? advertisedEstimate;
  } catch {}
  return {
    messages: finalized.messages,
    statusFreeEstimate,
    finalizedEstimate,
    statusCost: finalizedEstimate - statusFreeEstimate,
    visible: true,
    stripped: statusFree.stripped
  };
}

/** Reconstruct trusted inherited DCP summaries from a fork's visible surface. */
function syncVisibleBlockState(session, state, meter) {
  let changed = false;
  for (const rawSeq of session?.surface?.nodes ?? []) {
    const seq = Number(rawSeq);
    const event = session.eventAt?.(rawSeq) ?? session.eventAt?.(SessionSeq(seq));
    if (event?.type !== 'user/message') continue;
    const message = visibleMessage(event);
    if (message?.source?.kind !== PLUGIN_SOURCE_KIND) continue;
    const summary = visibleText(message);
    if (!/^\s*\[Compressed conversation section\]/.test(summary)) continue;
    const footer = summary.match(/<dcp-message-id>b([1-9]\d*)<\/dcp-message-id>\s*$/i);
    if (footer === null) continue;
    const blockId = footer[1];
    const existing = state.get(blockId);
    if (existing !== undefined) {
      if (existing.active !== false && Number(existing.nodeSeq) !== seq) {
        existing.nodeSeq = seq;
        state.put(existing);
        changed = true;
      }
      continue;
    }
    const shadowedSeqs = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs.map(Number).filter(Number.isInteger) : [];
    const shadowedMessageIds = shadowedSeqs
      .map((sourceSeq) => session.deriveEventMessage?.(session.eventAt?.(SessionSeq(sourceSeq)))?.id)
      .filter((id) => typeof id === 'string' && id.length > 0);
    let summaryTokens = 0;
    try {
      if (typeof meter?.estimateMessage === 'function') summaryTokens = meter.estimateMessage(message);
    } catch {
      summaryTokens = 0;
    }
    state.restore({
      blockId,
      topic: typeof message.source.summary === 'string' ? message.source.summary : '(inherited)',
      summary,
      summaryTokens,
      anchorMessageId: shadowedMessageIds[0] ?? String(message.id),
      shadowedMessageIds: shadowedMessageIds.length > 0 ? shadowedMessageIds : [String(message.id)],
      shadowedSeqs: shadowedSeqs.length > 0 ? shadowedSeqs : [seq],
      nodeSeq: seq,
      start: shadowedSeqs[0] ?? seq,
      end: shadowedSeqs.at(-1) ?? seq,
      active: true
    });
    changed = true;
  }
  return changed;
}

/** Authoritative active block records in their current left-to-right surface order. */
function orderedCompressedBlocks(references, state) {
  const seen = new Set();
  const blocks = [];
  for (const group of references?.groups ?? []) {
    if (group?.kind !== 'compressed-block') continue;
    const registered = state.get(group.blockId);
    const blockId = numericBlockId(registered?.blockId);
    if (registered?.active === false || blockId === undefined || blockId !== group.blockId || seen.has(blockId)) continue;
    seen.add(blockId);
    blocks.push({ blockId, topic: registered.topic });
  }
  return blocks;
}

/**
 * Where upstream keeps its prompt-override directory.
 *
 * Upstream resolves it as `<XDG_CONFIG_HOME>/opencode/dcp-prompts`, falling back
 * to `~/.config` when the variable is unset (`lib/prompts/store.ts`).
 *
 * @returns the XDG configuration home.
 */
function promptConfigHome() {
  const xdg = process.env.XDG_CONFIG_HOME;
  return typeof xdg === 'string' && xdg.trim().length > 0 ? xdg : join(homedir(), '.config');
}

const PROMPT_FILES = {
  system: 'system.md',
  compressRange: 'compress-range.md',
  compressMessage: 'compress-message.md',
  contextLimitNudge: 'context-limit-nudge.md',
  turnNudge: 'turn-nudge.md',
  iterationNudge: 'iteration-nudge.md'
};

function nearestOpencodeDir(start) {
  let current = start;
  while (typeof current === 'string' && current.length > 0) {
    const candidate = join(current, '.opencode');
    try {
      if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    } catch {}
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function normalizePromptOverride(name, input) {
  if (typeof input !== 'string') return undefined;
  let text = input
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[ \t]*\/\/.*?\/\/[ \t]*$/gm, '')
    .trim();
  if (text.length === 0) return undefined;
  if (name === 'system') {
    text = text.replace(/<manual>[\s\S]*?<\/manual>/gi, '').replace(/<subagent>[\s\S]*?<\/subagent>/gi, '').trim();
  }
  if (name === 'compressRange' || name === 'compressMessage') return text;
  const starts = /^\s*<dcp-system-reminder\b[^>]*>/i.test(text);
  const ends = /<\/dcp-system-reminder>\s*$/i.test(text);
  if (starts !== ends) return undefined;
  if (starts) {
    text = text
      .replace(/^\s*<dcp-system-reminder\b[^>]*>\s*/i, '')
      .replace(/\s*<\/dcp-system-reminder>\s*$/i, '')
      .trim();
  }
  return text.length > 0 ? `<dcp-system-reminder>\n${text}\n</dcp-system-reminder>` : undefined;
}

function promptReferenceText(name) {
  let text = editablePromptDefault(name).trim();
  if (name !== 'compressRange' && name !== 'compressMessage') {
    text = text
      .replace(/^\s*<dcp-system-reminder\b[^>]*>\s*/i, '')
      .replace(/\s*<\/dcp-system-reminder>\s*$/i, '')
      .trim();
  }
  return `${text}\n`;
}

function ensurePromptReferenceFiles(logger) {
  const root = join(promptConfigHome(), 'opencode', 'dcp-prompts');
  const defaults = join(root, 'defaults');
  const overrides = join(root, 'overrides');
  try {
    mkdirSync(defaults, { recursive: true });
    mkdirSync(overrides, { recursive: true });
    for (const name of EDITABLE_PROMPTS) {
      const path = join(defaults, PROMPT_FILES[name]);
      const content = promptReferenceText(name);
      if (readTextIfPresent(path) !== content) writeFileSync(path, content, 'utf8');
    }
    const readme = [
      '# DCP Prompt Defaults',
      '',
      'This directory stores the DCP prompts.',
      'Each prompt file here should contain plain text only (no XML wrappers).',
      '',
      '## Creating Overrides',
      '',
      '1. Copy a prompt file from this directory into an overrides directory using the same filename.',
      '2. Edit the copied file using plain text.',
      '3. Restart OpenCode.',
      '',
      'To reset an override, delete the matching file from your overrides directory.',
      '',
      'Do not edit the default prompt files directly, they are just for reference, only files in the overrides directory are used.',
      '',
      'Override precedence (highest first):',
      '1. `.opencode/dcp-prompts/overrides/` (project)',
      '2. `$OPENCODE_CONFIG_DIR/dcp-prompts/overrides/` (config dir)',
      '3. `~/.config/opencode/dcp-prompts/overrides/` (global)',
      '',
      '## Prompt Files',
      '',
      '- `system.md`',
      '  - Purpose: Core system-level DCP instruction block.',
      '  - Runtime use: Injected into the model system prompt on every request.',
      '- `compress-range.md`',
      '  - Purpose: range-mode compress tool instructions and summary constraints.',
      '  - Runtime use: Registered as the range-mode compress tool description.',
      '- `compress-message.md`',
      '  - Purpose: message-mode compress tool instructions and summary constraints.',
      '  - Runtime use: Registered as the message-mode compress tool description.',
      '- `context-limit-nudge.md`',
      '  - Purpose: High-priority nudge when context is over max threshold.',
      '  - Runtime use: Injected when context usage is beyond configured max limits.',
      '- `turn-nudge.md`',
      '  - Purpose: Nudge to compress closed ranges at turn boundaries.',
      '  - Runtime use: Injected when context is between min and max limits at a new user turn.',
      '- `iteration-nudge.md`',
      '  - Purpose: Nudge after many iterations without user input.',
      '  - Runtime use: Injected when iteration threshold is crossed.',
      ''
    ].join('\n');
    const readmePath = join(defaults, 'README.md');
    if (readTextIfPresent(readmePath) !== readme) writeFileSync(readmePath, readme, 'utf8');
  } catch (error) {
    logger?.warn?.(`${PLUGIN_ID}: failed to materialize prompt reference files: ${errorLine(error)}`);
  }
}

/**
 * Whether one session is a subagent child.
 *
 * Upstream knows this because OpenCode calls it with a subagent flag; a DSH
 * session records the same fact durably — `origin: 'subagent'` or a non-zero
 * `delegationDepth` (`dsh-session/lib/types/types.d.ts`). Reading the header
 * keeps the notice correct after a restart, which a runtime-only flag would not.
 *
 * @param session - session to inspect.
 * @returns true when the session is a subagent child.
 */
function isSubagentSession(session) {
  const header = session?.header;
  if (header === undefined || header === null) return false;
  if (header.origin === 'subagent') return true;
  return typeof header.delegationDepth === 'number' && header.delegationDepth > 0;
}

/**
 * The reminder text a context-limit nudge carries.
 *
 * Upstream keeps this text in `lib/prompts/context-limit-nudge.ts` and uses the
 * SAME reminder for both force levels — `nudgeForce` picks the addressee, not the
 * wording. The port used to invent its own two-line text, so the model received a
 * different emergency instruction here than in OpenCode; the upstream text is
 * therefore used verbatim with no port diagnostic suffix.
 *
 * `compress.nudgeForce` chooses the role of the message the wire transform pastes
 * the turn nudge into, matching upstream —
 * `targetRole = config.compress.nudgeForce === "strong" ? "user" : "assistant"`
 * (`lib/messages/inject/utils.ts:277`), consumed by `collectTurnNudgeAnchors` at
 * `:331`. The shared wire coordinator provides the same provider-bound edit while
 * leaving the session log untouched.
 *
 * @param options - whether the limit is exceeded and an optional prompt override.
 * @returns the reminder text.
 */
function nudgeText(options) {
  const reminder = options.text ?? (options.over === true ? CONTEXT_LIMIT_NUDGE : TURN_NUDGE);
  return reminder.trim();
}

/* ------------------------------------------------------------- engine core */

/**
 * The DCP compaction engine: the shipped replay-aware backend plus two
 * deterministic passes that run before the summarizer is ever considered.
 *
 * Subclassing rather than reimplementing is deliberate — `summarize()` is the
 * documented sole subclass hook, so pressure accounting, retention selection,
 * tool-pairing-safe cuts, checkpoint framing, and the durable
 * `compaction/start → summary → user/message → end` bracket all stay owned by
 * the shipped engine. What this class adds is the pruning policy.
 */
export class DcpCompactionEngine extends BasicCompactionEngine {
  /**
   * @param ctx - context carrying `llm` and `tokenMeter`.
   * @param resolved - the DCP configuration: `semantic` for this plugin,
   *   `basic` for the parent, which rejects keys it does not own.
   */
  constructor(ctx, resolved) {
    super(ctx, resolved.basic);
    /**
     * This plugin's own configuration.
     *
     * It CANNOT live on `this.config`: the parent constructor assigns that name
     * (`this.config = resolveConfig(config)`) as an OWN property, which shadows
     * any accessor this class declares on its prototype. The parent's value
     * holds only the shipped backend's policy fields, so reading `this.config`
     * for DCP settings silently yielded a document with no `strategies` — and
     * every consumer of it threw on the first property access.
     */
    this.dcpConfig = resolved.semantic;
    /** The session workspace, used to find a project-local prompt override. */
    this.workspaceRoot = typeof resolved.workspaceRoot === 'string' ? resolved.workspaceRoot : process.cwd();
    if (this.dcpConfig.experimental.customPrompts) ensurePromptReferenceFiles(ctx.logger);
    /** Running counters behind `/dcp`. */
    this.stats = {
      deduplicationRuns: 0,
      deduplicationNodes: 0,
      purgeErrorRuns: 0,
      purgeErrorNodes: 0,
      compressions: 0,
      compressionNodes: 0,
      /**
       * When the last deterministic pass ran, and what it landed.
       *
       * NOT a rewrite counter. The previous field counted an outgoing-list
       * rewrite that the harness discarded — a measurement of something that
       * never happened, and the reason `/dcp stats` looked healthy on a plugin
       * with no effect. Counting is done from the SESSION now (see the `stats`
       * verb): a prune leaves a `compaction/prune` event, so it is observable
       * rather than self-reported.
       */
      lastPass: undefined
    };
    this._compressionJournals = new Map();
    this._compressionLandingLocks = new Set();
    this._compressionFaultInjector = undefined;
    /** Latest status-free/finalized provider estimate, never persisted. */
    this._wireEstimates = new Map();
    this._registerNudges();
  }

  wireEstimateFor(session) {
    return this._wireEstimates.get(String(session?.id ?? session ?? ''));
  }

  recordWireEstimate(session, estimate) {
    this._wireEstimates.set(String(session?.id ?? ''), estimate);
  }

  /** Invalidate every surface-derived cache before native-compaction persistence. */
  invalidateForNativeCompaction(session, marker) {
    const sessionId = String(session?.id ?? 'unknown');
    const state = this.blocksFor(session);
    const forgotten = state.resetForCompaction(marker);
    syncVisibleBlockState(session, state, this.ctx?.tokenMeter);

    // These values feed the next prompt/status synchronously. They must not stay
    // observable while journal or registry persistence is still in progress.
    this._wireEstimates.delete(sessionId);
    this._nudgePrompt?.delete(sessionId);
    if (String(this._lastSession?.id ?? '') === sessionId) this._lastSession = undefined;
    this.lastNudge = undefined;
    this.nudgeCount = 0;
    this.stats = state.stats;

    let superseded = 0;
    try {
      superseded = this.compressionJournal(session).supersedePending({
        supersededBy: 'native-compaction',
        compactionSeq: Number(marker)
      }, (operation) => compressionOperationPredatesCompaction(session, operation));
    } catch (error) {
      this.ctx.logger?.warn?.(`${PLUGIN_ID}: could not supersede compression operations for ${sessionId}: ${errorLine(error)}`);
    }
    try {
      this.saveBlocks(session);
    } catch (error) {
      this.ctx.logger?.warn?.(`${PLUGIN_ID}: could not persist native-compaction invalidation for ${sessionId}: ${errorLine(error)}`);
    }
    return { state, forgotten, superseded };
  }

  manualModeFor(session) {
    const override = this.blocksFor(session).manualModeOverride;
    return typeof override === 'boolean' ? override : this.dcpConfig.manualMode === true;
  }

  automaticEnabledFor(session) {
    return this.availability(session).available && (!this.manualModeFor(session) || this.dcpConfig.automaticStrategies);
  }

  /**
   * Compression blocks for the session currently in play.
   *
   * THE POINT OF THIS SHAPE. Upstream never edits the conversation: it rewrites
   * the OUTGOING message array of each request (`lib/hooks.ts`,
   * `createChatMessageTransformHandler`), and keeps the summaries in its own
   * state, injected as a synthetic user message at each block's anchor. Blocks
   * are addressed by DURABLE message id, so a compression stays valid after the
   * surface shifts underneath it, and the whole state is persisted per session —
   * upstream's `lib/state/persistence.ts`.
   *
   * @returns the live block state.
   */
  get blocks() {
    this._blocksBySession ??= new Map();
    const sessionId = this._blocksSessionId ?? 'unbound';
    if (!this._blocksBySession.has(sessionId)) {
      this._blocksBySession.set(sessionId, new DcpBlockState());
    }
    return this._blocksBySession.get(sessionId);
  }

  /**
   * Load a session's persisted compression state.
   *
   * ONE STATE PER SESSION, held in a map, because a plugin instance serves every
   * session the server runs and outlives each of them. A single `_blocks` slot
   * meant a compression in one session was visible to the next one that touched
   * the engine — which showed up as "already compressed" on a span that had
   * never been touched, and would be a real leak across concurrent sessions.
   *
   * Loading is lazy and once per session: a missing file is the normal first
   * run, and the state is only reread when a session id is seen for the first
   * time.
   *
   * @param session - the session about to send a request.
   * @returns the block state for that session.
   */
  blocksFor(session) {
    const sessionId = String(session?.id ?? 'unknown');
    this._blocksBySession ??= new Map();
    if (!this._blocksBySession.has(sessionId)) {
      const state = new DcpBlockState(readBlockState(this.ctx, sessionId));
      const marker = latestCompactionMarker(session);
      let changed = false;
      if (marker > state.lastCompaction) {
        state.resetForCompaction(marker);
        changed = true;
      }
      if (syncVisibleBlockState(session, state, this.ctx?.tokenMeter)) changed = true;
      this._blocksBySession.set(sessionId, state);
      if (changed) writeBlockState(this.ctx, sessionId, state);
    }
    // `blocks` resolves the current session through this id, so every existing
    // call site reads this session's state without being told which one it is.
    this._blocksSessionId = sessionId;
    const state = this._blocksBySession.get(sessionId);
    this.stats = state.stats;
    this.lastNudge = state.nudges.lastDecision;
    this.nudgeCount = state.nudges.count;
    return state;
  }

  /** Build a read-only planning snapshot without caching or persisting first-touch state. */
  previewBlocksFor(session) {
    const sessionId = String(session?.id ?? 'unknown');
    const cached = this._blocksBySession?.get(sessionId);
    const state = new DcpBlockState(cached === undefined ? readBlockState(this.ctx, sessionId) : cached.toJSON());
    const marker = latestCompactionMarker(session);
    if (marker > state.lastCompaction) state.resetForCompaction(marker);
    syncVisibleBlockState(session, state, this.ctx?.tokenMeter);
    // Native compaction resets user-facing block ids, but durable journal ids must
    // remain unique for the lifetime of the session. First-touch preflight must not
    // populate the live journal cache or create any persistent state.
    const journal = this._compressionJournals.get(sessionId) ?? new CompressionOperationJournal(sessionId);
    state.nextRunId = Math.max(state.nextRunId, journal.nextRunIdFloor());
    return state;
  }

  /** Persist the current block state, upstream's `saveSessionState`. */
  saveBlocks(session) {
    const sessionId = String(session?.id ?? this._blocksSessionId ?? '');
    if (sessionId.length === 0) return;
    writeBlockState(this.ctx, sessionId, this.blocksFor({ id: sessionId }));
  }

  /** Mandatory state persistence used by durable compression landing. */
  saveBlocksStrict(session, state = this.blocksFor(session)) {
    const sessionId = String(session?.id ?? this._blocksSessionId ?? '');
    if (sessionId.length === 0) throw new Error('cannot persist DCP compression state without a session id');
    writeBlockState(this.ctx, sessionId, state, { strict: true });
  }

  compressionJournal(session) {
    const sessionId = String(session?.id ?? 'unknown');
    if (!this._compressionJournals.has(sessionId)) {
      this._compressionJournals.set(sessionId, new CompressionOperationJournal(sessionId));
    }
    return this._compressionJournals.get(sessionId);
  }

  /** Focused fault injection for crash-boundary regression tests. */
  setCompressionFaultInjector(injector) {
    this._compressionFaultInjector = typeof injector === 'function' ? injector : undefined;
  }

  compressionFault(phase, operation) {
    this._compressionFaultInjector?.(phase, operation);
  }

  withCompressionLandingLock(session, callback) {
    const sessionId = String(session?.id ?? 'unknown');
    if (this._compressionLandingLocks.has(sessionId)) {
      throw new Error(`DCP compression landing is already active for session ${sessionId}`);
    }
    this._compressionLandingLocks.add(sessionId);
    try {
      return callback();
    } finally {
      this._compressionLandingLocks.delete(sessionId);
    }
  }

  advanceCompressionOperation(journal, operationId, targetPhase, details = {}) {
    const phases = ['planned', 'prune_landed', 'replacement_landed', 'registry_persisted', 'committed'];
    let operation = journal.get(operationId);
    let index = phases.indexOf(operation?.phase);
    const target = phases.indexOf(targetPhase);
    if (index === -1 || target === -1) return operation;
    while (index < target) {
      const phase = phases[index + 1];
      operation = journal.transition(operationId, phase, phase === targetPhase ? details : {});
      this.compressionFault(phase, operation);
      index += 1;
    }
    return operation;
  }

  ensureCompressionReservation(session, state, operation, { consumeManualPermit = true } = {}) {
    const reservation = operation.plan.reservation;
    state.nextRunId = Math.max(state.nextRunId, reservation.nextRunId);
    state.nextBlockId = Math.max(state.nextBlockId, reservation.nextBlockId);
    if (consumeManualPermit && reservation.consumeManualPermit === true) state.manualPermit = false;
    this.saveBlocksStrict(session, state);
  }

  applyCompressionRegistry(session, state, operation, replacementSeq) {
    const existing = state.get(operation.blockId);
    if (existing?.operationId !== operation.operationId) {
      for (const childBlockId of operation.plan.block.childBlockIds ?? []) {
        if (String(childBlockId) === operation.blockId) continue;
        const child = state.get(String(childBlockId));
        if (child !== undefined) {
          child.parentBlockIds ??= [];
          if (!child.parentBlockIds.includes(operation.blockId)) child.parentBlockIds.push(operation.blockId);
        }
        state.deactivate(String(childBlockId), { byBlockId: operation.blockId });
      }
      const block = {
        ...operation.plan.block,
        operationId: operation.operationId,
        batchId: operation.batchId,
        nodeSeq: Number(replacementSeq)
      };
      state.put(block);
      const delta = operation.plan.statsDelta;
      state.stats.compressions += delta.compressions;
      state.stats.compressionNodes += delta.compressionNodes;
    }
    this.saveBlocksStrict(session, state);
  }

  failCompressionOperation(journal, operation, error) {
    if (operation.phase !== 'failed' && operation.phase !== 'superseded' && operation.phase !== 'committed') {
      journal.transition(operation.operationId, 'failed', { failure: errorLine(error) });
    }
    throw error;
  }

  reconcileCompressionOperation(session, state, journal, initialOperation) {
    let operation = journal.get(initialOperation.operationId);
    if (operation?.phase === 'failed' || operation?.phase === 'superseded') return operation;

    const reservation = operation?.plan?.reservation;
    const committedRegistryIsCurrent = operation?.phase === 'committed'
      && state.get(operation.blockId)?.operationId === operation.operationId
      && state.nextRunId >= reservation.nextRunId
      && state.nextBlockId >= reservation.nextBlockId;
    // Healthy terminal rows are recovery history, not work. Replaying them used
    // to rewrite the entire block registry once per historical compression and
    // could also consume a manual permit armed after that compression finished.
    if (committedRegistryIsCurrent) return operation;

    if (compressionOperationPredatesCompaction(session, operation)) {
      if (operation?.phase === 'committed') return operation;
      operation = journal.transition(operation.operationId, 'superseded', {
        supersededBy: 'native-compaction',
        compactionSeq: latestCompactionMarker(session)
      });
      return operation;
    }
    this.ensureCompressionReservation(session, state, operation, {
      consumeManualPermit: operation?.phase !== 'committed'
    });

    let evidence = compressionOperationEvidence(session, operation);
    if (evidence.prunes.length > 1 || evidence.replacements.length > 1) {
      return this.failCompressionOperation(journal, operation, new Error(`compression operation ${operation.operationId} has duplicate append-log evidence`));
    }
    if (evidence.replacements.length === 1 && evidence.prunes.length === 0) {
      return this.failCompressionOperation(journal, operation, new Error(`compression operation ${operation.operationId} has a replacement without its prune`));
    }

    let prune = evidence.prunes[0];
    let replacement = evidence.replacements[0];
    if (prune !== undefined && (prune.data?.dcpBatchId !== operation.batchId
      || String(prune.data?.dcpBlockId) !== operation.blockId)) {
      return this.failCompressionOperation(journal, operation, new Error(`compression operation ${operation.operationId} has mismatched prune metadata`));
    }
    const replacementMessage = replacement?.data?.message ?? replacement?.data;
    if (replacement !== undefined && (replacementMessage?.source?.dcpOperationId !== operation.operationId
      || replacementMessage?.source?.dcpBatchId !== operation.batchId
      || String(replacementMessage?.source?.dcpBlockId) !== operation.blockId)) {
      return this.failCompressionOperation(journal, operation, new Error(`compression operation ${operation.operationId} has mismatched replacement metadata`));
    }
    if (prune === undefined) {
      prune = appendCompressionPrune(session, operation);
    }
    operation = this.advanceCompressionOperation(journal, operation.operationId, 'prune_landed', { pruneSeq: Number(prune.seq) });

    if (replacement === undefined) {
      const events = session.snapshotEvents();
      const last = events[events.length - 1];
      if (Number(last?.seq) !== Number(prune.seq)) {
        return this.failCompressionOperation(journal, operation, new Error(`compression operation ${operation.operationId} lost prune/replacement adjacency`));
      }
      replacement = appendCompressionReplacement(session, operation);
    }
    if (Number(replacement.seq) !== Number(prune.seq) + 1) {
      return this.failCompressionOperation(journal, operation, new Error(`compression operation ${operation.operationId} has non-adjacent prune and replacement evidence`));
    }
    operation = this.advanceCompressionOperation(journal, operation.operationId, 'replacement_landed', { replacementSeq: Number(replacement.seq) });

    this.applyCompressionRegistry(session, state, operation, replacement.seq);
    operation = this.advanceCompressionOperation(journal, operation.operationId, 'registry_persisted');
    operation = this.advanceCompressionOperation(journal, operation.operationId, 'committed');
    return operation;
  }

  /** Reconcile all sidecar intents against known append-log evidence exactly once. */
  reconcileCompressionOperations(session) {
    return this.withCompressionLandingLock(session, () => {
      const state = this.blocksFor(session);
      const journal = this.compressionJournal(session);
      for (const operation of journal.operations()) {
        this.reconcileCompressionOperation(session, state, journal, operation);
      }
      const nextRunId = journal.nextRunIdFloor();
      if (state.nextRunId < nextRunId) {
        state.nextRunId = nextRunId;
        this.saveBlocksStrict(session, state);
      }
      return journal.operations();
    });
  }

  /** The next block number, upstream's `#1`, `#2`, … display. */
  nextBlockId() {
    return this.blocks.mintBlockId();
  }

  /**
   * Record one landed compression block.
   * @param block - the block to remember.
   * @returns the stored block.
   */
  registerBlock(block) {
    this.blocks.put(block);
    return block;
  }

  /**
   * Resolve a user-supplied block reference to a live block.
   * @param reference - a block number or id.
   * @returns the block, or `undefined` when nothing matches.
   */
  blockBy(reference) {
    const wanted = String(reference ?? '').trim();
    if (wanted.length === 0) return undefined;
    if (this.blocks.has(wanted)) return this.blocks.get(wanted);
    for (const block of this.blocks.values()) {
      if (block.blockId === wanted.replace(/^[#b]/i, '')) return block;
    }
    return undefined;
  }

  /** Live blocks in creation order, for listings and commands. */
  activeBlocks() {
    return this.blocks.active();
  }

  /**
   * Stored summary text by NUMERIC block id.
   *
   * The placeholder machinery is a port of upstream's, where block ids are
   * numbers; this port stores them as strings. This is the one place the two
   * representations meet, so every lookup below stays numeric.
   *
   * @returns the lookup table.
   */
  blockSummaries() {
    const map = new Map();
    for (const block of this.blocks.values()) {
      const id = Number.parseInt(String(block.blockId), 10);
      if (Number.isInteger(id)) map.set(id, block.summary);
    }
    return map;
  }

  /** Stable model-facing references for the current DSH surface. */
  messageReferences(session, options = {}) {
    const state = this.blocksFor(session);
    const references = collectMessageReferences(session, state, { assign: options.assign !== false });
    if (references.assigned > 0 && options.persist === true) this.saveBlocks(session);
    return references;
  }

  /** A read-only alias/reference view for whole-batch compression preflight. */
  snapshotMessageReferences(session, state = this.blocksFor(session)) {
    return collectMessageReferences(session, state, { assign: false });
  }

  /** Test/diagnostic lookup from an internal surface address to its visible ref. */
  boundaryRefAtSeq(session, seq) {
    const index = session?.surface?.nodes?.findIndex?.((candidate) => Number(candidate) === Number(seq));
    if (index < 0) return undefined;
    return this.messageReferences(session).groups.find((group) => index >= group.startIndex && index <= group.endIndex)?.ref;
  }

  /** Resolve visible mNNNN/bN boundaries using upstream's validation wording. */
  resolveBoundaryIds(session, startId, endId, references = this.messageReferences(session)) {
    const issues = [];
    const parsedStart = parseBoundaryId(startId);
    const parsedEnd = parseBoundaryId(endId);
    if (parsedStart === null) issues.push('startId is invalid. Use an injected message ID (mNNNN) or block ID (bN).');
    if (parsedEnd === null) issues.push('endId is invalid. Use an injected message ID (mNNNN) or block ID (bN).');
    if (issues.length > 0) throw new Error(issues.length === 1 ? issues[0] : issues.map((issue) => `- ${issue}`).join('\n'));
    const startReference = references.byRef.get(parsedStart.ref);
    const endReference = references.byRef.get(parsedEnd.ref);
    if (startReference === undefined) issues.push(`startId ${parsedStart.ref} is not available in the current conversation context. Choose an injected ID visible in context.`);
    if (endReference === undefined) issues.push(`endId ${parsedEnd.ref} is not available in the current conversation context. Choose an injected ID visible in context.`);
    if (issues.length > 0) throw new Error(issues.length === 1 ? issues[0] : issues.map((issue) => `- ${issue}`).join('\n'));
    if (startReference.startIndex > endReference.startIndex) {
      throw new Error(`startId ${parsedStart.ref} appears after endId ${parsedEnd.ref} in the conversation. Start must come before end.`);
    }
    return { references, startReference, endReference };
  }

  /**
   * Register the DCP system-prompt section. Nudges are provider-bound wire text.
   *
   * Upstream DCP nudges the model toward compression with prompts. The port
   * keeps the two that matter and drops the ones that only exist to talk an
   * OpenCode-specific UI into shape.
   */
  _registerNudges() {
    const { ctx } = this;
    const systemPrompt = ctx.get('systemPrompt');
    if (systemPrompt === undefined) return;
    // Upstream composes the prompt at each assembly from the base text plus the
    // extensions that apply RIGHT NOW (`lib/prompts/index.ts:renderSystemPrompt`):
    // the protected-tools reminder, manual mode, and the subagent notice. A
    // static section cannot express that, so the text is a provider.
    const buildText = (assembly) => {
      const session = this._sessionFromAssembly(assembly);
      if (!this.availability(session).available) return '';
      const mode = this.dcpConfig.compress.mode;
      const system = this.customPrompt('system') ?? editablePromptDefault('system', mode);
      return renderSystemPrompt({
        system,
        protectedToolsExtension: buildProtectedToolsExtension(this._protectedToolsForPrompt()),
        manual: this.manualModeFor(session),
        subagent: isSubagentSession(session)
      });
    };
    ctx.effect(() => systemPrompt.section({
      name: 'dcp:system',
      order: 1500,
      text: buildText
    }), 'dcp:system section');
    // Retain the named section for settings/UI compatibility. Runtime nudges are
    // injected by the shared outgoing transform, so this section stays empty.
    ctx.effect(() => systemPrompt.section({
      name: 'dcp:nudge',
      order: 1520,
      text: () => ''
    }), 'dcp:nudge section');
    for (const name of EDITABLE_PROMPTS) {
      const override = this.customPrompt(name);
      if (override !== undefined) {
        ctx.logger.info(`${PLUGIN_ID}: prompt override applied for "${name}" (${override.length} chars)`);
      }
    }
  }

  /**
   * The tool names whose output survives compression, as the prompt states them.
   *
   * Upstream lists `compress.protectedTools` in a `<dcp-system-reminder>` so the
   * model knows not to spend summary space on content the environment keeps
   * (`lib/prompts/extensions/system.ts:buildProtectedToolsExtension`).
   *
   * @returns the protected tool names.
   */
  _protectedToolsForPrompt() {
    const configured = this.dcpConfig.compress.protectedTools;
    return Array.isArray(configured) ? configured : [...DEFAULT_COMPRESS_PROTECTED_TOOLS];
  }

  /**
   * The session a prompt assembly belongs to, when the context names one.
   * @param assembly - the assembly context handed to the section provider.
   * @returns the session, or `undefined`.
   */
  _sessionFromAssembly(assembly) {
    const scope = assembly?.scope;
    if (scope !== undefined && scope !== null) {
      if (typeof scope === 'object' && (typeof scope.snapshotEvents === 'function' || scope.surface !== undefined)) return scope;
      if (typeof scope === 'string' && typeof this.ctx.get === 'function') {
        const agents = this.ctx.get('agents');
        const found = typeof agents?.get === 'function' ? agents.get(scope)?.session : undefined;
        if (found?.surface !== undefined) return found;
      }
    }
    if (typeof this.ctx.get === 'function') {
      const session = this.ctx.get('session');
      if (session?.surface !== undefined) return session;
      const agent = this.ctx.get('agent');
      if (agent?.session?.surface !== undefined) return agent.session;
    }
    return this._lastSession;
  }

  /**
   * Read one prompt override from the user's `dcp-prompts` directory.
   *
   * Upstream exposes SIX editable prompts and reads them from
   * `<XDG_CONFIG_HOME>/opencode/dcp-prompts/overrides/<name>.md`, with project and
   * `OPENCODE_CONFIG_DIR` override directories winning (`lib/prompts/store.ts`). It gates the
   * whole mechanism behind `experimental.customPrompts`, because a stale override
   * silently changes how the model behaves, and it names the six prompts so a
   * typo cannot masquerade as a working override.
   * @param name - one of {@link EDITABLE_PROMPTS}.
   * @param includeInline - false to preview what resetting the saved override uses.
   * @returns normalized runtime text, or `undefined` when custom prompts are off.
   */
  customPrompt(name, includeInline = true) {
    if (!EDITABLE_PROMPTS.includes(name)) {
      this.ctx.logger.warn(`${PLUGIN_ID}: "${name}" is not an overridable prompt; known: ${EDITABLE_PROMPTS.join(', ')}`);
      return undefined;
    }
    if (!this.dcpConfig.experimental.customPrompts) return undefined;
    const configured = this.dcpConfig.prompts?.[name];
    if (includeInline) {
      const normalized = normalizePromptOverride(name, configured);
      if (normalized !== undefined) return normalized;
    }
    const opencode = nearestOpencodeDir(this.workspaceRoot);
    const roots = [
      opencode === undefined ? undefined : join(opencode, 'dcp-prompts', 'overrides'),
      typeof process.env.OPENCODE_CONFIG_DIR === 'string' && process.env.OPENCODE_CONFIG_DIR.length > 0
        ? join(process.env.OPENCODE_CONFIG_DIR, 'dcp-prompts', 'overrides')
        : undefined,
      join(promptConfigHome(), 'opencode', 'dcp-prompts', 'overrides')
    ].filter(Boolean);
    for (const root of roots) {
      const text = readTextIfPresent(join(root, PROMPT_FILES[name]));
      const normalized = normalizePromptOverride(name, text);
      if (normalized !== undefined) return normalized;
    }
    return normalizePromptOverride(name, editablePromptDefault(name, this.dcpConfig.compress.mode));
  }

  /** The DCP strategy configuration for one session, recompiled per call. */
  _plannerConfig() {
    return resolveStrategyConfig(this.dcpConfig);
  }

  /**
   * The compress tool description for one prompt name.
   *
   * Upstream registers the tool with a full instruction text whose mode picks
   * which one applies, and which the user may override through the editable
   * `compressRange`/`compressMessage` prompts (`lib/prompts/store.ts`).
   *
   * @param promptName - the editable prompt name to read.
   * @param bundled - the bundled default when no override exists.
   * @returns the description text.
   */
  customPromptFor(promptName, bundled) {
    return this.customPrompt(promptName) ?? bundled;
  }

  /**
   * The live block a surface node stands in for, when it is one.
   *
   * A compressed block must agree in three places: active registry state, DCP
   * plugin source, and exact header/footer wrapper. Fork/restart synchronization
   * rebuilds registry state before this check; ordinary text cannot impersonate a block.
   *
   * @param session - session owning the node.
   * @param seq - the surface sequence number.
   * @returns `{blockId, summary}`, or `undefined` for a non-block node.
   */
  blockAtSeq(session, seq, state = this.blocksFor(session)) {
    const wanted = Number(seq);
    // WHICH BLOCK A LIVE NODE BELONGS TO, read from the STATE.
    //
    // A compression lands as ONE replacement node standing for the span it
    // shadowed, so a live block node is identified by `nodeSeq` - the seq of that
    // replacement. This is the ONLY way a block on the surface matches: its
    // `shadowedSeqs` name the ORIGINAL events, and those stopped being surface
    // nodes the moment the replacement landed.
    //
    // That distinction was the defect. `blockAtSeq` searched `shadowedSeqs` only,
    // so every real block node was invisible, and the two callers that depend on
    // it silently did the wrong thing: the `(bN)` placeholder pass never inlined
    // an earlier summary, and `confirmStart`/`confirmEnd` did not recognize a
    // block at a range edge - which made `balancedRange` return a range whose END
    // was a node BEFORE its start (`requested 10..10`, resolved `10..8`), because
    // the balance fold ran on past the block into unrelated material.
    const registered = [...state.values()].find((block) => block.active !== false && Number(block.nodeSeq) === wanted);
    if (registered === undefined) return undefined;
    // NOT the `shadowedSeqs`, deliberately. Those name the ORIGINAL events the
    // block replaced, and after the replacement they are no longer surface
    // nodes - so a lookup that matched them would identify ordinary material as
    // a block the moment a stale seq was handed in. That is not a hypothetical:
    // it made `confirmStart` walk a whole tool exchange as if it were one
    // compressed block and return a range whose end preceded its start.
    const event = session.eventAt(SessionSeq(seq));
    if (event?.type !== 'user/message') return undefined;
    const message = event.data?.message ?? event.data;
    if (message?.source?.kind !== PLUGIN_SOURCE_KIND) return undefined;
    const content = message?.content ?? [];
    let text = '';
    for (const piece of content) {
      if (piece?.type === 'text' && typeof piece.text === 'string') text += piece.text;
    }
    if (text.length === 0) return undefined;
    const header = /^\s*\[Compressed conversation section\]/.test(text);
    const footer = text.match(/<dcp-message-id>b([1-9]\d*)<\/dcp-message-id>\s*$/i);
    if (!header || footer === null || String(registered.blockId) !== footer[1]) return undefined;
    return { blockId: registered.blockId, summary: registered.summary, topic: registered.topic };
  }

  /**
   * Evaluate the context-limit reminder for one session.
   *
   * Upstream DCP nudges the model toward compression with dated prompts and
   * thresholds instead of relying on a system-prompt paragraph alone: below
   * `minContextLimit` reminders are off, above `maxContextLimit` a strong one
   * fires every `nudgeFrequency`-th measurement, and `summaryBuffer` widens the
   * effective ceiling by the tokens the live summaries already occupy (the
   * summary text is in the transcript, so counting it twice would fire early).
   *
   * Pure with respect to the session: it reads a measurement, returns a
   * decision, and only the caller injects anything. The per-call counter lives
   * on the engine so the decision is reproducible for a given call number.
   *
   * @param session - session to measure.
   * @returns the decision, or `undefined` when the meter is unavailable.
   */
  evaluateNudge(session) {
    if (!this.availability(session).available || this.manualModeFor(session)) return undefined;
    const meter = this.ctx.tokenMeter;
    if (meter === undefined || typeof meter.measure !== 'function') return undefined;
    const state = this.blocksFor(session);
    let measured;
    try {
      measured = meter.measure(session);
    } catch (error) {
      this.ctx.logger.warn(`${PLUGIN_ID}: token measurement failed: ${errorLine(error)}`);
      return undefined;
    }
    if (typeof measured?.totalTokens !== 'number' || !Number.isFinite(measured.totalTokens)) return undefined;
    const calls = state.nudges.calls + 1;
    state.nudges.calls = calls;

    const config = this.dcpConfig;
    const compress = config.compress;
    const summaryTokens = this.activeBlocks().reduce((total, block) => total + (Number.isFinite(block.summaryTokens) ? block.summaryTokens : 0), 0);
    const buffered = compress.summaryBuffer ? summaryTokens : 0;
    // A percent limit is meaningless without the window it is a percentage OF,
    // so both are resolved together, exactly as upstream does.
    const window = this.contextWindow(session);
    const key = this.modelKey(session);
    const ceilingLimit = compressLimitFor(compress.maxContextLimit, compress.modelMaxLimits, key, window);
    const floorLimit = compressLimitFor(compress.minContextLimit, compress.modelMinLimits, key, window);
    // Upstream treats an unresolvable limit as "no limit": an absent ceiling can
    // never be exceeded, and an absent floor never suppresses the iteration nudge
    // (`utils.ts:156-157`). Infinity is the same statement in arithmetic form.
    const ceiling = (ceilingLimit ?? Number.POSITIVE_INFINITY) + buffered;
    const floor = floorLimit ?? 0;
    const used = measured.totalTokens;
    const references = collectMessageReferences(session, state);
    const groups = references.groups.filter((group) => group.kind === 'message');
    const indexById = new Map(groups.map((group, index) => [group.rawMessageId, index]));
    const last = groups.at(-1);
    const lastAssistant = [...groups].reverse().find((group) => group.role === 'assistant');
    const lastUserIndex = groups.findLastIndex((group) => group.role === 'user');
    const iterations = lastUserIndex < 0 ? groups.length : groups.length - lastUserIndex - 1;
    const addAnchor = (anchors, group, interval) => {
      if (group === undefined) return false;
      let latest = -1;
      for (const id of anchors) latest = Math.max(latest, indexById.get(id) ?? -1);
      const index = indexById.get(group.rawMessageId) ?? -1;
      if (index < 0 || (latest >= 0 && index - latest < interval)) return false;
      const size = anchors.size;
      anchors.add(group.rawMessageId);
      return anchors.size !== size;
    };
    const guidance = buildCompressedBlockGuidance(orderedCompressedBlocks(references, state));

    if (state.nudges.suppressNext) {
      state.nudges.suppressNext = false;
      return { level: 'quiet', used, floor, ceiling, calls, suppressedAfterCompress: true };
    }

    if (used < floor) {
      state.nudges.turnAnchors.clear();
      state.nudges.iterationAnchors.clear();
      return { level: 'quiet', used, floor, ceiling, calls };
    }

    if (used > ceiling) {
      addAnchor(state.nudges.contextAnchors, last, Math.max(1, compress.nudgeFrequency));
      return {
        level: 'strong', used, floor, ceiling, calls, kind: 'context',
        text: appendGuidanceToDcpTag(nudgeText({ over: true, text: this.customPrompt('contextLimitNudge') }), guidance)
      };
    }

    let turnAdded = false;
    if (last?.role === 'user' && lastAssistant !== undefined) {
      const before = state.nudges.turnAnchors.size;
      state.nudges.turnAnchors.add(last.rawMessageId);
      state.nudges.turnAnchors.add(lastAssistant.rawMessageId);
      turnAdded = state.nudges.turnAnchors.size !== before;
    }
    const iterationAdded = iterations >= compress.iterationNudgeThreshold
      ? addAnchor(state.nudges.iterationAnchors, last, Math.max(1, compress.nudgeFrequency))
      : false;
    if (iterationAdded) {
      return {
        level: 'reminder', used, floor, ceiling, calls, iterations, kind: 'iteration',
        text: appendGuidanceToDcpTag(this.customPromptFor('iterationNudge', ITERATION_NUDGE).trim(), guidance)
      };
    }
    if (turnAdded || state.nudges.turnAnchors.size > 0) {
      return {
        level: 'reminder', used, floor, ceiling, calls, kind: 'turn',
        text: appendGuidanceToDcpTag(this.customPromptFor('turnNudge', TURN_NUDGE).trim(), guidance)
      };
    }
    return { level: 'quiet', used, floor, ceiling, calls, iterations };
  }

  /**
   * How many surface steps have landed since the newest user instruction.
   *
   * A step is an assistant message; tool results belong to the step that
   * requested them. Only the live surface is counted, so a span that an earlier
   * compression already replaced stops contributing — which is the property a
   * "you have done a lot since we last spoke" signal needs.
   *
   * @param session - session to inspect.
   * @returns the number of assistant steps after the newest user message.
   */
  _iterationsSinceUserMessage(session) {
    const nodes = session.surface?.nodes ?? [];
    let count = 0;
    for (const seq of nodes) {
      const event = session.eventAt(SessionSeq(seq));
      if (event?.type === 'user/message') {
        count = 0;
        continue;
      }
      if (event?.type === 'assistant/message') count += 1;
    }
    return count;
  }

  /**
   * The `provider/model` key this session routes to, when it declares one.
   *
   * Upstream keys `modelMaxLimits`/`modelMinLimits` by the exact
   * `provider/model` string. A session that does not expose a route simply
   * matches no override, which is the documented behaviour of an absent key.
   *
   * @param session - session to inspect.
   * @returns the route key, or an empty string.
   */
  modelKey(session) {
    const state = this.blocksFor(session);
    if (state.requestModelKey.length > 0) return state.requestModelKey;
    const header = session?.header ?? session?.agent?.session?.header;
    const provider = header?.provider ?? header?.model?.provider;
    const model = header?.model?.id ?? header?.modelId ?? header?.model;
    if (typeof provider !== 'string' || typeof model !== 'string') return '';
    return `${provider}/${model}`;
  }

  /**
   * The routed model's context window for one session, when the log declares it.
   *
   * Upstream reads `state.modelContextLimit` to turn a `"50%"` limit into tokens
   * (`lib/messages/inject/utils.ts:103-114`). A DSH session records the same fact
   * in its `request/context` event (`{ provider, model, contextWindow }`), which
   * is durable and therefore also correct after a restart. The value is cached per
   * session id because the event never changes and this is read on every nudge.
   *
   * @param session - session to inspect.
   * @returns the context window in tokens, or `undefined` when unknown.
   */
  contextWindow(session) {
    const state = this.blocksFor(session);
    if (typeof state.modelContextLimit === 'number') return state.modelContextLimit;
    let found;
    if (typeof session?.snapshotEvents === 'function') {
      try {
        for (const event of session.snapshotEvents()) {
          if (event?.type !== 'request/context') continue;
          const value = event.data?.contextWindow;
          if (typeof value === 'number' && Number.isFinite(value)) found = value;
          const provider = event.data?.provider;
          const model = event.data?.model;
          if (typeof provider === 'string' && typeof model === 'string') state.requestModelKey = `${provider}/${model}`;
        }
      } catch {
        // A session whose log cannot be walked simply has no known window, which
        // is the same state as a log with no `request/context` event at all.
      }
    }
    if (typeof found === 'number') state.modelContextLimit = found;
    return found;
  }

  recordRequestContext(session, request) {
    const state = this.blocksFor(session);
    const provider = request?.provider;
    const model = request?.model;
    const modelId = typeof model === 'string' ? model : model?.id;
    if (typeof provider === 'string' && typeof modelId === 'string') state.requestModelKey = `${provider}/${modelId}`;
    const window = request?.contextWindow ?? request?.contextLimit ?? request?.model?.contextWindow;
    if (typeof window === 'number' && Number.isFinite(window)) state.modelContextLimit = window;
  }

  /**
   * Compute the current reminder and remember it for the outgoing wire transform.
   *
   * Any level whose decision carries text is delivered that way. The same text
   * is not counted twice in a row for one session. Stamp-cached so prompt
   * `text()` does not advance `nudgeFrequency` twice for one surface.
   *
   * @param session - session to measure.
   * @returns the decision that was made, for `/dcp context`.
   */
  _nudgeForPrompt(session) {
    if (!this.availability(session).available || this.manualModeFor(session)) return undefined;
    const sessionKey = String(session?.id ?? '');
    const state = this.blocksFor(session);
    const nodes = session?.surface?.nodes;
    const stamp = `${Array.isArray(nodes) ? nodes.length : 0}:${Array.isArray(nodes) && nodes.length > 0 ? nodes[nodes.length - 1] : ''}:${state.requestModelKey}`;
    this._nudgePrompt = this._nudgePrompt ?? new Map();
    const prev = this._nudgePrompt.get(sessionKey);
    if (prev?.stamp === stamp) return prev.decision;
    if (state.nudges.lastDecision?.stamp === stamp) {
      this._nudgePrompt.set(sessionKey, { stamp, decision: state.nudges.lastDecision });
      return state.nudges.lastDecision;
    }
    const evaluated = this.evaluateNudge(session);
    const decision = evaluated === undefined ? undefined : { ...evaluated, stamp };
    this._nudgePrompt.set(sessionKey, { stamp, decision });
    state.nudges.lastDecision = decision;
    this.lastNudge = decision;
    const text = decision?.text;
    if (typeof text === 'string' && text.length > 0) {
      if (state.nudges.lastText !== text) {
        state.nudges.lastText = text;
        state.nudges.count += 1;
        this.nudgeCount = state.nudges.count;
      }
    }
    this.saveBlocks(session);
    return decision;
  }

  _maybeNudge(session, _agent) {
    if (!this.availability(session).available || this.manualModeFor(session)) return undefined;
    // Measuring-only callers (in-turn strategy pass) must not advance the
    // schedule. Delivery is the shared wire transform on the next request.
    if (this._measuringOnly === true) return this.lastNudge;
    return this._nudgeForPrompt(session);
  }

  clearNudgeAnchors(session, suppressNext = false) {
    const nudges = this.blocksFor(session).nudges;
    nudges.contextAnchors.clear();
    nudges.turnAnchors.clear();
    nudges.iterationAnchors.clear();
    nudges.lastDecision = undefined;
    nudges.lastText = undefined;
    nudges.suppressNext = suppressNext;
  }

  /**
   * Whether this port should act on a session at all.
   *
   * `experimental.allowSubAgents` is upstream's switch for running DCP inside a
   * delegated session. The DSH equivalent of "this is a subagent session" is a
   * session created with a delegation depth above zero, which the session
   * header records. Refusing there is the conservative reading of the upstream
   * default (`false`): a delegated run is short, its transcript returns to the
   * parent as one result, and pruning it would rewrite history the parent is
   * about to quote.
   *
   * @param session - session to judge.
   * @returns true when this port may prune it.
   */
  allowsSession(session) {
    if (this.dcpConfig.experimental.allowSubAgents) return true;
    if (session?.header?.origin === 'subagent') return false;
    const depth = session?.header?.delegationDepth;
    return !(typeof depth === 'number' && depth > 0);
  }

  availability(session) {
    if (!this.dcpConfig.enabled) return { available: false, reason: 'DCP is disabled by configuration' };
    if (this.dcpConfig.compress.permission === 'deny') return { available: false, reason: 'compress permission is denied' };
    if (session !== undefined && !this.allowsSession(session)) return { available: false, reason: 'DCP is unavailable in this subagent session' };
    return { available: true };
  }

  /**
   * Drop manifest entries the session does not actually carry.
   *
   * A manifest entry is a CLAIM; the surface is the FACT. An entry with no
   * recorded replacement node was written before this pass could materialize (or
   * its replacement was later shadowed by a compression), and leaving it in place
   * would make the planner treat a live call as already pruned — permanently, and
   * silently, because the manifest is persisted and reloaded on the next start.
   *
   * @param session - the live session.
   * @param state - its prune state.
   * @returns the call ids that were forgotten.
   */
  _forgetUnmaterializedPrunes(session, state) {
    const nodes = session?.surface?.nodes;
    if (!Array.isArray(nodes)) return [];
    const present = new Set(nodes.map((seq) => Number(seq)));
    const forgotten = [];
    for (const [callId, entry] of state.prunedNodes) {
      if (present.has(Number(entry.seq))) continue;
      // The placeholder node is gone: either a compression consumed it, or it
      // never landed in this session. Either way the manifest's claim is stale.
      state.prunedNodes.delete(callId);
      state.prunedToolIds.delete(callId);
      state.prunedToolKinds.delete(callId);
      forgotten.push(callId);
    }
    // An entry with no node record at all cannot be verified, so it is not
    // trusted: the planner will re-derive it from the surface, which is the only
    // source that knows whether the call is still live.
    for (const callId of [...state.prunedToolIds.keys()]) {
      if (state.prunedToolKinds.get(callId) !== 'output') continue;
      if (state.prunedNodes.has(callId)) continue;
      state.prunedToolIds.delete(callId);
      state.prunedToolKinds.delete(callId);
      forgotten.push(callId);
    }
    return forgotten;
  }

  /**
   * Land one planned prune as a session replacement — the operation that
   * actually changes what the model receives.
   *
   * WHY THIS EXISTS AT ALL. A prune cannot be done at request time in this
   * harness. `llm/stream` receives a deep-frozen envelope whose message array is
   * frozen too, cordis's `waterfall` discards whatever a listener passes to
   * `next()`, and the type definition says so plainly: the options "arrive
   * deep-frozen (mutation throws) … so listeners read it, never rewrite it". A
   * design that computed a pruned list there and returned it changed nothing —
   * the model kept receiving the whole history while `/dcp stats` reported a
   * saving. The surface is the one channel that reaches the model, and it is the
   * channel the shipped tool-result pruner and the compaction engine both use.
   *
   * @param session - the live session to extend.
   * @param entry - one planned prune, carrying the node seq, the original event,
   *   its derived message and which half of the call must go.
   * @returns the replacement event, or `undefined` when the entry cannot land.
   */
  _materializePrune(session, entry, state) {
    if (entry?.kind !== 'output') return undefined;
    if (!Number.isInteger(entry?.seq) || entry.event === undefined) return undefined;
    // THE SURFACE IS THE GUARD. If the planned node is no longer there, the range
    // it named was already shadowed — by an earlier pass, by a compression, or by
    // the harness's own compaction — and re-appending a replacement over it would
    // be rejected at the append site. Declining here is the honest outcome;
    // appending and swallowing the throw is what let a whole class of failure go
    // unnoticed.
    const nodes = session?.surface?.nodes;
    if (!Array.isArray(nodes) || !nodes.some((seq) => Number(seq) === entry.seq)) return undefined;
    // A completed call loses its payload; a FAILED one keeps its error text and
    // loses the oversized input instead. Upstream draws the same line.
      const text = PRUNED_TOOL_OUTPUT_REPLACEMENT;
    const replacement = prunedToolResultMessage(entry.message, text);
    if (replacement === undefined) return undefined;
    const appended = materializeToolResultPrune(session, {
      seq: entry.seq,
      event: entry.event,
      replacement,
      tokens: entry.tokens
    });
    // The replacement NODE, remembered on the manifest so `decompress` can undo
    // it: the original event is still in the log, and a second replacement over
    // the placeholder's own seq is how it comes back.
    if (state !== undefined && appended !== undefined) {
      state.recordPrunedNode(entry.callId, Number(appended.seq));
    }
    return appended;
  }

  /**
   * Run every deterministic strategy against one session and record what it
   * planned into the PRUNE MANIFEST; a strategy that fails is logged and the
   * others still run.
   *
   * THE POINT OF THIS SHAPE. Upstream's strategies write only into
   * `state.prune.tools` (`lib/strategies/deduplication.ts:90`) and never touch
   * the conversation; the removal happens later, on the outgoing request, where
   * `pruneToolOutputs` swaps one call's output for a placeholder
   * (`lib/messages/prune.ts:73`). An earlier revision of this port instead
   * appended a replacement node that shadowed the whole step — the assistant
   * message and EVERY result it produced — which destroyed sibling results that
   * had nothing to do with the duplicate and left the original unrecoverable in
   * the surface. Recording a call id cannot do that: the manifest names one call,
   * the session keeps every message, and `decompress`/an audit can still read the
   * original text.
   *
   * @param session - session to prune.
   * @param agent - the owning agent, when the caller has it; prune notifications
   *   still inject through it, nudges do not.
   * @param options - `nudge: false` measures without advancing the reminder
   *   schedule, which is what the in-turn strategy pass wants.
   * @returns the manifest entries this pass added, in strategy order.
   */
  pruneSession(session, agent, options = {}) {
    if (!this.availability(session).available) return [];
    const state = this.blocksFor(session);
    const strategyConfig = this._plannerConfig();
    const turn = liveTurn(session);
    const added = [];
    const shouldPlan = this.automaticEnabledFor(session) || options.sweep !== undefined;
    if (shouldPlan) {
      try {
        readToolCalls(session, this.ctx.tokenMeter);
      } catch (error) {
        this.ctx.logger.warn(`${PLUGIN_ID}: token measurement failed before strategy planning: ${errorLine(error)}`);
        return added;
      }
    }
    // A CALL THE MANIFEST CLAIMS IS NOT NECESSARILY PRUNED IN THIS SESSION.
    //
    // The manifest is durable state about what SHOULD be pruned; the session is
    // durable state about what actually was. They can disagree: a state file that
    // outlived the events it named, a session resumed from a log written before
    // the pass existed, a replacement whose append failed. Deciding "already
    // done" from the manifest alone leaves such a session permanently unpruned —
    // and that is not hypothetical, it is what the first version of this code did
    // until the end-to-end check caught it.
    //
    // So the manifest is RE-SEEDED from the session first: an entry whose
    // replacement node is gone (or was never there) is forgotten, which puts the
    // call back in front of the planners so it can be materialized again.
    const forgotten = this._forgetUnmaterializedPrunes(session, state);
    this._lastSession = session;
    this._measuringOnly = options.nudge === false;
    try {
      this._maybeNudge(session, agent);
    } finally {
      this._measuringOnly = false;
    }
    // Upstream reports what it pruned, at a level the user chooses. Delivering
    // it as a message is the `chat` mode; `toast` has no DSH equivalent, so it
    // goes to the session log instead of the transcript — the boundary between
    // "the model should see this" and "the operator should" is exactly what
    // that setting is about.
    const report = () => this._reportPruning(added);

    const runStrategy = (label, plan, stat) => {
      let entries;
      try {
        entries = plan();
      } catch (error) {
        this.ctx.logger.warn(`${PLUGIN_ID}: ${label} planning failed: ${errorLine(error)}`);
        return;
      }
      if (entries.length === 0) return;
      // ONE-WAY, as upstream is: a call already in the manifest keeps its
      // original token count, so a second pass cannot inflate the reported save.
      // "Already there" also decides what this pass REPORTS: re-materializing a
      // stale entry is a repair, not a prune, and counting it again would make
      // `/dcp stats` drift every time a session was reopened.
      const preExisting = new Set(state.prunedToolIds.keys());
      const fresh = state.pruneTools(entries.map((entry) => ({ callId: entry.callId, tokens: entry.tokens, kind: entry.kind })));
      let landed = 0;
      for (const entry of entries) {
        if (!fresh.includes(entry.callId)) continue;
        landed += 1;
        if (preExisting.has(entry.callId)) continue;
        added.push({ strategy: entry.strategy, callId: entry.callId, tool: entry.tool, kind: entry.kind, tokens: entry.tokens, label: entry.label });
      }
      stat(landed);
      // AND THE PRUNE ITSELF, as a session event. Recording a manifest entry is
      // only bookkeeping; this is the operation that changes what the model
      // receives, and it must happen HERE — the surface node still holds the
      // original output, and a later pass would be planning against a surface it
      // no longer recognises.
      //
      // EVERY entry is offered, not only the fresh ones. The manifest is durable
      // state about what SHOULD be pruned; whether the session actually carries
      // the replacement is a separate fact, and the two can disagree — a state
      // file that outlived the events it refers to, a session resumed from a log
      // written before this pass existed, a replacement whose append failed. The
      // guard is therefore the SURFACE, not the manifest: `_materializePrune`
      // declines when the planned node seq is no longer on the surface, which is
      // exactly the "already replaced" case, and lands the event otherwise.
      if (this.materialize === false) return;
      for (const entry of entries) {
        try {
          this._materializePrune(session, entry, state);
        } catch (error) {
          this.ctx.logger.warn(`${PLUGIN_ID}: could not materialize the prune of ${entry.callId}: ${errorLine(error)}`);
        }
      }
    };

    if (shouldPlan) {
      const deps = {
        meter: this.ctx.tokenMeter,
        currentTurn: turn,
        turnProtection: strategyConfig.turnProtection,
        pruned: state.prunedToolIds
      };
      if (options.sweep !== undefined) {
        // A MANUAL SWEEP REPLACES THE AUTOMATIC PASS for this call. It is the same
        // manifest and the same materialization — the only difference is who chose
        // the calls: the user named a count instead of the strategies finding
        // duplicates. Upstream draws the same line (`lib/commands/sweep.ts`).
        //
        // Protection is the command-only SWEEP config. Automatic strategies read
        // only their own lists, matching upstream's separate defaults.
        const sweepConfig = strategyConfig.commands;
        let swept;
        try {
          swept = planSweep(session, {
            meter: deps.meter,
            config: sweepConfig,
            limit: options.sweep.limit,
            sinceUserMessage: options.sweep.sinceUserMessage === true,
            pruned: deps.pruned
          });
        } catch (error) {
          this.ctx.logger.warn(`${PLUGIN_ID}: sweep planning failed: ${errorLine(error)}`);
          swept = { entries: [], skippedProtected: 0 };
        }
        this.lastSweep = swept;
        state.lastSweep = swept;
        runStrategy(
          'sweep',
          () => swept.entries,
          (count) => {
            this.stats.sweepRuns = (this.stats.sweepRuns ?? 0) + 1;
            this.stats.sweepNodes = (this.stats.sweepNodes ?? 0) + count;
          }
        );
      } else {
        runStrategy(
          'deduplication',
          () => planDeduplication(session, strategyConfig.deduplication, deps),
          (count) => {
            this.stats.deduplicationRuns += 1;
            this.stats.deduplicationNodes += count;
          }
        );
        runStrategy(
          'purgeErrors',
          () => planPurgeErrors(session, strategyConfig.purgeErrors, deps),
          (count) => {
            this.stats.purgeErrorRuns += 1;
            this.stats.purgeErrorNodes += count;
          }
        );
      }
    }
    if (added.length > 0 || forgotten.length > 0) {
      // Persist cleanup too, even when automatic strategies are disabled or
      // add nothing: a reload must not resurrect stale prune claims.
      this.saveBlocks(session);
    }
    report();
    return added;
  }

  /**
   * Emit an operator-only pruning report at the configured level.
   *
   * @param added - the manifest entries this pass added.
   * @returns the text that was delivered, or `undefined` when nothing was.
   */
  _reportPruning(added) {
    const level = this.dcpConfig.pruneNotification;
    if (level === 'off' || added.length === 0) return undefined;
    const nodes = added.length;
    const text = level === 'minimal'
      ? `Pruned ${added.length} tool output(s).`
      : [
        `Pruned ${nodes} tool output(s) (the call and its result stay; the payload is replaced on the request):`,
        ...added.map((entry) => `- ${entry.strategy}: ${entry.label}`)
      ].join('\n');
    if (this.dcpConfig.pruneNotificationType === 'chat') {
      this.ctx.logger.info(`${PLUGIN_ID}: ${text.split('\n')[0]}`);
    } else {
      this.ctx.logger.info(`${PLUGIN_ID}: ${text.split('\n')[0]}`);
    }
    return text;
  }

  /**
   * Run the deterministic passes before the shipped pressure policy.
   *
   * Pruning first is the point of the port: on a session whose bulk is
   * repeated tool output, the free passes can drop below the pressure
   * threshold entirely, so the model-backed summarizer never runs.
   *
   * @param agent - agent whose session is measured.
   * @param trigger - the automatic trigger being served.
   * @param signal - cancellation signal forwarded to the shipped policy.
   * @returns the compaction result, or `null` when nothing was needed.
   */
  async compactIfNeeded(agent, trigger, signal) {
    if (this.automaticEnabledFor(agent?.session)) {
      try {
        const landed = this.pruneSession(agent.session);
        if (landed.length > 0) {
          this.ctx.logger.info(`${PLUGIN_ID}: pruned ${landed.length} step(s) before ${trigger === 'pressure' ? 'pressure' : 'overflow'} compaction`);
        }
      } catch (error) {
        this.ctx.logger.warn(`${PLUGIN_ID}: pre-compaction pruning failed: ${errorLine(error)}`);
      }
    }
    return super.compactIfNeeded(agent, trigger, signal);
  }

  /**
   * Balance a caller-selected range and hand it to the shipped engine.
   *
   * The harness requires balanced edges, because an assistant tool call split
   * from its result is not a valid transcript. DCP's `compress` lets the model
   * name a range, so this snaps both edges inward to the nearest balanced
   * boundary and refuses a range that cannot be compacted at all.
   *
   * The balance is a fold over the CURRENT surface: an assistant message adds
   * one per tool-call block, a tool result subtracts one, and a cut is balanced
   * when the running count is zero. Step markers are NOT usable as boundaries —
   * compaction rewrites surface positions, which is why the shipped engine
   * derives its cuts from content. Computing this here is what makes the tool
   * callable at all: before this, every range the model could name was refused
   * by `validateSurfaceRegion` with "not a balanced boundary", and the model had
   * no way to learn the right numbers.
   *
   * @param session - session whose surface is read.
   * @param start - first surface seq, inclusive.
   * @param end - last surface seq, inclusive.
   * @param options - `singleNode` allows a one-node span, which `message` mode
   *   needs: upstream compresses individual raw messages, and a message with no
   *   tool call is balanced on both sides by definition.
   * @returns the balanced range — plus `innerBlockIds`, the compressed blocks it
   *   contains and whose text the summary must carry forward, and
   *   `boundaryBlockIds`, the blocks at its inclusive edges - or `undefined`
   *   when it holds no work.
   */
  balancedRange(session, start, end, options = {}) {
    const single = options.singleNode === true;
    const nodes = session.surface.nodes;
    // Planning may provide a detached snapshot so malformed whole batches can be
    // rejected without first-touch persistence or journal reconciliation.
    const state = options.state ?? this.blocksFor(session);

    // Sequence numbers are addresses, not sortable positions. A stale address
    // must not resolve to an unrelated replacement (especially a new system head).
    const startIdx = nodes.findIndex((seq) => Number(seq) === Number(start));
    const endIdx = nodes.findIndex((seq) => Number(seq) === Number(end));
    if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return undefined;

    // Match the core compaction invariant: only a system message at surface node
    // zero is the protected prompt head. Later system messages are historical
    // prompt updates and ordinary compactable history. Rejecting any system node
    // made old block ranges impossible to absorb after a model/prompt change.
    if (startIdx === 0 && session.eventAt(nodes[0])?.type === 'system/message') return undefined;

    // Balance immediately BEFORE each node, and immediately AFTER it.
    //
    // A COMPRESSED BLOCK IS A COMPLETE EXCHANGE AND MUST COUNT AS ONE. The fold
    // counts an assistant tool call as +1 and its result as -1, and a block node
    // is neither: it is a `user/message` carrying a summary. So a run like
    // `[user, block, assistant, result]` left the running count non-zero at the
    // block, `balancedBefore` was false there, and the snap walked PAST the block
    // into the material after it. The block is a self-contained span whose
    // content was already closed - nothing inside it can leave a call unanswered
    // - so the depth it contributes is zero and its two edges are balanced cuts.
    //
    // Guarding the snap on `inProgress === 0` instead was tried and is not enough:
    // it stops the snap from crossing a block but leaves the block's own edges
    // unusable, so a range that begins or ends ON a block (the ordinary shape of
    // "carry this earlier summary forward") cannot be expressed at all.
    const balancedBefore = new Array(nodes.length);
    const balancedAfter = new Array(nodes.length);
    let inProgress = 0;
    for (let index = 0; index < nodes.length; index += 1) {
      const isBlock = this.blockAtSeq(session, nodes[index], state) !== undefined;
      if (isBlock) inProgress = 0;
      balancedBefore[index] = inProgress === 0;
      const event = session.eventAt(nodes[index]);
      if (!isBlock && event?.type === 'assistant/message') {
        const content = event.data?.message?.content ?? [];
        for (const block of content) if (block?.type === 'tool-call') inProgress += 1;
      } else if (!isBlock && event?.type === 'tool/result') {
        inProgress -= 1;
      }
      balancedAfter[index] = inProgress === 0;
    }

    // Snap inward to complete exchanges. A selected block remains inside the
    // inclusive range: carrying its text must also shadow its own surface node.
    let from = startIdx;
    while (from < nodes.length && !balancedBefore[from]) from += 1;
    let to = endIdx;
    while (to >= 0 && !balancedAfter[to]) to -= 1;
    const floor = single ? from : from + 1;
    if (from >= nodes.length || to < 0 || to < floor) return undefined;

    // Block identity comes from `blockAtSeq`, which recognizes a summary by its
    // header, its id footer, or its registry entry. An earlier version of this
    // method keyed purely off the message's producer `source.kind`, which cannot
    // tell a pruning notice from a compression — and a notice on the surface would then
    // have been treated as compressible content.
    // Like upstream's resolveSelection, collect only blocks within the selected
    // span, including its edges. A span may consist entirely of existing blocks:
    // re-compressing them is how several older summaries are merged or absorbed.
    const innerBlockIds = [];
    const boundaryBlockIds = [];
    for (let index = from; index <= to; index += 1) {
      const block = this.blockAtSeq(session, nodes[index], state);
      if (block === undefined) continue;
      const id = numericBlockId(block.blockId);
      if (id === undefined) continue;
      const ids = index === from || index === to ? boundaryBlockIds : innerBlockIds;
      if (!ids.includes(id)) ids.push(id);
    }
    // State-only ownership must agree for hints and execution. Addresses can be
    // reordered by replacements, so only membership proves complete coverage.
    if (!single) {
      const span = nodes.slice(from, to + 1).map(Number);
      if (state.active().some((block) => {
        const owned = new Set((block.shadowedSeqs ?? []).map(Number));
        return span.every((seq) => owned.has(seq));
      })) return undefined;
    }
    return { start: nodes[from], end: nodes[to], startIdx: from, endIdx: to, innerBlockIds, boundaryBlockIds };
  }
}

/* ---------------------------------------------------------------- the tool */

function applyWireToolInputPruning(messages, state) {
  const kinds = state.prunedToolKinds;
  if (!(kinds instanceof Map) || kinds.size === 0) return messages;
  let changed = false;
  const next = messages.map((message) => {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) return message;
    let messageChanged = false;
    const content = message.content.map((part) => {
      if (part?.type !== 'tool-call' || part.id === undefined) return part;
      const kind = kinds.get(String(part.id));
      if (kind !== 'error-input' && kind !== 'question-input') return part;
      if (typeof part.arguments !== 'string') return part;
      let input;
      try { input = JSON.parse(part.arguments); } catch { return part; }
      if (input === null || typeof input !== 'object' || Array.isArray(input)) return part;
      const rewritten = { ...input };
      if (kind === 'question-input') {
        if (rewritten.questions === undefined) return part;
        rewritten.questions = PRUNED_QUESTION_INPUT_REPLACEMENT;
      } else {
        for (const key of Object.keys(rewritten)) {
          if (typeof rewritten[key] === 'string') rewritten[key] = PRUNED_TOOL_ERROR_INPUT_REPLACEMENT;
        }
      }
      const arguments_ = JSON.stringify(rewritten);
      if (arguments_ === part.arguments) return part;
      messageChanged = true;
      return { ...part, arguments: arguments_ };
    });
    if (!messageChanged) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? next : messages;
}

function appendNudgeToMessage(message, nudge) {
  if (!Array.isArray(message?.content) || typeof nudge !== 'string' || nudge.length === 0) return message;
  const content = [...message.content];
  const textIndexes = content.flatMap((part, index) => part?.type === 'text' && typeof part.text === 'string' ? [index] : []);
  const target = message.role === 'user' ? textIndexes.at(-1) : textIndexes[0];
  if (target !== undefined) {
    if (content[target].text.includes(nudge)) return message;
    const base = content[target].text.replace(/\n*$/, '');
    content[target] = { ...content[target], text: base.length > 0 ? `${base}\n\n${nudge.replace(/^\n+/, '')}` : nudge.replace(/^\n+/, '') };
    return { ...message, content };
  }
  const synthetic = { type: 'text', text: nudge.replace(/^\n+/, '') };
  const firstTool = content.findIndex((part) => part?.type === 'tool-call');
  if (firstTool < 0) content.push(synthetic);
  else content.splice(firstTool, 0, synthetic);
  return { ...message, content };
}

function injectPendingNudge(session, state, engine, messages) {
  const references = collectMessageReferences(session, state);
  const groups = new Map(references.groups.filter((group) => group.kind === 'message').map((group) => [group.rawMessageId, group]));
  const guidance = buildCompressedBlockGuidance(orderedCompressedBlocks(references, state));
  const contextText = appendGuidanceToDcpTag(nudgeText({ over: true, text: engine.customPrompt('contextLimitNudge') }), guidance);
  const turnText = appendGuidanceToDcpTag(engine.customPromptFor('turnNudge', TURN_NUDGE).trim(), guidance);
  const iterationText = appendGuidanceToDcpTag(engine.customPromptFor('iterationNudge', ITERATION_NUDGE).trim(), guidance);
  const injections = [];
  for (const id of state.nudges.contextAnchors) injections.push([id, contextText]);
  const turnRole = engine.dcpConfig.compress.nudgeForce === 'strong' ? 'user' : 'assistant';
  for (const id of state.nudges.turnAnchors) {
    if (groups.get(id)?.role === turnRole) injections.push([id, turnText]);
  }
  for (const id of state.nudges.iterationAnchors) injections.push([id, iterationText]);
  if (injections.length === 0) return messages;
  let next = messages;
  for (const [id, text] of injections) {
    const index = next.findIndex((message) => String(message?.id) === id);
    if (index < 0) continue;
    const message = appendNudgeToMessage(next[index], text);
    if (message === next[index]) continue;
    if (next === messages) next = [...messages];
    next[index] = message;
  }
  return next;
}

/** Register DCP's model-facing tool, its commands, and its status surface. */
function registerSurface(ctx, engine, legacyEditor = true) {
  /**
   * The summary text one entry replaces its span with.
   *
   * Upstream DCP lets the MODEL write the summary and pass it as a parameter,
   * which is why it needs no size gate: the model already decided what is worth
   * keeping. This port follows that shape. Two protections append verbatim text
   * to it, because a summary is lossy by nature and these are the parts a user
   * asked never to lose.
   *
   * @param session - session being compressed.
   * @param range - the balanced range from {@link DcpCompactionEngine#balancedRange}.
   * @param body - the model's own summary text.
   * @param config - the resolved DCP configuration.
   * @returns the text the replacement message carries.
   */
  const composeSummary = (session, range, body, config) => {
    const textsOf = (seq) => {
      // Selected blocks are already carried verbatim by the placeholder pass.
      if (engine.blockAtSeq(session, seq) !== undefined) return '';
      const event = session.eventAt(SessionSeq(seq));
      const message = event?.data?.message ?? event?.data;
      const content = Array.isArray(message?.content) ? message.content : [];
      let text = '';
      for (const block of content) {
        // Current DSH tool results are ordinary top-level `role: 'tool'`
        // messages whose content is text. Legacy logs used a nested
        // `{ type: 'tool-result', content: [...] }` block; retain both forms.
        if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
        if (block?.type === 'tool-result' && Array.isArray(block.content)) {
          for (const inner of block.content) {
            if (inner?.type === 'text' && typeof inner.text === 'string') text += inner.text;
          }
        }
      }
      return text;
    };

    let summary = body;

    if (config.compress.protectUserMessages) {
      const kept = [];
      for (const seq of range.shadowedSeqs) {
        const event = session.eventAt(SessionSeq(seq));
        const message = event?.data?.message ?? event?.data;
        if (event?.type !== 'user/message' || message?.source?.form === 'notice') continue;
        const text = (message?.content ?? []).find((part) => part?.type === 'text' && typeof part.text === 'string')?.text;
        if (typeof text === 'string' && text.trim().length > 0) kept.push(text);
      }
      if (kept.length > 0) {
        summary += '\n\nThe following user messages were sent in this conversation verbatim:';
        summary += kept.map((text) => `\n${text}`).join('');
      }
    }

    if (config.compress.protectTags) {
      const protected_ = [];
      for (const seq of range.shadowedSeqs) {
        const event = session.eventAt(SessionSeq(seq));
        const message = event?.data?.message ?? event?.data;
        if (event?.type !== 'user/message' || message?.source?.form === 'notice') continue;
        for (const match of textsOf(seq).matchAll(/<protect>([\s\S]*?)<\/protect>/gi)) {
          if (typeof match[1] === 'string' && match[1].trim().length > 0) protected_.push(match[1].trim());
        }
      }
      if (protected_.length > 0) {
        summary += '\n\nThe following protected prompt information was included in this conversation verbatim:';
        summary += protected_.map((text) => `\n${text}`).join('');
      }
    }

    const carried = [];
    const carriedTools = config.compress.protectedTools ?? DEFAULT_COMPRESS_PROTECTED_TOOLS;
    const nameMatcher = compileToolNameMatcher(carriedTools);
    const pathMatcher = compilePathMatcher(config.protectedFilePatterns ?? []);
    if (carriedTools.length > 0 || (config.protectedFilePatterns?.length ?? 0) > 0) {
      for (const step of readSteps(session)) {
        const calls = new Map(step.calls.map((call) => [String(call.id), call]));
        for (const result of step.results) {
          if (!range.shadowedSeqs.includes(Number(result.node.seq))) continue;
          const call = calls.get(String(result.callId));
          if (call === undefined) continue;
          const args = invocationOf(call).arguments;
          if (!nameMatcher(call.name) && !filePathsOf(args, call.name).some(pathMatcher)) continue;
          const text = textsOf(result.node.seq).trim();
          if (text.length > 0) carried.push(`\n### Tool: ${call.name}\n${text}`);
        }
      }
      if (carried.length > 0) {
        summary += '\n\nThe following protected tools were used in this conversation as well:';
        summary += carried.join('');
      }
    }
    return summary;
  };

  const createTool = () => {
    // A tool already handed to a request keeps its policy while settings change.
    const configSnapshot = engine.dcpConfig;
    return defineTool({
    name: 'compress',
    // Upstream registers the tool with the BIG instruction text as its
    // description, and matches the mode: `lib/prompts/compress-range.ts` (range)
    // or `compress-message.ts` (message), with the schema-format block appended
    // from `extensions/tool.ts`. The model's quality bar for a summary is set
    // here and nowhere else, so this is the text that matters most.
    description: [
      engine.dcpConfig.compress.mode === 'message'
        ? engine.customPromptFor('compressMessage', COMPRESS_MESSAGE)
        : engine.customPromptFor('compressRange', COMPRESS_RANGE),
      formatExtension(engine.dcpConfig.compress.mode)
    ].join('\n'),
    parameters: {
      topic: {
        type: 'string',
        ...(configSnapshot.compress.mode === 'message' ? { required: true } : {}),
        description: configSnapshot.compress.mode === 'message'
          ? "Short label (3-5 words) for the overall batch - e.g., 'Closed Research Notes'"
          : 'Short label (3-5 words) for the whole batch; canonical location'
      },
      content: {
        type: 'array',
        required: true,
        description: configSnapshot.compress.mode === 'message'
          ? 'Batch of individual message summaries to create in one tool call'
          : 'One or more ranges to compress, each with start/end boundaries and a summary',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: configSnapshot.compress.mode === 'message'
            ? {
                messageId: { type: 'string', required: true, description: 'Raw message ID to compress (e.g. m0001)' },
                topic: { type: 'string', required: true, description: 'Short label (3-5 words) for this one message summary' },
                summary: { type: 'string', required: true, description: 'Complete technical summary replacing that one message' }
              }
            : {
                startId: { type: 'string', required: true, description: 'Message or block ID marking the beginning of range (e.g. m0001, b2)' },
                endId: { type: 'string', required: true, description: 'Message or block ID marking the end of range (e.g. m0012, b5)' },
                topic: { type: 'string', description: 'Fallback when the top-level topic is missing; all non-empty values must match' },
                summary: { type: 'string', required: true, description: 'Complete technical summary replacing all content in range' }
              }
        }
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          compressed: { type: 'boolean', required: true },
          compressedMessages: { type: 'integer', required: true },
          blocks: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                blockId: { type: 'string', required: true },
                topic: { type: 'string', required: true },
                start: { type: 'integer', required: true },
                end: { type: 'integer', required: true },
                coverage: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    start: { type: 'integer', required: true },
                    end: { type: 'integer', required: true }
                  },
                  description: 'The first and last SHADOWED seq. Differs from start/end when a requested edge was not a surface node and had to resolve onto one.'
                },
                shadowedSeqs: { type: 'array', required: true, items: { type: 'integer' } },
                summaryChars: { type: 'integer', required: true },
                childBlockIds: {
                  type: 'array', required: true, items: { type: 'string' },
                  description: 'Every predecessor block selected by this compression.'
                },
                preservedBlockIds: {
                  type: 'array', required: true, items: { type: 'string' },
                  description: 'Selected predecessors expanded at an explicit canonical (bN) marker.'
                },
                absorbedBlockIds: {
                  type: 'array', required: true, items: { type: 'string' },
                  description: 'Selected predecessors intentionally absorbed because their marker was omitted.'
                },
                summary: { type: 'string', description: 'The replacement text, present only when compress.showCompression is on.' }
              }
            }
          },
          skipped: { type: 'array', required: true, items: { type: 'string' } },
          swept: {
            type: 'array',
            required: true,
            items: { type: 'string' },
            description: 'Tool outputs the deterministic strategies added to the prune manifest during this call; their payloads are replaced on the request from now on.'
          },
          shadowedSeqs: { type: 'array', required: true, items: { type: 'integer' } },
          shadowedTokens: { type: 'integer', required: true },
          freedTokens: { type: 'integer', required: true },
          preservedBlocks: { type: 'integer', required: true },
          absorbedBlocks: { type: 'integer', required: true },
          beforeEstimate: { type: 'integer', required: true },
          afterEstimate: { type: 'integer', required: true },
          estimatedFreed: { type: 'integer', required: true },
          summaryChars: { type: 'integer', required: true },
          reason: { type: 'string' }
        }
      },
      render: (args, value) => {
        const sweptLine = Array.isArray(value.swept) && value.swept.length > 0
          ? `Also pruned ${value.swept.length} tool output(s) on the way in (payloads replaced on the request, history untouched): `
            + value.swept.join('; ')
          : '';
        if (!value.compressed) {
          return [{
            type: 'text',
            text: [
              `Nothing was compressed: ${value.reason ?? 'no compactable span'}.`,
              sweptLine
            ].filter((line) => line.length > 0).join('\n')
          }];
        }
        return [{
          type: 'text',
          text: [
            `Compressed ${value.compressedMessages} messages into [Compressed conversation section].`,
            `Predecessor blocks: ${value.preservedBlocks} preserved, ${value.absorbedBlocks} absorbed.`,
            `Estimated tokens for compressed spans: ${value.beforeEstimate} before, ${value.afterEstimate} after, ${value.estimatedFreed} freed.`,
            sweptLine,
            ...(configSnapshot.compress.showCompression
              ? value.blocks.map((block) => block.summary).filter((summary) => typeof summary === 'string' && summary.length > 0)
              : [])
          ].filter((line) => line.length > 0).join('\n\n')
        }];
      }
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const config = configSnapshot;
      const agent = exec.agent;
      if (agent === undefined) throw new Error('compress requires an owning agent session');
      const session = agent.session;
      const messageMode = config.compress.mode === 'message';
      const topic = validateCompressionArgumentShape(args, messageMode);
      const availability = engine.availability(session);
      if (!availability.available) throw new Error(`compress: ${availability.reason}`);
      const previewState = engine.previewBlocksFor(session);
      const manualOverride = previewState.manualModeOverride;
      const manualMode = typeof manualOverride === 'boolean' ? manualOverride : engine.dcpConfig.manualMode === true;
      if (manualMode && previewState.manualPermit !== true) {
        throw new Error('Manual mode: compress blocked. Do not retry until `<compress triggered manually>` appears in user context.');
      }
      // Every property the output schema marks required must be present on the
      // REFUSAL path too. Without `freedTokens` here the harness rejected the
      // whole result with "tool \"compress\" returned invalid output: missing
      // required property \"value.freedTokens\"", which reached the model as a
      // tool failure instead of the intended "nothing was compressed: …"
      // answer — a refusal was indistinguishable from a crash.
      const empty = {
        compressed: false,
        compressedMessages: 0,
        blocks: [],
        skipped: [],
        swept: [],
        shadowedSeqs: [],
        shadowedTokens: 0,
        freedTokens: 0,
        preservedBlocks: 0,
        absorbedBlocks: 0,
        beforeEstimate: 0,
        afterEstimate: 0,
        estimatedFreed: 0,
        summaryChars: 0
      };

      const nodes = [...session.surface.nodes];
      const surfaceFingerprint = nodes.map(Number).join(',');
      const frozenReferences = engine.snapshotMessageReferences(session, previewState);
      const plans = [];
      const skipped = [];
      for (let index = 0; index < args.content.length; index += 1) {
        const entry = args.content[index] ?? {};
        const summary = entry.summary;
        if (messageMode) {
          const parsed = parseBoundaryId(entry.messageId);
          if (parsed === null || parsed.kind !== 'message') {
            skipped.push(`messageId ${entry.messageId.trim()} is invalid. Use an injected raw message ID of the form mNNNN.`);
            continue;
          }
          let resolved;
          try {
            resolved = engine.resolveBoundaryIds(session, parsed.ref, parsed.ref, frozenReferences);
          } catch {
            skipped.push(`messageId ${parsed.ref} is not available in the current conversation context. Choose an injected mNNNN ID visible in context.`);
            continue;
          }
          const { startReference, endReference } = resolved;
          const range = engine.balancedRange(session, startReference.startSeq, endReference.endSeq, {
            singleNode: true,
            state: previewState
          });
          if (range === undefined) {
            skipped.push(`messageId ${parsed.ref} cannot be compressed because its tool call/result exchange is incomplete.`);
            continue;
          }
          plans.push({
            index,
            range,
            summary,
            topic: entry.topic.trim(),
            entry: { messageId: parsed.ref, startId: parsed.ref, endId: parsed.ref },
            startReference,
            endReference,
            messageCount: 1,
            requiredBlockIds: [],
            boundaryBlockIds: []
          });
          continue;
        }
        const normalized = { startId: entry.startId.trim(), endId: entry.endId.trim() };
        const { references, startReference, endReference } = engine.resolveBoundaryIds(session, normalized.startId, normalized.endId, frozenReferences);
        const range = engine.balancedRange(session, startReference.startSeq, endReference.endSeq, {
          singleNode: startReference.ref === endReference.ref,
          state: previewState
        });
        if (range === undefined) {
          throw new Error(`content[${index}] (${normalized.startId}..${normalized.endId}) cannot be compressed because it would split a tool call from its result or include unavailable system content.`);
        }
        const selectedGroups = references.groups.filter((group) => group.startIndex >= range.startIdx && group.startIndex <= range.endIdx);
        const requiredBlockIds = selectedGroups.filter((group) => group.kind === 'compressed-block').map((group) => group.blockId);
        const messageCount = selectedGroups.reduce((count, group) => {
          if (group.kind === 'message') return count + 1;
          return count + (previewState.get(group.blockId)?.shadowedMessageIds?.length ?? 0);
        }, 0);
        plans.push({
          index,
          range,
          summary,
          topic,
          entry: normalized,
          startReference,
          endReference,
          messageCount,
          requiredBlockIds,
          boundaryBlockIds: [startReference, endReference]
            .filter((reference) => reference.kind === 'compressed-block')
            .map((reference) => reference.blockId)
        });
      }

      if (plans.length === 0) {
        return { ...empty, skipped, reason: skipped.length > 0 ? skipped.join('; ') : 'no compactable span' };
      }

      const validationOrder = [...plans].sort((a, b) => a.range.startIdx - b.range.startIdx);
      for (let index = 1; index < validationOrder.length; index += 1) {
        const previous = validationOrder[index - 1];
        const current = validationOrder[index];
        if (current.range.startIdx > previous.range.endIdx) continue;
        throw new Error(
          `content[${previous.index}] (${previous.entry.startId}..${previous.entry.endId}) overlaps content[${current.index}] (${current.entry.startId}..${current.entry.endId}). Overlapping ranges cannot be compressed in the same batch.`
        );
      }

      const blocks = [];
      const preparedPlans = [];
      const shadowedSeqs = [];
      let shadowedTokens = 0;
      let freedTokens = 0;
      let afterEstimate = 0;
      let preservedBlocks = 0;
      let absorbedBlocks = 0;
      let summaryChars = 0;
      const runId = previewState.nextRunId;
      const firstBlockId = previewState.nextBlockId;
      const batchId = `dcp:${String(session.id)}:run-${runId}:blocks-${firstBlockId}-${firstBlockId + plans.length - 1}`;
      const registrySnapshot = [...previewState.values()].map((block) => ({
        blockId: block.blockId,
        summary: block.summary,
        active: block.active !== false
      }));

      for (const plan of plans) {
        const spanSeqs = nodes.slice(plan.range.startIdx, plan.range.endIdx + 1).map((seq) => Number(seq));
        const full = { ...plan.range, shadowedSeqs: spanSeqs };
        // The placeholder pass runs BEFORE the protections are appended: the
        // model's own text is what carries the placeholders, and a protected
        // excerpt appended afterwards cannot accidentally contain a `(bN)` that
        // names an unrelated block.
        const selectedById = new Map();
        for (const seq of spanSeqs) {
          const block = engine.blockAtSeq(session, seq, previewState);
          const numeric = numericBlockId(block?.blockId);
          if (numeric === undefined || selectedById.has(numeric)) continue;
          selectedById.set(numeric, {
            blockId: numeric,
            summary: block.summary,
            active: block.active !== false
          });
        }
        const lineage = classifyAndExpandBlockPlaceholders(plan.summary, {
          selectedBlocks: [...selectedById.values()],
          registry: registrySnapshot
        });
        const expandedSummary = composeSummary(session, full, lineage.expandedSummary, config);
        // The stored text is WRAPPED, upstream's `wrapCompressedSummary`: the
        // header is how the model recognizes a compressed section in context,
        // which is exactly what the prompt's placeholder rules point at.
        // Reserve only in local data; failed preparation must not consume an id.
        const blockId = String(firstBlockId + preparedPlans.length);
        const operationId = `${batchId}:block-${blockId}`;
        const text = wrapBlockSummary(blockId, expandedSummary, plan.topic);
        const message = createUserMessage({
          content: [{ type: 'text', text }],
          source: {
            kind: PLUGIN_SOURCE_KIND,
            form: 'notice',
            summary: plan.topic,
            dcpOperationId: operationId,
            dcpBatchId: batchId,
            dcpBlockId: blockId
          }
        });
        // The claim is the gross price of the shadowed range: it is what the
        // context loses when the span stops being sent, less the summary's own
        // cost, which is what the model receives instead.
        const tokens = spanSeqs.reduce((total, seq) => {
          const derived = session.deriveEventMessage(session.eventAt(SessionSeq(seq)));
          return total + (derived === null ? 0 : requiredCompressionMessageEstimate(ctx.tokenMeter, derived));
        }, 0);
        const replacementTokens = requiredCompressionMessageEstimate(ctx.tokenMeter, message);

        // ADDRESSING BY MESSAGE ID, not by position.
        //
        // The block records the durable id of every message it replaces, plus
        // the id of the one it is injected BEFORE. That is upstream's
        // `byMessageId` + `activeByAnchorMessageId` (`lib/state/types.ts`), and it
        // is the reason a compression keeps working after the surface shifts
        // underneath it: nothing here is an offset that a later compaction, a
        // fork or a restart could invalidate.
        const messageIds = spanSeqs
          .map((seq) => session.deriveEventMessage(session.eventAt(SessionSeq(seq))))
          .filter((derived) => derived !== null)
          .map((derived) => derived.id)
          .filter((id) => typeof id === 'string' && id.length > 0);
        const anchorMessageId = messageIds[0];
        if (anchorMessageId === undefined) {
          throw new Error(`content[${plan.index}]: the range ${plan.range.start}..${plan.range.end} derives no messages to anchor a summary to`);
        }
        const block = {
          blockId,
          runId,
          operationId,
          batchId,
          topic: plan.topic,
          startId: plan.entry.startId,
          endId: plan.entry.endId,
          start: Number(plan.range.start),
          end: Number(plan.range.end),
          // THE SPAN THE MODEL SHOULD BELIEVE, not the numbers it asked with. On
          // the surface a seq may be gone (a replacement sits in its place), and
          // the resolved edge is then a different number. Reporting the request
          // back made the result look like a no-op: a call asked to compress
          // `1..3` that landed as `1..2` printed `range 1..3`, and the model - the
          // one reader that will act on this line - went on believing the whole
          // exchange was covered.
          coverage: { start: spanSeqs[0], end: spanSeqs[spanSeqs.length - 1] },
          shadowedSeqs: spanSeqs,
          shadowedMessageIds: messageIds,
          anchorMessageId,
          summary: text,
          summaryChars: text.length,
          summaryTokens: replacementTokens,
          childBlockIds: lineage.childBlockIds.map(String),
          preservedBlockIds: lineage.preservedBlockIds.map(String),
          absorbedBlockIds: lineage.absorbedBlockIds.map(String),
          parentBlockIds: [],
          active: true,
          // `showCompression` is upstream's switch for surfacing the summary
          // text itself in the result. The text is always recorded on the block
          // (decompress needs it, and a later compression inlines it); the switch
          // only decides whether it travels back in the tool result, where it
          // would otherwise re-add the very tokens the call just removed.
          ...(config.compress.showCompression ? { shownSummary: expandedSummary } : {})
        };
        const preparedMaterialization = prepareSummaryMaterialization(session, {
          startSeq: Number(plan.range.start),
          endSeq: Number(plan.range.end),
          shadowedSeqs: spanSeqs,
          tokens,
          summary: text,
          summaryMessage: message
        });
        preparedPlans.push({
          plan,
          block,
          operationId,
          messageId: message.id,
          text,
          expandedSummary,
          tokens,
          replacementTokens,
          preparedMaterialization
        });
      }

      const reservation = {
        nextRunId: runId + 1,
        nextBlockId: firstBlockId + preparedPlans.length,
        consumeManualPermit: previewState.manualPermit === true
      };
      const createdAt = new Date().toISOString();
      const plannedAtSeq = latestSessionSeq(session);
      const operations = preparedPlans.map((prepared) => ({
        operationId: prepared.operationId,
        batchId,
        blockId: prepared.block.blockId,
        phase: 'planned',
        createdAt,
        plannedAtSeq,
        plan: {
          reservation,
          block: prepared.block,
          materialization: prepared.preparedMaterialization,
          replacementMessageId: prepared.messageId,
          statsDelta: {
            compressions: 1,
            compressionNodes: prepared.block.shadowedSeqs.length
          }
        }
      }));

      // Only a fully prepared batch may recover durable intent or persist first-touch
      // state. Invalid rows, ranges, overlaps, placeholders, and token estimates have
      // all failed before this point against the detached preview above.
      engine.reconcileCompressionOperations(session);
      const sessionState = engine.blocksFor(session);
      if (sessionState.nextRunId !== runId
        || sessionState.nextBlockId !== firstBlockId
        || sessionState.manualPermit !== previewState.manualPermit) {
        throw new Error('compression state changed during whole-batch preflight; retry with the current message IDs');
      }
      const currentManualOverride = sessionState.manualModeOverride;
      const currentManualMode = typeof currentManualOverride === 'boolean'
        ? currentManualOverride
        : engine.dcpConfig.manualMode === true;
      if (currentManualMode && sessionState.manualPermit !== true) {
        throw new Error('Manual mode: compress blocked. Do not retry until `<compress triggered manually>` appears in user context.');
      }

      engine.withCompressionLandingLock(session, () => {
        if ([...session.surface.nodes].map(Number).join(',') !== surfaceFingerprint) {
          throw new Error('compression surface changed during whole-batch preflight; retry with the current message IDs');
        }
        const journal = engine.compressionJournal(session);
        journal.planBatch(operations);
        for (const operation of operations) engine.compressionFault('planned', journal.get(operation.operationId));
        for (const operation of operations) {
          engine.reconcileCompressionOperation(session, sessionState, journal, operation);
        }
      });

      for (const prepared of preparedPlans) {
        const { block, text, expandedSummary, tokens, replacementTokens } = prepared;
        blocks.push({
          blockId: block.blockId,
          topic: block.topic,
          start: block.start,
          end: block.end,
          coverage: block.coverage,
          shadowedSeqs: block.shadowedSeqs,
          summaryChars: block.summaryChars,
          childBlockIds: block.childBlockIds,
          preservedBlockIds: block.preservedBlockIds,
          absorbedBlockIds: block.absorbedBlockIds,
          ...(config.compress.showCompression ? { summary: expandedSummary } : {})
        });
        shadowedSeqs.push(...block.shadowedSeqs);
        shadowedTokens += tokens;
        afterEstimate += replacementTokens;
        freedTokens += tokens - replacementTokens;
        preservedBlocks += block.preservedBlockIds.length;
        absorbedBlocks += block.absorbedBlockIds.length;
        summaryChars += text.length;
      }

      engine.clearNudgeAnchors(session, true);
      sessionState.lastCompression = {
        beforeEstimate: shadowedTokens,
        afterEstimate,
        estimatedFreed: shadowedTokens - afterEstimate
      };
      engine.saveBlocks(session);
      const swept = engine.pruneSession(session, agent, { nudge: false });

      return {
        compressed: true,
        compressedMessages: plans.reduce((count, plan) => count + plan.messageCount, 0),
        blocks,
        skipped,
        // What the strategies found on the way in. Reported rather than silent:
        // the pruning is invisible in the session by design, so this is the one
        // place the model learns that some outputs it can still see in its
        // history are placeholders in the request.
        swept: swept.map((entry) => `${entry.strategy}: ${entry.tool} (${entry.callId}) ~${entry.tokens} token(s) — ${entry.label}`),
        shadowedSeqs,
        shadowedTokens,
        freedTokens,
        preservedBlocks,
        absorbedBlocks,
        beforeEstimate: shadowedTokens,
        afterEstimate,
        estimatedFreed: shadowedTokens - afterEstimate,
        summaryChars
      };
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `compress (${Array.isArray(args.content) ? args.content.length : 0} entr${args.content?.length === 1 ? 'y' : 'ies'})`,
      kind: 'other',
      rawInput: typeof args.topic === 'string' && args.topic.trim().length > 0
        ? args.topic.trim()
        : (Array.isArray(args.content)
            ? [...new Set(args.content
              .map((entry) => typeof entry?.topic === 'string' ? entry.topic.trim() : '')
              .filter((entryTopic) => entryTopic.length > 0))].join(', ')
            : '')
    })
  });
  };

  /**
   * Run the deterministic passes when history grows — the DSH form of upstream's
   * per-request `prune()`.
   *
   * Upstream rewrites the outgoing array on every request. That seam does not
   * exist here (see {@link DcpCompactionEngine#_materializePrune}), so the port
   * takes the equivalent moment on the other side of the same boundary: the
   * instant a history node LANDS. A tool result that repeats an earlier call is
   * pruned as it arrives, which is upstream's semantics with the discovery moved
   * to the event that makes it possible — and it costs nothing per request,
   * because the decision is made once per node instead of once per token.
   *
   * Only a `tool/result` triggers a pass: every strategy keys off a completed
   * call, and an assistant message with no result cannot be pruned.
   */
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'tool/result') return;
    if (!engine.availability(session).available) return;
    // DEFERRED, NOT INLINE. A `session/event` observer runs while the session is
    // still inside its own append — `entry.appending` is set before observers are
    // invoked — and `Session.append` rejects a REENTRANT call outright. Appending
    // the replacement directly from here therefore throws, every time, and the
    // prune silently never lands. A microtask runs after the append has
    // committed, which is also the first moment the new node is part of the
    // surface the pass will read.
    queueMicrotask(() => {
      try {
        engine.pruneSession(session, undefined, { nudge: false });
      } catch (error) {
        engine.ctx.logger.warn(`${PLUGIN_ID}: strategy pass after seq ${event.seq} failed: ${errorLine(error)}`);
      }
    });
  });

  /**
   * Deliver the context nudge where upstream delivers it: between steps.
   *
   * The port computed a nudge and could never hand it over. `_maybeNudge` needs an
   * agent to inject through, and the only pass that had one ran from
   * `compactIfNeeded` — that is, at the moment the context is already being
   * compacted, which is the opposite of a warning. The event pass passes
   * `undefined` on purpose, because injecting from a `session/event` observer
   * would append a synthetic user message in the middle of the turn that is still
   * being built.
   *
   * `agent/pre-step` is that moment and it is a cordis event, so it needs no seam
   * the harness does not already offer. It is the SAME hook the shipped compaction
   * engine uses to decide whether to compact (`dsh-compaction-basic\lib\index.js:798`),
   * which is the strongest available argument that it is the intended place for
   * this decision: "the step is about to be assembled, is the context too big?"
   *
   * `nudge: false` is deliberately NOT passed — that flag means "measure only".
   * The measurement is one per step, the same cost upstream pays per request.
   */
  ctx.on('agent/pre-step', ({ agent }, next) => {
    // A durable intent is authoritative. Do not assemble another provider request
    // until any crash-interrupted prune/replacement pair has been reconciled.
    engine.reconcileCompressionOperations(agent.session);
    try {
      engine.pruneSession(agent.session, agent, { nudge: false });
    } catch (error) {
      engine.ctx.logger.warn(`${PLUGIN_ID}: pre-step pass failed: ${errorLine(error)}`);
    }
    return next();
  });

  ctx.effect(() => registerWireTransform(ctx, (messages, request) => {
    if (typeof request?.sessionId !== 'string') return messages;
    const sessions = ctx.get('sessions') ?? ctx.root?.get?.('sessions');
    const session = sessions?.get?.(request.sessionId);
    if (session === undefined || !engine.availability(session).available) return messages;
    engine.recordRequestContext(session, request);
    engine._nudgeForPrompt(session);
    const state = engine.blocksFor(session);
    let transformed = sanitizeMessageReferences(session, state, messages);
    transformed = applyWireToolInputPruning(transformed, state);
    transformed = injectPendingNudge(session, state, engine, transformed);
    const injected = injectMessageReferences(session, state, transformed, { sanitize: false });
    const finalized = finalizeDcpWireContext(injected.messages, engine.ctx.tokenMeter, {
      enabled: engine.dcpConfig.includeContextStatus === true,
      lastCompression: state.lastCompression
    });
    engine.recordWireEstimate(session, {
      statusFreeEstimate: finalized.statusFreeEstimate,
      finalizedEstimate: finalized.finalizedEstimate,
      statusCost: finalized.statusCost,
      visible: finalized.visible
    });
    engine.saveBlocks(session);
    return finalized.messages;
  }, {
    order: 200,
    onError: (error) => engine.ctx.logger.warn(`${PLUGIN_ID}: message id overlay failed: ${errorLine(error)}`)
  }), 'dcp: message id overlay');

  /**
   * When the SHIPPED engine finishes a compaction, the block registry is stale.
   *
   * This is the port of upstream's `resetOnCompaction`
   * (`opencode-dcp\lib\state\utils.ts:331-345`), which fires when a new compaction
   * appears in the session (`state.ts:47-53`). Upstream wipes everything: tool
   * parameters, the prune map, the prune-message state, message ids and nudges.
   *
   * Blocks, prune entries, aliases, permits and nudge anchors all refer to the old
   * surface, so the entire address state resets and is persisted even when no
   * blocks existed. `blocksFor` performs the same marker check after a restart.
   *
   * `compaction/end` is the shipped engine's own event. The port's tool-result
   * prune emits `compaction/prune` only, so this listener cannot fire on the
   * port's own work — which a catch-all on `compaction/*` would have done, wiping
   * the registry immediately after every prune.
   */
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'compaction/end') return;
    if (event.data?.error !== undefined) return;
    const { state, forgotten, superseded } = engine.invalidateForNativeCompaction(session, Number(event.seq));
    engine.ctx.logger.info(`${PLUGIN_ID}: the harness compacted this session; synchronously invalidated ${forgotten} DCP block(s), ${superseded} pending operation(s), and all stale addresses (now ${state.size} blocks)`);
  });

  const registerLifecycle = () => ctx.effect(function* lifecycle() {
    if (engine.dcpConfig.enabled && engine.dcpConfig.compress.permission !== 'deny') yield ctx.tools.register(createTool());
    const commands = ctx.get('commands');
    if (commands === undefined) return;
    const dcpCommandsEnabled = engine.dcpConfig.commands.enabled
      && engine.dcpConfig.enabled
      && engine.dcpConfig.compress.permission !== 'deny';
    /**
     * Queue one model-driven compression pass.
     *
     * DCP's manual trigger is a prompt, not a silent action: the model owns the
     * choice of span and writes the summary, so the command asks for a pass
     * instead of performing one.
     *
     * @param invocation - the command invocation.
     * @returns the command result.
     */
    const queueCompressionPass = (invocation) => {
      const session = invocation.agent?.session;
      const availability = engine.availability(session);
      if (!availability.available) return { kind: 'error', text: availability.reason };
      const state = engine.blocksFor(session);
      const references = engine.messageReferences(session);
      const focus = invocation.rawInput.trim();
      const prompt = [
        '<compress triggered manually>',
        'Manual mode trigger received. You must now use the compress tool.',
        'Find the most significant completed conversation content that can be compressed into a high-fidelity technical summary.',
        'Follow the active compress mode, preserve all critical implementation details, and choose safe targets.',
        'Return after compress with a brief explanation of what content was compressed.',
        engine.dcpConfig.compress.mode === 'range' ? buildCompressedBlockGuidance(orderedCompressedBlocks(references, state)) : '',
        focus.length > 0 ? `Additional user focus:\n${focus}` : ''
      ].filter((line) => line.length > 0).join('\n\n');
      state.manualPermit = true;
      engine.saveBlocks(session);
      invocation.agent.inject(createUserMessage({
        content: [{
          type: 'text',
          text: prompt
        }],
        source: { kind: PLUGIN_SOURCE_KIND, form: 'notice', summary: 'DCP compression pass requested' }
      }));
      return { kind: 'success', text: 'Queued one compression pass for this session.' };
    };

    /** One section per verb, so `/dcp <verb>` behaves like a small CLI. */
    const VERBS = {
      help: () => ({
        kind: 'success',
        text: [
          'Usage: /dcp [verb]',
          '  (none) | status   context-pruning status and the compression blocks',
          '  compress [focus]  ask the model for one compression pass',
          '  decompress <bN>   show the text a compression stands in for, and mark it inactive',
          '  recompress <bN>   re-activate a compression that was decompressed',
          '  sweep [N]         prune the last N tool outputs, or every one since your last message',
          '  manual [on|off]   toggle manual mode (automatic strategies still follow automaticStrategies)',
          '  context           what this session currently holds, in surface order',
          '  stats             counters for this session'
        ].join('\n')
      }),
      stats: (invocation) => ({
        kind: 'success',
        text: [
          `executions: ${engine.stats.compressions} compression(s) covering ${engine.stats.compressionNodes} node(s)`,
          `deduplication: ${engine.stats.deduplicationRuns} pass(es), ${engine.stats.deduplicationNodes} tool output(s) in the manifest`,
          `purgeErrors: ${engine.stats.purgeErrorRuns} pass(es), ${engine.stats.purgeErrorNodes} tool input(s) in the manifest`,
          `blocks: ${engine.activeBlocks().length} active of ${engine.blocks.size}`,
          `prune manifest: ${engine.blocks.prunedToolCount} tool call(s), ~${engine.blocks.prunedToolTokens} token(s) claimed`,
          // WHAT THE MODEL IS ACTUALLY NOT RECEIVING, measured from the session
          // rather than from a counter. The old report quoted `lastRewrite`,
          // which counted a rewrite that the harness threw away — a fabricated
          // measurement, and the most misleading thing in the port. A prune now
          // leaves a `compaction/prune` event in the log and a placeholder node
          // on the surface, so it can be COUNTED. If this line reads 0 while the
          // manifest is non-empty, the passes are not landing.
          (() => {
            const session = invocation.agent.session;
            const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : [];
            const prunes = events.filter((event) => event.type === 'compaction/prune');
            const reasons = events.filter((event) => event.type === 'compaction/start');
            return `materialized: ${prunes.length} prune(s) in the log, ${reasons.length} compaction(s) by this port or the shipped engine`
              + ` — the model view is ${session?.deriveMessages?.().length ?? '?'} message(s) over ${session?.surface?.nodes?.length ?? '?'} surface node(s)`;
          })()
        ].join('\n')
      }),
      context: (invocation) => {
        const steps = readSteps(invocation.agent.session);
        const lines = steps.slice(-20).map((step) => {
          const names = step.calls.map((call) => call.name).join(', ');
          const state = step.results.length === step.calls.length ? 'complete' : 'open';
          return `seq ${step.node.seq} — ${step.calls.length} call(s)${names.length > 0 ? ` (${names})` : ''}, ${state}`;
        });
        const nudge = engine.lastNudge;
        const pressure = nudge === undefined
          ? 'context-limit reminder: not measured yet'
          : `context-limit reminder: ${nudge.level} — ${nudge.used} tokens against floor ${nudge.floor} / ceiling ${nudge.ceiling}`
            + `${nudge.ceiling !== engine.dcpConfig.compress.maxContextLimit ? ' (per-model or summary-buffered)' : ''}`;
        return {
          kind: 'success',
          text: [pressure, ...(lines.length === 0 ? ['No assistant steps on the surface.'] : lines)].join('\n')
        };
      },
      sweep: (invocation) => {
        const raw = invocation.rawInput.trim();
        // `/dcp sweep` with no argument is upstream's "since the last user
        // message"; `/dcp sweep N` is the last N tools. An empty log is not an
        // error — it is the answer.
        const isNumeric = /^\d+$/.test(raw);
        const count = isNumeric ? Number.parseInt(raw, 10) : undefined;
        const isCount = Number.isInteger(count) && count > 0;
        if (raw.length > 0 && !isNumeric) {
          return { kind: 'error', text: `Usage: /dcp sweep [N]\n\n${JSON.stringify(raw)} is not a count.` };
        }
        const session = invocation.agent.session;
        const added = engine.pruneSession(session, invocation.agent, {
          nudge: false,
          sweep: isCount ? { limit: count } : { sinceUserMessage: true }
        });
        const skipped = engine.blocksFor(session).lastSweep?.skippedProtected ?? 0;
        const skipNote = skipped > 0 ? ` (${skipped} protected tool(s) skipped)` : '';
        if (added.length === 0) {
          const scope = isCount ? `the last ${count} tool(s)` : 'this turn';
          return {
            kind: 'success',
            text: `Swept nothing in ${scope}: no unpruned, unprotected tool output there.${skipNote}`
          };
        }
        const tokens = added.reduce((total, entry) => total + (Number.isFinite(entry.tokens) ? entry.tokens : 0), 0);
        const scope = isCount ? `the last ${count} tool(s)` : 'this turn';
        const lines = added.map((entry) => `- ~${entry.tokens} token(s) — ${entry.label}`);
        return {
          kind: 'success',
          text: [
            `Swept ${added.length} tool output(s) in ${scope}${skipNote}. Tokens saved: ~${tokens}.`,
            'The calls and their results stay in the session; their payloads are replaced with a placeholder on every request from now on.',
            ...lines
          ].join('\n')
        };
      },
      manual: async (invocation) => {
        const state = engine.blocksFor(invocation.agent.session);
        const argument = invocation.rawInput.trim().toLowerCase();
        if (!['', 'on', 'off'].includes(argument)) return { kind: 'error', text: `Usage: /dcp manual [on|off] — got ${JSON.stringify(argument)}` };
        const enabled = argument === '' ? !engine.manualModeFor(invocation.agent.session) : argument === 'on';
        state.manualModeOverride = enabled;
        state.manualPermit = false;
        engine.saveBlocks(invocation.agent.session);
        const strategies = engine.dcpConfig.automaticStrategies ? 'still running' : 'paused too';
        return {
          kind: 'success',
          text: `Manual mode ${enabled ? 'on' : 'off'}; automatic strategies ${strategies}.`
        };
      },
      decompress: (invocation) => {
        const session = invocation.agent.session;
        const state = engine.blocksFor(session);
        const reference = invocation.rawInput.trim();
        const known = [...state.values()];
        const matches = reference.length > 0 ? [engine.blockBy(reference)].filter(Boolean) : [];
        if (reference.length > 0 && matches.length === 0) {
          const listing = known.length === 0
            ? 'No compressions in this session.'
            : `Known compressions: ${known.map((block) => `${blockRef(block.blockId)} ${block.topic}`).join(', ')}`;
          return { kind: 'error', text: `${listing} — no block matches ${JSON.stringify(reference)}.` };
        }
        if (reference.length === 0) {
          const restorable = known.filter((block) => block.active !== false);
          if (restorable.length === 0) {
            return { kind: 'error', text: known.length === 0 ? 'No compressions in this session.' : 'Every compression is already restored.' };
          }
          const lines = restorable.map((block) => `  ${blockRef(block.blockId)} (${block.shadowedMessageIds.length} message(s), ${block.summaryChars} chars)  ${block.topic}`);
          return { kind: 'success', text: ['Usage: /dcp decompress <n>', '', 'Available compressions:', ...lines].join('\n') };
        }
        const block = matches[0];
        if (block.active === false) {
          const who = block.deactivatedByUser === true
            ? 'you already decompressed it'
            : 'it was deactivated by the engine, because a later compression absorbed it';
          return { kind: 'error', text: `Compression ${blockRef(block.blockId)} is not active — ${who}.` };
        }
        // THE SUMMARY NODE HAS TO GO, not just the flag. Deactivating a block only
        // changes what a request REWRITE would inject, and this port's request path
        // is the durable surface — so the model went on reading the summary after
        // this command reported success. `restoreBlockMessages` re-appends the
        // shadowed events and collapses the summary node into an invisible
        // `system/message`, which is the one shape the core allows (see its doc).
        const restored = restoreBlockMessages(session, block, ctx.tokenMeter);
        if (restored === undefined) {
          return {
            kind: 'error',
            text: `Compression ${blockRef(block.blockId)} could not be restored: its summary node is no longer on the surface, `
              + 'or the span it stands for cannot be re-appended. Nothing was changed.'
          };
        }
        for (const candidate of state.values()) {
          const copied = restored.copiedSeqByOriginal.get(Number(candidate.nodeSeq));
          if (copied !== undefined) candidate.nodeSeq = copied;
          candidate.anchorMessageId = restored.copiedMessageIdByOriginal.get(candidate.anchorMessageId) ?? candidate.anchorMessageId;
          candidate.shadowedMessageIds = (candidate.shadowedMessageIds ?? []).map((id) => restored.copiedMessageIdByOriginal.get(id) ?? id);
          if (Array.isArray(candidate.restoredSeqs) && candidate.restoredSeqs.length > 0) {
            candidate.restoredSeqs = candidate.restoredSeqs.flatMap((seq) => {
              if (Number(seq) === restored.summarySeq) return restored.restoredSeqs;
              return [restored.copiedSeqByOriginal.get(Number(seq)) ?? Number(seq)];
            });
          }
        }
        for (const entry of state.prunedNodes.values()) {
          const copied = restored.copiedSeqByOriginal.get(Number(entry.seq));
          if (copied !== undefined) entry.seq = copied;
        }
        for (const [originalId, copiedId] of restored.copiedMessageIdByOriginal) {
          const ref = state.messageIds.byRawId.get(originalId);
          if (ref === undefined) continue;
          state.messageIds.byRawId.delete(originalId);
          state.messageIds.byRawId.set(copiedId, ref);
          state.messageIds.byRef.set(ref, copiedId);
        }
        state.deactivate(block.blockId, { byUser: true });
        syncVisibleBlockState(session, state, engine.ctx.tokenMeter);
        for (const childId of block.childBlockIds ?? []) {
          const child = state.get(childId);
          if (child === undefined || String(child.deactivatedByBlockId) !== String(block.blockId)) continue;
          const coveredByActiveParent = (child.parentBlockIds ?? []).some((parentId) => String(parentId) !== String(block.blockId) && state.get(parentId)?.active === true);
          if (!coveredByActiveParent) state.reactivate(childId);
        }
        engine.saveBlocks(session);
        return {
          kind: 'success',
          text: [
            `Restored compression ${blockRef(block.blockId)}: ${restored.restoredCount} message(s) are back in the request.`,
            `They were never removed from the session, so this is a re-append, not a recovery — the summary node is now invisible and the originals (seq ${block.start}..${block.end}) are what the model reads.`,
            '',
            `${blockRef(block.blockId)} ${block.topic}`,
            block.summary
          ].join('\n')
        };
      },
      recompress: (invocation) => {
        const session = invocation.agent.session;
        const state = engine.blocksFor(session);
        const reference = invocation.rawInput.trim();
        const known = [...state.values()];
        // ONLY WHAT THE USER TURNED OFF. Upstream refuses a block that is inactive
        // for any other reason (`lib/commands/recompress.ts:172-178`): a block the
        // engine deactivated was absorbed by a later compression, so re-applying it
        // would inject text that is already inside another summary. The port used
        // to reactivate those, which is the one thing `deactivatedByUser` exists to
        // prevent.
        const available = known.filter((block) => block.active === false && block.deactivatedByUser === true);
        if (reference.length === 0) {
          if (available.length === 0) {
            const inactive = known.filter((block) => block.active === false);
            const note = inactive.length === 0
              ? 'No compressions in this session are inactive.'
              : `Inactive compressions: ${inactive.map((block) => blockRef(block.blockId)).join(', ')} — none of them was decompressed by you, so none can be re-compressed.`;
            return { kind: 'error', text: `Usage: /dcp recompress <n>\n\nNo user-decompressed compressions are available to re-compress.\n${note}` };
          }
          const lines = available.map((block) => `  ${blockRef(block.blockId)} (${block.shadowedMessageIds.length} message(s))  ${block.topic}`);
          return { kind: 'success', text: ['Usage: /dcp recompress <n>', '', 'Available user-decompressed compressions:', ...lines].join('\n') };
        }
        const block = engine.blockBy(reference);
        if (block === undefined) {
          const listing = known.length === 0
            ? 'No compressions in this session.'
            : `Known compressions: ${known.map((entry) => `${blockRef(entry.blockId)} ${entry.topic}`).join(', ')}`;
          return { kind: 'error', text: `${listing} — no block matches ${JSON.stringify(reference)}.` };
        }
        if (block.active !== false) {
          return { kind: 'error', text: `Compression ${blockRef(block.blockId)} is already active.` };
        }
        if (block.deactivatedByUser !== true) {
          return {
            kind: 'error',
            text: `Compression ${blockRef(block.blockId)} is not user-decompressed: the engine deactivated it because a later compression absorbed its text. `
              + 'Re-applying it would send that text twice, so it stays off.'
          };
        }
        const summaryMessage = createUserMessage({
          content: [{ type: 'text', text: block.summary }],
          source: { kind: PLUGIN_SOURCE_KIND, form: 'notice', summary: block.topic }
        });
        let tokens = 0;
        try {
          tokens = block.restoredSeqs.reduce((total, seq) => {
            const message = session.deriveEventMessage(session.eventAt(SessionSeq(seq)));
            return total + (message === null ? 0 : ctx.tokenMeter.estimateMessage(message));
          }, 0);
        } catch (error) {
          return { kind: 'error', text: `Compression ${blockRef(block.blockId)} could not be re-applied: ${errorLine(error)}.` };
        }
        const summaryEvent = rematerializeBlockSummary(session, block, { summaryMessage, tokens });
        if (summaryEvent === undefined) {
          return { kind: 'error', text: `Compression ${blockRef(block.blockId)} could not be re-applied because its restored messages are no longer a contiguous live range.` };
        }
        state.reactivate(block.blockId);
        for (const childId of block.childBlockIds ?? []) {
          if (state.get(childId) !== undefined) state.deactivate(childId, { byBlockId: block.blockId });
        }
        block.summaryTokens = ctx.tokenMeter.estimateMessage(summaryMessage);
        engine.saveBlocks(session);
        return {
          kind: 'success',
          text: `Re-applied compression ${blockRef(block.blockId)} ${block.topic}: ${block.shadowedMessageIds.length} message(s) leave the request again.`
        };
      }
    };

    if (dcpCommandsEnabled) yield commands.register({
      name: 'dcp',
      description: 'DCP: status, compress, decompress, recompress, sweep, manual, context, stats, help',
      // Same door as `/edit` above: without `input`, `/dcp compress` never reaches
      // this handler — the browser refuses the line as a command and the model
      // receives it as prose. The verbs are the whole point of the command.
      input: { hint: '<verb> [args]' },
      handler(invocation) {
        const session = invocation.agent?.session;
        const availability = engine.availability(session);
        if (!availability.available) return { kind: 'error', text: availability.reason };
        engine.blocksFor(session);
        const raw = invocation.rawInput.trim();
        const [verb] = raw.split(/\s+/, 1);
        const key = verb.toLowerCase();
        const rest = raw.slice(verb.length).trim();
        const scoped = { ...invocation, rawInput: rest };
        if (key.length === 0) {
          return { kind: 'success', text: renderStatus(engine, invocation.agent.session) };
        }
        if (key === 'status') {
          return { kind: 'success', text: renderStatus(engine, invocation.agent.session) };
        }
        if (key === 'compress' || key === 'compress-pass') return queueCompressionPass(scoped);
        const handler = VERBS[key];
        if (handler === undefined) {
          return { kind: 'error', text: `Unknown verb ${JSON.stringify(verb)}. Try /dcp help.` };
        }
        return handler(scoped);
      }
    });

    if (dcpCommandsEnabled) yield commands.register({
      name: 'dcp-compress',
      description: 'Ask the model to run one compression pass',
      input: { hint: '[focus]' },
      handler: queueCompressionPass
    });

    /**
     * `/edit` — the durable branch of the history editor.
     *
     * The behaviour lives in `lib/edit-durable.js` so it can be driven by a test without a
     * live server; this is only the registration. Three forms, because the first two are
     * how a person finds out what the third will touch: no argument lists the user
     * messages, a target alone previews the change, and a target plus text commits it.
     *
     * The assistant's replies are NOT handled here. On the shipped core a replacement
     * carrier for an `assistant/message` is refused by the fold itself, so that role
     * belongs to the wire overlay; the command says so instead of failing obscurely.
     */
    // Registered UNCONDITIONALLY, even though `editor.enabled` defaults to false, because a
    // command that only appears when the flag was already on at load time makes turning the
    // feature on require a server restart. The handler refuses with an explanation while the
    // flag is off (`runEditCommand`), so the flag is still the gate — it is just a gate that
    // moves with the config file instead of with the process.
    //
    // `input` IS NOT DECORATION — IT IS WHAT MAKES AN ARGUMENT REACH THIS HANDLER.
    // The browser decision table (`dsh-client-ui-commands/lib/client.js:747-751`) splits
    // an entered line into a token and the rest, and only claims the line as a command
    // when the resolved descriptor declares `input`; otherwise a non-bare line returns
    // `undefined`, the slash line is treated as ordinary composer text, and it is sent
    // to the model as a user message. That is exactly what `/edit -1` did live: 13 tool
    // steps, 522K tokens, no edit. A bare `/edit` has no space and takes the other
    // branch, which is why the command looked half-working. The hint is the string the
    // palette shows while the argument is being typed.
    if (legacyEditor) yield commands.register({
      name: 'edit',
      description: 'Edit a message of this conversation: /edit [#|id|-1] [new text]',
      input: { hint: '[#|id|-1] [new text]' },
      handler: (invocation) => runEditCommand({
        session: invocation.agent.session,
        agent: invocation.agent,
        config: engine.dcpConfig.editor,
        rawInput: invocation.rawInput
      })
    });
    // The interface half is NOT mounted here, and this is the end of a long hunt.
    //
    // `installEditGui` needs `connection` and `webServer` — HOST services — and this
    // row is a preset row, mounted inside an agent preset's realm. Measured on a real
    // harness rather than inferred: at the top level of the same profile
    // `ctx.inject(['connection','webServer'], cb)` runs `cb` and both services are
    // usable, while from here `ctx.get` answers `undefined` for both AND `cb` never
    // runs — the mounting trail ends at `inject:asking` with no `inject:ran`. Three
    // earlier attempts to mount the panel from this file each failed differently
    // (a lambda cordis never called, an illegal channel path, an unreachable scope),
    // and all three were the same mistake: asking a preset realm for host services.
    //
    // The panel now lives in `lib/edit-host.js`, a TOP-LEVEL row of the profile, and
    // gets its engine through `lib/edit-bridge.js` (published in `apply` above).
    // `lib/edit-gui.js` is still the single implementation of the panel and the
    // channel; only the mounting site moved.
  }, 'dcp surface lifecycle');

  let dispose = registerLifecycle();
  const restrictions = new Map();
  const syncAgentRestriction = (agent) => {
    const existing = restrictions.get(agent);
    const shouldRestrict = engine.dcpConfig.enabled
      && engine.dcpConfig.compress.permission !== 'deny'
      && !engine.dcpConfig.experimental.allowSubAgents
      && isSubagentSession(agent?.session);
    if (!shouldRestrict) {
      existing?.();
      restrictions.delete(agent);
      return;
    }
    if (existing !== undefined) return;
    try {
      restrictions.set(agent, agent.ctx.tools.restrict({ deny: ['compress'] }));
    } catch (error) {
      engine.ctx.logger.warn(`${PLUGIN_ID}: could not hide compress from subagent ${String(agent?.id ?? 'unknown')}: ${errorLine(error)}`);
    }
  };
  ctx.on('agent/created', ({ agent }) => syncAgentRestriction(agent));
  ctx.on('agent/disposed', ({ agent }) => {
    restrictions.get(agent)?.();
    restrictions.delete(agent);
  });
  engine.refreshAgentToolRestrictions = () => {
    const agents = ctx.get('agents') ?? ctx.root?.get?.('agents');
    for (const agent of restrictions.keys()) syncAgentRestriction(agent);
    for (const agent of agents?.list?.() ?? []) syncAgentRestriction(agent);
  };
  engine.refreshAgentToolRestrictions();
  ctx.effect(() => () => {
    for (const release of restrictions.values()) release();
    restrictions.clear();
  }, 'dcp: subagent tool restrictions');
  return () => {
    dispose();
    dispose = registerLifecycle();
    engine.refreshAgentToolRestrictions();
  };
}

/** Render the `/dcp` status report for one session. */
function renderStatus(engine, session) {
  const strategyConfig = resolveStrategyConfig(engine.dcpConfig);
  const steps = readSteps(session);
  const turns = turnsFor(session, steps.map((step) => step.node.seq));
  const lastTurn = turns.get(steps[steps.length - 1]?.node.seq ?? 0) ?? 0;
  const lines = [
    `DCP port — ${engine.dcpConfig.enabled ? 'enabled' : 'disabled'}${engine.manualModeFor(session) ? ', manual mode' : ''}`,
    `strategies: deduplication=${strategyConfig.deduplication.enabled ? 'on' : 'off'}, purgeErrors=${strategyConfig.purgeErrors.enabled ? `on (${strategyConfig.purgeErrors.turns} turns)` : 'off'}`,
    `turn protection: ${strategyConfig.turnProtection.enabled ? `on (${strategyConfig.turnProtection.turns} turns)` : 'off'}`,
    `protected tools: ${strategyConfig.deduplication.protectedTools.join(', ')}`,
    `protected files: ${strategyConfig.protectedFilePatterns.length === 0 ? '(none)' : strategyConfig.protectedFilePatterns.join(', ')}`,
    `surface: ${session.surface.nodes.length} nodes, ${steps.length} assistant steps, turn ${lastTurn}`,
    `this session: ${engine.stats.deduplicationRuns} dedup + ${engine.stats.purgeErrorRuns} error purge replacement(s), ${engine.stats.compressions} compression(s)`
  ];
  const blocks = engine.activeBlocks();
  lines.push(blocks.length === 0
    ? 'compression blocks: (none)'
    : `compression blocks:\n${blocks.map((block) => `  ${blockRef(block.blockId)} ${block.topic} — seq ${block.start}..${block.end}, ${block.shadowedSeqs.length} node(s)`).join('\n')}`);
  return lines.join('\n');
}

/* -------------------------------------------------------------- composition */

/**
 * Mount DCP.
 *
 * @param ctx - the registrant context.
 * @param rowConfig - the preset row's configuration, used as the base layer.
 */
export function installDcpAddon(ctx, config) {
  const resolved = resolveConfiguration(config, {}, ctx.logger);
  // The agent preset keeps its native pressure/overflow compactor. This private
  // engine contributes only DCP's pruning, guidance and explicit compress tool.
  const engine = new DcpCompactionEngine(ctx, { ...resolved, basic: { ...resolved.basic, auto: false } });
  lastEngine = engine;
  const refresh = registerSurface(ctx, engine, false);
  engine.configure = next => {
    engine.dcpConfig = resolveConfiguration(next, {}, ctx.logger).semantic;
    if (engine.dcpConfig.experimental.customPrompts) ensurePromptReferenceFiles(ctx.logger);
    refresh();
  };
  return engine;
}

export function apply(ctx, rowConfig = {}) {
  // The harness always supplies an absolute cwd for a session's workspace; the
  // process cwd is only a fallback for a composition with no workspace service.
  const headerCwd = ctx.get('workspace')?.root;
  const cwd = typeof headerCwd === 'string' && headerCwd.length > 0 ? headerCwd : process.cwd();
  // The `dshHome` SERVICE is not always there: a preset ROW is mounted while the
  // deployment is still starting, and `ctx.get` answers `undefined` instead of
  // waiting. Passing the empty string it used to pass made `readConfigFiles` look
  // for a RELATIVE `dcp.jsonc` under the process cwd, so in the Web composition the
  // user's own `<home>/dcp.jsonc` was never read at all and every setting in it -
  // `editor.enabled` among them - was silently replaced by the schema default. The
  // same fallback the prompts path already uses (line 1050) is the honest one:
  // `$DSH_HOME`, else `~/.dsh`.
  const home = ctx.get('dshHome');
  const { merged, sources } = readConfigFiles(cwd, typeof home === 'string' && home.length > 0 ? home : resolveHome(), ctx.logger);
  const migrated = migrateLegacyLimits(rowConfig, merged, ctx.logger);
  const resolved = resolveConfiguration(migrated, merged, ctx.logger);
  const engine = new DcpCompactionEngine(ctx, { ...resolved, workspaceRoot: cwd });
  lastEngine = engine;
  if (sources.length > 0) ctx.logger.info(`${PLUGIN_ID}: configuration files applied: ${sources.join(', ')}`);
  // Hand the engine to the host plane. The editor panel cannot be mounted from
  // HERE (a preset's realm cannot reach `connection`/`webServer`), so it lives in
  // `lib/edit-host.js` at the top level and asks for an engine per request through
  // this bridge. The session id is what lets it refuse a conversation it does not
  // hold, so it is read from the context the row was mounted with.
  const sessionId = ctx.get('session')?.id ?? ctx.get('agent')?.sessionId;
  ctx.effect(() => publishEngine(sessionId, engine), 'context-kit: engine bridge');
  // The assistant branch of the editor, which the log cannot hold. A user message
  // is replaced in place (the durable branch), but an assistant node embeds its own
  // source stream and the core refuses a replacement for it, so its edit is spent on
  // the way OUT instead: the overlay sits on the `llm/stream` waterfall and rebuilds
  // the request the provider is about to see. Without this call the overlay is dead
  // code - it was written, tested in isolation, and never mounted - and every
  // assistant edit is refused with "the assistant branch needs the wire overlay".
  const editStore = createEditStore({
    onProblem: (id, problem) => ctx.logger.warn(`${PLUGIN_ID}: edit state for ${id}: ${problem}`)
  });
  ctx.effect(() => {
    const unpublish = publishEditStore(sessionId, editStore);
    const uninstall = installWireOverlay(ctx, editStore, {
      // Off with the same switch as the durable branch: one editor, one gate.
      active: () => engine.dcpConfig.editor.enabled === true,
      onApplied: (id, entry) => ctx.logger.info(`${PLUGIN_ID}: assistant edit applied on the wire (${id}, seq ${entry?.index ?? '?'}, block ${entry?.block ?? '?'})`),
      onError: (error) => ctx.logger.warn(`${PLUGIN_ID}: wire overlay failed, request left alone: ${error?.message ?? error}`)
    });
    return () => {
      if (typeof uninstall === 'function') uninstall();
      unpublish();
    };
  }, 'context-kit: wire overlay');
  registerSurface(ctx, engine);
}

/**
 * The engine the most recent {@link apply} built.
 *
 * A range-selection question — "which compressed blocks does this span contain,
 * and did the caller's summary carry them forward?" — is answerable only from
 * the engine, because the tool's answer is a message the test would otherwise
 * have to decode out of a JSON blob. Tests use this to assert the SELECTION, not
 * its rendering.
 */
let lastEngine;

/** The engine of the last mount, for tests and audits. */
export const engineForTest = () => lastEngine;

export { Config, manualModeForTest, parseLimitForTest, resolveConfigForTest } from './dcp-config.js';

export { DEFAULT_COMPRESS_PROTECTED_TOOLS, DEFAULT_PROTECTED_TOOLS };
