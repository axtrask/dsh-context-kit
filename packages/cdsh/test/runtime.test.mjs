// Implementation note.
// Implementation note.
//
// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
//
// Implementation note.
// Implementation note.
//     <tmp>/work/{runtime,generate-regions,panel,times,tool-motion,font-face,env}.mjs
//     <tmp>/upstream/src/themes/*.json
// Implementation note.

import { mkdtemp, mkdir, copyFile, cp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Implementation note.
class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.attrs = new Map()
    this.childNodes = []
    this.parentNode = null
    this.textContent = ''
    this.dataset = {}
  }
  setAttribute(k, v) { this.attrs.set(String(k), String(v)) }
  getAttribute(k) { return this.attrs.has(String(k)) ? this.attrs.get(String(k)) : null }
  hasAttribute(k) { return this.attrs.has(String(k)) }
  removeAttribute(k) { this.attrs.delete(String(k)) }
  appendChild(n) { if (n.parentNode) n.parentNode.removeChild(n); n.parentNode = this; this.childNodes.push(n); return n }
  removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); n.parentNode = null; return n }
  remove() { if (this.parentNode) this.parentNode.removeChild(this) }
}

function attrMatches(node, sel) {
  const re = /\[([^\]=]+)(?:=("([^"]*)"|'([^']*)'|([^\]]*)))?\]/g
  let m
  let any = false
  while ((m = re.exec(sel))) {
    any = true
    const name = m[1]
    if (!node.hasAttribute(name)) return false
    const expected = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : m[5])
    if (expected !== undefined && node.getAttribute(name) !== expected) return false
  }
  return any
}

function matches(node, sel) {
  const s = sel.trim()
  if (!s) return false
  let rest = s
  const tag = /^[a-zA-Z][\w-]*/.exec(rest)
  let sawTag = false
  if (tag) {
    sawTag = true
    if (node.tagName !== tag[0].toUpperCase()) return false
    rest = rest.slice(tag[0].length)
  }
  const sawAttr = attrMatches(node, rest)
  return sawTag || sawAttr
}

class FakeDocument {
  constructor() {
    this.documentElement = new FakeNode('html')
    this.head = new FakeNode('head')
    this.body = new FakeNode('body')
    this.documentElement.appendChild(this.head)
    this.documentElement.appendChild(this.body)
  }
  createElement(tag) { return new FakeNode(tag) }
  getElementsByTagName(tag) {
    return tag.toLowerCase() === 'head' ? [this.head] : []
  }
  querySelectorAll(selector) {
    const parts = String(selector).split(',')
    const out = []
    const walk = (node) => {
      for (let i = 0; i < node.childNodes.length; i++) {
        const child = node.childNodes[i]
        for (let p = 0; p < parts.length; p++) {
          if (matches(child, parts[p])) { out.push(child); break }
        }
        walk(child)
      }
    }
    walk(this.documentElement)
    return out
  }
}

function installDom() {
  const doc = new FakeDocument()
  globalThis.document = doc
  return doc
}

function makeStorage(seed) {
  const map = new Map(Object.entries(seed || {}))
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: (k) => { map.delete(k) },
    _map: map,
  }
}

// ── Micro framework ──────────────────────────────────────────────────────────
let passed = 0
const failures = []
function ok(cond, msg) {
  if (cond) { passed++; return true }
  failures.push(msg)
  return false
}
function eq(actual, expected, msg) {
  return ok(actual === expected, msg + ' (expected ' + JSON.stringify(expected) + ', received ' + JSON.stringify(actual) + ')')
}

// Fake generator: its response shape exactly matches the contract.
function makeGenerator(overrides) {
  const base = {
    themeNames: () => ['system', 'opencode', 'gruvbox', 'tokyonight'],
    previewColors: (n) => ({ background: '#101010', text: '#eeeeee', primary: '#fab283', name: n }),
    themeGroups: () => [{ name: 'warm', color: '#fab283', themes: [{ name: 'opencode', colors: null }] }],
    FONTS: { 'JetBrains Mono': "'JetBrains Mono',monospace", 'Cascadia Code': "'Cascadia Code',monospace" },
    SANS_STACK: 'system-ui,sans-serif',
    generateRegionCss: (theme, region, opts) => ({
      css: '--dsw-alias-bg-base:#101010;--dsw-alias-label-primary:#eeeeee;',
      meta: { theme: theme, region: region, selector: opts && opts.selector, important: opts && opts.important },
    }),
    generateTypographyCss: (typography) => ({
      css: 'body,body[data-ds-dark-theme]{--dsw-font-family:TestStack;--dsw-font-markdown-base-font-size:' + typography.size + 'px;}body{font-size:' + typography.size + 'px;}',
      meta: { size: typography.size },
    }),
  }
  return Object.assign(base, overrides || {})
}

