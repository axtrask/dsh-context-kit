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
// Implementation note.
//
// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
//
// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
//
// Implementation note.
//   ./generate-regions.mjs  generateRegionCss(themeName, regionName, opts) -> { css, meta }
//   ./panel.mjs             registerPanel(ctx, { api, slot, tr, id })
//   ./font-face.mjs         FONT_FACE_CSS, BUNDLED_FONTS (vendored engine source)
//
// Implementation note.
// Implementation note.
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
// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
//   createClient({ strict: false, scope: false }).
//
// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
//
// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
//
// Implementation note.
// Implementation note.
// Implementation note.

import { PLUGIN_ID, VERSION, SETTINGS_SLOT } from './env.mjs'
import { generateRegionCss, listThemes, listRegions } from './generate-regions.mjs'
import { registerPanel } from './panel.mjs'
import { registerTimes } from './times.mjs'
import { installToolMotion } from './tool-motion.mjs'
import { FONT_FACE_CSS, BUNDLED_FONTS } from './font-face.mjs'

const LOG = '[' + PLUGIN_ID + ']'

// Implementation note.
export const PALETTE_VERSION = VERSION

// Implementation note.
// Implementation note.
// Implementation note.
const LEGACY_PLUGIN_IDS = ['dsh-regional-palette', 'dsh-opencode-palette']

// Implementation note.
// CDSH writes its own key and keeps the previous keys as read-only migration
// sources so existing region and typography choices survive the rebrand.
export const STORAGE_KEY = 'dsh.cdsh.v2'
const NOOP_DEFAULT_STORAGE_KEY = 'dsh.cdsh.v1'
export const LEGACY_STORAGE_KEYS = Object.freeze([
  NOOP_DEFAULT_STORAGE_KEY,
  'dsh.opencode-palette.v3',
  'dsh.opencode-palette.v2',
  'dsh.opencode-tui-theme.v2',
])

// Implementation note.
export const ATTR_REGION = 'data-dsh-region' // Implementation note.
export const ATTR_OWNED = 'data-dsh-palette-owned' // Implementation note.
export const ATTR_STYLE = 'data-dsh-palette-style' // Implementation note.
export const ATTR_PLUGIN = 'data-plugin' // Implementation note.

// Implementation note.
export const REGION_IDS = Object.freeze([
  'sidebar',
  'header',
  'conversation',
  'composer',
  'toolCards',
  'overlays',
])

// Implementation note.
// Implementation note.
// Implementation note.
export const REGION_META = Object.freeze({
  sidebar: { i18n: 'region.sidebar', note: 'left panel (sidebar.* slots)' },
  header: { i18n: 'region.header', note: 'top bar / session header' },
  conversation: { i18n: 'region.conversation', note: 'main feed (primary region during migration)' },
  composer: { i18n: 'region.composer', note: 'nested in conversation: input field' },
  toolCards: { i18n: 'region.toolCards', note: 'tool cards with semantic anchors' },
  overlays: { i18n: 'region.overlays', note: 'portals/dialogs; transform/filter are forbidden' },
})

// Implementation note.
// Implementation note.
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
export const DEFAULT_REGION_ANCHORS = Object.freeze({
  sidebar: [
    '[data-dsh-region="sidebar"]',
    '[data-slot="sidebar"]',
  ],
  header: [
    '[data-dsh-region="header"]',
    '[data-slot="conversation.session.header"]',
  ],
  conversation: [
    '[data-dsh-region="conversation"]',
    '[data-slot="main.conversation"]',
  ],
  composer: [
    '[data-dsh-region="composer"]',
    '[data-composer-card]',
    '[data-slot="conversation.input.dock"]',
    '[data-slot="conversation.composer.bar"]',
    '[data-slot="conversation.composer"]',
  ],
  toolCards: [
    '[data-dsh-region="toolCards"]',
    // Implementation note.
    // Implementation note.
    '[data-dsh-region^="tool-call"]',
    '[data-tool]',
    '[data-diff]',
    '[data-read]',
    '[data-search]',
    '[data-terminal]',
    '[data-expandable]',
  ],
  overlays: [
    '[data-dsh-region="overlays"]',
    '[data-slot="shell.overlay"]',
    '[data-shell-overlay]',
  ],
})

// Implementation note.
// Implementation note.
// Implementation note.
export const TYPOGRAPHY_ANCHORS = Object.freeze(['body,body[data-ds-dark-theme]'])

// Implementation note.
// Fresh workspaces must visibly demonstrate CDSH; `system` remains an explicit
// per-region escape hatch for users who want the host palette in that area.
export const DEFAULT_REGION_THEME = 'opencode'

function defaultRegions(theme) {
  const regions = {}
  for (let i = 0; i < REGION_IDS.length; i++) regions[REGION_IDS[i]] = { enabled: true, theme: theme }
  return regions
}

// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
export const DEFAULT_TYPOGRAPHY = Object.freeze({
  mode: 'tui',
  size: 14,
  fontKey: 'JetBrains Mono',
})

export const FEATURE_DEFAULTS = Object.freeze({
  brand: true,
  workspace: true,
  turnInsights: true,
  planCopy: true,
  focusView: true,
})

export const DEFAULT_STATE = Object.freeze({
  enabled: true,
  regions: Object.freeze(defaultRegions(DEFAULT_REGION_THEME)),
  typography: DEFAULT_TYPOGRAPHY,
  features: FEATURE_DEFAULTS,
})

// Implementation note.
// Implementation note.
// Implementation note.
export const I18N = {
  panelName: { zh: 'CDSH', en: 'CDSH' },
  subtitle: { zh: 'Custom DSH：按区域应用 38 款配色主题', en: 'Custom DSH: 38 colour themes applied per region' },
  enabled: { zh: '已启用', en: 'Enabled' },
  disabled: { zh: '已停用', en: 'Disabled' },
  disableTitle: { zh: '点击停用主题', en: 'Click to disable' },
  enableTitle: { zh: '点击启用主题', en: 'Click to enable' },
  typography: { zh: '字体字号', en: 'Typography' },
  bodyStyle: { zh: '正文样式', en: 'Body style' },
  mono: { zh: '全部文字', en: 'All text' },
  sans: { zh: '仅代码', en: 'Code only' },
  fontSize: { zh: '字号', en: 'Font size' },
  codeFont: { zh: '代码字体', en: 'Code font' },
  fontNotInstalled: { zh: '本机未装', en: 'missing' },
  fontLocal: { zh: '本地', en: 'local' },
  themeSection: { zh: '选择主题', en: 'Themes' },
  themeCount: { zh: '38 款 · 按色系分组', en: '38 · by color family' },
  search: { zh: '搜索主题…', en: 'Search themes…' },
  noMatch: { zh: '未找到匹配的主题', en: 'No matching themes' },
  systemDefault: { zh: 'system（宿主配色）', en: 'system (host colors)' },
  regionsSection: { zh: '区域', en: 'Regions' },
  regionsHint: { zh: '每个区域可独立启用并选择主题', en: 'Each region can be enabled and themed independently' },
  systemMeansOff: { zh: 'system = 此区域保持宿主配色', en: 'system = keep host colors in this region' },
  'region.sidebar': { zh: '侧边栏', en: 'Sidebar' },
  'region.header': { zh: '顶栏', en: 'Header' },
  'region.conversation': { zh: '对话', en: 'Conversation' },
  'region.composer': { zh: '输入框', en: 'Composer' },
  'region.toolCards': { zh: '工具卡片', en: 'Tool cards' },
  'region.overlays': { zh: '浮层', en: 'Overlays' },
  'group.warm': { zh: '暖橙', en: 'Warm' },
  'group.yellow-green': { zh: '黄绿', en: 'Yellow-green' },
  'group.teal': { zh: '青绿', en: 'Teal' },
  'group.cyan-blue': { zh: '青蓝', en: 'Cyan-blue' },
  'group.cool-blue': { zh: '冷蓝', en: 'Cool blue' },
  'group.violet': { zh: '蓝紫', en: 'Violet' },
  'group.neutral': { zh: '中性', en: 'Neutral' },
  'group.transparent': { zh: '透明', en: 'Transparent' },
  'group.special': { zh: '特殊', en: 'Special' },
}

// Implementation note.
export function toLocaleDicts(i18n) {
  const src = i18n || I18N
  const zh = {}
  const en = {}
  for (const key in src) {
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue
    const pair = src[key] || {}
    zh[key] = pair.zh
    en[key] = pair.en
  }
  return { zh: zh, en: en }
}

// Implementation note.
// Implementation note.
// Implementation note.

function hasDom() {
  return typeof document !== 'undefined' && document !== null && typeof document.createElement === 'function'
}

function hasStorage() {
  try {
    return typeof globalThis !== 'undefined' && !!globalThis.localStorage
  } catch (e) {
    return false
  }
}

function warn() {
  try {
    if (typeof console !== 'undefined' && console.warn) console.warn.apply(console, arguments)
  } catch (e) { /* Implementation note. */ }
}

function fail() {
  try {
    if (typeof console !== 'undefined' && console.error) console.error.apply(console, arguments)
  } catch (e) { /* Implementation note. */ }
}

