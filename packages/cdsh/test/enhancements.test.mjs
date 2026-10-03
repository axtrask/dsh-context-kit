import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  FOCUS_VIEW_ID,
  PLAN_COPY_ID,
  TURN_INSIGHTS_ID,
  installFocusView,
  installPlanCopy,
  installTurnInsights,
} from '../src/enhancements.mjs'
import { BRAND_ID, WORKSPACE_ID, WORKSPACE_KIND, installBrand, installWorkspace } from '../src/workspace.mjs'

function once(fn) {
  let closed = false
  return () => {
    if (closed) return
    closed = true
    fn?.()
  }
}

function disposerOf(value) {
  if (typeof value === 'function') return value
  if (value && typeof value.dispose === 'function') return () => value.dispose()
  return () => {}
}

function fakeReact() {
  class Component {
    constructor(props) {
      this.props = props
      this.state = {}
    }
  }
  return {
    Component,
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return {
        type,
        props: {
          ...(props || {}),
          children: children.length < 2 ? children[0] : children,
        },
      }
    },
    memo: value => value,
    useEffect: () => {},
    useLayoutEffect: () => {},
    useRef: value => ({ current: value }),
    useState: value => [typeof value === 'function' ? value() : value, () => {}],
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  }
}

function makeApi(enabled = true) {
  const statuses = []
  const listeners = new Set()
  return {
    statuses,
    getState: () => ({ enabled }),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    reportFeatureStatus(feature, status, detail) {
      statuses.push({ feature, status, detail })
    },
    emit() {
      for (const listener of [...listeners]) listener()
    },
  }
}

function makeSlots({ late = [], objectInject = false, objectRegister = false, throwInject = [], throwRegister = [] } = {}) {
  const lateOwners = new Set(late)
  const throwInjectOwners = new Set(throwInject)
  const throwRegisterNames = new Set(throwRegister)
  const pending = new Map()
  const registry = new Map()
  const counts = { injectDrops: 0, registerDrops: 0 }
  let activeOwner = null

  const asHandle = (drop, object) => object ? { dispose: once(drop) } : once(drop)
  const keyOf = options => options.name + ':' + (options.id || options.key)

  const slots = {
    inject(owner, mount) {
      if (throwInjectOwners.has(owner)) throw new Error('inject failed: ' + owner)
      let inner = null
      let closed = false
      const activate = () => {
        if (closed || inner) return
        activeOwner = owner
        try { inner = mount() } finally { activeOwner = null }
      }
      if (lateOwners.has(owner)) {
        const list = pending.get(owner) || []
        list.push(activate)
        pending.set(owner, list)
      } else {
        activate()
      }
      return asHandle(() => {
        if (closed) return
        closed = true
        counts.injectDrops++
        disposerOf(inner)()
      }, objectInject)
    },
    register(options, Component) {
      if (throwRegisterNames.has(options.name)) throw new Error('register failed: ' + options.name)
      const key = keyOf(options)
      if (registry.has(key)) throw new Error('duplicate registration: ' + key)
      const entry = { owner: activeOwner, options, Component }
      registry.set(key, entry)
      return asHandle(() => {
        counts.registerDrops++
        registry.delete(key)
      }, objectRegister)
    },
    trigger(owner) {
      lateOwners.delete(owner)
      for (const activate of pending.get(owner) || []) activate()
      pending.delete(owner)
    },
    registry,
    counts,
  }
  return slots
}

function makeWorkspaceContext(slots, { tabObject = false, effectObject = false } = {}) {
  const tabRegistry = new Map()
  let tabDrops = 0
  const tabHandle = drop => tabObject ? { dispose: once(drop) } : once(drop)
  const effectHandle = drop => effectObject ? { dispose: once(drop) } : once(drop)
  return {
    slots,
    sessions: { list: {} },
    uiConversation: {},
    sidebarRight: { openTab() {} },
    sidebarRightTabs: {
      register(definition) {
        if (tabRegistry.has(definition.id)) throw new Error('duplicate tab: ' + definition.id)
        tabRegistry.set(definition.id, definition)
        return tabHandle(() => {
          tabDrops++
          tabRegistry.delete(definition.id)
        })
      },
    },
    effect(factory) {
      const dispose = disposerOf(factory())
      return effectHandle(dispose)
    },
    tabRegistry,
    get tabDrops() { return tabDrops },
  }
}

