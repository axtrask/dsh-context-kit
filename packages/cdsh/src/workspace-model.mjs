// Published conversation records only. No log mutation, transport or DOM state.
const historyCache = new WeakMap()
const changesCache = new WeakMap()
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

export function contentText(blocks, kind) {
  if (!Array.isArray(blocks)) return ''
  return blocks.map(block => {
    const type = block.kind || block.type
    if (kind && type !== kind) return ''
    if (typeof block.text === 'string') return block.text
    if (type === 'tool-call') return ''
    return kind ? '' : '[' + String(type || 'content') + ': available in Chat]'
  }).filter(Boolean).join('\n\n')
}

export function elapsedText(start, end) {
  if (finite(start) === null || finite(end) === null) return 'Unavailable'
  const seconds = Math.max(0, end - start) / 1000
  if (seconds < 60) return seconds.toFixed(1) + 's'
  return Math.floor(seconds / 60) + 'm ' + Math.floor(seconds % 60) + 's'
}

function describe(value) {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) || '' } catch { return 'Unserializable event data' }
}

function historyOf(snapshot) {
  const nodes = snapshot.legacy.nodes
  const cached = historyCache.get(nodes)
  if (cached && cached.locations === snapshot.locations) return cached
  const rows = [], answers = [], tools = new Map(), turns = new Set(), callTurns = new Map()
  for (const node of nodes) {
    if (Number.isInteger(node.turn)) turns.add(node.turn)
    if (node.kind === 'assistant') {
      for (const block of node.blocks) if (block.kind === 'tool-call') callTurns.set(block.callId, node.turn)
    }
  }
  const addTool = (call, turn, depth = 0) => {
    const previous = tools.get(call.callId)
    if (previous && previous.depth >= depth) return
    const settled = call.kind === 'tool-result'
    const row = {
      id: 'tool:' + call.callId, type: 'tool', title: settled ? call.call?.name || call.callId : call.name,
      turn: turn ?? call.turn ?? callTurns.get(call.callId) ?? null, step: call.step ?? null,
      seq: call.seq ?? null, start: finite(settled ? call.callTime : call.time), end: settled ? finite(call.time) : null,
      state: settled ? call.isError ? 'error' : 'done' : 'running', depth,
      args: settled ? call.call?.argsRaw || '' : call.argsRaw || '', output: settled ? contentText(call.content) : '',
      source: call,
    }
    tools.set(call.callId, row)
    for (const child of call.subCalls || []) addTool(child, row.turn, depth + 1)
  }
  for (const node of nodes) {
    const turn = node.turn ?? callTurns.get(node.callId) ?? snapshot.locations?.getTurn?.(node.seq) ?? null
    if (Number.isInteger(turn)) turns.add(turn)
    if (node.kind === 'tool-result') { addTool(node, turn); continue }
    if (node.kind === 'assistant') {
      const answer = contentText(node.blocks, 'text'), reasoning = contentText(node.blocks, 'reasoning')
      answers.push({ turn, answer, reasoning, interrupted: node.interrupted === true, seq: node.seq })
      rows.push({ id: 'assistant:' + node.seq, type: 'assistant', title: 'Assistant / step ' + node.step, turn, seq: node.seq,
        start: finite(node.timing?.stepStartTime), end: finite(node.timing?.completedTime ?? node.time),
        state: node.interrupted ? 'stopped' : 'done', output: answer, reasoning, depth: 0 })
      continue
    }
    if (node.kind === 'user' || node.kind === 'steering') continue
    const state = node.kind === 'turn-error' || node.outcome?.kind === 'error' ? 'error' : node.kind === 'command' && !node.outcome ? 'running' : 'recorded'
    rows.push({ id: 'event:' + node.seq + ':' + node.kind, type: 'event', turn, seq: node.seq, depth: 0,
      title: node.type || (node.kind === 'command' ? '/' + (node.name || 'command') : node.kind),
      start: finite(node.time), end: state === 'running' ? null : finite(node.time), state,
      output: node.message || node.outcome?.text || node.summary || contentText(node.content) || describe(node.data ?? node),
      args: node.args || '', source: node })
  }
  const value = { locations: snapshot.locations, rows, answers, tools, turns, addTool }
  historyCache.set(nodes, value)
  return value
}

