import test from 'node:test';
import assert from 'node:assert/strict';
import { uiHarness } from './ui-harness.mjs';
import { until } from './helpers.mjs';

test('an old topology player sheet cannot change a subsequently opened surface', async () => {
  let release, choices = 0;
  const h = uiHarness({ platformOverrides: { choose: () => {
    choices++;
    return choices === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve(1);
  } } });
  try {
    await until(() => h.app.session.snapshot && !h.app.session.busy);
    await h.tap('cabin-board'); await h.scrollTo('topology-setup'); await h.tap('topology-setup');
    await h.tap('topology-torus'); await h.scrollTo('topology-controllers'); await h.tap('topology-controllers');
    assert.equal(choices, 1);
    await h.tap('topology-back'); await h.scrollTo('topology-setup'); await h.tap('topology-setup');
    await h.tap('topology-cylinder');
    release(0); await new Promise(resolve => setTimeout(resolve, 10)); await h.render();
    assert.equal(choices, 1, 'a stale first sheet must not open a second sheet on the new surface');
    await h.scrollTo('topology-start'); await h.tap('topology-start');
    await until(() => h.app.session.snapshot?.rulesVersion === 'surface-v1' && !h.app.session.busy);
    assert.equal(h.app.session.controllerFor('BLACK'), 'human');
    assert.equal(h.app.session.settings.boardDefinition.topology.preset, 'cylinder');
  } finally { release?.(-1); h.app.dispose(); }
});
