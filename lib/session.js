/**
 * Session-surface reading for deterministic (model-free) pruning.
 *
 * A DSH session is an append-only event log plus a derived model-visible
 * surface. This module is the read half of the port: it replays the surface
 * into the small vocabulary DCP's strategies reason about — steps (one
 * assistant message plus the tool results it produced), tool invocations, and
 * the turn each surface node belongs to — without depending on how the log
 * was produced.
 *
 * @module dsh-context-kit/session
 */

import { isRecord, stableStringify } from './common.js';

/** Project one surface event into the message it derives to, or `undefined`. */
function derivedMessage(event) {
  switch (event?.type) {
    case 'user/message':
      return event.data;
    case 'system/message':
    case 'assistant/message': {
      const message = event.data?.message;
      if (message === undefined || message.content.length === 0) return undefined;
      return message;
    }
    case 'tool/result':
      return event.data?.message;
    default:
      return undefined;
  }
}

/**
 * Read the live surface as `{ seq, event, message }` records in surface order.
 *
 * @param session - session whose surface is read.
 * @returns one record per surface node that projects to a message.
 */
export function readSurface(session) {
  const records = [];
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq);
    if (event === undefined) continue;
    const message = derivedMessage(event);
    if (message === undefined) continue;
    records.push({ seq, event, message });
  }
  return records;
}

/**
 * Map one surface node to the AGE UNIT upstream measures policies in.
 *
 * Upstream's `syncToolCache` walks the outgoing messages and increments its
 * counter on every `step-start` part (`lib/state/tool-cache.ts:39-52`), storing
 * that counter as `metadata.turn`. Both policies compare against it:
 * `turnProtection` skips a call while `currentTurn - turn < turns`
 * (`tool-cache.ts:44-47`) and `purgeErrors` prunes while
 * `currentTurn - metadata.turn >= Math.max(1, turns)`
 * (`lib/strategies/purge-errors.ts:46,72-75`).
 *
 * Counting `turn/start` instead — the port's earlier behaviour — is a unit
 * error of roughly the steps-per-turn factor. Measured on the user's own session
 * log: `turn/start` = 36 against `step/start` = 1503, about 42 steps per turn.
 * With the shipped default of `turns: 4` that made both policies wait for four
 * whole user turns, so an error six steps old inside one turn was never purged
 * and a four-step protection window protected a whole turn.
 *
 * ONLY `step/start` advances the counter, exactly as upstream advances it on
 * `step-start` parts and on nothing else. An earlier version also advanced it on
 * `turn/start` when the turn logged no step, as a kindness to turn-shaped
 * fixtures — and that kindness was a silent policy change: a fixture with two
 * bare turns read an age of 2, which is why the age assertions in the suite were
 * measuring the wrong quantity. A log with no `step/start` therefore has age 0,
 * which is correct: no step has been taken, so nothing is old in step terms.
 *
 * `event.data.turn` is NOT used as the age. `turn` is monotonic within a session
 * (`dsh-agent-loop\lib\index.js:924,930` — `const turn = phase.turn + 1`, kept
 * across wake-ups through `lastTurn`), but it is assigned per USER turn, so a
 * single turn with forty steps is one number. Counting it is the unit error this
 * whole section exists about.
 *
 * The log is walked once so a node created by a replacement inherits the step it
 * landed in rather than the step of the events it shadowed — which is what a
 * "how many steps ago" policy wants.
 *
 * @param session - session providing the log.
 * @param seqs - surface node sequences to resolve.
 * @returns a map from sequence number to step number.
 */
export function turnsFor(session, seqs) {
  const wanted = new Set(seqs);
  const turns = new Map();
  let current = 0;
  for (let seq = 0; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq);
    if (event === undefined) continue;
    if (event.type === 'step/start') current += 1;
    if (wanted.has(seq)) turns.set(seq, current);
  }
  for (const seq of seqs) if (!turns.has(seq)) turns.set(seq, current);
  return turns;
}

/** The tool-call blocks of one assistant message, in order. */
export function toolCallsOf(message) {
  const calls = [];
  for (const block of message?.content ?? []) {
    if (block?.type === 'tool-call' && typeof block.name === 'string') {
      calls.push({ id: block.id, name: block.name, arguments: block.arguments });
    }
  }
  return calls;
}

/** The tool-result block carried by one tool-result message. */
export function toolResultOf(message) {
  const block = message?.content?.[0];
  if (block?.type === 'tool-result') return block;
  return undefined;
}

/**
 * Group the surface into DCP steps.
 *
 * A step is one assistant message and the tool-result nodes that answer it.
 * Assistant messages with no tool calls produce a step with an empty result
 * list; tool results whose call is not on the surface (possible after an
 * earlier replacement) are skipped, because they cannot be pruned as a pair.
 *
 * @param session - session whose surface is read.
 * @returns steps in surface order.
 */
