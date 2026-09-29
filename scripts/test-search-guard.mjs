/**
 * Functional harness for the `ctx_search` throttle and for the knowledge base's
 * source and content-type filters.
 *
 * The throttle is the only piece of context-mode state that survives a call,
 * and every way of getting it wrong is silent: a guard that never trips costs
 * nothing visible, and a guard keyed on the process instead of the session
 * blocks a parallel fan-out that never flooded anything. These cases pin the
 * window arithmetic, the two exact user-facing strings, the fact that a
 * multi-query call is still ONE call, and that a source filter cannot be widened
 * by a `LIKE` wildcard inside the label.
 *
 * Run with:
 *   node scripts/test-search-guard.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const kitRoot = join(here, '..');

const { Context } = await import('@deepseek-ai/cordis');
const contextMode = await import(pathToFileURL(join(kitRoot, 'lib', 'context-mode.js')).href);
const { KnowledgeBase } = await import(pathToFileURL(join(kitRoot, 'lib', 'knowledge-base.js')).href);

/** The document every search scenario runs against: three lines match. */
const DOC = 'alpha needle\nbeta needle\nneedle in the middle\ngamma line\n';

/**
 * Mount context-mode over a private knowledge base.
 * @param config - plugin configuration overrides.
 * @returns the registered tool definitions, keyed by name.
 */
