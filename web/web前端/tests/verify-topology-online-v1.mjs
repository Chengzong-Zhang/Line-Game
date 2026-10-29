import assert from "node:assert/strict";

import { canonicalizeBoard } from "../BoardCompiler.js";
import { createSurfacePreset } from "../BoardPresets.js";

const networkModule = await import("../NetworkManager.js");
const roomSyncModule = await import("../OnlineRoomSync.js");
const appStateModule = await import("../OnlineAppState.js");

const {
  NetworkManager,
  ServerEvent,
  TOPOLOGY_ROOM_CAPABILITY,
} = networkModule;
const {
  coordinateControllerRoomSnapshot,
  validateTopologyRoomSnapshot,
} = roomSyncModule;
const { normalizeGameSettings } = appStateModule;

assert.equal(typeof TOPOLOGY_ROOM_CAPABILITY, "string",
  "NetworkManager must export the topology-room capability name");
assert.equal(TOPOLOGY_ROOM_CAPABILITY, "board-topology-v1",
  "the client and server must negotiate one stable topology capability");
assert.equal(typeof validateTopologyRoomSnapshot, "function",
  "room snapshots need a reusable topology validation boundary");

const canonical = canonicalizeBoard(createSurfacePreset("torus", { width: 4, height: 4 }));
assert.equal(canonical.ok, true, JSON.stringify(canonical.errors));

const boardDefinition = canonical.definition;
const boardHash = canonical.boardHash;
const topologySettings = {
  playerCount: 2,
  gridSize: 4,
  boardShape: "custom",
  rulesVersion: "surface-v1",
  boardDefinition,
  boardHash,
  topologyProtocolVersion: TOPOLOGY_ROOM_CAPABILITY,
};
const topologyAction = {
  type: "player_move",
  vertexId: boardDefinition.vertices[0].id,
  boardHash,
};

assert.equal(typeof normalizeGameSettings, "function",
  "the production setting normalizer must remain available to room restoration");
const normalizedTopologySettings = normalizeGameSettings(topologySettings);
assert.equal(normalizedTopologySettings.rulesVersion, "surface-v1",
  "the production setting normalizer must not downgrade surface-v1 to a legacy rule set");
assert.equal(normalizedTopologySettings.boardShape, "custom",
  "the production setting normalizer must not downgrade custom topology boards to triangles");
assert.deepEqual(normalizedTopologySettings.boardDefinition, boardDefinition,
  "the full canonical board definition must survive UI state normalization");
assert.equal(normalizedTopologySettings.boardHash, boardHash,
  "the topology board identity must survive UI state normalization");
assert.equal(normalizedTopologySettings.topologyProtocolVersion, TOPOLOGY_ROOM_CAPABILITY,
  "the UI must retain the negotiated topology protocol version");

function clone(value) {
  return structuredClone(value);
}

function makeTopologyPayload({
  settings = topologySettings,
  matchSettings = settings,
  actions = [topologyAction],
} = {}) {
  return {
    type: ServerEvent.ROOM_JOINED,
    roomId: "topology-test-room",
    settings: clone(settings),
    matchState: {
      settings: clone(matchSettings),
      actions: clone(actions),
    },
  };
}

function assertSnapshotAccepted(payload, incomingSettings = payload.settings,
  capabilities = [TOPOLOGY_ROOM_CAPABILITY]) {
  const result = validateTopologyRoomSnapshot(payload, incomingSettings, capabilities);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.isTopology, true, "surface rooms must be detected as topology rooms");
}

function assertSnapshotRejected(payload, incomingSettings = payload.settings,
  capabilities = [TOPOLOGY_ROOM_CAPABILITY], message = "snapshot must fail closed") {
  const result = validateTopologyRoomSnapshot(payload, incomingSettings, capabilities);
  assert.equal(result.ok, false, message + ": " + JSON.stringify(result));
  assert.equal(typeof result.code, "string", "rejected snapshots need a stable diagnostic code");
  assert.ok(result.code.length > 0, "rejected snapshots need a non-empty diagnostic code");
  return result;
}

const validTopologyPayload = makeTopologyPayload();
assertSnapshotAccepted(validTopologyPayload);
assert.equal(JSON.stringify(validTopologyPayload), JSON.stringify(makeTopologyPayload()),
  "snapshot validation must not mutate the authority payload");
assertSnapshotAccepted({
  type: ServerEvent.ROOM_CREATED,
  roomId: "topology-test-room",
  settings: clone(topologySettings),
}, topologySettings, [TOPOLOGY_ROOM_CAPABILITY]);

const legacySettings = {
  playerCount: 2,
  gridSize: 5,
  boardShape: "triangle",
  rulesVersion: "territory-v3",
};
const legacyValidation = validateTopologyRoomSnapshot(
  { type: ServerEvent.ROOM_JOINED, settings: legacySettings }, legacySettings, [],
);
assert.equal(legacyValidation.ok, true, "legacy rooms must stay compatible");
assert.equal(legacyValidation.isTopology, false, "legacy rooms must not be misclassified");

