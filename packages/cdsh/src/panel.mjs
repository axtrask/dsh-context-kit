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
// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
//   setAllRegionsTheme(theme) | setAllRegionsEnabled(bool) | setDefaultTheme(theme) |
//   localeNs | locale | regionList | regions | themeNames() | groups() | previews() | preview(name) |
//   fonts | bundledFonts | themeZh | version | repo | issues | subscribeLocale(fn)
//
// Implementation note.
// Implementation note.
// Implementation note.

// Implementation note.
const REGION_FALLBACK = [
  { key: 'sidebar', zh: '侧边栏', en: 'Sidebar', icon: '◧' },
  { key: 'header', zh: '顶栏', en: 'Header', icon: '▤' },
  { key: 'conversation', zh: '对话区', en: 'Conversation', icon: '✦' },
  { key: 'composer', zh: '输入框', en: 'Composer', icon: '⌨' },
  { key: 'toolCards', zh: '工具卡片', en: 'Tool cards', icon: '⚙' },
  { key: 'overlays', zh: '浮层', en: 'Overlays', icon: '▦' },
]

const DEFAULT_LOCALE_NS = 'cdsh'
const DEFAULT_THEME = 'opencode'
const DEFAULT_TYPOGRAPHY = { mode: 'mono', size: 13, fontKey: 'JetBrains Mono' }
const SIZE_VALUES = [11, 12, 13, 14, 15, 16, 17, 18]
const DEFAULT_REPO = 'https://github.com/deepseek-ai/DeepSeek-Harness'
const FEATURE_FALLBACK = {
  brand: true,
  workspace: true,
  turnInsights: true,
  planCopy: true,
  focusView: true,
}
const FEATURE_META = [
  { key: 'brand', title: 'CDSH brand', zhTitle: 'CDSH 品牌', description: 'Show the CDSH identity in the native sidebar.', zhDescription: '在原生侧边栏显示 CDSH 标识。' },
  { key: 'workspace', title: 'Run workspace', zhTitle: '运行工作区', description: 'Execution, recorded changes and native context pressure in the right pane.', zhDescription: '在右侧面板显示执行、变更记录与原生上下文压力。' },
  { key: 'turnInsights', title: 'Turn Insights', zhTitle: '回合洞察', description: 'Small native Chat tail badges with steps, actions and elapsed time.', zhDescription: '在原生 Chat 回合末尾显示步骤、操作与耗时。' },
  { key: 'planCopy', title: 'Copy Plan', zhTitle: '复制计划', description: 'A clipboard action beside native plan-review controls.', zhDescription: '在原生计划审阅操作旁提供复制到剪贴板按钮。' },
  { key: 'focusView', title: 'CDSH Focus', zhTitle: 'CDSH Focus', description: 'Optional searchable conversation map. Native Chat remains the default and fallback.', zhDescription: '可搜索的可选对话地图；原生 Chat 始终是默认和后备。' },
]

const DEFAULT_FONTS = {
  'JetBrains Mono': "'JetBrains Mono','Fira Code','Cascadia Code','IBM Plex Mono','SF Mono',Consolas,Menlo,'Liberation Mono','Courier New','PingFang SC','Microsoft YaHei'",
  'Cascadia Code': "'Cascadia Code','JetBrains Mono','Fira Code','IBM Plex Mono','SF Mono',Consolas,'Courier New','PingFang SC','Microsoft YaHei'",
  'Fira Code': "'Fira Code','JetBrains Mono','Cascadia Code','IBM Plex Mono','SF Mono',Consolas,'Courier New','PingFang SC','Microsoft YaHei'",
  'IBM Plex Mono': "'IBM Plex Mono','JetBrains Mono','Fira Code','Cascadia Code','SF Mono',Consolas,'Courier New','PingFang SC','Microsoft YaHei'",
  'SF Mono': "'SF Mono','JetBrains Mono','Fira Code','Cascadia Code','IBM Plex Mono',Consolas,'Courier New','PingFang SC','Microsoft YaHei'",
  Consolas: "Consolas,'JetBrains Mono','Fira Code','Cascadia Code','IBM Plex Mono','SF Mono','Courier New','PingFang SC','Microsoft YaHei'",
}
const BUNDLED_FONT_FALLBACK = ['JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Inter', 'IBM Plex Mono']

// Implementation note.
const I18N = {
  panelName: { zh: 'CDSH', en: 'CDSH' },
  subtitle: { zh: '每个区域独立配色：先选一个默认主题，再按需微调单个区域', en: 'Colour every region on its own: pick a default theme, then fine-tune single regions' },
  enabled: { zh: '已启用', en: 'Enabled' },
  disabled: { zh: '已停用', en: 'Disabled' },
  disableTitle: { zh: '点击停用主题', en: 'Click to disable' },
  enableTitle: { zh: '点击启用主题', en: 'Click to enable' },
  typography: { zh: '字体字号', en: 'Typography' },
  typographyHint: { zh: '全局界面字号和字体；会话字号由常规设置控制', en: 'Global interface size and fonts; General controls conversation size' },
  mono: { zh: '全部文字', en: 'All text' },
  sans: { zh: '仅代码', en: 'Code only' },
  fontSize: { zh: '字号', en: 'Font size' },
  codeFont: { zh: '代码字体', en: 'Code font' },
  fontNotInstalled: { zh: '本机未装', en: 'missing' },
  fontLocal: { zh: '本地', en: 'local' },
  defaultTheme: { zh: '默认主题', en: 'Default theme' },
  defaultThemeHint: { zh: '选一次，再一键铺到全部区域 —— 不必逐区选六次', en: 'Pick once, apply to every region in one click — no six manual picks' },
  applyToAll: { zh: '应用到全部区域', en: 'Apply to every region' },
  applyToAllHint: { zh: '把「{name}」写入全部区域并打开它们', en: 'Write “{name}” into every region and switch them on' },
  useOnly: { zh: '只用于这一个区域', en: 'Use for this region only' },
  pickedForAll: { zh: '默认主题已选为「{name}」，点右侧按钮一次铺开', en: 'Default theme set to “{name}” — click the button to apply it everywhere' },
  regions: { zh: '区域', en: 'Regions' },
  regionHint: { zh: '每个区域可单独开关与换色；点区域主题按钮展开选择', en: 'Each region toggles and themes on its own; open a row to change its colour' },
  search: { zh: '搜索主题…', en: 'Search themes…' },
  noMatch: { zh: '未找到匹配的主题', en: 'No matching themes' },
  systemDefault: { zh: 'system（宿主配色）', en: 'system (host colors)' },
  followDefault: { zh: '同默认', en: 'Default' },
  followsDefault: { zh: '跟随默认「{name}」', en: 'Follows default “{name}”' },
  customBadge: { zh: '自定义', en: 'Custom' },
  customCount: { zh: '{n} 个区域自定义', en: '{n} region(s) custom' },
  allDefault: { zh: '全部区域跟随默认主题', en: 'All regions follow the default theme' },
  enableAll: { zh: '全部开启区域', en: 'Enable all regions' },
  disableAll: { zh: '全部关闭区域', en: 'Disable all regions' },
  noRegions: { zh: '运行时未提供区域列表', en: 'Runtime provided no region list' },
  offNotice: { zh: '插件已停用：配色和扩展当前不生效，重新开启后保留原偏好并立即恢复', en: 'CDSH is off: colours and extensions are inactive. Your preferences are preserved and return when enabled.' },
  extensions: { zh: '扩展', en: 'Extensions' },
  extensionsHint: { zh: '每项独立检测兼容性；单项失败不会影响配色或其它功能', en: 'Each capability is detected independently; one failure never disables palettes or siblings.' },
  preview: { zh: '对话预览', en: 'Conversation preview' },
  previewHint: { zh: '在对话视图选择器中打开 CDSH Focus；原生 Chat 始终保留', en: 'Open CDSH Focus from the conversation view selector. Native Chat always remains available.' },
  requested: { zh: '已请求', en: 'Requested' },
  statusDisabled: { zh: '已停用', en: 'Disabled' },
  statusWaiting: { zh: '等待中', en: 'Waiting' },
  statusActive: { zh: '可用', en: 'Active' },
  statusUnsupported: { zh: '不支持', en: 'Unsupported' },
  statusFailed: { zh: '失败', en: 'Failed' },
  'group.warm': { zh: '暖橙', en: 'Warm' },
  'group.yellow-green': { zh: '黄绿', en: 'Yellow-green' },
  'group.teal': { zh: '青绿', en: 'Teal' },
  'group.cyan-blue': { zh: '青蓝', en: 'Cyan-blue' },
  'group.cool-blue': { zh: '冷蓝', en: 'Cool blue' },
  'group.violet': { zh: '蓝紫', en: 'Violet' },
  'group.neutral': { zh: '中性', en: 'Neutral' },
  'group.transparent': { zh: '透明', en: 'Transparent' },
  'group.special': { zh: '特殊', en: 'Special' },
  'region.sidebar': { zh: '侧边栏', en: 'Sidebar' },
  'region.header': { zh: '顶栏', en: 'Header' },
  'region.conversation': { zh: '对话区', en: 'Conversation' },
  'region.composer': { zh: '输入框', en: 'Composer' },
  'region.toolCards': { zh: '工具卡片', en: 'Tool cards' },
  'region.overlays': { zh: '浮层', en: 'Overlays' },
}

