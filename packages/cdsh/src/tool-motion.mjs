// CDSH tool-card grid and motion for DSH 0.2.x grouped process rows.
//
// DSH owns the process group, disclosure controls, tool cards, scrolling and
// virtualization. CDSH only lays out the *visible* direct children of the
// native process flow. Hidden historical members stay hidden, the running or
// expanded card stays full width, and completed collapsed actions become
// compact native chips in a three-column row.

export const TOOL_GRID_ATTR = 'data-cdsh-tool-grid'
export const TOOL_MOTION_ATTR = 'data-cdsh-tool-motion'
export const TOOL_STAGE_ATTR = 'data-cdsh-tool-stage'
export const TOOL_TIME_ATTR = 'data-cdsh-tool-time'
export const PROCESS_FLOW_SELECTOR = '[data-step-process-content][data-chat-flow]'

const TIME_SOURCE_SLOT = 'conversation.input.dock'
const TIME_SOURCE_ID = 'cdsh/tool-times'
const TERMINAL_STATES = '[data-state="ok"],[data-state="error"],[data-state="stopped"],[data-state="cancelled"]'
const CLOSED_ROW = '[data-disclosure-row][aria-expanded="false"],[data-sample="bash"][data-variant="bash"][aria-expanded="false"]'
const ACTION = ':is([data-chat-flow-kind="tool-call"],[data-chat-flow-kind="assistant-step"]:has([data-variant="think"]))'
const CHIP = ACTION + ':not([hidden]):not([data-turn-process-hidden="true"]):has(:is(' + TERMINAL_STATES + ')):not(:has([data-state="running"])):has(:is(' + CLOSED_ROW + '))'
const STAGED = ACTION + '[' + TOOL_STAGE_ATTR + '="wide"]'
const FLOW = PROCESS_FLOW_SELECTOR + '[' + TOOL_GRID_ATTR + '="active"]'

export const toolMotionCss = `
/* DSH keeps ownership of grouped process rows; only their visible native
   action wrappers participate in the CDSH compact grid. */
[data-slot="main"] ${FLOW} {
  display:flex;
  flex-flow:row wrap;
  align-items:flex-start;
  gap:0;
}
[data-slot="main"] ${FLOW} > * {
  box-sizing:border-box;
  flex:0 0 100%;
  width:100%;
  min-width:0;
}
[data-slot="main"] ${FLOW} > ${CHIP} {
  flex-basis:33.3333%;
  width:33.3333%;
  min-width:0;
  margin:0;
  padding:4px;
  border-top:0;
}
/* A recorded completion clock belongs to the compact native wrapper. It is
   painted without adding a React-owned child, while the row reserves enough
   inline space to keep the native title and summary from running underneath. */
[data-slot="main"] ${FLOW} > ${CHIP}[data-chat-flow-kind="tool-call"][${TOOL_TIME_ATTR}] {
  position:relative;
}
[data-slot="main"] ${FLOW} > ${CHIP}[data-chat-flow-kind="tool-call"][${TOOL_TIME_ATTR}]::after {
  content:attr(${TOOL_TIME_ATTR});
  position:absolute;
  z-index:2;
  top:50%;
  right:10px;
  transform:translateY(-50%);
  color:var(--dsw-alias-label-secondary);
  opacity:.72;
  font-size:10px;
  line-height:1;
  font-variant-numeric:tabular-nums;
  letter-spacing:.01em;
  white-space:nowrap;
  pointer-events:none;
}
[data-slot="main"] ${FLOW} > ${CHIP}[data-chat-flow-kind="tool-call"][${TOOL_TIME_ATTR}] :is([data-disclosure-row],[data-sample="bash"][data-variant="bash"]) {
  padding-right:46px;
}
[data-slot="main"] ${FLOW} > ${CHIP} :is([data-disclosure-row],[data-sample="bash"][data-variant="bash"]) {
  box-sizing:border-box;
  min-width:0;
  min-height:32px;
  overflow:hidden;
  border-radius:6px;
}
[data-slot="main"] ${FLOW} > ${CHIP} :is([data-disclosure-row],[data-sample="bash"][data-variant="bash"]) > * {
  min-width:0;
}
[data-slot="main"] ${FLOW} > ${CHIP} :is([data-disclosure-row],[data-sample="bash"][data-variant="bash"]) :is([class*="label"],[class*="title"],[class*="summary"]) {
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
}
/* Running calls, newborn actions staged for one frame, and user-opened
   disclosures always retain the native full lane. The staging marker makes
   even a synchronously completed call visibly land from full width. */
[data-slot="main"] ${FLOW} > :is(${STAGED},${ACTION}:is(:has([data-state="running"]),:has([data-disclosure-row][aria-expanded="true"]),:has([data-sample="bash"][aria-expanded="true"]))) {
  flex-basis:100%;
  width:100%;
  padding:4px 0;
}
[data-slot="main"] ${FLOW} > [${TOOL_MOTION_ATTR}="active"] {
  position:relative;
  z-index:1;
}
@media (prefers-reduced-motion: reduce) {
  [data-slot="main"] ${FLOW} > * {
    transition:none !important;
    animation:none !important;
  }
}
`

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

