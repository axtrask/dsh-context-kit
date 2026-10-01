/** Single Loader entry for every Context Kit host feature and its Web client. */
import z from '@deepseek-ai/schemastery';
import { Config as DcpConfig, installDcpPlugin } from './dcp-plugin.js';
import { Config as ContextModeConfig, installContextModePlugin } from './context-mode-plugin.js';
import { Config as EditorConfig, installEditorPlugin } from './editor-plugin.js';

export const name = 'context-kit';
export const inject = [
  'settings',
  'tools',
  'llm',
  'tokenMeter',
  'sessions',
  'commands',
  'connection',
  'webServer'
];

export const Config = z.object({
  dcp: DcpConfig.default({}),
  contextMode: ContextModeConfig.default({}),
  historyEditor: EditorConfig.default({})
});

function section(config, key) {
  return config[key];
}

export function apply(ctx, config) {
  ctx.effect(() => ctx.settings.configure({ auto: false }));
  const options = { configureSettings: false };
  installDcpPlugin(ctx, section(config, 'dcp'), options);
  installContextModePlugin(ctx, section(config, 'contextMode'), options);
  installEditorPlugin(ctx, section(config, 'historyEditor'), options);
}
