import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const times = readFileSync(new URL('./times.mjs', import.meta.url), 'utf8')
const style = readFileSync(new URL('./faithful-style.mjs', import.meta.url), 'utf8')
const instrumented = times + '\nexport { lifecycleState, chipped, runningAction, terminalAction, scopedThinkRoots, hasExpandedDisclosure, syncExecution, morphCells, kidResize, startBirth, startMorph, morphRuns, cellRects }; export function setFlowForTest(flow, height) { observedFlow = flow; lastFlowHeight = height }\n'
const internals = await import('data:text/javascript;base64,' + Buffer.from(instrumented).toString('base64'))

test('the execution slot is state on the real native wrapper, never a fabricated child', () => {
  assert.match(times, /const EXEC_ATTR = 'data-dsu-exec'/)
  assert.match(times, /function syncExecution\(flow, animate\)/)
  assert.match(times, /document\.startViewTransition/)
  assert.match(style, /\[data-dsu-exec="current"\][^}]+flex:0 0 100%/)
  assert.match(style, /::view-transition-group\(dsu-exec-tool\)[^}]+animation-duration:220ms/)
  assert.doesNotMatch(times, /appendChild|createElement\(|data-dsu-slot|__dsuSlot|slotBusy|slotHold|slotRelease|slotStep|SLOT_BASE|SLOT_MAX/)
  assert.doesNotMatch(style, /data-dsu-slot|dsu-breathe/)
})

test('only genuine running tool wrappers qualify for the execution lane', () => {
  function cell(kind, state, markdown = false) {
    return {
      getAttribute(name) { return name === 'data-chat-flow-kind' ? kind : null },
      querySelector(selector) {
        if (selector === '[data-disclosure-row]') return {}
        if (selector === '[class*="markdown"]') return markdown ? {} : null
        if (selector === '[data-state="running"]') return state === 'running' ? {} : null
        if (selector.includes('[data-state="ok"]')) return state === 'ok' ? {} : null
        return null
      },
    }
  }
  assert.equal(internals.runningAction(cell('tool-call', 'running')), true)
  assert.equal(internals.runningAction(cell('assistant-step', 'running')), true)
  assert.equal(internals.runningAction(cell('assistant-step', 'running', true)), false)
  assert.equal(internals.runningAction(cell('model-retry', 'running')), false)
  assert.equal(internals.runningAction(cell('context', 'running')), false)
})

test('lifecycle follows the disclosure card owner, not arbitrary nested data-state', () => {
  const owner = { getAttribute(name) { return name === 'data-state' ? 'ok' : null } }
  const row = { closest(selector) { return selector === '[data-state]' ? owner : null } }
  const cell = {
    contains(node) { return node === owner },
    getAttribute(name) { return name === 'data-chat-flow-kind' ? 'tool-call' : null },
    querySelector(selector) {
      if (selector === '[data-disclosure-row]') return row
      if (selector === '[class*="markdown"]') return null
      if (selector === '[data-state="running"]') return {} // nested subcall must be ignored
      return null
    },
  }
  assert.equal(internals.lifecycleState(cell), 'ok')
  assert.equal(internals.runningAction(cell), false)
  assert.equal(internals.terminalAction(cell), true)
})

test('multi-root Think lifecycle gives running priority and any expanded row restores full width', () => {
  let states = ['ok', 'running']
  let expanded = ['false', 'false']
  let cell
  const roots = [0, 1].map(index => ({
    getAttribute(name) { return name === 'data-state' ? states[index] : null },
    closest(selector) { return selector === '[data-chat-flow-key]' ? cell : null },
  }))
  const rows = [0, 1].map(index => ({
    getAttribute(name) { return name === 'aria-expanded' ? expanded[index] : null },
    closest(selector) {
      if (selector === '[data-chat-flow-key]') return cell
      if (selector === '[data-state]') return roots[index]
      return null
    },
  }))
  cell = {
    getAttribute(name) { return name === 'data-chat-flow-kind' ? 'assistant-step' : null },
    contains(node) { return roots.includes(node) || rows.includes(node) },
    querySelector(selector) {
      if (selector === '[data-disclosure-row]') return rows[0]
      if (selector === '[class*="markdown"]') return null
      return null
    },
    querySelectorAll(selector) {
      if (selector === '[data-variant="think"][data-state]') return roots
      if (selector === '[data-disclosure-row][aria-expanded="true"]') return rows.filter((_, index) => expanded[index] === 'true')
      return []
    },
  }
  assert.equal(internals.lifecycleState(cell), 'running', 'a later streaming Think cannot be hidden by an earlier ok root')
  assert.equal(internals.runningAction(cell), true)
  assert.equal(internals.terminalAction(cell), false)

  states = ['ok', 'ok']
  assert.equal(internals.lifecycleState(cell), 'ok')
  assert.equal(internals.terminalAction(cell), true)
  assert.equal(internals.chipped(cell), true)

  expanded = ['false', 'true']
  assert.equal(internals.hasExpandedDisclosure(cell), true)
  assert.equal(internals.chipped(cell), false, 'opening any meaningful Think row restores the whole step')
  assert.match(style, /DISCLOSURE_FINISHED[^\n]+:not\(:has\(\[data-disclosure-row\]\[aria-expanded="true"\]\)\)/)
})

