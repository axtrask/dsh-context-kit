/**
 * The fetch guard, the fetch cache, and the output budget.
 *
 * Three behaviours the port got wrong, each with a consequence a user can feel:
 *
 * 1. NO SSRF guard at all. Upstream refuses a URL whose scheme is not http/https
 *    and whose hostname RESOLVES to a blocked address — link-local (including the
 *    cloud metadata service at 169.254.169.254), `0.0.0.0/8`, multicast and
 *    reserved, over both IPv4 and IPv6, with `CTX_FETCH_STRICT=1` adding loopback
 *    and RFC1918 (`src/server.ts:3168-3286`). It checks the resolved ADDRESS, which
 *    is what defends against a hostile DNS record. The port fetched anything,
 *    including `file://`.
 * 2. No fetch cache. Upstream keys it by (source, url), serves a copy younger than
 *    `ttl` (default 24 h), and lets `force: true` bypass it
 *    (`src/server.ts:3295-3310`).
 * 3. An output budget that lied. The truncation notice quoted `maxOutputChars`
 *    while the real bound came from `headChars`/`tailChars`, so raising the setting
 *    changed only the wording. Upstream returns stdout in full below
 *    `LARGE_OUTPUT_THRESHOLD = 102_400` bytes (`:1980`).
 *
 * Run:  node scripts/test-fetch-guard.mjs
 *
 * @module dsh-context-kit/scripts/test-fetch-guard
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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

const contextMode = await import(pathToFileURL(join(kitRoot, 'lib', 'context-mode.js')).href);
const { classifyIp, ssrfRefusalForTest } = contextMode;

console.log('\n--- the fetch module is independent, with stable entrypoint exports ---');
{
  const moduleUrl = pathToFileURL(join(kitRoot, 'lib', 'context-mode-fetch.js')).href;
  const fetchModule = await import(moduleUrl);
  check('the original helper exports are direct re-exports', classifyIp === fetchModule.classifyIp && ssrfRefusalForTest === fetchModule.ssrfRefusalForTest && contextMode.toPlainText === fetchModule.toPlainText);
  const standalone = spawnSync(process.execPath, ['--input-type=module'], {
    input: `
      import { registerHooks } from 'node:module';
      registerHooks({ resolve(specifier, context, next) {
        if (specifier === 'node:sqlite' || ['context-mode', 'knowledge-base', 'dcp', 'edit-gui'].some((name) => specifier.endsWith('/' + name + '.js'))) {
          throw new Error('fetch module imported a plugin or database: ' + specifier);
        }
        return next(specifier, context);
      } });
      globalThis.fetch = () => { throw new Error('network request during import'); };
      const module = await import(${JSON.stringify(moduleUrl)});
      if (typeof module.fetchOneUrl !== 'function') throw new Error('fetchOneUrl is missing');
    `,
    encoding: 'utf8',
    timeout: 10_000
  });
  check('standalone import needs no plugin, database, or network', standalone.status === 0, standalone.stderr || standalone.error?.message || '');
}

console.log('\n--- IP classification (upstream `classifyIp`) ---');
{
  /** `[address, verdict, why]` — expected values are upstream's. */
  const cases = [
    ['169.254.169.254', 'block', 'the cloud metadata service (IMDS)'],
    ['169.254.0.1', 'block', 'link-local'],
    ['0.0.0.0', 'block', '0.0.0.0/8 current network'],
    ['224.0.0.1', 'block', 'multicast'],
    ['239.255.255.250', 'block', 'SSDP multicast'],
    ['255.255.255.255', 'block', 'broadcast'],
    ['127.0.0.1', 'private', 'loopback'],
    ['10.1.2.3', 'private', 'RFC1918 10/8'],
    ['172.16.0.1', 'private', 'RFC1918 172.16/12'],
    ['172.31.255.254', 'private', 'RFC1918 172.16/12 upper edge'],
    ['192.168.1.1', 'private', 'RFC1918 192.168/16'],
    ['8.8.8.8', 'public', 'a public resolver'],
    ['172.32.0.1', 'public', 'just OUTSIDE 172.16/12'],
    ['::1', 'private', 'IPv6 loopback'],
    ['fe80::1', 'block', 'IPv6 link-local'],
    // The zone-identifier bypass: without stripping `%eth0`, a loopback stops
    // matching the equality test and is classified "public".
    ['fe80::1%eth0', 'block', 'IPv6 link-local WITH a zone id'],
    ['::1%eth0', 'private', 'IPv6 loopback with a zone id'],
    ['ff02::1', 'block', 'IPv6 multicast'],
    ['fc00::1', 'private', 'IPv6 ULA'],
    ['fd00::1', 'private', 'IPv6 ULA'],
    ['::ffff:127.0.0.1', 'private', 'IPv4-mapped loopback'],
    ['::ffff:169.254.169.254', 'block', 'IPv4-mapped IMDS'],
    ['::', 'block', 'IPv6 unspecified'],
    ['not-an-ip', 'block', 'malformed'],
    ['1.2.3', 'block', 'a truncated address'],
    ['256.1.1.1', 'block', 'an out-of-range octet']
  ];
  for (const [address, expected, why] of cases) {
    const got = classifyIp(address);
    check(`${address} -> ${expected}`, got === expected, `${got} (${why})`);
  }
}

