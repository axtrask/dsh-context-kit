/** Stable model-facing DCP message and compressed-block references. */

import { SessionSeq } from '@deepseek-ai/dsh-session';

const MESSAGE_REF_REGEX = /^m(\d{4})$/;
const BLOCK_REF_REGEX = /^b([1-9]\d*)$/;
const MESSAGE_ID_SUFFIX_REGEX = /\n<dcp-message-id(?:\s[^>]*)?>m\d{4}<\/dcp-message-id>\s*$/;
const DCP_PAIRED_TAG_REGEX = /<dcp[^>]*>[\s\S]*?<\/dcp[^>]*>/gi;
const DCP_UNPAIRED_TAG_REGEX = /<\/?dcp[^>]*>/gi;
const HALLUCINATED_PARAMETER_SUFFIX_REGEX = /(?<=\n)m\d+<\/parameter>\s*$/;

export const MESSAGE_REF_MAX_INDEX = 9999;

export function formatMessageRef(index) {
  if (!Number.isInteger(index) || index < 1 || index > MESSAGE_REF_MAX_INDEX) {
    throw new Error(`Message ID index out of bounds: ${index}. Supported range is 0-${MESSAGE_REF_MAX_INDEX}.`);
  }
  return `m${String(index).padStart(4, '0')}`;
}

export function formatBlockRef(blockId) {
  const numeric = Number(blockId);
  if (!Number.isInteger(numeric) || numeric < 1) throw new Error(`Invalid block ID: ${blockId}`);
  return `b${numeric}`;
}

export function parseMessageRef(ref) {
  const match = String(ref ?? '').trim().toLowerCase().match(MESSAGE_REF_REGEX);
  if (match === null) return null;
  const index = Number.parseInt(match[1], 10);
  return index >= 1 && index <= MESSAGE_REF_MAX_INDEX ? index : null;
}

export function parseBlockRef(ref) {
  const match = String(ref ?? '').trim().toLowerCase().match(BLOCK_REF_REGEX);
  if (match === null) return null;
  const id = Number.parseInt(match[1], 10);
  return Number.isInteger(id) ? id : null;
}

export function parseBoundaryId(id) {
  const normalized = String(id ?? '').trim().toLowerCase();
  const messageIndex = parseMessageRef(normalized);
  if (messageIndex !== null) return { kind: 'message', ref: formatMessageRef(messageIndex), index: messageIndex };
  const blockId = parseBlockRef(normalized);
  if (blockId !== null) return { kind: 'compressed-block', ref: formatBlockRef(blockId), blockId };
  return null;
}

function escapeXmlAttribute(value) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function formatMessageIdTag(ref, attributes) {
  const serialized = Object.entries(attributes ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => name.trim().length === 0 || typeof value !== 'string' || value.length === 0
      ? ''
      : ` ${name}="${escapeXmlAttribute(value)}"`)
    .join('');
  return `\n<dcp-message-id${serialized}>${ref}</dcp-message-id>`;
}

export function stripHallucinatedDcpMetadata(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(MESSAGE_ID_SUFFIX_REGEX, '')
    .replace(HALLUCINATED_PARAMETER_SUFFIX_REGEX, '')
    .replace(DCP_PAIRED_TAG_REGEX, '')
    .replace(DCP_UNPAIRED_TAG_REGEX, '');
}

function messageOf(event) {
  return event?.data?.message ?? event?.data;
}

