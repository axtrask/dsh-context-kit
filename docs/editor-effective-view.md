# Effective Editor View

Implemented and verified on 2026-09-13. This is the current behavior; the older
[English](editor-ui.md) and [Russian](editor-ui.ru.md) editor notes retain the
historical investigation.

## Reported Bugs

| Report | Correction |
| --- | --- |
| B1: wire edits reopen the original | List and commit use the same effective projection. Text, character counts, block targets and edit badges update without waiting for another model request. New edits check the effective text they opened. |
| B2: a reply opens Thinking by default | A list entry prefers its editable Answer target. A block-specific pencil still opens that exact block; thinking-only messages remain editable. |
| B3: user pencil says Answer | User targets are labelled Message; assistant targets distinguish Answer, Thinking, Tool call, and Tool result. Each shadow button has a matching accessible name and tooltip. |
| B4: durable edits never appear in Chat | Verified editor replacement ancestry maps the current surface message back to its original Chat row. A reversible Chat projection displays effective text without rewriting the audit. |
| B5: several rows stay open | There is one active editor. Switching rows or targets protects unsaved drafts, including drafts held separately across sessions. |
| B6: misleading branch/status text | Confirmation identifies the edited target. A wire branch alone does not produce an edited badge. |

## Data And Safety

- `lib/edit.js` applies new `basis: 'effective'` records sequentially. Existing v1
  records keep their original-basis behavior and their saved `before` values.
  Malformed persisted anchors are diagnosed and skipped individually.
- `lib/edit-durable.js` keeps `editableIndex` raw and provides a separate
  `effectiveEditableIndex`. Verified `originSeq` and `originId` follow editor-owned,
  single-source user replacements and core-valid content-only `tool/result` replacement
  chains, not DCP or guessed ID suffixes.
- `lib/edit-gui.js` returns the last 40 entries for the panel and the complete
  transcript projection for older visible Chat rows. A stale `expected` value is
  rejected before writing. Disabling the editor disables wire projection as well;
  already-durable replacements remain part of the surface.
- An explicit durable `blockAt` changes only the selected text block. Editing
  `[A, B]` successively produces `[X, B]` and `[X, Y]`, not `[X, X]`.
  Legacy calls without a block keep their existing whole-message contract.
- The request body remains bounded at 128 KiB, allowing both expected and new
  text in a request. Tests cover two 40 KiB strings and rejection above the limit.

## Browser Integration

`package.json` declares the existing package's web `./client` export.
`lib/edit-client.js` is a small classic client-module registration, served by the
installed registry without a build step or new dependency. The existing absolute
host row for `edit-host.js` is sufficient for discovery; presets were not changed.

The bridge subscribes to the public `ctx.sessions.list` store. The panel uses
that tab's current selection, never shared `localStorage`. Missing selection or
provider disposal disables editing and clears projections. Responses from an
earlier session epoch cannot update the current panel. Chat nodes retained from
another session cannot acquire the new session's pencils or effective text.

`lib/edit-panel.js` decorates only settled, unambiguously matched Chat rows. It
recognizes the installed slot wrapper, CSS-module shapes and Thinking disclosure.
Confirmed Message, Answer and expanded plain-text Thinking containers are edited
directly and display effective text in their native body. Tools, attachments,
fold controls, the session ledger and Trajectory stay intact. Known Markdown
code-banner Copy controls are retained with the original nodes for cancellation;
unrecognized embedded controls still require the history panel.
Multiple user text blocks share one combined Chat projection while remaining
separate editing targets.

The projection uses plain text and has its own **Copy effective** action. Native
Chat Copy still uses the original component data. Unknown or mixed layouts keep
the original visible and receive a labelled effective preview rather than an
unsafe replacement. Signed thinking and unsupported targets remain protected.

Pencils have visible Edit message, Edit answer or Edit thinking labels below
their own content. User editing joins the native timestamp/Copy action row when
that row is confirmed. Buttons stay visible without hovering. An unavailable
user target keeps an explanatory action instead of silently losing its button;
it never guesses a replacement message or issues a commit.
More than two targets use a compact message chooser instead of an overflowing row
of pencils.

## Inline Editing And Restore

