/**
 * The context-limit knobs must actually do something.
 *
 * `minContextLimit`, `maxContextLimit`, `nudgeFrequency`, `summaryBuffer`, and
 * the per-model override maps were accepted by the schema and read by nobody:
 * a user could set them, see no complaint, and get no effect — the worst of the
 * three possible outcomes. Upstream DCP fires a reminder between those
 * thresholds and escalates past the ceiling, so this test pins the decision
 * table and the two rules that are easy to get wrong:
 *
 *   - `summaryBuffer` widens the ceiling by the tokens the live summaries
 *     already occupy, because that text is in the transcript too;
 *   - a per-model override wins over the global limit for that route only.
 *
 * Run:  node scripts/test-dcp-nudge.mjs
 *
 * @module dsh-context-kit/scripts/test-dcp-nudge
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const kitRoot = join(here, '..');
const stateHome = mkdtempSync(join(tmpdir(), 'dcp-nudge-state-'));
const previousDshHome = process.env.DSH_HOME;
const previousXdgHome = process.env.XDG_CONFIG_HOME;
const previousConfigDir = process.env.OPENCODE_CONFIG_DIR;
process.env.DSH_HOME = stateHome;
process.env.XDG_CONFIG_HOME = join(stateHome, 'xdg');
process.env.OPENCODE_CONFIG_DIR = join(stateHome, 'config');

const failures = [];
/** @param name - check label. @param ok - result. @param detail - evidence. */
function check(name, ok, detail = '') {
  console.log(`${ok ? '[ok]  ' : '[FAIL]'} ${name}${detail.length > 0 ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const dcp = await import(pathToFileURL(join(kitRoot, 'lib', 'dcp.js')).href);

/**
 * An engine carrying just what `evaluateNudge` touches.
 *
 * The real constructor opens the knowledge base and registers prompt sections,
 * neither of which the decision table needs. Building on the prototype keeps
 * every method real while the dependencies stay stubs, and it is the same
 * approach `test-dcp-range.mjs` uses for `balancedRange`.
 *
 * @param config - DCP configuration overrides.
 * @param totalTokens - what the token meter reports.
 * @returns the engine plus the logger warnings it recorded.
 */
function engineFor(config, totalTokens) {
  const engine = Object.create(dcp.DcpCompactionEngine.prototype);
  const warnings = [];
  const messages = [];
  engine.ctx = {
    tokenMeter: {
      estimateMessage: (message) => JSON.stringify(message ?? '').length,
      measure: () => ({ totalTokens, surfaceTokens: totalTokens, nodes: [] })
    },
    logger: {
      warn: (message) => warnings.push(message),
      info: (message) => messages.push(message)
    }
  };
  engine.dcpConfig = dcp.Config(config ?? {});
  engine.stats = { deduplicationRuns: 0, deduplicationNodes: 0, purgeErrorRuns: 0, purgeErrorNodes: 0, compressions: 0, compressionNodes: 0 };
  engine.ctx.logger.messages = messages;
  return { engine, warnings };
}

/** A session stub: measurement is stubbed, so only the header and seq matter. */
let stubSessionId = 0;
const sessionFor = (header, id = `nudge-${process.pid}-${++stubSessionId}`) => ({ id, header, seq: 0, eventAt: () => undefined, surface: { nodes: [] } });
const eventMessage = (id, role, value) => role === 'assistant'
  ? { type: 'assistant/message', data: { message: { id, role, content: [{ type: 'text', text: value }], source: { kind: 'model', provider: 'p', model: 'm' } } } }
  : { type: 'user/message', data: { id, role, content: [{ type: 'text', text: value }], source: { kind: 'user' } } };
function sessionWith(events, header = {}) {
  const id = `nudge-${process.pid}-${++stubSessionId}`;
  return { id, header, seq: events.length, eventAt: (seq) => events[Number(seq)], snapshotEvents: () => events.map((event, seq) => ({ ...event, seq })), surface: { nodes: events.map((_, index) => index) } };
}
const turnSession = () => sessionWith([eventMessage('assistant-anchor', 'assistant', 'done'), eventMessage('user-anchor', 'user', 'next')]);
const iterationSession = (count = 2) => sessionWith([eventMessage('user-start', 'user', 'go'), ...Array.from({ length: count }, (_, index) => eventMessage(`assistant-${index}`, 'assistant', `step ${index}`))]);

/** An agent stub that records what gets injected. */
function agentSpy() {
  const injected = [];
  return { injected, inject: (message) => injected.push(message) };
}

/* ------------------------------------------------------------------ checks */

console.log('--- the decision table ---');
{
  const { engine } = engineFor({ compress: { minContextLimit: 1000, maxContextLimit: 5000, nudgeFrequency: 5, summaryBuffer: false } }, 500);
  const decision = engine.evaluateNudge(sessionFor({}));
  check('below the floor the reminder is off', decision.level === 'quiet', JSON.stringify(decision));
}
{
  const { engine } = engineFor({ compress: { minContextLimit: 1000, maxContextLimit: 5000, nudgeFrequency: 5, summaryBuffer: false } }, 3000);
  const decision = engine.evaluateNudge(turnSession());
  check('between the thresholds it is a reminder', decision.level === 'reminder', JSON.stringify(decision));
  // Upstream sends TURN_NUDGE in this band (`lib/prompts/turn-nudge.ts`): the model
  // is asked to evaluate the conversation for compressible ranges. A silent
  // reminder was this port's own invention, so the model was never asked.
  check('the reminder carries upstream\'s turn nudge', /Evaluate the conversation for compressible ranges/.test(decision.text ?? ''), (decision.text ?? '').slice(0, 80));
  check('the turn nudge says to keep active context', /Keep active context uncompressed/.test(decision.text ?? ''));
}
{
  const { engine } = engineFor({ compress: { minContextLimit: 1000, maxContextLimit: 5000, nudgeFrequency: 5, summaryBuffer: false } }, 9000);
  const session = sessionWith([eventMessage('context-anchor', 'user', 'go')]);
  const first = engine.evaluateNudge(session);
  check('past the ceiling the first visible anchor receives the reminder', first.level === 'strong' && typeof first.text === 'string', JSON.stringify(first));
  check('the reminder is exact upstream text without port diagnostics', !/Measured /.test(first.text ?? '') && /MAX CONTEXT LIMIT REACHED/.test(first.text ?? ''), (first.text ?? '').slice(0, 90));
  engine.evaluateNudge(session);
  check('the same message is not added as an immediate second anchor', engine.blocksFor(session).nudges.contextAnchors.size === 1);
}

console.log('\n--- nudgeForce picks the addressee, not the wording ---');
{
  // Upstream keeps ONE text per nudge kind and lets `nudgeForce` decide who is
  // addressed (`lib/messages/inject/utils.ts`); the port used to swap the wording
  // instead, so the reminder the model read was not upstream's.
  const { engine } = engineFor({ compress: { maxContextLimit: 100, minContextLimit: 0, nudgeFrequency: 1, nudgeForce: 'strong', summaryBuffer: false } }, 5000);
  const strong = engine.evaluateNudge(sessionFor({}));
  check('strong carries the critical warning', /MAX CONTEXT LIMIT REACHED/.test(strong.text ?? ''), (strong.text ?? '').slice(0, 60));
  check('the critical warning demands compression now', /You MUST use the \`compress\` tool now/.test(strong.text ?? ''));
  const { engine: softEngine } = engineFor({ compress: { maxContextLimit: 100, minContextLimit: 0, nudgeFrequency: 1, nudgeForce: 'soft', summaryBuffer: false } }, 5000);
  const soft = softEngine.evaluateNudge(sessionFor({}));
  check('soft carries the same upstream text', /MAX CONTEXT LIMIT REACHED/.test(soft.text ?? ''), (soft.text ?? '').slice(0, 60));
  check('the two force levels differ only by addressee', (strong.text ?? '').replace(/Measured.*/, '') === (soft.text ?? '').replace(/Measured.*/, ''));
}

console.log('\n--- summaryBuffer ---');
/**
 * One live block carrying a long summary.
 *
 * The shape is the state's, not the old registry's: a block is `active` or not
 * (`deactivated` and `messageSeq` belonged to the surface-node design, where a
 * block WAS a session node), and it is addressed by the message ids it shadows.
 * @param active - whether the block counts toward the ceiling.
 * @returns the stored block.
 */
const liveSummaryBlock = (active) => ({
  blockId: '1',
  topic: 't',
  start: 0,
  end: 0,
  shadowedSeqs: [0],
  summaryChars: 4000,
  summaryTokens: 1000,
  summary: 'x'.repeat(4000),
  anchorMessageId: 'm-1',
  shadowedMessageIds: ['m-1'],
  active
});
{
  // 4000 chars of live summary is ~1000 tokens, so the ceiling moves 5000 -> 6000.
  const { engine } = engineFor({ compress: { minContextLimit: 0, maxContextLimit: 5000, nudgeFrequency: 1, summaryBuffer: true } }, 5500);
  const session = turnSession();
  engine.blocksFor(session);
  engine.registerBlock(liveSummaryBlock(true));
  const decision = engine.evaluateNudge(session);
  check('active summary tokens extend the ceiling', decision.ceiling === 6000, `ceiling=${decision.ceiling}`);
  check('so a measurement that would otherwise be past the ceiling is only a reminder', decision.level === 'reminder', decision.level);
}
{
  const { engine } = engineFor({ compress: { minContextLimit: 0, maxContextLimit: 5000, nudgeFrequency: 1, summaryBuffer: false } }, 5500);
  const session = turnSession();
  engine.blocksFor(session);
  engine.registerBlock(liveSummaryBlock(true));
  const decision = engine.evaluateNudge(session);
  check('with summaryBuffer off the ceiling stays where it was', decision.ceiling === 5000, `ceiling=${decision.ceiling}`);
  check('and the same measurement is now past it', decision.level === 'strong', decision.level);
}
{
  // A decompressed block keeps its text but stops being injected, so it must
  // stop widening the ceiling too: the tokens it saved are no longer saved.
  const { engine } = engineFor({ compress: { minContextLimit: 0, maxContextLimit: 5000, nudgeFrequency: 1, summaryBuffer: true } }, 5500);
  const session = turnSession();
  engine.blocksFor(session);
  engine.registerBlock(liveSummaryBlock(false));
  const decision = engine.evaluateNudge(session);
  check('a deactivated summary stops counting toward the ceiling', decision.ceiling === 5000, `ceiling=${decision.ceiling}`);
}

console.log('\n--- per-model overrides ---');
{
  const { engine } = engineFor({
    compress: {
      minContextLimit: 0,
      maxContextLimit: 5000,
      nudgeFrequency: 1,
      summaryBuffer: false,
      modelMaxLimits: { 'deepseek-official/deepseek-flash': 20000 }
    }
  }, 9000);
  const routed = engine.evaluateNudge(sessionFor({ provider: 'deepseek-official', model: 'deepseek-flash' }));
  check('the routed model uses its own ceiling', routed.ceiling === 20000, `ceiling=${routed.ceiling}`);
  const other = engine.evaluateNudge(sessionFor({ provider: 'other', model: 'model' }));
  check('an unrouted model keeps the global ceiling', other.ceiling === 5000, `ceiling=${other.ceiling}`);
}
{
  const { engine } = engineFor({
    compress: { minContextLimit: 0, maxContextLimit: 5000, nudgeFrequency: 1, summaryBuffer: false, modelMinLimits: { 'p/m': 8000 } }
  }, 6000);
  const decision = engine.evaluateNudge(sessionFor({ provider: 'p', model: 'm' }));
  check('a per-model floor raises the quiet band', decision.level === 'quiet' && decision.floor === 8000, JSON.stringify({ level: decision.level, floor: decision.floor }));
}

console.log('\n--- delivery ---');
{
  const { engine } = engineFor({ compress: { minContextLimit: 0, maxContextLimit: 100, nudgeFrequency: 1, summaryBuffer: false } }, 9000);
  const agent = agentSpy();
  const session = sessionFor({});
  engine.pruneSession(session, agent);
  check('a due reminder is not injected as a fake user message', agent.injected.length === 0, `injected=${agent.injected.length}`);
  check('the reminder is kept for the system prompt', /MAX CONTEXT LIMIT REACHED/.test(engine.lastNudge?.text ?? ''), (engine.lastNudge?.text ?? '').slice(0, 70));
  check('the engine counts what it delivered', engine.nudgeCount === 1, String(engine.nudgeCount));
}
{
  const { engine } = engineFor({ compress: { minContextLimit: 0, maxContextLimit: 100, nudgeFrequency: 1, summaryBuffer: false } }, 9000);
  const session = sessionFor({});
  const decision = engine.evaluateNudge(session);
  check('without an agent the decision is still reported', decision.level === 'strong');
  engine.pruneSession(session, undefined);
  check('a missing agent still counts the system-prompt reminder', engine.nudgeCount === 1, String(engine.nudgeCount));
}
{
  // Upstream delivers THREE nudges; the port used to deliver only the critical
  // one, so the turn nudge and the iteration nudge were computed and discarded —
  // the model was never asked to look for compressible ranges.
  const { engine } = engineFor({ compress: { minContextLimit: 1000, maxContextLimit: 5000, nudgeFrequency: 5, summaryBuffer: false } }, 3000);
  const agent = agentSpy();
  const session = turnSession();
  engine.pruneSession(session, agent);
  check('the turn nudge is delivered, not just computed', engine.nudgeCount === 1 && agent.injected.length === 0, `count=${engine.nudgeCount} injected=${agent.injected.length}`);
  check('what was delivered is upstream\'s turn nudge', /Evaluate the conversation for compressible ranges/.test(engine.lastNudge?.text ?? ''), (engine.lastNudge?.text ?? '').slice(0, 70));
  engine.pruneSession(session, agent);
  check('the identical reminder is not counted twice', engine.nudgeCount === 1, String(engine.nudgeCount));
}
{
  // Upstream keeps the counter and the last-delivered text on `SessionState`, and
  // one engine serves EVERY session in the process. Instance-wide, a second
  // session advanced the first one's `nudgeFrequency` schedule and an identical
  // reminder already delivered in one session suppressed it in another — the model
  // in the second session was simply never told.
  const { engine } = engineFor({ compress: { minContextLimit: 0, maxContextLimit: 100, nudgeFrequency: 3, summaryBuffer: false } }, 9000);
  const first = { id: 'session-a', header: {}, seq: 0, eventAt: () => undefined, surface: { nodes: [] } };
  const second = { id: 'session-b', header: {}, seq: 0, eventAt: () => undefined, surface: { nodes: [] } };
  const firstAgent = agentSpy();
  const secondAgent = agentSpy();

  // Each measurement ADVANCES the counter, so the fixture counts explicitly. Two
  // measurements per session, and then `pruneSession` is the THIRD for that
  // session — a multiple of `nudgeFrequency: 3`, which is when the nudge is due
  // and carries text. The counts are listed rather than derived because the whole
  // point of the case is that they are per session.
  const calls = [
    ['a', engine.evaluateNudge(first)?.calls],
    ['b', engine.evaluateNudge(second)?.calls],
    ['a', engine.evaluateNudge(first)?.calls],
    ['b', engine.evaluateNudge(second)?.calls]
  ];
  check('session A counts 1 then 2', calls[0][1] === 1 && calls[2][1] === 2, JSON.stringify(calls));
  check('session B counts 1 then 2 as well, independently', calls[1][1] === 1 && calls[3][1] === 2, JSON.stringify(calls));

  // The same text delivered to A must NOT suppress it for B: `_lastNudgeText` is
  // per session now, and instance-wide it was the reason a second session's model
  // was never told.
  engine.pruneSession(first, firstAgent);
  engine.pruneSession(second, secondAgent);
  const textA = engine.blocksFor(first).nudges.lastDecision?.text ?? '';
  const textB = engine.blocksFor(second).nudges.lastDecision?.text ?? '';
  check('session A received the due reminder', /MAX CONTEXT LIMIT REACHED/.test(textA) && firstAgent.injected.length === 0, textA.slice(0, 50));
  check('session B received its own copy of the same text', /MAX CONTEXT LIMIT REACHED/.test(textB) && secondAgent.injected.length === 0, textB.slice(0, 50));
  check('and the two deliveries are the same reminder', textA === textB && textA.length > 0, '');
  engine.pruneSession(second, secondAgent);
  check('B does not recount a reminder that is not due', engine.blocksFor(second).nudges.count === 1, String(engine.blocksFor(second).nudges.count));
}
{
  const events = [
    { type: 'user/message', data: { content: [{ type: 'text', text: 'the instruction' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a' }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'b' }] } } }
  ];
  const session = { header: {}, seq: events.length, eventAt: (seq) => events[Number(seq)], surface: { nodes: [0, 1, 2] } };
  const { engine } = engineFor({ compress: { minContextLimit: 100000, maxContextLimit: 200000, iterationNudgeThreshold: 2, summaryBuffer: false } }, 10);
  const agent = agentSpy();
  engine.pruneSession(session, agent);
  check('the iteration nudge obeys the floor', agent.injected.length === 0 && engine.nudgeCount === 0, `injected=${agent.injected.length} count=${engine.nudgeCount}`);
}
{
  const { engine } = engineFor({ compress: { minContextLimit: 1000, maxContextLimit: 5000, nudgeFrequency: 5, summaryBuffer: false } }, 3000);
  const agent = agentSpy();
  engine.pruneSession(sessionFor({}), agent);
  const text = engine.lastNudge?.text ?? '';
  check('the quiet band stays silent', !/MAX CONTEXT LIMIT REACHED/.test(text), text.slice(0, 50));
}

console.log('\n--- the iteration anchor ---');
{
  // Two assistant steps on the surface, no user message after them.
  const events = [
    { type: 'user/message', data: { content: [{ type: 'text', text: 'the instruction' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a' }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'b' }] } } }
  ];
  const session = { header: {}, seq: events.length, eventAt: (seq) => events[Number(seq)], surface: { nodes: [0, 1, 2] } };
  const { engine } = engineFor({ compress: { minContextLimit: 100000, maxContextLimit: 200000, iterationNudgeThreshold: 2, summaryBuffer: false } }, 10);
  const decision = engine.evaluateNudge(session);
  check('a long run below the floor stays quiet', decision.level === 'quiet' && decision.text === undefined, JSON.stringify(decision));
}
{
  const events = [
    { type: 'user/message', data: { content: [{ type: 'text', text: 'the instruction' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a' }] } } }
  ];
  const session = { header: {}, seq: events.length, eventAt: (seq) => events[Number(seq)], surface: { nodes: [0, 1] } };
  const { engine } = engineFor({ compress: { minContextLimit: 100000, maxContextLimit: 200000, iterationNudgeThreshold: 5, summaryBuffer: false } }, 10);
  const decision = engine.evaluateNudge(session);
  check('below the iteration threshold nothing fires', decision.level === 'quiet', JSON.stringify(decision));
}

console.log('\n--- subagent sessions ---');
{
  const { engine } = engineFor({}, 10);
  check('a top-level session is allowed', engine.allowsSession({ header: { delegationDepth: 0 } }) === true);
  check('a delegated session is refused by default', engine.allowsSession({ header: { delegationDepth: 1 } }) === false);
  check('a session with no depth recorded is allowed', engine.allowsSession({ header: {} }) === true);
  const { engine: permissive } = engineFor({ experimental: { allowSubAgents: true } }, 10);
  check('allowSubAgents lifts the refusal', permissive.allowsSession({ header: { delegationDepth: 2 } }) === true);
  const landed = engine.pruneSession({ header: { delegationDepth: 1 }, seq: 0, eventAt: () => undefined, surface: { nodes: [] } }, undefined);
  check('a delegated session lands no replacements', Array.isArray(landed) && landed.length === 0, JSON.stringify(landed));
}

console.log('\n--- custom prompt overrides ---');
{
  // Upstream exposes SIX editable prompts and one internal gate
  // (`lib/prompts/store.ts`); the port used to read a single `policy.md` whose
  // name matched nothing upstream could produce.
  const workspace = mkdtempSync(join(tmpdir(), 'dcp-prompts-'));
  mkdirSync(join(workspace, '.opencode', 'dcp-prompts', 'overrides'), { recursive: true });
  writeFileSync(join(workspace, '.opencode', 'dcp-prompts', 'overrides', 'system.md'), 'MY OWN SYSTEM TEXT\n', 'utf8');
  writeFileSync(join(workspace, '.opencode', 'dcp-prompts', 'overrides', 'turn-nudge.md'), 'MY OWN TURN NUDGE\n', 'utf8');

  const off = engineFor({ experimental: { customPrompts: false } }, 10).engine;
  off.workspaceRoot = workspace;
  check('the override is ignored while the switch is off', off.customPrompt('system') === undefined);

  const on = engineFor({ experimental: { customPrompts: true } }, 10).engine;
  on.workspaceRoot = workspace;
  check('the system prompt override is read and wrapped', on.customPrompt('system') === '<dcp-system-reminder>\nMY OWN SYSTEM TEXT\n</dcp-system-reminder>', JSON.stringify(on.customPrompt('system')));
  check('the turn-nudge override is read and wrapped', on.customPrompt('turnNudge') === '<dcp-system-reminder>\nMY OWN TURN NUDGE\n</dcp-system-reminder>', JSON.stringify(on.customPrompt('turnNudge')));
  check('an overridable prompt with no file uses normalized bundled fallback', /You've been iterating/.test(on.customPrompt('iterationNudge') ?? ''));
  check('a name outside the six editable prompts is refused', on.customPrompt('nothing-here') === undefined);

  // A missing workspace directory must not throw: the override is optional.
  const bare = engineFor({ experimental: { customPrompts: true } }, 10).engine;
  bare.workspaceRoot = join(workspace, 'does-not-exist');
  check('a missing directory is not an error', typeof bare.customPrompt('system') === 'string' || bare.customPrompt('system') === undefined);
  rmSync(workspace, { recursive: true, force: true });
}

console.log('\n--- pruning reports ---');
{
  // The report is driven by synthetic manifest entries so the three levels can
  // be compared directly; `test-dcp-strategies.mjs` covers the pass that
  // produces them. An entry is now ONE PRUNED TOOL OUTPUT — a call id, not a
  // shadowed span — which is what the wording quotes.
  const added = [
    { strategy: 'deduplication', callId: 'c1', tokens: 40, label: 'read → superseded by the identical call c9' },
    { strategy: 'purgeErrors', callId: 'c2', tokens: 0, label: 'bash (errored, older than 4 turn(s))' }
  ];
  const run = (config) => {
    const { engine } = engineFor(config, 10);
    const agent = agentSpy();
    const text = engine._reportPruning(added, agent);
    return { text, injected: agent.injected, logged: engine.ctx.logger.messages };
  };

  const off = run({ pruneNotification: 'off' });
  check('off delivers nothing at all', off.text === undefined && off.injected.length === 0, JSON.stringify(off.text));

  const minimal = run({ pruneNotification: 'minimal' });
  check('minimal is one line', minimal.text === 'Pruned 2 tool output(s).', JSON.stringify(minimal.text));
  check('minimal is UI/log-only, never injected into the model session', minimal.injected.length === 0 && minimal.logged.some((line) => /Pruned 2 tool output/.test(line)));

  const detailed = run({ pruneNotification: 'detailed' });
  check('detailed lists each strategy', /deduplication/.test(detailed.text) && /purgeErrors/.test(detailed.text), JSON.stringify(detailed.text?.split('\n').length));
  check('detailed is not injected as a model turn', detailed.injected.length === 0);
  check('detailed counts the pruned outputs', /Pruned 2 tool output\(s\)/.test(detailed.text), JSON.stringify(detailed.text?.split('\n')[0]));
  check(
    'detailed says the call and its result stay — the user must not think history was rewritten',
    /the call and its result stay/.test(detailed.text),
    ''
  );

  const toast = run({ pruneNotification: 'detailed', pruneNotificationType: 'toast' });
  check('a non-chat report is not injected', toast.injected.length === 0);
  check('a non-chat report goes to the session log', toast.logged.some((line) => /Pruned 2 tool output/.test(line)), JSON.stringify(toast.logged.slice(0, 2)));

  const empty = (() => {
    const { engine } = engineFor({}, 10);
    const agent = agentSpy();
    return { text: engine._reportPruning([], agent), injected: agent.injected.length };
  })();
  check('a pass that pruned nothing says nothing', empty.text === undefined && empty.injected === 0);
}

console.log(`\n${failures.length === 0 ? 'all DCP nudge tests passed' : `${failures.length} failure(s)`}`);
rmSync(stateHome, { recursive: true, force: true });
if (previousDshHome === undefined) delete process.env.DSH_HOME;
else process.env.DSH_HOME = previousDshHome;
if (previousXdgHome === undefined) delete process.env.XDG_CONFIG_HOME;
else process.env.XDG_CONFIG_HOME = previousXdgHome;
if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
else process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
process.exit(failures.length === 0 ? 0 : 1);
