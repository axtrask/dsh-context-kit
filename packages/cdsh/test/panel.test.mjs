// Implementation note.
// Implementation note.
//
// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.

import assert from 'node:assert/strict'
import { createPanelComponent, registerPanel, getI18nDicts, getLocaleNamespace, bindReact, REGIONS } from '../src/panel.mjs'

const NS = getLocaleNamespace()
const DICTS = getI18nDicts()

// Implementation note.
const listeners = {}
// Implementation note.
const bodyState = { dark: true }
const fakeDoc = {
  documentElement: { lang: 'en' },
  head: { appendChild() {} },
  body: { hasAttribute: (n) => (n === 'data-ds-dark-theme' ? bodyState.dark : false) },
  addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn) },
  removeEventListener(t, fn) { if (listeners[t]) listeners[t] = listeners[t].filter((f) => f !== fn) },
}
globalThis.document = fakeDoc
// Implementation note.
const observers = []
globalThis.MutationObserver = class {
  constructor(cb) { this.cb = cb; this.target = null; observers.push(this) }
  observe(target) { this.target = target }
  disconnect() { const i = observers.indexOf(this); if (i >= 0) observers.splice(i, 1) }
}
function triggerObservers(target) {
  for (const o of observers.slice()) if (!target || o.target === target) o.cb([])
}
globalThis.window = {}

// Implementation note.
function makeReact() {
  const depsEqual = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  let prev = []      // Implementation note.
  let curr = []      // Implementation note.
  let cursor = 0
  let rendering = false
  let dirty = false
  let scheduled = false
  let mount = { Comp: null, props: null, tree: null }
  let commits = 0

  const React = {
    createElement(type, props, ...children) {
      const flat = []
      const push = (c) => {
        if (Array.isArray(c)) c.forEach(push)
        else if (c !== null && c !== undefined && c !== false && c !== true) flat.push(c)
      }
      children.forEach(push)
      return { $$el: true, type, props: props || {}, children: flat }
    },
    useState(init) {
      const i = cursor++
      const p = prev[i]
      const h = p && p.kind === 'state' ? p : { kind: 'state', v: typeof init === 'function' ? init() : init }
      curr[i] = h
      return [h.v, (next) => {
        const val = typeof next === 'function' ? next(h.v) : next
        if (Object.is(val, h.v)) return
        h.v = val
        dirty = true
        schedule()
      }]
    },
    useRef(init) {
      const i = cursor++
      const p = prev[i]
      const h = p && p.kind === 'ref' ? p : { kind: 'ref', v: { current: init === undefined ? null : init } }
      curr[i] = h
      return h.v
    },
    useEffect(fn, deps) {
      const i = cursor++
      const p = prev[i]
      let h
      if (!p || p.kind !== 'effect') h = { kind: 'effect', deps: deps, cleanup: null, run: fn }
      else if (!depsEqual(p.deps, deps)) h = { kind: 'effect', deps: deps, cleanup: p.cleanup, run: fn }
      else h = { kind: 'effect', deps: p.deps, cleanup: p.cleanup, run: p.run }
      curr[i] = h
    },
  }

  function schedule() { scheduled = true; if (!rendering) flush() }
  function renderOnce() {
    cursor = 0
    curr = []
    rendering = true
    let out
    try { out = mount.Comp(mount.props) } finally { rendering = false }
    prev = curr
    commits++
    mount.tree = out
  }
  function runEffects(phase) {
    for (const h of prev) {
      if (!h || h.kind !== 'effect') continue
      if (phase === 'cleanup' && h.run) {
        if (h.cleanup) { try { h.cleanup() } catch (e) { /* Implementation note. */ } h.cleanup = null }
      } else if (phase === 'run' && h.run) {
        const c = h.run()
        h.cleanup = typeof c === 'function' ? c : null
        h.run = null
      }
    }
  }
  // Implementation note.
  function flush() {
    let guard = 0
    while (dirty || scheduled) {
      if (++guard > 80) throw new Error('rerender did not settle (possible self-triggering loop)')
      scheduled = false
      dirty = false
      runEffects('cleanup')
      renderOnce()
      runEffects('run')
    }
  }
  return {
    React,
    mount(Comp, props) {
      mount = { Comp, props, tree: null }
      prev = []
      curr = []
      cursor = 0
      renderOnce()
      runEffects('run')
      flush()
      return mount
    },
    rerender() { flush(); return mount.tree },
    get commits() { return commits },
  }
}

