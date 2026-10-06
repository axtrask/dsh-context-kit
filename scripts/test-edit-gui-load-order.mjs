/**
 * The button mounts against a REAL cordis root, in both load orders.
 *
 * ## Why this test drives cordis itself
 *
 * The first release of the button shipped a plugin that read its two host
 * services once, at mount time:
 *
 *     const connection = ctx.get('connection');
 *     const webServer = ctx.get('webServer');
 *     if (connection?.rpc?.handle === undefined || webServer?.tapIndex === undefined) return undefined;
 *
 * Against a unit-test double that answer is stable, so `scripts/test-edit-gui.mjs`
 * passed while the live Web GUI had no button at all. Against the real runtime it
 * is a RACE: a preset ROW is mounted while the deployment is still coming up, and
 * `ctx.get(name)` answers `undefined` — without throwing and without retrying —
 * for a service that is not yet PROVIDED. The guard then took the "headless
 * composition" branch on a Web server, returned `undefined`, and nothing anywhere
 * recorded that the button had been skipped.
 *
 * A double cannot catch that, because a double does not implement service
 * lifetime. This test mounts the real `WebServer`-shaped service through the real
 * cordis, under the real `ctx.plugin` / `ctx.effect` machinery the harness uses,
 * and asserts the mount happens in BOTH orders:
 *
 *   1. the services already exist when the plugin starts;
 *   2. the services arrive AFTER the plugin started (the live case);
 *   3. neither service ever arrives (headless) — the plugin must still boot.
 *
 * Cordis is resolved from the installed harness, which is also where the live
 * server's cordis instance comes from, so `Context.is` branding and the service
 * resolver are the same implementation the button runs under.
 *
 * `[node:assert]` — every check throws on failure.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { EDIT_CHANNEL, installEditGui } from '../lib/edit-gui.js';

const HERE = dirname(fileURLToPath(import.meta.url));

let checks = 0;
const ok = (label, fn) => {
  fn();
  checks += 1;
  console.log(`  [ok] ${label}`);
};

/** Resolve cordis the way the running harness does, or skip loudly. */
async function loadCordis() {
  const candidates = [
    join(HERE, '..', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'),
    process.env.DSH_INSTALL && join(process.env.DSH_INSTALL, '@deepseek-ai', 'cordis', 'lib', 'index.js')
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const module = await import(pathToFileURL(candidate).href);
      return { module, from: candidate };
    }
  }
  return undefined;
}

const loaded = await loadCordis();
if (loaded === undefined) {
  console.log('  [skip] cordis is not installed next to the kit; cannot drive a real root');
  console.log('\nedit gui load order: 0 checks passed');
  process.exit(0);
}
const { Context, Service } = loaded.module;
console.log(`the GUI mounts on a real cordis root (${loaded.from})`);

const PAGE = '<!doctype html><html><body><div id="root"></div></body></html>';

/** The shipped WebServer surface, reduced to the two methods the button uses. */
class FakeWebServer extends Service {
  taps = [];
  routes = [];
  constructor(ctx) {
    super(ctx, 'webServer');
    this.tapIndex = (transform) => {
      this.taps.push(transform);
      return () => {
        const at = this.taps.indexOf(transform);
        if (at !== -1) this.taps.splice(at, 1);
      };
    };
    this.register = (route) => {
      this.routes.push(route);
      return () => {
        const at = this.routes.indexOf(route);
        if (at !== -1) this.routes.splice(at, 1);
      };
    };
  }
}

/** The shipped Connection surface, reduced to the one method the button uses. */
class FakeConnection extends Service {
  channels = [];
  constructor(ctx) {
    super(ctx, 'connection');
    // The direct editor route delegates the request-role check to Connection.
    this.requestRejection = () => undefined;
    this.rpc = {
      handle: (channel, handler) => {
        const entry = { channel, handler };
        this.channels.push(entry);
        return () => {
          const at = this.channels.indexOf(entry);
          if (at !== -1) this.channels.splice(at, 1);
        };
      }
    };
  }
}

/** An engine stub: the button only reads `dcpConfig.editor` from it. */
const engine = { dcpConfig: { editor: { enabled: true, requireIdle: true } } };

/** Mount the button exactly as `lib/dcp.js` does, as a cordis plugin row. */
const buttonRow = {
  name: 'context-kit: button under test',
  apply(ctx) {
    ctx.effect(() => installEditGui(ctx, engine), 'context-kit: history editor GUI');
  }
};

const tick = () => new Promise((resolve) => { setTimeout(resolve, 0); });

ok('services that already exist: the button mounts at once', async () => {
  const root = new Context();
  const webServer = new FakeWebServer(root);
  const connection = new FakeConnection(root);
  const row = root.plugin(buttonRow);
  await row.await;

  assert.equal(webServer.taps.length, 1, 'the index tap was not registered on an existing Web surface');
  assert.deepEqual(webServer.routes.map((route) => route.path), [EDIT_CHANNEL],
    'the browser channel route was not registered on an existing Web surface');
  assert.ok(webServer.taps[0](PAGE).includes('id="dsh-context-kit-editor"'),
    'the registered tap does not inject the button host');
  await root.fiber.dispose?.();
});

