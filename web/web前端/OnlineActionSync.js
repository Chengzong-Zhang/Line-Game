const ACTION_TYPES = new Set(["player_move", "player_skip", "player_resign"]);
const SNAPSHOT_TYPES = new Set(["SYNC_STATE", "ROOM_STATE", "ROOM_JOINED", "ROOM_CREATED", "MATCH_RESET", "ROOM_READY", "ROOM_COUNTDOWN"]);
const MAX_ID = 128;
const isId = value => typeof value === "string" && value.length > 0 && value.length <= MAX_ID;
const isSeq = value => Number.isInteger(value) && value >= 0;
const isPoint = value => Array.isArray(value) && value.length === 2 && value.every(Number.isInteger);
const clone = value => Array.isArray(value) ? value.map(clone) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)])) : value;
const samePoint = (a, b) => isPoint(a) && isPoint(b) && a[0] === b[0] && a[1] === b[1];
const sameScope = (a, b) => Boolean(a && b) && a.serverInstanceId === b.serverInstanceId
  && a.roomInstanceId === b.roomInstanceId && a.matchGeneration === b.matchGeneration && a.matchEpoch === b.matchEpoch;
const sameRoom = (a, b) => Boolean(a && b) && a.serverInstanceId === b.serverInstanceId && a.roomInstanceId === b.roomInstanceId;
const sameAction = (a, b) => Boolean(a && b) && a.type === b.type && a.playerId === b.playerId
  && (a.type !== "player_move" || samePoint(a.point, b.point));
const validAction = action => Boolean(action && ACTION_TYPES.has(action.type) && isId(action.playerId)
  && typeof action.color === "string" && (action.type === "player_move" ? isPoint(action.point) : action.point == null));

function snapshotError(payload) {
  if (!payload || !SNAPSHOT_TYPES.has(payload.type)) return "unsupported_snapshot_type";
  if (payload.actionProtocolVersion !== 1 || !isId(payload.serverInstanceId) || !isId(payload.roomInstanceId)
    || !isId(payload.matchEpoch) || !isSeq(payload.matchGeneration) || !isSeq(payload.actionSeq)
    || !isSeq(payload.roomRevision)) return "invalid_snapshot_scope";
  const state = payload.matchState;
  if (!state || typeof state !== "object" || !state.settings || typeof state.settings !== "object" || !Array.isArray(state.actions)) return "invalid_match_state";
  if (state.actions.length !== payload.actionSeq) return "snapshot_action_count_mismatch";
  const outer = ["serverInstanceId", "roomInstanceId", "matchGeneration", "matchEpoch", "actionSeq", "roomRevision"];
  for (const key of outer) if (state[key] !== undefined && state[key] !== payload[key]) return `snapshot_${key}_mismatch`;
  if (state.actionProtocolVersion !== undefined && state.actionProtocolVersion !== 1) return "invalid_match_state_protocol_version";
  for (let i = 0; i < state.actions.length; i += 1) {
    const action = state.actions[i];
    if (!validAction(action) || action.actionSeq !== i + 1 || action.matchEpoch !== payload.matchEpoch
      || !(action.clientActionId == null || isId(action.clientActionId))) return `invalid_snapshot_action_${i + 1}`;
  }
  return null;
}

function snapshotActionMatches(record, action, scope) {
  return Boolean(record && action && sameScope(record.scope, scope) && action.matchEpoch === scope.matchEpoch
    && action.actionSeq === record.wireAction.baseActionSeq + 1 && action.clientActionId === record.wireAction.clientActionId
    && action.playerId === record.playerId && (record.actorColor == null || action.color === record.actorColor) && sameAction(action, { ...record.wireAction, playerId: record.playerId }));
}

function findOwnedSnapshotAction(record, actions, snapshotScope) {
  if (!record || !sameScope(record.scope, snapshotScope)) return null;
  return actions.find(action => action.matchEpoch === record.scope.matchEpoch
    && action.clientActionId === record.wireAction.clientActionId && action.playerId === record.playerId) ?? null;
}