// Implementation note.
// Implementation note.
export function getReact() {
  if (typeof require === 'function') {
    try { return require('react') } catch (e) { /* Implementation note. */ }
  }
  if (typeof globalThis !== 'undefined' && globalThis.React) return globalThis.React
  return null
}

// Implementation note.
export function getLang() {
  try {
    const l = (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang) ||
      (typeof navigator !== 'undefined' && navigator.language) || 'en'
    return /^zh/i.test(l) ? 'zh' : 'en'
  } catch (e) {
    return 'en'
  }
}

// Implementation note.
// Implementation note.
export function isHostDark() {
  try {
    if (!hasDom() || !document.body || typeof document.body.hasAttribute !== 'function') return true
    return document.body.hasAttribute('data-ds-dark-theme')
  } catch (e) {
    return true
  }
}

// Implementation note.
export function isFontAvailable(family, bundledFonts) {
  try {
    const bundled = bundledFonts || (typeof globalThis !== 'undefined' && globalThis.__dshPaletteBundledFonts) || null
    if (bundled && bundled.indexOf && bundled.indexOf(family) >= 0) return true
    if (hasDom() && document.fonts && typeof document.fonts.check === 'function') {
      return document.fonts.check('12px "' + family + '"')
    }
  } catch (e) { /* Implementation note. */ }
  return true
}

// Implementation note.
// Implementation note.
// Implementation note.

function clampSize(v) {
  const n = Math.round(Number(v))
  if (!isFinite(n)) return DEFAULT_TYPOGRAPHY.size
  if (n < 8) return 8
  if (n > 32) return 32
  return n
}

function safeThemeNames(deps) {
  try {
    if (deps && typeof deps.themeNames === 'function') {
      const names = deps.themeNames()
      if (Array.isArray(names) && names.length) return names
    }
  } catch (e) { /* Implementation note. */ }
  return null
}

// Implementation note.
// Implementation note.
export function sanitizeTheme(name, deps, fallback) {
  const fb = typeof fallback === 'string' && fallback ? fallback : DEFAULT_REGION_THEME
  if (typeof name !== 'string') return fb
  const v = name.trim()
  if (!v) return fb
  if (v === 'system') return v // Implementation note.
  const names = safeThemeNames(deps)
  if (names && names.indexOf(v) < 0) return fb
  return v
}

export function normalizeTypography(raw, deps, notes) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const typography = {
    mode: src.mode == null ? DEFAULT_TYPOGRAPHY.mode : src.mode === 'tui' ? 'tui' : 'mono',
    size: clampSize(src.size === undefined || src.size === null ? DEFAULT_TYPOGRAPHY.size : src.size),
    fontKey: typeof src.fontKey === 'string' && src.fontKey.trim() ? src.fontKey.trim() : DEFAULT_TYPOGRAPHY.fontKey,
  }
  const fonts = deps && deps.FONTS && typeof deps.FONTS === 'object' ? deps.FONTS : null
  if (fonts && !Object.prototype.hasOwnProperty.call(fonts, typography.fontKey)) {
    if (notes) notes.push('unknown font "' + typography.fontKey + '" → "' + DEFAULT_TYPOGRAPHY.fontKey + '"')
    typography.fontKey = DEFAULT_TYPOGRAPHY.fontKey
  }
  return typography
}

export function normalizeFeatures(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const features = {}
  for (const key in src) if (typeof src[key] === 'boolean') features[key] = src[key]
  for (const key in FEATURE_DEFAULTS) {
    if (typeof features[key] !== 'boolean') features[key] = FEATURE_DEFAULTS[key]
  }
  return features
}

// Implementation note.
// Implementation note.
// Implementation note.
export function normalizeState(raw, deps) {
  const notes = []
  const src = raw && typeof raw === 'object' ? raw : {}
  const enabled = typeof src.enabled === 'boolean' ? src.enabled : DEFAULT_STATE.enabled

  // Implementation note.
  const legacyShape = !src.regions || typeof src.regions !== 'object'

  let legacyTheme = null
  if (legacyShape) {
    legacyTheme = sanitizeTheme(src.theme, deps, DEFAULT_REGION_THEME)
    if (src.theme !== undefined && src.theme !== legacyTheme) {
      notes.push('legacy theme "' + src.theme + '" was replaced with "' + legacyTheme + '"')
    }
    notes.push('v1.7.1 → v2 migration: theme "' + legacyTheme + '" was assigned to the conversation region and copied to the other regions')
  }

  const regions = {}
  for (let i = 0; i < REGION_IDS.length; i++) {
    const id = REGION_IDS[i]
    const fallback = legacyShape ? legacyTheme : DEFAULT_REGION_THEME
    const r = legacyShape ? null : (src.regions ? src.regions[id] : null)
    if (r && typeof r === 'object') {
      regions[id] = {
        enabled: typeof r.enabled === 'boolean' ? r.enabled : true,
        theme: sanitizeTheme(r.theme, deps, fallback),
      }
    } else {
      if (!legacyShape && src.regions) notes.push('region ' + id + ' was missing → added with defaults')
      regions[id] = { enabled: true, theme: fallback }
    }
  }

  // Implementation note.
  const typography = normalizeTypography(legacyShape ? src : src.typography, deps, notes)

  return {
    state: { enabled: enabled, regions: regions, typography: typography, features: normalizeFeatures(src.features) },
    migrated: legacyShape,
    notes: notes,
  }
}

// Implementation note.
// v0.2.0 stored an all-`system` state by default, which made enabling CDSH look
// identical to disabling it. Upgrade only that exact untouched palette shape;
// any disabled region or non-system theme is an explicit user choice and wins.
export function isNoopV1Default(raw) {
  if (!raw || typeof raw !== 'object' || raw.enabled !== true || !raw.regions || typeof raw.regions !== 'object') return false
  for (let i = 0; i < REGION_IDS.length; i++) {
    const region = raw.regions[REGION_IDS[i]]
    if (!region || typeof region !== 'object' || region.enabled !== true || region.theme !== 'system') return false
  }
  return true
}

export function loadState(deps) {
  const result = { state: normalizeState(null, deps).state, source: 'defaults', notes: [], migrated: false, error: null }
  if (!hasStorage()) return result
  let rawText = null
  let sourceKey = null
  try {
    rawText = globalThis.localStorage.getItem(STORAGE_KEY)
    if (rawText) {
      sourceKey = STORAGE_KEY
    } else {
      for (let i = 0; i < LEGACY_STORAGE_KEYS.length; i++) {
        const k = LEGACY_STORAGE_KEYS[i]
        const legacy = globalThis.localStorage.getItem(k)
        if (legacy) { rawText = legacy; sourceKey = k; break }
      }
    }
  } catch (e) {
    result.error = e
    return result
  }
  if (!rawText) return result

  let parsed = null
  try {
    parsed = JSON.parse(rawText)
  } catch (e) {
    fail(LOG, 'saved state is corrupt (' + sourceKey + '); using defaults:', e)
    result.error = e
    result.source = sourceKey + ':corrupt'
    return result
  }

  const migrateNoopDefault = sourceKey === NOOP_DEFAULT_STORAGE_KEY && isNoopV1Default(parsed)
  if (migrateNoopDefault) parsed = { ...parsed, regions: defaultRegions(DEFAULT_REGION_THEME) }

  const norm = normalizeState(parsed, deps)
  result.state = norm.state
  result.notes = migrateNoopDefault
    ? ['CDSH v0.2.0 all-system default → visible CDSH Default palette'].concat(norm.notes)
    : norm.notes
  result.migrated = norm.migrated || migrateNoopDefault
  result.source = sourceKey
  // Implementation note.
  // Implementation note.
  if (sourceKey !== STORAGE_KEY) saveState(result.state)
  return result
}

export function saveState(state) {
  if (!hasStorage()) return false
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      enabled: state.enabled,
      regions: state.regions,
      typography: state.typography,
      features: normalizeFeatures(state.features),
    }))
    return true
  } catch (e) { /* Implementation note. */
    return false
  }
}

// Implementation note.
// Implementation note.
// Implementation note.

const COMMENT_RE = /\/\*[\s\S]*?\*\//g
// Implementation note.
const GLOBAL_RULE_RE = /(^|[}])(\s*)((?::root|html|body(?:\[[^\]]*\])?)(?:\s*,\s*(?::root|html|body(?:\[[^\]]*\])?))*)(\s*)\{/g
const GLOBAL_TOKEN_RE = /(^|[},])(\s*)(:root|html|body(?:\[[^\]]*\])?)(\s*)(?=[{,])/g

function stripComments(css) {
  return String(css).replace(COMMENT_RE, '')
}

export function hasGlobalSelector(css) {
  const text = stripComments(css)
  // Implementation note.
  GLOBAL_RULE_RE.lastIndex = 0
  GLOBAL_TOKEN_RE.lastIndex = 0
  return GLOBAL_RULE_RE.test(text) || GLOBAL_TOKEN_RE.test(text)
}

// Implementation note.
// Implementation note.
// Implementation note.
export function reanchorCss(css, anchors) {
  const sel = anchors.join(',')
  GLOBAL_RULE_RE.lastIndex = 0
  GLOBAL_TOKEN_RE.lastIndex = 0
  let out = String(css).replace(GLOBAL_RULE_RE, function (m, pre, sp, list, sp2) {
    return pre + sp + sel + sp2 + '{'
  })
  out = out.replace(GLOBAL_TOKEN_RE, function (m, pre, sp, token, sp2) {
    return pre + sp + sel + sp2
  })
  return out
}

// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
function splitTopLevelRules(css) {
  const text = String(css)
  const rules = []
  let depth = 0
  let start = 0
  let preludeEnd = -1
  let quote = null
  let comment = false
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i)
    if (comment) {
      if (ch === '*' && text.charAt(i + 1) === '/') { comment = false; i++ }
      continue
    }
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '/' && text.charAt(i + 1) === '*') { comment = true; i++; continue }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '{') {
      if (depth === 0) preludeEnd = i
      depth++
      continue
    }
    if (ch === '}') {
      depth--
      if (depth === 0 && preludeEnd >= 0) {
        rules.push({ prelude: text.slice(start, preludeEnd), body: text.slice(preludeEnd + 1, i) })
        start = i + 1
        preludeEnd = -1
      }
      continue
    }
  }
  return { rules: rules, tail: text.slice(start) }
}