console.log('\n--- the guard refuses before any fetch ---');
{
  /** `[url, refused, why]` */
  const cases = [
    ['file:///etc/passwd', true, 'a file URL'],
    ['javascript:alert(1)', true, 'a javascript URL'],
    ['ftp://example.com/x', true, 'an ftp URL'],
    ['not a url', true, 'garbage'],
    ['http://169.254.169.254/latest/meta-data/', true, 'IMDS over http'],
    ['http://[::ffff:169.254.169.254]/', true, 'IMDS through an IPv4-mapped address'],
    ['http://0.0.0.0/', true, 'the current-network address'],
    ['http://224.0.0.1/', true, 'multicast'],
    // Loopback and RFC1918 are the user's own machine and are allowed by default;
    // `CTX_FETCH_STRICT=1` is what refuses them.
    ['http://127.0.0.1:8080/x', false, 'loopback, allowed by default'],
    ['http://localhost:3000/', false, 'the loopback name, allowed by default']
  ];
  for (const [url, shouldRefuse, why] of cases) {
    const refusal = await ssrfRefusalForTest(url);
    check(`${url} refused=${shouldRefuse}`, (refusal !== undefined) === shouldRefuse, `${refusal ?? 'allowed'} (${why})`);
  }
}
{
  process.env.CTX_FETCH_STRICT = '1';
  const loopback = await ssrfRefusalForTest('http://127.0.0.1:8080/x');
  check('CTX_FETCH_STRICT=1 refuses loopback', loopback !== undefined && /STRICT/.test(loopback), loopback ?? 'allowed');
  const rfc1918 = await ssrfRefusalForTest('http://10.0.0.5/');
  check('CTX_FETCH_STRICT=1 refuses RFC1918', rfc1918 !== undefined && /STRICT/.test(rfc1918), rfc1918 ?? 'allowed');
  delete process.env.CTX_FETCH_STRICT;
}