The Chat pencil opens an editor at the selected bubble or text block, not a modal.
It offers **Save**, **Cancel** and **Restore original**. All three text kinds use
the native container when it is available. Editing never clicks harness disclosure
controls. A visible but collapsed Think gets a temporary plain-text surface below
its summary, without changing its expanded state. A hidden outer Thought group
uses the history panel instead of expanding automatically.
Answer is still the default for a message-level chooser.
Ctrl/Cmd+Enter saves; Escape cancels with confirmation for an unsaved draft.

Only one editor is active across Chat and the history panel. Switching targets
asks before discarding changes; session switches retain separate drafts. A draft
whose Chat node disappears is moved into the panel rather than lost. The named
modal remains available for old messages, draft recovery and unknown layouts.
Reload/closing the tab warns while unsaved work remains; drafts are not persisted
across a browser restart.

Restore requires confirmation and affects only the selected block. The server
resolves its original text from the untouched assistant event or verified durable
user ancestry, never from a client-supplied original. It checks the current text
and appends an ordinary replacement/edit, preserving siblings and the audit trail.
Signed Thinking remains protected. Unchanged, unavailable or empty originals do
not offer restoration. Restoring also returns the native Chat text renderer.

## UI/UX Follow-Up

- Inline save refusals and request failures retain the actual reason next to the
  draft, with error styling and an accessible description. Long diagnostics wrap
  inside the editor instead of overflowing it. Inline errors do not also create a
  floating notification over the composer.
- Saving changes the button to **Saving...**, marks the row busy and temporarily
  disables Cancel, target selection, Edit and Restore. Refusals preserve the draft
  and re-enable the controls for retry.
- Ctrl/Cmd+Enter works in both Chat and the panel. Composition keystrokes do not
  submit or cancel an inline draft. Clicking the active pencil focuses that draft
  without a discard prompt or another fetch.
- Coarse-pointer panel forms use 16px input text and at least 44px controls.
  Native Chat editors inherit their content font and also have 44px controls.
  Opening a panel editor scrolls its actions into view after the status text has
  settled. The redundant Edit button disappears while its editor is open.
- Effective-copy buttons match the editor controls and show **Copied** after the
  clipboard write completes. A clipboard refusal remains visible and can be
  retried; native Chat Copy behavior is unchanged.

Ten new browser scenarios reproduced the defects before their fixes. The mobile
checks also assert vertical visibility of the actions in a 320x640 viewport, not
just horizontal fit. This follow-up used isolated Chromium fixtures and inspected
screenshots, not live-session edits. Mobile OS keyboard behavior and Safari were
not tested.

## Native Thinking First Pass

The previous Thinking editor hid `lcKema_thinkBody` and inserted a styled card
with a bounded textarea, then called `scrollIntoView`. That changed the reading
position, height and typography. The installed upstream `ReasoningRow` renders
one plain string in this body, so this known shape became a temporary
`contenteditable="plaintext-only"` surface instead. At this stage Message and
Answer kept the card editor; the unified follow-up below replaces those too.

- The same body stayed visible with its native font, line height, padding and
  wrapping. Opening focuses it with `preventScroll`; no replacement card or
  nested text scroll box is inserted. Save, Cancel and Restore sit by the Think
  heading, outside text flow. Their position tracks size changes and does not
  cover the first text line, including coarse-pointer controls.
- A hidden textarea retains the draft independently of the renderer. Native
  input updates it; rich paste explicitly uses clipboard plain text and normalizes
  Windows line endings, retaining browser undo. Composition does not trigger
  submit/cancel. Save locks the native surface as well as the actions.
- A confirmed save refreshes effective data before releasing this surface.
  Expanded Thinking also displays effective text in the same native body after
  saving, with compact edited/copy controls, not a separate text projection.
  This is a reversible display change, not a session-log rewrite. Native Copy
  continues to use component data; Copy effective uses the effective target.
- Cleanup removes listeners, observers and temporary editing attributes. It
  restores owned text but never overwrites a renderer update. Removal, collapse,
  streaming or replacement moves the last typed draft into the history panel.
  Session switches retain drafts separately; expected-text and signed-block
  safeguards are unchanged.

Eight new browser cases cover native geometry at 1280px and touch 390px, multiline
save/reopen/restore, busy/refusal/composition/retry, replacement/rewrite/collapse
recovery, and rich paste with session switching. They reproduced the old card
behavior before implementation. Additional assertions caught toolbar overlap and
HTML-clipboard newline conversion before their fixes. One older asynchronous
fallback test now waits for the panel to become visible before asserting it.