function withoutWarnings(action) {
  const previous = console.warn
  console.warn = () => {}
  try { return action() } finally { console.warn = previous }
}

function assertBoundary(Component, api, feature) {
  const wrapped = Component({})
  assert.equal(typeof wrapped.type, 'function')
  assert.equal(typeof wrapped.type.prototype.render, 'function')
  const boundary = new wrapped.type(wrapped.props)
  assert.equal(typeof boundary.componentDidCatch, 'function')
  withoutWarnings(() => boundary.componentDidCatch(new Error(feature + ' render boom')))
  assert.equal(api.statuses.at(-1).feature, feature)
  assert.equal(api.statuses.at(-1).status, 'failed')
}

function renderRegistered(entry, props) {
  const wrapped = entry.Component(props)
  const child = wrapped && wrapped.props && wrapped.props.children
  assert.equal(typeof child?.type, 'function')
  return child.type(child.props)
}

function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props && node.props.children)
}

function findElement(node, predicate) {
  if (node === null || node === undefined || node === false) return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate)
      if (found) return found
    }
    return null
  }
  if (typeof node !== 'object') return null
  if (predicate(node)) return node
  return findElement(node.props && node.props.children, predicate)
}

const enhancementCases = [
  ['turnInsights', 'conversation.chat.turnTail', TURN_INSIGHTS_ID, installTurnInsights],
  ['planCopy', 'conversation.plan-review.actions', PLAN_COPY_ID, installPlanCopy],
  ['focusView', 'conversation.view', FOCUS_VIEW_ID, installFocusView],
]

test('enhancement owners can arrive late and keep stable unique IDs across remounts', () => {
  const owners = enhancementCases.map(([, owner]) => owner)
  const slots = makeSlots({ late: owners, objectInject: true, objectRegister: true })
  const api = makeApi()
  const React = fakeReact()
  const drops = enhancementCases.map(([, , , install]) => install({ slots }, api, React))
  assert.equal(slots.registry.size, 0)

  for (const [feature, owner, id] of enhancementCases) {
    slots.trigger(owner)
    const entry = slots.registry.get(owner + ':' + id)
    assert.ok(entry, feature + ' registered after its owner became available')
    assert.equal(entry.options.id, id)
    assert.equal(api.statuses.findLast(item => item.feature === feature)?.status, 'active')
  }

  for (const drop of drops) { drop(); drop() }
  assert.equal(slots.registry.size, 0)
  assert.equal(slots.counts.injectDrops, 3)
  assert.equal(slots.counts.registerDrops, 3)
  for (const [feature] of enhancementCases) {
    assert.equal(api.statuses.findLast(item => item.feature === feature)?.status, 'waiting')
  }

  const remount = installFocusView({ slots }, api, React)
  assert.ok(slots.registry.has('conversation.view:' + FOCUS_VIEW_ID))
  remount()
})

test('each enhancement is wrapped in a render error boundary', () => {
  const slots = makeSlots()
  const api = makeApi()
  const React = fakeReact()
  const drops = enhancementCases.map(([feature, owner, id, install]) => {
    const drop = install({ slots }, api, React)
    assertBoundary(slots.registry.get(owner + ':' + id).Component, api, feature)
    return drop
  })
  for (const drop of drops) drop()
})

