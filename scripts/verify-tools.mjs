/**
 * INVOKE the context-mode tools and validate their canonical output.
 *
 * The harness rejects a tool result that is not lossless JSON — `undefined`
 * nested anywhere, a class instance, a non-finite number, a symbol — with
 * "returned invalid output: value is not lossless JSON". A tool can execute
 * perfectly and still be unusable because of that, and only invoking the body
 * catches it.
 *
 * Run:  node scripts/verify-tools.mjs
 *
 * @module dsh-context-kit/scripts/verify-tools
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const kitRoot = join(here, '..');

const { schemaViolations } = await import(pathToFileURL(join(here, 'schema-check.mjs')).href);

const { Context } = await import('@deepseek-ai/cordis');

const workspace = mkdtempSync(join(tmpdir(), 'ctx-tools-ws-'));
const dbPath = join(mkdtempSync(join(tmpdir(), 'ctx-tools-db-')), 'knowledge.db');
writeFileSync(join(workspace, 'sample.txt'), 'alpha\nbeta\ngamma\n', 'utf8');

const registered = new Map();
const root = new Context();
root.provide('tools', { register: (definition) => { registered.set(definition.name, definition); return () => {}; } });

const contextMode = await import(pathToFileURL(join(kitRoot, 'lib', 'context-mode.js')).href);
root.plugin(contextMode, { knowledgeBasePath: dbPath, timeoutMs: 60000 });
await new Promise((resolve) => setTimeout(resolve, 150));

// Start from an empty index: the knowledge base now REPLACES a source on
// re-index (`store.ts:1049-1052`), but labels from an earlier ON-DISK database
// would still answer searches, so a stale entry would look like a failure of the
// thing being tested. Purging also exercises the purge path.
{
  const purge = await registered.get('ctx_purge').execute({ confirm: true }, { callId: 'call-purge-setup' });
  if (purge.removed > 0) console.log(`[--]   cleared ${purge.removed} stale indexed line(s) before the run`);
}

/** One invocation context shaped like the harness's `ToolRunContext`. */
const execFor = (callId) => ({
  callId,
  rootCallId: callId,
  name: 'test',
  token: Symbol('token'),
  arguments: {},
  signal: new AbortController().signal,
  agent: { id: 'session-verify', session: { header: { cwd: workspace }, id: 'session-verify' } },
  deferContext: () => {},
  concludeTurn: () => {}
});

/**
 * Walk a value the way the harness's lossless-JSON check does.
 * @param value - candidate value.
 * @param path - dotted path for the diagnostic.
 * @returns one line per violation.
 */
function jsonViolations(value, path = 'value') {
  if (value === undefined) return [`${path} is undefined`];
  if (value === null) return [];
  const type = typeof value;
  if (type === 'function') return [`${path} is a function`];
  if (type === 'symbol') return [`${path} is a symbol`];
  if (type === 'bigint') return [`${path} is a bigint`];
  if (type === 'number') {
    if (!Number.isFinite(value)) return [`${path} is not finite (${value})`];
    if (Object.is(value, -0)) return [`${path} is negative zero`];
    return [];
  }
  if (type === 'string' || type === 'boolean') return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => jsonViolations(item, `${path}[${index}]`));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return [`${path} is a ${value?.constructor?.name ?? 'class instance'}, not a plain object`];
  }
  return Object.entries(value).flatMap(([key, item]) => jsonViolations(item, `${path}.${key}`));
}

const failures = [];
/** Canonical values captured by {@link invoke}, for the output-contract check. */
const returns = new Map();

/**
 * Invoke one tool and validate its canonical value.
 * @param name - registered tool name.
 * @param args - tool arguments.
 */
async function invoke(name, args) {
  const definition = registered.get(name);
  if (definition === undefined) {
    failures.push(`${name}: not registered`);
    console.log(`[FAIL] ${name}: not registered`);
    return undefined;
  }
  let value;
  try {
    value = await definition.execute(args, execFor(`call-${name}`));
  } catch (error) {
    failures.push(`${name}: threw ${error.message}`);
    console.log(`[FAIL] ${name} threw: ${error.message}`);
    return undefined;
  }
  returns.set(name, value);
  const violations = jsonViolations(value);
  if (violations.length > 0) {
    failures.push(`${name}: ${violations.join('; ')}`);
    console.log(`[FAIL] ${name}: ${violations.length} non-JSON value(s)`);
    for (const violation of violations.slice(0, 8)) console.log(`        ${violation}`);
    return value;
  }
  // Lossless JSON is necessary but NOT sufficient: the harness also validates
  // the value against `output.schema`, and one absent required property turns
  // the tool's own answer into `returned invalid output: missing required
  // property "value.…"`. Checking here means the success path of every invoked
  // tool is schema-checked, and it is checked for the tools' OWN schema rather
  // than for a hand-written list of fields.
  const schemaBad = schemaViolations(definition.output?.schema, value);
  if (schemaBad.length > 0) {
    failures.push(`${name}: ${schemaBad.join('; ')}`);
    console.log(`[FAIL] ${name}: ${schemaBad.length} schema violation(s)`);
    for (const violation of schemaBad.slice(0, 8)) console.log(`        ${violation}`);
  }
  console.log(`[ok]   ${name}: canonical output is lossless JSON`);
  return value;
}

