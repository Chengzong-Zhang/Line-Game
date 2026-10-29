import assert from 'node:assert/strict';
import test from 'node:test';
import '../web前端/TopologyGameEngine.js';
import GameEngine from '../web前端/GameEngine.js';
import { canonicalize } from '../web前端/ReplayCodec.js';
import { createTopologySetup, addTopologyBoundaryVertex, closeTopologyBoundary, changeTopologyStarts } from '../../wechat/minigame/src/topology-setup.js';
import { createTopologyReplayDocument, restoreGame } from '../../wechat/minigame/src/state.js';
import { checksum } from '../../wechat/minigame/src/integrity.js';
import { validateContribution } from '../tools/validate_contribution.mjs';

function fixtureSettings() {
  let setup = createTopologySetup();
  for (const point of [[0, 0], [1, 0], [2, 0], [1, 1], [0, 2], [0, 1]]) {
    const result = addTopologyBoundaryVertex(setup, point);
    assert.equal(result.ok, true); setup = result.setup;
  }
  const closed = closeTopologyBoundary(setup); assert.equal(closed.ok, true);
  const started = changeTopologyStarts(closed.setup, { mode: 'default', playerCount: 2 }); assert.equal(started.ok, true);
  return { gridSize: 5, playerCount: 2, startPlayer: 'BLACK', rulesVersion: 'surface-v1', boardShape: 'custom',
    boardDefinition: started.setup.definition, boardHash: started.setup.boardHash, topologyProtocolVersion: 'board-topology-v1',
    rootMode: 'classic', rootRulesVersion: 'root-v1', hintEnabled: false, hintMaxCount: 3,
    turnTimerEnabled: false, turnTimeLimitSeconds: 60, undoEnabled: false, undoMaxCount: 3 };
}
const context = { source: 'local', actors: { BLACK: { kind: 'human' }, WHITE: { kind: 'human' } }, mixedProfiles: false,
  hintsEnabled: false, undo: { enabled: false, maxCount: 3, usedCount: 0 } };
const wrap = replay => ({ format: 'lifeline-training-contribution', version: 4, consent: true,
  consent_policy: 'anonymous-replay-training-v4', replay, context });
const same = (a, b) => assert.equal(canonicalize(a), canonicalize(b));

async function checkAgainstReference(settings, actions) {
  const doc = createTopologyReplayDocument(settings, actions);
  const reference = new GameEngine({ ...settings, deferTerritoryUpdates: false });
  for (const action of actions) {
    // Compare the existence-only check against the original exhaustive helper
    // on actual evolving state/history, including no-move automatic skips.
    for (const player of reference.activePlayers) {
      const all = reference.getLegalMoves(player).length > 0;
      const first = reference.validPositions.some(vertexId => reference._evaluateMove(vertexId, player).legal);
      assert.equal(first, all);
    }
    const result = action.type === 'move' ? reference.playMove(action.vertexId)
      : action.type === 'skip' ? reference.skipTurn() : reference.resignPlayer(action.player);
    assert.equal(result.success, true);
  }
  assert.equal(reference.gameOver, true);
  same(reference.encodeTopologyState(), doc.finalState.topologyState);
  assert.equal(checksum(reference.encodeTopologyState()), doc.finalState.stateHash);
  const accepted = await validateContribution(wrap(doc));
  same(accepted.replay.finalState.topologyState, reference.encodeTopologyState());
  return doc;
}

test('batch preserves full state for explicit pass and resignation', async () => {
  const settings = fixtureSettings();
  const passed = await checkAgainstReference(settings, [{ type: 'skip', player: 'BLACK' }, { type: 'skip', player: 'WHITE' }]);
  assert.equal(passed.finalState.topologyState.ruleState.consecutivePasses, 2);
  const resigned = await checkAgainstReference(settings, [{ type: 'resign', player: 'BLACK' }]);
  assert.deepEqual(resigned.finalState.topologyState.ruleState.resignedPlayers, ['BLACK']);
});

test('batch preserves automatic skips and exact final commitments', async () => {
  const settings = fixtureSettings(), mini = restoreGame(settings), actions = [];
  while (!mini.gameOver && actions.length < 10) {
    const move = mini.getLegalMoves()[0]; assert.ok(move);
    const action = { type: 'move', player: mini.currentPlayer, vertexId: move.vertexId };
    assert.equal(mini.playMove(move.vertexId).success, true); actions.push(action);
  }
  assert.ok(mini.gameOver && mini.consecutiveSkips === 2, 'the reference game ended via automatic skips');
  const doc = await checkAgainstReference(settings, actions);
  for (const [where, value] of [
    ['actor', 'WHITE'], ['vertexId', 'cv:missing'], ['stateHash', `sha256:${'0'.repeat(64)}`],
    ['score', 999], ['history', 'forged'],
  ]) {
    const altered = structuredClone(doc);
    if (where === 'actor') altered.actions[0].player = value;
    else if (where === 'vertexId') altered.actions[0].vertexId = value;
    else if (where === 'stateHash') altered.finalState.stateHash = value;
    else if (where === 'score') altered.finalState.topologyState.ruleState.terminal.territories.BLACK.area = value;
    else altered.finalState.topologyState.ruleState.historyHashes.push(value);
    await assert.rejects(validateContribution(wrap(altered)), where);
  }
});

test('existence short-circuit honors a Superko-rejected candidate without mutating history', () => {
  const reference = new GameEngine({ ...fixtureSettings(), deferTerritoryUpdates: false });
  const player = reference.currentPlayer, candidate = reference.getLegalMoves(player)[0]; assert.ok(candidate);
  const saved = reference._captureTopologyState();
  assert.equal(reference._addNode(candidate.vertexId, player), true);
  const forbidden = reference._computeStateHash(reference._getNextPlayer(player));
  reference._restoreTopologyState(saved); reference.historyHashes.add(forbidden);
  assert.equal(reference._evaluateMove(candidate.vertexId, player).reason, 'SUPERKO_VIOLATION');
  const before = canonicalize(reference.getTopologyRuleState());
  const full = reference.getLegalMoves(player).length > 0;
  const short = reference.validPositions.some(vertexId => reference._evaluateMove(vertexId, player).legal);
  assert.equal(short, full);
  assert.equal(canonicalize(reference.getTopologyRuleState()), before);
});