// Implementation note.
// Implementation note.
function walk(node, out, clickable, collect) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out, clickable, collect)); return }
  if (!node.$$el) { out.push(String(node)); return }
  const props = node.props
  if (!collect) { node.children.forEach((c) => walk(c, out, clickable, collect)); return }
  const style = props.style || {}
  const hasClick = typeof props.onClick === 'function'
  if (hasClick) clickable.push({ node, props, style, text: textOf(node) })
  out.push('<' + (typeof node.type === 'string' ? node.type : 'C') + (hasClick ? '#' + (clickable.length - 1) : '') + '>')
  if (props.placeholder) out.push('@ph=' + props.placeholder)
  if (props.href) out.push('@href=' + props.href)
  if (props.title) out.push('@title=' + props.title)
  if (props.role) out.push('@role=' + props.role)
  if (props['data-theme']) out.push('@theme=' + props['data-theme'])
  if (props['data-scope']) out.push('@scope=' + props['data-scope'])
  if (props['data-region']) out.push('@region=' + props['data-region'])
  if (style.color) out.push('@color=' + style.color)
  if (style.background) out.push('@bg=' + style.background)
  if (style.border) out.push('@border=' + style.border)
  if (style.boxShadow) out.push('@shadow=' + style.boxShadow)
  node.children.forEach((c) => walk(c, out, clickable, collect))
}
function textOf(node) {
  const acc = []
  walk(node, acc, [], false)
  return acc.join(' ').trim()
}
function inspect(tree) {
  const out = []
  const clickable = []
  walk(tree, out, clickable, true)
  return { text: out.join(' | '), clickable, tree }
}
const click = (n, ev) => { assert.ok(n, 'target click node does not exist'); n.node.props.onClick(ev || { stopPropagation() {}, target: null }) }
const byText = (items, needle) => items.find((n) => n.text.indexOf(needle) >= 0)
const chip = (items, theme, scope) => items.find((n) => n.props['data-theme'] === theme && (!scope || n.props['data-scope'] === scope))
const switches = (items) => items.filter((n) => n.props.role === 'switch')

// Implementation note.
function makeRuntime(overrides = {}) {
  const calls = []
  const state = {
    enabled: true,
    regions: {
      sidebar: { enabled: true, theme: 'tokyonight' },
      header: { enabled: true, theme: 'tokyonight' },
      conversation: { enabled: true, theme: 'tokyonight' },
      composer: { enabled: true, theme: 'tokyonight' },
      toolCards: { enabled: true, theme: 'tokyonight' },
      overlays: { enabled: false, theme: 'tokyonight' },
    },
    typography: { mode: 'mono', size: 13, fontKey: 'JetBrains Mono' },
    theme: 'tokyonight',
    ...overrides,
  }
  const subs = []
  const api = {
    getState: () => JSON.parse(JSON.stringify(state)),
    setRegionTheme(r, t) { calls.push(['setRegionTheme', r, t]); state.regions[r].theme = t },
    toggleRegion(r, e) { calls.push(['toggleRegion', r, e]); state.regions[r].enabled = e },
    setEnabled(b) { calls.push(['setEnabled', b]); state.enabled = b },
    refresh(m, s, f) { calls.push(['refresh', m, s, f]); state.typography = { mode: m, size: s, fontKey: f } },
    subscribe(fn) { subs.push(fn); return () => { const i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1) } },
    themeNames: () => ['dracula', 'nord', 'opencode', 'tokyonight', 'system'],
    groups: () => [
      { name: 'warm', color: '#FAB283', themes: [{ name: 'opencode', colors: { background: '#202020', text: '#EEEEEE', primary: '#FAB283' } }] },
      { name: 'cool-blue', color: '#82AAFF', themes: [{ name: 'nord', colors: { background: '#2E3440', text: '#D8DEE9', primary: '#88C0D0' } }] },
      {
        name: 'violet', color: '#C4A7E7', themes: [
          { name: 'tokyonight', colors: { background: '#1A1B26', text: '#C0CAF5', primary: '#BB9AF7' } },
          { name: 'dracula', colors: { background: '#282A36', text: '#F8F8F2', primary: '#BD93F9' } },
        ],
      },
      { name: 'special', color: '#8B8B95', themes: [{ name: 'system', colors: { background: null, text: null, primary: null } }] },
    ],
    version: '9.9.9',
    repo: 'https://example.test/repo',
    regionList: REGIONS.map((r) => ({ key: r.key, zh: r.zh, en: r.en, icon: r.icon })),
  }
  return { api, state, calls, subs }
}

