/** Focused redirect, HTTP status, streaming limit, and conversion checks. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { fetchOneUrl, guardedConnectLookup, toPlainText } from '../lib/context-mode-fetch.js';

let checks = 0;
const check = (name, condition, detail = '') => {
  checks += 1;
  console.log(`${condition ? '[ok]  ' : '[FAIL]'} ${name}${detail ? ` - ${detail}` : ''}`);
  assert.ok(condition, name);
};

const knowledgeBase = { sourceMeta: () => undefined };
const headers = (values = {}) => ({
  get(name) {
    const key = Object.keys(values).find((candidate) => candidate.toLowerCase() === String(name).toLowerCase());
    return key === undefined ? null : String(values[key]);
  }
});
const publicLookup = async (hostname) => [{ address: hostname === 'blocked.test' ? '169.254.169.254' : '8.8.8.8', family: 4 }];

console.log('--- connect-time DNS is checked again ---');
{
  const error = await new Promise((resolve) => {
    guardedConnectLookup('rebind.test', {}, (problem) => resolve(problem), (_hostname, options, callback) => {
      assert.equal(options.all, true);
      callback(null, [{ address: '169.254.169.254', family: 4 }]);
    });
  });
  check('DNS rebinding to link-local metadata is refused at connect time', error instanceof Error && /connect-time DNS refused/.test(error.message), error?.message);
}

console.log('\n--- environment proxies cannot replace the guarded transport ---');
{
  const originalFetch = globalThis.fetch;
  const originalHttpProxy = process.env.HTTP_PROXY;
  const originalProxy = process.env.HTTPS_PROXY;
  const originalProxyFlag = process.env.NODE_USE_ENV_PROXY;
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('direct guarded response');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    process.env.HTTP_PROXY = 'http://127.0.0.1:10808';
    process.env.HTTPS_PROXY = 'http://127.0.0.1:10808';
    process.env.NODE_USE_ENV_PROXY = '1';
    globalThis.fetch = async () => { throw new Error('incompatible global fetch was used'); };
    const result = await fetchOneUrl(
      { url: `http://127.0.0.1:${port}/proxy`, source: 'proxy', force: true },
      knowledgeBase
    );
    check('configured environment proxy does not block a guarded fetch', result.ok === true && result.text === 'direct guarded response');
    check('default transport does not mix global fetch with a package Agent', result.ok === true);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
    if (originalHttpProxy === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = originalHttpProxy;
    if (originalProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = originalProxy;
    if (originalProxyFlag === undefined) delete process.env.NODE_USE_ENV_PROXY;
    else process.env.NODE_USE_ENV_PROXY = originalProxyFlag;
  }
}

console.log('--- redirects are manual and each target is revalidated ---');
{
  const requests = [];
  const result = await fetchOneUrl(
    { url: 'https://safe.test/start', source: 'redirect', force: true },
    knowledgeBase,
    {
      lookup: publicLookup,
      fetch: async (url, options) => {
        requests.push({ url, options });
        return { status: 302, headers: headers({ location: 'http://blocked.test/metadata' }), body: { cancel: async () => {} } };
      }
    }
  );
  check('redirect to a DNS name resolving to IMDS is refused', result.ok === false && /169\.254\.169\.254|blocked/.test(result.error), result.error);
  check('blocked redirect is never requested', requests.length === 1);
  check('automatic redirect handling is disabled', requests[0].options.redirect === 'manual');
}

console.log('\n--- non-2xx and Content-Length fail before body reads ---');
{
  let bodyRead = false;
  const unavailable = await fetchOneUrl(
    { url: 'https://safe.test/unavailable', source: 'status', force: true },
    knowledgeBase,
    {
      lookup: publicLookup,
      fetch: async () => ({
        status: 503,
        headers: headers({ 'content-type': 'text/plain' }),
        body: { cancel: async () => {} },
        text: async () => { bodyRead = true; return 'maintenance'; }
      })
    }
  );
  check('non-2xx is rejected with its HTTP status', unavailable.ok === false && unavailable.status === 503 && unavailable.error === 'HTTP 503');
  check('non-2xx body is not materialized', bodyRead === false);

  const declared = await fetchOneUrl(
    { url: 'https://safe.test/declared-large', source: 'length', force: true },
    knowledgeBase,
    {
      lookup: publicLookup,
      maxBytes: 7,
      fetch: async () => ({
        status: 200,
        headers: headers({ 'content-length': '8', 'content-type': 'text/plain' }),
        body: { cancel: async () => {} },
        text: async () => { bodyRead = true; return '12345678'; }
      })
    }
  );
  check('Content-Length is rejected before reading', declared.ok === false && /Content-Length.*8.*7-byte ceiling/.test(declared.error), declared.error);
}

console.log('\n--- streaming cap counts UTF-8 bytes, not characters ---');
{
  let reads = 0;
  let cancelled = false;
  const multibyte = await fetchOneUrl(
    { url: 'https://safe.test/multibyte', source: 'bytes', force: true },
    knowledgeBase,
    {
      lookup: publicLookup,
      maxBytes: 7,
      fetch: async () => ({
        status: 200,
        headers: headers({ 'content-type': 'text/plain' }),
        body: {
          getReader: () => ({
            read: async () => (++reads === 1 ? { done: false, value: Buffer.from('🎯🎯') } : { done: true }),
            cancel: async () => { cancelled = true; }
          })
        }
      })
    }
  );
  check('two emoji exceed a seven-byte cap', multibyte.ok === false && /at least 8 bytes.*7-byte ceiling/.test(multibyte.error), multibyte.error);
  check('oversized stream is cancelled immediately', reads === 1 && cancelled);
}

console.log('\n--- readable HTML and nested JSON conversion ---');
{
  const html = toPlainText(
    '<header>menu</header><h2>Guide &amp; API</h2><p>Read <a href="/docs">the docs</a>.</p><ul><li>first</li><li><code>x()</code></li></ul><script>secret()</script>',
    'text/html; charset=utf-8'
  );
  check('HTML keeps headings, links, lists, and inline code', html.includes('## Guide & API') && html.includes('[the docs](/docs)') && html.includes('- first') && html.includes('`x()`'));
  check('HTML removes page chrome and executable content', !html.includes('menu') && !html.includes('secret'));

  const json = toPlainText(JSON.stringify({ id: 7, user: { profile: { name: 'Ada', roles: ['admin', 'author'] } } }), 'application/problem+json');
  check('nested JSON exposes searchable key-path headings', json.includes('## user > profile') && json.includes('## user > profile > roles'));
  check('nested JSON preserves primitive values', json.includes('"id": 7') && json.includes('"name": "Ada"') && json.includes('"admin"'));
}

console.log(`\nall ${checks} context-mode fetch checks passed`);
