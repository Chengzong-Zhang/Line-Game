import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import { sut, wireClone, until } from './helpers.mjs';
import { TEXT } from '../src/i18n.js';

const mainSource = await fs.readFile(new URL('../dist/game.js', import.meta.url), 'utf8');
const workerSource = await fs.readFile(new URL('../dist/workers/index.js', import.meta.url), 'utf8');

// Runs the actual minified main and Worker in separate JS realms. The bridge
// copies and reorders every message in both directions. This is not a device test.
for (const language of ['zh', 'en']) {
  test(`production bundles read help, play, branch, settle and replay through a copying bridge: ${language}`, async () => {
    const callbacks = {}, storage = new Map([['lifeline-wx-language', language]]);
    const timers = new Set(), workers = [], kinds = [], calls = { login: 0, request: 0 };
    let texts = [], arcs = [], nativeAction = 'replay';
    const later = fn => {
      const timer = setTimeout(() => { timers.delete(timer); fn(); }, 0);
      timers.add(timer); return timer;
    };
    const canvasContext = new Proxy({
      measureText: text => ({ width: String(text).length * 8 }),
      fillText: (text, x, y) => texts.push({ text: String(text), x, y }),
      arc: (x, y, radius) => arcs.push({ x, y, radius }),
    }, { get: (target, key) => key in target ? target[key] : () => {} });
    const api = {
      createCanvas: () => ({ getContext: () => canvasContext }),
      getWindowInfo: () => ({ windowWidth: 390, windowHeight: 844, pixelRatio: 3, safeArea: { top: 48, bottom: 810 } }),
      getMenuButtonBoundingClientRect: () => ({ bottom: 88 }),
      getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value),
      onTouchStart: fn => { callbacks.start = fn; }, onTouchEnd: fn => { callbacks.end = fn; },
      onTouchMove: fn => { callbacks.move = fn; }, onTouchCancel() {}, onWindowResize() {}, onShow() {},
      onHide: fn => { callbacks.hide = fn; }, showShareMenu() {}, onShareAppMessage() {},
      getLaunchOptionsSync: () => ({}), login: () => { calls.login++; }, request: () => { calls.request++; },
      showActionSheet: ({ itemList, success }) => success({ tapIndex: itemList.indexOf(TEXT[language][nativeAction]) }),
      showModal: ({ success }) => success({ confirm: true }),
      createWorker: filename => {
        assert.equal(filename, 'workers/index.js');
        let receiveMain, receiveWorker;
        const instance = {
          terminated: false,
          onMessage: fn => { receiveMain = fn; }, onError() {}, onProcessKilled() {},
          postMessage: message => {
            kinds.push(message.kind);
            const copy = wireClone(message);
            later(() => { if (!instance.terminated) receiveWorker(copy); });
          },
          terminate() { this.terminated = true; },
        };
        const workerContext = vm.createContext({ worker: {
          onMessage: fn => { receiveWorker = fn; },
          postMessage: message => {
            const copy = wireClone(message);
            later(() => { if (!instance.terminated) receiveMain(copy); });
          },
        } });
        vm.runInContext(workerSource, workerContext, { timeout: 2000 });
        workers.push(instance); return instance;
      },
    };
    const mainContext = vm.createContext({ wx: api, setTimeout, clearTimeout, setInterval, clearInterval,
      requestAnimationFrame: fn => later(() => { texts = []; arcs = []; fn(); }),
    });
    const tap = ({ x, y }) => {
      callbacks.start({ touches: [{ clientX: x, clientY: y }] });
      callbacks.end({ changedTouches: [{ clientX: x, clientY: y }] });
    };
    const renderedLabel = label => {
      const single = texts.findLast(item => item.text === label);
      if (single) return single;
      // Compact English buttons may draw two lines in the Canvas. Locate the
      // rendered label, including the line break, rather than requiring one fillText.
      for (let i = texts.length - 2; i >= 0; i--) {
        const a = texts[i], b = texts[i + 1];
        if (a.x === b.x && b.y > a.y && b.y - a.y <= 24 && `${a.text} ${b.text}` === label)
          return { x: a.x, y: (a.y + b.y) / 2 };
      }
      return null;
    };
    const tapLabel = label => {
      // The status line can repeat a button caption (for example Continue).
      // Actions are painted after status text; tap the frontmost matching label.
      const item = renderedLabel(label);
      assert.ok(item, `Visible action: ${label}`); tap(item);
    };
    const scrollLabel = async label => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const item = texts.find(item => item.text === label && item.y >= 227 && item.y <= 776);
        if (item) { tap(item); return; }
        callbacks.start({ touches: [{ clientX: 356, clientY: 744 }] });
        callbacks.move({ touches: [{ clientX: 356, clientY: 604 }] });
        callbacks.end({ changedTouches: [{ clientX: 356, clientY: 604 }] });
        await new Promise(resolve => setTimeout(resolve, 8));
      }
      assert.fail(`Reachable scroll action: ${label}`);
    };
    const openReplayHub = async () => {
      tapLabel(TEXT[language]['cabin-board']);
      await until(() => texts.some(item => item.text.includes(language === 'zh' ? '语言 ·' : 'Language ·')));
      await scrollLabel(language === 'zh' ? '复盘模式' : 'Replay mode');
      await until(() => texts.some(item => item.text === TEXT[language].displayOptions));
    };
    const saves = () => [...storage.entries()].filter(([key]) => key.startsWith('lifeline-wechat-session-v1-'))
      .map(([, value]) => JSON.parse(value)).sort((a, b) => b.sequence - a.sequence);
    try {
      vm.runInContext(mainSource, mainContext, { timeout: 2000 });
      // Version 0.8 opens the live board immediately. Follow the real dock
      // instead of waiting for the retired start-menu screen.
      await until(() => texts.some(item => item.text === TEXT[language].confirm));
      tapLabel(TEXT[language]['cabin-guide']);
      await until(() => texts.some(item => item.text === (language === 'zh' ? '规则' : 'Rules')));
      tapLabel(language === 'zh' ? '简明规则' : 'Essentials');
      await until(() => texts.some(item => item.text === TEXT[language].backToGuide));
      tapLabel(TEXT[language].nextPage);
      await until(() => texts.some(item => /^2 \/ /.test(item.text)));
      tapLabel(TEXT[language].backToGuide);
      await scrollLabel(language === 'zh' ? '制作与致谢' : 'People behind the game');
      await until(() => texts.some(item => item.text.includes(language === 'zh' ? '创始人' : 'Founder')));
      tapLabel(TEXT[language].backToBoard);
      await until(() => texts.some(item => item.text === TEXT[language].resume));
      tapLabel(TEXT[language].resume);
      await until(() => arcs.some(item => item.radius === 2.4) && texts.some(item => item.text === TEXT[language].confirm))
        .catch(error => { throw new Error(`${error.message}: visible labels=${texts.map(item => item.text).join('|')}; worker=${kinds.join(',')}`); });
      assert.equal(saves()[0].payload.session.actions.length, 0);
      tap(arcs.find(item => item.radius === 2.4));
      await until(() => texts.some(item => item.text === TEXT[language].selected));
      tapLabel(TEXT[language].confirm);
      await until(() => saves()[0]?.payload.session.actions.length === 2);
      await until(() => texts.some(item => item.text.includes(`${TEXT[language].turn} 3`)));
      assert.deepEqual(kinds, ['STATE', 'APPLY', 'AI', 'APPLY']);
      assert.deepEqual(calls, { login: 0, request: 0 });
      assert.equal(texts.some(item => /正在核对最新进度|Checking the latest/.test(item.text)), false);
      const originalActions = saves()[0].payload.session.actions;
      await openReplayHub();
      tapLabel(TEXT[language].replay);
      await until(() => texts.some(item => item.text === `${TEXT[language].replay} · 0 / 2`));
      await until(() => renderedLabel(TEXT[language].branchReplay));
      tapLabel(TEXT[language].branchReplay);
      await until(() => texts.some(item => item.text === TEXT[language].branchStart));
      tapLabel(TEXT[language].branchStart);
      await until(() => saves()[0].payload.session.actions.length === 0 && texts.some(item => item.text === TEXT[language].resume));
      const archived = new sut.ReplayLibrary({ get: key => storage.get(key) }).read();
      assert.deepEqual(archived.entries[0].payload.session.actions, originalActions);
      assert.equal(saves()[0].payload.mode, 'human');
      await openReplayHub();
      tapLabel(TEXT[language].displayOptions);
      await until(() => texts.some(item => item.text === TEXT[language]['display-coordinates']));
      tapLabel(TEXT[language]['display-coordinates']);
      await until(() => JSON.parse(storage.get('lifeline-wx-display-v1') || '{}').coordinates === true);
      tap(texts.filter(item => item.text === TEXT[language].back).at(-1));
      await until(() => texts.some(item => item.text === (language === 'zh' ? '复盘模式' : 'Replay workspace')));
      tapLabel(TEXT[language].backToBoard);
      await until(() => texts.some(item => item.text === TEXT[language].resume)); tapLabel(TEXT[language].resume);
      await until(() => texts.some(item => item.text === TEXT[language].confirm));
      tap(arcs.find(item => item.radius === 2.4));
      await until(() => texts.some(item => item.text === TEXT[language].selected)); tapLabel(TEXT[language].confirm);
      await until(() => saves()[0].payload.session.actions.length === 1);
      await until(() => texts.some(item => item.text.includes(`${TEXT[language].turn} 2`)));
      tapLabel(TEXT[language].resign);
      await until(() => texts.some(item => item.text === TEXT[language].resultDetails));
      tapLabel(TEXT[language].resultDetails);
      await until(() => texts.some(item => item.text === TEXT[language].resultResigned));
      assert.ok(texts.some(item => item.text === `${TEXT[language].black} ${TEXT[language].wins}`));
      tapLabel(TEXT[language].saveResult);
      await until(() => new sut.ReplayLibrary({ get: key => storage.get(key) }).read().entries.length === 2);
      tapLabel(TEXT[language].replay);
      await until(() => texts.some(item => item.text === `${TEXT[language].replay} · 0 / 2`));
      assert.deepEqual(calls, { login: 0, request: 0 });
    } finally {
      callbacks.hide?.();
      for (const instance of workers) instance.terminate();
      for (const timer of timers) clearTimeout(timer);
    }
  });
}
