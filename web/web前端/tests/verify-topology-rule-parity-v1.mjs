import assert from "node:assert/strict";
import "../TopologyGameEngine.js";
import { GameEngine } from "../GameEngine.js";
import { createLegacyBoardDefinition } from "../BoardDefinition.js";
import { createCylinderBoardDefinition, createMobiusBoardDefinition,
  createTorusBoardDefinition, createKleinBottleBoardDefinition } from "../BoardPresets.js";
import { enumerateConnections } from "../BoardPaths.js";
import { makeTriangularPatchDefinition } from "./fixtures/board-topology-v1-fixtures.mjs";

const options = { gridSize: 7, playerCount: 2, boardShape: "triangle" };
const legacy = new GameEngine(options);
const surface = new GameEngine({ boardDefinition: createLegacyBoardDefinition(options),
  initialPositions: legacy.initialPositions, playerCount: 2 });
const canonical = (point) => surface._canonicalId(point);
const played = [];
const compare = () => {
  assert.equal(surface.currentPlayer, legacy.currentPlayer);
  for (const point of legacy.getValidPositions()) {
    assert.equal(surface.getStateAt(point), legacy.getStateAt(point), `state ${point}; moves ${JSON.stringify(played)}`);
    assert.equal(surface._evaluateMove(point).legal, legacy._evaluateMove(point).legal,
      `legal ${point} for ${legacy.currentPlayer}`);
  }
};
compare();
for (const point of [[2, 0], [3, 3], [0, 2], [2, 3]]) {
  played.push(point);
  assert.equal(legacy.playMove(point).success, true, `legacy ${point}`);
  assert.equal(surface.playMove(canonical(point)).success, true, `surface ${point}`);
  compare();
}

// A friendly line or intermediate node never stops a straight connection, but
// any enemy-covered point away from the move blocks it, including a crossing.
const definition = makeTriangularPatchDefinition({ width: 5, height: 4,
  startingVertices: { BLACK: "v:0,1", WHITE: "v:2,3" } });
const example = new GameEngine({ boardDefinition: definition });
const id = (x, y) => example._canonicalId([x, y]);
const route = (enemy = []) => enumerateConnections(example.compiledBoard, {
  coverageByPlayer: { BLACK: [id(0, 1), id(1, 1), id(2, 1)], WHITE: enemy },
  nodesByPlayer: { BLACK: [id(0, 1), id(2, 1)] },
}, id(4, 1), "BLACK");
assert.ok(route().some((path) => path.endVertexId === id(0, 1)
  && path.vertices.join(",") === [id(4, 1), id(3, 1), id(2, 1), id(1, 1), id(0, 1)].join(",")));
assert.equal(route([id(3, 1)]).length, 0, "enemy line or node blocks passage");

// Construct two intact root-connected edges, then cut the black edge at (2,1).
// The white move forms a three-node adjacency chain and is legal only because
// it cuts an actual black logical edge; its disconnected endpoint disappears.
const blackNode = example._getPlayerStates("BLACK").node;
const whiteNode = example._getPlayerStates("WHITE").node;
example._setState(id(4, 1), blackNode);
example._setState(id(2, 2), whiteNode);
for (const [player, start, end] of [["BLACK", id(4, 1), id(0, 1)], ["WHITE", id(2, 2), id(2, 3)]]) {
  const paths = enumerateConnections(example.compiledBoard, { coverageByPlayer: { [player]: [end] } }, start, player);
  assert.equal(paths.length, 1);
  example.topologyPaths[player].set(paths[0].pathId, paths[0]);
}
example._rebuildTopology();
assert.equal(example._checkThreePointLimitation(id(2, 1), "WHITE"), false);
assert.equal(example._addNode(id(2, 1), "WHITE"), true);
assert.equal(example.getStateAt(id(4, 1)), 0, "disconnected enemy node is removed");
assert.equal(example.topologyPaths.BLACK.size, 0, "cut enemy path is removed");

