import GameController from "./GameController.js?v=20260421a";
import { Player } from "./GameEngine.js?v=20260421a";
import NetworkManager, { ClientEvent, ServerEvent, resolveWebSocketUrl } from "./NetworkManager.js?v=20260421a";
import {
  createEmptyAuth as createAppEmptyAuth,
  GRID_SIZE_OPTIONS as APP_GRID_SIZE_OPTIONS,
  PLAYER_COUNT_OPTIONS as APP_PLAYER_COUNT_OPTIONS,
  createDefaultGameState as createAppDefaultGameState,
  createEmptySession as createAppEmptySession,
  loadStoredAuth as loadAppStoredAuth,
  loadStoredSession as loadAppStoredSession,
  normalizeGameSettings as normalizeAppGameSettings,
  persistAuth as persistAppAuth,
  persistSession as persistAppSession,
} from "./OnlineAppState.js?v=20260421a";
import {
  formatArea as formatAppArea,
  formatConnectionState as formatAppConnectionState,
  formatFinalScoreLine as formatAppFinalScoreLine,
  formatPlayerName as formatAppPlayerName,
  formatResetVoteMessage as formatAppResetVoteMessage,
  formatWinner as formatAppWinner,
  getInitialLanguage as getAppInitialLanguage,
  getTexts as getAppTexts,
  getNextPlayer as getAppNextPlayer,
  localizeErrorMessage as localizeAppErrorMessage,
} from "./OnlineAppI18n.js?v=20260421a";

const {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} = globalThis.Vue ?? {};

if (!globalThis.Vue) {
  throw new Error("Vue runtime is not available on window.Vue.");
}

// OnlineApp 是联机版页面入口。
// 组件定义和业务流程都放在这里，但通用状态工具与文案已经拆到独立模块。

function resolveApiBaseUrl(serverUrl, locationLike = globalThis.location) {
  const fallbackOrigin = locationLike?.origin ?? "http://localhost:8000";
  const rawUrl = String(serverUrl ?? "").trim();

  if (!rawUrl) {
    return fallbackOrigin;
  }

  try {
    const parsed = new URL(rawUrl, fallbackOrigin);
    parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";

    if (parsed.pathname.endsWith("/ws")) {
      parsed.pathname = parsed.pathname.slice(0, -3) || "/";
    }

    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return fallbackOrigin;
  }
}

