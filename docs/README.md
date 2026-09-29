# Context kit — working notes

This directory holds the accumulated knowledge behind this plugin: what the DSH core
allows and forbids, how the DCP port is built, what the history-editor work has
established, and how this machine is wired. It exists so that a fresh context — after a
compaction, or a new session — can continue without re-deriving anything.

## Read in this order

| Document | What it answers |
|---|---|
| [`docs/dsh-core.md`](dsh-core.md) | What a plugin can and cannot change in a session. Every claim with file, line and the artifact that proved it; includes the conclusions that had to be retracted |
| [`docs/dcp-port.md`](dcp-port.md) | The DCP port: the materialization seam, the block/range model, the six defects that made pruning a no-op, and the remaining parity work |
| [`docs/edit-feature.md`](edit-feature.md) | Editing chat history: the three mechanisms, the five audits, the agreed hybrid plan, and the implementation requirements |
| [`docs/environment.md`](environment.md) | Paths, plugin wiring, the profile patch layer, operational rules, and tooling traps |

## Current state, in five lines

- **DCP port works and is green:** <!-- suite:count -->950 marked checks / 0 failures across 21 test + 8 verify + 3 probe files<!-- /suite:count --> (`node scripts/run-suite.mjs`), the automatic
  pass is proven end to end on a real `SessionStore`; a shadowed span measures
  2038 → 46 tokens, so the saving is real rather than a manifest claim.
- **Twelve parity defects are closed since the first audit**, each with the commit and the
  cost recorded in `dcp-port.md` §6 — the age unit, the dedup signature, the compress limit
  defaults, the output-prune exemption, the nudge delivery, an invented config key, plus
  `recompress`, tool-name globs, `resetOnCompaction`, per-session nudge state, `sweep N` and
  a `decompress` that actually restored anything.
- **What remains open is listed in `dcp-port.md` §7** and is small: `nudgeForce` (inert by
  construction, explained in place), and `context-mode`, the untouched second plugin.
- **A history editor is researched, designed and agreed, but not built.** Agreed order:
  finish DCP, then build the editor as a hybrid (durable when the core ban is lifted,
  wire-level otherwise). DCP is now finished by that definition.

## Runnable evidence

```powershell
# everything at once: 15 test files, 8 verify scripts, 3 probes
node scripts/run-suite.mjs                # add --update to refresh the suite:count markers
node scripts/run-suite.mjs --update

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
git-ignored) so fixture sessions stop writing state files into the live
`~/.dsh/context-kit/dcp-state/`; the verify and probe files keep the real home because
`verify-preset` and `verify-load` read the installed preset.

## Rules of engagement

- Consult the upstream sources before every design decision:
  `~\.dsh\tes\upstream\opencode-dcp` for DCP, and the public harness source (tag
  `dsh-v0.1.5-rc.2`) when core behaviour is in question.
- One git commit per logical step; keep the suite green; verify on the live server rather
  than claiming success. Unproven means unfinished.
- Never restart the user's server. File policy is `danger-full-access` with approval
  prompts disabled, so sandbox escalation must never be requested.
- Re-read `docs/dsh-core.md` before assuming a core limit: three of our early conclusions
  were wrong, and retracting them cost five audits.
