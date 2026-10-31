import assert from "node:assert/strict";
import fs from "node:fs/promises";

const source = await fs.readFile(new URL("../OnlineActionSync.js", import.meta.url), "utf8");
const { OnlineActionSync } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
let idCounter = 0;
const nextId = () => `action-${++idCounter}`;
const action = (type, playerId, color, seq, epoch = "epoch-a", clientActionId = null, point = null) => ({
  type, playerId, color, actionSeq: seq, matchEpoch: epoch, clientActionId,
  ...(type === "player_move" ? { point } : {}),
});
function snapshot(overrides = {}) {
  const data = { type: "ROOM_STATE", actionProtocolVersion: 1, serverInstanceId: "server-a",
    roomInstanceId: "room-a", matchGeneration: 1, matchEpoch: "epoch-a", actionSeq: 0, roomRevision: 1,
    yourPlayerId: "alice", matchState: { settings: {}, actions: [], actionProtocolVersion: 1, roomRevision: 1 } };
  Object.assign(data, overrides);
  data.matchState = { ...data.matchState, roomRevision: data.roomRevision };
  return data;
}
function harness() {
  const client = new OnlineActionSync({ createActionId: nextId });
  client.setProtocol({ status: "selected", version: 1, serverInstanceId: "server-a" });
  const plan = client.prepareSnapshot(snapshot(), { allowNewScope: true });
  assert.equal(plan.status, "ready");
  assert.equal(client.commitSnapshot(plan.token, { restoreSucceeded: true }).status, "committed");
  return client;
}
function loggedEvent({ seq, who = "bob", color = "WHITE", id = null, type = "player_skip", point = null, epoch = "epoch-a", room = "room-a", generation = 1, extra = {} }) {
  return { type: "ACTION_LOGGED", actionProtocolVersion: 1, serverInstanceId: "server-a", roomInstanceId: room,
    matchGeneration: generation, matchEpoch: epoch, actionSeq: seq, roomRevision: seq + 1, clientActionId: id,
    action: { type, playerId: who, color, ...(type === "player_move" ? { point } : {}) }, ...extra };
}

// Reservations are single-slot, and a prepared action event holds the lock through controller callbacks.
const sync = harness();
const reservation = sync.beginAction({ type: "player_move", point: [2, 3], playerId: "alice" });
assert.equal(reservation.status, "reserved");
assert.equal(sync.beginAction({ type: "player_skip", playerId: "alice" }).status, "locked");
assert.equal(sync.markOptimisticApplied(reservation.clientActionId), true);
const localAck = loggedEvent({ seq: 1, who: "alice", color: "BLACK", id: reservation.clientActionId, type: "player_move", point: [2, 3] });
const localPlan = sync.prepareActionEvent(localAck);
assert.equal(localPlan.status, "prepared");
assert.equal(sync.beginAction({ type: "player_skip", playerId: "alice" }).status, "locked");
assert.equal(sync.commitActionEvent(localPlan.token).status, "confirmed");
assert.equal(sync.prepareActionEvent(localAck).status, "duplicate");

// Unmatched records must belong to the current full scope; gaps and malformed current events lock input.
const scopeSync = harness();
assert.equal(scopeSync.prepareActionEvent(loggedEvent({ seq: 1, room: "room-other" })).status, "ignore");
assert.equal(scopeSync.prepareActionEvent(loggedEvent({ seq: 1, epoch: "epoch-old" })).status, "ignore");
assert.equal(scopeSync.prepareActionEvent(loggedEvent({ seq: 3 })).reason, "action_sequence_gap");
assert.equal(scopeSync.isLocked(), true);
assert.equal(scopeSync.beginAction({ type: "player_skip", playerId: "alice" }).status, "locked");
const recover = scopeSync.prepareSnapshot(snapshot());
assert.equal(recover.status, "ready");
assert.equal(scopeSync.commitSnapshot(recover.token, { restoreSucceeded: true }).locked, false);

// An identical action ID from another actor is not a duplicate.
const idReuse = harness();
const first = loggedEvent({ seq: 1, who: "bob", id: "shared-id" });
const firstPlan = idReuse.prepareActionEvent(first);
assert.equal(firstPlan.status, "prepared");
assert.equal(idReuse.commitActionEvent(firstPlan.token, { applied: true }).status, "applied");
const sameIdOtherActor = loggedEvent({ seq: 2, who: "alice", color: "BLACK", id: "shared-id" });
const reusedPlan = idReuse.prepareActionEvent(sameIdOtherActor);
assert.equal(reusedPlan.status, "prepared");
assert.equal(idReuse.commitActionEvent(reusedPlan.token, { applied: true }).status, "applied");

// A remote event cannot stack over an optimistic local action with the same base watermark.
const optimistic = harness();
const local = optimistic.beginAction({ type: "player_move", point: [1, 2], playerId: "alice" });
optimistic.markOptimisticApplied(local.clientActionId);
assert.equal(optimistic.prepareActionEvent(loggedEvent({ seq: 1 })).reason, "concurrent_action_during_optimistic_pending");
assert.equal(optimistic.beginAction({ type: "player_skip", playerId: "alice" }).status, "locked");

