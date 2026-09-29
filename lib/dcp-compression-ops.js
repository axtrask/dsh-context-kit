import { createHash } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';

import { kitDir } from './common.js';

export const COMPRESSION_OPERATION_PHASES = Object.freeze([
  'planned',
  'prune_landed',
  'replacement_landed',
  'registry_persisted',
  'committed'
]);

export const COMPRESSION_OPERATION_TERMINALS = Object.freeze(['committed', 'failed', 'superseded']);

const PHASE_INDEX = new Map(COMPRESSION_OPERATION_PHASES.map((phase, index) => [phase, index]));
const VALID_PHASES = new Set([...COMPRESSION_OPERATION_PHASES, ...COMPRESSION_OPERATION_TERMINALS]);
let temporaryCounter = 0;

function durableDirectorySync(path) {
  if (process.platform === 'win32') return;
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Atomically replace one JSON document and force its bytes to stable storage. */
export function writeDurableJson(path, value) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${path}.${process.pid}.${temporaryCounter += 1}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, 'w', 0o600);
    writeFileSync(descriptor, serialized, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    durableDirectorySync(directory);
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* preserve the first failure */ }
    }
    try { unlinkSync(temporary); } catch { /* the rename may already have landed */ }
    throw error;
  }
}

function sessionFileKey(sessionId) {
  const source = String(sessionId);
  const readable = source.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 48) || 'session';
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 16);
  return `${readable}-${digest}`;
}

export function compressionOperationJournalPath(sessionId) {
  return join(kitDir('dcp-operations'), `${sessionFileKey(sessionId)}.json`);
}

function emptyJournal(sessionId) {
  return { version: 1, sessionId: String(sessionId), operations: [] };
}

function validateOperation(raw, sessionId) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`DCP compression journal for ${sessionId} contains a non-object operation`);
  }
  if (typeof raw.operationId !== 'string' || raw.operationId.length === 0) {
    throw new Error(`DCP compression journal for ${sessionId} contains an operation without an id`);
  }
  if (!VALID_PHASES.has(raw.phase)) {
    throw new Error(`DCP compression operation ${raw.operationId} has invalid phase ${JSON.stringify(raw.phase)}`);
  }
  if (typeof raw.batchId !== 'string' || raw.batchId.length === 0
    || (typeof raw.blockId !== 'string' && typeof raw.blockId !== 'number')) {
    throw new Error(`DCP compression operation ${raw.operationId} has invalid batch or block identity`);
  }
  if (raw.plan === null || typeof raw.plan !== 'object' || Array.isArray(raw.plan)) {
    throw new Error(`DCP compression operation ${raw.operationId} has no durable plan`);
  }
  const { reservation, block, materialization, replacementMessageId, statsDelta } = raw.plan;
  if (!Number.isInteger(reservation?.nextRunId) || !Number.isInteger(reservation?.nextBlockId)
    || block === null || typeof block !== 'object' || String(block.blockId) !== String(raw.blockId)
    || materialization === null || typeof materialization !== 'object'
    || !Array.isArray(materialization.shadowedSeqs) || materialization.shadowedSeqs.length === 0
    || typeof replacementMessageId !== 'string' || replacementMessageId.length === 0
    || !Number.isFinite(statsDelta?.compressions) || !Number.isFinite(statsDelta?.compressionNodes)) {
    throw new Error(`DCP compression operation ${raw.operationId} has an incomplete durable plan`);
  }
  raw.blockId = String(raw.blockId);
  return raw;
}

function readJournal(path, sessionId) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyJournal(sessionId);
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`DCP compression journal for ${sessionId} is unreadable: ${error.message}`, { cause: error });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)
    || parsed.version !== 1 || parsed.sessionId !== String(sessionId) || !Array.isArray(parsed.operations)) {
    throw new Error(`DCP compression journal for ${sessionId} has an unsupported shape`);
  }
  const seen = new Set();
  for (const operation of parsed.operations) {
    validateOperation(operation, sessionId);
    if (seen.has(operation.operationId)) {
      throw new Error(`DCP compression journal for ${sessionId} repeats operation ${operation.operationId}`);
    }
    seen.add(operation.operationId);
  }
  return parsed;
}

