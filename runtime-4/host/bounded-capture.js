import { closeSync, ftruncateSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_CAPTURE_MAX_BYTES_PER_STREAM = 64 * 1024 * 1024;
export const MAX_CAPTURE_MAX_BYTES_PER_STREAM = 1024 * 1024 * 1024;

export function normalizeCaptureMaxBytes(value) {
  const number = Number(value ?? DEFAULT_CAPTURE_MAX_BYTES_PER_STREAM);
  if (!Number.isSafeInteger(number) || number < 2 || number > MAX_CAPTURE_MAX_BYTES_PER_STREAM) {
    throw new RangeError(`captureMaxBytesPerStream must be a safe integer from 2 to ${MAX_CAPTURE_MAX_BYTES_PER_STREAM}`);
  }
  return number;
}

export function capturePaths(tmpDir, stamp) {
  return {
    stdoutHeadPath: join(tmpDir, `${stamp}.stdout.head`),
    stdoutTailPath: join(tmpDir, `${stamp}.stdout.tail`),
    stderrHeadPath: join(tmpDir, `${stamp}.stderr.head`),
    stderrTailPath: join(tmpDir, `${stamp}.stderr.tail`),
    manifestPath: join(tmpDir, `${stamp}.capture.json`),
    controlPath: join(tmpDir, `${stamp}.control.json`),
    brokerPlanPath: join(tmpDir, `${stamp}.broker.json`)
  };
}

export function emptyCapture(paths, stream) {
  const prefix = stream === 'stderr' ? 'stderr' : 'stdout';
  return {
    observedBytes: 0,
    storedBytes: 0,
    droppedBytes: 0,
    truncated: false,
    headBytes: 0,
    tailBytes: 0,
    headLimit: 0,
    tailLimit: 0,
    tailCursor: 0,
    tailWrapped: false,
    headPath: paths[`${prefix}HeadPath`],
    tailPath: paths[`${prefix}TailPath`]
  };
}

export class BoundedCaptureSink {
  constructor(headPath, tailPath, capacity) {
    this.headPath = headPath;
    this.tailPath = tailPath;
    this.capacity = normalizeCaptureMaxBytes(capacity);
    this.headLimit = Math.max(1, Math.min(this.capacity - 1, Math.floor(this.capacity * 0.75)));
    this.tailLimit = this.capacity - this.headLimit;
    this.headBytes = 0;
    this.tailBytes = 0;
    this.tailCursor = 0;
    this.observedBytes = 0;
    this.tailWrapped = false;
    this.finalized = false;
    this.headFd = openSync(headPath, 'w+');
    try {
      this.tailFd = openSync(tailPath, 'w+');
    } catch (error) {
      closeSync(this.headFd);
      throw error;
    }
  }

  write(value) {
    if (this.finalized) throw new Error('cannot write to a finalized capture sink');
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
    this.observedBytes += buffer.length;
    let offset = 0;
    let remaining = buffer.length;

    if (this.headBytes < this.headLimit) {
      const count = Math.min(remaining, this.headLimit - this.headBytes);
      writeSync(this.headFd, buffer, offset, count, this.headBytes);
      this.headBytes += count;
      offset += count;
      remaining -= count;
    }

    while (remaining > 0) {
      const count = Math.min(remaining, this.tailLimit - this.tailCursor);
      writeSync(this.tailFd, buffer, offset, count, this.tailCursor);
      this.tailCursor = (this.tailCursor + count) % this.tailLimit;
      this.tailBytes = Math.min(this.tailLimit, this.tailBytes + count);
      offset += count;
      remaining -= count;
    }
    this.tailWrapped = this.observedBytes > this.capacity;
  }

  snapshot() {
    const storedBytes = this.headBytes + this.tailBytes;
    return {
      observedBytes: this.observedBytes,
      storedBytes,
      droppedBytes: Math.max(0, this.observedBytes - storedBytes),
      truncated: this.observedBytes > storedBytes,
      headBytes: this.headBytes,
      tailBytes: this.tailBytes,
      headLimit: this.headLimit,
      tailLimit: this.tailLimit,
      tailCursor: this.tailCursor,
      tailWrapped: this.tailWrapped,
      headPath: this.headPath,
      tailPath: this.tailPath
    };
  }

  finalize() {
    if (this.finalized) return this.snapshot();
    if (this.tailWrapped && this.tailBytes > 0) {
      const raw = readFileSync(this.tailPath).subarray(0, this.tailBytes);
      const cursor = Math.min(raw.length, this.tailCursor);
      const ordered = Buffer.concat([raw.subarray(cursor), raw.subarray(0, cursor)]);
      writeSync(this.tailFd, ordered, 0, ordered.length, 0);
      ftruncateSync(this.tailFd, ordered.length);
      this.tailCursor = 0;
      this.tailWrapped = false;
    } else {
      ftruncateSync(this.tailFd, this.tailBytes);
    }
    ftruncateSync(this.headFd, this.headBytes);
    this.finalized = true;
    return this.snapshot();
  }

  close() {
    try { closeSync(this.headFd); } catch { }
    try { closeSync(this.tailFd); } catch { }
  }
}

function captureNumber(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function normalizeCapture(value, fallback) {
  if (value === undefined || value === null || typeof value !== 'object') return fallback;
  return {
    observedBytes: captureNumber(value.observedBytes),
    storedBytes: captureNumber(value.storedBytes),
    droppedBytes: captureNumber(value.droppedBytes),
    truncated: value.truncated === true,
    headBytes: captureNumber(value.headBytes),
    tailBytes: captureNumber(value.tailBytes),
    headLimit: captureNumber(value.headLimit),
    tailLimit: captureNumber(value.tailLimit),
    tailCursor: captureNumber(value.tailCursor),
    tailWrapped: value.tailWrapped === true,
    headPath: typeof value.headPath === 'string' ? value.headPath : fallback.headPath,
    tailPath: typeof value.tailPath === 'string' ? value.tailPath : fallback.tailPath
  };
}

export function readCaptureManifest(path, paths) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== 'object') return undefined;
  const stdout = normalizeCapture(value.stdout, emptyCapture(paths, 'stdout'));
  const stderr = normalizeCapture(value.stderr, emptyCapture(paths, 'stderr'));
  return {
    state: value.state === 'final' ? 'final' : 'provisional',
    complete: value.complete === true,
    generation: captureNumber(value.generation),
    updatedAt: captureNumber(value.updatedAt),
    completedSteps: captureNumber(value.completedSteps),
    processId: captureNumber(value.processId) || undefined,
    exitCode: Number.isInteger(value.exitCode) ? value.exitCode : null,
    spawnError: typeof value.spawnError === 'string' && value.spawnError.length > 0 ? value.spawnError : undefined,
    terminationReason: typeof value.terminationReason === 'string' && value.terminationReason.length > 0 ? value.terminationReason : undefined,
    stdout,
    stderr
  };
}

export function writeControlRequest(path, request) {
  const temporary = `${path}.tmp.${process.pid}`;
  writeFileSync(temporary, JSON.stringify(request), 'utf8');
  try { unlinkSync(path); } catch { }
  renameSync(temporary, path);
}
