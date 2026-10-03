/* Implementation note.

















































































 */

import { readFile, writeFile, mkdir, rm, mkdtemp, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve, basename, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { checkNativeContracts } from './check-native-contracts.mjs'

/* Implementation note. */

const SCRIPTS = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(SCRIPTS, '..')
const WORK = join(PACKAGE_ROOT, 'src')
const REPO = PACKAGE_ROOT
const UPSTREAM = join(PACKAGE_ROOT, 'vendor', 'dsh-opencode-palette')
const UPSTREAM_SRC = join(UPSTREAM, 'src')
const UPSTREAM_ENGINE = join(UPSTREAM_SRC, 'engine')

const DEFAULT_NAME = 'cdsh'
const DEFAULT_ROW_ID = 'cdsh'
const SETTINGS_SLOT = 'settings.plugins.tab'
const DEFAULT_VERSION = '0.3.0'

/** Platform singletons the web shell seeds into the client module table. */
const SEED_WORDS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/** Package-name edges whose factories must arrive before ours. */
const DEFAULT_CLIENT_INJECT = []

/**
 * Cordis service names (NOT package names) required before the client plugin
 * boots. Cordis 4.0.4 requires the locale edge to be declared by this wrapper;
 * feature-specific services remain supervised by runtime ctx.inject() scopes.
 */
const DEFAULT_CORDIS_INJECT = ['locale']

/** Entry export candidates on `runtime.mjs`, tried in order. */
const ENTRY_CANDIDATES = ['createClient', 'createPlugin', 'plugin', 'create', 'apply']

/** Source stems that MUST exist for a build. */
const REQUIRED_STEMS = ['generate-regions', 'runtime', 'panel', 'design', 'workspace', 'enhancements']

/** Every source stem; `font-face` is optional and can be stubbed by --no-fonts. */
const STEMS = ['generate-regions', 'font-face', 'runtime', 'panel', 'design', 'workspace', 'enhancements']

/** Exports the runtime expects from the conversation-rendering module. */

/* Implementation note.










 */
const DESIGN_EXPORTS = ['designCss']

/** Exports the runtime expects from the optional font payload module. */
const FONT_FACE_EXPORTS = ['FONT_FACE_CSS', 'BUNDLED_FONTS']

/** Node builtins that get a shim binding instead of a bundle dependency. */
const NODE_BUILTINS = new Set(['fs', 'path', 'url', 'os'])

/** Cut the Node-only CLI tail from this top-level marker to EOF. */
const DEFAULT_TAIL_MARKER = /^(?:const|let|var)\s+invokedDirectly\b/

/** Text extensions eligible for build-time inlining into the shimmed `fs`. */
const INLINE_EXT = new Set(['.json', '.mjs', '.js', '.cjs', '.css', '.txt', '.md'])

/* Implementation note. */

const RE_IMPORT_JSON = /^import\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+\.json)['"](\s+with\s*\{[^}]*\})?\s*;?\s*$/
const RE_IMPORT_NAMED = /^import\s*\{\s*([^}]*?)\s*\}\s*from\s*['"]([^'"]+)['"]\s*;?\s*$/
const RE_IMPORT_DEFAULT = /^import\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]\s*;?\s*$/
const RE_IMPORT_NS = /^import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]\s*;?\s*$/
const RE_EXPORT_DEFAULT_ID = /^export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/
const RE_EXPORT_FN = /^export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/
const RE_EXPORT_VAR = /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/
const RE_EXPORT_CLASS = /^export\s+class\s+([A-Za-z_$][\w$]*)/
const RE_FORBIDDEN = /^(?:import\s*\(|import\b|export\s+default\b|export\s*\{|export\s*\*)/

/* Implementation note. */

/* Implementation note.



 */
const GATES = [
  {
    id: 'G1',
    hard: true,
    re: /var\(\s*--dsw-[A-Za-z0-9-]+\s*,/g,
    what: 'var(--dsw-…, <fallback>) — an unresolved token silently takes the fallback colour',
    fix: 'emit the bare value or a plain custom property; never a fallback for a --dsw-* name',
  },
  {
    id: 'G2',
    hard: true,
    re: /\._[A-Za-z0-9]+_[A-Za-z0-9]{3,}/g,
    what: 'hashed DSH class selector (`._card_1b2ny_13`) — unstable across DSH releases',
    fix: 'anchor on a semantic attribute ([data-diff], [data-terminal], …) or your own wrapper',
  },
  {
    id: 'G3',
    hard: true,
    re: /\.overrideTokens\s*\(|document\.(?:body|documentElement)\.style\.setProperty\s*\(/g,
    what: 'document-wide token/root write — exactly the "paints everything" behaviour being replaced',
    fix: 'declare the tokens inside a region root selector instead',
  },
  {
    id: 'G4',
    hard: false,
    // Implementation note.
    // font is declared on `:root` in the shipped CSS and consumed by `body`, so
    // Implementation note.
    // violation. Never escalates, even under --strict.
    escalate: false,
    except: /--dsw-font-family|data-ds-dark-theme/,
    re: /(?:^|[\s,{}])(?::root|html|body)\s*(?:,|\{)/g,
    what: 'a global (`:root` / `html` / `body`) CSS rule — only the typography axis may be document-wide',
    fix: 'scope colour/token blocks to a region root; document-wide rules are limited to the font axis',
  },
  {
    id: 'G5',
    hard: false,
    re: /[^.\w]import\s*\(/g,
    what: 'dynamic import() — cannot resolve from a classic-script bundle (fetch is relative to the bundle URL)',
    fix: 'pass the module in at build time (the entry wiring already passes generator and panel)',
  },
  {
    id: 'G6',
    hard: false,
    re: /querySelectorAll\(\s*['"]style\[data-plugin/,
    what: 'selecting foreign `style[data-plugin]` nodes — that is DSH HMR bookkeeping, not ours',
    fix: 'sweep only tags carrying our own marker (data-dsh-palette-style / PLUGIN_ID)',
  },
]

/* ─────────────────────────────── helpers ───────────────────────────────── */

const log = (...a) => console.log(...a)
const bytes = (s) => Buffer.byteLength(s, 'utf8')

function die(title, lines = []) {
  console.error('\n[build] FAILED — ' + title)
  for (const line of lines) console.error('  ' + line)
  console.error('')
  process.exit(1)
}

function parseArgs(argv) {
  const opts = {
    mode: 'build',
    strict: false,
    gate: true,
    keepTail: false,
    noFonts: false,
    noNodeShim: false,
    version: process.env.PALETTE_VERSION || DEFAULT_VERSION,
    name: process.env.PALETTE_NAME || DEFAULT_NAME,
    versionExplicit: false,
    nameExplicit: false,
    rowId: process.env.PALETTE_ROW_ID || DEFAULT_ROW_ID,
    slot: SETTINGS_SLOT,
    entry: undefined,
    inject: undefined,
    root: WORK,
    outputDir: undefined,
  }
  const val = (a, prefix, i) => (a.startsWith(prefix) ? a.slice(prefix.length) : argv[i + 1])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--check') opts.mode = 'check'
    else if (a === '--selftest') opts.mode = 'selftest'
    else if (a === '--strict') opts.strict = true
    else if (a === '--no-gate') opts.gate = false
    else if (a === '--keep-tail') opts.keepTail = true
    else if (a === '--no-fonts' || a === '--light') opts.noFonts = true
    else if (a === '--no-node-shim') opts.noNodeShim = true
    else if (a === '--version' || a.startsWith('--version=')) {
      opts.version = val(a, '--version=', i)
      opts.versionExplicit = true
    } else if (a === '--name' || a.startsWith('--name=')) {
      opts.name = val(a, '--name=', i)
      opts.nameExplicit = true
    } else if (a === '--row-id' || a.startsWith('--row-id=')) opts.rowId = val(a, '--row-id=', i)
    else if (a === '--entry' || a.startsWith('--entry=')) opts.entry = val(a, '--entry=', i)
    else if (a === '--output-dir' || a.startsWith('--output-dir=')) opts.outputDir = resolve(val(a, '--output-dir=', i))
    else if (a === '--inject' || a.startsWith('--inject=')) opts.inject = val(a, '--inject=', i).split(',').map((s) => s.trim()).filter(Boolean)
    else die('unknown option ' + a, ['see the usage block at the top of scripts/build.mjs'])
  }
  for (const key of ['version', 'name', 'rowId']) {
    if (opts[key] === undefined || opts[key] === '') die('--' + key + ' needs a value', ['e.g. node scripts/build.mjs --' + key + ' <value>'])
  }
  return opts
}

/**
 * Read the identity the sources actually use. `src/env.mjs` is the single
 * source of truth for the plugin id, the version and the settings slot, so the
 * manifest, the bundle registration id and the `data-plugin` style marker can
 * never drift apart — which is exactly how a build ends up with orphaned
 * `<style>` tags after an HMR reload.
 *
 * @param root - source directory.
 * @returns `{ id, version, slot, file }` or undefined when the file is absent.
 */
async function readEnvModule(root) {
  const file = join(root, 'env.mjs')
  if (!existsSync(file)) return undefined
  const text = await readFile(file, 'utf8')
  const pick = (name) => {
    const m = text.match(new RegExp('^export\\s+const\\s+' + name + "\\s*=\\s*(['\"])([^'\"]*)\\1", 'm'))
    return m === null ? undefined : m[2]
  }
  return { file, id: pick('PLUGIN_ID'), version: pick('VERSION'), slot: pick('SETTINGS_SLOT') }
}

/** Resolve a relative specifier against the importer's directory, then the roots. */
function resolveSource(spec, fromDir) {
  if (!spec.startsWith('.')) return undefined
  for (const base of [fromDir, WORK, UPSTREAM_ENGINE, UPSTREAM_SRC]) {
    const candidate = resolve(base, spec)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * The bundle-local key for one module: specifier basename minus its extension.
 *
 * Any extension is stripped, not just the JavaScript ones. The loader uses the
 * same rule (see the `basename(file).replace(/\.[^.]+$/, '')` in `collect`), and
 * the two MUST agree: a source published under `nodes.body.md` while its import
 * was rewritten to `__mods["nodes.body"]` produced
 * "Cannot destructure property 'installNodes' of '__mods.nodes.body.md' as it is
 * undefined" when the bundle materialized. Text modules loaded for inlining
 * (`nodes.body.md`) are the case that exposed it.
 */
const keyOf = (spec) => basename(spec).replace(/\.[^.]+$/, '')

/* Implementation note. */

/** Relative (package-root-based, forward-slashed) key for build-time inlining. */
const fileKey = (abs) => relative(REPO, abs).split('\\').join('/')

// Vendor source is preserved verbatim on disk, but non-English implementation
// comments are removed from the browser payload. Strings and theme data remain.
function sanitizeInlineModule(source) {
  let output = ''
  let index = 0
  let quote = null
  let escaped = false
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (quote !== null) {
      output += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = null
      index++
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      output += char
      index++
      continue
    }
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index)
      const stop = end === -1 ? source.length : end
      const comment = source.slice(index, stop)
      output += /[^\x00-\x7f]/.test(comment) ? '// Vendor implementation note.' : comment
      index = stop
      continue
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2)
      const stop = end === -1 ? source.length : end + 2
      const comment = source.slice(index, stop)
      if (/[^\x00-\x7f]/.test(comment)) {
        const lines = comment.match(/\r?\n/g) || []
        output += '/* Vendor implementation note.' + lines.join('') + ' */'
      } else output += comment
      index = stop
      continue
    }
    output += char
    index++
  }
  return output
    .split(/(\r?\n)/)
    .map((line) => {
      if (/^\r?\n$/.test(line) || !/[^\x00-\x7f]/.test(line)) return line
      if (/^\s*\/\//.test(line)) return line.replace(/^(\s*).*/, '$1// Vendor implementation note.')
      if (/^\s*\/\*/.test(line)) {
        const indent = line.match(/^\s*/)[0]
        return indent + (line.includes('*/') ? '/* Vendor implementation note. */' : '/* Vendor implementation note.')
      }
      if (/^\s*\*/.test(line)) {
        const indent = line.match(/^\s*/)[0]
        return indent + ' * Vendor implementation note.' + (line.includes('*/') ? ' */' : '')
      }
      line = line.replace(/\/\*[^\r\n]*?\*\//g, (comment) =>
        /[^\x00-\x7f]/.test(comment) ? '/* Vendor implementation note. */' : comment)
      const marker = line.search(/(^|\s)\/\//)
      if (marker >= 0 && /[^\x00-\x7f]/.test(line.slice(marker))) {
        return line.slice(0, marker) + (line[marker] === '/' ? '' : line[marker]) + '// Vendor implementation note.'
      }
      return line
    })
    .join('')
}

/** Recursively collect the text files the shimmed `fs` should answer for. */
async function collectInlineFiles() {
  const table = new Map()
  const skipped = []

  const walk = async (dir) => {
    let items
    try {
      items = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      if (item.name === 'node_modules' || item.name === '.git') continue
      // Fonts are compiled as a module; no runtime fs read needs this second copy.
      if (item.name === 'font-face.mjs') continue
      const abs = join(dir, item.name)
      if (item.isDirectory()) {
        await walk(abs)
        continue
      }
      const ext = item.name.slice(item.name.lastIndexOf('.'))
      // The browser runtime reads only theme JSON. Engine modules, notices, and
      // authored sources are build/test inputs and must not become FILES payload.
      if (ext !== '.json') continue
      const info = await stat(abs)
      if (info.size > 4 * 1024 * 1024) {
        skipped.push(fileKey(abs) + ' (' + info.size + ' B, too large)')
        continue
      }
      table.set(fileKey(abs), await readFile(abs, 'utf8'))
    }
  }

  await walk(UPSTREAM_SRC)
  return { table, skipped }
}

/**
 * The injected `__node` shim. Small on purpose: only what the sources use, and
 * an `fs` that throws loudly for anything the build did not inline.
 * @param table - `repoRelativePath -> text`.
 * @returns the shim source.
 */
function nodeShim(table) {
  return [
    'var __node = (function () {',
    '  var FILES = ' + JSON.stringify(Object.fromEntries(table)) + ';',
    '  function norm(p) {',
    "    var s = String(p).split('\\\\').join('/');",
    "    var i = s.indexOf('/cdsh/');",
    "    if (i >= 0) return s.slice(i + '/cdsh/'.length);",
    '    return s;',
    '  }',
    '  function normalize(p) {',
    "    var s = String(p).split('\\\\').join('/');",
    "    var abs = s.charAt(0) === '/';",
    "    var parts = s.split('/');",
    '    var out = [];',
    '    for (var i = 0; i < parts.length; i++) {',
    '      var seg = parts[i];',
    "      if (seg === '' || seg === '.') continue;",
    "      if (seg === '..') {",
    "        if (out.length && out[out.length - 1] !== '..') out.pop();",
    "        else if (!abs) out.push('..');",
    '        continue;',
    '      }',
    '      out.push(seg);',
    '    }',
    "    return (abs ? '/' : '') + out.join('/');",
    '  }',
    '  var path = {',
    '    normalize: normalize,',
    '    join: function () { var a = []; for (var i = 0; i < arguments.length; i++) a.push(String(arguments[i])); return normalize(a.join("/")); },',
    '    resolve: function () { var a = []; for (var i = 0; i < arguments.length; i++) a.push(String(arguments[i])); return normalize(a.join("/")); },',
    '    dirname: function (p) {',
    "      var s = normalize(p); var i = s.lastIndexOf('/');",
    "      if (i < 0) return '.';",
    "      if (i === 0) return '/';",
    '      return s.slice(0, i);',
    '    },',
    '    basename: function (p) { var s = normalize(p); var i = s.lastIndexOf("/"); return i < 0 ? s : s.slice(i + 1); },',
    "    extname: function (p) { var b = path.basename(p); var i = b.lastIndexOf('.'); return i <= 0 ? '' : b.slice(i); },",
    "    sep: '/'",
    '  };',
    '  var fs = {',
    '    existsSync: function (p) { return Object.prototype.hasOwnProperty.call(FILES, norm(p)); },',
    '    readFileSync: function (p) {',
    '      var k = norm(p);',
    '      if (!Object.prototype.hasOwnProperty.call(FILES, k)) {',
    "        throw new Error('regional-palette bundle: readFileSync(' + String(p) + ') is not inlined at build time (key \"' + k + '\") — see scripts/build.mjs, NODE-ONLY SOURCES');",
    '      }',
    '      return FILES[k];',
    '    },',
    '    readdirSync: function (p) {',
    '      var k = norm(p).replace(/\\/$/, "") + "/";',
    '      var out = [];',
    '      for (var key in FILES) {',
    '        if (key.indexOf(k) === 0 && key.slice(k.length).indexOf("/") < 0) out.push(key.slice(k.length));',
    '      }',
    '      return out;',
    '    }',
    '  };',
    '  function fileURLToPath(u) {',
    "    var s = String(u).replace(/^file:\\/\\//, '');",
    '    try { s = decodeURIComponent(s); } catch (e) { /* already decoded */ }',
    "    return s.replace(/^\\/([A-Za-z]:)/, '$1');",
    '  }',
    "  return { fs: fs, path: path, url: { fileURLToPath: fileURLToPath }, fileURLToPath: fileURLToPath, process: { version: 'browser', platform: 'web', argv: [], env: {} } };",
    '})();',
  ].join('\n')
}

/* Implementation note. */

/**
 * Read and rewrite one ESM module into flat CJS-in-closure form.
 *
 * @param file - absolute path of the source module.
 * @param source - raw text, pre-read by the caller so gates can scan it.
 * @param opts - parsed CLI options.
 * @returns the transformed body, exports, imports, and per-module notes.
 */
function flatten(file, source, opts) {
  const key = basename(file).replace(/\.[^.]+$/, '')
  const dir = dirname(file)
  const notes = []
  const body = []
  const exports = []
  const imports = []
  const nodeBindings = []
  const dropped = []

  if (opts.noNodeShim && /^\s*import\s[^\n]*from\s*['"](?:node:[^'"]+|fs|path|url|os)['"]/m.test(source)) {
    die('--no-node-shim: this source imports a Node builtin', [
      key + '.mjs imports a node: builtin, which a classic-script bundle cannot resolve.',
      'Without the shim the module must be browser-clean — move the file-reading part behind an',
      'inlined data table (see scripts/build.mjs, NODE-ONLY SOURCES) or drop the import.',
    ])
  }

  // Use a stable virtual URL so generated output never captures a developer machine path.
  // The Node shim maps /cdsh/<package-relative path> back to its inlined file key.
  const virtualUrl = 'file:///cdsh/' + fileKey(file)
  let text = source.split('import.meta.url').join(JSON.stringify(virtualUrl))
  if (/\bimport\.meta\b/.test(text)) {
    die('unsupported import.meta usage', [key + '.mjs uses import.meta in a form the builder does not substitute', 'only import.meta.url is supported'])
  }

  // A shebang is legal at the top of a Node ESM file and illegal anywhere else,
  // so it must not survive into the middle of a bundle.
  if (text.startsWith('#!')) {
    text = text.slice(text.indexOf('\n'))
    notes.push('dropped the `#!` shebang line (Node-only entry marker)')
  }

  let lines = text.split(/\r?\n/)

  // Node-only CLI tail: from the first top-level `invokedDirectly` marker to EOF.
  if (!opts.keepTail) {
    const cut = lines.findIndex((line) => DEFAULT_TAIL_MARKER.test(line))
    if (cut >= 0) {
      dropped.push('cut the Node-only CLI tail: lines ' + (cut + 1) + '-' + lines.length + ' (' + (lines.length - cut) + ' lines)')
      lines = lines.slice(0, cut)
    }
  }

  lines.forEach((line, index) => {
    const where = key + '.mjs:' + String(index + 1)

    let m = line.match(RE_IMPORT_JSON)
    if (m !== null) {
      const target = resolveSource(m[2], dir)
      if (target === undefined) die('cannot resolve ' + m[2], ['imported by ' + where])
      imports.push({ kind: 'json', names: [m[1]], spec: m[2], file: target, key: keyOf(m[2]) })
      body.push(MARK_JSON + JSON.stringify({ key: keyOf(m[2]), name: m[1], spec: m[2] }))
      return
    }

    m = line.match(RE_IMPORT_NAMED)
    if (m !== null) {
      const names = m[1].split(',').map((s) => s.trim()).filter(Boolean)
      if (names.some((n) => n.includes(' as '))) {
        die('import aliasing is not supported', [where + ': ' + line.trim(), 'rewrite `import { a as b }` by hand'])
      }
      const builtin = nodeBuiltinOf(m[2])
      if (builtin !== undefined) {
        nodeBindings.push({ names, from: builtin, named: true })
        return
      }
      imports.push({ kind: specKind(m[2]), names, spec: m[2], file: resolveSource(m[2], dir), key: keyOf(m[2]) })
      body.push(MARK_IMPORT + JSON.stringify({ key: keyOf(m[2]), names, spec: m[2] }))
      return
    }

    m = line.match(RE_IMPORT_NS)
    if (m !== null) {
      const builtin = nodeBuiltinOf(m[2])
      if (builtin !== undefined) {
        nodeBindings.push({ names: [m[1]], from: builtin })
        return
      }
      die('namespace imports are not supported', [where + ': ' + line.trim(), 'use named imports: import { a, b } from …'])
    }

    m = line.match(RE_IMPORT_DEFAULT)
    if (m !== null) {
      const builtin = nodeBuiltinOf(m[2])
      if (builtin !== undefined) {
        nodeBindings.push({ names: [m[1]], from: builtin })
        return
      }
      die('default imports are not supported', [where + ': ' + line.trim(), 'the module contract allows named imports only (node: builtins are exempt)'])
    }

    m = line.match(RE_EXPORT_DEFAULT_ID)
    if (m !== null) {
      notes.push('dropped `export default ' + m[1] + '` at line ' + String(index + 1) + ' (standalone-Node convenience; the bundle uses named exports)')
      return
    }

    if (RE_FORBIDDEN.test(line)) {
      die('forbidden module syntax', [
        where + ': ' + line.trim(),
        'Not allowed: export default <expression>, export { … }, export * from, a line-initial dynamic import(…),',
        'bare `import "x"`, multi-line import/export, TypeScript syntax in a .mjs source.',
        'See the SOURCE CONTRACT at the top of scripts/build.mjs.',
      ])
    }

    m = line.match(RE_EXPORT_FN) ?? line.match(RE_EXPORT_VAR) ?? line.match(RE_EXPORT_CLASS)
    if (m !== null) {
      exports.push(m[1])
      body.push(line.replace(/^export\s+/, ''))
      return
    }

    if (/^export\b/.test(line)) {
      die('unsupported export form', [
        where + ': ' + line.trim(),
        'Supported: `export function name`, `export async function name`, `export const name`,',
        '`export let/var name`, `export class Name` — one name per line, starting at column 0.',
      ])
    }

    body.push(line)
  })

  const preamble = []
  if (nodeBindings.length > 0) {
    preamble.push('/* node: builtins, bound to the injected __node shim by scripts/build.mjs */')
    for (const b of nodeBindings) {
      for (const name of b.names) {
        if (new RegExp('(?:^|[^\\w$.])' + name + '\\s*=').test(text)) {
          die('node: import binding is reassigned', [key + '.mjs declares `' + name + '` from node:' + b.from + ' and also assigns to it'])
        }
      }
      preamble.push(b.named === true ? 'const { ' + b.names.join(', ') + ' } = __node.' + b.from + ';' : 'const ' + b.names[0] + ' = __node.' + b.from + ';')
    }
    notes.push('bound ' + nodeBindings.map((b) => (b.named === true ? '{ ' + b.names.join(', ') + ' }' : b.names[0]) + ' from node:' + b.from).join(', '))
  }
  if (/\bprocess\./.test(text) && !/\b(?:const|let|var|function)\s+process\b/.test(text)) {
    preamble.push('const process = __node.process;')
    notes.push('bound `process` to __node.process')
  }

  return { key, file, body: preamble.concat(body), exports, imports, notes, dropped }
}

/** Classify one import specifier. */
function specKind(spec) {
  return spec.startsWith('.') ? 'relative' : 'bare'
}

/** `node:fs` / `fs` -> the shim member name, or undefined for a normal specifier. */
function nodeBuiltinOf(spec) {
  const bare = spec.startsWith('node:') ? spec.slice(5) : spec
  if (spec.startsWith('node:')) {
    if (!NODE_BUILTINS.has(bare)) die('unsupported node: builtin `' + spec + '`', ['the shim covers: ' + [...NODE_BUILTINS].map((n) => 'node:' + n).join(', ')])
    return bare
  }
  return undefined
}

/* Implementation note. */

/* Implementation note.







 */
function orderModules(entries, order) {
  const out = []
  const state = new Map()

  const visit = (key, path) => {
    const mark = state.get(key)
    if (mark === 'done') return
    if (mark === 'open') {
      die('import cycle in the bundle', [
        [...path, key].join(' -> '),
        'Closure-form CJS cannot deliver partial exports, so a cycle is fatal.',
        'Break it by moving the shared value into a third module.',
      ])
    }
    const mod = entries.get(key)
    if (mod === undefined) return
    state.set(key, 'open')
    for (const imp of mod.imports) {
      if (imp.kind === 'relative' || imp.kind === 'json') visit(imp.key, [...path, key])
    }
    state.set(key, 'done')
    out.push(key)
  }

  for (const key of order) visit(key, [])
  for (const key of entries.keys()) visit(key, [])
  return out
}

/* Implementation note. */

/** Marker prefixes for rewritten line kinds; the slice offsets must match. */
const MARK_JSON = '/*!json*/'
const MARK_IMPORT = '/*!import*/'

/**
 * Render one module as the IIFE the bundle executes.
 * @param mod - flattened module.
 * @param json - `key -> raw JSON text` for inlined data imports.
 * @param allowed - bare specifiers that resolve without a graph row.
 * @returns the IIFE source.
 */
function emitModule(mod, json, allowed) {
  const body = []
  for (const line of mod.body) {
    if (line.startsWith(MARK_JSON)) {
      const { key, name, spec } = JSON.parse(line.slice(MARK_JSON.length))
      if (!json.has(key)) missingImport(spec, mod, 'json data')
      body.push('const ' + name + ' = ' + json.get(key).trim())
      continue
    }
    if (line.startsWith(MARK_IMPORT)) {
      const { key, names, spec } = JSON.parse(line.slice(MARK_IMPORT.length))
      const list = names.join(', ')
      if (spec.startsWith('.')) {
        body.push('const { ' + list + ' } = __mods[' + JSON.stringify(key) + ']')
      } else if (allowed.has(spec)) {
        body.push('const { ' + list + ' } = require(' + JSON.stringify(spec) + ')')
      } else {
        const pkg = spec.replace(/\/client$/, '')
        if (!allowed.has(pkg)) {
          const next = [...new Set([...DEFAULT_CLIENT_INJECT, pkg])].join(',')
          die('require(' + JSON.stringify(spec) + ') cannot resolve at runtime', [
            mod.key + '.mjs imports ' + JSON.stringify(spec) + ', which is neither a platform seed word nor a declared package edge.',
            'Seed words: ' + SEED_WORDS.join(', '),
            'Fix: declare the package edge — node scripts/build.mjs --inject=' + next,
          ])
        }
        body.push('const { ' + list + ' } = require(' + JSON.stringify(pkg + '/client') + ')')
      }
      continue
    }
    body.push(line)
  }
  if (mod.exports.length > 0) {
    body.push('__mods[' + JSON.stringify(mod.key) + '] = { ' + mod.exports.join(', ') + ' }')
  }
  // The leading semicolon is load-bearing. The previous statement may be a
  // publication line with no trailing `;`, and without the guard the `(` of the
  // Implementation note.
  // "{} is not a function", the v1.2.0 bundle-loading failure upstream records
  // in scripts/build-client.mjs. Never remove it.
  return ';(function () {\n' + body.join('\n') + '\n})();'
}

function missingImport(spec, mod, kind) {
  die('cannot resolve a ' + kind + ' import', [
    mod.key + '.mjs imports ' + JSON.stringify(spec),
    'looked in: the importing directory, src/, vendor/dsh-opencode-palette/src/engine/, vendor/dsh-opencode-palette/src/',
  ])
}

/* Implementation note. */

function packageJson(opts, clientInject) {
  return {
    name: opts.name,
    version: opts.version,
    description:
      'CDSH (Custom DSH): safe regional theming for DeepSeek Harness with 38 colour themes, an optional run workspace, and no host-layout rewrites.',
    type: 'module',
    main: 'lib/index.js',
    exports: {
      '.': './lib/index.js',
      './client': './lib/client.js',
      './cordis.patch.yml': './cordis.patch.yml',
      './package.json': './package.json',
    },
    files: ['lib', 'cordis.patch.yml'],
    keywords: ['dsh', 'deepseek-harness', 'plugin', 'theme', 'regional', 'cdsh'],
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      client: {
        platform: 'web',
        immediately: true,
        inject: clientInject,
      },
    },
    license: 'MIT',
  }
}

function patchYml(opts) {
  return [
    '# ' + opts.name + ' bundle layer — inserts the plugin row.',
    '#',
    '# Written by scripts/build.mjs (v' + opts.version + '); regenerate rather than hand-edit.',
    '# Applied automatically when a DSH profile installs this directory as a bundle.',
    '#',
    '# The row id must be unique across the whole composed loader config:',
    '# cordis-plugin-loader throws `duplicate loader entry id` and the profile fails to boot',
    '# if two layers insert the same id. See README.md.',
    '- insert:',
    '    - id: ' + opts.rowId,
    "      name: '" + opts.name + "'",
    '      config: {}',
    '',
  ].join('\n')
}

function hostHalf(opts) {
  return [
    '/**',
    ' * ' + opts.name + ' v' + opts.version + ' — host half (no-op).',
    ' *',
    ' * Every bit of work happens in the browser half (./client.js):',
    ' *   - region -> theme resolution and CSS emission,',
    ' *   - region-scoped <style> injection under data-plugin ownership,',
    ' *   - the settings panel.',
    ' * The host half exists so the loader row resolves and mounts.',
    ' */',
    'export const name = ' + JSON.stringify(opts.name),
    '',
    'export function apply() {',
    '  // no-op: the client half owns everything',
    '}',
    '',
  ].join('\n')
}

function virtualEnv(opts) {
  return [
    '/* virtual module injected by scripts/build.mjs — do not create src/env.mjs */',
    'const PLUGIN_ID = ' + JSON.stringify(opts.name),
    'const VERSION = ' + JSON.stringify(opts.version),
    'const SETTINGS_SLOT = ' + JSON.stringify(SETTINGS_SLOT),
    '__mods["env"] = { PLUGIN_ID, VERSION, SETTINGS_SLOT };',
    '',
  ].join('\n')
}

/**
 * The light build's stand-in for the optional font payload module. `@font-face`
 * with embedded woff2 is ~460 KB, and the runtime already understands
 * `createClient({ fontFaces: false })`, so a distributable build can drop the
 * bytes instead of shipping them to every user.
 *
 * @param exportNames - exports the real module would publish (or the defaults).
 * @returns a flattened-module shape with the payload replaced by empty values.
 */
function fontFaceStub(exportNames) {
  const names = exportNames.length > 0 ? exportNames : FONT_FACE_EXPORTS
  const valueFor = (name) => {
    if (/CSS$/.test(name)) return '""'
    if (/FONTS$|FAMILIES$|STACK$|LIST$/.test(name)) return '[]'
    return 'null'
  }
  return {
    key: 'font-face',
    file: '(stub)',
    body: [
      '/* light build (--no-fonts): the @font-face payload is not bundled.',
      '   Every export keeps its name and shape, so the runtime wiring is unchanged;',
      '   the entry additionally passes fontFaces: false. */',
      ...names.map((name) => 'const ' + name + ' = ' + valueFor(name)),
    ],
    exports: [...names],
    imports: [],
    notes: [],
    dropped: [],
  }
}

/* Implementation note. */

/**
 * Read the source files, run the gates, and flatten everything.
 * @param root - directory holding the source modules.
 * @param opts - parsed CLI options.
 * @returns `{ entries, json, findings, notes }`.
 */
async function collect(root, opts) {
  const entries = new Map()
  const json = new Map()
  const findings = []
  const notes = []
  const seenAt = new Map()

  const load = async (file) => {
    const key = basename(file).replace(/\.[^.]+$/, '')
    const previous = seenAt.get(key)
    if (previous !== undefined && previous !== file) {
      die('two source files share the basename ' + JSON.stringify(key), [previous, file, 'module keys must be unique — rename one of them'])
    }
    if (entries.has(key)) return
    seenAt.set(key, file)
    const raw = await readFile(file, 'utf8')
    const rel = file.startsWith(root) ? file.slice(root.length + 1) : file.slice(REPO.length + 1)
    scanGates(rel, raw, file.startsWith(root), findings, opts)
    const mod = flatten(file, sanitizeInlineModule(raw), opts)
    for (const note of mod.notes) notes.push(rel + ': ' + note)
    for (const note of mod.dropped) notes.push(rel + ': ' + note)
    entries.set(key, mod)
    for (const imp of mod.imports) {
      if (imp.kind === 'json') {
        json.set(imp.key, await readFile(imp.file, 'utf8'))
      } else if (imp.kind === 'relative') {
        // `./env.mjs` is virtual: scripts/build.mjs emits it, no file exists.
        if (imp.file === undefined && imp.key === 'env') continue
        // `./font-face.mjs` is virtual under --no-fonts (stub registered above).
        if (imp.file === undefined && imp.key === 'font-face' && opts.noFonts) continue
        if (imp.file === undefined) {
          if (imp.key === 'font-face') {
            die('font-face.mjs is missing', [
              '.' + '/' + 'font-face.mjs' + ' is imported by ' + mod.key + '.mjs but does not exist.',
              '',
              'Either the font module is still being written, or you want the light build:',
              '  node scripts/build.mjs --no-fonts   (stubs the module: FONT_FACE_CSS = "", BUNDLED_FONTS = [],',
              '                                    and passes fontFaces: false to the runtime)',
            ])
          }
          missingImport(imp.spec, mod, 'module')
        }
        await load(imp.file)
      }
    }
  }

  for (const stem of STEMS) {
    const file = join(root, stem + '.mjs')
    if (existsSync(file)) await load(file)
    else if (opts.noFonts && stem === 'font-face') {
      const stub = fontFaceStub(FONT_FACE_EXPORTS)
      entries.set('font-face', stub)
      notes.push('font-face.mjs is absent; --no-fonts supplied a stub (' + stub.exports.join(', ') + ')')
    }
  }

  // --no-fonts with the real module present: keep its export NAMES, drop its bytes.
  if (opts.noFonts && existsSync(join(root, 'font-face.mjs'))) {
    const real = entries.get('font-face')
    const stub = fontFaceStub(real.exports)
    entries.set('font-face', stub)
    notes.push('--no-fonts: font-face.mjs is stubbed; exports kept as ' + stub.exports.join(', ') + ' (payload dropped)')
  }
  return { entries, json, findings, notes }
}

/**
 * Blank out comments while preserving every newline, so gate line numbers stay
 * valid. Deliberately not a full JS lexer: regex literals are treated as code,
 * which can only make the gate see MORE text, never less.
 * @param text - source text.
 * @returns the same text with comment bodies replaced by spaces.
 */
function stripComments(text) {
  let out = ''
  let state = 'code'
  let i = 0
  while (i < text.length) {
    const c = text[i]
    const d = text[i + 1]
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; out += '  '; i += 2; continue }
      if (c === '/' && d === '*') { state = 'block'; out += '  '; i += 2; continue }
      if (c === "'" || c === '"' || c === '`') state = c
      out += c
      i++
      continue
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c } else out += ' '
      i++
      continue
    }
    if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; out += '  '; i += 2; continue }
      out += c === '\n' ? '\n' : ' '
      i++
      continue
    }
    // Inside a string literal.
    if (c === '\\') { out += c + (d ?? ''); i += 2; continue }
    if (c === state) state = 'code'
    out += c
    i++
  }
  return out
}

/* Implementation note.



 */
const ASSERTION_RE = /\b(?:check[A-Z]\w*|checkValue|assert\w*|expect)\s*\(|\bt\.push\s*\(|\bproblems\.push\s*\(|\berrors\.push\s*\(/

/* Implementation note. */
function scanGates(rel, text, hard, findings, opts) {
  if (!opts.gate) return
  const lines = stripComments(text).split(/\r?\n/)
  for (const rule of GATES) {
    lines.forEach((line, index) => {
      rule.re.lastIndex = 0
      if (!rule.re.test(line)) return
      const assertion = ASSERTION_RE.test(line)
      const excepted = rule.except !== undefined && rule.except.test(line)
      let severity
      if (assertion) severity = 'note'
      else if (excepted) severity = 'note'
      else if (rule.escalate === false) severity = 'warn'
      else severity = (rule.hard && hard) || opts.strict ? 'error' : 'warn'
      findings.push({
        rule: rule.id,
        severity,
        file: rel,
        line: index + 1,
        text: line.trim().slice(0, 160),
        why: assertion
          ? 'assertion context — the line tests that this pattern is rejected, it does not emit it'
          : excepted
            ? 'excepted: document-wide typography is the intended font axis (PLAN sec.3.2)'
            : undefined,
        what: rule.what,
        fix: rule.fix,
      })
    })
  }
}

function reportGate(findings) {
  if (findings.length === 0) {
    log('[build] gate: clean (' + GATES.map((g) => g.id).join(', ') + ')')
    return
  }
  for (const f of findings) {
    log('[build] gate ' + f.severity.toUpperCase() + ' ' + f.rule + ' ' + f.file + ':' + f.line)
    log('          ' + f.text)
    if (f.why !== undefined) log('          ' + f.why)
    log('          ' + f.what)
    if (f.severity !== 'note') log('          fix: ' + f.fix)
  }
}

/* Implementation note. */

/**
 * Compose the client entry: the one place where the three independently
 * authored modules are joined. Everything here goes through their public
 * exports, so no agent's internal logic is rewritten.
 *
 * @param entries - `key -> module` map.
 * @param opts - parsed CLI options.
 * @returns `{ source, notes, used }`.
 */
function buildEntry(entries, opts) {
  const notes = []
  const used = new Set()
  const runtime = entries.get('runtime')
  if (runtime === undefined) {
    die('runtime.mjs is missing', ['the client plugin entry lives there — see the SOURCE CONTRACT in scripts/build.mjs'])
  }

  const requested = opts.entry
  const candidates = requested === undefined ? ENTRY_CANDIDATES : [requested]
  const entry = candidates.find((name) => runtime.exports.includes(name))
  if (entry === undefined) {
    die('runtime.mjs exports no usable entry point', [
      'looked for: ' + candidates.join(', '),
      'found: ' + (runtime.exports.join(', ') || '(nothing exported)'),
      'The entry must be a factory taking the settings slot id (or an options object) and returning apply(ctx).',
      'Name it createClient, or pass --entry=<name>.',
    ])
  }

  const gen = entries.get('generate-regions')
  const genOk = gen !== undefined && gen.exports.includes('generateRegionCss')
  const panel = entries.get('panel')
  const panelOk = panel !== undefined && panel.exports.includes('registerPanel')
  // Native DSH owns chat/tool rendering; the plugin supplies presentation only.
  // Implementation note.
  // and its stem key is the file name itself.
  const designBody = entries.get('design')
  const designOk = designBody !== undefined && DESIGN_EXPORTS.every((n) => designBody.exports.includes(n))

  const lines = ['{']
  if (requested === undefined) {
    lines.push('  slotTarget: ' + JSON.stringify(opts.slot) + ',')
  }
  if (opts.noFonts) {
    const runtimeText = runtime.body.join('\n')
    if (/\bfontFaces\b/.test(runtimeText)) {
      lines.push('  fontFaces: false,')
      notes.push('light build: fontFaces: false is passed to createClient, so the @font-face layer is skipped as well as unbundled')
    } else {
      notes.push(
        'LIGHT BUILD WITHOUT A RUNTIME SWITCH: runtime.mjs never mentions `fontFaces`, so the entry cannot turn the font layer off. ' +
          'The payload is gone from the bundle, but FONT_FACE_CSS resolves to "" — make sure the runtime treats that as "no fonts".'
      )
    }
  }
  if (genOk) {
    lines.push('  generator: __mods[' + JSON.stringify('generate-regions') + '],')
    used.add('generate-regions')
    notes.push('wired generator: generate-regions.mjs is passed to createClient as `generator` (the runtime\'s applyModule picks generateRegionCss and friends)')
  } else {
    notes.push(
      'GENERATOR NOT WIRED: ' +
        (gen === undefined ? 'src/generate-regions.mjs is not present' : 'generate-regions.mjs exports no generateRegionCss') +
        ' — the runtime falls back to its stub, and its dynamic-import path cannot resolve from a classic-script bundle'
    )
  }
  if (panelOk) {
    lines.push('  panel: function (api, ctx) {')
    lines.push('    return __mods[' + JSON.stringify('panel') + '].registerPanel(ctx, {')
    lines.push('      api: api,')
    lines.push('      slot: ' + JSON.stringify(opts.slot) + ',')
    lines.push('      id: ' + JSON.stringify(opts.rowId) + ',')
    lines.push('      tr: typeof api.tr === "function" ? api.tr : undefined')
    lines.push('    })')
    lines.push('  },')
    used.add('panel')
    notes.push('wired panel: panel.mjs#registerPanel adapted to the runtime `panel(api, ctx) -> disposer` contract')
  } else {
    notes.push(
      'PANEL NOT WIRED: ' +
        (panel === undefined ? 'src/panel.mjs is not present' : 'panel.mjs exports no registerPanel') +
        ' — the client will run without a settings surface'
    )
  }
  if (designOk) {
    lines.push('  designCss: __mods[' + JSON.stringify('design') + '].designCss,')
    used.add('design')
    notes.push('wired design: owned workspace CSS plus a grouped-process-only tool grid; message/tool renderers stay native')
  } else {
    notes.push(
      'DESIGN NOT WIRED: ' +
        (designBody === undefined ? 'src/design.mjs is not present' : designBody.exports.join(', ') + ' — no designCss') +
        ' — the interface keeps the renderer styles only: no tokens, no depth, no motion'
    )
  }
  const workspace = entries.get('workspace')
  if (workspace?.exports.includes('installBrand') && workspace?.exports.includes('installWorkspace')) {
    lines.push('  brand: function (ctx, api) { return __mods["workspace"].installBrand(ctx, api, require("react")); },')
    lines.push('  workspace: function (ctx, api) { return __mods["workspace"].installWorkspace(ctx, api, require("react")); },')
    used.add('workspace')
    notes.push('wired brand and workspace as independent feature-scoped native contributions')
  } else {
    die('workspace.mjs must export installBrand and installWorkspace')
  }
  const enhancements = entries.get('enhancements')
  if (enhancements?.exports.includes('installTurnInsights') && enhancements?.exports.includes('installPlanCopy') && enhancements?.exports.includes('installFocusView')) {
    lines.push('  turnInsights: function (ctx, api) { return __mods["enhancements"].installTurnInsights(ctx, api, require("react")); },')
    lines.push('  planCopy: function (ctx, api) { return __mods["enhancements"].installPlanCopy(ctx, api, require("react")); },')
    lines.push('  focusView: function (ctx, api) { return __mods["enhancements"].installFocusView(ctx, api, require("react")); },')
    used.add('enhancements')
    notes.push('wired additive Turn Insights, Copy Plan, and optional CDSH Focus view')
  } else {
    die('enhancements.mjs must export installTurnInsights, installPlanCopy, and installFocusView')
  }
  lines.push('  times: false,')
  notes.push('legacy flat-flow timing observers stay disabled; CDSH uses the grouped-process-scoped tool-motion adapter')
  lines.push('}')

  return { source: lines.join('\n'), notes, used, entry }
}

/* Implementation note. */

/**
 * Turn flattened modules into the two distributable forms.
 * @param order - emission order of module keys.
 * @param entries - `key -> module`.
 * @param json - inlined JSON sources.
 * @param opts - parsed CLI options.
 * @param inline - build-time file table for the node shim.
 * @returns the bundles plus the wiring facts.
 */
function emit(order, entries, json, opts, inline) {
  const clientInject = opts.inject ?? DEFAULT_CLIENT_INJECT
  const allowed = new Set([...SEED_WORDS, ...clientInject])
  const wiring = buildEntry(entries, opts)
  if (entries.has('runtime')) wiring.used.add('runtime')

  const parts = []
  if (inline.table.size > 0) {
    parts.push(nodeShim(inline.table))
    parts.push('')
  }
  // A real src/env.mjs publishes `__mods["env"]` itself; the virtual module is
  // only a fallback so a build can run while the file is still being written.
  if (!entries.has('env')) parts.push(virtualEnv(opts))
  for (const key of order) {
    parts.push(emitModule(entries.get(key), json, allowed))
    parts.push('')
  }
  const modules = parts.join('\n').split('__PALETTE_VERSION__').join(opts.version)

  const cordisInject = DEFAULT_CORDIS_INJECT
  const entryCall = '__mods["runtime"][' + JSON.stringify(wiring.entry) + '](' + wiring.source + ')'

  const pkgBundle =
    [
      '/**',
      ' * ' + opts.name + ' v' + opts.version + ' — browser half (build artifact, do not edit).',
      ' * Sources: src/' + STEMS.join('.mjs + src/') + '.mjs',
      ' * Regenerate: node scripts/build.mjs',
      ' */',
      'window.__ModuleLoader__.load({',
      '  id: ' + JSON.stringify(opts.name) + ',',
      '  factory: function (require) {',
      '    var module = { exports: {} };',
      '    var exports = module.exports;',
      '    Object.defineProperty(exports, Symbol.toStringTag, { value: ' + JSON.stringify('Module') + ' });',
      '    var __mods = {};',
      modules,
      '    var __client = ' + entryCall + ';',
      '    exports.inject = ' + JSON.stringify(cordisInject) + ';',
      '    exports.apply = function (ctx) {',
      '      var apply = typeof __client === "function" ? __client : __client.apply;',
      '      apply(ctx);',
      '    };',
      '    return module.exports;',
      '  },',
      '})',
      '',
    ].join('\n')

  const dynBundle =
    [
      '// ' + opts.name + ' v' + opts.version + ' — dynamic form (build artifact, do not edit).',
      '// Usage: cordis_define(code.client = this file), then cordis_run.',
      'var __mods = {};',
      modules,
      'var __client = ' + entryCall + ';',
      'return { inject: ' + JSON.stringify(cordisInject) + ', apply: function (ctx) {',
      '  var apply = typeof __client === "function" ? __client : __client.apply;',
      '  apply(ctx);',
      '} };',
      '',
    ].join('\n')

  return { pkgBundle, dynBundle, cordisInject, clientInject, wiring }
}

/* Implementation note. */

async function readme(opts, clientInject) {
  return [
    '# CDSH (Custom DSH) v' + opts.version,
    '',
    'Safe regional theming for DeepSeek Harness. Instead of repainting every `--dsw-*`',
    'token on `:root`, this plugin declares theme tokens **inside a region root**',
    'and lets CSS inheritance do the scoping: a region is themed, its surroundings',
    'keep the stock appearance, and turning the plugin off leaves no trace.',
    '',
    '## Consume from a clone',
    '',
    'Point a DSH bundle resolver that accepts local npm package paths at this directory.',
    'The committed `lib` artifacts make a consumer-side build unnecessary.',
    '',
    'See the repository README for reproducible build and verification commands.',
    '',
    '## Package shape',
    '',
    '- `lib/index.js` — host half (no-op; all work is in the browser).',
    '- `lib/client.js` — browser half, loaded through `window.__ModuleLoader__.load`.',
    '- `cordis.patch.yml` — bundle layer inserting the loader row.',
    '',
    'Declared client edges: `' + clientInject.join('`, `') + '`.',
    '',
    '## Licence',
    '',
    'MIT. Theme tables are derived from dsh-opencode-palette, © FeatherHunter, MIT.',
    '',
  ].join('\n')
}

async function writePackage(pkgDir, opts, pkgBundle, clientInject, writeMetadata = true) {
  await rm(join(pkgDir, 'lib'), { recursive: true, force: true })
  await mkdir(join(pkgDir, 'lib'), { recursive: true })
  await writeFile(join(pkgDir, 'lib', 'client.js'), pkgBundle)
  await writeFile(join(pkgDir, 'lib', 'index.js'), hostHalf(opts))
  if (writeMetadata) {
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify(packageJson(opts, clientInject), null, 2) + '\n')
    await writeFile(join(pkgDir, 'cordis.patch.yml'), patchYml(opts))
    await writeFile(join(pkgDir, 'README.md'), await readme(opts, clientInject))
  }
  return pkgDir
}

/* Implementation note. */

async function main() {
  const opts = parseArgs(process.argv.slice(2))

  if (opts.mode === 'selftest') return selftest(opts)
  if (process.env.DSH_NATIVE_ROOT) log('[build] native compatibility: ' + JSON.stringify(checkNativeContracts()))
  else log('[build] native compatibility: skipped (set DSH_NATIVE_ROOT to run explicitly)')

  // src/env.mjs is the identity source of truth: the manifest name, the bundle
  // registration id and the data-plugin style marker all come from it.
  const env = await readEnvModule(opts.root)
  if (env !== undefined) {
    if (!opts.nameExplicit && env.id !== undefined) opts.name = env.id
    if (!opts.versionExplicit && env.version !== undefined) opts.version = env.version
    if (env.slot !== undefined && env.slot !== '') opts.slot = env.slot
    if (env.id !== undefined && opts.name !== env.id) {
      log('[build] WARN env.mjs declares PLUGIN_ID=' + env.id + ' but the package is named ' + opts.name)
      log('          DSH removes style[data-plugin=<package name>] on reload, so this leaves orphaned <style> tags.')
    }
    if (env.version !== undefined && opts.version !== env.version) {
      log('[build] WARN env.mjs declares VERSION=' + env.version + ' but the build version is ' + opts.version)
    }
  }

  if (opts.mode === 'check') return check(opts)

  const missing = REQUIRED_STEMS.filter((s) => !existsSync(join(opts.root, s + '.mjs')))
  if (missing.length > 0) {
    die('source modules are missing, nothing to build', [
      ...missing.map((s) => 'missing: src/' + s + '.mjs'),
      '',
      'These three files are the deliverables of agents 2-4 and the only inputs to this build:',
      '  src/generate-regions.mjs   theme + region -> CSS text        (agent 2)',
      '  src/runtime.mjs            region state, apply, dispose       (agent 3)',
      '  src/panel.mjs              settings panel                     (agent 4)',
      '',
      'Optional: src/font-face.mjs (the ~460 KB @font-face payload). Absent it, use --no-fonts.',
      '',
      'The SOURCE CONTRACT they must follow is documented at the top of scripts/build.mjs.',
      'Progress check:  node scripts/build.mjs --check',
      'Bundler check:   node scripts/build.mjs --selftest   (works with no sources present)',
    ])
  }

  const { entries, json, findings, notes } = await collect(opts.root, opts)
  reportGate(findings)
  if (findings.some((f) => f.severity === 'error')) {
    die('the gate rejected the sources', ['see the gate report above; fix the pattern or re-run with --no-gate if you are certain'])
  }
  const inline = await collectInlineFiles()
  const order = orderModules(entries, STEMS)
  const { pkgBundle, dynBundle, cordisInject, clientInject, wiring } = emit(order, entries, json, opts, inline)

  const pkgDir = opts.outputDir || PACKAGE_ROOT
  await writePackage(pkgDir, opts, pkgBundle, clientInject, false)

  log('[build] ' + opts.name + ' v' + opts.version)
  log('[build] module order: ' + order.join(' -> '))
  log('[build] entry: runtime.mjs#' + wiring.entry + '(' + (wiring.source === '{}' ? 'no options' : 'options object') + ')')
  log('[build] cordis inject (services): ' + JSON.stringify(cordisInject))
  log('[build] dsh.client.inject (packages): ' + JSON.stringify(clientInject))
  log('[build] node shim: ' + inline.table.size + ' text file(s) inlined (' + bytes(JSON.stringify(Object.fromEntries(inline.table))) + ' B of source data)')
  if (inline.skipped.length > 0) {
    const fonts = inline.skipped.filter((s) => s.endsWith('.woff2')).length
    const onlyFonts = fonts === inline.skipped.length
    log(
      '[build] node shim: ' +
        inline.skipped.length +
        ' non-text file(s) NOT inlined' +
        (fonts > 0 ? ' (' + fonts + ' woff2)' : '') +
        (onlyFonts
          ? ' — expected: the @font-face payload is embedded in src/font-face.mjs as base64 data: URIs, not read from disk.'
          : ' — a readFileSync of one throws with its exact path.')
    )
  }
  for (const stem of STEMS) {
    if (entries.has(stem) && !wiring.used.has(stem) && !order.some((k) => k !== stem && entries.get(k)?.imports.some((i) => i.key === stem))) {
      log('[build] WARN: ' + stem + '.mjs is bundled but nothing imports or wires it')
    }
  }
  for (const note of [...notes, ...wiring.notes]) log('[build] note: ' + note)

  const ownId = entries.get('runtime')?.key !== undefined ? findPluginIdLiteral(entries) : undefined
  if (ownId !== undefined && ownId !== opts.name) {
    log('')
    log('[build] WARN W5 package-name / ownership-label mismatch')
    log('          the sources tag their <style> node with data-plugin="' + ownId + '",')
    log('          but this package (and the DSH graph row) is named "' + opts.name + '".')
    log('          DSH HMR removes style[data-plugin=<package name>], so a reload of this')
    log('          plugin will not clear those tags, and a reload of "' + ownId + '" will.')
    log('          The runtime sweeps its own stale nodes, so this self-heals, but pick one:')
    log('            drop-in replacement : node scripts/build.mjs --name=' + ownId)
    log('            coexist             : change PLUGIN_ID in src/runtime.mjs to ' + opts.name)
    log('')
  }

  log('[build] wrote:')
  log('  ' + join(pkgDir, 'lib', 'index.js') + '  (' + bytes(hostHalf(opts)) + ' B)')
  log('  ' + join(pkgDir, 'lib', 'client.js') + '  (' + bytes(pkgBundle) + ' B)')
  log('[build] next: node scripts/check-publication.mjs')
}

/** The `PLUGIN_ID = '<literal>'` an entry module declares, if any. */
function findPluginIdLiteral(entries) {
  const runtime = entries.get('runtime')
  if (runtime === undefined) return undefined
  const line = runtime.body.find((l) => /^const\s+PLUGIN_ID\s*=/.test(l))
  if (line === undefined) return undefined
  const m = line.match(/=\s*['"]([^'"]+)['"]/)
  return m === null ? undefined : m[1]
}

/** Report which declared sources exist, without building anything. */
async function check(opts) {
  log('[build] source check (root: ' + opts.root + ')')
  let missing = 0
  for (const stem of STEMS) {
    const file = join(opts.root, stem + '.mjs')
    const required = REQUIRED_STEMS.includes(stem)
    if (existsSync(file)) {
      const text = await readFile(file, 'utf8')
      log('  [ok]   src/' + stem + '.mjs  (' + text.split(/\r?\n/).length + ' lines, ' + bytes(text) + ' B)')
    } else if (required) {
      missing++
      log('  [MISS] src/' + stem + '.mjs  (required)')
    } else {
      log('  [opt]  src/' + stem + '.mjs  (optional; --no-fonts stubs it)')
    }
  }
  const pkg = join(PACKAGE_ROOT, 'package.json')
  const built = existsSync(pkg)
  log('  [' + (built ? 'ok' : 'MISS') + ']   package.json' + (built ? '' : '  (restore the package manifest)'))
  log(missing === 0 ? '[build] all sources present' : '[build] ' + missing + ' source module(s) missing — the build would stop with a contract report')
  process.exit(missing === 0 ? 0 : 1)
}

/* Implementation note. */

/** Write throwaway stub sources so the bundler can be exercised with no real sources. */
async function writeStubs(dir) {
  await writeFile(
    join(dir, 'generate-regions.mjs'),
    [
      "import { PLUGIN_ID, VERSION } from './env.mjs'",
      "import path from 'node:path'",
      "import fs from 'node:fs'",
      'export const VERSION_SEEN = VERSION',
      'export const OWNER = PLUGIN_ID',
      'export function themeNames() { return ["amoled", "aura"] }',
      'export function generateRegionCss(theme, region) {',
      "  const p = path.join('vendor', 'dsh-opencode-palette', 'src', 'themes', theme + '.json')",
      '  const raw = fs.readFileSync(p)',
      '  return { css: \'[data-dsh-region="\' + region + \'"] { --dsw-alias-bg-base: #101014 }\', meta: { bytes: raw.length } }',
      '}',
      '',
    ].join('\n')
  )
  await writeFile(
    join(dir, 'panel.mjs'),
    [
      "import { themeNames } from './generate-regions.mjs'",
      'export function registerPanel(ctx, options) {',
      "  const slots = ctx && typeof ctx.get === 'function' ? ctx.get('slots') : null",
      '  if (!slots) return function () {}',
      '  return slots.inject(options.slot, function () { return null })',
      '}',
      'export function createPanelComponent() { return function Panel() { return null } }',
      'export function preview() { return themeNames().length }',
      'export default createPanelComponent',
      '',
    ].join('\n')
  )
  await writeFile(
    join(dir, 'runtime.mjs'),
    [
      'export const PLUGIN_ID = ' + JSON.stringify(DEFAULT_NAME),
      "export const PALETTE_VERSION = '__PALETTE_VERSION__'",
      'export function createClient(options) {',
      "  const opts = typeof options === 'string' ? { slotTarget: options } : (options || {})",
      '  return function apply(ctx) {',
      '    const out = { slot: opts.slotTarget, hasGenerator: !!opts.generator, hasPanel: !!opts.panel }',
      '    if (opts.generator) out.css = opts.generator.generateRegionCss("amoled", "sidebar").css',
      '    if (opts.panel) out.panelDisposer = typeof opts.panel({}, ctx)',
      '    globalThis.__cdshBuildSelftest = out',
      '    return out',
      '  }',
      '}',
      '',
    ].join('\n')
  )
  await writeFile(join(dir, 'design.mjs'), 'export function designCss() { return "" }\n')
  await writeFile(join(dir, 'workspace.mjs'), [
    'export function installBrand() { return function () {} }',
    'export function installWorkspace() { return function () {} }',
    '',
  ].join('\n'))
  await writeFile(join(dir, 'enhancements.mjs'), [
    'export function installTurnInsights() { return function () {} }',
    'export function installPlanCopy() { return function () {} }',
    'export function installFocusView() { return function () {} }',
    '',
  ].join('\n'))
}

/**
 * Prove the whole pipeline end to end against temporary stubs: flatten, order,
 * emit, write the package, then materialize the bundle in a fake module table
 * and drive the wired entry.
 */
async function selftest(opts) {
  const tmp = await mkdtemp(join(tmpdir(), 'regional-palette-selftest-'))
  const srcDir = join(tmp, 'src')
  await mkdir(srcDir, { recursive: true })
  await writeStubs(srcDir)
  const stubOpts = { ...opts, root: srcDir }

  log('[selftest] stubs written to ' + srcDir)
  const { entries, json, findings, notes } = await collect(srcDir, stubOpts)
  reportGate(findings)
  for (const note of notes) log('[selftest] note: ' + note)

  const inline = await collectInlineFiles()
  const order = orderModules(entries, STEMS)
  log('[selftest] module order: ' + order.join(' -> '))
  const { pkgBundle, dynBundle, cordisInject, clientInject, wiring } = emit(order, entries, json, stubOpts, inline)

  const checks = []
  const record = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: String(detail ?? '') })

  record('entry resolved', wiring.entry === 'createClient', 'runtime.mjs#' + wiring.entry)
  // Each module must be emitted before anything that reads it off __mods: the
  // entry call sits after every IIFE, so the real constraint is import order.
  record(
    'module order is dependency-first',
    order.indexOf('generate-regions') < order.indexOf('panel') && STEMS.every((s) => !entries.has(s) || order.includes(s)),
    order.join(' -> ')
  )
  record('generator wired', /generator:\s*__mods\["generate-regions"\]/.test(wiring.source), 'createClient receives the generator namespace')
  record('panel wired', /registerPanel\(ctx,\s*\{/.test(wiring.source), 'runtime panel(api, ctx) contract satisfied')
  record('node builtin shim inlined', inline.table.size > 0 && pkgBundle.includes('var __node ='), inline.table.size + ' file(s)')
  record('theme JSON reachable through the shim', pkgBundle.includes('vendor/dsh-opencode-palette/src/themes/amoled.json'), 'vendor/dsh-opencode-palette/src/themes/amoled.json present in the inline table')

  let syntaxError
  try {
    new Function(pkgBundle)
  } catch (e) {
    syntaxError = e
  }
  record('bundle parses', syntaxError === undefined, syntaxError === undefined ? bytes(pkgBundle) + ' B' : syntaxError.message)
  try {
    new Function(dynBundle)
    record('dynamic bundle parses', true, bytes(dynBundle) + ' B')
  } catch (e) {
    record('dynamic bundle parses', false, e.message)
  }

  // Materialize in a fake module table and drive the wired entry.
  let registration
  const previousWindow = globalThis.window
  const required = []
  globalThis.window = { __ModuleLoader__: { load: (reg) => { registration = reg } } }
  try {
    new Function(pkgBundle)()
    record('registers through window.__ModuleLoader__.load', registration !== undefined, registration === undefined ? 'no registration captured' : 'id=' + registration.id)
    record('registration id matches the package name', registration?.id === stubOpts.name, String(registration?.id))
    const exports = registration.factory((spec) => {
      required.push(spec)
      throw new Error('selftest: unexpected require(' + spec + ')')
    })
    record('exports.inject is a string array', Array.isArray(exports.inject) && exports.inject.every((s) => typeof s === 'string'), JSON.stringify(exports.inject))
    record('exports.apply is a function', typeof exports.apply === 'function', typeof exports.apply)
    record('no unexpected require() edges', required.length === 0, required.join(', ') || '(none)')

    // A minimal Cordis-shaped ctx so the wired panel path is exercised.
    const disposers = []
    const slots = {
      inject: (slot, factory) => { factory(); disposers.push(slot); return () => {} },
      register: () => () => {},
    }
    const ctx = {
      effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); return d },
      on: () => () => {},
      get: (name) => (name === 'slots' ? slots : undefined),
    }
    delete globalThis.__cdshBuildSelftest
    const outcome = exports.apply(ctx)
    const internal = globalThis.__cdshBuildSelftest
    record('Cordis 4.0.4 inject contract is exact', JSON.stringify(exports.inject) === JSON.stringify(['locale']), JSON.stringify(exports.inject))
    record('wired apply runs without exposing the internal API', outcome === undefined && internal !== undefined, 'return=' + String(outcome))
    record('generator produced region CSS through the shim', /data-dsh-region="sidebar"/.test(String(internal?.css)), String(internal?.css).slice(0, 80))
    record('panel mounted through the runtime hook', internal?.panelDisposer === 'function' && disposers.length > 0, disposers.length + ' disposer(s)')
    delete globalThis.__cdshBuildSelftest
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }

  // Exercise the real writer into a throwaway package directory.
  const pkgDir = join(tmp, 'package')
  await writePackage(pkgDir, stubOpts, pkgBundle, clientInject)
  const manifest = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'))
  record('package.json name', manifest.name === stubOpts.name, manifest.name)
  record('package.json dsh.bundle.patch', manifest.dsh?.bundle?.patch === './cordis.patch.yml', String(manifest.dsh?.bundle?.patch))
  record('package.json dsh.client.platform', manifest.dsh?.client?.platform === 'web', String(manifest.dsh?.client?.platform))
  record('package.json dsh.client.immediately', manifest.dsh?.client?.immediately === true, String(manifest.dsh?.client?.immediately))
  record('package.json dsh.client.inject is a string array', Array.isArray(manifest.dsh?.client?.inject), JSON.stringify(manifest.dsh?.client?.inject))
  record('package.json exports["./client"]', manifest.exports?.['./client'] === './lib/client.js', String(manifest.exports?.['./client']))
  record('exports["./client"] file exists', existsSync(join(pkgDir, manifest.exports['./client'])), manifest.exports['./client'])
  record('package.json files[] covers lib + patch', manifest.files?.includes('lib') && manifest.files?.includes('cordis.patch.yml'), JSON.stringify(manifest.files))

  const patch = await readFile(join(pkgDir, 'cordis.patch.yml'), 'utf8')
  record('patch layer has one insert row', (patch.match(/^\s*- insert:/gm) ?? []).length === 1, (patch.match(/^\s*- insert:/gm) ?? []).length + ' insert(s)')
  record('patch layer names the row id', new RegExp('id:\\s*' + stubOpts.rowId + '\\b').test(patch), stubOpts.rowId)
  record('patch layer names the package', patch.includes("'" + stubOpts.name + "'"), stubOpts.name)

  const host = await import(pathToFileURL(join(pkgDir, 'lib', 'index.js')).href)
  record('host half imports', host.name === stubOpts.name && typeof host.apply === 'function', 'name=' + String(host.name) + ' apply=' + typeof host.apply)
  record('host half apply is a no-op', host.apply() === undefined, 'returns undefined')
  record('cordis inject names services, not packages', cordisInject.every((s) => !s.includes('/')), JSON.stringify(cordisInject))

  const failed = checks.filter((c) => !c.ok)
  for (const c of checks) log((c.ok ? '[ok]   ' : '[FAIL] ') + c.name + ': ' + c.detail)
  log('\n[selftest] ' + (checks.length - failed.length) + '/' + checks.length + ' checks passed')
  await rm(tmp, { recursive: true, force: true })
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('[build] unexpected failure:')
  console.error(error)
  process.exit(1)
})
