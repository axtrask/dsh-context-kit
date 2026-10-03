import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  PROCESS_FLOW_SELECTOR,
  TOOL_GRID_ATTR,
  TOOL_MOTION_ATTR,
  TOOL_STAGE_ATTR,
  TOOL_TIME_ATTR,
  collectToolTimes,
  createToolTimeCache,
  formatToolTimestamp,
  installToolMotion,
  mergeToolTimes,
  reflowToolGrid,
  syncToolTimestamps,
  toolMotionCss,
} from '../src/tool-motion.mjs'

function fakeNode(rect) {
  const attrs = new Map()
  const calls = []
  return {
    nodeType: 1,
    rect,
    calls,
    getBoundingClientRect() { return this.rect },
    setAttribute(name, value) { attrs.set(name, String(value)) },
    removeAttribute(name) { attrs.delete(name) },
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null },
    hasAttribute(name) { return attrs.has(name) },
    animate(frames, options) {
      calls.push({ frames, options })
      return { cancel() {}, finished: Promise.resolve() }
    },
  }
}

function fakeToolRow(callId, options = {}) {
  const row = fakeNode({ left: 0, top: 0, width: 100, height: 32 })
  const key = '9:tool-call' + callId
  row.setAttribute('data-chat-flow-kind', options.kind || 'tool-call')
  row.setAttribute('data-chat-node-key', options.nodeKey || key)
  row.setAttribute('data-chat-flow-key', options.flowKey || key)
  if (options.hidden) row.setAttribute('hidden', options.hidden === true ? '' : options.hidden)
  if (options.processHidden) row.setAttribute('data-turn-process-hidden', 'true')
  if (options.staged) row.setAttribute(TOOL_STAGE_ATTR, 'wide')
  row.querySelector = selector => {
    if (selector === TERMINAL_FOR_TEST) return options.terminal === false ? null : {}
    if (selector === '[data-state="running"]') return options.running ? {} : null
    if (selector === CLOSED_FOR_TEST) return options.closed === false ? null : {}
    return null
  }
  return row
}

const TERMINAL_FOR_TEST = '[data-state="ok"],[data-state="error"],[data-state="stopped"],[data-state="cancelled"]'
const CLOSED_FOR_TEST = '[data-disclosure-row][aria-expanded="false"],[data-sample="bash"][data-variant="bash"][aria-expanded="false"]'

test('tool grid is scoped to native grouped-process content and keeps native outer flow untouched', () => {
  assert.match(toolMotionCss, /\[data-step-process-content\]\[data-chat-flow\]\[data-cdsh-tool-grid="active"\]/)
  assert.match(toolMotionCss, /flex-basis:33\.3333%/)
  assert.match(toolMotionCss, /:not\(\[hidden\]\):not\(\[data-turn-process-hidden="true"\]\)/)
  assert.match(toolMotionCss, /data-cdsh-tool-stage="wide"[\s\S]+flex-basis:100%/)
  assert.match(toolMotionCss, /data-state="running"[\s\S]+flex-basis:100%/)
  assert.match(toolMotionCss, /aria-expanded="true"/)
  assert.match(toolMotionCss, /data-chat-flow-kind="tool-call"\]\[data-cdsh-tool-time\][\s\S]+content:attr\(data-cdsh-tool-time\)/)
  assert.match(toolMotionCss, /color:var\(--dsw-alias-label-secondary\)/)
  assert.match(toolMotionCss, /pointer-events:none/)
  assert.match(toolMotionCss, /padding-right:46px/)
  assert.match(toolMotionCss, /prefers-reduced-motion: reduce/)
  assert.doesNotMatch(toolMotionCss, /\[data-slot="main"\]\s*>/)
  assert.equal(PROCESS_FLOW_SELECTOR, '[data-step-process-content][data-chat-flow]')
})

test('settled native tool nodes provide exact recorded completion clocks', () => {
  const completion = new Date(2026, 1, 10, 23, 59, 45).getTime()
  const nodes = {
    values: () => [
      { key: '9:tool-callcall_a', kind: 'tool-call', data: { root: { kind: 'tool-result', time: completion, callTime: completion - 5000 } } },
      { key: '9:tool-callcall_pending', kind: 'tool-call', data: { root: { kind: 'tool-call', time: completion - 1000 } } },
      { key: '9:tool-callcall_nested', kind: 'tool-call', data: { root: { kind: 'tool-call', nested: { kind: 'tool-result', time: completion } } } },
      { key: '11:tool-resultcall_other', kind: 'tool-result', data: { root: { kind: 'tool-result', time: completion } } },
    ],
  }
  const completed = collectToolTimes(nodes)
  assert.deepEqual(Array.from(completed), [['9:tool-callcall_a', completion]])
  assert.equal(formatToolTimestamp(completion), '23:59')
  assert.equal(formatToolTimestamp(0), '')
  assert.equal(formatToolTimestamp(Number.NaN), '')
})

