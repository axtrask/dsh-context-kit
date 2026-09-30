import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), 'context-kit-projection-'));

function probe(modulePath) {
  return spawnSync(process.execPath, [
    '--preserve-symlinks',
    '--input-type=module',
    '--eval',
    `await import(${JSON.stringify(pathToFileURL(modulePath).href)})`,
  ], { stdio: 'ignore' });
}

try {
  const fixture = join(temporary, 'fixture');
  const projectedModules = join(temporary, 'projection', 'node_modules');
  await mkdir(join(fixture, 'lib'), { recursive: true });
  await mkdir(join(fixture, 'runtime'), { recursive: true });
  await mkdir(projectedModules, { recursive: true });
  await writeFile(join(fixture, 'package.json'), '{"type":"module"}\n');
  await writeFile(join(fixture, 'lib', 'plugin.js'), 'export function apply() {}\n');
  await writeFile(join(fixture, 'runtime', 'legacy.js'), "export { apply } from '../lib/plugin.js';\n");
  const legacyProjection = join(projectedModules, 'legacy-context-kit');
  await symlink(join(fixture, 'runtime'), legacyProjection, 'junction');

  const broken = probe(join(legacyProjection, 'legacy.js'));
  assert.equal(broken.status, 1,
    'the former parent-relative entry must fail through a symlink-preserving package projection');

  const runtimeProjection = join(projectedModules, 'dsh-context-kit-runtime');
  await symlink(join(root, 'runtime'), runtimeProjection, 'junction');
  const fixed = probe(join(runtimeProjection, 'entry.js'));
  assert.equal(fixed.error, undefined, `runtime projection probe could not start: ${fixed.error?.message ?? ''}`);
  assert.equal(fixed.status, 0,
    'the realpath-aware runtime entry must import through a symlink-preserving package projection');
} finally {
  await rm(temporary, { recursive: true, force: true });
}

console.log('runtime symlink-projection falsification checks passed');
