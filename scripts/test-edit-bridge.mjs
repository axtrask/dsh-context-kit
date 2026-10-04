import assert from 'node:assert/strict';

import {
  editStoreFor,
  engineFor,
  publishEditStore,
  publishEngine,
  publishedCount,
  publishedStores,
  resetBridgeForTest,
} from '../lib/edit-bridge.js';

resetBridgeForTest();

const engineA = { name: 'engine-a' };
const engineB = { name: 'engine-b' };
const storeA = { name: 'store-a' };
const storeB = { name: 'store-b' };
const disposeEngineA = publishEngine('session-a', engineA);
const disposeEngineB = publishEngine('session-b', engineB);
const disposeStoreA = publishEditStore('session-a', storeA);
const disposeStoreB = publishEditStore('session-b', storeB);

assert.equal(publishedCount(), 2);
assert.equal(publishedStores(), 2);
assert.equal(engineFor('session-a'), engineA, 'an explicit session must resolve its exact engine');
assert.equal(editStoreFor('session-a'), storeA, 'an explicit session must resolve its exact store');
assert.equal(engineFor('missing'), undefined, 'an unmatched explicit session must not fall back to another engine');
assert.equal(editStoreFor('missing'), undefined, 'an unmatched explicit session must not fall back to another store');
assert.equal(engineFor(), engineB, 'a caller that names no session may use the newest engine');
assert.equal(editStoreFor(), storeB, 'a caller that names no session may use the newest store');

disposeEngineB();
disposeStoreB();
assert.equal(engineFor(), engineA);
assert.equal(editStoreFor(), storeA);
disposeEngineA();
disposeStoreA();
assert.equal(engineFor(), undefined);
assert.equal(editStoreFor(), undefined);

resetBridgeForTest();
console.log('edit bridge exact-session routing checks passed');