test('active partial snapshots retain clocks already observed in the same session', () => {
  const firstTime = new Date(2026, 1, 10, 23, 58, 45).getTime()
  const secondTime = new Date(2026, 1, 10, 23, 59, 45).getTime()
  const settled = {
    values: () => [
      { key: '9:tool-callcall_old', kind: 'tool-call', data: { root: { kind: 'tool-result', time: firstTime } } },
    ],
  }
  const activePartial = {
    values: () => [
      { key: '9:tool-callcall_running', kind: 'tool-call', data: { root: { kind: 'tool-call', time: secondTime } } },
    ],
  }
  const completed = mergeToolTimes(new Map(), settled)
  const duringCall = mergeToolTimes(completed, activePartial)

  assert.deepEqual(Array.from(duringCall), [['9:tool-callcall_old', firstTime]])
  const row = fakeToolRow('call_old')
  syncToolTimestamps({ children: [row] }, duringCall)
  assert.equal(row.getAttribute(TOOL_TIME_ATTR), '23:58')
})

test('session clock cache survives owner remounts, ignores stale cleanup and isolates switchback', () => {
  const firstTime = new Date(2026, 1, 10, 23, 58, 45).getTime()
  const secondTime = new Date(2026, 1, 10, 23, 59, 45).getTime()
  const settled = (key, time) => ({
    values: () => [{ key, kind: 'tool-call', data: { root: { kind: 'tool-result', time } } }],
  })
  const partial = { values: () => [{ key: '9:tool-callcall_running', kind: 'tool-call', data: { root: { kind: 'tool-call' } } }] }
  const firstOwner = {}
  const replacement = {}
  const remountedAfterCleanup = {}
  const otherSessionOwner = {}
  const cache = createToolTimeCache(2)

  let selected = cache.accept(settled('9:tool-callcall_old', firstTime), firstOwner, 'session-a')
  assert.deepEqual(Array.from(selected), [['9:tool-callcall_old', firstTime]])

  // The replacement's first projection is partial, but the session clock stays.
  selected = cache.accept(partial, replacement, 'session-a')
  assert.deepEqual(Array.from(selected), [['9:tool-callcall_old', firstTime]])
  selected = cache.accept(null, firstOwner, 'session-a')
  assert.deepEqual(Array.from(selected), [['9:tool-callcall_old', firstTime]])
  selected = cache.accept(null, replacement, 'session-a')
  selected = cache.accept(partial, remountedAfterCleanup, 'session-a')
  assert.deepEqual(Array.from(selected), [['9:tool-callcall_old', firstTime]])

  selected = cache.accept(settled('9:tool-callcall_other', secondTime), otherSessionOwner, 'session-b')
  assert.deepEqual(Array.from(selected), [['9:tool-callcall_other', secondTime]])
  selected = cache.accept(partial, {}, 'session-a')
  assert.deepEqual(Array.from(selected), [['9:tool-callcall_old', firstTime]])

  cache.accept(partial, {}, 'session-c')
  assert.equal(cache.size(), 2)
  assert.deepEqual(Array.from(cache.clear()), [])
  assert.equal(cache.size(), 0)
  assert.deepEqual(Array.from(cache.accept(partial, {}, 'session-a')), [])
})

test('completion clocks stamp compact terminal tools only and clear on wrapper reuse', () => {
  const completion = new Date(2026, 1, 10, 23, 59, 45).getTime()
  const completed = new Map([
    ['9:tool-callcall_a', completion],
    ['9:tool-callcall_fallback', completion],
  ])
  const compact = fakeToolRow('call_a', { flowKey: '9:tool-callwrong' })
  const fallback = fakeToolRow('call_fallback')
  fallback.removeAttribute('data-chat-node-key')
  const expanded = fakeToolRow('call_a', { closed: false })
  const running = fakeToolRow('call_a', { running: true })
  const staged = fakeToolRow('call_a', { staged: true })
  const hidden = fakeToolRow('call_a', { hidden: true })
  const processHidden = fakeToolRow('call_a', { processHidden: true })
  const thinking = fakeToolRow('call_a', { kind: 'assistant-step' })
  const rows = [compact, fallback, expanded, running, staged, hidden, processHidden, thinking]
  const stamped = new Set()
  syncToolTimestamps({ children: rows }, completed, stamped)
  assert.equal(compact.getAttribute(TOOL_TIME_ATTR), '23:59')
  assert.equal(fallback.getAttribute(TOOL_TIME_ATTR), '23:59')
  assert.deepEqual(Array.from(stamped), [compact, fallback])
  for (const row of rows.slice(2)) assert.equal(row.getAttribute(TOOL_TIME_ATTR), null)

  compact.setAttribute('data-chat-node-key', '9:tool-callcall_reused')
  syncToolTimestamps({ children: [compact] }, completed)
  assert.equal(compact.getAttribute(TOOL_TIME_ATTR), null)
})