// Pending snapshot IDs are reconciled by scope, actor, content, and sequence, never by ID alone.
const otherPlayerSameId = action("player_skip", "bob", "WHITE", 1, "epoch-a", "candidate");
const crossPlayer = harness();
const crossPlayerMove = crossPlayer.beginAction({ type: "player_move", point: [2, 3], playerId: "alice" });
otherPlayerSameId.clientActionId = crossPlayerMove.clientActionId;
const otherPlayerSnapshot = crossPlayer.prepareSnapshot(snapshot({ actionSeq: 1, roomRevision: 2,
  matchState: { settings: {}, actions: [otherPlayerSameId], roomRevision: 2 } }));
assert.equal(otherPlayerSnapshot.status, "ready");
crossPlayer.commitSnapshot(otherPlayerSnapshot.token, { restoreSucceeded: true });
assert.equal(crossPlayer.getState().pending.length, 1);
assert.equal(crossPlayer.isLocked(), true);

const wrongPoint = action("player_move", "alice", "BLACK", 1, "epoch-a", "candidate", [4, 4]);
const pointMismatch = harness();
const localMove = pointMismatch.beginAction({ type: "player_move", point: [2, 3], playerId: "alice" });
wrongPoint.clientActionId = localMove.clientActionId;
const badPoint = pointMismatch.prepareSnapshot(snapshot({ actionSeq: 1, roomRevision: 2,
  matchState: { settings: {}, actions: [wrongPoint], roomRevision: 2 } }));
assert.equal(badPoint.status, "invalid");
assert.equal(pointMismatch.getState().pending.length, 1);const badRevision = harness();
const inconsistentRevision = snapshot();
inconsistentRevision.matchState.roomRevision = 99;
assert.equal(badRevision.prepareSnapshot(inconsistentRevision).reason,
  "snapshot_roomRevision_mismatch");
assert.equal(badRevision.isLocked(), true);

// Canonical duplicate-resign ACK and SYNC_STATE after a lost ACK both reconcile to the original seq 3 record.
function resignSnapshot() {
  const records = [action("player_move", "alice", "BLACK", 1, "epoch-a", "move-a", [1, 1]),
    action("player_skip", "bob", "WHITE", 2), action("player_resign", "alice", "BLACK", 3, "epoch-a", "resign-first")];
  return snapshot({ actionSeq: 3, roomRevision: 4,
    matchState: { settings: {}, actions: records, roomRevision: 4 } });
}
const resignClient = harness();
const initialResign = resignClient.prepareSnapshot(resignSnapshot());
assert.equal(initialResign.status, "ready");
resignClient.commitSnapshot(initialResign.token, { restoreSucceeded: true });
const secondResign = resignClient.beginAction({ type: "player_resign", playerId: "alice" });
const noopEvent = { ...loggedEvent({ seq: 3, who: "alice", color: "BLACK", id: secondResign.clientActionId, type: "player_resign" }),
  duplicateNoop: true, action: { type: "player_resign", playerId: "alice", color: "BLACK" } };
const noopPlan = resignClient.prepareActionEvent(noopEvent);
assert.equal(noopPlan.status, "prepared");
assert.equal(resignClient.commitActionEvent(noopPlan.token).status, "confirmed_noop");
const fakeNoop = harness();
const fakeBase = fakeNoop.prepareSnapshot(resignSnapshot());
fakeNoop.commitSnapshot(fakeBase.token, { restoreSucceeded: true });
const fakeResign = fakeNoop.beginAction({ type: "player_resign", playerId: "alice" });
assert.equal(fakeNoop.prepareActionEvent({ ...noopEvent, actionSeq: 0, clientActionId: fakeResign.clientActionId }).reason,
  "invalid_duplicate_noop");

const syncClient = harness();
const original = syncClient.prepareSnapshot(resignSnapshot());
syncClient.commitSnapshot(original.token, { restoreSucceeded: true });
const pendingResign = syncClient.beginAction({ type: "player_resign", playerId: "alice" });
syncClient.markSent(pendingResign.clientActionId);
const request = syncClient.prepareSyncRequest();
assert.equal(request.request.matchEpoch, "epoch-a");
const result = { type: "ACTION_LOGGED", actionProtocolVersion: 1, serverInstanceId: "server-a", roomInstanceId: "room-a",
  matchGeneration: 1, matchEpoch: "epoch-a", actionSeq: 3, roomRevision: 4,
  clientActionId: pendingResign.clientActionId, playerId: "alice", color: "BLACK", duplicateNoop: true,
  action: { type: "player_resign", playerId: "alice", color: "BLACK" } };
const response = syncClient.prepareSyncResponse(request.token, { ...resignSnapshot(), type: "SYNC_STATE", syncRequestId: "network-owned-id",
  pendingActionOutcomes: [{ clientActionId: pendingResign.clientActionId, status: "logged", ...result }], outcomeLedgerComplete: true });
assert.equal(response.status, "ready");
assert.equal(syncClient.commitSnapshot(response.token, { restoreSucceeded: true }).locked, false);

