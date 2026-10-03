# DCP port — status, seam, and remaining work

Port of `opencode-dynamic-context-pruning` (upstream at
`C:\Users\pro100noob\.dsh\tes\upstream\opencode-dcp`, AGPL-3.0) into this plugin.
Target: behavioural 1:1 with upstream — the same strategies, ranges, protection rules
and nudges — plus a live, measurable reduction of what the model receives.

Historical snapshot: the implementation details and full-suite result below
predate the [absorption fix](dcp-absorption-fix.md),
[targeted module extraction](refactoring-plan.md), and
[compression safety fixes](dcp-compression-safety.md). Those documents describe the
current behavior, layout, and verification scope. Do not run the old full-suite
command with live settings; its verify/probe children are not safely isolated.

## 1. Where it stands

- **Suite green: <!-- suite:count -->950 marked checks / 0 failures across 21 test + 8 verify + 3 probe files<!-- /suite:count -->**,
  measured by `node scripts/run-suite.mjs`. `test-source-encoding.mjs` emits one check per owned
  file, so the total tracks the file inventory: it is a generated number, never a hand-written one.
- **`run-suite.mjs` labels each file for what it is, and the label is computed rather than assumed.**
  Only `test-context-mode.mjs` and `test-search-guard.mjs` import `node:assert/strict`;
  `verify-status.mjs` fails through its own `process.exit` and `[FAIL]` lines;
  `probe-edit-feasibility.mjs` now owns an exit code too; and `probe-seam.mjs` prints observations
  with no assertion at all, so the runner labels it `[PRINTS ONLY: CANNOT FAIL]` and names it in the
  summary. Four auditors independently refuted the earlier claim that all five "assert through
  `node:assert/strict`" — it was wrong for three, and two of those could not fail at all. That is the
  defect class this section exists to catch: **evidence with no failure mode.**
- Never quote a check count by hand: `run-suite.mjs --update` rewrites every
  `<!-- suite:count -->` marker in `docs/`. Hand-written totals had drifted to three
  different values (480 / 654 / 735) before the runner existed.
- Commits: `59bc0e4`, `e62b981`, `37afefa`, `4a24be7`, `b81f631`, `4c32c20`, `73b092f`,
  `2424e7d`, `2c28bdb`, `6a6f6c7`. One commit per logical step, authored as
  `-c user.name=dcp -c user.email=dcp@local`.
- The automatic pass is proven end to end on a **real** `SessionStore` mounted on the
  plugin's own cordis context: a `tool/result` append, one microtask turn, and then the
  manifest holds a prune, the model view loses the old body and gains the placeholder,
  and the replacement node is on the surface.

## 2. The seams: surface materialization and wire metadata

Upstream never touches history: it rewrites the **outgoing message array** and keeps
summaries in plugin state. DSH does not let a listener replace a request through
`next(rewritten)` (`docs/dsh-core.md` §2.6), so the port materializes compression:

```
session.append('compaction/prune', { shadowedRange, shadowedSeqs, shadowedTokenCount })
session.append(<replacement>, { surfaceOp: { op: 'replace', startSeq, endSeq }, sourceEventSeqs })
```

The two events must be adjacent. Originals stay in the append-only log; the surface —
and therefore `deriveMessages()` — carries the replacement. Measured: `tokenMeter`
2038 → 46 over a shadowed span, so the reduction is real, not a manifest claim.

This is not a workaround around DSH: `compaction/prune` is DSH's own native primitive,
used by its built-in compaction.

Message ids are different: they are request metadata, not conversation history.
`registerWireTransform` composes the editor and DCP transforms, then re-enters the public
LLM stream once with a recursion guard. DCP resolves the session from the request's own
`sessionId` through `sessions.get`, maps raw stable IDs to per-session `m0001…` aliases,
and leaves the session log unchanged. User tags are appended to text parts. An assistant
alias is appended to each completed tool result bound to that assistant's call IDs; this
adapts OpenCode's combined assistant/tool message to DSH's user-role tool-result projection
without changing call/result IDs. The transformed request is deliberately not marked as an
exact agent-loop reconstruction.

