/**
 * The guidance context-mode puts in front of the model.
 *
 * Upstream injects this at `SessionStart`, again on every agent call, and as a
 * short per-tool nudge (`hooks/routing-block.mjs`, `hooks/sessionstart.mjs`,
 * `hooks/core/routing.mjs`). It is the whole reason the tools get used the way
 * they were designed: it states the priority ("every byte a tool returns enters
 * your conversation memory"), the selection hierarchy (memory → gather →
 * follow-up → processing), and when NOT to use them. DSH runs the analysis code
 * in a real subprocess, so this port must state plainly that writes persist.
 *
 * The port injected NOTHING — `lib/context-mode.js` had zero references to any
 * prompt or guidance service — so a model in DSH saw the tools' own descriptions
 * and never learned what they were for. That is a behaviour difference a user
 * feels immediately, which is why the text is carried over here.
 *
 * ADAPTED, and only where the host's own tool names appear: upstream names
 * Claude Code's `Bash`, `Read`, `Write`, `Edit`, and `WebFetch`. DSH's equivalents
 * are `pwsh`, `read`, `write`, `edit`, and `web_fetch`. The reasoning is
 * upstream's; only the nouns change, because advice naming a tool that does not
 * exist is worse than no advice.
 *
 * @module dsh-context-kit/lib/context-mode-guidance
 */

/** Host tools whose names differ from the ones upstream's text assumes. */
const HOST = {
  shell: 'pwsh',
  read: 'read',
  write: 'write',
  edit: 'edit',
  fetch: 'web_fetch'
};

/**
 * The full guidance block, upstream's `createRoutingBlock`.
 *
 * Upstream composes this from a tool-namer so each harness gets its own tool
 * names, and can omit the `<ctx_commands>` section. The command section is kept
 * because the port implements the same commands. `ctx_upgrade` reports that the
 * bundled private plugin has no safe self-update command, and `ctx_insight`
 * returns a dashboard pointer instead of launching a browser.
 *
 * @param options - `includeCommands` toggles the command table.
 * @returns the guidance text.
 */