// A new epoch snapshot retains the uncertain old request; recovery queries that original epoch.
const oldEpoch = harness();
const oldPending = oldEpoch.beginAction({ type: "player_skip", playerId: "alice" });
oldEpoch.markSent(oldPending.clientActionId);
const reset = oldEpoch.prepareSnapshot(snapshot({ matchGeneration: 2, matchEpoch: "epoch-b", roomRevision: 2 }));
assert.equal(reset.status, "ready");
oldEpoch.commitSnapshot(reset.token, { restoreSucceeded: true });
const oldRequest = oldEpoch.prepareSyncRequest();
assert.equal(oldRequest.request.matchEpoch, "epoch-a");
assert.deepEqual(oldRequest.request.pendingActionIds, [oldPending.clientActionId]);
const afterReset = oldEpoch.prepareSyncResponse(oldRequest.token, { ...snapshot({ type: "SYNC_STATE", matchGeneration: 2,
  matchEpoch: "epoch-b", roomRevision: 2 }), syncRequestId: "network-owned-id",
  pendingActionOutcomes: [{ clientActionId: oldPending.clientActionId, status: "notSeen" }], outcomeLedgerComplete: true });
assert.equal(afterReset.status, "ready");
assert.equal(oldEpoch.commitSnapshot(afterReset.token, { restoreSucceeded: true }).locked, false);

// Failed restores, stale tokens, and contradictory outcome kinds keep the recovery gate closed.
const fail = harness();
const failedPlan = fail.prepareSnapshot(snapshot({ roomRevision: 2 }));
assert.equal(fail.commitSnapshot(failedPlan.token).status, "restore_failed");
assert.equal(fail.beginAction({ type: "player_skip", playerId: "alice" }).status, "locked");
const stale = fail.prepareActionEvent(loggedEvent({ seq: 1 }));
fail.markConnectionLost();
assert.equal(fail.commitActionEvent(stale.token, { applied: true }).status, "stale");
const contradictory = harness();
const requested = contradictory.beginAction({ type: "player_skip", playerId: "alice" });
contradictory.markSent(requested.clientActionId);
const req = contradictory.prepareSyncRequest();
const badOutcome = { type: "ACTION_REJECTED", actionProtocolVersion: 1, serverInstanceId: "server-a", roomInstanceId: "room-a",
  matchGeneration: 1, matchEpoch: "epoch-a", actionSeq: 0, clientActionId: requested.clientActionId,
  playerId: "alice", color: "BLACK", action: { type: "player_skip", playerId: "alice", color: "BLACK" } };
assert.equal(contradictory.prepareSyncResponse(req.token, { ...snapshot({ type: "SYNC_STATE" }), syncRequestId: "network-owned-id",
  pendingActionOutcomes: [{ clientActionId: requested.clientActionId, status: "logged", ...badOutcome }], outcomeLedgerComplete: true }).status, "invalid");
assert.equal(contradictory.getState().recoveryRequired, true);


// Sync logged outcomes use the actual server envelope (type and top-level ID); nested action has no ID.
const loggedSync = harness();
const localSkip = loggedSync.beginAction({ type: "player_skip", playerId: "alice" });
loggedSync.markSent(localSkip.clientActionId);
const loggedRequest = loggedSync.prepareSyncRequest();
const loggedRecord = action("player_skip", "alice", "BLACK", 1, "epoch-a", localSkip.clientActionId);
const loggedResult = { type: "ACTION_LOGGED", actionProtocolVersion: 1, serverInstanceId: "server-a", roomInstanceId: "room-a",
  matchGeneration: 1, matchEpoch: "epoch-a", actionSeq: 1, roomRevision: 2, clientActionId: localSkip.clientActionId,
  playerId: "alice", color: "BLACK", action: { type: "player_skip", playerId: "alice", color: "BLACK" } };
const loggedPrepared = loggedSync.prepareSyncResponse(loggedRequest.token, { ...snapshot({ type: "SYNC_STATE", actionSeq: 1,
  roomRevision: 2, matchState: { settings: {}, actions: [loggedRecord] } }), syncRequestId: "sync-real-id",
  pendingActionOutcomes: [{ clientActionId: localSkip.clientActionId, status: "logged", ...loggedResult }], outcomeLedgerComplete: true });
assert.equal(loggedPrepared.status, "ready");
assert.equal(loggedSync.commitSnapshot(loggedPrepared.token, { restoreSucceeded: true }).locked, false);

// Another player's history may reuse the pending ID without shadowing Alice's logged result.
const crossPlayerLogged = harness();
const aliceLoggedMove = crossPlayerLogged.beginAction({ type: "player_move", point: [2, 3], playerId: "alice" });
crossPlayerLogged.markSent(aliceLoggedMove.clientActionId);
const crossPlayerLoggedRequest = crossPlayerLogged.prepareSyncRequest();
const aliceHistory = action("player_move", "alice", "BLACK", 1, "epoch-a", aliceLoggedMove.clientActionId, [2, 3]);
const bobHistory = action("player_skip", "bob", "WHITE", 2, "epoch-a", aliceLoggedMove.clientActionId);
const aliceLoggedOutcome = { type: "ACTION_LOGGED", actionProtocolVersion: 1, serverInstanceId: "server-a", roomInstanceId: "room-a",
  matchGeneration: 1, matchEpoch: "epoch-a", actionSeq: 1, roomRevision: 3, clientActionId: aliceLoggedMove.clientActionId,
  playerId: "alice", color: "BLACK", action: { type: "player_move", playerId: "alice", color: "BLACK", point: [2, 3] } };
const crossPlayerLoggedPlan = crossPlayerLogged.prepareSyncResponse(crossPlayerLoggedRequest.token, { ...snapshot({ type: "SYNC_STATE",
  actionSeq: 2, roomRevision: 3, matchState: { settings: {}, actions: [aliceHistory, bobHistory] } }), syncRequestId: "sync-cross-player-logged",
  pendingActionOutcomes: [{ clientActionId: aliceLoggedMove.clientActionId, status: "logged", ...aliceLoggedOutcome }], outcomeLedgerComplete: true });