### Why compression still materializes

`lib/dcp-blocks.js` also exports `rewriteOutgoingMessages` / `applyToolPruning` — upstream's
`prune()` ported literally, down to the order of the three passes. **Nothing on the live path
calls it.** It is reachable only from the suite.

`BasicCompactionEngine` hooks cordis at exactly four points — `agent/pre-step`,
`agent/status`, `session/event`, `agent/request-error`
(`dsh-compaction-basic\lib\index.js:798,812,815,820`). None is a replacement seam. The
agent loop builds the request from `session.deriveMessages()`
(`dsh-agent-loop\lib\index.js:1204`), and `llm/stream` discards a rewritten argument to
`next`. Re-entering the stream is suitable for small, reversible overlays such as ids;
making the whole compression state depend on that detour would not use DSH's native
surface semantics.

Completed tool output pruning and compression materialize on the **surface**. Metadata,
failed-call input pruning, nudge anchoring and History Editor changes share one outgoing
coordinator and never mutate the durable log. `rewriteOutgoingMessages` remains a comparison
helper; production uses the materialization and shared-wire paths above.

### Harness rules the port must live inside

- A `tool/result` may shadow **exactly one** current `tool/result` and may change only
  `content[0].content`. Failed-call string inputs are therefore stripped on the shared
  outgoing wire transform by call ID; the error output and durable message remain intact.
- `Session.append` is synchronous and throws on **reentry** from a `session/event`
  observer — the strategy pass therefore defers through `queueMicrotask`.
- `session/event` is delivered only through a `SessionStore` entry; a detached
  `Session.create()` notifies nobody. `store.create()` enters inside a cordis effect, so
  a fixture must wait until `store.get(id) !== undefined`. The store must be constructed
  on the **same** `Context` the plugin is mounted on.
- The surface is **not** sorted by seq: a replacement mints a new seq and lands at the
  start index of the range, e.g. `[1, 10, 4, 5, 6, 7, 8]`.
- `assertPrice(tokens)` throws unless the price is finite and non-negative. A `0` price
  makes the GUI context bar treat the span as free forever — including after a restart.

## 3. Block model and range resolution

- Versioned `DcpBlockState` persists blocks, prune kinds, stats, nudge state, measured
  `summaryTokens`, manual permits, compaction marker, `nextBlockId`, and bidirectional
  raw-ID/`mNNNN` aliases per session. Versionless files migrate through tolerant defaults.
- The canonical range shape is `{topic: string, content: [{startId: string,
  endId: string, summary: string}]}`. The local schema also declares optional
  `content[].topic` for compatibility with misplaced fields: a root topic wins;
  otherwise the non-empty nested values must all match and are lifted to one batch
  topic. Both IDs must be visible `mNNNN`/`bN` references; equal boundaries are valid.
  System messages, ignored notices, and the first subagent instruction have no ID.
- DSH tool results are grouped by call ID under their assistant alias before an alias is
  resolved to internal surface boundaries. The internal range is then validated and
  materialized through `materializeSummary`; no sequence address is shown to the model.
- A block is wrapped exactly as `[Compressed conversation section]\n<summary>\n\n` plus
  `<dcp-message-id>bN</dcp-message-id>`. It receives `bN` only, never an additional `mNNNN`.
- Literal `(bN)` placeholders are validated against selected active blocks. Validation
  filters the working list only: unknown and duplicate literals remain in text, the first
  selected placeholder expands the saved body, omitted
  inner blocks are appended under upstream's heading, and boundary blocks are inserted at
  the start/end position. Consumed blocks become inactive and the new block becomes active.
- Protected tool output uses upstream exact/glob matching and DSH call-ID binding. Command
  and compression default protection do not leak into automatic deduplication or purgeErrors.
- Decompression copy-tails the restored span plus newer surface tail, preserving chronology.
  Recompression materializes the saved summary over the restored nodes and updates its anchor.
- A fork reconstructs trusted inherited `bN` blocks only from DCP plugin source, exact header,
  footer and event provenance. Ordinary user text that imitates a block is sanitized and gets
  a normal `mNNNN` alias.
