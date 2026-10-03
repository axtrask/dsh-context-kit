/**
 * The GUI half of the editor: what the button is allowed to assume.
 *
 * The panel is injected into the boot page and talks to the server over the
 * generic authenticated channel. Neither half can be exercised without a browser,
 * but both halves have contracts that a unit test can hold:
 *
 *  - the index transform is pure, idempotent, and leaves non-html alone, because
 *    `webServer.tapIndex` applies it to every index response;
 *  - the injected script mentions the channel it actually calls, so a renamed
 *    channel cannot silently orphan the button;
 *  - the script reads the session from the shell's own storage key, and that key
 *    is the one verified live in the running GUI;
 *  - the plugin refuses to mount without a Web surface instead of throwing, so a
 *    headless composition still boots;
 *  - the three methods the browser may call are the three the handler answers.
 *
 * `[node:assert]` — every check throws on failure.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

import { Context } from '@deepseek-ai/cordis';
import { ClientModuleRegistry, bootInjections } from '@deepseek-ai/dsh-client-modules';
import * as llm from '@deepseek-ai/dsh-llm';
import { Session, SessionId, SessionStore } from '@deepseek-ai/dsh-session';

import { EDIT_CHANNEL, EDIT_METHODS, SESSION_KEY, injectEditor, installEditGui, panelEntry } from '../lib/edit-gui.js';
import { createPanelScript } from '../lib/edit-panel.js';
import { blockTargets, commitUserEdit, editableIndex, editability, renderEditableList } from '../lib/edit-durable.js';
import { createEditStore, editStatePath, planWireRewrite, signedReasoningRefusal } from '../lib/edit.js';
import { publishEditStore, resetBridgeForTest } from '../lib/edit-bridge.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// A THROWAWAY HOME, WIPED FIRST, and set before the first check runs: `ok()` starts its
// body immediately, and a commit on the wire branch persists its record under
// `$DSH_HOME/context-kit/edits/`. The home of the machine running this test is not the
// test's to write into.
const scratchHome = join(ROOT, '.suite-state', 'edit-gui-test');
assert.ok(statSync(dirname(scratchHome)).isDirectory());
assert.ok(statSync(tmpdir()).isDirectory());
rmSync(scratchHome, { recursive: true, force: true });
mkdirSync(scratchHome);
process.env.DSH_HOME = scratchHome;
process.env.XDG_CONFIG_HOME = join(scratchHome, 'xdg');
process.env.OPENCODE_CONFIG_DIR = join(scratchHome, 'opencode');

let checks = 0;
let firstFailure;
const pending = [];
const ok = (label, fn) => {
  // The count used to be incremented inside an un-awaited async body, so the
  // summary line printed "0 checks passed" while the checks were still running:
  // the one number a reader trusts was the one number that was never true.
  const run = (async () => {
    await fn();
    checks += 1;
    console.log(`  [ok] ${label}`);
  })();
  pending.push(run.catch((error) => {
    console.error(`[FAIL] ${label}: ${error.message}`);
    firstFailure ??= error;
  }));
  return run;
};

const PAGE = '<!doctype html><html><head><title>DeepSeek Harness</title></head><body><div id="root"></div></body></html>';
const SCRIPT = injectEditor(PAGE).match(/<script type="module">([\s\S]*?)<\/script>/u)?.[1];

console.log('the index transform (applied to every index response)');

ok('the host is inserted before </body>', () => {
  const out = injectEditor(PAGE);
  assert.ok(out.includes('id="dsh-context-kit-editor"'), 'the host element is missing');
  assert.ok(out.indexOf('dsh-context-kit-editor') < out.indexOf('</body>'), 'the host landed after the body close');
  assert.ok(out.startsWith('<!doctype html>'), 'the document head was disturbed');
  assert.ok(out.includes('<div id="root"></div>'), 'the app root was disturbed');
});

ok('a second application is a no-op (idempotence)', () => {
  const once = injectEditor(PAGE);
  const twice = injectEditor(once);
  assert.equal(twice, once, 'the transform is not idempotent, so a double tap would mount two panels');
});

ok('non-html and bodyless input are returned unchanged', () => {
  assert.equal(injectEditor(''), '');
  assert.equal(injectEditor(undefined), undefined);
  assert.equal(injectEditor('<div>no body here</div>'), '<div>no body here</div>');
  for (const value of [null, 42, {}, Buffer.from(PAGE)]) assert.equal(injectEditor(value), value);
});

ok('injection keeps the exact wrapper and replaces only the first closing body', () => {
  assert.equal(typeof SCRIPT, 'string');
  const host = '<div id="dsh-context-kit-editor" data-context-kit="editor"></div>\n'
    + '<script type="module">' + SCRIPT + '</script>\n';
  const before = '<!doctype html><html><body>\r\noriginal\r\n';
  const after = '</body></html>\r\n<!-- trailing content -->';
  assert.equal(injectEditor(before + '</BoDy>' + after), before + host + '</body>' + after);
  const marked = '<html><body><!-- dsh-context-kit-editor --></body></html>';
  assert.equal(injectEditor(marked), marked, 'the existing marker must still short-circuit injection');
});

ok('the injected script is a module and closes cleanly', () => {
  const out = injectEditor(PAGE);
  assert.ok(out.includes('<script type="module">'), 'the panel is not a module script');
  assert.ok(out.includes('</script>'), 'the script tag is unterminated');
  // A template literal left un-interpolated would ship a literal ${...} to the browser.
  assert.ok(!out.includes('${EDIT_CHANNEL}'), 'the channel placeholder was not interpolated');
  assert.ok(!out.includes('${'), 'an uninterpolated placeholder reached the served page');
});

ok('the script body is real code, not a collapsed expression', () => {
  // THE BUG THIS EXISTS FOR. The panel is one template literal, so a single stray
  // backtick anywhere inside it — including inside a comment — closes the literal
  // early. What follows is then parsed as an expression, and a `${`-free string
  // compared against a number collapses the whole constant to `NaN`. The page then
  // serves `<script type="module">NaN</script>` and the button silently does
  // nothing at all: no exception, no log, no button. Assert the shape, not just
  // the absence of a marker.
  const out = injectEditor(PAGE);
  const script = out.slice(out.indexOf('<script type="module">') + 22, out.indexOf('</script>'));
  assert.ok(script.length > 5000, `the panel script collapsed to ${script.length} characters`);
  assert.ok(!/^NaN$/u.test(script), 'the panel script is the number NaN — a stray backtick closed the literal');
  assert.ok(script.includes('document.getElementById'), 'the script does not start like code');
  assert.ok(script.trimEnd().endsWith('}'), 'the script does not end like code');
  assert.ok(!/`/u.test(script), 'the script body contains a backtick, which is what collapses the literal');
  // AND IT MUST PARSE. The shape checks above all passed on a script that the
  // browser refused with `Uncaught SyntaxError: Invalid or unexpected token` and
  // that created no shadow root: a backtick in a COMMENT closes the literal early,
  // and what is left can still look like code while being unparseable. Only a real
  // parse settles it, so the served text is written out and checked as a module.
  const probe = join(tmpdir(), `ctxkit-panel-${process.pid}.mjs`);
  writeFileSync(probe, script, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', probe], { stdio: 'pipe' });
  } catch (error) {
    const detail = String(error.stderr ?? error).split('\n').filter((line) => line.trim()).slice(0, 4).join(' ');
    assert.fail(`the served panel script is not valid JavaScript, so the browser cannot run it: ${detail}`);
  } finally {
    rmSync(probe, { force: true });
  }
});

console.log('the browser half (what it must call and read)');

ok('the panel factory imports independently without touching browser globals', () => {
  // A fresh process cannot hide a dependency behind the server module's import cache.
  execFileSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    const panelUrl = ${JSON.stringify(new URL('../lib/edit-panel.js', import.meta.url).href)};
    registerHooks({ resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      assert.equal(resolved.url, panelUrl, 'the panel factory must not import dependencies');
      return resolved;
    } });
    for (const name of ['document', 'window', 'localStorage', 'MutationObserver', 'fetch']) {
      Object.defineProperty(globalThis, name, {
        get() { throw new Error(name + ' accessed by the panel factory'); }
      });
    }
    const panel = await import(panelUrl);
    assert.deepEqual(Object.keys(panel), ['createPanelScript']);
    assert.equal(panel.createPanelScript.length, 1);
    assert.equal(typeof panel.createPanelScript('/ctxkit.independent'), 'string');
  `], { stdio: 'pipe' });
});

ok('the factory emits exactly the served string and substitutes only the channel', async () => {
  assert.equal(createPanelScript(EDIT_CHANNEL), SCRIPT);
  for (const channel of ['/ctxkit.panel-test', '/ctxkit.another']) {
    const expected = SCRIPT.replace(`fetch('${EDIT_CHANNEL}/'`, `fetch('${channel}/'`);
    assert.notEqual(expected, SCRIPT, 'the comparison must change the channel');
    assert.equal(createPanelScript(channel), expected, 'a channel change must alter no other emitted byte');
  }
  assert.equal(createPanelScript(EDIT_CHANNEL), SCRIPT, 'calls for another channel must not retain state');
  const gui = await import('../lib/edit-gui.js');
  assert.deepEqual(Object.keys(gui).sort(), [
    'EDIT_CHANNEL', 'EDIT_DOCTRINE', 'EDIT_METHODS', 'SESSION_KEY', 'injectEditor', 'installEditGui', 'panelEntry'
  ]);
});

ok('the served script leaves an absent or already mounted host alone', () => {
  for (const host of [null, { shadowRoot: {} }]) {
    runInNewContext(SCRIPT, {
      document: { getElementById: (id) => {
        assert.equal(id, 'dsh-context-kit-editor');
        return host;
      } }
    }, { timeout: 1000 });
  }
});

ok('both served stylesheets keep their rules and browser escape layers', () => {
  const start = SCRIPT.indexOf('\n  const css = ');
  const end = SCRIPT.indexOf('\n  const wrap = ', start);
  assert.ok(start > 0 && end > start, 'the panel stylesheet declaration is missing');
  const css = runInNewContext(SCRIPT.slice(start, end) + '\ncss.textContent;', {
    document: { createElement: () => ({}) }
  });
  const { pinCss } = panelConsts(SCRIPT, ['pinCss']);
  for (const [name, text] of [['panel', css], ['pencil', pinCss]]) {
    assert.ok(text.includes('\n'), `${name} CSS lost its line separators`);
    assert.ok(!text.includes('\\n'), `${name} CSS contains literal backslash-n instead of newlines`);
  }
  assert.ok(css.startsWith(':host { all: initial;'), 'panel CSS must begin by resetting the shadow host');
  assert.ok(css.includes('.wrap.open { display: block; }'));
  assert.ok(css.includes('width: min(760px, 92vw)'));
  assert.ok(css.includes('button:disabled { opacity: .5; cursor: default; }'));
  assert.ok(css.endsWith('footer.good { color: #8ee0a8; }'));
  assert.ok(pinCss.startsWith(':host { position: relative; display: flex;'));
  assert.ok(pinCss.includes('min-height: 44px; min-width: 44px;'));
  assert.ok(!/position:\s*(sticky|fixed|absolute)/.test(pinCss), 'editor actions must stay in flow below their block');
});

ok('the script calls the channel the server registers', () => {
  const out = injectEditor(PAGE);
  // The method rides in the PATH, because the channel speaks the connection's own
  // protocol: `<channel>/<method>`, and a request whose envelope names a different
  // method than its path is refused as a bad request.
  assert.ok(out.includes(`fetch('${EDIT_CHANNEL}/' + method`), `the panel does not call ${EDIT_CHANNEL}/<method>`);
  assert.equal(EDIT_CHANNEL, '/ctxkit.edit');
  // The host accepts ONE segment after the leading slash
  // (`CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/`); a second slash throws while the
  // loader entry is applied, so the whole preset fails to mount. The assertion
  // above pins the name; this one pins the property that made the name legal, so
  // a future rename cannot reintroduce the mount-killing shape.
  assert.match(EDIT_CHANNEL, /^\/[A-Za-z0-9._~-]+$/,
    'the channel must match the host pattern or the dcp row fails to mount');
});

ok('the script sends the generic client-request envelope', () => {
  const out = injectEditor(PAGE);
  assert.ok(out.includes("type: 'client-request'"), 'the envelope type is missing');
  assert.ok(out.includes('rpcId: rpcId()'), 'the correlation id is missing');
  assert.ok(out.includes("credentials: 'same-origin'"), 'the browser credential would not be sent');
});

ok('the served request helper preserves payloads, refusals, and transport errors', async () => {
  const { call, rpcId } = panelConsts(SCRIPT, ['rpcId', 'call']);
  const value = { ok: false, reason: 'editor disabled' };
  let response = { ok: true, json: async () => ({ result: { ok: true, value } }) };
  const sent = [];
  const request = runInNewContext('(' + call.toString() + ')', {
    rpcId,
    fetch: async (url, options) => { sent.push({ url, options }); return response; }
  });
  for (const method of Object.values(EDIT_METHODS)) {
    const payload = { sessionId: 'session-1', seq: 8, text: 'line one\n"line two"' };
    assert.equal(await request(method, payload), value, 'a server refusal must remain a value, not a transport error');
    const { url, options } = sent.at(-1);
    assert.equal(url, EDIT_CHANNEL + '/' + method);
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'same-origin');
    assert.deepEqual(Object.entries(options.headers), [['content-type', 'application/json']]);
    const envelope = JSON.parse(options.body);
    assert.match(envelope.rpcId, /^ctxkit-[0-9]+-[0-9]+$/u);
    assert.deepEqual(envelope, { type: 'client-request', rpcId: envelope.rpcId, method, payload });
  }
  for (const [reply, message] of [
    [{ ok: false, status: 403, text: async () => 'x'.repeat(205) }, 'HTTP 403: ' + 'x'.repeat(200)],
    [{ ok: true, json: async () => ({}) }, 'the server answered without a result'],
    [{ ok: true, json: async () => ({ result: { ok: false, error: { message: 'not allowed' } } }) }, 'not allowed'],
    [{ ok: true, json: async () => ({ result: { ok: false } }) }, 'the channel refused the call']
  ]) {
    response = reply;
    await assert.rejects(request(EDIT_METHODS.list, {}), { message });
  }
});

ok('the panel uses only the page-local controller bridge, never shared storage or React internals', () => {
  const out = injectEditor(PAGE);
  assert.ok(out.includes('__DSH_CONTEXT_KIT_SESSION__'), 'the controller bridge getter is missing');
  assert.ok(out.includes('dsh-context-kit:session'), 'synchronous selection notifications are missing');
  assert.doesNotMatch(out, /localStorage|sessionStorage|reactFiber|__react|Storage\.prototype/u);
  assert.ok(!out.includes('location.pathname.match'), 'the panel still guesses the session from the path');
});

ok('the served session reader fails closed without an available controller selection', () => {
  const { currentSessionId } = panelConsts(SCRIPT, ['currentSessionId']);
  const window = {};
  Object.defineProperty(window, 'localStorage', { get() { throw Error('storage must never be read'); } });
  const readSession = runInNewContext('(' + currentSessionId.toString() + ')', { window });
  assert.equal(readSession(), '');
  for (const value of [undefined, null, 42, '', {}, 'session-1']) {
    window.__DSH_CONTEXT_KIT_SESSION__ = () => value;
    assert.equal(readSession(), value === 'session-1' ? value : '');
  }
  window.__DSH_CONTEXT_KIT_SESSION__ = () => { throw Error('controller disposed'); };
  assert.equal(readSession(), '');
});

ok('the generation guard reads the scoped Session status before the DOM fallback', () => {
  globalThis.__ctxkitGenerationBridge = { window: {}, rows: [] };
  const { selectedGenerationRunning, generationRunning } = panelConsts(SCRIPT,
    ['selectedGenerationRunning', 'generationRunning'], [
      'const window = globalThis.__ctxkitGenerationBridge.window;',
      'const chatRows = () => globalThis.__ctxkitGenerationBridge.rows;',
      'const running = value => value === true;'
    ].join('\n'));
  assert.equal(selectedGenerationRunning(), false);
  assert.equal(generationRunning(), false);
  globalThis.__ctxkitGenerationBridge.window.__DSH_CONTEXT_KIT_GENERATING__ = () => true;
  assert.equal(selectedGenerationRunning(), true);
  assert.equal(generationRunning(), true);
  globalThis.__ctxkitGenerationBridge.window.__DSH_CONTEXT_KIT_GENERATING__ = () => { throw Error('disposed'); };
  globalThis.__ctxkitGenerationBridge.rows = [true];
  assert.equal(selectedGenerationRunning(), false);
  assert.equal(generationRunning(), true, 'the DOM compatibility fallback stopped working');
  delete globalThis.__ctxkitGenerationBridge;
});

ok('activating Edit history while generation runs opens only the exact refusal', () => {
  globalThis.__ctxkitLaunch = { running: true, calls: [], draft: null };
  const { openPanel } = panelConsts(SCRIPT, ['openPanel'], [
    'const STATE = { get draft() { return globalThis.__ctxkitLaunch.draft; } };',
    'const syncSession = () => globalThis.__ctxkitLaunch.calls.push("sync");',
    'const generationRunning = () => globalThis.__ctxkitLaunch.running;',
    'const showPanel = () => globalThis.__ctxkitLaunch.calls.push("show");',
    'const say = (message, kind) => globalThis.__ctxkitLaunch.calls.push([message, kind]);',
    'const leaveDraft = () => { globalThis.__ctxkitLaunch.calls.push("leave"); return true; };',
    'const clearList = () => globalThis.__ctxkitLaunch.calls.push("clear");',
    'const load = () => globalThis.__ctxkitLaunch.calls.push("load");',
    'const STOP_GENERATION = "Generation is running. Stop generation before editing or deleting history.";'
  ].join('\n'));
  openPanel();
  assert.deepEqual(globalThis.__ctxkitLaunch.calls, ['sync', 'show',
    ['Generation is running. Stop generation before editing or deleting history.', 'err']]);
  globalThis.__ctxkitLaunch.running = false;
  globalThis.__ctxkitLaunch.calls = [];
  openPanel();
  assert.deepEqual(globalThis.__ctxkitLaunch.calls, ['sync', 'show', 'clear', 'load']);
  delete globalThis.__ctxkitLaunch;
});

ok('the classic client binds the selected session and generation from the scoped composer slot', async () => {
  const script = readFileSync(join(ROOT, 'lib', 'edit-client.js'), 'utf8');
  const window = new EventTarget();
  let registration;
  window.__ModuleLoader__ = { load: value => { registration = value; } };
  runInNewContext(script, { window, Event });
  assert.equal(registration.id, 'dsh-context-kit');
  assert.equal(window.__DSH_CONTEXT_KIT_SESSION__, undefined, 'registration must remain lazy');
  assert.equal(window.__DSH_CONTEXT_KIT_GENERATING__, undefined, 'generation registration must remain lazy');
  let component;
  let effects = [];
  const refs = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useEffect: effect => { effects.push(effect); },
    useRef: initial => { const ref = { current: initial }; refs.push(ref); return ref; },
    useState: initial => [initial, () => {}]
  };
  const plugin = registration.factory(id => id === 'react' ? React : (() => { throw Error('unexpected module: ' + id); })());
  assert.deepEqual(Array.from(plugin.inject), ['sessions']);
  const notifications = [];
  Object.defineProperty(window, 'localStorage', { get() { throw Error('the client must not read shared storage'); } });
  window.addEventListener('dsh-context-kit:session', () => notifications.push(window.__DSH_CONTEXT_KIT_SESSION__?.()));
  const root = new Context();
  const consumer = root.plugin(plugin);
  await consumer.await();
  assert.equal(window.__DSH_CONTEXT_KIT_SESSION__, undefined);
  // The real SessionListState has no `current` field. Keeping that broken shape here
  // prevents the editor from drifting back to a catalog-based selection guess.
  const list = { getSnapshot: () => ({ ids: ['catalog-only'], byId: {}, phase: 'ready', projectionsBySession: {} }),
    subscribe: () => { throw Error('session selection must not subscribe to the catalog'); } };
  const slots = { inject: (_name, install) => install(), register: (spec, value) => {
    if (spec.name === 'conversation.input.right') component = value;
    return () => {};
  } };
  const provider = root.plugin({ apply(ctx) { ctx.provide('sessions', { list }); ctx.provide('slots', slots); } });
  try {
    await provider.await(); await consumer.await();
    assert.equal(typeof component, 'function', 'the scoped composer bridge must be registered');
    assert.equal(window.__DSH_CONTEXT_KIT_SESSION__(), undefined);
    assert.equal(window.__DSH_CONTEXT_KIT_GENERATING__(), false);
    const mount = (sessionId, running) => {
      effects = [];
      const firstRef = refs.length;
      const statuses = new Map([[sessionId, { running }]]);
      component({ sessionId, useProjection: () => undefined, useSessionStatus: selector => selector(statuses) });
      const cleanups = effects.map(effect => effect()).filter(value => typeof value === 'function');
      return { runningRef: refs[firstRef], unmount() { for (const cleanup of cleanups.reverse()) cleanup(); } };
    };
    const mountedA = mount('A', false);
    assert.equal(window.__DSH_CONTEXT_KIT_SESSION__(), 'A', 'the exact slot sessionId must become the editor selection');
    assert.equal(window.__DSH_CONTEXT_KIT_GENERATING__(), false);
    const mountedB = mount('B', true);
    assert.equal(window.__DSH_CONTEXT_KIT_SESSION__(), 'B');
    assert.equal(window.__DSH_CONTEXT_KIT_GENERATING__(), true, 'the exact slot status must become the generation guard');
    mountedB.runningRef.current = false;
    mountedA.runningRef.current = true;
    assert.equal(window.__DSH_CONTEXT_KIT_GENERATING__(), false, 'a stale slot status update must not replace the foreground status');
    mountedB.runningRef.current = true;
    mountedA.unmount();
    assert.equal(window.__DSH_CONTEXT_KIT_SESSION__(), 'B', 'stale slot cleanup must not clear the newer selection');
    assert.equal(window.__DSH_CONTEXT_KIT_GENERATING__(), true, 'stale slot cleanup must not clear the newer generation status');
    mountedB.unmount();
    assert.equal(window.__DSH_CONTEXT_KIT_SESSION__(), undefined);
    assert.equal(window.__DSH_CONTEXT_KIT_GENERATING__(), false);
    await provider.dispose(); await consumer.await();
    assert.equal(window.__DSH_CONTEXT_KIT_SESSION__, undefined);
    assert.equal(window.__DSH_CONTEXT_KIT_GENERATING__, undefined);
    assert.deepEqual(notifications, [undefined, 'A', 'B', undefined, undefined]);
  } finally { await consumer.dispose(); await provider.dispose(); }
});

ok('installed client registry discovers the absolute host row through its nearest manifest offline', async () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'dsh-context-kit');
  assert.equal(pkg.exports['./client'], './lib/edit-client.js');
  const clientDependencies = ['@deepseek-ai/dsh-api-session-controller', '@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-ui-settings-plugins'];
  assert.deepEqual(pkg.dsh.client, { platform: 'web', inject: clientDependencies });
  const root = new Context();
  const host = join(ROOT, 'lib', 'edit-host.js');
  assert.ok(statSync(host).isFile());
  root.provide('loader', { entries: () => [{ options: { name: host }, fiber: {},
    parent: { tree: { ctx: { baseUrl: pathToFileURL(join(ROOT, 'package.json')).href } } } }] });
  const scope = root.plugin(ClientModuleRegistry);
  try {
    await scope.await();
    const registry = root.get('clientModules');
    const graph = registry.graph();
    const module = graph.entries.find(row => row.id === pkg.name);
    assert.deepEqual(module.inject, clientDependencies);
    assert.equal(registry.clientPath(pkg.name), join(ROOT, 'lib', 'edit-client.js'));
    assert.ok(bootInjections(graph).find(row => row.name === '__DSH_BOOT__').value.entries.includes(module));
    const response = await registry.fetchBundle(new Request(new URL(module.url, 'https://editor.invalid')));
    assert.equal(response.status, 200);
    assert.ok((await response.text()).includes('__DSH_CONTEXT_KIT_SESSION__'));
  } finally { await scope.dispose(); }
});

ok('Chat CSS tokens match only the two complete module naming formats', () => {
  const { hasToken } = panelConsts(SCRIPT, ['hasToken']);
  for (const [token, suffix] of [['Sixlwa_userRow', 'userRow'], ['lcKema_thinkBody', 'thinkBody'],
    ['_markdown_kcgor_5', 'markdown'], ['other_markdown', 'markdown']]) {
    assert.equal(hasToken({ classList: ['extra', token] }, suffix), true);
  }
  for (const token of ['x_markdown_unknown', '_markdown_hash', '_markdown_hash_5_extra', 'markdown', 'prefix_markdownSuffix']) {
    assert.equal(hasToken({ classList: [token] }, 'markdown'), false, token);
  }
});

ok('the five methods the browser may call are the five the channel answers', () => {
  const source = readFileSync(join(ROOT, 'lib', 'edit-gui.js'), 'utf8');
  for (const method of Object.values(EDIT_METHODS)) {
    assert.ok(source.includes(`'${method}'`), `${method} is not named in the module`);
    assert.ok(injectEditor(PAGE).includes(`'${method}'`), `${method} is never called by the panel`);
  }
  assert.deepEqual(Object.keys(EDIT_METHODS).sort(), ['commit', 'deleteMessage', 'deleteTurn', 'list', 'status']);
});

ok('the panel refuses nothing silently: refusals are shown as text', () => {
  const out = injectEditor(PAGE);
  assert.ok(out.includes('cannot be edited here'), 'a refused message would render without an explanation');
  assert.ok(out.includes('Not saved.'), 'a refused save would render without feedback');
});

console.log('mounting (headless must not break)');

ok('a composition with no Web surface gets no button, and still yields a disposer', () => {
  // No `connection`, no `webServer`, and an `inject` that never fires: exactly what
  // a headless or ACP composition looks like. The plugin must still boot, which
  // means the call must not throw — AND it must not hand the caller `undefined`,
  // because the caller is `yield installEditGui(...)` inside a cordis generator
  // effect, and `Fiber._execute` throws `TypeError: Invalid effect` for a non-null,
  // non-function yield (`cordis/lib/index.js:1139`). A no-op disposer is the answer
  // for "nothing mounted yet".
  const injected = [];
  const ctx = { get: () => undefined, inject: (names, callback) => injected.push({ names, callback }) };
  const result = installEditGui(ctx, {});
  assert.equal(typeof result, 'function', 'a deferred mount must still return a disposer for the effect to collect');
  result(); // releasing nothing must not throw either
  assert.deepEqual(injected.map((entry) => entry.names), [['connection', 'webServer']]);
});

ok('a Web surface registers exactly one channel and one tap, and releases both', async () => {
  const released = [];
  const routes = [];
  const tapped = [];
  const ctx = {
    get: (key) => (key === 'connection'
      ? { rpc: { handle: () => { throw new Error('the connection seam must not be used for the channel'); } } }
      : key === 'webServer'
        ? {
          tapIndex: (transform) => { tapped.push(transform); return () => released.push('tap'); },
          register: (route) => { routes.push(route); return () => released.push('route'); }
        }
        : undefined),
    effect: (body) => { released.push('effect'); return body(); }
  };
  const dispose = installEditGui(ctx, { dcpConfig: { editor: { enabled: true, requireIdle: true } } });
  assert.equal(typeof dispose, 'function', 'no disposer was returned');
  // The channel is an HTTP route on the server, NOT a `connection.rpc.handle`
  // registration: that seam resolves `owner.webServer` through the registration's
  // own scope and killed the boot three times. See `lib/edit-route.js`.
  assert.deepEqual(routes.map((route) => route.path), [EDIT_CHANNEL]);
  assert.equal(routes[0].kind, 'prefix');
  assert.equal(typeof routes[0].handler, 'function', 'the route has no request handler');
  assert.equal(tapped.length, 1, 'the index tap was not registered');
  assert.equal(tapped[0](PAGE).includes('dsh-context-kit-editor'), true, 'the registered tap does not inject');
  // The route speaks the connection's protocol: JSON in, JSON out, method in path,
  // and the REAL handler behind it — every method is answered by the same code the
  // browser will reach.
  const answer = routeAnswer(routes[0]);

  // An unknown method is content the panel can show: HTTP 200, `result.value` with
  // the reason — not a transport failure and not a thrown error.
  const unknown = await answer('contextKit.edit.nope', {});
  assert.equal(unknown.status, 200, 'a refusal must be content, not a transport failure');
  assert.equal(unknown.body.type, 'server-response');
  assert.equal(unknown.body.result.ok, true);
  assert.equal(unknown.body.result.value.ok, false, 'an unknown method must come back as a refusal');
  assert.match(unknown.body.result.value.reason, /unknown method/u);

  const status = await answer(EDIT_METHODS.status, {});
  assert.equal(status.body.result.value.enabled, true);
  assert.equal(status.body.result.value.requireIdle, true);

  const listed = await answer(EDIT_METHODS.list, { sessionId: 'missing' });
  assert.equal(listed.body.result.value.ok, false, 'a session the server does not hold must be refused, not invented');
  assert.match(listed.body.result.value.reason, /no live session/u);

  const wrongPath = await answer(EDIT_METHODS.status, {});
  assert.equal(wrongPath.body.rpcId, '1', 'the response must carry the request correlation id');

  dispose();
  assert.deepEqual([...released].sort(), ['effect', 'route', 'tap'], 'the channel route and the tap must both be released');
});

ok('a Web surface that comes up LATER is still mounted (the load-order bug)', () => {
  // THE BUG THIS EXISTS FOR, and the reason the first release shipped a button
  // nobody could see. `ctx.get('webServer')` is `undefined` while a preset row is
  // being mounted on a real Web server, because the host services are still coming
  // up. The first version read the two services ONCE and returned `undefined` when
  // either was missing — so the plugin recorded "no Web surface here", registered
  // no route and no tap, and said nothing anywhere. Live symptoms: `POST
  // /ctxkit/edit` answered 405 (the static fallback), and the served index never
  // contained the host element.
  //
  // The contract now: when the services are not readable yet, the mount must be
  // handed to `ctx.inject`, which runs it when they arrive.
  const released = [];
  const routes = [];
  const tapped = [];
  const injected = [];
  const late = {
    get: (key) => (key === 'webServer'
      ? {
        tapIndex: (transform) => { tapped.push(transform); return () => released.push('tap'); },
        register: (route) => { routes.push(route); return () => released.push('route'); }
      }
      : undefined),
    // The injected callback registers the mount on the OUTER context, whose
    // `effect` is what an injected context does not have. Without it here the
    // mount throws into the callback's own guard and this test would pass on a
    // button that never registers anything.
    effect: (body) => { released.push('effect'); return body(); }
  };
  const ctx = {
    // Nothing is provided at mount time — the whole point.
    get: () => undefined,
    effect: (body) => { released.push('effect'); return body(); },
    inject: (names, callback) => injected.push({ names, callback })
  };
  // A no-op disposer, not `undefined`: the caller is `yield installEditGui(...)`
  // inside a cordis generator effect, and `Fiber._execute` rejects a non-null,
  // non-function yield with `TypeError: Invalid effect` (`cordis/lib/index.js:1139`).
  const deferred = installEditGui(ctx, { dcpConfig: { editor: { enabled: true } } });
  assert.equal(typeof deferred, 'function', 'the deferred mount must answer with a disposer the effect can collect');
  deferred();
  assert.equal(routes.length, 0, 'nothing may be registered before the services exist');
  assert.deepEqual(injected.map((entry) => entry.names), [['connection', 'webServer']],
    'the mount was never handed to ctx.inject, so a later Web surface would never get a button');

  // Now the host services arrive and cordis runs the injected callback.
  injected[0].callback(late);
  assert.deepEqual(routes.map((route) => route.path), [EDIT_CHANNEL],
    'the channel was not registered when the services arrived');
  assert.equal(tapped.length, 1, 'the index tap was not registered when the services arrived');
  assert.ok(tapped[0](PAGE).includes('id="dsh-context-kit-editor"'),
    'the late tap does not inject the button host');
});

console.log('the trail left on disk (the only diagnostic that survives a restart)');

ok('every decision point writes a readable line, and a broken home never throws', () => {
  // The button shipped invisible TWICE, and both times the only record was a line
  // in a terminal nobody could read afterwards. The panel now appends its mounting
  // trail to `$DSH_HOME/context-kit/edit-gui.log`, so "it logged something" is a
  // fact that can be checked after the process is gone.
  const home = mkdtempSync(join(scratchHome, 'ctxkit-trail-'));
  try {
    const ctx = {
      get: (key) => (key === 'dshHome' ? home : undefined),
      inject: () => {},
      logger: { warn: () => {} }
    };
    installEditGui(ctx, { dcpConfig: { editor: { enabled: true } } });
    const trail = readFileSync(join(home, 'context-kit', 'edit-gui.log'), 'utf8');
    assert.match(trail, /install /u, 'the install stage was not recorded');
    assert.match(trail, /"canInject":true/u, 'the trail does not say whether injection was even possible');
    assert.match(trail, /"connection":"no"/u, 'the trail does not say which service was missing');
    assert.match(trail, /inject:asking/u, 'the trail does not show that the deferred mount was requested');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  // No home at all, and a home that is not a string: neither may throw, because a
  // diagnostic must never be the reason the plugin fails to load.
  assert.equal(typeof installEditGui({ get: () => undefined, inject: () => {} }, {}), 'function');
  assert.equal(typeof installEditGui({ get: () => 42, inject: () => {} }, {}), 'function');
  // A name that resolves to something which cannot carry a channel or a tap is the
  // same situation as a missing service: fall through to the injected path rather
  // than throwing a `TypeError` out of `mount`.
  const injectedFor = [];
  const strange = { get: () => 42, inject: (names, callback) => injectedFor.push(names), logger: { warn: () => {} } };
  installEditGui(strange, { dcpConfig: { editor: { enabled: true } } });
  assert.deepEqual(injectedFor, [['connection', 'webServer']],
    'an unusable service must be treated as absent, not mounted against');
});

console.log('\nthe panel entry rule (why the list refused every message, including your own)');

/** An entry as `editableIndex` builds one: `blocks` is a COUNT, and `message` is the node. */
const userEntry = (content, extra = {}) => ({
  seq: 8,
  type: 'user/message',
  role: 'user',
  id: '5337c8c9-0ed2-4664-8603-8961ced46807',
  index: 1,
  userIndex: 0,
  text: content.filter((block) => block.type === 'text').map((block) => block.text).join(''),
  blocks: content.filter((block) => block.type === 'text').length,
  message: { id: '5337c8c9-0ed2-4664-8603-8961ced46807', role: 'user', content },
  ...extra
});