// Implementation note.
const THEME_ZH_FALLBACK = {
  tokyonight: '东京之夜', dracula: '德古拉', gruvbox: '复古凹槽', matrix: '黑客帝国',
  catppuccin: '卡布奇诺', 'catppuccin-frappe': '卡布奇诺·冰沙', 'catppuccin-macchiato': '卡布奇诺·玛奇朵',
  solarized: '日光浴', synthwave84: '合成波 84', everforest: '常青森林', nord: '北极',
  kanagawa: '神奈川', nightowl: '夜猫子', palenight: '苍白之夜', material: '材料设计', ayu: '鮎',
  carbonfox: '碳狐', cobalt2: '钴蓝', aura: '光环', flexoki: '纸墨', zenburn: '禅燃', mercury: '水星',
  'osaka-jade': '大阪翡翠', vesper: '黄昏星', 'lucent-orng': '透光橙', orng: '纯橙',
  'oc-2': 'OC 2', onedarkpro: 'One Dark Pro', shadesofpurple: '紫影', system: '跟随系统',
}

// Implementation note.
const PALETTE_VERSION = '__PALETTE_VERSION__' // eslint-disable-line no-unused-vars
const LOCALE_NS = 'cdsh'

// Implementation note.
function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) }
function isFn(v) { return typeof v === 'function' }
// Implementation note.
// Implementation note.
function sameUi(a, b) {
  if (a === b) return true
  if (!isObj(a) || !isObj(b)) return false
  if (a.enabled !== b.enabled || a.theme !== b.theme) return false
  const ta = a.typography || {}
  const tb = b.typography || {}
  if (ta.mode !== tb.mode || ta.size !== tb.size || ta.fontKey !== tb.fontKey) return false
  const ra = a.regions || {}
  const rb = b.regions || {}
  for (const k in ra) {
    if (rb[k] === undefined) return false
    if (ra[k].enabled !== rb[k].enabled || ra[k].theme !== rb[k].theme) return false
  }
  for (const k in rb) if (ra[k] === undefined) return false
  const fa = a.features || {}
  const fb = b.features || {}
  for (const k in fa) if (fb[k] !== fa[k]) return false
  for (const k in fb) if (fa[k] !== fb[k]) return false
  const ca = a.compatibility || {}
  const cb = b.compatibility || {}
  for (const k in ca) {
    if (!cb[k] || ca[k].status !== cb[k].status || ca[k].detail !== cb[k].detail) return false
  }
  for (const k in cb) if (!ca[k]) return false
  return true
}

// Implementation note.
// Implementation note.
// Implementation note.
let ReactRef = null
export function bindReact(react) {
  if (react && isObj(react) && isFn(react.createElement)) {
    ReactRef = react
    return true
  }
  return ReactRef !== null
}
function getReact() {
  // Implementation note.
  if (ReactRef) return ReactRef
  try { if (typeof require === 'function') { const r = require('react'); if (r) return bindReact(r) ? ReactRef : null } } catch (e) { /* Implementation note. */ }
  const g = globalThis
  try {
    const cands = [g.React, g.__DSH_REACT__, g.__dshReact, g.window && g.window.React, g.document && g.document.React]
    for (let i = 0; i < cands.length; i++) if (cands[i] && isFn(cands[i].createElement)) return bindReact(cands[i]) ? ReactRef : null
  } catch (e) { /* Implementation note. */ }
  return null
}

// Implementation note.
function isHostDark() {
  try {
    if (typeof document === 'undefined' || !document.body || !isFn(document.body.hasAttribute)) return true
    return document.body.hasAttribute('data-ds-dark-theme')
  } catch (e) { return true }
}

// Implementation note.
function domLang() {
  try {
    const l = (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang)
      || (typeof navigator !== 'undefined' && navigator.language) || 'en'
    return /^zh/i.test(String(l)) ? 'zh' : 'en'
  } catch (e) { return 'en' }
}
function serviceLang(svc) {
  try {
    if (!svc || !isFn(svc.getLocale)) return null
    const loc = svc.getLocale()
    if (!loc) return null
    const active = loc.active || loc.locale || loc.lang || loc.language
    return active ? (/^zh/i.test(String(active)) ? 'zh' : 'en') : null
  } catch (e) { return null }
}
function toLocaleDicts(i18n) {
  const zh = {}
  const en = {}
  for (const key in i18n) { zh[key] = i18n[key].zh; en[key] = i18n[key].en }
  return { zh: zh, en: en }
}
function readPath(obj, path) {
  let cur = obj
  const parts = String(path).split('.')
  for (let i = 0; i < parts.length; i++) {
    if (!isObj(cur)) return undefined
    cur = cur[parts[i]]
  }
  return cur
}
function pickDict(source) {
  if (!isObj(source)) return null
  const zh = source.zh || source['zh-CN'] || source['zh-cn'] || source['zh-Hans']
  const en = source.en || source['en-US'] || source['en-us']
  if (isObj(zh) || isObj(en)) return { zh: isObj(zh) ? zh : null, en: isObj(en) ? en : null }
  return null
}
// Implementation note.
function dictLookup(svc, ns, lang, key) {
  try {
    if (!svc || !isFn(svc.getLocale)) return undefined
    const loc = svc.getLocale()
    if (!loc) return undefined
    const dicts = (isObj(loc.dicts) && pickDict(loc.dicts[ns])) || (isObj(loc.messages) && pickDict(loc.messages[ns]))
    if (!dicts) return undefined
    const side = dicts[lang]
    if (!isObj(side)) return undefined
    const flat = side[key]
    if (flat !== undefined && typeof flat !== 'object') return flat
    const nested = readPath(side, key)
    return typeof nested === 'string' ? nested : undefined
  } catch (e) { return undefined }
}
function resolveLocaleNs(api) {
  if (!isObj(api)) return DEFAULT_LOCALE_NS
  if (typeof api.localeNs === 'string' && api.localeNs) return api.localeNs
  if (typeof api.namespace === 'string' && api.namespace) return api.namespace
  const maybe = api.locale || api.i18n
  if (maybe && typeof maybe.ns === 'string' && maybe.ns) return maybe.ns
  return DEFAULT_LOCALE_NS
}
function resolveLocaleService(api) {
  if (!isObj(api)) return null
  const cands = [api.locale, api.i18n, api.localeService]
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i]
    if (c && isFn(c.getLocale) && isFn(c.register)) return c
  }
  return null
}

