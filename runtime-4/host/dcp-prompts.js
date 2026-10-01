/**
 * The prompt texts DCP puts in front of the model.
 *
 * These use upstream's prompts
 * (`Opencode-DCP/opencode-dynamic-context-pruning`, `lib/prompts/*`) as their
 * baseline. The range tool deliberately adds local guidance for purpose,
 * narrative preservation, useful failed attempts, and temporal anchoring; the
 * remaining prompt surface stays aligned with upstream and the port's block
 * placeholder contract.
 *
 * Model-facing vocabulary is upstream's unchanged: stable `mNNNN` aliases,
 * compressed `bN` references, and string boundaries in the compress schema.
 *
 * Upstream's override surface is six editable prompts plus two internal
 * extensions (`lib/prompts/store.ts`), read from
 * `<XDG_CONFIG_HOME>/opencode/dcp-prompts/` with a project-local `.opencode`
 * directory taking precedence, and gated behind `experimental.customPrompts`.
 *
 * @module dsh-context-kit/lib/dcp-prompts
 */

/** `lib/prompts/system.ts` — the base system prompt. */
export const SYSTEM = `
You operate in a context-constrained environment. Manage context continuously to avoid buildup and preserve retrieval quality. Efficient context management is paramount for your agentic performance.

The ONLY tool you have for context management is \`compress\`. It replaces older conversation content with technical summaries you produce.

\`<dcp-message-id>\` and \`<dcp-system-reminder>\` tags are environment-injected metadata. Do not output them.

THE PHILOSOPHY OF COMPRESS
\`compress\` transforms conversation content into dense, high-fidelity summaries. This is not cleanup - it is crystallization. Your summary becomes the authoritative record of what transpired.

Think of compression as phase transitions: raw exploration becomes refined understanding. The original context served its purpose; your summary now carries that understanding forward.

COMPRESS WHEN

A section is genuinely closed and the raw conversation has served its purpose:

- Research concluded and findings are clear
- Implementation finished and verified
- Exploration exhausted and patterns understood
- Dead-end noise can be discarded without waiting for a whole chapter to close

DO NOT COMPRESS IF

- Raw context is still relevant and needed for edits or precise references
- The target content is still actively in progress
- You may need exact code, error messages, or file contents in the immediate next steps

Before compressing, ask: _"Is this section closed enough to become summary-only right now?"_

Evaluate conversation signal-to-noise REGULARLY. Use \`compress\` deliberately with quality-first summaries. Prioritize stale content intelligently to maintain a high-signal context window that supports your agency.

It is of your responsibility to keep a sharp, high-quality context window for optimal performance.
`;

/** `lib/prompts/extensions/system.ts` — manual-mode reminder (internal). */
export const MANUAL_MODE_SYSTEM_EXTENSION = `<dcp-system-reminder>
Manual mode is enabled. Do NOT use compress unless the user has explicitly triggered it through a manual marker.

Only use the compress tool after seeing \`<compress triggered manually>\` in the current user instruction context.

Issue exactly ONE compress tool per manual trigger. Do NOT launch multiple compress tools in parallel. Each trigger grants a single compression; after it completes, wait for the next trigger.

After completing a manually triggered context-management action, STOP IMMEDIATELY. Do NOT continue with any task execution. End your response right after the tool use completes and wait for the next user input.
</dcp-system-reminder>
`;

/** `lib/prompts/extensions/system.ts` — subagent notice (internal). */
export const SUBAGENT_SYSTEM_EXTENSION = `<dcp-system-reminder>
You are operating in a subagent environment.

The initial subagent instruction is imperative and must be followed exactly.
It is the only user message intentionally not assigned a message ID, and therefore is not eligible for compression.
All subsequent messages in the session will have IDs.
</dcp-system-reminder>
`;

/**
 * `lib/prompts/extensions/system.ts` — the protected-tools reminder.
 *
 * ADAPTED: upstream names the tools it protects and tells the model their output
 * is retained by the environment. The port retains exactly the same tools
 * (`compress.protectedTools`), so only the sentence about how the range is
 * addressed differs.
 *
 * @param protectedTools - tool names whose output survives compression.
 * @returns the reminder, or an empty string when nothing is protected.
 */
export function buildProtectedToolsExtension(protectedTools) {
  if (!Array.isArray(protectedTools) || protectedTools.length === 0) return '';
  const toolList = protectedTools.map((tool) => `\`${tool}\``).join(', ');
  return `<dcp-system-reminder>
The following tools are environment-managed: ${toolList}.
Their outputs are automatically preserved during compression.
Do not include their content in compress tool summaries — the environment retains it independently.
</dcp-system-reminder>`;
}

