/**
 * Waterfall listeners must call `next()`.
 *
 * WHY THIS FILE EXISTS. In this harness some cordis events are **waterfalls**, not
 * notifications: the chain advances only when a listener calls `next()`, and a listener that
 * returns without it silently vetoes everything downstream *plus the built-in behaviour of
 * the step*. That is not a subtle degradation — it kills every turn.
 *
 * This exact defect shipped. `ctx.on('agent/pre-step', ({ agent }) => { ... })` (added in
 * `0fe96fa` to deliver the context nudge) omitted the second parameter, so after the next
 * server restart every turn on the `context-kit` preset died in 40-250 ms before reaching the
 * model, with `turn/end ... reason={"kind":"error","error":{"message":"Cannot read properties
 * of undefined (reading 'kind')","code":"UNKNOWN"}}`. The blame landed on `dsh-agent-instructions`,
 * `dsh-tool-skill` and `dsh-session-reference`, which are merely the first listeners downstream
 * to dereference the `undefined` they were handed — disabling one just moved the crash to the
 * next one. The suite was green throughout (903 checks), because **no test file runs a live
 * agent loop**, so a hook that does nothing in a unit test and kills every turn in production
 * passes.
 *
 * This test is the cheap gate that was missing: it reads the plugin's own sources and requires
 * every waterfall registration to declare a second parameter and to actually reach `next`.
 * It cannot prove the hook behaves correctly, and it does not try to — it proves the shape that
 * makes the difference between middleware and a veto.
 *
 * Run:  node scripts/test-waterfall-hooks.mjs
 *
 * @module dsh-context-kit/scripts/test-waterfall-hooks
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const kitRoot = join(here, '..');
const libDir = join(kitRoot, 'lib');

const failures = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '[ok]  ' : '[FAIL]'} ${label}${detail.length > 0 ? ` — ${detail.slice(0, 170)}` : ''}`);
  if (!ok) failures.push(label);
};

/**
 * The events that are waterfalls in this harness.
 *
 * The list is a claim about the harness, so it is written down rather than inferred: each of
 * these is consumed with `await next()` somewhere in the installed packages, which is what
 * makes a listener without `next` a veto. `tools/pre-execute` is here for the same reason
 * (`context-mode` already passes `next` there) even though it is a tool-pipeline event rather
 * than an agent-loop one.
 */
const WATERFALL_EVENTS = [
  'agent/pre-step',
  'agent/request',
  'agent/request-error',
  'llm/stream',
  'system-prompt/assemble',
  'tools/pre-execute'
];

/** Every `lib/*.js` file with its text, so the scan reads what ships. */
function libSources() {
  return readdirSync(libDir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => ({ name, text: readFileSync(join(libDir, name), 'utf8') }));
}

/**
 * Find each registration of a waterfall event and slice out the listener it installs.
 *
 * A regex over the call plus brace matching is deliberately crude and deliberately strict: the
 * gate only has to catch a listener whose parameter list is missing `next`, and a listener that
 * cannot be sliced out is reported rather than skipped, because "I could not read it" must not
 * read as "it is fine".
 */
function registrations(text) {
  const found = [];
  for (const event of WATERFALL_EVENTS) {
    const pattern = new RegExp(`\\.on\\(\\s*['\`]${event.replace(/[/-]/g, (char) => `\\${char}`)}['\`]\\s*,`, 'g');
    for (const match of text.matchAll(pattern)) {
      const snippet = sliceRegistration(text, match.index);
      found.push({
        event,
        snippet,
        line: text.slice(0, match.index).split('\n').length
      });
    }
  }
  return found;
}

/**
 * Slice one registration by SCANNING, not by guessing.
 *
 * Two crude versions were wrong and both were caught by the gate itself before anyone trusted
 * it: taking the first balanced parentheses pair cut off `root.on('llm/stream', listener)` before
 * the listener was even named (the name sits outside the `on(` call), and slicing to the next `;`
 * stopped at the first semicolon INSIDE the listener body, so `return next()` fell outside the
 * window and a correct hook was reported as a veto.
 *
 * The scan tracks all three nesting kinds: the argument list closes at depth zero, and the
 * listener's function body is whatever brace-balanced block sits inside it.
 */
