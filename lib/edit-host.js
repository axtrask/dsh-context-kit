/**
 * The host-plane row that mounts the history editor's panel.
 *
 * ## Why the panel is not mounted by the plugin that owns the editing rules
 *
 * `installEditGui` needs `connection` (an authenticated RPC channel) and
 * `webServer` (the index tap). Those are HOST services. The DCP engine is mounted
 * inside an AGENT PRESET, one composition per session, and a preset's realm cannot
 * reach the Web plane. Measured on a real harness, not inferred:
 *
 * - at the top level of the same profile, `ctx.inject(['connection','webServer'], cb)`
 *   runs `cb`, and both services are usable;
 * - from the `dcp` row, `ctx.get` answers `undefined` for both and the injected
 *   callback never runs — the mounting trail in `$DSH_HOME/context-kit/edit-gui.log`
 *   stops at `inject:asking` with no `inject:ran`.
 *
 * So the panel is mounted HERE, where the services live, and asks for an engine per
 * request through `lib/edit-bridge.js`. The alternative — teaching the DCP row to
 * reach the Web plane — is not a thing cordis offers.
 *
 * ## How it is wired
 *
 * One top-level row in the profile patch layer:
 *
 *     - insert:
 *         - id: context-kit-edit-panel
 *           name: '<absolute-path-to-dsh-context-kit>/lib/edit-host.js'
 *
 * A patch file can only override an EXISTING row or insert into an EXISTING group,
 * which is why this is an `insert` and why the row cannot live in the preset the
 * DCP engine sits in: a preset that published a host service would fail the mount
 * with `row(s) published process-global service(s)`.
 *
 * ## What it deliberately does not do
 *
 * It does not write messages. Every edit goes through
 * `lib/edit-durable.js` with the engine the bridge hands over, so the panel is a
 * second way to type the same command, not a second implementation of it.
 *
 * @module dsh-context-kit/edit-host
 */

import { installEditGui } from './edit-gui.js';

export const name = 'context-kit-edit-panel';

/**
 * Services this row needs. Both are host-plane, which is the point.
 *
 * BOTH MUST BE DECLARED, and the second one for a reason that is not obvious:
 * `connection.rpc.handle` registers the channel through
 * `owner.effect(() => owner.webServer.register(route))`
 * (`dsh-client-connection/lib/index.js:618`), where `owner` is the context that
 * READ the connection. Registering the channel therefore resolves `webServer`
 * from THIS context, and an undeclared one throws
 * `cannot get property "webServer" without inject` out of the middleware — which
 * fails the loader entry and takes the whole plugin tree down with it. Measured:
 * the row booted with only `connection` declared and the boot died at
 * `failed to apply loader entry context-kit-edit-panel`.
 */
export const inject = ['connection', 'webServer'];

/**
 * Mount the panel.
 *
 * @param ctx - the host-plane context: it can see `connection` and `webServer`.
 */
export function apply(ctx) {
  ctx.effect(() => {
    const dispose = installEditGui(ctx, undefined);
    return typeof dispose === 'function' ? dispose : () => {};
  }, 'context-kit: history editor panel');
}
