import assert from 'node:assert/strict';
import { createNumberKeyboard } from '../src/inline-number-input.js';
import { drawTurnOrderStrip, turnOrderRegions } from '../src/turn-order-ui.js';

const events = new Map();
let showOptions, hideCalls = 0, hideListener;
const api = {
  showKeyboard: options => { showOptions = options; },
  hideKeyboard: () => { hideCalls++; },
  onHide: fn => { hideListener = fn; }, offHide: fn => { if (hideListener === fn) hideListener = null; },
};
for (const kind of ['Input', 'Confirm', 'Complete']) {
  events.set(kind, new Set());
  api[`onKeyboard${kind}`] = handler => events.get(kind).add(handler);
  api[`offKeyboard${kind}`] = handler => events.get(kind).delete(handler);
}
const emit = (kind, value) => { for (const listener of [...events.get(kind)]) listener({ value }); };

const keyboard = createNumberKeyboard(api);
const seen = [];
const first = keyboard.begin({ value: '5', onInput: value => seen.push(`input:${value}`), onBlur: value => seen.push(`blur:${value}`) });
assert.equal(showOptions.type, 'number');
assert.equal(showOptions.defaultValue, '5');
emit('Input', '');
assert.deepEqual(seen, ['input:']);
assert.equal(first.update({ value: '8' }), true);
assert.equal(first.update('9'), true);
let staleCalls = 0;
const oldListener = [...events.get('Input')][0];
const second = keyboard.begin({ value: '10', onConfirm: value => seen.push(`confirm:${value}`), onBlur: () => staleCalls++ });
oldListener({ value: 'stale' });
assert.equal(seen.at(-1), 'blur:9');
assert.equal(staleCalls, 0);
emit('Confirm', '100');
emit('Complete', '100');
assert.deepEqual(seen, ['input:', 'blur:9', 'confirm:100']);
assert.equal(staleCalls, 1);
assert.equal(second.update('1'), false);
assert.equal(events.get('Input').size, 0);
const third = keyboard.begin({ value: '3', onBlur: value => seen.push(`hidden:${value}`) });
hideListener();
assert.equal(seen.at(-1), 'hidden:3');
assert.equal(third.update('4'), false);
keyboard.begin({ value: '2' }).close();
assert.ok(hideCalls >= 2);
keyboard.destroy();
assert.equal(hideListener, null);

const regions = turnOrderRegions({ players: ['A', 'B', 'C'], order: ['C', 'A', 'C'], x: 10, y: 20, width: 300 });
assert.deepEqual(regions.map(region => [region.player, region.order]), [['C', 1], ['A', 2], ['B', 3]]);
assert.equal(regions[0].color, '#667085');
const drawn = [];
const rendered = drawTurnOrderStrip({ rect: (...args) => drawn.push(['rect', ...args]), text: (...args) => drawn.push(['text', ...args]) },
  { players: ['BLACK', 'WHITE'], order: ['WHITE', 'BLACK'], labels: { BLACK: 'Blue', WHITE: 'Red' }, x: 0, y: 0, width: 220 });
assert.equal(rendered.regions[0].player, 'WHITE');
assert.equal(rendered.regions[0].color, '#d96356');
assert.equal(rendered.height, 42);
assert.ok(drawn.length > 0);

console.log('inline-number-input: PASS');
