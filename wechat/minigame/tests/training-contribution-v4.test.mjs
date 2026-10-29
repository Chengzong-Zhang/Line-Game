import test from 'node:test';
import assert from 'node:assert/strict';
import { TrainingContribution, contributionContext, CONTRIBUTION_V4_POLICY } from '../src/training-contribution.js';
import { checksum } from '../src/integrity.js';
import { createTopologySetup, useTopologyPreset } from '../src/topology-setup.js';
import { createTopologyReplayDocument, restoreGame } from '../src/state.js';
import { createReplayDocument, createTopologyReplayDocument as createWebTopologyReplay } from '../../../web/web前端/ReplayCodec.js';
import { validateContribution } from '../../../web/tools/validate_contribution.mjs';
import { PLAYER_ORDER, randomInitialPositions } from '../src/core.js';
import { controllerChoices } from '../src/controllers.js';
import { contributionV4ProfileChoices } from '../../../web/tools/training_contribution_schema.mjs';

const base = { gridSize: 5, playerCount: 2, startPlayer: 'BLACK', rulesVersion: 'territory-v3',
  boardShape: 'diamond', hintEnabled: false, hintMaxCount: 3, turnTimerEnabled: false,
  turnTimeLimitSeconds: 60, undoEnabled: false, undoMaxCount: 3 };
const actions = [{ type: 'skip', player: 'BLACK' }, { type: 'skip', player: 'WHITE' }];
const context = settings => contributionContext({ settings, controllerFor: () => 'human', undoUsage: { usedCount: 0 } }, 4);
const payload = (replay, ctx) => ({ format: 'lifeline-training-contribution', version: 4, consent: true,
  consent_policy: CONTRIBUTION_V4_POLICY, replay, context: ctx });
const createReplay = (settings, events) => settings.rulesVersion === 'surface-v1'
  ? createTopologyReplayDocument(settings, events) : createReplayDocument(settings, events, checksum);

test('v4 validates a completed diamond replay and rejects tampering', async () => {
  const doc = await createReplay(base, actions), p = payload(doc, context(base));
  assert.equal((await validateContribution(p)).player_count, 2);
  const altered = structuredClone(p); altered.replay.actions[0].actor = 'WHITE';
  await assert.rejects(validateContribution(altered));
  const unfinished = await createReplay(base, actions.slice(0, 1));
  await assert.rejects(validateContribution(payload(unfinished, context(base))));
});

test('v4 covers the Mini controller matrix and 15-player shapes', async () => {
  for (let playerCount = 2; playerCount <= 15; playerCount++) for (const boardShape of ['triangle', 'hexagon', 'diamond']) {
    const settings = { ...base, gridSize: 9, playerCount, boardShape };
    assert.deepEqual([...contributionV4ProfileChoices(settings)].sort(), [...controllerChoices(settings)].sort());
  }
  for (const boardShape of ['triangle', 'hexagon', 'diamond']) {
    const settings = { ...base, gridSize: 15, playerCount: 15, boardShape, startingPointMode: 'random',
      initialPositions: randomInitialPositions(15, 15, () => 0.5, boardShape) };
    const events = PLAYER_ORDER.slice(0, 15).map(player => ({ type: 'skip', player }));
    const doc = await createReplay(settings, events);
    assert.equal((await validateContribution(payload(doc, context(settings)))).player_count, 15);
  }
});

test('v4 preserves and verifies root-v2 relocation and addition actions', async () => {
  for (const rootMode of ['relocate', 'add']) {
    const settings = { ...base, gridSize: 9, boardShape: 'triangle', rootMode, rootRulesVersion: 'root-v2' };
    const events = [
      { type: 'move', player: 'BLACK', point: [1, 0] },
      { type: 'move', player: 'WHITE', point: [7, 0] },
      { type: `root_${rootMode}`, player: 'BLACK', point: [1, 0] },
      { type: 'skip', player: 'WHITE' }, { type: 'skip', player: 'BLACK' },
    ];
    const doc = await createReplay(settings, events);
    assert.equal(doc.actions[2].type, `root_${rootMode}`);
    assert.equal((await validateContribution(payload(doc, context(settings)))).protocol_version, 4);
    const changed = structuredClone(doc); changed.actions[2].point = [2, 0];
    await assert.rejects(validateContribution(payload(changed, context(settings))));
  }
});

