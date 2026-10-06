/** Production-boundary checks for the current Context Mode contract. */
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const kitRoot = join(here, '..');
const home = mkdtempSync(join(tmpdir(), 'ctx-current-home-'));
const workspace = mkdtempSync(join(tmpdir(), 'ctx-current-workspace-'));
const outside = mkdtempSync(join(tmpdir(), 'ctx-current-outside-'));
process.env.DSH_HOME = home;
const sampleFile = join(workspace, 'sample file.txt');
const originalReadFileSync = fs.readFileSync;
let parentSampleReads = 0;
fs.readFileSync = function countedReadFileSync(path, ...args) {
  if (String(path) === sampleFile) parentSampleReads += 1;
  return originalReadFileSync.call(this, path, ...args);
};
syncBuiltinESMExports();

try {
writeFileSync(join(home, 'context-mode.jsonc'), `{
  // Valid legacy settings remain active while invalid overrides are skipped.
  "routingGuard": false,
  "knowledgeBasePath": 42,
  "timeoutMs": 999
}`, 'utf8');

const { Context } = await import('@deepseek-ai/cordis');
const { SessionStore, SessionId } = await import('@deepseek-ai/dsh-session');
const llm = await import('@deepseek-ai/dsh-llm');
const contextMode = await import(pathToFileURL(join(kitRoot, 'lib', 'context-mode.js')).href);
const { KnowledgeBase } = await import(pathToFileURL(join(kitRoot, 'lib', 'knowledge-base.js')).href);

let checks = 0;
const check = (name, condition, detail = '') => {
  checks += 1;
  console.log(`${condition ? '[ok]  ' : '[FAIL]'} ${name}${detail ? ` - ${detail}` : ''}`);
  assert.ok(condition, name);
};
const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const poll = async (probe, timeoutMs = 8_000, intervalMs = 100) => {
  const deadline = Date.now() + timeoutMs;
  let result;
  do {
    result = await probe();
    if (result) return result;
    if (Date.now() >= deadline) return result;
    await wait(intervalMs);
  } while (true);
};
const divertedBytes = (rendered) => Number(/context bytes: \d+ indexed, \d+ returned, (\d+) conservatively measured as diverted/.exec(rendered)?.[1]);

const validationWarnings = [];
writeFileSync(join(home, 'context-mode.jsonc'), `{
  "enabled": false,
  "knowledgeBasePath": 42,
  "timeoutMs": 999
}`, 'utf8');
contextMode.apply({
  logger: {
    info() {},
    warn(message) { validationWarnings.push(String(message)); }
  }
}, { enabled: true });
writeFileSync(join(home, 'context-mode.jsonc'), `{
  "routingGuard": false,
  "knowledgeBasePath": 42,
  "timeoutMs": 999
}`, 'utf8');

const tools = new Map();
const guards = [];
const warnings = [];
const root = new Context();
root.provide('logger', { info() {}, debug() {}, warn(message) { warnings.push(String(message)); }, error() {} });
root.provide('tools', {
  register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); },
  guard(guard) { guards.push(guard); return () => guards.splice(guards.indexOf(guard), 1); }
});
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
  check('valid legacy routingGuard:false remains active', guards.length === 0);
  check('invalid legacy overrides are skipped with key-specific warnings',
    validationWarnings.some((line) => line.includes('knowledgeBasePath') && line.includes('invalid override'))
      && validationWarnings.some((line) => line.includes('timeoutMs') && line.includes('invalid override')),
    validationWarnings.join(' | '));
  await tools.get('ctx_stats').execute({}, exec({ id: 'config-path', header: { cwd: workspace } }, 'config-path'));
  check('invalid legacy knowledgeBasePath preserves the validated row setting after first database use', existsSync(join(workspace, 'knowledge.db')));
  const upgrade = await tools.get('ctx_upgrade').execute({}, {});
  check('bundled upgrade is honest instead of updating an unrelated package', upgrade.command === '' && /private local plugin|private.*plugin/i.test(upgrade.rendered), upgrade.rendered);

  unlinkSync(join(home, 'context-mode.jsonc'));
  const routingGuards = [];
  const routingRoot = new Context();
  routingRoot.provide('logger', { info() {}, debug() {}, warn() {}, error() {} });
  routingRoot.provide('tools', {
    register() { return () => {}; },
    guard(guard) { routingGuards.push(guard); return () => routingGuards.splice(routingGuards.indexOf(guard), 1); }
  });
  const routingScope = routingRoot.plugin(contextMode, {
    routingGuard: true,
    commands: false,
    autoIndex: false,
    knowledgeBasePath: join(workspace, 'routing-knowledge.db')
  });
  await wait(100);
  check('routing policy registers through the synchronous tools guard API',
    routingGuards.length === 1
      && /fetches a URL through the shell/.test(routingGuards[0]({ name: 'pwsh', arguments: { command: 'curl https://example.test' } }) ?? ''));
  await routingScope.dispose();

  const first = await own('ctx-current-first');
  const second = await own('ctx-current-second');

  console.log('\n--- FILE_CONTENT and host-readable paths ---');
  const fileText = 'Привет FILE_CONTENT';
  writeFileSync(sampleFile, fileText, 'utf8');
  const fileResult = await tools.get('ctx_execute_file').execute({
    path: sampleFile,
    language: 'javascript',
    code: 'console.log(`${FILE_CONTENT}|${FILE_CONTENT_PATH.endsWith("sample file.txt")}`)'
  }, exec(first, 'file-content'));
  check('ctx_execute_file exposes text and path variables', /Привет FILE_CONTENT\|true/.test(fileResult.rendered), fileResult.rendered);
  check('ctx_execute_file preserves child-derived character-count metadata', fileResult.fileChars === fileText.length, String(fileResult.fileChars));
  check('ctx_execute_file does not read the full file in the parent process', parentSampleReads === 0, String(parentSampleReads));

  const diversionBefore = divertedBytes((await tools.get('ctx_stats').execute({}, exec(first, 'stats-before-diversion'))).rendered);
  const diversionFile = join(workspace, 'diversion-sample.txt');
  const diversionText = 'x'.repeat(16_384);
  writeFileSync(diversionFile, diversionText, 'utf8');
  await tools.get('ctx_execute_file').execute({
    path: diversionFile,
    language: 'javascript',
    code: 'console.log(FILE_CONTENT.slice(0, 16).length)'
  }, exec(first, 'file-diversion'));
  const diversionAfter = divertedBytes((await tools.get('ctx_stats').execute({}, exec(first, 'stats-after-diversion'))).rendered);
  check('ctx_stats counts raw execute-file bytes as conservatively measured diversion',
    Number.isFinite(diversionBefore) && diversionAfter - diversionBefore > Buffer.byteLength(diversionText) / 2,
    `${diversionBefore} -> ${diversionAfter}`);

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
  writeFileSync(join(workspace, 'docs', 'ignored.md'), 'BARE_GITIGNORE_MUST_NOT_INDEX_624', 'utf8');
  writeFileSync(join(workspace, 'root-only.md'), 'ROOT_ANCHORED_MUST_NOT_INDEX_735', 'utf8');
  writeFileSync(join(workspace, 'docs', 'root-only.md'), 'NESTED_ROOT_NAME_MUST_INDEX_846', 'utf8');
  writeFileSync(join(workspace, '.gitignore'), 'ignored.md\n/root-only.md\n', 'utf8');
  writeFileSync(join(workspace, 'node_modules', 'ignored.md'), 'must-not-index', 'utf8');
  const indexed = await tools.get('ctx_index').execute({ path: workspace, source: 'directory-contract', include: ['**/*.md'] }, exec(first, 'directory'));
  check('directory indexing keeps allowed files and defaults', indexed.files === 2 && indexed.rendered.includes('2 file(s)'), indexed.rendered);
  const directoryHit = await tools.get('ctx_search').execute({ queries: ['blue-saffron-2718'] }, exec(first, 'directory-search'));
  const ignoredHit = await tools.get('ctx_search').execute({ queries: ['must-not-index'] }, exec(first, 'ignored-search'));
  const gitignoreHits = await tools.get('ctx_search').execute({
    queries: ['BARE_GITIGNORE_MUST_NOT_INDEX_624', 'ROOT_ANCHORED_MUST_NOT_INDEX_735', 'NESTED_ROOT_NAME_MUST_INDEX_846']
  }, exec(first, 'gitignore-search'));
  check('directory content is searchable and excluded trees are absent', directoryHit.hits > 0 && ignoredHit.hits === 0);
  check('bare gitignore names match at any depth while leading slash stays root-anchored',
    gitignoreHits.rendered.includes('## BARE_GITIGNORE_MUST_NOT_INDEX_624\n(no matches)')
      && gitignoreHits.rendered.includes('## ROOT_ANCHORED_MUST_NOT_INDEX_735\n(no matches)')
      && !gitignoreHits.rendered.includes('## NESTED_ROOT_NAME_MUST_INDEX_846\n(no matches)'),
    gitignoreHits.rendered);

  console.log('\n--- hard array caps ---');
  const tooMany = Array.from({ length: 65 }, (_, index) => `item-${index}`);
  await assert.rejects(
    tools.get('ctx_search').execute({ queries: tooMany }, exec(first, 'search-cap')),
    /ctx_search: queries accepts at most 64 items/
  );
  await assert.rejects(
    tools.get('ctx_batch_execute').execute({
      commands: tooMany.map((label) => ({ label, command: 'echo skipped' })),
      queries: ['skipped']
    }, exec(first, 'commands-cap')),
    /ctx_batch_execute: commands accepts at most 64 items/
  );
  await assert.rejects(
    tools.get('ctx_batch_execute').execute({ commands: [{ label: 'skipped', command: 'echo skipped' }], queries: tooMany }, exec(first, 'batch-queries-cap')),
    /ctx_batch_execute: queries accepts at most 64 items/
  );
  await assert.rejects(
    tools.get('ctx_fetch_and_index').execute({ requests: tooMany.map((url) => ({ url: `https://example.test/${url}` })) }, exec(first, 'requests-cap')),
    /ctx_fetch_and_index: requests accepts at most 64 items/
  );
  for (const name of ['include', 'exclude', 'extensions']) {
    await assert.rejects(
      tools.get('ctx_index').execute({ path: workspace, [name]: tooMany }, exec(first, `index-${name}-cap`)),
      new RegExp(`ctx_index: ${name} accepts at most 64 items`)
    );
  }
  check('oversized user arrays fail before work starts', true);

  console.log('\n--- event auto-memory and search scope ---');
  first.append('user/message', llm.createUserMessage({
    content: [{ type: 'text', text: 'AUTO_MEMORY_NEEDLE_918273' }],
    source: { kind: 'user' }
  }), { surfaceOp: 'append' });
  await wait();
  const sameSession = await tools.get('ctx_search').execute({ queries: ['AUTO_MEMORY_NEEDLE_918273'] }, exec(first, 'memory-same'));
  const otherRelevant = await tools.get('ctx_search').execute({ queries: ['AUTO_MEMORY_NEEDLE_918273'] }, exec(second, 'memory-other'));
  const otherTimeline = await tools.get('ctx_search').execute({ queries: ['AUTO_MEMORY_NEEDLE_918273'], sort: 'timeline' }, exec(second, 'memory-timeline'));
  const projectTimeline = await tools.get('ctx_search').execute({ queries: ['AUTO_MEMORY_NEEDLE_918273'], sort: 'timeline', scope: 'project' }, exec(second, 'memory-project-timeline'));
  check('user events are captured without an explicit ctx_index call', sameSession.hits > 0);
  check('search scope is session-local independently of sort', otherRelevant.hits === 0 && otherTimeline.hits === 0, `${otherRelevant.hits}/${otherTimeline.hits}`);
  check('project scope explicitly crosses sessions', projectTimeline.hits > 0);

  console.log('\n--- batch scoping ---');
  const firstBatch = await tools.get('ctx_batch_execute').execute({
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
  check('batch query status distinguishes matches', firstBatch.queryStatuses[0].status === 'matched' && firstBatch.queryStatuses[0].hits > 0);
  check('batch reports separate process, capture, index, and query statuses',
    repeatedBatch.commandStatuses[0].processStatus === 'success'
      && repeatedBatch.commandStatuses[0].captureState === 'final'
      && repeatedBatch.commandStatuses[0].indexStatus === 'indexed'
      && repeatedBatch.queryStatuses[0].status === 'no_matches');

  const deadlineMarker = join(workspace, 'batch-deadline-must-not-run.txt');
  const slowCommand = process.platform === 'win32' ? 'Start-Sleep -Milliseconds 400' : 'sleep 0.4';
  const forbiddenCommand = process.platform === 'win32'
    ? `Set-Content -LiteralPath '${deadlineMarker.replaceAll("'", "''")}' -Value leaked`
    : `printf leaked > ${JSON.stringify(deadlineMarker)}`;
  const deadlineBatch = await tools.get('ctx_batch_execute').execute({
    commands: [
      { label: 'consume-deadline', command: slowCommand },
      { label: 'must-not-start-a', command: forbiddenCommand },
      { label: 'must-not-start-b', command: forbiddenCommand }
    ],
    queries: ['DEADLINE_OUTPUT_THAT_DOES_NOT_EXIST_553'],
    concurrency: 1,
    timeout: 80
  }, exec(first, 'batch-deadline'));
  check('batch deadline does not launch queued commands with a synthetic 1 ms timeout',
    deadlineBatch.commandStatuses[0].processStatus === 'timeout'
      && deadlineBatch.commandStatuses.slice(1).every((status) => status.processStatus === 'not_started_deadline'
        && status.captureState === 'none'
        && status.indexStatus === 'skipped')
      && !existsSync(deadlineMarker));
  check('batch query status distinguishes no matches', deadlineBatch.queryStatuses[0].status === 'no_matches');

  const originalSearch = KnowledgeBase.prototype.search;
  KnowledgeBase.prototype.search = function statusSeam(query, options) {
    if (query === 'FORCE_INVALID_QUERY_STATUS_773') return { status: 'invalid_query', rows: [] };
    if (query === 'FORCE_DATABASE_ERROR_STATUS_884') throw new Error('database is locked for status guard');
    return originalSearch.call(this, query, options);
  };
  let failedQueryBatch;
  try {
    failedQueryBatch = await tools.get('ctx_batch_execute').execute({
      commands: [{ label: 'status-seam', command: process.platform === 'win32' ? 'Write-Output STATUS_SEAM' : 'echo STATUS_SEAM' }],
      queries: ['FORCE_INVALID_QUERY_STATUS_773', 'FORCE_DATABASE_ERROR_STATUS_884']
    }, exec(first, 'batch-query-statuses'));
  } finally {
    KnowledgeBase.prototype.search = originalSearch;
  }
  check('batch query statuses keep invalid input distinct from database failures',
    failedQueryBatch.queryStatuses[0].status === 'invalid_query'
      && failedQueryBatch.queryStatuses[1].status === 'database_error'
      && /database is locked/.test(failedQueryBatch.queryStatuses[1].error));

  console.log('\n--- background detachment ---');
  const marker = join(workspace, 'background-marker.txt');
  const code = `setTimeout(async () => { const fs = await import('node:fs'); fs.writeFileSync(${JSON.stringify(marker)}, 'done'); console.log('BACKGROUND_FINAL_INDEX_441'); process.exit(0); }, 350);`;
  const started = Date.now();
  const background = await tools.get('ctx_execute').execute({ language: 'javascript', code, timeout: 80, background: true }, exec(first, 'background'));
  check('background mode detaches at its timeout instead of killing the tree', Date.now() - started < 1000 && /still running in background/.test(background.rendered), background.rendered);
  const processCompleted = await poll(() => existsSync(marker));
  check('the detached process completes after the tool returns', processCompleted);
  let backgroundSearchAttempts = 0;
  const finalBackgroundHit = await poll(async () => {
    backgroundSearchAttempts += 1;
    const result = await tools.get('ctx_search').execute(
      { queries: ['BACKGROUND_FINAL_INDEX_441'] },
      exec(first, `background-final-search-${backgroundSearchAttempts}`)
    );
    return result.hits > 0 ? result : undefined;
  });
  check('detached final output is indexed after process exit', finalBackgroundHit?.hits > 0, `${backgroundSearchAttempts} attempt(s)`);

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
} finally {
  fs.readFileSync = originalReadFileSync;
  syncBuiltinESMExports();
}
