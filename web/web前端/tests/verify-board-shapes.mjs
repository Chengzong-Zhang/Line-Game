import assert from "node:assert/strict";
import GameEngine, { PLAYER_ORDER, getBoardVertices, resolveInitialPositions, resolveBoardShape } from "../GameEngine.js";
import GameController from "../GameController.js";
import Renderer from "../Renderer.js";
import { randomInitialPositions } from "../StartingPoints.js";
import { serializeEngineState } from "../AIStateProtocol.js";
import { createReplayDocument, validateReplayDocument, serializeRuleState } from "../ReplayCodec.js";
import { normalizeGameSettings } from "../OnlineAppState.js";
import { createLocalGameSession, persistLocalGameSession, loadLocalGameSession, sessionMatchesSettings } from "../LocalGameSession.js";
import { localPlayerProfile, normalizeLocalPlayers, usesGenericBoardAI } from "../LocalAIModes.js";
import { TrainingContribution } from "../TrainingContribution.js";

const shapes = ["triangle", "hexagon"];
const noop = () => {};
const values = new Map();
const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
const controllerFor = (settings) => Object.assign(Object.create(GameController.prototype), {
  options: { engine: settings }, engine: new GameEngine(settings), _engineEpoch: 0,
  _cancelTerritoryRefresh: noop, _scheduleTerritoryRefresh: noop, _syncSnapshot: noop,
  canvas: { style: {}, setAttribute: noop }, renderer: { invalidate: noop },
  _updateLargeBoardClass: noop, multiplayerEnabled: false, lastAction: null, localPlayer: null,
});
let openings = 0, savedStarts = 0, cuts = 0, workers = 0;
for (const boardShape of shapes) for (let count = 2; count <= 6; count++) {
  for (let size = 5; size <= 15; size++) {
    const settings = { playerCount: count, gridSize: size, boardShape, startPlayer: "BLACK", rulesVersion: "territory-v2" };
    const engine = new GameEngine(settings), r = size - 1, m = Math.floor(r / 2);
    assert.equal(engine.boardShape, boardShape);
    assert.equal(engine.validPositions.length, boardShape === "hexagon" ? 3 * r * (r + 1) + 1 : size * (size + 1) / 2);
    const hexSeats = count === 2 ? [0, 3] : count === 3 ? [0, 2, 4] : count === 4 ? [0, 1, 3, 4] : [0, 1, 2, 3, 4, 5];
    const triangleSeats = count === 2 ? [[0, 0], [r, 0]] : [[0, 0], [0, r], [r, 0], [0, m], [m, r - m], [r - m, 0]];
    const expected = boardShape === "hexagon" ? hexSeats.map((i) => getBoardVertices(size, count, boardShape)[i]) : triangleSeats;
    assert.deepEqual(Object.values(engine.initialPositions), expected.slice(0, count));
    assert.equal(new Set(Object.values(engine.initialPositions).map(String)).size, count);
    for (const point of engine.validPositions) assert.equal(engine.validPositions[engine._pointToIndex(point)].join(), point.join());
    for (const player of engine.activePlayers) {
      assert.ok(engine.isValidPosition(engine.initialPositions[player]));
      for (const point of engine.getAdjacentPositions(engine.initialPositions[player])) {
        const opponent = engine.activePlayers.find((other) => other !== player);
        assert.equal(engine._isInProtectionZone(point, opponent), true, "the selected root keeps its adjacent protection");
      }
    }
    assert.equal(normalizeGameSettings(settings).boardShape, boardShape);
    const snapshot = engine.getSnapshot();
    const renderer = Object.assign(Object.create(Renderer.prototype), {
      _lastMeasuredWidth: 640, _lastMeasuredHeight: 640, topInset: 0, paddingRatio: .05,
    });
    const layout = renderer._computeLayout(snapshot);
    assert.equal(layout.boardShape, boardShape);
    assert.deepEqual(renderer._collectBoardData(snapshot).validPoints, engine.getValidPositions());
    for (const point of engine.validPositions) {
      const [x, y] = renderer._gridToPixel(...point, layout);
      assert.ok(x >= 0 && x <= 640 && y >= 0 && y <= 640);
    }
    openings++;
    if (![5, 6, 9, 15].includes(size)) continue;
    for (const mode of ["random", "custom"]) {
      const initialPositions = randomInitialPositions(size, count, () => .43, boardShape);
      const customSettings = { ...settings, startingPointMode: mode, initialPositions };
      const match = { players: normalizeLocalPlayers({ BLACK: { choice: "minimax" } }, count, boardShape), started: true, paused: true };
      const session = createLocalGameSession(customSettings, [], match);
      assert.equal(persistLocalGameSession(session, storage), true);
      assert.equal(sessionMatchesSettings(loadLocalGameSession(storage), customSettings), true);
      assert.equal(sessionMatchesSettings(session, { ...customSettings, boardShape: shapes.find((s) => s !== boardShape) }), false);
      const controller = controllerFor(settings);
      assert.equal(controller.restoreMatchState(session).success, true);
      assert.equal(controller.engine.boardShape, boardShape);
      assert.deepEqual(controller.engine.initialPositions, initialPositions);
      assert.equal(localPlayerProfile(match.players.BLACK, count, size, boardShape)?.strategy,
        usesGenericBoardAI(count, boardShape) ? "greedy" : count === 2 ? "minimax" : count === 3 ? "three-player" : undefined);
      savedStarts++;
    }
  }
  for (const reverse of [false, true]) {
    const hex = boardShape === "hexagon";
    const near = hex ? [6, 6] : [1, 1], far = hex ? [10, 6] : [5, 1], cut = hex ? [8, 6] : [3, 1];
    const initialPositions = { ...resolveInitialPositions(9, count, null, boardShape), BLACK: reverse ? far : near, WHITE: hex ? [5, 9] : [0, 4] };
    if (!hex && count >= 4) initialPositions.GREEN = [0, 8];
    if (!hex && count === 6) initialPositions.CYAN = [0, 6];
    const settings = { gridSize: 9, playerCount: count, boardShape, startPlayer: "BLACK", rulesVersion: "territory-v2", startingPointMode: "custom", initialPositions };
    const engine = new GameEngine(settings);
    const actions = [{ type: "player_move", point: reverse ? near : far }, { type: "player_move", point: cut }];
    for (const action of actions) {
      const result = engine.playMove(action.point);
      assert.equal(result.success, true, JSON.stringify({ boardShape, count, reverse, action, reason: result.reason }));
    }
    assert.deepEqual(engine._getPlayerNodes("BLACK"), [initialPositions.BLACK]);
    assert.equal(engine.edges.BLACK.size, 0);
    const controller = controllerFor(settings);
    assert.equal(controller.restoreMatchState({ settings, actions }).success, true);
    assert.deepEqual(serializeRuleState(controller.engine), serializeRuleState(engine));
    const replay = await createReplayDocument(settings, actions);
    assert.equal((await validateReplayDocument(replay)).success, true);
    const changed = structuredClone(replay);
    changed.config.boardShape = hex ? "triangle" : "hexagon";
    assert.equal((await validateReplayDocument(changed)).success, false, "shape is part of replay commitments");
    cuts++;
  }
}
assert.throws(() => new GameEngine({ boardShape: "square" }));
assert.throws(() => createLocalGameSession({ playerCount: 2, gridSize: 5, startPlayer: "BLACK", rulesVersion: "territory-v2", boardShape: "square" }));
// The same closed region must have the same discrete score at all three edge
// seats, including reflected boards. This fixture encloses exactly 6 nodes.
const edgeSettings = { gridSize: 9, playerCount: 6, boardShape: "triangle", rulesVersion: "territory-v2" };
const enclosed = new GameEngine(edgeSettings);
for (const [from, to] of [[[0, 4], [2, 4]], [[2, 4], [2, 2]], [[2, 2], [0, 4]]]) {
  for (const point of enclosed.getLinePoints(from, to)) enclosed._setState(point, enclosed._getPlayerStates("GREEN").line);
  enclosed._setState(from, enclosed._getPlayerStates("GREEN").node);
  enclosed._setState(to, enclosed._getPlayerStates("GREEN").node);
  enclosed.edges.GREEN.add(enclosed._edgeKey(from, to));
}
assert.equal(enclosed._computeTerritory("GREEN").area, 6);
let edgeSymmetries = 0;
for (const permutation of [[0, 1, 2], [1, 0, 2], [0, 2, 1], [2, 1, 0], [1, 2, 0], [2, 0, 1]]) {
  const transform = ([x, y]) => permutation.slice(0, 2).map((i) => [x, y, 8 - x - y][i]);
  const mapped = new GameEngine(edgeSettings);
  const activePlayers = PLAYER_ORDER.slice(0, edgeSettings.playerCount);
  const playerMap = Object.fromEntries(activePlayers.map((player) => [player,
    activePlayers.find((other) => mapped.initialPositions[other].join() === transform(enclosed.initialPositions[player]).join()),
  ]));
  for (const [key, state] of enclosed.grid) {
    if (!state) continue;
    const owner = PLAYER_ORDER.find((player) => Object.values(enclosed._getPlayerStates(player)).includes(state));
    const kind = state === enclosed._getPlayerStates(owner).node ? "node" : "line";
    mapped._setState(transform(key.split(",").map(Number)), mapped._getPlayerStates(playerMap[owner])[kind]);
  }
  for (const edge of enclosed.edges.GREEN) {
    const [from, to] = edge.split("|").map((key) => transform(key.split(",").map(Number)));
    mapped.edges[playerMap.GREEN].add(mapped._edgeKey(from, to));
  }
  assert.equal(mapped._computeTerritory(playerMap.GREEN).area, 6);
  edgeSymmetries++;
}
for (const count of [2, 3, 4, 5, 6]) {
  assert.equal(new GameEngine({ playerCount: count }).boardShape, resolveBoardShape(count), "old saves keep their geometry");
}
const originalSelf = globalThis.self;
let response;
globalThis.self = { postMessage: (message) => { response = message; } };
try {
  await import("../AIWorker.js"); const aiHandler = self.onmessage;
  await import("../TerritoryWorker.js"); const territoryHandler = self.onmessage;
  for (const boardShape of shapes) for (let count = 2; count <= 6; count++) {
    const settings = { gridSize: 5, playerCount: count, boardShape, startPlayer: "BLACK", rulesVersion: "territory-v2" };
    const engine = new GameEngine(settings);
    for (let move = 0; move < 6 && !engine.gameOver; move++) {
      const before = serializeRuleState(engine);
      await aiHandler({ data: { type: "COMPUTE", requestId: `shape-${count}-${boardShape}-${move}`, strategy: "greedy", topN: 1,
        serializedState: serializeEngineState(engine), aiPlayer: engine.currentPlayer } });
      assert.equal(response.type, "RESULT", response.message);
      assert.deepEqual(serializeRuleState(engine), before);
      if (response.moves[0]?.point) assert.equal(engine.playMove(response.moves[0].point).success, true);
      else assert.equal(engine.skipTurn().success, true);
    }
    territoryHandler({ data: { type: "COMPUTE_TERRITORIES", requestId: `score-${count}-${boardShape}`,
      serializedState: serializeEngineState(engine), territoryStateRevision: engine.getTerritoryStateRevision(), gameOver: engine.gameOver } });
    assert.equal(response.type, "RESULT", response.message);
    engine._updateTerritories();
    assert.deepEqual(response.territories, engine.cachedTerritories);
    if (usesGenericBoardAI(count, boardShape)) assert.equal(await new TrainingContribution({ storage }).enqueue(settings, [], {}), false);
    workers++;
  }
} finally { if (originalSelf === undefined) delete globalThis.self; else globalThis.self = originalSelf; }
console.log(JSON.stringify({ status: "PASS", openings, savedStarts, cuts, workers, edgeSymmetries, coverage: ["2–6 × both shapes × sizes 5–15", "exact vertices and edge midpoints", "render geometry", "root protection", "random/custom saves", "cut cleanup", "batch replay and tamper rejection", "AI and territory Workers", "edge-seat scoring symmetry", "legacy shapes"] }));