async function mount(config) {
  const registered = new Map();
  const root = new Context();
  root.provide('tools', { register: (definition) => { registered.set(definition.name, definition); return () => {}; } });
  root.plugin(contextMode, {
    knowledgeBasePath: join(mkdtempSync(join(tmpdir(), 'ctx-guard-db-')), 'knowledge.db'),
    ...config
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  return registered;
}

/** One invocation context shaped like the harness's `ToolRunContext`. */
const execFor = (callId, sessionId = 'session-guard') => ({
  callId,
  rootCallId: callId,
  name: 'test',
  token: Symbol('token'),
  arguments: {},
  signal: new AbortController().signal,
  agent: { id: sessionId, session: { header: { cwd: process.cwd() }, id: sessionId } },
  deferContext: () => {},
  concludeTurn: () => {}
});

/**
 * Assert that one reply carries the exact throttle line for a call.
 * @param rendered - the reply text.
 * @param count - this call's number within the window.
 * @param remaining - calls left before the soft cap.
 * @param blockCap - the configured hard cap.
 */
function assertThrottle(rendered, count, remaining, blockCap = 8) {
  const line = `> Throttle: call #${count}/${blockCap} in this window. ${remaining} call(s) before soft cap. `
    + 'Prefer ctx_search(queries: [...]) array form for multi-query workloads — it counts as a single call.';
  assert.ok(rendered.includes(line), `throttle line missing (call #${count}); tail was ${JSON.stringify(rendered.slice(-160))}`);
}

/** Index the shared document into one mounted instance. */
async function seed(tools, source = 'guard-doc') {
  await tools.get('ctx_index').execute({ source, text: DOC }, execFor('call-index'));
}

/* ------------------------------------------------------------ the window */

{
  const guard = contextMode.createSearchGuard({ windowMs: 60000, softCap: 3, blockCap: 8 });
  assert.equal(guard.record('s1', 1000).count, 1, 'the first call opens the window');
  assert.equal(guard.record('s1', 2000).count, 2);
  const edge = guard.record('s1', 61000);
  assert.equal(edge.count, 3, 'a call exactly one window later still belongs to the open window');
  assert.equal(edge.windowStart, 1000);
  const reset = guard.record('s1', 61001);
  assert.equal(reset.count, 1, 'the counter resets once the window has elapsed');
  assert.equal(reset.windowStart, 61001, 'and the new window starts at that call');
  assert.equal(reset.blocked, false);

  const soft = contextMode.createSearchGuard({ windowMs: 60000, softCap: 3, blockCap: 8 });
  assert.equal(soft.record('s2', 0).softCapped, false);
  assert.equal(soft.record('s2', 0).softCapped, false);
  assert.equal(soft.record('s2', 0).softCapped, false, 'the call AT the soft cap is not yet capped');
  assert.equal(soft.record('s2', 0).softCapped, true, 'the call after it is');
  assert.equal(soft.record('s2', 0).blocked, false);
  assert.equal(soft.record('s2', 0).blocked, false);
  assert.equal(soft.record('s2', 0).blocked, false);
  assert.equal(soft.record('s2', 0).blocked, false, 'the call AT the hard cap is not yet blocked');
  assert.equal(soft.record('s2', 0).blocked, true, 'the call after it is blocked');

  const keyed = contextMode.createSearchGuard({ windowMs: 60000, softCap: 3, blockCap: 8 });
  assert.equal(keyed.record('a', 0).count, 1);
  assert.equal(keyed.record('b', 0).count, 1, 'a second session gets its own counter');
  assert.equal(keyed.record('a', 0).count, 2);
  assert.equal(keyed.size(), 2);
  console.log('guard: the window resets, the caps trip on the call after, and sessions are counted separately');
}

/* ------------------------------------------- the throttle through the tool */

const tools = await mount({});
const search = tools.get('ctx_search');
await seed(tools);

{
  const first = await search.execute({ queries: ['needle'] }, execFor('call-1'));
  assert.equal(first.hits, 2, 'a query returns at most two hits however large `limit` is by default');
  assertThrottle(first.rendered, 1, 2);

  // Three queries in ONE call: the guard must record a single call, which is
  // the whole reason the throttle line points at the array form.
  const batched = await search.execute(
    { queries: ['needle', 'middle', 'alpha'] },
    execFor('call-2')
  );
  assert.equal(batched.queries.length, 3);
  assertThrottle(batched.rendered, 2, 1);

  const third = await search.execute({ queries: ['needle'] }, execFor('call-3'));
  assert.equal(third.hits, 2, 'the call AT the soft cap still returns two hits');
  assertThrottle(third.rendered, 3, 0);

  const fourth = await search.execute({ queries: ['needle'] }, execFor('call-4'));
  assert.equal(fourth.hits, 1, 'past the soft cap a query returns exactly one hit');
  assertThrottle(fourth.rendered, 4, 0);

  const other = await search.execute({ queries: ['needle'] }, execFor('call-other', 'session-elsewhere'));
  assertThrottle(other.rendered, 1, 2);
  assert.equal(other.hits, 0, 'relevance search does not leak another session\'s indexed content');
  console.log('search: one batched call counts once, the soft cap trims to one hit, and sessions do not share data or budget');
}

/* ----------------------------------------------------------- the hard cap */

{
  const blockedTools = await mount({ searchSoftCap: 2, searchBlockCap: 3 });
  await seed(blockedTools, 'guard-block');
  const blockedSearch = blockedTools.get('ctx_search');
  for (const call of ['call-a', 'call-b', 'call-c']) {
    await blockedSearch.execute({ queries: ['needle'] }, execFor(call));
  }
  await assert.rejects(
    () => blockedSearch.execute({ queries: ['needle'] }, execFor('call-d')),
    (error) => {
      assert.equal(
        error.message,
        "BLOCKED: 4 search calls in 0s. You're flooding context. STOP making individual search calls. "
        + 'Use ctx_batch_execute(commands, queries) for your next research step.'
      );
      return true;
    },
    'the call past the hard cap must be refused with the exact upstream text'
  );
  console.log('search: the call past the hard cap is refused with the exact BLOCKED text');
}

/* ------------------------------------------------- the window, end to end */

{
  const windowed = await mount({ searchWindowMs: 150, searchSoftCap: 1, searchBlockCap: 2 });
  await seed(windowed, 'guard-window');
  const windowedSearch = windowed.get('ctx_search');
  assert.equal((await windowedSearch.execute({ queries: ['needle'] }, execFor('w1'))).hits, 2);
  const capped = await windowedSearch.execute({ queries: ['needle'] }, execFor('w2'));
  assert.equal(capped.hits, 1, 'the second call inside the window is soft-capped');
  await new Promise((resolve) => setTimeout(resolve, 250));
  // Without the reset this call would be the third in the window and blocked.
  const after = await windowedSearch.execute({ queries: ['needle'] }, execFor('w3'));
  assert.equal(after.hits, 2, 'a call after the window starts a fresh budget');
  assertThrottle(after.rendered, 1, 0, 2);
  console.log('search: the counter resets after the window, through the tool path');
}

/* ----------------------------------------------------------- the output cap */

{
  const capped = await mount({ searchMaxChars: 512 });
  const long = (word) => `needle ${word} ${'x'.repeat(380)}`;
  await capped.get('ctx_index').execute(
    { source: 'guard-cap', text: `${long('one')}\n${long('two')}\n${long('three')}\n` },
    execFor('call-cap-index')
  );
  const reply = await capped.get('ctx_search').execute(
    { queries: ['needle', 'needle two', 'needle three'] },
    execFor('call-cap')
  );
  assert.equal(reply.hits, 2, 'only the query that fit under the cap contributed hits');
  assert.ok(reply.rendered.includes('- [guard-cap'), 'the first query is rendered in full');
  assert.ok(
    reply.rendered.includes('## needle two\n(output cap reached)\n'),
    'the query that crossed the cap carries the exact upstream notice'
  );
  assert.ok(reply.rendered.includes('## needle three\n(output cap reached)\n'), 'and so does every query after it');
  assert.equal((reply.rendered.match(/\(output cap reached\)/g) ?? []).length, 2, 'each cut query is named once');
  console.log('search: a query past the output cap is replaced by the upstream "(output cap reached)" notice');
}

/* --------------------------------------- source and content-type filters */

{
  const kb = new KnowledgeBase({
    path: join(mkdtempSync(join(tmpdir(), 'ctx-guard-kb-')), 'knowledge.db'),
    producer: 'test',
    logger: console
  });
  kb.index({ source: 'fetch:docs-page', kind: 'fetch', text: 'the needle is on the page', createdAt: 1 });
  kb.index({ source: 'docs-other', kind: 'note', text: 'the needle is in the note', createdAt: 2 });
  kb.index({ source: 'a_b', kind: 'note', text: 'the needle sits under a_b', createdAt: 3 });
  kb.index({ source: 'aXb', kind: 'note', text: 'the needle sits under aXb', createdAt: 4 });

  assert.equal(kb.search('needle', { source: 'docs', limit: 10 }).length, 2, 'a source fragment matches every label containing it');
  assert.deepEqual(
    kb.search('needle', { source: 'DOCS', limit: 10 }).map((row) => row.source).sort(),
    ['docs-other', 'fetch:docs-page'],
    'the fragment match is case-insensitive'
  );
  assert.equal(kb.search('needle', { source: 'fetch:docs-page', limit: 10 }).length, 1, 'an exact label still matches');
  const literal = kb.search('needle', { source: 'a_b', limit: 10 });
  assert.equal(literal.length, 1, 'a LIKE wildcard inside a source label is escaped, not interpreted');
  assert.equal(literal[0].source, 'a_b');
  assert.equal(kb.search('needle', { source: 'nothing-here', limit: 10 }).length, 0);

  kb.index({
    source: 'mixed',
    kind: 'note',
    text: 'const total = items.reduce((a, b) => a + b, 0);\nThe total is a sentence about items.\n  if (total > 10) {\n',
    createdAt: 5
  });
  const all = kb.search('total', { limit: 10 });
  const code = kb.search('total', { limit: 10, contentType: 'code' });
  const prose = kb.search('total', { limit: 10, contentType: 'prose' });
  assert.equal(all.length, 3, 'the document contributes three matching lines');
  assert.equal(code.length + prose.length, all.length, 'every matching line is either code or prose');
  assert.equal(code.length, 2, 'the two code-shaped lines are the code set');
  assert.deepEqual(prose.map((row) => row.text), ['The total is a sentence about items.']);
  kb.close();
  console.log('kb: source is a case-insensitive substring with wildcards escaped, and contentType splits code from prose');
}

/* -------------------------------------------------------------- insight */

{
  const insight = tools.get('ctx_insight');
  assert.ok(insight !== undefined, 'ctx_insight must be registered');
  const value = await insight.execute({}, execFor('call-insight'));
  assert.equal(value.url, contextMode.INSIGHT_URL);
  assert.equal(value.embeddable, true);
  assert.equal(value.reason, '');
  assert.ok(value.rendered.includes(contextMode.INSIGHT_URL), 'the happy branch names the URL');
  assert.match(value.rendered, /external dashboard/);
  const failure = contextMode.insightResult('not a url');
  assert.equal(failure.embeddable, false);
  assert.ok(failure.reason.length > 0, 'the failure branch names a reason');
  assert.match(
    failure.rendered,
    /^Could not embed the Insight dashboard URL in this reply \(.+\)\.\nOpen Insight manually: /
  );
  console.log('insight: the URL is returned as a pointer, and an unembeddable URL takes the failure branch');
}

console.log('\nall search guard tests passed');
