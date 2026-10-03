import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readPluginMeta } from '@deepseek-ai/dsh-app-boot';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const runtimeManifest = JSON.parse(await readFile(join(root, 'runtime', 'package.json'), 'utf8'));
const runtime2Manifest = JSON.parse(await readFile(join(root, 'runtime-2', 'package.json'), 'utf8'));
const runtime3Manifest = JSON.parse(await readFile(join(root, 'runtime-3', 'package.json'), 'utf8'));
const runtime4Manifest = JSON.parse(await readFile(join(root, 'runtime-4', 'package.json'), 'utf8'));
const runtime5Manifest = JSON.parse(await readFile(join(root, 'runtime-5', 'package.json'), 'utf8'));
const runtime6Manifest = JSON.parse(await readFile(join(root, 'runtime-6', 'package.json'), 'utf8'));
const locale = JSON.parse(await readFile(join(root, 'locale', 'en.json'), 'utf8'));
const runtimeLocale = JSON.parse(await readFile(join(root, 'runtime', 'locale', 'en.json'), 'utf8'));
const runtime2Locale = JSON.parse(await readFile(join(root, 'runtime-2', 'locale', 'en.json'), 'utf8'));
const runtime3Locale = JSON.parse(await readFile(join(root, 'runtime-3', 'locale', 'en.json'), 'utf8'));
const runtime4Locale = JSON.parse(await readFile(join(root, 'runtime-4', 'locale', 'en.json'), 'utf8'));
const runtime5Locale = JSON.parse(await readFile(join(root, 'runtime-5', 'locale', 'en.json'), 'utf8'));
const runtime6Locale = JSON.parse(await readFile(join(root, 'runtime-6', 'locale', 'en.json'), 'utf8'));
const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8');
const runtimePatch = await readFile(join(root, 'runtime', 'cordis.patch.yml'), 'utf8');
const runtime2Patch = await readFile(join(root, 'runtime-2', 'cordis.patch.yml'), 'utf8');
const runtime3Patch = await readFile(join(root, 'runtime-3', 'cordis.patch.yml'), 'utf8');
const runtime4Patch = await readFile(join(root, 'runtime-4', 'cordis.patch.yml'), 'utf8');
const runtime5Patch = await readFile(join(root, 'runtime-5', 'cordis.patch.yml'), 'utf8');
const runtime6Patch = await readFile(join(root, 'runtime-6', 'cordis.patch.yml'), 'utf8');
const client = await readFile(join(root, 'lib', 'edit-client.js'), 'utf8');
const runtimeClient = await readFile(join(root, 'runtime', 'client.js'), 'utf8');
const runtime2Client = await readFile(join(root, 'runtime-2', 'client.js'), 'utf8');
const runtime3Client = await readFile(join(root, 'runtime-3', 'client.js'), 'utf8');
const runtime4Client = await readFile(join(root, 'runtime-4', 'client.js'), 'utf8');
const runtime5Client = await readFile(join(root, 'runtime-5', 'client.js'), 'utf8');
const runtime6Client = await readFile(join(root, 'runtime-6', 'client.js'), 'utf8');
const runtimeHostEntry = await readFile(join(root, 'runtime', 'host-entry.js'), 'utf8');
const runtime2HostEntry = await readFile(join(root, 'runtime-2', 'host-entry.js'), 'utf8');
const runtime3HostEntry = await readFile(join(root, 'runtime-3', 'host-entry.js'), 'utf8');
const runtime4HostEntry = await readFile(join(root, 'runtime-4', 'host-entry.js'), 'utf8');
const runtime5HostEntry = await readFile(join(root, 'runtime-5', 'host-entry.js'), 'utf8');
const runtime6HostEntry = await readFile(join(root, 'runtime-6', 'host-entry.js'), 'utf8');

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
assert.ok(
  manifest.files?.includes('runtime-6'),
  'published bundle must include the latest fresh runtime generation',
);
assert.equal(locale.meta?.title, 'Context Kit');
assert.match(locale.meta?.description ?? '', /DCP/i);
assert.match(locale.meta?.description ?? '', /Context Mode/i);
assert.doesNotMatch(locale.meta?.title ?? '', /^file:/i);

