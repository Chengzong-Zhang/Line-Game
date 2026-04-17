import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js";
import GameController from "./GameController.js";
import { Player } from "./GameEngine.js";
import NetworkManager, { ClientEvent, ServerEvent, resolveWebSocketUrl } from "./NetworkManager.js";

const LANGUAGE_STORAGE_KEY = "triaxis-language";

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
  return String(Math.round(Number(value ?? 0)));
}

function getInitialLanguage() {
  const stored = globalThis.localStorage?.getItem(LANGUAGE_STORAGE_KEY);
  return stored === "en" ? "en" : "zh";
}

function getTexts(language) {
  if (language === "en") {
    return {
      pageTitle: "TriAxis Web Arena",
      languageLabel: "Language",
      heroTitle: "TriAxis Web Arena",
      heroCopy: "Rules still run in the browser. The FastAPI relay server only creates rooms and forwards match actions.",
      statusLabel: "Match Feed",
      boardTitle: "Triangular Board",
      boardEyebrow: "Canvas Board",
      boardAriaLabel: "TriAxis triangular board",
      localControls: "Local Controls",
      controlsEyebrow: "Local Controls",
      boardStatus: "Board Status",
      boardStatusEyebrow: "Match State",
      onlineMatch: "Online Match",
      onlineEyebrow: "Relay Room",
      connectServer: "Connect Server",
      createRoom: "Create Room",
      joinRoom: "Join Room",
      leaveRoom: "Leave Room",
      serverAddress: "Server Address",
      roomId: "Room ID",
      roomPlaceholder: "Enter 4-digit room ID",
      roomLabel: "Room",
      playerLabel: "Player",
      yourSide: "Your Side",
      turnCount: "Turn Count",
      legalMoves: "Legal Moves",
      blueTerritory: "Blue Territory",
      redTerritory: "Red Territory",
      area: "Area",
      turnSuffix: "Turn",
      gameOver: "Game Over",
      whatIsConnect: "What does “Connect Server” do?",
      connectExplanation: "It connects to the WebSocket address above so you can create rooms, join rooms, and sync moves. This stays as a separate button because solo play does not need the network, and you may want to edit the local or cloud server address before opening the connection.",
      soloHelp: "In solo mode you can click the board, skip a turn, or reset the match at any time.",
      onlineOverHelp: "This online round is over. Starting the next round keeps the same room and both sides.",
      onlinePlayHelp: "Either side can skip on its own turn. If one side has no legal moves, the engine auto-skips that turn. Restarting mid-match is treated as a resignation.",
      startNewSolo: "Start New Solo Match",
      resetBoard: "Reset Board",
      startNextOnline: "Start Next Online Match",
      resignAndRestart: "Resign And Restart",
      idle: "Idle",
      connecting: "Connecting",
      connected: "Connected",
      reconnecting: "Reconnecting",
      disconnected: "Disconnected",
      error: "Connection Error",
      solo: "Solo Mode",
      waiting: "Waiting",
      ready: "Room Ready",
      offline: "Room Offline",
      inProgress: "In Progress",
      draw: "Draw",
      unassigned: "Unassigned",
      waitingStatus: (roomId) => `Room ${roomId ?? "--"} is ready and waiting for the second player.`,
      offlineStatus: "Connection was lost. Reconnect to the relay server before continuing the online match.",
      finalStatus: (winner, blueScore, redScore) => `${winner}. Final score: Blue ${blueScore}, Red ${redScore}.`,
      localTurnStatus: (side) => `It is your turn as ${side}. Click a legal point to play, skip the turn, or resign and restart.`,
      remoteTurnStatus: "It is the opponent's turn. The board stays locked until their move arrives through WebSocket.",
      soloBlueStatus: "Solo mode: Blue to move.",
      soloRedStatus: "Solo mode: Red to move.",
      waitingHint: "The room exists, but the board stays locked until both players are present.",
      notYourTurnHint: "It is the opponent's turn. Their move will be applied to your local board automatically.",
      networkUnavailableHint: "Network unavailable. Reconnect before continuing the online match.",
      opponentOfflineHint: "The opponent disconnected, so the board stays locked until the room is ready again.",
      multiplayerHint: "Skipping is synchronized for both players. Restarting an unfinished online match counts as a resignation by the player who clicked restart.",
      soloHint: "Solo mode is still available. Click a board vertex to place a node.",
      joinRoomRequired: "Please enter a 4-digit room ID before joining.",
      invalidWebSocket: "Please enter a valid WebSocket address.",
      connectFailed: (url) => `Failed to connect to ${url}. Make sure the local server is running.`,
      socketClosed: "The WebSocket connection was closed. Reconnect to the server and try again.",
      websocketNotConnected: "The WebSocket is not connected yet. Click Connect Server first.",
      websocketSendBlocked: "The connection is not open yet, so the message cannot be sent.",
      timeout: "Timed out while waiting for the server response. Please try again.",
      invalidJson: "The server returned invalid JSON data.",
      invalidPayload: "The server returned an unsupported payload.",
      roomNotFound: (roomId) => `Room ${roomId} does not exist. Check the room ID and try again.`,
      roomFull: (roomId) => `Room ${roomId} is full.`,
      playerAlreadyConnected: "This player session is already connected elsewhere.",
      opponentLeft: "The opponent left the room. Waiting for a new player or a reconnect.",
      unknownServer: "The server returned an unknown error.",
      continueMatch: "Continue Match",
      resignedSummary: (winner, loser) => `${winner}. ${loser} resigned and the board has been reset.`,
    };
  }

  return {
    pageTitle: "TriAxis 网页版",
    languageLabel: "语言",
    heroTitle: "TriAxis 网页版",
    heroCopy: "规则运算仍在浏览器中完成，FastAPI 中继服务只负责创建房间并转发对局操作。",
    statusLabel: "对局播报",
    boardTitle: "三角棋盘",
    boardEyebrow: "Canvas 棋盘",
    boardAriaLabel: "TriAxis 三角棋盘",
    localControls: "本地操作",
    controlsEyebrow: "本地操作",
    boardStatus: "棋盘状态",
    boardStatusEyebrow: "对局状态",
    onlineMatch: "在线对局",
    onlineEyebrow: "联机房间",
    connectServer: "连接服务器",
    createRoom: "创建房间",
    joinRoom: "加入房间",
    leaveRoom: "离开房间",
    serverAddress: "服务器地址",
    roomId: "房间号",
    roomPlaceholder: "输入 4 位房间号",
    roomLabel: "房间",
    playerLabel: "玩家",
    yourSide: "你的阵营",
    turnCount: "回合数",
    legalMoves: "合法落点",
    blueTerritory: "蓝方领地",
    redTerritory: "红方领地",
    area: "面积",
    turnSuffix: "回合",
    gameOver: "对局结束",
    whatIsConnect: "什么是“连接服务器”？",
    connectExplanation: "它会连接你上面填写的 WebSocket 地址，用来创建房间、加入房间和同步双方落子。之所以单独放一个按钮，是因为本地单机模式不需要联网，而且你可能想先改成本地或云端地址，再决定何时连接。",
    soloHelp: "本地模式下，你可以随时点击棋盘、跳过回合，或者直接重开棋局。",
    onlineOverHelp: "这一局在线对战已经结束。开始下一局时会保留当前房间和双方阵营。",
    onlinePlayHelp: "双方都可以在自己的回合跳过。若一方没有合法落点，引擎会自动跳过。在线中途重开会被视为当前玩家认输。",
    startNewSolo: "开始新的本地对局",
    resetBoard: "重置棋盘",
    startNextOnline: "开始下一局在线对战",
    resignAndRestart: "认输并重开",
    idle: "未连接",
    connecting: "连接中",
    connected: "已连接",
    reconnecting: "重连中",
    disconnected: "已断开",
    error: "连接异常",
    solo: "本地模式",
    waiting: "等待对手",
    ready: "房间已就绪",
    offline: "房间离线",
    inProgress: "对局进行中",
    draw: "平局",
    unassigned: "未分配",
    waitingStatus: (roomId) => `房间 ${roomId ?? "--"} 已创建，等待第二位玩家加入。`,
    offlineStatus: "连接已断开，继续在线对局前请先重新连接服务器。",
    finalStatus: (winner, blueScore, redScore) => `${winner}。最终比分：蓝方 ${blueScore}，红方 ${redScore}。`,
    localTurnStatus: (side) => `现在轮到你操作，你是${side}。点击合法落点即可下子，也可以选择跳过回合或认输重开。`,
    remoteTurnStatus: "现在是对手回合，棋盘会暂时锁定，等对方通过 WebSocket 传来操作。",
    soloBlueStatus: "本地模式中，现在轮到蓝方。",
    soloRedStatus: "本地模式中，现在轮到红方。",
    waitingHint: "房间已经存在，但双方都进入前，棋盘会保持锁定。",
    notYourTurnHint: "现在是对手回合。对方的操作会自动同步到你本地的棋盘。",
    networkUnavailableHint: "网络不可用，请先重新连接，再继续在线对局。",
    opponentOfflineHint: "对手已断开连接，房间重新就绪前棋盘会保持锁定。",
    multiplayerHint: "跳过回合同步给双方。在线对局未结束时点击重开，会按当前玩家认输并立即重置对局。",
    soloHint: "你也可以继续本地单机模式，直接点击棋盘顶点落子。",
    joinRoomRequired: "加入房间前请先输入 4 位房间号。",
    invalidWebSocket: "请输入有效的 WebSocket 地址。",
    connectFailed: (url) => `无法连接到 ${url}。请确认本地服务是否已启动。`,
    socketClosed: "WebSocket 连接已关闭，请重新连接服务器。",
    websocketNotConnected: "WebSocket 尚未连接，请先点击“连接服务器”。",
    websocketSendBlocked: "连接尚未建立完成，暂时无法发送消息。",
    timeout: "等待服务器响应超时，请稍后重试。",
    invalidJson: "服务器返回了无效的 JSON 数据。",
    invalidPayload: "服务器返回了无法识别的数据。",
    roomNotFound: (roomId) => `房间 ${roomId} 不存在。请检查房间号是否正确。`,
    roomFull: (roomId) => `房间 ${roomId} 已满。`,
    playerAlreadyConnected: "这个玩家会话已经在别处连接。",
    opponentLeft: "对手已离开房间，正在等待新玩家加入或重新连接。",
    unknownServer: "服务器返回了未知错误。",
    continueMatch: "继续对局",
    resignedSummary: (winner, loser) => `${winner}，${loser}认输，棋盘已重置。`,
  };
}