function validOutcome(outcome, record, requestScope, actions, snapshotScope) {
  if (!record || outcome.clientActionId !== record.wireAction.clientActionId || outcome.actionProtocolVersion !== 1
    || outcome.serverInstanceId !== requestScope.serverInstanceId || outcome.roomInstanceId !== requestScope.roomInstanceId
    || outcome.matchGeneration !== requestScope.matchGeneration || outcome.matchEpoch !== requestScope.matchEpoch
    || outcome.playerId !== record.playerId || !isSeq(outcome.actionSeq)) return false;
  if (outcome.status === "rejected") {
    if (outcome.type !== "ACTION_REJECTED" || outcome.duplicateNoop === true) return false;
    return outcome.action === undefined || (validAction(outcome.action) && outcome.action.playerId === record.playerId
      && outcome.action.type === record.wireAction.type
      && (outcome.action.type !== "player_move" || samePoint(outcome.action.point, record.wireAction.point)));
  }
  if (outcome.status !== "logged" || outcome.type !== "ACTION_LOGGED" || !validAction(outcome.action)
    || outcome.action.playerId !== record.playerId || outcome.action.type !== record.wireAction.type
    || (outcome.action.type === "player_move" && !samePoint(outcome.action.point, record.wireAction.point))
    || (record.actorColor != null && outcome.action.color !== record.actorColor)) return false;
  if (outcome.duplicateNoop === true) {
    if (record.wireAction.type !== "player_resign" || outcome.actionSeq <= 0) return false;
    const original = sameScope(snapshotScope, requestScope)
      ? actions.find(action => action.actionSeq === outcome.actionSeq && action.matchEpoch === requestScope.matchEpoch
        && action.type === "player_resign" && action.playerId === record.playerId)
      : record.originalResign;
    return Boolean(original && original.actionSeq === outcome.actionSeq && original.matchEpoch === requestScope.matchEpoch
      && original.type === "player_resign" && original.playerId === record.playerId
      && original.clientActionId !== record.wireAction.clientActionId);
  }
  return outcome.actionSeq === record.wireAction.baseActionSeq + 1
    && (!sameScope(snapshotScope, requestScope) || actions.some(action => action.actionSeq === outcome.actionSeq
      && action.matchEpoch === requestScope.matchEpoch && action.clientActionId === record.wireAction.clientActionId
      && sameAction(action, outcome.action)));
}
function normalizeHistoryAction(action, scope, actionSeq = action.actionSeq, clientActionId = action.clientActionId ?? null) {
  return { ...clone(action), actionSeq, matchEpoch: scope.matchEpoch, clientActionId,
    serverInstanceId: scope.serverInstanceId, roomInstanceId: scope.roomInstanceId, matchGeneration: scope.matchGeneration };
}

function defaultCreateActionId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  defaultCreateActionId.counter = (defaultCreateActionId.counter ?? 0) + 1;
  return `action-${Date.now().toString(36)}-${defaultCreateActionId.counter.toString(36)}`;
}

export class OnlineActionSync {
  constructor(options = {}) {
    this._createActionId = options.createActionId ?? defaultCreateActionId;
    this._protocol = { status: "unknown", version: null, serverInstanceId: null };
    this._scope = null;
    this._pending = null;
    this._lastSeen = null;
    this._loggedActions = [];
    this._activePlan = null;
    this._syncRequest = null;
    this._nextToken = 0;
    this._revision = 0;
    this._recoveryRequired = false;
    this._capacityBlock = null;
    this._capacityRecoveryReadyScope = null;
    this._committedSnapshot = null;
  }

  setProtocol(info = {}) {
    const status = ["selected", "legacy", "unknown"].includes(info.status) ? info.status : "unknown";
    const version = status === "selected" ? info.version : null;
    const serverInstanceId = status === "selected" && isId(info.serverInstanceId) ? info.serverInstanceId : null;
    if (status === "selected" && (version !== 1 || !serverInstanceId)) return { status: "invalid", reason: "invalid_protocol_info" };
    if (this._protocol.status === status && this._protocol.version === version
      && this._protocol.serverInstanceId === serverInstanceId) return { status: "unchanged", identityChanged: false };
    const previousStatus = this._protocol.status;
    const changed = this._protocol.serverInstanceId !== null && serverInstanceId !== null
      && this._protocol.serverInstanceId !== serverInstanceId;
    this._protocol = { status, version, serverInstanceId };
    this._capacityRecoveryReadyScope = null;
    if (changed || (status === "unknown" && (this._scope || this._pending || previousStatus !== "unknown"))
      || (status === "legacy" && this._pending)) this._requireRecovery();
    if (status === "legacy" && !this._pending) this._recoveryRequired = false;
    this._changed();
    return { status: "updated", identityChanged: changed };
  }

  markConnectionLost() {
    this._protocol = { status: "unknown", version: null, serverInstanceId: null };
    this._capacityRecoveryReadyScope = null;
    this._requireRecovery();
    this._changed();
  }

