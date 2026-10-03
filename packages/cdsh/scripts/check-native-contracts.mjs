import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REQUIRED_PACKAGES = Object.freeze([
  'dsh',
  'dsh-client-store',
  'dsh-client-ui-primitives',
  'dsh-client-ui-sidebar',
  'dsh-client-ui-sidebar-right',
  'dsh-client-ui-settings-plugins',
  'dsh-client-ui-slots',
  'dsh-client-ui-theme',
])

export const NATIVE_ROOT = process.env.DSH_NATIVE_ROOT ? resolve(process.env.DSH_NATIVE_ROOT) : null

function text(io, file) {
  return String(io.readFileSync(file))
}

/**
 * Verify only the public rc.2 contracts CDSH actually consumes.
 *
 * The former gate pinned every UI bundle byte and a retired web-frontend asset
 * name from DSH 0.1.5. That treated any upstream release as corruption while
 * providing no useful compatibility signal. This semantic gate checks package
 * identity/version plus the supported slot and theme-token contracts used by
 * the compatibility implementation.
 */
export function checkNativeContracts(root = NATIVE_ROOT, io = { readFileSync }) {
  if (!root) throw new Error('Set DSH_NATIVE_ROOT to the installed node_modules/@deepseek-ai directory.')
  const errors = []
  let runtimeVersion = ''
  const manifests = new Map()

  for (const name of REQUIRED_PACKAGES) {
    try {
      const manifest = JSON.parse(text(io, join(root, name, 'package.json')))
      const expectedName = '@deepseek-ai/' + name
      if (manifest.name !== expectedName) errors.push(name + ': expected package identity ' + expectedName)
      if (name === 'dsh') runtimeVersion = String(manifest.version || '')
      manifests.set(name, manifest)
    } catch (error) {
      errors.push(name + ': package unavailable or invalid: ' + error.message)
    }
  }

  if (!/^0\.2\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(runtimeVersion)) {
    errors.push('dsh: CDSH compatibility release requires DSH 0.2.x, found ' + (runtimeVersion || 'unknown'))
  }
  for (const [name, manifest] of manifests) {
    if (name !== 'dsh' && runtimeVersion && manifest.version !== runtimeVersion) {
      errors.push(name + ': version ' + manifest.version + ' does not match DSH ' + runtimeVersion)
    }
  }

  const contracts = [
    ['dsh-client-ui-sidebar', 'lib/client.js', ['sidebar.brand.name', 'sidebar.brand.mark']],
    ['dsh-client-ui-sidebar-right', 'lib/client.js', ['sidebar.right.pane.tab', 'keepMounted']],
    ['dsh-client-ui-settings-plugins', 'lib/client.js', ['settings.plugins.tab', 'renderSlot']],
    ['dsh-client-ui-theme', 'lib/client.js', ['--dsw-alias-label-primary', '--dsw-alias-brand-primary-new-colorprimary-new-color']],
  ]
  for (const [name, file, anchors] of contracts) {
    try {
      const source = text(io, join(root, name, file))
      for (const anchor of anchors) if (!source.includes(anchor)) errors.push(name + ': missing public contract ' + anchor)
    } catch (error) {
      errors.push(name + ': ' + file + ' unavailable: ' + error.message)
    }
  }

  if (errors.length) {
    throw new Error('Native semantic compatibility gate failed:\n' + errors.join('\n') + '\nReview the public slot/token contracts before releasing CDSH.')
  }
  return { version: runtimeVersion, packages: REQUIRED_PACKAGES.length, mode: 'semantic' }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log('Native compatibility: ' + JSON.stringify(checkNativeContracts())) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
