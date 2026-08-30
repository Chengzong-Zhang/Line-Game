import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { TERRITORY_V2_HOT_PATH_FIXTURES } from "./territory-v2-fixtures.mjs";

const engineSource = await fs.readFile(new URL("../GameEngine.js", import.meta.url), "utf8");
const { GameEngine, TerritoryRulesVersion } = await import(
  `data:text/javascript;base64,${Buffer.from(engineSource).toString("base64")}`
);

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function rounded(value) {
  return Number(value.toFixed(3));
}

function canonicalPolygonKey(polygon) {
  if (!polygon?.length) return "";
  const lastPoint = polygon[polygon.length - 1];
  const openPolygon = polygon.length > 1
    && polygon[0][0] === lastPoint[0]
    && polygon[0][1] === lastPoint[1]
    ? polygon.slice(0, -1)
    : polygon;
  const representations = [];
  for (const oriented of [openPolygon, [...openPolygon].reverse()]) {
    for (let offset = 0; offset < oriented.length; offset += 1) {
      representations.push(
        [...oriented.slice(offset), ...oriented.slice(0, offset)]
          .map((point) => `${point[0]},${point[1]}`)
          .join("|"),
      );
    }
  }
  representations.sort();
  return representations[0] ?? "";
}

function benchmarkSmoke(gridSize, rulesVersion, samples = 5) {
  const constructorMs = [];
  const firstMoveMs = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let started = performance.now();
    const game = new GameEngine({ gridSize, playerCount: 2, rulesVersion });
    constructorMs.push(performance.now() - started);

    started = performance.now();
    const result = game.playMove([2, 0]);
    if (!result.success) throw new Error(`grid ${gridSize}: deterministic first move failed`);
    firstMoveMs.push(performance.now() - started);
  }
  return {
    scenario: "constructor-and-first-move-smoke",
    gridSize,
    rulesVersion,
    samples,
    constructorMedianMs: rounded(median(constructorMs)),
    firstMoveMedianMs: rounded(median(firstMoveMs)),
  };
}

function createFixtureGame(fixture) {
  const game = new GameEngine({
    gridSize: fixture.gridSize,
    playerCount: fixture.playerCount,
    rulesVersion: TerritoryRulesVersion.V2,
  });
  fixture.moves.forEach((point, index) => {
    const result = game.playMove(point);
    assert.equal(
      result.success,
      true,
      `${fixture.name}: move ${index + 1} ${point} failed: ${result.reason}`,
    );
  });
  assert.deepEqual(
    Object.fromEntries(game.activePlayers.map((player) => [
      player,
      game.cachedTerritories[player].area,
    ])),
    fixture.expectedAreas,
    `${fixture.name}: area drift`,
  );
  assert.deepEqual(
    Object.fromEntries(game.activePlayers.map((player) => [
      player,
      canonicalPolygonKey(game.cachedTerritories[player].polygon),
    ])),
    fixture.expectedPolygonKeys,
    `${fixture.name}: canonical polygon drift`,
  );
  return game;
}

function collectHotPathDiagnostics(game) {
  const diagnostics = {
    floodFillCalls: 0,
    bfsCalls: 0,
    boundaryCycleChecks: 0,
    reconstructedPaths: 0,
  };
  const wallSets = new Set();
  const originalCovered = game._getCoveredPoints;
  const originalBfs = game._bfsFromSource;
  const originalCycle = game._hasBoundaryCycle;
  const originalPaths = game._iterateReconstructedPaths;

  game._getCoveredPoints = function instrumentedCovered(...args) {
    diagnostics.floodFillCalls += 1;
    return originalCovered.apply(this, args);
  };
  game._bfsFromSource = function instrumentedBfs(...args) {
    diagnostics.bfsCalls += 1;
    return originalBfs.apply(this, args);
  };
  game._hasBoundaryCycle = function instrumentedCycle(polygon) {
    diagnostics.boundaryCycleChecks += 1;
    const indices = [];
    for (const point of polygon ?? []) {
      const index = this._keyToIdx.get(`${point[0]},${point[1]}`);
      if (index !== undefined) indices.push(index);
    }
    wallSets.add([...new Set(indices)].sort((left, right) => left - right).join(","));
    return originalCycle.call(this, polygon);
  };
  game._iterateReconstructedPaths = function* instrumentedPaths(...args) {
    for (const path of originalPaths.apply(this, args)) {
      diagnostics.reconstructedPaths += 1;
      yield path;
    }
  };

  try {
    game._updateTerritories();
  } finally {
    delete game._getCoveredPoints;
    delete game._bfsFromSource;
    delete game._hasBoundaryCycle;
    delete game._iterateReconstructedPaths;
  }

  diagnostics.uniqueWallSetsObserved = wallSets.size;
  diagnostics.repeatedWallSetObservations = diagnostics.boundaryCycleChecks - wallSets.size;
  return diagnostics;
}

function benchmarkHotPath(fixture, samples = 21) {
  const game = createFixtureGame(fixture);
  const diagnostics = collectHotPathDiagnostics(game);
  game._updateTerritories();

  const updateMs = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const started = performance.now();
    game._updateTerritories();
    updateMs.push(performance.now() - started);
  }

  return {
    scenario: "territory-v2-midgame-update",
    fixture: fixture.name,
    gridSize: fixture.gridSize,
    playerCount: fixture.playerCount,
    plies: fixture.moves.length,
    samples,
    updateP50Ms: rounded(median(updateMs)),
    updateP95Ms: rounded(percentile(updateMs, 0.95)),
    diagnostics,
  };
}

const smoke = [];
for (const gridSize of [5, 9, 15]) {
  for (const rulesVersion of [TerritoryRulesVersion.V1, TerritoryRulesVersion.V2]) {
    smoke.push(benchmarkSmoke(gridSize, rulesVersion));
  }
}

console.log(JSON.stringify({
  measurementPolicy: "descriptive-only; no machine-dependent pass threshold",
  smoke,
  territoryV2HotPath: TERRITORY_V2_HOT_PATH_FIXTURES.map((fixture) => benchmarkHotPath(fixture)),
}, null, 2));
