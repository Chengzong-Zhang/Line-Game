import GameController from "./GameController.js?v=20260426d";
import { Player } from "./GameEngine.js?v=20260421c";
import NetworkManager, { ClientEvent, ServerEvent, resolveWebSocketUrl } from "./NetworkManager.js?v=20260421c";
import {
  createEmptyAuth as createAppEmptyAuth,
  GRID_SIZE_OPTIONS as APP_GRID_SIZE_OPTIONS,
  PLAYER_COUNT_OPTIONS as APP_PLAYER_COUNT_OPTIONS,
  DEFAULT_TURN_TIMER_SECONDS as APP_DEFAULT_TURN_TIMER_SECONDS,
  TURN_TIMER_MAX_SECONDS as APP_TURN_TIMER_MAX_SECONDS,
  TURN_TIMER_MIN_SECONDS as APP_TURN_TIMER_MIN_SECONDS,
  createDefaultGameState as createAppDefaultGameState,
  createEmptySession as createAppEmptySession,
  loadStoredAuth as loadAppStoredAuth,
  loadStoredSession as loadAppStoredSession,
  normalizeGameSettings as normalizeAppGameSettings,
  persistAuth as persistAppAuth,
  persistSession as persistAppSession,
} from "./OnlineAppState.js?v=20260421c";
import {
  formatArea as formatAppArea,
  formatConnectionState as formatAppConnectionState,
  formatFinalScoreLine as formatAppFinalScoreLine,
  formatPlayerName as formatAppPlayerName,
  formatResetVoteMessage as formatAppResetVoteMessage,
  formatWinner as formatAppWinner,
  getInitialLanguage as getAppInitialLanguage,
  getTexts as getAppTexts,
  localizeErrorMessage as localizeAppErrorMessage,
} from "./OnlineAppI18n.js?v=20260426c";

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

