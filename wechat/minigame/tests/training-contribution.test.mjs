import test from 'node:test';
import assert from 'node:assert/strict';
import { TrainingContribution, CONTRIBUTION_STORAGE, legacyContributionContext as contributionContext } from '../src/training-contribution.js';
import { createAnonymousContributionRequest } from '../src/contribution-transport.js';
import { createReplayDocument } from '../../../web/web前端/ReplayCodec.js';
import { validateContribution } from '../../../web/tools/validate_contribution.mjs';
import { checksum } from '../src/integrity.js';

const settings = { rulesVersion: 'territory-v2', gridSize: 5, playerCount: 2, startPlayer: 'BLACK',
  hintEnabled: false, hintMaxCount: 3, turnTimerEnabled: false, turnTimeLimitSeconds: 60 };
const actions = [{ type: 'skip', player: 'BLACK' }, { type: 'skip', player: 'WHITE' }];
const context = { source: 'local', actors: { BLACK: { kind: 'human' }, WHITE: { kind: 'ai', strategy: 'minimax', depth: 2 } }, mixedProfiles: false, hintsEnabled: false };
const replay = (config, list) => createReplayDocument(config, list, checksum);
const flushMicrotasks = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function harness(options = {}) {
  const values = new Map(), calls = []; let time = 1000;
  const storage = { get: key => values.get(key), set: (key, value) => values.set(key, value) };
  const request = ({ url, data }) => {
    calls.push({ url, data });
    return { promise: validateContribution(data).then(result => ({ status: 200, data: { status: 'awaiting_review', game_id: result.game_id } })), abort() {} };
  };
  const config = { storage, request, origin: 'https://fixture.invalid', createReplay: replay, now: () => time, version: 1, ...options };
  const client = new TrainingContribution(config);
  return { client, values, calls, config, advance: ms => { time += ms; } };
}
const begin = (client, extra = {}) => client.beginMatch({ settings, context, source: 'local', actionCount: 0, ...extra });
const finish = (client, ticket, extra = {}) => client.completeMatch(ticket, { settings, actions, context, source: 'local', ...extra });

test('v1 training contribution never mislabels alternate boards, custom/random roots or undo-enabled games', () => {
  const h = harness(); h.client.setEnabled(true);
  for (const patch of [{ boardShape: 'hexagon' }, { startingPointMode: 'random', initialPositions: { BLACK: [0, 1], WHITE: [1, 1] } },
    { startingPointMode: 'custom', initialPositions: { BLACK: [0, 0], WHITE: [4, 0] } }, { undoEnabled: true },
    { protectionRule: 'duel-first-unprotected-v1' }]) {
    const config = { ...settings, ...patch };
    assert.equal(contributionContext({ settings: config, controllerFor: () => 'human' }), null);
    assert.equal(begin(h.client, { settings: config }), null);
  }
  assert.equal(contributionContext({ settings, undoUsage: { usedCount: 1 }, controllerFor: () => 'human' }), null);
  assert.ok(contributionContext({ settings: { ...settings, protectionRule: 'symmetric-v1' }, controllerFor: () => 'human' }));
  assert.equal(h.calls.length, 0);
});

test('default off; consent begins with a fresh local match and never captures teaching/replay/network/restored games', async () => {
  const h = harness(); assert.equal(h.client.enabled, false); assert.equal(begin(h.client), null);
  await h.client.flush(); assert.equal(h.calls.length, 0);
  h.client.setEnabled(true);
  assert.equal(begin(h.client, { source: 'online' }), null); assert.equal(begin(h.client, { actionCount: 1 }), null);
  const ticket = begin(h.client);
  for (const extra of [{ source: 'online' }, { replay: true }, { tutorial: true }, { actions: actions.slice(0, 1) }]) {
    assert.equal(await finish(h.client, ticket, extra), false);
  }
  assert.equal(await finish(h.client, ticket), true); await h.client.flush();
  assert.equal(h.calls.length, 1); assert.equal(h.client.status, 'received');
  assert.equal(await finish(h.client, begin(h.client)), false);
});

