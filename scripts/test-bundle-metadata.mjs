import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readPluginMeta } from '@deepseek-ai/dsh-app-boot';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const locale = JSON.parse(await readFile(join(root, 'locale', 'en.json'), 'utf8'));
const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8');
const client = await readFile(join(root, 'lib', 'edit-client.js'), 'utf8');

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
assert.deepEqual(
  loaderNames,
  ['dsh-context-kit/plugin'],
  'one package declaring dsh.client must have exactly one active Loader source',
);
assert.equal(manifest.exports?.['./plugin'], './lib/plugin.js');
const parentURL = pathToFileURL(join(root, 'package.json')).href;
const meta = readPluginMeta('dsh-context-kit/plugin', parentURL);
const title = typeof meta?.title === 'string' ? meta.title : meta?.title?.en;
assert.equal(title, 'Context Kit', 'the combined row must expose a readable display title');
assert.doesNotMatch(
  patch,
  /^\s*name:\s*\.\/lib\//mu,
  'file-relative row names bypass package display metadata',
);

function assertOneClientSource(specifiers) {
  const sources = specifiers.filter(name => name === manifest.name || name.startsWith(manifest.name + '/'));
  assert.ok(manifest.dsh?.client, 'the owning package must declare its Web client');
  assert.equal(sources.length, 1, `client package ${manifest.name} resolves from multiple active Loader sources: ${sources.join(', ')}`);
}

const brokenTopology = [
  'dsh-context-kit/dcp-plugin',
  'dsh-context-kit/context-mode-plugin',
  'dsh-context-kit/editor-plugin'
];
assert.throws(
  () => assertOneClientSource(brokenTopology),
  /multiple active Loader sources/,
  'the former three-source topology must remain an executable failing fixture',
);
assert.doesNotThrow(() => assertOneClientSource(loaderNames));
assert.match(client, /const namespace = 'context-kit-bundle';/);
assert.equal((client.match(/configForms\.get\(/g) ?? []).length, 1, 'the client must bind one writable Config namespace');
assert.match(client, /path: \[spec\.section, key\]/, 'every card must write beneath its nested Host section');
assert.match(client, /current\.value\?\.\[spec\.section\]\?\.\[op\.path\[1\]\]/, 'save verification must read the same nested path');

console.log('bundle metadata and single-client-source checks passed');