ok('a plain user message is OFFERED, not refused', () => {
  // THE BUG THIS EXISTS FOR. `editableIndex` fills `blocks` with the NUMBER of
  // editable texts, and the panel read it as the block ARRAY — `Array.isArray(entry.blocks)`
  // was false for every message of every session — so the list said "cannot be edited
  // here" about everything, the user's own plain text included, while the durable branch
  // would have accepted it. That is the whole reason the button looked broken.
  const content = [{ type: 'text', text: 'plain user text' }];
  const shown = panelEntry(userEntry(content));
  assert.equal(shown.editable, true, `a plain user message was refused: ${String(shown.reason)}`);
  assert.equal(shown.reason, undefined, 'an offered message still carries a refusal reason');
  assert.equal(shown.textBlocks, 1, 'the count of editable texts is not passed through');
  assert.equal(shown.seq, 8);
});

ok('a verified origin without an id is not replaced with the current id', () => {
  const shown = panelEntry(userEntry([{ type: 'text', text: 'B' }], { originSeq: 1, originId: undefined }));
  assert.equal(shown.originSeq, 1);
  assert.equal(shown.originId, undefined, 'unknown provenance must remain unknown');
});

ok('the panel and the commit answer the same question (one rule, one place)', () => {
  // They must not be able to drift: the panel may not offer what `commitUserEdit` refuses.
  const plain = userEntry([{ type: 'text', text: 'x' }]);
  assert.deepEqual(editability(plain), { ok: true, branch: 'durable' }, 'the shared rule disagrees with the panel on a plain message');
  // A message that says something AND carries something else is editable: the text is
  // rewritten, the rest is copied into the replacement untouched, and nothing is refused
  // on the person's behalf.
  const mixed = userEntry([{ type: 'text', text: 'x' }, { type: 'file', path: 'a.txt' }]);
  assert.deepEqual(editability(mixed), { ok: true, branch: 'durable' }, 'a message with a file beside its text is not editable');
  assert.equal(panelEntry(mixed).editable, true, 'the panel withholds a message the commit accepts');
});

