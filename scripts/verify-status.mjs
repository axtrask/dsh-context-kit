/**
 * Exercise the `/dcp` STATUS RENDERER in isolation.
 *
 * `verify-activation.mjs` proves the plugin mounts; it never INVOKES the
 * commands it registers, so a defect inside the status path only shows up when
 * a human types `/dcp`. This drives the registered handler against a fake
 * session and prints whatever it produces — or the exact throw.
 *
 * Run:  node scripts/verify-status.mjs
 *
 * @module dsh-context-kit/scripts/verify-status
 */

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const kitRoot = join(here, '..');

const { Context } = await import('@deepseek-ai/cordis');

/* ------------------------------------------------------------- fake session */

let nextSeq = 0;
const event = (type, data, surfaceOp = 'append') => ({ type, seq: nextSeq++, time: Date.now(), data, surfaceOp });

const call = (id, name, args) => ({
  type: 'tool-call',
  id,
  name,
  arguments: JSON.stringify(args)
});

function fakeSession() {
  nextSeq = 0;
  const log = [
    event('turn/start', { turn: 1 }, undefined),
    event('system/message', { turn: 1, step: 1, message: { id: 's1', role: 'system', content: [{ type: 'text', text: 'sys' }], source: { kind: 'system-prompt' } } }),
    event('user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }),
    event('assistant/message', { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [call('c1', 'read', { filePath: 'a.js' })], source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [] }),
    event('tool/result', { turn: 1, step: 1, message: { id: 'r1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }], source: { kind: 'tool', callId: 'c1' } } })
  ];
  // Turn boundary events carry no surfaceOp; strip the marker the helper added.
  for (const item of log) if (item.type === 'turn/start') delete item.surfaceOp;
  const bySeq = new Map(log.map((item) => [item.seq, item]));
  const surfaceTypes = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result']);
  return {
    seq: log.length,
    surface: { nodes: log.filter((item) => surfaceTypes.has(item.type)).map((item) => item.seq), replaceGeneration: 0 },
    eventAt: (seq) => bySeq.get(seq),
    deriveEventMessage(item) {
      if (item.type === 'assistant/message') return item.data.message.content.length === 0 ? null : item.data.message;
      if (item.type === 'user/message') return item.data;
      if (item.type === 'tool/result') return item.data.message;
      return null;
    }
  };
}

/* ------------------------------------------------------------ mount + invoke */

const registered = new Map();
const commands = new Map();
const root = new Context();
root.provide('tools', { register: (definition) => { registered.set(definition.name, definition); return () => {}; } });
root.provide('commands', { register: (definition) => { commands.set(definition.name, definition); return () => {}; } });
root.provide('llm', { resolveModelInfo: async () => ({ context: { contextWindow: 128000 } }) });
root.provide('tokenMeter', { measure: () => ({ nodes: [], totalTokens: 0 }), estimateMessage: () => 0 });

const dcp = await import(pathToFileURL(join(kitRoot, 'lib', 'dcp.js')).href);
root.plugin(dcp, {});
await new Promise((resolve) => setTimeout(resolve, 150));

console.log(`tools registered:    ${[...registered.keys()].join(', ') || '(none)'}`);
console.log(`commands registered: ${[...commands.keys()].join(', ') || '(none)'}`);
console.log(`ctx.compaction:      ${root.get('compaction') === undefined ? 'MISSING' : 'present'}`);

const session = fakeSession();
const injected = [];
let failures = 0;

for (const [name, definition] of commands) {
  try {
    const result = await definition.handler({
      commandId: 'cmd-1',
      agent: {
        session,
        id: 'session-fake',
        // `/dcp-compress` queues a compression pass by injecting a message.
        inject: (message) => injected.push(message)
      },
      rawInput: '',
      attachments: [],
      signal: new AbortController().signal
    });
    const text = typeof result?.text === 'string' ? result.text : JSON.stringify(result);
    console.log(`\n/${name} handler -> ${result?.kind ?? '?'}\n${text}`);
  } catch (error) {
    failures += 1;
    console.log(`\n[FAIL] /${name} threw:\n${error?.stack ?? String(error)}`);
  }
}

if (injected.length > 0) {
  const text = injected[0]?.content?.map((block) => block.text ?? '').join('');
  console.log(`\n/dcp-compress injected ${injected.length} message(s); queued text:\n${text}`);
  if (typeof text !== 'string' || !text.includes('compression pass')) {
    failures += 1;
    console.log('[FAIL] the injected message does not look like a compression request');
  }
}

console.log(`\n${failures === 0 ? 'status path OK' : `${failures} command(s) threw`}`);
process.exit(failures === 0 ? 0 : 1);