// Implementation note.
function boot(rt, opts = {}) {
  const R = makeReact()
  bindReact(R.React)
  delete rt.api.locale
  if (opts.locale) rt.api.locale = opts.locale
  if (opts.lang) fakeDoc.documentElement.lang = opts.lang
  if (opts.hostDark !== undefined) bodyState.dark = opts.hostDark
  if (opts.props) Object.assign(rt.api, opts.props)
  const m = R.mount(createPanelComponent(), { api: rt.api })
  return { R, m, view: inspect(m.tree) }
}
const re = (b) => inspect(b.R.rerender())
// Implementation note.
function switchHost(b, dark) {
  bodyState.dark = dark
  triggerObservers(fakeDoc.body)
  return inspect(b.R.rerender())
}
function collectStyleStrings(node, out) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach((n) => collectStyleStrings(n, out)); return }
  if (!node.$$el) return
  const st = node.props && node.props.style
  if (st) for (const k in st) { const v = st[k]; if (typeof v === 'string') out.push(v) }
  ;(node.children || []).forEach((c) => collectStyleStrings(c, out))
}

let passed = 0
let failed = 0
function ok(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name) }
  catch (e) {
    failed++
    console.error('  FAIL ' + name + '\n       ' + (e && e.message))
    if (process.env.PANEL_TEST_TRACE && e && e.stack) console.error(String(e.stack).split('\n').slice(0, 12).join('\n       '))
  }
}

console.log('--- Panel test group at source line 270 ---')
ok('Panel scenario at source line 271', () => {
  const rt = makeRuntime()
  const b = boot(rt)
  for (const k of ['Sidebar', 'Header', 'Conversation', 'Composer', 'Tool cards', 'Overlays']) {
    assert.ok(b.view.text.includes(k), 'panel assertion at source line 275' + k)
  }
  assert.ok(b.view.text.includes('Default theme'), 'panel assertion at source line 277')
  const bulk = byText(b.view.clickable, 'Apply to every region')
  assert.ok(bulk, 'panel assertion at source line 279')
  assert.equal(bulk.props.disabled, true, 'panel assertion at source line 280')
  assert.ok(b.view.text.includes('All regions follow the default theme'), 'panel assertion at source line 281')
  assert.ok(b.view.text.includes('CDSH'), 'panel assertion at source line 282')
  assert.ok(b.view.text.includes('v9.9.9'), 'panel assertion at source line 283')
  assert.ok(b.view.text.includes('@href=https://example.test/repo'), 'panel assertion at source line 284')
  assert.ok(b.view.text.includes('@href=https://example.test/repo/issues'), 'panel assertion at source line 285')
  assert.ok(b.view.text.includes('Typography'), 'panel assertion at source line 286')
  assert.ok(b.view.text.includes('Enabled'), 'panel assertion at source line 287')
  assert.equal(switches(b.view.clickable).length, 12, 'panel assertion at source line 288')
})

ok('Panel scenario at source line 291', () => {
  const rt = makeRuntime()
  const b = boot(rt, { lang: 'zh-CN' })
  assert.ok(b.view.text.includes('CDSH'), 'panel assertion at source line 294')
  assert.ok(b.view.text.includes('对话区'), 'panel assertion at source line 295')
  assert.ok(b.view.text.includes('暖橙'), 'panel assertion at source line 296')
  assert.ok(b.view.text.includes('应用到全部区域'), 'panel assertion at source line 297')
  assert.ok(!b.view.text.includes('Opencode Palette'), 'panel assertion at source line 298')
  fakeDoc.documentElement.lang = 'en'
})

ok('Panel scenario at source line 302', () => {
  // Implementation note.
  const svc = {
    getLocale: () => ({ active: 'zh', revision: 1, dicts: { [NS]: { zh: { ...DICTS.zh, panelName: '宿主译名' }, en: { ...DICTS.en } } } }),
    subscribe: () => () => {},
    register: () => () => {},
  }
  const rt = makeRuntime()
  const b = boot(rt, { locale: svc })
  assert.ok(b.view.text.includes('宿主译名'), 'panel assertion at source line 311')
  assert.ok(b.view.text.includes('已启用') || b.view.text.includes('已停用'), 'panel assertion at source line 312')
})

ok('Panel scenario at source line 315', () => {
  let rev = 1
  let cb = null
  const svc = {
    getLocale: () => ({ active: rev === 1 ? 'en' : 'zh', revision: rev }),
    subscribe: (fn) => { cb = fn; return () => { cb = null } },
    register: () => () => {},
  }
  const rt = makeRuntime()
  const b = boot(rt, { locale: svc })
  assert.ok(b.view.text.includes('CDSH'), 'panel assertion at source line 325')
  rev = 2
  cb({ active: 'zh', revision: 2 })
  const v2 = re(b)
  assert.ok(v2.text.includes('CDSH'), 'panel assertion at source line 329')
})

