// Safe, additive CDSH conversation extensions.
// Native DSH keeps ownership of Chat rows, tool renderers, approvals and layout.

export const TURN_INSIGHTS_ID = 'cdsh/turn-insights'
export const PLAN_COPY_ID = 'cdsh/plan-copy'
export const FOCUS_VIEW_ID = 'cdsh/focus'

const noop = () => {}
const retryableNoop = () => {
  const dispose = () => {}
  dispose.cdshRetryableFailure = true
  return dispose
}
const disposeOf = value => {
  const dispose = typeof value === 'function' ? value : value && typeof value.dispose === 'function' ? () => value.dispose() : null
  if (!dispose) return noop
  let closed = false
  return () => {
    if (closed) return
    closed = true
    dispose()
  }
}
const asText = value => {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join(' ')
  if (typeof value === 'object') {
    for (const key of ['text', 'content', 'value', 'title', 'label']) {
      if (typeof value[key] === 'string') return value[key]
    }
  }
  return ''
}
const preview = (value, limit = 220) => {
  const text = asText(value).replace(/\s+/g, ' ').trim()
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text
}
const turnNumber = value => Number.isFinite(Number(value)) ? Number(value) : value
const elapsed = (start, end) => {
  if (!Number.isFinite(start)) return ''
  const ms = Math.max(0, (Number.isFinite(end) ? end : Date.now()) - start)
  if (ms < 1000) return ms + ' ms'
  if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' s'
  const minutes = Math.floor(ms / 60000)
  const seconds = Math.floor((ms % 60000) / 1000)
  return minutes + 'm ' + seconds + 's'
}

function status(api, feature, value, detail) {
  try {
    if (api && typeof api.reportFeatureStatus === 'function') api.reportFeatureStatus(feature, value, detail)
  } catch (_) {}
}

function boundaryOf(React, api, feature) {
  return class CDSHBoundary extends React.Component {
    constructor(props) {
      super(props)
      this.state = { failed: false }
    }
    static getDerivedStateFromError() { return { failed: true } }
    componentDidCatch(error) {
      status(api, feature, 'failed', String(error && (error.message || error) || 'Render failed'))
      try { console.warn('[cdsh] ' + feature + ' render failed', error) } catch (_) {}
    }
    render() {
      if (this.state.failed) return null
      return this.props.children
    }
  }
}

function registerOwnedSlot(ctx, owner, options, Component, api, feature) {
  const slots = ctx && (ctx.slots || (typeof ctx.get === 'function' && ctx.get('slots')))
  if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
    status(api, feature, 'unsupported', 'The required Slots service is unavailable.')
    return noop
  }
  try {
    let failedSynchronously = false
    const dispose = slots.inject(owner, () => {
      try {
        const registered = disposeOf(slots.register(options, Component))
        status(api, feature, 'active', 'Compatible with this DSH build.')
        return disposeOf(() => {
          registered()
          status(api, feature, 'waiting', 'Waiting for the DSH slot owner to return.')
        })
      } catch (error) {
        failedSynchronously = true
        status(api, feature, 'failed', 'Slot registration failed: ' + String(error && (error.message || error) || error))
        try { console.warn('[cdsh] failed to register ' + options.id, error) } catch (_) {}
        return noop
      }
    })
    const owned = disposeOf(dispose)
    if (failedSynchronously) {
      owned()
      return retryableNoop()
    }
    return owned
  } catch (error) {
    status(api, feature, 'failed', 'Slot injection failed: ' + String(error && (error.message || error) || error))
    return retryableNoop()
  }
}

function turnMetrics(snapshot, turn) {
  if (!snapshot) return { steps: 0, actions: 0, start: null, end: null }
  let keys = []
  try { keys = snapshot.locations && snapshot.locations.getTurn ? snapshot.locations.getTurn(turn) || [] : [] } catch (_) {}
  let steps = 0
  let actions = 0
  for (const key of keys) {
    let node
    try { node = snapshot.nodes && snapshot.nodes.get ? snapshot.nodes.get(key) : null } catch (_) { node = null }
    const kind = node && typeof node.kind === 'string' ? node.kind : ''
    if (kind === 'assistant-step' || kind === 'turn-process') steps++
    if (/tool|call|action|approval|question/.test(kind)) actions++
  }
  let timing
  try {
    const timings = snapshot.legacy && snapshot.legacy.turnTimings
    timing = timings && typeof timings.get === 'function' ? timings.get(turn) : timings && timings[turn]
  } catch (_) { timing = null }
  return {
    steps,
    actions,
    start: timing && Number.isFinite(timing.startTime) ? timing.startTime : timing && Number.isFinite(timing.start) ? timing.start : null,
    end: timing && Number.isFinite(timing.endTime) ? timing.endTime : timing && Number.isFinite(timing.end) ? timing.end : null,
  }
}

