/** DCP configuration schemas, file layers, normalization, and limit resolution. */

import { join } from 'node:path';

import z from '@deepseek-ai/schemastery';

import { errorLine, isRecord, readJsonc } from './common.js';
import { DEFAULT_COMPRESS_PROTECTED_TOOLS, DEFAULT_PROTECTED_TOOLS } from './dcp-strategies.js';
import { EDITABLE_PROMPTS } from './dcp-prompts.js';

const PLUGIN_ID = 'dcp';

/** Configuration-file names, in DCP's own precedence order within a directory. */
const CONFIG_FILENAMES = ['dcp.jsonc', 'dcp.json'];

const protectedToolsList = z.array(z.string());
const deduplication = z.object({
  enabled: z.boolean().default(true),
  protectedTools: protectedToolsList.default([])
});
const purgeErrors = z.object({
  enabled: z.boolean().default(true),
  turns: z.number().step(1).min(0).default(4),
  protectedTools: protectedToolsList.default([])
});
const turnProtection = z.object({
  enabled: z.boolean().default(false),
  turns: z.number().step(1).min(0).default(4)
});
/**
 * A limit as the configuration schema expresses it.
 *
 * Upstream's `PluginConfig` declares `number | \`${number}%\``; a port that
 * accepts only numbers rejects a documented, working setting with a schema error
 * instead of honouring it. Both forms are therefore accepted and both reach
 * {@link parseLimitValue}.
 */
const limitSchema = z.union([z.number().min(0), z.string()]).default(100000);

/**
 * `manualMode` in the schema, accepting BOTH documented forms.
 *
 * Upstream declares an object (`{ enabled, automaticStrategies }`, `config.ts:65`);
 * this port's canonical form is the boolean plus a top-level
 * `automaticStrategies`. Both are valid input and both normalize to the boolean,
 * so a document written for upstream loads instead of failing validation and
 * taking the plugin — and context-mode's tool suite with it — down.
 */
const manualModeSchema = z
  .union([
    z.boolean(),
    z.object({
      enabled: z.boolean().default(false),
      automaticStrategies: z.boolean().default(true)
    })
  ])
  .default(false);

const compress = z.object({
  mode: z.union(['range', 'message']).default('range'),
  // `ask` is upstream's third documented value. Upstream never branches on it —
  // only `deny` suppresses the tool — so it is accepted and behaves as `allow`.
  permission: z.union(['ask', 'allow', 'deny']).default('allow'),
  showCompression: z.boolean().default(false),
  summaryBuffer: z.boolean().default(true),
  // Upstream's defaults are 100000 / 50000 (`lib/config.ts:684-685`), and the
  // floor is not decoration: it is what suppresses the iteration nudge while a
  // long run stays comfortably under the ceiling (`utils.ts:156-157`). The port
  // had `limitSchema` with NO default on both, so an unconfigured install read
  // `minContextLimit` as undefined — and undefined means "no floor at all",
  // which silently turned the quiet band off for every user who never set it.
  maxContextLimit: limitSchema.default(100000),
  minContextLimit: limitSchema.default(50000),
  modelMaxLimits: z.dict(z.union([z.number(), z.string()])).default({}),
  modelMinLimits: z.dict(z.union([z.number(), z.string()])).default({}),
  nudgeFrequency: z.number().step(1).min(1).default(5),
  iterationNudgeThreshold: z.number().step(1).min(1).default(15),
  nudgeForce: z.union(['soft', 'strong']).default('soft'),
  protectedTools: protectedToolsList.default([...DEFAULT_COMPRESS_PROTECTED_TOOLS]),
  protectTags: z.boolean().default(false),
  protectUserMessages: z.boolean().default(false)
});
const commands = z.object({
  enabled: z.boolean().default(true),
  protectedTools: protectedToolsList.default([...DEFAULT_PROTECTED_TOOLS])
});
/**
 * The history editor.
 *
 * `enabled` defaults to **false**, unlike every other row here, and that stays deliberate
 * even though both branches are now proven. The durable path is covered by
 * `scripts/test-edit-durable.mjs`; the wire overlay by `scripts/test-edit-wire.mjs`, which
 * mounts THIS `apply` and asserts that the listener reaches the adapter with the edited
 * text while the log stays byte-identical — and it has been observed on a real request to a
 * real provider, whose next answer quoted the text the reply was rewritten to. The default
 * is not about doubt any more: editing the history the model is being sent is a change a
 * person should ask for, and a feature that rewrites a conversation by itself is not one to
 * switch on for everyone. Turn it on per profile.
 */
