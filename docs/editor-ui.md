# Chat-history editor: interface contract

## Current behavior

- Eligible transcript rows expose compact icon-only destructive actions on row hover or keyboard
  focus. Rows absent from the editor index expose no unusable destructive controls.
- Eligible user, assistant, tool-call, tool-result, and reasoning text blocks can be edited or
  deleted without implicitly removing the following history. Assistant tool blocks use the wire
  overlay; host `tool/result` events use a durable content-only replacement that preserves the
  envelope, message metadata, and call pairing. Editing signed visible reasoning converts it to
  ordinary provider-neutral text and removes stale signatures, without adding a status label to
  the transcript. Opaque or redacted reasoning remains unavailable and cannot be selected.
- Every direct human message has an icon action that hides all later history. Its confirmation
  states that the selected user message is retained and only later history is hidden.
- Mutations are disabled while generation is active and are also rejected by the server if a
  stale or modified client submits one. `editor.requireIdle: false` is accepted only as legacy
  configuration; it never disables this guard.
- Refreshes share one list request per generation. A newer refresh invalidates the previous
  generation, and stale responses cannot replace the current panel state. The server builds one
  raw editable index and reuses it for the effective projection.
- Destructive success moves focus to a stable control before reloading the transcript. This
  avoids leaving keyboard focus inside a row that has just been removed.

Historical implementation notes follow. The effective-text projection, B1-B6 fixes,
tab-local client bridge, and verification scope are also documented in
[Effective Editor View](editor-effective-view.md). Earlier route and client-loader claims below
describe the investigation at the time, not the current contract.

Written 2026-09-13, at the point where the durable editor works but the user still has to
type a command. **The user's actual requirement, in their words:**

> «речь шла не про командную тему, а про интерфейсную кнопочку типа нажал и редачишь как
> белый человек»

So: a button (or inline affordance) on a message in the GUI — press it, edit the text in
place, and the edit reaches the provider **without deleting what follows**. No slash command
in the normal flow.

## The button exists, and the reason it was invisible (2026-09-13, commit `5a927ae` + the fix after it)

