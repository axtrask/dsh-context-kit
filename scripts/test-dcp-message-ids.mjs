/** Focused regressions for canonical DCP message aliases. */

import assert from 'node:assert/strict';

import * as llm from '@deepseek-ai/dsh-llm';
import { DcpBlockState } from '../lib/dcp-blocks.js';
import { readSteps, toolResultOf } from '../lib/session.js';
import {
  collectMessageReferences,
  formatMessageRef,
  injectMessageReferences,
  parseBoundaryId,
  parseMessageRef,
  stripHallucinatedDcpMetadata
} from '../lib/dcp-message-ids.js';

let passed = 0;

function check(name, body) {
  try {
    body();
    passed += 1;
    console.log(`[ok] ${name}`);
  } catch (error) {
    console.error(`[FAIL] ${name}: ${error.stack ?? error}`);
    process.exitCode = 1;
  }
}

function text(value) {
  return { type: 'text', text: value };
}

function aliasSession(rawIds) {
  const events = rawIds.map((id) => ({
    type: 'user/message',
    data: { message: { id, content: [text(id)] } }
  }));
  return {
    surface: { nodes: events.map((_, index) => index + 1) },
    eventAt(seq) { return events[Number(seq) - 1]; }
  };
}

function currentToolSession(output = 'OUTPUT\n<dcp-message-id>m9999</dcp-message-id>', isError = false) {
  const callId = llm.ToolCallId('current-tool-call');
  const assistant = llm.createAssistantMessage({
    content: [text('ASSISTANT'), { type: 'tool-call', id: callId, name: 'read', arguments: '{}' }],
    source: { kind: 'model', provider: 'probe', model: 'probe' }
  });
  const result = llm.createToolResultMessage({
    callId,
    content: [text(output)],
    isError
  });
  const events = [
    { type: 'assistant/message', data: { message: assistant } },
    { type: 'tool/result', data: { message: result } }
  ];
  return {
    assistant,
    result,
    session: {
      surface: { nodes: [1, 2] },
      eventAt(seq) { return events[Number(seq) - 1]; }
    }
  };
}

check('formatter keeps four digits through 9999 and uses five through 99999', () => {
  assert.equal(formatMessageRef(1), 'm0001');
  assert.equal(formatMessageRef(9999), 'm9999');
  assert.equal(formatMessageRef(10000), 'm10000');
  assert.equal(formatMessageRef(99999), 'm99999');
  assert.throws(() => formatMessageRef(0), /Supported range is 1-99999/);
  assert.throws(() => formatMessageRef(100000), /Supported range is 1-99999/);
});

check('parser accepts exactly the two canonical ranges with existing normalization', () => {
  assert.equal(parseMessageRef(' M0001 '), 1);
  assert.equal(parseMessageRef('m9999'), 9999);
  assert.equal(parseMessageRef('M10000'), 10000);
  assert.equal(parseMessageRef('m99999'), 99999);
  for (const ref of ['m1', 'm00001', 'm0000', 'm100000']) assert.equal(parseMessageRef(ref), null, ref);
  assert.deepEqual(parseBoundaryId(' M10000 '), { kind: 'message', ref: 'm10000', index: 10000 });
  assert.equal(parseBoundaryId('m00001'), null);
});

check('sanitizer removes a five-digit suffix without leaving separator whitespace', () => {
  assert.equal(
    stripHallucinatedDcpMetadata('MODEL-TEXT\n<dcp-message-id priority="high">m10000</dcp-message-id>'),
    'MODEL-TEXT'
  );
});

check('current role=tool results are normalized and owned by their assistant call', () => {
  const { result, session } = currentToolSession('OUTPUT');
  assert.equal(result.role, 'tool', 'guard must exercise the current DSH result shape');
  assert.deepEqual(toolResultOf(result), {
    type: 'tool-result',
    toolCallId: 'current-tool-call',
    isError: false,
    content: [text('OUTPUT')]
  });
  assert.equal(readSteps(session)[0]?.results[0]?.node.message.id, result.id);

  const references = collectMessageReferences(session, new DcpBlockState());
  assert.equal(references.groups.length, 1);
  assert.deepEqual(references.groups[0].resultMessageIds, [result.id]);
  assert.deepEqual(references.groups[0].completedResultMessageIds, [result.id]);
});