const editor = z.object({
  enabled: z.boolean().default(false),
  requireIdle: z.boolean().default(true)
});
const experimental = z.object({
  allowSubAgents: z.boolean().default(false),
  customPrompts: z.boolean().default(false)
});

/**
 * The plugin's declared configuration.
 *
 * Every key optional and defaulted, because it is a *base*: the user's
 * `dcp.jsonc` is validated against this schema on top of it, so a config file
 * is checked exactly as strictly as a preset row would be.
 */
export const Config = z.object({
  enabled: z.boolean().default(true),
  // Upstream declares `manualMode` as an object (`{ enabled, automaticStrategies }`,
  // `config.ts:65`); both forms are accepted and folded into the boolean plus the
  // top-level `automaticStrategies` this port uses.
  manualMode: manualModeSchema,
  automaticStrategies: z.boolean().default(true),
  includeContextStatus: z.boolean().default(false),
  pruneNotification: z.union(['off', 'minimal', 'detailed']).default('detailed'),
  pruneNotificationType: z.union(['chat', 'toast']).default('chat'),
  // `maxContextLimit` / `minContextLimit` are NOT declared here. They belong to
  // `compress` (upstream `config.ts:679-692`), and they used to be accepted at the
  // top level as deprecated aliases. Because the schema now carries real DEFAULTS
  // for the `compress` pair, an accepted-but-dead top-level key would resolve to
  // its own default and quietly override the user's own `compress.minContextLimit`
  // — the migration in `migrateLegacyLimits` is what carries such a key over, and
  // the key is dropped from `CONFIG_KEYS` so a config file that sets it is told
  // rather than obeyed.
  // NO top-level `protectedTools`. Upstream validates every key
  // (`lib/config.ts:93-137`) and the only `protectedTools` it knows are
  // `compress.protectedTools`, `commands.protectedTools` and the two per-strategy
  // lists. A top-level one is therefore a key this port invented, and it was read
  // by nothing. Removed rather than silently kept, so a
  // config file that sets it is told the key is unknown.
  protectedFilePatterns: protectedToolsList.default([]),
  strategies: z.object({ deduplication, purgeErrors }).default({}),
  turnProtection: turnProtection.default({}),
  commands: commands.default({}),
  editor: editor.default({}),
  experimental: experimental.default({}),
  prompts: z.object(Object.fromEntries(EDITABLE_PROMPTS.map(name => [name, z.string().default('')]))).default({}),
  compress: compress.default({})
});

/**
 * Parse ONE limit value the way upstream does.
 *
 * Upstream accepts `number | "${number}%"` and resolves a percentage against the
 * session's model context window (`lib/messages/inject/utils.ts:94-115`):
 * round the percent, clamp it to 0..100, scale by the window, round again. A
 * percentage with no known window resolves to `undefined`, which upstream then
 * treats as "no limit" — the nudge simply cannot fire. This port keeps that
 * exact arithmetic; accepting the string but ignoring it would silently disable
 * the very setting the user wrote.
 *
 * @param limit - the configured limit.
 * @param contextWindow - the model's context window, when known.
 * @returns the token count, or `undefined` when it cannot be resolved.
 */
function parseLimitValue(limit, contextWindow) {
  if (typeof limit === 'number') return Number.isFinite(limit) ? limit : undefined;
  if (typeof limit !== 'string' || !limit.endsWith('%')) return undefined;
  if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow)) return undefined;
  const parsed = Number.parseFloat(limit.slice(0, -1));
  if (Number.isNaN(parsed)) return undefined;
  const clamped = Math.max(0, Math.min(100, Math.round(parsed)));
  return Math.round((clamped / 100) * contextWindow);
}

/**
 * Resolve one context limit, honouring a per-model override.
 *
 * Upstream keys the override maps by the exact `provider/model` string and lets
 * them take priority over the global value (`lib/messages/inject/utils.ts:117-129`);
 * a session with no route matches no override, which is what an absent key
 * should mean.
 *
 * @param global - the configured global limit.
 * @param perModel - the override map.
 * @param modelKey - the session's `provider/model`, or an empty string.
 * @param contextWindow - the model's context window, when known.
 * @returns the limit that applies, or `undefined` for an unresolvable percent.
 */
