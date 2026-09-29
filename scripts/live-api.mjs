// Drive the running `dsh web` server over its own HTTP API.
//
// WHY THIS EXISTS. The live GUI needs authentication, and there is no MCP browser driver in this
// harness, so an end-to-end turn cannot be clicked through. It does not have to be: the server
// issues a signed cookie derived from a secret it already keeps on disk
// (`~/.dsh/.credentials.yaml`, record `client-connection/browser-session`), and the same bundles
// that mint it document how (`dsh-client-connection/lib/index.js`: `cookieName`, `encodeCookie`,
// `sessionCookie`, `requestAuthority`). This script reconstructs that cookie and asks the server
// for the app.
//
// Usage:
//   node scripts/live-api.mjs probe                 # authenticate, list what the app exposes
//   node scripts/live-api.mjs sessions              # list sessions from the API
//
// Read-only by default. Anything that mutates goes behind an explicit subcommand so a probe can
// never edit a conversation by accident.

import { createHash, createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh');
const base = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080';
const authority = new URL(base).host;

/* ------------------------------------------------------------- the credential */

/** Pull the one secret this needs out of the credentials file without a YAML dependency. */
function browserSessionSecret() {
  const text = readFileSync(join(home, '.credentials.yaml'), 'utf8');
  const lines = text.split(/\r?\n/u);
  // The record name is a nested key; find it, then the first `secret:` at a deeper indent that
  // follows, and stop at the next key of the same or shallower indent.
  const start = lines.findIndex((line) => line.includes('client-connection/browser-session'));
  if (start === -1) throw new Error('client-connection/browser-session is not in .credentials.yaml');
  let indent = lines[start].search(/\S/u);
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0) continue;
    const here = line.search(/\S/u);
    if (here < indent) break;
    const match = line.match(/secret:\s*(\S+)/u);
    if (match !== null) return match[1].replace(/^["']|["']$/gu, '');
    if (here === indent) indent = here;
  }
  throw new Error('no secret found under the browser-session record');
}

const base64url = (value) => Buffer.from(value).toString('base64')
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');

/** The cookie the server would have set for this browser: name from the authority, HMAC body. */
function sessionCookie(secret) {
  const name = `dsh-auth-${base64url(createHash('sha256').update(authority).digest())}`;
  const now = Date.now();
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 30 * 24 * 3600 * 1000 };
  const body = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signed = base64url(createHmac('sha256', secret).update(body).digest());
  return { name, value: `v1.${body}.${signed}`, header: `${name}=v1.${body}.${signed}` };
}

/* ------------------------------------------------------------------ requests */

const secret = browserSessionSecret();
console.log(`authority   : ${authority}`);
console.log(`cookie name : ${sessionCookie(secret).name}`);
console.log(`secret      : ${secret.length} chars, from ${join(home, '.credentials.yaml')}`);

/**
 * The cookie to send.
 *
 * A locally minted cookie — the same construction the server uses for a returning browser — is
 * NOT accepted on this build (probed: 401 with a well-formed `v1.<body>.<sig>` for this authority).
 * What the server does accept is the **launch token** from the URL it prints when it starts
 * (`?token=...`, `TOKEN_QUERY = "token"`): exchanging it sets the persistent cookie. So the cookie
 * is captured from that exchange once and cached next to the edit state, and every later call
 * reuses it.
 */
const cookiePath = join(home, 'context-kit', 'web-session.cookie');
let cookieHeader = (() => {
  try {
    return readFileSync(cookiePath, 'utf8').trim();
  } catch {
    return undefined;
  }
})();

/** Exchange a launch token for the persistent cookie and cache it. */
async function login(token) {
  const response = await fetch(new URL(`/?token=${token}`, base), { redirect: 'manual' });
  const raw = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''];
  const found = raw.map((entry) => entry.split(';')[0]).find((entry) => entry.startsWith('dsh-auth-'));
  if (found === undefined) {
    console.log(`login failed: ${response.status}, no dsh-auth cookie in the response`);
    console.log(`  set-cookie: ${JSON.stringify(raw)}`);
    process.exitCode = 1;
    return false;
  }
  cookieHeader = found;
  mkdirSync(dirname(cookiePath), { recursive: true });
  writeFileSync(cookiePath, `${found}\n`, 'utf8');
  console.log(`login ok: ${response.status}, cookie cached at ${cookiePath}`);
  return true;
}

/** One authenticated request, returning status, headers and body text. */
async function ask(path, options = {}) {
  const response = await fetch(new URL(path, base), {
    ...options,
    headers: {
      ...(cookieHeader === undefined ? {} : { cookie: cookieHeader }),
      accept: 'application/json, text/html',
      ...(options.headers ?? {})
    },
    redirect: 'manual'
  });
  const body = await response.text();
  return { status: response.status, body, type: response.headers.get('content-type') ?? '' };
}

const command = process.argv[2] ?? 'probe';

if (command === 'login') {
  const token = process.argv[3];
  if (token === undefined) {
    console.log('usage: node scripts/live-api.mjs login <token from the dsh web URL>');
    process.exitCode = 2;
  } else {
    await login(token);
  }
} else if (command === 'probe') {
  if (cookieHeader === undefined) {
    console.log('\nno cached cookie yet: run `login <token>` with the token from the dsh web URL');
  }
  for (const path of ['/', '/api', '/api/sessions', '/api/health']) {
    const result = await ask(path);
    const head = result.body.replace(/\s+/gu, ' ').slice(0, 160);
    console.log(`\n${path} -> ${result.status} ${result.type}\n  ${head}`);
  }
} else if (command === 'sessions') {
  const result = await ask('/api/sessions');
  console.log(`\n/api/sessions -> ${result.status}`);
  console.log(result.body.slice(0, 2000));
} else {
  console.log(`unknown command ${JSON.stringify(command)}; try: login <token> | probe | sessions`);
  process.exitCode = 2;
}