/** `lib/prompts/compress-range.ts` — range-mode tool description. */
export const COMPRESS_RANGE = `Collapse a range in the conversation into a detailed summary. This reduces context usage while preserving the technical record, user intent, and narrative needed to understand what happened and continue the work correctly.

THE SUMMARY
Your summary must be EXHAUSTIVE. Capture file paths, function signatures, decisions made, constraints discovered, key findings... EVERYTHING that maintains context integrity. This is not a brief note - it is an authoritative record so faithful that the original conversation adds no value.

USER INTENT FIDELITY
When the compressed range includes user messages, preserve the user's intent with extra care. Do not change scope, constraints, priorities, acceptance criteria, or requested outcomes.
You may preserve user messages verbatim, in full or as direct quotations, when this helps maintain a clear narrative, preserves exact intent, or makes later decisions understandable. User wording is part of the conversation record and should not be removed merely for brevity.

Yet be LEAN. Strip away only noise: verbose tool outputs, repetitive back-and-forth exploration, and details that teach nothing. Preserve failed attempts when they provide reusable information: what was tried, why it failed or was rejected, and what should be done instead. What remains should be pure signal - golden nuggets of detail that preserve full understanding with zero ambiguity.

TEMPORAL ANCHORING
The summary replaces the selected range at that range's original position in the conversation; it is not appended to the current end. Write it as a historical record whose statements remain correct at that chronological position.

Do not use unqualified conversation-relative language such as "current task", "current work", "now", "next step", "latest state", or "still pending". If end-of-range state is essential, anchor it explicitly with wording such as "At the end of this range, ..." or "The next step planned at that point was ...". Later conversation may supersede that state.

Do not describe events or state from after the selected range. If the selected work is resolved within the range, summarize the resolution instead of preserving an obsolete plan. Exact quotations may retain the user's original wording, but the surrounding summary must keep its historical meaning clear.

COMPRESSED BLOCK PLACEHOLDERS
When the selected range includes previously compressed blocks, use this exact placeholder format when referencing one:

- \`(bN)\`

Compressed block sections in context are clearly marked with a header:

- \`[Compressed conversation section]\`

Compressed block IDs always use the \`bN\` form (never \`mNNNN\`) and are represented in the same XML metadata tag format.

Rules:

- For each compressed block inside the selected range, choose one of these two behaviors:
  - Omit its \`(bN)\` marker to absorb that block into your new summary. Its stored text will not be inserted automatically.
  - Include its \`(bN)\` marker exactly once to preserve that block verbatim at that exact position.
- Do not invent placeholders for blocks outside the selected range.
- Do not include the same block marker more than once.
- Treat \`(bN)\` placeholders as RESERVED TOKENS. Do not emit \`(bN)\` text anywhere except intentional placeholders.
- If you need to mention a block in prose, use plain text like \`compressed bN\` (not as a placeholder).
- Preflight check before finalizing: every marker must name a block inside the selected range, appear at most once, and reflect an intentional preserve choice; every omitted block is intentionally absorbed.

These placeholders are semantic references. Each included marker will be replaced with the full stored compressed block content when the tool processes your output.

FLOW PRESERVATION WITH PLACEHOLDERS
When you use compressed block placeholders, write the surrounding summary text so it still reads correctly AFTER placeholder expansion.

- Treat each placeholder as a stand-in for a full conversation segment, not as a short label.
- Ensure transitions before and after each placeholder preserve chronology and causality.
- Do not write text that depends on the placeholder staying literal (for example, "as noted in \`(b2)\`").
- Your final meaning must be coherent once each placeholder is replaced with its full compressed block content.

BOUNDARY IDS
You specify boundaries by ID using the injected IDs visible in the conversation:

- \`mNNNN\` IDs identify raw messages
- \`bN\` IDs identify previously compressed blocks

Each message has an ID inside XML metadata tags like \`<dcp-message-id>...</dcp-message-id>\`.
The same ID tag appears in every tool output of the message it belongs to — each unique ID identifies one complete message.
Treat these tags as boundary metadata only, not as tool result content.

Rules:

- Pick \`startId\` and \`endId\` directly from injected IDs in context.
- IDs must exist in the current visible context.
- \`startId\` must appear before \`endId\`.
- Do not invent IDs. Use only IDs that are present in context.

BATCHING
When multiple independent ranges are ready and their boundaries do not overlap, include all of them as separate entries in the \`content\` array of a single tool call. Each entry should have its own \`startId\`, \`endId\`, and \`summary\`.
`;