function resolveInitialServerUrl(storedUrl, locationLike = globalThis.location) {
  const dynamicUrl = resolveWebSocketUrl(locationLike);
  const rawUrl = String(storedUrl ?? "").trim();

  if (!rawUrl) {
    return dynamicUrl;
  }

  try {
    const parsed = new URL(rawUrl, dynamicUrl);
    if (locationLike?.protocol === "https:" && parsed.protocol === "ws:") {
      return dynamicUrl;
    }
    return parsed.toString();
  } catch {
    return dynamicUrl;
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

const ROOM_START_COUNTDOWN_FALLBACK_SECONDS = 20;

function createEmptyRoomInfo() {
  return {
    status: "solo",
    hostPlayerId: null,
    players: [],
    settings: normalizeAppGameSettings(),
    countdownEndsAt: null,
  };
}

function normalizeRoomStatus(status) {
  const normalized = String(status ?? "").trim().toLowerCase();
  if (normalized === "in_progress") {
    return "inProgress";
  }
  return normalized || "solo";
}

const PLAYER_ACCENT_CLASS = Object.freeze({
  [Player.BLACK]: "player-accent-blue",
  [Player.WHITE]: "player-accent-red",
  [Player.PURPLE]: "player-accent-purple",
});

function getPlayerAccentClass(player) {
  return PLAYER_ACCENT_CLASS[player] ?? "";
}

function findRoomPlayerByColor(roomPlayers, color) {
  if (!Array.isArray(roomPlayers)) {
    return null;
  }

  return roomPlayers.find((player) => player?.color === color) ?? null;
}

function resolveOnlinePlayerName(roomPlayers, color, language) {
  const player = findRoomPlayerByColor(roomPlayers, color);
  return player?.username ?? player?.playerId ?? formatAppPlayerName(color, language);
}

function buildNamedScoreEntries(scores, players, roomPlayers, language) {
  const activePlayers = Array.isArray(players) && players.length
    ? players
    : [Player.BLACK, Player.WHITE];

  return activePlayers
    .filter((player) => scores && Object.prototype.hasOwnProperty.call(scores, player))
    .map((player) => ({
      key: player,
      color: player,
      name: resolveOnlinePlayerName(roomPlayers, player, language),
      value: scores?.[player],
      accentClass: getPlayerAccentClass(player),
    }));
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
    roomPlayers: {
      type: Array,
      default: () => [],
    },
    language: {
      type: String,
      required: true,
    },
    statusText: {
      type: String,
      default: "",
    },
  },
  setup(props) {
    const texts = computed(() => getAppTexts(props.language));
    const isOnlineMatch = computed(() => Boolean(props.session?.roomId));
    const currentPlayerLabel = computed(() => (
      isOnlineMatch.value
        ? resolveOnlinePlayerName(props.roomPlayers, props.gameState.currentPlayer, props.language)
        : formatAppPlayerName(props.gameState.currentPlayer, props.language)
    ));
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
    const scoreCards = computed(() => {
      const players = Array.isArray(props.gameState.players) && props.gameState.players.length
        ? props.gameState.players
        : [Player.BLACK, Player.WHITE];

      return players.map((player) => {
        const namedCard = {
          key: player,
          name: resolveOnlinePlayerName(props.roomPlayers, player, props.language),
          accentClass: getPlayerAccentClass(player),
          isNamed: isOnlineMatch.value,
        };

        if (player === Player.BLACK) {
          return {
            ...namedCard,
            label: texts.value.blueTerritory,
            value: props.gameState.scores?.[Player.BLACK],
            className: "score-card-blue",
          };
        }

        if (player === Player.WHITE) {
          return {
            ...namedCard,
            label: texts.value.redTerritory,
            value: props.gameState.scores?.[Player.WHITE],
            className: "score-card-red",
          };
        }

        return {
          ...namedCard,
          label: texts.value.purpleTerritory,
          value: props.gameState.scores?.[Player.PURPLE],
          className: "score-card-purple",
        };
      });
    });

    return {
      Player,
      texts,
      currentPlayerLabel,
      localRoleLabel,
      winnerLabel,
      turnBannerClass,
      scoreCards,
      formatArea: formatAppArea,
    };
  },
  template: `
    <section class="panel panel-score">
      <div class="panel-head">
        <p class="eyebrow">{{ texts.boardStatusEyebrow }}</p>
        <h2>{{ texts.boardStatus }}</h2>
      </div>

      <p class="status-copy panel-status-copy">{{ statusText }}</p>

      <div class="turn-banner" :class="turnBannerClass">
        <span class="turn-dot"></span>
        <strong>{{ currentPlayerLabel }}{{ texts.turnSuffix }}</strong>
        <small>{{ winnerLabel }}</small>
      </div>

      <div class="score-grid">
        <article
          v-for="card in scoreCards"
          :key="card.key"
          class="score-card"
          :class="card.className"
        >
          <p v-if="card.isNamed">
            <span :class="card.accentClass">{{ card.name }}</span><span>{{ texts.territorySuffix }}</span>
          </p>
          <p v-else>{{ card.label }}</p>
          <strong>{{ formatArea(card.value) }}</strong>
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
  emits: [
    "update:player-count",
    "update:grid-size",
    "update:language",
    "update:turn-timer-enabled",
    "update:turn-time-limit-seconds",
  ],
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
    turnTimerEnabled: {
      type: Boolean,
      default: false,
    },
    turnTimeLimitSeconds: {
      type: Number,
      default: APP_DEFAULT_TURN_TIMER_SECONDS,
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
      TURN_TIMER_MAX_SECONDS: APP_TURN_TIMER_MAX_SECONDS,
      TURN_TIMER_MIN_SECONDS: APP_TURN_TIMER_MIN_SECONDS,
    };
  },
  template: `
    <section class="panel panel-setup modal-panel">
      <div class="panel-head panel-head-inline">
        <div>
          <p class="eyebrow">{{ texts.setupLabel || '对局设置' }}</p>
          <h2>{{ texts.setupLabel || '对局设置' }}</h2>
        </div>
        <span class="panel-head-badge" v-if="settingsLocked">{{ texts.lockedLabel || '已锁定' }}</span>
      </div>

      <div class="settings-cluster settings-cluster-standalone">
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
          <div>
            <label class="field-label" for="turn-timer-enabled">{{ texts.turnTimerLabel || '读秒开关' }}</label>
            <label class="toggle-field" for="turn-timer-enabled">
              <input
                id="turn-timer-enabled"
                type="checkbox"
                :checked="turnTimerEnabled"
                :disabled="busy || settingsLocked"
                @change="$emit('update:turn-timer-enabled', $event.target.checked)"
              />
              <span>{{ turnTimerEnabled ? 'ON' : 'OFF' }}</span>
            </label>
          </div>
          <div v-if="turnTimerEnabled">
            <label class="field-label" for="turn-time-limit">{{ texts.turnTimerDurationLabel || '读秒时长' }}</label>
            <input
              id="turn-time-limit"
              class="input-field input-field-compact"
              type="number"
              :min="TURN_TIMER_MIN_SECONDS"
              :max="TURN_TIMER_MAX_SECONDS"
              :value="turnTimeLimitSeconds"
              :disabled="busy || settingsLocked"
              @change="$emit('update:turn-time-limit-seconds', Number($event.target.value))"
            />
          </div>
        </div>
        <p class="help-copy">{{ texts.turnTimerHint }}</p>
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
    <section class="panel panel-auth modal-panel">
      <div class="panel-head panel-head-inline">
        <div>
          <p class="eyebrow">{{ texts.authEyebrow }}</p>
          <h2>{{ texts.authTitle }}</h2>
        </div>
        <span class="panel-head-badge" v-if="isAuthenticated">{{ auth.username }}</span>
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
    "toggle-ready",
    "update:start-player",
    "close-prompt",
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
    roomInfo: {
      type: Object,
      required: true,
    },
    isHost: {
      type: Boolean,
      default: false,
    },
    localReady: {
      type: Boolean,
      default: false,
    },
    readyDisabled: {
      type: Boolean,
      default: false,
    },
    starterLocked: {
      type: Boolean,
      default: false,
    },
    startPlayer: {
      type: String,
      default: "",
    },
    starterOptions: {
      type: Array,
      default: () => [],
    },
    showClosePrompt: {
      type: Boolean,
      default: false,
    },
  },
  setup(props) {
    const texts = computed(() => getAppTexts(props.language));
    const roleLabel = computed(() => formatAppPlayerName(props.session.color, props.language));
    const connectionLabel = computed(() => formatAppConnectionState(props.connectionState, props.language));
    const roomStatusLabel = computed(() => formatAppConnectionState(props.roomStatus, props.language));
    const roomPlayers = computed(() => Array.isArray(props.roomInfo?.players) ? props.roomInfo.players : []);
    const roomPlayerName = (player) => player?.username ?? player?.playerId ?? formatAppPlayerName(player?.color, props.language);
    const readyActionLabel = computed(() => (
      props.roomStatus === "inProgress"
        ? texts.value.inProgress
        : (props.localReady ? texts.value.cancelReadyAction : texts.value.readyAction)
    ));
    const resolvePlayerState = (player) => {
      if (!player?.connected) {
        return {
          className: "status-pill-muted",
          label: texts.value.roomOfflineTag,
        };
      }
      if (props.roomStatus === "inProgress") {
        return {
          className: "status-pill-live",
          label: texts.value.inProgress,
        };
      }
      if (player.ready) {
        return {
          className: "status-pill-success",
          label: texts.value.roomReadyTag,
        };
      }
      return {
        className: "status-pill-warn",
        label: texts.value.roomIdleTag,
      };
    };

    return {
      texts,
      roleLabel,
      connectionLabel,
      roomStatusLabel,
      roomPlayers,
      getPlayerAccentClass,
      readyActionLabel,
      resolvePlayerState,
      roomPlayerName,
    };
  },
  template: `
    <section class="panel panel-network modal-panel">
      <div class="panel-head panel-head-inline">
        <div>
          <p class="eyebrow">{{ texts.onlineEyebrow }}</p>
          <h2>{{ texts.onlineMatch }}</h2>
        </div>
        <span class="panel-head-badge">{{ roomStatusLabel }}</span>
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

      <div class="room-lobby" v-if="session.roomId">
        <div class="panel-subhead">
          <p class="eyebrow">{{ texts.roomLobby }}</p>
          <h3>{{ texts.roomPlayers }}</h3>
        </div>

        <div class="status-pill-row room-action-row">
          <button
            class="action-button action-button-primary"
            :disabled="readyDisabled"
            @click="$emit('toggle-ready', !localReady)"
          >
            {{ readyActionLabel }}
          </button>
          <button
            v-if="showClosePrompt"
            class="action-button action-button-ghost"
            :disabled="busy"
            @click="$emit('close-prompt')"
          >
            {{ texts.closePrompt }}
          </button>
        </div>

        <div class="room-player-list">
          <article v-for="player in roomPlayers" :key="player.playerId" class="room-player-card">
            <div>
              <strong :class="getPlayerAccentClass(player.color)">{{ roomPlayerName(player) }}</strong>
              <span class="room-player-meta" v-if="player.playerId === session.playerId">{{ texts.roomYou }}</span>
              <span class="room-player-meta" v-if="player.isHost">{{ texts.roomHost }}</span>
            </div>
            <span
              class="status-pill"
              :class="resolvePlayerState(player).className"
            >
              {{ resolvePlayerState(player).label }}
            </span>
          </article>
        </div>

        <div v-if="isHost" class="host-controls">
          <div class="panel-subhead">
            <p class="eyebrow">{{ texts.roomControls }}</p>
            <h3>{{ texts.starterLabel }}</h3>
          </div>
          <label class="field-label" for="room-starter">{{ texts.starterLabel }}</label>
          <select
            id="room-starter"
            class="input-field input-field-compact"
            :value="startPlayer"
            :disabled="starterLocked"
            @change="$emit('update:start-player', $event.target.value)"
          >
            <option v-for="option in starterOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </div>
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
    gameState: {
      type: Object,
      required: true,
    },
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
    session: {
      type: Object,
      required: true,
    },
    roomPlayers: {
      type: Array,
      default: () => [],
    },
    turnTimerEnabled: {
      type: Boolean,
      default: false,
    },
    turnTimerRemaining: {
      type: Number,
      default: 0,
    },
    language: {
      type: String,
      required: true,
    },
  },
  setup(props) {
    const texts = computed(() => getAppTexts(props.language));
    const currentPlayerLabel = computed(() => (
      props.session?.roomId
        ? resolveOnlinePlayerName(props.roomPlayers, props.gameState.currentPlayer, props.language)
        : formatAppPlayerName(props.gameState.currentPlayer, props.language)
    ));
    const turnTimerLabel = computed(() => (
      props.turnTimerEnabled
        ? (
          props.turnTimerRemaining > 0
            ? texts.value.turnTimerStatus(Math.max(0, props.turnTimerRemaining))
            : texts.value.countdownPaused
        )
        : ""
    ));
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
      currentPlayerLabel,
      texts,
      turnTimerLabel,
      turnBannerClass,
    };
  },
  template: `
    <section class="panel panel-controls duel-strip">
      <div class="duel-copy">
        <p class="eyebrow">{{ texts.duelDeskTitle }}</p>
        <p class="duel-label">{{ texts.currentTurnLabel }}</p>
        <div class="turn-banner duel-turn-banner" :class="turnBannerClass">
          <span class="turn-dot"></span>
          <strong>{{ currentPlayerLabel }}{{ texts.turnSuffix }}</strong>
          <small v-if="turnTimerEnabled" class="duel-timer-copy">{{ turnTimerLabel }}</small>
        </div>
      </div>
      <div class="actions duel-actions">
        <button class="action-button action-button-primary" :disabled="skipDisabled" @click="$emit('skip')">
          {{ language === 'en' ? 'Skip Turn' : '跳过回合' }}
        </button>
        <button class="action-button action-button-secondary" :disabled="resetDisabled" @click="$emit('reset')">
          {{ resetLabel }}
        </button>
      </div>
    </section>
  `,
};

const ResultModal = {
  name: "ResultModal",
  emits: ["action", "close", "leave"],
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
    session: {
      type: Object,
      required: true,
    },
    roomPlayers: {
      type: Array,
      default: () => [],
    },
    overlayResult: {
      type: Object,
      default: null,
    },
    visible: {
      type: Boolean,
      default: true,
    },
    closeLabel: {
      type: String,
      default: "",
    },
  },
  setup(props) {
    const texts = computed(() => getAppTexts(props.language));
    const isOnlineSettlement = computed(() => Boolean(props.session?.roomId && props.session?.color));
    const resolvedWinner = computed(() => props.overlayResult?.winner ?? props.gameState.winner);
    const localPlayerName = computed(() => (
      isOnlineSettlement.value
        ? resolveOnlinePlayerName(props.roomPlayers, props.session.color, props.language)
        : ""
    ));
    const localPlayerAccentClass = computed(() => getPlayerAccentClass(props.session.color));
    const localPlayerDidWin = computed(() => {
      if (!isOnlineSettlement.value || resolvedWinner.value === "DRAW") {
        return null;
      }
      return resolvedWinner.value === props.session.color;
    });
    const showPerspectiveTitle = computed(() => localPlayerDidWin.value !== null && Boolean(localPlayerName.value));
    const title = computed(() => {
      if (props.overlayResult) {
        return formatAppWinner(props.overlayResult.winner, props.language);
      }
      return formatAppWinner(props.gameState.winner, props.language);
    });
    const titleOutcome = computed(() => {
      if (localPlayerDidWin.value === true) {
        return texts.value.victorySuffix;
      }
      if (localPlayerDidWin.value === false) {
        return texts.value.defeatSuffix;
      }
      return texts.value.draw;
    });
    const structuredSummaryEntries = computed(() => {
      if (props.overlayResult || !isOnlineSettlement.value) {
        return [];
      }
      return buildNamedScoreEntries(
        props.gameState.scores,
        props.gameState.players,
        props.roomPlayers,
        props.language,
      );
    });
    const summary = computed(() => {
      if (props.overlayResult?.scoreLine) {
        return props.overlayResult.scoreLine;
      }
      if (props.overlayResult) {
        return texts.value.resignedSummary(
          resolveOnlinePlayerName(props.roomPlayers, props.overlayResult.winner, props.language),
          resolveOnlinePlayerName(props.roomPlayers, props.overlayResult.loser, props.language),
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
    const showLeaveAction = computed(() => Boolean(
      !props.overlayResult
      && props.session?.roomId
      && props.gameState.gameOver,
    ));
    const showCloseAction = computed(() => !showLeaveAction.value);

    return {
      actionLabel,
      formatArea: formatAppArea,
      localPlayerAccentClass,
      localPlayerName,
      showCloseAction,
      showLeaveAction,
      showPerspectiveTitle,
      structuredSummaryEntries,
      texts,
      title,
      titleOutcome,
      summary,
    };
  },
  template: `
    <transition name="fade">
      <div v-if="visible && (overlayResult || gameState.gameOver)" class="result-overlay" role="dialog" aria-modal="true">
        <div class="result-card">
          <p class="eyebrow">{{ texts.gameOver }}</p>
          <h2 v-if="showPerspectiveTitle" class="result-title-rich">
            <span :class="localPlayerAccentClass">{{ localPlayerName }}</span><span>{{ titleOutcome }}</span>
          </h2>
          <h2 v-else>{{ title }}</h2>
          <p v-if="structuredSummaryEntries.length" class="result-summary result-summary-scoreline">
            <template v-for="(entry, index) in structuredSummaryEntries" :key="entry.key">
              <span :class="entry.accentClass">{{ entry.name }}</span>
              <span class="result-score-value">{{ formatArea(entry.value) }}</span>
              <span v-if="index < structuredSummaryEntries.length - 1" class="result-score-separator"> : </span>
            </template>
          </p>
          <p v-else class="result-summary">{{ summary }}</p>
          <button
            class="action-button action-button-primary"
            :disabled="overlayResult ? false : !allowReset"
            @click="$emit('action')"
          >
            {{ actionLabel }}
          </button>
          <button v-if="showLeaveAction" class="action-button action-button-secondary" @click="$emit('leave')">
            {{ texts.leaveRoomAfterMatch }}
          </button>
          <button v-else-if="showCloseAction" class="action-button action-button-ghost" @click="$emit('close')">
            {{ closeLabel }}
          </button>
        </div>
      </div>
    </transition>
  `,
};

const DockDirectory = {
  name: "DockDirectory",
  props: {
    variant: {
      type: String,
      default: "board",
    },
    title: {
      type: String,
      default: "",
    },
    badge: {
      type: String,
      default: "",
    },
  },
  template: `
    <details class="dock-folder" :class="'dock-folder-' + variant">
      <summary class="dock-folder-summary">
        <span class="dock-folder-head">
          <span class="dock-folder-icon" :class="'dock-folder-icon-' + variant" aria-hidden="true">
            <span v-if="variant === 'board'" class="triangle-glyph"></span>
            <svg v-else viewBox="0 0 24 24" focusable="false">
              <path d="M19.43 12.98c.04-.32.07-.65.07-.98s-.03-.66-.08-.98l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.6-.22l-2.49 1a7.2 7.2 0 0 0-1.69-.98l-.38-2.65A.5.5 0 0 0 14 1h-4a.5.5 0 0 0-.49.42l-.38 2.65c-.61.24-1.18.56-1.69.98l-2.49-1a.5.5 0 0 0-.6.22l-2 3.46a.5.5 0 0 0 .12.64l2.11 1.65c-.05.32-.08.65-.08.98s.03.66.08.98L2.47 14.63a.5.5 0 0 0-.12.64l2 3.46a.5.5 0 0 0 .6.22l2.49-1c.51.42 1.08.74 1.69.98l.38 2.65A.5.5 0 0 0 10 23h4a.5.5 0 0 0 .49-.42l.38-2.65c.61-.24 1.18-.56 1.69-.98l2.49 1a.5.5 0 0 0 .6-.22l2-3.46a.5.5 0 0 0-.12-.64l-2.1-1.65ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z" />
            </svg>
          </span>
          <span class="dock-folder-title-wrap">
            <strong class="dock-folder-title">{{ title }}</strong>
          </span>
        </span>
        <span v-if="badge" class="dock-folder-badge">{{ badge }}</span>
      </summary>
      <div class="dock-folder-body">
        <slot></slot>
      </div>
    </details>
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
    <section class="board-shell panel panel-board-focus">
      <div class="canvas-frame">
        <canvas ref="canvasRef" class="game-canvas" :aria-label="texts.boardAriaLabel"></canvas>
      </div>
    </section>
  `,
};

const App = {
  name: "TriangularGameOnlineApp",
  components: {
    AuthPanel,
    BoardCanvas,
    ControlPanel,
    DockDirectory,
    ResultModal,
    RoomPanel,
    ScorePanel,
    SetupPanel,
  },
  setup() {
    const storedAuth = loadAppStoredAuth();
    const storedSession = loadAppStoredSession();
    const initialServerUrl = resolveInitialServerUrl(storedSession.url);
    const normalizedStoredSession = {
      ...storedSession,
      url: initialServerUrl,
    };
    const initialSettings = normalizeAppGameSettings(normalizedStoredSession.settings);
    const controller = ref(null);
    const gameState = ref(createAppDefaultGameState());
    const language = ref(getAppInitialLanguage());
    const networkManager = new NetworkManager();
    networkManager.setAuthToken(storedAuth.token);
    networkManager.hydrateSession(normalizedStoredSession);
    const serverUrl = ref(initialServerUrl);
    const roomIdInput = ref(normalizedStoredSession.roomId || "");
    const auth = ref(storedAuth);
    const authMode = ref("login");
    const authUsername = ref(storedAuth.username || "");
    const authPassword = ref("");
    const authBusy = ref(false);
    const authError = ref("");
    const authFeedbackTone = ref("error");
    const selectedPlayerCount = ref(initialSettings.playerCount);
    const selectedGridSize = ref(initialSettings.gridSize);
    const selectedStartPlayer = ref(initialSettings.startPlayer);
    const selectedTurnTimerEnabled = ref(initialSettings.turnTimerEnabled);
    const selectedTurnTimeLimitSeconds = ref(initialSettings.turnTimeLimitSeconds);
    const session = ref(networkManager.getSession());
    const connectionState = ref("idle");
    const roomStatus = ref("solo");
    const roomInfo = ref(createEmptyRoomInfo());
    const networkBusy = ref(false);
    const networkError = ref("");
    const overlayResult = ref(null);
    const resultModalDismissed = ref(false);
    const turnCountdown = ref(ROOM_START_COUNTDOWN_FALLBACK_SECONDS);
    const turnTimerRemaining = ref(0);
    const unsubscribers = [];
    let reconnectTimerId = null;
    let turnCountdownTimerId = null;
    let turnTimerId = null;
    let turnTimerDeadline = 0;
    let turnTimerSkipInFlight = false;
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

    watch([selectedPlayerCount, selectedGridSize, selectedStartPlayer, selectedTurnTimerEnabled, selectedTurnTimeLimitSeconds], ([
      playerCount,
      gridSize,
      startPlayer,
      turnTimerEnabled,
      turnTimeLimitSeconds,
    ], [
      previousPlayerCount,
      previousGridSize,
      previousStartPlayer,
      previousTurnTimerEnabled,
      previousTurnTimeLimitSeconds,
    ] = []) => {
      if (syncingRemoteSettings) {
        return;
      }

      // 本地模式下改设置立即重建棋盘；联机模式下设置以房间配置为准。
      const normalized = normalizeAppGameSettings({
        playerCount,
        gridSize,
        startPlayer,
        turnTimerEnabled,
        turnTimeLimitSeconds,
      });
      selectedPlayerCount.value = normalized.playerCount;
      selectedGridSize.value = normalized.gridSize;
      selectedStartPlayer.value = normalized.startPlayer;
      selectedTurnTimerEnabled.value = normalized.turnTimerEnabled;
      selectedTurnTimeLimitSeconds.value = normalized.turnTimeLimitSeconds;
      syncSession();

      if (roomStatus.value === "solo" && controller.value) {
        gameState.value = controller.value.setGameConfig(normalized, true);
        return;
      }

      if (isHost.value && roomStatus.value !== "solo" && roomStatus.value !== "inProgress" && roomStatus.value !== "countdown") {
        const settingsChanged = normalized.playerCount !== previousPlayerCount
          || normalized.gridSize !== previousGridSize
          || normalized.turnTimerEnabled !== previousTurnTimerEnabled
          || normalized.turnTimeLimitSeconds !== previousTurnTimeLimitSeconds;
        const starterChanged = normalized.startPlayer !== previousStartPlayer;

        if (settingsChanged) {
          void networkManager.updateRoomSettings(normalized).catch(handleNetworkError);
        } else if (starterChanged) {
          void networkManager.updateStartPlayer(normalized.startPlayer).catch(handleNetworkError);
        }
      }
    });

    watch(() => gameState.value.gameOver, (isGameOver) => {
      if (!isGameOver) {
        resultModalDismissed.value = false;
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
          startPlayer: selectedStartPlayer.value,
          turnTimerEnabled: selectedTurnTimerEnabled.value,
          turnTimeLimitSeconds: selectedTurnTimeLimitSeconds.value,
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
    const isHost = computed(() => Boolean(session.value.playerId && roomInfo.value.hostPlayerId === session.value.playerId));
    const boardDockBadge = computed(() => (
      language.value === "en"
        ? `${selectedPlayerCount.value}P / ${selectedGridSize.value}`
        : `${selectedPlayerCount.value}人 / ${selectedGridSize.value}`
    ));
    const networkDockBadge = computed(() => {
      if (session.value.roomId) {
        return `#${session.value.roomId}`;
      }

      return getAppTexts(language.value).localShort;
    });
    const localReady = computed(() => {
      return Boolean(
        session.value.playerId
          && roomInfo.value.players?.some((player) => player.playerId === session.value.playerId && player.ready),
      );
    });
    const starterOptions = computed(() => {
      const sourcePlayers = Array.isArray(roomInfo.value.players) && roomInfo.value.players.length
        ? roomInfo.value.players.map((player) => player.color)
        : [Player.BLACK, Player.WHITE, Player.PURPLE].slice(0, selectedPlayerCount.value);
      return sourcePlayers.map((color) => ({
        value: color,
        label: formatAppPlayerName(color, language.value),
      }));
    });

    const currentGameSettings = () => ({
      playerCount: selectedPlayerCount.value,
      gridSize: selectedGridSize.value,
      startPlayer: selectedStartPlayer.value,
      turnTimerEnabled: selectedTurnTimerEnabled.value,
      turnTimeLimitSeconds: selectedTurnTimeLimitSeconds.value,
    });

    const effectiveGameSettings = computed(() => (
      roomStatus.value === "solo"
        ? normalizeAppGameSettings(currentGameSettings())
        : normalizeAppGameSettings(roomInfo.value.settings)
    ));
    const turnTimerEnabled = computed(() => effectiveGameSettings.value.turnTimerEnabled);
    const turnTimeLimitSeconds = computed(() => effectiveGameSettings.value.turnTimeLimitSeconds);

    const applySettingsToController = (settings, reset = true) => {
      const normalized = normalizeAppGameSettings(settings);
      syncingRemoteSettings = true;
      try {
        // 远端同步设置时先打标记，避免 watch 把这次被动更新误判为用户主动修改。
        selectedPlayerCount.value = normalized.playerCount;
        selectedGridSize.value = normalized.gridSize;
        selectedStartPlayer.value = normalized.startPlayer;
        selectedTurnTimerEnabled.value = normalized.turnTimerEnabled;
        selectedTurnTimeLimitSeconds.value = normalized.turnTimeLimitSeconds;
        syncSession();

        if (!controller.value) {
          return;
        }

        controller.value.setGameConfig(normalized, reset);
      } finally {
        syncingRemoteSettings = false;
      }
    };

    const clearReconnectTimer = () => {
      if (reconnectTimerId !== null) {
        globalThis.clearTimeout(reconnectTimerId);
        reconnectTimerId = null;
      }
    };

    const clearTurnCountdown = () => {
      if (turnCountdownTimerId !== null) {
        globalThis.clearInterval(turnCountdownTimerId);
        turnCountdownTimerId = null;
      }
    };

    const restartTurnCountdown = () => {
      clearTurnCountdown();
      turnCountdown.value = ROOM_START_COUNTDOWN_FALLBACK_SECONDS;

      if (
        gameState.value.gameOver
        || overlayResult.value
        || roomStatus.value === "waiting"
        || roomStatus.value === "lobby"
        || roomStatus.value === "offline"
      ) {
        return;
      }

      if (roomStatus.value === "countdown") {
        turnCountdown.value = Math.max(
          0,
          Math.ceil(((roomInfo.value.countdownEndsAt ?? Date.now()) - Date.now()) / 1000),
        );
        turnCountdownTimerId = globalThis.setInterval(() => {
          turnCountdown.value = Math.max(
            0,
            Math.ceil(((roomInfo.value.countdownEndsAt ?? Date.now()) - Date.now()) / 1000),
          );
        }, 250);
        return;
      }

      turnCountdownTimerId = globalThis.setInterval(() => {
        if (turnCountdown.value > 0) {
          turnCountdown.value -= 1;
        }
      }, 1000);
    };

    const clearTurnTimer = () => {
      if (turnTimerId !== null) {
        globalThis.clearInterval(turnTimerId);
        turnTimerId = null;
      }
      turnTimerDeadline = 0;
      turnTimerRemaining.value = 0;
    };

    const shouldRunTurnTimer = () => {
      if (!turnTimerEnabled.value || !controller.value) {
        return false;
      }

      if (
        gameState.value.gameOver
        || overlayResult.value
        || roomStatus.value === "waiting"
        || roomStatus.value === "lobby"
        || roomStatus.value === "offline"
        || roomStatus.value === "countdown"
      ) {
        return false;
      }

      if (roomStatus.value === "solo") {
        return true;
      }

      return roomStatus.value === "inProgress" && gameState.value.isLocalTurn;
    };

    const updateTurnTimerRemaining = () => {
      if (!turnTimerDeadline) {
        turnTimerRemaining.value = 0;
        return;
      }

      turnTimerRemaining.value = Math.max(
        0,
        Math.ceil((turnTimerDeadline - Date.now()) / 1000),
      );
    };

    const triggerTimedSkip = () => {
      if (turnTimerSkipInFlight) {
        return;
      }

      turnTimerSkipInFlight = true;
      clearTurnTimer();
      void Promise.resolve(handleSkip()).finally(() => {
        turnTimerSkipInFlight = false;
      });
    };

    const restartTurnTimer = () => {
      clearTurnTimer();

      if (!shouldRunTurnTimer()) {
        return;
      }

      turnTimerDeadline = Date.now() + turnTimeLimitSeconds.value * 1000;
      updateTurnTimerRemaining();
      turnTimerId = globalThis.setInterval(() => {
        updateTurnTimerRemaining();
        if (turnTimerRemaining.value <= 0) {
          triggerTimedSkip();
        }
      }, 250);
    };

    watch(
      () => [
        gameState.value.turnCount,
        gameState.value.currentPlayer,
        gameState.value.gameOver,
        Boolean(overlayResult.value),
        roomStatus.value,
        roomInfo.value.countdownEndsAt,
      ],
      () => {
        restartTurnCountdown();
      },
      { immediate: true },
    );

    watch(
      () => [
        gameState.value.turnCount,
        gameState.value.currentPlayer,
        gameState.value.gameOver,
        gameState.value.isLocalTurn,
        Boolean(overlayResult.value),
        roomStatus.value,
        turnTimerEnabled.value,
        turnTimeLimitSeconds.value,
      ],
      () => {
        restartTurnTimer();
      },
      { immediate: true },
    );

    const handleNetworkError = (error) => {
      networkError.value = localizeAppErrorMessage(error?.message ?? String(error), language.value);
    };

    const applyRoomPayload = (payload) => {
      const nextStatus = normalizeRoomStatus(payload?.status ?? roomStatus.value);
      roomStatus.value = nextStatus || roomStatus.value;
      roomInfo.value = {
        ...createEmptyRoomInfo(),
        status: nextStatus || roomInfo.value.status,
        hostPlayerId: payload?.hostPlayerId ?? roomInfo.value.hostPlayerId,
        players: Array.isArray(payload?.players) ? payload.players : roomInfo.value.players,
        settings: normalizeAppGameSettings(payload?.settings ?? roomInfo.value.settings),
        countdownEndsAt: payload?.countdownEndsAt ?? null,
      };
      resultModalDismissed.value = false;
    };

    const resetRoomContext = () => {
      roomStatus.value = "solo";
      roomInfo.value = createEmptyRoomInfo();
      roomIdInput.value = "";
      overlayResult.value = null;
      resultModalDismissed.value = false;
    };

    const syncControllerState = (partial) => {
      if (!controller.value) {
        return;
      }
      gameState.value = controller.value.setMultiplayerState(partial);
    };

    const syncOnlineController = (payload = null) => {
      if (!controller.value) {
        return;
      }

      const normalizedSettings = normalizeAppGameSettings(payload?.settings ?? roomInfo.value.settings);
      const players = Array.isArray(payload?.players) ? payload.players : roomInfo.value.players;
      const normalizedStatus = normalizeRoomStatus(payload?.status ?? roomStatus.value);
      const everyoneConnected = Array.isArray(players)
        && players.length >= normalizedSettings.playerCount
        && players.every((player) => player.connected);

      gameState.value = controller.value.enableMultiplayer({
        networkManager,
        localPlayer: payload?.yourColor ?? payload?.color ?? session.value.color,
        roomReady: normalizedStatus === "inProgress",
        opponentConnected: everyoneConnected,
      });
    };

    const applyRoomSnapshot = (payload, resetController = true) => {
      applyRoomPayload(payload);
      roomIdInput.value = payload?.roomId ?? roomIdInput.value;
      applySettingsToController(payload?.settings ?? payload?.matchState?.settings ?? currentGameSettings(), resetController);
      syncSession();
      syncOnlineController(payload);

      if (payload?.matchState && controller.value) {
        gameState.value = controller.value.restoreMatchState(payload.matchState);
      }

      reconnectAttempt = 0;
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
        applyRoomSnapshot(payload, true);
        networkError.value = "";
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
        resetRoomContext();
        connectionState.value = "idle";
        await networkManager.leaveRoom();
        networkManager.disconnect(1000, "logout");
        networkManager.clearAuthToken();
        networkManager.url = null;
        networkManager.roomId = null;
        networkManager.playerId = null;
        networkManager.color = null;
        if (controller.value) {
          controller.value.disableMultiplayer();
          gameState.value = controller.value.resetGame({ force: true });
        }
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
      resultModalDismissed.value = false;
      overlayResult.value = null;
      clearReconnectTimer();

      try {
        await ensureConnected();
        const payload = await networkManager.createRoom(currentGameSettings());
        applyRoomSnapshot(payload, true);
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
        applyRoomSnapshot(payload, true);
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
      resultModalDismissed.value = false;
      clearReconnectTimer();

      try {
        await networkManager.leaveRoom();
        resetRoomContext();
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
        gameState.value = controller.value.resetGame();
        overlayResult.value = null;
        resultModalDismissed.value = false;
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

    const handleToggleReady = async (ready) => {
      if (!session.value.roomId) {
        return;
      }

      networkBusy.value = true;
      networkError.value = "";
      try {
        await networkManager.sendReady(ready);
      } catch (error) {
        handleNetworkError(error);
      } finally {
        networkBusy.value = false;
      }
    };

    const handleStartPlayerChange = (value) => {
      selectedStartPlayer.value = value;
    };

    const handleClosePrompt = () => {
      if (overlayResult.value?.resetAfterClose && controller.value) {
        gameState.value = controller.value.resetGame();
      }
      overlayResult.value = null;
      resultModalDismissed.value = true;
    };

    const statusText = computed(() => {
      const texts = getAppTexts(language.value);
      if (roomStatus.value === "waiting") {
        return texts.waitingStatus(session.value.roomId);
      }

      if (roomStatus.value === "lobby") {
        return texts.lobbyStatus;
      }

      if (roomStatus.value === "countdown") {
        return texts.countdownStatus(turnCountdown.value);
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

      if (roomStatus.value === "inProgress") {
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

      if (roomStatus.value === "lobby" || roomStatus.value === "countdown") {
        return texts.roomNeedReady;
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

    const readyDisabled = computed(() => {
      return !session.value.roomId
        || networkBusy.value
        || roomStatus.value === "waiting"
        || roomStatus.value === "offline"
        || roomStatus.value === "inProgress"
        || roomStatus.value === "countdown";
    });
    const starterLocked = computed(() => !isHost.value || networkBusy.value || roomStatus.value === "inProgress" || roomStatus.value === "countdown");
    const showClosePrompt = computed(() => Boolean(overlayResult.value || (gameState.value.gameOver && !resultModalDismissed.value)));

    const resetLabel = computed(() => {
      const texts = getAppTexts(language.value);
      if (roomStatus.value === "solo") {
        return gameState.value.gameOver ? texts.startNewSolo : texts.resetBoard;
      }

      return gameState.value.gameOver ? texts.startNextOnline : texts.resignAndRestart;
    });

    const settingsLocked = computed(() => {
      if (networkBusy.value) {
        return true;
      }
      if (roomStatus.value === "solo") {
        return false;
      }
      return !isHost.value || roomStatus.value === "inProgress" || roomStatus.value === "countdown";
    });

    const resultResetAllowed = computed(() => {
      return !resetDisabled.value;
    });

    watch(showClosePrompt, (promptVisible) => {
      document.body.classList.toggle("modal-open", Boolean(promptVisible));
    }, { immediate: true });

    const handleEscapeKeydown = (event) => {
      if (event.key !== "Escape") {
        return;
      }

      if (showClosePrompt.value) {
        handleClosePrompt();
      }
    };

    const handleResultAction = async () => {
      if (overlayResult.value) {
        if (overlayResult.value.resetAfterClose && controller.value) {
          gameState.value = controller.value.resetGame();
        }
        overlayResult.value = null;
        return;
      }

      if (session.value.roomId && gameState.value.gameOver) {
        overlayResult.value = null;
        resultModalDismissed.value = true;
      }
      await handleReset();
    };

    const handleResultLeaveRoom = async () => {
      overlayResult.value = null;
      resultModalDismissed.value = true;
      await handleLeaveRoom();
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
        applyRoomSnapshot(payload, true);
      }),
    );

    unsubscribers.push(
      networkManager.on(ServerEvent.ROOM_JOINED, (payload) => {
        applyRoomSnapshot(payload, true);
      }),
    );

    unsubscribers.push(
      networkManager.on(ServerEvent.ROOM_STATE, (payload) => {
        applyRoomSnapshot(payload, true);
        if (payload?.reason === "settings_updated") {
          networkError.value = getAppTexts(language.value).roomSettingsChanged;
        }
      }),
    );

    unsubscribers.push(
      networkManager.on(ServerEvent.ROOM_COUNTDOWN, (payload) => {
        applyRoomSnapshot(payload, true);
      }),
    );

    unsubscribers.push(
      networkManager.on(ServerEvent.ROOM_READY, (payload) => {
        networkError.value = "";
        applyRoomSnapshot(payload, true);
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
        resultModalDismissed.value = false;
        applyRoomSnapshot(payload, true);
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
      clearTurnCountdown();
      clearTurnTimer();
      document.body.classList.remove("modal-open");
      globalThis.removeEventListener("keydown", handleEscapeKeydown);
      for (const unsubscribe of unsubscribers) {
        if (typeof unsubscribe === "function") {
          unsubscribe();
        }
      }
      networkManager.disconnect();
    });

    onMounted(() => {
      globalThis.addEventListener("keydown", handleEscapeKeydown);
      if (storedAuth.token && normalizedStoredSession.roomId && normalizedStoredSession.playerId && normalizedStoredSession.url) {
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
      boardDockBadge,
      controller,
      gameState,
      getTexts: getAppTexts,
      isAuthenticated,
      language,
      networkDockBadge,
      serverUrl,
      roomIdInput,
      selectedPlayerCount,
      selectedGridSize,
      selectedStartPlayer,
      selectedTurnTimerEnabled,
      selectedTurnTimeLimitSeconds,
      session,
      connectionState,
      roomStatus,
      roomInfo,
      isHost,
      localReady,
      readyDisabled,
      starterLocked,
      starterOptions,
      showClosePrompt,
      networkBusy,
      networkError,
      overlayResult,
      statusText,
      boardHint,
      skipDisabled,
      resetDisabled,
      resetLabel,
      settingsLocked,
      turnTimerEnabled,
      turnTimerRemaining,
      resultResetAllowed,
      handleResultAction,
      handleResultLeaveRoom,
      handleControllerReady,
      handleAuthSubmit,
      handleLogout,
      handleStateChange,
      handleConnect,
      handleCreateRoom,
      handleJoinRoom,
      handleLeaveRoom,
      handleToggleReady,
      handleStartPlayerChange,
      handleSkip,
      handleReset,
      handleClosePrompt,
    };
  },
  template: `
    <main class="app-shell app-shell-focus">
      <section class="stage-layout">
        <section class="board-column">
          <header class="stage-heading">
            <h1 class="stage-title">{{ getTexts(language).heroTitle }}</h1>
          </header>

          <BoardCanvas
            :language="language"
            :hint-text="boardHint"
            @controller-ready="handleControllerReady"
            @state-change="handleStateChange"
          />

          <ControlPanel
            :game-state="gameState"
            :language="language"
            :skip-disabled="skipDisabled"
            :reset-disabled="resetDisabled"
            :reset-label="resetLabel"
            :session="session"
            :room-players="roomInfo.players"
            :turn-timer-enabled="turnTimerEnabled"
            :turn-timer-remaining="turnTimerRemaining"
            @skip="handleSkip"
            @reset="handleReset"
          />
        </section>

        <aside class="dock-column">
          <DockDirectory
            variant="board"
            :title="getTexts(language).boardDockTitle"
            :badge="boardDockBadge"
          >
            <div class="dock-stack">
              <SetupPanel
                :language="language"
                :player-count="selectedPlayerCount"
                :grid-size="selectedGridSize"
                :turn-timer-enabled="selectedTurnTimerEnabled"
                :turn-time-limit-seconds="selectedTurnTimeLimitSeconds"
                :settings-locked="settingsLocked"
                :busy="networkBusy"
                @update:language="language = $event"
                @update:player-count="selectedPlayerCount = $event"
                @update:grid-size="selectedGridSize = $event"
                @update:turn-timer-enabled="selectedTurnTimerEnabled = $event"
                @update:turn-time-limit-seconds="selectedTurnTimeLimitSeconds = $event"
              />

              <ScorePanel
                :game-state="gameState"
                :session="session"
                :room-players="roomInfo.players"
                :language="language"
                :status-text="statusText"
              />
            </div>
          </DockDirectory>

          <DockDirectory
            variant="network"
            :title="getTexts(language).networkDockTitle"
            :badge="networkDockBadge"
          >
            <div class="dock-stack">
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
                :room-info="roomInfo"
                :is-host="isHost"
                :local-ready="localReady"
                :ready-disabled="readyDisabled"
                :starter-locked="starterLocked"
                :start-player="selectedStartPlayer"
                :starter-options="starterOptions"
                :show-close-prompt="showClosePrompt"
                @update:server-url="serverUrl = $event"
                @update:room-id="roomIdInput = $event"
                @connect="handleConnect"
                @create-room="handleCreateRoom"
                @join-room="handleJoinRoom"
                @leave-room="handleLeaveRoom"
                @toggle-ready="handleToggleReady"
                @update:start-player="handleStartPlayerChange"
                @close-prompt="handleClosePrompt"
              />
            </div>
          </DockDirectory>
        </aside>
      </section>

      <ResultModal
        :language="language"
        :game-state="gameState"
        :allow-reset="resultResetAllowed"
        :session="session"
        :room-players="roomInfo.players"
        :overlay-result="overlayResult"
        :visible="showClosePrompt"
        :reset-label="resetLabel"
        :close-label="getTexts(language).closePrompt"
        @action="handleResultAction"
        @leave="handleResultLeaveRoom"
        @close="handleClosePrompt"
      />
    </main>
  `,
};

export default App;






