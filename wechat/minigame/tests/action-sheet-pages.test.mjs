import test from 'node:test';
import assert from 'node:assert/strict';
import { createWxPlatform } from '../src/platform.js';

const platform = showActionSheet => createWxPlatform({ createCanvas: () => ({}), showActionSheet });
const labels = { previousLabel: '上一页', nextLabel: '下一页' };

test('up to six native choices preserve their original indices and require one sheet', async () => {
  const items = ['A', 'B', 'C', 'D', 'E', 'F'];
  for (let selected = 0; selected < items.length; selected++) {
    let calls = 0;
    const p = platform(options => { calls++; assert.deepEqual(options.itemList, items); options.success({ tapIndex: selected }); });
    assert.equal(await p.choose(items), selected);
    assert.equal(calls, 1);
  }
});

test('every entry in long AI menus remains reachable within the native six-row limit', async () => {
  for (const count of [7, 9, 17, 29]) for (let selected = 0; selected < count; selected++) {
    const items = Array.from({ length: count }, (_, i) => `AI ${i}`), visited = [];
    const p = platform(options => {
      visited.push(options.itemList);
      assert.ok(options.itemList.length <= 6);
      let index = options.itemList.indexOf(items[selected]);
      if (index < 0) index = options.itemList.indexOf('下一页 ›');
      assert.ok(index >= 0, 'The requested AI must be present or reachable on a later page');
      options.success({ tapIndex: index });
    });
    assert.equal(await p.choose(items, labels), selected);
    assert.ok(visited.length <= Math.ceil(count / 4));
    assert.deepEqual(items, Array.from({ length: count }, (_, i) => `AI ${i}`));
  }
});

test('back navigation returns original indices rather than a page-local index', async () => {
  const items = Array.from({ length: 11 }, (_, i) => `AI ${i}`), actions = ['Next ›', '‹ Previous', 'AI 2'];
  const p = platform(options => {
    const index = options.itemList.indexOf(actions.shift()); assert.ok(index >= 0);
    options.success({ tapIndex: index });
  });
  assert.equal(await p.choose(items), 2);
  assert.equal(actions.length, 0);
});

test('cancel, malformed replies and unavailable native menus do not choose an AI', async () => {
  const items = Array.from({ length: 8 }, (_, i) => `AI ${i}`);
  let calls = 0;
  const cancelled = platform(options => {
    calls++;
    if (calls === 1) options.success({ tapIndex: options.itemList.indexOf('Next ›') });
    else options.fail({ errMsg: 'cancel' });
  });
  assert.equal(await cancelled.choose(items), -1); assert.equal(calls, 2);
  for (const reply of [undefined, {}, { tapIndex: -1 }, { tapIndex: 20 }, { tapIndex: 0.5 }]) {
    assert.equal(await platform(options => options.success(reply)).choose(items), -1);
  }
  assert.equal(await platform(() => { throw Error('UNAVAILABLE'); }).choose(items), -1);
  assert.equal(await platform(() => assert.fail('Empty lists must not open a sheet')).choose([]), -1);
});

test('leaving the current screen prevents both selection and further native pages', async () => {
  for (const target of ['AI 0', 'Next ›']) {
    let current = true, calls = 0, pending;
    const p = platform(options => { calls++; pending = options; });
    const result = p.choose(Array.from({ length: 8 }, (_, i) => `AI ${i}`), { isCurrent: () => current });
    assert.equal(calls, 1); current = false;
    pending.success({ tapIndex: pending.itemList.indexOf(target) });
    assert.equal(await result, -1); assert.equal(calls, 1);
  }
  assert.equal(await platform(() => assert.fail('Stale callers must not open a sheet'))
    .choose(['A'], { isCurrent: () => false }), -1);
});