/** `lib/prompts/compress-message.ts` — message-mode tool description. */
export const COMPRESS_MESSAGE = `Collapse selected individual messages in the conversation into detailed summaries.

THE SUMMARY
Your summary must be EXHAUSTIVE. Capture file paths, function signatures, decisions made, constraints discovered, key findings, tool outcomes, and user intent details that matter... EVERYTHING that preserves the value of the selected message after the raw message is removed.

USER INTENT FIDELITY
When a selected message contains user intent, preserve that intent with extra care. Do not change scope, constraints, priorities, acceptance criteria, or requested outcomes.
Directly quote short user instructions when that best preserves exact meaning.

Yet be LEAN. Strip away the noise: failed attempts that led nowhere, verbose tool output, and repetition. What remains should be pure signal - golden nuggets of detail that preserve full understanding with zero ambiguity.
If a message contains no significant technical decisions, code changes, or user requirements, produce a minimal one-line summary rather than a detailed one.

MESSAGE IDS
You specify individual raw messages by ID using the injected IDs visible in the conversation:

- \`mNNNN\` IDs identify raw messages

Each message has an ID inside XML metadata tags like \`<dcp-message-id priority="high">m0007</dcp-message-id>\`.
The same ID tag appears in every tool output of the message it belongs to — each unique ID identifies one complete message.
Treat these tags as message metadata only, not as content to summarize. Use only the inner \`mNNNN\` value as the \`messageId\`.
The \`priority\` attribute indicates relative context cost. You MUST compress high-priority messages when their full text is no longer necessary for the active task.
If prior compress-tool results are present, always compress and summarize them minimally only as part of a broader compression pass. Do not invoke the compress tool solely to re-compress an earlier compression result.
Messages marked as \`<dcp-message-id>BLOCKED</dcp-message-id>\` cannot be compressed.

Rules:

- Pick each \`messageId\` directly from injected IDs visible in context.
- Only use raw message IDs of the form \`mNNNN\`.
- Ignore XML attributes such as \`priority\` when copying the ID; use only the inner \`mNNNN\` value.
- Do not invent IDs. Use only IDs that are present in context.

BATCHING
Select MANY messages in a single tool call when they are safe to compress.
Each entry should summarize exactly one message, and the tool can receive as many entries as needed in one batch.

GENERAL CLEANUP
Use the topic "general cleanup" for broad cleanup passes.
During general cleanup, compress all medium and high-priority messages that are not relevant to the active task.
Optimize for reducing context footprint, not for grouping messages by topic.
Do not compress away still-active instructions, unresolved questions, or constraints that are likely to matter soon.
Prioritize the earliest messages in the context as they will be the least relevant to the active task.
General cleanup should be done periodically between other normal compression tool passes, not as the primary form of compression.
`;

/** `lib/prompts/turn-nudge.ts` */
export const TURN_NUDGE = `<dcp-system-reminder>
Evaluate the conversation for compressible ranges.

If any messages are cleanly closed and unlikely to be needed again, use the compress tool on them.
If direction has shifted, compress earlier ranges that are now less relevant.

The goal is to filter noise and distill key information so context accumulation stays under control.
Keep active context uncompressed.
</dcp-system-reminder>
`;

/** `lib/prompts/iteration-nudge.ts` */
export const ITERATION_NUDGE = `<dcp-system-reminder>
You've been iterating for a while after the last user message.

If there is a closed portion that is unlikely to be referenced immediately (for example, finished research before implementation), use the compress tool on it now.
</dcp-system-reminder>
`;

/** `lib/prompts/context-limit-nudge.ts` */
export const CONTEXT_LIMIT_NUDGE = `<dcp-system-reminder>
CRITICAL WARNING: MAX CONTEXT LIMIT REACHED

You are at or beyond the configured max context threshold. This is an emergency context-recovery moment.

You MUST use the \`compress\` tool now. Do not continue normal exploration until compression is handled.

If you are in the middle of a critical atomic operation, finish that atomic step first, then compress immediately.

SELECTION PROCESS
Start from older, resolved history and capture as much stale context as safely possible in one pass.
Avoid the newest active working messages unless it is clearly closed.

SUMMARY REQUIREMENTS
Your summary MUST cover all essential details from the selected messages so work can continue.
If the compressed range includes user messages, preserve user intent exactly. Prefer direct quotes for short user messages to avoid semantic drift.
</dcp-system-reminder>
`;

export const COMPRESSED_BLOCK_HEADER = '[Compressed conversation section]';

/**
 * `lib/prompts/extensions/tool.ts` — the input format, kept out of the editable
 * prompt because it must match the tool's schema.
 *
 * @param mode - `range` or `message`.
 * @returns the format block appended to the tool description.
 */
