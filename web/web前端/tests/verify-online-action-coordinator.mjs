import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { OnlineActionSyncCoordinator } from "../OnlineActionSyncCoordinator.js";
import OnlineActionSync from "../OnlineActionSync.js";

const sourceText = async path => fs.readFile(new URL(path, import.meta.url), "utf8");
const dataModule = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const engineUrl = dataModule(await sourceText("../GameEngine.js"));
const { default: GameEngine, Player, TerritoryRulesVersion } = await import(engineUrl);
const controllerSource = await sourceText("../GameController.js");
const controllerModule = controllerSource
  .replace(/^import \{ decodeTopologyState \} from "\.\/TopologyStateCodec\.js\?v=[^"]+";/m,
    `import { decodeTopologyState } from "${dataModule("export function decodeTopologyState() { throw new Error('Unexpected topology in ordinary fixture'); }")}";`)
  .replace(/^import GameEngine, \{[^}]+\} from "\.\/GameEngine\.js\?v=[^"]+";/m,
    `import GameEngine, { Player, StartProtectionRule, TerritoryRulesVersion, PLAYER_ORDER, getBoardPositions, resolveBoardShape } from "${engineUrl}";`)
  .replace(/^import Renderer from "\.\/Renderer\.js\?v=[^"]+";/m,
    `import Renderer from "${dataModule("export default class Renderer {}")}";`)
  .replace(/^import \{ ServerEvent \} from "\.\/NetworkManager\.js\?v=[^"]+";/m,
    `import { ServerEvent } from "${dataModule("export const ServerEvent = {}; ")}";`)
  .replace(/^import \{ serializeEngineState \} from "\.\/AIStateProtocol\.js\?v=[^"]+";/m,
    `import { serializeEngineState } from "${dataModule("export function serializeEngineState(){ return {}; }")}";`)
  .replace(/^import \{\r?\n  applyTerritoryWorkerResult,\r?\n\} from "\.\/TerritoryWorkerSession\.js\?v=[^"]+";\r?\nimport TerritoryWorkerPool from "\.\/TerritoryWorkerPool\.js\?v=[^"]+";/m,
    `import { applyTerritoryWorkerResult } from "${dataModule("export function applyTerritoryWorkerResult(){return false;}")}";\nimport TerritoryWorkerPool from "${dataModule("export default class TerritoryWorkerPool { cancel(){return false;} cancelPending(){return false;} hasCurrentRequest(){return false;} start(){return 1;} }")}";`);
const { GameController } = await import(dataModule(controllerModule));

function realController(engineOptions = {}) {
  const options = { gridSize: 5, playerCount: 2, startPlayer: Player.BLACK, rulesVersion: TerritoryRulesVersion.V1, ...engineOptions };
  const controller = Object.create(GameController.prototype);
  controller.options = { engine: options };
  controller.engine = new GameEngine(options);
  controller._validGridPoints = controller.engine.getValidPositions();
  controller.renderer = { invalidate() {}, render() {} };
  controller._engineEpoch = 2; controller.lastAction = null; controller._authoritativeSnapshotValid = true;
  controller._preparedMatchStates = new Map(); controller._preparedOnlineActions = new Map(); controller._preparedTransactionSequence = 0;
  controller.multiplayerEnabled = false; controller.canvas = { classList: { toggle() {} }, style: {}, setAttribute() {} };
  controller._reportNetworkError = () => {}; controller._invalidatePendingRoomOperation = () => {};
  controller._cancelTerritoryRefresh = () => {}; controller.stateChangeListener = () => {};
  return controller;
}

function harness({ commitStatus = "applied", protocolStatus = "selected", pending = true, onPublish = null, onRejected = null,
  timerMode = "injected" } = {}) {
  const events = [];
  const listeners = new Map();
  const socket = {};
  const manager = { socket, on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name); },
    async negotiateActionProtocol() { return protocolStatus === "selected"
      ? { status: "selected", version: 1, serverInstanceId: "server-a" } : { status: protocolStatus }; },
    async sendVersionedAction() {}, async requestActionSync() { throw new Error("unexpected sync"); } };
  let currentProtocol = "unknown";
  let hasPending = pending;
  let recoveryRequired = false;
  let scope = { serverInstanceId: "server-a", roomInstanceId: "room-a", matchGeneration: 1, matchEpoch: "epoch-a", actionSeq: 0, localPlayerId: "alice" };
  let resolvedActionOutcome = null;
  const sync = { getState: () => ({ protocol: { status: currentProtocol }, scope,
      pending: hasPending ? [{ clientActionId: "id-a", actorColor: "BLACK", playerId: "alice", scope: { ...scope } }] : [], recoveryRequired }),
    setProtocol(value) { currentProtocol = value.status; return { status: "updated" }; },
    prepareActionEvent() { events.push("ledger-prepare"); return { status: "prepared", token: "action-token", decision: "apply" }; },
    prepareSyncRequest() { return { status: "locked" }; },
    commitActionEvent() { events.push("ledger-commit"); if (commitStatus === "applied") scope = { ...scope, actionSeq: 1 }; return { status: commitStatus }; },
    abortActionEvent() { events.push("ledger-abort"); }, markConnectionLost() { events.push("connection-lost"); },
    prepareSnapshot() { return { status: "ready", token: "snapshot-token" }; },
    commitSnapshot(_token, { restoreSucceeded }) { events.push(`snapshot-commit:${restoreSucceeded}`); if (restoreSucceeded) hasPending = false;
      return { status: "committed", retryActions: [], resolvedActionOutcome }; },
    abortSnapshot() { events.push("snapshot-abort"); }, failSyncRequest() {} };
  sync.clearRoom = () => { events.push("room-cleared"); currentProtocol = "unknown"; scope = null; };
  let publishHook = null;
  const controller = { bindOnlineActionSync() { return { status: "bound" }; },
    prepareVersionedActionApplication() { events.push("controller-prepare"); return { success: true, token: "controller-action" }; },
    installVersionedActionApplication() { events.push("controller-install"); return { success: true }; },
    rollbackVersionedActionApplication() { events.push("controller-rollback"); },
    abortVersionedActionApplication() { events.push("controller-abort"); },
    publishVersionedActionApplication() { events.push("controller-publish"); publishHook?.(); return { success: true }; },
    prepareMatchState() { events.push("controller-prepare-snapshot"); return { success: true, token: "controller-snapshot" }; },
    installPreparedMatchState() { events.push("controller-install-snapshot"); return { success: true }; },
    rollbackPreparedMatchState() { events.push("controller-rollback-snapshot"); },
    abortPreparedMatchState() { events.push("controller-abort-snapshot"); },
    publishPreparedMatchState() { events.push("controller-publish-snapshot"); publishHook?.(); return { success: true, state: {} }; },
    refreshOnlineActionSyncState() { if (currentProtocol === "legacy") events.push("controller-refresh-sync-state"); },
    setAuthoritativeSnapshotValid() {} };
  const timerOptions = timerMode === "host-default" ? {}
    : timerMode === "legacy-host-binding"
      ? { setTimeoutFn: globalThis.setTimeout, clearTimeoutFn: globalThis.clearTimeout }
      : { setTimeoutFn: () => 1, clearTimeoutFn() {} };
  const coordinator = new OnlineActionSyncCoordinator({ sync, controller, getNetworkManager: () => manager,
    playerId: "alice", resolvePlayerColor: () => "BLACK", onActionRejected: onRejected, ...timerOptions });
  publishHook = onPublish ? () => onPublish(coordinator) : null;
  return { coordinator, manager, listeners, events, sync,
    setScope(value) { scope = value; }, setPending(value) { hasPending = value; },
    setResolvedActionOutcome(value) { resolvedActionOutcome = value; }, setRecoveryRequired(value) { recoveryRequired = value; } };
}