ok('Panel scenario at source line 332', () => {
  const rt = makeRuntime()
  const b = boot(rt)
  assert.ok(b.view.text.includes('@bg=#1A1B26'), 'panel assertion at source line 335')
  assert.ok(b.view.text.includes('@bg=#2E3440'), 'panel assertion at source line 336')
  assert.ok(b.view.text.includes('Warm'), 'panel assertion at source line 337')
  assert.ok(b.view.text.includes('Special'), 'panel assertion at source line 338')
  assert.ok(b.view.text.includes('system (host colors)'), 'panel assertion at source line 339')
  assert.ok(b.view.text.includes('@ph=Search themes…'), 'panel assertion at source line 340')
})

console.log('--- Panel test group at source line 343 ---')
ok('Panel scenario at source line 344', () => {
  const rt = makeRuntime()
  const b = boot(rt)
  const nord = chip(b.view.clickable, 'nord', 'global')
  assert.ok(nord, 'panel assertion at source line 348')
  click(nord)
  assert.equal(rt.calls.filter((c) => c[0] === 'setRegionTheme').length, 0, 'panel assertion at source line 350')
  const v2 = re(b)
  assert.ok(v2.text.includes('Default theme · nord'), 'panel assertion at source line 352' + v2.text.slice(0, 160))
  assert.ok(v2.text.includes('Default theme set to'), 'panel assertion at source line 353')
  click(byText(v2.clickable, 'Apply to every region'))
  const writes = rt.calls.filter((c) => c[0] === 'setRegionTheme')
  assert.equal(writes.length, 6, 'panel assertion at source line 356' + writes.length)
  assert.deepEqual([...new Set(writes.map((c) => c[1]))].sort(), ['composer', 'conversation', 'header', 'overlays', 'sidebar', 'toolCards'])
  assert.ok(writes.every((c) => c[2] === 'nord'), 'panel assertion at source line 358' + JSON.stringify(writes))
  assert.equal(rt.calls.filter((c) => c[0] === 'toggleRegion' && c[2] === true).length, 6, 'panel assertion at source line 359')
  const v3 = re(b)
  assert.equal(byText(v3.clickable, 'Apply to every region').props.disabled, true, 'panel assertion at source line 361')
  assert.ok(v3.text.includes('All regions follow the default theme'), 'panel assertion at source line 362')
})

ok('Panel scenario at source line 365', () => {
  const rt = makeRuntime()
  const bulk = []
  rt.api.setAllRegionsTheme = (t) => { bulk.push(['theme', t]); for (const k in rt.state.regions) rt.state.regions[k].theme = t }
  rt.api.setAllRegionsEnabled = (e) => { bulk.push(['enabled', e]); for (const k in rt.state.regions) rt.state.regions[k].enabled = e }
  const b = boot(rt)
  click(chip(b.view.clickable, 'nord', 'global'))
  click(byText(re(b).clickable, 'Apply to every region'))
  assert.deepEqual(bulk, [['theme', 'nord'], ['enabled', true]], 'panel assertion at source line 373' + JSON.stringify(bulk))
  assert.equal(rt.calls.filter((c) => c[0] === 'setRegionTheme').length, 0, 'panel assertion at source line 374')
})

ok('Panel scenario at source line 377', () => {
  const rt = makeRuntime()
  const seen = []
  rt.api.setDefaultTheme = (t) => { seen.push(t) }
  const b = boot(rt)
  click(chip(b.view.clickable, 'dracula', 'global'))
  assert.deepEqual(seen, ['dracula'], 'panel assertion at source line 383')
})

console.log('--- Panel test group at source line 386 ---')
ok('Panel scenario at source line 387', () => {
  const rt = makeRuntime()
  const b = boot(rt)
  click(b.view.clickable.find((n) => n.props['data-region'] === 'sidebar'))
  const v2 = re(b)
  const dracula = chip(v2.clickable, 'dracula', 'region')
  assert.ok(dracula, 'panel assertion at source line 393')
  click(dracula)
  const writes = rt.calls.filter((c) => c[0] === 'setRegionTheme')
  assert.equal(writes.length, 1, 'panel assertion at source line 396')
  assert.deepEqual(writes[0].slice(1), ['sidebar', 'dracula'])
  assert.equal(rt.calls.filter((c) => c[0] === 'toggleRegion').length, 0, 'panel assertion at source line 398')
  const v3 = re(b)
  assert.ok(v3.text.includes('Custom'), 'panel assertion at source line 400')
})

ok('Panel scenario at source line 403', () => {
  const rt = makeRuntime()
  const b = boot(rt)
  click(b.view.clickable.find((n) => n.props['data-region'] === 'overlays'))
  click(chip(re(b).clickable, 'nord', 'region'))
  assert.deepEqual(rt.calls.filter((c) => c[0] === 'toggleRegion'), [['toggleRegion', 'overlays', true]])
  assert.deepEqual(rt.calls.filter((c) => c[0] === 'setRegionTheme')[0].slice(1), ['overlays', 'nord'])
})

