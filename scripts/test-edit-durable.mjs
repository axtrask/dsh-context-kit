/**
 * The durable half of the editor, against a real `@deepseek-ai/dsh-session`.
 *
 * The claim this file exists to test: an edit of the user's own message is an ordinary
 * replacement event, so the model receives the new text, the tail is untouched, every
 * other consumer agrees, and the original is still in the log afterwards. A stub session
 * cannot prove that — the fold, the guards and the projection all have to be the real ones.
 *
 * Run:  node scripts/test-edit-durable.mjs
 *
 * @module dsh-context-kit/scripts/test-edit-durable
 */

import { existsSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const kitRoot = join(here, '..');
// A DEDICATED home, wiped first. This test mounts the real plugin, and the plugin persists its
// block/prune state per session under `$DSH_HOME/context-kit/dcp-state/`. Sharing one throwaway
// home with the other suites makes this test's result depend on what they left behind — which is
// exactly what happened: it passed alone and failed under the runner until the fixture was given
// a home of its own.
const scratchHome = join(kitRoot, '.suite-state', 'edit-durable-test');
if (!statSync(dirname(scratchHome)).isDirectory()) throw new Error('missing suite parent');
rmSync(scratchHome, { recursive: true, force: true });
process.env.DSH_HOME = scratchHome;
process.env.XDG_CONFIG_HOME = join(scratchHome, 'xdg');
process.env.OPENCODE_CONFIG_DIR = join(scratchHome, 'opencode');

const failures = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? '[ok]  ' : '[FAIL]'} ${name}${detail.length > 0 ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const { Context } = await import('@deepseek-ai/cordis');
const { Session, SessionStore, SessionId } = await import('@deepseek-ai/dsh-session');
const llm = await import('@deepseek-ai/dsh-llm');
const dcp = await import(`${new URL('../lib/dcp.js', import.meta.url).href}`);
const durable = await import(`${new URL('../lib/edit-durable.js', import.meta.url).href}`);

const text = (value) => ({ type: 'text', text: value });

/** A context with the plugin mounted, so `session/event` delivery behaves as in production. */
async function mount() {
  const context = new Context();
  const warnings = [];
  context.provide('logger', {
    info: () => {},
    debug: () => {},
    error: () => {},
    warn: (...args) => warnings.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '))
  });
  context.provide('tools', { register: () => () => {} });
  context.provide('llm', llm);
  context.provide('tokenMeter', {
    estimateMessage: (message) => JSON.stringify(message?.content ?? message ?? '').length,
    measure: () => ({ nodes: [] })
  });
  const store = new SessionStore(context);
  context.plugin(dcp, {});
  await new Promise((resolve) => setTimeout(resolve, 250));
  return { store, warnings };
}

async function own(store, id) {
  const session = store.create(SessionId(id), { meta: { cwd: process.cwd() } });
  for (let attempt = 0; attempt < 50 && store.get(session.id) === undefined; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return session;
}

const providerView = (session) => session.deriveMessages();
const viewText = (session) => JSON.stringify(providerView(session));

/* ------------------------------------------------------------------ the walk */

console.log('--- a durable edit of the user\'s own message ---');
{
  const { store, warnings } = await mount();
  const session = await own(store, 'edit-durable-walk');

  session.append('turn/start', { turn: 1 });
  session.append('user/message', llm.createUserMessage({ content: [text('FIRST QUESTION')], source: { kind: 'user' } }), { surfaceOp: 'append' });
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    stream: [],
    message: llm.createAssistantMessage({
      content: [text('FIRST ANSWER'), { type: 'tool-call', id: llm.ToolCallId('c1'), name: 'read', arguments: '{"filePath":"a.js"}' }],
      source: { kind: 'model', provider: 'p', model: 'm' }
    })
  }, { surfaceOp: 'append' });
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: llm.createToolResultMessage({ callId: llm.ToolCallId('c1'), content: [text('TOOL BODY')], isError: false })
  }, { surfaceOp: 'append' });
  session.append('turn/end', { turn: 1 });
  session.append('turn/start', { turn: 2 });
  session.append('user/message', llm.createUserMessage({ content: [text('SECOND QUESTION')], source: { kind: 'user' } }), { surfaceOp: 'append' });
  session.append('assistant/message', {
    turn: 2,
    step: 1,
    stream: [],
    message: llm.createAssistantMessage({ content: [text('SECOND ANSWER')], source: { kind: 'model', provider: 'p', model: 'm' } })
  }, { surfaceOp: 'append' });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const before = viewText(session);
  check('the fixture reaches the provider intact', before.includes('FIRST QUESTION') && before.includes('SECOND ANSWER'), '');
  // Five, not six: `deriveEventMessage` drops the empty assistant payload that hosts the
  // usage record, which is why every index in a request has to be derived rather than counted.
  check('five messages are in the request', providerView(session).length === 5, String(providerView(session).length));

  /* --- the index --- */

  const index = durable.editableIndex(session);
  check('the index lists every visible message', index.length === 5, String(index.length));
  check('only user messages are editable durably', durable.userMessages(session).length === 2, String(durable.userMessages(session).length));
  check(
    'the index counts positions as the provider sees them',
    index.map((entry) => entry.index).join(',') === '0,1,2,3,4',
    index.map((entry) => entry.index).join(',')
  );
  check(
    'the index carries every node type, not just the editable ones',
    index.map((entry) => entry.type).join(',') === 'user/message,assistant/message,tool/result,user/message,assistant/message',
    index.map((entry) => entry.type).join(',')
  );
  check(
    'the user messages carry their user-relative number',
    durable.userMessages(session).map((entry) => entry.userIndex).join(',') === '0,1',
    durable.userMessages(session).map((entry) => entry.userIndex).join(',')
  );
  check(
    'the index reports the text the provider would receive',
    durable.userMessages(session)[0].text === 'FIRST QUESTION',
    durable.userMessages(session)[0].text
  );
  // A reply is addressed by its position, not by an id: the GUI's transcript row for it
  // is keyed `<flow>:assistant-step<turn>:<step>` and names no message id at all. The
  // numbers come off the event envelope, so they are read here and nowhere else.
  const replies = index.filter((entry) => entry.type === 'assistant/message');
  check(
    'each reply carries the turn and the step of its event',
    replies.map((entry) => `${entry.turn}:${entry.step}`).join(',') === '1:1,2:1',
    replies.map((entry) => `${entry.turn}:${entry.step}`).join(',')
  );
  check(
    'a message the envelope does not position carries no turn',
    index.filter((entry) => entry.type === 'user/message').every((entry) => entry.turn === undefined && entry.step === undefined),
    JSON.stringify(index.filter((entry) => entry.type === 'user/message').map((entry) => [entry.type, entry.turn, entry.step]))
  );

  /* --- resolving a target --- */

  check('-1 is the last user message', durable.resolveTarget(session, '-1').entry?.text === 'SECOND QUESTION', durable.resolveTarget(session, '-1').entry?.text ?? durable.resolveTarget(session, '-1').reason);
  check('-2 is the first user message', durable.resolveTarget(session, '-2').entry?.text === 'FIRST QUESTION', durable.resolveTarget(session, '-2').entry?.text ?? '');
  check('0 is the first user message', durable.resolveTarget(session, '0').entry?.text === 'FIRST QUESTION', '');
  check('1 is the second user message', durable.resolveTarget(session, '1').entry?.text === 'SECOND QUESTION', '');
  check('an out-of-range number is refused with the count', /no user message #9 \(2 available\)/.test(durable.resolveTarget(session, '9').reason ?? ''), durable.resolveTarget(session, '9').reason);
  check('an out-of-range negative is refused', durable.resolveTarget(session, '-9').reason !== undefined, durable.resolveTarget(session, '-9').reason ?? '');
  const firstId = String(durable.userMessages(session)[0].id);
  const secondId = String(durable.userMessages(session)[1].id);
  let uniquePrefixLength = 1;
  while (uniquePrefixLength < firstId.length && (
    secondId.startsWith(firstId.slice(0, uniquePrefixLength))
      || /^[-+]?\d+$/u.test(firstId.slice(0, uniquePrefixLength))
  )) uniquePrefixLength += 1;
  const firstPrefix = firstId.slice(0, uniquePrefixLength);
  check('a full id resolves', durable.resolveTarget(session, firstId).entry?.text === 'FIRST QUESTION', '');
  check('a unique id prefix resolves', durable.resolveTarget(session, firstPrefix).entry?.text === 'FIRST QUESTION', firstPrefix);
  check('an unknown prefix is refused', durable.resolveTarget(session, 'zzzz').reason !== undefined, durable.resolveTarget(session, 'zzzz').reason ?? '');

  /* --- the dry run --- */

  const target = durable.resolveTarget(session, '-2').entry;
  const eventsBefore = session.snapshotEvents().length;
  const dry = durable.commitUserEdit(session, target, 'FIRST QUESTION, CORRECTED', { dryRun: true });
  check('a dry run succeeds', dry.ok === true, JSON.stringify(dry.reason ?? ''));
  check('a dry run appends nothing', session.snapshotEvents().length === eventsBefore, String(session.snapshotEvents().length - eventsBefore));
  check('a dry run reports the old text', dry.report?.before === 'FIRST QUESTION', String(dry.report?.before));
  check('a dry run reports the new text', dry.report?.after === 'FIRST QUESTION, CORRECTED', String(dry.report?.after));
  check('a dry run reports the seq it would replace', Number.isInteger(dry.report?.seq), JSON.stringify(dry.report?.seq));

  /* --- the commit --- */

  const committed = durable.commitUserEdit(session, target, 'FIRST QUESTION, CORRECTED');
  check('the commit succeeds', committed.ok === true, JSON.stringify(committed.reason ?? ''));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const after = viewText(session);
  check('the model now receives the corrected text', after.includes('FIRST QUESTION, CORRECTED'), after.slice(0, 120));
  check('the original text is gone from the request', !after.includes('"FIRST QUESTION"'), '');
  check('the answer that followed survived', after.includes('FIRST ANSWER'), '');
  check('the tool result survived', after.includes('TOOL BODY'), '');
  check('the second turn survived', after.includes('SECOND QUESTION') && after.includes('SECOND ANSWER'), '');
  check('the request still has five messages', providerView(session).length === 5, String(providerView(session).length));
  check(
    'the edit landed in the slot the original occupied, not at the end',
    providerView(session)[0]?.content?.[0]?.text === 'FIRST QUESTION, CORRECTED',
    providerView(session)[0]?.content?.[0]?.text ?? ''
  );
  check(
    'the message after the edit kept its position',
    JSON.stringify(providerView(session)[1]?.content ?? '').includes('FIRST ANSWER'),
    JSON.stringify(providerView(session)[1]?.content ?? '').slice(0, 60)
  );
  check(
    'the tool result still follows its call',
    providerView(session)[2]?.toolCallId === 'c1',
    JSON.stringify(providerView(session)[2]?.toolCallId ?? null)
  );

  /* --- what the log kept --- */

  const events = session.snapshotEvents();
  check('the original text is still in the log', JSON.stringify(events).includes('"FIRST QUESTION"'), '');
  check('the replacement is in the log as an ordinary event', events.some((event) => event.surfaceOp !== 'append' && event.surfaceOp !== undefined), '');
  check('the log only grew', events.length > eventsBefore, `${eventsBefore} -> ${events.length}`);
  check('no warning was raised', warnings.length === 0, JSON.stringify(warnings));

  /* --- the surface, which is what a reload rebuilds --- */

  check('the surface lists five nodes after the edit', session.surface.nodes.length === 5, String(session.surface.nodes.length));
  const folded = session.surface.nodes.map((seq) => session.eventAt(seq)).map((event) => event?.type);
  check('the folded node types are unchanged', JSON.stringify(folded) === JSON.stringify(['user/message', 'assistant/message', 'tool/result', 'user/message', 'assistant/message']), JSON.stringify(folded));

  /* --- refusing what must be refused --- */

  const unchanged = durable.commitUserEdit(session, durable.resolveTarget(session, '-1').entry, 'SECOND QUESTION');
  check('an unchanged text is refused', unchanged.ok === false && /unchanged/.test(unchanged.reason), String(unchanged.reason));
  const empty = durable.commitUserEdit(session, durable.resolveTarget(session, '-1').entry, '   ');
  check('an empty text is refused', empty.ok === false && /empty/.test(empty.reason), String(empty.reason));
  const assistantEntry = durable.editableIndex(session).find((entry) => entry.type === 'assistant/message');
  const wrongNode = durable.commitUserEdit(session, assistantEntry, 'trying to edit the model');
  check('an assistant node is refused with the reason', wrongNode.ok === false && /wire overlay/.test(wrongNode.reason), String(wrongNode.reason));

  /* --- the listing --- */

  const listing = durable.renderEditableList(session);
  check('the listing numbers the user messages', listing.includes('[0]') && listing.includes('[1]'), listing.split('\n')[1] ?? '');
  check('the listing marks the last message', listing.includes('(last)'), '');
  check('the listing shows the current text', listing.includes('FIRST QUESTION, CORRECTED'), '');

  /* --- a second edit of the same message --- */

  const second = durable.commitUserEdit(session, durable.resolveTarget(session, '-2').entry, 'FIRST QUESTION, TWICE');
  check('a message can be edited again', second.ok === true, JSON.stringify(second.reason ?? ''));
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('the newest text is what the model receives', viewText(session).includes('FIRST QUESTION, TWICE'), '');
  check('the superseded text is gone from the request', !viewText(session).includes('FIRST QUESTION, CORRECTED'), '');
  check('both edits are in the log', JSON.stringify(session.snapshotEvents()).includes('FIRST QUESTION, CORRECTED'), '');
  check('the request is still five messages', providerView(session).length === 5, String(providerView(session).length));

  /* --- the command, which is what a person actually types --- */

  const idle = { status: 'idle' };
  const running = { status: 'running' };
  const on = { enabled: true, requireIdle: true };

  const blockedWhenOff = durable.runEditCommand({ session, agent: idle, config: { enabled: false }, rawInput: '' });
  check('the command refuses to work while the editor is off', blockedWhenOff.kind === 'error' && /editor is off/.test(blockedWhenOff.text), blockedWhenOff.text);

  const bare = durable.runEditCommand({ session, agent: idle, config: on, rawInput: '' });
  check('the bare command lists the editable messages', bare.kind === 'success' && bare.text.includes('[0]'), bare.text.split('\n')[0] ?? '');

  const previewOnly = durable.runEditCommand({ session, agent: idle, config: on, rawInput: '-1' });
  check('a target alone previews instead of editing', previewOnly.kind === 'success' && previewOnly.text.includes('now: SECOND QUESTION'), previewOnly.text.split('\n')[1] ?? '');
  check('the preview does not change the request', providerView(session).length === 5 && viewText(session).includes('SECOND QUESTION'), '');

  const unknown = durable.runEditCommand({ session, agent: idle, config: on, rawInput: '9 whatever' });
  check('an unknown target is refused', unknown.kind === 'error' && /no user message #9/.test(unknown.text), unknown.text);

  const busy = durable.runEditCommand({ session, agent: running, config: on, rawInput: '-1 changed while running' });
  check('a running agent blocks a write', busy.kind === 'error' && /agent is running/.test(busy.text), busy.text);
  check('the blocked write changed nothing', !viewText(session).includes('changed while running'), '');

  const bypass = durable.runEditCommand({ session, agent: running, config: { enabled: true, requireIdle: false }, rawInput: '-1 changed with the gate off' });
  check('requireIdle false cannot bypass the mandatory running-agent guard', bypass.kind === 'error' && /agent is running/.test(bypass.text), bypass.text);
  check('the attempted bypass changed nothing', !viewText(session).includes('changed with the gate off'), '');

  let transactionState = 'untouched';
  const failingAppendSession = new Proxy(session, {
    get(target, property) {
      if (property === 'append') return () => { throw new Error('simulated durable append failure'); };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const transactionalStore = {
    prepareTruncateAnchorRebase() {
      transactionState = 'prepared';
      return {
        ok: true,
        commit: () => { transactionState = 'committed'; },
        rollback: () => { transactionState = 'rolled back'; }
      };
    }
  };
  let appendFailure;
  try {
    durable.runEditCommand({
      session: failingAppendSession,
      agent: idle,
      store: transactionalStore,
      config: on,
      rawInput: '-1 should not survive a failed append'
    });
  } catch (error) {
    appendFailure = error;
  }
  check('a durable append failure is reported', /simulated durable append failure/u.test(String(appendFailure)), String(appendFailure));
  check('a prepared truncate-anchor rebase rolls back when the durable append fails', transactionState === 'rolled back', transactionState);
  check('the failed durable append changes neither request nor tail', !viewText(session).includes('should not survive a failed append')
    && viewText(session).includes('SECOND QUESTION'), viewText(session));

  const written = durable.runEditCommand({ session, agent: idle, config: { enabled: true, requireIdle: false }, rawInput: '-1 changed while idle' });
  check('the same legacy config still permits an idle write', written.kind === 'success', written.text);
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('the idle edit from the command reached the provider', viewText(session).includes('changed while idle'), '');
  check('the tail survived the command edit', viewText(session).includes('FIRST QUESTION, TWICE'), '');

  const listed = durable.runEditCommand({ session, agent: idle, config: on, rawInput: '' });
  check('the listing shows the text the command just wrote', listed.text.includes('changed while idle'), '');

  const pastedId = String(durable.userMessages(session)[0].id);
  const byId = durable.runEditCommand({ session, agent: idle, config: on, rawInput: `${pastedId} edited by id` });
  check('a message can be edited by its id', byId.kind === 'success' && byId.text.includes('#0'), byId.text);
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('the id-based edit reached the provider', viewText(session).includes('edited by id'), '');
  check('the request is still five messages after four edits', providerView(session).length === 5, String(providerView(session).length));

  /* --- what this core refuses, stated as a check --- */

  const assistantTarget = durable.editableIndex(session).find((entry) => entry.type === 'assistant/message');
  const direct = (() => {
    try {
      session.append('assistant/message', {
        turn: 9,
        step: 9,
        stream: [],
        message: llm.createAssistantMessage({ content: [text('REPLACEMENT')], source: { kind: 'model', provider: 'p', model: 'm' } })
      }, { surfaceOp: { op: 'replace', startSeq: assistantTarget.seq, endSeq: assistantTarget.seq }, sourceEventSeqs: [assistantTarget.seq] });
      return { accepted: true };
    } catch (error) {
      return { accepted: false, message: error.message };
    }
  })();
  check('the shipped core still refuses an assistant replacement', direct.accepted === false, JSON.stringify(direct).slice(0, 140));

  check('the state directory was not used by this test', !existsSync(join(scratchHome, 'context-kit', 'edits', 'edit-durable-walk.json')), '');
}

/* --------------------------------------- every genuine block editor target */

console.log('--- durable editor block targets ---');
{
  const image = { type: 'image', source: { type: 'url', url: 'https://example.invalid/target.png' } };
  const message = {
    id: 'all-targets',
    role: 'assistant',
    content: [
      text('ANSWER'),
      { type: 'reasoning', text: 'THINKING' },
      { type: 'tool-call', id: 'target-call', name: 'read', arguments: '{"path":"a.js"}' },
      { type: 'tool-result', toolCallId: 'target-call', content: [text('NESTED RESULT'), image], isError: false },
      image,
      { type: 'tool-result', toolCallId: 'image-only', content: [image], isError: false },
      { type: 'tool-result', toolCallId: 'malformed-content', content: 'not-blocks', isError: false }
    ],
    source: { kind: 'model', provider: 'p', model: 'm' }
  };
  const entry = {
    seq: 1,
    type: 'assistant/message',
    role: 'assistant',
    id: message.id,
    index: 0,
    text: 'ANSWER',
    message
  };
  const targets = durable.blockTargets(entry);
  check('text, reasoning, tool-call and nested tool-result blocks are exposed in order',
    targets.map((target) => `${target.at}:${target.kind}`).join(',') === '0:text,1:reasoning,2:tool-call,3:tool-result',
    JSON.stringify(targets));
  check('every target has its specified human label',
    targets.map((target) => target.label).join(',') === 'Answer,Thinking,Tool call,Tool result',
    targets.map((target) => target.label).join(','));
  check('target text uses the shared canonical text for every block kind',
    targets.map((target) => target.text).join('|') === 'ANSWER|THINKING|{"path":"a.js"}|NESTED RESULT',
    targets.map((target) => target.text).join('|'));
  check('image, image-only result and malformed result blocks are not manufactured into targets',
    targets.length === 4 && targets.every((target) => target.at < 4), JSON.stringify(targets));
  check('assistant tool-call and nested tool-result targets stay on the wire branch',
    durable.editability(entry, 2).branch === durable.WIRE_BRANCH
      && durable.editability(entry, 3).branch === durable.WIRE_BRANCH
      && targets[2].editable === true && targets[3].editable === true,
    JSON.stringify([durable.editability(entry, 2), durable.editability(entry, 3)]));

  const userMessage = llm.createUserMessage({ content: [text('QUESTION')], source: { kind: 'user' } });
  const userEntry = { seq: 2, type: 'user/message', role: 'user', id: userMessage.id, index: 0, userIndex: 0, text: 'QUESTION', message: userMessage };
  check('ordinary user and assistant text targets are labelled Message and Answer',
    durable.blockTargets(userEntry)[0]?.label === 'Message' && targets[0]?.label === 'Answer');
}

/* ------------------------------------ durable host tool/result replacement */

console.log('--- a durable edit of a host tool result ---');
{
  const session = Session.create(SessionId('editor-host-tool-result'));
  const callId = llm.ToolCallId('host-call');
  session.append('assistant/message', {
    turn: 4,
    step: 2,
    stream: [{ keep: 'stream-envelope' }],
    message: llm.createAssistantMessage({
      content: [text('calling'), { type: 'tool-call', id: callId, name: 'read', arguments: '{"filePath":"a.js"}' }],
      source: { kind: 'model', provider: 'p', model: 'm' }
    })
  }, { surfaceOp: 'append' });
  const toolMessage = {
    ...llm.createToolResultMessage({ callId, content: [
      { ...text('HOST BODY'), annotations: { keep: 'text metadata' } },
      { type: 'image', source: { type: 'url', url: 'https://example.invalid/result.png' } }
    ], isError: true }),
    metadata: { keep: 'message metadata' }
  };
  session.append(durable.TOOL_EVENT, {
    turn: 4,
    step: 2,
    message: toolMessage,
    error: { name: 'ReadError', code: 'E_READ', reason: 'original raw reason' },
    meta: { card: { keep: true }, count: 7 }
  }, { surfaceOp: 'append' });

  const entry = durable.editableIndex(session).find((item) => item.type === durable.TOOL_EVENT);
  const originalEvent = session.eventAt(entry.seq);
  const originalLogLength = session.snapshotEvents().length;
  const originalSurface = [...session.surface.nodes];
  const originalAt = originalSurface.indexOf(entry.seq);
  const withoutContent = (data) => JSON.stringify({ ...data, message: { ...data.message, content: null } });
  const originalOutsideContent = withoutContent(originalEvent.data);
  const targets = durable.blockTargets(entry);
  check('a host result text block is exposed and labelled Tool result',
    targets.length === 1 && targets[0].kind === 'text' && targets[0].label === 'Tool result' && targets[0].text === 'HOST BODY',
    JSON.stringify(targets));
  check('a host tool result selects the durable branch', durable.editability(entry, 0).branch === durable.DURABLE_BRANCH,
    JSON.stringify(durable.editability(entry, 0)));

  const dry = durable.commitToolResultEdit(session, entry, 'HOST BODY EDITED', { blockAt: 0, dryRun: true });
  check('a host result dry run succeeds and reports the selected block', dry.ok === true
    && dry.report?.before === 'HOST BODY' && dry.report?.after === 'HOST BODY EDITED'
    && dry.report?.block === 0 && dry.report?.branch === durable.DURABLE_BRANCH, JSON.stringify(dry));
  check('the host result dry run appends nothing', session.snapshotEvents().length === originalLogLength
    && JSON.stringify(session.surface.nodes) === JSON.stringify(originalSurface));
  check('the planned result changes only event.data.message.content', dry.ok === true
    && withoutContent(dry.data) === originalOutsideContent
    && dry.data.message.content[0].text === 'HOST BODY EDITED'
    && JSON.stringify(dry.data.message.content[1]) === JSON.stringify(originalEvent.data.message.content[1]),
    JSON.stringify(dry.data));
  check('commitUserEdit cannot accidentally take the narrower tool-result branch',
    durable.commitUserEdit(session, entry, 'WRONG API', { blockAt: 0, dryRun: true }).ok === false
      && /commitToolResultEdit/u.test(durable.commitUserEdit(session, entry, 'WRONG API', { blockAt: 0, dryRun: true }).reason ?? ''));

  const committed = durable.commitToolResultEdit(session, entry, 'HOST BODY EDITED', { blockAt: 0 });
  check('the durable host result commit succeeds', committed.ok === true, JSON.stringify(committed.reason ?? committed.report));
  check('the replacement appended exactly one event', session.snapshotEvents().length === originalLogLength + 1,
    `${originalLogLength} -> ${session.snapshotEvents().length}`);
  check('the result is replaced in its original surface slot', session.surface.nodes.length === originalSurface.length
    && session.surface.nodes[originalAt] === committed.report?.newSeq
    && session.surface.nodes.filter((_, at) => at !== originalAt).every((seq, at) => seq === originalSurface[at < originalAt ? at : at + 1]),
    JSON.stringify(session.surface.nodes));
  const currentEvent = session.eventAt(session.surface.nodes[originalAt]);
  check('the committed result preserved every data and message field outside content',
    withoutContent(currentEvent.data) === originalOutsideContent, withoutContent(currentEvent.data));
  check('metadata, error identity and pairing survive the durable rewrite',
    currentEvent.data.meta?.card?.keep === true
      && currentEvent.data.error?.code === 'E_READ'
      && currentEvent.data.message.metadata?.keep === 'message metadata'
      && currentEvent.data.message.toolCallId === callId
      && currentEvent.data.message.source?.callId === callId
      && currentEvent.data.message.isError === true);
  check('the selected text changed while the sibling image survived byte for byte',
    currentEvent.data.message.content[0].text === 'HOST BODY EDITED'
      && JSON.stringify(currentEvent.data.message.content[1]) === JSON.stringify(originalEvent.data.message.content[1]));
  check('the append shadows exactly the original result node',
    currentEvent.surfaceOp?.op === 'replace'
      && currentEvent.surfaceOp.startSeq === entry.seq && currentEvent.surfaceOp.endSeq === entry.seq
      && JSON.stringify(currentEvent.sourceEventSeqs) === JSON.stringify([entry.seq]), JSON.stringify(currentEvent));
  check('the assistant call remains immediately before its paired edited result',
    providerView(session)[0]?.content?.some((block) => block.type === 'tool-call' && block.id === callId)
      && providerView(session)[1]?.toolCallId === callId);
  check('the original result remains in the audit log',
    session.snapshotEvents().some((event) => event.seq === entry.seq && event.data?.message?.content?.[0]?.text === 'HOST BODY'));

  const firstProjection = durable.effectiveEditableIndex(session).find((item) => item.type === durable.TOOL_EVENT);
  check('the GUI projection follows the durable result edge back to its original text',
    firstProjection?.originSeq === entry.seq && firstProjection?.originId === entry.id
      && firstProjection?.edited === true && firstProjection?.changed === true
      && firstProjection?.targets?.[0]?.originalText === 'HOST BODY'
      && firstProjection?.targets?.[0]?.edited === true && firstProjection?.targets?.[0]?.changed === true,
    JSON.stringify(firstProjection));

  const repeatedEntry = durable.editableIndex(session).find((item) => item.type === durable.TOOL_EVENT);
  const repeated = durable.commitToolResultEdit(session, repeatedEntry, 'HOST BODY EDITED AGAIN', { blockAt: 0 });
  const repeatedProjection = durable.effectiveEditableIndex(session).find((item) => item.type === durable.TOOL_EVENT);
  check('a repeated durable result edit retains the first result as its restore origin', repeated.ok === true
    && repeatedProjection?.originSeq === entry.seq && repeatedProjection?.targets?.[0]?.originalText === 'HOST BODY'
    && repeatedProjection?.text === 'HOST BODY EDITED AGAIN', JSON.stringify(repeatedProjection));

  const restoreEntry = durable.editableIndex(session).find((item) => item.type === durable.TOOL_EVENT);
  const restored = durable.commitToolResultEdit(session, restoreEntry, repeatedProjection.targets[0].originalText, { blockAt: 0 });
  const replay = Session.create(SessionId('editor-host-tool-result-replay'), session.snapshotEvents());
  const restoredProjection = durable.effectiveEditableIndex(replay).find((item) => item.type === durable.TOOL_EVENT);
  check('repeated edit and restore survive replay with history but no current difference', restored.ok === true
    && restoredProjection?.originSeq === entry.seq && restoredProjection?.targets?.[0]?.originalText === 'HOST BODY'
    && restoredProjection?.edited === true && restoredProjection?.changed === false
    && restoredProjection?.targets?.[0]?.edited === true && restoredProjection?.targets?.[0]?.changed === false
    && restoredProjection?.text === 'HOST BODY', JSON.stringify(restoredProjection));

  const stale = durable.commitToolResultEdit(session, entry, 'STALE RESULT', { blockAt: 0, dryRun: true });
  check('an entry for the shadowed result is refused as stale', stale.ok === false && /no longer a current surface node/u.test(stale.reason ?? ''), String(stale.reason));
}

console.log('--- canonical nested host tool-result editing ---');
{
  const session = Session.create(SessionId('editor-host-nested-tool-result'));
  const callId = llm.ToolCallId('nested-host-call');
  session.append('assistant/message', {
    turn: 1, step: 1, stream: [],
    message: llm.createAssistantMessage({
      content: [{ type: 'tool-call', id: callId, name: 'nested', arguments: '{}' }],
      source: { kind: 'model', provider: 'p', model: 'm' }
    })
  }, { surfaceOp: 'append' });
  const image = { type: 'image', source: { type: 'url', url: 'https://example.invalid/nested.png' } };
  session.append(durable.TOOL_EVENT, {
    turn: 1, step: 1,
    message: llm.createToolResultMessage({ callId, content: [{
      type: 'tool-result', toolCallId: 'inner-call', isError: false,
      content: [text('INNER A'), text(' + INNER B'), image]
    }], isError: false })
  }, { surfaceOp: 'append' });
  const entry = durable.editableIndex(session).find((item) => item.type === durable.TOOL_EVENT);
  const target = durable.blockTargets(entry)[0];
  check('a nested result target uses canonical joined text', target?.kind === 'tool-result'
    && target.text === 'INNER A + INNER B' && target.label === 'Tool result', JSON.stringify(target));
  const result = durable.commitToolResultEdit(session, entry, 'INNER EDITED', { blockAt: target.at });
  const nested = durable.editableIndex(session).find((item) => item.type === durable.TOOL_EVENT)?.message?.content?.[0];
  check('the durable nested edit uses shared canonicalization and keeps result identity', result.ok === true
    && nested?.type === 'tool-result' && nested.toolCallId === 'inner-call' && nested.isError === false
    && nested.content.filter((block) => block.type === 'text').map((block) => block.text).join('') === 'INNER EDITED',
    JSON.stringify(nested));
  check('the nested non-text sibling survives canonicalization',
    JSON.stringify(nested?.content?.find((block) => block.type === 'image')) === JSON.stringify(image));
}

console.log('--- malformed, unpaired and no-text host results are refused ---');
{
  const canonical = llm.createToolResultMessage({ callId: llm.ToolCallId('orphan-call'), content: [text('ORPHAN BODY')], isError: false });
  const event = { seq: 10, type: durable.TOOL_EVENT, data: { turn: 1, step: 1, message: canonical } };
  const stub = { surface: { nodes: [10] }, eventAt: (seq) => (seq === 10 ? event : undefined) };
  const entry = durable.editableIndex(stub)[0];
  const unpaired = durable.commitToolResultEdit(stub, entry, 'EDITED', { blockAt: 0, dryRun: true });
  check('an otherwise canonical but unpaired host result is refused', unpaired.ok === false && /unpaired/u.test(unpaired.reason ?? ''), String(unpaired.reason));

  const mismatchedMessage = { ...canonical, source: { ...canonical.source, callId: 'different-call' } };
  const mismatchedEvent = { ...event, data: { ...event.data, message: mismatchedMessage } };
  const mismatchedStub = { surface: { nodes: [10] }, eventAt: (seq) => (seq === 10 ? mismatchedEvent : undefined) };
  const mismatchedEntry = durable.editableIndex(mismatchedStub)[0];
  const mismatched = durable.commitToolResultEdit(mismatchedStub, mismatchedEntry, 'EDITED', { blockAt: 0, dryRun: true });
  check('mismatched result and source pairing ids are refused as malformed',
    mismatched.ok === false && /do not match/u.test(mismatched.reason ?? ''), String(mismatched.reason));

  const callEvent = {
    seq: 9, type: 'assistant/message',
    data: { turn: 1, step: 1, stream: [], message: llm.createAssistantMessage({
      content: [{ type: 'tool-call', id: llm.ToolCallId('no-text-call'), name: 'read', arguments: '{}' }],
      source: { kind: 'model', provider: 'p', model: 'm' }
    }) }
  };
  const noTextMessage = llm.createToolResultMessage({
    callId: llm.ToolCallId('no-text-call'),
    content: [
      { type: 'image', source: { type: 'url', url: 'https://example.invalid/only.png' } },
      { type: 'tool-result', toolCallId: 'inner', content: [], isError: false }
    ],
    isError: false
  });
  const noTextEvent = { seq: 10, type: durable.TOOL_EVENT, data: { turn: 1, step: 1, message: noTextMessage } };
  const noTextStub = {
    surface: { nodes: [9, 10] },
    eventAt: (seq) => (seq === 9 ? callEvent : seq === 10 ? noTextEvent : undefined)
  };
  const noTextEntry = durable.editableIndex(noTextStub).find((item) => item.type === durable.TOOL_EVENT);
  check('image-only and empty nested results expose no target', durable.blockTargets(noTextEntry).length === 0,
    JSON.stringify(durable.blockTargets(noTextEntry)));
  const noText = durable.commitToolResultEdit(noTextStub, noTextEntry, 'EDITED', { dryRun: true });
  check('a paired host result with no genuine text is refused without append',
    noText.ok === false && /no editable text block/u.test(noText.reason ?? ''), String(noText.reason));
}

console.log('--- only safe tool-result provenance is followed ---');
for (const [name, alter] of [
  ['multiple sources', ({ replacement, source }) => ({ source, replacement: { ...replacement, sourceEventSeqs: [0, 0] } })],
  ['mismatched replacement range', ({ replacement, source }) => ({ source, replacement: { ...replacement, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 } } })],
  ['changed event metadata', ({ replacement, source }) => ({ source, replacement: { ...replacement, data: { ...replacement.data, meta: { forged: true } } } })],
  ['changed message identity', ({ replacement, source }) => ({
    source,
    replacement: { ...replacement, data: { ...replacement.data, message: { ...replacement.data.message, id: 'different-result-id' } } }
  })],
  ['non-result source', ({ replacement, source }) => ({
    replacement,
    source: { ...source, type: 'user/message', data: llm.createUserMessage({ content: [text('SOURCE')], source: { kind: 'user' } }) }
  })]
]) {
  const callId = llm.ToolCallId(`unsafe-provenance-${name}`);
  const sourceMessage = llm.createToolResultMessage({ callId, content: [text('ORIGINAL')], isError: false });
  const source = { seq: 0, type: durable.TOOL_EVENT, data: { turn: 1, step: 1, message: sourceMessage }, surfaceOp: 'append' };
  const replacement = {
    seq: 1,
    type: durable.TOOL_EVENT,
    data: { ...source.data, message: { ...sourceMessage, content: [text('CURRENT')] } },
    sourceEventSeqs: [0],
    surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }
  };
  const changed = alter({ source, replacement });
  const events = [changed.source, changed.replacement];
  const session = { surface: { nodes: [1] }, eventAt: (seq) => events[seq] };
  const projected = durable.effectiveEditableIndex(session)[0];
  check(`tool-result origin does not cross ${name}`, projected?.originSeq === 1
    && projected?.edited === false && projected?.targets?.[0]?.originalText === 'CURRENT', JSON.stringify(projected));
}

/* ------------------------------------------- the model's own thinking (CoT) */

console.log('--- the chain of thought ---');
{
  const { store } = await mount();
  const cot = await own(store, 'edit-durable-cot');
  const reasoning = (value) => ({ type: 'reasoning', text: value });
  cot.append('turn/start', { turn: 1 });
  cot.append('user/message', llm.createUserMessage({ content: [text('ASK')], source: { kind: 'user' } }), { surfaceOp: 'append' });
  // A DeepSeek turn before a tool call says nothing but its thinking. There is no text
  // block to rewrite, so the thinking is the only thing an edit could target.
  cot.append('assistant/message', {
    turn: 1,
    step: 1,
    stream: [],
    message: llm.createAssistantMessage({
      content: [reasoning('THINKING ONLY')],
      source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }
    })
  }, { surfaceOp: 'append' });
  // The same shape from the Anthropic-family adapter, whose thinking is SIGNED and whose
  // signature lives in the message's replay state, not on the block.
  cot.append('assistant/message', {
    turn: 1,
    step: 2,
    stream: [],
    message: llm.createAssistantMessage({
      content: [reasoning('SIGNED THINKING')],
      source: {
        kind: 'model',
        provider: 'pi',
        model: 'claude',
        replayState: {
          response: { kind: 'pi-ai', version: 2, api: 'anthropic-messages', provider: 'pi', model: 'claude', stopReason: 'stop' },
          blocks: [{ type: 'reasoning', thinkingSignature: 'SIG-over-the-old-thinking' }]
        }
      }
    })
  }, { surfaceOp: 'append' });
  // And a reply that says both things, where the TEXT is what an edit must land on.
  cot.append('assistant/message', {
    turn: 1,
    step: 3,
    stream: [],
    message: llm.createAssistantMessage({
      content: [reasoning('SOME THINKING'), text('SOME ANSWER')],
      source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }
    })
  }, { surfaceOp: 'append' });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const replies = durable.editableIndex(cot).filter((entry) => entry.type === 'assistant/message');
  check('the three replies are on the index', replies.length === 3, String(replies.length));

  const thinkingOnly = replies[0];
  check('a reply that says nothing but its thinking carries that thinking as its text', thinkingOnly?.text === 'THINKING ONLY', String(thinkingOnly?.text));
  check('and it is editable on the wire', durable.editability(thinkingOnly).branch === 'wire', JSON.stringify(durable.editability(thinkingOnly)));

  const signed = replies[1];
  check('a SIGNED thinking reply is editable on the wire', durable.editability(signed).branch === 'wire', JSON.stringify(durable.editability(signed)));
  check('its signed reasoning target is offered for editing', durable.blockTargets(signed)[0]?.editable === true, JSON.stringify(durable.blockTargets(signed)));

  const opaqueMessage = {
    id: 'opaque-redacted-reasoning',
    role: 'assistant',
    content: [{ type: 'reasoning', redacted: { providerState: 'opaque' } }],
    source: { kind: 'model', provider: 'p', model: 'm' }
  };
  const opaque = {
    seq: 999,
    type: 'assistant/message',
    role: 'assistant',
    id: opaqueMessage.id,
    index: 0,
    text: '',
    message: opaqueMessage
  };
  const opaqueTargets = durable.blockTargets(opaque);
  check('opaque redacted thinking remains a visible disabled target with empty display text',
    opaqueTargets.length === 1 && opaqueTargets[0].kind === 'reasoning'
      && opaqueTargets[0].label === 'Thinking' && opaqueTargets[0].text === '' && opaqueTargets[0].chars === 0
      && opaqueTargets[0].signed === true && opaqueTargets[0].editable === false,
    JSON.stringify(opaqueTargets));
  check('opaque redacted thinking exposes the permanent redaction reason before generic no-text refusal',
    /redacted, so its text is not what the provider receives/u.test(opaqueTargets[0]?.reason ?? '')
      && !/no editable text/u.test(opaqueTargets[0]?.reason ?? '')
      && durable.editability(opaque, 0).reason === opaqueTargets[0]?.reason,
    JSON.stringify(durable.editability(opaque, 0)));

  const both = replies[2];
  check('a reply with thinking AND text is edited through its text', both?.text === 'SOME ANSWER', String(both?.text));
  check('and it is editable on the wire', durable.editability(both).branch === 'wire', JSON.stringify(durable.editability(both)));
  // The thinking is NOT silently folded into the text an edit is aimed at: the joined
  // string would match no block and the commit would refuse after the panel offered it.
  check('the thinking is not joined into that text', !String(both?.text).includes('SOME THINKING'), String(both?.text));
}