// Implementation note.
function normalizeRegionEntry(entry, key, index) {
  if (typeof entry === 'string') return { key: key || entry, label: entry, zh: null, en: null, i18n: null, icon: null, order: index }
  if (!isObj(entry)) return { key: key || ('region-' + index), label: key || ('region-' + index), zh: null, en: null, i18n: null, icon: null, order: index }
  const labelRaw = entry.label
  const label = entry.zh || entry.en
    || (typeof labelRaw === 'string' ? labelRaw : null)
    || (isObj(labelRaw) ? (labelRaw.zh || labelRaw.en) : null)
  const icon = typeof entry.icon === 'string' ? entry.icon : (typeof entry.glyph === 'string' ? entry.glyph : null)
  return {
    key: entry.key || entry.id || key || ('region-' + index),
    label: label || entry.key || key || ('region-' + index),
    zh: typeof entry.zh === 'string' ? entry.zh : (isObj(labelRaw) && typeof labelRaw.zh === 'string' ? labelRaw.zh : null),
    en: typeof entry.en === 'string' ? entry.en : (isObj(labelRaw) && typeof labelRaw.en === 'string' ? labelRaw.en : null),
    i18n: typeof entry.i18n === 'string' ? entry.i18n : (typeof entry.labelKey === 'string' ? entry.labelKey : null),
    icon: icon,
    order: typeof entry.order === 'number' ? entry.order : index,
  }
}
function fallbackRegion(key) {
  for (let i = 0; i < REGION_FALLBACK.length; i++) if (REGION_FALLBACK[i].key === key) return REGION_FALLBACK[i]
  return null
}
// Implementation note.
function normalizeRegionList(raw) {
  const out = []
  if (raw === undefined || raw === null) return REGION_FALLBACK.map(function (r) { return { key: r.key, label: r.zh, zh: r.zh, en: r.en, i18n: null, icon: r.icon, order: null } })
  if (typeof raw === 'string') raw = [raw]
  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length; i++) out.push(normalizeRegionEntry(raw[i], null, i))
  } else if (isObj(raw)) {
    for (const k in raw) out.push(normalizeRegionEntry(raw[k], k, out.length))
  } else return []
  for (let j = 0; j < out.length; j++) {
    if (out[j].order === null) out[j].order = j
    const fb = fallbackRegion(out[j].key)
    if (fb) {
      if (!out[j].icon) out[j].icon = fb.icon
      if (!out[j].zh) out[j].zh = fb.zh
      if (!out[j].en) out[j].en = fb.en
      if (!out[j].label || out[j].label === out[j].key) out[j].label = fb.zh
    }
  }
  out.sort(function (a, b) { return (a.order === null ? 999 : a.order) - (b.order === null ? 999 : b.order) })
  return out
}
function normalizeState(raw) {
  const st = isObj(raw) ? raw : {}
  const typo = isObj(st.typography) ? st.typography : {}
  const rawRegions = isObj(st.regions) ? st.regions : {}
  const legacyTheme = typeof st.theme === 'string' && st.theme ? st.theme : null
  const regions = {}
  const keys = []
  for (let i = 0; i < REGION_FALLBACK.length; i++) keys.push(REGION_FALLBACK[i].key)
  for (const k in rawRegions) if (keys.indexOf(k) < 0) keys.push(k)
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    if (rawRegions[key] === undefined) {
      // Implementation note.
      regions[key] = { enabled: false, theme: legacyTheme || DEFAULT_THEME }
      continue
    }
    const r = rawRegions[key]
    if (isObj(r)) {
      regions[key] = {
        enabled: !!r.enabled,
        theme: typeof r.theme === 'string' && r.theme ? r.theme : (legacyTheme || DEFAULT_THEME),
      }
    } else {
      regions[key] = { enabled: !!r, theme: legacyTheme || DEFAULT_THEME }
    }
  }
  const rawFeatures = isObj(st.features) ? st.features : {}
  const features = {}
  for (const key in rawFeatures) if (typeof rawFeatures[key] === 'boolean') features[key] = rawFeatures[key]
  for (const key in FEATURE_FALLBACK) if (typeof features[key] !== 'boolean') features[key] = FEATURE_FALLBACK[key]
  const rawCompatibility = isObj(st.compatibility) ? st.compatibility : {}
  const compatibility = {}
  for (const key in FEATURE_FALLBACK) {
    const item = isObj(rawCompatibility[key]) ? rawCompatibility[key] : {}
    compatibility[key] = {
      status: typeof item.status === 'string' ? item.status : (features[key] ? 'waiting' : 'disabled'),
      detail: typeof item.detail === 'string' ? item.detail : '',
    }
  }
  return {
    enabled: st.enabled === undefined ? true : !!st.enabled,
    theme: legacyTheme,
    regions: regions,
    typography: {
      mode: typeof typo.mode === 'string' ? typo.mode : (typeof st.mode === 'string' ? st.mode : DEFAULT_TYPOGRAPHY.mode),
      size: typeof typo.size === 'number' ? typo.size : (typeof st.size === 'number' ? st.size : DEFAULT_TYPOGRAPHY.size),
      fontKey: typeof typo.fontKey === 'string' ? typo.fontKey : (typeof st.fontKey === 'string' ? st.fontKey : DEFAULT_TYPOGRAPHY.fontKey),
    },
    features: features,
    compatibility: compatibility,
  }
}

// Implementation note.
function themeListOf(api) {
  const v = pickData(api, ['themeNames', 'list', 'themes'])
  if (Array.isArray(v) && v.length > 0) return v
  return [DEFAULT_THEME, 'system']
}
function groupListOf(api) {
  const v = pickData(api, ['groups', 'themeGroups'])
  return Array.isArray(v) && v.length > 0 ? v : null
}
function previewMapOf(api, names) {
  const map = {}
  const raw = pickData(api, ['previews', 'previewColors'])
  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length; i++) {
      const it = raw[i]
      if (!isObj(it)) continue
      const nm = it.name || it.theme || it.key
      if (nm && isObj(it.colors)) map[nm] = it.colors
    }
  } else if (isObj(raw)) {
    for (const k in raw) {
      const v = raw[k]
      // Implementation note.
      if (isObj(v)) map[k] = v
    }
  }
  // Implementation note.
  const groups = groupListOf(api)
  if (Array.isArray(groups)) {
    for (let i = 0; i < groups.length; i++) {
      const themes = groups[i] && groups[i].themes
      if (!Array.isArray(themes)) continue
      for (let j = 0; j < themes.length; j++) {
        const t = themes[j]
        if (isObj(t) && t.name && isObj(t.colors) && !map[t.name]) map[t.name] = t.colors
      }
    }
  }
  // Implementation note.
  const single = api.preview || api.previewColors
  if (isFn(single)) {
    for (let i = 0; i < names.length; i++) {
      if (map[names[i]]) continue
      const c = callOrValue(single, names[i])
      if (isObj(c)) map[names[i]] = c
    }
  }
  return map
}
function buildGroups(names, groups) {
  if (Array.isArray(groups)) {
    const out = []
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i]
      const src = isObj(g) && Array.isArray(g.themes) ? g.themes : []
      const themes = []
      for (let j = 0; j < src.length; j++) {
        const t = src[j]
        const nm = typeof t === 'string' ? t : (isObj(t) ? (t.name || t.key) : null)
        if (nm) themes.push(nm)
      }
      if (themes.length > 0) out.push({ key: (isObj(g) && (g.name || g.key)) || 'themes', color: isObj(g) ? g.color : null, themes: themes })
    }
    if (out.length > 0) return out
  }
  return [{ key: '', color: null, themes: names.slice() }]
}
function fontsOf(api) {
  const v = callOrObj(api.fonts)
  return v || DEFAULT_FONTS
}
function bundledFontsOf(api) {
  const v = callOrValue(api.bundledFonts)
  return Array.isArray(v) && v.length > 0 ? v : BUNDLED_FONT_FALLBACK
}
// Implementation note.
function fontAvailable(family, bundled) {
  try {
    if (bundled.indexOf(family) >= 0) return true
    if (typeof document !== 'undefined' && document.fonts && isFn(document.fonts.check)) {
      return document.fonts.check('12px "' + family + '"')
    }
  } catch (e) { /* Implementation note. */ }
  return true
}
function safeName(name, names) {
  if (names.indexOf(name) >= 0) return name
  if (names.indexOf(DEFAULT_THEME) >= 0) return DEFAULT_THEME
  return names[0]
}

