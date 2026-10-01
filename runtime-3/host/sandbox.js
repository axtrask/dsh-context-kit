/**
 * The sandbox behind context-mode: run a program, keep only its stdout.
 *
 * Upstream context-mode intercepts the harness's own tools and re-routes bulky
 * work into a subprocess. In this port the subprocess IS the tool: the model
 * writes a program, the program runs in the session workspace, and only a
 * bounded preview reaches the conversation. A configurable head and rolling
 * tail stay on disk for indexing; bytes between them may be discarded.
 *
 * On Windows a PowerShell/.NET broker owns the redirected streams. Asking Node
 * for `stdio: 'pipe'` is denied by the confined harness (`spawn EPERM`), while
 * truncating an inherited regular file races the producer's independent file
 * offset. The broker keeps draining both streams after the physical cap and
 * never terminates a producer merely because its output is large.
 *
 * @module dsh-context-kit/sandbox
 */

import { spawn, spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BoundedCaptureSink, capturePaths, emptyCapture, normalizeCaptureMaxBytes, readCaptureManifest, writeControlRequest } from './bounded-capture.js';
import { codePointLength, errorLine } from './common.js';

const WINDOWS_CAPTURE_BROKER = fileURLToPath(new URL('./bounded-capture.ps1', import.meta.url));
const backgroundChildren = new Map();

