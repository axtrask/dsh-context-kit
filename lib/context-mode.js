/**
 * context-mode — ported to DeepSeek Harness.
 *
 * Upstream context-mode is an MCP server that keeps bulk out of the model's
 * context window three ways: it runs work in a sandbox and returns only stdout,
 * it indexes everything it sees into a searchable store, and it blocks the
 * "dump the whole file into the conversation" routes. This port keeps all
 * three, as native harness tools rather than an MCP server:
 *
 * - **Sandbox** — `ctx_execute`, `ctx_execute_file`, `ctx_batch_execute` run a
 *   program in the session workspace and return bounded stdout with a pointer
 *   to the full output. This replaces the upstream `ctx_execute` and
 *   `ctx_batch_execute`, and it is the port of "think in code".
 * - **Knowledge base** — `ctx_index`, `ctx_fetch_and_index`, and `ctx_search`
 *   put arbitrary content into a local SQLite FTS5 index (Node's own
 *   `node:sqlite`, no native build) and answer questions with matching lines
 *   instead of file pastes. This replaces upstream's session memory.
 * - **Routing** — `ctx_stats`, `ctx_doctor`, `ctx_purge`, the `/ctx` command,
 *   and an optional `tools/pre-execute` guard that refuses the commands
 *   upstream refuses (`curl`, `wget`, inline HTTP) and names the tool to use
 *   instead.
 *
 * The harness already sandboxes and spills shell output (`dsh-spill-policy`);
 * what this adds is a *searchable* store with a stable source label, which is
 * the part that makes "look it up later" cheaper than "read it now".
 *
 * @module dsh-context-kit/context-mode
 */

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';

import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';

import { dshHome, errorLine, isRecord, pathsOutsideWorkspace, readTextIfPresent } from './common.js';
import { grepGuidance, readGuidance, routingBlock, shellGuidance } from './context-mode-guidance.js';
import { fetchOneUrl } from './context-mode-fetch.js';
import { DEFAULT_CAPTURE_MAX_BYTES_PER_STREAM, MAX_CAPTURE_MAX_BYTES_PER_STREAM } from './bounded-capture.js';
import { KnowledgeBase, estimateTokens } from './knowledge-base.js';
import { LANGUAGES, cleanupScratch, readCaptureText, resolveAgainst, runProgram, terminateBackgroundProcesses } from './sandbox.js';

export const name = 'context-mode';
export const inject = ['tools'];

/** Plugin identity recorded on injected messages and diagnostics. */
const PLUGIN_ID = 'context-mode';

/**
 * Whether one shell segment fetches into the conversation, by upstream's rule.
 *
 * Upstream decides PER SEGMENT and only denies a fetch whose bytes would land in
 * the conversation (`hooks/core/routing.mjs:738-765`). A `curl`/`wget` that is
 * silent AND writes to a file is deliberately ALLOWED, because the body never
 * reaches the model; the port denied it, which broke a legitimate and common
 * command. The rules, in upstream's order:
 *
 * 1. no file output (`-o`/`-O`/`--output`/`--output-document`, or a redirect) — dangerous;
 * 2. output aliased back to stdout (`-o -`, `-o /dev/stdout`) — dangerous;
 * 3. verbose/trace flags flood stderr — dangerous;
 * 4. not silent (curl `-s`/`--silent`, wget `-q`/`--quiet`) — dangerous, progress bars flood stderr;
 *
 * @param segment - one command segment, already split on `;`, `&&`, `|`, newlines.
 * @returns true when this segment would pull a body into the conversation.
 */
