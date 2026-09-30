/** Guard the DSH 0.1.7 Config-derived settings contract used by all host plugins. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { Context } from '@deepseek-ai/cordis';

let settingsConfigureCalls = 0;
const settings = { configure: () => { settingsConfigureCalls++; return () => {}; } };

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
const contextKit = await import('../lib/plugin.js');

assert.equal(dcp.Config({ enabled: false }).get().enabled, false);
assert.equal(contextMode.Config({ enabled: false }).get().enabled, false);
assert.equal(editor.Config({ enabled: true }).get().enabled, true);
const combined = contextKit.Config({
  dcp: { enabled: false },
  contextMode: { enabled: false },
  historyEditor: { enabled: true }
});
assert.equal(combined.dcp.get().enabled, false);
assert.equal(combined.contextMode.get().enabled, false);
assert.equal(combined.historyEditor.get().enabled, true);

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
const configureCallsBeforeCombined = settingsConfigureCalls;
await mount(contextKit, {
  dcp: { enabled: false },
  contextMode: { enabled: false },
  historyEditor: { enabled: false }
}, {
  tools,
  llm: {},
  tokenMeter: { measure: () => ({ nodes: [], totalTokens: 0 }), estimateMessage: () => 0 },
  sessions: {},
  commands: { register: () => () => {} },
  connection: {},
  webServer: { register: () => () => {}, tapIndex: () => () => {} }
});
assert.equal(settingsConfigureCalls - configureCallsBeforeCombined, 1, 'the combined fiber must register one settings presentation');

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
  getSnapshot: () => ({ status: 'ready', value: {
    dcp: { enabled: true, prompts: {} },
    contextMode: { enabled: true },
    historyEditor: { enabled: true }
  }, revision: 0, writable: true }),
  subscribe: () => () => {},
  mutate: async () => true
};
const requestedNamespaces = [];
client.apply({
  sessions: { list: { getSnapshot: () => ({}), subscribe: () => () => {} } },
  effect: effect => effect(),
  inject: (names, apply) => apply(names.includes('configForms')
    ? { configForms: { get: namespace => { requestedNamespaces.push(namespace); return form; } }, slots }
    : { slots })
});
assert.deepEqual(requestedNamespaces, ['context-kit-bundle']);
assert.equal(settingsTab?.spec.id, 'context-kit');
assert.equal(settingsTab.component().children[2].children.length, 3);

console.log('[ok] current DSH settings API activates the combined host plugin and its three settings cards');