ok('a message with no text block is refused for the reason it has', () => {
  // The one thing a durable edit cannot do is find words to rewrite; an image on its own
  // has none, and saying so is the whole refusal.
  const shown = panelEntry(userEntry([{ type: 'image', source: {} }]));
  assert.equal(shown.editable, false);
  assert.match(String(shown.reason), /no text block/u, 'the refusal no longer explains itself');
});

ok('the assistant\'s reply is offered too, and says it goes to the wire', () => {
  // The log cannot hold this edit (an assistant node embeds its own source stream),
  // so the reply is editable through the store and the request the provider sees.
  // The panel must say WHICH branch it is, because the two keep different promises:
  // the durable one rewrites the record, the wire one only rewrites the request.
  const shown = panelEntry({
    seq: 15,
    type: 'assistant/message',
    role: 'assistant',
    id: '5f013e03-1300-4e89-91cb-ac5f790669d5',
    index: 3,
    turn: 1,
    step: 1,
    text: 'ok',
    blocks: 1,
    message: { id: '5f013e03', role: 'assistant', content: [{ type: 'text', text: 'ok' }] }
  });
  assert.equal(shown.editable, true, `an assistant reply was refused: ${String(shown.reason)}`);
  assert.equal(shown.branch, 'wire', 'the assistant branch is not named');
  // THE ROW MATCHER FEEDS ON THESE TWO NUMBERS. Without them the browser has no way to
  // tie the reply's transcript row to this entry, because that row names no id at all.
  assert.equal(shown.turn, 1, 'the reply\'s turn is not passed to the browser');
  assert.equal(shown.step, 1, 'the reply\'s step is not passed to the browser');
  // A user message has no position in a turn, and must not be given one: a fabricated
  // 0:0 would let a row match a message by accident.
  assert.equal(panelEntry(userEntry([{ type: 'text', text: 'x' }])).turn, undefined,
    'a user message was given a turn number it does not have');
  // A reply with nothing to rewrite is still refused, in its own words.
  const silent = panelEntry({
    seq: 16,
    type: 'assistant/message',
    role: 'assistant',
    id: 'a1',
    index: 4,
    text: '',
    blocks: 0,
    message: { id: 'a1', role: 'assistant', content: [{ type: 'tool-call', id: 't1', name: 'read' }] }
  });
  assert.equal(silent.editable, false, 'a reply with no text block cannot be rewritten');
  assert.match(String(silent.reason), /no text block/u, 'the refusal does not say what is missing');
});

ok('the durable branch still refuses an assistant message', () => {
  // `commitUserEdit` is the log branch. Accepting the reply here would append a
  // replacement the fold refuses, so the two branches must not be confused.
  const entry = {
    seq: 15,
    type: 'assistant/message',
    role: 'assistant',
    id: '5f013e03',
    index: 3,
    text: 'ok',
    blocks: 1,
    message: { id: '5f013e03', role: 'assistant', content: [{ type: 'text', text: 'ok' }] }
  };
  const refused = commitUserEdit({ append: () => { throw new Error('the log must not be touched'); } }, entry, 'changed');
  assert.equal(refused.ok, false, 'the durable branch accepted an assistant node');
  assert.match(String(refused.reason), /wire overlay/u, 'the refusal no longer names the branch that works');
});

console.log('\nthe pencil on each message (the transcript is the shell\'s, not ours)');

/**
 * Evaluate named arrow functions out of the SERVED script, together.
 *
 * The decorator's helpers call each other (`targetOf` -> `stepOf` -> `flowBody`), so
 * extracting one of them alone would test a function whose dependencies do not exist
 * and would report a missing helper as a broken one. The source text is taken from the
 * served page rather than from the module, so what is checked is what the browser runs.
 *
 * @param script - the served panel script.
 * @param names - the const names to lift, in dependency order.
 * @param extra - extra declarations the lifted code needs from the page (`document`, and
 *   the row opener the pencils call), appended after the lifted source.
 * @returns the functions, by name.
 */
function panelConsts(script, names, extra = '') {
  // A declaration ends at its own closing brace line or at the next top-level
  // declaration, whichever comes first, and both boundaries carry their indentation.
  // A bare '};' search stops inside a helper that returns an object literal
  // (`return { turn: 1 };` ends with the very characters being searched for) and a
  // bare 'const' search stops inside a function body, and either way the slice does
  // not parse and the failure reads as a broken panel instead of a broken extractor.
  const BRACE = '\n  };';
  const NEXT = '\n  const ';
  const parts = names.map((name) => {
    const at = script.indexOf(`const ${name} `);
    assert.ok(at > 0, `the served script no longer defines ${name}`);
    const ends = [BRACE, NEXT]
      .map((marker) => script.indexOf(marker, at + 1))
      .filter((index) => index > at);
    assert.ok(ends.length > 0, `the definition of ${name} has no end`);
    const end = Math.min(...ends);
    return script.slice(at, script.startsWith(BRACE, end) ? end + BRACE.length : end);
  });
  return new Function(`${parts.join('\n')}\n${extra}\nreturn { ${names.join(', ')} };`)();
}

/** One transcript row, as the decorator sees it: the attribute and nothing else. */
const flowRow = (key, kind) => ({ getAttribute: (name) => (name === 'data-chat-flow-kind' ? kind ?? 'user' : key ?? null) });

ok('the served script reads the id out of the live flow key', () => {
  // The pencil is placed by ID, never by text: the shell renders
  // `data-chat-flow-key="13:input-message<id>"`, and that tail is exactly the id the
  // engine lists. Verified against the live GUI, so the parse is tested on the real shape.
  const script = injectEditor(PAGE);
  assert.ok(script.includes('data-chat-flow-key'), 'the decorator does not look at the attribute that names a message');
  assert.ok(script.includes('data-ctxkit-pencil'), 'the pencil marker is missing from the served script');
  assert.ok(script.includes('stopPropagation'), 'a pencil click would travel into the shell as a message click');
  assert.ok(!script.includes('Array.isArray(entry.blocks)'), 'the predicate that refused every message is back');
  const { messageIdOf } = panelConsts(script, ['flowBody', 'messageIdOf']);
  assert.equal(messageIdOf(flowRow('13:input-message5337c8c9-0ed2-4664-8603-8961ced46807')),
    '5337c8c9-0ed2-4664-8603-8961ced46807', 'the live flow key no longer yields the message id');
  assert.equal(messageIdOf(flowRow('4:context-injection')), '',
    'a node that names no message must yield no id rather than a fragment');
  assert.equal(messageIdOf(flowRow(null)), '', 'a missing attribute must not throw');
});

ok('a reply row is named by the turn and the step, because it carries no id', () => {
  // THE BUG THIS EXISTS FOR. The shell keys a reply `<flow>:assistant-step<turn>:<step>`
  // — `14:assistant-step1:1`, verified live, for the reply of turn 1 step 1 — and that
  // row contains no message id at all, so the id-only decorator never placed a pencil
  // on an assistant reply. The two numbers are the same ones the session log records on
  // the `assistant/message` envelope, and they are now parsed out of the row.
  const script = injectEditor(PAGE);
  const { stepOf } = panelConsts(script, ['flowBody', 'stepPrefix', 'stepOf']);
  assert.deepEqual(stepOf(flowRow('14:assistant-step1:1', 'assistant-step')), { turn: 1, step: 1 },
    'the live assistant row key no longer yields its position');
  assert.deepEqual(stepOf(flowRow('9:assistant-step12:3', 'assistant-step')), { turn: 12, step: 3 },
    'a two-digit turn and step must parse');
  // Everything that is NOT a reply position must yield nothing. A guess here would put
  // the pencil on whatever message happened to sit at 0:0.
  for (const key of ['13:input-message5337c8c9-0ed2-4664-8603-8961ced46807', '12:turn-process1', '9:turn-tail1', '14:system-message7', '4:context-injection']) {
    assert.equal(stepOf(flowRow(key)), undefined, `a non-reply row (${key}) was read as a position`);
  }
  for (const key of ['14:assistant-step1', '14:assistant-step1:', '14:assistant-stepx:1', '14:assistant-step1:1:1', null]) {
    assert.equal(stepOf(flowRow(key)), undefined, `a malformed reply key (${String(key)}) was read as a position`);
  }
});

ok('each deletion kind is offered only for its own message role', () => {
  const { canDeleteTurn, canDeleteMessage } = panelConsts(injectEditor(PAGE), ['canDeleteTurn', 'canDeleteMessage']);
  assert.equal(canDeleteTurn({ type: 'user/message', directUser: true }), true);
  assert.equal(canDeleteMessage({ type: 'assistant/message' }), true);
  for (const entry of [
    { type: 'user/message', directUser: false },
    { type: 'user/message' },
    { type: 'assistant/message', directUser: true },
    { type: 'tool/result', directUser: true },
    undefined
  ]) assert.equal(canDeleteTurn(entry), false, JSON.stringify(entry));
  for (const entry of [
    { type: 'user/message', directUser: true },
    { type: 'tool/result' },
    undefined
  ]) assert.equal(canDeleteMessage(entry), false, JSON.stringify(entry));
});

ok('grouped seats use their canonical reply key and deleted turns include auxiliary flow rows', () => {
  const script = injectEditor(PAGE);
  const { stepOf, turnOf, deletedTurnsOf, deletedEntryFor } = panelConsts(script, [
    'flowBody', 'messageIdOf', 'turnOf', 'stepPrefix', 'stepOf', 'entryFor', 'targetOf', 'deletedTurnsOf', 'deletedEntryFor'
  ]);
  const row = (attributes) => ({ getAttribute: (name) => attributes[name] ?? null });
  const grouped = row({
    'data-chat-flow-kind': 'assistant-step',
    'data-chat-node-key': '14:assistant-step8:2',
    'data-chat-flow-key': '["14:assistant-step8:2","reasoning"]',
    'data-chat-turn': '8'
  });
  assert.deepEqual(stepOf(grouped), { turn: 8, step: 2 }, 'the grouped member seat did not use data-chat-node-key');
  assert.equal(turnOf(grouped), 8);
  assert.equal(turnOf(row({})), undefined, 'a missing turn must not become turn zero');

  const hidden = [{ type: 'assistant/message', turn: 8, step: 2, id: 'reply-8', deletedTurn: true }];
  const hiddenTurns = deletedTurnsOf(hidden);
  assert.deepEqual([...hiddenTurns], [8]);
  assert.deepEqual([...deletedTurnsOf([{ type: 'assistant/message', turn: 8, step: 2 }])], [],
    'a future partial hide must not hide the complete process group');
  assert.equal(deletedEntryFor(hidden, hiddenTurns, grouped)?.turn, 8, 'the grouped reply seat stayed visible');
  for (const auxiliary of [
    row({ 'data-chat-flow-kind': 'tool', 'data-chat-flow-key': '15:tool-call8', 'data-chat-turn': '8' }),
    row({ 'data-chat-flow-key': '12:turn-process8', 'data-chat-turn': '8' }),
    row({ 'data-chat-flow-key': '9:turn-tail8', 'data-chat-turn': '8' })
  ]) assert.equal(deletedEntryFor(hidden, hiddenTurns, auxiliary)?.turn, 8, 'an auxiliary row in the deleted turn stayed visible');
  assert.equal(deletedEntryFor(hidden, hiddenTurns, row({ 'data-chat-turn': '9' })), undefined,
    'a neighboring turn was hidden');
  assert.equal(deletedEntryFor([{ type: 'user/message', originId: 'u1' }], new Set(),
    row({ 'data-chat-flow-kind': 'user', 'data-chat-flow-key': '13:input-messageu1' })), undefined,
  'a partially hidden row without Host deletion metadata must stay visible');
  assert.equal(deletedEntryFor([{ type: 'user/message', originId: 'u1', deletedTurn: true }], new Set(),
    row({ 'data-chat-flow-kind': 'user', 'data-chat-flow-key': '13:input-messageu1' }))?.originId, 'u1',
  'a deleted user-only turn must still match by origin id when the Host marks it deleted');

  const partial = [{ type: 'assistant/message', turn: 8, step: 2, id: 'reply-8', deletedMessage: true, deletedTurn: false }];
  const partialTurns = deletedTurnsOf(partial);
  assert.deepEqual([...partialTurns], [], 'one assistant tombstone was promoted to a complete deleted turn');
  assert.equal(deletedEntryFor(partial, partialTurns, grouped)?.id, 'reply-8',
    'the exact deleted assistant seat stayed visible');
  assert.equal(deletedEntryFor(partial, partialTurns, row({
    'data-chat-flow-kind': 'assistant-step', 'data-chat-node-key': '14:assistant-step8:1', 'data-chat-turn': '8'
  })), undefined, 'a sibling assistant step was hidden with the exact deleted message');
  assert.equal(deletedEntryFor(partial, partialTurns,
    row({ 'data-chat-flow-key': '12:turn-process8', 'data-chat-turn': '8' })), undefined,
  'a partial assistant deletion hid the whole grouped process');
});

ok('the decorator hides only the exact assistant row for a delete-message tombstone', () => {
  const exact = fakeElement('article');
  exact.setAttribute('data-chat-flow-kind', 'assistant-step');
  exact.setAttribute('data-chat-node-key', '14:assistant-step8:2');
  exact.setAttribute('data-chat-flow-key', '["14:assistant-step8:2","reasoning"]');
  exact.setAttribute('data-chat-turn', '8');
  const sibling = fakeElement('article');
  sibling.setAttribute('data-chat-flow-kind', 'assistant-step');
  sibling.setAttribute('data-chat-node-key', '14:assistant-step8:1');
  sibling.setAttribute('data-chat-flow-key', '14:assistant-step8:1');
  sibling.setAttribute('data-chat-turn', '8');
  const process = fakeElement('article');
  process.setAttribute('data-chat-flow-key', '12:turn-process8');
  process.setAttribute('data-chat-turn', '8');
  const rows = [exact, sibling, process];
  globalThis.__ctxkitHiddenDocument = {
    querySelectorAll: (selector) => selector === '[data-chat-flow] > [data-chat-flow-key]' ? rows : []
  };
  const { STATE, HIDDEN_TURN_ATTR, decorateTranscript } = panelConsts(injectEditor(PAGE), [
    'STATE', 'FLOW_SELECTOR', 'HIDDEN_TURN_ATTR', 'flowBody', 'messageIdOf', 'turnOf', 'stepPrefix', 'stepOf',
    'entryFor', 'targetOf', 'deletedTurnsOf', 'deletedEntryFor', 'projections', 'pinnedRows', 'unavailableRows',
    'rowOwners', 'hiddenRows', 'setDeletedVisibility', 'decorateTranscript'
  ], [
    'const document = globalThis.__ctxkitHiddenDocument;',
    'const flowRows = () => [...document.querySelectorAll(FLOW_SELECTOR)];',
    'const running = () => false; const installAffordance = () => {};',
    'const DELETE_ACTION_ATTR = "data-ctxkit-delete"; const PENCIL_ATTR = "data-ctxkit-pencil";',
    'const projectRow = () => {}; const placeDeleteAction = () => {};'
  ].join('\n'));
  STATE.sessionId = 'test-session';
  STATE.hidden = [{ type: 'assistant/message', turn: 8, step: 2, id: 'reply-8', deletedMessage: true, deletedTurn: false }];
  STATE.transcript = [];
  decorateTranscript();
  assert.equal(exact.hasAttribute(HIDDEN_TURN_ATTR), true, 'the exact deleted assistant row stayed visible');
  assert.equal(sibling.hasAttribute(HIDDEN_TURN_ATTR), false, 'a sibling assistant row was hidden');
  assert.equal(process.hasAttribute(HIDDEN_TURN_ATTR), false, 'the grouped process row was hidden');
  STATE.hidden = [];
  decorateTranscript();
  assert.equal(exact.hasAttribute(HIDDEN_TURN_ATTR), false, 'clearing Host metadata did not restore the row');
  delete globalThis.__ctxkitHiddenDocument;
});

ok('deleted-row markers are reversible without touching native visibility or DOM ownership', () => {
  const { HIDDEN_TURN_ATTR, setDeletedVisibility } = panelConsts(injectEditor(PAGE), [
    'HIDDEN_TURN_ATTR', 'hiddenRows', 'setDeletedVisibility'
  ]);
  const parent = fakeElement('div');
  const before = fakeElement('span');
  const row = fakeElement('article');
  const after = fakeElement('span');
  parent.append(before, row, after);
  row.hidden = false;
  row.style.display = 'grid';
  const children = [...parent.children];

  setDeletedVisibility(row, true);
  assert.equal(row.hasAttribute(HIDDEN_TURN_ATTR), true);
  setDeletedVisibility(row, true);
  assert.deepEqual(parent.children, children, 're-decoration changed native child order');
  assert.equal(row.parentNode, parent, 're-decoration reparented a React-owned row');
  assert.equal(row.hidden, false, 'native hidden state was changed');
  assert.equal(row.style.display, 'grid', 'native display state was changed');
  setDeletedVisibility(row, false);
  assert.equal(row.hasAttribute(HIDDEN_TURN_ATTR), false, 'the plugin-owned marker was not restored');

  const native = fakeElement('article');
  native.setAttribute(HIDDEN_TURN_ATTR, 'native');
  setDeletedVisibility(native, true);
  setDeletedVisibility(native, false);
  assert.equal(native.getAttribute(HIDDEN_TURN_ATTR), 'native', 'a pre-existing native marker was clobbered');
});

