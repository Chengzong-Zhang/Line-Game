import GameController from "./GameController.js?v=20260428k";
import { Player } from "./GameEngine.js?v=20260421c";
import NetworkManager, { ClientEvent, ServerEvent, resolveWebSocketUrl } from "./NetworkManager.js?v=20260429b";
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
} from "./OnlineAppState.js?v=20260428l";
import {
  formatArea as formatAppArea,
  formatConnectionState as formatAppConnectionState,
  formatFinalScoreLine as formatAppFinalScoreLine,
  formatPlayerName as formatAppPlayerName,
  formatResetVoteMessage as formatAppResetVoteMessage,
  formatWinner as formatAppWinner,
  getInitialLanguage as getAppInitialLanguage,
  getInitialUiStyle as getAppInitialUiStyle,
  getTexts as getAppTexts,
  UI_STYLE_STORAGE_KEY,
  UI_STYLE_ACADEMIC,
  localizeErrorMessage as localizeAppErrorMessage,
} from "./OnlineAppI18n.js?v=20260428l";
import { ensureGuideRuleImages, getGuideMarkdown, getGuideMarkdownAsset, parseGuideMarkdown } from "./GuideContent.js?v=20260429a";

const {
  computed,
  nextTick,
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
    if (/^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(parsed.hostname) && parsed.port && parsed.port !== "8000") {
      return dynamicUrl;
    }
    return parsed.toString();
  } catch {
    return dynamicUrl;
  }
}

function getLocalWebSocketFallbacks(url) {
  try {
    const parsed = new URL(url, globalThis.location?.href ?? "http://localhost:8000/");
    if (!/^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(parsed.hostname)) {
      return [];
    }

    const ports = ["8000", "8001", "8002", "8003", "8004"].filter((port) => port !== parsed.port);
    return ports.map((port) => {
      const fallback = new URL(parsed.toString());
      fallback.port = port;
      fallback.pathname = "/ws";
      fallback.search = "";
      fallback.hash = "";
      return fallback.toString();
    });
  } catch {
    return [];
  }
}

function getLocalApiFallbacks(serverUrl) {
  try {
    const parsed = new URL(resolveApiBaseUrl(serverUrl), globalThis.location?.href ?? "http://localhost:8000/");
    if (!/^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(parsed.hostname)) {
      return [];
    }

    return ["8000", "8001", "8002", "8003", "8004"]
      .filter((port) => port !== parsed.port)
      .map((port) => {
        const fallback = new URL(parsed.toString());
        fallback.port = port;
        fallback.pathname = "";
        fallback.search = "";
        fallback.hash = "";
        return fallback.toString().replace(/\/$/, "");
      });
  } catch {
    return [];
  }
}

