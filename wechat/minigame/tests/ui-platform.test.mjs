import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import { sut, memoryStorage, fakeWorker, until, localScheduler } from './helpers.mjs';

function context() {
  return new Proxy({ measureText: text => ({ width: String(text).length * 8 }) }, {
    get: (obj, prop) => prop in obj ? obj[prop] : () => {}, set: (obj, prop, value) => { obj[prop] = value; return true; },
  });
}
function platform(width, height, top, language = 'zh') {
  const callbacks = {}, store = memoryStorage(); store.set('lifeline-wx-language', language);
  return { callbacks, storage: store, canvas: { getContext: () => context() },
    metrics: () => ({ width, height, top, bottom: 24, dpr: 2 }), frame: fn => setTimeout(fn, 0),
    createWorker: () => { const w = fakeWorker(); w.postMessage = m => setTimeout(() => { if (!w.terminated) w.receive(sut.handleWorkerMessage(m)); }, 1); return w; },
    touchStart: fn => { callbacks.start = fn; }, touchEnd: fn => { callbacks.end = fn; }, onHide: fn => { callbacks.hide = fn; },
    touchMove: fn => { callbacks.move = fn; }, touchCancel: fn => { callbacks.cancel = fn; },
    onShow: fn => { callbacks.show = fn; }, onResize: fn => { callbacks.resize = fn; }, setupShare: () => {}, launchOptions: () => ({}),
    confirm: async () => true, choose: async () => -1, message: async () => {},
  };
}

test('all core buttons fit compact/large safe areas in both languages; touch uses confirmation', async () => {
  for (const language of ['zh', 'en']) for (const [width, height, top] of [[320, 568, 64], [390, 844, 88], [430, 932, 88]]) {
    const p = platform(width, height, top, language), app = sut.createApp(p);
    try {
      await until(() => app.getButtons().length > 0);
      for (const button of app.getButtons()) {
        assert.ok(button.x >= 0 && button.x + button.width <= width);
        assert.ok(button.y >= (button.id === 'account-avatar' ? top - 40 : top - 2)
          && button.y + button.height <= height - 24);
        if (button.id === 'account-avatar') assert.ok(button.x + button.width < width - 102, 'avatar stays left of the native capsule');
      }
      await until(() => app.getScene() === 'game' && !app.session.busy && app.getLayout());
      let [x, y] = sut.toScreen([1, 0], app.getLayout());
      const dense = app.getLayout().spacing < 28;
      p.callbacks.start({ touches: [{ clientX: x, clientY: y }] }); p.callbacks.end({ changedTouches: [{ clientX: x, clientY: y }] });
      if (dense) {
        await until(() => app.getLayout().spacing === 44);
        assert.equal(app.session.actions.length, 0);
        [x, y] = sut.toScreen([1, 0], app.getLayout());
        p.callbacks.start({ touches: [{ clientX: x, clientY: y }] }); p.callbacks.end({ changedTouches: [{ clientX: x, clientY: y }] });
      }
      await until(() => app.getButtons().find(b => b.id === 'confirm' && !b.disabled));
      assert.equal(app.session.actions.length, 0, 'selection must not play immediately');
      for (const b of app.getButtons()) assert.ok(b.y + b.height <= height - 24);
      p.callbacks.hide(); p.callbacks.show(); assert.equal(app.session.canPlay(), false);
    } finally { app.dispose(); }
  }
});

