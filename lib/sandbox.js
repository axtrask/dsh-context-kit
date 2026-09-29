/**
 * The sandbox behind context-mode: run a program, keep only its stdout.
 *
 * Upstream context-mode intercepts the harness's own tools and re-routes bulky
 * work into a subprocess. In this port the subprocess IS the tool: the model
 * writes a program, the program runs in the session workspace, and only the
 * bounded stdout reaches the conversation. Full output stays on disk and is
 * indexed by source label, so "show me everything" becomes a search instead of
 * a paste.
 *
 * Child output is captured through FILES, never pipes. That is deliberate:
 * the harness's Windows sandbox denies a confined process the named pipes
 * Node uses for `stdio: 'pipe'` ("spawn EPERM"), and a file capture is the
 * better design anyway — the complete output is already where the truncation
 * notice says it is, with no second write to keep in sync.
 *
 * @module dsh-context-kit/sandbox
 */

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { codePointLength, errorLine } from './common.js';

const backgroundChildren = new Map();

/** Kill detached programs owned by one plugin/session (or every owner). */
export function terminateBackgroundProcesses(filter = {}) {
  let terminated = 0;
  for (const [pid, entry] of backgroundChildren) {
    if (filter.owner !== undefined && entry.owner !== filter.owner) continue;
    if (filter.session !== undefined && entry.session !== filter.session) continue;
    backgroundChildren.delete(pid);
    killTree(entry.child);
    terminated += 1;
  }
  return terminated;
}

/**
 * Resolve how to launch one program on this platform.
 *
 * Each branch mirrors upstream's `buildCommand` (`src/runtime.ts:644-…`),
 * including the two platform details that are easy to get wrong on Windows: a
 * bash script is invoked with `-c "source '<path>'"` because MSYS rewrites a
 * bare path argument (`D:\tmp\x.sh` becomes `D:\c\tmp\x.sh`), and PowerShell
 * gets a process-scoped `-ExecutionPolicy Bypass` so a generated script runs
 * without changing machine policy.
 *
 * @param language - one of {@link LANGUAGES}.
 * @param scriptPath - the file holding the program.
 * @param runtimes - detected runtimes, injectable for focused tests.
 * @returns ordered process steps and generated files to remove afterwards.
 */
function launch(language, scriptPath, runtimes = detectRuntimes()) {
  const isWindows = process.platform === 'win32';
  const one = (command, args) => ({ steps: [{ command, args }], cleanupPaths: [] });
  switch (language) {
    case 'javascript': {
      const node = runtimes.javascript;
      if (node === null || node === undefined) {
        throw new Error('no JavaScript runtime available; install Node.js or Bun on PATH');
      }
      return one(node, ['--no-warnings', scriptPath]);
    }
    case 'typescript': {
      const typescript = runtimes.typescript;
      if (typescript === null) throw new Error('no TypeScript runtime available; install tsx or ts-node');
      return one(typescript, [scriptPath]);
    }
    case 'python': {
      const python = runtimes.python;
      if (python === null) throw new Error('no Python runtime available; install python3 or python');
      // `py -3` is the Windows launcher; it takes the version as an argument.
      return python === 'py'
        ? one('py', ['-3', scriptPath])
        : one(python, [scriptPath]);
    }
    case 'shell': {
      const shell = runtimes.shell;
      const base = shell.split(/[\\/]/).pop().toLowerCase();
      if (base.startsWith('bash') || base === 'sh' || base === 'sh.exe') {
        const include = base.startsWith('bash') ? 'source' : '.';
        return one(shell, ['-c', `${include} '${scriptPath.replace(/'/g, "'\\''")}'`]);
      }
      if (base.startsWith('pwsh') || base.startsWith('powershell')) {
        return one(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath]);
      }
      return one(shell, [scriptPath]);
    }
    // Upstream runs each remaining language as a script through its own runtime.
    // Rust and Go are compiled, so the port uses the single-file forms that need
    // no build step, matching what upstream's `rustc`/`go` branches do.
    case 'ruby':
    case 'php':
    case 'perl':
    case 'r':
    case 'elixir':
    case 'csharp': {
      const key = language === 'csharp' ? 'csharp' : language;
      const command = runtimes[key];
      if (command === null || command === undefined) throw new Error(`no ${language} runtime available`);
      return one(command, [scriptPath]);
    }
    case 'go':
      if (runtimes.go === null) throw new Error('no Go runtime available');
      return one(runtimes.go, ['run', scriptPath]);
    case 'rust': {
      if (runtimes.rust === null) throw new Error('no Rust runtime available');
      const binaryPath = `${scriptPath}${isWindows ? '.exe' : '.out'}`;
      return {
        steps: [
          { command: runtimes.rust, args: ['--edition', '2021', scriptPath, '-o', binaryPath] },
          { command: binaryPath, args: [] }
        ],
        cleanupPaths: [binaryPath]
      };
    }
    default:
      throw new Error(`unsupported language ${JSON.stringify(language)}; supported here: ${LANGUAGES.join(', ')}`);
  }
}

