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
  const promptContract = `${prompts.COMPRESS_RANGE}\n${prompts.buildCompressedBlockGuidance([1, 2])}`;
  assert.match(promptContract, /omit[\s\S]*absorb/i, 'runtime text must teach omission => absorption');
  assert.match(promptContract, /include[\s\S]*exactly once[\s\S]*preserve[\s\S]*verbatim/i,
    'runtime text must teach one marker => verbatim preservation');
  assert.doesNotMatch(promptContract, /required (?:block )?placeholder|exactly match the required set/i,
    'runtime text must not require every selected placeholder');

  for (const source of [
    'Keep this (because it matters).',
    'Use a (B-tree) index for lookup.'
  ]) {
    const result = placeholders.classifyAndExpandBlockPlaceholders(source);
    assert.equal(result.expandedSummary, source, `natural prose must survive unchanged: ${source}`);
  }

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