assert.equal(crossPlayerLoggedPlan.status, "ready");
assert.equal(crossPlayerLogged.commitSnapshot(crossPlayerLoggedPlan.token, { restoreSucceeded: true }).locked, false);
assert.equal(crossPlayerLogged.getState().pending.length, 0);

// A Bob history entry with the same ID does not contradict Alice's rejected outcome.
const crossPlayerRejected = harness();
const aliceRejectedSkip = crossPlayerRejected.beginAction({ type: "player_skip", playerId: "alice" });
crossPlayerRejected.markSent(aliceRejectedSkip.clientActionId);
const crossPlayerRejectedRequest = crossPlayerRejected.prepareSyncRequest();
const bobReusedHistory = action("player_skip", "bob", "WHITE", 1, "epoch-a", aliceRejectedSkip.clientActionId);
const aliceRejectedOutcome = { type: "ACTION_REJECTED", actionProtocolVersion: 1, serverInstanceId: "server-a", roomInstanceId: "room-a",
  matchGeneration: 1, matchEpoch: "epoch-a", actionSeq: 0, roomRevision: 2, clientActionId: aliceRejectedSkip.clientActionId,
  playerId: "alice", color: "BLACK", action: { type: "player_skip", playerId: "alice", color: "BLACK" } };
const crossPlayerRejectedPlan = crossPlayerRejected.prepareSyncResponse(crossPlayerRejectedRequest.token, { ...snapshot({ type: "SYNC_STATE",
  actionSeq: 1, roomRevision: 2, matchState: { settings: {}, actions: [bobReusedHistory] } }), syncRequestId: "sync-cross-player-rejected",
  pendingActionOutcomes: [{ clientActionId: aliceRejectedSkip.clientActionId, status: "rejected", ...aliceRejectedOutcome }], outcomeLedgerComplete: true });
assert.equal(crossPlayerRejectedPlan.status, "ready");
assert.equal(crossPlayerRejected.commitSnapshot(crossPlayerRejectedPlan.token, { restoreSucceeded: true }).locked, false);
assert.equal(crossPlayerRejected.getState().pending.length, 0);

// A validated RATE_LIMITED outcome remains typed after a successful rollback clears its pending ID.
const rateLimitedSync = harness();
const rateLimitedPending = rateLimitedSync.beginAction({ type: "player_skip", playerId: "alice" });
rateLimitedSync.markSent(rateLimitedPending.clientActionId);
const rateLimitedRequest = rateLimitedSync.prepareSyncRequest();
const rateLimitedOutcome = { type: "ACTION_REJECTED", actionProtocolVersion: 1, serverInstanceId: "server-a", roomInstanceId: "room-a",
  matchGeneration: 1, matchEpoch: "epoch-a", actionSeq: 0, roomRevision: 1, clientActionId: rateLimitedPending.clientActionId,
  playerId: "alice", color: "BLACK", code: "RATE_LIMITED", message: "server message must not reach UI",
  retryAfterMs: 250, action: { type: "player_skip", playerId: "alice", color: "BLACK" } };
const rateLimitedPlan = rateLimitedSync.prepareSyncResponse(rateLimitedRequest.token, { ...snapshot({ type: "SYNC_STATE" }),
  syncRequestId: "sync-rate-limited", pendingActionOutcomes: [{ clientActionId: rateLimitedPending.clientActionId,
    status: "rejected", ...rateLimitedOutcome }], outcomeLedgerComplete: true });
assert.equal(rateLimitedPlan.status, "ready");
const rateLimitedCommit = rateLimitedSync.commitSnapshot(rateLimitedPlan.token, { restoreSucceeded: true });
assert.equal(rateLimitedCommit.status, "committed");
assert.equal(rateLimitedSync.getState().pending.length, 0, "a rejected ID is completed and cannot be automatically retried");
assert.deepEqual(rateLimitedCommit.resolvedActionOutcome, {
  status: "rejected", code: "RATE_LIMITED", clientActionId: rateLimitedPending.clientActionId, playerId: "alice",
  scope: { serverInstanceId: "server-a", roomInstanceId: "room-a", matchGeneration: 1, matchEpoch: "epoch-a", actionSeq: 0, roomRevision: 1, localPlayerId: "alice" },
  submittedActionSeq: 0,
  committedScope: { serverInstanceId: "server-a", roomInstanceId: "room-a", matchGeneration: 1, matchEpoch: "epoch-a", actionSeq: 0, roomRevision: 1 },
  committedActionSeq: 0,
}, "the UI receives bounded typed rejection metadata without raw message or historical retry estimate");

// Snapshot-covered legacy events dedupe by full action sequence/content even when they have no client ID.
const legacyReplay = harness();
const oldLegacyMove = action("player_move", "bob", "WHITE", 1, "epoch-a", null, [3, 4]);
const covered = legacyReplay.prepareSnapshot(snapshot({ actionSeq: 1, roomRevision: 2,
  matchState: { settings: {}, actions: [oldLegacyMove] } }));
