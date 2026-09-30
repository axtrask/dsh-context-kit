/** Production-boundary tests for the DSH DCP compression contract. */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testHome = mkdtempSync(join(tmpdir(), 'dsh-dcp-compress-'));
const temporaryHomes = [testHome];
process.env.DSH_HOME = testHome;

const { Context } = await import('@deepseek-ai/cordis');
const { Session, SessionId } = await import('@deepseek-ai/dsh-session');
const llm = await import('@deepseek-ai/dsh-llm');
const dcp = await import('../lib/dcp.js');
const { registerWireTransform } = await import('../lib/edit.js');
const blockTools = await import('../lib/dcp-blocks.js');
const { DcpBlockState } = blockTools;
const { compressionOperationJournalPath } = await import('../lib/dcp-compression-ops.js');
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

function recursiveFileSnapshot(root) {
  const entries = [];
  const walk = (directory, prefix = '') => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        entries.push(`d:${relative}`);
        walk(path, relative);
      } else if (entry.isFile()) {
        entries.push(`f:${relative}:${readFileSync(path).toString('base64')}`);
      }
    }
  };
  walk(root);
  return JSON.stringify(entries);
}

async function mount(config = {}, options = {}) {
  const root = new Context();
  const tools = new Map();
  const sessions = new Map();
  const meter = options.meter ?? {
    estimateMessage: (message) => JSON.stringify(message?.content ?? message ?? '').length,
    measure: () => ({ nodes: [] })
  };
  root.provide('tools', { register(definition) { tools.set(definition.name, definition); return () => {}; } });
  root.provide('llm', llm);
  root.provide('tokenMeter', meter);
  root.provide('sessions', { get: (id) => sessions.get(String(id)), list: () => [...sessions.values()] });
  const scope = root.plugin(dcp, {
    manualMode: false,
    automaticStrategies: false,
    strategies: { deduplication: { enabled: false }, purgeErrors: { enabled: false } },
    ...config
  });
  scopes.push(scope);
  await new Promise((resolve) => setTimeout(resolve, 150));
  return { tool: tools.get('compress'), engine: dcp.engineForTest(), meter, root, sessions };
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

function requestThrough(instance, session, messages) {
  instance.sessions.set(String(session.id), session);
  let seen = messages;
  let fired = false;
  const provider = {
    stream(request) {
      fired = true;
      seen = request.messages;
      return request;
    }
  };
  instance.root.waterfall(provider, 'llm/stream', { sessionId: String(session.id), messages }, (request) => provider.stream(request));
  return { seen, fired };
}

function wireStatuses(messages) {
  return JSON.stringify(messages).match(/<dcp-status>DCP-finalized message estimate: [^<]+<\/dcp-status>/g) ?? [];
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

  console.log('\n--- zero-effect whole-batch preflight ---');
  const isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-dcp-preflight-'));
  temporaryHomes.push(isolatedHome);
  const priorHome = process.env.DSH_HOME;
  process.env.DSH_HOME = isolatedHome;
  try {
    const isolated = await mount();
    const firstTouch = fixture();
    firstTouch.session.append('compaction/end', { turn: 1, ok: true });
    const firstTouchBeforeFiles = recursiveFileSnapshot(isolatedHome);
    const firstTouchBeforeEvents = JSON.stringify(firstTouch.session.snapshotEvents());
    let firstTouchError;
    try {
      await isolated.tool.execute({
        topic: 'Semantic invalid first-touch batch',
        content: [{ startId: 'm0001', endId: 'm0001', summary: 'must not run' }]
      }, execFor(firstTouch.session));
    } catch (error) {
      firstTouchError = error;
    }
    const firstTouchSessionId = String(firstTouch.session.id);
    check('semantic first-touch failure after native compaction has zero side effects',
      /startId m0001 is not available/.test(firstTouchError?.message ?? '')
      && recursiveFileSnapshot(isolatedHome) === firstTouchBeforeFiles
      && JSON.stringify(firstTouch.session.snapshotEvents()) === firstTouchBeforeEvents
      && isolated.engine._blocksBySession?.has(firstTouchSessionId) !== true
      && isolated.engine._compressionJournals.has(firstTouchSessionId) !== true,
    firstTouchError?.message ?? recursiveFileSnapshot(isolatedHome));

    const pending = fixture();
    const pendingAlias = ref(isolated.engine, pending.session, pending.user);
    isolated.engine.setCompressionFaultInjector((phase) => {
      if (phase === 'planned') throw new Error('leave pending preflight operation');
    });
    let plannedError;
    try {
      await compressRange(isolated, pending, pendingAlias, pendingAlias, 'PENDING-PREFLIGHT');
    } catch (error) {
      plannedError = error;
    } finally {
      isolated.engine.setCompressionFaultInjector(undefined);
    }
    const pendingJournal = isolated.engine.compressionJournal(pending.session);
    const pendingOperation = pendingJournal.operations()[0];
    const pendingBeforeFiles = recursiveFileSnapshot(isolatedHome);
    const pendingBeforeEvents = JSON.stringify(pending.session.snapshotEvents());
    const pendingBeforeState = JSON.stringify(isolated.engine.blocksFor(pending.session).toJSON());
    let pendingInvalidError;
    try {
      await isolated.tool.execute({
        topic: 'Late invalid pending batch',
        content: [
          { startId: pendingAlias, endId: pendingAlias, summary: 'valid detached plan' },
          { startId: 'm9999', endId: 'm9999', summary: 'must not run' }
        ]
      }, execFor(pending.session));
    } catch (error) {
      pendingInvalidError = error;
    }
    check('late-invalid semantic input cannot reconcile or land a pending planned operation',
      plannedError?.message === 'leave pending preflight operation'
      && /startId m9999 is not available/.test(pendingInvalidError?.message ?? '')
      && pendingOperation?.phase === 'planned'
      && pendingJournal.get(pendingOperation?.operationId)?.phase === 'planned'
      && recursiveFileSnapshot(isolatedHome) === pendingBeforeFiles
      && JSON.stringify(pending.session.snapshotEvents()) === pendingBeforeEvents
      && JSON.stringify(isolated.engine.blocksFor(pending.session).toJSON()) === pendingBeforeState,
    pendingInvalidError?.message ?? JSON.stringify(pendingJournal.operations()));
  } finally {
    process.env.DSH_HOME = priorHome;
  }

  console.log('\n--- post-reconcile stale-plan guards ---');
  const changedReservation = await mount();
  const changedReservationFixture = fixture();
  const changedReservationAlias = ref(changedReservation.engine, changedReservationFixture.session, changedReservationFixture.user);
  const changedReservationBeforeEvents = JSON.stringify(changedReservationFixture.session.snapshotEvents());
  const reconcileBeforeReservationChange = changedReservation.engine.reconcileCompressionOperations;
  changedReservation.engine.reconcileCompressionOperations = function mutateReservationDuringReconcile(session) {
    this.blocksFor(session).nextBlockId += 1;
    return [];
  };
  let changedReservationError;
  try {
    await compressRange(changedReservation, changedReservationFixture, changedReservationAlias, changedReservationAlias, 'STALE-RESERVATION');
  } catch (error) {
    changedReservationError = error;
  } finally {
    changedReservation.engine.reconcileCompressionOperations = reconcileBeforeReservationChange;
  }
  check('reservation changes during reconciliation abort before durable planning',
    changedReservationError?.message === 'compression state changed during whole-batch preflight; retry with the current message IDs'
    && JSON.stringify(changedReservationFixture.session.snapshotEvents()) === changedReservationBeforeEvents
    && changedReservation.engine._compressionJournals.has(String(changedReservationFixture.session.id)) !== true,
  changedReservationError?.message ?? JSON.stringify(changedReservationFixture.session.snapshotEvents()));

  const changedSurface = await mount();
  const changedSurfaceFixture = fixture();
  const changedSurfaceAlias = ref(changedSurface.engine, changedSurfaceFixture.session, changedSurfaceFixture.user);
  const changedSurfaceBeforeEvents = JSON.stringify(changedSurfaceFixture.session.snapshotEvents());
  const reconcileBeforeSurfaceChange = changedSurface.engine.reconcileCompressionOperations;
  let mutatedSurfaceNodes;
  changedSurface.engine.reconcileCompressionOperations = function mutateSurfaceDuringReconcile(session) {
    mutatedSurfaceNodes = session.surface.nodes;
    mutatedSurfaceNodes.push(Number(mutatedSurfaceNodes.at(-1)) + 1000);
    return [];
  };
  let changedSurfaceError;
  try {
    await compressRange(changedSurface, changedSurfaceFixture, changedSurfaceAlias, changedSurfaceAlias, 'STALE-SURFACE');
  } catch (error) {
    changedSurfaceError = error;
  } finally {
    if (mutatedSurfaceNodes !== undefined) mutatedSurfaceNodes.pop();
    changedSurface.engine.reconcileCompressionOperations = reconcileBeforeSurfaceChange;
  }
  check('surface changes during reconciliation abort before durable planning',
    changedSurfaceError?.message === 'compression surface changed during whole-batch preflight; retry with the current message IDs'
    && JSON.stringify(changedSurfaceFixture.session.snapshotEvents()) === changedSurfaceBeforeEvents
    && changedSurface.engine._compressionJournals.has(String(changedSurfaceFixture.session.id)) !== true,
  changedSurfaceError?.message ?? JSON.stringify(changedSurfaceFixture.session.snapshotEvents()));

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
  const mixedLineage = await compressRange(standard, batch, 'b1', 'b2', 'KEEP (b1), absorb the other predecessor', 'Mixed lineage telemetry');
  check('aggregate lineage telemetry distinguishes mixed children', mixedLineage.preservedBlocks === 1 && mixedLineage.absorbedBlocks === 1, JSON.stringify(mixedLineage));
  check('compression estimate telemetry is finite and arithmetically exact', [mixedLineage.beforeEstimate, mixedLineage.afterEstimate, mixedLineage.estimatedFreed].every(Number.isFinite)
    && mixedLineage.estimatedFreed === mixedLineage.beforeEstimate - mixedLineage.afterEstimate, JSON.stringify(mixedLineage));
  const telemetryFields = ['preservedBlocks', 'absorbedBlocks', 'beforeEstimate', 'afterEstimate', 'estimatedFreed'];
  const requiredOutputFields = standard.tool.output.schema.required ?? [];
  check('aggregate telemetry is required by the tool output schema', telemetryFields.every((field) => standard.tool.output.schema.properties[field]?.type === 'integer'
    && (standard.tool.output.schema.properties[field].required === true || requiredOutputFields.includes(field))), JSON.stringify(standard.tool.output.schema));
  const mixedRendered = standard.tool.output.render({}, mixedLineage).map((part) => part.text).join('');
  check('aggregate telemetry is visible in the rendered tool result', mixedRendered.includes('1 preserved, 1 absorbed')
    && mixedRendered.includes(`${mixedLineage.beforeEstimate} before`)
    && mixedRendered.includes(`${mixedLineage.afterEstimate} after`)
    && mixedRendered.includes(`${mixedLineage.estimatedFreed} freed`), mixedRendered);

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

  const freshLate = fixture();
  const freshUserId = ref(standard.engine, freshLate.session, freshLate.user);
  const freshTailId = ref(standard.engine, freshLate.session, freshLate.tail);
  const freshStatePath = join(testHome, 'context-kit', 'dcp-state', `${String(freshLate.session.id)}.json`);
  const freshJournalPath = compressionOperationJournalPath(freshLate.session.id);
  // Addressing is established before the baseline. Removing its persisted copy
  // makes any write performed by the rejected batch directly observable.
  rmSync(freshStatePath, { force: true });
  const freshBeforeState = JSON.stringify(standard.engine.blocksFor(freshLate.session).toJSON());
  const freshEvents = JSON.stringify(freshLate.session.snapshotEvents());
  let freshLateError;
  try {
    await standard.tool.execute({ topic: 'fresh atomic preflight', content: [
      { startId: freshUserId, endId: freshUserId, summary: 'VALID-FIRST-ROW' },
      { startId: freshTailId, endId: freshTailId, summary: 'legacy {block_1}' }
    ] }, execFor(freshLate.session));
  } catch (error) { freshLateError = error; }
  const freshAfter = standard.engine.blocksFor(freshLate.session);
  check('a fresh late failure allocates no permit, id, state file, journal, or log entry', freshLateError?.message === 'Use canonical (bN) instead of {block_N}'
    && JSON.stringify(freshAfter.toJSON()) === freshBeforeState
    && !existsSync(freshStatePath) && !existsSync(freshJournalPath)
    && JSON.stringify(freshLate.session.snapshotEvents()) === freshEvents, freshLateError?.message ?? JSON.stringify(freshAfter.toJSON()));

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
  check('successful output retains upstream wording and adds bounded telemetry', rendered.startsWith('Compressed 1 messages into [Compressed conversation section].')
    && rendered.includes('Predecessor blocks: 0 preserved, 0 absorbed.')
    && /Estimated tokens for compressed spans: \d+ before, \d+ after, -?\d+ freed\./.test(rendered), rendered);
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

  console.log('\n--- finalized wire estimate status ---');
  const wire = await mount();
  const wireFixture = fixture();
  const outgoing = wireFixture.session.snapshotEvents()
    .map((event) => wireFixture.session.deriveEventMessage(event))
    .filter((message) => message !== null);
  const disposeEditor = registerWireTransform(wire.root, (messages) => messages.map((message, index) => {
    if (index !== messages.length - 1 || message?.role !== 'user') return message;
    return {
      ...message,
      content: message.content.map((part) => part?.type === 'text' ? { ...part, text: `${part.text}\nEDITOR-STAGE-100` } : part)
    };
  }), { order: 100 });
  const firstWire = requestThrough(wire, wireFixture.session, outgoing);
  const firstCache = wire.engine.wireEstimateFor(wireFixture.session);
  const secondWire = requestThrough(wire, wireFixture.session, firstWire.seen);
  disposeEditor();
  const firstStatuses = wireStatuses(firstWire.seen);
  const secondStatuses = wireStatuses(secondWire.seen);
  const terminalUserText = [...firstWire.seen].reverse().find((message) => message?.role === 'user')?.content
    ?.filter((part) => part?.type === 'text').at(-1)?.text ?? '';
  const statusFreeWire = dcp.stripDcpWireStatuses(firstWire.seen).messages;
  const independentlyMeasured = statusFreeWire.reduce((total, message) => total + wire.meter.estimateMessage(message), 0);
  check('DCP status runs after ordinary editor and DCP transforms', firstWire.fired && terminalUserText.includes('EDITOR-STAGE-100') && terminalUserText.includes('<dcp-message-id>'));
  check('the provider-bound copy contains exactly one bounded estimate status', firstStatuses.length === 1
    && firstStatuses[0].includes('DCP-finalized message estimate: ~')
    && firstStatuses[0].length <= dcp.DCP_WIRE_STATUS_MAX_CHARS, firstStatuses.join('\n'));
  check('the wire status preserves the terminal DCP message id', /<dcp-status>DCP-finalized message estimate: ~\d+ tokens<\/dcp-status>\n<dcp-message-id>m\d{4,5}<\/dcp-message-id>\s*$/.test(terminalUserText), terminalUserText);
  check('prior wire status is replaced instead of accumulated', secondWire.fired && secondStatuses.length === 1, JSON.stringify(secondStatuses));
  check('wire measurement excludes the prior status and prices one final status', firstCache?.statusFreeEstimate === independentlyMeasured
    && firstCache?.finalizedEstimate === firstWire.seen.reduce((total, message) => total + wire.meter.estimateMessage(message), 0)
    && firstCache?.statusCost === firstCache.finalizedEstimate - firstCache.statusFreeEstimate, JSON.stringify({ firstCache, independentlyMeasured, visibleMeasured: firstWire.seen.reduce((total, message) => total + wire.meter.estimateMessage(message), 0) }));
  check('wire-only status never enters durable session history', !JSON.stringify(wireFixture.session.snapshotEvents()).includes('<dcp-status>'));

  const noUser = requestThrough(wire, wireFixture.session, [{ role: 'system', content: [{ type: 'text', text: 'system only' }] }]);
  check('no user text means no synthetic visible status message', noUser.fired && wireStatuses(noUser.seen).length === 0
    && noUser.seen.length === 1 && noUser.seen[0].role === 'system' && wire.engine.wireEstimateFor(wireFixture.session)?.visible === false);

  const fallback = await mount({}, {
    meter: {
      estimateMessage: () => Number.NaN,
      measure: () => ({ nodes: [] })
    }
  });
  const fallbackFixture = fixture();
  const fallbackOutgoing = fallbackFixture.session.snapshotEvents()
    .map((event) => fallbackFixture.session.deriveEventMessage(event))
    .filter((message) => message !== null);
  const fallbackWire = requestThrough(fallback, fallbackFixture.session, fallbackOutgoing);
  const fallbackStatuses = wireStatuses(fallbackWire.seen);
  check('unavailable measurement uses an explicit bounded estimate fallback', fallbackWire.fired && fallbackStatuses.length === 1
    && fallbackStatuses[0] === '<dcp-status>DCP-finalized message estimate: unavailable</dcp-status>'
    && fallbackStatuses[0].length <= dcp.DCP_WIRE_STATUS_MAX_CHARS, fallbackStatuses.join('\n'));

  console.log('\n--- durable landing fault reconciliation ---');
  for (const phase of ['planned', 'prune_landed', 'replacement_landed', 'registry_persisted', 'committed']) {
    const crash = fixture();
    standard.engine.setCompressionFaultInjector((landedPhase) => {
      if (landedPhase === phase) throw new Error(`injected crash at ${phase}`);
    });
    let crashError;
    try {
      await compressRange(standard, crash, crash.user, crash.user, `RECOVER-${phase}`);
    } catch (error) {
      crashError = error;
    } finally {
      standard.engine.setCompressionFaultInjector(undefined);
    }
    const crashedJournal = standard.engine.compressionJournal(crash.session);
    const operation = crashedJournal.operations()[0];
    const phasePersisted = operation?.phase === phase;
    const restarted = await mount();
    let reconcileError;
    try {
      restarted.engine.reconcileCompressionOperations(crash.session);
      restarted.engine.reconcileCompressionOperations(crash.session);
    } catch (error) {
      reconcileError = error;
    }
    const journal = restarted.engine.compressionJournal(crash.session);
    const prunes = crash.session.snapshotEvents().filter((event) => event.type === 'compaction/prune' && event.data?.dcpOperationId === operation?.operationId);
    const replacements = crash.session.snapshotEvents().filter((event) => event.type === 'user/message' && event.data?.source?.dcpOperationId === operation?.operationId);
    const recoveredBlock = restarted.engine.blocksFor(crash.session).get(operation?.blockId);
    check(`fault at ${phase} reconciles exactly once after restart`,
      crashError?.message === `injected crash at ${phase}`
      && phasePersisted
      && reconcileError === undefined
      && journal.get(operation.operationId)?.phase === 'committed'
      && prunes.length === 1
      && replacements.length === 1
      && Number(replacements[0].seq) === Number(prunes[0].seq) + 1
      && recoveredBlock?.operationId === operation.operationId
      && restarted.engine.blocksFor(crash.session).stats.compressions === 1,
    reconcileError?.message ?? JSON.stringify({ persisted: operation?.phase, prunes: prunes.length, replacements: replacements.length }));
  }

  console.log('\n--- synchronous native-compaction invalidation ---');
  const native = await mount();
  const nativeFixture = fixture();
  await compressRange(native, nativeFixture, nativeFixture.user, nativeFixture.user, 'COMMITTED-BEFORE-NATIVE');
  native.engine.setCompressionFaultInjector((phase) => {
    if (phase === 'planned') throw new Error('leave one pending operation');
  });
  let pendingError;
  try {
    await compressRange(native, nativeFixture, nativeFixture.tail, nativeFixture.tail, 'PENDING-BEFORE-NATIVE');
  } catch (error) {
    pendingError = error;
  } finally {
    native.engine.setCompressionFaultInjector(undefined);
  }
  const nativeState = native.engine.blocksFor(nativeFixture.session);
  nativeState.nudges.count = 7;
  nativeState.nudges.lastDecision = 'stale-nudge';
  nativeState.manualPermit = true;
  native.engine._nudgePrompt = new Map([[String(nativeFixture.session.id), { stamp: 'stale' }]]);
  native.engine.recordWireEstimate(nativeFixture.session, { statusFreeEstimate: 999, finalizedEstimate: 1000 });
  const nativeJournal = native.engine.compressionJournal(nativeFixture.session);
  const pendingBeforeNative = nativeJournal.operations().find((operation) => operation.phase === 'planned');
  const nativeEnd = nativeFixture.session.append('compaction/end', { turn: 1, ok: true });
  const pendingAfterNative = JSON.parse(JSON.stringify(pendingBeforeNative));
  pendingAfterNative.operationId = `${pendingBeforeNative.operationId}-after-marker`;
  pendingAfterNative.batchId = `${pendingBeforeNative.batchId}-after-marker`;
  pendingAfterNative.blockId = '999';
  pendingAfterNative.plannedAtSeq = Number(nativeEnd.seq);
  pendingAfterNative.plan.block.blockId = '999';
  pendingAfterNative.plan.replacementMessageId = `${pendingBeforeNative.plan.replacementMessageId}-after-marker`;
  pendingAfterNative.plan.materialization.replacement.data.id = pendingAfterNative.plan.replacementMessageId;
  pendingAfterNative.plan.materialization.replacement.data.source.dcpOperationId = pendingAfterNative.operationId;
  pendingAfterNative.plan.materialization.replacement.data.source.dcpBatchId = pendingAfterNative.batchId;
  pendingAfterNative.plan.materialization.replacement.data.source.dcpBlockId = pendingAfterNative.blockId;
  nativeJournal.planBatch([pendingAfterNative]);
  native.root.emit('session/event', nativeFixture.session, nativeEnd);
  const nativePhases = nativeJournal.operations().map((operation) => operation.phase);
  check('native compaction supersedes pending intent planned before its marker', nativePhases[1] === 'superseded', JSON.stringify(nativePhases));
  check('native compaction preserves pending intent planned at its marker', nativePhases[2] === 'planned', JSON.stringify(nativePhases));
  check('native compaction synchronously invalidates stale caches while retaining a visible summary', pendingError?.message === 'leave one pending operation'
    && nativeState.size === 1 && nativeState.get('1')?.active === true && nativeState.nextBlockId === 2 && nativeState.nextRunId === 2
    && nativeState.messageIds.nextRef === 1 && nativeState.messageIds.byRawId.size === 0 && nativeState.messageIds.byRef.size === 0
    && nativeState.nudges.count === 0 && nativeState.manualPermit === false
    && native.engine.wireEstimateFor(nativeFixture.session) === undefined
    && !native.engine._nudgePrompt.has(String(nativeFixture.session.id))
    && JSON.stringify(nativePhases) === '["committed","superseded","planned"]', JSON.stringify({ state: nativeState.toJSON(), nativePhases }));

  const retainedNodeSeq = nativeState.get('1').nodeSeq;
  nativeFixture.session.append('compaction/prune', {
    shadowedRange: { start: retainedNodeSeq, end: retainedNodeSeq },
    shadowedSeqs: [retainedNodeSeq],
    shadowedTokenCount: nativeState.get('1').summaryTokens
  });
  nativeFixture.session.append('user/message', llm.createUserMessage({
    content: [text('NATIVE-COMPACTION-REPLACEMENT')],
    source: { kind: 'user' }
  }), {
    surfaceOp: { op: 'replace', startSeq: retainedNodeSeq, endSeq: retainedNodeSeq },
    sourceEventSeqs: [retainedNodeSeq]
  });
  const secondNativeEnd = nativeFixture.session.append('compaction/end', { turn: 2, ok: true });
  native.root.emit('session/event', nativeFixture.session, secondNativeEnd);
  native.engine._blocksBySession.delete(String(nativeFixture.session.id));
  native.engine._compressionJournals.delete(String(nativeFixture.session.id));
  const restartedNativeState = native.engine.blocksFor(nativeFixture.session);
  let nativeReconcileError;
  try { native.engine.reconcileCompressionOperations(nativeFixture.session); } catch (error) { nativeReconcileError = error; }
  check('restart and reconciliation cannot resurrect a pre-compaction summary that is no longer visible', nativeReconcileError === undefined
    && restartedNativeState.size === 0 && restartedNativeState.nextBlockId === 1
    && JSON.stringify(native.engine.compressionJournal(nativeFixture.session).operations().map((operation) => operation.phase)) === '["committed","superseded","superseded"]', nativeReconcileError?.message ?? JSON.stringify(restartedNativeState.toJSON()));

  const postNativeUser = appendUser(nativeFixture.session, 'AFTER-NATIVE-COMPACTION');
  let postNativeResult;
  let postNativeError;
  try {
    postNativeResult = await compressRange(native, nativeFixture, postNativeUser, postNativeUser, 'POST-NATIVE-COMPRESSION');
  } catch (error) {
    postNativeError = error;
  }
  const postNativeOperations = native.engine.compressionJournal(nativeFixture.session).operations();
  const postNativeOperationIds = postNativeOperations.map((operation) => operation.operationId);
  check('compression after native compaction resets the display block id but never reuses a durable run id', postNativeError === undefined
    && postNativeResult?.compressed === true && postNativeResult.blocks?.[0]?.blockId === '1'
    && postNativeOperationIds.length === new Set(postNativeOperationIds).size
    && postNativeOperationIds.at(-1)?.includes(':run-3:blocks-1-1:block-1'), postNativeError?.message ?? JSON.stringify({ postNativeResult, postNativeOperationIds }));

  const failedPersistence = await mount();
  const failedPersistenceFixture = fixture();
  await compressRange(failedPersistence, failedPersistenceFixture, failedPersistenceFixture.user, failedPersistenceFixture.user, 'RESET-IN-MEMORY');
  const failedPersistenceState = failedPersistence.engine.blocksFor(failedPersistenceFixture.session);
  failedPersistence.engine.recordWireEstimate(failedPersistenceFixture.session, { statusFreeEstimate: 1, finalizedEstimate: 2 });
  const saveBlocks = failedPersistence.engine.saveBlocks;
  failedPersistence.engine.saveBlocks = () => { throw new Error('injected invalidation persistence failure'); };
  let invalidationError;
  try {
    const failedEnd = failedPersistenceFixture.session.append('compaction/end', { turn: 1, ok: true });
    failedPersistence.root.emit('session/event', failedPersistenceFixture.session, failedEnd);
  } catch (error) {
    invalidationError = error;
  } finally {
    failedPersistence.engine.saveBlocks = saveBlocks;
  }
  check('in-memory invalidation remains synchronous when persistence fails', invalidationError === undefined
    && failedPersistenceState.size === 1 && failedPersistenceState.get('1')?.active === true
    && failedPersistenceState.messageIds.nextRef === 1
    && failedPersistence.engine.wireEstimateFor(failedPersistenceFixture.session) === undefined, invalidationError?.message ?? JSON.stringify(failedPersistenceState.toJSON()));

  console.log('\n--- current top-level tool-result compatibility ---');
  const currentToolResult = Object.freeze({
    id: 'tool-message-current',
    role: 'tool',
    toolCallId: 'current-call',
    isError: false,
    source: Object.freeze({ kind: 'tool', callId: 'current-call' }),
    content: Object.freeze([{ type: 'text', text: 'CURRENT-OUTPUT' }]),
    providerField: 'preserve-me'
  });
  const directlyPruned = blockTools.prunedToolResultMessage(currentToolResult, 'CURRENT-PLACEHOLDER');
  check('current top-level tool result is immutably replaced with identity intact', directlyPruned !== currentToolResult
    && directlyPruned.id === currentToolResult.id
    && directlyPruned.role === 'tool'
    && directlyPruned.toolCallId === currentToolResult.toolCallId
    && directlyPruned.isError === currentToolResult.isError
    && JSON.stringify(directlyPruned.source) === JSON.stringify(currentToolResult.source)
    && directlyPruned.providerField === currentToolResult.providerField
    && directlyPruned.content?.[0]?.text === 'CURRENT-PLACEHOLDER'
    && currentToolResult.content[0].text === 'CURRENT-OUTPUT', JSON.stringify(directlyPruned));
  const currentPruneState = new DcpBlockState();
  currentPruneState.pruneTools([{ callId: 'current-call', tokens: 10, kind: 'output' }]);
  const currentPrunedList = blockTools.applyToolPruning([{
    id: 'assistant-current', role: 'assistant', content: [{ type: 'tool-call', id: 'current-call', name: 'read', arguments: '{}' }]
  }, currentToolResult], currentPruneState);
  check('tool-output pruning recognizes the current top-level result shape', currentPrunedList[1] !== currentToolResult
    && currentPrunedList[1].content?.[0]?.text === blockTools.PRUNED_TOOL_OUTPUT_REPLACEMENT
    && currentPrunedList[1].toolCallId === 'current-call'
    && currentPrunedList[1].providerField === 'preserve-me', JSON.stringify(currentPrunedList[1]));

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
  const migratedAgain = new DcpBlockState(new DcpBlockState(legacyState.toJSON()).toJSON()).get('9');
  check('legacy-unknown lineage survives a second persistence round trip', migratedAgain?.lineageSemantics === 'legacy-unknown'
    && JSON.stringify(migratedAgain.preservedBlockIds) === '["1","2"]'
    && JSON.stringify(migratedAgain.absorbedBlockIds) === '[]', JSON.stringify(migratedAgain));
} finally {
  for (const scope of scopes.reverse()) await scope.dispose();
  for (const home of temporaryHomes) rmSync(home, { recursive: true, force: true });
}

console.log(failures.length === 0 ? '\nall DCP compress tests passed' : `\n${failures.length} failure(s)`);
process.exit(failures.length === 0 ? 0 : 1);
