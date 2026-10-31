const DEFAULT_RETRY_DELAYS = [250, 750, 1500];

export class OnlineActionSyncCoordinator {
  constructor({ sync, controller, getNetworkManager, playerId, resolvePlayerColor, onCommittedRoomState, onActionRejected, isCurrentOwner,
    ackTimeoutMs = 5000, retryDelays = DEFAULT_RETRY_DELAYS,
    setTimeoutFn = (...args) => globalThis.setTimeout(...args),
    clearTimeoutFn = (...args) => globalThis.clearTimeout(...args) } = {}) {
    if (!sync || !controller || typeof getNetworkManager !== "function") {
      throw new TypeError("OnlineActionSyncCoordinator requires sync, controller, and getNetworkManager.");
    }
    this.sync = sync;
    this.controller = controller;
    this.getNetworkManager = getNetworkManager;
    this.playerId = playerId ?? null;
    this.resolvePlayerColor = resolvePlayerColor ?? (() => null);
    this._playerColorById = new Map();
    this.onCommittedRoomState = onCommittedRoomState ?? null;
    this.onActionRejected = onActionRejected ?? null;
    this.isCurrentOwner = typeof isCurrentOwner === "function" ? isCurrentOwner : () => true;
    this.ackTimeoutMs = ackTimeoutMs;
    this.retryDelays = [...retryDelays];
    this.setTimeout = setTimeoutFn;
    this.clearTimeout = clearTimeoutFn;
    this.manager = null;
    this.socket = null;
    this.connectionOpen = false;
    this.generation = 0;
    this.disposed = false;
    this._unsubscribers = [];
    this._ackTimers = new Map();
    this._retryTimers = new Map();
    this._syncRetryTimers = new Map();
    this._actionAttempts = new Map();
    this._syncAttempts = 0;
    this._capacitySyncKey = null;
    this._syncPromise = null;
    this._negotiation = null;
    this._onActionSending = this._onActionSending.bind(this);
    this._onRecoveryRequired = this._onRecoveryRequired.bind(this);
  }

  async start(manager = this.getNetworkManager()) {
    if (this.disposed) return { status: "disposed" };
    if (!manager) return { status: "unavailable", reason: "network_manager_missing" };
    if (this.manager === manager && this._unsubscribers.length) return this.ensureReady(manager);
    this._detachManager({ markLost: Boolean(this.manager) });
    this.manager = manager;
    this.socket = manager.socket ?? null;
    this.connectionOpen = this._managerIsConnected(manager);
    const generation = ++this.generation;
    const bound = this.controller.bindOnlineActionSync({ sync: this.sync, playerId: this.playerId,
      onRecoveryRequired: this._onRecoveryRequired, onActionSending: this._onActionSending });
    if (bound.status !== "bound") return bound;

    this._subscribe("CLOSE", () => this._handleClose(this.generation, manager));
    this._subscribe("ACTION_LOGGED", payload => { void this.handleActionEvent(payload, { generation: this.generation, manager }); });
    this._subscribe("ACTION_REJECTED", payload => { void this.handleActionEvent(payload, { generation: this.generation, manager }); });
    this._subscribe("ACTION_NOT_PROCESSED", payload => { void this.handleCapacityControl(payload, { generation: this.generation, manager, socket: manager.socket ?? null }); });
    this._subscribe("OPEN", () => {
      const nextSocket = manager.socket ?? null;
      if (!this._managerIsConnected(manager) || nextSocket === null) return;
      if (nextSocket !== this.socket || !this.connectionOpen) {
        if (this.connectionOpen && nextSocket !== this.socket && this.sync.getState().scope) {
          const capacityBlocked = this.sync.getState().capacityBlocked;
          this.sync.markConnectionLost();
          if (capacityBlocked) this._publishCapacityRecoveryState({ generation: this.generation, manager });
        }
        this.generation += 1;
        this._clearAllTimers();
        this._syncPromise = null;
      }
      this.socket = nextSocket;
      this.connectionOpen = true;
      void this._beginNegotiation(this.generation, manager);
    });
    return this.connectionOpen
      ? this._beginNegotiation(generation, manager)
      : { status: "not_connected", reason: "waiting_for_open" };
  }

