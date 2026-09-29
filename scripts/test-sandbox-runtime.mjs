/** Focused process, byte-budget, cleanup, and encoding checks for sandbox.js. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LANGUAGES,
  cleanupScratch,
  launchPlanForTest,
  readCaptureText,
  runProgram
} from '../lib/sandbox.js';

let checks = 0;
const check = (name, condition, detail = '') => {
  checks += 1;
  console.log(`${condition ? '[ok]  ' : '[FAIL]'} ${name}${detail ? ` - ${detail}` : ''}`);
  assert.ok(condition, name);
};

const scratch = mkdtempSync(join(tmpdir(), 'ctx-sandbox-runtime-'));
const workspace = mkdtempSync(join(tmpdir(), 'ctx-sandbox-workspace-'));
const base = {
  cwd: workspace,
  tmpDir: scratch,
  timeoutMs: 10_000,
  outputBudgetBytes: 256,
  headChars: 192,
  tailChars: 64
};

try {
  console.log('--- shared UTF-8 byte budget ---');
  const bounded = await runProgram({
    ...base,
    language: 'javascript',
    code: '/* UTF-8 stress sample */ process.stdout.write("🎯".repeat(120)); process.stderr.write("Ж".repeat(120)); process.exit(2);'
  });
  check('stdout and stderr share one 256-byte budget', bounded.boundedOutputBytes <= 256, `${bounded.boundedOutputBytes} bytes`);
  check('both streams contributed to the shared bound', bounded.stdoutTruncated && bounded.stderrTruncated);
  check('full UTF-8 byte metadata is exact', bounded.fullStdoutBytes === 480 && bounded.fullStderrBytes === 240);
  check('UTF-8 truncation never creates replacement characters', !bounded.stdout.includes('\uFFFD') && !bounded.stderr.includes('\uFFFD'));

  console.log('\n--- physically bounded head and rolling tail ---');
  const stdoutPayload = `STDOUT-HEAD-${'a'.repeat(5_000)}-STDOUT-TAIL-DONE`;
  const stderrPayload = `STDERR-HEAD-${'b'.repeat(3_000)}-STDERR-TAIL-DONE`;
  const capped = await runProgram({
    ...base,
    language: 'javascript',
    captureMaxBytesPerStream: 1_024,
    code: `process.stdout.write(${JSON.stringify(stdoutPayload)}); process.stderr.write(${JSON.stringify(stderrPayload)});`
  });
  const retainedStdout = readCaptureText(capped.stdoutCapture, 'stdout');
  const retainedStderr = readCaptureText(capped.stderrCapture, 'stderr');
  const stdoutStoredOnDisk = statSync(capped.spillPath).size + statSync(capped.stdoutTailPath).size;
  const stderrStoredOnDisk = statSync(capped.stderrPath).size + statSync(capped.stderrTailPath).size;
  check('capture cap does not change process success', capped.ok && capped.exitCode === 0 && capped.processStatus === 'success');
  check('stdout counters distinguish observed, stored, and dropped bytes', capped.stdoutCapture.observedBytes === Buffer.byteLength(stdoutPayload) && capped.stdoutCapture.storedBytes === 1_024 && capped.stdoutCapture.droppedBytes === Buffer.byteLength(stdoutPayload) - 1_024);
  check('stderr has an independent physical cap', capped.stderrCapture.observedBytes === Buffer.byteLength(stderrPayload) && capped.stderrCapture.storedBytes === 1_024 && capped.stderrCapture.droppedBytes === Buffer.byteLength(stderrPayload) - 1_024);
  check('capture files never exceed either per-stream cap', stdoutStoredOnDisk <= 1_024 && stderrStoredOnDisk <= 1_024, `${stdoutStoredOnDisk}/${stderrStoredOnDisk}`);
  check('retained stdout contains the head and final rolling tail', retainedStdout.startsWith('STDOUT-HEAD-') && retainedStdout.endsWith('-STDOUT-TAIL-DONE'));
  check('retained stderr contains the head and final rolling tail', retainedStderr.startsWith('STDERR-HEAD-') && retainedStderr.endsWith('-STDERR-TAIL-DONE'));
  check('Windows uses the broker rather than forbidden Node pipes', process.platform !== 'win32' || capped.captureBackend === 'powershell-broker');

  const multibyte = await runProgram({
    ...base,
    language: 'javascript',
    captureMaxBytesPerStream: 101,
    code: 'process.stdout.write("начало-" + "🎯".repeat(100) + "-конец");'
  });
  const retainedMultibyte = readCaptureText(multibyte.stdoutCapture, 'stdout');
  check('ring boundaries do not emit malformed UTF-8', !retainedMultibyte.includes('\uFFFD') && retainedMultibyte.includes('начало') && retainedMultibyte.endsWith('-конец'));

  console.log('\n--- detached capture finalization ---');
  let finishBackground;
  const backgroundFinal = new Promise((resolve) => { finishBackground = resolve; });
  const detached = await runProgram({
    ...base,
    language: 'javascript',
    captureMaxBytesPerStream: 256,
    timeoutMs: 60,
    background: true,
    code: 'process.stdout.write("DETACHED-HEAD-"); setTimeout(() => { process.stdout.write("x".repeat(1000) + "-DETACHED-TAIL"); }, 180); setTimeout(() => process.exit(0), 220);',
    onBackgroundFinal: finishBackground
  });
  check('detached result exposes provisional capture metadata', detached.backgrounded && detached.captureState === 'provisional' && detached.exitCode === null);
  const detachedFinal = await Promise.race([
    backgroundFinal,
    new Promise((_, reject) => setTimeout(() => reject(new Error('detached finalization callback timed out')), 5_000))
  ]);
  const retainedDetached = readCaptureText(detachedFinal.stdoutCapture, 'stdout');
  check('detached completion exposes exact final metadata', detachedFinal.captureState === 'final' && detachedFinal.captureComplete && detachedFinal.exitCode === 0);
  check('detached final capture keeps completion tail without killing producer', retainedDetached.endsWith('-DETACHED-TAIL'));

  console.log('\n--- successful stderr capture ---');
  const diagnostic = await runProgram({
    ...base,
    language: 'javascript',
    code: 'console.error("diagnostic-only"); console.log("visible-answer");'
  });
  check('successful stderr is absent from the ordinary result', diagnostic.stderr === '' && diagnostic.stdout.includes('visible-answer'));
  check('successful stderr remains discoverable through metadata', diagnostic.stderrCaptured && diagnostic.stderrSuppressed && diagnostic.fullStderrBytes > 0);
  check('successful stderr remains in its capture file', readFileSync(diagnostic.stderrPath, 'utf8').includes('diagnostic-only'));
  const successfulMixed = await runProgram({
    ...base,
    language: 'javascript',
    code: 'process.stdout.write("o".repeat(220)); process.stderr.write("🎯".repeat(20));'
  });
  check('successful hidden stderr still consumes the shared budget', successfulMixed.boundedOutputBytes <= 256 && successfulMixed.stderrTruncated);

  console.log('\n--- shell source encoding ---');
  const sample = 'Привет, Ёж 🎯';
  const shellCode = process.platform === 'win32'
    ? `Write-Output ${JSON.stringify(sample)}`
    : `printf '%s\\n' '${sample}'`;
  const shell = await runProgram({ ...base, language: 'shell', code: shellCode });
  check('shell preserves Cyrillic and emoji', shell.exitCode === 0 && shell.stdout.includes(sample), shell.stderr.trim());

  console.log('\n--- Rust compile/run plan ---');
  const rustPlan = launchPlanForTest('rust', join(scratch, 'plan.rs'), { rust: 'rustc-test' });
  check('Rust has compile and binary execution steps', rustPlan.steps.length === 2 && rustPlan.steps[0].command === 'rustc-test');
  check('Rust executes the generated binary', rustPlan.steps[1].command === rustPlan.cleanupPaths[0]);
  check('Rust generated binary is marked for cleanup', rustPlan.cleanupPaths.length === 1 && rustPlan.steps[0].args.includes(rustPlan.cleanupPaths[0]));

  console.log('\n--- timeout and AbortSignal kill descendants ---');
  const timeoutMarker = join(workspace, 'timeout-descendant.txt');
  const descendant = [
    'const { spawn } = await import("node:child_process");',
    `spawn(process.execPath, ["-e", ${JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(timeoutMarker)}, 'orphan'), 1400)`) }], { stdio: "ignore" });`,
    'setInterval(() => {}, 1000);'
  ].join('\n');
  const timed = await runProgram({ ...base, language: 'javascript', code: descendant, timeoutMs: 300 });
  await new Promise((resolve) => setTimeout(resolve, 1700));
  check('timeout is reported with no synthetic exit code', timed.timedOut === true && timed.exitCode === null);
  check('timeout kills the descendant process tree', !existsSync(timeoutMarker));

  const controller = new AbortController();
  setTimeout(() => controller.abort('focused test'), 200);
  const aborted = await runProgram({
    ...base,
    language: 'javascript',
    code: 'setInterval(() => {}, 1000);',
    signal: controller.signal
  });
  check('AbortSignal settles as aborted', aborted.aborted === true && aborted.exitCode === null && aborted.timedOut === false);

  console.log('\n--- scratch cleanup does not follow links ---');
  const cleanupRoot = mkdtempSync(join(tmpdir(), 'ctx-cleanup-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'ctx-cleanup-outside-'));
  try {
    writeFileSync(join(outside, 'must-survive.txt'), 'safe', 'utf8');
    writeFileSync(join(cleanupRoot, 'old.txt'), 'old', 'utf8');
    const oldDir = join(cleanupRoot, 'old-dir');
    mkdirSync(oldDir);
    writeFileSync(join(oldDir, 'nested.txt'), 'old', 'utf8');
    const link = join(cleanupRoot, 'outside-link');
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const swept = cleanupScratch(cleanupRoot, -1000);
    check('cleanup removes old owned files, directories, and links', swept.removed === 3 && !existsSync(oldDir) && !existsSync(link));
    check('cleanup never traverses the junction/symlink target', readFileSync(join(outside, 'must-survive.txt'), 'utf8') === 'safe');
  } finally {
    rmSync(cleanupRoot, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }

  check('shell remains an advertised runtime', LANGUAGES.includes('shell'));
  console.log(`\nall ${checks} sandbox runtime checks passed`);
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
  rmSync(workspace, { recursive: true, force: true, maxRetries: 5 });
}
