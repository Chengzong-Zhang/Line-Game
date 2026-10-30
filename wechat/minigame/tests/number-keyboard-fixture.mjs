import assert from 'node:assert/strict';

// Exercise the real row focus and its native callbacks after replacing sliders.
export async function typeNumber(h, id, value) {
  let entry;
  h.p.numberKeyboard = { begin: options => { entry = options; return { close() {} }; }, close() {} };
  await h.scrollTo(id); await h.tap(id);
  assert.ok(entry, `${id} opened the inline keyboard`);
  entry.onInput(String(value)); entry.onConfirm(String(value)); await h.render();
}
