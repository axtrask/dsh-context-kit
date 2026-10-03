# Editing chat history in DSH — design and evidence

The editor's release contract is guarded by `npm run test:edit-history`, which covers
core behavior, durable state, wire behavior, GUI behavior, and GUI load order.

The requirement, in the user's words: edit the chat history **both ways** — the
assistant's replies and the user's own messages — so that the edited text is what
goes to the provider, **without deleting what follows**. In opencode, editing a
message cuts the whole tail; the user calls that unacceptable.

That last point is the one that turns out to be free in DSH: the surface fold is
positional (`F\dsh-session\lib\types\surface.js:370-377`), it replaces one slot in an
ordered list, and nothing after the edit is cut. Only a deliberately wide `endSeq`
cuts a tail.

## 1. Evidence base

Probes in this repository, runnable with `node`:

- `scripts/probe-edit-feasibility.mjs` — what the session API permits today, and it now owns its
  exit code: every expectation is settled into a failure list, so a flipped expectation exits 1.
  Cases 1 / 1b / 1c / 5 / 6 pass; **2 and 3 are declared refusals** (an `assistant/message` carrier)
  and are asserted as such. Case 4 is **accepted** — its carrier is a user message. The earlier claim
  here that "2 / 3 / 4 / 5 are refusals or collapses" was wrong and went unnoticed for exactly one
  reason: the probe could not fail when it was written, and four auditors proved that independently.
- `scripts/probe-wire-and-copytail.mjs` — the two bypasses, 16 checks, all green. It scans the whole
  serialized request of **every** adapter call for the original text, and a second check proves that
  scan is not vacuous.
- `scripts/probe-seam.mjs` — **not evidence.** It prints three cordis observations with no assertion
  and no exit code; `run-suite.mjs` labels it `[PRINTS ONLY: CANNOT FAIL]` and names it in the
  summary. It is kept as a printed record of how the `llm/stream` seam was first measured. See
  `docs/dsh-core.md` §4b for the waterfall trap this whole class of file can hide.

Five historical audits ran against the installed Harness with full context. Their
portable conclusions and maintained regression probes are recorded below:

| Auditor | Result |
|---|---|
| **a1** | `assistant/message` as a replacement carrier is a **logical dead end** — proven across 38 spellings, including raw `log.push`, seeds and `foldSurface`. Tool calls are **not** the obstacle. Found the live-array hole in `SurfaceManager.nodes` |
| **a2** | A plugin **cannot** register a new surface-eligible event type (private runtime set, closed `switch`). Found the wire-rewrite bypass: re-enter `LlmRuntime.stream()` from an `llm/stream` listener |
| **a3** | Found the copy-tail recipe (invisible `system/message` + re-emitted tail); confirmed it survives reload, keeps roles and tool pairing |
| **a4** | User-message edits work today; assistant-message edits do not. **Falsified** our "replacements never reach the client" claim. Mapped the client extension points and the fork contract |
| **a5** | **Patched the core (two guard sites) and got assistant editing with the tail kept.** Found the public source repository, and corrected the persistence picture (no integrity protection; live writers append rather than revert) |

## 2. The three mechanisms

### M1 — replace the user's own message in place (works today, no patch)

Keeps the tail, keeps roles, durable in the log because the replacement is an ordinary
event that flows to disk unchanged. This alone satisfies most of the request.

**Built and tested** (`lib/edit-durable.js`, 74 checks in `scripts/test-edit-durable.mjs`
against a real `SessionStore`; `/edit` sits behind `editor.enabled`, default **off**).

Three facts that took real experiments to settle, all of which the implementation depends on:

- **The request index must be DERIVED from the surface, never counted from events.**
  `deriveEventMessage` (`dsh-session/lib/index.js:209-219`) returns null for an empty
  `assistant`/`system` payload, so an empty assistant node — exactly what a compress leaves
  behind — takes a surface slot and produces no message. `editableIndex()` folds the surface
  and counts only what survives, which is why it reports `index` (position in the request)
  and `userIndex` (position among user messages) as separate numbers: `/edit 1` means the
  second user message, an anchor means position in the request, and confusing the two edits
  the wrong turn.
- **The replacement lands in the slot the original occupied.** Measured on a real session:
  surface `[1,2,3,4]` → `[5,2,3,4]`, request shape unchanged, tool pairing intact — including
  with a tool-call/result pair in the middle of the conversation.
- **The original stays in the log.** The log only grows (`8 -> 9` events in the fixture) and
  the pre-edit text is still readable below the replacement, which is what makes recovery
  possible at all.

The command has three forms, because the first two are how a person finds out what the third
will touch: `/edit` lists the user messages, `/edit -1` previews one, `/edit -1 new text`
commits. A running agent blocks a write unless `editor.requireIdle: false`, and the command
runs a `dryRun` before the real append so its reply cannot describe a change that did not happen.

