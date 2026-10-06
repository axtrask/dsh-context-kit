/**
 * DCP's deterministic strategies, expressed as pure manifest builders.
 *
 * WHAT THESE PRODUCE — AND WHAT THEY MUST NOT DO.
 *
 * Upstream's strategies do not touch the conversation. `deduplicate` and
 * `purgeErrors` read the message list and write into ONE piece of plugin state:
 *
 *     state.prune.tools.set(callId, tokenCount)      // lib/strategies/deduplication.ts:90
 *
 * Nothing is removed there. Removal happens later, on the OUTGOING request:
 * `pruneToolOutputs` replaces a pruned call's `part.state.output` with
 * `[Output removed to save context - information superseded or no longer needed]`
 * and `pruneToolErrors` blanks the string inputs of a pruned call that FAILED
 * (`lib/messages/prune.ts:73-157`). The call, its result and the transcript
 * structure all stay; only the payload goes.
 *
 * The unit of the operation is therefore ONE TOOL CALL — not one "step". An
 * earlier revision of this port replaced whole steps (the assistant message and
 * every result it produced), which destroyed the sibling results of a batch that
 * had nothing to do with the duplicate. That is the defect this shape exists to
 * make impossible: an entry here can only ever name a single call id.
 *
 * Each planner is a pure function of (surface, config, already-pruned ids), so
 * the same session and configuration always produce the same manifest, and the
 * cost is a log walk rather than a model call.
 *
 * @module dsh-context-kit/dcp-strategies
 */

import {
  compilePathMatcher,
  compileToolNameMatcher,
  filePathsOf,
  invocationOf,
  readSteps,
  readSurface,
  toolResultOf,
  turnsFor
} from './session.js';
import { stableStringify } from './common.js';

/**
 * Tools DCP protects from compression unless the user opts out.
 *
 * Upstream's `COMPRESS_DEFAULT_PROTECTED_TOOLS` is `["task", "skill",
 * "todowrite", "todoread"]` (`lib/config.ts:91`), mapped onto harness tool
 * names. These ride a compression summary rather than being dropped by it.
 */
export const DEFAULT_COMPRESS_PROTECTED_TOOLS = ['subagent', 'subagent_fork', 'skill', 'todo_write', 'todo_read'];

/**
 * Tools DCP protects from command-driven sweep by default.
 *
 * Upstream's `DEFAULT_PROTECTED_TOOLS` (`lib/config.ts:78`) is `["task",
 * "skill", "todowrite", "todoread", "compress", "batch", "plan_enter",
 * "plan_exit", "write", "edit"]`, mapped onto harness tool names.
 */
export const DEFAULT_PROTECTED_TOOLS = [
  'subagent',
  'subagent_fork',
  'skill',
  'todo_write',
  'todo_read',
  'compress',
  'workflow',
  'ralph',
  'exit_plan_mode',
  'edit',
  'write'
];

const QUESTION_TOOLS = new Set(['question', 'ask_user_question']);
const PROTECTED_OUTPUT_TOOLS = new Set(['edit', 'write']);

function pruneKind(call) {
  if (call.isError === true) return 'error-input';
  if (QUESTION_TOOLS.has(call.tool)) return 'question-input';
  if (PROTECTED_OUTPUT_TOOLS.has(call.tool)) return 'protected-output';
  return 'output';
}

/**
 * Plan a manual sweep, upstream's `/dcp sweep [N]`.
 *
 * Upstream's handler (`lib/commands/sweep.ts:129-231`) picks call ids by hand —
 * the last N from `state.toolIdList`, or everything after the last user message —
 * filters out ones already pruned and ones the `commands.protectedTools` list
 * covers, and writes the survivors into `state.prune.tools` with their token
 * counts. This is that selection, and nothing else: the caller feeds the entries
 * through the same manifest and materialization the automatic strategies use, so a
 * hand-run sweep leaves exactly the same kind of trace as an automatic pass.
 *
 * THE ORDER OF THE FILTERS IS UPSTREAM'S, and it matters for what the report can
 * say: the candidates are picked BEFORE protection is applied, so "N tools swept"
 * counts what the user asked for while the protected ones are reported separately
 * rather than silently reducing the number.
 *
 * @param session - session whose surface is read.
 * @param options - `limit` (the N of `/dcp sweep N`) and the config to protect by.
 * @returns the planned entries in surface order, plus how many were skipped.
 */