export function readRun(snapshot, session = {}, selectedTurn) {
  const empty = { rows: [], turns: [], turn: null, answer: '', answerId: null, reasoning: '', streaming: false, phase: null, start: null, end: null, status: 'unavailable', toolCount: 0 }
  if (!snapshot?.legacy || session.removed || ['cold', 'loading', 'error'].includes(session.openState)) return empty
  const history = historyOf(snapshot), legacy = snapshot.legacy
  const turns = new Set(history.turns)
  for (const turn of legacy.turnTimings?.keys() || []) turns.add(turn)
  for (const call of legacy.runningCalls || []) turns.add(call.turn)
  if (legacy.partial) turns.add(legacy.partial.turn)
  const orderedTurns = [...turns].filter(Number.isInteger).sort((a, b) => a - b)
  const latest = orderedTurns.at(-1) ?? null
  const turn = selectedTurn === '*' ? '*' : Number.isInteger(selectedTurn) && orderedTurns.includes(selectedTurn) ? selectedTurn : latest
  const matches = value => turn === '*' || value === turn || value === null
  // Settled nodes are cached by the native immutable history array. Stream ticks
  // only add the small in-flight tail; no transcript serialization per token.
  const rows = history.rows.filter(row => matches(row.turn))
  const tools = new Map(history.tools)
  const append = (call, parentTurn, depth = 0) => {
    const callTurn = call.turn ?? parentTurn
    if (call.kind === 'tool-result') {
      if (!tools.has(call.callId)) tools.set(call.callId, { id: 'tool:' + call.callId, type: 'tool', title: call.call?.name || call.callId,
        turn: callTurn, seq: call.seq, start: finite(call.callTime), end: finite(call.time), state: call.isError ? 'error' : 'done',
        depth, args: call.call?.argsRaw || '', output: contentText(call.content), source: call })
    } else if (!tools.has(call.callId)) {
      tools.set(call.callId, { id: 'tool:' + call.callId, type: 'tool', title: call.name, turn: callTurn, seq: null,
        start: finite(call.time), end: null, state: session.running && callTurn === latest ? 'running' : 'unsettled',
        depth, args: call.argsRaw || '', output: '', source: call })
    }
    for (const child of call.subCalls || []) append(child, callTurn, depth + 1)
  }
  for (const call of legacy.runningCalls || []) append(call, call.turn)
  rows.push(...[...tools.values()].filter(row => matches(row.turn)).map(row =>
    row.state === 'running' && !(session.running && row.turn === latest) ? { ...row, state: 'unsettled' } : row))
  const finals = history.answers.filter(answer => turn === '*' || answer.turn === turn)
  const partial = legacy.partial && (turn === '*' || legacy.partial.turn === turn) ? legacy.partial : null
  const final = finals.at(-1)
  if (partial) rows.push({ id: 'partial:' + partial.turn + ':' + partial.step, type: 'assistant', title: 'Assistant / step ' + partial.step,
    turn: partial.turn, seq: null, start: null, end: null, state: session.running && partial.turn === latest ? 'running' : 'unsettled', depth: 0,
    output: contentText(partial.blocks, 'text'), reasoning: contentText(partial.blocks, 'reasoning') })
  rows.sort((a, b) => (a.start ?? a.end ?? Infinity) - (b.start ?? b.end ?? Infinity) || (a.seq ?? Infinity) - (b.seq ?? Infinity))
  const timing = legacy.turnTimings?.get(turn === '*' ? latest : turn)
  const live = !!session.running && (turn === '*' || turn === latest)
  const error = rows.some(row => row.source?.kind === 'turn-error')
  const status = live ? 'running' : error ? 'error' : final?.interrupted ? 'stopped' : timing?.endTime !== undefined ? 'ended' : rows.length ? 'recorded' : 'idle'
  const answer = partial ? contentText(partial.blocks, 'text') : final?.answer || ''
  const reasoning = partial ? contentText(partial.blocks, 'reasoning') : final?.reasoning || ''
  const streaming = !!partial && partial.turn === latest && live
  const phase = !live ? null : streaming && answer ? 'answer' : streaming && reasoning ? 'reasoning' : rows.some(row => row.type === 'tool' && row.state === 'running') ? 'tool' : 'waiting'
  return { rows, turns: orderedTurns, turn, status, start: finite(timing?.startTime), end: finite(timing?.endTime),
    answer, reasoning, answerId: partial ? 'partial:' + partial.turn + ':' + partial.step : final ? 'assistant:' + final.seq : null,
    streaming, phase,
    toolCount: rows.filter(row => row.type === 'tool').length }
}

