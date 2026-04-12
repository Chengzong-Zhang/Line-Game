import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
} from "https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js";
import GameController from "./GameController.js";
import { Player } from "./GameEngine.js";
import NetworkManager, { ClientEvent, ServerEvent, resolveWebSocketUrl } from "./NetworkManager.js";

function createDefaultGameState() {
  return {
    currentPlayer: Player.BLACK,
    gameOver: false,
    winner: null,
    turnCount: 0,
    consecutiveSkips: 0,
    scores: {
      [Player.BLACK]: 0,
      [Player.WHITE]: 0,
    },
    territories: {
      [Player.BLACK]: { area: 0, polygon: null },
      [Player.WHITE]: { area: 0, polygon: null },
    },
    legalMoves: [],
    snapshot: null,
    multiplayerEnabled: false,
    localPlayer: null,
    roomReady: false,
    opponentConnected: false,
    isLocalTurn: false,
    interactionLocked: false,
    interactionLockReason: null,
    skipLocked: false,
    skipLockReason: null,
    resetLocked: false,
    resetLockReason: null,
  };
}

function createEmptySession() {
  return {
    url: null,
    roomId: null,
    playerId: null,
    color: null,
    connected: false,
  };
}

function formatArea(value) {
  return Number(value ?? 0).toFixed(1);
}

function formatPlayerName(player) {
  if (player === Player.BLACK) {
    return "Black";
  }
  if (player === Player.WHITE) {
    return "White";
  }
  return "Unassigned";
}

function formatWinner(winner) {
  if (winner === Player.BLACK) {
    return "Black Wins";
  }
  if (winner === Player.WHITE) {
    return "White Wins";
  }
  if (winner === "DRAW") {
    return "Draw";
  }
  return "In Progress";
}

const ScorePanel = {
  name: "ScorePanel",
  props: {
    gameState: {
      type: Object,
      required: true,
    },
    session: {
      type: Object,
      required: true,
    },
  },
  setup(props) {
    const currentPlayerLabel = computed(() => formatPlayerName(props.gameState.currentPlayer));
    const localRoleLabel = computed(() => formatPlayerName(props.session.color));
    const winnerLabel = computed(() => formatWinner(props.gameState.winner));

    return {
      Player,
      currentPlayerLabel,
      localRoleLabel,
      winnerLabel,
      formatArea,
    };
  },
  template: `
    <section class="panel panel-score">
      <div class="panel-head">
        <p class="eyebrow">Match State</p>
        <h2>Board Status</h2>
      </div>

      <div class="turn-banner" :class="gameState.currentPlayer === Player.BLACK ? 'is-blue' : 'is-red'">
        <span class="turn-dot"></span>
        <strong>{{ currentPlayerLabel }} Turn</strong>
        <small>{{ winnerLabel }}</small>
      </div>

      <div class="score-grid">
        <article class="score-card score-card-blue">
          <p>Black Territory</p>
          <strong>{{ formatArea(gameState.scores[Player.BLACK]) }}</strong>
          <span>Area</span>
        </article>
        <article class="score-card score-card-red">
          <p>White Territory</p>
          <strong>{{ formatArea(gameState.scores[Player.WHITE]) }}</strong>
          <span>Area</span>
        </article>
      </div>

      <dl class="meta-list">
        <div>
          <dt>Your Side</dt>
          <dd>{{ localRoleLabel }}</dd>
        </div>
        <div>
          <dt>Turn Count</dt>
          <dd>{{ gameState.turnCount }}</dd>
        </div>
        <div>
          <dt>Legal Moves</dt>
          <dd>{{ gameState.legalMoves.length }}</dd>
        </div>
      </dl>
    </section>
  `,
};

