import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDirectory = join(root, 'lib');
const targets = [
  { label: 'runtime/host', directory: join(root, 'runtime', 'host') },
  { label: 'runtime-2/host', directory: join(root, 'runtime-2', 'host') },
];
const excluded = new Set(['edit-client.js', 'index.js']);
const checkOnly = process.argv.includes('--check');

const sourceEntries = (await readdir(sourceDirectory, { withFileTypes: true }))
  .filter(entry => entry.isFile() && !excluded.has(entry.name))
  .map(entry => entry.name)
  .sort();

if (checkOnly) {
  for (const target of targets) {
    const targetEntries = (await readdir(target.directory, { withFileTypes: true }))
      .filter(entry => entry.isFile())
      .map(entry => entry.name)
      .sort();
    assert.deepEqual(targetEntries, sourceEntries,
      `${target.label} must contain exactly the canonical Host implementation files`);
    for (const name of sourceEntries) {
      const [source, mirrored] = await Promise.all([
        readFile(join(sourceDirectory, name)),
        readFile(join(target.directory, name)),
      ]);
      assert.deepEqual(mirrored, source, `${target.label}/${name} must match lib/${name}`);
    }
  }
  console.log(`runtime Host mirror check passed (${targets.length} generations, ${sourceEntries.length} files each)`);
} else {
  for (const target of targets) {
    await mkdir(target.directory, { recursive: true });
    const existing = new Set((await readdir(target.directory, { withFileTypes: true }))
      .filter(entry => entry.isFile())
      .map(entry => entry.name));
    const stale = [...existing].filter(name => !sourceEntries.includes(name));
    assert.deepEqual(stale, [], `remove stale ${target.label} files before synchronizing`);
    await Promise.all(sourceEntries.map(name => copyFile(
      join(sourceDirectory, name),
      join(target.directory, name),
    )));
  }
  console.log(`synchronized runtime Host mirrors (${targets.length} generations, ${sourceEntries.length} files each)`);
}
