/** Production-path regressions for the negative DCP parity review. */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { Session, SessionId, SessionStore } from '@deepseek-ai/dsh-session';
import * as llm from '@deepseek-ai/dsh-llm';
import { createScope } from '@deepseek-ai/dsh-scope';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { toolResultOf } from '../lib/session.js';

const home = mkdtempSync(join(tmpdir(), 'dcp-review-gaps-'));
process.env.DSH_HOME = home;
process.env.XDG_CONFIG_HOME = join(home, 'xdg');
process.env.OPENCODE_CONFIG_DIR = join(home, 'config');

const dcp = await import('../lib/dcp.js');
const { DCP_STATE_VERSION } = await import('../lib/dcp-blocks.js');

const scopes = [];
let passed = 0;
let failed = 0;
let sessionNumber = 0;
const text = (value) => ({ type: 'text', text: value });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function check(name, body) {
  try {
    await body();
    passed += 1;
    console.log(`[ok] ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`[FAIL] ${name}: ${error.stack ?? error}`);
  }
}

async function mount(config = {}, options = {}) {
  const root = new Context();
  const tools = new Map();
  const commands = new Map();
  const sections = new Map();
  const calls = [];
  const injected = [];
  const meter = {
    total: options.totalTokens ?? 0,
    failEstimate: false,
    estimateMessage(message) {
      if (this.failEstimate) throw new Error('meter exploded');
      if (options.summaryTokens !== undefined && message?.source?.kind === 'plugin:dcp') return options.summaryTokens;
      return JSON.stringify(message?.content ?? message ?? '').length;
    },
    measure() { return { totalTokens: this.total, nodes: [] }; }
  };
  class CaptureAdapter extends llm.LlmAdapter {
    async prepareCall(provider, model, signal) {
      return { model: await this.resolveModel(provider, model, signal), stream: (request) => this.stream(request) };
    }
    async *stream(request) {
      calls.push(request);
      yield { type: 'text', delta: 'ok' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const runtime = new llm.LlmRuntime(root);
  runtime.registerAdapter(['stub', 'special', 'normal'], new CaptureAdapter());
  root.provide('tools', { register(item) { tools.set(item.name, item); return () => tools.delete(item.name); } });
  root.provide('commands', { register(item) { commands.set(item.name, item); return () => commands.delete(item.name); } });
  root.provide('systemPrompt', { section(item) { sections.set(item.name, item); return () => sections.delete(item.name); } });
  root.provide('tokenMeter', meter);
  root.provide('workspace', { root: options.workspace ?? process.cwd() });
  const store = new SessionStore(root);
  const scope = root.plugin(dcp, config);
  scopes.push(scope);
  await new Promise((resolve) => setTimeout(resolve, 180));
  return { root, runtime, tools, commands, sections, calls, injected, meter, store, engine: dcp.engineForTest() };
}

async function createSession(mounted, options = {}) {
  const id = SessionId(options.id ?? `review-${process.pid}-${Date.now()}-${++sessionNumber}`);
  const session = mounted.store.create(id, {
    ...(options.seed ? { seed: options.seed } : {}),
    meta: { cwd: process.cwd(), ...(options.meta ?? {}) }
  });
  for (let attempt = 0; attempt < 50 && mounted.store.get(id) === undefined; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  return session;
}

function appendUser(session, value, source = { kind: 'user' }) {
  return session.append('user/message', llm.createUserMessage({ content: [text(value)], source }), { surfaceOp: 'append' });
}

function appendAssistant(session, calls = [], value = 'ASSISTANT') {
  return session.append('assistant/message', {
    turn: 1,
    step: 1,
    stream: [],
    message: llm.createAssistantMessage({
      content: [
        ...(value === undefined ? [] : [text(value)]),
        ...calls.map((call) => ({ type: 'tool-call', id: llm.ToolCallId(call.id), name: call.name, arguments: JSON.stringify(call.args ?? {}) }))
      ],
      source: { kind: 'model', provider: 'stub', model: 'stub' }
    })
  }, { surfaceOp: 'append' });
}

function appendResult(session, call, output, isError = false) {
  return session.append('tool/result', {
    turn: 1,
    step: 1,
    message: llm.createToolResultMessage({ callId: llm.ToolCallId(call.id), content: [text(output)], isError })
  }, { surfaceOp: 'append' });
}

function appendExchange(session, call, output, isError = false, value = 'ASSISTANT') {
  const assistant = appendAssistant(session, [call], value);
  const result = appendResult(session, call, output, isError);
  return { assistant, result };
}

function execFor(session) {
  return {
    callId: 'compress-review', rootCallId: 'compress-review', name: 'compress', token: Symbol('compress'),
    arguments: {}, signal: new AbortController().signal, agent: { id: 'review', session }, deferContext() {}, concludeTurn() {}
  };
}

function commandInvocation(session, rawInput, injected = []) {
  return { rawInput, agent: { session, inject(message) { injected.push(message); } } };
}

async function command(mounted, session, rawInput, injected = []) {
  return mounted.commands.get('dcp').handler(commandInvocation(session, rawInput, injected));
}

async function send(mounted, session, request = {}) {
  const original = session.deriveMessages();
  for await (const _ of mounted.runtime.stream({
    provider: request.provider ?? 'stub', model: request.model ?? 'stub', messages: original,
    sessionId: String(session.id), signal: undefined, ...(request.contextWindow ? { contextWindow: request.contextWindow } : {})
  })) {}
  return { original, sent: mounted.calls.at(-1) };
}

function alias(engine, session, event) {
  return engine.boundaryRefAtSeq(session, Number(event.seq));
}

async function compress(mounted, session, start, end, summary, topic = 'review range') {
  const startId = typeof start === 'string' ? start : alias(mounted.engine, session, start);
  const endId = typeof end === 'string' ? end : alias(mounted.engine, session, end);
  return mounted.tools.get('compress').execute({ topic, content: [{ startId, endId, summary }] }, execFor(session));
}

function allText(messages) {
  return JSON.stringify(messages);
}

const strategiesOff = { deduplication: { enabled: false }, purgeErrors: { enabled: false, turns: 4 } };

try {
  await check('decompress preserves a middle span before its newer tail and recompress restores the summary view', async () => {
    const mounted = await mount({ pruneNotification: 'off', strategies: strategiesOff });
    const session = await createSession(mounted);
    session.append('turn/start', { turn: 1 });
    appendUser(session, 'HEAD');
    const middle = appendAssistant(session, [], 'MIDDLE-ORIGINAL');
    appendUser(session, 'NEWER-TAIL');
    const middleId = middle.data.message.id;
    const middleRef = alias(mounted.engine, session, middle);
    await compress(mounted, session, middle, middle, 'MIDDLE-SUMMARY');
    assert.ok(allText(session.deriveMessages()).includes('MIDDLE-SUMMARY'));
    const decompressed = await command(mounted, session, 'decompress B1');
    assert.equal(decompressed.kind, 'success');
    let view = allText(session.deriveMessages());
    assert.ok(view.indexOf('MIDDLE-ORIGINAL') < view.indexOf('NEWER-TAIL'), view);
    assert.ok(!view.includes('MIDDLE-SUMMARY'));
    const restoredMiddleSeq = mounted.engine.blocksFor(session).get('1').restoredSeqs[0];
    assert.notEqual(session.eventAt(restoredMiddleSeq).data.message.id, middleId);
    assert.equal(alias(mounted.engine, session, session.eventAt(restoredMiddleSeq)), middleRef);
    const recompressed = await command(mounted, session, 'recompress #1');
    assert.equal(recompressed.kind, 'success');
    view = allText(session.deriveMessages());
    assert.ok(view.includes('MIDDLE-SUMMARY') && !view.includes('MIDDLE-ORIGINAL'), view);
    assert.ok(view.indexOf('MIDDLE-SUMMARY') < view.indexOf('NEWER-TAIL'), view);
    assert.equal((await command(mounted, session, 'decompress 1')).kind, 'success');
    assert.equal((await command(mounted, session, 'recompress b1')).kind, 'success');
  });

  await check('nested decompress reactivates the consumed child and recompress restores ownership', async () => {
    const mounted = await mount({ pruneNotification: 'off', strategies: strategiesOff });
    const buildNested = async () => {
      const session = await createSession(mounted);
      const first = appendUser(session, 'B1-ORIGINAL');
      const fresh = appendUser(session, 'B2-FRESH');
      await compress(mounted, session, first, first, 'B1-SUMMARY');
      await compress(mounted, session, 'b1', alias(mounted.engine, session, fresh), 'B2-SUMMARY (b1)');
      const state = mounted.engine.blocksFor(session);
      assert.equal(state.get('1').active, false);
      assert.equal(state.get('1').deactivatedByBlockId, '2');
      return { session, state };
    };

    const restored = await buildNested();
    assert.equal((await command(mounted, restored.session, 'decompress b2')).kind, 'success');
    assert.equal(restored.state.get('1').active, true);
    assert.equal(mounted.engine.messageReferences(restored.session).byRef.get('b1')?.blockId, 1);
    assert.equal((await command(mounted, restored.session, 'decompress b1')).kind, 'success');
    assert.ok(allText(restored.session.deriveMessages()).includes('B1-ORIGINAL'));

    const recompressed = await buildNested();
    assert.equal((await command(mounted, recompressed.session, 'decompress b2')).kind, 'success');
    assert.equal(recompressed.state.get('1').active, true);
    assert.equal((await command(mounted, recompressed.session, 'recompress b2')).kind, 'success');
    assert.equal(recompressed.state.get('2').active, true);
    assert.equal(recompressed.state.get('1').active, false);
    assert.equal(recompressed.state.get('1').deactivatedByBlockId, '2');
    const view = allText(recompressed.session.deriveMessages());
    assert.ok(view.includes('B2-SUMMARY') && !view.includes('B1-ORIGINAL'));
  });

  await check('one availability guard covers disabled, deny, subagent prompt/tool/command/wire while editor stays separate', async () => {
    for (const config of [
      { enabled: false, editor: { enabled: true, requireIdle: false } },
      { compress: { permission: 'deny' }, editor: { enabled: true, requireIdle: false } }
    ]) {
      const mounted = await mount(config);
      const session = await createSession(mounted);
      const user = appendUser(session, 'NO-DCP');
      assert.equal(mounted.tools.has('compress'), false);
      assert.equal(mounted.commands.has('dcp'), false);
      assert.equal(mounted.commands.has('edit'), true);
      assert.equal(mounted.sections.get('dcp:system').text({ scope: session }), '');
      const { sent } = await send(mounted, session);
      assert.equal(allText(sent.messages).includes('dcp-message-id'), false);
      assert.ok(user);
    }
    const mounted = await mount({ experimental: { allowSubAgents: false } });
    const subagent = await createSession(mounted, { meta: { origin: 'subagent', delegationDepth: 0 } });
    const user = appendUser(subagent, 'SUBAGENT');
    assert.equal(mounted.sections.get('dcp:system').text({ scope: subagent }), '');
    await assert.rejects(() => mounted.tools.get('compress').execute({ topic: 'x', content: [{ startId: 'm0001', endId: 'm0001', summary: 'x' }] }, execFor(subagent)), /subagent/);
    assert.match((await command(mounted, subagent, 'status')).text, /subagent/);
    const { sent } = await send(mounted, subagent);
    assert.equal(allText(sent.messages).includes('dcp-message-id'), false);
    assert.ok(user);
  });

  await check('subagent catalog exposes compress by default and an explicit opt-out hides it', async () => {
    for (const { label, config, childHasCompress } of [
      { label: 'default', config: {}, childHasCompress: true },
      { label: 'restricted', config: { experimental: { allowSubAgents: false } }, childHasCompress: false }
    ]) {
      const root = new Context();
      await root.plugin(SystemPrompt, {});
      await root.plugin(ToolRuntime, {});
      root.provide('llm', llm);
      root.provide('tokenMeter', { estimateMessage: () => 1, measure: () => ({ totalTokens: 0, nodes: [] }) });
      new SessionStore(root);
      const plugin = root.plugin(dcp, { ...config, strategies: strategiesOff });
      scopes.push(plugin);
      await new Promise((resolve) => setTimeout(resolve, 150));

      const makeAgent = async (id, header) => {
        const agent = { id: SessionId(id) };
        let scope;
        const holder = root.plugin(Object.assign((inner) => { scope = createScope(inner, agent); }, { inject: ['tools', 'systemPrompt'] }));
        scopes.push(holder);
        await holder;
        agent.ctx = scope.ctx;
        agent.scope = scope;
        agent.session = { id: agent.id, header, seq: 0, eventAt: () => undefined, snapshotEvents: () => [], surface: { nodes: [] } };
        root.emit('agent/created', { agent });
        return agent;
      };
      const main = await makeAgent(`catalog-${label}-main-${Date.now()}`, { delegationDepth: 0 });
      const child = await makeAgent(`catalog-${label}-child-${Date.now()}`, { origin: 'subagent', delegationDepth: 1 });
      assert.ok(root.tools.schemas(main).some((tool) => tool.name === 'compress'));
      assert.equal(root.tools.schemas(child).some((tool) => tool.name === 'compress'), childHasCompress);
      assert.ok(root.tools.schemas().some((tool) => tool.name === 'compress'));
    }
  });

  await check('native and restart-detected compaction reset and persist aliases even with no blocks', async () => {
    const mounted = await mount({ strategies: strategiesOff, pruneNotification: 'off' });
    const session = await createSession(mounted);
    const state = mounted.engine.blocksFor(session);
    state.messageIds.byRawId.set('capacity', 'm99999');
    state.messageIds.byRef.set('m99999', 'capacity');
    state.messageIds.nextRef = 100000;
    session.append('compaction/end', { turn: 1, ok: true });
    await tick();
    assert.equal(state.messageIds.nextRef, 1);
    const user = appendUser(session, 'AFTER-COMPACTION');
    const { sent } = await send(mounted, session);
    assert.match(allText(sent.messages), /<dcp-message-id>m0001<\/dcp-message-id>/);
    assert.ok(user);

    const retained = await createSession(mounted);
    const retainedUser = appendUser(retained, 'RETAINED-ORIGINAL');
    const retainedTail = appendUser(retained, 'RETAINED-TAIL');
    const retainedTailRef = alias(mounted.engine, retained, retainedTail);
    await compress(mounted, retained, retainedUser, retainedUser, 'RETAINED-SUMMARY');
    retained.append('compaction/end', { turn: 1, ok: true });
    await tick();
    const retainedState = mounted.engine.blocksFor(retained);
    assert.equal(retainedState.get('1')?.active, true);
    assert.equal(retainedState.nextBlockId, 2);
    assert.equal((await command(mounted, retained, 'decompress b1')).kind, 'success');
    assert.ok(allText(retained.deriveMessages()).includes('RETAINED-ORIGINAL'));
    assert.equal(mounted.engine.messageReferences(retained).byRef.get(retainedTailRef)?.ref, retainedTailRef);
    const retainedValue = await compress(mounted, retained, retainedTailRef, retainedTailRef, 'AFTER-RETAINED');
    assert.equal(retainedValue.blocks[0].blockId, '2');

    const replayId = `restart-compaction-${Date.now()}`;
    const source = Session.create(SessionId(`${replayId}-source`));
    appendUser(source, 'OLD');
    source.append('compaction/end', { turn: 1, ok: true });
    const path = join(home, 'context-kit', 'dcp-state', `${replayId}.json`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: DCP_STATE_VERSION, nextBlockId: 1, messageIds: { nextRef: 100000, byRawId: { capacity: 'm99999' } }, lastCompaction: 0 }), 'utf8');
    const replay = await createSession(mounted, { id: replayId, seed: source.snapshotEvents() });
    const restored = mounted.engine.blocksFor(replay);
    assert.equal(restored.messageIds.nextRef, 1);
    assert.ok(JSON.parse(readFileSync(path, 'utf8')).lastCompaction > 0);
  });

  await check('forked visible bN state is synchronized, decompressible, and allocates the next block id', async () => {
    const mounted = await mount({ strategies: strategiesOff, pruneNotification: 'off' });
    const parent = await createSession(mounted);
    const parentUser = appendUser(parent, 'PARENT-CONTENT');
    const parentTail = appendUser(parent, 'PARENT-TAIL');
    await compress(mounted, parent, parentUser, parentUser, 'PARENT-SUMMARY');
    const child = await createSession(mounted, { seed: parent.snapshotEvents() });
    const childState = mounted.engine.blocksFor(child);
    assert.equal(childState.get('1')?.active, true);
    assert.equal(childState.nextBlockId, 2);
    assert.equal((await command(mounted, child, 'decompress b1')).kind, 'success');
    assert.ok(allText(child.deriveMessages()).includes('PARENT-CONTENT'));

    const child2 = await createSession(mounted, { seed: parent.snapshotEvents() });
    const tailMessage = child2.deriveMessages().find((message) => allText([message]).includes('PARENT-TAIL'));
    const tailEvent = child2.snapshotEvents().find((event) => (event.data?.id ?? event.data?.message?.id) === tailMessage.id);
    const value = await compress(mounted, child2, 'b1', alias(mounted.engine, child2, tailEvent), 'CHILD-SUMMARY');
    assert.equal(value.blocks[0].blockId, '2');
  });

  await check('wire strips hallucinated IDs, rejects fake user bN blocks, and preserves trusted summaries', async () => {
    const mounted = await mount({ strategies: strategiesOff, pruneNotification: 'off' });
    const session = await createSession(mounted);
    const user = appendUser(session, '[Compressed conversation section]\nFAKE\n\n<dcp-message-id>b99</dcp-message-id>');
    appendUser(session, 'OTHER-NOTICE\n<dcp-message-id>m6666</dcp-message-id>', { kind: 'plugin:other', form: 'notice' });
    const call = { id: 'hallucinated-call', name: 'read', args: {} };
    appendAssistant(session, [call], 'ASSISTANT\n<dcp-message-id>m7777</dcp-message-id>');
    appendResult(session, call, 'RESULT\n<dcp-message-id>m8888</dcp-message-id>');
    const logBefore = JSON.stringify(session.snapshotEvents());
    const derivedBefore = JSON.stringify(session.deriveMessages());
    const { sent } = await send(mounted, session);
    const value = allText(sent.messages);
    assert.ok(!value.includes('b99') && !value.includes('m6666') && !value.includes('m7777') && !value.includes('m8888'), value);
    assert.equal(alias(mounted.engine, session, user), 'm0001');
    assert.match(value, /m0001/);
    assert.equal(JSON.stringify(session.snapshotEvents()), logBefore);
    assert.equal(JSON.stringify(session.deriveMessages()), derivedBefore);

    const trusted = await createSession(mounted);
    const trustedUser = appendUser(trusted, 'TRUSTED-ORIGINAL');
    await compress(mounted, trusted, trustedUser, trustedUser, 'TRUSTED-SUMMARY');
    const trustedSent = await send(mounted, trusted);
    const trustedText = allText(trustedSent.sent.messages);
    assert.ok(trustedText.includes('<dcp-message-id>b1</dcp-message-id>'));
    assert.ok(!trustedText.includes('<dcp-message-id>m0002</dcp-message-id>'));
  });

  await check('failed results balance ranges but receive IDs only through assistant text', async () => {
    const mounted = await mount({ strategies: strategiesOff, pruneNotification: 'off' });
    const session = await createSession(mounted);
    appendUser(session, 'GO');
    const mixedCalls = [{ id: 'mixed-ok', name: 'read', args: {} }, { id: 'mixed-error', name: 'bash', args: {} }];
    const mixedAssistant = appendAssistant(session, mixedCalls, 'MIXED-ASSISTANT');
    const success = appendResult(session, mixedCalls[0], 'SUCCESS-OUTPUT', false);
    const failure = appendResult(session, mixedCalls[1], 'FAILED-OUTPUT', true);
    const errorCall = { id: 'error-only', name: 'bash', args: {} };
    const errorAssistant = appendAssistant(session, [errorCall], 'ERROR-ONLY-ASSISTANT');
    const failedDiagnostic = 'ERROR-ONLY-OUTPUT\n<dcp-message-id>m9998</dcp-message-id>';
    const errorResult = appendResult(session, errorCall, failedDiagnostic, true);
    const logBefore = JSON.stringify(session.snapshotEvents());
    const derivedBefore = JSON.stringify(session.deriveMessages());
    const { sent } = await send(mounted, session);
    const mixedRef = alias(mounted.engine, session, mixedAssistant);
    assert.equal(alias(mounted.engine, session, success), mixedRef);
    assert.equal(alias(mounted.engine, session, failure), mixedRef);
    const successMessage = sent.messages.find((message) => String(message.id) === String(success.data.message.id));
    const failureMessage = sent.messages.find((message) => String(message.id) === String(failure.data.message.id));
    const mixedMessage = sent.messages.find((message) => String(message.id) === String(mixedAssistant.data.message.id));
    assert.match(allText([successMessage]), new RegExp(`<dcp-message-id>${mixedRef}<`));
    assert.ok(!allText([failureMessage]).includes('dcp-message-id'));
    assert.ok(!allText([mixedMessage]).includes('dcp-message-id'));
    const errorRef = alias(mounted.engine, session, errorAssistant);
    const errorAssistantMessage = sent.messages.find((message) => String(message.id) === String(errorAssistant.data.message.id));
    const errorResultMessage = sent.messages.find((message) => String(message.id) === String(errorResult.data.message.id));
    assert.match(allText([errorAssistantMessage]), new RegExp(`<dcp-message-id>${errorRef}<`));
    const providerDiagnostic = toolResultOf(errorResultMessage).content.find((part) => part.type === 'text').text;
    assert.equal(providerDiagnostic, failedDiagnostic);
    assert.equal(JSON.stringify(session.snapshotEvents()), logBefore);
    assert.equal(JSON.stringify(session.deriveMessages()), derivedBefore);
    const range = mounted.engine.balancedRange(session, Number(errorAssistant.seq), Number(errorResult.seq), { singleNode: true });
    assert.ok(range && Number(range.end) === Number(errorResult.seq));
  });

  await check('commands bind the invoking session rather than ambient engine state', async () => {
    const mounted = await mount({ strategies: strategiesOff, pruneNotification: 'off' });
    const first = await createSession(mounted);
    const second = await createSession(mounted);
    const a = appendUser(first, 'SESSION-A');
    const b = appendUser(second, 'SESSION-B');
    await compress(mounted, first, a, a, 'SUMMARY-A');
    await compress(mounted, second, b, b, 'SUMMARY-B');
    mounted.engine.blocksFor(second);
    assert.equal((await command(mounted, first, 'decompress b1')).kind, 'success');
    assert.ok(allText(first.deriveMessages()).includes('SESSION-A'));
    assert.ok(allText(second.deriveMessages()).includes('SUMMARY-B'));
    assert.equal(mounted.engine.blocksFor(second).get('1').active, true);
  });

  await check('reversed chronological batches allocate blocks in input order with one run id', async () => {
    const mounted = await mount({ strategies: strategiesOff, pruneNotification: 'off' });
    const session = await createSession(mounted);
    const early = appendUser(session, 'EARLY');
    const middle = appendUser(session, 'MIDDLE');
    const late = appendUser(session, 'LATE');
    const args = {
      topic: 'input order',
      content: [
        { startId: alias(mounted.engine, session, late), endId: alias(mounted.engine, session, late), summary: 'FIRST-INPUT-LATE' },
        { startId: alias(mounted.engine, session, early), endId: alias(mounted.engine, session, early), summary: 'SECOND-INPUT-EARLY' }
      ]
    };
    const value = await mounted.tools.get('compress').execute(args, execFor(session));
    assert.deepEqual(value.blocks.map((block) => block.blockId), ['1', '2']);
    const state = mounted.engine.blocksFor(session);
    assert.equal(state.get('1').startId, args.content[0].startId);
    assert.equal(state.get('2').startId, args.content[1].startId);
    assert.equal(state.get('1').runId, state.get('2').runId);
    assert.equal(state.nextRunId, 2);
    assert.ok(middle);
  });

  await check('question/edit/write protect successful outputs while pruning eligible inputs', async () => {
    const mounted = await mount({ pruneNotification: 'off', strategies: { deduplication: { enabled: true }, purgeErrors: { enabled: true, turns: 1 } } });
    for (const name of ['question', 'ask_user_question', 'edit', 'write']) {
      const session = await createSession(mounted);
      appendUser(session, 'GO');
      const args = name.includes('question') ? { questions: [{ question: 'Q?' }] } : { filePath: 'a.js', content: 'x' };
      appendExchange(session, { id: `${name}-1`, name, args }, `${name}-ONE`);
      appendExchange(session, { id: `${name}-2`, name, args }, `${name}-TWO`);
      const surfaceBefore = JSON.stringify(session.surface.nodes);
      const added = mounted.engine.pruneSession(session, undefined, { nudge: false });
      assert.equal(added.length, 1, name);
      assert.equal(added[0].kind, name.includes('question') ? 'question-input' : 'protected-output');
      assert.equal(JSON.stringify(session.surface.nodes), surfaceBefore);
      const { sent } = await send(mounted, session);
      assert.ok(allText(sent.messages).includes(`${name}-ONE`) && allText(sent.messages).includes(`${name}-TWO`));
      const firstCall = sent.messages.flatMap((message) => message.content ?? []).find((part) => part.type === 'tool-call' && part.id === `${name}-1`);
      if (name.includes('question')) assert.equal(JSON.parse(firstCall.arguments).questions, "[questions removed - see output for user's answers]");
      else assert.deepEqual(JSON.parse(firstCall.arguments), args);
    }
    for (const name of ['ask_user_question', 'edit', 'write']) {
      const session = await createSession(mounted);
      session.append('step/start', { turn: 1, step: 1 });
      appendUser(session, 'GO');
      appendExchange(session, { id: `${name}-failed`, name, args: { payload: 'large', nested: { keep: 'nested' } } }, `${name}-ERROR`, true);
      session.append('step/start', { turn: 1, step: 2 });
      const added = mounted.engine.pruneSession(session, undefined, { nudge: false });
      assert.equal(added[0].kind, 'error-input');
      const { sent } = await send(mounted, session);
      const call = sent.messages.flatMap((message) => message.content ?? []).find((part) => part.type === 'tool-call' && part.id === `${name}-failed`);
      const input = JSON.parse(call.arguments);
      assert.equal(input.payload, '[input removed due to failed tool call]');
      assert.deepEqual(input.nested, { keep: 'nested' });
      assert.ok(allText(sent.messages).includes(`${name}-ERROR`));
    }

  });

  await check('duplicate signatures drop only top-level null and preserve nested null', async () => {
    const mounted = await mount({ pruneNotification: 'off', strategies: { deduplication: { enabled: true }, purgeErrors: { enabled: false } } });
    const nested = await createSession(mounted);
    appendUser(nested, 'GO');
    appendExchange(nested, { id: 'nested-1', name: 'read', args: { top: 1, nested: { value: null } } }, 'ONE');
    appendExchange(nested, { id: 'nested-2', name: 'read', args: { top: 1, nested: {} } }, 'TWO');
    assert.equal(mounted.engine.pruneSession(nested, undefined, { nudge: false }).length, 0);
    const top = await createSession(mounted);
    appendUser(top, 'GO');
    appendExchange(top, { id: 'top-1', name: 'read', args: { top: 1, drop: null } }, 'ONE');
    appendExchange(top, { id: 'top-2', name: 'read', args: { top: 1 } }, 'TWO');
    assert.equal(mounted.engine.pruneSession(top, undefined, { nudge: false }).length, 1);
  });

  await check('token meter failure cancels a strategy plan without manifest or surface mutation', async () => {
    const mounted = await mount({ pruneNotification: 'off', strategies: { deduplication: { enabled: true }, purgeErrors: { enabled: false } } });
    const session = await createSession(mounted);
    appendUser(session, 'GO');
    appendExchange(session, { id: 'meter-1', name: 'read', args: { x: 1 } }, 'ONE');
    appendExchange(session, { id: 'meter-2', name: 'read', args: { x: 1 } }, 'TWO');
    const before = JSON.stringify({ events: session.snapshotEvents(), surface: session.surface.nodes, state: mounted.engine.blocksFor(session).toJSON() });
    mounted.meter.failEstimate = true;
    const added = mounted.engine.pruneSession(session, undefined, { nudge: false });
    mounted.meter.failEstimate = false;
    assert.equal(added.length, 0);
    assert.equal(JSON.stringify({ events: session.snapshotEvents(), surface: session.surface.nodes, state: mounted.engine.blocksFor(session).toJSON() }), before);
  });

  await check('manual trigger grants exactly one per-session call and dcp-compress declares input', async () => {
    const mounted = await mount({ manualMode: true, automaticStrategies: false, pruneNotification: 'off', strategies: strategiesOff });
    const first = await createSession(mounted);
    const second = await createSession(mounted);
    const firstUser = appendUser(first, 'FIRST');
    const secondUser = appendUser(second, 'SECOND');
    assert.match(mounted.sections.get('dcp:system').text({ scope: first }), /Manual mode is enabled/);
    await assert.rejects(() => compress(mounted, first, firstUser, firstUser, 'NO-PERMIT'), /Manual mode: compress blocked/);
    assert.ok(mounted.commands.get('dcp-compress').input);
    const injected = [];
    const trigger = await mounted.commands.get('dcp-compress').handler(commandInvocation(first, 'focus here', injected));
    assert.equal(trigger.kind, 'success');
    assert.match(allText(injected), /<compress triggered manually>/);
    assert.match(allText(injected), /Additional user focus:\\nfocus here/);
    assert.equal((await compress(mounted, first, firstUser, firstUser, 'ONE-PERMIT')).compressed, true);
    await assert.rejects(() => compress(mounted, first, 'b1', 'b1', 'SECOND-CALL'), /Manual mode: compress blocked/);
    await assert.rejects(() => compress(mounted, second, secondUser, secondUser, 'OTHER-SESSION'), /Manual mode: compress blocked/);
  });

  await check('manual guidance follows real surface order and includes authoritative topics', async () => {
    const mounted = await mount({ manualMode: false, automaticStrategies: false, pruneNotification: 'off', strategies: strategiesOff });
    const session = await createSession(mounted);
    session.append('turn/start', { turn: 1 });
    const first = appendUser(session, 'FIRST-ORIGINAL');
    const second = appendUser(session, 'SECOND-ORIGINAL');
    const third = appendUser(session, 'THIRD-ORIGINAL');
    const fourth = appendUser(session, 'FOURTH-ORIGINAL');
    await compress(mounted, session, fourth, fourth, 'TAIL-SUMMARY', 'Tail topic');
    await compress(mounted, session, second, second, 'MIDDLE-SUMMARY', 'Middle topic');
    await compress(mounted, session, third, third, 'TEMP-SUMMARY', 'Temporary topic');
    await compress(mounted, session, first, first, 'HEAD-SUMMARY', '  Head\n topic  ');
    assert.equal((await command(mounted, session, 'decompress b3')).kind, 'success');

    const visible = mounted.engine.messageReferences(session, { assign: false }).groups
      .filter((group) => group.kind === 'compressed-block')
      .map((group) => group.ref);
    assert.deepEqual(visible, ['b4', 'b2', 'b1'], 'fixture must prove current physical surface order');

    const injected = [];
    assert.equal((await mounted.commands.get('dcp-compress').handler(commandInvocation(session, '', injected))).kind, 'success');
    const prompt = allText(injected);
    assert.match(prompt, /current surface order: 3 \(b4 — \\"Head topic\\"; b2 — \\"Middle topic\\"; b1 — \\"Tail topic\\"\)/);
    assert.doesNotMatch(prompt, /Active compressed blocks in this session: 3 \(b1, b2, b4\)/,
      'the old numerically sorted topic-less shape must remain invalid');
    assert.ok(prompt.indexOf('b4') < prompt.indexOf('b2') && prompt.indexOf('b2') < prompt.indexOf('b1'), prompt);
  });

  await check('/dcp manual is a persisted per-session override', async () => {
    const mounted = await mount({ manualMode: false, strategies: strategiesOff, pruneNotification: 'off' });
    const first = await createSession(mounted);
    const second = await createSession(mounted);
    assert.equal((await command(mounted, first, 'manual on')).kind, 'success');
    assert.equal(mounted.engine.manualModeFor(first), true);
    assert.equal(mounted.engine.manualModeFor(second), false);
    assert.equal(mounted.engine.dcpConfig.manualMode, false);
    assert.equal((await command(mounted, second, 'manual on')).kind, 'success');
    assert.equal((await command(mounted, first, 'manual off')).kind, 'success');
    assert.equal(mounted.engine.manualModeFor(first), false);
    assert.equal(mounted.engine.manualModeFor(second), true);
    const next = await mount({ manualMode: false, strategies: strategiesOff, pruneNotification: 'off' });
    const replay = await createSession(next, { id: String(second.id), seed: second.snapshotEvents() });
    assert.equal(next.engine.manualModeFor(replay), true);
  });

  await check('/dcp sweep 0 uses since-user mode and swept entries retain tool names', async () => {
    const mounted = await mount({ pruneNotification: 'off', strategies: strategiesOff });
    const session = await createSession(mounted);
    appendUser(session, 'FIRST-USER');
    appendExchange(session, { id: 'before-user', name: 'read', args: { x: 1 } }, 'BEFORE');
    appendUser(session, 'LAST-USER');
    appendExchange(session, { id: 'after-user', name: 'bash', args: { command: 'x' } }, 'AFTER');
    const result = await command(mounted, session, 'sweep 0');
    assert.equal(result.kind, 'success');
    const state = mounted.engine.blocksFor(session);
    assert.equal(state.prunedToolIds.has('before-user'), false);
    assert.equal(state.prunedToolIds.has('after-user'), true);
    const other = await createSession(mounted);
    appendUser(other, 'GO');
    appendExchange(other, { id: 'named-sweep', name: 'bash', args: { command: 'y' } }, 'OUT');
    const added = mounted.engine.pruneSession(other, undefined, { nudge: false, sweep: { limit: 1 } });
    assert.equal(added[0].tool, 'bash');

    const automatic = await mount({ pruneNotification: 'off', strategies: { deduplication: { enabled: true }, purgeErrors: { enabled: false } } });
    const automaticSession = await createSession(automatic);
    const compressTarget = appendUser(automaticSession, 'COMPRESS-TARGET');
    appendExchange(automaticSession, { id: 'compress-sweep-1', name: 'read', args: { x: 1 } }, 'ONE');
    appendExchange(automaticSession, { id: 'compress-sweep-2', name: 'read', args: { x: 1 } }, 'TWO');
    const compressed = await compress(automatic, automaticSession, compressTarget, compressTarget, 'TARGET-SUMMARY');
    assert.ok(compressed.swept.some((line) => line.includes('read') && !line.includes('undefined')),
      JSON.stringify(compressed.swept));
  });

  await check('nudge floor, strict ceiling, nudgeForce role, pairing, and request model overrides match upstream', async () => {
    const quiet = await mount({ pruneNotification: 'off', strategies: strategiesOff, compress: { minContextLimit: 100, maxContextLimit: 200, nudgeFrequency: 1, nudgeForce: 'soft' } }, { totalTokens: 99 });
    const quietSession = await createSession(quiet);
    appendUser(quietSession, 'USER');
    appendAssistant(quietSession, [], 'ASSISTANT');
    assert.equal(quiet.engine.evaluateNudge(quietSession).level, 'quiet');
    appendUser(quietSession, 'NEW-USER');
    quiet.meter.total = 200;
    assert.equal(quiet.engine.evaluateNudge(quietSession).level, 'reminder');
    quiet.meter.total = 201;
    assert.equal(quiet.engine.evaluateNudge(quietSession).level, 'strong');

    for (const [force, role] of [['soft', 'assistant'], ['strong', 'user']]) {
      const mounted = await mount({ pruneNotification: 'off', strategies: strategiesOff, compress: { minContextLimit: 0, maxContextLimit: 1000, nudgeForce: force } }, { totalTokens: 500 });
      const session = await createSession(mounted);
      appendUser(session, 'ROLE-USER');
      const call = { id: `pair-${force}`, name: 'read', args: {} };
      const assistant = appendAssistant(session, [call], 'ROLE-ASSISTANT');
      appendResult(session, call, 'ROLE-RESULT');
      const user = appendUser(session, 'ROLE-NEW-USER');
      const { sent } = await send(mounted, session);
      const targetId = role === 'user' ? (user.data?.id ?? user.data?.message?.id) : assistant.data.message.id;
      const target = sent.messages.find((message) => String(message.id) === String(targetId));
      assert.match(allText([target]), /Evaluate the conversation for compressible ranges/);
      const callPart = sent.messages.flatMap((message) => message.content ?? []).find((part) => part.type === 'tool-call');
      const resultPart = sent.messages.map(toolResultOf).find(Boolean);
      assert.equal(callPart.id, resultPart.toolCallId);
    }

    const iteration = await mount({ pruneNotification: 'off', strategies: strategiesOff, compress: { minContextLimit: 0, maxContextLimit: 1000, iterationNudgeThreshold: 2, nudgeFrequency: 5 } }, { totalTokens: 500 });
    const iterationSession = await createSession(iteration);
    appendUser(iterationSession, 'ITERATE');
    appendAssistant(iterationSession, [], 'ITERATION-ONE');
    const iterationLast = appendAssistant(iterationSession, [], 'ITERATION-TWO');
    const iterationSent = await send(iteration, iterationSession);
    const iterationState = iteration.engine.blocksFor(iterationSession);
    assert.equal(iterationState.nudges.iterationAnchors.size, 1);
    assert.equal(iterationState.nudges.turnAnchors.size, 0);
    assert.equal(iterationState.nudges.contextAnchors.size, 0);
    const iterationMessage = iterationSent.sent.messages.find((message) => String(message.id) === String(iterationLast.data.message.id));
    assert.match(allText([iterationMessage]), /You've been iterating for a while/);
    const iterationReload = await mount({ pruneNotification: 'off', strategies: strategiesOff, compress: { minContextLimit: 0, maxContextLimit: 1000, iterationNudgeThreshold: 2, nudgeFrequency: 5 } }, { totalTokens: 500 });
    const iterationReplay = await createSession(iterationReload, { id: String(iterationSession.id), seed: iterationSession.snapshotEvents() });
    assert.equal(iterationReload.engine.blocksFor(iterationReplay).nudges.iterationAnchors.size, 1);

    const clear = await mount({ pruneNotification: 'off', strategies: strategiesOff, compress: { minContextLimit: 0, maxContextLimit: 1000 } }, { totalTokens: 500 });
    const clearSession = await createSession(clear);
    appendAssistant(clearSession, [], 'CLOSED');
    const clearUser = appendUser(clearSession, 'NEW-TURN');
    await send(clear, clearSession);
    assert.ok(clear.engine.blocksFor(clearSession).nudges.turnAnchors.size > 0);
    await compress(clear, clearSession, clearUser, clearUser, 'CLEAR-ANCHORS');
    const cleared = clear.engine.blocksFor(clearSession);
    assert.equal(cleared.nudges.turnAnchors.size + cleared.nudges.contextAnchors.size + cleared.nudges.iterationAnchors.size, 0);
    const afterCompress = await send(clear, clearSession);
    assert.ok(!allText(afterCompress.sent.messages).includes('Evaluate the conversation for compressible ranges'));

    const routed = await mount({ pruneNotification: 'off', strategies: strategiesOff, compress: { minContextLimit: 0, maxContextLimit: 1000, nudgeFrequency: 1, modelMaxLimits: { 'stub/special': 100 } } }, { totalTokens: 200 });
    const special = await createSession(routed);
    appendUser(special, 'SPECIAL');
    const specialSent = await send(routed, special, { provider: 'stub', model: 'special', contextWindow: 2000 });
    assert.match(allText(specialSent.sent.messages), /CRITICAL WARNING/);
    assert.equal(routed.engine.blocksFor(special).requestModelKey, 'stub/special');
  });

  await check('actual summaryTokens and versioned stats/nudges persist and reload', async () => {
    const mounted = await mount({ pruneNotification: 'off', strategies: strategiesOff, compress: { minContextLimit: 0, maxContextLimit: 100, nudgeFrequency: 1, summaryBuffer: true } }, { totalTokens: 120, summaryTokens: 37 });
    const session = await createSession(mounted);
    const user = appendUser(session, 'TOKENS');
    await compress(mounted, session, user, user, 'TOKEN-SUMMARY');
    const state = mounted.engine.blocksFor(session);
    assert.equal(state.get('1').summaryTokens, 37);
    assert.equal(mounted.engine.evaluateNudge(session).ceiling, 137);
    appendUser(session, 'NUDGE-SAVE');
    await send(mounted, session);
    const file = join(home, 'context-kit', 'dcp-state', `${String(session.id)}.json`);
    const document = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(document.version, DCP_STATE_VERSION);
    assert.equal(document.stats.compressions, 1);
    assert.ok(document.nudges.calls > 0);

    const replayId = String(session.id);
    const next = await mount({ pruneNotification: 'off', strategies: strategiesOff });
    const replay = await createSession(next, { id: replayId, seed: session.snapshotEvents() });
    const restored = next.engine.blocksFor(replay);
    assert.equal(restored.stats.compressions, 1);
    assert.ok(restored.nudges.calls > 0);
  });

  await check('PromptStore paths, normalization, and precedence are upstream-compatible', async () => {
    const workspace = join(home, 'workspace', 'nested');
    const project = join(home, 'workspace', '.opencode', 'dcp-prompts', 'overrides');
    const config = join(process.env.OPENCODE_CONFIG_DIR, 'dcp-prompts', 'overrides');
    const global = join(process.env.XDG_CONFIG_HOME, 'opencode', 'dcp-prompts', 'overrides');
    for (const dir of [workspace, project, config, global]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(global, 'turn-nudge.md'), 'GLOBAL', 'utf8');
    writeFileSync(join(config, 'turn-nudge.md'), 'CONFIG', 'utf8');
    writeFileSync(join(project, 'turn-nudge.md'), '\uFEFF<!--comment-->\r\n<dcp-system-reminder>\r\nPROJECT\r\n</dcp-system-reminder>\r\n', 'utf8');
    writeFileSync(join(project, 'system.md'), 'SYSTEM\n<manual>DROP-MANUAL</manual>\n<subagent>DROP-SUBAGENT</subagent>', 'utf8');
    const mounted = await mount({ experimental: { customPrompts: true } }, { workspace });
    const defaults = join(process.env.XDG_CONFIG_HOME, 'opencode', 'dcp-prompts', 'defaults');
    const expectedReferences = ['README.md', 'compress-message.md', 'compress-range.md', 'context-limit-nudge.md', 'iteration-nudge.md', 'system.md', 'turn-nudge.md'];
    assert.deepEqual(readdirSync(defaults).sort(), expectedReferences);
    assert.ok(readdirSync(join(process.env.XDG_CONFIG_HOME, 'opencode', 'dcp-prompts', 'overrides')).length === 1);
    const referenceBefore = expectedReferences.map((file) => readFileSync(join(defaults, file), 'utf8'));
    await mount({ experimental: { customPrompts: true } }, { workspace });
    assert.deepEqual(expectedReferences.map((file) => readFileSync(join(defaults, file), 'utf8')), referenceBefore);
    assert.equal(mounted.engine.customPrompt('turnNudge'), '<dcp-system-reminder>\nPROJECT\n</dcp-system-reminder>');
    assert.equal(mounted.engine.customPrompt('system'), '<dcp-system-reminder>\nSYSTEM\n</dcp-system-reminder>');
    unlinkSync(join(project, 'turn-nudge.md'));
    assert.equal(mounted.engine.customPrompt('turnNudge'), '<dcp-system-reminder>\nCONFIG\n</dcp-system-reminder>');
    unlinkSync(join(config, 'turn-nudge.md'));
    assert.equal(mounted.engine.customPrompt('turnNudge'), '<dcp-system-reminder>\nGLOBAL\n</dcp-system-reminder>');

    const gated = await mount({ experimental: { customPrompts: false }, prompts: { system: 'MUST-NOT-APPLY' } }, { workspace });
    assert.equal(gated.engine.customPrompt('system'), undefined);
    assert.ok(!gated.tools.get('compress').description.includes('MUST-NOT-APPLY'));
  });

  await check('showCompression controls rendered summaries and dcp-compress accepts arguments', async () => {
    for (const showCompression of [false, true]) {
      const mounted = await mount({ pruneNotification: 'off', strategies: strategiesOff, compress: { showCompression } });
      const session = await createSession(mounted);
      const user = appendUser(session, `SHOW-${showCompression}`);
      const args = { topic: 'show', content: [{ startId: alias(mounted.engine, session, user), endId: alias(mounted.engine, session, user), summary: 'RENDERED-SUMMARY' }] };
      const value = await mounted.tools.get('compress').execute(args, execFor(session));
      const rendered = mounted.tools.get('compress').output.render(args, value).map((part) => part.text).join('');
      assert.equal(rendered.includes('RENDERED-SUMMARY'), showCompression);
      assert.ok(mounted.commands.get('dcp-compress').input);
      const schema = mounted.tools.get('compress').parameters.properties;
      assert.equal(schema.topic.description, 'Short label (3-5 words) for the whole batch; canonical location');
      assert.equal(schema.content.description, 'One or more ranges to compress, each with start/end boundaries and a summary');
      assert.equal(schema.content.items.properties.startId.description, 'Message or block ID marking the beginning of range (e.g. m0001, b2)');
      assert.equal(schema.content.items.properties.endId.description, 'Message or block ID marking the end of range (e.g. m0012, b5)');
      assert.equal(schema.content.items.properties.topic.description, 'Fallback when the top-level topic is missing; all non-empty values must match');
    }
    const messageMode = await mount({ strategies: strategiesOff, compress: { mode: 'message' } });
    const messageSchema = messageMode.tools.get('compress').parameters.properties;
    assert.equal(messageSchema.topic.description, "Short label (3-5 words) for the overall batch - e.g., 'Closed Research Notes'");
    assert.equal(messageSchema.content.items.properties.messageId.description, 'Raw message ID to compress (e.g. m0001)');
  });

  await check('purgeErrors strips top-level string inputs only on wire and keeps error output/log immutable', async () => {
    const mounted = await mount({ pruneNotification: 'off', strategies: { deduplication: { enabled: false }, purgeErrors: { enabled: true, turns: 1 } } });
    const session = await createSession(mounted);
    session.append('step/start', { turn: 1, step: 1 });
    appendUser(session, 'GO');
    const call = { id: 'failed-wire', name: 'bash', args: { command: 'x'.repeat(300), nested: { keep: null, text: 'nested-stays' }, count: 2 } };
    appendExchange(session, call, 'ERROR-OUTPUT-STAYS', true);
    session.append('step/start', { turn: 1, step: 2 });
    const logBefore = JSON.stringify(session.snapshotEvents());
    const derivedBefore = JSON.stringify(session.deriveMessages());
    const surfaceBefore = JSON.stringify(session.surface.nodes);
    const added = mounted.engine.pruneSession(session, undefined, { nudge: false });
    assert.equal(added[0].kind, 'error-input');
    assert.equal(JSON.stringify(session.surface.nodes), surfaceBefore);
    const { sent } = await send(mounted, session);
    const toolCall = sent.messages.flatMap((message) => message.content ?? []).find((part) => part.type === 'tool-call' && part.id === 'failed-wire');
    const args = JSON.parse(toolCall.arguments);
    assert.equal(args.command, '[input removed due to failed tool call]');
    assert.deepEqual(args.nested, { keep: null, text: 'nested-stays' });
    assert.equal(args.count, 2);
    assert.match(allText(sent.messages), /ERROR-OUTPUT-STAYS/);
    assert.equal(JSON.stringify(session.snapshotEvents()), logBefore);
    assert.equal(JSON.stringify(session.deriveMessages()), derivedBefore);
  });

  await check('automatic detailed chat notification never creates a model-visible turn', async () => {
    const mounted = await mount({ pruneNotification: 'detailed', pruneNotificationType: 'chat', strategies: { deduplication: { enabled: true }, purgeErrors: { enabled: false } } });
    const session = await createSession(mounted);
    appendUser(session, 'GO');
    appendExchange(session, { id: 'notify-1', name: 'read', args: { x: 1 } }, 'ONE');
    appendExchange(session, { id: 'notify-2', name: 'read', args: { x: 1 } }, 'TWO');
    await tick();
    const beforeEvents = session.snapshotEvents().length;
    const beforeView = JSON.stringify(session.deriveMessages());
    const delivered = [];
    const agent = { session, inject(message) { delivered.push(message); } };
    const signal = new AbortController().signal;
    mounted.root.emit('agent/pre-step', { agent, signal }, () => {});
    assert.equal(delivered.length, 0);
    assert.equal(session.snapshotEvents().length, beforeEvents);
    assert.equal(JSON.stringify(session.deriveMessages()), beforeView);
    mounted.root.emit('agent/pre-step', { agent, signal }, () => {});
    assert.equal(delivered.length, 0);
  });
} finally {
  for (const scope of scopes.reverse()) await scope.dispose();
  rmSync(home, { recursive: true, force: true });
}

console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
