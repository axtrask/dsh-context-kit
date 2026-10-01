/** Profile-level DCP addon; no preset or editor dependency. */
import z from '@deepseek-ai/schemastery';
import { Config as LegacyConfig } from './dcp-config.js';
import { installDcpAddon } from './dcp.js';
import { EDITABLE_PROMPTS, editablePromptDefault } from './dcp-prompts.js';
import { createChannelHandler } from './edit-route.js';

export const name = 'dcp';
export const inject = ['settings', 'tools', 'llm', 'tokenMeter', 'sessions'];
export const Config = z.object(Object.fromEntries(Object.entries(LegacyConfig.dict).filter(([key]) => key !== 'editor'))).volatile();

function validate(value) {
  const limit = input => {
    if (typeof input === 'number' && Number.isFinite(input) && input >= 0 && Number.isInteger(input)) return [input, 'tokens'];
    if (typeof input === 'string' && /^(?:\d+(?:\.\d+)?)%$/.test(input) && Number.parseFloat(input) <= 100) return [Number.parseFloat(input), '%'];
    throw new Error('Context limits must be non-negative whole tokens or a percentage from 0% to 100%.');
  };
  const checkPair = (min, max) => {
    const [a, unitA] = limit(min), [b, unitB] = limit(max);
    if (unitA === unitB && a > b) throw new Error('The reminder threshold must not exceed the context-limit threshold.');
  };
  const c = value.compress;
  checkPair(c.minContextLimit, c.maxContextLimit);
  for (const key of new Set([...Object.keys(c.modelMinLimits), ...Object.keys(c.modelMaxLimits)])) {
    checkPair(c.modelMinLimits[key] ?? c.minContextLimit, c.modelMaxLimits[key] ?? c.maxContextLimit);
  }
  for (const text of Object.values(value.prompts)) if (text.length > 32768) throw new Error('Each prompt must be at most 32768 characters.');
}

export function installDcpPlugin(ctx, config, { configureSettings = true } = {}) {
  if (configureSettings) ctx.effect(() => ctx.settings.configure({ auto: false }));
  validate(config.get());
  const engine = installDcpAddon(ctx.isolate('compaction'), config.get());
  ctx.on('loader/volatile-update', () => {
    validate(config.get());
    engine.configure(config.get());
  });
  ctx.inject(['webServer'], web => {
    web.effect(() => web.webServer.register({ kind: 'prefix', path: '/ctxkit.dcp',
      handler: createChannelHandler('/ctxkit.dcp', method => {
        if (method !== 'prompts') throw new Error('Unknown DCP settings method');
        return { liveSettings: true, defaults: Object.fromEntries(EDITABLE_PROMPTS.map(key =>
          [key, engine.customPrompt(key, false) ?? editablePromptDefault(key, engine.dcpConfig.compress.mode)])) };
      })
    }));
  });
}

export function apply(ctx, config) {
  return installDcpPlugin(ctx, config);
}