function segmentFetchesIntoContext(segment) {
  // The segment must BEGIN (possibly after a pipeline, `;`, `&&`, or `(`) with a
  // fetch command. Upstream matches the word anywhere in the segment, so
  // `grep -r curl src/` and a commit message mentioning wget are denied as
  // dangerous fetches — a false positive the model cannot act on. Still safer than
  // upstream: a real fetch starts its own segment.
  const command = String.raw`(?:&\s*)?(?:curl(?:\.exe)?|wget(?:\.exe)?|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)`;
  if (!new RegExp(String.raw`(^|[;&|(\n]\s*)\s*${command}\b`, 'i').test(segment)) return false;
  const isCurl = /(^|[;&|(\n]\s*)\s*(?:&\s*)?curl(?:\.exe)?\b/i.test(segment);
  const isWget = /(^|[;&|(\n]\s*)\s*(?:&\s*)?wget(?:\.exe)?\b/i.test(segment);
  const isPowerShell = /(^|[;&|(\n]\s*)\s*(?:&\s*)?(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b/i.test(segment);
  if (isPowerShell) {
    const fileOutput = /\s-(?:OutFile|o)\s+\S+/i.test(segment) || /\s*>{1,2}\s*\S+/.test(segment);
    return !fileOutput;
  }
  const hasFileOutput = isCurl
    ? (/\s(-o|--output)\s/.test(segment) || /\s*>\s*/.test(segment) || /\s*>>\s*/.test(segment))
    : (/\s(-O|--output-document)\s/.test(segment) || /\s*>\s*/.test(segment) || /\s*>>\s*/.test(segment));
  if (!hasFileOutput) return true;
  if (isCurl && /\s(-o|--output)\s+(-|\/dev\/stdout)(\s|$)/.test(segment)) return true;
  if (isWget && /\s(-O|--output-document)\s+(-|\/dev\/stdout)(\s|$)/.test(segment)) return true;
  if (/\s(-v|--verbose|--trace|-D\s+-)\b/.test(segment)) return true;
  const isSilent = isCurl ? /\s-[a-zA-Z]*s|--silent/.test(segment) : /\s-[a-zA-Z]*q|--quiet/.test(segment);
  if (!isSilent) return true;
  return false;
}

/**
 * Whether a shell command fetches a URL into the conversation.
 *
 * Splitting first is what makes `git status && curl -s -o out.json URL` legal
 * while `curl URL` is not: only the segment that actually fetches decides.
 *
 * @param command - the whole shell command line.
 * @returns true when any segment would flood the conversation with a body.
 */
function commandFetchesIntoContext(command) {
  return command.split(/[\n;]|&&|\|\|?/).some((segment) => segmentFetchesIntoContext(segment));
}

/**
 * A verbose build tool, which upstream redirects for the same reason: the output
 * is enormous and almost never worth its bytes (`routing.mjs:807-812`).
 */
const BUILD_TOOL_PATTERN = new RegExp(
  String.raw`(^|\s|&&|\||\;)(\./gradlew|gradlew|gradle|\./mvnw|mvnw|mvn|\./sbt|sbt)(\s|$)`,
  'i'
);

/**
 * Shell commands that perform HTTP inline, which upstream also intercepts.
 *
 * Upstream's own patterns, which are deliberately narrow so prose is not a hit:
 * `fetch("http…")`, `requests.get(`, `http.get(`, `http.request(` — evaluated on
 * the command with heredocs removed (`routing.mjs:788-805`). The port matched
 * `new-object system.net.webclient` and `python -c … requests` instead, and its
 * pattern missed a bare `fetch("http://…")` that upstream blocks.
 */
const INLINE_HTTP_PATTERNS = [
  /fetch\s*\(\s*['"](?:https?:\/\/|http)/i,
  /requests\.(?:get|post|put)\s*\(/i,
  /http\.(?:get|request)\s*\(/i
];

/**
 * Remove heredoc bodies before matching, so `cat <<EOF … requests.get … EOF` is
 * not mistaken for a call (`routing.mjs:788-793`).
 *
 * @param command - the shell command line.
 * @returns the command with heredoc bodies removed.
 */
function stripHeredocs(command) {
  return command.replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\s*\1/g, '');
}

/** Languages accepted by the sandbox tools. */
const LANGUAGE_ENUM = [...LANGUAGES];

/**
 * The upstream Insight dashboard `ctx_insight` points at.
 *
 * @see {@link insightResult} for why this port never opens it itself.
 */
const INSIGHT_URL = 'https://context-mode.com/insight';

/* ------------------------------------------------------------------ config */

/**
 * Plugin configuration.
 *
 * The `search*` keys carry upstream's flood guard and its result budget.
 * `searchLimit` is only the default for a call that passes no `limit`: no call
 * ever returns more than two hits per query, and one hit once the soft cap is
 * passed. That ceiling is upstream's (`Math.min(limit, 2)`) and it is
 * deliberately not configurable — a knob that raised it would defeat the
 * throttle the other three keys exist to implement.
 */
export const Config = z.object({
  enabled: z.boolean().default(true),
  knowledgeBasePath: z.string().default(''),
  // Upstream's own threshold: `LARGE_OUTPUT_THRESHOLD = 102_400` bytes
  // (`src/server.ts:1980`). Below it stdout is returned in full, above it the
  // capture is bounded and the full text is reached through the index. This is
  // the single output budget; `headChars`/`tailChars` are only the minimum split
  // used when a bound does apply.
  maxOutputChars: z.number().step(1).min(256).default(102400),
  // Physical retained-byte budget, independently for stdout and stderr. The
  // runner keeps draining after this cap and stores a head plus rolling tail.
  captureMaxBytesPerStream: z.number().step(1).min(2).max(MAX_CAPTURE_MAX_BYTES_PER_STREAM).default(DEFAULT_CAPTURE_MAX_BYTES_PER_STREAM),
  headChars: z.number().step(1).min(0).default(6000),
  tailChars: z.number().step(1).min(0).default(2000),
  timeoutMs: z.number().step(1).min(1000).default(120000),
  batchConcurrency: z.number().step(1).min(1).default(4),
  searchLimit: z.number().step(1).min(1).default(3),
  searchWindowMs: z.number().step(1).min(1).default(60000),
  searchSoftCap: z.number().step(1).min(1).default(3),
  searchBlockCap: z.number().step(1).min(1).default(8),
  searchMaxChars: z.number().step(1).min(512).default(40960),
  autoIndex: z.boolean().default(true),
  routingGuard: z.boolean().default(true),
  // Match the host's read capability by default. Operators that need a hard
  // project boundary can opt into it from Settings > Plugins.
  restrictPathsToWorkspace: z.boolean().default(false),
  // Upstream always injects its guidance; the switch exists so an operator can
  // turn the block off when another plugin owns the prompt budget.
  guidance: z.boolean().default(true),
  // Upstream composes the `<ctx_commands>` table into the same block and omits it
  // in harnesses that have no commands; DSH has commands, so it is on by default.
  commands: z.boolean().default(true),
  scratchRetentionMs: z.number().step(1).min(0).default(24 * 60 * 60 * 1000)
});

/** Configuration keys `context-mode.jsonc` may set. */
const CONFIG_KEYS = new Set([
  'enabled',
  'knowledgeBasePath',
  'maxOutputChars',
  'captureMaxBytesPerStream',
  'headChars',
  'tailChars',
  'timeoutMs',
  'batchConcurrency',
  'searchLimit',
  'searchWindowMs',
  'searchSoftCap',
  'searchBlockCap',
  'searchMaxChars',
  'autoIndex',
  'routingGuard',
  'restrictPathsToWorkspace',
  'guidance',
  'commands',
  'scratchRetentionMs'
]);

/** Merge the row configuration with an optional `context-mode.jsonc`. */
function resolveConfig(config, logger) {
  const home = process.env.DSH_HOME;
  if (typeof home !== 'string' || home.length === 0) return config;
  const file = readTextIfPresent(join(home, 'context-mode.jsonc'));
  if (file === undefined) return config;
  let parsed;
  try {
    parsed = JSON.parse(stripJsonComments(file));
  } catch (error) {
    logger.warn(`${PLUGIN_ID}: ignoring invalid context-mode.jsonc: ${errorLine(error)}`);
    return config;
  }
  if (!isRecord(parsed)) {
    logger.warn(`${PLUGIN_ID}: ignoring context-mode.jsonc — it must contain a JSON object`);
    return config;
  }
  const accepted = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!CONFIG_KEYS.has(key)) {
      logger.warn(`${PLUGIN_ID}: context-mode.jsonc sets unknown key "${key}"; ignoring it`);
      continue;
    }
    if (key === 'captureMaxBytesPerStream'
      && (!Number.isSafeInteger(value) || value < 2 || value > MAX_CAPTURE_MAX_BYTES_PER_STREAM)) {
      logger.warn(`${PLUGIN_ID}: context-mode.jsonc sets invalid captureMaxBytesPerStream; expected an integer from 2 to ${MAX_CAPTURE_MAX_BYTES_PER_STREAM}`);
      continue;
    }
    accepted[key] = value;
  }
  if (Object.keys(accepted).length === 0) return config;
  logger.info(`${PLUGIN_ID}: context-mode.jsonc applied (${Object.keys(accepted).join(', ')})`);
  return { ...config, ...accepted };
}

/** Strip JSONC comments without touching quoted strings. */
function stripJsonComments(text) {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      output += '\n';
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < text.length - 1 && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index += 1;
      continue;
    }
    output += char;
  }
  return output;
}

/* -------------------------------------------------------------- tools: core */

/** The session workspace an execution runs in. */
function cwdOf(exec) {
  const header = exec?.agent?.session?.header;
  const cwd = header?.cwd;
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd();
}

/**
 * The flood-guard bucket one call belongs to.
 *
 * The session id, never the process: search throttling is a per-agent
 * permission, so one session's burst must not spend another's budget. Calls
 * that arrive without an attributable session share the `__default__` bucket,
 * which is upstream's fallback name.
 *
 * @param exec - the tool execution.
 * @returns the guard key for this call.
 */
function sessionKeyOf(exec) {
  const id = exec?.agent?.session?.id;
  return typeof id === 'string' && id.length > 0 ? id : '__default__';
}

/** Resolve a caller path, optionally enforcing the session workspace boundary. */
function toolPath(input, exec, toolName, restrictToWorkspace) {
  const cwd = cwdOf(exec);
  const path = resolveAgainst(input, cwd);
  if (restrictToWorkspace && pathsOutsideWorkspace(path, cwd)) {
    throw new Error(`${toolName}: refused path outside the session workspace (${cwd}): ${path}`);
  }
  return path;
}

/** Inject upstream-compatible file variables around one code snippet. */
function wrapFileContent(path, language, code) {
  const escaped = JSON.stringify(path);
  if (language === 'javascript' || language === 'typescript') {
    return `const FILE_CONTENT_PATH = ${escaped};\nconst file_path = FILE_CONTENT_PATH;\nconst FILE_CONTENT = (await import('node:fs')).readFileSync(FILE_CONTENT_PATH, 'utf8');\n${code}`;
  }
  if (language === 'python') {
    return `FILE_CONTENT_PATH = ${escaped}\nfile_path = FILE_CONTENT_PATH\nwith open(FILE_CONTENT_PATH, "r", encoding="utf-8") as _f:\n    FILE_CONTENT = _f.read()\n${code}`;
  }
  if (language === 'shell') {
    if (process.platform === 'win32') {
      return `$FILE_CONTENT_PATH = $env:CTX_FILE\n$file_path = $FILE_CONTENT_PATH\n$FILE_CONTENT = [System.IO.File]::ReadAllText($FILE_CONTENT_PATH)\n${code}`;
    }
    const quoted = `'${path.replace(/'/g, `'\\''`)}'`;
    return `FILE_CONTENT_PATH=${quoted}\nfile_path=${quoted}\nFILE_CONTENT=$(cat ${quoted})\n${code}`;
  }
  if (language === 'ruby') return `FILE_CONTENT_PATH = ${escaped}\nfile_path = FILE_CONTENT_PATH\nFILE_CONTENT = File.read(FILE_CONTENT_PATH, encoding: "utf-8")\n${code}`;
  if (language === 'go') return `package main\n\nimport (\n\t"fmt"\n\t"os"\n)\n\nvar FILE_CONTENT_PATH = ${escaped}\nvar file_path = FILE_CONTENT_PATH\n\nfunc main() {\n\tb, _ := os.ReadFile(FILE_CONTENT_PATH)\n\tFILE_CONTENT := string(b)\n\t_ = FILE_CONTENT\n\t_ = fmt.Sprint()\n${code}\n}\n`;
  if (language === 'rust') return `#![allow(unused_variables)]\nuse std::fs;\n\nfn main() {\n    let file_content_path = ${escaped};\n    let file_path = file_content_path;\n    let file_content = fs::read_to_string(file_content_path).unwrap();\n${code}\n}\n`;
  if (language === 'php') return `<?php\n$FILE_CONTENT_PATH = ${escaped};\n$file_path = $FILE_CONTENT_PATH;\n$FILE_CONTENT = file_get_contents($FILE_CONTENT_PATH);\n${code}`;
  if (language === 'perl') return `my $FILE_CONTENT_PATH = ${escaped};\nmy $file_path = $FILE_CONTENT_PATH;\nopen(my $fh, '<:encoding(UTF-8)', $FILE_CONTENT_PATH) or die "Cannot open: $!";\nmy $FILE_CONTENT = do { local $/; <$fh> };\nclose($fh);\n${code}`;
  if (language === 'r') return `FILE_CONTENT_PATH <- ${escaped}\nfile_path <- FILE_CONTENT_PATH\nFILE_CONTENT <- readLines(FILE_CONTENT_PATH, warn=FALSE, encoding="UTF-8")\nFILE_CONTENT <- paste(FILE_CONTENT, collapse="\\n")\n${code}`;
  if (language === 'elixir') return `file_content_path = ${escaped}\nfile_path = file_content_path\nfile_content = File.read!(file_content_path)\n${code}`;
  if (language === 'csharp') return `var FILE_CONTENT_PATH = ${escaped};\nvar file_path = FILE_CONTENT_PATH;\nvar FILE_CONTENT = System.IO.File.ReadAllText(FILE_CONTENT_PATH);\n${code}`;
  return code;
}

const DEFAULT_INDEX_EXTENSIONS = ['.md', '.mdx', '.txt', '.json', '.yaml', '.yml', '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.sh'];
const DEFAULT_INDEX_EXCLUDES = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.venv', '__pycache__'];

/** Small cross-platform glob matcher for directory indexing options. */
function globPattern(pattern) {
  const normalized = String(pattern).replace(/\\/g, '/').replace(/^\.\//, '');
  let source = '^';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === '*' && normalized[index + 1] === '*') {
      source += '.*';
      index += 1;
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`${source}$`, process.platform === 'win32' ? 'i' : '');
}

/** Collect an indexable directory tree without following an escape. */
function collectIndexFiles(root, workspace, args) {
  const maxDepth = Number.isInteger(args.maxDepth) && args.maxDepth >= 0 ? args.maxDepth : 5;
  const maxFiles = Number.isInteger(args.maxFiles) && args.maxFiles > 0 ? Math.min(args.maxFiles, 10_000) : 200;
  const extensions = new Set((Array.isArray(args.extensions) && args.extensions.length > 0 ? args.extensions : DEFAULT_INDEX_EXTENSIONS)
    .map((value) => String(value).toLowerCase().replace(/^([^\.])/, '.$1')));
  const include = (Array.isArray(args.include) ? args.include : []).map(globPattern);
  const exclude = (Array.isArray(args.exclude) ? args.exclude : []).map(globPattern);
  const gitignore = [];
  if (args.respectGitignore !== false) {
    const text = readTextIfPresent(join(root, '.gitignore'));
    if (text !== undefined) {
      for (const line of text.split(/\r?\n/)) {
        const value = line.trim();
        if (value.length > 0 && !value.startsWith('#') && !value.startsWith('!')) gitignore.push(globPattern(value.replace(/\/$/, '/**')));
      }
    }
  }
  const files = [];
  const walk = (directory, depth) => {
    if (files.length >= maxFiles || depth > maxDepth) return;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const path = join(directory, entry.name);
      const rel = relative(root, path).replace(/\\/g, '/');
      const segments = rel.split('/');
      if (segments.some((segment) => DEFAULT_INDEX_EXCLUDES.includes(segment))) continue;
      if (exclude.some((pattern) => pattern.test(rel)) || gitignore.some((pattern) => pattern.test(rel))) continue;
      if (entry.isSymbolicLink()) {
        if (args.followSymlinks !== true) continue;
        let target;
        try { target = realpathSync(path); } catch { continue; }
        if (workspace.length > 0 && pathsOutsideWorkspace(target, workspace)) continue;
        let info;
        try { info = statSync(target); } catch { continue; }
        if (info.isDirectory()) walk(target, depth + 1);
        else if (info.isFile() && extensions.has(extname(target).toLowerCase()) && (include.length === 0 || include.some((pattern) => pattern.test(rel)))) files.push({ path: target, rel });
        continue;
      }
      if (entry.isDirectory()) {
        walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile() || !extensions.has(extname(entry.name).toLowerCase())) continue;
      if (include.length > 0 && !include.some((pattern) => pattern.test(rel))) continue;
      files.push({ path, rel });
    }
  };
  walk(root, 0);
  return { files, maxFiles, capped: files.length >= maxFiles };
}

/**
 * Build the execution environment for one sandbox call.
 *
 * The scratch directory is derived from the harness home, NOT from the process
 * cwd. `ctx.get('dshHome')` is not a service, so the earlier fallback silently
 * resolved to whatever directory DSH happened to be launched from — the same
 * plugin wrote captures into two different trees depending on the command line.
 *
 * `TEMP`/`TMP` are pointed INTO that scratch directory as well. A program that
 * asks the system for a temporary path then writes where the scratch sweep can
 * see it, instead of scattering files across the machine's temp and leaving
 * them there.
 *
 * @param ctx - plugin context.
 * @param config - resolved configuration.
 * @param exec - the tool execution (caller agent, working directory).
 * @param overrides - per-call timeout, args, and environment overrides.
 * @returns the runner options.
 */
function prepareRun(ctx, config, exec, overrides = {}) {
  const tmpDir = join(dshHome(), 'context-kit', 'tmp');
  const cwd = cwdOf(exec);
  return {
    cwd,
    tmpDir,
    timeoutMs: Number.isInteger(overrides.timeoutMs) && overrides.timeoutMs > 0
      ? Math.min(overrides.timeoutMs, 900000)
      : config.timeoutMs,
    // `maxOutputChars` is the ONE output budget. It used to be announced in the
    // truncation notice while the real bound came from `headChars`/`tailChars`,
    // so setting `maxOutputChars: 40000` changed nothing but the wording — a
    // configured limit that lies about itself is worse than no limit. The head
    // and tail split is derived from it, and nothing is bounded below it.
    passThroughChars: config.maxOutputChars,
    captureMaxBytesPerStream: config.captureMaxBytesPerStream,
    headChars: Math.max(config.headChars, Math.floor(config.maxOutputChars * 0.75)),
    tailChars: Math.max(config.tailChars, Math.floor(config.maxOutputChars * 0.25)),
    args: overrides.args,
    signal: overrides.signal ?? exec?.signal,
    background: overrides.background === true,
    backgroundOwner: ctx,
    backgroundSession: sessionKeyOf(exec),
    onBackgroundFinal: overrides.onBackgroundFinal,
    env: { TEMP: tmpDir, TMP: tmpDir, ...(overrides.env ?? {}) }
  };
}

/**
 * Reconstruct the retained capture used for indexing.
 *
 * Each stream is a bounded head plus chronological rolling tail. A capture can
 * be final without being complete coverage: dropped bytes are represented by a
 * visible omission marker and `complete` remains false.
 */
function captureFor(run) {
  const parts = [];
  let complete = run.captureComplete !== false && run.captureState !== 'provisional';
  const add = (capture, fallback, label) => {
    if (capture !== undefined) {
      const text = readCaptureText(capture, label ?? 'stdout');
      if (text.trim().length > 0) parts.push(label === undefined ? text : `[${label}]\n${text}`);
      if (capture.truncated === true || capture.droppedBytes > 0) complete = false;
      if (!existsSync(capture.headPath) || !existsSync(capture.tailPath)) complete = false;
      return;
    }
    complete = false;
    if (fallback.length > 0) parts.push(label === undefined ? fallback : `[${label}]\n${fallback}`);
  };
  add(run.stdoutCapture, run.stdout ?? '', undefined);
  add(run.stderrCapture, run.stderr ?? '', 'stderr');
  return { text: parts.join('\n'), complete };
}

/** Index one execution's retained output and return a typed status. */
function indexOutput(knowledgeBase, config, run, source, sessionId) {
  const base = {
    status: 'skipped',
    indexed: false,
    lines: 0,
    totalLines: 0,
    bytes: 0,
    complete: run.captureTruncated !== true && run.captureComplete !== false
  };
  if (!config.autoIndex) return { ...base, reason: 'disabled' };
  if (run.backgrounded === true && run.captureState !== 'final') {
    return { ...base, status: 'pending', complete: false, reason: 'background_running' };
  }
  const capture = captureFor(run);
  const text = capture.text;
  if (text.trim().length === 0) return { ...base, complete: capture.complete, reason: 'empty' };
  const totalLines = text.split('\n').filter((line) => line.trim().length > 0).length;
  try {
    const result = knowledgeBase.index({
      source,
      kind: 'execute',
      text,
      session: sessionId,
      isError: run.ok !== true,
      createdAt: Date.now()
    });
    return {
      status: 'indexed',
      indexed: true,
      lines: result.lines,
      totalLines,
      bytes: result.bytes ?? Buffer.byteLength(text),
      complete: capture.complete,
      coverage: capture.complete ? 'complete' : 'partial'
    };
  } catch (error) {
    return {
      ...base,
      status: 'failed',
      totalLines,
      complete: capture.complete,
      reason: 'index_error',
      error: errorLine(error)
    };
  }
}

/**
 * Whether one settled execution lost any output to bounding.
 *
 * The three flags are only ever SET on the truncation path, so a plain `||`
 * yields `undefined` on every clean run. `undefined` nested in a canonical tool
 * value is not lossless JSON, and the harness rejects the whole result with
 * "returned invalid output" — the tool runs, the model never sees it. Coercing
 * here keeps the flag a boolean on every path.
 *
 * @param run - a settled execution from the sandbox.
 * @returns true when any stream was bounded.
 */
function boundedFlag(run) {
  return run.stdoutTruncated === true || run.stderrTruncated === true || run.truncatedLive === true;
}

/** Stable process, capture, and indexing metadata for execution tool values. */
function executionMetadata(run, indexed) {
  return {
    processStatus: run.processStatus ?? (run.ok ? 'success' : 'failed'),
    captureState: run.captureState ?? 'final',
    captureComplete: run.captureComplete === true,
    captureTruncated: run.captureTruncated === true,
    stdoutObservedBytes: run.stdoutCapture?.observedBytes ?? run.fullStdoutBytes ?? 0,
    stdoutStoredBytes: run.stdoutCapture?.storedBytes ?? run.fullStdoutBytes ?? 0,
    stdoutDroppedBytes: run.stdoutCapture?.droppedBytes ?? 0,
    stderrObservedBytes: run.stderrCapture?.observedBytes ?? run.fullStderrBytes ?? 0,
    stderrStoredBytes: run.stderrCapture?.storedBytes ?? run.fullStderrBytes ?? 0,
    stderrDroppedBytes: run.stderrCapture?.droppedBytes ?? 0,
    indexStatus: indexed.status ?? (indexed.indexed ? 'indexed' : 'skipped')
  };
}

/** Render one settled execution as the model-facing text. */
function renderExecution(run, options = {}) {
  const lines = [];
  if (run.spawnError !== undefined) lines.push(`Failed to start the program: ${run.spawnError}`);
  const bounded = boundedFlag(run);
  if (!bounded && run.stdout.length > 0) lines.push(run.stdout.replace(/\s+$/, ''));
  if (!bounded && run.stderr.length > 0) lines.push(`[stderr]\n${run.stderr.replace(/\s+$/, '')}`);
  if (run.stdout.length === 0 && run.stderr.length === 0 && run.spawnError === undefined && run.timedOut !== true) {
    lines.push('(no output)');
  }
  if (run.timedOut === true) {
    lines.push(run.backgrounded === true
      ? `[process still running in background after ${run.durationMs} ms; capture metadata is provisional and final retained output will be indexed after exit]`
      : `[TIMED OUT after ${run.durationMs} ms — the program was killed, so the output above is PARTIAL and no exit code exists. Raise \`timeout\`, or stream progress to a file and read it after.]`);
  }
  if (bounded) {
    lines.push(`[output exceeded ${options.maxOutputChars ?? 'the'}-byte inline limit; retained output stayed out of context]`);
  }
  if (run.captureTruncated === true) {
    const stdout = run.stdoutCapture ?? {};
    const stderr = run.stderrCapture ?? {};
    lines.push(
      `[physical capture cap omitted ${stdout.droppedBytes ?? 0} stdout byte(s) and ${stderr.droppedBytes ?? 0} stderr byte(s); `
      + `the retained files contain the beginning and final rolling tail, not the complete streams]`
    );
  }
  const indexed = options.indexed;
  if (indexed?.indexed === true) {
    const coverage = indexed.complete === false ? ' Retained coverage is partial because bytes were omitted.' : '';
    lines.push(
      `[indexed ${indexed.lines} of ${indexed.totalLines} retained non-empty line(s) as source ${JSON.stringify(options.source)} — ctx_search reads the retained head and tail.]${coverage}`
    );
  } else if (indexed?.status === 'failed') {
    lines.push(`[indexing failed: ${indexed.error ?? 'unknown error'}]`);
  }
  // `exitCode` is null only when the program never returned one (a kill), and
  // the timeout notice above already accounts for that case.
  if (run.exitCode !== 0 && run.exitCode !== null) lines.push(`[exit code: ${run.exitCode}]`);
  return lines.join('\n\n');
}

/* ------------------------------------------------------------- search guard */

/**
 * Build the per-session search throttle upstream calls a flood guard.
 *
 * One counter per key inside one rolling window. The whole policy is a counter
 * plus a clock parameter: no timer, no persistence, nothing scheduled — a
 * blocked call cannot outlive the process, and a test moves the clock instead
 * of sleeping. The key is the CALLING SESSION's id, because a single
 * process-wide counter sums a parallel subagent fan-out into one budget and
 * blocks agents that never flooded anything (upstream issue #769).
 *
 * @param options - window length in milliseconds plus the soft and hard caps.
 * @returns the guard; `record(key, now)` returns this call's decision.
 */
export function createSearchGuard(options) {
  const buckets = new Map();
  // Bound the map. A host that mints unbounded session ids would otherwise
  // grow it without limit over the life of the process. The oldest window is
  // evicted first, which fails OPEN: an evicted session gets a fresh window,
  // never a false block.
  const maxKeys = 4096;
  return {
    /**
     * Record one search call and report where this session stands.
     *
     * @param key - the calling session's id.
     * @param now - the clock, injectable so the window is testable.
     * @returns the call count, the window start, and the two throttles.
     */
    record(key, now = Date.now()) {
      let bucket = buckets.get(key);
      // `>` and not `>=`, matching upstream: the counter resets once the window
      // has fully elapsed, so a call exactly one window later still belongs to
      // the window it started in.
      if (bucket === undefined || now - bucket.windowStart > options.windowMs) {
        bucket = { count: 0, windowStart: now };
        buckets.set(key, bucket);
        if (buckets.size > maxKeys) {
          let oldestKey;
          let oldestStart = Infinity;
          for (const [candidate, entry] of buckets) {
            if (entry.windowStart < oldestStart) {
              oldestStart = entry.windowStart;
              oldestKey = candidate;
            }
          }
          if (oldestKey !== undefined) buckets.delete(oldestKey);
        }
      }
      bucket.count += 1;
      return {
        count: bucket.count,
        windowStart: bucket.windowStart,
        blocked: bucket.count > options.blockCap,
        softCapped: bucket.count > options.softCap
      };
    },
    /**
     * How many sessions the guard is currently tracking.
     *
     * @returns the number of live windows.
     */
    size() {
      return buckets.size;
    }
  };
}

/**
 * The refusal text for a call past the hard cap.
 *
 * Assembled here rather than inline so the wording is one edit away from
 * upstream's, whose string is the model's instruction to change strategy.
 *
 * @param count - this session's call count in the window.
 * @param elapsedSeconds - whole seconds since the window opened.
 * @returns the exact error text.
 */
function blockedText(count, elapsedSeconds) {
  return `BLOCKED: ${count} search calls in ${elapsedSeconds}s. You're flooding context. STOP making individual search calls. Use ctx_batch_execute(commands, queries) for your next research step.`;
}

/**
 * The throttle line every non-blocked reply carries.
 *
 * Upstream swaps this line for a louder warning once the soft cap is passed;
 * this port keeps the single documented form so the string is stable, and the
 * soft cap still shows itself by lowering the effective limit to one hit.
 *
 * @param count - this session's call count in the window.
 * @param options - the soft and hard caps the line reports against.
 * @returns the one-line throttle notice.
 */
function throttleText(count, options) {
  const remaining = Math.max(0, options.softCap - count);
  return `> Throttle: call #${count}/${options.blockCap} in this window. ${remaining} call(s) before soft cap. Prefer ctx_search(queries: [...]) array form for multi-query workloads — it counts as a single call.`;
}

/* ------------------------------------------------------------------ insight */

/**
 * Why a dashboard URL cannot be embedded in a reply, or an empty string.
 *
 * A URL carrying a space or a control character splits into two tokens when the
 * reply is rendered, and one carrying a quote or a backtick breaks the line
 * around it — either way the user is handed a pointer that cannot be followed,
 * which is worse than being told to open it manually.
 *
 * @param url - the candidate URL.
 * @returns the reason to report, or `''` when the URL can be embedded.
 */
function embeddableFailure(url) {
  if (typeof url !== 'string' || url.length === 0) return 'the URL is empty';
  if (/[\s\u0000-\u001f\u007f]/.test(url)) return 'the URL contains whitespace or a control character';
  if (/[<>"`|\\^{}]/.test(url)) return 'the URL contains a character that breaks the surrounding markup';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'the URL is not absolute';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return `the URL scheme is ${parsed.protocol.replace(':', '')}, not http or https`;
  }
  return '';
}

/**
 * Render the `ctx_insight` reply for one dashboard URL.
 *
 * Upstream opens the URL in the user's default browser and reports whether it
 * could. This port has no browser to open and will not spawn one: launching a
 * GUI process on the user's desktop is a starting side effect no tool call
 * should have, and the harness exposes no supported way to ask for it. The
 * honest equivalent is the URL itself as a clickable pointer, so the tool keeps
 * upstream's two-branch shape — a happy branch naming the URL, and a failure
 * branch that names a reason and says `Open Insight manually: <url>` — and
 * changes only what the happy branch claims.
 *
 * The failure branch therefore fires when the URL cannot be EMBEDDED in the
 * reply: it is empty, not absolute, not http(s), or carries whitespace, a
 * control character, or a character that would break the markup around it. That
 * is a real condition rather than a simulated browser error — a URL that cannot
 * be rendered is a pointer that cannot be clicked — and it is re-checked on
 * every call, so a future dashboard URL cannot silently produce a broken link.
 *
 * @param url - the dashboard URL to embed in the reply.
 * @returns the canonical value: the URL, whether it was embeddable, the reason
 *   it was not (an empty string when it was), and the rendered text.
 */
export function insightResult(url) {
  const reason = embeddableFailure(url);
  const text = typeof url === 'string' ? url : '';
  if (reason.length > 0) {
    return {
      url: text,
      embeddable: false,
      reason,
      rendered: `Could not embed the Insight dashboard URL in this reply (${reason}).\nOpen Insight manually: ${text}`
    };
  }
  return {
    url: text,
    embeddable: true,
    reason: '',
    rendered: [
      'Insight is an external dashboard — this port returns its address instead of opening a browser.',
      `Open Insight: ${text}`
    ].join('\n')
  };
}

/** Flatten model content blocks without serializing presentation metadata. */
function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (typeof block?.text === 'string') parts.push(block.text);
    if (Array.isArray(block?.content)) {
      const nested = textFromContent(block.content);
      if (nested.length > 0) parts.push(nested);
    }
  }
  return parts.join('\n');
}

/* --------------------------------------------------------------- registration */

/**
 * Mount context-mode.
 *
 * @param ctx - the registrant context.
 * @param rawConfig - the preset row's configuration.
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig, ctx.logger);
  installContextMode(ctx, config);
}

/** Install a settings-resolved instance without reapplying legacy file overrides. */
export function installContextMode(ctx, config) {
  if (!config.enabled) {
    ctx.logger.info(`${PLUGIN_ID}: disabled by configuration`);
    return;
  }

  // Upstream injects its guidance at SessionStart and again on every agent call
  // (`hooks/routing-block.mjs`, `hooks/core/routing.mjs:905-913`). The port
  // injected nothing at all, so a model here saw ten tool descriptions and no
  // statement of what they are FOR. A registered section is re-assembled on every
  // request, which is the same effect.
  const systemPrompt = ctx.get('systemPrompt');
  if (systemPrompt !== undefined && config.guidance !== false) {
    ctx.effect(() => systemPrompt.section({
      name: 'context-mode:guidance',
      order: 1600,
      text: routingBlock({ includeCommands: config.commands !== false })
    }), 'context-mode guidance section');
  } else if (systemPrompt === undefined) {
    ctx.logger.warn(`${PLUGIN_ID}: no systemPrompt service; the tool guidance cannot be injected`);
  }

  const databases = new Map();
  const sessions = new Map();
  const emptyCounters = () => ({ executed: 0, indexed: 0, searched: 0, fetched: 0, bytesIndexed: 0, bytesReturned: 0 });
  const stateFor = (exec) => {
    const path = config.knowledgeBasePath || KnowledgeBase.defaultPath(cwdOf(exec));
    if (!databases.has(path)) databases.set(path, new KnowledgeBase({ path, producer: PLUGIN_ID, logger: ctx.logger }));
    const key = `${path}\u0000${sessionKeyOf(exec)}`;
    if (!sessions.has(key)) sessions.set(key, emptyCounters());
    return { knowledgeBase: databases.get(path), counters: sessions.get(key), databasePath: path, counterKey: key };
  };
  const clearCounters = (databasePath, sessionId) => {
    const exact = sessionId === undefined ? undefined : `${databasePath}\u0000${sessionId}`;
    for (const key of sessions.keys()) {
      if ((exact !== undefined && key === exact) || (exact === undefined && key.startsWith(`${databasePath}\u0000`))) sessions.delete(key);
    }
  };
  const stateForSession = (session) => stateFor({ agent: { session }, callId: `event-${session?.id ?? 'default'}` });
  ctx.effect(() => () => {
    terminateBackgroundProcesses({ owner: ctx });
    for (const database of databases.values()) database.close();
    databases.clear();
    sessions.clear();
  }, 'context-mode project databases');

  // Reap capture files left by earlier runs. A child cannot delete the file it
  // is still writing, and a killed child never gets the chance, so the sweep
  // runs on mount and keeps anything younger than `scratchRetentionMs` — a
  // capture named in a recent result must still be readable.
  //
  // Housekeeping must NEVER be able to prevent registration: a locked or
  // unreadable scratch directory would otherwise take every tool down with it,
  // and the failure would look exactly like "context-mode is not installed".
  try {
    const scratch = join(dshHome(), 'context-kit', 'tmp');
    const swept = cleanupScratch(scratch, config.scratchRetentionMs);
    if (swept.removed > 0) {
      ctx.logger.info(`${PLUGIN_ID}: removed ${swept.removed} expired capture file(s) from ${scratch}`);
    }
  } catch (error) {
    ctx.logger.warn(`${PLUGIN_ID}: scratch sweep skipped: ${errorLine(error)}`);
  }

  /**
   * The search throttle: one rolling window per calling session.
   *
   * Built once per plugin instance, so the window is shared by every session
   * the instance serves while the counters inside it stay per session, and it
   * dies with the process — nothing is written down.
   */
  const searchLimits = {
    windowMs: config.searchWindowMs,
    softCap: config.searchSoftCap,
    blockCap: config.searchBlockCap
  };
  const searchGuard = createSearchGuard(searchLimits);

  const sourceFor = (exec, explicit) => (typeof explicit === 'string' && explicit.trim().length > 0
    ? explicit.trim()
    : `exec-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${String(exec?.callId ?? 'manual').slice(-6)}`);

  const indexMemory = (session, event, category, text, isError = false) => {
    if (typeof text !== 'string' || text.trim().length === 0) return;
    const { knowledgeBase, counters } = stateForSession(session);
    const sessionId = String(session?.id ?? 'unknown');
    const result = knowledgeBase.index({
      source: `${category}:${sessionId}:${event.seq}`,
      kind: category,
      text,
      session: sessionId,
      seq: Number(event.seq ?? 0),
      createdAt: Date.now(),
      isError
    });
    counters.indexed += result.lines;
    counters.bytesIndexed += result.bytes ?? Buffer.byteLength(text);
  };

  /* ------------------------------------------------------------ ctx_execute */

  const executeTool = defineTool({
    name: 'ctx_execute',
    description: [
      'Run a program and return only what it prints. This is the "think in code" tool: when the answer requires reading, counting, filtering, comparing, parsing, or transforming data, write the program that computes it and print the answer.',
      '',
      'Only stdout enters the conversation. A bounded head and rolling tail are saved and indexed for each stream; very large middle sections may be omitted. `ctx_search` reads the retained capture, not just the inline preview.',
      '',
      'Languages: `javascript` (Node ESM, builtins available), `python` (standard library, UTF-8 forced), `shell` (PowerShell on Windows, /bin/sh elsewhere). The program starts in the session workspace; `TEMP`/`TMP` point at a scratch directory that is swept automatically.',
      '',
      'Note the boundary: this is a subprocess, NOT a confined sandbox. It inherits your environment and can write anywhere your account can, unlike the harness shell tools which are restricted to the workspace. Use it for analysis, not for writes outside the workspace.',
      '',
      'One script that prints three lines replaces ten file reads. Prefer it.'
    ].join('\n'),
    parameters: {
      language: { type: 'string', required: true, enum: LANGUAGE_ENUM, description: 'Runtime for the program.' },
      code: { type: 'string', required: true, description: 'The complete program text. Print the answer to stdout.' },
      timeout: { type: 'integer', description: 'Maximum execution time in milliseconds.' },
      background: { type: 'boolean', description: 'Keep a long-running process alive after the timeout.' },
      cwd: { type: 'string', description: config.restrictPathsToWorkspace
        ? 'Working directory inside the session workspace.'
        : 'Working directory. Relative paths resolve from the session workspace.' },
      intent: { type: 'string', description: 'What to look for; also labels indexed output.' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exitCode: { type: 'integer', required: true },
          stdoutChars: { type: 'integer', required: true },
          stderrChars: { type: 'integer', required: true },
          durationMs: { type: 'integer', required: true },
          bounded: { type: 'boolean', required: true },
          timedOut: { type: 'boolean', required: true },
          processStatus: { type: 'string', required: true },
          captureState: { type: 'string', required: true },
          captureComplete: { type: 'boolean', required: true },
          captureTruncated: { type: 'boolean', required: true },
          stdoutObservedBytes: { type: 'integer', required: true },
          stdoutStoredBytes: { type: 'integer', required: true },
          stdoutDroppedBytes: { type: 'integer', required: true },
          stderrObservedBytes: { type: 'integer', required: true },
          stderrStoredBytes: { type: 'integer', required: true },
          stderrDroppedBytes: { type: 'integer', required: true },
          spillPath: { type: 'string' },
          indexStatus: { type: 'string', required: true },
          indexedLines: { type: 'integer', required: true },
          indexedTotalLines: { type: 'integer', required: true },
          source: { type: 'string', required: true },
          rendered: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.rendered }]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { knowledgeBase, counters } = stateFor(exec);
      const source = sourceFor(exec, args.intent ?? args.source);
      const sessionId = exec.agent?.session?.id;
      const onBackgroundFinal = (finalRun) => {
        const finalIndexed = indexOutput(knowledgeBase, config, finalRun, source, sessionId);
        if (finalIndexed.indexed) {
          counters.indexed += finalIndexed.lines;
          counters.bytesIndexed += finalIndexed.bytes;
        }
      };
      const options = prepareRun(ctx, config, exec, {
        timeoutMs: args.timeout ?? args.timeout_ms,
        background: args.background === true,
        onBackgroundFinal
      });
      if (typeof args.cwd === 'string' && args.cwd.length > 0) {
        options.cwd = toolPath(args.cwd, exec, 'ctx_execute', config.restrictPathsToWorkspace);
      }
      const run = await runProgram(options, {
        ...options,
        language: args.language,
        code: args.code
      });
      counters.executed += 1;
      const indexed = indexOutput(knowledgeBase, config, run, source, sessionId);
      if (indexed.indexed) {
        counters.indexed += indexed.lines;
        counters.bytesIndexed += indexed.bytes;
      }
      const rendered = renderExecution(run, { source, indexed, maxOutputChars: config.maxOutputChars });
      counters.bytesReturned += Buffer.byteLength(rendered);
      return {
        exitCode: run.exitCode ?? -1,
        stdoutChars: run.fullStdoutChars,
        stderrChars: run.fullStderrChars,
        durationMs: run.durationMs,
        bounded: boundedFlag(run),
        timedOut: run.timedOut === true,
        ...executionMetadata(run, indexed),
        ...(run.spillPath === undefined ? {} : { spillPath: run.spillPath }),
        indexedLines: indexed.lines,
        indexedTotalLines: indexed.totalLines ?? 0,
        source,
        rendered
      };
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `ctx_execute (${args.language})`,
      kind: 'other',
      rawInput: args.code
    })
  });

  /* ------------------------------------------------------- ctx_execute_file */

  const executeFileTool = defineTool({
    name: 'ctx_execute_file',
    description: [
      'Run a program that also receives a file\'s contents, returning only what the program prints.',
      'Use this for the common case "read this file and tell me something about it" — grepping it, counting in it, extracting a section, comparing two versions — where reading it into the conversation would be wasteful.',
      '',
      'The file is available as `FILE_CONTENT` and `FILE_CONTENT_PATH` (`file_content` in Elixir and Rust), and its path is also passed as the final argument.',
      'Only stdout enters the conversation; the retained head and rolling tail are saved and indexed.'
    ].join('\n'),
    parameters: {
      path: { type: 'string', required: true, description: config.restrictPathsToWorkspace
        ? 'File inside the session workspace to analyse.'
        : 'Host-readable file to analyse. Relative paths resolve from the session workspace.' },
      language: { type: 'string', required: true, enum: LANGUAGE_ENUM, description: 'Runtime for the program.' },
      code: { type: 'string', required: true, description: 'Code to process FILE_CONTENT (file_content in Elixir/Rust).' },
      timeout: { type: 'integer', description: 'Maximum execution time in milliseconds.' },
      intent: { type: 'string', description: 'What to look for; also labels indexed output.' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          fileChars: { type: 'integer', required: true },
          exitCode: { type: 'integer', required: true },
          outsideWorkspace: { type: 'boolean', required: true },
          bounded: { type: 'boolean', required: true },
          timedOut: { type: 'boolean', required: true },
          processStatus: { type: 'string', required: true },
          captureState: { type: 'string', required: true },
          captureComplete: { type: 'boolean', required: true },
          captureTruncated: { type: 'boolean', required: true },
          stdoutObservedBytes: { type: 'integer', required: true },
          stdoutStoredBytes: { type: 'integer', required: true },
          stdoutDroppedBytes: { type: 'integer', required: true },
          stderrObservedBytes: { type: 'integer', required: true },
          stderrStoredBytes: { type: 'integer', required: true },
          stderrDroppedBytes: { type: 'integer', required: true },
          spillPath: { type: 'string' },
          indexStatus: { type: 'string', required: true },
          indexedLines: { type: 'integer', required: true },
          indexedTotalLines: { type: 'integer', required: true },
          source: { type: 'string', required: true },
          rendered: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.rendered }]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { knowledgeBase, counters } = stateFor(exec);
      const cwd = cwdOf(exec);
      const path = toolPath(args.path, exec, 'ctx_execute_file', config.restrictPathsToWorkspace);
      const text = readTextIfPresent(path);
      if (text === undefined) throw new Error(`ctx_execute_file: cannot read ${path}`);
      const source = sourceFor(exec, args.intent ?? args.source ?? `file-${basename(path)}`);
      const sessionId = exec.agent?.session?.id;
      const options = prepareRun(ctx, config, exec, {
        timeoutMs: args.timeout ?? args.timeout_ms,
        args: [path],
        env: { CTX_FILE: path, CTX_FILE_CHARS: String(text.length) }
      });
      const run = await runProgram(options, {
        ...options,
        language: args.language,
        code: `${wrapFileContent(path, args.language, args.code)}\n`
      });
      counters.executed += 1;
      const indexed = indexOutput(knowledgeBase, config, run, source, sessionId);
      if (indexed.indexed) {
        counters.indexed += indexed.lines;
        counters.bytesIndexed += indexed.bytes;
      }
      const body = renderExecution(run, { source, indexed, maxOutputChars: config.maxOutputChars });
      counters.bytesReturned += Buffer.byteLength(body);
      return {
        path,
        fileChars: text.length,
        exitCode: run.exitCode ?? -1,
        outsideWorkspace: pathsOutsideWorkspace(path, cwd),
        bounded: boundedFlag(run),
        timedOut: run.timedOut === true,
        ...executionMetadata(run, indexed),
        ...(run.spillPath === undefined ? {} : { spillPath: run.spillPath }),
        indexedLines: indexed.lines,
        indexedTotalLines: indexed.totalLines ?? 0,
        source,
        rendered: body
      };
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `ctx_execute_file ${args.path}`,
      kind: 'read',
      rawInput: args.path
    })
  });

  /* ------------------------------------------------------- ctx_batch_execute */

  const runBatch = async (entries, concurrency, exec, source, options = {}) => {
    const { knowledgeBase, counters } = stateFor(exec);
    const results = new Array(entries.length);
    const startedAt = Date.now();
    let cursor = 0;
    const worker = async () => {
      while (cursor < entries.length) {
        const index = cursor;
        cursor += 1;
        const entry = entries[index];
        const prepared = prepareRun(ctx, config, exec, {});
        const timeoutMs = options.timeoutMs === undefined
          ? undefined
          : (concurrency === 1 ? Math.max(1, options.timeoutMs - (Date.now() - startedAt)) : options.timeoutMs);
        const run = await runProgram(prepared, {
          ...prepared,
          language: 'shell',
          code: entry.command,
          // Upstream lets a batch set one working directory and one timeout for
          // all of its commands (`src/server.ts:3742-3763`).
          ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {})
        });
        results[index] = { label: entry.label, command: entry.command, run };
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, entries.length)) }, worker));

    // Each command is indexed separately under its own label from its retained
    // capture. Indexing the joined previews instead would lose both the rolling
    // tail and the ability to search a single command's result.
    const blocks = [];
    let indexedLines = 0;
    let indexedTotalLines = 0;
    let indexedBytes = 0;
    let anyIndexed = false;
    let allComplete = true;
    for (const entry of results) {
      const label = `${source}:${entry.label}`;
      const indexed = indexOutput(knowledgeBase, config, entry.run, label, exec.agent?.session?.id);
      if (indexed.indexed) {
        anyIndexed = true;
        indexedLines += indexed.lines;
        indexedTotalLines += indexed.totalLines ?? 0;
        indexedBytes += indexed.bytes ?? 0;
        counters.indexed += indexed.lines;
        counters.bytesIndexed += indexed.bytes ?? 0;
      }
      if (indexed.complete === false) allComplete = false;
      const header = `## ${entry.label}\n$ ${entry.command}`;
      const body = renderExecution(entry.run, { source: label, indexed, maxOutputChars: config.maxOutputChars });
      blocks.push(`${header}\n${body}`);
    }
    return {
      blocks,
      indexed: { indexed: anyIndexed, lines: indexedLines, totalLines: indexedTotalLines, bytes: indexedBytes, complete: allComplete }
    };
  };

  /**
   * Extract the window of a stored line that carries the query's terms.
   *
   * Upstream returns a snippet around the match rather than the whole chunk, and
   * its budget per snippet is 3000 characters (`src/server.ts:formatBatchQueryResults`,
   * `extractSnippet(..., 3000, ...)`). A batch answer is a READING of the output,
   * not the output itself — which is the entire point of the tool.
   *
   * @param text - the stored line.
   * @param query - the query whose terms to centre on.
   * @param budget - maximum characters to return.
   * @returns the snippet.
   */
  const snippetFor = (text, query, budget = 3000) => {
    const source = String(text ?? '');
    if (source.length <= budget) return source;
    const terms = String(query ?? '').toLowerCase().split(/\s+/).filter((term) => term.length > 2);
    const haystack = source.toLowerCase();
    let at = -1;
    for (const term of terms) {
      const found = haystack.indexOf(term);
      if (found !== -1 && (at === -1 || found < at)) at = found;
    }
    if (at === -1) return `${source.slice(0, budget)} …[truncated]`;
    const start = Math.max(0, at - Math.floor(budget / 3));
    return `${start > 0 ? '…' : ''}${source.slice(start, start + budget)}${start + budget < source.length ? ' …[truncated]' : ''}`;
  };

  /**
   * Answer the batch's OWN queries from what it just indexed.
   *
   * Upstream makes `queries` a REQUIRED argument and answers them in the same
   * round trip (`src/server.ts:3734-3741`, `:3852-3871`): the tool is "gather and
   * answer", not "gather and return". The port had dropped the field entirely, so
   * a caller had to spend a second call on `ctx_search` for what the first call
   * already had in hand. Scope defaults to this batch; `global` searches the whole
   * index instead (`:3764-3775`).
   *
   * @param queries - the questions to answer.
   * @param source - this batch's index label.
   * @param scope - `batch` or `global`.
   * @returns the rendered sections, in upstream's shape.
   */
  const answerBatchQueries = (queries, source, scope, exec) => {
    const { knowledgeBase } = stateFor(exec);
    const sections = [];
    let outputSize = 0;
    const maxOutput = 80 * 1024;
    const searchSource = scope === 'global' ? undefined : source;
    for (const query of queries) {
      if (outputSize > maxOutput) {
        sections.push(`## ${query}\n(output cap reached — use ctx_search(queries: ["${query}"]) for details)\n`);
        continue;
      }
      sections.push(`## ${query}`, '');
      const results = knowledgeBase.search(query, { limit: 3, source: searchSource });
      if (results.length === 0) {
        sections.push('No matching sections found.', '');
        continue;
      }
      for (const result of results) {
        const snippet = snippetFor(result.text, query);
        sections.push(`### ${result.source} (line ${result.line})`, snippet, '');
        outputSize += snippet.length;
      }
    }
    sections.push(scope === 'global'
      ? '> **Scope:** Queries searched the entire persistent index (query_scope: "global").'
      : '> **Tip:** Results are scoped to this batch only. To search across all indexed sources, use `ctx_search(queries: [...])` or call ctx_batch_execute with `query_scope: "global"`.');
    return sections;
  };

  const batchTool = defineTool({
    name: 'ctx_batch_execute',
    description: [
      'Run several shell commands in one call, index everything they print, and answer your questions about it in the SAME round trip.',
      'This is the gather step: instead of ten separate shell calls, each adding its own output to the conversation, send one batch. Every command gets its own labelled section, the whole batch is indexed under one source label, and `queries` pulls the matching lines straight back — the raw bytes never enter the conversation.',
      '',
      'Put ALL your questions in `queries`. This is your only chance in this call: five to eight comprehensive queries cost nothing extra, and every one of them is answered from the output that was just captured.',
      'Use `query_scope: "global"` when you also want prior knowledge from the index, not just this batch.',
      '',
      'Concurrency defaults to 1, which is correct for CPU-bound or stateful commands (builds, tests, ports, locks). Raise it to 4-8 for I/O-bound batches (network, multi-repo reads).'
    ].join('\n'),
    parameters: {
      commands: {
        type: 'array',
        required: true,
        description: 'Commands to run, in order. Each `label` becomes the section header and the indexed chunk title — descriptive labels improve search.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            label: { type: 'string', required: true, description: 'Short header for this command\'s section.' },
            command: { type: 'string', required: true, description: 'The shell command line to run.' }
          }
        }
      },
      queries: {
        type: 'array',
        required: true,
        description: 'Search queries to extract information from the indexed output. Use 5-8 comprehensive queries; each returns the top 3 matching lines with content. This is your only chance — put ALL your questions here.',
        items: { type: 'string' }
      },
      concurrency: { type: 'integer', description: 'Max commands to run in parallel (1-8, default 1). Use 4-8 for I/O-bound batches; keep at 1 for CPU-bound or stateful commands.' },
      timeout: { type: 'integer', description: 'Max execution time in ms for the whole batch.' },
      cwd: { type: 'string', description: 'Optional working directory for all shell commands in this batch.' },
      query_scope: { type: 'string', enum: ['batch', 'global'], description: 'Scope for `queries` (default `batch`): `batch` searches only this batch\'s output, `global` searches the entire index.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sections: { type: 'integer', required: true },
          indexedLines: { type: 'integer', required: true },
          indexedTotalLines: { type: 'integer', required: true },
          queriesAnswered: { type: 'integer', required: true },
          source: { type: 'string', required: true },
          rendered: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.rendered }]
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const { counters } = stateFor(exec);
      if (args.commands.length === 0) throw new Error('ctx_batch_execute: at least one command is required');
      const queries = Array.isArray(args.queries)
        ? args.queries.filter((query) => typeof query === 'string' && query.trim().length > 0)
        : [];
      // Upstream makes `queries` required: the tool's whole point is to answer
      // from what it captured, and a caller that omits them pays a second
      // round trip for output it already has.
      if (queries.length === 0) throw new Error('ctx_batch_execute: `queries` is required — pass the questions you want answered from this batch');
      // A run-unique prefix keeps query_scope:"batch" from matching rows left by
      // an older invocation that reused the same human label.
      const source = `${sourceFor(exec, args.source)}:batch-${String(exec?.callId ?? Date.now())}`;
      const concurrency = Number.isInteger(args.concurrency) && args.concurrency > 0
        ? Math.min(args.concurrency, 8)
        : 1;
      const { blocks, indexed } = await runBatch(args.commands, concurrency, exec, source, {
        timeoutMs: Number.isInteger(args.timeout) && args.timeout > 0 ? args.timeout : undefined,
        cwd: typeof args.cwd === 'string' && args.cwd.length > 0
          ? toolPath(args.cwd, exec, 'ctx_batch_execute', config.restrictPathsToWorkspace)
          : undefined
      });
      counters.executed += args.commands.length;
      const totalLines = blocks.reduce((total, block) => total + block.split('\n').length, 0);
      const answerSections = answerBatchQueries(queries, source, args.query_scope === 'global' ? 'global' : 'batch', exec);
      counters.searched += queries.length;
      const inventory = [
        `Executed ${args.commands.length} commands (${totalLines} lines). Indexed ${indexed.lines} section(s). Searched ${queries.length} queries.`,
        '',
        '## Commands',
        '',
        ...args.commands.map((entry) => `- ${entry.label}: \`${String(entry.command).slice(0, 120)}\``),
        ''
      ];
      const rendered = [
        ...inventory,
        ...answerSections,
        indexed.indexed
          ? `\n[indexed all ${indexed.lines} of ${indexed.totalLines} non-empty line(s), one source per command named "${source}:<label>" — ctx_search can query any of them]`
          : ''
      ].filter((part) => part.length > 0).join('\n');
      counters.bytesReturned += Buffer.byteLength(rendered);
      return {
        sections: blocks.length,
        indexedLines: indexed.lines,
        indexedTotalLines: indexed.totalLines,
        queriesAnswered: queries.length,
        source,
        rendered
      };
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `ctx_batch_execute (${args.commands.length} commands)`,
      kind: 'terminal',
      rawInput: args.commands.map((entry) => entry.command).join('\n')
    })
  });

  /* -------------------------------------------------------------- ctx_index */

  const indexTool = defineTool({
    name: 'ctx_index',
    description: [
      'Store content in the searchable knowledge base without printing it.',
      'Use it to keep something you will need later — a specification, a long log, a fetched page, notes you just derived — so retrieving the relevant line later costs a search instead of a re-read.',
      config.restrictPathsToWorkspace
        ? 'Provide `content` or a workspace-confined file/directory `path`. Directory walks are bounded and respect common build exclusions.'
        : 'Provide `content` or a host-readable file/directory `path`. Relative paths resolve from the session workspace; directory walks are bounded.'
    ].join('\n'),
    parameters: {
      content: { type: 'string', description: 'Content to index. Provide this or `path`.' },
      path: { type: 'string', description: config.restrictPathsToWorkspace
        ? 'Workspace file or directory to index. Provide this or `content`.'
        : 'Host-readable file or directory to index. Provide this or `content`.' },
      source: { type: 'string', description: 'Optional source label.' },
      include: { type: 'array', items: { type: 'string' }, description: 'Directory-only glob patterns to include.' },
      exclude: { type: 'array', items: { type: 'string' }, description: 'Directory-only glob patterns to exclude.' },
      maxDepth: { type: 'integer', description: 'Directory recursion depth (default 5).' },
      maxFiles: { type: 'integer', description: 'Directory file cap (default 200).' },
      extensions: { type: 'array', items: { type: 'string' }, description: 'Directory file extensions.' },
      respectGitignore: { type: 'boolean', description: 'Apply root .gitignore rules (default true).' },
      followSymlinks: { type: 'boolean', description: 'Follow contained directory symlinks (default false).' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          source: { type: 'string', required: true },
          lines: { type: 'integer', required: true },
          chars: { type: 'integer', required: true },
          bytes: { type: 'integer', required: true },
          files: { type: 'integer', required: true },
          capped: { type: 'boolean', required: true },
          rendered: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.rendered }]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { knowledgeBase, counters } = stateFor(exec);
      const inline = typeof args.content === 'string' ? args.content : (typeof args.text === 'string' ? args.text : '');
      const hasPath = typeof args.path === 'string' && args.path.length > 0;
      if (inline.length > 0 && hasPath) throw new Error('ctx_index: provide `content` or `path`, not both');
      if (inline.trim().length === 0 && !hasPath) throw new Error('ctx_index: provide non-empty `content` or a readable `path`');
      const sessionId = exec.agent?.session?.id;
      const cwd = cwdOf(exec);
      const requestedSource = typeof args.source === 'string' && args.source.trim().length > 0 ? args.source.trim() : undefined;
      let source = requestedSource ?? `inline-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
      let lines = 0;
      let chars = 0;
      let bytes = 0;
      let files = 0;
      let capped = false;
      const indexOne = (label, text, kind = 'note') => {
        const result = knowledgeBase.index({ source: label, kind, text, session: sessionId, createdAt: Date.now() });
        lines += result.lines;
        chars += result.chars;
        bytes += result.bytes ?? Buffer.byteLength(text);
      };
      if (inline.trim().length > 0) {
        indexOne(source, inline, typeof args.kind === 'string' ? args.kind : 'note');
      } else {
        const path = toolPath(args.path, exec, 'ctx_index', config.restrictPathsToWorkspace);
        let info;
        try { info = statSync(path); } catch { throw new Error(`ctx_index: cannot read ${path}`); }
        source = requestedSource ?? basename(path);
        if (info.isFile()) {
          const text = readTextIfPresent(path);
          if (text === undefined) throw new Error(`ctx_index: cannot read ${path}`);
          indexOne(source, text, 'file');
          files = 1;
        } else if (info.isDirectory()) {
          const collected = collectIndexFiles(path, config.restrictPathsToWorkspace ? cwd : '', args);
          capped = collected.capped;
          for (const file of collected.files) {
            const text = readTextIfPresent(file.path);
            if (text === undefined) continue;
            indexOne(`${source}:${file.rel}`, text, 'file');
            files += 1;
          }
        } else {
          throw new Error(`ctx_index: path is not a regular file or directory: ${path}`);
        }
      }
      counters.indexed += lines;
      counters.bytesIndexed += bytes;
      const rendered = [
        `Indexed ${lines} line(s), ${chars} chars, under source ${JSON.stringify(source)}${files > 0 ? ` from ${files} file(s)` : ''}.`,
        capped ? 'Directory file cap reached; narrow include patterns or raise maxFiles.' : '',
        `Search with ctx_search(queries: [...], source: ${JSON.stringify(source)}).`
      ].filter(Boolean).join('\n');
      counters.bytesReturned += Buffer.byteLength(rendered);
      return {
        source,
        lines,
        chars,
        bytes,
        files,
        capped,
        rendered
      };
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `ctx_index ${args.source ?? args.path ?? 'content'}`,
      kind: 'other',
      rawInput: args.source ?? args.path ?? ''
    })
  });

  /* ------------------------------------------------------------- ctx_search */

  const searchTool = defineTool({
    name: 'ctx_search',
    description: [
      'Search everything indexed this session (and earlier ones) and answer with matching lines.',
      'Search BEFORE asking the user to repeat themselves, and BEFORE re-running a command whose output was already captured. If a search returns nothing, treat the topic as new.',
      '',
      'Pass several queries at once — they are run together and grouped by source, so one call answers a multi-part question, and the whole call counts as ONE search against the throttle.',
      '`sort: "timeline"` returns the newest hits first, which is what "what were we just doing" wants; the default ranks by relevance.',
      '`source` matches any source label CONTAINING the text, case-insensitively; `contentType` keeps only lines that look like code, or only lines that do not.',
      '',
      'Each query returns at most two hits (one once the soft cap is passed) and the whole reply is capped, so a research step that needs more belongs in `ctx_batch_execute(commands, queries)`.'
    ].join('\n'),
    parameters: {
      queries: {
        type: 'array',
        required: true,
        description: 'One or more search queries.',
        items: { type: 'string' }
      },
      source: { type: 'string', description: 'Keep only sources whose label contains this text (case-insensitive).' },
      sort: { type: 'string', enum: ['relevance', 'timeline'], description: 'Result order.' },
      limit: { type: 'integer', description: 'Maximum hits per query; the effective limit is capped at 2 (1 once the soft cap is passed).' },
      contentType: { type: 'string', enum: ['code', 'prose'], description: 'Keep only code-like lines (`code`) or only lines that do not look like code (`prose`).' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hits: { type: 'integer', required: true },
          queries: { type: 'array', required: true, items: { type: 'string' } },
          rendered: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.rendered }]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { knowledgeBase, counters } = stateFor(exec);
      const now = Date.now();
      // ONE guard record for the whole call, before the query loop: a call that
      // batches five queries is one search, which is the behaviour the throttle
      // line tells the model to prefer. Blocking is an ERROR, not a short reply,
      // so a refusal cannot be mistaken for "the index has nothing".
      const flood = searchGuard.record(sessionKeyOf(exec), now);
      if (flood.blocked) throw new Error(blockedText(flood.count, Math.round((now - flood.windowStart) / 1000)));
      const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : config.searchLimit;
      const effectiveLimit = flood.softCapped ? 1 : Math.min(limit, 2);
      const sort = args.sort === 'timeline' ? 'timeline' : 'relevance';
      const blocks = [];
      let hits = 0;
      for (const query of args.queries) {
        // The cap is measured against the text actually rendered so far, and
        // the query that would cross it is replaced by upstream's notice rather
        // than dropped in silence. Every later query gets the same notice: a
        // fixed ~30 characters each, so the overshoot tracks the query count,
        // never the size of the content behind it.
        if (blocks.join('\n\n').length > config.searchMaxChars) {
          blocks.push(`## ${query}\n(output cap reached)\n`);
          continue;
        }
        let rows;
        // Counted per QUERY, next to the call that performs it: the knowledge
        // base keeps its own tally, but `ctx_stats` reads this plugin's
        // counters, and leaving them uncoupled made every search invisible.
        counters.searched += 1;
        try {
          rows = knowledgeBase.search(query, {
            limit: effectiveLimit,
            source: args.source,
            sort,
            contentType: args.contentType,
            ...(sort === 'timeline' ? {} : { session: sessionKeyOf(exec) })
          });
        } catch (error) {
          blocks.push(`## ${query}\nsearch failed: ${errorLine(error)}`);
          continue;
        }
        hits += rows.length;
        if (rows.length === 0) {
          blocks.push(`## ${query}\n(no matches)`);
          continue;
        }
        const lines = rows.map((row) => {
          const when = new Date(row.createdAt).toISOString().replace('T', ' ').slice(0, 19);
          const flag = row.isError ? ' !' : '';
          return `- [${row.source}${flag} @${when}] ${row.snippet || row.text}`;
        });
        blocks.push(`## ${query}\n${lines.join('\n')}`);
      }
      // The throttle line is appended AFTER the cap check, as upstream does, so
      // the notice about pacing is never the thing that gets truncated.
      return {
        hits,
        queries: [...args.queries],
        rendered: [...blocks, throttleText(flood.count, searchLimits)].join('\n\n')
      };
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `ctx_search (${args.queries.length} queries)`,
      kind: 'search',
      rawInput: args.queries.join('\n')
    })
  });

  /* --------------------------------------------------- ctx_fetch_and_index */

  const fetchTool = defineTool({
    name: 'ctx_fetch_and_index',
    description: [
      'Fetch one or more URLs and index the result, so the raw body never enters the conversation.',
      'This is the replacement for `curl`/`wget`/WebFetch. Fetch first, then `ctx_search` the source label to pull out only the lines you need — a 200 KB page costs one search, not one paste.',
      'Use `requests` when each URL needs its own source label; the legacy single `url` + `source` form remains accepted.'
    ].join('\n'),
    parameters: {
      url: { type: 'string', description: 'Single URL to fetch. Provide this or `requests`.' },
      requests: {
        type: 'array',
        description: 'URLs with optional per-URL source labels.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            url: { type: 'string', required: true },
            source: { type: 'string' }
          }
        }
      },
      source: { type: 'string', description: 'Source label for the legacy single `url` form.' },
      concurrency: { type: 'integer', description: 'How many URLs may be fetched at once.' },
      // Upstream's cache controls (`src/server.ts:3288-3310`): a fetched URL is
      // cached under (source, url), served from cache while younger than the TTL,
      // and `force` bypasses the lookup for a page known to have changed.
      force: { type: 'boolean', description: 'Refetch even when a fresh cached copy exists.' },
      ttl: { type: 'integer', description: 'Cache lifetime in ms; 0 disables the cache for this call.' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fetched: { type: 'integer', required: true },
          failed: { type: 'integer', required: true },
          source: { type: 'string', required: true },
          indexedLines: { type: 'integer', required: true },
          rendered: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.rendered }]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { knowledgeBase, counters } = stateFor(exec);
      const fallbackSource = typeof args.source === 'string' && args.source.trim().length > 0
        ? args.source.trim()
        : `fetch-${new Date().toISOString().slice(0, 10)}`;
      const legacySource = !Array.isArray(args.requests);
      // The current `requests` shape wins when supplied; `url`/`urls` remain a
      // hidden compatibility path for older DSH sessions.
      const requestInputs = (Array.isArray(args.requests)
        ? args.requests
        : [
            ...(typeof args.url === 'string' && args.url.length > 0 ? [{ url: args.url, source: fallbackSource }] : []),
            ...(Array.isArray(args.urls) ? args.urls.map((url) => ({ url, source: fallbackSource })) : [])
          ]).filter((entry) => typeof entry?.url === 'string' && entry.url.length > 0);
      const requests = requestInputs.map((entry, index) => ({
          index,
          url: entry.url,
          source: typeof entry.source === 'string' && entry.source.trim().length > 0
            ? entry.source.trim()
            : (legacySource ? fallbackSource : entry.url)
        }));
      if (requests.length === 0) throw new Error('ctx_fetch_and_index: provide `url`, `requests`, or legacy `urls`');
      const concurrency = Number.isInteger(args.concurrency) && args.concurrency > 0
        ? Math.min(args.concurrency, 8)
        : Math.min(config.batchConcurrency, 4);

      const results = new Array(requests.length);
      let cursor = 0;
      const worker = async () => {
        while (cursor < requests.length) {
          const index = cursor;
          const request = requests[index];
          const { url, source } = request;
          cursor += 1;
          try {
            const response = await fetchOneUrl(
              { url, source, force: args.force, ttl: args.ttl },
              knowledgeBase,
              config.__fetchSeams
            );
            if (!response.ok || response.cached === true) {
              results[index] = { ...response, source };
              continue;
            }
            const { cacheKey, text } = response;
            const indexed = knowledgeBase.index({
              source: cacheKey,
              kind: 'fetch',
              text: `# ${url}\n${text}`,
              session: exec?.agent?.session?.id,
              createdAt: Date.now()
            });
            counters.indexed += indexed.lines;
            counters.bytesIndexed += indexed.bytes ?? Buffer.byteLength(text);
            counters.fetched += 1;
            results[index] = { url, source, ok: true, status: response.status, chars: text.length, lines: indexed.lines, age: 0 };
          } catch (error) {
            results[index] = { url, source, ok: false, error: errorLine(error) };
          }
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, requests.length)) }, worker));
      const ok = results.filter((entry) => entry.ok);
      const failed = results.length - ok.length;
      const rendered = [
        `Fetched ${ok.length}/${results.length} URL(s) (${ok.reduce((total, entry) => total + entry.lines, 0)} line(s) indexed).`,
        ...results.map((entry) => (entry.ok
          ? `- ${entry.status} ${entry.url} -> ${entry.source} — ${entry.chars} chars, ${entry.lines} lines${entry.cached === true ? ` (cached ${entry.age === 0 ? 'just now' : `${entry.age}m ago`}; pass force: true to refetch)` : ''}`
          : `- FAILED ${entry.url} — ${entry.error}`)),
        ok.length > 0 ? 'Search it with ctx_search(queries: [...], source: "<source>").' : ''
      ].filter((line) => line.length > 0).join('\n');
      counters.bytesReturned += Buffer.byteLength(rendered);
      return {
        fetched: ok.length,
        failed,
        source: legacySource ? fallbackSource : (ok.length === 1 ? ok[0].source : 'multiple'),
        indexedLines: ok.reduce((total, entry) => total + entry.lines, 0),
        rendered
      };
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'ctx_fetch_and_index',
      kind: 'web',
      rawInput: args.url ?? (args.requests ?? []).map((entry) => entry.url).join('\n') ?? (args.urls ?? []).join('\n')
    })
  });

  /* ------------------------------------------------------------ ctx_insight */

  const insightTool = defineTool({
    name: 'ctx_insight',
    description: [
      'Return the address of the Insight dashboard — the upstream context-mode analytics site — as a clickable pointer.',
      'It is an EXTERNAL dashboard: nothing is uploaded, and this port never launches a browser process. Report the URL to the user instead of opening or fetching it.'
    ].join('\n'),
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          embeddable: { type: 'boolean', required: true },
          reason: { type: 'string', required: true },
          rendered: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.rendered }]
    },
    isConcurrencySafe: () => true,
    async execute() {
      return insightResult(INSIGHT_URL);
    },
    presentCall: () => ({
      card: 'generic',
      title: 'ctx_insight',
      kind: 'web',
      rawInput: INSIGHT_URL
    })
  });

  /* -------------------------------------------------------- ctx_stats / doctor / purge */

  const statsTool = defineTool({
    name: 'ctx_stats',
    description: 'Report what context-mode has captured: index size, sources, and how much has been kept out of the conversation.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rendered: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.rendered }]
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const { knowledgeBase, counters } = stateFor(exec);
      let stats;
      try {
        stats = knowledgeBase.stats();
      } catch (error) {
        throw new Error(`ctx_stats: cannot read the knowledge base: ${errorLine(error)}`);
      }
      const lines = [
        `context-mode knowledge base: ${stats.path}`,
        `entries: ${stats.lines} line(s) across ${stats.sources} source(s), ${stats.storedBytes} stored byte(s)`,
        stats.newestAt === null ? 'newest entry: (empty)' : `newest entry: ${new Date(stats.newestAt).toISOString()}`,
        `this session: ${counters.executed} execution(s), ${counters.indexed} line(s) indexed, ${counters.searched} search(es), ${counters.fetched} fetch(es)`,
        `context bytes: ${counters.bytesIndexed} indexed, ${counters.bytesReturned} returned, ${Math.max(0, counters.bytesIndexed - counters.bytesReturned)} avoided (~${Math.ceil(Math.max(0, counters.bytesIndexed - counters.bytesReturned) / 4)} tokens)`,
        stats.bySource.length === 0 ? 'sources: (none)' : `sources:\n${stats.bySource.map((entry) => `  - ${entry.source}: ${entry.lines}`).join('\n')}`
      ];
      const rendered = lines.join('\n');
      counters.bytesReturned += Buffer.byteLength(rendered);
      return { rendered };
    }
  });

  const doctorTool = defineTool({
    name: 'ctx_doctor',
    description: 'Check that the sandbox and knowledge base are usable, and report what is misconfigured.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          rendered: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.rendered }]
    },
    isConcurrencySafe: () => false,
    async execute(_args, exec) {
      const { knowledgeBase, databasePath } = stateFor(exec);
      const checks = [];
      const options = prepareRun(ctx, config, exec, {});
      const node = await runProgram(options, { ...options, language: 'javascript', code: 'console.log(process.version);' });
      checks.push({ name: 'sandbox javascript', ok: node.exitCode === 0, detail: node.stdout.trim() || node.spawnError || `exit ${node.exitCode}` });
      const python = await runProgram(options, { ...options, language: 'python', code: 'import sys; print(sys.version.split()[0])' });
      checks.push({ name: 'sandbox python', ok: python.exitCode === 0, detail: python.stdout.trim() || python.spawnError || `exit ${python.exitCode}` });
      const shell = await runProgram(options, { ...options, language: 'shell', code: process.platform === 'win32' ? 'Write-Output ok' : 'echo ok' });
      checks.push({ name: 'sandbox shell', ok: shell.exitCode === 0, detail: shell.stdout.trim() || shell.spawnError || `exit ${shell.exitCode}` });
      try {
        const verify = knowledgeBase.verify();
        checks.push({ name: 'knowledge base', ok: verify.ok, detail: `${knowledgeBase.path}: ${verify.detail}` });
      } catch (error) {
        checks.push({ name: 'knowledge base', ok: false, detail: errorLine(error) });
      }
      const failed = checks.filter((check) => !check.ok);
      const rendered = [
        ...checks.map((check) => `${check.ok ? '[ok]' : '[FAIL]'} ${check.name}: ${check.detail}`),
        '',
        failed.length === 0
          ? 'Everything context-mode needs is available.'
          : `${failed.length} check(s) failed; the affected tools will report the same failure when used.`
      ].join('\n');
      return { ok: failed.length === 0, rendered };
    }
  });

  const purgeTool = defineTool({
    name: 'ctx_purge',
    description: 'Permanently delete indexed content for one session or the current project. Destructive and irreversible; requires `confirm: true`.',
    parameters: {
      confirm: { type: 'boolean', required: true, description: 'Must be true; false cancels without deleting.' },
      sessionId: { type: 'string', description: 'Session to purge; do not combine with project scope.' },
      scope: { type: 'string', enum: ['session', 'project'], description: 'Explicit deletion scope. Session scope requires sessionId.' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          removed: { type: 'integer', required: true },
          scope: { type: 'string', required: true },
          rendered: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.rendered }]
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (args.confirm !== true) return { removed: 0, scope: 'cancelled', rendered: 'Purge cancelled; nothing was deleted.' };
      if (args.sessionId !== undefined && args.scope === 'project') throw new Error('ctx_purge: sessionId and project scope are ambiguous; pick one');
      if (args.scope === 'session' && (typeof args.sessionId !== 'string' || args.sessionId.length === 0)) {
        throw new Error('ctx_purge: session scope requires sessionId');
      }
      const { knowledgeBase, databasePath } = stateFor(exec);
      const scope = args.scope ?? (args.sessionId ? 'session' : 'project');
      const result = knowledgeBase.purge({ scope, ...(args.sessionId ? { sessionId: args.sessionId } : {}) });
      clearCounters(databasePath, scope === 'session' ? args.sessionId : undefined);
      return {
        removed: result.removed,
        scope: result.scope,
        rendered: `Purged ${result.removed} indexed line(s) from ${result.scope}${result.sessionId ? ` ${result.sessionId}` : ''}.`
      };
    }
  });

  const upgradeTool = defineTool({
    name: 'ctx_upgrade',
    description: 'Report how this DSH-bundled Context Mode can be upgraded. This private local plugin has no safe self-update command.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string', required: true },
          rendered: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.rendered }]
    },
    isConcurrencySafe: () => true,
    async execute() {
      return {
        command: '',
        rendered: 'ctx_upgrade is not automatic in DSH: dsh-context-kit is a private local plugin with no package registry or Git remote. Update the plugin source, then restart DSH.'
      };
    }
  });

  /* ------------------------------------------------------------- composition */

  ctx.effect(function* lifecycle() {
    for (const tool of [
      executeTool,
      executeFileTool,
      batchTool,
      indexTool,
      searchTool,
      fetchTool,
      statsTool,
      doctorTool,
      purgeTool,
      insightTool,
      upgradeTool
    ]) {
      yield ctx.tools.register(tool);
    }

    yield ctx.on('session/event', (session, event) => {
      try {
        if (event?.type === 'user/message') {
          const message = event.data;
          if (message?.source?.kind === 'user') indexMemory(session, event, 'user-prompt', textFromContent(message.content));
          return;
        }
        if (event?.type === 'assistant/message') {
          indexMemory(session, event, 'assistant-response', textFromContent(event.data?.message?.content));
          return;
        }
        if (event?.type === 'tool/result') {
          const content = event.data?.message?.content;
          const failed = Array.isArray(content) && content.some((part) => part?.type === 'tool-result' && part.isError === true);
          if (failed) indexMemory(session, event, 'error', textFromContent(content), true);
          return;
        }
        if (event?.type === 'compaction/summary') {
          indexMemory(session, event, 'compaction', textFromContent(event.data?.summary));
          return;
        }
        if (event?.type === 'todo/write') {
          indexMemory(session, event, 'plan', JSON.stringify(event.data?.todos ?? []));
        }
      } catch (error) {
        ctx.logger.warn(`${PLUGIN_ID}: auto-memory capture failed: ${errorLine(error)}`);
      }
    });

    yield ctx.on('agent/disposed', ({ agent }) => {
      terminateBackgroundProcesses({ owner: ctx, session: String(agent?.session?.id ?? '__default__') });
    });

    if (config.routingGuard) {
      yield ctx.on('tools/pre-execute', async (exec, next) => {
        const decision = await next();
        if (decision.kind !== 'allow') return decision;
        const name = exec.name;
        if (name !== 'bash' && name !== 'pwsh' && name !== 'shell') return decision;
        const args = exec.arguments;
        const command = typeof args?.command === 'string' ? args.command : '';
        if (command.length === 0) return decision;
        if (commandFetchesIntoContext(command)) {
          return {
            kind: 'deny',
            reason: [
              `${PLUGIN_ID} routing: \`${command.slice(0, 80)}\` fetches a URL through the shell, which drops the raw body into the conversation.`,
              'Use `ctx_execute` with a short program that fetches, derives the answer in code, and prints only the result — the body stays in the sandbox.',
              'Or use `ctx_fetch_and_index` to index the response and pull out only the lines you need with `ctx_search`.',
              'A silent fetch that writes to a file is allowed here, because its body never reaches the conversation.',
              'Set `routingGuard: false` on the context-mode row to disable this guard.'
            ].join(' ')
          };
        }
        if (INLINE_HTTP_PATTERNS.some((pattern) => pattern.test(stripHeredocs(command)))) {
          return {
            kind: 'deny',
            reason: [
              `${PLUGIN_ID} routing: this command performs inline HTTP from the shell.`,
              'Use `ctx_execute` with a short program that prints only the answer, or `ctx_fetch_and_index` to index the response.',
              'Set `routingGuard: false` on the context-mode row to disable this guard.'
            ].join(' ')
          };
        }
        if (BUILD_TOOL_PATTERN.test(command)) {
          return {
            kind: 'deny',
            reason: [
              `${PLUGIN_ID} routing: a build tool's output is large and rarely worth its bytes.`,
              'Run it through `ctx_execute` (language "shell") or `ctx_batch_execute` so the log stays in the sandbox and only the failure or the summary enters the conversation.',
              'Set `routingGuard: false` on the context-mode row to disable this guard.'
            ].join(' ')
          };
        }
        return decision;
      });
    }

    const commands = ctx.get('commands');
    if (commands === undefined || config.commands === false) return;
    yield commands.register({
      name: 'ctx',
      description: 'context-mode: stats | doctor | purge',
      async handler(invocation) {
        const { knowledgeBase, counters, databasePath } = stateFor(invocation);
        const verb = invocation.rawInput.trim().toLowerCase();
        if (verb === 'stats' || verb.length === 0) {
          const stats = knowledgeBase.stats();
          return {
            kind: 'success',
            text: [
              `knowledge base: ${stats.path}`,
              `${stats.lines} line(s), ${stats.sources} source(s)`,
              `${counters.executed} execution(s), ${counters.searched} search(es), ${counters.fetched} fetch(es)`
            ].join('\n')
          };
        }
        if (verb === 'doctor') {
          const verify = knowledgeBase.verify();
          return { kind: 'success', text: `knowledge base ${verify.ok ? 'ok' : 'FAILED'}: ${verify.detail}\nsandbox languages: ${LANGUAGE_ENUM.join(', ')}` };
        }
        if (verb === 'purge confirm') {
          const result = knowledgeBase.purge();
          clearCounters(databasePath);
          return { kind: 'success', text: `Purged ${result.removed} indexed line(s).` };
        }
        if (verb === 'purge') return { kind: 'error', text: 'Refused: use `/ctx purge confirm` for this irreversible project purge.' };
        return { kind: 'error', text: 'Usage: /ctx [stats|doctor|purge confirm]' };
      }
    });
  }, 'context-mode lifecycle');
}

export { INSIGHT_URL, KnowledgeBase, LANGUAGES, runProgram };
export { classifyIp, ssrfRefusalForTest, toPlainText } from './context-mode-fetch.js';
