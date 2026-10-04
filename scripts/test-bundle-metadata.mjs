import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readPluginMeta } from '@deepseek-ai/dsh-app-boot';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const cdshManifest = JSON.parse(await readFile(join(root, 'packages', 'cdsh', 'package.json'), 'utf8'));
const locale = JSON.parse(await readFile(join(root, 'locale', 'en.json'), 'utf8'));
const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8');
const client = await readFile(join(root, 'lib', 'edit-client.js'), 'utf8');

const expectedPeers = {
  '@deepseek-ai/dsh-client-connection': '0.2.0-rc.2',
  '@deepseek-ai/dsh-compaction-basic': '0.2.0-rc.2',
  '@deepseek-ai/dsh-llm': '0.2.0-rc.2',
  '@deepseek-ai/dsh-session': '0.2.0-rc.2',
  '@deepseek-ai/dsh-tools': '0.2.0-rc.2',
  '@deepseek-ai/dsh-util-values': '0.2.0-rc.2',
  '@deepseek-ai/schemastery': '3.18.4',
};

assert.equal(manifest.name, 'dsh-context-kit');
assert.equal(manifest.version, '0.1.11');
assert.equal(manifest.private, true, 'the Git/local bundle must remain private');
assert.equal(manifest.license, 'UNLICENSED', 'the private bundle must not invent an open-source grant');
assert.equal(manifest.engines?.node, '>=22.19.0');
assert.equal(manifest.type, 'module');
assert.equal(manifest.exports?.['.'], './lib/index.js');
assert.equal(manifest.exports?.['./editor-plugin'], './lib/editor-plugin.js');
assert.equal(manifest.exports?.['./plugin'], './lib/plugin.js');
assert.equal(manifest.exports?.['./client'], './lib/edit-client.js');
assert.equal(manifest.exports?.['./package.json'], './package.json');
assert.equal(manifest.exports?.['./locale/*.json'], './locale/*.json');
assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml');
assert.equal(manifest.dsh?.client?.platform, 'web');
assert.deepEqual(manifest.dsh?.client?.inject, [
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-settings-plugins',
]);
assert.deepEqual(manifest.files, [
  'lib',
  'locale/*.json',
  'locale/**/*.json',
  'cordis.patch.yml',
  'packages/cdsh',
]);
assert.deepEqual(manifest.peerDependencies, expectedPeers);
assert.deepEqual(
  Object.fromEntries(Object.entries(manifest.peerDependenciesMeta ?? {}).map(([name, meta]) => [name, meta?.optional])),
  Object.fromEntries(Object.keys(expectedPeers).map(name => [name, true])),
  'every Harness peer must be exact and optional because the installation supplies it',
);
assert.deepEqual(manifest.dependencies, { undici: '8.11.2' });
assert.equal(typeof cdshManifest.name, 'string', 'the nested CDSH package must have a package identity');
assert.ok(cdshManifest.name.length > 0, 'the nested CDSH package name must not be empty');

assert.equal(locale.meta?.title, 'Context Kit');
assert.match(locale.meta?.description ?? '', /DCP/i);
assert.match(locale.meta?.description ?? '', /Context Mode/i);
assert.doesNotMatch(locale.meta?.title ?? '', /^file:/i);
const parentURL = pathToFileURL(join(root, 'package.json')).href;
const meta = readPluginMeta('dsh-context-kit', parentURL);
const title = typeof meta?.title === 'string' ? meta.title : meta?.title?.en;
assert.equal(title, 'Context Kit', 'the aggregate Loader package must expose its Web display metadata');

function parseRows(source) {
  return [...source.matchAll(/^ {4}- id:\s*([^\r\n]+)\r?\n {6}name:\s*([^\r\n]+)\r?\n {6}disabled:\s*(true|false)\s*$/gmu)]
    .map(([, id, name, disabled]) => ({ id: id.trim(), name: name.trim(), disabled: disabled === 'true' }));
}

function assertCanonicalTopology(rows) {
  assert.deepEqual(rows.map(row => row.id), ['context-kit-bundle', 'cdsh'],
    'the bundle must expose exactly the aggregate Context Kit row and nested CDSH row');
  assert.deepEqual(rows.map(row => row.name), ['dsh-context-kit', './packages/cdsh/lib/index.js']);
  assert.deepEqual(rows.map(row => row.disabled), [false, false], 'both canonical Loader rows must be enabled');
}

