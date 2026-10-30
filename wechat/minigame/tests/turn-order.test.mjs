import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreGame, applyAction, ruleView, normalizeGameSettings, topologySettingsFor, createTopologyReplayDocument, validateTopologyReplayDocument } from '../src/state.js';
import { createTopologySetup, useTopologyPreset } from '../src/topology-setup.js';
import { createReplayDocument, validateReplayDocument } from '../../../web/web前端/ReplayCodec.js';
import { createLocalGameSession, sessionMatchesSettings } from '../../../web/web前端/LocalGameSession.js';
import { readPreferences, savePreferences } from '../src/preferences.js';
import { serializeEngineState } from '../../../web/web前端/AIStateProtocol.js';
import { validateContribution } from '../../../web/tools/validate_contribution.mjs';
import { contributionContext, CONTRIBUTION_V4_POLICY } from '../src/training-contribution.js';

const order = ['PURPLE', 'BLACK', 'GREEN', 'WHITE'];
const base = { gridSize: 7, playerCount: 4, startPlayer: order[0], turnOrder: order, rulesVersion: 'territory-v3', boardShape: 'hexagon', hintEnabled: false, hintMaxCount: 0, turnTimerEnabled: false, turnTimeLimitSeconds: 60, undoEnabled: false, undoMaxCount: 3 };
function playRound(settings) {
  const engine = restoreGame(settings), actions = [];
  for (const player of order) {
    assert.equal(engine.currentPlayer, player);
    const move = engine.getLegalMoves(player)[0];
    assert.ok(move);
    const action = engine.isTopologyBoard ? { type: 'move', player, vertexId: move.vertexId } : { type: 'move', player, point: move.point };
    assert.equal(applyAction(engine, action).success, true); actions.push(action);
  }
  assert.equal(engine.currentPlayer, order[0]);
  assert.deepEqual(ruleView(restoreGame(settings, actions)).ruleState, ruleView(engine).ruleState);
  assert.equal(restoreGame(settings, actions.slice(0, 2)).currentPlayer, order[2]);
  assert.equal(applyAction(engine, { type: 'skip', player: order[0] }).success, true);
  assert.equal(engine.currentPlayer, order[1]);
  assert.equal(applyAction(engine, { type: 'resign', player: order[2] }).success, true);
  assert.equal(engine.currentPlayer, order[1]);
  assert.equal(applyAction(engine, { type: 'skip', player: order[1] }).success, true);
  assert.equal(engine.currentPlayer, order[3]);
  return actions;
}
test('non-rotational order persists through actual play, replay, state, undo and AI payload', async () => {
  const actions = playRound(base), engine = restoreGame(base, actions);
  assert.deepEqual(serializeEngineState(engine).turnOrder, order);
  const replay = await createReplayDocument(base, actions);
  assert.deepEqual(replay.config.turnOrder, order); assert.equal((await validateReplayDocument(replay)).success, true);
  const saved = createLocalGameSession(base, actions); assert.deepEqual(saved.settings.turnOrder, order);
  assert.equal(sessionMatchesSettings(saved, { ...base, turnOrder: [...order] }), true);
  const legacy = { ...base }; delete legacy.turnOrder;
  const old = restoreGame(legacy); assert.equal(old.currentPlayer, 'PURPLE');
  assert.equal(old.skipTurn().success, true); assert.equal(old.currentPlayer, 'GREEN');
  assert.equal('turnOrder' in ruleView(old).ruleState, false);
  assert.notEqual(ruleView(restoreGame(base)).stateHash, ruleView(restoreGame(legacy)).stateHash);
  for (const invalid of [['PURPLE','BLACK','BLACK','WHITE'], ['BLACK','PURPLE','GREEN','WHITE'], ['PURPLE','BLACK']])
    assert.throws(() => normalizeGameSettings({ ...base, turnOrder: invalid }), /INVALID_TURN_ORDER/);
  const map = new Map(), storage = { get: key => map.get(key), set: (key, value) => map.set(key, value) };
  savePreferences(storage, { size: 7, mode: 'human', difficulty: 'simple', playerCount: 4, startPlayer: 'PURPLE', turnOrder: order });
  assert.deepEqual(readPreferences(storage).turnOrder, order);
});
test('topology order is in encoded state and replays under the same rules', () => {
  const preset = useTopologyPreset(createTopologySetup(), 'cylinder', { gridSize: 7, playerCount: 4 }).setup;
  const settings = topologySettingsFor(preset.definition, { ...base, boardHash: preset.boardHash });
  const actions = playRound(settings), replay = createTopologyReplayDocument(settings, actions);
  assert.deepEqual(replay.finalState.topologyState.ruleState.turnOrder, order);
  assert.deepEqual(validateTopologyReplayDocument(replay).settings.turnOrder, order);
  const wrong = structuredClone(replay); wrong.config.turnOrder = ['PURPLE','WHITE','GREEN','BLACK'];
  assert.throws(() => validateTopologyReplayDocument(wrong));
});
test('v4 authority accepts a completed non-rotational game and rejects reordered actors', async () => {
  const actions = order.map(player => ({ type: 'skip', player }));
  const replay = await createReplayDocument(base, actions);
  const context = contributionContext({ settings: base, controllerFor: () => 'human', undoUsage: { usedCount: 0 } }, 4);
  const payload = { format: 'lifeline-training-contribution', version: 4, consent: true, consent_policy: CONTRIBUTION_V4_POLICY, replay, context };
  assert.equal((await validateContribution(payload)).player_count, 4);
  const tampered = structuredClone(payload); tampered.replay.config.turnOrder = ['PURPLE','WHITE','GREEN','BLACK'];
  await assert.rejects(validateContribution(tampered));
});

