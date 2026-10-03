/** Focused guards for DCP's optional placeholder contract. */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testHome = mkdtempSync(join(tmpdir(), 'dsh-dcp-placeholders-'));
process.env.DSH_HOME = testHome;

const prompts = await import('../lib/dcp-prompts.js');
const placeholders = await import('../lib/dcp-block-placeholders.js');

const text = (value) => ({ type: 'text', text: value });
let scope;

try {
  const guidance = prompts.buildCompressedBlockGuidance([
    { blockId: 4, topic: 'Fourth topic' },
    { blockId: 2, topic: 'Second topic' },
    { blockId: 1, topic: 'First topic' },
    { blockId: 2, topic: 'Duplicate ignored' }
  ]);
  const promptContract = `${prompts.COMPRESS_RANGE}\n${guidance}`;
  assert.match(promptContract, /omit[\s\S]*absorb/i, 'runtime text must teach omission => absorption');
  assert.match(promptContract, /include[\s\S]*exactly once[\s\S]*preserve[\s\S]*verbatim/i,
    'runtime text must teach one marker => verbatim preservation');
  assert.doesNotMatch(promptContract, /required (?:block )?placeholder|exactly match the required set/i,
    'runtime text must not require every selected placeholder');
  assert.match(promptContract, /current surface order: 3 \(b4 — "Fourth topic"; b2 — "Second topic"; b1 — "First topic"\)/,
    'guidance must retain first-seen surface order, topics, and deduplication');
  assert.ok(guidance.indexOf('b4') < guidance.indexOf('b2') && guidance.indexOf('b2') < guidance.indexOf('b1'),
    'guidance must not numerically reorder block ids');

  for (const source of [
    'Keep this (because it matters).',
    'Use a (B-tree) index for lookup.'
  ]) {
    const result = placeholders.classifyAndExpandBlockPlaceholders(source);
    assert.equal(result.expandedSummary, source, `natural prose must survive unchanged: ${source}`);
  }

  const noisyTopic = `  Multi-line\n\"quoted\" \\ delimiter ${'😀'.repeat(140)}  `;
  const renderedTopic = placeholders.formatBlockTopic(noisyTopic);
  const wrapped = placeholders.wrapBlockSummary(7, 'WRAPPED BODY', noisyTopic);
  const wrapperLines = wrapped.split('\n');
  assert.equal(wrapperLines[0], placeholders.COMPRESSED_BLOCK_HEADER);
  assert.equal(wrapperLines[1], `Block b7 — Topic: ${renderedTopic}`);
  assert.equal(wrapperLines.at(-3), `End of ${renderedTopic} (b7) block`);
  assert.equal(wrapperLines.at(-1), '<dcp-message-id>b7</dcp-message-id>');
  const parsedTopic = JSON.parse(renderedTopic);
  assert.equal([...parsedTopic].length, placeholders.BLOCK_TOPIC_MAX_LENGTH,
    'display topics must be bounded by Unicode code points');
  assert.equal([...parsedTopic].at(-1), '…', 'oversized display topics must end with one ellipsis');
  assert.doesNotMatch(parsedTopic, /\uFFFD/, 'Unicode truncation must not split a surrogate pair');
  assert.equal(placeholders.restoreBlockSummary(wrapped), 'WRAPPED BODY',
    'a matched presentation wrapper must restore only its body');
  const mismatched = wrapped.replace('(b7) block', '(b8) block');
  const mismatchedRestored = placeholders.restoreBlockSummary(mismatched);
  assert.match(mismatchedRestored, /^Block b7 — Topic:/,
    'mismatched readable markers must be preserved rather than stripped');
  assert.match(mismatchedRestored, /End of .* \(b8\) block$/,
    'the mismatched end marker must remain visible for safe failure');
  const topicMismatch = wrapped.replace(`End of ${renderedTopic}`, 'End of "different topic"');
  assert.match(placeholders.restoreBlockSummary(topicMismatch), /^Block b7 — Topic:/,
    'mismatched topic labels must also remain visible for safe failure');
  const malformedWrapper = wrapped.replace(`\n\nEnd of ${renderedTopic} (b7) block`, '');
  assert.match(placeholders.restoreBlockSummary(malformedWrapper), /^Block b7 — Topic:/,
    'a missing end marker must not cause destructive top-marker stripping');
  const legacyWrapped = '[Compressed conversation section]\nLEGACY BODY\n\n<dcp-message-id>b9</dcp-message-id>';
  assert.equal(placeholders.restoreBlockSummary(legacyWrapped), 'LEGACY BODY',
    'legacy generic wrappers must remain restorable');

  const selected = [{
    blockId: 1,
    summary: placeholders.wrapBlockSummary(1, 'SAVED VERBATIM'),
    active: true
  }];
  const preserved = placeholders.classifyAndExpandBlockPlaceholders('left (b1) right', {
    selectedBlocks: selected,
    registry: selected
  });
  assert.equal(preserved.expandedSummary, 'left SAVED VERBATIM right');
  assert.deepEqual(preserved.childBlockIds, [1]);
  assert.deepEqual(preserved.preservedBlockIds, [1]);
  assert.deepEqual(preserved.absorbedBlockIds, []);

  const absorbed = placeholders.classifyAndExpandBlockPlaceholders('replacement only', {
    selectedBlocks: selected,
    registry: selected
  });
  assert.equal(absorbed.expandedSummary, 'replacement only');
  assert.deepEqual(absorbed.childBlockIds, [1]);
  assert.deepEqual(absorbed.preservedBlockIds, []);
  assert.deepEqual(absorbed.absorbedBlockIds, [1]);

  assert.throws(
    () => placeholders.classifyAndExpandBlockPlaceholders('{block_1}'),
    { message: 'Use canonical (bN) instead of {block_N}' }
  );

  for (const source of [
    '(b1\n)',
    '(b1\r\n)',
    '( b1)',
    '{block_1',
    '{ block_1}',
    '{block_1\n}'
  ]) {
    assert.throws(
      () => placeholders.classifyAndExpandBlockPlaceholders(source, {
        selectedBlocks: selected,
        registry: selected
      }),
      { message: `Malformed block placeholder ${JSON.stringify(source)}. Use canonical (bN).` },
      `marker-shaped malformed input must fail: ${JSON.stringify(source)}`
    );
  }

  const { Context } = await import('@deepseek-ai/cordis');
  const { Session, SessionId } = await import('@deepseek-ai/dsh-session');
  const llm = await import('@deepseek-ai/dsh-llm');
  const dcp = await import('../lib/dcp.js');

  const root = new Context();
  const tools = new Map();
  root.provide('tools', {
    register(definition) {
      tools.set(definition.name, definition);
      return () => {};
    }
  });
  root.provide('llm', llm);
  root.provide('tokenMeter', {
    estimateMessage: (message) => JSON.stringify(message?.content ?? message ?? '').length,
    measure: () => ({ nodes: [] })
  });
  scope = root.plugin(dcp, {
    manualMode: false,
    automaticStrategies: false,
    strategies: { deduplication: { enabled: false }, purgeErrors: { enabled: false } }
  });
  await new Promise((resolve) => setTimeout(resolve, 150));

  const tool = tools.get('compress');
  const engine = dcp.engineForTest();
  assert.ok(tool, 'compress tool must register');
  assert.ok(engine, 'DCP engine must mount');

  const session = Session.create(SessionId(`placeholder-contract-${process.pid}-${Date.now()}`));
  session.append('turn/start', { turn: 1 });
  const first = session.append('user/message', llm.createUserMessage({
    content: [text('FIRST')],
    source: { kind: 'user' }
  }), { surfaceOp: 'append' });
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    stream: [],
    message: llm.createAssistantMessage({
      content: [text('MIDDLE')],
      source: { kind: 'model', provider: 'guard', model: 'guard' }
    })
  }, { surfaceOp: 'append' });
  const last = session.append('user/message', llm.createUserMessage({
    content: [text('LAST')],
    source: { kind: 'user' }
  }), { surfaceOp: 'append' });

  const firstRef = engine.boundaryRefAtSeq(session, Number(first.seq));
  const lastRef = engine.boundaryRefAtSeq(session, Number(last.seq));
  assert.ok(firstRef && lastRef, 'batch boundaries must resolve');
  const beforeEvents = JSON.stringify(session.snapshotEvents());
  const beforeState = JSON.stringify(engine.blocksFor(session).toJSON());
  const malformed = '(b1\n)';

  await assert.rejects(
    tool.execute({
      topic: 'Placeholder preflight',
      content: [
        { startId: firstRef, endId: firstRef, summary: 'VALID-FIRST-ROW' },
        { startId: lastRef, endId: lastRef, summary: malformed }
      ]
    }, {
      callId: 'placeholder-contract-call',
      rootCallId: 'placeholder-contract-call',
      name: 'compress',
      token: Symbol('compress'),
      arguments: {},
      signal: new AbortController().signal,
      agent: { id: 'placeholder-contract-agent', session },
      deferContext() {},
      concludeTurn() {}
    }),
    { message: `Malformed block placeholder ${JSON.stringify(malformed)}. Use canonical (bN).` }
  );

  assert.equal(JSON.stringify(session.snapshotEvents()), beforeEvents,
    'a late malformed row must append no events');
  assert.equal(JSON.stringify(engine.blocksFor(session).toJSON()), beforeState,
    'a late malformed row must change no registry state, counters, ids, or permits');
} finally {
  if (scope !== undefined) await scope.dispose();
  rmSync(testHome, { recursive: true, force: true });
}

console.log('DCP placeholder contract guards passed');
