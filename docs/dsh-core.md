# DSH core: what a plugin can and cannot change

Everything below is established by executable proof, not by reading comments. Every
claim names the file and line that enforces it and the artifact that demonstrated
it. When a claim was overturned later, the overturning evidence is recorded too —
three of our early conclusions did not survive contact with a real session.

`F = C:\Users\pro100noob\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\`

## 1. The shape of a session

- The log is **append-only**. `F\dsh-session\lib\index.js` — `Session.append(type, data, opts)`.
- The **surface** is a derivative of the log, and *it* is what becomes the message
  array: `F\dsh-agent-loop\lib\index.js:1204` — `const boundaryMessages = session.deriveMessages()`.
- Two surface operations exist, and only two: `surfaceOp: 'append'` and
  `surfaceOp: { op: 'replace', startSeq, endSeq }` (`F\dsh-session\lib\types\types.d.ts:429-433`).
- A replacement **must cite** every node it shadows: `sourceEventSeqs`
  (enforced at `F\dsh-session\lib\index.js:299-300`).
- A range replacement collapses the range into **one** node, and lands **at the
  start index** of the range — not at the tail:
  `F\dsh-session\lib\types\surface.js:370-377`
  `state.nodes.splice(plan.startIdx, plan.endIdx - plan.startIdx + 1, plan.seq)`.
  Measured: surface `[0,1,2,3]`, replace `[1..1]` → `[4,2,3]`, provider order preserved.
- Surface event types are a private runtime set of exactly four literals
  (`F\dsh-session\lib\types\surface.js:13-18`): `system/message`, `user/message`,
  `assistant/message`, `tool/result`. It is **not exported** and there is **no registry**:
  "plugin-merged" in `types.d.ts` is a TypeScript-only merge. A plugin cannot add a
  surface-eligible event type — proven by 6 experiments in `audit-work/a2`.
- `deriveEventMessage` is a closed `switch`; `default: return null`
  (`F\dsh-session\lib\types\surface.js:75-110`).

### Event payload shapes (a real trap)

| event | payload |
|---|---|
| `user/message` | the `UserMessage` **bare** — `deriveEventMessage` returns `event.data` verbatim |
| `system/message` | `{ message: SystemMessage }` |
| `assistant/message` | `{ turn, step, message: AssistantMessage, stream: AssistantStreamRecord[], usage?, interrupted? }` |
| `tool/result` | `{ turn, step, message: ToolResultMessage, error?, meta? }` |

Getting this wrong fails confusingly: a bare object under `user/message` throws
`TypeError: Cannot read properties of undefined (reading 'content')` deep inside
`deriveMessages`, and a wrapped object under `user/message` silently produces a
message with no `role` and no `content`, which then fails in the LLM runtime with
`content is not iterable`.

Also: `createToolResultMessage({callId, content})` **without** an explicit `isError`
leaves `isError: undefined` on the block, `undefined` is not JSON for DSH, and the
whole event is rejected with `session event "tool/result" carries non-JSON-serializable
data`. Always pass `isError` explicitly.

### Message-id footgun

`createUserMessage({content})` returns a **plain `UserMessage`** (the object itself).
`createToolResultMessage(...)` / `createAssistantMessage(...)` return the same, but
when appended under `assistant/message` / `tool/result` they must be wrapped in
`{ message: ... }`. Since `message.id` is generated per call, two "identical"
fixtures are not byte-identical.

## 2. What cannot be done (each proven, not assumed)

1. **An `assistant/message` can never be a replacement carrier.** Two rules
   contradict, so every spelling dies:
   - with `sourceEventSeqs` → `F\dsh-session\lib\index.js:285`
     `assistant/message embeds its source stream and cannot carry sourceEventSeqs`
     (type-level mirror: `sourceEventSeqs?: never`, `types.d.ts:438-446`);
   - without it → `F\dsh-session\lib\index.js:299-300`
     `surface replace: sourceEventSeqs must include every shadowed surface node; missing N`.
   Line 285 fires even on `append` — it is about the field, not about replacement.
   The ban has nothing to do with tool calls: a text-only assistant reply is refused
   byte-for-byte with the same errors.
2. **A `tool/result` can only rewrite one current `tool/result` node, and only
   `content[0].content`** — `assertToolResultRewrite`, `F\dsh-session\lib\index.js:346-372`.
   Changing `toolCallId` → `tool/result surface replacement may change only content`.
   This is the *only* sanctioned rewrite mechanism in the whole core.
3. **Surface node 0 is protected** — `assertSystemHeadRewrite`,
   `F\dsh-session\lib\index.js:379-383`: only a `system/message` over exactly that
   node may rewrite it.
4. **No positional insert.** `isReplaceOp` requires exactly 3 keys
   (`F\dsh-session\lib\index.js:262-264`); `append` pushes to the tail only.
5. **In-place mutation of log or messages is impossible** — `deepFreeze` twice:
   `F\dsh-session\lib\index.js:1182-1188` and `F\dsh-agent-loop\lib\index.js:1204-1213`.
   Writing to a frozen message throws `TypeError: Cannot assign to read only property`.
6. **`llm/stream` cannot substitute a request via its arguments.**
   `F\dsh-llm\lib\index.js:2306-2308` calls
   `ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(options, prepared))`.
   cordis builds `next` as `const next = () => (cbs.shift() ?? inner)(...args)`
   (`cordis\lib\index.js:317-325`) — arguments to `next(...)` are **discarded**.
   The harness's own listener is registered as `(_options, next) => validateStream(next(), fail)`
   (`F\dsh-llm\lib\invariant.js:63`), underscore included. The request envelope is
   deep-frozen at build time.

## 3. What can be done (the useful half)

### 3.1 Edit the user's own message, keep the tail — works today, no patch

```js
session.append('user/message', newUserMessage, {
  surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },   // startSeq === endSeq
  sourceEventSeqs: [seq]                                       // a superset is accepted
});
```

Verified in `scripts/probe-edit-feasibility.mjs` case 1/1b/1c:

```
surface [4,2,3]      provider gets: user NEW-A | assistant ORIGINAL-B <call bash> | user <result>
surface [4,2,3,6]    then a new turn appends cleanly after it
foldSurface(log)     rebuilds [4,2,3] — the edit is in the log, so a restart keeps it
```

This is the whole answer to "edit without losing the tail": the fold is positional,
so nothing after the edited node is cut.

### 3.2 Rewrite on the wire — works today, log untouched

A listener may **re-enter the public `LlmRuntime.stream()`** with a rebuilt request.
Re-entering through `this.stream(...)` is what makes it work: inside a listener
`this` is the `LlmRuntime` instance (`cordis\lib\index.js:263`).

```js
const reentered = new WeakSet();
root.on('llm/stream', function (options, next) {
  if (reentered.has(options)) return next();          // guard against recursion
  const messages = Object.freeze(options.messages.map(rewriteOne));
  const rewritten = Object.freeze({ ...options, messages });
  reentered.add(rewritten);
  return this.stream(rewritten);                      // public, same provider
});
```

Verified in `scripts/probe-wire-and-copytail.mjs` (R2 section, now 8 checks green):
the adapter receives `assistant A1-EDITED <call bash>`, the listener runs exactly twice
(loop request, own rewrite), and **no adapter call, in any position, carries the original
text**. Nothing complains, because `callConfigEquals` (`F\dsh-llm\lib\index.js:352-356`)
compares only provider, model, reasoningEffort, temperature, maxTokens, stop — **not**
messages.

Four auditors independently narrowed two claims that used to be written here in absolute
form, and the narrowings are the honest ones:

- **"the model never sees the original text in any position"** is proven *at the adapter
  boundary*, over `JSON.stringify` of every request the adapter received — not over a network
  payload. No HTTP request is made by any probe, so nothing here says what a provider
  transport does with the envelope afterwards. The check used to scan a projection that
  renders only text blocks and call names, so an original hiding in a tool-result body or a
  call's `arguments` was invisible to it; it now scans the whole serialized request of every
  call, and a second check proves the scan is not vacuous by finding the text the model DOES
  still have.
- **"the session log is byte-identical"** is serialized equality of the in-memory event array
  (`JSON.stringify(session.snapshotEvents())` before and after). No probe writes or reads a
  session log file, so byte-identity *on disk* is untested. The stronger statement is also
  false as worded: `deriveMessages()` deliberately still returns the original, because the
  log is the record of what happened and the overlay is not state.

Cost: the change is invisible to the log, to invariants, to the token meter and to
the UI. It is a wire-level overlay, not state.

### 3.3 Durable rewrite inside the log — the copy-tail recipe

`system/message` with `content: []` projects to `null` (`F\dsh-session\lib\types\surface.js:96-101`):
the node **occupies a surface position but is invisible to the provider**. That gives
a legal way to erase a range while re-emitting the tail as fresh appends.

```js
const range = [...session.surface.nodes].slice(session.surface.nodes.indexOf(editSeq));
session.append('assistant/message', editedAssistantData, { surfaceOp: 'append' });
for (const seq of range.slice(1)) {
  const event = session.eventAt(seq);
  session.append(event.type, structuredClone(event.data), { surfaceOp: 'append' });
}
session.append('system/message',
  { message: { id: 'void', role: 'system', content: [], source: { kind: 'system-prompt' } } },
  { surfaceOp: { op: 'replace', startSeq: range[0], endSeq: range.at(-1) }, sourceEventSeqs: range });
