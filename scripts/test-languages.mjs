/**
 * The sandbox must run every language this machine has, and advertise exactly
 * those.
 *
 * Upstream detects runtimes rather than promising a fixed list
 * (`src/runtime.ts:334-392`, `:629-642`): the tool schema advertises what can
 * actually run, so a user never sees "unsupported language" for a language the
 * tool claimed. The port hard-coded three (`javascript`, `python`, `shell`), so
 * Go — which IS installed on this machine — looked unsupported while Rust, which
 * is not installed, would have looked fine on a machine that had it.
 *
 * The probe is also where upstream learned two lessons worth keeping:
 *
 * - `where python3` finds the Microsoft Store App Execution Alias stub even when
 *   no Python exists, and the stub exits non-zero while popping the Store, so
 *   every hit under `Microsoft\WindowsApps` is discarded.
 * - `--version` is not universal: `go` answers only to `go version`.
 *
 * Run:  node scripts/test-languages.mjs
 *
 * @module dsh-context-kit/scripts/test-languages
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const kitRoot = join(here, '..');

const failures = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '[ok]  ' : '[FAIL]'} ${label}${detail.length > 0 ? ` — ${detail.slice(0, 170)}` : ''}`);
  if (!ok) failures.push(label);
};

const sandbox = await import(pathToFileURL(join(kitRoot, 'lib', 'sandbox.js')).href);
const runtimes = sandbox.detectRuntimes();
const languages = sandbox.LANGUAGES;

console.log('\n--- detection matches this machine ---');
{
  console.log(`      detected: ${Object.entries(runtimes).filter(([, v]) => v !== null).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  check('javascript is always available', languages.includes('javascript'));
  check('shell is always available', languages.includes('shell'));
  check('javascript and shell lead the list, as upstream orders it',
    languages[0] === 'javascript' && languages[1] === 'shell', languages.join(', '));
  // Every advertised language must have a runtime, and vice versa.
  const advertised = new Set(languages);
  for (const name of ['javascript', 'typescript', 'python', 'shell', 'ruby', 'go', 'rust', 'php', 'perl', 'r', 'elixir', 'csharp']) {
    const detected = runtimes[name] !== null && runtimes[name] !== undefined;
    const isAdvertised = advertised.has(name);
    const alwaysOn = name === 'javascript' || name === 'shell';
    check(`${name}: advertised=${isAdvertised} matches detected=${detected}`,
      isAdvertised === (detected || alwaysOn),
      `runtime=${runtimes[name] ?? 'none'}`);
  }
  check('the list is a subset of upstream\'s twelve',
    languages.every((name) => ['javascript', 'typescript', 'python', 'shell', 'ruby', 'go', 'rust', 'php', 'perl', 'r', 'elixir', 'csharp'].includes(name)),
    languages.join(', '));
}

console.log('\n--- the known trap: a Store stub is not a runtime ---');
{
  // `python3` on Windows resolves to the Store alias even with no Python, so a
  // naive `where` probe would advertise python3 and then fail to run it.
  const { spawnSync } = await import('node:child_process');
  const probe = spawnSync('where', ['python3'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: true });
  const hits = String(probe.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const onlyStubs = hits.length > 0 && hits.every((hit) => /\\Microsoft\\WindowsApps\\/i.test(hit));
  if (onlyStubs) {
    check('a Store stub for python3 is NOT advertised', runtimes.python !== 'python3',
      `python3 resolves only to ${hits[0]}`);
  } else {
    // Either there is no python3 entry at all, or it is a real install.
    check('python3 is only used when it really runs', runtimes.python !== 'python3' || hits.length > 0,
      hits[0] ?? 'python3 not on PATH');
  }
}

console.log('\n--- every advertised language actually RUNS ---');
{
  const dbDir = mkdtempSync(join(tmpdir(), 'ctx-lang-'));
  const { Context } = await import('@deepseek-ai/cordis');
  const registered = new Map();
  const root = new Context();
  root.provide('tools', { register: (definition) => { registered.set(definition.name, definition); return () => {}; } });
  root.provide('commands', { register: () => () => {} });
  root.provide('logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
  root.provide('systemPrompt', { section: () => () => {} });
  root.provide('workspace', { root: kitRoot });
  const contextMode = await import(pathToFileURL(join(kitRoot, 'lib', 'context-mode.js')).href);
  root.plugin(contextMode, { knowledgeBasePath: join(dbDir, 'kb.db') });
  await new Promise((resolve) => setTimeout(resolve, 700));

  const tool = registered.get('ctx_execute');
  const enumValues = tool.parameters.properties.language.enum;
  check('the tool schema advertises exactly the detected languages',
    JSON.stringify(enumValues) === JSON.stringify(languages),
    JSON.stringify(enumValues));
  check('the schema is not the old hard-coded three',
    !(enumValues.length === 3 && enumValues.includes('python') && enumValues.includes('shell')),
    JSON.stringify(enumValues));

  const exec = {
    callId: 'call-lang',
    rootCallId: 'call-lang',
    name: 'ctx_execute',
    token: Symbol('t'),
    arguments: {},
    signal: new AbortController().signal,
    agent: { id: 'session-lang', session: { header: { cwd: kitRoot }, id: 'session-lang' } },
    deferContext: () => {},
    concludeTurn: () => {}
  };

  /** `[language, program, expected stdout]` — one real run per language. */
  const programs = {
    javascript: ['console.log("ran-javascript")', 'ran-javascript'],
    python: ['print("ran-python")', 'ran-python'],
    shell: [process.platform === 'win32' ? 'Write-Output "ran-shell"' : 'echo "ran-shell"', 'ran-shell'],
    go: ['package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("ran-go")\n}', 'ran-go'],
    ruby: ['puts "ran-ruby"', 'ran-ruby'],
    php: ['<?php echo "ran-php";', 'ran-php'],
    perl: ['print "ran-perl\\n";', 'ran-perl'],
    r: ['cat("ran-r\\n")', 'ran-r'],
    elixir: ['IO.puts("ran-elixir")', 'ran-elixir'],
    csharp: ['Console.WriteLine("ran-csharp");', 'ran-csharp'],
    typescript: ['console.log("ran-typescript")', 'ran-typescript'],
    rust: ['fn main() { println!("ran-rust"); }', 'ran-rust']
  };

  for (const language of languages) {
    const [code, expected] = programs[language];
    let value;
    try {
      value = await tool.execute({ language, code, source: `lang-${language}` }, exec);
    } catch (error) {
      failures.push(`${language} threw ${error.message}`);
      console.log(`[FAIL] ${language} threw: ${error.message.slice(0, 120)}`);
      continue;
    }
    const rendered = value.rendered ?? '';
    check(`${language} runs and prints`, rendered.includes(expected), rendered.split('\n')[0].slice(0, 90));
  }
}

if (failures.length > 0) {
  console.log(`\n${failures.length} language check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nlanguages match the runtimes this machine has');
}
