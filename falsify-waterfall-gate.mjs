// Scratch harness for the waterfall gate. Not part of the suite (the runner scans
// `scripts/test-*.mjs`, and this lives in the plugin root under a name it does not match).
//
// It copies `lib/` and the gate into a temp tree, removes `next` from the `agent/pre-step`
// hook, and runs the gate against the mutated copy — which MUST fail. A gate nobody has seen
// fail is not a gate.

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const scratch = join(root, '.suite-state', 'waterfall-falsify');
rmSync(scratch, { recursive: true, force: true });
mkdirSync(join(scratch, 'scripts'), { recursive: true });
cpSync(join(root, 'lib'), join(scratch, 'lib'), { recursive: true });
cpSync(join(root, 'scripts', 'test-waterfall-hooks.mjs'), join(scratch, 'scripts', 'gate.mjs'));

const hook = join(scratch, 'lib', 'dcp.js');
const before = readFileSync(hook, 'utf8');
const after = before
  .replace("ctx.on('agent/pre-step', ({ agent }, next) => {", "ctx.on('agent/pre-step', ({ agent }) => {")
  .replace(/\n\s*return next\(\);/u, '');
writeFileSync(hook, after, 'utf8');
console.log('hook mutated:', before !== after, '| still declares next:', /agent\/pre-step',\s*\(\{\s*agent\s*\}\s*,\s*next/.test(after));

let exit = 0;
let out = '';
try {
  out = execFileSync(process.execPath, [join(scratch, 'scripts', 'gate.mjs')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (error) {
  exit = error.status ?? 1;
  out = `${error.stdout ?? ''}${error.stderr ?? ''}`;
}
const failed = (out.match(/\[FAIL\]/g) ?? []).length;
console.log(`gate exit=${exit} FAIL lines=${failed}`);
for (const line of out.split('\n').filter((text) => text.includes('[FAIL]') || text.includes('FAILURES') || text.includes('continues the chain'))) {
  console.log(`  ${line.trim()}`);
}
console.log(exit !== 0 && failed > 0 ? 'FALSIFIED: the gate fails when the hook loses next()' : 'NOT FALSIFIED: the gate passed a broken hook');
process.exit(exit !== 0 && failed > 0 ? 0 : 1);
