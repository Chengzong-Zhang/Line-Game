import assert from 'node:assert/strict';
import { sut, memoryStorage, fakeWorker, until, wireClone } from './helpers.mjs';

export function uiHarness({ width = 390, height = 844, top = 88, language = 'zh', canvas, storage = memoryStorage(), config = {}, platformOverrides = {}, workerDelay = 1 } = {}) {
  const callbacks = {}, messages = [], calls = { read: 0, write: 0 }, workers = [];
  let texts = [], clipboard = '', frames = 0;
  storage.set('lifeline-wx-language', language);
  const ctx = new Proxy({ measureText: text => ({ width: String(text).length * 8 }),
    fillText: value => texts.push(String(value)) }, { get: (target, key) => key in target ? target[key] : () => {} });
  const p = { callbacks, storage, canvas: canvas || { getContext: () => ctx }, messages, calls, workerDelay,
    metrics: () => ({ width, height, top, bottom: 24, dpr: 2 }),
    frame: fn => setTimeout(() => { texts = []; fn(); frames++; }, 0),
    createWorker: () => {
      const w = fakeWorker(); workers.push(w);
      w.postMessage = message => setTimeout(async () => {
        if (w.terminated) return;
        const result = await sut.handleWorkerMessage(wireClone(message));
        if (!w.terminated) w.receive(wireClone(result));
      }, p.workerDelay);
      return w;
    },
    touchStart: fn => { callbacks.start = fn; }, touchEnd: fn => { callbacks.end = fn; },
    touchMove: fn => { callbacks.move = fn; }, touchCancel: fn => { callbacks.cancel = fn; },
    onHide: fn => { callbacks.hide = fn; }, onShow: fn => { callbacks.show = fn; }, onResize: fn => { callbacks.resize = fn; },
    setupShare() {}, launchOptions: () => ({}), confirm: async () => true, choose: async () => -1,
    message: async text => messages.push(text),
    readClipboard: async () => { calls.read++; return clipboard; },
    writeClipboard: async text => { calls.write++; clipboard = text; },
  };
  Object.assign(p, platformOverrides);
  const app = sut.createApp(p, config);
  const render = async () => { const before = frames; app.redraw(); await until(() => frames > before); };
  const scrollTo = async id => {
    await render(); if (app.getButtons().some(item => item.id === id)) return;
    const sx = width - 34, sy = top + 130;
    callbacks.start({ touches: [{ clientX: sx, clientY: sy }] });
    callbacks.move({ touches: [{ clientX: sx, clientY: sy + 2000 }] });
    callbacks.end({ changedTouches: [{ clientX: sx, clientY: sy + 2000 }], touches: [] });
    for (let attempt = 0; attempt < 12; attempt++) {
      await render(); if (app.getButtons().some(item => item.id === id)) return;
      const x = width - 34, y = height - 70;
      callbacks.start({ touches: [{ clientX: x, clientY: y }] });
      callbacks.move({ touches: [{ clientX: x, clientY: y - 140 }] });
      callbacks.end({ changedTouches: [{ clientX: x, clientY: y - 140 }], touches: [] });
      await render();
    }
  };
  const tap = async id => {
    await render();
    let b = app.getButtons().find(b => b.id === id);
    if (!b && ['library', 'display-open', 'language'].includes(id) && ['game', 'home'].includes(app.getScene())) {
      if (app.getCabin() !== 'board') await tap('cabin-board');
      if (id !== 'language') { await scrollTo('replay-mode'); await tap('replay-mode'); }
      await scrollTo(id); b = app.getButtons().find(item => item.id === id);
    }
    if (!b && id === 'friends' && app.getScene() === 'game') {
      await tap('cabin-battle'); await scrollTo(id); b = app.getButtons().find(item => item.id === id);
    }
    assert.ok(b && !b.disabled, `Enabled button: ${id}`);
    app.tap(b.x + b.width / 2, b.y + b.height / 2);
    await new Promise(resolve => setTimeout(resolve, 8));
  };
  const slide = async (id, value, min, max) => {
    await scrollTo(id); const b = app.getButtons().find(item => item.id === id); assert.ok(b && !b.disabled, id);
    app.tap(b.x + 12 + (b.width - 24) * (value - min) / (max - min), b.y + b.height / 2); await render();
  };
  return { app, p, tap, render, scrollTo, slide, workers, get texts() { return texts; },
    get clipboard() { return clipboard; }, set clipboard(value) { clipboard = value; } };
}
