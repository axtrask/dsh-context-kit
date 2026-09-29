/**
 * A direct port of upstream DCP's `lib/compress/range-utils.ts:103-308`.
 *
 * THE PROBLEM THIS SOLVES. A compressed block is a span the model can no longer
 * read in full — it survives as one summary node on the surface. When a LATER
 * compression swallows that node, the earlier summary is inside the new range,
 * so it disappears unless the new summary carries it forward. Upstream's answer
 * is a placeholder discipline: the model writes `(bN)` where the old block
 * belongs, the tool replaces the placeholder with the block's stored text
 * BEFORE the new summary is stored, and any block inside the range that the
 * model did not reference is appended under a heading so nothing is silently
 * lost.
 *
 * Without this, every nested compression is lossy — the exact failure mode the
 * upstream prompt's "Include every required block placeholder exactly once"
 * rule exists to prevent. The port taught the discipline (the prompts are
 * verbatim) but performed no expansion, so the model was following instructions
 * that nothing implemented.
 *
 * Block ids are strings in persisted DSH state and numbers in the placeholder
 * grammar. Every lookup is normalized at this boundary.
 */

/** Upstream's literal placeholder grammar. */
const BLOCK_PLACEHOLDER_REGEX = /\(b(\d+)\)|\{block_(\d+)\}/gi;

/** Upstream `lib/compress/state.ts:5` — the header every stored summary carries. */
export const COMPRESSED_BLOCK_HEADER = '[Compressed conversation section]';

/**
 * A block id as the NUMBER every lookup table is keyed by.
 *
 * Block ids travel as strings through this port (`compress` stores
 * `String(id)`; upstream stores numbers) but the placeholder syntax is numeric,
 * so lookups are numeric. A boundary injection that handed `"1"` to a map keyed
 * by `1` found nothing and threw `Compressed block not found: (b1)` for a block
 * sitting in plain sight. The conversion therefore happens here, once, instead
 * of at each call site.
 *
 * @param blockId - a block id in either representation, with or without `#`/`b`.
 * @returns the numeric id, or `undefined` when it is not an integer.
 */
