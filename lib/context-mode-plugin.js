/** Profile-level Context Mode with one default database per calling project. */
import { Config as RuntimeConfig, installContextMode } from './context-mode.js';

export const Config = RuntimeConfig.volatile();
export const name = 'context-mode';
export const inject = ['settings', 'tools'];

export function apply(ctx, config) {
  ctx.effect(() => ctx.settings.configure({ auto: false }));
  installContextMode(ctx, config.get());
}
