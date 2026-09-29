# Independent Plugins

## Ownership

Three profile-level plugins replace the special preset as the installation unit:

| Entry | Native settings namespace | Owns | Settings timing |
| --- | --- | --- | --- |
| `lib/dcp-plugin.js` | `dcp` | Pruning, `compress`, DCP commands and guidance | Live, subsequent steps |
| `lib/context-mode-plugin.js` | `context-mode` | Context Mode tools, routing guidance and project indexes | Restart |
| `lib/editor-plugin.js` | `history-editor` | `/edit`, the wire overlay, durable editing and the Web panel | Live |

Disabling DCP does not disable the editor or Context Mode. The client registers
three keyed `settings.plugin.item` contributions through DSH's settings scope
and slots services; the cards are not injected into another plugin's UI. Native
settings provide persistence, validation and expected-revision protection. Card
drafts survive invalid JSON and server refusals; successful saves are confirmed
against the published settings snapshot rather than assumed from a void return.

The DCP addon uses a private compaction service with `auto: false`. Its pruning
and explicit compression remain active, while the chosen preset's native engine
owns automatic pressure/overflow compaction and `/compact`. This avoids both a
private-preset monkey patch and two competing automatic compaction engines.

Context Mode selects the default database from the calling session's project,
not the host's mount directory. Usage counters and search throttles are scoped
to the calling session. An explicit `knowledgeBasePath` deliberately selects a
shared database. Database handles are closed when the plugin is disposed.

History Editor retains the existing record paths and expected-text, signed-block,
idle and session guards. Only settings ownership changes. The legacy DCP entry
and GUI runtime adapter remain for existing installations; do not mount legacy
and independent entries together.

## Migration

From the package directory, inspect first:

```powershell
node scripts/migrate-independent-plugins.mjs --check
```

Stop DSH before applying, then run:

```powershell
node scripts/migrate-independent-plugins.mjs --apply
```

The script does not stop or restart any process. `DSH_HOME` chooses the home;
the default is `~/.dsh`. `DSH_MIGRATION_PORT` overrides the shutdown check's port
(default 3080). Stop every host using this home; a port check alone cannot detect
an unrelated CLI process or a host running on an unspecified port.

The migration:

- Restores native `compaction-basic` in the known legacy preset copies and
  removes only the kit's old Context Mode row.
- Preserves the preset ID, selected/default preset, MCP entries and unrelated
  customizations. The old preset can remain selected, but is no longer required.
- Replaces the kit's old editor-host profile entry with three independent entries.
- Imports legacy global settings into `settings.yaml`; existing native namespace
  values win. Editor settings move out of DCP into `history-editor`.
- Leaves old configuration files in place, but the independent entries use native
  settings thereafter. A card cannot be silently overridden by a stale JSONC file.
- Validates configuration, refuses conflicting legacy copies or foreign entries,
  checks resolved target paths against `DSH_HOME`, and checks file contents again
  before replacing them.
- Creates a backup manifest and original bytes under
  `$DSH_HOME/context-kit/migration-backups/<id>/` before applying any change.
  On a caught failure, only unchanged migration-owned output is rolled back;
  concurrent user edits are not overwritten. This is not a crash-atomic multi-file
  transaction, so retain the backup if the process or machine is interrupted.

Session logs, editor records and knowledge-base files are not migrated, opened
or purged by this procedure. `scripts/sync-preset.mjs` is retired so it cannot
overwrite customized presets or bring the old coupling back.

After a successful migration, start DSH normally and reload the browser. Open
Settings > Plugins and check DCP, Context Mode and History Editor. The Standard
preset should also expose their tools; changing the default preset is optional.

## Configuration Limits

The independent settings are profile-wide. Legacy project JSONC overlays are
not read on each request; installations relying on project-specific protection
or disabling rules must review those rules before switching. The old entry still
supports its file layering. The migration imports global settings only and does
not search all projects for local overrides.

DCP inline prompt overrides are profile-wide and editable in its card. Optional
legacy file lookup still uses the addon mount workspace and global prompt
directory, not a dynamically selected per-session project; that lookup defaults
to off. Do not treat it as preserving project-specific custom prompts.

