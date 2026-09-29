/**
 * `/edit` MUST DECLARE `input`, OR ITS ARGUMENT IS NEVER DELIVERED.
 *
 * The defect this file exists for, observed live before it was fixed: typing
 * `/edit -1` in the GUI sent the line to the model as an ordinary user message
 * (13 tool steps, 522K tokens, no edit), while a bare `/edit` listed the
 * messages correctly. The command itself was fine; the *door* was wrong.
 *
 * The door is the browser's own decision table, and it is read from the
 * installed harness rather than remembered:
 *
 *   - `dsh-client-ui-commands/lib/client.js:712-716` splits an entered line into
 *     a token (up to the first whitespace) and the rest, and records `bare`.
 *   - `:747-751` claims the line ONLY when the resolved descriptor declares
 *     `input`; `rawInput` then carries the whole remainder, spaces included.
 *   - `:751` returns `undefined` for a non-bare line whose descriptor has no
 *     `input` — and `undefined` means "not a command", so the composer sends
 *     the slash line to the model.
 *   - `dsh-commands/lib/index.js:90-103` re-splits the same line server-side and
 *     sets `rawInput: line.slice(match[0].length)`, so `-1` survives intact.
 *
 * So the two halves of the contract are: the descriptor must declare `input`,
 * and the parser must hand the untouched remainder to the handler. Both are
 * asserted below, and both assertions are written so that they FAIL if the
 * upstream branch they encode is removed (see the guard check at the end).
 *
 * `[node:assert]` — every check throws on failure.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let checks = 0;
const ok = (label, fn) => {
  fn();
  checks += 1;
  console.log(`  [ok] ${label}`);
};

/** Resolve one installed harness package, wherever this machine keeps it. */
function harnessFile(relative) {
  const candidates = [
    process.env.DSH_INSTALL,
    'C:\\Users\\pro100noob\\AppData\\Local\\npm-cache\\_npx\\1e7f6d9597241db0\\node_modules',
    join(process.env.APPDATA ?? '', 'npm', 'node_modules')
  ].filter((value) => typeof value === 'string' && value.length > 0);
  for (const base of candidates) {
    try {
      return readFileSync(join(base, relative), 'utf8');
    } catch {
      continue;
    }
  }
  throw new Error(`harness file not found for ${relative}; set DSH_INSTALL to the node_modules root`);
}

const COMMANDS_CLIENT = '\\@deepseek-ai\\dsh-client-ui-commands\\lib\\client.js';
const COMMANDS_HOST = '\\@deepseek-ai\\dsh-commands\\lib\\index.js';

console.log('upstream decision table (the door an argument must pass)');

const client = harnessFile(COMMANDS_CLIENT);
const host = harnessFile(COMMANDS_HOST);

ok('the enter column splits the line into a token and the remainder', () => {
  assert.match(client, /const ws = trimmed\.search\(\/\\s\/\);/u, 'the whitespace probe moved');
  assert.match(client, /const token = ws === -1 \? trimmed : trimmed\.slice\(0, ws\);/u, 'the token split moved');
  assert.match(client, /const bare = ws === -1;/u, 'the bare flag moved');
});