ok('Panel scenario at source line 412', () => {
  const rt = makeRuntime({ regions: { ...makeRuntime().state.regions, sidebar: { enabled: true, theme: 'dracula' } } })
  const b = boot(rt)
  click(b.view.clickable.find((n) => n.props['data-region'] === 'sidebar'))
  const back = byText(re(b).clickable, 'Default · tokyonight')
  assert.ok(back, 'panel assertion at source line 417')
  click(back)
  const writes = rt.calls.filter((c) => c[0] === 'setRegionTheme')
  assert.deepEqual(writes[writes.length - 1].slice(1), ['sidebar', 'tokyonight'])
})

ok('Panel scenario at source line 423', () => {
  const rt = makeRuntime()
  const b = boot(rt)
  click(switches(b.view.clickable)[1])
  assert.deepEqual(rt.calls.filter((c) => c[0] === 'toggleRegion'), [['toggleRegion', 'sidebar', false]])
})

ok('Panel scenario at source line 430', () => {
  const rt = makeRuntime()
  const b = boot(rt)
  click(switches(b.view.clickable)[0])
  assert.deepEqual(rt.calls.filter((c) => c[0] === 'setEnabled'), [['setEnabled', false]])
})

ok('Panel scenario at source line 437', () => {
  const rt = makeRuntime({ enabled: false })
  const b = boot(rt)
  assert.ok(b.view.text.includes('Disabled'), 'panel assertion at source line 440')
  assert.ok(b.view.text.includes('CDSH is off: colours and extensions are inactive'), 'panel assertion at source line 441')
})

ok('Panel scenario at source line 444', () => {
  const rt = makeRuntime()
  const b = boot(rt)
  click(byText(b.view.clickable, 'Enable all regions'))
  const t = rt.calls.filter((c) => c[0] === 'toggleRegion')
  assert.equal(t.length, 6, 'panel assertion at source line 449')
  assert.ok(t.every((c) => c[2] === true))
})

console.log('--- Panel test group at source line 453 ---')
ok('Panel scenario at source line 454', () => {
  const rt = makeRuntime()
  const b = boot(rt)
  click(byText(b.view.clickable, 'Font size 13px'))
  click(byText(re(b).clickable, '15px'))
  const r = rt.calls.filter((c) => c[0] === 'refresh')
  assert.deepEqual(r[r.length - 1], ['refresh', 'mono', 15, 'JetBrains Mono'])
})

ok('Panel scenario at source line 463', () => {
  const rt = makeRuntime()
  const b = boot(rt)
  click(byText(b.view.clickable, 'Code only'))
  click(byText(b.view.clickable, 'JetBrains Mono'))
  const fira = re(b).clickable.find((n) => n.text.indexOf('Fira Code') >= 0 && n.text !== 'Code only')
  assert.ok(fira, 'panel assertion at source line 469')
  click(fira)
  const r = rt.calls.filter((c) => c[0] === 'refresh')
  assert.deepEqual(r[r.length - 1], ['refresh', 'tui', 13, 'Fira Code'])
})

ok('Panel scenario at source line 475', () => {
  const rt = makeRuntime()
  const b = boot(rt)
  click(byText(b.view.clickable, 'Code only'))
  assert.equal(rt.calls.filter((c) => c[0] === 'setRegionTheme').length, 0, 'panel assertion at source line 479')
  assert.equal(rt.calls.filter((c) => c[0] === 'toggleRegion').length, 0, 'panel assertion at source line 480')
})

console.log('--- Panel test group at source line 483 ---')
ok('Panel scenario at source line 484', () => {
  const rt = makeRuntime()
  const b = boot(rt)
  assert.equal(rt.subs.length, 1, 'panel assertion at source line 487')
  assert.ok(b.view.text.includes('Follows default'), 'panel assertion at source line 488')
  rt.state.regions.sidebar.theme = 'dracula'
  rt.subs[0](rt.api.getState())
  const v2 = re(b)
  assert.ok(v2.text.includes('Custom'), 'panel assertion at source line 492')
  assert.ok(v2.text.includes('1 region(s) custom'), 'panel assertion at source line 493' + v2.text.slice(0, 140))
})

