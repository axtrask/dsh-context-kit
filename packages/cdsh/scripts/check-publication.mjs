import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const checks = []

function check(name, condition, detail = '') {
  checks.push({ name, ok: Boolean(condition), detail })
  if (!condition) failures.push(name + (detail ? ': ' + detail : ''))
}

function text(path) {
  return readFileSync(join(ROOT, path), 'utf8')
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, out)
    else if (entry.isFile()) out.push(path)
  }
  return out
}

function commentsIn(source) {
  const comments = []
  let state = 'code'
  let start = 0
  let line = 1
  let startLine = 1
  let regexClass = false
  let previous = ''
  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    const next = source[i + 1]
    if (char === '\n') line++
    if (state === 'line') {
      if (char === '\n') { comments.push({ line: startLine, text: source.slice(start, i) }); state = 'code' }
      continue
    }
    if (state === 'block') {
      if (char === '*' && next === '/') { comments.push({ line: startLine, text: source.slice(start, i) }); state = 'code'; i++ }
      continue
    }
    if (state === 'regex') {
      if (char === '\\') { i++; continue }
      if (char === '[') regexClass = true
      else if (char === ']') regexClass = false
      else if (char === '/' && !regexClass) state = 'code'
      continue
    }
    if (state !== 'code') {
      if (char === '\\') { i++; continue }
      if ((state === 'single' && char === "'") || (state === 'double' && char === '"') || (state === 'template' && char === '`')) state = 'code'
      continue
    }
    if (char === "'") { state = 'single'; continue }
    if (char === '"') { state = 'double'; continue }
    if (char === '`') { state = 'template'; continue }
    if (char === '/' && next === '/') { state = 'line'; start = i + 2; startLine = line; i++; continue }
    if (char === '/' && next === '*') { state = 'block'; start = i + 2; startLine = line; i++; continue }
    if (char === '/' && (!previous || /[([{:;,=!?&|+*%^~<>-]/.test(previous))) { state = 'regex'; regexClass = false; continue }
    if (!/\s/.test(char)) previous = char
  }
  if (state === 'line') comments.push({ line: startLine, text: source.slice(start) })
  return comments
}

const FORBIDDEN_COMMENT_LETTERS = /[\p{Script=Cyrillic}\p{Script=Han}]/u

const pkg = JSON.parse(text('package.json'))
const client = text('lib/client.js')
const host = text('lib/index.js')
const patch = text('cordis.patch.yml')
const notice = text('THIRD_PARTY_NOTICES.md')
const provenance = text('vendor/dsh-opencode-palette/PROVENANCE.md')

check('package identity', pkg.name === 'cdsh' && pkg.version === '0.3.0', `${pkg.name}@${pkg.version}`)
check('zero runtime dependencies', pkg.dependencies === undefined && pkg.devDependencies === undefined)
check('entrypoints', pkg.main === 'lib/index.js' && pkg.exports?.['./client'] === './lib/client.js')
check('Loader row identity', /^\s*- id: cdsh$/m.test(patch) && /^\s+name: ['"]cdsh['"]$/m.test(patch))
check('host identity', /export const name = "cdsh"/.test(host))
check('Cordis locale injection', /exports\.inject = \["locale"\]/.test(client))
check('settings slot preserved', client.includes('settings.plugins.tab'))
check('vendored version notice', notice.includes('dsh-opencode-palette@1.7.1'))
check('vendored provenance', provenance.includes('dsh-opencode-palette') && provenance.includes('Version: `1.7.1`'))
check('generated client parses', (() => { try { new Function(client); return true } catch { return false } })())

const forbidden = [
  ['drive file URL', new RegExp('file:' + '\\/\\/\\/' + '[A-Za-z]:\\/', 'i')],
  ['Windows user path', new RegExp('C:' + '\\\\' + 'Users' + '\\\\', 'i')],
  ['macOS user path', new RegExp('\\/Users\\/[^\\/\\s]+\\/', 'i')],
  ['Linux user path', new RegExp('\\/home\\/[^\\/\\s]+\\/', 'i')],
  ['local username', new RegExp('pro' + '100noob', 'i')],
  ['scratch tree', new RegExp('\\/' + 'palette-rewrite' + '\\/', 'i')],
]
const authoredRoots = ['src', 'scripts', 'test', 'lib']
const authored = authoredRoots.flatMap((name) => walk(join(ROOT, name)))
  .filter((path) => /\.(?:mjs|js|json|md|yml|yaml|txt)$/.test(path))
const authoredCode = authored.filter((path) => /\.(?:mjs|js)$/.test(path))
const nonEnglishComments = authoredCode.flatMap((path) => commentsIn(readFileSync(path, 'utf8'))
  .filter((comment) => FORBIDDEN_COMMENT_LETTERS.test(comment.text))
  .map((comment) => relative(ROOT, path) + ':' + comment.line))
check('comment language guard rejects Cyrillic and CJK letters',
  commentsIn('// комментарий\n/* 注释 */').filter((comment) => FORBIDDEN_COMMENT_LETTERS.test(comment.text)).length === 2
    && commentsIn("const fixture = 'нет-такой-темы'\n// punctuation — allowed").filter((comment) => FORBIDDEN_COMMENT_LETTERS.test(comment.text)).length === 0)
check('English-only authored code comments', nonEnglishComments.length === 0, nonEnglishComments.join(', '))
for (const [label, pattern] of forbidden) {
  const hits = authored.filter((path) => pattern.test(readFileSync(path, 'utf8'))).map((path) => relative(ROOT, path))
  check('no ' + label, hits.length === 0, hits.join(', '))
}
check('virtual package URLs only', !/file:\/\/\/(?!cdsh\/)/i.test(client))
check('no non-English line comments in client', !/\/\/[^\r\n]*[^\x00-\x7f]/.test(client))
check('no non-English block comments in client', !/\/\*[^*]*[^\x00-\x7f][^*]*\*\//.test(client))
check('no embedded engine sources', !client.includes('vendor/dsh-opencode-palette/src/engine/'))
check('no embedded authored sources', !client.includes('"src/generate-regions.mjs"'))

const temp = mkdtempSync(join(tmpdir(), 'cdsh-publication-'))
try {
  const env = { ...process.env }
  delete env.DSH_NATIVE_ROOT
  const built = spawnSync(process.execPath, ['scripts/build.mjs', '--output-dir=' + temp], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  })
  check('reproducible build exits cleanly', built.status === 0, (built.stderr || built.stdout || '').trim().split(/\r?\n/).slice(-1)[0] || '')
  for (const file of ['lib/index.js', 'lib/client.js']) {
    const fresh = join(temp, file)
    const same = built.status === 0 && statSync(fresh).isFile() && readFileSync(fresh).equals(readFileSync(join(ROOT, file)))
    check(file + ' is fresh', same)
  }
} finally {
  rmSync(temp, { recursive: true, force: true })
}

for (const item of checks) console.log(`${item.ok ? '[ok]' : '[FAIL]'} ${item.name}${item.detail ? ': ' + item.detail : ''}`)
console.log(`[publication] ${checks.length - failures.length}/${checks.length} checks passed`)
if (failures.length) process.exit(1)
