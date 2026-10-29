import assert from "node:assert/strict";

import "../TopologyGameEngine.js";
import { GameEngine, TopologyRulesVersion } from "../GameEngine.js";
import { createTorusBoardDefinition } from "../BoardPresets.js";
import { computeTerritory } from "../SurfaceTerritory.js";
import {
  CONCAVE_GAP_DEFINITION,
  copyDefinition,
} from "./fixtures/board-topology-v1-fixtures.mjs";

const concave = new GameEngine({ boardDefinition: CONCAVE_GAP_DEFINITION });
assert.ok(concave instanceof GameEngine, "the topology engine remains a GameEngine instance");
assert.equal(concave.isTopologyBoard, true);
assert.equal(concave.boardShape, "custom");
assert.equal(concave.rulesVersion, TopologyRulesVersion.SURFACE_V1);
assert.equal(typeof concave.boardHash, "string");
assert.equal(concave.getValidPositions().every((id) => typeof id === "string"), true,
  "runtime identity is canonical rather than a guessed coordinate row");
assert.equal(concave.getSnapshot().boardDefinition.schemaVersion, 1);
assert.equal(concave.getSnapshot().boardStates[concave.initialPositions.BLACK],
  concave._getPlayerStates("BLACK").node);

// A missing middle lattice point cannot be silently filtered out and then
// rejoined as a long legacy coordinate line.
const noJump = new GameEngine({
  boardDefinition: CONCAVE_GAP_DEFINITION,
  initialPositions: { BLACK: "v:2,0", WHITE: "v:5,3" },
});
assert.deepEqual(noJump.getLinePoints("v:2,0", "v:4,0"), []);
assert.equal(noJump.canConnectWithBlocking("v:2,0", "v:4,0", "BLACK"), false);
assert.equal(noJump.playMove("v:4,0").success, false);

const move = concave.getLegalMoves("BLACK")[0];
assert.ok(move && typeof move.vertexId === "string", "a compiled custom board has canonical legal moves");
const moveResult = concave.playMove(move.vertexId);
assert.equal(moveResult.success, true);
assert.ok(concave.topologyPaths.BLACK.size >= 1, "the move stores a logical path identity");
assert.equal(concave.getSnapshot().edges.BLACK.length, concave.topologyPaths.BLACK.size);

// GameEngine's score now dispatches through the topology component rule, not
// the old triangle/hexagon polygon scorer.
const expectedTerritory = computeTerritory(concave.compiledBoard, {
  ownedSampleIdsByPlayer: concave._coverageByPlayer(),
}, "BLACK");
assert.equal(concave.getScoreboard().BLACK.area, expectedTerritory.area);
assert.deepEqual(
  new Set(concave.getScoreboard().BLACK.renderPoints),
  new Set([...expectedTerritory.ownedSampleIds, ...expectedTerritory.enclosedSampleIds]),
);

// Closed presets retain no fake outside boundary and still admit an opening.
const torus = new GameEngine({ boardDefinition: createTorusBoardDefinition() });
assert.equal(torus.compiledBoard.realBoundarySampleIds.length, 0);
assert.ok(torus.getLegalMoves().length > 0,
  "minimum supported torus preset has a real opening instead of an auto-skip");
const torusMove = torus.getLegalMoves()[0].vertexId;
assert.equal(torus.playMove(torusMove).success, true);
assert.ok(torus.getSnapshot().topologyPaths.BLACK.length >= 1);

// Failed map compilation happens before a new engine is returned and does not
// mutate an unrelated running legacy game.
const legacy = new GameEngine({ gridSize: 5 });
const legacyBefore = legacy.getSnapshot();
const invalid = copyDefinition(CONCAVE_GAP_DEFINITION);
invalid.seamPairs = [{
  id: "bad-self",
  edgeOccurrenceA: "u:0,0:0",
  edgeOccurrenceB: "u:0,0:0",
  endpointMap: [0, 1],
}];
assert.throws(() => new GameEngine({ boardDefinition: invalid }), /INVALID_BOARD_DEFINITION/);
assert.equal(legacy.boardShape, "triangle");
assert.deepEqual(legacy.getSnapshot(), legacyBefore,
  "a bad topology import cannot clear or alter the active legacy match");

// The normal terminal path still computes synchronous formal areas.
assert.equal(concave.skipTurn().success, true);
assert.equal(concave.skipTurn().success, true);
assert.equal(concave.gameOver, true);
assert.ok(["BLACK", "WHITE", "DRAW"].includes(concave.getWinner()));

console.log(JSON.stringify({
  status: "PASS",
  coverage: [
    "fixed concave match construction",
    "no jump across a missing lattice point",
    "canonical logical paths and surface territory dispatch",
    "closed torus opening without fake boundary",
    "failed import preserves an existing game",
    "PASS terminal scoring",
  ],
}));