  beginAction(actionLike = {}) {
    if (this._capacityBlock && sameScope(this._capacityBlock.scope, this._scope))
      return { status: "locked", reason: "ACTION_OUTCOME_CAPACITY" };
    if (this.isLocked()) return { status: "locked", reason: this._recoveryRequired ? "recovery_required" : "action_pending" };
    if (this._protocol.status === "legacy") return { status: "legacy", action: {
      type: actionLike.type, ...(actionLike.type === "player_move" ? { point: clone(actionLike.point) } : {}), clientActionId: null,
    } };
    if (this._protocol.status !== "selected" || !this._scope || this._scope.serverInstanceId !== this._protocol.serverInstanceId)
      return { status: "unavailable", reason: "protocol_or_scope_unknown" };
    if (!ACTION_TYPES.has(actionLike.type) || !isId(actionLike.playerId)
      || (actionLike.type === "player_move" ? !isPoint(actionLike.point) : actionLike.point !== undefined))
      return { status: "invalid", reason: "invalid_action" };
    const id = this._createActionId();
    if (!isId(id)) return { status: "invalid", reason: "action_id_not_unique" };
    const wireAction = { type: actionLike.type, roomInstanceId: this._scope.roomInstanceId,
      matchEpoch: this._scope.matchEpoch, clientActionId: id, baseActionSeq: this._scope.actionSeq,
      ...(actionLike.type === "player_move" ? { point: [...actionLike.point] } : {}) };
    const originalResign = actionLike.type === "player_resign"
      ? this._loggedActions.find(item => item.matchEpoch === this._scope.matchEpoch
        && item.type === "player_resign" && item.playerId === actionLike.playerId) ?? null
      : null;
    this._pending = { wireAction, scope: clone(this._scope), playerId: actionLike.playerId, actorColor: actionLike.actorColor ?? null,
      status: "reserved", optimisticApplied: false, originalResign: clone(originalResign) };
    this._changed();
    return { status: "reserved", clientActionId: id, action: clone(wireAction) };
  }

  markOptimisticApplied(id) { if (!this._pending || this._pending.wireAction.clientActionId !== id || this._pending.status !== "reserved" || this._pending.optimisticApplied) return false; this._pending.optimisticApplied = true; this._changed(); return true; }
  markSent(id) { if (!this._pending || this._pending.wireAction.clientActionId !== id || !["reserved", "retryable"].includes(this._pending.status)) return false; this._pending.status = "sent"; this._changed(); return true; }
  cancelReservation(id) { if (!this._pending || this._pending.wireAction.clientActionId !== id || this._pending.status !== "reserved" || this._pending.optimisticApplied) return false; this._pending = null; this._changed(); return true; }
  markUncertain(id = null) { if (!this._pending || (id !== null && this._pending.wireAction.clientActionId !== id)) return false; this._pending.status = "uncertain"; this._requireRecovery(); this._changed(); return true; }

  prepareRetry(id) {
    if (this._capacityBlock && sameScope(this._capacityBlock.scope, this._scope))
      return { status: "unavailable", reason: "action_outcome_capacity" };
    if (!this._pending || this._pending.wireAction.clientActionId !== id || this._pending.status !== "retryable"
      || !this._pending.retryBaseline || !sameScope(this._pending.retryBaseline.scope, this._scope)
      || this._pending.retryBaseline.actionSeq !== this._scope.actionSeq
      || this._pending.retryBaseline.actionSeq !== this._pending.wireAction.baseActionSeq
      || !sameScope(this._pending.scope, this._scope) || this._protocol.serverInstanceId !== this._pending.scope.serverInstanceId)
      return { status: "unavailable", reason: "retry_not_compatible" };
    this._pending.status = "reserved"; this._pending.optimisticApplied = false; this._changed();
    return { status: "retry", clientActionId: id, action: clone(this._pending.wireAction) };
  }

