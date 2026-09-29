/** Offline-only migration. Default: inspect. Explicit --apply: backup and apply. */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { planMigration } from '../lib/plugin-migration.js';

const args = process.argv.slice(2);
if (args.some(arg => !['--apply', '--check'].includes(arg))) throw new Error('Use --check (default) or --apply');
const home = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'));
const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const plan = planMigration({ home, kitRoot });
console.log(`${plan.changes.length} configuration files need migration. History and indexes are untouched.`);
for (const change of plan.changes) console.log(change.path);
if (args.includes('--apply') && plan.changes.length) {
  const port = Number(process.env.DSH_MIGRATION_PORT || 3080);
  await new Promise((resolveStopped, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(2000);
    socket.once('connect', () => { socket.destroy(); reject(new Error(`Stop DSH on port ${port} before migration. Nothing was written.`)); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('Cannot establish whether DSH is stopped. Nothing was written.')); });
    socket.once('error', error => error.code === 'ECONNREFUSED' ? resolveStopped() : reject(error));
  });
  const base = join(home, 'context-kit');
  mkdirSync(base, { recursive: true });
  const lock = join(base, 'plugin-migration.lock');
  writeFileSync(lock, String(process.pid), { flag: 'wx' });
  const backup = join(base, 'migration-backups', randomUUID());
  const written = [];
  const current = path => existsSync(path) ? readFileSync(path, 'utf8') : null;
  try {
    for (const change of plan.changes) if (current(change.path) !== change.before) throw new Error('Configuration changed; run the migration again');
    mkdirSync(backup, { recursive: true });
    writeFileSync(join(backup, 'manifest.json'), JSON.stringify(plan.changes.map(({ path, before }, index) => ({ path, backup: before === null ? null : String(index) })), null, 2));
    for (const [index, change] of plan.changes.entries()) if (change.before !== null) writeFileSync(join(backup, String(index)), change.before, { flag: 'wx' });
    for (const change of plan.changes) {
      if (current(change.path) !== change.before) throw new Error('Configuration changed during migration');
      const temporary = change.path + '.' + randomUUID() + '.tmp';
      try { writeFileSync(temporary, change.after, { flag: 'wx' }); renameSync(temporary, change.path); }
      finally { if (existsSync(temporary)) unlinkSync(temporary); }
      written.push(change);
    }
    console.log('Migration applied. Backup: ' + backup);
  } catch (error) {
    for (const change of written.reverse()) {
      if (current(change.path) !== change.after) continue;
      if (change.before === null) unlinkSync(change.path);
      else writeFileSync(change.path, change.before);
    }
    throw error;
  } finally { unlinkSync(lock); }
} else if (plan.changes.length) console.log('Stop DSH, then rerun with --apply. A backup is created before any change.');