const actionPayload = { type: "ACTION_LOGGED", serverInstanceId: "server-a", roomInstanceId: "room-a", matchGeneration: 1,
  matchEpoch: "epoch-a", actionSeq: 1, clientActionId: "id-a", action: { type: "player_skip", playerId: "alice", color: "BLACK" } };
{
  const h = harness();
  await h.coordinator.start();
  const result = await h.coordinator.handleActionEvent(actionPayload);
  assert.equal(result.status, "applied");
  assert.deepEqual(h.events, ["ledger-prepare", "controller-prepare", "controller-install", "ledger-commit", "controller-publish"]);
  h.coordinator.dispose();
}
{
  let resolveSync;
  const notices = [];
  const h = harness({ onRejected: notice => notices.push(notice) });
  const committedScope = { ...h.sync.getState().scope, roomRevision: 2 };
  h.setResolvedActionOutcome({ status: "rejected", code: "RATE_LIMITED", clientActionId: "id-a", playerId: "alice",
    scope: { ...committedScope }, submittedActionSeq: 0, committedScope: { ...committedScope }, committedActionSeq: 0 });
  h.sync.prepareActionEvent = () => ({ status: "needsSync", reason: "local_action_rejected", locked: true });
  h.sync.prepareSyncRequest = () => ({ status: "ready", token: "sync-request", request: { roomInstanceId: "room-a", matchEpoch: "epoch-a", pendingActionIds: ["id-a"] } });
  h.sync.prepareSyncResponse = () => ({ status: "ready", token: "snapshot-token" });
  h.manager.requestActionSync = () => new Promise(resolve => { resolveSync = resolve; });
  h.coordinator.onCommittedRoomState = () => { h.events.push("metadata-commit"); return true; };
  await h.coordinator.start();
  const pending = h.coordinator.handleActionEvent({ ...actionPayload, type: "ACTION_REJECTED", actionProtocolVersion: 1,
    code: "RATE_LIMITED", playerId: "alice", actionSeq: 0 });
  await Promise.resolve();
  assert.equal(notices.length, 0, "the live rejection does not announce success before authoritative rollback");
  resolveSync({ type: "SYNC_STATE", actionProtocolVersion: 1, serverInstanceId: "server-a", roomInstanceId: "room-a",
    matchGeneration: 1, matchEpoch: "epoch-a", actionSeq: 0, roomRevision: 2,
    yourPlayerId: "alice", matchState: { settings: {}, actions: [] }, pendingActionOutcomes: [], outcomeLedgerComplete: true });
  const result = await pending;
  assert.equal(result.status, "committed");
  assert.equal(notices.length, 1, "the post-sync path announces once after snapshot publication and metadata commit");
  assert.equal(notices[0].code, "RATE_LIMITED");
  assert.deepEqual(h.events.slice(-2), ["controller-publish-snapshot", "metadata-commit"]);
  h.coordinator.dispose();
}
{
  const notices = [];
  const h = harness({ onRejected: notice => notices.push(notice) });
  const committedScope = { ...h.sync.getState().scope };
  h.setResolvedActionOutcome({ status: "rejected", code: "RATE_LIMITED", clientActionId: "id-a", playerId: "alice",
    scope: { ...committedScope }, submittedActionSeq: 0, committedScope: { ...committedScope }, committedActionSeq: 0 });
  h.sync.prepareActionEvent = () => ({ status: "needsSync", reason: "local_action_rejected", locked: true });
  h.sync.prepareSyncRequest = () => ({ status: "ready", token: "sync-request", request: {} });
  h.sync.prepareSyncResponse = () => ({ status: "ready", token: "snapshot-token" });
  h.manager.requestActionSync = async () => ({ type: "SYNC_STATE", actionProtocolVersion: 1, serverInstanceId: "server-a",
    roomInstanceId: "room-a", matchGeneration: 1, matchEpoch: "epoch-a", actionSeq: 0, roomRevision: 1,
    yourPlayerId: "alice", matchState: { settings: {}, actions: [] }, pendingActionOutcomes: [], outcomeLedgerComplete: true });
  h.coordinator.onCommittedRoomState = () => { throw new Error("metadata callback fault"); };
  await h.coordinator.start();
  const result = await h.coordinator.handleActionEvent({ ...actionPayload, type: "ACTION_REJECTED", actionProtocolVersion: 1,
    code: "RATE_LIMITED", playerId: "alice", actionSeq: 0 });
  assert.equal(result.status, "committed", "a metadata callback result never changes already committed status");
  assert.equal(notices.length, 0, "metadata callback failure suppresses the claim that the game is synced");
  h.coordinator.dispose();
}
{
  const h = harness({ onRejected: () => { throw new Error("UI callback fault"); } });
  const scope = { ...h.sync.getState().scope };
  h.setResolvedActionOutcome({ status: "rejected", code: "RATE_LIMITED", clientActionId: "id-a", playerId: "alice",
    scope, submittedActionSeq: 0, committedScope: scope, committedActionSeq: 0 });
  h.sync.prepareActionEvent = () => ({ status: "needsSync", reason: "local_action_rejected", locked: true });
  h.sync.prepareSyncRequest = () => ({ status: "ready", token: "sync-request", request: {} });
  h.sync.prepareSyncResponse = () => ({ status: "ready", token: "snapshot-token" });
  h.manager.requestActionSync = async () => ({ type: "SYNC_STATE", actionProtocolVersion: 1, serverInstanceId: "server-a",
    roomInstanceId: "room-a", matchGeneration: 1, matchEpoch: "epoch-a", actionSeq: 0, roomRevision: 1,
    yourPlayerId: "alice", matchState: { settings: {}, actions: [] }, pendingActionOutcomes: [], outcomeLedgerComplete: true });
  await h.coordinator.start();
  const result = await h.coordinator.handleActionEvent({ ...actionPayload, type: "ACTION_REJECTED", actionProtocolVersion: 1,
    code: "RATE_LIMITED", playerId: "alice", actionSeq: 0 });
  assert.equal(result.status, "committed", "an App feedback callback exception cannot undo or falsify a committed snapshot");
  h.coordinator.dispose();
}
{
  const notices = [];
  const h = harness({ onRejected: notice => notices.push(notice) });
  const scope = { ...h.sync.getState().scope };
  h.setResolvedActionOutcome({ status: "rejected", code: "RATE_LIMITED", clientActionId: "id-a", playerId: "alice",
    scope, submittedActionSeq: 0, committedScope: scope, committedActionSeq: 0 });
  h.sync.prepareActionEvent = () => ({ status: "needsSync", reason: "local_action_rejected", locked: true });
  h.sync.prepareSyncRequest = () => ({ status: "ready", token: "sync-request", request: {} });
  h.sync.prepareSyncResponse = () => ({ status: "ready", token: "snapshot-token" });
  h.manager.requestActionSync = async () => ({ type: "SYNC_STATE", actionProtocolVersion: 1, serverInstanceId: "server-a",
    roomInstanceId: "room-a", matchGeneration: 1, matchEpoch: "epoch-a", actionSeq: 0, roomRevision: 1,
    yourPlayerId: "alice", matchState: { settings: {}, actions: [] }, pendingActionOutcomes: [], outcomeLedgerComplete: true });
  h.coordinator.controller.prepareMatchState = () => ({ success: false, reason: "RESTORE_FAILED" });
  await h.coordinator.start();
  const result = await h.coordinator.handleActionEvent({ ...actionPayload, type: "ACTION_REJECTED", actionProtocolVersion: 1,
    code: "RATE_LIMITED", playerId: "alice", actionSeq: 0 });
  assert.equal(result.status, "restore_failed");
  assert.equal(notices.length, 0, "a failed authoritative restore never claims the action rejection is synced");
  h.coordinator.dispose();
}
{
  const notices = [];
  const h = harness({ onRejected: notice => notices.push(notice), onPublish: coordinator => {
    const current = coordinator.sync.getState().scope;
    h.setPending(true);
    h.setScope({ ...current, actionSeq: current.actionSeq + 1 });
  } });
  const scope = { ...h.sync.getState().scope };
  h.setResolvedActionOutcome({ status: "rejected", code: "RATE_LIMITED", clientActionId: "id-a", playerId: "alice",
    scope, submittedActionSeq: 0, committedScope: scope, committedActionSeq: 0 });
  h.sync.prepareActionEvent = () => ({ status: "needsSync", reason: "local_action_rejected", locked: true });
  h.sync.prepareSyncRequest = () => ({ status: "ready", token: "sync-request", request: {} });
  h.sync.prepareSyncResponse = () => ({ status: "ready", token: "snapshot-token" });
  h.manager.requestActionSync = async () => ({ type: "SYNC_STATE", actionProtocolVersion: 1, serverInstanceId: "server-a",
    roomInstanceId: "room-a", matchGeneration: 1, matchEpoch: "epoch-a", actionSeq: 0, roomRevision: 1,
    yourPlayerId: "alice", matchState: { settings: {}, actions: [] }, pendingActionOutcomes: [], outcomeLedgerComplete: true });
  await h.coordinator.start();
  await h.coordinator.handleActionEvent({ ...actionPayload, type: "ACTION_REJECTED", actionProtocolVersion: 1,
    code: "RATE_LIMITED", playerId: "alice", actionSeq: 0 });
  assert.equal(notices.length, 0, "a newer action watermark or newly pending action suppresses stale rejection feedback");
  h.coordinator.dispose();
}
{
  const h = harness();
  h.manager.socket = null;
  let negotiations = 0;
  const negotiate = h.manager.negotiateActionProtocol;
  h.manager.negotiateActionProtocol = async () => { negotiations += 1; return negotiate(); };
  const start = await h.coordinator.start();
  assert.equal(start.status, "not_connected", "start before OPEN waits without protocol negotiation");
  assert.equal(negotiations, 0);
  h.manager.socket = {};
  h.listeners.get("OPEN")();
  const ready = await h.coordinator.ensureReady();
  assert.equal(ready.status, "selected", "OPEN starts protocol negotiation for the current socket");
  assert.equal(negotiations, 1, "ensureReady joins the OPEN negotiation instead of duplicating it");
  h.coordinator.dispose();
}
{
  let notifications = 0;
  const h = harness({ onPublish: coordinator => coordinator.confirmRoomLeft() });
  h.coordinator.onCommittedRoomState = () => { notifications += 1; };
  await h.coordinator.start();
  const payload = { type: "ROOM_STATE", serverInstanceId: "server-a", roomInstanceId: "room-a", matchGeneration: 1,
    matchEpoch: "epoch-a", actionSeq: 0, matchState: { settings: {}, actions: [], players: [{ playerId: "alice", color: "BLACK" }] } };
  const result = await h.coordinator.acceptRoomSnapshot(payload, { allowNewScope: true });
  assert.equal(result.status, "committed_but_room_changed");
  assert.equal(notifications, 0);
  assert.equal(h.coordinator._playerColorById.size, 0);
}
{
  let notifications = 0;
  const h = harness({ onPublish: coordinator => coordinator.confirmRoomLeft() });
  h.coordinator.onCommittedRoomState = () => { notifications += 1; };
  await h.coordinator.start();
  const result = await h.coordinator.handleActionEvent(actionPayload);
  assert.equal(result.status, "committed_but_room_changed");
  assert.equal(notifications, 0);
}
{
  const h = harness({ commitStatus: "stale" });
  await h.coordinator.start();
  const result = await h.coordinator.handleActionEvent(actionPayload);
  assert.equal(result.status, "locked");
  assert.deepEqual(h.events, ["ledger-prepare", "controller-prepare", "controller-install", "ledger-commit", "controller-rollback", "controller-abort"]);
  h.coordinator.dispose();
}
{
  const h = harness();
  await h.coordinator.start();
  const payload = { type: "ROOM_STATE", serverInstanceId: "server-a", roomInstanceId: "room-a", matchGeneration: 1,
    matchEpoch: "epoch-a", actionSeq: 0, matchState: { settings: {}, actions: [], players: [{ playerId: "alice", color: "BLACK" }] } };
  const result = await h.coordinator.acceptRoomSnapshot(payload, { allowNewScope: true });
  assert.equal(result.status, "committed");
  assert.deepEqual(h.events, ["controller-prepare-snapshot", "controller-install-snapshot", "snapshot-commit:true", "controller-publish-snapshot"]);
  h.coordinator.dispose();
}
{
  const controller = realController();
  const oldEngine = controller.engine;
  const prepared = controller.prepareMatchState({ settings: {}, actions: [] });
  assert.equal(prepared.success, true);
  assert.equal(controller.installPreparedMatchState(prepared.token).success, true);
  assert.notEqual(controller.engine, oldEngine);
  assert.equal(controller.lastAction, null);
  controller._syncSnapshot = () => {};
  assert.equal(controller.publishPreparedMatchState(prepared.token).success, true);
}
{
  const controller = realController();
  const oldEngine = controller.engine;
  const oldEpoch = controller._engineEpoch;
  const prepared = controller.prepareMatchState({ settings: {}, actions: [] });
  const candidate = controller._preparedMatchStates.get(prepared.token).candidateEngine;
  candidate.getValidPositions = () => { throw new Error("simulated install failure"); };
  const installed = controller.installPreparedMatchState(prepared.token);
  assert.equal(installed.success, false);
  assert.equal(controller.engine, oldEngine);
  assert.equal(controller._engineEpoch, oldEpoch);
  controller.abortPreparedMatchState(prepared.token);
}
{
  const controller = realController();
  const oldEngine = controller.engine;
  const prepared = controller.prepareVersionedActionApplication({ type: "player_skip", playerId: "alice", color: Player.BLACK },
    { resolvePlayerColor: () => Player.BLACK });
  assert.equal(prepared.success, true);
  controller._preparedOnlineActions.get(prepared.token).candidateEngine.getValidPositions = () => { throw new Error("simulated action install failure"); };
  assert.equal(controller.installVersionedActionApplication(prepared.token).success, false);
  assert.equal(controller.engine, oldEngine);
  controller.abortVersionedActionApplication(prepared.token);
}
{
  const h = harness({ protocolStatus: "legacy", pending: false });
  const result = await h.coordinator.start();
  assert.equal(result.status, "legacy");
  assert.equal(h.events.includes("controller-refresh-sync-state"), true);
  h.coordinator.dispose({ leftRoom: true });
}
{
  const sync = new OnlineActionSync({ createActionId: () => "pending-v1" });
  sync.setProtocol({ status: "selected", version: 1, serverInstanceId: "server-a" });
  const payload = { type: "ROOM_STATE", actionProtocolVersion: 1, serverInstanceId: "server-a", roomInstanceId: "room-a",
    matchGeneration: 1, matchEpoch: "epoch-a", actionSeq: 0, roomRevision: 1, yourPlayerId: "alice",
    matchState: { settings: {}, actions: [] } };
  const snapshot = sync.prepareSnapshot(payload, { allowNewScope: true });
  sync.commitSnapshot(snapshot.token, { restoreSucceeded: true });
  sync.markConnectionLost();
  sync.setProtocol({ status: "legacy" });
  assert.equal(sync.getState().locked, false);
  sync.setProtocol({ status: "selected", version: 1, serverInstanceId: "server-a" });
  const reserved = sync.beginAction({ type: "player_skip", playerId: "alice", actorColor: "BLACK" });
  assert.equal(reserved.status, "reserved");
  sync.markConnectionLost();
  sync.setProtocol({ status: "legacy" });
  assert.equal(sync.getState().pending.length, 1);
  assert.equal(sync.getState().locked, true);
}
{
  const sync = new OnlineActionSync();
  sync.setProtocol({ status: "selected", version: 1, serverInstanceId: "server-a" });
  const revision = sync.getState().revision;
  assert.equal(sync.setProtocol({ status: "selected", version: 1, serverInstanceId: "server-a" }).status, "unchanged");
  assert.equal(sync.getState().revision, revision);
}
{
  const h = harness();
  await h.coordinator.start();
  const beforeClose = h.coordinator.generation;
  h.manager.socket = null;
  h.listeners.get("CLOSE")();
  assert.equal(h.coordinator.generation > beforeClose, true);
  assert.equal(h.coordinator.connectionOpen, false);
  const afterClose = h.coordinator.generation;
  h.manager.socket = {};
  h.listeners.get("OPEN")();
  assert.equal(h.coordinator.generation > afterClose, true);
  assert.equal(h.coordinator.connectionOpen, true);
  h.coordinator.dispose();
}
{
  const oldBlack = "departed-black";
  const white = "remaining-white";
  const actions = [
    { type: "player_move", point: [1, 0], playerId: oldBlack, color: "BLACK", actionSeq: 1, matchEpoch: "epoch-a", clientActionId: "action-1" },
    { type: "player_skip", playerId: white, color: "WHITE", actionSeq: 2, matchEpoch: "epoch-a", clientActionId: "action-2" },
    { type: "player_move", point: [3, 0], playerId: oldBlack, color: "BLACK", actionSeq: 3, matchEpoch: "epoch-a", clientActionId: "action-3" },
    { type: "player_move", point: [4, 0], playerId: white, color: "WHITE", actionSeq: 4, matchEpoch: "epoch-a", clientActionId: "action-4" },
  ];
  const payload = { type: "ROOM_STATE", actionProtocolVersion: 1, serverInstanceId: "server-a", roomInstanceId: "room-a",
    matchGeneration: 1, matchEpoch: "epoch-a", actionSeq: 4, roomRevision: 8,
    players: [{ playerId: white, color: "WHITE" }],
    matchState: { settings: { gridSize: 9, playerCount: 2, startPlayer: "BLACK", rulesVersion: TerritoryRulesVersion.V2 },
      actions, matchPlayerColors: { [oldBlack]: "BLACK", [white]: "WHITE" } } };
  const realHarness = (isCurrentOwner = () => true) => {
    const sync = new OnlineActionSync();
    const controller = realController({ gridSize: 9, rulesVersion: TerritoryRulesVersion.V2 });
    controller._syncSnapshot = () => {};
    controller._updateLargeBoardClass = () => {};
    controller._syncCanvasInteractivity = () => {};
    const listeners = new Map();
    const manager = { socket: {}, on(name, callback) { listeners.set(name, callback); return () => listeners.delete(name); },
      isConnected() { return true; },
      async negotiateActionProtocol() { return { status: "selected", version: 1, serverInstanceId: "server-a" }; },
      async requestActionSync() { throw new Error("sync not expected in this assertion"); } };
    const coordinator = new OnlineActionSyncCoordinator({ sync, controller, getNetworkManager: () => manager,
      playerId: white, resolvePlayerColor: () => "WHITE", isCurrentOwner, retryDelays: [], setTimeoutFn: () => 1, clearTimeoutFn() {} });
    return { sync, controller, coordinator, manager, listeners };
  };
  {
    const capacity = realHarness();
    const updates = [];
    const transaction = [];
    capacity.controller.stateChangeListener = state => updates.push({ state, ready: capacity.sync.getState().capacityRecoveryReady });
    capacity.controller._syncSnapshot = snapshot => capacity.controller.stateChangeListener?.(capacity.controller._buildGameState(snapshot));
    const publishSnapshot = capacity.controller.publishPreparedMatchState.bind(capacity.controller);
    capacity.controller.publishPreparedMatchState = token => {
      transaction.push({ step: "controller-publish", ready: capacity.sync.getState().capacityRecoveryReady });
      return publishSnapshot(token);
    };
    let rejectMetadata = false;
    capacity.coordinator.onCommittedRoomState = () => {
      transaction.push({ step: "metadata", ready: capacity.sync.getState().capacityRecoveryReady });
      return !rejectMetadata;
    };
    await capacity.coordinator.start();
    const emptyRoom = { type: "ROOM_STATE", actionProtocolVersion: 1, serverInstanceId: "server-a", roomInstanceId: "room-a",
      matchGeneration: 1, matchEpoch: "epoch-a", actionSeq: 0, roomRevision: 1, yourPlayerId: white,
      matchState: { settings: { gridSize: 9, playerCount: 2, startPlayer: "BLACK", rulesVersion: TerritoryRulesVersion.V2 }, actions: [],
        matchPlayerColors: { [white]: "WHITE" } } };
    assert.equal((await capacity.coordinator.acceptRoomSnapshot(emptyRoom, { allowNewScope: true })).status, "committed");
    updates.length = 0;
    transaction.length = 0;
    const capacityState = { ...emptyRoom, type: "SYNC_STATE", roomRevision: 2, syncRequestId: "capacity-ready-sync",
      outcomeLedgerComplete: true, pendingActionOutcomes: [],
      actionOutcomeCapacity: { serverInstanceId: "server-a", roomInstanceId: "room-a", matchGeneration: 1,
        matchEpoch: "epoch-a", blocked: true, count: 1, serializedBytes: 10, maxEntries: 1, maxSerializedBytes: 1024 } };
    capacity.manager.requestActionSync = async () => capacityState;
    assert.equal((await capacity.coordinator.requestSync()).status, "committed");
    assert.deepEqual(transaction.map(item => item.step), ["controller-publish", "metadata"]);
    assert.deepEqual(transaction.map(item => item.ready), [false, false], "readiness remains false through Controller publish and metadata");
    assert.equal(capacity.sync.getState().capacityRecoveryReady, true, "Coordinator grants readiness only after finalize");
    assert.equal(updates.at(-1).ready, true, "the final Controller refresh publishes readiness to the App");
    assert.equal(capacity.controller._getOnlineActionLockReason(), "ACTION_OUTCOME_CAPACITY",
      "a finalized capacity block has its own user-facing lock reason");

    rejectMetadata = true;
    capacity.manager.requestActionSync = async () => ({ ...capacityState, roomRevision: 3, syncRequestId: "failed-capacity-recheck" });
    const failedRecheck = await capacity.coordinator.requestSync();
    assert.equal(failedRecheck.status, "metadata_commit_failed");
    assert.equal(capacity.sync.getState().capacityBlocked, true, "a failed recheck preserves the previously finalized capacity fact");
    assert.equal(capacity.sync.getState().capacityRecoveryReady, false, "a failed same-scope recheck revokes readiness");
    assert.equal(updates.at(-1).ready, false, "the failure path publishes revoked readiness");
    capacity.coordinator.dispose();
  }
  {
    const capacityFailure = realHarness();
    await capacityFailure.coordinator.start();
    const emptyRoom = { type: "ROOM_STATE", actionProtocolVersion: 1, serverInstanceId: "server-a", roomInstanceId: "room-a",
      matchGeneration: 1, matchEpoch: "epoch-a", actionSeq: 0, roomRevision: 1, yourPlayerId: white,
      matchState: { settings: { gridSize: 9, playerCount: 2, startPlayer: "BLACK", rulesVersion: TerritoryRulesVersion.V2 }, actions: [],
        matchPlayerColors: { [white]: "WHITE" } } };
    assert.equal((await capacityFailure.coordinator.acceptRoomSnapshot(emptyRoom, { allowNewScope: true })).status, "committed");
    capacityFailure.coordinator.onCommittedRoomState = () => false;
    capacityFailure.manager.requestActionSync = async () => ({ ...emptyRoom, type: "SYNC_STATE", roomRevision: 2,
      syncRequestId: "metadata-failure-sync", outcomeLedgerComplete: true, pendingActionOutcomes: [],
      actionOutcomeCapacity: { serverInstanceId: "server-a", roomInstanceId: "room-a", matchGeneration: 1,
        matchEpoch: "epoch-a", blocked: true, count: 1, serializedBytes: 10, maxEntries: 1, maxSerializedBytes: 1024 } });
    assert.equal((await capacityFailure.coordinator.requestSync()).status, "metadata_commit_failed");
    assert.equal(capacityFailure.sync.getState().capacityBlocked, false, "a first unfinalized marker is not promoted to a capacity fact");
    assert.equal(capacityFailure.sync.getState().capacityRecoveryReady, false, "metadata failure cannot report recovery success");
    assert.equal(capacityFailure.sync.getState().recoveryRequired, true, "metadata failure leaves recovery required");
    capacityFailure.coordinator.dispose();
  }
  {
    const publishFailure = realHarness();
    const updates = [];
    publishFailure.controller.stateChangeListener = state => updates.push({ state, ready: publishFailure.sync.getState().capacityRecoveryReady });
    publishFailure.controller._syncSnapshot = snapshot => publishFailure.controller.stateChangeListener?.(publishFailure.controller._buildGameState(snapshot));
    await publishFailure.coordinator.start();
    const emptyRoom = { type: "ROOM_STATE", actionProtocolVersion: 1, serverInstanceId: "server-a", roomInstanceId: "room-a",
      matchGeneration: 1, matchEpoch: "epoch-a", actionSeq: 0, roomRevision: 1, yourPlayerId: white,
      matchState: { settings: { gridSize: 9, playerCount: 2, startPlayer: "BLACK", rulesVersion: TerritoryRulesVersion.V2 }, actions: [],
        matchPlayerColors: { [white]: "WHITE" } } };
    assert.equal((await publishFailure.coordinator.acceptRoomSnapshot(emptyRoom, { allowNewScope: true })).status, "committed");
    publishFailure.manager.requestActionSync = async () => ({ ...emptyRoom, type: "SYNC_STATE", roomRevision: 2,
      syncRequestId: "publish-failure-sync", outcomeLedgerComplete: true, pendingActionOutcomes: [],
      actionOutcomeCapacity: { serverInstanceId: "server-a", roomInstanceId: "room-a", matchGeneration: 1,
        matchEpoch: "epoch-a", blocked: true, count: 1, serializedBytes: 10, maxEntries: 1, maxSerializedBytes: 1024 } });
    publishFailure.controller.publishPreparedMatchState = () => ({ success: false, reason: "fixture_publish_failure" });
    assert.equal((await publishFailure.coordinator.requestSync()).status, "controller_commit_failed");
    assert.equal(publishFailure.sync.getState().capacityBlocked, false, "failed first Controller publish does not confirm the new marker");
    assert.equal(publishFailure.sync.getState().capacityRecoveryReady, false);
    assert.equal(updates.at(-1).ready, false, "publish failure revokes readiness in the App");
    publishFailure.coordinator.dispose();
  }
  {
    let currentOwner = true;
    const retired = realHarness(() => currentOwner);
    await retired.coordinator.start();
    const emptyRoom = { type: "ROOM_STATE", actionProtocolVersion: 1, serverInstanceId: "server-a", roomInstanceId: "room-a",
      matchGeneration: 1, matchEpoch: "epoch-a", actionSeq: 0, roomRevision: 1, yourPlayerId: white,
      matchState: { settings: { gridSize: 9, playerCount: 2, startPlayer: "BLACK", rulesVersion: TerritoryRulesVersion.V2 }, actions: [],
        matchPlayerColors: { [white]: "WHITE" } } };
    assert.equal((await retired.coordinator.acceptRoomSnapshot(emptyRoom, { allowNewScope: true })).status, "committed");
    let controllerPublishes = 0;
    const publish = retired.controller.publishPreparedMatchState.bind(retired.controller);
    retired.controller.publishPreparedMatchState = token => { controllerPublishes += 1; return publish(token); };
    const commit = retired.sync.commitSnapshot.bind(retired.sync);
    retired.sync.commitSnapshot = (token, options) => {
      const result = commit(token, options);
      if (options?.deferFinalize) currentOwner = false;
      return result;
    };
    retired.manager.requestActionSync = async () => ({ ...emptyRoom, type: "SYNC_STATE", roomRevision: 2,
      syncRequestId: "retired-owner-capacity", outcomeLedgerComplete: true, pendingActionOutcomes: [],
      actionOutcomeCapacity: { serverInstanceId: "server-a", roomInstanceId: "room-a", matchGeneration: 1,
        matchEpoch: "epoch-a", blocked: true, count: 1, serializedBytes: 10, maxEntries: 1, maxSerializedBytes: 1024 } });
    const result = await retired.coordinator.requestSync();
    assert.equal(result.status, "stale", "capacity confirmation finishing after owner retirement is discarded");
    assert.equal(controllerPublishes, 0, "a retired controller never publishes the prepared capacity snapshot");
    assert.equal(retired.sync.getState().capacityRecoveryReady, false, "a retired owner cannot grant App recovery readiness");
    retired.coordinator.dispose();
  }
  const cold = realHarness(); await cold.coordinator.start();
  const coldResult = await cold.coordinator.acceptRoomSnapshot(payload, { allowNewScope: true });
  assert.equal(coldResult.status, "committed", `a cold coordinator restores departed historical actors from the epoch roster: ${coldResult.reason}`);
  assert.equal(cold.controller.engine.getSnapshot().turnCount, 3,
    "the actual controller replays the four versioned moves/skips");
  assert.equal(cold.controller.engine.getSnapshot().gameOver, false);
  assert.deepEqual([...cold.coordinator._playerColorById], [[white, "WHITE"]], "live identity cache remains the current room roster");
  const afterRestore = structuredClone(cold.controller.engine.getSnapshot());
  const recoveryReasons = [];
  cold.coordinator.requestSync = async ({ reason }) => { recoveryReasons.push(reason); return { status: "sync_intercepted", reason }; };
  const live = await cold.coordinator.handleActionEvent({ type: "ACTION_LOGGED", actionProtocolVersion: 1,
    serverInstanceId: "server-a", roomInstanceId: "room-a",
    matchGeneration: 1, matchEpoch: "epoch-a", actionSeq: 5, clientActionId: "action-5",
    action: { type: "player_skip", playerId: oldBlack, color: "BLACK" } });
  assert.equal(live.status, "sync_intercepted", "a departed actor cannot authorize a new live action");
  assert.deepEqual(recoveryReasons, ["ACTION_PLAYER_IDENTITY_MISMATCH"], "live rejection reaches identity validation");
  assert.deepEqual(cold.controller.engine.getSnapshot(), afterRestore, "rejected live action leaves the recovered board unchanged");
  cold.coordinator.dispose();

  const hot = realHarness(); await hot.coordinator.start();
  const fullRoster = structuredClone(payload);
  fullRoster.players = [{ playerId: oldBlack, color: "BLACK" }, { playerId: white, color: "WHITE" }];
  assert.equal((await hot.coordinator.acceptRoomSnapshot(fullRoster, { allowNewScope: true })).status, "committed");
  assert.equal((await hot.coordinator.acceptRoomSnapshot(payload, { allowNewScope: true })).status, "committed",
    "a warm coordinator also uses the epoch table after the live roster drops an actor");
  assert.deepEqual([...hot.coordinator._playerColorById], [[white, "WHITE"]]);
  hot.coordinator.dispose();

  const conflicting = realHarness(); await conflicting.coordinator.start();
  assert.equal((await conflicting.coordinator.acceptRoomSnapshot(payload, { allowNewScope: true })).status, "committed",
    "a valid complete history establishes a noninitial board before failure cases");
  const preserved = { snapshot: structuredClone(conflicting.controller.engine.getSnapshot()),
    historyHashes: [...conflicting.controller.engine.historyHashes] };
  const badColor = structuredClone(payload); badColor.matchState.matchPlayerColors[oldBlack] = "WHITE";
  const conflictResult = await conflicting.coordinator.acceptRoomSnapshot(badColor, { allowNewScope: true });
  assert.equal(conflictResult.status, "restore_failed", "conflicting current and historical actor identities fail closed");
  assert.deepEqual(conflicting.controller.engine.getSnapshot(), preserved.snapshot, "failed replay preserves the preexisting board");
  assert.deepEqual([...conflicting.controller.engine.historyHashes], preserved.historyHashes, "failed replay preserves superko history");
  const missing = structuredClone(payload); delete missing.matchState.matchPlayerColors[oldBlack];
  const missingResult = await conflicting.coordinator.acceptRoomSnapshot(missing, { allowNewScope: true });
  assert.equal(missingResult.status, "restore_failed", "an absent historical actor is rejected rather than guessed");
  for (const invalidHistory of [null, []]) {
    const malformed = structuredClone(payload);
    malformed.players = [{ playerId: oldBlack, color: "BLACK" }, { playerId: white, color: "WHITE" }];
    malformed.matchState.matchPlayerColors = invalidHistory;
    assert.equal((await conflicting.coordinator.acceptRoomSnapshot(malformed, { allowNewScope: true })).status, "restore_failed",
      "null and array epoch maps cannot fall back to a complete live roster");
  }
  const changedCurrentRoster = structuredClone(payload);
  changedCurrentRoster.players = [{ playerId: "replacement-black", color: "BLACK" }, { playerId: oldBlack, color: "WHITE" }];
  assert.equal((await conflicting.coordinator.acceptRoomSnapshot(changedCurrentRoster, { allowNewScope: true })).status, "committed",
    "correct epoch identity remains authoritative when a current roster color differs");
  assert.deepEqual([...conflicting.coordinator._playerColorById], [["replacement-black", "BLACK"], [oldBlack, "WHITE"]],
    "live identity cache follows the current replacement roster while history remains epoch-scoped");
  const rotated = structuredClone(payload); rotated.matchGeneration = 2; rotated.matchEpoch = "epoch-b";
  rotated.matchState.actions = rotated.matchState.actions.map(action => ({ ...action, matchEpoch: "epoch-b" }));
  rotated.matchState.matchPlayerColors = { "replacement-black": "BLACK", [white]: "WHITE" };
  const oldEpochResult = await conflicting.coordinator.acceptRoomSnapshot(rotated, { allowNewScope: true });
  assert.equal(oldEpochResult.status, "restore_failed", "a validly scoped new epoch cannot reuse prior-epoch actor identity");
  const freshEpoch = structuredClone(rotated);
  freshEpoch.actionSeq = 0; freshEpoch.roomRevision += 1;
  freshEpoch.matchState.actions = [];
  assert.equal((await conflicting.coordinator.acceptRoomSnapshot(freshEpoch, { allowNewScope: true })).status, "committed",
    "a valid new epoch with empty history is accepted");
  conflicting.coordinator.dispose();

  const legacy = realHarness(); await legacy.coordinator.start();
  const oldPayload = structuredClone(payload); delete oldPayload.matchState.matchPlayerColors;
  oldPayload.players = [{ playerId: oldBlack, color: "BLACK" }, { playerId: white, color: "WHITE" }];
  const legacyResult = await legacy.coordinator.acceptRoomSnapshot(oldPayload, { allowNewScope: true });
  assert.equal(legacyResult.status, "committed", "older snapshots with a full current roster remain compatible");
  legacy.coordinator.dispose();
}
{
  const h = harness();
  await h.coordinator.start();
  let requests = 0;
  h.sync.prepareSnapshot = () => ({ status: "defer", reason: "snapshot_omits_optimistic_action" });
  h.sync.prepareSyncRequest = () => ({ status: "ready", token: "sync-token", request: {} });
  h.sync.prepareSyncResponse = () => ({ status: "ready", token: "snapshot-token" });
  h.manager.requestActionSync = async () => {
    requests += 1;
    return { type: "SYNC_STATE", serverInstanceId: "server-a", roomInstanceId: "room-a", matchGeneration: 1,
      matchEpoch: "epoch-a", actionSeq: 0, matchState: { settings: {}, actions: [] } };
  };
  const result = await h.coordinator.acceptRoomSnapshot({ type: "ROOM_STATE" });
  assert.equal(result.status, "committed");
  assert.equal(requests, 1);
  h.coordinator.dispose();
}
{
  const h = harness();
  await h.coordinator.start();
  let requests = 0;
  h.sync.getState = () => ({ protocol: { status: "selected", version: 1, serverInstanceId: "server-a" },
    scope: { serverInstanceId: "server-a", roomInstanceId: "room-a", matchGeneration: 1, matchEpoch: "epoch-a" },
    pending: [{ clientActionId: "id-a", playerId: "alice", scope: { serverInstanceId: "server-a", roomInstanceId: "room-a",
      matchGeneration: 1, matchEpoch: "epoch-a" }, status: "uncertain" }], recoveryRequired: true });
  h.sync.prepareSyncRequest = () => ({ status: "ready", token: "capacity-sync", request: {} });
  h.sync.prepareSyncResponse = () => ({ status: "invalid", reason: "probe" });
  h.sync.failSyncRequest = () => true;
  h.manager.requestActionSync = async () => { requests += 1; return {}; };
  const control = { type: "ACTION_NOT_PROCESSED", processed: false, reason: "OUTCOME_CAPACITY", actionProtocolVersion: 1,
    serverInstanceId: "server-a", roomInstanceId: "room-a", matchGeneration: 1, matchEpoch: "epoch-a",
    clientActionId: "id-a", playerId: "alice" };
  const context = { generation: h.coordinator.generation, manager: h.manager, socket: h.manager.socket };
  assert.equal((await h.coordinator.handleCapacityControl({ ...control, playerId: "mallory" }, context)).status, "ignored");
  assert.equal(requests, 0, "a mismatched owner cannot trigger ledger sync");
  await h.coordinator.handleCapacityControl(control, context);
  assert.equal(requests, 1, "a matching capacity control triggers one immediate ledger sync");
  assert.equal(h.sync.getState().pending.length, 1, "the control does not resolve or clear pending");
  assert.equal((await h.coordinator.handleCapacityControl(control, context)).status, "duplicate");
  assert.equal(requests, 1, "duplicate controls cannot create repeated sync requests");
  h.coordinator.dispose();
}
{
  const sync = new OnlineActionSync({ createActionId: () => "old-epoch-action" });
  sync.setProtocol({ status: "selected", version: 1, serverInstanceId: "server-a" });
  const initial = { type: "ROOM_STATE", actionProtocolVersion: 1, serverInstanceId: "server-a", roomInstanceId: "room-a",
    matchGeneration: 1, matchEpoch: "epoch-a", actionSeq: 0, roomRevision: 1, yourPlayerId: "alice",
    matchState: { settings: {}, actions: [] } };
  const initialPlan = sync.prepareSnapshot(initial, { allowNewScope: true });
  assert.equal(initialPlan.status, "ready");
  sync.commitSnapshot(initialPlan.token, { restoreSucceeded: true });

  const timers = new Map(); let timerId = 0; let sends = 0; let syncCalls = 0; let actionSending = null;
  const listeners = new Map();
  const manager = { socket: {}, isConnected() { return true; }, on(name, callback) {
    const list = listeners.get(name) ?? []; list.push(callback); listeners.set(name, list);
    return () => listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== callback));
  }, async negotiateActionProtocol() { return { status: "selected", version: 1, serverInstanceId: "server-a" }; },
  async sendVersionedAction() { sends += 1; }, async requestActionSync() {
    syncCalls += 1;
    const oldEpoch = syncCalls === 1;
    const scope = { actionProtocolVersion: 1, serverInstanceId: "server-a", roomInstanceId: "room-a",
      matchGeneration: oldEpoch ? 1 : 2, matchEpoch: oldEpoch ? "epoch-a" : "epoch-next",
      actionSeq: 0, roomRevision: oldEpoch ? 1 : 2, yourPlayerId: "alice" };
    return { type: "SYNC_STATE", ...scope, syncRequestId: `sync-${syncCalls}`, outcomeLedgerComplete: oldEpoch,
      pendingActionOutcomes: [{ clientActionId: "old-epoch-action", status: oldEpoch ? "notSeen" : "unknownEpoch" }],
      actionOutcomeCapacity: { serverInstanceId: "server-a", roomInstanceId: "room-a", matchGeneration: scope.matchGeneration,
        matchEpoch: scope.matchEpoch, blocked: true, count: 1, serializedBytes: 10, maxEntries: 1, maxSerializedBytes: 1024 },
      matchState: { settings: {}, actions: [], roomRevision: scope.roomRevision } };
  } };
  const controller = { bindOnlineActionSync({ onActionSending: callback }) { actionSending = callback; return { status: "bound" }; },
    prepareMatchState() { return { success: true, token: "prepared-state" }; }, installPreparedMatchState() { return { success: true }; },
    rollbackPreparedMatchState() {}, abortPreparedMatchState() {},
    publishPreparedMatchState() { return { success: true, state: {} }; }, setAuthoritativeSnapshotValid() {} };
  const coordinator = new OnlineActionSyncCoordinator({ sync, controller, getNetworkManager: () => manager, playerId: "alice",
    retryDelays: [1, 2], ackTimeoutMs: 100, setTimeoutFn: callback => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeoutFn: id => timers.delete(id) });
  await coordinator.start();
  const reserved = sync.beginAction({ type: "player_skip", playerId: "alice", actorColor: "BLACK" });
  assert.equal(reserved.status, "reserved");
  actionSending({ clientActionId: reserved.clientActionId, action: reserved.action, manager });
  sync.markSent(reserved.clientActionId);
  await manager.sendVersionedAction(reserved.action);
  const control = { type: "ACTION_NOT_PROCESSED", processed: false, reason: "OUTCOME_CAPACITY", actionProtocolVersion: 1,
    serverInstanceId: "server-a", roomInstanceId: "room-a", matchGeneration: 1, matchEpoch: "epoch-a",
    clientActionId: "old-epoch-action", playerId: "alice" };
  for (const listener of listeners.get("ACTION_NOT_PROCESSED") ?? []) listener(control);
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) { await Promise.resolve(); const running = coordinator._syncPromise; if (running) await running; }
  };
  await settle();
  assert.equal(sync.getState().pending[0].status, "capacityBlocked", "same-epoch notSeen settles into the capacity hold");
  await coordinator.requestSync();
  await settle();
  let callbacks = 0;
  while (timers.size) {
    if (++callbacks > 8) throw new Error("virtual recovery callback limit exceeded");
    const [id, callback] = timers.entries().next().value;
    timers.delete(id); callback(); await settle();
  }
  const state = sync.getState();
  assert.equal(syncCalls, 4, "the old pending action receives only the configured bounded recovery queries");
  assert.equal(sends, 1, "no retry resends the old action");
  assert.equal(state.pending.length, 1, "the new-epoch capacity fact does not clear old pending");
  assert.equal(state.pending[0].scope.matchEpoch, "epoch-a");
  assert.equal(state.pending[0].status, "uncertain");
  assert.equal(state.scope.matchEpoch, "epoch-next");
  assert.equal(state.capacityBlocked, true);
  assert.equal(state.capacityRecoveryReady, false, "an uncertain old-epoch pending action blocks capacity recovery readiness");
  assert.equal(state.locked, true);
  assert.equal(timers.size, 0, "the finite recovery budget ends with no timer");
  coordinator.dispose();
}
{
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const scheduled = new Map();
  const cleared = [];
  let nextTimer = 0;
  globalThis.setTimeout = function (callback, delay) {
    if (this !== globalThis) throw new TypeError("Illegal invocation: setTimeout receiver must be globalThis");
    const id = ++nextTimer;
    scheduled.set(id, { callback, delay });
    return id;
  };
  globalThis.clearTimeout = function (id) {
    if (this !== globalThis) throw new TypeError("Illegal invocation: clearTimeout receiver must be globalThis");
    cleared.push(id);
    scheduled.delete(id);
  };
  try {
    // Negative control: this is the old constructor default binding shape.
    const oldBinding = harness({ timerMode: "legacy-host-binding" });
    await oldBinding.coordinator.start();
    assert.throws(() => oldBinding.coordinator._onActionSending({ clientActionId: "id-a", action: {}, manager: oldBinding.manager }),
      /Illegal invocation: setTimeout receiver must be globalThis/,
      "the former raw host-method default fails when called as an instance method");
    oldBinding.coordinator.dispose();

    const current = harness({ timerMode: "host-default" });
    await current.coordinator.start();
    current.coordinator._onActionSending({ clientActionId: "id-a", action: {}, manager: current.manager });
    current.coordinator._actionAttempts.set("id-a", 1);
    current.sync.getState = () => ({ protocol: { status: "selected" }, scope: {}, pending: [{ status: "retryable" }] });
    current.coordinator._scheduleActionRetry("id-a", current.coordinator.generation, current.manager);
    current.coordinator._scheduleSyncRetry(current.coordinator.generation, current.manager, "fixture_retry");
    assert.equal(current.coordinator._ackTimers.size, 1, "ACK timeout uses the host timer safely");
    assert.equal(current.coordinator._retryTimers.size, 1, "action retry uses the host timer safely");
    assert.equal(current.coordinator._syncRetryTimers.size, 1, "sync retry uses the host timer safely");
    assert.deepEqual([...scheduled.values()].map(({ delay }) => delay), [5000, 250, 250]);
    current.coordinator.dispose();
    assert.equal(cleared.length, 3, "cleanup clears ACK, action retry and sync retry timers with the host receiver");
    assert.equal(scheduled.size, 0);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}
// The retained v1 schema cannot represent canonical vertices or root actions.
// Shared authoritative rooms do not bind this legacy ledger.
{
  const controller = realController();
  controller.multiplayerEnabled = true;
  controller._onlineActionSync = { getState: () => ({ protocol: {status:"selected"}, pending:[], scope:{} }) };
  controller._onlineActionPlayerId = "alice";
  let sent = 0; controller.networkManager = {sendRootAction: async () => { sent++; }};
  const before = JSON.stringify(controller.engine.getSnapshot());
  const root = await controller.requestRootAction("add", [1,0]);
  assert.equal(root.reason, "ACTION_PROTOCOL_UNSUPPORTED");
  assert.equal(sent, 0); assert.equal(JSON.stringify(controller.engine.getSnapshot()), before);
  Object.defineProperty(controller.engine, "isTopologyBoard", { value:true });
  assert.equal(controller._getOnlineActionLockReason(), "ACTION_PROTOCOL_UNSUPPORTED");
}
console.log("verify-online-action-coordinator: PASS");