const missingCapability = assertSnapshotRejected(makeTopologyPayload(), topologySettings, [],
  "a client without board-topology-v1 must not enter a topology room");
assert.equal(missingCapability.code, "TOPOLOGY_CAPABILITY_REQUIRED");

const missingDefinitionSettings = { ...topologySettings };
delete missingDefinitionSettings.boardDefinition;
assertSnapshotRejected(makeTopologyPayload({
  settings: missingDefinitionSettings,
  matchSettings: missingDefinitionSettings,
}), missingDefinitionSettings, [TOPOLOGY_ROOM_CAPABILITY],
"a topology room without its complete definition must not fall back to a triangle board");

const missingHashSettings = { ...topologySettings };
delete missingHashSettings.boardHash;
assertSnapshotRejected(makeTopologyPayload({
  settings: missingHashSettings,
  matchSettings: missingHashSettings,
}), missingHashSettings, [TOPOLOGY_ROOM_CAPABILITY],
"a topology room without boardHash must not be restored");

const unsupportedProtocolSettings = {
  ...topologySettings,
  topologyProtocolVersion: "board-topology-v0",
};
assertSnapshotRejected(makeTopologyPayload({
  settings: unsupportedProtocolSettings,
  matchSettings: unsupportedProtocolSettings,
}), unsupportedProtocolSettings, [TOPOLOGY_ROOM_CAPABILITY],
"an unsupported topology protocol must be explicit rather than downgraded");

const differentRoomHashSettings = { ...topologySettings, boardHash: "different-room-hash" };
assertSnapshotRejected(makeTopologyPayload({
  settings: topologySettings,
  matchSettings: differentRoomHashSettings,
}), topologySettings, [TOPOLOGY_ROOM_CAPABILITY],
"room settings and reconnect settings must identify the same board");

const differentDefinition = clone(boardDefinition);
differentDefinition.topology.specialVertexPolicy = "different-policy";
const differentDefinitionSettings = {
  ...topologySettings,
  boardDefinition: differentDefinition,
};
assertSnapshotRejected(makeTopologyPayload({
  settings: topologySettings,
  matchSettings: differentDefinitionSettings,
}), topologySettings, [TOPOLOGY_ROOM_CAPABILITY],
"room settings and reconnect settings must carry the same full board definition");

assertSnapshotRejected(makeTopologyPayload({
  actions: [{ type: "player_move", vertexId: topologyAction.vertexId, boardHash: "wrong-hash" }],
}), topologySettings, [TOPOLOGY_ROOM_CAPABILITY],
"a replay action from another board must be rejected");
assertSnapshotRejected(makeTopologyPayload({
  actions: [{ type: "player_move", boardHash }],
}), topologySettings, [TOPOLOGY_ROOM_CAPABILITY],
"a topology replay action without vertexId must be rejected");
assertSnapshotRejected(makeTopologyPayload({
  actions: [{ type: "player_move", vertexId: topologyAction.vertexId }],
}), topologySettings, [TOPOLOGY_ROOM_CAPABILITY],
"a topology replay action without boardHash must be rejected");
assertSnapshotRejected(makeTopologyPayload({
  actions: [{ type: "player_move", point: [1, 2], boardHash }],
}), topologySettings, [TOPOLOGY_ROOM_CAPABILITY],
"legacy grid coordinates must not be accepted as topology replay moves");

const failClosedCalls = [];
const failClosedResult = coordinateControllerRoomSnapshot({
  controller: {
    restoreMatchState() {
      assert.fail("an invalid topology snapshot must fail before restoring a board");
    },
    setAuthoritativeSnapshotValid(value) {
      failClosedCalls.push(["valid", value]);
    },
    setMultiplayerState(value, syncState) {
      failClosedCalls.push(["multiplayer", value, syncState]);
    },
  },
  payload: makeTopologyPayload(),
  incomingSettings: topologySettings,
  topologyCapabilities: [],
  syncOnlineController() {
    assert.fail("an invalid topology snapshot must fail before online state is synchronized");
  },
  applySettingsToController() {
    assert.fail("an invalid topology snapshot must not replace the active board");
  },
});
assert.equal(failClosedResult.success, false);
assert.equal(failClosedResult.reason, "TOPOLOGY_CAPABILITY_REQUIRED");
assert.deepEqual(failClosedCalls, [
  ["valid", false],
  ["multiplayer", { roomReady: false, opponentConnected: false }, false],
]);