  ensureReady(manager = this.manager) {
    if (this.disposed) return Promise.resolve({ status: "disposed" });
    if (!manager || manager !== this.manager || manager !== this.getNetworkManager()) {
      return Promise.resolve({ status: "unavailable", reason: "network_manager_not_attached" });
    }
    if (!this.connectionOpen || !this._managerIsConnected(manager) || (manager.socket ?? null) !== this.socket) {
      return Promise.resolve({ status: "not_connected", reason: "waiting_for_open" });
    }
    return this._beginNegotiation(this.generation, manager);
  }

  _beginNegotiation(generation, manager) {
    if (this._negotiation?.generation === generation && this._negotiation.manager === manager
      && this._negotiation.socket === (manager.socket ?? null)) return this._negotiation.promise;
    const promise = this._negotiate(generation, manager);
    const record = { generation, manager, socket: manager.socket ?? null, promise };
    this._negotiation = record;
    promise.finally(() => { if (this._negotiation === record) this._negotiation = null; });
    return promise;
  }

  adoptPlayerIdentity(playerId) {
    if (typeof playerId !== "string" || !playerId) return { status: "invalid", reason: "player_id_missing" };
    const bound = this.controller.bindOnlineActionSync({ sync: this.sync, playerId,
      onRecoveryRequired: this._onRecoveryRequired, onActionSending: this._onActionSending });
    if (bound.status !== "bound") return bound;
    this.playerId = playerId;
    return { status: "bound", state: bound.state };
  }

  async _negotiate(generation, manager) {
    if (!this._isCurrent(generation, manager)) return { status: "stale" };
    if (typeof manager.negotiateActionProtocol !== "function") return { status: "unknown", reason: "negotiation_unavailable" };
    let protocol;
    try { protocol = await manager.negotiateActionProtocol(); }
    catch (error) { protocol = { status: "unknown", reason: "negotiation_failed", error }; }
    if (!this._isCurrent(generation, manager)) return { status: "stale" };
    if (!protocol || !["selected", "legacy"].includes(protocol.status)) {
      this.sync.setProtocol({ status: "unknown" });
      this._refreshControllerActionState({ generation, manager });
      return { status: "unknown", reason: protocol?.reason ?? "protocol_not_selected" };
    }
    if (protocol.status === "legacy" && this.sync.getState().pending.length) {
      this.sync.setProtocol({ status: "legacy" });
      this._refreshControllerActionState({ generation, manager });
      return { status: "locked", reason: "legacy_with_pending_v1_action" };
    }
    const result = this.sync.setProtocol(protocol);
    if (result.status === "updated") this._refreshControllerActionState({ generation, manager });
    return { status: ["updated", "unchanged"].includes(result.status) ? protocol.status : result.status, protocol };
  }

  _refreshControllerActionState({ generation = this.generation, manager = this.manager } = {}) {
    try {
      if (this.sync.getState().capacityBlocked) this._publishCapacityRecoveryState({ generation, manager });
      else this.controller.refreshOnlineActionSyncState?.();
    }
    catch (error) {
      try { this.controller._reportNetworkError?.(error); } catch (_reportError) {}
    }
  }

  _publishCapacityRecoveryState({ generation = this.generation, manager = this.manager } = {}) {
    if (this.disposed || generation !== this.generation || manager !== this.manager
      || manager !== this.getNetworkManager() || !this.isCurrentOwner()) return false;
    try {
      this.controller.refreshOnlineActionSyncState?.();
      return true;
    } catch (error) {
      this.sync.clearCapacityRecoveryReady?.();
      try { this.controller._reportNetworkError?.(error); } catch (_reportError) {}
      return false;
    }
  }