const EMPTY_NODES = { values: function () { return [] } }
let ReactRef = null

function getReact() {
  if (ReactRef) return ReactRef
  const usable = function (value) {
    return value && typeof value.createElement === 'function' && typeof value.useEffect === 'function' && typeof value.useRef === 'function'
  }
  try {
    if (typeof require === 'function') {
      const value = require('react')
      if (usable(value)) { ReactRef = value; return ReactRef }
    }
  } catch (error) { /* dynamic builds have no require */ }
  try {
    const root = typeof globalThis === 'undefined' ? {} : globalThis
    const candidates = [root.React, root.__DSH_REACT__, root.__dshReact, root.window && root.window.React]
    for (const value of candidates) if (usable(value)) { ReactRef = value; return ReactRef }
  } catch (error) { /* optional global fallbacks */ }
  return null
}

function pickNodes(snapshot) {
  return snapshot && typeof snapshot === 'object' && snapshot.nodes !== undefined ? snapshot.nodes : EMPTY_NODES
}

/** Recorded completion times keyed by the exact native conversation node key. */
export function collectToolTimes(nodes) {
  const completed = new Map()
  let values = []
  try {
    if (nodes && typeof nodes.values === 'function') values = Array.from(nodes.values())
    else if (nodes && typeof nodes[Symbol.iterator] === 'function') values = Array.from(nodes)
  } catch (error) { values = [] }
  for (const node of values) {
    if (!node || typeof node !== 'object' || node.kind !== 'tool-call' || typeof node.key !== 'string') continue
    const data = node.data && typeof node.data === 'object' ? node.data : null
    const root = data && data.root && typeof data.root === 'object' ? data.root : null
    const time = root && root.kind === 'tool-result' && typeof root.time === 'number' && Number.isFinite(root.time) && root.time > 0
      ? root.time
      : null
    if (time !== null) completed.set(node.key, time)
  }
  return completed
}

/**
 * Completion clocks are monotonic within one session. A live chat projection may
 * briefly omit an older node while a new tool call is streaming, so a partial
 * snapshot must add clocks without erasing ones already observed.
 */
export function mergeToolTimes(completed, nodes) {
  const merged = completed instanceof Map ? new Map(completed) : new Map()
  for (const [key, time] of collectToolTimes(nodes)) merged.set(key, time)
  return merged
}

export const TOOL_TIME_SESSION_LIMIT = 8

/**
 * Keep exact recorded completion clocks per native session. Source instances may
 * remount while a projection is partial, so ownership only guards cleanup; it
 * never defines the lifetime of a session's monotonic clock map.
 */