function formatPlayerName(player, language = "zh") {
  const texts = getTexts(language);
  if (player === Player.BLACK) {
    return language === "en" ? "Blue" : "蓝方";
  }
  if (player === Player.WHITE) {
    return language === "en" ? "Red" : "红方";
  }
  return texts.unassigned;
}

function formatWinner(winner, language = "zh") {
  const texts = getTexts(language);
  if (winner === Player.BLACK) {
    return language === "en" ? "Blue Wins" : "蓝方获胜";
  }
  if (winner === Player.WHITE) {
    return language === "en" ? "Red Wins" : "红方获胜";
  }
  if (winner === "DRAW") {
    return texts.draw;
  }
  return texts.inProgress;
}

function formatConnectionState(state, language = "zh") {
  const texts = getTexts(language);
  return texts[state] ?? state;
}

function localizeErrorMessage(message, language = "zh") {
  const texts = getTexts(language);
  if (!message) {
    return texts.unknownServer;
  }
  if (message === "Please enter a room ID before joining.") {
    return texts.joinRoomRequired;
  }
  if (message === "connect(url) requires a valid WebSocket URL.") {
    return texts.invalidWebSocket;
  }
  if (message.startsWith("Failed to connect to ")) {
    return texts.connectFailed(message.slice("Failed to connect to ".length));
  }
  if (message.startsWith("WebSocket closed:")) {
    return texts.socketClosed;
  }
  if (message === "WebSocket is not connected. Call connect(url) first.") {
    return texts.websocketNotConnected;
  }
  if (message === "Cannot send WebSocket message before the connection is open.") {
    return texts.websocketSendBlocked;
  }
  if (message.startsWith("Timed out waiting for ")) {
    return texts.timeout;
  }
  if (message === "Received invalid JSON from server.") {
    return texts.invalidJson;
  }
  if (message === "Received an unsupported payload from server.") {
    return texts.invalidPayload;
  }
  if (message.startsWith("Room ") && message.endsWith(" does not exist.")) {
    return texts.roomNotFound(message.slice(5, 9));
  }
  if (message.startsWith("Room ") && message.endsWith(" is full.")) {
    return texts.roomFull(message.slice(5, 9));
  }
  if (message === "This player session is already connected.") {
    return texts.playerAlreadyConnected;
  }
  return message;
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
    language: {
      type: String,
      required: true,
    },
  },
  setup(props) {
    const texts = computed(() => getTexts(props.language));
    const currentPlayerLabel = computed(() => formatPlayerName(props.gameState.currentPlayer, props.language));
    const localRoleLabel = computed(() => formatPlayerName(props.session.color, props.language));
    const winnerLabel = computed(() => formatWinner(props.gameState.winner, props.language));

    return {
      Player,
      texts,
      currentPlayerLabel,
      localRoleLabel,
      winnerLabel,
      formatArea,
    };
  },
  template: `
    <section class="panel panel-score">
      <div class="panel-head">
        <p class="eyebrow">{{ texts.boardStatusEyebrow }}</p>
        <h2>{{ texts.boardStatus }}</h2>
      </div>

      <div class="turn-banner" :class="gameState.currentPlayer === Player.BLACK ? 'is-blue' : 'is-red'">
        <span class="turn-dot"></span>
        <strong>{{ currentPlayerLabel }} {{ texts.turnSuffix }}</strong>
        <small>{{ winnerLabel }}</small>
      </div>

      <div class="score-grid">
        <article class="score-card score-card-blue">
          <p>{{ texts.blueTerritory }}</p>
          <strong>{{ formatArea(gameState.scores[Player.BLACK]) }}</strong>
          <span>{{ texts.area }}</span>
        </article>
        <article class="score-card score-card-red">
          <p>{{ texts.redTerritory }}</p>
          <strong>{{ formatArea(gameState.scores[Player.WHITE]) }}</strong>
          <span>{{ texts.area }}</span>
        </article>
      </div>

      <dl class="meta-list">
        <div>
          <dt>{{ texts.yourSide }}</dt>
          <dd>{{ localRoleLabel }}</dd>
        </div>
        <div>
          <dt>{{ texts.turnCount }}</dt>
          <dd>{{ gameState.turnCount }}</dd>
        </div>
        <div>
          <dt>{{ texts.legalMoves }}</dt>
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
    language: {
      type: String,
      required: true,
    },
  },
  setup(props) {
    const texts = computed(() => getTexts(props.language));
    const roleLabel = computed(() => formatPlayerName(props.session.color, props.language));
    const connectionLabel = computed(() => formatConnectionState(props.connectionState, props.language));
    const roomStatusLabel = computed(() => formatConnectionState(props.roomStatus, props.language));

    return {
      texts,
      roleLabel,
      connectionLabel,
      roomStatusLabel,
    };
  },
  template: `
    <section class="panel panel-network">
      <div class="panel-head">
        <p class="eyebrow">{{ texts.onlineEyebrow }}</p>
        <h2>{{ texts.onlineMatch }}</h2>
      </div>

      <label class="field-label" for="server-url">{{ texts.serverAddress }}</label>
      <input
        id="server-url"
        class="input-field"
        :value="serverUrl"
        :disabled="busy"
        @input="$emit('update:server-url', $event.target.value)"
      />

      <label class="field-label" for="room-id">{{ texts.roomId }}</label>
      <input
        id="room-id"
        class="input-field"
        maxlength="4"
        :placeholder="texts.roomPlaceholder"
        :value="roomId"
        :disabled="busy"
        @input="$emit('update:room-id', $event.target.value)"
      />

      <div class="actions actions-stack">
        <button class="action-button action-button-primary" :disabled="busy" @click="$emit('connect')">
          {{ texts.connectServer }}
        </button>
        <button class="action-button action-button-secondary" :disabled="busy" @click="$emit('create-room')">
          {{ texts.createRoom }}
        </button>
        <button class="action-button action-button-secondary" :disabled="busy" @click="$emit('join-room')">
          {{ texts.joinRoom }}
        </button>
        <button class="action-button action-button-ghost" :disabled="busy || !session.roomId" @click="$emit('leave-room')">
          {{ texts.leaveRoom }}
        </button>
      </div>

      <div class="network-meta">
        <div class="status-pill-row">
          <span class="status-pill">{{ connectionLabel }}</span>
          <span class="status-pill">{{ roomStatusLabel }}</span>
          <span class="status-pill" v-if="session.color">{{ roleLabel }}</span>
        </div>
        <p class="help-copy room-copy">
          {{ texts.roomLabel }}: <strong>{{ session.roomId || "--" }}</strong><br />
          {{ texts.playerLabel }}: <strong>{{ session.playerId || "--" }}</strong>
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
    resetLabel: {
      type: String,
      default: "",
    },
    helpText: {
      type: String,
      default: "",
    },
    language: {
      type: String,
      required: true,
    },
  },
  setup(props) {
    const texts = computed(() => getTexts(props.language));
    return { texts };
  },
  template: `
    <section class="panel panel-controls">
      <div class="panel-head">
        <p class="eyebrow">{{ texts.controlsEyebrow }}</p>
        <h2>{{ texts.localControls }}</h2>
      </div>
      <div class="actions">
        <button class="action-button action-button-primary" :disabled="skipDisabled" @click="$emit('skip')">
          {{ language === 'en' ? 'Skip Turn' : '跳过回合' }}
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
  emits: ["action"],
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
      default: "",
    },
    language: {
      type: String,
      required: true,
    },
    overlayResult: {
      type: Object,
      default: null,
    },
  },
  setup(props) {
    const texts = computed(() => getTexts(props.language));
    const title = computed(() => {
      if (props.overlayResult) {
        return formatWinner(props.overlayResult.winner, props.language);
      }
      return formatWinner(props.gameState.winner, props.language);
    });
    const summary = computed(() => {
      if (props.overlayResult) {
        return texts.value.resignedSummary(
          formatPlayerName(props.overlayResult.winner, props.language),
          formatPlayerName(props.overlayResult.loser, props.language),
        );
      }

      const blueScore = formatArea(props.gameState.scores[Player.BLACK]);
      const redScore = formatArea(props.gameState.scores[Player.WHITE]);
      return props.language === "en"
        ? `Blue ${blueScore} vs Red ${redScore}`
        : `蓝方 ${blueScore} 对 红方 ${redScore}`;
    });

    const actionLabel = computed(() => {
      if (props.overlayResult) {
        return texts.value.continueMatch;
      }
      return props.resetLabel;
    });

    return {
      actionLabel,
      texts,
      title,
      summary,
    };
  },
  template: `
    <transition name="fade">
      <div v-if="overlayResult || gameState.gameOver" class="result-overlay" role="dialog" aria-modal="true">
        <div class="result-card">
          <p class="eyebrow">{{ texts.gameOver }}</p>
          <h2>{{ title }}</h2>
          <p class="result-summary">{{ summary }}</p>
          <button
            class="action-button action-button-primary"
            :disabled="overlayResult ? false : !allowReset"
            @click="$emit('action')"
          >
            {{ actionLabel }}
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
    language: {
      type: String,
      required: true,
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
      texts: computed(() => getTexts(props.language)),
    };
  },
  template: `
    <section class="board-shell panel">
      <div class="panel-head">
        <p class="eyebrow">{{ texts.boardEyebrow }}</p>
        <h2>{{ texts.boardTitle }}</h2>
      </div>
      <div class="canvas-frame">
        <canvas ref="canvasRef" class="game-canvas" :aria-label="texts.boardAriaLabel"></canvas>
      </div>
      <p class="board-note">{{ hintText }}</p>
    </section>
  `,
};

