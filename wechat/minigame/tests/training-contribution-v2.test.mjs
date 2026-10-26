import test from 'node:test';
import assert from 'node:assert/strict';
import { TrainingContribution, CONTRIBUTION_STORAGE, CONTRIBUTION_POLICY, CONTRIBUTION_LIMITS, contributionContext } from '../src/training-contribution.js';
import { controllerChoices, playerIds } from '../src/controllers.js';
import { createReplayDocument } from '../../../web/web前端/ReplayCodec.js';
import { randomInitialPositions } from '../../../web/web前端/StartingPoints.js';
import { validateContribution } from '../../../web/tools/validate_contribution.mjs';
import { GameEngine } from '../../../web/web前端/GameEngine.js';
import { checksum } from '../src/integrity.js';

const settings = { rulesVersion: 'territory-v2', gridSize: 5, playerCount: 2, startPlayer: 'BLACK',
  hintEnabled: false, hintMaxCount: 3, turnTimerEnabled: false, turnTimeLimitSeconds: 60, undoEnabled: false, undoMaxCount: 3 };
const turns = config => playerIds(config.playerCount).map(player => ({ type: 'skip', player }));
const context = (config, profile = 'human', usedCount = 0) => contributionContext({ settings: config,
  controllerFor: player => player === 'BLACK' ? profile : 'human', undoUsage: { usedCount } });
const replay = (config, actions) => createReplayDocument(config, actions, checksum);
function harness(overrides = {}) {
  const values = new Map(), calls = [], timers = new Map(); let clock = 1000, nextTimer = 0, busy = false;
  const options = { storage: { get: key => values.get(key), set: (key, value) => values.set(key, value), remove: key => values.delete(key) },
    createReplay: replay, origin: 'https://fixture.invalid', now: () => clock, canRun: () => !busy,
    setTimer: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: clock + delay }); return id; },
    clearTimer: id => timers.delete(id), request: request => { calls.push(request);
      return { promise: Promise.resolve({ status: 200, data: { game_id: 'a'.repeat(64), status: 'awaiting_review' } }), abort() {} }; }, ...overrides };
  const payloadRequest = options.request;
  options.request = request => request.method === 'GET' ? (overrides.statusRequest?.(request) || {
    promise: Promise.resolve({ status: 200, data: { enabled: true, supported_versions: [1, 2], consent_policies: { 2: CONTRIBUTION_POLICY } } }), abort() {},
  }) : payloadRequest(request);
  const client = new TrainingContribution(options);
  return { client, calls, timers, values, options, setBusy: value => { busy = value; }, advance: value => { clock += value; },
    async next() {
      const first = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      assert.ok(first, 'a pending automatic retry exists'); timers.delete(first[0]); clock = Math.max(clock, first[1].at); first[1].callback();
      for (let i = 0; i < 500 && client.active; i++) await new Promise(resolve => setImmediate(resolve));
      assert.equal(client.active, false, 'background retry completed');
    },
  };
}
function capture(client, config = settings, ctx = context(config), actions = turns(config)) {
  const ticket = client.beginMatch({ settings: config, context: ctx, source: 'local', actionCount: 0 });
  return client.captureCompletedMatch(ticket, { settings: config, actions, context: ctx, source: 'local', terminal: true });
}

test('v2 collector accepts all board/count/root combinations and every selectable AI without identity metadata', async () => {
  const h = harness(); h.client.setEnabled(true); const profiles = new Set();
  for (const count of [2, 3, 4, 5, 6]) for (const shape of ['triangle', 'hexagon']) for (const mode of ['default', 'random', 'custom']) {
    const config = { ...settings, playerCount: count, boardShape: shape, startingPointMode: mode,
      ...(mode !== 'default' ? { initialPositions: randomInitialPositions(5, count, () => .35, shape) } : {}) };
    const engine = new GameEngine(config), actions = [];
    while (!engine.gameOver && actions.length < 10) { actions.push({ type: 'skip', player: engine.currentPlayer }); engine.skipTurn(); }
    assert.equal(engine.gameOver, true);
    const ctx = context(config); assert.ok(ctx); assert.equal(capture(h.client, config, ctx, actions), true); await h.client.flush();
    const payload = h.calls.at(-1).data;
    assert.equal(payload.version, 2); assert.equal(payload.consent_policy, CONTRIBUTION_POLICY);
    assert.deepEqual(payload.context.actors, Object.fromEntries(playerIds(count).map(player => [player, { kind: 'human' }])));
    const verified = await validateContribution(payload); assert.match(verified.game_id, /^[a-f0-9]{64}$/);
  }
  // A separate collector lets identical gameplay exercise each declared profile.
  for (const count of [2, 3, 4]) {
    const config = { ...settings, playerCount: count };
    for (const profile of controllerChoices(config).filter(item => item !== 'human')) {
      const client = harness(); client.client.setEnabled(true); profiles.add(profile);
      assert.equal(capture(client.client, config, context(config, profile)), true); await client.client.flush();
      assert.deepEqual(client.calls[0].data.context.actors.BLACK, { kind: 'ai', profile });
      await validateContribution(client.calls[0].data); client.client.dispose();
    }
  }
  assert.equal(profiles.size, 29);
  for (const profile of ['multiplayer-easy-v1', 'multiplayer-medium-v1', 'multiplayer-hard-v1'])
    assert.ok(profiles.has(profile), `new multiplayer tier was collected and validated: ${profile}`);
  h.client.dispose();
});

