import GameEngine, { Player } from "./GameEngine.js?v=20260417b";
import Renderer from "./Renderer.js?v=20260417b";
import { ClientEvent, ServerEvent } from "./NetworkManager.js?v=20260417b";

const DEFAULT_ENGINE_OPTIONS = Object.freeze({
  playerCount: 2,
  gridSize: 9,
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
    this.engine = new GameEngine(this.options.engine);
    this.renderer = new Renderer(canvas, options.renderer ?? {});
    this.stateChangeListener = typeof options.onStateChange === "function" ? options.onStateChange : null;
    this.networkErrorListener = typeof options.onNetworkError === "function" ? options.onNetworkError : null;

    this.multiplayerEnabled = false;
    this.localPlayer = null;
    this.roomReady = false;
    this.opponentConnected = false;
    this.networkManager = null;
    this._networkUnsubscribers = [];

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

  init() {
    if (!this._isInitialized) {
      this.canvas.addEventListener("click", this._boundHandleClick);
      this.canvas.addEventListener("touchstart", this._boundHandleTouchStart, { passive: false });
      this._isInitialized = true;
    }

    const snapshot = this.engine.getSnapshot();
    this.renderer.render(snapshot);
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

    this.engine = new GameEngine(this.options.engine);
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

    this._networkUnsubscribers.push(
      this.networkManager.on(ServerEvent.ROOM_CREATED, (payload) => {
        this.setMultiplayerState({
          enabled: true,
          localPlayer: payload.color ?? this.localPlayer,
          roomReady: false,
          opponentConnected: false,
        });
      }),
    );

    this._networkUnsubscribers.push(
      this.networkManager.on(ServerEvent.ROOM_JOINED, (payload) => {
        const ready = payload.status === "READY";
        this.setMultiplayerState({
          enabled: true,
          localPlayer: payload.color ?? this.localPlayer,
          roomReady: ready,
          opponentConnected: ready,
        });
      }),
    );

    this._networkUnsubscribers.push(
      this.networkManager.on(ServerEvent.ROOM_READY, (payload) => {
        this.setMultiplayerState({
          enabled: true,
          localPlayer: payload.yourColor ?? this.localPlayer,
          roomReady: true,
          opponentConnected: true,
        });
      }),
    );

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
      this.networkManager.on(ServerEvent.MATCH_RESET, () => {
        this.applyRemoteReset();
      }),
    );

    this._networkUnsubscribers.push(
      this.networkManager.on(ServerEvent.PLAYER_LEFT, () => {
        this.setMultiplayerState({
          enabled: true,
          roomReady: false,
          opponentConnected: false,
        });
      }),
    );

    this._networkUnsubscribers.push(
      this.networkManager.on(ClientEvent.CLOSE, () => {
        if (this.multiplayerEnabled) {
          this.setMultiplayerState({
            enabled: true,
            roomReady: false,
            opponentConnected: false,
          });
        }
      }),
    );
  }

  enableMultiplayer(options = {}) {
    return this.setMultiplayerState({
      enabled: true,
      ...options,
    });
  }

  disableMultiplayer() {
    this._removeNetworkListeners();
    this.networkManager = null;
    return this.setMultiplayerState({
      enabled: false,
      localPlayer: null,
      roomReady: false,
      opponentConnected: false,
    });
  }

  setMultiplayerState(partial = {}) {
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

    const snapshot = this.engine.getSnapshot();
    this._syncCanvasInteractivity(snapshot);
    this._emitStateChange(snapshot);
    return this._buildGameState(snapshot);
  }

  _emitStateChange(snapshot) {
    if (this.stateChangeListener) {
      this.stateChangeListener(this._buildGameState(snapshot));
    }
  }

  _buildGameState(snapshot = this.engine.getSnapshot()) {
    const black = snapshot.territories?.[Player.BLACK] ?? { area: 0, polygon: null };
    const white = snapshot.territories?.[Player.WHITE] ?? { area: 0, polygon: null };
    const purple = snapshot.territories?.[Player.PURPLE] ?? { area: 0, polygon: null };
    const interactionLockReason = this._getInteractionLockReason(snapshot);
    const skipLockReason = this._getSkipLockReason(snapshot);
    const resetLockReason = this._getResetLockReason(snapshot);

    return {
      currentPlayer: snapshot.currentPlayer,
      gameOver: snapshot.gameOver,
      winner: snapshot.winner,
      turnCount: snapshot.turnCount,
      consecutiveSkips: snapshot.consecutiveSkips,
      scores: {
        [Player.BLACK]: black.area,
        [Player.WHITE]: white.area,
        [Player.PURPLE]: purple.area,
      },
      territories: snapshot.territories,
      legalMoves: snapshot.legalMoves,
      snapshot,
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
    const snapshot = this.engine.getSnapshot();
    const validPoints = typeof this.engine.getValidPositions === "function"
      ? this.engine.getValidPositions()
      : this._deriveValidPoints(snapshot.gridSize);

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

  _syncCanvasInteractivity(snapshot = this.engine.getSnapshot()) {
    const locked = Boolean(this._getInteractionLockReason(snapshot));
    this.canvas.style.cursor = locked ? "not-allowed" : "pointer";
    this.canvas.setAttribute("aria-disabled", locked ? "true" : "false");
  }

  _syncSnapshot(snapshot) {
    this.renderer.render(snapshot);
    this._syncCanvasInteractivity(snapshot);
    this._emitStateChange(snapshot);
  }

  _applyMove(point) {
    const normalizedPoint = clonePoint(point);
    const result = this.engine.playMove(normalizedPoint);

    if (result.success) {
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
    const lockReason = this._getInteractionLockReason();
    if (lockReason) {
      return {
        success: false,
        reason: lockReason,
        state: this.getGameState(),
      };
    }

    const relative = this._getCanvasRelativePosition(clientX, clientY);
    const point = this._findNearestGridPoint(relative.x, relative.y);
    if (!point) {
      return {
        success: false,
        reason: "MISS",
        state: this.getGameState(),
      };
    }

    const result = this._applyMove(point);
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
    const result = this.engine.skipTurn();
    if (result.success) {
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

  applyRemoteReset() {
    return this.resetGame({ force: true });
  }

  restoreMatchState(matchState = null) {
    const actions = Array.isArray(matchState?.actions) ? matchState.actions : [];
    const incomingSettings = matchState?.settings;
    if (incomingSettings && typeof incomingSettings === "object") {
      this.setGameConfig(incomingSettings, false);
    }
    this.engine = new GameEngine(this.options.engine ?? {});

    for (const action of actions) {
      if (!action || typeof action.type !== "string") {
        continue;
      }

      if (action.type === "player_move" && isGridPoint(action.point)) {
        const result = this.engine.playMove(clonePoint(action.point));
        if (!result.success) {
          this._reportNetworkError(new Error(`Replay move failed: ${result.reason}`));
          break;
        }
        continue;
      }

      if (action.type === "player_skip") {
        const result = this.engine.skipTurn();
        if (!result.success) {
          this._reportNetworkError(new Error(`Replay skip failed: ${result.reason}`));
          break;
        }
      }
    }

    const snapshot = this.engine.getSnapshot();
    this._syncSnapshot(snapshot);
    return this._buildGameState(snapshot);
  }

  skipTurn() {
    if (this.multiplayerEnabled) {
      return {
        success: false,
        reason: "MULTIPLAYER_SKIP_UNSUPPORTED",
        state: this.getGameState(),
      };
    }

    const result = this.engine.skipTurn();
    if (result.success) {
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

  async requestResetMatch(options = {}) {
    const lockReason = this._getResetLockReason();
    if (lockReason) {
      return this.getGameState();
    }

    const reason = options.reason === "normal_restart" ? "normal_restart" : "resign_restart";

    try {
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

    this.engine = new GameEngine(this.options.engine ?? {});
    const snapshot = this.engine.getSnapshot();
    this._syncSnapshot(snapshot);
    return this._buildGameState(snapshot);
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
