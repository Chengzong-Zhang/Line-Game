import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import CrossPlatformNetwork from "../CrossPlatformNetwork.js?v=20261025-room1";
import GameEngine from "../GameEngine.js?v=20261025-room1";
import { canonicalize, serializeRuleState } from "../ReplayCodec.js?v=20261025-room1";
import { verifySharedRoom, sharedRoomPayload } from "../SharedRoomClient.js?v=20261025-room1";
import { roomSettingsFromBoard, roomBotColors } from "../OnlineRoomSettings.js?v=20261025-room1";

const noop = () => {};
globalThis.crypto ??= webcrypto;
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };
globalThis.location = new URL("http://localhost:8876/");
globalThis.addEventListener = globalThis.removeEventListener = noop;
globalThis.fetch = async () => ({ ok: false });
const disposers = [];
globalThis.Vue = process.env.LIFELINE_VUE_RUNTIME
  ? { ...new Function(`${await readFile(process.env.LIFELINE_VUE_RUNTIME, "utf8")}; return Vue;`)(),
    onMounted: noop, onBeforeUnmount: callback => disposers.push(callback) }
  : {
  ref: value => ({ value }), shallowRef: value => ({ value }),
  computed: read => ({ get value() { return read(); } }),
  watch: noop, nextTick: async () => {}, onMounted: noop, onBeforeUnmount: noop,
};
globalThis.document = { documentElement: { dataset: {} }, body: { classList: { toggle: noop, remove: noop } } };
const calls = { create: [], save: [] };
CrossPlatformNetwork.prototype.createSharedRoom = async settings => { calls.create.push(settings); };
CrossPlatformNetwork.prototype.updateRoomSettings = async settings => { calls.save.push(settings); };
const { default: App } = await import("../OnlineApp.js?v=20261025-room1");
const app = App.setup();
app.tutorialActive.value = false;
app.auth.value = { username: "host", token: "fixture-token" };
app.selectedPlayerCount.value = 6;
app.selectedBoardShape.value = "hexagon";
app.selectedGridSize.value = 7;
app.selectedLocalPlayers.value = {
  BLACK: { choice: "ai-medium" }, WHITE: { choice: "human" },
  PURPLE: { choice: "ai-easy" }, GREEN: { choice: "human" },
  ORANGE: { choice: "ai-hard" }, CYAN: { choice: "human" },
};
app.selectedUndoEnabled.value = true;
app.selectedUndoMaxCount.value = 4;
app.selectedTurnTimerEnabled.value = true;
app.selectedTurnTimeLimitSeconds.value = 90;
app.openRoomSetup();
assert.equal(app.activeUtilityDeck.value, "board");
assert.equal(app.roomSetupOpen.value, true);
await app.saveRoomSettings();
await Vue.nextTick();
assert.equal(calls.create.length, 1);
const settings = calls.create[0];
assert.equal(settings.playerCount, 6);
assert.equal(settings.boardShape, "hexagon");
assert.equal(settings.gridSize, 7);
assert.equal(settings.undoMaxCount, 4);
assert.equal(settings.turnTimeLimitSeconds, 90);
assert.deepEqual(roomBotColors(settings), ["BLACK", "PURPLE", "ORANGE"]);
assert.equal(settings.playerSetup.WHITE.choice, "human");

const engine = new GameEngine(settings);
const snapshot = engine.getSnapshot();
const rawHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalize(serializeRuleState(engine))));
const room = {
  protocol: 1, code: "ABCDEFGH", matchId: "a".repeat(32), revision: 2, seq: 0,
  status: "waiting", player: "WHITE", hostPlayer: "WHITE", settings,
  currentPlayer: snapshot.currentPlayer, gameOver: snapshot.gameOver, winner: snapshot.winner,
  scores: Object.fromEntries(engine.activePlayers.map(color => [color, snapshot.territories[color].area])),
  stateHash: `sha256:${Buffer.from(rawHash).toString("hex")}`, actions: [], actionIds: [],
  bots: ["BLACK", "PURPLE", "ORANGE"],
  members: { BLACK: true, WHITE: true, PURPLE: true, GREEN: false, ORANGE: true, CYAN: false },
  ready: { BLACK: true, WHITE: false, PURPLE: true, GREEN: false, ORANGE: true, CYAN: false },
  rematchVotes: {}, undo: { usedCount: 0, pending: false, votes: [] },
};
await verifySharedRoom(room);
const payload = sharedRoomPayload(room);
assert.equal(payload.hostPlayerId, "ABCDEFGH:WHITE");
assert.equal(payload.players.length, 6);
assert.deepEqual(payload.players.filter(p => p.empty).map(p => p.color), ["GREEN", "CYAN"]);
assert.equal(payload.undo.requiredVotes, 1);

app.session.value = { ...app.session.value, shared: true, roomId: room.code, color: "WHITE", playerId: "ABCDEFGH:WHITE" };
app.roomInfo.value = { ...payload, players: payload.players.map(p => ({ ...p, ready: true })), matchPhase: "PLAYING" };
app.roomStatus.value = "inProgress";
const before = JSON.parse(JSON.stringify(app.roomInfo.value.settings));
const liveGame = app.gameState.value;
app.openRoomSetup();
assert.equal(app.settingsLocked.value, false, "a ready/playing host may edit next-game settings");
app.selectedGridSize.value = 9;
app.updateLocalPlayer({ color: "PURPLE", patch: { choice: "ai-hard" } });
await app.saveRoomSettings();
assert.equal(calls.save.length, 1);
assert.equal(calls.save[0].gridSize, 9);
assert.equal(calls.save[0].playerSetup.PURPLE.choice, "ai-hard");
assert.deepEqual(app.roomInfo.value.settings, before, "saving next-game settings must preserve active settings");
assert.equal(app.gameState.value, liveGame, "opening/saving room settings must preserve the live game");
app.roomInfo.value.pendingSettings = roomSettingsFromBoard({ ...settings, gridSize: 11 }, settings.playerSetup);
app.openRoomSetup();
await Vue.nextTick();
assert.equal(app.selectedGridSize.value, 11, "reopening edits the saved next-game draft");
const changedShape = roomSettingsFromBoard({ ...settings, playerCount: 3, gridSize: 7, boardShape: "triangle",
  startingPointMode: "custom", initialPositions: { BLACK: [1, 0], WHITE: [6, 0], PURPLE: [0, 6] } },
{ BLACK: { choice: "three-player", version: "three-player-policy-v2" }, WHITE: { choice: "human" }, PURPLE: { choice: "ai-easy" } });
app.roomInfo.value.pendingSettings = changedShape;
app.openRoomSetup();
await Vue.nextTick();
assert.deepEqual(app.selectedStartingPoints.value.initialPositions, changedShape.initialPositions,
  "queued watchers must not overwrite authoritative custom starts when the shape changes");
assert.equal(app.selectedLocalPlayers.value.BLACK.version, "three-player-policy-v2");
app.session.value.playerId = "ABCDEFGH:GREEN";
assert.equal(app.settingsLocked.value, true, "only the host edits room settings");

assert.doesNotMatch(App.components.RoomPanel.template, /create-shared-room|room-bot-count/);
assert.match(App.components.SetupPanel.template, /aiAvailable \|\| onlineAvailable/);
assert.match(App.template, /@create-room="openRoomSetup"/);
await Vue.nextTick();
for (const dispose of disposers) dispose();
console.log(`verify-unified-room-ui: PASS (${process.env.LIFELINE_VUE_RUNTIME ? "real Vue watchers" : "mock Vue"}; six seats, one setup, pending edits preserve live match and custom starts)`);