const LanguageSwitcher = {
  name: "LanguageSwitcher",
  emits: ["update:language"],
  props: {
    language: {
      type: String,
      required: true,
    },
  },
  setup(props) {
    return {
      texts: computed(() => getTexts(props.language)),
    };
  },
  template: `
    <div class="language-switcher" role="group" :aria-label="texts.languageLabel">
      <span class="language-label">{{ texts.languageLabel }}</span>
      <button class="language-button" :class="{ 'is-active': language === 'zh' }" @click="$emit('update:language', 'zh')">
        中文
      </button>
      <button class="language-button" :class="{ 'is-active': language === 'en' }" @click="$emit('update:language', 'en')">
        English
      </button>
    </div>
  `,
};

const App = {
  name: "TriangularGameOnlineApp",
  components: {
    BoardCanvas,
    ControlPanel,
    LanguageSwitcher,
    ResultModal,
    RoomPanel,
    ScorePanel,
  },
  setup() {
    const controller = ref(null);
    const gameState = ref(createDefaultGameState());
    const language = ref(getInitialLanguage());
    const networkManager = new NetworkManager();
    const serverUrl = ref(resolveWebSocketUrl());
    const roomIdInput = ref("");
    const session = ref(createEmptySession());
    const connectionState = ref("idle");
    const roomStatus = ref("solo");
    const networkBusy = ref(false);
    const networkError = ref("");
    const overlayResult = ref(null);
    const unsubscribers = [];
    let reconnectTimerId = null;
    let reconnectAttempt = 0;

    watch(language, (value) => {
      globalThis.localStorage?.setItem(LANGUAGE_STORAGE_KEY, value);
      document.documentElement.lang = value === "en" ? "en" : "zh-CN";
      document.title = getTexts(value).pageTitle;
    }, { immediate: true });

    const syncSession = () => {
      session.value = {
        ...createEmptySession(),
        ...networkManager.getSession(),
      };
    };

    const clearReconnectTimer = () => {
      if (reconnectTimerId !== null) {
        globalThis.clearTimeout(reconnectTimerId);
        reconnectTimerId = null;
      }
    };

    const handleNetworkError = (error) => {
      networkError.value = localizeErrorMessage(error?.message ?? String(error), language.value);
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

    const attemptReconnect = async () => {
      if (roomStatus.value === "solo") {
        return;
      }

      clearReconnectTimer();
      connectionState.value = "reconnecting";

      try {
        await ensureConnected();
        syncSession();

        if (!session.value.roomId) {
          reconnectAttempt = 0;
          return;
        }

        const payload = await networkManager.joinRoom(session.value.roomId, session.value.playerId);
        roomStatus.value = payload.status === "READY" ? "ready" : "waiting";
        syncSession();
        enableOnlineController(payload, payload.status === "READY");
        networkError.value = "";
        reconnectAttempt = 0;
      } catch (error) {
        handleNetworkError(error);
        reconnectAttempt += 1;
        const delay = Math.min(8000, 1000 * reconnectAttempt);
        reconnectTimerId = globalThis.setTimeout(() => {
          void attemptReconnect();
        }, delay);
      }
    };

    const scheduleReconnect = () => {
      if (roomStatus.value === "solo") {
        return;
      }

      clearReconnectTimer();
      reconnectTimerId = globalThis.setTimeout(() => {
        void attemptReconnect();
      }, 1200);
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
      overlayResult.value = null;
      clearReconnectTimer();

      try {
        await ensureConnected();
        reconnectAttempt = 0;
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
      overlayResult.value = null;
      clearReconnectTimer();

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
      overlayResult.value = null;
      clearReconnectTimer();

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
      overlayResult.value = null;
      clearReconnectTimer();

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
      const texts = getTexts(language.value);
      if (roomStatus.value === "waiting") {
        return texts.waitingStatus(session.value.roomId);
      }

      if (roomStatus.value === "offline") {
        return texts.offlineStatus;
      }

      if (gameState.value.gameOver) {
        return texts.finalStatus(
          formatWinner(gameState.value.winner, language.value),
          formatArea(gameState.value.scores[Player.BLACK]),
          formatArea(gameState.value.scores[Player.WHITE]),
        );
      }

      if (roomStatus.value === "ready") {
        return gameState.value.isLocalTurn
          ? texts.localTurnStatus(formatPlayerName(session.value.color, language.value))
          : texts.remoteTurnStatus;
      }

      return gameState.value.currentPlayer === Player.BLACK
        ? texts.soloBlueStatus
        : texts.soloRedStatus;
    });

    const boardHint = computed(() => {
      const texts = getTexts(language.value);
      if (roomStatus.value === "waiting") {
        return texts.waitingHint;
      }

      if (gameState.value.interactionLockReason === "NOT_YOUR_TURN") {
        return texts.notYourTurnHint;
      }

      if (gameState.value.interactionLockReason === "NETWORK_UNAVAILABLE") {
        return texts.networkUnavailableHint;
      }

      if (gameState.value.interactionLockReason === "OPPONENT_OFFLINE") {
        return texts.opponentOfflineHint;
      }

      if (gameState.value.multiplayerEnabled) {
        return texts.multiplayerHint;
      }

      return texts.soloHint;
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
      const texts = getTexts(language.value);
      if (roomStatus.value === "solo") {
        return gameState.value.gameOver ? texts.startNewSolo : texts.resetBoard;
      }

      return gameState.value.gameOver ? texts.startNextOnline : texts.resignAndRestart;
    });

    const controlsHelpText = computed(() => {
      const texts = getTexts(language.value);
      if (roomStatus.value === "solo") {
        return texts.soloHelp;
      }

      if (gameState.value.gameOver) {
        return texts.onlineOverHelp;
      }

      return texts.onlinePlayHelp;
    });

    const resultResetAllowed = computed(() => {
      return !resetDisabled.value;
    });

    const handleResultAction = async () => {
      if (overlayResult.value) {
        overlayResult.value = null;
        return;
      }

      await handleReset();
    };

    unsubscribers.push(
      networkManager.on(ClientEvent.OPEN, () => {
        connectionState.value = "connected";
        clearReconnectTimer();
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
          scheduleReconnect();
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
        reconnectAttempt = 0;
      }),
    );

    unsubscribers.push(
      networkManager.on(ServerEvent.ROOM_JOINED, (payload) => {
        const ready = payload.status === "READY";
        roomStatus.value = ready ? "ready" : "waiting";
        roomIdInput.value = payload.roomId ?? roomIdInput.value;
        syncSession();
        enableOnlineController(payload, ready);
        reconnectAttempt = 0;
      }),
    );

    unsubscribers.push(
      networkManager.on(ServerEvent.ROOM_READY, (payload) => {
        roomStatus.value = "ready";
        syncSession();
        enableOnlineController(payload, true);
        reconnectAttempt = 0;
      }),
    );

    unsubscribers.push(
      networkManager.on(ServerEvent.PLAYER_LEFT, () => {
        roomStatus.value = "waiting";
        networkError.value = getTexts(language.value).opponentLeft;
        syncControllerState({
          enabled: true,
          networkManager,
          roomReady: false,
          opponentConnected: false,
        });
      }),
    );

    unsubscribers.push(
      networkManager.on(ServerEvent.MATCH_RESET, (payload) => {
        networkError.value = "";
        roomStatus.value = "ready";
        if (payload.reason === "resign_restart" && payload.winnerColor && payload.color) {
          overlayResult.value = {
            winner: payload.winnerColor,
            loser: payload.color,
          };
        }
      }),
    );

    unsubscribers.push(
      networkManager.on(ServerEvent.ERROR, (payload) => {
        handleNetworkError(new Error(payload.message ?? payload.code ?? getTexts(language.value).unknownServer));
      }),
    );

    onBeforeUnmount(() => {
      clearReconnectTimer();
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
      getTexts,
      language,
      serverUrl,
      roomIdInput,
      session,
      connectionState,
      roomStatus,
      networkBusy,
      networkError,
      overlayResult,
      statusText,
      boardHint,
      skipDisabled,
      resetDisabled,
      resetLabel,
      controlsHelpText,
      resultResetAllowed,
      handleResultAction,
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
          <LanguageSwitcher :language="language" @update:language="language = $event" />
          <p class="eyebrow">Vue 3 + Canvas + WebSocket</p>
          <h1>{{ getTexts(language).heroTitle }}</h1>
          <p class="hero-copy">
            {{ getTexts(language).heroCopy }}
          </p>
        </div>
      </section>

      <section class="layout-grid">
        <BoardCanvas
          :language="language"
          :hint-text="boardHint"
          @controller-ready="handleControllerReady"
          @state-change="handleStateChange"
        />

        <aside class="sidebar">
          <ControlPanel
            :language="language"
            :skip-disabled="skipDisabled"
            :reset-disabled="resetDisabled"
            :reset-label="resetLabel"
            :help-text="controlsHelpText"
            @skip="handleSkip"
            @reset="handleReset"
          />

          <ScorePanel :game-state="gameState" :session="session" :language="language" />

          <RoomPanel
            :language="language"
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
        </aside>
      </section>

      <ResultModal
        :language="language"
        :game-state="gameState"
        :allow-reset="resultResetAllowed"
        :overlay-result="overlayResult"
        :reset-label="resetLabel"
        @action="handleResultAction"
      />
    </main>
  `,
};

export default App;
