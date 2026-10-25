// Receives actual durable-service views from test_shared_room_seats.py on stdin.
// Exercises both production clients' validation and authoritative reconstruction;
// no browser, device, WebSocket or remote service is represented by this check.
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { verifySharedRoom, sharedRoomPayload } from "../SharedRoomClient.js";
import { canonicalize, serializeRuleState } from "../ReplayCodec.js";
import { sut, plain } from "../../../wechat/minigame/tests/helpers.mjs";

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;
let raw = "";
for await (const chunk of process.stdin) {
  raw += chunk;
  if (raw.length > 1024 * 1024) throw new Error("FIXTURE_TOO_LARGE");
}
const fixture = JSON.parse(raw), stages = fixture.stages;
assert.equal(fixture.source, "temporary-sqlite-real-rules-and-ai-bridge");
assert.ok(Array.isArray(stages) && stages.length >= 10);
const memory = new Map(), requests = [];
const scheduler = {
  cancel() {},
  async request(kind, payload, context) {
    requests.push({ kind, playerCount: payload.settings.playerCount, boardShape: payload.settings.boardShape });
    const response = await sut.handleWorkerMessage({ id: requests.length, kind, payload: plain(payload), context });
    if (!response.ok) throw new Error(response.error);
    return response.result;
  },
};
const native = new sut.OnlineClient({ storage: { get: key => memory.get(key), set: (key, value) => memory.set(key, value) } },
  { onlineEnabled: false, apiBase: "https://fixture.invalid" }, scheduler);
native.active = true;
let sawPending = false, sawSixBotMove = false, sawNewMatch = false, firstMatch;

for (const { name, room } of stages) {
  const web = await verifySharedRoom(room), payload = sharedRoomPayload(room);
  const colors = sut.playerIds(room.settings.playerCount);
  assert.deepEqual(payload.players.map(player => player.color), colors, name);
  assert.equal(payload.hostPlayerId, `${room.code}:WHITE`, name);
  assert.equal(payload.players.find(player => player.isHost)?.color, "WHITE", name);
  assert.deepEqual(payload.players.filter(player => player.isBot).map(player => player.color), room.bots, name);
  assert.equal(payload.undo.requiredVotes, colors.filter(color => room.members[color] && !room.bots.includes(color)).length, name);
  assert.deepEqual(payload.pendingSettings, room.pendingSettings, name);
  assert.deepEqual(payload.matchState.actions.map(action => action.color), room.actions.map(action => action.player), name);
  assert.equal(sut.validateRoom(plain(room)).code, room.code, name);
  assert.equal(await native.receive(plain(room)), true, `${name}: ${native.error || native.game.error}`);
  assert.equal(native.game.stateHash, room.stateHash, name);
  assert.equal(native.game.snapshot.currentPlayer, web.currentPlayer, name);
  assert.equal(native.game.snapshot.gameOver, web.gameOver, name);
  assert.deepEqual(native.game.actions, room.actions, name);
  for (const color of colors) assert.equal(native.game.snapshot.territories[color].area, room.scores[color], `${name}:${color}`);
  assert.equal(canonicalize(serializeRuleState(web)), canonicalize(sut.serializeRuleState(sut.restoreGame(room.settings, room.actions))), name);
  firstMatch ??= room.matchId;
  if (room.pendingSettings) {
    sawPending = true;
    assert.equal(room.settings.playerCount, 6, name);
    assert.equal(room.settings.boardShape, "hexagon", name);
    assert.equal(room.pendingSettings.playerCount, 4, name);
    assert.equal(room.pendingSettings.boardShape, "triangle", name);
    assert.deepEqual(native.game.settings.playerSetup, room.settings.playerSetup, name);
  }
  if (room.settings.playerCount === 6 && room.actions.some(action => action.type === "move" && room.bots.includes(action.player))) sawSixBotMove = true;
  if (room.matchId !== firstMatch) {
    sawNewMatch = true;
    assert.equal(room.settings.playerCount, 4, name);
    assert.equal(room.settings.boardShape, "triangle", name);
    assert.equal(room.pendingSettings, null, name);
    assert.deepEqual(room.bots, ["BLACK", "PURPLE"], name);
  }
}

assert.ok(sawPending && sawSixBotMove && sawNewMatch);
assert.ok(requests.some(request => request.playerCount === 6 && request.boardShape === "hexagon"));
assert.ok(requests.some(request => request.playerCount === 4 && request.boardShape === "triangle"));
const final = stages.at(-1).room, tampered = plain(final);
tampered.revision++;
tampered.stateHash = `${final.stateHash.slice(0, -1)}${final.stateHash.endsWith("0") ? "1" : "0"}`;
await assert.rejects(verifySharedRoom(tampered), /STATE_MISMATCH/);
assert.equal(await native.receive(tampered), false);
assert.equal(native.error, "STATE_MISMATCH");
assert.equal(native.room.stateHash, final.stateHash);
assert.equal(native.room.matchId, final.matchId);
native.detach();
process.stdout.write(JSON.stringify({ status: "PASS_SHARED_SERVICE_BOTH_CLIENTS", snapshots: stages.length,
  nativeStateRequests: requests.length, sixSeatBotMove: sawSixBotMove, pendingSettings: sawPending,
  countAndShapeRematch: sawNewMatch, tamperedHashRejectedByBoth: true }));