  prepareActionEvent(payload) {
    if (this._activePlan) return this._needsSync("another_plan_active");
    if (!payload || !["ACTION_LOGGED", "ACTION_REJECTED"].includes(payload.type)) return { status: "ignore", reason: "unsupported_event" };
    if (payload.actionProtocolVersion !== 1 || !isId(payload.serverInstanceId) || !isId(payload.roomInstanceId)
      || !isSeq(payload.matchGeneration) || !isId(payload.matchEpoch) || !isSeq(payload.actionSeq)) return this._needsSync("invalid_event_scope");
    const eventScope = { serverInstanceId: payload.serverInstanceId, roomInstanceId: payload.roomInstanceId,
      matchGeneration: payload.matchGeneration, matchEpoch: payload.matchEpoch };
    if (!sameScope(eventScope, this._scope)) return { status: "ignore", reason: "different_scope" };
    if (this._recoveryRequired) return { status: "needsSync", reason: "snapshot_recovery_required", locked: true };
    if (payload.type === "ACTION_REJECTED") {
      if (this._pending && payload.clientActionId === this._pending.wireAction.clientActionId
        && sameScope(this._pending.scope, eventScope) && payload.playerId === this._pending.playerId) return this._needsSync("local_action_rejected");
      return { status: "ignore", reason: "unmatched_rejection" };
    }
    const action = payload.action;
    if (!validAction(action) || (payload.playerId !== undefined && payload.playerId !== action.playerId)) return this._needsSync("invalid_or_conflicting_action");
    const id = payload.clientActionId;
    if (!(id == null || isId(id))) return this._needsSync("invalid_action_id");
    const pending = this._pending && id === this._pending.wireAction.clientActionId ? this._pending : null;
    if (pending && (!sameScope(pending.scope, eventScope) || action.playerId !== pending.playerId
      || (pending.actorColor != null && action.color !== pending.actorColor)
      || !sameAction(action, { ...pending.wireAction, playerId: pending.playerId }))) return this._needsSync("local_action_mismatch");
    if (pending && payload.duplicateNoop === true) {
      const original = this._loggedActions.find(item => item.actionSeq === payload.actionSeq && item.matchEpoch === eventScope.matchEpoch
        && item.type === "player_resign" && item.playerId === pending.playerId);
      if (action.type !== "player_resign" || !original || original.actionSeq !== payload.actionSeq
        || original.matchEpoch !== eventScope.matchEpoch || payload.actionSeq <= 0) return this._needsSync("invalid_duplicate_noop");
      return this._plan("confirmNoop", { pendingId: id, actionSeq: payload.actionSeq, payload: clone(payload) });
    }
    if (pending) {
      if (payload.actionSeq !== pending.wireAction.baseActionSeq + 1) return this._needsSync("local_action_sequence_mismatch");
      return this._plan(pending.optimisticApplied ? "confirm" : "apply", { pendingId: id, actionSeq: payload.actionSeq,
        action: clone(action), payload: clone(payload) });
    }
    if (this._pending && !pending) return this._needsSync("concurrent_action_during_optimistic_pending");
    if (id != null && this._lastSeen && sameScope(this._lastSeen.scope, eventScope)
      && this._lastSeen.id === id && this._lastSeen.playerId === action.playerId && sameAction(this._lastSeen.action, action))
      return { status: "duplicate", reason: "completed_action" };
    if (payload.actionSeq <= this._scope.actionSeq) {
      const seen = this._loggedActions.find(item => item.actionSeq === payload.actionSeq);
      if (seen && sameAction(seen, action) && (id == null || seen.clientActionId === id)) return { status: "duplicate", reason: "action_sequence_seen" };
      return this._needsSync("old_or_conflicting_action_sequence");
    }
    if (payload.actionSeq !== this._scope.actionSeq + 1) return this._needsSync("action_sequence_gap");
    if (id == null && action.playerId === this._scope.localPlayerId) return this._needsSync("unattributed_local_action");
    return this._plan("apply", { pendingId: null, actionSeq: payload.actionSeq, action: clone(action), payload: clone(payload) });
  }

  commitActionEvent(token, { applied = false } = {}) {
    const plan = this._takePlan(token, "action");
    if (!plan) return { status: "stale", reason: "prepared_action_invalidated" };
    const value = plan.value;
    if ((value.kind === "apply") !== Boolean(applied)) { this._requireRecovery(); this._changed(); return { status: "failed", reason: "action_application_not_committed", locked: true }; }
    if (value.kind === "confirmNoop") { this._completePending(value.pendingId); this._changed(); return { status: "confirmed_noop", actionSeq: this._scope.actionSeq }; }
    const action = value.kind === "apply" ? value.action : value.payload.action;
    this._remember(value.payload, action);
    if (value.pendingId) this._completePending(value.pendingId);
    this._scope.actionSeq = Math.max(this._scope.actionSeq, value.actionSeq);
    this._scope.roomRevision = Math.max(this._scope.roomRevision, value.payload.roomRevision ?? this._scope.roomRevision);
    this._recoveryRequired = false; this._changed();
    return { status: value.kind === "apply" ? "applied" : "confirmed", actionSeq: this._scope.actionSeq };
  }

  abortActionEvent(token) { const plan = this._takePlan(token, "action"); if (!plan) return false; this._requireRecovery(); this._changed(); return true; }

