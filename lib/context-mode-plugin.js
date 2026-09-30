/** Profile-level Context Mode with one default database per calling project. */
import { Config as RuntimeConfig, installContextMode } from './context-mode.js';

export const Config = RuntimeConfig.volatile();
export const name = 'context-mode';
export const inject = ['settings', 'tools'];

export function installContextModePlugin(ctx, config, { configureSettings = true } = {}) {
  if (configureSettings) ctx.effect(() => ctx.settings.configure({ auto: false }));
  installContextMode(ctx, config.get());
}

export function apply(ctx, config) {
  return installContextModePlugin(ctx, config);
}