test('production main bundle starts with wx/Canvas only and keeps offline first launch offline', async () => {
  const p = platform(390, 844, 88), calls = { requests: 0, login: 0, workers: 0 };
  const api = {
    createCanvas: () => p.canvas, getWindowInfo: () => ({ windowWidth: 390, windowHeight: 844, pixelRatio: 3, safeArea: { top: 48, bottom: 810 } }),
    getMenuButtonBoundingClientRect: () => ({ bottom: 88 }),
    getStorageSync: p.storage.get, setStorageSync: p.storage.set,
    onTouchStart() {}, onTouchEnd() {}, onTouchMove() {}, onTouchCancel() {}, onWindowResize() {}, onHide() {}, onShow() {}, showShareMenu() {}, onShareAppMessage() {},
    getLaunchOptionsSync: () => ({}), request: () => { calls.requests++; }, login: () => { calls.login++; },
    createWorker: () => {
      calls.workers++;
      const worker = fakeWorker();
      worker.postMessage = message => setTimeout(async () => {
        if (!worker.terminated) worker.receive(await sut.handleWorkerMessage(message));
      }, 1);
      return worker;
    },
  };
  const source = await fs.readFile(new URL('../dist/game.js', import.meta.url), 'utf8');
  const sandbox = vm.createContext({ wx: api, requestAnimationFrame: () => 1, setTimeout, clearTimeout, setInterval, clearInterval });
  vm.runInContext(source, sandbox, { timeout: 2000 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls.requests, 0); assert.equal(calls.login, 0);
  assert.equal(calls.workers, 1, 'offline first launch initializes the playable board in the production Worker');
  const native = sut.createWxPlatform(api).metrics(); assert.equal(native.top, 88); assert.equal(native.dpr, 2);
});

test('a failed first STATE offers a working new-game recovery in both languages', async () => {
  for (const language of ['zh', 'en']) {
    const p = platform(320, 568, 64, language), texts = [], ctx = context();
    ctx.fillText = text => texts.push(String(text));
    p.canvas.getContext = () => ctx;
    let failOnce = true;
    p.createWorker = () => {
      const w = fakeWorker();
      w.postMessage = message => setTimeout(() => {
        if (w.terminated) return;
        const response = sut.handleWorkerMessage(message);
        if (failOnce) { response.context = {}; failOnce = false; }
        w.receive(response);
      }, 1);
      return w;
    };
    const app = sut.createApp(p);
    const tap = id => {
      const b = app.getButtons().find(button => button.id === id);
      assert.ok(b && !b.disabled, id); app.tap(b.x + 20, b.y + 20);
    };
    try {
      await until(() => app.getButtons().some(b => b.id === 'load-retry'));
      assert.equal(app.session.snapshot, null);
      assert.equal(app.session.error, 'STALE_WORKER_CONTEXT');
      assert.equal(texts.some(text => /正在核对最新进度|Checking the latest/.test(text)), false);
      const button = app.getButtons().find(b => b.id === 'load-retry');
      assert.ok(button.y + button.height <= 568 - 24);
      tap('load-retry');
      await until(() => app.session.canPlay() && app.getLayout());
      assert.equal(app.session.error, null);
      assert.equal(app.getButtons().some(b => b.id === 'load-retry'), false);
    } finally { app.dispose(); }
  }
});

test('last-action annotation follows the replay prefix and clears the old move marker after pass/resign', async () => {
  for (const language of ['zh', 'en']) {
    const p = platform(320, 568, 64, language), texts = [], markers = [];
    const ctx = context();
    ctx.fillRect = (_x, _y, w, h) => { if (w === h && w <= 8) markers.push([w, h]); };
    ctx.fillText = text => texts.push(String(text));
    p.canvas.getContext = () => ctx;
    const app = sut.createApp(p), last = () => texts.filter(t => t.startsWith(language === 'zh' ? '上一步 ·' : 'Last action ·'));
    let frameCount = 0;
    p.frame = fn => setTimeout(() => { texts.length = 0; markers.length = 0; fn(); frameCount++; }, 0);
    const render = async () => { const before = frameCount; app.redraw(); await until(() => frameCount > before); };
    try {
      await until(() => app.session.canPlay());
      await app.session.newGame(5, 'human');
      await app.session.act({ type: 'move', point: [1, 0] });
      await render(); assert.ok(last()[0]?.includes(language === 'zh' ? '落子' : 'Move')); assert.equal(markers.length, 1);
      await app.session.act({ type: 'skip' });
      await render(); assert.ok(last()[0]?.includes(language === 'zh' ? '跳过' : 'Pass')); assert.equal(markers.length, 0);
      await app.session.restore(); // Saved logs use player_move/player_skip without a stored actor.
      await render(); assert.ok(last()[0]?.includes(language === 'zh' ? '跳过' : 'Pass')); assert.equal(markers.length, 0);
      await app.session.replay(0);
      await render(); assert.equal(last().length, 0); assert.equal(markers.length, 0);
      await app.session.replay(1);
      await render(); assert.ok(last()[0]?.includes(language === 'zh' ? '落子' : 'Move')); assert.equal(markers.length, 1);
      await app.session.exitReplay(); app.session.resume();
      await app.session.act({ type: 'resign' });
      await render(); assert.ok(last()[0]?.includes(language === 'zh' ? '认输' : 'Resign')); assert.equal(markers.length, 0);
    } finally { app.dispose(); }
  }
});

test('account deletion asks before login, prevents a new room while pending and preserves the local game', async () => {
  const p = platform(320, 568, 64), messages = [], calls = [];
  let confirmed = false, confirmations = 0, release;
  p.confirm = async () => { confirmations++; return confirmed; };
  p.message = async text => messages.push(text);
  p.login = async () => { calls.push('login'); return 'test-only-code'; };
  p.request = async options => {
    calls.push(new URL(options.url).pathname);
    if (options.url.endsWith('/login')) return { token: 'fixture-token', expiresIn: 7200, protocol: 1 };
    assert.ok(options.url.endsWith('/account/delete'));
    await new Promise(resolve => { release = resolve; });
    return { deleted: true, protocol: 1 };
  };
  const app = sut.createApp(p, { onlineEnabled: true, apiBase: 'https://test.invalid' });
  const tap = id => {
    const button = app.getButtons().find(b => b.id === id);
    assert.ok(button && !button.disabled); app.tap(button.x + 1, button.y + 1);
  };
  try {
    await until(() => app.getButtons().length > 0);
    await app.session.newGame(7, 'human'); await app.session.act({ type: 'move', point: [1, 0] });
    const hash = app.session.stateHash;
    tap('cabin-battle'); await until(() => app.getButtons().some(b => b.id === 'account-privacy'));
    tap('account-privacy'); await until(() => app.getButtons().some(b => b.id === 'delete-account'));
    tap('delete-account'); await until(() => confirmations === 1);
    assert.equal(calls.length, 0, 'cancel must not create or log into an account');
    confirmed = true; tap('delete-account'); await until(() => release);
    assert.equal(app.online.deleting, true);
    await assert.rejects(app.online.enter('create', 7), /ACCOUNT_DELETION_PENDING/);
    await until(() => app.getButtons().find(b => b.id === 'delete-account')?.disabled);
    release(); await until(() => messages.length > 0 && !app.online.deleting);
    assert.ok(messages[0].includes('联机账号和相关房间已删除'));
    assert.equal(app.session.stateHash, hash); assert.equal(app.session.actions.length, 1);
    assert.equal(new sut.SaveStore(p.storage).read().payload.session.actions.length, 1);
    assert.equal(app.online.token, null);
  } finally { release?.(); app.dispose(); }
});

test('finished local games keep new-game and replay actions after replay exit and hide/show', async () => {
  const p = platform(390, 844, 88), app = sut.createApp(p);
  const tap = id => {
    const button = app.getButtons().find(b => b.id === id);
    assert.ok(button && !button.disabled, `${id} must be available`);
    app.tap(button.x + 1, button.y + 1);
  };
  const hasTerminalActions = () => ['new-game', 'replay'].every(id => app.getButtons().some(b => b.id === id && !b.disabled));
  try {
    await until(() => app.getScene() === 'game' && app.session.canPlay());
    await app.session.newGame(5, 'human');
    await app.session.act({ type: 'resign' });
    await until(hasTerminalActions);
    tap('replay');
    await until(() => app.session.replayIndex === 0 && !app.session.busy && app.getButtons().some(b => b.id === 'replay-next' && !b.disabled));
    tap('exit-replay');
    await until(hasTerminalActions, 1000);
    assert.equal(app.session.snapshot.gameOver, true);
    assert.equal(app.session.snapshot.winner, 'WHITE');
    assert.equal(app.getButtons().some(b => b.id === 'pause-resume'), false);
    p.callbacks.hide(); p.callbacks.show();
    await until(hasTerminalActions);
    assert.equal(app.session.canPlay(), false);
    tap('new-game');
    await until(() => app.session.canPlay() && app.session.actions.length === 0);
  } finally { app.dispose(); }
});

test('online disabled has no login side effect; malformed snapshots are rejected', async () => {
  let login = 0;
  const client = new sut.OnlineClient({ storage: memoryStorage(), login: () => { login++; } }, {}, { cancel() {} });
  await assert.rejects(client.authenticate(), /ONLINE_NOT_CONFIGURED/); assert.equal(login, 0);
  assert.throws(() => sut.validateRoom({ protocol: 99 }), /INVALID_ROOM/);
});

test('dense board zoom allows precise selection; drags, cancellation and old gestures never play', async () => {
  for (const language of ['zh', 'en']) {
    const p = platform(320, 568, 64, language), app = sut.createApp(p);
    const point = ([clientX, clientY]) => ({ clientX, clientY });
    const touch = xy => { p.callbacks.start({ touches: [point(xy)] }); p.callbacks.end({ changedTouches: [point(xy)] }); };
    const enabled = () => app.getButtons().some(b => b.id === 'confirm' && !b.disabled);
    const tapButton = id => { const b = app.getButtons().find(b => b.id === id); assert.ok(b && !b.disabled); touch([b.x + 20, b.y + 20]); };
    try {
      await until(() => app.session.canPlay()); await app.session.newGame(15, 'human');
      await until(() => app.getLayout()?.size === 15);
      const originalHash = app.session.stateHash, originalSave = new Map(p.storage.map);
      touch(sut.toScreen([2, 0], app.getLayout()));
      await until(() => app.getLayout().spacing === 44);
      assert.equal(enabled(), false, 'coarse tap opens zoom without choosing a move');
      p.callbacks.resize(); await new Promise(resolve => p.frame(resolve));
      assert.equal(app.getLayout().spacing, 44, 'an unchanged size notification must preserve the view');
      tapButton('board-zoom'); await until(() => app.getLayout().spacing < 28);
      touch(sut.toScreen([2, 0], app.getLayout())); await until(() => app.getLayout().spacing === 44);
      let center = sut.toScreen([2, 0], app.getLayout());
      touch([center[0] + 12, center[1]]);
      await until(enabled);
      // Drag away and back: the final position alone must not count as a tap.
      p.callbacks.start({ touches: [point(center)] });
      p.callbacks.move({ touches: [point([center[0] - 44, center[1]])] });
      await until(() => !enabled() && Math.abs(sut.toScreen([3, 0], app.getLayout())[0] - center[0]) < 0.001);
      p.callbacks.move({ touches: [point(center)] }); p.callbacks.end({ changedTouches: [point(center)] });
      await until(() => Math.abs(sut.toScreen([2, 0], app.getLayout())[0] - center[0]) < 0.001);
      assert.equal(enabled(), false);
      p.callbacks.start({ touches: [point(center)] }); p.callbacks.cancel({}); p.callbacks.end({ changedTouches: [point(center)] });
      p.callbacks.start({ touches: [point(center)] });
      p.callbacks.move({ touches: [point(center), point([center[0] + 40, center[1]])] });
      p.callbacks.end({ changedTouches: [point(center)] });
      assert.equal(enabled(), false);
      touch(sut.toScreen([14, 0], app.getLayout()));
      assert.equal(enabled(), false, 'clipped nodes outside the viewport must not be selectable');
      assert.equal(app.session.stateHash, originalHash); assert.deepEqual(p.storage.map, originalSave);
      touch([center[0] + 12, center[1]]); await until(enabled);
      tapButton('confirm'); await until(() => app.session.actions.length === 1 && !app.session.busy && app.getLayout().spacing < 28);
      assert.deepEqual(app.session.actions[0].point, [2, 0]);
      // A suspended gesture must not survive backgrounding or a replacement match.
      const redPoint = sut.toScreen([13, 0], app.getLayout());
      p.callbacks.start({ touches: [point(redPoint)] }); p.callbacks.hide(); p.callbacks.show();
      app.session.resume(); p.callbacks.end({ changedTouches: [point(redPoint)] });
      await until(() => app.getButtons().some(b => b.id === 'confirm'));
      assert.equal(app.getLayout().spacing < 28, true);
      assert.equal(enabled(), false); assert.equal(app.session.actions.length, 1);
      p.callbacks.start({ touches: [point(redPoint)] }); await app.session.newGame(9, 'human');
      p.callbacks.end({ changedTouches: [point(redPoint)] });
      await until(() => app.getLayout()?.size === 9);
      assert.equal(enabled(), false); assert.equal(app.session.actions.length, 0);
    } finally { app.dispose(); }
  }
});

test('zoom can inspect a replay without selecting a move, and exits to the full original board', async () => {
  const p = platform(320, 568, 64), app = sut.createApp(p);
  const tapButton = id => { const b = app.getButtons().find(b => b.id === id); assert.ok(b && !b.disabled); app.tap(b.x + 20, b.y + 20); };
  try {
    await until(() => app.session.canPlay()); await app.session.newGame(15, 'human');
    await app.session.act({ type: 'move', point: [2, 0] });
    const originalHash = app.session.stateHash;
    await app.session.replay(0);
    await until(() => app.getButtons().some(b => b.id === 'board-zoom' && !b.disabled));
    tapButton('board-zoom'); await until(() => app.getLayout().spacing === 44);
    app.tap(...sut.toScreen([5, 4], app.getLayout()));
    assert.equal(app.session.actions.length, 1); assert.equal(app.session.canPlay(), false);
    tapButton('exit-replay');
    await until(() => app.session.replayIndex === null && app.getLayout().spacing < 28);
    assert.equal(app.session.stateHash, originalHash);
  } finally { app.dispose(); }
});

test('simultaneous HTTP and socket acknowledgements share one verification', async () => {
  const scheduler = localScheduler(), client = new sut.OnlineClient({ storage: memoryStorage() }, {}, scheduler);
  const request = scheduler.request.bind(scheduler); let requests = 0;
  scheduler.request = (...args) => { requests++; return request(...args); };
  const settings = sut.settingsFor(), view = sut.executeTask({ kind: 'STATE', payload: { settings, actions: [] } });
  const room = { protocol: 1, code: 'ABCDEFGH', matchId: 'a'.repeat(32), revision: 1, seq: 0, settings,
    actions: [], actionIds: [], status: 'waiting', currentPlayer: 'BLACK', player: 'BLACK', stateHash: view.stateHash,
    ready: { BLACK: false, WHITE: false }, members: { BLACK: true, WHITE: false }, rematchVotes: { BLACK: false, WHITE: false } };
  client.active = true;
  try {
    const first = client.receive(room), second = client.receive(JSON.parse(JSON.stringify(room)));
    assert.equal(first, second); assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.equal(requests, 1); assert.equal(client.game.stateHash, view.stateHash);
  } finally { client.detach(); scheduler.cancel(); }
});