  prepareSnapshot(payload, options = {}) {
    const error = snapshotError(payload);
    if (error) { this._requireRecovery(); this._changed(); return { status: "invalid", reason: error }; }
    const next = { serverInstanceId: payload.serverInstanceId, roomInstanceId: payload.roomInstanceId,
      matchGeneration: payload.matchGeneration, matchEpoch: payload.matchEpoch, actionSeq: payload.actionSeq, roomRevision: payload.roomRevision };
    if (this._protocol.status !== "selected" || this._protocol.version !== 1) return { status: "defer", reason: "protocol_not_selected" };
    if (next.serverInstanceId !== this._protocol.serverInstanceId) { this._requireRecovery(); this._changed(); return { status: "defer", reason: "server_identity_changed" }; }
    const current = this._scope;
    const newRoom = !current || !sameRoom(current, next);
    if (newRoom && options.allowNewScope !== true) return { status: "defer", reason: "new_room_scope_requires_explicit_adoption" };
    if (current && !newRoom) {
      if (next.roomRevision < current.roomRevision || next.matchGeneration < current.matchGeneration) return { status: "ignore", reason: "stale_snapshot" };
      if (next.matchGeneration === current.matchGeneration && next.matchEpoch !== current.matchEpoch) return { status: "defer", reason: "epoch_changed_without_generation" };
      if (next.matchGeneration === current.matchGeneration && next.matchEpoch === current.matchEpoch && next.actionSeq < current.actionSeq) return { status: "ignore", reason: "action_watermark_rollback" };
      if (next.matchGeneration > current.matchGeneration && next.matchEpoch === current.matchEpoch) { this._requireRecovery(); this._changed(); return { status: "invalid", reason: "generation_changed_without_epoch" }; }
    }
    if (this._activePlan) return { status: "defer", reason: "another_plan_active" };
    const actions = payload.matchState.actions;
    const syncPlan = options.syncPlan ?? null;
    if (syncPlan) for (const [id, outcome] of syncPlan.outcomes) {
      const record = this._pending?.wireAction.clientActionId === id ? this._pending : null;
      const present = record ? findOwnedSnapshotAction(record, actions, syncPlan.requestScope) : null;
      if (outcome.status === "logged" && !validOutcome(outcome, record, syncPlan.requestScope, actions, next)) return this._invalidSnapshot("logged_outcome_snapshot_mismatch");
      if (outcome.status === "rejected" && (!validOutcome(outcome, record, syncPlan.requestScope, actions, next) || present)) return this._invalidSnapshot("rejected_outcome_snapshot_mismatch");
      if (outcome.status === "notSeen" && present) return this._invalidSnapshot("not_seen_action_present");
      if (outcome.status === "unknownEpoch" && present) return this._invalidSnapshot("unknown_epoch_action_present");
    }
    if (this._pending) {
      const record = this._pending;
      const present = findOwnedSnapshotAction(record, actions, next);
      if (present && !snapshotActionMatches(record, present, next)) return this._invalidSnapshot("pending_id_snapshot_mismatch");
      const outcome = syncPlan?.outcomes.get(record.wireAction.clientActionId);
      if (record.optimisticApplied && sameScope(record.scope, next) && !present && !outcome) return { status: "defer", reason: "snapshot_omits_optimistic_action" };
    }
    const syncReqToken = syncPlan?.requestToken ?? null;
    if (this._capacityBlock && sameScope(this._capacityBlock.scope, this._scope)) this._capacityRecoveryReadyScope = null;
    const plan = this._plan("snapshot", { payload: clone(payload), nextScope: next, actions: clone(actions), syncPlan: clonePlan(syncPlan), newRoom });
    return { status: "ready", token: plan.token, source: options.source ?? "room", syncRequestToken: syncReqToken,
      deferFinalize: Boolean(this._capacityBlock) };
  }

  prepareSyncRequest() {
    if (this._protocol.status !== "selected" || !this._scope) return { status: "unavailable", reason: "protocol_or_scope_unknown" };
    if (this._syncRequest || this._activePlan) return { status: "locked", reason: "sync_or_plan_active" };
    const record = this._pending;
    const requestScope = clone(record?.scope ?? this._scope);
    if (!sameRoom(requestScope, this._scope)) return { status: "unavailable", reason: "pending_room_mismatch" };
    if (this._capacityBlock && sameScope(this._capacityBlock.scope, this._scope)) this._capacityRecoveryReadyScope = null;
    const token = `sync-${++this._nextToken}`;
    this._syncRequest = { token, revision: this._revision, scope: requestScope, record: clone(record) };
    return { status: "ready", token, request: { roomInstanceId: requestScope.roomInstanceId, matchEpoch: requestScope.matchEpoch,
      pendingActionIds: record ? [record.wireAction.clientActionId] : [] } };
  }

  failSyncRequest(requestToken) {
    if (!this._syncRequest || this._syncRequest.token !== requestToken) return false;
    this._syncRequest = null;
    this._requireRecovery();
    this._changed();
    return true;
  }

