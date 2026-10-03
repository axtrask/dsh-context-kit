// Implementation note.
//
// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
//
// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
//
// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
//
// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
//
// Implementation note.
// Implementation note.
// Implementation note.

const DOCK_SLOT = 'conversation.input.dock'
const TIME_ENTRY_ID = 'dsh-regional-palette:timerow'
const ROW_ATTR = 'data-dsu-row'
const START_ATTR = 'data-dsu-start'
const END_ATTR = 'data-dsu-end'
const ROW_TOLERANCE = 2
const FLOW_SELECTOR = '[data-slot="main"] [data-chat-flow]'

// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
//
// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
// Implementation note.
//
// Implementation note.
// Implementation note.
// Implementation note.
const MORPH_ATTR = 'data-dsu-morph'
const EXEC_ATTR = 'data-dsu-exec'
const EXEC_CURRENT = 'current'
const EXEC_LANDING = 'landing'
const VIEW_NAME = 'dsu-exec-tool'
const VIEW_ATTR = 'data-dsu-view'
const RESIZE_ATTR = 'data-dsu-resizing'
// Implementation note.
// Implementation note.
// Implementation note.
const MORPH_MS = 220
// Implementation note.
// Implementation note.
const SYNC_MS = 90

// Implementation note.
let ReactRef = null
function getReact() {
  if (ReactRef) return ReactRef
  const usable = function (r) { return r !== null && r !== undefined && typeof r.createElement === 'function' }
  try {
    if (typeof require === 'function') {
      const r = require('react')
      if (usable(r)) { ReactRef = r; return ReactRef }
    }
  } catch (e) { /* Implementation note. */ }
  const g = typeof globalThis !== 'undefined' ? globalThis : {}
  const cands = [g.React, g.__DSH_REACT__, g.__dshReact, g.window && g.window.React, g.document && g.document.React]
  for (let i = 0; i < cands.length; i++) if (usable(cands[i])) { ReactRef = cands[i]; return ReactRef }
  return null
}

// Implementation note.
function clock(ms) {
  if (typeof ms !== 'number' || ms <= 0) return undefined
  const d = new Date(ms)
  const h = d.getHours()
  const m = d.getMinutes()
  return (h < 10 ? '0' + h : '' + h) + ':' + (m < 10 ? '0' + m : '' + m)
}

function fmtDuration(ms) {
  if (typeof ms !== 'number' || ms < 0) return undefined
  if (ms < 1000) return ms + 'ms'
  if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's'
  return Math.floor(ms / 60000) + 'm' + Math.round((ms % 60000) / 1000) + 's'
}

// Implementation note.

function mark(start, end) { return { start: start, end: end } }

/* Implementation note. */
function collectCall(spot, calls) {
  if (spot === null || typeof spot !== 'object') return
  const id = typeof spot.callId === 'string' ? spot.callId : ''
  const stamp = typeof spot.time === 'number' ? spot.time : null
  if (id === '' || stamp === null) return
  const callTime = typeof spot.callTime === 'number' ? spot.callTime : null
  const found = calls[id]
  // Implementation note.
  if (found !== undefined && (found.end !== null || callTime === null)) return
  calls[id] = callTime === null ? mark(stamp, null) : mark(callTime, stamp)
}

/* Implementation note. */
function walkTimes(spot, calls, depth) {
  if (spot === null || typeof spot !== 'object' || depth > 4) return
  if (Array.isArray(spot)) {
    for (let i = 0; i < spot.length; i++) walkTimes(spot[i], calls, depth + 1)
    return
  }
  collectCall(spot, calls)
  for (const key in spot) if (Object.prototype.hasOwnProperty.call(spot, key)) walkTimes(spot[key], calls, depth + 1)
}

/* Implementation note. */
function collectTimes(nodes) {
  const calls = {}
  const steps = {}
  const list = nodes !== null && typeof nodes === 'object' && typeof nodes.values === 'function' ? nodes.values() : []
  for (let i = 0; i < list.length; i++) {
    const node = list[i]
    if (node === null || typeof node !== 'object') continue
    if (node.kind === 'tool-call' || node.kind === 'tool-result') walkTimes(node.data, calls, 0)
    if (node.kind !== 'assistant-step' && node.kind !== 'assistant') continue
    const data = node.data !== null && typeof node.data === 'object' ? node.data : {}
    const turn = typeof node.turn === 'number' ? node.turn : data.turn
    const step = typeof node.step === 'number' ? node.step : data.step
    const timing = node.timing !== null && typeof node.timing === 'object' ? node.timing : {}
    const start = typeof timing.stepStartTime === 'number' ? timing.stepStartTime : null
    // Implementation note.
    // Implementation note.
    const end = typeof timing.completedTime === 'number' ? timing.completedTime
      : (typeof node.time === 'number' ? node.time
        : (typeof data.time === 'number' ? data.time : null))
    if (nodeProbe === '-' && (node.kind === 'assistant-step' || node.kind === 'assistant')) {
      nodeProbe = 'kind:' + node.kind + ' t:' + turn + ' s:' + step + ' q:' + node.seq + ' time:' + (typeof node.time) +
        ' dtime:' + (typeof data.time) + ' tm:' + (node.timing === undefined ? 'none' : Object.keys(timing).join('/')) +
        ' st:' + start + ' en:' + end
    }
    // Implementation note.
    // Implementation note.
    if (typeof turn === 'number' && typeof step === 'number' && end !== null) {
      steps[turn + ':' + step] = mark(start, end)
    }
  }
  return { calls: calls, steps: steps }
}

/* Implementation note. */
function timeOfKey(key, times) {
  const call = key.indexOf(':tool-call')
  if (call >= 0) {
    const id = key.slice(call + ':tool-call'.length)
    return Object.prototype.hasOwnProperty.call(times.calls, id) ? times.calls[id] : null
  }
  const step = key.indexOf(':assistant-step')
  if (step >= 0) {
    const at = key.slice(step + ':assistant-step'.length)
    return Object.prototype.hasOwnProperty.call(times.steps, at) ? times.steps[at] : null
  }
  return null
}