const validCoordinationCalls = [];
const validCoordination = coordinateControllerRoomSnapshot({
  controller: {
    restoreMatchState(matchState) {
      validCoordinationCalls.push(["restore", matchState]);
      return { success: true, state: { restored: true } };
    },
    setAuthoritativeSnapshotValid(value) {
      validCoordinationCalls.push(["valid", value]);
    },
  },
  payload: makeTopologyPayload(),
  incomingSettings: clone(topologySettings),
  topologyCapabilities: [TOPOLOGY_ROOM_CAPABILITY],
  syncOnlineController(payload, syncState) {
    validCoordinationCalls.push(["online", payload.roomId, syncState]);
  },
  applySettingsToController(settings, resetController, authoritative) {
    validCoordinationCalls.push(["settings", settings.boardHash, resetController, authoritative]);
  },
});
assert.equal(validCoordination.success, true, JSON.stringify(validCoordination));
assert.deepEqual(validCoordinationCalls[0], ["online", "topology-test-room", false]);
assert.equal(validCoordinationCalls[1][0], "restore");
assert.equal(validCoordinationCalls[1][1].settings.boardHash, boardHash);
assert.deepEqual(validCoordinationCalls.slice(2), [
  ["valid", true],
  ["settings", boardHash, false, false],
]);

function openManager(options = {}) {
  const sent = [];
  const manager = new NetworkManager(options);
  manager.socket = {
    readyState: 1,
    send(raw) {
      sent.push(JSON.parse(raw));
    },
  };
  return { manager, sent };
}

const previousWebSocket = globalThis.WebSocket;
globalThis.WebSocket = { OPEN: 1 };
try {
  const { manager, sent } = openManager();
  assert.deepEqual(manager.topologyCapabilities, [TOPOLOGY_ROOM_CAPABILITY],
    "current clients advertise the topology capability by default");

  const createRequest = manager.createRoom({ ...legacySettings });
  await Promise.resolve();
  assert.deepEqual(sent[0], {
    type: "create_room",
    settings: legacySettings,
    topologyCapabilities: [TOPOLOGY_ROOM_CAPABILITY],
  });
  manager._handleMessage({ data: JSON.stringify({
    type: ServerEvent.ROOM_CREATED,
    roomId: "topology-test-room",
    playerId: "player-black",
    color: "BLACK",
  }) });
  await createRequest;

  const joinRequest = manager.joinRoom("topology-test-room", "player-black");
  await Promise.resolve();
  assert.deepEqual(sent[1], {
    type: "join_room",
    roomId: "topology-test-room",
    playerId: "player-black",
    topologyCapabilities: [TOPOLOGY_ROOM_CAPABILITY],
    rootProtocolVersion: 2,
  });
  manager._handleMessage({ data: JSON.stringify({
    type: ServerEvent.ROOM_JOINED,
    roomId: "topology-test-room",
    playerId: "player-black",
    color: "BLACK",
  }) });
  await joinRequest;

  await manager.updateRoomSettings(topologySettings);
  assert.deepEqual(sent[2], {
    type: "update_room_settings",
    settings: topologySettings,
    topologyCapabilities: [TOPOLOGY_ROOM_CAPABILITY],
  });

  const legacyMove = await manager.sendMove([1, 2]);
  assert.equal(sent[3].type, "player_move");
  assert.deepEqual(sent[3].point, [1, 2], "legacy coordinate encoding must stay stable");
  assert.match(sent[3].actionId, /^player-black:/, "legacy action carries a deduplication identity");
  assert.deepEqual(legacyMove, {
    roomId: "topology-test-room",
    playerId: "player-black",
    point: [1, 2],
  });

  const topologyMove = await manager.sendMove({
    vertexId: topologyAction.vertexId,
    boardHash,
  });
  assert.deepEqual(sent[4], {
    type: "player_move",
    vertexId: topologyAction.vertexId,
    boardHash,
  }, "topology moves must never be silently encoded as grid points");
  assert.deepEqual(topologyMove, {
    roomId: "topology-test-room",
    playerId: "player-black",
    vertexId: topologyAction.vertexId,
    boardHash,
  });

  await assert.rejects(manager.sendMove({ vertexId: "", boardHash }), /vertexId/i);
  await assert.rejects(manager.sendMove({ vertexId: topologyAction.vertexId, boardHash: "" }), /boardHash/i);
  await assert.rejects(manager.sendMove({ vertexId: topologyAction.vertexId }), /boardHash/i);

  const oldClient = openManager({ topologyCapabilities: [] });
  assert.deepEqual(oldClient.manager.topologyCapabilities, [],
    "tests and old clients can explicitly declare no topology support");
  const oldJoin = oldClient.manager.joinRoom("legacy-room");
  await Promise.resolve();
  assert.deepEqual(oldClient.sent[0], {
    type: "join_room",
    roomId: "legacy-room",
    topologyCapabilities: [],
    rootProtocolVersion: 2,
  });
  oldClient.manager._handleMessage({ data: JSON.stringify({
    type: ServerEvent.ROOM_JOINED,
    roomId: "legacy-room",
    playerId: "legacy-player",
    color: "WHITE",
  }) });
  await oldJoin;
} finally {
  globalThis.WebSocket = previousWebSocket;
}

console.log(JSON.stringify({
  status: "PASS",
  contract: "board-topology-online-v1",
  coverage: [
    "topology capability negotiation on create join and settings updates",
    "legacy coordinate moves remain stable",
    "topology vertexId and boardHash moves are explicit",
    "missing capability definition hash protocol and replay-action mismatches fail closed",
    "invalid snapshots cannot replace the active controller board",
  ],
}));