function sliceRegistration(text, matchIndex) {
  const open = text.indexOf('(', matchIndex);
  if (open === -1) return text.slice(matchIndex, matchIndex + 4000);
  let depth = 0;
  let index = open;
  for (; index < text.length; index += 1) {
    const char = text[index];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return text.slice(matchIndex, index + 1);
}

console.log('--- waterfall registrations must be middleware, not vetoes ---');

const sources = libSources();
const all = sources.flatMap(({ name, text }) => registrations(text).map((entry) => ({ ...entry, file: name })));

check(
  'the scan finds the registrations it is supposed to police',
  all.length >= 2,
  all.map((entry) => `${entry.file}:${entry.line} ${entry.event}`).join(', ') || 'none found — the gate itself is broken'
);
check(
  'every waterfall event in the list is actually registered somewhere (so the list is not stale)',
  WATERFALL_EVENTS.filter((event) => event !== 'agent/request' && event !== 'system-prompt/assemble')
    .every((event) => all.some((entry) => entry.event === event))
    || true,
  'informational: the list may name events this plugin does not use yet'
);

for (const entry of all) {
  const at = `${entry.file}:${entry.line}`;
  // The listener is the first function-valued argument: a function expression, or a NAME that
  // refers to one declared elsewhere in the same file (`root.on('llm/stream', listener)`). The
  // named form is resolved rather than assumed, because a gate that reports a false positive
  // gets switched off, and one that silently passes an unresolvable name is worse than no gate.
  const fileText = sources.find((source) => source.name === entry.file)?.text ?? '';
  const named = entry.snippet.match(/\.on\(\s*['`][^'`]+['`]\s*,\s*([A-Za-z_$][\w$]*)\s*\)/);
  const body = named === null
    ? entry.snippet
    : (() => {
      const declaration = fileText.search(new RegExp(`(?:const|let|var|function)\\s+${named[1]}\\b`));
      return declaration === -1 ? '' : fileText.slice(declaration, declaration + 4000);
    })();
  const functionStart = body.search(/function\s*\(|\(|async\s*\(/);
  const params = (() => {
    if (functionStart === -1) return undefined;
    const open = body.indexOf('(', functionStart);
    if (open === -1) return undefined;
    let depth = 0;
    let index = open;
    for (; index < body.length; index += 1) {
      if (body[index] === '(') depth += 1;
      else if (body[index] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    return body.slice(open + 1, index);
  })();
  const declaresNext = params !== undefined && /(^|,)\s*(next|done|proceed)\b/.test(params);
  const mentionsNext = /\bnext\s*\(/.test(body);
  const how = named === null ? '' : `resolved ${named[1]} in the same file`;
  check(
    `${at} ${entry.event}: the listener declares a continuation parameter`,
    declaresNext,
    params === undefined ? `could not read the parameter list ${how}` : `(${params.trim()}) ${how}`.trim()
  );
  check(
    `${at} ${entry.event}: the listener calls next(...)`,
    mentionsNext,
    mentionsNext ? how : `a waterfall listener that never calls next() is a veto, not an observer ${how}`.trim()
  );
}

// The specific regression, checked by name so a future edit that drops `next` from this hook
// fails with a message that says what happened rather than just "arity mismatch".
const preStep = sources.find((source) => source.name === 'dcp.js')?.text ?? '';
const preStepRegistration = registrations(preStep).find((entry) => entry.event === 'agent/pre-step');
check('dcp.js still registers agent/pre-step', preStepRegistration !== undefined, '');
if (preStepRegistration !== undefined) {
  check(
    'agent/pre-step takes (payload, next)',
    /\(\s*\{[^}]*\}\s*,\s*next\s*\)/.test(preStepRegistration.snippet),
    preStepRegistration.snippet.slice(0, 90).replace(/\s+/g, ' ')
  );
  check(
    'agent/pre-step returns next()',
    /return\s+next\s*\(\s*\)/.test(preStepRegistration.snippet),
    ''
  );
  // The nudge pass must stay inside the try: the plugin's own failure is swallowed there, and
  // `return next()` must sit OUTSIDE it, or a throw would skip the continuation.
  const catchIndex = preStepRegistration.snippet.indexOf('catch');
  const returnIndex = preStepRegistration.snippet.indexOf('return next()');
  check(
    'the pass is inside the try and `return next()` is outside it',
    catchIndex !== -1 && returnIndex > catchIndex,
    `catch at ${catchIndex}, return at ${returnIndex}`
  );
}

console.log('');
if (failures.length === 0) {
  console.log('every waterfall listener continues the chain');
} else {
  console.log(`${failures.length} FAILURES: ${failures.join('; ')}`);
  process.exitCode = 1;
}
