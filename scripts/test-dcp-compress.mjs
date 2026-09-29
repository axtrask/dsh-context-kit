/** Production-boundary tests for the DSH DCP compression contract. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testHome = mkdtempSync(join(tmpdir(), 'dsh-dcp-compress-'));
process.env.DSH_HOME = testHome;

const { Context } = await import('@deepseek-ai/cordis');
const { Session, SessionId } = await import('@deepseek-ai/dsh-session');
const llm = await import('@deepseek-ai/dsh-llm');
const dcp = await import('../lib/dcp.js');
const { DcpBlockState } = await import('../lib/dcp-blocks.js');
const placeholders = await import('../lib/dcp-block-placeholders.js');

const failures = [];
const scopes = [];
let sessionCounter = 0;

function check(name, ok, detail = '') {
  console.log(`${ok ? '[ok]  ' : '[FAIL]'} ${name}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const text = (value) => ({ type: 'text', text: value });
const nextSessionId = () => SessionId(`compress-${process.pid}-${Date.now()}-${++sessionCounter}`);
const modelText = (session) => JSON.stringify(session.deriveMessages());
const countOf = (value, needle) => value.split(needle).length - 1;

async function mount(config = {}) {
  const root = new Context();
  const tools = new Map();
  root.provide('tools', { register(definition) { tools.set(definition.name, definition); return () => {}; } });
  root.provide('llm', llm);
  root.provide('tokenMeter', {
    estimateMessage: (message) => JSON.stringify(message?.content ?? message ?? '').length,
    measure: () => ({ nodes: [] })
  });
  const scope = root.plugin(dcp, {
    manualMode: false,
    automaticStrategies: false,
    strategies: { deduplication: { enabled: false }, purgeErrors: { enabled: false } },
    ...config
  });
  scopes.push(scope);
  await new Promise((resolve) => setTimeout(resolve, 150));
  return { tool: tools.get('compress'), engine: dcp.engineForTest() };
}

function appendUser(session, value, source = { kind: 'user' }) {
  return session.append('user/message', llm.createUserMessage({ content: [text(value)], source }), { surfaceOp: 'append' });
}

function appendAssistant(session, calls, body) {
  return session.append('assistant/message', {
    turn: 1,
    step: 1,
    stream: [],
    message: llm.createAssistantMessage({
      content: [
        ...(body === undefined ? [] : [text(body)]),
        ...calls.map((call) => ({
          type: 'tool-call',
          id: llm.ToolCallId(call.id),
          name: call.name,
          arguments: JSON.stringify(call.args ?? {})
        }))
      ],
      source: { kind: 'model', provider: 'probe', model: 'probe' }
    })
  }, { surfaceOp: 'append' });
}

function appendResult(session, call, output) {
  return session.append('tool/result', {
    turn: 1,
    step: 1,
    message: llm.createToolResultMessage({
      callId: llm.ToolCallId(call.id),
      content: [text(output)],
      isError: false
    })
  }, { surfaceOp: 'append' });
}

function fixture(options = {}) {
  const session = Session.create(nextSessionId());
  session.append('turn/start', { turn: 1 });
  const system = options.system === false ? undefined : session.append('system/message', {
    message: llm.createSystemMessage('SYSTEM-ONLY', 'fixture')
  }, { surfaceOp: 'append' });
  const user = appendUser(session, options.user ?? 'USER-INSTRUCTION');
  const calls = options.calls ?? [{ id: 'call-1', name: 'read', args: { filePath: 'a.js' } }];
  const assistant = appendAssistant(session, calls, options.assistant);
  const outputs = options.outputs ?? calls.map((call, index) => [call, `OUTPUT-${index + 1}`]);
  const results = outputs.map(([call, output]) => appendResult(session, call, output));
  const tail = options.tail === false ? undefined : appendUser(session, options.tail ?? 'TAIL-QUESTION');
  return { session, system, user, assistant, calls, results, tail };
}

function execFor(session) {
  return {
    callId: 'compress-call',
    rootCallId: 'compress-call',
    name: 'compress',
    token: Symbol('compress'),
    arguments: {},
    signal: new AbortController().signal,
    agent: { id: 'test-agent', session },
    deferContext() {},
    concludeTurn() {}
  };
}

function ref(engine, session, event) {
  return engine.boundaryRefAtSeq(session, Number(event.seq));
}

async function compressRange(instance, fixtureValue, start, end, summary, topic = 'Closed work') {
  return instance.tool.execute({
    topic,
    content: [{
      startId: typeof start === 'string' ? start : ref(instance.engine, fixtureValue.session, start),
      endId: typeof end === 'string' ? end : ref(instance.engine, fixtureValue.session, end),
      summary
    }]
  }, execFor(fixtureValue.session));
}

try {
  console.log('--- model-facing schema and prompts ---');
  const standard = await mount();
  check('compress is registered', standard.tool !== undefined);
  const rootProperties = Object.keys(standard.tool?.parameters?.properties ?? {});
  const rangeProperties = Object.keys(standard.tool?.parameters?.properties?.content?.items?.properties ?? {});
  check('the root schema is topic + content', JSON.stringify(rootProperties.sort()) === JSON.stringify(['content', 'topic']));
  check('range entries are exactly startId/endId/summary', JSON.stringify(rangeProperties.sort()) === JSON.stringify(['endId', 'startId', 'summary']));
  check('range boundaries and topic are strings', standard.tool.parameters.properties.topic.type === 'string'
    && standard.tool.parameters.properties.content.items.properties.startId.type === 'string'
    && standard.tool.parameters.properties.content.items.properties.endId.type === 'string');
  const description = standard.tool.description;
  check('the tool description teaches mNNNN and bN', description.includes('mNNNN') && description.includes('bN'));
  check('numeric protocol is absent from the model-facing tool', !/start_seq|end_seq|\[id\]|seq: number/.test(description + JSON.stringify(standard.tool.parameters)));

  const oldShapeFixture = fixture();
  let oldShapeError;
  try {
    await standard.tool.execute({ topic: 'old shape', content: [{ start_seq: 1, end_seq: 2, summary: 'must fail' }] }, execFor(oldShapeFixture.session));
  } catch (error) {
    oldShapeError = error;
  }
  check('the shipped numeric input shape is rejected', /missing required property "content\[0\]\.startId"/.test(oldShapeError?.message ?? '')
    && /start_seq.*not a declared property/.test(oldShapeError?.message ?? ''), oldShapeError?.message);

  console.log('\n--- validation and system exclusion ---');
  for (const [args, expected] of [
    [{ topic: '', content: [{ startId: 'm0001', endId: 'm0001', summary: 'x' }] }, 'topic is required and must be a non-empty string'],
    [{ topic: 'x', content: [] }, 'content is required and must be a non-empty array'],
    [{ topic: 'x', content: [{ startId: '', endId: 'm0001', summary: 'x' }] }, 'content[0].startId is required and must be a non-empty string'],
    [{ topic: 'x', content: [{ startId: 'm0001', endId: '', summary: 'x' }] }, 'content[0].endId is required and must be a non-empty string'],
    [{ topic: 'x', content: [{ startId: 'm0001', endId: 'm0001', summary: '' }] }, 'content[0].summary is required and must be a non-empty string']
  ]) {
    const sample = fixture();
    let message = '';
    try { await standard.tool.execute(args, execFor(sample.session)); } catch (error) { message = error.message; }
    check(expected, message === expected, message);
  }

  const unavailable = fixture();
  const systemRef = standard.engine.boundaryRefAtSeq(unavailable.session, Number(unavailable.system.seq));
  check('system messages have no boundary alias', systemRef === undefined, String(systemRef));
  const unavailableBefore = JSON.stringify(unavailable.session.snapshotEvents());
  let unavailableError;
  try {
    await standard.tool.execute({ topic: 'bad boundary', content: [{ startId: 'm9999', endId: 'm9999', summary: 'x' }] }, execFor(unavailable.session));
  } catch (error) { unavailableError = error; }
  check('an unavailable alias is rejected with upstream wording', unavailableError?.message === 'startId m9999 is not available in the current conversation context. Choose an injected ID visible in context.\n- endId m9999 is not available in the current conversation context. Choose an injected ID visible in context.'
    || unavailableError?.message === '- startId m9999 is not available in the current conversation context. Choose an injected ID visible in context.\n- endId m9999 is not available in the current conversation context. Choose an injected ID visible in context.', unavailableError?.message);
  check('a refused boundary does not append to the durable log', JSON.stringify(unavailable.session.snapshotEvents()) === unavailableBefore);

  const reversed = fixture();
  const reversedStart = ref(standard.engine, reversed.session, reversed.tail);
  const reversedEnd = ref(standard.engine, reversed.session, reversed.user);
  let reversedError;
  try {
    await standard.tool.execute({ topic: 'reversed', content: [{ startId: reversedStart, endId: reversedEnd, summary: 'x' }] }, execFor(reversed.session));
  } catch (error) { reversedError = error; }
  check('reversed aliases use upstream ordering error', reversedError?.message === `startId ${reversedStart} appears after endId ${reversedEnd} in the conversation. Start must come before end.`, reversedError?.message);

  const overlap = fixture();
  const overlapUser = ref(standard.engine, overlap.session, overlap.user);
  const overlapAssistant = ref(standard.engine, overlap.session, overlap.assistant);
  const overlapTail = ref(standard.engine, overlap.session, overlap.tail);
  const overlapBefore = JSON.stringify(overlap.session.snapshotEvents());
  let overlapError;
  try {
    await standard.tool.execute({ topic: 'overlap', content: [
      { startId: overlapUser, endId: overlapTail, summary: 'first' },
      { startId: overlapTail, endId: overlapTail, summary: 'second' }
    ] }, execFor(overlap.session));
  } catch (error) { overlapError = error; }
  check('overlapping alias ranges are rejected before writes', /overlaps content\[1\].*Overlapping ranges cannot be compressed in the same batch/.test(overlapError?.message ?? '')
    && JSON.stringify(overlap.session.snapshotEvents()) === overlapBefore, overlapError?.message);

  console.log('\n--- same-boundary message compression ---');
  const oneUser = fixture();
  const userAlias = ref(standard.engine, oneUser.session, oneUser.user);
  const userValue = await compressRange(standard, oneUser, userAlias, userAlias, 'USER-SUMMARY');
  check('startId=endId is accepted for a raw user message', userValue.compressed === true && userValue.compressedMessages === 1, JSON.stringify(userValue));
  check('the selected user text leaves the model view', !modelText(oneUser.session).includes('USER-INSTRUCTION'));
  check('the replacement summary enters the model view', modelText(oneUser.session).includes('USER-SUMMARY'));

  const batch = fixture();
  const batchUser = ref(standard.engine, batch.session, batch.user);
  const batchTail = ref(standard.engine, batch.session, batch.tail);
  const batchValue = await standard.tool.execute({ topic: 'Two closed messages', content: [
    { startId: batchUser, endId: batchUser, summary: 'BATCH-USER' },
    { startId: batchTail, endId: batchTail, summary: 'BATCH-TAIL' }
  ] }, execFor(batch.session));
  check('non-overlapping ranges batch in one call', batchValue.compressed === true && batchValue.blocks.length === 2 && batchValue.compressedMessages === 2);

  const multiCalls = [
    { id: 'multi-1', name: 'read', args: { filePath: 'a.js' } },
    { id: 'multi-2', name: 'read', args: { filePath: 'b.js' } }
  ];
  const toolOnly = fixture({ calls: multiCalls, outputs: [[multiCalls[0], 'MULTI-ONE'], [multiCalls[1], 'MULTI-TWO']] });
  const assistantAlias = ref(standard.engine, toolOnly.session, toolOnly.assistant);
  check('both completed tool outputs resolve to the assistant alias', toolOnly.results.every((event) => ref(standard.engine, toolOnly.session, event) === assistantAlias), assistantAlias);
  const toolOnlyValue = await compressRange(standard, toolOnly, toolOnly.user, toolOnly.tail, 'ASSISTANT-WITH-TOOLS-SUMMARY');
  const toolOnlyView = modelText(toolOnly.session);
  check('one assistant ID compresses its message and every completed tool result', toolOnlyValue.compressed === true && !toolOnlyView.includes('MULTI-ONE') && !toolOnlyView.includes('MULTI-TWO'), toolOnlyView);
  check('the compressed transcript has no orphaned selected tool pair', !toolOnlyView.includes('multi-1') && !toolOnlyView.includes('multi-2'));

  console.log('\n--- exact block wrapper and bN boundaries ---');
  const boundary = fixture();
  const first = await compressRange(standard, boundary, boundary.user, boundary.user, 'FIRST-BLOCK');
  check('the first compression lands as b1', first.blocks[0]?.blockId === '1');
  const exactWrapper = '[Compressed conversation section]\nFIRST-BLOCK\n\n<dcp-message-id>b1</dcp-message-id>';
  check('the durable replacement wrapper is exact', standard.engine.blocksFor(boundary.session).get('1')?.summary === exactWrapper, JSON.stringify(standard.engine.blocksFor(boundary.session).get('1')?.summary));
  const boundaryValue = await compressRange(standard, boundary, 'b1', 'b1', 'AFTER-BOUNDARY');
  const boundaryText = modelText(boundary.session);
  check('bN can be a range boundary', boundaryValue.compressed === true, boundaryValue.reason ?? '');
  check('an omitted selected predecessor is absorbed without hidden append', !boundaryText.includes('FIRST-BLOCK') && boundaryText.includes('AFTER-BOUNDARY'), boundaryText);
  check('absorbed lineage is complete', JSON.stringify(boundaryValue.blocks[0]) === JSON.stringify({
    ...boundaryValue.blocks[0],
    childBlockIds: ['1'], preservedBlockIds: [], absorbedBlockIds: ['1']
  }) && standard.engine.blocksFor(boundary.session).get('1')?.active === false);

  const blockOnly = fixture();
  await compressRange(standard, blockOnly, blockOnly.user, blockOnly.user, 'BLOCK-ONLY-FIRST');
  const blockOnlyValue = await compressRange(standard, blockOnly, 'b1', 'b1', 'before (b1) after');
  const blockOnlyText = modelText(blockOnly.session);
  check('startId=endId is accepted for a compressed block boundary', blockOnlyValue.compressed === true, blockOnlyValue.reason ?? '');
  check('one canonical marker preserves the old block exactly at that location', blockOnlyText.indexOf('before') < blockOnlyText.indexOf('BLOCK-ONLY-FIRST') && blockOnlyText.indexOf('BLOCK-ONLY-FIRST') < blockOnlyText.indexOf('after') && countOf(blockOnlyText, 'BLOCK-ONLY-FIRST') === 1, blockOnlyText);
  check('preserved lineage is complete', JSON.stringify(blockOnlyValue.blocks[0].childBlockIds) === '["1"]' && JSON.stringify(blockOnlyValue.blocks[0].preservedBlockIds) === '["1"]' && JSON.stringify(blockOnlyValue.blocks[0].absorbedBlockIds) === '[]');

  console.log('\n--- strict canonical placeholder semantics ---');
  const lateRow = fixture();
  const lateUser = ref(standard.engine, lateRow.session, lateRow.user);
  const lateTail = ref(standard.engine, lateRow.session, lateRow.tail);
  const lateBeforeEvents = JSON.stringify(lateRow.session.snapshotEvents());
  const lateBeforeState = JSON.stringify(standard.engine.blocksFor(lateRow.session).toJSON());
  let lateError;
  try {
    await standard.tool.execute({ topic: 'atomic preflight', content: [
      { startId: lateUser, endId: lateUser, summary: 'VALID-FIRST-ROW' },
      { startId: lateTail, endId: lateTail, summary: 'legacy {block_1}' }
    ] }, execFor(lateRow.session));
  } catch (error) { lateError = error; }
  check('a late legacy marker rejects the entire batch with exact guidance', lateError?.message === 'Use canonical (bN) instead of {block_N}', lateError?.message);
  check('a late-row failure has zero durable or registry side effects', JSON.stringify(lateRow.session.snapshotEvents()) === lateBeforeEvents && JSON.stringify(standard.engine.blocksFor(lateRow.session).toJSON()) === lateBeforeState);

  console.log('\n--- protected outputs use patterns and call-id binding ---');
  const protectedInstance = await mount({
    compress: { protectedTools: ['keep_exact', 'mcp_*'] },
    protectedFilePatterns: ['**/*.env']
  });
  const calls = [
    { id: 'keep-id', name: 'keep_exact', args: {} },
    { id: 'wild-id', name: 'mcp_fetch', args: {} },
    { id: 'file-id', name: 'read', args: { filePath: 'C:\\repo\\.env' } },
    { id: 'drop-id', name: 'drop_me', args: {} }
  ];
  const protectedFixture = fixture({
    calls,
    outputs: [
      [calls[3], 'DROP-OUTPUT'],
      [calls[2], 'FILE-OUTPUT'],
      [calls[0], 'EXACT-OUTPUT'],
      [calls[1], 'WILDCARD-OUTPUT']
    ]
  });
  const protectedValue = await compressRange(protectedInstance, protectedFixture, protectedFixture.user, protectedFixture.tail, 'PROTECTED-SUMMARY');
  const protectedSummary = protectedInstance.engine.blocksFor(protectedFixture.session).get(protectedValue.blocks[0].blockId)?.summary ?? '';
  check('exact protected tool output is bound by call id', protectedSummary.includes('### Tool: keep_exact\nEXACT-OUTPUT'));
  check('wildcard protected tool output is preserved', protectedSummary.includes('### Tool: mcp_fetch\nWILDCARD-OUTPUT'));
  check('protected file output is preserved', protectedSummary.includes('### Tool: read\nFILE-OUTPUT'));
  check('an unprotected result is not carried by positional accident', !protectedSummary.includes('DROP-OUTPUT'), protectedSummary);

  console.log('\n--- result rendering, message mode, and permission ---');
  const renderedFixture = fixture();
  const renderedArgs = {
    topic: 'Rendered result',
    content: [{ startId: ref(standard.engine, renderedFixture.session, renderedFixture.user), endId: ref(standard.engine, renderedFixture.session, renderedFixture.user), summary: 'DONE' }]
  };
  const renderedValue = await standard.tool.execute(renderedArgs, execFor(renderedFixture.session));
  const rendered = standard.tool.output.render(renderedArgs, renderedValue).map((part) => part.text).join('');
  check('successful output matches upstream wording', rendered === 'Compressed 1 messages into [Compressed conversation section].', rendered);
  check('successful output exposes no internal seq values', !/seq|range \d|shadowed/i.test(rendered), rendered);

  const messageMode = await mount({ compress: { mode: 'message' } });
  const messageProperties = Object.keys(messageMode.tool.parameters.properties.content.items.properties).sort();
  check('message mode also uses string aliases, never numeric seq', JSON.stringify(messageProperties) === JSON.stringify(['messageId', 'summary', 'topic']));
  const messageFixture = fixture();
  const messageId = ref(messageMode.engine, messageFixture.session, messageFixture.user);
  const messageValue = await messageMode.tool.execute({
    topic: 'One message',
    content: [{ messageId, topic: 'User instruction', summary: 'MESSAGE-MODE-SUMMARY' }]
  }, execFor(messageFixture.session));
  check('message mode resolves an mNNNN alias', messageValue.compressed === true && modelText(messageFixture.session).includes('MESSAGE-MODE-SUMMARY'));

  const denied = await mount({ compress: { permission: 'deny' } });
  check('permission deny removes the tool', denied.tool === undefined);

  console.log('\n--- placeholder unit falsification ---');
  const selected = [{ blockId: 1, summary: placeholders.wrapBlockSummary(1, 'SAVED'), active: true }];
  const registry = [
    ...selected,
    { blockId: 2, summary: placeholders.wrapBlockSummary(2, 'OUTSIDE'), active: true },
    { blockId: 3, summary: placeholders.wrapBlockSummary(3, 'INACTIVE'), active: false }
  ];
  const classified = placeholders.classifyAndExpandBlockPlaceholders('left (b1) right', { selectedBlocks: selected, registry });
  check('one canonical placeholder expands exactly in place', classified.expandedSummary === 'left SAVED right' && JSON.stringify(classified.childBlockIds) === '[1]' && JSON.stringify(classified.preservedBlockIds) === '[1]' && JSON.stringify(classified.absorbedBlockIds) === '[]', JSON.stringify(classified));
  const absorbed = placeholders.classifyAndExpandBlockPlaceholders('replacement only', { selectedBlocks: selected, registry });
  check('omitting a selected predecessor is legal absorption', absorbed.expandedSummary === 'replacement only' && JSON.stringify(absorbed.childBlockIds) === '[1]' && JSON.stringify(absorbed.preservedBlockIds) === '[]' && JSON.stringify(absorbed.absorbedBlockIds) === '[1]', JSON.stringify(absorbed));

  const strictCases = [
    ['legacy', '{block_1}', 'Use canonical (bN) instead of {block_N}'],
    ['duplicate', '(b1) then (b1)', 'Duplicate block placeholder (b1). Include a selected block at most once.'],
    ['unknown', '(b99)', 'Unknown block placeholder (b99).'],
    ['inactive', '(b3)', 'Inactive block placeholder (b3) cannot be preserved.'],
    ['out-of-range', '(b2)', 'Block placeholder (b2) is outside the selected compression range.'],
    ['malformed zero', '(b0)', 'Malformed block placeholder "(b0)". Use canonical (bN).'],
    ['malformed leading zero', '(b01)', 'Malformed block placeholder "(b01)". Use canonical (bN).'],
    ['malformed missing close', '(b1', 'Malformed block placeholder "(b1". Use canonical (bN).']
  ];
  for (const [name, summary, expected] of strictCases) {
    let error;
    try { placeholders.classifyAndExpandBlockPlaceholders(summary, { selectedBlocks: selected, registry }); } catch (caught) { error = caught; }
    check(`${name} marker rejects preflight`, error?.message === expected, error?.message);
  }

  const legacyState = new DcpBlockState({
    version: 3,
    blocks: [{
      blockId: '9', summary: placeholders.wrapBlockSummary(9, 'LEGACY'),
      anchorMessageId: 'legacy-anchor', shadowedMessageIds: ['legacy-anchor'], shadowedSeqs: [9],
      consumedBlockIds: ['1'], appendedBlockIds: ['2'], active: true
    }]
  });
  const migrated = legacyState.get('9');
  check('legacy lineage migrates conservatively to preserved children', JSON.stringify(migrated.childBlockIds) === '["1","2"]' && JSON.stringify(migrated.preservedBlockIds) === '["1","2"]' && JSON.stringify(migrated.absorbedBlockIds) === '[]' && migrated.lineageSemantics === 'legacy-unknown', JSON.stringify(migrated));
} finally {
  for (const scope of scopes.reverse()) await scope.dispose();
  rmSync(testHome, { recursive: true, force: true });
}

console.log(failures.length === 0 ? '\nall DCP compress tests passed' : `\n${failures.length} failure(s)`);
process.exit(failures.length === 0 ? 0 : 1);
