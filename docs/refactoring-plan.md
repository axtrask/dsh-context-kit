# Targeted Refactoring Plan

Status: implemented and verified on 2026-09-13. The agreed steps below are
retained as the scope record; the completion record is at the end. The baseline
was the working tree, including the DCP absorption fix and existing editor work,
not a clean checkout of HEAD. Those changes were preserved.

## Goal And Scope

Separate three responsibilities that currently share files with plugin wiring.
Keep observable behavior, existing entry points, settings, and persisted data
unchanged. Make one extraction at a time, with a verification gate between steps.

| Order | From | New internal module | Responsibility and reason |
| --- | --- | --- | --- |
| 1 | `lib/dcp.js` | `lib/dcp-config.js` | Schema, reading, normalization, validation, and migration of settings. Configuration should be testable without creating a compression engine. |
| 2 | `lib/edit-gui.js` | `lib/edit-panel.js` | The browser script, including both CSS blocks and DOM behavior. Browser code should be separate from server permissions and service lifecycle. |
| 3 | `lib/context-mode.js` | `lib/context-mode-fetch.js` | URL checks, cache lookup, HTTP loading, and text conversion. Keep the network policy in one place instead of inside tool registration. |

The existing blocks, placeholders, strategies, storage, and execution modules
already have useful boundaries. Do not split them again or add a generic helpers
layer. No new packages, build step, TypeScript conversion, or public package
subpaths are needed.

The main files will still be substantial: roughly 2,600 lines for DCP, 670 for
the editor server, and 1,600 for context-mode after mechanical extraction. These
are estimates, not targets. The goal is clearer responsibilities, not an arbitrary
line limit or fewer total lines. Further splitting requires a separate reason.

## Step 0: Establish A Safe Baseline

1. Inspect the current status and diff. Preserve all existing work, including the
   absorption fix and uncommitted editor changes. Compare against this working
   baseline, not against HEAD alone. If another edit directly conflicts with a
   planned move, coordinate before touching that section.
2. Run the existing `test-*.mjs` scripts sequentially in separate processes with
   an isolated `DSH_HOME` below `.suite-state`. For configuration cases, also
   isolate `XDG_CONFIG_HOME`, `OPENCODE_CONFIG_DIR`, and the workspace searched
   for settings. All database and capture paths must remain inside test storage.
   Do not copy live configuration files into the fixtures.
3. Before each extraction, strengthen the relevant existing test file to exercise
   the behavior being moved. Establish its result before moving implementation.
   Add direct imports of a new module only after that module exists.
4. Record the emitted editor script as a temporary comparison baseline. Do not
   maintain a second 500-line production-script copy as a permanent fixture.

The earlier absorption-fix run passed all 24 `test-*.mjs` files. That is historical
evidence, not a fresh result for this refactoring.

Do not use the current full `scripts/run-suite.mjs` or its `--update` mode for
this work. Its verify/probe children can inherit live settings, and verification
includes purge. Making that runner safe is a separate task, not a prerequisite
for running the isolated test files directly.

## Step 1: Extract DCP Configuration

Move these groups into `lib/dcp-config.js`:

- The complete `Config` schema and its component schemas, including editor
  settings. Moving the editor schema does not move editor implementation.
- `CONFIG_FILENAMES`, `CONFIG_KEYS`, `validateFileConfig`, `readConfigFiles`, and
  `mergeConfig`.
- `normalizeConfigShapes`, `dropOffendingKey`, `canonicalManualMode`, and
  `validateConfigWithRecovery`.
- `BASIC_CONFIG_KEYS`, `basicSubset`, `resolveConfiguration`, and
  `migrateLegacyLimits`.
- `parseLimitValue` and `compressLimitFor`, which interpret configured limits.

Use the existing schema library, path/home utilities, `common.js` helpers, and
the protected-tool default from `dcp-strategies.js`. Keep strategy resolution in
the strategies module. Pass paths, raw settings, and logger explicitly; do not
pass the whole Cordis context, session, or engine into the configuration module.
It must not import `dcp.js` or perform configuration reads at import time.

In `dcp.js`, keep the engine, block-state persistence, prompts, session detection,
commands, tool schemas, editor installation, and DSH lifecycle. Preserve the
startup sequence: determine paths, read files, migrate raw settings, resolve
configuration, create the engine. In particular, retain the `dshHome` fallback,
migration before defaults, and the separate `{ semantic, basic }` results.

Keep the existing `./dcp` package entry and preset module path. Re-export `Config`
and existing configuration test aliases from `dcp.js`: current tests and the
published plugin entry already use that surface. `Config` must remain the same
schema object, not a wrapper. Do not add another compatibility layer.