test('Mini checksum/codec payload passes actual collector validator and preserves AI, hint and timer labels', async () => {
  const h = harness(); h.client.setEnabled(true);
  const config = { ...settings, hintEnabled: true, turnTimerEnabled: true, turnTimeLimitSeconds: 30 };
  const ctx = { ...context, hintsEnabled: true };
  assert.equal(await finish(h.client, begin(h.client, { settings: config, context: ctx }), { settings: config, context: ctx }), true);
  await h.client.flush(); const payload = h.calls[0].data;
  assert.deepEqual(Object.keys(payload).sort(), ['format', 'version', 'consent', 'consent_policy', 'replay', 'context'].sort());
  assert.deepEqual(payload.context, ctx); assert.equal(payload.replay.config.turnTimerEnabled, true);
  assert.equal(payload.replay.config.turnTimeLimitSeconds, 30); assert.equal(payload.replay.config.hintEnabled, true);
  const verified = await validateContribution(payload); assert.match(verified.game_id, /^[a-f0-9]{64}$/);
  assert.notEqual(verified.game_id, payload.replay.integrity.canonicalDocumentHash);
});

test('unsupported Greedy is never relabelled; profile or settings changes reject the whole match', async () => {
  const fake = { settings, controllerFor: player => player === 'BLACK' ? 'human' : 'greedy' };
  assert.equal(contributionContext(fake), null);
  fake.controllerFor = player => player === 'BLACK' ? 'human' : 'minimax-3';
  assert.equal(contributionContext(fake).actors.WHITE.depth, 3);
  const h = harness(); h.client.setEnabled(true); const ticket = begin(h.client);
  assert.equal(await finish(h.client, ticket, { context: { ...context, actors: { BLACK: { kind: 'human' }, WHITE: { kind: 'human' } } } }), false);
  assert.equal(await finish(h.client, ticket, { settings: { ...settings, turnTimerEnabled: true } }), false);
  assert.equal(begin(h.client, { context: { ...context, openid: 'private' } }), null);
  assert.equal(h.calls.length, 0);
});

test('bounded queue survives restart, drops corrupt/private input and rebuilds before retry', async () => {
  const h = harness(); h.client.setEnabled(true); await finish(h.client, begin(h.client));
  const restored = new TrainingContribution(h.config); assert.equal(restored.queue.length, 1);
  assert.equal(restored.enabled, false); await restored.flush(); assert.equal(h.calls.length, 0);
  restored.setEnabled(true);
  await restored.flush(); assert.equal(h.calls.length, 1);
  const duplicate = new TrainingContribution(h.config); duplicate.setEnabled(true); assert.equal(await finish(duplicate, begin(duplicate)), false);
  const saved = JSON.parse(h.values.get(CONTRIBUTION_STORAGE)); saved.queue = [{ id: `sha256:${'a'.repeat(64)}`, settings, actions, context: { ...context, nickname: 'private' } }];
  h.values.set(CONTRIBUTION_STORAGE, JSON.stringify(saved)); assert.equal(new TrainingContribution(h.config).queue.length, 0);
});

test('server failure retains queue and applies a cooldown; malformed receipt cannot discard data', async () => {
  let status = 429;
  const h = harness({ request: () => ({ promise: Promise.resolve({ status, data: {} }), abort() {} }) });
  h.client.setEnabled(true); await finish(h.client, begin(h.client)); await h.client.flush();
  assert.equal(h.client.queue.length, 1); assert.equal(h.client.status, 'retry');
  const retryAt = h.client.retryAt; await h.client.flush(); assert.equal(h.client.retryAt, retryAt);
  h.advance(60001); status = 503; await h.client.flush(); assert.equal(h.client.status, 'unavailable');
  h.advance(30001); status = 200; await h.client.flush(); assert.equal(h.client.status, 'retry'); assert.equal(h.client.queue.length, 1);
});

