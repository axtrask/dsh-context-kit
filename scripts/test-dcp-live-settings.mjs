/** Live settings must change policy without replacing the engine or its state. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Context } from '@deepseek-ai/cordis';
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file';
import * as llm from '@deepseek-ai/dsh-llm';
import { SessionStore } from '@deepseek-ai/dsh-session';
import * as plugin from '../lib/dcp-plugin.js';
import { engineForTest } from '../lib/dcp.js';

const home = mkdtempSync(join(tmpdir(), 'dcp-live-'));
process.env.DSH_HOME = home;
process.env.XDG_CONFIG_HOME = join(home, 'xdg');
process.env.OPENCODE_CONFIG_DIR = join(home, 'opencode');
const root = new Context(), tools = new Map(), commands = new Map(), sections = new Map(), routes = [];
const register = map => item => {
  assert.ok(!map.has(item.name), 'duplicate registration: ' + item.name);
  map.set(item.name, item);
  return () => { if (map.get(item.name) === item) map.delete(item.name); };
};
root.provide('tools', { register: register(tools) });
root.provide('commands', { register: register(commands) });
root.provide('systemPrompt', { section: register(sections) });
root.provide('llm', llm);
root.provide('webServer', { register: route => { routes.push(route); return () => routes.splice(routes.indexOf(route), 1); } });
let used = 60000;
root.provide('tokenMeter', { estimateMessage: () => 1, measure: () => ({ totalTokens: used, nodes: [] }) });
new SessionStore(root);
const provider = root.plugin(FileSettingsProvider, { path: join(home, 'settings.yaml'), watch: false });
await provider.await();
const mount = root.plugin(plugin, {});
await mount.await();
let passed = 0, failed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log('[ok] ' + name); }
  catch (error) { failed++; console.error('[FAIL] ' + name + ': ' + error.stack); }
};
const update = async patch => { await root.settings.update('dcp', patch); await new Promise(resolve => setTimeout(resolve, 20)); };
const sessionEvents = [
  { type: 'assistant/message', data: { message: { id: 'live-assistant', role: 'assistant', content: [{ type: 'text', text: 'done' }], source: { kind: 'model', provider: 'p', model: 'm' } } } },
  { type: 'user/message', data: { id: 'live-user', role: 'user', content: [{ type: 'text', text: 'next' }], source: { kind: 'user' } } }
];
const session = { id: 'live-test', seq: sessionEvents.length, eventAt: seq => sessionEvents[Number(seq)], snapshotEvents: () => sessionEvents.map((event, seq) => ({ ...event, seq })), surface: { nodes: [0, 1] } };
const engine = engineForTest(), blocks = engine.blocksFor(session), stats = engine.stats;
engine.contextWindow = () => 1000000;
try {
  await check('thresholds and enable switches apply to the same live engine', async () => {
    assert.equal(engine.evaluateNudge(session).level, 'reminder');
    await update({ compress: { minContextLimit: '70%', maxContextLimit: '90%' } });
    assert.equal(engine.evaluateNudge(session).level, 'quiet');
    assert.equal(engineForTest(), engine);
    assert.equal(engine.blocksFor(session), blocks);
    assert.equal(engine.stats, stats);
    assert.equal(engine.config.auto, false);
    const inFlightTool = tools.get('compress');
    await update({ enabled: false });
    assert.ok(!tools.has('compress') && !commands.has('dcp'));
    assert.equal(sections.get('dcp:system').text({ scope: session }), '');
    assert.equal(sections.has('dcp:surface'), false);
    await assert.rejects(() => inFlightTool.execute({ topic: 'Captured policy', content: [] }, {}), /owning agent/);
    await update({ enabled: true });
    assert.ok(tools.has('compress') && commands.has('dcp'));
  });
  await check('all editable prompts reach the next policy and tool registration', async () => {
    await update({ enabled: true, experimental: { customPrompts: true }, compress: { minContextLimit: 50000, maxContextLimit: 100000, nudgeFrequency: 1 },
      prompts: { system: 'CUSTOM SYSTEM', turnNudge: 'CUSTOM TURN', iterationNudge: 'CUSTOM ITERATION', contextLimitNudge: 'CUSTOM LIMIT', compressRange: 'CUSTOM RANGE', compressMessage: 'CUSTOM MESSAGE' } });
    assert.match(sections.get('dcp:system').text({ scope: session }), /CUSTOM SYSTEM/);
    assert.match(engine.evaluateNudge(session).text, /CUSTOM TURN/);
    assert.match(engine.customPrompt('iterationNudge'), /CUSTOM ITERATION/);
    used = 150000;
    assert.match(engine.evaluateNudge(session).text, /CUSTOM LIMIT/);
    assert.match(tools.get('compress').description, /CUSTOM RANGE/);
    assert.match(tools.get('compress').description, /THE FORMAT OF COMPRESS/);
    await update({ compress: { mode: 'message' } });
    assert.match(tools.get('compress').description, /CUSTOM MESSAGE/);
    await update({ compress: { permission: 'deny' }, commands: { enabled: false } });
    assert.ok(!tools.has('compress') && !commands.has('dcp'));
    await update({ compress: { permission: 'allow' }, commands: { enabled: true } });
    assert.ok(tools.has('compress') && commands.has('dcp'));
    await update({ manualMode: true });
    const agent = { inject() { throw new Error('manual mode must not inject automatic reminders'); } };
    assert.equal(engine._maybeNudge(session, agent), undefined);
    await update({ manualMode: false });
  });
  await check('invalid limits are refused without changing the running settings', async () => {
    const before = engine.dcpConfig;
    for (const value of ['oops', '120%', '-3%', Infinity, -1]) {
      await assert.rejects(() => update({ compress: { maxContextLimit: value } }));
      assert.equal(engine.dcpConfig, before);
    }
    await assert.rejects(() => update({ compress: { minContextLimit: 1000, maxContextLimit: 999 } }));
    assert.equal(engine.dcpConfig, before);
  });
  await check('the manual command persists a session override without changing shared settings', async () => {
    await update({ manualMode: { enabled: false, automaticStrategies: false } });
    const result = await commands.get('dcp').handler({ rawInput: 'manual on', agent: { session } });
    assert.equal(result.kind, 'success');
    assert.equal(root.settings.get('dcp').manualMode.enabled, false);
    assert.equal(root.settings.get('dcp').manualMode.automaticStrategies, false);
    assert.equal(engine.dcpConfig.manualMode, false);
    assert.equal(engine.manualModeFor(session), true);
  });
  await check('prompt reset previews the actual fallback without the editor', async () => {
    const route = routes.find(route => route.path === '/ctxkit.dcp');
    assert.ok(route);
    const server = createServer(route.handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/ctxkit.dcp/prompts`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'test', method: 'prompts', payload: {} }) });
      const data = await response.json();
      assert.equal(data.result.value.liveSettings, true);
      assert.equal(Object.keys(data.result.value.defaults).length, 6);
      assert.ok(Object.values(data.result.value.defaults).every(text => typeof text === 'string' && text.length > 0));
      assert.ok(!JSON.stringify(data).includes('CUSTOM SYSTEM'));
      mkdirSync(join(home, 'xdg', 'opencode', 'dcp-prompts', 'overrides'), { recursive: true });
      writeFileSync(join(home, 'xdg', 'opencode', 'dcp-prompts', 'overrides', 'system.md'), 'FILE SYSTEM DEFAULT');
      await update({ experimental: { customPrompts: true } });
      const fallback = await fetch(`http://127.0.0.1:${server.address().port}/ctxkit.dcp/prompts`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'fallback', method: 'prompts', payload: {} }) });
      assert.equal((await fallback.json()).result.value.defaults.system, '<dcp-system-reminder>\nFILE SYSTEM DEFAULT\n</dcp-system-reminder>');
      assert.equal(engine.customPrompt('system'), '<dcp-system-reminder>\nCUSTOM SYSTEM\n</dcp-system-reminder>', 'preview must not change the active override');
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
} finally { await mount.dispose(); await provider.dispose(); }
assert.equal(tools.size, 0);
assert.equal(commands.size, 0);
await check('the DCP card exposes thresholds, six prompts and explained settings beside Advanced', () => {
  let client, card;
  const React = { createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => [initial, () => {}], useEffect() {}, useSyncExternalStore: (_subscribe, snapshot) => snapshot() };
  const window = new EventTarget();
  window.__ModuleLoader__ = { load: definition => { client = definition.factory(() => React); } };
  runInNewContext(readFileSync(new URL('../lib/edit-client.js', import.meta.url), 'utf8'), { window, Event });
  client.apply({ effect() {}, inject(names, body) {
    if (!names.includes('settingsScope')) return;
    body({ settingsScope: { bind: () => ({ getSnapshot: () => ({ status: 'ready', writable: true, value: plugin.Config({}) }) }) },
      slots: { inject: (_name, fn) => fn(), register: (spec, component) => { if (spec.key === 'dcp') card = component; } } });
  } });
  const rendered = JSON.stringify(card());
  for (const label of ['Reminder threshold', 'Context-limit threshold', 'Critical reminder every', 'Long-run reminder after',
    'System guidance', 'Context reminder', 'Long-run reminder', 'Context-limit reminder', 'Compress ranges', 'Compress messages',
    'Deduplicate tool results', 'Protect user messages', 'Allow DCP in subagents', 'Advanced configuration']) assert.ok(rendered.includes(label), 'missing control: ' + label);
  assert.match(rendered, /next.*step/i);
});
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