Only the Web profile is migrated. Other profiles require their own installation.
No new model credentials, model routes, network requests to a model, or preset
defaults are needed for this change.

## Verification

The following passed against isolated homes after implementation:

- All 25 `scripts/test-*.mjs` programs passed in the final serial regression run,
  including DCP configuration, compression/materialization, durable editing,
  source encoding and the tests listed below.
- `test-independent-plugins.mjs`: eight guards covering independent entries and
  native card registration, project isolation and purge scope, DCP-off/editor-on,
  a private non-automatic DCP service, preserved migration content, refusal while
  a server is listening, backup/idempotence, and home-boundary isolation.
- `test-context-mode.mjs`, `test-search-guard.mjs`, `test-fetch-guard.mjs`.
- `test-edit-gui.mjs` (62 checks), `test-edit-gui-load-order.mjs` (5 checks),
  `test-edit-wire.mjs`, and `test-dcp-compress.mjs`.

An ordinary isolated DSH on port 3181 loaded the three cards with the shipped
Standard preset, without script injection. The settings browser checks exercised
independent persistence, restart notices, invalid JSON, server validation and
live editor enable/disable. The initial seven checks passed, but the mobile
screenshot was subsequently found to show a dismissed dialog; this is not accepted
as mobile visual verification. The screenshot guard now requires a visible card
before and after capture and reopens Settings after resizing. Its latest rerun
was blocked by Chromium navigation failure. A manual 390px accessibility snapshot
confirmed all three cards and expanded DCP controls; screenshot capture timed out.

The full existing 64-case editor browser rerun also timed out in this environment
after its first nine cases passed. Earlier 64-case results in the editor report
predate this task and are not a fresh full-suite result for this change.

During migration-test development, an incorrect mirror path briefly modified the
live legacy preset instead of a fixture copy. That file was restored byte-for-byte
from the test's backup and verified again after the corrected eight-test run.
The planner now derives both preset locations from `DSH_HOME`, checks physical
paths, and retains a regression for a kit installation outside the fixture home.
No conversation, user settings file or live profile patch was changed by that
incident.

## Live Activation

After explicit user approval, the running Web host was stopped and the migration
was applied to the four planned files. All originals were backed up at:

`C:/Users/pro100noob/.dsh/context-kit/migration-backups/d1616df8-8314-468a-ba8c-3d7083c197a7/`

Verification against that backup confirmed unchanged unrelated settings and MCP
entries, one native compactor in each legacy preset copy, and no remaining legacy
DCP/Context Mode rows in those copies. A repeated migration check reported zero
files requiring changes. The selected/default preset was preserved. Session logs,
editor records and indexes were not part of the migration.

The user then started DSH. The final listener on port 3080 belongs to that normal
`dsh web --no-open` instance; no second host remains on port 3181. A fresh ordinary
browser tab on port 3080, without panel-script injection, showed all three native
cards. Opening each card confirmed DCP and Context Mode enabled with restart
notices, and History Editor enabled with immediate application and the idle guard.
No settings were saved and no model requests, message edits or clipboard writes
were made during this live inspection.

Live screenshots were captured and visually reviewed at 1566x752 and emulated
390x844. On the narrow viewport all three cards were 294px wide inside a 342px
dialog, without horizontal overflow. Console warnings and errors were absent.

- `C:/Users/pro100noob/AppData/Local/Temp/opencode/ctxkit-independent-live-desktop.png`
- `C:/Users/pro100noob/AppData/Local/Temp/opencode/ctxkit-independent-live-390.png`

These live checks supersede the earlier blocked mobile visual inspection, not the
incomplete 64-case editor regression run. Only the inspection tab was closed;
the user's existing tab and running DSH were left open.

## Native Title Color

The palette plugin applies its Markdown accent color globally to `strong`.
Our card titles used that element, so they appeared yellow rather than using the
native primary label color. Titles now use a styled `span`, like the native cards,
with the same primary color, 15px size and 600 weight. No theme rules were changed.