export function planSweep(session, options = {}) {
  const { meter, config, limit, sinceUserMessage = false, pruned = new Set() } = options;
  const calls = (options.calls ?? readToolCalls(session, meter)).filter((call) => call.result !== undefined);
  const candidates = [];
  if (sinceUserMessage) {
    // Everything AFTER the last user instruction, which is upstream's default
    // when no number is given: the work the model has done in this turn.
    const nodes = readSurface(session);
    let lastUserIndex = -1;
    for (let index = 0; index < nodes.length; index += 1) {
      if (nodes[index].event?.type === 'user/message' && toolResultOf(nodes[index].message) === undefined) {
        lastUserIndex = index;
      }
    }
    if (lastUserIndex !== -1) {
      const inScope = new Set();
      for (let index = lastUserIndex + 1; index < nodes.length; index += 1) inScope.add(Number(nodes[index].seq));
      for (const call of calls) {
        if (inScope.has(Number(call.seq))) candidates.push(call);
      }
    }
  } else if (Number.isInteger(limit) && limit > 0) {
    candidates.push(...calls.slice(Math.max(0, calls.length - limit)));
  } else {
    candidates.push(...calls);
  }

  const entries = [];
  let skippedProtected = 0;
  for (const call of candidates) {
    if (pruned.has(call.callId)) continue;
    if (config !== undefined && isProtectedCall(call, config)) {
      skippedProtected += 1;
      continue;
    }
    entries.push({
      strategy: STRATEGY_LABELS.sweep,
      callId: call.callId,
      tool: call.tool,
      // The call's OWN price, which is what upstream records for a sweep
      // (`sweep.ts:225-228`). The automatic strategies leave 0 here for a failed
      // call because they remove its input rather than its output; a sweep removes
      // the output, so the number is the payload it is about to delete.
      tokens: call.tokens,
      turn: call.turn,
      prune: call.isError === true ? 'inputs' : 'output',
      kind: pruneKind(call),
      seq: call.seq,
      event: call.event,
      message: call.message,
      label: `${call.tool} (swept by hand)`
    });
  }
  return { entries, skippedProtected };
}

/** Human-readable label for one strategy, used in results and diagnostics. */
const STRATEGY_LABELS = {
  deduplication: 'deduplication',
  purgeErrors: 'purgeErrors',
  sweep: 'sweep'
};

/**
 * The age unit upstream measures both age policies in: the count of steps, not
 * the turn number.
 *
 * `turnsFor` (in `session.js`) stamps every node with the same counter, so the
 * live side must count identically or the subtraction is meaningless — a call in
 * the current step has to land on the total. Upstream gets this for free by
 * walking the outgoing messages and incrementing on each `step-start` part
 * (`lib/state/tool-cache.ts:39-52`).
 *
 * ONLY `step/start` advances the counter, mirroring `turnsFor` and upstream's
 * `step-start` parts. A log with no `step/start` yields 0, and an earlier
 * turn-shaped fallback here — which advanced the counter on `turn/start` when the
 * turn logged no step — is gone: it made the same log measure two different ages
 * depending on which side asked, and it let the suite assert ages that no real
 * session can produce.
 *
 * @param session - session to inspect.
 * @returns the number of steps in the log.
 */
function currentTurn(session) {
  let steps = 0;
  for (let seq = 0; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq);
    if (event === undefined) continue;
    if (event.type === 'step/start') steps += 1;
  }
  return steps;
}

/**
 * Whether a call is protected from a strategy by tool name or by file glob.
 *
 * Upstream checks both, per call, before it ever looks at signatures
 * (`lib/strategies/deduplication.ts:55-62`): a protected tool name, or an
 * invocation that touched a protected file path.
 *
 * @param call - the invocation, as {@link readToolCalls} reports it (`tool`, not
 *   `name` — the record's field is `tool`, and reading a field that does not
 *   exist made this whole function return false, silently disabling EVERY
 *   protection while the checks that only asserted "something was pruned" still
 *   passed).
 * @param config - resolved strategy configuration.
 * @returns true when the call must be left alone.
 */
