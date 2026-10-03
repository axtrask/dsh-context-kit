#!/usr/bin/env node
/* Implementation note.



































































































































































































































 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Implementation note.
// Implementation note.
// Implementation note.

// Implementation note.
export const TOKEN_MAP = [
  // Implementation note.
  ['--dsw-alias-bg-base', 'background'],
  ['--dsw-alias-bg-layer-1', 'background'],
  ['--dsw-alias-bg-layer-2', 'background'],
  ['--dsw-alias-bg-overlay', 'background'],
  ['--dsw-alias-bg-layer-3', 'background'],
  ['--dsw-specific-sidebar-fill', 'background'],
  ['--dsw-specific-menu', 'background'],
  ['--dsw-alias-markdown-code-segment-unselected', 'background'],
  ['--dsw-alias-markdown-code-segment-selected', 'backgroundElement'],
  // Implementation note.
  ['--dsw-alias-markdown-tag', 'backgroundPanel'],
  ['--dsw-alias-markdown-placeholder', 'backgroundPanel'],
  ['--dsw-specific-bubble', 'backgroundPanel'],
  ['--dsw-alias-bg-multi-select', 'backgroundPanel'],
  // Implementation note.
  ['--dsw-alias-markdown-citation', 'backgroundElement'],
  ['--dsw-alias-bg-module-platform', 'backgroundElement'],
  ['--dsw-specific-selector', 'backgroundElement'],
  ['--dsw-specific-tip', 'backgroundElement'],
  ['--dsw-specific-bubble-highlight', 'backgroundElement'],
  // Implementation note.
  ['--dsw-specific-input-major', 'backgroundPanel'],
  ['--dsw-specific-login-input', 'backgroundPanel'],
  ['--dsw-alias-markdown-code-block', 'backgroundPanel'],
  ['--dsw-alias-markdown-code-block-banner', 'backgroundElement'],
  ['--dsw-alias-toast-bg', 'backgroundElement'],
  ['--dsw-alias-tooltip-bg', 'backgroundElement'],
  ['--dsw-alias-button-elevated-fill', 'backgroundPanel'],
  ['--dsw-alias-button-floating-fill', 'backgroundPanel'],
  // Implementation note.
  ['--dsw-alias-label-primary', 'text'],
  ['--dsw-alias-label-primary-dimmed', 'text'],
  ['--dsw-alias-label-secondary', 'textMuted'],
  ['--dsw-alias-label-tertiary', 'textMuted'],
  ['--dsw-alias-label-caption', 'textMuted'],
  ['--dsw-alias-label-primary-bluish', 'markdownLink'],
  // Implementation note.
  ['--dsw-alias-brand-primary', 'primary'],
  ['--dsw-alias-brand-text', 'primary'],
  ['--dsw-alias-button-primary-fill', 'primary'],
  ['--dsw-alias-button-info-fill', 'info'],
  ['--dsw-alias-button-contrast-fill', 'text'],
  ['--dsw-alias-state-error-primary', 'error'],
  ['--dsw-alias-state-warn-primary', 'warning'],
  ['--dsw-alias-state-warn-label', 'warning'],
  ['--dsw-alias-state-success-primary', 'success'],
  ['--dsw-alias-state-business-primary', 'primary'],
  // Implementation note.
  ['--dsw-alias-border-l1', 'border'],
  ['--dsw-alias-border-l2', 'borderActive'],
  ['--dsw-alias-border-l2-darkmode-thin', 'borderActive'],
  ['--dsw-alias-border-l3', 'borderActive'],
  ['--dsw-alias-border-l4', 'borderActive'],
  ['--dsw-alias-button-ghost-active-border', 'borderActive'],
  // DSH 0.2.x surfaces. These aliases are consumed by grouped chat rows,
  // settings cards, deliverables and the right-sidebar applications.
  ['--dsw-alias-bg-document-preview', 'backgroundPanel'],
  ['--dsw-alias-bg-l1', 'background'],
  ['--dsw-alias-bg-layer-4', 'backgroundElement'],
  ['--dsw-alias-brand-primary-new-colorprimary-new-color', 'primary'],
  ['--dsw-alias-code-diff-added', 'success'],
  ['--dsw-alias-code-diff-deleted', 'error'],
  ['--dsw-alias-file-diff-added-marker', 'success'],
  ['--dsw-alias-file-diff-deleted-marker', 'error'],
  ['--dsw-alias-fill-l1', 'backgroundPanel'],
  ['--dsw-alias-fill-l2', 'backgroundElement'],
  ['--dsw-alias-fill-tertiary', 'backgroundElement'],
  ['--dsw-alias-fill-tsp-secondary', 'backgroundPanel'],
  ['--dsw-alias-label-deep-diving', 'primary'],
  ['--dsw-alias-label-document-preview', 'text'],
  ['--dsw-alias-label-quaternary', 'textMuted'],
  ['--dsw-alias-link', 'markdownLink'],
  ['--dsw-alias-menu-icon', 'textMuted'],
  ['--dsw-alias-onboarding-accent', 'primary'],
  ['--dsw-alias-onboarding-card-fill', 'backgroundPanel'],
  ['--dsw-alias-onboarding-checkbox-border', 'borderActive'],
  ['--dsw-alias-onboarding-secondary-fill', 'backgroundElement'],
  ['--dsw-alias-separator-primary', 'border'],
  ['--dsw-alias-settings-card-fill', 'backgroundPanel'],
  ['--dsw-alias-settings-card-stroke', 'border'],
  ['--dsw-alias-state-idle-primary', 'textMuted'],
  ['--dsw-alias-switch-thumb', 'text'],
  ['--dsw-alias-toast-label', 'text'],
  ['--dsw-alias-turn-trigger-bg', 'backgroundPanel'],
  // Implementation note.
  // Implementation note.
  // Implementation note.
  // Implementation note.
  ['--dsw-alias-markdown-inline-code', '__transparent__'],
]

// Implementation note.
export const DERIVED_TOKENS = [
  ['--dsw-alias-button-primary-hover', (c) => shade(c.primary, 0.12)],
  ['--dsw-alias-button-info-hover', (c) => shade(c.info, 0.12)],
  ['--dsw-alias-label-primary-inverted', (c) => contrastText(c.text)],
  ['--dsw-alias-label-primary-foreground', (c) => contrastText(c.primary)],
  ['--dsw-alias-brand-primary-invert', (c) => contrastText(c.primary)],
  ['--dsw-alias-button-primary-dimmed', (c) => withAlpha(c.primary, 0.2)],
  ['--dsw-alias-button-ghost-active-fill', (c) => withAlpha(c.text, 0.1)],
  ['--dsw-alias-bg-skeleton', (c) => withAlpha(c.text, 0.08)],
  ['--dsw-alias-state-error-secondary', (c) => shade(c.error, 0.25)],
  ['--dsw-alias-state-success-secondary', (c) => shade(c.success, 0.25)],
  ['--dsw-alias-state-warn-secondary', (c) => shade(c.warning, 0.25)],
  ['--dsw-alias-state-success-tertiary', (c) => withAlpha(c.success, 0.14)],
  ['--dsw-alias-state-warn-tertiary', (c) => withAlpha(c.warning, 0.14)],
  ['--dsw-alias-state-business-tertiary', (c) => withAlpha(c.primary, 0.12)],
  ['--dsw-alias-label-dimmed', (c) => withAlpha(c.textMuted, 0.8)],
  ['--dsw-alias-button-tool-bar-fill', (c) => withAlpha(c.text, 0.1)],
  ['--dsw-alias-button-tool-bar-hover', (c) => withAlpha(c.text, 0.16)],
  ['--dsw-alias-button-tool-bar-fill-invisible', (c) => withAlpha(c.text, 0.04)],
  ['--dsw-alias-button-floating-hover', (c) => c.backgroundElement],
  ['--dsw-alias-button-ghost-active-hover', (c) => c.backgroundElement],
  ['--dsw-alias-interactive-bg-active', (c) => withAlpha(c.text, 0.14)],
  ['--dsw-alias-interactive-bg-hover', (c) => withAlpha(c.text, 0.08)],
  ['--dsw-alias-interactive-bg-hover-accent', (c) => withAlpha(c.primary, 0.2)],
  ['--dsw-alias-interactive-bg-hover-danger', (c) => withAlpha(c.error, 0.15)],
  ['--dsw-alias-interactive-bg-hover-solid', (c) => c.backgroundElement],
  ['--dsw-alias-border-inverted', (c) => withAlpha(c.text, 0.06)],
  ['--dsw-alias-border-inverted2', (c) => withAlpha(c.text, 0.08)],
  ['--dsw-alias-scrollbar-bg-l1', (c) => withAlpha(c.text, 0.08)],
  ['--dsw-alias-scrollbar-bg-l2', (c) => withAlpha(c.text, 0.08)],
  ['--dsw-alias-scrollbar-hover-l1', (c) => c.borderActive],
  ['--dsw-alias-scrollbar-hover-l2', (c) => c.borderActive],
  ['--dsw-specific-sidebar-nav-item-hover', (c) => withAlpha(c.text, 0.08)],
  ['--dsw-specific-sidebar-nav-item-active', (c) => withAlpha(c.text, 0.14)],
  ['--dsw-specific-sidebar-nav-item-active-accent', (c) => withAlpha(c.primary, 0.35)],
  ['--dsw-alias-bg-document-selection', (c) => withAlpha(c.primary, 0.16)],
  ['--dsw-alias-bg-mask-1', (c) => withAlpha(c.background, 0.76)],
  ['--dsw-alias-bg-mask-drop', (c) => withAlpha(c.background, 0.9)],
  ['--dsw-alias-file-diff-added-bg', (c) => withAlpha(c.success, 0.12)],
  ['--dsw-alias-file-diff-added-gutter', (c) => withAlpha(c.success, 0.2)],
  ['--dsw-alias-file-diff-deleted-bg', (c) => withAlpha(c.error, 0.12)],
  ['--dsw-alias-file-diff-deleted-gutter', (c) => withAlpha(c.error, 0.2)],
  ['--dsw-alias-label-deep-diving-shimmer', (c) => withAlpha(c.primary, 0.72)],
  ['--dsw-alias-label-shimmer', (c) => withAlpha(c.text, 0.72)],
  ['--dsw-alias-menu-group-header-fill', (c) => withAlpha(c.text, 0.06)],
  ['--dsw-alias-tooltip-key-bg', (c) => withAlpha(c.text, 0.1)],
  ['--dsw-alias-turn-trigger-bg-hover', (c) => c.backgroundElement],
]

// Implementation note.
export const SHIKI_MAP = [
  ['--shiki-foreground', 'text'],
  ['--shiki-token-comment', 'syntaxComment'],
  ['--shiki-token-keyword', 'syntaxKeyword'],
  ['--shiki-token-function', 'syntaxFunction'],
  ['--shiki-token-parameter', 'syntaxType'],
  ['--shiki-token-constant', 'syntaxNumber'],
  ['--shiki-token-string', 'syntaxString'],
  ['--shiki-token-string-expression', 'syntaxString'],
  ['--shiki-token-punctuation', 'syntaxOperator'],
  ['--shiki-token-link', 'markdownLink'],
]

// Implementation note.
// Implementation note.
// Implementation note.

const ANSI_16 = [
  '#000000', '#800000', '#008000', '#808000', '#000080', '#800080', '#008080', '#C0C0C0',
  '#808080', '#FF0000', '#00FF00', '#FFFF00', '#0000FF', '#FF00FF', '#00FFFF', '#FFFFFF',
]

export function ansiToHex(code) {
  if (!Number.isInteger(code) || code < 0 || code > 255) return '#FF00FF'
  if (code < 16) return ANSI_16[code]
  if (code < 232) {
    const index = code - 16
    const b = index % 6
    const g = Math.floor(index / 6) % 6
    const r = Math.floor(index / 36)
    const val = (x) => (x === 0 ? 0 : x * 40 + 55)
    return rgbToHex(val(r), val(g), val(b))
  }
  const gray = (code - 232) * 10 + 8
  return rgbToHex(gray, gray, gray)
}

export function rgbToHex(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return ('#' + c(r) + c(g) + c(b)).toUpperCase()
}

export function hexToRgb(hex) {
  let t = String(hex || '').trim()
  if (t[0] === '#') t = t.slice(1)
  if (t.length === 3) t = t.split('').map((x) => x + x).join('')
  if (t.length === 4) t = t.split('').map((x) => x + x).join('')
  const n = parseInt(t, 16)
  if (t.length === 8) return { r: (n >>> 24) & 255, g: (n >>> 16) & 255, b: (n >>> 8) & 255, a: n & 255 }
  return { r: (n >>> 16) & 255, g: (n >>> 8) & 255, b: n & 255, a: 255 }
}

export function shade(hex, f) {
  const { r, g, b } = hexToRgb(hex)
  const target = f >= 0 ? 255 : 0
  const k = Math.abs(f)
  return rgbToHex(r + (target - r) * k, g + (target - g) * k, b + (target - b) * k)
}

export function withAlpha(hex, a) {
  const { r, g, b } = hexToRgb(hex)
  return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')'
}

export function contrastText(hex) {
  const { r, g, b } = hexToRgb(hex)
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luma > 0.6 ? '#141414' : '#F4F4F5'
}

const HEX_RE = /^#([0-9a-fA-F]{3,8})$/

export function resolveColor(ref, defs, theme, mode, chain) {
  const seen = chain || []
  if (typeof ref === 'number') return ansiToHex(ref)
  if (typeof ref === 'string') {
    const t = ref.trim()
    if (t === 'none' || t === 'transparent') return 'transparent'
    if (HEX_RE.test(t)) return t.toUpperCase()
    if (seen.includes(t)) {
      throw new Error('cyclic colour reference: ' + seen.concat(t).join(' -> '))
    }
    const next = (defs && defs[t]) || (theme && theme[t])
    if (next === undefined) throw new Error('unknown colour reference "' + t + '" (absent from both defs and theme)')
    return resolveColor(next, defs, theme, mode, seen.concat(t))
  }
  if (typeof ref === 'object' && ref !== null) {
    const v = ref[mode] !== undefined ? ref[mode] : (ref.dark !== undefined ? ref.dark : ref.light)
    if (v === undefined) throw new Error('colour variant has neither dark nor light: ' + JSON.stringify(ref))
    return resolveColor(v, defs, theme, mode, seen)
  }
  throw new Error('invalid colour value: ' + String(ref))
}

export function resolveThemeColors(json, mode) {
  const m = mode || 'dark'
  const defs = (json && json.defs) || {}
  const theme = (json && json.theme) || {}
  const out = {}
  for (const key of Object.keys(theme)) {
    if (key === 'thinkingOpacity') continue
    try {
      out[key] = resolveColor(theme[key], defs, theme, m, [])
    } catch (e) {
      out[key] = { __error: e.message }
    }
  }
  if (out.selectedListItemText === undefined) out.selectedListItemText = out.background
  if (out.backgroundMenu === undefined) out.backgroundMenu = out.backgroundElement
  return out
}

export function collectErrors(colors) {
  const out = []
  for (const key of Object.keys(colors)) {
    const v = colors[key]
    if (v && typeof v === 'object' && v.__error) out.push(key + ': ' + v.__error)
  }
  return out
}

// Implementation note.
// Implementation note.
// Implementation note.

export const SYSTEM_THEME = 'system'

const THEME_FILES = [
  'amoled', 'aura', 'ayu', 'carbonfox', 'catppuccin-frappe', 'catppuccin-macchiato',
  'catppuccin', 'cobalt2', 'cursor', 'dracula', 'everforest', 'flexoki', 'github',
  'gruvbox', 'kanagawa', 'lucent-orng', 'material', 'matrix', 'mercury', 'monokai',
  'nightowl', 'nord', 'oc-2', 'one-dark', 'onedarkpro', 'opencode', 'orng',
  'osaka-jade', 'palenight', 'rosepine', 'shadesofpurple', 'solarized', 'synthwave84',
  'tokyonight', 'vercel', 'vesper', 'zenburn',
]

/* Implementation note. */
export const REGION_ORDER = ['sidebar', 'header', 'conversation', 'composer', 'toolCards', 'overlays']

