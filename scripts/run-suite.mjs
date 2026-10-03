// Runs every runnable check in the kit and reports the totals that the docs quote.
//
//   node scripts/run-suite.mjs          # run everything, print the table
//   node scripts/run-suite.mjs --update # also rewrite the counts in docs/*.md
//
// Non-zero exit when any file fails. Files that assert with node:assert print no
// `[ok]` markers, so they are counted as files, not as checks - the docs must say
// "marked checks" for the number to stay honest.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scripts = join(root, 'scripts');
const update = process.argv.includes('--update');

const groups = [
  // Fixture sessions write per-session state files; point them at a throwaway home so a
  // suite run never litters the live `~/.dsh/context-kit/dcp-state`.
  { kind: 'test', pattern: /^test-.*\.mjs$/, sandboxed: true },
  // Some verification scripts inspect the selected live Harness environment, while
  // `verify-load` itself stays checkout-only. Do not redirect these to fixture state.
  { kind: 'verify', pattern: /^verify-.*\.mjs$/, sandboxed: false },
  { kind: 'probe', pattern: /^probe-.*\.mjs$/, sandboxed: false },
];

const files = readdirSync(scripts).sort();
const rows = [];
const silentByConstruction = [];
let marked = 0;
let failed = 0;
let failedFiles = [];

for (const group of groups) {
  for (const file of files) {
    if (!group.pattern.test(file)) continue;
    let out = '';
    let status = 0;
    try {
      out = execFileSync(process.execPath, [join(scripts, file)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: group.sandboxed
          ? { ...process.env, DSH_HOME: join(root, '.suite-state') }
          : { ...process.env },
      });
    } catch (error) {
      out = `${error.stdout ?? ''}${error.stderr ?? ''}`;
      status = error.status ?? 1;
    }
    const ok = (out.match(/\[ok\]/g) ?? []).length;
    const bad = (out.match(/\[FAIL\]/g) ?? []).length + (out.match(/\bFAILURES:/g) ?? []).length;
    if (status !== 0 || bad > 0) {
      failed += 1;
      failedFiles.push(file);
    }
    if (group.kind !== 'probe') marked += ok;
    // Label a file for what it IS. An earlier version tagged every zero-marker row
    // `[assert-based]`, which was wrong for four files and hid the real problem: a file
    // that asserts nothing can only fail by throwing, and two probes could not fail at all.
    const source = readFileSync(join(scripts, file), 'utf8');
    const asserts = /from 'node:assert/.test(source);
    const hasAssertions = asserts || /process\.exit(Code)?\s*=/.test(source) || /\[FAIL\]/.test(source);
    const label = ok > 0 ? '' : asserts ? '  [node:assert]' : hasAssertions ? '  [own failure path]' : '  [PRINTS ONLY: CANNOT FAIL]';
    rows.push(
      `${group.kind.padEnd(6)} ${file.padEnd(34)} exit=${status} ok=${String(ok).padStart(4)}` +
        (bad ? ` FAIL=${bad}` : '') +
        label,
    );
    if (label.includes('CANNOT FAIL')) silentByConstruction.push(`${file} (${group.kind})`);
  }
}

console.log(rows.join('\n'));
const summary = `files=${files.filter((f) => /^(test|verify|probe)-.*\.mjs$/.test(f)).length} `
  + `marked checks=${marked} failed files=${failed}`;
console.log(`\n${summary}`);
if (silentByConstruction.length > 0) {
  console.log(`prints only, no assertion and no exit code (kept as evidence, not as a check): ${silentByConstruction.join(', ')}`);
}
if (failedFiles.length > 0) console.log(`FAILED: ${failedFiles.join(', ')}`);

if (update) {
  const counts = { tests: 0, verifies: 0, probes: 0, marked };
  for (const row of rows) {
    const kind = row.slice(0, 6).trim();
    if (kind === 'test') counts.tests += 1;
    if (kind === 'verify') counts.verifies += 1;
    if (kind === 'probe') counts.probes += 1;
  }
  const sentence = `${counts.marked} marked checks / ${failed} failures across `
    + `${counts.tests} test + ${counts.verifies} verify + ${counts.probes} probe files`;
  for (const doc of ['environment.md', 'dcp-port.md', 'README.md', 'edit-feature.md']) {
    const path = join(root, 'docs', doc);
    const before = readFileSync(path, 'utf8');
    const after = before.replace(/<!-- suite:count -->[^<]*<!-- \/suite:count -->/g,
      `<!-- suite:count -->${sentence}<!-- /suite:count -->`);
    if (after !== before) {
      writeFileSync(path, after);
      console.log(`updated docs/${doc}`);
    }
  }
}

process.exit(failed === 0 ? 0 : 1);