- Native compaction resets and persists every stale address even with zero blocks; the same
  marker check runs when state is first loaded after restart.
- Failed tool results participate in assistant range balancing but are never sanitized or
  tagged as completed output. Their diagnostic bytes survive the provider transform unchanged.
- Nested block ownership is explicit: restoring a parent reactivates uncovered child summaries,
  while recompressing the parent deactivates those children under the parent again.
- The active profile registers `compress` globally. Context Kit enables it for each isolated
  subagent by default; a subagent can compress only its own context. With an explicit
  `experimental.allowSubAgents: false`, the plugin uses the shipped scoped tool seam
  `agent.ctx.tools.restrict({deny:['compress']})` before first prompt assembly. No generated
  npm-cache artifact or DSH core source is modified.

## 4. Review-closure behavior

- One availability decision gates prompt, nudge, tool, DCP commands, automatic strategies and
  wire transforms for disabled, denied and subagent sessions. History Editor commands keep
  their independent gate.
- `/dcp manual` persists a per-session override without changing shared settings. Manual mode
  stores one permit per session; `/dcp-compress [focus]` emits upstream's marker and grants
  one call, while direct and second calls are refused.
- Nudge eligibility uses `used >= min` and strict `used > max`. Turn reminders target assistant
  for `soft` and user for `strong`; provider/model comes from the actual outgoing request.
- Error output is never replaced. `purgeErrors` strips top-level string call inputs on the
  provider-bound copy, preserving nested values, pairing, `deriveMessages()` and log bytes.
- DSH exposes no ignored/noReply chat primitive. Automatic detailed/chat notifications are
  logger/UI-only and never call `agent.inject`, create a step, or enter provider messages.
- Prompt overrides use PromptStore filenames, normalization and project > config-dir > global
  precedence under `dcp-prompts/overrides`.

## 5. The six defects that made pruning a no-op

Each one alone was enough to stop pruning from reaching the model:

1. `shadowedTokenCount` silently fell back to `0`, and that value is what the context bar
   subtracts — the span looked free forever, including after a restart. Fixed by
   `assertPrice`.
2. `blockAtSeq` looked blocks up by `shadowedSeqs` — the **original** events, which stop
   being surface nodes after the replacement. No live block was ever recognized, so `(bN)`
   never expanded.
3. `balancedRange` could return a range whose end preceded its start (`4..8` for a request
   of `10..10`), shadowing six unnamed nodes. Fixed by exact-seq resolution with inward
   snapping plus a structural refusal when `nodes[to] < nodes[from]`.
4. The balance fold did not treat a block as a completed pair, so the snapshot drifted.
5. `requiredBlockIds` came from the boundary blocks only, so an inner block's `(bN)` was
   discarded as unknown and the literal text travelled into the stored summary — the
   previous block's text was not carried over at all, and the result said nothing.
   Fixed by `absorbedIds`.
6. `nodeSeq` was not persisted, so every block came back invisible after a restart.

The old suite could not catch any of this because it asserted on the **return value of a
pure function nobody called**, and because its fixture emitted events through `llm/stream`
— a waterfall whose argument the harness discards. Five checks certified the cancelled
design.

## 6. The age unit: `step/start`, never `turn/start`

Fixed in `59bc0e4`. Recorded because it is the defect that a green suite hid best.

Upstream's counter advances on every `step-start` part and on nothing else — twice, in two
functions that have to agree:

- `syncToolCache` (`upstream\opencode-dcp\lib\state\tool-cache.ts:21,30-33`) walks the
  outgoing messages, increments `turnCounter` per `step-start`, and stores it as the call's
  `metadata.turn`;
- `countTurns` (`lib\state\utils.ts:76-93`) computes `state.currentTurn` as the total count
  of `step-start` parts over the same list.

Both comparisons are then made against that same counter:

| policy | condition | source |
|---|---|---|
| `turnProtection` | `state.currentTurn - turnCounter < turns` → skip the call entirely | `tool-cache.ts:41-52` |
| `purgeErrors` | `state.currentTurn - metadata.turn >= Math.max(1, turns)` | `lib\strategies\purge-errors.ts:72` |

