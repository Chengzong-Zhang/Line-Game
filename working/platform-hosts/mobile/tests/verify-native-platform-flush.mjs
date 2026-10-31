import assert from 'node:assert/strict';
import { initializeNativeSessionStorage } from '../src/native-session-storage.js';

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

class FakeEventTarget {
  listeners = new Map();
  addEventListener(type, listener) {
    const entries = this.listeners.get(type) ?? [];
    entries.push(listener);
    this.listeners.set(type, entries);
  }
  dispatch(type, detail = undefined) {
    for (const listener of this.listeners.get(type) ?? []) listener({ detail });
  }
}

let releaseWrite;
const writes = [];
const plugin = {
  async loadRecord() { return { value: null }; },
  async saveRecord({ key, value }) {
    writes.push({ operation: 'save', key, value });
    if (value === 'delayed') await new Promise((resolve) => { releaseWrite = resolve; });
    return { durable: true };
  },
  async removeRecord({ key }) {
    writes.push({ operation: 'clear', key });
    return { durable: true };
  },
};
const statuses = [];
const bridge = await initializeNativeSessionStorage({
  plugin,
  storage: new MemoryStorage(),
  eventTarget: new FakeEventTarget(),
  reportStatus: (state) => statuses.push(state),
});
assert.equal(typeof bridge.flushSessionMirror, 'function', 'native initialization exposes the platform flush hook');
await bridge.flushSessionMirror();

const eventTarget = new FakeEventTarget();
const delayedBridge = await initializeNativeSessionStorage({
  plugin,
  storage: new MemoryStorage(),
  eventTarget,
  reportStatus: (state) => statuses.push(state),
});
eventTarget.dispatch('lifeline:session-saved', { value: 'delayed' });
await new Promise((resolve) => setImmediate(resolve));
let flushFinished = false;
const pendingFlush = delayedBridge.flushSessionMirror().then(() => { flushFinished = true; });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(flushFinished, false, 'native flush waits for the in-flight durable write');
releaseWrite();
await pendingFlush;
eventTarget.dispatch('lifeline:session-cleared');
await delayedBridge.flushSessionMirror();
assert.deepEqual(writes.map(({ operation }) => operation), ['save', 'clear']);
assert.ok(statuses.includes('confirmed'));
console.log('verify-native-platform-flush: PASS (native init, save, flush, clear)');