test('shipped Bash and stopped lifecycles use the real wrapper and land as a closed chip', () => {
  const attrs = new Map([
    ['data-chat-flow-kind', 'tool-call'],
    ['data-chat-flow-key', 'call:bash-stopped'],
  ])
  let state = 'running'
  let expanded = null
  let cell
  const row = {
    getAttribute(name) {
      if (name === 'data-sample' || name === 'data-variant') return 'bash'
      if (name === 'data-state') return state
      if (name === 'aria-expanded') return expanded
      return null
    },
    closest(selector) { return selector === '[data-chat-flow-key]' ? cell : null },
  }
  const flow = { children: null, getBoundingClientRect() { return { width: 688, height: 500, top: 0, left: 0 } } }
  cell = {
    nodeType: 1,
    isConnected: true,
    parentElement: flow,
    style: { removeProperty() {} },
    getBoundingClientRect() { return { width: state === 'running' ? 688 : 229, height: state === 'running' ? 54 : 24, top: 100, left: 0, bottom: 124 } },
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null },
    setAttribute(name, value) { attrs.set(name, String(value)) },
    removeAttribute(name) { attrs.delete(name) },
    querySelector(selector) {
      if (selector === '[data-disclosure-row]') return null
      if (selector === '[data-sample="bash"][data-variant="bash"][data-state]') return row
      if (selector === '[class*="markdown"]') return null
      return null
    },
  }
  flow.children = [cell]
  const previousWindow = globalThis.window
  globalThis.window = { clearTimeout() {}, getComputedStyle() { return { marginTop: '16px', marginBottom: '0px' } } }
  try {
    assert.equal(internals.lifecycleState(cell), 'running')
    assert.equal(internals.runningAction(cell), true)
    internals.syncExecution(flow, false)
    assert.equal(attrs.get('data-dsu-exec'), 'current')

    state = 'stopped'
    assert.equal(internals.terminalAction(cell), true)
    assert.equal(internals.chipped(cell), false, 'current holds the interrupted card until landing')
    internals.syncExecution(flow, false)
    assert.equal(attrs.has('data-dsu-exec'), false)
    assert.equal(internals.chipped(cell), true, 'non-expandable Bash is closed when aria-expanded is absent')

    expanded = 'true'
    assert.equal(internals.chipped(cell), false, 'opened Bash returns to its full row')
    assert.match(style, /data-sample="bash"[\s\S]*data-state="stopped"/)
    assert.match(style, /data-state="stopped"[\s\S]*dsw-alias-state-warn-primary/)
    assert.match(style, /\[data-state\] > :not\(\[class\*="_visuallyHidden"\]\)/, 'chip geometry must not expose Bash screen-reader status')
    assert.match(style, /:not\(\[class\*="_leading_"\]\):not\(\[class\*="_visuallyHidden"\]\)/, 'content rewrite must leave the status visually hidden')
  } finally {
    internals.cellRects.clear()
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

test('native ChatView is the sole owner of scroll intent', () => {
  assert.doesNotMatch(times, /scrollTop|addEventListener\('scroll'|foot(?:Obs|Flow|Scroller|AtBottom|LastTop|Reader|Pin|Observe)|bottomIntent|scrollerOf/)
  assert.match(times, /lastFlowHeight/)
  assert.match(times, /new ResizeObserver\(onFlowResize\)/)
})

test('current holds completion full-width until landing releases the same wrapper', () => {
  const attrs = new Map([['data-chat-flow-kind', 'tool-call'], ['data-dsu-exec', 'current']])
  let state = 'ok'
  const row = { getAttribute(name) { return name === 'aria-expanded' ? 'false' : null } }
  const cell = {
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null },
    querySelector(selector) {
      if (selector === '[data-disclosure-row]') return row
      if (selector === '[class*="markdown"]') return null
      if (selector === '[data-state="running"]') return state === 'running' ? {} : null
      if (selector.includes('[data-state="ok"]')) return state === 'ok' ? {} : null
      return null
    },
  }
  assert.equal(internals.terminalAction(cell), true)
  assert.equal(internals.chipped(cell), false, 'React completion cannot collapse a current wrapper')
  attrs.set('data-dsu-exec', 'landing')
  assert.equal(internals.chipped(cell), true, 'landing releases that same wrapper into the chip grid')
})

test('unknown lifecycle cannot leave current full-width beyond one frame', () => {
  const attrs = new Map([
    ['data-chat-flow-kind', 'tool-call'],
    ['data-chat-flow-key', 'call:unknown'],
    ['data-dsu-exec', 'current'],
  ])
  let frame = null
  const row = { closest() { return null }, getAttribute() { return 'false' } }
  const cell = {
    nodeType: 1,
    isConnected: true,
    parentElement: null,
    style: { removeProperty() {} },
    getBoundingClientRect() { return { width: 688, height: 54, top: 0, left: 0, bottom: 54 } },
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null },
    setAttribute(name, value) { attrs.set(name, String(value)) },
    removeAttribute(name) { attrs.delete(name) },
    contains() { return false },
    querySelector(selector) { return selector === '[data-disclosure-row]' ? row : null },
  }
  const flow = { children: [cell] }
  const previousWindow = globalThis.window
  globalThis.window = {
    requestAnimationFrame(callback) { frame = callback; return 77 },
    cancelAnimationFrame() {},
    getComputedStyle() { return { marginTop: '0px', marginBottom: '0px' } },
  }
  try {
    internals.syncExecution(flow, true)
    assert.equal(attrs.get('data-dsu-exec'), 'current')
    frame()
    assert.equal(attrs.has('data-dsu-exec'), false)
  } finally {
    internals.cellRects.clear()
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

test('landing transaction is the sole geometry owner for its wrapper', () => {
  assert.match(times, /function morphCells[\s\S]*?EXEC_LANDING[^\n]+landingQueued\(cell\)[^\n]+continue/)
  assert.match(times, /function kidResize[\s\S]*?EXEC_LANDING[^\n]+landingQueued\(kid\)[^\n]+continue/)
  assert.match(times, /cell\.style\.transition = 'none'[\s\S]*?setAttribute\(EXEC_ATTR, EXEC_LANDING\)[\s\S]*?stageLandingBridge/)
})

test('View Transition lands the identical keyed wrapper and cleans execution state', async () => {
  const attrs = new Map([['data-chat-flow-kind', 'tool-call'], ['data-chat-flow-key', 'call:same']])
  const values = new Map()
  const rootAttrs = new Map()
  const listeners = new Map()
  let state = 'running'
  let transitioned = null
  let resolveVisual = null
  const style = {
    set viewTransitionName(value) { values.set('view-transition-name', String(value)) },
    set transition(value) { values.set('transition', String(value)) },
    set marginBottom(value) { values.set('margin-bottom', String(value)) },
    removeProperty(name) { values.delete(name) },
  }
  const row = { getAttribute(name) { return name === 'aria-expanded' ? 'false' : null } }
  const flow = {
    children: null,
    getBoundingClientRect() { return { width: 688, height: 500, top: 0, left: 0 } },
  }
  const cell = {
    nodeType: 1,
    isConnected: true,
    parentElement: flow,
    style,
    get offsetHeight() { return this.getBoundingClientRect().height },
    getBoundingClientRect() {
      const height = attrs.get('data-dsu-exec') === 'landing' ? 24 : 54
      return { width: attrs.get('data-dsu-exec') === 'landing' ? 229 : 688, height, top: 100, left: 0, bottom: 100 + height }
    },
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null },
    setAttribute(name, value) { attrs.set(name, String(value)) },
    removeAttribute(name) { attrs.delete(name) },
    querySelector(selector) {
      if (selector === '[data-disclosure-row]') return row
      if (selector === '[class*="markdown"]') return null
      if (selector === '[data-state="running"]') return state === 'running' ? {} : null
      if (selector.includes('[data-state="ok"]')) return state === 'ok' ? {} : null
      return null
    },
    addEventListener(name, fn) { listeners.set(name, fn) },
    removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name) },
  }
  flow.children = [cell]
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  globalThis.window = {
    setTimeout() { return 31 },
    clearTimeout() {},
    matchMedia() { return { matches: false } },
    getComputedStyle() { return { marginTop: '0px', marginBottom: '0px' } },
  }
  globalThis.document = {
    documentElement: {
      setAttribute(name, value) { rootAttrs.set(name, String(value)) },
      removeAttribute(name) { rootAttrs.delete(name) },
      hasAttribute(name) { return rootAttrs.has(name) },
    },
    startViewTransition(update) {
      transitioned = cell
      Promise.resolve().then(update)
      return { finished: new Promise((resolve) => { resolveVisual = resolve }), skipTransition() {} }
    },
  }
  try {
    internals.syncExecution(flow, true)
    assert.equal(attrs.get('data-dsu-exec'), 'current')
    state = 'ok'
    internals.syncExecution(flow, true)
    assert.equal(transitioned, cell, 'the transition names the original native object')
    assert.equal(attrs.get('data-dsu-exec'), 'current', 'browser-style async update keeps the old snapshot full-width')
    assert.equal(values.get('view-transition-name'), 'dsu-exec-tool')
    await Promise.resolve()
    assert.equal(attrs.get('data-dsu-exec'), 'landing', 'update callback releases only after old-state capture')
    assert.equal(values.get('transition'), 'none', 'endpoint is measured with broad child transitions frozen')
    resolveVisual()
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(attrs.has('data-dsu-exec'), false)
    assert.equal(values.has('view-transition-name'), false)
    assert.equal(rootAttrs.has('data-dsu-view'), false)
    assert.equal(flow.children.length, 1)
    assert.equal(flow.children[0], cell)
  } finally {
    internals.morphRuns.clear()
    internals.cellRects.clear()
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  }
})

test('reduced motion snaps current to chip without leaving execution residue', () => {
  const attrs = new Map([['data-chat-flow-kind', 'tool-call'], ['data-chat-flow-key', 'call:reduce']])
  let state = 'running'
  const row = { getAttribute(name) { return name === 'aria-expanded' ? 'false' : null } }
  const flow = { children: null, getBoundingClientRect() { return { width: 688, height: 500, top: 0, left: 0 } } }
  const cell = {
    nodeType: 1,
    isConnected: true,
    parentElement: flow,
    style: { removeProperty() {} },
    getBoundingClientRect() { return { width: state === 'running' ? 688 : 229, height: state === 'running' ? 54 : 24, top: 100, left: 0, bottom: 124 } },
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null },
    setAttribute(name, value) { attrs.set(name, String(value)) },
    removeAttribute(name) { attrs.delete(name) },
    querySelector(selector) {
      if (selector === '[data-disclosure-row]') return row
      if (selector === '[class*="markdown"]') return null
      if (selector === '[data-state="running"]') return state === 'running' ? {} : null
      if (selector.includes('[data-state="ok"]')) return state === 'ok' ? {} : null
      return null
    },
  }
  flow.children = [cell]
  const previousWindow = globalThis.window
  globalThis.window = { clearTimeout() {}, getComputedStyle() { return { marginTop: '16px', marginBottom: '0px' } } }
  try {
    internals.syncExecution(flow, false)
    assert.equal(attrs.get('data-dsu-exec'), 'current')
    state = 'ok'
    internals.syncExecution(flow, false)
    assert.equal(attrs.has('data-dsu-exec'), false)
    assert.equal(internals.chipped(cell), true)
  } finally {
    internals.cellRects.clear()
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

test('bounded cell geometry owns birth and fold, then one cleanup releases every inline value', () => {
  assert.match(times, /function startBirth[\s\S]*?cellRects\.set\(key, natural\)[\s\S]*?cell\.style\.height = '0px'/)
  assert.match(times, /cell\.style\.height = from\.toFixed\(1\) \+ 'px'/)
  assert.match(times, /cell\.style\.height = to\.toFixed\(1\) \+ 'px'/)
  assert.match(times, /function cancelMorph[\s\S]*?removeProperty\('transition'\)[\s\S]*?removeProperty\('box-sizing'\)[\s\S]*?removeProperty\('height'\)[\s\S]*?removeProperty\('margin-top'\)[\s\S]*?removeProperty\('margin-bottom'\)/)
  assert.match(times, /transitionend/)
  assert.match(style, /transition:height 220ms var\(--studio-ease\)[^\n]*padding-top 220ms var\(--studio-ease\)[^\n]*border-top-width 220ms var\(--studio-ease\)/)
  assert.doesNotMatch(style, /interpolate-size/)
})

test('birth records natural geometry before zero and releases it on transitionend', () => {
  const values = new Map()
  const writes = []
  const layouts = []
  let frame = null
  const styleObject = {
    set transition(value) { values.set('transition', String(value)) },
    get transition() { return values.get('transition') || '' },
    set boxSizing(value) { values.set('box-sizing', String(value)) },
    get boxSizing() { return values.get('box-sizing') || '' },
    set minHeight(value) { values.set('min-height', String(value)) },
    set height(value) { values.set('height', String(value)); writes.push(['height', String(value)]) },
    get height() { return values.get('height') || '' },
    set marginTop(value) { values.set('margin-top', String(value)); writes.push(['margin-top', String(value)]) },
    set marginBottom(value) { values.set('margin-bottom', String(value)); writes.push(['margin-bottom', String(value)]) },
    set paddingTop(value) { values.set('padding-top', String(value)) },
    set paddingBottom(value) { values.set('padding-bottom', String(value)) },
    set borderTopWidth(value) { values.set('border-top-width', String(value)) },
    set borderBottomWidth(value) { values.set('border-bottom-width', String(value)) },
    removeProperty(name) { values.delete(name) },
  }
  const attrs = new Map([['data-chat-flow-kind', 'tool-call']])
  const listeners = new Map()
  const row = { getAttribute(name) { return name === 'aria-expanded' ? 'true' : null } }
  const cell = {
    nodeType: 1,
    style: styleObject,
    parentElement: null,
    get offsetHeight() { const height = this.getBoundingClientRect().height; layouts.push(height); return height },
    getBoundingClientRect() {
      // The live running card is content-box with 19px of vertical decoration. Even border-box
      // cannot shrink below its own padding+border, so birth must temporarily own those edges too.
      const explicit = values.has('height') ? parseFloat(values.get('height')) : null
      const edge =
        (values.has('padding-top') ? parseFloat(values.get('padding-top')) : 18) +
        (values.has('padding-bottom') ? parseFloat(values.get('padding-bottom')) : 0) +
        (values.has('border-top-width') ? parseFloat(values.get('border-top-width')) : 1) +
        (values.has('border-bottom-width') ? parseFloat(values.get('border-bottom-width')) : 0)
      const height = explicit === null ? 73 : values.get('box-sizing') === 'border-box' ? Math.max(explicit, edge) : explicit + edge
      return { width: 688, height, top: 0, left: 0, bottom: height }
    },
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null },
    setAttribute(name, value) { attrs.set(name, String(value)) },
    removeAttribute(name) { attrs.delete(name) },
    querySelector(selector) { return selector === '[data-disclosure-row]' ? row : null },
    addEventListener(name, fn) { listeners.set(name, fn) },
    removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name) },
  }
  const previousWindow = globalThis.window
  globalThis.window = {
    setTimeout() { return 11 },
    clearTimeout() {},
    requestAnimationFrame(callback) { frame = callback; return 23 },
    cancelAnimationFrame() { frame = null },
    getComputedStyle() {
      return {
        marginTop: values.has('margin-top') ? values.get('margin-top') : '22px',
        marginBottom: values.has('margin-bottom') ? values.get('margin-bottom') : '0px',
        paddingTop: values.has('padding-top') ? values.get('padding-top') : '18px',
        paddingBottom: values.has('padding-bottom') ? values.get('padding-bottom') : '0px',
        borderTopWidth: values.has('border-top-width') ? values.get('border-top-width') : '1px',
        borderBottomWidth: values.has('border-bottom-width') ? values.get('border-bottom-width') : '0px',
      }
    },
  }
  try {
    internals.startBirth(cell, 'new-call', false)
    assert.equal(internals.cellRects.get('new-call').h, 73, 'natural rest is stored before the zero frame')
    assert.deepEqual(writes.slice(0, 3), [['height', '0px'], ['margin-top', '0px'], ['margin-bottom', '0px']])
    assert.equal(layouts[0], 0, 'padding and border cannot create a discrete first-frame floor')
    assert.equal(styleObject.boxSizing, 'border-box')
    assert.equal(styleObject.height, '0px', 'the zero state survives until the next animation-frame boundary')
    assert.equal(typeof frame, 'function', 'the natural target is staged through requestAnimationFrame')
    assert.equal(attrs.get('data-dsu-morph'), 'birth')
    frame()
    assert.equal(styleObject.height, '0px', 'one frame first enables transition on the zero geometry')
    assert.equal(typeof frame, 'function', 'the target waits for a second frame boundary')
    frame()
    assert.equal(styleObject.height, '73.0px')
    assert.equal(cell.getBoundingClientRect().height, 73, 'the content-box decoration is not added twice')
    listeners.get('transitionend')({ target: cell, propertyName: 'height' })
    assert.equal(styleObject.height, '')
    assert.equal(styleObject.boxSizing, '')
    assert.equal(values.has('margin-top'), false)
    assert.equal(values.has('margin-bottom'), false)
    assert.equal(values.has('min-height'), false)
    assert.equal(values.has('padding-top'), false)
    assert.equal(values.has('border-top-width'), false)
    assert.equal(attrs.has('data-dsu-morph'), false)
    assert.equal(internals.cellRects.get('new-call').h, 73)
  } finally {
    internals.morphRuns.clear()
    internals.cellRects.clear()
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

test('a fold bridges the measured flow loss only for the bounded transition', () => {
  const values = new Map()
  const bottomWrites = []
  const styleObject = {
    set transition(value) { values.set('transition', String(value)) },
    get transition() { return values.get('transition') || '' },
    set height(value) { values.set('height', String(value)) },
    get height() { return values.get('height') || '' },
    set marginTop(value) { values.set('margin-top', String(value)) },
    set marginBottom(value) { values.set('margin-bottom', String(value)); bottomWrites.push(String(value)) },
    removeProperty(name) { values.delete(name) },
  }
  const scroller = { scrollTop: 0 }
  const flow = {
    getBoundingClientRect() {
      const h = values.has('height') ? parseFloat(values.get('height')) : 24
      const mt = values.has('margin-top') ? parseFloat(values.get('margin-top')) : 16
      const mb = values.has('margin-bottom') ? parseFloat(values.get('margin-bottom')) : 0
      return { height: 1000 + h + mt + mb - 34 }
    },
  }
  const attrs = new Map([['data-chat-flow-kind', 'tool-call']])
  const listeners = new Map()
  const row = { getAttribute(name) { return name === 'aria-expanded' ? 'false' : null } }
  const cell = {
    nodeType: 1,
    style: styleObject,
    parentElement: flow,
    get offsetHeight() { return values.has('height') ? parseFloat(values.get('height')) : 24 },
    getBoundingClientRect() {
      const height = values.has('height') ? parseFloat(values.get('height')) : 24
      return { width: 229, height, top: 100, left: 0, bottom: 100 + height }
    },
    closest() { return scroller },
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null },
    setAttribute(name, value) { attrs.set(name, String(value)) },
    removeAttribute(name) { attrs.delete(name) },
    querySelector(selector) {
      if (selector === '[data-disclosure-row]') return row
      if (selector === '[data-state="ok"]') return {}
      return null
    },
    addEventListener(name, fn) { listeners.set(name, fn) },
    removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name) },
    animate() { return { cancel() {} } },
  }
  const previousWindow = globalThis.window
  globalThis.window = {
    setTimeout() { return 19 },
    clearTimeout() {},
    getComputedStyle() {
      return {
        marginTop: values.has('margin-top') ? values.get('margin-top') : '16px',
        marginBottom: values.has('margin-bottom') ? values.get('margin-bottom') : '0px',
      }
    },
  }
  try {
    internals.setFlowForTest(flow, 1130)
    internals.startMorph(cell, 'bridged-call', { h: 120, m: 10, chip: false, x: 0, y: 100 }, true)
    assert.deepEqual(bottomWrites, ['0.0px', '34.0px', '0.0px'], 'the exact 34px rewrap loss is held, then released')
    assert.equal(attrs.get('data-dsu-morph'), 'fold')
    listeners.get('transitionend')({ target: cell, propertyName: 'height' })
    assert.equal(values.has('margin-bottom'), false, 'the local bridge cannot survive its transition')
    assert.equal(internals.morphRuns.has('bridged-call'), false)
  } finally {
    internals.setFlowForTest(null, 0)
    internals.morphRuns.clear()
    internals.cellRects.clear()
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

test('a fast fold releases its explicit height on transitionend', () => {
  const values = new Map()
  const styleObject = {
    set transition(value) { values.set('transition', String(value)) },
    get transition() { return values.get('transition') || '' },
    set height(value) { values.set('height', String(value)) },
    get height() { return values.get('height') || '' },
    removeProperty(name) { values.delete(name) },
  }
  const attrs = new Map([['data-chat-flow-kind', 'tool-call']])
  const listeners = new Map()
  const row = { getAttribute(name) { return name === 'aria-expanded' ? 'false' : null } }
  const cell = {
    nodeType: 1,
    style: styleObject,
    previousElementSibling: null,
    nextElementSibling: null,
    parentElement: null,
    get offsetHeight() { return parseFloat(styleObject.height) || 24 },
    getBoundingClientRect() {
      const height = parseFloat(styleObject.height) || 24
      return { width: 300, height, top: 0, bottom: height }
    },
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null },
    setAttribute(name, value) { attrs.set(name, String(value)) },
    removeAttribute(name) { attrs.delete(name) },
    querySelector(selector) {
      if (selector === '[data-disclosure-row]') return row
      if (selector === '[data-state="ok"]') return {}
      return null
    },
    addEventListener(name, fn) { listeners.set(name, fn) },
    removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name) },
  }
  const previousWindow = globalThis.window
  globalThis.window = {
    setTimeout() { return 17 },
    clearTimeout() {},
    getComputedStyle() { return { marginTop: '0' } },
  }
  try {
    internals.startMorph(cell, 'fast-call', { h: 120, m: 0, chip: false }, true)
    assert.equal(styleObject.height, '24.0px', 'fold has an explicit destination only while moving')
    assert.equal(attrs.get('data-dsu-morph'), 'fold')
    assert.equal(internals.morphRuns.has('fast-call'), true)
    listeners.get('transitionend')({ target: cell, propertyName: 'height' })
    assert.equal(styleObject.height, '', 'transitionend returns height to natural layout')
    assert.equal(styleObject.transition, '', 'transitionend returns transition ownership')
    assert.equal(attrs.has('data-dsu-morph'), false)
    assert.equal(internals.morphRuns.has('fast-call'), false)
    assert.equal(internals.cellRects.get('fast-call').h, 24)
  } finally {
    internals.morphRuns.clear()
    internals.cellRects.clear()
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

test('time labels do not rewrite identical attributes and wake their observer', () => {
  assert.match(times, /if \(node\.getAttribute\(name\) !== value\) node\.setAttribute\(name, value\)/)
  assert.match(times, /const rowLabels = new Map\(\)/)
  assert.doesNotMatch(times, /chip\.removeAttribute\(ROW_ATTR\)[\s\S]*?line\.first\.setAttribute\(ROW_ATTR/)
})

test('registerTimes accepts the direct slots service exposed by the live client context', () => {
  let injected = ''
  let registration = null
  let entry = null
  let disposed = 0
  const slots = {
    inject(name, mount) {
      injected = name
      const unmount = mount()
      return function () { unmount(); disposed += 1 }
    },
    register(descriptor, component) {
      registration = descriptor
      entry = component
      return function () { disposed += 1 }
    },
  }
  const off = internals.registerTimes({ slots })
  assert.equal(injected, 'conversation.input.dock')
  assert.deepEqual(registration, {
    name: 'conversation.input.dock',
    id: 'dsh-regional-palette:timerow',
    order: 90,
    label: 'Action times',
  })
  assert.equal(typeof entry, 'function')
  off()
  assert.equal(disposed, 2)
})
