/**
 * Canonical aggregate Host entry for Context Kit.
 *
 * The bundle mounts this package root once so DCP, Context Mode, and History
 * Editor share one Host row, Web client, and nested configuration scope.
 *
 * @module dsh-context-kit
 */

export * as dcp from './dcp.js';
export * as contextMode from './context-mode.js';
export { name, inject, Config, apply } from './plugin.js';
