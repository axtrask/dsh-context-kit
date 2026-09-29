// Verify that ~/.dsh/dcp.jsonc is actually READ by the plugin and that the editor flag
// arrives in the resolved configuration.
//
// The tempting shortcut — `resolveConfigForTest` — does not prove this: it takes the
// file-level override as an ARGUMENT, so it certifies a pipeline that `apply()` never runs
// unless the file was read first. That is the exact defect shape recorded in
// docs/dcp-port.md 6 ("a test seam that does not run the pipeline it certifies"), and the
// first version of this script fell into it: it printed `{"enabled":false}` while the file
// on disk said `true`.
//
// So this mounts the REAL plugin on a cordis context that provides `dshHome`, which is what
// makes apply() call readConfigFiles, and reads the engine's resolved config afterwards.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const kitRoot = join(here, '..');
const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh');

const path = join(home, 'dcp.jsonc');
console.log(`config file: ${path}`);
console.log(readFileSync(path, 'utf8').split('\n').filter((line) => !line.trim().startsWith('//')).join('\n').trim());

const { Context } = await import('@deepseek-ai/cordis');
const llm = await import('@deepseek-ai/dsh-llm');
const dcp = await import(pathToFileURL(join(kitRoot, 'lib', 'dcp.js')).href);

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
context.provide('tokenMeter', { estimateMessage: () => 1, measure: () => ({ nodes: [] }) });
// THIS is what makes readConfigFiles run. Without it the plugin resolves defaults and the
// file below is never opened.
context.provide('dshHome', home);
context.plugin(dcp, {});
await new Promise((resolve) => setTimeout(resolve, 400));

const engine = dcp.engineForTest?.();
const resolved = engine?.dcpConfig;
console.log('\nengine resolved config:');
console.log('  editor        :', JSON.stringify(resolved?.editor));
console.log('  commands      :', JSON.stringify(resolved?.commands));
console.log('  warnings      :', JSON.stringify(warnings));
console.log(
  resolved?.editor?.enabled === true
    ? '\nRESULT: the file IS read and the editor is ON'
    : '\nRESULT: the editor is still OFF — the file was not read'
);
process.exitCode = resolved?.editor?.enabled === true ? 0 : 1;
