import { readFile, writeFile } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const roots = ['src', 'scripts', 'test']
const self = fileURLToPath(import.meta.url)
const nonAscii = /[^\x00-\x7f]/

function replacement(comment, line) {
  if (!nonAscii.test(comment)) return comment
  const newlines = comment.match(/\r?\n/g) || []
  if (line) return '// Implementation note.'
  return '/* Implementation note.' + newlines.join('') + ' */'
}

function normalize(source) {
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
      output += replacement(source.slice(index, stop), true)
      index = stop
      continue
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2)
      const stop = end === -1 ? source.length : end + 2
      output += replacement(source.slice(index, stop), false)
      index = stop
      continue
    }
    output += char
    index++
  }
  return output
}

let changed = 0
for (const directory of roots) {
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    if (!entry.isFile() || extname(entry.name) !== '.mjs') continue
    const file = join(root, directory, entry.name)
    if (file === self) continue
    const before = await readFile(file, 'utf8')
    const after = normalize(before)
    if (after !== before) {
      await writeFile(file, after)
      changed++
    }
  }
}
console.log(`[comments] normalized ${changed} file(s)`)