const forged = new GameEngine({ boardDefinition: definition });
forged._setState(id(2, 2), whiteNode);
forged._setState(id(2, 1), forged._getPlayerStates("BLACK").line);
assert.equal(forged._addNode(id(2, 1), "WHITE"), false, "an orphan enemy line cannot grant the attack exception");
forged._setState(id(2, 1), forged._getPlayerStates("WHITE").line);
assert.equal(forged._addNode(id(2, 1), "WHITE"), false, "own line does not grant the attack exception");
// Extend the same live position, preferring actual cuts. Compare every legal
// choice and every occupied point before and after each step.
let seed = 0x38d4c1;
let attackCount = 0;
for (let step = 0; step < 12 && !legacy.gameOver && !surface.gameOver; step += 1) {
  const moves = legacy.getLegalMoves();
  if (!moves.length) break;
  const attacks = moves.filter((move) => move.isAttack);
  const candidates = attacks.length ? attacks : moves;
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const point = candidates[seed % candidates.length].point;
  if (attacks.length) attackCount += 1;
  played.push(point);
  assert.equal(legacy.playMove(point).success, true);
  assert.equal(surface.playMove(canonical(point)).success, true);
  compare();
}
assert.ok(attackCount > 0, "the differential game must exercise a cut");
const saved = surface.encodeTopologyState();
const restored = new GameEngine({ boardDefinition: surface.boardDefinition });
assert.equal(restored.restoreTopologyState(saved), true);
assert.deepEqual(restored.getTopologyRuleState(), surface.getTopologyRuleState(),
  "state, paths, and full Superko history survive a cut and subsequent moves");

for (const factory of [createCylinderBoardDefinition, createMobiusBoardDefinition,
  createTorusBoardDefinition, createKleinBottleBoardDefinition]) {
  const legacyDefinition = factory({ width: 5, height: 5 });
  legacyDefinition.topology.movementStrategy = 'simple-rays-v2';
  const game = new GameEngine({ boardDefinition: legacyDefinition });
  const snapshot = game.getSnapshot();
  for (const owner of game.activePlayers) {
    const protectedIds = new Set(game.getAdjacentPositions(game.initialPositions[owner]));
    for (const id of game.validPositions) {
      const entry = snapshot.topology.protectionZones.find((item) => item.canonicalVertexId === id);
      assert.equal(entry?.owners.includes(owner) ?? false, protectedIds.has(id));
      const opponent = game.activePlayers.find((player) => player !== owner);
      if (protectedIds.has(id)) assert.equal(game._isInProtectionZone(id, opponent), true);
    }
  }
  for (const copy of snapshot.topology.viewBoard.pointCopies) {
    assert.equal(game._canonicalId(copy.sourceVertexId), copy.canonicalVertexId);
  }
  for (const face of snapshot.topology.viewBoard.faces) {
    assert.equal(face.copyIds.length, 3);
    assert.equal(face.canonicalVertexIds.length, 3);
  }
  // A ray starting on a glued vertex may have several atlas copies. It must
  // still reach the target face through the transported direction.
  let transported = false;
  for (const transition of game.compiledBoard.directionTransitions) {
    for (const rule of transition.endpointTransport) {
      const sourceRaw = transition.sourceFaceSide.orientedVertices[rule.sourceEndpointIndex];
      const start = game._canonicalId(sourceRaw);
      const target = game._canonicalId(transition.targetFaceSide.interiorVertexId);
      if (start === target) continue;
      const paths = enumerateConnections(game.compiledBoard,
        { coverageByPlayer: { BLACK: [target] } }, start, "BLACK");
      if (paths.some((path) => path.seamCrossings.some((crossing) =>
        crossing.fromEdgeOccurrenceId === transition.fromEdgeOccurrenceId
        && crossing.sourceVertexId === sourceRaw
        && crossing.targetDirectionState === rule.targetEntryDirectionIndex))) {
        transported = true;
        break;
      }
    }
    if (transported) break;
  }
  assert.equal(transported, true, "at least one seam route must transport its direction");
}
console.log(JSON.stringify({ status: "PASS", planarMoves: played.length, planarAttacks: attackCount,
  coverage: ["planar legacy parity including a cut and crawl", "blocking and straight complete paths", "three-node exception requires a real enemy cut", "disconnected cleanup", "surface start protection and atlas copies"] }));