const loaderNames = [...patch.matchAll(/^\s*name:\s*(\S+)\s*$/gmu)].map(match => match[1]);
const runtimeLoaderNames = [...runtimePatch.matchAll(/^\s*name:\s*(\S+)\s*$/gmu)].map(match => match[1]);
const runtime2LoaderNames = [...runtime2Patch.matchAll(/^\s*name:\s*(\S+)\s*$/gmu)].map(match => match[1]);
const runtime3LoaderNames = [...runtime3Patch.matchAll(/^\s*name:\s*(\S+)\s*$/gmu)].map(match => match[1]);
const runtime4LoaderNames = [...runtime4Patch.matchAll(/^\s*name:\s*(\S+)\s*$/gmu)].map(match => match[1]);
const runtime5LoaderNames = [...runtime5Patch.matchAll(/^\s*name:\s*(\S+)\s*$/gmu)].map(match => match[1]);
const runtime6LoaderNames = [...runtime6Patch.matchAll(/^\s*name:\s*(\S+)\s*$/gmu)].map(match => match[1]);
assert.deepEqual(loaderNames, ['dsh-context-kit'], 'the normal bundle must have one combined Loader source');
assert.deepEqual(runtimeLoaderNames, ['./host-entry.js'], 'the hot-migration bundle must use a fresh, self-contained Loader source');
assert.deepEqual(runtime2LoaderNames, ['./host-entry.js'], 'the second hot-migration bundle must use its own self-contained Loader source');
assert.deepEqual(runtime3LoaderNames, ['./host-entry.js'], 'the third hot-migration bundle must use its own self-contained Loader source');
assert.deepEqual(runtime4LoaderNames, ['./host-entry.js'], 'the fourth hot-migration bundle must use its own self-contained Loader source');
assert.deepEqual(runtime5LoaderNames, ['./host-entry.js'], 'the fifth hot-migration bundle must use its own self-contained Loader source');
assert.deepEqual(runtime6LoaderNames, ['./host-entry.js'], 'the sixth hot-migration bundle must use its own self-contained Loader source');
assert.equal(manifest.dsh?.client?.platform, 'web');
for (const [generation, generationManifest, hostEntry] of [
  ['runtime', runtimeManifest, runtimeHostEntry],
  ['runtime-2', runtime2Manifest, runtime2HostEntry],
  ['runtime-3', runtime3Manifest, runtime3HostEntry],
  ['runtime-4', runtime4Manifest, runtime4HostEntry],
  ['runtime-5', runtime5Manifest, runtime5HostEntry],
  ['runtime-6', runtime6Manifest, runtime6HostEntry],
]) {
  assert.equal(generationManifest.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.equal(generationManifest.dsh?.client?.platform, 'web');
  assert.equal(generationManifest.exports?.['.'], './index.js');
  assert.ok(generationManifest.files?.includes('host-entry.js'), `${generation} must publish its fresh Host entry`);
  assert.ok(generationManifest.files?.includes('host'), `${generation} must publish its self-contained Host closure`);
  assert.match(hostEntry, /from '\.\/host\/plugin\.js'/,
    `${generation} Loader entry must import only its mirrored Host closure`);
  assert.doesNotMatch(hostEntry, /\.\.\/lib\//,
    `${generation} Loader entry must not reconnect to stale canonical Host module URLs`);
}
assert.equal(runtimePatch.replace('name: ./host-entry.js', 'name: dsh-context-kit'), patch,
  'normal and hot-migration bundles may differ only by their Loader import address');
assert.equal(runtime2Patch, runtimePatch,
  'the second hot-migration patch must preserve the verified combined Loader configuration');
assert.equal(runtime3Patch.replace('          includeContextStatus: true\n', ''), runtime2Patch,
  'the third hot-migration patch may differ only by explicitly enabling its new optional status');
assert.equal(runtime4Patch, runtime3Patch,
  'the fourth hot-migration patch must preserve the verified deployed configuration');
assert.equal(runtime5Patch, runtime4Patch,
  'the fifth hot-migration patch must preserve the verified deployed configuration');
assert.equal(runtime6Patch, runtime5Patch,
  'the sixth hot-migration patch must preserve the verified deployed configuration');
assert.doesNotMatch(runtime2Patch, /includeContextStatus/,
  'older runtime configurations must keep the new optional status disabled by omission');
assert.match(runtime3Patch, /^\s*includeContextStatus:\s*true\s*$/mu,
  'the third deployed generation must explicitly enable model-facing context status');
assert.match(runtime4Patch, /^\s*includeContextStatus:\s*true\s*$/mu,
  'the fourth deployed generation must explicitly enable model-facing context status');
assert.match(runtime5Patch, /^\s*includeContextStatus:\s*true\s*$/mu,
  'the fifth deployed generation must explicitly enable model-facing context status');
assert.match(runtime6Patch, /^\s*includeContextStatus:\s*true\s*$/mu,
  'the latest deployed generation must explicitly enable model-facing context status');
assert.match(runtime6Patch, /^\s*allowSubAgents:\s*true\s*$/mu,
  'the latest deployed generation must enable subagent DCP access');
assert.equal(runtime2Manifest.name, 'dsh-context-kit-runtime-2');
assert.equal(runtime2Manifest.version, '0.1.6');
assert.equal(runtime3Manifest.name, 'dsh-context-kit-runtime-3');
assert.equal(runtime3Manifest.version, '0.1.7');
assert.equal(runtime4Manifest.name, 'dsh-context-kit-runtime-4');
assert.equal(runtime4Manifest.version, '0.1.8');
assert.equal(runtime5Manifest.name, 'dsh-context-kit-runtime-5');
assert.equal(runtime5Manifest.version, '0.1.9');
assert.equal(runtime6Manifest.name, 'dsh-context-kit-runtime-6');
assert.equal(runtime6Manifest.version, '0.1.10');
assert.notEqual(runtime2Manifest.name, runtimeManifest.name,
  'a no-restart replacement must use a new package identity instead of the cached package');
assert.notEqual(runtime3Manifest.name, runtime2Manifest.name,
  'each no-restart replacement must use another fresh package identity');
assert.notEqual(runtime4Manifest.name, runtime3Manifest.name,
  'the fourth no-restart replacement must use another fresh package identity');
assert.notEqual(runtime5Manifest.name, runtime4Manifest.name,
  'the fifth no-restart replacement must use another fresh package identity');
assert.notEqual(runtime6Manifest.name, runtime5Manifest.name,
  'the sixth no-restart replacement must use another fresh package identity');
const runtimePlugin = await import('../runtime/index.js');
const runtime2Plugin = await import('../runtime-2/index.js');
const runtime3Plugin = await import('../runtime-3/index.js');
const runtime4Plugin = await import('../runtime-4/index.js');
const runtime5Plugin = await import('../runtime-5/index.js');
const runtime6Plugin = await import('../runtime-6/index.js');
assert.equal(typeof runtimePlugin.apply, 'function', 'the fresh package root must be directly importable as a Host plugin');
assert.equal(typeof runtime2Plugin.apply, 'function', 'the second fresh package root must be directly importable as a Host plugin');
assert.equal(typeof runtime3Plugin.apply, 'function', 'the third fresh package root must be directly importable as a Host plugin');
assert.equal(typeof runtime4Plugin.apply, 'function', 'the fourth fresh package root must be directly importable as a Host plugin');
assert.equal(typeof runtime5Plugin.apply, 'function', 'the fifth fresh package root must be directly importable as a Host plugin');
assert.equal(typeof runtime6Plugin.apply, 'function', 'the sixth fresh package root must be directly importable as a Host plugin');
const parentURL = pathToFileURL(join(root, 'package.json')).href;
const runtimeParentURL = pathToFileURL(join(root, 'runtime', 'package.json')).href;
const runtime2ParentURL = pathToFileURL(join(root, 'runtime-2', 'package.json')).href;
const runtime3ParentURL = pathToFileURL(join(root, 'runtime-3', 'package.json')).href;
const runtime4ParentURL = pathToFileURL(join(root, 'runtime-4', 'package.json')).href;
const runtime5ParentURL = pathToFileURL(join(root, 'runtime-5', 'package.json')).href;
const runtime6ParentURL = pathToFileURL(join(root, 'runtime-6', 'package.json')).href;
const meta = readPluginMeta('dsh-context-kit', parentURL);
const runtimeMeta = readPluginMeta('dsh-context-kit-runtime', runtimeParentURL);
const runtime2Meta = readPluginMeta('dsh-context-kit-runtime-2', runtime2ParentURL);
const runtime3Meta = readPluginMeta('dsh-context-kit-runtime-3', runtime3ParentURL);
const runtime4Meta = readPluginMeta('dsh-context-kit-runtime-4', runtime4ParentURL);
const runtime5Meta = readPluginMeta('dsh-context-kit-runtime-5', runtime5ParentURL);
const runtime6Meta = readPluginMeta('dsh-context-kit-runtime-6', runtime6ParentURL);
const runtimeRowMeta = readPluginMeta('./host-entry.js', runtimeParentURL);
const runtime2RowMeta = readPluginMeta('./host-entry.js', runtime2ParentURL);
const runtime3RowMeta = readPluginMeta('./host-entry.js', runtime3ParentURL);
const runtime4RowMeta = readPluginMeta('./host-entry.js', runtime4ParentURL);
const runtime5RowMeta = readPluginMeta('./host-entry.js', runtime5ParentURL);
const runtime6RowMeta = readPluginMeta('./host-entry.js', runtime6ParentURL);
const title = typeof meta?.title === 'string' ? meta.title : meta?.title?.en;
const runtimeTitle = typeof runtimeMeta?.title === 'string' ? runtimeMeta.title : runtimeMeta?.title?.en;
const runtime2Title = typeof runtime2Meta?.title === 'string' ? runtime2Meta.title : runtime2Meta?.title?.en;
const runtime3Title = typeof runtime3Meta?.title === 'string' ? runtime3Meta.title : runtime3Meta?.title?.en;
const runtime4Title = typeof runtime4Meta?.title === 'string' ? runtime4Meta.title : runtime4Meta?.title?.en;
const runtime5Title = typeof runtime5Meta?.title === 'string' ? runtime5Meta.title : runtime5Meta?.title?.en;
const runtime6Title = typeof runtime6Meta?.title === 'string' ? runtime6Meta.title : runtime6Meta?.title?.en;
assert.equal(title, 'Context Kit', 'the normal combined row must expose a readable display title');
assert.equal(runtimeTitle, 'Context Kit', 'the hot-migration package must expose the same display title');
assert.equal(runtime2Title, 'Context Kit', 'the second hot-migration package must expose the same display title');
assert.equal(runtime3Title, 'Context Kit', 'the third hot-migration package must expose the same display title');
assert.equal(runtime4Title, 'Context Kit', 'the fourth hot-migration package must expose the same display title');
assert.equal(runtime5Title, 'Context Kit', 'the fifth hot-migration package must expose the same display title');
assert.equal(runtime6Title, 'Context Kit', 'the sixth hot-migration package must expose the same display title');
assert.equal(runtimeRowMeta, undefined, 'the relative hot-migration row must exercise the client display fallback');
assert.equal(runtime2RowMeta, undefined, 'the second relative hot-migration row must exercise the client display fallback');
assert.equal(runtime3RowMeta, undefined, 'the third relative hot-migration row must exercise the client display fallback');
assert.equal(runtime4RowMeta, undefined, 'the fourth relative hot-migration row must exercise the client display fallback');
assert.equal(runtime5RowMeta, undefined, 'the fifth relative hot-migration row must exercise the client display fallback');
assert.equal(runtime6RowMeta, undefined, 'the sixth relative hot-migration row must exercise the client display fallback');
assert.equal(runtimeLocale.meta?.title, 'Context Kit');
assert.equal(runtime2Locale.meta?.title, 'Context Kit');
assert.equal(runtime3Locale.meta?.title, 'Context Kit');
assert.equal(runtime4Locale.meta?.title, 'Context Kit');
assert.equal(runtime5Locale.meta?.title, 'Context Kit');
assert.equal(runtime6Locale.meta?.title, 'Context Kit');
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
  assert.deepEqual(specifiers, ['./host-entry.js'], 'hot migration must use the fresh self-contained relative entry');
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
assert.doesNotThrow(() => assertOneClientSource(runtimeLoaderNames, runtimeManifest.name, runtimeManifest.dsh?.client, name => name === './host-entry.js'));
assert.doesNotThrow(() => assertOneClientSource(runtime2LoaderNames, runtime2Manifest.name, runtime2Manifest.dsh?.client, name => name === './host-entry.js'));
assert.doesNotThrow(() => assertOneClientSource(runtime3LoaderNames, runtime3Manifest.name, runtime3Manifest.dsh?.client, name => name === './host-entry.js'));
assert.doesNotThrow(() => assertOneClientSource(runtime4LoaderNames, runtime4Manifest.name, runtime4Manifest.dsh?.client, name => name === './host-entry.js'));
assert.doesNotThrow(() => assertOneClientSource(runtime5LoaderNames, runtime5Manifest.name, runtime5Manifest.dsh?.client, name => name === './host-entry.js'));
assert.doesNotThrow(() => assertOneClientSource(runtime6LoaderNames, runtime6Manifest.name, runtime6Manifest.dsh?.client, name => name === './host-entry.js'));
assert.throws(() => assertHotMigrationAddress(['dsh-context-kit-runtime']), /self-contained relative entry/,
  'the cached bare-package address must remain an executable failing fixture');
assert.doesNotThrow(() => assertHotMigrationAddress(runtimeLoaderNames));
assert.doesNotThrow(() => assertHotMigrationAddress(runtime2LoaderNames));
assert.doesNotThrow(() => assertHotMigrationAddress(runtime3LoaderNames));
assert.doesNotThrow(() => assertHotMigrationAddress(runtime4LoaderNames));
assert.doesNotThrow(() => assertHotMigrationAddress(runtime5LoaderNames));
assert.doesNotThrow(() => assertHotMigrationAddress(runtime6LoaderNames));
assert.equal(runtimeClient.replace("id: 'dsh-context-kit-runtime'", "id: 'dsh-context-kit'"), client,
  'normal and hot-migration Web clients may differ only by package identity');
assert.equal(runtime2Client
  .replaceAll('dsh-context-kit-runtime-2', 'dsh-context-kit-runtime')
  .replaceAll('runtime-2/host-entry', 'runtime/host-entry'), runtimeClient,
  'the second hot-migration Web client may differ only by its fresh package and Host identities');
assert.equal(runtime3Client
  .replaceAll('dsh-context-kit-runtime-3', 'dsh-context-kit-runtime-2')
  .replaceAll('runtime-3/host-entry', 'runtime-2/host-entry'), runtime2Client,
  'the third hot-migration Web client may differ only by its fresh package and Host identities');
assert.equal(runtime4Client
  .replaceAll('dsh-context-kit-runtime-4', 'dsh-context-kit-runtime-3')
  .replaceAll('runtime-4/host-entry', 'runtime-3/host-entry'), runtime3Client,
  'the fourth hot-migration Web client may differ only by its fresh package and Host identities');
assert.equal(runtime5Client
  .replaceAll('dsh-context-kit-runtime-5', 'dsh-context-kit-runtime-4')
  .replaceAll('runtime-5/host-entry', 'runtime-4/host-entry'), runtime4Client,
  'the fifth hot-migration Web client may differ only by its fresh package and Host identities');
assert.equal(runtime6Client
  .replaceAll('dsh-context-kit-runtime-6', 'dsh-context-kit-runtime-5')
  .replaceAll('runtime-6/host-entry', 'runtime-5/host-entry'), runtime5Client,
  'the sixth hot-migration Web client may differ only by its fresh package and Host identities');
assert.match(runtimeClient, /\['context-kit-bundle', 'runtime\/host-entry', 'Context Kit'\]/,
  'the hot-migration client must replace its file address with a readable title');
assert.match(runtime2Client, /\['context-kit-bundle', 'runtime-2\/host-entry', 'Context Kit'\]/,
  'the second hot-migration client must replace its file address with a readable title');
assert.match(runtime3Client, /\['context-kit-bundle', 'runtime-3\/host-entry', 'Context Kit'\]/,
  'the third hot-migration client must replace its file address with a readable title');
assert.match(runtime4Client, /\['context-kit-bundle', 'runtime-4\/host-entry', 'Context Kit'\]/,
  'the fourth hot-migration client must replace its file address with a readable title');
assert.match(runtime5Client, /\['context-kit-bundle', 'runtime-5\/host-entry', 'Context Kit'\]/,
  'the fifth hot-migration client must replace its file address with a readable title');
assert.match(runtime6Client, /\['context-kit-bundle', 'runtime-6\/host-entry', 'Context Kit'\]/,
  'the sixth hot-migration client must replace its file address with a readable title');
const registrationId = client.match(/__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/)?.[1];
const runtimeRegistrationId = runtimeClient.match(/__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/)?.[1];
const runtime2RegistrationId = runtime2Client.match(/__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/)?.[1];
const runtime3RegistrationId = runtime3Client.match(/__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/)?.[1];
const runtime4RegistrationId = runtime4Client.match(/__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/)?.[1];
const runtime5RegistrationId = runtime5Client.match(/__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/)?.[1];
const runtime6RegistrationId = runtime6Client.match(/__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/)?.[1];
assert.equal(registrationId, manifest.name, 'the normal Web module registration id must equal its package name');
assert.equal(runtimeRegistrationId, runtimeManifest.name, 'the hot-migration Web module registration id must equal its package name');
assert.equal(runtime2RegistrationId, runtime2Manifest.name, 'the second hot-migration Web module registration id must equal its package name');
assert.equal(runtime3RegistrationId, runtime3Manifest.name, 'the third hot-migration Web module registration id must equal its package name');
assert.equal(runtime4RegistrationId, runtime4Manifest.name, 'the fourth hot-migration Web module registration id must equal its package name');
assert.equal(runtime5RegistrationId, runtime5Manifest.name, 'the fifth hot-migration Web module registration id must equal its package name');
assert.equal(runtime6RegistrationId, runtime6Manifest.name, 'the sixth hot-migration Web module registration id must equal its package name');
assert.match(client, /const namespace = 'context-kit-bundle';/);
assert.match(client, /field\('experimental\.allowSubAgents', 'Allow DCP in subagents'/,
  'the settings card must expose subagent DCP access as a checkbox');
assert.equal((client.match(/configForms\.get\(/g) ?? []).length, 1, 'the client must bind one writable Config namespace');
assert.match(client, /path: \[spec\.section, key\]/, 'every card must write beneath its nested Host section');
assert.match(client, /const accepted = await scope\.mutate\(ops, draft\.revision\);/);
assert.match(client, /if \(!accepted\) throw new Error/);

console.log('bundle metadata and single-client-source checks passed');