function snapshot(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Durable, fail-closed sidecar for one session's compression operations. */
export class CompressionOperationJournal {
  constructor(sessionId) {
    this.sessionId = String(sessionId);
    this.path = compressionOperationJournalPath(this.sessionId);
    this.document = readJournal(this.path, this.sessionId);
  }

  operations() {
    return this.document.operations;
  }

  get(operationId) {
    return this.document.operations.find((operation) => operation.operationId === operationId);
  }

  persist() {
    writeDurableJson(this.path, this.document);
  }

  planBatch(operations) {
    if (!Array.isArray(operations) || operations.length === 0) throw new Error('a compression operation batch cannot be empty');
    const previous = snapshot(this.document);
    try {
      for (const raw of operations) {
        const operation = validateOperation(snapshot(raw), this.sessionId);
        if (operation.phase !== 'planned') throw new Error(`new compression operation ${operation.operationId} must start as planned`);
        const existing = this.get(operation.operationId);
        if (existing !== undefined) {
          if (JSON.stringify(existing) !== JSON.stringify(operation)) {
            throw new Error(`compression operation ${operation.operationId} already exists with different intent`);
          }
          continue;
        }
        this.document.operations.push(operation);
      }
      this.persist();
    } catch (error) {
      this.document = previous;
      throw error;
    }
  }

  transition(operationId, phase, details = {}) {
    if (!VALID_PHASES.has(phase)) throw new Error(`invalid compression operation phase ${JSON.stringify(phase)}`);
    const operation = this.get(operationId);
    if (operation === undefined) throw new Error(`unknown compression operation ${operationId}`);
    if (operation.phase === phase) return operation;
    if (COMPRESSION_OPERATION_TERMINALS.includes(operation.phase)) {
      throw new Error(`compression operation ${operationId} is already terminal at ${operation.phase}`);
    }
    const currentIndex = PHASE_INDEX.get(operation.phase);
    const nextIndex = PHASE_INDEX.get(phase);
    const isSequential = currentIndex !== undefined && nextIndex === currentIndex + 1;
    const isTerminal = phase === 'failed' || phase === 'superseded';
    if (!isSequential && !isTerminal) {
      throw new Error(`compression operation ${operationId} cannot transition from ${operation.phase} to ${phase}`);
    }

    const previous = snapshot(this.document);
    try {
      operation.phase = phase;
      operation.updatedAt = new Date().toISOString();
      Object.assign(operation, snapshot(details));
      this.persist();
      return operation;
    } catch (error) {
      this.document = previous;
      throw error;
    }
  }

  advance(operationId, targetPhase, detailsByPhase = {}) {
    const targetIndex = PHASE_INDEX.get(targetPhase);
    if (targetIndex === undefined) throw new Error(`cannot advance to non-progress phase ${targetPhase}`);
    let operation = this.get(operationId);
    let currentIndex = PHASE_INDEX.get(operation?.phase);
    if (currentIndex === undefined) return operation;
    while (currentIndex < targetIndex) {
      const nextPhase = COMPRESSION_OPERATION_PHASES[currentIndex + 1];
      operation = this.transition(operationId, nextPhase, detailsByPhase[nextPhase] ?? {});
      currentIndex += 1;
    }
    return operation;
  }
}

function operationMessage(event) {
  return event?.data?.message ?? event?.data;
}

/** Locate exact known-event evidence for one durable operation. */
export function compressionOperationEvidence(session, operation) {
  const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : [];
  const prunes = [];
  const replacements = [];
  for (const event of events) {
    if (event?.type === 'compaction/prune' && event.data?.dcpOperationId === operation.operationId) {
      prunes.push(event);
      continue;
    }
    if (event?.type !== 'user/message') continue;
    const message = operationMessage(event);
    if (message?.id !== operation.plan?.replacementMessageId) continue;
    if (message?.source?.kind !== 'plugin:dcp') continue;
    replacements.push(event);
  }
  return { prunes, replacements };
}

function assertCurrentRange(session, materialization) {
  const nodes = [...(session?.surface?.nodes ?? [])];
  const shadowedSeqs = materialization.shadowedSeqs;
  const startIndex = nodes.indexOf(materialization.start);
  const endIndex = nodes.indexOf(materialization.end);
  if (startIndex === -1 || endIndex === -1 || startIndex > endIndex) {
    throw new Error(`summary range ${materialization.start}..${materialization.end} changed after durable planning`);
  }
  const current = nodes.slice(startIndex, endIndex + 1);
  if (current.length !== shadowedSeqs.length || current.some((seq, index) => Number(seq) !== Number(shadowedSeqs[index]))) {
    throw new Error(`summary range ${materialization.start}..${materialization.end} changed after durable planning`);
  }
}

/** Append only the known compaction/prune half of a durable compression operation. */
export function appendCompressionPrune(session, operation) {
  const materialization = operation.plan.materialization;
  assertCurrentRange(session, materialization);
  const shadowedSeqs = materialization.shadowedSeqs;
  return session.append('compaction/prune', {
    shadowedRange: { start: shadowedSeqs[0], end: shadowedSeqs[shadowedSeqs.length - 1] },
    shadowedSeqs,
    shadowedTokenCount: materialization.prepared.tokens,
    ...(materialization.prepared.summary !== undefined ? { summary: materialization.prepared.summary } : {}),
    dcpOperationId: operation.operationId,
    dcpBatchId: operation.batchId,
    dcpBlockId: operation.blockId
  });
}

/** Append only the stable user/message half of a durable compression operation. */
export function appendCompressionReplacement(session, operation) {
  const materialization = operation.plan.materialization;
  assertCurrentRange(session, materialization);
  const replacement = materialization.replacement;
  if (replacement.data?.id !== operation.plan.replacementMessageId
    || replacement.data?.source?.kind !== 'plugin:dcp'
    || replacement.data?.source?.dcpOperationId !== operation.operationId) {
    throw new Error(`compression operation ${operation.operationId} has inconsistent replacement identity`);
  }
  return session.append('user/message', replacement.data, {
    surfaceOp: replacement.surfaceOp,
    sourceEventSeqs: materialization.shadowedSeqs
  });
}