export function compressLimitFor(global, perModel, modelKey, contextWindow) {
  if (modelKey.length > 0 && isRecord(perModel)) {
    const override = perModel[modelKey];
    if (override !== undefined) return parseLimitValue(override, contextWindow);
  }
  return parseLimitValue(global, contextWindow);
}

/**
 * Normalize one configuration document into this port's canonical shape.
 *
 * The port accepts upstream's DOCUMENTED config shapes in explicitly supplied
 * settings and DSH-owned `dcp.jsonc` files. Three shapes differ, and each is a
 * real upstream form rather than a typo to reject:
 *
 * - `manualMode` is an object upstream (`{ enabled, automaticStrategies }`,
 *   `config.ts:65`) and a boolean here. An object is a Fatal validation error in
 *   the strict schema, so the plugin would not load at all.
 * - `compress.permission` accepts `"ask"` upstream (`config.ts:7,516`). Upstream
 *   never branches on `"ask"`: `lib/compress/pipeline.ts` turns any non-`deny`
 *   value into `"compress"`, and only `"deny"` suppresses the tool. `"ask"` is
 *   therefore normalized to `"allow"`, which is the same observable behaviour.
 * - `compress.modelMaxLimits`/`modelMinLimits` may hold percent strings.
 *
 * @param raw - the document as the user wrote it, or as a preset row supplied it.
 * @returns a document the strict schema accepts.
 */
function normalizeConfigShapes(raw) {
  if (!isRecord(raw)) return raw;
  const out = { ...raw };

  const manual = out.manualMode;
  if (isRecord(manual)) {
    const { enabled, automaticStrategies } = manual;
    if (typeof enabled === 'boolean') out.manualMode = enabled;
    else delete out.manualMode;
    if (automaticStrategies !== undefined) out.automaticStrategies = automaticStrategies;
  }

  if (isRecord(out.compress)) {
    const compress = { ...out.compress };
    if (compress.permission === 'ask') compress.permission = 'allow';
    for (const key of ['modelMaxLimits', 'modelMinLimits']) {
      if (isRecord(compress[key])) {
        const limits = {};
        for (const [route, value] of Object.entries(compress[key])) {
          const parsed = value;
          if (typeof parsed === 'number' || typeof parsed === 'string') limits[route] = parsed;
        }
        compress[key] = limits;
      }
    }
    out.compress = compress;
  }
  return out;
}

/**
 * Drop the keys a validation failure has proven unusable.
 *
 * Recovery is deliberately field-by-field rather than whole-document: a config
 * file with one bad value should cost the user that ONE setting, not the tool
 * and not the ten `ctx_*` tools that share this plugin module. Cordis fails the
 * whole loader entry when `apply` throws (`cordis-plugin-loader`), and both
 * feature sets are registered from this one entry, so "load anyway with
 * defaults plus a warning" is the only acceptable failure mode.
 *
 * @param raw - the document that failed validation.
 * @param message - the validation error message, naming the offending path.
 * @returns a shallow copy without the offending top-level key, or `undefined`.
 */
function dropOffendingKey(raw, message) {
  if (!isRecord(raw)) return undefined;
  // A nested path (`$.compress.mode`) names the INNERMOST key, and dropping only
  // that one is the difference between losing one setting and losing the whole
  // section: `{ mode: 'sideways', maxContextLimit: 42000 }` must keep the limit.
  const segments = [...String(message ?? '').matchAll(/\$?\.?([A-Za-z_][\w-]*)/g)].map((m) => m[1]);
  for (let depth = segments.length; depth >= 1; depth -= 1) {
    const path = segments.slice(0, depth);
    let parent = raw;
    for (const step of path.slice(0, -1)) {
      parent = parent?.[step];
      if (!isRecord(parent)) break;
    }
    const leaf = path[path.length - 1];
    if (!isRecord(parent) || !Object.prototype.hasOwnProperty.call(parent, leaf)) continue;
    const copy = { ...raw };
    if (path.length === 1) {
      delete copy[leaf];
      return copy;
    }
    // Rebuild the chain so the nested delete does not mutate the caller's object.
    let rebuilt = copy;
    let cursor = copy;
    for (const step of path.slice(0, -1)) {
      cursor[step] = { ...cursor[step] };
      cursor = cursor[step];
    }
    delete cursor[leaf];
    return rebuilt;
  }
  return undefined;
}