Running the tests against a real session caught four fixture bugs of mine in one sitting —
worth remembering before trusting a green suite: an assertion that assumed the edited message
stayed at position 1 (it moves into the slot the original held), a message count that ignored
the dropped empty payload, a string assertion against a message object, and a
PowerShell-written file that mojibake'd two em-dashes — the last caught by
`test-source-encoding.mjs`, which exists for exactly that.

### M2 — rewrite on the wire (works today, no patch)

An `llm/stream` listener rebuilds the request and re-enters `this.stream(...)`. Handles
**both** roles, including the assistant's, because it never touches a node carrier.
Cost: invisible to the log, to the token meter, to invariants and to any other consumer.
An edit applied this way lives only in plugin state, so it must be persisted by the
plugin or it disappears on restart — exactly the model upstream DCP uses.

Implementation sketch and the verified output are in `docs/dsh-core.md` §3.2, including the two
claims four auditors narrowed: "the provider receives the edited text" is proven at the
**adapter boundary** (whole serialized requests, every call) and **not** over a network payload,
and "the log is untouched" is in-memory serialized equality, not on-disk bytes. The plugin side of
this branch is `lib/edit.js` (`planWireRewrite` + `installWireOverlay`), tested by
`scripts/test-edit.mjs` — but **no probe yet drives the production overlay inside a live agent
loop**, which is why `editor.enabled` defaults to false.

Still unproven, and worth saying rather than implying otherwise:

- that a wire-level edit disappears on a plugin reload: nobody restarted a server to watch it;
- that the copy-tail recipe's duplicate UI rows look the way §3.3 describes: no transcript was
  ever rendered in a browser;
