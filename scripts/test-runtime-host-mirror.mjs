import assert from 'node:assert/strict';

await assert.doesNotReject(async () => {
  const marker = '--check';
  const added = !process.argv.includes(marker);
  if (added) process.argv.push(marker);
  try {
    await import('./sync-runtime-host.mjs');
  } finally {
    if (added) process.argv.splice(process.argv.lastIndexOf(marker), 1);
  }
}, 'the runtime Host mirror must stay byte-identical to the canonical implementation');