  async acceptRoomSnapshot(payload, { allowNewScope = false, generation = this.generation, manager = this.manager } = {}) {
    if (!this._isCurrent(generation, manager)) return { status: "stale" };
    if (this.sync.getState().protocol.status !== "selected") return { status: "defer", reason: "protocol_not_selected" };
    const prepared = this.sync.prepareSnapshot(payload, { source: "room", allowNewScope });
    if (prepared.status !== "ready") {
      if (prepared.status === "defer" && prepared.reason === "snapshot_omits_optimistic_action") {
        return this.requestSync({ generation, manager, reason: prepared.reason });
      }
      return prepared;
    }
    if (prepared.deferFinalize || this.sync.getState().capacityBlocked) this._publishCapacityRecoveryState({ generation, manager });
    const result = await this._commitPreparedSnapshot(payload, prepared, { generation, manager });
    if (result.status === "committed" && this.sync.getState().pending.some(item => item.status === "uncertain")) {
      return this.requestSync({ generation, manager, reason: "snapshot_left_uncertain_outcome" });
    }
    return result;
  }

  async handleActionEvent(payload, { generation = this.generation, manager = this.manager } = {}) {
    if (!this._isCurrent(generation, manager)) return { status: "stale" };
    const plan = this.sync.prepareActionEvent(payload);
    if (plan.status === "needsSync") {
      this._clearAck(payload?.clientActionId);
      return this.requestSync({ generation, manager, reason: plan.reason });
    }
    if (plan.status !== "prepared") return plan;

    let controllerToken = null;
    if (plan.decision !== "confirmNoop") {
      const pending = this.sync.getState().pending.find(item => item.clientActionId === payload.clientActionId);
      const resolvePlayerColor = playerId => this._playerColorById.get(playerId) ?? this.resolvePlayerColor(playerId);
      const prepared = this.controller.prepareVersionedActionApplication(payload.action, {
        optimisticLocal: plan.decision === "confirm",
        expectedActorColor: pending?.actorColor ?? null,
        resolvePlayerColor,
      });
      if (!prepared.success) {
        this.sync.abortActionEvent(plan.token);
        this._clearAck(payload.clientActionId);
        return this.requestSync({ generation, manager, reason: prepared.reason });
      }
      controllerToken = prepared.token;
      let installed;
      try { installed = this.controller.installVersionedActionApplication(controllerToken); }
      catch (error) { installed = { success: false, reason: "CONTROLLER_INSTALL_FAILED", error }; }
      if (!installed.success || !this._isCurrent(generation, manager)) {
        this.controller.rollbackVersionedActionApplication(controllerToken);
        this.controller.abortVersionedActionApplication(controllerToken);
        this.sync.abortActionEvent(plan.token);
        this._clearAck(payload?.clientActionId);
        return this._isCurrent(generation, manager) ? this.requestSync({ generation, manager, reason: installed.reason }) : { status: "stale" };
      }
    }

    let committed;
    try { committed = this.sync.commitActionEvent(plan.token, { applied: plan.decision === "apply" }); }
    catch (error) { committed = { status: "failed", reason: error?.message ?? String(error) }; }
    if (!(["applied", "confirmed", "confirmed_noop"].includes(committed.status))) {
      if (controllerToken) { this.controller.rollbackVersionedActionApplication(controllerToken); this.controller.abortVersionedActionApplication(controllerToken); }
      this._clearAck(payload.clientActionId);
      return this.requestSync({ generation, manager, reason: committed.reason ?? committed.status });
    }
    if (controllerToken) {
      const controllerCommit = this.controller.publishVersionedActionApplication(controllerToken);
      if (!controllerCommit.success) {
        this.sync.markConnectionLost();
        this._clearAck(payload.clientActionId);
        return { status: "recovery_required", reason: controllerCommit.reason };
      }
    }
    this._clearAck(payload.clientActionId);
    this._actionAttempts.delete(payload.clientActionId);
    const committedScope = this.sync.getState().scope;
    if (!this._isCurrent(generation, manager) || !this._matchesCommittedScope(payload, committedScope)) {
      return { status: "committed_but_room_changed", payload };
    }
    return { ...committed, payload };
  }