/* Implementation note.



 */
let seatState = 'react:? seat:?'
let syncRuns = 0
let nodeProbe = '-'

/* Implementation note.



 */
function note(name, text) {
  try {
    if (typeof document !== 'undefined' && document !== null && document.documentElement) {
      document.documentElement.setAttribute(name, text)
    }
  } catch (e) { /* Implementation note. */ }
}

function diag(text) { note('data-dsu-diag', text) }

function countKeys(obj) {
  let n = 0
  for (const k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) n += 1
  return n
}

/* Implementation note. */
function domStepKeys(kids) {
  const out = []
  for (let i = 0; i < kids.length && out.length < 3; i++) {
    const key = kids[i].getAttribute('data-chat-flow-key') || ''
    if (key.indexOf(':assistant-step') >= 0) out.push(key)
  }
  return out.join(',')
}

// Implementation note.

/* Implementation note. */
const cellRects = new Map()
/* Implementation note. */
let kidObs = null
const kidWatched = new Set()
/* Implementation note. */
const morphRuns = new Map()
let morphToken = 0
/* Implementation note. */
let landingActive = null
const landingQueue = []
let landingToken = 0
/* Implementation note. */
const unknownCurrentFrames = new Map()
/* Implementation note. */
let observedFlow = null
let flowObs = null
let lastFlowHeight = 0
let flowRememberFrame = 0

/* Implementation note. */
function motionAllowed() {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    if (typeof document !== 'undefined' && document.documentElement !== null && document.documentElement.hasAttribute(RESIZE_ATTR)) return false
    return !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch (e) { return false }
}

/* Implementation note.



 */
function isBashLifecycleRow(row) {
  return row !== null && typeof row.getAttribute === 'function' && row.getAttribute('data-sample') === 'bash' && row.getAttribute('data-variant') === 'bash'
}

/**
 * Native tools expose one of two lifecycle controls:
 * - ordinary cards own a disclosure row under their data-state card;
 * - the shipped Bash card puts data-state directly on its constrained bash row.
 * The nearest keyed wrapper check keeps a nested renderer from claiming another chat node.
 */
function lifecycleRow(cell) {
  const disclosure = cell.querySelector('[data-disclosure-row]')
  if (disclosure !== null) return disclosure
  const bash = cell.querySelector('[data-sample="bash"][data-variant="bash"][data-state]')
  if (bash === null) return null
  if (typeof bash.closest === 'function') {
    const host = bash.closest('[data-chat-flow-key]')
    if (host !== null && host !== cell) return null
  }
  return bash
}

function belongsToCell(node, cell) {
  if (node === null) return false
  if (typeof node.closest !== 'function') return true
  const owner = node.closest('[data-chat-flow-key]')
  return owner === null || owner === cell
}

function scopedThinkRoots(cell) {
  if (typeof cell.querySelectorAll !== 'function') return []
  const found = cell.querySelectorAll('[data-variant="think"][data-state]')
  const roots = []
  for (let i = 0; i < found.length; i++) if (belongsToCell(found[i], cell)) roots.push(found[i])
  return roots
}

function hasExpandedDisclosure(cell) {
  if (typeof cell.querySelectorAll !== 'function') return false
  const rows = cell.querySelectorAll('[data-disclosure-row][aria-expanded="true"]')
  for (let i = 0; i < rows.length; i++) if (belongsToCell(rows[i], cell)) return true
  return false
}

function lifecycleState(cell) {
  // AssistantMarkdown can hold several reasoning roots in one stable assistant-step wrapper.
  // Running wins over an earlier completed block; otherwise the last terminal root owns the step.
  if (cell.getAttribute('data-chat-flow-kind') === 'assistant-step') {
    const roots = scopedThinkRoots(cell)
    for (let i = 0; i < roots.length; i++) if (roots[i].getAttribute('data-state') === 'running') return 'running'
    for (let i = roots.length - 1; i >= 0; i--) {
      const state = roots[i].getAttribute('data-state')
      if (state === 'ok' || state === 'error' || state === 'stopped' || state === 'cancelled') return state
    }
  }
  const row = lifecycleRow(cell)
  if (row === null) return null
  if (isBashLifecycleRow(row)) {
    const state = row.getAttribute('data-state')
    return typeof state === 'string' && state.length > 0 ? state : null
  }
  // Implementation note.
  // Implementation note.
  if (typeof row.closest === 'function') {
    const owner = row.closest('[data-state]')
    if (owner === null) return null
    if (typeof cell.contains === 'function' && !cell.contains(owner)) return null
    const state = owner.getAttribute('data-state')
    return typeof state === 'string' && state.length > 0 ? state : null
  }
  // Implementation note.
  if (cell.querySelector('[data-state="running"]') !== null) return 'running'
  if (cell.querySelector('[data-state="ok"]') !== null) return 'ok'
  if (cell.querySelector('[data-state="error"]') !== null) return 'error'
  if (cell.querySelector('[data-state="stopped"]') !== null) return 'stopped'
  if (cell.querySelector('[data-state="cancelled"]') !== null) return 'cancelled'
  return null
}

function chipped(chip) {
  if (chip.getAttribute(EXEC_ATTR) === EXEC_CURRENT) return false
  const row = lifecycleRow(chip)
  if (row === null || hasExpandedDisclosure(chip)) return false
  const expanded = row.getAttribute('aria-expanded')
  if (isBashLifecycleRow(row) ? expanded === 'true' : expanded !== 'false') return false
  const kind = chip.getAttribute('data-chat-flow-kind')
  if (kind === 'context') return chip.querySelector('[data-state]') === null
  if (kind !== 'tool-call' && kind !== 'assistant-step') return false
  if (kind === 'assistant-step' && chip.querySelector('[class*="markdown"]') !== null) return false
  const state = lifecycleState(chip)
  return state === 'ok' || state === 'error' || state === 'stopped' || state === 'cancelled'
}

function actionCell(cell) {
  const kind = cell.getAttribute('data-chat-flow-kind')
  return kind === 'tool-call' || kind === 'assistant-step' || kind === 'context'
}

