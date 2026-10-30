import assert from 'node:assert/strict';
import test from 'node:test';
import { until } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';

async function ready(harness) {
  await until(() => harness.app.session.snapshot && !harness.app.session.busy);
  await harness.render();
}

test('topology setup starts a canonical local match and UI submits vertexId actions only', async () => {
  const h = uiHarness();
  try {
    await ready(h);
    await h.tap('cabin-board');
    await h.scrollTo('topology-setup');
    await h.tap('topology-setup');
    assert.equal(h.app.getScene(), 'home');

    await h.scrollTo('topology-torus');
    await h.tap('topology-torus');
    await h.scrollTo('new-game');
    await h.tap('new-game');
    await until(() => h.app.session.snapshot?.rulesVersion === 'surface-v1' && !h.app.session.busy);
    await h.render();

    const { settings, snapshot } = h.app.session;
    assert.equal(settings.rulesVersion, 'surface-v1');
    assert.equal(settings.boardShape, 'custom');
    assert.equal(settings.rootMode, 'classic');
    assert.equal(settings.rootRulesVersion, 'root-v1');
    assert.equal(settings.topologyProtocolVersion, 'board-topology-v1');
    assert.match(settings.boardHash, /^[a-f0-9]{64}$/);
    assert.ok(settings.boardDefinition);

    const vertexId = snapshot.legalMoves[0].vertexId;
    const layout = h.app.getLayout();
    const copy = layout.projected.pointCopies.find(point => point.canonicalVertexId === vertexId);
    assert.ok(copy, 'a legal canonical vertex has a visible chart copy');
    h.app.tap(copy.x, copy.y);
    await h.render();
    assert.equal(h.app.getButtons().find(button => button.id === 'confirm')?.disabled, false);

    await h.tap('confirm');
    await until(() => h.app.session.actions.length >= 1 && !h.app.session.busy);
    const first = h.app.session.actions[0];
    assert.equal(first.type, 'move');
    assert.equal(typeof first.vertexId, 'string');
    assert.equal(Object.hasOwn(first, 'point'), false);
  } finally {
    h.app.dispose();
  }
});

test('missing native WebGL is disclosed without changing the topology match', async () => {
  const h = uiHarness();
  try {
    await ready(h); await h.tap('cabin-board'); await h.scrollTo('topology-setup'); await h.tap('topology-setup');
    await h.scrollTo('topology-torus'); await h.tap('topology-torus'); await h.scrollTo('new-game'); await h.tap('new-game');
    await until(() => h.app.session.snapshot?.rulesVersion === 'surface-v1' && !h.app.session.busy);
    const before = h.app.session.stateHash;
    await h.render(); await h.tap('topology-3d');
    assert.equal(h.app.getScene(), 'topology-3d');
    assert.ok(h.app.getButtons().some(button => button.id === 'surface-back'));
    await h.tap('surface-back');
    assert.equal(h.app.getScene(), 'game');
    assert.equal(h.app.session.stateHash, before);
  } finally { h.app.dispose(); }
});