The client-render guard failed before this correction and now passes. The eight
independent-plugin guards, 62 GUI checks and five load-order checks passed again.
A browser regression also simulates an accented `strong` rule. On the ordinary
running page, all three title colors changed from `rgb(245, 167, 66)` to the native
`rgb(238, 238, 238)` through the revisioned client update, without restarting DSH.
No settings were saved; the full settings browser suite was not rerun for this fix.
The live screenshot was visually checked:
`C:/Users/pro100noob/AppData/Local/Temp/opencode/ctxkit-native-card-titles.png`.

## Context Readout And Inventory Names

The native context meter renders nothing until both token usage and a context
limit are available, and otherwise uses a small ring. In the reported conversation,
the stored request and usage records were intact and the native meter was present
during inspection. The exact cause of its earlier absence in the screenshot was
not established; it is not attributed to lost token records or to the migration.

The revisioned client now contributes a numeric readout through the native
`conversation.input.right` list slot, with a stable registration ID. It uses the
current session's public `contextPressure` and `contextBreakdown` projections.
Unknown usage remains visible as `Context waiting`; missing limits are explicitly
reported rather than treated as zero. A popover shows estimated usage, reported
limit, remaining space and approximate composition. Zero, invalid values and
partial projections are guarded. It closes on Escape, outside interaction, viewport
movement or a session change. The native ring is hidden only in the same composer
row while this replacement is mounted; no token-meter backend or session is changed.

The inventory paths were caused by our absolute-file plugin installation: the
native inventory derives its title from the loader module name, not the plugin's
exported name. A scoped presentation adapter now displays DCP, Context Mode and
History Editor for their exact `include:context-kit-*` entry IDs and matching kit
module paths. Native title text nodes, loader identities, full-path tooltips and
detail actions are retained. Accessible labels preserve the current status;
unrelated plugins are untouched and disposal restores owned presentation changes.

Verification for this correction:

- The new readout guard failed before implementation; nine independent-plugin
  guards now pass, including missing/partial/zero usage and session changes.
  A transient timeout in the existing migration subprocess cleared on rerun.
- Both new inventory browser cases failed before implementation and now pass at
  1280px and 390px, including original node identity, foreign entries, status
  updates, native details, disposal and remounting.
- Four existing browser cases for Copy icons and legacy bottom actions passed;
  62 GUI and five load-order checks passed again. This is not a full editor-suite
  rerun, and no backend code changed in this correction.
- The ordinary running page, without script injection or restart, showed all
  three inventory names. The reported conversation displayed 13,710 estimated
  tokens out of 1,000,000. At 390px the button was 44px high and the 280px popover
  stayed within the viewport, with no horizontal overflow. Escape restored focus;
  resize closed the popover without errors. Switching to the dedicated test
  conversation changed the estimate to 20,296 and closed the previous popover.

Live screenshots were captured and visually reviewed:

- `C:/Users/pro100noob/AppData/Local/Temp/opencode/ctxkit-context-tokens-desktop.png`
- `C:/Users/pro100noob/AppData/Local/Temp/opencode/ctxkit-context-tokens-390.png`
- `C:/Users/pro100noob/AppData/Local/Temp/opencode/ctxkit-plugin-names-desktop.png`

The original conversation was selected again before closing only the inspection
tab. No model requests, settings saves, message edits or clipboard writes were
made. A normal page reload is sufficient to load this client-only correction.

## DCP Live Settings

The earlier restart requirement was an implementation choice: the independent
entry captured settings once at mount. DCP now watches its native settings scope,
keeps the same engine, block registry, counters and hooks, and refreshes only its
tool/command registrations. Enabling DCP after a disabled start also works without
restarting. Context Mode's separate restart policy is unchanged.

The DCP card retains Advanced JSON and expected-revision/readback checks. Normal
controls and Advanced edit the same draft, including nested options; invalid JSON
or refused values keep that draft. Useful controls are grouped with explanations:

| Group | Controls and meaning |
| --- | --- |
| When to remind | Lower reminder and upper context-limit thresholds, in whole tokens or percent of the model window; critical reminder frequency; long-run step count; summary allowance. These are DCP reminders, not a new model window or a forced native compaction limit. |
| Cleanup and protection | Deduplication, failed-input cleanup/retention, recent-turn protection, user-text and protected-section preservation, compression mode and notifications. |
| Prompts | System guidance, context reminder, context-limit reminder, long-run reminder, range-tool instructions and experimental message-tool instructions. |
| Advanced | Full configuration, including protected tools/files, exact per-model threshold overrides and experimental options. |