console.log('--- invocation and JSON-safety ---');
const executed = await invoke('ctx_execute', { language: 'javascript', code: 'console.log("js ok")', source: 'tooltest-js' });
await invoke('ctx_execute', { language: 'python', code: 'print("py ok")', source: 'tooltest-py' });
await invoke('ctx_execute', { language: 'shell', code: 'Write-Output "sh ok"', source: 'tooltest-sh' });
await invoke('ctx_execute_file', { path: join(workspace, 'sample.txt'), language: 'javascript', code: 'const fs = await import("node:fs"); console.log(fs.readFileSync(process.argv[2], "utf8").trim().split("\\n").length);', source: 'tooltest-filearg' });
await invoke('ctx_index', { source: 'idx', text: 'needle in a haystack' });
await invoke('ctx_search', { queries: ['needle'] });
// `queries` is REQUIRED by the tool, as it is upstream: the batch answers its own
// questions in the same round trip, and a caller that omits them pays a second
// call for output it already has.
const batchValue = await invoke('ctx_batch_execute', {
  commands: [{ label: 'echo', command: process.platform === 'win32' ? 'Write-Output batch-ok' : 'echo batch-ok' }],
  queries: ['batch-ok'],
  source: 'tooltest-batch'
});
if (batchValue !== undefined) {
  const rendered = batchValue.rendered ?? '';
  const answered = /## batch-ok/.test(rendered);
  const inventoried = /## Commands/.test(rendered);
  const scoped = /Results are scoped to this batch only/.test(rendered);
  if (answered && inventoried && scoped) {
    console.log(`[ok]   ctx_batch_execute answers its own queries in one round trip (${batchValue.queriesAnswered} answered)`);
  } else {
    failures.push(`ctx_batch_execute rendered without a full answer (answered=${answered} inventory=${inventoried} tip=${scoped})`);
    console.log(`[FAIL] ctx_batch_execute did not answer its own queries (answered=${answered} inventory=${inventoried} tip=${scoped})`);
  }
}
await invoke('ctx_stats', {});
await invoke('ctx_doctor', {});
await invoke('ctx_insight', {});

// `ctx_purge` without confirmation must cancel without changing the index.
{
  const definition = registered.get('ctx_purge');
  const before = registered.get('ctx_stats') === undefined
    ? undefined
    : await registered.get('ctx_stats').execute({}, execFor('call-purge-before'));
  const cancelled = await definition.execute({ confirm: false }, execFor('call-purge'));
  const after = registered.get('ctx_stats') === undefined
    ? undefined
    : await registered.get('ctx_stats').execute({}, execFor('call-purge-after'));
  if (/cancel/i.test(cancelled?.rendered ?? '') && before?.lines === after?.lines) {
    console.log('[ok]   ctx_purge: cancels an unconfirmed wipe without changing the index');
  } else {
    failures.push('ctx_purge: unconfirmed cancellation changed the index or returned no cancellation');
    console.log('[FAIL] ctx_purge: unconfirmed cancellation changed the index or returned no cancellation');
  }
}

console.log('\n--- rendering ---');
if (executed !== undefined && registered.has('ctx_execute')) {
  const rendered = registered.get('ctx_execute').output.render({ language: 'javascript', code: 'x' }, executed);
  const text = rendered.map((block) => block.text).join('');
  console.log(text.slice(0, 400));
  console.log(`[ok]   ctx_execute renders ${rendered.length} block(s)`);
}

console.log('\n--- output contract (declared fields must be present) ---');
{
  // A value schema expresses requiredness by PRESENCE (and, when the spec says
  // `required: true`, by compiling that into the JSON Schema `required` list).
  // What matters for a caller is therefore: every declared field is actually
  // returned, and nothing undeclared appears beside it — the harness validates
  // the value against this schema, so a gap here becomes a rejected result.
  const problems = [];
  for (const [name, definition] of registered) {
    const spec = definition.output.schema;
    if (spec.type !== 'object') continue;
    const declared = Object.keys(spec.properties ?? {});
    const declaredRequired = declared.filter((key) => spec.properties[key].required === true);
    const seen = returns.get(name);
    if (seen === undefined) {
      console.log(`[--]   ${name}: not invoked here (${declared.length} declared field(s))`);
      continue;
    }
    const absent = declared.filter((key) => !(key in seen));
    const extra = Object.keys(seen).filter((key) => !declared.includes(key));
    if (absent.length === 0 && extra.length === 0) {
      console.log(`[ok]   ${name}: all ${declared.length} declared field(s) present (${declaredRequired.length} marked required), no extras`);
      continue;
    }
    const detail = [
      absent.length > 0 ? `absent ${absent.join(', ')}` : '',
      extra.length > 0 ? `undeclared ${extra.join(', ')}` : ''
    ].filter((part) => part.length > 0).join('; ');
    problems.push(`${name}: ${detail}`);
    console.log(`[FAIL] ${name}: ${detail}`);
  }
  failures.push(...problems);
}

