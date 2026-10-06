/**
 * The knowledge base behind context-mode: a local full-text index of everything
 * a tool call produced, so the model can retrieve a line instead of reading a
 * file into its context.
 *
 * Upstream context-mode uses SQLite + FTS5 through `better-sqlite3`. Node 24
 * ships SQLite itself (`node:sqlite`, SQLite 3.50 with FTS5 compiled in), so
 * the port needs no native build step and no dependency.
 *
 * @module dsh-context-kit/knowledge-base
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { kitDir } from './common.js';

/**
 * Node marks `node:sqlite` experimental and prints a warning the first time the
 * module evaluates. The harness's console is a user-facing surface, so the
 * import is deferred until after a filter is installed.
 *
 * The filter drops exactly that one warning; every other process warning still
 * reaches its original listeners. The import itself is not optional — Node
 * before 22.5 has no `node:sqlite` at all — so a failure here surfaces as a
 * readable error from {@link KnowledgeBase.open} rather than a crash on mount.
 */
let sqliteNamespace;
let sqliteFailure;
const sqliteReady = (() => {
  const original = process.listeners('warning');
  try {
    process.removeAllListeners('warning');
    process.on('warning', (warning) => {
      if (warning?.name === 'ExperimentalWarning' && /SQLite/i.test(String(warning.message))) return;
      for (const listener of original) listener.call(process, warning);
    });
  } catch {
    // A host that froze the warning channel keeps its own behaviour.
  }
  try {
    sqliteNamespace = createRequire(import.meta.url)('node:sqlite');
    return Promise.resolve(true);
  } catch (error) {
    sqliteFailure = error;
    return Promise.resolve(false);
  }
})();

/** Refuse a synchronous call made before the SQLite module settled. */
function assertSqliteReady() {
  if (sqliteNamespace !== undefined) return sqliteNamespace;
  if (sqliteFailure !== undefined) {
    throw new Error(
      `context-mode: this Node build has no usable SQLite module (${sqliteFailure.message}); `
      + 'the knowledge base needs Node 22.5 or newer'
    );
  }
  throw new Error('context-mode: the Node SQLite module is still loading; retry in a moment');
}

/**
 * The namespace once the asynchronous import has settled.
 *
 * The import is asynchronous because a top-level `await` in a plugin module would
 * delay every other registration in the composition. A caller that runs
 * immediately after mount — a script, or the first tool call of a session — can
 * therefore arrive first, and "retry in a moment" is not an answer it can act on.
 * Awaiting this promise is.
 *
 * @returns a promise resolving once the SQLite module has settled either way.
 */
export function sqliteSettled() {
  return sqliteReady;
}


/** Long lines are split without dropping their tail; overlap keeps boundary tokens. */
const MAX_CHUNK_CHARS = 4000;
const CHUNK_OVERLAP_CHARS = 512;

/** Version 2 uses one global typo-correction vocabulary. */
const SCHEMA_VERSION = 2;
const RRF_K = 60;
const DEFAULT_ROOT = kitDir('context-mode');
const defaultPathMigrations = new Map();
const warnedSharedLegacy = new Set();

/** Estimate tokens for one text the way the harness's fixed heuristic does. */
export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * A content-addressed full-text store with timeline and relevance queries.
 *
 * One instance owns one SQLite file. It is opened lazily, so a session that
 * never indexes anything never touches the disk.
 */
export class KnowledgeBase {
  /**
   * @param options - database path, indexer identity, and logger.
   */
  constructor(options) {
    this.path = canonicalDatabasePath(options.path);
    this.producer = options.producer;
    this.logger = options.logger;
    this.db = null;
    this.counters = {
      indexed: 0,
      searched: 0,
      purged: 0,
      bytesIndexed: 0,
      bytesReturned: 0,
      bytesAvoided: 0
    };
  }

  /**
   * The default database path, one database PER PROJECT.
   *
   * Upstream keys its store by the project: `~/<config>/context-mode/content/
   * <sha256(cwd)[0:16]>.db` (`src/server.ts:686-696`, `src/session/db.ts:430,460`).
   * The port kept ONE database for the whole machine, so a search in project B
   * returned whatever project A had indexed, and `ctx_purge` wiped every project
   * at once. The hash below is the same first-16-hex-characters-of-sha256 rule.
   *
   * @param workspace - the session workspace; absent keeps the shared database.
   * @returns the database path to use.
   */
  static defaultPath(workspace) {
    if (typeof workspace !== 'string' || workspace.trim().length === 0) return join(DEFAULT_ROOT, 'knowledge.db');

    const lexical = resolve(workspace);
    const canonical = canonicalWorkspacePath(lexical);
    const key = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
    const target = join(DEFAULT_ROOT, 'content', `${key}.db`);

    const legacyKey = createHash('sha256').update(lexical).digest('hex').slice(0, 16);
    const candidates = [
      join(DEFAULT_ROOT, 'content', `${legacyKey}.db`)
    ].filter((candidate) => pathIdentity(candidate) !== pathIdentity(target));
    const migrationKey = pathIdentity(target);
    const known = defaultPathMigrations.get(migrationKey) ?? [];
    defaultPathMigrations.set(migrationKey, [...new Set([...known, ...candidates])]);
    return target;
  }

