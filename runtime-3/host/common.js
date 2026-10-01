/**
 * Shared plumbing for the DSH ports of DCP and context-mode.
 *
 * Everything here is deliberately dependency-free apart from `node:` builtins
 * and the harness packages the callers already import: it is the layer both
 * plugins agree on (paths, JSONC config reading, session-surface walking,
 * bounded subprocess output, and message construction).
 *
 * @module dsh-context-kit/common
 */

import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/* ------------------------------------------------------------------ paths */

/** The harness home: `$DSH_HOME` when set, else `~/.dsh`. */
export function dshHome() {
  const configured = process.env.DSH_HOME;
  if (typeof configured === 'string' && configured.trim().length > 0) return resolve(configured);
  return join(homedir(), '.dsh');
}

/** One plugin-private directory under the harness home, created on demand. */
export function kitDir(name) {
  const dir = join(dshHome(), 'context-kit', name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Read a UTF-8 text file, or `undefined` when it does not exist. */
export function readTextIfPresent(path) {
  try {
    if (!existsSync(path)) return undefined;
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------- jsonc */

/**
 * Strip `//` and block comments plus trailing commas from JSONC source.
 *
 * The scanner is string-aware: comment markers inside a quoted string are
 * content, not syntax, so a config value containing `http://…` survives.
 *
 * @param text - JSONC source.
 * @returns plain JSON source.
 */
export function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Read and parse one JSONC document.
 * @param path - file to read.
 * @returns the parsed value, or `undefined` when the file is absent or invalid.
 */
export function readJsonc(path) {
  const text = readTextIfPresent(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(stripJsonComments(text));
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ values */

/** Plain-object test used throughout both plugins. */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Stable stringify with sorted keys, for call-signature comparison. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/**
 * Count Unicode code points without splitting surrogate pairs.
 *
 * `sandbox.js` bounds child output with this, so a cut never lands inside a
 * surrogate pair and mangles the last character.
 *
 * @param text - text to measure.
 * @returns the code-point count.
 */
export function codePointLength(text) {
  return Array.from(text).length;
}

/** Render an unknown thrown value as one diagnostic line. */
export function errorLine(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/* --------------------------------------------------------------- messages */

/**
 * Whether one path resolves outside the session workspace.
 *
 * Context Mode uses this predicate to enforce the upstream project boundary for
 * `ctx_execute_file` and path-backed indexing. Other callers may use it only as
 * an observation, so the function reports rather than throws.
 *
 * Both paths are realpath'd when they exist, because a workspace under a
 * symlinked temporary directory (the harness's own scratch lives in one) would
 * otherwise look like an escape to a lexical comparison.
 *
 * @param path - the resolved candidate path.
 * @param cwd - the session workspace root.
 * @returns true when the path is outside the workspace.
 */
export function pathsOutsideWorkspace(path, cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return false;
  if (typeof path !== 'string' || path.length === 0) return false;
  const normalize = (value) => {
    let real = resolve(value);
    try {
      real = realpathSync(real);
    } catch {
      // A path that does not exist yet keeps its resolved form.
    }
    const slashed = real.replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
  };
  const root = normalize(cwd);
  const target = normalize(path);
  return target !== root && !target.startsWith(`${root}/`);
}

/* ------------------------------------------------------- bounded subprocess */