// Fake ctx with Cordis semantics: effect(fn) runs fn and uses its return value as the disposer.
function makeCtx() {
  const disposers = []
  return {
    effect(fn) {
      const d = typeof fn === 'function' ? fn() : null
      if (typeof d === 'function') disposers.push(d)
      return () => {}
    },
    get() { return undefined },
    dispose() {
      while (disposers.length) {
        const d = disposers.pop()
        try { d() } catch (e) { /* Ignore cleanup failures. */ }
      }
    },
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

// ── Sandbox matching the build layout ───────────────────────────────────────
const TEST_ROOT = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(TEST_ROOT, '..')
const SOURCE_ROOT = join(PACKAGE_ROOT, 'src')

async function makeSandbox() {
  const root = await mkdtemp(join(tmpdir(), 'cdsh-runtime-test-'))
  const work = join(root, 'src')
  await mkdir(work, { recursive: true })
  for (const f of ['runtime.mjs', 'generate-regions.mjs', 'panel.mjs', 'times.mjs', 'tool-motion.mjs', 'font-face.mjs']) {
    await copyFile(join(SOURCE_ROOT, f), join(work, f))
  }
  await writeFile(join(work, 'env.mjs'), [
    "export const PLUGIN_ID = 'dsh-regional-palette'",
    "export const VERSION = '0.0.0-test'",
    "export const SETTINGS_SLOT = 'settings.plugins.tab'",
    '',
  ].join('\n'))
  // Preserve the package-relative vendor layout used by the production generator.
  await cp(join(PACKAGE_ROOT, 'vendor', 'dsh-opencode-palette'), join(root, 'vendor', 'dsh-opencode-palette'), { recursive: true })
  return { root: root, entry: join(work, 'runtime.mjs') }
}

// ════════════════════════════════════════════════════════════════════════════
async function main() {
  const sandbox = await makeSandbox()
  const rt = await import(pathToFileURL(sandbox.entry).href)
  const { createClient, REGION_IDS, STORAGE_KEY, ATTR_REGION, ATTR_OWNED, hasGlobalSelector, normalizeFeatures, normalizeState, DEFAULT_TYPOGRAPHY, DEFAULT_REGION_THEME } = rt
  // Nearly all checks replace the generator and omit @font-face (460 KB),
  // testing runtime logic rather than theme contents.
  // Row labels (./times.mjs) use a separate conversation slot entry, so engine
  // tests disable them and the panel; both have dedicated checks below.
  const mk = (extra) => createClient(Object.assign({ fontFaces: false, panel: false, times: false }, extra || {}))

  // A palette refresh must not sweep away its own independent design sheet.
  {
    const doc = installDom()
    globalThis.localStorage = makeStorage()
    const ctx = makeCtx()
    const api = mk({ generator: makeGenerator(), designCss: () => '.studio-test{color:red}' })(ctx)
    const design = doc.querySelectorAll('style').find(n => n.textContent.includes('.studio-test'))
    // Reflect dataset.plugin, as a real browser does (FakeNode has a plain object).
    design.setAttribute('data-plugin', design.dataset.plugin)
    api.setTypography({ size: 15 })
    ok(design.parentNode === doc.head, 'design survives typography reconciliation')
    api.setRegionTheme('header', 'gruvbox')
    ok(design.parentNode === doc.head, 'design survives palette reconciliation')
    api.setEnabled(false)
    eq(doc.querySelectorAll('style').length, 0, 'disable removes both palette and design')
    api.setEnabled(true)
    eq(doc.querySelectorAll('style').length, 2, 'enable restores palette and design once')
    ctx.dispose()
    eq(doc.querySelectorAll('style').length, 0, 'dispose removes both layers')
  }

  // ── 1. Application: one <style>, blocks for every region ──────────────────────
  {
    const doc = installDom()
    globalThis.localStorage = makeStorage()
    const api = mk({ generator: makeGenerator() })(makeCtx())

    eq(DEFAULT_REGION_THEME, 'opencode', 'fresh workspace uses the visible CDSH Default colorway')
    ok(REGION_IDS.every(id => api.getState().regions[id].theme === 'opencode'), 'fresh regions visibly select CDSH Default')

    eq(doc.querySelectorAll('style').length, 1, 'runtime check at source line 233')
    const css = api.getCss()
    for (const r of REGION_IDS) {
      ok(css.indexOf('[data-dsh-region="' + r + '"]') >= 0, 'runtime check at source line 236' + r)
    }
    ok(css.indexOf('body,body[data-ds-dark-theme]{--dsw-font-family') >= 0, 'runtime check at source line 238')
    eq(api.getMeta().applied.length, 6, 'runtime check at source line 239')
    // Color blocks are line-oriented; only typography may use global selectors.
    const regionLines = api.getCss().split('\n').filter((l) => l.indexOf('/* region:') === 0)
    eq(regionLines.length, 6, 'runtime check at source line 242')
    let globalLeak = 0
    for (const line of regionLines) {
      if (/(^|[},])\s*(:root|html|body)\b/.test(line)) globalLeak++
    }
    eq(globalLeak, 0, 'runtime check at source line 247')
    ok(css.indexOf('toolCards') >= 0 && css.indexOf('[data-tool]') >= 0, 'runtime check at source line 248')
    ok(css.indexOf('[data-composer-card]') >= 0, 'runtime check at source line 249')
  }

  // ── 2. Idempotence ────────────────────────────────────────────────────
  {
    const doc = installDom()
    globalThis.localStorage = makeStorage()
    const api = mk({ generator: makeGenerator() })(makeCtx())
    const first = api.getCss()
    for (let i = 0; i < 5; i++) api.apply()
    eq(doc.querySelectorAll('style').length, 1, 'runtime check at source line 259')
    eq(api.getCss(), first, 'runtime check at source line 260')
    eq(doc.head.childNodes.length, 1, 'runtime check at source line 261')
  }

  // ── 3. Removal of foreign/stale nodes (HMR, duplicate plugin, v1.7.1) ─────────────
  {
    const doc = installDom()
    globalThis.localStorage = makeStorage()
    const decoyA = doc.createElement('style')
    decoyA.setAttribute('data-plugin', 'dsh-opencode-palette')
    const decoyB = doc.createElement('style')
    decoyB.setAttribute('data-dsh-palette-style', '1')
    doc.head.appendChild(decoyA)
    doc.head.appendChild(decoyB)
    const api = mk({ generator: makeGenerator() })(makeCtx())
    eq(doc.querySelectorAll('style').length, 1, 'runtime check at source line 275')
    ok(decoyA.parentNode === null && decoyB.parentNode === null, 'runtime check at source line 276')
    eq(api.verifyClean().styleNodes, 1, 'runtime check at source line 277')
  }

  // ── 4. Regions: change theme and disable one region ────────────────────
  {
    const doc = installDom()
    globalThis.localStorage = makeStorage()
    const api = mk({ generator: makeGenerator() })(makeCtx())
    api.setAllRegionsTheme('opencode')

    eq(api.setRegionTheme('sidebar', 'gruvbox'), true, 'runtime check at source line 287')
    ok(api.getCss().indexOf('region:sidebar theme:gruvbox') >= 0, 'runtime check at source line 288')
    eq(api.getState().regions.conversation.theme, 'opencode', 'runtime check at source line 289')

    eq(api.toggleRegion('composer', false), false, 'runtime check at source line 291')
    ok(api.getCss().indexOf('region:composer') < 0, 'runtime check at source line 292')
    eq(api.getMeta().skipped.indexOf('composer:off') >= 0, true, 'runtime check at source line 293')
    eq(doc.querySelectorAll('style').length, 1, 'runtime check at source line 294')

    api.toggleRegion('composer')
    ok(api.getCss().indexOf('region:composer') >= 0, 'runtime check at source line 297')

    api.setRegionTheme('header', 'system')
    ok(api.getCss().indexOf('region:header') < 0, 'runtime check at source line 300')

    eq(api.setRegionTheme('нетТакогоРегиона', 'gruvbox'), false, 'runtime check at source line 302')
    eq(api.setRegionTheme('sidebar', 'такойТемыНет'), false, 'runtime check at source line 303')
    eq(api.getState().regions.sidebar.theme, 'gruvbox', 'runtime check at source line 304')
  }

  // ── 5. Clean disable ──────────────────────────────────────────────────
  {
    const doc = installDom()
    globalThis.localStorage = makeStorage()
    const root = doc.createElement('div')
    doc.body.appendChild(root)
    const api = mk({ generator: makeGenerator() })(makeCtx())
    const release = api.markRegionRoot(root, 'conversation')
    eq(root.getAttribute(ATTR_REGION), 'conversation', 'runtime check at source line 315')
    eq(root.getAttribute(ATTR_OWNED), '1', 'runtime check at source line 316')
    ok(doc.querySelectorAll('style').length === 1, 'runtime check at source line 317')

    eq(api.setEnabled(false), false, 'runtime check at source line 319')
    eq(doc.querySelectorAll('style').length, 0, 'runtime check at source line 320')
    eq(api.getCss(), '', 'runtime check at source line 321')
    const report = api.verifyClean()
    eq(report.ok, true, 'runtime check at source line 323' + report.styleNodes + ', owned=' + report.ownedNodes + ')')
    eq(report.styleNodes, 0, 'runtime check at source line 324')
    eq(report.ownedNodes, 1, 'runtime check at source line 325')

    eq(api.setEnabled(true), true, 'runtime check at source line 327')
    eq(doc.querySelectorAll('style').length, 1, 'runtime check at source line 328')
    eq(root.getAttribute(ATTR_REGION), 'conversation', 'runtime check at source line 329')

    release()
    eq(root.getAttribute(ATTR_REGION), null, 'runtime check at source line 332')
    eq(root.getAttribute(ATTR_OWNED), null, 'runtime check at source line 333')
  }

  // ── 6. v1.7.1 → v2 migration ───────────────────────────────────────────────
  {
    installDom()
    const legacy = JSON.stringify({ enabled: true, theme: 'gruvbox', mode: 'tui', size: 15, fontKey: 'Cascadia Code' })
    const storage = makeStorage({ 'dsh.opencode-palette.v2': legacy })
    globalThis.localStorage = storage
    const api = mk({ generator: makeGenerator() })(makeCtx())
    const st = api.getState()

    eq(st.enabled, true, 'runtime check at source line 345')
    eq(st.regions.conversation.theme, 'gruvbox', 'runtime check at source line 346')
    let allSame = true
    for (const r of REGION_IDS) if (st.regions[r].theme !== 'gruvbox') allSame = false
    eq(allSame, true, 'runtime check at source line 349')
    eq(st.typography.mode, 'tui', 'runtime check at source line 350')
    eq(st.typography.size, 15, 'runtime check at source line 351')
    eq(st.typography.fontKey, 'Cascadia Code', 'runtime check at source line 352')
    ok(storage.getItem(STORAGE_KEY) !== null, 'runtime check at source line 353')
    ok(storage.getItem('dsh.opencode-palette.v2') !== null, 'runtime check at source line 354')

    // Second start: v3 is read directly, so no migration remains.
    const api2 = mk({ generator: makeGenerator() })(makeCtx())
    eq(api2.deps.resolved, true, 'runtime check at source line 358')
    eq(api2.getState().regions.conversation.theme, 'gruvbox', 'runtime check at source line 359')
  }

  // ── 6b. Migration from the oldest key (dsh-opencode-tui-theme.v2) ───────
  {
    installDom()
    const storage = makeStorage({ 'dsh.opencode-tui-theme.v2': JSON.stringify({ theme: 'tokyonight', size: 12 }) })
    globalThis.localStorage = storage
    const api = mk({ generator: makeGenerator() })(makeCtx())
    eq(api.getState().regions.conversation.theme, 'tokyonight', 'runtime check at source line 368')
    eq(api.getState().typography.size, 12, 'runtime check at source line 369')
    eq(api.getState().typography.fontKey, 'JetBrains Mono', 'runtime check at source line 370')
  }

  // ── 6c. Unknown legacy theme → default theme ──────────────────────
  {
    installDom()
    globalThis.localStorage = makeStorage({ 'dsh.opencode-palette.v2': JSON.stringify({ theme: 'нетТакойТемы' }) })
    const api = mk({ generator: makeGenerator() })(makeCtx())
    eq(api.getState().regions.conversation.theme, DEFAULT_REGION_THEME, 'runtime check at source line 378')
  }

  // ── 6d. CDSH v0.2.0 no-op default upgrades once without touching custom palettes ──
  {
    installDom()
    const regions = {}
    for (const id of REGION_IDS) regions[id] = { enabled: true, theme: 'system' }
    const storage = makeStorage({
      'dsh.cdsh.v1': JSON.stringify({ enabled: true, regions, typography: { mode: 'mono', size: 16, fontKey: 'Cascadia Code' } }),
    })
    globalThis.localStorage = storage
    const api = mk({ generator: makeGenerator() })(makeCtx())
    ok(REGION_IDS.every(id => api.getState().regions[id].theme === 'opencode'), 'untouched all-system v0.2.0 palette migrates to CDSH Default')
    eq(api.getState().typography.size, 16, 'palette migration preserves customized typography')
    ok(storage.getItem(STORAGE_KEY) !== null, 'palette migration writes the v2 CDSH key')
    ok(storage.getItem('dsh.cdsh.v1') !== null, 'palette migration keeps the rollback source')
  }
  {
    installDom()
    const regions = {}
    for (const id of REGION_IDS) regions[id] = { enabled: true, theme: id === 'sidebar' ? 'gruvbox' : 'system' }
    globalThis.localStorage = makeStorage({ 'dsh.cdsh.v1': JSON.stringify({ enabled: true, regions }) })
    const api = mk({ generator: makeGenerator() })(makeCtx())
    eq(api.getState().regions.sidebar.theme, 'gruvbox', 'an explicit custom region survives v0.2.0 migration')
    eq(api.getState().regions.conversation.theme, 'system', 'mixed custom/system palette is not rewritten')
  }

  // ── 6e. Global-selector detection is stable across repeated calls ───────
  {
    for (let i = 0; i < 4; i++) {
      eq(hasGlobalSelector('body{color:red}'), true, 'runtime check at source line 409' + i + ')')
      eq(hasGlobalSelector('[data-dsh-region="x"]{--a:1}'), false, 'runtime check at source line 410' + i + ')')
    }
  }

  // ── 7. Protection against coloring everything ────────────────────────────────────────
  {
    installDom()
    globalThis.localStorage = makeStorage()
    const bad = makeGenerator({
      generateRegionCss: () => ({ css: 'body,body[data-ds-dark-theme]{--dsw-alias-bg-base:#101010;}', meta: {} }),
    })
    const api = mk({ generator: bad })(makeCtx())
    api.setAllRegionsTheme('opencode')
    const css = api.getCss()
    eq(api.getMeta().reanchored.length, 6, 'runtime check at source line 424')
    ok(css.indexOf('body,body[data-ds-dark-theme]{--dsw-alias-bg-base') < 0, 'runtime check at source line 425')
    ok(css.indexOf('[data-dsh-region="sidebar"]{--dsw-alias-bg-base:#101010;}') >= 0, 'runtime check at source line 426')
    eq(doc_style_count(), 1, 'runtime check at source line 427')
  }

  // ── 7b. Bare generator selectors are scoped to the region anchor ────────
  {
    installDom()
    globalThis.localStorage = makeStorage()
    const loose = makeGenerator({
      generateRegionCss: (theme, region) => ({
        css: '--dsw-alias-bg-base:#101010;' +
          'a{color:#fab283;}' +
          'code:not(pre code){background:transparent;}' +
          '@media (min-width:900px){blockquote{color:#888;}}' +
          '@keyframes palette-pulse{from{opacity:0}to{opacity:1}}' +
          '[data-dsh-region="' + region + '"] .md a{color:#0f0;}',
        meta: {},
      }),
    })
    const api = mk({ generator: loose })(makeCtx())
    api.setAllRegionsTheme('opencode')
    const css = api.getCss()
    eq(api.getMeta().scoped.length, 6, 'runtime check at source line 448')
    ok(css.indexOf('[data-dsh-region="sidebar"] a{color:#fab283;}') >= 0, 'runtime check at source line 449')
    ok(css.indexOf('[data-dsh-region="sidebar"] code:not(pre code)') >= 0, 'runtime check at source line 450')
    ok(!/(^|[}\n])a\{color:#fab283;\}/.test(css), 'runtime check at source line 451')
    ok(css.indexOf('@media (min-width:900px){[data-dsh-region="sidebar"] blockquote') >= 0, 'runtime check at source line 452')
    ok(css.indexOf('@keyframes palette-pulse{from{opacity:0}to{opacity:1}}') >= 0, 'runtime check at source line 453')
    ok(css.indexOf('[data-dsh-region="conversation"] .md a{color:#0f0;}') >= 0, 'runtime check at source line 454')
    eq(css.indexOf('[data-dsh-region="sidebar"] [data-dsh-region="conversation"] .md a'), -1, 'runtime check at source line 455')
    eq(doc_style_count(), 1, 'runtime check at source line 456')
  }

  // ── 8. Typography is independent of regions ─────────────────────────────────
  {
    const doc = installDom()
    globalThis.localStorage = makeStorage()
    const api = mk({ generator: makeGenerator() })(makeCtx())
    api.setAllRegionsEnabled(false)
    eq(api.getMeta().applied.length, 0, 'runtime check at source line 465')
    // Read the font size from the runtime instead of hard-coding it: the default
    // is a visual choice that may change, and the typography-independence check
    // must not fail when it does. Test the independent axis itself.
    ok(api.getCss().indexOf('--dsw-font-markdown-base-font-size:' + DEFAULT_TYPOGRAPHY.size + 'px') >= 0,
      'typography remains active on its independent axis')
    eq(doc.querySelectorAll('style').length, 1, 'runtime check at source line 471')

    api.refresh({ size: 17 })
    ok(api.getCss().indexOf('--dsw-font-markdown-base-font-size:17px') >= 0, 'runtime check at source line 474')
    eq(api.getState().typography.size, 17, 'runtime check at source line 475')
    api.refresh('mono', 12, 'JetBrains Mono')
    eq(api.getState().typography.size, 12, 'runtime check at source line 477')
    eq(doc.querySelectorAll('style').length, 1, 'runtime check at source line 478')
  }

  // ── 9. Generator returns empty output: typography still works ─────────────
  {
    const doc = installDom()
    globalThis.localStorage = makeStorage()
    const empty = { generateRegionCss: (theme, region) => ({ css: '', meta: { stub: true, theme: theme, region: region } }) }
    const api = mk({ generator: empty })(makeCtx())
    api.setAllRegionsTheme('opencode')
    ok(api.getCss().indexOf('--dsw-font-family') >= 0, 'runtime check at source line 488')
    eq(api.getMeta().applied.length, 0, 'runtime check at source line 489')
    eq(api.getMeta().stub, true, 'runtime check at source line 490')
    eq(doc.querySelectorAll('style').length, 1, 'runtime check at source line 491')
    api.apply()
    eq(doc.querySelectorAll('style').length, 1, 'runtime check at source line 493')
    api.setEnabled(false)
    eq(api.verifyClean().ok, true, 'runtime check at source line 495')
  }

  // ── 9b. INTEGRATION with the real generator (without injection) ─────────────────
  {
    const doc = installDom()
    globalThis.localStorage = makeStorage()
    const api = createClient({ panel: false })(makeCtx()) // generator and fontFaces match the build
    api.setAllRegionsTheme('opencode')
    const names = api.themeNames()
    ok(Array.isArray(names) && names.length >= 20, 'runtime check at source line 505' + (names ? names.length : 0))

    const css = api.getCss()
    eq(api.getMeta().applied.length, 6, 'runtime check at source line 508')
    eq(api.getMeta().rejected.length, 0, 'runtime check at source line 509' + api.getMeta().rejected.join(','))
    ok(css.indexOf(':where([data-dsh-region="conversation"])') >= 0, 'runtime check at source line 510')
    ok(css.indexOf('--dsw-alias-bg-base') >= 0, 'runtime check at source line 511')
    ok(css.indexOf('[data-diff]') >= 0, 'runtime check at source line 512')
    ok(css.indexOf(':where(body[data-ds-dark-theme]') >= 0, 'runtime check at source line 513')
    ok(css.indexOf('@font-face') >= 0, 'runtime check at source line 514')

    // Region isolation: no document-level rules except typography.
    let globalRules = 0
    for (const line of css.split('\n')) {
      if (!/^\s*(:root|html|body)\s*[,{]/.test(line)) continue
      if (line.indexOf('--dsw-font-family') >= 0) continue // typography is intentionally document-level
      globalRules++
    }
    eq(globalRules, 0, 'runtime check at source line 523')
    eq(css.split('\n').filter((l) => l.indexOf('/* region:') === 0).length, 6, 'runtime check at source line 524')

    // Change theme using a real registry name.
    const other = names.filter((n) => n !== 'system' && n !== api.getState().regions.sidebar.theme)[0]
    eq(api.setRegionTheme('sidebar', other), true, 'runtime check at source line 528' + other)
    ok(api.getCss().indexOf('region:sidebar theme:' + other) >= 0, 'runtime check at source line 529')

    // Disable with real CSS.
    api.setEnabled(false)
    eq(doc.querySelectorAll('style').length, 0, 'runtime check at source line 533')
    eq(api.verifyClean().ok, true, 'runtime check at source line 534')
    api.setEnabled(true)
    eq(doc.querySelectorAll('style').length, 1, 'runtime check at source line 536')

    // fontFaces: false saves about 460 KB
    const light = mk({})(makeCtx())
    eq(light.getCss().indexOf('@font-face'), -1, 'runtime check at source line 540')
  }

  // ── 9c. INTEGRATION with the real panel (./panel.mjs) ──────────────────────
  {
    installDom()
    globalThis.localStorage = makeStorage()
    const registered = []
    let slotDisposers = 0
    const slots = {
      inject: function (slot, fn) {
        registered.push(slot)
        try { if (typeof fn === 'function') fn() } catch (e) { /* React is not needed in this test. */ }
        return function () { slotDisposers++ }
      },
      register: function (desc, Comp) { return { desc: desc, Comp: Comp } },
    }
    const ctx = makeCtx()
    const baseGet = ctx.get
    ctx.get = function (name) { return name === 'slots' ? slots : baseGet(name) }
    createClient({ fontFaces: false, times: false })(ctx)
    ok(registered.indexOf('settings.plugins.tab') >= 0, 'runtime check at source line 561')
    ok(registered.indexOf('settings.section') >= 0, 'runtime check at source line 562')
    ctx.dispose()
    eq(slotDisposers, 2, 'runtime check at source line 564')

    // panel:false prevents the panel from mounting
    const ctx2 = makeCtx()
    let touched = false
    ctx2.get = function (name) { if (name === 'slots') touched = true; return undefined }
    mk({})(ctx2)
    eq(touched, false, 'runtime check at source line 571')
  }

  // ── 9d. Row labels (./times.mjs): exactly one conversation-slot entry ──
  {
    installDom()
    globalThis.localStorage = makeStorage()
    const registered = []
    let slotDisposers = 0
    const slots = {
      inject: function (slot, fn) {
        registered.push(slot)
        try { if (typeof fn === 'function') fn() } catch (e) { /* React is not needed in this test. */ }
        return function () { slotDisposers++ }
      },
      register: function (desc, Comp) { return { desc: desc, Comp: Comp } },
    }
    const ctx = makeCtx()
    let requestedServices = null
    ctx.inject = function (services, activate) {
      requestedServices = services
      return activate({ slots: slots })
    }
    createClient({ fontFaces: false, panel: false })(ctx)
    eq(JSON.stringify(requestedServices), JSON.stringify(['slots']), 'runtime check at source line 595')
    eq(registered.length, 1, 'runtime check at source line 596')
    eq(registered[0], 'conversation.input.dock', 'runtime check at source line 597')
    ctx.dispose()
    eq(slotDisposers, 1, 'runtime check at source line 599')

    // times:false prevents the label from mounting
    const ctx2 = makeCtx()
    let touched = false
    ctx2.get = function (name) { if (name === 'slots') touched = true; return undefined }
    createClient({ fontFaces: false, panel: false, times: false })(ctx2)
    eq(touched, false, 'runtime check at source line 606')
  }

  // ── 10. Dispose removes every side effect (Cordis semantics) ───────────
  {
    const doc = installDom()
    globalThis.localStorage = makeStorage()
    const ctx = makeCtx()
    const root = doc.createElement('div')
    doc.body.appendChild(root)
    const api = mk({ generator: makeGenerator() })(ctx)
    api.markRegionRoot(root, 'sidebar')
    ok(globalThis.__opencodePalette === api, 'runtime check at source line 618')
    eq(doc.querySelectorAll('style').length, 1, 'runtime check at source line 619')

    ctx.dispose()
    eq(doc.querySelectorAll('style').length, 0, 'runtime check at source line 622')
    eq(root.getAttribute(ATTR_REGION), null, 'runtime check at source line 623')
    ok(globalThis.__opencodePalette === undefined, 'runtime check at source line 624')
    eq(api.verifyClean().ok, true, 'runtime check at source line 625')
    api.setEnabled(true)
    eq(doc.querySelectorAll('style').length, 0, 'runtime check at source line 627')
  }

  // ── 10b. HMR/double start: old instance does not remove the new instance's style ──────
  {
    const doc = installDom()
    globalThis.localStorage = makeStorage()
    const ctxA = makeCtx()
    const apiA = mk({ generator: makeGenerator() })(ctxA)
    eq(doc.querySelectorAll('style').length, 1, 'runtime check at source line 636')

    const ctxB = makeCtx()
    const apiB = mk({ generator: makeGenerator() })(ctxB)
    eq(doc.querySelectorAll('style').length, 1, 'runtime check at source line 640')
    const cssB = apiB.getCss()
    ok(cssB.length > 0, 'runtime check at source line 642')

    ctxA.dispose() // the old runtime stops AFTER the new one (typical HMR)
    eq(doc.querySelectorAll('style').length, 1, 'runtime check at source line 645')
    eq(doc.querySelectorAll('style')[0].textContent, cssB, 'runtime check at source line 646')
    const rootB = doc.createElement('section')
    doc.body.appendChild(rootB)
    eq(typeof apiB.markRegionRoot(rootB, 'sidebar'), 'function', 'runtime check at source line 649')

    const staleRoot = doc.createElement('section')
    doc.body.appendChild(staleRoot)
    let staleEvents = 0
    eq(apiA.markRegionRoot(staleRoot, 'sidebar'), false, 'runtime check at source line 654')
    eq(staleRoot.getAttribute(ATTR_REGION), null, 'runtime check at source line 655')
    eq(apiA.setRegionAnchors('sidebar', ['[data-stale-anchor]']), false, 'runtime check at source line 656')
    eq(apiA.resetRegionAnchors('sidebar'), false, 'runtime check at source line 657')
    apiA.subscribe(() => { staleEvents++ })
    apiA.subscribeLocale(() => { staleEvents++ })
    const staleSweep = apiA.sweep()
    eq(staleSweep.styles, 0, 'runtime check at source line 661')
    eq(staleSweep.attributes, 0, 'runtime check at source line 662')
    apiA.clear()
    apiA.apply()
    apiA.setRegionTheme('sidebar', 'gruvbox') // late call through the stale API
    apiA.setEnabled(false)
    apiB.setRegionTheme('header', 'gruvbox')
    eq(staleEvents, 0, 'runtime check at source line 668')
    eq(rootB.getAttribute(ATTR_REGION), 'sidebar', 'runtime check at source line 669')
    eq(rootB.getAttribute(ATTR_OWNED), '1', 'runtime check at source line 670')
    eq(doc.querySelectorAll('style').length, 1, 'runtime check at source line 671')
    eq(doc.querySelectorAll('style')[0].textContent, apiB.getCss(), 'runtime check at source line 672')

    ctxB.dispose()
    eq(doc.querySelectorAll('style').length, 0, 'runtime check at source line 675')
  }

  // ── 10c. Repeated start through the same apply (as in the built package) ──────────
  // In lib/client.js the builder emits exports.apply = createClient(slot), so
  // createClient is evaluated ONCE while apply(ctx) may run repeatedly when the
  // composition row restarts. Every call must be self-contained.
  {
    const doc = installDom()
    globalThis.localStorage = makeStorage()
    const plugin = mk({ generator: makeGenerator() })
    const ctx1 = makeCtx()
    const api1 = plugin(ctx1)
    eq(doc.querySelectorAll('style').length, 1, 'runtime check at source line 688')

    ctx1.dispose()
    eq(doc.querySelectorAll('style').length, 0, 'runtime check at source line 691')

    const ctx2 = makeCtx()
    const api2 = plugin(ctx2)
    eq(doc.querySelectorAll('style').length, 1, 'runtime check at source line 695')
    ok(api2.getCss().length > 0, 'runtime check at source line 696')
    api2.setEnabled(false)
    eq(api2.verifyClean().ok, true, 'runtime check at source line 698')
    ctx2.dispose()
  }

  // ── 11. Subscription and bus for the settings panel ───────────────────────────────
  {
    installDom()
    globalThis.localStorage = makeStorage()
    const api = mk({ generator: makeGenerator() })(makeCtx())
    const events = []
    const unsub = api.subscribe((snapshot, reason) => events.push(reason))
    api.setRegionTheme('header', 'gruvbox')
    api.setEnabled(false)
    ok(events.length >= 2, 'runtime check at source line 711' + events.join(','))
    unsub()
    const before = events.length
    api.setEnabled(true)
    eq(events.length, before, 'runtime check at source line 715')

    let nested = false
    let outerBrandStatus = null
    const firstListener = api.subscribe((_snapshot, reason) => {
      if (reason === 'region:sidebar' && !nested) {
        nested = true
        api.reportFeatureStatus('brand', 'active', 'nested update')
      }
    })
    const secondListener = api.subscribe((snapshot, reason) => {
      if (reason === 'region:sidebar') outerBrandStatus = snapshot.compatibility.brand.status
    })
    api.setRegionTheme('sidebar', 'tokyonight')
    eq(outerBrandStatus, 'active', 'runtime check at source line 729')
    firstListener()
    secondListener()

    const bus = globalThis.__dshPaletteBus
    ok(!!bus && bus.api === api, 'runtime check at source line 734')
    let fromBus = null
    const unbind = bus.subscribe((a) => { fromBus = a })
    eq(fromBus, api, 'runtime check at source line 737')
    unbind()

    for (const name of ['getState', 'setRegionTheme', 'toggleRegion', 'setEnabled', 'refresh', 'subscribe', 'markRegionRoot', 'verifyClean']) {
      eq(typeof api[name], 'function', 'runtime check at source line 741' + name)
    }
  }

  // ── 12. State normalization as a pure function ────────────────────────
  {
    const norm = normalizeState({ theme: 'gruvbox' }, null)
    eq(norm.migrated, true, 'runtime check at source line 748')
    eq(norm.state.regions.overlays.theme, 'gruvbox', 'runtime check at source line 749')
    const norm2 = normalizeState({ enabled: false, regions: { sidebar: { enabled: true, theme: 'gruvbox' } }, typography: { size: 20 }, features: { brand: false, futureBoolean: true, futureText: 'no' }, compatibility: { brand: { status: 'failed' } } }, null)
    eq(norm2.migrated, false, 'runtime check at source line 751')
    eq(norm2.state.regions.sidebar.theme, 'gruvbox', 'runtime check at source line 752')
    eq(norm2.state.regions.header.theme, DEFAULT_REGION_THEME, 'runtime check at source line 753')
    eq(norm2.state.typography.size, 20, 'runtime check at source line 754')
    eq(norm2.state.features.brand, false, 'runtime check at source line 755')
    eq(norm2.state.features.futureBoolean, true, 'runtime check at source line 756')
    eq(Object.prototype.hasOwnProperty.call(norm2.state.features, 'futureText'), false, 'runtime check at source line 757')
    eq(Object.prototype.hasOwnProperty.call(norm2.state, 'compatibility'), false, 'runtime check at source line 758')
    eq(normalizeFeatures({ brand: false }).focusView, true, 'runtime check at source line 759')
  }

  // ── 13. Extension supervision: isolation, preferences, and exact cleanup ─────────
  {
    installDom()
    const storage = makeStorage()
    globalThis.localStorage = storage
    const ctx = makeCtx()
    let brandAttempts = 0
    let brandMounts = 0
    let brandDrops = 0
    let focusMounts = 0
    let focusDrops = 0
    let injectionDrops = 0
    ctx.slots = {}
    ctx.inject = function (_services, activate) {
      const dispose = activate(ctx)
      let closed = false
      return {
        dispose() {
          if (closed) return
          closed = true
          injectionDrops++
          if (typeof dispose === 'function') dispose()
          else if (dispose && typeof dispose.dispose === 'function') dispose.dispose()
        },
      }
    }
    const api = mk({
      generator: makeGenerator(),
      brand(_scope, featureApi) {
        brandAttempts++
        if (brandAttempts === 1) throw new Error('brand boom')
        brandMounts++
        featureApi.reportFeatureStatus('brand', 'active', 'test active')
        let closed = false
        return function () {
          if (closed) return
          closed = true
          brandDrops++
        }
      },
      focusView(_scope, featureApi) {
        focusMounts++
        featureApi.reportFeatureStatus('focusView', 'active', 'test active')
        let closed = false
        return {
          dispose() {
            if (closed) return
            closed = true
            focusDrops++
          },
        }
      },
    })(ctx)
    eq(api.getState().compatibility.brand.status, 'failed', 'runtime check at source line 815')
    eq(brandAttempts, 1, 'runtime check at source line 816')
    eq(api.getState().compatibility.focusView.status, 'active', 'runtime check at source line 817')
    eq(focusMounts, 1, 'runtime check at source line 818')
    api.setRegionTheme('header', 'gruvbox')
    eq(brandAttempts, 2, 'runtime check at source line 820')
    eq(brandMounts, 1, 'runtime check at source line 821')
    eq(api.getState().compatibility.brand.status, 'active', 'runtime check at source line 822')
    api.setFeature('focusView', false)
    eq(focusDrops, 1, 'runtime check at source line 824')
    eq(api.getState().features.focusView, false, 'runtime check at source line 825')
    api.setFeature('focusView', true)
    eq(focusMounts, 2, 'runtime check at source line 827')
    api.setEnabled(false)
    eq(focusDrops, 2, 'runtime check at source line 829')
    eq(brandDrops, 1, 'runtime check at source line 830')
    eq(api.getState().features.focusView, true, 'runtime check at source line 831')
    const saved = JSON.parse(storage._map.get(STORAGE_KEY))
    eq(saved.features.focusView, true, 'runtime check at source line 833')
    eq(Object.prototype.hasOwnProperty.call(saved, 'compatibility'), false, 'runtime check at source line 834')
    api.setEnabled(true)
    eq(focusMounts, 3, 'runtime check at source line 836')
    eq(brandAttempts, 3, 'runtime check at source line 837')
    eq(brandMounts, 2, 'runtime check at source line 838')
    ctx.dispose()
    eq(focusDrops, 3, 'runtime check at source line 840')
    eq(brandDrops, 2, 'runtime check at source line 841')
    ok(injectionDrops >= 1, 'runtime check at source line 842')
  }

  function doc_style_count() { return document.querySelectorAll('style').length }

  // ── result ──────────────────────────────────────────────────────────────────
  if (failures.length) {
    console.error('\nFAILED ' + failures.length + ' checks (passed ' + passed + '):')
    for (const f of failures) console.error('  ✗ ' + f)
    process.exitCode = 1
    return
  }
  console.log('OK: ' + passed + ' checks passed, 0 failures')
}

main().catch((e) => {
  console.error('test failed with an exception:', e)
  process.exitCode = 1
})
