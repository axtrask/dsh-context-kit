# CDSH 0.3.0

CDSH (Custom DSH) adds regional themes and optional workspace enhancements to DeepSeek Harness without replacing the host layout.

## Package contract

- npm package, client module, and Loader row id: `cdsh`
- client runtime dependency: `locale`
- host entry: `lib/index.js` (intentional no-op)
- browser entry: `lib/client.js`
- Cordis bundle patch: `cordis.patch.yml`

The package can be referenced directly from a clone by any DSH bundle resolver that accepts a local npm package path. It already contains committed `lib` output; no profile changes or build step are required to consume it.

## Reproducible build

Requires Node.js 20 or newer and no third-party dependencies.

```sh
npm run check
npm run test:builder
npm test
npm run build
npm run verify
npm pack --dry-run --json
```

`npm run build` is deterministic and does not inspect DSH profiles or npm caches. To run the optional compatibility gate against a specific installed DSH release:

```sh
DSH_NATIVE_ROOT=/path/to/node_modules/@deepseek-ai npm run test:native
```

On PowerShell, set the variable with `$env:DSH_NATIVE_ROOT = '...'` first.

Canonical production modules are in `src/`. Vendored theme tables and font inputs are in `vendor/`. The generated browser and host entries are committed in `lib/`.

## Licenses

CDSH is MIT licensed; see `LICENSE`. Third-party licenses and provenance are documented in `THIRD_PARTY_NOTICES.md`, `legal/`, and the vendored upstream directories.