assert.equal(covered.status, "ready");
legacyReplay.commitSnapshot(covered.token, { restoreSucceeded: true });
assert.equal(legacyReplay.prepareActionEvent(loggedEvent({ seq: 1, who: "bob", color: "WHITE", id: null,
  type: "player_move", point: [3, 4] })).status, "duplicate");

// Late acknowledgments from a prior epoch cannot advance the new epoch's watermark.
const lateAck = harness();
const preResetPending = lateAck.beginAction({ type: "player_skip", playerId: "alice" });
lateAck.markSent(preResetPending.clientActionId);
const newerEpoch = lateAck.prepareSnapshot(snapshot({ matchGeneration: 2, matchEpoch: "epoch-b", roomRevision: 2 }));
assert.equal(newerEpoch.status, "ready");
lateAck.commitSnapshot(newerEpoch.token, { restoreSucceeded: true });
const lateEvent = { ...loggedEvent({ seq: 1, who: "alice", color: "BLACK", id: preResetPending.clientActionId }), matchGeneration: 1 };
assert.equal(lateAck.prepareActionEvent(lateEvent).status, "ignore");
assert.equal(lateAck.getState().scope.actionSeq, 0);
assert.equal(lateAck.getState().pending[0].status, "uncertain");


// Initial legacy negotiation is usable; unknown is unavailable, and an unresolved v1 action blocks downgrade.
const legacyClient = new OnlineActionSync();
legacyClient.setProtocol({ status: "legacy" });
assert.equal(legacyClient.beginAction({ type: "player_skip" }).status, "legacy");
const unknownClient = new OnlineActionSync();
unknownClient.setProtocol({ status: "unknown" });
assert.equal(unknownClient.beginAction({ type: "player_skip", playerId: "alice" }).status, "unavailable");
const downgradeClient = harness();
downgradeClient.beginAction({ type: "player_skip", playerId: "alice" });
downgradeClient.setProtocol({ status: "legacy" });
assert.equal(downgradeClient.beginAction({ type: "player_skip" }).status, "locked");

// A live accepted action is retained as normalized history for null-ID duplicates and resign no-ops.
const liveHistory = harness();
const firstResign = liveHistory.beginAction({ type: "player_resign", playerId: "alice" });
const firstResignAck = loggedEvent({ seq: 1, who: "alice", color: "BLACK", id: firstResign.clientActionId, type: "player_resign" });
const firstResignPlan = liveHistory.prepareActionEvent(firstResignAck);
assert.equal(firstResignPlan.status, "prepared");
assert.equal(liveHistory.commitActionEvent(firstResignPlan.token, { applied: true }).status, "applied");
const repeatedLegacyEvent = loggedEvent({ seq: 1, who: "alice", color: "BLACK", id: null, type: "player_resign" });
assert.equal(liveHistory.prepareActionEvent(repeatedLegacyEvent).status, "duplicate");
const liveSecondResign = liveHistory.beginAction({ type: "player_resign", playerId: "alice" });
const secondResignAck = { ...loggedEvent({ seq: 1, who: "alice", color: "BLACK", id: liveSecondResign.clientActionId, type: "player_resign" }), duplicateNoop: true };
const secondResignPlan = liveHistory.prepareActionEvent(secondResignAck);
assert.equal(secondResignPlan.status, "prepared");
assert.equal(liveHistory.commitActionEvent(secondResignPlan.token).status, "confirmed_noop");

// Recovery stays locked until a successfully restored snapshot.
const recoveryGate = harness();
assert.equal(recoveryGate.prepareActionEvent(loggedEvent({ seq: 3 })).status, "needsSync");
assert.equal(recoveryGate.prepareActionEvent(loggedEvent({ seq: 1 })).status, "needsSync");
assert.equal(recoveryGate.isLocked(), true);

// A duplicate-resign outcome from an older epoch is checked against the retained original record.
const oldNoop = harness();
const oldResignBase = oldNoop.prepareSnapshot(resignSnapshot());
oldNoop.commitSnapshot(oldResignBase.token, { restoreSucceeded: true });
const oldNoopPending = oldNoop.beginAction({ type: "player_resign", playerId: "alice" });
oldNoop.markSent(oldNoopPending.clientActionId);
const newMatch = oldNoop.prepareSnapshot(snapshot({ matchGeneration: 2, matchEpoch: "epoch-b", roomRevision: 5 }));
assert.equal(newMatch.status, "ready");
oldNoop.commitSnapshot(newMatch.token, { restoreSucceeded: true });
const oldNoopRequest = oldNoop.prepareSyncRequest();
assert.equal(oldNoopRequest.request.matchEpoch, "epoch-a");
const oldNoopResult = { type: "ACTION_LOGGED", actionProtocolVersion: 1, serverInstanceId: "server-a", roomInstanceId: "room-a",
  matchGeneration: 1, matchEpoch: "epoch-a", actionSeq: 3, roomRevision: 4, clientActionId: oldNoopPending.clientActionId,
  playerId: "alice", color: "BLACK", duplicateNoop: true,
  action: { type: "player_resign", playerId: "alice", color: "BLACK" } };
const oldNoopResponse = oldNoop.prepareSyncResponse(oldNoopRequest.token, { ...snapshot({ type: "SYNC_STATE",
  matchGeneration: 2, matchEpoch: "epoch-b", roomRevision: 5 }), syncRequestId: "sync-old-noop",
  pendingActionOutcomes: [{ clientActionId: oldNoopPending.clientActionId, status: "logged", ...oldNoopResult }], outcomeLedgerComplete: true });
