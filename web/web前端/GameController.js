import GameEngine, { Player, TerritoryRulesVersion } from "./GameEngine.js?v=20260830a";
import Renderer from "./Renderer.js?v=20260830a";
import { ServerEvent } from "./NetworkManager.js?v=20260430d";

// GameController 鏄墠绔殑鈥滆兌姘村眰鈥濓細
// 瀹冩妸 Model(GameEngine)銆乂iew(Renderer) 鍜岃仈鏈哄眰(NetworkManager) 涓茶捣鏉ワ紝
// 瀵瑰鏆撮湶缁熶竴鐨勬父鎴忕姸鎬佷笌鎿嶄綔鎺ュ彛锛屽敖閲忎笉璁?Vue 鐩存帴纰板簳灞傜粏鑺傘€?
const DEFAULT_ENGINE_OPTIONS = Object.freeze({
  playerCount: 2,
  gridSize: 9,
  rulesVersion: TerritoryRulesVersion.V2,
});

function clonePoint(point) {
  return [point[0], point[1]];
}

function distanceBetween(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function isKnownPlayer(player) {
  return player === Player.BLACK || player === Player.WHITE || player === Player.PURPLE;
}

function isGridPoint(point) {
  return Array.isArray(point)
    && point.length === 2
    && Number.isInteger(point[0])
    && Number.isInteger(point[1]);
}

export class GameController {
  constructor(canvas, options = {}) {
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error("GameController expects a valid <canvas> element.");
    }

    this.canvas = canvas;
    this.options = {
      ...options,
      engine: {
        ...DEFAULT_ENGINE_OPTIONS,
        ...(options.engine ?? {}),
      },
    };
    // 只要配置变化需要立即生效，就整体重建引擎，避免残留旧棋盘状态。
    this.engine = new GameEngine(this.options.engine);
    this._validGridPoints = this.engine.getValidPositions();
    this.renderer = new Renderer(canvas, options.renderer ?? {});
    this._engineEpoch = 1;
    this.stateChangeListener = typeof options.onStateChange === "function" ? options.onStateChange : null;
    this.networkErrorListener = typeof options.onNetworkError === "function" ? options.onNetworkError : null;

    this.multiplayerEnabled = false;
    this.localPlayer = null;
    this.roomReady = false;
    this.opponentConnected = false;
    this.networkManager = null;
    this.lastAction = null;
    this._networkUnsubscribers = [];
    this._authoritativeSnapshotValid = true;

    this._isInitialized = false;
    this._boundHandleClick = this._handleClick.bind(this);
    this._boundHandleTouchStart = this._handleTouchStart.bind(this);

    if (options.networkManager || options.multiplayer) {
      this.enableMultiplayer({
        networkManager: options.networkManager ?? null,
        localPlayer: options.localPlayer ?? null,
        roomReady: options.roomReady ?? false,
        opponentConnected: options.opponentConnected ?? false,
      });
    }
  }

  _updateLargeBoardClass() {
    const gridSize = this.options.engine?.gridSize ?? 9;
    if (typeof document !== "undefined" && document.body) {
      if (gridSize >= 15) {
        document.body.classList.add("large-board");
      } else {
        document.body.classList.remove("large-board");
      }
    }
  }

  _replaceEngine(engineOptions = this.options.engine ?? {}) {
    this.engine = new GameEngine(engineOptions);
    this._validGridPoints = this.engine.getValidPositions();
    this._engineEpoch += 1;
    this.renderer.invalidate();
    return this.engine;
  }

  init() {
    if (!this._isInitialized) {
      this.canvas.addEventListener("click", this._boundHandleClick);
      this.canvas.addEventListener("touchstart", this._boundHandleTouchStart, { passive: false });
      this._isInitialized = true;
    }

    this._updateLargeBoardClass();
    const snapshot = this.engine.getSnapshot();
    this.renderer.render({
      ...snapshot,
      renderEpoch: this._engineEpoch,
      lastAction: this._cloneLastAction(),
    });
    this._syncCanvasInteractivity(snapshot);
    this._emitStateChange(snapshot);
    return snapshot;
  }

  destroy() {
    if (this._isInitialized) {
      this.canvas.removeEventListener("click", this._boundHandleClick);
      this.canvas.removeEventListener("touchstart", this._boundHandleTouchStart);
      this._isInitialized = false;
    }

    this._removeNetworkListeners();
    this.renderer.destroy();
  }

  setStateChangeListener(listener) {
    this.stateChangeListener = typeof listener === "function" ? listener : null;
  }

  setNetworkErrorListener(listener) {
    this.networkErrorListener = typeof listener === "function" ? listener : null;
  }

  setGameConfig(engineOptions = {}, reset = true) {
    this.options.engine = {
      ...DEFAULT_ENGINE_OPTIONS,
      ...this.options.engine,
      ...(engineOptions ?? {}),
    };

    if (!reset) {
      return this.options.engine;
    }

    this._replaceEngine(this.options.engine);
    this._setLastAction(null);
    this._updateLargeBoardClass();
    const snapshot = this.engine.getSnapshot();
    this._syncSnapshot(snapshot);
    return this._buildGameState(snapshot);
  }

  setNetworkManager(networkManager) {
    if (this.networkManager === networkManager) {
      return;
    }

    this._removeNetworkListeners();
    this.networkManager = networkManager ?? null;

    if (!this.networkManager || typeof this.networkManager.on !== "function") {
      return;
    }

    // OnlineApp owns complete room snapshots and lifecycle state. The controller
    // only applies incremental gameplay events so one server frame has one owner.
    this._networkUnsubscribers.push(
      this.networkManager.on(ServerEvent.OPPONENT_MOVE, (payload) => {
        if (isGridPoint(payload.point)) {
          this.applyRemoteMove(payload.point);
        } else {
          this._reportNetworkError(new Error("Received invalid OPPONENT_MOVE payload."));
        }
      }),
    );

    this._networkUnsubscribers.push(
      this.networkManager.on(ServerEvent.TURN_SKIPPED, () => {
        this.applyRemoteSkip();
      }),
    );

    this._networkUnsubscribers.push(
      this.networkManager.on(ServerEvent.PLAYER_RESIGNED, (payload) => {
        this.applyRemoteResign(payload?.color);
      }),
    );

  }

  enableMultiplayer(options = {}, syncState = true) {
    return this.setMultiplayerState({
      enabled: true,
      ...options,
    }, syncState);
  }

  disableMultiplayer() {
    this._removeNetworkListeners();
    this.networkManager = null;
    this._authoritativeSnapshotValid = true;
    return this.setMultiplayerState({
      enabled: false,
      localPlayer: null,
      roomReady: false,
      opponentConnected: false,
    });
  }

  setMultiplayerState(partial = {}, syncState = true) {
    if (Object.prototype.hasOwnProperty.call(partial, "networkManager")) {
      this.setNetworkManager(partial.networkManager);
    }

    if (Object.prototype.hasOwnProperty.call(partial, "enabled")) {
      this.multiplayerEnabled = Boolean(partial.enabled);
    }

    if (Object.prototype.hasOwnProperty.call(partial, "localPlayer")) {
      this.localPlayer = partial.localPlayer ?? null;
    }

    if (Object.prototype.hasOwnProperty.call(partial, "roomReady")) {
      this.roomReady = Boolean(partial.roomReady);
    }

    if (Object.prototype.hasOwnProperty.call(partial, "opponentConnected")) {
      this.opponentConnected = Boolean(partial.opponentConnected);
    }

    if (!this.multiplayerEnabled) {
      this.roomReady = false;
      this.opponentConnected = false;
    }

    if (!syncState) {
      return null;
    }

    const snapshot = this.engine.getSnapshot();
    const nextState = this._buildGameState(snapshot);
    this._syncCanvasInteractivity(snapshot, nextState);
    this._emitStateChange(snapshot, nextState);
    return nextState;
  }

  _emitStateChange(snapshot, state = null) {
    if (this.stateChangeListener) {
      this.stateChangeListener(state ?? this._buildGameState(snapshot));
    }
  }

  setAuthoritativeSnapshotValid(isValid) {
    this._authoritativeSnapshotValid = Boolean(isValid);
    if (!this._authoritativeSnapshotValid && this.multiplayerEnabled) {
      this.roomReady = false;
      this.opponentConnected = false;
    }
  }

  _cloneLastAction() {
    if (!this.lastAction) {
      return null;
    }

    return {
      ...this.lastAction,
      point: Array.isArray(this.lastAction.point) ? [...this.lastAction.point] : null,
    };
  }

  _setLastAction(action = null) {
    if (!action) {
      this.lastAction = null;
      return;
    }

    this.lastAction = {
      type: action.type ?? null,
      player: action.player ?? null,
      point: Array.isArray(action.point) ? [...action.point] : null,
    };
  }

  _buildGameState(snapshot = this.engine.getSnapshot()) {
    // 这里把底层快照补齐成 UI 可直接消费的状态，包含联机锁定原因等派生字段。
    const black = snapshot.territories?.[Player.BLACK] ?? { area: 0, polygon: null };
    const white = snapshot.territories?.[Player.WHITE] ?? { area: 0, polygon: null };
    const purple = snapshot.territories?.[Player.PURPLE] ?? { area: 0, polygon: null };
    const interactionLockReason = this._getInteractionLockReason(snapshot);
    const skipLockReason = this._getSkipLockReason(snapshot);
    const resetLockReason = this._getResetLockReason(snapshot);

    return {
      rulesVersion: snapshot.rulesVersion,
      positionRevision: snapshot.positionRevision,
      currentPlayer: snapshot.currentPlayer,
      gameOver: snapshot.gameOver,
      winner: snapshot.winner,
      turnCount: snapshot.turnCount,
      consecutiveSkips: snapshot.consecutiveSkips,
      resignedPlayers: Array.isArray(snapshot.resignedPlayers) ? [...snapshot.resignedPlayers] : [],
      scores: {
        [Player.BLACK]: black.area,
        [Player.WHITE]: white.area,
        [Player.PURPLE]: purple.area,
      },
      displayScores: {
        [Player.BLACK]: black.displayArea ?? black.area,
        [Player.WHITE]: white.displayArea ?? white.area,
        [Player.PURPLE]: purple.displayArea ?? purple.area,
      },
      territories: snapshot.territories,
      legalMoves: snapshot.legalMoves,
      snapshot,
      lastAction: this._cloneLastAction(),
      players: Array.isArray(snapshot.players)
        ? [...snapshot.players]
        : [Player.BLACK, Player.WHITE, Player.PURPLE].slice(0, snapshot.playerCount ?? this.options.engine.playerCount),
      playerCount: snapshot.playerCount ?? this.options.engine.playerCount,
      multiplayerEnabled: this.multiplayerEnabled,
      localPlayer: this.localPlayer,
      roomReady: this.roomReady,
      opponentConnected: this.opponentConnected,
      isLocalTurn: isKnownPlayer(this.localPlayer) && snapshot.currentPlayer === this.localPlayer,
      interactionLocked: Boolean(interactionLockReason),
      interactionLockReason,
      skipLocked: Boolean(skipLockReason),
      skipLockReason,
      resetLocked: Boolean(resetLockReason),
      resetLockReason,
    };
  }

  _getCanvasRelativePosition(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  }

  _findNearestGridPoint(pixelX, pixelY) {
    const validPoints = this._validGridPoints?.length
      ? this._validGridPoints
      : this._deriveValidPoints(this.engine.gridSize ?? this.options.engine.gridSize);

    let nearestPoint = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const point of validPoints) {
      const pixelPoint = this.renderer.getPointPixelCoordinates(point);
      const distance = distanceBetween({ x: pixelX, y: pixelY }, pixelPoint);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestPoint = point;
      }
    }

    const threshold = this.renderer.getHitRadius();
    if (!nearestPoint || nearestDistance > threshold) {
      return null;
    }

    return clonePoint(nearestPoint);
  }

  _deriveValidPoints(gridSize) {
    const points = [];
    for (let y = 0; y < gridSize; y += 1) {
      for (let x = 0; x < gridSize - y; x += 1) {
        points.push([x, y]);
      }
    }
    return points;
  }

  _getInteractionLockReason(snapshot = this.engine.getSnapshot()) {
    if (snapshot.gameOver) {
      return "GAME_OVER";
    }

    if (!this.multiplayerEnabled) {
      return null;
    }

    if (this._authoritativeSnapshotValid === false) {
      return "AUTHORITATIVE_SNAPSHOT_INVALID";
    }

    if (!this.roomReady) {
      return "ROOM_NOT_READY";
    }

    if (!this.opponentConnected) {
      return "OPPONENT_OFFLINE";
    }

    if (!isKnownPlayer(this.localPlayer)) {
      return "LOCAL_PLAYER_UNASSIGNED";
    }

    if (!this.networkManager || typeof this.networkManager.sendMove !== "function") {
      return "NETWORK_UNAVAILABLE";
    }

    if (typeof this.networkManager.isConnected === "function" && !this.networkManager.isConnected()) {
      return "NETWORK_UNAVAILABLE";
    }

    if (snapshot.currentPlayer !== this.localPlayer) {
      return "NOT_YOUR_TURN";
    }

    return null;
  }

  _getSkipLockReason(snapshot = this.engine.getSnapshot()) {
    if (snapshot.gameOver) {
      return "GAME_OVER";
    }

    if (!this.multiplayerEnabled) {
      return null;
    }

    return this._getInteractionLockReason(snapshot);
  }

  _getResetLockReason(snapshot = this.engine.getSnapshot()) {
    if (!this.multiplayerEnabled) {
      return null;
    }

    if (this._authoritativeSnapshotValid === false) {
      return "AUTHORITATIVE_SNAPSHOT_INVALID";
    }

    if (!this.roomReady) {
      return "ROOM_NOT_READY";
    }

    if (!this.opponentConnected) {
      return "OPPONENT_OFFLINE";
    }

    if (!isKnownPlayer(this.localPlayer)) {
      return "LOCAL_PLAYER_UNASSIGNED";
    }

    if (!this.networkManager || typeof this.networkManager.sendReset !== "function") {
      return "NETWORK_UNAVAILABLE";
    }

    if (typeof this.networkManager.isConnected === "function" && !this.networkManager.isConnected()) {
      return "NETWORK_UNAVAILABLE";
    }

    return null;
  }

  _syncCanvasInteractivity(snapshot = this.engine.getSnapshot(), state = null) {
    const interactionLockReason = state?.interactionLockReason ?? this._getInteractionLockReason(snapshot);
    const locked = Boolean(interactionLockReason);
    this.canvas.style.cursor = locked ? "not-allowed" : "pointer";
    this.canvas.setAttribute("aria-disabled", locked ? "true" : "false");
  }

  _syncSnapshot(snapshot) {
    this.renderer.render({
      ...snapshot,
      renderEpoch: this._engineEpoch,
      lastAction: this._cloneLastAction(),
    });
    this._syncCanvasInteractivity(snapshot);
    this._emitStateChange(snapshot);
  }

  _applyMove(point, actingPlayer = this.engine.getCurrentPlayer()) {
    const normalizedPoint = clonePoint(point);
    const result = this.engine.playMove(normalizedPoint);

    if (result.success) {
      this._setLastAction({
        type: "move",
        player: actingPlayer,
        point: normalizedPoint,
      });
      this._syncSnapshot(result.snapshot);
    }

    return {
      success: result.success,
      reason: result.reason,
      point: normalizedPoint,
      state: this._buildGameState(result.snapshot),
    };
  }

  _reportNetworkError(error) {
    if (this.networkErrorListener) {
      this.networkErrorListener(error);
      return;
    }

    console.error(error);
  }

  async _syncLocalMove(point) {
    if (!this.multiplayerEnabled || !this.networkManager) {
      return;
    }

    try {
      await this.networkManager.sendMove(point);
    } catch (error) {
      this._reportNetworkError(error);
    }
  }

  _processPointer(clientX, clientY) {
    const snapshot = this.engine.getSnapshot();
    const lockReason = this._getInteractionLockReason(snapshot);
    if (lockReason) {
      return {
        success: false,
        reason: lockReason,
        state: this._buildGameState(snapshot),
      };
    }

    const relative = this._getCanvasRelativePosition(clientX, clientY);
    const point = this._findNearestGridPoint(relative.x, relative.y);
    if (!point) {
      return {
        success: false,
        reason: "MISS",
        state: this._buildGameState(snapshot),
      };
    }

    const result = this._applyMove(point, snapshot.currentPlayer);
    if (result.success) {
      void this._syncLocalMove(point);
    }

    return result;
  }

  _handleClick(event) {
    this._processPointer(event.clientX, event.clientY);
  }

  _handleTouchStart(event) {
    event.preventDefault();
    const touch = event.touches[0];
    if (!touch) {
      return;
    }
    this._processPointer(touch.clientX, touch.clientY);
  }

  applyRemoteMove(point) {
    const recoveryLock = this._getRemoteRecoveryLock();
    if (recoveryLock) {
      return recoveryLock;
    }

    if (!isGridPoint(point)) {
      return {
        success: false,
        reason: "INVALID_REMOTE_MOVE",
        state: this.getGameState(),
      };
    }

    const result = this._applyMove(point);
    if (!result.success) {
      this._reportNetworkError(new Error(`Remote move could not be applied: ${result.reason}`));
    }
    return result;
  }

  applyRemoteSkip() {
    const recoveryLock = this._getRemoteRecoveryLock();
    if (recoveryLock) {
      return recoveryLock;
    }

    const actingPlayer = this.engine.getCurrentPlayer();
    const result = this.engine.skipTurn();
    if (result.success) {
      this._setLastAction({
        type: "skip",
        player: actingPlayer,
        point: null,
      });
      this._syncSnapshot(result.snapshot);
    } else {
      this._reportNetworkError(new Error(`Remote skip could not be applied: ${result.reason}`));
    }

    return {
      success: result.success,
      reason: result.reason,
      state: this._buildGameState(result.snapshot),
    };
  }

  applyRemoteResign(player) {
    const recoveryLock = this._getRemoteRecoveryLock();
    if (recoveryLock) {
      return recoveryLock;
    }

    const targetPlayer = isKnownPlayer(player) ? player : this.engine.getSnapshot().currentPlayer;
    const result = this.engine.resignPlayer(targetPlayer);
    if (result.success) {
      this._setLastAction({
        type: "resign",
        player: targetPlayer,
        point: null,
      });
      this._syncSnapshot(result.snapshot);
    } else if (result.reason !== "PLAYER_ALREADY_RESIGNED") {
      this._reportNetworkError(new Error(`Remote resignation could not be applied: ${result.reason}`));
    }

    return {
      success: result.success,
      reason: result.reason,
      state: this._buildGameState(result.snapshot),
    };
  }

  applyRemoteReset() {
    return this.resetGame({ force: true });
  }

  _getRemoteRecoveryLock() {
    if (this._authoritativeSnapshotValid !== false) {
      return null;
    }
    const snapshot = this.engine.getSnapshot();
    return {
      success: false,
      reason: "AUTHORITATIVE_SNAPSHOT_INVALID",
      state: this._buildGameState(snapshot),
    };
  }

  restoreMatchState(matchState = null) {
    // 联机重连后，在临时引擎上批量回放；只有完整成功才替换当前棋盘。
    const actions = Array.isArray(matchState?.actions) ? matchState.actions : [];
    const incomingSettings = matchState?.settings;
    const nextEngineOptions = {
      ...DEFAULT_ENGINE_OPTIONS,
      ...(this.options.engine ?? {}),
      ...(incomingSettings && typeof incomingSettings === "object" ? incomingSettings : {}),
    };

    const preserveCurrentEngine = (reason, preservedSnapshot = null) => {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      this._reportNetworkError(error);
      if (this.multiplayerEnabled) {
        // A rejected authoritative snapshot must never unlock the preserved board.
        this.setAuthoritativeSnapshotValid(false);
      }
      const snapshot = preservedSnapshot ?? this.engine.getSnapshot();
      const state = this._buildGameState(snapshot);
      this._syncCanvasInteractivity(snapshot, state);
      return {
        success: false,
        reason: error.message,
        state,
      };
    };

    let candidateEngine;
    let replayResult;
    try {
      candidateEngine = new GameEngine(nextEngineOptions);
      replayResult = candidateEngine.replayBatch((engine) => {
        let lastAction = null;

        for (let index = 0; index < actions.length; index += 1) {
          const action = actions[index];
          if (!action || typeof action.type !== "string") {
            return {
              success: false,
              reason: `Replay action ${index + 1} is malformed.`,
            };
          }

          if (action.type === "player_move") {
            if (!isGridPoint(action.point)) {
              return {
                success: false,
                reason: `Replay move ${index + 1} has an invalid point.`,
              };
            }
            const actingPlayer = engine.getCurrentPlayer();
            const result = engine.playMove(clonePoint(action.point));
            if (!result.success) {
              return {
                success: false,
                reason: `Replay move ${index + 1} failed: ${result.reason}`,
              };
            }
            lastAction = {
              type: "move",
              player: actingPlayer,
              point: clonePoint(action.point),
            };
            continue;
          }

          if (action.type === "player_skip") {
            const actingPlayer = engine.getCurrentPlayer();
            const result = engine.skipTurn();
            if (!result.success) {
              return {
                success: false,
                reason: `Replay skip ${index + 1} failed: ${result.reason}`,
              };
            }
            lastAction = {
              type: "skip",
              player: actingPlayer,
              point: null,
            };
            continue;
          }

          if (action.type === "player_resign") {
            if (!isKnownPlayer(action.color)) {
              return {
                success: false,
                reason: `Replay resignation ${index + 1} has an invalid player.`,
              };
            }
            const result = engine.resignPlayer(action.color);
            if (!result.success && result.reason !== "PLAYER_ALREADY_RESIGNED") {
              return {
                success: false,
                reason: `Replay resignation ${index + 1} failed: ${result.reason}`,
              };
            }
            lastAction = {
              type: "resign",
              player: action.color,
              point: null,
            };
            continue;
          }

          return {
            success: false,
            reason: `Replay action ${index + 1} has unsupported type: ${action.type}.`,
          };
        }

        return {
          success: true,
          reason: null,
          lastAction,
        };
      });
    } catch (error) {
      return preserveCurrentEngine(error);
    }

    if (!replayResult.success) {
      return preserveCurrentEngine(replayResult.reason);
    }

    const previousControllerState = {
      engine: this.engine,
      engineOptions: this.options.engine,
      validGridPoints: this._validGridPoints,
      engineEpoch: this._engineEpoch,
      lastAction: this._cloneLastAction(),
    };

    try {
      this.options.engine = nextEngineOptions;
      this.engine = candidateEngine;
      this._validGridPoints = candidateEngine.getValidPositions();
      this._engineEpoch += 1;
      this.setAuthoritativeSnapshotValid(true);
      this.renderer.invalidate();
      this._setLastAction(replayResult.lastAction);
      this._updateLargeBoardClass();
      this._syncSnapshot(replayResult.snapshot);
    } catch (error) {
      this.options.engine = previousControllerState.engineOptions;
      this.engine = previousControllerState.engine;
      this._validGridPoints = previousControllerState.validGridPoints;
      this._engineEpoch = previousControllerState.engineEpoch;
      this._setLastAction(previousControllerState.lastAction);
      this._updateLargeBoardClass();
      const previousSnapshot = this.engine.getSnapshot();
      try {
        this.renderer.invalidate();
        this.renderer.render({
          ...previousSnapshot,
          renderEpoch: this._engineEpoch,
          lastAction: this._cloneLastAction(),
        });
      } catch {
        // The original controller state is restored even if renderer recovery
        // cannot repaint; preserveCurrentEngine still locks interaction below.
      }
      return preserveCurrentEngine(error, previousSnapshot);
    }

    return {
      success: true,
      reason: null,
      state: this._buildGameState(replayResult.snapshot),
    };
  }

  skipTurn() {
    if (this.multiplayerEnabled) {
      return {
        success: false,
        reason: "MULTIPLAYER_SKIP_UNSUPPORTED",
        state: this.getGameState(),
      };
    }

    const actingPlayer = this.engine.getCurrentPlayer();
    const result = this.engine.skipTurn();
    if (result.success) {
      this._setLastAction({
        type: "skip",
        player: actingPlayer,
        point: null,
      });
      this._syncSnapshot(result.snapshot);
    }
    return {
      success: result.success,
      reason: result.reason,
      state: this._buildGameState(result.snapshot),
    };
  }

  async requestSkipTurn() {
    const lockReason = this._getSkipLockReason();
    if (lockReason) {
      return {
        success: false,
        reason: lockReason,
        state: this.getGameState(),
      };
    }

    try {
      await this.networkManager.sendSkip();
      return {
        success: true,
        reason: null,
        state: this.getGameState(),
      };
    } catch (error) {
      this._reportNetworkError(error);
      return {
        success: false,
        reason: "NETWORK_ERROR",
        state: this.getGameState(),
      };
    }
  }

  async requestResign() {
    const lockReason = this._getResetLockReason();
    if (lockReason) {
      return {
        success: false,
        reason: lockReason,
        state: this.getGameState(),
      };
    }

    try {
      await this.networkManager.sendResign();
      return {
        success: true,
        reason: null,
        state: this.getGameState(),
      };
    } catch (error) {
      this._reportNetworkError(error);
      return {
        success: false,
        reason: "NETWORK_ERROR",
        state: this.getGameState(),
      };
    }
  }

  async requestResetMatch(options = {}) {
    const lockReason = this._getResetLockReason();
    if (lockReason) {
      return this.getGameState();
    }

    const reason = options.reason === "normal_restart" ? "normal_restart" : "resign_restart";

    try {
      // 三人模式下这里会先收到 RESET_STATUS，等全员确认后才会真正收到 MATCH_RESET。
      await this.networkManager.sendReset(reason);
    } catch (error) {
      this._reportNetworkError(error);
    }

    return this.getGameState();
  }

  resetGame(options = {}) {
    if (this.multiplayerEnabled && options.force !== true) {
      return this.getGameState();
    }

    this._replaceEngine(this.options.engine ?? {});
    this._setLastAction(null);
    const snapshot = this.engine.getSnapshot();
    this._syncSnapshot(snapshot);
    return this._buildGameState(snapshot);
  }

  resignPlayer(player = null) {
    if (this.multiplayerEnabled) {
      return {
        success: false,
        reason: "MULTIPLAYER_RESIGN_UNSUPPORTED",
        state: this.getGameState(),
      };
    }

    const targetPlayer = isKnownPlayer(player) ? player : this.engine.getCurrentPlayer();
    const result = this.engine.resignPlayer(targetPlayer);
    if (result.success) {
      this._setLastAction({
        type: "resign",
        player: targetPlayer,
        point: null,
      });
      this._syncSnapshot(result.snapshot);
    }
    return {
      success: result.success,
      reason: result.reason,
      state: this._buildGameState(result.snapshot),
    };
  }

  getGameState() {
    return this._buildGameState(this.engine.getSnapshot());
  }

  _removeNetworkListeners() {
    for (const unsubscribe of this._networkUnsubscribers) {
      if (typeof unsubscribe === "function") {
        unsubscribe();
      }
    }
    this._networkUnsubscribers = [];
  }
}

export default GameController;