function isProtectedCall(call, config) {
  const matcher = config.nameMatcher;
  if (matcher !== undefined && matcher(call.tool)) return true;
  const pathMatcher = config.pathMatcher;
  for (const path of filePathsOf(call.arguments, call.tool)) {
    if (pathMatcher(path)) return true;
  }
  return false;
}

/**
 * The signature that makes two invocations duplicates.
 *
 * Upstream's `createToolSignature` (`lib/strategies/deduplication.ts:96-103`), step
 * for step: drop null/undefined fields (`normalizeParameters`, `:105-116`), sort
 * the keys **recursively** (`sortObjectKeys`, `:118-127`), join tool and JSON
 * with `::`.
 *
 * THE SORT MATTERS WHENEVER THE PORT COMPARES TWO CALLS THAT CAME FROM DIFFERENT
 * PLACES, and that is not hypothetical: the manifest is re-seeded from the
 * session on every pass (`_forgetUnmaterializedPrunes`), a session can be resumed
 * from a log written by another build, and a model is free to emit
 * `{"a":1,"b":2}` and `{"b":2,"a":1}` for the same invocation. Key order is not
 * part of the invocation, so the comparison must not see it.
 *
 * An earlier version of this function used `JSON.stringify` on the normalized
 * tree with its keys in their ORIGINAL order, on the argument that both sides
 * were always produced here and therefore always serialized the same way. That
 * argument is exactly the assumption this port keeps having to retract.
 *
 * @param call - the call record, whose `arguments` is a PARSED record.
 * @returns the signature string.
 */
function callSignature(call) {
  return `${call.tool}::${JSON.stringify(sortKeysDeep(withoutEmptyFields(call.arguments)))}`;
}

/**
 * Rebuild an argument tree with every object's keys in sorted order.
 *
 * Upstream's `sortObjectKeys` (`lib/strategies/deduplication.ts:118-127`):
 * arrays keep their order and are walked element by element, objects are rebuilt
 * from `Object.keys(obj).sort()`, and anything that is not an object is returned
 * as it is.
 *
 * @param value - a parsed argument tree.
 * @returns the same tree with sorted keys, at every depth.
 */
function sortKeysDeep(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  const sorted = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortKeysDeep(value[key]);
  return sorted;
}

/**
 * Drop top-level null and undefined fields, as upstream does before it
 * compares two invocations.
 *
 * Upstream's `normalizeParameters` (`lib/strategies/deduplication.ts:105-116`)
 * skips empty entries in the input object only. Nested nulls remain meaningful;
 * recursive key sorting happens in the separate pass above.
 *
 * @param value - a parsed argument tree.
 * @returns the tree without empty fields.
 */
function withoutEmptyFields(value) {
  if (Array.isArray(value)) return value;
  if (value === null || typeof value !== 'object') return value;
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || entry === null) continue;
    result[key] = entry;
  }
  return result;
}

/** The magnitude of one call's output, priced from the message the model saw. */
function messageTokens(session, node, meter) {
  const message = session.deriveEventMessage(session.eventAt(node.seq));
  if (message === null || message === undefined) return 0;
  if (typeof meter?.estimateMessage !== 'function') throw new Error('token meter is unavailable; refusing to mutate DCP prune state');
  const tokens = meter.estimateMessage(message);
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) throw new Error('token meter returned an invalid message estimate; refusing to mutate DCP prune state');
  return tokens;
}

/**
 * Every tool call on the surface, in order, with its result.
 *
 * This is the port of upstream's `toolIdList` + `toolParameters` pair: it walks
 * the messages once and records, per call, the tool name, the parsed arguments,
 * the turn the call happened in, the result's error flag, and how many tokens
 * the result was worth. Calls whose result is not on the surface yet are
 * reported with `result: undefined` and are never prunable — upstream skips them
 * for the same reason (`state.toolParameters` is filled from completed parts).
 *
 * @param session - session whose surface is read.
 * @param meter - the token meter used to price a result.
 * @returns call records in surface order.
 */
