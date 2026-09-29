/**
 * Ensure the kit can resolve `@deepseek-ai/*`, repairing the link if needed.
 *
 * The kit lives outside the installed harness, so its bare imports need a
 * `node_modules` branch somewhere above it. ONE junction at the plugins root
 * provides that for every plugin kept there:
 *
 *   ~/.dsh/plugins/node_modules  ->  <harness>/node_modules
 *
 * Node's upward lookup finds it from `plugins/dsh-context-kit/lib/*.js`, so the
 * kit itself needs no `node_modules` of its own — an earlier attempt to check
 * for one produced a wrong "the kit cannot compose" diagnosis.
 *
 * The harness path is DISCOVERED, never hardcoded: `_npx/<hash>/node_modules`
 * changes whenever npx refreshes the package, which is exactly why a
 * hand-written `New-Item` command rots. Candidates are tried in the order that
 * keeps a working setup working: the existing link's target, this script's own
 * resolution, then npx cache footprints newest-first.
 *
 * Usage:
 *   node scripts/link-modules.mjs          # check, and repair when needed
 *   node scripts/link-modules.mjs --check  # report only, never write
 *
 * @module dsh-context-kit/scripts/link-modules
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const kitRoot = resolve(here, '..');
const pluginsRoot = resolve(kitRoot, '..');
const linkPath = join(pluginsRoot, 'node_modules');
const checkOnly = process.argv.includes('--check');

/** Package the kit imports; the probe for whether a tree is usable. */
const PROBE_PACKAGE = '@deepseek-ai/dsh-tools';

const log = (message) => console.log(message);

/** `lstat` that answers undefined instead of throwing. */
function lstatSafe(path) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/** Whether a directory looks like a harness `node_modules`. */
function isHarnessTree(root) {
  return typeof root === 'string' && existsSync(join(root, PROBE_PACKAGE, 'package.json'));
}

/**
 * Discover a harness `node_modules` directory.
 * @returns an absolute path, or `undefined` when nothing was found.
 */
function discoverHarnessTree() {
  const candidates = [];

  // 1. Where the existing link points, so a repair keeps pointing where it did.
  if (lstatSafe(linkPath) !== undefined) {
    try {
      candidates.push(realpathSync(linkPath));
    } catch {
      /* unreadable link */
    }
  }

  // 2. The tree this script itself resolves through — works while a link exists.
  try {
    const resolved = fileURLToPath(import.meta.resolve(`${PROBE_PACKAGE}/package.json`));
    candidates.push(resolve(dirname(resolved), '..', '..'));
  } catch {
    /* unresolvable without a link, which is the case being repaired */
  }

  // 3. npx cache footprints, newest first — this is what rescues an upgrade.
  const localAppData = process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Local');
  const npxCache = join(localAppData, 'npm-cache', '_npx');
  try {
    const found = readdirSync(npxCache, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(npxCache, entry.name, 'node_modules'))
      .filter(isHarnessTree);
    found.sort((a, b) => Number(lstatSafe(b)?.mtimeMs ?? 0) - Number(lstatSafe(a)?.mtimeMs ?? 0));
    candidates.push(...found);
  } catch {
    /* no npx cache on this machine */
  }

  for (const candidate of candidates) if (isHarnessTree(candidate)) return candidate;
  return undefined;
}

/** Report what the link currently is. */
function describeLink() {
  const stats = lstatSafe(linkPath);
  if (stats === undefined) return 'absent';
  if (stats.isSymbolicLink()) {
    try {
      return `link -> ${realpathSync(linkPath)}`;
    } catch {
      return 'link -> (unreadable target)';
    }
  }
  if (stats.isDirectory()) return 'plain directory';
  return 'present but not a directory';
}

log(`kit:          ${kitRoot}`);
log(`link:         ${linkPath}`);
log(`current:      ${describeLink()}`);
log(`resolvable:   ${isHarnessTree(linkPath) ? 'yes' : 'no'}`);

const target = discoverHarnessTree();
if (target === undefined) {
  log('\nNo harness tree found. Run DSH once so its packages exist, then retry.');
  process.exit(1);
}
log(`harness tree: ${target}`);

if (isHarnessTree(linkPath)) {
  let alreadyRight = false;
  try {
    alreadyRight = realpathSync(linkPath) === realpathSync(target);
  } catch {
    alreadyRight = false;
  }
  if (alreadyRight) {
    log('\nNothing to do: the kit already resolves its harness imports.');
    process.exit(0);
  }
}

if (checkOnly) {
  log(`\n--check: would link ${linkPath} -> ${target}`);
  process.exit(1);
}

// Replace whatever is there. A junction is removed WITHOUT recursing: deleting
// through a link would delete the harness it points at.
try {
  const stats = lstatSafe(linkPath);
  if (stats !== undefined) {
    if (stats.isDirectory() && !stats.isSymbolicLink() && readdirSync(linkPath).length > 0) {
      log(`\nRefusing to replace a non-empty real directory at ${linkPath}.`);
      process.exit(1);
    }
    rmSync(linkPath, { recursive: false, force: true });
  }
} catch (error) {
  log(`\nCould not remove the old link: ${error.message}`);
  process.exit(1);
}

mkdirSync(pluginsRoot, { recursive: true });
try {
  // 'junction' needs no elevation on Windows and is what a directory link wants.
  symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
} catch (error) {
  log(`\nCould not create the link: ${error.message}`);
  log(`Create it by hand instead:\n  mklink /J "${linkPath}" "${target}"`);
  process.exit(1);
}

log(`\nLinked ${linkPath} -> ${target}`);
log('Verify with: node scripts/verify-activation.mjs');
process.exit(isHarnessTree(linkPath) ? 0 : 1);
