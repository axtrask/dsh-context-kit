import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temporary = await mkdtemp(join(root, '.runtime-projection-'));

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
  const fixed = probe(join(runtimeProjection, 'host-entry.js'));
  assert.equal(fixed.error, undefined, `runtime projection probe could not start: ${fixed.error?.message ?? ''}`);
  assert.equal(fixed.status, 0,
    'the self-contained runtime Host closure must import through a symlink-preserving package projection');

  const staleDirectory = join(temporary, 'stale-closure');
  const freshDirectory = join(temporary, 'fresh-closure');
  await mkdir(staleDirectory, { recursive: true });
  await mkdir(freshDirectory, { recursive: true });
  const staleContext = join(staleDirectory, 'context.js');
  const stalePlugin = join(staleDirectory, 'plugin.js');
  const freshPlugin = join(freshDirectory, 'plugin.js');
  await writeFile(staleContext, "export const generation = 'old';\n");
  await writeFile(stalePlugin, "export { install } from './context.js';\n");
  await writeFile(join(freshDirectory, 'context.js'), 'export function install() {}\n');
  await writeFile(freshPlugin, "export { install } from './context.js';\n");
  const staleCacheScript = `
    import assert from 'node:assert/strict';
    import { writeFile } from 'node:fs/promises';
    await import(${JSON.stringify(pathToFileURL(staleContext).href)});
    await writeFile(${JSON.stringify(staleContext)}, 'export function install() {}\\n');
    await assert.rejects(
      import(${JSON.stringify(pathToFileURL(stalePlugin).href)}),
      error => error instanceof SyntaxError && /does not provide an export named ['\"]install['\"]/.test(error.message),
    );
    const fresh = await import(${JSON.stringify(pathToFileURL(freshPlugin).href)});
    assert.equal(typeof fresh.install, 'function');
  `;
  const staleCache = spawnSync(process.execPath, ['--input-type=module', '--eval', staleCacheScript], { stdio: 'ignore' });
  assert.equal(staleCache.error, undefined, `stale-cache probe could not start: ${staleCache.error?.message ?? ''}`);
  assert.equal(staleCache.status, 0,
    'a fresh transitive Host closure must escape a rejected canonical ESM module graph');
} finally {
  await rm(temporary, { recursive: true, force: true });
}

console.log('runtime symlink-projection falsification checks passed');
