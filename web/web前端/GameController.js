import GameEngine, { Player, StartProtectionRule, TerritoryRulesVersion, PLAYER_ORDER, getBoardPositions, resolveBoardShape } from "./GameEngine.js?v=20261029-unified-r1";
import Renderer from "./Renderer.js?v=20261029-unified-r1";
import { ServerEvent } from "./NetworkManager.js?v=20261101-platform-alignment-r1";
import { serializeEngineState } from "./AIStateProtocol.js?v=20261029-unified-r1";
import {
  applyTerritoryWorkerResult,
} from "./TerritoryWorkerSession.js?v=20261029-unified-r1";
import TerritoryWorkerPool from "./TerritoryWorkerPool.js?v=20261029-unified-r1";
import { decodeTopologyState } from "./TopologyStateCodec.js?v=20261029-unified-r1";

// GameController 鏄墠绔殑鈥滆兌姘村眰鈥濓細
// 瀹冩妸 Model(GameEngine)銆乂iew(Renderer) 鍜岃仈鏈哄眰(NetworkManager) 涓茶捣鏉ワ紝
// 瀵瑰鏆撮湶缁熶竴鐨勬父鎴忕姸鎬佷笌鎿嶄綔鎺ュ彛锛屽敖閲忎笉璁?Vue 鐩存帴纰板簳灞傜粏鑺傘€?
const DEFAULT_ENGINE_OPTIONS = Object.freeze({
  playerCount: 2,
  gridSize: 9,
  rulesVersion: TerritoryRulesVersion.V3,
});
const ASYNC_TERRITORY_MIN_GRID_SIZE = 15;
const TOUCH_MOVE_THRESHOLD_CSS_PX = 8;
const TOUCH_CLICK_SUPPRESSION_MS = 800;
const TOUCH_CLICK_SUPPRESSION_RADIUS_CSS_PX = 28;

function clonePoint(point) {
  // Topology boards expose canonical vertex IDs rather than a fabricated
  // rectangular coordinate. Keep that identity intact through controller
  // metadata, replay and network handoff; legacy boards retain copied tuples.
  if (typeof point === "string") return point;
  return Array.isArray(point) ? [point[0], point[1]] : null;
}

