import assert from "node:assert/strict";

import {
  GameEngine,
  Player,
  TerritoryRulesVersion,
  getBoardPositions,
  getBoardVertices,
  isBoardPoint,
  resolveInitialPositions,
} from "../GameEngine.js";
import { GreedyAI, MinimaxAI } from "../AIEngine.js";
import { serializeEngineState } from "../AIStateProtocol.js";
import GameController from "../GameController.js";
import {
  localPlayerChoices,
  localPlayerProfile,
  normalizeLocalPlayers,
} from "../LocalAIModes.js";
import { createLocalGameSession, sessionMatchesSettings } from "../LocalGameSession.js";
import { loadMultiplayerRuntime } from "../MultiplayerRuntime.js";
import { localAIWorkerRoute } from "../LocalAIWorkerFactory.js";
import { normalizeRoomPlayerSetup, roomPlayerProfile } from "../OnlineRoomSettings.js";
import { GRID_SIZE_OPTIONS, normalizeGameSettings } from "../OnlineAppState.js";
import Renderer from "../Renderer.js";
import { createReplayDocument, validateReplayDocument } from "../ReplayCodec.js";
import {
  randomInitialPositions,
  requiresExplicitStartingPoints,
  startingPointSettings,
} from "../StartingPoints.js";

const pointKey = point => point.join(",");

for (const gridSize of [5, 9, 15]) {
  const r = gridSize - 1;
  const points = getBoardPositions(gridSize, 2, "diamond");
  assert.equal(points.length, gridSize ** 2, `diamond ${gridSize} must contain N² points`);
  assert.equal(new Set(points.map(pointKey)).size, points.length);
  assert.deepEqual(getBoardVertices(gridSize, 2, "diamond"), [[0, 0], [r, 0], [r, r], [0, r]]);
  assert.equal(isBoardPoint([r, r], gridSize, 2, "diamond"), true);
  assert.equal(isBoardPoint([r + 1, r], gridSize, 2, "diamond"), false);
  assert.equal(isBoardPoint([r, r + 1], gridSize, 2, "diamond"), false);

  const engine = new GameEngine({
    gridSize,
    playerCount: 2,
    boardShape: "diamond",
    rulesVersion: TerritoryRulesVersion.V3,
  });
  assert.deepEqual(engine.initialPositions, { BLACK: [0, 0], WHITE: [r, r] });
  assert.deepEqual(points.map(point => engine._pointToIndex(point)), points.map((_, index) => index));
  assert.equal(engine.getBoardMatrix().length, gridSize);
  assert.equal(engine.getBoardMatrix().every(row => row.length === gridSize && row.every(value => value !== null)), true);
  const snapshot = engine.getSnapshot();
  assert.equal(snapshot.boardShape, "diamond");
  assert.deepEqual(snapshot.boardVertices, [[0, 0], [r, 0], [r, r], [0, r]]);
  assert.equal(snapshot.territories.BLACK.area, 1);
  assert.equal(snapshot.territories.WHITE.area, 1);

  // Renderer geometry and input hit testing must use the same N x N lattice
  // as the rules.  The projected opposite vertices are the two 60-degree
  // tips of the rhombus, and every point remains inside the responsive canvas.
  const renderer = Object.assign(Object.create(Renderer.prototype), {
    minCssWidth: 220,
    minCssHeight: 180,
    paddingRatio: 0.025,
    topInset: 0,
    _lastMeasuredWidth: 720,
    _lastMeasuredHeight: 540,
    _renderCaches: new Map(),
  });
  renderer.layout = renderer._computeLayout(snapshot);
  const pixels = points.map(point => renderer.getPointPixelCoordinates(point));
  assert.equal(pixels.every(({ x, y }) => x > 0 && x < 720 && y > 0 && y < 540), true);
  const controller = Object.assign(Object.create(GameController.prototype), {
    renderer,
    engine,
    _validGridPoints: points,
  });
  const target = renderer.getPointPixelCoordinates([Math.min(1, r), 0]);
  assert.deepEqual(controller._findNearestGridPoint(target.x, target.y), [Math.min(1, r), 0]);
}