export function readToolCalls(session, meter) {
  const steps = readSteps(session);
  const seqs = [];
  for (const step of steps) {
    seqs.push(step.node.seq);
    for (const result of step.results) seqs.push(result.node.seq);
  }
  const turns = turnsFor(session, seqs);
  const calls = [];
  for (const step of steps) {
    for (const call of step.calls) {
      const result = step.results.find((entry) => entry.callId === call.id);
      // The PARSED record, not the raw JSON string. `filePathsOf` reads named
      // fields off an object, so handing it the string silently yielded no paths
      // and turned every `protectedFilePatterns` glob into a no-op.
      const { arguments: parsed } = invocationOf(call);
      calls.push({
        callId: call.id,
        tool: call.name,
        arguments: parsed,
        turn: turns.get(step.node.seq) ?? 0,
        isError: result?.isError === true,
        result,
        // The node seq and the event, for materializing the prune. A prune is a
        // session event that shadows this node, so both are needed at decision
        // time; they are read here, while the surface still holds the original.
        seq: result === undefined ? undefined : Number(result.node.seq),
        event: result?.event,
        message: result === undefined ? undefined : result.node.message,
        tokens: result === undefined ? 0 : messageTokens(session, result.node, meter)
      });
    }
  }
  return calls;
}

/**
 * Plan the pruning of repeated tool invocations, upstream's `deduplicate`.
 *
 * Two invocations are duplicates when their signature matches. The newest of each
 * group is authoritative; every EARLIER one is added to the manifest, so the
 * model keeps the answer it would have read anyway and loses only the copies.
 * Upstream's grouping is over the flat list of calls in surface order, so two
 * identical calls inside one assistant message deduplicate against each other
 * exactly as two calls in different messages do — the port keeps that.
 *
 * @param session - session whose surface is planned over.
 * @param config - resolved `strategies.deduplication` configuration.
 * @param deps - `meter`, the live turn, the turn-protection window, and the ids
 *   already in the manifest.
 * @returns the manifest entries this pass would add, in surface order.
 */
export function planDeduplication(session, config, deps) {
  if (!config.enabled) return [];
  const calls = deps.calls ?? readToolCalls(session, deps.meter);
  if (calls.length === 0) return [];
  const already = deps.pruned ?? new Set();

  // Group by signature, keeping only the LAST call of each group. Protected and
  // already-pruned calls never enter the map, so neither can push a live call
  // out of the "newest" position.
  const latestBySignature = new Map();
  for (const call of calls) {
    if (already.has(call.callId)) continue;
    if (call.result === undefined) continue;
    if (isProtectedCall(call, config)) continue;
    if (isTurnProtected(call, deps)) continue;
    latestBySignature.set(callSignature(call), call);
  }

  const entries = [];
  for (const call of calls) {
    if (already.has(call.callId)) continue;
    if (call.result === undefined) continue;
    if (isProtectedCall(call, config)) continue;
    if (isTurnProtected(call, deps)) continue;
    const latest = latestBySignature.get(callSignature(call));
    if (latest === undefined || latest.callId === call.callId) continue;
    entries.push({
      strategy: STRATEGY_LABELS.deduplication,
      callId: call.callId,
      tool: call.tool,
      tokens: call.tokens,
      turn: call.turn,
      // WHICH HALF OF THE CALL GOES. Upstream's `pruneToolOutputs` blanks the
      // payload of a COMPLETED call and `pruneToolErrors` blanks the inputs of an
      // ERRORED one — the error text is the lesson and must survive. The manifest
      // used to carry no status at all, so a successful duplicate's arguments were
      // relabelled "[input removed due to failed tool call]" and a failed call's
      // error was erased by the output placeholder. The status travels with the
      // entry now so the materializer cannot confuse the two.
      prune: call.isError === true ? 'inputs' : 'output',
      kind: pruneKind(call),
      seq: call.seq,
      event: call.event,
      message: call.message,
      label: `${call.tool} → superseded by the identical call ${latest.callId}`
    });
  }
  return entries;
}

/**
 * Whether a call sits inside the protected turn window (upstream's
 * `turnProtection`, applied inside the tool-cache sync).
 *
 * Upstream evaluates this at CACHE time and simply never records the call
 * (`lib/state/tool-cache.ts:39-52`), which is why a protected call cannot be
 * pruned by any later pass: the strategies only ever see cached calls. The port
 * makes the same decision at the same point.
 *
 * @param call - the call record.
 * @param deps - carries `currentTurn` and the turn-protection configuration.
 * @returns true when the call is too recent to touch.
 */