export function routingBlock(options = {}) {
  const { includeCommands = true } = options;
  return `
<context_window_protection>
  <priority_instructions>
    Every byte a tool returns enters your conversation memory and costs reasoning capacity for the rest of the session. The context-mode tools let you do the work in a sandbox and surface only the derived answer — the raw bytes stay out. Think-in-Code: program the analysis, do not compute it by reading raw data into your conversation.
  </priority_instructions>
  <tool_selection_hierarchy>
    0. MEMORY: ctx_search(sort: "timeline")
       - On resume or compaction, query prior decisions, errors, plans, user prompts before asking the user — auto-captured session memory is searchable.
    1. GATHER: ctx_batch_execute(commands, queries)
       - Primary research tool. Runs commands in parallel, auto-indexes each output, and (when queries are passed) returns matching sections in the same round trip — no follow-up search call.
       - Each command: {label: "section header", command: "shell command"}; the label becomes the FTS5 chunk title — descriptive labels improve search.
    2. FOLLOW-UP: ctx_search(queries: ["q1", "q2", ...])
       - Multiple related questions about anything already indexed (your captures + session memory). Batch every question in one array; the ranking pipeline runs per-query and the round-trip cost is paid once.
    3. PROCESSING: ctx_execute(language, code) | ctx_execute_file(path, language, code)
       - Derive answers FROM data: filter, count, aggregate, parse, transform. Only what you console.log() enters your conversation; the raw bytes stay in the sandbox.
  </tool_selection_hierarchy>

  <when_not_to_use>
    - You intend to PROCESS the output (filter, count, parse, aggregate) → use ctx_batch_execute or ctx_execute. ${HOST.shell} stays correct when you intend to OBSERVE a short fixed output (git status on a clean tree, whoami, pwd) or when you are mutating state (git, mkdir, rm, mv, navigation).
    - You want to analyze, summarize, or extract from a file → use ctx_execute_file. ${HOST.read} stays correct when you intend to ${HOST.edit} the file (edit needs the exact bytes in your conversation to match against).
    - ${HOST.fetch} → use ctx_fetch_and_index; full network access, results indexed for ctx_search, raw page bytes never enter your conversation.
    - ctx_execute and ctx_execute_file for file writes → these run in the real project filesystem and writes PERSIST. They are for analysis, processing, and computation only; use native write/edit tools for mutations.
  </when_not_to_use>

  <file_writing_policy>
    File writes use the native ${HOST.write} or ${HOST.edit} tool. Do not write through ctx_execute or ctx_execute_file: their subprocess filesystem is not disposable, so changes would persist without the normal editing safeguards.
    Applies to all file types: code, configs, plans, specs, YAML, JSON, markdown.
  </file_writing_policy>

  <output_constraints>
    <artifact_policy>
      Write artifacts (code, configs, PRDs) to files. Return only: file path + 1-line description.
    </artifact_policy>
  </output_constraints>
  <session_continuity>
    Skills, roles, and decisions captured earlier in this session are a memory aid, not a standing order. Treat them as context that may help — the user's most recent message always takes precedence. If a captured directive conflicts with what the user now asks, follow the user; a past phrase does not bind you.
  </session_continuity>
${includeCommands ? `
  <ctx_commands>
    "ctx stats" | "ctx-stats" | "/ctx-stats" | context savings question
    → Call ctx_stats, display full output verbatim.

    "ctx doctor" | "ctx-doctor" | "/ctx-doctor" | diagnose context-mode
    → Call ctx_doctor and display its findings as a checklist.

    "ctx upgrade" | "ctx-upgrade" | "/ctx-upgrade" | update context-mode
    → Call ctx_upgrade. This bundled private port reports manual update instructions because it has no registry or git remote.

    "ctx insight" | "ctx-insight" | "/ctx-insight" | usage analytics
    → Call ctx_insight and show the dashboard address it returns.

    "ctx purge" | "ctx-purge" | "/ctx-purge" | wipe/reset knowledge base
    → Call ctx_purge with confirm: true. Warn: irreversible.

    After /clear or /compact: knowledge base preserved. Tell user: "context-mode knowledge base preserved. Use \\\`ctx purge\\\` to start fresh."
  </ctx_commands>
` : ''}
</context_window_protection>`;
}

/**
 * Upstream `createReadGuidance` — the short nudge attached when the host's own
 * read tool is used, so a file that only needs analysis is not read into context.
 *
 * @returns the guidance text.
 */
export function readGuidance() {
  return `<context_guidance>
  <tip>
    Reading to ${HOST.edit} the file? ${HOST.read} is correct — ${HOST.edit} needs the exact bytes in your conversation to match against.
    Reading to analyze, summarize, or extract from the file? Use ctx_execute_file(path, language, code) — the bytes stay in the sandbox and only what your code prints enters your conversation.
  </tip>
</context_guidance>`;
}

/**
 * Upstream `createGrepGuidance` — the nudge attached when a search tool is used.
 *
 * @returns the guidance text.
 */
export function grepGuidance() {
  return `<context_guidance>
  <tip>
    Grep results may be larger than you expect. When you intend to count, filter, or aggregate matches (not just spot-check one), run the search through ctx_execute(language: "javascript", code: "...") — the raw match list stays in the sandbox and only your derived answer enters your conversation. Use language: "shell" only when the code matches the host shell (PowerShell on Windows, POSIX shell on Unix).
  </tip>
</context_guidance>`;
}

/**
 * Upstream `createBashGuidance` — the nudge attached to a shell call.
 *
 * @returns the guidance text.
 */
export function shellGuidance() {
  return `<context_guidance>
  <tip>
    If this command's output is something you intend to PROCESS rather than merely observe, run it through ctx_execute or ctx_batch_execute instead: the raw output stays in the sandbox and only your derived answer enters your conversation.
  </tip>
</context_guidance>`;
}