console.log('--- verified durable editor provenance ---');
{
  const session = Session.create(SessionId('editor-origin'));
  session.append('assistant/message', {
    turn: 1, step: 1, stream: [],
    message: llm.createAssistantMessage({ content: [], source: { kind: 'model', provider: 'p', model: 'm' } })
  }, { surfaceOp: 'append' });
  session.append('user/message', llm.createUserMessage({ content: [text('A')], source: { kind: 'user' } }), { surfaceOp: 'append' });
  const original = durable.userMessages(session)[0];
  check('the provenance fixture has a non-projecting surface node before the user', session.surface.nodes.indexOf(original.seq) !== original.index);
  const first = durable.commitUserEdit(session, original, 'B');
  check('newSeq is the actual appended event, not a filtered surface position', first.report?.newSeq === session.snapshotEvents().at(-1).seq);
  durable.commitUserEdit(session, durable.userMessages(session)[0], 'C', { source: { kind: 'plugin:context-kit-editor' } });
  const restored = Session.create(SessionId('editor-origin-restored'), session.snapshotEvents());
  const projected = durable.effectiveEditableIndex?.(restored)?.[0];
  check('repeat edits and replay retain the original seq and id', projected?.originSeq === original.seq && projected?.originId === original.id);
  check('current identity remains distinct from the origin', projected?.seq === durable.userMessages(restored)[0].seq && projected?.id !== original.id);
  check('durable projection reports edited and changed', projected?.edited === true && projected?.changed === true);
  durable.commitUserEdit(restored, durable.userMessages(restored)[0], 'A');
  const reverted = durable.effectiveEditableIndex?.(restored)?.[0];
  check('durable A->B->C->A retains history but no actual diff', reverted?.edited === true && reverted?.changed === false && reverted?.targets?.[0]?.changed === false);
}