function isTurnProtected(call, deps) {
  const protection = deps.turnProtection;
  if (protection === undefined || protection.enabled !== true) return false;
  const window = Number.isInteger(protection.turns) && protection.turns > 0 ? protection.turns : 0;
  if (window === 0) return false;
  return (deps.currentTurn ?? 0) - call.turn < window;
}

/**
 * Plan the blanking of arguments for tool calls that FAILED, once they are old
 * enough — upstream's `purgeErrors`.
 *
 * The error text is preserved and only the inputs go: the lesson ("that command
 * does not work") stays in the transcript, the huge argument payload does not.
 * Upstream measures the age as `state.currentTurn - metadata.turn >= turns` and
 * clamps the threshold to at least 1 turn.
 *
 * @param session - session whose surface is planned over.
 * @param config - resolved `strategies.purgeErrors` configuration.
 * @param deps - `meter`, the live turn, turn protection, and the manifest.
 * @returns the manifest entries this pass would add, in surface order.
 */
export function planPurgeErrors(session, config, deps) {
  if (!config.enabled) return [];
  const threshold = Math.max(1, Number.isInteger(config.turns) ? config.turns : 1);
  const calls = deps.calls ?? readToolCalls(session, deps.meter);
  const already = deps.pruned ?? new Set();
  const entries = [];
  for (const call of calls) {
    if (already.has(call.callId)) continue;
    if (call.result === undefined) continue;
    if (call.isError !== true) continue;
    if (isProtectedCall(call, config)) continue;
    if (isTurnProtected(call, deps)) continue;
    if ((deps.currentTurn ?? 0) - call.turn < threshold) continue;
    entries.push({
      strategy: STRATEGY_LABELS.purgeErrors,
      callId: call.callId,
      tool: call.tool,
      // Upstream records 0 here (`purge-errors.ts:80-83` prices the call's own
      // tokens, not the input it removes) and so does the port: the number is
      // the manifest's, and inflating it would misreport the saving.
      tokens: 0,
      turn: call.turn,
      // A failed call's INPUT goes, and its error text stays — that is the whole
      // point of the strategy.
      prune: 'inputs',
      kind: 'error-input',
      seq: call.seq,
      event: call.event,
      message: call.message,
      label: `${call.tool} (errored, older than ${threshold} turn(s))`
    });
  }
  return entries;
}

/**
 * The turn number of the newest turn in the log, for turn-protection decisions.
 * @param session - session to inspect.
 * @returns the turn number, or 0 before the first turn.
 */
export function liveTurn(session) {
  return currentTurn(session);
}

/**
 * Resolve the merged DCP configuration into the shape the planners read.
 *
 * The merged configuration is the plugin's declared `Config` after the user's
 * `dcp.jsonc` has been folded in by the engine, so every field is already
 * validated; this only widens the string lists and compiles the path globs
 * once per session instead of once per invocation.
 *
 * @param config - merged, validated DCP configuration.
 * @returns a frozen strategy configuration.
 */
export function resolveStrategyConfig(config) {
  const extra = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);
  const pathMatcher = compilePathMatcher(extra(config.protectedFilePatterns));
  const protectedFilePatterns = Object.freeze(extra(config.protectedFilePatterns));
  // A NAME MATCHER, not a list. Upstream's `isToolNameProtected` splits the
  // patterns into exact names and globs and tries the exact set first
  // (`lib/protected-patterns.ts:113-132`), so `protectedTools: ["mcp_*"]` protects
  // every tool a server exposes. The port compared with `Array.includes`, which
  // made a glob silently protect nothing.
  const toolList = (own) => Object.freeze(extra(own));
  const strategyConfig = (own, extraFields = {}) => Object.freeze({
    protectedTools: toolList(own),
    nameMatcher: compileToolNameMatcher(toolList(own)),
    pathMatcher,
    ...extraFields
  });
  return Object.freeze({
    protectedFilePatterns,
    deduplication: strategyConfig(config.strategies.deduplication.protectedTools, {
      enabled: config.strategies.deduplication.enabled
    }),
    purgeErrors: strategyConfig(config.strategies.purgeErrors.protectedTools, {
      enabled: config.strategies.purgeErrors.enabled,
      turns: config.strategies.purgeErrors.turns
    }),
    commands: strategyConfig(config.commands?.protectedTools),
    turnProtection: Object.freeze({
      enabled: config.turnProtection.enabled,
      turns: config.turnProtection.turns
    })
  });
}
