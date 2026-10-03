import test from 'node:test'
import assert from 'node:assert/strict'
import { readRun, readChanges, changePreview, contextNumbers, contentText, elapsedText, fileAddress } from '../src/workspace-model.mjs'

test('recorded changes page large text without losing Unicode or exposing binary content', () => {
  const text = 'x'.repeat(23999) + '\uD83D\uDE00' + 'y'.repeat(48003)
  const pages = Array.from({ length: changePreview(text).pages }, (_, page) => changePreview(text, page))
  assert.equal(pages.map(page => page.text).join(''), text)
  assert.ok(pages.every(page => page.text.length <= 24001))
  assert.equal(changePreview(text, -1).page, 0)
  assert.equal(changePreview(text, Infinity).page, pages.length - 1)
  assert.deepEqual(changePreview('binary\0data'), { binary: true })
  assert.deepEqual(changePreview(null), { unavailable: true })
  assert.deepEqual(changePreview({ bytes: [1, 2] }), { unavailable: true })
  assert.equal(changePreview('').text, '')
})

function snapshot(nodes = [], extra = {}) {
  return { legacy: { nodes, runningCalls: [], partial: null, turnTimings: new Map([[1, { startTime: 1000, endTime: 5000 }]]), turnEnds: new Map([[1, 20]]), ...extra }, locations: { getTurn: () => 1 } }
}
const call = { kind: 'tool-result', seq: 12, time: 3000, callId: 'call-1', call: { name: 'edit', argsRaw: JSON.stringify({ file_path: 'src/a.ts', old_string: 'before', new_string: 'after' }) }, callTime: 2000, content: [{ type: 'text', text: 'Applied' }], isError: false, subCalls: [] }
const assistant = { kind: 'assistant', seq: 14, time: 4000, turn: 1, step: 1, blocks: [{ kind: 'reasoning', text: 'Check first.' }, { kind: 'text', text: 'Changed.' }], timing: { stepStartTime: 1000, firstTokenTime: 1500, completedTime: 4000 } }

