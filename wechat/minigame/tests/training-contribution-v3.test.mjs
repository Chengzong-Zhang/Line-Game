import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TrainingContribution,
  CONTRIBUTION_STORAGE,
  CONTRIBUTION_V3_POLICY,
  contributionContext,
} from '../src/training-contribution.js';
import { createReplayDocument } from '../../../web/web前端/ReplayCodec.js';
import { validateContribution } from '../../../web/tools/validate_contribution.mjs';
import { contributionV3ProfileChoices } from '../../../web/tools/training_contribution_schema.mjs';
import { controllerChoices } from '../src/controllers.js';
import { checksum } from '../src/integrity.js';

const settings = {
  rulesVersion: 'territory-v3',
  gridSize: 5,
  playerCount: 2,
  startPlayer: 'BLACK',
  hintEnabled: false,
  hintMaxCount: 3,
  turnTimerEnabled: false,
  turnTimeLimitSeconds: 60,
  undoEnabled: true,
  undoMaxCount: 3,
};
const actions = [{ type: 'skip', player: 'BLACK' }, { type: 'skip', player: 'WHITE' }];
const replay = (config, list) => createReplayDocument(config, list, checksum);
const context = usedCount => contributionContext({
  settings,
  controllerFor: () => 'human',
  undoUsage: { usedCount },
});

function harness(status) {
  const values = new Map(), posts = [], statuses = [];
  const storage = {
    get: key => values.get(key),
    set: (key, value) => values.set(key, value),
    remove: key => values.delete(key),
  };
  const request = request => {
    if (request.method === 'GET') {
      statuses.push(request);
      return { promise: Promise.resolve({ status: 200, data: status }), abort() {} };
    }
    posts.push(request.data);
    return { promise: validateContribution(request.data).then(verified => ({
      status: 200,
      data: { game_id: verified.game_id, status: 'awaiting_review' },
    })), abort() {} };
  };
  const client = new TrainingContribution({
    storage,
    request,
    origin: 'https://fixture.invalid',
    createReplay: replay,
    setTimer: () => 1,
    clearTimer() {},
  });
  return { client, values, posts, statuses, storage };
}

function capture(client, ctx = context(1)) {
  const ticket = client.beginMatch({ settings, context: context(0), source: 'local', actionCount: 0 });
  assert.ok(ticket);
  return client.captureCompletedMatch(ticket, {
    settings,
    actions,
    context: ctx,
    source: 'local',
    terminal: true,
  });
}

test('every selectable 2–6 player Mini profile matches the shared v3 anonymous schema', () => {
  let cases = 0;
  for (let playerCount = 2; playerCount <= 6; playerCount += 1) {
    for (const boardShape of ['triangle', 'hexagon']) {
      for (let gridSize = 5; gridSize <= 15; gridSize += 1) {
        const config = { rulesVersion: 'territory-v3', playerCount, boardShape, gridSize };
        assert.deepEqual([...controllerChoices(config)].sort(), [...contributionV3ProfileChoices(config)].sort(), JSON.stringify(config));
        cases += 1;
      }
    }
  }
  assert.equal(cases, 110);
});

test('v3 is an independent opt-in protocol and uploads only after exact capability discovery', async () => {
  const h = harness({
    enabled: true,
    supported_versions: [1, 2, 3],
    consent_policies: { 2: 'anonymous-replay-training-v2', 3: CONTRIBUTION_V3_POLICY },
  });
  assert.equal(h.client.version, 3);
  assert.deepEqual(context(0).undo, { enabled: true, maxCount: 3, usedCount: 0 });
  assert.equal(h.client.enabled, false);
  h.client.setEnabled(true);
  assert.equal(capture(h.client), true);
  await h.client.flush();
  assert.equal(h.statuses.length, 1);
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].version, 3);
  assert.equal(h.posts[0].consent_policy, 'anonymous-replay-training-v3');
  assert.equal(h.posts[0].replay.config.rulesVersion, 'territory-v3');
  assert.deepEqual(h.posts[0].context.undo, { enabled: true, maxCount: 3, usedCount: 1 });
});

test('missing version 3 or a mismatched v3 policy never sends replay data and retains the outbox', async () => {
  for (const status of [
    { enabled: true, supported_versions: [1, 2], consent_policies: { 2: 'anonymous-replay-training-v2' } },
    { enabled: true, supported_versions: [1, 2, 3], consent_policies: { 3: 'foreign-policy' } },
    { enabled: false, supported_versions: [3], consent_policies: { 3: CONTRIBUTION_V3_POLICY } },
  ]) {
    const h = harness(status);
    h.client.setEnabled(true);
    assert.equal(capture(h.client), true);
    await h.client.flush();
    assert.equal(h.posts.length, 0);
    assert.equal(h.client.queue.length, 1);
    assert.equal(h.client.reason, 'PROTOCOL_NOT_AVAILABLE');
  }
});

test('v3 outbox survives restart but every launch requires fresh consent', () => {
  const h = harness({ enabled: true, supported_versions: [3], consent_policies: { 3: CONTRIBUTION_V3_POLICY } });
  h.client.setEnabled(true);
  assert.equal(capture(h.client), true);
  const stored = JSON.parse(h.values.get(CONTRIBUTION_STORAGE));
  assert.equal(stored.policy, CONTRIBUTION_V3_POLICY);
  assert.equal(stored.queue[0].version, 3);
  const restored = new TrainingContribution({
    storage: h.storage,
    request: () => { throw new Error('must not upload without fresh consent'); },
    origin: 'https://fixture.invalid',
    createReplay: replay,
  });
  assert.equal(restored.enabled, false);
  assert.equal(restored.queue.length, 1);
  assert.equal(restored.reason, 'RESUME_CONSENT_REQUIRED');
});

test('v3 sanitizer rejects v2 games and identity-bearing anonymous context', () => {
  const h = harness({ enabled: true, supported_versions: [3], consent_policies: { 3: CONTRIBUTION_V3_POLICY } });
  h.client.setEnabled(true);
  const ctx = context(0);
  assert.equal(h.client.beginMatch({ settings: { ...settings, rulesVersion: 'territory-v2' }, context: ctx, source: 'local', actionCount: 0 }), null);
  assert.equal(h.client.beginMatch({ settings, context: { ...ctx, nickname: 'private' }, source: 'local', actionCount: 0 }), null);
  assert.equal(h.client.queue.length, 0);
});