ok('the live case: services arriving LATER still get the button', async () => {
  const root = new Context();
  // Nothing is provided yet. This is the state a preset row is mounted in.
  assert.equal(root.get('webServer'), undefined);
  assert.equal(root.get('connection'), undefined);

  const row = root.plugin(buttonRow);
  await row.await;

  // The host services come up, as they do during deployment startup.
  const webServer = new FakeWebServer(root);
  const connection = new FakeConnection(root);
  await tick();

  assert.equal(webServer.taps.length, 1,
    'a Web surface that appeared after the plugin started got no button: the mount is reading the service once');
  assert.deepEqual(webServer.routes.map((route) => route.path), [EDIT_CHANNEL],
    'the browser channel route was not registered for a late Web surface');
  assert.ok(webServer.taps[0](PAGE).includes('id="dsh-context-kit-editor"'),
    'the late tap does not inject the button host');
  await root.fiber.dispose?.();
});

ok('the OLD guard really is broken here (this test can fail)', async () => {
  // An executable falsification, kept in the suite rather than performed once by
  // hand: without it, "the test passes" could simply mean the test is blind to the
  // race. This row is the shipped-buggy shape — read both services once, give up
  // silently when either is missing.
  const wrongRow = {
    name: 'context-kit: the old one-shot guard',
    apply(ctx) {
      const connection = ctx.get('connection');
      const webServer = ctx.get('webServer');
      if (connection?.rpc?.handle === undefined || webServer?.tapIndex === undefined) return undefined;
      connection.rpc.handle(EDIT_CHANNEL, () => ({ ok: false }));
      webServer.tapIndex((html) => html);
    }
  };
  const root = new Context();
  const row = root.plugin(wrongRow);
  await row.await;
  const webServer = new FakeWebServer(root);
  const connection = new FakeConnection(root);
  await tick();
  assert.equal(webServer.taps.length, 0,
    'the one-shot guard mounted anyway, so this test does not exercise the race it claims to');
  assert.equal(webServer.routes.length, 0,
    'the one-shot guard registered a route anyway, so this test is blind to the bug');
  await root.fiber.dispose?.();

  // Same row, services already present: it DOES mount, which is why a test that
  // provides the services up front stayed green while the live GUI had no button.
  const warm = new Context();
  const warmWeb = new FakeWebServer(warm);
  const warmConnection = new FakeConnection(warm);
  await warm.plugin(wrongRow).await;
  assert.equal(warmWeb.taps.length, 1, 'the one-shot guard should work when the services are already up');
  assert.notEqual(warmConnection, undefined);
  await warm.fiber.dispose?.();
});

ok('headless: no Web surface ever arrives, and the plugin still boots', async () => {
  const root = new Context();
  const row = root.plugin(buttonRow);
  await row.await;
  assert.equal(root.get('webServer'), undefined);
  assert.equal(root.get('connection'), undefined);
  await root.fiber.dispose?.();
});

ok('the generator body of lib/dcp.js would really mount it (the shipped bug)', async () => {
  // THE BUG THIS EXISTS FOR, kept as an executable falsification of the exact line
  // that shipped. `lib/dcp.js` mounted the button with
  //
  //     yield () => installEditGui(ctx, engine);
  //
  // and `Fiber._execute` (`cordis/lib/index.js:1134-1152`) walks a generator body
  // with `safeCollect(result.value)`, which only REGISTERS a yielded function as a
  // disposer — it never calls it. A lambda that is never called cannot fail, so the
  // mount never ran, nothing was registered and nothing was logged: two releases,
  // two restarts, and still no button. `yield installEditGui(ctx, engine)` is the
  // fix, and it is why the result may never be `undefined` — `safeCollect` throws
  // `TypeError: Invalid effect` for a non-null, non-function yield.
  const mounted = async (body) => {
    const root = new Context();
    const webServer = new FakeWebServer(root);
    const connection = new FakeConnection(root);
    const row = root.plugin({ name: 'generator shape', apply: body });
    await row.await;
    return { root, webServer, connection };
  };

  // The correct shape: evaluated inside the generator body, so the disposer the
  // mount returns is what the effect collects.
  const good = await mounted(function* goodBody(ctx) {
    yield installEditGui(ctx, engine);
  });
  assert.equal(good.webServer.taps.length, 1, 'evaluating the mount in the generator must register the tap');
  assert.equal(good.webServer.routes.length, 1, 'evaluating the mount in the generator must register the channel route');
  await good.root.fiber.dispose?.();

  // The shipped shape: the lambda is registered as a disposer and never called.
  const bad = await mounted(function* badBody(ctx) {
    yield () => installEditGui(ctx, engine);
  });
  assert.equal(bad.webServer.taps.length, 0,
    'a yielded lambda registered the tap, so this test no longer reproduces the shipped bug');
  assert.equal(bad.webServer.routes.length, 0,
    'a yielded lambda registered the channel, so this test no longer reproduces the shipped bug');
  await bad.root.fiber.dispose?.();

  // And the deferred answer satisfies cordis: a no-op disposer is collectable,
  // where `undefined` would fail the effect with `Invalid effect`.
  const deferred = installEditGui({ get: () => undefined, inject: () => {} }, engine);
  assert.equal(typeof deferred, 'function', 'a deferred mount must answer with a disposer, not undefined');
  deferred();
});

console.log(`\nedit gui load order: ${checks} checks passed`);