/** Test seam for validating multi-step runtime plans without installed tools. */
export function launchPlanForTest(language, scriptPath, runtimes) {
  return launch(language, scriptPath, runtimes);
}

/** File extension for one language's program file. */
function extensionFor(language) {
  switch (language) {
    case 'javascript':
      return 'mjs';
    case 'typescript':
      return 'ts';
    case 'python':
      return 'py';
    case 'shell':
      return process.platform === 'win32' ? 'ps1' : 'sh';
    case 'ruby':
      return 'rb';
    case 'go':
      return 'go';
    case 'rust':
      return 'rs';
    case 'php':
      return 'php';
    case 'perl':
      return 'pl';
    case 'r':
      return 'r';
    case 'elixir':
      return 'exs';
    case 'csharp':
      return 'csx';
    default:
      return 'txt';
  }
}

/**
 * Whether one command resolves to a real, runnable program.
 *
 * Upstream refuses to trust a bare name match on Windows: `where python3` finds
 * the Microsoft Store App Execution Alias stub at
 * `C:\Users\<u>\AppData\Local\Microsoft\WindowsApps\` even when no Python exists,
 * and the stub exits 9009 while popping the Store. So every hit under that
 * directory is discarded, and the surviving candidate must actually answer
 * `<cmd> --version` (`src/runtime.ts:78-127`).
 *
 * @param command - the command name to probe.
 * @param versionArgs - arguments that make it print its version.
 * @returns true when the command exists AND runs.
 */