  async handleCapacityControl(payload, { generation = this.generation, manager = this.manager, socket = this.socket } = {}) {
    if (!this._isCurrent(generation, manager) || socket !== this.socket || (manager.socket ?? null) !== socket) return { status: "stale" };
    const state = this.sync.getState();
    const pending = state.pending[0];
    const scope = pending?.scope;
    if (state.protocol.status !== "selected" || state.protocol.version !== 1 || !pending || state.pending.length !== 1
      || !scope || !state.scope || state.scope.serverInstanceId !== scope.serverInstanceId || state.scope.roomInstanceId !== scope.roomInstanceId
      || state.scope.matchGeneration !== scope.matchGeneration || state.scope.matchEpoch !== scope.matchEpoch
      || !this._matchesCapacityControl(payload, pending, scope, state.protocol)) return { status: "ignored", reason: "unmatched_capacity_control" };
    const key = `${generation}:${scope.serverInstanceId}:${scope.roomInstanceId}:${scope.matchGeneration}:${scope.matchEpoch}:${pending.clientActionId}`;
    if (this._capacitySyncKey === key) return { status: "duplicate" };
    this._capacitySyncKey = key;
    this._clearAck(pending.clientActionId);
    this._clearTimerMap(this._retryTimers, pending.clientActionId);
    this._clearTimerMap(this._syncRetryTimers, "sync");
    return this.requestSync({ generation, manager, reason: "action_outcome_capacity" });
  }

  _matchesCapacityControl(payload, pending, scope, protocol) {
    return payload?.type === "ACTION_NOT_PROCESSED" && payload.processed === false && payload.reason === "OUTCOME_CAPACITY"
      && payload.actionProtocolVersion === 1 && payload.serverInstanceId === protocol.serverInstanceId
      && payload.serverInstanceId === scope.serverInstanceId && payload.roomInstanceId === scope.roomInstanceId
      && payload.matchGeneration === scope.matchGeneration && payload.matchEpoch === scope.matchEpoch
      && payload.clientActionId === pending.clientActionId && payload.playerId === pending.playerId;
  }

  async requestSync({ generation = this.generation, manager = this.manager, reason = "manual" } = {}) {
    if (!this._isCurrent(generation, manager)) return { status: "stale" };
    if (this._syncPromise) return this._syncPromise;
    const request = this.sync.prepareSyncRequest();
    if (request.status !== "ready") return request;
    const capacityFlow = this.sync.getState().capacityBlocked;
    if (capacityFlow) this._publishCapacityRecoveryState({ generation, manager });
    this._clearAck(this.sync.getState().pending[0]?.clientActionId);
    const requestToken = request.token;
    const operation = (async () => {
      try {
        const payload = await manager.requestActionSync(request.request);
        if (!this._isCurrent(generation, manager)) {
          this.sync.failSyncRequest(requestToken);
          return { status: "stale" };
        }
        const prepared = this.sync.prepareSyncResponse(requestToken, payload);
        if (prepared.status !== "ready") {
          this.sync.failSyncRequest(requestToken);
          if (capacityFlow) this._publishCapacityRecoveryState({ generation, manager });
          this._scheduleSyncRetry(generation, manager, reason);
          return prepared;
        }
        const result = await this._commitPreparedSnapshot(payload, prepared, { generation, manager, requestToken });
        if (result.status === "committed") {
          const pendingAfter = this.sync.getState().pending;
          if (!pendingAfter.length) this._syncAttempts = 0;
          if (result.retryActions?.length) this._scheduleActionRetry(result.retryActions[0].clientActionId, generation, manager);
          else if (pendingAfter.some(item => item.status === "uncertain")) this._scheduleSyncRetry(generation, manager, "unresolved_outcome");
          if (result.metadataCommitted !== false) this._notifyRejectedAction(result.resolvedActionOutcome, { generation, manager });
        } else this._scheduleSyncRetry(generation, manager, result.reason ?? reason);
        return result;
      } catch (error) {
        this.sync.failSyncRequest(requestToken);
        if (capacityFlow && this._isCurrent(generation, manager)) this._publishCapacityRecoveryState({ generation, manager });
        this._scheduleSyncRetry(generation, manager, reason);
        return { status: "failed", reason: error?.message ?? String(error), error };
      }
    })();
    this._syncPromise = operation;
    try { return await operation; }
    finally { if (this._syncPromise === operation) this._syncPromise = null; }
  }