assert.deepEqual(GRID_SIZE_OPTIONS, [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
for (const gridSize of GRID_SIZE_OPTIONS) {
  assert.equal(normalizeGameSettings({ playerCount: 2, boardShape: "diamond", gridSize }).gridSize, gridSize);
}

assert.equal(requiresExplicitStartingPoints(2, "diamond"), false);
assert.equal(requiresExplicitStartingPoints(3, "diamond"), true);
assert.equal(requiresExplicitStartingPoints(6, "diamond"), true);
assert.throws(
  () => new GameEngine({ gridSize: 5, playerCount: 3, boardShape: "diamond" }),
  /random or custom starting points/,
);
assert.throws(
  () => startingPointSettings({ gridSize: 5, playerCount: 3, boardShape: "diamond" }),
  /random or custom starting points/,
);

const samples = [0, 0.2, 0.4, 0.6, 0.8, 0.99];
let sampleIndex = 0;
const randomStarts = randomInitialPositions(5, 6, () => samples[sampleIndex++ % samples.length], "diamond");
assert.equal(Object.keys(randomStarts).length, 6);
assert.equal(new Set(Object.values(randomStarts).map(pointKey)).size, 6);
for (const point of Object.values(randomStarts)) assert.equal(isBoardPoint(point, 5, 6, "diamond"), true);

const threeStarts = { BLACK: [0, 0], WHITE: [4, 4], PURPLE: [0, 4] };
const three = new GameEngine({
  gridSize: 5,
  playerCount: 3,
  boardShape: "diamond",
  initialPositions: threeStarts,
  rulesVersion: TerritoryRulesVersion.V3,
});
assert.deepEqual(resolveInitialPositions(5, 3, threeStarts, "diamond"), threeStarts);
assert.equal(serializeEngineState(three).boardShape, "diamond");
assert.deepEqual(serializeEngineState(three).initialPositions, threeStarts);
for (const player of three.activePlayers) {
  const territory = three._computeTerritory(player);
  assert.equal(Number.isFinite(territory.area), true);
  assert.equal(territory.area, 1);
}

// The ordinary menu routes diamond multiplayer seats only to topology-safe
// generic tiers. Easy is the untrained rule Greedy baseline and Hard is the
// generic multiplayer search; triangle/hexagon-trained weights stay out.
const easyProfile = localPlayerProfile({ choice: "ai-easy" }, 3, 5, "diamond");
const hardProfile = localPlayerProfile({ choice: "ai-hard" }, 3, 5, "diamond");
assert.deepEqual(easyProfile, { strategy: "greedy" });
assert.deepEqual(hardProfile, { strategy: "multiplayer", modelId: "multiplayer-hard-v1" });
await assert.rejects(() => loadMultiplayerRuntime("multiplayer-easy-v1", three), /native multiplayer board shape/);
const easy = new GreedyAI();
const easyMoves = easy.getTopMoves(three, three.currentPlayer, 3);
assert.equal(easyMoves.length > 0, true);
const hard = await loadMultiplayerRuntime("multiplayer-hard-v1", three);
assert.equal(hard.modelInfo.runtime_policy, "generic-multiplayer-minimax");
assert.equal(hard.modelInfo.trained_model, false);
assert.equal(hard.modelInfo.evidenceTier, "rule-search");
const hardMoves = hard.ai.getTopMoves(three, three.currentPlayer, 1);
const legalKeys = new Set(three.getLegalMoves(three.currentPlayer).map(move => pointKey(move.point)));
for (const move of [...easyMoves, ...hardMoves]) {
  assert.equal(move.point === null || legalKeys.has(pointKey(move.point)), true);
}

const legacyDiamondRoom = normalizeRoomPlayerSetup({
  playerCount: 2,
  boardShape: "diamond",
  gridSize: 5,
  rulesVersion: TerritoryRulesVersion.V3,
  botCount: 1,
});
assert.equal(legacyDiamondRoom.WHITE.choice, "minimax");
assert.deepEqual(roomPlayerProfile(legacyDiamondRoom.WHITE, {
  playerCount: 2, boardShape: "diamond", gridSize: 5,
}), { strategy: "minimax", depth: 3 });

const normalizedThree = normalizeGameSettings({
  gridSize: 5,
  playerCount: 3,
  boardShape: "diamond",
  rulesVersion: TerritoryRulesVersion.V3,
});
assert.equal(normalizedThree.startingPointMode, "random");
assert.equal(Object.keys(normalizedThree.initialPositions).length, 3);
assert.deepEqual(startingPointSettings(normalizedThree), {
  startingPointMode: "random",
  initialPositions: normalizedThree.initialPositions,
});

assert.deepEqual(localPlayerChoices(2, "diamond"), ["human", "minimax"]);
assert.deepEqual(localPlayerChoices(3, "diamond"), ["human", "ai-easy", "ai-hard"]);
const normalizedDuelPlayers = normalizeLocalPlayers({ WHITE: { choice: "greedy", depth: 4 } }, 2, "diamond");
assert.equal(normalizedDuelPlayers.WHITE.choice, "minimax");
assert.deepEqual(localPlayerProfile(normalizedDuelPlayers.WHITE, 2, 5, "diamond"), { strategy: "minimax", depth: 4 });

const duel = new GameEngine({
  gridSize: 5,
  playerCount: 2,
  boardShape: "diamond",
  rulesVersion: TerritoryRulesVersion.V3,
});
const ranked = new MinimaxAI(2).getTopMoves(duel, Player.BLACK, 3);
assert.equal(ranked.length > 0, true);
assert.equal(ranked.every(move => move.point === null || duel.getLegalMoves(Player.BLACK).some(candidate => pointKey(candidate.point) === pointKey(move.point))), true);

// Diamond AI must stay on the ordinary shape-aware Worker.  The optimized
// native-hard bundle intentionally embeds only the admitted triangle/hexagon
// runtimes and must never receive a diamond state.
assert.equal(localAIWorkerRoute({
  playerCount: 3,
  gridSize: 5,
  boardShape: "diamond",
  rulesVersion: TerritoryRulesVersion.V3,
}, [{ strategy: "multiplayer", modelId: "multiplayer-hard-v1" }]).kind, "ordinary");
assert.equal(localAIWorkerRoute({
  playerCount: 3,
  gridSize: 5,
  boardShape: "diamond",
  rulesVersion: TerritoryRulesVersion.V3,
}, [{ strategy: "greedy" }]).kind, "ordinary");

// Exercise the real Worker entry, including state reconstruction, instead of
// only calling Minimax in the main module.
const previousSelf = globalThis.self;
const workerMessages = [];
globalThis.self = {
  postMessage(message) { workerMessages.push(message); },
};
try {
  await import(`../AIWorker.js?diamond-board-test=${Date.now()}`);
  await globalThis.self.onmessage({ data: {
    type: "COMPUTE",
    requestId: "diamond-minimax-worker",
    serializedState: serializeEngineState(duel),
    aiPlayer: Player.BLACK,
    strategy: "minimax",
    depth: 2,
    topN: 1,
  } });
  await globalThis.self.onmessage({ data: {
    type: "COMPUTE",
    requestId: "diamond-multiplayer-greedy-worker",
    serializedState: serializeEngineState(three),
    aiPlayer: three.currentPlayer,
    strategy: "greedy",
    topN: 1,
  } });
  await globalThis.self.onmessage({ data: {
    type: "COMPUTE",
    requestId: "diamond-trained-easy-rejected",
    serializedState: serializeEngineState(three),
    aiPlayer: three.currentPlayer,
    strategy: "multiplayer",
    modelId: "multiplayer-easy-v1",
    topN: 1,
  } });
} finally {
  if (previousSelf === undefined) delete globalThis.self;
  else globalThis.self = previousSelf;
}
const workerResult = workerMessages.find(message => message.type === "RESULT");
assert.equal(workerResult?.requestId, "diamond-minimax-worker");
assert.equal(workerResult.moves.length, 1);
assert.equal(workerResult.moves[0].point === null
  || duel.getLegalMoves(Player.BLACK).some(candidate => pointKey(candidate.point) === pointKey(workerResult.moves[0].point)), true);
const greedyWorkerResult = workerMessages.find(message => message.requestId === "diamond-multiplayer-greedy-worker");
assert.equal(greedyWorkerResult?.type, "RESULT");
assert.deepEqual(greedyWorkerResult.modelInfo, {
  strategy: "greedy", runtime_policy: "generic-rule-greedy", trained_model: false,
});
assert.equal(greedyWorkerResult.moves[0].point === null
  || three.getLegalMoves(three.currentPlayer).some(candidate => pointKey(candidate.point) === pointKey(greedyWorkerResult.moves[0].point)), true);
const rejectedEasyWorker = workerMessages.find(message => message.requestId === "diamond-trained-easy-rejected");
assert.equal(rejectedEasyWorker?.type, "ERROR");
assert.match(rejectedEasyWorker.message, /native multiplayer board shape/);

const duelSettings = {
  gridSize: 5,
  playerCount: 2,
  boardShape: "diamond",
  startPlayer: "BLACK",
  rulesVersion: TerritoryRulesVersion.V3,
  turnTimerEnabled: false,
  turnTimeLimitSeconds: 60,
  hintEnabled: true,
  hintMaxCount: 3,
};
const session = createLocalGameSession(duelSettings, [{ type: "skip" }], {
  players: { BLACK: { choice: "human" }, WHITE: { choice: "minimax", depth: 3 } },
  started: true,
  paused: false,
});
assert.equal(session.settings.boardShape, "diamond");
assert.equal(sessionMatchesSettings(session, duelSettings), true);

const duelReplay = await createReplayDocument(duelSettings, [{ type: "skip" }, { type: "skip" }]);
assert.equal(duelReplay.config.boardShape, "diamond");
assert.deepEqual(duelReplay.config.initialPositions, undefined);
assert.equal((await validateReplayDocument(duelReplay)).success, true);

const threeReplaySettings = {
  ...duelSettings,
  playerCount: 3,
  boardShape: "diamond",
  startingPointMode: "custom",
  initialPositions: threeStarts,
};
const threeReplay = await createReplayDocument(threeReplaySettings, [
  { type: "skip" }, { type: "skip" }, { type: "skip" },
]);
assert.equal(threeReplay.config.boardShape, "diamond");
assert.deepEqual(threeReplay.config.initialPositions, threeStarts);
assert.equal((await validateReplayDocument(threeReplay)).success, true);

const tampered = structuredClone(threeReplay);
tampered.config.initialPositions.WHITE = [5, 5];
assert.equal((await validateReplayDocument(tampered)).success, false);

console.log(JSON.stringify({
  status: "PASS",
  shape: "diamond",
  geometry: [5, 9, 15],
  defaultDuelVertices: [[0, 0], ["N-1", "N-1"]],
  multiplayerStarts: "random-or-custom",
  ai: "duel-minimax-2-4-plus-untrained-greedy-and-generic-multiplayer-minimax",
  persistence: ["worker", "session", "replay"],
}));