function messageText(message) {
  return (message?.content ?? [])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function isIgnoredUserEvent(event) {
  if (event?.type !== 'user/message') return false;
  const message = messageOf(event);
  if (message?.source?.form === 'notice') return true;
  const content = message?.content;
  return Array.isArray(content) && (content.length === 0 || content.every((part) => part?.ignored === true));
}

function firstSubagentInstructionId(session) {
  if (session?.header?.origin !== 'subagent' && !(Number(session?.header?.delegationDepth) > 0)) return undefined;
  const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : [];
  for (const event of events) {
    if (event?.type !== 'user/message' || isIgnoredUserEvent(event)) continue;
    const id = messageOf(event)?.id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return undefined;
}

function allocateMessageRef(messageIds) {
  let candidate = Number.isInteger(messageIds.nextRef) ? Math.max(1, messageIds.nextRef) : 1;
  while (candidate <= MESSAGE_REF_MAX_INDEX) {
    const ref = formatMessageRef(candidate);
    if (!messageIds.byRef.has(ref)) {
      messageIds.nextRef = candidate + 1;
      return ref;
    }
    candidate += 1;
  }
  throw new Error(`Message ID alias capacity exceeded. Cannot allocate more than ${formatMessageRef(MESSAGE_REF_MAX_INDEX)} aliases in this session.`);
}

/**
 * Build DSH's equivalent of upstream raw messages. Each assistant event owns all
 * completed tool results bound to its call ids, even though DSH projects those
 * result messages with role=user.
 */
export function collectMessageReferences(session, state, options = {}) {
  const nodes = session?.surface?.nodes;
  if (!Array.isArray(nodes)) return { groups: [], byRef: new Map(), byRawId: new Map(), assigned: 0 };
  const messageIds = state.messageIds;
  const blockBySeq = new Map();
  for (const block of state.blocksById?.values?.() ?? []) {
    if (block?.active !== false && Number.isInteger(Number(block.nodeSeq))) blockBySeq.set(Number(block.nodeSeq), Number(block.blockId));
  }

  const groups = [];
  const byCallId = new Map();
  const skippedSubagentId = firstSubagentInstructionId(session);
  let assigned = 0;

  for (let rawIndex = 0; rawIndex < nodes.length; rawIndex += 1) {
    const rawSeq = nodes[rawIndex];
    const seq = Number(rawSeq);
    const event = session.eventAt?.(rawSeq) ?? session.eventAt?.(SessionSeq(seq));
    if (event?.type === 'system/message') continue;

    if (event?.type === 'tool/result') {
      const message = messageOf(event);
      const result = message?.content?.find?.((part) => part?.type === 'tool-result');
      const group = result?.toolCallId === undefined ? undefined : byCallId.get(String(result.toolCallId));
      if (group === undefined) continue;
      group.endIndex = rawIndex;
      group.endSeq = seq;
      if (typeof message?.id === 'string' && message.id.length > 0) {
        group.resultMessageIds.push(message.id);
        if (result.isError !== true) group.completedResultMessageIds.push(message.id);
      }
      continue;
    }

    if (event?.type !== 'user/message' && event?.type !== 'assistant/message') continue;
    const message = messageOf(event);
    const rawMessageId = message?.id;
    if (typeof rawMessageId !== 'string' || rawMessageId.length === 0) continue;

    const registeredBlockId = blockBySeq.get(seq);
    const blockText = messageText(message);
    const trustedBlock = registeredBlockId !== undefined
      && message?.source?.kind === 'plugin:dcp'
      && /^\s*\[Compressed conversation section\]/.test(blockText)
      && new RegExp(`<dcp-message-id>b${registeredBlockId}<\\/dcp-message-id>\\s*$`, 'i').test(blockText);
    const blockId = trustedBlock ? registeredBlockId : undefined;
    if (blockId !== undefined) {
      groups.push({ kind: 'compressed-block', ref: formatBlockRef(blockId), blockId, rawMessageId, startIndex: rawIndex, endIndex: rawIndex, startSeq: seq, endSeq: seq, resultMessageIds: [], completedResultMessageIds: [] });
      continue;
    }

    if (isIgnoredUserEvent(event) || rawMessageId === skippedSubagentId) continue;
    let ref = messageIds.byRawId.get(rawMessageId);
    if (ref === undefined && options.assign !== false) {
      ref = allocateMessageRef(messageIds);
      messageIds.byRawId.set(rawMessageId, ref);
      messageIds.byRef.set(ref, rawMessageId);
      assigned += 1;
    } else if (ref !== undefined && messageIds.byRef.get(ref) !== rawMessageId) {
      messageIds.byRef.set(ref, rawMessageId);
    }
    if (ref === undefined) continue;

    const group = {
      kind: 'message', ref, rawMessageId,
      role: event.type === 'user/message' ? 'user' : 'assistant',
      startIndex: rawIndex, endIndex: rawIndex, startSeq: seq, endSeq: seq,
      resultMessageIds: [],
      completedResultMessageIds: []
    };
    groups.push(group);
    if (event.type === 'assistant/message') {
      for (const part of message.content ?? []) {
        if (part?.type === 'tool-call' && part.id !== undefined) byCallId.set(String(part.id), group);
      }
    }
  }

  return {
    groups,
    byRef: new Map(groups.map((group) => [group.ref, group])),
    byRawId: new Map(groups.filter((group) => group.kind === 'message').map((group) => [group.rawMessageId, group])),
    assigned
  };
}

function appendTextPartTag(content, tag, everyTextPart) {
  if (!Array.isArray(content)) return content;
  const textIndexes = content.flatMap((part, index) => part?.type === 'text' && typeof part.text === 'string' ? [index] : []);
  if (textIndexes.length === 0) return everyTextPart ? [...content, { type: 'text', text: tag.slice(1) }] : content;
  const targets = everyTextPart ? new Set(textIndexes) : new Set([textIndexes.at(-1)]);
  return content.map((part, index) => {
    if (!targets.has(index) || MESSAGE_ID_SUFFIX_REGEX.test(part.text)) return part;
    const base = part.text.replace(/\n*$/, '');
    return { ...part, text: base.length > 0 ? `${base}\n${tag}` : tag.slice(1) };
  });
}

function appendToolResultTag(message, tag) {
  if (!Array.isArray(message?.content)) return message;
  let changed = false;
  const content = message.content.map((part) => {
    if (part?.type !== 'tool-result') return part;
    let output = part.content;
    if (typeof output === 'string') {
      if (output.endsWith(tag)) return part;
      output = `${output}${tag}`;
    } else if (Array.isArray(output)) {
      const textIndexes = output.flatMap((entry, index) => entry?.type === 'text' && typeof entry.text === 'string' ? [index] : []);
      if (textIndexes.length === 0) output = [...output, { type: 'text', text: tag.slice(1) }];
      else {
        const target = textIndexes.at(-1);
        output = output.map((entry, index) => index !== target || MESSAGE_ID_SUFFIX_REGEX.test(entry.text)
          ? entry
          : { ...entry, text: `${entry.text}${tag}` });
      }
    } else {
      output = [{ type: 'text', text: tag.slice(1) }];
    }
    changed = true;
    return { ...part, content: output };
  });
  return changed ? { ...message, content } : message;
}

function sanitizeMessage(message, toolResult) {
  if (!Array.isArray(message?.content)) return message;
  let changed = false;
  const content = message.content.map((part) => {
    if (!toolResult && part?.type === 'text' && typeof part.text === 'string') {
      const text = stripHallucinatedDcpMetadata(part.text);
      if (text !== part.text) {
        changed = true;
        return { ...part, text };
      }
    }
    if (toolResult && part?.type === 'tool-result') {
      if (part.isError === true) return part;
      if (typeof part.content === 'string') {
        const value = stripHallucinatedDcpMetadata(part.content);
        if (value !== part.content) {
          changed = true;
          return { ...part, content: value };
        }
      }
      if (Array.isArray(part.content)) {
        const output = part.content.map((entry) => {
          if (entry?.type !== 'text' || typeof entry.text !== 'string') return entry;
          const text = stripHallucinatedDcpMetadata(entry.text);
          if (text === entry.text) return entry;
          changed = true;
          return { ...entry, text };
        });
        if (changed) return { ...part, content: output };
      }
    }
    return part;
  });
  return changed ? { ...message, content } : message;
}

/** Add aliases only to the provider-bound copy; the session log is untouched. */
export function sanitizeMessageReferences(session, state, messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const references = collectMessageReferences(session, state);
  const trustedBlockIds = new Set(references.groups.filter((group) => group.kind === 'compressed-block').map((group) => group.rawMessageId));
  let changed = false;
  const sanitized = messages.map((message) => {
    const id = message?.id === undefined ? undefined : String(message.id);
    if (id !== undefined && trustedBlockIds.has(id)) return message;
    const toolResult = Array.isArray(message?.content) && message.content.some((part) => part?.type === 'tool-result');
    if (message?.role !== 'user' && message?.role !== 'assistant' && !toolResult) return message;
    const next = sanitizeMessage(message, toolResult);
    if (next !== message) changed = true;
    return next;
  });
  return changed ? sanitized : messages;
}

export function injectMessageReferences(session, state, messages, options = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return { messages, assigned: 0 };
  const references = collectMessageReferences(session, state);
  const sourceMessages = options.sanitize === false ? messages : sanitizeMessageReferences(session, state, messages);
  const byMessageId = new Map();
  for (const group of references.groups) {
    if (group.kind !== 'message') continue;
    byMessageId.set(group.rawMessageId, { group, result: false });
    for (const id of group.completedResultMessageIds) byMessageId.set(id, { group, result: true });
  }

  let changed = false;
  const transformed = sourceMessages.map((message) => {
    const target = message?.id === undefined ? undefined : byMessageId.get(String(message.id));
    if (target === undefined) return message;
    const tag = formatMessageIdTag(target.group.ref);
    if (target.result) {
      const next = appendToolResultTag(message, tag);
      if (next !== message) changed = true;
      return next;
    }
    if (target.group.role === 'assistant' && target.group.completedResultMessageIds.length > 0) {
      return message;
    }
    const content = appendTextPartTag(message.content, tag, target.group.role === 'user');
    if (content === message.content) return message;
    changed = true;
    return { ...message, content };
  });
  return { messages: changed ? transformed : sourceMessages, assigned: references.assigned };
}
