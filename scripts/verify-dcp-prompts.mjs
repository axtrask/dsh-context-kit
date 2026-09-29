/**
 * Verify that every prompt the model reads equals upstream's, verbatim.
 *
 * This is the check that was missing. `verify-parity.mjs` compared config
 * DEFAULTS and tool shapes, so the port could satisfy it completely while telling
 * the model something entirely different: its own four-line policy instead of
 * upstream's `system.ts`, a three-paragraph tool description instead of
 * `compress-range.ts`, and one of three nudges with invented wording. Tool
 * behaviour cannot be 1:1 while the instructions that drive it are not.
 *
 * The comparison is textual and mechanical: extract the template literal from the
 * upstream TypeScript source and require the model-facing text to be
 * byte-identical to the port's constant.
 *
 * Run:  node scripts/verify-dcp-prompts.mjs
 *
 * @module dsh-context-kit/scripts/verify-dcp-prompts
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const kitRoot = join(here, '..');
const upstreamRoot = process.env.DCP_UPSTREAM ?? join(kitRoot, '..', '..', 'tes', 'upstream', 'opencode-dcp');

const failures = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '[ok]  ' : '[FAIL]'} ${label}${detail.length > 0 ? ` — ${detail.slice(0, 160)}` : ''}`);
  if (!ok) failures.push(label);
};

if (!existsSync(upstreamRoot)) {
  console.log(`[--]  upstream checkout not found at ${upstreamRoot}; set DCP_UPSTREAM to run this gate`);
  process.exit(0);
}

/**
 * Read one exported template literal out of an upstream TypeScript module.
 * @param relative - path below the upstream root.
 * @param exportName - the exported constant's name.
 * @returns the literal's text.
 */
function upstreamLiteral(relative, exportName) {
  const source = readFileSync(join(upstreamRoot, relative), 'utf8');
  const start = source.indexOf(`export const ${exportName} = \``);
  if (start === -1) throw new Error(`${exportName} not found in ${relative}`);
  const from = start + `export const ${exportName} = \``.length;
  let index = from;
  while (index < source.length) {
    if (source[index] === '\\') { index += 2; continue; }
    if (source[index] === '`') break;
    index += 1;
  }
  return source.slice(from, index);
}

/**
 * Normalize one extracted literal for comparison.
 *
 * Two things must be undone before a byte comparison means anything:
 *
 * - Line endings. The upstream checkout carries CRLF under Windows' default
 *   `core.autocrlf`, while this repository's files are LF. A raw comparison would
 *   report every prompt as divergent for a reason that is not a divergence.
 * - Escapes. The literal is extracted as SOURCE, so `\\`` and `\\$` are still two
 *   characters; the port's own file stores them the same way, so both sides get
 *   the same treatment.
 *
 * @param text - an extracted template-literal body.
 * @returns the text the module would actually export.
 */