// Implementation note.
// Implementation note.
// Implementation note.
function callOrValue(x, arg) {
  try {
    if (isFn(x)) return x(arg)
  } catch (e) { return undefined }
  return x
}
function callOrObj(x, arg) {
  const v = callOrValue(x, arg)
  return isObj(v) && Object.keys(v).length > 0 ? v : null
}
// Implementation note.
function pickData(api, keys) {
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]
    if (api[k] === undefined || api[k] === null) continue
    const v = callOrValue(api[k])
    if (Array.isArray(v) && v.length > 0) return v
    if (isObj(v) && Object.keys(v).length > 0) return v
  }
  return null
}
// Implementation note.
function regionListOf(api) {
  const direct = callOrValue(api.regionList)
  if (Array.isArray(direct) && direct.length > 0) return normalizeRegionList(direct)
  if (isObj(direct) && Object.keys(direct).length > 0) return normalizeRegionList(direct)
  const ids = callOrValue(api.regionIds)
  if (Array.isArray(ids) && ids.length > 0) {
    const meta = isObj(api.regionMeta) ? api.regionMeta : null
    return normalizeRegionList(ids.map(function (id) {
      const m = meta && isObj(meta[id]) ? meta[id] : null
      return {
        key: id,
        label: m ? (m.label || m.i18n || m.note || id) : id,
        i18n: m && typeof m.i18n === 'string' ? m.i18n : 'region.' + id,
        icon: m && typeof m.icon === 'string' ? m.icon : null,
      }
    }))
  }
  // Implementation note.
  const regions = callOrValue(api.regions)
  if (isObj(regions) && Object.keys(regions).length > 0) {
    const first = regions[Object.keys(regions)[0]]
    if (isObj(first) && (first.theme !== undefined || first.enabled !== undefined)) return null
    return normalizeRegionList(regions)
  }
  return null
}
// Implementation note.
function themeZhOf(api, props) {
  if (isObj(props.themeZh)) return props.themeZh
  const own = callOrObj(api.themeZh)
  if (own) return own
  const i18n = callOrObj(api.i18n)
  if (i18n) {
    const fromI18n = i18n.themeZh || i18n.themes || i18n.themeNames
    if (isObj(fromI18n)) return fromI18n
  }
  return THEME_ZH_FALLBACK
}
// Implementation note.
function runtimeDictOf(api) {
  const i18n = callOrObj(api.i18n)
  if (!i18n) return null
  const zh = {}
  const en = {}
  let count = 0
  for (const k in i18n) {
    const e = i18n[k]
    if (!isObj(e)) continue
    if (typeof e.zh === 'string') { zh[k] = e.zh; count++ }
    if (typeof e.en === 'string') en[k] = e.en
  }
  return count > 0 ? { zh: zh, en: en } : null
}