test('turning off aborts wx-style request task and late success cannot recreate queue or consent', async () => {
  let native, aborted = 0;
  const request = createAnonymousContributionRequest({ request: options => { native = options; return { abort: () => { aborted++; } }; } });
  const h = harness({ request }); h.client.setEnabled(true); await finish(h.client, begin(h.client));
  const running = h.client.flush();
  while (!native) await flushMicrotasks();
  assert.deepEqual(native.header, { 'Content-Type': 'application/json' }); assert.equal(native.enableCookie, false);
  assert.equal(native.url, 'https://fixture.invalid/api/training/contributions');
  h.client.setEnabled(false); assert.equal(aborted, 1);
  native.success({ statusCode: 200, data: { game_id: 'a'.repeat(64), status: 'duplicate' } }); await running;
  assert.equal(h.client.status, 'off'); assert.equal(h.client.queue.length, 0);
  assert.equal(new TrainingContribution(h.config).enabled, false);
});

test('anonymous capability request is GET without a replay body, account headers or cookies', async () => {
  let native;
  const request = createAnonymousContributionRequest({ request: options => { native = options; return { abort() {} }; } });
  const task = request({ url: 'https://fixture.invalid/api/training/contributions/status', method: 'GET', data: { shouldNotSend: true } });
  assert.equal(native.method, 'GET'); assert.equal(Object.hasOwn(native, 'data'), false);
  assert.deepEqual(native.header, { 'Content-Type': 'application/json' }); assert.equal(native.enableCookie, false);
  native.success({ statusCode: 200, data: { enabled: false } }); assert.equal((await task.promise).status, 200);
});

test('failed opt-out persistence cannot auto-upload on restart, and explicit invalidation survives profile rollback', async () => {
  const h = harness(); h.client.setEnabled(true); await finish(h.client, begin(h.client));
  h.config.storage.set = () => { throw new Error('write denied'); };
  h.client.setEnabled(false); assert.equal(h.client.snapshot().reason, 'OPT_OUT_STORAGE_FAILED');
  const restored = new TrainingContribution(h.config); assert.equal(restored.enabled, false);
  assert.equal(restored.status, 'paused'); await restored.flush(); assert.equal(h.calls.length, 0);
  const other = harness(); other.client.setEnabled(true); const ticket = begin(other.client);
  other.client.invalidateMatch(ticket);
  assert.equal(await finish(other.client, ticket), false); assert.equal(other.client.reason, 'MATCH_CHANGED');
});

test('queue accepts more than five games and oversized payloads never reach transport', async () => {
  const h = harness(); h.client.setEnabled(true);
  for (let size = 5; size <= 10; size++) {
    const config = { ...settings, gridSize: size };
    assert.equal(await finish(h.client, begin(h.client, { settings: config }), { settings: config }), true);
  }
  assert.equal(h.client.queue.length, 6); assert.equal(h.client.status, 'pending');
  const large = harness({ createReplay: async (...args) => ({ ...await replay(...args), oversizedFixture: 'a'.repeat(500001) }) });
  large.client.setEnabled(true); assert.equal(await finish(large.client, begin(large.client)), false);
  assert.equal(large.client.status, 'too-large'); assert.equal(large.calls.length, 0);
});

test('revocation during codec work and storage/UI failures never interrupt the game', async () => {
  let rejectCodec;
  const h = harness({ createReplay: () => new Promise((_, reject) => { rejectCodec = reject; }) });
  h.client.setEnabled(true); const pending = finish(h.client, begin(h.client));
  h.client.setEnabled(false); rejectCodec(new Error('cancelled Worker')); assert.equal(await pending, false); assert.equal(h.client.status, 'off');
  const broken = harness({ storage: { get() { throw new Error('denied'); }, set() { throw new Error('full'); } }, onChange() { throw new Error('UI callback'); } });
  assert.doesNotThrow(() => broken.client.setEnabled(true)); assert.equal(broken.client.status, 'storage-error');
  assert.equal(await finish(broken.client, begin(broken.client)), true);
  await broken.client.flush(); assert.equal(broken.client.queue.length, 0);
});

test('invalidating a match during asynchronous export prevents a late valid document from being queued', async () => {
  let finishCodec;
  const h = harness({ createReplay: () => new Promise(resolve => { finishCodec = resolve; }) });
  h.client.setEnabled(true); const ticket = begin(h.client), pending = finish(h.client, ticket);
  h.client.invalidateMatch(ticket); finishCodec(await replay(settings, actions));
  assert.equal(await pending, false); assert.equal(h.client.queue.length, 0);
});