  prepareSyncResponse(requestToken, payload) {
    const request = this._syncRequest;
    if (!request || request.token !== requestToken || request.revision !== this._revision) return { status: "stale", reason: "sync_request_invalidated" };
    if (payload?.type !== "SYNC_STATE" || !isId(payload.syncRequestId) || payload.roomInstanceId !== request.scope.roomInstanceId
      || !Array.isArray(payload.pendingActionOutcomes) || typeof payload.outcomeLedgerComplete !== "boolean") return this._invalidSyncResponse("invalid_sync_response");
    const outcomes = new Map();
    for (const outcome of payload.pendingActionOutcomes) {
      if (!outcome || !isId(outcome.clientActionId) || outcomes.has(outcome.clientActionId)
        || !request.record || outcome.clientActionId !== request.record.wireAction.clientActionId
        || !["logged", "rejected", "notSeen", "unknownEpoch"].includes(outcome.status)) return this._invalidSyncResponse("invalid_pending_action_outcome");
      if (outcome.status === "notSeen" && !payload.outcomeLedgerComplete) return this._invalidSyncResponse("not_seen_without_complete_ledger");
      if (outcome.status === "unknownEpoch" && payload.outcomeLedgerComplete) return this._invalidSyncResponse("unknown_epoch_with_complete_ledger");
      outcomes.set(outcome.clientActionId, clone(outcome));
    }
    if ((request.record && outcomes.size !== 1) || (!request.record && outcomes.size !== 0)) return this._invalidSyncResponse("pending_action_outcomes_incomplete");
    const marker = payload.actionOutcomeCapacity;
    if (marker !== undefined && (!marker || typeof marker !== "object" || Array.isArray(marker)
      || !isId(marker.serverInstanceId) || !isId(marker.roomInstanceId) || !isId(marker.matchEpoch)
      || !Number.isSafeInteger(marker.matchGeneration) || marker.matchGeneration < 0 || typeof marker.blocked !== "boolean"
      || !Number.isSafeInteger(marker.count) || marker.count < 0 || !Number.isSafeInteger(marker.serializedBytes) || marker.serializedBytes < 0
      || !Number.isSafeInteger(marker.maxEntries) || marker.maxEntries < 1
      || !Number.isSafeInteger(marker.maxSerializedBytes) || marker.maxSerializedBytes < 1)) return this._invalidSyncResponse("invalid_action_outcome_capacity");
    const capacity = marker ? clone(marker) : null;
    if (capacity && (capacity.serverInstanceId !== payload.serverInstanceId || capacity.roomInstanceId !== payload.roomInstanceId
      || capacity.matchGeneration !== payload.matchGeneration || capacity.matchEpoch !== payload.matchEpoch))
      return this._invalidSyncResponse("action_outcome_capacity_scope_mismatch");
    const syncPlan = { requestToken, requestScope: request.scope, outcomeLedgerComplete: payload.outcomeLedgerComplete, outcomes, capacity };
    const prepared = this.prepareSnapshot(payload, { source: "sync", syncPlan });
    const responseScope = { serverInstanceId: payload.serverInstanceId, roomInstanceId: payload.roomInstanceId,
      matchGeneration: payload.matchGeneration, matchEpoch: payload.matchEpoch };
    if (prepared.status === "ready") prepared.deferFinalize = prepared.deferFinalize
      || Boolean(capacity?.blocked === true && sameScope(capacity, responseScope));
    return prepared;
  }

  commitSnapshot(token, { restoreSucceeded = false, deferFinalize = false } = {}) {
    const plan = this._takePlan(token, "snapshot");
    if (!plan) return { status: "stale", reason: "prepared_snapshot_invalidated" };
    if (!restoreSucceeded) { this._requireRecovery(); this._changed(); return { status: "restore_failed", locked: true }; }
    // A newer successful restore supersedes any candidate whose caller never finalized it.
    this._committedSnapshot = null;
    const { payload, nextScope, actions, syncPlan } = plan.value;
    const previous = this._scope;
    this._scope = { ...nextScope, localPlayerId: payload.yourPlayerId ?? payload.playerId ?? previous?.localPlayerId ?? null };
    this._loggedActions = actions.map(item => normalizeHistoryAction(item, nextScope));
    if (deferFinalize) {
      this._committedSnapshot = { token: `finalize-${++this._nextToken}`, nextScope: clone(nextScope), actions: clone(actions), syncPlan: clonePlan(syncPlan), payload: clone(payload) };
      this._recoveryRequired = Boolean(this._pending);
      if (this._pending) this._pending.status = "uncertain";
      if (syncPlan) this._syncRequest = null;
      this._changed();
      this._committedSnapshot.revision = this._revision;
      return { status: "committed", finalizeToken: this._committedSnapshot.token, scope: clone(this._scope), retryActions: [], locked: this.isLocked() };
    }
    return this._finalizeSnapshot({ nextScope, actions, syncPlan, payload });
  }