test('v2 collector accepts only missing or explicit symmetric start protection', () => {
  const h = harness(); h.client.setEnabled(true);
  const legacyContext = context(settings);
  const symmetric = { ...settings, protectionRule: 'symmetric-v1' };
  assert.ok(h.client.beginMatch({ settings: symmetric, context: legacyContext, source: 'local', actionCount: 0 }));
  const asymmetric = { ...settings, protectionRule: 'duel-first-unprotected-v1' };
  assert.equal(context(asymmetric), null);
  assert.equal(h.client.beginMatch({ settings: asymmetric, context: legacyContext, source: 'local', actionCount: 0 }), null);
  assert.equal(h.client.queue.length, 0); assert.equal(h.calls.length, 0); h.client.dispose();
});

test('a terminal snapshot is persisted synchronously and survives immediately starting another game', async () => {
  let exports = 0;
  const h = harness({ createReplay: (...args) => { exports++; return replay(...args); } }); h.client.setEnabled(true); h.setBusy(true);
  const actions = turns(settings), ctx = context(settings);
  const ticket = h.client.beginMatch({ settings, context: ctx, source: 'local', actionCount: 0 });
  assert.equal(h.client.captureCompletedMatch(ticket, { settings, context: ctx, actions, source: 'local', terminal: true }), true);
  actions[0].player = 'private'; ctx.actors.BLACK.nickname = 'private';
  h.client.invalidateMatch(ticket); assert.equal(exports, 0); assert.equal(h.calls.length, 0); assert.equal(h.timers.size, 0);
  assert.equal(JSON.parse(h.values.get(CONTRIBUTION_STORAGE)).queue.length, 1);
  h.setBusy(false); h.client.wake(); await h.next();
  assert.equal(exports, 1); assert.equal(h.calls.length, 1); assert.equal(h.client.queue.length, 0);
  assert.ok(!JSON.stringify(h.calls).includes('private')); h.client.dispose();
});

test('fresh explicit permission is required after reload, and completed restored pending games retry automatically', async () => {
  const h = harness(); h.client.setEnabled(true); h.setBusy(true); capture(h.client);
  const restored = new TrainingContribution(h.options); assert.equal(restored.enabled, false); assert.equal(restored.queue.length, 1);
  await restored.flush(); assert.equal(h.calls.length, 0);
  h.setBusy(false); restored.setEnabled(true); await restored.flush();
  assert.equal(h.calls.length, 1); assert.equal(restored.queue.length, 0); restored.dispose(); h.client.dispose();
});

test('unfinished or forged terminal state cannot upload; hints and real undo use remain labelled', async () => {
  const h = harness(); h.client.setEnabled(true);
  assert.equal(capture(h.client, settings, context(settings), turns(settings).slice(0, 1)), true);
  await h.client.flush(); assert.equal(h.calls.length, 0); assert.equal(h.client.queue.length, 0); assert.equal(h.client.status, 'invalid');
  const config = { ...settings, undoEnabled: true, hintEnabled: true };
  const ticket = h.client.beginMatch({ settings: config, context: context(config), source: 'local', actionCount: 0 });
  assert.equal(h.client.captureCompletedMatch(ticket, { settings: config, context: context(config, 'human', 2), actions: turns(config), source: 'local', terminal: true }), true);
  await h.client.flush(); assert.deepEqual(h.calls[0].data.context.undo, { enabled: true, maxCount: 3, usedCount: 2 });
  assert.equal(h.calls[0].data.replay.config.hintEnabled, true); await validateContribution(h.calls[0].data); h.client.dispose();
});