// Only these exact provenance edges establish editor identity; id suffixes prove nothing.
for (const [name, override] of [
  ['DCP', { data: { id: 'root-edited', role: 'user', content: [text('B')], source: { kind: 'plugin:dcp' } } }],
  ['non-plugin source', { data: { id: 'root-edited', role: 'user', content: [text('B')], source: { kind: 'user', plugin: 'edit' } } }],
  ['append', { surfaceOp: 'append' }],
  ['incorrect event seq', { seq: 99 }],
  ['multiple sources', { sourceEventSeqs: [0, 1] }],
  ['mismatched range', { surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 } }],
  ['self-reference', { sourceEventSeqs: [2], surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 } }],
  ['missing source', { sourceEventSeqs: [1], surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } }]
]) {
  const root = { seq: 0, type: 'user/message', data: { id: 'root', role: 'user', content: [text('A')] }, surfaceOp: 'append' };
  const replacement = {
    seq: 2, type: 'user/message', data: { id: 'root-edited', role: 'user', content: [text('B')], source: { kind: 'plugin:edit' } },
    surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }, sourceEventSeqs: [0], ...override
  };
  const events = [root, undefined, replacement];
  const session = { surface: { nodes: [2] }, eventAt: (seq) => events[seq] };
  const projected = durable.effectiveEditableIndex?.(session)?.[0];
  check(`origin does not cross ${name}`, projected?.originSeq === 2 && projected?.originId === replacement.data.id && projected?.edited === false);
  events.push({ ...replacement, seq: 3, data: { ...replacement.data, id: 'later', source: { kind: 'plugin:context-kit-editor' } }, sourceEventSeqs: [2], surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 } });
  session.surface.nodes = [3];
  const later = durable.effectiveEditableIndex?.(session)?.[0];
  const validSource = replacement.seq === 2;
  check(`an editor edge stops at ${name} rather than crossing it`, later?.originSeq === (validSource ? 2 : 3)
    && later?.originId === (validSource ? replacement.data.id : 'later') && later?.edited === validSource);
}