test('Turn Insights reads TurnLocation.turn and Focus uses native navigation items and openView contract', () => {
  const slots = makeSlots()
  const api = makeApi()
  const React = fakeReact()
  const turnDrop = installTurnInsights({ slots }, api, React)
  let requestedTurn = null
  const chat = {
    locations: { getTurn(turn) { requestedTurn = turn; return ['step', 'tool'] } },
    nodes: new Map([['step', { kind: 'assistant-step' }], ['tool', { kind: 'tool-call' }]]),
    legacy: { turnTimings: new Map([[7, { startTime: 1000, endTime: 2500 }]]) },
  }
  const insight = renderRegistered(slots.registry.get('conversation.chat.turnTail:' + TURN_INSIGHTS_ID), {
    turn: { turn: 7, anchorKey: 'turn-7' },
    useChat: selector => selector(chat),
  })
  assert.equal(requestedTurn, 7)
  assert.match(textOf(insight), /Turn 7 · 1 step · 1 action · 1\.5 s/)

  const focusDrop = installFocusView({ slots }, api, React)
  const items = [
    { turn: 3, anchorKey: 'anchor-3', prompt: 'First prompt', response: 'First response' },
    { turn: 9, anchorKey: 'anchor-9', prompt: 'Latest prompt', response: 'Latest response' },
  ]
  let itemsCalls = 0
  let selectedItems = null
  const opened = []
  const focus = renderRegistered(slots.registry.get('conversation.view:' + FOCUS_VIEW_ID), {
    useChat(selector) {
      selectedItems = selector({ navigation: { items() { itemsCalls++; return items } } })
      return selectedItems
    },
    openView: (...args) => opened.push(args),
  })
  assert.equal(selectedItems, items)
  assert.equal(itemsCalls, 1)
  const nativeChat = findElement(focus, node => node.type === 'button' && textOf(node) === 'Native Chat')
  assert.ok(nativeChat)
  nativeChat.props.onClick()
  assert.deepEqual(opened, [['chat', 'anchor-9']])

  const firstTurn = findElement(focus, node => node.type === 'button' && textOf(node).includes('Turn 3'))
  assert.ok(firstTurn)
  firstTurn.props.onClick()
  assert.deepEqual(opened.at(-1), ['chat', 'anchor-3'])
  turnDrop()
  focusDrop()
})

test('enhancements degrade safely when React, Slots, injection, or registration is unavailable', () => {
  const React = fakeReact()
  for (const [feature, owner, , install] of enhancementCases) {
    const missingApi = makeApi()
    assert.doesNotThrow(() => install({}, missingApi, React)())
    assert.equal(missingApi.statuses.at(-1).status, 'unsupported')

    const injectApi = makeApi()
    assert.doesNotThrow(() => install({ slots: makeSlots({ throwInject: [owner] }) }, injectApi, React)())
    assert.equal(injectApi.statuses.at(-1).status, 'failed')

    const registerApi = makeApi()
    assert.doesNotThrow(() => withoutWarnings(() => install({ slots: makeSlots({ throwRegister: [owner] }) }, registerApi, React)()))
    assert.equal(registerApi.statuses.at(-1).feature, feature)
    assert.equal(registerApi.statuses.at(-1).status, 'failed')
  }
})

test('brand supports late owner activation, object disposers, remounting, and a render boundary', () => {
  const slots = makeSlots({ late: ['sidebar.brand.name'], objectInject: true, objectRegister: true })
  const api = makeApi()
  const React = fakeReact()
  const drop = installBrand({ slots }, api, React)
  assert.equal(slots.registry.size, 0)
  slots.trigger('sidebar.brand.name')
  const entry = slots.registry.get('sidebar.brand.name:' + BRAND_ID)
  assert.ok(entry)
  assertBoundary(entry.Component, api, 'brand')
  drop(); drop()
  assert.equal(slots.counts.injectDrops, 1)
  assert.equal(slots.counts.registerDrops, 1)
  assert.equal(api.statuses.findLast(item => item.feature === 'brand')?.status, 'waiting')
  const remount = installBrand({ slots }, api, React)
  assert.ok(slots.registry.has('sidebar.brand.name:' + BRAND_ID))
  remount()
})