Per-model limits in Advanced take precedence over the global controls. The
long-run reminder is independent of the lower quiet band and can fire below it.
Summary allowance raises the upper threshold by the active summaries' estimated
size. Critical frequency counts DCP pressure checks, normally assistant steps;
diagnostic context checks also use that policy. Existing same-text/session dedup
prevents repeating an identical notice. `nudgeForce` remains a known unsupported
DSH distinction and is not presented as a working UI control.

All six inline overrides are stored under `dcp.prompts`. Nonblank values override
legacy files; resetting inherits an enabled custom file or the bundled text for
the selected mode. The read-only `/ctxkit.dcp/prompts` channel previews that real
fallback without changing the active override. Editing an empty textarea stays
empty while drafting. Switching prompts retains drafts; Save persists them, and
Cancel restores the published configuration. Required tool input format,
protected-tool rules and compressed-block references are still supplied by DCP.
The three reminder paths now actually use their configured prompt overrides;
previously those overrides were not read there.

Server validation rejects invalid/negative limits, percentages outside 0-100,
reversed comparable threshold pairs, and individual prompts over 32,768 characters.
`/dcp manual` updates the same native setting shown by the card, preserving the
legacy object form. Manual mode and denied compression do not inject automatic
compression reminders.

Already-sent model requests are not rewritten. Already-dispatched tool executions
retain their captured definition/policy, but DSH resolves not-yet-dispatched tool
calls against the current registry. Avoid changing compression mode mid-response;
this change does not add per-agent shadow tools that could bypass native tool
restrictions. The chosen preset still owns automatic compaction and `/compact`.

Verification for this change:

- Six live-settings checks cover same-engine updates, thresholds, all prompt
  paths, enable/permission/manual toggles, invalid settings, canonical CLI
  persistence, default/file fallback preview and native controls beside Advanced.
  New behavior was first reproduced with failing guards.
- DCP configuration, nudges, compression and integration suites passed again,
  along with nine independent-plugin checks, 62 GUI and five load-order checks.
- Ten settings-browser cases passed on the isolated server at port 3181. They
  cover save/reload, units and invalid thresholds, all six prompts, multiline and
  literal HTML text, reset, draft retention, unrelated settings and desktop/mobile
  layout. The fixture's late API-key onboarding initially caused cascading
  navigation timeouts; bounded onboarding handling fixed the harness, after which
  all ten passed against a freshly loaded test server. No provider was called.
- Screenshots: `C:/Users/pro100noob/AppData/Local/Temp/opencode/ctxkit-dcp-thresholds-1280.png`
  and `C:/Users/pro100noob/AppData/Local/Temp/opencode/ctxkit-dcp-prompts-390.png`.
  This is not a fresh full editor-browser regression run.

An already running host still needs to load this new server code once. The client
checks the DCP capability/defaults channel and disables unsupported editing on an
old host instead of pretending it can save new settings. After that one-time code
activation, ordinary DCP settings changes do not require a restart. User-server
activation is separate from the isolated verification above.

The subsequent ordinary-browser inspection at `http://127.0.0.1:3080` confirmed
that its running host had already loaded the live-settings implementation. The
read-only capability request returned `liveSettings: true` and all six defaults.
The native card displayed "Applies to the next step", enabled its controls and
showed the existing 50,000 / 150,000 thresholds without an outdated-host warning.
All six prompt choices were present and the current prompt was editable. No
settings were saved or changed during this inspection; no user-server restart,
model request, message edit or clipboard write was performed.

Live screenshot:
`C:/Users/pro100noob/AppData/Local/Temp/opencode/ctxkit-dcp-live-thresholds.png`.
The live tab also logged `ChatNode` / tool-view `createElement` errors outside the
settings slots; those were not investigated or changed in this task. The isolated
settings run had no client runtime errors. Only the new inspection tab and the
owned port-3181 test server were closed; the existing user tab/server were left
running. No additional restart is currently needed to use the DCP settings.
