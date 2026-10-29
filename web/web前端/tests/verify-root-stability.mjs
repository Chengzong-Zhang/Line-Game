import assert from 'node:assert/strict';
import { computeRootStability, stabilityPointKey } from '../RootStability.js';
import { GameEngine } from '../GameEngine.js';
import '../TopologyGameEngine.js';
import { createSurfacePreset } from '../BoardPresets.js';

function symbolic(nodes, paths, roots = ['r']) {
  return {
    currentPlayer: 'BLACK', initialRoots: { BLACK: roots },
    _getPlayerNodes: () => nodes,
    topologyPaths: { BLACK: new Map(paths.map(([id, vertices]) => [id, {
      pathId: id, startVertexId: vertices[0], endVertexId: vertices.at(-1), vertices,
    }])) },
  };
}
assert.deepEqual(computeRootStability(symbolic(['r', 'a', 'b'], [
  ['ra', ['r', 'a']], ['ab', ['a', 'b']],
])).nodeKeys, ['r', 'a', 'b']);
assert.deepEqual(computeRootStability(symbolic(['r', 'a', 'b'], [
  ['ra', ['r', 'x', 'a']], ['rb', ['r', 'y', 'b']], ['ab', ['a', 'b']],
])).nodeKeys, ['r'], 'two long supports do not make a permanent component');
assert.deepEqual(computeRootStability(symbolic(['r', 'a', 'b'], [
  ['rab', ['r', 'a', 'b']],
])).nodeKeys, ['r'], 'an uncertified interior NODE is not a permanent cut barrier');
assert.deepEqual(computeRootStability(symbolic(['r', 'a', 'b'], [
  ['rab', ['r', 'a', 'b']], ['ra', ['r', 'a']],
])).nodeKeys, ['r', 'a', 'b'], 'dependencies activate regardless of edge enumeration order');
assert.deepEqual(computeRootStability(symbolic(['r', 'q', 'a'], [
  ['qa', ['q', 'a']],
], ['r', 'q'])).nodeKeys, ['r', 'q', 'a']);
assert.deepEqual(computeRootStability(symbolic(['r', 'a'], [])).nodeKeys, ['r'],
  'physical adjacency is not a logical path');

for (const options of [
  { gridSize: 5, playerCount: 2, rulesVersion: 'territory-v3' },
  { gridSize: 5, playerCount: 3, boardShape: 'hexagon', rulesVersion: 'territory-v3' },
  { boardDefinition: createSurfacePreset('cylinder', { gridSize: 5 }) },
  { boardDefinition: createSurfacePreset('sphere', { gridSize: 5 }) },
]) {
  const engine = new GameEngine({ ...options, deferTerritoryUpdates: true });
  engine._isReplayingBatch = true;
  let inspected = 0;
  for (let turn = 0; turn < 6 && !engine.gameOver; turn += 1) {
    const before = engine._captureReplayState();
    const certificates = engine.activePlayers.map(player => computeRootStability(engine, player));
    assert.deepEqual(engine._captureReplayState(), before, 'certification must not mutate rules/history');
    const moves = engine.getLegalMoves();
    for (const move of [...moves, null]) {
      engine._restoreReplayState(before);
      const action = move == null ? engine.skipTurn() : engine.playMove(move.vertexId ?? move.point ?? move);
      assert.equal(action.success, true);
      for (const certificate of certificates) {
        const present = new Set(engine._getPlayerNodes(certificate.player).map(stabilityPointKey));
        for (const key of certificate.nodeKeys) assert.ok(present.has(key), `lost certified ${key}`);
      }
      inspected += 1;
    }
    engine._restoreReplayState(before);
    if (!moves.length) engine.skipTurn(); else {
      const root = engine.initialRoots?.[engine.currentPlayer]?.[0] ?? engine.initialPositions[engine.currentPlayer];
      const adjacent = new Set(engine.getAdjacentPositions(root).map(stabilityPointKey));
      const chosen = moves.find(move => adjacent.has(stabilityPointKey(move.vertexId ?? move.point ?? move))) ?? moves[0];
      assert.equal(engine.playMove(chosen.vertexId ?? chosen.point ?? chosen).success, true);
    }
  }
  assert.ok(inspected > 5);
}
console.log('PASS: sufficient permanent-root certificates, path dependencies, multiple roots and all legal replies across ordinary/topology boards.');
