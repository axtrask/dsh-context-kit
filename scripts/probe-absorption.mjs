/**
 * Absorption probe: does a compression that covers an existing block send the
 * absorbed block's text TWICE?
 *
 * THE DEFECT THIS FILE MEASURES.
 *
 * A compression lands as a session REPLACEMENT: the span it shadows leaves the
 * surface and one summary node takes its place. A block the new range covers is
 * therefore replaced by the new summary, and the new summary has to carry the
 * old block's text forward - otherwise the earlier compression's content is lost.
 *
 * "Carried forward" is only half of the operation. The other half is that the
 * old block's OWN node must leave the surface with the rest of the span. When
 * the range planner treated a block at a range EDGE as a boundary the span stops
 * against instead of content it covers, the edge snapped off the block: the
 * block stayed on the surface while its text was also appended into the new
 * summary. The model then received the same text twice, and every further
 * compression multiplied the earlier facts - the observed shape was [2,2,1],
 * [4,4,2,1], [8,8,4,2,1].
 *
 * A SECOND PATH ran through the `compress.protectTags` / `protectUserMessages`
 * settings: a summary carries protected excerpts verbatim, and an absorbed block
 * node is itself a `user/message` whose text contains the block body, so the
 * protection pass copied it in while the placeholder pass also appended it. That
 * variant duplicates inside ONE message rather than across the request, which is
 * why every case below counts occurrences per message as well as per request.
 *
 * WHAT THIS PROBE ASSERTS, independently of the suite's own compress cases:
 *
 *   1. a chain of compressions, each absorbing the previous block: every tracked
 *      fact occurs in the derived conversation EXACTLY ONCE, not "at least once";
 *   2. no fact occurs twice inside ONE derived message;
 *   3. the number of `[Compressed conversation section]` nodes equals the number
 *      of ACTIVE blocks - no orphan node survives an absorption;
 *   4. an absorbed block's former node is gone from the surface;
 *   5. both summary styles: the `(bN)` placeholder written by the model, and the
 *      placeholder omitted so the engine appends the text itself;
 *   6. the same, with protectTags and protectUserMessages ON, and the absorbed
 *      block placed INTERIOR to the new range (the protect path's trigger);
 *   7. a range that does not touch a block neither absorbs nor deactivates it;
 *   8. a predecessor sitting at the END edge of the new range is carried once and
 *      its node is extinguished, exactly as at the start edge;
 *   9. reloading the persisted block state mid-chain, as a restart does, changes
 *      nothing about the request;
 *  10. the size of the request, printed before and after the chain, so the cost
 *      of carrying text forward is visible rather than asserted away.
 *
 * The subject of every assertion is `session.deriveMessages()` - the array the
 * harness sends to a provider. Nothing here calls `rewriteOutgoingMessages`:
 * that function is upstream's algorithm kept runnable for comparison and is not
 * on the live path, so asserting on it would prove nothing about a request.
 *
 * Run:  node scripts/probe-absorption.mjs
 *
 * @module dsh-context-kit/scripts/probe-absorption
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const kitRoot = join(here, '..');
const scratchHome = join(kitRoot, '.probe-state');

// THE STATE DIRECTORY IS RESOLVED ON EVERY CALL, so this has to be in place
// before the plugin is mounted. Without it the fixture sessions below would
// write their block state into the live `~/.dsh/context-kit/dcp-state` - this
// probe is NOT in the suite's sandboxed group, so nothing else would set it.
process.env.DSH_HOME = scratchHome;

const failures = [];
/** @param name - check label. @param ok - result. @param detail - evidence. */
function check(name, ok, detail = '') {
  console.log(`${ok ? '[ok]  ' : '[FAIL]'} ${name}${detail.length > 0 ? ` - ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

/** A measurement, not an assertion. Printed so the numbers are in the log. */
function note(text) {
  console.log(`      ${text}`);
}

const { Context } = await import('@deepseek-ai/cordis');
const { Session, SessionId } = await import('@deepseek-ai/dsh-session');
const llm = await import('@deepseek-ai/dsh-llm');
const dcp = await import(pathToFileURL(join(kitRoot, 'lib', 'dcp.js')).href);

const { createUserMessage, createAssistantMessage, createToolResultMessage, ToolCallId } = llm;

/** The header a stored summary carries. One per block NODE, never one per copy. */
const HEADER = '[Compressed conversation section]';

/* ------------------------------------------------------------------ mounting */

/**
 * Mount one isolated plugin instance and hand back its registered tools.
 *
 * Every case gets its own mount AND its own session id: block state is persisted
 * per session id, so a fixed fixture id would make a second run read the first
 * run's compressions and report them as its own.
 *
 * The mount is awaited because cordis applies a plugin asynchronously; reading
 * the tool map immediately after `root.plugin(...)` sees nothing at all.
 *
 * @param config - the plugin row configuration.
 * @returns the tools by name, with the mounted engine on a non-enumerable key.
 */
async function mountTools(config) {
  const root = new Context();
  const registered = new Map();
  root.provide('logger', { info: () => {}, debug: () => {}, error: () => {}, warn: () => {} });
  root.provide('tools', {
    register: (definition) => {
      registered.set(definition.name, definition);
      return () => {};
    }
  });
  root.provide('llm', llm);
  root.provide('tokenMeter', {
    estimateMessage: (message) => JSON.stringify(message?.content ?? message ?? '').length,
    measure: () => ({ nodes: [] })
  });
  root.plugin(dcp, config ?? {});
  await new Promise((resolve) => setTimeout(resolve, 250));
  Object.defineProperty(registered, '__engine', { value: dcp.engineForTest(), enumerable: false });
  return registered;
}

/** The engine of a mounted instance, captured at mount time. */
const engineOf = (tools) => tools.__engine;

/** Distinct session ids, so persisted state never crosses cases or runs. */
const runTag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
let caseCounter = 0;
const nextSessionId = (label) => `probe-absorption-${label}-${runTag}-${(caseCounter += 1)}`;

/* ----------------------------------------------------------------- fixtures */

/**
 * The transcript: a user instruction, then balanced tool exchanges, then a tail.
 *
 * Every text is UNIQUE and TERMINATED (`...-END`), so no tracked fact is a
 * substring of another and an occurrence count is unambiguous. Exchange
 * arguments differ per step on purpose: identical arguments would let the
 * plugin's own deduplication strategy replace a result with a placeholder
 * before the compression is planned, which is correct behaviour and a fixture
 * that tests the wrong thing.
 *
 * @param label - run-unique fixture label, used inside every text.
 * @param steps - how many balanced exchanges to append.
 * @param options - `instruction`, `outputHooks` (index -> extra output text).
 * @returns the real session.
 */
function fixture(label, steps, options = {}) {
  const session = Session.create(SessionId(nextSessionId(label)));
  session.append('turn/start', { turn: 1 });
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: options.instruction ?? `INSTRUCTION|${label}|END` }],
    source: { kind: 'user' }
  }), { surfaceOp: 'append' });
  for (let index = 1; index <= steps; index += 1) {
    const step = String(index).padStart(2, '0');
    const callId = `${label}-c${step}`;
    const extra = options.outputHooks?.(index) ?? '';
    session.append('assistant/message', {
      turn: 1,
      step: index,
      stream: [],
      message: createAssistantMessage({
        content: [
          { type: 'text', text: `BODY|${label}|${step}|END` },
          {
            type: 'tool-call',
            id: ToolCallId(callId),
            name: 'read',
            arguments: JSON.stringify({ path: `${label}-step-${step}.js`, note: `${label}-${step}` })
          }
        ],
        source: { kind: 'model', provider: 'probe', model: 'probe' }
      })
    }, { surfaceOp: 'append' });
    session.append('tool/result', {
      turn: 1,
      step: index,
      message: createToolResultMessage({
        callId: ToolCallId(callId),
        content: [{ type: 'text', text: `OUTPUT|${label}|${step}|END${extra}` }],
        // Explicit, not omitted: an `undefined` leaf is not JSON-serializable
        // and `Session.append` refuses the whole event for it.
        isError: false
      })
    }, { surfaceOp: 'append' });
  }
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `TAIL|${label}|END` }],
    source: { kind: 'user' }
  }), { surfaceOp: 'append' });
  return session;
}