console.log('\n--- regressions: encoding, timeout, full indexing ---');
{
  // Cyrillic and an emoji through all three runtimes. Python encoded stdout as
  // the ANSI code page on a non-UTF-8 system locale, and Windows PowerShell 5.1
  // read a BOM-less .ps1 as ANSI — both turned this into mojibake or a parse
  // error. The sandbox now forces UTF-8 mode and writes a BOM.
  const sample = 'Привет, мир! Ёж 🎯';
  for (const [language, code] of [
    ['javascript', `console.log(${JSON.stringify(sample)})`],
    ['python', `print(${JSON.stringify(sample)})`],
    ['shell', `Write-Output ${JSON.stringify(sample)}`]
  ]) {
    const value = await invoke('ctx_execute', { language, code, source: `verify-utf8-${language}` });
    const rendered = value?.rendered ?? '';
    if (rendered.includes(sample)) {
      console.log(`[ok]   ${language}: non-ASCII survives the round trip`);
    } else {
      failures.push(`${language}: non-ASCII mangled — got ${JSON.stringify(rendered.slice(0, 120))}`);
      console.log(`[FAIL] ${language}: non-ASCII mangled — got ${JSON.stringify(rendered.slice(0, 120))}`);
    }
  }

  // A killed program must be REPORTED as killed. It used to look like a short
  // successful run: no timeout notice, no exit code, nothing.
  const killed = await invoke('ctx_execute', {
    language: 'javascript',
    code: 'setTimeout(() => {}, 60000)',
    timeout_ms: 1500,
    source: 'verify-timeout'
  });
  if (killed?.timedOut === true && /TIMED OUT/.test(killed.rendered ?? '')) {
    console.log('[ok]   a timeout is reported in the canonical value and the rendered text');
  } else {
    failures.push(`timeout not reported (timedOut=${String(killed?.timedOut)})`);
    console.log(`[FAIL] timeout not reported (timedOut=${String(killed?.timedOut)})`);
  }

  // The index must hold the WHOLE capture. A run this size no longer needs
  // bounding at all: upstream returns stdout in full below
  // `LARGE_OUTPUT_THRESHOLD = 102_400` bytes (`src/server.ts:1980`), and this port
  // now uses the same threshold as its single output budget — so the conversation
  // sees all 500 lines AND the index holds all 500.
  const lineCount = 500;
  const big = await invoke('ctx_execute', {
    language: 'javascript',
    code: `for (let i = 1; i <= ${lineCount}; i += 1) console.log("line " + i + " of the run");`,
    source: 'verify-fullindex',
    timeout_ms: 60000
  });
  const indexedLines = big?.indexedLines ?? 0;
  if (indexedLines === lineCount) {
    console.log(`[ok]   full capture indexed (${indexedLines}/${lineCount} lines)`);
  } else {
    failures.push(`index covered ${indexedLines}/${lineCount} lines`);
    console.log(`[FAIL] index covered ${indexedLines}/${lineCount} lines`);
  }
  const rendered = big?.rendered ?? '';
  if (rendered.includes('line 480 of the run')) {
    console.log('[ok]   the last line reached the conversation (nothing was bounded below the threshold)');
  } else {
    failures.push('the tail of a 500-line run never reached the conversation');
    console.log('[FAIL] the tail of a 500-line run never reached the conversation');
  }
  const deep = await invoke('ctx_search', { queries: ['line 480 of the run'], source: 'verify-fullindex' });
  if ((deep?.hits ?? 0) > 0) {
    console.log('[ok]   the same line is searchable through the index');
  } else {
    failures.push('a line from the run is NOT searchable');
    console.log('[FAIL] a line from the run is NOT searchable');
  }
}

console.log('\n--- stats counters ---');
const statsTool = registered.get('ctx_stats');
const statsValue = await statsTool.execute({}, execFor('call-stats'));
console.log(statsValue.rendered);

rmSync(workspace, { recursive: true, force: true });
console.log(`\n${failures.length === 0 ? 'all tool invocations are JSON-safe' : `${failures.length} problem(s)`}`);
process.exit(failures.length === 0 ? 0 : 1);
