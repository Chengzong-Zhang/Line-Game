import test from 'node:test';
import assert from 'node:assert/strict';
import { createWxPlatform } from '../src/platform.js';

const windowInfo = { windowWidth: 390, windowHeight: 844, pixelRatio: 3,
  statusBarHeight: 47, safeArea: { top: 47, bottom: 810 } };
function metrics(menuReader, info = windowInfo) {
  return createWxPlatform({ createCanvas: () => ({}), getWindowInfo: () => info,
    getMenuButtonBoundingClientRect: menuReader }).metrics();
}

test('an empty native menu response still reserves space below the visible capsule', () => {
  // Captured from WeChat Devtools 2.02.2608080 / base library 3.17.4, iPhone 12/13.
  for (const response of [{}, { bottom: 0 }, { bottom: NaN }, { bottom: 47 }]) {
    const actual = metrics(() => response);
    assert.equal(actual.top, 87);
    assert.equal(actual.bottom, 34);
    assert.equal(actual.dpr, 2);
  }
});

test('supported menu bounds are preserved; absent or failing bounds fall back safely', () => {
  assert.equal(metrics(() => ({ bottom: 88 })).top, 88);
  assert.equal(metrics(undefined).top, 87);
  assert.equal(metrics(() => { throw new Error('not available yet'); }).top, 87);
  const compact = { windowWidth: 320, windowHeight: 568, pixelRatio: 2, statusBarHeight: 20 };
  assert.equal(metrics(undefined, compact).top, 64);
});

test('brand row uses valid capsule coordinates and ignores partial zero or invalid bounds', () => {
  const valid = metrics(() => ({ top: 51, bottom: 83, left: 280, height: 32 }));
  assert.equal(valid.capsuleTop, 51); assert.equal(valid.capsuleLeft, 280); assert.equal(valid.capsuleHeight, 32);
  for (const response of [{}, { top: 0, left: 0, height: 0 }, { top: -20, left: NaN, height: 300 }]) {
    const actual = metrics(() => response);
    assert.equal(actual.capsuleTop, 51); assert.equal(actual.capsuleLeft, 288); assert.equal(actual.capsuleHeight, 32);
    assert.ok(actual.capsuleTop >= windowInfo.statusBarHeight);
  }
});
