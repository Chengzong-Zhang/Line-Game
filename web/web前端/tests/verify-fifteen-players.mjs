import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { GameEngine, PLAYER_ORDER, PointState } from "../GameEngine.js?v=20261025-room1";
import { randomInitialPositions, startingPointSettings } from "../StartingPoints.js?v=20261025-room1";
import { normalizeGameSettings, PLAYER_COUNT_OPTIONS } from "../OnlineAppState.js?v=20261025-room1";
import { localPlayerChoices, localPlayerProfile, normalizeLocalPlayers, localMatchActors } from "../LocalAIModes.js?v=20261025-room1";
import { createLocalGameSession, loadLocalGameSession } from "../LocalGameSession.js?v=20261025-room1";
import { normalizeUndoUsage } from "../LocalUndo.js?v=20261025-room1";
import { canonicalize, createReplayDocument, validateReplayDocument, serializeRuleState } from "../ReplayCodec.js?v=20261025-room1";
import { verifySharedRoom, sharedRoomPayload } from "../SharedRoomClient.js?v=20261025-room1";
import { roomSettingsFromBoard, roomBotColors } from "../OnlineRoomSettings.js?v=20261025-room1";
import { processBotRequest } from "../../tools/online_bot_bridge.mjs";
import { serializeEngineState } from "../AIStateProtocol.js?v=20261025-room1";
import { loadMultiplayerRuntime } from "../MultiplayerRuntime.js?v=20261025-room1";
import { formatPlayerName } from "../OnlineAppI18n.js?v=20261025-room1";

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;
assert.deepEqual(PLAYER_COUNT_OPTIONS, Array.from({ length: 14 }, (_, index) => index + 2));
assert.equal(PLAYER_ORDER.length, 15);
assert.equal(PointState.CYAN_LINE, 12, "old saves retain the original state numbers");
assert.equal(PointState.CORAL_LINE, 30);
let cases = 0;
for (const playerCount of PLAYER_COUNT_OPTIONS) for (const boardShape of ["triangle", "hexagon"]) {
  const settings = normalizeGameSettings({ playerCount, gridSize: 7, boardShape, rulesVersion: "territory-v3" });
  if (playerCount > 6) {
    assert.equal(settings.startingPointMode, "random");
    assert.throws(() => startingPointSettings({ ...settings, startingPointMode: "default" }), /7-15/);
    assert.throws(() => new GameEngine({ playerCount, gridSize: 7, boardShape }), /7-15/);
    assert.deepEqual(localPlayerChoices(playerCount, boardShape), ["human", "ai-easy", "ai-hard"]);
  }
  const engine = new GameEngine(settings);
  assert.equal(engine.activePlayers.length, playerCount);
  const snapshot = engine.getSnapshot();
  for (const player of engine.activePlayers) {
    assert.equal(engine._getState(engine.initialPositions[player]), PointState[`${player}_NODE`]);
    assert.equal(snapshot.territories[player].area, 1);
    assert.ok(formatPlayerName(player, "zh"));
  }
  const players = normalizeLocalPlayers({}, playerCount, boardShape);
  const saved = createLocalGameSession(settings, [], { players, started: true, paused: false,
    undo: { usedCount: 1, blockedPlayers: [engine.activePlayers.at(-1)] } });
  const restored = loadLocalGameSession({ getItem: () => JSON.stringify(saved) });
  assert.deepEqual(restored.settings, saved.settings);
  assert.deepEqual(restored.match.undo.blockedPlayers, [engine.activePlayers.at(-1)]);
  assert.deepEqual(normalizeUndoUsage(saved.match.undo), saved.match.undo);
  const actions = [];
  while (!engine.gameOver) {
    actions.push({ type: "skip", player: engine.currentPlayer });
    assert.equal(engine.skipTurn().success, true);
    assert.ok(actions.length <= playerCount);
  }
  const replay = await createReplayDocument(settings, actions, { actors: localMatchActors(players, playerCount, 7, boardShape) });
  assert.equal((await validateReplayDocument(replay)).success, true);
  assert.equal(Object.keys(replay.terminal.scores).length, playerCount);
  cases++;
}

