/**
 * Prove the canonical checkout can load without touching a DSH profile.
 *
 * Run: node scripts/verify-load.mjs
 * Exit: 0 when every check passes, 1 with a report otherwise.
 *
 * @module dsh-context-kit/scripts/verify-load
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const kitRoot = join(here, '..');
const scratchRoot = mkdtempSync(join(tmpdir(), 'dsh-context-kit-verify-'));
const checks = [];
const record = (name, ok, detail) => checks.push({ name, ok, detail: String(detail ?? '') });

let aggregate;
let dcp;
let contextMode;

try {
  aggregate = await import(pathToFileURL(join(kitRoot, 'lib', 'index.js')).href);
  record(
    'aggregate imports',
    typeof aggregate.apply === 'function' && aggregate.name === 'context-kit',
    Object.keys(aggregate).join(', '),
  );
} catch (error) {
  record('aggregate imports', false, error.message);
}

try {
  dcp = await import(pathToFileURL(join(kitRoot, 'lib', 'dcp.js')).href);
  record('dcp imports', typeof dcp.apply === 'function', Object.keys(dcp).join(', '));
} catch (error) {
  record('dcp imports', false, error.message);
}

try {
  contextMode = await import(pathToFileURL(join(kitRoot, 'lib', 'context-mode.js')).href);
  record('context-mode imports', typeof contextMode.apply === 'function', Object.keys(contextMode).join(', '));
} catch (error) {
  record('context-mode imports', false, error.message);
}

if (aggregate !== undefined) {
  try {
    const resolved = aggregate.Config({ dcp: {}, contextMode: {}, historyEditor: {} });
    const values = {
      dcp: resolved.dcp.get().enabled,
      contextMode: resolved.contextMode.get().enabled,
      historyEditor: resolved.historyEditor.get().enabled,
    };
    record(
      'aggregate config validates',
      values.dcp === true && values.contextMode === true && values.historyEditor === false,
      JSON.stringify(values),
    );
  } catch (error) {
    record('aggregate config validates', false, error.message);
  }
}

if (dcp !== undefined) {
  try {
    const resolved = dcp.Config({});
    record(
      'dcp config validates',
      resolved.enabled === true && resolved.strategies.purgeErrors.turns === 4,
      JSON.stringify(resolved.strategies),
    );
  } catch (error) {
    record('dcp config validates', false, error.message);
  }
}

if (contextMode !== undefined) {
  try {
    const resolved = contextMode.Config({});
    record(
      'context-mode config validates',
      resolved.routingGuard === true && resolved.maxOutputChars === 102400,
      JSON.stringify({ routingGuard: resolved.routingGuard, maxOutputChars: resolved.maxOutputChars }),
    );
  } catch (error) {
    record('context-mode config validates', false, error.message);
  }
}

try {
  const tools = await import('@deepseek-ai/dsh-tools');
  record('Harness tool API reachable', typeof tools.defineTool === 'function', 'resolved from the installed peer graph');
} catch (error) {
  record('Harness tool API reachable', false, error.message);
}

try {
  const compaction = await import('@deepseek-ai/dsh-compaction');
  const isEngine = dcp !== undefined && Object.prototype.isPrototypeOf.call(compaction.CompactionEngine, dcp.DcpCompactionEngine);
  record(
    'DcpCompactionEngine extends CompactionEngine',
    isEngine,
    isEngine ? 'single-provider contract satisfied' : 'the engine does not inherit the compaction contract',
  );
} catch (error) {
  record('DcpCompactionEngine extends CompactionEngine', false, error.message);
}

try {
  const module = await import(pathToFileURL(join(kitRoot, 'lib', 'knowledge-base.js')).href);
  const ready = await module.sqliteReady;
  record('node:sqlite available', ready, ready ? 'FTS5 knowledge base can open' : 'this Node build has no usable SQLite');
  if (ready) {
    const kb = new module.KnowledgeBase({ path: ':memory:', producer: 'verify-load', logger: console });
    kb.index({ source: 'verify', kind: 'note', text: 'load check line' });
    const hits = kb.search('load');
    record('knowledge base usable', hits.length === 1, `${hits.length} hit(s) for "load"`);
    kb.close();
  }
} catch (error) {
  record('knowledge base usable', false, error.message);
}

try {
  const { runProgram } = await import(pathToFileURL(join(kitRoot, 'lib', 'sandbox.js')).href);
  const base = {
    cwd: kitRoot,
    tmpDir: join(scratchRoot, 'sandbox'),
    timeoutMs: 30000,
    liveCapChars: 65536,
    headChars: 500,
    tailChars: 200,
  };
  for (const [language, code] of [
    ['javascript', 'console.log("js-ok")'],
    ['python', 'print("py-ok")'],
    ['shell', process.platform === 'win32' ? 'Write-Output "sh-ok"' : 'echo sh-ok'],
  ]) {
    const run = await runProgram({ ...base, language, code });
    record(`sandbox ${language}`, run.exitCode === 0 && /ok/.test(run.stdout), run.stdout.trim() || run.spawnError || `exit ${run.exitCode}`);
  }
} catch (error) {
  record('sandbox available', false, error.message);
} finally {
  rmSync(scratchRoot, { recursive: true, force: true });
}

const failed = checks.filter((check) => !check.ok);
for (const check of checks) console.log(`${check.ok ? '[ok]  ' : '[FAIL]'} ${check.name}: ${check.detail}`);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
