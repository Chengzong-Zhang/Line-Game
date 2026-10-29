import test from 'node:test';
import assert from 'node:assert/strict';
import { until, memoryStorage } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';
import { TrainingContribution } from '../src/training-contribution.js';

const KEY = 'lifeline-wx-training-contribution-v1';
const saved = storage => JSON.parse(storage.get(KEY) || '{"enabled":false,"queue":[]}');
function seedPendingV2(storage) {
  const legacy = new TrainingContribution({ storage, canRun: () => false, version: 2 });
  const settings = { rulesVersion: 'territory-v2', gridSize: 5, playerCount: 2, startPlayer: 'BLACK',
    hintEnabled: false, hintMaxCount: 3, turnTimerEnabled: false, turnTimeLimitSeconds: 60, undoEnabled: false, undoMaxCount: 3 };
  const context = { source: 'local', actors: { BLACK: { kind: 'human' }, WHITE: { kind: 'human' } },
    mixedProfiles: false, hintsEnabled: false, undo: { enabled: false, maxCount: 3, usedCount: 0 } };
  legacy.setEnabled(true);
  const ticket = legacy.beginMatch({ settings, context, source: 'local', actionCount: 0 });
  assert.ok(ticket);
  assert.equal(legacy.captureCompletedMatch(ticket, { settings, actions: [{ type: 'skip', player: 'BLACK' }],
    context, source: 'local', terminal: true }), true);
  legacy.dispose();
}

test('default territory-v3 offers explicit consent, never backfills the current match, and uploads the next complete local match', async () => {
  const storage = memoryStorage(), confirmations = [], uploads = [];
  const h = uiHarness({ storage, config: { onlineEnabled: true, apiBase: 'https://fixture.invalid' }, platformOverrides: {
    confirm: async message => { confirmations.push(message); return true; },
    contributionRequest: request => {
      if (request.method === 'GET') return { promise: Promise.resolve({ status: 200, data: {
        enabled: true,
        supported_versions: [1, 2, 3],
        consent_policies: { 2: 'anonymous-replay-training-v2', 3: 'anonymous-replay-training-v3' },
      } }), abort() {} };
      uploads.push(request.data);
      return { promise: Promise.resolve({ status: 200, data: { game_id: 'a'.repeat(64), status: 'awaiting_review' } }), abort() {} };
    },
  } });
  try {
    await until(() => h.app.session.snapshot && !h.app.session.busy);
    assert.equal(h.app.session.settings.rulesVersion, 'territory-v3');
    await h.tap('cabin-board'); await h.scrollTo('training-contribution'); await h.render();
    const toggle = h.app.getButtons().find(button => button.id === 'training-contribution');
    assert.equal(toggle.disabled, false);
    assert.ok(h.texts.some(text => /帮 AI 学下棋/.test(text)));
    await h.tap('training-contribution');
    assert.equal(confirmations.length, 1);
    assert.match(confirmations[0], /territory-v3/);
    assert.equal(saved(storage).enabled, true);
    await h.tap('cabin-close'); await h.tap('resign'); await until(() => h.app.session.snapshot.gameOver);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.deepEqual(uploads, []);
    await h.tap('new-game');
    await until(() => !h.app.session.snapshot.gameOver && !h.app.session.actions.length && !h.app.session.busy);
    await h.tap('resign');
    await until(() => h.app.session.snapshot.gameOver);
    await until(() => uploads.length === 1);
    assert.equal(uploads[0].version, 3);
    assert.equal(uploads[0].consent_policy, 'anonymous-replay-training-v3');
    assert.equal(uploads[0].replay.config.rulesVersion, 'territory-v3');
  } finally { h.app.dispose(); }
});

test('pending V2 records can be retried with consent or cleared while viewing a default V3 game', async () => {
  const storage = memoryStorage();
  seedPendingV2(storage);
  let prompts = 0;
  const h = uiHarness({ language: 'en', storage, config: { onlineEnabled: true, apiBase: 'https://fixture.invalid' }, platformOverrides: {
    confirm: async text => { prompts++; assert.match(text, /territory-v2/i); assert.match(text, /territory-v3/i); return true; },
    contributionRequest: request => ({ promise: Promise.resolve({ status: request.method === 'GET' ? 503 : 200,
      data: request.method === 'GET' ? {} : { game_id: 'a'.repeat(64), status: 'awaiting_review' } }), abort() {} }),
  } });
  try {
    await until(() => h.app.session.snapshot && !h.app.session.busy);
    await h.tap('cabin-board'); await h.scrollTo('training-contribution'); await h.render();
    const toggle = h.app.getButtons().find(button => button.id === 'training-contribution');
    assert.equal(toggle.disabled, false, 'pending V2 records remain accessible for retry consent');
    assert.ok(h.texts.some(text => /Help AI learn/i.test(text)));
    assert.ok(h.texts.some(text => /off/i.test(text)));
    await h.tap('training-contribution');
    assert.equal(prompts, 1);
    assert.equal(saved(storage).enabled, true, 'the explicit opt-in permits V3 collection and retrying old V2 records');
    await h.tap('training-contribution');
    assert.equal(saved(storage).enabled, false);
    assert.deepEqual(saved(storage).queue, []);
  } finally { h.app.dispose(); }
});

test('pending V2 records remain deletable offline from a default V3 game', async () => {
  const storage = memoryStorage(); seedPendingV2(storage);
  const h = uiHarness({ language: 'en', storage, platformOverrides: {
    confirm: async text => { assert.match(text, /service is unavailable/i); return true; },
  } });
  try {
    await until(() => h.app.session.snapshot && !h.app.session.busy);
    await h.tap('cabin-board'); await h.scrollTo('training-contribution'); await h.render();
    const toggle = h.app.getButtons().find(button => button.id === 'training-contribution');
    assert.equal(toggle.disabled, false, 'pending local records can be managed without an upload service');
    await h.tap('training-contribution');
    assert.equal(saved(storage).enabled, false);
    assert.deepEqual(saved(storage).queue, []);
  } finally { h.app.dispose(); }
});