async function postAuthJson(serverUrl, path, payload) {
  const response = await fetch(`${resolveApiBaseUrl(serverUrl)}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new Error(data?.detail ?? `HTTP ${response.status}`);
  }

  return data;
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
    const texts = computed(() => getAppTexts(props.language));
    const currentPlayerLabel = computed(() => formatAppPlayerName(props.gameState.currentPlayer, props.language));
    const localRoleLabel = computed(() => formatAppPlayerName(props.session.color, props.language));
    const winnerLabel = computed(() => formatAppWinner(props.gameState.winner, props.language));
    const turnBannerClass = computed(() => {
      if (props.gameState.currentPlayer === Player.BLACK) {
        return "is-blue";
      }
      if (props.gameState.currentPlayer === Player.WHITE) {
        return "is-red";
      }
      return "is-purple";
    });

    return {
      Player,
      texts,
      currentPlayerLabel,
      localRoleLabel,
      winnerLabel,
      turnBannerClass,
      formatArea: formatAppArea,
    };
  },
  template: `
    <section class="panel panel-score">
      <div class="panel-head">
        <p class="eyebrow">{{ texts.boardStatusEyebrow }}</p>
        <h2>{{ texts.boardStatus }}</h2>
      </div>

      <div class="turn-banner" :class="turnBannerClass">
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
        <article class="score-card score-card-purple">
          <p>{{ texts.purpleTerritory }}</p>
          <strong>{{ formatArea(gameState.scores[Player.PURPLE]) }}</strong>
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

const SetupPanel = {
  name: "SetupPanel",
  emits: ["update:player-count", "update:grid-size", "update:language"],
  props: {
    language: {
      type: String,
      required: true,
    },
    playerCount: {
      type: Number,
      required: true,
    },
    gridSize: {
      type: Number,
      required: true,
    },
    settingsLocked: {
      type: Boolean,
      default: false,
    },
    busy: {
      type: Boolean,
      default: false,
    },
  },
  setup(props) {
    const texts = computed(() => getAppTexts(props.language));

    return {
      texts,
      PLAYER_COUNT_OPTIONS: APP_PLAYER_COUNT_OPTIONS,
      GRID_SIZE_OPTIONS: APP_GRID_SIZE_OPTIONS,
    };
  },
  template: `
    <section class="panel panel-setup">
      <div class="panel-head">
        <p class="eyebrow">{{ texts.setupLabel || '对局设置' }}</p>
        <h2>{{ texts.setupLabel || '对局设置' }}</h2>
      </div>

      <div class="settings-cluster settings-cluster-standalone">
        <div class="settings-cluster-head">
          <p class="eyebrow">{{ texts.boardStatusEyebrow }}</p>
          <span class="settings-lock" v-if="settingsLocked">{{ texts.lockedLabel || '已锁定' }}</span>
        </div>
        <div class="settings-grid">
          <div>
            <label class="field-label">{{ texts.languageLabel || '语言' }}</label>
            <div id="language-select" class="language-switcher language-switcher-inline" role="group" :aria-label="texts.languageLabel">
              <button
                class="language-button"
                :class="{ 'is-active': language === 'zh' }"
                :disabled="busy"
                @click="$emit('update:language', 'zh')"
              >
                中文
              </button>
              <button
                class="language-button"
                :class="{ 'is-active': language === 'en' }"
                :disabled="busy"
                @click="$emit('update:language', 'en')"
              >
                English
              </button>
            </div>
          </div>
          <div>
            <label class="field-label" for="player-count">{{ texts.playerCountLabel || '玩家人数' }}</label>
            <select
              id="player-count"
              class="input-field input-field-compact"
              :value="playerCount"
              :disabled="busy || settingsLocked"
              @change="$emit('update:player-count', Number($event.target.value))"
            >
              <option v-for="count in PLAYER_COUNT_OPTIONS" :key="count" :value="count">{{ count }}</option>
            </select>
          </div>
          <div>
            <label class="field-label" for="grid-size">{{ texts.gridSizeLabel || '棋盘边长' }}</label>
            <select
              id="grid-size"
              class="input-field input-field-compact"
              :value="gridSize"
              :disabled="busy || settingsLocked"
              @change="$emit('update:grid-size', Number($event.target.value))"
            >
              <option v-for="size in GRID_SIZE_OPTIONS" :key="size" :value="size">{{ size }}</option>
            </select>
          </div>
        </div>
      </div>
    </section>
  `,
};

const AuthPanel = {
  name: "AuthPanel",
  emits: [
    "update:mode",
    "update:username",
    "update:password",
    "submit",
    "logout",
  ],
  props: {
    language: {
      type: String,
      required: true,
    },
    auth: {
      type: Object,
      required: true,
    },
    mode: {
      type: String,
      required: true,
    },
    username: {
      type: String,
      required: true,
    },
    password: {
      type: String,
      required: true,
    },
    busy: {
      type: Boolean,
      default: false,
    },
    error: {
      type: String,
      default: "",
    },
    feedbackTone: {
      type: String,
      default: "error",
    },
  },
  setup(props) {
    const texts = computed(() => getAppTexts(props.language));
    const isAuthenticated = computed(() => Boolean(props.auth?.token && props.auth?.username));

    return {
      texts,
      isAuthenticated,
    };
  },
  template: `
    <section class="panel panel-auth">
      <div class="panel-head">
        <p class="eyebrow">{{ texts.authEyebrow }}</p>
        <h2>{{ texts.authTitle }}</h2>
      </div>

      <template v-if="isAuthenticated">
        <div class="auth-welcome">
          <p class="auth-welcome-label">{{ texts.authLoggedIn }}</p>
          <strong>{{ auth.username }}</strong>
          <p class="help-copy auth-help">{{ texts.authRequired }}</p>
        </div>

        <div class="actions">
          <button class="action-button action-button-ghost" :disabled="busy" @click="$emit('logout')">
            {{ texts.authLogout }}
          </button>
        </div>
      </template>

      <template v-else>
        <div class="auth-tabs" role="tablist" :aria-label="texts.authTitle">
          <button
            class="language-button auth-tab"
            :class="{ 'is-active': mode === 'login' }"
            :disabled="busy"
            @click="$emit('update:mode', 'login')"
          >
            {{ texts.authLoginTab }}
          </button>
          <button
            class="language-button auth-tab"
            :class="{ 'is-active': mode === 'register' }"
            :disabled="busy"
            @click="$emit('update:mode', 'register')"
          >
            {{ texts.authRegisterTab }}
          </button>
        </div>

        <label class="field-label" for="auth-username">{{ texts.authUsername }}</label>
        <input
          id="auth-username"
          class="input-field"
          autocomplete="username"
          :value="username"
          :disabled="busy"
          @input="$emit('update:username', $event.target.value)"
        />

        <label class="field-label" for="auth-password">{{ texts.authPassword }}</label>
        <input
          id="auth-password"
          class="input-field"
          type="password"
          autocomplete="current-password"
          :value="password"
          :disabled="busy"
          @input="$emit('update:password', $event.target.value)"
          @keydown.enter="$emit('submit')"
        />

        <div class="actions">
          <button class="action-button action-button-primary" :disabled="busy" @click="$emit('submit')">
            {{ mode === 'login' ? texts.authLoginAction : texts.authRegisterAction }}
          </button>
        </div>
      </template>

      <p v-if="error" :class="feedbackTone === 'success' ? 'success-copy' : 'error-copy'">{{ error }}</p>
    </section>
  `,
};

const RoomPanel = {
  name: "RoomPanel",
  emits: [
    "connect",
    "create-room",
    "join-room",
    "leave-room",
    "update:server-url",
    "update:room-id",
  ],
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
    authenticated: {
      type: Boolean,
      default: false,
    },
    language: {
      type: String,
      required: true,
    },
  },
  setup(props) {
    const texts = computed(() => getAppTexts(props.language));
    const roleLabel = computed(() => formatAppPlayerName(props.session.color, props.language));
    const connectionLabel = computed(() => formatAppConnectionState(props.connectionState, props.language));
    const roomStatusLabel = computed(() => formatAppConnectionState(props.roomStatus, props.language));

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
        <button class="action-button action-button-primary" :disabled="busy || !authenticated" @click="$emit('connect')">
          {{ texts.connectServer }}
        </button>
        <button class="action-button action-button-secondary" :disabled="busy || !authenticated" @click="$emit('create-room')">
          {{ texts.createRoom }}
        </button>
        <button class="action-button action-button-secondary" :disabled="busy || !authenticated" @click="$emit('join-room')">
          {{ texts.joinRoom }}
        </button>
        <button class="action-button action-button-ghost" :disabled="busy || !authenticated || !session.roomId" @click="$emit('leave-room')">
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
      <p v-else-if="!authenticated" class="help-copy">{{ texts.authRequired }}</p>
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
    const texts = computed(() => getAppTexts(props.language));
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
    const texts = computed(() => getAppTexts(props.language));
    const title = computed(() => {
      if (props.overlayResult) {
        return formatAppWinner(props.overlayResult.winner, props.language);
      }
      return formatAppWinner(props.gameState.winner, props.language);
    });
    const summary = computed(() => {
      if (props.overlayResult?.scoreLine) {
        return props.overlayResult.scoreLine;
      }
      if (props.overlayResult) {
        return texts.value.resignedSummary(
          formatAppPlayerName(props.overlayResult.winner, props.language),
          formatAppPlayerName(props.overlayResult.loser, props.language),
        );
      }
      return formatAppFinalScoreLine(props.gameState.scores, props.language, props.gameState.players);
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
      texts: computed(() => getAppTexts(props.language)),
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

const App = {
  name: "TriangularGameOnlineApp",
  components: {
    AuthPanel,
    BoardCanvas,
    ControlPanel,
    ResultModal,
    RoomPanel,
    ScorePanel,
    SetupPanel,
  },
  setup() {
    const storedAuth = loadAppStoredAuth();
    const storedSession = loadAppStoredSession();
    const initialSettings = normalizeAppGameSettings(storedSession.settings);
    const controller = ref(null);
    const gameState = ref(createAppDefaultGameState());
    const language = ref(getAppInitialLanguage());
    const networkManager = new NetworkManager();
    networkManager.setAuthToken(storedAuth.token);
    networkManager.hydrateSession(storedSession);
    const serverUrl = ref(storedSession.url || resolveWebSocketUrl());
    const roomIdInput = ref(storedSession.roomId || "");
    const auth = ref(storedAuth);
    const authMode = ref("login");
    const authUsername = ref(storedAuth.username || "");
    const authPassword = ref("");
    const authBusy = ref(false);
    const authError = ref("");
    const authFeedbackTone = ref("error");
    const selectedPlayerCount = ref(initialSettings.playerCount);
    const selectedGridSize = ref(initialSettings.gridSize);
    const session = ref(networkManager.getSession());
    const connectionState = ref("idle");
    const roomStatus = ref("solo");
    const networkBusy = ref(false);
    const networkError = ref("");
    const overlayResult = ref(null);
    const unsubscribers = [];
    let reconnectTimerId = null;
    let reconnectAttempt = 0;
    let syncingRemoteSettings = false;

    watch(language, (value) => {
      globalThis.localStorage?.setItem("triaxis-language", value);
      document.documentElement.lang = value === "en" ? "en" : "zh-CN";
      document.title = getAppTexts(value).pageTitle;
    }, { immediate: true });

    watch(auth, (value) => {
      persistAppAuth(value);
      networkManager.setAuthToken(value?.token ?? null);
    }, { deep: true, immediate: true });

    watch(authMode, () => {
      authError.value = "";
      authPassword.value = "";
      authFeedbackTone.value = "error";
    });

    watch([selectedPlayerCount, selectedGridSize], ([playerCount, gridSize]) => {
      if (syncingRemoteSettings) {
        return;
      }

      // 本地模式下改设置立即重建棋盘；联机模式下设置以房间配置为准。
      const normalized = normalizeAppGameSettings({ playerCount, gridSize });
      selectedPlayerCount.value = normalized.playerCount;
      selectedGridSize.value = normalized.gridSize;
      syncSession();

      if (roomStatus.value === "solo" && controller.value) {
        gameState.value = controller.value.setGameConfig(normalized, true);
      }
    });

    const syncSession = () => {
      // UI 自己维护“期望中的设置”，并把它和房间上下文合并后持久化。
      session.value = {
        ...createAppEmptySession(),
        ...networkManager.getSession(),
        settings: {
          playerCount: selectedPlayerCount.value,
          gridSize: selectedGridSize.value,
        },
      };
      persistAppSession(session.value);
    };

    const setAuthState = (nextAuth) => {
      auth.value = {
        ...createAppEmptyAuth(),
        ...nextAuth,
      };
    };

    const clearAuthState = () => {
      setAuthState(createAppEmptyAuth());
      authPassword.value = "";
      authError.value = "";
      authFeedbackTone.value = "error";
    };

    const handleAuthError = (error) => {
      authFeedbackTone.value = "error";
      authError.value = localizeAppErrorMessage(error?.message ?? String(error), language.value);
    };

    const isAuthenticated = computed(() => Boolean(auth.value.token && auth.value.username));

    const currentGameSettings = () => ({
      playerCount: selectedPlayerCount.value,
      gridSize: selectedGridSize.value,
    });

    const applySettingsToController = (settings, reset = true) => {
      const normalized = normalizeAppGameSettings(settings);
      selectedPlayerCount.value = normalized.playerCount;
      selectedGridSize.value = normalized.gridSize;
      syncSession();

      if (!controller.value) {
        return;
      }

      syncingRemoteSettings = true;
      // 远端同步设置时先打标记，避免 watch 把这次被动更新误判为用户主动修改。
      controller.value.setGameConfig(normalized, reset);
      syncingRemoteSettings = false;
    };

    const clearReconnectTimer = () => {
      if (reconnectTimerId !== null) {
        globalThis.clearTimeout(reconnectTimerId);
        reconnectTimerId = null;
      }
    };

    const handleNetworkError = (error) => {
      networkError.value = localizeAppErrorMessage(error?.message ?? String(error), language.value);
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

      // 断线重连的核心思路：重新入房，然后用服务端的 matchState 回放棋盘。
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
        applySettingsToController(payload.settings ?? payload.matchState?.settings ?? currentGameSettings(), true);
        syncSession();
        enableOnlineController(payload, payload.status === "READY");
        if (payload.matchState && controller.value) {
          gameState.value = controller.value.restoreMatchState(payload.matchState);
        }
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

      if (!auth.value.token) {
        throw new Error("Authentication token is required. Please log in first.");
      }

      connectionState.value = "connecting";
      await networkManager.connect(serverUrl.value.trim(), auth.value.token);
      connectionState.value = "connected";
      syncSession();
    };

    const handleLogout = async () => {
      authBusy.value = true;

      try {
        clearReconnectTimer();
        roomStatus.value = "solo";
        connectionState.value = "idle";
        networkManager.disconnect(1000, "logout");
        await networkManager.leaveRoom();
        networkManager.clearAuthToken();
        networkManager.url = null;
        networkManager.roomId = null;
        networkManager.playerId = null;
        networkManager.color = null;
        if (controller.value) {
          controller.value.disableMultiplayer();
          gameState.value = controller.value.resetGame({ force: true });
        }
        roomIdInput.value = "";
        persistAppSession(createAppEmptySession());
        syncSession();
        clearAuthState();
      } finally {
        authBusy.value = false;
      }
    };

    const handleControllerReady = (instance) => {
      controller.value = instance;
      controller.value.setNetworkErrorListener(handleNetworkError);
      gameState.value = instance.setGameConfig(currentGameSettings(), true);
    };

    const handleStateChange = (nextState) => {
      gameState.value = nextState;
    };

    const handleAuthSubmit = async () => {
      const username = authUsername.value.trim();
      const password = authPassword.value;

      authBusy.value = true;
      authError.value = "";
      authFeedbackTone.value = "error";

      try {
        if (!username) {
          throw new Error("Username cannot be empty.");
        }

        if (authMode.value === "register") {
          await postAuthJson(serverUrl.value, "/api/register", {
            username,
            password,
          });
          authMode.value = "login";
          authPassword.value = "";
          authFeedbackTone.value = "success";
          authError.value = getAppTexts(language.value).authRegisterSuccess;
          return;
        }

        const payload = await postAuthJson(serverUrl.value, "/api/login", {
          username,
          password,
        });
        setAuthState({
          token: payload.token ?? null,
          username: payload.username ?? username,
        });
        authUsername.value = payload.username ?? username;
        authPassword.value = "";
        authError.value = "";
        authFeedbackTone.value = "error";
        networkError.value = "";
        if (session.value.roomId && session.value.playerId && session.value.url) {
          roomStatus.value = "offline";
          void attemptReconnect();
        }
      } catch (error) {
        handleAuthError(error);
      } finally {
        authBusy.value = false;
      }
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
        const payload = await networkManager.createRoom(currentGameSettings());
        roomIdInput.value = payload.roomId ?? roomIdInput.value;
        roomStatus.value = "waiting";
        applySettingsToController(payload.settings ?? currentGameSettings(), true);
        syncSession();

        if (controller.value) {
          controller.value.resetGame({ force: true });
        }
        enableOnlineController(payload, false);
        if (payload.matchState && controller.value) {
          gameState.value = controller.value.restoreMatchState(payload.matchState);
        }
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
        applySettingsToController(payload.settings ?? payload.matchState?.settings ?? currentGameSettings(), true);
        syncSession();

        if (controller.value) {
          controller.value.resetGame({ force: true });
        }
        enableOnlineController(payload, payload.status === "READY");
        if (payload.matchState && controller.value) {
          gameState.value = controller.value.restoreMatchState(payload.matchState);
        }
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
        persistAppSession(createAppEmptySession());
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
        if (!gameState.value.gameOver) {
          // 本地模式中途重开，UI 用一个临时 overlay 表示“当前行动方认输”。
          overlayResult.value = {
            winner: getAppNextPlayer(gameState.value.currentPlayer),
            loser: gameState.value.currentPlayer,
            resetAfterClose: true,
          };
          return;
        }

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
      const texts = getAppTexts(language.value);
      if (roomStatus.value === "waiting") {
        return texts.waitingStatus(session.value.roomId);
      }

      if (roomStatus.value === "offline") {
        return texts.offlineStatus;
      }

      if (gameState.value.gameOver) {
        return language.value === "en"
          ? texts.finalStatus(
            formatAppWinner(gameState.value.winner, language.value),
            formatAppFinalScoreLine(gameState.value.scores, language.value, gameState.value.players),
          )
          : texts.finalStatus(
            formatAppWinner(gameState.value.winner, language.value),
            formatAppFinalScoreLine(gameState.value.scores, language.value, gameState.value.players),
          );
      }

      if (roomStatus.value === "ready") {
        return gameState.value.isLocalTurn
          ? texts.localTurnStatus(formatAppPlayerName(session.value.color, language.value))
          : texts.remoteTurnStatus;
      }

      return gameState.value.currentPlayer === Player.BLACK
        ? texts.soloBlueStatus
        : gameState.value.currentPlayer === Player.WHITE
          ? texts.soloRedStatus
          : (texts.soloPurpleStatus ?? "Purple to move.");
    });

    const boardHint = computed(() => {
      const texts = getAppTexts(language.value);
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
      const texts = getAppTexts(language.value);
      if (roomStatus.value === "solo") {
        return gameState.value.gameOver ? texts.startNewSolo : texts.resetBoard;
      }

      return gameState.value.gameOver ? texts.startNextOnline : texts.resignAndRestart;
    });

    const controlsHelpText = computed(() => {
      const texts = getAppTexts(language.value);
      if (roomStatus.value === "solo") {
        return texts.soloHelp;
      }

      if (gameState.value.gameOver) {
        return texts.onlineOverHelp;
      }

      return texts.onlinePlayHelp;
    });

    const settingsLocked = computed(() => roomStatus.value !== "solo" || networkBusy.value);

    const resultResetAllowed = computed(() => {
      return !resetDisabled.value;
    });

    const handleResultAction = async () => {
      if (overlayResult.value) {
        if (overlayResult.value.resetAfterClose && controller.value) {
          gameState.value = controller.value.resetGame();
        }
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
      networkManager.on(ClientEvent.CLOSE, (payload) => {
        connectionState.value = "disconnected";
        syncSession();
        if (payload?.code === 4401) {
          networkError.value = localizeAppErrorMessage(`WebSocket closed: ${payload.code} ${payload.reason}`, language.value);
          clearReconnectTimer();
          void handleLogout();
          return;
        }
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
        applySettingsToController(payload.settings ?? currentGameSettings(), true);
        syncSession();
        enableOnlineController(payload, false);
        if (payload.matchState && controller.value) {
          gameState.value = controller.value.restoreMatchState(payload.matchState);
        }
        reconnectAttempt = 0;
      }),
    );

    unsubscribers.push(
      networkManager.on(ServerEvent.ROOM_JOINED, (payload) => {
        const ready = payload.status === "READY";
        roomStatus.value = ready ? "ready" : "waiting";
        roomIdInput.value = payload.roomId ?? roomIdInput.value;
        applySettingsToController(payload.settings ?? payload.matchState?.settings ?? currentGameSettings(), true);
        syncSession();
        enableOnlineController(payload, ready);
        if (payload.matchState && controller.value) {
          gameState.value = controller.value.restoreMatchState(payload.matchState);
        }
        reconnectAttempt = 0;
      }),
    );

    unsubscribers.push(
      networkManager.on(ServerEvent.ROOM_READY, (payload) => {
        roomStatus.value = "ready";
        applySettingsToController(payload.settings ?? payload.matchState?.settings ?? currentGameSettings(), true);
        syncSession();
        enableOnlineController(payload, true);
        if (payload.matchState && controller.value) {
          gameState.value = controller.value.restoreMatchState(payload.matchState);
        }
        reconnectAttempt = 0;
      }),
    );

    unsubscribers.push(
      networkManager.on(ServerEvent.PLAYER_LEFT, () => {
        roomStatus.value = "waiting";
        networkError.value = getAppTexts(language.value).opponentLeft;
        syncControllerState({
          enabled: true,
          networkManager,
          roomReady: false,
          opponentConnected: false,
        });
      }),
    );

    unsubscribers.push(
      networkManager.on(ServerEvent.RESET_STATUS, (payload) => {
        networkError.value = formatAppResetVoteMessage(
          payload.confirmedVotes ?? 0,
          payload.requiredVotes ?? 0,
          language.value,
        );
      }),
    );

    unsubscribers.push(
      networkManager.on(ServerEvent.MATCH_RESET, (payload) => {
        networkError.value = "";
        roomStatus.value = "ready";
        // 联机重置后，服务端不会回传整盘棋，而是让前端自己重建空盘并展示结算 overlay。
        if (payload.reason === "consensus_restart" && payload.winnerColor) {
          overlayResult.value = {
            winner: payload.winnerColor,
            scoreLine: formatAppFinalScoreLine(gameState.value.scores, language.value, gameState.value.players),
          };
        } else if (payload.reason === "resign_restart" && payload.winnerColor && payload.color) {
          overlayResult.value = {
            winner: payload.winnerColor,
            loser: payload.color,
          };
        }
      }),
    );

    unsubscribers.push(
      networkManager.on(ServerEvent.ERROR, (payload) => {
        handleNetworkError(new Error(payload.message ?? payload.code ?? getAppTexts(language.value).unknownServer));
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

    onMounted(() => {
      if (storedAuth.token && storedSession.roomId && storedSession.playerId && storedSession.url) {
        roomStatus.value = "offline";
        void attemptReconnect();
      }
    });

    return {
      auth,
      authBusy,
      authError,
      authFeedbackTone,
      authMode,
      authPassword,
      authUsername,
      controller,
      gameState,
      getTexts: getAppTexts,
      isAuthenticated,
      language,
      serverUrl,
      roomIdInput,
      selectedPlayerCount,
      selectedGridSize,
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
      settingsLocked,
      resultResetAllowed,
      handleResultAction,
      handleControllerReady,
      handleAuthSubmit,
      handleLogout,
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
          <AuthPanel
            :language="language"
            :auth="auth"
            :mode="authMode"
            :username="authUsername"
            :password="authPassword"
            :busy="authBusy"
            :error="authError"
            :feedback-tone="authFeedbackTone"
            @update:mode="authMode = $event"
            @update:username="authUsername = $event"
            @update:password="authPassword = $event"
            @submit="handleAuthSubmit"
            @logout="handleLogout"
          />

          <SetupPanel
            :language="language"
            :player-count="selectedPlayerCount"
            :grid-size="selectedGridSize"
            :settings-locked="settingsLocked"
            :busy="networkBusy"
            @update:language="language = $event"
            @update:player-count="selectedPlayerCount = $event"
            @update:grid-size="selectedGridSize = $event"
          />

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
            :authenticated="isAuthenticated"
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