/* Implementation note. */
function runningAction(cell) {
  const kind = cell.getAttribute('data-chat-flow-kind')
  if (kind !== 'tool-call' && kind !== 'assistant-step') return false
  if (kind === 'assistant-step' && cell.querySelector('[class*="markdown"]') !== null) return false
  return lifecycleState(cell) === 'running'
}

function terminalAction(cell) {
  const kind = cell.getAttribute('data-chat-flow-kind')
  if (kind !== 'tool-call' && kind !== 'assistant-step') return false
  if (kind === 'assistant-step' && cell.querySelector('[class*="markdown"]') !== null) return false
  const state = lifecycleState(cell)
  return state === 'ok' || state === 'error' || state === 'stopped' || state === 'cancelled'
}

/* Implementation note. */
function marginOf(cell) {
  try { return parseFloat(window.getComputedStyle(cell).marginTop) || 0 } catch (e) { return 0 }
}

function marginBottomOf(cell) {
  try { return parseFloat(window.getComputedStyle(cell).marginBottom) || 0 } catch (e) { return 0 }
}

function verticalEdges(cell) {
  try {
    const css = window.getComputedStyle(cell)
    return {
      paddingTop: parseFloat(css.paddingTop) || 0,
      paddingBottom: parseFloat(css.paddingBottom) || 0,
      borderTop: parseFloat(css.borderTopWidth) || 0,
      borderBottom: parseFloat(css.borderBottomWidth) || 0,
    }
  } catch (e) {
    return { paddingTop: 0, paddingBottom: 0, borderTop: 0, borderBottom: 0 }
  }
}

function flowPosition(cell, box) {
  const flow = cell.parentElement
  if (flow !== null && typeof flow.getBoundingClientRect === 'function') {
    const frame = flow.getBoundingClientRect()
    if (Number.isFinite(frame.left) && Number.isFinite(frame.top)) {
      return { x: box.left - frame.left, y: box.top - frame.top }
    }
  }
  return { x: box.left, y: box.top }
}

/* Implementation note. */
function resting(cell, chip) {
  const box = cell.getBoundingClientRect()
  const pos = flowPosition(cell, box)
  return { h: box.height, m: marginOf(cell), chip: chip, x: pos.x, y: pos.y }
}

/* Implementation note. */
function invert(cell, dx, dy) {
  if ((Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) || typeof cell.animate !== 'function') return null
  return cell.animate([
    { transform: 'translate3d(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px,0)' },
    { transform: 'translate3d(0px,0px,0)' },
  ], { duration: MORPH_MS, easing: 'cubic-bezier(.22,.8,.25,1)', fill: 'none' })
}