/** Kill detached programs owned by one plugin/session (or every owner). */
export function terminateBackgroundProcesses(filter = {}) {
  let terminated = 0;
  for (const [token, entry] of backgroundChildren) {
    if (filter.owner !== undefined && entry.owner !== filter.owner) continue;
    if (filter.session !== undefined && entry.session !== filter.session) continue;
    backgroundChildren.delete(token);
    entry.cancelled = true;
    entry.requestTermination?.('dispose');
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
const resolvedRuntimes = new Map();

function runnable(command, versionArgs = ['--version']) {
  const isWindows = process.platform === 'win32';
  let candidates = [command];
  if (isWindows && !isAbsolute(command)) {
    const extensions = extname(command).length > 0
      ? ['']
      : String(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
    candidates = String(process.env.PATH ?? '').split(delimiter).flatMap((entry) => {
      const directory = entry.replace(/^"|"$/g, '');
      return extensions.map((extension) => join(directory, `${command}${extension}`));
    }).filter((path) => {
      if (/\\Microsoft\\WindowsApps\\/i.test(path)) return false;
      try { return lstatSync(path).isFile(); } catch { return false; }
    });
  } else if (!isWindows) {
    try {
      const probe = spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
      if (probe.status !== 0) return false;
    } catch {
      return false;
    }
  }
  for (const candidate of candidates) {
    for (const args of [versionArgs, ['version'], ['-version'], ['--help']]) {
      try {
        const version = spawnSync(candidate, args, { stdio: 'ignore', timeout: 5000, shell: false });
        if (version.status === 0 || version.status === 1) {
          resolvedRuntimes.set(command, candidate);
          return true;
        }
      } catch {
        /* try the next flag */
      }
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
    if (runnable(candidate)) return resolvedRuntimes.get(candidate) ?? candidate;
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
    javascript: process.release?.name === 'node' ? process.execPath : firstRunnable(['node']),
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
function readCaptureBuffer(path, expectedBytes) {
  try {
    const data = readFileSync(path);
    return Number.isSafeInteger(expectedBytes) && expectedBytes >= 0
      ? data.subarray(0, Math.min(data.length, expectedBytes))
      : data;
  } catch {
    return Buffer.alloc(0);
  }
}

/**
 * Reconstruct the retained head and tail in chronological order.
 *
 * A provisional tail is still a ring; a final tail has already been rotated by
 * the sink. The omission marker is metadata, not producer output, and therefore
 * does not consume the physical capture budget.
 */
export function readCaptureText(capture, streamName = 'output') {
  if (capture === undefined || capture === null) return '';
  const head = readCaptureBuffer(capture.headPath, capture.headBytes);
  let tail = readCaptureBuffer(capture.tailPath, capture.tailBytes);
  const cursor = Math.max(0, Math.min(tail.length, Number(capture.tailCursor ?? 0)));
  if (capture.tailWrapped === true && tail.length > 0 && cursor > 0) {
    tail = Buffer.concat([tail.subarray(cursor), tail.subarray(0, cursor)]);
  }
  const dropped = Math.max(0, Number(capture.droppedBytes ?? 0));
  if (dropped === 0) return Buffer.concat([head, tail]).toString('utf8');
  const marker = `\n\n[... ${dropped} ${streamName} bytes omitted by capture cap ...]\n\n`;
  return `${utf8Prefix(head, head.length)}${marker}${utf8Suffix(tail, tail.length)}`;
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
function captureBudget(merged) {
  const candidate = merged.outputBudgetBytes ?? merged.passThroughBytes ?? merged.passThroughChars;
  const fallback = Math.max(0, Number(merged.headChars ?? 0) + Number(merged.tailChars ?? 0));
  return Number.isFinite(candidate) && candidate >= 0 ? candidate : fallback;
}

function captureManifestFromSinks(stdoutSink, stderrSink, state, complete, values = {}) {
  return {
    state,
    complete,
    generation: values.generation ?? 0,
    updatedAt: Date.now(),
    completedSteps: values.completedSteps ?? 0,
    exitCode: values.exitCode ?? null,
    spawnError: values.spawnError,
    terminationReason: values.terminationReason,
    stdout: stdoutSink?.snapshot() ?? values.stdout,
    stderr: stderrSink?.snapshot() ?? values.stderr
  };
}

function buildRunResult(merged, details) {
  const manifest = details.manifest;
  const rawOut = readCaptureText(manifest.stdout, 'stdout');
  const rawErr = readCaptureText(manifest.stderr, 'stderr');
  const budgetBytes = captureBudget(merged);
  const bounded = boundCombined(
    rawOut,
    rawErr,
    budgetBytes,
    Math.max(0, Number(merged.headChars ?? 0)),
    Math.max(0, Number(merged.tailChars ?? 0))
  );
  const running = details.backgrounded === true && manifest.state !== 'final';
  const signal = details.signal ?? null;
  const exitCode = Number.isInteger(details.exitCode) ? details.exitCode : null;
  const spawnError = details.spawnError ?? manifest.spawnError;
  const success = !running
    && spawnError === undefined
    && details.timedOut !== true
    && details.aborted !== true
    && signal === null
    && exitCode === 0;
  const processStatus = running
    ? 'running'
    : spawnError !== undefined
      ? 'spawn_failed'
      : details.timedOut === true
        ? 'timeout'
        : details.aborted === true
          ? 'aborted'
          : signal !== null
            ? 'signaled'
            : exitCode === 0
              ? 'success'
              : 'nonzero_exit';
  const stderrText = success || running ? '' : bounded.stderr.text;
  return {
    ok: running || success,
    processStatus,
    backgrounded: details.backgrounded === true,
    spawnError,
    timedOut: details.timedOut === true,
    aborted: details.aborted === true,
    signal,
    stdout: bounded.stdout.text,
    stderr: stderrText,
    fullStdoutChars: codePointLength(rawOut),
    fullStderrChars: codePointLength(rawErr),
    fullStdoutBytes: manifest.stdout.observedBytes,
    fullStderrBytes: manifest.stderr.observedBytes,
    boundedOutputBytes: bounded.renderedBytes,
    renderedOutputBytes: Buffer.byteLength(bounded.stdout.text) + Buffer.byteLength(stderrText),
    outputBudgetBytes: budgetBytes,
    stdoutTruncated: bounded.stdout.truncated,
    stderrTruncated: bounded.stderr.truncated,
    previewTruncated: bounded.stdout.truncated || bounded.stderr.truncated,
    captureTruncated: manifest.stdout.truncated || manifest.stderr.truncated,
    stderrCaptured: manifest.stderr.observedBytes > 0,
    stderrSuppressed: (success || running) && manifest.stderr.observedBytes > 0,
    completedSteps: manifest.completedSteps,
    exitCode,
    durationMs: Date.now() - details.startedAt,
    scriptPath: details.scriptPath,
    spillPath: manifest.stdout.headPath,
    stdoutTailPath: manifest.stdout.tailPath,
    stderrPath: manifest.stderr.headPath,
    stderrTailPath: manifest.stderr.tailPath,
    captureManifestPath: details.captureManifestPath,
    captureBackend: details.captureBackend,
    captureState: manifest.state,
    captureComplete: manifest.state === 'final' && manifest.complete,
    stdoutCapture: manifest.stdout,
    stderrCapture: manifest.stderr,
    capture: {
      backend: details.captureBackend,
      state: manifest.state,
      complete: manifest.state === 'final' && manifest.complete,
      manifestPath: details.captureManifestPath,
      stdout: manifest.stdout,
      stderr: manifest.stderr
    }
  };
}

/**
 * Run generated code with independently bounded stdout and stderr capture.
 * The cap affects storage only: both streams continue to drain until EOF.
 */
export function runProgram(options, overrides = {}) {
  const merged = { ...options, ...overrides };
  const language = merged.language;
  if (!LANGUAGES.includes(language)) {
    return Promise.reject(new Error(`unsupported language ${JSON.stringify(language)}; supported: ${LANGUAGES.join(', ')}`));
  }

  let captureMaxBytesPerStream;
  try {
    captureMaxBytesPerStream = normalizeCaptureMaxBytes(merged.captureMaxBytesPerStream);
  } catch (error) {
    return Promise.reject(error);
  }

  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(merged.tmpDir, { recursive: true });
  const scriptPath = join(merged.tmpDir, `${stamp}.${extensionFor(language)}`);
  const paths = capturePaths(merged.tmpDir, stamp);

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
  const signal = merged.signal;
  const timeoutMs = Number.isFinite(merged.timeoutMs) && merged.timeoutMs > 0 ? merged.timeoutMs : undefined;
  const emptyStdout = emptyCapture(paths, 'stdout');
  const emptyStderr = emptyCapture(paths, 'stderr');

  if (process.platform === 'win32') {
    return new Promise((settle) => {
      const brokerPlan = {
        version: 1,
        cwd: merged.cwd,
        steps,
        captureMaxBytesPerStream,
        ...paths
      };
      try {
        writeFileSync(paths.brokerPlanPath, JSON.stringify(brokerPlan), 'utf8');
      } catch (error) {
        cleanupGenerated(plan.cleanupPaths);
        settle(buildRunResult(merged, {
          manifest: captureManifestFromSinks(undefined, undefined, 'final', false, {
            stdout: emptyStdout,
            stderr: emptyStderr,
            spawnError: errorLine(error)
          }),
          spawnError: errorLine(error),
          exitCode: null,
          timedOut: false,
          aborted: false,
          startedAt,
          scriptPath,
          captureManifestPath: paths.manifestPath,
          captureBackend: 'powershell-broker'
        }));
        return;
      }

      let child;
      let returned = false;
      let completed = false;
      let timedOut = false;
      let aborted = false;
      let terminationFallback;
      let timer;
      let onAbort;
      const token = `${stamp}:broker`;
      const backgroundEntry = {
        child: undefined,
        owner: merged.backgroundOwner,
        session: merged.backgroundSession,
        cancelled: false,
        requestTermination: (reason) => {
          try { writeControlRequest(paths.controlPath, { action: 'terminate', reason }); } catch { }
        }
      };

      const currentManifest = (forceFinal = false) => {
        const stored = readCaptureManifest(paths.manifestPath, paths);
        if (stored !== undefined) {
          if (forceFinal && stored.state !== 'final') return { ...stored, state: 'final', complete: false };
          return stored;
        }
        return captureManifestFromSinks(undefined, undefined, forceFinal ? 'final' : 'provisional', false, {
          stdout: emptyStdout,
          stderr: emptyStderr
        });
      };

      const releaseListeners = () => {
        if (timer !== undefined) clearTimeout(timer);
        if (terminationFallback !== undefined) clearTimeout(terminationFallback);
        if (signal !== undefined && onAbort !== undefined) signal.removeEventListener('abort', onAbort);
      };

      const finish = (brokerCode, brokerSignal, brokerError) => {
        if (completed) return;
        completed = true;
        releaseListeners();
        backgroundChildren.delete(token);
        const manifest = currentManifest(true);
        const localSpawnError = brokerError
          ?? manifest.spawnError
          ?? (brokerCode !== 0 && !timedOut && !aborted ? `capture broker exited with code ${brokerCode}` : undefined);
        const result = buildRunResult(merged, {
          manifest,
          spawnError: localSpawnError,
          exitCode: timedOut || aborted ? null : manifest.exitCode,
          signal: timedOut || aborted ? null : brokerSignal,
          timedOut,
          aborted,
          startedAt,
          scriptPath,
          captureManifestPath: paths.manifestPath,
          captureBackend: 'powershell-broker',
          backgrounded: false
        });
        cleanupGenerated([...plan.cleanupPaths, paths.brokerPlanPath, paths.controlPath]);
        if (!returned) {
          returned = true;
          settle(result);
        } else if (!backgroundEntry.cancelled && typeof merged.onBackgroundFinal === 'function') {
          Promise.resolve(merged.onBackgroundFinal(result)).catch(() => {});
        }
      };

      const requestTermination = (reason) => {
        if (completed) return;
        if (reason === 'timeout') timedOut = true;
        else aborted = true;
        backgroundEntry.requestTermination(reason);
        terminationFallback = setTimeout(() => killTree(child), 1000);
        terminationFallback.unref?.();
      };

      const detach = () => {
        if (completed || returned) return;
        returned = true;
        releaseListeners();
        try { writeControlRequest(paths.controlPath, { action: 'snapshot' }); } catch { }
        backgroundEntry.child = child;
        backgroundChildren.set(token, backgroundEntry);
        child.unref();
        settle(buildRunResult(merged, {
          manifest: currentManifest(false),
          exitCode: null,
          timedOut: true,
          aborted: false,
          startedAt,
          scriptPath,
          captureManifestPath: paths.manifestPath,
          captureBackend: 'powershell-broker',
          backgrounded: true
        }));
      };

      try {
        child = spawn(detectRuntimes().shell, [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy', 'Bypass',
          '-File', WINDOWS_CAPTURE_BROKER,
          '-PlanPath', paths.brokerPlanPath
        ], {
          cwd: merged.cwd,
          env: { ...sandboxEnv(process.env), ...(merged.env ?? {}) },
          stdio: ['ignore', 'ignore', 'ignore'],
          windowsHide: true
        });
        backgroundEntry.child = child;
      } catch (error) {
        finish(null, null, errorLine(error));
        return;
      }
      child.once('error', (error) => finish(null, null, errorLine(error)));
      child.once('close', (code, closeSignal) => finish(code, closeSignal, undefined));

      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (merged.background === true) detach();
          else requestTermination('timeout');
        }, timeoutMs);
      }
      if (signal !== undefined) {
        onAbort = () => requestTermination('abort');
        if (signal.aborted) {
          requestTermination('abort');
        } else {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }
    });
  }

  return new Promise((settle) => {
    let stdoutSink;
    let stderrSink;
    try {
      stdoutSink = new BoundedCaptureSink(paths.stdoutHeadPath, paths.stdoutTailPath, captureMaxBytesPerStream);
      stderrSink = new BoundedCaptureSink(paths.stderrHeadPath, paths.stderrTailPath, captureMaxBytesPerStream);
    } catch (error) {
      stdoutSink?.close();
      stderrSink?.close();
      cleanupGenerated(plan.cleanupPaths);
      settle(buildRunResult(merged, {
        manifest: captureManifestFromSinks(undefined, undefined, 'final', false, {
          stdout: emptyStdout,
          stderr: emptyStderr,
          spawnError: errorLine(error)
        }),
        spawnError: errorLine(error),
        exitCode: null,
        timedOut: false,
        aborted: false,
        startedAt,
        scriptPath,
        captureManifestPath: paths.manifestPath,
        captureBackend: 'node-pipe'
      }));
      return;
    }

    let child;
    let returned = false;
    let completed = false;
    let foregroundTimedOut = false;
    let aborted = false;
    let completedSteps = 0;
    let timer;
    let onAbort;
    let captureError;
    const token = `${stamp}:pipe`;
    const backgroundEntry = {
      child: undefined,
      owner: merged.backgroundOwner,
      session: merged.backgroundSession,
      cancelled: false,
      requestTermination: () => killTree(backgroundEntry.child)
    };

    const manifest = (state, complete, values = {}) => captureManifestFromSinks(
      stdoutSink,
      stderrSink,
      state,
      complete,
      { completedSteps, ...values }
    );

    const releaseListeners = () => {
      if (timer !== undefined) clearTimeout(timer);
      if (signal !== undefined && onAbort !== undefined) signal.removeEventListener('abort', onAbort);
    };

    const finish = (exitCode, closeSignal, spawnError) => {
      if (completed) return;
      completed = true;
      releaseListeners();
      backgroundChildren.delete(token);
      let captureComplete = true;
      try {
        stdoutSink.finalize();
        stderrSink.finalize();
      } catch (error) {
        captureError ??= errorLine(error);
        captureComplete = false;
      }
      const finalManifest = manifest('final', captureComplete, {
        exitCode,
        spawnError: spawnError ?? captureError,
        terminationReason: foregroundTimedOut ? 'timeout' : aborted ? 'abort' : undefined
      });
      stdoutSink.close();
      stderrSink.close();
      const result = buildRunResult(merged, {
        manifest: finalManifest,
        spawnError: spawnError ?? captureError,
        exitCode: foregroundTimedOut || aborted ? null : exitCode,
        signal: foregroundTimedOut || aborted ? null : closeSignal,
        timedOut: foregroundTimedOut,
        aborted,
        startedAt,
        scriptPath,
        captureManifestPath: undefined,
        captureBackend: 'node-pipe',
        backgrounded: false
      });
      cleanupGenerated(plan.cleanupPaths);
      if (!returned) {
        returned = true;
        settle(result);
      } else if (!backgroundEntry.cancelled && typeof merged.onBackgroundFinal === 'function') {
        Promise.resolve(merged.onBackgroundFinal(result)).catch(() => {});
      }
    };

    const spawnStep = (index) => {
      if (completed) return;
      const step = steps[index];
      try {
        child = spawn(step.command, step.args, {
          cwd: merged.cwd,
          env: { ...sandboxEnv(process.env), ...(merged.env ?? {}) },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          detached: true
        });
        backgroundEntry.child = child;
      } catch (error) {
        finish(null, null, errorLine(error));
        return;
      }
      child.stdout.on('data', (chunk) => {
        try { stdoutSink.write(chunk); } catch (error) { captureError ??= errorLine(error); killTree(child); }
      });
      child.stderr.on('data', (chunk) => {
        try { stderrSink.write(chunk); } catch (error) { captureError ??= errorLine(error); killTree(child); }
      });
      child.once('error', (error) => finish(null, null, errorLine(error)));
      child.once('close', (code, closeSignal) => {
        if (completed) return;
        if (foregroundTimedOut || aborted || captureError !== undefined) {
          finish(null, closeSignal, captureError);
          return;
        }
        if (code === 0) {
          completedSteps += 1;
          if (index + 1 < steps.length) {
            spawnStep(index + 1);
            return;
          }
        }
        finish(code, closeSignal, undefined);
      });
      if (foregroundTimedOut || aborted) killTree(child);
    };

    const terminate = (reason) => {
      if (completed) return;
      if (reason === 'timeout' && merged.background === true && !returned) {
        returned = true;
        releaseListeners();
        backgroundChildren.set(token, backgroundEntry);
        child?.unref();
        settle(buildRunResult(merged, {
          manifest: manifest('provisional', true),
          exitCode: null,
          timedOut: true,
          aborted: false,
          startedAt,
          scriptPath,
          captureManifestPath: undefined,
          captureBackend: 'node-pipe',
          backgrounded: true
        }));
        return;
      }
      if (reason === 'timeout') foregroundTimedOut = true;
      else aborted = true;
      killTree(child);
    };

    if (timeoutMs !== undefined) timer = setTimeout(() => terminate('timeout'), timeoutMs);
    if (signal !== undefined) {
      onAbort = () => terminate('abort');
      if (signal.aborted) aborted = true;
      else signal.addEventListener('abort', onAbort, { once: true });
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
