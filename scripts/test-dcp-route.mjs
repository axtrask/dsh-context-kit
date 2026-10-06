/** The optional DCP settings route must enforce Connection trust without making it a mount dependency. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import * as llm from '@deepseek-ai/dsh-llm';
import { SessionStore } from '@deepseek-ai/dsh-session';
import * as plugin from '../lib/dcp-plugin.js';

const home = mkdtempSync(join(tmpdir(), 'dcp-route-'));
process.env.DSH_HOME = home;
process.env.XDG_CONFIG_HOME = join(home, 'xdg');
process.env.OPENCODE_CONFIG_DIR = join(home, 'opencode');

function host() {
  const root = new Context();
  root.provide('settings', { configure: () => undefined });
  root.provide('tools', { register: () => () => undefined });
  root.provide('llm', llm);
  root.provide('tokenMeter', { estimateMessage: () => 1, measure: () => ({ totalTokens: 0, nodes: [] }) });
  new SessionStore(root);
  return root;
}

const headless = host();
const headlessMount = headless.plugin(plugin, {});
await headlessMount.await();
await headlessMount.dispose();
console.log('[ok] headless DCP mounts without route services');

const root = host();
const routes = [];
let rejection;
let trustChecks = 0;
root.provide('webServer', { register: route => {
  routes.push(route);
  return () => routes.splice(routes.indexOf(route), 1);
} });
root.provide('connection', { requestRejection: request => {
  trustChecks += 1;
  assert.ok(request.headers);
  return rejection;
} });
const mount = root.plugin(plugin, {});
await mount.await();
const route = routes.find(candidate => candidate.path === '/ctxkit.dcp');
assert.ok(route, 'DCP route was not registered once both optional services existed');

const server = createServer(route.handler);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const endpoint = `http://127.0.0.1:${server.address().port}/ctxkit.dcp/prompts`;
  const request = rpcId => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method: 'prompts', payload: {} })
  });

  const allowed = await fetch(endpoint, request('allowed'));
  assert.equal(allowed.status, 200);
  const payload = await allowed.json();
  assert.equal(payload.rpcId, 'allowed');
  assert.equal(payload.result.ok, true);
  assert.equal(payload.result.value.liveSettings, true);
  assert.equal(Object.keys(payload.result.value.defaults).length, 6);
  console.log('[ok] trusted POST reaches the DCP route');

  rejection = 403;
  const rejected = await fetch(endpoint, request('rejected'));
  assert.equal(rejected.status, 403);
  assert.equal(await rejected.text(), 'forbidden');
  assert.equal(trustChecks, 2);
  console.log('[ok] rejected POST is stopped by Connection trust');
} finally {
  await new Promise(resolve => server.close(resolve));
  await mount.dispose();
  rmSync(home, { recursive: true, force: true });
}