All 47 browser scenarios, 62 GUI checks, 5 load-order checks and source encoding
passed after this change. Isolated screenshots include
`.suite-state/edit-panel-browser/thinking-in-place-1280.png` and
`thinking-in-place-390.png`. Mobile OS keyboard/zoom behavior and Safari remain
untested; the content font is deliberately inherited rather than forced to 16px.

That script was also injected only into the dedicated live test tab at
390px, without restarting DSH. Opening preserved the exact body node, focus,
position (top 426px), dimensions (260x68px), font and padding. A dirty Cancel
restored the prior effective text, removed editing attributes and issued zero
commit requests. Screenshot:
`<temporary-directory>/ctxkit-live-thinking-in-place-390.png`.
Save/Restore in this pass used isolated browser fixtures, not live-session writes.

## Unified Native Editing

This first unified pass made Message and Answer share the native plain-text
editor with Thinking. The bottom-actions follow-up below supersedes its original
placement and height policy. The
installed `UserStyleBubble`, `MarkdownText`, `ReasoningRow` and Markdown code-banner
markup were checked first. A confirmed single-target user bubble or mapped answer
container is editable directly; ambiguous multi-block bubbles and mixed media
still use the panel. Markdown is edited as source, not as a rich-text document.

- In this pass every native editor was limited to `min(420px, 45dvh)` with internal vertical
  scrolling. Width, font and padding stay native. Save/Cancel/Restore remain
  outside the scrolling body. A long existing block intentionally shrinks to the
  cap when editing; cancellation restores its original height and scroll position.
- User actions originally sat immediately below the bubble, Answer above its text, and
  Thinking in its own disclosure header. Labels supplement the pencil icon;
  Thinking has a dashed accent and Answer a different accent. A collapsed Thought
  group no longer leaves a stray Thinking button below the answer. During editing
  the label gives way to the toolbar in the same action location.
- Cancellation restores actual renderer nodes, not HTML clones, including code
  formatting and its original Copy control. Only the verified Markdown code-banner
  Copy button is treated as decoration; other embedded actions still block native
  editing. Host rewrites retain priority, with the last typed draft recovered in
  the panel. Effective projections use the same guarded native containers.
- Refresh after a successful durable save may legitimately change the user entry
  id/seq. It no longer misclassifies that transition as removal of the edited row.

Six added browser scenarios failed against the old editor before implementation.
They cover user/answer identity, bounded height, exact cancellation and labeled
action placement at 1280px and touch 390px. The answer cases were extended with
upstream-shaped code banners after the live check exposed their old fallback;
both failed before the decoration-aware fix. That full suite passed 53 cases,
alongside 62 GUI and 5 load-order checks. Fixtures also verify unchanged tools,
attachments, audit views, native Copy data and stale-save safeguards.

Live checks used only the dedicated conversation, with commit requests blocked.
At 390x844 both user and code-containing answer edited the same focused node and
capped 60-line drafts at 379.8px with internal scrolling. Answer cancellation
restored the exact renderer nodes and Copy button, with zero commits. Desktop
1280x900 inspection confirmed the three labels beside their respective blocks.
Screenshots in the approved temporary directory: `ctxkit-live-user-native-390.png`,
`ctxkit-live-answer-native-390.png`, `ctxkit-live-native-actions-1280.png`.
Isolated label screenshots: `.suite-state/edit-panel-browser/native-actions-1280.png`
and `native-actions-390.png`. Live Save/Restore, Safari and actual mobile keyboards
were not exercised in this pass. The running DSH host was not restarted.

## Bottom Actions And Adaptive Height

The installed native user action row and collapsed Thinking CSS were checked
before this follow-up. Earlier controls sat above answers or inside disclosure
headers, while editing inherited the old block's minimum height. This caused
short drafts to retain a large empty editor and sent actions away from the text.

- Edit actions and the active Cancel/Restore/Save bar now sit below their block.
  User editing shares the native action row; other verified blocks have their own
  bottom action. A guarded scroll adjustment keeps the action
  near its previous viewport position when opening or cancelling a long block.
  This deliberately preserves the bottom action, not the old top of a long body.