ok('nested editable regions paint one deepest hover outline and share their mark safely', () => {
  const head = fakeElement('head');
  head.querySelector = (selector) => head.children.find((child) => child.tagName === 'STYLE'
    && selector === 'style[data-ctxkit-affordance]' && child.hasAttribute('data-ctxkit-affordance')) || null;
  globalThis.__ctxkitAffordanceDocument = { head, createElement: (tag) => fakeElement(tag) };
  const { EDIT_ATTR, AFFORDANCE_ATTR, installAffordance, markRegion, unmarkRegion, pinAt } = panelConsts(injectEditor(PAGE), [
    'PENCIL_ATTR', 'HIDDEN_TURN_ATTR', 'EDIT_ATTR', 'AFFORDANCE_ATTR', 'installAffordance',
    'regionOwners', 'markRegion', 'unmarkRegion', 'pinAt'
  ], 'const document = globalThis.__ctxkitAffordanceDocument;');
  installAffordance();
  installAffordance();
  const styles = globalThis.__ctxkitAffordanceDocument.head.children
    .filter((child) => child.getAttribute(AFFORDANCE_ATTR) !== null);
  assert.equal(styles.length, 1, 'the hover stylesheet was installed twice');
  const hover = styles[0].textContent.split('\n')[0];
  assert.match(hover, /^\[data-ctxkit-edit\]:hover:not\(:has\(\[data-ctxkit-edit\]:hover\)\)/u,
    'an outer marked wrapper can still paint behind its hovered child');
  assert.equal((hover.match(/outline:/gu) || []).length, 1, 'the hover winner paints more than one outline');
  assert.doesNotMatch(hover, /box-shadow/u, 'the removed hover glow came back');
  assert.doesNotMatch(styles[0].textContent, /\[data-ctxkit-edit\]:hover\s*\{/u,
    'a generic parent hover painter bypasses the deepest-only rule');

  const shared = fakeElement('div');
  markRegion(shared);
  markRegion(shared);
  assert.equal(shared.hasAttribute(EDIT_ATTR), true);
  unmarkRegion(shared);
  assert.equal(shared.hasAttribute(EDIT_ATTR), true, 'one owner removed another target\'s shared hover region');
  unmarkRegion(shared);
  assert.equal(shared.hasAttribute(EDIT_ATTR), false, 'the final owner did not clean up its hover region');

  const leaf = {};
  const outer = { contains: (candidate) => candidate === outer || candidate === inner || candidate === leaf };
  const inner = { contains: (candidate) => candidate === inner || candidate === leaf };
  const outerPin = { regions: [outer] };
  const innerPin = { regions: [inner] };
  for (const pins of [[outerPin, innerPin], [innerPin, outerPin]]) {
    assert.equal(pinAt({ querySelectorAll: () => pins }, leaf), innerPin,
      'the innermost editable region did not win independently of pin order');
  }
  delete globalThis.__ctxkitAffordanceDocument;
});

ok('re-decoration keeps exactly one delete action on a direct human row', () => {
  globalThis.__ctxkitDeleteDocument = { createElement: (tag) => fakeElement(tag) };
  const { placeDeleteAction } = panelConsts(injectEditor(PAGE), [
    'canDeleteTurn', 'canDeleteMessage', 'placeDeleteAction'
  ], [
    'const document = globalThis.__ctxkitDeleteDocument;',
    'const DELETE_ACTION_ATTR = "data-ctxkit-delete";',
    'const requestTurnDeletion = () => {};',
    'const requestMessageDeletion = () => {};',
    'const userActionStrip = (node) => node;',
    'const textLayout = () => ({ containers: [], thinks: [] });'
  ].join('\n'));
  const row = fakeElement('article');
  const entry = { type: 'user/message', directUser: true, seq: 17 };
  placeDeleteAction(row, entry);
  const first = row.querySelector('[data-ctxkit-delete]');
  placeDeleteAction(row, entry);
  assert.equal(row.querySelectorAll('[data-ctxkit-delete]').length, 1, 'a second decoration duplicated Delete turn');
  assert.equal(row.querySelector('[data-ctxkit-delete]'), first, 'a stable delete action was unnecessarily replaced');
  delete globalThis.__ctxkitDeleteDocument;
});

ok('an assistant row keeps one exact delete-message action and wires its callback', () => {
  globalThis.__ctxkitDeleteAction = { calls: [] };
  globalThis.__ctxkitDeleteDocument = { createElement: (tag) => fakeElement(tag) };
  const { placeDeleteAction } = panelConsts(injectEditor(PAGE), [
    'canDeleteTurn', 'canDeleteMessage', 'placeDeleteAction'
  ], [
    'const document = globalThis.__ctxkitDeleteDocument;',
    'const DELETE_ACTION_ATTR = "data-ctxkit-delete";',
    'const requestTurnDeletion = () => { throw Error("assistant action called deleteTurn"); };',
    'const requestMessageDeletion = (entry, control) => globalThis.__ctxkitDeleteAction.calls.push([entry, control]);',
    'const userActionStrip = () => null;',
    'const textLayout = () => ({ containers: [], thinks: [] });'
  ].join('\n'));
  const row = fakeElement('article');
  const entry = { type: 'assistant/message', seq: 18, id: 'reply-18', turn: 3, step: 2 };
  placeDeleteAction(row, entry);
  const first = row.querySelector('[data-ctxkit-delete]');
  placeDeleteAction(row, entry);
  assert.equal(row.querySelectorAll('[data-ctxkit-delete]').length, 1, 'a second decoration duplicated Delete message');
  assert.equal(row.querySelector('[data-ctxkit-delete]'), first, 'a stable assistant delete action was replaced');
  assert.equal(first.getAttribute('data-ctxkit-delete'), 'message:18');
  const button = first.shadowRoot.children.find((child) => child.tagName === 'BUTTON');
  assert.equal(button.textContent, 'Delete message');
  assert.equal(button.getAttribute('aria-label'), 'Delete this assistant message');
  button.dispatch('click');
  assert.equal(globalThis.__ctxkitDeleteAction.calls.length, 1, 'the assistant action did not request message deletion');
  assert.equal(globalThis.__ctxkitDeleteAction.calls[0][0], entry);
  assert.equal(globalThis.__ctxkitDeleteAction.calls[0][1], button);
  delete globalThis.__ctxkitDeleteAction;
  delete globalThis.__ctxkitDeleteDocument;
});

ok('turn deletion waits for confirmation, sends the exact payload, and refreshes only after Host success', async () => {
  globalThis.__ctxkitDelete = { running: false, confirmation: null, calls: [], loads: 0, notices: [], answer: { ok: true } };
  const { STATE, requestTurnDeletion } = panelConsts(injectEditor(PAGE), [
    'STATE', 'entryFor', 'canDeleteTurn', 'requestTurnDeletion'
  ], [
    'const syncSession = () => {};',
    'const generationRunning = () => globalThis.__ctxkitDelete.running;',
    'const say = (message, kind) => globalThis.__ctxkitDelete.notices.push([message, kind]);',
    'const leaveDraft = () => true;',
    'const askConfirmation = (title, message, action, accept, cancel) => { globalThis.__ctxkitDelete.confirmation = { title, message, action, accept, cancel }; };',
    'const call = async (method, payload) => { globalThis.__ctxkitDelete.calls.push([method, payload]); return globalThis.__ctxkitDelete.answer; };',
    'const isCurrent = () => true;',
    'const load = async () => { globalThis.__ctxkitDelete.loads += 1; return true; };',
    'const STOP_GENERATION = "Generation is running. Stop generation before editing or deleting history.";'
  ].join('\n'));
  const entry = { type: 'user/message', directUser: true, originId: 'origin-u', id: 'wire-u', seq: 17, text: 'question' };
  STATE.sessionId = 'session-a';
  STATE.epoch = 4;
  STATE.transcript = [entry];

  requestTurnDeletion(entry, { isConnected: true, disabled: false });
  assert.equal(globalThis.__ctxkitDelete.confirmation.cancel, 'Cancel');
  assert.deepEqual(globalThis.__ctxkitDelete.calls, [], 'opening or cancelling confirmation must not call delete');
  assert.equal(globalThis.__ctxkitDelete.loads, 0, 'opening confirmation must not refresh');
  await globalThis.__ctxkitDelete.confirmation.accept();
  assert.deepEqual(globalThis.__ctxkitDelete.calls, [[EDIT_METHODS.deleteTurn, {
    sessionId: 'session-a', seq: 17, id: 'wire-u', expected: 'question'
  }]]);
  assert.equal(globalThis.__ctxkitDelete.loads, 1, 'Host success must refresh exactly once');

  globalThis.__ctxkitDelete.confirmation = null;
  globalThis.__ctxkitDelete.running = true;
  requestTurnDeletion(entry);
  assert.equal(globalThis.__ctxkitDelete.confirmation, null, 'running generation opened deletion UI');
  assert.equal(globalThis.__ctxkitDelete.notices.at(-1)[0], 'Generation is running. Stop generation before editing or deleting history.');

  globalThis.__ctxkitDelete.running = false;
  globalThis.__ctxkitDelete.answer = { ok: false, reason: 'generation won the race' };
  requestTurnDeletion(entry);
  const before = STATE.transcript;
  await globalThis.__ctxkitDelete.confirmation.accept();
  assert.equal(globalThis.__ctxkitDelete.loads, 1, 'Host refusal must not refresh or hide anything');
  assert.equal(STATE.transcript, before, 'Host refusal optimistically replaced the transcript');
  assert.match(globalThis.__ctxkitDelete.notices.at(-1)[0], /generation won the race/u);
  delete globalThis.__ctxkitDelete;
});

ok('assistant deletion waits for confirmation and sends the exact message payload', async () => {
  globalThis.__ctxkitDeleteMessage = { running: false, confirmation: null, calls: [], loads: 0, notices: [], answer: { ok: true } };
  const { STATE, requestMessageDeletion } = panelConsts(injectEditor(PAGE), [
    'STATE', 'entryFor', 'canDeleteMessage', 'requestMessageDeletion'
  ], [
    'const syncSession = () => {};',
    'const generationRunning = () => globalThis.__ctxkitDeleteMessage.running;',
    'const say = (message, kind) => globalThis.__ctxkitDeleteMessage.notices.push([message, kind]);',
    'const leaveDraft = () => true;',
    'const askConfirmation = (title, message, action, accept, cancel) => { globalThis.__ctxkitDeleteMessage.confirmation = { title, message, action, accept, cancel }; };',
    'const call = async (method, payload) => { globalThis.__ctxkitDeleteMessage.calls.push([method, payload]); return globalThis.__ctxkitDeleteMessage.answer; };',
    'const isCurrent = () => true;',
    'const load = async () => { globalThis.__ctxkitDeleteMessage.loads += 1; return true; };',
    'const STOP_GENERATION = "Generation is running. Stop generation before editing or deleting history.";'
  ].join('\n'));
  const entry = { type: 'assistant/message', id: 'wire-a', seq: 18, turn: 3, step: 2, text: 'answer' };
  STATE.sessionId = 'session-a';
  STATE.epoch = 4;
  STATE.transcript = [entry];

  requestMessageDeletion(entry, { isConnected: true, disabled: false });
  assert.equal(globalThis.__ctxkitDeleteMessage.confirmation.action, 'Delete message');
  assert.deepEqual(globalThis.__ctxkitDeleteMessage.calls, [], 'opening assistant confirmation called delete');
  await globalThis.__ctxkitDeleteMessage.confirmation.accept();
  assert.deepEqual(globalThis.__ctxkitDeleteMessage.calls, [[EDIT_METHODS.deleteMessage, {
    sessionId: 'session-a', seq: 18, id: 'wire-a', expected: 'answer'
  }]]);
  assert.equal(globalThis.__ctxkitDeleteMessage.loads, 1, 'Host success must refresh exactly once');

  globalThis.__ctxkitDeleteMessage.answer = { ok: false, reason: 'stale assistant' };
  requestMessageDeletion(entry);
  await globalThis.__ctxkitDeleteMessage.confirmation.accept();
  assert.equal(globalThis.__ctxkitDeleteMessage.loads, 1, 'Host refusal must not refresh or hide anything');
  assert.match(globalThis.__ctxkitDeleteMessage.notices.at(-1)[0], /stale assistant/u);
  delete globalThis.__ctxkitDeleteMessage;
});

ok('a rewritten row requires exact verified provenance, never an id suffix guess', () => {
  const script = injectEditor(PAGE);
  const { entryFor } = panelConsts(script, ['entryFor']);
  const entries = [{ type: 'user/message', id: 'replacement', originId: 'aaa', seq: 19 },
    { type: 'user/message', id: 'bbb', originId: 'bbb', seq: 9 }];
  assert.equal(entryFor(entries, 'bbb').seq, 9, 'an exact origin id must match');
  assert.equal(entryFor(entries, 'aaa').seq, 19, 'verified provenance must survive a replacement id and seq');
  assert.equal(entryFor(entries, 'ccc'), undefined, 'an unknown id must match nothing');
  assert.equal(entryFor([{ type: 'user/message', id: 'z-edited' }], 'z'), undefined, 'even a unique suffix is not provenance');
  assert.equal(entryFor([{ type: 'user/message', id: 'z', originId: 'other' }], 'z'), undefined, 'current id cannot override verified origin');
  assert.equal(entryFor([entries[0], { ...entries[0], seq: 20 }], 'aaa'), undefined, 'duplicate provenance must refuse');
});

ok('a reply is matched by position, and only when exactly one reply claims it', () => {
  const script = injectEditor(PAGE);
  const { entryFor, targetOf } = panelConsts(script, ['flowBody', 'messageIdOf', 'stepPrefix', 'stepOf', 'targetOf', 'entryFor']);
  const reply = { id: 'r1', seq: 15, type: 'assistant/message', editable: true, turn: 1, step: 1 };
  const other = { id: 'r2', seq: 21, type: 'assistant/message', editable: true, turn: 2, step: 1 };
  const user = { id: 'u1', originId: 'u1', seq: 19, type: 'user/message', editable: true, userIndex: 0 };
  const entries = [user, reply, other];
  // The row names a position; the entry that carries it is the one the panel edits.
  assert.equal(entryFor(entries, targetOf(flowRow('14:assistant-step1:1', 'assistant-step'))).seq, 15,
    'the assistant row no longer finds its reply');
  assert.equal(entryFor(entries, targetOf(flowRow('14:assistant-step2:1', 'assistant-step'))).seq, 21,
    'a second turn must find its own reply');
  // A user row still resolves through its id, which is what keeps the two shapes apart.
  assert.equal(entryFor(entries, targetOf(flowRow('13:input-messageu1'))).seq, 19,
    'a user row stopped resolving by id');
  // Everything below must match NOTHING: a collision, a reply without a position, a
  // row that names only a turn, and a row that names nothing at all.
  const twins = [reply, { ...reply, id: 'r3', seq: 30 }];
  assert.equal(entryFor(twins, { turn: 1, step: 1 }), undefined, 'two replies in one step must make the match refuse, not guess');
  assert.equal(entryFor([{ ...reply, turn: undefined, step: undefined }], { turn: 1, step: 1 }), undefined,
    'a reply whose event carried no position must not be matched at 0:0');
  assert.equal(entryFor(entries, targetOf(flowRow('14:assistant-step1', 'assistant-step'))), undefined,
    'a truncated reply key must match nothing');
  assert.equal(entryFor(entries, targetOf(flowRow(null))), undefined, 'a row with no key must match nothing');
  assert.equal(entryFor(entries, undefined), undefined, 'an absent target must match nothing');
});

/**
 * Drive one mounted route the way the browser does: one JSON POST, the answer parsed.
 *
 * The envelope and the path are the connection's own protocol — the method rides in the
 * PATH as well as in the envelope, and a request whose two halves disagree is refused as a
 * bad request — so a test that speaks it is testing the contract the panel speaks.
 *
 * @param route - a route registered through `webServer.register`.
 * @returns a function of `(method, payload)` answering `{ status, body }`.
 */
function routeAnswer(route) {
  return async (method, payload) => {
    const body = JSON.stringify({ type: 'client-request', rpcId: '1', method, payload });
    let destroyed = false;
    const request = {
      url: `${EDIT_CHANNEL}/${method}`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      on(event, handler) {
        if (event === 'data') {
          const bytes = Buffer.from(body);
          for (let at = 0; at < bytes.length && !destroyed; at += 16384) handler(bytes.subarray(at, at + 16384));
        }
        if (event === 'end' && !destroyed) handler();
        return this;
      },
      destroy() { destroyed = true; }
    };
    let status = 0;
    let text = '';
    const response = {
      writeHead(code) { status = code; return this; },
      end(chunk) { if (typeof chunk === 'string') text += chunk; }
    };
    await route.handler(request, response);
    return { status, body: status === 200 ? JSON.parse(text) : text, destroyed };
  };
}

/**
 * The smallest DOM `decorateTranscript` needs, so that pencils can be COUNTED.
 *
 * The decorator is browser code and this suite has no browser, but the rule under test is
 * "one pencil per editable target" — and a rule about how many elements were appended is
 * only really tested by appending them. Every method here is the stub the decorator calls
 * and nothing else about the page is modelled.
 *
 * @param tag - the element name.
 * @returns a fake element.
 */
function fakeElement(tag) {
  const element = {
    tagName: String(tag).toUpperCase(),
    children: [],
    attributes: new Map(),
    listeners: new Map(),
    shadowRoot: null,
    parentNode: null,
    isConnected: false,
    style: { position: '' },
    className: '',
    textContent: '',
    title: '',
    type: '',
    setAttribute(name, value) { element.attributes.set(name, String(value)); },
    getAttribute(name) { return element.attributes.has(name) ? element.attributes.get(name) : null; },
    hasAttribute(name) { return element.attributes.has(name); },
    removeAttribute(name) { element.attributes.delete(name); },
    closest() { return null; },
    append(...nodes) {
      for (const node of nodes) {
        node.parentNode = element;
        node.isConnected = true;
        element.children.push(node);
      }
    },
    remove() {
      if (element.parentNode === null) return;
      const at = element.parentNode.children.indexOf(element);
      if (at >= 0) element.parentNode.children.splice(at, 1);
      element.parentNode = null;
      element.isConnected = false;
    },
    addEventListener(name, handler) {
      element.listeners.set(name, [...(element.listeners.get(name) ?? []), handler]);
    },
    dispatch(name) {
      for (const handler of element.listeners.get(name) ?? []) {
        handler({ preventDefault() {}, stopPropagation() {} });
      }
    },
    attachShadow() {
      element.shadowRoot = fakeElement('#shadow');
      element.shadowRoot.parentNode = element;
      return element.shadowRoot;
    },
    querySelectorAll(selector) {
      if (selector.includes('data-ctxkit-pencil')) {
        return element.children.filter((child) => child.getAttribute('data-ctxkit-pencil') !== null);
      }
      const attribute = /^\[([^\]]+)\]$/u.exec(selector)?.[1];
      if (attribute) return element.children.filter((child) => child.getAttribute(attribute) !== null);
      return [];
    },
    querySelector(selector) {
      return element.querySelectorAll(selector)[0] ?? null;
    }
  };
  return element;
}

