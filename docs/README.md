# Context kit — working notes

This directory holds the accumulated knowledge behind this plugin: what the DSH core
allows and forbids, how the DCP port is built, what the history-editor work established,
and how the portable bundle is composed. It exists so maintainers can continue without
re-deriving the design evidence.

## Read in this order

| Document | What it answers |
|---|---|
| [`docs/dsh-core.md`](dsh-core.md) | What a plugin can and cannot change in a session. Every claim with file, line and the artifact that proved it; includes the conclusions that had to be retracted |
| [`docs/dcp-port.md`](dcp-port.md) | The DCP port: the materialization seam, the block/range model, the six defects that made pruning a no-op, and the remaining parity work |
| [`docs/edit-feature.md`](edit-feature.md) | Editing chat history: the three mechanisms, the five audits, the agreed hybrid plan, and the implementation requirements |
| [`docs/environment.md`](environment.md) | Paths, plugin wiring, the profile patch layer, operational rules, and tooling traps |

## Current state

- **DCP is implemented and protected by focused regression tests.** The automatic pass is
  proven end to end on a real `SessionStore`; a shadowed span measures 2038 → 46 tokens.
- **Context Mode is integrated into the aggregate plugin** and shares the package-level
  configuration surface with DCP and History Editor.
- **History Editor is implemented.** Its durable and wire-level behavior, GUI contract, and
  load order are guarded by `npm run test:edit-history`.
- **Release validation is intentionally split.** Run `npm run test:publication` for the
  deterministic publication gates. `node scripts/run-suite.mjs` also contains historical,
  live-profile, and environment-sensitive probes and is not the release acceptance gate.

## Runnable evidence

```powershell
# deterministic publication gates
npm run test:publication

# extended historical/live diagnostics (environment-sensitive)
node scripts/run-suite.mjs

# the port's own suite, file by file
node scripts/test-dcp-compress.mjs        # 109 checks
node scripts/test-dcp-strategies.mjs      # 79 checks, drives the real session seam
node scripts/test-dcp-integration.mjs     # 20 checks: every mechanism in one session, in order
node scripts/test-dcp-config.mjs          # 38 checks, the config pipeline
node scripts/test-dcp-nudge.mjs           # 60 checks, the decision table and delivery
node scripts/test-dcp-range.mjs           # 14 checks
node scripts/test-dcp-materialization.mjs # 39 checks against real @deepseek-ai/dsh-session

# what a session API actually permits today
node scripts/probe-edit-feasibility.mjs   # edit own message: works; edit the assistant's: refused

# the two bypasses, verified independently of the auditors who found them
node scripts/probe-wire-and-copytail.mjs  # 14 checks, all green

# the original evidence that llm/stream cannot substitute a request
node scripts/probe-seam.mjs
```

`scripts/test-source-encoding.mjs` guards against mojibake in sources — relevant because
Cyrillic written through PowerShell corrupts silently. It emits one check per owned file, so
its count tracks the file inventory.

**What `run-suite.mjs` labels mean**, because an audit found the previous labels were a
fiction: `[node:assert]` is only for files that import `node:assert/strict` (exactly two —
`test-context-mode.mjs`, `test-search-guard.mjs`); `[own failure path]` is for a file that
sets its own exit code or prints `[FAIL]` without assert; `[PRINTS ONLY: CANNOT FAIL]` is for
a file with neither, currently `probe-seam.mjs`, which is kept as a printed record and named
in the summary rather than counted as coverage. `probe-edit-feasibility.mjs` used to be in
that last class and was fixed by making it own its exit code — four auditors had falsified it,
and one of them was right that a probe which cannot fail is not evidence.

A suite run points the **test** files at a throwaway `DSH_HOME` (`.suite-state/`,
git-ignored) so fixture sessions stop writing state files into the live Context Kit state
directory. Some verify and probe files intentionally inspect the selected Harness profile;
`verify-load.mjs` is checkout-only and uses temporary scratch state.

## Rules of engagement

- Consult the upstream sources before every design decision: a separate local checkout of
  `opencode-dcp` for DCP, and the matching public Harness source when core behaviour is in
  question.
- One git commit per logical step; keep deterministic publication gates green and classify
  environment-sensitive diagnostics explicitly. Unproven means unfinished.
- Never restart the user's server while validating a development checkout.
- Re-read `docs/dsh-core.md` before assuming a core limit: three of our early conclusions
  were wrong, and retracting them cost five audits.
