import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const locale = JSON.parse(await readFile(join(root, 'locale', 'en.json'), 'utf8'));
const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8');

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
  'published bundle must include locale metadata',
);
assert.equal(locale.meta?.title, 'Context Kit');
assert.match(locale.meta?.description ?? '', /DCP/i);
assert.match(locale.meta?.description ?? '', /Context Mode/i);
assert.doesNotMatch(locale.meta?.title ?? '', /^file:/i);

for (const specifier of [
  'dsh-context-kit/dcp-plugin',
  'dsh-context-kit/context-mode-plugin',
  'dsh-context-kit/editor-plugin',
]) {
  assert.ok(
    patch.includes(`name: ${specifier}`),
    `bundle row must use package specifier ${specifier} so display metadata resolves`,
  );
}
assert.doesNotMatch(
  patch,
  /^\s*name:\s*\.\/lib\//mu,
  'file-relative row names bypass package display metadata',
);

console.log('bundle display metadata checks passed');
