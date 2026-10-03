import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { designCss } from '../src/design.mjs'
import { workspaceCss } from '../src/workspace-style.mjs'
import { enhancementCss } from '../src/enhancements.mjs'
import { toolMotionCss } from '../src/tool-motion.mjs'
import { DEFAULT_TYPOGRAPHY, normalizeTypography } from '../src/runtime.mjs'

const css = designCss().replace(/\/\*[\s\S]*?\*\//g, '')
const build = readFileSync(new URL('../scripts/build.mjs', import.meta.url), 'utf8')
const workspace = readFileSync(new URL('../src/workspace.mjs', import.meta.url), 'utf8')
const panel = readFileSync(new URL('../src/panel.mjs', import.meta.url), 'utf8')

test('compatibility design contains owned CDSH CSS plus the narrow grouped-process adapter', () => {
  assert.equal(designCss(), workspaceCss + '\n' + enhancementCss + '\n' + toolMotionCss)
  assert.match(css, /\.studio-workspace/)
  assert.match(css, /\[data-step-process-content\]\[data-chat-flow\]\[data-cdsh-tool-grid="active"\]/)
  assert.doesNotMatch(css, /\[data-(?:composer|conversation-scroll)/)
})

test('default typography survives normalization as proportional UI', () => {
  assert.equal(normalizeTypography(DEFAULT_TYPOGRAPHY).mode, 'tui')
})

test('fresh typography uses the declared default without rewriting a saved mono choice', () => {
  assert.equal(normalizeTypography(undefined).mode, DEFAULT_TYPOGRAPHY.mode)
  assert.equal(normalizeTypography({ size: 15 }).mode, DEFAULT_TYPOGRAPHY.mode)
  assert.equal(normalizeTypography({ mode: 'mono' }).mode, 'mono')
})

test('host chat, composer, sidebar and header remain owned while grouped tool children get three columns', () => {
  for (const anchor of ['[data-composer-card]', '[data-slot="sidebar"]', '[data-slot="conversation.session.header"]']) {
    assert.ok(!css.includes(anchor), 'unexpected host anchor: ' + anchor)
  }
  assert.match(css, /flex-flow:row wrap/)
  assert.match(css, /width:33\.3333%/)
  assert.doesNotMatch(css, /position\s*:\s*fixed/)
})

test('build keeps native renderers, disables legacy flat-flow observers, and bundles grouped tool motion', () => {
  assert.doesNotMatch(build, /const (?:REQUIRED_STEMS|STEMS) = .*'nodes'/)
  assert.doesNotMatch(build, /lines\.push\('  nodes:/)
  assert.match(build, /lines\.push\('  times: false,'\)/)
  assert.match(build, /grouped-process-scoped tool-motion adapter/)
})

test('CDSH branding starts independently and workspace imports no Harness Client package', () => {
  assert.match(workspace, /'CDSH'/)
  assert.match(workspace, /slots\.inject\('sidebar\.brand\.name',[\s\S]+slots\.register\(\{ name: 'sidebar\.brand\.name', id: BRAND_ID, priority: -10 \}, SafeBrandName\)/)
  assert.match(workspace, /scope\.sidebarRightTabs\.register/)
  assert.doesNotMatch(workspace, /ctx\.inject\(\['sessions'/)
  assert.match(build, /const DEFAULT_CORDIS_INJECT = \['locale'\]/)
  assert.match(build, /exports\.apply = function \(ctx\)[\s\S]+apply\(ctx\);/)
  assert.match(build, /const DEFAULT_CLIENT_INJECT = \[\]/)
  assert.doesNotMatch(workspace, /primitives|@deepseek-ai\/dsh-client-ui-/)
  assert.doesNotMatch(build, /require\(["']@deepseek-ai\/dsh-client-ui-primitives["']\)/)
  assert.doesNotMatch(panel, /Opencode Palette|OpenCode Palette|Regional Palette/)
})

test('workspace uses the current right-tab guide contract without native DOM installers', () => {
  assert.match(workspace, /guide: \[\{ id: 'run', order: 20, title: \(\) => 'Run workspace', description: \(\) => 'Execution, recorded changes and native context usage\.' \}\]/)
  assert.doesNotMatch(workspace, /installNativeSurfaces|installTimes/)
})

test('workspace CSS is scoped, compact and avoids broad effects', () => {
  assert.ok(Buffer.byteLength(css) < 50 * 1024)
  assert.match(css, /--studio-panel:var\(--dsw-alias-bg-layer-1\)/)
  assert.match(css, /--studio-soft-line:var\(--dsw-alias-border-l1\)/)
  assert.doesNotMatch(css, /(?:^|\})\s*(?::root|html|body)\s*\{/)
  assert.doesNotMatch(css, /\[role=["']?(?:dialog|alertdialog|menu|listbox|tooltip)["']?\]/)
  assert.doesNotMatch(css, /(?:backdrop-filter|will-change)\s*:|transition:\s*all/)
  assert.doesNotMatch(css, /var\(\s*--dsw-[\w-]+\s*,/)
})
