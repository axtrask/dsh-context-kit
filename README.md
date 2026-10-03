# dsh-context-kit

`dsh-context-kit` is one private DeepSeek Harness bundle that installs native context-management and history-editing features:

- **DCP** adds model-directed compression and deterministic context cleanup.
- **Context Mode** adds sandboxed processing and a searchable local knowledge base so large outputs do not have to enter the conversation.
- **History Editor** edits user messages and the effective assistant text used by later turns.
- **CDSH** is shipped as a nested package and mounted by the same bundle.

The bundle reimplements useful behavior in Harness-native services. It does not copy the upstream DCP or context-mode source.

## Requirements

- Node.js 22.19 or newer.
- A compatible DeepSeek Harness installation that supplies the optional `@deepseek-ai/*` peer packages declared in `package.json`.
- The Harness `plugin_manager` tool.

This repository is private and `UNLICENSED`. Installing it does not grant permission to redistribute it.

## Supported installation

Install the repository as a bundle. Do not copy files into a profile, edit a profile manifest, create junctions, or run migration scripts.

### Local checkout

1. Clone or copy the repository to a normal workspace outside the DSH profile.
2. Ask a Harness agent to call `plugin_manager` with:

```json
{
  "action": "install_bundle",
  "target": "<absolute-path-to-the-checkout>"
}
```

Use the repository root as `target`, not `lib`, `packages/cdsh`, or a generated archive.

### Git checkout

Clone from the Git URL supplied by the repository owner, then install that checkout with the same `plugin_manager install_bundle` call:

```sh
git clone <git-url> dsh-context-kit
```

For an update, pull the desired revision and install the same absolute checkout path again. Read the `application` and `warnings` fields returned by `plugin_manager`; they state whether the update was applied live or needs a restart.

## Installed composition

`cordis.patch.yml` inserts exactly two enabled Host rows:

| Loader id | Package | Purpose |
|---|---|---|
| `context-kit-bundle` | `dsh-context-kit` | Aggregate DCP, Context Mode, and History Editor Host and Web client |
| `cdsh` | `./packages/cdsh/lib/index.js` | Nested CDSH package shipped in this bundle |

The Context Kit row is deliberately aggregate. Do not mount `dsh-context-kit/dcp-plugin`, `dsh-context-kit/context-mode-plugin`, or `dsh-context-kit/editor-plugin` as extra Loader rows: they would duplicate the owning package's Web client and service contributions.

## Settings

The aggregate package owns one **Context Kit** scope in **Settings > Plugins**. Its values are grouped beneath three nested sections:

- `dcp` — compression, pruning, protected tools, notifications, and subagent policy;
- `contextMode` — capture limits, search limits, sandbox routing, and knowledge-base behavior;
- `historyEditor` — Edit History availability and idle-session safety.

The default patch enables all three sections. DCP also enables `includeContextStatus`, matching the current supported runtime behavior.

CDSH is a separate nested package in the same installation. Its Loader row is not another Context Kit settings namespace.

## Package contract

The publication root is `dsh-context-kit` version `0.1.11`:

- `lib/` is the canonical implementation;
- `locale/` contains package and component metadata;
- `cordis.patch.yml` declares the two supported Loader rows;
- `packages/cdsh/` is the only nested package;
- `undici` is the only ordinary runtime dependency;
- compatible Harness libraries are exact optional peers supplied by the installation.

Development runtime generations are not part of the package. There are no `runtime`, `runtime-2`, or later cache-busting snapshots and no absolute machine paths in the packed files.

## Verification

From the repository root:

```sh
npm run test:metadata
npm run test:edit-history
```

`test:metadata` validates the manifest, aggregate-plus-nested Loader topology, Web client identity, nested settings shape, and the `npm pack --dry-run` inventory. `test:edit-history` runs the five regression gates that protect the durable edit path, wire rewrite, Settings UI, and client load order.

Run both groups with:

```sh
npm run test:publication
```

These tests inspect the checkout only. They do not install the bundle, modify a DSH profile, or restart a running Harness process.

## Main entry points

| Path | Role |
|---|---|
| `lib/index.js` | Aggregate Host entry exported by the package root |
| `lib/plugin.js` | Shared Context Kit Host composition and nested config schema |
| `lib/dcp.js` | DCP engine, compression tool, commands, and integration hooks |
| `lib/context-mode.js` | Context Mode tools, routing guard, and knowledge-base integration |
| `lib/edit-client.js` | Context Kit Settings card and Edit History Web integration |
| `packages/cdsh/` | Nested CDSH package |

Legacy component exports remain available for programmatic compatibility, but the supported bundle composition mounts only the aggregate package root.