- Native typography and width are retained. Height fits the current text, grows
  and shrinks automatically, with a 32px minimum and `min(420px, 45vh)` automatic
  cap. Overflow scrolls inside the body. The native bottom-right resize handle
  allows vertical mouse resizing up to `min(720px, 75dvh)`; subsequent typing
  respects the manually chosen height.
- Thinking is not automatically expanded on opening, saving or cancelling.
  A temporary surface for a collapsed Think is removed on exit, restoring its
  layout. An already expanded body retains its original nodes. A user disclosure
  change while editing recovers the draft in the panel rather than losing it.
- Ghost edit actions use the host theme, with a clear primary Save action. Restore
  is hidden when it cannot apply. Error details stay with the draft rather than
  floating over it. Compact dismissible notifications use host theme variables.
- Discard and Restore use an accessible, themed modal instead of `window.confirm`.
  Keep editing receives initial focus; Escape keeps the draft. Confirmation is
  guarded by the session, epoch, draft identity and busy state, and is dismissed
  on session changes. The native unload warning still protects browser navigation.
- Missing or refused user targets receive an explanatory Edit message action only
  after a successful list response. It is removed when mapping becomes available,
  during streaming or on session change. The exact missing-button screenshot was
  not reproduced in its original conversation; no unsafe ancestry or block mapping
  was added to make an unavailable target appear editable.

Five new scenarios failed before the implementation and now pass. They cover
collapsed Thinking open/cancel/save, adaptive sizing at 1280px and touch 390px,
session-scoped custom confirmation, and native user actions with an unavailable
target. The desktop sizing case also physically drags the resize handle with
Playwright's mouse; the mobile case checks preservation of a manually set height,
not an OS touch-resize gesture. Existing confirmation, placement, durable-save
and viewport guards were migrated to the new behavior. All 58 Chromium scenarios,
62 GUI checks and 5 load-order checks pass. Backend code was unchanged.

Live checks injected only the current client script into the dedicated test tab;
DSH was not restarted and commits were blocked. A collapsed Think stayed collapsed
while its local draft changed from `123` (32px) to 100 lines (405px, 2008px internal
scroll height) and back to `123` (32px) at 1280x900. At 390x844 the short body was
260x32px, with a 52px toolbar below it. Keep editing retained the draft, Discard
removed the temporary surface, and the expanded state remained unchanged. Zero
commit requests occurred; live text was not saved or restored. The original outer
disclosure state and the temporary fetch override were restored after inspection.

Screenshots in the approved temporary directory: `ctxkit-comfort-actions-1280.png`,
`ctxkit-comfort-short-1280.png`, `ctxkit-comfort-short-390.png`, and
`ctxkit-comfort-confirm-390.png`. Isolated resize screenshots are
`.suite-state/edit-panel-browser/comfort-editor-1280.png` and
`comfort-editor-390.png`. Safari, mobile OS keyboards and touch resizing remain
untested.

## Strict Bottom Placement

The follow-up removed sticky positioning from the active toolbar. Edit,
Cancel/Restore/Save and effective Copy belong below their own text block in normal
flow, not above it, beside it or floating over it during scrolling. Controls may
scroll out of view with their block; they do not pin themselves over the text.

Two additional Chromium cases exercise user, answer and expanded Thinking at
1280px and touch 390px in a short scrolling viewport. They verify every action's
actual position before editing, while scrolling the editor, and after Cancel.
Both failed against the sticky toolbar and pass with normal-flow placement.

An authenticated read at this stage confirmed the running server still served
the older `thinkingTools` header anchor and bare Answer/Thinking labels matching
the reported HTML, not the updated client on disk. Reload alone cannot replace
the host's import-time `PANEL_SCRIPT`; the user must restart DSH and then reload.
This follow-up did not restart DSH or modify any live conversation.

## Verification

- Before the inline extension, all 24 `scripts/test-*.mjs` programs passed in isolated homes and
  separate processes. This excludes the unsafe live-home verify/probe runner.
- The editor checks were rerun: 123 core, 126 durable, 61 wire, 62 GUI and 5 load-order
  checks. Real Session, registered GUI routes and the provider adapter verify
  sequential edits, sibling-block preservation, replay and unchanged audit data.