assert.equal(oldNoopResponse.status, "ready");
assert.equal(oldNoop.commitSnapshot(oldNoopResponse.token, { restoreSucceeded: true }).scope.actionSeq, 0);
assert.equal(oldNoop.isLocked(), false);

// Sync request cancellation is token-owned, keeps recovery locked, and permits a retry.
const failedRequestClient = harness();
const failedRequest = failedRequestClient.prepareSyncRequest();
assert.equal(failedRequestClient.failSyncRequest(failedRequest.token), true);
assert.equal(failedRequestClient.getState().recoveryRequired, true);
assert.equal(failedRequestClient.beginAction({ type: "player_skip", playerId: "alice" }).status, "locked");
const retriedRequest = failedRequestClient.prepareSyncRequest();
assert.equal(retriedRequest.status, "ready");
assert.equal(failedRequestClient.failSyncRequest(failedRequest.token), false);
assert.equal(failedRequestClient.prepareSyncRequest().status, "locked");
const retriedSnapshot = failedRequestClient.prepareSyncResponse(retriedRequest.token, { ...snapshot({ type: "SYNC_STATE" }),
  syncRequestId: "sync-retried", pendingActionOutcomes: [], outcomeLedgerComplete: true });
assert.equal(retriedSnapshot.status, "ready");
assert.equal(failedRequestClient.commitSnapshot(retriedSnapshot.token, { restoreSucceeded: true }).locked, false);

// A complete notSeen ledger plus a same-scope capacity marker keeps the room blocked without retrying the action.
const capacitySync = harness();
const capacityAction = capacitySync.beginAction({ type: "player_skip", playerId: "alice", actorColor: "BLACK" });
assert.equal(capacitySync.markSent(capacityAction.clientActionId), true);
const capacityRequest = capacitySync.prepareSyncRequest();
const capacityResponse = capacitySync.prepareSyncResponse(capacityRequest.token, {
  ...snapshot({ type: "SYNC_STATE" }), syncRequestId: "network-owned-id", outcomeLedgerComplete: true,
  pendingActionOutcomes: [{ clientActionId: capacityAction.clientActionId, status: "notSeen" }],
  actionOutcomeCapacity: { serverInstanceId: "server-a", roomInstanceId: "room-a", matchGeneration: 1,
    matchEpoch: "epoch-a", blocked: true, count: 1, serializedBytes: 10, maxEntries: 1, maxSerializedBytes: 1024 },
});
assert.equal(capacityResponse.status, "ready");
const capacityCommit = capacitySync.commitSnapshot(capacityResponse.token, { restoreSucceeded: true, deferFinalize: true });
assert.equal(capacitySync.getState().pending.length, 1, "pending must survive until controller publish and metadata commit");
assert.equal(capacitySync.finalizeSnapshot(capacityCommit.finalizeToken).status, "committed");
assert.equal(capacitySync.getState().pending.length, 1, "capacity reconciliation preserves the original pending action");
assert.equal(capacitySync.getState().pending[0].status, "capacityBlocked");
assert.equal(capacitySync.getState().capacityBlocked, true);
assert.equal(capacitySync.getState().capacityRecoveryReady, false, "finalization alone is not the complete UI recovery signal");
assert.equal(capacitySync.completeCapacityRecovery(), true, "same-scope capacity-blocked pending action permits finalized readiness");
assert.equal(capacitySync.getState().capacityRecoveryReady, true);
assert.equal(capacitySync.beginAction({ type: "player_skip", playerId: "alice" }).reason, "ACTION_OUTCOME_CAPACITY");
const repeatedRoomState = capacitySync.prepareSnapshot(snapshot());
assert.equal(repeatedRoomState.status, "ready");
assert.equal(capacitySync.getState().capacityRecoveryReady, false, "a later same-scope snapshot immediately revokes old readiness");
assert.equal(repeatedRoomState.deferFinalize, true, "same-scope room snapshots defer while a capacity latch is active");
const repeatedCommit = capacitySync.commitSnapshot(repeatedRoomState.token, { restoreSucceeded: true, deferFinalize: true });
assert.equal(capacitySync.finalizeSnapshot(repeatedCommit.finalizeToken).status, "committed");
assert.equal(capacitySync.getState().capacityBlocked, true, "same-scope snapshots cannot clear a confirmed capacity block");