test('identity attribute reuse schedules a flush that clears a stale timestamp', () => {
  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    MutationObserver: globalThis.MutationObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  }
  const row = fakeToolRow('call_old')
  const flowAttrs = new Map()
  const flow = {
    nodeType: 1,
    children: [row],
    matches: selector => selector === PROCESS_FLOW_SELECTOR,
    setAttribute(name, value) { flowAttrs.set(name, String(value)) },
    removeAttribute(name) { flowAttrs.delete(name) },
  }
  row.closest = selector => selector === PROCESS_FLOW_SELECTOR ? flow : null
  const frames = []
  let observer
  class Observer {
    constructor(fn) { this.fn = fn; this.options = null; observer = this }
    observe(target, options) { this.options = options }
    disconnect() {}
    emitAttribute(target, name) {
      if (this.options && this.options.attributeFilter.includes(name)) {
        this.fn([{ type: 'attributes', target, attributeName: name }])
      }
    }
  }
  globalThis.document = { body: {}, querySelectorAll: () => [flow] }
  globalThis.window = { matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} }
  globalThis.MutationObserver = Observer
  globalThis.requestAnimationFrame = fn => { frames.push(fn); return frames.length }
  globalThis.cancelAnimationFrame = () => {}

  try {
    const dispose = installToolMotion({}, { getState: () => ({ enabled: true }), subscribe: () => () => {} })
    const changes = [
      ['data-chat-node-key', '9:tool-callcall_reused'],
      ['data-chat-flow-key', '9:tool-callcall_reused'],
      ['data-chat-flow-kind', 'assistant-step'],
    ]
    for (const [name, value] of changes) {
      row.setAttribute(TOOL_TIME_ATTR, '23:59')
      row.setAttribute(name, value)
      observer.emitAttribute(row, name)
      assert.equal(frames.length, 1, name + ' must schedule reconciliation')
      frames.shift()()
      assert.equal(row.getAttribute(TOOL_TIME_ATTR), null, name + ' must clear the stale clock')
    }
    dispose()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
  }
})

test('terminal full-width action lands into a one-third cell with FLIP motion', () => {
  const action = fakeNode({ left: 0, top: 0, width: 100, height: 32 })
  const moved = fakeNode({ left: 0, top: 40, width: 300, height: 24 })
  const flow = { children: [action, moved] }
  const before = new Map([
    [action, { left: 0, top: 0, width: 300, height: 120 }],
    [moved, { left: 0, top: 140, width: 300, height: 24 }],
  ])

  const after = reflowToolGrid(flow, before, { animate: true })
  assert.equal(after.get(action).width, 100)
  assert.equal(action.calls.length, 1)
  assert.match(action.calls[0].frames[0].transform, /scaleX\(3\)/)
  assert.equal(action.calls[0].options.duration, 220)
  assert.equal(moved.calls.length, 1)
  assert.match(moved.calls[0].frames[0].transform, /translate3d\(0px,100px,0\)/)
})

test('new running action gets a bounded birth animation after the grid is primed', () => {
  const old = fakeNode({ left: 0, top: 0, width: 100, height: 32 })
  const born = fakeNode({ left: 0, top: 40, width: 300, height: 40 })
  const before = new Map([[old, { left: 0, top: 0, width: 100, height: 32 }]])
  reflowToolGrid({ children: [old, born] }, before, { animate: true })
  assert.equal(born.calls.length, 1)
  assert.deepEqual(born.calls[0].frames[0], { opacity: 0, transform: 'translate3d(0,8px,0)' })
  assert.equal(born.calls[0].options.duration, 180)
})

test('reduced-motion preference suppresses all Web Animations', () => {
  const savedWindow = globalThis.window
  globalThis.window = { matchMedia: () => ({ matches: true }) }
  try {
    const action = fakeNode({ left: 0, top: 0, width: 100, height: 32 })
    reflowToolGrid({ children: [action] }, new Map([[action, { left: 0, top: 0, width: 300, height: 80 }]]), { animate: true })
    assert.equal(action.calls.length, 0)
  } finally {
    if (savedWindow === undefined) delete globalThis.window
    else globalThis.window = savedWindow
  }
})

