# DCP Absorption Fix

## Behavior

- Compression carries selected blocks, not every block in the stored registry.
  Inactive ancestors and unrelated blocks are no longer required placeholders.
  Active ownership of still-visible originals remains supported.
- A carried boundary block stays inside the replaced span. Its previous node is
  removed from the model-visible conversation instead of surviving beside its copy.
- Range order follows the conversation surface, not numeric event order. A newly
  created summary can precede older event numbers. Adjacent unselected blocks are
  not pulled into the range, and a range containing only old blocks is refused.
- Protection rules do not append selected compressed blocks a second time as
  user messages or tagged content. Their text is already carried verbatim.
- Full summary carry and the persisted state format are unchanged. No digest mode
  or automatic rewriting of existing summaries was introduced.

## Verification

The new guards failed before the corresponding fixes. Repeated compression of real
DSH Sessions doubled older facts; protection settings exposed another doubling
path. After the fixes, each tracked fact occurs once in `session.deriveMessages()`.

- `scripts/test-dcp-compress.mjs`: 239 marked checks passed.
- `scripts/test-dcp-range.mjs`: 22 marked checks passed.
- All 24 `test-*.mjs` files passed, run sequentially with
  `DSH_HOME=<plugin>/.suite-state`. This is not a full runner result.
- Coverage includes placed and omitted placeholders, independent ranges, both
  boundaries, protection settings, and continuing after replaying the session log
  and reloading persisted block state into a fresh engine.

The existing full `run-suite.mjs` was not run. Its verify/probe children are not
isolated from live `DSH_HOME`. In particular, `verify-tools.mjs` exercises purge,
and a configured knowledge-base path can override its temporary test path. Those
checks need an isolated home and preset fixtures before a safe full run.

## Refactoring Assessment

Length alone is not a defect, but these files mix responsibilities. Prefer small,
separately tested extractions rather than a rewrite or arbitrary size limits:

1. `lib/dcp.js` (3,204 lines after this fix): move configuration loading,
   normalization and migration out of the compression engine module.
2. `lib/edit-gui.js` (1,171 lines): separate the browser panel script from server
   integration while keeping the current script injection behavior.
3. `lib/context-mode.js` (1,732 lines): separate HTTP fetching, URL validation,
   caching and HTML cleanup from tool registration.

These extractions were not performed as part of the bug fix. Existing module
boundaries already cover blocks, placeholders, strategies, storage and execution.

## Applying And Limits

- The user must restart DSH to load the changed plugin. No running DSH process was
  restarted or stopped during this work.
- Existing duplicated text inside stored summaries is not automatically repaired.
- Normal persisted-state reload is tested. Missing or corrupt block-registry
  recovery is a separate pre-existing risk: visible block IDs may be reused.
- Unrelated working-tree changes were preserved; no commit was made.