export function readChanges(rows) {
  const changes = []
  for (const row of rows) {
    if (row.type !== 'tool' || row.state !== 'done') continue
    const name = row.title.toLowerCase()
    if (!['edit', 'write', 'apply_patch'].includes(name)) continue
    const cached = changesCache.get(row)
    if (cached) { changes.push(...cached); continue }
    const from = changes.length
    let args
    try { args = JSON.parse(row.args) } catch { continue }
    if (!args || typeof args !== 'object') continue
    const path = args.file_path ?? args.path ?? args.filePath
    if (typeof path === 'string' && path && name !== 'apply_patch') {
      changes.push({ id: row.id, path, kind: name, start: row.start, end: row.end,
        before: typeof args.old_string === 'string' ? args.old_string : null,
        after: typeof args.new_string === 'string' ? args.new_string : typeof args.content === 'string' ? args.content : null,
        patch: null, row })
    }
    const patch = args.patchText ?? args.patch ?? args.input
    if (name === 'apply_patch' && typeof patch === 'string') {
      const parts = [...patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)]
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]
        changes.push({ id: row.id + ':' + i, path: part[2].trim(), kind: part[1].toLowerCase(), before: null, after: null,
          patch: patch.slice(part.index, parts[i + 1]?.index ?? patch.length), row, start: row.start, end: row.end })
      }
    }
    // Settled rows are immutable; clock/text ticks must not parse whole patches again.
    changesCache.set(row, changes.slice(from))
  }
  return changes
}

export function changePreview(text, page = 0) {
  if (typeof text !== 'string') return { unavailable: true }
  if (text.includes('\0')) return { binary: true }
  const pages = Math.max(1, Math.ceil(text.length / 24000))
  const current = Math.min(pages - 1, Math.max(0, Math.trunc(page) || 0))
  let start = current * 24000, end = Math.min(text.length, start + 24000)
  // Keep a surrogate pair together at page boundaries without dropping text.
  if (start && /[\uDC00-\uDFFF]/.test(text[start])) start--
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end--
  return { text: text.slice(start, end), start, end, total: text.length, page: current, pages }
}

export function contextNumbers(pressure, breakdown) {
  const reported = finite(pressure?.pressureTokens), projected = finite(pressure?.projectedTokens)
  const used = projected ?? reported, capacity = finite(pressure?.contextWindow)
  return { reported, projected, used, capacity, percent: used !== null && capacity > 0 ? used / capacity * 100 : null,
    composition: { system: finite(breakdown?.systemTokens), tools: finite(breakdown?.toolsTokens), messages: finite(breakdown?.messageTokens) } }
}

export function fileAddress(sessionId, cwd, file) {
  let path = file.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
  const root = (cwd || '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (root && path.startsWith(root + '/')) path = path.slice(root.length + 1)
  const encode = value => encodeURIComponent(value).replace(/%3A/gi, ':')
  return 'dsh-resource://file/session/' + encode(sessionId) + '/' + path.split('/').map(encode).join('/')
}
