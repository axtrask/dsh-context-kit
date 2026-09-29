/** Guard the DSH 0.1.7 Config-derived settings contract used by all host plugins. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { Context } from '@deepseek-ai/cordis';

const settings = { configure: () => () => {} };

async function mount(module, config, services) {
  const root = new Context();
  root.provide('settings', settings);
  for (const [name, service] of Object.entries(services)) root.provide(name, service);
  const fiber = root.plugin(module, config);
  await fiber.await();
  assert.equal(fiber.state, 2, `${module.name} must activate`);
  await fiber.dispose();
}

const tools = { register: () => () => {} };
const dcp = await import('../lib/dcp-plugin.js');
const contextMode = await import('../lib/context-mode-plugin.js');
const editor = await import('../lib/editor-plugin.js');

assert.equal(dcp.Config({ enabled: false }).get().enabled, false);
assert.equal(contextMode.Config({ enabled: false }).get().enabled, false);
assert.equal(editor.Config({ enabled: true }).get().enabled, true);

await mount(dcp, { enabled: false }, {
  tools,
  llm: {},
  tokenMeter: { measure: () => ({ nodes: [], totalTokens: 0 }), estimateMessage: () => 0 },
  sessions: {}
});
await mount(contextMode, { enabled: false }, { tools });
await mount(editor, { enabled: true }, {
  commands: { register: () => () => {} },
  connection: {},
  webServer: { register: () => () => {}, tapIndex: () => () => {} }
});

let client;
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useEffect() {},
  useRef: initial => ({ current: initial }),
  useState: initial => [initial, () => {}],
  useSyncExternalStore: (_subscribe, snapshot) => snapshot()
};
const window = new EventTarget();
window.__ModuleLoader__ = { load: definition => { client = definition.factory(() => React); } };
runInNewContext(readFileSync(new URL('../lib/edit-client.js', import.meta.url), 'utf8'), { window, Event });
let settingsTab;
const slots = {
  inject: (_name, register) => register(),
  register: (spec, component) => {
    if (spec.name === 'settings.plugins.tab') settingsTab = { spec, component };
    return () => {};
  }
};
const form = {
  getSnapshot: () => ({ status: 'ready', value: {}, revision: 0, writable: true }),
  subscribe: () => () => {},
  mutate: async () => true
};
client.apply({
  sessions: { list: { getSnapshot: () => ({}), subscribe: () => () => {} } },
  effect: effect => effect(),
  inject: (names, apply) => apply(names.includes('configForms') ? { configForms: { get: () => form }, slots } : { slots })
});
assert.equal(settingsTab?.spec.id, 'context-kit');
assert.equal(settingsTab.component().children[2].children.length, 3);

console.log('[ok] current DSH settings API activates all three host plugins and their settings tab');
