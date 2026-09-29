/** Host plugins must not depend on an agent preset or on each other. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file';
import * as llm from '@deepseek-ai/dsh-llm';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { engineFor as engineFromBridge, editStoreFor, resetBridgeForTest } from '../lib/edit-bridge.js';
import { runInNewContext } from 'node:vm';
import YAML from 'yaml';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const home = mkdtempSync(join(tmpdir(), 'ctx-plugins-'));
process.env.DSH_HOME = home;
process.env.XDG_CONFIG_HOME = join(home, 'xdg');
process.env.OPENCODE_CONFIG_DIR = join(home, 'opencode');
let passed = 0;
let failed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log('[ok] ' + name); }
  catch (error) { failed++; console.error('[FAIL] ' + name + ': ' + error.stack); }
};

await check('three separately importable host plugins own three settings sections', async () => {
  for (const [file, namespace] of [['dcp-plugin', 'dcp'], ['context-mode-plugin', 'context-mode'], ['editor-plugin', 'history-editor']]) {
    const plugin = await import('../lib/' + file + '.js');
    assert.equal(plugin.name, namespace);
    assert.equal(typeof plugin.apply, 'function');
    assert.ok(plugin.inject.includes('settings'));
  }
});

await check('the client registers three native keyed settings cards', async () => {
  let plugin;
  const window = new EventTarget();
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => [initial, () => {}],
    useEffect() {},
    useSyncExternalStore: (_subscribe, snapshot) => snapshot()
  };
  window.__ModuleLoader__ = { load: definition => { plugin = definition.factory(() => React); } };
  runInNewContext(readFileSync(new URL('../lib/edit-client.js', import.meta.url), 'utf8'), { window, Event });
  const cards = new Map(), scopes = [];
  const slots = {
    register(spec, component) { if (spec.name === 'settings.plugin.item') cards.set(spec.key, component); return () => {}; },
    inject(name, body) { const result = body(); if (result?.next) for (const value of result) void value; }
  };
  plugin.apply({
    sessions: { list: { getSnapshot: () => ({}), subscribe: () => () => {} } },
    effect: fn => fn(),
    inject(names, body) {
      assert.ok(names.includes('slots'));
      body({ slots, settingsScope: { bind({ namespace }) {
        scopes.push(namespace);
        return { getSnapshot: () => ({ status: 'ready', writable: true, value: {} }) };
      } } });
    }
  });
  assert.deepEqual([...cards.keys()].sort(), ['context-mode', 'dcp', 'history-editor']);
  assert.deepEqual(scopes.sort(), [...cards.keys()].sort());
  for (const component of cards.values()) {
    const tree = component();
    const header = tree.children.find(child => child?.props?.className === 'ctxkit-settings-header');
    const title = header.children[0].children[0];
    assert.equal(title.type, 'span', 'card titles must not pick up the palette markdown strong color');
    assert.equal(title.props.className, 'ctxkit-settings-title');
  }
});

await check('context readout stays visible for missing, partial and changing projections', () => {
  let plugin, component, currentSession = 'a';
  const window = new EventTarget();
  const states = [];
  let cursor = 0;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useRef: () => ({ current: null }),
    useEffect: () => {},
    useState: initial => { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = value; }]; },
    useSyncExternalStore: (_subscribe, snapshot) => snapshot()
  };
  window.__ModuleLoader__ = { load: definition => { plugin = definition.factory(() => React); } };
  runInNewContext(readFileSync(new URL('../lib/edit-client.js', import.meta.url), 'utf8'), { window, Event });
  plugin.apply({
    sessions: { list: { getSnapshot: () => ({ current: currentSession }), subscribe: () => () => {} } },
    effect: () => {},
    inject(names, body) {
      if (names.includes('settingsScope')) return;
      body({ slots: { inject: (_name, fn) => fn(), register: (spec, fn) => {
        if (spec.name === 'conversation.input.right') {
          assert.equal(spec.id, 'context-kit-token-meter', 'native list slots require a stable id');
          component = fn;
        }
      } } });
    }
  });
  assert.equal(typeof component, 'function', 'composer must have a persistent context readout');
  const flatten = node => typeof node === 'object' && node ? [node, ...node.children.flatMap(flatten)] : [];
  const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : node?.children?.map(text).join(' ') ?? '';
  const render = pressure => { cursor = 0; return component({ sessionId: currentSession, useProjection: () => pressure }); };
  const trigger = tree => flatten(tree).find(node => node.type === 'button');
  assert.match(text(trigger(render(undefined))), /Context.*waiting/i);
  assert.match(text(trigger(render({ projectedTokens: 13621 }))), /13\.6K/);
  assert.doesNotMatch(trigger(render({ projectedTokens: 13621 })).props['aria-label'], /0%/);
  assert.match(text(trigger(render({ projectedTokens: 0, contextWindow: 1000000 }))), /0/);
  let tree = render({ projectedTokens: 13621, pressureTokens: 5, contextWindow: 1000000 });
  assert.match(text(trigger(tree)), /13\.6K/);
  trigger(tree).props.onClick();
  tree = render({ projectedTokens: 13621, contextWindow: 1000000 });
  assert.ok(flatten(tree).some(node => node.props.role === 'dialog'));
  currentSession = 'b';
  tree = render(undefined);
  assert.ok(!flatten(tree).some(node => node.props.role === 'dialog'), 'session changes must close the old popover');
  assert.match(text(trigger(tree)), /waiting/i);
  assert.doesNotMatch(text(trigger(render({ projectedTokens: NaN, contextWindow: 0 }))), /NaN|Infinity/);
});

await check('Context Mode isolates project indexes and session counters on one host', async () => {
  const plugin = await import('../lib/context-mode.js');
  const registered = new Map();
  const ctx = new Context();
  ctx.provide('tools', { register(tool) { registered.set(tool.name, tool); return () => {}; } });
  const scope = ctx.plugin(plugin, { routingGuard: false });
  await new Promise(resolve => setTimeout(resolve, 150));
  const exec = (id, cwd) => ({ callId: 'test-' + id, agent: { session: { id, header: { cwd } } } });
  const a = join(home, 'project-a'), b = join(home, 'project-b');
  mkdirSync(a); mkdirSync(b);
  try {
    await registered.get('ctx_index').execute({ text: 'PRIVATE_ALPHA_MARKER', source: 'a' }, exec('a', a));
    const left = await registered.get('ctx_stats').execute({}, exec('a', a));
    const right = await registered.get('ctx_stats').execute({}, exec('b', b));
    assert.notEqual(left.rendered, right.rendered, 'indexes/counters must be selected by the calling session, not the mount cwd');
    const found = await registered.get('ctx_search').execute({ queries: ['PRIVATE_ALPHA_MARKER'] }, exec('b', b));
    assert.equal(found.hits, 0, 'another project must not return the indexed content');
    await registered.get('ctx_purge').execute({ confirm: true }, exec('b', b));
    const after = await registered.get('ctx_stats').execute({}, exec('a', a));
    assert.match(after.rendered, /entries: 1 line\(s\).*1 source\(s\)/, 'purging project B must leave project A entries intact');
    assert.match(after.rendered, /- a: 1/, 'purging project B must leave project A source intact');
    assert.equal(after.rendered.split('\n')[0], left.rendered.split('\n')[0], 'purging project B must keep project A database selected');
  } finally { await scope.dispose(); }
});

await check('native settings mount all plugins without a preset; editor survives DCP off', async () => {
  resetBridgeForTest();
  const root = new Context(), tools = new Map(), commands = new Map(), routes = [];
  root.provide('tools', { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } });
  root.provide('commands', { register(command) { commands.set(command.name, command); return () => commands.delete(command.name); } });
  root.provide('llm', llm);
  root.provide('tokenMeter', { estimateMessage: () => 1, measure: () => ({ nodes: [] }) });
  new SessionStore(root);
  root.provide('connection', { rpc: { handle() {} } });
  root.provide('webServer', { register(route) { routes.push(route); return () => {}; }, tapIndex: () => () => {} });
  const provider = root.plugin(FileSettingsProvider, { path: join(home, 'settings.yaml'), watch: false });
  await provider.await();
  const mounts = [];
  try {
    for (const [file, config] of [['dcp-plugin', { enabled: false }], ['context-mode-plugin', { enabled: false }], ['editor-plugin', { enabled: true }]]) {
      const mount = root.plugin(await import('../lib/' + file + '.js'), config);
      mounts.push(mount); await mount.await();
    }
    assert.ok(commands.has('edit'));
    assert.ok(!commands.has('dcp'));
    assert.ok(!tools.has('ctx_execute'));
    assert.equal(routes.filter(route => route.path === '/ctxkit.edit').length, 1);
    assert.equal(engineFromBridge().editorConfig.enabled, true);
    assert.ok(editStoreFor('an-independent-session'));
    await root.settings.update('history-editor', { enabled: false });
    assert.equal(engineFromBridge().editorConfig.enabled, false, 'editor settings are live');
    await root.settings.update('history-editor', { enabled: true });
    assert.equal(engineFromBridge().editorConfig.enabled, true);
  } finally {
    for (const mount of mounts.reverse()) await mount.dispose();
    await provider.dispose(); resetBridgeForTest();
  }
});

await check('DCP addon keeps the native compactor and does not install editor hooks', async () => {
  const root = new Context(), commands = new Map();
  root.provide('tools', { register: () => () => {} });
  root.provide('commands', { register(command) { commands.set(command.name, command); return () => {}; } });
  root.provide('llm', llm);
  root.provide('tokenMeter', { estimateMessage: () => 1, measure: () => ({ nodes: [] }) });
  new SessionStore(root);
  const native = { compactIfNeeded() {} };
  root.provide('compaction', native);
  const provider = root.plugin(FileSettingsProvider, { path: join(home, 'dcp-settings.yaml'), watch: false });
  await provider.await();
  const mount = root.plugin(await import('../lib/dcp-plugin.js'), {});
  try {
    await mount.await();
    const { engineForTest } = await import('../lib/dcp.js');
    assert.equal(root.get('compaction'), native);
    assert.equal(engineForTest().config.auto, false, 'the native preset owns automatic pressure/overflow compaction');
    assert.ok(commands.has('dcp'));
    assert.ok(!commands.has('edit'));
    assert.equal(engineFromBridge(), undefined);
  } finally { await mount.dispose(); await provider.dispose(); }
});

await check('migration removes kit dependencies but preserves presets, MCP, settings and history', async () => {
  const { planMigration } = await import('../lib/plugin-migration.js');
  const fixture = join(home, 'migration'), kitRoot = join(fixture, 'plugins', 'dsh-context-kit');
  const profile = join(fixture, 'profiles', 'web');
  const preset = join(fixture, 'plugins', 'presets', 'context-kit');
  mkdirSync(profile, { recursive: true }); mkdirSync(preset, { recursive: true }); mkdirSync(kitRoot);
  const entry = file => join(kitRoot, 'lib', file).replace(/\\/g, '/');
  const mcp = { id: 'mcp-chrome-devtools', name: '@deepseek-ai/dsh-mcp-client', config: { args: ['--no-usage-statistics', '--no-performance-crux'] } };
  const files = {
    [join(profile, 'cordis.patch.yml')]: YAML.stringify([{ id: 'agent-presets', config: { default: 'context-kit', roots: [] } },
      { id: 'user-plugin', config: { keep: true } }, { insert: [{ id: 'context-kit-edit-panel', name: entry('edit-host.js') }] }]),
    [join(preset, 'agent.cordis.yml')]: YAML.stringify([{ id: 'compaction', isolate: { compaction: true }, config: [{ id: 'dcp', name: entry('dcp.js') }, { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' }] },
      { id: 'context-mode', name: entry('context-mode.js') }, mcp]),
    [join(fixture, 'settings.yaml')]: YAML.stringify({ 'ui-chat': { untouched: 7 }, dcp: { manualMode: true } }),
    [join(fixture, 'dcp.jsonc')]: JSON.stringify({ manualMode: false, editor: { enabled: true, requireIdle: true } }),
    [join(fixture, 'history.jsonl')]: 'DO NOT TOUCH\n'
  };
  for (const [path, text] of Object.entries(files)) writeFileSync(path, text);
  const plan = planMigration({ home: fixture, kitRoot });
  const migrated = file => YAML.parse(plan.changes.find(change => change.path === file)?.after ?? files[file]);
  const rows = migrated(join(profile, 'cordis.patch.yml'));
  assert.deepEqual(rows.find(row => row.id === 'user-plugin').config, { keep: true });
  assert.equal(rows.find(row => row.id === 'agent-presets').config.default, 'context-kit', 'preserve the selected preset and its MCP');
  const hosts = rows.flatMap(row => row.insert ?? []);
  assert.deepEqual(hosts.map(row => row.id).sort(), ['context-kit-context-mode', 'context-kit-dcp', 'context-kit-history-editor']);
  const legacy = migrated(join(preset, 'agent.cordis.yml'));
  assert.equal(legacy[0].config[0].name, '@deepseek-ai/dsh-compaction-basic');
  assert.deepEqual(legacy.find(row => row.id === mcp.id), mcp);
  assert.ok(!legacy.some(row => row.id === 'context-mode'));
  const settings = migrated(join(fixture, 'settings.yaml'));
  assert.equal(settings.dcp.manualMode, true, 'existing native settings win over legacy files');
  assert.equal(settings['history-editor'].enabled, true);
  assert.equal(settings['ui-chat'].untouched, 7);
  assert.ok(plan.changes.every(change => !/history|knowledge/i.test(change.path)));
  for (const [path, text] of Object.entries(files)) assert.equal(readFileSync(path, 'utf8'), text, 'planning is read-only');
  for (const change of plan.changes) writeFileSync(change.path, change.after);
  assert.equal(planMigration({ home: fixture, kitRoot }).changes.length, 0, 'migration is idempotent');
});

await check('a sandbox home never migrates presets beside an external kit installation', async () => {
  const { planMigration } = await import('../lib/plugin-migration.js');
  const fixture = join(home, 'boundary-home'), installation = join(home, 'external-install', 'kit');
  const externalPreset = join(home, 'external-install', 'presets', 'context-kit', 'agent.cordis.yml');
  mkdirSync(join(fixture, 'profiles', 'web'), { recursive: true });
  mkdirSync(join(home, 'external-install', 'presets', 'context-kit'), { recursive: true });
  writeFileSync(join(fixture, 'profiles', 'web', 'cordis.patch.yml'), '[]\n');
  writeFileSync(externalPreset, YAML.stringify([{ id: 'context-mode', name: join(installation, 'lib', 'context-mode.js').replace(/\\/g, '/') }]));
  const before = readFileSync(externalPreset, 'utf8');
  const plan = planMigration({ home: fixture, kitRoot: installation });
  assert.ok(plan.changes.every(change => change.path.startsWith(fixture + (process.platform === 'win32' ? '\\' : '/'))));
  assert.equal(readFileSync(externalPreset, 'utf8'), before);
});

await check('migration refuses a running server and backs up an offline change', async () => {
  const fixture = join(home, 'offline-migration');
  mkdirSync(join(fixture, 'profiles', 'web'), { recursive: true });
  writeFileSync(join(fixture, 'profiles', 'web', 'cordis.patch.yml'), '[]\n');
  writeFileSync(join(fixture, 'settings.yaml'), '# existing comment\nui-chat:\n  untouched: true\n');
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const run = () => spawnSync(process.execPath, [fileURLToPath(new URL('./migrate-independent-plugins.mjs', import.meta.url)), '--apply'], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env, DSH_HOME: fixture, DSH_MIGRATION_PORT: String(port) }
  });
  try {
    const refused = run();
    assert.notEqual(refused.status, 0); assert.match(refused.stderr, /Stop DSH/);
    assert.equal(readFileSync(join(fixture, 'profiles', 'web', 'cordis.patch.yml'), 'utf8'), '[]\n');
  } finally { await new Promise(resolve => server.close(resolve)); }
  const applied = run();
  assert.equal(applied.status, 0, applied.stderr); assert.match(applied.stdout, /Migration applied\. Backup:/);
  const settings = readFileSync(join(fixture, 'settings.yaml'), 'utf8');
  assert.match(settings, /existing comment/); assert.equal(YAML.parse(settings)['ui-chat'].untouched, true);
  const repeated = run();
  assert.equal(repeated.status, 0, repeated.error?.message ?? repeated.stderr);
  assert.match(repeated.stdout, /0 configuration files/);
});

console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
