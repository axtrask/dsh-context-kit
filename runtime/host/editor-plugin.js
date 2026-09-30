/** Independent history editor, including its command, wire overlay and Web UI. */
import z from '@deepseek-ai/schemastery';
import { publishEditStore, publishEngine } from './edit-bridge.js';
import { createEditStore, installWireOverlay } from './edit.js';
import { runEditCommand } from './edit-durable.js';
import { installEditGui } from './edit-gui.js';

export const name = 'history-editor';
export const inject = ['settings', 'commands', 'connection', 'webServer'];
export const Config = z.object({
  enabled: z.boolean().default(false),
  requireIdle: z.boolean().default(true)
}).volatile();

export function installEditorPlugin(ctx, config, { configureSettings = true } = {}) {
  if (configureSettings) ctx.effect(() => ctx.settings.configure({ auto: false }));
  const runtime = { get editorConfig() { return config.get(); } };
  const store = createEditStore({ onProblem: (id, problem) => ctx.logger.warn(`${name}: ${id}: ${problem}`) });
  ctx.effect(() => publishEngine(undefined, runtime));
  ctx.effect(() => publishEditStore(undefined, store));
  ctx.effect(() => installWireOverlay(ctx, store, {
    active: () => config.get().enabled,
    onError: error => ctx.logger.warn(`${name}: wire overlay failed: ${error.message}`)
  }));
  ctx.effect(() => ctx.commands.register({
    name: 'edit',
    description: 'Edit a message of this conversation: /edit [#|id|-1] [new text]',
    input: { hint: '[#|id|-1] [new text]' },
    handler: invocation => runEditCommand({ session: invocation.agent.session, agent: invocation.agent,
      config: config.get(), rawInput: invocation.rawInput })
  }));
  installEditGui(ctx, runtime);
}

export function apply(ctx, config) {
  return installEditorPlugin(ctx, config);
}
