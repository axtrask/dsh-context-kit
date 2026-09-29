/**
 * Production-boundary checks for DCP's stable canonical message aliases.
 *
 * Run: node scripts/test-dcp-tags.mjs
 */

import { Context } from '@deepseek-ai/cordis';
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session';
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file';
import * as llm from '@deepseek-ai/dsh-llm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as dcp from '../lib/dcp.js';
import * as dcpPlugin from '../lib/dcp-plugin.js';
import { DcpBlockState } from '../lib/dcp-blocks.js';
import { formatMessageIdTag, formatMessageRef, parseBoundaryId, parseMessageRef } from '../lib/dcp-message-ids.js';
import { editStoreFor } from '../lib/edit-bridge.js';
import { editableIndex } from '../lib/edit-durable.js';

const failures = [];
const stateHome = mkdtempSync(join(tmpdir(), 'dcp-tags-state-'));
const previousDshHome = process.env.DSH_HOME;
process.env.DSH_HOME = stateHome;

check('message refs use four digits through 9999 and five digits through 99999',
  formatMessageRef(1) === 'm0001'
  && formatMessageRef(9999) === 'm9999'
  && formatMessageRef(10000) === 'm10000'
  && formatMessageRef(99999) === 'm99999');
check('message parsing accepts both canonical widths and keeps normalization',
  parseMessageRef(' M0001 ') === 1
  && parseMessageRef('m9999') === 9999
  && parseMessageRef('M10000') === 10000
  && parseMessageRef('m99999') === 99999);
check('message parsing rejects noncanonical and out-of-capacity forms',
  ['m1', 'm00001', 'm0000', 'm100000'].every((ref) => parseMessageRef(ref) === null));
check('boundary parsing accepts canonical message/block refs only', parseBoundaryId(' M10000 ')?.ref === 'm10000'
  && parseBoundaryId('b12')?.blockId === 12 && parseBoundaryId('m00001') === null && parseBoundaryId('7') === null);
check('message-id tag attributes are sorted and escaped', formatMessageIdTag('m0001', { z: '<x>', a: '"' }) === '\n<dcp-message-id a="&quot;" z="&lt;x&gt;">m0001</dcp-message-id>');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const text = (value) => ({ type: 'text', text: value });

