/**
 * Functional harness for the context-mode port's two moving parts: the sandbox
 * runner and the SQLite FTS5 knowledge base.
 *
 * Run with:
 *   node scripts/test-context-mode.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KnowledgeBase, toMatchExpression } from '../lib/knowledge-base.js';
import { runProgram } from '../lib/sandbox.js';

const tmpDir = mkdtempSync(join(tmpdir(), 'ctx-kit-test-'));
const workspace = mkdtempSync(join(tmpdir(), 'ctx-kit-ws-'));

const options = {
  cwd: workspace,
  tmpDir,
  timeoutMs: 30000,
  liveCapChars: 65536,
  headChars: 400,
  tailChars: 100
};

/* --------------------------------------------------------------- sandbox */

{
  const run = await runProgram({ ...options, language: 'javascript', code: 'console.log("hello", 6 * 7);' });
  assert.equal(run.exitCode, 0, `javascript should exit 0 (${run.spawnError ?? ''}${run.stderr})`);
  assert.match(run.stdout, /hello 42/);
  console.log('sandbox: javascript runs and returns stdout');
}

{
  const run = await runProgram({ ...options, language: 'javascript', code: 'console.error("boom"); process.exit(3);' });
  assert.equal(run.exitCode, 3);
  assert.match(run.stderr, /boom/);
  assert.equal(run.ok, false);
  assert.equal(run.processStatus, 'nonzero_exit');
  console.log('sandbox: non-zero exit stays distinct from other process outcomes');
}

{
  const run = await runProgram({
    ...options,
    language: 'javascript',
    code: 'const big = "x".repeat(5000); console.log(big); console.log("TAIL-MARKER");'
  });
  assert.equal(run.stdoutTruncated, true, 'an oversized stdout is bounded');
  assert.match(run.stdout, /TAIL-MARKER/, 'the tail survives bounding');
  assert.ok(run.spillPath, 'a spill file is written');
  const spilled = readFileSync(run.spillPath, 'utf8');
  assert.match(spilled, /x{5000}/, 'the spill file holds the complete output');
  console.log(`sandbox: output bounded (${run.fullStdoutChars} chars) with full capture on disk`);
}

{
  const run = await runProgram({ ...options, language: 'javascript', code: 'setTimeout(() => {}, 60000);' , timeoutMs: 1500 });
  assert.notEqual(run.exitCode, 0, 'a runaway program is killed by the timeout');
  assert.equal(run.processStatus, 'timeout');
  console.log('sandbox: timeout remains distinct and kills a runaway program');
}

{
  const target = join(workspace, 'data.txt');
  writeFileSync(target, 'alpha\nbeta\ngamma\n', 'utf8');
  const run = await runProgram({
    ...options,
    language: 'javascript',
    args: [target],
    env: { CTX_FILE: target },
    code: 'const fs = await import("node:fs"); console.log(fs.readFileSync(process.argv[2], "utf8").trim().split("\\n").length);'
  });
  assert.equal(run.stdout.trim(), '3', `the file path reaches the program (got ${JSON.stringify(run.stdout)} ${run.stderr})`);
  console.log('sandbox: extra args reach the program (ctx_execute_file)');
}

for (const [language, code, expected] of [
  ['python', 'print(2 ** 10)', /1024/],
  ['shell', process.platform === 'win32' ? 'Write-Output "shell-ok"' : 'echo shell-ok', /shell-ok/]
]) {
  const run = await runProgram({ ...options, language, code });
  if (run.spawnError !== undefined || run.exitCode !== 0) {
    console.log(`sandbox: ${language} unavailable here (${run.spawnError ?? run.stderr.trim().slice(0, 80)}) — reported, not fatal`);
    continue;
  }
  assert.match(run.stdout, expected);
  console.log(`sandbox: ${language} runs and returns stdout`);
}

/* -------------------------------------------------------- knowledge base */

const dbPath = join(tmpDir, 'knowledge.db');
const kb = new KnowledgeBase({ path: dbPath, producer: 'test', logger: console });

{
  const result = kb.index({
    source: 'unit',
    kind: 'note',
    text: 'the quick brown fox\njumps over the lazy dog\nERROR: something failed loudly\n',
    createdAt: Date.now()
  });
  assert.equal(result.lines, 3, 'blank lines are not indexed');
  console.log('kb: indexing counts non-empty lines');
}