/** A linked fake DOM for display-projection checks that need native sibling identity. */
function linkedElement(tag, classes = [], attributes = {}) {
  const attrs = new Map(Object.entries(attributes));
  const values = new Map();
  const priorities = new Map();
  const connect = (node, connected) => {
    node.isConnected = connected;
    for (const child of node.childNodes ?? []) connect(child, connected);
  };
  const detach = (node) => {
    const parent = node.parentNode;
    if (!parent) return;
    const childAt = parent.childNodes.indexOf(node);
    if (childAt >= 0) parent.childNodes.splice(childAt, 1);
    const elementAt = parent.children.indexOf(node);
    if (elementAt >= 0) parent.children.splice(elementAt, 1);
    node.parentNode = null;
    node.parentElement = null;
    connect(node, false);
  };
  const element = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    children: [],
    childNodes: [],
    parentNode: null,
    parentElement: null,
    isConnected: false,
    classList: [...classes],
    className: classes.join(' '),
    attributes: attrs,
    listeners: new Map(),
    shadowRoot: null,
    textContent: '',
    type: '',
    disabled: false,
    style: {
      setProperty(name, value, priority = '') { values.set(name, String(value)); priorities.set(name, String(priority)); },
      getPropertyValue: (name) => values.get(name) ?? '',
      getPropertyPriority: (name) => priorities.get(name) ?? '',
      removeProperty(name) { values.delete(name); priorities.delete(name); }
    },
    setAttribute(name, value) { attrs.set(name, String(value)); },
    getAttribute: (name) => attrs.has(name) ? attrs.get(name) : null,
    hasAttribute: (name) => attrs.has(name),
    removeAttribute(name) { attrs.delete(name); },
    matches(selector) {
      return selector.split(',').some((part) => {
        const item = part.trim();
        if (item === '[class]') return element.classList.length > 0;
        const valued = /^\[([^=\]]+)="([^"]*)"\]$/u.exec(item);
        if (valued) return attrs.get(valued[1]) === valued[2];
        const plain = /^\[([^\]]+)\]$/u.exec(item);
        if (plain) return attrs.has(plain[1]);
        return item.toUpperCase() === element.tagName;
      });
    },
    closest(selector) {
      for (let current = element; current; current = current.parentElement) {
        if (current.matches(selector)) return current;
      }
      return null;
    },
    contains(candidate) {
      if (candidate === element) return true;
      return element.childNodes.some((child) => child.nodeType === 1 && child.contains(candidate));
    },
    append(...nodes) {
      for (const node of nodes) {
        detach(node);
        node.parentNode = element;
        node.parentElement = element;
        element.childNodes.push(node);
        if (node.nodeType === 1) element.children.push(node);
        connect(node, element.isConnected);
      }
    },
    after(...nodes) {
      const parent = element.parentNode;
      if (!parent) return;
      let childAt = parent.childNodes.indexOf(element) + 1;
      let elementAt = parent.children.indexOf(element) + 1;
      for (const node of nodes) {
        detach(node);
        node.parentNode = parent;
        node.parentElement = parent;
        parent.childNodes.splice(childAt++, 0, node);
        if (node.nodeType === 1) parent.children.splice(elementAt++, 0, node);
        connect(node, parent.isConnected);
      }
    },
    remove() { detach(element); },
    replaceChildren(...nodes) {
      for (const child of [...element.childNodes]) detach(child);
      element.append(...nodes);
    },
    addEventListener(name, handler) { element.listeners.set(name, [...(element.listeners.get(name) ?? []), handler]); },
    attachShadow() {
      element.shadowRoot = linkedElement('#shadow');
      element.shadowRoot.parentNode = element;
      element.shadowRoot.parentElement = element;
      return element.shadowRoot;
    },
    querySelectorAll(selector) {
      const found = [];
      const visit = (parent) => {
        for (const child of parent.children) {
          if (child.matches(selector)) found.push(child);
          visit(child);
        }
      };
      visit(element);
      return found;
    },
    querySelector(selector) { return element.querySelectorAll(selector)[0] ?? null; }
  };
  Object.defineProperties(element, {
    nextSibling: { get: () => {
      const at = element.parentNode?.childNodes.indexOf(element) ?? -1;
      return at >= 0 ? element.parentNode.childNodes[at + 1] ?? null : null;
    } },
    innerHTML: { get: () => element.childNodes.map((child) => child.textContent ?? '').join('') }
  });
  return element;
}

/** The button inside one pencil's shadow root. */
function pinButton(pin) {
  return pin.shadowRoot.children.find((child) => child.tagName === 'BUTTON');
}

/**
 * A live session with one reply of the given blocks, and the panel's own route on top.
 *
 * The route is the REAL handler — the same one the browser reaches — so what the commit
 * checks below exercise is the shipped path and not a copy of it, and the session is a real
 * `dsh-session` one, because the entry the commit resolves has to come out of the real
 * surface fold. A wire store is published for the session the way the plugin publishes it
 * (`dcp.js`), so `commitValue` finds the store it writes to.
 *
 * @param replyBlocks - the content of the assistant reply.
 * @param options - `id` for the session and `source` for the reply message.
 * @returns the session id, the reply entry, the wire store and the route driver.
 */
async function mountedPanel(replyBlocks, options = {}) {
  const context = new Context();
  context.provide('llm', llm);
  const sessions = new SessionStore(context);
  let session = sessions.create(SessionId(options.id ?? 'edit-gui-commit'), { meta: { cwd: process.cwd() } });
  for (let attempt = 0; attempt < 50 && sessions.get(session.id) === undefined; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  session.append('turn/start', { turn: 1 });
  session.append('user/message', llm.createUserMessage({
    content: [{ type: 'text', text: 'QUESTION' }],
    source: { kind: 'user' }
  }), { surfaceOp: 'append' });
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    stream: [],
    message: llm.createAssistantMessage({
      content: replyBlocks,
      source: options.source ?? { kind: 'model', provider: 'stub', model: 'stub' }
    })
  }, { surfaceOp: 'append' });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const routes = [];
  const ctx = {
    get: (key) => (key === 'sessions'
      ? { get: (id) => (String(id) === String(session.id) ? session : undefined) }
      : key === 'agents'
        ? options.hostAgent === undefined
          ? undefined
          : { get: (id) => (String(id) === String(session.id) ? options.hostAgent : undefined) }
        : key === 'connection'
          ? { rpc: { handle: () => {} } }
          : key === 'webServer'
            ? { register: (route) => { routes.push(route); return () => {}; }, tapIndex: () => () => {} }
            : undefined),
    effect: (body) => body()
  };
  const engine = {
    ctx: { get: (key) => key === 'agent' ? options.agent : undefined },
    dcpConfig: { editor: { enabled: true, ...options.editor } }
  };
  installEditGui(ctx, engine);
  assert.equal(routes.length, 1, 'the commit path needs the panel route to be mounted');
  const wire = createEditStore({ restore: false });
  publishEditStore(String(session.id), wire);
  const reply = editableIndex(session).find((entry) => entry.type === 'assistant/message');
  const user = editableIndex(session).find((entry) => entry.type === 'user/message');
  return {
    sessionId: String(session.id), get session() { return session; }, reply, user, wire, engine, answer: routeAnswer(routes[0]),
    reload() { session = Session.create(session.id, session.snapshotEvents()); }
  };
}

ok('the list identifies only direct human messages as turn-deletion anchors', async () => {
  const panel = await mountedPanel([{ type: 'text', text: 'ANSWER' }], { id: 'edit-gui-direct-user' });
  const value = (await panel.answer(EDIT_METHODS.list, { sessionId: panel.sessionId })).body.result.value;
  const user = value.transcript.find((entry) => entry.type === 'user/message');
  const reply = value.transcript.find((entry) => entry.type === 'assistant/message');
  assert.equal(user.sourceKind, 'user');
  assert.equal(user.directUser, true);
  assert.equal(reply.directUser, false);
});

ok('the delete route tombstones one complete human turn without mutating the log', async () => {
  const panel = await mountedPanel([{ type: 'text', text: 'ANSWER' }], { id: 'edit-gui-delete-turn' });
  const before = panel.session.snapshotEvents();
  const removed = await panel.answer(EDIT_METHODS.deleteTurn, {
    sessionId: panel.sessionId, seq: panel.user.seq, id: panel.user.id, expected: 'QUESTION'
  });
  assert.equal(removed.body.result.value.ok, true, String(removed.body.result.value.reason));
  assert.equal(panel.session.snapshotEvents().length, before.length, 'turn deletion must not mutate the session log');
  assert.equal(panel.wire.editsFor(panel.sessionId).at(-1)?.kind, 'delete-turn');
  const listed = (await panel.answer(EDIT_METHODS.list, { sessionId: panel.sessionId })).body.result.value;
  assert.deepEqual(listed.transcript, [], 'the deleted user message and its assistant reply must be absent from effective history');
  assert.deepEqual(listed.hidden.map((entry) => entry.type), ['user/message', 'assistant/message'],
    'the browser was not told which native Chat rows belong to the deleted turn');
  assert.deepEqual(listed.hidden.map((entry) => entry.deletedTurn), [true, true],
    'the browser cannot distinguish a complete deleted turn from a future partial hide');
  assert.deepEqual(listed.hidden.map((entry) => entry.directUser), [true, false],
    'the hidden turn lost its direct-human boundary');
});

ok('the delete-message route tombstones exactly one assistant envelope without mutating the log', async () => {
  const panel = await mountedPanel([{ type: 'text', text: 'ANSWER' }], { id: 'edit-gui-delete-message' });
  const before = panel.session.snapshotEvents();
  const removed = await panel.answer(EDIT_METHODS.deleteMessage, {
    sessionId: panel.sessionId, seq: panel.reply.seq, id: panel.reply.id, expected: 'ANSWER'
  });
  assert.equal(removed.body.result.value.ok, true, String(removed.body.result.value.reason));
  assert.deepEqual(panel.session.snapshotEvents(), before, 'assistant deletion must not mutate the session log');
  const expectedEdit = {
    kind: 'delete-message',
    id: `${panel.sessionId.slice(0, 8)}-m1`,
    parent: null,
    basis: 'effective',
    before: 'ANSWER',
    texts: ['ANSWER'],
    members: [{ id: panel.reply.id, role: 'assistant', sourceKind: 'model', blocks: [{ type: 'text' }] }],
    next: null,
    at: 1,
    anchor: { index: 1, role: 'assistant', blocks: [{ type: 'text' }] },
    messageId: panel.reply.id
  };
  assert.deepEqual(panel.wire.editsFor(panel.sessionId), [expectedEdit]);
  const restored = createEditStore();
  assert.deepEqual(restored.editsFor(panel.sessionId), [expectedEdit], 'message tombstone was not durable');
  publishEditStore(panel.sessionId, restored);
  panel.reload();
  const reloaded = panel.session.snapshotEvents();
  assert.deepEqual(reloaded.slice(0, before.length), before, 'reload changed an original session event');
  assert.deepEqual(reloaded.slice(before.length).map((event) => event.type), ['session/end-seed'],
    'reload appended something other than the Session seed terminator');
  const listed = (await panel.answer(EDIT_METHODS.list, { sessionId: panel.sessionId })).body.result.value;
  assert.deepEqual(listed.transcript.map((entry) => entry.type), ['user/message'],
    'assistant deletion removed the direct-human message too');
  assert.equal(listed.hidden.length, 1, 'a partial deletion hid more than its exact assistant envelope');
  assert.equal(listed.hidden[0].type, 'assistant/message');
  assert.equal(listed.hidden[0].id, panel.reply.id);
  assert.equal(listed.hidden[0].deletedMessage, true, 'the exact assistant tombstone was not identified');
  assert.equal(listed.hidden[0].deletedTurn, false, 'a partial assistant deletion was classified as a whole turn');
});

ok('the delete-message route refuses stale assistant identity and content', async () => {
  const panel = await mountedPanel([{ type: 'text', text: 'ANSWER' }], { id: 'edit-gui-delete-message-stale' });
  const before = panel.session.snapshotEvents();
  for (const changed of [
    { id: 'different-message', expected: 'ANSWER' },
    { id: panel.reply.id, expected: 'CHANGED' }
  ]) {
    const removed = await panel.answer(EDIT_METHODS.deleteMessage, {
      sessionId: panel.sessionId, seq: panel.reply.seq, ...changed
    });
    assert.equal(removed.body.result.value.ok, false, 'stale assistant deletion was accepted');
  }
  assert.deepEqual(panel.session.snapshotEvents(), before, 'a stale deletion mutated the session log');
  assert.equal(panel.wire.editsFor(panel.sessionId).length, 0, 'a stale deletion wrote an overlay');
  assert.deepEqual(createEditStore().editsFor(panel.sessionId), [], 'a stale deletion persisted an overlay');
});

ok('the Host refuses edit and both deletion kinds while the agent is running', async () => {
  const agent = { status: 'running' };
  const panel = await mountedPanel([{ type: 'text', text: 'ANSWER' }], {
    id: 'edit-gui-idle-guard', agent, editor: { requireIdle: true }
  });
  const before = panel.session.snapshotEvents();
  const payload = { sessionId: panel.sessionId, seq: panel.user.seq, id: panel.user.id, expected: 'QUESTION' };
  const edited = await panel.answer(EDIT_METHODS.commit, { ...payload, text: 'CHANGED' });
  const removed = await panel.answer(EDIT_METHODS.deleteTurn, payload);
  const replyRemoved = await panel.answer(EDIT_METHODS.deleteMessage, {
    sessionId: panel.sessionId, seq: panel.reply.seq, id: panel.reply.id, expected: 'ANSWER'
  });
  for (const result of [edited, removed, replyRemoved]) {
    assert.equal(result.body.result.value.ok, false);
    assert.match(String(result.body.result.value.reason), /stop generation/i);
  }
  assert.equal(panel.wire.editsFor(panel.sessionId).length, 0);
  assert.deepEqual(panel.session.snapshotEvents(), before, 'a generation guard failure mutated the session log');
});

ok('the Host guard resolves the running agent from the exact session registry', async () => {
  const panel = await mountedPanel([{ type: 'text', text: 'ANSWER' }], {
    id: 'edit-gui-registry-idle-guard', hostAgent: { status: 'running' }, editor: { requireIdle: true }
  });
  const removed = await panel.answer(EDIT_METHODS.deleteTurn, {
    sessionId: panel.sessionId, seq: panel.user.seq, id: panel.user.id, expected: 'QUESTION'
  });
  const replyRemoved = await panel.answer(EDIT_METHODS.deleteMessage, {
    sessionId: panel.sessionId, seq: panel.reply.seq, id: panel.reply.id, expected: 'ANSWER'
  });
  for (const result of [removed, replyRemoved]) {
    assert.equal(result.body.result.value.ok, false, 'a direct RPC bypassed the Host generation guard');
    assert.match(String(result.body.result.value.reason), /stop generation/i);
  }
  assert.equal(panel.wire.editsFor(panel.sessionId).length, 0, 'a refused deletion wrote an overlay');
});

ok('requireIdle does not block a standalone Host editor with no agent service', async () => {
  const panel = await mountedPanel([{ type: 'text', text: 'ANSWER' }], {
    id: 'edit-gui-idle-absent', editor: { requireIdle: true }
  });
  const removed = await panel.answer(EDIT_METHODS.deleteTurn, {
    sessionId: panel.sessionId, seq: panel.user.seq, id: panel.user.id, expected: 'QUESTION'
  });
  assert.equal(removed.body.result.value.ok, true, String(removed.body.result.value.reason));
});

/* -------------------------------------------------- the targets of a message */

console.log('\nthe targets of a message (one pencil per thing it says)');

const blockText = (value) => ({ type: 'text', text: value });
const blockReasoning = (value) => ({ type: 'reasoning', text: value });

/**
 * An entry as `editableIndex` builds one for an assistant reply.
 *
 * `text` is filled the way the engine fills it (`textOfMessage`): the text blocks joined,
 * and — only when there is no text block at all — the thinking, which is then the only
 * thing the reply says. A fixture that joined both, or that left the thinking out, would
 * describe a message the engine never produces.
 *
 * `source` travels to the MESSAGE, not to the entry: a signature that matters to the rule
 * lives beside the message (`message.source.replayState`), so a fixture that put it on the
 * entry would test a reply nobody could sign.
 */
const replyEntry = (content, extra = {}) => {
  const { source, ...rest } = extra;
  const joined = (kind) => content.filter((block) => block.type === kind).map((block) => block.text ?? '').join('');
  const texts = joined('text');
  return {
    seq: 15,
    type: 'assistant/message',
    role: 'assistant',
    id: '5f013e03-1300-4e89-91cb-ac5f790669d5',
    index: 3,
    turn: 1,
    step: 1,
    text: texts.length > 0 ? texts : joined('reasoning'),
    blocks: content.length,
    message: { id: '5f013e03', role: 'assistant', content, ...(source === undefined ? {} : { source }) },
    ...rest
  };
};

/** A reply whose thinking is signed by the provider, the shape `dsh-llm-pi-ai` produces. */
const signedSource = {
  kind: 'model',
  provider: 'pi',
  model: 'claude',
  replayState: {
    response: { kind: 'pi-ai', version: 2, api: 'anthropic-messages', provider: 'pi', model: 'claude', stopReason: 'stop' },
    blocks: [{ type: 'reasoning', thinkingSignature: 'SIG-over-the-old-thinking' }]
  }
};