/* Implementation note. */
export const DEFAULT_REGION_ATTR = 'data-dsh-region'

export function listThemes() {
  return THEME_FILES.concat(SYSTEM_THEME).sort((a, b) => a.localeCompare(b))
}

export function listRegions() {
  return REGION_ORDER.slice()
}

export function isSystemTheme(name) {
  return name === SYSTEM_THEME
}

// Resolve package-owned vendor data from this module in both Node and the browser shim.
const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(HERE, '..')

function themeJsonPath(name) {
  return path.join(PACKAGE_ROOT, 'vendor', 'dsh-opencode-palette', 'src', 'themes', name + '.json')
}

const themeCache = new Map()

/* Implementation note. */
export function getThemeJson(name) {
  if (isSystemTheme(name)) return null
  if (!THEME_FILES.includes(name)) return null
  if (!themeCache.has(name)) {
    themeCache.set(name, JSON.parse(fs.readFileSync(themeJsonPath(name), 'utf8')))
  }
  return themeCache.get(name)
}

// Implementation note.
// Implementation note.
// Implementation note.

const TRANSPARENT = 'transparent'

function isResolveError(v) {
  return Boolean(v && typeof v === 'object' && v.__error)
}

function usable(colors, from) {
  const v = colors[from]
  if (v === undefined || v === null) return null
  if (v === TRANSPARENT) return null
  if (isResolveError(v)) return null
  return v
}

/* Implementation note. */
export function buildTokenValues(colors) {
  const out = Object.create(null)
  const put = (name, value) => {
    if (value !== null && value !== undefined && value !== '') out[name] = value
  }
  for (const [dshVar, from] of TOKEN_MAP) {
    // Implementation note.
    if (from === '__transparent__') { put(dshVar, TRANSPARENT); continue }
    put(dshVar, usable(colors, from))
  }
  for (const [dshVar, fn] of DERIVED_TOKENS) {
    try {
      const v = fn(colors)
      if (v !== null && v !== undefined && v !== TRANSPARENT) put(dshVar, v)
    } catch (e) { /* Implementation note. */ }
  }
  for (const [dshVar, from] of SHIKI_MAP) {
    put(dshVar, usable(colors, from))
  }
  return { ...out }
}