export function formatExtension(mode) {
  if (mode === 'message') {
    return `
THE FORMAT OF COMPRESS

\`\`\`
{
  topic: string,           // Short label (3-5 words) for the overall batch
  content: [               // One or more messages to compress independently
    {
      messageId: string,   // Raw message ID only: mNNNN (ignore metadata attributes like priority)
      topic: string,       // Short label (3-5 words) for this one message summary
      summary: string      // Complete technical summary replacing that one message
    }
  ]
}
\`\`\``;
  }
  return `
THE FORMAT OF COMPRESS

\`\`\`
{
  topic: string,           // Short label (3-5 words) - e.g., "Auth System Exploration"
  content: [               // One or more ranges to compress
    {
      startId: string,     // Boundary ID at range start: mNNNN or bN
      endId: string,       // Boundary ID at range end: mNNNN or bN
      summary: string      // Complete technical summary replacing all content in range
    }
  ]
}
\`\`\``;
}

/**
 * `lib/prompts/extensions/nudge.ts` — tells the model which blocks exist so a
 * range that swallows one can carry the required `(bN)` placeholder.
 *
 * @param blockIds - active compressed block ids, in any order.
 * @returns the guidance block appended to a nudge.
 */
export function buildCompressedBlockGuidance(blockIds) {
  // The ids arrive as whatever the registry stores — strings in this port,
  // numbers upstream — so they are parsed rather than type-checked. Requiring
  // `Number.isInteger` here silently dropped EVERY id and told the model
  // "Active compressed blocks in this session: 0 (none)" while blocks existed,
  // which made the whole placeholder discipline unreachable.
  const refs = [...new Set(blockIds)]
    .map((id) => Number.parseInt(String(id).replace(/^[#b]/, ''), 10))
    .filter((id) => Number.isInteger(id) && id > 0)
    .sort((a, b) => a - b)
    .map((id) => `b${id}`);
  const count = refs.length;
  const list = count > 0 ? refs.join(', ') : 'none';
  return [
    'Compressed block context:',
    `- Active compressed blocks in this session: ${count} (${list})`,
    '- For each listed block inside your selected compression range: omit its `(bN)` marker to absorb it, or include the marker exactly once to preserve its stored summary verbatim at that position.'
  ].join('\n');
}

/**
 * `lib/prompts/extensions/nudge.ts` — attach guidance inside the reminder tag.
 *
 * @param nudgeText - the reminder, ending in `</dcp-system-reminder>`.
 * @param guidance - the guidance block, or an empty string.
 * @returns the reminder with the guidance inserted before the closing tag.
 */
export function appendGuidanceToDcpTag(nudgeText, guidance) {
  if (typeof guidance !== 'string' || guidance.trim().length === 0) return nudgeText;
  const closeTag = '</dcp-system-reminder>';
  const at = nudgeText.lastIndexOf(closeTag);
  if (at === -1) return `${nudgeText}\n${guidance}`;
  return `${nudgeText.slice(0, at)}${guidance}\n${nudgeText.slice(at)}`;
}

/**
 * `lib/prompts/index.ts:renderSystemPrompt` — base text plus extensions.
 *
 * The order matters and is upstream's: protected tools, then manual mode, then
 * the subagent notice, with runs of blank lines collapsed to one.
 *
 * @param options - the extensions that apply to this assembly.
 * @returns the assembled system prompt.
 */
export function renderSystemPrompt(options = {}) {
  const { system = SYSTEM, protectedToolsExtension, manual = false, subagent = false } = options;
  const extensions = [];
  if (typeof protectedToolsExtension === 'string' && protectedToolsExtension.trim().length > 0) {
    extensions.push(protectedToolsExtension.trim());
  }
  if (manual) extensions.push(MANUAL_MODE_SYSTEM_EXTENSION.trim());
  if (subagent) extensions.push(SUBAGENT_SYSTEM_EXTENSION.trim());
  return [String(system).trim(), ...extensions]
    .filter(Boolean)
    .join('\n\n')
    .replace(/\n([ \t]*\n)+/g, '\n\n')
    .trim();
}

/**
 * The six prompts a user may override, matching upstream's editable surface.
 *
 * Upstream reads them from `<dir>/<name>.md` under its `dcp-prompts` directory
 * and reports the resolved paths (`lib/prompts/store.ts`).
 */
export const EDITABLE_PROMPTS = ['system', 'compressRange', 'compressMessage', 'contextLimitNudge', 'turnNudge', 'iterationNudge'];

/**
 * The editable prompt a file name selects.
 *
 * @param name - prompt name without an extension.
 * @param mode - the active compress mode, for its default value.
 * @returns the bundled default text, or `undefined` for an unknown name.
 */
export function editablePromptDefault(name, mode = 'range') {
  switch (name) {
    case 'system': return SYSTEM;
    case 'compressRange': return COMPRESS_RANGE;
    case 'compressMessage': return COMPRESS_MESSAGE;
    case 'contextLimitNudge': return CONTEXT_LIMIT_NUDGE;
    case 'turnNudge': return TURN_NUDGE;
    case 'iterationNudge': return ITERATION_NUDGE;
    default: return mode === 'message' ? COMPRESS_MESSAGE : COMPRESS_RANGE;
  }
}
