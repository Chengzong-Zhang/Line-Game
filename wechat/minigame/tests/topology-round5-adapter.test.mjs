import test from 'node:test';
import assert from 'node:assert/strict';
import { createTopologySetup, generateTopologyBoard, changeTopologyStarts } from '../src/topology-setup.js';
import { GameEngine } from '../src/core.js';
import { executeTask } from '../src/worker-runtime.js';

test('v4 random topology uses the requested player count and freezes all random roots', () => {
  let result = generateTopologyBoard(createTopologySetup(), { gridSize: 5, playerCount: 3 }, 'mini-round5-fixed');
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.setup.definition.generator.generatorVersion, 'random-board-v4');
  result = changeTopologyStarts(result.setup, { mode: 'random', playerCount: 3, random: () => 0.25 });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  result = changeTopologyStarts(result.setup, { mode: 'append-random', playerCount: 3, player: 'WHITE', random: () => 0.75 });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.setup.compiled.startingRoots.WHITE.length, 2);
  assert.equal(result.setup.compiled.startingRoots.BLACK.length, 1);
  const engine = new GameEngine({ rulesVersion: 'surface-v1', playerCount: 3, startPlayer: 'BLACK', boardDefinition: result.setup.definition });
  assert.equal(engine.boardHash, result.setup.boardHash);
  assert.equal(engine.getSnapshot().topology.startingRoots.WHITE.length, 2);
});

test('topology worker returns searched canonical actions and discloses completed depth', () => {
  const result = generateTopologyBoard(createTopologySetup(), { gridSize: 5, playerCount: 2 }, 'mini-round5-search');
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const settings = { gridSize: 5, playerCount: 2, startPlayer: 'BLACK', rulesVersion: 'surface-v1', boardShape: 'custom', boardDefinition: result.setup.definition, boardHash: result.setup.boardHash, topologyProtocolVersion: 'board-topology-v1' };
  const state = executeTask({ kind: 'STATE', payload: { settings, actions: [] } });
  const reply = executeTask({ kind: 'AI', payload: { settings, actions: [], profile: 'topology-generic', timeLimitMs: 80 }, context: { boardHash: settings.boardHash, topologyProtocolVersion: 'board-topology-v1', revision: state.snapshot.positionRevision, player: 'BLACK' } });
  assert.ok(reply.searchInfo);
  for (const move of reply.moves) { assert.ok(['move', 'skip'].includes(move.type)); assert.equal(Object.hasOwn(move, 'point'), false); if (move.type === 'move') assert.equal(typeof move.vertexId, 'string'); }
});

test('double-surface presets retain their 3D geometry and roots', async () => {
  const { useTopologyPreset } = await import('../src/topology-setup.js');
  const { buildSurfaceCells } = await import('../src/topology/TopologySurface3D.js');
  for (const name of ['double-sphere', 'double-torus']) {
    const result = useTopologyPreset(createTopologySetup(), name, { gridSize: 7, playerCount: 3 });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    const engine = new GameEngine({ rulesVersion: 'surface-v1', playerCount: 3, startPlayer: 'BLACK', boardDefinition: result.setup.definition });
    const surface = buildSurfaceCells(engine.getSnapshot(), 1);
    assert.equal(surface.surface.kind, name);
    assert.ok(surface.cells.length > 0);
    assert.ok(surface.cells.every(cell => cell.points.every(point => Array.isArray(point) && point.length === 3 && point.every(Number.isFinite))));
  }
});

test('topology replay reports actual score and edge changes', async () => {
  const { useTopologyPreset } = await import('../src/topology-setup.js');
  const result = useTopologyPreset(createTopologySetup(), 'cylinder', { gridSize: 5, playerCount: 2 });
  const settings = { gridSize: 5, playerCount: 2, startPlayer: 'BLACK', rulesVersion: 'surface-v1', boardShape: 'custom', boardDefinition: result.setup.definition, boardHash: result.setup.boardHash, topologyProtocolVersion: 'board-topology-v1' };
  const initial = executeTask({ kind: 'STATE', payload: { settings, actions: [] } });
  const move = initial.snapshot.legalMoves[0].vertexId;
  const replay = executeTask({ kind: 'REPLAY_STEP', payload: { settings, actions: [{ type: 'move', vertexId: move }], cursor: 1 } });
  assert.ok(replay.effects.addedEdgesByPlayer.BLACK.length > 0);
  assert.equal(replay.effects.territoryDelta.BLACK, replay.snapshot.territories.BLACK.area - initial.snapshot.territories.BLACK.area);
});

test('native F2 algebra matches the Web implementation without BigInt syntax', async () => {
  const native = await import('../src/topology/TopologyAlgebra.js');
  const web = await import('../../../web/web前端/TopologyAlgebra.js');
  const { useTopologyPreset } = await import('../src/topology-setup.js');
  for (const name of ['cylinder', 'mobius', 'torus', 'klein-bottle', 'double-sphere', 'double-torus']) {
    const result = useTopologyPreset(createTopologySetup(), name, { gridSize: 5, playerCount: 2 });
    const board = result.setup.compiled;
    for (const relativeBoundary of [false, true]) {
      assert.deepEqual(native.analyzeBoardAlgebra(board, { relativeBoundary }), web.analyzeBoardAlgebra(board, { relativeBoundary }));
      for (const edgeIds of [[], board.edgeClasses.slice(0, 3).map(edge => edge.id), [board.edgeClasses[0].id, board.edgeClasses[0].id]])
        assert.deepEqual(native.analyzeEdgeCycle(board, edgeIds, { relativeBoundary }), web.analyzeEdgeCycle(board, edgeIds, { relativeBoundary }));
    }
  }
});
