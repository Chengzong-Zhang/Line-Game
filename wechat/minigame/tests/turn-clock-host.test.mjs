import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../src/turn-clock.js', import.meta.url), 'utf8');

test('default clock timers preserve the host receiver required by browser APIs', () => {
  const realm = vm.createContext({});
  vm.runInContext(`
    globalThis.calls = [];
    globalThis.setTimeout = function(callback, delay) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      calls.push(['schedule', delay]); return 17;
    };
    globalThis.clearTimeout = function(timer) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      calls.push(['cancel', timer]);
    };
    ${source.replace('export class TurnClock', 'class TurnClock')}
    globalThis.clock = new TurnClock(() => {}, () => { throw new Error('Unexpected expiry'); }, { now: () => 50 });
    clock.reset(1000); clock.start(); clock.suspend();
  `, realm);
  assert.deepEqual(JSON.parse(JSON.stringify(realm.calls)), [['cancel', null], ['schedule', 250], ['cancel', 17]]);
  assert.equal(realm.clock.running, false);
  assert.equal(realm.clock.remaining(), 1000);
});