function runnable(command, versionArgs = ['--version']) {
  const isWindows = process.platform === 'win32';
  let hits;
  try {
    // `where` and `command -v` are shell builtins/resolvers, so the LOOKUP needs a
    // shell; passing arguments alongside `shell: true` is what Node deprecates
    // (DEP0190), so the command line is built as one string instead.
    const probe = isWindows
      ? spawnSync(`where ${command}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: true, timeout: 5000 })
      : spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    if (probe.status !== 0) return false;
    hits = String(probe.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  } catch {
    return false;
  }
  if (hits.length === 0) return false;
  if (isWindows && hits.every((hit) => /\\Microsoft\\WindowsApps\\/i.test(hit))) return false;
  // `--version` is the common flag but not a universal one: `go` answers only to
  // `go version`, and an unknown flag exits non-zero. Trying the alternatives is
  // what keeps a genuinely installed runtime from being reported as absent.
  for (const args of [versionArgs, ['version'], ['-version'], ['--help']]) {
    try {
      const version = spawnSync(command, args, { encoding: 'utf8', stdio: 'ignore', timeout: 5000, shell: false });
      // A launcher that RUNS is enough; some print help and exit non-zero.
      if (version.status === 0 || version.status === 1) return true;
    } catch {
      /* try the next flag */
    }
  }
  return false;
}

/**
 * The first of several candidate commands that actually runs.
 * @param candidates - command names, preferred first.
 * @returns the command name, or `null`.
 */
function firstRunnable(candidates) {
  for (const candidate of candidates) {
    if (runnable(candidate)) return candidate;
  }
  return null;
}

/**
 * Which language runtimes this machine has.
 *
 * Upstream detects runtimes rather than promising a fixed list
 * (`src/runtime.ts:334-392`): the tool schema then advertises exactly what can
 * run, so a user never gets "unsupported language" for something the tool
 * claimed to support. The port hard-coded three languages, so Go — which IS
 * installed here — looked unsupported, and Rust — which is not — would have
 * looked supported on a machine that had it.
 *
 * Detection is cached: three `--version` probes per language would otherwise run
 * on every tool-schema build.
 *
 * @returns the resolved command per language, or `null` when unavailable.
 */
let runtimeCache;
export function detectRuntimes() {
  if (runtimeCache !== undefined) return runtimeCache;
  const isWindows = process.platform === 'win32';
  runtimeCache = {
    javascript: runnable(process.execPath, ['--version']) ? process.execPath : firstRunnable(['node']),
    typescript: firstRunnable(['tsx', 'ts-node']),
    python: firstRunnable(['python3', 'python', 'py']),
    // WSL's `bash.exe` is a stub that fails until a distribution is installed, so
    // it is not treated as bash: `resolveWindowsShell` reaches PowerShell instead,
    // which is always present on Windows (`src/runtime.ts:223-238`).
    shell: isWindows
      ? (firstRunnable(['pwsh', 'powershell']) ?? 'powershell.exe')
      : (firstRunnable(['bash', 'sh']) ?? '/bin/sh'),
    ruby: firstRunnable(['ruby']),
    go: firstRunnable(['go']),
    rust: firstRunnable(['rustc']),
    php: firstRunnable(['php']),
    perl: firstRunnable(['perl']),
    r: firstRunnable(['Rscript', 'r']),
    elixir: firstRunnable(['elixir']),
    csharp: firstRunnable(['dotnet-script'])
  };
  return runtimeCache;
}

/**
 * The languages this machine can actually run, upstream's ordering
 * (`src/runtime.ts:629-642`): javascript and shell always, the rest only when
 * their runtime was found.
 *
 * @returns the supported language names.
 */
export function availableLanguages() {
  const runtimes = detectRuntimes();
  const languages = ['javascript', 'shell'];
  for (const name of ['typescript', 'python', 'ruby', 'go', 'rust', 'php', 'perl', 'r', 'elixir', 'csharp']) {
    if (runtimes[name] !== null && runtimes[name] !== undefined) languages.push(name);
  }
  return languages;
}

/** Languages the sandbox can run on THIS machine, in upstream's order. */
export const LANGUAGES = availableLanguages();

/** First lines prepended to a program, stating the one rule that matters. */
function preludeFor(language) {
  if (language === 'javascript' || language === 'typescript') {
    return [
      '// context-mode sandbox: only stdout reaches the conversation —',
      '// print the answer, not the data.',
      ''
    ].join('\n');
  }
  if (language === 'python') {
    return [
      '# context-mode sandbox: Python standard library.',
      '# Only stdout reaches the conversation — print the answer, not the data.',
      ''
    ].join('\n');
  }
  if (language === 'shell' && process.platform === 'win32') {
    return [
      '$ctxUtf8 = New-Object System.Text.UTF8Encoding($false)',
      '[Console]::InputEncoding = $ctxUtf8',
      '[Console]::OutputEncoding = $ctxUtf8',
      '$OutputEncoding = $ctxUtf8',
      ''
    ].join('\n');
  }
  return '';
}

/**
 * Name patterns for environment entries a child must never inherit.
 *
 * Upstream context-mode strips the whole environment and rebuilds a small set
 * (`#buildSafeEnv`, src/executor.ts) because its children are meant to be
 * hermetic. This port cannot do that: the harness's own environment carries the
 * toolchain locations children need, and a launched program must still find
 * `node`, `py`, and `powershell`. So the port deletes by NAME instead of
 * rebuilding, which removes the same class of value — credentials — without
 * breaking a child that needs `PATH`.
 *
 * Matching is deliberately narrow. A substring test on "KEY" would delete
 * `PUBLIC_KEY` and `KEYBOARD_LAYOUT`; these require a delimiter before the
 * sensitive word, which is how credential variables are actually named
 * (`OPENAI_API_KEY`, `AWS_ACCESS_KEY_ID`, `GITHUB_TOKEN`).
 */
const SECRET_ENV_PATTERNS = [
  /(^|_)(API|ACCESS|SECRET|PRIVATE|SIGNING|ENCRYPTION|SESSION|REFRESH)_?(KEY|TOKEN|SECRET|ID)?$/i,
  /(^|_)(APIKEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PASSPHRASE)$/i,
  /^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)$/i,
  /^AZURE_(CLIENT_SECRET|STORAGE_KEY|TENANT_ID|CLIENT_ID)$/i,
  /^GOOGLE_APPLICATION_CREDENTIALS$/i
];

/**
 * Environment entries that look like credentials or harness-internal state.
 *
 * `DSH_*` is the harness's own namespace; a child needs none of it, and leaving
 * it in place would hand a sandboxed program the host's configuration.
 *
 * @param name - the variable name.
 * @returns whether the child must not see it.
 */
export function isSecretEnvName(name) {
  if (/^DSH_/i.test(name)) return true;
  return SECRET_ENV_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Environment every child gets, fixing the two encoding traps on Windows and
 * dropping the credentials the parent happens to hold.
 *
 * `PYTHONUTF8` forces Python's UTF-8 mode, without which Python 3 on a
 * non-UTF-8 system locale encodes stdout as the ANSI code page: Cyrillic comes
 * back as replacement characters and any non-encodable character kills the
 * program outright.
 *
 * `PYTHONIOENCODING` repeats the guarantee for the stderr/stdout streams
 * specifically, so it holds even if a program or a site config disables UTF-8
 * mode.
 *
 * `NODE_OPTIONS` is dropped for a different reason: it can inject `--require`
 * flags into the child, so an inherited value would let the host's launcher
 * configuration change what a sandboxed program is.
 *
 * @param base - the parent environment.
 * @returns a detached environment for the child.
 */
function sandboxEnv(base) {
  const scrubbed = {};
  for (const [name, value] of Object.entries(base)) {
    if (isSecretEnvName(name)) continue;
    if (name === 'NODE_OPTIONS') continue;
    scrubbed[name] = value;
  }
  return {
    ...scrubbed,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8'
  };
}

/**
 * Delete capture files left by earlier runs.
 *
 * A child cannot delete its own capture while it is still writing to it, and a
 * killed child never gets the chance, so reaping happens on the next mount
 * instead of at the end of each run. Files stay for `retentionMs` so a capture
 * named in a recent result can still be read.
 *
 * @param dir - the scratch directory.
 * @param retentionMs - how long a capture is kept.
 * @returns how many files were removed and how many remain.
 */
export function cleanupScratch(dir, retentionMs = 24 * 60 * 60 * 1000) {
  let removed = 0;
  let kept = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { removed, kept };
  }
  const cutoff = Date.now() - retentionMs;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    const stats = lstatSafe(path);
    if (stats === undefined) continue;
    if (stats.mtimeMs >= cutoff) {
      kept += 1;
      continue;
    }
    try {
      removeNoFollow(path);
      removed += 1;
    } catch {
      kept += 1;
    }
  }
  return { removed, kept };
}

/** `lstat` that answers undefined instead of throwing or following a link. */
function lstatSafe(path) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/** Remove one owned scratch entry without traversing symlinks or junctions. */
function removeNoFollow(path) {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    unlinkSync(path);
    return;
  }
  for (const entry of readdirSync(path)) removeNoFollow(join(path, entry));
  rmdirSync(path);
}

