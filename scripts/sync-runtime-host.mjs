import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDirectory = join(root, 'lib');
const targetDirectory = join(root, 'runtime', 'host');
const excluded = new Set(['edit-client.js', 'index.js']);
const checkOnly = process.argv.includes('--check');

const sourceEntries = (await readdir(sourceDirectory, { withFileTypes: true }))
  .filter(entry => entry.isFile() && !excluded.has(entry.name))
  .map(entry => entry.name)
  .sort();

if (checkOnly) {
  const targetEntries = (await readdir(targetDirectory, { withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .sort();
  assert.deepEqual(targetEntries, sourceEntries,
    'runtime/host must contain exactly the canonical Host implementation files');
  for (const name of sourceEntries) {
    const [source, target] = await Promise.all([
      readFile(join(sourceDirectory, name)),
      readFile(join(targetDirectory, name)),
    ]);
    assert.deepEqual(target, source, `runtime/host/${name} must match lib/${name}`);
  }
  console.log(`runtime Host mirror check passed (${sourceEntries.length} files)`);
} else {
  await mkdir(targetDirectory, { recursive: true });
  const existing = new Set((await readdir(targetDirectory, { withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => entry.name));
  const stale = [...existing].filter(name => !sourceEntries.includes(name));
  assert.deepEqual(stale, [], 'remove stale runtime/host files before synchronizing');
  await Promise.all(sourceEntries.map(name => copyFile(
    join(sourceDirectory, name),
    join(targetDirectory, name),
  )));
  console.log(`synchronized runtime Host mirror (${sourceEntries.length} files)`);
}