ok('a reply of [reasoning, text] offers two targets: the thinking and the answer', () => {
  const shown = panelEntry(replyEntry([blockReasoning('THOUGHTS'), blockText('ANSWER')]));
  assert.equal(shown.targets.length, 2, 'the thinking of such a reply is still unreachable');
  assert.deepEqual(
    shown.targets.map((target) => [target.at, target.kind, target.label]),
    [[0, 'reasoning', 'Thinking'], [1, 'text', 'Answer']],
    'the targets are not the two blocks of the reply, in order'
  );
  assert.deepEqual(shown.targets.map((target) => target.text), ['THOUGHTS', 'ANSWER'], 'a target quotes the wrong text');
  assert.deepEqual(shown.targets.map((target) => target.chars), [8, 6], 'the character counts do not match the blocks');
  assert.deepEqual(shown.targets.map((target) => target.signed), [false, false], 'unsigned thinking was marked signed');
  assert.deepEqual(shown.targets.map((target) => target.editable), [true, true], 'an editable target was refused');
  assert.deepEqual(shown.targets.map((target) => target.reason), [undefined, undefined], 'an offered target carries a refusal');
  // The message-level answer is unchanged by any of this: it is still about the TEXT block.
  assert.equal(shown.editable, true);
  assert.equal(shown.branch, 'wire');
  assert.equal(shown.text, 'ANSWER');
  console.log(`       targets: ${JSON.stringify(shown.targets)}`);
});

ok('the thinking-only reply offers its thinking, as it always did', () => {
  const shown = panelEntry(replyEntry([blockReasoning('THOUGHTS ONLY')]));
  assert.equal(shown.targets.length, 1);
  assert.deepEqual(shown.targets[0].at, 0);
  assert.equal(shown.targets[0].label, 'Thinking');
  assert.equal(shown.targets[0].editable, true);
});

ok('a plain user message offers its text, once', () => {
  const shown = panelEntry(userEntry([blockText('plain user text')]));
  assert.deepEqual(shown.targets, [{
    at: 0,
    kind: 'text',
    label: 'Message',
    text: 'plain user text',
    chars: 15,
    signed: false,
    editable: true,
    reason: undefined,
    edited: false,
    changed: false,
    editStatus: 'none'
  }]);
});

ok('a message that says nothing editable offers no target at all', () => {
  const shown = panelEntry(replyEntry([{ type: 'tool-call', id: 't1', name: 'read', arguments: '{"filePath":"a.js"}' }]));
  assert.deepEqual(shown.targets, [], 'a tool call is not an answer');
  assert.equal(shown.editable, false);
});

ok('a signed thinking block is offered, refused, and says why', () => {
  const entry = replyEntry([blockReasoning('SIGNED THINKING')], { source: signedSource });
  const shown = panelEntry(entry);
  assert.equal(shown.targets.length, 1, 'the thinking is not offered at all');
  assert.equal(shown.targets[0].signed, true, 'a signed thinking block is not marked signed');
  assert.equal(shown.targets[0].editable, false, 'a signed thinking block must not be offered as editable');
  // The refusal is the SHARED one: the same sentence a commit would answer with, which
  // contains the wording `signedReasoningRefusal` produces rather than a new invention.
  const shared = signedReasoningRefusal(entry.message, 0);
  assert.equal(typeof shared, 'string', 'the fixture does not carry a signature at all');
  assert.ok(String(shown.targets[0].reason).includes(shared), `the refusal does not quote the shared one: ${String(shown.targets[0].reason)}`);
  assert.equal(shown.editable, false, 'the message-level answer must still refuse signed thinking');
  assert.match(String(shown.reason), /signature|signed/u);
});

ok('a signed thinking does not hide the answer beside it', () => {
  // The two questions are DIFFERENT, and this is the shape that shows it: the reply as a
  // whole is editable (through its text), its thinking is not.
  const shown = panelEntry(replyEntry([blockReasoning('SIGNED THINKING'), blockText('ANSWER')], { source: signedSource }));
  assert.equal(shown.editable, true, 'the answer of such a reply was refused');
  assert.deepEqual(shown.targets.map((target) => [target.at, target.editable]), [[0, false], [1, true]]);
  assert.deepEqual(shown.targets.map((target) => target.signed), [true, false]);
  assert.equal(shown.targets[1].reason, undefined);
});

ok('the rule asked about the DEFAULT block is the rule with no block at all', () => {
  // `editability(entry)` is what every existing caller and check is written against, so the
  // second argument must not be able to change its answer, and the block it picks has to be
  // the one the commit would rewrite.
  const fixtures = [
    userEntry([blockText('plain user text')]),
    replyEntry([blockText('ok')]),
    replyEntry([blockReasoning('THOUGHTS ONLY')]),
    replyEntry([blockReasoning('SIGNED THINKING')], { source: signedSource }),
    replyEntry([blockReasoning('THOUGHTS'), blockText('ANSWER')])
  ];
  for (const entry of fixtures) {
    assert.deepEqual(editability(entry), editability(entry, undefined), 'a second argument changed the answer');
  }
  const both = replyEntry([blockReasoning('THOUGHTS'), blockText('ANSWER')]);
  assert.deepEqual(editability(both, 1), editability(both), 'the default block is not the text block');
  // And asking about the thinking is a question the old rule could not be asked at all.
  assert.deepEqual(editability(both, 0), { ok: true, branch: 'wire' }, 'the thinking of a mixed reply is not editable');
  // A block the message does not have is refused, in its own words, at either branch.
  assert.match(String(editability(both, 9).reason), /no block 9/u);
  assert.match(String(editability(userEntry([blockText('x')]), 9).reason), /no block 9/u);
  assert.match(String(editability(userEntry([blockText('x'), { type: 'image', source: {} }]), 1).reason), /image block/u);
});

ok('unsigned Thinking is discovered through only the verified public wrapper', () => {
  const make = (classes = [], attributes = {}) => {
    const attrs = new Map(Object.entries(attributes));
    const node = {
      children: [], classList: classes,
      getAttribute: (name) => attrs.has(name) ? attrs.get(name) : null,
      hasAttribute: (name) => attrs.has(name),
      matches(selector) {
        if (selector === '[data-variant="think"]') return attrs.get('data-variant') === 'think';
        if (selector === '[data-tool], [data-variant]') return attrs.has('data-tool') || attrs.has('data-variant');
        return false;
      },
      append(...children) { node.children.push(...children); }
    };
    return node;
  };
  const { textLayout } = panelConsts(injectEditor(PAGE), ['targetsOf', 'hasToken', 'textLayout']);
  const entry = panelEntry(replyEntry([blockReasoning('THOUGHTS'), blockText('ANSWER')]));

  for (const expanded of [false, true]) {
    const row = make();
    const slot = make([], { 'data-slot': 'conversation.chat.node' });
    const root = make(['_root_hash_1']);
    const body = make(['_body_hash_1']);
    const processReasoning = make();
    const think = make([], { 'data-variant': 'think', 'data-state': expanded ? 'open' : 'closed', ...(expanded ? { 'data-expanded': '' } : {}) });
    const disclosure = make(['DisclosureRow_root_hash']);
    think.append(disclosure);
    if (expanded) think.append(make(['ReasoningRow_thinkBody_hash']));
    processReasoning.append(think);
    const markdown = make(['_markdown_hash_1']);
    body.append(processReasoning, markdown);
    root.append(body);
    slot.append(root);
    row.append(slot);
    const childCount = think.children.length;
    const state = think.getAttribute('data-state');
    const layout = textLayout(row, entry);
    assert.deepEqual(layout.thinks, [think], (expanded ? 'expanded' : 'collapsed') + ' Thinking was not found');
    assert.deepEqual(layout.containers, [markdown], 'the answer container changed while finding Thinking');
    assert.equal(layout.thoughts.length, 1, 'the unsigned reasoning target was not retained');
    assert.equal(think.children.length, childCount, 'Thinking disclosure children were mutated');
    assert.equal(think.getAttribute('data-state'), state, 'Thinking disclosure state was mutated');
    assert.equal(think.hasAttribute('data-expanded'), expanded, 'Thinking was toggled during discovery');
  }

  const row = make();
  const slot = make([], { 'data-slot': 'conversation.chat.node' });
  const root = make(['AssistantMarkdown_root_hash']);
  const body = make(['AssistantMarkdown_body_hash']);
  const outer = make();
  const unverifiedInner = make();
  const nestedThink = make([], { 'data-variant': 'think' });
  unverifiedInner.append(nestedThink);
  outer.append(unverifiedInner);
  body.append(outer);
  root.append(body);
  slot.append(root);
  row.append(slot);
  assert.deepEqual(textLayout(row, entry).thinks, [], 'an arbitrary descendant search crossed an unverified wrapper');
});

ok('edited Thinking projects through one stable wrapper without changing disclosure state', () => {
  globalThis.__ctxkitProjectionDocument = {
    createElement: (tag) => linkedElement(tag),
    createTextNode: (text) => ({
      nodeType: 3, textContent: String(text), childNodes: [], parentNode: null, parentElement: null, isConnected: false
    })
  };
  const { STATE, projections, projectRow } = panelConsts(injectEditor(PAGE), [
    'STATE', 'targetsOf', 'labelOf', 'badgeText', 'hasToken', 'embeddedContent', 'restoreDisplay',
    'restoreProjection', 'textLayout', 'projections', 'projectRow'
  ], 'const document = globalThis.__ctxkitProjectionDocument;');
  STATE.sessionId = 'test-session';
  const entry = {
    type: 'assistant/message', seq: 17, id: 'reply-17', editable: true,
    targets: [{ at: 0, kind: 'reasoning', label: 'Thinking', text: 'EDITED THINKING\\nSECOND', changed: true, editable: true }]
  };
  const connectTree = (node) => {
    node.isConnected = true;
    for (const child of node.childNodes ?? []) connectTree(child);
  };
  for (const expanded of [false, true]) {
    const row = linkedElement('article', [], { 'data-chat-flow-key': '14:assistant-step8:2' });
    const slot = linkedElement('div', [], { 'data-slot': 'conversation.chat.node' });
    const root = linkedElement('div', ['_root_hash_1']);
    const body = linkedElement('div', ['_body_hash_1']);
    const processReasoning = linkedElement('div');
    const think = linkedElement('div', [], {
      'data-variant': 'think',
      'data-state': expanded ? 'open' : 'closed',
      ...(expanded ? { 'data-expanded': '' } : {})
    });
    const disclosure = linkedElement('div', ['_root_hash_2']);
    const summary = linkedElement('span', ['_summaryText_hash_1']);
    disclosure.append(summary);
    think.append(disclosure);
    if (expanded) think.append(linkedElement('div', ['_thinkBody_hash_1']));
    processReasoning.append(think);
    body.append(processReasoning);
    root.append(body);
    slot.append(root);
    row.append(slot);
    connectTree(row);
    const state = think.getAttribute('data-state');
    const nativeChildren = [...think.children];

    projectRow(row, entry);
    const hosts = row.querySelectorAll('[data-ctxkit-projection]');
    assert.equal(hosts.length, 1, `${expanded ? 'expanded' : 'collapsed'} Thinking got more than one projection wrapper`);
    assert.equal(projections.get(row)?.size, 1, 'one Thinking target created more than one projection record');
    assert.ok(hosts[0].shadowRoot.querySelector('button'), 'the single projection wrapper lost its copy control');
    const firstHost = hosts[0];
    projectRow(row, entry);
    assert.deepEqual(row.querySelectorAll('[data-ctxkit-projection]'), [firstHost],
      're-decoration duplicated or replaced a stable Thinking projection');
    assert.equal(think.getAttribute('data-state'), state, 'projection changed disclosure state');
    assert.equal(think.hasAttribute('data-expanded'), expanded, 'projection toggled Thinking');
    assert.deepEqual(think.children.filter((child) => !child.hasAttribute('data-ctxkit-projection')), nativeChildren,
      'projection replaced or reordered native disclosure children');
  }
  delete globalThis.__ctxkitProjectionDocument;
});

/* ------------------------------------------------------------ the two pencils */

console.log('\nthe pencil per target (the transcript is still the shell\'s)');

ok('a row draws one pencil per editable target, keyed by seq and block', () => {
  const script = injectEditor(PAGE);
  const row = fakeElement('div');
  row.setAttribute('data-chat-flow-key', '14:assistant-step1:1');
  row.setAttribute('data-chat-flow-kind', 'assistant-step');
  globalThis.__ctxkitOpened = [];
  globalThis.__ctxkitGeneration = { running: false, notices: [] };
  globalThis.__ctxkitDocument = {
    querySelectorAll: (selector) => (selector === '[data-chat-flow] > [data-chat-flow-key]' ? [row] : []),
    createTextNode: (text) => Object.assign(fakeElement('#text'), { textContent: text }),
    createElement: (tag) => fakeElement(tag)
  };
  const { STATE, decorateTranscript, pinCss } = panelConsts(script, [
    'STATE', 'targetsOf', 'labelOf', 'optionValue', 'fallbackTarget', 'FLOW_SELECTOR', 'PENCIL_ATTR', 'flowRows', 'chatRows', 'running',
    'flowBody', 'messageIdOf', 'turnOf', 'stepPrefix', 'stepOf', 'pinCss', 'parseKey', 'keyOf',
    'pointed', 'pointerOnce', 'pointerEdit', 'pinAt', 'INNER_CONTROL', 'GESTURE_GRACE',
    'hovered', 'hoverOnce', 'addPencil', 'entryFor', 'targetOf', 'deletedTurnsOf', 'deletedEntryFor', 'pinTargets', 'sameTarget',
    'projections', 'pinnedRows', 'unavailableRows', 'rowOwners', 'decorateTranscript'
  ], [
    'const document = globalThis.__ctxkitDocument;',
    'const installAffordance = () => {}; const setDeletedVisibility = () => {};',
    'const DELETE_ACTION_ATTR = "data-ctxkit-delete"; const placeDeleteAction = () => {};',
    'const generationRunning = () => globalThis.__ctxkitGeneration.running; const STOP_GENERATION = "Generation is running. Stop generation before editing or deleting history."; const say = (message, kind) => globalThis.__ctxkitGeneration.notices.push([message, kind]);',
    'const getComputedStyle = () => ({ position: "static" });',
    'const projectRow = () => {};', // Display projection is driven by the full browser regression.
    'const placePencil = () => {};', // Geometry and native anchoring are covered in Chromium.
    'const openAt = (seq, at) => { globalThis.__ctxkitOpened.push([seq, at]); };'
  ].join('\n'));

  STATE.sessionId = 'test-session';
  STATE.transcript = [panelEntry(replyEntry([blockReasoning('THOUGHTS'), blockText('ANSWER')]))];
  decorateTranscript();
  const pins = () => row.querySelectorAll(':scope > [data-ctxkit-pencil]');
  assert.equal(pins().length, 2, `a reply that thinks and answers must draw two pencils, drew ${pins().length}`);
  assert.deepEqual(pins().map((pin) => pin.getAttribute('data-ctxkit-for')), ['15:0', '15:1'],
    'the pencils are not keyed <seq>:<at>');
  // The label is the button's whole content, and that button is now the keyboard path only: the
  // pointer opens the editor on the message text itself.
  assert.deepEqual(pins().map((pin) => pinButton(pin).textContent), ['Edit thinking', 'Edit answer'],
    'the accessible name must survive even though the chip is no longer painted');
  // FALSIFICATION OF THE OLD BUTTON: it held a pencil svg before the label. The label alone is
  // the button now, so any icon element coming back fails here.
  assert.deepEqual(pins().map((pin) => pinButton(pin).children.filter((child) => child.tagName === 'SVG').length), [0, 0],
    'the chip must be its label alone; the pencil glyph must not come back');
  // FALSIFICATION OF THE VISIBLE CHIP, whatever shape it takes - first a label row below the
  // block, then a labelled chip seated on its corner, and in both the pointer was the chip. The
  // pin must now paint nothing at rest, the message text must be the way in, and the glow must
  // live on that text. These live here rather than in the stylesheet check above because that
  // check is already red on an unrelated rule and never reaches its tail.
  assert.ok(!SCRIPT.includes('PLANT_ATTR') && !SCRIPT.includes('plantLift'), 'the seated-chip placement is back');
  assert.ok(pinCss.includes('clip-path: inset(50%)'), 'the resting chip must collapse to the visually-hidden square');
  assert.ok(!pinCss.includes(':host(:hover) button'), 'the glow must not sit on the chip any more');
  assert.ok(SCRIPT.includes('pointerEdit'), 'the message text must be the pointer path');
  assert.ok(SCRIPT.includes('pin.open = open'), 'the text click and the button must share one action');
  assert.ok(SCRIPT.includes("a, button, input, textarea, select, summary, code, pre"),
    'a link, code or control inside the text must stay the shell\'s');
  assert.ok(SCRIPT.includes('isCollapsed === false'), 'a click made while text is selected must not open the editor');
  assert.ok(SCRIPT.includes('event.button !== 0'), 'a right click must not open the editor');
  assert.ok(SCRIPT.includes('data-ctxkit-affordance') && SCRIPT.includes("'[' + EDIT_ATTR + ']:hover"),
    'the hover glow must be a document rule on the marked regions');
  assert.ok(SCRIPT.includes('data-ctxkit-edit'), 'the editable regions must be marked for that rule');
  assert.ok(SCRIPT.includes('var(--dsw-alias-brand-primary'), 'the glow must use the brand token, not a new palette');
  assert.ok(pinCss.includes('min-height: 44px; min-width: 44px;'), 'the focused chip must keep its touch size');
  assert.ok(SCRIPT.includes("button.textContent = 'Edit '"), 'the chip must be its own label, not an icon plus a label');
  assert.ok(!SCRIPT.includes('button.innerHTML'), 'the removed pencil glyph markup is back');
  // SAVE AND CANCEL ARE DRAWINGS: a checkmark and a cross, with the name kept for assistive
  // technology, and the busy word still the one piece of live text in that row.
  assert.ok(SCRIPT.includes('icon(save, ') && SCRIPT.includes('icon(cancel, '), 'Save and Cancel must be drawn');
  assert.ok(!SCRIPT.includes("save.textContent = 'Save'") && !SCRIPT.includes("cancel.textContent = 'Cancel'"),
    'the old Save/Cancel words are back');
  assert.ok(SCRIPT.includes("save.textContent = 'Saving...'"), 'the busy word must survive the icons');
  assert.ok(SCRIPT.includes("icon(save, 'Save', CHECK_PATH)"), 'Save must be a checkmark');
  assert.ok(SCRIPT.includes("icon(cancel, 'Cancel', CROSS_PATH)"), 'Cancel must be a cross');
  assert.ok(SCRIPT.includes("svg.setAttribute('stroke-width', '1.4')") && SCRIPT.includes("svg.setAttribute('fill', 'none')"),
    'the drawn controls must follow the plugin stroke style');
  // WHICH TARGET each pencil is for is in its tooltip, and the click carries the block.
  assert.deepEqual(pins().map((pin) => pinButton(pin).title),
    ['Edit thinking (seq 15, block 0)', 'Edit answer (seq 15, block 1)']);
  pins()[0].shadowRoot.children[1].dispatch('click');
  assert.deepEqual(globalThis.__ctxkitOpened, [[15, 0]], 'the thinking pencil opened the wrong target');
  globalThis.__ctxkitGeneration.running = true;
  pins()[1].shadowRoot.children[1].dispatch('click');
  assert.deepEqual(globalThis.__ctxkitOpened, [[15, 0]], 'editing opened while generation was running');
  assert.equal(globalThis.__ctxkitGeneration.notices.at(-1)[0],
    'Generation is running. Stop generation before editing or deleting history.');
  assert.equal(pins().length, 2, 'generation hid the visible edit controls');
  globalThis.__ctxkitGeneration.running = false;
  pins()[1].shadowRoot.children[1].dispatch('click');
  assert.deepEqual(globalThis.__ctxkitOpened, [[15, 0], [15, 1]], 'the answer pencil opened the wrong target');
  // A re-decoration adds nothing, and a marker in the OLD shape (a bare seq) is replaced
  // rather than kept beside the new ones.
  decorateTranscript();
  assert.equal(pins().length, 2, 'a second decoration drew the pencils again');
  const legacy = fakeElement('span');
  legacy.setAttribute('data-ctxkit-pencil', '1');
  legacy.setAttribute('data-ctxkit-for', '15');
  row.append(legacy);
  decorateTranscript();
  assert.equal(pins().length, 2, 'the old bare-seq marker was not replaced');
  assert.deepEqual(pins().map((pin) => pin.getAttribute('data-ctxkit-for')), ['15:0', '15:1']);

  // A message whose target LIST did not arrive keeps the single pencil it always had, in
  // the old bare-seq shape - the field is what the second pencil is drawn from, so losing
  // it must not take the first one away.
  STATE.transcript = [{ ...panelEntry(replyEntry([blockText('ANSWER')])), targets: undefined }];
  decorateTranscript();
  assert.deepEqual(pins().map((pin) => pin.getAttribute('data-ctxkit-for')), ['15'],
    'a message without targets lost its pencil');
  globalThis.__ctxkitOpened = [];
  pins()[0].shadowRoot.children[1].dispatch('click');
  assert.deepEqual(globalThis.__ctxkitOpened, [[15, undefined]],
    'a pencil without a block must open the message, not block 0');
});