  /** Open the database, creating the schema on first use. */
  open() {
    if (this.db !== null) return this.db;
    const { DatabaseSync } = assertSqliteReady();
    // A per-project database lives in `content/`, which does not exist on a fresh
    // machine; SQLite creates the file but not the directory above it.
    mkdirSync(dirname(this.path), { recursive: true });
    const db = new DatabaseSync(this.path);
    try {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
      db.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source TEXT NOT NULL,
          kind TEXT NOT NULL,
          seq INTEGER NOT NULL,
          line INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          session TEXT,
          text TEXT NOT NULL,
          is_error INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS entries_source ON entries(source, seq);
        CREATE INDEX IF NOT EXISTS entries_created ON entries(created_at);
        CREATE TABLE IF NOT EXISTS vocabulary (
          word TEXT PRIMARY KEY
        );
      `);

      const current = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
      const version = current === undefined ? SCHEMA_VERSION : Number(current.value);
      if (!Number.isInteger(version) || version > SCHEMA_VERSION) {
        throw new Error(`context-mode: unsupported knowledge-base schema ${String(current?.value)}`);
      }

      let rebuild = false;
      if (current === undefined) {
        db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
      } else if (version < SCHEMA_VERSION) {
        db.exec('BEGIN');
        try {
          // Schema 1 wrote zero-based line numbers. Keep every row and fix it in place.
          if (version < 2) {
            db.exec('UPDATE entries SET line = line + 1');
            rebuild = true;
          }
          db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(SCHEMA_VERSION), 'schema_version');
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      }

      if (rebuild) {
        db.exec('DROP TABLE IF EXISTS fts; DROP TABLE IF EXISTS fts_trigram');
      }
      const porterSql = String(db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'fts'"
      ).get()?.sql ?? '');
      if (porterSql.length > 0 && !/porter\s+unicode61/i.test(porterSql)) {
        db.exec('DROP TABLE fts');
        rebuild = true;
      }
      createSearchTables(db);
      const sharedLegacy = join(DEFAULT_ROOT, 'knowledge.db');
      if (pathIdentity(this.path) !== pathIdentity(sharedLegacy)
        && existsSync(sharedLegacy)
        && !warnedSharedLegacy.has(pathIdentity(this.path))) {
        warnedSharedLegacy.add(pathIdentity(this.path));
        const warn = typeof this.logger?.warn === 'function' ? this.logger.warn.bind(this.logger) : console.warn;
        warn(`context-mode: legacy shared knowledge base retained at ${sharedLegacy}; it was not imported because its entries have no project identity`);
      }
      if (this._importLegacyDatabases(db) > 0) rebuild = true;

      const entries = Number(db.prepare('SELECT COUNT(*) AS n FROM entries').get().n ?? 0);
      const porterRows = Number(db.prepare('SELECT COUNT(*) AS n FROM fts').get().n ?? 0);
      const trigramRows = Number(db.prepare('SELECT COUNT(*) AS n FROM fts_trigram').get().n ?? 0);
      if (rebuild || entries !== porterRows || entries !== trigramRows) rebuildSearchData(db);

      this.db = db;
      return db;
    } catch (error) {
      try { db.close(); } catch { /* preserve the opening failure */ }
      throw error;
    }
  }

  /** Import old case-sensitive or shared stores once, leaving each source DB intact. */
  _importLegacyDatabases(db) {
    const candidates = defaultPathMigrations.get(pathIdentity(this.path)) ?? inferLegacyPaths(this.path);
    let imported = 0;
    for (const candidate of candidates) {
      if (!existsSync(candidate) || pathIdentity(candidate) === pathIdentity(this.path)) continue;
      const marker = `legacy_import:${createHash('sha256').update(pathIdentity(candidate)).digest('hex').slice(0, 16)}`;
      if (db.prepare('SELECT 1 FROM meta WHERE key = ?').get(marker) !== undefined) continue;

      let attached = false;
      try {
        db.prepare('ATTACH DATABASE ? AS legacy_import').run(candidate);
        attached = true;
        const hasEntries = db.prepare(
          "SELECT 1 FROM legacy_import.sqlite_master WHERE type = 'table' AND name = 'entries'"
        ).get();
        if (hasEntries === undefined) continue;

        let legacyVersion = 1;
        try {
          legacyVersion = Number(db.prepare(
            "SELECT value FROM legacy_import.meta WHERE key = 'schema_version'"
          ).get()?.value ?? 1);
        } catch {
          legacyVersion = 1;
        }
        const lineOffset = legacyVersion < 2 ? 1 : 0;
        db.exec('BEGIN');
        try {
          const result = db.prepare(`
            INSERT INTO entries (source, kind, seq, line, created_at, session, text, is_error)
            SELECT l.source, l.kind, l.seq, l.line + ?, l.created_at, l.session, l.text, l.is_error
            FROM legacy_import.entries l
            WHERE NOT EXISTS (
              SELECT 1 FROM entries e
              WHERE e.source = l.source AND e.kind = l.kind AND e.seq = l.seq
                AND e.line = l.line + ? AND e.created_at = l.created_at
                AND e.session IS l.session AND e.text = l.text
            )
          `).run(lineOffset, lineOffset);
          db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(marker, String(Date.now()));
          db.exec('COMMIT');
          imported += Number(result.changes ?? 0);
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
        const warn = typeof this.logger?.warn === 'function' ? this.logger.warn.bind(this.logger) : console.warn;
        warn(`context-mode: imported legacy knowledge base into ${this.path}; original retained at ${candidate}`);
      } catch (error) {
        const warn = typeof this.logger?.warn === 'function' ? this.logger.warn.bind(this.logger) : console.warn;
        warn(`context-mode: legacy knowledge base remains at ${candidate} (${error.message})`);
      } finally {
        if (attached) {
          try { db.exec('DETACH DATABASE legacy_import'); } catch { /* best effort */ }
        }
      }
    }
    return imported;
  }

  /** Close the database, if open. */
  close() {
    if (this.db === null) return;
    try {
      this.db.close();
    } catch {
      /* a failed close must not mask the caller's own outcome */
    }
    this.db = null;
  }

  /**
   * Index one document: a source label, a kind, and its text.
   *
   * Text is stored line by line so a hit reports the line it came from and a
   * query returns a snippet instead of a whole log.
   *
   * Re-indexing a label REPLACES it, which is upstream's rule
   * (`src/store.ts:1049-1052` deletes by label before inserting). Appending
   * instead — what the port did — means a source indexed twice answers every
   * later search twice and inflates `ctx_stats`, so a re-run of the same command
   * behaves differently from the first run.
   *
   * @param document - the document to store.
   * @returns how many lines were indexed and how many characters they hold.
   */
  index(document) {
    const db = this.open();
    const text = typeof document.text === 'string' ? document.text : String(document.text ?? '');
    const source = document.source.length > 0 ? document.source : 'unlabeled';
    const kind = document.kind ?? 'note';
    const session = document.session ?? null;
    const replace = document.replace !== false;

    if (text.trim().length === 0) {
      // An empty document still claims the label: otherwise a failed re-run would
      // silently leave the previous run's content answering searches.
      if (replace) this.removeSource(source);
      return { lines: 0, chars: 0 };
    }
    const createdAt = Number.isFinite(document.createdAt) ? document.createdAt : Date.now();

    const insertEntry = db.prepare(
      'INSERT INTO entries (source, kind, seq, line, created_at, session, text, is_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const insertFts = db.prepare('INSERT INTO fts (text, source, entry_id) VALUES (?, ?, ?)');
    const insertTrigram = db.prepare('INSERT INTO fts_trigram (text, source, entry_id) VALUES (?, ?, ?)');
    const insertWord = db.prepare('INSERT OR IGNORE INTO vocabulary (word) VALUES (?)');

    const rawLines = text.split(/\r?\n/);
    let indexedLines = 0;
    let chunks = 0;
    let chars = 0;
    const bytes = Buffer.byteLength(text);
    db.exec('BEGIN');
    try {
      const removed = replace ? this._removeSourceWithin(source) : 0;
      for (let lineNumber = 0; lineNumber < rawLines.length; lineNumber += 1) {
        const raw = rawLines[lineNumber];
        if (raw.trim().length === 0) continue;
        const isError = document.isError === true || /(^|\s)(error|exception|traceback|failed|fatal)(:|\s|$)/i.test(raw);
        for (const chunk of splitLongLine(raw)) {
          const info = insertEntry.run(
            source,
            kind,
            document.seq ?? 0,
            lineNumber + 1,
            createdAt,
            session,
            chunk,
            isError ? 1 : 0
          );
          const entryId = Number(info.lastInsertRowid);
          insertFts.run(chunk, source, entryId);
          insertTrigram.run(chunk, source, entryId);
          for (const word of vocabularyWords(chunk)) insertWord.run(word);
          chunks += 1;
        }
        indexedLines += 1;
        chars += raw.length;
      }
      if (removed > 0) rebuildVocabulary(db);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    this.counters.indexed += chunks;
    this.counters.bytesIndexed += bytes;
    return { lines: indexedLines, chunks, chars, bytes };
  }

  /**
   * Delete one label's rows inside the caller's transaction.
   * @param source - the exact source label.
   */
  _removeSourceWithin(source) {
    const db = this.db;
    db.prepare('DELETE FROM fts WHERE entry_id IN (SELECT id FROM entries WHERE source = ?)').run(source);
    db.prepare('DELETE FROM fts_trigram WHERE entry_id IN (SELECT id FROM entries WHERE source = ?)').run(source);
    const result = db.prepare('DELETE FROM entries WHERE source = ?').run(source);
    return Number(result.changes ?? 0);
  }

  /**
   * Delete one label's rows, opening its own transaction.
   * @param source - the exact source label.
   * @returns how many rows were removed.
   */
  removeSource(source) {
    const db = this.open();
    db.exec('BEGIN');
    try {
      const removed = this._removeSourceWithin(source);
      if (removed > 0) rebuildVocabulary(db);
      db.exec('COMMIT');
      return removed;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Run one FTS5 query.
   *
   * `source` is a case-insensitive SUBSTRING filter, matching upstream: a
   * caller scopes a search with a fragment of a label (`tooltest` selects
   * `tooltest-filearg`). An exact label still matches — it is a substring of
   * itself — so the exact-match path the port started with is preserved rather
   * than kept as a second branch. SQLite's `LIKE` folds case for ASCII only,
   * which is the same limit upstream's `LIKE` has.
   *
   * @param query - the user's query text; quoted so FTS5 operators in a search
   *   term cannot turn into syntax errors.
   * @param options - limit, source pattern, content-type filter, and sort order.
   * @returns matching rows, newest-first in `timeline` mode.
   */
  search(query, options = {}) {
    const db = this.open();
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 100) : 3;
    const source = typeof options.source === 'string' && options.source.length > 0 ? options.source : undefined;
    const session = typeof options.session === 'string' && options.session.length > 0 ? options.session : undefined;
    const scope = options.scope ?? (session === undefined ? 'project' : 'session');
    if (scope !== 'session' && scope !== 'project') throw new TypeError(`Unknown search scope: ${scope}`);
    if (scope === 'session' && session === undefined) throw new TypeError("search: scope 'session' requires session");
    const contentType = options.contentType === 'code' || options.contentType === 'prose' ? options.contentType : undefined;
    const terms = queryTerms(query);
    this.counters.searched += 1;
    if (terms.length === 0) return options.withStatus === true ? { status: 'no_matches', rows: [] } : [];
    const searchState = { invalidQuery: false };
    // `%` and `_` are LIKE wildcards, so a label is escaped before it becomes a
    // pattern. Without that, `_` matches ANY single character — `tooltest_file`
    // would also select `tooltestXfile` — and a label containing `%` would
    // match every source in the index, silently widening the scope the caller
    // asked to narrow.
    const pattern = source === undefined ? null : `%${escapeLike(source)}%`;
    const timeline = options.sort === 'timeline';
    const fetchLimit = Math.min(Math.max(limit * (contentType === undefined ? 8 : 20), 100), 2000);

    let fused = this._fuseSearch(db, terms, pattern, scope, session, contentType, fetchLimit, timeline, searchState);
    let matchedTerms = terms;
    let matchLayer = 'rrf';
    if (fused.length === 0 && !searchState.invalidQuery) {
      const corrected = this._correctTerms(db, terms);
      if (corrected.some((term, index) => term !== terms[index])) {
        fused = this._fuseSearch(db, corrected, pattern, scope, session, contentType, fetchLimit, timeline, searchState);
        matchedTerms = corrected;
        matchLayer = 'rrf-fuzzy';
      }
    }

    if (timeline) {
      fused.sort((a, b) => (
        Number(b.row.created_at) - Number(a.row.created_at)
        || Number(b.row.seq) - Number(a.row.seq)
        || Number(b.row.line) - Number(a.row.line)
        || Number(b.row.id) - Number(a.row.id)
      ));
    } else {
      for (const item of fused) item.proximity = proximityBoost(item.row.text, matchedTerms);
      fused.sort((a, b) => (
        b.proximity - a.proximity
        || b.rrf - a.rrf
        || a.bestRank - b.bestRank
        || Number(b.row.created_at) - Number(a.row.created_at)
        || Number(b.row.id) - Number(a.row.id)
      ));
    }

    const rows = fused.slice(0, limit).map((item) => {
      const row = toRow(item.row);
      row.snippet = extractSearchSnippet(row.text, matchedTerms);
      row.matchLayer = matchLayer;
      row.rank = -item.rrf;
      return row;
    });
    const returnedBytes = rows.reduce((sum, row) => sum + Buffer.byteLength(row.snippet), 0);
    const candidateBytes = fused.reduce((sum, item) => sum + Buffer.byteLength(String(item.row.text)), 0);
    this.counters.bytesReturned += returnedBytes;
    this.counters.bytesAvoided += Math.max(0, candidateBytes - returnedBytes);
    if (options.withStatus === true) {
      return { status: rows.length > 0 ? 'matched' : (searchState.invalidQuery ? 'invalid_query' : 'no_matches'), rows };
    }
    return rows;
  }

  /** Search one FTS layer and return rank-ordered candidates. */
  _searchLayer(db, table, terms, pattern, scope, session, limit, timeline, searchState = { invalidQuery: false }) {
    const selected = table === 'fts_trigram' ? terms.filter((term) => term.length >= 3) : terms;
    if (selected.length === 0) return [];
    const match = matchExpression(selected);
    const order = timeline
      ? 'e.created_at DESC, e.seq DESC, e.line DESC, e.id DESC'
      : `bm25(${table}), e.id DESC`;
    const sessionClause = scope === 'session' ? 'AND e.session = ?' : '';
    // Preparation errors are operational failures, not malformed user input.
    // Keep prepare outside the narrow FTS execution guard so they propagate.
    const statement = db.prepare(`
      SELECT e.id, e.source, e.kind, e.seq, e.line, e.created_at, e.text, e.is_error,
             bm25(${table}) AS score
      FROM entries e
      JOIN ${table} ON ${table}.entry_id = e.id
       WHERE ${table} MATCH ?
         AND (? IS NULL OR e.source LIKE ? ESCAPE '\\')
         ${sessionClause}
      ORDER BY ${order}
      LIMIT ?
    `);
    const params = [match, pattern, pattern];
    if (scope === 'session') params.push(session);
    params.push(limit);
    try {
      return statement.all(...params);
    } catch (error) {
      // Only confirmed FTS5 parser/tokenizer execution failures mean an invalid
      // query. Locking, I/O, schema, and other SQLite failures must propagate.
      if (isFtsQueryError(error)) {
        searchState.invalidQuery = true;
        return [];
      }
      throw error;
    }
  }

  /** Merge Porter and trigram rankings with reciprocal-rank fusion. */
  _fuseSearch(db, terms, pattern, scope, session, contentType, limit, timeline, searchState) {
    const merged = new Map();
    for (const table of ['fts', 'fts_trigram']) {
      const rows = this._searchLayer(db, table, terms, pattern, scope, session, limit, timeline, searchState);
      rows.forEach((row, index) => {
        const code = looksLikeCode(row.text);
        if (contentType === 'code' && !code) return;
        if (contentType === 'prose' && code) return;
        const id = Number(row.id);
        const contribution = 1 / (RRF_K + index + 1);
        const existing = merged.get(id);
        if (existing === undefined) {
          merged.set(id, { row, rrf: contribution, bestRank: index, proximity: 0 });
        } else {
          existing.rrf += contribution;
          existing.bestRank = Math.min(existing.bestRank, index);
        }
      });
    }
    return [...merged.values()];
  }

  /** Correct query words only when no exact/stem/substring layer answered. */
  _correctTerms(db, terms) {
    return terms.map((term) => {
      const word = term.toLowerCase();
      if (word.length < 3) return term;
      const maxDistance = word.length <= 4 ? 1 : word.length <= 12 ? 2 : 3;
      const candidates = db.prepare(`
        SELECT word FROM vocabulary
        WHERE LENGTH(word) BETWEEN ? AND ?
        ORDER BY word
      `).all(word.length - maxDistance, word.length + maxDistance);
      if (candidates.some((candidate) => candidate.word === word)) return term;

      let best;
      let bestDistance = maxDistance + 1;
      for (const candidate of candidates) {
        const distance = levenshtein(word, String(candidate.word));
        if (distance < bestDistance) {
          best = String(candidate.word);
          bestDistance = distance;
        }
      }
      return bestDistance <= maxDistance ? best : term;
    });
  }

  /**
    * The newest indexed batch for one source label.
    *
    * Upstream's fetch cache is keyed by (source, url) and asks the store when the
    * label was last written (`src/server.ts:3300-3305`). This is the same question
    * asked of the port's own table.
    *
    * @param source - the exact source label.
    * @returns `{ indexedAt, lines, chars }`, or undefined when the label is absent.
    */
  sourceMeta(source) {
    const db = this.open();
    const row = db.prepare(
      'SELECT MAX(created_at) AS indexed_at, COUNT(*) AS lines, COALESCE(SUM(LENGTH(text)), 0) AS chars FROM entries WHERE source = ?'
    ).get(source);
    if (row === undefined || row.indexed_at === null) return undefined;
    return { indexedAt: Number(row.indexed_at), lines: Number(row.lines), chars: Number(row.chars) };
  }

  /** Aggregate counters and byte measurements for `ctx_stats`. */
  stats() {
    const db = this.open();
    const totals = db.prepare('SELECT COUNT(*) AS lines, COUNT(DISTINCT source) AS sources FROM entries').get();
    const chars = db.prepare('SELECT COALESCE(SUM(LENGTH(text)), 0) AS chars FROM entries').get();
    const storedBytes = db.prepare('SELECT COALESCE(SUM(LENGTH(CAST(text AS BLOB))), 0) AS bytes FROM entries').get();
    const newest = db.prepare('SELECT MAX(created_at) AS at FROM entries').get();
    const bySource = db.prepare('SELECT source, COUNT(*) AS lines FROM entries GROUP BY source ORDER BY lines DESC LIMIT 20').all();
    return {
      path: this.path,
      lines: Number(totals.lines ?? 0),
      sources: Number(totals.sources ?? 0),
      chars: Number(chars.chars ?? 0),
      storedBytes: Number(storedBytes.bytes ?? 0),
      newestAt: newest.at === null ? null : Number(newest.at),
      bySource: bySource.map((row) => ({ source: String(row.source), lines: Number(row.lines) })),
      counters: { ...this.counters }
    };
  }

  /** Delete one session or the whole project; no arguments keep legacy behavior. */
  purge(options = {}) {
    const db = this.open();
    const scope = options.scope ?? (options.sessionId ? 'session' : 'project');
    if (!['session', 'project', 'all'].includes(scope)) throw new TypeError(`Unknown purge scope: ${scope}`);
    if (scope === 'session' && (typeof options.sessionId !== 'string' || options.sessionId.length === 0)) {
      throw new TypeError("purge: scope 'session' requires sessionId");
    }
    if (scope !== 'session' && options.sessionId !== undefined) {
      throw new TypeError('purge: sessionId cannot be combined with project/all scope');
    }

    const sessionId = scope === 'session' ? options.sessionId : undefined;
    const before = Number(db.prepare(
      sessionId === undefined
        ? 'SELECT COUNT(*) AS lines FROM entries'
        : 'SELECT COUNT(*) AS lines FROM entries WHERE session = ?'
    ).get(...(sessionId === undefined ? [] : [sessionId])).lines ?? 0);

    db.exec('BEGIN');
    try {
      if (sessionId === undefined) {
        db.exec('DELETE FROM fts; DELETE FROM fts_trigram; DELETE FROM entries; DELETE FROM vocabulary');
      } else {
        db.prepare('DELETE FROM fts WHERE entry_id IN (SELECT id FROM entries WHERE session = ?)').run(sessionId);
        db.prepare('DELETE FROM fts_trigram WHERE entry_id IN (SELECT id FROM entries WHERE session = ?)').run(sessionId);
        db.prepare('DELETE FROM entries WHERE session = ?').run(sessionId);
        if (before > 0) rebuildVocabulary(db);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    if (sessionId === undefined) db.exec('VACUUM');
    this.counters.purged += 1;
    return { removed: before, scope: sessionId === undefined ? 'project' : 'session', sessionId };
  }

  /** Explicit convenience form for storage callers. */
  purgeSession(sessionId) {
    return this.purge({ scope: 'session', sessionId });
  }

  /** Integrity check for `ctx_doctor`. */
  verify() {
    const db = this.open();
    const result = db.prepare('PRAGMA integrity_check').get();
    const value = result?.integrity_check ?? 'unknown';
    return { ok: value === 'ok', detail: String(value) };
  }
}

export { sqliteReady };

/** Resolve existing paths and fold case on Windows before hashing/opening. */
function canonicalWorkspacePath(workspace) {
  let canonical = resolve(workspace);
  try { canonical = realpathSync.native(canonical); } catch { /* lexical path is the fallback */ }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

function canonicalDatabasePath(path) {
  if (path === ':memory:' || String(path).startsWith('file:')) return path;
  let canonical = resolve(path);
  try {
    canonical = realpathSync.native(canonical);
  } catch {
    try { canonical = join(realpathSync.native(dirname(canonical)), canonical.split(/[\\/]/).pop()); } catch { /* parent may not exist yet */ }
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

function pathIdentity(path) {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function inferLegacyPaths(path) {
  return [];
}

/** Create the two derived indexes used by the search fusion pipeline. */
function createSearchTables(db) {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
      text, source UNINDEXED, entry_id UNINDEXED,
      tokenize = 'porter unicode61 remove_diacritics 2'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_trigram USING fts5(
      text, source UNINDEXED, entry_id UNINDEXED,
      tokenize = 'trigram'
    );
  `);
}

/** Rebuild derived FTS/vocabulary data without deleting source entries. */
function rebuildSearchData(db) {
  const insertPorter = db.prepare('INSERT INTO fts (text, source, entry_id) VALUES (?, ?, ?)');
  const insertTrigram = db.prepare('INSERT INTO fts_trigram (text, source, entry_id) VALUES (?, ?, ?)');
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM fts; DELETE FROM fts_trigram');
    for (const row of db.prepare('SELECT id, source, text FROM entries ORDER BY id').iterate()) {
      insertPorter.run(row.text, row.source, row.id);
      insertTrigram.run(row.text, row.source, row.id);
    }
    rebuildVocabulary(db);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Rebuild the global typo-correction vocabulary after rows are deleted. */
function rebuildVocabulary(db) {
  db.exec('DELETE FROM vocabulary');
  const insertWord = db.prepare('INSERT OR IGNORE INTO vocabulary (word) VALUES (?)');
  for (const row of db.prepare('SELECT text FROM entries').iterate()) {
    for (const word of vocabularyWords(row.text)) insertWord.run(word);
  }
}

/** Extract distinct normalized terms for incremental vocabulary maintenance. */
function vocabularyWords(text) {
  return new Set(String(text).toLowerCase().match(/[\p{L}\p{N}_]{3,64}/gu) ?? []);
}

/** Split one physical line into lossless overlapping windows. */
function splitLongLine(line) {
  if (line.length <= MAX_CHUNK_CHARS) return [line];
  const chunks = [];
  let start = 0;
  while (start < line.length) {
    let end = Math.min(line.length, start + MAX_CHUNK_CHARS);
    if (end < line.length && isHighSurrogate(line.charCodeAt(end - 1)) && isLowSurrogate(line.charCodeAt(end))) end -= 1;
    chunks.push(line.slice(start, end));
    if (end >= line.length) break;
    let next = Math.max(start + 1, end - CHUNK_OVERLAP_CHARS);
    if (next > 0 && isLowSurrogate(line.charCodeAt(next)) && isHighSurrogate(line.charCodeAt(next - 1))) next -= 1;
    start = next;
  }
  return chunks;
}

function isHighSurrogate(code) { return code >= 0xD800 && code <= 0xDBFF; }
function isLowSurrogate(code) { return code >= 0xDC00 && code <= 0xDFFF; }

/** Map one SQLite row into the shape the tools render. */
function toRow(row) {
  return {
    id: Number(row.id),
    source: String(row.source),
    kind: String(row.kind),
    seq: Number(row.seq),
    line: Number(row.line),
    createdAt: Number(row.created_at),
    text: String(row.text),
    snippet: row.snip === undefined || row.snip === null ? String(row.text) : String(row.snip),
    isError: Number(row.is_error) === 1
  };
}

/** A bounded snippet centered on the first exact or stem-equivalent term. */
function extractSearchSnippet(text, terms, maxChars = 320) {
  const value = String(text);
  if (value.length <= maxChars) return value;
  const positions = terms.flatMap((term) => findTermPositions(value, term));
  const position = positions.length > 0 ? Math.min(...positions) : 0;
  const start = Math.max(0, Math.min(position - 120, value.length - maxChars));
  const end = Math.min(value.length, start + maxChars);
  return `${start > 0 ? '… ' : ''}${value.slice(start, end)}${end < value.length ? ' …' : ''}`;
}

/** Rank chunks containing all query terms higher when those terms are close. */
function proximityBoost(text, terms) {
  if (terms.length < 2) return 0;
  const groups = terms.map((term, index) => findTermPositions(text, term).map((position) => ({ position, index })));
  if (groups.some((group) => group.length === 0)) return 0;
  const points = groups.flat().sort((a, b) => a.position - b.position || a.index - b.index);
  const counts = new Array(terms.length).fill(0);
  let covered = 0;
  let left = 0;
  let minSpan = Infinity;
  for (let right = 0; right < points.length; right += 1) {
    if (counts[points[right].index]++ === 0) covered += 1;
    while (covered === terms.length) {
      minSpan = Math.min(minSpan, points[right].position - points[left].position);
      if (--counts[points[left].index] === 0) covered -= 1;
      left += 1;
    }
  }
  return Number.isFinite(minSpan) ? 1 / (1 + minSpan) : 0;
}

function findTermPositions(text, term) {
  const lower = String(text).toLowerCase();
  const needle = String(term).toLowerCase();
  const positions = [];
  let at = lower.indexOf(needle);
  while (at >= 0) {
    positions.push(at);
    at = lower.indexOf(needle, at + Math.max(1, needle.length));
  }
  if (positions.length > 0) return positions;

  const stem = porterLikeStem(needle);
  const matcher = /[\p{L}\p{N}_]+/gu;
  let match;
  while ((match = matcher.exec(lower)) !== null) {
    if (porterLikeStem(match[0]) === stem) positions.push(match.index);
  }
  return positions;
}

/** A small scorer-only stemmer; FTS5's Porter tokenizer performs retrieval. */
function porterLikeStem(word) {
  let stem = word.toLowerCase();
  if (stem.length > 5 && stem.endsWith('ing')) stem = stem.slice(0, -3);
  else if (stem.length > 4 && stem.endsWith('ied')) stem = `${stem.slice(0, -3)}i`;
  else if (stem.length > 4 && stem.endsWith('ed')) stem = stem.slice(0, -2);
  else if (stem.length > 4 && stem.endsWith('es')) stem = stem.slice(0, -2);
  else if (stem.length > 3 && stem.endsWith('s')) stem = stem.slice(0, -1);
  if (stem.length > 4 && stem.endsWith('e')) stem = stem.slice(0, -1);
  return stem;
}

function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      current[column] = a[row - 1] === b[column - 1]
        ? previous[column - 1]
        : 1 + Math.min(previous[column], current[column - 1], previous[column - 1]);
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * Escape a literal value for a SQL `LIKE` pattern.
 *
 * The backslash is replaced first, so an escape added here cannot be consumed
 * by one the caller wrote — `a\%b` must match a literal backslash followed by a
 * literal percent sign, not become a wildcard.
 *
 * @param value - the literal text to match.
 * @returns the pattern-safe form, without the surrounding wildcards.
 */
function escapeLike(value) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * Whether one indexed line looks like a line of source code.
 *
 * Deliberately small: a real parse per line would cost far more than the filter
 * is worth. A line is code when it carries a brace or an arrow function, ends
 * in a statement semicolon, or is indented and carries an operator — the shape
 * of a continuation or a nested statement. A sentence can satisfy the last rule
 * (`  total: 3 items`), so the split is approximate; a misclassification costs
 * one filtered line, never a wrong answer, which is exactly the trade upstream
 * makes with a coarse content type.
 *
 * @param line - one indexed line.
 * @returns true when the line looks like code.
 */
export function looksLikeCode(line) {
  const text = String(line ?? '');
  if (/[{}]|=>/.test(text)) return true;
  if (/;\s*$/.test(text)) return true;
  return /^\s{2,}\S/.test(text) && /[=+\-*/<>:]/.test(text);
}

/** Whether SQLite reported a MATCH parser/tokenizer error for user input. */
function isFtsQueryError(error) {
  const message = String(error?.message ?? error);
  return /fts5:\s*(?:syntax error|malformed|unterminated|parse error|tokenizer)/i.test(message)
    || /malformed\s+MATCH\s+expression/i.test(message);
}

/**
 * Words that carry no retrieval signal, so BM25 should not rank on them.
 *
 * Upstream's list, verbatim (`src/store.ts:51-…`). Dropping them is what makes a
 * natural-language question behave like a search rather than a phrase match.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
  'her', 'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his',
  'how', 'its', 'may', 'new', 'now', 'old', 'see', 'two', 'who', 'did',
  'does', 'let', 'put', 'say', 'she', 'too', 'use', 'that', 'this', 'with',
  'from', 'what', 'when', 'where', 'which', 'would', 'there', 'their',
  'them', 'then', 'than', 'into', 'only', 'also', 'been', 'have', 'were',
  'will', 'your', 'about', 'after', 'before', 'being', 'could', 'every'
]);

/**
 * FTS5 operators a user query must never be allowed to inject as syntax.
 *
 * A query is data, not a query language: `AND`, `OR`, `NOT`, `NEAR`, and `*` are
 * stripped or quoted so a search for the literal word `not` cannot change the
 * shape of the expression.
 */
const FTS_OPERATORS = new Set(['AND', 'OR', 'NOT', 'NEAR']);

/**
 * Turn a user query into an FTS5 MATCH expression, upstream's way.
 *
 * Upstream sanitises the query and ORs the MEANINGFUL terms
 * (`src/store.ts:90-110`, called with `"OR"` at `:1254`): a six-word question is a
 * set of candidates, and BM25 ranks the documents that match more of them first.
 * The port ANDed every term, so a question whose words never appear in one line
 * returned nothing at all — which is precisely what a natural question looks like.
 *
 * Stopwords are dropped to improve ranking, but only when something survives:
 * a query that is nothing but stopwords falls back to the unfiltered terms rather
 * than becoming an empty search.
 *
 * @param query - the raw query text.
 * @param mode - `OR` (upstream's default for search) or `AND` for exact matching.
 * @returns the MATCH expression, or `undefined` when no term survives.
 */
export function toMatchExpression(query, mode = 'OR') {
  const terms = queryTerms(query);
  if (terms.length === 0) return undefined;
  return matchExpression(terms, mode);
}

function queryTerms(query) {
  const seen = new Set();
  const words = String(query ?? '')
    .replace(/['"(){}[\]*:^~]/g, ' ')
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0 && !FTS_OPERATORS.has(term.toUpperCase()))
    .filter((term) => {
      const key = term.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const meaningful = words.filter((word) => !STOPWORDS.has(word.toLowerCase()));
  return meaningful.length > 0 ? meaningful : words;
}

function matchExpression(terms, mode = 'OR') {
  const joiner = mode === 'AND' ? ' AND ' : ' OR ';
  return terms.map((term) => `"${term.replaceAll('"', '')}"`).join(joiner);
}
