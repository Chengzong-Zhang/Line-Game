import assert from 'node:assert/strict';
import test from 'node:test';
import { uiHarness } from './ui-harness.mjs';
import { memoryStorage, sut, until } from './helpers.mjs';

const ready = h => until(() => h.app.session.snapshot && !h.app.session.busy);
const preferences = h => sut.readPreferences(h.p.storage);
const point = button => ({ clientX: button.x + button.width / 2, clientY: button.y + button.height / 2 });
function type(entry, value) {
  const raw = String(value);
  if (!raw) { entry.onInput(''); return; }
  for (let i = 1; i <= raw.length; i++) entry.onInput(raw.slice(0, i));
}

function numberKeyboardMock() {
  const sessions = [];
  return {
    sessions,
    begin(options) {
      const session = { ...options, closed: false };
      sessions.push(session);
      return { close: () => { session.closed = true; }, update: value => { session.value = value; return !session.closed; } };
    },
    close() {}, destroy() {},
  };
}

function drag(h, fromId, toId) {
  const get = id => h.app.getButtons().find(button => button.id === id && !button.disabled);
  const from = get(fromId), to = get(toId);
  assert.ok(from && to, `${fromId} and ${toId} are visible order regions`);
  const start = point(from), target = point(to);
  h.p.callbacks.start({ touches: [start] });
  h.p.callbacks.move({ touches: [target] });
  h.p.callbacks.end({ touches: [], changedTouches: [target] });
}

test('color order blocks drag a non-rotational four-player order into the next game and action cycle', async () => {
  const fills = [];
  const ctx = new Proxy({ measureText: value => ({ width: String(value).length * 8 }), fillText() {} }, {
    get(target, key) { return key in target ? target[key] : () => {}; },
    set(target, key, value) { if (key === 'fillStyle') fills.push(value); target[key] = value; return true; },
  });
  const storage = memoryStorage(), h = uiHarness({ storage, canvas: { getContext: () => ctx } });
  try {
    await ready(h); const current = h.app.session;
    await h.tap('cabin-board'); await h.slide('player-count', 4, 2, 15);
    await h.scrollTo('order-BLACK'); await h.render();
    const initialOrder = ['BLACK', 'WHITE', 'PURPLE', 'GREEN'];
    assert.ok(initialOrder.every(player => h.app.getButtons().some(button => button.id === `order-${player}`)),
      'each participant has a direct touch region for its color block');
    for (const tint of ['#d3e1f6', '#f7ddda', '#e5dbfd', '#cee4da'])
      assert.ok(fills.includes(tint), `the order strip draws the player color block ${tint}`);

    // 3 -> 1 -> 4 -> 2; this is not a rotation of the original seat order.
    drag(h, 'order-PURPLE', 'order-BLACK'); await h.render();
    drag(h, 'order-GREEN', 'order-WHITE'); await h.render();
    const wanted = ['PURPLE', 'BLACK', 'GREEN', 'WHITE'];
    assert.deepEqual(preferences(h).turnOrder, wanted);
    assert.equal(h.app.session, current, 'editing next-game order preserves the live match');

    await h.tap('cabin-close'); await h.tap('new-game'); await ready(h);
    assert.deepEqual(h.app.session.settings.turnOrder, wanted);
    const actions = [];
    for (const player of wanted) {
      assert.equal(h.app.session.snapshot.currentPlayer, player, 'the next actor follows the selected order');
      const actor = h.app.session.snapshot.currentPlayer;
      assert.equal(await h.app.session.act({ type: 'skip' }), true);
      actions.push(h.app.session.actions.at(-1).player || actor);
      await until(() => !h.app.session.busy);
    }
    assert.deepEqual(actions, wanted, 'the first four actions use the non-rotational order');
  } finally { h.app.dispose(); }
});

test('cancelling or backgrounding an order drag leaves the saved order unchanged', async () => {
  const storage = memoryStorage(), h = uiHarness({ storage });
  try {
    await ready(h); await h.tap('cabin-board'); await h.slide('player-count', 4, 2, 15);
    await h.scrollTo('order-BLACK'); await h.render();
    const before = preferences(h).turnOrder || ['BLACK', 'WHITE', 'PURPLE', 'GREEN'];
    const source = h.app.getButtons().find(button => button.id === 'order-PURPLE'), target = h.app.getButtons().find(button => button.id === 'order-BLACK');
    assert.ok(source && target);
    h.p.callbacks.start({ touches: [point(source)] }); h.p.callbacks.move({ touches: [point(target)] });
    h.p.callbacks.cancel({ touches: [] }); await h.render();
    assert.deepEqual(preferences(h).turnOrder || before, before, 'touch cancellation discards the preview order');

    const current = h.app.getButtons().find(button => button.id === 'order-PURPLE'), next = h.app.getButtons().find(button => button.id === 'order-WHITE');
    h.p.callbacks.start({ touches: [point(current)] }); h.p.callbacks.move({ touches: [point(next)] });
    h.p.callbacks.hide();
    h.p.callbacks.end({ touches: [], changedTouches: [point(next)] });
    assert.deepEqual(preferences(h).turnOrder || before, before, 'background invalidates an unfinished drag');
  } finally { h.app.dispose(); }
});