  async _commitPreparedSnapshot(payload, prepared, { generation, manager, requestToken = null } = {}) {
    const capacityFlow = prepared.deferFinalize === true || this.sync.getState().capacityBlocked;
    if (!this._isCurrent(generation, manager)) {
      this.sync.abortSnapshot(prepared.token);
      if (requestToken) this.sync.failSyncRequest(requestToken);
      return { status: "stale" };
    }
    const versionedScope = {
      serverInstanceId: payload.serverInstanceId, roomInstanceId: payload.roomInstanceId,
      matchGeneration: payload.matchGeneration, matchEpoch: payload.matchEpoch, actionSeq: payload.actionSeq,
    };
    const controllerPrepared = this.controller.prepareMatchState(payload.matchState, {
      strictVersionedActions: true, resolvePlayerColor: playerId => this._hasSnapshotPlayers(payload)
        || this._hasSnapshotMatchPlayers(payload)
        ? this._resolveSnapshotColor(playerId, payload) : this.resolvePlayerColor(playerId), versionedScope,
    });
    if (!controllerPrepared.success) {
      this.sync.abortSnapshot(prepared.token);
      if (requestToken) this.sync.failSyncRequest(requestToken);
      if (capacityFlow) this._publishCapacityRecoveryState({ generation, manager });
      return { status: "restore_failed", reason: controllerPrepared.reason };
    }
    let installed;
    try { installed = this.controller.installPreparedMatchState(controllerPrepared.token); }
    catch (error) { installed = { success: false, reason: "CONTROLLER_INSTALL_FAILED", error }; }
    if (!installed.success || !this._isCurrent(generation, manager)) {
      this.controller.rollbackPreparedMatchState(controllerPrepared.token);
      this.controller.abortPreparedMatchState(controllerPrepared.token);
      this.sync.abortSnapshot(prepared.token);
      if (requestToken) this.sync.failSyncRequest(requestToken);
      if (capacityFlow && this._isCurrent(generation, manager)) this._publishCapacityRecoveryState({ generation, manager });
      return this._isCurrent(generation, manager) ? { status: "controller_install_failed", reason: installed.reason } : { status: "stale" };
    }
    let committed;
    const deferredFinalize = typeof this.sync.finalizeSnapshot === "function";
    try { committed = this.sync.commitSnapshot(prepared.token, { restoreSucceeded: true, deferFinalize: deferredFinalize && prepared.deferFinalize === true }); }
    catch (error) { committed = { status: "failed", reason: error?.message ?? String(error) }; }
    if (committed.status !== "committed") {
      this.controller.rollbackPreparedMatchState(controllerPrepared.token);
      this.controller.abortPreparedMatchState(controllerPrepared.token);
      if (requestToken) this.sync.failSyncRequest(requestToken);
      if (capacityFlow && this._isCurrent(generation, manager)) this._publishCapacityRecoveryState({ generation, manager });
      return { status: committed.status, reason: committed.reason };
    }
    this._rememberSnapshotPlayers(payload);
    if (!this._isCurrent(generation, manager)) {
      this.controller.rollbackPreparedMatchState(controllerPrepared.token);
      this.controller.abortPreparedMatchState(controllerPrepared.token);
      return { ...committed, status: "stale" };
    }
    const controllerCommit = this.controller.publishPreparedMatchState(controllerPrepared.token);
    if (!this._isCurrent(generation, manager) || !this._matchesCommittedScope(payload, this.sync.getState().scope)) {
      return { ...committed, status: "committed_but_room_changed", state: controllerCommit.state };
    }
    if (!controllerCommit.success) {
      this.sync.markConnectionLost();
      this.controller.setAuthoritativeSnapshotValid(false);
      if (requestToken) this.sync.failSyncRequest(requestToken);
      if (capacityFlow) this._publishCapacityRecoveryState({ generation, manager });
      return { status: "controller_commit_failed", reason: controllerCommit.reason };
    }
    if (!this._isCurrent(generation, manager) || !this._matchesCommittedScope(payload, this.sync.getState().scope)) {
      return { ...committed, status: "committed_but_room_changed", state: controllerCommit.state };
    }
    const metadataCommitted = this._notifyCommitted(payload);
    if (!this._isCurrent(generation, manager) || !this._matchesCommittedScope(payload, this.sync.getState().scope)) {
      return { ...committed, status: "committed_but_room_changed", state: controllerCommit.state, metadataCommitted };
    }
    if (deferredFinalize && prepared.deferFinalize === true && metadataCommitted !== true) {
      this.sync.markConnectionLost();
      this._publishCapacityRecoveryState({ generation, manager });
      return { ...committed, status: "metadata_commit_failed", state: controllerCommit.state, metadataCommitted: false };
    }
    if (deferredFinalize && prepared.deferFinalize === true) {
      committed = this.sync.finalizeSnapshot(committed.finalizeToken);
      if (committed.status !== "committed") {
        if (capacityFlow && this._isCurrent(generation, manager)) this._publishCapacityRecoveryState({ generation, manager });
        return committed;
      }
    }
    if (capacityFlow && typeof this.sync.completeCapacityRecovery === "function") {
      this.sync.completeCapacityRecovery(committed.scope);
    }
    let finalState = controllerCommit.state;
    if (capacityFlow) {
      const published = this._publishCapacityRecoveryState({ generation, manager });
      if (!published) {
        this.sync.clearCapacityRecoveryReady?.(committed.scope);
        this._publishCapacityRecoveryState({ generation, manager });
      } else finalState = this.controller.getGameState?.() ?? controllerCommit.state;
    }
    if (this.sync.getState().capacityBlocked) {
      const unresolvedPending = this.sync.getState().pending.some(item => item.status === "uncertain");
      if (!unresolvedPending) {
        this._clearTimerMap(this._syncRetryTimers, "sync");
        this._syncAttempts = 0;
      }
    }
    return { ...committed, status: "committed", retryActions: committed.retryActions,
      resolvedActionOutcome: committed.resolvedActionOutcome ?? null, metadataCommitted, state: finalState };
  }

