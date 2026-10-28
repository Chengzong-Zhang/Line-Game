import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GameEngine,
  TopologyRulesVersion,
  createTorusBoardDefinition,
  decodeTopologyState,
} from '../src/core.js';

test('vendored topology runtime registers before a surface-v1 GameEngine is created', () => {
  const settings = {
    boardDefinition: createTorusBoardDefinition({ width: 4, height: 4 }),
    rulesVersion: TopologyRulesVersion.SURFACE_V1,
    playerCount: 2,
  };
  const engine = new GameEngine(settings);
  const initial = engine.getSnapshot();

  assert.equal(engine.isTopologyBoard, true);
  assert.equal(initial.rulesVersion, TopologyRulesVersion.SURFACE_V1);
  assert.match(initial.boardHash, /^[a-f0-9]{64}$/);
  assert.ok(initial.legalMoves.length > 0);

  const move = initial.legalMoves[0];
  assert.equal(typeof move.vertexId, 'string');
  assert.equal(engine.playMove(move.vertexId).success, true);

  const encoded = engine.encodeTopologyState();
  const decoded = decodeTopologyState(encoded);
  assert.equal(decoded.boardHash, initial.boardHash);

  const restored = new GameEngine(settings);
  assert.equal(restored.restoreTopologyState(encoded), true);
  assert.equal(restored.getSnapshot().boardHash, initial.boardHash);
  assert.equal(restored.getSnapshot().positionRevision, 1);
});
