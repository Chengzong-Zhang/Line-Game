import test from 'node:test';
import assert from 'node:assert/strict';
import { createWxInput } from '../src/input.js';
import { uiHarness } from './ui-harness.mjs';
import { sut, until } from './helpers.mjs';

function nativeInput() {
  const events = {}, removed = [], api = {}, calls = [];
  for (const name of ['TouchStart', 'TouchMove', 'TouchEnd', 'TouchCancel', 'MouseDown', 'MouseMove', 'MouseUp', 'Wheel']) {
    api[`on${name}`] = fn => { events[name] = fn; };
    api[`off${name}`] = fn => { removed.push(name); assert.equal(fn, events[name]); };
  }
  let time = 0;
  const input = createWxInput(api, { now: () => time });
  for (const name of ['start', 'move', 'end', 'cancel', 'wheel']) {
    input[name === 'wheel' ? name : `touch${name[0].toUpperCase()}${name.slice(1)}`](event => calls.push({ name, event }));
  }
  return { input, events, calls, removed, later: () => { time += 1000; } };
}
const p = (x, y) => ({ clientX: x, clientY: y });
const ready = async h => { await until(() => h.app.session.snapshot && !h.app.session.busy); await h.render(); };

test('native desktop mouse coordinates drive one drag; right click and hover do not start actions', () => {
  const h = nativeInput();
  h.events.MouseMove({ x: 20, y: 30 }); h.events.MouseDown({ x: 20, y: 30, button: 2 });
  assert.equal(h.calls.length, 0);
  h.events.MouseDown({ x: 20, y: 30, button: 0 });
  h.events.MouseMove({ x: 90, y: 32 }); h.events.MouseUp({ x: 110, y: 34, button: 0 });
  assert.deepEqual(h.calls.map(c => c.name), ['start', 'move', 'end']);
  assert.deepEqual(h.calls[1].event.touches, [p(90, 32)]);
  assert.deepEqual(h.calls[2].event.changedTouches, [p(110, 34)]);
  assert.deepEqual(h.calls[2].event.touches, []);
});

test('translated mouse/touch pairs complete once in either order, including mixed move delivery', () => {
  for (const mouseFirst of [true, false]) {
    const h = nativeInput();
    const mouseStart = () => h.events.MouseDown({ x: 40, y: 50, button: 0 });
    const touchStart = () => h.events.TouchStart({ touches: [p(40, 50)] });
    if (mouseFirst) { mouseStart(); touchStart(); } else { touchStart(); mouseStart(); }
    // Some desktop clients translate only part of the mouse sequence to touch.
    h.events.MouseMove({ x: 100, y: 50 });
    h.events.TouchMove({ touches: [p(100, 50)] });
    h.events.TouchEnd({ touches: [], changedTouches: [p(100, 50)] });
    h.events.MouseUp({ x: 100, y: 50, button: 0 });
    assert.equal(h.calls.filter(c => c.name === 'start').length, 1);
    assert.equal(h.calls.filter(c => c.name === 'end').length, 1);
    assert.ok(h.calls.some(c => c.name === 'move'));
    h.events.MouseDown({ x: 100, y: 50, button: 0 });
    h.events.MouseUp({ x: 100, y: 50, button: 0 });
    assert.equal(h.calls.filter(c => c.name === 'end').length, 2, 'rapid repeat mouse clicks remain usable');
    h.later(); h.events.MouseDown({ x: 100, y: 50, button: 0 }); h.events.MouseUp({ x: 100, y: 50, button: 0 });
    assert.equal(h.calls.filter(c => c.name === 'end').length, 3);
  }
});

test('late duplicate taps are suppressed, touch-only remains usable, cancel and dispose clear capture', () => {
  const h = nativeInput();
  h.events.MouseDown({ x: 40, y: 50 }); h.events.MouseUp({ x: 40, y: 50 });
  h.events.TouchStart({ touches: [p(40, 50)] }); h.events.TouchEnd({ touches: [], changedTouches: [p(40, 50)] });
  assert.equal(h.calls.filter(c => c.name === 'end').length, 1);
  h.later(); h.events.TouchStart({ touches: [p(40, 50)] }); h.events.TouchMove({ touches: [p(40, 90)] });
  h.events.TouchEnd({ touches: [], changedTouches: [p(40, 90)] });
  assert.equal(h.calls.filter(c => c.name === 'end').length, 2);
  h.later(); h.events.MouseDown({ x: 10, y: 10 }); h.input.resetInput(); h.events.MouseUp({ x: 10, y: 10 });
  assert.equal(h.calls.at(-1).name, 'cancel');
  h.events.MouseDown({ x: 10, y: 10 }); h.events.MouseMove({ x: 30, y: 10, buttons: 0 });
  assert.equal(h.calls.at(-1).name, 'cancel');
  h.input.disposeInput(); const count = h.calls.length; h.events.MouseDown({ x: 10, y: 10 });
  assert.equal(h.calls.length, count); assert.equal(h.removed.length, 8);
  assert.doesNotThrow(() => createWxInput({}));
  assert.doesNotThrow(() => createWxInput({ onMouseDown() { throw new Error('unsupported'); }, onWheel() { throw new Error('unsupported'); } }));
});