ok('Panel scenario at source line 496', () => {
  const rt = makeRuntime()
  let unsub = 0
  rt.api.subscribe = (fn) => { rt.subs.push(fn); return () => { unsub++; const i = rt.subs.indexOf(fn); if (i >= 0) rt.subs.splice(i, 1) } }
  const b = boot(rt)
  assert.equal(rt.subs.length, 1)
  switchHost(b, false)
  switchHost(b, true)
  re(b)
  assert.equal(unsub, 0, 'panel assertion at source line 505')
  assert.equal(rt.subs.length, 1, 'panel assertion at source line 506')
})

ok('Panel scenario at source line 509', () => {
  const rt = makeRuntime()
  delete rt.api.subscribe
  const b = boot(rt)
  assert.ok(b.view.text.includes('CDSH'), 'panel assertion at source line 513')
  click(switches(b.view.clickable)[0])
  assert.deepEqual(rt.calls.filter((c) => c[0] === 'setEnabled'), [['setEnabled', false]])
})

console.log('--- Panel test group at source line 518 ---')
ok('Panel scenario at source line 519', () => {
  const rt = makeRuntime()
  const b = boot(rt)
  const seen = []
  collectStyleStrings(b.m.tree, seen)
  const bad = seen.filter((s) => /var\([^)]*,/.test(s))
  assert.deepEqual(bad, [], 'panel assertion at source line 525' + bad.join(' ; '))
})

ok('Panel scenario at source line 528', () => {
  const rt = makeRuntime()
  const b = boot(rt)
  const seen = []
  collectStyleStrings(b.m.tree, seen)
  const vars = new Set()
  for (const s of seen) for (const m of s.matchAll(/var\((--[a-z0-9-]+)\)/g)) vars.add(m[1])
  const allowed = /^--(dsw-alias-[a-z0-9-]+|dsw-font-family|ds-font-family-code|ds-ease-in-out)$/
  for (const v of vars) assert.ok(allowed.test(v), 'undeclared token: ' + v)
  assert.ok(vars.size > 8, 'too few tokens (' + vars.size + ')')
})

console.log('--- Panel test group at source line 540 ---')
ok('Panel scenario at source line 541', () => {
  const rt = makeRuntime()
  const b = boot(rt, { hostDark: true })
  click(byText(b.view.clickable, 'Font size 13px'))
  const v = re(b)
  assert.ok(v.text.includes('@shadow=0 8px 24px rgba(0,0,0,0.5)'), 'panel assertion at source line 546')
  assert.ok(!v.text.includes('@shadow=0 1px 3px rgba(0,0,0,0.25)'), 'panel assertion at source line 547')
  assert.ok(v.text.includes('@bg=var(--dsw-alias-bg-layer-3)'), 'Dark switch uses the semantic track token')
})

ok('Panel scenario at source line 551', () => {
  const rt = makeRuntime()
  const b = boot(rt, { hostDark: true })
  click(byText(b.view.clickable, 'Font size 13px'))
  re(b)
  const lv = switchHost(b, false)
  assert.ok(lv.text.includes('@shadow=0 1px 3px rgba(0,0,0,0.25)'), 'panel assertion at source line 557' + lv.text.slice(0, 200))
  assert.ok(lv.text.includes('@shadow=0 8px 24px rgba(0,0,0,0.18)'), 'panel assertion at source line 558')
  assert.ok(!lv.text.includes('#8b8b95'), 'panel assertion at source line 559')
  assert.ok(lv.text.includes('@bg=var(--dsw-alias-bg-layer-3)'), 'panel assertion at source line 560')
  const bv = switchHost(b, true)
  assert.ok(bv.text.includes('@bg=var(--dsw-alias-bg-layer-3)'), 'Dark switch retains the semantic track token')
})

console.log('--- Panel test group at source line 565 ---')
ok('Panel scenario at source line 566', () => {
  const rt = makeRuntime()
  rt.api.getState = () => ({})
  const b = boot(rt)
  assert.ok(b.view.text.includes('Sidebar'), 'panel assertion at source line 570')
  assert.ok(b.view.text.includes('Default theme'), 'panel assertion at source line 571')
})

ok('Panel scenario at source line 574', () => {
  const rt = makeRuntime()
  delete rt.api.regionList
  const b = boot(rt)
  for (const k of ['Sidebar', 'Tool cards', 'Overlays']) assert.ok(b.view.text.includes(k), 'missing region ' + k)
})

ok('Panel scenario at source line 581', () => {
  const rt = makeRuntime()
  delete rt.api.groups
  const b = boot(rt)
  for (const n of ['dracula', 'nord', 'opencode', 'tokyonight', 'system (host colors)']) {
    assert.ok(b.view.text.includes(n), 'panel assertion at source line 586' + n)
  }
})

