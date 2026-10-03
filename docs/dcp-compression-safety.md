# DCP compression safety

Implemented and re-verified on 2026-09-19. This follows the
[absorption fix](dcp-absorption-fix.md) and the
[module extraction](refactoring-plan.md).

## Current surface addresses

The model selects stable `mNNNN`/`bN` references. The resolver maps them to raw
message IDs and only then to the current DSH surface; internal sequence numbers
are never accepted by the tool. `startId=endId` is valid. System messages,
ignored notices and the first subagent instruction receive no alias, so they
cannot be selected as boundaries. An assistant alias includes every completed
tool result matched to its call IDs.

## Publish only landed replacements

`materializeSummary` in `lib/dcp-blocks.js` validates live boundaries, message
shape, price, lossless JSON and the exact ordered source list before appending
anything. It uses public harness validation APIs, without copying the session
history or mutating private fields.

The compression handler prepares the summary before consuming a block ID.
Only after the replacement lands does it deactivate absorbed parents, register
the new block, update compression counters and persist the registry. Each landed
block is saved separately: a later runtime failure in a batch cannot erase the
registry record of an earlier successful replacement.

Automatic pruning runs after successful range replacements, not before address
validation. A rejected system or stale range therefore cannot prune unrelated
messages as a side effect. The batch uses a snapshot of the addressed surface.
Cleanup of obsolete prune claims is also persisted when no new output is pruned,
including manual mode with automatic strategies disabled.

## Wire metadata

Aliases are added through the shared History Editor wire coordinator. The
request's `sessionId` is resolved through `sessions.get`; a second session cannot
reuse the first session's map. The provider-bound copy changes, while the frozen
request, `deriveMessages()` result and durable log remain byte-identical.

The same coordinator strips untrusted/stale DCP tags, removes top-level string
inputs for failed calls, and anchors nudges to the upstream role. Tool results,
nested arguments, call IDs and durable events are preserved.

Error tool-result diagnostics are excluded from hallucination stripping, matching
upstream's completed-output-only rule. They still balance assistant ranges, while
their assistant alias is placed on assistant text when no completed output exists.

Automatic prune notifications are never sent through `agent.inject`: DSH has no
ignored/noReply chat primitive, so they remain logger/UI-only and cannot create a
model-visible turn.

## Restore and lifecycle

Decompression copy-tails both the restored span and every newer live node before
collapsing the old range. A restored middle section therefore remains before its
newer tail. Recompression replaces those contiguous restored nodes with the saved
summary again. Native compaction resets all stale aliases and prune addresses;
the persisted compaction marker applies the same reset after restart. Forks only
adopt `bN` summaries with trusted DCP source, exact wrapper and provenance.
Nested ownership is restored with the surface: an uncovered consumed child becomes
active/addressable after its parent is decompressed and is deactivated again when
the parent is recompressed.

## Verification and limits

- The focused 15-script regression set passed with 897 marked checks; the final
  production review script adds 22 grouped checks, for 919 marked checks total.
- Real Session regressions failed before the fixes and passed afterwards. They
  cover refreshed system heads, stale IDs, refusal side effects, parent/ID/count
  preservation, partial-batch reload, cleanup reload and executable hint batches.
- Existing nested-summary, protection and reload tests remain passing.
- The negative-review regressions use real Context, SessionStore, LlmRuntime,
  command and tool registrations, captured adapter requests and replayed logs.
- `DSH_HOME`, XDG/custom config paths and test databases were isolated. The full
  runner's verify/probe programs were not used because of their live-home risk.
- The harness exposes two separate appends, not a transaction. Unexpected failure
  between them can still leave a prune event; arbitrary rollback is not promised.
- Previously corrupted registry entries and old embedded duplicates are not
  migrated. A top-level `topic` remains canonical. Range mode tolerates misplaced
  `content[].topic` values only as input compatibility: the root wins when present;
  without it, all non-empty nested values must agree on one batch topic.
- No live DSH restart, live-session repair or commit was performed. The user must
  restart DSH to load the updated plugin. Large-history hint latency was not measured.