/** Read a capture file, tolerating a missing or unreadable one. */
function readCapture(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Bound stdout and stderr to one shared UTF-8 byte budget.
 *
 * Upstream does NOT bound every run: it returns stdout in full until it exceeds
 * `LARGE_OUTPUT_THRESHOLD = 102_400` bytes and only then auto-indexes and returns
 * a pointer (`src/server.ts:1980,1937-1941`). The port bounded at 6000+2000
 * characters unconditionally, so a 30 KB log arrived as 6 KB of head and 2 KB of
 * tail with the middle — where failures usually are — left only in the index.
 *
 * The option names retain their old `Chars` suffix for API compatibility, but
 * both the threshold and split are byte-based. A multibyte stream therefore
 * cannot exceed the configured budget merely because it has fewer code points.
 */
function boundCombined(stdout, stderr, budgetBytes, headWeight, tailWeight) {
  const streams = [stdout, stderr].map((text) => ({
    text,
    bytes: Buffer.byteLength(text),
    chars: codePointLength(text)
  }));
  const totalBytes = streams[0].bytes + streams[1].bytes;
  if (totalBytes <= budgetBytes) {
    return {
      stdout: { ...streams[0], truncated: false },
      stderr: { ...streams[1], truncated: false },
      renderedBytes: totalBytes
    };
  }

  const marker = '\n\n[... output middle truncated ...]\n\n';
  const markerBytes = Buffer.byteLength(marker);
  const nonEmpty = streams.filter((stream) => stream.bytes > 0).length;
  const markerBudget = nonEmpty === 0 ? 0 : Math.min(markerBytes, Math.floor(budgetBytes / nonEmpty));
  const boundedMarker = utf8Prefix(Buffer.from(marker, 'utf8'), markerBudget);
  const sourceBudget = Math.max(0, budgetBytes - markerBudget * nonEmpty);
  const allocations = streams.map((stream) => totalBytes === 0 ? 0 : Math.floor(sourceBudget * stream.bytes / totalBytes));
  let unassigned = sourceBudget - allocations[0] - allocations[1];

  // A small stream is kept whole; its unused proportional share goes to the
  // other stream. This avoids turning a one-line error into only a marker.
  if (streams[0].bytes > 0 && streams[1].bytes > 0) {
    const smaller = streams[0].bytes <= streams[1].bytes ? 0 : 1;
    if (streams[smaller].bytes <= Math.floor(sourceBudget / 4)) {
      const larger = 1 - smaller;
      allocations[smaller] = streams[smaller].bytes;
      allocations[larger] = Math.max(0, sourceBudget - allocations[smaller]);
      unassigned = 0;
    }
  }
  for (let index = 0; index < streams.length; index += 1) {
    if (allocations[index] > streams[index].bytes) {
      unassigned += allocations[index] - streams[index].bytes;
      allocations[index] = streams[index].bytes;
    }
  }
  while (unassigned > 0) {
    const index = streams[0].bytes - allocations[0] >= streams[1].bytes - allocations[1] ? 0 : 1;
    const add = Math.min(unassigned, streams[index].bytes - allocations[index]);
    if (add <= 0) break;
    allocations[index] += add;
    unassigned -= add;
  }

  const ratio = headWeight + tailWeight > 0 ? headWeight / (headWeight + tailWeight) : 0.75;
  const bounded = streams.map((stream, index) => {
    if (stream.bytes <= allocations[index]) return { ...stream, truncated: false };
    const headBytes = Math.floor(allocations[index] * ratio);
    const tailBytes = allocations[index] - headBytes;
    const buffer = Buffer.from(stream.text, 'utf8');
    const head = utf8Prefix(buffer, headBytes);
    const tail = utf8Suffix(buffer, tailBytes);
    return { ...stream, text: `${head}${boundedMarker}${tail}`, truncated: true };
  });
  return {
    stdout: bounded[0],
    stderr: bounded[1],
    renderedBytes: Buffer.byteLength(bounded[0].text) + Buffer.byteLength(bounded[1].text)
  };
}

/** Decode at most `maxBytes` from the start without splitting UTF-8. */
function utf8Prefix(buffer, maxBytes) {
  let end = Math.min(buffer.length, Math.max(0, maxBytes));
  const decoder = new TextDecoder('utf-8', { fatal: true });
  while (end > 0) {
    try {
      return decoder.decode(buffer.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return '';
}

/** Decode at most `maxBytes` from the end without splitting UTF-8. */
function utf8Suffix(buffer, maxBytes) {
  let start = Math.max(0, buffer.length - Math.max(0, maxBytes));
  const decoder = new TextDecoder('utf-8', { fatal: true });
  while (start < buffer.length) {
    try {
      return decoder.decode(buffer.subarray(start));
    } catch {
      start += 1;
    }
  }
  return '';
}

/** Kill a child and every descendant it spawned. */
function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    try {
      const killed = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: 10_000,
        windowsHide: true
      });
      if (killed.status === 0) return;
    } catch {
      /* fall through to the direct kill */
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      /* fall through to the direct kill */
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

/** Best-effort cleanup for generated binaries after every exit path. */
function cleanupGenerated(paths) {
  for (const path of paths) {
    try {
      rmSync(path, { force: true, maxRetries: process.platform === 'win32' ? 5 : 0, retryDelay: 50 });
    } catch {
      /* a lingering OS handle is reaped by cleanupScratch later */
    }
  }
}

/**
 * Run one program and return its bounded result.
 *
 * @param options - program text, language, limits, spill directory, and any
 *   extra arguments appended after the program file.
 * @param overrides - fields merged over `options`, letting a caller keep the
 *   shared run environment in one object and pass just `language` and `code`
 *   in a second. Callers that already merged them into `options` pass nothing.
 * @returns the settled execution, never a rejection for a program-level
 *   failure (a failure to START the program is reported as `spawnError`).
 */
export function runProgram(options, overrides = {}) {
  const merged = { ...options, ...overrides };
  const language = merged.language;
  if (!LANGUAGES.includes(language)) {
    return Promise.reject(new Error(`unsupported language ${JSON.stringify(language)}; supported: ${LANGUAGES.join(', ')}`));
  }
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(merged.tmpDir, { recursive: true });
  const scriptPath = join(merged.tmpDir, `${stamp}.${extensionFor(language)}`);
  const outPath = join(merged.tmpDir, `${stamp}.stdout.txt`);
  const errPath = join(merged.tmpDir, `${stamp}.stderr.txt`);

  // Windows PowerShell 5.1 reads a .ps1 file with NO byte-order mark as ANSI,
  // so a UTF-8 script containing Cyrillic — or any non-ASCII character, or an
  // emoji — is decoded to mojibake and the parser fails on a reversed quote.
  // A UTF-8 BOM makes PowerShell 5.1, PowerShell 7, and `node` all read the
  // file the way it was written. The BOM is written as raw bytes, never as a
  // text prefix, so the file keeps exactly one.
  const prelude = Buffer.from(preludeFor(language), 'utf8');
  const body = Buffer.from(merged.code, 'utf8');
  const script = language === 'shell' && process.platform === 'win32'
    ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), prelude, body])
    : Buffer.concat([prelude, body]);
  writeFileSync(scriptPath, script);

  const plan = launch(language, scriptPath);
  const extraArgs = Array.isArray(merged.args) ? merged.args.map(String) : [];
  const steps = plan.steps.map((step, index) => ({
    ...step,
    args: index === plan.steps.length - 1 ? [...step.args, ...extraArgs] : [...step.args]
  }));
  const startedAt = Date.now();

  return new Promise((settle) => {
    let outFd;
    let errFd;
    try {
      outFd = openSync(outPath, 'w');
      errFd = openSync(errPath, 'w');
    } catch (error) {
      cleanupGenerated(plan.cleanupPaths);
      settle({
        ok: false,
        spawnError: errorLine(error),
        timedOut: false,
        aborted: false,
        stdout: '',
        stderr: '',
        fullStdoutChars: 0,
        fullStderrChars: 0,
        fullStdoutBytes: 0,
        fullStderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
        exitCode: null,
        durationMs: 0,
        scriptPath
      });
      return;
    }

    let child;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let completedSteps = 0;
    const signal = merged.signal;
    const timeoutMs = Number.isFinite(merged.timeoutMs) && merged.timeoutMs > 0 ? merged.timeoutMs : undefined;
    let timer;
    let onAbort;

    const finish = (exitCode, spawnError) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (signal !== undefined && onAbort !== undefined) signal.removeEventListener('abort', onAbort);
      try {
        closeSync(outFd);
      } catch {
        /* already closed with the child */
      }
      try {
        closeSync(errFd);
      } catch {
        /* already closed with the child */
      }
      const durationMs = Date.now() - startedAt;
      const rawOut = readCapture(outPath);
      const rawErr = readCapture(errPath);
      const success = spawnError === undefined && !timedOut && !aborted && exitCode === 0;
      const budgetCandidate = merged.outputBudgetBytes ?? merged.passThroughBytes ?? merged.passThroughChars;
      const fallbackBudget = Math.max(0, Number(merged.headChars ?? 0) + Number(merged.tailChars ?? 0));
      const budgetBytes = Number.isFinite(budgetCandidate) && budgetCandidate >= 0 ? budgetCandidate : fallbackBudget;
      const bounded = boundCombined(
        rawOut,
        rawErr,
        budgetBytes,
        Math.max(0, Number(merged.headChars ?? 0)),
        Math.max(0, Number(merged.tailChars ?? 0))
      );
      cleanupGenerated(plan.cleanupPaths);
      settle({
        ok: success && !bounded.stdout.truncated && !bounded.stderr.truncated,
        spawnError,
        timedOut,
        aborted,
        stdout: bounded.stdout.text,
        // Successful diagnostics remain available through stderrPath and
        // metadata, but only failed runs expose them in the ordinary result.
        stderr: success ? '' : bounded.stderr.text,
        fullStdoutChars: codePointLength(rawOut),
        fullStderrChars: codePointLength(rawErr),
        fullStdoutBytes: Buffer.byteLength(rawOut),
        fullStderrBytes: Buffer.byteLength(rawErr),
        boundedOutputBytes: bounded.renderedBytes,
        renderedOutputBytes: Buffer.byteLength(bounded.stdout.text) + (success ? 0 : Buffer.byteLength(bounded.stderr.text)),
        outputBudgetBytes: budgetBytes,
        stdoutTruncated: bounded.stdout.truncated,
        stderrTruncated: bounded.stderr.truncated,
        stderrCaptured: rawErr.length > 0,
        stderrSuppressed: success && rawErr.length > 0,
        completedSteps,
        exitCode,
        durationMs,
        scriptPath,
        spillPath: outPath,
        stderrPath: errPath
      });
    };

    const terminate = (reason) => {
      if (settled) return;
      if (reason === 'timeout' && merged.background === true && child !== undefined) {
        settled = true;
        timedOut = true;
        if (timer !== undefined) clearTimeout(timer);
        if (signal !== undefined && onAbort !== undefined) signal.removeEventListener('abort', onAbort);
        try { closeSync(outFd); } catch { /* child retains its inherited handle */ }
        try { closeSync(errFd); } catch { /* child retains its inherited handle */ }
        const rawOut = readCapture(outPath);
        const rawErr = readCapture(errPath);
        const budgetCandidate = merged.outputBudgetBytes ?? merged.passThroughBytes ?? merged.passThroughChars;
        const fallbackBudget = Math.max(0, Number(merged.headChars ?? 0) + Number(merged.tailChars ?? 0));
        const budgetBytes = Number.isFinite(budgetCandidate) && budgetCandidate >= 0 ? budgetCandidate : fallbackBudget;
        const bounded = boundCombined(rawOut, rawErr, budgetBytes, Number(merged.headChars ?? 0), Number(merged.tailChars ?? 0));
        child.removeAllListeners('error');
        child.removeAllListeners('close');
        child.once('error', () => {});
        backgroundChildren.set(child.pid, { child, owner: merged.backgroundOwner, session: merged.backgroundSession });
        child.once('close', () => {
          backgroundChildren.delete(child.pid);
          cleanupGenerated(plan.cleanupPaths);
        });
        child.unref();
        settle({
          ok: true,
          backgrounded: true,
          spawnError: undefined,
          timedOut: true,
          aborted: false,
          stdout: bounded.stdout.text,
          stderr: '',
          fullStdoutChars: codePointLength(rawOut),
          fullStderrChars: codePointLength(rawErr),
          fullStdoutBytes: Buffer.byteLength(rawOut),
          fullStderrBytes: Buffer.byteLength(rawErr),
          boundedOutputBytes: bounded.renderedBytes,
          renderedOutputBytes: Buffer.byteLength(bounded.stdout.text),
          outputBudgetBytes: budgetBytes,
          stdoutTruncated: bounded.stdout.truncated,
          stderrTruncated: bounded.stderr.truncated,
          stderrCaptured: rawErr.length > 0,
          stderrSuppressed: rawErr.length > 0,
          completedSteps,
          exitCode: null,
          durationMs: Date.now() - startedAt,
          scriptPath,
          spillPath: outPath,
          stderrPath: errPath
        });
        return;
      }
      if (reason === 'timeout') timedOut = true;
      else aborted = true;
      killTree(child);
    };

    const spawnStep = (index) => {
      if (settled) return;
      const step = steps[index];
      try {
        child = spawn(step.command, step.args, {
          cwd: merged.cwd,
          // `sandboxEnv` carries the Python UTF-8 guarantees; a caller's own
          // `env` (ctx_execute_file's CTX_FILE) is layered on top of it.
          env: { ...sandboxEnv(process.env), ...(merged.env ?? {}) },
          stdio: ['ignore', outFd, errFd],
          windowsHide: true,
          detached: process.platform !== 'win32'
        });
      } catch (error) {
        finish(null, errorLine(error));
        return;
      }
      child.once('error', (error) => finish(null, errorLine(error)));
      child.once('close', (code) => {
        if (settled) return;
        if (timedOut || aborted) {
          finish(null, undefined);
          return;
        }
        if (code === 0) {
          completedSteps += 1;
          if (index + 1 < steps.length) {
            spawnStep(index + 1);
            return;
          }
        }
        finish(code, undefined);
      });
      if (timedOut || aborted) killTree(child);
    };

    if (timeoutMs !== undefined) timer = setTimeout(() => terminate('timeout'), timeoutMs);
    if (signal !== undefined) {
      onAbort = () => terminate('abort');
      if (signal.aborted) {
        aborted = true;
        finish(null, undefined);
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    spawnStep(0);
  });
}

/**
 * Resolve a caller-supplied path against a working directory.
 * @param path - absolute or relative path.
 * @param cwd - the working directory relative paths resolve against.
 * @returns an absolute path.
 */
export function resolveAgainst(path, cwd) {
  return isAbsolute(path) ? path : resolve(cwd, path);
}
