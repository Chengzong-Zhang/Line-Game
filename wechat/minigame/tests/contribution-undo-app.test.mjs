// The V2 collector stays covered at its protocol boundary; default V3 app
// sessions must not create upload tickets, including after undo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { until, memoryStorage } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';

test('default territory-v3 remains ineligible after undo and terminal completion', async () => {
  const uploads = [];
  const storage = memoryStorage();
  storage.set('lifeline-wx-preferences-v1', JSON.stringify({ size: 5, mode: 'human', difficulty: 'normal',
    controllers: { BLACK: 'human', WHITE: 'human' },
    playOptions: { hintEnabled: false, hintMaxCount: 3, turnTimerEnabled: false, turnTimeLimitSeconds: 60,
      undoEnabled: true, undoMaxCount: 3 } }));
  const h = uiHarness({ storage, platformOverrides: {
    contributionRequest: request => { uploads.push(request); return { promise: Promise.resolve({ status: 200 }), abort() {} }; },
  } });
  try {
    await until(() => h.app.session.snapshot && !h.app.session.busy);
    await h.render();
    assert.equal(h.app.session.settings.rulesVersion, 'territory-v3');
    const before = h.app.session.actions.length;
    for (let index = 0; index < 2; index++) {
      const point = h.app.session.snapshot.legalMoves[index].point;
      assert.equal((await h.app.session.act({ type: 'move', point })), true);
      await until(() => h.app.session.actions.length === before + index + 1 && !h.app.session.busy);
    }
    await h.render(); await h.tap('undo'); await until(() => !h.app.session.busy && h.app.session.undoUsage.usedCount === 1);
    assert.equal(h.app.session.actions.length, before);
    await h.tap('resign'); await until(() => h.app.session.snapshot.gameOver && !h.app.session.busy);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.deepEqual(uploads, []);
    await h.tap('cabin-board'); await h.scrollTo('training-contribution');
    assert.equal(h.app.getButtons().find(button => button.id === 'training-contribution').disabled, true);
  } finally { h.app.dispose(); }
});
