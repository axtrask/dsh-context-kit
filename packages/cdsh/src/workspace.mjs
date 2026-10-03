import { readRun, readChanges, changePreview, contextNumbers, elapsedText, fileAddress } from './workspace-model.mjs'

export const WORKSPACE_KIND = 'studio-workspace'
export const WORKSPACE_ID = 'dsh-regional-palette/workspace'
export const BRAND_ID = 'cdsh/brand'

const noop = () => {}
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
function report(api, feature, status, detail) {
  try { if (api && typeof api.reportFeatureStatus === 'function') api.reportFeatureStatus(feature, status, detail) } catch (_) {}
}
function boundaryOf(React, api, feature) {
  return class CDSHWorkspaceBoundary extends React.Component {
    constructor(props) { super(props); this.state = { failed: false } }
    static getDerivedStateFromError() { return { failed: true } }
    componentDidCatch(error) {
      report(api, feature, 'failed', String(error && (error.message || error) || 'Render failed'))
      try { console.warn('[cdsh] ' + feature + ' render failed', error) } catch (_) {}
    }
    render() { return this.state.failed ? null : this.props.children }
  }
}

export function installBrand(ctx, api, React) {
  const slots = ctx && (ctx.slots || (typeof ctx.get === 'function' && ctx.get('slots')))
  if (!React || !React.Component || typeof React.createElement !== 'function' || !slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
    report(api, 'brand', 'unsupported', 'The required React or Slots capability is unavailable.')
    return noop
  }
  const h = React.createElement
  function BrandName() {
    return h('span', {
      'data-cdsh-brand': '',
      style: {
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'var(--dsw-font-family)',
        fontSize: 15,
        fontWeight: 700,
        letterSpacing: '.04em',
        lineHeight: '24px',
        whiteSpace: 'nowrap',
      },
    }, 'CDSH')
  }
  const Boundary = boundaryOf(React, api, 'brand')
  const SafeBrandName = () => h(Boundary, null, h(BrandName))
  try {
    const dispose = slots.inject('sidebar.brand.name', () => {
      try {
        const registered = disposeOf(slots.register({ name: 'sidebar.brand.name', id: BRAND_ID, priority: -10 }, SafeBrandName))
        report(api, 'brand', 'active', 'Compatible with this DSH build.')
        return disposeOf(() => {
          registered()
          report(api, 'brand', 'waiting', 'Waiting for the DSH brand slot owner to return.')
        })
      } catch (error) {
        report(api, 'brand', 'failed', 'Brand registration failed: ' + String(error && (error.message || error) || error))
        console.warn('[cdsh] brand registration failed', error)
        return noop
      }
    })
    return disposeOf(dispose)
  } catch (error) {
    report(api, 'brand', 'failed', 'Brand injection failed: ' + String(error && (error.message || error) || error))
    console.warn('[cdsh] brand injection failed', error)
    return noop
  }
}

