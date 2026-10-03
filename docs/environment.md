# Environment and operational boundaries

Context Kit is installed from an ordinary local or Git checkout. The checkout must not
assume a user name, a DSH cache hash, a profile directory, or a platform-specific path.

## Runtime discovery

DSH exposes these values to processes started by a profile:

| Variable | Purpose |
|---|---|
| `DSH_HOME` | Harness state root |
| `DSH_PROFILE` | Active profile name |
| `DSH_PROFILE_DIR` | Active profile directory |

They are runtime inputs, not installation targets. Repository code and scripts must not
write a profile manifest or patch directly. A test that inspects unpacked Harness files
may accept `DSH_INSTALL` as the `node_modules` root, but normal package loading uses the
Node resolver and the dependencies declared in `package.json`.

Session and Context Mode state belong beneath `DSH_HOME`; source code, generated bundles,
and dependency links do not.

## Supported installation

Use `plugin_manager install_bundle` with the absolute repository root:

```json
{
  "action": "install_bundle",
  "target": "<absolute-path-to-dsh-context-kit>"
}
```

The Plugin Manager installs ordinary dependencies, resolves the exact optional Harness
peers from the DSH installation, applies `cordis.patch.yml`, and owns subsequent updates.
Do not copy the package under `DSH_HOME`, edit profile files, create a `node_modules`
junction, or apply a separate preset.

The bundle patch inserts one aggregate Context Kit row and one relative nested CDSH row.
Both rows resolve from the installed bundle, so the composition remains portable across
DSH and Node.js installation locations.

## Development checks

Run the publication gates from the repository root:

```sh
npm run test:publication
node scripts/verify-load.mjs
```

The publication gate checks the manifest, Loader topology, packed inventory, and Edit
History regressions. `verify-load.mjs` imports the canonical aggregate package, validates
its schemas, exercises the in-memory knowledge base, and runs the supported sandbox
languages in a temporary directory. Neither command installs a bundle or changes a DSH
profile.

Some historical probes inspect Harness implementation details. They resolve installed
packages through Node or require an explicit `DSH_INSTALL`; they must fail clearly rather
than fall back to a developer's machine path.

## Operational rules

- Never restart or kill a running DSH process. The user controls restarts.
- Use `plugin_manager` for every profile bundle change.
- Treat the `application` and `warnings` fields returned by Plugin Manager as the source
  of truth for live application versus restart requirements.
- Keep code, comments, identifiers, and English documentation in English.
- Preserve executable regression guards for every behavior-affecting fix.