/** Configuration keys `dcp.jsonc` may set: everything the schema declares. */
const CONFIG_KEYS = new Set([
  'enabled',
  'manualMode',
  'automaticStrategies',
  'includeContextStatus',
  'pruneNotification',
  'pruneNotificationType',
  'protectedFilePatterns',
  'strategies',
  'turnProtection',
  'commands',
  'editor',
  'experimental',
  'prompts',
  'compress'
]);

/**
 * Validate a parsed config file against this plugin's schema and strip keys a
 * newer upstream DCP understands but this port does not.
 *
 * A silently ignored key is worse than a loud one: the user would believe a
 * setting took effect. Unknown keys are therefore reported, not dropped.
 *
 * @param raw - parsed JSONC document.
 * @param sources - where the document came from, for the diagnostic.
 * @param logger - logger used for the warning.
 * @returns the keys that were applied.
 */
function validateFileConfig(raw, source, logger) {
  if (!isRecord(raw)) {
    logger.warn(`${PLUGIN_ID}: ${source} must contain a JSON object; ignoring it`);
    return [];
  }
  const applied = [];
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) {
      logger.warn(`${PLUGIN_ID}: ${source} sets unknown key "${key}"; ignoring it`);
      continue;
    }
    applied.push(key);
  }
  return applied;
}

/**
 * Read DCP's DSH-owned configuration files and layer them into one override.
 *
 * OpenCode owns `OPENCODE_CONFIG_DIR`, XDG/home `.config/opencode`, and
 * workspace `.opencode` trees. They are deliberately absent here: a DSH agent
 * must not change behaviour because another application has a DCP file.
 *
 * @param cwd - the session workspace root, when known.
 * @param dshHome - the harness home directory.
 * @param logger - logger used for diagnostics.
 * @returns the merged file-level overrides, plus the files that contributed.
 */
export function readConfigFiles(cwd, dshHome, logger) {
  const candidates = [];
  for (const filename of CONFIG_FILENAMES) candidates.push(join(dshHome, filename));
  if (typeof cwd === 'string' && cwd.length > 0) {
    for (const filename of CONFIG_FILENAMES) candidates.push(join(cwd, '.dsh', filename));
  }
  const merged = {};
  const sources = [];
  for (const path of candidates) {
    const raw = readJsonc(path);
    if (raw === undefined) continue;
    if (validateFileConfig(raw, path, logger).length === 0) continue;
    sources.push(path);
    Object.assign(merged, raw);
  }
  return { merged, sources };
}

/** Deep-merge one file-level override onto the resolved base configuration. */
function mergeConfig(base, override) {
  return {
    ...base,
    ...override,
    strategies: {
      deduplication: { ...base.strategies.deduplication, ...(override.strategies?.deduplication ?? {}) },
      purgeErrors: { ...base.strategies.purgeErrors, ...(override.strategies?.purgeErrors ?? {}) }
    },
    turnProtection: { ...base.turnProtection, ...(override.turnProtection ?? {}) },
    commands: { ...base.commands, ...(override.commands ?? {}) },
    editor: { ...base.editor, ...(override.editor ?? {}) },
    experimental: { ...base.experimental, ...(override.experimental ?? {}) },
    prompts: { ...base.prompts, ...(override.prompts ?? {}) },
    compress: { ...base.compress, ...(override.compress ?? {}) }
  };
}

/**
 * Configuration keys the SHIPPED backend accepts in its constructor.
 *
 * `BasicCompactionEngine` rejects unknown keys outright, so the parent must
 * receive only this subset; DCP's own keys are kept out of it deliberately.
 */
const BASIC_CONFIG_KEYS = [
  'thresholdRatio',
  'retainRatio',
  'retainTokens',
  'summarizationProvider',
  'summarizationModel',
  'maxTokens',
  'compactionRetries',
  'maxOverflowRetries',
  'modelPolicies',
  'auto'
];

/**
 * The subset of a DCP configuration the parent engine understands.
 * @param config - a validated DCP configuration.
 * @returns a plain object holding only the parent's keys.
 */