```

Verified in `scripts/probe-wire-and-copytail.mjs` (R3 section, 8 checks green):
provider view length 6 → 6, roles identical position by position, edited text in
place, tail intact, no empty message emitted, log reloads to the same view,
`foldSurface` matches the live surface, tool pairing still balanced.

Cost: `1 + tail length` events per edit; downstream message ids change to the copies;
the transcript gets **duplicate rows** because the UI matches append-origin events
(`F\dsh-client-ui-chat\lib\client.js:6051`, and the same predicate at 5934, 6490).

### 3.4 What a core patch would open (do not do this casually)

A5 proved the minimal patch: **two guard sites**, both mandatory because the shipped
`lib` is bundled, so the source-level guard exists twice and both copies are live:

- `F\dsh-session\lib\index.js:285` — the live path for `Session.append()`;
- `F\dsh-session\lib\types\surface.js:207-209` — the live path for the
  `dsh-session/surface` subpath (`dsh-compaction`'s `SurfaceManager`, the API
  wire-event validator). Reverting only the first re-blocks edits; a log accepted by
  the patched `index.js` is still rejected by an unpatched `surface.js`.

Browser bundles carry two more copies (`F\dsh-api-session-controller\lib\client.js:249`,
`F\dsh-client-connection\lib\client.js:1858`).

Result after patching (`audit-work/a5/verify.mjs`): nodes `[0,1,6,3,4,5]`,
`TAIL KEPT: YES`, roles and order identical, system-head and tool/result guards still
fire, reload re-validates. In published source it is **one** edit —
`packages/core/session/src/surface.ts:274-275` — the duplication is a bundler artifact.

Implementation requirements discovered after the fact:

- write `message.content` **and** `stream` coherently. `assertCurrentAssistantStreams`
  ("content disagrees with its embedded stream") is reachable **only from the migration
  path**, so a stale `stream` loads without complaint and anything rendering from it
  (trajectory view, replay) shows the old text;
- projection cache rows (`$DSH_HOME/storages/session_projcache/sessions/<id>.json`) are
  keyed by a seq watermark with **no content digest** and hold literal text copies — an
  edit that does not change the seq count can leave stale projections (e.g. session title);
- `dsh-session\invariant.js:56-58` requires an open step for `assistant/message`, so an
  out-of-turn edit trips it.

Upgrade risk: the install lives in an npx cache directory named by hash
(`_npx\1e7f6d9597241db0`). A new install is a **new directory with a pristine package**,
so the patch must be re-applied. `patch-dsh-session.mjs --check` (in `audit-work/a5`)
tests its own applicability and exits non-zero when the anchor is missing.

## 4. Session plumbing worth remembering

- **The transcript the user sees does not follow replacements.** The server **does**
  send replacement events to the client (`F\dsh-api-session-controller\lib\types\history.js`
  `paginate` returns `events.slice(cut, end)`, replacements included) — an earlier
  conclusion of ours that they were filtered server-side was **wrong**. They are hidden
  in the browser: `systemMessageDefinition` has a catch-all
  `match: (event) => event.type === "system/message" || "surfaceOp" in event && event.surfaceOp !== "append"`
  (`F\dsh-client-ui-chat\lib\client.js:6120-6141`) whose `buildViewNode` returns null.
  Consequence: **a client plugin can render an edit**, because the data arrives.
- **Fork copies the log**, it does not reference it:
  `_forkSeed` uses `snapshotEvents(0, boundary + 1)` (events `0..boundary` inclusive),
  then `create(..., seed, inheritedEventCount = seed.length, meta {parentSession, isSeeded, cwd})`
  (`F\dsh-session\lib\index.js:1579-1611`). Landed replacements are inherited.
  A cut is allowed **only at a turn boundary** — between `turn/start` and `turn/end` it
  throws `OPEN_TURN`; the contract is "the first `turn/end` at or after atSeq"
  (`SESSION_NOT_FOUND | SESSION_NOT_LIVE | SESSION_ALREADY_EXISTS | INVALID_BOUNDARY | OPEN_TURN`).
  The branch button already exists: `onBranch: () => forkAt(closing.finalNode.seq)`
  (`F\dsh-client-ui-chat\lib\client.js:3664-3667`), disabled by
  `branchUnavailable: data.branchUnavailable || hasLaterChatNode`.
- **Tool pairing is guarded by a module, not by the fold**:
  `F\dsh-compaction\lib\types\tool-pairing.js` —
  `tool/result at surface seq N has no matching tool-call (corrupt surface)`.
  Replacing a tool-calling assistant node with a plain user message orphans the result.
  **Any editor must refuse to strip tool calls.**
- **Known hole (do not build on it):** `SurfaceManager.nodes`'s getter returns the live
  internal array (`F\dsh-session\lib\index.js:480-483`) while the type declares
  `readonly nodes: readonly SessionSeq[]` (`types\surface.d.ts:94`). Splicing it rewrites
  the model's view in memory — role preserved, order chosen — but it is not persisted and
  `foldSurface` disagrees with it. A second hole: `Session.append` does not check
  event-type↔role (`assertMessageEventShape` is called only on the seed path,
  `F\dsh-session\lib\index.js:900`), so a `user/message` carrying `role:"assistant"` is
  accepted live and makes the session **unloadable** (`seed user/message at index N message
  must have role "user"`).
- **Persistence**: `$DSH_HOME/sessions/<projectKey>/<encodedId>/session.v3.jsonl.zstd` —
  JSONL inside a concatenation of independent zstd frames, frame[0] being the header.
  There is **no cryptographic integrity**: no per-record hash, MAC or length prefix; the
  only check is an unkeyed zstd frame checksum (`ZSTD_c_checksumFlag: 1`,
  `F\dsh-session-persistence-jsonl\lib\index.js:1289`), absent under `compression: "none"`.
  Decode → edit → recompress with a valid checksum **loads without error** and
  `deriveMessages()` returns the forged text. A live writer **appends after** an edit
  rather than reverting it (verified with a real open handle); truncating records under a
  live writer corrupts the log permanently. Our claim that the log is tamper-evident was
  **wrong** — it is accident-evident, not intent-evident. The honest route is still to
  append a normal replacement event, which flows to disk unchanged.
- **Invariant companions**: `dsh-invariants` ships no checks itself; 38 per-package
  `lib/invariant.js` files carry them. Rule of thumb: **log-anchored invariants survive
  editing, surface-anchored consumers break.** `dsh-agent-loop\invariant.js:26-27` is an
  ally — it compares the request against `session.deriveMessages()`, the same derivative.
  `dsh-session-title\invariant.js:36-37` resolves through `eventAt` (the log), so titles
  survive. The live web profile mounts **no** invariant rows today, so these are latent.

## 4b. `ctx.on(...)` on a waterfall event is MIDDLEWARE, not an observer

**This cost a working product.** The nudge hook was written as a plain listener:

```js
ctx.on('agent/pre-step', ({ agent }) => {          // no continuation parameter
  try { engine.pruneSession(agent.session, agent, { nudge: true }); }
  catch (error) { engine.ctx.logger.warn(...); }
});                                                // and never calls next()
```

`agent/pre-step` is a cordis **waterfall**. The chain advances only when a listener calls
`next()`; a listener that returns without it **vetoes everything downstream, including the
built-in behaviour of the step**. The result, after the next server restart, was that *every*
turn on the `context-kit` preset died in 40-250 ms before reaching the model:

```
turn/end turn=N reason={"kind":"error","error":{"message":"Cannot read properties of undefined (reading 'kind')","code":"UNKNOWN"}}
```

The fix is one continuation parameter and one call:

```js
ctx.on('agent/pre-step', ({ agent }, next) => {
  try { engine.pruneSession(agent.session, agent, { nudge: true }); }
  catch (error) { engine.ctx.logger.warn(`${PLUGIN_ID}: pre-step pass failed: ${errorLine(error)}`); }
  return next();                                   // AFTER the pass, OUTSIDE the try/catch
});
```

`return next()` must sit outside the `try`, or the plugin's own failure would skip the
continuation — the point is that the plugin's error stays swallowed and logged while the chain
continues.

**The blame lands on the wrong package.** The stack named `dsh-agent-instructions`
(`lib/index.js:1276`), `dsh-tool-skill` (`:169`, `:205`) and `dsh-session-reference` (`:468`) —
each merely `await next()` and dereference the `undefined` it was handed. Disabling one just
**moves** the crash to the next listener. The rule: *the first component to stumble on the lost
value fails, not the component that lost it.*

### Events that are waterfalls (treat every `ctx.on` on these as middleware)

`agent/pre-step`, `agent/request`, `agent/request-error`, `llm/stream`,
`system-prompt/assemble`, `tools/pre-execute`.

`scripts/test-waterfall-hooks.mjs` now enforces this shape for the plugin's own `lib/*.js`: a
declared continuation parameter *and* an actual `next(` call, resolving a named listener in the
same file, plus a named check for the `agent/pre-step` hook. `falsify-waterfall-gate.mjs` mutates a
copy of `lib/` to drop `next()` and asserts the gate fails — it does, with five FAIL lines.

### The debug recipe that cracks this class in one run

`agent/error` in the session log carries only `message` and `code: "UNKNOWN"` — **the real stack is
not in the log.** Capture it from the live `agent/error` event inside the process, which in
practice means a diagnostic plugin row in a scratch profile that writes the stack to a file. Every
attempt to find this from the persisted session log went in circles.

### Traps that made this take longer than it should have

- A reproduction profile must be **complete**. A scratch profile without the DeepSeek extension
  fails with `REQUEST_EXTENSION` instead, which reads as "does not reproduce here". Only a step-0
  failure is trustworthy for this defect class; once a turn reaches the model, the profile is
  useless for it.
- **Verify that `disabled: true` actually applied.** Disabling a preset row at profile level left
  the row in the composition (another row overrode it), and "the disable did not help" was a wrong
  conclusion drawn from a correct observation. Check `--dump-config` and confirm the row is gone.
- **Do not hand-edit `~/.dsh/.agent-presets/context-kit/agent.cordis.yml`.** It is a generated
  snapshot of the shipped `standard` preset; `scripts/sync-preset.mjs` regenerates it and would wipe
  the edit. Change the generator.
- **Removing the `dcp` row from the preset is not a workaround**: the preset then fails to mount —
  `agent-preset/invalid: preset "context-kit" failed to mount: 1 row(s) did not activate:
  command-compact (...): waiting for compaction`, because `command-compact` waits on the
  `compaction` service that `dcp` publishes.
- PowerShell 5.1 corrupts YAML/UTF-8 (`Set-Content` turned a row `id` into `В id`); grep the result
  rather than trusting exit code 0.

### Why the suite did not catch it

903 checks were green while every turn was broken. **No test file runs a live agent loop**, so a
hook that does nothing in a unit test and kills every production turn passes. That is the same
defect class as the three recorded in `docs/dcp-port.md` §6: not a wrong implementation, but a
mechanism whose *shape* was never asserted. The gate above asserts the shape.

## 5. Conclusions that had to be retracted

Recorded so nobody re-derives them the expensive way.

1. "A plugin cannot change what the provider receives, except through session
   materialization." — **False.** Three ways exist: user-message replacement (§3.1),
   wire rewrite (§3.2), copy-tail (§3.3).
2. "Replacement events are filtered server-side and never reach the client, so the UI
   cannot show an edit." — **False.** They arrive; the browser hides them (§4).
3. "The session log is a tamper-evident record." — **False.** No cryptographic
   integrity at all; only zstd frame checksums (§4).
4. "The assistant's reply cannot be edited because replacing it would orphan its tool
   call." — **Wrong reason.** The ban fires identically for a text-only reply; it is
   about `stream`, not about tool calls (§2.1).
5. "`llm/stream` is useless for rewriting." — **Too broad.** `next(rewritten)` is
   discarded, but a listener can re-enter `this.stream(rewritten)` and that works (§3.2).