async function postAuthJson(serverUrl, path, payload) {
  const request = async (apiBaseUrl) => fetch(`${apiBaseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  let activeApiBaseUrl = resolveApiBaseUrl(serverUrl);
  let response = await request(activeApiBaseUrl);

  if ([404, 405, 501].includes(response.status)) {
    for (const fallbackApiBaseUrl of getLocalApiFallbacks(serverUrl)) {
      try {
        const fallbackResponse = await request(fallbackApiBaseUrl);
        if (!fallbackResponse.ok && [404, 405, 501].includes(fallbackResponse.status)) {
          response = fallbackResponse;
          continue;
        }
        response = fallbackResponse;
        activeApiBaseUrl = fallbackApiBaseUrl;
        break;
      } catch {
        continue;
      }
    }
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new Error(data?.detail ?? `HTTP ${response.status}`);
  }

  return {
    ...data,
    apiBaseUrl: activeApiBaseUrl,
  };
}

const ROOM_START_COUNTDOWN_FALLBACK_SECONDS = 20;
const SERVER_TIMESTAMP_TOLERANCE_MS = 1000;
const CHAT_EMOJI_OPTIONS = Object.freeze([
  { content: "👏", animation: "bounce", duration: 1200, label: "Nice" },
  { content: "🔥", animation: "bounce", duration: 1200, label: "Hot" },
  { content: "😎", animation: "bounce", duration: 1200, label: "Cool" },
  { content: "🤝", animation: "fade", duration: 1400, label: "Respect" },
  { content: "❓", animation: "shake", duration: 1000, label: "Question" },
  { content: "🤔", animation: "fade", duration: 1400, label: "Thinking" },
  { content: "💀", animation: "shake", duration: 1100, label: "Defeated" },
  { content: "🤯", animation: "shake", duration: 1200, label: "Mind blown" },
  { content: "🏳", animation: "fade", duration: 1300, label: "Surrender" },
  { content: "😤", animation: "bounce", duration: 1200, label: "Pressure" },
]);
const CHAT_EMOJI_ANIMATIONS = new Set(["bounce", "fade", "shake"]);

function createEmptyRoomInfo() {
  return {
    status: "solo",
    hostPlayerId: null,
    players: [],
    settings: normalizeAppGameSettings(),
    countdownEndsAt: null,
    matchPhase: "solo",
  };
}

function normalizeRoomStatus(status) {
  const normalized = String(status ?? "").trim().toLowerCase();
  if (normalized === "in_progress") {
    return "inProgress";
  }
  return normalized || "solo";
}

function normalizeMatchPhase(phase, fallbackStatus = "solo") {
  const normalizedStatus = normalizeRoomStatus(fallbackStatus);
  if (normalizedStatus === "inProgress") {
    return "PLAYING";
  }
  if (normalizedStatus === "countdown") {
    return "READY_TO_START";
  }
  if (normalizedStatus === "waiting") {
    return "WAITING_FOR_PLAYERS";
  }
  if (normalizedStatus === "lobby") {
    return "LOBBY";
  }
  const normalized = String(phase ?? "").trim().toUpperCase();
  if (["PLAYING", "READY_TO_START", "WAITING_FOR_PLAYERS", "LOBBY", "SOLO"].includes(normalized)) {
    return normalized;
  }
  return "SOLO";
}

function readPayloadMatchPhase(payload, fallbackPhase) {
  return payload?.matchPhase
    ?? payload?.match_phase
    ?? payload?.matchState?.phase
    ?? payload?.match_state?.phase
    ?? fallbackPhase;
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

function resolveOnlinePlayerName(roomPlayers, color, language, uiStyle) {
  const player = findRoomPlayerByColor(roomPlayers, color);
  const roleLabel = formatAppPlayerName(color, language, uiStyle);
  const identity = player?.username ?? player?.playerId ?? "";

  if (!identity) {
    return roleLabel;
  }

  return uiStyle === UI_STYLE_ACADEMIC ? `${roleLabel} / ${identity}` : identity;
}

function buildNamedScoreEntries(scores, players, roomPlayers, language, uiStyle) {
  const activePlayers = Array.isArray(players) && players.length
    ? players
    : [Player.BLACK, Player.WHITE];

  return activePlayers
    .filter((player) => scores && Object.prototype.hasOwnProperty.call(scores, player))
    .map((player) => ({
      key: player,
      color: player,
      name: resolveOnlinePlayerName(roomPlayers, player, language, uiStyle),
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
    uiStyle: {
      type: String,
      required: true,
    },
    statusText: {
      type: String,
      default: "",
    },
  },
  setup(props) {
    const texts = computed(() => getAppTexts(props.language, props.uiStyle));
    const isOnlineMatch = computed(() => Boolean(props.session?.roomId));
    const currentPlayerLabel = computed(() => (
      isOnlineMatch.value
        ? resolveOnlinePlayerName(props.roomPlayers, props.gameState.currentPlayer, props.language, props.uiStyle)
        : formatAppPlayerName(props.gameState.currentPlayer, props.language, props.uiStyle)
    ));
    const localRoleLabel = computed(() => formatAppPlayerName(props.session.color, props.language, props.uiStyle));
    const winnerLabel = computed(() => formatAppWinner(props.gameState.winner, props.language, props.uiStyle));
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
          name: resolveOnlinePlayerName(props.roomPlayers, player, props.language, props.uiStyle),
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
    "update:ui-style",
    "update:turn-timer-enabled",
    "update:turn-time-limit-seconds",
  ],
  props: {
    language: {
      type: String,
      required: true,
    },
    uiStyle: {
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
    const texts = computed(() => getAppTexts(props.language, props.uiStyle));

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
        <h2>{{ texts.setupLabel }}</h2>
        <span class="panel-head-badge" v-if="settingsLocked">{{ texts.lockedLabel }}</span>
      </div>

      <div class="settings-cluster settings-cluster-standalone">
        <div class="settings-grid">
          <div>
            <label class="field-label">{{ texts.languageLabel }}</label>
            <div id="language-select" class="language-switcher language-switcher-inline" role="group" :aria-label="texts.languageLabel">
              <button
                class="language-button"
                :class="{ 'is-active': language === 'zh' }"
                :disabled="busy"
                @click="$emit('update:language', 'zh')"
              >
                {{ texts.languageZhAction }}
              </button>
              <button
                class="language-button"
                :class="{ 'is-active': language === 'en' }"
                :disabled="busy"
                @click="$emit('update:language', 'en')"
              >
                {{ texts.languageEnAction }}
              </button>
            </div>
          </div>
          <div>
            <label class="field-label">{{ texts.uiStyleLabel }}</label>
            <div id="ui-style-select" class="language-switcher language-switcher-inline" role="group" :aria-label="texts.uiStyleLabel">
              <button
                class="language-button"
                :class="{ 'is-active': uiStyle === 'casual' }"
                :disabled="busy"
                @click="$emit('update:ui-style', 'casual')"
              >
                {{ texts.uiStyleCasualAction }}
              </button>
              <button
                class="language-button"
                :class="{ 'is-active': uiStyle === 'academic' }"
                :disabled="busy"
                @click="$emit('update:ui-style', 'academic')"
              >
                {{ texts.uiStyleAcademicAction }}
              </button>
            </div>
          </div>
          <div>
            <label class="field-label" for="player-count">{{ texts.playerCountLabel }}</label>
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
          <div class="settings-grid-item-wide">
            <label id="grid-size-label" class="field-label">{{ texts.gridSizeLabel }}</label>
            <div
              id="grid-size"
              class="board-choice-grid board-choice-grid-size"
              role="radiogroup"
              aria-labelledby="grid-size-label"
            >
              <button
                v-for="size in GRID_SIZE_OPTIONS"
                :key="size"
                type="button"
                class="board-choice-option board-choice-size"
                :class="{ 'is-active': gridSize === size }"
                role="radio"
                :aria-checked="gridSize === size"
                :disabled="busy || settingsLocked"
                @click="$emit('update:grid-size', size)"
              >
                {{ size }}
              </button>
            </div>
          </div>
          <div>
            <label class="field-label" for="turn-timer-enabled">{{ texts.turnTimerLabel }}</label>
            <label class="toggle-field" for="turn-timer-enabled">
              <input
                id="turn-timer-enabled"
                type="checkbox"
                :checked="turnTimerEnabled"
                :disabled="busy || settingsLocked"
                @change="$emit('update:turn-timer-enabled', $event.target.checked)"
              />
              <span>{{ turnTimerEnabled ? texts.toggleOn : texts.toggleOff }}</span>
            </label>
          </div>
          <div v-if="turnTimerEnabled">
            <label class="field-label" for="turn-time-limit">{{ texts.turnTimerDurationLabel }}</label>
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
    uiStyle: {
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
    const texts = computed(() => getAppTexts(props.language, props.uiStyle));
    const isAuthenticated = computed(() => Boolean(props.auth?.token && props.auth?.username));

    return {
      texts,
      isAuthenticated,
    };
  },
  template: `
    <section class="panel panel-auth modal-panel">
      <div class="panel-head panel-head-inline">
        <h2>{{ texts.authTitle }}</h2>
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
    "update:room-id",
  ],
  props: {
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
    uiStyle: {
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
    const texts = computed(() => getAppTexts(props.language, props.uiStyle));
    const roleLabel = computed(() => formatAppPlayerName(props.session.color, props.language, props.uiStyle));
    const connectionLabel = computed(() => formatAppConnectionState(props.connectionState, props.language, props.uiStyle));
    const roomStatusLabel = computed(() => formatAppConnectionState(props.roomStatus, props.language, props.uiStyle));
    const roomPlayers = computed(() => Array.isArray(props.roomInfo?.players) ? props.roomInfo.players : []);
    const roomPlayerName = (player) => resolveOnlinePlayerName(props.roomInfo?.players, player?.color, props.language, props.uiStyle);
    const roomPlaying = computed(() => props.roomStatus === "inProgress" || props.roomInfo?.matchPhase === "PLAYING");
    const getStarterOptionClass = (option) => ({
      "is-active": option.value === props.startPlayer,
      "is-blue": option.value === Player.BLACK,
      "is-red": option.value === Player.WHITE,
      "is-purple": option.value === Player.PURPLE,
    });
    const readyActionLabel = computed(() => (
      roomPlaying.value
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
      if (roomPlaying.value) {
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
      roomPlaying,
      getPlayerAccentClass,
      readyActionLabel,
      resolvePlayerState,
      roomPlayerName,
      getStarterOptionClass,
    };
  },
  template: `
    <section class="panel panel-network modal-panel">
      <div class="panel-head panel-head-inline">
        <h2>{{ texts.onlineMatch }}</h2>
        <span class="panel-head-badge">{{ roomStatusLabel }}</span>
      </div>

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
          <h3>{{ texts.roomPlayers }}</h3>
        </div>

        <div class="status-pill-row room-action-row">
          <span
            v-if="roomStatus === 'inProgress' || roomInfo?.matchPhase === 'PLAYING'"
            class="status-pill status-pill-live"
          >{{ texts.inProgress }}</span>
          <button
            v-else
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
            <h3>{{ texts.starterLabel }}</h3>
          </div>
          <label id="room-starter-label" class="field-label">{{ texts.starterLabel }}</label>
          <div
            id="room-starter"
            class="board-choice-grid board-choice-grid-player"
            role="radiogroup"
            aria-labelledby="room-starter-label"
          >
            <button
              v-for="option in starterOptions"
              :key="option.value"
              type="button"
              class="board-choice-option board-choice-player"
              :class="getStarterOptionClass(option)"
              role="radio"
              :aria-checked="startPlayer === option.value"
              :disabled="starterLocked"
              @click="$emit('update:start-player', option.value)"
            >
              <span class="board-choice-stone" aria-hidden="true"></span>
              {{ option.label }}
            </button>
          </div>
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
  emits: ["skip", "reset", "emoji"],
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
    emojiOptions: {
      type: Array,
      default: () => [],
    },
    emojiDisabled: {
      type: Boolean,
      default: true,
    },
    language: {
      type: String,
      required: true,
    },
    uiStyle: {
      type: String,
      required: true,
    },
  },
  setup(props) {
    const texts = computed(() => getAppTexts(props.language, props.uiStyle));
    const currentPlayerLabel = computed(() => (
      props.session?.roomId
        ? resolveOnlinePlayerName(props.roomPlayers, props.gameState.currentPlayer, props.language, props.uiStyle)
        : formatAppPlayerName(props.gameState.currentPlayer, props.language, props.uiStyle)
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
        <p class="duel-label">{{ texts.currentTurnLabel }}</p>
        <div class="turn-banner duel-turn-banner" :class="turnBannerClass">
          <span class="turn-dot"></span>
          <strong>{{ currentPlayerLabel }}{{ texts.turnSuffix }}</strong>
          <small v-if="turnTimerEnabled" class="duel-timer-copy">{{ turnTimerLabel }}</small>
        </div>
      </div>
      <div class="actions duel-actions">
        <button class="action-button action-button-primary" :disabled="skipDisabled" @click="$emit('skip')">
          {{ texts.skipTurnAction }}
        </button>
        <button class="action-button action-button-secondary" :disabled="resetDisabled" @click="$emit('reset')">
          {{ resetLabel }}
        </button>
      </div>
      <div v-if="emojiOptions.length" class="chat-emoji-toolbar" role="group" aria-label="chat emoji">
        <button
          v-for="emoji in emojiOptions"
          :key="emoji.content"
          type="button"
          class="chat-emoji-button"
          :title="emoji.label"
          :disabled="emojiDisabled"
          @click="$emit('emoji', emoji)"
        >
          {{ emoji.content }}
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
    uiStyle: {
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
    const texts = computed(() => getAppTexts(props.language, props.uiStyle));
    const isOnlineSettlement = computed(() => Boolean(props.session?.roomId && props.session?.color));
    const resolvedWinner = computed(() => props.overlayResult?.winner ?? props.gameState.winner);
    const localPlayerName = computed(() => (
      isOnlineSettlement.value
        ? resolveOnlinePlayerName(props.roomPlayers, props.session.color, props.language, props.uiStyle)
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
        return formatAppWinner(props.overlayResult.winner, props.language, props.uiStyle);
      }
      return formatAppWinner(props.gameState.winner, props.language, props.uiStyle);
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
        props.uiStyle,
      );
    });
    const summary = computed(() => {
      if (props.overlayResult?.scoreLine) {
        return props.overlayResult.scoreLine;
      }
      if (props.overlayResult) {
        return texts.value.resignedSummary(
          resolveOnlinePlayerName(props.roomPlayers, props.overlayResult.winner, props.language, props.uiStyle),
          resolveOnlinePlayerName(props.roomPlayers, props.overlayResult.loser, props.language, props.uiStyle),
        );
      }
      return formatAppFinalScoreLine(props.gameState.scores, props.language, props.gameState.players, props.uiStyle);
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

const GuideBoardIllustration = {
  name: "GuideBoardIllustration",
  template: `
    <section class="guide-illustration-card" aria-hidden="true">
      <svg class="guide-illustration-svg" viewBox="0 0 520 420" focusable="false">
        <defs>
          <linearGradient id="guide-board-glow" x1="0%" x2="100%" y1="0%" y2="100%">
            <stop offset="0%" stop-color="#fff8ea" />
            <stop offset="100%" stop-color="#edd7b6" />
          </linearGradient>
          <linearGradient id="guide-blue-territory" x1="0%" x2="100%" y1="0%" y2="100%">
            <stop offset="0%" stop-color="rgba(70, 134, 255, 0.26)" />
            <stop offset="100%" stop-color="rgba(70, 134, 255, 0.06)" />
          </linearGradient>
          <linearGradient id="guide-red-territory" x1="100%" x2="0%" y1="0%" y2="100%">
            <stop offset="0%" stop-color="rgba(221, 90, 69, 0.24)" />
            <stop offset="100%" stop-color="rgba(221, 90, 69, 0.06)" />
          </linearGradient>
        </defs>
        <rect x="28" y="24" width="464" height="372" rx="28" fill="url(#guide-board-glow)" />
        <polygon points="116,86 404,86 260,336" fill="rgba(255,255,255,0.72)" stroke="rgba(91,70,46,0.2)" stroke-width="2" />
        <path d="M152 274 L260 86 L368 274" fill="none" stroke="rgba(91,70,46,0.14)" stroke-width="2" />
        <path d="M188 274 L260 149 L332 274" fill="none" stroke="rgba(91,70,46,0.14)" stroke-width="2" />
        <path d="M224 274 L260 212 L296 274" fill="none" stroke="rgba(91,70,46,0.14)" stroke-width="2" />
        <path d="M116 86 L260 336 L404 86" fill="none" stroke="rgba(91,70,46,0.14)" stroke-width="2" />
        <path d="M152 149 L368 149" fill="none" stroke="rgba(91,70,46,0.14)" stroke-width="2" />
        <path d="M188 212 L332 212" fill="none" stroke="rgba(91,70,46,0.14)" stroke-width="2" />
        <path d="M224 274 L296 274" fill="none" stroke="rgba(91,70,46,0.14)" stroke-width="2" />
        <polygon points="134,274 188,180 258,302 200,324" fill="url(#guide-blue-territory)" stroke="rgba(70, 134, 255, 0.42)" stroke-width="2" />
        <polygon points="386,274 332,180 264,302 320,324" fill="url(#guide-red-territory)" stroke="rgba(221, 90, 69, 0.42)" stroke-width="2" />
        <path d="M116 86 L188 212 L224 274" fill="none" stroke="#3e7df0" stroke-linecap="round" stroke-width="8" />
        <path d="M404 86 L332 212 L296 274" fill="none" stroke="#d7634f" stroke-linecap="round" stroke-width="8" />
        <path d="M188 212 L296 212" fill="none" stroke="#d7634f" stroke-linecap="round" stroke-width="8" />
        <path d="M224 274 L296 274" fill="none" stroke="#3e7df0" stroke-linecap="round" stroke-width="8" />
        <circle cx="116" cy="86" r="11" fill="#3e7df0" />
        <circle cx="188" cy="212" r="11" fill="#3e7df0" />
        <circle cx="224" cy="274" r="11" fill="#3e7df0" />
        <circle cx="404" cy="86" r="11" fill="#d7634f" />
        <circle cx="332" cy="212" r="11" fill="#d7634f" />
        <circle cx="296" cy="274" r="11" fill="#d7634f" />
        <circle cx="260" cy="212" r="12" fill="#e0a63e" stroke="#fff7e8" stroke-width="4" />
        <path d="M244 196 L276 228" stroke="#7a4b12" stroke-linecap="round" stroke-width="4" />
        <path d="M276 196 L244 228" stroke="#7a4b12" stroke-linecap="round" stroke-width="4" />
      </svg>
    </section>
  `,
};

function escapeGuideHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderGuideMathToken(value) {
  let rendered = escapeGuideHtml(String(value ?? "").trim());
  rendered = rendered.replace(/\\langle/g, "&lang;");
  rendered = rendered.replace(/\\rangle/g, "&rang;");
  rendered = rendered.replace(/\\rightarrow/g, "&rarr;");
  rendered = rendered.replace(/\\subseteq/g, "&sube;");
  rendered = rendered.replace(/\\cup/g, "&cup;");
  rendered = rendered.replace(/\\notin/g, "&notin;");
  rendered = rendered.replace(/\\mathcal\{([^}]+)\}/g, "<span class=\"guide-math-cal\">$1</span>");
  rendered = rendered.replace(/_\{([^}]+)\}/g, "<sub>$1</sub>");
  rendered = rendered.replace(/\^\\?\{([^}]+)\}/g, "<sup>$1</sup>");
  rendered = rendered.replace(/_([A-Za-z0-9*+-]+)/g, "<sub>$1</sub>");
  rendered = rendered.replace(/\^([A-Za-z0-9*+-]+)/g, "<sup>$1</sup>");
  return rendered;
}

function formatGuideInlineMath(value) {
  return `\\(${String(value ?? "").trim()}\\)`;
}

function formatGuideDisplayMath(value) {
  return `\\[${String(value ?? "").trim()}\\]`;
}

function highlightGuideCode(value, language = "") {
  const escaped = escapeGuideHtml(value);
  const normalizedLanguage = String(language ?? "").toLowerCase();
  if (!/^(py|python|js|javascript|ts|typescript)$/.test(normalizedLanguage)) {
    return escaped;
  }

  return escaped
    .replace(/\b(def|return|if|else|elif|for|while|in|not|and|or|class|const|let|var|function|new)\b/g, "<span class=\"guide-code-keyword\">$1</span>")
    .replace(/\b(True|False|None|Set|List|Tuple|dict|set|frozenset)\b/g, "<span class=\"guide-code-type\">$1</span>")
    .replace(/(&quot;.*?&quot;|'.*?')/g, "<span class=\"guide-code-string\">$1</span>")
    .replace(/(#.*)$/gm, "<span class=\"guide-code-comment\">$1</span>");
}

const GuideInlineText = {
  name: "GuideInlineText",
  props: {
    tokens: {
      type: Array,
      default: () => [],
    },
  },
  setup() {
    return {
      formatGuideInlineMath,
      renderGuideMathToken,
    };
  },
  template: `
    <template v-for="(token, index) in tokens" :key="index">
      <strong v-if="token.type === 'strong'">{{ token.text }}</strong>
      <span v-else-if="token.type === 'math'" class="guide-inline-math">{{ formatGuideInlineMath(token.text) }}</span>
      <code v-else-if="token.type === 'code'" class="guide-inline-code">{{ token.text }}</code>
      <span v-else>{{ token.text }}</span>
    </template>
  `,
};

const GuidePanel = {
  name: "GuidePanel",
  emits: ["open-entry"],
  props: {
    embedded: {
      type: Boolean,
      default: false,
    },
    language: {
      type: String,
      required: true,
    },
    uiStyle: {
      type: String,
      required: true,
    },
    ruleEntry: {
      type: Object,
      default: null,
    },
    whyEntry: {
      type: Object,
      default: null,
    },
    thanksEntry: {
      type: Object,
      default: null,
    },
  },
  setup(props) {
    return {
      texts: computed(() => getAppTexts(props.language, props.uiStyle)),
    };
  },
  template: `
    <section class="panel panel-guide modal-panel">
      <div v-if="!embedded" class="panel-head panel-head-inline">
        <h2>{{ texts.guideTitle }}</h2>
        <span class="panel-head-badge">{{ texts.guideDockBadge }}</span>
      </div>

      <button
        v-if="ruleEntry"
        type="button"
        class="guide-section-card guide-section-button"
        @click="$emit('open-entry', ruleEntry.key)"
      >
        <div class="guide-section-head">
          <h3>{{ ruleEntry.title }}</h3>
          <span class="guide-entry-arrow" aria-hidden="true">></span>
        </div>
        <p v-if="ruleEntry.subtitle" class="guide-section-copy">{{ ruleEntry.subtitle }}</p>
        <div v-if="ruleEntry.subEntries?.length" class="guide-section-mini-tabs" aria-hidden="true">
          <span v-for="subEntry in ruleEntry.subEntries" :key="subEntry.key">{{ subEntry.tabTitle }}</span>
        </div>
      </button>

      <button
        v-if="whyEntry"
        type="button"
        class="guide-section-card guide-section-button"
        @click="$emit('open-entry', whyEntry.key)"
      >
        <div class="guide-section-head">
          <h3>{{ whyEntry.title }}</h3>
          <span class="guide-entry-arrow" aria-hidden="true">></span>
        </div>
        <p v-if="whyEntry.subtitle" class="guide-section-copy">{{ whyEntry.subtitle }}</p>
        <div v-if="whyEntry.subEntries?.length" class="guide-section-mini-tabs" aria-hidden="true">
          <span v-for="subEntry in whyEntry.subEntries" :key="subEntry.key">{{ subEntry.tabTitle }}</span>
        </div>
      </button>

      <button
        v-if="thanksEntry"
        type="button"
        class="guide-section-card guide-section-button"
        @click="$emit('open-entry', thanksEntry.key)"
      >
        <div class="guide-section-head">
          <h3>{{ thanksEntry.title }}</h3>
          <span class="guide-entry-arrow" aria-hidden="true">></span>
        </div>
        <p v-if="thanksEntry.subtitle" class="guide-section-copy">{{ thanksEntry.subtitle }}</p>
      </button>
    </section>
  `,
};

function buildGuideDisplayBlocks(blocks = []) {
  const result = [];
  const isCutExample = (block) => block?.type === "image" && /切断|cut example/i.test(block.alt ?? "");

  for (let index = 0; index < blocks.length; index += 1) {
    const currentBlock = blocks[index];
    const nextBlock = blocks[index + 1];

    if (isCutExample(currentBlock) && isCutExample(nextBlock)) {
      result.push({
        type: "image-row",
        images: [currentBlock, nextBlock],
      });
      index += 1;
      continue;
    }

    result.push(currentBlock);
  }

  return result;
}

const GuideReaderModal = {
  name: "GuideReaderModal",
  components: {
    GuideInlineText,
  },
  emits: ["close"],
  props: {
    entry: {
      type: Object,
      default: null,
    },
    language: {
      type: String,
      required: true,
    },
    uiStyle: {
      type: String,
      required: true,
    },
  },
  setup(props) {
    const activeSubKey = ref("");
    const activeReadableEntry = computed(() => {
      const subEntries = props.entry?.subEntries ?? [];
      if (!subEntries.length) {
        return props.entry;
      }
      return subEntries.find((item) => item.key === activeSubKey.value) ?? subEntries[0];
    });
    const displayBlocks = computed(() => buildGuideDisplayBlocks(activeReadableEntry.value?.blocks ?? []));

    const typesetGuideMath = () => {
      nextTick?.(() => {
        const reader = document.querySelector(".guide-reader");
        if (reader && globalThis.MathJax?.typesetPromise) {
          globalThis.MathJax.typesetClear?.([reader]);
          globalThis.MathJax.typesetPromise([reader]).catch((error) => {
            console.warn("Guide MathJax typeset failed:", error);
          });
        }
      });
    };

    watch(() => props.entry?.key, () => {
      activeSubKey.value = props.entry?.subEntries?.[0]?.key ?? "";
      typesetGuideMath();
    }, { immediate: true });

    watch(activeSubKey, () => {
      typesetGuideMath();
    });

    watch(displayBlocks, () => {
      typesetGuideMath();
    });

    return {
      activeReadableEntry,
      activeSubKey,
      displayBlocks,
      formatGuideDisplayMath,
      highlightGuideCode,
      texts: computed(() => getAppTexts(props.language, props.uiStyle)),
    };
  },
  template: `
    <transition name="fade">
      <div v-if="entry" class="guide-overlay" role="dialog" aria-modal="true" @click.self="$emit('close')">
        <div class="guide-reader">
          <div class="guide-reader-top">
            <div>
              <h2>{{ entry.title }}</h2>
              <p v-if="activeReadableEntry?.subtitle || entry.subtitle" class="guide-reader-subtitle">
                {{ activeReadableEntry?.subtitle || entry.subtitle }}
              </p>
            </div>
            <button type="button" class="action-button action-button-ghost guide-close-button" @click="$emit('close')">
              {{ texts.guideCloseAction }}
            </button>
          </div>

          <div class="guide-reader-layout">
            <div v-if="entry.subEntries?.length" class="guide-sub-tabs" role="tablist" :aria-label="entry.title">
              <button
                v-for="subEntry in entry.subEntries"
                :key="subEntry.key"
                type="button"
                class="guide-sub-tab"
                :class="{ 'is-active': activeSubKey === subEntry.key }"
                role="tab"
                :aria-selected="activeSubKey === subEntry.key"
                @click="activeSubKey = subEntry.key"
              >
                <strong>{{ subEntry.tabTitle }}</strong>
                <span>{{ subEntry.subtitle }}</span>
              </button>
            </div>
            <div class="guide-reader-body">
              <template v-for="(block, index) in displayBlocks" :key="(activeReadableEntry?.key || entry.key) + '-' + index">
                <h3 v-if="block.type === 'heading1'" class="guide-block-heading-xl"><GuideInlineText :tokens="block.tokens" /></h3>
                <h4 v-else-if="block.type === 'heading2'" class="guide-block-heading"><GuideInlineText :tokens="block.tokens" /></h4>
                <h5 v-else-if="block.type === 'heading3'" class="guide-block-subheading"><GuideInlineText :tokens="block.tokens" /></h5>
                <h5 v-else-if="block.type === 'callout'" class="guide-block-callout"><GuideInlineText :tokens="block.tokens" /></h5>
                <blockquote v-else-if="block.type === 'quote'" class="guide-block-quote">
                  <p><GuideInlineText :tokens="block.tokens" /></p>
                </blockquote>
                <div v-else-if="block.type === 'mathblock'" class="guide-block-math">
                  {{ formatGuideDisplayMath(block.text) }}
                </div>
                <pre v-else-if="block.type === 'codeblock'" class="guide-code-block"><code :class="'language-' + (block.language || 'text')" v-html="highlightGuideCode(block.code, block.language)"></code></pre>
                <div v-else-if="block.type === 'table'" class="guide-table-wrap">
                  <table class="guide-table">
                    <thead>
                      <tr>
                        <th v-for="(cell, cellIndex) in block.headers" :key="'h-' + cellIndex">
                          <GuideInlineText :tokens="cell.tokens" />
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="(row, rowIndex) in block.rows" :key="'r-' + rowIndex">
                        <td v-for="(cell, cellIndex) in row" :key="'c-' + rowIndex + '-' + cellIndex">
                          <GuideInlineText :tokens="cell.tokens" />
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <hr v-else-if="block.type === 'divider'" class="guide-block-divider" />
                <figure v-else-if="block.type === 'image'" class="guide-block-figure">
                  <img :src="block.src" :alt="block.alt || entry.title" class="guide-block-image" loading="lazy" />
                  <figcaption v-if="block.alt" class="guide-block-figcaption">{{ block.alt }}</figcaption>
                </figure>
                <div v-else-if="block.type === 'image-row'" class="guide-block-image-row">
                  <figure
                    v-for="(image, imageIndex) in block.images"
                    :key="entry.key + '-image-' + index + '-' + imageIndex"
                    class="guide-block-figure"
                  >
                    <img :src="image.src" :alt="image.alt || entry.title" class="guide-block-image" loading="lazy" />
                    <figcaption v-if="image.alt" class="guide-block-figcaption">{{ image.alt }}</figcaption>
                  </figure>
                </div>
                <div v-else-if="block.type === 'meta'" class="guide-block-meta">
                  <span class="guide-block-meta-label">{{ block.label }}</span>
                  <p class="guide-block-meta-value"><GuideInlineText :tokens="block.tokens" /></p>
                </div>
                <div v-else-if="block.type === 'bullet'" class="guide-block-bullet">
                  <span class="guide-bullet-dot" aria-hidden="true"></span>
                  <p><GuideInlineText :tokens="block.tokens" /></p>
                </div>
                <div v-else-if="block.type === 'ordered'" class="guide-block-ordered">
                  <span class="guide-ordered-index">{{ block.order }}</span>
                  <p><GuideInlineText :tokens="block.tokens" /></p>
                </div>
                <p v-else class="guide-block-paragraph"><GuideInlineText :tokens="block.tokens" /></p>
              </template>
            </div>
          </div>
        </div>
      </div>
    </transition>
  `,
};

const DockLauncher = {
  name: "DockLauncher",
  emits: ["open"],
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
    copy: {
      type: String,
      default: "",
    },
  },
  template: `
    <button type="button" class="dock-launcher" :class="'dock-launcher-' + variant" @click="$emit('open')">
      <span class="dock-folder-head">
        <span class="dock-folder-icon" :class="'dock-folder-icon-' + variant" aria-hidden="true">
          <span v-if="variant === 'board'" class="triangle-glyph"></span>
          <svg v-else-if="variant === 'guide'" viewBox="0 0 24 24" focusable="false">
            <path d="M5 4.75A2.75 2.75 0 0 1 7.75 2h9.5A1.75 1.75 0 0 1 19 3.75v15.5A1.75 1.75 0 0 1 17.25 21h-9A3.25 3.25 0 0 0 5 23V4.75Zm2.75-1.25A1.25 1.25 0 0 0 6.5 4.75v13.02c.52-.18 1.08-.27 1.75-.27h9.25V3.75a.25.25 0 0 0-.25-.25h-9.5Zm.5 16.5c-.68 0-1.24.16-1.75.49V21.5c.35-.33.89-.5 1.75-.5h9.25a.75.75 0 0 0 .75-.75v-1.25H8.25Z" />
            <path d="M9 7.25a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 0 1.5h-4.5A.75.75 0 0 1 9 7.25Zm0 3.5A.75.75 0 0 1 9.75 10h5.5a.75.75 0 0 1 0 1.5h-5.5a.75.75 0 0 1-.75-.75Zm0 3.5a.75.75 0 0 1 .75-.75h5.5a.75.75 0 0 1 0 1.5h-5.5a.75.75 0 0 1-.75-.75Z" />
          </svg>
          <svg v-else viewBox="0 0 24 24" focusable="false">
            <path d="M19.43 12.98c.04-.32.07-.65.07-.98s-.03-.66-.08-.98l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.6-.22l-2.49 1a7.2 7.2 0 0 0-1.69-.98l-.38-2.65A.5.5 0 0 0 14 1h-4a.5.5 0 0 0-.49.42l-.38 2.65c-.61.24-1.18.56-1.69.98l-2.49-1a.5.5 0 0 0-.6.22l-2 3.46a.5.5 0 0 0 .12.64l2.11 1.65c-.05.32-.08.65-.08.98s.03.66.08.98L2.47 14.63a.5.5 0 0 0-.12.64l2 3.46a.5.5 0 0 0 .6.22l2.49-1c.51.42 1.08.74 1.69.98l.38 2.65A.5.5 0 0 0 10 23h4a.5.5 0 0 0 .49-.42l.38-2.65c.61-.24 1.18-.56 1.69-.98l2.49 1a.5.5 0 0 0 .6-.22l2-3.46a.5.5 0 0 0-.12-.64l-2.1-1.65ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z" />
          </svg>
        </span>
        <span class="dock-launcher-copy">
          <strong class="dock-folder-title">{{ title }}</strong>
          <small v-if="copy">{{ copy }}</small>
        </span>
      </span>
      <span class="dock-launcher-foot">
        <span v-if="badge" class="dock-folder-badge">{{ badge }}</span>
        <span class="dock-launcher-action">></span>
      </span>
    </button>
  `,
};

const UtilityModal = {
  name: "UtilityModal",
  emits: ["close"],
  props: {
    visible: {
      type: Boolean,
      default: false,
    },
    variant: {
      type: String,
      default: "board",
    },
    eyebrow: {
      type: String,
      default: "",
    },
    title: {
      type: String,
      default: "",
    },
    description: {
      type: String,
      default: "",
    },
    closeLabel: {
      type: String,
      default: "",
    },
  },
  template: `
    <transition name="fade">
      <div
        v-if="visible"
        class="utility-overlay"
        :class="'utility-overlay-' + variant"
        role="dialog"
        aria-modal="true"
        @click.self="$emit('close')"
      >
        <div class="utility-modal" :class="'utility-modal-' + variant">
          <div class="utility-header">
            <div class="utility-head-copy">
              <h2>{{ title }}</h2>
              <p v-if="description" class="utility-description">{{ description }}</p>
            </div>
            <button type="button" class="utility-close" :aria-label="closeLabel" @click="$emit('close')">×</button>
          </div>
          <div class="utility-body">
            <slot></slot>
          </div>
        </div>
      </div>
    </transition>
  `,
};

function resolveGuideMarkdown(key, language, guideMarkdownOverrides = {}) {
  return guideMarkdownOverrides[key] ?? getGuideMarkdown(key, language);
}

function createGuideEntries(language = "zh", uiStyle = "casual", guideMarkdownOverrides = {}) {
  const texts = getAppTexts(language, uiStyle);
  const ruleSubEntries = [
    {
      key: "rules-essential",
      group: "rules",
      tabTitle: texts.guideRuleSimpleTitle,
      eyebrow: texts.guideRulesTitle,
      title: texts.guideRuleSimpleTitle,
      subtitle: texts.guideRuleSimpleSubtitle,
      showIllustration: false,
      blocks: ensureGuideRuleImages("rulesEssential", parseGuideMarkdown(resolveGuideMarkdown("rulesEssential", language, guideMarkdownOverrides)), language),
    },
    {
      key: "rules-war",
      group: "rules",
      tabTitle: texts.guideRuleWarTitle,
      eyebrow: texts.guideRulesTitle,
      title: texts.guideRuleWarTitle,
      subtitle: texts.guideRuleWarSubtitle,
      showIllustration: false,
      blocks: ensureGuideRuleImages("rulesWar", parseGuideMarkdown(resolveGuideMarkdown("rulesWar", language, guideMarkdownOverrides)), language),
    },
    {
      key: "rules-math",
      group: "rules",
      tabTitle: texts.guideRuleMathTitle,
      eyebrow: texts.guideRulesTitle,
      title: texts.guideRuleMathTitle,
      subtitle: texts.guideRuleMathSubtitle,
      showIllustration: false,
      blocks: ensureGuideRuleImages("rulesMath", parseGuideMarkdown(resolveGuideMarkdown("rulesMath", language, guideMarkdownOverrides)), language),
    },
  ];
  const whySubEntries = [
    {
      key: "why-talk",
      group: "why",
      tabTitle: texts.guideWhyTalkTitle,
      eyebrow: texts.guideWhyTitle,
      title: texts.guideWhyTalkTitle,
      subtitle: texts.guideWhyTalkSubtitle,
      showIllustration: false,
      blocks: parseGuideMarkdown(resolveGuideMarkdown("whyTalk", language, guideMarkdownOverrides)),
    },
    {
      key: "why-code",
      group: "why",
      tabTitle: texts.guideWhyCodeTitle,
      eyebrow: texts.guideWhyTitle,
      title: texts.guideWhyCodeTitle,
      subtitle: texts.guideWhyCodeSubtitle,
      showIllustration: false,
      blocks: parseGuideMarkdown(resolveGuideMarkdown("whyCode", language, guideMarkdownOverrides)),
    },
    {
      key: "why-theory",
      group: "why",
      tabTitle: texts.guideWhyTheoryTitle,
      eyebrow: texts.guideWhyTitle,
      title: texts.guideWhyTheoryTitle,
      subtitle: texts.guideWhyTheorySubtitle,
      showIllustration: false,
      blocks: parseGuideMarkdown(resolveGuideMarkdown("whyTheory", language, guideMarkdownOverrides)),
    },
  ];
  return [
    {
      key: "rules",
      group: "rules-root",
      eyebrow: texts.guideRulesTitle,
      title: texts.guideRulesTitle,
      subtitle: texts.guideRulesCopy,
      showIllustration: false,
      subEntries: ruleSubEntries,
      blocks: ruleSubEntries[0]?.blocks ?? [],
    },
    {
      key: "why-this",
      group: "why",
      eyebrow: texts.guideWhyTitle,
      title: texts.guideWhyTitle,
      subtitle: texts.guideWhySubtitle,
      showIllustration: false,
      subEntries: whySubEntries,
      blocks: whySubEntries[0]?.blocks ?? [],
    },
    {
      key: "thanks",
      group: "thanks",
      eyebrow: texts.guideThanksTitle,
      title: texts.guideThanksTitle,
      subtitle: texts.guideThanksSubtitle,
      showIllustration: false,
      blocks: parseGuideMarkdown(resolveGuideMarkdown("thanks", language, guideMarkdownOverrides)),
    },
  ];
}

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
    uiStyle: {
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
      texts: computed(() => getAppTexts(props.language, props.uiStyle)),
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
    DockLauncher,
    GuidePanel,
    UtilityModal,
    GuideReaderModal,
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
    const uiStyle = ref(getAppInitialUiStyle());
    const guideMarkdownOverrides = ref({});
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
    const readyPending = ref(false);
    const chatEmojiBursts = ref([]);
    const chatEmojiOptions = CHAT_EMOJI_OPTIONS;
    let lastServerTimestamp = 0;
    const overlayResult = ref(null);
    const activeUtilityDeck = ref("");
    const activeGuideKey = ref("");
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
    let guideMarkdownLoadId = 0;
    const chatEmojiTimeoutIds = new Set();

    watch([language, uiStyle], ([nextLanguage, nextUiStyle]) => {
      globalThis.localStorage?.setItem("triaxis-language", nextLanguage);
      globalThis.localStorage?.setItem(UI_STYLE_STORAGE_KEY, nextUiStyle);
      document.documentElement.lang = nextLanguage === "en" ? "en" : "zh-CN";
      document.documentElement.dataset.uiStyle = nextUiStyle;
      document.title = getAppTexts(nextLanguage, nextUiStyle).pageTitle;
    }, { immediate: true });

    watch(language, async (value) => {
      const loadId = ++guideMarkdownLoadId;
      const keys = [
        "rulesEssential",
        "rulesWar",
        "rulesMath",
        "whyTalk",
        "whyCode",
        "whyTheory",
        "thanks",
      ];
      const nextOverrides = {};

      await Promise.all(keys.map(async (key) => {
        const asset = getGuideMarkdownAsset(key, value);
        if (!asset) {
          return;
        }
        try {
          const response = await fetch(`${asset}?v=20260429a`, { cache: "no-cache" });
          if (response.ok) {
            nextOverrides[key] = await response.text();
          }
        } catch (error) {
          console.warn(`Guide markdown asset failed: ${key}`, error);
        }
      }));

      if (loadId === guideMarkdownLoadId) {
        guideMarkdownOverrides.value = nextOverrides;
      }
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
      authError.value = localizeAppErrorMessage(error?.message ?? String(error), language.value, uiStyle.value);
    };

    const isAuthenticated = computed(() => Boolean(auth.value.token && auth.value.username));
    const isHost = computed(() => Boolean(session.value.playerId && roomInfo.value.hostPlayerId === session.value.playerId));
    const boardDockBadge = computed(() => (
      uiStyle.value === UI_STYLE_ACADEMIC
        ? (language.value === "en"
          ? `${selectedPlayerCount.value}N / ${selectedGridSize.value}`
          : `${selectedPlayerCount.value}节点 / ${selectedGridSize.value}`)
        : (language.value === "en"
          ? `${selectedPlayerCount.value}P / ${selectedGridSize.value}`
          : `${selectedPlayerCount.value}人 / ${selectedGridSize.value}`)
    ));
    const networkDockBadge = computed(() => {
      if (session.value.roomId) {
        return `#${session.value.roomId}`;
      }

      return getAppTexts(language.value, uiStyle.value).localShort;
    });
    const guideDockBadge = computed(() => getAppTexts(language.value, uiStyle.value).guideDockBadge);
    const guideEntries = computed(() => createGuideEntries(language.value, uiStyle.value, guideMarkdownOverrides.value));
    const ruleGuideEntry = computed(() => guideEntries.value.find((entry) => entry.key === "rules") ?? null);
    const whyGuideEntry = computed(() => guideEntries.value.find((entry) => entry.group === "why") ?? null);
    const thanksGuideEntry = computed(() => guideEntries.value.find((entry) => entry.group === "thanks") ?? null);
    const activeGuideEntry = computed(() => (
      guideEntries.value.find((entry) => entry.key === activeGuideKey.value) ?? null
    ));
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
        label: formatAppPlayerName(color, language.value, uiStyle.value),
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

    const clearChatEmojiBursts = () => {
      for (const timeoutId of chatEmojiTimeoutIds) {
        globalThis.clearTimeout(timeoutId);
      }
      chatEmojiTimeoutIds.clear();
      chatEmojiBursts.value = [];
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
      networkError.value = localizeAppErrorMessage(error?.message ?? String(error), language.value, uiStyle.value);
    };

    const applyRoomPayload = (payload) => {
      // MATCH_RESET 必须无条件通过，在所有时间戳校验之前处理。
      // 认输/重开包到达时直接应用，并清零时间戳基线，防止后续包被误拦。
      const isMatchReset = payload?.type === ServerEvent.MATCH_RESET
        || payload?.reason === "resign_restart"
        || payload?.reason === "normal_restart";
      if (isMatchReset) {
        lastServerTimestamp = 0;
        readyPending.value = false;
        const nextStatusReset = normalizeRoomStatus(payload?.status ?? roomStatus.value);
        roomStatus.value = nextStatusReset || roomStatus.value;
        roomInfo.value = {
          ...createEmptyRoomInfo(),
          status: nextStatusReset || roomInfo.value.status,
          hostPlayerId: payload?.hostPlayerId ?? roomInfo.value.hostPlayerId,
          players: Array.isArray(payload?.players) ? payload.players : roomInfo.value.players,
          settings: normalizeAppGameSettings(payload?.settings ?? roomInfo.value.settings),
          countdownEndsAt: payload?.countdownEndsAt ?? null,
          matchPhase: normalizeMatchPhase(
            readPayloadMatchPhase(payload, roomInfo.value.matchPhase),
            nextStatusReset,
          ),
        };
        resultModalDismissed.value = false;
        return true;
      }

      // 用服务端时间戳做单调性校验，丢弃比当前状态更旧的广播包。
      const incomingTs = payload?.serverTimestamp ?? 0;
      const nextStatus = normalizeRoomStatus(payload?.status ?? roomStatus.value);
      const isRoomReadyTransition = payload?.type === ServerEvent.ROOM_READY
        && nextStatus === "inProgress"
        && roomStatus.value !== "inProgress";
      const timestampRollbackMs = incomingTs > 0
        ? lastServerTimestamp - incomingTs
        : 0;
      const shouldAcceptRoomReadyRollback = isRoomReadyTransition
        && timestampRollbackMs > 0
        && timestampRollbackMs <= SERVER_TIMESTAMP_TOLERANCE_MS;

      if (timestampRollbackMs > 0 && !shouldAcceptRoomReadyRollback) {
        return false;
      }
      if (incomingTs > 0) {
        lastServerTimestamp = Math.max(lastServerTimestamp, incomingTs);
      }

      // 服务端确认后，解除准备操作的本地锁。
      readyPending.value = false;

      roomStatus.value = nextStatus || roomStatus.value;
      roomInfo.value = {
        ...createEmptyRoomInfo(),
        status: nextStatus || roomInfo.value.status,
        hostPlayerId: payload?.hostPlayerId ?? roomInfo.value.hostPlayerId,
        players: Array.isArray(payload?.players) ? payload.players : roomInfo.value.players,
        settings: normalizeAppGameSettings(payload?.settings ?? roomInfo.value.settings),
        countdownEndsAt: payload?.countdownEndsAt ?? null,
        matchPhase: normalizeMatchPhase(
          readPayloadMatchPhase(payload, roomInfo.value.matchPhase),
          nextStatus,
        ),
      };
      resultModalDismissed.value = false;
      return true;
    };

    const resetRoomContext = () => {
      roomStatus.value = "solo";
      roomInfo.value = createEmptyRoomInfo();
      roomIdInput.value = "";
      overlayResult.value = null;
      resultModalDismissed.value = false;
      readyPending.value = false;
      lastServerTimestamp = 0;
      clearChatEmojiBursts();
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
      const normalizedPhase = normalizeMatchPhase(readPayloadMatchPhase(payload, roomInfo.value.matchPhase), normalizedStatus);
      const everyoneConnected = Array.isArray(players)
        && players.length >= normalizedSettings.playerCount
        && players.every((player) => player.connected);

      gameState.value = controller.value.enableMultiplayer({
        networkManager,
        localPlayer: payload?.yourColor ?? session.value.color,
        roomReady: normalizedStatus === "inProgress" || normalizedPhase === "PLAYING",
        opponentConnected: everyoneConnected,
      });
    };

    const applyRoomSnapshot = (payload, resetController = true) => {
      if (!applyRoomPayload(payload)) {
        return;
      }
      roomIdInput.value = payload?.roomId ?? roomIdInput.value;
      syncSession();
      syncOnlineController(payload);
      applySettingsToController(payload?.settings ?? payload?.matchState?.settings ?? currentGameSettings(), resetController);
      syncSession();

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
      const primaryUrl = serverUrl.value.trim();
      try {
        await networkManager.connect(primaryUrl, auth.value.token);
      } catch (error) {
        const fallbacks = getLocalWebSocketFallbacks(primaryUrl);
        if (!fallbacks.length) {
          throw error;
        }

        let lastError = error;
        for (const fallbackUrl of fallbacks) {
          try {
            await networkManager.connect(fallbackUrl, auth.value.token);
            serverUrl.value = fallbackUrl;
            lastError = null;
            break;
          } catch (fallbackError) {
            lastError = fallbackError;
          }
        }

        if (lastError) {
          throw lastError;
        }
      }
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
          const payload = await postAuthJson(serverUrl.value, "/api/register", {
            username,
            password,
          });
          if (payload.apiBaseUrl) {
            serverUrl.value = payload.apiBaseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:") + "/ws";
          }
          authMode.value = "login";
          authPassword.value = "";
          authFeedbackTone.value = "success";
          authError.value = getAppTexts(language.value, uiStyle.value).authRegisterSuccess;
          return;
        }

        const payload = await postAuthJson(serverUrl.value, "/api/login", {
          username,
          password,
        });
        if (payload.apiBaseUrl) {
          serverUrl.value = payload.apiBaseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:") + "/ws";
        }
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

      if (roomInfo.value.matchPhase === "PLAYING" || roomStatus.value === "inProgress") {
        networkError.value = getAppTexts(language.value, uiStyle.value).matchInProgress;
        return;
      }

      readyPending.value = true;
      networkBusy.value = true;
      networkError.value = "";
      try {
        await networkManager.sendReady(ready);
      } catch (error) {
        handleNetworkError(error);
        readyPending.value = false;
      } finally {
        networkBusy.value = false;
      }
    };

    const chatEmojiDisabled = computed(() => {
      return !session.value.roomId
        || !networkManager.isConnected()
        || roomStatus.value === "solo"
        || roomStatus.value === "offline";
    });

    const normalizeChatEmojiPayload = (payload) => {
      const content = String(payload?.content ?? "").trim();
      if (!content) {
        return null;
      }

      const metadata = payload?.metadata && typeof payload.metadata === "object"
        ? payload.metadata
        : {};
      const animation = CHAT_EMOJI_ANIMATIONS.has(metadata.animation)
        ? metadata.animation
        : "bounce";
      const rawDuration = Number(metadata.duration ?? 1200);
      const duration = Number.isFinite(rawDuration)
        ? Math.max(300, Math.min(3000, Math.round(rawDuration)))
        : 1200;
      return {
        sender: String(payload?.sender ?? ""),
        content,
        metadata: {
          animation,
          duration,
        },
      };
    };

    const pushChatEmojiBurst = (payload) => {
      const normalized = normalizeChatEmojiPayload(payload);
      if (!normalized) {
        return;
      }

      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const burst = {
        id,
        sender: normalized.sender,
        content: normalized.content,
        animation: normalized.metadata.animation,
        duration: normalized.metadata.duration,
        side: normalized.sender && normalized.sender === session.value.playerId ? "self" : "remote",
      };
      chatEmojiBursts.value = [...chatEmojiBursts.value.slice(-3), burst];

      const timeoutId = globalThis.setTimeout(() => {
        chatEmojiTimeoutIds.delete(timeoutId);
        chatEmojiBursts.value = chatEmojiBursts.value.filter((candidate) => candidate.id !== id);
      }, burst.duration + 180);
      chatEmojiTimeoutIds.add(timeoutId);
    };

    const handleChatEmoji = async (emoji) => {
      if (chatEmojiDisabled.value) {
        return;
      }

      networkError.value = "";
      try {
        await networkManager.sendChatEmoji(emoji?.content, {
          animation: emoji?.animation,
          duration: emoji?.duration,
        });
      } catch (error) {
        handleNetworkError(error);
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
      const texts = getAppTexts(language.value, uiStyle.value);
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
            formatAppWinner(gameState.value.winner, language.value, uiStyle.value),
            formatAppFinalScoreLine(gameState.value.scores, language.value, gameState.value.players, uiStyle.value),
          )
          : texts.finalStatus(
            formatAppWinner(gameState.value.winner, language.value, uiStyle.value),
            formatAppFinalScoreLine(gameState.value.scores, language.value, gameState.value.players, uiStyle.value),
          );
      }

      if (roomInfo.value.matchPhase === "PLAYING" || roomStatus.value === "inProgress") {
        const turnStatus = gameState.value.isLocalTurn
          ? texts.localTurnStatus(formatAppPlayerName(session.value.color, language.value, uiStyle.value))
          : texts.remoteTurnStatus;
        return `${texts.playingStatus} ${turnStatus}`;
      }

      return gameState.value.currentPlayer === Player.BLACK
        ? texts.soloBlueStatus
        : gameState.value.currentPlayer === Player.WHITE
          ? texts.soloRedStatus
          : (texts.soloPurpleStatus ?? "Purple to move.");
    });

    const boardHint = computed(() => {
      const texts = getAppTexts(language.value, uiStyle.value);
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
        || readyPending.value
        || roomStatus.value === "waiting"
        || roomStatus.value === "offline"
        || roomInfo.value.matchPhase === "PLAYING"
        || roomStatus.value === "inProgress"
        || roomStatus.value === "countdown";
    });
    const starterLocked = computed(() => !isHost.value || networkBusy.value || roomInfo.value.matchPhase === "PLAYING" || roomStatus.value === "inProgress" || roomStatus.value === "countdown");
    const showClosePrompt = computed(() => Boolean(overlayResult.value || (gameState.value.gameOver && !resultModalDismissed.value)));

    const resetLabel = computed(() => {
      const texts = getAppTexts(language.value, uiStyle.value);
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
      return !isHost.value || roomInfo.value.matchPhase === "PLAYING" || roomStatus.value === "inProgress" || roomStatus.value === "countdown";
    });

    const resultResetAllowed = computed(() => {
      return !resetDisabled.value;
    });
    const hasUtilityModalOpen = computed(() => Boolean(activeUtilityDeck.value));
    const hasGuideModalOpen = computed(() => Boolean(activeGuideEntry.value));
    const hasAnyModalOpen = computed(() => showClosePrompt.value || hasUtilityModalOpen.value || hasGuideModalOpen.value);

    watch(hasAnyModalOpen, (promptVisible) => {
      document.body.classList.toggle("modal-open", Boolean(promptVisible));
    }, { immediate: true });

    const handleEscapeKeydown = (event) => {
      if (event.key !== "Escape") {
        return;
      }

      if (showClosePrompt.value) {
        handleClosePrompt();
        return;
      }

      if (hasGuideModalOpen.value) {
        activeGuideKey.value = "";
        return;
      }

      if (hasUtilityModalOpen.value) {
        activeUtilityDeck.value = "";
        return;
      }
    };

    const handleOpenUtilityDeck = (deckKey) => {
      activeUtilityDeck.value = deckKey;
    };

    const handleCloseUtilityDeck = () => {
      activeUtilityDeck.value = "";
      activeGuideKey.value = "";
    };

    const handleOpenGuideEntry = (entryKey) => {
      activeGuideKey.value = entryKey;
    };

    const handleCloseGuideEntry = () => {
      activeGuideKey.value = "";
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
          networkError.value = localizeAppErrorMessage(`WebSocket closed: ${payload.code} ${payload.reason}`, language.value, uiStyle.value);
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
          networkError.value = getAppTexts(language.value, uiStyle.value).roomSettingsChanged;
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
        networkError.value = getAppTexts(language.value, uiStyle.value).opponentLeft;
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
            uiStyle.value,
        );
      }),
    );

    unsubscribers.push(
      networkManager.on(ServerEvent.MATCH_RESET, (payload) => {
        networkError.value = "";
        resultModalDismissed.value = false;
        // applyRoomPayload 已在最顶部无条件处理 MATCH_RESET，此处直接调用快照同步。
        applyRoomSnapshot(payload, true);
        // 强制刷新控制器渲染，防止棋盘停留在重置前的旧画面。
        if (controller.value) {
          gameState.value = controller.value.getGameState();
        }
        // 联机重置后，服务端不会回传整盘棋，而是让前端自己重建空盘并展示结算 overlay。
        if (payload.reason === "consensus_restart" && payload.winnerColor) {
          overlayResult.value = {
            winner: payload.winnerColor,
            scoreLine: formatAppFinalScoreLine(gameState.value.scores, language.value, gameState.value.players, uiStyle.value),
          };
        } else if (payload.reason === "resign_restart" && payload.winnerColor && (payload.loserColor || payload.resetColor || payload.color)) {
          overlayResult.value = {
            winner: payload.winnerColor,
            loser: payload.loserColor ?? payload.resetColor ?? payload.color,
          };
        }
      }),
    );

    unsubscribers.push(
      networkManager.on(ServerEvent.CHAT_EMOJI, (payload) => {
        pushChatEmojiBurst(payload);
      }),
    );

    unsubscribers.push(
      networkManager.on(ServerEvent.ERROR, (payload) => {
        handleNetworkError(new Error(payload.message ?? payload.code ?? getAppTexts(language.value, uiStyle.value).unknownServer));
      }),
    );

    onBeforeUnmount(() => {
      clearReconnectTimer();
      clearTurnCountdown();
      clearTurnTimer();
      clearChatEmojiBursts();
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
      activeUtilityDeck,
      guideDockBadge,
      activeGuideEntry,
      ruleGuideEntry,
      whyGuideEntry,
      thanksGuideEntry,
      isAuthenticated,
      language,
      uiStyle,
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
      chatEmojiBursts,
      chatEmojiOptions,
      chatEmojiDisabled,
      settingsLocked,
      turnTimerEnabled,
      turnTimerRemaining,
      resultResetAllowed,
      handleResultAction,
      handleResultLeaveRoom,
      handleOpenUtilityDeck,
      handleCloseUtilityDeck,
      handleOpenGuideEntry,
      handleCloseGuideEntry,
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
      handleChatEmoji,
      handleClosePrompt,
    };
  },
  template: `
    <main class="app-shell app-shell-focus">
      <section class="stage-layout">
        <section class="board-column">
          <header class="stage-heading">
            <h1 class="stage-title">{{ getTexts(language, uiStyle).heroTitle }}</h1>
          </header>

          <BoardCanvas
            :language="language"
            :ui-style="uiStyle"
            :hint-text="boardHint"
            @controller-ready="handleControllerReady"
            @state-change="handleStateChange"
          />

          <div class="chat-emoji-layer" aria-live="polite" aria-atomic="false">
            <div
              v-for="burst in chatEmojiBursts"
              :key="burst.id"
              class="chat-emoji-bubble"
              :class="['is-' + burst.side, 'is-' + burst.animation]"
              :style="{ '--emoji-duration': burst.duration + 'ms' }"
            >
              {{ burst.content }}
            </div>
          </div>

          <ControlPanel
            :game-state="gameState"
            :language="language"
            :ui-style="uiStyle"
            :skip-disabled="skipDisabled"
            :reset-disabled="resetDisabled"
            :reset-label="resetLabel"
            :session="session"
            :room-players="roomInfo.players"
            :turn-timer-enabled="turnTimerEnabled"
            :turn-timer-remaining="turnTimerRemaining"
            :emoji-options="chatEmojiOptions"
            :emoji-disabled="chatEmojiDisabled"
            @skip="handleSkip"
            @reset="handleReset"
            @emoji="handleChatEmoji"
          />
        </section>

        <aside class="dock-column">
          <DockLauncher
            variant="board"
            :title="getTexts(language, uiStyle).boardDockTitle"
            :copy="getTexts(language, uiStyle).boardDockCopy"
            :badge="boardDockBadge"
            @open="handleOpenUtilityDeck('board')"
          />

          <DockLauncher
            variant="network"
            :title="getTexts(language, uiStyle).networkDockTitle"
            :copy="getTexts(language, uiStyle).networkDockCopy"
            :badge="networkDockBadge"
            @open="handleOpenUtilityDeck('network')"
          />

          <DockLauncher
            variant="guide"
            :title="getTexts(language, uiStyle).guideDockTitle"
            :copy="getTexts(language, uiStyle).guideDockCopy"
            :badge="guideDockBadge"
            @open="handleOpenUtilityDeck('guide')"
          />
        </aside>
      </section>

      <UtilityModal
        variant="board"
        :visible="activeUtilityDeck === 'board'"
        :eyebrow="getTexts(language, uiStyle).stageFocusEyebrow"
        :title="getTexts(language, uiStyle).boardDockTitle"
        :description="getTexts(language, uiStyle).boardDockCopy"
        :close-label="getTexts(language, uiStyle).closePanel"
        @close="handleCloseUtilityDeck"
      >
        <div class="utility-grid utility-grid-board">
          <SetupPanel
            :language="language"
            :ui-style="uiStyle"
            :player-count="selectedPlayerCount"
            :grid-size="selectedGridSize"
            :turn-timer-enabled="selectedTurnTimerEnabled"
            :turn-time-limit-seconds="selectedTurnTimeLimitSeconds"
            :settings-locked="settingsLocked"
            :busy="networkBusy"
            @update:language="language = $event"
            @update:ui-style="uiStyle = $event"
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
            :ui-style="uiStyle"
            :status-text="statusText"
          />
        </div>
      </UtilityModal>

      <UtilityModal
        variant="network"
        :visible="activeUtilityDeck === 'network'"
        :eyebrow="getTexts(language, uiStyle).onlineEyebrow"
        :title="getTexts(language, uiStyle).networkDockTitle"
        :description="getTexts(language, uiStyle).networkDockCopy"
        :close-label="getTexts(language, uiStyle).closePanel"
        @close="handleCloseUtilityDeck"
      >
        <div class="utility-stack">
          <AuthPanel
            :language="language"
            :ui-style="uiStyle"
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
            :ui-style="uiStyle"
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
      </UtilityModal>

      <UtilityModal
        variant="guide"
        :visible="activeUtilityDeck === 'guide'"
        :eyebrow="getTexts(language, uiStyle).guideEyebrow"
        :title="getTexts(language, uiStyle).guideDockTitle"
        :description="getTexts(language, uiStyle).guideDockCopy"
        :close-label="getTexts(language, uiStyle).closePanel"
        @close="handleCloseUtilityDeck"
      >
        <GuidePanel
          :embedded="true"
          :language="language"
          :ui-style="uiStyle"
          :rule-entry="ruleGuideEntry"
          :why-entry="whyGuideEntry"
          :thanks-entry="thanksGuideEntry"
          @open-entry="handleOpenGuideEntry"
        />
      </UtilityModal>

      <GuideReaderModal
        :entry="activeGuideEntry"
        :language="language"
        :ui-style="uiStyle"
        @close="handleCloseGuideEntry"
      />

      <ResultModal
        :language="language"
        :ui-style="uiStyle"
        :game-state="gameState"
        :allow-reset="resultResetAllowed"
        :session="session"
        :room-players="roomInfo.players"
        :overlay-result="overlayResult"
        :visible="showClosePrompt"
        :reset-label="resetLabel"
        :close-label="getTexts(language, uiStyle).closePrompt"
        @action="handleResultAction"
        @leave="handleResultLeaveRoom"
        @close="handleClosePrompt"
      />
    </main>
  `,
};

export default App;
