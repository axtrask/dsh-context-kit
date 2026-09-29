/**
 * Check the generated preset's STRUCTURE, not just that it parses.
 *
 * The row that matters is `dcp`: it publishes `ctx.compaction`, so it must be a
 * child of the `compaction` group, whose `isolate.compaction: true` gives that
 * group a private service symbol. Mounted at the top level it publishes into the
 * root realm instead, and `command-compact` — which resolves the isolated
 * symbol — waits forever. That failure only appears at session compose time, so
 * this check exists to catch it at generation time.
 *
 * The composition uses the loader's `!!js` tag, which plain js-yaml does not
 * know, so a permissive type is registered for it: the tag's VALUE is never
 * needed here, only the shape around it.
 *
 * Run:  node scripts/verify-preset.mjs [path-to-agent.cordis.yml]
 *
 * @module dsh-context-kit/scripts/verify-preset
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import yaml from 'js-yaml';

const here = dirname(fileURLToPath(import.meta.url));
const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh');
const path = process.argv[2] ?? join(dshHome, '.agent-presets', 'context-kit', 'agent.cordis.yml');

/** Accept the loader's `!!js` tag as opaque text; this check never evaluates it. */
const JsTagType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: () => true,
  construct: (value) => value
});
const SCHEMA = yaml.DEFAULT_SCHEMA.extend([JsTagType]);

const checks = [];
const record = (name, ok, detail) => checks.push({ name, ok, detail: String(detail ?? '') });

let rows;
try {
  rows = yaml.load(readFileSync(path, 'utf8'), { schema: SCHEMA });
  record('composition parses', Array.isArray(rows), `${Array.isArray(rows) ? rows.length : 0} top-level rows`);
} catch (error) {
  record('composition parses', false, error.message);
}

if (Array.isArray(rows)) {
  const topIds = rows.map((row) => row.id);
  const group = rows.find((row) => row.id === 'compaction');
  const children = group?.config ?? [];
  const childIds = children.map((row) => row.id);

  record('compaction group present', group !== undefined, group === undefined ? 'missing' : 'found');
  record(
    'compaction realm is isolated',
    group?.isolate?.compaction === true,
    JSON.stringify(group?.isolate ?? null)
  );
  record('dcp is a child of the group', childIds.includes('dcp'), childIds.join(', ') || '(no children)');
  record('dcp is NOT at the top level', !topIds.includes('dcp'), 'a top-level dcp would publish into the root realm');
  record('dcp is mounted before command-compact', childIds.indexOf('dcp') < childIds.indexOf('command-compact') && childIds.includes('command-compact'), childIds.join(' -> '));
  record('context-mode is at the top level', topIds.includes('context-mode'), 'it provides no service, so it needs no realm');
  record('shipped backend removed', !topIds.includes('compaction-basic'), 'dcp subclasses it; two providers would collide');
}

const failed = checks.filter((check) => !check.ok);
for (const check of checks) console.log(`${check.ok ? '[ok]  ' : '[FAIL]'} ${check.name}: ${check.detail}`);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed  (${path})`);
process.exit(failed.length === 0 ? 0 : 1);
