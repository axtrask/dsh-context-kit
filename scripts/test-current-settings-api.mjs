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
const hookStates = [];
let hookIndex = 0;
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useEffect() {},
  useRef: initial => ({ current: initial }),
  useState(initial) {
    const index = hookIndex++;
    if (!(index in hookStates)) hookStates[index] = typeof initial === 'function' ? initial() : initial;
    return [hookStates[index], value => { hookStates[index] = typeof value === 'function' ? value(hookStates[index]) : value; }];
  },
  useSyncExternalStore: (_subscribe, snapshot) => snapshot()
};
const render = (Component, props = {}) => { hookIndex = 0; return Component(props); };
const findNode = (node, predicate) => {
  if (Array.isArray(node)) {
    for (const child of node) { const found = findNode(child, predicate); if (found) return found; }
    return undefined;
  }
  if (!node || typeof node !== 'object') return undefined;
  if (predicate(node)) return node;
  return findNode(node.children, predicate);
};
const nodeText = node => Array.isArray(node) ? node.map(nodeText).join('')
  : node && typeof node === 'object' ? nodeText(node.children) : typeof node === 'string' ? node : '';
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
const baseValue = {
  dcp: { enabled: true, prompts: {} },
  contextMode: { enabled: true },
  historyEditor: { enabled: true, requireIdle: true }
};
let formSnapshot = { status: 'ready', value: structuredClone(baseValue), base: structuredClone(baseValue), user: {}, revision: 0, writable: true };
let mutate = async () => true;
const form = {
  getSnapshot: () => formSnapshot,
  subscribe: () => () => {},
  mutate: (...args) => mutate(...args)
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
const settingsView = settingsTab.component();
assert.equal(settingsView.children[2].children.length, 3);
const historyCard = settingsView.children[2].children[2];

let card = render(historyCard.type, historyCard.props);
let advanced = findNode(card, node => node.props?.['aria-label'] === 'History Editor configuration JSON');
advanced.props.onChange({ target: { value: JSON.stringify({ requireIdle: true }, null, 2) } });
card = render(historyCard.type, historyCard.props);
let save = findNode(card, node => node.type === 'button' && node.props?.className === 'primary');
let writtenOps;
mutate = async ops => {
  writtenOps = structuredClone(ops);
  formSnapshot = { ...formSnapshot, user: { historyEditor: { enabled: true } }, revision: 1 };
  return true;
};
await save.props.onClick();
assert.deepEqual(writtenOps, [{ op: 'unset', path: ['historyEditor', 'enabled'] }]);
card = render(historyCard.type, historyCard.props);
save = findNode(card, node => node.type === 'button' && node.props?.className === 'primary');
assert.equal(save.props.disabled, true, 'an accepted unset materialized from the base layer must clear the draft');

hookStates.length = 0;
formSnapshot = { status: 'ready', value: structuredClone(baseValue), base: structuredClone(baseValue), user: {}, revision: 2, writable: true };
card = render(historyCard.type, historyCard.props);
advanced = findNode(card, node => node.props?.['aria-label'] === 'History Editor configuration JSON');
advanced.props.onChange({ target: { value: JSON.stringify({ enabled: false, requireIdle: true }, null, 2) } });
card = render(historyCard.type, historyCard.props);
save = findNode(card, node => node.type === 'button' && node.props?.className === 'primary');
mutate = async () => {
  formSnapshot = { ...formSnapshot, value: { ...formSnapshot.value, historyEditor: { enabled: false, requireIdle: true } } };
  return false;
};
await save.props.onClick();
card = render(historyCard.type, historyCard.props);
save = findNode(card, node => node.type === 'button' && node.props?.className === 'primary');
assert.equal(save.props.disabled, false, 'a refused mutation must keep the draft even when the published value happens to match');
assert.match(nodeText(findNode(card, node => node.props?.role === 'status')), /refused/i);

console.log('[ok] current DSH settings API activates the combined host plugin and its three settings cards');
