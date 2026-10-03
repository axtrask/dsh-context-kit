/** URL validation, cache reads, and response loading without plugin registration. */
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns';
import { Agent, fetch as undiciFetch } from 'undici';

import { errorLine } from './common.js';

/**
 * Classify an IP address the way upstream does.
 *
 * `block` is always refused; `private` is loopback or RFC1918, which is allowed by
 * default because the runtime is usually the user's own machine (`src/server.ts:3244-3286`).
 *
 * Two details are load-bearing and easy to get wrong:
 *
 * - An IPv6 zone identifier (`fe80::1%eth0`, URL-encoded `%25eth0`) must be stripped
 *   BEFORE classification. Without the strip, `::1%eth0` stops matching the loopback
 *   equality and falls through to "public", silently bypassing the guard.
 * - IPv4-mapped IPv6 (`::ffff:127.0.0.1`) must recurse through the IPv4 classifier,
 *   which is why the `:` check comes first.
 *
 * @param rawIp - one resolved address.
 * @returns the verdict.
 */
export function classifyIp(rawIp) {
  const percent = String(rawIp ?? '').indexOf('%');
  const ip = percent === -1 ? String(rawIp ?? '') : String(rawIp).slice(0, percent);
  const lower = ip.toLowerCase();
  if (lower.includes(':')) {
    const mapped = lower.match(/^::ffff:([\d.]+)$/);
    if (mapped) return classifyIp(mapped[1]);
    const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const high = Number.parseInt(mappedHex[1], 16);
      const low = Number.parseInt(mappedHex[2], 16);
      return classifyIp(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    if (isIP(ip) !== 6) return 'block';
    if (lower === '::') return 'block';
    if (/^fe[89ab]/.test(lower)) return 'block';
    if (lower.startsWith('ff')) return 'block';
    if (lower.startsWith('2001:db8')) return 'block';
    if (lower === '::1') return 'private';
    if (lower.startsWith('fc') || lower.startsWith('fd')) return 'private';
    return 'public';
  }
  if (!ip.includes('.')) return 'block';
  const rawParts = ip.split('.');
  if (rawParts.length !== 4 || rawParts.some((part) => !/^\d{1,3}$/.test(part))) return 'block';
  const parts = rawParts.map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => part < 0 || part > 255)) return 'block';
  const [a, b] = parts;
  if (a === 169 && b === 254) return 'block';
  if (a === 0) return 'block';
  if (a === 100 && b >= 64 && b <= 127) return 'block';
  if (a === 192 && b === 0) return 'block';
  if (a === 192 && b === 88 && parts[2] === 99) return 'block';
  if (a === 198 && (b === 18 || b === 19)) return 'block';
  if (a === 198 && b === 51 && parts[2] === 100) return 'block';
  if (a === 203 && b === 0 && parts[2] === 113) return 'block';
  if (a >= 224) return 'block';
  if (a === 127) return 'private';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  return 'public';
}

/**
 * Refuse a URL whose bytes must never be fetched.
 *
 * Upstream performs this BEFORE any cache lookup or subprocess spawn, and resolves
 * the hostname to check the ADDRESS rather than the name, which is what defends
 * against a hostile DNS record pointing `evil.com` at the metadata service
 * (`src/server.ts:3168-3234`). `CTX_FETCH_STRICT=1` additionally refuses loopback
 * and RFC1918, for hosted or CI environments where the runtime is not the user's
 * own machine.
 *
 * @param rawUrl - the URL to check.
 * @returns `undefined` when the fetch is safe, or the refusal message.
 */
async function ssrfRefusal(rawUrl, seams = {}) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    return 'invalid URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `URL scheme "${parsed.protocol}" not allowed (only http: and https:)`;
  }
  const strict = process.env.CTX_FETCH_STRICT === '1';
  try {
    const lookup = seams.lookup ?? (await import('node:dns/promises')).lookup;
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    const records = isIP(hostname) === 0
      ? await lookup(hostname, { all: true, verbatim: true })
      : [{ address: hostname, family: isIP(hostname) }];
    if (!Array.isArray(records) || records.length === 0) return `DNS lookup returned no addresses for "${hostname}"`;
    for (const record of records) {
      const verdict = classifyIp(record.address);
      if (verdict === 'block') {
        return `URL "${hostname}" resolves to ${record.address} — blocked (link-local / IMDS / multicast / reserved)`;
      }
      if (verdict === 'private' && strict) {
        return `URL "${hostname}" resolves to private IP ${record.address} — blocked under CTX_FETCH_STRICT=1`;
      }
    }
  } catch (error) {
    const code = error?.code ?? '';
    const transient = ['ETIMEOUT', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EPERM'].includes(code);
    return `DNS lookup failed for "${parsed.hostname}": ${errorLine(error)}`
      + (transient ? ' — transient DNS error; retry once before falling back.' : '');
  }
  return undefined;
}

/** Upstream's fetch timeout: 30 seconds (`src/server.ts:3323`). */
const FETCH_TIMEOUT_MS = 30_000;