test('v4 replays native topology vertex identities and checks complete final state', async () => {
  const b = useTopologyPreset(createTopologySetup(), 'double-torus', { gridSize: 9, playerCount: 2 }).setup;
  const settings = { ...base, gridSize: 9, boardShape: 'custom', rulesVersion: 'surface-v1',
    boardDefinition: b.definition, boardHash: b.boardHash, topologyProtocolVersion: 'board-topology-v1', rootMode: 'classic', rootRulesVersion: 'root-v1' };
  const engine = restoreGame(settings), vertexId = engine.getSnapshot().legalMoves[0].vertexId;
  const events = [{ type: 'move', player: 'BLACK', vertexId }, { type: 'skip', player: 'WHITE' }, { type: 'skip', player: 'BLACK' }];
  const doc = await createReplay(settings, events), p = payload(doc, context(settings));
  assert.ok(doc.finalState.topologyState.ruleState.logicPaths.length);
  assert.equal((await validateContribution(p)).protocol_version, 4);
  const altered = structuredClone(p); altered.replay.finalState.topologyState.ruleState.consecutivePasses = 1;
  await assert.rejects(validateContribution(altered));
  const privateField = structuredClone(p); privateField.replay.config.nickname = 'person';
  await assert.rejects(validateContribution(privateField));
  const webReplay = await createWebTopologyReplay(settings, events);
  assert.equal(webReplay.engineFamily, 'web-game-engine');
  assert.equal((await validateContribution(payload(webReplay, context(settings)))).protocol_version, 4);
  const malformed = structuredClone(webReplay); malformed.actions[0].vertexId = 'cv:missing';
  await assert.rejects(validateContribution(payload(malformed, context(settings))));
});

test('v4 handshake retains and reloads the queue until the service supports v4', async () => {
  const store = new Map(), posts = [];
  const storage = { get: key => store.get(key), set: (key, value) => store.set(key, value), remove: key => store.delete(key) };
  const status = { enabled: true, supported_versions: [1, 2, 3], consent_policies: { 3: 'anonymous-replay-training-v3' } };
  const request = options => options.method === 'GET' ? { promise: Promise.resolve({ status: 200, data: status }), abort() {} }
    : { promise: (async () => { posts.push(options.data); const result = await validateContribution(options.data);
      return { status: 200, data: { game_id: result.game_id, status: 'awaiting_review' } }; })(), abort() {} };
  const options = { storage, request, origin: 'https://fixture.invalid', createReplay, version: 4, setTimer: () => 1, clearTimer() {} };
  const client = new TrainingContribution(options); client.setEnabled(true);
  const ticket = client.beginMatch({ settings: base, context: context(base), source: 'local', actionCount: 0 });
  assert.ok(ticket); assert.ok(client.captureCompletedMatch(ticket, { settings: base, actions, context: context(base), source: 'local', terminal: true }));
  await client.flush(); assert.equal(posts.length, 0); assert.equal(client.snapshot().pending, 1);
  client.dispose();
  const resumed = new TrainingContribution(options); assert.equal(resumed.snapshot().pending, 1); assert.equal(resumed.enabled, false);
  status.supported_versions.push(4); status.consent_policies[4] = CONTRIBUTION_V4_POLICY;
  resumed.setEnabled(true); await resumed.flush();
  assert.equal(posts.length, 1); assert.equal(resumed.snapshot().pending, 0);
  resumed.setEnabled(false); assert.equal(resumed.snapshot().pending, 0);
});
