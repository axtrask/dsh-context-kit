# Standing rules for this repository

## Language

> **A reply to the user is NEVER in Chinese. It is in Russian.**

The user has had to repeat this several times, in escalating terms, and called the
Chinese replies out explicitly ("да нет ты на китайском базаришь. не делай так",
"да скок бля можно НА РУССКОМ"). It is a hard rule, not a style preference.

| what | language |
|---|---|
| Chat replies to the user | **Russian** — plain, short, human |
| Code, comments, identifiers | English |
| Commit messages | English |
| `docs/*.md` | English (`docs/editor-ui.ru.md` is the Russian translation of one document) |
| Commit prefixes, log lines, tool output shown to the user | as written; never translated into Chinese |

Two more requirements travel with it, because the same frustration produced them:

- **Short and non-technical.** A long wall of technical Russian reads as noise; the user
  has said so. Answer the question, name the cause, name what is next.
- **No jargon without a plain sentence around it.** "Failed to mount the RPC seam" is not
  an answer; "кнопка не появилась, потому что сервер не успел отдать службы" is.

If a reply must include English identifiers, paths or commands, that is fine — the
*sentences* are Russian.

## Other standing rules

- **Upstream first.** Before any design decision, read the original in
  `tes/upstream/opencode-dcp` (AGPL) or `tes/upstream/context-mode` (ELv2). The ports
  reimplement behaviour, never copy source, so neither licence is inherited — but the
  behaviour is the specification.
- **One commit per logical step**, authored with `-c user.name=dcp -c user.email=dcp@local`.
- **Never restart or kill a running DSH process.** The user restarts the server; a plugin
  module is read at start-up, so an edit needs a restart to take effect.
- **Verify with a failing guard.** A check that cannot fail is not a check: when a bug is
  fixed, keep the broken shape in the suite as an executable falsification.