for (const type of ['assistant/message', 'system/message']) {
  const events = [
    { seq: 0, type, data: { message: { id: 'not-user', role: 'assistant', content: [text('A')] } } },
    { seq: 1, type: 'user/message', data: { id: 'replacement', role: 'user', content: [text('B')], source: { kind: 'plugin:edit' } },
      sourceEventSeqs: [0], surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 } }
  ];
  const projected = durable.effectiveEditableIndex?.({ surface: { nodes: [1] }, eventAt: (seq) => events[seq] })?.[0];
  check(`origin never follows a ${type} source`, projected?.originSeq === 1 && projected?.edited === false);
}

console.log('--- durable edits of one selected user text block ---');
{
  const session = Session.create(SessionId('editor-user-blocks'));
  session.append('user/message', {
    ...llm.createUserMessage({ content: [
      { ...text('A'), id: 'text-a', annotations: { keep: 'a' } },
      { ...text('B'), id: 'text-b', annotations: { keep: 'b' } }
    ], source: { kind: 'user' } }),
    metadata: { keep: 'message' }
  }, { surfaceOp: 'append' });
  session.append('user/message', llm.createUserMessage({ content: [text('TAIL')], source: { kind: 'user' } }), { surfaceOp: 'append' });
  const original = durable.userMessages(session)[0];
  const originalEvents = session.snapshotEvents();
  const originalLog = JSON.stringify(originalEvents);
  check('the selected-block fixture really retains block and message metadata', original.message.metadata?.keep === 'message'
    && original.message.content[0].annotations?.keep === 'a' && original.message.content[1].id === 'text-b');
  check('the real session exposes frozen input blocks', Object.isFrozen(original.message) && Object.isFrozen(original.message.content[0]));
  const preview = durable.commitUserEdit(session, original, 'X', { blockAt: 0, dryRun: true });
  check('selected-block preview reports only A->X at block 0', preview.ok && preview.report?.before === 'A'
    && preview.report?.after === 'X' && preview.report?.block === 0);
  check('selected-block preview appends nothing', JSON.stringify(session.snapshotEvents()) === originalLog);
  for (const blockAt of [-1, 2, 0.5, '0', null]) {
    const refused = durable.commitUserEdit(session, original, 'X', { blockAt, dryRun: true });
    check(`an invalid explicit durable block (${JSON.stringify(blockAt)}) is refused`, refused.ok === false);
  }

  const unchangedSession = Session.create(SessionId('editor-user-block-unchanged'), originalEvents);
  const unchangedLog = JSON.stringify(unchangedSession.snapshotEvents());
  const unchanged = durable.commitUserEdit(unchangedSession, durable.userMessages(unchangedSession)[0], 'A', { blockAt: 0 });
  check('unchanged means the selected text, not the joined message', unchanged.ok === false && /unchanged/u.test(unchanged.reason ?? ''));
  check('an unchanged selected block appends nothing', JSON.stringify(unchangedSession.snapshotEvents()) === unchangedLog);

  const first = durable.commitUserEdit(session, original, 'X', { blockAt: 0 });
  let current = durable.userMessages(session)[0];
  check('block 0 replaces [A,B] with [X,B], not [X,X]', first.ok && current.message.content.map((block) => block.text).join(',') === 'X,B');
  check('the selected block keeps all fields except its text', JSON.stringify(current.message.content[0]) === JSON.stringify({ ...original.message.content[0], text: 'X' }));
  check('the sibling block survives byte for byte', JSON.stringify(current.message.content[1]) === JSON.stringify(original.message.content[1]));
  check('a block edit preserves unrelated message fields', JSON.stringify(current.message.metadata) === JSON.stringify(original.message.metadata));
  check('the first durable report names the selected before, after and block', first.report?.before === 'A' && first.report?.after === 'X' && first.report?.block === 0);
  const firstProjection = durable.effectiveEditableIndex(session)[0];
  check('an untouched sibling is not marked as edited or applied', firstProjection.targets[0].edited === true
    && firstProjection.targets[1].edited === false && firstProjection.targets[1].changed === false && firstProjection.targets[1].editStatus === 'none');
  const firstLog = JSON.stringify(session.snapshotEvents());
  let staleRefused = false;
  try { durable.commitUserEdit(session, original, 'STALE', { blockAt: 0 }); } catch { staleRefused = true; }
  check('the core still rejects a durable edit of a replaced source node', staleRefused && JSON.stringify(session.snapshotEvents()) === firstLog);

  const second = durable.commitUserEdit(session, current, 'Y', { blockAt: 1 });
  current = durable.userMessages(session)[0];
  check('block 1 then replaces [X,B] with [X,Y]', second.ok && current.message.content.map((block) => block.text).join(',') === 'X,Y');
  check('the second report says B->Y at block 1', second.report?.before === 'B' && second.report?.after === 'Y' && second.report?.block === 1);
  check('the original audit and trailing node remain unchanged', JSON.stringify(session.snapshotEvents().slice(0, originalEvents.length)) === originalLog
    && durable.userMessages(session)[1].text === 'TAIL');
  const replay = Session.create(SessionId('editor-user-blocks-replay'), session.snapshotEvents());
  const projected = durable.effectiveEditableIndex(replay)[0];
  check('selected edits survive replay with their original provenance', projected.text === 'XY' && projected.originSeq === original.seq
    && projected.originId === original.id && projected.seq === second.report?.newSeq);
  durable.commitUserEdit(replay, durable.userMessages(replay)[0], 'A', { blockAt: 0 });
  durable.commitUserEdit(replay, durable.userMessages(replay)[0], 'B', { blockAt: 1 });
  const reverted = durable.effectiveEditableIndex(replay)[0];
  check('per-block reverts keep history without claiming a current difference', reverted.text === 'AB' && reverted.edited && !reverted.changed
    && reverted.targets.every((target) => target.edited && !target.changed));

  const legacy = Session.create(SessionId('editor-user-blocks-legacy'), originalEvents);
  const whole = durable.commitUserEdit(legacy, durable.userMessages(legacy)[0], 'WHOLE');
  check('omitting blockAt preserves the shipped whole-message contract', whole.ok && whole.report.before === 'AB' && whole.report.block === undefined
    && durable.userMessages(legacy)[0].message.content.every((block) => block.text === 'WHOLE'));
  const command = durable.runEditCommand({ session: legacy, config: { enabled: true }, rawInput: '0 COMMAND' });
  check('the command still rewrites the whole multi-text message', command.kind === 'success'
    && durable.userMessages(legacy)[0].message.content.every((block) => block.text === 'COMMAND'));
}