// The smallest triangle fits exactly 15 starts; it must not duplicate a root.
const smallest = randomInitialPositions(5, 15, () => 0, "triangle");
assert.equal(new Set(Object.values(smallest).map(point => point.join(","))).size, 15);
assert.equal(new GameEngine({ gridSize: 5, playerCount: 15, boardShape: "triangle", initialPositions: smallest }).activePlayers.length, 15);

const base = normalizeGameSettings({ playerCount: 15, gridSize: 7, startPlayer: "CORAL", rulesVersion: "territory-v3" });
const settings = roomSettingsFromBoard(base, { CORAL: { choice: "ai-hard" } });
assert.deepEqual(roomBotColors(settings), ["CORAL"]);
assert.equal(localPlayerProfile({ choice: "ai-easy" }, 15, 7, "hexagon").strategy, "greedy");
assert.equal(localPlayerProfile({ choice: "ai-medium" }, 15, 7, "hexagon").modelId, "multiplayer-hard-v1");
const engine = new GameEngine(settings), snapshot = engine.getSnapshot();
const room = {
  protocol: 1, code: "ABCDEFGH", matchId: "a".repeat(32), revision: 1, seq: 0, status: "waiting",
  player: "BLACK", hostPlayer: "BLACK", settings, currentPlayer: snapshot.currentPlayer,
  gameOver: snapshot.gameOver, winner: snapshot.winner,
  scores: Object.fromEntries(PLAYER_ORDER.map(player => [player, snapshot.territories[player].area])),
  stateHash: `sha256:${createHash("sha256").update(canonicalize(serializeRuleState(engine))).digest("hex")}`,
  actions: [], actionIds: [], bots: ["CORAL"], rematchVotes: {},
  members: Object.fromEntries(PLAYER_ORDER.map(player => [player, ["BLACK", "CORAL"].includes(player)])),
  ready: Object.fromEntries(PLAYER_ORDER.map(player => [player, player === "CORAL"])),
};
await verifySharedRoom(room);
assert.equal(sharedRoomPayload(room).players.length, 15);
const result = await processBotRequest({ settings, actions: [] });
assert.equal(result.success, true, result.reason);
assert.equal(result.fallback, false, result.fallbackReason);
assert.equal(result.action.color, "CORAL");
assert.equal(result.modelInfo.id, "multiplayer-hard-v1");
assert.equal(result.modelInfo.lineage, null, "7-15-player search must not claim six-player training lineage");
const unsupported = structuredClone(settings);
unsupported.playerSetup.CORAL.choice = "hex-player";
assert.equal((await processBotRequest({ settings: unsupported, actions: [] })).reason, "INVALID_CONFIGURATION");
await assert.rejects(() => loadMultiplayerRuntime("multiplayer-medium-v1", engine), /requires|Unsupported/);
await assert.rejects(() => loadMultiplayerRuntime("multiplayer-easy-v1", engine), /requires|Unsupported/);

// Exercise the actual generic Worker with the fifteenth player as actor.
const messages = [], originalSelf = globalThis.self;
globalThis.self = { postMessage: message => messages.push(message) };
try {
  await import("../AIWorker.js?v=20261025-room1");
  await self.onmessage({ data: { type: "COMPUTE", requestId: "fifteen-hard", strategy: "multiplayer", modelId: "multiplayer-hard-v1",
    aiPlayer: engine.currentPlayer, serializedState: serializeEngineState(engine), topN: 1 } });
  const response = messages.at(-1);
  assert.equal(response.type, "RESULT", response.message);
  assert.equal(response.currentPlayer, "CORAL");
  assert.equal(response.modelInfo.id, "multiplayer-hard-v1");
  const point = response.moves[0]?.point;
  assert.ok(point === null || engine.getLegalMoves().some(move => String(move.point) === String(point)));
} finally { globalThis.self = originalSelf; }
console.log(JSON.stringify({ status: "PASS_FIFTEEN_PLAYERS", boardConfigurationCases: cases,
  checks: ["15 distinct states/colors", "random/custom only", "restore", "undo", "terminal replay", "15-seat shared room", "generic hard bot", "actual AI Worker"] }));