export function readSteps(session) {
  const surface = readSurface(session);
  const steps = [];
  const indexByCallId = new Map();
  for (const record of surface) {
    if (record.event.type === 'assistant/message') {
      const calls = toolCallsOf(record.message);
      const step = { node: record, calls, results: [] };
      steps.push(step);
      for (const call of calls) indexByCallId.set(call.id, step);
      continue;
    }
    if (record.event.type === 'tool/result') {
      const result = toolResultOf(record.message);
      if (result === undefined) continue;
      const step = indexByCallId.get(result.toolCallId);
      if (step === undefined) continue;
      step.results.push({
        node: record,
        // The LOG EVENT, not just its projected message. Materializing a prune
        // requires re-appending the whole `tool/result` event with one content
        // block swapped (the harness accepts a tool-result replacement only when
        // id, source, callId and isError are byte-identical), so the event is
        // carried here rather than re-fetched from the surface later — by then a
        // replacement may already have moved it.
        event: record.event,
        callId: result.toolCallId,
        isError: result.isError === true
      });
    }
  }
  return steps;
}

/**
 * Strip every tool-call block from an assistant message's content.
 *
 * A step whose tool calls are all shadowed must not keep the calls: the
 * provider contract pairs every assistant tool call with a following tool
 * result, and the results are exactly what the replacement removes.
 *
 * @param content - assistant content blocks.
 * @returns the text/reasoning blocks that survive.
 */
export function withoutToolCalls(content) {
  return (content ?? []).filter((block) => block?.type !== 'tool-call');
}

/** The durable payload of a tool invocation, for display and reporting. */
export function invocationOf(call) {
  let parsed;
  try {
    parsed = JSON.parse(call.arguments);
  } catch {
    parsed = undefined;
  }
  // The REPORTED arguments are always a record. A call whose arguments are
  // absent, empty or not a JSON object reports `{}` rather than the raw string,
  // because every consumer of this — the path matcher, the signature, the
  // placeholder pass — is written against an object: handing one of them a
  // string does not fail loudly, it quietly matches nothing.
  const parsedArguments = isRecord(parsed)
    ? parsed
    : typeof call.arguments === 'string' && call.arguments.trim().length > 0
      ? { raw: call.arguments }
      : {};
  return {
    name: call.name,
    arguments: parsedArguments,
    signature: `${call.name}\u0000${stableStringify(parsed ?? call.arguments)}`
  };
}

/**
 * The file paths one invocation touched, including upstream's special
 * `apply_patch` and `multiedit` parameter shapes.
 *
 * @param args - parsed tool arguments.
 * @param tool - tool name selecting a special parameter shape.
 * @returns the candidate paths, possibly empty.
 */
export function filePathsOf(args, tool = '') {
  if (!isRecord(args)) return [];
  const paths = [];
  if (tool === 'apply_patch' && typeof args.patchText === 'string') {
    for (const match of args.patchText.matchAll(/\*\*\* (?:Add|Delete|Update) File: ([^\n\r]+)/g)) paths.push(match[1].trim());
  }
  if (tool === 'multiedit') {
    if (typeof args.filePath === 'string') paths.push(args.filePath);
    for (const edit of Array.isArray(args.edits) ? args.edits : []) {
      if (isRecord(edit) && typeof edit.filePath === 'string') paths.push(edit.filePath);
    }
  }
  if (typeof args.filePath === 'string') paths.push(args.filePath);
  return [...new Set(paths)].filter((path) => path.length > 0);
}

/**
 * Compile a TOOL-NAME matcher, upstream's `isToolNameProtected`.
 *
 * Upstream splits the patterns in two (`lib/protected-patterns.ts:113-132`): a
 * pattern without `*` or `?` is an EXACT name and is looked up in a set, anything
 * else is a glob. Splitting rather than matching everything as a glob is not just
 * an optimisation — it is what makes a name containing regex-significant
 * characters compare literally, and it is why `edit` protects the tool `edit` and
 * not `edXt`.
 *
 * The glob half is the same language as the file-path matcher (`*` inside a
 * segment, `**` across them, `?` for one character), which upstream shares between
 * the two (`matchesGlob`, `:13-62`).
 *
 * @param patterns - the resolved `protectedTools` list.
 * @returns a predicate; exact hits first, then the globs.
 */
export function compileToolNameMatcher(patterns) {
  const exact = new Set();
  const globs = [];
  for (const pattern of patterns) {
    if (pattern.length === 0) continue;
    if (/[*?]/.test(pattern)) globs.push(pattern);
    else exact.add(pattern);
  }
  if (globs.length === 0) return (name) => exact.has(name);
  return (name) => exact.has(name) || globs.some((pattern) => matchesGlob(name, pattern));
}

/** Upstream's path-normalizing `*`/`**`/`?` matcher. */
export function matchesGlob(inputPath, pattern) {
  if (!pattern) return false;
  const input = String(inputPath).replaceAll('\\', '/');
  const normalized = String(pattern).replaceAll('\\', '/');
  let regex = '^';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        if (normalized[index + 2] === '/') {
          regex += '(?:.*/)?';
          index += 2;
        } else {
          regex += '.*';
          index += 1;
        }
      } else {
        regex += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      regex += '[^/]';
      continue;
    }
    regex += /[\\.^$+{}()|\[\]]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`${regex}$`).test(input);
}

/**
 * Compile glob patterns into a matcher over absolute-ish paths.
 *
 * Supports `*` (within a segment), `**` (across segments), and `?` against the
 * normalized full path, exactly as upstream does.
 *
 * @param patterns - glob patterns.
 * @returns a predicate; always false for an empty pattern list.
 */
export function compilePathMatcher(patterns) {
  if (patterns.length === 0) return () => false;
  return (candidate) => patterns.some((pattern) => matchesGlob(candidate, pattern));
}
