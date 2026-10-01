/** Exact regression guard for the locally approved range-compression preamble. */

import assert from 'node:assert/strict';
import { COMPRESS_RANGE } from '../lib/dcp-prompts.js';

const expectedPreamble = `Collapse a range in the conversation into a detailed summary. This reduces context usage while preserving the technical record, user intent, and narrative needed to understand what happened and continue the work correctly.

THE SUMMARY
Your summary must be EXHAUSTIVE. Capture file paths, function signatures, decisions made, constraints discovered, key findings... EVERYTHING that maintains context integrity. This is not a brief note - it is an authoritative record so faithful that the original conversation adds no value.

USER INTENT FIDELITY
When the compressed range includes user messages, preserve the user's intent with extra care. Do not change scope, constraints, priorities, acceptance criteria, or requested outcomes.
You may preserve user messages verbatim, in full or as direct quotations, when this helps maintain a clear narrative, preserves exact intent, or makes later decisions understandable. User wording is part of the conversation record and should not be removed merely for brevity.

Yet be LEAN. Strip away only noise: verbose tool outputs, repetitive back-and-forth exploration, and details that teach nothing. Preserve failed attempts when they provide reusable information: what was tried, why it failed or was rejected, and what should be done instead. What remains should be pure signal - golden nuggets of detail that preserve full understanding with zero ambiguity.

TEMPORAL ANCHORING
The summary replaces the selected range at that range's original position in the conversation; it is not appended to the current end. Write it as a historical record whose statements remain correct at that chronological position.

Do not use unqualified conversation-relative language such as "current task", "current work", "now", "next step", "latest state", or "still pending". If end-of-range state is essential, anchor it explicitly with wording such as "At the end of this range, ..." or "The next step planned at that point was ...". Later conversation may supersede that state.

Do not describe events or state from after the selected range. If the selected work is resolved within the range, summarize the resolution instead of preserving an obsolete plan. Exact quotations may retain the user's original wording, but the surrounding summary must keep its historical meaning clear.`;

const marker = '\n\nCOMPRESSED BLOCK PLACEHOLDERS\n';
const markerAt = COMPRESS_RANGE.indexOf(marker);
assert.notEqual(markerAt, -1, 'range prompt must retain the placeholder section after its preamble');
assert.equal(COMPRESS_RANGE.slice(0, markerAt), expectedPreamble,
  'range prompt preamble must stay byte-identical to the approved wording');
assert.doesNotMatch(COMPRESS_RANGE, /failed attempts that led nowhere/,
  'range prompt must not discard failed approaches categorically');

console.log('DCP range prompt contract guard passed');
