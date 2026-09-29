/**
 * Counterfactual guards for the current context-mode storage/search contract.
 *
 * Run: node scripts/test-context-search-parity.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ctx-search-parity-'));
const previousDshHome = process.env.DSH_HOME;
process.env.DSH_HOME = join(dir, 'dsh-home');
const { KnowledgeBase, sqliteSettled } = await import('../lib/knowledge-base.js');
await sqliteSettled();

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const kb = new KnowledgeBase({ path: join(dir, 'knowledge.db'), producer: 'test', logger: silent });

try {
  const longLine = `prefix ${'x'.repeat(4495)} tailneedle after`;
  const indexed = kb.index({ source: 'long-line', kind: 'note', text: longLine });
  assert.equal(indexed.lines, 1);
  assert.ok(indexed.chunks > 1, 'a long physical line must be split');
  const stored = kb.open().prepare(
    'SELECT text FROM entries WHERE source = ? ORDER BY id'
  ).all('long-line').map((row) => String(row.text));
  for (let index = 1; index < stored.length; index += 1) {
    assert.equal(stored[index - 1].slice(-512), stored[index].slice(0, 512));
  }
  const rebuilt = stored.reduce((whole, chunk, index) => (
    index === 0 ? chunk : whole + chunk.slice(512)
  ), '');
  assert.equal(rebuilt, longLine, 'overlapping chunks must reconstruct the full line');
  const tail = kb.search('tailneedle', { limit: 5 });
  assert.ok(tail.some((row) => row.text.includes('tailneedle')), 'a token after character 4500 must be searchable');
  assert.ok(tail.every((row) => row.line === 1), 'chunks retain the physical 1-based line number');
  console.log('[ok] long-line tail is retained in lossless overlapping chunks');

  kb.index({ source: 'porter', kind: 'note', text: 'A cached response remains available.' });
  assert.ok(kb.search('caching').some((row) => row.source === 'porter'));
  console.log('[ok] Porter stemming matches caching to cached');

  kb.index({ source: 'trigram', kind: 'note', text: 'React useEffect cleanup guidance.' });
  assert.ok(kb.search('useEff').some((row) => row.source === 'trigram'));
  console.log('[ok] trigram search matches useEff to useEffect');

  kb.index({ source: 'typo', kind: 'note', text: 'The database connection is healthy.' });
  const typo = kb.search('databse');
  assert.ok(typo.some((row) => row.source === 'typo'));
  assert.equal(typo.find((row) => row.source === 'typo').matchLayer, 'rrf-fuzzy');
  console.log('[ok] one-character typo falls back through Levenshtein correction');

  kb.index({ source: 'line-numbers', kind: 'note', text: 'firstmarker\n\nthirdmarker' });
  assert.equal(kb.search('firstmarker')[0].line, 1);
  assert.equal(kb.search('thirdmarker')[0].line, 3);
  console.log('[ok] first and third physical lines report 1 and 3');

  const schemaOnePath = join(dir, 'schema-one.db');
  const schemaOne = new KnowledgeBase({ path: schemaOnePath, producer: 'test', logger: silent });
  schemaOne.index({ source: 'preserved', kind: 'note', text: 'migrationmarker survives' });
  schemaOne.open().exec(`
    UPDATE entries SET line = line - 1;
    UPDATE meta SET value = '1' WHERE key = 'schema_version';
    DROP TABLE fts_trigram;
  `);
  schemaOne.close();
  const migratedSchema = new KnowledgeBase({ path: schemaOnePath, producer: 'test', logger: silent });
  const preserved = migratedSchema.search('migrationmarker');
  assert.equal(preserved.length, 1);
  assert.equal(preserved[0].line, 1);
  migratedSchema.close();
  console.log('[ok] schema migration preserves entries and fixes old line numbers');

  kb.index({
    source: 'Docs:Prose',
    kind: 'note',
    text: 'The total describes the prose result.',
    createdAt: 100
  });
  kb.index({
    source: 'Code:Sample',
    kind: 'note',
    text: 'const total = compute();',
    createdAt: 200
  });
  const scoped = kb.search('total', { source: 'DOCS', limit: 10 });
  assert.deepEqual(scoped.map((row) => row.source), ['Docs:Prose']);
  assert.equal(kb.search('total', { sort: 'timeline', limit: 10 })[0].source, 'Code:Sample');
  assert.deepEqual(kb.search('total', { contentType: 'code', limit: 10 }).map((row) => row.source), ['Code:Sample']);
  assert.ok(kb.search('total', { contentType: 'prose', limit: 10 }).some((row) => row.source === 'Docs:Prose'));
  console.log('[ok] source substring, timeline, and contentType filters are preserved');

  kb.index({ source: 'far', kind: 'note', text: `alpha ${'filler '.repeat(40)} omega`, createdAt: 300 });
  kb.index({ source: 'near', kind: 'note', text: 'alpha omega are adjacent', createdAt: 250 });
  assert.equal(kb.search('alpha omega', { limit: 2 })[0].source, 'near');
  console.log('[ok] multi-term proximity boosts the tighter result');

  kb.index({ source: 'session-a', kind: 'note', text: 'sessionalpha only', session: 'A' });
  kb.index({ source: 'session-b', kind: 'note', text: 'sessionbravo only', session: 'B' });
  const purged = kb.purge({ scope: 'session', sessionId: 'A' });
  assert.equal(purged.removed, 1);
  assert.equal(kb.search('sessionalpha').length, 0);
  assert.ok(kb.search('sessionbravo').some((row) => row.source === 'session-b'));
  console.log('[ok] session purge removes A and leaves B');

  const mixedCaseWorkspace = join(dir, 'CaseSensitiveName');
  const upper = KnowledgeBase.defaultPath(mixedCaseWorkspace.toUpperCase());
  const lower = KnowledgeBase.defaultPath(mixedCaseWorkspace.toLowerCase());
  assert.equal(upper, lower);
  console.log('[ok] Windows workspace case variants select one deterministic database');

  const legacyPath = KnowledgeBase.defaultPath();
  const legacy = new KnowledgeBase({ path: legacyPath, producer: 'test', logger: silent });
  legacy.index({ source: 'legacy-shared', kind: 'note', text: 'legacymarker remains recoverable' });
  legacy.close();
  const migratedWorkspace = join(dir, 'MigratedWorkspace');
  mkdirSync(migratedWorkspace);
  const warnings = [];
  const migrated = new KnowledgeBase({
    path: KnowledgeBase.defaultPath(migratedWorkspace),
    producer: 'test',
    logger: { ...silent, warn: (message) => warnings.push(String(message)) }
  });
  assert.equal(migrated.search('legacymarker').length, 0, 'shared legacy rows have no project attribution and must not leak into a project DB');
  assert.ok(warnings.some((message) => message.includes('not imported')));
  assert.equal(existsSync(legacyPath), true, 'the shared legacy database must remain available for explicit migration');
  migrated.close();
  console.log('[ok] shared legacy knowledge.db is retained with a warning but not leaked into projects');

  const stats = kb.stats();
  assert.ok(stats.storedBytes > 0);
  assert.ok(stats.counters.bytesIndexed >= Buffer.byteLength(longLine));
  assert.ok(stats.counters.bytesReturned > 0);
  assert.ok(stats.counters.bytesAvoided > 0);
  console.log('[ok] indexed, returned, avoided, and stored byte primitives are measured');

  console.log('\nall context search parity tests passed');
} finally {
  kb.close();
  if (previousDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousDshHome;
  rmSync(dir, { recursive: true, force: true });
}