test('workspace core waits for its owner and registers tab definition plus pane atomically', () => {
  const slots = makeSlots({ late: ['sidebar.right.pane.tab', 'conversation.session.header.utilities'], objectInject: true, objectRegister: true })
  const api = makeApi()
  const React = fakeReact()
  const ctx = makeWorkspaceContext(slots, { tabObject: true, effectObject: true })
  const drop = installWorkspace(ctx, api, React)
  assert.equal(ctx.tabRegistry.size, 0)
  assert.equal(slots.registry.size, 0)

  slots.trigger('sidebar.right.pane.tab')
  assert.ok(ctx.tabRegistry.has(WORKSPACE_ID))
  const pane = slots.registry.get('sidebar.right.pane.tab:' + WORKSPACE_ID)
  assert.ok(pane)
  assert.equal(api.statuses.findLast(item => item.feature === 'workspace')?.status, 'active')
  assertBoundary(pane.Component, api, 'workspace')

  slots.trigger('conversation.session.header.utilities')
  assert.ok(slots.registry.has('conversation.session.header.utilities:' + WORKSPACE_ID))
  drop(); drop()
  assert.equal(ctx.tabRegistry.size, 0)
  assert.equal(slots.registry.size, 0)
  assert.equal(ctx.tabDrops, 1)
})

test('workspace launcher opens the selected session pane without a stale sessions.list.current gate', () => {
  const slots = makeSlots()
  const api = makeApi()
  const React = fakeReact()
  const ctx = makeWorkspaceContext(slots)
  const opened = []
  ctx.sidebarRight.openTab = (...args) => opened.push(args)
  const drop = installWorkspace(ctx, api, React)
  const entry = slots.registry.get('conversation.session.header.utilities:' + WORKSPACE_ID)
  const launcher = renderRegistered(entry, { sessionId: 'selected-session' })
  assert.equal(launcher.type, 'button')
  assert.equal(launcher.props.disabled, undefined)
  launcher.props.onClick()
  assert.deepEqual(opened, [[WORKSPACE_KIND, { params: undefined }]])
  drop()
})

test('workspace rolls back the tab definition when pane registration fails', () => {
  const slots = makeSlots({ throwRegister: ['sidebar.right.pane.tab'], objectInject: true, objectRegister: true })
  const api = makeApi()
  const ctx = makeWorkspaceContext(slots, { tabObject: true, effectObject: true })
  assert.throws(() => installWorkspace(ctx, api, fakeReact()), /register failed: sidebar\.right\.pane\.tab/)
  assert.equal(ctx.tabRegistry.size, 0)
  assert.equal(ctx.tabDrops, 1)
  assert.equal(api.statuses.findLast(item => item.feature === 'workspace')?.status, 'failed')
})

test('workspace launcher failure does not roll back an active core', () => {
  const slots = makeSlots({ throwInject: ['conversation.session.header.utilities'], objectInject: true, objectRegister: true })
  const api = makeApi()
  const ctx = makeWorkspaceContext(slots, { tabObject: true, effectObject: true })
  const drop = withoutWarnings(() => installWorkspace(ctx, api, fakeReact()))
  assert.ok(ctx.tabRegistry.has(WORKSPACE_ID))
  assert.ok(slots.registry.has('sidebar.right.pane.tab:' + WORKSPACE_ID))
  assert.equal(api.statuses.findLast(item => item.feature === 'workspace')?.status, 'active')
  drop()
  assert.equal(ctx.tabRegistry.size, 0)
  assert.equal(slots.registry.size, 0)
})

test('workspace and brand report unsupported instead of throwing on malformed capabilities', () => {
  const api = makeApi()
  assert.doesNotThrow(() => installBrand({}, api, fakeReact())())
  assert.equal(api.statuses.at(-1).status, 'unsupported')
  assert.doesNotThrow(() => installWorkspace({ slots: {} }, api, fakeReact())())
  assert.equal(api.statuses.at(-1).feature, 'workspace')
  assert.equal(api.statuses.at(-1).status, 'unsupported')
})
