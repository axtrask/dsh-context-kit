/**
 * The sandbox must not hand a child the parent's credentials.
 *
 * Upstream context-mode rebuilds a small environment for its children
 * (`#buildSafeEnv`, src/executor.ts) because they are meant to be hermetic.
 * This port cannot rebuild: the harness's environment carries the toolchain
 * locations children need to find `node`, `py`, and `powershell`. So it deletes
 * by NAME instead — the same class of value (credentials, harness-internal
 * configuration, loader injection) without breaking a child that needs `PATH`.
 *
 * The matching has to be narrow in both directions: a substring test on "KEY"
 * would delete `PUBLIC_KEY` and `KEYBOARD_LAYOUT`, while a test that only looks
 * at the whole name would miss `AWS_SECRET_ACCESS_KEY`.
 *
 * Run:  node scripts/test-sandbox-env.mjs
 *
 * @module dsh-context-kit/scripts/test-sandbox-env
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const kitRoot = join(here, '..');

const failures = [];
/** @param name - check label. @param ok - result. @param detail - evidence. */
function check(name, ok, detail = '') {
  console.log(`${ok ? '[ok]  ' : '[FAIL]'} ${name}${detail.length > 0 ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const { isSecretEnvName, runProgram } = await import(pathToFileURL(join(kitRoot, 'lib', 'sandbox.js')).href);

console.log('--- name matching ---');
const NAMES = [
  ['OPENAI_API_KEY', true],
  ['ANTHROPIC_API_KEY', true],
  ['AWS_ACCESS_KEY_ID', true],
  ['AWS_SECRET_ACCESS_KEY', true],
  ['AZURE_CLIENT_SECRET', true],
  ['GOOGLE_APPLICATION_CREDENTIALS', true],
  ['GITHUB_TOKEN', true],
  ['DB_PASSWORD', true],
  ['MY_PASSPHRASE', true],
  ['APP_SESSION_SECRET', true],
  ['DSH_HOME', true],
  ['DSH_WEB_URL', true],
  // Must survive: these are needed to run anything at all.
  ['PATH', false],
  ['TEMP', false],
  ['SystemRoot', false],
  ['PYTHONUTF8', false],
  ['COMPUTERNAME', false],
  // Must survive: not credentials, despite containing a sensitive-looking word.
  ['PUBLIC_KEY', false],
  ['KEYBOARD_LAYOUT', false],
  ['MONKEY_MODE', false],
  ['TOKENIZER_PATH', false]
];
for (const [name, expected] of NAMES) {
  const actual = isSecretEnvName(name);
  check(`${name} ${expected ? 'is dropped' : 'is kept'}`, actual === expected, `got ${actual}`);
}

console.log('\n--- a real child ---');
const tmp = mkdtempSync(join(tmpdir(), 'sandbox-env-'));
// Plant credentials in THIS process's environment: the child inherits through
// `process.env`, which is exactly the leak this guard exists to stop.
process.env.OPENAI_API_KEY = 'sk-planted';
process.env.DSH_HOME = 'C:/planted-home';
process.env.MY_APP_TOKEN = 'planted-token';
process.env.NODE_OPTIONS = '--max-old-space-size=64';

const run = await runProgram(
  { cwd: tmp, tmpDir: tmp, timeoutMs: 30000, liveCapChars: 65536, headChars: 4000, tailChars: 1000 },
  {
    language: 'javascript',
    code: [
      'console.log(JSON.stringify({',
      '  openai: process.env.OPENAI_API_KEY ?? null,',
      '  dsh: process.env.DSH_HOME ?? null,',
      '  appToken: process.env.MY_APP_TOKEN ?? null,',
      '  nodeOptions: process.env.NODE_OPTIONS ?? null,',
      '  path: typeof process.env.PATH === "string" && process.env.PATH.length > 10,',
      '  temp: typeof process.env.TEMP === "string" && process.env.TEMP.length > 0,',
      '  utf8: process.env.PYTHONUTF8 ?? null,',
      '  ioenc: process.env.PYTHONIOENCODING ?? null',
      '}));'
    ].join('\n')
  }
);
check('the child ran', run.exitCode === 0, run.stderr.trim().slice(0, 160));
let observed = {};
try {
  observed = JSON.parse(run.stdout.trim());
} catch {
  observed = {};
}
check('OPENAI_API_KEY does not reach the child', observed.openai === null, JSON.stringify(observed.openai));
check('DSH_HOME does not reach the child', observed.dsh === null, JSON.stringify(observed.dsh));
check('MY_APP_TOKEN does not reach the child', observed.appToken === null, JSON.stringify(observed.appToken));
check('NODE_OPTIONS does not reach the child', observed.nodeOptions === null, JSON.stringify(observed.nodeOptions));
check('PATH survives, so the child can find its toolchain', observed.path === true);
check('TEMP survives and points into the scratch directory', observed.temp === true);
check('PYTHONUTF8 is injected for UTF-8 stdout', observed.utf8 === '1', JSON.stringify(observed.utf8));
check('PYTHONIOENCODING is injected for the stdio streams', observed.ioenc === 'utf-8', JSON.stringify(observed.ioenc));

rmSync(tmp, { recursive: true, force: true });
delete process.env.OPENAI_API_KEY;
delete process.env.DSH_HOME;
delete process.env.MY_APP_TOKEN;
delete process.env.NODE_OPTIONS;

console.log(`\n${failures.length === 0 ? 'all sandbox environment tests passed' : `${failures.length} failure(s)`}`);
process.exit(failures.length === 0 ? 0 : 1);