Default `turnProtection` is `{enabled: false, turns: 4}` (`lib\config.ts:670-673`), and the
port's schema carries the same defaults, so the protection window is OFF in both until a
user turns it on. Everything below is about what happens when it is on, and about the
`purgeErrors` threshold, which is always evaluated.

In DSH the analogous event is `step/start {turn, step}` — and `turn` is **not** a usable
substitute for the upstream counter. `dsh-agent-loop\lib\index.js:924,930` sets
`const turn = phase.turn + 1` once per **user** turn, carried across wake-ups through
`lastTurn`; its inner loop (`:936-955`) assigns `step` per iteration. So a user turn holding
twenty steps is ONE turn number. Measured on the 8 MB `session-full.jsonl` of this project:
`turn/start` = 18 against `step/start` = 369; on the 11 MB live log, 57 against 1350. That
is the ≈20-24× coarseness the parity note used to record as ≈42×.

What the port did instead, and why it looked right:

1. `turnsFor` (and `currentTurn`) read `event.data.turn`, so both age policies were measured
   in **user turns** while their thresholds are documented in steps. With `turns: 4` a
   policy waited four whole user turns.
2. A fallback advanced the counter on `turn/start` when a turn logged no `step/start`, so
   the turn-shaped fixtures in the suite read an age of 1 or 2 and their age assertions
   passed — while a real session, which always logs steps, took the other branch.

Consequence measured on the live 11 MB log (1447 completed calls, 31 of them errored):
`purgeErrors.turns = 4` marked 1154 calls eligible under the turn counter against 1444 under
the step counter — **290 calls that upstream would prune were silently protected**. The
errored tail is where it is most visible: those calls sat at 36 turns old while being 652-690
steps old.

Both functions now count `step/start` only, and the fallback is gone. A log with no
`step/start` has an age of 0, which is honest: no step has been taken.

### What the suite had to change with it

The fixtures were rebuilt around the shape `dsh-agent-loop` actually writes, because a
fixture that marks turns and nothing else measures protection while claiming to measure age:

- `stepsSession(steps)` emits one real turn: `turn/start`, then per step `step/start`,
  the assistant message with its batch of calls, one `tool/result` per call, `step/end`,
  and finally `turn/end`; it reads `body`/`isError` per call **or per step**;
- `oneTurnWithSteps(n, {outcome})` and `erroredCallAged(total, age)` build on it, the second
  making a threshold a number instead of an accident of fixture length;
- `duplicatePair` is now two steps of one turn rather than two bare turns.

Three assertions were **wrong**, not stale, and had to be corrected rather than re-fitted:

1. deduplication records the NEWEST copy of a duplicate pair, and the manifest key for the
   prune is therefore the *newer* call id. The old check asserted the older id, so it could
   only ever pass through the protection window — "c1 is protected" and "c1 is pruned" were
   the same observable.
2. `pruneSession`'s report carries `strategy, callId, tokens, label`; it has never carried
   the manifest's `prune` half, so `added[0].prune === 'inputs'` compared `undefined` with a
   string, forever.
3. "the ERROR ITSELF stays in the log" asserted `"command not found"` against `before.text` —
   the JSON of the **whole log**, in a fixture that never contained that string. It was
   reading a different fixture's payload and passing.

And one fixture-level bug that made a check vacuous: `stepsSession` read only
`call.isError`, so a step-level `isError` was dropped and the errored call arrived at the
strategies as a successful one. `purgeErrors` skipped it, and the check "an old errored call
enters the manifest" failed while the code was correct.

Two things worth remembering about the window, both learned while rebuilding the fixtures:

- `isTurnProtected` is `currentTurn - turn < turns` and `currentTurn` is the TOTAL step
  count, so under protection the newest call of a duplicate pair is eligible only if the
  session has taken at least `turns` steps **after** it. A pair whose newest copy sits in the
  last step has no deduplication candidate under any window of 1 or more.
- under `enabled: false` (the default) none of this applies and deduplication runs on the
  whole log.

## 7. Twelve parity defects closed since the first audit

Each one was measured, fixed, and pinned by a check that would fail if it came back.