  _matchesCommittedScope(payload, scope) {
    return Boolean(scope && payload && scope.serverInstanceId === payload.serverInstanceId
      && scope.roomInstanceId === payload.roomInstanceId && scope.matchGeneration === payload.matchGeneration
      && scope.matchEpoch === payload.matchEpoch && scope.actionSeq === payload.actionSeq);
  }

  _resolveSnapshotColor(playerId, payload) {
    const hasEpochColors = Boolean(payload?.matchState
      && Object.prototype.hasOwnProperty.call(payload.matchState, "matchPlayerColors"));
    if (hasEpochColors) {
      const historicalColors = payload.matchState.matchPlayerColors;
      if (!historicalColors || typeof historicalColors !== "object" || Array.isArray(historicalColors)
        || !Object.prototype.hasOwnProperty.call(historicalColors, playerId)) return null;
      const historicalColor = historicalColors[playerId];
      if (typeof historicalColor !== "string") return null;
      return historicalColor;
    }
    return this._snapshotRosterColor(playerId, payload?.players ?? payload?.matchState?.players);
  }

  _snapshotRosterColor(playerId, players) {
    if (Array.isArray(players)) {
      const player = players.find(item => item?.playerId === playerId || item?.id === playerId);
      return player?.color ?? null;
    }
    if (players && typeof players === "object") {
      const player = players[playerId];
      if (typeof player === "string") return player;
      return player?.color ?? null;
    }
    return null;
  }

  _hasSnapshotMatchPlayers(payload) {
    return Boolean(payload?.matchState && Object.prototype.hasOwnProperty.call(payload.matchState, "matchPlayerColors"));
  }

  _hasSnapshotPlayers(payload) {
    const players = payload?.players ?? payload?.matchState?.players;
    return Array.isArray(players) || Boolean(players && typeof players === "object");
  }