test('automatic failures use bounded backoff, do not spin, and network recovery retries retained data', async () => {
  let attempts = 0, fail = true;
  const h = harness({ request: () => { attempts++; return { promise: fail ? Promise.reject(new Error('NETWORK_ERROR'))
    : Promise.resolve({ status: 200, data: { game_id: 'b'.repeat(64), status: 'duplicate' } }), abort() {} }; } });
  h.client.setEnabled(true); capture(h.client);
  for (let i = 0; i < CONTRIBUTION_LIMITS.automaticAttempts; i++) await h.next();
  assert.equal(attempts, 4); assert.equal(h.timers.size, 0); assert.equal(h.client.queue.length, 1);
  h.client.wake(); assert.equal(h.timers.size, 0);
  h.client.networkChanged({ isConnected: false }); fail = false; h.client.networkChanged({ isConnected: true });
  await h.next(); assert.equal(attempts, 5); assert.equal(h.client.queue.length, 0); h.client.dispose();
});

test('rate limiting cooldown survives a rapid offline/online transition', async () => {
  let attempts = 0;
  const h = harness({ request: () => { attempts++; return { promise: Promise.resolve({ status: 429, data: {} }), abort() {} }; } });
  h.client.setEnabled(true); capture(h.client); await h.next();
  const retryAt = h.client.retryAt; h.client.networkChanged({ isConnected: false }); h.client.networkChanged({ isConnected: true });
  assert.equal(h.client.retryAt, retryAt); await h.client.flush(); assert.equal(attempts, 1);
  await h.next(); assert.equal(attempts, 2); h.client.dispose();
});