// Implementation note.
function PalettePanel(props) {
  const p = isObj(props) ? props : {}
  const api = isObj(p.api) ? p.api : p
  const react = getReact()
  if (!react) {
    console.warn('[palette-panel] React is not ready (runtime bindReact must inject it); panel rendering is deferred')
    return null
  }
  const P = react.createElement

  // Implementation note.
  const getState = isFn(api.getState) ? api.getState : function () { return null }
  const setRegionTheme = isFn(api.setRegionTheme) ? api.setRegionTheme : function () {}
  const toggleRegion = isFn(api.toggleRegion) ? api.toggleRegion : function () {}
  const setEnabled = isFn(api.setEnabled) ? api.setEnabled : function () {}
  const setFeature = isFn(api.setFeature) ? api.setFeature : function () {}
  const refresh = isFn(api.refresh) ? api.refresh : function () {}
  const subscribe = isFn(api.subscribe) ? api.subscribe : null
  // Implementation note.
  const setAllRegionsTheme = isFn(api.setAllRegionsTheme) ? api.setAllRegionsTheme : null
  const setAllRegionsEnabled = isFn(api.setAllRegionsEnabled) ? api.setAllRegionsEnabled : null
  const setDefaultTheme = isFn(api.setDefaultTheme) ? api.setDefaultTheme : null
  const subscribeLocaleProp = isFn(api.subscribeLocale) ? api.subscribeLocale : null
  const localeSvc = p.locale || resolveLocaleService(api)
  const localeNs = resolveLocaleNs(api)
  const version = typeof api.version === 'string' && api.version ? api.version : PALETTE_VERSION
  const repo = typeof api.repo === 'string' && api.repo ? api.repo : DEFAULT_REPO
  const issues = typeof api.issues === 'string' && api.issues ? api.issues : repo + '/issues'
  const themeZh = themeZhOf(api, p)
  const runtimeDict = runtimeDictOf(api)
  const runtimeTr = isFn(api.tr) ? api.tr : null
  const fonts = fontsOf(api)
  const bundledFonts = bundledFontsOf(api)
  const names = themeListOf(api)
  const previews = previewMapOf(api, names)
  const groups = buildGroups(names, groupListOf(api))
  const regionList = regionListOf(api) || normalizeRegionList(null)

  // Implementation note.
  const [ui, setUi] = react.useState(function () { return normalizeState(getState()) })
  const [picked, setPicked] = react.useState(null)   // Implementation note.
  const [hostDark, setHostDark] = react.useState(isHostDark)
  const [, bump] = react.useState(0)                  // Implementation note.
  const [query, setQuery] = react.useState('')
  const [openMenu, setOpenMenu] = react.useState(null) // Implementation note.
  const [fontOpen, setFontOpen] = react.useState(false)
  const [sizeOpen, setSizeOpen] = react.useState(false)
  const rootRef = react.useRef(null)
  const menuTrigger = react.useRef(null)
  // Implementation note.
  // Implementation note.
  const apiRef = react.useRef(null)
  apiRef.current = {
    getState: getState, setRegionTheme: setRegionTheme, toggleRegion: toggleRegion,
    setEnabled: setEnabled, setFeature: setFeature, refresh: refresh, subscribe: subscribe,
    localeSvc: localeSvc, subscribeLocale: subscribeLocaleProp,
  }

  const lang = serviceLang(localeSvc) || domLang()
  const st = normalizeState(ui)
  const regionKeys = regionList.map(function (r) { return r.key })

  // Implementation note.
  // Implementation note.
  // Implementation note.
  // Implementation note.
  const tr = function (key) {
    const fromHost = dictLookup(localeSvc, localeNs, lang, key)
    if (fromHost !== undefined) return fromHost
    const entry = I18N[key]
    if (entry) return entry[lang] !== undefined ? entry[lang] : key
    if (runtimeDict) {
      const side = runtimeDict[lang]
      if (isObj(side) && typeof side[key] === 'string') return side[key]
    }
    if (runtimeTr) { try { const v = runtimeTr(key); if (typeof v === 'string' && v !== key) return v } catch (e) { /* Implementation note. */ } }
    return key
  }
  const tf = function (key, vars) {
    let out = tr(key)
    if (isObj(vars)) for (const k in vars) out = out.split('{' + k + '}').join(String(vars[k]))
    return out
  }
  // Implementation note.
  const sync = function () {
    const next = normalizeState(getState())
    setUi(function (prev) { return sameUi(prev, next) ? prev : next })
  }
  const themeLabel = function (name) {
    if (name === 'system') return tr('systemDefault')
    if (name === 'opencode') return lang === 'zh' ? 'CDSH 默认' : 'CDSH Default'
    return lang === 'zh' ? (themeZh[name] || name) : name
  }
  const groupLabel = function (key) {
    const entry = I18N['group.' + key]
    return entry ? entry[lang] : key
  }
  const regionText = function (region) {
    const entry = I18N['region.' + region.key]
    if (entry) return entry[lang] !== undefined ? entry[lang] : entry.en
    const dict = runtimeDict && runtimeDict[lang]
    if (dict && region.i18n && typeof dict[region.i18n] === 'string') return dict[region.i18n]
    if (runtimeTr && region.i18n) {
      try { const v = runtimeTr(region.i18n); if (typeof v === 'string' && v !== region.i18n) return v } catch (e) { /* Implementation note. */ }
    }
    return (lang === 'zh' && region.zh) ? region.zh : (region.en || region.label || region.key)
  }

  // Implementation note.
  // Implementation note.
  // Implementation note.
  // Implementation note.
  // Implementation note.
  const derivedDefault = (function () {
    if (picked && names.indexOf(picked) >= 0) return picked
    let only = null
    let uniform = regionList.length > 0
    for (let i = 0; i < regionList.length; i++) {
      const r = st.regions[regionList[i].key]
      const t = r && typeof r.theme === 'string' ? r.theme : null
      if (t === null) { uniform = false; break }
      if (only === null) only = t
      else if (only !== t) { uniform = false; break }
    }
    if (uniform && only !== null && names.indexOf(only) >= 0) return only
    if (typeof st.theme === 'string' && names.indexOf(st.theme) >= 0) return st.theme
    for (let j = 0; j < regionList.length; j++) {
      const r = st.regions[regionList[j].key]
      if (r && r.enabled && names.indexOf(r.theme) >= 0) return r.theme
    }
    return names.indexOf(DEFAULT_THEME) >= 0 ? DEFAULT_THEME : names[0]
  })()
  const customKeys = regionKeys.filter(function (k) {
    const r = st.regions[k]
    return r && r.theme !== derivedDefault
  })
  const onCount = regionKeys.filter(function (k) { return st.regions[k] && st.regions[k].enabled }).length
  const allOn = regionKeys.length > 0 && onCount === regionKeys.length

  // Implementation note.
  // Implementation note.
  const applyToAll = function (theme) {
    const nm = safeName(theme, names)
    if (!st.enabled) setEnabled(true)
    if (setAllRegionsTheme) setAllRegionsTheme(nm)
    else for (let i = 0; i < regionKeys.length; i++) setRegionTheme(regionKeys[i], nm)
    if (!allOn) {
      if (setAllRegionsEnabled) setAllRegionsEnabled(true)
      else for (let i = 0; i < regionKeys.length; i++) toggleRegion(regionKeys[i], true)
    }
    setPicked(null)
    sync()
  }
  // Implementation note.
  const setOne = function (key, theme) {
    const nm = safeName(theme, names)
    if (!st.enabled) setEnabled(true)
    if (st.regions[key] && !st.regions[key].enabled) toggleRegion(key, true)
    setRegionTheme(key, nm)
    sync()
  }
  const toggleOne = function (key, next) {
    toggleRegion(key, next)
    sync()
  }
  const setAllOn = function (on) {
    if (setAllRegionsEnabled) setAllRegionsEnabled(on)
    else for (let i = 0; i < regionKeys.length; i++) toggleRegion(regionKeys[i], on)
    sync()
  }
  const commitTypography = function (next) {
    refresh(next.mode, next.size, next.fontKey)
    setUi(function (prev) {
      const base = normalizeState(prev)
      return { enabled: base.enabled, theme: base.theme, regions: base.regions, typography: { mode: next.mode, size: next.size, fontKey: next.fontKey }, features: base.features, compatibility: base.compatibility }
    })
    sync()
  }
  const pickDefault = function (name) {
    if (setDefaultTheme) { setDefaultTheme(name); sync(); return }
    setPicked(name)
  }

  // Implementation note.
  const anyOpen = openMenu !== null || fontOpen || sizeOpen
  function closeMenuOnEscape(event) {
    if (event.key !== 'Escape' || !anyOpen || event.isComposing) return
    event.preventDefault(); event.stopPropagation()
    setOpenMenu(null); setFontOpen(false); setSizeOpen(false)
    if (menuTrigger.current && menuTrigger.current.isConnected) menuTrigger.current.focus()
  }
  // Implementation note.
  react.useEffect(function () {
    const r0 = apiRef.current
    if (!r0.subscribe) return
    let disposed = false
    const off = r0.subscribe(function (next) {
      if (disposed) return
      // Implementation note.
      const snap = r0.getState()
      const snapshot = isObj(next) ? normalizeState(next) : normalizeState(snap)
      setUi(function (prev) { return sameUi(prev, snapshot) ? prev : snapshot })
    })
    return function () {
      disposed = true
      if (isFn(off)) { try { off() } catch (e) { /* Implementation note. */ } }
    }
  }, [])
  // Implementation note.
  react.useEffect(function () {
    const r0 = apiRef.current
    if (r0.subscribeLocale) {
      const off = r0.subscribeLocale(function () { bump(function (n) { return n + 1 }) })
      return function () { if (isFn(off)) { try { off() } catch (e) { /* Implementation note. */ } } }
    }
    const svc = r0.localeSvc
    if (!svc || !isFn(svc.subscribe)) return
    let revision = null
    try { const loc = svc.getLocale(); revision = loc && loc.revision } catch (e) { revision = null }
    const off = svc.subscribe(function (cur) {
      let next = cur
      if (next === undefined) { try { next = svc.getLocale() } catch (e) { next = null } }
      const rev = isObj(next) ? next.revision : undefined
      if (rev !== undefined && rev === revision) return
      revision = rev !== undefined ? rev : null
      bump(function (n) { return n + 1 })
    })
    return function () { if (isFn(off)) { try { off() } catch (e) { /* Implementation note. */ } } }
  }, [])
  // Implementation note.
  react.useEffect(function () {
    if (apiRef.current.localeSvc) return
    if (typeof MutationObserver === 'undefined' || typeof document === 'undefined' || !document.documentElement) return
    let obs = null
    try {
      obs = new MutationObserver(function () { bump(function (n) { return n + 1 }) })
      obs.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
    } catch (e) { obs = null }
    return function () { if (obs) { try { obs.disconnect() } catch (e) { /* Implementation note. */ } } }
  }, [])
  // Implementation note.
  react.useEffect(function () {
    if (typeof MutationObserver === 'undefined' || typeof document === 'undefined' || !document.body) return
    let obs = null
    try {
      obs = new MutationObserver(function () { setHostDark(isHostDark()) })
      obs.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    } catch (e) { obs = null }
    return function () { if (obs) { try { obs.disconnect() } catch (e) { /* Implementation note. */ } } }
  }, [])
  // Implementation note.
  react.useEffect(function () {
    if (!anyOpen) return
    if (typeof document === 'undefined') return
    const onDoc = function (e) {
      const root = rootRef.current
      if (root && e && e.target && isFn(root.contains) && root.contains(e.target)) return
      setOpenMenu(null); setFontOpen(false); setSizeOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    // Native Settings handles Escape on document capture; the inner popup goes first.
    const onKey = function (event) {
      if (rootRef.current && rootRef.current.contains(event.target)) closeMenuOnEscape(event)
    }
    const view = document.defaultView
    if (view) view.addEventListener('keydown', onKey, true)
    return function () {
      document.removeEventListener('mousedown', onDoc)
      if (view) view.removeEventListener('keydown', onKey, true)
    }
  }, [anyOpen])

  // Implementation note.
  const base = 'var(--dsw-alias-label-primary)'
  const muted = 'var(--dsw-alias-label-secondary)'
  const faint = 'var(--dsw-alias-label-tertiary)'
  const dim = 'var(--dsw-alias-label-dimmed)'
  const line = 'var(--dsw-alias-border-l1)'
  const panelBg = 'var(--dsw-alias-bg-layer-2)'
  const rowBg = 'var(--dsw-alias-bg-layer-2)'
  const inputBg = 'var(--dsw-alias-bg-layer-2)'
  const hoverBg = 'var(--dsw-alias-interactive-bg-hover)'
  const activeBg = 'var(--dsw-alias-interactive-bg-active)'
  const menuBg = 'var(--dsw-alias-bg-overlay)'
  const brand = 'var(--dsw-alias-brand-primary)'
  const menuShadow = hostDark ? '0 8px 24px rgba(0,0,0,0.5)' : '0 8px 24px rgba(0,0,0,0.18)'
  const switchOffTrack = 'var(--dsw-alias-bg-layer-3)'
  const switchOffKnob = 'var(--dsw-alias-label-tertiary)'
  const chipShadow = hostDark ? undefined : '0 1px 3px rgba(0,0,0,0.25)'
  const codeFont = 'var(--ds-font-family-code)'
  const uiFont = 'var(--dsw-font-family)'
  const ease = 'var(--ds-ease-in-out)'

  const S = {
    root: { display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 960, color: base, fontFamily: uiFont, fontSize: 13 },
    header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
    title: { fontWeight: 600, fontSize: 14 },
    headerRight: { display: 'inline-flex', alignItems: 'center', gap: 8, flex: 'none' },
    link: { color: muted, textDecoration: 'none', cursor: 'pointer', display: 'inline-flex', lineHeight: 1 },
    status: { fontSize: 12, color: st.enabled ? 'var(--dsw-alias-state-success-primary)' : muted },
    subtitle: { fontSize: 12, color: muted, marginTop: -6 },
    notice: { fontSize: 12, color: 'var(--dsw-alias-state-warn-primary)', border: '1px solid ' + line, borderRadius: 6, padding: '6px 10px', background: panelBg },
    sec: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', fontSize: 11, color: faint, letterSpacing: '.08em', textTransform: 'uppercase' },
    secHint: { fontSize: 11, color: dim, letterSpacing: 0, textTransform: 'none' },
    count: { color: dim, fontSize: 11, letterSpacing: 0 },
    deck: { display: 'flex', flexDirection: 'column', gap: 10, border: '1px solid ' + line, borderRadius: 8, padding: 12, background: panelBg },
    groupRow: { display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: faint, margin: '4px 0 2px' },
    chipRow: { display: 'flex', flexWrap: 'wrap', gap: 6 },
    row: { display: 'flex', flexDirection: 'column', alignItems: 'stretch', border: '1px solid ' + line, borderRadius: 8, background: rowBg },
    rowHead: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', flexWrap: 'wrap' },
    regionName: { fontSize: 13, color: base, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 200 },
    badge: { fontSize: 10, color: faint, border: '1px solid ' + line, borderRadius: 4, padding: '1px 5px', flex: 'none' },
    spacer: { flex: '1 1 auto', minWidth: 8 },
    menuPanel: { borderTop: '1px solid ' + line, padding: 10, display: 'flex', flexDirection: 'column', gap: 9 },
    menuEmpty: { fontSize: 12, color: muted, padding: '6px 2px' },
    input: { width: '100%', boxSizing: 'border-box', background: inputBg, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6, padding: '6px 10px', fontSize: 12, outline: 'none', color: base, fontFamily: uiFont },
    btn: { display: 'inline-flex', alignItems: 'center', gap: 7, background: inputBg, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6, padding: '5px 10px', fontSize: 12, cursor: 'pointer', color: base, fontFamily: uiFont },
    btnPrimary: { display: 'inline-flex', alignItems: 'center', gap: 7, background: 'var(--dsw-alias-button-primary-fill)', border: '1px solid var(--dsw-alias-button-primary-fill)', borderRadius: 6, padding: '5px 12px', fontSize: 12, cursor: 'pointer', color: 'var(--dsw-alias-label-primary-foreground)', fontFamily: uiFont, fontWeight: 600 },
    btnMuted: { display: 'inline-flex', alignItems: 'center', gap: 7, background: inputBg, border: '1px dashed ' + line, borderRadius: 6, padding: '5px 12px', fontSize: 12, cursor: 'default', color: dim, fontFamily: uiFont, opacity: 0.65 },
    seg: { display: 'inline-flex', background: inputBg, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6, padding: 2, gap: 2 },
    hint: { fontSize: 11, color: dim },
    pickedHint: { fontSize: 11, color: 'var(--dsw-alias-state-warn-primary)' },
    featureList: { display: 'flex', flexDirection: 'column', gap: 8 },
    featureRow: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', border: '1px solid ' + line, borderRadius: 8, padding: '9px 10px', background: rowBg },
    featureText: { display: 'flex', flexDirection: 'column', gap: 2, flex: '1 1 360px', minWidth: 180 },
    featureTitle: { color: base, fontSize: 12, fontWeight: 600 },
    statusBadge: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, lineHeight: '16px', border: '1px solid ' + line, borderRadius: 999, padding: '1px 7px', whiteSpace: 'nowrap' },
    previewCard: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', border: '1px solid ' + line, borderRadius: 8, padding: 12, background: panelBg },
    ddPanel: { position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 30, background: menuBg, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, padding: 4, boxShadow: menuShadow, maxHeight: 320, overflow: 'auto' },
    switcher: function (on) {
      return {
        position: 'relative', display: 'inline-block', width: 36, height: 20, flex: 'none', borderRadius: 11, cursor: 'pointer',
        background: on ? brand : switchOffTrack, boxShadow: 'inset 0 0 0 1px ' + line, transition: 'background 120ms ' + ease,
      }
    },
    knob: function (on) {
      return {
        position: 'absolute', top: 3, left: on ? 19 : 3, width: 14, height: 14, borderRadius: '50%',
        background: on ? 'var(--dsw-alias-label-primary-foreground)' : switchOffKnob, transition: 'left 120ms ' + ease,
      }
    },
  }

  const dot = function (color, size) {
    return P('span', { key: 'd', style: { width: size, height: size, borderRadius: '50%', background: color || faint, display: 'inline-block', flex: 'none' } })
  }
  // Implementation note.
  const chipStyle = function (colors, selected) {
    const bg = colors && colors.background ? colors.background : inputBg
    let fg = base
    if (colors && colors.text && (hostDark || colors.background)) fg = colors.text
    return {
      display: 'inline-flex', alignItems: 'center', gap: 5, background: bg, color: fg,
      border: selected ? '2px solid ' + brand : '1px solid ' + ((colors && colors.primary) || (hostDark ? line : 'var(--dsw-alias-border-l1)')),
      borderRadius: 6, padding: '3px 8px 3px 5px', boxShadow: chipShadow, fontFamily: codeFont,
      fontSize: 12, minHeight: 32, lineHeight: '16px', cursor: 'pointer',
    }
  }
  const switchNode = function (on, onToggle, label) {
    return P('button', {
      type: 'button',
      role: 'switch',
      'aria-label': label,
      'aria-checked': on ? 'true' : 'false',
      title: on ? tr('disableTitle') : tr('enableTitle'),
      onClick: function () { onToggle(!on) },
      style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 44, minHeight: 32, padding: 4, border: 0, background: 'transparent', flex: 'none', cursor: 'pointer' },
    }, P('span', { style: S.switcher(on), 'aria-hidden': true }, P('span', { key: 'k', style: S.knob(on) })))
  }
  const statusLabel = function (status) {
    const key = 'status' + String(status || 'waiting').charAt(0).toUpperCase() + String(status || 'waiting').slice(1)
    return tr(key)
  }
  const statusColor = function (status) {
    if (status === 'active') return 'var(--dsw-alias-state-success-primary)'
    if (status === 'failed') return 'var(--dsw-alias-state-error-primary)'
    if (status === 'waiting' || status === 'unsupported') return 'var(--dsw-alias-state-warn-primary)'
    return muted
  }
  const seg = function (value, options, onChange) {
    return P('div', { style: S.seg }, options.map(function (opt) {
      const on = opt.value === value
      return P('button', {
        key: String(opt.value),
        type: 'button',
        'aria-pressed': on,
        onClick: function () { onChange(opt.value) },
        style: {
          border: 0, borderRadius: 4, padding: '4px 10px', fontSize: 12, cursor: 'pointer',
          background: on ? activeBg : 'transparent', color: on ? base : muted, fontFamily: uiFont,
        },
      }, opt.label)
    }))
  }
  const dropdown = function (open, setOpen, labelNode, items, minWidth) {
    return P('div', { style: { position: 'relative' } }, [
      P('button', { key: 'b', type: 'button', 'aria-expanded': open, onClick: function (event) { menuTrigger.current = event.currentTarget; setOpenMenu(null); setFontOpen(false); setSizeOpen(false); setOpen(!open) }, style: S.btn },
        [labelNode, P('span', { key: 'a', style: { color: muted } }, '▾')]),
      open ? P('div', { key: 'p', style: Object.assign({}, S.ddPanel, { minWidth: minWidth || 180, width: 'max-content', maxWidth: 'calc(100vw - 48px)' }) }, items) : null,
    ])
  }
  const ddItem = function (key, label, on, onClick, extra) {
    return P('button', {
      key: key,
      type: 'button',
      'aria-pressed': on,
      title: extra && extra.title,
      onClick: function () { onClick(); if (menuTrigger.current) menuTrigger.current.focus() },
      style: Object.assign({
        display: 'block', width: '100%', textAlign: 'start', border: 0, fontFamily: uiFont,
        padding: '6px 10px', fontSize: 12, borderRadius: 5, cursor: 'pointer',
        background: on ? hoverBg : 'transparent', color: on ? base : muted, whiteSpace: 'nowrap',
      }, extra || {}),
    }, label)
  }

  // Implementation note.
  const themeGrid = function (mode, activeKey) {
    const q = query.trim().toLowerCase()
    const shown = groups.map(function (g) {
      const themes = q === ''
        ? g.themes
        : g.themes.filter(function (n) { return (n + ' ' + (themeZh[n] || '')).toLowerCase().indexOf(q) >= 0 })
      return { key: g.key, color: g.color, themes: themes }
    }).filter(function (g) { return g.themes.length > 0 })
    return P('div', { key: 'grid', style: { display: 'flex', flexDirection: 'column', gap: 9 } }, [
      P('input', {
        key: 'q',
        placeholder: tr('search'),
        'aria-label': tr('search'),
        value: query,
        onChange: function (e) { setQuery(e.target.value) },
        style: Object.assign({}, S.input, { maxWidth: 380 }),
      }),
      shown.length === 0
        ? P('div', { key: 'empty', style: S.hint }, tr('noMatch'))
        : P('div', { key: 'gs', style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            shown.map(function (g) {
              return P('div', { key: g.key || 'all' }, [
                P('div', { key: 'h', style: S.groupRow }, [dot(g.color, 8), P('span', { key: 'n' }, groupLabel(g.key)), P('span', { key: 'c', style: S.count }, String(g.themes.length))]),
                P('div', { key: 'r', style: S.chipRow }, g.themes.map(function (name) {
                  const cur = mode === 'global' ? name === derivedDefault : !!(st.regions[activeKey] && st.regions[activeKey].theme === name)
                  return P('button', {
                    key: name,
                    // Implementation note.
                    'data-theme': name,
                    'data-scope': mode,
                    'aria-pressed': cur ? 'true' : 'false',
                    title: mode === 'global' ? tf('applyToAllHint', { name: themeLabel(name) }) : tr('useOnly'),
                    onClick: function () { if (mode === 'global') pickDefault(name); else setOne(activeKey, name) },
                    style: chipStyle(previews[name], cur),
                  }, [
                    dot(previews[name] && previews[name].primary, 9),
                    P('span', { key: 'l' }, themeLabel(name)),
                    cur ? P('span', { key: 'c', style: { color: brand, fontWeight: 700 } }, '✓') : null,
                  ])
                })),
              ])
            })),
    ])
  }

  // Implementation note.
  const regionRow = function (region) {
    const key = region.key
    const value = st.regions[key] || { enabled: false, theme: derivedDefault }
    const isDefault = value.theme === derivedDefault
    const open = openMenu === key
    const display = isDefault && value.enabled ? tf('followsDefault', { name: themeLabel(derivedDefault) }) : themeLabel(value.theme)
    return P('div', { key: key, style: S.row }, [
      P('div', { key: 'h', style: S.rowHead }, [
        P('span', { key: 'i', style: { color: faint, fontSize: 13, width: 16, textAlign: 'center', flex: 'none' } }, region.icon || '·'),
        P('span', { key: 'n', style: S.regionName, title: key }, regionText(region)),
        isDefault ? null : P('span', { key: 'b', style: S.badge }, tr('customBadge')),
        P('span', { key: 's', style: S.spacer }),
        value.enabled ? null : P('span', { key: 'o', style: { fontSize: 11, color: dim, flex: 'none' } }, tr('disabled')),
        P('button', {
          key: 'p',
          title: tr('regionHint'),
          'data-region': key,
          'aria-expanded': open ? 'true' : 'false',
          onClick: function (event) { menuTrigger.current = event.currentTarget; setOpenMenu(open ? null : key); setFontOpen(false); setSizeOpen(false) },
          style: Object.assign({}, S.btn, { maxWidth: 320 }),
        }, [
          dot(previews[value.theme] && previews[value.theme].primary, 9),
          P('span', { key: 'l', style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: isDefault ? muted : base } }, display),
          P('span', { key: 'a', style: { color: muted, flex: 'none' } }, open ? '▴' : '▾'),
        ]),
        switchNode(value.enabled, function (next) { toggleOne(key, next) }, regionText(region)),
      ]),
      open ? P('div', { key: 'm', style: S.menuPanel }, [
        P('div', { key: 'h2', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, [
          P('span', { key: 't', style: S.hint }, regionText(region) + ' · ' + key),
          P('span', { key: 's2', style: S.spacer }),
          P('button', {
            key: 'd',
            onClick: function () { setOne(key, derivedDefault); setOpenMenu(null) },
            title: tf('applyToAllHint', { name: themeLabel(derivedDefault) }),
            style: S.btn,
          }, tr('followDefault') + ' · ' + themeLabel(derivedDefault)),
        ]),
        themeGrid('region', key),
      ]) : null,
    ])
  }

  // Implementation note.
  const header = P('div', { key: 'header', style: S.header }, [
    P('strong', { key: 't', style: S.title }, tr('panelName')),
    P('div', { key: 'r', style: S.headerRight }, [
      P('span', { key: 'v', style: { fontSize: 11, color: faint } }, 'v' + version),
      P('a', {
        key: 'star', href: repo, target: '_blank', rel: 'noopener noreferrer',
        title: lang === 'zh' ? '你的 ⭐是我夜空中最亮的星' : 'A star means a lot',
        style: Object.assign({}, S.link, { fontSize: 15 }),
      }, 'Source'),
      P('a', {
        key: 'iss', href: issues, target: '_blank', rel: 'noopener noreferrer',
        title: lang === 'zh' ? '任何功能需求、故障、建议、意见都可以提ISSUE' : 'Issues and feature requests welcome',
        style: S.link,
      }, P('svg', {
        width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', style: { display: 'block' },
      }, [
        P('circle', { key: 'c', cx: 12, cy: 12, r: 10 }),
        P('line', { key: 'l1', x1: 12, y1: 8, x2: 12, y2: 12 }),
        P('line', { key: 'l2', x1: 12, y1: 16, x2: 12.01, y2: 16 }),
      ])),
      P('span', { key: 'st', style: S.status }, st.enabled ? tr('enabled') : tr('disabled')),
      switchNode(st.enabled, function (next) { setEnabled(next); sync() }, tr('panelName')),
    ]),
  ])

  // Implementation note.
  const typography = P('div', { key: 'typo', style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
    P('div', { key: 'sec', style: S.sec }, [
      P('span', { key: 't' }, tr('typography')),
      P('span', { key: 'h', style: S.secHint }, tr('typographyHint')),
    ]),
    P('div', { key: 'ctl', style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } }, [
      seg(st.typography.mode, [
        { value: 'mono', label: tr('mono') },
        { value: 'tui', label: tr('sans') },
      ], function (v) { commitTypography({ mode: v, size: st.typography.size, fontKey: st.typography.fontKey }) }),
      dropdown(sizeOpen, setSizeOpen,
        P('span', { key: 'l' }, tr('fontSize') + ' ' + st.typography.size + 'px'),
        SIZE_VALUES.map(function (n) {
          return ddItem('s' + n, String(n) + 'px', n === st.typography.size, function () {
            setSizeOpen(false)
            commitTypography({ mode: st.typography.mode, size: n, fontKey: st.typography.fontKey })
          })
        }), 120),
      dropdown(fontOpen, setFontOpen,
        P('span', { key: 'l', style: { fontFamily: fonts[st.typography.fontKey] || fonts[DEFAULT_TYPOGRAPHY.fontKey] } }, st.typography.fontKey),
        Object.keys(fonts).map(function (k) {
          const on = k === st.typography.fontKey
          const ok = fontAvailable(k, bundledFonts)
          const bundled = bundledFonts.indexOf(k) >= 0
          const suffix = bundled ? '' : ' (' + (ok ? tr('fontLocal') : tr('fontNotInstalled')) + ')'
          return ddItem('f' + k, k + suffix, on, function () {
            setFontOpen(false)
            commitTypography({ mode: st.typography.mode, size: st.typography.size, fontKey: k })
          }, { opacity: ok ? 1 : 0.45, title: ok ? '' : tr('fontNotInstalled') })
        }), 220),
    ]),
  ])

  // Implementation note.
  // Implementation note.
  // Implementation note.
  // Implementation note.
  const pendingPick = picked !== null
  const uniformAll = customKeys.length === 0
  const deck = P('div', { key: 'deck', style: S.deck }, [
    P('div', { key: 'sec', style: S.sec }, [
      P('span', { key: 't' }, tr('defaultTheme') + ' · ' + themeLabel(derivedDefault)),
      P('span', { key: 'h', style: S.secHint }, tr('defaultThemeHint')),
    ]),
    P('div', { key: 'row', style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } }, [
      P('button', {
        key: 'bulk',
        onClick: function () { applyToAll(derivedDefault) },
        disabled: uniformAll,
        title: uniformAll ? tr('allDefault') : tf('applyToAllHint', { name: themeLabel(derivedDefault) }),
        style: uniformAll ? S.btnMuted : S.btnPrimary,
      }, tr('applyToAll') + ' · ' + themeLabel(derivedDefault)),
      P('span', { key: 'sp', style: S.spacer }),
      regionKeys.length > 0
        ? P('button', { key: 'all', onClick: function () { setAllOn(!allOn) }, style: S.btn },
            allOn ? tr('disableAll') : tr('enableAll'))
        : null,
      P('span', { key: 'sum', style: S.hint }, customKeys.length === 0 ? tr('allDefault') : tf('customCount', { n: customKeys.length })),
    ]),
    pendingPick ? P('div', { key: 'pk', style: S.pickedHint }, tf('pickedForAll', { name: themeLabel(derivedDefault) })) : null,
    themeGrid('global'),
  ])

  // Implementation note.
  const regionSection = P('div', { key: 'regions', style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
    P('div', { key: 'sec', style: S.sec }, [
      P('span', { key: 't' }, tr('regions')),
      P('span', { key: 'c', style: S.count }, onCount + '/' + regionKeys.length),
      P('span', { key: 'h', style: S.secHint }, tr('regionHint')),
    ]),
    regionList.length === 0
      ? P('div', { key: 'none', style: S.hint }, tr('noRegions'))
      : P('div', { key: 'list', style: { display: 'flex', flexDirection: 'column', gap: 8 } }, regionList.map(regionRow)),
  ])

  const extensionSection = P('div', { key: 'extensions', style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
    P('div', { key: 'sec', style: S.sec }, [
      P('span', { key: 't' }, tr('extensions')),
      P('span', { key: 'h', style: S.secHint }, tr('extensionsHint')),
    ]),
    P('div', { key: 'list', style: S.featureList }, FEATURE_META.map(function (meta) {
      const requested = st.features[meta.key] !== false
      const compatibility = st.compatibility[meta.key] || { status: requested ? 'waiting' : 'disabled', detail: '' }
      const color = statusColor(compatibility.status)
      return P('div', { key: meta.key, 'data-cdsh-feature': meta.key, style: S.featureRow }, [
        P('div', { key: 'text', style: S.featureText }, [
          P('span', { key: 'title', style: S.featureTitle }, lang === 'zh' ? meta.zhTitle : meta.title),
          P('span', { key: 'description', style: S.hint }, lang === 'zh' ? meta.zhDescription : meta.description),
          compatibility.detail ? P('span', { key: 'detail', style: Object.assign({}, S.hint, { color: color }) }, compatibility.detail) : null,
        ]),
        P('span', { key: 'status', title: compatibility.detail || statusLabel(compatibility.status), style: Object.assign({}, S.statusBadge, { color: color }) }, [
          dot(color, 6),
          P('span', { key: 'label' }, statusLabel(compatibility.status)),
        ]),
        switchNode(requested, function (next) { setFeature(meta.key, next); sync() }, (lang === 'zh' ? meta.zhTitle : meta.title) + ' · ' + tr('requested')),
      ])
    })),
  ])

  const focusCompatibility = st.compatibility.focusView || { status: st.features.focusView ? 'waiting' : 'disabled', detail: '' }
  const previewSection = P('div', { key: 'preview', style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
    P('div', { key: 'sec', style: S.sec }, [
      P('span', { key: 't' }, tr('preview')),
      P('span', { key: 'h', style: S.secHint }, tr('previewHint')),
    ]),
    P('div', { key: 'card', style: S.previewCard }, [
      P('span', { key: 'native', style: Object.assign({}, S.statusBadge, { color: base }) }, 'Chat · native'),
      P('span', { key: 'arrow', style: { color: dim } }, '↔'),
      P('span', { key: 'focus', style: Object.assign({}, S.statusBadge, { color: statusColor(focusCompatibility.status) }) }, 'CDSH Focus · ' + statusLabel(focusCompatibility.status)),
      P('span', { key: 'hint', style: Object.assign({}, S.hint, { flex: '1 1 260px' }) }, tr('previewHint')),
    ]),
  ])

  const children = [P('style', { key: 'controls' }, `
    [data-studio-palette-panel] :is(button,a) { min-height:32px;box-sizing:border-box }
    [data-studio-palette-panel] :is(button,a,input):focus-visible { outline:2px solid var(--dsw-alias-brand-primary)!important;outline-offset:2px }
    [data-studio-palette-panel] input { min-width:0 }
    @media (pointer:coarse) { [data-studio-palette-panel] :is(button,a) { min-height:44px!important } }
    @media (max-width:480px) { [data-studio-palette-panel] button[data-region] { max-width:100%!important } }
    @media (prefers-reduced-motion:reduce) { [data-studio-palette-panel] * { transition:none!important } }
  `), header, P('div', { key: 'sub', style: S.subtitle }, tr('subtitle'))]
  if (!st.enabled) children.push(P('div', { key: 'notice', style: S.notice }, tr('offNotice')))
  children.push(typography)
  children.push(deck)
  children.push(regionSection)
  children.push(extensionSection)
  children.push(previewSection)
  return P('div', { ref: rootRef, 'data-studio-palette-panel': '', style: S.root, onKeyDown: closeMenuOnEscape }, children)
}