- `scripts/check-edit-panel-browser.mjs` passed 64 isolated Chromium scenarios:
  effective reopening, default targets, drafts, real-shaped Chat containers,
  disclosure, reload, two tabs, session/provider races, keyboard interaction and
  16 targets at mobile width, inline edit/restore, node removal and session draft
  recovery, save errors/busy states, composition shortcuts, touch forms and
  clipboard feedback, adaptive native editing, strict bottom actions during scrolling
  custom confirmations, legacy control placement, client-refresh draft recovery,
  icon-only Copy controls and native code-copy node preservation.
  The browser RPC is a fixture,
  not the live model API.
- The UI/UX follow-up reran all 39 browser scenarios, the 62 GUI and 5 load-order
  checks, and source-encoding verification. Core, durable and wire implementation
  did not change in this follow-up; their counts above are from the preceding run.
- New bug guards were run red before their corresponding fixes. Independent
  review findings were addressed and rechecked.

The optional browser check accepts `EDITOR_PLAYWRIGHT_MODULE` and
`EDITOR_BROWSER_PATH`; it is not a new mandatory package dependency.
`EDITOR_CASE` optionally filters scenario names by a regular expression.

Authenticated DevTools checks used only the newly created **DSH editor live
isolated test** conversation. User and assistant V1 -> V2 -> V3 edits reached the
next real model request. Thinking edits preserved Answer and displayed literal
HTML-like text. The earlier card UI was then checked against live Chat at 390px
for Message, Answer, nested Thinking, visibility, sizing and Cancel. Its source
was loaded only into the isolated test tab; the running host was not replaced.
Restore itself is covered by real-Session registered-route tests and browser
fixtures, not a live commit against the still-running older host module.

## Served Browser Recheck

After the user disputed the bottom-placement claim, a fresh browser tab was
opened against the actual running server without injecting the edited script.
Only the dedicated live test conversation was used. This check FAILED the
requested placement; the 60 fixture passes describe the source on disk, not the
UI served to the user at that stage.

- Answer's Edit button was at y=512.59..540.59, above its native text container
  at y=544.59..707.59. Save, Cancel and Restore occupied that same upper row.
- Thinking's Edit button overlapped its heading. Editing expanded the disclosure;
  Save, Cancel and Restore were at y=27.59..55.59, above the editable body at
  y=55.59..460.59. Cancel left the disclosure expanded.
- Both normal and `cache: 'no-store'` authenticated index requests returned the
  same older 94,142-character script containing `thinkingTools` and bare labels.
  This is not merely a stale browser response. The host remains unchanged.

Screenshot of the unmodified served page:
`<temporary-directory>/ctxkit-bottom-server-before.png`.
Editors were opened and cancelled without changing or saving text. No live
Save/Restore was performed. The earlier statement that all actions were already
below their blocks was not true of the running UI. The following delivery fix
addresses that failure without replacing the cached panel.

## Live Bottom-Action Delivery

The installed client-module registry already watches `lib/edit-client.js` and
publishes revisioned bundle updates. Its existing session bridge now also repairs
the older panel's placement. This uses normal client loading, not a DevTools
injection, a second panel, a service worker or a host restart.

Only legacy bare Message/Answer/Thinking controls are handled. Each must have a
connected, panel-verified anchor in its own Chat row. The old heading observer is
released, the same control is moved after its anchor, and relative positioning
overrides the old heading offsets. Event handlers, source nodes and drafts are not
replaced. The current panel's `Edit ...` controls are left alone. The observer is
idempotent and is disconnected when the client module is disposed.

Two new desktop/mobile guards failed before this change. They cover legacy
placement, editing, and recovery of an unsaved draft in the history panel after a
client bridge refresh. The complete browser suite now passes 62 scenarios; 62 GUI
and 5 load-order checks, source encoding and syntax checks also pass. Backend
implementation and configuration were not changed.

A fresh ordinary browser tab loaded the update from the running server, with no
init script or panel injection. In the dedicated live test conversation:

- At 1280px, Answer's body ended at y=657.59 and Edit/Save/Cancel/Restore began at
  y=679.59. Thinking's editable body ended at y=872.59 and its actions began at
  y=878.59, below the text rather than over its heading.
- At touch 390x844, after scrolling the editable source to the top, user text
  ended at y=455.80 and actions began at y=469.80; Answer ended at y=586 with
  actions at y=608; Thinking ended at y=455.80 with actions at y=461.80.
  All visible editing buttons were 44px high.
