import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { designCss } from '../src/design.mjs'
import { workspaceCss } from '../src/workspace-style.mjs'
import { enhancementCss } from '../src/enhancements.mjs'
import { toolMotionCss } from '../src/tool-motion.mjs'

test('CDSH branding is injected through the native brand-name seat', () => {
  const workspace = readFileSync(new URL('../src/workspace.mjs', import.meta.url), 'utf8')
  assert.match(workspace, /sidebar\.brand\.name/)
  assert.match(workspace, /'CDSH'/)
  assert.doesNotMatch(workspace, /sidebar\.brand\.mark/)
  assert.doesNotMatch(workspace, /workspace-shell/)
})

test('the workspace composes through native seats without redeclaring native children', () => {
  const source = readFileSync(new URL('../src/workspace.mjs', import.meta.url), 'utf8')
  assert.match(source, /sidebarRightTabs\.register/)
  assert.match(source, /sidebar\.right\.pane\.tab/)
  assert.match(source, /scope\.sidebarRight\.openTab\(WORKSPACE_KIND, \{ params \}\)/)
  assert.doesNotMatch(source, /name: ['"](?:root|main|shell\.overlay)['"]|children:\s*\{|renderSlot\(|function ChatNode\(/)
  assert.doesNotMatch(source, /workspace-shell|createWorkspaceShell/)
})

test('compatibility presentation adds only the grouped-process tool adapter to owned workspace CSS', () => {
  const css = designCss()
  assert.equal(css, workspaceCss + '\n' + enhancementCss + '\n' + toolMotionCss)
  assert.match(css, /\.studio-context-meter/)
  assert.match(css, /\.studio-changes-page/)
  assert.match(css, /\[data-step-process-content\]\[data-chat-flow\]\[data-cdsh-tool-grid="active"\]/)
  assert.doesNotMatch(css, /\[data-composer-card/)
  for (const value of ['studio-shell', 'data-studio-shell', 'studio-inspector-header', 'studio-inline-inspector', 'studio-brand']) {
    assert.ok(!css.includes(value), 'Legacy shell artefact ' + value)
  }
})

test('prototype faithful and frame styles stay quarantined and tool grid follows its region toggle', () => {
  const source = readFileSync(new URL('../src/design.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /faithfulCss|frameCss|nativeCss/)
  assert.equal(designCss({ regions: { conversation: { enabled: true, theme: 'nord' } } }), workspaceCss + '\n' + enhancementCss + '\n' + toolMotionCss)
  assert.equal(designCss({ regions: { toolCards: { enabled: false } } }), workspaceCss + '\n' + enhancementCss)
})