| # | defect | commit | what it cost |
|---|---|---|---|
| 1 | the age unit was `turn/start`, not `step/start` | `59bc0e4` | 290 calls on the live log that upstream prunes were protected here |
| 2 | the dedup signature did not sort keys recursively (and used `\u0000` where upstream uses `::`) | `2e8c115` | a duplicate survived whenever the same arguments arrived in another key order |
| 3 | `compress.minContextLimit` had no default (upstream: 50000) | `7cf6e6f` | the quiet band was off for every unconfigured install |
| 4 | the output-prune exemption read `message.source?.name`, which DSH never sets | `7cf6e6f` | a failed `write`'s result could be replaced by the failure note — the record of a change that was made |
| 5 | nudges were computed and never delivered | `0fe96fa` | the model was never asked to look for compressible ranges |
| 6 | a top-level `protectedTools` key the port invented and nothing read | `79e3f24` | a user could set it, see no complaint, and get no effect |
| 7 | `/dcp recompress` revived blocks the ENGINE had deactivated | `522fa97` | text a later compression had absorbed would be sent twice |
| 8 | `protectedTools` compared by exact name only | `891520e` | `protectedTools: ["mcp_*"]` silently protected nothing |
| 9 | no `resetOnCompaction` | `891520e` | after a harness compaction, `blockAtSeq` could recognise an unrelated node as a compressed block |
| 10 | `_nudgeCalls` / `_lastNudgeText` were instance-wide | `891520e` | a reminder delivered in one session suppressed the identical one in another |
| 11 | `/dcp sweep N` ran the automatic strategies instead | `915b8d9` | the verb existed in name only |
| 12 | `/dcp decompress` flipped a flag and reported success | `db9e0fc` | the model went on reading the summary; the command was a lie |

Three shapes recur, and they are this port's characteristic failure modes rather than
coincidences:

1. **A config key or a message field that exists in the code and is read by nothing.**
   #4 and #6. #4 is the worst instance — the code that reads it looks correct line by line,
   and only a real session log shows the field it reads is `{ kind: "tool", callId }` and
   never carries a name.
2. **A test seam that does not run the pipeline it certifies.** `resolveConfigForTest`
   skipped `migrateLegacyLimits` (#3), and the whole age-unit family of fixtures asserted
   against turn-shaped logs no real session produces (#1). Both were green while wrong.
3. **A mechanism that assumes another one's state.** #12 is the clearest: `active` is
   meaningful for a request REWRITE, and this port's request path is the durable surface,
   so the flag was true and the model's view was unchanged. #11 is the same shape one step
   removed — a verb that ran a different mechanism than the one it named.

`scripts/test-dcp-integration.mjs` exists for the third shape: it walks one real session
through every mechanism in the order a user meets them, and checks what the model receives
after each step. Two of its checks assert what must NOT happen (`compaction/prune` must not
clear the block registry; a second session must not be touched by the first one's pass),
because those are exactly the failures isolated fixtures cannot see.

## 8. Remaining work

No plugin-fixable DCP gap from the 2026-09 negative review remains. Provider-bound
behavior is covered against captured adapter requests, but a running DSH/provider was not
restarted for this work.

Separate context-mode parity work was completed after this DCP review. The plugin now
exposes the current execution/file/index/fetch schemas, `FILE_CONTENT`, project-boundary
enforcement, directory indexing, scoped purge, auto-memory, current search behavior and
an honest `ctx_upgrade` result for this private bundle. Its subprocess filesystem is not
disposable, so both the tool descriptions and model guidance explicitly forbid using it
for edits.
- ~~`test-context-mode.mjs` and `test-search-guard.mjs` report 0 `[ok]` lines~~ — resolved:
  they assert through `node:assert/strict` and print only names, so the zero was a
  counting artifact, not an early exit. Both run real checks and fail by throwing.
- Operational hygiene: test runs write 300+ fixture state files into the production
  `~/.dsh/context-kit/dcp-state/`.

Order agreed with the user: **finish DCP first**, then build the history editor as a
hybrid (`docs/edit-feature.md` §3).
