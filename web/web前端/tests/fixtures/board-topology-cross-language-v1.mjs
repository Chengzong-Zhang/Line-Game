/**
 * Frozen cross-process witnesses for the BoardDefinition / compiler contract.
 *
 * This module deliberately obtains every structural value from the Web
 * implementation.  The Python test that consumes it separately checks the
 * documented hand expectations (surface invariants and territory values), so
 * it is not a second copy of either compiler.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createCylinderBoardDefinition,
  createKleinBottleBoardDefinition,
  createMobiusBoardDefinition,
  createTorusBoardDefinition,
} from "../../BoardPresets.js";
import { compileBoardOrThrow } from "../../BoardCompiler.js";
import { enumerateConnections } from "../../BoardPaths.js";
import { computeTerritory } from "../../SurfaceTerritory.js";
import "../../TopologyGameEngine.js";
import { GameEngine, TopologyRulesVersion } from "../../GameEngine.js";
import {
  CONCAVE_GAP_DEFINITION,
  NONADJACENT_REVERSED_SEAM,
  copyDefinition,
  makeTriangularPatchDefinition,
} from "./board-topology-v1-fixtures.mjs";

function compareIds(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// This is the frozen v1 contract. New product presets default to v2, so
// explicitly retain the original movement version for every preset witness.
function legacyPreset(factory) {
  const definition = factory();
  definition.topology.movementStrategy = "simple-rays-v1";
  return definition;
}

function normalizedComponents(components) {
  return components.map((component) => ({
    sampleIds: [...component.sampleIds].sort(compareIds),
    weight: component.weight,
    touchesRealBoundary: component.touchesRealBoundary,
    containsEnemy: component.containsEnemy,
    counted: component.counted,
  })).sort((left, right) => left.sampleIds.join("|").localeCompare(right.sampleIds.join("|")));
}

function structuralSnapshot(definition) {
  const board = compileBoardOrThrow(definition);
  return {
    definition: board.definition,
    boardHash: board.boardHash,
    canonicalVertices: board.canonicalVertices.map((vertex) => ({
      id: vertex.id,
      sourceVertexIds: [...vertex.sourceVertexIds],
    })),
    rawVertexToCanonical: board.rawVertexToCanonical,
    sampleIds: [...board.sampleIds],
    sampleWeights: board.sampleWeights,
    sampleAdjacency: Object.fromEntries(Object.entries(board.sampleAdjacency)
      .map(([id, neighbors]) => [id, [...neighbors].sort(compareIds)])),
    realBoundarySampleIds: [...board.realBoundarySampleIds].sort(compareIds),
    realBoundaryEdgeClassIds: [...board.realBoundaryEdgeClassIds].sort(compareIds),
    boundaryComponents: board.boundaryComponents.map((component) => [...component].sort(compareIds))
      .sort((left, right) => left.join("|").localeCompare(right.join("|"))),
    eulerCharacteristic: board.eulerCharacteristic,
    orientable: board.orientable,
  };
}

function territorySnapshot(board, position, playerId) {
  const territory = computeTerritory(board, position, playerId);
  return {
    area: territory.area,
    ownedSampleIds: [...territory.ownedSampleIds].sort(compareIds),
    enclosedSampleIds: [...territory.enclosedSampleIds].sort(compareIds),
    components: normalizedComponents(territory.components),
  };
}

const planarDonutDefinition = makeTriangularPatchDefinition({ width: 5, height: 5 });
const planarDonutBoard = compileBoardOrThrow(planarDonutDefinition);
const planarCenter = planarDonutBoard.rawVertexToCanonical["v:2,2"];
const planarRing = [...planarDonutBoard.sampleAdjacency[planarCenter]].sort(compareIds);

const torusDefinition = legacyPreset(createTorusBoardDefinition);
const torusBoard = compileBoardOrThrow(torusDefinition);
const torusEnemy = torusBoard.sampleIds[0];

// This input intentionally omits starts.  The paired Python test is an
// expected failure until Python adopts the same graph-distance selection and
// freezes the resulting start layout into the gameplay hash.
const missingStartsDefinition = makeTriangularPatchDefinition({ width: 3, height: 3 });
delete missingStartsDefinition.startingVertices;
const webDefaultStarts = new GameEngine({
  boardDefinition: missingStartsDefinition,
  rulesVersion: TopologyRulesVersion.SURFACE_V1,
  playerCount: 2,
});

// This is an actual Web simple-rays-v1 path that crosses a torus seam.  The
// Python adapter does not infer the ray itself, but its import/restore layer
// must preserve and structurally validate the Web-produced payload.
const seamPathDefinition = legacyPreset(createTorusBoardDefinition);
seamPathDefinition.startingVertices = { BLACK: "v:0,1", WHITE: "v:3,3" };
const seamPathBoard = compileBoardOrThrow(seamPathDefinition);
const seamPathStart = seamPathBoard.rawVertexToCanonical["v:1,1"];
const seamPathExisting = seamPathBoard.rawVertexToCanonical["v:0,1"];
const seamPath = enumerateConnections(
  seamPathBoard,
  { coverageByPlayer: { BLACK: [seamPathExisting] } },
  seamPathStart,
  "BLACK",
).find((path) => path.endVertexId === seamPathExisting && path.seamCrossings.length > 0);
if (!seamPath) throw new Error("Expected a seam-crossing torus connection fixture.");

export function createCrossLanguageContractFixture() {
  return {
    contractVersion: "board-topology-v1",
    cases: [
      { id: "concave-planar", ...structuralSnapshot(copyDefinition(CONCAVE_GAP_DEFINITION)) },
      { id: "arbitrary-reversed-seam", ...structuralSnapshot(copyDefinition(NONADJACENT_REVERSED_SEAM)) },
      { id: "cylinder", ...structuralSnapshot(legacyPreset(createCylinderBoardDefinition)) },
      { id: "mobius", ...structuralSnapshot(legacyPreset(createMobiusBoardDefinition)) },
      { id: "torus", ...structuralSnapshot(torusDefinition) },
      { id: "klein-bottle", ...structuralSnapshot(legacyPreset(createKleinBottleBoardDefinition)) },
    ],
    territoryCases: [
      {
        id: "planar-donut-without-enemy",
        definition: planarDonutBoard.definition,
        position: { owners: { BLACK: planarRing } },
        playerId: "BLACK",
        result: territorySnapshot(planarDonutBoard, { ownedSampleIdsByPlayer: { BLACK: planarRing } }, "BLACK"),
      },
      {
        id: "planar-donut-with-enemy",
        definition: planarDonutBoard.definition,
        position: { owners: { BLACK: planarRing, WHITE: [planarCenter] } },
        playerId: "BLACK",
        result: territorySnapshot(planarDonutBoard, {
          ownedSampleIdsByPlayer: { BLACK: planarRing, WHITE: [planarCenter] },
        }, "BLACK"),
      },
      {
        id: "closed-torus-without-enemy",
        definition: torusBoard.definition,
        position: { owners: {} },
        playerId: "BLACK",
        result: territorySnapshot(torusBoard, { ownedSampleIdsByPlayer: {} }, "BLACK"),
      },
      {
        id: "closed-torus-with-enemy",
        definition: torusBoard.definition,
        position: { owners: { WHITE: [torusEnemy] } },
        playerId: "BLACK",
        result: territorySnapshot(torusBoard, { ownedSampleIdsByPlayer: { WHITE: [torusEnemy] } }, "BLACK"),
      },
    ],
    defaultStartWitness: {
      inputDefinition: missingStartsDefinition,
      selectedStarts: webDefaultStarts.initialPositions,
      boardDefinition: webDefaultStarts.boardDefinition,
      boardHash: webDefaultStarts.boardHash,
    },
    seamPathWitness: {
      definition: seamPathBoard.definition,
      boardHash: seamPathBoard.boardHash,
      newVertexId: seamPathStart,
      existingVertexId: seamPathExisting,
      path: seamPath,
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.stdout.write(JSON.stringify(createCrossLanguageContractFixture()));
}