- that `/dcp decompress` behaves through the *registered* command handler in the automated
  suite. One auditor did drive the real handler (`/dcp decompress 1` → "4 message(s) are back in
  the request"), but `test-dcp-materialization.mjs` calls `restoreBlockMessages` directly and
  `verify-status.mjs` passes an empty `rawInput` for every command, so it can only reach the usage
  branch. The wiring is one line (`lib/dcp.js:2905`): read, not exercised, by the suite.

### M3 — durable rewrite inside the log (works today, no patch)

Re-emit the tail as fresh appends, then collapse the whole original range into an
invisible `system/message` with empty content. Survives restart, fork and export, all
readers agree by construction. Cost: log growth of `1 + tail length` per edit, changed
downstream ids, and **duplicate rows in the browser transcript** (the UI matches
append-origin events). Sketch in `docs/dsh-core.md` §3.3.

## 2b. The hybrid, stated precisely

"Hybrid" is not a fourth mechanism. It is **one editor with a two-branch commit step**:
try the durable path, fall back to the wire path. The UI, the storage, the validation and
the diff are shared; only the last call differs.

```js
// lib/edit.js — the only place the two worlds meet
function commitEdit(session, target, newText, { durableAssistantEditing }) {
  if (target.role === 'user') return commitDurableInPlace(session, target, newText); // M1
  if (durableAssistantEditing) return commitDurableInPlace(session, target, newText);
  return commitWireOverlay(session.id, target, newText);                             // M2
}
```

`durableAssistantEditing` comes from a capability check. Options, in order of preference:

1. **A smoke session** created at plugin init through the injected `sessions` service
   (`host.create()`), appended to, then abandoned. Costs one tiny session directory and
   touches nobody's history. This is the route to prefer — but it still needs a service that
   may not be injected in every profile, so "cannot probe" must mean "no".
2. **Derived from the harness version plus a marker file** written by
   `patch-dsh-session.mjs --apply`. Cheap, and wrong the moment an upgrade lands in a new npx
   directory without the patch — the exact failure the probe exists to prevent.
3. **Try-and-fall-back**: attempt the durable replacement on the real session; if the core
   throws, catch it and use the wire. No probe and no config, self-correcting — but it must
   first be proven that a refused append leaves no half-written event behind.

What is **not** acceptable is a boolean in `resolveConfiguration`: it would drift silently,
and silent drift is a defect shape this project has already paid for three times
(`docs/dcp-port.md` §6).

Two ways to make the first branch answer `true`:

- **Historical in-place patch** of an installed bundle. This was fast but was silently
  reverted by reinstalling DSH and is not part of the published package.
- **Rebuild from the matching public DSH source** with the required session-core change.
  This is the maintainable upstream route; Context Kit itself never edits the installed
  Harness files or the active profile.

Both branches are proven runnable today (`scripts/probe-edit-feasibility.mjs`,
`scripts/probe-wire-and-copytail.mjs`), so the hybrid is a wiring job, not a research job.

### Comparison, with the numbers that matter

| criterion | M1 in place | M2 wire | M3 copy-tail | patched core |
|---|---|---|---|---|
| works with the shipped core | yes | yes | yes | **no** (needs the patch) |
| roles it can edit | user only | **both** | both | both |
| survives restart | yes | **no** (plugin state) | yes | yes |
| original text recoverable | yes (below the replacement) | **yes** (log untouched) | yes (in the collapsed range) | yes |
| log growth per edit | +1 event | **0** | `1 + tail` events | +1 event |
| other consumers agree (meter, fork, export) | yes | **no** | yes | yes |
| UI consequence | none | none | duplicate rows | none |
| core files modified | 0 | 0 | 0 | 4 |

## 3. The decision the user has to make

The user wants the edit to be part of the session ("правка станет частью истории"),
which M2 alone does not give and M1 gives only for their own messages. Two honest ways:

- **Core patch** (`audit-work/a5/patch-dsh-session.mjs`)
  Two guard sites, four including the browser bundles. After patching, an assistant
  replacement is a legal event: durable, inherited by forks, visible to every consumer.
  Price: it modifies an installed package inside an npx cache directory, so a harness
  upgrade silently reverts it — re-run `--check`, which fails loudly when the anchor
  moves. A supported alternative is rebuilding `dsh-session` from the public source
  (`deepseek-ai/deepseek-harness`, tag `dsh-v0.1.5-rc.2`) and overriding the row through
  the profile patch layer (see `docs/environment.md`).
- **Plugin-only** (M1 + M2)
  Nothing outside the plugin is touched. Edits live in plugin state; the log keeps the
  original. Same architecture as upstream DCP, and the log stays the record of what
  actually happened.

**Agreed plan (user's words: "доделаем dcp, затем начнём редактировалку делать думаю в
гибриде"):** build the editor as a **hybrid** — one code path that detects whether the
core ban is lifted. Patched core → write a real replacement event (durable). Unpatched
core → fall back to the wire rewrite. Same UI, same storage; only the commit step differs.

## 4. Implementation requirements (hard-won)

1. **Never strip tool calls.** An assistant reply carrying `tool-call` blocks must keep
   them, otherwise the paired `tool/result` is orphaned and
   `F\dsh-compaction\lib\types\tool-pairing.js` throws
   `tool/result at surface seq N has no matching tool-call (corrupt surface)`.
   The editor must refuse such an edit, not attempt it.
2. **Write `content` and `stream` coherently** on the durable path. The cross-check
   (`assertCurrentAssistantStreams`) only runs during migration, so a stale `stream`
   loads silently and any view rendered from the stream shows the pre-edit text.
3. **Invalidate the projection cache** (`$DSH_HOME/storages/session_projcache/...`).
   Rows are keyed by seq watermark with no content digest and hold literal text, so a
   same-length edit can leave a stale session title.
4. **Gate edits on an idle agent.** `dsh-agent-loop\invariant.js:26-27` re-derives and
   compares the request; an edit landing between build and dispatch is a desync. That
   invariant is not mounted in the live web profile today, so do not rely on it — gate
   the UI instead.
5. **Server side** needs an RPC; there is no edit operation anywhere in the public API.
   `SessionStore` exposes only `create, prepare, enter, announce, flush, get, list, fork`
   and `Session.append` is the only surface mutator. A slash command through
   `dsh-commands` is the natural carrier.
6. **Client side** needs a button plus a renderer. Replacements reach the client, so a
   client plugin can draw the edited row; note that the core transcript row definitions
   (`F\dsh-client-ui-chat\lib\client.js:5934, 6051, 6490`) match `isAppendSurfaceEvent`,
   so the original row is not suppressed — an edit is shown *in addition*, which is
   acceptable and arguably desirable. Extension points:
   `ctx.uiConversation.events.register`, the keyed slot `conversation.chat.node`
   (keys include `user`, `assistant-step`), `conversation.chat.turnTail`,
   `conversation.chat.assistant-actions`.
7. **Forking is not a substitute for editing.** Cuts are allowed only at turn
   boundaries (`OPEN_TURN` otherwise) and the tail after the cut does not exist in the
   child — which is exactly the behaviour the user rejected in opencode.

## 5. What "the edit is not part of the session" means — and does not mean

It does **not** mean concatenation. The edit replaces an element of the outgoing array;
the provider never receives the original text, in any position, and no two texts are
ever joined. Both the model and the UI see a single message with the new text.

It means the *provenance* differs: with M2 the session file still holds the original,
so opening the session without the plugin (or forking in another environment, or
reading the log with an external tool) shows the pre-edit conversation. The conversation
is coherent in that case, just unedited. The one visible oddity for a human reader is
that the assistant's reply may answer a question the reader no longer sees.

With the durable path the edit is an event in the log; the original stays below it
(the log is append-only, so nothing is erased) and is visible to anyone who inspects
the log, but the conversation — model, UI, fork, export — carries the edited text.