/** An execution context shaped like the harness's ToolRunContext. */
const execFor = (session) => ({
  callId: 'call-compress',
  rootCallId: 'call-compress',
  name: 'compress',
  token: Symbol('token'),
  arguments: {},
  signal: new AbortController().signal,
  agent: { id: 'session-probe', session },
  deferContext: () => {},
  concludeTurn: () => {}
});

/* ------------------------------------------------------------- observation */

/** WHAT THE MODEL RECEIVES. The only honest subject for this probe. */
const modelMessages = (session) => session.deriveMessages();

/** Every text block of every derived message, joined. */
const modelText = (session) => modelMessages(session)
  .flatMap((message) => message.content ?? [])
  .filter((block) => block?.type === 'text')
  .map((block) => block.text)
  .join('\n');

/** Every derived message's text, separately - "twice in one message" needs this. */
const modelTexts = (session) => modelMessages(session)
  .map((message) => (message.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n'));

/** Occurrences of a literal substring. */
const countOf = (haystack, needle) => haystack.split(needle).length - 1;

/**
 * How many derived messages are a compressed-block NODE.
 *
 * A message that merely MENTIONS the header - the protection pass copying a
 * block's text into a summary, say - is not a node, and counting occurrences in
 * the joined text cannot tell the two apart. This can.
 */
const summaryNodes = (session) => modelTexts(session)
  .filter((text) => text.trimStart().startsWith(HEADER)).length;

/**
 * Assert the request's block NODES match the live block registry.
 *
 * Two separate questions on purpose: how many messages are block nodes, and how
 * many headers the request contains at all. A copied block body inflates the
 * second without touching the first, which is how the protection path's
 * duplication presented.
 *
 * @param label - case label.
 * @param session - the session to inspect.
 * @param engine - the mounted engine, for its block registry.
 */
function checkSummaryNodes(label, session, engine) {
  const active = engine.blocks.active();
  const nodes = summaryNodes(session);
  const headers = countOf(modelText(session), HEADER);
  check(`${label}: one summary NODE per active block`, nodes === active.length,
    `nodes=${nodes} active=${active.length} (${active.map((entry) => entry.blockId).join(',')})`);
  check(`${label}: no extra copied header anywhere in the request`, headers === active.length,
    `headers=${headers} active=${active.length}`);
}

/** The surface seqs as plain numbers. */
const surfaceOf = (session) => session.surface.nodes.map(Number);

/** How many chars and messages the request costs right now. */
const weightOf = (session) => ({
  chars: JSON.stringify(modelMessages(session)).length,
  messages: modelMessages(session).length
});

/**
 * Occurrence counts of every tracked fact, in order.
 * @param text - the derived conversation text.
 * @param facts - the literals that must survive.
 * @returns the counts, one per fact.
 */
const factCounts = (text, facts) => facts.map((fact) => countOf(text, fact));

/**
 * Facts appearing more than once inside ONE derived message.
 *
 * A request-wide count can hide this: two copies in a single summary message
 * and none elsewhere still reads as "the fact is present" to a global check.
 *
 * @param session - the session to inspect.
 * @param facts - the literals to look for.
 * @returns a description per offending fact, empty when the request is clean.
 */
function duplicatedInOneMessage(session, facts) {
  const offenders = [];
  for (const [index, text] of modelTexts(session).entries()) {
    for (const fact of facts) {
      const seen = countOf(text, fact);
      if (seen > 1) offenders.push(`${fact} x${seen} in message ${index}`);
    }
  }
  return offenders;
}

/* ---------------------------------------------------------------- selection */

/**
 * The first span the engine resolves for a request that STARTS on `startSeq`.
 *
 * Ranges cannot be guessed: the balance fold snaps both edges inward onto
 * complete exchanges, so a hand-picked `1..4` tests the fixture rather than the
 * product. This asks the product's own resolver, so the numbers passed to the
 * tool are numbers the tool resolves the same way.
 *
 * `snapped` is the interesting field, not an implementation detail. The caller
 * names `startSeq`; when the engine answers with a span that begins at a LATER
 * surface position, it has moved the edge off the node the caller named - which
 * is exactly the edge rule under test here. The span is still handed to the tool
 * as-is, so the case measures what the product DOES with that request instead of
 * abandoning the request when the answer is inconvenient.
 *
 * @param engine - the mounted engine.
 * @param session - the session to inspect.
 * @param startSeq - the surface seq the caller names as the start.
 * @param minimum - how many nodes the span must shadow.
 * @returns `{ start, end, startIdx, endIdx, nodes, snapped }`, or `undefined`.
 */
function rangeFrom(engine, session, startSeq, minimum) {
  const surface = surfaceOf(session);
  const index = surface.findIndex((seq) => Number(seq) === Number(startSeq));
  if (index === -1) return undefined;
  engine.blocksFor(session);
  for (let to = index; to < surface.length; to += 1) {
    const range = engine.balancedRange(session, surface[index], surface[to]);
    if (range === undefined || range.startIdx < index) continue;
    const nodes = range.endIdx - range.startIdx + 1;
    if (nodes < minimum) continue;
    return {
      start: Number(startSeq),
      end: Number(range.end),
      startIdx: range.startIdx,
      endIdx: range.endIdx,
      nodes,
      snapped: range.startIdx !== index
    };
  }
  return undefined;
}

/**
 * The first span of at least `minimum` nodes that lies entirely at or after
 * surface position `afterIndex` - how a case asks for a range that must NOT
 * touch a block sitting before that position.
 *
 * @param engine - the mounted engine.
 * @param session - the session to inspect.
 * @param afterIndex - the first surface position the span may use.
 * @param minimum - how many nodes the span must shadow.
 * @returns the same shape as {@link rangeFrom}, or `undefined`.
 */
function rangeAfter(engine, session, afterIndex, minimum) {
  const surface = surfaceOf(session);
  engine.blocksFor(session);
  for (let index = Math.max(0, afterIndex); index < surface.length; index += 1) {
    for (let to = index; to < surface.length; to += 1) {
      const range = engine.balancedRange(session, surface[index], surface[to]);
      if (range === undefined || range.startIdx !== index) continue;
      const nodes = range.endIdx - range.startIdx + 1;
      if (nodes < minimum) continue;
      return {
        start: Number(range.start),
        end: Number(range.end),
        startIdx: range.startIdx,
        endIdx: range.endIdx,
        nodes
      };
    }
  }
  return undefined;
}

function rangeEntry(engine, session, range, summary) {
  return {
    startId: engine.boundaryRefAtSeq(session, range.start),
    endId: engine.boundaryRefAtSeq(session, range.end),
    summary
  };
}

/* ------------------------------------------------------------------ cases */

/** The block state file the plugin persists for one session id. */
const statePathOf = (session) => join(scratchHome, 'context-kit', 'dcp-state', `${String(session.id)}.json`);

/**
 * Shared body of the two chain cases: N compressions, each one starting ON the
 * previous block's own node, so every pass absorbs its predecessor.
 *
 * @param label - case label, used in every check name.
 * @param options - `tag`, `passes`, `steps`, `placeholders`, `config`, `reloadAt`.
 */
async function chainCase(label, options) {
  let tools = await mountTools(options.config);
  const engine = () => engineOf(tools);
  const session = fixture(options.tag, options.steps ?? 8);
  const run = (args) => tools.get('compress').execute(args, execFor(session));
  const facts = [];
  const start = weightOf(session);
  note(`${label}: uncompressed request ${start.chars} chars over ${start.messages} messages`);
  let previous;
  let reloaded = false;

  for (let pass = 1; pass <= options.passes; pass += 1) {
    const surface = surfaceOf(session);
    const startSeq = previous === undefined ? surface[0] : Number(previous.nodeSeq);
    const range = rangeFrom(engine(), session, startSeq, 3);
    if (range === undefined) {
      check(`${label}: pass ${pass} finds a compressible range`, false, `surface ${JSON.stringify(surface)}`);
      return;
    }
    const fact = `FACT|${options.tag}|P${String(pass).padStart(2, '0')}|END`;
    facts.push(fact);
    const placed = options.placeholders === true && previous !== undefined;
    const summary = placed ? `${fact}\n\n(b${previous.blockId})` : fact;
    if (range.snapped) {
      note(`${label}: pass ${pass} named seq ${range.start} as the start and the engine began at `
        + `position ${range.startIdx} instead - span ${JSON.stringify(surface.slice(range.startIdx, range.endIdx + 1))}`);
    } else {
      note(`${label}: pass ${pass} names seq ${range.start} as the start and the engine keeps it - `
        + `span ${JSON.stringify(surface.slice(range.startIdx, range.endIdx + 1))}`);
    }
    const value = await run({
      topic: `${label} pass ${pass}`,
      content: [rangeEntry(engine(), session, range, summary)]
    });
    check(`${label}: pass ${pass} lands`, value.compressed === true,
      value.reason ?? `range ${range.start}..${range.end} (${range.nodes} nodes)`);
    if (value.compressed !== true) return;
    const block = value.blocks[0];

    const text = modelText(session);
    const counts = factCounts(text, facts);
    const weight = weightOf(session);
    note(`${label}: pass ${pass} block b${block.blockId} range ${block.coverage.start}..${block.coverage.end} `
      + `shadowed=${JSON.stringify(block.shadowedSeqs)} counts=${JSON.stringify(counts)} `
      + `${weight.chars} chars / ${weight.messages} messages`);

    check(`${label}: pass ${pass} sends every tracked fact exactly once`,
      counts.every((count) => count === 1), `counts=${JSON.stringify(counts)} facts=${JSON.stringify(facts)}`);
    const insideOne = duplicatedInOneMessage(session, facts);
    check(`${label}: pass ${pass} puts no fact twice inside one message`,
      insideOne.length === 0, insideOne.join('; '));
    checkSummaryNodes(`${label}: pass ${pass}`, session, engine());

    if (previous !== undefined) {
      check(`${label}: pass ${pass} absorbed the predecessor's node`,
        block.shadowedSeqs.includes(previous.nodeSeq) && !surfaceOf(session).includes(previous.nodeSeq),
        `nodeSeq=${previous.nodeSeq} shadowed=${JSON.stringify(block.shadowedSeqs)} surface=${JSON.stringify(surfaceOf(session))}`);
      check(`${label}: pass ${pass} deactivated the predecessor`,
        engine().blocks.get(previous.blockId)?.active === false,
        `b${previous.blockId} active=${engine().blocks.get(previous.blockId)?.active}`);
      check(`${label}: pass ${pass} carries the predecessor's text`,
        text.includes(previous.fact) && countOf(text, previous.fact) === 1,
        `${previous.fact} x${countOf(text, previous.fact)}`);
      check(`${label}: pass ${pass} records the predecessor as consumed`,
        (block.consumedBlockIds ?? []).includes(String(previous.blockId)),
        `consumed=${JSON.stringify(block.consumedBlockIds)} appended=${JSON.stringify(block.appendedBlockIds)}`);
      if (options.placeholders === true) {
        check(`${label}: pass ${pass} appends nothing when the model placed the placeholder`,
          (block.appendedBlockIds ?? []).length === 0, JSON.stringify(block.appendedBlockIds));
      } else {
        check(`${label}: pass ${pass} injects the omitted boundary instead of treating it as an omitted inner block`,
          JSON.stringify(block.appendedBlockIds ?? []) === '[]',
          JSON.stringify(block.appendedBlockIds));
      }
    }

    if (options.reloadAt === pass && reloaded === false) {
      reloaded = true;
      const before = modelText(session);
      const path = statePathOf(session);
      const raw = existsSync(path) ? readFileSync(path, 'utf8') : '';
      check(`${label}: pass ${pass} wrote its block state to disk`, raw.length > 0, path);
      tools = await mountTools(options.config);
      const reloadedState = engine().blocksFor(session);
      check(`${label}: a fresh mount reloads one active block from disk`,
        reloadedState.active().length === 1 && String(reloadedState.active()[0].blockId) === String(block.blockId),
        JSON.stringify(reloadedState.active().map((entry) => entry.blockId)));
      check(`${label}: pass ${pass} reloading the persisted state does not change the request`,
        modelText(session) === before, `${before.length} vs ${modelText(session).length} chars`);
      check(`${label}: pass ${pass} reloaded state still renders one summary node`,
        countOf(modelText(session), HEADER) === 1, `headers=${countOf(modelText(session), HEADER)}`);
    }

    previous = { blockId: block.blockId, nodeSeq: Number(engine().blocks.get(block.blockId)?.nodeSeq), fact };
  }

  const end = weightOf(session);
  note(`${label}: compressed request ${end.chars} chars over ${end.messages} messages`);
  check(`${label}: compression shrinks the request`, end.chars < start.chars, `${start.chars} -> ${end.chars}`);
  checkSummaryNodes(`${label}: final`, session, engine());
  return { session, facts, tools, start, end };
}

console.log('\n=== case 1/2: a chain of absorptions, predecessor omitted then placed ===');

console.log('\n--- case 1: predecessor with no placeholder (the engine appends it) ---');
const chainOmitted = await chainCase('chain-omit', { tag: 'CHAINOMIT', passes: 4, steps: 8, reloadAt: 2 });

console.log('\n--- case 2: predecessor named by a (bN) placeholder written into the summary ---');
const chainPlaced = await chainCase('chain-place', { tag: 'CHAINPLACE', passes: 4, steps: 8, placeholders: true });

console.log('\n--- case 2b: the weight of carrying text forward ---');
{
  // The numbers, not an assertion about them. A chain re-states every earlier
  // summary inside the newest one, so the request keeps paying for the carried
  // text by design; what must NOT happen is the same text arriving twice.
  if (chainPlaced !== undefined) {
    const carried = chainPlaced.facts.length;
    note(`chain-place: ${carried} chain facts, all present exactly once`);
    note(`chain-place: request ${chainPlaced.start.chars} chars before the chain, `
      + `${chainPlaced.end.chars} after ${carried} compressions`);
    const saved = chainPlaced.start.chars - chainPlaced.end.chars;
    note(`chain-place: ${saved} chars no longer sent `
      + `(${Math.round((saved / chainPlaced.start.chars) * 100)}% of the original request)`);
    if (chainOmitted !== undefined) {
      note(`chain-omit: ${chainOmitted.start.chars} chars before, ${chainOmitted.end.chars} after `
        + `- the appended predecessor costs the same text the placeholder form pays for inline`);
    }
    check('the carry-forward cost is smaller than the text it replaced',
      chainPlaced.end.chars < chainPlaced.start.chars,
      `${chainPlaced.start.chars} -> ${chainPlaced.end.chars}`);
  }
}

console.log('\n--- case 3: an INTERIOR predecessor with protectTags and protectUserMessages ON ---');
{
  const tag = 'INTERIOR';
  const config = { compress: { protectTags: true, protectUserMessages: true } };
  const tools = await mountTools(config);
  const engine = engineOf(tools);
  // The `<protect>` excerpt sits in a tool output. Upstream protects tags only
  // from selected user messages, so this text must not be carried accidentally.
  const session = fixture(tag, 6, { outputHooks: (index) => (index === 1 ? `\n<protect>SECRET|${tag}|END</protect>` : '') });
  const run = (args) => tools.get('compress').execute(args, execFor(session));
  const facts = [`FACT|${tag}|P01|END`, `FACT|${tag}|P02|END`, `INSTRUCTION|${tag}|END`];

  // Pass 1 starts at surface position 1, so the instruction stays in front of
  // the block and pass 2 can put the block strictly INSIDE its span.
  const surface = surfaceOf(session);
  const first = rangeFrom(engine, session, surface[1], 4);
  check('interior: pass 1 finds a span after the instruction', first !== undefined,
    first === undefined ? `surface ${JSON.stringify(surface)}` : `${first.start}..${first.end} (${first.nodes} nodes)`);
  if (first !== undefined) {
    const value = await run({
      topic: 'interior pass 1',
      content: [rangeEntry(engine, session, first, facts[0])]
    });
    check('interior: pass 1 lands', value.compressed === true, value.reason ?? '');
    const blockId = value.blocks?.[0]?.blockId;
    const blockSeq = Number(engine.blocks.get(blockId)?.nodeSeq);
    const live = surfaceOf(session);
    const blockIndex = live.indexOf(blockSeq);
    check('interior: the block really sits at an interior position with fresh material before it',
      blockIndex > 0 && blockIndex < live.length - 1, `index=${blockIndex} of ${live.length} surface=${JSON.stringify(live)}`);
    check('interior: a protect tag inside tool output is not treated as protected prompt text',
      countOf(modelText(session), `SECRET|${tag}|END`) === 0, `x${countOf(modelText(session), `SECRET|${tag}|END`)}`);

    // Pass 2 covers the instruction, the block (INTERIOR, not at an edge) and
    // two fresh exchanges. The protection pass and the placeholder pass both
    // look at every shadowed node here - which is where the two copies came from.
    const second = rangeFrom(engine, session, live[0], blockIndex + 3);
    check('interior: pass 2 finds a span that contains the block strictly inside it',
      second !== undefined && second.startIdx === 0 && second.endIdx > blockIndex,
      second === undefined ? 'none' : `${second.start}..${second.end} startIdx=${second.startIdx} endIdx=${second.endIdx} blockIndex=${blockIndex}`);
    if (second !== undefined) {
      const value2 = await run({
        topic: 'interior pass 2',
        content: [rangeEntry(engine, session, second, facts[1])]
      });
      check('interior: pass 2 lands', value2.compressed === true, value2.reason ?? '');
      const text = modelText(session);
      const counts = factCounts(text, facts);
      note(`interior: counts=${JSON.stringify(counts)} for ${JSON.stringify(facts)}`);
      check('interior: every tracked fact survives exactly once',
        counts.every((count) => count === 1), JSON.stringify(counts));
      const insideOne = duplicatedInOneMessage(session, facts);
      check('interior: no fact appears twice inside one message', insideOne.length === 0, insideOne.join('; '));
      check('interior: the absorbed block node is gone from the surface',
        !surfaceOf(session).includes(blockSeq), JSON.stringify(surfaceOf(session)));
      check('interior: the absorbed block is deactivated',
        engine.blocks.get(blockId)?.active === false, `active=${engine.blocks.get(blockId)?.active}`);
      checkSummaryNodes('interior: after the interior absorption', session, engine);
      check('interior: the instruction is still carried verbatim exactly once',
        countOf(text, `INSTRUCTION|${tag}|END`) === 1, `x${countOf(text, `INSTRUCTION|${tag}|END`)}`);
      // The protection pass reads every shadowed node as text, and an absorbed
      // block node is a user message: if it is not excluded, the block's whole
      // body - header included - lands in the protected-user section while the
      // placeholder pass appends it as well.
      const protectAt = text.indexOf('The following user messages were sent in this conversation verbatim:');
      const nextSection = text.indexOf('The following previously compressed summaries', protectAt + 1);
      const protectSection = protectAt === -1 ? '' : text.slice(protectAt, nextSection === -1 ? undefined : nextSection);
      check('interior: the protected-user section holds no compressed block node',
        protectSection.length > 0 && !protectSection.includes(HEADER) && !protectSection.includes(facts[0]),
        `section ${JSON.stringify(protectSection.trim().slice(0, 140))}`);
    }
  }
}

console.log('\n--- case 4: a range that does not touch a block leaves it alone ---');
{
  const tag = 'OWNED';
  const tools = await mountTools({});
  const engine = engineOf(tools);
  const session = fixture(tag, 8);
  const run = (args) => tools.get('compress').execute(args, execFor(session));
  const first = rangeFrom(engine, session, surfaceOf(session)[0], 3);
  const value = await run({
    topic: 'owned pass 1',
    content: [rangeEntry(engine, session, first, `FACT|${tag}|P01|END`)]
  });
  check('owned: pass 1 lands', value.compressed === true, value.reason ?? '');
  const firstBlockId = value.blocks?.[0]?.blockId;
  const firstNode = Number(engine.blocks.get(firstBlockId)?.nodeSeq);
  const live = surfaceOf(session);
  const blockIndex = live.indexOf(firstNode);
  note(`owned: block b${firstBlockId} at surface index ${blockIndex} of ${live.length} - surface ${JSON.stringify(live)}`);

  // A range strictly AFTER the block. It names no block seq and covers no
  // shadowed span of the first block, so nothing about that block is its work.
  const second = rangeAfter(engine, session, blockIndex + 1, 3);
  check('owned: pass 2 finds a span after the block', second !== undefined,
    second === undefined ? `surface ${JSON.stringify(live)}` : `${second.start}..${second.end} (${second.nodes} nodes)`);
  if (second !== undefined) {
    const value2 = await run({
      topic: 'owned pass 2',
      content: [rangeEntry(engine, session, second, `FACT|${tag}|P02|END`)]
    });
    check('owned: pass 2 lands', value2.compressed === true, value2.reason ?? '');
    const block2 = value2.blocks?.[0] ?? {};
    check('owned: pass 2 does not shadow the untouched block node',
      !(block2.shadowedSeqs ?? []).includes(firstNode), JSON.stringify(block2.shadowedSeqs));
    check('owned: pass 2 does not absorb the untouched block',
      !(block2.consumedBlockIds ?? []).includes(String(firstBlockId)) && !(block2.appendedBlockIds ?? []).includes(String(firstBlockId)),
      `consumed=${JSON.stringify(block2.consumedBlockIds)} appended=${JSON.stringify(block2.appendedBlockIds)}`);
    check('owned: the untouched block is still active', engine.blocks.get(firstBlockId)?.active === true,
      `active=${engine.blocks.get(firstBlockId)?.active}`);
    check('owned: the untouched block node is still on the surface', surfaceOf(session).includes(firstNode),
      JSON.stringify(surfaceOf(session)));
    const facts = [`FACT|${tag}|P01|END`, `FACT|${tag}|P02|END`];
    const text = modelText(session);
    const counts = factCounts(text, facts);
    note(`owned: counts=${JSON.stringify(counts)} blocks=${engine.blocks.active().length}`);
    check('owned: both blocks are sent exactly once each',
      counts.every((count) => count === 1), JSON.stringify(counts));
    check('owned: no fact appears twice inside one message',
      duplicatedInOneMessage(session, facts).length === 0, duplicatedInOneMessage(session, facts).join('; '));
    checkSummaryNodes('owned: after the independent range', session, engine);
  }
}

console.log('\n--- case 5: a predecessor at the END edge of the new range ---');
{
  const tag = 'TAILEDGE';
  const tools = await mountTools({});
  const engine = engineOf(tools);
  const session = fixture(tag, 6);
  const run = (args) => tools.get('compress').execute(args, execFor(session));
  const facts = [`FACT|${tag}|P01|END`, `FACT|${tag}|P02|END`, `TAIL|${tag}|END`];

  // Pass 1 compresses a MIDDLE span, so fresh material stays in front of the
  // block and the next range can end ON the block instead of starting on it.
  const live = surfaceOf(session);
  const first = rangeFrom(engine, session, live[3], 4);
  check('tail-edge: pass 1 finds a middle span', first !== undefined,
    first === undefined ? `surface ${JSON.stringify(live)}` : `${first.start}..${first.end} (${first.nodes} nodes)`);
  if (first !== undefined) {
    const value = await run({
      topic: 'tail-edge pass 1',
      content: [rangeEntry(engine, session, first, facts[0])]
    });
    check('tail-edge: pass 1 lands', value.compressed === true, value.reason ?? '');
    const blockId = value.blocks?.[0]?.blockId;
    const blockSeq = Number(engine.blocks.get(blockId)?.nodeSeq);
    const after = surfaceOf(session);
    const blockIndex = after.indexOf(blockSeq);
    note(`tail-edge: block b${blockId} at surface index ${blockIndex} - surface ${JSON.stringify(after)}`);
    check('tail-edge: the block has fresh material in front of it', blockIndex > 0,
      `index=${blockIndex}`);

    // The span ENDS on the block: the instruction and exchange 1 are fresh,
    // the block is its last node.
    const endRange = engine.balancedRange(session, after[0], blockSeq);
    check('tail-edge: the end-anchored span resolves with the block inside it',
      endRange !== undefined && endRange.startIdx === 0 && endRange.endIdx === blockIndex,
      endRange === undefined ? 'unresolved' : `${endRange.start}..${endRange.end} (${endRange.startIdx}..${endRange.endIdx})`);
    if (endRange !== undefined) {
      const value2 = await run({
        topic: 'tail-edge pass 2',
        content: [rangeEntry(engine, session, endRange, facts[1])]
      });
      check('tail-edge: pass 2 lands', value2.compressed === true, value2.reason ?? '');
      const text = modelText(session);
      const counts = factCounts(text, facts);
      note(`tail-edge: counts=${JSON.stringify(counts)} for ${JSON.stringify(facts)}`);
      check('tail-edge: the end-edge predecessor is carried exactly once',
        counts.every((count) => count === 1), JSON.stringify(counts));
      check('tail-edge: no fact appears twice inside one message',
        duplicatedInOneMessage(session, facts).length === 0, duplicatedInOneMessage(session, facts).join('; '));
      check('tail-edge: the end-edge predecessor node is extinguished',
        !surfaceOf(session).includes(blockSeq), JSON.stringify(surfaceOf(session)));
      check('tail-edge: the end-edge predecessor is deactivated',
        engine.blocks.get(blockId)?.active === false, `active=${engine.blocks.get(blockId)?.active}`);
      checkSummaryNodes('tail-edge: after the end-edge absorption', session, engine);
      check('tail-edge: the untouched tail turn is still there exactly once',
        countOf(text, `TAIL|${tag}|END`) === 1, `x${countOf(text, `TAIL|${tag}|END`)}`);
    }
  }
}

/* ----------------------------------------------------------------- summary */

const total = failures.length;
console.log(`\nprobe-absorption: ${total === 0 ? 'every check passed' : `${total} check(s) failed`}`);
if (total > 0) {
  console.log('FAILURES:');
  for (const name of failures) console.log(`  - ${name}`);
  process.exitCode = 1;
}
