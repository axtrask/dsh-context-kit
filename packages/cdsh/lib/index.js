/**
 * cdsh v0.3.0 — host half (no-op).
 *
 * Every bit of work happens in the browser half (./client.js):
 *   - region -> theme resolution and CSS emission,
 *   - region-scoped <style> injection under data-plugin ownership,
 *   - the settings panel.
 * The host half exists so the loader row resolves and mounts.
 */
export const name = "cdsh"

export function apply() {
  // no-op: the client half owns everything
}
