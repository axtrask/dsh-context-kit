import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

test('context details survive conversation autoscroll and dismiss on outside input', () => {
  const source = readFileSync(new URL('../lib/edit-client.js', import.meta.url), 'utf8');
  const component = source.slice(source.indexOf('function ContextReadout('), source.indexOf("viewCtx.slots.inject('conversation.input.right'"));
  const states = [], effects = [], listeners = new Map();
  let cursor = 0, effectCursor = 0, refCursor = 0;
  const button = { getBoundingClientRect: () => ({ left: 300, top: 700 }), focus() {} };
  const runningRef = { current: false };
  const root = { current: { contains: target => target === button, querySelector: () => button } };
  const events = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useRef: () => refCursor++ === 0 ? runningRef : root,
    useState(value) { const i = cursor++; if (!(i in states)) states[i] = value; return [states[i], next => { states[i] = typeof next === 'function' ? next(states[i]) : next; }]; },
    useEffect(setup, deps) { const i = effectCursor++, old = effects[i]; if (!old || deps.some((v, j) => v !== old.deps[j])) { old?.cleanup?.(); effects[i] = { deps, cleanup: setup() }; } },
  };
  const renderComponent = vm.runInNewContext('(' + component.trim() + ')', {
    React,
    h: React.createElement,
    bindSelectedSession: () => () => {},
    document: events,
    window: { ...events, innerWidth: 1280, innerHeight: 800 }
  });
  const render = () => { cursor = 0; effectCursor = 0; refCursor = 0; return renderComponent({ sessionId: 'A', useProjection: () => ({ projectedTokens: 212278, contextWindow: 1000000 }), useSessionStatus: () => false }); };
  const trigger = tree => tree.children.find(child => child?.type === 'button');
  trigger(render()).props.onClick({ currentTarget: button });
  assert.equal(trigger(render()).props['aria-expanded'], true);
  listeners.get('scroll')({ target: {} });
  assert.equal(trigger(render()).props['aria-expanded'], true, 'Conversation autoscroll dismissed context details');
  listeners.get('resize')({ target: {} });
  assert.equal(trigger(render()).props['aria-expanded'], true);
  listeners.get('pointerdown')({ target: {} });
  assert.equal(trigger(render()).props['aria-expanded'], false);
  trigger(render()).props.onClick({ currentTarget: button });
  render();
  listeners.get('keydown')({ key: 'Escape' });
  assert.equal(trigger(render()).props['aria-expanded'], false);
  for (const effect of effects) effect.cleanup?.();
});