  finalizeSnapshot(token) {
    const staged = this._committedSnapshot;
    if (!staged || staged.token !== token) return { status: "stale", reason: "snapshot_finalize_invalidated" };
    if (staged.revision !== this._revision || !sameScope(staged.nextScope, this._scope)) {
      this._committedSnapshot = null;
      this._requireRecovery();
      this._changed();
      return { status: "stale", reason: "snapshot_finalize_invalidated", locked: true };
    }
    this._committedSnapshot = null;
    return this._finalizeSnapshot(staged);
  }

  _finalizeSnapshot({ nextScope, actions, syncPlan, payload }) {
    if (!sameScope(this._capacityRecoveryReadyScope, nextScope)) this._capacityRecoveryReadyScope = null;
    let resolvedActionOutcome = null;
    if (this._pending) {
      const record = this._pending;
      const id = record.wireAction.clientActionId;
      const action = findOwnedSnapshotAction(record, actions, nextScope);
      const outcome = syncPlan?.outcomes.get(id);
      if (action && snapshotActionMatches(record, action, nextScope)) this._completePending(id);
      else if (outcome?.status === "logged" || outcome?.status === "rejected") {
        if (outcome.status === "rejected") {
          resolvedActionOutcome = {
            status: "rejected",
            code: outcome.code === "RATE_LIMITED" ? "RATE_LIMITED" : null,
            clientActionId: id,
            playerId: record.playerId,
            scope: clone(record.scope),
            submittedActionSeq: record.wireAction.baseActionSeq,
            committedScope: clone(nextScope),
            committedActionSeq: nextScope.actionSeq,
          };
        }
        this._completePending(id);
      }
      else if (outcome?.status === "notSeen") {
        const blocked = syncPlan?.capacity?.blocked === true && sameScope(syncPlan.capacity, record.scope)
          && sameScope(syncPlan.capacity, nextScope) && sameScope(syncPlan.requestScope, record.scope);
        const markerBlocksNextScope = syncPlan?.capacity?.blocked === true && sameScope(syncPlan.capacity, nextScope);
        if (blocked || (this._capacityBlock && sameScope(this._capacityBlock.scope, record.scope))) record.status = "capacityBlocked";
        else if (markerBlocksNextScope && !sameScope(record.scope, nextScope)) record.status = "uncertain";
        else if (syncPlan.outcomeLedgerComplete && sameScope(record.scope, nextScope) && record.wireAction.baseActionSeq === nextScope.actionSeq) {
          record.status = "retryable"; record.optimisticApplied = false;
          record.retryBaseline = { scope: clone(nextScope), actionSeq: nextScope.actionSeq };
        } else this._completePending(id);
      } else if (outcome?.status === "unknownEpoch") record.status = "uncertain";
      else if (this._capacityBlock && sameScope(this._capacityBlock.scope, record.scope)) record.status = "capacityBlocked";
      else record.status = "uncertain";
    }
    if (syncPlan?.capacity?.blocked === true && sameScope(syncPlan.capacity, nextScope))
      this._capacityBlock = { scope: { serverInstanceId: syncPlan.capacity.serverInstanceId, roomInstanceId: syncPlan.capacity.roomInstanceId,
        matchGeneration: syncPlan.capacity.matchGeneration, matchEpoch: syncPlan.capacity.matchEpoch }, marker: clone(syncPlan.capacity) };
    else if (!sameScope(this._capacityBlock?.scope, nextScope) && this._capacityBlock) this._capacityBlock = null;
    this._recoveryRequired = Boolean(this._pending && this._pending.status === "uncertain");
    if (syncPlan) this._syncRequest = null;
    this._changed();
    return { status: "committed", scope: clone(this._scope), retryActions: this._pending?.status === "retryable" ? [clone(this._pending.wireAction)] : [],
      resolvedActionOutcome, locked: this.isLocked() };
  }

