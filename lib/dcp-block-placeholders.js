/**
 * Canonical compressed-block placeholders used by DCP summaries.
 *
 * `(bN)` is the only supported marker. A marker preserves the named selected
 * predecessor at that exact position; a selected predecessor omitted from the
 * summary is deliberately absorbed by the new summary. Nothing is appended or
 * injected implicitly.
 */

const CANONICAL_BLOCK_PLACEHOLDER = /\(b([1-9]\d*)\)/g;
const LEGACY_BLOCK_PLACEHOLDER = /\{block_(\d+)\}/i;

export const COMPRESSED_BLOCK_HEADER = '[Compressed conversation section]';

export function numericBlockId(blockId) {
  const text = String(blockId ?? '').replace(/^[#b]/, '');
  if (!/^[1-9]\d*$/.test(text)) return undefined;
  const parsed = Number.parseInt(text, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function blockRef(blockId) {
  return `b${String(blockId).replace(/^[#b]/, '')}`;
}

export function wrapBlockSummary(blockId, summary) {
  const body = String(summary ?? '').trim();
  return body.length === 0
    ? `${COMPRESSED_BLOCK_HEADER}\n<dcp-message-id>${blockRef(blockId)}</dcp-message-id>`
    : `${COMPRESSED_BLOCK_HEADER}\n${body}\n\n<dcp-message-id>${blockRef(blockId)}</dcp-message-id>`;
}

export function parseBlockPlaceholders(summary) {
  const source = typeof summary === 'string' ? summary : '';
  const placeholders = [];
  const regex = new RegExp(CANONICAL_BLOCK_PLACEHOLDER);
  let match = regex.exec(source);
  while (match !== null) {
    placeholders.push({
      raw: match[0],
      blockId: Number.parseInt(match[1], 10),
      startIndex: match.index,
      endIndex: match.index + match[0].length
    });
    match = regex.exec(source);
  }
  return placeholders;
}

function blockRecord(value, fallbackId) {
  if (value !== null && typeof value === 'object') {
    const blockId = numericBlockId(value.blockId ?? fallbackId);
    if (blockId === undefined) return undefined;
    return {
      blockId,
      summary: typeof value.summary === 'string' ? value.summary : String(value.summary ?? ''),
      active: value.active !== false
    };
  }
  const blockId = numericBlockId(fallbackId);
  if (blockId === undefined) return undefined;
  return { blockId, summary: String(value ?? ''), active: true };
}

function blockMap(values) {
  const result = new Map();
  if (values instanceof Map) {
    for (const [key, value] of values) {
      const record = blockRecord(value, key);
      if (record !== undefined) result.set(record.blockId, record);
    }
    return result;
  }
  for (const value of Array.isArray(values) ? values : []) {
    const record = blockRecord(value, value?.blockId);
    if (record !== undefined) result.set(record.blockId, record);
  }
  return result;
}

function markerFragment(summary, startIndex, close) {
  const endIndex = summary.indexOf(close, startIndex + 1);
  return summary.slice(startIndex, endIndex === -1 ? summary.length : endIndex + 1);
}

function looksLikeCanonicalMarker(summary, startIndex) {
  let cursor = startIndex + 1;
  while (cursor < summary.length && /\s/.test(summary[cursor])) cursor += 1;
  if (summary[cursor]?.toLowerCase() !== 'b') return false;

  cursor += 1;
  const next = summary[cursor];
  if (next === undefined || next === ')' || /[\s\d]/.test(next)) return true;
  return /[+\-_]/.test(next) && /\d/.test(summary[cursor + 1] ?? '');
}

function looksLikeLegacyMarker(summary, startIndex) {
  let cursor = startIndex + 1;
  while (cursor < summary.length && /\s/.test(summary[cursor])) cursor += 1;
  if (summary.slice(cursor, cursor + 5).toLowerCase() !== 'block') return false;

  cursor += 5;
  while (cursor < summary.length && /\s/.test(summary[cursor])) cursor += 1;
  return summary[cursor] === '_';
}

function malformedMarker(summary, validPlaceholders) {
  const validStarts = new Set(validPlaceholders.map((entry) => entry.startIndex));
  for (let index = 0; index < summary.length; index += 1) {
    if (summary[index] === '(' && !validStarts.has(index) && looksLikeCanonicalMarker(summary, index)) {
      return markerFragment(summary, index, ')');
    }
    if (summary[index] === '{' && looksLikeLegacyMarker(summary, index)) {
      return markerFragment(summary, index, '}');
    }
  }
  return undefined;
}

/**
 * Validate and expand all placeholders without mutating registry state.
 *
 * Validation is deliberately strict so callers can run it for every batch row
 * before consuming a permit, allocating persistent ids, appending events, or
 * changing counters. The returned lineage is a complete partition of selected
 * predecessors.
 */
export function classifyAndExpandBlockPlaceholders(summary, { selectedBlocks = [], registry = [] } = {}) {
  const source = String(summary ?? '');
  if (LEGACY_BLOCK_PLACEHOLDER.test(source)) {
    throw new Error('Use canonical (bN) instead of {block_N}');
  }

  const placeholders = parseBlockPlaceholders(source);
  const malformed = malformedMarker(source, placeholders);
  if (malformed !== undefined) {
    throw new Error(`Malformed block placeholder ${JSON.stringify(malformed)}. Use canonical (bN).`);
  }

  const selected = blockMap(selectedBlocks);
  const known = blockMap(registry);
  for (const [blockId, record] of selected) known.set(blockId, record);

  const seen = new Set();
  for (const placeholder of placeholders) {
    const blockId = placeholder.blockId;
    if (seen.has(blockId)) {
      throw new Error(`Duplicate block placeholder (b${blockId}). Include a selected block at most once.`);
    }
    const record = known.get(blockId);
    if (record === undefined) {
      throw new Error(`Unknown block placeholder (b${blockId}).`);
    }
    if (record.active === false) {
      throw new Error(`Inactive block placeholder (b${blockId}) cannot be preserved.`);
    }
    if (!selected.has(blockId)) {
      throw new Error(`Block placeholder (b${blockId}) is outside the selected compression range.`);
    }
    seen.add(blockId);
  }

  let cursor = 0;
  const chunks = [];
  for (const placeholder of placeholders) {
    chunks.push(source.slice(cursor, placeholder.startIndex));
    chunks.push(restoreBlockSummary(selected.get(placeholder.blockId).summary));
    cursor = placeholder.endIndex;
  }
  chunks.push(source.slice(cursor));

  const childBlockIds = [...selected.keys()];
  const preservedBlockIds = childBlockIds.filter((blockId) => seen.has(blockId));
  const absorbedBlockIds = childBlockIds.filter((blockId) => !seen.has(blockId));
  return {
    expandedSummary: chunks.join(''),
    childBlockIds,
    preservedBlockIds,
    absorbedBlockIds
  };
}

export function restoreBlockSummary(summary) {
  if (typeof summary !== 'string') return '';
  const headerMatch = summary.match(/^\s*\[Compressed conversation(?: section)?(?: b?\d+)?\]/i);
  if (headerMatch === null) return summary;
  return summary
    .slice(headerMatch[0].length)
    .replace(/^(?:\r?\n)+/, '')
    .replace(/(?:\r?\n)*<dcp-message-id>b?\d+<\/dcp-message-id>\s*$/i, '')
    .replace(/(?:\r?\n)+$/, '');
}
