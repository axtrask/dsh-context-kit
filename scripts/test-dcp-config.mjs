/**
 * Configuration must accept upstream's documented shapes and must never take the
 * plugin down.
 *
 * Two upstream facts drive every check here:
 *
 * 1. A DSH preset loads `lib/dcp.js` by absolute path through Cordis. An
 *    exception inside `apply()` fails the whole loader entry
 *    (`cordis-plugin-loader/lib/index.js:458,488`), and this ONE module registers
 *    both DCP's `compress` and context-mode's ten `ctx_*` tools — so a typo in a
 *    single config line would silently remove eleven tools. Degrading to
 *    "defaults plus a warning" is therefore a requirement, not politeness.
 * 2. Upstream's config accepts three shapes this port originally rejected:
 *    `manualMode` as an object (`lib/config.ts:65`), `compress.permission:
 *    "ask"` (`:7,516`, where only `deny` suppresses the tool —
 *    `lib/compress/pipeline.ts:44-48`), and limits as `number | "${number}%"`
 *    (`:20-21`) resolved against the model's context window
 *    (`lib/messages/inject/utils.ts:94-129`).
 *
 * Run:  node scripts/test-dcp-config.mjs
 *
 * @module dsh-context-kit/scripts/test-dcp-config
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const kitRoot = join(here, '..');

const failures = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '[ok]  ' : '[FAIL]'} ${label}${detail.length > 0 ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const { Context } = await import('@deepseek-ai/cordis');
const dcp = await import(pathToFileURL(join(kitRoot, 'lib', 'dcp.js')).href);
const { Config, parseLimitForTest, resolveConfigForTest } = dcp;
const silent = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} };
/** Resolve a document through the real pipeline: validate, fold, or recover. */
const resolve = (row, file = {}, logger = silent) => resolveConfigForTest(row, file, logger);

