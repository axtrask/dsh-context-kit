/**
 * Check the routing guard against UPSTREAM's decisions, case by case.
 *
 * The guard reads shell command text, so both failure modes are user-visible: a
 * pattern that matches a bare mention refuses a legitimate command, and a pattern
 * that is too narrow lets a fetch flood the conversation. The previous version of
 * this script read the port's own regexes out of its source and asserted the
 * port's own behaviour — which is why it passed while the port disagreed with
 * upstream on two well-known commands.
 *
 * The port now implements upstream's rule (`hooks/core/routing.mjs:738-812`):
 * decide PER SEGMENT, and allow a `curl`/`wget` that is silent and writes to a
 * file, because its body never reaches the model. The expected values below are
 * upstream's, taken from its own logic rather than from the port.
 *
 * Run:  node scripts/verify-routing.mjs
 *
 * @module dsh-context-kit/scripts/verify-routing
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const kitRoot = join(here, '..');

// The guard is exercised through the real plugin: a fake `tools/pre-execute`
// listener is captured at registration and then called, so the test cannot pass
// by matching a private regex the plugin no longer uses.
const { Context } = await import('@deepseek-ai/cordis');
const { mkdtempSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const home = mkdtempSync(join(tmpdir(), 'ctx-routing-'));
process.env.DSH_HOME = home;

const contextMode = await import(pathToFileURL(join(kitRoot, 'lib', 'context-mode.js')).href);
const root = new Context();
const listeners = [];
root.provide('tools', { register: () => () => {} });
root.provide('logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
root.provide('commands', { register: () => () => {} });
const originalOn = root.on.bind(root);
root.on = (event, handler) => {
  if (event === 'tools/pre-execute') listeners.push(handler);
  return originalOn(event, handler);
};
root.plugin(contextMode, { knowledgeBasePath: join(home, 'kb.db') });
await new Promise((resolve) => setTimeout(resolve, 300));
rmSync(home, { recursive: true, force: true });

const guard = listeners[0];
if (guard === undefined) {
  console.log('[FAIL] the plugin registered no tools/pre-execute guard');
  process.exit(1);
}

/**
 * Run one command through the guard.
 * @param command - the shell command line.
 * @returns true when the guard denies it.
 */
async function denied(command) {
  const exec = { name: 'pwsh', arguments: { command } };
  const decision = await guard(exec, async () => ({ kind: 'allow' }));
  return decision.kind === 'deny';
}

/** `[command, upstreamBlocksIt, why]` — expected values are upstream's. */
const CASES = [
  // Upstream ALLOWS a silent fetch that writes to a file: the body never enters
  // the conversation. The port used to deny both of these.
  ['curl -s -o out.json https://example.com/api', false, 'silent curl writing to a file (upstream: ALLOW)'],
  ['wget -q -O out.html https://example.com/page', false, 'quiet wget writing to a file (upstream: ALLOW)'],
  ['curl -s https://example.com/api', true, 'silent curl but nothing redirects the body'],
  ['curl https://example.com', true, 'a bare curl fetch'],
  ['curl -o out.html https://example.com', true, 'file output but NOT silent — the progress bar floods stderr'],
  ['curl -s -v -o out.json https://example.com', true, 'silent and redirected, but verbose'],
  ['curl -s -o - https://example.com', true, 'output aliased back to stdout'],
  ['curl -s -o /dev/stdout https://example.com', true, 'output aliased to /dev/stdout'],
  ['wget -q -O - https://example.com', true, 'wget aliasing to stdout'],
  ['git status && curl -s -o out.json https://example.com', false, 'the legal segment beside another command'],
  ['git status && curl https://example.com', true, 'a dangerous segment beside another command'],
  ['echo "the word curl appears here"', false, 'the WORD in prose'],
  ["echo 'wget is a tool'", false, 'a quoted mention'],
  ['Get-Help curl', false, 'reading help for curl'],
  ['grep -r curl src/', false, 'searching the tree for the word'],
  ['npm run build', false, 'an unrelated command'],
  ['git commit -m "document wget usage"', false, 'a commit message mentioning it'],
  // Upstream's inline-HTTP patterns.
  ['node -e "fetch(\'https://x\')"', true, 'a bare fetch() one-liner (upstream: MODIFY)'],
  ['python -c "import requests; requests.get(\'http://x\')"', true, 'inline HTTP from python'],
  ['python -c "print(1)"', false, 'python doing something else'],
  ['echo fetch( in prose', false, 'the token `fetch(` in text with no URL'],
  ['cat <<EOF\nrequests.get("http://x")\nEOF', false, 'a heredoc body is removed before matching'],
  // Upstream redirects verbose build tools (routing.mjs:807-812).
  ['./gradlew build', true, 'a gradle build'],
  ['mvn -q package', true, 'a maven build'],
  ['sbt compile', true, 'an sbt build'],
  ['npm run build', false, 'npm is not in upstream\'s build-tool list'],
  ['Write-Output "uploading"', false, 'a plain command']
];

let failures = 0;
for (const [command, shouldBlock, why] of CASES) {
  const blocked = await denied(command);
  const ok = blocked === shouldBlock;
  if (!ok) failures += 1;
  console.log(`${ok ? '[ok]  ' : '[FAIL]'} deny=${String(blocked).padEnd(5)} ${JSON.stringify(command)}  (${why})`);
}

console.log(`\n${CASES.length - failures}/${CASES.length} routing cases behave as upstream specifies`);
process.exit(failures === 0 ? 0 : 1);