test('reads published assistant kinds and raw content types without executing HTML', () => {
  assert.equal(contentText([{ type: 'text', text: '<img onerror=alert(1)>' }]), '<img onerror=alert(1)>')
  assert.equal(contentText(assistant.blocks, 'text'), 'Changed.')
  assert.equal(contentText(assistant.blocks, 'reasoning'), 'Check first.')
  assert.match(contentText([{ type: 'image', source: {} }]), /image/i)
})
test('settled calls have real start, duration and output', () => {
  const run = readRun(snapshot([call, assistant]), { running: false })
  const row = run.rows.find(row => row.id === 'tool:call-1')
  assert.equal(row.start, 2000)
  assert.equal(row.end, 3000)
  assert.equal(row.output, 'Applied')
  assert.equal(run.status, 'ended')
  assert.equal(run.answer, 'Changed.')
})
test('window-truncated call heads remain unknown, not zero-duration successes', () => {
  const row = readRun(snapshot([{ ...call, call: null, callTime: null }]), {}).rows[0]
  assert.equal(row.start, null)
  assert.match(row.title, /call-1/)
  assert.equal(elapsedText(row.start, row.end), 'Unavailable')
})
test('running tools do not invent stdout or completion', () => {
  const run = readRun(snapshot([], { runningCalls: [{ callId: 'live', name: 'bash', argsRaw: '{}', turn: 1, step: 2, time: 2000, subCalls: [] }], turnTimings: new Map([[1, { startTime: 1000 }]]) }), { running: true })
  assert.equal(run.status, 'running')
  assert.equal(run.rows[0].state, 'running')
  assert.equal(run.rows[0].output, '')
  assert.equal(run.rows[0].end, null)
})
test('unsettled calls are not presented as running after a stopped session', () => {
  const run = readRun(snapshot([], { runningCalls: [{ callId: 'live', name: 'bash', time: 2000, turn: 1, subCalls: [] }] }), { running: false })
  assert.equal(run.rows[0].state, 'unsettled')
})
test('tool errors and interrupted answers retain distinct states', () => {
  const run = readRun(snapshot([{ ...call, isError: true }, { ...assistant, interrupted: true }]), {})
  assert.equal(run.rows.find(row => row.type === 'tool').state, 'error')
  assert.equal(run.status, 'stopped')
})
test('partial answer is authoritative and separate from reasoning', () => {
  const run = readRun(snapshot([assistant], { partial: { turn: 1, step: 2, blocks: [{ kind: 'text', text: 'Now streaming' }, { kind: 'reasoning', text: 'Private lane' }] } }), { running: true })
  assert.equal(run.answer, 'Now streaming')
  assert.equal(run.reasoning, 'Private lane')
  assert.equal(run.streaming, true)
  assert.equal(run.phase, 'answer')
  assert.equal(run.answerId, 'partial:1:2')
  assert.equal(run.rows.find(row => row.id === run.answerId).output, run.answer)
})
test('waiting, reasoning, tool execution and ended answers have distinct truthful phases', () => {
  const waiting = readRun(snapshot([assistant]), { running: true })
  assert.equal(waiting.phase, 'waiting')
  assert.equal(waiting.streaming, false)
  assert.equal(waiting.answerId, 'assistant:14')
  const reasoning = readRun(snapshot([], { partial: { turn: 1, step: 2, blocks: [{ kind: 'reasoning', text: 'Checking.' }] } }), { running: true })
  assert.equal(reasoning.phase, 'reasoning')
  assert.equal(reasoning.answer, '')
  assert.equal(reasoning.reasoning, 'Checking.')
  const tool = readRun(snapshot([], { runningCalls: [{ callId: 'active', name: 'bash', turn: 1, time: 2000 }] }), { running: true })
  assert.equal(tool.phase, 'tool')
  assert.equal(tool.answer, '')
  assert.equal(readRun(snapshot([assistant]), { running: false }).phase, null)
  assert.equal(readRun(undefined, { running: true }).phase, null)
})
test('an old partial cannot masquerade as the current stream when a new turn starts', () => {
  const s = snapshot([assistant], { partial: { turn: 1, step: 2, blocks: [{ kind: 'text', text: 'Old partial' }] }, turnTimings: new Map([[1, { startTime: 1000, endTime: 5000 }], [2, { startTime: 6000 }]]) })
  const all = readRun(s, { running: true }, '*')
  assert.equal(all.phase, 'waiting')
  assert.equal(all.streaming, false)
  assert.equal(all.rows.find(row => row.id === 'partial:1:2').state, 'unsettled')
  assert.equal(readRun(s, { running: true }, 1).phase, null)
})
test('recursive calls retain depth and are not duplicated', () => {
  const child = { ...call, callId: 'child', parentCallId: 'root' }
  const root = { ...call, callId: 'root', subCalls: [child] }
  const rows = readRun(snapshot([root, child]), {}).rows.filter(row => row.type === 'tool')
  assert.equal(rows.length, 2)
  assert.equal(rows.find(row => row.id === 'tool:child').depth, 1)
})
test('an unfinished nested call does not keep running after its session stops', () => {
  const child = { callId: 'nested', name: 'bash', argsRaw: '{}', time: 2200, turn: 1, step: 1, subCalls: [] }
  const s = snapshot([{ ...call, subCalls: [child] }])
  assert.equal(readRun(s, { running: true }).rows.find(row => row.id === 'tool:nested').state, 'running')
  assert.equal(readRun(s, { running: false }).rows.find(row => row.id === 'tool:nested').state, 'unsettled')
})
test('turn selection and loaded-history scope preserve old and unknown events', () => {
  const s = snapshot([assistant, { ...assistant, seq: 30, turn: 2, blocks: [{ kind: 'text', text: 'Second' }] }, { kind: 'unknown', type: 'extension/event', seq: 40, data: { safe: true }, time: 6000 }], { turnTimings: new Map([[1, { startTime: 1000, endTime: 5000 }], [2, { startTime: 6000 }]]) })
  s.locations.getTurn = seq => seq === 40 ? undefined : seq < 30 ? 1 : 2
  assert.equal(readRun(s, { running: true }).answer, 'Second')
  assert.equal(readRun(s, { running: true }, 1).answer, 'Changed.')
  assert.equal(readRun(s, { running: true }, 1).status, 'ended')
  assert.ok(readRun(s, {}, '*').rows.some(row => row.title === 'extension/event'))
})
test('missing snapshots fail closed without stale rows', () => {
  assert.deepEqual(readRun(undefined, { openState: 'loading' }).rows, [])
  assert.equal(readRun(undefined, { openState: 'error' }).status, 'unavailable')
})
test('no selection means latest even when a zero-numbered turn is loaded', () => {
  const s = snapshot([{ ...assistant, turn: 0, seq: 1 }, { ...assistant, seq: 2, blocks: [{ kind: 'text', text: 'Latest' }] }], { turnTimings: new Map([[0, { startTime: 0 }], [1, { startTime: 1000 }]]) })
  assert.equal(readRun(s, {}, null).answer, 'Latest')
  assert.equal(readRun(s, {}, 0).answer, 'Changed.')
})
test('Changes reports successful recorded edits, not reads, failures or shell guesses', () => {
  const nodes = [call, { ...call, callId: 'bad', isError: true }, { ...call, callId: 'read', call: { name: 'read', argsRaw: call.call.argsRaw } }, { ...call, callId: 'shell', call: { name: 'bash', argsRaw: '{"command":"git diff"}' } }]
  const changes = readChanges(readRun(snapshot(nodes), {}, '*').rows)
  assert.equal(changes.length, 1)
  assert.equal(changes[0].path, 'src/a.ts')
  assert.equal(changes[0].before, 'before')
  assert.equal(changes[0].after, 'after')
  assert.equal(changes[0].kind, 'edit')
})
test('clock and text ticks do not reparse unchanged recorded edit payloads', () => {
  let reads = 0
  const row = { id: 'edit', type: 'tool', title: 'edit', state: 'done', get args() { reads++; return call.call.argsRaw } }
  const first = readChanges([row])
  assert.deepEqual(readChanges([row]), first)
  assert.equal(reads, 1)
  const changed = { ...row, args: JSON.stringify({ file_path: 'b.ts', old_string: '', new_string: 'new' }) }
  assert.equal(readChanges([changed])[0].path, 'b.ts')
})
test('invalid args are safe and patch operations remain explicitly scoped', () => {
  const rows = readRun(snapshot([{ ...call, call: { name: 'edit', argsRaw: '{broken' } }, { ...call, callId: 'patch', call: { name: 'apply_patch', argsRaw: JSON.stringify({ patchText: '*** Begin Patch\n*** Update File: a.ts\n-old\n+new\n*** End Patch' }) } }]), {}, '*').rows
  const changes = readChanges(rows)
  assert.equal(changes.length, 1)
  assert.equal(changes[0].path, 'a.ts')
  assert.match(changes[0].patch, /-old\n\+new/)
})
test('pressure and heuristic composition are not conflated', () => {
  const c = contextNumbers({ pressureTokens: 42000, projectedTokens: 46000, contextWindow: 128000 }, { systemTokens: 1000, toolsTokens: 2000, messageTokens: 3000 })
  assert.equal(c.used, 46000)
  assert.equal(c.reported, 42000)
  assert.equal(c.percent, 46000 / 128000 * 100)
  assert.equal(c.composition.messages, 3000)
})
test('unavailable, malformed and zero-capacity token data never produce fake percentages', () => {
  assert.equal(contextNumbers(undefined, undefined).percent, null)
  assert.equal(contextNumbers({ pressureTokens: 0, contextWindow: 0 }, {}).percent, null)
  assert.equal(contextNumbers({ projectedTokens: -1, pressureTokens: 10, contextWindow: 100 }, {}).used, 10)
  assert.equal(contextNumbers({ pressureTokens: 200, contextWindow: 100 }, {}).percent, 200)
})
test('native file addresses are session scoped and encode special characters', () => {
  const url = new URL(fileAddress('session-1', 'C:\\repo', 'C:\\repo\\a #.ts'))
  assert.equal(url.protocol, 'dsh-resource:')
  assert.match(url.href, /a%20%23\.ts/)
  assert.match(url.href, /session-1/)
})
test('elapsed clocks are bounded and never fabricate missing timestamps', () => {
  assert.equal(elapsedText(1000, 2500), '1.5s')
  assert.equal(elapsedText(null, 3000), 'Unavailable')
  assert.equal(elapsedText(3000, 1000), '0.0s')
})