function basicSubset(config) {
  const subset = {};
  for (const key of BASIC_CONFIG_KEYS) {
    if (config[key] !== undefined) subset[key] = config[key];
  }
  return subset;
}

/**
 * Fold the object form of `manualMode` into this port's canonical fields.
 *
 * The schema deliberately accepts upstream's object form so the document loads;
 * every consumer downstream reads `manualMode` as a boolean, so the fold has to
 * happen exactly once, right after validation (see {@link manualModeSchema}).
 *
 * @param config - a validated configuration document.
 * @returns a shallow copy whose `manualMode` is a boolean.
 */
function canonicalManualMode(config) {
  const manual = config.manualMode;
  if (typeof manual !== 'object' || manual === null) return config;
  return {
    ...config,
    manualMode: manual.enabled === true,
    automaticStrategies: manual.automaticStrategies ?? config.automaticStrategies
  };
}

/**
 * Validate the row configuration, fold in any `dcp.jsonc` overrides, and
 * validate the result.
 *
 * The first pass is what makes the defaults real: an unconfigured preset row
 * arrives as `{}`, and the schema is what turns that into the full default
 * document. Merging a partial file onto a partial row would otherwise read
 * `base.strategies.deduplication` off `undefined`. The second pass re-checks
 * the merged document so a config file is validated exactly as strictly as a
 * preset row — which is the whole reason the schema is exported.
 *
 * @param rowConfig - the preset row's configuration, however partial.
 * @param fileOverride - overrides read from the user's config files.
 * @param logger - logger used for recovery warnings.
 * @returns the fully resolved, validated configuration.
 */
export function resolveConfiguration(rowConfig, fileOverride, logger) {
  const normalizedRow = normalizeConfigShapes(rowConfig ?? {});
  const validatedRow = canonicalManualMode(Config(normalizedRow));
  const inherited = basicSubset(validatedRow);
  if (fileOverride === undefined || Object.keys(fileOverride).length === 0) {
    return { semantic: validatedRow, basic: inherited };
  }
  const basic = { ...inherited };
  for (const key of BASIC_CONFIG_KEYS) {
    if (fileOverride[key] !== undefined) basic[key] = fileOverride[key];
  }
  // Validation runs on the document that will actually be used — defaults plus
  // the file's values — so a value still at its default can never be blamed, and
  // dropping the offending key drops only the user's own choice.
  const merged = mergeConfig(validatedRow, normalizeConfigShapes(fileOverride));
  const semantic = canonicalManualMode(validateConfigWithRecovery(
    (candidate) => Config(candidate),
    merged,
    logger
  ));
  return { semantic, basic };
}

/**
 * Validate a config document, dropping offending keys instead of throwing.
 *
 * `Config()` is strict: one bad value is a `ValidationError` that escapes
 * `apply()` and fails the WHOLE Cordis loader entry. Because this one module
 * registers both DCP's `compress` and context-mode's ten `ctx_*` tools, a typo in
 * one line of `dcp.jsonc` would silently remove eleven tools. Degrading to
 * "defaults plus a warning" is therefore required, not optional.
 *
 * @param attempt - thunk performing one validation.
 * @param raw - the document being validated, used to drop the offending key.
 * @param logger - logger for the warnings.
 * @returns the validated document, or the defaults when nothing survives.
 */
function validateConfigWithRecovery(attempt, raw, logger) {
  let candidate = raw;
  // One pass per top-level key is enough: dropping a key cannot introduce a new
  // violation in another key, so the loop terminates in at most |keys| + 1 steps.
  for (let guard = 0; guard <= Object.keys(isRecord(raw) ? raw : {}).length + 1; guard += 1) {
    try {
      return attempt(candidate);
    } catch (error) {
      const message = errorLine(error);
      const next = dropOffendingKey(candidate, message);
      if (next === undefined) {
        logger.warn(`${PLUGIN_ID}: configuration rejected (${message}); using defaults`);
        return Config({});
      }
      const path = [...String(message).matchAll(/\$?\.?([A-Za-z_][\w-]*)/g)].map((m) => m[1]).slice(0, 8);
      let dropped = path[path.length - 1];
      for (let depth = path.length; depth >= 1; depth -= 1) {
        let node = candidate;
        for (const step of path.slice(0, depth - 1)) node = node?.[step];
        if (isRecord(node) && Object.prototype.hasOwnProperty.call(node, path[depth - 1])) { dropped = path.slice(0, depth).join('.'); break; }
      }
      logger.warn(`${PLUGIN_ID}: ignoring configuration key "${dropped}": ${message}`);
      candidate = next;
    }
  }
  logger.warn(`${PLUGIN_ID}: configuration could not be salvaged; using defaults`);
  return Config({});
}

