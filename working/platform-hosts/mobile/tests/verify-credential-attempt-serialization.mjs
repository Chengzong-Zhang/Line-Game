import assert from 'node:assert/strict';
import { createCredentialAuthority } from '../src/credential-authority.js';

const values = new Map();
let release, started;
const inFlight = new Promise(resolve => { started = resolve; });
let stored = { token: 'prior', username: 'prior' };
const provider = {
  claim: async () => ({ pageEpoch: 1, ownerGeneration: 1 }),
  load: async () => ({ state: 'present', credential: { ...stored } }),
  save: async (_lease, value) => {
    started();
    await new Promise(resolve => { release = resolve; });
    stored = { ...value };
    return { durable: true };
  },
  clear: async () => ({ durable: true }),
};
const storage = {
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value),
  removeItem: key => values.delete(key),
};
const authority = createCredentialAuthority({ provider, storage });
await authority.bootstrap();
const first = authority.beginAttempt();
const pending = authority.save({ token: 'first', username: 'first' });
await inFlight;
assert.equal(authority.beginAttempt(), null, 'a native commit prevents a second login attempt');
assert.equal(authority.isAttemptCurrent(first), true, 'rejected reentry does not invalidate the active commit');
release();
assert.equal(await pending, true);
assert.equal(stored.token, 'first');
assert.ok(authority.beginAttempt(), 'a new attempt is allowed after native completion');
console.log('verify-credential-attempt-serialization: PASS');
