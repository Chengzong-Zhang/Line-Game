import test from 'node:test';
import assert from 'node:assert/strict';
import { uiHarness } from './ui-harness.mjs';
import { until } from './helpers.mjs';

test('a touch started in a cancelled editor cannot affect a subsequently selected surface', async () => {
  const h = uiHarness();
  try {
    await until(() => h.app.session.snapshot && !h.app.session.busy);
    await h.tap('cabin-board'); await h.scrollTo('topology-custom'); await h.tap('topology-custom');
    await h.tap('editor-tool-contour'); await h.tap('editor-clear');
    const point = h.app.getEditorLayout().gridPoints.find(p => p.coordinate.join(',') === '1,1');
    h.p.callbacks.start({ touches: [{ clientX: point.x, clientY: point.y }] });
    await h.tap('editor-cancel');
    await h.scrollTo('topology-setup'); await h.tap('topology-setup');
    await h.scrollTo('topology-cylinder'); await h.tap('topology-cylinder');
    h.p.callbacks.end({ touches: [], changedTouches: [{ clientX: point.x, clientY: point.y }] });
    await h.render(); await h.scrollTo('new-game'); await h.tap('new-game');
    await until(() => h.app.session.snapshot?.rulesVersion === 'surface-v1' && !h.app.session.busy);
    assert.equal(h.app.session.settings.boardDefinition.topology.preset, 'cylinder');
    assert.equal(h.app.session.controllerFor('BLACK'), 'human');
  } finally { h.app.dispose(); }
});