const rows = parseRows(patch);
assertCanonicalTopology(rows);
assert.throws(() => assertCanonicalTopology([
  { id: 'context-kit-dcp', name: 'dsh-context-kit/dcp-plugin', disabled: false },
  { id: 'context-kit-context-mode', name: 'dsh-context-kit/context-mode-plugin', disabled: false },
  { id: 'context-kit-history-editor', name: 'dsh-context-kit/editor-plugin', disabled: false },
]), /aggregate Context Kit row/, 'the obsolete independent-row topology must remain an executable failing fixture');
assert.throws(() => assertCanonicalTopology([
  { id: 'context-kit-bundle', name: 'dsh-context-kit', disabled: false },
]), /aggregate Context Kit row/, 'omitting the nested CDSH row must fail the publication contract');
assert.throws(() => assertCanonicalTopology([
  { id: 'context-kit-bundle', name: 'dsh-context-kit', disabled: false },
  { id: 'cdsh', name: './packages/cdsh/lib/index.js', disabled: true },
]), /enabled/, 'a disabled CDSH row must fail the publication contract');

const aggregateStart = patch.indexOf('    - id: context-kit-bundle');
const nestedStart = patch.indexOf('\n    - id: cdsh', aggregateStart + 1);
assert.ok(aggregateStart >= 0 && nestedStart > aggregateStart, 'the aggregate row must precede the nested CDSH row');
const aggregateBlock = patch.slice(aggregateStart, nestedStart);
assert.match(aggregateBlock, /^ {8}dcp:\s*$/mu);
assert.match(aggregateBlock, /^ {10}includeContextStatus:\s*true\s*$/mu);
assert.match(aggregateBlock, /^ {8}contextMode:\s*$/mu);
assert.match(aggregateBlock, /^ {8}historyEditor:\s*$/mu);
assert.doesNotMatch(patch, /^\s*id:\s*context-kit-(?:dcp|context-mode|history-editor)\s*$/mu);

assert.match(client, /id:\s*'dsh-context-kit'/, 'the Web module registration id must keep the package identity');
assert.match(client, /const namespace = 'context-kit-bundle';/);
assert.match(client, /path: \[spec\.section, key\]/, 'the single settings card must write beneath nested Host sections');
assert.equal((client.match(/configForms\.get\(/g) ?? []).length, 1, 'the client must bind exactly one writable Config namespace');

function npmPackDryRun() {
  const windows = process.platform === 'win32';
  const command = windows ? (process.env.ComSpec || 'cmd.exe') : 'npm';
  const args = windows
    ? ['/d', '/s', '/c', 'npm pack --dry-run --json --ignore-scripts']
    : ['pack', '--dry-run', '--json', '--ignore-scripts'];
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, npm_config_loglevel: 'silent' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `npm pack --dry-run failed:\n${result.stderr || result.stdout}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.length, 1, 'npm pack must report exactly one root artifact');
  return report[0].files.map(file => file.path.replace(/^package\//u, '').replaceAll('\\', '/'));
}

const inventory = npmPackDryRun();
const inventorySet = new Set(inventory);
for (const required of [
  'package.json',
  'README.md',
  'cordis.patch.yml',
  'lib/index.js',
  'lib/plugin.js',
  'lib/editor-plugin.js',
  'lib/edit.js',
  'lib/edit-client.js',
  'locale/en.json',
  'packages/cdsh/package.json',
]) {
  assert.ok(inventorySet.has(required), `packed artifact is missing ${required}`);
}
for (const path of inventory) {
  assert.ok(!/^(?:[A-Za-z]:|\/|\\|\.\.\/)/u.test(path), `packed inventory contains a machine-specific or unsafe path: ${path}`);
  assert.doesNotMatch(path, /^runtime(?:-[2-6])?\//u, `runtime snapshot leaked into npm pack: ${path}`);
  assert.ok(
    path === 'package.json'
      || path === 'cordis.patch.yml'
      || /^(?:README|LICENSE|LICENCE|COPYING)(?:\..*)?$/iu.test(path)
      || path.startsWith('lib/')
      || path.startsWith('locale/')
      || path.startsWith('packages/cdsh/'),
    `unexpected publication root in npm pack: ${path}`,
  );
}

for (const subpath of ['./editor-plugin', './plugin']) {
  const target = manifest.exports?.[subpath];
  assert.equal(typeof target, 'string', `${subpath} must be exported`);
  assert.ok(inventorySet.has(target.replace(/^\.\//u, '')), `packed artifact is missing the ${subpath} export target`);
  const imported = await import(`${manifest.name}/${subpath.slice(2)}`);
  assert.equal(typeof imported.apply, 'function', `${subpath} must resolve and import through package exports`);
}

for (const path of inventory.filter(file => /\.(?:c?js|mjs|json|ya?ml|md|css|html|txt)$/iu.test(file))) {
  const source = await readFile(join(root, path), 'utf8');
  assert.doesNotMatch(source, /file:\/\/\/[A-Za-z]:\//iu, `packed file embeds a local file URL: ${path}`);
  assert.doesNotMatch(
    source,
    /(?:pro100noob|[\\/]palette-rewrite[\\/]|_npx[\\/][0-9a-f]{8,})/iu,
    `packed file embeds a developer-machine path: ${path}`,
  );
}

console.log(`canonical bundle metadata and npm pack inventory checks passed (${inventory.length} files)`);