export function numericBlockId(blockId) {
  const parsed = Number.parseInt(String(blockId ?? '').replace(/^[#b]/, ''), 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

/**
 * The label this port shows the model for one block.
 *
 * Upstream's `formatBlockRef` (`lib/message-ids.ts:37-42`) is the `bN` form, and
 * that is what the prompts and the nudge guidance reference. The command line
 * also accepts `#N` because that was this port's earlier display, and a user who
 * learned it should not have to relearn it.
 *
 * @param blockId - a block id, as a string or number.
 * @returns the `bN` reference.
 */
export function blockRef(blockId) {
  return `b${String(blockId).replace(/^[#b]/, '')}`;
}

/**
 * Wrap a summary the way upstream stores it (`lib/compress/state.ts:52-60`).
 *
 * The header is functional, not cosmetic: it is how the model recognizes a
 * compressed section in context, which upstream's prompt tells it to look for.
 *
 * @param blockId - the block being created.
 * @param summary - the model's expanded summary.
 * @returns the text the replacement node carries.
 */
export function wrapBlockSummary(blockId, summary) {
  const body = String(summary ?? '').trim();
  return body.length === 0
    ? `${COMPRESSED_BLOCK_HEADER}\n<dcp-message-id>${blockRef(blockId)}</dcp-message-id>`
    : `${COMPRESSED_BLOCK_HEADER}\n${body}\n\n<dcp-message-id>${blockRef(blockId)}</dcp-message-id>`;
}

/**
 * Parse the block placeholders a summary references.
 *
 * @param summary - the model's summary text.
 * @returns placeholders with their ids and offsets, in text order.
 */
export function parseBlockPlaceholders(summary) {
  const placeholders = [];
  if (typeof summary !== 'string' || summary.length === 0) return placeholders;
  const regex = new RegExp(BLOCK_PLACEHOLDER_REGEX);
  let match = regex.exec(summary);
  while (match !== null) {
    const full = match[0];
    const digits = match[1] ?? match[2];
    const parsed = Number.parseInt(digits, 10);
    if (Number.isInteger(parsed)) {
      placeholders.push({
        raw: full,
        blockId: parsed,
        startIndex: match.index,
        endIndex: match.index + full.length
      });
    }
    match = regex.exec(summary);
  }
  return placeholders;
}

/**
 * Keep only the placeholders that name a block inside this range, drop
 * duplicates, and report which required blocks the summary failed to mention.
 *
 * Upstream's split (`range-utils.ts:127-168`): a block sitting at a boundary is
 * OPTIONAL, because a range can start or end on a block without owning it, and
 * requiring a placeholder there would reject a valid summary. A block fully
 * inside the range is REQUIRED.
 *
 * This mutates `placeholders` in place, exactly as upstream does, so the caller
 * passes the same array on to {@link injectBlockPlaceholders}.
 *
 * @param placeholders - parsed placeholders, mutated down to the valid ones.
 * @param requiredBlockIds - blocks this range contains in full.
 * @param boundaryBlockIds - blocks at the range's edges, optional by definition.
 * @returns the required block ids that no placeholder covered.
 */
export function validateSummaryPlaceholders(placeholders, requiredBlockIds, startReference, endReference, blockSummaryById) {
  const optional = new Set();
  if (startReference?.kind === 'compressed-block') optional.add(numericBlockId(startReference.blockId));
  if (endReference?.kind === 'compressed-block') optional.add(numericBlockId(endReference.blockId));
  const required = new Set(requiredBlockIds.map((id) => numericBlockId(id)).filter((id) => id !== undefined));
  const strict = [...required].filter((id) => !optional.has(id));
  const kept = new Set();
  const valid = [];
  for (const placeholder of placeholders) {
    const known = blockSummaryById.has(placeholder.blockId);
    const selected = required.has(placeholder.blockId);
    const duplicate = kept.has(placeholder.blockId);
    if (known && selected && !duplicate) {
      valid.push(placeholder);
      kept.add(placeholder.blockId);
    }
  }
  placeholders.length = 0;
  placeholders.push(...valid);
  return strict.filter((id) => !kept.has(id));
}

/**
 * Replace every placeholder with the stored text of the block it names, and
 * inline a block that sits at a range edge.
 *
 * The edge case is upstream's `injectBoundarySummary`
 * (`range-utils.ts:280-308`): if the range begins on a compressed block, that
 * block's own text is prepended; if it ends on one, appended. This is what makes
 * a range that starts ON a block behave like a range that includes it, instead
 * of dropping the block's content on the floor.
 *
 * @param summary - the model's summary text.
 * @param placeholders - validated placeholders, in text order.
 * @param blockSummaryById - lookup of stored summary text by numeric block id.
 * @returns the expanded summary plus the ids it consumed, in order.
 */
export function injectBlockPlaceholders(summary, placeholders, blockSummaryById, startReference, endReference) {
  let cursor = 0;
  let expanded = summary;
  const consumed = [];
  const seen = new Set();

  if (placeholders.length > 0) {
    expanded = '';
    for (const placeholder of placeholders) {
      expanded += summary.slice(cursor, placeholder.startIndex);
      const target = blockSummaryById.get(placeholder.blockId);
      if (target === undefined) throw new Error(`Compressed block not found: (b${placeholder.blockId})`);
      expanded += restoreBlockSummary(typeof target === 'string' ? target : target.summary);
      cursor = placeholder.endIndex;
      if (!seen.has(placeholder.blockId)) {
        seen.add(placeholder.blockId);
        consumed.push(placeholder.blockId);
      }
    }
    expanded += summary.slice(cursor);
  }

  expanded = injectBoundaryBlock(expanded, startReference?.kind === 'compressed-block' ? startReference.blockId : undefined, 'start', blockSummaryById, consumed);
  expanded = injectBoundaryBlock(expanded, endReference?.kind === 'compressed-block' ? endReference.blockId : undefined, 'end', blockSummaryById, consumed);

  return { expandedSummary: expanded, consumedBlockIds: consumed };
}

/**
 * Inline a block the range sits on, before or after the summary text.
 *
 * @param summary - the summary to extend.
 * @param blockId - the boundary block, or `undefined` when the edge is a plain
 *   message and there is nothing to inline.
 * @param position - which edge the block sits on.
 * @param blockSummaryById - lookup of stored summary text by numeric block id.
 * @param consumedBlockIds - ids already consumed; mutated when this adds one.
 * @returns the extended summary.
 */
export function injectBoundaryBlock(summary, blockId, position, blockSummaryById, consumedBlockIds) {
  if (blockId === undefined || blockId === null) return summary;
  const numeric = numericBlockId(blockId);
  if (numeric === undefined) return summary;
  if (consumedBlockIds.includes(numeric) || consumedBlockIds.includes(blockId)) return summary;
  const target = blockSummaryById.get(numeric);
  if (target === undefined) {
    throw new Error(`Compressed block not found: (b${numeric})`);
  }
  const body = restoreBlockSummary(typeof target === 'string' ? target : target.summary).trim();
  const text = typeof summary === 'string' ? summary.trim() : '';
  const left = position === 'start' ? body : text;
  const right = position === 'start' ? text : body;
  const next = left.length === 0 ? right : right.length === 0 ? left : `${left}\n\n${right}`;
  consumedBlockIds.push(numeric);
  return next;
}

/**
 * Append the text of every block the summary forgot, so a nested compression
 * cannot lose an earlier one.
 *
 * Upstream's heading is reproduced verbatim (`range-utils.ts:258-259`) because
 * the model reads it on the NEXT compression and has to recognize the pattern.
 *
 * @param summary - the summary to extend.
 * @param missingBlockIds - required blocks with no placeholder.
 * @param blockSummaryById - lookup of stored summary text by numeric block id.
 * @param consumedBlockIds - ids already consumed; mutated when this adds one.
 * @returns the extended summary and the full consumed list.
 */
export function appendMissingBlockSummaries(summary, missingBlockIds, blockSummaryById, consumedBlockIds) {
  const seen = new Set(consumedBlockIds);
  const consumed = [...consumedBlockIds];
  const missing = [];
  for (const blockId of missingBlockIds) {
    if (seen.has(blockId)) continue;
    const target = blockSummaryById.get(blockId);
    if (target === undefined) {
      throw new Error(`Compressed block not found: (b${blockId})`);
    }
    missing.push(`\n### (b${blockId})\n${restoreBlockSummary(typeof target === 'string' ? target : target.summary)}`);
    seen.add(blockId);
    consumed.push(blockId);
  }
  if (missing.length === 0) return { expandedSummary: summary, consumedBlockIds: consumed };
  const heading = '\n\nThe following previously compressed summaries were also part of this conversation section:';
  return { expandedSummary: summary + heading + missing.join(''), consumedBlockIds: consumed };
}

/**
 * Strip the wrapper {@link wrapBlockSummary} added, so a nested block's text
 * sits inside the new summary as plain content rather than a second header.
 *
 * Upstream's `restoreSummary` (`range-utils.ts:267-278`), with the port's own
 * footer tag as well as upstream's.
 *
 * @param summary - a stored summary, wrapped or plain.
 * @returns the body text without the header or the id footer.
 */
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