{
  // A pasted screenshot beside the words is not a reason to withhold the editor. The edit
  // rewrites the text and carries the image, whichever way it is aimed.
  const image = { type: 'image', source: { type: 'url', url: 'https://example.invalid/image.png' } };
  const mixed = Session.create(SessionId('editor-user-blocks-mixed'));
  mixed.append('user/message', llm.createUserMessage({ content: [text('A'), image], source: { kind: 'user' } }), { surfaceOp: 'append' });
  const entry = () => durable.userMessages(mixed)[0];
  const byBlock = durable.commitUserEdit(mixed, entry(), 'X', { blockAt: 0 });
  check('an edit aimed at the text of a message with an image rewrites the text and keeps the image', byBlock.ok === true
    && entry().message.content.map((block) => block.type).join(',') === 'text,image'
    && entry().message.content[0].text === 'X');
  const whole = durable.commitUserEdit(mixed, entry(), 'WHOLE');
  check('and so does an edit of the whole message', whole.ok === true
    && entry().message.content.map((block) => block.type).join(',') === 'text,image'
    && entry().message.content[0].text === 'WHOLE');
  const imageAt = durable.commitUserEdit(mixed, entry(), 'Y', { blockAt: 1 });
  check('the image is still not an editable block', imageAt.ok === false && /image block/u.test(String(imageAt.reason)));
  check('so the panel offers the text block and nothing else', durable.blockTargets(entry()).map((target) => target.at).join(',') === '0'
    && durable.blockTargets(entry())[0].editable === true);

  const only = Session.create(SessionId('editor-user-image-only'));
  only.append('user/message', llm.createUserMessage({ content: [{ ...image }], source: { kind: 'user' } }), { surfaceOp: 'append' });
  const nothingToSay = durable.commitUserEdit(only, durable.userMessages(only)[0], 'X');
  check('a message with no text block is refused in the words that say so', nothingToSay.ok === false
    && /no text block/u.test(String(nothingToSay.reason))
    && durable.blockTargets(durable.userMessages(only)[0]).length === 0);
}

console.log(`\n${failures.length === 0 ? 'all durable edit tests passed' : `${failures.length} FAILURES: ${failures.join('; ')}`}`);
process.exit(failures.length === 0 ? 0 : 1);
