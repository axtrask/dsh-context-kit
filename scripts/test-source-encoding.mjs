/**
 * The source files must be valid UTF-8 with no mojibake.
 *
 * This is not paranoia. Writing a source file through a non-UTF-8 shell
 * round trip (Windows PowerShell's `Set-Content`/`-replace` on a UTF-8 file)
 * silently rewrites every multi-byte character as its CP1251 misreading: `—`
 * becomes `вЂ”`, `…` becomes `вЂ¦`. The damage is invisible in a diff, the file
 * still parses, and the only symptom is a comparison failing somewhere far away —
 * which is exactly how it presented: a throttle line whose text no longer matched
 * the string the test built, twice, in two files.
 *
 * Worse, some of the corrupted characters sat in text the MODEL reads. A prompt
 * or a tool result with `вЂ”` in it is a defect a user can see.
 *
 * The rule enforced here: `lib/` and `scripts/` contain ASCII plus ordinary
 * Latin-1 punctuation only. Cyrillic is allowed ONLY on a line that says so, so
 * the deliberate UTF-8 round-trip sample in `verify-tools.mjs` passes while an
 * accidental corruption fails loudly.
 *
 * Run:  node scripts/test-source-encoding.mjs
 *
 * @module dsh-context-kit/scripts/test-source-encoding
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const kitRoot = join(here, '..');

const failures = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '[ok]  ' : '[FAIL]'} ${label}${detail.length > 0 ? ` — ${detail.slice(0, 170)}` : ''}`);
  if (!ok) failures.push(label);
};

/** Every file this project owns, excluding dependencies and reports. */
function sourceFiles(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) { sourceFiles(path, found); continue; }
    if (/\.(js|mjs|md|json|yml)$/.test(entry)) found.push(path);
  }
  return found;
}

/**
 * A line may carry Cyrillic when it is explicitly marked as an encoding sample.
 *
 * Two legitimate uses exist, and both announce themselves: the UTF-8 round-trip
 * sample (`Привет, мир!`) proves non-ASCII survives all three runtimes, and a
 * comment that NAMES the mojibake it is warning about (`вЂ”`) has to contain it.
 * Everything else is corruption.
 */
const ALLOWED = /utf-?8|Привет|mojibake/i;

/** Characters that indicate a CP1251 misreading rather than real text. */
const MOJIBAKE = /[\u0400-\u04FF]/;

console.log('\n--- every owned source file is clean UTF-8 ---');
for (const dir of ['lib', 'scripts']) {
  for (const file of sourceFiles(join(kitRoot, dir))) {
    // This checker is the ONE file that must contain the corrupted characters, in
    // order to document what it looks for. Excluding it keeps the rule simple.
    if (file.endsWith('test-source-encoding.mjs')) continue;
    const text = readFileSync(file, 'utf8');
    const relative = file.slice(kitRoot.length + 1);
    const bad = text
      .split('\n')
      .map((line, index) => [index + 1, line])
      .filter(([, line]) => MOJIBAKE.test(line) && !ALLOWED.test(line));
    const replacement = (text.match(/\uFFFD/g) ?? []).length;
    check(`${relative} is clean`, bad.length === 0 && replacement === 0,
      bad.length > 0
        ? `${bad.length} mojibake line(s), first at ${bad[0][0]}: ${bad[0][1].trim().slice(0, 70)}`
        : (replacement > 0 ? `${replacement} replacement character(s)` : ''));
  }
}

console.log('\n--- the characters that were corrupted are the intended ones ---');
{
  // The two characters that actually got mangled, checked where they matter.
  const contextMode = readFileSync(join(kitRoot, 'lib', 'context-mode.js'), 'utf8');
  check('the throttle line carries a real em dash',
    /Throttle: call #\$\{count\}[\s\S]{0,200}workloads — it counts as a single call\./.test(contextMode),
    (contextMode.match(/> Throttle[^\n]*/) ?? ['(line missing)'])[0].slice(-70));
  const prompts = readFileSync(join(kitRoot, 'lib', 'dcp-prompts.js'), 'utf8');
  check('the upstream prompt texts carry no mojibake', !MOJIBAKE.test(prompts));
  const guidance = readFileSync(join(kitRoot, 'lib', 'context-mode-guidance.js'), 'utf8');
  check('the injected guidance carries no mojibake', !MOJIBAKE.test(guidance));
}

console.log('\n--- the corruption cannot come back through a script ---');
{
  // No shipped script may write a source file through the shell. `Set-Content`
  // and `-replace` are the exact primitives that caused this, and a script that
  // rewrites `lib/` is not something this project needs.
  for (const file of sourceFiles(join(kitRoot, 'scripts'))) {
    if (!file.endsWith('.mjs')) continue;
    // This checker quotes the offending primitives in its own explanation.
    if (file.endsWith('test-source-encoding.mjs')) continue;
    const text = readFileSync(file, 'utf8');
    const suspicious = text.split('\n').filter((line) => /Set-Content|-replace |Out-File/.test(line));
    check(`${file.slice(kitRoot.length + 1)} does not rewrite sources via the shell`, suspicious.length === 0, suspicious[0]?.trim().slice(0, 90) ?? '');
  }
}

if (failures.length > 0) {
  console.log(`\n${failures.length} encoding check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nsource encoding is clean');
}