test('new direct action is staged full-width for one frame before terminal landing', () => {
  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    MutationObserver: globalThis.MutationObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  }
  const old = fakeNode({ left: 0, top: 0, width: 100, height: 32 })
  const born = fakeNode({ left: 0, top: 40, width: 100, height: 32 })
  born.matches = () => true
  born.getBoundingClientRect = function () {
    return this.getAttribute(TOOL_STAGE_ATTR) === 'wide'
      ? { left: 0, top: 40, width: 300, height: 32 }
      : { left: 0, top: 40, width: 100, height: 32 }
  }
  const attrs = new Map()
  const flow = {
    nodeType: 1,
    children: [old],
    matches: selector => selector === PROCESS_FLOW_SELECTOR,
    setAttribute(name, value) { attrs.set(name, String(value)) },
    removeAttribute(name) { attrs.delete(name) },
  }
  let observer
  const frames = []
  class Observer {
    constructor(fn) { this.fn = fn; observer = this }
    observe() {}
    disconnect() {}
  }
  globalThis.document = { body: {}, querySelectorAll: () => [flow] }
  globalThis.window = { matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} }
  globalThis.MutationObserver = Observer
  globalThis.requestAnimationFrame = fn => { frames.push(fn); return frames.length }
  globalThis.cancelAnimationFrame = () => {}

  try {
    const dispose = installToolMotion({}, { getState: () => ({ enabled: true }), subscribe: () => () => {} })
    flow.children.push(born)
    observer.fn([{ type: 'childList', target: flow, addedNodes: [born], removedNodes: [] }])
    assert.equal(born.getAttribute(TOOL_STAGE_ATTR), 'wide')
    assert.equal(frames.length, 1)
    frames.shift()()
    assert.equal(born.getAttribute(TOOL_STAGE_ATTR), null)
    assert.equal(frames.length, 1)
    frames.shift()()
    assert.equal(born.calls.length, 2)
    assert.equal(born.calls[0].options.duration, 180)
    assert.match(born.calls[1].frames[0].transform, /scaleX\(3\)/)
    dispose()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
  }
})

test('installer marks grouped flows and unconditionally cleans observer, subscription and attributes', () => {
  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    MutationObserver: globalThis.MutationObserver,
  }
  const child = fakeNode({ left: 0, top: 0, width: 300, height: 40 })
  const attrs = new Map()
  const flow = {
    children: [child],
    setAttribute(name, value) { attrs.set(name, String(value)) },
    removeAttribute(name) { attrs.delete(name) },
  }
  let disconnected = 0
  let unsubscribed = 0
  let sourceDisposed = 0
  let injectedSlot = null
  let registeredEntry = null
  let dependency = null
  const slots = {
    inject(name, mount) {
      injectedSlot = name
      const drop = mount()
      return () => { drop(); sourceDisposed += 1 }
    },
    register(options) {
      registeredEntry = options
      return () => { sourceDisposed += 1 }
    },
  }
  class Observer {
    constructor(fn) { this.fn = fn }
    observe() {}
    disconnect() { disconnected += 1 }
  }
  globalThis.document = { body: {}, querySelectorAll: () => [flow] }
  globalThis.window = {
    matchMedia: () => ({ matches: false }),
    addEventListener() {},
    removeEventListener() {},
  }
  globalThis.MutationObserver = Observer

  try {
    const ctx = {
      get slots() { throw new Error('slots must be entered through inject') },
      inject(keys, mount) {
        dependency = keys
        return mount({ slots })
      },
    }
    const dispose = installToolMotion(ctx, {
      getState: () => ({ enabled: true, regions: { toolCards: { enabled: true } } }),
      subscribe: () => () => { unsubscribed += 1 },
    })
    assert.deepEqual(dependency, ['slots'])
    assert.equal(attrs.get(TOOL_GRID_ATTR), 'active')
    assert.equal(injectedSlot, 'conversation.input.dock')
    assert.equal(registeredEntry.id, 'cdsh/tool-times')
    child.setAttribute(TOOL_TIME_ATTR, '23:59')
    assert.equal(child.getAttribute(TOOL_TIME_ATTR), '23:59')
    dispose()
    assert.equal(attrs.has(TOOL_GRID_ATTR), false)
    assert.equal(child.getAttribute(TOOL_MOTION_ATTR), null)
    assert.equal(child.getAttribute(TOOL_TIME_ATTR), null)
    assert.equal(disconnected, 1)
    assert.equal(unsubscribed, 1)
    assert.equal(sourceDisposed, 2)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
  }
})
