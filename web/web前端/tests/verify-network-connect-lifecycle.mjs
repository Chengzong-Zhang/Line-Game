import assert from "node:assert/strict";
import { NetworkManager } from "../NetworkManager.js";

class ControlledWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  static instances = [];
  constructor(url) { this.url = url; this.readyState = 0; this.listeners = new Map(); ControlledWebSocket.instances.push(this); }
  addEventListener(type, handler) { const list = this.listeners.get(type) ?? []; list.push(handler); this.listeners.set(type, list); }
  emit(type, event = {}) { for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event); }
  send() {}
  close(code = 1000, reason = "") { this.closeArgs = { code, reason }; this.readyState = 3; }
}
const previous = globalThis.WebSocket;
globalThis.WebSocket = ControlledWebSocket;
try {
  const manager = new NetworkManager();
  const firstConnect = manager.connect("ws://example.invalid/ws", "token");
  const firstSocket = ControlledWebSocket.instances[0];
  manager.disconnect(1000, "cancel-startup");
  const rejection = assert.rejects(firstConnect, /cancel|closed|disconnect/i);
  await Promise.resolve();
  const secondConnect = manager.connect("ws://example.invalid/ws", "token");
  const secondSocket = ControlledWebSocket.instances[1];
  assert.ok(secondSocket, "disconnecting a pending connection permits a fresh attempt");
  firstSocket.readyState = ControlledWebSocket.OPEN;
  firstSocket.emit("open");
  firstSocket.readyState = ControlledWebSocket.CLOSED;
  firstSocket.emit("close", { code: 1000, reason: "late close" });
  assert.equal(manager.socket, secondSocket, "late events from a canceled socket cannot replace or clear the current socket");
  secondSocket.readyState = ControlledWebSocket.OPEN;
  secondSocket.emit("open");
  await secondConnect;
  await rejection;
  manager.disconnect();

  const erroredManager = new NetworkManager({ connectTimeout: 1000 });
  const secretEndpoint = "ws://example.invalid/error?tenant=private-value";
  const failedConnect = erroredManager.connect(secretEndpoint, "token");
  const erroredSocket = ControlledWebSocket.instances.at(-1);
  erroredSocket.emit("error");
  await assert.rejects(failedConnect, error => /Failed to connect/.test(error.message) && !error.message.includes("private-value"));
  assert.equal(erroredManager.socket, null, "a failed CONNECTING socket is detached immediately");
  erroredSocket.readyState = ControlledWebSocket.OPEN;
  erroredSocket.emit("open");
  assert.equal(erroredManager.isConnected(), false, "late open after connect error cannot activate the failed socket");
  const rawWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class ThrowingWebSocket { constructor() { throw new Error("private-token endpoint-secret"); } };
  try {
    await assert.rejects(new NetworkManager().connect("ws://example.invalid/constructor", "token"), error =>
      !/private-token|endpoint-secret/.test(error.message));
  } finally { globalThis.WebSocket = rawWebSocket; }
  const openManager = new NetworkManager();
  let openPayload = null;
  openManager.on("OPEN", payload => { openPayload = payload; });
  const openConnect = openManager.connect(secretEndpoint, "token");
  const openSocket = ControlledWebSocket.instances.at(-1);
  openSocket.readyState = ControlledWebSocket.OPEN; openSocket.emit("open"); await openConnect;
  assert.equal(Object.hasOwn(openPayload, "url"), false, "OPEN events never expose endpoint query values");
  assert.equal(openManager.getSession().url, null, "session snapshots never retain endpoint query values");
  openManager.hydrateSession({ url: "ws://user:password@example.invalid/ws?token=private#fragment" });
  assert.equal(openManager.getSession().url, null, "hydrated session URLs reject credentials, queries, and fragments");
  openManager.disconnect();

  const closeManager = new NetworkManager();
  let closePayload = null;
  closeManager.on("CLOSE", payload => { closePayload = payload; });
  const closeConnect = closeManager.connect("ws://example.invalid/close", "token");
  const closeSocket = ControlledWebSocket.instances.at(-1);
  closeSocket.readyState = ControlledWebSocket.OPEN; closeSocket.emit("open"); await closeConnect;
  closeSocket.readyState = ControlledWebSocket.CLOSED;
  closeSocket.emit("close", { code: 4401, reason: "private-token endpoint-secret", wasClean: false });
  assert.equal(Object.hasOwn(closePayload, "reason"), false, "close event payloads omit server-controlled reason text");
  closeManager.disconnect();

  const requestManager = new NetworkManager();
  const requestConnect = requestManager.connect("ws://example.invalid/request-error", "token");
  const requestSocket = ControlledWebSocket.instances.at(-1);
  requestSocket.readyState = ControlledWebSocket.OPEN;
  requestSocket.emit("open"); await requestConnect;
  const joinRequest = requestManager.joinRoom("expired-room", "player-7");
  await Promise.resolve();
  requestSocket.emit("message", { data: JSON.stringify({ type: "ERROR", code: "ROOM_NOT_FOUND", message: "Room not found: expired-room" }) });
  await assert.rejects(joinRequest, error => error.code === "ROOM_NOT_FOUND" && !/expired-room/.test(error.message));
  requestManager.disconnect();

  const timeoutManager = new NetworkManager({ connectTimeout: 5 });
  await assert.rejects(timeoutManager.connect("ws://example.invalid/timeout", "token"), /timed out/);
  assert.equal(timeoutManager.socket, null, "silent connect attempts time out and detach");

  const oldNow = Date.now;
  const oldSetInterval = globalThis.setInterval;
  const oldClearInterval = globalThis.clearInterval;
  let now = 1000;
  let intervalId = 0;
  const intervals = new Map();
  Date.now = () => now;
  globalThis.setInterval = callback => { const id = ++intervalId; intervals.set(id, callback); return id; };
  globalThis.clearInterval = id => intervals.delete(id);
  try {
    const heartbeatManager = new NetworkManager({ heartbeatInterval: 2000, heartbeatTimeout: 10 });
    let closeEvents = 0;
    heartbeatManager.on("CLOSE", () => { closeEvents += 1; });
    const connect = heartbeatManager.connect("ws://example.invalid/heartbeat", "token");
    const heartbeatSocket = ControlledWebSocket.instances.at(-1);
    heartbeatSocket.readyState = ControlledWebSocket.OPEN;
    heartbeatSocket.emit("open"); await connect;
    now += 11;
    [...intervals.values()][1]();
    assert.equal(heartbeatManager.socket, null);
    assert.equal(closeEvents, 1, "heartbeat timeout notifies the current connection loss exactly once");
    heartbeatSocket.readyState = ControlledWebSocket.CLOSED;
    heartbeatSocket.emit("close", { code: 4000, reason: "heartbeat_timeout" });
    assert.equal(closeEvents, 1, "late close after heartbeat timeout is not emitted twice");

    const intentional = new NetworkManager();
    let intentionalCloseEvents = 0;
    intentional.on("CLOSE", () => { intentionalCloseEvents += 1; });
    const intentionalConnect = intentional.connect("ws://example.invalid/intentional", "token");
    const intentionalSocket = ControlledWebSocket.instances.at(-1);
    intentional.disconnect(1000, "logout");
    await assert.rejects(intentionalConnect, /canceled/);
    assert.equal(intentionalCloseEvents, 0, "intentional logout does not request auto-reconnect");
  } finally {
    Date.now = oldNow;
    globalThis.setInterval = oldSetInterval;
    globalThis.clearInterval = oldClearInterval;
  }
  console.log("verify-network-connect-lifecycle: PASS (cancel, stale socket events, connect error, bounded timeout, heartbeat close notification)");
} finally {
  globalThis.WebSocket = previous;
}