export function createToolTimeCache(maxSessions = TOOL_TIME_SESSION_LIMIT) {
  const limit = Number.isSafeInteger(maxSessions) && maxSessions > 0 ? maxSessions : TOOL_TIME_SESSION_LIMIT
  const sessions = new Map()
  let activeOwner = null
  let activeSession = ''
  let selected = new Map()

  function touch(sessionId) {
    let clocks = sessions.get(sessionId)
    if (!(clocks instanceof Map)) clocks = new Map()
    else sessions.delete(sessionId)
    sessions.set(sessionId, clocks)
    while (sessions.size > limit) sessions.delete(sessions.keys().next().value)
    return clocks
  }

  function accept(nodes, owner, sessionId) {
    const session = typeof sessionId === 'string' ? sessionId : ''
    if (nodes === null) {
      // A replaced source often disposes after its successor has published.
      // Only release the exact active owner/session pair, and retain its clocks
      // so a same-session remount can start from a partial projection safely.
      if (owner === activeOwner && session === activeSession) activeOwner = null
      return selected
    }

    activeOwner = owner
    activeSession = session
    selected = mergeToolTimes(touch(session), nodes || EMPTY_NODES)
    sessions.set(session, selected)
    return selected
  }

  function clear() {
    sessions.clear()
    activeOwner = null
    activeSession = ''
    selected = new Map()
    return selected
  }

  return {
    accept,
    clear,
    size: function () { return sessions.size },
  }
}

/** Local completion clock used by native message timestamps as well. */
export function formatToolTimestamp(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const hours = date.getHours()
  const minutes = date.getMinutes()
  return (hours < 10 ? '0' : '') + hours + ':' + (minutes < 10 ? '0' : '') + minutes
}

function timeForRow(row, completed) {
  if (!row || typeof row.getAttribute !== 'function' || !(completed instanceof Map)) return null
  const nodeKey = row.getAttribute('data-chat-node-key') || ''
  if (nodeKey && completed.has(nodeKey)) return completed.get(nodeKey)
  const flowKey = row.getAttribute('data-chat-flow-key') || ''
  return flowKey && completed.has(flowKey) ? completed.get(flowKey) : null
}

function isCompactTool(row) {
  if (!row || row.nodeType !== 1 || typeof row.getAttribute !== 'function') return false
  if (row.getAttribute('data-chat-flow-kind') !== 'tool-call') return false
  if (typeof row.hasAttribute === 'function' && row.hasAttribute('hidden')) return false
  if (row.getAttribute('data-turn-process-hidden') === 'true') return false
  if (row.getAttribute(TOOL_STAGE_ATTR) === 'wide') return false
  if (typeof row.querySelector !== 'function') return false
  try {
    return row.querySelector(TERMINAL_STATES) !== null &&
      row.querySelector('[data-state="running"]') === null &&
      row.querySelector(CLOSED_ROW) !== null
  } catch (error) {
    return false
  }
}

function writeAttribute(node, name, value) {
  if (!node || typeof node.getAttribute !== 'function') return
  if (!value) {
    try { if (typeof node.hasAttribute !== 'function' || node.hasAttribute(name)) node.removeAttribute(name) } catch (error) { /* detached */ }
  } else if (node.getAttribute(name) !== value) {
    try { node.setAttribute(name, value) } catch (error) { /* detached */ }
  }
}

/** Stamp only visible, collapsed terminal tool wrappers; never add DOM children. */
export function syncToolTimestamps(flow, completed, stamped) {
  const children = flow && flow.children ? Array.from(flow.children) : []
  for (const row of children) {
    const label = isCompactTool(row) ? formatToolTimestamp(timeForRow(row, completed)) : ''
    writeAttribute(row, TOOL_TIME_ATTR, label)
    if (label && stamped instanceof Set) stamped.add(row)
  }
}

