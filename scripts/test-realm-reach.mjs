/**
 * Does a preset realm hide the Web-plane services from `ctx.inject`?
 *
 * This decides the editor panel's architecture, so it is worth a test instead of
 * an inference. The panel needs `connection` and `webServer`; the `dcp` row that
 * would mount it lives inside the agent preset's `compaction` group, which
 * isolates `compaction` and `toolResultPruner`.
 *
 * Cordis isolation is per NAME (`Context.isolate(name, label)`,
 * `cordis/lib/index.js:1722`), and a name nobody isolated resolves to the root
 * symbol, so `webServer` *should* stay reachable from inside the group. Three
 * shapes are measured here rather than argued about:
 *
 *   1. a plain child context (a preset row with no groups) — read and inject;
 *   2. a row inside a group whose `isolate` names OTHER services;
 *   3. a row inside a group that isolates `webServer` itself.
 *
 * `[node:assert]` — every check throws on failure.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

let checks = 0;
const ok = async (label, fn) => {
  await fn();
  checks += 1;
  console.log(`  [ok] ${label}`);
};

const candidates = [
  join(HERE, '..', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'),
  process.env.DSH_INSTALL && join(process.env.DSH_INSTALL, '@deepseek-ai', 'cordis', 'lib', 'index.js')
].filter(Boolean);
const found = candidates.find((candidate) => existsSync(candidate));
if (found === undefined) {
  console.log('  [skip] cordis is not installed next to the kit');
  console.log('\nrealm reach: 0 checks passed');
  process.exit(0);
}
const { Context, Service } = await import(pathToFileURL(found).href);

class FakeWebServer extends Service {
  constructor(ctx) {
    super(ctx, 'webServer');
    this.seen = 0;
  }
  tapIndex() {
    this.seen += 1;
    return () => {};
  }
}
class FakeConnection extends Service {
  constructor(ctx) {
    super(ctx, 'connection');
    this.channels = 0;
  }
  get rpc() {
    return {
      handle: () => {
        this.channels += 1;
        return () => {};
      }
    };
  }
}

const tick = () => new Promise((resolve) => { setTimeout(resolve, 0); });

/** What the panel does, reduced to the two facts it needs. */
const probeRow = (record) => ({
  name: 'realm probe',
  apply(ctx) {
    const read = (name) => {
      try { return ctx.get(name); } catch (error) { record.push(`${name} read threw: ${error.message}`); return undefined; }
    };
    record.push(`read connection=${read('connection') === undefined ? 'no' : 'yes'} webServer=${read('webServer') === undefined ? 'no' : 'yes'}`);
    try {
      ctx.inject(['connection', 'webServer'], (injected) => {
        const connection = injected.get('connection');
        const webServer = injected.get('webServer');
        record.push(`inject ran connection=${connection === undefined ? 'no' : 'yes'} webServer=${webServer === undefined ? 'no' : 'yes'}`);
        if (connection !== undefined && webServer !== undefined) {
          connection.rpc.handle('/ctxkit.edit', () => ({}));
          webServer.tapIndex((html) => html);
        }
      });
      record.push('inject registered');
    } catch (error) {
      record.push(`inject threw: ${error.message}`);
    }
  }
});

console.log('can a preset realm reach the Web-plane services?');

await ok('a plain child row reads and injects them', async () => {
  const root = new Context();
  const webServer = new FakeWebServer(root);
  const connection = new FakeConnection(root);
  const record = [];
  const row = root.plugin(probeRow(record));
  await row.await;
  await tick();
  console.log(`      ${record.join(' | ')}`);
  assert.equal(webServer.seen, 1, 'the tap was not registered');
  assert.equal(connection.channels, 1, 'the channel was not registered');
  await root.fiber.dispose?.();
});

await ok('a row inside a group isolating OTHER names still reaches them', async () => {
  const root = new Context();
  const webServer = new FakeWebServer(root);
  const connection = new FakeConnection(root);
  const record = [];
  const group = root.isolate('compaction', 'context-kit-realm').isolate('toolResultPruner', 'context-kit-realm');
  const row = group.plugin(probeRow(record));
  await row.await;
  await tick();
  console.log(`      ${record.join(' | ')}`);
  assert.equal(webServer.seen, 1, 'the tap was not registered from inside the group');
  assert.equal(connection.channels, 1, 'the channel was not registered from inside the group');
  await root.fiber.dispose?.();
});

await ok('a group that isolates webServer itself does NOT reach it', async () => {
  const root = new Context();
  const webServer = new FakeWebServer(root);
  const connection = new FakeConnection(root);
  const record = [];
  const group = root.isolate('webServer', 'context-kit-web');
  const row = group.plugin(probeRow(record));
  await row.await;
  await tick();
  console.log(`      ${record.join(' | ')}`);
  assert.equal(webServer.seen, 0, 'an isolated webServer should not be reachable from the isolated scope');
  await root.fiber.dispose?.();
});

console.log(`\nrealm reach: ${checks} checks passed`);
