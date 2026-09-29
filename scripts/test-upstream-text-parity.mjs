/**
 * Parity of the texts the model reads, pinned against upstream.
 *
 * WHY THIS FILE EXISTS. Every existing check compared production output against the
 * imported production constant — `view.includes(PRUNED_TOOL_OUTPUT_REPLACEMENT)` and so on.
 * An auditor mutated `PRUNED_TOOL_OUTPUT_REPLACEMENT` in a scratch copy of `lib` to a wrong
 * string and both big suites stayed green (`test-dcp-compress` 109 ok / 0 FAIL,
 * `test-dcp-materialization` 39 ok / 0 FAIL), while the same experiment on
 * `COMPRESSED_BLOCK_HEADER` produced 5 failures because that one IS compared against a
 * literal. Self-referential assertions cannot notice drift, and these strings are how a
 * reader — the model included — recognises a pruned or compressed section.
 *
 * So the literals are written out HERE, in the test, and checked from both ends: the kit's
 * exported constant must equal the pinned string, and the pinned string must still appear in
 * the upstream source. Drift in either direction fails.
 *
 * Run:  node scripts/test-upstream-text-parity.mjs
 *
 * @module dsh-context-kit/scripts/test-upstream-text-parity
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const kitRoot = join(here, '..');
// The upstream checkout does not live under the plugin or under `$DSH_HOME`: the workspace is
// `<home>/tes` while the plugin is `<home>/plugins/dsh-context-kit`, so the sibling is three
// levels up. Deriving it from `$DSH_HOME` made this test pass on its own and fail under the
// suite runner, which points the test files at a throwaway home — the runner's sandbox is right,
// the path assumption was wrong. Candidates are tried in order and the first that exists wins.
const candidates = [
  process.env.DCP_UPSTREAM,
  join(kitRoot, '..', '..', 'upstream', 'opencode-dcp'),
  join(kitRoot, '..', '..', '..', 'tes', 'upstream', 'opencode-dcp'),
  join(kitRoot, '..', '..', '..', 'workspace', 'upstream', 'opencode-dcp'),
  join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'tes', 'upstream', 'opencode-dcp')
].filter((candidate) => typeof candidate === 'string' && candidate.length > 0);
const upstream = candidates.find((candidate) => existsSync(join(candidate, 'lib'))) ?? candidates[1];

const failures = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '[ok]  ' : '[FAIL]'} ${label}${detail.length > 0 ? ` — ${detail.slice(0, 170)}` : ''}`);
  if (!ok) failures.push(label);
};

const placeholders = await import(pathToFileURL(join(kitRoot, 'lib', 'dcp-block-placeholders.js')).href);
const blocks = await import(pathToFileURL(join(kitRoot, 'lib', 'dcp-blocks.js')).href);

/**
 * The pinned pairs: what the kit must export, where upstream defines it, and the literal.
 *
 * `sourceFile` and `literal` are quoted from upstream by hand — that is the point. A test
 * that reads the expected value out of the code under test proves nothing.
 */
const PINNED = [
  {
    what: 'the pruned-output replacement',
    kit: () => blocks.PRUNED_TOOL_OUTPUT_REPLACEMENT,
    sourceFile: join('lib', 'messages', 'prune.ts'),
    literal: '[Output removed to save context - information superseded or no longer needed]'
  },
  {
    what: 'the failed-call input replacement',
    kit: () => blocks.PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
    sourceFile: join('lib', 'messages', 'prune.ts'),
    literal: '[input removed due to failed tool call]'
  },
  {
    what: 'the compressed-section header',
    kit: () => placeholders.COMPRESSED_BLOCK_HEADER,
    sourceFile: join('lib', 'compress', 'state.ts'),
    literal: '[Compressed conversation section]'
  }
];

console.log('--- the kit\'s model-facing texts must be upstream\'s ---');
console.log(`upstream root: ${upstream}`);

for (const { what, kit, sourceFile, literal } of PINNED) {
  const value = kit();
  check(`${what}: the kit exports the pinned literal`, value === literal, JSON.stringify(value));
  const path = join(upstream, sourceFile);
  if (!existsSync(path)) {
    check(`${what}: upstream source is readable`, false, `missing ${path}`);
    continue;
  }
  const source = readFileSync(path, 'utf8');
  check(`${what}: upstream still defines it verbatim`, source.includes(literal), `searched ${sourceFile}`);
}

// The header exists in two kit modules (the placeholder algebra and the prompt text). Two
// copies of a literal the model reads is a drift waiting to happen, so they are compared to
// each other as well as to upstream.
const prompts = await import(pathToFileURL(join(kitRoot, 'lib', 'dcp-prompts.js')).href);
check(
  'the header is the same string in dcp-block-placeholders and dcp-prompts',
  placeholders.COMPRESSED_BLOCK_HEADER === prompts.COMPRESSED_BLOCK_HEADER,
  `${JSON.stringify(placeholders.COMPRESSED_BLOCK_HEADER)} vs ${JSON.stringify(prompts.COMPRESSED_BLOCK_HEADER)}`
);

// The header is defined in more than one upstream file; if it moved, the pin above fails and
// this says where it is now instead of leaving the reader guessing.
const upstreamRoot = join(upstream, 'lib');
if (existsSync(upstreamRoot)) {
  const grep = (needle) => {
    const hits = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.ts') && readFileSync(path, 'utf8').includes(needle)) hits.push(path.slice(upstream.length + 1));
      }
    };
    walk(upstreamRoot);
    return hits;
  };
  const headerHits = grep('[Compressed conversation section]');
  check('upstream defines the compressed-section header somewhere in lib/', headerHits.length > 0, headerHits.join(', '));
  const outputHits = grep('[Output removed to save context - information superseded or no longer needed]');
  check('upstream defines the pruned-output replacement somewhere in lib/', outputHits.length > 0, outputHits.join(', '));
  check(
    'the pruned-output replacement is NOT inlined at its use site',
    outputHits.every((hit) => hit.endsWith('prune.ts')),
    outputHits.join(', ')
  );
}

if (failures.length > 0) {
  console.log(`\n${failures.length} parity check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nthe model-facing texts match upstream');
}