/**
 * Move the deprecated top-level context limits onto `compress`, and remove them
 * from the row.
 *
 * `maxContextLimit`/`minContextLimit` used to live at the top level. Upstream
 * declares them ONLY under `compress` (`lib/config.ts:679-692`), so a top-level
 * value would otherwise be accepted and ignored — the exact trap this port keeps
 * closing. A value the user actually wrote is therefore carried over, an explicit
 * `compress.*` value wins, and the top-level key is deleted either way so that
 * one setting has exactly one home.
 *
 * A key that is absent from the raw rows is left alone, which is what keeps the
 * schema defaults from looking like user intent: the migration runs on the raw
 * layers, before validation, so it can tell "the user wrote 50000" from "the
 * schema defaulted to 50000".
 *
 * @param rowConfig - the preset row, however partial.
 * @param fileOverride - merged `dcp.jsonc` overrides.
 * @param logger - logger used for the deprecation notices.
 * @returns the row configuration with the aliases resolved.
 */
export function migrateLegacyLimits(rowConfig, fileOverride, logger) {
  const carried = [];
  const dropped = [];
  const compressOverride = isRecord(fileOverride.compress) ? fileOverride.compress : {};
  const compressRow = isRecord(rowConfig.compress) ? rowConfig.compress : {};
  const next = { ...rowConfig };
  for (const key of ['maxContextLimit', 'minContextLimit']) {
    const fromFile = isRecord(fileOverride) ? fileOverride[key] : undefined;
    const fromRow = isRecord(rowConfig) ? rowConfig[key] : undefined;
    const value = fromFile ?? fromRow;
    // The alias is REMOVED either way. The schema no longer declares it and the
    // merged document is validated afterwards, so leaving it in would either be
    // stripped silently or — worse, before the schema defaults became real —
    // resolve to a default of its own and shadow `compress.*`. Deleting it is
    // what makes "one setting, one home" true.
    delete next[key];
    if (value === undefined) continue;
    // An explicit new-shape setting wins in either layer, and the top-level value
    // is reported rather than obeyed: a user with both spellings set should know
    // which one is in force.
    if (compressOverride[key] !== undefined || compressRow[key] !== undefined) {
      dropped.push(key);
      continue;
    }
    next.compress = { ...compressRow, [key]: value };
    carried.push(key);
  }
  if (carried.length > 0) {
    logger.warn(`${PLUGIN_ID}: ${carried.join(', ')} at the top level is deprecated; set compress.${carried[0]} instead (the value was carried over)`);
  }
  if (dropped.length > 0) {
    logger.warn(`${PLUGIN_ID}: ${dropped.join(', ')} at the top level is deprecated and was ignored, because compress.${dropped[0]} is set (compress wins)`);
  }
  return next;
}

/**
 * Test-only view of the limit arithmetic and the config pipeline.
 *
 * The behaviour these expose is the difference between "the plugin loads" and
 * "the plugin is gone": upstream's percent limits resolve against the model
 * window, and a bad value must be dropped rather than thrown out of `apply()`.
 * A regression test that cannot call them can only re-implement them, which is
 * how the original divergence survived. Exported under `*ForTest` names to keep
 * the production surface honest about what is public.
 */
export const parseLimitForTest = parseLimitValue;
/**
 * Test-only view of the configuration pipeline.
 *
 * It runs the SAME three steps `apply` runs — migrate the deprecated top-level
 * aliases, then validate the row, then fold the file layer in — because a test
 * that skipped the migration would certify a pipeline that does not exist: the
 * suite's top-level `maxContextLimit` cases failed exactly that way, with the
 * alias silently ignored while `apply` would have carried it over.
 */
export const resolveConfigForTest = (rowConfig, fileOverride, logger) =>
  resolveConfiguration(migrateLegacyLimits(rowConfig ?? {}, fileOverride ?? {}, logger), fileOverride, logger).semantic;
export const manualModeForTest = canonicalManualMode;