test('inline number keyboard commits valid input, preserves disabled values, clamps ranges, and ignores stale sessions', async () => {
  const storage = memoryStorage(), keyboard = numberKeyboardMock();
  let modalInputCalls = 0;
  const h = uiHarness({ storage, platformOverrides: { numberKeyboard: keyboard, input: async () => { modalInputCalls++; return '9'; } } });
  const open = async id => { await h.scrollTo(id); await h.tap(id); return keyboard.sessions.at(-1); };
  const edit = async (id, raw, finish = 'confirm') => {
    const entry = await open(id); type(entry, raw);
    if (finish === 'confirm') entry.onConfirm(raw); else entry.onBlur();
    await h.render(); return entry;
  };
  try {
    await ready(h); await h.tap('cabin-board');
    const defaults = h.app.session.settings;
    const option = key => preferences(h).playOptions?.[key] ?? defaults[key];
    let entry = await open('undo-count');
    type(entry, ''); entry.onConfirm(''); await h.render();
    assert.equal(option('undoMaxCount'), defaults.undoMaxCount, 'empty input is not converted to zero');
    entry = await edit('undo-count', '101');
    assert.equal(option('undoMaxCount'), defaults.undoMaxCount, 'undo count above 100 is rejected');
    await edit('undo-count', '1');
    assert.equal(option('undoMaxCount'), 1, 'undo count accepts its minimum');
    await edit('undo-count', '100');
    assert.equal(option('undoMaxCount'), 100);
    await h.tap('undo-enabled');
    assert.equal(option('undoEnabled'), true);
    await h.tap('undo-enabled');
    assert.equal(option('undoEnabled'), false);
    assert.equal(option('undoMaxCount'), 100, 'turning the feature off retains its numeric value');

    await edit('clock-duration', '14', 'blur');
    assert.equal(option('turnTimeLimitSeconds'), defaults.turnTimeLimitSeconds, 'clock values below 15 are rejected');
    await edit('clock-duration', '15');
    assert.equal(option('turnTimeLimitSeconds'), 15, 'clock accepts its minimum');
    await edit('clock-duration', '200');
    assert.equal(option('turnTimeLimitSeconds'), 200);
    entry = await open('clock-duration'); type(entry, '90'); entry.onBlur(); await h.render();
    assert.equal(option('turnTimeLimitSeconds'), 90, 'a valid keyboard blur commits the edited value');
    await edit('hint-count', '11');
    assert.equal(option('hintMaxCount'), defaults.hintMaxCount, 'hint values above 10 are rejected');
    await edit('hint-count', '0');
    assert.equal(option('hintMaxCount'), defaults.hintMaxCount, 'hint count below 1 is rejected');
    await edit('hint-count', '1');
    assert.equal(option('hintMaxCount'), 1, 'hint count accepts its minimum');
    await edit('hint-count', '10');
    assert.equal(option('hintMaxCount'), 10);

    entry = await open('hint-count'); type(entry, '6');
    const stale = entry;
    const sx = h.p.metrics().width - 34, sy = h.p.metrics().top + 130;
    h.p.callbacks.start({ touches: [{ clientX: sx, clientY: sy }] });
    h.p.callbacks.move({ touches: [{ clientX: sx, clientY: sy + 180 }] });
    h.p.callbacks.end({ touches: [], changedTouches: [{ clientX: sx, clientY: sy + 180 }] }); await h.render();
    stale.onConfirm('6');
    assert.equal(option('hintMaxCount'), 10, 'scrolling closes and invalidates the editor token');

    entry = await open('clock-duration'); type(entry, '45');
    const pageStale = entry; await h.tap('cabin-guide'); pageStale.onConfirm('123');
    assert.equal(option('turnTimeLimitSeconds'), 45, 'switching pages commits valid blur input and rejects later stale callbacks');

    await h.tap('cabin-board'); entry = await open('undo-count'); type(entry, '7');
    const hidden = entry; h.p.callbacks.hide(); hidden.onConfirm('7');
    assert.equal(option('undoMaxCount'), 100, 'backgrounding prevents an unfinished value from committing');
    assert.equal(modalInputCalls, 0, 'numeric values use the inline keyboard instead of modal input');
  } finally { h.app.dispose(); }
});