ok('Panel scenario at source line 590', () => {
  const rt = makeRuntime()
  rt.state.regions.sidebar.theme = 'no-such-theme'
  const b = boot(rt)
  click(b.view.clickable.find((n) => n.props['data-region'] === 'header'))
  click(chip(re(b).clickable, 'nord', 'region'))
  assert.equal(rt.calls.filter((c) => c[0] === 'setRegionTheme').pop()[2], 'nord')
})

console.log('--- Panel test group at source line 599 ---')
// Implementation note.
// Implementation note.
// Implementation note.
function makeRuntimeLikeApi() {
  const calls = []
  const state = {
    enabled: true,
    regions: {
      sidebar: { enabled: true, theme: 'opencode' }, header: { enabled: true, theme: 'opencode' },
      conversation: { enabled: true, theme: 'opencode' }, composer: { enabled: true, theme: 'opencode' },
      toolCards: { enabled: true, theme: 'opencode' }, overlays: { enabled: true, theme: 'opencode' },
    },
    typography: { mode: 'mono', size: 13, fontKey: 'JetBrains Mono' },
  }
  const localeListeners = []
  const api = {
    version: '__PALETTE_VERSION__',
    regionIds: ['sidebar', 'header', 'conversation', 'composer', 'toolCards', 'overlays'],
    regionMeta: {
      sidebar: { i18n: 'region.sidebar' }, header: { i18n: 'region.header' },
      conversation: { i18n: 'region.conversation' }, composer: { i18n: 'region.composer' },
      toolCards: { i18n: 'region.toolCards' }, overlays: { i18n: 'region.overlays' },
    },
    getState: () => JSON.parse(JSON.stringify(state)),
    setEnabled: (b) => { calls.push(['setEnabled', b]); state.enabled = b },
    setRegionTheme: (r, t) => { calls.push(['setRegionTheme', r, t]); state.regions[r].theme = t },
    toggleRegion: (r, e) => { calls.push(['toggleRegion', r, e]); state.regions[r].enabled = e },
    setAllRegionsTheme: (t) => { calls.push(['setAllRegionsTheme', t]); for (const k in state.regions) state.regions[k].theme = t },
    setAllRegionsEnabled: (e) => { calls.push(['setAllRegionsEnabled', e]); for (const k in state.regions) state.regions[k].enabled = e },
    refresh: (m, s, f) => { calls.push(['refresh', m, s, f]) },
    subscribe: () => () => {},
    subscribeLocale: (fn) => { localeListeners.push(fn); return () => {} },
    tr: (k) => (k === 'panelName' ? 'CDSH' : k),
    getLang: () => 'zh',
    i18n: {
      panelName: { zh: 'CDSH', en: 'CDSH' },
      enabled: { zh: '已启用', en: 'Enabled' },
      'region.toolCards': { zh: '工具卡片', en: 'Tool cards' },
    },
    themeNames: () => ['akira', 'nord', 'opencode', 'system'],
    fonts: () => ({ 'JetBrains Mono': "'JetBrains Mono',monospace", Consolas: 'Consolas,monospace' }),
    bundledFonts: () => ['JetBrains Mono'],
    previewColors: (n) => (n === 'system' ? { background: null, text: null, primary: null } : { background: '#101014', text: '#EDEDED', primary: '#7AA2F7' }),
  }
  return { api, state, calls }
}

ok('Panel scenario at source line 647', () => {
  const rt = makeRuntimeLikeApi()
  const b = boot(rt)
  assert.ok(b.view.text.includes('JetBrains Mono'), 'panel assertion at source line 650')
  click(byText(b.view.clickable, 'JetBrains Mono'))
  const v = re(b)
  assert.ok(v.text.includes('Consolas'), 'panel assertion at source line 653')
})

ok('Panel scenario at source line 656', () => {
  const rt = makeRuntimeLikeApi()
  const b = boot(rt)
  assert.ok(b.view.text.includes('Tool cards'), 'panel assertion at source line 659')
  assert.ok(b.view.text.includes('Sidebar'), 'panel assertion at source line 660')
  assert.equal(switches(b.view.clickable).length, 12, 'panel assertion at source line 661')
  assert.equal(b.view.clickable.filter((n) => n.props['data-region']).length, 6, 'panel assertion at source line 662')
  assert.deepEqual(b.view.clickable.filter((n) => n.props['data-region']).map((n) => n.props['data-region']), REGIONS.map((r) => r.key))
})