const readyNoPendingSync = harness();
const readyNoPendingRequest = readyNoPendingSync.prepareSyncRequest();
const readyNoPendingPrepared = readyNoPendingSync.prepareSyncResponse(readyNoPendingRequest.token, {
  ...snapshot({ type: "SYNC_STATE" }), syncRequestId: "network-owned-id", outcomeLedgerComplete: true,
  pendingActionOutcomes: [],
  actionOutcomeCapacity: { serverInstanceId: "server-a", roomInstanceId: "room-a", matchGeneration: 1,
    matchEpoch: "epoch-a", blocked: true, count: 1, serializedBytes: 10, maxEntries: 1, maxSerializedBytes: 1024 },
});
const readyNoPendingStage = readyNoPendingSync.commitSnapshot(readyNoPendingPrepared.token, { restoreSucceeded: true, deferFinalize: true });
assert.equal(readyNoPendingSync.getState().capacityRecoveryReady, false, "staged snapshots cannot report recovery success");
assert.equal(readyNoPendingSync.finalizeSnapshot(readyNoPendingStage.finalizeToken).status, "committed");
assert.equal(readyNoPendingSync.getState().capacityRecoveryReady, false, "ledger finalize awaits Controller/UI publication acknowledgement");
assert.equal(readyNoPendingSync.completeCapacityRecovery(), true, "a complete no-pending recovery may become ready");
assert.equal(readyNoPendingSync.getState().capacityRecoveryReady, true);
const readinessRecheck = readyNoPendingSync.prepareSyncRequest();
assert.equal(readinessRecheck.status, "ready");
assert.equal(readyNoPendingSync.getState().capacityRecoveryReady, false, "starting a same-scope recheck revokes prior readiness");
readyNoPendingSync.markConnectionLost();
assert.equal(readyNoPendingSync.getState().capacityRecoveryReady, false, "connection loss clears finalized readiness");
assert.equal(readyNoPendingSync.getState().capacityBlocked, true, "connection loss preserves a previously confirmed capacity fact");
readyNoPendingSync.setProtocol({ status: "selected", version: 1, serverInstanceId: "server-a" });
assert.equal(readyNoPendingSync.getState().capacityRecoveryReady, false, "renegotiation does not resurrect an old readiness grant");

const wrongCapacitySync = harness();
const wrongCapacityAction = wrongCapacitySync.beginAction({ type: "player_skip", playerId: "alice", actorColor: "BLACK" });
const wrongCapacityRequest = wrongCapacitySync.prepareSyncRequest();
const wrongCapacityResponse = wrongCapacitySync.prepareSyncResponse(wrongCapacityRequest.token, {
  ...snapshot({ type: "SYNC_STATE" }), syncRequestId: "network-owned-id", outcomeLedgerComplete: true,
  pendingActionOutcomes: [{ clientActionId: wrongCapacityAction.clientActionId, status: "notSeen" }],
  actionOutcomeCapacity: { serverInstanceId: "server-a", roomInstanceId: "other-room", matchGeneration: 1,
    matchEpoch: "epoch-a", blocked: true, count: 1, serializedBytes: 10, maxEntries: 1, maxSerializedBytes: 1024 },
});
assert.equal(wrongCapacityResponse.status, "invalid", "a wrong-scope marker fails closed instead of allowing notSeen retry");
assert.equal(wrongCapacitySync.getState().pending.length, 1);
assert.equal(wrongCapacitySync.getState().pending[0].status, "uncertain");

const staleFinalizeSync = harness();
const staleAction = staleFinalizeSync.beginAction({ type: "player_skip", playerId: "alice", actorColor: "BLACK" });
const staleRequest = staleFinalizeSync.prepareSyncRequest();
const stalePrepared = staleFinalizeSync.prepareSyncResponse(staleRequest.token, {
  ...snapshot({ type: "SYNC_STATE" }), syncRequestId: "network-owned-id", outcomeLedgerComplete: true,
  pendingActionOutcomes: [{ clientActionId: staleAction.clientActionId, status: "notSeen" }],
  actionOutcomeCapacity: { serverInstanceId: "server-a", roomInstanceId: "room-a", matchGeneration: 1,
    matchEpoch: "epoch-a", blocked: true, count: 1, serializedBytes: 10, maxEntries: 1, maxSerializedBytes: 1024 },
});
const staleStage = staleFinalizeSync.commitSnapshot(stalePrepared.token, { restoreSucceeded: true, deferFinalize: true });
staleFinalizeSync.markConnectionLost();
assert.equal(staleFinalizeSync.finalizeSnapshot(staleStage.finalizeToken).status, "stale");
assert.equal(staleFinalizeSync._committedSnapshot, null, "a stale finalize candidate is discarded rather than leaving a permanent staged lock");
assert.equal(staleFinalizeSync.getState().pending.length, 1);
assert.equal(staleFinalizeSync.getState().recoveryRequired, true, "stale finalization fails closed with pending retained");
staleFinalizeSync.setProtocol({ status: "selected", version: 1, serverInstanceId: "server-a" });
const laterRequest = staleFinalizeSync.prepareSyncRequest();
const laterAction = action("player_skip", "alice", "BLACK", 1, "epoch-a", staleAction.clientActionId);
const laterPrepared = staleFinalizeSync.prepareSyncResponse(laterRequest.token, {
  ...snapshot({ type: "SYNC_STATE", actionSeq: 1, roomRevision: 2,
    matchState: { settings: {}, actions: [laterAction], roomRevision: 2 } }),
  syncRequestId: "network-owned-id", outcomeLedgerComplete: true,
  pendingActionOutcomes: [{ type: "ACTION_LOGGED", clientActionId: staleAction.clientActionId, status: "logged", actionProtocolVersion: 1,
    serverInstanceId: "server-a", roomInstanceId: "room-a", matchGeneration: 1, matchEpoch: "epoch-a",
    playerId: "alice", actionSeq: 1, action: laterAction }],
});
assert.equal(laterPrepared.status, "ready");
assert.equal(laterPrepared.deferFinalize, false, "an abandoned first capacity marker is not confirmed before finalize");
assert.equal(staleFinalizeSync.commitSnapshot(laterPrepared.token, { restoreSucceeded: true }).status, "committed");
assert.equal(staleFinalizeSync.getState().pending.length, 0);
assert.equal(staleFinalizeSync.getState().locked, false, "a later valid restore clears the abandoned staging lock");
assert.equal(staleFinalizeSync.getState().capacityBlocked, false, "an unfinalized first marker never becomes a capacity fact");
assert.equal(staleFinalizeSync.completeCapacityRecovery(), false);

