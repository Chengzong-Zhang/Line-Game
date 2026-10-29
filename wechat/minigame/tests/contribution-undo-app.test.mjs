// The V3 collector keeps the real undo declaration while consent and match
// boundaries remain explicit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { until, memoryStorage } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';

test('a newly started consented territory-v3 match uploads its actual undo use after terminal completion', async () => {
  const uploads = [];
  const storage = memoryStorage();
  storage.set('lifeline-wx-preferences-v1', JSON.stringify({ size: 5, mode: 'human', difficulty: 'normal',
    controllers: { BLACK: 'human', WHITE: 'human' },
    playOptions: { hintEnabled: false, hintMaxCount: 3, turnTimerEnabled: false, turnTimeLimitSeconds: 60,
      undoEnabled: true, undoMaxCount: 3 } }));
  const h = uiHarness({ storage, config: { apiBase: 'https://fixture.invalid', onlineEnabled: true }, platformOverrides: {
    confirm: async () => true,
    contributionRequest: request => {
      if (request.method === 'GET') return { promise: Promise.resolve({ status: 200, data: {
        enabled: true, supported_versions: [1, 2, 3],
        consent_policies: { 2: 'anonymous-replay-training-v2', 3: 'anonymous-replay-training-v3' },
      } }), abort() {} };
      uploads.push(request.data);
      return { promise: Promise.resolve({ status: 200, data: { game_id: 'a'.repeat(64), status: 'awaiting_review' } }), abort() {} };
    },
  } });
  try {
    await until(() => h.app.session.snapshot && !h.app.session.busy);
    await h.render();
    assert.equal(h.app.session.settings.rulesVersion, 'territory-v3');
    await h.tap('cabin-board'); await h.scrollTo('training-contribution');
    assert.equal(h.app.getButtons().find(button => button.id === 'training-contribution').disabled, false);
    await h.tap('training-contribution'); await h.tap('cabin-close');
    await h.tap('new-game');
    await until(() => !h.app.session.actions.length && !h.app.session.busy);
    const before = h.app.session.actions.length;
    for (let index = 0; index < 2; index++) {
      const point = h.app.session.snapshot.legalMoves[index].point;
      assert.equal((await h.app.session.act({ type: 'move', point })), true);
      await until(() => h.app.session.actions.length === before + index + 1 && !h.app.session.busy);
    }
    await h.render(); await h.tap('undo'); await until(() => !h.app.session.busy && h.app.session.undoUsage.usedCount === 1);
    assert.equal(h.app.session.actions.length, before);
    await h.tap('resign'); await until(() => h.app.session.snapshot.gameOver && !h.app.session.busy);
    await until(() => uploads.length === 1);
    assert.equal(uploads[0].version, 3);
    assert.equal(uploads[0].replay.config.rulesVersion, 'territory-v3');
    assert.deepEqual(uploads[0].context.undo, { enabled: true, maxCount: 3, usedCount: 1 });
  } finally { h.app.dispose(); }
});
