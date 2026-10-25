// Maintained by the deployment/review task: exercise rendered controls through
// the actual app while keeping layout implementation in the UI owner's files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { uiHarness } from './ui-harness.mjs';
import { sut, until } from './helpers.mjs';

for (const language of ['zh', 'en']) for (const [width, height, top] of [[320, 568, 64], [390, 844, 88], [430, 932, 88]]) {
  test(`${language}/${width}: core controls never overlap across play, failure, replay and result states`, async () => {
    const h = uiHarness({ language, width, height, top });
    const check = async state => {
      await h.render();
      const buttons = h.app.getButtons();
      for (const [index, a] of buttons.entries()) {
        assert.ok(a.x >= 0 && a.x + a.width <= width && a.y >= (a.id === 'account-avatar' ? top - 40 : top)
          && a.y + a.height <= height - 24, `${state}: outside safe area: ${a.id}`);
        for (const b of buttons.slice(index + 1)) assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x
          || a.y + a.height <= b.y || b.y + b.height <= a.y, `${state}: overlapping actions: ${a.id}/${b.id}`);
      }
    };
    try {
      await until(() => h.app.session.snapshot && !h.app.session.busy);
      await check('initial');
      h.app.session.pause(); await check('paused');
      // Storage failure is injected at the view boundary to cover retry affordances.
      h.app.session.saveError = true; await check('save-error'); h.app.session.saveError = false;
      await h.app.session.load(sut.settingsFor(6, 3), [{ type: 'move', point: [1, 0] }], { mode: 'human', paused: true });
      await check('three-player');
      await h.app.session.replay(0); await check('replay');
      h.app.session.saveError = true; await check('save-error-replay'); h.app.session.saveError = false;
      await h.app.session.exitReplay();
      await h.app.session.load(sut.settingsFor(6, 3), [{ type: 'resign', player: 'WHITE' }, { type: 'resign', player: 'BLACK' }],
        { mode: 'human', paused: true });
      await check('ended');
      await h.app.session.tutorialLevel(3); await check('lesson');
    } finally { h.app.dispose(); }
  });
}
