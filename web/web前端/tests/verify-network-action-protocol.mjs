import assert from "node:assert/strict";
import { NetworkManager } from "../NetworkManager.js";

class ControlledWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3; static instances = [];
  constructor(url) { this.url = url; this.readyState = 0; this.listeners = new Map(); this.sent = []; ControlledWebSocket.instances.push(this); }
  addEventListener(type, handler) { const list = this.listeners.get(type) ?? []; list.push(handler); this.listeners.set(type, list); }
  emit(type, event = {}) { for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close(code = 1000, reason = "") { this.readyState = 3; this.emit("close", { code, reason, wasClean: true }); }
  message(payload) { this.emit("message", { data: JSON.stringify(payload) }); }
}

const previous = globalThis.WebSocket; globalThis.WebSocket = ControlledWebSocket;
async function opened(options = {}) {
  const manager = new NetworkManager(options); const promise = manager.connect("ws://test.invalid/ws", "token");
  const socket = ControlledWebSocket.instances.at(-1); socket.readyState = ControlledWebSocket.OPEN; socket.emit("open"); await promise;
  return { manager, socket };
}
try {
  const { manager, socket } = await opened({ protocolTimeout: 20 });
  const negotiation = manager.negotiateActionProtocol();
  assert.equal(socket.sent.at(-1).type, "action_protocol_hello");
  socket.message({ type: "ACTION_PROTOCOL_SELECTED", version: 1, serverInstanceId: "server-a" });
  assert.deepEqual(await negotiation, { status: "selected", version: 1, serverInstanceId: "server-a" });
  const sent = await manager.sendVersionedAction({ roomInstanceId: "instance-a", matchEpoch: "epoch-a", clientActionId: "action-1", baseActionSeq: 4, type: "player_move", point: [2, 3] });
  assert.equal(sent.sent, true);
  assert.deepEqual(socket.sent.at(-1), { type: "player_move", roomInstanceId: "instance-a", matchEpoch: "epoch-a", clientActionId: "action-1", baseActionSeq: 4, point: [2, 3] });
  await manager.retryBots();
  assert.deepEqual(socket.sent.at(-1), { type: "retry_bots" });
  manager.disconnect();

  const oldResponse = await opened();
  const syncHandshake = oldResponse.manager.negotiateActionProtocol();
  oldResponse.socket.message({ type: "ACTION_PROTOCOL_SELECTED", version: 1, serverInstanceId: "server-a" });
  await syncHandshake;
  const sync = oldResponse.manager.requestActionSync({ roomInstanceId: "instance-a", matchEpoch: "epoch-a", pendingActionIds: ["a1"] });
  const request = oldResponse.socket.sent.at(-1);
  assert.equal(request.type, "sync_state"); assert.equal(request.matchEpoch, "epoch-a"); assert.deepEqual(request.pendingActionIds, ["a1"]);
  oldResponse.socket.message({ type: "SYNC_STATE", syncRequestId: "wrong-id", roomInstanceId: "instance-a" });
  oldResponse.socket.message({ type: "SYNC_STATE", syncRequestId: request.syncRequestId, roomInstanceId: "instance-b" });
  await assert.rejects(sync, /different room instance/);
  oldResponse.manager.disconnect();

  const routed = await opened();
  const routedHandshake = routed.manager.negotiateActionProtocol();
  routed.socket.message({ type: "ACTION_PROTOCOL_SELECTED", version: 1, serverInstanceId: "server-a" }); await routedHandshake;
  const skip = routed.manager.sendSkip();
  const routedSync = routed.manager.requestActionSync({ roomInstanceId: "instance-a", matchEpoch: "epoch-a", pendingActionIds: [] });
  const routedId = routed.socket.sent.at(-1).syncRequestId;
  routed.socket.message({ type: "ERROR", code: "SYNC_FAILED", message: "sync failed", syncRequestId: routedId });
  await assert.rejects(routedSync, error => error.code === "SYNC_FAILED");
  assert.equal(routed.manager._pendingRequests.length, 1, "a sync error cannot settle an unrelated legacy request");
  routed.socket.message({ type: "TURN_SKIPPED" }); await skip;
  routed.manager.disconnect();

  const legacy = await opened();
  const handshake = legacy.manager.negotiateActionProtocol();
  legacy.socket.message({ type: "ERROR", code: "UNKNOWN_MESSAGE_TYPE", message: "Unsupported message type: 'action_protocol_hello'" });
  assert.equal((await handshake).status, "legacy");
  const helloCount = legacy.socket.sent.filter(message => message.type === "action_protocol_hello").length;
  assert.deepEqual(await legacy.manager.negotiateActionProtocol(), { status: "legacy" });
  assert.equal(legacy.socket.sent.filter(message => message.type === "action_protocol_hello").length, helloCount, "legacy is final for this connection");
  legacy.manager.disconnect();

  const generic = await opened({ protocolTimeout: 10 });
  const uncertain = generic.manager.negotiateActionProtocol();
  generic.socket.message({ type: "ERROR", code: "OTHER", message: "unrelated" });
  assert.equal((await uncertain).status, "unknown");
  const timedOutHelloCount = generic.socket.sent.filter(message => message.type === "action_protocol_hello").length;
  assert.deepEqual(await generic.manager.negotiateActionProtocol(), { status: "unknown", reason: "timeout" });
  assert.equal(generic.socket.sent.filter(message => message.type === "action_protocol_hello").length, timedOutHelloCount, "unknown cannot be taken over by a second uncorrelated hello");
  generic.manager.disconnect();

  const malformed = await opened();
  let selectedEvents = 0;
  malformed.manager.on("ACTION_PROTOCOL_SELECTED", () => { selectedEvents += 1; });
  const malformedHandshake = malformed.manager.negotiateActionProtocol();
  malformed.socket.message({ type: "ACTION_PROTOCOL_SELECTED", version: 1, serverInstanceId: {} });
  assert.deepEqual(await malformedHandshake, { status: "unknown", reason: "invalid_response" });
  assert.equal(selectedEvents, 0, "malformed protocol acknowledgments are not broadcast");
  const malformedHelloCount = malformed.socket.sent.filter(message => message.type === "action_protocol_hello").length;
  assert.deepEqual(await malformed.manager.negotiateActionProtocol(), { status: "unknown", reason: "invalid_response" });
  assert.equal(malformed.socket.sent.filter(message => message.type === "action_protocol_hello").length, malformedHelloCount);
  malformed.manager.disconnect();

  const joinError = await opened({ protocolTimeout: 10 });
  const join = joinError.manager.joinRoom("absent");
  await Promise.resolve();
  const joinHandshake = joinError.manager.negotiateActionProtocol();
  joinError.socket.message({ type: "ERROR", code: "ROOM_NOT_FOUND", message: "Room not found: absent" });
  await assert.rejects(join, error => error.code === "ROOM_NOT_FOUND");
  assert.equal((await joinHandshake).status, "unknown", "a room error does not settle or consume an unrelated hello");
  joinError.manager.disconnect();

  const leaveSync = await opened();
  const leaveHandshake = leaveSync.manager.negotiateActionProtocol();
  leaveSync.socket.message({ type: "ACTION_PROTOCOL_SELECTED", version: 1, serverInstanceId: "server-a" }); await leaveHandshake;
  leaveSync.manager.hydrateSession({ roomId: "room-a" });
  let syncEvents = 0; let staleSyncErrors = 0;
  leaveSync.manager.on("SYNC_STATE", () => { syncEvents += 1; });
  leaveSync.manager.on("ERROR", () => { staleSyncErrors += 1; });
  const leavingRequest = leaveSync.manager.requestActionSync({ roomInstanceId: "instance-a", matchEpoch: "epoch-a", pendingActionIds: [] });
  const leavingId = leaveSync.socket.sent.at(-1).syncRequestId;
  await leaveSync.manager.leaveRoom();
  await assert.rejects(leavingRequest, /Room session ended/);
  leaveSync.socket.message({ type: "SYNC_STATE", syncRequestId: leavingId, roomInstanceId: "instance-a" });
  leaveSync.socket.message({ type: "ERROR", syncRequestId: "expired-id", code: "ACTION_PROTOCOL_NOT_NEGOTIATED", message: "stale" });
  leaveSync.socket.message({ type: "sync_state", syncRequestId: leavingId, roomInstanceId: "instance-a" });
  assert.equal(syncEvents, 0, "late or lowercase sync replies are isolated from the current room");
  assert.equal(staleSyncErrors, 0, "unowned sync errors are not broadcast");
  leaveSync.socket.readyState = ControlledWebSocket.CLOSED;
  leaveSync.socket.emit("close", { code: 1000, reason: "remote", wasClean: true });
  assert.deepEqual(leaveSync.manager.getActionProtocol(), { status: "unknown", version: null, serverInstanceId: null }, "a real close clears negotiated protocol state");
  console.log("verify-network-action-protocol: PASS");
} finally { globalThis.WebSocket = previous; }