ok('a pencil is not drawn for a target that cannot be rewritten', () => {
  const script = injectEditor(PAGE);
  const row = fakeElement('div');
  row.setAttribute('data-chat-flow-key', '14:assistant-step1:1');
  row.setAttribute('data-chat-flow-kind', 'assistant-step');
  globalThis.__ctxkitOpened = [];
  globalThis.__ctxkitGeneration = { running: false, notices: [] };
  globalThis.__ctxkitDocument = {
    querySelectorAll: (selector) => (selector === '[data-chat-flow] > [data-chat-flow-key]' ? [row] : []),
    createTextNode: (text) => Object.assign(fakeElement('#text'), { textContent: text }),
    createElement: (tag) => fakeElement(tag)
  };
  const { STATE, decorateTranscript } = panelConsts(script, [
    'STATE', 'targetsOf', 'labelOf', 'optionValue', 'fallbackTarget', 'FLOW_SELECTOR', 'PENCIL_ATTR', 'flowRows', 'chatRows', 'running',
    'flowBody', 'messageIdOf', 'turnOf', 'stepPrefix', 'stepOf', 'pinCss', 'parseKey', 'keyOf',
    'pointed', 'pointerOnce', 'pointerEdit', 'pinAt', 'INNER_CONTROL', 'GESTURE_GRACE',
    'hovered', 'hoverOnce', 'addPencil', 'entryFor', 'targetOf', 'deletedTurnsOf', 'deletedEntryFor', 'pinTargets', 'sameTarget',
    'projections', 'pinnedRows', 'unavailableRows', 'rowOwners', 'decorateTranscript'
  ], [
    'const document = globalThis.__ctxkitDocument;',
    'const installAffordance = () => {}; const setDeletedVisibility = () => {};',
    'const DELETE_ACTION_ATTR = "data-ctxkit-delete"; const placeDeleteAction = () => {};',
    'const generationRunning = () => globalThis.__ctxkitGeneration.running; const STOP_GENERATION = "Generation is running. Stop generation before editing or deleting history."; const say = (message, kind) => globalThis.__ctxkitGeneration.notices.push([message, kind]);',
    'const getComputedStyle = () => ({ position: "static" });',
    'const projectRow = () => {};',
    'const placePencil = () => {};',
    'const openAt = (seq, at) => { globalThis.__ctxkitOpened.push([seq, at]); };'
  ].join('\n'));
  const pins = () => row.querySelectorAll(':scope > [data-ctxkit-pencil]');

  // A signed thinking alone: nothing editable, so no control that could only refuse.
  STATE.sessionId = 'test-session';
  STATE.transcript = [panelEntry(replyEntry([blockReasoning('SIGNED THINKING')], { source: signedSource }))];
  decorateTranscript();
  assert.equal(pins().length, 0, 'a pencil was drawn for a block the commit refuses');

  // A signed thinking BESIDE an answer: exactly one pencil, on the answer, block 1.
  STATE.transcript = [panelEntry(replyEntry([blockReasoning('SIGNED THINKING'), blockText('ANSWER')], { source: signedSource }))];
  decorateTranscript();
  assert.deepEqual(pins().map((pin) => pin.getAttribute('data-ctxkit-for')), ['15:1'],
    'the signed thinking got a pencil, or the answer lost one');

  // A message the list no longer holds: the pencils go with it.
  STATE.transcript = [panelEntry(replyEntry([blockText('ANSWER')], { turn: 4, step: 4 }))];
  decorateTranscript();
  assert.equal(pins().length, 0, 'a pencil outlived the entry it was drawn for');
});

ok('the pencil key is <seq>:<at>, and the bare seq of the first release is still read', () => {
  const script = injectEditor(PAGE);
  const { parseKey, keyOf, targetKey } = panelConsts(script, ['parseKey', 'keyOf', 'targetKey']);
  assert.deepEqual(parseKey('15:1'), { seq: 15, at: 1 });
  assert.deepEqual(parseKey('15:0'), { seq: 15, at: 0 });
  assert.deepEqual(parseKey('15'), { seq: 15, at: undefined }, 'the old bare-seq form is no longer accepted');
  for (const bad of ['15:', ':1', '15:1:2', 'x:1', '15:x', '', null, undefined, ' 15']) {
    assert.equal(parseKey(bad), undefined, `${JSON.stringify(bad)} was read as a target`);
  }
  assert.equal(keyOf(15, 1), '15:1');
  assert.equal(keyOf(15, 0), '15:0');
  assert.equal(keyOf(15, undefined), '15');
  // What the transcript decorator and a row opener are handed: either shape, or a pair.
  assert.deepEqual(targetKey('15:1'), { seq: 15, at: 1 });
  assert.deepEqual(targetKey('8'), { seq: 8, at: undefined });
  assert.deepEqual(targetKey(15, 0), { seq: 15, at: 0 });
  assert.deepEqual(targetKey(15, undefined), { seq: 15, at: undefined });
});

ok('a cached text click opens before an unresolved Host refresh', async () => {
  globalThis.__ctxkitImmediate = { focuses: [], loads: [] };
  const { STATE, openAt } = panelConsts(injectEditor(PAGE), [
    'STATE', 'parseKey', 'targetKey', 'openAt'
  ], [
    'const syncSession = () => {};',
    'const leaveDraft = () => true;',
    'const focusInline = (seq, at, returnFocus) => { globalThis.__ctxkitImmediate.focuses.push([seq, at, returnFocus]); return Promise.resolve(true); };',
    'const load = (foreground) => { globalThis.__ctxkitImmediate.loads.push(foreground); return new Promise(() => {}); };',
    'const isCurrent = (sessionId, epoch) => STATE.sessionId === sessionId && STATE.epoch === epoch;',
    'const currentSessionId = () => STATE.sessionId;'
  ].join('\n'));
  STATE.sessionId = 'session-cache';
  STATE.epoch = 2;
  STATE.listed = true;
  STATE.transcript = [{ type: 'assistant/message', seq: 15, turn: 1, step: 1 }];
  openAt(15, 0);
  assert.deepEqual(globalThis.__ctxkitImmediate.focuses, [[15, 0, undefined]],
    'the cached inline editor waited for the list RPC');
  assert.deepEqual(globalThis.__ctxkitImmediate.loads, [], 'the background refresh started before cached focus resolved');
  await Promise.resolve();
  assert.deepEqual(globalThis.__ctxkitImmediate.loads, [false], 'cached success did not begin a background refresh');
  assert.equal(STATE.pending, null, 'cached success was routed through the foreground pending path');
  assert.doesNotMatch(String(openAt), /setTimeout/u, 'click-to-edit brought back a timer');
  delete globalThis.__ctxkitImmediate;
});

/* ------------------------------------------------- the commit names its block */

console.log('\nthe commit with a block (which of a reply\'s blocks is rewritten)');

/** One commit through the mounted route. */
const commitOn = (panel, payload) => panel.answer(EDIT_METHODS.commit, {
  sessionId: panel.sessionId,
  seq: panel.reply.seq,
  id: panel.reply.id,
  ...payload
});

ok('a commit with block 0 rewrites the thinking, and expects the thinking', async () => {
  const panel = await mountedPanel([blockReasoning('THE THINKING'), blockText('THE ANSWER')]);
  const committed = await commitOn(panel, { block: 0, text: 'THE THINKING, CORRECTED' });
  const value = committed.body.result.value;
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.equal(value.report.branch, 'wire');
  assert.equal(value.report.block, 0, 'the report does not name the block it rewrote');
  assert.equal(value.report.before, 'THE THINKING', 'the report quotes the wrong old text');
  const edits = panel.wire.editsFor(panel.sessionId);
  assert.equal(edits.length, 1, 'the edit was not recorded');
  assert.equal(edits[0].cursor.block, 0, 'the store aims at the wrong block');
  assert.equal(edits[0].before, 'THE THINKING', 'expected must be the text of the CHOSEN block');
  assert.equal(edits[0].after, 'THE THINKING, CORRECTED');
});

ok('a commit with block 1 rewrites the answer, and expects the answer', async () => {
  const panel = await mountedPanel([blockReasoning('THE THINKING'), blockText('THE ANSWER')], { id: 'edit-gui-block-1' });
  const value = (await commitOn(panel, { block: 1, text: 'THE ANSWER, CORRECTED' })).body.result.value;
  assert.equal(value.ok, true, JSON.stringify(value));
  const edits = panel.wire.editsFor(panel.sessionId);
  assert.equal(edits[0].cursor.block, 1, 'the store aims at the wrong block');
  assert.equal(edits[0].before, 'THE ANSWER', 'expected must be the text of the CHOSEN block');
});

ok('a commit WITHOUT a block keeps its old meaning: the message text block', async () => {
  const panel = await mountedPanel([blockReasoning('THE THINKING'), blockText('THE ANSWER')], { id: 'edit-gui-no-block' });
  const value = (await commitOn(panel, { text: 'THE ANSWER, AS BEFORE' })).body.result.value;
  assert.equal(value.ok, true, JSON.stringify(value));
  const edits = panel.wire.editsFor(panel.sessionId);
  assert.equal(edits[0].cursor.block, 1, 'a payload without a block stopped meaning "the message text"');
  assert.equal(edits[0].before, 'THE ANSWER');
  // Nothing was sent as `block`, and the report still names the block that was rewritten.
  assert.equal(value.report.block, 1);
});

ok('the block decides even when both blocks read the same string', async () => {
  // By text alone the store rewrites the FIRST block holding it, which is the thinking.
  const panel = await mountedPanel([blockReasoning('SAME WORDS'), blockText('SAME WORDS')], { id: 'edit-gui-same-words' });
  const value = (await commitOn(panel, { block: 1, text: 'ANSWER, BY BLOCK' })).body.result.value;
  assert.equal(value.ok, true, JSON.stringify(value));
  const edits = panel.wire.editsFor(panel.sessionId);
  assert.equal(edits[0].cursor.block, 1, 'the identical thinking was rewritten instead of the answer');
  assert.equal(edits[0].before, 'SAME WORDS');
  // The other direction, on a session of its own: the SAME payload aimed at block 0.
  const other = await mountedPanel([blockReasoning('SAME WORDS'), blockText('SAME WORDS')], { id: 'edit-gui-same-words-0' });
  const thinking = (await commitOn(other, { block: 0, text: 'THINKING, BY BLOCK' })).body.result.value;
  assert.equal(thinking.ok, true, JSON.stringify(thinking));
  assert.equal(other.wire.editsFor(other.sessionId)[0].cursor.block, 0);
});

ok('a commit on a signed thinking is refused and records nothing', async () => {
  const panel = await mountedPanel([blockReasoning('SIGNED THINKING')], { id: 'edit-gui-signed', source: signedSource });
  const value = (await commitOn(panel, { block: 0, text: 'anything at all' })).body.result.value;
  assert.equal(value.ok, false, 'a signed thinking block was rewritten');
  assert.match(String(value.reason), /signature|signed/u, 'the refusal does not explain itself');
  assert.equal(panel.wire.editsFor(panel.sessionId).length, 0, 'a refused commit recorded an edit anyway');
});

ok('a block index the message does not have, or one that is not an index, is refused', async () => {
  const panel = await mountedPanel([blockReasoning('THOUGHTS'), blockText('ANSWER')], { id: 'edit-gui-bad-block' });
  const outside = (await commitOn(panel, { block: 9, text: 'x' })).body.result.value;
  assert.equal(outside.ok, false, 'a block the message does not have was accepted');
  assert.match(String(outside.reason), /no block 9/u);
  const notAnIndex = (await commitOn(panel, { block: 'one', text: 'x' })).body.result.value;
  assert.equal(notAnIndex.ok, false, 'a non-numeric block was accepted');
  assert.match(String(notAnIndex.reason), /not a block index/u);
  const negative = (await commitOn(panel, { block: -1, text: 'x' })).body.result.value;
  assert.equal(negative.ok, false, 'a negative block was accepted');
  assert.equal(panel.wire.editsFor(panel.sessionId).length, 0, 'a refused commit recorded an edit anyway');
});

ok('a commit on a user message with block 0 still goes into the log', async () => {
  // The ordinary case, end to end through the mounted route: the panel now always names a
  // block, and a user message offers exactly one, so this is the path every Save on a
  // message of your own takes.
  const panel = await mountedPanel([blockText('ANSWER')], { id: 'edit-gui-durable' });
  const before = JSON.stringify(panel.session.deriveMessages());
  assert.ok(before.includes('QUESTION'), 'the fixture does not reach the provider');
  const value = (await panel.answer(EDIT_METHODS.commit, {
    sessionId: panel.sessionId,
    seq: panel.user.seq,
    id: panel.user.id,
    block: 0,
    text: 'QUESTION, CORRECTED'
  })).body.result.value;
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.equal(value.report.branch, 'durable');
  assert.equal(value.report.after, 'QUESTION, CORRECTED');
  const after = JSON.stringify(panel.session.deriveMessages());
  assert.ok(after.includes('QUESTION, CORRECTED'), 'the model does not receive the new text');
  assert.ok(!after.includes('"QUESTION"'), 'the old text is still in the request');
  // Nothing else moved: the reply that follows the edited message is where it was.
  assert.ok(after.includes('ANSWER'), 'the message after the edit was disturbed');
  assert.equal(panel.session.deriveMessages().length, 2, 'the edit changed the number of messages');
  assert.equal(panel.wire.editsFor(panel.sessionId).length, 0, 'a durable edit must not go to the wire store');
});

ok('registered routes list and commit the effective block, including reload and old Chat rows', async () => {
  const panel = await mountedPanel([blockReasoning('THINK A'), blockText('A')], { id: 'edit-gui-effective' });
  const list = async () => (await panel.answer(EDIT_METHODS.list, { sessionId: panel.sessionId })).body.result.value;
  const shownReply = (value) => value.transcript.find((entry) => entry.id === panel.reply.id);
  const beforeLog = JSON.stringify(panel.session.snapshotEvents());
  const first = (await commitOn(panel, { block: 1, expected: 'A', text: 'BB' })).body.result.value;
  assert.equal(first.ok, true);
  let listed = await list();
  let shown = listed.entries.find((entry) => entry.id === panel.reply.id);
  assert.equal(shown.text, 'BB', 'list must project the wire edit, not the raw index');
  assert.equal(shown.chars, 2);
  assert.deepEqual(shown.targets.map((target) => [target.text, target.chars, target.edited, target.changed, target.editStatus]), [
    ['THINK A', 7, false, false, 'none'], ['BB', 2, true, true, 'applied']
  ]);
  assert.equal(shown.edited, true);
  assert.equal(shown.changed, true);
  assert.equal(panel.wire.editsFor(panel.sessionId)[0].basis, 'effective');
  const second = (await commitOn(panel, { block: 1, expected: 'BB', text: 'CCC' })).body.result.value;
  assert.equal(second.ok, true);
  assert.equal(second.report.before, 'BB');
  assert.deepEqual(panel.wire.editsFor(panel.sessionId).map((record) => record.before), ['A', 'BB']);
  assert.equal(editableIndex(panel.session).find((entry) => entry.id === panel.reply.id).text, 'A', 'raw index contract must not change');
  assert.equal(JSON.stringify(panel.session.snapshotEvents()), beforeLog);
  const restored = createEditStore();
  publishEditStore(panel.sessionId, restored);
  panel.reload();
  assert.equal(shownReply(await list()).text, 'CCC');
  assert.equal(planWireRewrite(panel.session.deriveMessages(), restored.editsFor(panel.sessionId)).messages[panel.reply.index].content[1].text, 'CCC');
  const thinking = (await commitOn(panel, { block: 0, expected: 'THINK A', text: 'THINK B' })).body.result.value;
  assert.equal(thinking.ok, true);
  assert.equal(thinking.report.before, 'THINK A');
  assert.deepEqual(shownReply(await list()).targets.map((target) => target.text), ['THINK B', 'CCC']);
  // No expected field remains supported, but its audit must still start at the effective text.
  const reverted = (await commitOn(panel, { block: 1, text: 'A' })).body.result.value;
  assert.equal(reverted.ok, true);
  assert.equal(reverted.report.before, 'CCC');
  shown = shownReply(await list());
  assert.equal(shown.targets[1].edited, true);
  assert.equal(shown.targets[1].changed, false);
  assert.equal(shown.changed, true, 'thinking still differs even when the answer is back at origin');
  assert.equal((await commitOn(panel, { block: 0, expected: 'THINK B', text: 'THINK A' })).body.result.value.ok, true);
  assert.equal(shownReply(await list()).changed, false);
  for (let i = 0; i < 45; i += 1) {
    panel.session.append('user/message', llm.createUserMessage({ content: [blockText(`tail ${i}`)], source: { kind: 'user' } }), { surfaceOp: 'append' });
  }
  listed = await list();
  assert.equal(listed.entries.length, 40);
  assert.equal(listed.transcript.length, listed.counts.total);
  assert.equal(listed.entries.some((entry) => entry.id === panel.reply.id), false);
  assert.equal(shownReply(listed).edited, true, 'old edited Chat rows must not disappear at the panel limit');
});

