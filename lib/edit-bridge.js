/**
 * The panel's hand-off across planes.
 *
 * ## Why this module exists
 *
 * The history editor's button needs two services that live on the Web plane:
 * `connection` (an authenticated RPC channel) and `webServer` (the index tap).
 * The DCP engine, which owns the editing rules, is mounted inside an AGENT PRESET,
 * one composition per session. Measured, in a real harness:
 *
 * - at the TOP level of the same profile, `ctx.inject(['connection','webServer'], cb)`
 *   runs `cb` and both services are usable;
 * - from the `dcp` row's context, the same call never runs `cb` at all — the
 *   mounting trail in `$DSH_HOME/context-kit/edit-gui.log` ends at `inject:asking`
 *   with no `inject:ran`, so the injected fiber is never activated.
 *
 * A panel that cannot be mounted from where the engine lives has exactly one
 * honest shape: mount it where the services ARE, and let it ask for an engine
 * instead of closing over one. This module is that asking point.
 *
 * It is deliberately a plain module-level registry rather than a cordis service:
 * the two halves are mounted in different realms, and a service published in one
 * is invisible to the other — which is the whole problem being solved. Node's
 * module cache is shared by both, because both import this same file.
 *
 * ## Lifetime
 *
 * A session registers its engine when the preset mounts and unregisters it when
 * the preset is disposed, so a session that is gone leaves no engine behind and
 * the panel refuses instead of editing a stale conversation. Registration is keyed
 * by session id. A request that names a session resolves only that exact registration;
 * using the newest engine as a cross-session fallback would let one session's busy
 * state and configuration authorize a mutation in another.
 *
 * @module dsh-context-kit/edit-bridge
 */

/** Engines by session id, plus the order they arrived in. */
const engines = new Map();

/** The session id of the most recent registration, used when a caller names none. */
let newest = undefined;

/**
 * Publish an engine for the panel to find.
 *
 * @param sessionId - the session this engine folds, or `undefined` while unknown.
 * @param engine - the DCP engine.
 * @returns a disposer removing the registration.
 */
export function publishEngine(sessionId, engine) {
  const key = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : Symbol('session');
  engines.set(key, engine);
  newest = key;
  return () => {
    engines.delete(key);
    if (newest === key) newest = engines.size === 0 ? undefined : [...engines.keys()].at(-1);
  };
}

/**
 * Resolve the engine a panel request may act on.
 *
 * @param sessionId - the session the browser named, when it named one.
 * @returns the engine, or `undefined` when nothing is mounted for that session.
 */
export function engineFor(sessionId) {
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    return engines.get(sessionId);
  }
  return newest === undefined ? undefined : engines.get(newest);
}

/** How many engines are published, for tests and diagnostics. */
export const publishedCount = () => engines.size;

/* ------------------------------------------------------------- the wire store */

/**
 * Wire stores by session id.
 *
 * The assistant branch cannot be written into the log at all: the core refuses a
 * replacement for a node that embeds its own stream (`assistant/message embeds its
 * source stream and cannot carry sourceEventSeqs`), so an assistant edit lives
 * only in the store and is applied to the request on its way out. The store is
 * created where the ENGINE is created - inside the session's preset row - and
 * spent where the REQUEST is made, which is the same crossing this module already
 * solves for engines, for the same reason.
 */
const stores = new Map();
let newestStore = undefined;

/**
 * Publish the wire store of one session.
 *
 * @param sessionId - the session the store belongs to.
 * @param store - the edit store built by `createEditStore`.
 * @returns a disposer removing the registration.
 */
export function publishEditStore(sessionId, store) {
  const key = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : Symbol('session');
  stores.set(key, store);
  newestStore = key;
  return () => {
    stores.delete(key);
    if (newestStore === key) newestStore = stores.size === 0 ? undefined : [...stores.keys()].at(-1);
  };
}

/**
 * Resolve the wire store a panel request may write to.
 *
 * @param sessionId - the session the browser named.
 * @returns the store, or `undefined` when no session published one.
 */
export function editStoreFor(sessionId) {
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    return stores.get(sessionId);
  }
  return newestStore === undefined ? undefined : stores.get(newestStore);
}

/** How many stores are published, for tests and diagnostics. */
export const publishedStores = () => stores.size;

/** Forget everything. Only a test has a reason to call this. */
export function resetBridgeForTest() {
  engines.clear();
  newest = undefined;
  stores.clear();
  newestStore = undefined;
}
