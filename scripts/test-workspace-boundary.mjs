/**
 * File access follows the host by default and can be restricted to the workspace.
 *
 * DSH's native read capability can reach host-readable absolute paths. Context
 * Mode mirrors that by default, while `restrictPathsToWorkspace:true` supplies
 * a hard boundary for operators that need it. The test also pins realpath
 * behavior so the optional restriction cannot be bypassed with aliases.
 *
 * Run:  node scripts/test-workspace-boundary.mjs
 *
 * @module dsh-context-kit/scripts/test-workspace-boundary
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const kitRoot = join(here, '..');

const failures = [];
/** @param name - check label. @param ok - result. @param detail - evidence. */
function check(name, ok, detail = '') {
  console.log(`${ok ? '[ok]  ' : '[FAIL]'} ${name}${detail.length > 0 ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const { pathsOutsideWorkspace } = await import(pathToFileURL(join(kitRoot, 'lib', 'common.js')).href);
const contextMode = await import(pathToFileURL(join(kitRoot, 'lib', 'context-mode.js')).href);
const cordis = await import('@deepseek-ai/cordis');

/* ------------------------------------------------------------------ pure checks */

/**
 * Remove a test directory, tolerating the one Windows case that bites here.
 *
 * `rmSync(..., { recursive: true })` fails on a directory junction with EPERM,
 * because the recursive walk cannot decide whether to unlink the link or the
 * tree behind it. The link is therefore removed first, one level down, and the
 * rest of the tree is then an ordinary recursive delete.
 *
 * @param base - directory to remove.
 */
function cleanup(base) {
  let entries = [];
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    try {
      unlinkSync(join(base, entry.name));
    } catch {
      /* best effort: the tree is a test artifact */
    }
  }
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* best effort: the scratch sweep will collect anything left behind */
  }
}

console.log('--- the predicate ---');
const root = mkdtempSync(join(tmpdir(), 'ws-boundary-'));
const nested = join(root, 'src', 'deep');
mkdirSync(nested, { recursive: true });
const inside = join(nested, 'file.txt');
writeFileSync(inside, 'inside\n', 'utf8');
const outsideDir = mkdtempSync(join(tmpdir(), 'ws-outside-'));
const outside = join(outsideDir, 'other.txt');
writeFileSync(outside, 'outside\n', 'utf8');

check('a file inside the workspace is not flagged', pathsOutsideWorkspace(inside, root) === false);
check('the workspace root itself is not flagged', pathsOutsideWorkspace(root, root) === false);
check('a sibling directory is flagged', pathsOutsideWorkspace(outside, root) === true);
check('a path that merely prefixes the root name is flagged', pathsOutsideWorkspace(`${root}-extra`, root) === true);
check('no workspace root means no judgement', pathsOutsideWorkspace(outside, '') === false);

// A prefix match on strings alone would call `C:\ws\src` outside `C:\ws\src2`.
{
  const sibling = `${root}2`;
  mkdirSync(sibling, { recursive: true });
  check('a sibling whose name extends the root is flagged', pathsOutsideWorkspace(join(sibling, 'x.txt'), root) === true);
  rmSync(sibling, { recursive: true, force: true });
}

// The harness's scratch directory lives under a symlinked temp path, so a
// lexical comparison alone would report a false escape for a legitimate file.
{
  let linked = true;
  const linkPath = join(outsideDir, 'link-to-workspace');
  try {
    symlinkSync(root, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    linked = false;
  }
  if (linked) {
    check('a file reached through a symlink INTO the workspace is not flagged', pathsOutsideWorkspace(join(linkPath, 'src', 'deep', 'file.txt'), root) === false);
  } else {
    console.log('[--]   symlink check skipped (cannot create a link here)');
  }
}

/* ------------------------------------------------------------- through the tool */

const execFor = (callId) => ({
  callId,
  rootCallId: callId,
  name: 'test',
  token: Symbol('token'),
  arguments: {},
  signal: new AbortController().signal,
  agent: { id: 'session-boundary', session: { header: { cwd: root }, id: 'session-boundary' } },
  deferContext: () => {},
  concludeTurn: () => {}
});

console.log('\n--- host-readable paths by default ---');
const openTools = new Map();
const openContext = new cordis.Context();
openContext.provide('tools', {
  register: (definition) => {
    openTools.set(definition.name, definition);
    return () => {};
  }
});
openContext.plugin(contextMode, { knowledgeBasePath: join(root, 'open-knowledge.db'), timeoutMs: 60000 });
await new Promise((resolve) => setTimeout(resolve, 250));

const openValue = await openTools.get('ctx_execute_file').execute(
  { path: outside, language: 'javascript', code: 'console.log(FILE_CONTENT.trim());' },
  execFor('call-open-outside')
);
check('default file access follows the host read capability', openValue.exitCode === 0 && openValue.outsideWorkspace === true, JSON.stringify({ exitCode: openValue.exitCode, outsideWorkspace: openValue.outsideWorkspace }));
const openIndex = await openTools.get('ctx_index').execute(
  { path: outside, source: 'boundary-open-index' },
  execFor('call-open-index')
);
check('default indexing accepts a host-readable outside file', openIndex.files === 1, JSON.stringify(openIndex.files));

console.log('\n--- optional strict workspace boundary ---');
const registered = new Map();
const rootContext = new cordis.Context();
rootContext.provide('tools', {
  register: (definition) => {
    registered.set(definition.name, definition);
    return () => {};
  }
});
rootContext.plugin(contextMode, {
  knowledgeBasePath: join(root, 'knowledge.db'),
  timeoutMs: 60000,
  restrictPathsToWorkspace: true
});
await new Promise((resolve) => setTimeout(resolve, 250));

const readLength = 'console.log(String(FILE_CONTENT.length));';

{
  const value = await registered.get('ctx_execute_file').execute(
    { path: inside, language: 'javascript', code: readLength, source: 'boundary-inside' },
    execFor('call-inside')
  );
  check('an inside file reports outsideWorkspace=false', value.outsideWorkspace === false, JSON.stringify(value.outsideWorkspace));
  check('an inside file carries no boundary notice', !/outside the session workspace/.test(value.rendered));
}
{
  let error;
  try {
    await registered.get('ctx_execute_file').execute(
      { path: outside, language: 'javascript', code: readLength },
      execFor('call-outside')
    );
  } catch (caught) {
    error = caught;
  }
  check('an outside file is refused before execution', /outside the (?:project|session workspace)/.test(String(error?.message)), String(error?.message));
}

console.log('\n--- through ctx_index ---');
{
  let error;
  try {
    await registered.get('ctx_index').execute(
      { path: outside, source: 'boundary-index-outside' },
      execFor('call-index-outside')
    );
  } catch (caught) {
    error = caught;
  }
  check('indexing an outside file is refused', /outside the (?:project|session workspace)/.test(String(error?.message)), String(error?.message));
}
{
  const value = await registered.get('ctx_index').execute(
    { path: inside, source: 'boundary-index-inside' },
    execFor('call-index-inside')
  );
  check('indexing an inside file stays quiet', !/outside the session workspace/.test(value.rendered));
}

cleanup(outsideDir);
cleanup(root);

console.log(`\n${failures.length === 0 ? 'all workspace boundary tests passed' : `${failures.length} failure(s)`}`);
process.exit(failures.length === 0 ? 0 : 1);