function disposeOf(value) {
  if (typeof value === 'function') return value
  if (value && typeof value.dispose === 'function') return function () { value.dispose() }
  return function () {}
}

function registerToolTimeSource(ctx, onNodes) {
  function mount(scope) {
    const slots = scope && (scope.slots || (typeof scope.get === 'function' && scope.get('slots')))
    if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return function () {}

    function ToolTimeSource(props) {
      const React = getReact()
      if (React === null) return null
      const seat = props && typeof props === 'object' ? props : {}
      const useChat = typeof seat.useChat === 'function' ? seat.useChat : null
      const nodes = useChat === null ? EMPTY_NODES : useChat(pickNodes)
      const sessionId = typeof seat.sessionId === 'string' ? seat.sessionId : ''
      const owner = React.useRef(null)
      if (owner.current === null) owner.current = {}
      React.useEffect(function () { onNodes(nodes, owner.current, sessionId) })
      React.useEffect(function () {
        const token = owner.current
        return function () { onNodes(null, token, sessionId) }
      }, [sessionId])
      return null
    }

    const injected = slots.inject(TIME_SOURCE_SLOT, function () {
      let registered = function () {}
      try {
        registered = disposeOf(slots.register({
          name: TIME_SOURCE_SLOT,
          id: TIME_SOURCE_ID,
          order: 90,
          label: 'Tool timestamps',
        }, ToolTimeSource))
      } catch (error) { /* optional source */ }
      return function () { registered() }
    })
    return disposeOf(injected)
  }

  // A Cordis hard dependency must be entered through inject before touching
  // ctx.slots; reading that property on the root context throws by design.
  if (ctx && typeof ctx.inject === 'function') {
    try { return disposeOf(ctx.inject(['slots'], mount)) } catch (error) { return function () {} }
  }
  return mount(ctx)
}

function boxOf(node) {
  if (!node || typeof node.getBoundingClientRect !== 'function') return null
  const box = node.getBoundingClientRect()
  const width = finite(box && box.width)
  const height = finite(box && box.height)
  if (width <= 0 || height <= 0) return null
  return {
    left: finite(box.left),
    top: finite(box.top),
    width,
    height,
  }
}

function reducedMotion() {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch (error) {
    return false
  }
}