console.log('\n--- the registered fetch handler, with controlled HTTP and a real index ---');
{
  const { Context } = await import('@deepseek-ai/cordis');
  const fixture = mkdtempSync(join(tmpdir(), 'ctx-fetch-handler-'));
  const databasePath = join(fixture, 'kb.db');
  const envKeys = ['DSH_HOME', 'XDG_CONFIG_HOME', 'OPENCODE_CONFIG_DIR', 'CTX_FETCH_STRICT'];
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const saved = {
    fetch: globalThis.fetch,
    now: Date.now,
    timeout: AbortSignal.timeout,
    index: contextMode.KnowledgeBase.prototype.index,
    sourceMeta: contextMode.KnowledgeBase.prototype.sourceMeta,
    close: contextMode.KnowledgeBase.prototype.close
  };
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const observer = new contextMode.KnowledgeBase({ path: databasePath, producer: 'fetch-test', logger });
  const replies = new Map();
  const requests = [];
  const reads = [];
  const indexed = [];
  const timeouts = [];
  const now = Date.now();
  let active = 0;
  let peak = 0;
  let failIndex;
  let failMetadata;
  let onIndexed;
  let releaseSlow;
  let scope;
  let closedPluginDatabases = 0;
  let closedObserverDatabases = 0;
  contextMode.KnowledgeBase.prototype.close = function () {
    if (this === observer) closedObserverDatabases += 1;
    else closedPluginDatabases += 1;
    return saved.close.call(this);
  };
  try {
    const home = join(fixture, 'home');
    mkdirSync(home);
    Object.assign(process.env, { DSH_HOME: home, XDG_CONFIG_HOME: join(home, 'xdg'), OPENCODE_CONFIG_DIR: join(home, 'custom') });
    delete process.env.CTX_FETCH_STRICT;
    const registered = new Map();
    const root = new Context();
    root.provide('tools', {
      register: (tool) => { registered.set(tool.name, tool); return () => {}; },
      guard: () => () => {}
    });
    root.provide('commands', { register: () => () => {} });
    root.provide('logger', logger);
    root.provide('systemPrompt', { section: () => () => {} });
    root.provide('workspace', { root: fixture });
    scope = root.plugin(contextMode, {
      knowledgeBasePath: databasePath,
      batchConcurrency: 6,
      __fetchSeams: { fetch: (...args) => globalThis.fetch(...args) }
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
    const tool = registered.get('ctx_fetch_and_index');
    check('the real fetch tool is registered', typeof tool?.execute === 'function');

    // Only this test process is instrumented; the plugin still owns a real SQLite DB.
    Date.now = () => now;
    AbortSignal.timeout = (ms) => { timeouts.push(ms); return saved.timeout.call(AbortSignal, ms); };
    contextMode.KnowledgeBase.prototype.sourceMeta = function (source) {
      if (this !== observer) {
        reads.push(source);
        if (source === failMetadata) throw new Error('synthetic metadata failure');
      }
      return saved.sourceMeta.call(this, source);
    };
    contextMode.KnowledgeBase.prototype.index = function (document) {
      if (this !== observer && document.source === failIndex) throw new Error('synthetic index failure');
      const result = saved.index.call(this, document);
      if (this !== observer) {
        indexed.push({ ...document, lines: result.lines });
        onIndexed?.(document);
      }
      return result;
    };
    globalThis.fetch = async (url, options) => {
      requests.push({ url, options });
      active += 1;
      peak = Math.max(peak, active);
      const reply = replies.get(url) ?? {};
      if (reply.networkError) {
        active -= 1;
        throw new Error(reply.networkError);
      }
      return {
        status: reply.status ?? 200,
        headers: new Headers({ 'content-type': reply.type ?? 'text/plain' }),
        async text() {
          try {
            if (reply.wait) await reply.wait;
            if (reply.delay) await new Promise((resolve) => setTimeout(resolve, reply.delay));
            if (reply.bodyError) throw new Error(reply.bodyError);
            return reply.body ?? `BODY-${new URL(url).pathname}`;
          } finally {
            active -= 1;
          }
        }
      };
    };

    const a = 'http://127.0.0.1/first';
    const b = 'http://127.0.0.1/second';
    const html = '<h1>PAGE-A &amp; &lt; &gt; &quot; &#39;</h1><script>SECRET-SCRIPT</script><style>SECRET-STYLE</style><!--SECRET-COMMENT--><p>second&nbsp;line</p>';
    const plainA = '# PAGE-A & < > " \'\n\nsecond line';
    const plainB = 'PAGE-B\nkeep <literal> &amp;';
    replies.set(a, { body: html, type: 'text/html' });
    replies.set(b, { body: plainB, type: 'application/json' });
    const first = await tool.execute({ url: a, urls: ['', b], source: '  shared  ' });
    check('URL normalization preserves both valid inputs', first.fetched === 2 && first.failed === 0 && requests.length === 2);
    check('source labels are trimmed', first.source === 'shared');
    check('HTML cleanup keeps structure and removes script/style/comment bodies', indexed.find((row) => row.source === `shared::${a}`)?.text === `# ${a}\n${plainA}`);
    check('non-HTML bodies are kept unchanged', indexed.find((row) => row.source === `shared::${b}`)?.text === `# ${b}\n${plainB}`);
    check('two URLs under one label remain separate cache entries', observer.sourceMeta(`shared::${a}`)?.lines === 3 && observer.sourceMeta(`shared::${b}`)?.lines === 3);
    check('fetched documents retain their kind and timestamp', indexed.every((row) => row.kind === 'fetch' && row.createdAt === now));
    check('the response shape stays metadata-only', Object.keys(first).sort().join(',') === 'failed,fetched,indexedLines,rendered,source' && !/PAGE-A|PAGE-B|SECRET-/.test(JSON.stringify(first)));
    check('successful responses report body characters and indexed lines', first.indexedLines === 6 && first.rendered.includes(`${plainA.length} chars, 3 lines`) && first.rendered.includes(`${plainB.length} chars, 3 lines`));

    const beforeRefusal = { requests: requests.length, reads: reads.length, writes: indexed.length };
    process.env.CTX_FETCH_STRICT = '1';
    const refused = await tool.execute({ url: a, source: 'shared' });
    delete process.env.CTX_FETCH_STRICT;
    check('a URL refusal wins over an existing fresh cache entry', refused.fetched === 0 && refused.failed === 1 && refused.rendered.includes('CTX_FETCH_STRICT=1'));
    check('refusal happens before metadata lookup, HTTP, and indexing', requests.length === beforeRefusal.requests && reads.length === beforeRefusal.reads && indexed.length === beforeRefusal.writes);

    const day = 24 * 60 * 60 * 1000;
    for (const test of [
      { label: 'fresh', age: 0, args: {}, network: false },
      { label: 'custom TTL', age: 60_000, args: { ttl: 120_000 }, network: false },
      { label: 'exact expiry', age: 1000, args: { ttl: 1000 }, network: true },
      { label: 'default TTL fresh', age: day - 1, args: {}, network: false },
      { label: 'default TTL expired', age: day, args: {}, network: true },
      { label: 'force', age: 0, args: { force: true }, network: true, bypass: true },
      { label: 'zero TTL', age: 0, args: { ttl: 0 }, network: true, bypass: true },
      { label: 'invalid TTL fallback', age: day - 1, args: { ttl: -1 }, network: false }
    ]) {
      observer.index({ source: `shared::${a}`, text: `# ${a}\nCACHED-PAGE`, createdAt: now - test.age });
      const cachedMeta = observer.sourceMeta(`shared::${a}`);
      const before = { requests: requests.length, reads: reads.length, writes: indexed.length };
      const result = await tool.execute({ url: a, source: 'shared', ...test.args });
      check(`${test.label}: cache/network decision`, result.fetched === 1 && result.failed === 0 && requests.length - before.requests === Number(test.network) && result.rendered.includes('(cached ') === !test.network);
      check(`${test.label}: lookup and write counts`, reads.length - before.reads === Number(!test.bypass) && indexed.length - before.writes === Number(test.network));
      if (!test.network) {
        const age = Math.floor(test.age / 60000);
        check(`${test.label}: cached metadata and age`, result.indexedLines === cachedMeta.lines && result.rendered.includes(`${cachedMeta.chars} chars, ${cachedMeta.lines} lines`) && result.rendered.includes(age === 0 ? 'cached just now;' : `cached ${age}m ago;`));
      }
    }

    const defaultSource = await tool.execute({ url: b, source: '  ', force: true });
    check('an omitted label keeps the date-based default', defaultSource.source === `fetch-${new Date().toISOString().slice(0, 10)}`);
    const beforeCurrentShape = requests.length;
    const currentShape = await tool.execute({
      url: a,
      requests: [{ url: b, source: 'request-specific' }],
      force: true
    });
    check('the current requests shape takes precedence over a simultaneous url', requests.length === beforeCurrentShape + 1 && requests.at(-1).url === b && currentShape.source === 'request-specific');

    const ordered = await tool.execute({
      requests: [{ url: a, source: 'first-source' }, { url: a, source: 'second-source' }],
      concurrency: 2,
      force: true
    });
    const orderedLines = ordered.rendered.split('\n');
    check('duplicate URLs with distinct sources retain input order', orderedLines[1].includes('first-source') && orderedLines[2].includes('second-source'));
    let missingUrl;
    try { await tool.execute({ urls: [''] }); } catch (error) { missingUrl = error.message; }
    check('an empty URL selection still rejects the call', missingUrl === 'ctx_fetch_and_index: provide `url`, `requests`, or legacy `urls`');

    for (const test of [
      { label: 'network', reply: { networkError: 'synthetic network failure' }, error: 'synthetic network failure' },
      { label: 'body', reply: { bodyError: 'synthetic body failure' }, error: 'synthetic body failure' },
      { label: 'index', error: 'synthetic index failure' },
      { label: 'metadata', error: 'synthetic metadata failure' },
      { label: 'size', reply: { body: 'x'.repeat(50 * 1024 * 1024 + 1) }, error: 'over the 52428800-byte ceiling' }
    ]) {
      const source = `failure-${test.label}`;
      const bad = `http://127.0.0.1/${test.label}-bad`;
      const good = `http://127.0.0.1/${test.label}-good`;
      replies.set(bad, test.reply ?? {});
      failIndex = test.label === 'index' ? `${source}::${bad}` : undefined;
      failMetadata = test.label === 'metadata' ? `${source}::${bad}` : undefined;
      const before = indexed.length;
      const result = await tool.execute({ urls: [bad, good], source, concurrency: 2 });
      check(`${test.label} failure is isolated to its URL`, result.failed === 1 && result.fetched === 1 && result.rendered.includes(test.error));
      check(`${test.label} failure adds no index entry`, observer.sourceMeta(`${source}::${bad}`) === undefined && observer.sourceMeta(`${source}::${good}`) !== undefined && indexed.length === before + 1);
      failIndex = undefined;
      failMetadata = undefined;
      replies.delete(bad);
    }

    for (const test of [
      { label: 'serial', args: { concurrency: 1 }, limit: 1 },
      { label: 'explicit', args: { concurrency: 3 }, limit: 3 },
      { label: 'default', args: {}, limit: 4 },
      { label: 'capped', args: { concurrency: 99 }, limit: 8 }
    ]) {
      const urls = Array.from({ length: test.limit + 1 }, (_, i) => `http://127.0.0.1/${test.label}-${i}`);
      urls.forEach((url, i) => replies.set(url, { delay: i === 0 ? 35 : 10 }));
      peak = 0;
      const result = await tool.execute({ urls, source: test.label, ...test.args });
      check(`${test.label} concurrency uses the existing limit`, peak === test.limit && active === 0 && result.fetched === urls.length);
      check(`${test.label} responses retain input order`, urls.every((url, i) => result.rendered.split('\n')[i + 1].includes(` ${url} `)));
    }

    const fast = 'http://127.0.0.1/fast';
    const slow = 'http://127.0.0.1/slow';
    replies.set(slow, { wait: new Promise((resolve) => { releaseSlow = resolve; }) });
    const fastIndexed = new Promise((resolve) => {
      onIndexed = (document) => { if (document.source === `stream::${fast}`) resolve(true); };
    });
    const pending = tool.execute({ urls: [slow, fast], source: 'stream', concurrency: 2 });
    let timer;
    const wroteBeforeSlow = await Promise.race([fastIndexed, new Promise((resolve) => { timer = setTimeout(() => resolve(false), 1000); })]);
    clearTimeout(timer);
    check('each worker indexes before unrelated response bodies finish', wroteBeforeSlow);
    releaseSlow();
    await pending;
    onIndexed = undefined;

    const duplicate = 'http://127.0.0.1/duplicate';
    replies.set(duplicate, { body: 'DUPLICATE-PAGE', delay: 10 });
    const beforeDuplicates = requests.length;
    const duplicates = await tool.execute({ urls: [duplicate, duplicate], source: 'duplicates', concurrency: 2, force: true });
    check('duplicate requests are not silently coalesced', requests.length === beforeDuplicates + 2 && duplicates.fetched === 2 && duplicates.indexedLines === 4);
    check('duplicate writes still replace the exact cache source', observer.sourceMeta(`duplicates::${duplicate}`)?.lines === 2);

    const stats = await registered.get('ctx_stats').execute({});
    const totals = stats.rendered.match(/this session: (\d+) execution\(s\), (\d+) line\(s\) indexed, (\d+) search\(es\), (\d+) fetch\(es\)/);
    check('session counters count successful writes, not cache hits or failures', totals?.[1] === '0' && Number(totals?.[2]) === indexed.reduce((sum, row) => sum + row.lines, 0) && totals?.[3] === '0' && Number(totals?.[4]) === indexed.length);
    check('HTTP requests retain their user agent and timeout signal', requests.every(({ options }) => options.headers['user-agent'] === 'dsh-context-mode/0.1 (+https://github.com/mksglu/context-mode)' && options.signal instanceof AbortSignal) && timeouts.length === requests.length && timeouts.every((ms) => ms === 30_000));
  } finally {
    releaseSlow?.();
    globalThis.fetch = saved.fetch;
    Date.now = saved.now;
    AbortSignal.timeout = saved.timeout;
    contextMode.KnowledgeBase.prototype.index = saved.index;
    contextMode.KnowledgeBase.prototype.sourceMeta = saved.sourceMeta;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { await scope?.dispose(); } finally {
      observer.close();
      contextMode.KnowledgeBase.prototype.close = saved.close;
      check('plugin disposal closes its fetch database handle', closedPluginDatabases >= 1, String(closedPluginDatabases));
      check('test cleanup closes the observer database handle', closedObserverDatabases === 1, String(closedObserverDatabases));
      rmSync(fixture, { recursive: true, force: true, maxRetries: 5 });
    }
  }
}

console.log('\n--- the output budget is one number, and it is honest ---');
{
  const { Context } = await import('@deepseek-ai/cordis');
  const dbDir = mkdtempSync(join(tmpdir(), 'ctx-fetch-'));
  const registered = new Map();
  const root = new Context();
  root.provide('tools', {
    register: (definition) => { registered.set(definition.name, definition); return () => {}; },
    guard: () => () => {}
  });
  root.provide('commands', { register: () => () => {} });
  root.provide('logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
  root.provide('systemPrompt', { section: () => () => {} });
  root.provide('workspace', { root: kitRoot });
  const contextMode = await import(pathToFileURL(join(kitRoot, 'lib', 'context-mode.js')).href);
  const scope = root.plugin(contextMode, { knowledgeBasePath: join(dbDir, 'kb.db') });
  await new Promise((resolve) => setTimeout(resolve, 700));

  const exec = {
    callId: 'call-fetch',
    rootCallId: 'call-fetch',
    name: 'ctx_execute',
    token: Symbol('t'),
    arguments: {},
    signal: new AbortController().signal,
    agent: { id: 'session-fetch', session: { header: { cwd: kitRoot }, id: 'session-fetch' } },
    deferContext: () => {},
    concludeTurn: () => {}
  };
  const execute = registered.get('ctx_execute');

  // 30 KB is BELOW upstream's 102 400-byte threshold, so all of it must arrive.
  const lines = 600;
  const big = await execute.execute({
    language: 'javascript',
    code: `for (let i = 0; i < ${lines}; i += 1) console.log('LINE-' + String(i).padStart(4, '0') + ' ' + 'x'.repeat(40));`,
    source: 'fetch-budget-big'
  }, exec);
  const body = big.rendered ?? '';
  check('30 KB of output is NOT truncated', !/output middle truncated/.test(body), `${body.length} chars rendered`);
  check('the middle of a 30 KB run is present', body.includes('LINE-0300'));
  check('the whole run is indexed', big.indexedLines === lines, `${big.indexedLines} of ${big.indexedTotalLines}`);

  // Above the threshold the bound applies, and the notice must name the threshold
  // it actually used rather than a setting that had no effect.
  const huge = await execute.execute({
    language: 'javascript',
    code: `for (let i = 0; i < 4000; i += 1) console.log('LINE-' + String(i).padStart(4, '0') + ' ' + 'y'.repeat(40));`,
    source: 'fetch-budget-huge'
  }, exec);
  const hugeBody = huge.rendered ?? '';
  check('above the threshold returns only a short capture pointer', hugeBody.length < 1000 && /output stayed out of context/.test(hugeBody), `${hugeBody.length} chars`);
  check('large-output head stays out of conversation', !hugeBody.includes('LINE-0000'));
  check('large-output tail stays out of conversation', !hugeBody.includes('LINE-3999'));
  check('the notice names the real threshold', /102400/.test(hugeBody), (hugeBody.match(/\[output exceeded[^\]]*\]/) ?? ['(no notice)'])[0].slice(0, 140));
  check('the full capture is still indexed in full', huge.indexedLines === 4000, `${huge.indexedLines} of ${huge.indexedTotalLines}`);

  const doctor = registered.get('ctx_doctor');
  const report = await doctor.execute({}, exec);
  check('ctx_doctor still reports ok', report.ok === true, report.rendered?.split('\n')[0] ?? '');
  // Windows keeps the SQLite file handle until the plugin scope is disposed.
  await scope.dispose();
  rmSync(dbDir, { recursive: true, force: true, maxRetries: 5 });
}

if (failures.length > 0) {
  console.log(`\n${failures.length} fetch/budget check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nfetch guards, caching, and output budgets pass');
}