/** Run real apply calls with disposable Cordis scopes and no live config paths. */
async function withConfigFiles(run) {
  const suite = join(kitRoot, '.suite-state');
  mkdirSync(suite, { recursive: true });
  const root = mkdtempSync(join(suite, 'dcp-config-'));
  const paths = {
    custom: join(root, 'custom'),
    xdg: join(root, 'xdg', 'opencode'),
    osHome: join(root, 'os-home'),
    osHomeOpencode: join(root, 'os-home', '.config', 'opencode'),
    home: join(root, 'home'),
    fallback: root,
    workspace: join(root, 'workspace'),
    workspaceDsh: join(root, 'workspace', '.dsh'),
    workspaceOpencode: join(root, 'workspace', '.opencode')
  };
  const environmentKeys = ['DSH_HOME', 'XDG_CONFIG_HOME', 'OPENCODE_CONFIG_DIR', 'HOME', 'USERPROFILE'];
  const previous = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  const scopes = [];
  try {
    for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
    Object.assign(process.env, {
      DSH_HOME: paths.fallback,
      XDG_CONFIG_HOME: dirname(paths.xdg),
      OPENCODE_CONFIG_DIR: paths.custom,
      HOME: paths.osHome,
      USERPROFILE: paths.osHome
    });
    const mount = async (rowConfig = {}, provideHome = true) => {
      const context = new Context();
      const warnings = [];
      const infos = [];
      const logger = { ...silent, warn: (line) => warnings.push(line), info: (line) => infos.push(line) };
      context.provide('tools', { register: () => () => {} });
      context.provide('llm', {});
      context.provide('tokenMeter', { estimateMessage: () => 0, measure: () => ({ nodes: [] }) });
      context.provide('workspace', { root: paths.workspace });
      if (provideHome) context.provide('dshHome', paths.home);
      let engine;
      let error;
      const scope = context.plugin({
        apply(ctx) {
          try {
            dcp.apply(ctx.extend({ logger }), rowConfig);
            engine = dcp.engineForTest();
          } catch (caught) {
            error = caught;
          }
        }
      });
      scopes.push(scope);
      await scope;
      return { engine, config: engine?.dcpConfig, basic: engine?.config, error, warnings, infos, homeService: context.get('dshHome') };
    };
    await run({ paths, mount });
  } finally {
    for (const scope of scopes.reverse()) await scope.dispose();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('\n--- upstream document shapes must validate ---');
{
  const upstreamDocument = {
    $schema: 'https://example.invalid/dcp.schema.json',
    manualMode: { enabled: true, automaticStrategies: true },
    compress: {
      permission: 'ask',
      maxContextLimit: '50%',
      minContextLimit: '20%',
      modelMaxLimits: { 'openai/gpt-4o': '30%' },
      modelMinLimits: { 'openai/gpt-4o': '10%' }
    },
    turnProtection: { enabled: true, turns: 4 },
    commands: { enabled: true, protectedTools: ['task', 'skill'] },
    strategies: { deduplication: { enabled: true }, purgeErrors: { enabled: true, turns: 4 } }
  };
  // The schema accepts it — an upstream document is not a validation error.
  let schemaThrew;
  try {
    Config(upstreamDocument);
  } catch (error) {
    schemaThrew = error;
  }
  check('an upstream-shaped document passes the schema', schemaThrew === undefined, schemaThrew?.message ?? '');

  // The pipeline returns the canonical form every consumer downstream reads.
  const value = resolve(upstreamDocument);
  check('manualMode object folds to enabled=true', value.manualMode === true, JSON.stringify(value.manualMode));
  check('automaticStrategies comes from the object', value.automaticStrategies === true, JSON.stringify(value.automaticStrategies));
  // Upstream accepts "ask" but never branches on it: `lib/compress/pipeline.ts`
  // turns any non-`deny` value into `"compress"`, and only `"deny"` suppresses
  // the tool (`index.ts:82,91,97`). Accepting it as "allow" is therefore the same
  // observable behaviour, and the point is that a document carrying it LOADS.
  check('permission "ask" is normalized to the behaviour it has upstream', value.compress.permission === 'allow', JSON.stringify(value.compress.permission));
  check('permission "deny" still suppresses the tool', resolve({ compress: { permission: 'deny' } }).compress.permission === 'deny');
  check('percent limits survive validation', value.compress.maxContextLimit === '50%', JSON.stringify(value.compress.maxContextLimit));
  check('per-model percent limits survive', value.compress.modelMaxLimits['openai/gpt-4o'] === '30%', JSON.stringify(value.compress.modelMaxLimits));
  check('the protected tools list arrives', value.commands.protectedTools.join(',') === 'task,skill', JSON.stringify(value.commands.protectedTools));
}
{
  const off = resolve({ manualMode: { enabled: false, automaticStrategies: false } });
  check('manualMode object folds to enabled=false', off.manualMode === false, JSON.stringify(off.manualMode));
  check('automaticStrategies false from the object', off.automaticStrategies === false, JSON.stringify(off.automaticStrategies));
  check('a plain boolean still works', resolve({ manualMode: true }).manualMode === true);
}

console.log('\n--- the shipped compress limits are upstream\u2019s ---');
{
  // upstream `lib/config.ts:684-685`: `maxContextLimit: 100000`,
  // `minContextLimit: 50000`. The floor is the quiet band that suppresses the
  // iteration nudge, so reading it as `undefined` — which is what a schema with
  // no default does — silently disables a documented feature for every user who
  // never set it.
  const plain = resolve({});
  check('model-facing DCP context status defaults off', plain.includeContextStatus === false, JSON.stringify(plain.includeContextStatus));
  check('model-facing DCP context status can be enabled explicitly', resolve({ includeContextStatus: true }).includeContextStatus === true);
  check('the DCP file layer can enable model-facing context status', resolve({}, { includeContextStatus: true }).includeContextStatus === true);
  check('compress.maxContextLimit defaults to 100000', plain.compress.maxContextLimit === 100000, JSON.stringify(plain.compress.maxContextLimit));
  check('compress.minContextLimit defaults to 50000', plain.compress.minContextLimit === 50000, JSON.stringify(plain.compress.minContextLimit));
  check('range/allow/show/summary-buffer defaults match upstream', plain.compress.mode === 'range' && plain.compress.permission === 'allow' && plain.compress.showCompression === false && plain.compress.summaryBuffer === true, JSON.stringify(plain.compress));
  check('nudge defaults match upstream', plain.compress.nudgeFrequency === 5 && plain.compress.iterationNudgeThreshold === 15 && plain.compress.nudgeForce === 'soft');
  check('turn protection and subagents default off', plain.turnProtection.enabled === false && plain.turnProtection.turns === 4 && plain.experimental.allowSubAgents === false);
  check('automatic strategy defaults have empty protectedTools', plain.strategies.deduplication.enabled === true && plain.strategies.deduplication.protectedTools.length === 0 && plain.strategies.purgeErrors.enabled === true && plain.strategies.purgeErrors.turns === 4 && plain.strategies.purgeErrors.protectedTools.length === 0, JSON.stringify(plain.strategies));
  check('compress protected defaults are the mapped upstream list', JSON.stringify(plain.compress.protectedTools) === JSON.stringify(['subagent', 'subagent_fork', 'skill', 'todo_write', 'todo_read']), JSON.stringify(plain.compress.protectedTools));
  check('command protected defaults are the mapped upstream list', JSON.stringify(plain.commands.protectedTools) === JSON.stringify(['subagent', 'subagent_fork', 'skill', 'todo_write', 'todo_read', 'compress', 'workflow', 'ralph', 'exit_plan_mode', 'edit', 'write']), JSON.stringify(plain.commands.protectedTools));
  check('deprecated top-level nudge defaults are gone', !Object.hasOwn(plain, 'nudgeFrequency') && !Object.hasOwn(plain, 'iterationNudgeThreshold'));

  // The deprecated top-level aliases are CARRIED OVER, not ignored — and they are
  // removed from the row, so the compress default can never shadow the value the
  // user actually wrote.
  const warnings = [];
  const carried = resolve({ maxContextLimit: 70000 }, {}, { warn: (line) => warnings.push(line), info: () => {}, error: () => {}, debug: () => {} });
  check('a top-level maxContextLimit is carried onto compress', carried.compress.maxContextLimit === 70000, JSON.stringify(carried.compress.maxContextLimit));
  check('the carried value is not shadowed by the new default', carried.compress.minContextLimit === 50000, JSON.stringify(carried.compress.minContextLimit));
  check('the deprecation is reported', warnings.some((line) => line.includes('deprecated')), JSON.stringify(warnings));

  // Both spellings: `compress` wins, and the user is TOLD that the alias lost.
  const both = [];
  const merged = resolve({ maxContextLimit: 70000, compress: { maxContextLimit: 42000 } }, {}, { warn: (line) => both.push(line), info: () => {}, error: () => {}, debug: () => {} });
  check('an explicit compress.maxContextLimit wins over the alias', merged.compress.maxContextLimit === 42000, JSON.stringify(merged.compress.maxContextLimit));
  check('the ignored alias is reported rather than obeyed', both.some((line) => line.includes('was ignored')), JSON.stringify(both));

  // And the alias works when it arrives from the FILE layer, which is the layer a
  // `dcp.jsonc` written against the older shape actually uses.
  const fromFile = resolve({}, { minContextLimit: 30000 });
  check('the alias works from the file layer too', fromFile.compress.minContextLimit === 30000, JSON.stringify(fromFile.compress.minContextLimit));
  const fileWins = resolve({}, { maxContextLimit: 90000, compress: { maxContextLimit: 11000 } });
  check('the file layer resolves the conflict the same way', fileWins.compress.maxContextLimit === 11000, JSON.stringify(fileWins.compress.maxContextLimit));
}

console.log('\n--- percent arithmetic must match upstream exactly ---');
{
  // upstream: round the percent, clamp 0..100, scale by the window, round again
  // (`lib/messages/inject/utils.ts:107-114`).
  const window = 1_000_000;
  check('50% of 1 000 000', parseLimitForTest('50%', window) === 500_000, String(parseLimitForTest('50%', window)));
  check('20% of 1 000 000', parseLimitForTest('20%', window) === 200_000, String(parseLimitForTest('20%', window)));
  check('a percentage rounds before scaling (33.7% -> 34%)', parseLimitForTest('33.7%', window) === 340_000, String(parseLimitForTest('33.7%', window)));
  check('above 100% clamps', parseLimitForTest('150%', window) === 1_000_000, String(parseLimitForTest('150%', window)));
  check('below 0% clamps', parseLimitForTest('-5%', window) === 0, String(parseLimitForTest('-5%', window)));
  check('a plain number is itself', parseLimitForTest(42_000, window) === 42_000, String(parseLimitForTest(42_000, window)));
  check('a percent with no known window is unresolvable', parseLimitForTest('50%', undefined) === undefined);
  check('garbage is unresolvable', parseLimitForTest('half', window) === undefined);
  check('a percent resolves against a non-round window', parseLimitForTest('15%', 262_144) === Math.round(0.15 * 262_144), String(parseLimitForTest('15%', 262_144)));
}

console.log('\n--- a broken config degrades instead of failing the plugin ---');
await withConfigFiles(async ({ paths, mount }) => {
  // `enabled` is genuinely wrong: a string where a boolean belongs. Recovery must
  // drop THAT key and keep the rest.
  const source = join(paths.home, 'dcp.jsonc');
  const contents = JSON.stringify({
    enabled: 'yes please',
    compress: { maxContextLimit: 42000 },
    unknownSetting: true
  });
  writeFileSync(source, contents, 'utf8');
  const { config: resolved, error: threw, warnings, infos } = await mount();
  check('a bad value does not throw out of config resolution', threw === undefined, threw?.message ?? '');
  check('the bad key was reported', warnings.some((w) => w.includes('"enabled"')), warnings.join(' | ').slice(0, 160));
  check('the plugin still resolves a usable config', resolved !== undefined && typeof resolved.compress === 'object');
  check('the good SIBLING KEY of the bad one survived', resolved?.compress?.maxContextLimit === 42000, JSON.stringify(resolved?.compress?.maxContextLimit));
  check('the dropped key falls back to its default', resolved?.enabled === true, JSON.stringify(resolved?.enabled));
  check('apply reports the file that required recovery', infos.includes(`dcp: configuration files applied: ${source}`), JSON.stringify(infos));
  check('an unknown key warning names its source and key', warnings.includes(`dcp: ${source} sets unknown key "unknownSetting"; ignoring it`), JSON.stringify(warnings));
  check('recovery does not rewrite the config file', readFileSync(source, 'utf8') === contents);
});
await withConfigFiles(async ({ paths, mount }) => {
  writeFileSync(join(paths.home, 'dcp.json'), JSON.stringify({
    compress: { mode: 'sideways', permission: 'maybe', maxContextLimit: 77777 }
  }), 'utf8');
  const { config: resolved, error: threw, warnings } = await mount();
  check('two bad keys in one section still do not throw', threw === undefined, threw?.message ?? '');
  check('both bad keys were reported', warnings.filter((w) => w.includes('ignoring configuration key')).length >= 2, warnings.join(' | ').slice(0, 200));
  check('the GOOD key beside two bad ones survived', resolved?.compress?.maxContextLimit === 77777, JSON.stringify(resolved?.compress?.maxContextLimit));
  check('nested recovery restores only the invalid fields', resolved?.compress?.mode === 'range' && resolved?.compress?.permission === 'allow');
});

console.log('\n--- OpenCode-owned config files cannot influence DSH ---');
await withConfigFiles(async ({ paths, mount }) => {
  const row = {
    compress: { permission: 'allow', maxContextLimit: 87654 },
    experimental: { customPrompts: true },
    prompts: { system: 'DSH-INLINE-PROMPT' }
  };
  const directories = [paths.custom, paths.xdg, paths.workspaceOpencode];
  let fixture = 0;
  for (const directory of directories) {
    for (const filename of ['dcp.jsonc', 'dcp.json']) {
      fixture += 1;
      const source = join(directory, filename);
      writeFileSync(source, JSON.stringify({
        compress: { permission: 'deny', maxContextLimit: 1000 + fixture },
        experimental: { customPrompts: false },
        prompts: { system: `OPENCODE-PROMPT-${fixture}` }
      }), 'utf8');
      const { config, error, infos, warnings } = await mount(row);
      const label = `${Object.keys(paths).find((key) => paths[key] === directory)}/${filename}`;
      check(`${label} is ignored`, error === undefined
        && config?.compress?.permission === 'allow'
        && config?.compress?.maxContextLimit === 87654
        && config?.experimental?.customPrompts === true
        && config?.prompts?.system === 'DSH-INLINE-PROMPT', error?.message ?? JSON.stringify(config));
      check(`${label} is absent from applied sources and warnings`, infos.length === 0 && warnings.length === 0, JSON.stringify({ infos, warnings }));
    }
  }
});
await withConfigFiles(async ({ paths, mount }) => {
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.OPENCODE_CONFIG_DIR;
  const row = { compress: { permission: 'allow', maxContextLimit: 76543 } };
  for (const filename of ['dcp.jsonc', 'dcp.json']) {
    const source = join(paths.osHomeOpencode, filename);
    writeFileSync(source, JSON.stringify({ compress: { permission: 'deny', maxContextLimit: 1 } }), 'utf8');
    const { config, error, infos, warnings } = await mount(row);
    check(`home .config/opencode/${filename} is ignored`, error === undefined
      && config?.compress?.permission === 'allow'
      && config?.compress?.maxContextLimit === 76543
      && infos.length === 0
      && warnings.length === 0, error?.message ?? JSON.stringify({ config, infos, warnings }));
  }
});

console.log('\n--- DSH-owned files follow DSH precedence and shallow layering ---');
await withConfigFiles(async ({ paths, mount }) => {
  const row = {
    compress: { maxContextLimit: 90000, minContextLimit: 2200, summaryBuffer: false },
    strategies: { deduplication: { protectedTools: ['row-tool'] }, purgeErrors: { turns: 8 } }
  };
  const before = JSON.stringify(row);
  const sources = [];
  const directories = [paths.home, paths.workspaceDsh];
  for (const directory of directories) {
    for (const filename of ['dcp.jsonc', 'dcp.json']) {
      const limit = 10000 + sources.length * 1000;
      const document = { compress: { maxContextLimit: limit } };
      if (sources.length === 0) {
        document.compress.minContextLimit = 1100;
        document.pruneNotification = 'off';
        document.strategies = { deduplication: { enabled: false }, purgeErrors: { turns: 9 } };
      } else if (sources.length === 1) {
        document.strategies = { purgeErrors: { turns: 6 } };
      }
      const source = join(directory, filename);
      const contents = JSON.stringify(document, null, 2);
      writeFileSync(source, filename.endsWith('jsonc') ? `// config fixture\n${contents.slice(0, -1)},\n}\n` : contents, 'utf8');
      sources.push(source);
      const { config, error, infos, warnings } = await mount(row);
      const label = `${Object.keys(paths).find((key) => paths[key] === directory)}/${filename}`;
      check(`${label} loads through apply`, error === undefined && config?.compress?.maxContextLimit === limit, error?.message ?? JSON.stringify(config?.compress?.maxContextLimit));
      check(`${label} reports all DSH sources in load order`, infos.length === 1 && infos[0] === `dcp: configuration files applied: ${sources.join(', ')}`, JSON.stringify(infos));
      check(`${label} has no config warnings`, warnings.length === 0, JSON.stringify(warnings));
      if (sources.length === 2) {
        check('later DSH file sections replace earlier sections, not deep-merge them', config?.compress?.minContextLimit === 2200 && config?.strategies?.deduplication?.enabled === true);
        check('the remaining DSH file section still merges with the preset row', config?.compress?.summaryBuffer === false && config?.strategies?.purgeErrors?.turns === 6 && config?.strategies?.deduplication?.protectedTools?.join(',') === 'row-tool');
      }
      check(`${label} preserves unrelated earlier top-level settings`, config?.pruneNotification === 'off');
    }
  }
  check('repeated real apply calls do not mutate the preset row', JSON.stringify(row) === before);
});

console.log('\n--- missing, malformed, and nonobject files cannot displace a valid layer ---');
await withConfigFiles(async ({ paths, mount }) => {
  const empty = await mount();
  check('missing files leave a working default config', empty.error === undefined && empty.config?.compress?.maxContextLimit === 100000);
  check('missing files are neither reported nor warned about', empty.infos.length === 0 && empty.warnings.length === 0);
  check('editor defaults remain opt-in and idle-only', empty.config?.editor?.enabled === false && empty.config?.editor?.requireIdle === true);
  const source = join(paths.home, 'dcp.jsonc');
  const rejected = join(paths.workspaceDsh, 'dcp.json');
  writeFileSync(source, JSON.stringify({ compress: { maxContextLimit: 24680 } }), 'utf8');
  for (const [label, contents, nonobject] of [
    ['malformed', '{"compress":', false],
    ['empty', '', false],
    ['array', '[]', true],
    ['null', 'null', true],
    ['number', '42', true],
    ['string', '"not a config"', true],
    ['boolean', 'false', true],
    ['empty object', '{}', false]
  ]) {
    writeFileSync(rejected, contents, 'utf8');
    const { config, error, infos, warnings } = await mount();
    check(`${label} file leaves the valid lower-priority setting intact`, error === undefined && config?.compress?.maxContextLimit === 24680, error?.message ?? '');
    check(`${label} file is absent from applied sources`, infos.length === 1 && infos[0] === `dcp: configuration files applied: ${source}`, JSON.stringify(infos));
    // Malformed JSON is currently silent in this port; do not require that omission.
    if (nonobject) check(`${label} file warns with its path`, warnings.includes(`dcp: ${rejected} must contain a JSON object; ignoring it`), JSON.stringify(warnings));
  }
});

console.log('\n--- real apply uses DSH_HOME without a dshHome service ---');
await withConfigFiles(async ({ paths, mount }) => {
  const source = join(paths.fallback, 'dcp.jsonc');
  writeFileSync(source, JSON.stringify({
    manualMode: { enabled: true, automaticStrategies: false },
    compress: { permission: 'ask', maxContextLimit: 65432 },
    editor: { enabled: true }
  }), 'utf8');
  const row = { thresholdRatio: 0.72, retainTokens: 800, auto: false, compress: { summaryBuffer: false } };
  const before = JSON.stringify(row);
  const { engine, config, basic, error, homeService, infos } = await mount(row, false);
  check('the fallback fixture really has no dshHome service', homeService === undefined);
  check('apply reads DSH_HOME instead of silently using defaults', error === undefined && config?.compress?.maxContextLimit === 65432 && config?.editor?.enabled === true, error?.message ?? JSON.stringify(config?.compress));
  check('the fallback home file is reported as applied', infos.length === 1 && infos[0] === `dcp: configuration files applied: ${source}`, JSON.stringify(infos));
  check('real file shapes normalize before reaching the engine', config?.manualMode === true && config?.automaticStrategies === false && config?.compress?.permission === 'allow');
  check('semantic config stays separate from the backend config', engine !== undefined && config !== basic && basic?.thresholdRatio === 0.72 && basic?.retainTokens === 800 && basic?.auto === false);
  check('the backend is not given DCP-only sections', basic !== undefined && !('compress' in basic) && !('editor' in basic) && !('manualMode' in basic));
  check('file loading preserves valid preset siblings and the input row', config?.compress?.summaryBuffer === false && JSON.stringify(row) === before);
  const serviceSource = join(paths.home, 'dcp.jsonc');
  writeFileSync(serviceSource, JSON.stringify({ compress: { maxContextLimit: 34567 } }), 'utf8');
  const service = await mount();
  check('an explicit dshHome service takes priority over DSH_HOME', service.error === undefined && service.config?.compress?.maxContextLimit === 34567 && service.infos[0] === `dcp: configuration files applied: ${serviceSource}`);
});

console.log('\n--- migration and recovery leave input documents alone ---');
await withConfigFiles(async ({ paths, mount }) => {
  // A recognized key makes this a contributing file; legacy-only detection is separate work.
  writeFileSync(join(paths.home, 'dcp.jsonc'), JSON.stringify({ enabled: true, minContextLimit: 31000 }), 'utf8');
  const row = { manualMode: { enabled: true, automaticStrategies: false } };
  const before = JSON.stringify(row);
  const { config, error, warnings } = await mount(row);
  check('a real file alias migrates before schema defaults', error === undefined && config?.compress?.minContextLimit === 31000 && config?.compress?.maxContextLimit === 100000, error?.message ?? JSON.stringify(config?.compress));
  check('real file migration reports deprecation', warnings.some((line) => line.includes('deprecated')), JSON.stringify(warnings));
  check('real migration and normalization do not mutate the row', JSON.stringify(row) === before);
});
{
  const row = { manualMode: { enabled: true, automaticStrategies: false }, maxContextLimit: 72000 };
  const file = { compress: { mode: 'sideways', permission: 'ask', modelMaxLimits: { 'p/m': '30%', invalid: {} } } };
  const before = JSON.stringify({ row, file });
  const resolved = resolve(row, file);
  check('normalization and nested recovery preserve both input objects', JSON.stringify({ row, file }) === before);
  check('normalization and recovery still produce usable values', resolved.manualMode === true && resolved.automaticStrategies === false && resolved.compress.mode === 'range' && resolved.compress.permission === 'allow' && resolved.compress.modelMaxLimits['p/m'] === '30%');
}

console.log('\n--- per-model limits beat the global one, as upstream orders them ---');
{
  const resolved = resolveConfigForTest({}, {
    compress: { maxContextLimit: 100000, modelMaxLimits: { 'deepseek-official/deepseek-flash': 500000 } }
  }, { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} });
  check('the per-model override is stored', resolved.compress.modelMaxLimits['deepseek-official/deepseek-flash'] === 500000);
}

console.log('\n--- the extracted module is independent and preserves the plugin surface ---');
{
  const configuration = await import(pathToFileURL(join(kitRoot, 'lib', 'dcp-config.js')).href);
  const expectedExports = [
    'Config', 'DEFAULT_COMPRESS_PROTECTED_TOOLS', 'DEFAULT_PROTECTED_TOOLS',
    'DCP_WIRE_STATUS_LABEL', 'DCP_WIRE_STATUS_MAX_CHARS', 'DcpCompactionEngine',
    'apply', 'engineForTest', 'finalizeDcpWireContext', 'inject', 'installDcpAddon', 'manualModeForTest',
    'name', 'parseLimitForTest', 'resolveConfigForTest', 'stripDcpWireStatuses'
  ];
  check('the dcp entry retains its legacy exports and exposes the independent addon installer', JSON.stringify(Object.keys(dcp).sort()) === JSON.stringify(expectedExports.sort()));
  check('Config is the same schema object at both import paths', Config === configuration.Config);
  check('configuration test aliases are direct re-exports', ['manualModeForTest', 'parseLimitForTest', 'resolveConfigForTest'].every((key) => dcp[key] === configuration[key]));

  const row = { thresholdRatio: 0.72, retainTokens: 800, auto: false, maxContextLimit: 72000, manualMode: { enabled: true, automaticStrategies: false } };
  const file = { retainTokens: 1200, compress: { permission: 'ask', minContextLimit: 2300 } };
  const before = JSON.stringify({ row, file });
  const migrated = configuration.migrateLegacyLimits(row, file, silent);
  const result = configuration.resolveConfiguration(migrated, file, silent);
  check('the internal resolver returns both semantic and basic results', Object.keys(result).sort().join(',') === 'basic,semantic' && result.semantic !== result.basic);
  check('the semantic result includes migrated and normalized settings', result.semantic.compress.maxContextLimit === 72000 && result.semantic.compress.minContextLimit === 2300 && result.semantic.compress.permission === 'allow' && result.semantic.manualMode === true && result.semantic.automaticStrategies === false);
  check('basic results inherit row settings and accept file overrides only for parent keys', Object.keys(result.basic).sort().join(',') === 'auto,retainTokens,thresholdRatio' && result.basic.thresholdRatio === 0.72 && result.basic.retainTokens === 1200 && result.basic.auto === false);
  check('direct module resolution preserves both input documents', JSON.stringify({ row, file }) === before);
  check('the old resolver alias returns the same semantic result', JSON.stringify(resolve(row, file)) === JSON.stringify(result.semantic));
  check('no file layer still returns a separate basic subset', Object.keys(configuration.resolveConfiguration({}, undefined, silent).basic).length === 0);
  check('the moved per-model limit resolver overrides and falls back correctly', configuration.compressLimitFor(100000, { 'p/m': '30%' }, 'p/m', 1000000) === 300000 && configuration.compressLimitFor(100000, { 'p/m': '30%' }, 'other/m', 1000000) === 100000);
}
await withConfigFiles(async ({ paths }) => {
  // A fresh process prevents an already cached dcp.js import from hiding a cycle.
  const entry = pathToFileURL(join(kitRoot, 'lib', 'dcp-config.js')).href;
  const blocked = ['dcp.js', 'index.js'].map((file) => pathToFileURL(join(kitRoot, 'lib', file)).href);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { registerHooks, syncBuiltinESMExports } from 'node:module';
    const blocked = ${JSON.stringify(blocked)};
    registerHooks({ resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      if (blocked.includes(resolved.url) || specifier.startsWith('@deepseek-ai/dsh-compaction')) {
        throw new Error('Configuration imported plugin wiring or a compaction engine');
      }
      return resolved;
    } });
    const reads = [];
    for (const key of ['existsSync', 'readFileSync']) {
      const original = fs[key];
      fs[key] = (path, ...args) => {
        if (/dcp\\.jsonc?$/.test(String(path))) reads.push(String(path));
        return original(path, ...args);
      };
    }
    syncBuiltinESMExports();
    const configuration = await import(${JSON.stringify(entry)});
    if (reads.length > 0) throw new Error('Configuration read files at import: ' + reads.join(', '));
    if (configuration.resolveConfiguration({}, {}, { warn() {} }).semantic.editor.enabled !== false) {
      throw new Error('Standalone configuration did not resolve');
    }
    console.log('standalone config import passed');
  `], { cwd: paths.workspace, env: { ...process.env }, encoding: 'utf8', timeout: 10000 });
  check('a fresh process resolves config without plugin wiring or import-time file reads', child.status === 0 && child.stdout.includes('standalone config import passed'), child.error?.message ?? child.stderr);
});

if (failures.length > 0) {
  console.log(`\n${failures.length} configuration check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nall DCP configuration tests passed');
}
