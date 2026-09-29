/**
 * Dump one DSH session log to plain JSONL.
 *
 * A session file is zstd with two frames: frame 1 is the JSON header, frame 2 is
 * the event stream. This writes the concatenation of both, one event per line,
 * so `jq`/`Select-String` can read it.
 *
 * Usage: node dump-session.mjs <session.v3.jsonl.zstd> [out.jsonl]
 *
 * @module dsh-context-kit/scripts/dump-session
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const input = process.argv[2];
if (input === undefined) {
  console.error('usage: node dump-session.mjs <session.v3.jsonl.zstd> [out.jsonl]');
  process.exit(2);
}

const buffer = readFileSync(input);

// A zstd frame's last block carries the "content size" flag; without it the
// decoder needs a known output size, so walk the frame boundaries by asking the
// decoder for one frame at a time and advancing past what it consumed.
const parts = [];
let offset = 0;
while (offset < buffer.length) {
  const slice = buffer.subarray(offset);
  let decoded;
  try {
    decoded = zstdDecompressSync(slice);
  } catch (error) {
    console.error(`frame at byte ${offset} failed: ${error.message}`);
    break;
  }
  parts.push(decoded.toString('utf8'));
  // Advance by the frame's magic-to-end; find the next frame magic 0x28B52FFD.
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const next = buffer.indexOf(magic, offset + 4);
  if (next === -1) break;
  offset = next;
}

const text = parts.join('');
const out = process.argv[3] ?? `${input}.jsonl`;
writeFileSync(out, text, 'utf8');
console.log(`wrote ${out} (${text.length} chars, ${text.split('\n').length} lines)`);