// Implementation note.
// Implementation note.
const NESTED_AT_RULES = ['@media', '@supports', '@layer', '@container', '@document']

function isGlobalTokenSelector(sel) {
  return /^(:root|html|body(?:\[[^\]]*\])?)$/.test(sel)
}

function scopeSelector(sel, anchors) {
  const s = sel.trim()
  if (!s) return s
  // Implementation note.
  for (let i = 0; i < anchors.length; i++) {
    if (s.indexOf(anchors[i]) >= 0) return s
  }
  // Implementation note.
  if (isGlobalTokenSelector(s)) return anchors.join(',')
  const out = []
  for (let i = 0; i < anchors.length; i++) out.push(anchors[i] + ' ' + s)
  return out.join(',')
}

// Implementation note.
// Implementation note.
function splitDeclarations(prelude) {
  const i = prelude.lastIndexOf(';')
  if (i < 0) return { decls: '', selector: prelude }
  return { decls: prelude.slice(0, i + 1), selector: prelude.slice(i + 1) }
}

// Implementation note.
export function scopeBlockCss(css, anchors) {
  if (!anchors || !anchors.length) return String(css)
  const parsed = splitTopLevelRules(css)
  const parts = []
  for (let i = 0; i < parsed.rules.length; i++) {
    const rule = parsed.rules[i]
    const split = splitDeclarations(rule.prelude)
    if (split.decls.trim()) parts.push(anchors.join(',') + '{' + split.decls + '}')
    const sel = split.selector.trim()
    if (!sel) { parts.push(split.selector + '{' + rule.body + '}'); continue }
    if (sel.charAt(0) === '@') {
      let nested = false
      for (let k = 0; k < NESTED_AT_RULES.length; k++) {
        if (sel.indexOf(NESTED_AT_RULES[k]) === 0) { nested = true; break }
      }
      parts.push(nested ? split.selector + '{' + scopeBlockCss(rule.body, anchors) + '}' : split.selector + '{' + rule.body + '}')
      continue
    }
    const list = sel.split(',')
    const rewritten = []
    for (let k = 0; k < list.length; k++) rewritten.push(scopeSelector(list[k], anchors))
    parts.push(split.selector.replace(sel, rewritten.join(',')) + '{' + rule.body + '}')
  }
  const tail = parsed.tail || ''
  if (tail.trim()) {
    if (!stripComments(tail).trim()) parts.push(tail)
    else if (tail.indexOf('{') < 0) parts.push(anchors.join(',') + '{' + tail.trim() + '}')
    else parts.push(tail)
  }
  return parts.join('')
}

// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
export function normalizeBlockCss(result, anchors, options) {
  const opts = options || {}
  const raw = result == null ? '' : (typeof result === 'string' ? result : (typeof result.css === 'string' ? result.css : ''))
  const css = raw.trim()
  if (!css) return { css: '', mode: 'empty', reanchored: false, scoped: false, rejected: false }
  if (!anchors || !anchors.length) return { css: '', mode: 'empty', reanchored: false, scoped: false, rejected: true }
  if (css.indexOf('{') < 0) {
    // Implementation note.
    return { css: anchors.join(',') + '{' + css + '}', mode: 'declarations', reanchored: false, scoped: false, rejected: false }
  }
  let out = css
  let reanchored = false
  if (hasGlobalSelector(out)) {
    const next = reanchorCss(out, anchors)
    if (next !== out) { out = next; reanchored = true }
  }
  let scoped = false
  if (opts.scope !== false) {
    const next = scopeBlockCss(out, anchors)
    if (next !== out) { out = next; scoped = true }
  }
  if (opts.strict !== false && hasGlobalSelector(out)) {
    return { css: '', mode: 'rules', reanchored: reanchored, scoped: scoped, rejected: true }
  }
  return { css: out, mode: 'rules', reanchored: reanchored, scoped: scoped, rejected: false }
}

// Implementation note.
// Implementation note.
let stubWarned = false
function stubGenerateRegionCss(themeName, regionName) {
  if (!stubWarned) {
    stubWarned = true
    warn(LOG, 'region generator is unavailable — color blocks are empty; only typography remains active')
  }
  return { css: '', meta: { stub: true, theme: themeName, region: regionName } }
}

// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
const GENERIC_SANS = ['system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'].join(',')
const GENERIC_MONO = ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'Liberation Mono', 'monospace'].join(',')
// Implementation note.
const DEFAULT_FONTS = {
  'JetBrains Mono': "'JetBrains Mono','Fira Code','Cascadia Code','IBM Plex Mono','SF Mono',Consolas,Menlo,'Liberation Mono','Courier New','PingFang SC','Microsoft YaHei'",
  'Cascadia Code': "'Cascadia Code','JetBrains Mono','Fira Code','IBM Plex Mono','SF Mono',Consolas,'Courier New','PingFang SC','Microsoft YaHei'",
  'Fira Code': "'Fira Code','JetBrains Mono','Cascadia Code','IBM Plex Mono','SF Mono',Consolas,'Courier New','PingFang SC','Microsoft YaHei'",
  'IBM Plex Mono': "'IBM Plex Mono','JetBrains Mono','Fira Code','Cascadia Code','SF Mono',Consolas,'Courier New','PingFang SC','Microsoft YaHei'",
  'SF Mono': "'SF Mono','JetBrains Mono','Fira Code','Cascadia Code','IBM Plex Mono',Consolas,'Courier New','PingFang SC','Microsoft YaHei'",
  'Consolas': "Consolas,'JetBrains Mono','Fira Code','Cascadia Code','IBM Plex Mono','SF Mono','Courier New','PingFang SC','Microsoft YaHei'",
}
const DEFAULT_SANS_STACK = [
  "'Segoe UI'", 'system-ui', 'sans-serif',
].join(', ')

function toFontStack(v, fallback) {
  if (Array.isArray(v)) return v.length ? v.join(',') : fallback
  if (typeof v === 'string' && v.trim()) return v
  return fallback
}

// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
export function typographyCss(typography, deps) {
  const t = typography || DEFAULT_TYPOGRAPHY
  const fonts = deps && deps.FONTS && typeof deps.FONTS === 'object' ? deps.FONTS : DEFAULT_FONTS
  const sans = toFontStack(deps && deps.SANS_STACK, DEFAULT_SANS_STACK)
  const codeFont = toFontStack(fonts[t.fontKey], toFontStack(fonts[DEFAULT_TYPOGRAPHY.fontKey], GENERIC_MONO))
  const bodyFont = t.mode === 'mono' ? codeFont : sans
  const size = t.size
  // General owns conversation size; Palette owns interface size and font families.
  const content = 'var(--dsh-content-font-size,' + size + 'px)'
  const lh = 'calc(' + content + ' + 9px)'
  const small = 'max(11px,calc(' + content + ' - 1px))'
  const face = deps && typeof deps.FONT_FACE_CSS === 'string'
    ? deps.FONT_FACE_CSS
    : (typeof FONT_FACE_CSS === 'string' ? FONT_FACE_CSS : '')
  const vars = [
    '--dsw-font-family:' + bodyFont + ';',
    '--ds-font-family-code:' + codeFont + ';',
    '--dsw-font-markdown-base:' + content + '/' + lh + ' var(--dsw-font-family);',
    '--dsw-font-markdown-base-font-size:' + content + ';',
    '--dsw-font-markdown-base-line-height:' + lh + ';',
    '--dsw-font-markdown-h1:700 calc(' + content + ' + 3px)/1.5 var(--dsw-font-family);',
    '--dsw-font-markdown-h1-font-size:calc(' + content + ' + 3px);',
    '--dsw-font-markdown-h1-line-height:1.5;',
    '--dsw-font-markdown-h2:700 calc(' + content + ' + 2px)/1.5 var(--dsw-font-family);',
    '--dsw-font-markdown-h2-font-size:calc(' + content + ' + 2px);',
    '--dsw-font-markdown-h2-line-height:1.5;',
    '--dsw-font-markdown-h3:600 calc(' + content + ' + 1px)/1.5 var(--dsw-font-family);',
    '--dsw-font-markdown-h3-font-size:calc(' + content + ' + 1px);',
    '--dsw-font-markdown-h3-line-height:1.5;',
    '--dsw-font-markdown-small:' + small + '/1.6 var(--dsw-font-family);',
    '--dsw-font-markdown-small-font-size:' + small + ';',
    '--dsw-font-markdown-small-line-height:1.6;',
  ].join('')
  return face + TYPOGRAPHY_ANCHORS.join(',') + '{' + vars + '}' + 'body{font-size:' + size + 'px;}'
}

// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.

const STALE_SELECTOR = 'style[' + ATTR_PLUGIN + '="' + PLUGIN_ID + '"],[data-dsh-palette-style],style[' + ATTR_STYLE + '],style[' + ATTR_PLUGIN + '="' + LEGACY_PLUGIN_IDS[0] + '"]'

// Implementation note.
// Implementation note.
// Implementation note.
export const ATTR_INSTANCE = 'data-dsh-palette-instance'
let instanceSeq = 0
let activeInstance = 0

function instanceAttrSelector(id) { return '[' + ATTR_INSTANCE + '="' + id + '"]' }

function isLiveForeignNode(node, instanceId) {
  if (!node || typeof node.getAttribute !== 'function') return false
  let inst = null
  try { inst = node.getAttribute(ATTR_INSTANCE) } catch (e) { return false }
  return !!inst && inst !== instanceId
}

function queryAll(selector) {
  if (!hasDom() || typeof document.querySelectorAll !== 'function') return []
  try {
    const list = document.querySelectorAll(selector)
    const out = []
    for (let i = 0; i < list.length; i++) out.push(list[i])
    return out
  } catch (e) {
    return []
  }
}

function headNode() {
  if (!hasDom()) return null
  return document.head || (document.getElementsByTagName ? document.getElementsByTagName('head')[0] : null) || null
}

/* Implementation note.

















 */
export function createNodeStyleSink(layer, ownerId) {
  const nodes = []
  const name = typeof layer === 'string' && layer.length > 0 ? layer : 'nodes'
  let seq = 0

  function detach(node) {
    if (!node) return
    try {
      if (node.parentNode) node.parentNode.removeChild(node)
      else if (typeof node.remove === 'function') node.remove()
    } catch (e) { /* Implementation note. */ }
  }

  return {
    get count() { return nodes.length },
    insert(css) {
      const text = css == null ? '' : String(css)
      let node = null
      if (text && hasDom()) {
        try {
          node = document.createElement('style')
          node.setAttribute('data-dsh-palette-nodes', '1')
          node.setAttribute(ATTR_INSTANCE, ownerId || name + '-' + (++seq))
          node.setAttribute('data-dsh-palette-layer', name)
          if (node.dataset) node.dataset.plugin = PLUGIN_ID
          node.textContent = text
          const head = headNode()
          if (head) head.appendChild(node)
          else node = null
        } catch (e) {
          node = null
        }
      }
      if (node) nodes.push(node)
      let done = false
      return function () {
        if (done) return
        done = true
        if (node) {
          const at = nodes.indexOf(node)
          if (at >= 0) nodes.splice(at, 1)
          detach(node)
        }
      }
    },
  }
}

export function createStyleStore(instanceId) {
  const id = instanceId || ('palette-' + (++instanceSeq) + '-' + Date.now().toString(36))
  let styleEl = null
  let text = ''

  // Implementation note.
  // Implementation note.
  function sweep() {
    let removed = 0
    const nodes = queryAll(STALE_SELECTOR)
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      if (n === styleEl) continue
      if (n.getAttribute(ATTR_INSTANCE) === id) continue
      detach(n)
      removed++
    }
    return removed
  }

  function ensureNode() {
    if (!hasDom()) return null
    if (styleEl && styleEl.parentNode) return styleEl
    if (!styleEl) {
      styleEl = document.createElement('style')
      try {
        styleEl.setAttribute(ATTR_PLUGIN, PLUGIN_ID)
        styleEl.setAttribute(ATTR_STYLE, '1')
        styleEl.setAttribute(ATTR_INSTANCE, id)
        if (styleEl.dataset) styleEl.dataset.plugin = PLUGIN_ID
      } catch (e) { /* Implementation note. */ }
    }
    const head = headNode()
    if (head) {
      try { head.appendChild(styleEl) } catch (e) { return null }
    }
    return styleEl
  }

  function detach(node) {
    if (!node) return
    try {
      if (node.parentNode) node.parentNode.removeChild(node)
      else if (typeof node.remove === 'function') node.remove()
    } catch (e) { /* Implementation note. */ }
  }

  function setText(css) {
    const next = css == null ? '' : String(css)
    // Implementation note.
    if (!next) {
      detach(styleEl)
      text = ''
      return null
    }
    const el = ensureNode()
    if (!el) { text = ''; return null }
    text = next
    if (el.textContent !== next) {
      try { el.textContent = next } catch (e) { /* Implementation note. */ }
    }
    return el
  }

  // Implementation note.
  // Implementation note.
  function remove() {
    const nodes = queryAll(STALE_SELECTOR)
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      if (isLiveForeignNode(n, id)) continue
      detach(n)
    }
    if (!isLiveForeignNode(styleEl, id)) detach(styleEl)
    styleEl = null
    text = ''
  }

  return {
    id: id,
    setText: setText,
    remove: remove,
    sweep: sweep,
    get text() { return text },
    get textLength() { return text ? text.length : 0 },
    get node() { return styleEl },
    nodesInDocument: function () { return queryAll(STALE_SELECTOR).length },
    ownNodesInDocument: function () { return queryAll(instanceAttrSelector(id)).length },
  }
}

// Implementation note.
export function createAnchorRegistry() {
  const anchors = {}
  for (let i = 0; i < REGION_IDS.length; i++) {
    const id = REGION_IDS[i]
    anchors[id] = (DEFAULT_REGION_ANCHORS[id] || []).slice()
  }
  const claimed = new Map() // node -> { region, prevRegion, owned }

  function isRegion(id) { return REGION_IDS.indexOf(id) >= 0 }

  function get(id) { return isRegion(id) ? anchors[id].slice() : [] }

  function set(id, selectors) {
    if (!isRegion(id)) return false
    const list = []
    if (typeof selectors === 'string') list.push(selectors)
    else if (Array.isArray(selectors)) {
      for (let i = 0; i < selectors.length; i++) {
        const s = selectors[i]
        if (typeof s === 'string' && s.trim()) list.push(s.trim())
      }
    }
    anchors[id] = list.length ? list : []
    return true
  }

  function reset(id) {
    if (id === undefined) {
      for (let i = 0; i < REGION_IDS.length; i++) {
        const rid = REGION_IDS[i]
        anchors[rid] = (DEFAULT_REGION_ANCHORS[rid] || []).slice()
      }
      return true
    }
    if (!isRegion(id)) return false
    anchors[id] = (DEFAULT_REGION_ANCHORS[id] || []).slice()
    return true
  }

  // Implementation note.
  function claim(node, region) {
    if (!node || !isRegion(region) || typeof node.setAttribute !== 'function') return function () {}
    let prevRegion = null
    let owned = false
    try {
      prevRegion = typeof node.getAttribute === 'function' ? node.getAttribute(ATTR_REGION) : null
      owned = typeof node.getAttribute === 'function' && node.getAttribute(ATTR_OWNED) !== null
      node.setAttribute(ATTR_REGION, region)
      node.setAttribute(ATTR_OWNED, '1')
    } catch (e) {
      return function () {}
    }
    const rec = { node: node, prevRegion: prevRegion, owned: owned }
    claimed.set(node, rec)
    let released = false
    return function release() {
      if (released) return
      released = true
      claimed.delete(node)
      try {
        if (prevRegion === null) node.removeAttribute(ATTR_REGION)
        else node.setAttribute(ATTR_REGION, prevRegion)
        if (!owned) node.removeAttribute(ATTR_OWNED)
      } catch (e) { /* Implementation note. */ }
    }
  }

  // Implementation note.
  function releaseAll() {
    const releasers = []
    claimed.forEach(function (rec) { releasers.push(rec) })
    for (let i = 0; i < releasers.length; i++) {
      const rec = releasers[i]
      try {
        if (rec.prevRegion === null) rec.node.removeAttribute(ATTR_REGION)
        else rec.node.setAttribute(ATTR_REGION, rec.prevRegion)
        if (!rec.owned) rec.node.removeAttribute(ATTR_OWNED)
      } catch (e) { /* Implementation note. */ }
    }
    claimed.clear()
    const stray = queryAll('[' + ATTR_OWNED + ']')
    for (let i = 0; i < stray.length; i++) {
      try {
        stray[i].removeAttribute(ATTR_OWNED)
        if (stray[i].getAttribute(ATTR_REGION) !== null) stray[i].removeAttribute(ATTR_REGION)
      } catch (e) { /* Implementation note. */ }
    }
    return stray.length
  }

  function list() {
    const out = {}
    for (let i = 0; i < REGION_IDS.length; i++) out[REGION_IDS[i]] = anchors[REGION_IDS[i]].slice()
    return out
  }

  return {
    get: get,
    set: set,
    reset: reset,
    list: list,
    claim: claim,
    releaseAll: releaseAll,
    isRegion: isRegion,
    claimedCount: function () { return claimed.size },
  }
}

// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.

export function getPaletteBus() {
  const g = globalThis
  if (g.__dshPaletteBus && typeof g.__dshPaletteBus.publish === 'function' && typeof g.__dshPaletteBus.subscribe === 'function') {
    return { bus: g.__dshPaletteBus, created: false }
  }
  const listeners = []
  let current = null
  const bus = {
    version: PALETTE_VERSION,
    get api() { return current },
    subscribe: function (fn) {
      if (typeof fn !== 'function') return function () {}
      listeners.push(fn)
      if (current) { try { fn(current) } catch (e) { /* Implementation note. */ } }
      let done = false
      return function () {
        if (done) return
        done = true
        const i = listeners.indexOf(fn)
        if (i >= 0) listeners.splice(i, 1)
      }
    },
    publish: function (api) {
      current = api
      const snapshot = listeners.slice()
      for (let i = 0; i < snapshot.length; i++) {
        try { snapshot[i](api) } catch (e) { /* Implementation note. */ }
      }
    },
    clear: function (api) {
      if (current === api) current = null
    },
  }
  g.__dshPaletteBus = bus
  return { bus: bus, created: true }
}

// Implementation note.
// Implementation note.
// Implementation note.

// Implementation note.
// Implementation note.
function applyModule(deps, mod, source) {
  if (!mod || typeof mod !== 'object') return deps
  const pick = function (name) {
    if (typeof mod[name] === 'function') return mod[name]
    if (mod.default && typeof mod.default[name] === 'function') return mod.default[name]
    return null
  }
  const gen = pick('generateRegionCss')
  if (gen) { deps.generateRegionCss = gen; deps.sources.push(source) }
  const typo = pick('generateTypographyCss')
  if (typo) deps.generateTypographyCss = typo
  const names = pick('themeNames') || pick('listThemes')
  if (names) deps.themeNames = names
  const previews = pick('previewColors')
  if (previews) deps.previewColors = previews
  const groups = pick('themeGroups')
  if (groups) deps.themeGroups = groups
  const regions = pick('listRegions')
  if (regions) deps.listRegions = regions
  if (mod.FONTS && typeof mod.FONTS === 'object') deps.FONTS = mod.FONTS
  if (mod.SANS_STACK) deps.SANS_STACK = mod.SANS_STACK
  if (typeof mod.FONT_FACE_CSS === 'string') deps.FONT_FACE_CSS = mod.FONT_FACE_CSS
  if (Array.isArray(mod.BUNDLED_FONTS)) deps.BUNDLED_FONTS = mod.BUNDLED_FONTS
  return deps
}

function createDeps(options) {
  const deps = {
    generateRegionCss: typeof generateRegionCss === 'function' ? generateRegionCss : stubGenerateRegionCss,
    generateTypographyCss: null,
    themeNames: typeof listThemes === 'function' ? listThemes : null,
    previewColors: null,
    themeGroups: null,
    listRegions: typeof listRegions === 'function' ? listRegions : null,
    FONTS: DEFAULT_FONTS,
    SANS_STACK: DEFAULT_SANS_STACK,
    FONT_FACE_CSS: typeof FONT_FACE_CSS === 'string' ? FONT_FACE_CSS : '',
    BUNDLED_FONTS: Array.isArray(BUNDLED_FONTS) ? BUNDLED_FONTS : [],
    sources: [],
    error: null,
    resolved: true,
  }
  applyModule(deps, options.generator || options.engine || null, 'options')
  if (options.fontFaces === false) deps.FONT_FACE_CSS = ''
  return deps
}

function registerEffect(ctx, label, fn) {
  if (ctx && typeof ctx.effect === 'function') {
    try { return ctx.effect(fn, label) }
    catch (e) {
      // Cordis may have entered the effect before propagating the exception.
      // Running fn again here would duplicate registrations and ownership.
      warn(LOG, 'ctx.effect(' + label + ') failed:', e)
      return function () {}
    }
  }
  // Implementation note.
  let d = null
  try { d = fn() } catch (e) { warn(LOG, label + ':', e) }
  return typeof d === 'function' ? d : function () {}
}

function ctxGet(ctx, name) {
  try {
    if (ctx && typeof ctx.get === 'function') return ctx.get(name)
  } catch (e) { /* Implementation note. */ }
  return undefined
}

/* Implementation note.
































 */