function distanceBetween(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function isKnownPlayer(player) {
  return PLAYER_ORDER.includes(player);
}

function isGridPoint(point) {
  return Array.isArray(point)
    && point.length === 2
    && Number.isInteger(point[0])
    && Number.isInteger(point[1]);
}

function isTopologyVertexId(point) {
  return typeof point === "string" && point.length > 0;
}

function isMovePosition(point) {
  return isGridPoint(point) || isTopologyVertexId(point);
}

// Display metadata follows confirmed actions, including rule-driven automatic PASS.
// It never enters the rule state, search state or persisted replay format.
function updateLastMoves(lastMoves, action, engine, previousSkips = 0) {
  if (!action || !isKnownPlayer(action.player)) return;
  if (engine.isTopologyBoard) {
    if (action.type === "move") lastMoves[action.player] = clonePoint(action.point);
    else delete lastMoves[action.player];
    const explicitSkips = action.type === "skip" ? previousSkips + 1 : 0;
    const automaticSkips = Math.max(0, engine.consecutiveSkips - explicitSkips);
    let skippedPlayer = action.player;
    for (let index = 0; index < automaticSkips; index += 1) {
      skippedPlayer = engine._getNextPlayer(skippedPlayer);
      delete lastMoves[skippedPlayer];
    }
    // Once captured, a marker cannot revive when the coordinate is reused.
    for (const [owner, point] of Object.entries(lastMoves)) {
      if (engine.resignedPlayers.has(owner) || engine.getStateAt(point) !== engine._getPlayerStates(owner).node) delete lastMoves[owner];
    }
    return;
  }
  lastMoves[action.player] = action.type === "move" ? clonePoint(action.point) : null;
  const explicitSkips = action.type === "skip" ? previousSkips + 1 : 0;
  const automaticSkips = Math.max(0, engine.consecutiveSkips - explicitSkips);
  let player = action.player;
  for (let index = 0; index < automaticSkips; index += 1) {
    player = engine._getNextPlayer(player);
    lastMoves[player] = null;
  }
}

// A topology snapshot is authoritative. Only derive display metadata from an
// action log if replay reproduces its complete rule state, including history.
function canonicalDisplayState(value) {
  if (Array.isArray(value)) return value.map(canonicalDisplayState);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalDisplayState(value[key])]));
  return value;
}
function replayTopologyLastMoves(engine, actions, expectedRuleState) {
  if (!Array.isArray(actions)) return null;
  const lastMoves = {}; let lastAction = null;
  try {
    for (const action of actions) {
      if (!action || typeof action.type !== "string") return null;
      const previousSkips = engine.consecutiveSkips;
      const player = action.type === "player_resign" ? action.color : engine.getCurrentPlayer();
      let result;
      if (action.type === "player_move" && typeof action.vertexId === "string"
        && (action.boardHash == null || action.boardHash === engine.boardHash)) {
        result = engine.playMove(action.vertexId);
        lastAction = { type: "move", player, point: action.vertexId };
      } else if (action.type === "player_skip") {
        result = engine.skipTurn(); lastAction = { type: "skip", player, point: null };
      } else if (action.type === "player_resign" && isKnownPlayer(player)) {
        result = engine.resignPlayer(player); lastAction = { type: "resign", player, point: null };
      } else return null;
      if (!result?.success) return null;
      updateLastMoves(lastMoves, lastAction, engine, previousSkips);
    }
    if (JSON.stringify(canonicalDisplayState(engine.getTopologyRuleState())) !== JSON.stringify(canonicalDisplayState(expectedRuleState))) return null;
    return { lastMoves, lastAction };
  } catch (_) { return null; }
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
    const createTerritoryWorker = typeof options.createTerritoryWorker === "function"
      ? options.createTerritoryWorker
      : (typeof globalThis.Worker === "function"
        ? () => new globalThis.Worker(
            new URL("./TerritoryWorker.js?v=20261029-unified-r1", import.meta.url),
            { type: "module" },
          )
        : null);
    this._territoryWorkerSession = createTerritoryWorker
      ? new TerritoryWorkerPool(createTerritoryWorker, {
          size: Math.max(1, Math.min(3, (globalThis.navigator?.hardwareConcurrency ?? 4) - 1)),
        })
      : null;
    this._territoryFallbackToken = 0;
    this.engine = this._createEngine(this.options.engine);
    this._validGridPoints = this.engine.getValidPositions();
    this.renderer = new Renderer(canvas, options.renderer ?? {});
    this._engineEpoch = 1;
    this.stateChangeListener = typeof options.onStateChange === "function" ? options.onStateChange : null;
    this.networkErrorListener = typeof options.onNetworkError === "function" ? options.onNetworkError : null;
    this.actionFeedbackListener = typeof options.onActionFeedback === "function" ? options.onActionFeedback : null;
    this.successfulLocalPointerMoveListener = typeof options.onSuccessfulLocalPointerMove === "function" ? options.onSuccessfulLocalPointerMove : null;

    this.multiplayerEnabled = false;
    this.localPlayer = null;
    this.roomReady = false;
    this.opponentConnected = false;
    this.networkManager = null;
    this.lastAction = null;
    this.lastMoves = {};
    this.inspectionOverlay = null;
    this.readOnlyMode = false;
    this._networkUnsubscribers = [];
    this._lastServerActionIndex = 0;
    this._authoritativeSnapshotValid = true;
    this._pendingRoomOperation = null;
    this._onlineActionSync = null;
    this._onlineActionPlayerId = null;
    this._onlineActionRecoveryListener = null;
    this._onlineActionSendingListener = null;
    this._preparedMatchStates = new Map();
    this._preparedOnlineActions = new Map();
    this._preparedTransactionSequence = 0;
    this._lastVersionedRestore = null;
    this._onlineActionBindingRevision = 0;
    this._touchInputOwnershipEpoch = 0;

    this._isInitialized = false;
    this._boundHandleClick = this._handleClick.bind(this);
    this._boundHandleTouchStart = this._handleTouchStart.bind(this);
    this._boundHandleTouchMove = this._handleTouchMove.bind(this);
    this._boundHandleTouchEnd = this._handleTouchEnd.bind(this);
    this._boundHandleTouchCancel = this._handleTouchCancel.bind(this);
    this._boundHandleAnyTouchStart = this._handleAnyTouchStart.bind(this);
    this._boundHandlePointerDown = this._handlePointerDown.bind(this);
    this._boundSuspendTouchForLifecycle = this._suspendTouchForLifecycle.bind(this);
    this._boundResumeTouchForLifecycle = this._resumeTouchForLifecycle.bind(this);
    this._boundHandleTouchVisibility = this._handleTouchVisibility.bind(this);
    this._pendingTouchGesture = null;
    this._touchLifecycleEpoch = 0;
    this._touchLifecycleStartedAt = 0;
    this._touchHostActive = globalThis.__LIFELINE_APP_ACTIVE__ !== false;
    this._touchWindowFocused = true;
    this._touchDocumentVisible = typeof document === "undefined" || document.visibilityState !== "hidden";
    this._touchClickSuppression = null;

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
    const isTopologyBoard = Boolean(
      this.engine?.isTopologyBoard
      || this.options.engine?.boardDefinition
      || this.options.engine?.compiledBoard,
    );
    if (typeof document !== "undefined" && document.body) {
      if (!isTopologyBoard && (gridSize >= 15
        || (resolveBoardShape(this.options.engine?.playerCount, this.options.engine?.boardShape) === "hexagon" && gridSize >= 9))) {
        document.body.classList.add("large-board");
      } else {
        document.body.classList.remove("large-board");
      }
    }
  }

  _createEngine(engineOptions = {}) {
    const normalizedOptions = {
      ...DEFAULT_ENGINE_OPTIONS,
      ...(engineOptions ?? {}),
    };
    const isTopologyBoard = Boolean(
      normalizedOptions.boardDefinition
      || normalizedOptions.compiledBoard
      || (normalizedOptions.boardShape === "custom"
        && normalizedOptions.rulesVersion === "surface-v1"),
    );
    if (isTopologyBoard) {
      if (!Object.hasOwn(engineOptions, "rulesVersion")) normalizedOptions.rulesVersion = "surface-v1";
      // A materialized topology definition contains the complete root layout.
      // Settings may also carry legacy first-root fields for presentation; they
      // must never truncate a multi-root definition when starting/restoring it.
      const definition = normalizedOptions.compiledBoard?.definition ?? normalizedOptions.boardDefinition;
      if (Object.keys(definition?.startingVertices ?? {}).length) delete normalizedOptions.initialPositions;
    }
    if (!isTopologyBoard) {
      normalizedOptions.protectionRule ??= normalizedOptions.playerCount === 2
        && resolveBoardShape(normalizedOptions.playerCount, normalizedOptions.boardShape) === "triangle"
        ? StartProtectionRule.DUEL_FIRST_UNPROTECTED
        : StartProtectionRule.SYMMETRIC;
    }
    const deferTerritoryUpdates = normalizedOptions.deferTerritoryUpdates
      ?? (isTopologyBoard
        ? false
        : (normalizedOptions.gridSize >= ASYNC_TERRITORY_MIN_GRID_SIZE
          || normalizedOptions.playerCount >= 3
          || resolveBoardShape(normalizedOptions.playerCount, normalizedOptions.boardShape) === "hexagon"));
    return new GameEngine({
      ...normalizedOptions,
      deferTerritoryUpdates,
    });
  }

  _cancelTerritoryRefresh() {
    this._territoryPreview = null;
    this._territoryFallbackToken = (this._territoryFallbackToken ?? 0) + 1;
    return this._territoryWorkerSession?.cancel?.() ?? false;
  }

  _scheduleTerritoryFallback(engine) {
    const fallbackToken = (this._territoryFallbackToken ?? 0) + 1;
    this._territoryFallbackToken = fallbackToken;
    const settle = () => {
      globalThis.setTimeout(() => {
        if (
          fallbackToken !== this._territoryFallbackToken
          || this.engine !== engine
          || !engine.hasPendingTerritoryUpdate?.()
        ) {
          return;
        }
        engine._updateTerritories();
        this._syncSnapshot(engine.getSnapshot(), {
          forceRender: true,
          scheduleTerritory: false,
        });
      }, 0);
    };

    if (typeof globalThis.requestAnimationFrame === "function") {
      globalThis.requestAnimationFrame(settle);
    } else {
      settle();
    }
  }

  _scheduleTerritoryRefresh() {
    const engine = this.engine;
    // Surface territory is exact and already operates on canonical samples.
    // Legacy TerritoryWorker serializes rectangular matrices, so never send a
    // quotient board through that protocol.
    if (engine?.isTopologyBoard) {
      this._territoryPreview = null;
      if (this._territoryWorkerSession?.cancelPending) this._territoryWorkerSession.cancelPending();
      else this._cancelTerritoryRefresh();
      if (engine.hasPendingTerritoryUpdate?.()) {
        engine._updateTerritories();
        this._syncSnapshot(engine.getSnapshot(), {
          forceRender: true,
          scheduleTerritory: false,
        });
      }
      return;
    }
    if (
      !engine?.deferTerritoryUpdates
      || !engine.hasPendingTerritoryUpdate?.()
    ) {
      this._territoryPreview = null;
      // Leave idle workers warm. Explicit reset/destroy still terminates them.
      if (this._territoryWorkerSession?.cancelPending) this._territoryWorkerSession.cancelPending();
      else this._cancelTerritoryRefresh();
      return;
    }

    // Invalidate fallback work; the pool coalesces duplicate/current requests
    // and queues only the latest board behind any already-running calculation.
    this._territoryFallbackToken = (this._territoryFallbackToken ?? 0) + 1;
    if (!this._territoryWorkerSession) {
      this._scheduleTerritoryFallback(engine);
      return;
    }

    // The pool already keeps this exact request alive. Avoid serializing the
    // board, edges and complete Superko history again for duplicate UI syncs.
    if (this._territoryWorkerSession.hasCurrentRequest?.(engine)) return;

    try {
      this._territoryWorkerSession.start({
        engine,
        getCurrentEngine: () => this.engine,
        message: {
          type: "COMPUTE_TERRITORIES",
          serializedState: serializeEngineState(engine),
        },
        onProgress: (response) => {
          this._territoryPreview = { engine, ...response };
          const snapshot = this.renderer.lastSnapshot;
          if (snapshot?.positionRevision === response.positionRevision) {
            this.renderer.render({ ...snapshot, renderTerritories: response.territories });
          }
        },
        onResult: (response) => {
          this._territoryPreview = null;
          const applied = applyTerritoryWorkerResult({
            engine,
            territories: response.territories,
            territoryStateRevision: response.territoryStateRevision,
          });
          if (!applied) {
            this._scheduleTerritoryFallback(engine);
            return;
          }
          this._syncSnapshot(engine.getSnapshot(), {
            scheduleTerritory: false,
          });
        },
        onError: () => {
          // A Worker may be unavailable for file:// previews or blocked by a
          // restrictive browser policy. Keep the result exact after yielding a
          // paint rather than leaving a stale score on screen indefinitely.
          this._scheduleTerritoryFallback(engine);
        },
      });
    } catch (_error) {
      this._scheduleTerritoryFallback(engine);
    }
  }

  _replaceEngine(engineOptions = this.options.engine ?? {}) {
    // A rejected next-match definition must leave the playable engine and its
    // pending territory work intact.
    const nextEngine = this._createEngine(engineOptions);
    const nextValidPoints = nextEngine.getValidPositions();
    this.renderer.invalidate();
    this._cancelTerritoryRefresh();
    this.engine = nextEngine;
    this._validGridPoints = nextValidPoints;
    this._engineEpoch += 1;
    this._lastServerActionIndex = 0;
    this.renderer.invalidate();
    return this.engine;
  }

  init() {
    if (!this._isInitialized) {
      this._touchLifecycleEpoch += 1;
      this._touchLifecycleStartedAt = globalThis.performance?.now?.() ?? 0;
      this._pendingTouchGesture = null;
      this.canvas.addEventListener("click", this._boundHandleClick);
      this.canvas.addEventListener("touchstart", this._boundHandleTouchStart, { passive: false });
      this.canvas.addEventListener("touchmove", this._boundHandleTouchMove, { passive: false });
      this.canvas.addEventListener("touchend", this._boundHandleTouchEnd, { passive: false });
      this.canvas.addEventListener("touchcancel", this._boundHandleTouchCancel, { passive: false });
      this.canvas.addEventListener("pointerdown", this._boundHandlePointerDown);
      if (typeof globalThis.addEventListener === "function") {
        this._touchHostActive = globalThis.__LIFELINE_APP_ACTIVE__ !== false;
        globalThis.addEventListener("lifeline:background", this._boundSuspendTouchForLifecycle);
        globalThis.addEventListener("lifeline:foreground", this._boundResumeTouchForLifecycle);
        globalThis.addEventListener("blur", this._boundSuspendTouchForLifecycle);
        globalThis.addEventListener("focus", this._boundResumeTouchForLifecycle);
      }
      if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
        this._touchDocumentVisible = document.visibilityState !== "hidden";
        document.addEventListener("touchstart", this._boundHandleAnyTouchStart, { capture: true, passive: false });
        document.addEventListener("visibilitychange", this._boundHandleTouchVisibility);
      }
      this._touchWindowFocused = typeof document === "undefined" || typeof document.hasFocus !== "function" || document.hasFocus();
      this._isInitialized = true;
    }

    this._updateLargeBoardClass();
    const snapshot = this.engine.getSnapshot();
    this.renderer.render({
      ...snapshot,
      renderEpoch: this._engineEpoch,
      lastAction: this._cloneLastAction(),
      lastMoves: this._cloneLastMoves(),
      lastServerActionIndex: this._lastServerActionIndex ?? 0,
      inspectionOverlay: this.inspectionOverlay,
    });
    this._syncCanvasInteractivity(snapshot);
    this._emitStateChange(snapshot);
    return snapshot;
  }

  destroy() {
    if (this._isInitialized) {
      this._cancelPendingTouchGesture({ suppressClick: true });
      this._touchLifecycleEpoch += 1;
      this.canvas.removeEventListener("click", this._boundHandleClick);
      this.canvas.removeEventListener("touchstart", this._boundHandleTouchStart);
      this.canvas.removeEventListener("touchmove", this._boundHandleTouchMove);
      this.canvas.removeEventListener("touchend", this._boundHandleTouchEnd);
      this.canvas.removeEventListener("touchcancel", this._boundHandleTouchCancel);
      this.canvas.removeEventListener("pointerdown", this._boundHandlePointerDown);
      if (typeof globalThis.removeEventListener === "function") {
        globalThis.removeEventListener("lifeline:background", this._boundSuspendTouchForLifecycle);
        globalThis.removeEventListener("lifeline:foreground", this._boundResumeTouchForLifecycle);
        globalThis.removeEventListener("blur", this._boundSuspendTouchForLifecycle);
        globalThis.removeEventListener("focus", this._boundResumeTouchForLifecycle);
      }
      if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
        document.removeEventListener("touchstart", this._boundHandleAnyTouchStart, { capture: true });
        document.removeEventListener("visibilitychange", this._boundHandleTouchVisibility);
      }
      this._isInitialized = false;
    }

    this._cancelTerritoryRefresh();
    this._removeNetworkListeners();
    this.renderer.destroy();
  }

  setStateChangeListener(listener) {
    this.stateChangeListener = typeof listener === "function" ? listener : null;
  }

  setNetworkErrorListener(listener) {
    this.networkErrorListener = typeof listener === "function" ? listener : null;
  }

  setActionFeedbackListener(listener) {
    this.actionFeedbackListener = typeof listener === "function" ? listener : null;
  }

  setReadOnlyMode(enabled = false) {
    this._touchInputOwnershipEpoch += 1;
    this.readOnlyMode = Boolean(enabled);
    const snapshot = this.engine.getSnapshot();
    const state = this._buildGameState(snapshot);
    this._syncSnapshot(snapshot, { forceRender: true, scheduleTerritory: false });
    return state;
  }

  setInspectionOverlay(overlay = null) {
    if (!overlay) {
      this.inspectionOverlay = null;
    } else {
      this.inspectionOverlay = {
        tutorial: Boolean(overlay.tutorial),
        blockedPoint: isMovePosition(overlay.blockedPoint) ? clonePoint(overlay.blockedPoint) : null,
        selectedPoint: isMovePosition(overlay.selectedPoint) ? clonePoint(overlay.selectedPoint) : null,
        capturedPoints: Array.isArray(overlay.capturedPoints)
          ? overlay.capturedPoints.filter(isMovePosition).map(clonePoint)
          : [],
        addedEdges: Array.isArray(overlay.addedEdges)
          ? overlay.addedEdges
            .filter((item) => item && typeof item.edge === "string")
            .map((item) => ({ player: item.player, edge: item.edge }))
          : [],
        removedEdges: Array.isArray(overlay.removedEdges)
          ? overlay.removedEdges
            .filter((item) => item && typeof item.edge === "string")
            .map((item) => ({ player: item.player, edge: item.edge }))
          : [],
      };
    }
    this._syncSnapshot(this.engine.getSnapshot(), {
      forceRender: true,
      scheduleTerritory: false,
    });
    return this.inspectionOverlay;
  }

  setGameConfig(engineOptions = {}, reset = true) {
    const incomingOptions = engineOptions ?? {};
    const previousOptions = { ...this.options.engine };
    delete previousOptions.initialPositions;
    delete previousOptions.initialRoots;
    delete previousOptions.startingPointMode;
    delete previousOptions.rootMode;
    delete previousOptions.rootRulesVersion;
    // A new configuration selects its own protection scope. Inheriting a
    // previous duel's explicit modern rule into a multiplayer/hex game makes
    // the live rule differ from its normalized saved settings. Explicitly
    // supplied historical rules remain authoritative on the new config.
    if (!Object.hasOwn(incomingOptions, "protectionRule")) delete previousOptions.protectionRule;
    const suppliesDefinition = ["boardDefinition", "compiledBoard"]
      .some((key) => Object.hasOwn(incomingOptions, key));
    const keepsCurrentSurface = incomingOptions.boardShape === "custom"
      && !suppliesDefinition && Boolean(previousOptions.boardDefinition || previousOptions.compiledBoard);
    const selectsBoard = suppliesDefinition
      || (Object.hasOwn(incomingOptions, "boardShape") && !keepsCurrentSurface);
    if (selectsBoard) {
      // Explicit board selection replaces the previous board identity. A
      // triangle/hexagon must not inherit an old surface definition, and a new
      // definition must not be shadowed by an old compiled board.
      for (const key of ["boardShape", "boardDefinition", "compiledBoard", "boardHash", "topologyProtocolVersion"]) {
        delete previousOptions[key];
      }
      if (previousOptions.rulesVersion === "surface-v1") delete previousOptions.rulesVersion;
    } else if (incomingOptions.playerCount != null && !Object.hasOwn(incomingOptions, "boardShape")) {
      delete previousOptions.boardShape;
    }
    const nextEngineOptions = {
      ...DEFAULT_ENGINE_OPTIONS,
      ...previousOptions,
      ...incomingOptions,
    };
    if (!Object.hasOwn(incomingOptions, "rulesVersion")
      && (incomingOptions.boardDefinition || incomingOptions.compiledBoard || incomingOptions.boardShape === "custom")) {
      nextEngineOptions.rulesVersion = "surface-v1";
    }

    if (!reset) {
      this.options.engine = nextEngineOptions;
      return this.options.engine;
    }

    this._replaceEngine(nextEngineOptions);
    this.options.engine = nextEngineOptions;
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

    if (this.networkManager && this._onlineActionSync && this._hasVersionedActionState()) {
      this._onlineActionSync.markConnectionLost?.();
      this.refreshOnlineActionSyncState();
    }
    this._invalidatePendingRoomOperation();
    this._touchInputOwnershipEpoch += 1;
    this._removeNetworkListeners();
    this.networkManager = networkManager ?? null;

    if (!this.networkManager || typeof this.networkManager.on !== "function") {
      return;
    }

    // OnlineApp owns complete room snapshots and lifecycle state. The controller
    // only applies incremental gameplay events so one server frame has one owner.
    this._networkUnsubscribers.push(
      this.networkManager.on(ServerEvent.OPPONENT_MOVE, (payload) => {
        if (!this._shouldConsumeLegacyActionEvents() || !this._acceptServerAction(payload)) return;
        if (this.engine?.isTopologyBoard) {
          if (isTopologyVertexId(payload?.vertexId)
            && payload.boardHash === this.engine.boardHash) {
            this.applyRemoteMove(payload.vertexId);
          } else {
            this._reportNetworkError(new Error("Received invalid topology OPPONENT_MOVE payload."));
          }
        } else if (isGridPoint(payload?.point)) {
          this.applyRemoteMove(payload.point);
        } else {
          this._reportNetworkError(new Error("Received invalid OPPONENT_MOVE payload."));
        }
      }),
    );

    this._networkUnsubscribers.push(
      this.networkManager.on(ServerEvent.TURN_SKIPPED, (payload) => {
        if (!this._shouldConsumeLegacyActionEvents() || !this._acceptServerAction(payload)) return;
        this.applyRemoteSkip();
      }),
    );

    this._networkUnsubscribers.push(
      this.networkManager.on(ServerEvent.ROOT_ACTION_APPLIED, (payload) => {
        if (!this._shouldConsumeLegacyActionEvents() || !this._acceptServerAction(payload)) return;
        const type = payload?.actionType === "player_root_relocate" ? "relocate"
          : payload?.actionType === "player_root_add" ? "add" : null;
        if (type && isGridPoint(payload.point)) this.applyRemoteRootAction(type, payload.point);
        else this._reportNetworkError(new Error("Received invalid ROOT_ACTION_APPLIED payload."));
      }),
    );

    this._networkUnsubscribers.push(
      this.networkManager.on(ServerEvent.PLAYER_RESIGNED, (payload) => {
        if (!this._shouldConsumeLegacyActionEvents()) return;
        this.applyRemoteResign(payload?.color);
      }),
    );

    this._networkUnsubscribers.push(
      this.networkManager.on("CLOSE", () => {
        this._invalidatePendingRoomOperation();
        if (this._onlineActionSync && this._hasVersionedActionState()) {
          this._onlineActionSync.markConnectionLost?.();
          this.refreshOnlineActionSyncState();
        }
      }),
    );

  }

  bindOnlineActionSync({ sync = null, playerId = null, onRecoveryRequired = null, onActionSending = null } = {}) {
    const pending = this._onlineActionSync?.getState?.().pending ?? [];
    const ownershipChanged = this._onlineActionSync !== (sync ?? null) || this._onlineActionPlayerId !== (playerId ?? null);
    if (pending.length && ownershipChanged) return { status: "blocked", reason: "unresolved_versioned_action" };
    this._onlineActionSync = sync ?? null;
    this._onlineActionPlayerId = playerId ?? null;
    this._onlineActionRecoveryListener = typeof onRecoveryRequired === "function" ? onRecoveryRequired : null;
    this._onlineActionSendingListener = typeof onActionSending === "function" ? onActionSending : null;
    if (ownershipChanged) this._onlineActionBindingRevision += 1;
    return { status: "bound", unchanged: !ownershipChanged, state: this.refreshOnlineActionSyncState() };
  }

  refreshOnlineActionSyncState() {
    if (!this.engine || !this.renderer) return this.getGameState();
    const snapshot = this.engine.getSnapshot();
    this._syncSnapshot(snapshot, { scheduleTerritory: false });
    return this._buildGameState(snapshot);
  }

  _onlineActionLedgerState() {
    return this._onlineActionSync?.getState?.() ?? null;
  }

  _hasVersionedActionState() {
    const state = this._onlineActionLedgerState();
    return Boolean(state && (state.protocol?.status === "selected" || state.pending?.length));
  }

  _getOnlineActionLockReason() {
    if (!this._onlineActionSync) return null;
    const state = this._onlineActionLedgerState();
    if (state?.pending?.some((item) => item.status === "uncertain") || state?.recoveryRequired) return "ACTION_OUTCOME_UNKNOWN";
    if (state?.capacityBlocked) return "ACTION_OUTCOME_CAPACITY";
    if (state?.pending?.length || state?.locked) return "ACTION_PENDING";
    if (!this.multiplayerEnabled) return null;
    if (!state || state.protocol?.status === "unknown") return "ACTION_PROTOCOL_UNKNOWN";
    // The v1 legacy ledger encodes ordinary coordinate moves only. Never
    // optimistically mutate a topology board under an incompatible ledger.
    if (state.protocol.status === "selected" && this.engine?.isTopologyBoard) return "ACTION_PROTOCOL_UNSUPPORTED";
    if (state.protocol.status === "selected" && !state.scope) return "ACTION_SCOPE_UNKNOWN";
    if (state.protocol.status === "selected" && (typeof this._onlineActionPlayerId !== "string" || !this._onlineActionPlayerId)) {
      return "ACTION_LOCAL_PLAYER_UNKNOWN";
    }
    if (state.protocol.status !== "selected" && state.protocol.status !== "legacy") return "ACTION_PROTOCOL_UNKNOWN";
    return null;
  }

  _shouldConsumeLegacyActionEvents() {
    if (!this._onlineActionSync) return true;
    const state = this._onlineActionLedgerState();
    return state?.protocol?.status === "legacy" && !state.pending?.length;
  }

  _reserveOnlineAction(type, point = null) {
    if (!this._onlineActionSync) return { mode: "legacy" };
    const state = this._onlineActionLedgerState();
    if (state?.protocol?.status === "legacy" && !state.pending?.length && !state.locked) return { mode: "legacy" };
    const lockReason = this._getOnlineActionLockReason();
    if (lockReason) return { mode: "blocked", reason: lockReason };
    const reservation = this._onlineActionSync.beginAction({
      type,
      playerId: this._onlineActionPlayerId,
      actorColor: type === "player_resign" ? this.localPlayer : this.engine.getCurrentPlayer(),
      ...(type === "player_move" ? { point: clonePoint(point) } : {}),
    });
    if (reservation.status !== "reserved") {
      return { mode: "blocked", reason: reservation.reason ?? reservation.status };
    }
    const reserved = {
      mode: "versioned",
      sync: this._onlineActionSync,
      bindingRevision: this._onlineActionBindingRevision,
      manager: this.networkManager,
      socket: this.networkManager?.socket ?? null,
      engine: this.engine,
      engineEpoch: this._engineEpoch,
      clientActionId: reservation.clientActionId,
      actorColor: type === "player_resign" ? this.localPlayer : this.engine.getCurrentPlayer(),
      action: reservation.action,
      recoveryListener: this._onlineActionRecoveryListener,
    };
    // Publish only after the ledger owns the slot, so re-entrant listeners see the lock.
    try {
      this.refreshOnlineActionSyncState();
    } catch (error) {
      this._markOnlineActionUncertain(reserved, "reservation_publish_failed", error);
      return { mode: "blocked", reason: "ACTION_OUTCOME_UNKNOWN", state: this.getGameState() };
    }
    return reserved;
  }

  _isCurrentOnlineActionReservation(reservation) {
    const pending = reservation?.sync?.getState?.().pending ?? [];
    return Boolean(reservation && reservation.sync === this._onlineActionSync
      && reservation.bindingRevision === this._onlineActionBindingRevision
      && reservation.manager === this.networkManager
      && reservation.socket === (this.networkManager?.socket ?? null)
      && reservation.engine === this.engine && reservation.engineEpoch === this._engineEpoch
      && pending.some((item) => item.clientActionId === reservation.clientActionId));
  }

  _markOnlineActionUncertain(reservation, reason, error = null) {
    try {
      reservation.sync.markUncertain(reservation.clientActionId);
    } catch (ledgerError) {
      try { this._reportNetworkError(ledgerError); } catch (_reportError) {}
    }

    const state = this.getGameState();
    try {
      reservation.recoveryListener?.({ reason, clientActionId: reservation.clientActionId, error, state });
    } catch (callbackError) {
      try { this._reportNetworkError(callbackError); } catch (_reportError) {}
    }

    if (reservation.sync === this._onlineActionSync) {
      try {
        this.refreshOnlineActionSyncState();
      } catch (refreshError) {
        try { this._reportNetworkError(refreshError); } catch (_reportError) {}
      }
    }
    return state;
  }

  async _sendReservedOnlineAction(reservation) {
    if (!this._isCurrentOnlineActionReservation(reservation)) {
      return { success: false, reason: "STALE_ACTION_OWNER", state: this.getGameState() };
    }
    try {
      if (typeof reservation.manager?.sendVersionedAction !== "function") {
        throw new Error("Versioned action transport is unavailable.");
      }
      this._onlineActionSendingListener?.({
        clientActionId: reservation.clientActionId,
        action: { ...reservation.action, ...(Array.isArray(reservation.action?.point) ? { point: clonePoint(reservation.action.point) } : {}) },
        manager: reservation.manager,
        socket: reservation.socket,
        sync: reservation.sync,
      });
      if (!this._isCurrentOnlineActionReservation(reservation)) {
        return { success: false, reason: "STALE_ACTION_OWNER", state: this.getGameState() };
      }
      await reservation.manager.sendVersionedAction(reservation.action);
      if (!this._isCurrentOnlineActionReservation(reservation)) {
        return { success: false, reason: "STALE_ACTION_OWNER", state: this.getGameState() };
      }
      reservation.sync.markSent(reservation.clientActionId);
      return { success: true, reason: null, state: this.refreshOnlineActionSyncState() };
    } catch (error) {
      if (!this._isCurrentOnlineActionReservation(reservation)) {
        return { success: false, reason: "STALE_ACTION_OWNER", state: this.getGameState() };
      }
      const message = typeof error?.message === "string" ? error.message : String(error);
      const normalizedError = new Error(message, { cause: error });
      normalizedError.name = error?.name || "Error";
      normalizedError.code = "ACTION_OUTCOME_UNKNOWN";
      try { this._reportNetworkError(normalizedError); } catch (_reportError) {}
      const state = this._markOnlineActionUncertain(reservation, "action_send_failed", normalizedError);
      return { success: false, reason: "ACTION_OUTCOME_UNKNOWN", state };
    }
  }

  _performVersionedMove(point, actingPlayer) {
    const reservation = this._reserveOnlineAction("player_move", point);
    if (reservation.mode === "blocked") {
      const state = this.getGameState();
      this._emitActionFeedback({ type: "move", success: false, reason: reservation.reason, point });
      return { success: false, reason: reservation.reason, point: clonePoint(point), state };
    }
    if (reservation.mode !== "versioned") return null;
    return this._applyReservedVersionedMove(reservation, point, actingPlayer);
  }

  async retryPendingOnlineAction(clientActionId) {
    const state = this._onlineActionSync?.getState?.();
    const record = state?.pending?.find((item) => item.clientActionId === clientActionId);
    const baseline = this._lastVersionedRestore;
    const restored = Boolean(record?.status === "retryable" && record.retryBaseline
      && baseline && baseline.engine === this.engine && baseline.engineEpoch === this._engineEpoch
      && baseline.positionRevision === this.engine.getSnapshot().positionRevision
      && baseline.scope?.matchEpoch === record.retryBaseline.scope?.matchEpoch
      && baseline.scope?.actionSeq === record.retryBaseline.actionSeq
      && record.retryBaseline.actionSeq === record.wireAction.baseActionSeq
      && baseline.scope?.serverInstanceId === record.retryBaseline.scope?.serverInstanceId
      && baseline.scope?.roomInstanceId === record.retryBaseline.scope?.roomInstanceId
      && baseline.scope?.matchGeneration === record.retryBaseline.scope?.matchGeneration);
    if (!restored || record.optimisticApplied) {
      if (record) {
        const reservation = this._reservationFromPending(record);
        this._markOnlineActionUncertain(reservation, "retry_baseline_not_restored");
      }
      return { success: false, reason: "RETRY_BASELINE_NOT_RESTORED", state: this.getGameState() };
    }
    const retry = this._onlineActionSync.prepareRetry(clientActionId);
    if (retry.status !== "retry") return { success: false, reason: retry.reason ?? retry.status, state: this.getGameState() };
    const reservation = this._reservationFromPending({ ...record, action: retry.action, status: "reserved" });
    if (!this._isCurrentOnlineActionReservation(reservation)) {
      this._markOnlineActionUncertain(reservation, "retry_action_owner_changed");
      return { success: false, reason: "STALE_ACTION_OWNER", state: this.getGameState() };
    }
    if (retry.action.type === "player_move") {
      const result = this._applyReservedVersionedMove(reservation, retry.action.point, this.engine.getCurrentPlayer(), { retry: true });
      if (result.retrySendPromise) await result.retrySendPromise;
      return { ...result, state: this.getGameState() };
    }
    const sent = await this._sendReservedOnlineAction(reservation);
    return { ...sent, state: sent.state ?? this.getGameState() };
  }

  _reservationFromPending(record) {
    return {
      mode: "versioned",
      sync: this._onlineActionSync,
      bindingRevision: this._onlineActionBindingRevision,
      manager: this.networkManager,
      socket: this.networkManager?.socket ?? null,
      engine: this.engine,
      engineEpoch: this._engineEpoch,
      clientActionId: record.clientActionId,
      actorColor: record.actorColor,
      action: record.action ?? record.wireAction,
      recoveryListener: this._onlineActionRecoveryListener,
    };
  }

  _applyReservedVersionedMove(reservation, point, actingPlayer, { retry = false } = {}) {
    if (!this._isCurrentOnlineActionReservation(reservation)) {
      if (!retry) reservation.sync.cancelReservation(reservation.clientActionId);
      else this._markOnlineActionUncertain(reservation, "retry_action_owner_changed_before_apply");
      if (reservation.sync === this._onlineActionSync && !retry) this.refreshOnlineActionSyncState();
      return { success: false, reason: "STALE_ACTION_OWNER", point: clonePoint(point), state: this.getGameState() };
    }
    if (reservation.actorColor && reservation.engine.getCurrentPlayer() !== reservation.actorColor) {
      this._markOnlineActionUncertain(reservation, "retry_actor_changed_before_apply");
      return { success: false, reason: "ACTION_ACTOR_MISMATCH", point: clonePoint(point), state: this.getGameState() };
    }

    let result;
    const beforePositionRevision = reservation.engine.getSnapshot()?.positionRevision;
    try {
      result = this._applyMove(point, actingPlayer);
    } catch (error) {
      let definitelyUnchanged = false;
      try {
        definitelyUnchanged = this.engine === reservation.engine
          && reservation.engine.getSnapshot()?.positionRevision === beforePositionRevision;
      } catch (_snapshotError) {
        // Unknown engine state is treated as possibly changed.
      }
      if (definitelyUnchanged && !retry) reservation.sync.cancelReservation(reservation.clientActionId);
      else {
        reservation.sync.markOptimisticApplied(reservation.clientActionId);
        this._markOnlineActionUncertain(reservation, "move_callback_failed_after_engine_change", error);
      }
      if (definitelyUnchanged && reservation.sync === this._onlineActionSync) {
        try { this.refreshOnlineActionSyncState(); } catch (refreshError) {
          try { this._reportNetworkError(refreshError); } catch (_reportError) {}
        }
      }
      throw error;
    }
    if (!result.success) {
      if (!retry) {
        const reservationOwnerIsCurrent = this._isCurrentOnlineActionReservation(reservation);
        const cancelled = reservation.sync.cancelReservation(reservation.clientActionId);
        if (cancelled && reservationOwnerIsCurrent) {
          try {
            this.refreshOnlineActionSyncState();
          } catch (refreshError) {
            try { this._reportNetworkError(refreshError); } catch (_reportError) {}
          }
        }
      } else {
        this._markOnlineActionUncertain(reservation, "retry_move_rejected", new Error(result.reason ?? "Move rejected"));
      }
      return { ...result, state: this.getGameState() };
    }
    if (!reservation.sync.markOptimisticApplied(reservation.clientActionId)) {
      const state = this._markOnlineActionUncertain(reservation, "optimistic_action_commit_failed");
      return { ...result, success: false, reason: "ACTION_OUTCOME_UNKNOWN", state };
    }
    if (!this._isCurrentOnlineActionReservation(reservation)) {
      const state = this._markOnlineActionUncertain(reservation, "action_owner_changed_after_optimistic_apply");
      result.state = state;
      result.reason = "ACTION_OUTCOME_UNKNOWN";
      return result;
    }
    try {
      result.state = this.refreshOnlineActionSyncState();
    } catch (error) {
      const state = this._markOnlineActionUncertain(reservation, "move_refresh_failed_before_send", error);
      return { ...result, success: false, reason: "ACTION_OUTCOME_UNKNOWN", state };
    }
    if (!this._isCurrentOnlineActionReservation(reservation)) {
      const state = this._markOnlineActionUncertain(reservation, "action_owner_changed_before_send");
      return { ...result, success: false, reason: "ACTION_OUTCOME_UNKNOWN", state };
    }
    reservation.sendPromise = this._sendReservedOnlineAction(reservation);
    if (retry) return { ...result, retrySendPromise: reservation.sendPromise };
    return result;
  }

  enableMultiplayer(options = {}, syncState = true) {
    return this.setMultiplayerState({
      enabled: true,
      ...options,
    }, syncState);
  }

  disableMultiplayer() {
    this._invalidatePendingRoomOperation();
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
    this._touchInputOwnershipEpoch += 1;
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
    this._touchInputOwnershipEpoch += 1;
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
      point: clonePoint(this.lastAction.point),
    };
  }

  _cloneLastMoves() {
    return Object.fromEntries(Object.entries(this.lastMoves ?? {}).map(([player, point]) => [
      player, clonePoint(point),
    ]));
  }

  _setLastAction(action = null, previousSkips = 0) {
    if (!action) {
      this.lastAction = null;
      this.lastMoves = {};
      return;
    }

    this.lastMoves ??= {};
    updateLastMoves(this.lastMoves, action, this.engine, previousSkips);
    this.lastAction = {
      type: action.type ?? null,
      player: action.player ?? null,
      point: clonePoint(action.point),
    };
  }

  _buildGameState(snapshot = this.engine.getSnapshot()) {
    // 这里把底层快照补齐成 UI 可直接消费的状态，包含联机锁定原因等派生字段。
    const scorePlayers = PLAYER_ORDER.slice(0, Math.max(3, snapshot.playerCount ?? 2));
    const interactionLockReason = this._getInteractionLockReason(snapshot);
    const skipLockReason = this._getSkipLockReason(snapshot);
    const resetLockReason = this._getResetLockReason(snapshot);

    return {
      rulesVersion: snapshot.rulesVersion,
      protectionRule: snapshot.protectionRule,
      positionRevision: snapshot.positionRevision,
      currentPlayer: snapshot.currentPlayer,
      gameOver: snapshot.gameOver,
      territoryPending: Boolean(snapshot.territoryPending),
      winner: snapshot.winner,
      turnCount: snapshot.turnCount,
      consecutiveSkips: snapshot.consecutiveSkips,
      resignedPlayers: Array.isArray(snapshot.resignedPlayers) ? [...snapshot.resignedPlayers] : [],
      scores: Object.fromEntries(scorePlayers.map((player) => [player, snapshot.territories?.[player]?.area ?? 0])),
      displayScores: Object.fromEntries(scorePlayers.map((player) => [
        player, snapshot.territories?.[player]?.displayArea ?? snapshot.territories?.[player]?.area ?? 0,
      ])),
      territories: snapshot.territories,
      legalMoves: snapshot.legalMoves,
      legalRootActions: snapshot.legalRootActions ?? [],
      roots: snapshot.roots,
      rootMode: snapshot.rootMode,
      rootRulesVersion: snapshot.rootRulesVersion,
      rootActionsRemaining: snapshot.rootActionsRemaining,
      snapshot,
      lastAction: this._cloneLastAction(),
      lastMoves: this._cloneLastMoves(),
      players: Array.isArray(snapshot.players)
        ? [...snapshot.players]
        : PLAYER_ORDER.slice(0, snapshot.playerCount ?? this.options.engine.playerCount),
      playerCount: snapshot.playerCount ?? this.options.engine.playerCount,
      boardShape: snapshot.boardShape ?? ((snapshot.playerCount ?? 2) >= 4 ? "hexagon" : "triangle"),
      isTopologyBoard: Boolean(snapshot.isTopologyBoard),
      boardHash: snapshot.boardHash ?? null,
      boardDefinition: snapshot.boardDefinition ?? null,
      multiplayerEnabled: this.multiplayerEnabled,
      roomOperationPending: this.hasPendingRoomOperation(),
      roomOperationUnconfirmed: this._pendingRoomOperation?.phase === "uncertain"
        || this._onlineActionLedgerState()?.pending?.some((item) => item.status === "uncertain") === true
        || this._onlineActionLedgerState()?.recoveryRequired === true,
      onlineActionPending: Boolean(this._onlineActionLedgerState()?.pending?.length),
      onlineActionProtocolStatus: this._onlineActionLedgerState()?.protocol?.status ?? null,
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
    const layout = this.renderer.layout;
    return {
      x: (clientX - rect.left) * ((layout?.cssWidth ?? rect.width) / (rect.width || 1)),
      y: (clientY - rect.top) * ((layout?.cssHeight ?? rect.height) / (rect.height || 1)),
    };
  }

  _findNearestGridPoint(pixelX, pixelY) {
    if (this.engine?.isTopologyBoard) {
      return this.renderer.getTopologyHitVertexId(pixelX, pixelY);
    }
    const validPoints = this._validGridPoints?.length
      ? this._validGridPoints
      : this._deriveValidPoints(this.engine.gridSize ?? this.options.engine.gridSize, this.engine.playerCount, this.engine.boardShape);

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

  _deriveValidPoints(gridSize, playerCount = 2, boardShape = null) {
    return getBoardPositions(gridSize, playerCount, boardShape);
  }

  _getInteractionLockReason(snapshot = this.engine.getSnapshot()) {
    if (this.readOnlyMode) {
      return "READ_ONLY_REPLAY";
    }

    if (snapshot.gameOver) {
      return "GAME_OVER";
    }

    const onlineActionLockReason = this._getOnlineActionLockReason();
    if (onlineActionLockReason) return onlineActionLockReason;

    if (!this.multiplayerEnabled) {
      return null;
    }

    if (this._authoritativeSnapshotValid === false) {
      return "AUTHORITATIVE_SNAPSHOT_INVALID";
    }

    if (this._pendingRoomOperation) {
      return this._pendingRoomOperation.phase === "uncertain"
        ? "ROOM_ACTION_UNCONFIRMED"
        : "ROOM_ACTION_PENDING";
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
    if (this.networkManager.serverAuthoritative && typeof this.networkManager.canAct === "function" && !this.networkManager.canAct()) {
      return "ACTION_PENDING";
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

    const onlineActionLockReason = this._getOnlineActionLockReason();
    if (onlineActionLockReason) return onlineActionLockReason;

    if (!this.multiplayerEnabled) {
      return null;
    }

    return this._getInteractionLockReason(snapshot);
  }

  _getResetLockReason(snapshot = this.engine.getSnapshot()) {
    const onlineActionLockReason = this._getOnlineActionLockReason();
    if (onlineActionLockReason) return onlineActionLockReason;

    if (!this.multiplayerEnabled) {
      return null;
    }

    if (this._authoritativeSnapshotValid === false) {
      return "AUTHORITATIVE_SNAPSHOT_INVALID";
    }

    if (this._pendingRoomOperation) {
      return this._pendingRoomOperation.phase === "uncertain"
        ? "ROOM_ACTION_UNCONFIRMED"
        : "ROOM_ACTION_PENDING";
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

    if (!snapshot.gameOver && this.networkManager.serverAuthoritative
      && typeof this.networkManager.canAct === "function" && !this.networkManager.canAct()) return "NOT_YOUR_TURN";
    return null;
  }

  _syncCanvasInteractivity(snapshot = this.engine.getSnapshot(), state = null) {
    const interactionLockReason = state?.interactionLockReason ?? this._getInteractionLockReason(snapshot);
    const locked = Boolean(interactionLockReason);
    this.canvas.style.cursor = locked ? "not-allowed" : "pointer";
    this.canvas.setAttribute("aria-disabled", locked ? "true" : "false");
  }

  _syncSnapshot(snapshot, { forceRender = false, scheduleTerritory = true } = {}) {
    const preview = this._territoryPreview;
    const renderTerritories = snapshot.territoryPending && preview?.engine === this.engine
      && preview.positionRevision === snapshot.positionRevision
      && preview.rulesVersion === snapshot.rulesVersion
      && preview.currentPlayer === snapshot.currentPlayer
      && preview.territoryStateRevision === this.engine.getTerritoryStateRevision()
      ? preview.territories : null;
    this.renderer.render({
      ...snapshot,
      renderTerritories,
      legalMoves: this.readOnlyMode ? [] : snapshot.legalMoves,
      renderEpoch: this._engineEpoch,
      lastAction: this._cloneLastAction(),
      lastMoves: this._cloneLastMoves(),
      inspectionOverlay: this.inspectionOverlay,
    }, { force: forceRender });
    this._syncCanvasInteractivity(snapshot);
    this._emitStateChange(snapshot);
    if (scheduleTerritory) {
      this._scheduleTerritoryRefresh();
    }
  }

  _applyMove(point, actingPlayer = this.engine.getCurrentPlayer()) {
    if (!isMovePosition(point)) {
      const snapshot = this.engine.getSnapshot();
      return {
        success: false,
        reason: "INVALID_MOVE",
        point: null,
        state: this._buildGameState(snapshot),
      };
    }
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

    this._emitActionFeedback({
      type: "move",
      success: result.success,
      reason: result.reason,
      player: actingPlayer,
      point: normalizedPoint,
    });

    return {
      success: result.success,
      reason: result.reason,
      point: normalizedPoint,
      state: this._buildGameState(result.snapshot),
    };
  }

  _applyRootAction(type, point, actingPlayer = this.engine.getCurrentPlayer()) {
    const normalizedPoint = clonePoint(point);
    const result = this.engine.playRootAction(type, normalizedPoint);
    if (result.success) {
      this._setLastAction({ type: `root_${type}`, player: actingPlayer, point: normalizedPoint });
      this._syncSnapshot(result.snapshot);
    }
    this._emitActionFeedback({ type: `root_${type}`, success: result.success, reason: result.reason, player: actingPlayer, point: normalizedPoint });
    return { success: result.success, reason: result.reason, point: normalizedPoint, state: this._buildGameState(result.snapshot) };
  }

  _reportNetworkError(error) {
    if (this.networkErrorListener) {
      this.networkErrorListener(error);
      return;
    }

    console.error(error);
  }

  _emitActionFeedback(feedback) {
    if (this.actionFeedbackListener) {
      this.actionFeedbackListener({
        ...feedback,
        point: clonePoint(feedback?.point),
      });
    }
  }

  async _syncLocalMove(point) {
    if (!this.multiplayerEnabled || !this.networkManager) {
      return;
    }

    try {
      const move = this.engine?.isTopologyBoard
        ? { vertexId: point, boardHash: this.engine.boardHash }
        : clonePoint(point);
      await this.networkManager.sendMove(move);
    } catch (error) {
      this._reportNetworkError(error);
    }
  }

  _processPointer(clientX, clientY) {
    const snapshot = this.engine.getSnapshot();
    const lockReason = this._getInteractionLockReason(snapshot);
    if (lockReason) {
      this._emitActionFeedback({ type: "move", success: false, reason: lockReason, point: null });
      return {
        success: false,
        reason: lockReason,
        state: this._buildGameState(snapshot),
      };
    }

    const relative = this._getCanvasRelativePosition(clientX, clientY);
    const point = this._findNearestGridPoint(relative.x, relative.y);
    if (!point) {
      this._emitActionFeedback({ type: "move", success: false, reason: "MISS", point: null });
      return {
        success: false,
        reason: "MISS",
        state: this._buildGameState(snapshot),
      };
    }

    if (this.multiplayerEnabled && this.networkManager?.serverAuthoritative) {
      // The shared service is the sole authority. A lost response must not
      // leave an optimistic move on the local board.
      if (!this.engine._evaluateMove(point, snapshot.currentPlayer).legal) {
        this._emitActionFeedback({ type: "move", success: false, reason: "INVALID_MOVE", point });
        return { success: false, reason: "INVALID_MOVE", state: this.getGameState() };
      }
      void this._syncLocalMove(point);
      return { success: true, pending: true, reason: null, state: this.getGameState() };
    }
    const sourceEngine = this.engine;
    const sourceEngineEpoch = this._engineEpoch;
    const versionedResult = this.multiplayerEnabled && this._onlineActionSync?.getState?.().protocol?.status === "selected"
      ? this._performVersionedMove(point, snapshot.currentPlayer) : null;
    const result = versionedResult ?? this._applyMove(point, snapshot.currentPlayer);
    if (result.success && !versionedResult) void this._syncLocalMove(point);
    if (result.success && !versionedResult && !this.multiplayerEnabled
      && this.engine === sourceEngine && this._engineEpoch === sourceEngineEpoch) {
      // Local persistence listeners are installed by the host only when needed.
      try { this.successfulLocalPointerMoveListener?.(this); } catch (_error) {}
    }

    return result;
  }

  _handleClick(event) {
    const suppression = this._touchClickSuppression;
    if (suppression) {
      const explicitMouse = event.pointerType === "mouse"
        || event.sourceCapabilities?.firesTouchEvents === false;
      const isRecentTouchClick = Date.now() <= suppression.expiresAt
        && Math.hypot(event.clientX - suppression.x, event.clientY - suppression.y)
          <= TOUCH_CLICK_SUPPRESSION_RADIUS_CSS_PX;
      if (explicitMouse) {
        this._touchClickSuppression = null;
      } else if (isRecentTouchClick) {
        this._touchClickSuppression = null;
        return;
      } else if (Date.now() > suppression.expiresAt) {
        this._touchClickSuppression = null;
      }
    }
    this._processPointer(event.clientX, event.clientY);
  }

  _handleTouchStart(event) {
    if (event.cancelable !== false) event.preventDefault();
    if (!this._isInitialized || !this._isTouchSurfaceInteractive()) return;

    const touches = Array.from(event.touches ?? []);
    if (touches.length !== 1) {
      if (this._pendingTouchGesture) this._pendingTouchGesture.cancelled = true;
      return;
    }

    const touch = touches[0];
    if (!Number.isFinite(event.timeStamp) || event.timeStamp < this._touchLifecycleStartedAt) return;
    if (this._pendingTouchGesture) {
      this._pendingTouchGesture.cancelled = true;
      return;
    }

    const snapshot = this.engine.getSnapshot();
    if (this._getInteractionLockReason(snapshot)) return;
    this._pendingTouchGesture = {
      identifier: touch.identifier,
      startX: touch.clientX,
      startY: touch.clientY,
      cancelled: false,
      engine: this.engine,
      engineEpoch: this._engineEpoch,
      positionRevision: snapshot.positionRevision,
      inputOwner: this._captureTouchInputOwner(),
      mapping: this._captureTouchMapping(),
      lifecycleEpoch: this._touchLifecycleEpoch,
      startTimeStamp: event.timeStamp,
    };
  }

  _handlePointerDown(event) {
    if (event.pointerType === "mouse") {
      this._touchClickSuppression = null;
    }
  }

  _captureTouchInputOwner() {
    return {
      readOnlyMode: this.readOnlyMode,
      multiplayerEnabled: this.multiplayerEnabled,
      localPlayer: this.localPlayer,
      roomReady: this.roomReady,
      opponentConnected: this.opponentConnected,
      networkManager: this.networkManager,
      authoritativeSnapshotValid: this._authoritativeSnapshotValid,
      ownershipEpoch: this._touchInputOwnershipEpoch,
    };
  }

  _touchInputOwnerMatches(owner) {
    const current = this._captureTouchInputOwner();
    return Object.keys(owner).every((key) => owner[key] === current[key]);
  }

  _touchGestureIsCurrent(gesture) {
    const snapshot = this.engine.getSnapshot();
    return this._isInitialized
      && gesture.lifecycleEpoch === this._touchLifecycleEpoch
      && gesture.engine === this.engine
      && gesture.engineEpoch === this._engineEpoch
      && gesture.positionRevision === snapshot.positionRevision
      && this._touchMappingMatches(gesture.mapping)
      && this._touchInputOwnerMatches(gesture.inputOwner)
      && !this._getInteractionLockReason(snapshot);
  }

  _captureTouchMapping() {
    const rect = this.canvas.getBoundingClientRect();
    const layout = this.renderer.layout ?? {};
    return {
      rect: [rect.left, rect.top, rect.width, rect.height],
      layout: [layout.cssWidth, layout.cssHeight, layout.scale, layout.offsetX, layout.offsetY],
    };
  }

  _touchMappingMatches(mapping) {
    const current = this._captureTouchMapping();
    return mapping.rect.every((value, index) => value === current.rect[index])
      && mapping.layout.every((value, index) => value === current.layout[index]);
  }

  _rememberTouchClickSuppression(x, y) {
    this._touchClickSuppression = {
      x,
      y,
      expiresAt: Date.now() + TOUCH_CLICK_SUPPRESSION_MS,
    };
  }

  _cancelPendingTouchGesture({ suppressClick = false } = {}) {
    const gesture = this._pendingTouchGesture;
    if (!gesture) return;
    if (suppressClick) {
      this._rememberTouchClickSuppression(gesture.startX, gesture.startY);
    }
    this._pendingTouchGesture = null;
    this._touchLifecycleEpoch += 1;
  }

  _suspendTouchForLifecycle(event) {
    if (event.type === "lifeline:background") this._touchHostActive = false;
    if (event.type === "blur") this._touchWindowFocused = false;
    this._cancelPendingTouchGesture({ suppressClick: true });
  }

  _resumeTouchForLifecycle(event) {
    if (event.type === "lifeline:foreground") {
      this._touchHostActive = globalThis.__LIFELINE_APP_ACTIVE__ !== false;
    }
    if (event.type === "focus") this._touchWindowFocused = true;
    this._touchDocumentVisible = typeof document === "undefined" || document.visibilityState !== "hidden";
  }

  _handleTouchVisibility() {
    this._touchDocumentVisible = typeof document === "undefined" || document.visibilityState !== "hidden";
    if (!this._touchDocumentVisible) {
      this._cancelPendingTouchGesture({ suppressClick: true });
    }
  }

  _isTouchSurfaceInteractive() {
    return this._touchHostActive !== false
      && this._touchWindowFocused !== false
      && this._touchDocumentVisible !== false
      && globalThis.__LIFELINE_APP_ACTIVE__ !== false
      && (typeof document === "undefined" || document.visibilityState !== "hidden");
  }

  _handleAnyTouchStart(event) {
    const gesture = this._pendingTouchGesture;
    if (gesture && Array.from(event.touches ?? []).length > 1) {
      if (event.cancelable !== false) event.preventDefault();
      gesture.cancelled = true;
    }
  }

  _handleTouchMove(event) {
    const gesture = this._pendingTouchGesture;
    if (!gesture) return;
    if (event.cancelable !== false) event.preventDefault();
    const touches = Array.from(event.touches ?? []);
    if (touches.length !== 1) {
      gesture.cancelled = true;
      return;
    }
    const touch = touches.find((item) => item.identifier === gesture.identifier);
    if (!touch) {
      gesture.cancelled = true;
      return;
    }
    if (Math.hypot(touch.clientX - gesture.startX, touch.clientY - gesture.startY) > TOUCH_MOVE_THRESHOLD_CSS_PX) {
      gesture.cancelled = true;
    }
  }

  _handleTouchEnd(event) {
    if (event.cancelable !== false) event.preventDefault();
    const changedTouches = Array.from(event.changedTouches ?? []);

    const gesture = this._pendingTouchGesture;
    if (!gesture) return;
    const touch = changedTouches.find((item) => item.identifier === gesture.identifier);
    if (!touch) {
      const activeTouchStillDown = Array.from(event.touches ?? [])
        .some((item) => item.identifier === gesture.identifier);
      if (!activeTouchStillDown) this._cancelPendingTouchGesture({ suppressClick: true });
      else if (Array.from(event.touches ?? []).length > 1) gesture.cancelled = true;
      return;
    }

    const endAfterStart = Number.isFinite(event.timeStamp) && event.timeStamp >= gesture.startTimeStamp;
    if (!endAfterStart) return;
    const noOtherTouches = Array.from(event.touches ?? []).length === 0;
    const finalDistance = Math.hypot(touch.clientX - gesture.startX, touch.clientY - gesture.startY);
    if (finalDistance > TOUCH_MOVE_THRESHOLD_CSS_PX) gesture.cancelled = true;
    const shouldCommit = !gesture.cancelled && noOtherTouches && endAfterStart && this._touchGestureIsCurrent(gesture);
    this._rememberTouchClickSuppression(touch.clientX, touch.clientY);
    this._pendingTouchGesture = null;
    this._touchLifecycleEpoch += 1;
    if (shouldCommit) this._processPointer(touch.clientX, touch.clientY);
  }

  _handleTouchCancel(event) {
    if (event.cancelable !== false) event.preventDefault();
    const changedTouches = Array.from(event.changedTouches ?? []);
    const gesture = this._pendingTouchGesture;
    if (!gesture || (changedTouches.length && !changedTouches.some((touch) => touch.identifier === gesture.identifier))) return;
    this._rememberTouchClickSuppression(gesture.startX, gesture.startY);
    this._pendingTouchGesture = null;
    this._touchLifecycleEpoch += 1;
  }

  applyRemoteMove(point) {
    const recoveryLock = this._getRemoteRecoveryLock();
    if (recoveryLock) {
      return recoveryLock;
    }

    if (!(this.engine?.isTopologyBoard ? isTopologyVertexId(point) : isGridPoint(point))) {
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
    const previousSkips = this.engine.consecutiveSkips;
    const result = this.engine.skipTurn();
    if (result.success) {
      this._setLastAction({
        type: "skip",
        player: actingPlayer,
        point: null,
      }, previousSkips);
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

  prepareVersionedActionApplication(action, { optimisticLocal = false, expectedActorColor = null, resolvePlayerColor = null } = {}) {
    if (this._preparedOnlineActions.size >= 8) return { success: false, reason: "PREPARED_ACTION_LIMIT" };
    if (!action || !["player_move", "player_skip", "player_resign"].includes(action.type)
      || !isKnownPlayer(action.color) || typeof action.playerId !== "string" || !action.playerId) {
      return { success: false, reason: "INVALID_VERSIONED_ACTION" };
    }
    const mappedColor = typeof resolvePlayerColor === "function" ? resolvePlayerColor(action.playerId) : null;
    if (mappedColor !== action.color) return { success: false, reason: "ACTION_PLAYER_IDENTITY_MISMATCH" };
    if (optimisticLocal && expectedActorColor !== action.color) return { success: false, reason: "LOCAL_ACTION_COLOR_MISMATCH" };
    if (!optimisticLocal && action.type !== "player_resign" && this.engine.getCurrentPlayer() !== action.color) {
      return { success: false, reason: "ACTION_ACTOR_MISMATCH" };
    }

    let candidateEngine = null;
    let lastAction = this._cloneLastAction();
    if (!optimisticLocal) {
      candidateEngine = this._createEngine(this.options.engine);
      candidateEngine._restoreReplayState(this.engine._captureReplayState());
      let result;
      if (action.type === "player_move") {
        if (!isGridPoint(action.point)) return { success: false, reason: "INVALID_REMOTE_MOVE" };
        result = candidateEngine.playMove(clonePoint(action.point));
        lastAction = { type: "move", player: action.color, point: clonePoint(action.point) };
      } else if (action.type === "player_skip") {
        result = candidateEngine.skipTurn();
        lastAction = { type: "skip", player: action.color, point: null };
      } else {
        result = candidateEngine.resignPlayer(action.color);
        lastAction = { type: "resign", player: action.color, point: null };
      }
      if (!result.success && !(action.type === "player_resign" && result.reason === "PLAYER_ALREADY_RESIGNED")) {
        return { success: false, reason: result.reason ?? "ACTION_APPLICATION_FAILED" };
      }
    }

    const token = `prepared-action-${++this._preparedTransactionSequence}`;
    this._preparedOnlineActions.set(token, {
      candidateEngine, lastAction, baseEngine: this.engine, baseEngineEpoch: this._engineEpoch,
      basePositionRevision: this.engine.getSnapshot().positionRevision,
    });
    return { success: true, token, applied: !optimisticLocal };
  }

  abortVersionedActionApplication(token) {
    return this._preparedOnlineActions.delete(token);
  }

  commitVersionedActionApplication(token) {
    const installed = this.installVersionedActionApplication(token);
    if (!installed.success) return installed;
    return this.publishVersionedActionApplication(token);
  }

  installVersionedActionApplication(token) {
    const prepared = this._preparedOnlineActions.get(token);
    if (!prepared) return { success: false, reason: "PREPARED_ACTION_STALE", state: this.getGameState() };
    if (prepared.installed) return { success: true, installed: true };
    if (this.engine !== prepared.baseEngine || this._engineEpoch !== prepared.baseEngineEpoch
      || this.engine.getSnapshot().positionRevision !== prepared.basePositionRevision) {
      return { success: false, reason: "PREPARED_ACTION_OWNER_CHANGED", state: this.getGameState() };
    }
    if (prepared.candidateEngine) {
      prepared.previous = { engine: this.engine, validGridPoints: this._validGridPoints, engineEpoch: this._engineEpoch,
        lastAction: this._cloneLastAction() };
      try {
        this.engine = prepared.candidateEngine;
        this._validGridPoints = this.engine.getValidPositions();
        this._engineEpoch += 1;
        this.lastAction = { ...prepared.lastAction, point: Array.isArray(prepared.lastAction.point) ? [...prepared.lastAction.point] : null };
        if (this.engine !== prepared.candidateEngine || this._engineEpoch !== prepared.previous.engineEpoch + 1) {
          throw new Error("Prepared action owner changed during installation.");
        }
      } catch (error) {
        this.rollbackVersionedActionApplication(token);
        return { success: false, reason: "PREPARED_ACTION_INSTALL_FAILED", error, state: this.getGameState() };
      }
    }
    prepared.installed = true;
    return { success: true, installed: true };
  }

  rollbackVersionedActionApplication(token) {
    const prepared = this._preparedOnlineActions.get(token);
    if (!prepared || (!prepared.installed && !prepared.previous)) return false;
    if (prepared.previous) {
      this.engine = prepared.previous.engine; this._validGridPoints = prepared.previous.validGridPoints;
      this._engineEpoch = prepared.previous.engineEpoch; this.lastAction = prepared.previous.lastAction;
    }
    prepared.installed = false; prepared.previous = null;
    return true;
  }

  publishVersionedActionApplication(token) {
    const prepared = this._preparedOnlineActions.get(token);
    if (!prepared?.installed) return { success: false, reason: "PREPARED_ACTION_NOT_INSTALLED", state: this.getGameState() };
    this._preparedOnlineActions.delete(token);
    try {
      if (prepared.candidateEngine) this._cancelTerritoryRefresh();
      this._syncSnapshot(this.engine.getSnapshot());
    } catch (error) {
      try { this._reportNetworkError(error); } catch (_reportError) {}
    }
    return { success: true, state: this.getGameState() };
  }

  prepareMatchState(matchState = null, options = {}) {
    if (this._preparedMatchStates.size >= 4) return { success: false, reason: "PREPARED_MATCH_STATE_LIMIT" };
    return this.restoreMatchState(matchState, { ...options, deferCommit: true });
  }

  abortPreparedMatchState(token) {
    return this._preparedMatchStates.delete(token);
  }

  commitPreparedMatchState(token) {
    const installed = this.installPreparedMatchState(token);
    if (!installed.success) return installed;
    return this.publishPreparedMatchState(token);
  }

  installPreparedMatchState(token) {
    const prepared = this._preparedMatchStates.get(token);
    if (!prepared) return { success: false, reason: "PREPARED_MATCH_STATE_STALE", state: this.getGameState() };
    if (prepared.installed) return { success: true, installed: true };
    const baseSnapshot = prepared.baseEngine.getSnapshot();
    if (this.engine !== prepared.baseEngine || this._engineEpoch !== prepared.baseEngineEpoch
      || baseSnapshot.positionRevision !== prepared.basePositionRevision) {
      return { success: false, reason: "PREPARED_MATCH_STATE_OWNER_CHANGED", state: this.getGameState() };
    }

    prepared.previous = { engine: this.engine, engineOptions: this.options.engine, validGridPoints: this._validGridPoints,
      engineEpoch: this._engineEpoch, lastAction: this._cloneLastAction(), lastVersionedRestore: this._lastVersionedRestore,
      authoritativeSnapshotValid: this._authoritativeSnapshotValid };
    try {
      this.options.engine = prepared.nextEngineOptions;
      this.engine = prepared.candidateEngine;
      this._validGridPoints = this.engine.getValidPositions();
      this._engineEpoch += 1;
      this._lastVersionedRestore = prepared.versionedScope ? {
        scope: { ...prepared.versionedScope }, engine: this.engine, engineEpoch: this._engineEpoch,
        positionRevision: this.engine.getSnapshot().positionRevision,
      } : null;
      this._authoritativeSnapshotValid = true;
      const lastAction = prepared.replayResult.lastAction;
      this.lastAction = lastAction ? { ...lastAction, point: Array.isArray(lastAction.point) ? [...lastAction.point] : null } : null;
      if (this.engine !== prepared.candidateEngine || this._engineEpoch !== prepared.previous.engineEpoch + 1) {
        throw new Error("Prepared match state owner changed during installation.");
      }
      prepared.installed = true;
    } catch (error) {
      this.rollbackPreparedMatchState(token);
      return { success: false, reason: "PREPARED_MATCH_STATE_INSTALL_FAILED", error, state: this.getGameState() };
    }
    return { success: true, installed: true };
  }

  rollbackPreparedMatchState(token) {
    const prepared = this._preparedMatchStates.get(token);
    if (!prepared?.previous) return false;
    this.engine = prepared.previous.engine; this.options.engine = prepared.previous.engineOptions;
    this._validGridPoints = prepared.previous.validGridPoints; this._engineEpoch = prepared.previous.engineEpoch;
    this.lastAction = prepared.previous.lastAction; this._lastVersionedRestore = prepared.previous.lastVersionedRestore;
    this._authoritativeSnapshotValid = prepared.previous.authoritativeSnapshotValid;
    prepared.installed = false; prepared.previous = null;
    return true;
  }

  publishPreparedMatchState(token) {
    const prepared = this._preparedMatchStates.get(token);
    if (!prepared?.installed) return { success: false, reason: "PREPARED_MATCH_STATE_NOT_INSTALLED", state: this.getGameState() };
    this._preparedMatchStates.delete(token);
    try {
      this._invalidatePendingRoomOperation(); this._cancelTerritoryRefresh();
      this.renderer.invalidate(); this._updateLargeBoardClass(); this._syncSnapshot(prepared.replayResult.snapshot);
    } catch (error) { try { this._reportNetworkError(error); } catch (_reportError) {} }
    return { success: true, reason: null, state: this.getGameState() };
  }

  restoreMatchState(matchState = null, restoreOptions = {}) {
    // 联机重连后，在临时引擎上批量回放；只有完整成功才替换当前棋盘。
    const actions = Array.isArray(matchState?.actions) ? matchState.actions : [];
    const incomingSettings = matchState?.settings;
    const normalizedIncomingSettings = incomingSettings && typeof incomingSettings === "object"
      ? {
          ...incomingSettings,
          protectionRule: Object.hasOwn(incomingSettings, "protectionRule")
            ? incomingSettings.protectionRule : StartProtectionRule.SYMMETRIC,
        }
      : null;
    const previousOptions = { ...(this.options.engine ?? {}) };
    if (incomingSettings && typeof incomingSettings === "object") {
      // A settings-bearing restore is authoritative about board identity.  In
      // particular, a legacy tutorial/replay must not inherit a previously
      // selected topology definition merely because the controller was using
      // one before the restore began.  The incoming settings can still supply
      // their own topology payload below.
      delete previousOptions.initialPositions;
      delete previousOptions.initialRoots;
      delete previousOptions.startingPointMode;
      delete previousOptions.rootMode;
      delete previousOptions.rootRulesVersion;
      delete previousOptions.boardShape;
      delete previousOptions.boardDefinition;
      delete previousOptions.compiledBoard;
      delete previousOptions.boardHash;
      delete previousOptions.topologyProtocolVersion;
      delete previousOptions.turnOrder;
    }
    const nextEngineOptions = {
      ...DEFAULT_ENGINE_OPTIONS,
      ...previousOptions,
      ...(normalizedIncomingSettings ?? {}),
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
      candidateEngine = this._createEngine(nextEngineOptions);
      replayResult = candidateEngine.replayBatch((engine) => {
        let lastAction = null;
        const lastMoves = {};

        for (let index = 0; index < actions.length; index += 1) {
          const action = actions[index];
          if (!action || typeof action.type !== "string") {
            return {
              success: false,
              reason: `Replay action ${index + 1} is malformed.`,
            };
          }

          if (restoreOptions.strictVersionedActions && (action.type === "player_move" || action.type === "player_skip")) {
            const mappedColor = typeof restoreOptions.resolvePlayerColor === "function"
              ? restoreOptions.resolvePlayerColor(action.playerId) : null;
            if (!isKnownPlayer(action.color) || mappedColor !== action.color || engine.getCurrentPlayer() !== action.color) {
              return { success: false, reason: `Replay action ${index + 1} has a conflicting actor color.` };
            }
          }

          if (action.type === "player_move") {
            const point = engine.isTopologyBoard ? action.vertexId : action.point;
            const validMove = engine.isTopologyBoard
              ? isTopologyVertexId(point) && action.boardHash === engine.boardHash
              : isGridPoint(point);
            if (!validMove) {
              return {
                success: false,
                reason: `Replay move ${index + 1} has an invalid point.`,
              };
            }
            const actingPlayer = engine.getCurrentPlayer();
            const result = engine.playMove(clonePoint(point));
            if (!result.success) {
              return {
                success: false,
                reason: `Replay move ${index + 1} failed: ${result.reason}`,
              };
            }
            lastAction = {
              type: "move",
              player: actingPlayer,
              point: clonePoint(point),
            };
            updateLastMoves(lastMoves, lastAction, engine);
            continue;
          }

          if (action.type === "player_skip") {
            const actingPlayer = engine.getCurrentPlayer();
            const previousSkips = engine.consecutiveSkips;
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
            updateLastMoves(lastMoves, lastAction, engine, previousSkips);
            continue;
          }

          if (action.type === "player_root_relocate" || action.type === "player_root_add") {
            if (!isGridPoint(action.point)) return { success: false, reason: `Replay root action ${index + 1} has an invalid point.` };
            const actingPlayer = engine.getCurrentPlayer();
            const type = action.type === "player_root_relocate" ? "relocate" : "add";
            const result = engine.playRootAction(type, clonePoint(action.point));
            if (!result.success) return { success: false, reason: `Replay root action ${index + 1} failed: ${result.reason}` };
            lastAction = { type: `root_${type}`, player: actingPlayer, point: clonePoint(action.point) };
            updateLastMoves(lastMoves, lastAction, engine);
            continue;
          }

          if (action.type === "player_resign") {
            if (!isKnownPlayer(action.color)) {
              return {
                success: false,
                reason: `Replay resignation ${index + 1} has an invalid player.`,
              };
            }
            if (restoreOptions.strictVersionedActions) {
              const mappedColor = typeof restoreOptions.resolvePlayerColor === "function"
                ? restoreOptions.resolvePlayerColor(action.playerId) : null;
              if (mappedColor !== action.color) {
                return { success: false, reason: `Replay resignation ${index + 1} has a conflicting player identity.` };
              }
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
            if (result.success) updateLastMoves(lastMoves, lastAction, engine);
            else lastMoves[action.color] = null;
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
          lastMoves,
        };
      });
    } catch (error) {
      return preserveCurrentEngine(error);
    }

    if (!replayResult.success) {
      return preserveCurrentEngine(replayResult.reason);
    }

    if (restoreOptions.deferCommit === true) {
      if (this._preparedMatchStates.size >= 4) return { success: false, reason: "PREPARED_MATCH_STATE_LIMIT" };
      const token = `prepared-match-${++this._preparedTransactionSequence}`;
      this._preparedMatchStates.set(token, {
        candidateEngine,
        nextEngineOptions,
        replayResult,
        baseEngine: this.engine,
        baseEngineEpoch: this._engineEpoch,
        basePositionRevision: this.engine.getSnapshot().positionRevision,
        versionedScope: restoreOptions.versionedScope ?? null,
      });
      return { success: true, prepared: true, token, reason: null, snapshot: replayResult.snapshot };
    }
    this._invalidatePendingRoomOperation();

    const previousControllerState = {
      engine: this.engine,
      engineOptions: this.options.engine,
      validGridPoints: this._validGridPoints,
      engineEpoch: this._engineEpoch,
      lastAction: this._cloneLastAction(),
      lastMoves: this._cloneLastMoves(),
    };

    try {
      this._cancelTerritoryRefresh();
      this.options.engine = nextEngineOptions;
      this.engine = candidateEngine;
      this._validGridPoints = candidateEngine.getValidPositions();
      this._engineEpoch += 1;
      this.setAuthoritativeSnapshotValid(true);
      this.renderer.invalidate();
      this.lastAction = replayResult.lastAction;
      this.lastMoves = replayResult.lastMoves;
      this._lastServerActionIndex = actions.reduce((maximum, action, index) =>
        Math.max(maximum, Number.isInteger(action?.actionIndex) ? action.actionIndex : index + 1), 0);
      this._updateLargeBoardClass();
      this._syncSnapshot(replayResult.snapshot);
    } catch (error) {
      this.options.engine = previousControllerState.engineOptions;
      this.engine = previousControllerState.engine;
      this._validGridPoints = previousControllerState.validGridPoints;
      this._engineEpoch = previousControllerState.engineEpoch;
      this.lastAction = previousControllerState.lastAction;
      this.lastMoves = previousControllerState.lastMoves;
      this._lastServerActionIndex = previousControllerState.lastServerActionIndex;
      this._updateLargeBoardClass();
      const previousSnapshot = this.engine.getSnapshot();
      try {
        this.renderer.invalidate();
        this.renderer.render({
          ...previousSnapshot,
          renderEpoch: this._engineEpoch,
          lastAction: this._cloneLastAction(),
          lastMoves: this._cloneLastMoves(),
          inspectionOverlay: this.inspectionOverlay,
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

  /**
   * Restore a complete, isolated topology-state document.
   *
   * Topology saves retain more than a replay prefix: Superko history, logical
   * paths and an in-progress current player are all part of the rules state.
   * Replaying the visible moves alone is therefore not a safe substitute (in
   * particular for an older save whose original start player was not stored in
   * a legacy local-session envelope).  Decode and build a candidate first;
   * only replace the live engine after its complete state has been accepted.
   */
  restoreTopologyState(topologyState, { startPlayer = null, lastAction = null, actions = null } = {}) {
    const previousControllerState = {
      engine: this.engine,
      engineOptions: this.options.engine,
      validGridPoints: this._validGridPoints,
      engineEpoch: this._engineEpoch,
      lastAction: this._cloneLastAction(),
      lastMoves: this._cloneLastMoves(),
    };
    const preserveCurrentEngine = (reason, preservedSnapshot = null) => {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      this._reportNetworkError(error);
      if (this.multiplayerEnabled) this.setAuthoritativeSnapshotValid(false);
      const snapshot = preservedSnapshot ?? this.engine.getSnapshot();
      const state = this._buildGameState(snapshot);
      this._syncCanvasInteractivity(snapshot, state);
      return { success: false, reason: error.message, state };
    };

    let decoded;
    let candidateEngine;
    let snapshot;
    try {
      decoded = decodeTopologyState(topologyState);
      const activePlayers = PLAYER_ORDER.slice(0, Object.keys(decoded.ruleState.startingVertices).length);
      if (activePlayers.length < 2) throw new Error("Topology state has too few active players.");
      const normalizedStartPlayer = decoded.ruleState.turnOrder?.[0] ?? (activePlayers.includes(startPlayer)
        ? startPlayer
        : activePlayers[0]);
      const previousOptions = { ...(this.options.engine ?? {}) };
      delete previousOptions.initialPositions;
      delete previousOptions.startingPointMode;
      delete previousOptions.boardShape;
      delete previousOptions.turnOrder;
      const nextEngineOptions = {
        ...DEFAULT_ENGINE_OPTIONS,
        ...previousOptions,
        playerCount: activePlayers.length,
        boardShape: "custom",
        boardDefinition: decoded.board.definition,
        rulesVersion: decoded.ruleState.rulesVersion,
        initialPositions: decoded.ruleState.startingVertices,
        startPlayer: normalizedStartPlayer,
        ...(decoded.ruleState.turnOrder !== undefined ? { turnOrder: decoded.ruleState.turnOrder } : {}),
        deferTerritoryUpdates: false,
      };
      candidateEngine = this._createEngine(nextEngineOptions);
      const displayHistory = Array.isArray(actions)
        ? replayTopologyLastMoves(this._createEngine(nextEngineOptions), actions, decoded.ruleState) : null;
      if (!candidateEngine?.isTopologyBoard) {
        throw new Error("Decoded topology state did not create a topology engine.");
      }
      candidateEngine.restoreTopologyState(topologyState);
      snapshot = candidateEngine.getSnapshot();

      this._cancelTerritoryRefresh();
      this.options.engine = nextEngineOptions;
      this.engine = candidateEngine;
      this._validGridPoints = candidateEngine.getValidPositions();
      this._engineEpoch += 1;
      this.setAuthoritativeSnapshotValid(true);
      this.renderer.invalidate();
      this.lastAction = displayHistory ? displayHistory.lastAction : (lastAction && typeof lastAction === "object"
        ? { type: lastAction.type, player: lastAction.player ?? null, point: clonePoint(lastAction.point ?? lastAction.vertexId) }
        : null);
      this.lastMoves = displayHistory?.lastMoves ?? {};
      // Legacy snapshots may carry only the last action. Show that one marker
      // only if the canonical vertex is still occupied by that same player.
      if (!displayHistory && this.lastAction?.type === "move" && isKnownPlayer(this.lastAction.player)
        && typeof this.lastAction.point === "string"
        && candidateEngine.getStateAt(this.lastAction.point) === candidateEngine._getPlayerStates(this.lastAction.player).node) {
        this.lastMoves[this.lastAction.player] = this.lastAction.point;
      }
      this._updateLargeBoardClass();
      this._syncSnapshot(snapshot, { forceRender: true, scheduleTerritory: false });
    } catch (error) {
      this.options.engine = previousControllerState.engineOptions;
      this.engine = previousControllerState.engine;
      this._validGridPoints = previousControllerState.validGridPoints;
      this._engineEpoch = previousControllerState.engineEpoch;
      this.lastAction = previousControllerState.lastAction;
      this.lastMoves = previousControllerState.lastMoves;
      this._updateLargeBoardClass();
      const previousSnapshot = this.engine.getSnapshot();
      try {
        this.renderer.invalidate();
        this.renderer.render({
          ...previousSnapshot,
          renderEpoch: this._engineEpoch,
          lastAction: this._cloneLastAction(),
          lastMoves: this._cloneLastMoves(),
          inspectionOverlay: this.inspectionOverlay,
        });
      } catch {
        // Preserve the prior engine even if repaint recovery is unavailable.
      }
      return preserveCurrentEngine(error, previousSnapshot);
    }

    return {
      success: true,
      reason: null,
      state: this._buildGameState(snapshot),
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
    const previousSkips = this.engine.consecutiveSkips;
    const result = this.engine.skipTurn();
    if (result.success) {
      this._setLastAction({
        type: "skip",
        player: actingPlayer,
        point: null,
      }, previousSkips);
      this._syncSnapshot(result.snapshot);
    }
    this._emitActionFeedback({
      type: "skip",
      success: result.success,
      reason: result.reason,
      player: actingPlayer,
      point: null,
    });
    return {
      success: result.success,
      reason: result.reason,
      state: this._buildGameState(result.snapshot),
    };
  }

  playRootAction(type, point) {
    if (this.multiplayerEnabled) return { success: false, reason: "MULTIPLAYER_ROOT_ACTION_UNSUPPORTED", state: this.getGameState() };
    if (!isGridPoint(point)) return { success: false, reason: "INVALID_ROOT_TARGET", state: this.getGameState() };
    return this._applyRootAction(type, point);
  }

  applyRemoteRootAction(type, point) {
    const recoveryLock = this._getRemoteRecoveryLock();
    if (recoveryLock) return recoveryLock;
    if (!isGridPoint(point)) return { success: false, reason: "INVALID_REMOTE_ROOT_ACTION", state: this.getGameState() };
    return this._applyRootAction(type, point);
  }

  async requestRootAction(type, point) {
    if (this._onlineActionSync?.getState?.().protocol?.status === "selected") {
      return { success: false, reason: "ACTION_PROTOCOL_UNSUPPORTED", state: this.getGameState() };
    }
    const lockReason = this._getInteractionLockReason();
    const normalizedType = String(type ?? "").replace(/^root_/, "");
    if (lockReason) return { success: false, reason: lockReason, state: this.getGameState() };
    if (!isGridPoint(point) || !["relocate", "add"].includes(normalizedType)) {
      return { success: false, reason: "INVALID_ROOT_TARGET", state: this.getGameState() };
    }
    if (!this.networkManager || typeof this.networkManager.sendRootAction !== "function") {
      return { success: false, reason: "NETWORK_UNAVAILABLE", state: this.getGameState() };
    }
    try {
      await this.networkManager.sendRootAction(normalizedType, point);
      return { success: true, reason: null, state: this.getGameState() };
    } catch (error) {
      this._reportNetworkError(error);
      return { success: false, reason: "NETWORK_ERROR", state: this.getGameState() };
    }
  }

  async requestSkipTurn() {
    if (!this.multiplayerEnabled) {
      return { success: false, reason: "MULTIPLAYER_SKIP_REQUIRED", state: this.getGameState() };
    }

    const lockReason = this._getSkipLockReason();
    if (lockReason) {
      return {
        success: false,
        reason: lockReason,
        state: this.getGameState(),
      };
    }

    const reservation = this._reserveOnlineAction("player_skip");
    if (reservation.mode === "blocked") {
      return { success: false, reason: reservation.reason, state: this.getGameState() };
    }
    if (reservation.mode === "versioned") {
      const sent = await this._sendReservedOnlineAction(reservation);
      return { ...sent, state: sent.state ?? this.getGameState() };
    }

    const operation = this._beginRoomOperation("skip");
    if (!operation) {
      return { success: false, reason: "ROOM_ACTION_PENDING", state: this.getGameState() };
    }

    let success = false;
    let reason = null;
    try {
      await this.networkManager.sendSkip();
      if (this._pendingRoomOperation !== operation) {
        return { success: false, reason: "STALE_ROOM_OPERATION", state: this.getGameState() };
      }
      success = true;
    } catch (error) {
      this._handleRoomOperationFailure(operation, error);
      success = false;
      reason = "NETWORK_ERROR";
    } finally {
      this._finishRoomOperation(operation);
    }
    return { success, reason, state: this.getGameState() };
  }

  async requestResign() {
    if (!this.multiplayerEnabled) {
      return { success: false, reason: "MULTIPLAYER_RESIGN_REQUIRED", state: this.getGameState() };
    }

    const lockReason = this._getResetLockReason();
    if (lockReason) {
      return {
        success: false,
        reason: lockReason,
        state: this.getGameState(),
      };
    }

    const reservation = this._reserveOnlineAction("player_resign");
    if (reservation.mode === "blocked") {
      return { success: false, reason: reservation.reason, state: this.getGameState() };
    }
    if (reservation.mode === "versioned") {
      const sent = await this._sendReservedOnlineAction(reservation);
      return { ...sent, state: sent.state ?? this.getGameState() };
    }

    const operation = this._beginRoomOperation("resign");
    if (!operation) {
      return { success: false, reason: "ROOM_ACTION_PENDING", state: this.getGameState() };
    }

    let success = false;
    let reason = null;
    try {
      await this.networkManager.sendResign();
      if (this._pendingRoomOperation !== operation) {
        return { success: false, reason: "STALE_ROOM_OPERATION", state: this.getGameState() };
      }
      success = true;
    } catch (error) {
      this._handleRoomOperationFailure(operation, error);
      success = false;
      reason = "NETWORK_ERROR";
    } finally {
      this._finishRoomOperation(operation);
    }
    return { success, reason, state: this.getGameState() };
  }

  async requestResetMatch(options = {}) {
    if (!this.multiplayerEnabled) {
      return { ...this.getGameState(), success: false, reason: "MULTIPLAYER_RESET_REQUIRED" };
    }

    const lockReason = this._getResetLockReason();
    if (lockReason) {
      return this.getGameState();
    }

    const operation = this._beginRoomOperation("reset");
    if (!operation) {
      return this.getGameState();
    }
    const reason = options.reason === "normal_restart" ? "normal_restart" : "resign_restart";

    try {
      // 三人模式下这里会先收到 RESET_STATUS，等全员确认后才会真正收到 MATCH_RESET。
      await this.networkManager.sendReset(reason);
      if (this._pendingRoomOperation !== operation) return this.getGameState();
    } catch (error) {
      this._handleRoomOperationFailure(operation, error);
    } finally {
      this._finishRoomOperation(operation);
    }

    return this.getGameState();
  }

  resetGame(options = {}) {
    if (this._getOnlineActionLockReason() || this._onlineActionLedgerState()?.pending?.length) return this.getGameState();
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
    this._emitActionFeedback({
      type: "resign",
      success: result.success,
      reason: result.reason,
      player: targetPlayer,
      point: null,
    });
    return {
      success: result.success,
      reason: result.reason,
      state: this._buildGameState(result.snapshot),
    };
  }

  getGameState() {
    return this._buildGameState(this.engine.getSnapshot());
  }

  _beginRoomOperation(type) {
    if (this._pendingRoomOperation) return null;
    const operation = {
      type,
      phase: "pending",
      manager: this.networkManager,
      socket: this.networkManager?.socket ?? null,
      engine: this.engine,
      engineEpoch: this._engineEpoch,
    };
    this._pendingRoomOperation = operation;
    const snapshot = this.engine.getSnapshot();
    this._syncSnapshot(snapshot, { scheduleTerritory: false });
    return operation;
  }

  _finishRoomOperation(operation) {
    if (this._pendingRoomOperation !== operation || operation.phase === "uncertain") return false;
    if (operation.manager !== this.networkManager || operation.engine !== this.engine
        || operation.socket !== (this.networkManager?.socket ?? null)
        || operation.engineEpoch !== this._engineEpoch) {
      this._invalidatePendingRoomOperation();
      return false;
    }
    this._pendingRoomOperation = null;
    this._syncSnapshot(this.engine.getSnapshot(), { scheduleTerritory: false });
    return true;
  }

  _handleRoomOperationFailure(operation, error) {
    if (this._pendingRoomOperation !== operation) return;
    if (typeof error?.code === "string" && error.code) {
      this._reportNetworkError(error);
      return;
    }

    // A transport failure or timeout can happen after the server committed the
    // action. Keep input locked until an authoritative snapshot or new room
    // lifecycle invalidates this operation; never describe it as rejected.
    operation.phase = "uncertain";
    operation.error = error;
    this._syncSnapshot(this.engine.getSnapshot(), { scheduleTerritory: false });
    if (error && typeof error === "object") error.code = error.code ?? "ACTION_OUTCOME_UNKNOWN";
    this._reportNetworkError(error);
  }

  _invalidatePendingRoomOperation() {
    if (!this._pendingRoomOperation) return false;
    this._pendingRoomOperation = null;
    if (this.engine && this.renderer) {
      this._syncSnapshot(this.engine.getSnapshot(), { scheduleTerritory: false });
    }
    return true;
  }

  hasPendingRoomOperation() {
    const ledgerState = this._onlineActionLedgerState();
    const protocolBlocked = Boolean(this._onlineActionSync
      && (ledgerState?.protocol?.status === "unknown"
        || (ledgerState?.protocol?.status === "selected" && !ledgerState.scope)
        || ledgerState?.locked));
    return Boolean(this._pendingRoomOperation || ledgerState?.pending?.length || protocolBlocked);
  }

  _removeNetworkListeners() {
    for (const unsubscribe of this._networkUnsubscribers) {
      if (typeof unsubscribe === "function") {
        unsubscribe();
      }
    }
    this._networkUnsubscribers = [];
  }

  _acceptServerAction(payload) {
    const actionIndex = payload?.actionIndex;
    if (!Number.isInteger(actionIndex) || actionIndex < 1) return true;
    if (actionIndex <= (this._lastServerActionIndex ?? 0)) return false;
    this._lastServerActionIndex = actionIndex;
    return true;
  }
}

export default GameController;