ok('Panel scenario at source line 666', () => {
  const rt = makeRuntimeLikeApi()
  rt.api.regionIds = ['sidebar', 'customPanel']
  rt.api.regionMeta = { sidebar: { i18n: 'region.sidebar' }, customPanel: { i18n: 'region.customPanel' } }
  rt.api.i18n = { 'region.customPanel': { zh: '自定义面板', en: 'Custom panel' } }
  rt.api.getState = () => ({
    enabled: true,
    regions: { sidebar: { enabled: true, theme: 'opencode' }, customPanel: { enabled: true, theme: 'opencode' } },
    typography: { mode: 'mono', size: 13, fontKey: 'JetBrains Mono' },
  })
  const b = boot(rt, { lang: 'zh-CN' })
  assert.ok(b.view.text.includes('自定义面板'), 'panel assertion at source line 677')
  fakeDoc.documentElement.lang = 'en'
})

ok('Panel scenario at source line 681', () => {
  const rt = makeRuntimeLikeApi()
  const b = boot(rt)
  click(chip(b.view.clickable, 'nord', 'global'))
  click(byText(re(b).clickable, 'Apply to every region'))
  assert.deepEqual(rt.calls.filter((c) => c[0] === 'setAllRegionsTheme'), [['setAllRegionsTheme', 'nord']])
  assert.equal(rt.calls.filter((c) => c[0] === 'setRegionTheme').length, 0)
})

ok('Panel scenario at source line 690', () => {
  const rt = makeRuntimeLikeApi()
  const b = boot(rt)
  assert.ok(b.view.text.includes('@bg=#101014'), 'panel assertion at source line 693')
})

ok('Panel scenario at source line 696', () => {
  const rt = makeRuntimeLikeApi()
  const b = boot(rt, { lang: 'en' })   // Implementation note.
  assert.ok(b.view.text.includes('Typography'), 'panel assertion at source line 699')
  assert.ok(b.view.text.includes('Apply to every region'), 'panel assertion at source line 700')
  fakeDoc.documentElement.lang = 'en'
})

console.log('--- Panel test group at source line 704 ---')
ok('Panel scenario at source line 705', () => {
  const seen = []
  const ctx = {
    get: (k) => k === 'slots' ? {
      inject: (slot, cb) => { seen.push(slot); cb(); return () => {} },
      register: (desc) => { seen.push(desc.name + '#' + desc.order); return () => {} },
    } : undefined,
  }
  const rt = makeRuntime()
  const dispose = registerPanel(ctx, { api: rt.api, tr: (k) => DICTS.en[k] || k })
  assert.deepEqual(seen, ['settings.plugins.tab', 'settings.plugins.tab#30', 'settings.section', 'settings.section#16'])
  assert.equal(typeof dispose, 'function')
  dispose()
})

ok('Panel scenario at source line 720', () => {
  assert.throws(() => registerPanel({ get: () => null }, {}), /options\.api/)
  const rt = makeRuntime()
  const dispose = registerPanel({ get: () => null }, { api: rt.api })
  assert.equal(typeof dispose, 'function')
  dispose()
})

ok('Panel scenario at source line 728', () => {
  assert.equal(DICTS.zh.panelName, 'CDSH')
  assert.equal(DICTS.en.panelName, 'CDSH')
  assert.equal(DICTS.zh['group.warm'], '暖橙')
  assert.equal(DICTS.en['region.toolCards'], 'Tool cards')
  assert.equal(NS, 'cdsh')
  assert.equal(REGIONS.length, 6)
})

ok('Settings controls are native buttons with unique names and pressed state', () => {
  const b = boot(makeRuntime())
  const toggles = switches(b.view.clickable)
  assert.equal(new Set(toggles.map(n => n.props['aria-label'])).size, 12)
  for (const n of toggles) { assert.equal(n.node.type, 'button'); assert.equal(n.props.type, 'button') }
  assert.equal(byText(b.view.clickable, 'Code only').props['aria-pressed'], false)
  click(byText(b.view.clickable, 'Font size 13px'))
  const item = byText(re(b).clickable, '15px')
  assert.equal(item.node.type, 'button')
  assert.equal(item.props.type, 'button')
})

ok('Escape closes the local disclosure and restores its trigger before the parent dialog', () => {
  const b = boot(makeRuntime())
  let focused = 0, prevented = 0, stopped = 0
  const trigger = { isConnected: true, focus() { focused++ } }
  click(byText(b.view.clickable, 'Font size 13px'), { currentTarget: trigger })
  re(b)
  b.m.tree.props.onKeyDown({ key: 'Escape', preventDefault() { prevented++ }, stopPropagation() { stopped++ } })
  const view = re(b)
  assert.equal(focused, 1); assert.equal(prevented, 1); assert.equal(stopped, 1)
  assert.ok(!byText(view.clickable, '15px'))
})

console.log('\nPassed ' + passed + ' checks' + (failed ? ', failed ' + failed + ' checks' : ', all passed'))
if (failed) process.exitCode = 1
