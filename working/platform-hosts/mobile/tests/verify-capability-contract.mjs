import assert from 'node:assert/strict';
import {
  CAPABILITY_NAMES,
  CAPABILITY_QUERY_TIMEOUT_MS,
  createCapabilities,
  createUnknownCapabilities,
  normalizeCapabilities,
  queryCapabilities,
} from '../src/capability-contract.js';

const identity = { platform: 'harmonyos', source: 'harmony-native' };
const declared = createCapabilities({ ...identity, implementations: { sessionStorage: 'native' } });
assert.equal(declared.capabilities.sessionStorage.support, 'implemented');
assert.equal(declared.capabilities.sessionStorage.implementation, 'native');
assert.equal(declared.capabilities.appInfo.support, 'not-implemented');
assert.deepEqual(Object.keys(declared.capabilities).sort(), [...CAPABILITY_NAMES].sort());

const normalized = normalizeCapabilities(declared, identity);
assert.deepEqual(normalized, declared);
for (const value of [null, {}, { ...declared, schemaVersion: 2 }, { ...declared, extra: true },
  { ...declared, capabilities: { ...declared.capabilities, surprise: { support: 'implemented', implementation: 'native' } } }]) {
  const result = normalizeCapabilities(value, identity);
  assert.ok(Object.values(result.capabilities).every(({ support }) => support === 'unknown'));
}
assert.equal(normalizeCapabilities({ ...declared, schemaVersion: 2 }, identity).capabilities.appInfo.reason, 'unsupported-version');
const malformedField = normalizeCapabilities({
  ...declared,
  capabilities: { ...declared.capabilities, sessionStorage: { support: 'implemented', implementation: 'native', extra: true } },
}, identity);
assert.equal(malformedField.capabilities.sessionStorage.support, 'unknown');
assert.equal(malformedField.capabilities.appInfo.support, 'not-implemented');
assert.equal(createUnknownCapabilities(...Object.values(identity), 'missing-bridge').capabilities.appInfo.reason, 'missing-bridge');

let scheduled;
let cleared = false;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (callback, delay) => { scheduled = { callback, delay }; return 71; };
globalThis.clearTimeout = (id) => { cleared = id === 71; };
try {
  let releaseLate;
  const query = queryCapabilities({ ...identity, read: () => new Promise((resolve) => { releaseLate = resolve; }) });
  assert.equal(scheduled.delay, CAPABILITY_QUERY_TIMEOUT_MS);
  scheduled.callback();
  const timeoutResult = await query;
  assert.ok(Object.values(timeoutResult.capabilities).every((item) => item.reason === 'timeout'));
  assert.equal(cleared, true);
  releaseLate(declared);
  await Promise.resolve();
  assert.ok(Object.values(timeoutResult.capabilities).every((item) => item.reason === 'timeout'), 'late native replies cannot replace the settled unknown snapshot');

  const rejected = await queryCapabilities({ ...identity, read: () => Promise.reject(new Error('offline')) });
  assert.ok(Object.values(rejected.capabilities).every((item) => item.reason === 'native-error'));
  const boundedNativeCall = await queryCapabilities({ ...identity, read: () => Promise.reject(Object.assign(new Error('timeout'), { code: 'timeout' })) });
  assert.ok(Object.values(boundedNativeCall.capabilities).every((item) => item.reason === 'timeout'));
  const oldHost = await queryCapabilities({ ...identity, read: () => undefined });
  assert.ok(Object.values(oldHost.capabilities).every((item) => item.support === 'unknown'));
  const missingBridge = await queryCapabilities({ ...identity, read: null });
  assert.ok(Object.values(missingBridge.capabilities).every((item) => item.reason === 'missing-bridge'));
} finally {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}

console.log('verify-capability-contract: PASS (schema, malformed and unknown versions, bounded timeout, rejection, old host and late reply)');