{
  const hits = kb.search('fox');
  assert.equal(hits.length, 1);
  assert.match(hits[0].snippet, /fox/);
  assert.equal(hits[0].source, 'unit');
  console.log('kb: relevance search returns a snippet and its source');
}

{
  const hits = kb.search('something failed');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].isError, true, 'error-looking lines are flagged');
  console.log('kb: multi-term search ANDs terms and flags errors');
}

{
  kb.index({ source: 'other', kind: 'log', text: 'a second document mentioning a fox again', createdAt: Date.now() + 5 });
  const filtered = kb.search('fox', { source: 'other' });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].source, 'other');
  const timeline = kb.search('fox', { sort: 'timeline' });
  assert.equal(timeline[0].source, 'other', 'timeline puts the newest first');
  console.log('kb: source filter and timeline sort work');
}

{
  kb.index({ source: 'scope-a', kind: 'note', text: 'SCOPE_NEEDLE_733', session: 'session-a', createdAt: Date.now() });
  kb.index({ source: 'scope-b', kind: 'note', text: 'SCOPE_NEEDLE_733', session: 'session-b', createdAt: Date.now() });
  kb.index({ source: 'scope-project', kind: 'note', text: 'SCOPE_NEEDLE_733', createdAt: Date.now() });
  const sessionHits = kb.search('SCOPE_NEEDLE_733', { scope: 'session', session: 'session-a', limit: 10 });
  assert.deepEqual(sessionHits.map((row) => row.source), ['scope-a'], 'session scope must exclude other sessions and sessionless rows');
  const projectHits = kb.search('SCOPE_NEEDLE_733', { scope: 'project', limit: 10 });
  assert.equal(projectHits.length, 3);
  console.log('kb: explicit scope strictly separates session and project rows');
}

{
  const layerArgs = ['fts', ['needle'], null, 'project', undefined, 3, false];
  const ftsErrorDb = { prepare: () => ({ all: () => { throw new Error('fts5: syntax error near "."'); } }) };
  const searchState = { invalidQuery: false };
  assert.deepEqual(kb._searchLayer(ftsErrorDb, ...layerArgs, searchState), []);
  assert.equal(searchState.invalidQuery, true, 'confirmed FTS errors must remain distinguishable from no matches');
  const prepareFailureDb = { prepare: () => { throw new Error('database is locked'); } };
  assert.throws(() => kb._searchLayer(prepareFailureDb, ...layerArgs), /database is locked/);
  const executeFailureDb = { prepare: () => ({ all: () => { throw new Error('disk I/O error'); } }) };
  assert.throws(() => kb._searchLayer(executeFailureDb, ...layerArgs), /disk I\/O error/);
  assert.equal(kb.search('fox', { withStatus: true }).status, 'matched');
  assert.equal(kb.search('definitely-absent-token-9281', { withStatus: true }).status, 'no_matches');
  console.log('kb: only confirmed FTS query errors are suppressed and statuses stay distinct');
}

{
  const hits = kb.search('AND OR NEAR "quoted" -dash');
  assert.ok(Array.isArray(hits), 'FTS5 operator-looking input must not throw');
  assert.equal(toMatchExpression('   '), undefined);
  console.log('kb: query syntax is escaped, never interpreted');
}

{
  const stats = kb.stats();
  assert.equal(stats.lines, 7);
  assert.ok(stats.sources >= 2);
  assert.equal(kb.verify().ok, true);
  console.log(`kb: stats and integrity check ok (${stats.lines} lines, ${stats.sources} sources)`);
}

{
  const removed = kb.purge();
  assert.equal(removed.removed, 7);
  assert.equal(kb.stats().lines, 0);
  console.log('kb: purge empties the index');
}

kb.close();

/* --------------------------------------------------------- reopen persistence */

{
  const first = new KnowledgeBase({ path: dbPath, producer: 'test', logger: console });
  first.index({ source: 'persist', kind: 'note', text: 'survives a reopen', createdAt: Date.now() });
  first.close();
  const second = new KnowledgeBase({ path: dbPath, producer: 'test', logger: console });
  assert.equal(second.search('survives').length, 1, 'the index persists across instances');
  second.close();
  console.log('kb: content persists across reopen');
}

console.log('\nall context-mode tests passed');