const metadataNoPendingSync = harness();
const emptyCapacityRequest = metadataNoPendingSync.prepareSyncRequest();
const emptyCapacityPrepared = metadataNoPendingSync.prepareSyncResponse(emptyCapacityRequest.token, {
  ...snapshot({ type: "SYNC_STATE" }), syncRequestId: "network-owned-id", outcomeLedgerComplete: true,
  pendingActionOutcomes: [],
  actionOutcomeCapacity: { serverInstanceId: "server-a", roomInstanceId: "room-a", matchGeneration: 1,
    matchEpoch: "epoch-a", blocked: true, count: 1, serializedBytes: 10, maxEntries: 1, maxSerializedBytes: 1024 },
});
const emptyCapacityStage = metadataNoPendingSync.commitSnapshot(emptyCapacityPrepared.token, { restoreSucceeded: true, deferFinalize: true });
metadataNoPendingSync.markConnectionLost(); // Stand-in for publish/metadata invalidating the candidate revision.
assert.equal(metadataNoPendingSync.getState().locked, true);
metadataNoPendingSync.setProtocol({ status: "selected", version: 1, serverInstanceId: "server-a" });
const emptyRecoveryRequest = metadataNoPendingSync.prepareSyncRequest();
const emptyRecoveryPrepared = metadataNoPendingSync.prepareSyncResponse(emptyRecoveryRequest.token, {
  ...snapshot({ type: "SYNC_STATE" }), syncRequestId: "network-owned-id", outcomeLedgerComplete: true, pendingActionOutcomes: [],
});
assert.equal(emptyRecoveryPrepared.deferFinalize, false, "failed metadata does not confirm a first capacity marker");
assert.equal(metadataNoPendingSync.commitSnapshot(emptyRecoveryPrepared.token, { restoreSucceeded: true }).status, "committed");
assert.equal(metadataNoPendingSync._committedSnapshot, null);
assert.equal(metadataNoPendingSync.getState().locked, false, "the later complete restore clears the staging lock");
assert.equal(metadataNoPendingSync.getState().capacityBlocked, false, "a failed first capacity transaction leaves no confirmed capacity fact");

const metadataPendingSync = harness();
const metadataAction = metadataPendingSync.beginAction({ type: "player_skip", playerId: "alice", actorColor: "BLACK" });
const metadataCapacityRequest = metadataPendingSync.prepareSyncRequest();
const metadataCapacityPrepared = metadataPendingSync.prepareSyncResponse(metadataCapacityRequest.token, {
  ...snapshot({ type: "SYNC_STATE" }), syncRequestId: "network-owned-id", outcomeLedgerComplete: true,
  pendingActionOutcomes: [{ clientActionId: metadataAction.clientActionId, status: "notSeen" }],
  actionOutcomeCapacity: { serverInstanceId: "server-a", roomInstanceId: "room-a", matchGeneration: 1,
    matchEpoch: "epoch-a", blocked: true, count: 1, serializedBytes: 10, maxEntries: 1, maxSerializedBytes: 1024 },
});
metadataPendingSync.commitSnapshot(metadataCapacityPrepared.token, { restoreSucceeded: true, deferFinalize: true });
metadataPendingSync.markConnectionLost(); // The candidate is abandoned without calling finalizeSnapshot.
assert.equal(metadataPendingSync.getState().pending.length, 1);
metadataPendingSync.setProtocol({ status: "selected", version: 1, serverInstanceId: "server-a" });
const metadataRecoveryRequest = metadataPendingSync.prepareSyncRequest();
const metadataLoggedAction = action("player_skip", "alice", "BLACK", 1, "epoch-a", metadataAction.clientActionId);
const metadataRecoveryPrepared = metadataPendingSync.prepareSyncResponse(metadataRecoveryRequest.token, {
  ...snapshot({ type: "SYNC_STATE", actionSeq: 1, roomRevision: 2,
    matchState: { settings: {}, actions: [metadataLoggedAction], roomRevision: 2 } }),
  syncRequestId: "network-owned-id", outcomeLedgerComplete: true,
  pendingActionOutcomes: [{ type: "ACTION_LOGGED", clientActionId: metadataAction.clientActionId, status: "logged",
    actionProtocolVersion: 1, serverInstanceId: "server-a", roomInstanceId: "room-a", matchGeneration: 1,
    matchEpoch: "epoch-a", playerId: "alice", actionSeq: 1, action: metadataLoggedAction }],
});
assert.equal(metadataRecoveryPrepared.deferFinalize, false, "a failed first capacity transaction leaves no sticky latch");
assert.equal(metadataPendingSync.commitSnapshot(metadataRecoveryPrepared.token, { restoreSucceeded: true }).status, "committed");
assert.equal(metadataPendingSync._committedSnapshot, null);
assert.equal(metadataPendingSync.getState().pending.length, 0, "a later valid logged outcome resolves pending after metadata failure");
assert.equal(metadataPendingSync.getState().locked, false);
assert.equal(metadataPendingSync.getState().capacityBlocked, false);

console.log("online action sync verification passed");