Extend `scripts/test-dcp-config.mjs` rather than adding a new test framework:

- Exercise real file loading through plugin setup, not just validation of an
  object that happens to resemble a file's contents.
- Cover source precedence, JSON/JSONC conflicts, missing and malformed files,
  reported sources and warnings, and preservation of valid neighboring fields.
- Cover setup without a `dshHome` service, input immutability, and both resolved
  configuration results.
- After extraction, check independent module import and preserved old exports.

Acceptance gate: configuration results and diagnostics stay the same; loading
guards fail if reading or the fallback is bypassed; all DCP tests listed below
pass. The compression algorithm and the new no-duplication guards are untouched.

## Step 2: Extract The Browser Panel

Move the complete private `PANEL_SCRIPT` template, currently about 506 lines,
into `lib/edit-panel.js`. Keep both CSS strings, state, DOM construction, message
matching, observers, and browser request code together.

Use one internal export: `createPanelScript(channel) -> string`. The current
template has exactly one server interpolation, `EDIT_CHANNEL`. Replace only that
reference with the parameter. Keep the remaining literals and escaping intact;
do not introduce host/method/storage-key options, constant deduplication,
`String.raw`, function serialization, or a browser-side module import.

At the old declaration site, `edit-gui.js` builds `PANEL_SCRIPT` by calling the
factory with `EDIT_CHANNEL`. The channel is already initialized there. The
factory does not depend on the later `SESSION_KEY` export, the DOM, or server
services, and importing it does not execute browser code.

Keep server-side access checks, `listValue`/`commitValue`, durable/wire selection,
bridge resolution, routes, lifecycle, diagnostics, and `injectEditor` in
`edit-gui.js`. Preserve the existing inline HTML injection, HTTP contract, and
all exports. Do not add asset routes or change the panel's appearance.

Use `scripts/test-edit-gui.mjs` and its existing emitted-script tests. Preserve
syntax, placeholder, NaN, and DOM-helper checks; do not weaken assertions just
because code moved. Add an import-without-DOM check for the factory.

Acceptance gate: for the existing channel and identical input HTML, both the
emitted script and injected HTML match the pre-move baseline byte for byte.
Editor, load-order, and persistence tests pass. Any browser smoke check must use
a disposable session or isolated fixture, on desktop and narrow/mobile layouts;
do not edit working conversation history. Do not claim live UI verification
before the user has restarted DSH to load the changed plugin.

## Step 3: Extract URL Fetching

Move `classifyIp`, `ssrfRefusal`, the three `FETCH_*` constants, cache freshness
checks, HTTP/body loading, and `toPlainText` into `lib/context-mode-fetch.js`.

Use one orchestration function:
`fetchOneUrl({ url, source, force, ttl }, knowledgeBase)`.
It checks the URL before consulting `knowledgeBase.sourceMeta()` and returns a
cached result, fetched text with metadata, or an explicit refusal. Network and
storage exceptions remain handled by the existing per-URL error path. The module
does not create, close, or write the database. Do not introduce a cache interface,
service container, or another worker pool.

Keep schemas, request normalization, the worker queue, concurrency limits,
synchronous `knowledgeBase.index()` calls, counters, result ordering, and tool
response formatting in `context-mode.js`. Index each successful fetch inside its
worker as today, not in a new phase after accumulating all response bodies.

Keep the original source/URL cache key, source defaults, TTL/force semantics,
request headers, strict-mode setting, error isolation, and output shape. Do not
deduplicate requests or start applying the currently unused `fetchAllowedHosts`
setting. Keep existing `./context-mode` exports, including helper exports used
by `test-fetch-guard.mjs`, via direct re-exports where definitions move.

Extend `scripts/test-fetch-guard.mjs` to exercise the registered tool handler,
not only IP classification. Use an isolated process with controlled HTTP
responses and a temporary database, not external websites or the live KB.

- Verify that URL refusal happens before a cache hit can be returned.
- Cover independent URLs sharing one source label, cache hits, TTL expiry,
  `ttl: 0`, and `force: true`.
- Check text conversion, per-URL failures, index failures, counters, metadata
  without raw page bodies, concurrency limits, and duplicate-request handling.
- Compare supported behavior before and after the move. Record pre-existing
  defects separately; do not turn unsafe behavior into a permanent desired test
  contract or quietly repair it as part of extraction.

Acceptance gate: fetch, knowledge-base, and context-mode tests pass; public
results, successful indexing, and counter changes remain equivalent. The new
module has no import back into plugin registration or the editor.

## Verification Matrix

Run each script with `node`, from the plugin directory, under the isolated test
environment described above. Stop on a nonzero exit or a failure marker.