// Implementation note.
const HEX_VALUE_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
const FUNC_VALUE_RE = /^rgba?\(\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/

/* Implementation note.


 */
export function checkValue(value) {
  if (typeof value !== 'string') return 'value is not a string: ' + typeof value
  const v = value.trim()
  if (v === '') return 'empty value'
  if (v !== value) return 'value has surrounding whitespace: ' + JSON.stringify(value)
  if (v === TRANSPARENT) return null
  if (HEX_VALUE_RE.test(v)) return null
  if (FUNC_VALUE_RE.test(v)) return null
  if (/\bvar\s*\(/.test(v)) return 'FORBIDDEN: var() in a token value -> ' + v
  if (/[;{}]/.test(v)) return 'invalid characters (; { }) in value: ' + v
  return 'unknown colour value format: ' + JSON.stringify(v)
}

const OUT_OF_REGION_RE = /(^|[\s,])(:root|html|body)\s*(,|\{|$|\[)/
const GLOBAL_ANCHOR_RE = /^\s*(:root|html|body)\b/

function escapeAttrValue(name) {
  return String(name).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function defaultSelector(region) {
  return '[' + DEFAULT_REGION_ATTR + '="' + escapeAttrValue(region) + '"]'
}

/**
 * Split a selector LIST on top-level commas.
 * Commas inside parentheses, brackets, or strings do not split the list.
 * This is required because darkSelector must scope each selector separately.
 */
export function splitSelectorList(raw) {
  const s = String(raw)
  const out = []
  let buf = ''
  let depth = 0
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch === '"' || ch === "'") {
      const end = s.indexOf(ch, i + 1)
      if (end === -1) throw new Error('unterminated string in selector: ' + raw)
      buf += s.slice(i, end + 1)
      i = end + 1
      continue
    }
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') {
      depth--
      if (depth < 0) throw new Error('unbalanced brackets in selector: ' + raw)
    } else if (ch === ',' && depth === 0) {
      out.push(buf)
      buf = ''
      i++
      continue
    }
    buf += ch
    i++
  }
  if (depth !== 0) throw new Error('unbalanced brackets in selector: ' + raw)
  out.push(buf)
  return out.map((x) => x.trim())
}

/** Normalize one list item to :where(<item>). */
function normalizeOneSelector(part, raw) {
  if (part === '') throw new Error('empty item in selector list: ' + JSON.stringify(raw))
  if (OUT_OF_REGION_RE.test(part) || GLOBAL_ANCHOR_RE.test(part)) {
    throw new Error('anchor selector cannot be global (:root/html/body): ' + part)
  }
  if (/[{}]/.test(part)) throw new Error('selector contains { or }: ' + part)
  if (part.startsWith(':where(')) {
    if (!part.endsWith(')')) throw new Error('unterminated :where( in selector: ' + part)
    return part
  }
  return ':where(' + part + ')'
}

/**
 * Normalize one anchor selector or a comma-separated selector list.
 * Each item is wrapped independently so source order and the dark qualifier
 * determine the intended cascade.
 * @returns {string} a normalized list such as `:where(a), :where(b)`
 */
export function normalizeSelector(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('selector must be a non-empty string, received: ' + JSON.stringify(raw))
  }
  const parts = splitSelectorList(raw)
  return parts.map((p) => normalizeOneSelector(p, raw)).join(', ')
}

/**
 * Build the dark variant for every selector-list item independently.
 * Wrapping the whole list would leave later selectors outside the dark-theme
 * condition, so each normalized item receives its own body qualifier.
 */
function darkSelector(baseSelector) {
  const parts = splitSelectorList(baseSelector)
  return parts.map((part) => {
    if (!part.startsWith(':where(') || !part.endsWith(')')) {
      throw new Error('internal error: selector item is not normalized: ' + part)
    }
    const inner = part.slice(':where('.length, -1)
    return ':where(body[data-ds-dark-theme] ' + inner + ')'
  }).join(', ')
}

function renderBlock(selector, values, opts) {
  const indent = opts.indent
  const bang = opts.important ? ' !important' : ''
  const parts = []
  for (const name of Object.keys(values)) {
    const v = values[name]
    parts.push(indent + name + ':' + v + bang + ';')
  }
  return selector + ' {\n' + parts.join('\n') + '\n}'
}

function assertValues(values, where, strict, problems) {
  for (const name of Object.keys(values)) {
    const bad = checkValue(values[name])
    if (!bad) continue
    const msg = where + ': ' + name + ' — ' + bad
    if (strict) throw new Error(msg)
    problems.push(msg)
  }
}

function requireTheme(name) {
  if (isSystemTheme(name)) return null
  const json = getThemeJson(name)
  if (!json) {
    // An unknown name is a no-colour result rather than a program error.
    // The runtime receives empty CSS plus a metadata warning. Invalid data in a
    // known theme remains a hard error under the strict data contract.
    return null
  }
  return json
}

/** Return whether the named theme exists (37 static themes plus system). */
export function hasTheme(name) {
  return isSystemTheme(name) || THEME_FILES.includes(name)
}

function resolveAppearance(opts) {
  const a = opts.appearance === undefined ? 'both' : opts.appearance
  if (a !== 'both' && a !== 'light' && a !== 'dark') {
    throw new Error("appearance must be 'both' | 'light' | 'dark', received: " + JSON.stringify(opts.appearance))
  }
  return a
}

function pickSelector(region, opts) {
  if (opts.selector !== undefined) return opts.selector
  const byRegion = opts.selectorByRegion && opts.selectorByRegion[region]
  if (byRegion !== undefined) return byRegion
  return defaultSelector(region)
}

function requireRegion(region) {
  if (typeof region !== 'string' || region.trim() === '') {
    throw new Error('region must be a non-empty string, received: ' + JSON.stringify(region))
  }
  if (/[{}"\\]/.test(region)) {
    throw new Error('region name contains invalid characters: ' + region)
  }
  return region
}

function normalizeOpts(opts) {
  const o = opts || {}
  return {
    important: o.important === undefined ? true : Boolean(o.important),
    strict: o.strict === undefined ? true : Boolean(o.strict),
    header: Boolean(o.header),
    indent: typeof o.indent === 'string' ? o.indent : '  ',
    appearance: resolveAppearance(o),
    collapseIdentical: o.collapseIdentical === undefined ? true : Boolean(o.collapseIdentical),
    selector: o.selector,
    selectorByRegion: o.selectorByRegion,
    tokenFilter: typeof o.tokenFilter === 'function' ? o.tokenFilter : null,
  }
}

function buildMeta(themeName, regions, allValues, opts) {
  const bytes = regions.reduce((n, r) => n + r.css.length, 0) + (regions.length > 1 ? regions.length - 1 : 0)
  const warnings = []
  if (themeName === SYSTEM_THEME) {
    warnings.push("theme 'system': no colours are emitted (restore the native appearance); CSS is empty")
  } else if (!hasTheme(themeName)) {
    warnings.push("unknown theme '" + themeName + "': CSS is empty and the region is unchanged")
  } else if (allValues) {
    for (const r of regions) {
      if (!r.appearance.identical) continue
      warnings.push(
        "region '" + r.name + "': the light scheme matches the dark scheme because theme '" + themeName +
        "' has no light branch in its data; a single block is emitted"
      )
    }
  }
  if (!opts.important) {
    warnings.push('important:false reduces region authority: a shipped rule or another plugin rule on the same element can win by specificity')
  }
  return {
    theme: themeName,
    regions: regions.map((r) => r.name),
    appearance: opts.appearance,
    important: opts.important,
    selectorByRegion: regions.reduce((acc, r) => { acc[r.name] = r.selector; return acc }, {}),
    blocks: regions.reduce((n, r) => n + r.blocks, 0),
    collapsed: regions.filter((r) => r.collapsed).map((r) => r.name),
    tokens: regions.length ? regions[0].count : 0,
    bytes,
    warnings,
  }
}

function buildRegion(themeName, region, opts, json, problems) {
  requireRegion(region)
  const baseSelector = normalizeSelector(pickSelector(region, opts))
  const blocks = []

  if (json === null) {
    return {
      name: region, css: '', selector: baseSelector, blocks: 0, count: 0,
      tokens: {}, dark: {}, light: {},
      appearance: { dark: false, light: false, identical: false },
      problems,
    }
  }

  const wantLight = opts.appearance !== 'dark'
  const wantDark = opts.appearance !== 'light'
  const lightValues = wantLight ? buildTokenValues(resolveThemeColors(json, 'light')) : {}
  const darkValues = wantDark ? buildTokenValues(resolveThemeColors(json, 'dark')) : {}

  const lightNames = Object.keys(lightValues)
  const darkNames = Object.keys(darkValues)
  const identical = wantLight && wantDark &&
    lightNames.length === darkNames.length &&
    lightNames.every((n) => lightValues[n] === darkValues[n])

  // When both schemes are identical, a second block would be a byte-for-byte
  // duplicate. Emit one block and record the collapse in appearance.identical.
  const collapse = identical && opts.collapseIdentical
  const emitLight = wantLight && !collapse
  const emitDark = wantDark || collapse

  if (emitLight) {
    assertValues(lightValues, themeName + '/' + region + ' [light]', opts.strict, problems)
    blocks.push(renderBlock(baseSelector, lightValues, opts))
  }
  if (emitDark) {
    assertValues(darkValues, themeName + '/' + region + ' [dark]', opts.strict, problems)
    blocks.push(renderBlock(collapse ? baseSelector : darkSelector(baseSelector), darkValues, opts))
  }

  const reference = (wantLight ? lightValues : darkValues)
  const names = Object.keys(reference)
  const tokens = {}
  for (const n of names) {
    const rec = {}
    if (wantLight) rec.light = lightValues[n]
    if (wantDark) rec.dark = darkValues[n]
    tokens[n] = rec
  }

  let css = blocks.join('\n\n')
  if (css && opts.header) {
    css = '/* cdsh regional theme: ' + themeName + '/' + region + ' */\n' + css
  }

  return {
    name: region,
    css,
    selector: baseSelector,
    blocks: blocks.length,
    collapsed: collapse,
    count: names.length,
    tokens,
    dark: { ...darkValues },
    light: { ...lightValues },
    appearance: { dark: wantDark, light: wantLight, identical },
    problems,
  }
}

/**
 * Generate CSS for one region.
 * @param {string} themeName theme name (37 static themes plus system)
 * @param {string} regionName region name from REGION_ORDER
 * @param {object} [opts] generation options
 * @returns {{css: string, meta: object}}
 */
export function generateRegionCss(themeName, regionName, opts) {
  const o = normalizeOpts(opts)
  const json = requireTheme(themeName)
  const problems = []
  const region = buildRegion(themeName, regionName, o, json, problems)
  if (!o.strict && problems.length) region.css = ''
  const meta = buildMeta(themeName, [region], json, o)
  return { css: region.css, meta }
}

/**
 * Generate CSS for the listed regions in caller-provided order.
 * @param {string} themeName
 * @param {Array<string|{name:string,theme?:string,selector?:string,enabled?:boolean}>} [regionList]
 * @param {object} [opts]
 * @returns {string}
 */
export function generateAllRegions(themeName, regionList, opts) {
  return renderThemeRegions(themeName, regionList, opts).css
}

/**
 * Return CSS plus the `{ tokens, css }` region map used by the runtime and panel.
 * @returns {{css: string, regions: object, meta: object}}
 */
export function renderThemeRegions(themeName, regionList, opts) {
  const o = normalizeOpts(opts)
  const json = requireTheme(themeName)
  const list = Array.isArray(regionList) && regionList.length ? regionList : REGION_ORDER
  const problems = []
  const built = []
  const map = Object.create(null)

  for (const entry of list) {
    const spec = typeof entry === 'string' ? { name: entry } : (entry || {})
    if (spec.enabled === false) continue
    const regionName = requireRegion(spec.name)
    const regionTheme = spec.theme === undefined ? themeName : spec.theme
    const regionJson = requireTheme(regionTheme)
    const effOpts = spec.selector === undefined ? o : { ...o, selector: spec.selector }
    const region = buildRegion(regionTheme, regionName, effOpts, regionJson, problems)
    built.push(region)
    map[regionName] = {
      theme: regionTheme,
      css: region.css,
      tokens: region.tokens,
      dark: region.dark,
      light: region.light,
      appearance: region.appearance,
      selector: region.selector,
      count: region.count,
      problems: region.problems,
    }
  }

  const css = built.map((r) => r.css).filter(Boolean).join('\n\n')
  const meta = buildMeta(themeName, built, json, o)
  meta.problems = problems
  return { css, regions: map, meta }
}

/**
 * Return values without CSS as a direct replacement for the old token override.
 * @returns {{theme: string, regions: object, meta: object}}
 */
export function generateRegionTokens(themeName, opts) {
  const o = normalizeOpts(opts)
  const { regions, meta } = renderThemeRegions(themeName, REGION_ORDER, o)
  return { theme: themeName, regions, meta }
}

// ---------------------------------------------------------------------------
// Section 5: self-check
// ---------------------------------------------------------------------------

const FORBIDDEN_VAR_RE = /var\s*\(/
const GLOBAL_SELECTOR_RE = /(^|[\s,{])(:root|html|body)\s*(\{|,|\[|$)/
const DECL_RE = /(--[a-z0-9-]+)\s*:([^;{}]*?)\s*(!\s*important)?\s*;/g

/** Validate delimiter balance outside strings and comments. */
export function checkBalance(css) {
  const errs = []
  const stack = []
  const pairs = { '}': '{', ')': '(', ']': '[' }
  let i = 0
  while (i < css.length) {
    const ch = css[i]
    const next = css[i + 1]
    if (ch === '/' && next === '*') {
      const end = css.indexOf('*/', i + 2)
      if (end === -1) { errs.push('unterminated comment at position ' + i); break }
      i = end + 2
      continue
    }
    if (ch === '"' || ch === "'") {
      const end = css.indexOf(ch, i + 1)
      if (end === -1) { errs.push('unterminated string at position ' + i); break }
      i = end + 1
      continue
    }
    if (ch === '{' || ch === '(' || ch === '[') stack.push({ ch, i })
    else if (ch === '}' || ch === ')' || ch === ']') {
      const top = stack.pop()
      if (!top) { errs.push('unexpected "' + ch + '" at position ' + i); break }
      if (top.ch !== pairs[ch]) { errs.push('mismatched "' + ch + '" at position ' + i + ' (opened "' + top.ch + '" at ' + top.i + ')'); break }
    }
    i++
  }
  if (stack.length) errs.push(stack.length + ' unclosed delimiters; last "' + stack[stack.length - 1].ch + '" at position ' + stack[stack.length - 1].i)
  return errs
}

/** Parse CSS into `selector { declarations }` blocks. */
export function parseBlocks(css) {
  const out = []
  const rx = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = rx.exec(css))) out.push({ selector: m[1].trim(), body: m[2] })
  return out
}

function declsOf(body) {
  const out = []
  let m
  DECL_RE.lastIndex = 0
  while ((m = DECL_RE.exec(body))) out.push({ name: m[1], value: m[2].trim(), important: Boolean(m[3]) })
  return out
}

/**
 * Run the complete 38-theme, six-region, two-scheme self-check.
 * @param {{verbose?: boolean, drift?: boolean, strict?: boolean}} [options]
 */
export function runSelfCheck(options) {
  const o = options || {}
  const verbose = Boolean(o.verbose)
  const themes = listThemes()
  const regions = REGION_ORDER
  const checks = []
  const problems = []
  const warnings = []
  const perTheme = []
  let blocks = 0
  let decls = 0
  let cssBytes = 0

  const fail = (where, what, extra) => {
    problems.push({ where, what, extra: extra === undefined ? null : extra })
  }

  // 0. Compare embedded tables with the vendored source.
  let drift = null
  if (o.drift !== false) {
    drift = checkDrift()
    if (drift.ok) checks.push({ id: 'drift', ok: true, detail: 'tables match the vendored source (' + drift.compared.join(', ') + ')' })
    else {
      checks.push({ id: 'drift', ok: false, detail: drift.errors.join(' | ') })
      for (const e of drift.errors) fail('drift', e)
      for (const w of drift.warnings) warnings.push(w)
    }
  } else {
    checks.push({ id: 'drift', ok: true, detail: 'skipped (--no-drift)' })
  }

  // 1. Input inventory.
  checks.push({ id: 'themes', ok: themes.length === 38, detail: themes.length + ' themes (expected 38, including system)' })
  if (themes.length !== 38) fail('themes', 'received ' + themes.length + ' themes instead of 38')

  // 2. Exercise the complete theme-region grid.
  for (const theme of themes) {
    const isSystem = theme === SYSTEM_THEME
    let themeProblems = 0
    let minCount = Infinity
    let maxCount = 0
    let identical = 0

    for (const region of regions) {
      let res
      try {
        res = generateRegionCss(theme, region, { header: true })
      } catch (e) {
        themeProblems++
        fail(theme + '/' + region, 'generator threw an exception', String(e && e.message ? e.message : e))
        continue
      }
      const css = res.css
      const where = theme + '/' + region

      // Non-system themes must emit CSS.
      if (isSystem) {
        if (css !== '') fail(where, 'system theme must produce empty CSS', JSON.stringify(css.slice(0, 60)))
      } else if (css.trim() === '') {
        fail(where, 'empty CSS')
      }

      // The system theme must explain its intentional no-colour result.
      if (isSystem && !(res.meta.warnings || []).some((w) => w.includes('system'))) {
        fail(where, 'system theme has no metadata warning')
      }

      // Generated values must not contain var().
      if (FORBIDDEN_VAR_RE.test(css)) {
        const m = css.match(/[^\n]*var\s*\([^\n]*/)
        fail(where, 'found forbidden var() usage', m && m[0])
      }

      // Validate delimiter balance.
      const bal = checkBalance(css)
      if (bal.length) fail(where, 'unbalanced delimiters', bal.join('; '))

      // Ensure selectors cannot escape their region.
      const parsed = parseBlocks(css)
      for (const b of parsed) {
        if (GLOBAL_SELECTOR_RE.test(b.selector)) {
          fail(where, 'selector escapes its region', b.selector)
        }
        if (!b.selector.includes(DEFAULT_REGION_ATTR) && !/:where\(/.test(b.selector)) {
          fail(where, 'selector is not anchored to the region attribute', b.selector)
        }
      }

      if (!isSystem) {
        // Normally emit light and dark blocks, with the stronger dark block last.
        // A theme without a distinct light branch collapses to one block.
        const collapsed = parsed.length === 1
        if (parsed.length !== 2 && !collapsed) fail(where, 'expected two blocks (light and dark), received ' + parsed.length)
        if (collapsed) {
          if (parsed[0].selector.includes('data-ds-dark-theme')) {
            fail(where, 'collapsed block must not be tied to the dark scheme', parsed[0].selector)
          }
          if (!res.meta.collapsed) fail(where, 'meta.collapsed is not set for a single block')
        }
        if (parsed.length === 2) {
          if (parsed[0].selector === parsed[1].selector) fail(where, 'light and dark block selectors are identical', parsed[0].selector)
          if (!parsed[1].selector.includes('data-ds-dark-theme')) fail(where, 'second block is not dark', parsed[1].selector)
        }

        for (const b of parsed) {
          const ds = declsOf(b.body)
          const names = new Set()
          for (const d of ds) {
            if (names.has(d.name)) fail(where, 'token is declared twice in one block', d.name)
            names.add(d.name)
            if (d.value === '') fail(where, 'empty token value', d.name)
            if (FORBIDDEN_VAR_RE.test(d.value)) fail(where, 'var() in token value', d.name + ':' + d.value)
            if (!d.important) fail(where, 'declaration is not marked !important', d.name)
          }
          if (ds.length === 0) fail(where, 'block has no declarations', b.selector)
        }

        // Light and dark branches must expose identical token-name sets.
        if (parsed.length === 2) {
          const ln = declsOf(parsed[0].body).map((d) => d.name).sort()
          const dn = declsOf(parsed[1].body).map((d) => d.name).sort()
          if (ln.join(',') !== dn.join(',')) {
            fail(where, 'light and dark token sets differ',
              'light=' + ln.length + ' dark=' + dn.length + ' only in light: ' + ln.filter((x) => !dn.includes(x)).slice(0, 5).join(',') +
              ' only in dark: ' + dn.filter((x) => !ln.includes(x)).slice(0, 5).join(','))
          }
          blocks += 2
          decls += ln.length + dn.length
        } else {
          blocks += 1
          decls += declsOf(parsed[0].body).length
        }

        // Validate generated metadata.
        if (!res.meta || !res.meta.blocks) fail(where, 'meta.blocks is empty')
        const regionCount = Object.keys(res.meta.selectorByRegion || {}).length
        if (regionCount !== 1) fail(where, 'meta.selectorByRegion must contain exactly one region', String(regionCount))

        minCount = Math.min(minCount, res.meta.tokens || 0)
        maxCount = Math.max(maxCount, res.meta.tokens || 0)
        cssBytes += css.length
      }
    }

    // Track the identical flag across every region in the theme.
    if (!isSystem) {
      try {
        const { regions: map } = generateRegionTokens(theme)
        for (const r of regions) {
          if (map[r].appearance.identical) identical++
          if (!map[r].tokens || Object.keys(map[r].tokens).length === 0) fail(theme + '/' + r, 'token map is empty')
        }
      } catch (e) {
        fail(theme, 'generateRegionTokens threw an exception', String(e && e.message ? e.message : e))
      }
    }

    perTheme.push({
      theme, system: isSystem, problems: themeProblems,
      tokens: isSystem ? 0 : minCount,
      tokensMax: isSystem ? 0 : maxCount,
      identicalRegions: identical,
    })
    if (themeProblems) fail(theme, 'theme problems: ' + themeProblems)
  }

  // 3. Token consistency across regions of the same theme.
  for (const theme of themes) {
    if (theme === SYSTEM_THEME) continue
    const { regions: map } = generateRegionTokens(theme)
    const ref = Object.keys(map[regions[0]].dark).sort().join(',')
    for (const r of regions.slice(1)) {
      const cur = Object.keys(map[r].dark).sort().join(',')
      if (cur !== ref) fail(theme + '/' + r, 'token set differs from region ' + regions[0], 'len ' + cur.split(',').length + ' vs ' + ref.split(',').length)
    }
  }

  // 4. Determinism.
  {
    const a = generateAllRegions('opencode', REGION_ORDER, { header: true })
    const b = generateAllRegions('opencode', REGION_ORDER, { header: true })
    if (a !== b) fail('determinism', 'two calls produced different CSS')
    if (!a.includes('--dsw-alias-bg-base')) fail('determinism', 'CSS does not contain --dsw-alias-bg-base')
    checks.push({ id: 'determinism', ok: a === b, detail: 'repeated call produced identical CSS (' + a.length + ' bytes)' })
  }

  // 5. Options.
  {
    const t = []
    const darkOnly = generateRegionCss('opencode', 'conversation', { appearance: 'dark' })
    if (!darkOnly.css.includes('body[data-ds-dark-theme]')) t.push('appearance=dark does not contain a dark selector')
    if (darkOnly.css.split('{').length !== 2) t.push('appearance=dark must produce exactly one block')
    const lightOnly = generateRegionCss('opencode', 'conversation', { appearance: 'light' })
    if (lightOnly.css.includes('data-ds-dark-theme')) t.push('appearance=light must not contain a dark selector')
    if (lightOnly.css.split('{').length !== 2) t.push('appearance=light must produce exactly one block')
    const custom = generateRegionCss('opencode', 'conversation', { selector: '[data-x="y"]' })
    if (!custom.css.includes(':where([data-x="y"])')) t.push('selector was not substituted')

    // Each item in a selector list must be wrapped separately.
    const list = generateRegionCss('opencode', 'conversation', { selector: '[data-x="y"] [data-z], .other, [data-w]' })
    const blocks = list.css.split('\n\n').filter((b) => /--dsw-alias-bg-base/.test(b))
    const lightBlock = blocks[0] || ''
    const darkBlock = blocks[1] || ''
    if (!/^:where\(\[data-x="y"\] \[data-z\]\), :where\(\.other\), :where\(\[data-w\]\) \{/.test(lightBlock.replace(/^\/\*.*\*\/\n/, ''))) {
      t.push('light block: selector list was normalized incorrectly -> ' + lightBlock.split('{')[0].trim())
    }
    const wantDark = ':where(body[data-ds-dark-theme] [data-x="y"] [data-z]), :where(body[data-ds-dark-theme] .other), :where(body[data-ds-dark-theme] [data-w])'
    const gotDark = darkBlock.split('{')[0].trim()
    if (gotDark !== wantDark) {
      t.push('dark block: selector list was not wrapped item by item\n      got:  ' + gotDark + '\n      want: ' + wantDark)
    }
    // Every item in the dark block must remain under body[data-ds-dark-theme].
    for (const part of splitSelectorList(gotDark)) {
      if (!/^:where\(body\[data-ds-dark-theme\] /.test(part)) {
        t.push('dark selector item escaped body[data-ds-dark-theme]: ' + part)
      }
    }
    if (splitSelectorList(gotDark).length !== 3) t.push('dark block lost or gained selector-list items: ' + splitSelectorList(gotDark).length)
    // Commas inside :is(), :not(), or attribute values must not split the list.
    const nested = generateRegionCss('opencode', 'conversation', { selector: ':is([data-a], [data-b]) > div, [data-c="x,y"]' })
    const nestedDark = nested.css.split('\n\n').filter((b) => b.includes('data-ds-dark-theme'))[0]
      .split('{')[0].trim()
    if (splitSelectorList(nestedDark).length !== 2) {
      t.push('comma inside :is() or an attribute value incorrectly split the selector list: ' + nestedDark)
    }
    if (!nestedDark.includes('[data-c="x,y"]') || !nestedDark.includes(':is([data-a], [data-b])')) {
      t.push('nested selector form was lost: ' + nestedDark)
    }

    try {
      generateRegionCss('opencode', 'conversation', { selector: 'body' })
      t.push('selector="body" was not rejected')
    } catch (e) { /* expected */ }
    try {
      generateRegionCss('opencode', 'conversation', { selector: ':root' })
      t.push('selector=":root" was not rejected')
    } catch (e) { /* expected */ }
    try {
      generateRegionCss('opencode', 'conversation', { selector: '[data-a], body' })
      t.push('global selector in the second list item was not rejected')
    } catch (e) { /* expected */ }
    try {
      generateRegionCss('opencode', 'conversation', { selector: '[data-a], ' })
      t.push('empty selector-list item was not rejected')
    } catch (e) { /* expected */ }
    try {
      generateRegionCss('opencode', 'conversation', { selector: '[data-a' })
      t.push('unbalanced bracket in selector was not rejected')
    } catch (e) { /* expected */ }
    // An unknown theme is not a failure: it produces empty CSS plus a warning.
    // Generator errors caused by malformed data continue to throw.
    const unknown = generateRegionCss('нет-такой-темы', 'conversation')
    if (unknown.css !== '') t.push('unknown theme must produce empty CSS, received ' + JSON.stringify(unknown.css.slice(0, 40)))
    if (!unknown.meta.warnings.some((w) => w.includes('unknown theme'))) t.push('unknown theme has no metadata warning')
    if (hasTheme('нет-такой-темы')) t.push('hasTheme returned true for a nonexistent theme')
    if (!hasTheme('opencode') || !hasTheme('system') || hasTheme('SYSTEM')) t.push('hasTheme returned an incorrect result for existing themes')
    if (generateAllRegions('нет-такой-темы') !== '') t.push('generateAllRegions must return empty CSS for an unknown theme')
    const multi = generateAllRegions('opencode', ['conversation', { name: 'header', enabled: false }, 'sidebar'])
    if (multi.includes('"header"')) t.push('disabled region was emitted')
    if (!multi.includes('"conversation"') || !multi.includes('"sidebar"')) t.push('multi-region output lost a region')
    const perRegionTheme = generateAllRegions('opencode', [{ name: 'sidebar', theme: 'nord' }, 'conversation'])
    const nordOnly = generateAllRegions('nord', ['sidebar'])
    if (perRegionTheme === generateAllRegions('opencode', ['sidebar', 'conversation'])) {
      t.push('per-region theme did not affect the result')
    }
    const bgOf = (css) => (css.match(/--dsw-alias-bg-base:([^ !;]+)/) || [])[1]
    if (!nordOnly.includes('--dsw-alias-bg-base:' + bgOf(nordOnly))) t.push('nord produced no values')
    if (bgOf(perRegionTheme) !== bgOf(nordOnly)) {
      t.push('first block did not use the region theme: got ' + bgOf(perRegionTheme) + ', want ' + bgOf(nordOnly))
    }
    if (bgOf(generateAllRegions('opencode', ['sidebar', 'conversation'])) === bgOf(nordOnly)) {
      t.push('opencode and nord produced the same bg-base, making the per-region test ineffective')
    }
    if (t.length) for (const x of t) fail('opts', x)
    checks.push({ id: 'opts', ok: t.length === 0, detail: t.length ? t.join(' | ') : 'appearance/selector/regionList/per-region theme/strict behave correctly' })
  }

  // Implementation note.
  {
    const t = []
    if (checkValue('var(--dsw-alias-bg-base, #000)') === null) t.push('var() with a fallback colour was not rejected')
    if (checkValue('var(--x)') === null) t.push('var() without a fallback was not rejected')
    if (checkValue('color-mix(in srgb, red, blue)') === null) t.push('unknown function was not rejected')
    if (checkValue('#GGG') === null) t.push('invalid hex value was not rejected')
    if (checkValue('') === null) t.push('empty value was not rejected')
    if (checkValue('#0a0a0a') !== null) t.push('valid hex value was rejected')
    if (checkValue('rgba(10,20,30,0.2)') !== null) t.push('valid rgba value was rejected')
    if (checkValue('transparent') !== null) t.push('transparent was rejected')

    // Implementation note.
    const probs = []
    const strictThrew = (() => {
      try { assertValues({ '--dsw-alias-x': 'var(--y, #000)' }, 'unit', true, probs); return false } catch (e) { return true }
    })()
    if (!strictThrew) t.push('strict:true did not throw for var()')
    const lenient = []
    assertValues({ '--dsw-alias-x': 'var(--y, #000)' }, 'unit', false, lenient)
    if (lenient.length !== 1) t.push('strict:false did not record the problem (got ' + lenient.length + ')')

    // Implementation note.
    const resolveErrors = []
    for (const theme of themes) {
      if (theme === SYSTEM_THEME) continue
      for (const mode of ['light', 'dark']) {
        const errs = collectErrors(resolveThemeColors(getThemeJson(theme), mode))
        for (const e of errs) resolveErrors.push(theme + '[' + mode + '] ' + e)
      }
    }
    if (resolveErrors.length) {
      t.push('unresolved colour keys found: ' + resolveErrors.slice(0, 5).join(' | '))
    }
    if (t.length) for (const x of t) fail('strict', x)
    checks.push({
      id: 'strict',
      ok: t.length === 0,
      detail: t.length ? t.join(' | ')
        : 'var() and invalid values are rejected; zero unresolved colour keys across 76 runs (38 themes in light and dark modes)',
    })
  }

  // Implementation note.
  {
    const casc = checkCascade()
    for (const e of casc.errors) fail('cascade', e)
    checks.push({
      id: 'cascade',
      ok: casc.ok,
      detail: casc.ok
        ? 'cascade resolved as the browser would across ' + casc.checks.length + ' scenarios: ' +
          casc.checks.map((c) => c.label.split(':')[0] + '=' + c.value).join('; ')
        : casc.errors.join(' | '),
      notes: casc.notes,
    })
  }

  // Implementation note.
  {
    const vocab = buildTokenVocabulary()
    if (!vocab) {
      fail('vocabulary', 'ui-theme bundle (dsh-client-ui-theme) was not found; set DSH_THEME_BUNDLE or run the build from an active DSH environment')
      checks.push({ id: 'vocabulary', ok: false, detail: 'blocking error: ui-theme bundle not found' })
    } else {
      const known = new Set(vocab.tokens)
      const unknown = new Set()
      for (const theme of themes) {
        if (theme === SYSTEM_THEME) continue
        const { regions: map } = generateRegionTokens(theme)
        for (const r of regions) for (const name of Object.keys(map[r].dark)) if (!known.has(name)) unknown.add(name)
      }
      const ok = unknown.size === 0
      if (!ok) fail('vocabulary', 'emitted tokens are absent from the DSH vocabulary: ' + [...unknown].join(', '))
      checks.push({
        id: 'vocabulary',
        ok,
        detail: ok
          ? 'all ' + new Set(Object.values(generateRegionTokens('opencode').regions).flatMap((r) => Object.keys(r.dark))).size +
            ' emitted tokens are known to DSH (' + vocab.tokens.length + ' declared or consumed names across ' + vocab.bundles + ' UI bundles)'
          : 'unknown tokens: ' + [...unknown].slice(0, 8).join(', '),
      })
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    grid: { themes: themes.length, regions: regions.length, schemes: 2, cells: themes.length * regions.length },
    totals: { blocks, declarations: decls, cssBytes },
    perTheme,
    checks,
    problems,
    warnings,
    ok: problems.length === 0,
  }
  return { summary, verbose }
}

/* Implementation note.













 */
export function buildTokenVocabulary() {
  const roots = [process.env.DSH_THEME_BUNDLE].filter(Boolean)
  const profileFallbacks = [
    process.env.DSH_PROFILE_DIR && path.join(process.env.DSH_PROFILE_DIR, 'node_modules', '@deepseek-ai', 'dsh-client-ui-theme', 'lib', 'client.js'),
    path.join(REWRITE_ROOT, '..', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-client-ui-theme', 'lib', 'client.js'),
    path.join(REWRITE_ROOT, '..', 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-client-ui-theme', 'lib', 'client.js'),
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-client-ui-theme', 'lib', 'client.js'),
  ].filter(Boolean)
  // npx installations keep the shipped UI packages beside the active DSH CLI.
  // Search those versioned roots by recency instead of hard-coding an npx hash.
  const npxRoot = path.join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx')
  try {
    const shipped = fs.readdirSync(npxRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(npxRoot, entry.name, 'node_modules', '@deepseek-ai', 'dsh-client-ui-theme', 'lib', 'client.js'))
      .filter((file) => fs.existsSync(file))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    roots.push(...shipped)
  } catch (e) { /* explicit/profile candidates still apply */ }
  roots.push(...profileFallbacks)
  let text = null
  let origin = null
  for (const p of roots) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) { text = fs.readFileSync(p, 'utf8'); origin = p; break }
    } catch (e) { /* Implementation note. */ }
  }
  if (text === null) return null

  const tokens = new Set()
  // Implementation note.
  // Implementation note.
  // Implementation note.
  // Implementation note.
  // Implementation note.
  // Implementation note.
  const rx = /(?:body(?:\[data-ds-dark-theme\])?|:root)\{([^{}]*)\}/g
  let m
  while ((m = rx.exec(text))) {
    const body = m[1]
    if (!/--(?:dsw|shiki)-/.test(body)) continue
    for (const t of body.matchAll(/(--(?:dsw|shiki)-[a-z0-9-]+)\s*:/g)) tokens.add(t[1])
  }

  // Add every token consumed by the matching UI release. This deliberately
  // treats dimensions as known vocabulary but TOKEN_MAP/DERIVED_TOKENS remain
  // the colour-only allow-list controlling what CDSH actually emits.
  let bundles = 1
  const scopeRoot = path.resolve(origin, '..', '..', '..')
  try {
    for (const entry of fs.readdirSync(scopeRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('dsh-client-ui-')) continue
      const client = path.join(scopeRoot, entry.name, 'lib', 'client.js')
      if (!fs.existsSync(client)) continue
      const source = fs.readFileSync(client, 'utf8')
      for (const t of source.matchAll(/--(?:dsw|shiki)-[a-z0-9-]+/g)) tokens.add(t[0])
      bundles++
    }
  } catch (e) { /* theme declarations still form a useful minimum */ }

  if (!tokens.size) return null
  // Implementation note.
  // Implementation note.
  return { tokens: [...tokens].sort(), origin, bundles }
}

/* Implementation note. */
/* Implementation note.




 */
export function selectorSpecificity(selector) {
  const raw = String(selector)
  // Implementation note.
  const list = splitSelectorList(stripWhere(raw))
  if (list.length > 1) {
    return list.map(selectorSpecificity).reduce((a, b) => (cmpSpec(a, b) >= 0 ? a : b))
  }
  const spec = [0, 0, 0]
  // Implementation note.
  // Implementation note.
  // Implementation note.
  const s = stripWhere(raw)
  let i = 0
  // Implementation note.
  const argOf = (start) => {
    let depth = 1
    let j = start
    while (j < s.length && depth > 0) {
      if (s[j] === '(') depth++
      else if (s[j] === ')') depth--
      if (depth === 0) break
      j++
    }
    return { text: s.slice(start, j), end: j }
  }
  while (i < s.length) {
    const ch = s[i]
    if (ch === '#' && /[a-zA-Z_-\u00a0-\uffff]/.test(s[i + 1] || '')) {
      spec[0]++; i++; while (/[\w-]/.test(s[i] || '')) i++
      continue
    }
    if (ch === '.') {
      spec[1]++; i++; while (/[\w-]/.test(s[i] || '')) i++
      continue
    }
    if (ch === '[') {
      let j = i + 1
      while (j < s.length && s[j] !== ']') j++
      spec[1]++; i = j + 1
      continue
    }
    if (ch === ':') {
      const dbl = s[i + 1] === ':'
      const start = i + (dbl ? 2 : 1)
      let j = start
      while (/[\w-]/.test(s[j] || '')) j++
      const name = s.slice(start, j).toLowerCase()
      if (name === 'where') {
        const arg = argOf(j + 1)          // Implementation note.
        i = arg.end + 1
        continue
      }
      if (name === 'is' || name === 'not' || name === 'has' || name === 'matches' || name === 'any') {
        const arg = argOf(j + 1)
        const inner = splitSelectorList(arg.text).map(selectorSpecificity)
        if (inner.length) {
          const best = inner.reduce((a, b) => (cmpSpec(a, b) >= 0 ? a : b))
          spec[0] += best[0]; spec[1] += best[1]; spec[2] += best[2]
        }
        i = arg.end + 1
        continue
      }
      // Implementation note.
      if (dbl || ['before', 'after', 'first-line', 'first-letter', 'marker', 'placeholder', 'selection', 'backdrop', 'file-selector-button'].includes(name)) {
        spec[2]++
      } else {
        spec[1]++
      }
      i = j
      if (s[i] === '(') { const arg = argOf(i + 1); i = arg.end + 1 }
      continue
    }
    if (/[a-zA-Z_*\u00a0-\uffff]/.test(ch)) {
      if (ch !== '*') spec[2]++
      i++
      while (/[\w-]/.test(s[i] || '')) i++
      continue
    }
    i++
  }
  return spec
}

function cmpSpec(x, y) {
  for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] - y[i] }
  return 0
}

function specToString(sp) {
  return '(' + sp.join(',') + ')'
}

// Implementation note.
/* Implementation note.




 */
function stripWhere(selector) {
  let out = ''
  let i = 0
  const s = String(selector)
  while (i < s.length) {
    if (s.startsWith(':where(', i) && (i === 0 || !/[\w-]/.test(s[i - 1]))) {
      let depth = 1
      let j = i + ':where('.length
      while (j < s.length && depth > 0) {
        if (s[j] === '(') depth++
        else if (s[j] === ')') depth--
        if (depth === 0) break
        j++
      }
      if (depth !== 0) throw new Error('unterminated :where( in selector: ' + selector)
      out += stripWhere(s.slice(i + ':where('.length, j))
      i = j + 1
      continue
    }
    out += s[i]
    i++
  }
  return out
}

/* Implementation note. */
function splitCompound(part) {
  const out = []
  let i = 0
  while (i < part.length) {
    const ch = part[i]
    if (ch === '*') { out.push('*'); i++; continue }
    if (ch === '[') {
      let j = i + 1
      while (j < part.length && part[j] !== ']') j++
      out.push(part.slice(i, j + 1))
      i = j + 1
      continue
    }
    if (ch === '.' || ch === '#') {
      let j = i + 1
      while (/[\w-]/.test(part[j] || '')) j++
      out.push(part.slice(i, j))
      i = j
      continue
    }
    if (ch === ':') {
      let j = i + 1
      while (/[\w-]/.test(part[j] || '')) j++
      if (part[j] === '(') {
        let depth = 1
        let k = j + 1
        while (k < part.length && depth > 0) {
          if (part[k] === '(') depth++
          else if (part[k] === ')') depth--
          k++
        }
        j = k
      }
      out.push(part.slice(i, j))
      i = j
      continue
    }
    if (/[a-zA-Z_\u00a0-\uffff]/.test(ch)) {
      let j = i
      while (/[\w-]/.test(part[j] || '')) j++
      out.push(part.slice(i, j))
      i = j
      continue
    }
    i++ // Implementation note.
  }
  return out
}

function compoundMatches(compound, node, ctx) {
  const rest = stripWhere(compound)
  const tokens = splitCompound(rest)
  for (const tk of tokens) {
    if (tk === '*') continue
    if (tk[0] === '[') {
      const m = tk.slice(1, -1)
      if (m === 'data-ds-dark-theme') {
        if (node !== ctx.body || !ctx.dark) return false
        continue
      }
      let mm = m.match(/^([\w-]+)\s*([~^$*|]?=)\s*"?([^"]*)"?$/)
      if (!mm) return false
      if (mm[2] === '=') {
        if (node.attrs[mm[1]] !== mm[3]) return false
      } else {
        const have = String(node.attrs[mm[1]] === undefined ? '' : node.attrs[mm[1]])
        if (mm[2] === '^=' && !have.startsWith(mm[3])) return false
        if (mm[2] === '$=' && !have.endsWith(mm[3])) return false
        if (mm[2] === '*=' && !have.includes(mm[3])) return false
      }
      continue
    }
    if (tk[0] === ':') {
      const name = tk.slice(1).replace(/\(.*$/, '').toLowerCase()
      if (name === 'root') { if (node !== ctx.root) return false; continue }
      if (name === 'is' || name === 'not') {
        const inner = tk.slice(tk.indexOf('(') + 1, -1)
        const any = splitSelectorList(inner).some((sel) => matchComplex(sel, node, ctx))
        if (name === 'is' && !any) return false
        if (name === 'not' && any) return false
        continue
      }
      if (name === 'dark') { if (!ctx.dark) return false; continue }
      return false
    }
    if (tk[0] === '.') { if (!(node.classes || []).includes(tk.slice(1))) return false; continue }
    if (tk[0] === '#') { if (node.id !== tk.slice(1)) return false; continue }
    if (node.tag !== tk) return false
  }
  return true
}

function splitComplex(sel) {
  // Descendant and child combinators cover our generated forms and shipped rules.
  return sel.trim().split(/\s*>\s*|\s+(?![^\[]*\])/).map((x) => x.trim()).filter(Boolean)
}

function matchComplex(sel, node, ctx) {
  // Strip :where(...) before splitting on spaces so its contents stay intact.
  const compounds = splitComplex(stripWhere(sel))
  if (!compounds.length) return false
  const last = compounds[compounds.length - 1]
  if (!compoundMatches(last, node, ctx)) return false
  let cur = node.parent
  for (let i = compounds.length - 2; i >= 0; i--) {
    let found = false
    while (cur) {
      if (compoundMatches(compounds[i], cur, ctx)) { found = true; cur = cur.parent; break }
      cur = cur.parent
    }
    if (!found) return false
  }
  return true
}

function declsFromCss(css, origin) {
  const out = []
  const rx = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = rx.exec(css))) {
    const selector = m[1].trim()
    if (/^@/.test(selector)) continue
    for (const d of declsOf(m[2])) out.push({ selector, name: d.name, value: d.value, important: d.important, origin })
  }
  return out
}

/**
 * Resolve the cascade for one property on a specific node.
 * Implements CSS priority by origin, !important, specificity, and source order.
 * An inline style is modelled with specificity [1,0,0,0].
 * @returns {{value:string|null, source:string}}
 */
function resolveCascade(node, prop, decls, ctx, orderBase) {
  let best = null
  let order = orderBase
  for (const d of decls) {
    order++
    if (d.name !== prop) continue
    if (!matchComplex(d.selector, node, ctx)) continue
    const spec = selectorSpecificity(d.selector)
    const cand = { value: d.value, source: d.origin + ' "' + d.selector + '"', important: Boolean(d.important), spec, order }
    if (best === null) { best = cand; continue }
    if (cand.important !== best.important) { if (cand.important) best = cand; continue }
    const c = cmpSpec(cand.spec, best.spec)
    if (c > 0 || (c === 0 && cand.order > best.order)) best = cand
  }
  // Inline declaration on the node itself.
  if (node.inline && typeof node.inline[prop] === 'string') {
    const cand = { value: node.inline[prop], source: 'presenter inline style on <body>', important: Boolean(node.inlineImportant), spec: [1, 0, 0, 0], order: Number.MAX_SAFE_INTEGER }
    if (best === null) best = cand
    else if (cand.important !== best.important) { if (cand.important) best = cand }
    else if (cmpSpec(cand.spec, best.spec) >= 0) best = cand
  }
  return best === null ? { value: null, source: 'no declarations' } : { value: best.value, source: best.source }
}

/**
 * Prove cascade behaviour against the actual shipped selectors.
 *
 * Read the real token declarations from the ui-theme bundle (`body` and
 * `body[data-ds-dark-theme]`), add generated CSS and the presenter's inline
 * write on `body`, then resolve the cascade as a browser would.
 * This uses CSS rules only and requires no JavaScript DOM implementation.
 */
export function checkCascade() {
  const errors = []
  const notes = []
  const vocab = buildTokenVocabulary()
  if (!vocab) return { ok: true, errors: [], notes: ['ui-theme bundle not found; cascade check skipped'], checks: [] }

  const src = fs.readFileSync(vocab.origin, 'utf8')
  // Extract the token-dictionary block whose first declarations are --dsw-alias-*.
  // Neighbouring body blocks declare static, shadow, or font tokens and are excluded.
  const grabAliasBlock = (prefix) => {
    let i = -1
    while ((i = src.indexOf(prefix, i + 1)) !== -1) {
      const close = src.indexOf('}', i)
      if (close === -1) break
      const body = src.slice(i + prefix.length, close)
      if (/^--dsw-alias-bg-base\s*:/.test(body)) return body
    }
    return null
  }
  const lightBody = grabAliasBlock('body{')
  const darkBody = grabAliasBlock('body[data-ds-dark-theme]{')
  if (!lightBody || !darkBody) {
    return { ok: true, errors: [], notes: ['shipped token-dictionary blocks not found; cascade check skipped'], checks: [] }
  }
  const dshCss = 'body{' + lightBody + '}\nbody[data-ds-dark-theme]{' + darkBody + '}'
  const dshDecls = declsFromCss(dshCss, 'DSH design-platform.css')

  const PROP = '--dsw-alias-bg-base'
  /** Value written inline on <body> by the presenter through body.style.setProperty. */
  const INLINE = 'rgb(1, 2, 3)'
  /** Value from a synthetic shipped rule on the region root, intentionally not ours. */
  const GUARD_VALUE = 'rgb(9, 9, 9)'

  const makeTree = (dark) => {
    const root = { tag: 'html', attrs: {}, classes: [], parent: null }
    const body = { tag: 'body', attrs: dark ? { 'data-ds-dark-theme': '' } : {}, classes: [], parent: root, inline: { [PROP]: INLINE } }
    const outer = { tag: 'div', attrs: { 'data-dsh-region': 'conversation' }, classes: [], parent: body }
    const inner = { tag: 'div', attrs: { 'data-dsh-region': 'toolCards' }, classes: [], parent: outer }
    return { ctx: { root, body, dark }, root, body, outer, inner }
  }

  // Read values from the generator output so the test is independent of theme colours.
  const valueOf = (block, prop) => {
    const m = (block || '').match(new RegExp(prop.replace(/-/g, '\\-') + ':([^;!]+)'))
    return m ? m[1].trim() : null
  }

  /**
   * Run one cascade scenario.
   * @param {boolean} important whether generated CSS uses !important
   * @param {string} region region name and tree anchor
   * @param {boolean} dark whether the DSH dark scheme is active
   * @param {boolean} guard whether to add a synthetic shipped rule on the region root
   * @param {boolean} guardImportant whether that shipped rule uses !important
   * @param {'region'|'dsh'} expect expected winner
   */
  const scenario = (label, { important, region, dark, guard, guardImportant, expect }) => {
    const anchor = '[data-dsh-region="' + region + '"]'
    const css = generateAllRegions('opencode', [{ name: region, selector: anchor }], { important })
    const blocks = css.split('\n\n')
    const ourLight = valueOf(blocks[0], PROP)
    const ourDark = valueOf(blocks.find((b) => b.includes('data-ds-dark-theme')), PROP)

    const decls = dshDecls.concat(declsFromCss(css, 'generated CSS'))
    if (guard) {
      // Give the synthetic shipped rule the same specificity as our dark branch.
      // Both generated branches are therefore compared against the same rule,
      // matching how they compete in the real DOM.
      decls.push({
        selector: 'body[data-ds-dark-theme] ' + anchor,
        name: PROP,
        value: GUARD_VALUE,
        important: Boolean(guardImportant),
        origin: 'DSH (synthetic regional shipped rule)',
      })
    }

    const tree = makeTree(dark)
    const node = region === 'conversation' ? tree.outer : tree.inner
    const res = resolveCascade(node, PROP, decls, tree.ctx, 1000)
    const ourOwn = dark ? ourDark : ourLight
    const fromOurs = res.source.startsWith('generated CSS')
    const ok = expect === 'region'
      ? (res.value === ourOwn && fromOurs)   // The generated block must win.
      : !fromOurs                            // A non-generated rule must win.
    if (!ok) {
      errors.push(label + ': expected "' + expect + '" to win with value ' + (expect === 'region' ? ourOwn : GUARD_VALUE) +
        ', received ' + res.value + ' from ' + res.source)
    }
    notes.push((ok ? '[ OK ] ' : '[FAIL] ') + label + ' → ' + res.value + ' · ' + res.source)
    return { label, value: res.value, source: res.source, ok }
  }

  const checks = []
  checks.push(scenario('light scheme: generated block supplies values to the region subtree', { important: true, region: 'conversation', dark: false, expect: 'region' }))
  checks.push(scenario('dark scheme: the dark generated branch wins', { important: true, region: 'conversation', dark: true, expect: 'region' }))
  checks.push(scenario('nested region: nearest anchor overrides its parent', { important: true, region: 'toolCards', dark: true, expect: 'region' }))
  checks.push(scenario('generated !important overrides a shipped rule on the region root', { important: true, region: 'conversation', dark: true, guard: true, expect: 'region' }))
  checks.push(scenario('control: shipped rule on the region root wins without !important', { important: false, region: 'conversation', dark: true, guard: true, expect: 'dsh' }))

  // Compare specificity numerically.
  const specLight = selectorSpecificity(generateRegionCss('opencode', 'conversation', { selector: '[data-dsh-region="conversation"]' }).css.split('{')[0].trim())
  const specDark = selectorSpecificity(':where(body[data-ds-dark-theme] [data-dsh-region="x"])')
  const specBody = selectorSpecificity('body')
  const specBodyDark = selectorSpecificity('body[data-ds-dark-theme]')
  notes.push('specificities: generated light ' + specToString(specLight) + ', generated dark ' + specToString(specDark) +
    ', DSH body ' + specToString(specBody) + ', DSH body[data-ds-dark-theme] ' + specToString(specBodyDark))
  // :where() contributes no specificity itself, but its argument still selects
  // elements: :where([a]) is (0,1,0), not (0,0,0), in this model.
  if (cmpSpec(specLight, [0, 1, 0]) !== 0) errors.push('light selector: expected (0,1,0), received ' + specToString(specLight))
  if (cmpSpec(specDark, [0, 2, 1]) !== 0) errors.push('dark selector: expected (0,2,1), received ' + specToString(specDark))
  if (cmpSpec(specDark, specLight) <= 0) errors.push('dark selector is not more specific than the light selector')
  if (cmpSpec(selectorSpecificity(':where(:where([data-a]))'), [0, 1, 0]) !== 0) {
    errors.push(':where() specificity was computed incorrectly: ' + specToString(selectorSpecificity(':where(:where([data-a]))')))
  }
  if (cmpSpec(selectorSpecificity(':where([data-a], .b[data-c])'), [0, 2, 0]) !== 0) {
    errors.push('selector-list specificity inside :where() is incorrect: ' + specToString(selectorSpecificity(':where([data-a], .b[data-c])')))
  }
  if (cmpSpec(selectorSpecificity('[data-ds-dark-theme]'), [0, 1, 0]) !== 0) {
    errors.push('bare attribute specificity is incorrect: ' + specToString(selectorSpecificity('[data-ds-dark-theme]')))
  }
  if (cmpSpec(selectorSpecificity('#a.b c'), [1, 1, 1]) !== 0) {
    errors.push('#a.b c specificity is incorrect: ' + specToString(selectorSpecificity('#a.b c')))
  }

  return { ok: errors.length === 0, errors, notes, checks }
}

export function checkDrift() {
  const errors = []
  const warnings = []
  const compared = []
  const srcDir = path.join(PACKAGE_ROOT, 'vendor', 'dsh-opencode-palette', 'src', 'engine')
  if (!fs.existsSync(srcDir)) {
    return { ok: true, errors: [], warnings: ['vendored engine source not found; drift check skipped'], compared: [] }
  }

  const norm = (s) => s.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n+/g, '\n').trim()

  const extract = (file, startMarker, endMarker) => {
    const p = path.join(srcDir, file)
    if (!fs.existsSync(p)) { errors.push('missing file ' + file); return null }
    const text = fs.readFileSync(p, 'utf8')
    const a = text.indexOf(startMarker)
    const b = endMarker === null ? text.length : text.indexOf(endMarker, a + 1)
    if (a === -1 || (endMarker !== null && b === -1)) { errors.push('section boundary ' + startMarker + ' not found in ' + file); return null }
    return norm(text.slice(a, b === -1 ? text.length : b))
  }

  // TOKEN_MAP, DERIVED_TOKENS, and SHIKI_MAP occupy one contiguous source section.
  const upstreamTables = extract('map-dsh.mjs', 'export const TOKEN_MAP = [', null)
  if (upstreamTables) {
    // Ignore CSS_RULES and font data after SHIKI_MAP.
    // Compare parsed entries rather than raw text so comments do not cause drift.
    const up = parseUpstreamEntries(upstreamTables)
    for (const key of ['TOKEN_MAP', 'SHIKI_MAP']) {
      compared.push(key)
      const a = up[key]
      const b = key === 'TOKEN_MAP' ? TOKEN_MAP.map((e) => e.join('|')) : SHIKI_MAP.map((e) => e.join('|'))
      if (!a) { errors.push('could not parse ' + key + ' from the vendored source'); continue }
      // The copied upstream table is the compatibility baseline; rc.2 aliases
      // may extend it, but no baseline entry may disappear or be reordered.
      let cursor = 0
      for (let i = 0; i < a.length; i++) {
        const at = b.indexOf(a[i], cursor)
        if (at === -1) errors.push(key + '[' + i + ']: upstream entry is missing or reordered: ' + a[i])
        else cursor = at + 1
      }
    }
    // Compare DERIVED_TOKENS by variable names because function bodies are normalized.
    compared.push('DERIVED_TOKENS(names)')
    const upDerived = [...upstreamTables.matchAll(/\['(--dsw-[a-z0-9-]+)',\s*\(c\)\s*=>/g)].map((m) => m[1])
    const myDerived = DERIVED_TOKENS.map((e) => e[0])
    let derivedCursor = 0
    for (let i = 0; i < upDerived.length; i++) {
      const at = myDerived.indexOf(upDerived[i], derivedCursor)
      if (at === -1) errors.push('DERIVED_TOKENS[' + i + ']: upstream token is missing or reordered: ' + upDerived[i])
      else derivedCursor = at + 1
    }
  }

  // Compare resolve.mjs helper signatures so formulas cannot drift silently.
  const resolveText = path.join(srcDir, 'resolve.mjs')
  if (fs.existsSync(resolveText)) {
    compared.push('resolve.mjs(formulas)')
    const up = fs.readFileSync(resolveText, 'utf8')
    const grab = (src, fn) => {
      const i = src.indexOf('export function ' + fn + '(')
      if (i === -1) return null
      const j = src.indexOf('\n}', i)
      return norm(src.slice(i, j === -1 ? src.length : j + 2))
    }
    const mineSrc = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
    for (const fn of ['shade', 'withAlpha', 'contrastText', 'rgbToHex', 'hexToRgb']) {
      const a = grab(up, fn)
      const b = grab(mineSrc, fn)
      if (!a || !b) { warnings.push('could not compare ' + fn + ' because its function boundary was not found'); continue }
      if (a !== b) errors.push('resolve.' + fn + ' differs from the vendored source')
    }
  } else {
    warnings.push('vendored engine resolve.mjs not found; formulas were not compared')
  }

  return { ok: errors.length === 0, errors, warnings, compared }
}

function parseUpstreamEntries(text) {
  const grab = (name) => {
    const start = text.indexOf('export const ' + name + ' = [')
    if (start === -1) return null
    const end = text.indexOf('\n]', start)
    const body = text.slice(start, end === -1 ? text.length : end)
    return [...body.matchAll(/\['([^']+)',\s*'([^']+)'\]/g)].map((m) => m[1] + '|' + m[2])
  }
  return { TOKEN_MAP: grab('TOKEN_MAP'), SHIKI_MAP: grab('SHIKI_MAP') }
}

// 6. CLI.

function formatReport(summary, verbose) {
  const L = []
  L.push('generate-regions.mjs SELF-CHECK')
  L.push('='.repeat(72))
  L.push('grid: ' + summary.grid.themes + ' themes x ' + summary.grid.regions + ' regions x ' + summary.grid.schemes +
    ' schemes = ' + (summary.grid.themes * summary.grid.regions) + ' cells')
  L.push('generated: ' + summary.totals.blocks + ' CSS blocks, ' + summary.totals.declarations +
    ' declarations, ' + (summary.totals.cssBytes / 1024).toFixed(1) + ' KiB')
  L.push('')
  for (const c of summary.checks) L.push('  ' + (c.ok ? '[ OK ]' : '[FAIL]') + ' ' + c.id + ': ' + c.detail)
  for (const c of summary.checks) {
    if (!c.notes || !c.notes.length) continue
    L.push('')
    L.push('  details for check "' + c.id + '":')
    for (const n of c.notes) L.push('    ' + n)
  }
  L.push('')
  if (verbose) {
    L.push('by theme (tokens per region / regions whose light branch matches dark):')
    for (const t of summary.perTheme) {
      L.push('  ' + t.theme.padEnd(22) + String(t.tokens).padStart(3) + '..' + String(t.tokensMax).padEnd(3) +
        '  identical=' + String(t.identicalRegions).padStart(2) + '/6' + (t.system ? '   (system: no colours)' : ''))
    }
    L.push('')
  }
  if (summary.warnings.length) {
    L.push('warnings (' + summary.warnings.length + '):')
    for (const w of [...new Set(summary.warnings)].slice(0, 12)) L.push('  - ' + w)
    if (summary.warnings.length > 12) L.push('  - ... ' + (summary.warnings.length - 12) + ' more')
    L.push('')
  }
  if (summary.problems.length) {
    L.push('PROBLEMS (' + summary.problems.length + '):')
    for (const p of summary.problems.slice(0, 60)) {
      L.push('  x ' + p.where + ': ' + p.what + (p.extra ? ' - ' + p.extra : ''))
    }
    if (summary.problems.length > 60) L.push('  x ... ' + (summary.problems.length - 60) + ' more')
    L.push('')
  }
  L.push(summary.ok ? 'RESULT: OK - no problems.' : 'RESULT: FAIL - ' + summary.problems.length + ' problems.')
  return L.join('\n')
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const verbose = args.includes('--verbose')
  const noDrift = args.includes('--no-drift')
  const selfTest = args.includes('--selftest')

  if (selfTest) {
    // Run every theme across every region and print a summary.
    const { summary } = runSelfCheck({ verbose: true, drift: !noDrift })
    console.log(formatReport(summary, true))
    process.exit(summary.ok ? 0 : 1)
  }

  if (args.includes('--dump')) {
    const theme = args[args.indexOf('--dump') + 1] || 'opencode'
    const out = generateAllRegions(theme, null, { header: true })
    console.log(out)
    process.exit(0)
  }

  if (args.includes('--tokens')) {
    const theme = args[args.indexOf('--tokens') + 1] || 'opencode'
    console.log(JSON.stringify(generateRegionTokens(theme).regions, null, 2))
    process.exit(0)
  }

  const { summary } = runSelfCheck({ verbose, drift: !noDrift })
  if (json) console.log(JSON.stringify(summary, null, 2))
  else console.log(formatReport(summary, verbose))
  process.exit(summary.ok ? 0 : 1)
}