  abortSnapshot(token) { const plan = this._takePlan(token, "snapshot"); if (!plan) return false; this._requireRecovery(); this._changed(); return true; }
  clearRoom() { this._pending = null; this._scope = null; this._loggedActions = []; this._lastSeen = null; this._activePlan = null; this._syncRequest = null; this._committedSnapshot = null; this._capacityBlock = null; this._capacityRecoveryReadyScope = null; this._recoveryRequired = false; this._changed(); }
  completeCapacityRecovery(scope = this._scope) {
    const state = this.getState();
    const pendingReady = state.pending.length === 0 || (state.pending.length === 1
      && state.pending[0].status === "capacityBlocked" && sameScope(state.pending[0].scope, scope));
    if (!state.capacityBlocked || !sameScope(scope, state.scope) || state.protocol.status !== "selected"
      || state.protocol.version !== 1 || state.protocol.serverInstanceId !== scope?.serverInstanceId
      || state.recoveryRequired || state.pending.some(item => item.status === "uncertain") || !pendingReady
      || this._activePlan || this._committedSnapshot || this._syncRequest) return false;
    this._capacityRecoveryReadyScope = clone(scope);
    this._changed();
    return this.getState().capacityRecoveryReady;
  }
  clearCapacityRecoveryReady(scope = null) {
    if (scope && !sameScope(scope, this._capacityRecoveryReadyScope)) return false;
    if (!this._capacityRecoveryReadyScope) return false;
    this._capacityRecoveryReadyScope = null;
    this._changed();
    return true;
  }
  isLocked() { return this._recoveryRequired || Boolean(this._activePlan) || Boolean(this._pending) || Boolean(this._committedSnapshot)
    || Boolean(this._capacityBlock && sameScope(this._capacityBlock.scope, this._scope)); }
  getState() {
    const pending = this._pending ? [{ clientActionId: this._pending.wireAction.clientActionId, ...clone(this._pending) }] : [];
    const capacityBlocked = Boolean(this._capacityBlock && sameScope(this._capacityBlock.scope, this._scope));
    const pendingReady = pending.length === 0 || (pending.length === 1 && pending[0].status === "capacityBlocked"
      && sameScope(pending[0].scope, this._scope));
    const capacityRecoveryReady = Boolean(this._capacityRecoveryReadyScope && sameScope(this._capacityRecoveryReadyScope, this._scope)
      && capacityBlocked && this._protocol.status === "selected" && this._protocol.version === 1
      && this._protocol.serverInstanceId === this._scope?.serverInstanceId && !this._recoveryRequired && pendingReady
      && !pending.some(item => item.status === "uncertain") && !this._activePlan && !this._committedSnapshot && !this._syncRequest);
    return { protocol: clone(this._protocol), scope: clone(this._scope), pending, capacityBlocked, capacityBlock: clone(this._capacityBlock),
      capacityRecoveryReady, capacityRecoveryReadyScope: capacityRecoveryReady ? clone(this._capacityRecoveryReadyScope) : null,
      recoveryRequired: this._recoveryRequired, locked: this.isLocked(), revision: this._revision };
  }

  _plan(kind, value) { const token = `prepared-${++this._nextToken}`; this._activePlan = { token, kind: kind === "snapshot" ? "snapshot" : "action", revision: this._revision, value: { ...value, kind } }; return { status: "prepared", token, kind, decision: kind }; }
  _takePlan(token, kind) { const plan = this._activePlan; if (!plan || plan.token !== token || plan.kind !== kind || plan.revision !== this._revision) return null; this._activePlan = null; return plan; }
  _changed() { this._revision += 1; if (this._activePlan) this._activePlan = null; if (this._syncRequest && this._syncRequest.revision !== this._revision) this._syncRequest = null; }
  _needsSync(reason) { this._requireRecovery(); this._changed(); return { status: "needsSync", reason, locked: true }; }
  _invalidSnapshot(reason) { this._requireRecovery(); this._changed(); return { status: "invalid", reason }; }
  _invalidSyncResponse(reason) { this._requireRecovery(); this._changed(); return { status: "invalid", reason, locked: true }; }
  _requireRecovery() { this._capacityRecoveryReadyScope = null; this._recoveryRequired = true; if (this._pending) this._pending.status = "uncertain"; }
  _remember(payload, action) {
    const scope = { serverInstanceId: payload.serverInstanceId, roomInstanceId: payload.roomInstanceId,
      matchGeneration: payload.matchGeneration, matchEpoch: payload.matchEpoch };
    const logged = normalizeHistoryAction(action, scope, payload.actionSeq, payload.clientActionId ?? null);
    if (!this._loggedActions.some(item => item.actionSeq === logged.actionSeq)) this._loggedActions.push(logged);
    this._lastSeen = { scope, id: logged.clientActionId, playerId: logged.playerId, action: clone(logged) };
  }
  _completePending(id) { if (this._pending?.wireAction.clientActionId === id) this._pending = null; }
}

function clonePlan(plan) { return plan ? { ...plan, requestScope: clone(plan.requestScope), outcomes: new Map([...plan.outcomes].map(([id, item]) => [id, clone(item)])) } : null; }
export { ACTION_TYPES };
export default OnlineActionSync;