import { executeTask } from '../src/worker-runtime.js';
test('worker selects the actual ordered actor and rejects a stale actor', async () => {
  const settings = { ...base, boardShape: 'triangle' };
  const actions = [{ type: 'skip', player: 'PURPLE' }, { type: 'skip', player: 'BLACK' }], view = ruleView(restoreGame(settings, actions));
  const context = { epoch: 0, revision: view.snapshot.positionRevision, rulesVersion: base.rulesVersion, player: 'GREEN' };
  const result = await executeTask({ kind: 'AI', payload: { settings, actions, profile: 'greedy' }, context });
  assert.equal(result.player, 'GREEN'); assert.equal(result.stateHash, view.stateHash); assert.ok(result.moves.length);
  assert.throws(() => executeTask({ kind: 'AI', payload: { settings, actions, profile: 'greedy' }, context: { ...context, player: 'WHITE' } }), /WRONG_PLAYER/);
});
test('automatic pass advances using the configured order', () => {
  const engine = restoreGame(base); engine.currentPlayer = 'BLACK';
  const real = engine._hasAnyNonPassAction.bind(engine);
  engine._hasAnyNonPassAction = player => player !== 'BLACK' && real(player);
  engine._checkAndAutoSkip(); assert.equal(engine.currentPlayer, 'GREEN'); assert.equal(engine.consecutiveSkips, 1);
});
test('v4 native topology authority commits ordered state', async () => {
  const preset = useTopologyPreset(createTopologySetup(), 'cylinder', { gridSize: 7, playerCount: 4 }).setup;
  const settings = topologySettingsFor(preset.definition, { ...base, boardHash: preset.boardHash });
  const replay = createTopologyReplayDocument(settings, order.map(player => ({ type: 'skip', player })));
  const context = contributionContext({ settings, controllerFor: () => 'human', undoUsage: { usedCount: 0 } }, 4);
  const payload = { format: 'lifeline-training-contribution', version: 4, consent: true, consent_policy: CONTRIBUTION_V4_POLICY, replay, context };
  assert.equal((await validateContribution(payload)).player_count, 4);
  const altered = structuredClone(payload); altered.replay.config.turnOrder = ['PURPLE','WHITE','GREEN','BLACK'];
  await assert.rejects(validateContribution(altered));
});

test('corrupt preference order remains visible and marked for repair', () => {
  const map = new Map(), storage = { get: key => map.get(key), set: (key, value) => map.set(key, value) };
  const broken = ['PURPLE', 'BLACK', 'BLACK', 'WHITE'];
  savePreferences(storage, { size: 7, mode: 'human', difficulty: 'simple', playerCount: 4,
    startPlayer: 'PURPLE', turnOrder: broken });
  const loaded = readPreferences(storage);
  assert.equal(loaded.invalidTurnOrder, true); assert.deepEqual(loaded.turnOrder, broken); assert.equal(loaded.size, 7);
  assert.throws(() => normalizeGameSettings({ ...base, turnOrder: loaded.turnOrder }), /INVALID_TURN_ORDER/);
});

import { prepareRankedMatch } from '../tools/ranked-ai.mjs';
test('ranked setup retains order in rules and rating identity', async () => {
  const controllers = { BLACK: 'human', WHITE: 'greedy', PURPLE: 'greedy', GREEN: 'greedy' };
  const settings = { ...base, boardShape: 'diamond', startingPointMode: 'random' };
  const prepared = await prepareRankedMatch({ settings: Object.fromEntries(['gridSize','playerCount','startPlayer','turnOrder','rulesVersion','boardShape','startingPointMode'].map(key => [key, settings[key]])), controllers });
  assert.deepEqual(prepared.settings.turnOrder, order);
  assert.deepEqual(prepared.context.turnOrder, order);
  assert.equal(prepared.snapshot.currentPlayer, 'PURPLE');
});

import { createTopologyReplayDocument as createWebTopologyReplay, validateTopologyReplayDocument as validateWebTopologyReplay } from '../../../web/web前端/ReplayCodec.js';
test('web topology replay and v4 verifier retain arbitrary order', async () => {
  const preset = useTopologyPreset(createTopologySetup(), 'cylinder', { gridSize: 7, playerCount: 4 }).setup;
  const settings = topologySettingsFor(preset.definition, { ...base, boardHash: preset.boardHash });
  const replay = await createWebTopologyReplay(settings, order.map(player => ({ type: 'skip', player })));
  assert.deepEqual(replay.initialState.topologyState.ruleState.turnOrder, order);
  assert.equal((await validateWebTopologyReplay(replay)).success, true);
  const context = contributionContext({ settings, controllerFor: () => 'human', undoUsage: { usedCount: 0 } }, 4);
  const payload = { format: 'lifeline-training-contribution', version: 4, consent: true, consent_policy: CONTRIBUTION_V4_POLICY, replay, context };
  assert.equal((await validateContribution(payload)).player_count, 4);
});