export function createClient(options) {
  // Implementation note.
  const opts = typeof options === 'string' ? { slotTarget: options } : (options || {})

  return function apply(ctx) {
    const deps = createDeps(opts)
    const useStorage = opts.storage !== false
    const strict = opts.strict !== false

    const store = createStyleStore()
    // Implementation note.
    // Implementation note.
    const myInstance = ++instanceSeq
    activeInstance = myInstance
    const isActiveInstance = function () { return myInstance === activeInstance }
    const canMutate = function () { return !disposed && isActiveInstance() }
    const registry = createAnchorRegistry()
    if (opts.anchors && typeof opts.anchors === 'object') {
      for (const region in opts.anchors) {
        if (Object.prototype.hasOwnProperty.call(opts.anchors, region)) registry.set(region, opts.anchors[region])
      }
    }
    // Implementation note.
    if (typeof globalThis !== 'undefined' && globalThis.__dshPaletteAnchors && typeof globalThis.__dshPaletteAnchors === 'object') {
      for (const region in globalThis.__dshPaletteAnchors) {
        if (Object.prototype.hasOwnProperty.call(globalThis.__dshPaletteAnchors, region)) {
          registry.set(region, globalThis.__dshPaletteAnchors[region])
        }
      }
    }

    const loaded = useStorage ? loadState(deps) : { state: normalizeState(null, deps).state, source: 'defaults', notes: [], migrated: false }
    let state = loaded.state
    let disposed = false
    let lastMeta = { applied: [], skipped: [], reanchored: [], scoped: [], rejected: [], typography: false, stub: false, cssLength: 0 }
    let lastCss = ''
    const featureStatus = {}
    for (const key in FEATURE_DEFAULTS) featureStatus[key] = {
      status: !state.enabled || !state.features[key] ? 'disabled' : 'waiting',
      detail: !state.enabled ? 'CDSH is disabled.' : !state.features[key] ? 'Disabled by preference.' : 'Waiting for a compatible DSH surface.',
    }

    // Implementation note.
    const listeners = []
    const localeListeners = []

    function notify(reason) {
      const current = listeners.slice()
      for (let i = 0; i < current.length; i++) {
        // A listener may synchronously report a compatibility change, causing a
        // nested notify. Re-snapshot for every listener so the outer delivery can
        // never overwrite that newer state with a stale pre-listener payload.
        try { current[i](snapshotState(), reason) } catch (e) { warn(LOG, 'state subscriber failed:', e) }
      }
      return snapshotState()
    }

    function snapshotState() {
      const regions = {}
      for (let i = 0; i < REGION_IDS.length; i++) {
        const id = REGION_IDS[i]
        const r = state.regions[id]
        regions[id] = { enabled: !!r.enabled, theme: r.theme }
      }
      const features = {}
      for (const key in state.features) features[key] = !!state.features[key]
      const compatibility = {}
      for (const key in featureStatus) compatibility[key] = { status: featureStatus[key].status, detail: featureStatus[key].detail }
      return {
        enabled: !!state.enabled,
        regions: regions,
        typography: { mode: state.typography.mode, size: state.typography.size, fontKey: state.typography.fontKey },
        features: features,
        compatibility: compatibility,
      }
    }

    function subscribe(fn) {
      if (!canMutate() || typeof fn !== 'function') return function () {}
      listeners.push(fn)
      let done = false
      return function () {
        if (done) return
        done = true
        const i = listeners.indexOf(fn)
        if (i >= 0) listeners.splice(i, 1)
      }
    }

    // Implementation note.
    const localeSvc = ctxGet(ctx, 'locale') || (ctx && ctx.locale) || null
    let currentLang = localeSvc && typeof localeSvc.getLocale === 'function' ? localeSvc.getLocale().active : getLang()
    let dictDispose = null
    let localeUnsub = null
    let localeObserver = null

    function currentLocale() {
      try {
        return localeSvc && typeof localeSvc.getLocale === 'function' ? localeSvc.getLocale().active : getLang()
      } catch (e) { return getLang() }
    }

    function tr(key) {
      const entry = I18N[key]
      if (!entry) return key
      const v = entry[currentLang]
      return v === undefined ? key : v
    }

    function notifyLocale() {
      const next = currentLocale()
      if (next === currentLang) return
      currentLang = next
      const snapshot = localeListeners.slice()
      for (let i = 0; i < snapshot.length; i++) {
        try { snapshot[i](currentLang) } catch (e) { /* Implementation note. */ }
      }
    }

    const LOCALE_NS = 'cdsh'
    if (localeSvc && typeof localeSvc.subscribe === 'function') {
      try { localeUnsub = localeSvc.subscribe(notifyLocale) } catch (e) { localeUnsub = null }
    } else if (typeof MutationObserver !== 'undefined' && hasDom() && document.documentElement) {
      try {
        localeObserver = new MutationObserver(notifyLocale)
        localeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
      } catch (e) { localeObserver = null }
    }
    if (localeSvc && typeof localeSvc.register === 'function') {
      try { dictDispose = localeSvc.register(LOCALE_NS, toLocaleDicts(I18N)) } catch (e) { dictDispose = null }
    }

    // Implementation note.
    // Implementation note.
    // Implementation note.
    function buildTypographyBlock() {
      const meta = { used: false, source: 'runtime', mode: 'rules' }
      const anchors = TYPOGRAPHY_ANCHORS.slice()
      if (typeof deps.generateTypographyCss === 'function') {
        try {
          const result = deps.generateTypographyCss(state.typography, { anchors: anchors, hostDark: isHostDark() })
          const norm = normalizeBlockCss(result, anchors, { strict: false, scope: false })
          meta.source = 'generateTypographyCss'
          meta.used = !!norm.css
          meta.mode = norm.mode
          if (norm.css) return { css: norm.css, meta: meta }
        } catch (e) {
          warn(LOG, 'generateTypographyCss failed; building typography locally:', e)
        }
      }
      const css = typographyCss(state.typography, deps)
      meta.used = !!css
      return { css: css, meta: meta }
    }

    // Implementation note.
    // Implementation note.
    // Implementation note.
    function regionBlock(theme, region, anchors, meta) {
      const parts = []
      for (let i = 0; i < anchors.length; i++) {
        const callOpts = {
          selector: anchors[i],
          strict: strict,
          // Implementation note.
        }
        if (opts.important !== undefined) callOpts.important = opts.important === true
        let result = null
        try {
          result = deps.generateRegionCss(theme, region, callOpts)
        } catch (e) {
          meta.rejected.push(region + ':' + (e && e.message ? e.message : String(e)))
          continue
        }
        if (result && result.meta && result.meta.stub) meta.stub = true
        const norm = normalizeBlockCss(result, [anchors[i]], { strict: strict, scope: opts.scope !== false })
        if (norm.rejected) {
          meta.rejected.push(region)
          fail(LOG, 'region block ' + region + ' (' + anchors[i] + ') was rejected: a global selector remains')
          continue
        }
        if (!norm.css) continue
        // Implementation note.
        // Implementation note.
        if (norm.reanchored && meta.reanchored.indexOf(region) < 0) meta.reanchored.push(region)
        if (norm.scoped && meta.scoped.indexOf(region) < 0) meta.scoped.push(region)
        parts.push(norm.css)
      }
      return parts.join('\n')
    }

    function buildCss() {
      const meta = { applied: [], skipped: [], reanchored: [], scoped: [], rejected: [], typography: null, stub: false }
      const blocks = []
      blocks.push('/* ' + PLUGIN_ID + ' v' + PALETTE_VERSION + ' — regional theming; the plugin\'s only <style> */')

      const typo = buildTypographyBlock()
      meta.typography = typo.meta
      if (typo.css) blocks.push('/* typography (independent axis) */' + typo.css)

      for (let i = 0; i < REGION_IDS.length; i++) {
        const region = REGION_IDS[i]
        const rs = state.regions[region]
        if (!rs || !rs.enabled) { meta.skipped.push(region + ':off'); continue }
        if (!rs.theme || rs.theme === 'system') { meta.skipped.push(region + ':system'); continue }
        const anchors = registry.get(region)
        if (!anchors.length) { meta.skipped.push(region + ':no-anchor'); continue }

        const css = regionBlock(rs.theme, region, anchors, meta)
        if (!css) { meta.skipped.push(region + ':empty'); continue }
        meta.applied.push(region)
        blocks.push('/* region:' + region + ' theme:' + rs.theme + ' */' + css)
      }

      const css = blocks.join('\n')
      meta.cssLength = css.length
      return { css: css, meta: meta }
    }

    // Implementation note.
    function mount() {
      if (disposed) return null
      if (!isActiveInstance()) return null // Implementation note.
      store.sweep()
      const built = buildCss()
      lastMeta = built.meta
      lastCss = built.css
      store.setText(built.css)
      return built
    }

    function teardown() {
      store.remove()
      lastCss = ''
      lastMeta = { applied: [], skipped: [], reanchored: [], scoped: [], rejected: [], typography: null, stub: false, cssLength: 0 }
    }

    function reconcile() {
      if (!canMutate()) return
      if (state.enabled) mount()
      else teardown()
    }

    function commit(reason, shouldReconcile) {
      if (!canMutate()) return snapshotState()
      if (useStorage) saveState(state)
      if (shouldReconcile !== false) reconcile()
      return notify(reason)
    }

    // Implementation note.
    function getState() { return snapshotState() }

    function replaceState(patch) {
      if (!canMutate()) return state
      state = {
        enabled: patch && patch.enabled !== undefined ? !!patch.enabled : state.enabled,
        regions: patch && patch.regions !== undefined ? patch.regions : state.regions,
        typography: patch && patch.typography !== undefined ? patch.typography : state.typography,
        features: patch && patch.features !== undefined ? normalizeFeatures(patch.features) : state.features,
      }
      return state
    }

    function reportFeatureStatus(feature, value, detail) {
      if (!canMutate() || !Object.prototype.hasOwnProperty.call(FEATURE_DEFAULTS, feature)) return false
      const next = { status: value || 'waiting', detail: typeof detail === 'string' ? detail : '' }
      const previous = featureStatus[feature]
      if (previous && previous.status === next.status && previous.detail === next.detail) return false
      featureStatus[feature] = next
      notify('compatibility:' + feature)
      return true
    }

    function setFeature(feature, value) {
      if (!Object.prototype.hasOwnProperty.call(FEATURE_DEFAULTS, feature)) return false
      const next = !!value
      if (state.features[feature] === next) return next
      const features = {}
      for (const key in state.features) features[key] = state.features[key]
      features[feature] = next
      replaceState({ features: features })
      commit('feature:' + feature, false)
      return next
    }

    function setEnabled(value) {
      const next = !!value
      if (state.enabled === next) return state.enabled
      replaceState({ enabled: next })
      commit(next ? 'enabled' : 'disabled')
      return state.enabled
    }

    function toggle() { return setEnabled(!state.enabled) }

    function setRegionTheme(region, theme) {
      if (REGION_IDS.indexOf(region) < 0) return false
      const next = sanitizeTheme(theme, deps, state.regions[region].theme)
      const cur = state.regions[region]
      if (cur.theme === next) return false
      const regions = {}
      for (let i = 0; i < REGION_IDS.length; i++) {
        const id = REGION_IDS[i]
        regions[id] = id === region ? { enabled: cur.enabled, theme: next } : state.regions[id]
      }
      replaceState({ regions: regions })
      commit('region:' + region)
      return true
    }

    function setRegionEnabled(region, value) {
      if (REGION_IDS.indexOf(region) < 0) return false
      const next = !!value
      const cur = state.regions[region]
      if (cur.enabled === next) return next
      const regions = {}
      for (let i = 0; i < REGION_IDS.length; i++) {
        const id = REGION_IDS[i]
        regions[id] = id === region ? { enabled: next, theme: cur.theme } : state.regions[id]
      }
      replaceState({ regions: regions })
      commit((next ? 'region-on:' : 'region-off:') + region)
      return next
    }

    function toggleRegion(region, force) {
      if (REGION_IDS.indexOf(region) < 0) return false
      const next = typeof force === 'boolean' ? force : !state.regions[region].enabled
      setRegionEnabled(region, next)
      return next
    }

    function setAllRegionsTheme(theme) {
      const next = sanitizeTheme(theme, deps, DEFAULT_REGION_THEME)
      const regions = {}
      for (let i = 0; i < REGION_IDS.length; i++) {
        const id = REGION_IDS[i]
        regions[id] = { enabled: state.regions[id].enabled, theme: next }
      }
      replaceState({ regions: regions })
      commit('regions:theme')
      return next
    }

    function setAllRegionsEnabled(value) {
      const next = !!value
      const regions = {}
      for (let i = 0; i < REGION_IDS.length; i++) {
        const id = REGION_IDS[i]
        regions[id] = { enabled: next, theme: state.regions[id].theme }
      }
      replaceState({ regions: regions })
      commit('regions:enabled')
      return next
    }

    function setTypography(next) {
      const merged = normalizeTypography(
        {
          mode: next && next.mode !== undefined ? next.mode : state.typography.mode,
          size: next && next.size !== undefined ? next.size : state.typography.size,
          fontKey: next && next.fontKey !== undefined ? next.fontKey : state.typography.fontKey,
        },
        deps
      )
      replaceState({ typography: merged })
      commit('typography')
      return { mode: merged.mode, size: merged.size, fontKey: merged.fontKey }
    }

    // Implementation note.
    function refresh(modeOrTypography, size, fontKey) {
      if (modeOrTypography === undefined) {
        reconcile()
        return notify('reapply')
      }
      const next = typeof modeOrTypography === 'object' && modeOrTypography !== null
        ? modeOrTypography
        : { mode: modeOrTypography, size: size, fontKey: fontKey }
      setTypography(next)
      return snapshotState()
    }

    function resetState() {
      const norm = normalizeState(null, deps)
      state = norm.state
      commit('reset')
      return snapshotState()
    }

    function markRegionRoot(node, region) {
      return canMutate() ? registry.claim(node, region) : false
    }

    function listThemes() {
      const names = safeThemeNames(deps)
      return names || []
    }

    function previews() {
      const names = listThemes()
      const fn = deps.previewColors
      if (typeof fn !== 'function') return []
      const out = []
      for (let i = 0; i < names.length; i++) {
        try { out.push({ name: names[i], colors: fn(names[i]) }) } catch (e) { out.push({ name: names[i], colors: null }) }
      }
      return out
    }

    function groups() {
      try {
        if (typeof deps.themeGroups === 'function') return deps.themeGroups()
      } catch (e) { /* Implementation note. */ }
      return []
    }

    // Implementation note.
    // Implementation note.
    // Implementation note.
    // Implementation note.
    // Implementation note.
    // Implementation note.
    function verifyClean() {
      const report = {
        dom: hasDom(),
        styleNodes: 0,
        ownNodes: 0,
        ownedNodes: 0,
        regionNodes: 0,
        styleTextLength: store.textLength,
        problems: [],
        warnings: [],
        ok: true,
      }
      if (!report.dom) { report.ok = false; report.problems.push('DOM is unavailable'); return report }
      report.styleNodes = store.nodesInDocument()
      report.ownNodes = store.ownNodesInDocument()
      report.ownedNodes = queryAll('[' + ATTR_OWNED + ']').length
      report.regionNodes = queryAll('[' + ATTR_REGION + ']').length
      if (report.styleNodes > 0) report.problems.push('our <style> remains in the document (' + report.styleNodes + ')')
      if (report.styleTextLength > 0) report.problems.push('style text was not cleared')
      if (report.styleNodes > report.ownNodes) report.warnings.push('a <style> from another plugin instance remains in the document (HMR/double start)')
      if (report.ownedNodes > 0) report.warnings.push('our region anchor attributes remain (' + report.ownedNodes + '); they are inert without styles and sweep() removes them')
      report.ok = report.problems.length === 0
      return report
    }

    function sweep() {
      if (!canMutate()) return { styles: 0, attributes: 0 }
      const removedStyles = store.sweep()
      const removedAttrs = registry.releaseAll()
      return { styles: removedStyles, attributes: removedAttrs }
    }

    function getCss() { return lastCss }
    function getMeta() { return lastMeta }
    function getAnchors() { return registry.list() }

    const api = {
      version: PALETTE_VERSION,
      pluginId: PLUGIN_ID,
      regionIds: REGION_IDS.slice(),
      regionMeta: REGION_META,
      // Implementation note.
      getState: getState,
      setEnabled: setEnabled,
      toggle: toggle,
      setRegionTheme: setRegionTheme,
      setRegionEnabled: setRegionEnabled,
      toggleRegion: toggleRegion,
      setAllRegionsTheme: setAllRegionsTheme,
      setAllRegionsEnabled: setAllRegionsEnabled,
      setTypography: setTypography,
      setFeature: setFeature,
      reportFeatureStatus: reportFeatureStatus,
      featureDefaults: FEATURE_DEFAULTS,
      refresh: refresh,
      resetState: resetState,
      subscribe: subscribe,
      subscribeLocale: function (fn) {
        if (!canMutate() || typeof fn !== 'function') return function () {}
        localeListeners.push(fn)
        let done = false
        return function () {
          if (done) return
          done = true
          const i = localeListeners.indexOf(fn)
          if (i >= 0) localeListeners.splice(i, 1)
        }
      },
      // i18n
      tr: tr,
      getLang: currentLocale,
      i18n: I18N,
      localeNs: LOCALE_NS,
      // Implementation note.
      list: listThemes,
      themeNames: listThemes,
      fonts: function () { return deps.FONTS || DEFAULT_FONTS },
      bundledFonts: function () { return deps.BUNDLED_FONTS || [] },
      isFontAvailable: function (family) { return isFontAvailable(family, deps.BUNDLED_FONTS) },
      isHostDark: isHostDark,
      // Implementation note.
      getAnchors: getAnchors,
      setRegionAnchors: function (region, selectors) {
        if (!canMutate()) return false
        const ok = registry.set(region, selectors)
        if (ok && state.enabled) { reconcile(); notify('anchors:' + region) }
        return ok
      },
      resetRegionAnchors: function (region) {
        if (!canMutate()) return false
        const ok = registry.reset(region)
        if (ok && state.enabled) { reconcile(); notify('anchors:reset') }
        return ok
      },
      markRegionRoot: markRegionRoot,
      // Implementation note.
      apply: function () { if (!canMutate()) return snapshotState(); reconcile(); return notify('reapply') },
      clear: function () { if (!canMutate()) return verifyClean(); teardown(); return verifyClean() },
      sweep: sweep,
      verifyClean: verifyClean,
      getCss: getCss,
      getMeta: getMeta,
      deps: deps,
      isEnabled: function () { return !!state.enabled },
    }

    // Implementation note.
    // Implementation note.
    if (typeof deps.previewColors === 'function') api.previews = previews
    if (typeof deps.themeGroups === 'function') api.groups = groups
    if (typeof deps.listRegions === 'function') {
      api.listRegions = function () {
        try { return deps.listRegions() } catch (e) { return REGION_IDS.slice() }
      }
    }

    // Implementation note.

    // Implementation note.
    registerEffect(ctx, PLUGIN_ID + ': styles', function () {
      if (opts.autoApply !== false) reconcile()
      return function () {
        disposed = true
        teardown()
      }
    })

    const asDisposer = function (value) {
      const dispose = typeof value === 'function'
        ? value
        : value && typeof value.dispose === 'function'
          ? function () { value.dispose() }
          : null
      if (!dispose) return function () {}
      let closed = false
      return function () {
        if (closed) return
        closed = true
        dispose()
      }
    }

    function superviseFeature(feature, services, installer) {
      registerEffect(ctx, PLUGIN_ID + ': feature ' + feature, function () {
        if (typeof installer !== 'function') {
          reportFeatureStatus(feature, state.features[feature] ? 'unsupported' : 'disabled', state.features[feature] ? 'This CDSH build does not provide the feature.' : 'Disabled by preference.')
          return function () {}
        }

        let branch = null
        let closed = false
        const activate = function (scope) {
          let mounted = null
          let mounting = false
          let attempted = false
          let retryPending = false
          const sync = function (_snapshot, reason) {
            if (closed) return
            const requested = !!state.features[feature]
            const enabled = !!state.enabled && requested
            if (!enabled) {
              const dispose = mounted
              mounted = null
              attempted = false
              retryPending = false
              if (dispose) { try { dispose() } catch (e) { warn(LOG, feature + ': dispose failed:', e) } }
              reportFeatureStatus(feature, 'disabled', state.enabled ? 'Disabled by preference.' : 'CDSH is disabled.')
              return
            }
            if (mounted || mounting || attempted) return
            // Compatibility reports from sibling supervisors are nested startup
            // bookkeeping, not a user/runtime change.  A transient failure waits
            // for the next ordinary notification instead of retrying in a loop.
            if (retryPending && typeof reason === 'string' && reason.indexOf('compatibility:') === 0) return
            mounting = true
            attempted = true
            reportFeatureStatus(feature, 'waiting', 'Connecting to the compatible DSH surface…')
            try {
              const installed = installer(scope, api)
              if (installed && installed.cdshRetryableFailure === true) {
                mounted = null
                attempted = false
                retryPending = true
              } else {
                mounted = asDisposer(installed)
                retryPending = false
              }
            } catch (error) {
              mounted = null
              // Avoid retrying inside nested compatibility notifications, but
              // allow the next ordinary state notification to recover.
              attempted = false
              retryPending = true
              reportFeatureStatus(feature, 'failed', String(error && (error.message || error) || error))
              warn(LOG, feature + ': mount failed:', error)
            } finally {
              mounting = false
            }
          }
          sync()
          const unsubscribe = subscribe(sync)
          return function () {
            if (typeof unsubscribe === 'function') unsubscribe()
            const dispose = mounted
            mounted = null
            attempted = false
            retryPending = false
            if (dispose) { try { dispose() } catch (e) { warn(LOG, feature + ': dispose failed:', e) } }
            if (!closed && state.enabled && state.features[feature]) {
              reportFeatureStatus(feature, 'waiting', 'Waiting for required DSH services.')
            }
          }
        }

        if (state.enabled && state.features[feature]) reportFeatureStatus(feature, 'waiting', 'Waiting for required DSH services.')
        else reportFeatureStatus(feature, 'disabled', state.enabled ? 'Disabled by preference.' : 'CDSH is disabled.')

        try {
          if (ctx && typeof ctx.inject === 'function') branch = ctx.inject(services, activate)
          else {
            const missing = services.some(function (name) { return !(ctx && ctx[name]) && ctxGet(ctx, name) === undefined })
            if (missing) reportFeatureStatus(feature, 'unsupported', 'Required DSH services are unavailable.')
            else branch = activate(ctx)
          }
        } catch (error) {
          reportFeatureStatus(feature, 'failed', String(error && (error.message || error) || error))
          warn(LOG, feature + ': injection failed:', error)
        }
        return function () {
          closed = true
          asDisposer(branch)()
        }
      })
    }

    superviseFeature('brand', ['slots'], opts.brand)
    superviseFeature('workspace', ['slots', 'sessions', 'uiConversation', 'sidebarRight', 'sidebarRightTabs'], opts.workspace)
    superviseFeature('turnInsights', ['slots'], opts.turnInsights)
    superviseFeature('planCopy', ['slots'], opts.planCopy)
    superviseFeature('focusView', ['slots'], opts.focusView)

    // Implementation note.
    // Implementation note.
    // Implementation note.
    // Implementation note.
    if (typeof opts.nodes === 'function') {
      registerEffect(ctx, PLUGIN_ID + ': nodes', function () {
        const sink = createNodeStyleSink('nodes', store.id)
        // Implementation note.
        // Implementation note.
        // Implementation note.
        const nodesCssOf = typeof opts.nodesCss === 'function' ? opts.nodesCss : null
        if (nodesCssOf === null) {
          fail(LOG, 'conversation layer: no CSS builder (nodesCss) was provided — layer styles were not attached')
          return function () {}
        }
        let shownCss = null
        let dropStyle = null

        const nodesEnabled = function () {
          try {
            const st = getState()
            return st === null || st === undefined ? true : st.enabled !== false
          } catch (e) { return true }
        }
        const syncNodesStyle = function () {
          try {
            if (nodesEnabled()) {
              if (dropStyle === null) dropStyle = sink.insert(nodesCssOf())
            } else if (dropStyle !== null) {
              try { dropStyle() } catch (e) { /* Implementation note. */ }
              dropStyle = null
            }
          } catch (e) { warn(LOG, 'conversation layer: styles could not be switched:', e) }
        }
        const wrappedSink = {
          insert(css) {
            if (typeof css !== 'string') {
              warn(LOG, 'conversation layer: insert() received a non-string (' + typeof css + ') — insertion skipped')
              return function () {}
            }
            shownCss = css
            dropStyle = sink.insert(nodesEnabled() ? css : '')
            return function () {
              if (dropStyle !== null) { try { dropStyle() } catch (e) { /* Implementation note. */ } dropStyle = null }
            }
          },
        }

        let dropNodes = null
        try {
          dropNodes = opts.nodes(ctx, { styles: wrappedSink })
        } catch (e) {
          fail(LOG, 'conversation rendering layer failed to mount:', e)
          return function () {}
        }
        if (nodesEnabled() && dropStyle === null) dropStyle = sink.insert(nodesCssOf())
        const unsubscribe = subscribe(function () { syncNodesStyle() })

        return function () {
          try { unsubscribe() } catch (e) { /* Implementation note. */ }
          try { if (typeof dropNodes === 'function') dropNodes() } catch (e) { /* Implementation note. */ }
          if (dropStyle !== null) { try { dropStyle() } catch (e) { /* Implementation note. */ } dropStyle = null }
        }
      })
    }

    // Implementation note.
    // Implementation note.
    // Implementation note.
    // Implementation note.
    // Implementation note.
    // Implementation note.
    // Implementation note.
    if (typeof opts.designCss === 'function') {
      registerEffect(ctx, PLUGIN_ID + ': design', function () {
        const sink = createNodeStyleSink('design', store.id)
        let dropStyle = null
        let lastCss = null

        const designEnabled = function () {
          try {
            const st = getState()
            return st === null || st === undefined ? true : st.enabled !== false
          } catch (e) { return true }
        }
        const syncDesignStyle = function () {
          try {
            if (designEnabled()) {
              const css = opts.designCss(getState())
              if (css !== lastCss || dropStyle === null) {
                if (dropStyle !== null) dropStyle()
                dropStyle = sink.insert(css)
                lastCss = css
              }
            } else if (dropStyle !== null) {
              try { dropStyle() } catch (e) { /* Implementation note. */ }
              dropStyle = null
            }
          } catch (e) { warn(LOG, 'design layer: styles could not be switched:', e) }
        }

        syncDesignStyle()
        const unsubscribe = subscribe(function () { syncDesignStyle() })

        return function () {
          try { unsubscribe() } catch (e) { /* Implementation note. */ }
          if (dropStyle !== null) { try { dropStyle() } catch (e) { /* Implementation note. */ } dropStyle = null }
        }
      })
    }

    // Implementation note.
    // Implementation note.
    // Implementation note.
    // Implementation note.
    // Implementation note.
    if (opts.toolMotion !== false) {
      registerEffect(ctx, PLUGIN_ID + ': tool-motion', function () {
        try {
          const mount = typeof opts.toolMotion === 'function' ? opts.toolMotion : installToolMotion
          return asDisposer(mount(ctx, api))
        } catch (e) {
          warn(LOG, 'tool-card motion failed to mount:', e)
          return function () {}
        }
      })
    }

    // Implementation note.
    // Implementation note.
    if (opts.watchHostTheme === true) {
      registerEffect(ctx, PLUGIN_ID + ': host-theme', function () {
        if (typeof MutationObserver === 'undefined' || !hasDom() || !document.body) return function () {}
        let obs = null
        try {
          obs = new MutationObserver(function () { reconcile() })
          obs.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
        } catch (e) { obs = null }
        return function () { try { if (obs) obs.disconnect() } catch (e) { /* Implementation note. */ } }
      })
    }

    // Implementation note.
    registerEffect(ctx, PLUGIN_ID + ': locale', function () {
      return function () {
        try { if (dictDispose) dictDispose() } catch (e) { /* Implementation note. */ }
        try { if (localeUnsub) localeUnsub() } catch (e) { /* Implementation note. */ }
        try { if (localeObserver) localeObserver.disconnect() } catch (e) { /* Implementation note. */ }
        dictDispose = null
        localeUnsub = null
        localeObserver = null
      }
    })

    // Implementation note.
    registerEffect(ctx, PLUGIN_ID + ': anchors', function () {
      return function () { registry.releaseAll() }
    })

    // Implementation note.
    // Implementation note.
    // Implementation note.
    let providedDispose = null
    const bus = getPaletteBus().bus
    registerEffect(ctx, PLUGIN_ID + ': api', function () {
      bus.publish(api)
      try {
        if (typeof ctx.provide === 'function') {
          const d = ctx.provide('opencodePalette', api)
          if (typeof d === 'function') providedDispose = d
        }
      } catch (e) { /* Implementation note. */ }
      const debug = api
      if (typeof globalThis !== 'undefined') {
        try { globalThis.__cdsh = debug } catch (e) { /* Implementation note. */ }
        try { globalThis.__opencodePalette = debug } catch (e) { /* compatibility */ }
        try { globalThis.__dshPalette = debug } catch (e) { /* compatibility */ }
      }
      return function () {
        try { bus.clear(api) } catch (e) { /* Implementation note. */ }
        try { if (providedDispose) providedDispose() } catch (e) { /* Implementation note. */ }
        providedDispose = null
        if (typeof globalThis !== 'undefined') {
          if (globalThis.__cdsh === debug) { try { delete globalThis.__cdsh } catch (e) { /* Implementation note. */ } }
          if (globalThis.__opencodePalette === debug) { try { delete globalThis.__opencodePalette } catch (e) { /* compatibility */ } }
          if (globalThis.__dshPalette === debug) { try { delete globalThis.__dshPalette } catch (e) { /* compatibility */ } }
        }
      }
    })

    // Implementation note.
    // Implementation note.
    // Implementation note.
    const panelOption = opts.panel
    if (panelOption !== false) {
      registerEffect(ctx, PLUGIN_ID + ': panel', function () {
        const mountPanel = function (scope) {
          let d = null
          try {
            if (typeof panelOption === 'function') {
              d = panelOption(api, scope)
            } else if (panelOption && typeof panelOption.mount === 'function') {
              d = panelOption.mount(api, scope)
            } else if (typeof registerPanel === 'function') {
              d = registerPanel(scope, {
                api: api,
                slot: opts.slotTarget || SETTINGS_SLOT,
                id: PLUGIN_ID,
                tr: tr,
                withSection: opts.withSection !== false,
              })
            }
          } catch (e) {
            fail(LOG, 'settings panel failed to mount:', e)
            d = null
          }
          return asDisposer(d)
        }
        let branch = null
        try {
          branch = ctx && typeof ctx.inject === 'function' ? ctx.inject(['slots'], mountPanel) : mountPanel(ctx)
        } catch (e) {
          fail(LOG, 'settings panel did not obtain slots:', e)
        }
        return function () { try { asDisposer(branch)() } catch (e) { /* Implementation note. */ } }
      })
    }

    // Implementation note.
    // Implementation note.
    // Implementation note.
    // Implementation note.
    // Implementation note.
    // Implementation note.
    // Implementation note.
    if (opts.times !== false) {
      registerEffect(ctx, PLUGIN_ID + ': times', function () {
        const mountTimes = function (scope) {
          let d = null
          try {
            d = registerTimes(scope)
          } catch (e) {
            warn(LOG, 'time label failed to mount:', e)
            d = null
          }
          return asDisposer(d)
        }
        let branch = null
        try {
          branch = ctx && typeof ctx.inject === 'function' ? ctx.inject(['slots'], mountTimes) : mountTimes(ctx)
        } catch (e) {
          warn(LOG, 'time label did not obtain slots:', e)
        }
        return function () { try { asDisposer(branch)() } catch (e) { /* Implementation note. */ } }
      })
    }

    return api
  }
}