test('hiding or revoking consent aborts a request and ignores a late receipt without losing the retained queue', async () => {
  for (const revoke of [false, true]) {
    let finish, aborted = 0;
    const h = harness({ request: () => ({ promise: new Promise(resolve => { finish = resolve; }), abort: () => { aborted++; } }) });
    h.client.setEnabled(true); capture(h.client); const running = h.client.flush();
    for (let i = 0; i < 100 && !finish; i++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(finish); if (revoke) h.client.setEnabled(false); else h.client.setForeground(false);
    assert.equal(aborted, 1); finish({ status: 200, data: { game_id: 'a'.repeat(64), status: 'awaiting_review' } }); await running;
    assert.equal(h.client.queue.length, revoke ? 0 : 1); assert.equal(h.timers.size, 0);
    assert.equal(h.client.received.length, 0); h.client.dispose();
  }
});

test('a cancelled Worker export keeps its captured game for the next idle period', async () => {
  let attempts = 0;
  const h = harness({ createReplay: (...args) => { if (!attempts++) { h.setBusy(true); return Promise.reject(new Error('CANCELLED')); } return replay(...args); } });
  h.client.setEnabled(true); capture(h.client); await h.next();
  assert.equal(h.client.queue.length, 1); assert.equal(h.calls.length, 0); assert.equal(h.timers.size, 0);
  h.setBusy(false); h.client.wake(); await h.next(); assert.equal(h.calls.length, 1); h.client.dispose();
});

test('queue supports 100 compact games, evicts oldest, and stays under a single storage-key byte limit', () => {
  const h = harness(); h.client.setEnabled(true); h.setBusy(true);
  for (let i = 0; i < 105; i++) assert.equal(capture(h.client, { ...settings, turnTimeLimitSeconds: 15 + i }), true);
  assert.equal(h.client.queue.length, 100); assert.equal(h.client.dropped, 5);
  assert.equal(h.client.queue[0].settings.turnTimeLimitSeconds, 20);
  assert.ok(Buffer.byteLength(h.values.get(CONTRIBUTION_STORAGE)) <= CONTRIBUTION_LIMITS.queueBytes);
  const long = Array.from({ length: 3000 }, (_, i) => ({ type: 'move', player: i % 2 ? 'WHITE' : 'BLACK', point: [1, 0] }));
  for (let i = 0; i < 12; i++) assert.equal(capture(h.client, { ...settings, turnTimeLimitSeconds: 130 + i }, undefined, long), true);
  assert.ok(h.client.queue.length < 100); assert.ok(Buffer.byteLength(h.values.get(CONTRIBUTION_STORAGE)) <= CONTRIBUTION_LIMITS.queueBytes);
  assert.equal(h.calls.length, 0); assert.equal(h.timers.size, 0); h.client.dispose();
});

test('an ambiguous v2 server rejection retains the verified record until the server recovers', async () => {
  let requests = 0;
  const h = harness({ request: () => ({ promise: Promise.resolve(++requests === 1 ? { status: 422, data: {} }
    : { status: 200, data: { game_id: 'c'.repeat(64), status: 'awaiting_review' } }), abort() {} }) });
  h.client.setEnabled(true); capture(h.client); capture(h.client, { ...settings, gridSize: 6 });
  await h.next(); assert.equal(h.client.queue.length, 2); assert.equal(h.client.reason, 'SERVER_REJECTED');
  await h.next(); assert.equal(requests, 2); assert.equal(h.client.queue.length, 1);
  await h.next(); assert.equal(requests, 3); assert.equal(h.client.queue.length, 0); h.client.dispose();
});

test('a v1-only collector receives no v2 replay, keeps a bounded outbox, and automatically resumes after v2 activation', async () => {
  let supported = false, statuses = 0, exports = 0;
  const h = harness({ createReplay: (...args) => { exports++; return replay(...args); }, statusRequest: request => {
    statuses++; assert.equal(request.url, 'https://fixture.invalid/api/training/contributions/status'); assert.equal(request.data, undefined);
    return { promise: Promise.resolve({ status: 200, data: supported
      ? { enabled: true, supported_versions: [1, 2], consent_policies: { 2: CONTRIBUTION_POLICY } }
      : { enabled: true, consent_policy: 'anonymous-replay-training-v1' } }), abort() {} };
  } });
  h.client.setEnabled(true); capture(h.client);
  for (let i = 0; i < CONTRIBUTION_LIMITS.automaticAttempts; i++) await h.next();
  assert.equal(statuses, 4); assert.equal(exports, 0); assert.equal(h.calls.length, 0);
  assert.equal(h.client.queue.length, 1); assert.equal(h.timers.size, 0); assert.equal(h.client.reason, 'PROTOCOL_NOT_AVAILABLE');
  assert.equal(JSON.parse(h.values.get(CONTRIBUTION_STORAGE)).queue.length, 1);
  supported = true; h.client.setForeground(false); h.client.setForeground(true); await h.next();
  assert.equal(exports, 1); assert.equal(h.calls.length, 1); assert.equal(h.client.queue.length, 0); h.client.dispose();
});

test('disabled or mismatched-policy collectors never get replay data, and a v2-to-v1 rollback cannot erase it', async () => {
  for (const data of [{ enabled: false, supported_versions: [2], consent_policies: { 2: CONTRIBUTION_POLICY } },
    { enabled: true, supported_versions: [2], consent_policies: { 2: 'foreign-policy' } }]) {
    const h = harness({ statusRequest: () => ({ promise: Promise.resolve({ status: 200, data }), abort() {} }) });
    h.client.setEnabled(true); capture(h.client); await h.next();
    assert.equal(h.calls.length, 0); assert.equal(h.client.queue.length, 1); h.client.dispose();
  }
  let rolledBack = false;
  const h = harness({ statusRequest: () => ({ promise: Promise.resolve({ status: 200, data: rolledBack
    ? { enabled: true, consent_policy: 'anonymous-replay-training-v1' }
    : { enabled: true, supported_versions: [2], consent_policies: { 2: CONTRIBUTION_POLICY } } }), abort() {} }),
    request: () => { rolledBack = true; return { promise: Promise.resolve({ status: 422, data: { detail: 'Invalid replay contribution' } }), abort() {} }; } });
  h.client.setEnabled(true); capture(h.client); await h.next(); assert.equal(h.client.queue.length, 1);
  await h.next(); assert.equal(h.client.queue.length, 1); assert.equal(h.client.reason, 'PROTOCOL_NOT_AVAILABLE'); h.client.dispose();
});

test('extra identity fields, unknown AI and a changed actor/settings signature never enter the pending queue', () => {
  const h = harness(); h.client.setEnabled(true);
  const ctx = context(settings);
  assert.equal(h.client.beginMatch({ settings, context: { ...ctx, openid: 'private' }, source: 'local', actionCount: 0 }), null);
  assert.equal(context(settings, 'unknown-profile'), null);
  const ticket = h.client.beginMatch({ settings, context: ctx, source: 'local', actionCount: 0 });
  assert.equal(h.client.captureCompletedMatch(ticket, { settings, context: context(settings, 'greedy'), actions: turns(settings), source: 'local', terminal: true }), false);
  assert.equal(h.client.queue.length, 0); h.client.dispose();
});
