/**
 * Prove the kit loads, without needing dsh web or a chat session.
 *
 * This answers "does the harness accept it?" for the three things a unit test
 * cannot: that the active profile's rows resolve to real files, that each plugin's
 * configuration passes the harness's own schema validation, and that the DCP
 * engine really is a `ctx.compaction` implementation rather than a second
 * competing backend.
 *
 * Run:  node scripts/verify-load.mjs
 * Exit: 0 when every check passes, 1 with a report otherwise.
 *
 * @module dsh-context-kit/scripts/verify-load
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const kitRoot = join(here, '..');
const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh');

const checks = [];
const record = (name, ok, detail) => checks.push({ name, ok, detail: String(detail ?? '') });

/* 1. the preset and independent profile rows are present ------------------- */

const presetPath = join(dshHome, '.agent-presets', 'context-kit', 'agent.cordis.yml');
if (!existsSync(presetPath)) {
  record('preset present', false, `missing ${presetPath}`);
} else {
  record('preset present', true, presetPath);
  const yaml = readFileSync(presetPath, 'utf8');
  record('preset keeps native compaction', /id:\s*compaction-basic/.test(yaml), 'DCP is an independent add-on, not the native pressure backend');
}

const profilePatch = join(dshHome, 'profiles', 'web', 'cordis.patch.yml');
if (!existsSync(profilePatch)) {
  record('independent plugin profile patch present', false, `missing ${profilePatch}`);
} else {
  const yaml = readFileSync(profilePatch, 'utf8');
  const rows = [...yaml.matchAll(/name:\s*([^\r\n]+)/g)]
    .map((match) => match[1].trim().replace(/^['"]|['"]$/g, ''))
    .filter((name) => /dsh-context-kit\/lib\/(?:dcp-plugin|context-mode-plugin|editor-plugin)\.js$/i.test(name));
  record('profile names all three independent kit plugins', rows.length === 3, rows.join(', '));
  for (const file of rows) record(`row resolves: ${file.split('/').pop()}`, existsSync(file), file);
}

/* 2. both modules import and their configuration validates ----------------- */

let dcp;
let contextMode;
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

if (dcp !== undefined) {
  try {
    const resolved = dcp.Config({});
    record(
      'dcp config validates',
      resolved.enabled === true && resolved.strategies.purgeErrors.turns === 4,
      JSON.stringify(resolved.strategies)
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
      // `maxOutputChars` is upstream's own threshold, `LARGE_OUTPUT_THRESHOLD`
      // (`src/server.ts:1980`), and it is the ONE output budget — the truncation
      // notice quotes it and nothing is bounded below it.
      resolved.routingGuard === true && resolved.maxOutputChars === 102400,
      JSON.stringify({ routingGuard: resolved.routingGuard, maxOutputChars: resolved.maxOutputChars })
    );
  } catch (error) {
    record('context-mode config validates', false, error.message);
  }
}

/* 3. the harness packages resolve through the junction --------------------- */

try {
  const tools = await import('@deepseek-ai/dsh-tools');
  record('harness tool API reachable', typeof tools.defineTool === 'function', 'via plugins/node_modules junction');
} catch (error) {
  record('harness tool API reachable', false, error.message);
}

try {
  const compaction = await import('@deepseek-ai/dsh-compaction');
  const isEngine = dcp !== undefined && Object.prototype.isPrototypeOf.call(compaction.CompactionEngine, dcp.DcpCompactionEngine);
  record(
    'DcpCompactionEngine extends CompactionEngine',
    isEngine,
    isEngine
      ? 'single-provider rule satisfied by subclassing the shipped backend'
      : 'the engine does not inherit the compaction contract'
  );
} catch (error) {
  record('DcpCompactionEngine extends CompactionEngine', false, error.message);
}

/* 4. sqlite and the knowledge base work here ------------------------------- */

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

/* 5. the sandbox runs all three languages ---------------------------------- */

try {
  const { runProgram } = await import(pathToFileURL(join(kitRoot, 'lib', 'sandbox.js')).href);
  const tmpDir = join(dshHome, 'context-kit', 'tmp');
  const base = { cwd: kitRoot, tmpDir, timeoutMs: 30000, liveCapChars: 65536, headChars: 500, tailChars: 200 };
  for (const [language, code] of [
    ['javascript', 'console.log("js-ok")'],
    ['python', 'print("py-ok")'],
    ['shell', process.platform === 'win32' ? 'Write-Output "sh-ok"' : 'echo sh-ok']
  ]) {
    const run = await runProgram({ ...base, language, code });
    record(`sandbox ${language}`, run.exitCode === 0 && /ok/.test(run.stdout), run.stdout.trim() || run.spawnError || `exit ${run.exitCode}`);
  }
} catch (error) {
  record('sandbox available', false, error.message);
}

/* report ------------------------------------------------------------------ */

const failed = checks.filter((check) => !check.ok);
for (const check of checks) console.log(`${check.ok ? '[ok]  ' : '[FAIL]'} ${check.name}: ${check.detail}`);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
