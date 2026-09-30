/**
 * Composition root for the context kit: the two ports, side by side.
 *
 * Each is normally mounted as its own preset row so a deployment can take one
 * without the other; mounting this entry gives both.
 *
 * @module dsh-context-kit
 */

export * as dcp from './dcp.js';
export * as contextMode from './context-mode.js';
export { name, inject, Config, apply } from './plugin.js';