/* Implementation note. */
function cancelMorph(key) {
  const run = morphRuns.get(key)
  if (run === undefined) return null
  morphRuns.delete(key)
  if (typeof window !== 'undefined') {
    window.clearTimeout(run.timer)
    if (run.frame !== 0 && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(run.frame)
  }
  if (typeof run.onEnd === 'function') run.cell.removeEventListener('transitionend', run.onEnd)
  if (run.flip !== undefined && run.flip !== null && typeof run.flip.cancel === 'function') run.flip.cancel()
  run.cell.style.removeProperty('transition')
  run.cell.style.removeProperty('box-sizing')
  run.cell.style.removeProperty('min-height')
  run.cell.style.removeProperty('height')
  run.cell.style.removeProperty('margin-top')
  run.cell.style.removeProperty('margin-bottom')
  run.cell.style.removeProperty('padding-top')
  run.cell.style.removeProperty('padding-bottom')
  run.cell.style.removeProperty('border-top-width')
  run.cell.style.removeProperty('border-bottom-width')
  run.cell.removeAttribute(MORPH_ATTR)
  return run.cell
}

/* Implementation note. */
function settleMorph(key, token) {
  const run = morphRuns.get(key)
  if (run === undefined || run.token !== token) return
  // Implementation note.
  // Implementation note.
  const shownBox = run.cell.getBoundingClientRect()
  const shownPos = flowPosition(run.cell, shownBox)
  const shown = {
    h: shownBox.height,
    m: marginOf(run.cell),
    chip: chipped(run.cell),
    x: shownPos.x,
    y: shownPos.y,
  }
  const cell = cancelMorph(key)
  if (cell === null) return
  const natural = resting(cell, chipped(cell))
  if (actionCell(cell) && motionAllowed() && natural.h > 0.5 && (
    Math.abs(natural.h - shown.h) > 0.5 || Math.abs(natural.m - shown.m) > 0.5
  )) {
    cellRects.set(key, shown)
    startMorph(cell, key, shown, natural.chip)
    return
  }
  // Implementation note.
  // Implementation note.
  cellRects.set(key, natural)
  if (landingActive !== null && landingActive.fallback && landingActive.cell === cell && landingActive.key === key) {
    landingActive.visualDone = true
    landingActive.bridgeDone = true
    finishLanding(landingActive)
  }
}

/* Implementation note.




 */
function armMorph(cell, key, state) {
  if (morphRuns.has(key)) cancelMorph(key)
  const token = ++morphToken
  const onEnd = function (event) {
    if (event.target === cell && event.propertyName === 'height') settleMorph(key, token)
  }
  cell.setAttribute(MORPH_ATTR, state)
  const timer = window.setTimeout(function () { settleMorph(key, token) }, MORPH_MS + 140)
  morphRuns.set(key, { cell: cell, timer: timer, token: token, onEnd: onEnd, frame: 0 })
  cell.addEventListener('transitionend', onEnd)
}

/* Implementation note.



 */
function nextMorphFrame(key, apply) {
  const run = morphRuns.get(key)
  if (run === undefined) return
  const play = function () {
    if (morphRuns.get(key) !== run) return
    run.frame = 0
    apply(run)
  }
  const ready = function () {
    if (morphRuns.get(key) !== run) return
    run.frame = 0
    run.cell.style.removeProperty('transition')
    void run.cell.offsetHeight
    if (typeof window.requestAnimationFrame === 'function') run.frame = window.requestAnimationFrame(play)
    else play()
  }
  if (typeof window.requestAnimationFrame === 'function') run.frame = window.requestAnimationFrame(ready)
  else ready()
}

/* Implementation note.



 */
function startBirth(cell, key, now) {
  const natural = resting(cell, now)
  const box = cell.getBoundingClientRect()
  // Implementation note.
  // Implementation note.
  if (box.width <= 0 || natural.h <= 0.5) { cellRects.delete(key); return }
  cellRects.set(key, natural)
  if (morphRuns.has(key)) cancelMorph(key)
  const bottom = marginBottomOf(cell)
  const edges = verticalEdges(cell)
  cell.style.transition = 'none'
  // Implementation note.
  // Implementation note.
  // Implementation note.
  // Implementation note.
  cell.style.boxSizing = 'border-box'
  cell.style.minHeight = '0px'
  cell.style.height = '0px'
  cell.style.marginTop = '0px'
  cell.style.marginBottom = '0px'
  cell.style.paddingTop = '0px'
  cell.style.paddingBottom = '0px'
  cell.style.borderTopWidth = '0px'
  cell.style.borderBottomWidth = '0px'
  void cell.offsetHeight
  armMorph(cell, key, 'birth')
  nextMorphFrame(key, function () {
    cell.style.height = natural.h.toFixed(1) + 'px'
    cell.style.marginTop = natural.m.toFixed(1) + 'px'
    cell.style.marginBottom = bottom.toFixed(1) + 'px'
    cell.style.paddingTop = edges.paddingTop.toFixed(1) + 'px'
    cell.style.paddingBottom = edges.paddingBottom.toFixed(1) + 'px'
    cell.style.borderTopWidth = edges.borderTop.toFixed(1) + 'px'
    cell.style.borderBottomWidth = edges.borderBottom.toFixed(1) + 'px'
  })
}

/* Implementation note.




 */
function startMorph(cell, key, was, now) {
  const box = cell.getBoundingClientRect()
  if (box.width <= 0 || box.height <= 0) return
  const interrupted = morphRuns.has(key)
  const from = interrupted ? box.height : was.h
  const fromMargin = interrupted ? marginOf(cell) : was.m
  const firstPos = flowPosition(cell, box)
  // Implementation note.
  // Implementation note.
  const firstX = interrupted || !Number.isFinite(was.x) ? firstPos.x : was.x
  const firstY = interrupted || !Number.isFinite(was.y) ? firstPos.y : was.y
  const flow = cell.parentElement !== null && cell.parentElement === observedFlow ? observedFlow : null
  const beforeFlow = flow !== null ? lastFlowHeight : 0
  if (interrupted) cancelMorph(key)

  cell.style.transition = 'none'
  cell.style.removeProperty('box-sizing')
  cell.style.removeProperty('min-height')
  cell.style.removeProperty('height')
  cell.style.removeProperty('margin-top')
  cell.style.removeProperty('margin-bottom')
  // Implementation note.
  const to = cell.getBoundingClientRect().height
  const toMargin = marginOf(cell)
  const toBottom = marginBottomOf(cell)

  // Implementation note.
  // Implementation note.
  cell.style.boxSizing = 'border-box'
  cell.style.minHeight = '0px'
  cell.style.height = from.toFixed(1) + 'px'
  cell.style.marginTop = fromMargin.toFixed(1) + 'px'
  cell.style.marginBottom = toBottom.toFixed(1) + 'px'
  void cell.offsetHeight

  // Implementation note.
  // Implementation note.
  let bridge = 0
  if (flow !== null && beforeFlow > 0) {
    bridge = beforeFlow - flow.getBoundingClientRect().height
    if (Math.abs(bridge) > 0.5) {
      cell.style.marginBottom = (toBottom + bridge).toFixed(1) + 'px'
      void cell.offsetHeight
    }
  }

  const lastBox = cell.getBoundingClientRect()
  const lastPos = flowPosition(cell, lastBox)
  const dx = firstX - lastPos.x
  const dy = firstY - lastPos.y
  const moving = from > 0.5 && to > 0.5 && (
    Math.abs(to - from) > 0.5 ||
    Math.abs(toMargin - fromMargin) > 0.5 ||
    Math.abs(bridge) > 0.5 ||
    Math.abs(dx) > 0.5 ||
    Math.abs(dy) > 0.5
  )
  if (!moving) {
    cell.style.removeProperty('transition')
    cell.style.removeProperty('box-sizing')
    cell.style.removeProperty('min-height')
    cell.style.removeProperty('height')
    cell.style.removeProperty('margin-top')
    cell.style.removeProperty('margin-bottom')
    cellRects.set(key, resting(cell, now))
    if (landingActive !== null && landingActive.fallback && landingActive.cell === cell && landingActive.key === key) {
      landingActive.visualDone = true
      landingActive.bridgeDone = true
      finishLanding(landingActive)
    }
    return
  }

  armMorph(cell, key, now ? 'fold' : 'open')
  nextMorphFrame(key, function (run) {
    cell.style.height = to.toFixed(1) + 'px'
    cell.style.marginTop = toMargin.toFixed(1) + 'px'
    cell.style.marginBottom = toBottom.toFixed(1) + 'px'
    run.flip = invert(cell, dx, dy)
  })
}

function landingQueued(cell) {
  if (landingActive !== null && landingActive.cell === cell) return true
  for (let i = 0; i < landingQueue.length; i++) if (landingQueue[i].cell === cell) return true
  return false
}

function clearLandingFrames(run) {
  if (typeof window !== 'undefined') {
    if (run.frame !== 0 && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(run.frame)
    window.clearTimeout(run.timer)
    window.clearTimeout(run.visualTimer)
  }
  run.frame = 0
  run.timer = 0
  run.visualTimer = 0
  if (typeof run.onEnd === 'function') run.cell.removeEventListener('transitionend', run.onEnd)
  run.onEnd = null
}

/* Implementation note. */
function cancelLanding(run, advance) {
  if (landingActive !== run) return
  clearLandingFrames(run)
  if (run.transition !== null && typeof run.transition.skipTransition === 'function') {
    try { run.transition.skipTransition() } catch (e) {}
  }
  if (morphRuns.has(run.key)) cancelMorph(run.key)
  const cell = run.cell
  cell.style.removeProperty('transition')
  cell.style.removeProperty('margin-bottom')
  cell.style.removeProperty('view-transition-name')
  cell.removeAttribute(MORPH_ATTR)
  if (cell.isConnected !== false && runningAction(cell)) cell.setAttribute(EXEC_ATTR, EXEC_CURRENT)
  else cell.removeAttribute(EXEC_ATTR)
  if (typeof document !== 'undefined' && document.documentElement !== null) document.documentElement.removeAttribute(VIEW_ATTR)
  if (cell.isConnected !== false) cellRects.set(run.key, resting(cell, chipped(cell)))
  landingActive = null
  if (advance) pumpLanding()
}

function finishLanding(run) {
  if (landingActive !== run || !run.visualDone || !run.bridgeDone) return
  clearLandingFrames(run)
  const cell = run.cell
  cell.style.removeProperty('transition')
  cell.style.removeProperty('margin-bottom')
  cell.style.removeProperty('view-transition-name')
  if (typeof document !== 'undefined' && document.documentElement !== null) document.documentElement.removeAttribute(VIEW_ATTR)
  cell.removeAttribute(MORPH_ATTR)
  cell.removeAttribute(EXEC_ATTR)
  if (cell.isConnected !== false) cellRects.set(run.key, resting(cell, chipped(cell)))
  landingActive = null
  pumpLanding()
}

function completeLandingPart(run, part) {
  if (landingActive !== run) return
  if (part === 'visualDone' && run.visualTimer !== 0 && typeof window !== 'undefined') {
    window.clearTimeout(run.visualTimer)
    run.visualTimer = 0
  }
  run[part] = true
  finishLanding(run)
}

function stageLandingBridge(run, beforeFlow) {
  if (landingActive !== run) return
  const cell = run.cell
  const flow = cell.parentElement
  const naturalBottom = marginBottomOf(cell)
  const afterFlow = flow !== null && typeof flow.getBoundingClientRect === 'function'
    ? flow.getBoundingClientRect().height
    : beforeFlow
  const bridge = beforeFlow - afterFlow
  if (Math.abs(bridge) <= 0.5) {
    run.bridgeDone = true
    return
  }
  run.bridgeDone = false
  cell.setAttribute(MORPH_ATTR, EXEC_LANDING)
  // Implementation note.
  // Implementation note.
  cell.style.marginBottom = (naturalBottom + bridge).toFixed(1) + 'px'
  void cell.offsetHeight
  run.onEnd = function (event) {
    if (event.target !== cell || event.propertyName !== 'margin-bottom') return
    completeLandingPart(run, 'bridgeDone')
  }
  cell.addEventListener('transitionend', run.onEnd)
  run.timer = window.setTimeout(function () { completeLandingPart(run, 'bridgeDone') }, MORPH_MS + 140)
  const release = function () {
    if (landingActive !== run) return
    run.frame = 0
    cell.style.marginBottom = naturalBottom.toFixed(1) + 'px'
  }
  const ready = function () {
    if (landingActive !== run) return
    run.frame = 0
    cell.style.removeProperty('transition')
    void cell.offsetHeight
    if (typeof window.requestAnimationFrame === 'function') run.frame = window.requestAnimationFrame(release)
    else release()
  }
  if (typeof window.requestAnimationFrame === 'function') run.frame = window.requestAnimationFrame(ready)
  else ready()
}

function fallbackLanding(run) {
  if (landingActive !== run) return
  const cell = run.cell
  const box = cell.getBoundingClientRect()
  const pos = flowPosition(cell, box)
  const was = { h: box.height, m: marginOf(cell), chip: false, x: pos.x, y: pos.y }
  if (morphRuns.has(run.key)) cancelMorph(run.key)
  cell.setAttribute(EXEC_ATTR, EXEC_LANDING)
  startMorph(cell, run.key, was, true)
  run.fallback = true
  if (!morphRuns.has(run.key)) {
    run.visualDone = true
    run.bridgeDone = true
    finishLanding(run)
  }
}

function startLanding(item) {
  const cell = item.cell
  if (cell.isConnected === false || cell.parentElement === null) {
    cell.removeAttribute(EXEC_ATTR)
    pumpLanding()
    return
  }
  const run = {
    cell: cell,
    key: item.key,
    token: ++landingToken,
    frame: 0,
    timer: 0,
    visualTimer: 0,
    onEnd: null,
    transition: null,
    visualDone: false,
    bridgeDone: true,
    fallback: false,
  }
  landingActive = run
  if (!item.animate || typeof document === 'undefined' || typeof document.startViewTransition !== 'function') {
    if (!item.animate) {
      if (morphRuns.has(run.key)) cancelMorph(run.key)
      cell.setAttribute(EXEC_ATTR, EXEC_LANDING)
      run.visualDone = true
      run.bridgeDone = true
      finishLanding(run)
    } else fallbackLanding(run)
    return
  }

  const flow = cell.parentElement
  const beforeFlow = flow !== null && typeof flow.getBoundingClientRect === 'function'
    ? flow.getBoundingClientRect().height
    : 0
  cell.style.viewTransitionName = VIEW_NAME
  if (document.documentElement !== null) document.documentElement.setAttribute(VIEW_ATTR, 'yes')
  try {
    run.transition = document.startViewTransition(function () {
      if (landingActive !== run) return
      if (morphRuns.has(run.key)) cancelMorph(run.key)
      // Broad child transitions must not own the VT endpoint. Freeze first, release the
      // wrapper to its real chip layout, force that final layout, then measure the bridge.
      cell.style.transition = 'none'
      cell.setAttribute(EXEC_ATTR, EXEC_LANDING)
      void cell.offsetHeight
      stageLandingBridge(run, beforeFlow)
      cellRects.set(run.key, resting(cell, chipped(cell)))
    })
  } catch (e) {
    cell.style.removeProperty('view-transition-name')
    if (document.documentElement !== null) document.documentElement.removeAttribute(VIEW_ATTR)
    fallbackLanding(run)
    return
  }
  const finished = run.transition !== null ? run.transition.finished : null
  if (finished !== null && typeof finished.then === 'function') {
    finished.then(
      function () { completeLandingPart(run, 'visualDone') },
      function () { completeLandingPart(run, 'visualDone') },
    )
    run.visualTimer = window.setTimeout(function () {
      if (landingActive !== run || run.visualDone) return
      if (run.transition !== null && typeof run.transition.skipTransition === 'function') {
        try { run.transition.skipTransition() } catch (e) {}
      }
      completeLandingPart(run, 'visualDone')
    }, MORPH_MS + 700)
  } else completeLandingPart(run, 'visualDone')
}

function clearUnknownCurrentFrame(cell) {
  const frame = unknownCurrentFrames.get(cell)
  if (frame === undefined) return
  unknownCurrentFrames.delete(cell)
  if (frame !== 0 && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frame)
}

function scheduleUnknownCurrent(cell, key, animate) {
  if (unknownCurrentFrames.has(cell)) return
  const check = function () {
    unknownCurrentFrames.delete(cell)
    if (cell.isConnected === false || cell.getAttribute(EXEC_ATTR) !== EXEC_CURRENT) return
    if (runningAction(cell)) return
    if (terminalAction(cell)) { queueLanding(cell, key, animate); return }
    // Custom/changed renderer without a recognised lifecycle root may not own the lane forever.
    cell.removeAttribute(EXEC_ATTR)
    if (cell.isConnected !== false) cellRects.set(key, resting(cell, chipped(cell)))
  }
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    unknownCurrentFrames.set(cell, window.requestAnimationFrame(check))
  } else {
    unknownCurrentFrames.set(cell, 0)
    check()
  }
}

function pumpLanding() {
  if (landingActive !== null) return
  while (landingQueue.length > 0) {
    const next = landingQueue.shift()
    const cell = next.cell
    if (cell.isConnected === false || cell.getAttribute(EXEC_ATTR) !== EXEC_CURRENT) continue
    // Lifecycle can change while another named transition owns the queue.
    if (runningAction(cell)) continue
    if (!terminalAction(cell)) { scheduleUnknownCurrent(cell, next.key, next.animate); continue }
    next.animate = next.animate && motionAllowed()
    startLanding(next)
    return
  }
}

function queueLanding(cell, key, animate) {
  if (landingQueued(cell)) return
  landingQueue.push({ cell: cell, key: key, animate: animate })
  pumpLanding()
}

/** Mark the real native wrappers; no clone, placeholder, portal or CSS order is involved. */
function syncExecution(flow, animate) {
  if (flow === null) return
  const kids = flow.children
  for (let i = 0; i < kids.length; i++) {
    const cell = kids[i]
    if (cell.nodeType !== 1) continue
    const key = cell.getAttribute('data-chat-flow-key') || ''
    if (key.length === 0) continue
    const state = cell.getAttribute(EXEC_ATTR)
    if (runningAction(cell)) {
      clearUnknownCurrentFrame(cell)
      if (state === null) cell.setAttribute(EXEC_ATTR, EXEC_CURRENT)
      continue
    }
    if (state !== EXEC_CURRENT) continue
    if (terminalAction(cell)) {
      clearUnknownCurrentFrame(cell)
      queueLanding(cell, key, animate)
    } else scheduleUnknownCurrent(cell, key, animate)
  }
}

/* Implementation note.


 */
function morphCells(kids, animate) {
  if (!animate || typeof window === 'undefined') return
  for (let i = 0; i < kids.length; i++) {
    const cell = kids[i]
    if (cell.nodeType !== 1) continue
    const key = cell.getAttribute('data-chat-flow-key') || ''
    if (key.length === 0) continue
    if (cell.getAttribute(EXEC_ATTR) === EXEC_LANDING || landingQueued(cell)) continue
    const now = chipped(cell)
    const was = cellRects.get(key)
    if (was === undefined || was.h <= 0.5) {
      const natural = resting(cell, now)
      if (natural.h <= 0.5) { cellRects.delete(key); continue }
      if (cell.getAttribute(EXEC_ATTR) === EXEC_CURRENT && runningAction(cell)) startBirth(cell, key, now)
      else cellRects.set(key, natural)
      continue
    }
    if (was.chip !== now) startMorph(cell, key, was, now)
    was.chip = now
  }
  // Implementation note.
  // Implementation note.
  if (cellRects.size > kids.length * 2 + 8) {
    const alive = new Set()
    for (let i = 0; i < kids.length; i++) {
      const key = kids[i].nodeType === 1 ? kids[i].getAttribute('data-chat-flow-key') || '' : ''
      if (key.length > 0) alive.add(key)
    }
    for (const key of Array.from(cellRects.keys())) if (!alive.has(key)) cellRects.delete(key)
  }
}

/* Implementation note.

 */

/* Implementation note.


 */
function kidObserve(flow) {
  if (flow === null || typeof ResizeObserver !== 'function') return flow
  if (kidObs === null) kidObs = new ResizeObserver(kidResize)
  observeFlow(flow)
  const kids = flow.children
  for (let i = 0; i < kids.length; i++) {
    const kid = kids[i]
    if (kid.nodeType !== 1 || kidWatched.has(kid)) continue
    kidWatched.add(kid)
    kidObs.observe(kid)
  }
  for (const kid of kidWatched) {
    if (kid.isConnected) continue
    kidWatched.delete(kid)
    kidObs.unobserve(kid)
  }
  return flow
}

/* Implementation note. */
function kidResize(entries) {
  for (let i = 0; i < entries.length; i++) {
    const kid = entries[i].target
    const key = kid.getAttribute('data-chat-flow-key') || ''
    if (key.length === 0) continue
    // Implementation note.
    if (kid.getAttribute(MORPH_ATTR) !== null || kid.getAttribute(EXEC_ATTR) === EXEC_LANDING || landingQueued(kid)) continue
    const now = chipped(kid)
    const was = cellRects.get(key)
    const box = kid.getBoundingClientRect()
    if (box.height <= 0.5) { cellRects.delete(key); continue }
    if ((was === undefined || was.h <= 0.5) && kid.getAttribute(EXEC_ATTR) === EXEC_CURRENT && runningAction(kid)) {
      startBirth(kid, key, now)
      continue
    }
    // Implementation note.
    // Implementation note.
    if (was !== undefined && actionCell(kid) && motionAllowed() && was.h - box.height >= 8) {
      startMorph(kid, key, was, now)
      continue
    }
    cellRects.set(key, resting(kid, now))
  }
  // Implementation note.
  if (observedFlow !== null) lastFlowHeight = observedFlow.getBoundingClientRect().height
}

/** Flow ResizeObserver remembers geometry only after all observers of the frame have run. */
function rememberFlowFrame() {
  flowRememberFrame = 0
  if (observedFlow !== null) lastFlowHeight = observedFlow.getBoundingClientRect().height
}

function queueFlowFrame() {
  if (flowRememberFrame !== 0 || typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return
  flowRememberFrame = window.requestAnimationFrame(rememberFlowFrame)
}

function onFlowResize() {
  queueFlowFrame()
}

function observeFlow(flow) {
  if (flow === null || typeof ResizeObserver !== 'function') return flow
  if (flowObs === null) flowObs = new ResizeObserver(onFlowResize)
  if (observedFlow === flow) return flow
  if (observedFlow !== null) flowObs.unobserve(observedFlow)
  observedFlow = flow
  lastFlowHeight = flow.getBoundingClientRect().height
  flowObs.observe(flow)
  return flow
}


/* Implementation note. */
function kidDetach() {
  if (kidObs !== null) { kidObs.disconnect(); kidObs = null }
  if (flowObs !== null) { flowObs.disconnect(); flowObs = null }
  if (flowRememberFrame !== 0 && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(flowRememberFrame)
  flowRememberFrame = 0
  observedFlow = null
  lastFlowHeight = 0
  landingQueue.length = 0
  if (landingActive !== null) cancelLanding(landingActive, false)
  for (const entry of unknownCurrentFrames) {
    const frame = entry[1]
    if (frame !== 0 && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frame)
  }
  unknownCurrentFrames.clear()
  for (const kid of kidWatched) {
    kid.removeAttribute(EXEC_ATTR)
    kid.style.removeProperty('view-transition-name')
  }
  kidWatched.clear()
  for (const key of Array.from(morphRuns.keys())) cancelMorph(key)
  morphRuns.clear()
  cellRects.clear()
  return null
}

function writeAttr(node, name, value) {
  if (value === null) {
    if (node.hasAttribute(name)) node.removeAttribute(name)
    return
  }
  if (node.getAttribute(name) !== value) node.setAttribute(name, value)
}

function syncTimes(nodes) {
  if (typeof document === 'undefined' || document === null) return
  syncRuns += 1
  const flow = document.querySelector(FLOW_SELECTOR)
  if (flow === null) { diag('sync#' + syncRuns + ' ' + seatState + ' flow:0'); return }
  if (observedFlow !== null && observedFlow !== flow) kidDetach()
  const times = collectTimes(nodes)
  const kids = flow.children
  // Implementation note.
  const animate = motionAllowed()
  syncExecution(flow, animate)
  morphCells(kids, animate)
  kidObserve(flow)
  diag('sync#' + syncRuns + ' ' + seatState + ' flow:1 calls:' + countKeys(times.calls) + ' steps:' + countKeys(times.steps) + ' chips:' + kids.length + ' | ' + nodeProbe + ' | steps:' + Object.keys(times.steps).slice(0, 3).join(',') + ' | dom:' + domStepKeys(kids))
  // Implementation note.
  // Implementation note.
  // Implementation note.
  const rows = []
  const marks = []
  for (let i = 0; i < kids.length; i++) {
    const chip = kids[i]
    if (chip.nodeType !== 1) continue
    const spot = timeOfKey(chip.getAttribute('data-chat-flow-key') || '', times)
    marks.push({ chip: chip, spot: spot })
    if (chip.getClientRects().length === 0) continue
    const top = chip.offsetTop
    const row = rows.length > 0 ? rows[rows.length - 1] : null
    if (row === null || Math.abs(row.top - top) > ROW_TOLERANCE) {
      rows.push({ top: top, first: chip, start: spot === null ? null : spot.start, end: spot === null ? null : spot.end })
      continue
    }
    if (spot === null) continue
    if (typeof spot.start === 'number' && (row.start === null || spot.start < row.start)) row.start = spot.start
    if (spot.end !== null && (row.end === null || spot.end > row.end)) row.end = spot.end
  }
  const rowLabels = new Map()
  for (let r = 0; r < rows.length; r++) {
    const line = rows[r]
    if (line.end === null || line.first === null) continue
    // Implementation note.
    // Implementation note.
    // Implementation note.
    // Implementation note.
    // Implementation note.
    const span = line.start === null
      ? clock(line.end)
      : clock(line.start) + ' \u00b7 ' + fmtDuration(Math.max(0, line.end - line.start))
    if (typeof span === 'string' && span.length > 0) rowLabels.set(line.first, span)
  }
  // Implementation note.
  // Implementation note.
  for (let i = 0; i < marks.length; i++) {
    const chip = marks[i].chip
    const spot = marks[i].spot
    writeAttr(chip, START_ATTR, spot === null ? null : (clock(spot.start) || ''))
    writeAttr(chip, END_ATTR, spot === null ? null : (spot.end === null ? '' : (clock(spot.end) || '')))
    writeAttr(chip, ROW_ATTR, rowLabels.has(chip) ? rowLabels.get(chip) : null)
  }
}

// Implementation note.
// Implementation note.
let syncedNodes = null

function syncLabels(nodes, force) {
  if (!force && nodes === syncedNodes) return
  syncedNodes = nodes
  try {
    syncTimes(nodes)
  } catch (e) {
    syncedNodes = null
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[dsu] time labels could not be arranged: ' + (e && e.message ? e.message : e))
    }
  }
}

const EMPTY_NODES = { values: function () { return [] } }

/* Implementation note. */
function pickNodes(snapshot) {
  if (snapshot !== null && typeof snapshot === 'object' && snapshot.nodes !== undefined) return snapshot.nodes
  return EMPTY_NODES
}

/* Implementation note.



 */
function TimeRowEntry(props) {
  const React = getReact()
  if (React === null) return null
  const seat = props !== null && typeof props === 'object' ? props : {}
  const useChat = typeof seat.useChat === 'function' ? seat.useChat : null
  seatState = 'react:' + (React !== null ? 1 : 0) + ' seat:' + (useChat !== null ? 1 : 0) + ' keys:' + Object.keys(seat).join(',')
  note('data-dsu-seat', seatState)
  const nodes = useChat === null ? EMPTY_NODES : useChat(pickNodes)
  // Implementation note.
  // Implementation note.
  // Implementation note.
  // Implementation note.
  const live = React.useRef(nodes)
  live.current = nodes
  React.useEffect(function () {
    note('data-dsu-mount', 'yes')
    syncLabels(live.current, true)
    if (typeof window === 'undefined') return undefined
    let resizeTimer = 0
    let syncTimer = 0
    let lastSync = 0
    let mutationFlow = null
    let observer = null
    let rootObserver = null

    function settleMotion() {
      if (landingActive !== null) cancelLanding(landingActive, true)
      for (const key of Array.from(morphRuns.keys())) {
        const cell = cancelMorph(key)
        if (cell !== null && cell.isConnected !== false) cellRects.set(key, resting(cell, chipped(cell)))
      }
    }

    function ensureObservedFlow() {
      const next = document.querySelector(FLOW_SELECTOR)
      if (next === mutationFlow) return next
      if (observer !== null) observer.disconnect()
      if (mutationFlow !== null || observedFlow !== null) kidDetach()
      mutationFlow = next
      if (observer !== null && next !== null) {
        observer.observe(next, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['aria-expanded', 'data-state', 'data-chat-flow-kind'],
        })
      }
      return next
    }

    function onMutations(records) {
      const live2 = ensureObservedFlow()
      if (live2 !== null) {
        syncExecution(live2, motionAllowed())
        kidObserve(live2)
      }
      // Lifecycle state is handled in the same microtask; slower row labels remain throttled.
      let urgent = false
      for (let i = 0; i < records.length && !urgent; i++) {
        const record = records[i]
        if (record.type === 'attributes') urgent = true
        else if (live2 !== null && record.target === live2) urgent = true
        else if (record.type === 'childList' && live2 !== null) {
          const target = record.target.nodeType === 1 ? record.target : record.target.parentElement
          const owner = target !== null && typeof target.closest === 'function' ? target.closest('[data-chat-flow-key]') : null
          const key = owner !== null ? owner.getAttribute('data-chat-flow-key') || '' : ''
          const was = key.length > 0 ? cellRects.get(key) : undefined
          // ChatNodeSeat may arrive empty and receive its card in a nested commit. That first
          // meaningful footprint is urgent; ordinary streaming into an established card is not.
          if (owner !== null && owner.parentElement === live2 && (was === undefined || was.h <= 0.5)) urgent = true
        }
      }
      if (urgent && live2 !== null) morphCells(live2.children, motionAllowed())
      if (syncTimer !== 0) return
      syncTimer = window.setTimeout(function () {
        syncTimer = 0
        lastSync = Date.now()
        syncLabels(live.current, true)
      }, Math.max(0, SYNC_MS - (Date.now() - lastSync)))
    }

    if (typeof MutationObserver === 'function') {
      observer = new MutationObserver(onMutations)
      ensureObservedFlow()
      // A tiny identity observer survives an absent/replaced flow. It never inspects attributes;
      // the detailed observer above remains scoped to the live chat-flow.
      rootObserver = new MutationObserver(function () {
        const before = mutationFlow
        const next = ensureObservedFlow()
        if (next !== before && next !== null) syncLabels(live.current, true)
      })
      const root = document.body || document.documentElement
      if (root !== null) rootObserver.observe(root, { childList: true, subtree: true })
    }

    // Resize invalidates captured endpoints. Settle first, keep transitions disabled until stable.
    function onResize() {
      if (document.documentElement !== null) document.documentElement.setAttribute(RESIZE_ATTR, 'yes')
      settleMotion()
      ensureObservedFlow()
      if (resizeTimer !== 0) window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(function () {
        resizeTimer = 0
        if (document.documentElement !== null) document.documentElement.removeAttribute(RESIZE_ATTR)
      }, 220)
      syncLabels(live.current, true)
    }
    window.addEventListener('resize', onResize)

    const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
    const onMotion = function () {
      if (media !== null && media.matches) settleMotion()
      syncLabels(live.current, true)
    }
    if (media !== null && typeof media.addEventListener === 'function') media.addEventListener('change', onMotion)

    return function () {
      window.removeEventListener('resize', onResize)
      if (media !== null && typeof media.removeEventListener === 'function') media.removeEventListener('change', onMotion)
      if (resizeTimer !== 0) window.clearTimeout(resizeTimer)
      if (syncTimer !== 0) window.clearTimeout(syncTimer)
      if (observer !== null) observer.disconnect()
      if (rootObserver !== null) rootObserver.disconnect()
      kidDetach()
    }
  }, [])
  return null
}

/* Implementation note.







 */
export function registerTimes(ctx) {
  const slots = ctx && (ctx.slots || (typeof ctx.get === 'function' && ctx.get('slots')))
  if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
    return function () {}
  }
  const off = slots.inject(DOCK_SLOT, function () {
    let dispose = null
    try {
      dispose = slots.register({ name: DOCK_SLOT, id: TIME_ENTRY_ID, order: 90, label: 'Action times' }, TimeRowEntry)
    } catch (e) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[dsu] row label registration failed: ' + (e && e.message ? e.message : e))
      }
    }
    return function () { try { if (typeof dispose === 'function') dispose() } catch (e) { /* Implementation note. */ } }
  })
  return function () { try { if (typeof off === 'function') off() } catch (e) { /* Implementation note. */ } }
}
