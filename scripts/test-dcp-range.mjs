/**
 * Regression: `compress` must be reachable by the model.
 *
 * The shipped `validateSurfaceRegion` accepts a range only when the cut before
 * `start` and the cut after `end` are tool-pairing balanced, where balance is a
 * content fold (assistant tool-call = +1, tool/result = -1, balanced at zero).
 * The port's `balancedRange` used to look only for "not already compacted", so
 * every range a model could name was refused with "not a balanced boundary" and
 * the tool was unusable.
 *
 * This test drives `balancedRange` directly against a synthetic surface that
 * reproduces the shape that used to fail: a system node, a user node, then
 * steps whose boundaries do NOT sit on step markers.
 *
 * Run:  node scripts/test-dcp-range.mjs
 *
 * @module dsh-context-kit/scripts/test-dcp-range
 */

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const kitRoot = join(here, '..');

const failures = [];
/** @param name - check label. @param ok - result. @param detail - evidence. */
function check(name, ok, detail = '') {
  console.log(`${ok ? '[ok]  ' : '[FAIL]'} ${name}${detail.length > 0 ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

/** One assistant message with `calls` tool-call blocks and some text. */
const assistant = (calls) => ({
  type: 'assistant/message',
  data: {
    message: {
      content: [
        { type: 'text', text: `step with ${calls} call(s)` },
        ...Array.from({ length: calls }, (_, index) => ({ type: 'tool-call', id: `c${index}`, name: 'read', arguments: '{}' }))
      ]
    }
  }
});

/** One tool result answering call `id`. */
const result = (id) => ({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: id, isError: false }] } } });

/** One text-only assistant message (no tool calls). */
const textOnly = (text = 'plain') => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });

const system = { type: 'system/message', data: { message: { content: [{ type: 'text', text: 'system' }] } } };
const user = { type: 'user/message', data: { content: [{ type: 'text', text: 'the user instruction' }] } };

/**
 * Build a fake session whose surface and log share one sequence space.
 * @param events - log events in sequence order; index === seq.
 * @param surfaceSeqs - the nodes currently on the surface.
 */
let fakeSessionId = 0;
function fakeSession(events, surfaceSeqs) {
  return {
    id: `range-${++fakeSessionId}`,
    seq: events.length,
    eventAt: (seq) => (typeof seq === 'number' ? events[seq] : events[Number(seq)]),
    surface: { nodes: surfaceSeqs, replaceGeneration: 1 }
  };
}

const { DcpCompactionEngine } = await import(pathToFileURL(join(kitRoot, 'lib', 'dcp.js')).href);

// The engine's constructor needs a context; only `balancedRange` is exercised,
// and it touches no service, so a minimal stand-in is enough.
const engine = Object.create(DcpCompactionEngine.prototype);

/* ---------------------------------------------------------------- fixtures */

// seq: 0 system, 1 user, 2 assistant(2 calls), 3 result, 4 result,
//      5 assistant(1 call), 6 result, 7 text-only, 8 assistant(1 call) — 8 unanswered
const events = [
  system,
  user,
  assistant(2),
  result('c0'),
  result('c1'),
  assistant(1),
  result('c0'),
  textOnly('finished a step'),
  assistant(1)
];
const surfaceSeqs = [0, 1, 2, 3, 4, 5, 6, 7, 8];
const session = fakeSession(events, surfaceSeqs);

/* ------------------------------------------------------------------ checks */

console.log('--- balance fold ---');

// An unanchored start (mid tool pair) must snap FORWARD to the next balanced cut.
{
  const range = engine.balancedRange(session, 3, 7);
  check('start snaps forward out of a tool pair', range !== undefined && Number(range.start) === 5, JSON.stringify(range && { start: Number(range.start), end: Number(range.end) }));
}

// A start already on a balanced cut stays put.
{
  const range = engine.balancedRange(session, 2, 7);
  check('a balanced start is kept', range !== undefined && Number(range.start) === 2, JSON.stringify(range && { start: Number(range.start), end: Number(range.end) }));
}

// An end that leaves a call unanswered must snap BACK to the last balanced cut.
{
  const range = engine.balancedRange(session, 2, 8);
  check('end snaps back off an open tool call', range !== undefined && Number(range.end) === 7, JSON.stringify(range && { start: Number(range.start), end: Number(range.end) }));
}

// The whole surface-valid span, both edges already balanced.
{
  const range = engine.balancedRange(session, 2, 7);
  check('full span accepted', range !== undefined && Number(range.start) === 2 && Number(range.end) === 7);
}

// Seqs that are not on the surface are refused, never snapped onto something else.
{
  check('a seq absent from the surface is refused', engine.balancedRange(session, 999, 7) === undefined);
}

// A span that holds no complete pair at all is refused.
{
  const openOnly = fakeSession([system, user, assistant(1)], [0, 1, 2]);
  check('a span with only an open call is refused', engine.balancedRange(openOnly, 2, 2) === undefined);
}

console.log('\n--- system nodes and stale addresses ---');
{
  check('the system head cannot begin a compression', engine.balancedRange(session, 0, 7) === undefined);
  check('message mode cannot compress the system head', engine.balancedRange(session, 0, 0, { singleNode: true }) === undefined);
  const replaced = fakeSession([...events, system], [9, 1, 2, 3, 4, 5, 6, 7, 8]);
  check('a new system head is protected by type, not seq', engine.balancedRange(replaced, 9, 7) === undefined);
  check('a stale start cannot snap to the new system head', engine.balancedRange(replaced, 0, 7) === undefined);
  const stale = fakeSession(events, [0, 1, 5, 6, 7, 8]);
  check('a removed start cannot snap to unrelated surviving messages', engine.balancedRange(stale, 2, 7) === undefined);
  check('a removed end cannot snap to an earlier surviving message', engine.balancedRange(stale, 1, 4) === undefined);
  const interior = fakeSession([user, textOnly('a'), system, textOnly('b')], [0, 1, 2, 3]);
  check('an interior system message cannot be shadowed', engine.balancedRange(interior, 0, 3) === undefined);
  check('a non-system first surface node remains compressible', engine.balancedRange(interior, 0, 1) !== undefined);
}

console.log('\n--- already-compacted edges ---');

/**
 * A trusted DCP block node, framed the way a real one is.
 *
 * The footer is NOT decoration: `blockAtSeq` reads the id out of
 * `<dcp-message-id>bN</dcp-message-id>` when the registry has no entry, which is
 * exactly the case here: `blocksFor` reconstructs state from trusted DCP source,
 * wrapper and provenance before range balancing.
 *
 * @param id - the block id the footer carries.
 * @param body - the summary text.
 * @returns the session event.
 */
const checkpointBlock = (id, body) => ({
  type: 'user/message',
  data: {
    content: [{ type: 'text', text: `[Compressed conversation section]\n${body}\n<dcp-message-id>b${id}</dcp-message-id>` }],
    source: { kind: 'plugin:dcp' }
  }
});

// A selected boundary block is replaced along with the fresh material. Moving
// past it would carry its text while leaving its own node in the model view.
{
  const withCheckpoint = fakeSession([system, user, checkpointBlock(7, 'leading'), textOnly('a'), textOnly('b')], [0, 1, 2, 3, 4]);
  const range = engine.balancedRange(withCheckpoint, 2, 4);
  check('a leading compressed block stays inside the range', range !== undefined && Number(range.start) === 2 && Number(range.end) === 4, JSON.stringify(range && { start: Number(range.start), end: Number(range.end) }));
  check('the leading block is reported as a selected boundary', JSON.stringify(range?.boundaryBlockIds) === '[7]', JSON.stringify(range?.boundaryBlockIds));
  check('the leading block node is among the nodes to shadow', range !== undefined && withCheckpoint.surface.nodes.slice(range.startIdx, range.endIdx + 1).includes(2));
}
{
  // The same rule applies at the end edge.
  const withTrailing = fakeSession([system, user, textOnly('a'), textOnly('b'), checkpointBlock(7, 'trailing')], [0, 1, 2, 3, 4]);
  const range = engine.balancedRange(withTrailing, 1, 4);
  check('a trailing compressed block stays inside the range', range !== undefined && Number(range.start) === 1 && Number(range.end) === 4, JSON.stringify(range && { start: Number(range.start), end: Number(range.end) }));
  check('the trailing block is reported as a boundary', JSON.stringify(range?.boundaryBlockIds) === '[7]', JSON.stringify({ boundary: range?.boundaryBlockIds, stepped: range?.steppedBlockIds }));
  check('the trailing block node is among the nodes to shadow', range !== undefined && withTrailing.surface.nodes.slice(range.startIdx, range.endIdx + 1).includes(4));
}
{
  // Interior block: collected as compressible content, exactly like any other
  // node in the span, and reported so the caller can require a placeholder.
  const withInterior = fakeSession([system, user, textOnly('a'), checkpointBlock(7, 'middle'), textOnly('b')], [0, 1, 2, 3, 4]);
  const range = engine.balancedRange(withInterior, 1, 4);
  check('an interior block is collected', JSON.stringify(range?.innerBlockIds) === '[7]', JSON.stringify(range?.innerBlockIds));
  check('an interior block is not an edge', (range?.boundaryBlockIds ?? []).length === 0, JSON.stringify(range?.boundaryBlockIds));
}

console.log('\n--- replacement ids follow surface order, not numeric order ---');
{
  const reordered = fakeSession([system, user, textOnly('a'), textOnly('b'), checkpointBlock(7, 'new seq')], [0, 1, 4, 2, 3]);
  const range = engine.balancedRange(reordered, 4, 3);
  check('a newly minted block can begin a range ending at an older seq', range !== undefined && range.startIdx === 2 && range.endIdx === 4, JSON.stringify(range));
  check('a backwards surface range is refused', engine.balancedRange(reordered, 3, 4) === undefined);
  check('a one-node range needs single-node mode', engine.balancedRange(reordered, 4, 4) === undefined);
  const adjacent = engine.balancedRange(reordered, 2, 3);
  check('an adjacent outside block is not absorbed', adjacent !== undefined && adjacent.startIdx === 3 && adjacent.endIdx === 4 && adjacent.boundaryBlockIds.length === 0, JSON.stringify(adjacent));
  const single = engine.balancedRange(reordered, 2, 2, { singleNode: true });
  check('message mode does not absorb an adjacent block', single !== undefined && single.startIdx === 3 && single.endIdx === 3, JSON.stringify(single));
}
{
  const both = fakeSession([system, user, checkpointBlock(7, 'left'), textOnly('fresh'), checkpointBlock(8, 'right')], [0, 1, 2, 3, 4]);
  const range = engine.balancedRange(both, 2, 4);
  check('one fresh node between two blocks is compressible', range !== undefined && range.startIdx === 2 && range.endIdx === 4, JSON.stringify(range));
  check('both selected boundary blocks are reported', JSON.stringify(range?.boundaryBlockIds) === '[7,8]', JSON.stringify(range?.boundaryBlockIds));
  const onlyBlocks = fakeSession(both.surface.nodes.map((seq) => both.eventAt(seq)), [0, 1, 2, 4]);
  const blockRange = engine.balancedRange(onlyBlocks, 2, 4);
  check('a range containing only blocks is accepted', blockRange !== undefined && blockRange.startIdx === 2 && blockRange.endIdx === 3 && JSON.stringify(blockRange.boundaryBlockIds) === '[7,8]', JSON.stringify(blockRange));
}

console.log(`\n${failures.length === 0 ? 'all DCP range tests passed' : `${failures.length} failure(s)`}`);
process.exit(failures.length === 0 ? 0 : 1);
