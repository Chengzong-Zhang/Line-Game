import assert from "node:assert/strict";
import { NetworkManager } from "../NetworkManager.js?v=20261025-room1";
import CrossPlatformNetwork from "../CrossPlatformNetwork.js?v=20261025-room1";
import { sharedRoomPayload } from "../SharedRoomClient.js?v=20261025-room1";
import { normalizeGameSettings } from "../OnlineAppState.js?v=20261025-room1";

const noop = () => {};
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };
globalThis.location = new URL("http://localhost:8876/");
globalThis.document = { body: { classList: { toggle: noop, remove: noop } } };
globalThis.addEventListener = noop;
globalThis.removeEventListener = noop;
globalThis.fetch = async () => { throw new Error("Network upload is outside this check"); };
globalThis.Vue = {
  ref: value => ({ value }), shallowRef: value => ({ value }),
  computed: read => ({ get value() { return read(); } }),
  watch: noop, nextTick: async () => {}, onMounted: noop, onBeforeUnmount: noop,
};

const calls = { created: [], shared: [], updated: [], undo: [] };
NetworkManager.prototype.isConnected = () => true;
NetworkManager.prototype.createRoom = async function (settings) { calls.created.push(settings); return {}; };
NetworkManager.prototype.updateRoomSettings = async function (settings) { calls.updated.push(settings); return {}; };
NetworkManager.prototype.sendUndo = async function (accept) { calls.undo.push(accept); return {}; };
CrossPlatformNetwork.prototype.createSharedRoom = async function (settings) { calls.shared.push(settings); return {}; };
const { default: App } = await import("../OnlineApp.js?v=20261025-room1");
const app = App.setup();
app.tutorialActive.value = false;
app.auth.value = { username: "host", token: "test-token" };
app.selectedPlayerCount.value = 2;
app.selectedGridSize.value = 5;
app.selectedBoardShape.value = "hexagon";
const starts = { BLACK: [4, 0], WHITE: [0, 4] };
app.updateStartingPoints({ startingPointMode: "custom", initialPositions: starts });
await app.handleCreateRoom();
assert.equal(calls.shared.length, 1, `create failed: ${app.networkError?.value}`);
assert.deepEqual(calls.shared[0].initialPositions, starts);
assert.equal(calls.shared[0].boardShape, "hexagon");

app.roomStatus.value = "lobby";
app.session.value = { ...app.session.value, shared: false, roomId: "1234", playerId: "host" };
app.roomInfo.value = { ...app.roomInfo.value, hostPlayerId: "host", settings: normalizeGameSettings(calls.shared[0]), matchPhase: "LOBBY" };
app.updateStartingPoints({ startingPointMode: "random", initialPositions: { BLACK: [8, 4], WHITE: [4, 8] } });
assert.equal(calls.updated.length, 1);
assert.equal(calls.updated[0].startingPointMode, "random");
assert.deepEqual(calls.updated[0].initialPositions, { BLACK: [8, 4], WHITE: [4, 8] });

app.roomStatus.value = "solo";
app.session.value = { ...app.session.value, roomId: null };
app.selectedLocalPlayers.value = { BLACK: { choice: "human" }, WHITE: { choice: "greedy" } };
await app.handleCreateSharedRoom();
assert.equal(calls.shared.length, 2);
assert.equal(calls.shared[1].botCount, 1);
assert.equal(calls.shared[1].startingPointMode, "random");
assert.deepEqual(calls.shared[1].initialPositions, { BLACK: [8, 4], WHITE: [4, 8] });
assert.equal(normalizeGameSettings({ playerCount: 2, botCount: 1 }).botCount, 1);
const botPayload = sharedRoomPayload({
  code: "ABCDEFGH", player: "BLACK", status: "playing", revision: 2,
  settings: calls.shared[1], bots: ["WHITE"],
  members: { BLACK: true, WHITE: true }, ready: { BLACK: true, WHITE: true },
  undo: { usedCount: 0, pending: false, votes: [] }, actions: [],
  playerProfiles: { BLACK: { displayName: "Host" }, WHITE: { displayName: "AI" } },
});
assert.equal(botPayload.players[1].isBot, true);
assert.equal(botPayload.players[1].username, "AI");
assert.equal(botPayload.undo.requiredVotes, 1);
app.roomStatus.value = "lobby";
app.session.value = { ...app.session.value, shared: true, roomId: "ABCDEFGH", playerId: "ABCDEFGH:BLACK" };
app.roomInfo.value = { ...app.roomInfo.value, hostPlayerId: "ABCDEFGH:BLACK", matchPhase: "LOBBY",
  players: botPayload.players.map(player => ({ ...player, ready: player.isBot })), settings: botPayload.settings };
assert.equal(app.starterLocked.value, false, "an AI seat must not lock host settings");

app.roomStatus.value = "inProgress";
app.session.value = { ...app.session.value, shared: false, roomId: "1234", playerId: "host" };
app.roomInfo.value = { ...app.roomInfo.value, settings: { ...app.roomInfo.value.settings, undoEnabled: true, undoMaxCount: 2 },
  undo: { usedCount: 0, pending: false, votes: [], requiredVotes: 2 } };
app.gameState.value = { ...app.gameState.value, positionRevision: 0 };
assert.equal(app.undoDisabled.value, true);
app.gameState.value = { ...app.gameState.value, positionRevision: 1 };
assert.equal(app.undoEnabled.value, true);
assert.equal(app.undoDisabled.value, false);
assert.equal(await app.requestUndo(), true);
assert.deepEqual(calls.undo, [true]);
app.roomInfo.value = { ...app.roomInfo.value, undo: { usedCount: 0, pending: true, votes: [], requiredVotes: 2 } };
await app.rejectUndo();
assert.deepEqual(calls.undo, [true, false]);
assert.match(App.components.SetupPanel.template, /onlineAvailable/);
assert.match(App.components.ControlPanel.template, /onlineUndoAgree/);
console.log("verify-online-start-undo: PASS (create, room update, online voting controls)");
