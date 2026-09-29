/** Production-boundary checks for the current Context Mode contract. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const kitRoot = join(here, '..');
const home = mkdtempSync(join(tmpdir(), 'ctx-current-home-'));
const workspace = mkdtempSync(join(tmpdir(), 'ctx-current-workspace-'));
const outside = mkdtempSync(join(tmpdir(), 'ctx-current-outside-'));
process.env.DSH_HOME = home;

const { Context } = await import('@deepseek-ai/cordis');
const { SessionStore, SessionId } = await import('@deepseek-ai/dsh-session');
const llm = await import('@deepseek-ai/dsh-llm');
const contextMode = await import(pathToFileURL(join(kitRoot, 'lib', 'context-mode.js')).href);

let checks = 0;
const check = (name, condition, detail = '') => {
  checks += 1;
  console.log(`${condition ? '[ok]  ' : '[FAIL]'} ${name}${detail ? ` - ${detail}` : ''}`);
  assert.ok(condition, name);
};
const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const tools = new Map();
const root = new Context();
root.provide('logger', { info() {}, debug() {}, warn() {}, error() {} });
root.provide('tools', { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } });
const store = new SessionStore(root);
const scope = root.plugin(contextMode, { routingGuard: false, timeoutMs: 10_000, knowledgeBasePath: join(workspace, 'knowledge.db') });
let scopeDisposed = false;
await wait(250);

const own = async (id) => {
  const session = store.create(SessionId(id), { meta: { cwd: workspace } });
  for (let attempt = 0; attempt < 50 && store.get(session.id) === undefined; attempt += 1) await wait(10);
  return session;
};
const exec = (session, callId) => ({
  callId,
  rootCallId: callId,
  signal: new AbortController().signal,
  agent: { session },
  deferContext() {},
  concludeTurn() {}
});

try {
  console.log('--- tool surface ---');
  const expected = ['ctx_execute', 'ctx_execute_file', 'ctx_batch_execute', 'ctx_index', 'ctx_search', 'ctx_fetch_and_index', 'ctx_stats', 'ctx_doctor', 'ctx_purge', 'ctx_insight', 'ctx_upgrade'];
  check('all eleven current tools are registered', expected.every((name) => tools.has(name)) && tools.size === expected.length, [...tools.keys()].join(', '));
  check('ctx_execute advertises current arguments', ['timeout', 'background', 'cwd', 'intent'].every((name) => name in tools.get('ctx_execute').parameters.properties));
  check('ctx_index advertises content and directory controls', ['content', 'include', 'exclude', 'maxDepth', 'maxFiles', 'extensions', 'respectGitignore', 'followSymlinks'].every((name) => name in tools.get('ctx_index').parameters.properties));
  check('ctx_fetch_and_index advertises per-request sources', 'requests' in tools.get('ctx_fetch_and_index').parameters.properties);
  const upgrade = await tools.get('ctx_upgrade').execute({}, {});
  check('bundled upgrade is honest instead of updating an unrelated package', upgrade.command === '' && /private local plugin|private.*plugin/i.test(upgrade.rendered), upgrade.rendered);

  const first = await own('ctx-current-first');
  const second = await own('ctx-current-second');

  console.log('\n--- FILE_CONTENT and host-readable paths ---');
  const file = join(workspace, 'sample file.txt');
  writeFileSync(file, 'Привет FILE_CONTENT', 'utf8');
  const fileResult = await tools.get('ctx_execute_file').execute({
    path: file,
    language: 'javascript',
    code: 'console.log(`${FILE_CONTENT}|${FILE_CONTENT_PATH.endsWith("sample file.txt")}`)'
  }, exec(first, 'file-content'));
  check('ctx_execute_file exposes text and path variables', /Привет FILE_CONTENT\|true/.test(fileResult.rendered), fileResult.rendered);

  const secret = join(outside, 'secret.txt');
  writeFileSync(secret, 'must-not-be-read', 'utf8');
  const outsideResult = await tools.get('ctx_execute_file').execute(
    { path: secret, language: 'javascript', code: 'console.log(FILE_CONTENT)' },
    exec(first, 'outside')
  );
  check('default file access follows the host capability', outsideResult.outsideWorkspace === true && /must-not-be-read/.test(outsideResult.rendered), outsideResult.rendered);

  console.log('\n--- bounded directory indexing ---');
  mkdirSync(join(workspace, 'docs'));
  mkdirSync(join(workspace, 'node_modules'));
  writeFileSync(join(workspace, 'docs', 'one.md'), '# Contract needle\nblue-saffron-2718', 'utf8');
  writeFileSync(join(workspace, 'node_modules', 'ignored.md'), 'must-not-index', 'utf8');
  const indexed = await tools.get('ctx_index').execute({ path: workspace, source: 'directory-contract', include: ['**/*.md'] }, exec(first, 'directory'));
  check('directory indexing keeps allowed files and defaults', indexed.files === 1 && indexed.rendered.includes('1 file(s)'), indexed.rendered);
  const directoryHit = await tools.get('ctx_search').execute({ queries: ['blue-saffron-2718'] }, exec(first, 'directory-search'));
  const ignoredHit = await tools.get('ctx_search').execute({ queries: ['must-not-index'] }, exec(first, 'ignored-search'));
  check('directory content is searchable and excluded trees are absent', directoryHit.hits > 0 && ignoredHit.hits === 0);

  console.log('\n--- event auto-memory and search scope ---');
  first.append('user/message', llm.createUserMessage({
    content: [{ type: 'text', text: 'AUTO_MEMORY_NEEDLE_918273' }],
    source: { kind: 'user' }
  }), { surfaceOp: 'append' });
  await wait();
  const sameSession = await tools.get('ctx_search').execute({ queries: ['AUTO_MEMORY_NEEDLE_918273'] }, exec(first, 'memory-same'));
  const otherRelevant = await tools.get('ctx_search').execute({ queries: ['AUTO_MEMORY_NEEDLE_918273'] }, exec(second, 'memory-other'));
  const otherTimeline = await tools.get('ctx_search').execute({ queries: ['AUTO_MEMORY_NEEDLE_918273'], sort: 'timeline' }, exec(second, 'memory-timeline'));
  check('user events are captured without an explicit ctx_index call', sameSession.hits > 0);
  check('relevance is session-local while timeline crosses sessions', otherRelevant.hits === 0 && otherTimeline.hits > 0, `${otherRelevant.hits}/${otherTimeline.hits}`);

  console.log('\n--- batch scoping ---');
  await tools.get('ctx_batch_execute').execute({
    commands: [{ label: 'old', command: process.platform === 'win32' ? 'Write-Output OLD_BATCH_NEEDLE_771' : 'echo OLD_BATCH_NEEDLE_771' }],
    queries: ['OLD_BATCH_NEEDLE_771'],
    source: 'reused-batch-label'
  }, exec(first, 'batch-one'));
  const repeatedBatch = await tools.get('ctx_batch_execute').execute({
    commands: [{ label: 'new', command: process.platform === 'win32' ? 'Write-Output NEW_BATCH_NEEDLE_882' : 'echo NEW_BATCH_NEEDLE_882' }],
    queries: ['OLD_BATCH_NEEDLE_771'],
    source: 'reused-batch-label'
  }, exec(first, 'batch-two'));
  check('batch-scoped queries cannot see an older run that reused the same label', repeatedBatch.rendered.includes('No matching sections found.'));

  console.log('\n--- background detachment ---');
  const marker = join(workspace, 'background-marker.txt');
  const code = `setTimeout(async () => { const fs = await import('node:fs'); fs.writeFileSync(${JSON.stringify(marker)}, 'done'); process.exit(0); }, 350);`;
  const started = Date.now();
  const background = await tools.get('ctx_execute').execute({ language: 'javascript', code, timeout: 80, background: true }, exec(first, 'background'));
  check('background mode detaches at its timeout instead of killing the tree', Date.now() - started < 1000 && /still running in background/.test(background.rendered), background.rendered);
  await wait(600);
  check('the detached process completes after the tool returns', existsSync(marker));

  const disposedMarker = join(workspace, 'disposed-background-marker.txt');
  const disposedCode = `setTimeout(async () => { const fs = await import('node:fs'); fs.writeFileSync(${JSON.stringify(disposedMarker)}, 'leaked'); process.exit(0); }, 700);`;
  await tools.get('ctx_execute').execute({ language: 'javascript', code: disposedCode, timeout: 50, background: true }, exec(first, 'background-dispose'));
  await scope.dispose();
  scopeDisposed = true;
  await wait(900);
  check('plugin disposal kills detached processes owned by the plugin', !existsSync(disposedMarker));

  console.log(`\nall ${checks} current contract checks passed`);
} finally {
  if (!scopeDisposed) await scope.dispose();
  rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  rmSync(workspace, { recursive: true, force: true, maxRetries: 5 });
  rmSync(outside, { recursive: true, force: true, maxRetries: 5 });
}