export function installTurnInsights(ctx, api, React) {
  if (!React || !React.Component || typeof React.createElement !== 'function') {
    status(api, 'turnInsights', 'unsupported', 'The host React capability is unavailable.')
    return noop
  }
  const h = React.createElement
  const Boundary = boundaryOf(React, api, 'turnInsights')
  function Insight(props) {
    const useChat = props && props.useChat
    if (typeof useChat !== 'function') throw new Error('Native useChat selector is unavailable')
    const locations = useChat(value => value.locations)
    const nodes = useChat(value => value.nodes)
    const legacy = useChat(value => value.legacy)
    const turnLocation = props && props.turn
    const turn = turnNumber(turnLocation && typeof turnLocation === 'object' ? turnLocation.turn : turnLocation)
    const metrics = turnMetrics({ locations, nodes, legacy }, turn)
    const running = metrics.start !== null && metrics.end === null
    const [, tick] = React.useState(0)
    React.useEffect(() => {
      if (!running) return undefined
      const timer = setInterval(() => tick(value => value + 1), 1000)
      return () => clearInterval(timer)
    }, [running])
    const parts = ['Turn ' + turn]
    if (metrics.steps > 0) parts.push(metrics.steps + (metrics.steps === 1 ? ' step' : ' steps'))
    if (metrics.actions > 0) parts.push(metrics.actions + (metrics.actions === 1 ? ' action' : ' actions'))
    const duration = elapsed(metrics.start, metrics.end)
    if (duration) parts.push((running ? 'running ' : '') + duration)
    return h('div', { className: 'cdsh-turn-insights', role: 'status', 'aria-label': 'CDSH turn insights' },
      h('span', { className: 'cdsh-turn-insights__mark', 'aria-hidden': true }, '◆'),
      h('span', null, parts.join(' · ')))
  }
  const Wrapped = props => h(Boundary, null, h(Insight, props))
  return registerOwnedSlot(ctx, 'conversation.chat.turnTail', {
    name: 'conversation.chat.turnTail', id: TURN_INSIGHTS_ID, order: 90, label: 'CDSH Turn Insights',
  }, Wrapped, api, 'turnInsights')
}

export function installPlanCopy(ctx, api, React) {
  if (!React || !React.Component || typeof React.createElement !== 'function') {
    status(api, 'planCopy', 'unsupported', 'The host React capability is unavailable.')
    return noop
  }
  const h = React.createElement
  const Boundary = boundaryOf(React, api, 'planCopy')
  function CopyPlan(props) {
    const [state, setState] = React.useState('idle')
    const timer = React.useRef(null)
    React.useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current) }, [])
    const plan = props && props.review && typeof props.review.plan === 'string' ? props.review.plan : ''
    const resetLater = delay => {
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(() => { timer.current = null; setState('idle') }, delay)
    }
    const copy = async () => {
      if (!plan || state === 'copying') return
      setState('copying')
      try {
        const clipboard = typeof globalThis !== 'undefined' && globalThis.navigator && globalThis.navigator.clipboard
        if (!clipboard || typeof clipboard.writeText !== 'function') throw new Error('Clipboard API unavailable')
        await clipboard.writeText(plan)
        setState('copied')
        resetLater(1600)
      } catch (_) {
        setState('failed')
        resetLater(2200)
      }
    }
    const label = state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : state === 'copying' ? 'Copying…' : 'Copy plan'
    return h('button', { type: 'button', className: 'cdsh-plan-copy', onClick: copy, disabled: !plan || state === 'copying', 'data-state': state }, label)
  }
  const Wrapped = props => h(Boundary, null, h(CopyPlan, props))
  return registerOwnedSlot(ctx, 'conversation.plan-review.actions', {
    name: 'conversation.plan-review.actions', id: PLAN_COPY_ID, order: 90, label: 'Copy plan',
  }, Wrapped, api, 'planCopy')
}

