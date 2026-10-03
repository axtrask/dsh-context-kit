# dsh-context-kit

Independent DeepSeek Harness plugins for context management and history editing:

- **DCP** — [`Opencode-DCP/opencode-dynamic-context-pruning`](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning)
  (upstream AGPL-3.0-or-later). A `compress` tool the model calls on finished
  spans, plus deterministic cleanup: deduplicate repeated tool calls and purge
  the inputs of failed ones.
- **context-mode** — [`mksglu/context-mode`](https://github.com/mksglu/context-mode)
  (upstream ELv2). Sandboxed "think in code", and a searchable knowledge base
  instead of dumping output into the conversation.
- **History Editor** edits messages and effective assistant text independently
  of either context-management plugin.

Neither is a port of upstream source. They are reimplementations of the
*behaviour* in harness vocabulary: DCP lands through the official compaction
seam, and context-mode becomes native tools instead of an MCP server. No
upstream code is copied, so neither licence is inherited.

## Independent Plugins

The profile-level entries are `lib/dcp-plugin.js`, `lib/context-mode-plugin.js`
and `lib/editor-plugin.js`. Each has its own native **Settings > Plugins** card
and settings namespace. They work with the shipped Standard preset; a dedicated
context-kit preset is no longer required. DCP settings apply live to subsequent
steps; its card exposes thresholds, six editable prompts and cleanup controls
alongside Advanced JSON. Context Mode still requires a host restart; History
Editor settings apply immediately. Loading new server code once is separate
from changing settings in an already updated DCP plugin.

See [installation, migration and verification](docs/independent-plugins.md).
Existing installations must be migrated while DSH is stopped; merely adding
the new entries alongside the old preset would register duplicate tools.

## Layout

```
$DSH_HOME/plugins/dsh-context-kit/       the plugins (this package)
  lib/dcp.js                             DCP: engine + compress tool + commands
  lib/dcp-plugin.js                      independent DCP host entry
  lib/context-mode.js                    context-mode: ten ctx_* tools + guard
  lib/context-mode-plugin.js             independent Context Mode host entry
  lib/editor-plugin.js                   independent editor host entry
  lib/dcp-strategies.js                  the pure pruning planners
  lib/session.js, lib/common.js          surface reading and shared plumbing
  lib/knowledge-base.js                  SQLite FTS5 store (node:sqlite)
  lib/sandbox.js                         javascript / python / shell runner
$DSH_HOME/plugins/presets/context-kit/    retained legacy preset identity/customizations
$DSH_HOME/.agent-presets/context-kit/     legacy copy, if present
```

The original installation replaced the preset's compaction provider. The
independent DCP entry instead adds pruning and explicit compression in a private
service scope. The selected preset retains its native automatic pressure and
overflow compactor, including `/compact`; there is no second automatic engine.
Legacy entry points remain available for existing consumers, but must not be
mounted alongside the independent entries.

`$DSH_HOME/plugins/dsh-context-kit/node_modules` is a **junction** into the
installed harness's package tree — it is what lets the plugins resolve
`@deepseek-ai/*` while living outside the harness. Repoint it after a DSH
upgrade that changes the npx cache path.

## DCP

| Piece | Behaviour |
|---|---|
| `compress` tool | **The model writes the summary and passes it in.** Range mode keeps upstream's canonical shape: `topic` plus `content: [{ startId, endId, summary }]`, with string `mNNNN`/`bN` boundaries. As a local compatibility fallback it also accepts a misplaced `content[].topic`: the root wins when present, otherwise all supplied fallback values must match. Message mode uses `{ messageId, topic, summary }`. Each summary is materialized through `compaction/prune` + one `user/message`; internal surface sequences never enter the model-facing protocol. |
| message IDs | Stable per-session `m0001…` aliases are assigned by raw message ID. Successful completed outputs carry the assistant alias; failed results still close the range but keep diagnostics byte-identical, so an error-only assistant puts its alias on assistant text. Ordinary outbound text is sanitized; only active, source-verified DCP summaries retain `bN`. |
| range edges | `startId=endId` is valid. An assistant boundary includes every completed result bound to that assistant's tool call IDs. Internal DSH surface edges are still validated as a tool-pairing-balanced region before materialization; aliases never expose those internal sequence numbers. |
| batches | Several entries per call are allowed; they may not overlap, and the check runs over the shadowed nodes so snapping cannot smuggle a collision through. |
| protection | `compress.protectTags` appends `<protect>…</protect>` text verbatim; `compress.protectUserMessages` appends the user messages inside the span. `compress.permission: "deny"` removes the tool from the catalog entirely. |
| deduplication | Invocations with the same tool name and normalized argument JSON are duplicates; top-level nulls are omitted, nested nulls remain significant, and the newest result survives. |
| purgeErrors | After N steps (default 4), top-level string inputs of a failed call are replaced on the provider-bound copy. Nested values, the error output, `deriveMessages()` and the durable log remain unchanged. |
| turn protection | Optional window (`turnProtection.turns`) inside which nothing is touched. |
| protected tools | Compression defaults to the mapped DSH equivalents of upstream `task`/`skill`/`todowrite`/`todoread`; command sweep uses upstream's wider mapped list. Automatic deduplication and purge-error strategies default to empty `protectedTools`, exactly as upstream, and read only their own lists. Exact names and `*`/`?` patterns are supported. |
| protected files | Upstream glob patterns matched against the normalized full `filePath`, including paths extracted from `apply_patch` and `multiedit`. Use `**/*.env` for nested files; matching is case-sensitive. |
| block registry | Every landed compression receives a stable `bN` reference. Versioned state persists aliases, measured summary tokens, stats, nudges and ownership per session. Forks reconstruct trusted inherited blocks and continue at the next `bN`; native compaction resets stale addresses. |
| decompress/recompress | Decompression uses a copy-tail rewrite so restored middle history remains before newer tail messages. Decompressing a parent reactivates uncovered consumed children; recompressing it restores child ownership. Accepted references are `b1`, `B1`, `1`, and legacy `#1`. |
| subagents | `allowSubAgents` defaults to `true`, so every isolated subagent gets its own `compress` tool for its own context only. With an explicit `false`, `agent/created` installs `agent.ctx.tools.restrict({deny:['compress']})` before first prompt assembly. Main-agent and global catalogs retain `compress`; no DSH core patch is required. |
| nudges | The system prompt states policy; measured turn/iteration/context nudges are added to the outgoing copy. The floor applies first, max is strict (`used > max`), and `nudgeForce` chooses assistant (`soft`) or user (`strong`) for turn reminders. Actual request provider/model selects per-model limits. |
| commands | `/dcp` (status), `/dcp-compress [focus]`. |
| config | The independent entry uses the native `dcp` settings namespace. Migration imports legacy global configuration once; subsequent file edits do not override the settings card. Project JSONC layers belong to the legacy preset entry, not the independent entry. See the migration limits before switching an installation that relies on project overrides. |
| reporting | `pruneNotification` controls off/minimal/detailed operator reporting. DSH has no ignored/noReply chat primitive, so automatic and sweep/compression cleanup reports are logger/UI-only and never injected as model-visible turns. |
| every key does something | `compress.permission`, `compress.showCompression`, `compress.summaryBuffer`, `compress.maxContextLimit`/`minContextLimit`, `compress.modelMaxLimits`/`modelMinLimits` (keyed by an exact `provider/model`), `compress.nudgeFrequency`, `compress.iterationNudgeThreshold`, `compress.nudgeForce`, `compress.protectTags`, `compress.protectUserMessages`, `compress.protectedTools` (their output is carried INTO the summary), `commands.enabled`, `commands.protectedTools` (manual sweep only), per-strategy `protectedTools`, `experimental.allowSubAgents`, and `experimental.customPrompts`. |

Both automatic strategies plan purely from the session surface. Completed output
prunes materialize through DSH's replacement protocol; failed-input prunes use
the shared wire coordinator because assistant tool arguments are provider-bound.

### Two things that will bite an implementer

- **`inject` must not name the service you publish.** The engine subclasses
  `CompactionEngine`, so it *provides* `ctx.compaction`. Listing `compaction` in
  `inject` makes the row wait on itself forever, and every other consumer of
  that service — `command-compact` included — waits with it. The engine reaches
  its own service through `this.ctx.compaction`.
- **The shipped backend rejects unknown config keys.** `BasicCompactionEngine`
  takes only `thresholdRatio`, `retainRatio`, `retainTokens`,
  `summarizationProvider`, `summarizationModel`, `maxTokens`,
  `compactionRetries`, `maxOverflowRetries`, `modelPolicies`, `auto`. DCP's own
  keys are separated before `super()` is called.

## context-mode

| Tool | Behaviour |
|---|---|
| `ctx_execute` | Run `javascript` / `python` / `shell`; only bounded stdout enters the conversation. |
| `ctx_execute_file` | Same, with host-readable file content exposed as `FILE_CONTENT` / `FILE_CONTENT_PATH` (and the path retained in `CTX_FILE`). Set `restrictPathsToWorkspace: true` for a hard project boundary. |
| `ctx_batch_execute` | Many shell commands in one call, indexed separately, with the requested searches answered in the same round trip. |
| `ctx_index` | Store content or a bounded host-readable file/directory walk under source labels. Relative paths start in the project. |
| `ctx_search` | Relevance or timeline search, several queries per call, source filter (case-insensitive substring), `contentType: "code" \| "prose"` filter. |
| `ctx_fetch_and_index` | Fetch URLs, strip HTML, index; the raw body never enters context. |
| `ctx_stats` / `ctx_doctor` / `ctx_purge` | Measured byte counters; runtime and `integrity_check`; confirmed session/project purge. |
| `ctx_insight` | The upstream Insight dashboard's address as a pointer. It is an external site and the port never launches a browser — the reply says so, and the failure branch fires when the URL cannot be embedded (not absolute, not http(s), whitespace or markup characters). |
| `ctx_upgrade` | Honest manual-update notice: this bundled private plugin has no package registry or git remote to update from safely. |
| `/ctx [stats\|doctor\|purge]` | The same, from the command line. |
| routing guard | `tools/pre-execute` refuses `curl`/`wget`/`Invoke-WebRequest` and inline-HTTP shell commands, naming the tool to use instead. Disable with `routingGuard: false`. |

`ctx_search` carries the upstream throttle: one rolling window per calling
session (`searchWindowMs`, default 60000), a soft cap after `searchSoftCap`
(default 3) calls that trims every query to ONE hit, and a hard refusal after
`searchBlockCap` (default 8) with upstream's `BLOCKED: …` text. A call that
batches several queries counts ONCE, which is what the throttle line tells the
model to prefer. Each query returns at most two hits — upstream's ceiling, and
deliberately not configurable — and the rendered reply is capped at
`searchMaxChars` (default 40960); a query that would cross the cap is replaced
by `(output cap reached)` instead of being dropped in silence. `searchLimit`
(default 3) is only the pre-clamp default for a call that passes no `limit`.
The counter lives in memory, keyed by `session.id`, and is never written down.

The knowledge base is **Node's own `node:sqlite`** (FTS5 included), with no native
build. The default database is selected from the calling session's project;
usage counters are per session. An explicit `knowledgeBasePath` intentionally
shares a database. Existing database files are neither moved nor purged by
migration.

Two design notes worth knowing:

- **Child output is captured through files, not pipes.** The harness's Windows
  sandbox denies a confined process the named pipes Node uses for
  `stdio: 'pipe'` (`spawn EPERM`), and a file capture is the better design
  anyway: the complete output is already where the truncation notice points, so
  there is no second write to keep in sync. The INDEX is built from that capture,
  never from the bounded text, so a 5000-line run is fully searchable while the
  conversation receives only a short pointer.
- **UTF-8 is forced, twice.** `PYTHONUTF8=1` and `PYTHONIOENCODING=utf-8` go into
  every child, because Python on a non-UTF-8 system locale encodes stdout as the
  ANSI code page — Cyrillic came back as replacement characters and an emoji
  killed the program outright. PowerShell scripts are written as UTF-8 **with a
  BOM**, because Windows PowerShell 5.1 reads a BOM-less `.ps1` as ANSI and fails
  to parse a non-ASCII source at all.
- **`node:sqlite` is imported lazily**, after a warning filter is installed, so
  Node's `ExperimentalWarning` never appears above the chat. No other warning is
  suppressed.

### What the sandbox is NOT

`ctx_execute` runs a **subprocess**, not a confined sandbox. It inherits the
environment and can write anywhere the account can — unlike the harness's own
shell tools, which the sandbox policy confines to the workspace. `TEMP`/`TMP` are
  pointed at `$DSH_HOME/context-kit/tmp`, which is swept on mount (files younger
  than `scratchRetentionMs` are kept so a recent result's capture path stays
  readable). Treat the tool as
an analysis facility, and do not rely on it as a security boundary.

## Verify

For the independent installation, start with
`node scripts/test-independent-plugins.mjs`. It uses isolated homes and checks
the settings, editor independence, project isolation and offline migration.
`scripts/check-plugin-settings-browser.mjs` is restricted to a separate test
server on port 3181, because it deliberately changes settings.

The older preset-specific checks below remain relevant only to the legacy
installation. Do not run destructive integration suites against the live home.

```
node scripts/verify-load.mjs         # preset rows, imports, config, sqlite, sandbox
node scripts/verify-preset.mjs       # preset STRUCTURE: dcp inside the compaction realm
node scripts/verify-activation.mjs   # both plugins activate in a REAL cordis root
node scripts/verify-status.mjs       # INVOKES /dcp and /dcp-compress, not just mounts them
node scripts/verify-tools.mjs        # INVOKES every ctx_* tool; JSON safety, UTF-8, timeout, full index
node scripts/verify-parity.mjs       # the tool catalog, config defaults, and compress-tool shape on disk
node scripts/verify-routing.mjs      # the routing guard blocks fetches, not the word "curl"
node scripts/test-dcp-strategies.mjs # planners: dedup, protection, purge, windows
node scripts/test-context-mode.mjs   # sandbox (3 languages, bounds, timeout), FTS5
node scripts/test-search-guard.mjs   # search throttle window/caps, source filter, content type
```

Each script guards a failure mode that the others cannot see:

| Script | Catches |
|---|---|
| `verify-activation` | dependency injection unsatisfied — a row that injects the service it publishes, or waits on one nothing provides |
| `verify-preset` | a provider mounted OUTSIDE its consumer's realm, which otherwise appears only when a session composes |
| `verify-status` | a defect inside a command handler — mounting a command proves nothing about running it |
| `verify-tools` | a canonical value that is not lossless JSON (`undefined` nested anywhere), a returned value that does not match the declared output schema, mangled non-ASCII output, a swallowed timeout, or an index that holds less than the full capture. The harness rejects a non-JSON result with "returned invalid output" **after** the tool has already run, so the work happens and the model never sees it |
| `verify-routing` | a routing guard that matches the WORD `curl` instead of an actual fetch, refusing commands the model cannot fix |
| `verify-load` | unresolvable rows, invalid configuration, missing SQLite/FTS5, a broken sandbox |

Run all six after ANY edit to the kit or a preset regeneration.

A session is composed from its preset AT CREATION and keeps it for life, so
switching presets means starting a NEW session; the picker in Settings > General
only decides the default for sessions created later.

In a live session: `ctx_doctor` should report `[ok]` for javascript, python,
shell and the knowledge base; `/dcp` should print the strategy table; a long
session should show `compaction/prune` events in its log
(`node scripts/dump-session.mjs <session.v3.jsonl.zstd>` turns a session file
into readable JSONL).

## Migrate Instead Of Regenerating

`scripts/sync-preset.mjs` is retired: regeneration could overwrite user changes
and reintroduce plugin coupling. Run
`node scripts/migrate-independent-plugins.mjs --check` for a read-only plan.
After stopping DSH, `--apply` creates backups and migrates only the kit-owned
entries. Preset identity, MCP entries and unrelated settings are preserved.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `2 row(s) did not activate: dcp … waiting for compaction` | The inject cycle described above. `dcp` must not inject `compaction`. |
| `1 row(s) did not activate: command-compact … waiting for compaction` | `dcp` is mounted OUTSIDE the `compaction` group, so it publishes into the root realm while `command-compact` resolves the group's isolated symbol. Move the `dcp` row inside the group, before `command-compact`. |
| `Cannot read properties of undefined (reading 'deduplication')` | Two different causes, both fixed here: merging a config file onto an unvalidated row (validate through `Config()` first), and — subtler — reading `this.config` for DCP settings. The parent's constructor assigns `this.config` as an OWN property, which shadows any subclass accessor; DCP settings live on `this.dcpConfig`. |
| `BasicCompactionConfig: unknown key "enabled"` | DCP config leaked into the parent engine. Pass only the parent's key subset. |
| Every tool fails with `unknown tool "<name>"` | A malformed profile patch. `cordis.patch.yml` in the active profile must be a valid four-line `[]` document (or a valid patch array). |
| Rows fail to resolve | The `node_modules` junction is stale — repoint it at the current harness tree. |
| Knowledge base says "still loading" | Retried within the first microtask after mount. Retry; it settles immediately. |
| `spawn EPERM` | The sandbox was changed back to piped stdio. Use file descriptors. |
| `tool "ctx_execute" returned invalid output: value is not lossless JSON` | The canonical value held `undefined`. Classic cause: a boolean built as `a \|\| b \|\| c` where the flags are only ever SET on one path, so the clean path yields `undefined`. Coerce with `=== true`. |