const normalize = (text) =>
  text.replace(/\r\n/g, '\n').replace(/\\`/g, '`').replace(/\\\$/g, '$').replace(/\\\\/g, '\\').trim();

const prompts = await import(pathToFileURL(join(kitRoot, 'lib', 'dcp-prompts.js')).href);

console.log(`--- system prompt (lib/prompts/system.ts) ---`);
{
  const expected = normalize(upstreamLiteral('lib/prompts/system.ts', 'SYSTEM')).trim();
  const actual = prompts.SYSTEM.trim();
  const metadataLine = '`<dcp-message-id>` and `<dcp-system-reminder>` tags are environment-injected metadata. Do not output them.';
  check('SYSTEM keeps the metadata-discipline sentence', actual.includes(metadataLine));
  check(
    'SYSTEM matches upstream verbatim',
    expected === actual,
    expected === actual ? '' : `upstream ${expected.length} chars vs port ${actual.length} chars`
  );
  check('the criteria section survives', actual.includes('COMPRESS WHEN') && actual.includes('DO NOT COMPRESS IF'));
  check('the philosophy survives', actual.includes('THE PHILOSOPHY OF COMPRESS'));
  check('the closing responsibility line survives', actual.includes('It is of your responsibility to keep a sharp, high-quality context window'));
}

console.log('\n--- tool descriptions ---');
for (const [file, name, constant] of [
  ['lib/prompts/compress-range.ts', 'COMPRESS_RANGE', 'COMPRESS_RANGE'],
  ['lib/prompts/compress-message.ts', 'COMPRESS_MESSAGE', 'COMPRESS_MESSAGE']
]) {
  const upstream = normalize(upstreamLiteral(file, name)).trim();
  const port = prompts[constant].trim();
  check(
    `${constant} matches upstream verbatim`,
    upstream === port,
    upstream === port ? '' : `upstream ${upstream.length} chars vs port ${port.length} chars`
  );
  const cut = (text) => text.slice(text.indexOf('BATCHING'));
  check(
    `${constant} matches upstream from BATCHING onward`,
    cut(upstream) === cut(port),
    cut(upstream) === cut(port) ? '' : `upstream ${cut(upstream).length} chars vs port ${cut(port).length} chars`
  );
  const head = (text) => text.slice(0, text.search(/\n[A-Z][A-Z ]+\n/));
  const boundary = /^[A-Z][A-Z ]+$/m;
  const sectionsOf = (text) => text.split('\n').filter((line) => boundary.test(line));
  const upstreamSections = sectionsOf(upstream);
  const portSections = sectionsOf(port);
  // The boundary-ids section is the adapted one; the rest must survive by name.
  const adapted = 'MESSAGE IDS';
  const expectedSections = upstreamSections.filter((s) => s !== adapted);
  const missing = expectedSections.filter((s) => !portSections.includes(s));
  check(`${constant} keeps every upstream section`, missing.length === 0, missing.join(', '));
  check(`${constant} demands an exhaustive summary`, port.includes('EXHAUSTIVE'));
  check(`${constant} protects user intent`, port.includes('USER INTENT FIDELITY'));
  check(`${constant} demands leanness`, port.includes('Yet be LEAN'));
}
for (const [mode, name] of [['range', 'RANGE_FORMAT_EXTENSION'], ['message', 'MESSAGE_FORMAT_EXTENSION']]) {
  const expected = normalize(upstreamLiteral('lib/prompts/extensions/tool.ts', name)).trim();
  const actual = prompts.formatExtension(mode).trim();
  check(`${name} matches upstream verbatim`, expected === actual, expected === actual ? '' : `upstream ${expected.length} chars vs port ${actual.length} chars`);
}
{
  const range = prompts.COMPRESS_RANGE;
  check('range mode documents the (bN) placeholder discipline', range.includes('(bN)') && range.includes('RESERVED TOKENS'));
  check('range mode names the compressed-block header', range.includes('[Compressed conversation section]'));
  check('range mode states the preflight check', range.includes('Preflight check before finalizing'));
  check('range mode names upstream string boundary fields', range.includes('startId') && range.includes('endId') && range.includes('mNNNN'));
}

console.log('\n--- nudges ---');
for (const [file, name, constant] of [
  ['lib/prompts/turn-nudge.ts', 'TURN_NUDGE', 'TURN_NUDGE'],
  ['lib/prompts/iteration-nudge.ts', 'ITERATION_NUDGE', 'ITERATION_NUDGE'],
  ['lib/prompts/context-limit-nudge.ts', 'CONTEXT_LIMIT_NUDGE', 'CONTEXT_LIMIT_NUDGE']
]) {
  const expected = normalize(upstreamLiteral(file, name)).trim();
  const actual = prompts[constant].trim();
  check(`${constant} matches upstream verbatim`, expected === actual, expected === actual ? '' : `upstream ${expected.length} chars vs port ${actual.length} chars`);
  check(`${constant} is a dcp-system-reminder block`, actual.startsWith('<dcp-system-reminder>') && actual.endsWith('</dcp-system-reminder>'));
}
{
  // All three nudges must be reachable: upstream fires the turn nudge between the
  // thresholds, the iteration nudge on drift, and the critical one past the
  // ceiling. The port used to implement only the last of them.
  const values = [prompts.TURN_NUDGE, prompts.ITERATION_NUDGE, prompts.CONTEXT_LIMIT_NUDGE];
  check('all three nudges exist', new Set(values).size === 3);
  check('no nudge is the port\'s own text', !values.some((v) => /Consider compressing finished work/.test(v)));
}

console.log('\n--- system-prompt extensions ---');
{
  const manual = normalize(upstreamLiteral('lib/prompts/extensions/system.ts', 'MANUAL_MODE_SYSTEM_EXTENSION')).trim();
  check('MANUAL_MODE_SYSTEM_EXTENSION matches upstream verbatim', manual === prompts.MANUAL_MODE_SYSTEM_EXTENSION.trim());
  const subagent = normalize(upstreamLiteral('lib/prompts/extensions/system.ts', 'SUBAGENT_SYSTEM_EXTENSION')).trim();
  check('SUBAGENT_SYSTEM_EXTENSION matches upstream verbatim', subagent === prompts.SUBAGENT_SYSTEM_EXTENSION.trim());
  // `buildProtectedToolsExtension` is a function upstream, so its phrasing is
  // compared as wording rather than as one literal.
  const built = prompts.buildProtectedToolsExtension(['task', 'skill']);
  check('the protected-tools extension lists the tools', built.includes('`task`, `skill`'));
  check('it tells the model the environment retains their output', built.includes('the environment retains it independently'));
  check('an empty protected list produces no extension', prompts.buildProtectedToolsExtension([]) === '');
}

console.log('\n--- composition order (lib/prompts/index.ts:renderSystemPrompt) ---');
{
  const composed = prompts.renderSystemPrompt({
    protectedToolsExtension: prompts.buildProtectedToolsExtension(['task']),
    manual: true,
    subagent: true
  });
  const order = [
    composed.indexOf('You operate in a context-constrained environment'),
    composed.indexOf('The following tools are environment-managed'),
    composed.indexOf('Manual mode is enabled'),
    composed.indexOf('You are operating in a subagent environment')
  ];
  check('every part is present', order.every((at) => at !== -1), JSON.stringify(order));
  check('base first, then protected, manual, subagent', order.every((at, i) => i === 0 || at > order[i - 1]), JSON.stringify(order));
  check('blank-line runs are collapsed', !/\n\n\n/.test(composed));
  const plain = prompts.renderSystemPrompt({});
  check('with no extensions no reminder block is added', !plain.includes('dcp-system-reminder>\n'));
  check('and no extension text leaks in', !plain.includes('environment-managed') && !plain.includes('Manual mode is enabled'));
}

console.log('\n--- the port must actually USE them ---');
{
  const source = readFileSync(join(kitRoot, 'lib', 'dcp.js'), 'utf8');
  check('dcp.js no longer carries its own policy text', !source.includes('Context pruning is active for this session'));
  check('dcp.js registers the upstream system prompt', source.includes('renderSystemPrompt'));
  check('dcp.js builds the protected-tools reminder', source.includes('buildProtectedToolsExtension'));
  check('dcp.js uses the upstream turn nudge', source.includes('TURN_NUDGE'));
  check('dcp.js uses the upstream iteration nudge', source.includes('ITERATION_NUDGE'));
  check('dcp.js uses the upstream critical nudge', source.includes('CONTEXT_LIMIT_NUDGE'));
  check('the tool description comes from the upstream prompt', source.includes('COMPRESS_RANGE') && source.includes('formatExtension'));
  check('the compressed-block guidance is attached to nudges', source.includes('appendGuidanceToDcpTag'));
  check('the range entry schema is strict and carries only string boundaries plus summary', source.includes('startId: { type: \'string\'') && source.includes('endId: { type: \'string\'') && source.includes('additionalProperties: false'));
}

if (failures.length > 0) {
  console.log(`\n${failures.length} prompt parity check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nprompt surface matches upstream');
}