  _rememberSnapshotPlayers(payload) {
    if (!this._hasSnapshotPlayers(payload)) return;
    const players = payload.players ?? payload.matchState?.players;
    const next = new Map();
    if (Array.isArray(players)) {
      for (const player of players) {
        const id = player?.playerId ?? player?.id;
        if (typeof id === "string" && typeof player?.color === "string") next.set(id, player.color);
      }
    } else {
      for (const [id, value] of Object.entries(players)) {
        const color = typeof value === "string" ? value : value?.color;
        if (typeof color === "string") next.set(id, color);
      }
    }
    this._playerColorById = next;
  }

  _onActionSending({ clientActionId, action, manager }) {
    if (this.disposed || manager !== this.manager || manager !== this.getNetworkManager() || (manager.socket ?? null) !== this.socket) {
      throw new Error("Online action coordinator is not attached to the active connection.");
    }
    this._clearAck(clientActionId);
    this._actionAttempts.set(clientActionId, (this._actionAttempts.get(clientActionId) ?? 0) + 1);
    const generation = this.generation;
    const timer = this.setTimeout(() => {
      this._ackTimers.delete(clientActionId);
      if (this._isCurrent(generation, manager)) void this.requestSync({ generation, manager, reason: "ack_timeout" });
    }, this.ackTimeoutMs);
    this._ackTimers.set(clientActionId, timer);
  }

  _onRecoveryRequired(notice) {
    if (!this.disposed && this.manager && this.sync.getState().protocol.status === "selected") {
      void this.requestSync({ reason: notice?.reason ?? "controller_recovery" });
    }
  }

  _scheduleActionRetry(clientActionId, generation, manager) {
    const attempt = this._actionAttempts.get(clientActionId) ?? 1;
    const retryIndex = attempt - 1;
    if (retryIndex >= this.retryDelays.length) {
      this.sync.markUncertain(clientActionId);
      this._scheduleSyncRetry(generation, manager, "retry_limit_reached");
      return;
    }
    this._clearTimerMap(this._retryTimers, clientActionId);
    const timer = this.setTimeout(() => {
      this._retryTimers.delete(clientActionId);
      if (!this._isCurrent(generation, manager)) return;
      const state = this.sync.getState();
      if (state.protocol.status !== "selected" || state.pending[0]?.status !== "retryable") return;
      void this.controller.retryPendingOnlineAction(clientActionId).then(result => {
        if (!result.success) void this.requestSync({ generation, manager, reason: result.reason ?? "retry_failed" });
      }).catch(() => void this.requestSync({ generation, manager, reason: "retry_exception" }));
    }, this.retryDelays[retryIndex]);
    this._retryTimers.set(clientActionId, timer);
  }

  _scheduleSyncRetry(generation, manager, reason) {
    if (!this._isCurrent(generation, manager) || this._syncAttempts >= this.retryDelays.length) return;
    const attempt = this._syncAttempts++;
    this._clearTimerMap(this._syncRetryTimers, "sync");
    const timer = this.setTimeout(() => {
      this._syncRetryTimers.delete("sync");
      void this.requestSync({ generation, manager, reason });
    }, this.retryDelays[attempt]);
    this._syncRetryTimers.set("sync", timer);
  }

  _notifyCommitted(payload) {
    if (typeof this.onCommittedRoomState !== "function") return true;
    try { return this.onCommittedRoomState(payload) !== false; }
    catch (_uiError) { return false; /* A page callback cannot roll back a committed protocol transaction. */ }
  }

  _notifyRejectedAction(outcome, { generation, manager } = {}) {
    if (typeof this.onActionRejected !== "function" || !outcome || outcome.status !== "rejected"
      || outcome.code !== "RATE_LIMITED" || !this._isCurrent(generation, manager)) return false;
    const state = this.sync.getState();
    const current = state.scope;
    const submitted = outcome.scope;
    const committed = outcome.committedScope;
    const sameMatch = (left, right) => Boolean(left && right)
      && left.serverInstanceId === right.serverInstanceId && left.roomInstanceId === right.roomInstanceId
      && left.matchGeneration === right.matchGeneration && left.matchEpoch === right.matchEpoch;
    if (state.protocol.status !== "selected" || state.recoveryRequired || state.pending.length || !current
      || outcome.playerId !== this.playerId || current.localPlayerId !== outcome.playerId
      || !sameMatch(submitted, committed) || !sameMatch(current, committed)
      || current.actionSeq !== outcome.committedActionSeq || committed.actionSeq !== outcome.committedActionSeq) return false;
    try {
      this.onActionRejected({ status: outcome.status, code: outcome.code, clientActionId: outcome.clientActionId,
        playerId: outcome.playerId, scope: submitted, committedScope: committed,
        submittedActionSeq: outcome.submittedActionSeq, committedActionSeq: outcome.committedActionSeq });
      return true;
    } catch (_uiError) {
      return false; // UI feedback cannot change the already committed room transaction.
    }
  }