function closeEnough(value) {
  return Math.abs(value) < 0.75
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

const runningAnimations = new WeakMap()

function clearMotionMark(node, animation) {
  if (runningAnimations.get(node) !== animation) return
  runningAnimations.delete(node)
  try { node.removeAttribute(TOOL_MOTION_ATTR) } catch (error) { /* detached */ }
}

function play(node, frames, options) {
  if (!node || typeof node.animate !== 'function') return null
  const previous = runningAnimations.get(node)
  try { if (previous && typeof previous.cancel === 'function') previous.cancel() } catch (error) { /* already finished */ }
  let animation = null
  try {
    node.setAttribute(TOOL_MOTION_ATTR, 'active')
    animation = node.animate(frames, options)
    runningAnimations.set(node, animation)
    if (animation && animation.finished && typeof animation.finished.then === 'function') {
      animation.finished.then(function () { clearMotionMark(node, animation) }, function () { clearMotionMark(node, animation) })
    } else {
      clearMotionMark(node, animation)
    }
  } catch (error) {
    try { node.removeAttribute(TOOL_MOTION_ATTR) } catch (ignored) { /* detached */ }
    animation = null
  }
  return animation
}

/**
 * Measure one native process flow and FLIP its existing direct children from
 * their previous boxes. Exported as a small deterministic seam for tests.
 */
export function reflowToolGrid(flow, previous, options) {
  const before = previous instanceof Map ? previous : new Map()
  const next = new Map()
  const animate = options && options.animate === true && !reducedMotion()
  const children = flow && flow.children ? Array.from(flow.children) : []

  for (const child of children) {
    const now = boxOf(child)
    if (now === null) continue
    next.set(child, now)
    if (!animate) continue

    const was = before.get(child)
    if (was === undefined) {
      if (before.size > 0) {
        play(child, [
          { opacity: 0, transform: 'translate3d(0,8px,0)' },
          { opacity: 1, transform: 'translate3d(0,0,0)' },
        ], { duration: 180, easing: 'cubic-bezier(.32,.72,0,1)', fill: 'both' })
      }
      continue
    }

    const dx = was.left - now.left
    const dy = was.top - now.top
    const sx = clamp(was.width / now.width, 0.34, 3)
    if (closeEnough(dx) && closeEnough(dy) && closeEnough(sx - 1)) continue

    play(child, [
      { transformOrigin: '0 0', transform: 'translate3d(' + dx + 'px,' + dy + 'px,0) scaleX(' + sx + ')' },
      { transformOrigin: '0 0', transform: 'translate3d(0,0,0) scaleX(1)' },
    ], { duration: 220, easing: 'cubic-bezier(.32,.72,0,1)', fill: 'both' })
  }

  return next
}

function stateAllowsMotion(api) {
  try {
    const state = api && typeof api.getState === 'function' ? api.getState() : null
    if (state && state.enabled === false) return false
    if (state && state.regions && state.regions.toolCards && state.regions.toolCards.enabled === false) return false
  } catch (error) { /* default on */ }
  return true
}

function includesFlow(node) {
  if (!node || node.nodeType !== 1) return false
  try {
    return (typeof node.matches === 'function' && node.matches(PROCESS_FLOW_SELECTOR)) ||
      (typeof node.querySelector === 'function' && node.querySelector(PROCESS_FLOW_SELECTOR) !== null)
  } catch (error) {
    return false
  }
}

function stageDirectAction(node) {
  if (!node || node.nodeType !== 1) return false
  try {
    if (node.hasAttribute('hidden') || node.getAttribute('data-turn-process-hidden') === 'true') return false
    if (typeof node.matches !== 'function' || !node.matches(ACTION)) return false
    node.setAttribute(TOOL_STAGE_ATTR, 'wide')
    return true
  } catch (error) {
    return false
  }
}

/** Mount the scoped observer. It never opens groups or unhides virtualized rows. */
export function installToolMotion(ctx, api) {
  if (typeof document === 'undefined' || !document.body || typeof MutationObserver === 'undefined') return function () {}

  let closed = false
  let frame = 0
  let animateNext = false
  let enabled = stateAllowsMotion(api)
  let flows = new Set()
  let boxes = new Map()
  let stampedRows = new Set()
  const timeCache = createToolTimeCache()
  let completedTimes = new Map()
  let dropTimeSource = function () {}

  function acceptNodes(nodes, owner, sessionId) {
    if (closed) return
    completedTimes = timeCache.accept(nodes, owner, sessionId)
    schedule(false)
  }

  function dropFlow(flow) {
    try { flow.removeAttribute(TOOL_GRID_ATTR) } catch (error) { /* detached */ }
    try {
      for (const node of Array.from(flow.children || [])) {
        node.removeAttribute(TOOL_STAGE_ATTR)
        node.removeAttribute(TOOL_TIME_ATTR)
      }
    } catch (error) { /* detached */ }
    const old = boxes.get(flow)
    if (old instanceof Map) {
      for (const node of old.keys()) {
        const animation = runningAnimations.get(node)
        try { if (animation && typeof animation.cancel === 'function') animation.cancel() } catch (error) { /* finished */ }
        runningAnimations.delete(node)
        try { node.removeAttribute(TOOL_MOTION_ATTR) } catch (error) { /* detached */ }
      }
    }
    boxes.delete(flow)
  }

  function flush() {
    frame = 0
    if (closed) return
    enabled = stateAllowsMotion(api)
    const found = enabled ? new Set(Array.from(document.querySelectorAll(PROCESS_FLOW_SELECTOR))) : new Set()
    const times = enabled ? completedTimes : new Map()

    let staged = false
    const nextStampedRows = new Set()
    for (const flow of flows) if (!found.has(flow)) dropFlow(flow)
    for (const flow of found) {
      const fresh = !flows.has(flow)
      try { flow.setAttribute(TOOL_GRID_ATTR, 'active') } catch (error) { continue }
      syncToolTimestamps(flow, times, nextStampedRows)
      boxes.set(flow, reflowToolGrid(flow, boxes.get(flow), { animate: animateNext && !fresh }))
      try {
        for (const node of Array.from(flow.children || [])) {
          if (node.getAttribute(TOOL_STAGE_ATTR) !== 'wide') continue
          node.removeAttribute(TOOL_STAGE_ATTR)
          staged = true
        }
      } catch (error) { /* detached */ }
    }
    for (const row of stampedRows) if (!nextStampedRows.has(row)) writeAttribute(row, TOOL_TIME_ATTR, '')
    stampedRows = nextStampedRows
    flows = found
    animateNext = false
    // Measure once while newborn actions occupy the full lane, then remove the
    // staging marker and measure again on the next frame. The second pass is
    // the full-width -> one-third FLIP for calls that completed synchronously.
    if (staged) schedule(true)
  }

  function schedule(animate) {
    if (closed) return
    animateNext = animateNext || animate === true
    if (frame) return
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : function (fn) { return setTimeout(fn, 0) }
    frame = raf(flush)
  }

  const observer = new MutationObserver(function (records) {
    let relevant = false
    for (const record of records) {
      if (record.type === 'attributes') {
        const target = record.target
        try {
          if (target && typeof target.closest === 'function' && target.closest(PROCESS_FLOW_SELECTOR)) { relevant = true; break }
        } catch (error) { /* detached */ }
      } else if (record.type === 'childList') {
        try {
          if (record.target && typeof record.target.matches === 'function' && record.target.matches(PROCESS_FLOW_SELECTOR)) {
            for (const node of Array.from(record.addedNodes || [])) stageDirectAction(node)
            relevant = true
            break
          }
        } catch (error) { /* detached */ }
        if (Array.from(record.addedNodes || []).some(includesFlow) || Array.from(record.removedNodes || []).some(includesFlow)) { relevant = true; break }
      }
    }
    if (relevant) schedule(true)
  })

  try {
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        'data-state',
        'aria-expanded',
        'hidden',
        'data-turn-process-hidden',
        'data-chat-node-key',
        'data-chat-flow-key',
        'data-chat-flow-kind',
      ],
    })
  } catch (error) {
    return function () {}
  }

  const onResize = function () { schedule(false) }
  try { if (typeof window !== 'undefined') window.addEventListener('resize', onResize, { passive: true }) } catch (error) { /* optional */ }
  const unsubscribe = api && typeof api.subscribe === 'function' ? api.subscribe(function () { schedule(false) }) : null
  dropTimeSource = registerToolTimeSource(ctx, acceptNodes)
  flush()

  return function () {
    closed = true
    try { dropTimeSource() } catch (error) { /* already removed */ }
    dropTimeSource = function () {}
    completedTimes = timeCache.clear()
    try { observer.disconnect() } catch (error) { /* already disconnected */ }
    try { if (typeof window !== 'undefined') window.removeEventListener('resize', onResize) } catch (error) { /* optional */ }
    try { if (typeof unsubscribe === 'function') unsubscribe() } catch (error) { /* already removed */ }
    if (frame) {
      try {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
        else clearTimeout(frame)
      } catch (error) { /* already fired */ }
    }
    for (const flow of flows) dropFlow(flow)
    flows.clear()
    for (const row of stampedRows) writeAttribute(row, TOOL_TIME_ATTR, '')
    stampedRows.clear()
  }
}