ok('restore original uses the server block origin after repeated wire edits and preserves siblings and audit', async () => {
  const panel = await mountedPanel([blockReasoning('THINK ORIGINAL'), blockText('ANSWER ORIGINAL')], { id: 'edit-gui-restore-wire' });
  const audit = JSON.stringify(panel.session.snapshotEvents());
  for (const text of ['B', 'C']) assert.equal((await commitOn(panel, { block: 1, text })).body.result.value.ok, true);
  assert.equal((await commitOn(panel, { block: 0, text: 'THINK CHANGED' })).body.result.value.ok, true);
  const read = async () => (await panel.answer(EDIT_METHODS.list, { sessionId: panel.sessionId })).body.result.value.transcript.find(e => e.id === panel.reply.id);
  assert.deepEqual((await read()).targets.map(t => t.originalText), ['THINK ORIGINAL', 'ANSWER ORIGINAL']);
  const restored = (await commitOn(panel, { block: 1, expected: 'C', restore: true, text: 'UNTRUSTED CLIENT ORIGINAL' })).body.result.value;
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.equal(restored.report.after, 'ANSWER ORIGINAL');
  assert.deepEqual((await read()).targets.map(t => [t.text, t.changed]), [['THINK CHANGED', true], ['ANSWER ORIGINAL', false]]);
  assert.equal(panel.wire.editsFor(panel.sessionId).length, 4, 'restore appends instead of deleting edit history');
  assert.equal(JSON.stringify(panel.session.snapshotEvents()), audit);
  assert.equal((await commitOn(panel, { block: 0, expected: 'THINK CHANGED', restore: true })).body.result.value.ok, true);
  assert.equal((await read()).changed, false);
});

ok('restore original follows durable ancestry across edits and restores only the selected block', async () => {
  const panel = await mountedPanel([blockText('ANSWER')], { id: 'edit-gui-restore-user' });
  panel.session.append('user/message', llm.createUserMessage({ content: [blockText('LEFT'), blockText('RIGHT')], source: { kind: 'user' } }), { surfaceOp: 'append' });
  const origin = editableIndex(panel.session).at(-1);
  const originalEvent = JSON.stringify(panel.session.eventAt(origin.seq));
  const read = async () => (await panel.answer(EDIT_METHODS.list, { sessionId: panel.sessionId })).body.result.value.transcript.find(e => e.originId === origin.id);
  const commit = async (block, text, restore = false) => {
    const current = await read();
    return (await panel.answer(EDIT_METHODS.commit, { sessionId: panel.sessionId, seq: current.seq, id: current.id,
      block, expected: current.targets[block].text, text, restore })).body.result.value;
  };
  for (const [at, text] of [[0, 'X'], [0, 'XX'], [1, 'Y']]) assert.equal((await commit(at, text)).ok, true);
  assert.deepEqual((await read()).targets.map(t => t.originalText), ['LEFT', 'RIGHT']);
  assert.equal((await commit(0, undefined, true)).ok, true);
  assert.deepEqual((await read()).targets.map(t => [t.text, t.changed]), [['LEFT', false], ['Y', true]]);
  assert.equal(JSON.stringify(panel.session.eventAt(origin.seq)), originalEvent);
  assert.equal(panel.session.deriveMessages().at(-1).content[1].text, 'Y');
});

ok('restore refuses stale, implicit and signed targets without writing', async () => {
  const panel = await mountedPanel([blockReasoning('SIGNED'), blockText('A')], { id: 'edit-gui-restore-guards', source: signedSource });
  assert.equal((await commitOn(panel, { block: 1, text: 'B' })).body.result.value.ok, true);
  const before = readFileSync(editStatePath(panel.sessionId), 'utf8');
  for (const payload of [{ block: 1, expected: 'A' }, { block: 1 }, { expected: 'B' }, { block: 0, expected: 'SIGNED' }]) {
    const value = (await commitOn(panel, { ...payload, restore: true })).body.result.value;
    assert.equal(value.ok, false, JSON.stringify(payload));
  }
  assert.equal(readFileSync(editStatePath(panel.sessionId), 'utf8'), before);
});

ok('stale expected is refused before either wire state or the durable log is written', async () => {
  const panel = await mountedPanel([blockText('A')], { id: 'edit-gui-stale' });
  assert.equal((await commitOn(panel, { block: 0, expected: 'A', text: 'B' })).body.result.value.ok, true);
  const fileBefore = readFileSync(editStatePath(panel.sessionId), 'utf8');
  const logBefore = JSON.stringify(panel.session.snapshotEvents());
  for (const expected of ['A', null, 42]) {
    const value = (await commitOn(panel, { block: 0, expected, text: 'C' })).body.result.value;
    assert.equal(value.ok, false, 'stale or malformed expected must not overwrite B');
    assert.match(value.reason, /changed|stale|expected|reload/u);
  }
  const durable = (await panel.answer(EDIT_METHODS.commit, {
    sessionId: panel.sessionId, seq: panel.user.seq, id: panel.user.id, block: 0, expected: 'old question', text: 'new question'
  })).body.result.value;
  assert.equal(durable.ok, false);
  assert.equal(readFileSync(editStatePath(panel.sessionId), 'utf8'), fileBefore);
  assert.equal(JSON.stringify(panel.session.snapshotEvents()), logBefore);
});

ok('route projection preserves legacy audits and reports refused edits honestly', async () => {
  const panel = await mountedPanel([blockText('A')], { id: 'edit-gui-legacy' });
  for (const text of ['B', 'C']) panel.wire.record(panel.sessionId, panel.reply.message, text, { messageIndex: panel.reply.index, messageId: panel.reply.id });
  const old = readFileSync(editStatePath(panel.sessionId), 'utf8');
  const list = async () => (await panel.answer(EDIT_METHODS.list, { sessionId: panel.sessionId })).body.result.value.entries.find((entry) => entry.id === panel.reply.id);
  assert.equal((await list()).text, 'C');
  assert.equal(readFileSync(editStatePath(panel.sessionId), 'utf8'), old, 'list must not rewrite legacy audits');
  const saved = (await commitOn(panel, { expected: 'C', text: 'D' })).body.result.value;
  assert.equal(saved.ok, true);
  assert.equal(saved.report.before, 'C');
  assert.deepEqual(panel.wire.editsFor(panel.sessionId).map((record) => record.before), ['A', 'A', 'C']);
  panel.wire.editsFor(panel.sessionId).push({ ...panel.wire.editsFor(panel.sessionId)[0], id: 'refused-edit', before: 'never present' });
  const shown = await list();
  assert.equal(shown.text, 'D');
  assert.equal(shown.editStatus, 'mixed');
  assert.equal(shown.targets[0].editStatus, 'mixed');
  panel.wire.editsFor(panel.sessionId).splice(0, 3);
  const refused = await list();
  assert.equal(refused.text, 'A');
  assert.equal(refused.edited, true);
  assert.equal(refused.changed, false);
  assert.equal(refused.editStatus, 'refused');
  assert.equal(refused.targets[0].editStatus, 'refused');
});

ok('registered durable commits retain direct-human deletion provenance after replay', async () => {
  const panel = await mountedPanel([blockText('ANSWER')], { id: 'edit-gui-origin' });
  let user = panel.user;
  for (const text of ['B', 'QUESTION']) {
    const value = (await panel.answer(EDIT_METHODS.commit, {
      sessionId: panel.sessionId, seq: user.seq, id: user.id, block: 0, expected: user.text, text
    })).body.result.value;
    assert.equal(value.ok, true);
    panel.reload();
    const listed = (await panel.answer(EDIT_METHODS.list, { sessionId: panel.sessionId })).body.result.value;
    user = listed.entries.find((entry) => entry.type === 'user/message');
    assert.equal(user.seq, value.report.newSeq);
    assert.equal(user.originSeq, panel.user.seq);
    assert.equal(user.originId, panel.user.id);
    assert.notEqual(user.id, user.originId);
    assert.equal(user.edited, true);
    assert.equal(user.changed, text !== 'QUESTION');
    assert.equal(user.targets[0].edited, true);
    assert.equal(user.targets[0].changed, user.changed);
    assert.equal(user.targets[0].label, 'Message');
    assert.equal(user.editStatus, 'applied');
    assert.equal(user.directUser, true);
    assert.deepEqual(listed.transcript.find((entry) => entry.seq === user.seq), user);
  }
  const removed = (await panel.answer(EDIT_METHODS.deleteTurn, {
    sessionId: panel.sessionId, seq: user.seq, id: user.id, expected: user.text
  })).body.result.value;
  assert.equal(removed.ok, true, String(removed.reason));
  panel.reload();
  const listed = (await panel.answer(EDIT_METHODS.list, { sessionId: panel.sessionId })).body.result.value;
  assert.deepEqual(listed.hidden.map((entry) => entry.deletedTurn), [true, true],
    'a deleted edited turn lost Host deletion metadata after replay');
  assert.deepEqual(listed.hidden.map((entry) => entry.directUser), [true, false],
    'a durable replacement stopped being a direct-human turn boundary after replay');
});

ok('disabled editor lists raw wire text without undoing durable edits or saving', async () => {
  const panel = await mountedPanel([blockText('A')], { id: 'edit-gui-disabled-list' });
  assert.equal((await commitOn(panel, { expected: 'A', text: 'B' })).body.result.value.ok, true);
  const durable = (await panel.answer(EDIT_METHODS.commit, {
    sessionId: panel.sessionId, seq: panel.user.seq, id: panel.user.id, expected: 'QUESTION', text: 'DURABLE NEW'
  })).body.result.value;
  assert.equal(durable.ok, true);
  const list = async () => (await panel.answer(EDIT_METHODS.list, { sessionId: panel.sessionId })).body.result.value;
  const shownReply = (listed) => listed.entries.find((entry) => entry.id === panel.reply.id);
  assert.equal(shownReply(await list()).text, 'B');
  const logBefore = JSON.stringify(panel.session.snapshotEvents());
  const fileBefore = readFileSync(editStatePath(panel.sessionId), 'utf8');
  for (const enabled of [false, undefined]) {
    panel.engine.dcpConfig.editor.enabled = enabled;
    const listed = await list();
    const reply = shownReply(listed);
    assert.equal(reply.text, 'A', 'disabled list must agree with the disabled outgoing overlay');
    assert.equal(reply.changed, false);
    assert.equal(reply.editStatus, 'none');
    assert.equal(reply.targets[0].text, 'A');
    assert.equal(reply.targets[0].editStatus, 'none');
    assert.deepEqual(listed.transcript.find((entry) => entry.id === reply.id), reply);
    const user = listed.entries.find((entry) => entry.type === 'user/message');
    assert.equal(user.text, 'DURABLE NEW');
    assert.equal(user.originId, panel.user.id);
    assert.equal(user.editStatus, 'applied');
    const refused = (await commitOn(panel, { expected: 'A', text: 'C' })).body.result.value;
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /disabled/u);
  }
  assert.equal(editableIndex(panel.session).find((entry) => entry.id === panel.reply.id).text, 'A');
  assert.equal(JSON.stringify(panel.session.snapshotEvents()), logBefore);
  assert.equal(readFileSync(editStatePath(panel.sessionId), 'utf8'), fileBefore);
  panel.engine.dcpConfig.editor.enabled = true;
  assert.equal(shownReply(await list()).text, 'B');
  const next = (await commitOn(panel, { expected: 'B', text: 'C' })).body.result.value;
  assert.equal(next.ok, true);
  assert.equal(next.report.before, 'B');
});

ok('malformed persisted anchors cannot break list or unrelated durable commits', async () => {
  const panel = await mountedPanel([blockText('A')], { id: 'edit-gui-corrupt-anchor' });
  panel.wire.record(panel.sessionId, panel.reply.message, 'B', { messageIndex: panel.reply.index, messageId: panel.reply.id });
  const path = editStatePath(panel.sessionId);
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  const valid = saved.edits[0];
  saved.edits.unshift({ ...valid, id: 'bad-anchor', anchor: { ...valid.anchor, blocks: [null] } });
  writeFileSync(path, JSON.stringify(saved), 'utf8');
  const before = readFileSync(path, 'utf8');
  const problems = [];
  const restored = createEditStore({ onProblem: (_session, problem) => problems.push(problem) });
  publishEditStore(panel.sessionId, restored);
  const listed = await panel.answer(EDIT_METHODS.list, { sessionId: panel.sessionId });
  assert.equal(listed.body.result.ok, true, 'one malformed record must not throw out the entire list');
  const reply = listed.body.result.value.entries.find((entry) => entry.id === panel.reply.id);
  assert.equal(reply.text, 'B');
  assert.equal(reply.editStatus, 'applied');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /anchor.*block/u);
  assert.deepEqual(restored.editsFor(panel.sessionId), [valid]);
  assert.equal(readFileSync(path, 'utf8'), before, 'reading a malformed file must not migrate its valid audits');
  const committed = await panel.answer(EDIT_METHODS.commit, {
    sessionId: panel.sessionId, seq: panel.user.seq, id: panel.user.id, expected: 'QUESTION', text: 'USER NEW'
  });
  assert.equal(committed.body.result.ok, true);
  assert.equal(committed.body.result.value.ok, true);
  assert.equal(committed.body.result.value.report.branch, 'durable');
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.equal(planWireRewrite(panel.session.deriveMessages(), restored.editsFor(panel.sessionId)).messages[panel.reply.index].content[0].text, 'B');
});

ok('registered route accepts 40 KiB expected plus replacement and enforces a 128 KiB byte cap', async () => {
  const original = 'A'.repeat(40 * 1024);
  const replacement = 'B'.repeat(40 * 1024);
  const panel = await mountedPanel([blockText(original)], { id: 'edit-gui-body-cap' });
  const saved = await commitOn(panel, { block: 0, expected: original, text: replacement });
  assert.equal(saved.status, 200, 'two previously valid 40 KiB texts must fit the request cap');
  assert.equal(saved.body.result.value.ok, true);
  assert.equal(saved.body.result.value.report.before, original);
  assert.equal(panel.wire.editsFor(panel.sessionId)[0].after, replacement);

  const cap = 128 * 1024;
  const payload = { sessionId: panel.sessionId, seq: panel.reply.seq, id: panel.reply.id, block: 0, expected: replacement, text: '' };
  const bytes = () => Buffer.byteLength(JSON.stringify({ type: 'client-request', rpcId: '1', method: EDIT_METHODS.commit, payload }));
  payload.text = 'C'.repeat(cap - bytes());
  assert.equal(bytes(), cap);
  const boundary = await panel.answer(EDIT_METHODS.commit, payload);
  assert.equal(boundary.status, 200, 'a body exactly at the bounded cap must be accepted');
  assert.equal(boundary.body.result.value.ok, true);
  payload.expected = payload.text;
  payload.text = '';
  payload.text = 'D'.repeat(cap + 1 - bytes());
  assert.equal(bytes(), cap + 1);
  const fileBefore = readFileSync(editStatePath(panel.sessionId), 'utf8');
  const logBefore = JSON.stringify(panel.session.snapshotEvents());
  for (const text of [payload.text, '\u00e9'.repeat(payload.text.length)]) {
    const refused = await panel.answer(EDIT_METHODS.commit, { ...payload, text });
    assert.equal(refused.status, 413);
    assert.match(refused.body, /body larger than 131072 bytes/u);
    assert.equal(refused.destroyed, true);
  }
  assert.equal(panel.wire.editsFor(panel.sessionId).length, 2, 'oversize bodies must be refused before commit');
  assert.equal(readFileSync(editStatePath(panel.sessionId), 'utf8'), fileBefore);
  assert.equal(JSON.stringify(panel.session.snapshotEvents()), logBefore);
});

ok('textual listing reuses effective entries while the command keeps its raw default', async () => {
  const panel = await mountedPanel([blockText('ANSWER')], { id: 'edit-gui-effective-listing' });
  panel.wire.record(panel.sessionId, panel.user.message, 'USER WIRE', { messageIndex: panel.user.index, messageId: panel.user.id });
  const list = async () => (await panel.answer(EDIT_METHODS.list, { sessionId: panel.sessionId })).body.result.value;
  const enabled = await list();
  assert.equal(enabled.entries.find((entry) => entry.id === panel.user.id).text, 'USER WIRE');
  assert.ok(enabled.listing.includes('USER WIRE'), 'listing must use the same effective text as entries');
  assert.equal(enabled.listing.includes('QUESTION'), false);
  assert.ok(renderEditableList(panel.session).includes('QUESTION'), 'the command default must remain unchanged');
  panel.engine.dcpConfig.editor.enabled = false;
  assert.equal((await list()).listing, renderEditableList(panel.session));
});

await Promise.all(pending);
resetBridgeForTest();
if (firstFailure !== undefined) throw firstFailure;
console.log(`\nedit gui: ${checks} checks passed`);
