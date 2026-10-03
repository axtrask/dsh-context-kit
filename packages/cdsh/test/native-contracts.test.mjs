import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { checkNativeContracts, NATIVE_ROOT } from '../scripts/check-native-contracts.mjs'

test('current DSH public slot and token contracts pass', () => {
  const result = checkNativeContracts()
  assert.match(result.version, /^0\.2\./)
  assert.equal(result.packages, 8)
  assert.equal(result.mode, 'semantic')
})

test('rejects a public slot contract disappearing', () => {
  assert.throws(() => checkNativeContracts(NATIVE_ROOT, {
    readFileSync(path) {
      const bytes = readFileSync(path)
      if (/dsh-client-ui-sidebar[/\\]lib[/\\]client\.js$/.test(path)) {
        return Buffer.from(String(bytes).replaceAll('sidebar.brand.name', 'sidebar.brand.renamed'))
      }
      return bytes
    },
  }), /Native semantic compatibility gate failed:[\s\S]+missing public contract sidebar\.brand\.name/)
})

test('rejects a mixed DSH package release', () => {
  assert.throws(() => checkNativeContracts(NATIVE_ROOT, {
    readFileSync(path) {
      const bytes = readFileSync(path)
      if (/dsh-client-ui-settings-plugins[/\\]package\.json$/.test(path)) {
        const manifest = JSON.parse(String(bytes))
        manifest.version = '0.2.99'
        return Buffer.from(JSON.stringify(manifest))
      }
      return bytes
    },
  }), /version 0\.2\.99 does not match DSH/)
})

test('rejects an unsupported DSH major/minor line', () => {
  assert.throws(() => checkNativeContracts(NATIVE_ROOT, {
    readFileSync(path) {
      const bytes = readFileSync(path)
      if (/[/\\]dsh[/\\]package\.json$/.test(path)) {
        const manifest = JSON.parse(String(bytes))
        manifest.version = '0.1.5-rc.3'
        return Buffer.from(JSON.stringify(manifest))
      }
      return bytes
    },
  }), /requires DSH 0\.2\.x/)
})

test('all output-producing entry points gate before writing', () => {
  for (const file of ['build.mjs', 'build-workspace-fixture.mjs', 'install-studio.mjs']) {
    const source = readFileSync(new URL('./' + file, import.meta.url), 'utf8')
    assert.match(source, /import \{[^}]*checkNativeContracts[^}]*\} from '\.\/check-native-contracts\.mjs'/)
    assert.match(source, /checkNativeContracts\((?:native)?\)/)
  }
})