const RoomPanel = {
  name: "RoomPanel",
  emits: ["connect", "create-room", "join-room", "leave-room", "update:server-url", "update:room-id"],
  props: {
    serverUrl: {
      type: String,
      required: true,
    },
    roomId: {
      type: String,
      required: true,
    },
    connectionState: {
      type: String,
      required: true,
    },
    roomStatus: {
      type: String,
      required: true,
    },
    session: {
      type: Object,
      required: true,
    },
    networkError: {
      type: String,
      default: "",
    },
    busy: {
      type: Boolean,
      default: false,
    },
  },
  setup(props) {
    const roleLabel = computed(() => formatPlayerName(props.session.color));

    return {
      roleLabel,
    };
  },
  template: `
    <section class="panel panel-network">
      <div class="panel-head">
        <p class="eyebrow">Relay Room</p>
        <h2>Online Match</h2>
      </div>

      <label class="field-label" for="server-url">WebSocket URL</label>
      <input
        id="server-url"
        class="input-field"
        :value="serverUrl"
        :disabled="busy"
        @input="$emit('update:server-url', $event.target.value)"
      />

      <label class="field-label" for="room-id">Room ID</label>
      <input
        id="room-id"
        class="input-field"
        maxlength="4"
        placeholder="Enter 4-digit room"
        :value="roomId"
        :disabled="busy"
        @input="$emit('update:room-id', $event.target.value)"
      />

      <div class="actions actions-stack">
        <button class="action-button action-button-primary" :disabled="busy" @click="$emit('connect')">
          Connect Server
        </button>
        <button class="action-button action-button-secondary" :disabled="busy" @click="$emit('create-room')">
          Create Room
        </button>
        <button class="action-button action-button-secondary" :disabled="busy" @click="$emit('join-room')">
          Join Room
        </button>
        <button class="action-button action-button-ghost" :disabled="busy || !session.roomId" @click="$emit('leave-room')">
          Leave Room
        </button>
      </div>

      <div class="network-meta">
        <div class="status-pill-row">
          <span class="status-pill">{{ connectionState }}</span>
          <span class="status-pill">{{ roomStatus }}</span>
          <span class="status-pill" v-if="session.color">{{ roleLabel }}</span>
        </div>
        <p class="help-copy room-copy">
          Room: <strong>{{ session.roomId || "--" }}</strong><br />
          Player: <strong>{{ session.playerId || "--" }}</strong>
        </p>
      </div>

      <p v-if="networkError" class="error-copy">{{ networkError }}</p>
    </section>
  `,
};

const ControlPanel = {
  name: "ControlPanel",
  emits: ["skip", "reset"],
  props: {
    skipDisabled: {
      type: Boolean,
      default: false,
    },
    resetDisabled: {
      type: Boolean,
      default: false,
    },
    multiplayerEnabled: {
      type: Boolean,
      default: false,
    },
    resetLabel: {
      type: String,
      default: "Reset Board",
    },
    helpText: {
      type: String,
      default: "",
    },
  },
  template: `
    <section class="panel panel-controls">
      <div class="panel-head">
        <p class="eyebrow">Actions</p>
        <h2>Local Controls</h2>
      </div>
      <div class="actions">
        <button class="action-button action-button-primary" :disabled="skipDisabled" @click="$emit('skip')">
          Skip Turn
        </button>
        <button class="action-button action-button-secondary" :disabled="resetDisabled" @click="$emit('reset')">
          {{ resetLabel }}
        </button>
      </div>
      <p class="help-copy">{{ helpText }}</p>
    </section>
  `,
};

const ResultModal = {
  name: "ResultModal",
  emits: ["reset"],
  props: {
    gameState: {
      type: Object,
      required: true,
    },
    allowReset: {
      type: Boolean,
      default: true,
    },
    resetLabel: {
      type: String,
      default: "Start New Solo Match",
    },
  },
  setup(props) {
    const title = computed(() => formatWinner(props.gameState.winner));
    const summary = computed(() => {
      return `Black ${formatArea(props.gameState.scores[Player.BLACK])} vs White ${formatArea(props.gameState.scores[Player.WHITE])}`;
    });

    return {
      title,
      summary,
    };
  },
  template: `
    <transition name="fade">
      <div v-if="gameState.gameOver" class="result-overlay" role="dialog" aria-modal="true">
        <div class="result-card">
          <p class="eyebrow">Game Over</p>
          <h2>{{ title }}</h2>
          <p class="result-summary">{{ summary }}</p>
          <button
            class="action-button action-button-primary"
            :disabled="!allowReset"
            @click="$emit('reset')"
          >
            {{ resetLabel }}
          </button>
        </div>
      </div>
    </transition>
  `,
};