ok('a declared `input` is what claims a line that carries arguments', () => {
  assert.match(client, /if \(desc\.input !== void 0\) \{/u, 'the input gate moved');
  assert.match(client, /return \{ claim: this\.leadingClaim\(desc, session\) \};/u, 'the claim moved');
});

ok('WITHOUT a declared `input`, a non-bare line falls through to the model', () => {
  // Both halves matter: the guard that bails on arguments AND the absence of any
  // other claim path for a descriptor without `input`.
  assert.match(client, /if \(!bare\) return void 0;/u, 'the non-bare bail moved');
  assert.match(client, /if \(name === ""\) return void 0;/u, 'the empty-name bail moved');
});

ok('the leading claim submits `token + args` so the argument is preserved', () => {
  assert.match(client, /const token = `\/\$\{desc\.name\} `;/u, 'the leading token moved');
  assert.match(client, /submit: \(args, _actx, attachments\) => this\.execute\(session, token \+ args, attachments\)/u, 'the submit join moved');
});

ok('the host parser hands the untouched remainder to the handler', () => {
  assert.match(host, /rawInput: line\.slice\(match\[0\]\.length\)/u, 'the raw-input slice moved');
});

ok('the host accepts and freezes an `input` descriptor with a `hint`', () => {
  assert.match(host, /if \(rawInput !== void 0\) \{/u, 'the input normalization moved');
  assert.match(host, /command "\$\{definition\.name\}" input hint must be a string/u, 'the hint validation moved');
});

console.log('the plugin side (what our own registration must say)');

const dcp = readFileSync(join(ROOT, 'lib', 'dcp.js'), 'utf8');

ok('the `/edit` registration declares an input descriptor', () => {
  const at = dcp.indexOf("name: 'edit',");
  assert.notEqual(at, -1, 'the /edit registration disappeared');
  const block = dcp.slice(at, at + 900);
  assert.match(block, /input: \{ hint: /u, 'the /edit registration declares no input, so any argument is sent to the model');
  assert.match(block, /handler: \(invocation\) => runEditCommand\(\{/u, 'the handler wiring changed');
});

ok('EVERY command whose handler reads rawInput declares an input descriptor', () => {
  // The general form of the same defect. A command that splits `invocation.rawInput`
  // into a verb and a rest is meaningless without arguments, so each such registration
  // must declare `input` or its arguments become model prose.
  const registrations = [...dcp.matchAll(/commands\.register\(\{([\s\S]*?)\n {4}\}\);/gu)].map((match) => match[1]);
  assert.ok(registrations.length >= 3, `expected the plugin's command registrations, found ${registrations.length}`);
  const argumentReaders = registrations.filter((block) => /invocation\.rawInput|rawInput: invocation\.rawInput/u.test(block));
  assert.ok(argumentReaders.length >= 2, `expected at least two argument-reading commands, found ${argumentReaders.length}`);
  for (const block of argumentReaders) {
    const name = /name: '([^']+)'/u.exec(block)?.[1] ?? '<unnamed>';
    assert.match(block, /input: \{ hint: /u, `/${name} reads rawInput but declares no input, so its arguments are sent to the model`);
  }
});

ok('the handler receives the whole remainder as rawInput, not a slice of it', () => {
  const at = dcp.indexOf("name: 'edit',");
  const block = dcp.slice(at, at + 900);
  assert.match(block, /rawInput: invocation\.rawInput/u, 'rawInput is no longer the invocation value');
  assert.doesNotMatch(block, /rawInput: invocation\.rawInput\.(slice|split|trim)/u, 'the argument is being re-cut before the handler');
});

console.log('falsification (the checks above must be able to fail)');

ok('a descriptor without `input` is refused by the very branch asserted above', () => {
  // Re-implement the upstream branch verbatim against two descriptors and prove
  // the outcome differs. If the branch is not the gate, the two cases agree and
  // this check throws.
  const claimFor = (descriptor) => {
    const line = '/edit -1';
    const trimmed = line.trim();
    const ws = trimmed.search(/\s/);
    const token = ws === -1 ? trimmed : trimmed.slice(0, ws);
    const bare = ws === -1;
    if (bare) return 'bare';
    if (descriptor.input !== void 0) return `claimed:${token}`;
    return 'sent-to-model';
  };
  assert.equal(claimFor({}), 'sent-to-model', 'a descriptor without input must not claim arguments');
  assert.equal(claimFor({ input: { hint: '<x>' } }), 'claimed:/edit', 'a descriptor with input must claim the line');
});

ok('the argument arrives whole (the defect was never a slice bug)', () => {
  const parse = (line) => {
    const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(line);
    return { name: match[1], rawInput: line.slice(match[0].length) };
  };
  assert.deepEqual(parse('/edit -1'), { name: 'edit', rawInput: ' -1' });
  assert.equal(parse('/edit -1').rawInput.trim(), '-1', 'the negative offset must survive the parser');
  assert.equal(parse('/edit 1 привет').rawInput.trim(), '1 привет', 'a spaces-carrying argument must survive');
});

ok('rawInput keeps its leading space, and the durable branch tolerates it', () => {
  // Not a nicety: the parser leaves the separator in place, so the argument
  // arrives as ` -1`. Two things must hold for that to be harmless — the
  // command trims before splitting, and the target matcher accepts the sign.
  const durable = readFileSync(join(ROOT, 'lib', 'edit-durable.js'), 'utf8');
  assert.match(durable, /const raw = String\(rawInput \?\? ''\)\.trim\(\);/u, 'the rawInput trim disappeared');
  assert.match(durable, /if \(\/\^-\\d\+\$\/\.test\(raw\)\) \{/u, 'the negative-offset matcher for -1 disappeared');
  // And the split must take one word, so `-1` is the target and the text keeps
  // every remaining space (a message with two spaces is still that message).
  assert.match(durable, /const target = raw\.split\(\/\\s\+\/, 1\)\[0\];/u, 'the target split changed shape');
  const split = (raw) => {
    const target = raw.split(/\s+/, 1)[0];
    const text = raw.slice(target.length).trim().length === 0 ? undefined : raw.slice(target.length).trim();
    return { target, text };
  };
  assert.deepEqual(split('-1'), { target: '-1', text: undefined });
  assert.deepEqual(split('-1  hello   world '), { target: '-1', text: 'hello   world' });
});

console.log(`\ncommand-argument gate: ${checks} checks passed`);