function check(name, ok, detail = '') {
  console.log(`${ok ? '[ok]  ' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

function makeRoot() {
  const context = new Context();
  const runtime = new llm.LlmRuntime(context);
  const calls = [];
  class CaptureAdapter extends llm.LlmAdapter {
    async prepareCall(provider, model, signal) {
      return { model: await this.resolveModel(provider, model, signal), stream: (options) => this.stream(options) };
    }
    async *stream(options) {
      calls.push(options);
      yield { type: 'text', delta: 'x' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  runtime.registerAdapter(['stub'], new CaptureAdapter());
  context.provide('tools', { register: () => () => {} });
  context.provide('tokenMeter', {
    estimateMessage: (message) => JSON.stringify(message?.content ?? message ?? '').length,
    measure: () => ({ nodes: [] })
  });
  const store = new SessionStore(context);
  return { context, runtime, calls, store };
}

async function createSession(store, id) {
  const session = store.create(SessionId(id), { meta: { cwd: process.cwd() } });
  for (let attempt = 0; attempt < 50 && store.get(session.id) === undefined; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return session;
}

function appendAssistant(session, content, step) {
  return session.append('assistant/message', {
    turn: 1,
    step,
    stream: [],
    message: llm.createAssistantMessage({
      content,
      source: { kind: 'model', provider: 'stub', model: 'stub' }
    })
  }, { surfaceOp: 'append' });
}

function messageFrom(event) {
  return event?.data?.message ?? event?.data;
}

function textOf(message) {
  return (message?.content ?? []).filter((block) => block?.type === 'text').map((block) => block.text).join('');
}

function toolTextOf(message) {
  return (message?.content ?? [])
    .filter((block) => block?.type === 'tool-result')
    .flatMap((block) => Array.isArray(block.content) ? block.content : [{ type: 'text', text: String(block.content ?? '') }])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('');
}

async function drain(runtime, request) {
  for await (const _chunk of runtime.stream(request)) { /* drain */ }
}

const { context, runtime, calls, store } = makeRoot();
const warnings = [];
context.logger.warn = (...args) => warnings.push(args.map(String).join(' '));
const fiber = context.plugin(dcp, {
  manualMode: true,
  automaticStrategies: false,
  experimental: { allowSubAgents: true },
  editor: { enabled: true, requireIdle: false }
});
await new Promise((resolve) => setTimeout(resolve, 250));

const runId = `${process.pid}-${Date.now()}`;
const target = await createSession(store, `dcp-tags-target-${runId}`);
target.append('turn/start', { turn: 1 });
const systemEvent = target.append('system/message', {
  message: llm.createSystemMessage('TARGET-SYSTEM', 'fixture')
}, { surfaceOp: 'append' });
const ignoredEvent = target.append('user/message', llm.createUserMessage({
  content: [text('TARGET-IGNORED-NOTICE')],
  source: { kind: 'plugin:fixture', form: 'notice' }
}), { surfaceOp: 'append' });
const userEvent = target.append('user/message', llm.createUserMessage({
  content: [text('TARGET-QUESTION')],
  source: { kind: 'user' }
}), { surfaceOp: 'append' });
const callId = llm.ToolCallId('dcp-tags-call-1');
const secondCallId = llm.ToolCallId('dcp-tags-call-2');
const callEvent = appendAssistant(target, [
  { type: 'reasoning', text: 'TARGET-THINKING' },
  { type: 'tool-call', id: callId, name: 'probe', arguments: '{}' },
  { type: 'tool-call', id: secondCallId, name: 'probe', arguments: '{"second":true}' }
], 1);
const resultEvent = target.append('tool/result', {
  turn: 1,
  step: 1,
  message: llm.createToolResultMessage({
    callId,
    content: [text('TARGET-RESULT')],
    isError: false
  })
}, { surfaceOp: 'append' });
const secondResultEvent = target.append('tool/result', {
  turn: 1,
  step: 1,
  message: llm.createToolResultMessage({
    callId: secondCallId,
    content: [text('TARGET-RESULT-TWO')],
    isError: false
  })
}, { surfaceOp: 'append' });
const finalEvent = appendAssistant(target, [text('TARGET-FINAL')], 2);
const blockEvent = target.append('user/message', llm.createUserMessage({
  content: [text('[Compressed conversation section]\nBLOCK-SEVEN\n\n<dcp-message-id>b7</dcp-message-id>')],
  source: { kind: 'plugin:dcp', form: 'notice', summary: 'block seven' }
}), { surfaceOp: 'append' });
dcp.engineForTest().blocksFor(target).restore({
  blockId: '7', summary: '[Compressed conversation section]\nBLOCK-SEVEN\n\n<dcp-message-id>b7</dcp-message-id>',
  anchorMessageId: String(messageFrom(blockEvent)?.id), shadowedMessageIds: [String(messageFrom(blockEvent)?.id)],
  shadowedSeqs: [Number(blockEvent.seq)], nodeSeq: Number(blockEvent.seq), active: true
});
await tick();

const other = await createSession(store, `dcp-tags-other-${runId}`);
other.append('turn/start', { turn: 1 });
for (let index = 0; index < 8; index += 1) {
  other.append('user/message', llm.createUserMessage({ content: [text(`OTHER-${index}`)], source: { kind: 'user' } }), { surfaceOp: 'append' });
}
dcp.engineForTest()._lastSession = other;

const sessionId = String(target.id);
const wireStore = editStoreFor(sessionId);
const finalEntry = editableIndex(target).find((entry) => entry.id === messageFrom(finalEvent)?.id);
const recorded = wireStore?.record(sessionId, finalEntry?.message, 'TARGET-FINAL-EDITED', {
  messageIndex: finalEntry?.index,
  messageId: finalEntry?.id,
  expected: finalEntry?.text
});
check('the production editor store accepts the fixture edit', recorded?.ok === true, String(recorded?.reason ?? ''));

const logBefore = JSON.stringify(target.snapshotEvents());
const derived = target.deriveMessages();
const derivedBefore = JSON.stringify(derived);
const request = llm.markAgentLoopRequest(Object.freeze({
  provider: 'stub',
  model: 'stub',
  messages: derived,
  sessionId,
  signal: undefined
}));
const requestBefore = JSON.stringify(request);
await drain(runtime, request);
await tick();

const sent = calls.at(-1);
const byId = new Map((sent?.messages ?? []).filter((message) => message?.id !== undefined).map((message) => [String(message.id), message]));
const sentUser = byId.get(String(messageFrom(userEvent)?.id));
const sentSystem = byId.get(String(messageFrom(systemEvent)?.id));
const sentIgnored = byId.get(String(messageFrom(ignoredEvent)?.id));
const sentCall = byId.get(String(messageFrom(callEvent)?.id));
const sentResult = byId.get(String(messageFrom(resultEvent)?.id));
const sentSecondResult = byId.get(String(messageFrom(secondResultEvent)?.id));
const sentFinal = byId.get(String(messageFrom(finalEvent)?.id));
const sentBlock = byId.get(String(messageFrom(blockEvent)?.id));

console.log('--- request-owned wire tags ---');
check('the adapter received exactly one request', calls.length === 1, `calls=${calls.length}`);
check('the target user receives the first stable alias as an exact suffix', textOf(sentUser) === 'TARGET-QUESTION\n\n<dcp-message-id>m0001</dcp-message-id>', textOf(sentUser));
check('system messages receive no alias', !JSON.stringify(sentSystem).includes('dcp-message-id'), JSON.stringify(sentSystem));
check('ignored notices receive no alias and consume no number', textOf(sentIgnored) === 'TARGET-IGNORED-NOTICE', textOf(sentIgnored));
check('a tool-call-only assistant does not get a synthetic top-level text part', textOf(sentCall) === '', textOf(sentCall));
check('the assistant tool call is preserved', sentCall?.content?.some((block) => block?.type === 'tool-call' && block.id === callId) === true);
check('the editor runs before the DCP alias suffix', textOf(sentFinal) === 'TARGET-FINAL-EDITED\n\n<dcp-message-id>m0003</dcp-message-id>', textOf(sentFinal));
check('a compressed block receives only its bN reference', textOf(sentBlock).endsWith('<dcp-message-id>b7</dcp-message-id>') && !textOf(sentBlock).includes('<dcp-message-id>m'), textOf(sentBlock));
check('poisoning _lastSession cannot select the other session', !(sent?.messages ?? []).some((message) => textOf(message).includes('OTHER-')));

console.log('--- tool and durability invariants ---');
const originalResult = derived.find((message) => String(message?.id) === String(messageFrom(resultEvent)?.id));
check('the tool result is changed only on the provider-bound copy', JSON.stringify(sentResult) !== JSON.stringify(originalResult));
check('the tool-result has no top-level text block', !sentResult?.content?.some((block) => block?.type === 'text'));
check('the first completed output carries the assistant alias', toolTextOf(sentResult) === 'TARGET-RESULT\n<dcp-message-id>m0002</dcp-message-id>', toolTextOf(sentResult));
check('multiple completed outputs share that same assistant alias', toolTextOf(sentSecondResult) === 'TARGET-RESULT-TWO\n<dcp-message-id>m0002</dcp-message-id>', toolTextOf(sentSecondResult));
const toolCall = sentCall?.content?.find((block) => block?.type === 'tool-call');
const toolResult = sentResult?.content?.find((block) => block?.type === 'tool-result');
check('tool call/result ids still pair', toolCall?.id === toolResult?.toolCallId, `${toolCall?.id} / ${toolResult?.toolCallId}`);
const secondToolCall = sentCall?.content?.find((block) => block?.type === 'tool-call' && block.id === secondCallId);
const secondToolResult = sentSecondResult?.content?.find((block) => block?.type === 'tool-result');
check('the second call/result pair also stays intact', secondToolCall?.id === secondToolResult?.toolCallId);
check('the session log is byte-identical', JSON.stringify(target.snapshotEvents()) === logBefore);
check('deriveMessages remains byte-identical', JSON.stringify(target.deriveMessages()) === derivedBefore);
check('the frozen original request is byte-identical', JSON.stringify(request) === requestBefore);
check('the original request keeps its agent-loop marker', llm.isAgentLoopRequest(request));
check('the transformed request does not make a false log-reconstruction claim', !llm.isAgentLoopRequest(sent));
const overlayWarnings = warnings.filter((line) => /turn tag overlay|wire overlay failed/u.test(line));
check('the overlay emitted no warning', overlayWarnings.length === 0, overlayWarnings.join(' | '));
const serializedAliases = dcp.engineForTest().blocksFor(target).toJSON();
const restoredAliases = new DcpBlockState(JSON.parse(JSON.stringify(serializedAliases)));
check('raw-id aliases survive the persisted state round trip', restoredAliases.messageIds.byRawId.get(String(messageFrom(userEvent)?.id)) === 'm0001'
  && restoredAliases.messageIds.byRawId.get(String(messageFrom(callEvent)?.id)) === 'm0002');

console.log('--- executable broken shape ---');
const naive = derived.map((message) => message.role === 'user'
  ? { ...message, content: [{ type: 'text', text: '[999]' }, ...(message.content ?? [])] }
  : message);
const naiveResult = naive.find((message) => String(message?.id) === String(messageFrom(resultEvent)?.id));
check('tagging every user-role message WOULD contaminate a tool result', naiveResult?.content?.some((block) => block?.type === 'text') === true);

console.log('--- aliases are scoped per request session ---');
const otherBefore = JSON.stringify(other.snapshotEvents());
await drain(runtime, {
  provider: 'stub', model: 'stub', messages: other.deriveMessages(), sessionId: String(other.id), signal: undefined
});
const otherSent = calls.at(-1);
check('a second session starts independently at m0001', textOf(otherSent?.messages?.[0]) === 'OTHER-0\n\n<dcp-message-id>m0001</dcp-message-id>', textOf(otherSent?.messages?.[0]));
check('tagging the second session leaves its durable log byte-identical', JSON.stringify(other.snapshotEvents()) === otherBefore);

console.log('--- subagent first instruction ---');
const subagent = store.create(SessionId(`dcp-tags-subagent-${runId}`), {
  meta: { cwd: process.cwd(), origin: 'subagent', delegationDepth: 1 }
});
for (let attempt = 0; attempt < 50 && store.get(subagent.id) === undefined; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
subagent.append('turn/start', { turn: 1 });
const subagentInstruction = subagent.append('user/message', llm.createUserMessage({ content: [text('SUBAGENT-INSTRUCTION')], source: { kind: 'user' } }), { surfaceOp: 'append' });
const subagentReply = appendAssistant(subagent, [text('SUBAGENT-REPLY')], 1);
await drain(runtime, { provider: 'stub', model: 'stub', messages: subagent.deriveMessages(), sessionId: String(subagent.id), signal: undefined });
const subagentSent = new Map(calls.at(-1).messages.map((message) => [String(message.id), message]));
check('the first subagent instruction has no alias', textOf(subagentSent.get(String(messageFrom(subagentInstruction)?.id))) === 'SUBAGENT-INSTRUCTION');
check('the next subagent message starts at m0001', textOf(subagentSent.get(String(messageFrom(subagentReply)?.id))) === 'SUBAGENT-REPLY\n\n<dcp-message-id>m0001</dcp-message-id>');

await fiber.dispose();

console.log('--- independent profile entrypoint ---');
const profileHome = mkdtempSync(join(tmpdir(), 'dcp-tags-profile-'));
const profileRoot = makeRoot();
const settingsFiber = profileRoot.context.plugin(FileSettingsProvider, {
  path: join(profileHome, 'settings.yaml'),
  watch: false
});
await settingsFiber.await();
const profileFiber = profileRoot.context.plugin(dcpPlugin, {
  manualMode: true,
  automaticStrategies: false
});
await profileFiber.await();
const profileSession = await createSession(profileRoot.store, `dcp-tags-independent-${runId}`);
profileSession.append('turn/start', { turn: 1 });
const profileUser = profileSession.append('user/message', llm.createUserMessage({
  content: [text('PROFILE-QUESTION')],
  source: { kind: 'user' }
}), { surfaceOp: 'append' });
const profileAssistant = appendAssistant(profileSession, [text('PROFILE-ANSWER')], 1);
await drain(profileRoot.runtime, {
  provider: 'stub',
  model: 'stub',
  messages: profileSession.deriveMessages(),
  sessionId: String(profileSession.id),
  signal: undefined
});
const profileSent = profileRoot.calls.at(-1);
const profileById = new Map((profileSent?.messages ?? []).map((message) => [String(message?.id), message]));
check('the independent plugin resolves the request session through its isolated context',
  textOf(profileById.get(String(messageFrom(profileUser)?.id))) === 'PROFILE-QUESTION\n\n<dcp-message-id>m0001</dcp-message-id>');
check('the independent plugin tags assistant turns at the adapter boundary',
  textOf(profileById.get(String(messageFrom(profileAssistant)?.id))) === 'PROFILE-ANSWER\n\n<dcp-message-id>m0002</dcp-message-id>');
await profileFiber.dispose();
await settingsFiber.dispose();
rmSync(profileHome, { recursive: true, force: true });
rmSync(stateHome, { recursive: true, force: true });
if (previousDshHome === undefined) delete process.env.DSH_HOME;
else process.env.DSH_HOME = previousDshHome;

console.log(failures.length === 0 ? '\nall DCP tag tests passed' : `\n${failures.length} failure(s)`);
process.exit(failures.length === 0 ? 0 : 1);
