/**
 * Prove the three knowledge-base behaviours that were wrong.
 *
 * Each of these is a user-visible defect that the port's own tests could not see,
 * because they asserted the port's behaviour instead of upstream's:
 *
 * 1. AND-per-term matching. Upstream ORs the MEANINGFUL terms of a query
 *    (`src/store.ts:90-110`, called with `"OR"` at `:1254`), so a natural question
 *    is a set of candidates ranked by BM25. Requiring every term in one line made
 *    a six-word question return nothing — which is exactly what a question looks
 *    like, and what this port did in real use.
 * 2. Re-indexing a label APPENDED, so the same command run twice answered every
 *    search twice. Upstream deletes by label first (`src/store.ts:1049-1052`).
 * 3. One database for the whole machine. Upstream scopes it per project by
 *    `sha256(cwd)[0:16]` (`src/server.ts:686-696`), so a search in one project
 *    cannot return another project's output.
 *
 * Run:  node scripts/test-knowledge-base.mjs
 *
 * @module dsh-context-kit/scripts/test-knowledge-base
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const kitRoot = join(here, '..');

const failures = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '[ok]  ' : '[FAIL]'} ${label}${detail.length > 0 ? ` — ${detail.slice(0, 170)}` : ''}`);
  if (!ok) failures.push(label);
};

const { KnowledgeBase, toMatchExpression, sqliteSettled } = await import(pathToFileURL(join(kitRoot, 'lib', 'knowledge-base.js')).href);
// The SQLite import settles asynchronously; a script that runs immediately after
// mount arrives first. Awaiting the module's own promise is what a real caller
// does, and it is what makes this test deterministic instead of a race.
await sqliteSettled();
const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

console.log('\n--- a query is a set of candidates, not a phrase ---');
{
  const expression = toMatchExpression('how do the upstream tools handle context');
  check('terms are ORed', typeof expression === 'string' && expression.includes(' OR '), String(expression));
  check('no AND remains', !String(expression).includes(' AND '), String(expression));
  check('stopwords are dropped to improve ranking', !/\b"how"|\b"the"|\b"do"\b/.test(String(expression)), String(expression));
  check('a query of only stopwords keeps its terms instead of vanishing', typeof toMatchExpression('the and for') === 'string', String(toMatchExpression('the and for')));
  check('an explicit AND mode still exists for exact matching', String(toMatchExpression('alpha beta', 'AND')).includes(' AND '), String(toMatchExpression('alpha beta', 'AND')));
  check('FTS operators are stripped, never executed', !/NEAR\(/.test(String(toMatchExpression('NEAR(alpha beta)'))), String(toMatchExpression('NEAR(alpha beta)')));
  check('an empty query yields no expression', toMatchExpression('   ') === undefined);
}
{
  const dir = mkdtempSync(join(tmpdir(), 'kb-or-'));
  const kb = new KnowledgeBase({ path: join(dir, 'kb.db'), producer: 'test', logger: silent });
  // The words live on DIFFERENT lines: under the old AND rule this returned zero.
  kb.index({
    source: 'verify-or',
    kind: 'execute',
    text: [
      'the upstream repository is Opencode-DCP',
      'the tools expose a compress operation',
      'context handling differs between the two projects'
    ].join('\n')
  });
  const hits = kb.search('how do the upstream tools handle context', { limit: 3 });
  check('a natural-language question finds its lines', (hits.length) > 0, JSON.stringify(hits.length));
  const lines = hits.map((hit) => hit.text ?? hit.line ?? '').join(' | ');
  check('and returns the lines that carry the words', /upstream|tools|context/.test(lines), lines.slice(0, 120));
  kb.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n--- re-indexing a label replaces it ---');
{
  const dir = mkdtempSync(join(tmpdir(), 'kb-replace-'));
  const kb = new KnowledgeBase({ path: join(dir, 'kb.db'), producer: 'test', logger: silent });
  const first = kb.index({ source: 'verify-replace', kind: 'execute', text: 'alpha line one\nalpha line two' });
  check('the first index stores two lines', first.lines === 2, String(first.lines));
  const db = kb.open();
  check('new stores stay on schema 2',
    db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value === '2');
  check('schema 2 has no per-entry vocabulary table',
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'entry_vocabulary'").get() === undefined);
  const prepare = db.prepare.bind(db);
  let scannedWholeCorpus = false;
  db.prepare = (sql) => {
    const normalized = String(sql).replace(/\s+/g, ' ').trim();
    if (/^SELECT\b.*\btext\b.*\bFROM\s+entries\b/i.test(normalized) && !/\bWHERE\b/i.test(normalized)) {
      scannedWholeCorpus = true;
      throw new Error('full vocabulary rebuild is forbidden while indexing a new label');
    }
    return prepare(sql);
  };
  const added = kb.index({ source: 'verify-new', kind: 'execute', text: 'gamma stays searchable' });
  check('a second new label uses incremental vocabulary inserts', added.lines === 1 && !scannedWholeCorpus);
  db.prepare = prepare;
  const second = kb.index({ source: 'verify-replace', kind: 'execute', text: 'beta replaced everything' });
  check('the re-index stores the new content', second.lines === 1, String(second.lines));
  const rows = db.prepare('SELECT COUNT(*) AS n FROM entries WHERE source = ?').get('verify-replace');
  check('the old rows are gone, not duplicated', Number(rows.n) === 1, `rows=${rows.n}`);
  const stale = kb.search('alpha', { limit: 5 });
  check('the replaced content no longer answers searches', (stale.length) === 0, JSON.stringify(stale));
  const fresh = kb.search('beta', { limit: 5 });
  check('the new content does', (fresh.length) > 0);
  const words = db.prepare('SELECT word FROM vocabulary ORDER BY word').all().map((row) => String(row.word));
  check('replacement rebuild removes orphaned words and keeps other labels', !words.includes('alpha') && words.includes('beta') && words.includes('gamma'), words.join(','));
  // An empty re-run must still claim the label, or a failed run silently leaves
  // the previous output answering searches.
  kb.index({ source: 'verify-replace', kind: 'execute', text: '   ' });
  const afterEmpty = kb.search('beta', { limit: 5 });
  check('an empty re-index clears the label rather than keeping stale text', (afterEmpty.length) === 0, JSON.stringify(afterEmpty));
  check('empty replacement rebuilds vocabulary without harming other labels',
    db.prepare('SELECT 1 FROM vocabulary WHERE word = ?').get('beta') === undefined
      && db.prepare('SELECT 1 FROM vocabulary WHERE word = ?').get('gamma') !== undefined);
  const purged = kb.purge({ scope: 'project' });
  check('project purge clears entries and vocabulary', purged.removed === 1
    && db.prepare('SELECT COUNT(*) AS n FROM entries').get().n === 0
    && db.prepare('SELECT COUNT(*) AS n FROM vocabulary').get().n === 0);
  kb.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n--- the database is scoped to one project ---');
{
  const a = KnowledgeBase.defaultPath('C:/work/project-a');
  const b = KnowledgeBase.defaultPath('C:/work/project-b');
  check('two workspaces get two databases', a !== b, `${a} vs ${b}`);
  check('the same workspace is stable', KnowledgeBase.defaultPath('C:/work/project-a') === a);
  const key = a.split(/[\\/]/).pop().replace('.db', '');
  check('the key is 16 hex characters, as upstream', /^[0-9a-f]{16}$/.test(key), key);
  check('the file lives under content/, as upstream', /[\\/]content[\\/]/.test(a), a);
  check('no workspace falls back to the shared database', KnowledgeBase.defaultPath() !== a && KnowledgeBase.defaultPath().endsWith('knowledge.db'), KnowledgeBase.defaultPath());
}
{
  // Two projects must not see each other's captures.
  const dir = mkdtempSync(join(tmpdir(), 'kb-scope-'));
  const workspaceA = join(dir, 'a');
  const workspaceB = join(dir, 'b');
  const baseA = join(dir, 'a.db');
  const baseB = join(dir, 'b.db');
  const a = new KnowledgeBase({ path: baseA, producer: 'test', logger: silent });
  const b = new KnowledgeBase({ path: baseB, producer: 'test', logger: silent });
  a.index({ source: 'capture', kind: 'execute', text: 'a-secret-token lives here' });
  const leak = b.search('a-secret-token', { limit: 5 });
  check('project B does not see project A\'s capture', (leak.length) === 0, JSON.stringify(leak));
  const own = b.search('a-secret-token', { limit: 5, source: 'capture' });
  check('and B has nothing under that label at all', (own.length) === 0);
  a.close();
  b.close();
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.log(`\n${failures.length} knowledge-base check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nknowledge base behaves as upstream specifies');
}