// Implementation note.
export function createPanelComponent() {
  const React = getReact()
  if (!React || !React.Component) return function PanelShell(props) { return PalettePanel(props) }
  class PanelBoundary extends React.Component {
    constructor(props) { super(props); this.state = { error: null } }
    static getDerivedStateFromError(error) { return { error: error } }
    componentDidCatch(error) { console.warn('[palette-panel] rendering failed and was isolated', error) }
    render() {
      if (!this.state.error) return this.props.children
      return React.createElement('div', {
        role: 'status',
        style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, padding: 10 },
      }, 'CDSH settings are temporarily unavailable.')
    }
  }
  return function PanelShell(props) {
    return React.createElement(PanelBoundary, null, React.createElement(PalettePanel, props))
  }
}

// Implementation note.
// Implementation note.
export function registerPanel(ctx, options) {
  const opts = isObj(options) ? options : {}
  const api = opts.api
  if (!isObj(api)) throw new Error('[palette-panel] registerPanel requires options.api (the runtime panel interface)')
  const slots = ctx && ctx.slots ? ctx.slots : (ctx && isFn(ctx.get) ? ctx.get('slots') : null)
  if (!slots) {
    console.warn('[palette-panel] slots service is unavailable; panel was not registered')
    return function () {}
  }
  const Panel = isFn(opts.Component) ? opts.Component : createPanelComponent()
  const primary = typeof opts.slot === 'string' && opts.slot ? opts.slot : 'settings.plugins.tab'
  const order = typeof opts.order === 'number' ? opts.order : 30
  const tr = isFn(opts.tr) ? opts.tr : function () { return typeof opts.label === 'string' ? opts.label : 'CDSH' }
  const id = typeof opts.id === 'string' && opts.id ? opts.id : 'cdsh'
  const descriptors = [{ slot: primary, order: order }]
  if (primary === 'settings.plugins.tab' && opts.withSection !== false) {
    descriptors.push({ slot: 'settings.section', order: typeof opts.sectionOrder === 'number' ? opts.sectionOrder : 16 })
  }
  if (Array.isArray(opts.extraSlots)) {
    for (let i = 0; i < opts.extraSlots.length; i++) {
      const e = opts.extraSlots[i]
      if (isObj(e) && typeof e.slot === 'string') descriptors.push({ slot: e.slot, order: typeof e.order === 'number' ? e.order : order })
    }
  }
  const disposers = []
  const seen = {}
  for (let i = 0; i < descriptors.length; i++) {
    const d = descriptors[i]
    if (seen[d.slot]) continue
    seen[d.slot] = true
    try {
      const off = slots.inject(d.slot, function () {
        try {
          return slots.register({
            name: d.slot,
            id: id,
            order: d.order,
            label: function () { return tr('panelName') },
            inject: function () { return api },
          }, Panel)
        } catch (error) {
          console.warn('[palette-panel] deferred registration failed: ' + d.slot, error)
          return function () {}
        }
      })
      if (isFn(off)) disposers.push(off)
      else if (off && isFn(off.dispose)) disposers.push(function () { off.dispose() })
    } catch (e) {
      console.warn('[palette-panel] slot registration failed: ' + d.slot, e)
    }
  }
  return function () {
    for (let i = 0; i < disposers.length; i++) { try { disposers[i]() } catch (e) { /* Implementation note. */ } }
    disposers.length = 0
  }
}

export function getLocaleNamespace() { return LOCALE_NS }
export function getI18nDicts() { return toLocaleDicts(I18N) }
export const REGIONS = REGION_FALLBACK.slice()
export const I18N_TABLE = I18N
// Implementation note.
// Implementation note.
