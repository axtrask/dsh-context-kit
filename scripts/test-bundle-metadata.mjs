import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readPluginMeta } from '@deepseek-ai/dsh-app-boot';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const runtimeManifest = JSON.parse(await readFile(join(root, 'runtime', 'package.json'), 'utf8'));
const locale = JSON.parse(await readFile(join(root, 'locale', 'en.json'), 'utf8'));
const runtimeLocale = JSON.parse(await readFile(join(root, 'runtime', 'locale', 'en.json'), 'utf8'));
const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8');
const runtimePatch = await readFile(join(root, 'runtime', 'cordis.patch.yml'), 'utf8');
const client = await readFile(join(root, 'lib', 'edit-client.js'), 'utf8');
const runtimeClient = await readFile(join(root, 'runtime', 'client.js'), 'utf8');

assert.equal(
  manifest.exports?.['./package.json'],
  './package.json',
  'Plugin Manager must be able to resolve the bundle manifest',
);
assert.equal(
  manifest.exports?.['./locale/*.json'],
  './locale/*.json',
  'Plugin Manager must be able to resolve bundle locale metadata',
);
assert.ok(
  manifest.files?.includes('locale/*.json'),
  'published bundle must include bundle locale metadata',
);
assert.ok(
  manifest.files?.includes('locale/**/*.json'),
  'published bundle must include component locale metadata',
);
assert.equal(locale.meta?.title, 'Context Kit');
assert.match(locale.meta?.description ?? '', /DCP/i);
assert.match(locale.meta?.description ?? '', /Context Mode/i);
assert.doesNotMatch(locale.meta?.title ?? '', /^file:/i);

const loaderNames = [...patch.matchAll(/^\s*name:\s*(\S+)\s*$/gmu)].map(match => match[1]);
const runtimeLoaderNames = [...runtimePatch.matchAll(/^\s*name:\s*(\S+)\s*$/gmu)].map(match => match[1]);
assert.deepEqual(loaderNames, ['dsh-context-kit'], 'the normal bundle must have one combined Loader source');
assert.deepEqual(runtimeLoaderNames, ['./entry.js'], 'the hot-migration bundle must use a fresh, patch-anchored Loader source');
assert.equal(manifest.dsh?.client?.platform, 'web');
assert.equal(runtimeManifest.dsh?.bundle?.patch, './cordis.patch.yml');
assert.equal(runtimeManifest.dsh?.client?.platform, 'web');
assert.equal(runtimeManifest.exports?.['.'], './index.js');
assert.ok(runtimeManifest.files?.includes('entry.js'), 'the hot-migration package must publish its fresh Host entry');
assert.equal(runtimePatch.replace('name: ./entry.js', 'name: dsh-context-kit'), patch,
  'normal and hot-migration bundles may differ only by their Loader import address');
const runtimePlugin = await import('../runtime/index.js');
assert.equal(typeof runtimePlugin.apply, 'function', 'the fresh package root must be directly importable as a Host plugin');
const parentURL = pathToFileURL(join(root, 'package.json')).href;
const runtimeParentURL = pathToFileURL(join(root, 'runtime', 'package.json')).href;
const meta = readPluginMeta('dsh-context-kit', parentURL);
const runtimeMeta = readPluginMeta('dsh-context-kit-runtime', runtimeParentURL);
const runtimeRowMeta = readPluginMeta('./entry.js', runtimeParentURL);
const title = typeof meta?.title === 'string' ? meta.title : meta?.title?.en;
const runtimeTitle = typeof runtimeMeta?.title === 'string' ? runtimeMeta.title : runtimeMeta?.title?.en;
assert.equal(title, 'Context Kit', 'the normal combined row must expose a readable display title');
assert.equal(runtimeTitle, 'Context Kit', 'the hot-migration package must expose the same display title');
assert.equal(runtimeRowMeta, undefined, 'the relative hot-migration row must exercise the client display fallback');
assert.equal(runtimeLocale.meta?.title, 'Context Kit');
assert.doesNotMatch(
  patch,
  /^\s*name:\s*\.\/lib\//mu,
  'file-relative row names bypass package display metadata',
);

function assertOneClientSource(specifiers, packageName, declaration, owns = name => name === packageName || name.startsWith(packageName + '/')) {
  const sources = specifiers.filter(owns);
  assert.ok(declaration, 'the owning package must declare its Web client');
  assert.equal(sources.length, 1, `client package ${packageName} resolves from multiple active Loader sources: ${sources.join(', ')}`);
}

function assertHotMigrationAddress(specifiers) {
  assert.deepEqual(specifiers, ['./entry.js'], 'hot migration must use the fresh patch-anchored relative entry');
}

const brokenTopology = [
  'dsh-context-kit/dcp-plugin',
  'dsh-context-kit/context-mode-plugin',
  'dsh-context-kit/editor-plugin'
];
assert.throws(
  () => assertOneClientSource(brokenTopology, manifest.name, manifest.dsh?.client),
  /multiple active Loader sources/,
  'the former three-source topology must remain an executable failing fixture',
);
assert.doesNotThrow(() => assertOneClientSource(loaderNames, manifest.name, manifest.dsh?.client));
assert.doesNotThrow(() => assertOneClientSource(runtimeLoaderNames, runtimeManifest.name, runtimeManifest.dsh?.client, name => name === './entry.js'));
assert.throws(() => assertHotMigrationAddress(['dsh-context-kit-runtime']), /patch-anchored relative entry/,
  'the cached bare-package address must remain an executable failing fixture');
assert.doesNotThrow(() => assertHotMigrationAddress(runtimeLoaderNames));
assert.equal(runtimeClient.replace("id: 'dsh-context-kit-runtime'", "id: 'dsh-context-kit'"), client,
  'normal and hot-migration Web clients may differ only by package identity');
assert.match(runtimeClient, /\['context-kit-bundle', 'runtime\/entry', 'Context Kit'\]/,
  'the hot-migration client must replace its file address with a readable title');
const registrationId = client.match(/__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/)?.[1];
const runtimeRegistrationId = runtimeClient.match(/__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/)?.[1];
assert.equal(registrationId, manifest.name, 'the normal Web module registration id must equal its package name');
assert.equal(runtimeRegistrationId, runtimeManifest.name, 'the hot-migration Web module registration id must equal its package name');
assert.match(client, /const namespace = 'context-kit-bundle';/);
assert.equal((client.match(/configForms\.get\(/g) ?? []).length, 1, 'the client must bind one writable Config namespace');
assert.match(client, /path: \[spec\.section, key\]/, 'every card must write beneath its nested Host section');
assert.match(client, /const accepted = await scope\.mutate\(ops, draft\.revision\);/);
assert.match(client, /if \(!accepted\) throw new Error/);

console.log('bundle metadata and single-client-source checks passed');
