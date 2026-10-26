import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { MINIMAX_DIFFERENTIAL_CASES, loadMinimaxSource, runMinimaxDifferentialCase,
  verifyMinimaxExceptionRestore } from "../../tools/benchmark-minimax-search-v1.mjs";

const args = process.argv.slice(2), option = name => args.includes(name) ? args[args.indexOf(name) + 1] : null;
const candidate = await loadMinimaxSource();
const baseline = option("--baseline-source") ? await loadMinimaxSource(option("--baseline-source")) : null;
const selected = option("--cases")?.split(",");
if (selected) assert.ok(selected.every(id => MINIMAX_DIFFERENTIAL_CASES.some(row => row.id === id)), "Unknown case id");
const specs = MINIMAX_DIFFERENTIAL_CASES.filter(row => !selected || selected.includes(row.id));
const rows = [], started = performance.now();
for (const spec of specs) {
  const row = await runMinimaxDifferentialCase(spec, { candidate, baseline });
  rows.push({ id: row.id, exactRankingAndScores: true, fullStatePreserved: true,
    prunedRoots: row.optimized.search?.prunedRoots ?? null, optimizedNodes: row.optimized.search?.nodes ?? null,
    fullWindowNodes: row.fullWindow.search?.nodes ?? null, deliveredBaselineCompared: Boolean(baseline) });
}
const exceptions = [true, false].map(flag => verifyMinimaxExceptionRestore(candidate, flag));
function referenceBFS(engine, player) {
  const states = engine._getPlayerStates(player), opposing = new Set(engine._getOpponents(player)
    .flatMap(enemy => Object.values(engine._getPlayerStates(enemy))));
  const frontier = engine.validPositions.filter(point => [states.node, states.line].includes(engine._getState(point)));
  const visited = new Set(frontier.map(point => point.join(",")));
  for (let index = 0; index < frontier.length; index++) for (const point of engine.getAdjacentPositions(frontier[index])) {
    const key = point.join(",");
    if (!visited.has(key) && !opposing.has(engine._getState(point))) { visited.add(key); frontier.push(point); }
  }
  return visited.size;
}
const bfsRows = [];
for (const shape of ["triangle", "hexagon"]) for (const seats of [2, 3, 6, 15]) {
  const settings = { gridSize: seats === 15 ? 9 : 5, playerCount: seats, boardShape: shape,
    rulesVersion: "territory-v3", deferTerritoryUpdates: true };
  if (seats > 6) {
    settings.startingPointMode = "custom";
    const points = candidate.getBoardPositions(settings.gridSize, seats, shape);
    settings.initialPositions = Object.fromEntries(candidate.PLAYER_ORDER.slice(0, seats)
      .map((player, index) => [player, points[Math.floor(index * points.length / seats)]]));
  }
  const engine = new candidate.GameEngine(settings); engine._isReplayingBatch = true;
  const validate = label => {
    const before = candidate.saveState(engine), replay = engine._captureReplayState();
    for (const player of [...engine.activePlayers, ...engine.activePlayers].reverse()) {
      assert.equal(candidate.fastTerritoryBFS(engine, player), referenceBFS(engine, player), `${label}/${player}: reach mismatch`);
      if (baseline) assert.equal(candidate.fastTerritoryBFS(engine, player), baseline.fastTerritoryBFS(engine, player));
    }
    assert.deepEqual(candidate.saveState(engine), before); assert.deepEqual(engine._captureReplayState(), replay);
  };
  validate(`${shape}/${seats}/initial`);
  const saved = candidate.saveState(engine), legal = engine.getLegalMoves();
  if (legal.length) { assert.equal(engine.playMove(legal[0].point).success, true); validate(`${shape}/${seats}/after-legal`); }
  candidate.restoreState(engine, saved); validate(`${shape}/${seats}/restored`);
  engine.validPositions = engine.validPositions.map(point => [...point]); validate(`${shape}/${seats}/new-array`);
  const adjacent = engine.getAdjacentPositions; engine.getAdjacentPositions = function (point) { return adjacent.call(this, point); };
  validate(`${shape}/${seats}/new-adjacency-method`);
  bfsRows.push({ shape, seats, legalTransitionTested: legal.length > 0, restoreAndInvalidation: true });
}
// Square is not a native GameEngine board type. Exercise the general topology
// helper with an explicitly synthetic square, without claiming a new game mode.
const squarePoints = Array.from({ length: 25 }, (_, index) => [index % 5, Math.floor(index / 5)]);
const square = { validPositions: squarePoints, activePlayers: ["A", "B"],
  grid: new Map([["0,0", 1], ["4,4", 3], ["2,2", 4]]),
  _getOpponents(player) { return this.activePlayers.filter(actor => actor !== player); },
  _getPlayerStates(player) { return player === "A" ? { node: 1, line: 2 } : { node: 3, line: 4 }; },
  _getState(point) { return this.grid.get(point.join(",")) ?? 0; },
  getAdjacentPositions([x, y]) { return [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]
    .filter(([a, b]) => a >= 0 && b >= 0 && a < 5 && b < 5); } };
const squareBefore = structuredClone([...square.grid]);
for (const player of ["A", "B", "A"]) assert.equal(candidate.fastTerritoryBFS(square, player), referenceBFS(square, player));
assert.deepEqual([...square.grid], squareBefore);
square.grid.set("1,0", 4); square.grid.delete("4,4"); square.grid.set("3,3", 3);
for (const player of ["B", "A"]) assert.equal(candidate.fastTerritoryBFS(square, player), referenceBFS(square, player), "Synthetic occupancy must be reread");
const squareAdjacent = square.getAdjacentPositions;
square.getAdjacentPositions = function (point) { return squareAdjacent.call(this, point).filter(([x]) => x !== 1); };
for (const player of ["A", "B"]) assert.equal(candidate.fastTerritoryBFS(square, player), referenceBFS(square, player), "Changed adjacency method must invalidate topology");
square.getAdjacentPositions = squareAdjacent; square.validPositions = square.validPositions.map(point => [...point]);
square.grid = new Map(squareBefore);
for (const player of ["A", "B"]) assert.equal(candidate.fastTerritoryBFS(square, player), referenceBFS(square, player), "Restored synthetic occupancy must not reuse results");
bfsRows.push({ shape: "synthetic-square", seats: 2, nativeGameMode: false });
assert.deepEqual((await loadMinimaxSource()).hashes, candidate.hashes, "Candidate source changed while this behavior test was running");
console.log(JSON.stringify({ status: "PASS_MINIMAX_EXACT_ROOT_PRUNING_DIFFERENTIAL", cases: rows.length,
  depths: [...new Set(specs.map(row => row.depth))], playerCounts: [...new Set(specs.map(row => row.playerCount ?? 2))],
  rows, exceptions, bfsRows, elapsedMs: performance.now() - started, sourceHashes: { ...candidate.hashes, ...(baseline?.hashes ?? {}) },
  scope: "Exact equality to same-version full-window search and optional delivered source; v2/v3, depth1-4, 2/3 seats, PASS, auto-skip, Superko, ties and exception state restoration. No old frozen score assertions changed; no training or playing-strength claim." }));
