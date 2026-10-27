import test from 'node:test';
import assert from 'node:assert/strict';
import { until, memoryStorage } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';
import { TrainingContribution } from '../src/training-contribution.js';

const KEY = 'lifeline-wx-training-contribution-v1';
const saved = storage => JSON.parse(storage.get(KEY) || '{"enabled":false,"queue":[]}');
function seedPendingV2(storage) {
  const legacy = new TrainingContribution({ storage, canRun: () => false });
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

test('default territory-v3 matches clearly exclude contribution and never request consent', async () => {
  const storage = memoryStorage(), confirmations = [], uploads = [];
  const h = uiHarness({ storage, config: { onlineEnabled: true, apiBase: 'https://fixture.invalid' }, platformOverrides: {
    confirm: async message => { confirmations.push(message); return true; },
    contributionRequest: request => { uploads.push(request); return { promise: Promise.resolve({ status: 200 }), abort() {} }; },
  } });
  try {
    await until(() => h.app.session.snapshot && !h.app.session.busy);
    assert.equal(h.app.session.settings.rulesVersion, 'territory-v3');
    await h.tap('cabin-board'); await h.scrollTo('training-contribution'); await h.render();
    const toggle = h.app.getButtons().find(button => button.id === 'training-contribution');
    assert.equal(toggle.disabled, true);
    assert.ok(h.texts.some(text => /仅 V2/.test(text)));
    await h.tap('cabin-close'); await h.tap('resign'); await until(() => h.app.session.snapshot.gameOver);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(confirmations.some(message => /当前贡献协议|current protocol/.test(message)), false);
    assert.deepEqual(uploads, []);
    assert.equal(saved(storage).enabled, false);
  } finally { h.app.dispose(); }
});

test('pending V2 records can be retried with consent or cleared while viewing a default V3 game', async () => {
  const storage = memoryStorage();
  seedPendingV2(storage);
  let prompts = 0;
  const h = uiHarness({ language: 'en', storage, config: { onlineEnabled: true, apiBase: 'https://fixture.invalid' }, platformOverrides: {
    confirm: async text => { prompts++; assert.match(text, /territory-v2/); assert.match(text, /territory-v3/); return true; },
    contributionRequest: request => ({ promise: Promise.resolve({ status: request.method === 'GET' ? 503 : 200,
      data: request.method === 'GET' ? {} : { game_id: 'a'.repeat(64), status: 'awaiting_review' } }), abort() {} }),
  } });
  try {
    await until(() => h.app.session.snapshot && !h.app.session.busy);
    await h.tap('cabin-board'); await h.scrollTo('training-contribution'); await h.render();
    const toggle = h.app.getButtons().find(button => button.id === 'training-contribution');
    assert.equal(toggle.disabled, false, 'pending V2 records remain accessible for retry consent');
    assert.ok(h.texts.some(text => /V2 only/i.test(text)));
    assert.ok(h.texts.some(text => /opt-in/i.test(text)));
    assert.ok(h.texts.some(text => /off/i.test(text)));
    await h.tap('training-contribution');
    assert.equal(prompts, 1);
    assert.equal(saved(storage).enabled, true, 'the explicit opt-in permits retrying old V2 records');
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
