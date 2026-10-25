import test from 'node:test';
import assert from 'node:assert/strict';
import { createReaderCache } from '../src/reader-cache.js';
import { readerLayout, drawReader } from '../src/help-ui.js';
import { help, until, plain } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';
import { TEXT } from '../src/i18n.js';

function viewport(language = 'zh') {
  const measure = { calls: 0 };
  const ctx = { font: '', measureText(value) {
    measure.calls++;
    const font = Number(this.font.match(/\d+/)?.[0] || 16);
    return { width: [...String(value)].reduce((n, char) => n + (/[^\u0000-\u007f]/.test(char) ? font : font * .55), 0) };
  }, drawImage() {} };
  return { ui: { ctx, language, top: 136, metrics: { width: 320, height: 568, bottom: 24, dpr: 2 },
    label: key => TEXT[language][key], text() {}, rect() {}, button() {} }, measure };
}

test('repeated page drawing keeps every paragraph and chapter target without measuring the whole document again', () => {
  for (const language of ['zh', 'en']) for (const kind of ['rules-math', 'why-code']) {
    const { ui, measure } = viewport(language);
    const cache = createReaderCache(help.helpDocument);
    const first = cache.get(ui, kind, true);
    const expected = readerLayout(ui, help.helpDocument(kind, language, true));
    assert.deepEqual(first.layout, expected);
    const original = JSON.stringify(first);
    const chapters = new Set();
    let target = -1;
    for (let page = 0; page < expected.pages.length; page++) {
      const buttons = [];
      measure.calls = 0;
      // App creates a fresh UI wrapper every frame around the same Canvas.
      const state = cache.get({ ...ui, metrics: { ...ui.metrics } }, kind, true);
      assert.equal(measure.calls, 0, 'a frame must not remeasure the full article');
      drawReader({ ...ui, button: (id, title, x, y, width, action) => buttons.push({ id, action }) },
        { ...state, kind, page, canPractice: true }, { page(value) { target = value; }, back() {}, practice() {} });
      assert.ok(measure.calls < 300, 'drawing one page only measures its title');
      for (const button of buttons.filter(item => item.id.startsWith('reader-section-'))) {
        button.action();
        const id = button.id.slice('reader-section-'.length);
        assert.equal(expected.pages[target].id, id);
        assert.ok(!expected.pages[target].entries);
        chapters.add(id);
      }
    }
    assert.deepEqual([...chapters], first.sections.filter(section => !section.entries).slice(1).map(section => section.id));
    assert.equal(JSON.stringify(first), original, 'page drawing must not mutate cached text or layout');
  }
});

test('viewport, Canvas, language, document and privacy changes invalidate only the current cached entry', () => {
  const { ui, measure } = viewport();
  let documents = 0;
  const cache = createReaderCache((...args) => { documents++; return help.helpDocument(...args); });
  let value = cache.get(ui, 'privacy', false);
  assert.equal(documents, 1);
  for (const change of [
    () => { ui.metrics.width = 390; }, () => { ui.metrics.height = 844; },
    () => { ui.top = 160; }, () => { ui.metrics.bottom = 32; },
    () => { ui.metrics.dpr = 3; }, () => { ui.ctx = { ...ui.ctx }; },
    () => { const original = ui.ctx.measureText; ui.ctx.measureText = function (text) { return original.call(this, text); }; },
  ]) {
    change(); measure.calls = 0;
    const next = cache.get(ui, 'privacy', false);
    assert.ok(measure.calls > 0, 'changed measurement inputs trigger a fresh layout');
    assert.notEqual(next.layout, value.layout);
    assert.deepEqual(next.layout, readerLayout(ui, next.sections));
    assert.equal(documents, 1, 'geometry changes do not recreate bundled prose');
    value = next;
  }
  const offline = value.sections;
  const online = cache.get(ui, 'privacy', true).sections;
  assert.notDeepEqual(online, offline);
  assert.equal(documents, 2);
  ui.language = 'en';
  const english = cache.get(ui, 'privacy', true);
  assert.equal(english.layout.font, 16);
  assert.match(english.sections[0].title, /Data/);
  assert.equal(documents, 3);
  cache.get(ui, 'credits', true);
  cache.get(ui, 'privacy', true);
  assert.equal(documents, 5, 'returning from another article rebuilds rather than accumulating entries');
  cache.clear();
  cache.get(ui, 'privacy', true);
  assert.equal(documents, 6);
});

test('a failed document load does not poison the cache, and reopening observes replaced text', () => {
  const { ui } = viewport();
  let text = 'Original paragraph', fail = false;
  const cache = createReaderCache(kind => {
    if (fail) throw Error('DOCUMENT_UNAVAILABLE');
    return [{ id: kind, title: 'Chapter', paragraphs: [text] }];
  });
  const first = cache.get(ui, 'first');
  fail = true;
  assert.throws(() => cache.get(ui, 'second'), /DOCUMENT_UNAVAILABLE/);
  assert.equal(cache.get(ui, 'first').layout, first.layout);
  fail = false; text = 'Updated paragraph'; cache.clear();
  assert.deepEqual(cache.get(ui, 'first').sections[0].paragraphs, ['Updated paragraph']);
});

test('actual app reuses article layout while paging and redraws correctly after a window resize', async () => {
  let calls = 0;
  const ctx = new Proxy({ measureText(value) { calls++; return { width: String(value).length * 8 }; } },
    { get: (target, key) => key in target ? target[key] : () => {} });
  const h = uiHarness({ canvas: { getContext: () => ctx } });
  try {
    await until(() => h.app.session.snapshot && !h.app.session.busy);
    const before = { actions: plain(h.app.session.actions), hash: h.app.session.stateHash };
    await h.tap('cabin-guide');
    calls = 0;
    await h.tap('guide-rules-math'); await h.render();
    const cold = calls;
    assert.ok(cold > 10000, 'the real long document is laid out initially');
    calls = 0;
    for (let page = 0; page < 6; page++) { await h.tap('reader-next'); await h.render(); }
    const warm = calls;
    assert.ok(warm < cold / 5, `warm page work ${warm} must avoid repeated full layout ${cold}`);
    h.p.metrics = () => ({ width: 320, height: 568, top: 88, bottom: 24, dpr: 2 });
    calls = 0; h.p.callbacks.resize(); await h.render();
    assert.ok(calls > 10000, 'resizing recomputes the document for the new screen');
    for (const button of h.app.getButtons()) {
      assert.ok(button.x >= 0 && button.x + button.width <= 320);
      assert.ok(button.y + button.height <= 568 - 24);
    }
    calls = 0; await h.render();
    assert.ok(calls < 1000, 'the resized layout is reused on the next frame');
    assert.deepEqual(plain(h.app.session.actions), before.actions);
    assert.equal(h.app.session.stateHash, before.hash);
  } finally { h.app.dispose(); }
});