export function installWorkspace(ctx, api, React) {
  const required = ctx && ctx.slots && ctx.sessions && ctx.uiConversation && ctx.sidebarRight && ctx.sidebarRightTabs
  if (!React || !React.Component || typeof React.createElement !== 'function' || !required || typeof ctx.effect !== 'function') {
    report(api, 'workspace', 'unsupported', 'Required workspace services are unavailable.')
    return noop
  }
  const h = React.createElement
  const time = value => value === null ? 'Unavailable' : new Date(value).toLocaleTimeString([], { hour12: false })
  const number = value => value === null ? 'Unavailable' : Math.round(value).toLocaleString()
  const button = (label, onClick, props = {}) => h('button', { type: 'button', onClick, ...props }, label)
  const phases = { waiting: 'Waiting for the model', reasoning: 'Receiving reasoning', tool: 'Running tools', answer: 'Streaming answer' }
  const icon = h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true },
    h('path', { d: 'M4 5h16M4 12h10M4 19h7M17 15l4 4-4 4' }))

  function useFace(face) {
    const ref = React.useRef()
    if (!ref.current || ref.current.face !== face) ref.current = { face, read: () => face?.getSnapshot(), subscribe: listener => face?.subscribe(listener) || noop }
    return React.useSyncExternalStore(ref.current.subscribe, ref.current.read, ref.current.read)
  }

  function useClock(enabled) {
    const [now, setNow] = React.useState(Date.now)
    React.useEffect(() => {
      if (!enabled) return
      let timer
      const visibility = () => {
        clearInterval(timer)
        if (!document.hidden) {
          setNow(Date.now())
          timer = setInterval(() => setNow(Date.now()), 500)
        }
      }
      visibility()
      document.addEventListener('visibilitychange', visibility)
      return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visibility) }
    }, [enabled])
    return now
  }

  function Text({ text = '', streaming = false, prose = false }) {
    const [expanded, setExpanded] = React.useState(false)
    const shown = expanded ? text : text.slice(-24000)
    const tail = streaming ? Math.min(shown.length, 48) : 0
    return h(React.Fragment, null,
      text.length > shown.length && button('Show full text (' + number(text.length) + ' characters)', () => setExpanded(true), { className: 'studio-text-more' }),
      h('div', { className: prose ? 'studio-text studio-prose' : 'studio-text', 'data-streaming': streaming || undefined }, shown.slice(0, shown.length - tail),
        tail > 0 && h('span', { className: 'studio-stream-tail', key: text.length }, shown.slice(-tail))))
  }

  function ChangeText({ text }) {
    const [page, setPage] = React.useState(0)
    const preview = changePreview(text, page)
    if (preview.binary || preview.unavailable) return h('p', { className: 'studio-workspace-note', role: 'status' }, preview.binary
      ? 'Binary or non-text content. Text preview is unavailable; use the native file viewer.'
      : 'Recorded content is unavailable or unsupported. The operation is not a complete file diff; use the native file viewer.')
    return h('div', { className: 'studio-change-preview' },
      preview.pages > 1 && h('nav', { className: 'studio-change-actions', 'aria-label': 'Recorded content pages' },
        button('Previous page', () => setPage(preview.page - 1), { disabled: preview.page === 0 }),
        h('span', { role: 'status' }, 'Page ' + (preview.page + 1) + ' / ' + preview.pages + ' | Characters ' + (preview.start + 1) + '-' + preview.end + ' of ' + preview.total),
        button('Next page', () => setPage(preview.page + 1), { disabled: preview.page === preview.pages - 1 })),
      h('pre', { className: 'studio-patch', tabIndex: 0, 'aria-label': 'Recorded content preview' }, preview.text || '(empty recorded content)'))
  }

  const Row = React.memo(function Row({ row, selected, choose, now }) {
    const mark = row.type === 'assistant' ? 'M9 18h6m-5 3h4M8 14a6 6 0 1 1 8 0c-1 1-1 2-1 3H9c0-1 0-2-1-3' : /bash|pwsh|shell/.test(row.title) ? 'm4 6 5 5-5 5m8 0h8' : /edit|write|patch/.test(row.title) ? 'm5 19 4-1L20 7l-4-4L5 14v5m8-13 4 4' : 'M7 3h7l4 4v14H7zM13 3v5h5M10 12h5m-5 4h5'
    return h('li', { className: 'studio-run-row', 'data-state': row.state, 'data-kind': row.type, 'data-run-key': row.id, style: { '--studio-depth': Math.min(row.depth || 0, 6) } },
      button(h(React.Fragment, null,
        h('span', { className: 'studio-step-dot', 'aria-hidden': true }, h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 }, h('path', { d: mark }))),
        h('span', { className: 'studio-step-main' }, h('span', { className: 'studio-step-title' }, row.title),
          h('span', { className: 'studio-step-meta' },
            h('time', { dateTime: row.start === null ? undefined : new Date(row.start).toISOString() }, time(row.start)),
            h('span', null, elapsedText(row.start, row.end ?? (row.state === 'running' ? now : null))),
             h('span', { className: 'studio-step-state' }, row.state)))), () => choose(row.id), { 'aria-pressed': selected, title: row.title + ' | Started: ' + time(row.start) + ' | ' + row.state }))
  })

  let closed = false
  const watchEnabled = (scope, label, mount) => scope.effect(() => {
    let drop = null
    const sync = () => {
      if (closed || api.getState()?.enabled === false) {
        if (drop) drop()
        drop = null
        return
      }
      if (!drop) drop = mount()
    }
    sync()
    const unsubscribe = api.subscribe(sync)
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe()
      if (drop) drop()
      drop = null
    }
  }, label)

  const effects = []

  // These services are supplied by the feature-scoped Cordis injection in runtime.mjs.
  // Using the activated root context avoids leaving the workspace behind a second pending child Fiber.
  const scope = ctx
  let coreActive = false
  let launcherActive = false
  const reportWorkspaceState = () => {
    if (!coreActive) {
      report(api, 'workspace', 'waiting', 'Waiting for the DSH workspace slot owner to return.')
    } else if (!launcherActive) {
      report(api, 'workspace', 'active', 'Workspace core is active; the header launcher is waiting for its slot owner.')
    } else {
      report(api, 'workspace', 'active', 'Compatible with this DSH build.')
    }
  }
  const openWorkspace = params => {
      scope.sidebarRight.openTab(WORKSPACE_KIND, { params })
    }
    function Launcher() {
      return button(h(React.Fragment, null, icon, h('span', null, 'Run')), () => {
        openWorkspace()
      }, { className: 'studio-launch-run', title: 'Open execution, changes and context', 'aria-label': 'Open Run workspace' })
    }

    function Workspace({ sessionId, useTabInfo }) {
      const info = useTabInfo()
      const session = scope.sessions.binding(sessionId).session
      const sessionState = useFace(session)
      const chatFace = scope.uiConversation.binding(sessionId).target('chat')
      const chat = useFace(chatFace)
      const pressure = useFace(session.projections.faceOf('contextPressure'))
      const breakdown = useFace(session.projections.faceOf('contextBreakdown'))
      const list = useFace(scope.sessions.list)
      const params = info.tab.navigation.params
      const [view, setView] = React.useState('run')
      const [turn, setTurn] = React.useState(null)
      const [selected, choose] = React.useState(null)
      const [selectedChange, selectChange] = React.useState(null)
      const [query, setQuery] = React.useState('')
      const [error, setError] = React.useState('')
      const [stopping, setStopping] = React.useState(false)
      const [follow, setFollow] = React.useState(true)
      const outputRef = React.useRef(null), answerRef = React.useRef(null), owner = React.useRef(null)
      React.useEffect(() => {
        const current = { sessionId, alive: true }
        owner.current = current
        return () => { current.alive = false }
      }, [sessionId])
      React.useEffect(() => {
        setView(['run', 'changes', 'context'].includes(params?.view) ? params.view : 'run')
        setTurn(Number.isInteger(params?.turn) ? params.turn : null)
        choose(null); selectChange(null); setError(''); setQuery(''); setFollow(true)
      }, [sessionId, info.tab.navigation.revision])
      const run = readRun(chat, sessionState, turn)
      const all = turn === '*' ? run : readRun(chat, sessionState, '*')
      const changes = readChanges(all.rows)
      const change = changes.find(item => item.id === selectedChange) || changes.at(-1)
      const context = contextNumbers(pressure, breakdown)
      const now = useClock(run.status === 'running' && info.tab.visible && view === 'run')
      const rows = run.rows.filter(row => !query || (row.title + ' ' + (row.args || '') + ' ' + row.output).toLowerCase().includes(query.toLowerCase()))
      const active = rows.find(row => row.id === selected) || rows.findLast(row => row.state === 'running') || rows.at(-1)
      const separateAnswer = Boolean(run.answer) && active?.id !== run.answerId
      const current = list?.current === sessionId && !sessionState?.removed && !info.tab.signal.aborted
      React.useLayoutEffect(() => {
        if (!follow || !info.tab.visible) return
        for (const element of [outputRef.current, answerRef.current]) if (element) element.scrollTop = element.scrollHeight
      }, [active?.output, active?.reasoning, run.answer, follow, info.tab.visible])
      const trackScroll = event => {
        const el = event.currentTarget
        setFollow(el.scrollHeight - el.clientHeight - el.scrollTop < 48)
      }
      const stop = async () => {
        if (!current || stopping || !sessionState?.running) return
        const token = owner.current
        setStopping(true); setError('')
        try {
          const result = await session.cancel()
          if (!result.ok) throw new Error(result.error?.message || 'Stop was refused')
        } catch (e) { if (token.alive && owner.current === token) setError(String(e.message || e)) }
        finally { if (token.alive && owner.current === token) setStopping(false) }
      }
      const older = async () => {
        if (!current || sessionState?.loadingOlder) return
        const token = owner.current
        try { await session.loadOlder() } catch (e) { if (token.alive && owner.current === token) setError(String(e.message || e)) }
      }
      const selectView = value => { setView(value); setError('') }
      const tabs = h('nav', { className: 'studio-workspace-tabs', 'aria-label': 'Run workspace views', role: 'tablist', onKeyDown: event => {
        const values = ['run', 'changes', 'context'], index = values.indexOf(view)
        const next = event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : -1
        if (next < 0) return
        event.preventDefault(); selectView(values[next]); event.currentTarget.querySelectorAll('[role="tab"]')[next].focus()
      } }, ...['run', 'changes', 'context'].map(value => button(value[0].toUpperCase() + value.slice(1) + (value === 'changes' && changes.length ? ' ' + changes.length : ''), () => selectView(value),
        { key: value, role: 'tab', 'aria-selected': view === value, tabIndex: view === value ? 0 : -1 })))
      const summary = h('div', { className: 'studio-run-summary' },
        h('span', { className: 'studio-run-status', 'data-state': run.status, 'data-phase': run.phase || undefined, role: 'status' }, h('i', { 'aria-hidden': true }), phases[run.phase] || run.status),
        h('span', { className: 'studio-run-clock' }, 'Started ', h('time', null, time(run.start))),
        h('span', { className: 'studio-run-clock' }, run.status === 'running' ? 'Elapsed ' : 'Duration ', h('span', null, elapsedText(run.start, run.end ?? (run.status === 'running' ? now : null)))),
        sessionState?.running && button(stopping ? 'Stopping...' : 'Stop', stop, { disabled: !current || stopping, className: 'studio-stop' }))
      const toolbar = h('div', { className: 'studio-run-toolbar' },
        h('select', { 'aria-label': 'Execution turn', value: turn ?? '', onChange: e => { setTurn(e.target.value === '*' ? '*' : e.target.value === '' ? null : Number(e.target.value)); choose(null); setFollow(true) } },
          h('option', { value: '' }, 'Latest turn'), ...run.turns.slice().reverse().map(value => h('option', { key: value, value }, 'Turn ' + value)), h('option', { value: '*' }, 'All loaded history')),
        h('input', { type: 'search', placeholder: 'Find a step...', 'aria-label': 'Find execution step', value: query, onChange: e => setQuery(e.target.value) }),
        sessionState?.hasMore && button(sessionState.loadingOlder ? 'Loading...' : 'Older', older, { disabled: !current || sessionState.loadingOlder, title: 'Load older session history' }))
      const empty = text => h('div', { className: 'studio-workspace-empty' }, text)
      const runView = h('section', { className: 'studio-run-page', hidden: view !== 'run', role: 'tabpanel', 'aria-label': 'Run' }, summary, toolbar,
        h('div', { className: 'studio-run-grid' },
          h('section', { className: 'studio-run-timeline', 'aria-label': 'Execution steps' },
            rows.length ? h('ol', null, ...rows.flatMap((row, index) => [
              (index === 0 || rows[index - 1].turn !== row.turn) && h('li', { className: 'studio-run-group', key: row.id + ':turn' }, Number.isInteger(row.turn) ? 'Turn ' + row.turn : 'Recorded events'),
              h(Row, { key: row.id, row, selected: active?.id === row.id, choose, now: row.state === 'running' ? now : 0 }),
            ])) : empty(run.status === 'unavailable' ? 'Waiting for the native conversation projection. Chat remains available.' : query ? 'No matching steps.' : 'No execution recorded in this history window.')),
          h('section', { className: 'studio-run-monitor', 'data-split-output': separateAnswer || undefined, 'aria-label': 'Live execution output' },
            h('div', { className: 'studio-monitor-heading' }, h('strong', null, active?.title || 'Output'), h('span', { 'data-state': active?.state }, active?.state || 'idle'),
              !follow && button('Latest', () => setFollow(true), { title: 'Resume following output and answer' })),
             h('div', { className: 'studio-output-scroll', ref: outputRef, onScroll: trackScroll, tabIndex: 0, 'aria-label': 'Selected step output' },
               active && h('dl', { className: 'studio-selected-meta' }, h('dt', null, 'Step'), h('dd', null, active.title), h('dt', null, 'Started'), h('dd', null, h('time', { dateTime: active.start === null ? undefined : new Date(active.start).toISOString() }, time(active.start))), h('dt', null, 'State'), h('dd', null, active.state)),
              active?.args && h('details', { className: 'studio-step-input' }, h('summary', null, 'Input'), h('pre', null, active.args)),
               active?.reasoning && h('details', { className: 'studio-step-input', open: active.state === 'running' && !active.output || undefined }, h('summary', null, 'Reasoning'), h(Text, { key: active.id + ':reasoning', text: active.reasoning, prose: true, streaming: active.state === 'running' && !active.output })),
               active?.output ? h(Text, { key: active.id, text: active.output, prose: active.type === 'assistant', streaming: active.state === 'running' && active.type === 'assistant' }) : !active?.reasoning && empty(active?.state === 'running' ? active.type === 'assistant' ? 'Waiting for assistant content from DSH.' : 'Running. This tool has not published output; its result will appear when DSH provides it.' : run.phase ? phases[run.phase] + '. Content appears as DSH publishes it.' : 'No text output. Rich content and interactive tools remain in Chat.')),
            separateAnswer && h(React.Fragment, null, h('div', { className: 'studio-answer-heading' }, 'Latest answer', h('span', null, run.streaming ? 'Streaming' : 'Recorded')),
            h('div', { className: 'studio-answer-scroll', ref: answerRef, onScroll: trackScroll, tabIndex: 0, 'aria-label': 'Assistant answer' },
               h(Text, { key: run.answerId, text: run.answer, prose: true, streaming: run.streaming }))))),
        h('p', { className: 'studio-workspace-note' }, run.toolCount + ' tool calls in the selected window. Approvals, questions, rich messages and editing remain in Chat. No simulated progress.'))
      const changesView = h('section', { className: 'studio-changes-page', hidden: view !== 'changes', role: 'tabpanel', 'aria-label': 'Changes' },
        h('p', { className: 'studio-workspace-note' }, 'Successful edit/write/patch calls in loaded history. These are recorded operations, not a complete Git diff; shell and external changes may be missing.'),
        changes.length > 0 && h('div', { className: 'studio-changes-browser', 'aria-label': 'Recorded file operations' }, ...changes.map(item => button(h(React.Fragment, null, h('span', null, item.path), h('small', null, item.kind)), () => selectChange(item.id), { key: item.id, 'aria-pressed': item === change, title: item.path }))),
        change ? h('details', { className: 'studio-change', key: change.id, open: true },
          h('summary', null, h('span', null, change.path), h('small', null, change.kind)),
          h('div', { className: 'studio-change-actions' }, h('time', null, time(change.end)), button('Open file', () => info.tab.actions.openResource(fileAddress(sessionId, list?.byId?.[sessionId]?.cwd, change.path)), { disabled: !current, title: 'Open current file in the native viewer' })),
          change.patch !== null && h(ChangeText, { text: change.patch }),
          change.before !== null && h('div', { className: 'studio-change-before' }, h('small', null, 'Recorded replacement target'), h(ChangeText, { text: change.before })),
          change.after !== null && h('div', { className: 'studio-change-after' }, h('small', null, change.kind === 'write' ? 'Recorded written content' : 'Recorded replacement'), h(ChangeText, { text: change.after })),
          change.patch === null && change.before === null && change.after === null && h(ChangeText, { text: null })) : empty('No supported successful file operation in the loaded history. This does not mean the workspace is unchanged.'))
      const contextView = h('section', { className: 'studio-context-page', hidden: view !== 'context', role: 'tabpanel', 'aria-label': 'Context' },
        h('div', { className: 'studio-context-primary' }, h('span', null, context.projected !== null ? 'Next request / estimated' : 'Last reported prompt'),
          h('strong', null, number(context.used)), h('small', null, context.capacity > 0 ? 'of ' + number(context.capacity) + ' tokens' : 'Context capacity unavailable')),
        context.percent !== null && h('div', { className: 'studio-context-ring studio-context-meter', style: { '--studio-occupancy': Math.min(100, context.percent) + '%' }, role: 'meter', 'aria-label': 'Context occupancy', 'aria-valuemin': 0, 'aria-valuemax': context.capacity, 'aria-valuenow': Math.min(context.used, context.capacity), 'aria-valuetext': context.percent.toFixed(1) + '% of context capacity' },
          h('span', { 'data-overflow': context.percent > 100 || undefined }, context.percent.toFixed(1) + '%')),
        h('dl', { className: 'studio-context-values' }, h('dt', null, 'Provider-reported prompt'), h('dd', null, number(context.reported)), h('dt', null, 'Projected next prompt'), h('dd', null, number(context.projected)),
          h('dt', null, 'Capacity'), h('dd', null, number(context.capacity))),
        h('h3', null, 'Estimated composition'),
        h('dl', { className: 'studio-context-values' }, ...Object.entries(context.composition).flatMap(([key, value]) => [h('dt', { key: key + ':name' }, key), h('dd', { key }, number(value))])))
      return h('div', { className: 'studio-workspace', 'data-studio-workspace': '', 'data-session-id': sessionId, 'data-fullscreen': info.sidebar.fullscreen || undefined }, tabs,
        error && h('div', { className: 'studio-workspace-error', role: 'alert' }, error),
        sessionState?.openState === 'error' && h('div', { className: 'studio-workspace-error', role: 'alert' }, 'Conversation could not be loaded. Use the native conversation to retry.'),
        runView, changesView, contextView)
    }

  const Boundary = boundaryOf(React, api, 'workspace')
  const SafeLauncher = props => h(Boundary, null, h(Launcher, props))
  const SafeWorkspace = props => h(Boundary, null, h(Workspace, props))

  const disposeAll = disposers => {
    for (const dispose of disposers.splice(0).reverse()) {
      try { if (typeof dispose === 'function') dispose() }
      catch (_) {}
    }
  }

  // The right-tab definition and pane body are one atomic feature. A launcher
  // failure must not remove an otherwise usable workspace.
  effects.push(watchEnabled(scope, 'studio: workspace core', () => {
    try {
      const injected = scope.slots.inject('sidebar.right.pane.tab', () => {
        const disposers = []
        try {
          disposers.push(disposeOf(scope.sidebarRightTabs.register({ id: WORKSPACE_ID, kind: WORKSPACE_KIND, title: () => 'Run', guide: [{ id: 'run', order: 20, title: () => 'Run workspace', description: () => 'Execution, recorded changes and native context usage.' }] })))
          disposers.push(disposeOf(scope.slots.register({ name: 'sidebar.right.pane.tab', key: WORKSPACE_ID }, SafeWorkspace)))
          coreActive = true
          reportWorkspaceState()
          return disposeOf(() => {
            disposeAll(disposers)
            coreActive = false
            reportWorkspaceState()
          })
        } catch (error) {
          disposeAll(disposers)
          report(api, 'workspace', 'failed', 'Workspace registration failed: ' + String(error && (error.message || error) || error))
          throw error
        }
      })
      return disposeOf(injected)
    } catch (error) {
      report(api, 'workspace', 'failed', 'Workspace injection failed: ' + String(error && (error.message || error) || error))
      throw error
    }
  }))

  effects.push(watchEnabled(scope, 'studio: workspace launcher', () => {
    try {
      const dispose = scope.slots.inject('conversation.session.header.utilities', () => {
        try {
          const registered = disposeOf(scope.slots.register({ name: 'conversation.session.header.utilities', id: WORKSPACE_ID }, SafeLauncher))
          launcherActive = true
          reportWorkspaceState()
          return disposeOf(() => {
            registered()
            launcherActive = false
            reportWorkspaceState()
          })
        } catch (error) {
          launcherActive = false
          reportWorkspaceState()
          console.warn('[cdsh] workspace launcher registration failed', error)
          return noop
        }
      })
      return disposeOf(dispose)
    } catch (error) {
      launcherActive = false
      reportWorkspaceState()
      console.warn('[cdsh] workspace launcher injection failed', error)
      return noop
    }
  }))
  return () => {
    if (closed) return
    closed = true
    for (const effect of effects.splice(0).reverse()) {
      if (typeof effect === 'function') effect()
      else if (effect && typeof effect.dispose === 'function') effect.dispose()
    }
  }
}