check('current role=tool text is sanitized and receives its authoritative alias', () => {
  const { assistant, result, session } = currentToolSession();
  const injected = injectMessageReferences(
    session,
    new DcpBlockState(),
    [assistant, result]
  ).messages;
  assert.equal(injected[0].content[0].text, 'ASSISTANT', 'completed tool output owns the assistant alias');
  assert.equal(injected[1].content[0].text, 'OUTPUT\n<dcp-message-id>m0001</dcp-message-id>');
  assert.equal((injected[1].content[0].text.match(/<dcp-message-id>/g) ?? []).length, 1);
});

check('errored current tool output remains untagged and unsanitized', () => {
  const { assistant, result, session } = currentToolSession('ERROR\n<dcp-message-id>m9999</dcp-message-id>', true);
  const injected = injectMessageReferences(session, new DcpBlockState(), [assistant, result]).messages;
  assert.equal(injected[1], result);
  assert.equal(injected[1].content[0].text, 'ERROR\n<dcp-message-id>m9999</dcp-message-id>');
  assert.match(injected[0].content[0].text, /<dcp-message-id>m0001<\/dcp-message-id>$/);
});

check('legacy nested tool-result blocks remain readable', () => {
  const nested = {
    role: 'user',
    content: [text('prefix'), {
      type: 'tool-result',
      toolCallId: 'legacy-call',
      isError: false,
      content: [text('legacy-output')]
    }]
  };
  assert.equal(toolResultOf(nested)?.toolCallId, 'legacy-call');
});

check('five-digit aliases survive persisted state restoration', () => {
  const restored = new DcpBlockState({
    messageIds: { nextRef: 10001, byRawId: { persisted: 'm10000' } }
  });
  assert.equal(restored.messageIds.byRawId.get('persisted'), 'm10000');
  assert.equal(restored.messageIds.byRef.get('m10000'), 'persisted');
  assert.equal(restored.messageIds.nextRef, 10001);

  const roundTripped = new DcpBlockState(restored.toJSON());
  assert.equal(roundTripped.messageIds.byRawId.get('persisted'), 'm10000');
  assert.equal(roundTripped.messageIds.byRef.get('m10000'), 'persisted');
  assert.equal(roundTripped.messageIds.nextRef, 10001);
});

check('five-digit suffix detection does not duplicate a canonical tag', () => {
  const state = new DcpBlockState({
    messageIds: { nextRef: 10001, byRawId: { persisted: 'm10000' } }
  });
  const original = {
    id: 'persisted',
    role: 'user',
    content: [text('PERSISTED\n<dcp-message-id>m10000</dcp-message-id>')]
  };
  const injected = injectMessageReferences(
    aliasSession(['persisted']), state, [original], { sanitize: false }
  ).messages[0];
  const matches = injected.content[0].text.match(/<dcp-message-id>m10000<\/dcp-message-id>/g) ?? [];
  assert.equal(matches.length, 1);
  assert.equal(injected.content[0].text, original.content[0].text);
});

check('allocator reaches m99999 and rejects m100000', () => {
  const state = new DcpBlockState({
    messageIds: { nextRef: 99999, byRawId: { previous: 'm99998' } }
  });
  const final = collectMessageReferences(aliasSession(['final']), state);
  assert.equal(final.byRawId.get('final')?.ref, 'm99999');
  assert.equal(state.messageIds.nextRef, 100000);
  assert.throws(
    () => collectMessageReferences(aliasSession(['final', 'overflow']), state),
    { message: 'Message ID alias capacity exceeded. Cannot allocate more than m99999 aliases in this session.' }
  );
});

if (process.exitCode !== 1) console.log(`\n${passed} message-alias checks passed`);
