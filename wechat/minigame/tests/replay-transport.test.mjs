import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, until, plain } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';

const log = [{ type: 'move', point: [1, 0] }, { type: 'move', point: [0, 2] }, { type: 'move', point: [3, 1] }];
const stable = session => { const payload = plain(session.capture()); delete payload.session.savedAt; return payload; };

test('four graphical navigation buttons share one row; playback, seek and speed share the second row at every size', async () => {
  for (const language of ['zh', 'en']) for (const [width, height, top] of [[320, 568, 64], [390, 844, 88], [430, 932, 88]]) {
    const h = uiHarness({ language, width, height, top }), { app, p, tap, render } = h;
    try {
      await render(); await app.session.load(sut.settingsFor(5, 3), log, { mode: 'human', paused: true });
      const original = stable(app.session), hash = app.session.stateHash;
      await app.session.replay(1); await render();
      const by = id => app.getButtons().find(button => button.id === id);
      const nav = ['replay-first', 'replay-prev', 'replay-next', 'replay-last'].map(by);
      assert.ok(nav.every(button => button && button.y === nav[0].y && button.height >= 44));
      const playback = ['replay-play', 'replay-timeline', 'replay-speed'].map(by);
      assert.ok(playback.every(button => button && button.y === playback[0].y && button.y > nav[0].y));
      assert.ok(by('exit-replay').y > playback[0].y);
      assert.equal(h.texts.some(text => /[◀▶Ⅱ]/.test(text)), false, 'Transport symbols use Canvas paths, independent of device font support');
      for (const [index, a] of app.getButtons().entries()) {
        assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.width <= width && a.y + a.height <= height - 24, a.id);
        for (const b of app.getButtons().slice(index + 1))
          assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, `${a.id}/${b.id}`);
      }
      await tap('replay-first'); await until(() => !app.session.busy); assert.equal(app.session.replayIndex, 0);
      await tap('replay-last'); await until(() => !app.session.busy); assert.equal(app.session.replayIndex, 3);
      await tap('replay-prev'); await until(() => !app.session.busy); assert.equal(app.session.replayIndex, 2);
      await tap('replay-next'); await until(() => !app.session.busy); assert.equal(app.session.replayIndex, 3);
      p.choose = async () => 2; await tap('replay-speed'); assert.equal(app.session.replayInterval, 500);
      await render(); const bar = by('replay-timeline'), y = bar.y + bar.height / 2;
      p.callbacks.start({ touches: [{ clientX: bar.x + bar.width - 12, clientY: y }] });
      p.callbacks.move({ touches: [{ clientX: bar.x + 12, clientY: y }] });
      await render(); assert.equal(app.session.replayIndex, 3, 'A drag previews the cursor and commits once on release');
      p.callbacks.end({ changedTouches: [{ clientX: bar.x + 12, clientY: y }], touches: [] });
      await until(() => !app.session.busy && app.session.replayIndex === 0);
      app.session.replayInterval = 1000; await tap('replay-play'); assert.equal(app.session.replayPlaying, true);
      await tap('replay-play'); assert.equal(app.session.replayPlaying, false);
      assert.equal(app.session.stateHash, hash); assert.deepEqual(stable(app.session), original);
    } finally { app.dispose(); }
  }
});

test('board display is in the board cabin and absent from the replay workspace and replay navigation', async () => {
  const h = uiHarness();
  try {
    await h.render(); await h.app.session.load(sut.settingsFor(5, 3), log, { mode: 'human', paused: true });
    await h.tap('cabin-board'); assert.ok(h.app.getButtons().some(button => button.id === 'display-open'));
    await h.tap('display-open'); await h.tap('display-coordinates'); await h.tap('display-back');
    assert.equal(h.app.getCabin(), 'board');
    await h.scrollTo('replay-mode'); await h.tap('replay-mode');
    assert.equal(h.app.getButtons().some(button => button.id.includes('display')), false);
    await h.tap('replay-current'); await until(() => !h.app.session.busy);
    await h.tap('replay-options');
    assert.equal(h.app.getButtons().some(button => button.id.includes('display')), false);
  } finally { h.app.dispose(); }
});

test('a compact six-player replay retains board space and exposes analysis, inspection and try-from-here in navigation', async () => {
  const h = uiHarness({ width: 320, height: 568, top: 64 });
  try {
    await h.render(); const settings = sut.settingsFor(5, 6), engine = sut.restoreGame(settings, []);
    const point = engine.getSnapshot().legalMoves[0].point;
    await h.app.session.load(settings, [{ type: 'move', point }], { mode: 'human', paused: true });
    await h.app.session.replay(0); await h.render();
    assert.ok(h.app.getLayout().height >= 100, 'The board retains usable overview space');
    await h.tap('replay-options');
    for (const id of ['tool-analyzeReplay', 'tool-inspectReplay', 'tool-branchReplay'])
      assert.equal(h.app.getButtons().find(button => button.id === id)?.disabled, false, id);
    await h.tap('tool-branchReplay'); assert.equal(h.app.getScene(), 'branch');
  } finally { h.app.dispose(); }
});

test('analysis offers every existing AI on all player counts and marks unsupported choices without substituting', async () => {
  const profiles = new Set([...sut.BASIC_CONTROLLERS.filter(profile => profile !== 'human'),
    ...sut.MODEL_CATALOG.map(model => model.profile), ...sut.MULTIPLAYER_AI_CATALOG.map(model => model.profile)]);
  for (const count of [2, 3, 4, 5, 6]) {
    const settings = sut.settingsFor(5, count), choices = sut.replayAnalysisChoices(settings);
    assert.deepEqual(new Set(choices.map(choice => choice.profile)), profiles);
    assert.deepEqual(choices.filter(choice => choice.supported).map(choice => choice.profile).sort(), sut.controllerChoices(settings).filter(profile => profile !== 'human').sort());
  }
  const h = uiHarness();
  try {
    await h.render(); await h.app.session.load(sut.settingsFor(5, 3), log, { mode: 'human', paused: true });
    await h.app.session.replay(0); await h.tap('replay-analyzeReplay'); await until(() => !h.app.session.busy);
    const hash = h.app.session.stateHash, before = stable(h.app.session); let offered;
    h.p.choose = async options => { offered = options; return 0; };
    await h.tap('analysis-choose');
    assert.equal(offered.length, profiles.size);
    assert.ok(offered[0].includes('当前棋盘不适用')); assert.ok(h.p.messages.at(-1).includes('暂不支持'));
    assert.equal(h.app.session.stateHash, hash); assert.deepEqual(stable(h.app.session), before);
  } finally { h.app.dispose(); }
});
