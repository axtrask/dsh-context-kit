/** Regression tests for atomic DCP JSON persistence on Windows-style rename contention. */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeDurableJson } from '../lib/dcp-compression-ops.js';

const root = mkdtempSync(join(tmpdir(), 'dsh-dcp-durable-json-'));

function transient(code) {
  const error = new Error(`synthetic ${code}`);
  error.code = code;
  return error;
}

function temporaryFilesFor(target) {
  const prefix = `${target.split(/[\\/]/).at(-1)}.`;
  return readdirSync(root).filter((name) => name.startsWith(prefix) && name.endsWith('.tmp'));
}

try {
  const target = join(root, 'state.json');
  assert.equal(writeDurableJson(target, { version: 0, value: 'old' }), true);

  let attempts = 0;
  const waits = [];
  const temporaryPaths = [];
  const written = writeDurableJson(target, { version: 1, value: 'stable' }, {
    renameSync(source, destination) {
      attempts += 1;
      temporaryPaths.push(source);
      assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { version: 0, value: 'old' });
      if (attempts < 3) throw transient(attempts === 1 ? 'EPERM' : 'EACCES');
      renameSync(source, destination);
    },
    sleepSync(milliseconds) {
      waits.push(milliseconds);
    },
    renameRetryDelays: [3, 7, 11]
  });

  assert.equal(written, true);
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [3, 7]);
  assert.equal(new Set(temporaryPaths).size, 1);
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { version: 1, value: 'stable' });
  assert.deepEqual(temporaryFilesFor(target), []);

  let duplicateRenames = 0;
  const duplicateWritten = writeDurableJson(target, { version: 1, value: 'stable' }, {
    renameSync() {
      duplicateRenames += 1;
      throw new Error('identical content must not reach rename');
    }
  });
  assert.equal(duplicateWritten, false);
  assert.equal(duplicateRenames, 0);

  writeFileSync(target, '{"corrupt":true}\n', 'utf8');
  let repairRenames = 0;
  const repaired = writeDurableJson(target, { version: 1, value: 'stable' }, {
    renameSync(source, destination) {
      repairRenames += 1;
      renameSync(source, destination);
    }
  });
  assert.equal(repaired, true);
  assert.equal(repairRenames, 1);
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { version: 1, value: 'stable' });

  const invalidUtf8Target = join(root, 'invalid-utf8.json');
  const unicodeValue = { version: 1, value: 'replacement: \uFFFD' };
  assert.equal(writeDurableJson(invalidUtf8Target, unicodeValue), true);
  const validUtf8 = readFileSync(invalidUtf8Target);
  const replacementBytes = Buffer.from('\uFFFD', 'utf8');
  const replacementIndex = validUtf8.indexOf(replacementBytes);
  assert.notEqual(replacementIndex, -1);
  const invalidUtf8 = Buffer.concat([
    validUtf8.subarray(0, replacementIndex),
    Buffer.from([0xff]),
    validUtf8.subarray(replacementIndex + replacementBytes.length)
  ]);
  writeFileSync(invalidUtf8Target, invalidUtf8);
  assert.equal(invalidUtf8.toString('utf8'), validUtf8.toString('utf8'));
  assert.equal(invalidUtf8.equals(validUtf8), false);
  assert.equal(writeDurableJson(invalidUtf8Target, unicodeValue), true);
  assert.equal(readFileSync(invalidUtf8Target).equals(validUtf8), true);

  const exhausted = join(root, 'exhausted.json');
  assert.equal(writeDurableJson(exhausted, { version: 0 }), true);
  let exhaustedAttempts = 0;
  const exhaustedWaits = [];
  assert.throws(() => writeDurableJson(exhausted, { version: 1 }, {
    renameSync() {
      exhaustedAttempts += 1;
      throw transient('EBUSY');
    },
    sleepSync(milliseconds) {
      exhaustedWaits.push(milliseconds);
    },
    renameRetryDelays: [2, 5]
  }), (error) => error?.code === 'EBUSY');
  assert.equal(exhaustedAttempts, 3);
  assert.deepEqual(exhaustedWaits, [2, 5]);
  assert.deepEqual(JSON.parse(readFileSync(exhausted, 'utf8')), { version: 0 });
  assert.deepEqual(temporaryFilesFor(exhausted), []);
  assert.equal(writeDurableJson(exhausted, { version: 1 }), true);
  assert.deepEqual(JSON.parse(readFileSync(exhausted, 'utf8')), { version: 1 });

  const permanent = join(root, 'permanent.json');
  let permanentAttempts = 0;
  assert.throws(() => writeDurableJson(permanent, { version: 1 }, {
    renameSync() {
      permanentAttempts += 1;
      throw transient('EINVAL');
    },
    sleepSync() {
      throw new Error('non-transient rename failures must not sleep');
    }
  }), (error) => error?.code === 'EINVAL');
  assert.equal(permanentAttempts, 1);
  assert.deepEqual(temporaryFilesFor(permanent), []);

  console.log('dcp durable json: ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