test('official wx.onWheel deltas retain coordinates and never become taps', () => {
  const h = nativeInput();
  h.events.Wheel({ x: 30, y: 300, deltaX: 0, deltaY: 120, deltaZ: 0 });
  assert.deepEqual(h.calls, [{ name: 'wheel', event: { ...p(30, 300), deltaY: 120, deltaMode: 0 } }]);
});

test('player slider supports a continuous 2→3→4→6 drag across draft invalidation', async () => {
  const h = uiHarness();
  try {
    await ready(h); const hash = h.app.session.stateHash; await h.tap('cabin-board');
    const b = h.app.getButtons().find(b => b.id === 'player-count'), y = b.y + 21;
    const playerMax = sut.playerIds(15).length === 15 ? 15 : 6;
    const at = value => b.x + 12 + (b.width - 24) * (value - 2) / (playerMax - 2);
    h.p.callbacks.start({ touches: [p(at(2), y)] });
    for (const value of [...new Set([3, 4, 6, playerMax])]) {
      h.p.callbacks.move({ touches: [p(at(value), y)] }); await h.render();
      assert.equal(sut.readPreferences(h.p.storage).playerCount, value);
    }
    h.p.callbacks.end({ touches: [], changedTouches: [p(at(playerMax), y)] });
    assert.equal(h.app.session.stateHash, hash, 'draft edits preserve the current match');
    await h.tap('player-count-decrease'); await h.render();
    assert.equal(sut.readPreferences(h.p.storage).playerCount, playerMax - 1);
    await h.tap('player-count-increase'); await h.render();
    assert.equal(sut.readPreferences(h.p.storage).playerCount, playerMax);
    assert.equal(h.app.getButtons().find(b => b.id === 'player-count-increase').disabled, true);
  } finally { h.app.dispose(); }
});

test('vertical gestures from a slider stay scrolls even when later motion veers sideways', async () => {
  const h = uiHarness();
  try {
    await ready(h); await h.tap('cabin-board');
    const b = h.app.getButtons().find(b => b.id === 'player-count'), x = b.x + b.width / 2, y = b.y + 21;
    h.p.callbacks.start({ touches: [p(x, y)] });
    h.p.callbacks.move({ touches: [p(x, y - 30)] }); await h.render();
    h.p.callbacks.move({ touches: [p(x + 70, y - 40)] }); await h.render();
    h.p.callbacks.end({ touches: [], changedTouches: [p(x + 70, y - 40)] });
    assert.equal(sut.readPreferences(h.p.storage).playerCount ?? 2, 2);
  } finally { h.app.dispose(); }
});

test('wheel scroll exposes board size; plus/minus and drag edit draft without playing moves', async () => {
  let wheel;
  const h = uiHarness({ platformOverrides: { wheel: fn => { wheel = fn; } } });
  try {
    await ready(h); const hash = h.app.session.stateHash; await h.tap('cabin-board');
    const originalY = h.app.getButtons().find(b => b.id === 'player-count').y;
    wheel({ clientX: 0, clientY: 400, deltaY: 120 }); await h.render();
    assert.equal(h.app.getButtons().find(b => b.id === 'player-count').y, originalY, 'outside sheet ignored');
    wheel({ clientX: 200, clientY: 400, deltaY: 180 }); await h.render();
    const b = h.app.getButtons().find(b => b.id === 'board-size'); assert.ok(b, 'wheel reveals lower controls');
    const before = sut.readPreferences(h.p.storage).size;
    await h.tap('board-size-increase'); assert.equal(sut.readPreferences(h.p.storage).size, before + 1);
    await h.tap('board-size-decrease'); assert.equal(sut.readPreferences(h.p.storage).size, before);
    const y = b.y + 21;
    h.p.callbacks.start({ touches: [p(b.x + 12, y)] });
    h.p.callbacks.move({ touches: [p(b.x + b.width - 12, y)] }); await h.render();
    h.p.callbacks.end({ touches: [], changedTouches: [p(b.x + b.width - 12, y)] });
    assert.equal(sut.readPreferences(h.p.storage).size, 15); assert.equal(h.app.session.stateHash, hash);
    await h.tap('cabin-close'); wheel({ clientX: 200, clientY: 400, deltaY: 500 }); await h.render();
    assert.equal(h.app.session.actions.length, 0, 'wheel over board never selects or plays');
  } finally { h.app.dispose(); }
});