export function installFocusView(ctx, api, React) {
  if (!React || !React.Component || typeof React.createElement !== 'function') {
    status(api, 'focusView', 'unsupported', 'The host React capability is unavailable.')
    return noop
  }
  const h = React.createElement
  const Boundary = boundaryOf(React, api, 'focusView')
  function FocusView(props) {
    const useChat = props && props.useChat
    if (typeof useChat !== 'function') throw new Error('Native useChat selector is unavailable')
    // `navigation` is a stable live projection. Select the changing items array,
    // not the projection object, so the native snapshot hook can trigger renders.
    const items = useChat(value => {
      try { return value.navigation && value.navigation.items ? value.navigation.items() || [] : [] }
      catch (_) { return [] }
    })
    const [query, setQuery] = React.useState('')
    const needle = query.trim().toLowerCase()
    const shown = items.filter(item => {
      if (!needle) return true
      return (preview(item.prompt, 400) + ' ' + preview(item.response, 400)).toLowerCase().includes(needle)
    })
    const open = item => {
      if (props && typeof props.openView === 'function') props.openView('chat', item.anchorKey || String(item.turn))
    }
    return h('section', { className: 'cdsh-focus', 'aria-label': 'CDSH Focus conversation view' },
      h('header', { className: 'cdsh-focus__header' },
        h('div', null, h('strong', null, 'CDSH Focus'), h('p', null, 'A compact searchable map of the native conversation. Chat remains the source of truth.')),
        h('span', { className: 'cdsh-focus__count' }, shown.length + ' / ' + items.length + ' turns')),
      h('div', { className: 'cdsh-focus__toolbar' },
        h('input', { type: 'search', value: query, onChange: event => setQuery(event.target.value), placeholder: 'Search prompts and responses…', 'aria-label': 'Search conversation turns' }),
        h('button', { type: 'button', onClick: () => {
          if (!props || typeof props.openView !== 'function') return
          const last = items[items.length - 1]
          props.openView('chat', last ? last.anchorKey || String(last.turn) : 'cdsh:native-chat')
        } }, 'Native Chat')),
      shown.length === 0
        ? h('div', { className: 'cdsh-focus__empty' }, items.length ? 'No matching turns.' : 'The native Chat projection has no loaded turns yet.')
        : h('ol', { className: 'cdsh-focus__list' }, shown.map(item => h('li', { key: item.anchorKey || item.turn, className: 'cdsh-focus__card' },
            h('button', { type: 'button', onClick: () => open(item), title: 'Open this turn in native Chat' },
              h('span', { className: 'cdsh-focus__turn' }, 'Turn ' + item.turn),
              h('strong', null, preview(item.prompt) || 'Prompt'),
              h('span', null, preview(item.response) || 'No response preview'))))))
  }
  const Wrapped = props => h(Boundary, null, h(FocusView, props))
  return registerOwnedSlot(ctx, 'conversation.view', {
    name: 'conversation.view', id: FOCUS_VIEW_ID, order: 20, label: 'CDSH Focus',
  }, Wrapped, api, 'focusView')
}

export const enhancementCss = String.raw`
.cdsh-turn-insights{display:inline-flex;align-items:center;gap:6px;width:max-content;max-width:100%;padding:3px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:11px/1.5 var(--dsw-font-family)}
.cdsh-turn-insights__mark{color:var(--dsw-alias-brand-primary);font-size:8px}
.cdsh-plan-copy{appearance:none;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:5px 10px;font:12px/1.4 var(--dsw-font-family);cursor:pointer}
.cdsh-plan-copy:hover{border-color:var(--dsw-alias-brand-primary)}
.cdsh-plan-copy:disabled{cursor:default;opacity:.58}
.cdsh-plan-copy[data-state="copied"]{color:var(--dsw-alias-state-success-primary)}
.cdsh-plan-copy[data-state="failed"]{color:var(--dsw-alias-state-error-primary)}
.cdsh-focus{height:100%;min-height:0;overflow:auto;box-sizing:border-box;padding:18px 20px 36px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family)}
.cdsh-focus__header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;max-width:920px;margin:0 auto 14px}
.cdsh-focus__header strong{font-size:17px}.cdsh-focus__header p{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px}
.cdsh-focus__count{flex:none;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:3px 8px;color:var(--dsw-alias-label-secondary);font-size:11px}
.cdsh-focus__toolbar{position:sticky;top:0;z-index:1;display:flex;gap:8px;max-width:920px;margin:0 auto 12px;padding:8px 0;background:var(--dsw-alias-bg-base)}
.cdsh-focus__toolbar input{min-width:0;flex:1;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:8px 10px;font:12px var(--dsw-font-family);outline:none}
.cdsh-focus__toolbar input:focus{border-color:var(--dsw-alias-brand-primary)}
.cdsh-focus__toolbar button,.cdsh-focus__card button{border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);cursor:pointer}
.cdsh-focus__toolbar button{padding:7px 11px}.cdsh-focus__list{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:10px;max-width:920px;margin:0 auto;padding:0;list-style:none}
.cdsh-focus__card button{display:flex;width:100%;height:100%;box-sizing:border-box;flex-direction:column;align-items:flex-start;gap:6px;padding:13px;text-align:left;transition:transform 140ms ease,border-color 140ms ease,background 140ms ease}
.cdsh-focus__card button:hover{transform:translateY(-1px);border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1)}
.cdsh-focus__card strong{font-size:13px;line-height:1.45}.cdsh-focus__card span:last-child{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5}
.cdsh-focus__turn{color:var(--dsw-alias-brand-primary);font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.cdsh-focus__empty{max-width:920px;margin:28px auto;padding:24px;border:1px dashed var(--dsw-alias-border-l1);border-radius:8px;color:var(--dsw-alias-label-secondary);text-align:center;font-size:12px}
@media (max-width:640px){.cdsh-focus{padding:12px}.cdsh-focus__header{display:block}.cdsh-focus__count{display:inline-block;margin-top:8px}.cdsh-focus__toolbar{position:static}}
@media (prefers-reduced-motion:reduce){.cdsh-focus__card button{transition:none}.cdsh-focus__card button:hover{transform:none}}
`