`lib/edit-gui.js` is the interface half: `webServer.tapIndex` puts a host element and an inline
module script into the boot page (a launcher button bottom-right, then a modal list of the
session's user messages with an inline editor), and `connection.rpc.handle('/ctxkit/edit')` is
the authenticated channel it writes through. The panel never invents an edit the durable
branch would refuse; it reports the refusal as text.

**The first release registered nothing at all, and said nothing about it.** Both halves were
mounted from one guard that read its two host services ONCE, at mount time:

```js
const connection = ctx.get('connection');
const webServer = ctx.get('webServer');
if (connection?.rpc?.handle === undefined || webServer?.tapIndex === undefined) return undefined;
```

`ctx.get(name)` (`cordis/lib/index.js:762` → `_getImpl` at `:765`) returns `undefined` — no
throw, no retry — for a service that is not yet PROVIDED. A preset ROW is mounted while the
deployment is still coming up, so on a real Web server that branch was taken, the module
reported "no Web surface here", and the button did not exist. Symptoms, measured in the live
GUI: `document.getElementById('dsh-context-kit-editor')` was `null`, the served index never
contained the host element, and `POST /ctxkit/edit` answered **405** (the static fallback)
while `GET` answered 404. No log line anywhere pointed at the module.

The mount is now deferred through `ctx.inject(['connection', 'webServer'], cb)`
(`cordis/lib/index.js:1599`): a child fiber whose declared services must all be present, so
the callback runs the moment they arrive and the plugin itself never waits. Both services stay
optional, so a headless or ACP composition simply has no button.

Guarded by `scripts/test-edit-gui-load-order.mjs`, which drives the REAL cordis (resolved from
the installed harness, the same instance the live server uses) with WebServer-shaped and
Connection-shaped `Service` subclasses, in all three orders — services already present,
services arriving later, services never arriving — and keeps the SHIPPED-BUGGY guard as an
executable falsification: the old row must register nothing in the "arriving later" order,
otherwise the test has stopped exercising the race it claims to.

Still open: the live confirmation in the browser (list → edit → save, and the edited text
reaching the provider with the tail untouched).

- **`/edit` works in the GUI when selected from the command palette**, not when typed. A live
  run listed the session's user messages correctly:
  `edit 4 user message(s): [0] seq 8 id 455e0c26 — Remember this marker: AAA …`, with the
  runtime-context notice and the `<dcp-system-reminder>` message also visible as user messages.
- Typing `/edit -1` as free text **sent it to the model** as an ordinary message — 13 tool
  steps, 522K tokens, all wasted. So there is no client-routing mystery to chase; the earlier
  "typed vs palette gives different results" hypothesis is answered: the command only runs when
  it is actually dispatched as a command.
- **The user corrected the syntax: `-1` is not read. `/edit 1 привет` is the working form.**
  `resolveTarget(session, '-1')` is supposed to accept a negative offset from the end
  (`lib/edit-durable.js`), so either the client strips the leading `-`, or the argument
  reaching `runEditCommand` is not what was typed. **This is an open defect to find**, and it is
  exactly the shape documented in `docs/dcp-port.md` §6: a mechanism that assumes another one's
  state (here: that the raw argument survives the command pipeline unchanged).
- The editor is ON for new sessions: `~/.dsh/dcp.jsonc` sets
  `{ "editor": { "enabled": true, "requireIdle": true } }`, read by `readConfigFiles` →
  `resolveConfiguration` when `ctx.get('dshHome')` is provided — verified end to end by
  `scripts/check-editor-config.mjs` (mounts the real plugin and prints the resolved row).

## What already exists and works

- `lib/edit.js` — shared half: `validateEdit`, `applyEditToMessage`, `messageAnchor`,
  `findAnchoredIndex`, `planWireRewrite`, `installWireOverlay`, edit store with JSON
  persistence under `$DSH_HOME/context-kit/edits/<sessionId>.json`. An edit may only rewrite
  the text of a `text`/`tool-call`/`tool-result`/`reasoning` block and may never change the
  block count or a `toolCallId`, so tool pairing cannot break by construction. Editing signed,
  visible `reasoning` cannot preserve the provider proof: the replacement is therefore emitted
  as ordinary `text` in visible and replay content, with block signatures and stale
  `source.replayState` signature fields removed. Redacted or otherwise opaque reasoning is
  refused because its original text is unavailable, but it remains listed with that reason.
- `lib/edit-durable.js` — durable branch: `editableIndex` (derives the request index from the
  surface; `index` = position in the request, `userIndex` = position among user messages),
  `userMessages`, `resolveTarget`, `commitUserEdit` (dry run first, then a real
  `{surfaceOp:{op:'replace',startSeq,endSeq:startSeq}, sourceEventSeqs:[seq]}` append),
  `renderEditableList`, `runEditCommand({session, agent, config, rawInput})`.
- `/edit` is registered **unconditionally** in `lib/dcp.js` (commit `d2f86e0`) so enabling the
  feature never needs a restart; the handler refuses with an explanation while the flag is off.
- Tests: `scripts/test-edit.mjs` (195 marked checks, mostly refusals),
  `scripts/test-edit-durable.mjs` (173 marked checks against a real `SessionStore`, own wiped
  `DSH_HOME`).
- Assistant messages are **refused** by the durable path and handled by the wire overlay
  instead. The overlay is mounted by `apply` in `lib/dcp.js` and observed end to end:
  `scripts/test-edit-wire.mjs` mounts that `apply`, asserts the listener is in the root's
  registry, that the adapter receives the edited text while the log stays byte-identical, and
  that disposing the plugin takes the rewrite away with it. On a live server the model's next
  answer quoted the text its own earlier reply had been rewritten to, while the reply's event
  in the session log still held the original words.

## The browser driver (enabled this session)

The official MCP bridge `@deepseek-ai/dsh-mcp-client` was already installed in the
historical browser test environment. The following row records that environment only; it
is unrelated to Context Kit installation and is not generated by repository scripts:

```yaml
- id: mcp-chrome-devtools
  name: '@deepseek-ai/dsh-mcp-client'
  config: { serverName: chrome, transport: stdio, command: npx,
            args: ['-y','chrome-devtools-mcp@latest','--no-usage-statistics','--no-performance-crux'],
            env: { CHROME_USER_DATA_DIR: '<dedicated-browser-profile>' } }
```

Both telemetry flags are verified against the server's own `--help` and must not be removed
without asking. Tools appear as `mcp__chrome__*` and work: `list_pages`, `navigate_page`,
`take_snapshot`, `click`, `fill`, `press_key`, `wait_for`, `evaluate_script`,
`list_network_requests`. To authenticate the browser, open `http://127.0.0.1:3080/?token=<token>`
in the MCP browser FIRST — the token is single-use, so spending it in a script
(`scripts/live-api.mjs login`) leaves the browser unauthenticated.

## The client plugin: what is known and what to find out

`@deepseek-ai/dsh-client-ui-conversation` README states the model: targets
declaration-merge their snapshot and Location data maps, then register with
`ctx.uiConversation.events.register(...)` and `ctx.uiConversation.*`; the package owns the
root-scoped `main` key `conversation`; **view selection is deterministic** (a registered
persisted selection wins, otherwise the registered `chat` view wins).

Known extension points from the earlier audit (recorded in `docs/edit-feature.md` §4.6):
`ctx.uiConversation.events.register`, the keyed slot `conversation.chat.node` (keys include
`user`, `assistant-step`), `conversation.chat.turnTail`, `conversation.chat.assistant-actions`.
The core transcript row definitions live in
`F\dsh-client-ui-chat\lib\client.js:5934, 6051, 6490` and match `isAppendSurfaceEvent`, so a
replacement event does **not** suppress the original row — an edit is shown *in addition*.

**Open questions to answer by reading the installed packages:**
1. The exact registration call for a per-message action (slot name, key, the props a node
   receives, and how to reach the message id / seq from them).
2. How a client plugin reaches the server to perform the write. `SessionStore` has no edit
   operation and `/api/*` is 404 (the GUI's own channel is a websocket, not REST). The
   candidate routes are (a) a server-side route if the plugin API exposes one, (b) a
   `dsh-commands` command invoked programmatically from the client, or (c) a new event the
   server plugin handles. **Do not invent a path — find the one the harness already uses for
   its own client→server commands** (the UI has buttons that mutate sessions, e.g. branch and
   delete, so a channel exists).
3. Where the client plugin must live to be loaded: the kit is a plain directory, not an npm
   package, so a client entry needs the client-plugin loading path the harness uses for
   `@deepseek-ai/dsh-client-ui-*` packages.

## Order of work that makes sense

1. **Build the client plugin skeleton** and get one visible affordance into the transcript
   (a button on a user message). Verify it renders with the MCP browser — this is now cheap.
2. **Wire the button to a real write** using whatever server channel step 2 above finds.
   Prefer the durable path for the user's own messages; the wire overlay for assistant replies.
3. **Find and fix the `-1` argument defect** in the command form, so both entry points work.
4. **Run the live proof in the GUI**: send `Remember this marker: AAA`, edit it to `BBB`,
   send `What marker did I ask you to remember?` and require the answer `BBB`. Also verify the
   tail after the edit is untouched and that `/edit` refuses a message carrying tool calls.
5. Only then consider a separate core patch to make assistant edits durable instead of
   wire-level. Keep that patch outside this portable plugin package.

## Standing constraints

Replies in Russian; code, commits and English docs in English. One git commit per logical
step, authored `-c user.name=dcp -c user.email=dcp@local`. Keep deterministic publication
checks green and classify environment-sensitive diagnostics explicitly. **The user restarts
the server; never restart or kill a process.** Consult the separate upstream checkout before
design decisions.