/** Maximum redirects followed after validating every new target. */
const FETCH_MAX_REDIRECTS = 5;

/** Upstream's response size ceiling. */
const FETCH_MAX_BYTES = 50 * 1024 * 1024;

/** Default cache lifetime for a fetched URL (`FETCH_TTL_MS`). */
const FETCH_TTL_MS = 24 * 60 * 60 * 1000;

/** Re-check every address at the transport lookup immediately before connect. */
export function guardedConnectLookup(hostname, options, callback, lookup = dnsLookup) {
  lookup(hostname, { ...options, all: true, verbatim: true }, (error, records) => {
    if (error) return callback(error);
    const list = Array.isArray(records) ? records : [records];
    const strict = process.env.CTX_FETCH_STRICT === '1';
    const refused = list.find((record) => {
      const verdict = classifyIp(record?.address);
      return verdict === 'block' || (verdict === 'private' && strict);
    });
    if (refused !== undefined) return callback(new Error(`connect-time DNS refused ${hostname} -> ${refused.address}`));
    if (list.length === 0) return callback(new Error(`connect-time DNS returned no addresses for ${hostname}`));
    return options?.all === true
      ? callback(null, list)
      : callback(null, list[0].address, list[0].family);
  });
}

const safeDispatcher = new Agent({ connect: { lookup: guardedConnectLookup } });

/** Return cached metadata, a refusal, or fetched text for the caller to index. */
export async function fetchOneUrl({ url, source, force, ttl }, knowledgeBase, seams = {}) {
  // The guard runs BEFORE the cache lookup: a refusal must not be served
  // from a previously-poisoned cache slot, and a hostile DNS record must
  // be judged on the ADDRESS it resolves to (upstream `:3288-3293`).
  const refusal = await ssrfRefusal(url, seams);
  if (refusal !== undefined) return { url, ok: false, error: refusal };
  const cacheKey = `${source}::${url}`;
  const cacheTtl = Number.isInteger(ttl) && ttl >= 0 ? ttl : FETCH_TTL_MS;
  if (force !== true && cacheTtl !== 0) {
    const cached = knowledgeBase.sourceMeta(cacheKey);
    if (cached !== undefined && Date.now() - cached.indexedAt < cacheTtl) {
      const ageMin = Math.floor((Date.now() - cached.indexedAt) / 60000);
      return { url, ok: true, status: 200, cached: true, chars: cached.chars, lines: cached.lines, age: ageMin };
    }
  }
  // The dispatcher and fetch implementation must come from the same Undici
  // version. Node's bundled fetch rejects an Agent from the package copy.
  const fetchImpl = seams.fetch ?? undiciFetch;
  const lookup = seams.lookup;
  const timeoutMs = seams.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = seams.maxBytes ?? FETCH_MAX_BYTES;
  const signal = seams.signal ?? AbortSignal.timeout(timeoutMs);
  let currentUrl = String(url);
  let response;
  for (let redirects = 0; redirects <= FETCH_MAX_REDIRECTS; redirects += 1) {
    const hopRefusal = await ssrfRefusal(currentUrl, { lookup });
    if (hopRefusal !== undefined) return { url, ok: false, error: hopRefusal };
    response = await fetchImpl(currentUrl, {
      redirect: 'manual',
      signal,
      ...(seams.fetch === undefined ? { dispatcher: safeDispatcher } : {}),
      headers: { 'user-agent': 'dsh-context-mode/0.1 (+https://github.com/mksglu/context-mode)' }
    });
    const status = Number(response.status);
    if (status < 300 || status >= 400) break;
    const location = response.headers?.get?.('location');
    if (!location) break;
    await discardBody(response);
    if (redirects === FETCH_MAX_REDIRECTS) {
      return { url, ok: false, error: `redirect chain exceeded ${FETCH_MAX_REDIRECTS} hops` };
    }
    try {
      currentUrl = new URL(location, currentUrl).toString();
    } catch {
      return { url, ok: false, error: `invalid redirect Location: ${location}` };
    }
  }
  const status = Number(response?.status);
  if (!Number.isInteger(status) || status < 200 || status >= 300) {
    await discardBody(response);
    return { url, ok: false, status: Number.isInteger(status) ? status : 0, error: `HTTP ${Number.isInteger(status) ? status : 'response has no status'}` };
  }
  let body;
  try {
    body = await readBodyWithLimit(response, maxBytes);
  } catch (error) {
    return { url, ok: false, status, error: errorLine(error) };
  }
  const text = toPlainText(body, response.headers.get('content-type') ?? '');
  return { url, ok: true, status, cacheKey, text };
}

/** Consume a rejected response enough to release its connection. */
async function discardBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    /* the transport may already have closed it */
  }
}