- Clean Cancel preserved the exact original user/Answer HTML and child-node
  identities. No live Save/Restore was invoked. Test disclosure changes were
  restored and no draft remained.

Actual served-page screenshots, not fixture or injected-script screenshots:
`<temporary-directory>/ctxkit-bottom-served-fixed-1280.png`
and `ctxkit-bottom-served-fixed-390.png`.

This hot update fixes control placement only. It does not replace the older
panel's sizing, confirmation or automatic Thinking expansion behavior. Those
separate changes remain in the newer host-cached panel source.

## Icon-Only Copy

`lib/edit-client.js` now presents effective-copy actions with the existing native
Chat Copy SVG, a compact transparent hit area and a browser hover tooltip. Their
accessible names still distinguish message, answer and thinking. Success uses a
check icon; failure uses an error icon and an explanatory tooltip. The original
copy handler, plain-text payload, disabled state and live feedback remain intact.
The ready/success/error labels remain available to assistive technology without
being visibly printed beside the icons.

Native Markdown code-banner Copy buttons use the same artwork through a CSS mask.
Their React-owned text nodes and event handlers are not replaced: CSS hides the
visible word while its original accessible name and copy-state updates remain.
The tooltip follows Copy/Copied. Existing icon-only Chat actions are untouched.
Controls are 28px on desktop and 44px for coarse pointers. Observers and native
button attributes are cleaned up when the client module is disposed.

Two desktop/mobile cases failed before the icon conversion, and were extended
with failing guards for native code-banner Copy. All 64 browser scenarios now
pass, including actual fixture clipboard writes, clipboard refusal/retry,
native artwork reuse, keyboard focus, sizes, tooltips and preservation of the
native text-node identity through Copy/Copied/Copy. The 62 GUI and 5 load-order
checks and source-encoding checks also pass. Backend behavior was not changed.

The ordinary served page was checked in the dedicated live test conversation at
1280x900 and touch 390x844, without panel injection. All three effective-copy
actions used the exact native artwork and had no direct visible text. Native
code Copy displayed an icon, retained its original accessible label, and had a Copy tooltip.
Desktop controls measured 28x28; touch controls measured 44x44. This pass made no
live clipboard writes or Save/Restore requests. Screenshots:
`<temporary-directory>/ctxkit-copy-icons-1280.png`
and `ctxkit-copy-icons-390.png`.

## Activation And Limits

Bottom-action placement and Copy icons load through the normal revisioned client bundle;
an ordinary page reload is sufficient. Loading the other host-cached panel changes
still requires the user to restart DSH and reload. This work did not restart DSH,
change presets or create a commit.
Only the dedicated live test conversation was edited in earlier passes; existing
conversations were left untouched. The native editing passes made no live commits.
The inline, restore and unified native editing host changes require
restart/reload.

Existing edits are not automatically retargeted: a historical edit accidentally
saved into Thinking stays there until explicitly corrected. Persisted `before`
values are not rewritten to disguise what an older editor actually saved.
Large-history projection latency and future harness DOM variants are not claimed
as verified; ambiguous layouts deliberately fall back without hiding originals.

## Quiet Startup Selection

The native session controller starts with no current selection and can temporarily
clear it during reconnects. The panel incorrectly treated that normal state as an
error, briefly showing "The session controller bridge has no current selection.
Editing is unavailable." before the conversation loaded.

Both initial loading and selection transitions now use a neutral waiting message
inside the panel, without an error toast. Missing selection still blocks requests
and clears unsafe edit controls; no session ID is guessed. The existing bridge
notification resumes loading automatically. Session-local draft retention and real
list, save and restore errors are unchanged.

Two new browser guards failed on the old startup toast, then passed at 1280px and
390px. They cover late bridge mounting, empty selection, explicit panel opening,
automatic recovery, temporary selection gaps and visible real list failures.
All 13 selected startup, session-isolation and refusal browser cases passed, along
with 62 GUI and five load-order checks. This was not a full browser-suite rerun.

A read-only authenticated fetch from the live browser confirmed that the running
host still serves the old panel script. This host-cached fix requires the user's
next DSH restart followed by a page reload; a page reload alone is insufficient.
No user server was restarted and no live settings, messages or clipboard contents
were changed.
