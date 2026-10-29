// Real Mini UI/Worker source -> native anonymous transport -> loopback HTTP.
// The harness is not a WeChat device and never accesses a real account/server.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { uiHarness } from './ui-harness.mjs';
import { sut, memoryStorage, until } from './helpers.mjs';
import { createAnonymousContributionRequest } from '../src/contribution-transport.js';

const [origin, output] = process.argv.slice(2);
assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
assert.ok(output);
const requests = [], results = [];
const contributionRequest = createAnonymousContributionRequest({ request(options) {
  const url = new URL(options.url);
  assert.equal(url.origin, 'https://fixture.invalid');
  assert.ok(['/api/training/contributions', '/api/training/contributions/status'].includes(url.pathname));
  assert.equal(options.enableCookie, false);
  assert.deepEqual(Object.keys(options.header), ['Content-Type']);
  const abort = new AbortController();
  const item = { method: options.method, path: url.pathname, payload: options.data, status: null, receipt: null };
  requests.push(item);
  fetch(origin + url.pathname, { method: options.method, headers: options.header,
    ...(options.method === 'GET' ? {} : { body: JSON.stringify(options.data) }), signal: abort.signal })
    .then(async response => {
      const data = await response.json(); item.status = response.status; item.receipt = data;
      options.success({ statusCode: response.status, data });
    }, error => options.fail({ errMsg: error.name }));
  return { abort: () => abort.abort() };
} });

for (const kind of ['diamond', 'root-add', 'double-torus', 'custom']) {
  const storage = memoryStorage();
  sut.savePreferences(storage, { size: 5, mode: 'human', difficulty: 'simple', playerCount: 2 });
  const h = uiHarness({ storage, config: { onlineEnabled: true, apiBase: 'https://fixture.invalid' },
    platformOverrides: { contributionRequest } });
  try {
    await until(() => h.app.session.snapshot && !h.app.session.busy);
    await h.tap('cabin-board'); await h.scrollTo('training-contribution'); await h.tap('training-contribution');
    assert.equal(JSON.parse(storage.get('lifeline-wx-training-contribution-v1')).enabled, true);
    if (kind === 'diamond' || kind === 'root-add') {
      await h.scrollTo(kind === 'diamond' ? 'shape-diamond' : 'root-add');
      await h.tap(kind === 'diamond' ? 'shape-diamond' : 'root-add');
      await h.tap('cabin-close'); await h.tap('new-game');
      await until(() => !h.app.session.busy);
      if (kind === 'root-add') {
        for (let turn = 0; turn < 80 && !h.app.session.snapshot.legalRootActions?.length; turn++) {
          const move = h.app.session.snapshot.legalMoves[0]; assert.ok(move);
          assert.equal(await h.app.session.act({ type: 'move', point: move.point ?? move }), true);
        }
        const action = h.app.session.snapshot.legalRootActions[0]; assert.ok(action);
        await h.render(); await h.tap('root-action');
        h.app.tap(...sut.toScreen(action.point, h.app.getLayout())); await h.render(); await h.tap('confirm');
        await until(() => !h.app.session.busy && h.app.session.actions.some(action => /root_add/.test(action.type)));
      }
    } else {
      await h.scrollTo('topology-setup'); await h.tap('topology-setup');
      if (kind === 'double-torus') {
        await h.scrollTo('topology-double-torus'); await h.tap('topology-double-torus');
      } else {
        await h.scrollTo('topology-custom'); await h.tap('topology-custom'); await h.scrollTo('topology-add-boundary');
        for (const coordinate of [[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]]) {
          const point = h.app.getTopologyLayout().gridPoints.find(p => p.coordinate.join(',') === coordinate.join(','));
          assert.ok(point); h.app.tap(point.x, point.y); await h.render();
        }
        assert.equal(h.app.getTopologyLayout().closed, true);
      }
      await h.scrollTo('topology-start'); await h.tap('topology-start');
      await until(() => h.app.session.snapshot?.rulesVersion === 'surface-v1' && !h.app.session.busy);
      await h.render();
      const vertexId = h.app.session.snapshot.legalMoves[0].vertexId;
      const copy = h.app.getLayout().projected.pointCopies.find(point => point.canonicalVertexId === vertexId);
      h.app.tap(copy.x, copy.y); await h.render(); await h.tap('confirm');
      await until(() => h.app.session.actions.length === 1 && !h.app.session.busy);
    }
    const before = requests.length;
    await h.render(); await h.tap('resign');
    await until(() => h.app.session.snapshot.gameOver && !h.app.session.busy);
    await until(() => requests.slice(before).some(request => request.method === 'POST' && request.status !== null), 30000);
    const post = requests.slice(before).find(request => request.method === 'POST');
    assert.equal(post.status, 200, `${kind}: ${JSON.stringify(post.receipt)}`);
    assert.equal(post.payload.version, 4); assert.equal(post.receipt.status, 'awaiting_review');
    await until(() => JSON.parse(storage.get('lifeline-wx-training-contribution-v1')).queue.length === 0);
    if (kind === 'root-add') assert.ok(post.payload.replay.actions.some(action => /root_add/.test(action.type)));
    if (kind === 'double-torus' || kind === 'custom') {
      assert.equal(post.payload.replay.engineFamily, 'lifeline-topology-engine');
      assert.ok(post.payload.replay.finalState.topologyState.ruleState.logicPaths.some(path => path.edgeOccurrences.length));
    }
    results.push({ kind, version: 4, httpStatus: post.status, receiptStatus: post.receipt.status,
      gameId: post.receipt.game_id, requestBytes: Buffer.byteLength(JSON.stringify(post.payload)) });
  } finally { h.app.dispose(); }
}
await fs.writeFile(output, JSON.stringify({ status: 'PASS_MINI_UI_WORKER_REAL_LOOPBACK_HTTP',
  scope: 'Synthetic games, UI/Worker harness and real HTTP collector; not a WeChat device',
  authenticatedRequests: 0, productionRequests: 0, results }, null, 2));
console.log(JSON.stringify({ status: 'PASS_MINI_UI_WORKER_REAL_LOOPBACK_HTTP', games: results.length }));