/** Read a response incrementally and reject before retaining more than the cap. */
async function readBodyWithLimit(response, maxBytes) {
  const contentLength = response.headers?.get?.('content-length');
  if (typeof contentLength === 'string' && /^\s*\d+\s*$/.test(contentLength)) {
    const declared = Number(contentLength);
    if (declared > maxBytes) {
      await discardBody(response);
      throw new Error(`response Content-Length is ${declared} bytes, over the ${maxBytes}-byte ceiling`);
    }
  }

  if (typeof response.body?.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* already closed */ }
        throw new Error(`response is at least ${total} bytes, over the ${maxBytes}-byte ceiling`);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total).toString('utf8');
  }

  if (typeof response.arrayBuffer === 'function') {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(`response is ${bytes.length} bytes, over the ${maxBytes}-byte ceiling`);
    return bytes.toString('utf8');
  }
  const text = await response.text();
  const bytes = Buffer.byteLength(text);
  if (bytes > maxBytes) throw new Error(`response is ${bytes} bytes, over the ${maxBytes}-byte ceiling`);
  return text;
}

/**
 * Reduce a fetched response body to searchable text.
 *
 * The knowledge base is a line index, so HTML tags are stripped when the
 * content type says HTML: indexing markup would make every query match tag
 * names. JSON and plain text are indexed as-is.
 *
 * @param body - raw response body.
 * @param contentType - the response's content type.
 * @returns text for the index.
 */
export function toPlainText(body, contentType) {
  if (/application\/json|[^;\s]+\+json/i.test(contentType)) {
    try {
      return jsonKeyPathText(JSON.parse(body));
    } catch {
      return body;
    }
  }
  if (!/html|xhtml/i.test(contentType)) return body;
  return htmlToReadableText(body);
}

/** Convert nested JSON into Markdown sections whose headings are key paths. */
function jsonKeyPathText(value) {
  const sections = [];
  const walk = (current, path) => {
    const title = path.length === 0 ? '(root)' : path.join(' > ');
    if (Array.isArray(current)) {
      if (current.some((item) => item !== null && typeof item === 'object')) {
        current.forEach((item, index) => walk(item, [...path, `[${index}]`]));
      } else {
        sections.push(`## ${title}\n${JSON.stringify(current, null, 2)}`);
      }
      return;
    }
    if (current !== null && typeof current === 'object') {
      const flat = {};
      const nested = [];
      for (const [key, item] of Object.entries(current)) {
        if (item !== null && typeof item === 'object') nested.push([key, item]);
        else flat[key] = item;
      }
      if (Object.keys(flat).length > 0 || nested.length === 0) {
        sections.push(`## ${title}\n${JSON.stringify(flat, null, 2)}`);
      }
      for (const [key, item] of nested) walk(item, [...path, key]);
      return;
    }
    sections.push(`## ${title}\n${JSON.stringify(current)}`);
  };
  walk(value, []);
  return sections.join('\n\n');
}

/** Lightweight HTML-to-Markdown conversion for the structural tags web pages use. */
function htmlToReadableText(body) {
  const preBlocks = [];
  let text = String(body).replace(/\r\n?/g, '\n')
    .replace(/<(script|style|nav|header|footer|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_match, inner) => {
      const index = preBlocks.length;
      preBlocks.push(decodeHtml(inner.replace(/<[^>]+>/g, '')).replace(/^\n+|\n+$/g, ''));
      return `\n\nCTXPREBLOCK${index}TOKEN\n\n`;
    });

  text = text
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level, inner) => `\n\n${'#'.repeat(Number(level))} ${inner}\n\n`)
    .replace(/<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_match, _quote, href, label) => `[${label}](${decodeHtml(href)})`)
    .replace(/<img\b[^>]*alt\s*=\s*(["'])(.*?)\1[^>]*>/gi, (_match, _quote, alt) => decodeHtml(alt))
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_match, inner) => `\`${inner.replace(/<[^>]+>/g, '')}\``)
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<blockquote\b[^>]*>/gi, '\n\n> ')
    .replace(/<\/(blockquote)>/gi, '\n\n')
    .replace(/<\/?(p|div|section|article|main|aside|ul|ol|table|thead|tbody|tr|figure|figcaption|details|summary)\b[^>]*>/gi, '\n\n')
    .replace(/<\/?(td|th)\b[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((line) => decodeHtml(line).replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text.replace(/CTXPREBLOCK(\d+)TOKEN/g, (_match, index) => `\`\`\`\n${preBlocks[Number(index)]}\n\`\`\``);
}

function decodeHtml(text) {
  const named = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' };
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, key) => {
    if (key[0] !== '#') return named[key.toLowerCase()] ?? entity;
    const value = key[1].toLowerCase() === 'x'
      ? Number.parseInt(key.slice(2), 16)
      : Number.parseInt(key.slice(1), 10);
    try {
      return Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : entity;
    } catch {
      return entity;
    }
  });
}

/**
 * Test-only view of the SSRF guard.
 *
 * `classifyIp` is exported as itself because upstream exports it too, for exactly
 * this reason. This exposes the DNS-resolving half, which is where the guard can
 * regress without any visible symptom.
 *
 * @param url - the URL to check.
 * @returns the refusal message, or undefined when the fetch is safe.
 */
export const ssrfRefusalForTest = (url, seams) => ssrfRefusal(url, seams);