  _subscribe(event, listener) {
    const unsubscribe = this.manager.on?.(event, payload => {
      try { listener(payload); } catch (_error) { /* Network callbacks fail closed through their own transaction path. */ }
    });
    if (typeof unsubscribe === "function") this._unsubscribers.push(unsubscribe);
  }

  _handleClose(generation, manager) {
    if (this.disposed || generation !== this.generation || manager !== this.manager || manager !== this.getNetworkManager()) return;
    if (manager.socket != null) return;
    this.generation += 1;
    this.socket = manager.socket ?? null;
    this.connectionOpen = false;
    this._clearAllTimers();
    this._syncPromise = null;
    this._negotiation = null;
    if (this.sync.getState().scope) {
      const capacityBlocked = this.sync.getState().capacityBlocked;
      this.sync.markConnectionLost();
      if (capacityBlocked) this._publishCapacityRecoveryState({ generation: this.generation, manager });
    }
  }

  _detachManager({ markLost = false, keepManager = false } = {}) {
    this.generation += 1;
    for (const unsubscribe of this._unsubscribers.splice(0)) {
      try { unsubscribe(); } catch (_error) {}
    }
    this._clearAllTimers();
    this._syncPromise = null;
    if (markLost && this.sync.getState().scope) {
      const capacityBlocked = this.sync.getState().capacityBlocked;
      this.sync.markConnectionLost();
      if (capacityBlocked) this._publishCapacityRecoveryState({ generation: this.generation, manager: this.manager });
    }
    if (!keepManager) this.manager = null;
    this.connectionOpen = false;
  }

  _clearAck(id) { this._clearTimerMap(this._ackTimers, id); }
  _clearTimerMap(map, key) {
    const timer = map.get(key);
    if (timer !== undefined) this.clearTimeout(timer);
    map.delete(key);
  }
  _clearAllTimers() {
    for (const map of [this._ackTimers, this._retryTimers, this._syncRetryTimers]) {
      for (const timer of map.values()) this.clearTimeout(timer);
      map.clear();
    }
  }
  _isCurrent(generation, manager) {
    return !this.disposed && this.connectionOpen && this._managerIsConnected(manager) && this.socket !== null
      && generation === this.generation && manager === this.manager && manager === this.getNetworkManager()
      && (manager.socket ?? null) === this.socket && this.isCurrentOwner();
  }

  _managerIsConnected(manager) {
    if (!manager) return false;
    if (typeof manager.isConnected === "function") return manager.isConnected() === true;
    return manager.socket != null;
  }

  confirmRoomLeft() {
    this._detachManager({ markLost: false });
    this.sync.clearRoom();
    this._playerColorById.clear();
    this._actionAttempts.clear(); this._syncAttempts = 0;
    this._capacitySyncKey = null;
    this.controller.bindOnlineActionSync({ sync: null, playerId: null, onRecoveryRequired: null, onActionSending: null });
  }

  dispose({ leftRoom = false } = {}) {
    if (this.disposed) return;
    this.disposed = true;
    this._detachManager({ markLost: !leftRoom });
    if (leftRoom) { this.sync.clearRoom(); this._playerColorById.clear(); }
    this._actionAttempts.clear(); this._syncAttempts = 0;
    this._capacitySyncKey = null;
    this.controller.bindOnlineActionSync({ sync: leftRoom ? null : this.sync, playerId: leftRoom ? null : this.playerId,
      onRecoveryRequired: null, onActionSending: null });
  }
}

export default OnlineActionSyncCoordinator;