| Step | Focused scripts |
| --- | --- |
| DCP configuration | `scripts/test-dcp-config.mjs`, `scripts/test-dcp-nudge.mjs`, `scripts/test-dcp-strategies.mjs`, `scripts/test-dcp-compress.mjs`, `scripts/test-dcp-range.mjs`, `scripts/test-dcp-materialization.mjs`, `scripts/test-dcp-integration.mjs` |
| Browser panel | `scripts/test-edit-gui.mjs`, `scripts/test-edit-gui-load-order.mjs`, `scripts/test-edit.mjs`, `scripts/test-edit-durable.mjs`, `scripts/test-edit-wire.mjs`, `scripts/test-realm-reach.mjs` |
| URL fetching | `scripts/test-fetch-guard.mjs`, `scripts/test-knowledge-base.mjs`, `scripts/test-context-mode.mjs` |
| After all moves | All `test-*.mjs` files, including source-encoding and upstream-text-parity checks; `node --check` for changed JS/MJS files; `git diff --check` |

If a gate fails, do not stack the next extraction on top or weaken the guard.
Locate the regression in the current step. A required behavior fix gets a
separately identified scope and verification, not a hidden place in this move.
Review the final diff for lost exports, changed strings/defaults, circular
imports, and edits outside the agreed responsibilities. No commits are made
unless requested. Do not restart or kill a running DSH process.

## Upstream And Separate Work

Separate upstream checkouts were consulted for the extraction boundaries:
`opencode-dcp/lib/config.ts` and `context-mode/src/server.ts`.
The browser editor is a local DSH integration, not an upstream web panel.
Reuse this port's implementation; do not copy upstream source.

The following are not part of this behavior-preserving refactoring:

- Config alignment with upstream: the port currently uses different file
  precedence and shallow file merging. Legacy-only file recognition and combined
  legacy-limit migration also have existing edge cases needing separate fixes.
- Fetch hardening: automatic redirects and a second DNS resolution can escape
  the initial URL check. The current size check happens after full body loading
  and counts characters, not UTF-8 bytes. HTTP-error and empty-body handling also
  differ from upstream. These deserve a dedicated correctness/security change;
  do not copy upstream subprocess-only network patches into shared DSH globals.
- Full-runner isolation, digest mode, missing-registry recovery, repair of old
  duplicated summaries, and a rewrite of the compression engine or editor.

After the three steps, reassess the remaining files based on actual coupling and
maintenance friction. Do not automatically continue splitting them for size.

## Completion Record

All three extractions were completed in order, with their focused verification
gates passing before the next production move. No new dependencies, build step,
settings, public package subpaths, or persisted-data format were introduced.

| Original module | Lines before | Lines after | Extracted module | Lines |
| --- | ---: | ---: | --- | ---: |
| `lib/dcp.js` | 3,204 | 2,603 | `lib/dcp-config.js` | 612 |
| `lib/edit-gui.js` | 1,171 | 667 | `lib/edit-panel.js` | 508 |
| `lib/context-mode.js` | 1,732 | 1,569 | `lib/context-mode-fetch.js` | 172 |

Line counts include comments and blank lines. These are responsibility
boundaries, not a reduction in total implementation size.

- DCP keeps the same exported schema object and test aliases. The engine and
  plugin setup function match their pre-refactor SHA-256 fingerprints. Real
  file-loading tests cover precedence, warnings, recovery, and the home fallback.
- The editor factory is `createPanelScript(channel)`. Its output is byte-identical
  to the previous 24,864-byte script, including both CSS blocks; HTML insertion
  and the server functions also match the pre-refactor fingerprints.
- `fetchOneUrl({ url, source, force, ttl }, knowledgeBase)` owns URL checking,
  cache reads, loading, and conversion. The main plugin still owns the queue,
  synchronous indexing, counters, exception handling, and public results. The
  registered handler was tested against controlled HTTP responses and a real
  temporary database both before and after extraction.
- The three existing focused test files were strengthened before implementation
  moved. Deliberate in-memory mutations proved that the new guards detect lost
  configuration loading, browser-script changes, and fetch/cache/counter/queue
  regressions. No mutated production files were retained.

The initial baseline and final sequential run both passed all 24 `test-*.mjs`
files in separate Node processes with isolated settings and test storage. The
final run used `.suite-state/refactor-final-1789294244795`, with a separate home
for each script. This is not a full-runner result: verify/probe scripts and
`run-suite.mjs --update` were deliberately excluded for the safety reasons above.
Syntax checks and whitespace checks passed. Independent static review found no
new regressions within the agreed scope.

No live browser/UI smoke test or DSH restart was performed. Existing work was
not reverted and no commits were made. The user must restart DSH to load the
changed modules. The separate work listed above remains separate and unfixed.