const BoardCanvas = {
  name: "BoardCanvas",
  props: {
    hintText: {
      type: String,
      default: "",
    },
  },
  emits: ["state-change", "controller-ready"],
  setup(props, { emit }) {
    const canvasRef = ref(null);
    let controller = null;

    const handleStateChange = (nextState) => {
      emit("state-change", nextState);
    };

    onMounted(() => {
      controller = new GameController(canvasRef.value, {
        onStateChange: handleStateChange,
      });
      emit("controller-ready", controller);
      controller.init();
    });

    onBeforeUnmount(() => {
      if (controller) {
        controller.destroy();
        controller = null;
      }
    });

    return {
      canvasRef,
      props,
    };
  },
  template: `
    <section class="board-shell panel">
      <div class="panel-head">
        <p class="eyebrow">Canvas Board</p>
        <h2>Triangular Arena</h2>
      </div>
      <div class="canvas-frame">
        <canvas ref="canvasRef" class="game-canvas" aria-label="Triangular board"></canvas>
      </div>
      <p class="board-note">{{ hintText }}</p>
    </section>
  `,
};

const App = {
  name: "TriangularGameOnlineApp",
  components: {
    BoardCanvas,
    ScorePanel,
    RoomPanel,
    ControlPanel,
    ResultModal,
  },
  setup() {
    const controller = ref(null);
    const gameState = ref(createDefaultGameState());
    const networkManager = new NetworkManager();
    const serverUrl = ref(resolveWebSocketUrl());
    const roomIdInput = ref("");
    const session = ref(createEmptySession());
    const connectionState = ref("idle");
    const roomStatus = ref("solo");
    const networkBusy = ref(false);
    const networkError = ref("");
    const unsubscribers = [];

    const syncSession = () => {
      session.value = {
        ...createEmptySession(),
        ...networkManager.getSession(),
      };
    };

    const handleNetworkError = (error) => {
      networkError.value = error?.message ?? String(error);
    };

    const syncControllerState = (partial) => {
      if (!controller.value) {
        return;
      }
      gameState.value = controller.value.setMultiplayerState(partial);
    };

    const enableOnlineController = (payload, ready) => {
      if (!controller.value) {
        return;
      }

      gameState.value = controller.value.enableMultiplayer({
        networkManager,
        localPlayer: payload?.yourColor ?? payload?.color ?? session.value.color,
        roomReady: ready,
        opponentConnected: ready,
      });
    };

    const ensureConnected = async () => {
      if (networkManager.isConnected()) {
        connectionState.value = "connected";
        return;
      }

      connectionState.value = "connecting";
      await networkManager.connect(serverUrl.value.trim());
      connectionState.value = "connected";
      syncSession();
    };

    const handleControllerReady = (instance) => {
      controller.value = instance;
      controller.value.setNetworkErrorListener(handleNetworkError);
      gameState.value = instance.getGameState();
    };

    const handleStateChange = (nextState) => {
      gameState.value = nextState;
    };

    const handleConnect = async () => {
      networkBusy.value = true;
      networkError.value = "";

      try {
        await ensureConnected();
      } catch (error) {
        connectionState.value = "disconnected";
        handleNetworkError(error);
      } finally {
        networkBusy.value = false;
      }
    };

    const handleCreateRoom = async () => {
      networkBusy.value = true;
      networkError.value = "";

      try {
        await ensureConnected();
        const payload = await networkManager.createRoom();
        roomIdInput.value = payload.roomId ?? roomIdInput.value;
        roomStatus.value = "waiting";
        syncSession();

        if (controller.value) {
          controller.value.resetGame({ force: true });
        }
        enableOnlineController(payload, false);
      } catch (error) {
        handleNetworkError(error);
      } finally {
        networkBusy.value = false;
      }
    };

    const handleJoinRoom = async () => {
      const normalizedRoomId = roomIdInput.value.trim();
      if (!normalizedRoomId) {
        handleNetworkError(new Error("Please enter a room ID before joining."));
        return;
      }

      networkBusy.value = true;
      networkError.value = "";

      try {
        await ensureConnected();
        const payload = await networkManager.joinRoom(normalizedRoomId);
        roomStatus.value = payload.status === "READY" ? "ready" : "waiting";
        syncSession();

        if (controller.value) {
          controller.value.resetGame({ force: true });
        }
        enableOnlineController(payload, payload.status === "READY");
      } catch (error) {
        handleNetworkError(error);
      } finally {
        networkBusy.value = false;
      }
    };

    const handleLeaveRoom = async () => {
      networkBusy.value = true;
      networkError.value = "";

      try {
        await networkManager.leaveRoom();
        roomStatus.value = "solo";
        syncSession();
        if (controller.value) {
          controller.value.disableMultiplayer();
          gameState.value = controller.value.resetGame({ force: true });
        }
      } catch (error) {
        handleNetworkError(error);
      } finally {
        networkBusy.value = false;
      }
    };

    const handleSkip = async () => {
      if (!controller.value) {
        return;
      }

      if (roomStatus.value === "solo") {
        const result = controller.value.skipTurn();
        gameState.value = result.state;
        return;
      }

      networkBusy.value = true;
      networkError.value = "";
      try {
        const result = await controller.value.requestSkipTurn();
        gameState.value = result.state;
      } finally {
        networkBusy.value = false;
      }
    };

    const handleReset = async () => {
      if (!controller.value) {
        return;
      }

      if (roomStatus.value === "solo") {
        gameState.value = controller.value.resetGame();
        return;
      }

      networkBusy.value = true;
      networkError.value = "";
      try {
        gameState.value = await controller.value.requestResetMatch({
          reason: gameState.value.gameOver ? "normal_restart" : "resign_restart",
        });
      } finally {
        networkBusy.value = false;
      }
    };

    const statusText = computed(() => {
      if (roomStatus.value === "waiting") {
        return `Room ${session.value.roomId ?? "--"} is ready. Waiting for the second player to join.`;
      }

      if (roomStatus.value === "offline") {
        return "Connection lost. Reconnect to the relay server before sending more moves.";
      }

      if (gameState.value.gameOver) {
        return `${formatWinner(gameState.value.winner)}. Final score: ${formatArea(gameState.value.scores[Player.BLACK])} to ${formatArea(gameState.value.scores[Player.WHITE])}.`;
      }

      if (roomStatus.value === "ready") {
        return gameState.value.isLocalTurn
          ? `Your turn as ${formatPlayerName(session.value.color)}. Click a valid point to play, skip the turn, or resign and restart.`
          : "Opponent turn. Board input stays locked until their move arrives through WebSocket.";
      }

      return gameState.value.currentPlayer === Player.BLACK
        ? "Solo mode: Black to move."
        : "Solo mode: White to move.";
    });

    const boardHint = computed(() => {
      if (roomStatus.value === "waiting") {
        return "The room exists, but the board is locked until both players are present.";
      }

      if (gameState.value.interactionLockReason === "NOT_YOUR_TURN") {
        return "Opponent turn. Their incoming move will be applied to your local engine automatically.";
      }

      if (gameState.value.interactionLockReason === "NETWORK_UNAVAILABLE") {
        return "Network unavailable. Reconnect before trying to continue the online match.";
      }

      if (gameState.value.interactionLockReason === "OPPONENT_OFFLINE") {
        return "Opponent disconnected. Input is locked until the room becomes ready again.";
      }

      if (gameState.value.multiplayerEnabled) {
        return "Skip is synchronized for both players. Restarting an unfinished online match counts as a resignation for the player who clicked it.";
      }

      return "Solo mode is still available. Click a vertex to place a node.";
    });

    const skipDisabled = computed(() => {
      if (!controller.value || networkBusy.value) {
        return true;
      }

      if (roomStatus.value === "solo") {
        return gameState.value.gameOver;
      }

      return gameState.value.skipLocked;
    });

    const resetDisabled = computed(() => {
      if (!controller.value || networkBusy.value) {
        return true;
      }

      if (roomStatus.value === "solo") {
        return false;
      }

      return gameState.value.resetLocked;
    });

    const resetLabel = computed(() => {
      if (roomStatus.value === "solo") {
        return gameState.value.gameOver ? "Start New Solo Match" : "Reset Board";
      }

      return gameState.value.gameOver ? "Start Next Online Match" : "Resign And Restart";
    });

    const controlsHelpText = computed(() => {
      if (roomStatus.value === "solo") {
        return "In solo mode you can click the board, skip a turn, or reset the match at any time.";
      }

      if (gameState.value.gameOver) {
        return "This online round is over. Starting the next round keeps the same room and player colors.";
      }

      return "Either side can skip on their own turn. If one side has no legal moves, the engine auto-skips that turn. Restarting mid-match is treated as a resignation.";
    });

    const resultResetAllowed = computed(() => {
      return !resetDisabled.value;
    });

    unsubscribers.push(
      networkManager.on(ClientEvent.OPEN, () => {
        connectionState.value = "connected";
        syncSession();
      }),
    );

    unsubscribers.push(
      networkManager.on(ClientEvent.CLOSE, () => {
        connectionState.value = "disconnected";
        syncSession();
        if (roomStatus.value !== "solo") {
          roomStatus.value = "offline";
          syncControllerState({
            enabled: true,
            networkManager,
            roomReady: false,
            opponentConnected: false,
          });
        }
      }),
    );

    unsubscribers.push(
      networkManager.on(ClientEvent.CONNECTION_ERROR, () => {
        connectionState.value = "error";
      }),
    );

    unsubscribers.push(
      networkManager.on(ServerEvent.ROOM_CREATED, (payload) => {
        roomStatus.value = "waiting";
        roomIdInput.value = payload.roomId ?? roomIdInput.value;
        syncSession();
        enableOnlineController(payload, false);
      }),
    );

    unsubscribers.push(
      networkManager.on(ServerEvent.ROOM_JOINED, (payload) => {
        const ready = payload.status === "READY";
        roomStatus.value = ready ? "ready" : "waiting";
        roomIdInput.value = payload.roomId ?? roomIdInput.value;
        syncSession();
        enableOnlineController(payload, ready);
      }),
    );

    unsubscribers.push(
      networkManager.on(ServerEvent.ROOM_READY, (payload) => {
        roomStatus.value = "ready";
        syncSession();
        enableOnlineController(payload, true);
      }),
    );

    unsubscribers.push(
      networkManager.on(ServerEvent.PLAYER_LEFT, () => {
        roomStatus.value = "waiting";
        networkError.value = "Opponent left the room. Waiting for a new player or reconnect.";
        syncControllerState({
          enabled: true,
          networkManager,
          roomReady: false,
          opponentConnected: false,
        });
      }),
    );

    unsubscribers.push(
      networkManager.on(ServerEvent.MATCH_RESET, () => {
        networkError.value = "";
        roomStatus.value = "ready";
      }),
    );

    unsubscribers.push(
      networkManager.on(ServerEvent.ERROR, (payload) => {
        handleNetworkError(new Error(payload.message ?? payload.code ?? "Unknown relay server error."));
      }),
    );

    onBeforeUnmount(() => {
      for (const unsubscribe of unsubscribers) {
        if (typeof unsubscribe === "function") {
          unsubscribe();
        }
      }
      networkManager.disconnect();
    });

    return {
      controller,
      gameState,
      serverUrl,
      roomIdInput,
      session,
      connectionState,
      roomStatus,
      networkBusy,
      networkError,
      statusText,
      boardHint,
      skipDisabled,
      resetDisabled,
      resetLabel,
      controlsHelpText,
      resultResetAllowed,
      handleControllerReady,
      handleStateChange,
      handleConnect,
      handleCreateRoom,
      handleJoinRoom,
      handleLeaveRoom,
      handleSkip,
      handleReset,
    };
  },
  template: `
    <main class="app-shell">
      <section class="hero">
        <div>
          <p class="eyebrow">Vue 3 + Canvas + WebSocket</p>
          <h1>TriAxis Web Arena</h1>
          <p class="hero-copy">
            Local rules still run inside the browser. The FastAPI relay server only coordinates rooms and forwards moves.
          </p>
        </div>
        <div class="hero-status">
          <p class="status-label">Match Feed</p>
          <p class="status-copy">{{ statusText }}</p>
        </div>
      </section>

      <section class="layout-grid">
        <BoardCanvas
          :hint-text="boardHint"
          @controller-ready="handleControllerReady"
          @state-change="handleStateChange"
        />

        <aside class="sidebar">
          <RoomPanel
            :server-url="serverUrl"
            :room-id="roomIdInput"
            :connection-state="connectionState"
            :room-status="roomStatus"
            :session="session"
            :network-error="networkError"
            :busy="networkBusy"
            @update:server-url="serverUrl = $event"
            @update:room-id="roomIdInput = $event"
            @connect="handleConnect"
            @create-room="handleCreateRoom"
            @join-room="handleJoinRoom"
            @leave-room="handleLeaveRoom"
          />

          <ScorePanel :game-state="gameState" :session="session" />

          <ControlPanel
            :skip-disabled="skipDisabled"
            :reset-disabled="resetDisabled"
            :multiplayer-enabled="roomStatus !== 'solo'"
            :reset-label="resetLabel"
            :help-text="controlsHelpText"
            @skip="handleSkip"
            @reset="handleReset"
          />
        </aside>
      </section>

      <ResultModal
        :game-state="gameState"
        :allow-reset="resultResetAllowed"
        :reset-label="resetLabel"
        @reset="handleReset"
      />
    </main>
  `,
};

export default App;
