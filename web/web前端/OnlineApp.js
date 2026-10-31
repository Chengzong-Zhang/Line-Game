import { MultiplayerWarmupSession } from "./MultiplayerAIWarmup.js?v=20261029-unified-r1";
import { createLocalAIWorker } from "./LocalAIWorkerFactory.js?v=20261029-unified-r1";
import GameController from "./GameController.js?v=20261101-topology-markers";
import Renderer from "./Renderer.js?v=20261029-unified-r1";
import GameEngine, { Player, PointState } from "./GameEngine.js?v=20261029-unified-r1";
import { captureWorkerRequest, isWorkerResultForRequest, serializeEngineState } from "./AIStateProtocol.js?v=20261029-unified-r1";
import { RESEARCH_FAMILIES, TRANSFER_SEEDS, researchProfile } from "./ResearchAIOptions.js?v=20261029-unified-r1";
import {
  OneShotHintWorker,
  applyHintWorkerResult,
} from "./HintWorkerSession.js?v=20261029-unified-r1";
import { ClientEvent, ServerEvent, TOPOLOGY_ROOM_CAPABILITY, resolveWebSocketUrl } from "./NetworkManager.js?v=20261029-unified-r1";
import NetworkManager from "./CrossPlatformNetwork.js?v=20261029-unified-r1";
import {
  applyRoomSnapshotWithPostCommit,
  coordinateControllerRoomSnapshot,
  registerRoomSnapshotResponseListeners,
  validateTopologyRoomSnapshot,
} from "./OnlineRoomSync.js?v=20261029-unified-r1";
import {
  createEmptyAuth as createAppEmptyAuth,
  GRID_SIZE_OPTIONS as APP_GRID_SIZE_OPTIONS,
  PLAYER_COUNT_OPTIONS as APP_PLAYER_COUNT_OPTIONS,
  ALL_PLAYERS as APP_ALL_PLAYERS,
  DEFAULT_TURN_TIMER_SECONDS as APP_DEFAULT_TURN_TIMER_SECONDS,
  DEFAULT_RULES_VERSION as APP_DEFAULT_RULES_VERSION,
  TURN_TIMER_MAX_SECONDS as APP_TURN_TIMER_MAX_SECONDS,
  TURN_TIMER_MIN_SECONDS as APP_TURN_TIMER_MIN_SECONDS,
  createDefaultGameState as createAppDefaultGameState,
  createEmptySession as createAppEmptySession,
  loadStoredAuth as loadAppStoredAuth,
  loadStoredSession as loadAppStoredSession,
  getPrimaryScores as getDisplayScores,
  isTopologyGameSettings,
  normalizeGameSettings as normalizeAppGameSettings,
  persistAuth as persistAppAuth,
  persistSession as persistAppSession,
} from "./OnlineAppState.js?v=20261029-unified-r1";
import {
  formatArea as formatAppArea,
  formatConnectionState as formatAppConnectionState,
  formatHintRemaining as formatAppHintRemaining,
  formatPlayerName as formatAppPlayerName,
  formatResetVoteMessage as formatAppResetVoteMessage,
  formatWinner as formatAppWinner,
  getInitialLanguage as getAppInitialLanguage,
  getInitialUiStyle as getAppInitialUiStyle,
  getTexts as getAppTexts,
  UI_STYLE_STORAGE_KEY,
  UI_STYLE_ACADEMIC,
  localizeErrorMessage as localizeAppErrorMessage,
} from "./OnlineAppI18n.js?v=20261029-unified-r1";
import { ensureGuideRuleImages, getGuideMarkdown, loadGuideMarkdownAssets, parseGuideMarkdown } from "./GuideContent.js?v=20261101-guide-alignment";
import { getGuideChapterLinks } from "./GuideArticleFormat.js?v=20261031-guide-reading";
import {
  TUTORIAL_LEVELS,
  getTutorialEngineSettings,
  getTutorialInspectionOverlay,
  getTutorialLevel,
  isTutorialTarget,
  isTutorialRestrictionAttempt,
} from "./TutorialRunner.js?v=20261029-unified-r1";
import {
  appendLocalGameAction,
  appendTopologyLocalGameAction,
  clearLocalGameSession,
  clearTopologyLocalGameSession,
  createLocalGameSession,
  createTopologyLocalGameSession,
  loadLocalGameSession,
  loadTopologyLocalGameSession,
  persistLocalGameSession,
  persistTopologyLocalGameSession,
} from "./LocalGameSession.js?v=20261029-unified-r1";
import {
  createReplayDocument,
  createTopologyReplayDocument,
  downloadReplayDocument,
  parseAndValidateReplay,
  TOPOLOGY_REPLAY_FORMAT,
  validateTopologyReplayDocument,
} from "./ReplayCodec.js?v=20261029-unified-r1";
import { TrainingContribution, ContributionPanel, supportsContributionActors } from "./TrainingContribution.js?v=20261029-unified-r1";
import { localAIPlayer, localMatchActors, localMatchMode, localPlayerProfile, normalizeLocalPlayers, normalizeLocalPlayerDraft, prepareLocalPlayersForNewMatch, supportsRootModeAI, loadLocalMatchPreferences, persistLocalMatchPreferences } from "./LocalAIModes.js?v=20261029-unified-r1";
import { roomSettingsFromBoard, normalizeRoomPlayerSetup } from "./OnlineRoomSettings.js?v=20261029-unified-r1";
import LocalPlayerSetup from "./LocalPlayerSetup.js?v=20261031-turn-order";
import TurnOrderSetup, { resizeTurnOrder } from "./TurnOrderSetup.js?v=20261031-turn-order";
import StartingPointSetup from "./StartingPointSetup.js?v=20261029-unified-r1";
import TopologyStartingPointSetup, { topologyDefaultDefinition } from "./TopologyStartingPointSetup.js?v=20261029-unified-r1";
import { createTopologyStartingDefinition, prepareTopologyNewMatchSettings } from "./TopologyStartingPoints.js?v=20261029-unified-r1";
import { randomInitialPositions, randomInitialRoots, requiresExplicitStartingPoints, startingPointSettings } from "./StartingPoints.js?v=20261029-unified-r1";
import { resolveInitialPositions, resolveBoardShape, RootMode } from "./GameEngine.js?v=20261029-unified-r1";
import { normalizeUndoUsage, recordUndoAction, createLocalUndoTimeline, planLocalUndo, consumeLocalUndo } from "./LocalUndo.js?v=20261029-unified-r1";
import { compileBoard } from "./BoardCompiler.js?v=20261029-unified-r1";
import { createProductSurfacePreset as createSurfacePreset, PRODUCT_SURFACE_PRESETS } from "./ProductSurfacePresets.js?v=20261030-topology-fix";
import { generateBoard, randomBoardGeometrySignature } from "./RandomBoard.js?v=20261029-unified-r1";
import { TOPOLOGY_AI_ROUTE } from "./TopologyAIAdapter.js?v=20261029-unified-r1";
import { TopologyGraphicEditor } from "./TopologyGraphicEditor.js?v=20261029-unified-r1";
import { SharedLadderPanel } from "./SharedLadder.js?v=20261029-unified-r1";
import { mountTopologySurface3D } from "./TopologySurface3D.js?v=20261029-unified-r1";
import { TOPOLOGY_TUTORIAL_STEPS, topologyTutorialText } from "./TopologyTutorial.js?v=20261029-unified-r1";
import {
  addBoundaryVertex,
  addSeamPair,
  cancelBoardDraft,
  closeBoundaryDraft,
  createBoardDraft,
  startBoundaryRing,
  deleteBoundaryRing,
  undoBoundaryVertex,
} from "./BoardEditor.js?v=20261029-unified-r1";
import { decodeTopologyState } from "./TopologyStateCodec.js?v=20261029-unified-r1";

const {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} = globalThis.Vue ?? {};

if (!globalThis.Vue) {
  throw new Error("Vue runtime is not available on window.Vue.");
}

// OnlineApp 鏄仈鏈虹増椤甸潰鍏ュ彛銆?// 缁勪欢瀹氫箟鍜屼笟鍔℃祦绋嬮兘鏀惧湪杩欓噷锛屼絾閫氱敤鐘舵€佸伐鍏蜂笌鏂囨宸茬粡鎷嗗埌鐙珛妯″潡銆?
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
  } catch (_e) {
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
    if (/^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(parsed.hostname)) {
      return dynamicUrl;
    }
    return parsed.toString();
  } catch (_e) {
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
  } catch (_e) {
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
  } catch (_e) {
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
      } catch (_e) {
        continue;
      }
    }
  }

  let data = null;
  try {
    data = await response.json();
  } catch (_e) {
    data = null;
  }

  if (!response.ok) {
    throw new Error(data?.detail ?? `HTTP ${response.status}`);
  }

  return {
    ...data,
    apiBaseUrl: activeApiBaseUrl,
    authOrigin: new URL(response.url || activeApiBaseUrl).origin,
  };
}

const ROOM_START_COUNTDOWN_FALLBACK_SECONDS = 20;
const CHAT_EMOJI_OPTIONS = Object.freeze([
  { content: "\u{1F44F}", animation: "bounce", duration: 1200, label: "Nice" },
  { content: "\u{1F62D}", animation: "bounce", duration: 1200, label: "Crying" },
  { content: "\u{1F60E}", animation: "bounce", duration: 1200, label: "Cool" },
  { content: "\u{1F91D}", animation: "fade", duration: 1400, label: "Respect" },
  { content: "\u2753", animation: "shake", duration: 1000, label: "Question" },
  { content: "\u{1F914}", animation: "fade", duration: 1400, label: "Thinking" },
  { content: "\u{1F480}", animation: "shake", duration: 1100, label: "Defeated" },
  { content: "\u{1F44E}", animation: "shake", duration: 1200, label: "Thumbs down" },
  { content: "\u{1F613}", animation: "fade", duration: 1300, label: "Sweating" },
  { content: "\u{1F624}", animation: "bounce", duration: 1200, label: "Pressure" },
]);
const CHAT_EMOJI_ANIMATIONS = new Set(["bounce", "fade", "shake"]);

function hashChatEmojiSeed(seed) {
  const source = String(seed ?? "");
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createChatEmojiRandom(seed) {
  let state = hashChatEmojiSeed(seed) || 1;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function normalizeChatEmojiDisplay(display) {
  if (!display || typeof display !== "object") {
    return null;
  }

  const readNumber = (key, minimum, maximum) => {
    const value = Number(display[key]);
    if (!Number.isFinite(value)) {
      return null;
    }
    return Math.max(minimum, Math.min(maximum, Math.round(value)));
  };
  const x = readNumber("x", -20, 120);
  const y = readNumber("y", -20, 120);
  const dx = readNumber("dx", -120, 120);
  const mx = readNumber("mx", -80, 80);
  const dy = readNumber("dy", -160, 80);
  if ([x, y, dx, mx, dy].some((value) => value === null)) {
    return null;
  }

  const colorClass = ["blue", "red", "purple", "green", "orange", "cyan"].includes(display.colorClass)
    ? display.colorClass
    : "blue";
  return {
    x,
    y,
    dx,
    mx,
    dy,
    colorClass,
  };
}

function createEmptyRoomInfo() {
  return {
    status: "solo",
    hostPlayerId: null,
    players: [],
    settings: normalizeAppGameSettings(),
    countdownEndsAt: null,
    matchPhase: "solo",
    undo: { usedCount: 0, pending: false, votes: [], requiredVotes: 0 },
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
  [Player.GREEN]: "player-accent-green",
  [Player.ORANGE]: "player-accent-orange",
  [Player.CYAN]: "player-accent-cyan",
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
  if (player?.isBot) return `${roleLabel} AI`;
  const identity = player?.username ?? player?.playerId ?? "";

  if (!identity) {
    return roleLabel;
  }

  return uiStyle === UI_STYLE_ACADEMIC ? `${roleLabel} / ${identity}` : identity;
}

function formatIndexedPlayerName(player, players, language) {
  const activePlayers = Array.isArray(players) && players.length
    ? players
    : [Player.BLACK, Player.WHITE];
  const index = Math.max(0, activePlayers.indexOf(player)) + 1;
  return language === "en" ? `Player ${index}` : `玩家 ${index}`;
}

function formatGamePlayerName(player, players, roomPlayers, language, uiStyle) {
  if (findRoomPlayerByColor(roomPlayers, player)?.isBot) {
    return resolveOnlinePlayerName(roomPlayers, player, language, uiStyle);
  }
  const activePlayers = Array.isArray(players) && players.length
    ? players
    : [Player.BLACK, Player.WHITE];
  if (activePlayers.length >= 3 && uiStyle !== UI_STYLE_ACADEMIC) {
    const roomPlayer = findRoomPlayerByColor(roomPlayers, player);
    const identity = roomPlayer?.username ?? roomPlayer?.playerId ?? "";
    return identity || formatIndexedPlayerName(player, activePlayers, language);
  }
  return formatAppPlayerName(player, language, uiStyle);
}

function formatGameWinner(winner, players, roomPlayers, language, uiStyle) {
  const texts = getAppTexts(language, uiStyle);
  if (winner === "DRAW") {
    return texts.draw;
  }
  if (!APP_ALL_PLAYERS.includes(winner)) {
    return texts.inProgress;
  }
  if (uiStyle === UI_STYLE_ACADEMIC) {
    return formatAppWinner(winner, language, uiStyle);
  }
  const playerName = formatGamePlayerName(winner, players, roomPlayers, language, uiStyle);
  return language === "en" ? `${playerName} Wins` : `${playerName}获胜`;
}

function formatGameScoreLine(scores, players, roomPlayers, language, uiStyle) {
  const activePlayers = Array.isArray(players) && players.length
    ? players
    : [Player.BLACK, Player.WHITE];
  return activePlayers
    .filter((player) => scores && Object.prototype.hasOwnProperty.call(scores, player))
    .map((player) => `${formatGamePlayerName(player, activePlayers, roomPlayers, language, uiStyle)} ${formatAppArea(scores[player])}`)
    .join(language === "en" ? ", " : "，");
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
      name: formatGamePlayerName(player, activePlayers, roomPlayers, language, uiStyle),
      value: scores?.[player],
      accentClass: getPlayerAccentClass(player),
    }));
}

function formatResignationScoreLine({
  scores,
  players,
  resignedPlayers,
  winner,
  roomPlayers,
  language,
  uiStyle,
}) {
  const activePlayers = Array.isArray(players) && players.length
    ? players
    : [Player.BLACK, Player.WHITE];
  const resignedSet = new Set(Array.isArray(resignedPlayers) ? resignedPlayers : []);
  const resigned = activePlayers.filter((player) => resignedSet.has(player));
  if (!resigned.length) {
    return "";
  }

  const playerName = (player) => formatGamePlayerName(player, activePlayers, roomPlayers, language, uiStyle);
  const separator = language === "en" ? ", " : "\uFF0C";
  const remaining = activePlayers.filter((player) => !resignedSet.has(player));

  if (remaining.length <= 1 && winner && winner !== "DRAW") {
    const resignedNames = resigned.map(playerName).join(separator);
    const winnerName = playerName(winner);
    return language === "en"
      ? `${resignedNames} resigned, ${winnerName} wins`
      : `${resignedNames}\u8BA4\u8F93\uFF0C${winnerName}\u80DC\u5229`;
  }

  const resignedParts = resigned.map((player) => (
    language === "en" ? `${playerName(player)} resigned` : `${playerName(player)}\u8BA4\u8F93`
  ));
  const scoreParts = remaining.map((player) => (
    `${playerName(player)} ${formatAppArea(scores?.[player])}`
  ));
  return [...resignedParts, ...scoreParts].join(separator);
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
    localPending: { type: Boolean, default: false },
  },
  setup(props) {
    const texts = computed(() => getAppTexts(props.language, props.uiStyle));
    const isOnlineMatch = computed(() => Boolean(props.session?.roomId));
    const activePlayers = computed(() => (
      Array.isArray(props.gameState.players) && props.gameState.players.length
        ? props.gameState.players
        : [Player.BLACK, Player.WHITE]
    ));
    const currentPlayerLabel = computed(() => (
      formatGamePlayerName(
        props.gameState.currentPlayer,
        activePlayers.value,
        isOnlineMatch.value ? props.roomPlayers : [],
        props.language,
        props.uiStyle,
      )
    ));
    const localRoleLabel = computed(() => formatAppPlayerName(props.session.color, props.language, props.uiStyle));
    const winnerLabel = computed(() => formatGameWinner(
      props.gameState.winner,
      activePlayers.value,
      isOnlineMatch.value ? props.roomPlayers : [],
      props.language,
      props.uiStyle,
    ));
    const turnBannerClass = computed(() => `is-${getPlayerAccentClass(props.gameState.currentPlayer).replace("player-accent-", "")}`);
    const scoreCards = computed(() => {
      const players = activePlayers.value;
      const scores = getDisplayScores(props.gameState);
      const showPlayerNames = players.length >= 3;

      return players.map((player) => {
        const namedCard = {
          key: player,
          name: formatGamePlayerName(
            player,
            players,
            isOnlineMatch.value ? props.roomPlayers : [],
            props.language,
            props.uiStyle,
          ),
          accentClass: getPlayerAccentClass(player),
          isNamed: showPlayerNames,
        };

        const accent = getPlayerAccentClass(player).replace("player-accent-", "");
        return {
          ...namedCard,
          label: texts.value[`${accent}Territory`],
          value: scores?.[player],
          className: `score-card-${accent}`,
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
        <small>{{ localPending ? texts.localWaiting : winnerLabel }}</small>
      </div>

      <div class="score-grid" :aria-busy="gameState.territoryPending ? 'true' : 'false'">
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
          <strong>{{ gameState.territoryPending ? "…" : formatArea(card.value) }}</strong>
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
  components: { ContributionPanel, LocalPlayerSetup, StartingPointSetup, TurnOrderSetup },
  emits: [
    "update:player-count",
    "update:board-shape",
    "update:grid-size",
    "update:language",
    "update:ui-style",
    "update:turn-timer-enabled",
    "update:turn-time-limit-seconds",
    "update:hint-enabled",
    "update:hint-max-count",
    "update:undo-enabled",
    "update:undo-max-count",
    "update-local-player",
    "select-lab-model",
    "save-room-settings",
    "update:start-player",
    "update:turn-order",
    "swap-local-players",
    "start-local-match",
    "toggle-contributions",
    "retry-contributions",
    "update-starting-points",
    "open-topology-guide",
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
    boardShape: { type: String, required: true },
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
    hintEnabled: {
      type: Boolean,
      default: false,
    },
    hintMaxCount: {
      type: Number,
      default: 3,
    },
    undoEnabled: { type: Boolean, default: false },
    undoMaxCount: { type: Number, default: 3 },
    localPlayers: { type: Object, required: true },
    startPlayer: { type: String, required: true },
    turnOrder: { type: Array, required: true },
    localPending: { type: Boolean, default: true },
    localStarted: { type: Boolean, default: false },
    startingPoints: { type: Object, default: () => ({}) },
    roomSetupOpen: { type: Boolean, default: false },
    contributionState: { type: Object, required: true },
    aiAvailable: {
      type: Boolean,
      default: true,
    },
    onlineAvailable: { type: Boolean, default: false },
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
      contributionSupported: computed(() => supportsContributionActors(localMatchActors(props.localPlayers, props.playerCount, props.gridSize, props.boardShape), {
        rulesVersion: "territory-v3", playerCount: props.playerCount, gridSize: props.gridSize, boardShape: props.boardShape,
        hintEnabled: props.hintEnabled, undoEnabled: props.undoEnabled, undoMaxCount: props.undoMaxCount,
      })),
      PLAYER_COUNT_OPTIONS: APP_PLAYER_COUNT_OPTIONS,
      GRID_SIZE_OPTIONS: APP_GRID_SIZE_OPTIONS,
      TURN_TIMER_MAX_SECONDS: APP_TURN_TIMER_MAX_SECONDS,
      TURN_TIMER_MIN_SECONDS: APP_TURN_TIMER_MIN_SECONDS,
      HINT_MAX_COUNT_MIN: 1,
      HINT_MAX_COUNT_MAX: 10,
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
            <label id="player-count-label" class="field-label">{{ texts.playerCountLabel }}</label>
            <div
              id="player-count"
              class="language-switcher language-switcher-inline player-count-choices"
              role="radiogroup"
              aria-labelledby="player-count-label"
            >
              <button
                v-for="count in PLAYER_COUNT_OPTIONS"
                :key="count"
                type="button"
                class="language-button"
                :class="{ 'is-active': playerCount === count }"
                role="radio"
                :aria-checked="playerCount === count"
                :disabled="busy || settingsLocked || (boardShape === 'custom' && count > 6)"
                @click="$emit('update:player-count', count)"
              >
                {{ count }}
              </button>
            </div>
          </div>
          <div class="settings-grid-item-wide" v-if="aiAvailable || roomSetupOpen">
            <LocalPlayerSetup :texts="texts" :language="language" :players="localPlayers" :player-count="playerCount" :board-shape="boardShape"
              :root-mode="startingPoints.rootMode ?? 'classic'" :grid-size="gridSize"
              :online="roomSetupOpen"
              :initial-positions="startingPoints.initialPositions"
              :start-player="startPlayer" :show-starter="false" :pending="localPending" :started="localStarted" :locked="busy || settingsLocked"
              @update-player="$emit('update-local-player', $event)" @select-lab-model="$emit('select-lab-model', $event)" @update:start-player="$emit('update:start-player', $event)"
              @swap="$emit('swap-local-players')" @start="$emit('start-local-match')" @open-topology-guide="$emit('open-topology-guide')">
              <template #contribution>
                <ContributionPanel v-if="!roomSetupOpen && boardShape !== 'custom'" :language="language" :state="contributionState" :supported="contributionSupported" @toggle="$emit('toggle-contributions', $event)" @retry="$emit('retry-contributions')" />
              </template>
            </LocalPlayerSetup>
          </div>
          <div v-if="aiAvailable || roomSetupOpen" class="settings-grid-item-wide"><TurnOrderSetup :order="turnOrder" :language="language" :ui-style="uiStyle" :locked="busy || settingsLocked" @change="$emit('update:turn-order', $event)" /></div>
          <button v-if="roomSetupOpen" type="button" class="action-button action-button-primary" :disabled="busy || settingsLocked" @click="$emit('save-room-settings')">{{ language === 'zh' ? '保存房间设置' : 'Save room settings' }}</button>
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
          <div v-if="aiAvailable || onlineAvailable" class="settings-grid-item-wide">
            <label id="board-shape-label" class="field-label">{{ texts.boardShapeLabel }}</label>
            <div id="board-shape" class="language-switcher language-switcher-inline" role="radiogroup" aria-labelledby="board-shape-label">
              <button v-for="shape in ['triangle', 'diamond', 'hexagon', 'custom']" :key="shape" type="button" class="language-button"
                :class="{ 'is-active': boardShape === shape }" role="radio" :aria-checked="boardShape === shape"
                :data-board-shape="shape" :disabled="busy || settingsLocked" @click="$emit('update:board-shape', shape)">
                {{ shape === 'triangle' ? texts.triangleBoard : shape === 'diamond' ? (texts.diamondBoard ?? (language === 'zh' ? '菱形' : 'Diamond')) : shape === 'hexagon' ? texts.hexagonBoard : (language === 'zh' ? '拓扑棋盘' : 'Topology board') }}
              </button>
            </div>
          </div>
          <div v-if="boardShape === 'custom'" class="settings-grid-item-wide"><slot name="topology-feedback"></slot></div>
          <div v-if="boardShape === 'custom'" class="settings-grid-item-wide topology-setup-slot">
            <slot name="topology"></slot>
          </div>
          <StartingPointSetup v-if="(aiAvailable || onlineAvailable) && boardShape !== 'custom'" class="settings-grid-item-wide" :texts="texts" :language="language" :online="onlineAvailable"
            :player-count="playerCount" :board-shape="boardShape" :grid-size="gridSize" :selection="startingPoints" :locked="busy || settingsLocked"
            @update="$emit('update-starting-points', $event)" @start="$emit('start-local-match')" />
          <div class="settings-grid-item-wide settings-timing-row">
            <div class="settings-timing-controls">
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
          <div>
            <label class="field-label" for="turn-time-limit">{{ texts.turnTimerDurationLabel }}</label>
            <input
              id="turn-time-limit"
              class="input-field input-field-compact"
              type="number"
              :min="TURN_TIMER_MIN_SECONDS"
              :max="TURN_TIMER_MAX_SECONDS"
              :value="turnTimeLimitSeconds"
              :disabled="busy || settingsLocked || !turnTimerEnabled"
              @change="$emit('update:turn-time-limit-seconds', Number($event.target.value))"
            />
          </div>
          <div v-if="(playerCount <= 3 && boardShape === 'triangle') || boardShape === 'custom'">
            <label class="field-label" for="hint-enabled">{{ texts.hintSwitchLabel }}</label>
            <label class="toggle-field" for="hint-enabled">
              <input
                id="hint-enabled"
                type="checkbox"
                :checked="hintEnabled"
                :disabled="busy || settingsLocked"
                @change="$emit('update:hint-enabled', $event.target.checked)"
              />
              <span>{{ hintEnabled ? texts.toggleOn : texts.toggleOff }}</span>
            </label>
          </div>
          <div v-if="(playerCount <= 3 && boardShape === 'triangle') || boardShape === 'custom'">
            <label class="field-label" for="hint-max-count">{{ texts.hintMaxCountLabel }}</label>
            <input
              id="hint-max-count"
              class="input-field input-field-compact"
              type="number"
              :min="HINT_MAX_COUNT_MIN"
              :max="HINT_MAX_COUNT_MAX"
              :value="hintMaxCount"
              :disabled="busy || settingsLocked || !hintEnabled"
              @change="$emit('update:hint-max-count', Number($event.target.value))"
            />
          </div>
          <div v-if="aiAvailable || onlineAvailable">
            <label class="field-label" for="undo-enabled">{{ texts.undoSwitchLabel }}</label>
            <label class="toggle-field" for="undo-enabled">
              <input id="undo-enabled" type="checkbox" :checked="undoEnabled"
                :disabled="busy || settingsLocked" @change="$emit('update:undo-enabled', $event.target.checked)" />
              <span>{{ undoEnabled ? texts.toggleOn : texts.toggleOff }}</span>
            </label>
          </div>
          <div v-if="aiAvailable || onlineAvailable">
            <label class="field-label" for="undo-max-count">{{ texts.undoMaxCountLabel }}</label>
            <input id="undo-max-count" class="input-field input-field-compact" type="number" min="1" max="100"
              :value="undoMaxCount" :disabled="busy || settingsLocked || !undoEnabled"
              @change="$emit('update:undo-max-count', Number($event.target.value))" />
          </div>
            </div>
            <p v-if="(aiAvailable || onlineAvailable) && undoEnabled" class="help-copy">{{ onlineAvailable ? texts.onlineUndoHelp : texts.undoHelp }}</p>
          </div>
        </div>
      </div>
    </section>
  `,
};

// Surface boards deliberately have a small, separate setup surface.  The
// legacy board-shape control only represents the fixed triangle/hexagon
// families; exposing a custom definition there would invite the old matrix
// normaliser to reinterpret it.  This panel produces a draft only.  The App
// compiles and freezes the definition (including all active starting seats)
// before it may be used for a local match or room.
const TopologySetupPanel = {
  name: "TopologySetupPanel",
  components: { TopologyGraphicEditor, TopologyStartingPointSetup },
  emits: [
    "select-preset",
    "generate-random",
    "update:seed",
    "update:draft-x",
    "update:draft-y",
    "update:definition-text",
    "draft-add",
    "draft-undo",
    "draft-close",
    "draft-reset",
    "draft-add-seam",
    "draft-new-ring",
    "draft-delete-ring",
    "update-starts",
    "definition-load",
  ],
  props: {
    language: { type: String, required: true },
    gridSize: { type: Number, required: true },
    playerCount: { type: Number, required: true },
    definition: { type: Object, default: null },
    boardHash: { type: String, default: "" },
    source: { type: String, default: "" },
    message: { type: String, default: "" },
    seed: { type: String, default: "surface-1" },
    draft: { type: Object, required: true },
    draftX: { type: Number, default: 0 },
    draftY: { type: Number, default: 0 },
    definitionText: { type: String, default: "" },
    locked: { type: Boolean, default: false },
    busy: { type: Boolean, default: false },
  },
  setup(props) {
    const tutorialStep = ref(-1);
    const seamA = ref("");
    const seamB = ref("");
    const seamDirection = ref("same");
    const zh = computed(() => props.language === "zh");
    const boundaryOccurrences = computed(() => props.draft?.boundaryOccurrenceIds ?? []);
    const canAddSeam = computed(() => Boolean(
      props.draft?.closed && seamA.value && seamB.value && seamA.value !== seamB.value,
    ));
    const formattedPath = computed(() => (props.draft?.path ?? [])
      .map((coordinate) => `(${coordinate[0]}, ${coordinate[1]})`).join(" → "));
    const addSeam = () => {
      if (!canAddSeam.value) return;
      props.draft && globalThis.Vue.nextTick(() => {
        // The parent allocates the stable seam ID after checking the current
        // compiled definition, so duplicate clicks cannot reuse stale input.
      });
    };
    return {
      zh,
      tutorialStep,
      seamA,
      seamB,
      seamDirection,
      boundaryOccurrences,
      canAddSeam,
      formattedPath,
      addSeam,
      presetNames: PRODUCT_SURFACE_PRESETS,
      topologyTutorialSteps: TOPOLOGY_TUTORIAL_STEPS,
      topologyTutorialText: (step) => topologyTutorialText(step, props.language),
      presetLabel: (name) => (zh.value ? {
        cylinder: "圆柱", mobius: "莫比乌斯带", torus: "环面",
        "klein-bottle": "克莱因瓶", tetrahedron: "三角锥", cone: "圆锥", sphere: "球面", "double-sphere": "双片球面", "double-torus": "双把手",
      } : {
        cylinder: "Cylinder", mobius: "Möbius strip", torus: "Torus",
        "klein-bottle": "Klein bottle", tetrahedron: "Tetrahedron", cone: "Cone", sphere: "Sphere", "double-sphere": "Two-chart sphere", "double-torus": "Double torus",
      })[name] ?? name,
      sourceLabel: (source) => ({
        "double-torus": zh.value ? "双把手" : "Double torus", "double-sphere": zh.value ? "双片球面" : "Two-chart sphere",
        "随机棋盘": zh.value ? "随机棋盘" : "random board", "random board": zh.value ? "随机棋盘" : "random board",
        "自定义起点": zh.value ? "自定义起点" : "custom starts", "custom starts": zh.value ? "自定义起点" : "custom starts",
        "绘制边界": zh.value ? "手绘轮廓" : "drawn contour", "drawn boundary": zh.value ? "手绘轮廓" : "drawn contour",
        "绘制边界粘合": zh.value ? "手绘轮廓粘合" : "drawn contour seams", "drawn boundary seams": zh.value ? "手绘轮廓粘合" : "drawn contour seams",
        "导入 JSON": zh.value ? "导入 JSON" : "imported JSON", "imported JSON": zh.value ? "导入 JSON" : "imported JSON",
      })[source] ?? ((zh.value ? {cylinder:"圆柱",mobius:"莫比乌斯带",torus:"环面","klein-bottle":"克莱因瓶",tetrahedron:"三角锥",cone:"圆锥",sphere:"球面"} : {cylinder:"Cylinder",mobius:"Möbius strip",torus:"Torus","klein-bottle":"Klein bottle",tetrahedron:"Tetrahedron",cone:"Cone",sphere:"Sphere"})[source] ?? (zh.value ? "自定义棋盘" : "custom board")),
    };
  },
  template: `
    <section class="topology-setup" :aria-label="zh ? '拓扑棋盘设置' : 'Topology board setup'">
      <div class="panel-head panel-head-inline">
        <h2>{{ zh ? '拓扑棋盘' : 'Topology board' }}</h2>
      </div>
      <div class="topology-tutorial">
        <button type="button" class="action-button action-button-secondary" :disabled="locked || busy" @click="tutorialStep = 0; $emit('select-preset', 'cylinder')">{{ zh ? '开始拓扑新手引导' : 'Start topology tutorial' }}</button>
        <div v-if="tutorialStep >= 0" role="status">
          <strong>{{ topologyTutorialText(topologyTutorialSteps[tutorialStep]).title }}</strong>
          <p>{{ topologyTutorialText(topologyTutorialSteps[tutorialStep]).instruction }}</p>
          <button type="button" class="language-button" @click="tutorialStep = -1">{{ zh ? '退出引导' : 'Exit tutorial' }}</button>
          <button v-if="tutorialStep < topologyTutorialSteps.length - 1" type="button" class="language-button" :disabled="locked || busy" @click="tutorialStep++; if (topologyTutorialSteps[tutorialStep].action.type === 'select-preset') $emit('select-preset', topologyTutorialSteps[tutorialStep].action.preset)">{{ zh ? '下一步' : 'Next' }}</button>
        </div>
      </div>

      <div class="settings-cluster settings-cluster-standalone">
        <label class="field-label">{{ zh ? '曲面预设' : 'Surface presets' }}</label>
        <div class="board-choice-grid board-choice-grid-3col" role="group" :aria-label="zh ? '曲面预设' : 'Surface presets'">
          <button v-for="name in presetNames" :key="name" type="button" class="board-choice-option board-choice-size"
            :disabled="locked || busy" @click="$emit('select-preset', name)">{{ presetLabel(name) }}</button>
        </div>
        <p v-if="gridSize % 2 === 0 && ['tetrahedron', 'cone', 'sphere'].includes(definition?.topology?.preset)" class="help-copy topology-preset-effective-size" role="status">
          {{ zh ? '实际细分点数：' + (gridSize - 1) : 'Actual subdivision points: ' + (gridSize - 1) }}
        </p>

        <div class="actions">
          <button type="button" class="action-button action-button-secondary" :disabled="locked || busy"
            @click="$emit('generate-random')">{{ zh ? '生成随机棋盘' : 'Generate random board' }}</button>
        </div>

        <details class="local-player-advanced">
          <summary>{{ zh ? '自定义地图' : 'Custom map' }}</summary>
          <TopologyGraphicEditor :draft="draft" :language="language" :grid-size="gridSize" :message="message" :disabled="locked || busy"
            @vertex="$emit('draft-add', $event)" @close="$emit('draft-close')"
            @undo="$emit('draft-undo')" @reset="$emit('draft-reset')" @seam="$emit('draft-add-seam', $event)"
            @new-ring="$emit('draft-new-ring')" @delete-ring="$emit('draft-delete-ring', $event)" />
        </details>

        <details class="local-player-advanced">
          <summary>{{ zh ? '导入完整棋盘 JSON' : 'Load complete board JSON' }}</summary>
          <p class="help-copy">{{ zh ? '高级入口：可表达任意合法的单位边粘合。错误定义不会替换当前棋盘。' : 'Advanced path: express any valid unit-edge pairing. An invalid definition never replaces the current board.' }}</p>
          <textarea class="input-field" :aria-label="zh ? '完整棋盘 JSON' : 'Complete board JSON'" rows="10" :value="definitionText" :disabled="locked || busy"
            @input="$emit('update:definition-text', $event.target.value)"></textarea>
          <div class="actions"><button type="button" class="action-button action-button-secondary" :disabled="locked || busy || !definitionText.trim()"
            @click="$emit('definition-load')">{{ zh ? '验证并使用 JSON' : 'Validate and use JSON' }}</button></div>
        </details>
      </div>
      <TopologyStartingPointSetup v-if="definition" :definition="definition" :player-count="playerCount" :language="language" :locked="locked || busy" @change="$emit('update-starts', $event)" />
      <p v-if="definition" class="success-copy">{{ zh ? '已选择：' : 'Selected: ' }}{{ sourceLabel(source) }}</p>
      <p v-if="message" :class="message.startsWith('ERROR:') ? 'error-copy' : 'help-copy'">{{ message.replace(/^ERROR:\s*/, '') }}</p>

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
    "update:bot-count",
    "retry-bots",
  ],
  props: {
    playerCount: { type: Number, default: 2 },
    boardShape: { type: String, default: "triangle" },
    botCount: { type: Number, default: 0 },
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
      "is-green": option.value === Player.GREEN,
      "is-orange": option.value === Player.ORANGE,
      "is-cyan": option.value === Player.CYAN,
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
        maxlength="8"
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
        <button v-if="isHost && roomInfo?.settings?.botCount && roomPlaying" type="button" class="action-button action-button-ghost" :disabled="busy" @click="$emit('retry-bots')">{{ texts.roomRetryBots }}</button>
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
              <span class="room-player-meta" v-if="player.isBot">{{ roomInfo?.settings?.playerCount >= 4 ? texts.localHexAI : texts.localThreeAI }}</span>
            </div>
            <span
              class="status-pill"
              :class="resolvePlayerState(player).className"
            >
              {{ resolvePlayerState(player).label }}
            </span>
          </article>
        </div>

        <div v-if="isHost && session.shared" class="host-controls">
          <button type="button" class="action-button action-button-secondary" :disabled="busy" @click="$emit('create-room')">{{ language === 'zh' ? '房间设置与行动顺序' : 'Room settings and turn order' }}</button>
        </div>
        <div v-if="isHost && !session.shared" class="host-controls">
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
  emits: ["skip", "reset", "emoji", "hint", "undo", "undo-reject", "toggle-ai-duel"],
  props: {
    aiDuel: { type: Boolean, default: false },
    aiDuelPaused: { type: Boolean, default: false },
    gameState: {
      type: Object,
      required: true,
    },
    skipDisabled: {
      type: Boolean,
      default: false,
    },
    tutorialSkipTarget: {
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
    turnTimerPhase: {
      type: String,
      default: "paused",
    },
    aiThinking: {
      type: Boolean,
      default: false,
    },
    aiLoading: {
      type: Boolean,
      default: false,
    },
    multiplayerEnabled: {
      type: Boolean,
      default: false,
    },
    hintEnabled: {
      type: Boolean,
      default: false,
    },
    hintRemainingCount: {
      type: Number,
      default: 3,
    },
    undoEnabled: { type: Boolean, default: false },
    undoRemainingCount: { type: Number, default: 0 },
    undoDisabled: { type: Boolean, default: true },
    onlineUndoPending: { type: Boolean, default: false },
    onlineUndoVoted: { type: Boolean, default: false },
    onlineUndoVotes: { type: Number, default: 0 },
    onlineUndoRequiredVotes: { type: Number, default: 0 },
    hintThinking: {
      type: Boolean,
      default: false,
    },
    hintDisabled: {
      type: Boolean,
      default: false,
    },
    hintFeedback: {
      type: String,
      default: "",
    },
    resumeNotice: {
      type: String,
      default: "",
    },
    actionFeedback: {
      type: String,
      default: "",
    },
    actionFeedbackTone: {
      type: String,
      default: "neutral",
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
      formatGamePlayerName(
        props.gameState.currentPlayer,
        props.gameState.players,
        props.session?.roomId ? props.roomPlayers : [],
        props.language,
        props.uiStyle,
      )
    ));
    const turnTimerLabel = computed(() => (
      props.turnTimerEnabled
        ? (
          props.turnTimerPhase === "finished"
            ? texts.value.countdownFinished
            : props.turnTimerPhase === "paused"
              ? texts.value.countdownPaused
              : texts.value.turnTimerStatus(Math.max(0, props.turnTimerRemaining))
        )
        : ""
    ));
    const turnBannerClass = computed(() => `is-${getPlayerAccentClass(props.gameState.currentPlayer).replace("player-accent-", "")}`);
    const hintLabel = computed(() => (
      props.hintRemainingCount === 0
        ? texts.value.hintExhausted
        : formatAppHintRemaining(texts.value, props.hintRemainingCount)
    ));

    return {
      currentPlayerLabel,
      hintLabel,
      texts,
      turnTimerLabel,
      turnBannerClass,
    };
  },
  template: `
    <section class="panel panel-controls duel-strip">
      <div class="duel-top-row">
        <div class="duel-copy">
          <p class="duel-label">{{ texts.currentTurnLabel }}</p>
          <div class="turn-banner duel-turn-banner" :class="turnBannerClass">
            <span class="turn-dot"></span>
            <strong>{{ currentPlayerLabel }}{{ texts.turnSuffix }}</strong>
            <small v-if="aiThinking" class="duel-timer-copy">{{ aiLoading ? texts.aiLoading : texts.aiThinking }}</small>
            <small v-if="hintFeedback && !multiplayerEnabled && hintEnabled" class="duel-timer-copy">{{ hintFeedback }}</small>
            <small v-if="resumeNotice" class="duel-timer-copy">{{ resumeNotice }}</small>
            <small v-if="turnTimerEnabled" class="duel-timer-copy">{{ turnTimerLabel }}</small>
          </div>
        </div>
        <div class="actions duel-actions">
          <button v-if="aiDuel && !gameState.gameOver" type="button" class="action-button action-button-primary" @click="$emit('toggle-ai-duel')">{{ aiDuelPaused ? texts.aiDuelResume : texts.aiDuelPause }}</button>
          <button
            v-if="!multiplayerEnabled && hintEnabled"
            class="action-button action-button-primary"
            style="font-size: 0.85em; padding: 4px 10px;"
            :disabled="hintDisabled"
            @click="$emit('hint')"
          >
            {{ hintLabel }}
          </button>
          <button v-if="undoEnabled" type="button" class="action-button action-button-primary"
            :disabled="undoDisabled" :title="multiplayerEnabled ? texts.onlineUndoHelp : texts.undoHelp" @click="$emit('undo')">
            {{ multiplayerEnabled && onlineUndoPending ? (onlineUndoVoted ? texts.onlineUndoWaiting : texts.onlineUndoAgree) : texts.undoRemaining(undoRemainingCount) }}
          </button>
          <button v-if="multiplayerEnabled && undoEnabled && onlineUndoPending" type="button" class="action-button action-button-secondary"
            @click="$emit('undo-reject')">{{ onlineUndoVoted ? texts.onlineUndoCancel : texts.onlineUndoReject }}</button>
          <small v-if="multiplayerEnabled && undoEnabled && onlineUndoPending" role="status">{{ texts.onlineUndoVotes(onlineUndoVotes, onlineUndoRequiredVotes) }}</small>
          <button class="action-button action-button-primary" :class="{ 'tutorial-action-target': tutorialSkipTarget }" :disabled="skipDisabled" @click="$emit('skip')">
            {{ texts.skipTurnAction }}
          </button>
          <button class="action-button action-button-secondary" :disabled="resetDisabled" @click="$emit('reset')">
            {{ resetLabel }}
          </button>
        </div>
      </div>
      <p class="action-feedback" :class="actionFeedback ? 'is-' + actionFeedbackTone : 'is-empty'" aria-live="polite">
        {{ actionFeedback }}
      </p>
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

const ReplayPanel = {
  name: "ReplayPanel",
  emits: ["export", "import-file", "review-current", "review-imported", "exit-review"],
  props: {
    language: { type: String, required: true },
    actionCount: { type: Number, default: 0 },
    replayDocument: { type: Object, default: null },
    importedReady: { type: Boolean, default: false },
    canReview: { type: Boolean, default: false },
    replayMode: { type: Boolean, default: false },
    busy: { type: Boolean, default: false },
    error: { type: String, default: "" },
  },
  setup(props, { emit }) {
    const fileInput = ref(null);
    const copy = computed(() => props.language === "zh"
      ? {
          title: "复盘模式",
          description: "从这里打开复盘，棋盘和时间轴会回到主界面。",
          exportAction: "导出棋谱",
          importAction: "导入棋谱",
          reviewCurrent: "复盘本局",
          reviewImported: "复盘导入棋谱",
          exitAction: "退出复盘",
          empty: "本局还没有可复盘的步骤。下棋后再来，或导入棋谱。",
          imported: "已导入并验证棋谱",
          active: "复盘已在主界面打开。",
          step: "步",
          busy: "正在校验…",
        }
      : {
          title: "Review mode",
          description: "Open review here, then use the board and timeline on the main screen.",
          exportAction: "Export replay",
          importAction: "Import replay",
          reviewCurrent: "Review this match",
          reviewImported: "Review imported replay",
          exitAction: "Exit review",
          empty: "No moves to review yet. Play a move or import a replay.",
          imported: "Imported replay verified",
          active: "Review is open on the main screen.",
          step: "steps",
          busy: "Verifying…",
        });
    const openFilePicker = () => fileInput.value?.click();
    const handleFileChange = (event) => {
      const file = event.target.files?.[0] ?? null;
      event.target.value = "";
      if (file) return file.text().then((text) => emit("import-file", text));
      return null;
    };
    return { copy, fileInput, handleFileChange, openFilePicker };
  },
  template: `
    <section class="replay-panel panel panel-subtle" aria-live="polite">
      <div class="replay-panel-head">
        <div>
          <p class="panel-kicker">{{ copy.title }}</p>
        </div>
        <span class="status-pill" v-if="replayMode">{{ copy.active }}</span>
      </div>
      <div class="replay-panel-switch">
        <button v-if="replayMode" type="button" class="action-button action-button-primary" :disabled="busy" @click="$emit('exit-review')">{{ copy.exitAction }}</button>
        <template v-else>
          <button type="button" class="action-button action-button-primary" :disabled="busy || !canReview || actionCount === 0" @click="$emit('review-current')">{{ copy.reviewCurrent }}<span v-if="actionCount"> · {{ actionCount }} {{ copy.step }}</span></button>
          <button v-if="importedReady" type="button" class="action-button action-button-secondary" :disabled="busy || !canReview" @click="$emit('review-imported')">{{ copy.reviewImported }} · {{ replayDocument.actions.length }} {{ copy.step }}</button>
        </template>
      </div>
      <div class="replay-panel-actions">
        <button type="button" class="action-button action-button-ghost" :disabled="busy || replayMode || !canReview || actionCount === 0" @click="$emit('export')">{{ copy.exportAction }}</button>
        <button type="button" class="action-button action-button-ghost" :disabled="busy || replayMode || !canReview" @click="openFilePicker">{{ busy ? copy.busy : copy.importAction }}</button>
        <input ref="fileInput" class="replay-file-input" type="file" accept="application/json,.json" @change="handleFileChange" />
      </div>
      <p v-if="!replayMode && actionCount === 0 && !importedReady" class="help-copy">{{ copy.empty }}</p>
      <p v-else-if="!replayMode && importedReady" class="help-copy">{{ copy.imported }}</p>
      <p v-if="error" class="error-copy replay-error">{{ error }}</p>
    </section>
  `,
};

function formatReplayMovePosition(event) {
  const position = event?.vertexId ?? event?.point;
  if (Array.isArray(position) && position.length === 2) return `(${position.join(", ")})`;
  if (typeof position === "string" && position) return `(${position})`;
  return "";
}

const REPLAY_NODE_STATES = new Set([
  PointState.BLACK_NODE, PointState.WHITE_NODE, PointState.PURPLE_NODE,
  PointState.GREEN_NODE, PointState.ORANGE_NODE, PointState.CYAN_NODE,
]);

// Topology replay events deliberately contain only committed actions and
// hashes. Derive presentation-only effects in an isolated engine, leaving the
// signed document and the live/review controller untouched.
export function topologyReplayInspectionEffects(document, cursor) {
  if (!document?.initialState?.topologyState || !Number.isInteger(cursor) || cursor < 1 || cursor > document.actions?.length) return null;
  const decoded = decodeTopologyState(document.initialState.topologyState);
  const engine = new GameEngine({
    compiledBoard: decoded.board,
    playerCount: Object.keys(decoded.ruleState.startingVertices).length,
    startPlayer: decoded.ruleState.turnOrder?.[0] ?? decoded.ruleState.currentPlayer,
    ...(decoded.ruleState.turnOrder !== undefined ? { turnOrder: decoded.ruleState.turnOrder } : {}),
    rulesVersion: decoded.ruleState.rulesVersion,
    deferTerritoryUpdates: false,
  });
  engine.restoreTopologyState(document.initialState.topologyState);
  let before, after;
  for (let i = 0; i < cursor; i += 1) {
    const event = document.actions[i];
    if (i === cursor - 1) before = engine.getSnapshot();
    const result = event.type === "move" ? engine.playMove(event.vertexId)
      : event.type === "skip" ? engine.skipTurn()
        : event.type === "resign" ? engine.resignPlayer(event.actor) : null;
    if (!result?.success) throw new Error("Topology replay inspection could not reproduce an action.");
    if (i === cursor - 1) after = engine.getSnapshot();
  }
  const capturedPoints = Object.entries(before.boardStates ?? {})
    .filter(([id, state]) => REPLAY_NODE_STATES.has(state) && after.boardStates?.[id] !== state)
    .map(([id]) => id);
  const addedEdgesByPlayer = Object.fromEntries((before.players ?? []).map((player) => {
    const previous = new Set(before.edges?.[player] ?? []);
    return [player, (after.edges?.[player] ?? []).filter(edge => !previous.has(edge))];
  }));
  const territoryDelta = Object.fromEntries((before.players ?? []).map((player) => [
    player, Number(after.territories?.[player]?.area ?? 0) - Number(before.territories?.[player]?.area ?? 0),
  ]));
  return { capturedPoints, addedEdgesByPlayer, territoryDelta, gameEnded: Boolean(after.gameOver && !before.gameOver) };
}

const ReplayControls = {
  name: "ReplayControls",
  emits: ["seek", "toggle-play", "toggle-inspector", "exit-review"],
  props: {
    language: { type: String, required: true },
    uiStyle: { type: String, required: true },
    replayDocument: { type: Object, required: true },
    cursor: { type: Number, default: 0 },
    event: { type: Object, default: null },
    playing: { type: Boolean, default: false },
    inspectorOpen: { type: Boolean, default: false },
    error: { type: String, default: "" },
  },
  setup(props) {
    const copy = computed(() => props.language === "zh"
      ? { mode: "复盘中", start: "起点", move: "落子", skip: "跳过", resign: "认输", rootRelocate: "迁移起点", rootAdd: "增设起点", first: "到起点", previous: "上一步", next: "下一步", last: "到终点", play: "播放", pause: "暂停", details: "查看这一步", hideDetails: "收起分析", progress: "复盘进度", exit: "退出复盘" }
      : { mode: "Review", start: "Starting position", move: "played", skip: "skipped", resign: "resigned", rootRelocate: "relocated root", rootAdd: "added root", first: "First", previous: "Previous", next: "Next", last: "Last", play: "Play", pause: "Pause", details: "Inspect move", hideDetails: "Hide details", progress: "Replay progress", exit: "Exit review" });
    const summary = computed(() => {
      const event = props.event;
      if (!event) return copy.value.start;
      const player = formatAppPlayerName(event.actor, props.language, props.uiStyle);
      const position = formatReplayMovePosition(event);
      const action = event.type === "move" ? `${copy.value.move}${position ? ` ${position}` : ""}` : event.type === "skip" ? copy.value.skip : event.type === "root_relocate" ? `${copy.value.rootRelocate}${position ? ` ${position}` : ""}` : event.type === "root_add" ? `${copy.value.rootAdd}${position ? ` ${position}` : ""}` : copy.value.resign;
      return `${player} · ${action}`;
    });
    return { copy, summary };
  },
  template: `
    <section class="panel replay-controls" :aria-label="language === 'zh' ? '复盘控制' : 'Replay controls'">
      <div class="replay-controls-head">
        <div class="replay-controls-copy">
          <strong>{{ copy.mode }} · {{ cursor }} / {{ replayDocument.actions.length }}</strong>
        </div>
        <div class="replay-controls-actions">
          <button type="button" class="action-button action-button-secondary" @click="$emit('exit-review')">{{ copy.exit }}</button>
        </div>
      </div>
      <div class="replay-transport">
        <button type="button" class="action-button replay-step-button" :aria-label="copy.first" :title="copy.first" :disabled="cursor === 0" @click="$emit('seek', 0)">|◀</button>
        <button type="button" class="action-button replay-step-button" :aria-label="copy.previous" :title="copy.previous" :disabled="cursor === 0" @click="$emit('seek', cursor - 1)">◀</button>
        <button type="button" class="action-button replay-step-button" :aria-label="playing ? copy.pause : copy.play" :title="playing ? copy.pause : copy.play" :disabled="cursor === replayDocument.actions.length && !playing" @click="$emit('toggle-play')">{{ playing ? 'Ⅱ' : '▶' }}</button>
        <button type="button" class="action-button replay-step-button" :aria-label="copy.next" :title="copy.next" :disabled="cursor === replayDocument.actions.length" @click="$emit('seek', cursor + 1)">▶</button>
        <button type="button" class="action-button replay-step-button" :aria-label="copy.last" :title="copy.last" :disabled="cursor === replayDocument.actions.length" @click="$emit('seek', replayDocument.actions.length)">▶|</button>
        <label class="replay-progress">
          <input class="replay-range" type="range" min="0" :max="replayDocument.actions.length" :value="cursor" :aria-label="copy.progress" @input="$emit('seek', Number($event.target.value))" />
        </label>
      </div>
      <p v-if="error" class="error-copy replay-error" role="alert">{{ error }}</p>
    </section>
  `,
};

const ReplayInspectorPanel = {
  name: "ReplayInspectorPanel",
  emits: ["inspect-point", "compare-ai"],
  props: {
    language: { type: String, required: true },
    gameState: { type: Object, required: true },
    event: { type: Object, default: null },
    cursor: { type: Number, default: 0 },
    selectedPoint: { type: [Array, String], default: null },
    aiComparison: { type: Object, default: null },
    aiComparisonBusy: { type: Boolean, default: false },
    aiComparisonError: { type: String, default: "" },
  },
  setup(props, { emit }) {
    const copy = computed(() => props.language === "zh"
      ? {
          title: "只读局面检查器",
          badge: "规则解释",
          readOnly: "只读：不会提交动作，也不会修改原对局。",
          start: "这是棋谱起点。规则引擎已载入初始节点与历史约束。",
          move: "落子",
          skip: "跳过回合",
          resign: "认输",
          rootRelocate: "迁移起点",
          rootAdd: "增设起点",
          changed: "规则效果",
          captured: "清除节点",
          edges: "新增连线",
          territoryDelta: "领土变化",
          capturedDetail: "清除",
          edgeDetail: "连线",
          currentPlayer: "当前行动方",
          legal: "当前合法落点",
          occupied: "已占节点",
          structure: "结构摘要",
          links: "连线",
          territory: "领土",
          candidates: "合法候选（只读）",
          candidateHint: "点击候选点只查看，不会把它下到棋盘上。",
          selected: "已查看候选点",
          overlaySelected: "金色环：查看中的候选点",
          overlayCaptured: "红色叉：本步清除节点",
          overlayEdges: "虚线：本步新增连线",
          aiTitle: "AI 对手比较",
          aiDescription: "在当前只读局面上比较规则搜索、PUCT、DQN、PPO、SAC、GAIL 与 GAN（双人 5–15）。搜索统计不是胜率。",
          aiRun: "运行候选比较",
          aiRunning: "正在比较…",
          aiDepth: "深度",
          aiGreedy: "规则贪心基线",
          aiMcts: "UCT-MCTS（64 次模拟）",
          aiMinimax: "启发式 Minimax",
          aiTime: "耗时",
          aiScore: "启发式分数",
          aiValue: "rollout value",
          aiVisits: "访问次数",
          aiPrior: "先验",
          aiPlayer: "分析方",
          aiNoMoves: "该局面没有可比较的候选点。",
          none: "本步没有检测到清除或领土变化。",
          effectsUnavailable: "本步变化信息暂不可用。",
          ended: "本步触发了终局结算。",
        }
      : {
          title: "Read-only position inspector",
          badge: "Rule explanation",
          readOnly: "Read-only: no action is submitted and the live match is not modified.",
          start: "Replay start. The engine loaded the initial nodes and history constraints.",
          move: "Move",
          skip: "Skip turn",
          resign: "Resign",
          rootRelocate: "Relocate root",
          rootAdd: "Add root",
          changed: "Rule effects",
          captured: "nodes cleared",
          edges: "new edges",
          territoryDelta: "territory delta",
          capturedDetail: "Cleared",
          edgeDetail: "Edge",
          currentPlayer: "Current player",
          legal: "Legal points now",
          occupied: "Occupied nodes",
          structure: "Structure summary",
          links: "edges",
          territory: "territory",
          candidates: "Legal candidates (read-only)",
          candidateHint: "Click a candidate to inspect it; it will not be played on the board.",
          selected: "Inspected candidate",
          overlaySelected: "Gold ring: inspected candidate",
          overlayCaptured: "Red cross: node cleared in this step",
          overlayEdges: "Dashed line: edge added in this step",
          aiTitle: "AI opponent comparison",
          aiDescription: "Compare rule search, PUCT, DQN, PPO, SAC, GAIL, and GAN policies (two-player boards, side lengths 5–15). Search statistics are not win probabilities.",
          aiRun: "Run candidate comparison",
          aiRunning: "Comparing…",
          aiDepth: "Depth",
          aiGreedy: "Rule-greedy baseline",
          aiMcts: "UCT-MCTS (64 simulations)",
          aiMinimax: "Heuristic Minimax",
          aiTime: "Time",
          aiScore: "Heuristic score",
          aiValue: "Rollout value",
          aiVisits: "Visits",
          aiPrior: "Prior",
          aiPlayer: "Analyzed player",
          aiNoMoves: "This position has no candidates to compare.",
          none: "No clearing or territory change was detected for this step.",
          effectsUnavailable: "Changes for this step are unavailable.",
          ended: "This step triggered terminal settlement.",
        });
    const playerName = (player) => APP_ALL_PLAYERS.includes(player) ? formatAppPlayerName(player, props.language, props.uiStyle) : player ?? "—";
    const occupiedCount = computed(() => {
      const snapshot = props.gameState.snapshot;
      const states = snapshot?.isTopologyBoard
        ? Object.values(snapshot.boardStates ?? {})
        : (snapshot?.boardMatrix?.flat?.() ?? []);
      return states.filter(state => REPLAY_NODE_STATES.has(state)).length;
    });
    const candidatePoints = computed(() => (props.gameState.legalMoves ?? [])
      .map((move) => (Array.isArray(move) || typeof move === "string" ? move : (move?.vertexId ?? move?.point)))
      .filter((point) => typeof point === "string" || (Array.isArray(point) && point.length === 2)));
    const structureStats = computed(() => (props.gameState.players ?? []).map((player) => ({
      player,
      edges: props.gameState.snapshot?.edges?.[player]?.length ?? 0,
      territory: props.gameState.snapshot?.territories?.[player]?.area ?? 0,
    })));
    const selectedCandidateLabel = computed(() => props.selectedPoint
      ? `${copy.value.selected}：${pointLabel(props.selectedPoint)}`
      : "");
    const aiRunLabel = (run) => run.label ?? (run.strategy === "greedy"
      ? copy.value.aiGreedy
      : run.strategy === "mcts"
        ? copy.value.aiMcts
        : `${copy.value.aiMinimax} ${copy.value.aiDepth} ${run.depth}`);
    const pointLabel = (point) => Array.isArray(point) ? `(${point[0]}, ${point[1]})` : String(point ?? "—");
    const edgeLabel = (edge) => String(edge ?? "")
      .split("|")
      .map((point) => {
        const [x, y] = point.split(",").map(Number);
        return Number.isFinite(x) && Number.isFinite(y) ? `(${x}, ${y})` : point;
      })
      .join(" → ");
    const effectDetails = computed(() => {
      const effects = props.event?.effects ?? {};
      const details = [];
      for (const point of effects.capturedPoints ?? []) {
        details.push(`${copy.value.capturedDetail} ${pointLabel(point)}`);
      }
      for (const [player, edges] of Object.entries(effects.addedEdgesByPlayer ?? {})) {
        for (const edge of edges ?? []) {
          details.push(`${copy.value.edgeDetail} ${playerName(player)} ${edgeLabel(edge)}`);
        }
      }
      for (const [player, delta] of Object.entries(effects.territoryDelta ?? {})) {
        if (delta) details.push(`${copy.value.territoryDelta} ${playerName(player)} ${delta > 0 ? "+" : ""}${delta}`);
      }
      return details;
    });
    const selectCandidate = (point) => {
      emit("inspect-point", Array.isArray(point) ? [...point] : point);
    };
    const eventSummary = computed(() => {
      if (!props.event) return copy.value.start;
      const actionLabel = props.event.type === "move" ? copy.value.move : props.event.type === "skip" ? copy.value.skip : props.event.type === "root_relocate" ? copy.value.rootRelocate : props.event.type === "root_add" ? copy.value.rootAdd : copy.value.resign;
      const actor = playerName(props.event.actor);
      const position = props.event.type === "move" ? formatReplayMovePosition(props.event) : "";
      const point = position ? ` ${position}` : "";
      if (!props.event.effects) return `${actionLabel} · ${actor}${point}。${copy.value.effectsUnavailable}`;
      const effects = props.event.effects;
      const capturedCount = effects.capturedPoints?.length ?? 0;
      const edgeCount = Object.values(effects.addedEdgesByPlayer ?? {}).flat().length;
      const territoryText = Object.entries(effects.territoryDelta ?? {})
        .filter(([, delta]) => delta)
        .map(([player, delta]) => `${playerName(player)} ${delta > 0 ? "+" : ""}${delta}`)
        .join("，");
      const details = [];
      if (capturedCount) details.push(`${capturedCount} ${copy.value.captured}`);
      if (edgeCount) details.push(`${edgeCount} ${copy.value.edges}`);
      if (territoryText) details.push(`${copy.value.territoryDelta}：${territoryText}`);
      if (!details.length) details.push(copy.value.none);
      if (effects.gameEnded) details.push(copy.value.ended);
      return `${actionLabel} · ${actor}${point}。${copy.value.changed}：${details.join("；")}`;
    });
    return {
      candidatePoints,
      copy,
      effectDetails,
      eventSummary,
      aiRunLabel,
      occupiedCount,
      playerName,
      pointLabel,
      selectCandidate,
      selectedCandidateLabel,
      structureStats,
    };
  },
  template: `
    <section class="replay-inspector panel panel-subtle" aria-live="polite">
      <div class="replay-panel-head">
        <div>
          <p class="panel-kicker">{{ copy.title }}</p>
          <p class="replay-panel-description">{{ copy.readOnly }}</p>
        </div>
        <span class="status-pill">{{ copy.badge }}</span>
      </div>
      <p class="replay-event-summary">{{ eventSummary }}</p>
      <div class="replay-overlay-legend" :aria-label="copy.title">
        <span><i class="replay-legend-mark is-selected"></i>{{ copy.overlaySelected }}</span>
        <span v-if="!gameState.isTopologyBoard"><i class="replay-legend-mark is-captured"></i>{{ copy.overlayCaptured }}</span>
        <span v-if="!gameState.isTopologyBoard"><i class="replay-legend-mark is-edge"></i>{{ copy.overlayEdges }}</span>
      </div>
      <ul v-if="effectDetails.length" class="replay-effect-details">
        <li v-for="detail in effectDetails" :key="detail">{{ detail }}</li>
      </ul>
      <div class="replay-inspector-grid">
        <div><span>{{ copy.currentPlayer }}</span><strong>{{ playerName(gameState.currentPlayer) }}</strong></div>
        <div><span>{{ copy.legal }}</span><strong>{{ gameState.legalMoves?.length ?? 0 }}</strong></div>
        <div><span>{{ copy.occupied }}</span><strong>{{ occupiedCount }}</strong></div>
      </div>
      <div class="replay-inspector-section">
        <p class="replay-inspector-label">{{ copy.structure }}</p>
        <div class="replay-structure-list">
          <div v-for="stat in structureStats" :key="stat.player" class="replay-structure-item">
            <strong>{{ playerName(stat.player) }}</strong>
            <span>{{ stat.edges }} {{ copy.links }} · {{ stat.territory }} {{ copy.territory }}</span>
          </div>
        </div>
      </div>
      <div class="replay-inspector-section">
        <p class="replay-inspector-label">{{ copy.candidates }}</p>
        <p class="replay-panel-description">{{ copy.candidateHint }}</p>
        <div class="replay-candidate-list">
          <button v-for="point in candidatePoints" :key="pointLabel(point)" type="button" class="replay-candidate-button" @click="selectCandidate(point)">
            {{ pointLabel(point) }}
          </button>
          <span v-if="!candidatePoints.length" class="help-copy">—</span>
        </div>
        <p v-if="selectedCandidateLabel" class="replay-candidate-selected">{{ selectedCandidateLabel }}</p>
      </div>
      <div class="replay-inspector-section replay-ai-exhibit">
        <div class="replay-ai-head">
          <div>
            <p class="replay-inspector-label">{{ copy.aiTitle }}</p>
            <p class="replay-panel-description">{{ gameState.isTopologyBoard ? (language === "zh" ? "比较拓扑通用 AI 在不同搜索深度下的候选；预算可能使搜索不完整。" : "Compare topology AI candidates at different depths; the search budget may leave results incomplete.") : gameState.playerCount >= 4 ? (language === "zh" ? "多人棋盘支持逐步复盘与规则检查；暂不提供 AI 对比。" : "Multiplayer boards support step-by-step replay and rule inspection. AI comparison is not available yet.") : copy.aiDescription }}</p>
          </div>
          <button type="button" class="action-button action-button-secondary" :disabled="aiComparisonBusy || (!gameState.isTopologyBoard && gameState.playerCount >= 4) || !gameState.legalMoves?.length" @click="$emit('compare-ai')">
            {{ aiComparisonBusy ? copy.aiRunning : copy.aiRun }}
          </button>
        </div>
        <p v-if="aiComparisonError" class="error-copy replay-error">{{ aiComparisonError }}</p>
        <div v-if="aiComparison" class="replay-ai-result">
          <p class="replay-ai-meta">{{ copy.aiPlayer }}：{{ playerName(aiComparison.player) }}</p>
          <div v-for="run in aiComparison.runs" :key="run.id" class="replay-ai-run">
            <div class="replay-ai-run-head">
              <strong>{{ aiRunLabel(run) }}</strong>
              <span>{{ run.elapsedMs }} ms</span>
            </div>
            <p v-if="run.searchInfo && (run.searchInfo.budgetExceeded || run.searchInfo.selective || !run.searchInfo.legalEnumerationComplete || run.searchInfo.partialIterationDiscarded)" class="help-copy">{{ language === 'zh' ? '搜索未完整覆盖请求深度或全部候选；结果仅供参考。' : 'Search did not fully cover the requested depth or all candidates; results are indicative.' }}</p>
            <ol v-if="run.moves.length" class="replay-ai-moves">
              <li v-for="(move, index) in run.moves" :key="run.id + '-' + (move.point ? pointLabel(move.point) : 'PASS')">
                <span>#{{ index + 1 }} {{ move.type === 'pass' ? 'PASS' : pointLabel(move.point) }}</span>
                <strong v-if="run.strategy === 'mcts' || run.strategy === 'neural-puct'">{{ copy.aiVisits }} {{ move.visits }} · {{ copy.aiValue }} {{ move.meanValue }}<template v-if="move.prior !== null"> · {{ copy.aiPrior }} {{ move.prior }}</template></strong>
                <strong v-else>{{ copy.aiScore }} {{ move.score }}</strong>
              </li>
            </ol>
            <p v-else-if="run.unavailableMessage" class="help-copy">{{ run.unavailableMessage }}</p>
            <p v-else-if="run.searchInfo?.fallbackReason === 'no-action-before-budget'" class="help-copy">{{ language === 'zh' ? '预算内未能完成任何合法动作的检查，请重试。' : 'No legal action could be checked within the budget; please retry.' }}</p>
            <p v-else class="help-copy">{{ copy.aiNoMoves }}</p>
          </div>
        </div>
      </div>
    </section>
  `,
};

const TutorialCard = {
  name: "TutorialCard",
  emits: ["continue", "skip", "guide"],
  props: {
    language: {
      type: String,
      required: true,
    },
    level: {
      type: Object,
      required: true,
    },
    success: {
      type: Boolean,
      default: false,
    },
    restrictionObserved: {
      type: Boolean,
      default: false,
    },
    attempts: {
      type: Number,
      default: 0,
    },
  },
  setup(props) {
    const copy = computed(() => {
      const zh = props.language === "zh";
      return {
        eyebrow: zh ? "第一次玩 · 蓝方 vs 红方" : "FIRST PLAY · Blue vs Red",
        title: zh ? props.level.titleZh : props.level.titleEn,
        instruction: props.level.restriction && props.restrictionObserved
          ? (zh ? props.level.allowedInstructionZh : props.level.allowedInstructionEn)
          : (zh ? props.level.instructionZh : props.level.instructionEn),
        success: zh ? props.level.successZh : props.level.successEn,
        target: props.level.objective?.type === "skip"
          ? (zh ? "目标：点击“跳过回合”" : "Goal: click “Skip Turn”")
          : (zh ? `目标：点击高亮节点 [${props.level.objective.point}]` : `Goal: click the highlighted node [${props.level.objective.point}]`),
        attempts: zh ? `尝试次数：${props.attempts}` : `Attempts: ${props.attempts}`,
        continue: props.level.id === "L5-settle-score"
          ? (zh ? "进入实战" : "Continue to a real match")
          : (zh ? "下一关" : "Next lesson"),
        skip: zh ? "跳过教学" : "Skip tutorial",
        guide: zh ? "查看指南舱" : "Open Guide cabin",
        final: props.level.id === "L5-settle-score",
      };
    });
    const parts = computed(() => (props.success ? copy.value.success : copy.value.instruction)
      .split(/(蓝方|红方|Blue|Red|高亮节点|闭合领土|三点限制|连续紧邻|拉开间距|红叉|切断|断联|跳过回合|指南舱|highlighted node|three-point limit|adjacent chain|red cross|territory|Skip Turn|Guide cabin|\[\d,\d\])/g)
      .map((text, index) => ({
        text,
        emphasized: index % 2 === 1,
        color: /^(蓝方|Blue)$/.test(text) ? "blue" : /^(红方|Red)$/.test(text) ? "red" : "key",
      })));
    return { copy, parts };
  },
  template: `
    <section class="tutorial-card" role="region" aria-live="polite" aria-label="LIFELINE tutorial">
      <div class="tutorial-card-copy">
        <p class="tutorial-eyebrow">{{ copy.eyebrow }}</p>
        <h2>{{ copy.title }}</h2>
        <p :class="success ? 'tutorial-success' : 'tutorial-instruction'">
          <template v-for="(part, index) in parts" :key="index">
            <strong v-if="part.emphasized" :class="'tutorial-highlight-' + part.color">{{ part.text }}</strong><span v-else>{{ part.text }}</span>
          </template>
        </p>
      </div>
      <div class="tutorial-card-actions">
        <button v-if="success" type="button" class="action-button action-button-primary" @click="$emit('continue')">
          {{ copy.continue }}
        </button>
        <button v-if="success && copy.final" type="button" class="action-button action-button-secondary tutorial-guide-button" @click="$emit('guide')">{{ copy.guide }}</button>
        <button v-else type="button" class="text-button" @click="$emit('skip')">{{ copy.skip }}</button>
      </div>
    </section>
  `,
};

const TopologySurfacePreview = {
  props: { snapshot: { type: Object, required: true }, language: String },
  setup(props) {
    const host = ref(null);
    let surface = null;
    onMounted(() => { surface = mountTopologySurface3D(host.value, props.snapshot, { language: props.language }); });
    watch(() => [props.snapshot, props.language], ([snapshot, language]) => surface?.update(snapshot, { language }));
    onBeforeUnmount(() => { surface?.destroy(); surface = null; });
    return { host };
  },
  template: `<div ref="host" class="topology-surface-preview"></div>`,
};

const TopologySurfaceExpandable = {
  components: { TopologySurfacePreview },
  props: { snapshot: { type: Object, required: true }, language: String },
  setup() { return { opened: ref(false) }; },
  template: `<details class="topology-live-preview" @toggle="opened = $event.target.open">
    <summary>{{ language === 'zh' ? '查看曲面与领地' : 'View surface and territory' }}</summary>
    <TopologySurfacePreview v-if="opened" :snapshot="snapshot" :language="language" />
  </details>`,
};

const SettlementBoardPreview = {
  name: "SettlementBoardPreview",
  props: { snapshot: { type: Object, required: true }, language: { type: String, required: true } },
  setup(props) {
    const canvas = ref(null);
    let renderer = null;
    onMounted(() => {
      renderer = new Renderer(canvas.value, { minCssWidth: 1, minCssHeight: 1 });
      renderer.render(props.snapshot);
    });
    watch(() => props.snapshot, (snapshot) => { if (renderer && snapshot?.boardMatrix) renderer.render(snapshot); });
    onBeforeUnmount(() => { renderer?.destroy(); renderer = null; });
    return { canvas };
  },
  template: `<div><div class="settlement-board-preview"><canvas ref="canvas" :aria-label="language === 'zh' ? '终局领土预览' : 'Final territory preview'"></canvas></div><p class="help-copy">{{ language === 'zh' ? '填色帮助理解领土，比分以离散计分为准。' : 'Fill illustrates territory; the displayed score uses the discrete rule.' }}</p></div>`,
};

const ResultModal = {
  name: "ResultModal",
  components: { TopologySurfacePreview, SettlementBoardPreview },
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
        return formatGameWinner(
          props.overlayResult.winner,
          props.gameState.players,
          props.roomPlayers,
          props.language,
          props.uiStyle,
        );
      }
      return formatGameWinner(
        props.gameState.winner,
        props.gameState.players,
        props.roomPlayers,
        props.language,
        props.uiStyle,
      );
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
      if (props.overlayResult || resignationSummary.value) {
        return [];
      }
      return buildNamedScoreEntries(
        getDisplayScores(props.gameState),
        props.gameState.players,
        props.roomPlayers,
        props.language,
        props.uiStyle,
      );
    });
    const resignationSummary = computed(() => {
      if (props.overlayResult) {
        return "";
      }
      return formatResignationScoreLine({
        scores: getDisplayScores(props.gameState),
        players: props.gameState.players,
        resignedPlayers: props.gameState.resignedPlayers,
        winner: props.gameState.winner,
        roomPlayers: props.roomPlayers,
        language: props.language,
        uiStyle: props.uiStyle,
      });
    });
    const summary = computed(() => {
      if (props.overlayResult?.scoreLine) {
        return props.overlayResult.scoreLine;
      }
      if (props.overlayResult) {
        return texts.value.resignedSummary(
          formatGamePlayerName(props.overlayResult.loser, props.gameState.players, props.roomPlayers, props.language, props.uiStyle),
          formatGamePlayerName(props.overlayResult.winner, props.gameState.players, props.roomPlayers, props.language, props.uiStyle),
        );
      }
      if (resignationSummary.value) {
        return resignationSummary.value;
      }
      return formatGameScoreLine(
        getDisplayScores(props.gameState),
        props.gameState.players,
        props.roomPlayers,
        props.language,
        props.uiStyle,
      );
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
              <span class="result-score-value" :class="entry.accentClass">{{ formatArea(entry.value) }}</span>
              <span v-if="index < structuredSummaryEntries.length - 1" class="result-score-separator"> : </span>
            </template>
          </p>
          <p v-else class="result-summary">{{ summary }}</p>
          <TopologySurfacePreview v-if="gameState.isTopologyBoard" :snapshot="gameState.snapshot" :language="language" />
          <SettlementBoardPreview v-else-if="gameState.gameOver && gameState.snapshot?.boardMatrix" :snapshot="gameState.snapshot" :language="language" />
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
      <a v-else-if="token.type === 'anchor'" class="guide-inline-link" :href="token.href">{{ token.text }}</a>
      <a v-else-if="token.type === 'link'" class="guide-inline-link" :href="token.href" target="_blank" rel="noopener noreferrer">{{ token.text }}</a>
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
    topologyEntry: {
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
  const isCutExample = (block) => block?.type === "image" && /\u5207\u65AD|cut example/i.test(block.alt ?? "");

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
    initialKey: { type: String, default: "" },
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
    const chapterLinks = computed(() => getGuideChapterLinks(displayBlocks.value));
    const goToChapter = (id) => document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "auto" });

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

    watch(() => [props.entry?.key, props.initialKey], () => {
      const requested = props.initialKey === "rules-math-topology" ? "rules-math" : props.initialKey;
      activeSubKey.value = props.entry?.subEntries?.some(item => item.key === requested) ? requested : (props.entry?.subEntries?.[0]?.key ?? "");
      typesetGuideMath();
      if (props.initialKey === "rules-math-topology") nextTick?.(() => document.getElementById("rulesMath-topology")?.scrollIntoView?.({ block: "start" }));
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
      chapterLinks,
      goToChapter,
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
            <details v-if="chapterLinks.length > 1" :key="activeReadableEntry?.key" class="guide-chapter-contents">
              <summary>{{ language === 'zh' ? '文章目录' : 'Contents' }} · {{ chapterLinks.length }}</summary>
              <nav class="guide-chapter-nav" :aria-label="language === 'zh' ? '文章目录' : 'Article contents'">
                <button v-for="chapter in chapterLinks" :key="chapter.id" type="button" @click="goToChapter(chapter.id)"><GuideInlineText :tokens="chapter.tokens" /></button>
              </nav>
            </details>
            <div class="guide-reader-body">
              <template v-for="(block, index) in displayBlocks" :key="(activeReadableEntry?.key || entry.key) + '-' + index">
                <h3 v-if="block.type === 'heading1'" :id="block.id" class="guide-block-heading-xl"><GuideInlineText :tokens="block.tokens" /></h3>
                <h4 v-else-if="block.type === 'heading2'" :id="block.id" class="guide-block-heading"><GuideInlineText :tokens="block.tokens" /></h4>
                <h5 v-else-if="block.type === 'heading3'" :id="block.id" class="guide-block-subheading"><GuideInlineText :tokens="block.tokens" /></h5>
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
    compactTitle: {
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
    <button type="button" class="dock-launcher" :class="'dock-launcher-' + variant" :aria-label="title" :title="title" @click="$emit('open')">
      <span class="dock-folder-head">
        <span class="dock-folder-icon" :class="'dock-folder-icon-' + variant" aria-hidden="true">
          <span v-if="variant === 'board'" class="triangle-glyph"></span>
          <svg v-else-if="variant === 'tutorial'" viewBox="0 0 24 24" focusable="false">
            <path d="M8 4.5a1 1 0 0 1 1.5-.86l11 7a1.6 1.6 0 0 1 0 2.72l-11 7A1 1 0 0 1 8 19.5v-15ZM4 4h2v16H4z" />
          </svg>
          <svg v-else-if="variant === 'guide'" viewBox="0 0 24 24" focusable="false">
            <path d="M5 4.75A2.75 2.75 0 0 1 7.75 2h9.5A1.75 1.75 0 0 1 19 3.75v15.5A1.75 1.75 0 0 1 17.25 21h-9A3.25 3.25 0 0 0 5 23V4.75Zm2.75-1.25A1.25 1.25 0 0 0 6.5 4.75v13.02c.52-.18 1.08-.27 1.75-.27h9.25V3.75a.25.25 0 0 0-.25-.25h-9.5Zm.5 16.5c-.68 0-1.24.16-1.75.49V21.5c.35-.33.89-.5 1.75-.5h9.25a.75.75 0 0 0 .75-.75v-1.25H8.25Z" />
            <path d="M9 7.25a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 0 1.5h-4.5A.75.75 0 0 1 9 7.25Zm0 3.5A.75.75 0 0 1 9.75 10h5.5a.75.75 0 0 1 0 1.5h-5.5a.75.75 0 0 1-.75-.75Zm0 3.5a.75.75 0 0 1 .75-.75h5.5a.75.75 0 0 1 0 1.5h-5.5a.75.75 0 0 1-.75-.75Z" />
          </svg>
          <svg v-else viewBox="0 0 24 24" focusable="false">
            <path d="M19.43 12.98c.04-.32.07-.65.07-.98s-.03-.66-.08-.98l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.6-.22l-2.49 1a7.2 7.2 0 0 0-1.69-.98l-.38-2.65A.5.5 0 0 0 14 1h-4a.5.5 0 0 0-.49.42l-.38 2.65c-.61.24-1.18.56-1.69.98l-2.49-1a.5.5 0 0 0-.6.22l-2 3.46a.5.5 0 0 0 .12.64l2.11 1.65c-.05.32-.08.65-.08.98s.03.66.08.98L2.47 14.63a.5.5 0 0 0-.12.64l2 3.46a.5.5 0 0 0 .6.22l2.49-1c.51.42 1.08.74 1.69.98l.38 2.65A.5.5 0 0 0 10 23h4a.5.5 0 0 0 .49-.42l.38-2.65c.61-.24 1.18-.56 1.69-.98l2.49 1a.5.5 0 0 0 .6-.22l2-3.46a.5.5 0 0 0-.12-.64l-2.1-1.65ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z" />
          </svg>
        </span>
        <span class="dock-launcher-copy">
          <strong class="dock-folder-title"><span class="dock-title-full">{{ title }}</span><span class="dock-title-compact">{{ compactTitle || title }}</span></strong>
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
            <button type="button" class="utility-close" :aria-label="closeLabel" @click="$emit('close')">&times;</button>
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
      key: "topology",
      group: "topology",
      eyebrow: texts.guideTopologyTitle,
      title: texts.guideTopologyTitle,
      subtitle: texts.guideTopologySubtitle,
      showIllustration: false,
      blocks: parseGuideMarkdown(resolveGuideMarkdown("topologyGuide", language, guideMarkdownOverrides)),
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
    emojiBursts: {
      type: Array,
      default: () => [],
    },
    aiThinking: {
      type: Boolean,
      default: false,
    },
    inspectionOverlay: {
      type: Object,
      default: null,
    },
    inputLocked: { type: Boolean, default: false },
    playerCount: { type: Number, default: 2 },
    boardShape: { type: String, default: "triangle" },
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
        renderer: { topInset: 52 },
        onStateChange: handleStateChange,
      });
      emit("controller-ready", controller);
      controller.init();
      controller.setInspectionOverlay(props.inspectionOverlay);
    });

    watch(() => props.inspectionOverlay, (overlay) => {
      controller?.setInspectionOverlay(overlay);
    }, { deep: true });

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
        <div class="board-canvas-surface">
          <canvas
            ref="canvasRef"
            class="game-canvas"
            :class="{ 'game-canvas-ai-thinking': aiThinking || inputLocked }"
            :aria-label="boardShape === 'hexagon' ? texts.hexBoardAriaLabel : texts.boardAriaLabel"
            :aria-disabled="inputLocked ? 'true' : 'false'"
            :aria-busy="aiThinking ? 'true' : 'false'"
          ></canvas>
          <slot name="tools"></slot>
        </div>
      </div>
      <div class="chat-emoji-layer" aria-live="polite" aria-atomic="false">
        <div
          v-for="burst in emojiBursts"
          :key="burst.id"
          class="chat-emoji-bubble"
          :class="['is-' + burst.animation, 'is-color-' + burst.colorClass]"
          :style="{
            '--emoji-duration': burst.duration + 'ms',
            '--emoji-x': burst.x + '%',
            '--emoji-y': burst.y + '%',
            '--emoji-mx': burst.mx + 'px',
            '--emoji-dx': burst.dx + 'px',
            '--emoji-dy': burst.dy + 'px'
          }"
        >
          {{ burst.content }}
        </div>
      </div>
    </section>
  `,
};

// A received room is historical authority; absence of a rule field means legacy.
const normalizeReceivedGameSettings = (settings = {}) => normalizeAppGameSettings({
  ...settings, protectionRule: settings?.protectionRule ?? "symmetric-v1",
});

// Identify a saved preset using its geometry and seams, never by trusting the
// label alone. This inspects candidates only; the saved board is never rebuilt.
const topologyGeometrySignature = (definition) => JSON.stringify({
  faces: randomBoardGeometrySignature(definition),
  seams: (definition?.seamPairs ?? []).map(pair => {
    const edges = [pair.edgeOccurrenceA, pair.edgeOccurrenceB].sort();
    return [edges, pair.endpointMap];
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
});
function inferSavedTopologyPreset(definition) {
  const preset = definition?.topology?.preset;
  if (!PRODUCT_SURFACE_PRESETS.includes(preset)) return null;
  const presetGeometry = value => JSON.stringify({
    geometry: topologyGeometrySignature(value),
    vertices: (value?.vertices ?? []).map(({ id, coordinate }) => [id, coordinate])
      .sort((a, b) => a[0].localeCompare(b[0])),
  });
  const signature = presetGeometry(definition);
  const sizes = APP_GRID_SIZE_OPTIONS.filter(size => {
    try { return presetGeometry(createSurfacePreset(preset, { gridSize: size })) === signature; }
    catch (_) { return false; }
  });
  return sizes.length ? { preset, sizes } : null;
}

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
    TopologySurfacePreview,
    TopologySurfaceExpandable,
    ReplayPanel,
    ReplayControls,
    ReplayInspectorPanel,
    RoomPanel,
    ScorePanel,
    SetupPanel,
    TopologySetupPanel,
    SharedLadderPanel,
    TutorialCard,
  },
  setup() {
    const storedAuth = loadAppStoredAuth();
    const storedSession = loadAppStoredSession();
    const storedLocalGame = loadLocalGameSession();
    const storedTopologyGame = loadTopologyLocalGameSession();
    let storedTopologyDecoded = null;
    try {
      if (storedTopologyGame) storedTopologyDecoded = decodeTopologyState(storedTopologyGame.topologyState);
    } catch (_) {
      // The topology-session reader already validates its envelope.  Keep the
      // legacy local match available if a browser extension/storage race makes
      // an additional decode fail here.
      storedTopologyDecoded = null;
    }
    const storedMatchPreferences = loadLocalMatchPreferences();
    const firstTutorialLevel = getTutorialLevel(0);
    const standaloneTutorial = new URLSearchParams(globalThis.location?.search ?? "").get("tutorial") === "1";
    const initialServerUrl = resolveInitialServerUrl(storedSession.url);
    const normalizedStoredSession = {
      ...(standaloneTutorial ? createAppEmptySession() : storedSession),
      settings: storedSession.settings,
      url: initialServerUrl,
    };
    const topologySettingsFromState = (decoded, topologySession = null) => normalizeAppGameSettings({
      playerCount: Object.keys(decoded.ruleState.startingVertices ?? {}).length,
      boardShape: "custom",
      rulesVersion: "surface-v1",
      topologyProtocolVersion: "board-topology-v1",
      // Board identity comes only from the validated topology state.  The
      // envelope may retain local UI controls (undo/hint/timer) but cannot
      // override its definition, hash, starts or rules.
      ...(topologySession?.settings ?? {}),
      // Old v1 saves omitted the setup size. Infer only a unique exact preset
      // geometry; ambiguous old sizes fall back to the normal UI default.
      gridSize: (() => {
        const saved = topologySession?.settings?.gridSize;
        const sizes = inferSavedTopologyPreset(decoded.board.definition)?.sizes;
        if (saved !== undefined && (!sizes || sizes.includes(saved))) return saved;
        return sizes?.length === 1 ? sizes[0] : undefined;
      })(),
      boardDefinition: decoded.board.definition,
      boardHash: decoded.boardHash,
      // The saved current player is a position property, not the opening
      // player.  The topology-session envelope retains the latter; starts are
      // canonical IDs and must not pass through legacy coordinate helpers.
      startPlayer: decoded.ruleState.turnOrder?.[0] ?? topologySession?.startPlayer ?? "BLACK",
      ...(decoded.ruleState.turnOrder !== undefined ? { turnOrder: decoded.ruleState.turnOrder } : {}),
      initialPositions: { ...decoded.ruleState.startingVertices },
    });
    const storedTopologySettings = storedTopologyDecoded
      ? topologySettingsFromState(storedTopologyDecoded, storedTopologyGame) : null;
    const normalGameSettings = normalizeAppGameSettings(storedTopologySettings ?? storedLocalGame?.settings ?? storedMatchPreferences?.settings ?? normalizedStoredSession.settings);
    const initialSettings = normalizeAppGameSettings(getTutorialEngineSettings(firstTutorialLevel));
    // A saved *draft* topology definition is neither a legacy coordinate
    // session nor a full topology session yet.  In particular, never send it
    // through createLocalGameSession(), which deliberately rejects custom
    // board settings.  It is restored as an unstarted topology board when the
    // tutorial closes below.
    let tutorialReturnSession = storedLocalGame ?? (storedTopologyDecoded || isTopologyGameSettings(normalGameSettings)
      ? null
      : createLocalGameSession(normalGameSettings));
    let tutorialReturnTopologySession = storedTopologyDecoded ? storedTopologyGame : null;
    const storedLocalMatch = storedTopologyDecoded ? storedTopologyGame?.match : storedLocalGame?.match;
    let tutorialReturnHintCount = normalGameSettings.hintEnabled ? normalGameSettings.hintMaxCount : 0;
    let pendingRoomReconnect = !standaloneTutorial && Boolean(
      storedAuth.token && normalizedStoredSession.roomId && normalizedStoredSession.playerId && normalizedStoredSession.url,
    );
    const controller = shallowRef(null);
    const gameState = ref(createAppDefaultGameState());
    const defaultTopologyChart = () => globalThis.matchMedia?.("(max-width: 700px)")?.matches ? "front" : "both";
    const topologyChart = ref(defaultTopologyChart());
    const hasDoubleTopologyChart = computed(() => ["double-torus", "double-sphere"].includes(gameState.value.snapshot?.boardDefinition?.topology?.preset));
    const topologyChartLatest = computed(() => {
      const snapshot = gameState.value.snapshot;
      const moves = Object.values(gameState.value.lastMoves ?? {}).filter(point => typeof point === "string");
      if (!moves.length && typeof gameState.value.lastAction?.point === "string") moves.push(gameState.value.lastAction.point);
      const latest = new Set(moves);
      const result = { front: false, back: false };
      for (const copy of snapshot?.topology?.viewBoard?.pointCopies ?? []) {
        if (latest.has(copy.canonicalVertexId)) result[String(copy.sourceVertexId ?? "").startsWith("back:") ? "back" : "front"] = true;
      }
      return result;
    });
    const setTopologyChart = (chart) => {
      if (!["both", "front", "back"].includes(chart)) return;
      topologyChart.value = chart;
      controller.value?.renderer?.setTopologyChart?.(chart);
    };
    watch(() => gameState.value.snapshot?.boardHash, () => setTopologyChart(defaultTopologyChart()));
    const tutorialActive = ref(true);
    // Existing games restore through the same isolated tutorial-exit path,
    // but do not expose the first-run lesson while restoration is pending.
    const tutorialAutoRestoring = ref(!standaloneTutorial && Boolean(storedTopologyDecoded || storedLocalGame));
    let startupRestorePromise = null;
    const tutorialSuccess = ref(false);
    const tutorialAttempts = ref(0);
    const tutorialLevelIndex = ref(0);
    const tutorialStartSnapshot = shallowRef(null);
    const tutorialResultSnapshot = shallowRef(null);
    const tutorialRestrictionObserved = ref(false);
    const localGameActions = ref([]);
    let topologyLocalSession = storedTopologyDecoded ? storedTopologyGame : null;
    const contributionState = ref({ enabled: false, pending: 0, status: "off", receipt: null });
    const contribution = new TrainingContribution({ onChange: (state) => { contributionState.value = state; } });
    contributionState.value = contribution.snapshot();
    let contributionContext = null;
    let contributionProfileSignature = null;
    const invalidateContributionTicket = () => { contributionContext = null; contributionProfileSignature = null; };
    const retryContributions = () => { void contribution.flush(); };
    const toggleContributions = (enabled) => { contribution.setEnabled(enabled); invalidateContributionTicket(); retryContributions(); };
    const localGamePositionRevision = ref(-1);
    const localGameRestoring = ref(false);
    const localGameResumeNotice = ref("");
    const replayDocument = ref(null);
    const replaySource = ref("");
    const replayActions = ref([]);
    const replayCursor = ref(0);
    const replayMode = ref(false);
    const replayPlaying = ref(false);
    const replayInspectorOpen = ref(false);
    const replayBusy = ref(false);
    const replayError = ref("");
    const replayRestoring = ref(false);
    const replayInspectionPoint = ref(null);
    const aiComparison = ref(null);
    const aiComparisonBusy = ref(false);
    const aiComparisonError = ref("");
    const topologyInspectionCache = new WeakMap();
    const currentReplayEvent = computed(() => {
      const document = replayDocument.value;
      const cursor = replayCursor.value;
      const event = cursor > 0 ? document?.actions?.[cursor - 1] ?? null : null;
      if (!event || document.format !== TOPOLOGY_REPLAY_FORMAT) return event;
      let cache = topologyInspectionCache.get(document);
      if (!cache) { cache = new Map(); topologyInspectionCache.set(document, cache); }
      if (!cache.has(cursor)) {
        try {
          const effects = topologyReplayInspectionEffects(document, cursor);
          if (effects) cache.set(cursor, effects);
        } catch (error) { console.warn("Topology replay inspection failed:", error); }
      }
      return { ...event, effects: cache.get(cursor) ?? null };
    });
    const replayInspectionOverlay = computed(() => {
      if (!replayMode.value) {
        return null;
      }
      const effects = currentReplayEvent.value?.effects ?? {};
      const addedEdges = Object.entries(effects.addedEdgesByPlayer ?? {})
        .flatMap(([player, edges]) => (edges ?? []).map((edge) => ({ player, edge })));
      return {
        selectedPoint: replayInspectionPoint.value,
        capturedPoints: effects.capturedPoints ?? [],
        addedEdges,
      };
    });
    let liveReplayRestore = null;
    let replayPlaybackId = null;
    const selectedHintEnabled = ref(initialSettings.hintEnabled);
    const selectedHintMaxCount = ref(initialSettings.hintMaxCount);
    const hintRemainingCount = ref(0);
    const selectedUndoEnabled = ref(initialSettings.undoEnabled);
    const selectedUndoMaxCount = ref(initialSettings.undoMaxCount);
    const undoUsage = ref(normalizeUndoUsage(storedLocalMatch?.undo));
    const hintThinking = ref(false);
    const hintFeedback = ref("");
    const actionFeedback = ref("");
    const actionFeedbackTone = ref("neutral");
    const language = ref(getAppInitialLanguage());
    const uiStyle = ref(getAppInitialUiStyle());
    const guideMarkdownOverrides = ref({});
    // Declare this explicitly instead of relying on NetworkManager's default:
    // reconnects must negotiate the same topology capability as new rooms.
    const networkManager = new NetworkManager({
      topologyCapabilities: [TOPOLOGY_ROOM_CAPABILITY],
      requestPasswordSession: ({ login, signal }) => requestSharedPasswordSession(login, signal),
    });
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
    const selectedBoardShape = ref(initialSettings.boardShape);
    const selectedGridSize = ref(initialSettings.gridSize);
    const selectedStartPlayer = ref(initialSettings.startPlayer);
    const selectedTurnOrder = ref(resizeTurnOrder(initialSettings.turnOrder, initialSettings.playerCount, initialSettings.startPlayer));
    const selectedStartingPoints = ref(startingPointSettings(initialSettings));
    const selectedTopologyDefinition = shallowRef(null);
    const topologyDefaultSelection = shallowRef(null);
    const selectedTopologyHash = ref("");
    const selectedTopologyGridSize = ref(initialSettings.gridSize);
    const selectedTopologySource = ref("");
    const topologySetupMessage = ref("");
    const topologyRandomSeed = ref("surface-1");
    const topologyDraft = shallowRef(createBoardDraft());
    const topologyDraftsBySize = new Map();
    const topologyDraftX = ref(0);
    const topologyDraftY = ref(0);
    const topologyDefinitionText = ref("");
    let startingPointPreviewFresh = false;
    const selectedRulesVersion = ref(initialSettings.rulesVersion ?? APP_DEFAULT_RULES_VERSION);
    const selectedTurnTimerEnabled = ref(initialSettings.turnTimerEnabled);
    const selectedTurnTimeLimitSeconds = ref(initialSettings.turnTimeLimitSeconds);
    const selectedLocalPlayers = ref(normalizeLocalPlayers(storedLocalMatch?.players ?? storedMatchPreferences?.players, initialSettings.playerCount, initialSettings.boardShape));
    const explicitLabColors = new Set();
    const activeLocalPlayers = ref(normalizeLocalPlayers(storedLocalMatch?.players, normalGameSettings.playerCount, normalGameSettings.boardShape));
    const selectedRoomBotCount = ref(0);
    const roomSetupOpen = ref(false);
    const activeLocalSettings = ref(normalGameSettings);
    const localMatchStarted = ref(storedLocalMatch?.started ?? Boolean(storedTopologyDecoded ? storedTopologyGame?.actions.length : storedLocalGame?.actions.length));
    const localSetupSettingsSignature = (settings) => {
      const normalized = normalizeAppGameSettings(settings);
      // Protection belongs to a match version, not to editable setup fields.
      delete normalized.protectionRule;
      normalized.turnOrder = resizeTurnOrder(normalized.turnOrder, normalized.playerCount, normalized.startPlayer);
      return JSON.stringify(normalized);
    };
    // A changed draft is reviewable in the setup panel, while the active game
    // stays playable until Start explicitly commits the new settings.
    const localSettingsChanged = computed(() => JSON.stringify(selectedLocalPlayers.value) !== JSON.stringify(activeLocalPlayers.value)
      || localSetupSettingsSignature(draftGameSettings()) !== localSetupSettingsSignature(activeLocalSettings.value));
    const localSetupPending = computed(() => !localMatchStarted.value);
    const selectedAiMode = computed(() => localMatchMode(activeLocalPlayers.value, activeLocalSettings.value.playerCount, activeLocalSettings.value.boardShape));
    const aiDuelPaused = ref(storedLocalMatch?.paused ?? false);
    const aiThinking = ref(false);
    const aiLoading = ref(false);
    const session = ref(networkManager.getSession());
    const connectionState = ref("idle");
    const roomStatus = ref("solo");
    const roomInfo = ref(createEmptyRoomInfo());
    const networkBusy = ref(false);
    const networkError = ref("");
    const readyPending = ref(false);
    const chatEmojiBursts = ref([]);
    const chatEmojiOptions = CHAT_EMOJI_OPTIONS;
    const optimisticChatEmoji = {
      content: "",
      sentAt: 0,
    };
    let lastServerTimestamp = 0;
    const overlayResult = ref(null);
    const activeUtilityDeck = ref("");
    const accountLinkCode = ref(""), accountLinkError = ref(""), accountLinkBusy = ref(false);
    let accountLinkGeneration = 0, accountLinkExpiry = null;
    const sharedPasswordOpen = ref(false), sharedPasswordUsername = ref(""), sharedPassword = ref("");
    const sharedPasswordBusy = ref(false), sharedPasswordError = ref("");
    let sharedPasswordRequest = null;
    const cancelSharedPassword = (cancelAuthentication = true) => {
      const pending = sharedPasswordRequest;
      sharedPasswordRequest = null;
      sharedPassword.value = ""; sharedPasswordUsername.value = "";
      sharedPasswordOpen.value = false; sharedPasswordBusy.value = false; sharedPasswordError.value = "";
      pending?.dispose();
      pending?.reject(new Error("CANCELLED"));
      if (cancelAuthentication) networkManager.shared.cancelAuthentication();
    };
    function requestSharedPasswordSession(login, signal) {
      cancelSharedPassword(false);
      if (signal.aborted || !auth.value.token || !auth.value.username) return Promise.reject(new Error("CANCELLED"));
      activeUtilityDeck.value = "network";
      sharedPasswordUsername.value = auth.value.username;
      sharedPasswordOpen.value = true;
      return new Promise((resolve, reject) => {
        const cancel = () => cancelSharedPassword(false);
        sharedPasswordRequest = { login, resolve, reject, token: auth.value.token, server: serverUrl.value,
          dispose: () => signal.removeEventListener("abort", cancel) };
        signal.addEventListener("abort", cancel, { once: true });
        const pending = sharedPasswordRequest;
        void nextTick(() => {
          if (sharedPasswordRequest !== pending || !sharedPasswordOpen.value) return;
          globalThis.document?.getElementById("shared-password-input")?.focus({ preventScroll: true });
        });
      });
    }
    const handleSharedPasswordSubmit = async () => {
      const pending = sharedPasswordRequest;
      if (!pending || sharedPasswordBusy.value) return;
      if (!sharedPassword.value) { sharedPasswordError.value = language.value === "zh" ? "请输入当前网页账号的密码。" : "Enter your current Web account password."; return; }
      const password = sharedPassword.value;
      sharedPassword.value = ""; sharedPasswordError.value = ""; sharedPasswordBusy.value = true;
      try {
        const result = await pending.login({ username: sharedPasswordUsername.value, password });
        if (sharedPasswordRequest !== pending || pending.token !== auth.value.token || pending.server !== serverUrl.value) return;
        sharedPasswordRequest = null; pending.dispose(); sharedPasswordOpen.value = false; sharedPasswordUsername.value = "";
        pending.resolve(result);
      } catch (error) {
        if (sharedPasswordRequest === pending) sharedPasswordError.value = error.message === "CANCELLED"
          ? (language.value === "zh" ? "验证已取消。" : "Verification cancelled.")
          : (language.value === "zh" ? "验证失败，请检查账号密码后重试。" : "Verification failed. Check your account and password.");
      } finally { if (sharedPasswordRequest === pending || !sharedPasswordRequest) sharedPasswordBusy.value = false; }
    };
    watch(activeUtilityDeck, deck => { if (deck !== "network" && sharedPasswordRequest) cancelSharedPassword(); }, { flush: "sync" });
    watch(serverUrl, () => {
      cancelSharedPassword();
      accountLinkGeneration += 1; accountLinkCode.value = ""; accountLinkError.value = "";
      clearTimeout(accountLinkExpiry);
    }, { flush: "sync" });
    const activeGuideKey = ref("");
    const resultModalDismissed = ref(false);
    const turnCountdown = ref(ROOM_START_COUNTDOWN_FALLBACK_SECONDS);
    const turnTimerRemaining = ref(0);
    const turnTimerPhase = ref("paused");
    const unsubscribers = [];
    let reconnectTimerId = null;
    let hintClearTimeoutId = null;
    let hintFeedbackTimeoutId = null;
    let turnCountdownTimerId = null;
    let countdownSnapshotRefreshTimerId = null;
    let turnTimerId = null;
    let turnTimerDeadline = 0;
    let turnTimerSkipInFlight = false;
    let localGameNoticeTimeoutId = null;
    let reconnectAttempt = 0;
    let syncingRemoteSettings = false;
    let roomSnapshotRecoveryFailed = false;
    let guideMarkdownLoadId = 0;
    let aiWorker = null;
    const multiplayerWarmup = new MultiplayerWarmupSession();
    let aiTimeoutId = null;
    let aiScheduleId = null;
    let aiRequestSequence = 0;
    let activeAiRequestId = null;
    let activeAiRequest = null;
    const hintWorkerSession = new OneShotHintWorker(
      () => new Worker(new URL("./AIWorker.js?v=20261029-unified-r1", import.meta.url), { type: "module" }),
    );
    const aiComparisonWorkerSession = new OneShotHintWorker(
      () => new Worker(new URL("./AIWorker.js?v=20261029-unified-r1", import.meta.url), { type: "module" }),
    );
    const chatEmojiTimeoutIds = new Set();

    const cancelHintRequest = () => hintWorkerSession.cancel();
    const cancelAiComparison = () => aiComparisonWorkerSession.cancel();

    const getAiPlayer = (state = gameState.value) => localAIPlayer(activeLocalPlayers.value, activeLocalSettings.value.playerCount, state?.currentPlayer, activeLocalSettings.value.gridSize, activeLocalSettings.value.boardShape);

    const selectedAiProfile = (player = gameState.value.currentPlayer) => localPlayerProfile(activeLocalPlayers.value[player], activeLocalSettings.value.playerCount, activeLocalSettings.value.gridSize, activeLocalSettings.value.boardShape);

    const terminateAiWorker = () => {
      if (aiTimeoutId !== null) {
        globalThis.clearTimeout(aiTimeoutId);
        aiTimeoutId = null;
      }
      if (aiScheduleId !== null) {
        globalThis.clearTimeout(aiScheduleId);
        aiScheduleId = null;
      }
      if (aiWorker) {
        aiWorker.terminate();
        aiWorker = null;
      }
      activeAiRequestId = null;
      activeAiRequest = null;
      aiThinking.value = false;
      aiLoading.value = false;
    };

    const canRunLocalAI = (state = gameState.value) => (
      !tutorialActive.value
      && !replayMode.value
      && !replayBusy.value
      && !localGameRestoring.value
      && roomStatus.value === "solo"
      && APP_PLAYER_COUNT_OPTIONS.includes(activeLocalSettings.value.playerCount)
      && !localSetupPending.value
      && selectedAiMode.value !== "none"
      && !aiDuelPaused.value
      && !state?.gameOver
      && !state?.multiplayerEnabled
      && !controller.value?.multiplayerEnabled
    );

    const armAiTimeout = (requestId, loading, delay) => {
      if (aiTimeoutId !== null) globalThis.clearTimeout(aiTimeoutId);
      aiTimeoutId = globalThis.setTimeout(() => {
        if (activeAiRequestId !== requestId) return;
        const request = activeAiRequest, progress = request?.progress, worker = aiWorker;
        const engine = controller.value?.engine;
        if (!loading && worker && request?.ready && progress
            && isWorkerResultForRequest(engine, request, progress)
            && request.profileSignature === JSON.stringify(selectedAiProfile())
            && canRunLocalAI() && getAiPlayer() === progress.currentPlayer) {
          const previousRevision = engine.positionRevision;
          // Reuse the ordinary RESULT path, including the final legality and
          // identity checks. Terminate the still-computing Worker afterwards.
          worker.onmessage({ data: { ...progress, type: "RESULT" } });
          if (aiWorker === worker) { worker.terminate(); aiWorker = null; }
          if (engine.positionRevision !== previousRevision) {
            showLocalGameNotice(language.value === "zh"
              ? "AI 思考预算已到，采用已验证的合法候选；原策略搜索未完成。"
              : "AI time budget reached; a verified legal fallback was played before the strategy finished.");
          }
          return;
        }
        terminateAiWorker();
        aiDuelPaused.value = true;
        saveLocalMatch();
        const texts = getAppTexts(language.value, uiStyle.value);
        showLocalGameNotice(loading ? texts.localAiLoadingTimeout : texts.localAiThinkingTimeout);
      }, delay);
    };

    const ensureAiWorker = () => {
      if (!aiWorker && canRunLocalAI()) {
        aiWorker = createLocalAIWorker(controller.value?.engine,
          APP_ALL_PLAYERS.slice(0, activeLocalSettings.value.playerCount).map(player => selectedAiProfile(player)));
        const worker = aiWorker;
        aiWorker.onmessage = (event) => {
          if (aiWorker !== worker) return;
          if (event.data?.type === "WARMUP_FAILED") {
            if (aiWorker === worker && multiplayerWarmup.hasRequested(worker) && activeAiRequest === null && activeAiRequestId === null) {
              worker.terminate();
              aiWorker = null;
            }
            return;
          }
          if (event.data?.type === "READY") {
            const request = activeAiRequest;
            if (aiWorker !== worker || !request || request.ready
                || event.data.requestId !== activeAiRequestId || event.data.strategy !== request.strategy
                || (request.strategy === "multiplayer" && event.data.modelInfo?.id !== request.modelId)
                || !isWorkerResultForRequest(controller.value?.engine, request, event.data)
                || request.profileSignature !== JSON.stringify(selectedAiProfile())
                || !canRunLocalAI() || getAiPlayer() !== event.data.currentPlayer) return;
            request.ready = true;
            aiLoading.value = false;
            armAiTimeout(request.requestId, false, 3300);
            return;
          }
          if (event.data?.type === "PROGRESS") {
            const request = activeAiRequest, engine = controller.value?.engine, move = event.data.moves?.[0];
            if (!request?.ready || event.data.strategy !== request.strategy
                || !isWorkerResultForRequest(engine, request, event.data)
                || request.profileSignature !== JSON.stringify(selectedAiProfile())
                || !canRunLocalAI() || getAiPlayer() !== event.data.currentPlayer
                || !Array.isArray(move?.point) || move.point.length !== 2
                || !move.point.every(Number.isInteger) || !engine._evaluateMove(move.point, event.data.currentPlayer).legal) return;
            request.progress = structuredClone(event.data);
            return;
          }
          if (event.data?.type !== "RESULT" && event.data?.type !== "ERROR") {
            return;
          }
          if (event.data.requestId !== activeAiRequestId) {
            return;
          }
          // A result cannot bypass this request's loading/identity handshake.
          if (event.data.type === "RESULT" && activeAiRequest?.strategy === "multiplayer" && !activeAiRequest.ready) return;
          if (aiTimeoutId !== null) {
            globalThis.clearTimeout(aiTimeoutId);
            aiTimeoutId = null;
          }
          const request = activeAiRequest;
          activeAiRequestId = null;
          activeAiRequest = null;

          try {
            const aiPlayer = getAiPlayer();
            const sourceStillCurrent = isWorkerResultForRequest(controller.value?.engine, request, event.data);
            const profileStillCurrent = request?.profileSignature === JSON.stringify(selectedAiProfile());
            const mayApplyResult = event.data.type === "RESULT"
              && canRunLocalAI()
              && gameState.value.currentPlayer === aiPlayer
              && sourceStillCurrent && profileStillCurrent;
            if (!mayApplyResult) {
              if (event.data.type === "ERROR" && sourceStillCurrent && profileStillCurrent && canRunLocalAI()) {
                console.error(`AI worker failed: ${event.data.message}`);
                const side = gameState.value.currentPlayer;
                const fallback = activeLocalSettings.value.playerCount === 2 && activeLocalSettings.value.boardShape === "triangle" && activeLocalPlayers.value[side].choice !== "minimax";
                terminateAiWorker();
                if (fallback) {
                  activeLocalPlayers.value = normalizeLocalPlayers({ ...activeLocalPlayers.value, [side]: { ...activeLocalPlayers.value[side], choice: "minimax" } });
                  selectedLocalPlayers.value = normalizeLocalPlayers(activeLocalPlayers.value);
                  if (contributionContext) contributionContext.mixedProfiles = true;
                  persistLocalMatchPreferences(selectedLocalPlayers.value, draftGameSettings());
                } else aiDuelPaused.value = true;
                const texts = getAppTexts(language.value, uiStyle.value);
                showLocalGameNotice(event.data.code?.startsWith("ULTIMATE_") ? texts.localUltimateUnavailable
                  : texts.localAiFailure(formatAppPlayerName(side, language.value, uiStyle.value), fallback));
                saveLocalMatch();
                if (fallback) scheduleAiMove(gameState.value);
              }
              return;
            }

            const appliedProfile = selectedAiProfile();
            if (["three-player", "hex-player", "multiplayer"].includes(appliedProfile?.strategy)
                && (event.data.strategy !== appliedProfile.strategy || event.data.modelInfo?.id !== appliedProfile.modelId)) {
              throw new Error("AI 返回的模型身份与当前选择不一致。");
            }
            if (appliedProfile?.strategy === "topology-generic"
                && (event.data.strategy !== "topology-generic"
                  || event.data.modelInfo?.route !== TOPOLOGY_AI_ROUTE
                  || event.data.boardHash !== controller.value.engine.boardHash)) {
              throw new Error("拓扑 AI 返回的棋盘身份或路由不一致。");
            }
            const applyAiPass = () => {
              const passResult = controller.value.skipTurn();
              if (!passResult?.success) {
                throw new Error(`AI PASS 未能应用：${passResult?.reason ?? "UNKNOWN"}`);
              }
            };
            if (event.data.moves?.length) {
              const move = event.data.moves[0];
              if (move.type === "pass" && move.point === null) applyAiPass();
              else if (controller.value.engine.isTopologyBoard) {
                const vertexId = move.vertexId ?? move.point;
                if (typeof vertexId !== "string"
                  || event.data.boardHash !== controller.value.engine.boardHash
                  || !controller.value.engine._evaluateMove(vertexId, aiPlayer).legal) {
                  throw new Error("AI 返回非法拓扑动作。");
                }
                const moveResult = controller.value._applyMove(vertexId);
                if (!moveResult?.success) throw new Error(`拓扑 AI 落子未能应用：${moveResult?.reason ?? "UNKNOWN"}`);
              }
              else if (["root_relocate", "root_add"].includes(move.type)
                && Array.isArray(move.point) && move.point.length === 2 && move.point.every(Number.isInteger)
                && controller.value.engine._validateRootAction(move.type.replace(/^root_/, ""), move.point, aiPlayer) == null) {
                const result = controller.value._applyRootAction(move.type.replace(/^root_/, ""), move.point, aiPlayer);
                if (!result.success) throw new Error(`AI 起点操作未能应用：${result.reason ?? "UNKNOWN"}`);
              }
              else if (Array.isArray(move.point) && move.point.length === 2 && move.point.every(Number.isInteger)
                && controller.value.engine._evaluateMove(move.point, aiPlayer).legal) {
                const moveResult = controller.value._applyMove(move.point);
                if (!moveResult?.success) throw new Error(`AI 落子未能应用：${moveResult?.reason ?? "UNKNOWN"}`);
              }
              else throw new Error("AI 返回非法动作。");
            } else if (["multiplayer", "topology-generic"].includes(appliedProfile?.strategy)) {
              throw new Error("AI 未返回有效动作。");
            } else {
              applyAiPass();
            }
            if (event.data.searchStats?.partial || event.data.searchInfo?.fallbackReason === "partial-policy-candidate"
                || event.data.searchInfo?.fallbackReason === "first-legal-action-not-policy") {
              showLocalGameNotice(language.value === "zh"
                ? "AI 思考预算已到，本次使用未完成搜索的候选。"
                : "AI time budget reached; this move came from an incomplete search.");
            }
          } catch (error) {
            console.error("AI result could not be applied.", error);
            terminateAiWorker();
            aiDuelPaused.value = true;
            saveLocalMatch();
            showLocalGameNotice(getAppTexts(language.value, uiStyle.value).localAiFailure(formatAppPlayerName(gameState.value.currentPlayer, language.value, uiStyle.value), false));
          } finally {
            aiThinking.value = false;
            aiLoading.value = false;
            if (event.data.type === "RESULT") {
              scheduleAiMove(gameState.value);
            }
          }
        };
        aiWorker.onerror = (event) => {
          if (aiWorker !== worker || !canRunLocalAI()) return;
          if (multiplayerWarmup.hasRequested(worker) && activeAiRequest === null && activeAiRequestId === null) {
            // Keep any scheduled COMPUTE: it will create a fresh Worker.
            worker.terminate();
            aiWorker = null;
            return;
          }
          console.error("AI worker failed.", event);
          terminateAiWorker();
          aiDuelPaused.value = true;
          saveLocalMatch();
          showLocalGameNotice(getAppTexts(language.value, uiStyle.value).localAiFailure(formatAppPlayerName(gameState.value.currentPlayer, language.value, uiStyle.value), false));
        };
      }
      return aiWorker;
    };

    const scheduleAiMove = (state = gameState.value) => {
      if (replayMode.value || replayRestoring.value) {
        return;
      }
      const aiPlayer = getAiPlayer(state);
      if (!canRunLocalAI(state)) {
        if (state?.gameOver || state?.multiplayerEnabled || selectedAiMode.value === "none" || aiDuelPaused.value) {
          terminateAiWorker();
        }
        return;
      }
      multiplayerWarmup.request({
        started: localMatchStarted.value, allowed: true,
        humanTurn: state.currentPlayer !== aiPlayer && controller.value?.engine?.currentPlayer === state.currentPlayer,
        idle: !aiThinking.value && activeAiRequest === null && activeAiRequestId === null && aiScheduleId === null,
        context: controller.value?.engine,
        profiles: APP_ALL_PLAYERS.slice(0, activeLocalSettings.value.playerCount).map(player => selectedAiProfile(player)),
        ensureWorker: ensureAiWorker,
      });
      if (state.currentPlayer !== aiPlayer || aiThinking.value || aiScheduleId !== null) {
        return;
      }

      aiThinking.value = true;
      aiScheduleId = globalThis.setTimeout(() => {
        aiScheduleId = null;
        const nextAiPlayer = getAiPlayer();
        if (
          !canRunLocalAI()
          || gameState.value.currentPlayer !== nextAiPlayer
          || !controller.value?.engine
        ) {
          aiThinking.value = false;
          return;
        }

        try {
          const worker = ensureAiWorker();
          if (!worker) {
            aiThinking.value = false;
            return;
          }
          const requestId = ++aiRequestSequence;
          activeAiRequestId = requestId;
          const profile = selectedAiProfile(nextAiPlayer);
          activeAiRequest = { ...captureWorkerRequest(controller.value.engine, requestId), profileSignature: JSON.stringify(profile),
            strategy: profile.strategy, modelId: profile.modelId, ready: false };
          aiLoading.value = profile.strategy === "multiplayer";
          // Every Worker request must have a total bound. Multiplayer replaces
          // this loading bound with its shorter decision bound after READY;
          // two-player and legacy workers have no READY handshake, so this is
          // also their protection against an endless "thinking" state.
          armAiTimeout(requestId, profile.strategy === "multiplayer", 15000);
          worker.postMessage({
            type: "COMPUTE",
            requestId,
            serializedState: serializeEngineState(controller.value.engine),
            aiPlayer: nextAiPlayer,
            ...profile,
            enableProgress: profile.strategy !== "topology-generic",
            topN: 5,
          });
        } catch (error) {
          console.error("Could not start AI worker.", error);
          terminateAiWorker();
          aiDuelPaused.value = true;
          saveLocalMatch();
          showLocalGameNotice(getAppTexts(language.value, uiStyle.value).localAiFailure(formatAppPlayerName(gameState.value.currentPlayer, language.value, uiStyle.value), false));
        }
      }, activeLocalSettings.value.playerCount >= 3 ? 0 : selectedAiMode.value === "ai_duel" ? 400 : 0);
    };

    const restartLocalAiWorker = () => {
      terminateAiWorker();
      scheduleAiMove();
    };

    watch([language, uiStyle], ([nextLanguage, nextUiStyle]) => {
      globalThis.localStorage?.setItem("triaxis-language", nextLanguage);
      globalThis.localStorage?.setItem(UI_STYLE_STORAGE_KEY, nextUiStyle);
      document.documentElement.lang = nextLanguage === "en" ? "en" : "zh-CN";
      document.documentElement.dataset.uiStyle = nextUiStyle;
      document.title = getAppTexts(nextLanguage, nextUiStyle).pageTitle;
    }, { immediate: true });

    watch(language, async (value) => {
      const loadId = ++guideMarkdownLoadId;
      const nextOverrides = await loadGuideMarkdownAssets(value);

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

    watch([selectedPlayerCount, selectedBoardShape, selectedGridSize, selectedStartPlayer, selectedRulesVersion, selectedTurnTimerEnabled, selectedTurnTimeLimitSeconds, selectedHintEnabled, selectedHintMaxCount, selectedUndoEnabled, selectedUndoMaxCount, selectedTurnOrder], ([
      playerCount,
      boardShape,
      gridSize,
      startPlayer,
      rulesVersion,
      turnTimerEnabled,
      turnTimeLimitSeconds,
      hintEnabled,
      hintMaxCount,
      undoEnabled,
      undoMaxCount,
      turnOrder,
    ], [
      previousPlayerCount,
      previousBoardShape,
      previousGridSize,
      previousStartPlayer,
      previousRulesVersion,
      previousTurnTimerEnabled,
      previousTurnTimeLimitSeconds,
      previousHintEnabled,
      previousHintMaxCount,
      previousUndoEnabled,
      previousUndoMaxCount,
      previousTurnOrder,
    ] = []) => {
      if (syncingRemoteSettings || tutorialActive.value) {
        return;
      }

      const validCount = APP_PLAYER_COUNT_OPTIONS.includes(playerCount) ? playerCount : 2;
      const starter = APP_ALL_PLAYERS.slice(0, validCount).includes(startPlayer) ? startPlayer : APP_ALL_PLAYERS[0];
      const effectiveOrder = resizeTurnOrder(turnOrder, validCount, starter);
      if (JSON.stringify(effectiveOrder) !== JSON.stringify(selectedTurnOrder.value)) selectedTurnOrder.value = effectiveOrder;
      const wantsTopology = boardShape === "custom" || rulesVersion === "surface-v1";
      let settingsInput;
      if (wantsTopology) {
        if (!selectedTopologyDefinition.value) {
          // Keep an incomplete custom selection visibly incomplete.  It must
          // fail at the match boundary rather than being normalized into a
          // playable triangle by the legacy settings path.
          settingsInput = {
            playerCount, boardShape: "custom", gridSize, startPlayer: starter, turnOrder: effectiveOrder,
            rulesVersion: "surface-v1", topologyProtocolVersion: "board-topology-v1",
            turnTimerEnabled, turnTimeLimitSeconds, hintEnabled, hintMaxCount,
            undoEnabled, undoMaxCount, botCount: 0,
          };
        } else {
          try {
            const materialized = materializeTopologyDefinition(selectedTopologyDefinition.value, playerCount, starter);
            selectedTopologyDefinition.value = materialized.definition;
            selectedTopologyHash.value = materialized.boardHash;
            selectedStartingPoints.value = { startingPointMode: "topology" };
            settingsInput = {
              playerCount, boardShape: "custom", gridSize, startPlayer: starter, turnOrder: effectiveOrder,
              rulesVersion: "surface-v1", topologyProtocolVersion: "board-topology-v1",
              boardDefinition: materialized.definition, boardHash: materialized.boardHash,
              initialPositions: materialized.initialPositions,
              turnTimerEnabled, turnTimeLimitSeconds, hintEnabled, hintMaxCount,
              undoEnabled, undoMaxCount, botCount: 0,
            };
          } catch (error) {
            setTopologySetupMessage(error?.message ?? String(error), true);
            return;
          }
        }
      } else {
        try {
          if (boardShape !== previousBoardShape && previousBoardShape) throw new Error("Board changed");
          startingPointSettings({ ...selectedStartingPoints.value, playerCount, gridSize, boardShape });
        } catch (_) {
          const selectedRootMode = selectedStartingPoints.value.rootMode ?? RootMode.CLASSIC;
          const requiresExplicit = requiresExplicitStartingPoints(playerCount, boardShape);
          const requestedMode = selectedStartingPoints.value.startingPointMode ?? "default";
          const mode = requiresExplicit && requestedMode === "default" ? "random" : requestedMode;
          selectedStartingPoints.value = mode === "default" && selectedRootMode === RootMode.CLASSIC ? {} : {
            ...(selectedRootMode === RootMode.CLASSIC ? {} : { rootMode: selectedRootMode }), startingPointMode: mode,
            ...(selectedRootMode === RootMode.CLASSIC
              ? { initialPositions: mode === "random" ? randomInitialPositions(gridSize, playerCount, Math.random, boardShape) : resolveInitialPositions(gridSize, playerCount, null, boardShape) }
              : { initialRoots: randomInitialRoots(gridSize, playerCount, selectedRootMode, Math.random, boardShape) }),
          };
        }
        settingsInput = {
          playerCount, boardShape, gridSize, startPlayer: starter, turnOrder: effectiveOrder, rulesVersion,
          ...(roomStatus.value !== "solo" ? { protectionRule: roomInfo.value.settings?.protectionRule ?? "symmetric-v1" } : {}),
          turnTimerEnabled, turnTimeLimitSeconds, hintEnabled, hintMaxCount,
          undoEnabled, undoMaxCount, ...selectedStartingPoints.value,
        };
      }

      const normalized = normalizeAppGameSettings(settingsInput);
      selectedPlayerCount.value = normalized.playerCount;
      selectedBoardShape.value = normalized.boardShape;
      selectedRoomBotCount.value = normalizeAppGameSettings({ ...normalized, botCount: selectedRoomBotCount.value }).botCount;
      if ((normalized.playerCount !== previousPlayerCount || normalized.boardShape !== previousBoardShape) && roomStatus.value === "solo") {
        selectedLocalPlayers.value = normalizeLocalPlayers(selectedLocalPlayers.value, normalized.playerCount, normalized.boardShape);
      }
      selectedGridSize.value = normalized.gridSize;
      selectedStartPlayer.value = normalized.startPlayer;
      selectedRulesVersion.value = normalized.rulesVersion;
      selectedTurnTimerEnabled.value = normalized.turnTimerEnabled;
      selectedTurnTimeLimitSeconds.value = normalized.turnTimeLimitSeconds;
      selectedHintEnabled.value = normalized.hintEnabled;
      selectedHintMaxCount.value = normalized.hintMaxCount;
      selectedUndoEnabled.value = normalized.undoEnabled;
      selectedUndoMaxCount.value = normalized.undoMaxCount;
      syncSession();

      const gameAffectingChanged = normalized.playerCount !== previousPlayerCount
        || normalized.boardShape !== previousBoardShape
        || normalized.gridSize !== previousGridSize
        || normalized.startPlayer !== previousStartPlayer
        || JSON.stringify(normalized.turnOrder) !== JSON.stringify(previousTurnOrder)
        || normalized.rulesVersion !== previousRulesVersion
        || normalized.turnTimerEnabled !== previousTurnTimerEnabled
        || normalized.turnTimeLimitSeconds !== previousTurnTimeLimitSeconds;
      const hintChanged = normalized.hintEnabled !== previousHintEnabled
        || normalized.hintMaxCount !== previousHintMaxCount
        || normalized.undoEnabled !== previousUndoEnabled
        || normalized.undoMaxCount !== previousUndoMaxCount;

      if (roomStatus.value === "solo" && controller.value) {
        // Settings are a draft until Start; keep the live board and saved evidence.
        if (gameAffectingChanged || hintChanged) {
          cancelHintRequest();
          terminateAiWorker();
          persistLocalMatchPreferences(selectedLocalPlayers.value, normalized);
          if (localMatchStarted.value) scheduleAiMove(gameState.value);
        }
        return;
      }

      if (roomSetupOpen.value) return;
      if (isHost.value && roomStatus.value !== "solo" && roomStatus.value !== "inProgress" && roomStatus.value !== "countdown") {
        const settingsChanged = normalized.playerCount !== previousPlayerCount
          || normalized.boardShape !== previousBoardShape
          || normalized.gridSize !== previousGridSize
          || normalized.rulesVersion !== previousRulesVersion
          || normalized.turnTimerEnabled !== previousTurnTimerEnabled
          || normalized.turnTimeLimitSeconds !== previousTurnTimeLimitSeconds
          || normalized.undoEnabled !== previousUndoEnabled
          || normalized.undoMaxCount !== previousUndoMaxCount
          || (session.value.shared && JSON.stringify(normalized.turnOrder) !== JSON.stringify(previousTurnOrder));
        const starterChanged = normalized.startPlayer !== previousStartPlayer;

        if (settingsChanged) {
          void networkManager.updateRoomSettings(normalizeAppGameSettings({ ...normalized, botCount: roomInfo.value.settings?.botCount ?? 0 })).catch(handleNetworkError);
        } else if (starterChanged) {
          void networkManager.updateStartPlayer(normalized.startPlayer).catch(handleNetworkError);
        }
      }
    });

    watch(selectedLocalPlayers, () => {
      cancelHintRequest();
      terminateAiWorker();
      persistLocalMatchPreferences(selectedLocalPlayers.value, draftGameSettings());
      if (!localSetupPending.value) scheduleAiMove(gameState.value);
    }, { deep: true });
    watch(selectedStartingPoints, () => {
      if (syncingRemoteSettings || tutorialActive.value || roomStatus.value !== "solo") return;
      cancelHintRequest();
      terminateAiWorker();
      persistLocalMatchPreferences(selectedLocalPlayers.value, draftGameSettings());
      if (!localSetupPending.value) scheduleAiMove(gameState.value);
    }, { deep: true });
    watch(localSetupPending, (pending) => {
      cancelHintRequest();
      terminateAiWorker();
      if (!pending) scheduleAiMove(gameState.value);
    });
    const handleBoardShapeChange = (shape) => {
      if (!['triangle', 'hexagon', 'custom'].includes(shape) || settingsLocked.value) return;
      if (shape === "custom") {
        if (selectedPlayerCount.value > 6) {
          selectedPlayerCount.value = 6;
          if (!APP_ALL_PLAYERS.slice(0, 6).includes(selectedStartPlayer.value)) selectedStartPlayer.value = APP_ALL_PLAYERS[0];
          selectedTurnOrder.value = resizeTurnOrder(selectedTurnOrder.value, 6, selectedStartPlayer.value);
        }
        if (!selectedTopologyDefinition.value || selectedTopologyGridSize.value !== selectedGridSize.value) selectTopologyPreset("cylinder");
        else selectTopologyDefinition(selectedTopologyDefinition.value, selectedTopologySource.value || "custom");
        return;
      }
      // Leaving a surface draft must also leave its version marker; otherwise
      // normalizeGameSettings correctly (but unexpectedly for this click)
      // continues to treat a legacy button press as an incomplete topology
      // request.
      selectedBoardShape.value = shape;
      selectedRulesVersion.value = APP_DEFAULT_RULES_VERSION;
      selectedStartingPoints.value = {};
      setTopologySetupMessage("");
    };
    const updateLocalPlayer = ({ color, patch, fromLab = false }) => {
      if (settingsLocked.value || (roomStatus.value !== "solo" && !roomSetupOpen.value) || !APP_ALL_PLAYERS.slice(0, selectedPlayerCount.value).includes(color)) return;
      if (fromLab) {
        if (selectedPlayerCount.value !== 2 || selectedBoardShape.value !== "triangle") return;
        explicitLabColors.add(color);
      } else explicitLabColors.delete(color);
      terminateAiWorker();
      const players = { ...selectedLocalPlayers.value, [color]: { ...selectedLocalPlayers.value[color], ...patch } };
      selectedLocalPlayers.value = roomSetupOpen.value ? normalizeRoomPlayerSetup(draftGameSettings(), players)
        : normalizeLocalPlayers(players, selectedPlayerCount.value, selectedBoardShape.value);
      persistLocalMatchPreferences(selectedLocalPlayers.value, draftGameSettings());
    };
    const swapLocalPlayers = () => {
      if (settingsLocked.value || roomStatus.value !== "solo") return;
      terminateAiWorker();
      selectedLocalPlayers.value = normalizeLocalPlayers({ ...selectedLocalPlayers.value, BLACK: selectedLocalPlayers.value.WHITE, WHITE: selectedLocalPlayers.value.BLACK }, selectedPlayerCount.value, selectedBoardShape.value);
      persistLocalMatchPreferences(selectedLocalPlayers.value, draftGameSettings());
    };
    const updateStartingPoints = (selection) => {
      if (settingsLocked.value || tutorialActive.value || replayMode.value) return;
      if (selectedBoardShape.value === "custom" || selectedRulesVersion.value === "surface-v1") return;
      selectedStartingPoints.value = startingPointSettings({ ...selection, gridSize: selectedGridSize.value, playerCount: selectedPlayerCount.value, boardShape: selectedBoardShape.value });
      startingPointPreviewFresh = true;
      cancelHintRequest();
      terminateAiWorker();
      if (roomStatus.value === "solo") persistLocalMatchPreferences(selectedLocalPlayers.value, draftGameSettings());
      else void networkManager.updateRoomSettings(normalizeAppGameSettings({ ...draftGameSettings(), botCount: roomInfo.value.settings?.botCount ?? 0 })).catch(handleNetworkError);
    };
    const toggleAiDuel = () => {
      if (selectedAiMode.value === "none" || localSetupPending.value || roomStatus.value !== "solo" || tutorialActive.value || replayMode.value || gameState.value.gameOver) return;
      aiDuelPaused.value = !aiDuelPaused.value;
      terminateAiWorker();
      saveLocalMatch();
      if (!aiDuelPaused.value) scheduleAiMove(gameState.value);
    };

    watch(() => gameState.value.multiplayerEnabled, (multiplayerEnabled) => {
      if (multiplayerEnabled) {
        cancelHintRequest();
        terminateAiWorker();
      } else {
        scheduleAiMove(gameState.value);
      }
    });

    watch(roomStatus, (status) => {
      if (status !== "solo") {
        cancelHintRequest();
        terminateAiWorker();
      } else {
        scheduleAiMove(gameState.value);
      }
    });

    watch(() => gameState.value.gameOver, (isGameOver) => {
      if (!isGameOver) {
        resultModalDismissed.value = false;
      } else {
        cancelHintRequest();
        terminateAiWorker();
      }
    });

    const syncSession = () => {
      // Lesson settings must not replace the saved match or online room settings.
      if (tutorialActive.value) return;
      const sourceSettings = roomStatus.value === "solo"
        ? currentGameSettings()
        : roomInfo.value.settings;
      const normalizedSettings = normalizeAppGameSettings(sourceSettings);
      const boardDefinition = normalizedSettings.boardDefinition;
      const boardHash = normalizedSettings.boardHash;
      session.value = {
        ...createAppEmptySession(),
        ...networkManager.getSession(),
        settings: {
          ...normalizedSettings,
          ...(boardDefinition ? { boardDefinition } : {}),
          ...(boardHash ? { boardHash } : {}),
        },
      };
      if (!standaloneTutorial) persistAppSession(session.value);
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
      (() => {
        const displayGridSize = tutorialActive.value
          ? currentTutorialLevel.value.gridSize
          : selectedGridSize.value;
        return uiStyle.value === UI_STYLE_ACADEMIC
          ? (language.value === "en"
            ? `${selectedPlayerCount.value}N / ${displayGridSize}`
            : `${selectedPlayerCount.value}\u8282\u70B9 / ${displayGridSize}`)
          : (language.value === "en"
            ? `${selectedPlayerCount.value}P / ${displayGridSize}`
            : `${selectedPlayerCount.value}\u4EBA / ${displayGridSize}`);
      })()
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
    const topologyGuideEntry = computed(() => guideEntries.value.find((entry) => entry.key === "topology") ?? null);
    const whyGuideEntry = computed(() => guideEntries.value.find((entry) => entry.group === "why") ?? null);
    const thanksGuideEntry = computed(() => guideEntries.value.find((entry) => entry.group === "thanks") ?? null);
    const activeGuideEntry = computed(() => (
      guideEntries.value.find((entry) => entry.key === activeGuideKey.value || entry.subEntries?.some((sub) => sub.key === activeGuideKey.value || (activeGuideKey.value === "rules-math-topology" && sub.key === "rules-math"))) ?? null
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
        : APP_ALL_PLAYERS.slice(0, selectedPlayerCount.value);
      return sourcePlayers.map((color) => ({
        value: color,
        label: formatAppPlayerName(color, language.value, uiStyle.value),
      }));
    });

    const cloneTopologyJson = (value) => {
      if (typeof structuredClone === "function") return structuredClone(value);
      return JSON.parse(JSON.stringify(value));
    };

    const topologyCompileError = (errors = []) => errors
      .map((error) => `${error.code ?? "INVALID"}${error.location ? ` @ ${error.location}` : ""}`)
      .join("; ") || (language.value === "zh" ? "棋盘定义无效。" : "Invalid board definition.");

    // The board definition must name every active seat before it becomes a
    // room identity.  TopologyGameEngine contains the deterministic graph
    // distance selector used by normal local creation, so use an isolated
    // instance to materialize those starts rather than inventing a second
    // (and potentially server-incompatible) selection rule in the UI.
    const materializeTopologyDefinition = (definition, playerCount = selectedPlayerCount.value,
      startPlayer = selectedStartPlayer.value) => {
      const compiled = compileBoard(definition);
      if (!compiled.ok) throw new Error(topologyCompileError(compiled.errors));
      const engine = new GameEngine({
        compiledBoard: compiled.value,
        playerCount,
        startPlayer,
        rulesVersion: "surface-v1",
        deferTerritoryUpdates: false,
      });
      if (!engine.isTopologyBoard || !engine.boardHash || !engine.boardDefinition) {
        throw new Error("Topology board runtime did not produce a canonical board identity.");
      }
      const finalCheck = compileBoard(engine.boardDefinition);
      if (!finalCheck.ok || finalCheck.value.boardHash !== engine.boardHash) {
        throw new Error("Topology board starts did not reproduce a canonical board hash.");
      }
      return {
        definition: cloneTopologyJson(engine.boardDefinition),
        boardHash: engine.boardHash,
        initialPositions: { ...engine.initialPositions },
      };
    };

    // Draft fields can be read before Vue flushes the count/starter watcher.
    // Reconcile only the local draft; authoritative room inputs stay strict.
    const draftTurnState = () => {
      const count = APP_PLAYER_COUNT_OPTIONS.includes(selectedPlayerCount.value) ? selectedPlayerCount.value : 2;
      const starter = APP_ALL_PLAYERS.slice(0, count).includes(selectedStartPlayer.value)
        ? selectedStartPlayer.value : APP_ALL_PLAYERS[0];
      return { starter, order: resizeTurnOrder(selectedTurnOrder.value, count, starter) };
    };

    const selectedTopologySettings = () => {
      if (!selectedTopologyDefinition.value) {
        throw new Error("Select, draw, generate, or import a topology board before starting.");
      }
      const { starter, order } = draftTurnState();
      const materialized = materializeTopologyDefinition(selectedTopologyDefinition.value, selectedPlayerCount.value, starter);
      return {
        playerCount: selectedPlayerCount.value,
        boardShape: "custom",
        botCount: 0,
        gridSize: selectedGridSize.value,
        startPlayer: starter,
        turnOrder: order,
        rulesVersion: "surface-v1",
        topologyProtocolVersion: "board-topology-v1",
        boardDefinition: materialized.definition,
        boardHash: materialized.boardHash,
        // The definition itself carries the fixed raw starts; this duplicate
        // is canonical IDs for the runtime only and never goes through the
        // coordinate-only legacy starting-point helper.
        initialPositions: materialized.initialPositions,
        turnTimerEnabled: selectedTurnTimerEnabled.value,
        turnTimeLimitSeconds: selectedTurnTimeLimitSeconds.value,
        hintEnabled: selectedHintEnabled.value,
        hintMaxCount: selectedHintMaxCount.value,
        undoEnabled: selectedUndoEnabled.value,
        undoMaxCount: selectedUndoMaxCount.value,
      };
    };

    function draftGameSettings() {
      const { starter, order } = draftTurnState();
      if (selectedBoardShape.value === "custom" || selectedRulesVersion.value === "surface-v1") {
        // Preserve the topology identity even while an incomplete selection is
        // being edited.  Callers that would construct a match catch the
        // explicit missing-definition error above; nothing falls back to a
        // legacy triangle.
        if (selectedTopologyDefinition.value) return selectedTopologySettings();
        return {
          playerCount: selectedPlayerCount.value,
          boardShape: "custom",
          botCount: 0,
          gridSize: selectedGridSize.value,
          startPlayer: starter,
          turnOrder: order,
          rulesVersion: "surface-v1",
          topologyProtocolVersion: "board-topology-v1",
          turnTimerEnabled: selectedTurnTimerEnabled.value,
          turnTimeLimitSeconds: selectedTurnTimeLimitSeconds.value,
          hintEnabled: selectedHintEnabled.value,
          hintMaxCount: selectedHintMaxCount.value,
          undoEnabled: selectedUndoEnabled.value,
          undoMaxCount: selectedUndoMaxCount.value,
        };
      }
      return {
        playerCount: selectedPlayerCount.value,
        boardShape: selectedBoardShape.value,
        gridSize: selectedGridSize.value,
        startPlayer: starter,
        turnOrder: order,
        rulesVersion: selectedRulesVersion.value,
        ...(roomStatus.value !== "solo"
          ? { protectionRule: roomInfo.value.settings?.protectionRule ?? "symmetric-v1" } : {}),
        turnTimerEnabled: selectedTurnTimerEnabled.value,
        turnTimeLimitSeconds: selectedTurnTimeLimitSeconds.value,
        hintEnabled: selectedHintEnabled.value,
        hintMaxCount: selectedHintMaxCount.value,
        undoEnabled: selectedUndoEnabled.value,
        undoMaxCount: selectedUndoMaxCount.value,
        ...selectedStartingPoints.value,
      };
    }

    const setTopologySetupMessage = (message, error = false) => {
      topologySetupMessage.value = error ? `ERROR: ${message}` : message;
    };
    // Transient feedback is produced in the active language; clear it on a
    // language switch so an old error cannot linger in the other language.
    watch(language, () => { topologySetupMessage.value = ""; });
    const removedSeamMessage = (ids) => ids?.length
      ? (language.value === "zh" ? `轮廓改变使 ${ids.length} 对粘边失效，已移除：${ids.join("、")}。` : `Contour change invalidated ${ids.length} seam pair(s), removed: ${ids.join(", ")}.`)
      : "";

    const selectTopologyDefinition = (definition, source = "custom") => {
      try {
        const priorShape = selectedBoardShape.value;
        const materialized = materializeTopologyDefinition(definition);
        syncingRemoteSettings = true;
        try {
          selectedTopologyDefinition.value = materialized.definition;
          selectedTopologyGridSize.value = selectedGridSize.value;
          if (source !== "自定义起点" && source !== "custom starts") topologyDefaultSelection.value = cloneTopologyJson(materialized.definition);
          selectedTopologyHash.value = materialized.boardHash;
          selectedTopologySource.value = source;
          topologyDefinitionText.value = JSON.stringify(materialized.definition, null, 2);
          selectedBoardShape.value = "custom";
          selectedRulesVersion.value = "surface-v1";
          // Starts are fixed inside the definition.  Keeping canonical IDs out
          // of the legacy setup component prevents coordinate coercion.
          selectedStartingPoints.value = { startingPointMode: "topology", initialPositions: materialized.initialPositions };
          selectedRoomBotCount.value = 0;
          selectedLocalPlayers.value = normalizeLocalPlayers(
            selectedLocalPlayers.value,
            selectedPlayerCount.value,
            "custom",
          );
        } finally {
          syncingRemoteSettings = false;
        }
        if (priorShape === "custom" && !roomSetupOpen.value && isHost.value && roomStatus.value !== "solo"
          && roomStatus.value !== "inProgress" && roomStatus.value !== "countdown") {
          void networkManager.updateRoomSettings(normalizeAppGameSettings({ ...draftGameSettings(), botCount: 0 })).catch(handleNetworkError);
        }
        setTopologySetupMessage(language.value === "zh" ? "棋盘已验证。" : "Board validated.");
        return materialized;
      } catch (error) {
        setTopologySetupMessage(language.value === "zh" ? `棋盘验证失败，请检查轮廓、粘边和起点。${topologyCompileError(error?.errors ?? [])}` : (error?.message ?? String(error)), true);
        return null;
      }
    };

    const selectTopologyPreset = (name) => {
      try {
        const definition = createSurfacePreset(name, { gridSize: selectedGridSize.value });
        return selectTopologyDefinition(definition, name);
      } catch (error) {
        setTopologySetupMessage(language.value === "zh" ? "无法生成这个曲面预设，请检查尺寸后重试。" : (error?.message ?? String(error)), true);
        return null;
      }
    };

    let topologyRandomCounter = 0;
    const generateTopologyBoard = () => {
      const entropy = new Uint32Array(2);
      if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(entropy);
      else { entropy[0] = Math.floor(Math.random() * 0x100000000); entropy[1] = Date.now() >>> 0; }
      topologyRandomSeed.value = `${Date.now()}-${++topologyRandomCounter}-${entropy[0]}-${entropy[1]}`;
      const generated = generateBoard({
        gridSize: selectedGridSize.value,
        playerCount: selectedPlayerCount.value,
        roughness: 0.45,
        minimumChannelWidth: 2,
        minStartDistance: 2,
        maxAttempts: 24,
      }, topologyRandomSeed.value, "random-board-v4");
      if (!generated.ok) {
        setTopologySetupMessage(topologyCompileError(generated.errors), true);
        return null;
      }
      if (selectedTopologyDefinition.value && topologyGeometrySignature(generated.definition) === topologyGeometrySignature(selectedTopologyDefinition.value)) {
        setTopologySetupMessage(language.value === "zh" ? "生成结果与当前棋盘相同，请重试。" : "The generated board matches the current board; please retry.", true);
        return null;
      }
      const selected = selectTopologyDefinition(generated.definition, language.value === "zh" ? "随机棋盘" : "random board");
      if (selected) {
        setTopologySetupMessage(language.value === "zh" ? "随机棋盘已生成。" : "Random board generated.");
      }
      return selected;
    };

    const handleGridSizeChange = (size) => {
      if (settingsLocked.value || !APP_GRID_SIZE_OPTIONS.includes(size) || size === selectedGridSize.value) return;
      const previousSize = selectedGridSize.value;
      const previousDraft = topologyDraft.value;
      topologyDraftsBySize.set(previousSize, previousDraft);
      topologyDraft.value = topologyDraftsBySize.get(size) ?? createBoardDraft();
      selectedGridSize.value = size;
      if (selectedBoardShape.value === "custom") {
        // Rebuild a selected preset at the new size. Random maps remain
        // random; hand-drawn drafts stay cached separately for each size.
        const oldDefinition = selectedTopologyDefinition.value;
        const oldPreset = oldDefinition?.topology?.preset;
        const supportedPreset = PRODUCT_SURFACE_PRESETS.includes(oldPreset);
        const wasRandom = Boolean(oldDefinition?.generator);
        const selected = supportedPreset ? selectTopologyPreset(oldPreset)
          : wasRandom ? generateTopologyBoard() : selectTopologyPreset("cylinder");
        if (!selected) {
          selectedGridSize.value = previousSize;
          topologyDraft.value = previousDraft;
          return;
        }
        setTopologySetupMessage(language.value === "zh"
          ? (supportedPreset ? "尺寸已更改，保留所选曲面并恢复其默认起点；手绘草稿按尺寸保留。"
            : wasRandom ? "尺寸已更改，已生成新的随机地图及默认起点；手绘草稿按尺寸保留。"
            : "尺寸已更改，已选圆柱；手绘草稿按尺寸保留，可切回原尺寸继续编辑。")
          : (supportedPreset ? "Size changed; the selected surface is retained with its default starts. Drawn drafts are kept per size."
            : wasRandom ? "Size changed; a new random map and its starts were generated. Drawn drafts are kept per size."
            : "Size changed; a cylinder was selected. Drawn drafts are kept per size and can be resumed at the original size."));
      }
    };
    const updateTopologyStarts = (options) => {
      if (settingsLocked.value || !selectedTopologyDefinition.value) return;
      try {
        const compiled = compileBoard(options.mode === "default"
          ? (topologyDefaultSelection.value ?? topologyDefaultDefinition(selectedTopologyDefinition.value, selectedGridSize.value)) : selectedTopologyDefinition.value);
        if (!compiled.ok) throw new Error(topologyCompileError(compiled.errors));
        const definition = createTopologyStartingDefinition(compiled.value, { ...options, playerCount: selectedPlayerCount.value });
        selectTopologyDefinition(definition, language.value === "zh" ? "自定义起点" : "custom starts");
      } catch (error) {
        const messages = { START_ROOTS_FULL: ["该方已有 6 个起点。", "This player already has 6 starts."], INSUFFICIENT_START_VERTICES: ["没有可用棋位，起点未更改。", "No unclaimed point is available; starts were not changed."], INVALID_START_PLAYER: ["请先选择一方。", "Select a player first."] };
        const message = messages[error?.code];
        setTopologySetupMessage(message ? message[language.value === "zh" ? 0 : 1] : (language.value === "zh" ? "起点无效，请检查各方起点数量及位置。" : (error?.message ?? String(error))), true);
      }
    };
    const addTopologyDraftVertex = (coordinate = [topologyDraftX.value, topologyDraftY.value]) => {
      const result = addBoundaryVertex(topologyDraft.value, coordinate);
      if (!result.ok) {
        const messages = { NON_LATTICE_EDGE: "请沿相邻的点画边。", SELF_TOUCH: "边界不能重复经过同一个点。", SELF_INTERSECTION: "边界不能与已有线段相交。" };
        setTopologySetupMessage(language.value === "zh" ? (messages[result.code] ?? `无法修改轮廓。（${result.code}）`) : (result.detail ?? result.code), true);
        return false;
      }
      topologyDraft.value = result.draft;
      setTopologySetupMessage("");
      return true;
    };

    const undoTopologyDraftVertex = () => {
      const result = undoBoundaryVertex(topologyDraft.value);
      if (!result.ok) {
        setTopologySetupMessage(language.value === "zh" ? `无法撤销当前操作。（${result.code}）` : (result.detail ?? result.code), true);
        return false;
      }
      if (result.definition && !selectTopologyDefinition(result.definition, language.value === "zh" ? "绘制边界粘合" : "drawn boundary seams")) return false;
      topologyDraft.value = result.draft;
      setTopologySetupMessage("");
      return true;
    };

    const resetTopologyDraft = () => {
      const result = cancelBoardDraft(topologyDraft.value);
      topologyDraft.value = result.draft;
      setTopologySetupMessage("");
      return true;
    };

    const newTopologyDraftRing = () => {
      const result = startBoundaryRing(topologyDraft.value);
      if (!result.ok) { setTopologySetupMessage(language.value === "zh" ? `请先闭合当前轮廓。（${result.code}）` : (result.detail ?? result.code), true); return false; }
      topologyDraft.value = result.draft;
      setTopologySetupMessage(language.value === "zh" ? "新轮廓闭合前保留当前已选地图。" : "The selected board remains in place until the new contour is closed.");
      return true;
    };
    const deleteTopologyDraftRing = (index) => {
      const result = deleteBoundaryRing(topologyDraft.value, index);
      if (!result.ok) { setTopologySetupMessage(language.value === "zh" ? `无法删除轮廓。（${result.code}）` : (result.detail ?? result.code), true); return false; }
      if (result.definition) {
        const compiled = compileBoard(result.definition);
        if (!compiled.ok) { setTopologySetupMessage(topologyCompileError(compiled.errors), true); return false; }
        if (!selectTopologyDefinition(result.definition, language.value === "zh" ? "绘制边界" : "drawn boundary")) return false;
      }
      topologyDraft.value = result.draft;
      if (result.removedSeams?.length) setTopologySetupMessage(removedSeamMessage(result.removedSeams));
      else if (!result.definition) setTopologySetupMessage(language.value === "zh" ? "轮廓草稿已更新；当前已选地图保留到新轮廓闭合。" : "Draft updated; the selected board remains until a new contour is closed.");
      return true;
    };
    const closeTopologyDraft = () => {
      const result = closeBoundaryDraft(topologyDraft.value);
      if (!result.ok) {
        const messages = { DEGENERATE_BOUNDARY: "边界至少需要三个不共线的点。", OPEN_BOUNDARY: "请先画到起点旁的相邻点，再点击起点闭合。", SELF_INTERSECTION: "闭合线不能与已有边界相交。", EMPTY_INTERIOR: "边界内需要包含可用的三角格。" };
        setTopologySetupMessage(language.value === "zh" ? (messages[result.code] ?? `无法闭合轮廓。（${result.code}）`) : (result.detail ?? result.code), true);
        return false;
      }
      const compiled = compileBoard(result.definition);
      if (!compiled.ok) {
        setTopologySetupMessage(topologyCompileError(compiled.errors), true);
        return false;
      }
      const selected = selectTopologyDefinition(result.definition, language.value === "zh" ? "绘制边界" : "drawn boundary");
      if (!selected) return false;
      topologyDraft.value = result.draft;
      if (result.removedSeams?.length) setTopologySetupMessage(removedSeamMessage(result.removedSeams));
      return true;
    };

    const addTopologyDraftSeam = ({ edgeOccurrenceA, edgeOccurrenceB, endpointMap } = {}) => {
      const usedIds = new Set((topologyDraft.value.seamPairs ?? []).map(pair => pair.id));
      let seamNumber = 1;
      while (usedIds.has(`seam:${seamNumber}`)) seamNumber += 1;
      const nextSeamId = `seam:${seamNumber}`;
      const result = addSeamPair(topologyDraft.value, {
        id: nextSeamId,
        edgeOccurrenceA,
        edgeOccurrenceB,
        endpointMap,
      });
      if (!result.ok) {
        setTopologySetupMessage(language.value === "zh" ? `无法粘合：请检查边是否已使用，并尝试更换边或箭头方向。（${result.code}）` : (result.detail ?? result.code), true);
        return false;
      }
      // Compile before committing either the visible draft or the active
      // selection, so an illegal surface never replaces an already playable
      // board merely because it was clicked in the editor.
      const selected = selectTopologyDefinition(result.definition,
        language.value === "zh" ? "绘制边界粘合" : "drawn boundary seams");
      if (!selected) {
        if (language.value === "zh") topologySetupMessage.value = `ERROR: 无法按此方向粘合，请重新选择边或反转箭头。${topologySetupMessage.value.replace(/^ERROR:\s*/, "")}`;
        return false;
      }
      topologyDraft.value = result.draft;
      return true;
    };

    const loadTopologyDefinitionText = () => {
      try {
        const definition = JSON.parse(topologyDefinitionText.value);
        return Boolean(selectTopologyDefinition(definition,
          language.value === "zh" ? "导入 JSON" : "imported JSON"));
      } catch (error) {
        setTopologySetupMessage(language.value === "zh" ? "无法读取棋盘 JSON，请检查格式。" : (error?.message ?? String(error)), true);
        return false;
      }
    };

    const currentGameSettings = () => roomStatus.value === "solo" && !tutorialActive.value
      ? { ...activeLocalSettings.value } : draftGameSettings();
    const currentLocalMatch = () => ({ players: activeLocalPlayers.value, started: localMatchStarted.value, paused: aiDuelPaused.value, undo: undoUsage.value });
    const topologySessionMetadata = () => ({
      startPlayer: activeLocalSettings.value?.startPlayer,
      settings: {
        gridSize: activeLocalSettings.value?.gridSize,
        turnTimerEnabled: activeLocalSettings.value?.turnTimerEnabled,
        turnTimeLimitSeconds: activeLocalSettings.value?.turnTimeLimitSeconds,
        hintEnabled: activeLocalSettings.value?.hintEnabled,
        hintMaxCount: activeLocalSettings.value?.hintMaxCount,
        undoEnabled: activeLocalSettings.value?.undoEnabled,
        undoMaxCount: activeLocalSettings.value?.undoMaxCount,
      },
      match: currentLocalMatch(),
    });
    const isTopologyLocalMatch = () => Boolean(controller.value?.engine?.isTopologyBoard
      || isTopologyGameSettings(currentGameSettings()));
    const topologyActionFromControllerAction = (action, boardHash = controller.value?.engine?.boardHash) => {
      if (!action?.type) return null;
      if (action.type === "move" || action.type === "player_move") {
        const vertexId = action.vertexId ?? action.point;
        return typeof vertexId === "string" && typeof boardHash === "string"
          ? { type: "player_move", vertexId, boardHash }
          : null;
      }
      if (action.type === "skip" || action.type === "player_skip") return { type: "player_skip" };
      if (action.type === "resign" || action.type === "player_resign") {
        const color = action.color ?? action.player;
        return typeof color === "string" ? { type: "player_resign", color } : null;
      }
      return null;
    };
    const topologyActionsForController = (actions, boardHash) => actions.map((action) => {
      if (action?.boardHash != null && action.boardHash !== boardHash) throw new Error("Topology action board identity mismatch.");
      const normalized = topologyActionFromControllerAction(action, boardHash);
      if (!normalized) throw new Error("Topology action history is malformed.");
      return normalized;
    });
    const persistTopologyMatch = () => {
      const engine = controller.value?.engine;
      if (!engine?.isTopologyBoard) return false;
      try {
        const session = createTopologyLocalGameSession(
          engine.encodeTopologyState(),
          topologyActionsForController(localGameActions.value, engine.boardHash),
          topologySessionMetadata(),
        );
        topologyLocalSession = session;
        return persistTopologyLocalGameSession(session);
      } catch (error) {
        console.warn("Could not persist topology local match.", error);
        return false;
      }
    };
    const saveLocalMatch = () => {
      if (roomStatus.value !== "solo" || tutorialActive.value || localGameRestoring.value || replayMode.value) return;
      if (isTopologyLocalMatch()) {
        persistTopologyMatch();
        return;
      }
      persistLocalGameSession(createLocalGameSession(currentGameSettings(), localGameActions.value, currentLocalMatch()));
    };
    const armContributionForFreshLocalMatch = () => {
      invalidateContributionTicket();
      if (!contribution.enabled || roomStatus.value !== "solo" || tutorialActive.value || replayMode.value
        || localGameActions.value.length !== 0) return false;
      const settings = currentGameSettings();
      const actors = localMatchActors(activeLocalPlayers.value, settings.playerCount, settings.gridSize, settings.boardShape);
      if (!supportsContributionActors(actors, settings)) return false;
      contributionContext = { source: "local", actors, mixedProfiles: false, hintsEnabled: settings.hintEnabled === true,
        undo: { enabled: settings.undoEnabled === true, maxCount: settings.undoMaxCount ?? 3, usedCount: 0 } };
      contributionProfileSignature = JSON.stringify(actors);
      return true;
    };
    const startLocalMatch = async () => {
      if (!controller.value || settingsLocked.value || roomStatus.value !== "solo" || localGameRestoring.value) return false;
      clearLocalGameNotice();
      setActionFeedback("", "neutral");
      localGameRestoring.value = true;
      let stoppedSearch = false;
      try {
        // A new random match gets a fresh opening. A pending preview is used
        // exactly as displayed, and saved matches never reroll on restoration.
        if (selectedBoardShape.value !== "custom" && localMatchStarted.value && !localSettingsChanged.value
          && !startingPointPreviewFresh && selectedStartingPoints.value.startingPointMode === "random") {
          const selectedRootMode = selectedStartingPoints.value.rootMode ?? RootMode.CLASSIC;
          selectedStartingPoints.value = selectedRootMode === RootMode.CLASSIC
            ? { startingPointMode: "random", initialPositions: randomInitialPositions(selectedGridSize.value, selectedPlayerCount.value, Math.random, selectedBoardShape.value) }
            : { rootMode: selectedRootMode, startingPointMode: "random", initialRoots: randomInitialRoots(selectedGridSize.value, selectedPlayerCount.value, selectedRootMode, Math.random, selectedBoardShape.value) };
        }
        const pendingSettings = draftGameSettings();
        if (isTopologyGameSettings(pendingSettings) && !pendingSettings.boardDefinition) {
          throw new Error(language.value === "zh"
            ? "请先选择、绘制、生成或导入一个有效的拓扑棋盘。"
            : "Select, draw, generate, or import a valid topology board first.");
        }
        const nextSettings = prepareTopologyNewMatchSettings(normalizeAppGameSettings(pendingSettings));
        const nextPlayers = prepareLocalPlayersForNewMatch(selectedLocalPlayers.value, nextSettings.playerCount, nextSettings.boardShape, explicitLabColors);
        const unsupportedPlayer = APP_ALL_PLAYERS.slice(0, nextSettings.playerCount).find((player) =>
          !supportsRootModeAI(localPlayerProfile(nextPlayers[player], nextSettings.playerCount, nextSettings.gridSize, nextSettings.boardShape), nextSettings.rootMode));
        if (unsupportedPlayer) throw new Error(language.value === "zh" ? "当前起点玩法不支持所选 AI。" : "The selected AI does not support this root mode.");
        if (isTopologyGameSettings(nextSettings)) {
          // Check every seat on an isolated initial position. Use precisely the
          // definition that will be committed, including all user-chosen roots.
          // The controller also removes the legacy first-root fields when the
          // definition carries its complete roots.
          const candidateOptions = { ...nextSettings, deferTerritoryUpdates: false };
          if (Object.keys(candidateOptions.boardDefinition?.startingVertices ?? {}).length) delete candidateOptions.initialPositions;
          const candidate = new GameEngine(candidateOptions);
          const blockedPlayers = candidate.activePlayers.filter((player) => candidate.getLegalMoves(player).length === 0);
          if (blockedPlayers.length) {
            const names = blockedPlayers.map((player) => formatAppPlayerName(player, language.value, uiStyle.value)).join(language.value === "zh" ? "、" : ", ");
            const message = language.value === "zh"
              ? `该尺寸和起点布局使部分玩家开局无路可走（${names}），请增大棋盘、减少人数或调整起点。`
              : `Some players have no legal opening move at this size and starting layout (${names}). Choose a larger board, fewer players, or different starts.`;
            setTopologySetupMessage(message, true);
            throw new Error(message);
          }
          if (topologySetupMessage.value.startsWith("ERROR:")) setTopologySetupMessage("");
        }
        terminateAiWorker();
        cancelHintRequest();
        stoppedSearch = true;
        // Construct the candidate first. A rejected configuration must not
        // erase the saved match or replace its active player/settings metadata.
        const nextState = controller.value.setGameConfig(nextSettings, true);
        if (isTopologyGameSettings(nextSettings)) {
          selectedTopologyDefinition.value = cloneTopologyJson(nextSettings.boardDefinition);
          selectedTopologyHash.value = nextSettings.boardHash;
        }
        activeLocalSettings.value = nextSettings;
        activeLocalPlayers.value = nextPlayers;
        explicitLabColors.clear();
        localMatchStarted.value = true;
        aiDuelPaused.value = false;
        clearSavedLocalGame();
        armContributionForFreshLocalMatch();
        gameState.value = nextState;
        startingPointPreviewFresh = false;
        localGamePositionRevision.value = gameState.value.positionRevision;
        overlayResult.value = null;
        resultModalDismissed.value = false;
        resetHintUsage();
        await nextTick();
      } catch (error) {
        setActionFeedback(error?.message ?? String(error), "error");
        localGameRestoring.value = false;
        if (stoppedSearch) scheduleAiMove(gameState.value);
        return false;
      } finally { localGameRestoring.value = false; }
      persistLocalMatchPreferences(selectedLocalPlayers.value, draftGameSettings());
      saveLocalMatch();
      activeUtilityDeck.value = "";
      scheduleAiMove(gameState.value);
      return true;
    };
    const currentTutorialLevel = computed(() => getTutorialLevel(tutorialLevelIndex.value));
    const boardInspectionOverlay = computed(() => tutorialActive.value
      ? getTutorialInspectionOverlay(currentTutorialLevel.value, tutorialStartSnapshot.value, tutorialResultSnapshot.value ?? tutorialStartSnapshot.value, tutorialSuccess.value, tutorialRestrictionObserved.value)
      : replayInspectionOverlay.value);

    const clearLocalGameNotice = () => {
      localGameResumeNotice.value = "";
      if (localGameNoticeTimeoutId !== null) {
        globalThis.clearTimeout(localGameNoticeTimeoutId);
        localGameNoticeTimeoutId = null;
      }
    };

    const showLocalGameNotice = (message) => {
      clearLocalGameNotice();
      localGameResumeNotice.value = message;
      localGameNoticeTimeoutId = globalThis.setTimeout(() => {
        localGameResumeNotice.value = "";
        localGameNoticeTimeoutId = null;
      }, 5000);
    };

    const clearSavedLocalGame = () => {
      localGameActions.value = [];
      undoUsage.value = normalizeUndoUsage();
      invalidateContributionTicket();
      localGamePositionRevision.value = -1;
      topologyLocalSession = null;
      clearLocalGameSession();
      clearTopologyLocalGameSession();
    };

    const persistCurrentLocalGame = (nextState) => {
      if (replayRestoring.value || replayMode.value || tutorialActive.value || roomStatus.value !== "solo") {
        invalidateContributionTicket();
        return;
      }
      if (
        localGameRestoring.value
        || !nextState
        || nextState.positionRevision === localGamePositionRevision.value
      ) {
        return;
      }

      const action = nextState.lastAction;
      if (!action?.type) {
        localGamePositionRevision.value = nextState.positionRevision ?? localGamePositionRevision.value;
        return;
      }

      if (controller.value?.engine?.isTopologyBoard) {
        const engine = controller.value.engine;
        const topologyAction = topologyActionFromControllerAction(action, engine.boardHash);
        if (!topologyAction) {
          console.warn("Topology controller emitted an invalid local action.", action);
          return;
        }
        let nextSession;
        try {
          const encodedState = engine.encodeTopologyState();
          const baseSession = topologyLocalSession ?? createTopologyLocalGameSession(
            encodedState,
            topologyActionsForController(localGameActions.value, engine.boardHash),
            topologySessionMetadata(),
          );
          // appendTopologyLocalGameAction validates the action family and the
          // canonical board identity while the state is still isolated.
          nextSession = appendTopologyLocalGameAction(
            baseSession,
            topologyAction,
            encodedState,
            topologySessionMetadata(),
          );
        } catch (error) {
          console.warn("Could not append topology local action.", error);
          return;
        }
        if (!nextSession) return;
        const nextUndoUsage = recordUndoAction(undoUsage.value, action.player);
        persistTopologyLocalGameSession(nextSession);
        topologyLocalSession = nextSession;
        undoUsage.value = nextUndoUsage;
        localGameActions.value = [...localGameActions.value, topologyAction];
        localGamePositionRevision.value = nextState.positionRevision;
        return;
      }

      const nextUndoUsage = recordUndoAction(undoUsage.value, action.player);
      const nextMatch = { ...currentLocalMatch(), undo: nextUndoUsage };
      const nextSession = localGameActions.value.length === 0
        ? createLocalGameSession(currentGameSettings(), [action], nextMatch)
        : appendLocalGameAction(
          createLocalGameSession(currentGameSettings(), localGameActions.value, nextMatch),
          action,
        );
      if (!nextSession) {
        return;
      }

      // Keep the in-memory history usable even if browser storage is full.
      persistLocalGameSession(nextSession);
      undoUsage.value = nextUndoUsage;
      localGameActions.value = nextSession.actions;
      localGamePositionRevision.value = nextState.positionRevision;
      if (contribution.enabled) {
        const settings = currentGameSettings();
        const actors = localMatchActors(activeLocalPlayers.value, activeLocalSettings.value.playerCount, activeLocalSettings.value.gridSize, activeLocalSettings.value.boardShape);
        const signature = JSON.stringify(actors);
        if (contributionContext && !supportsContributionActors(actors, settings)) {
          invalidateContributionTicket();
        } else if (contributionContext && signature !== contributionProfileSignature) {
          contributionContext.actors = actors;
          contributionContext.mixedProfiles = true;
          contributionProfileSignature = signature;
        }
        if (contributionContext) {
          contributionContext.hintsEnabled = settings.hintEnabled === true;
          contributionContext.undo = { enabled: settings.undoEnabled === true, maxCount: settings.undoMaxCount ?? 3, usedCount: undoUsage.value.usedCount };
        }
        if (nextState.gameOver && contributionContext) {
          void contribution.enqueue(settings, nextSession.actions, contributionContext)
            .then(retryContributions).catch(() => { contribution.status = "retry"; contribution.save(); });
        }
      }
    };

    const setActionFeedback = (message, tone = "neutral") => {
      actionFeedback.value = message;
      actionFeedbackTone.value = tone;
    };

    // Transient feedback is already formatted in the language active when it
    // was produced. Clear it on a language change without touching the match.
    watch(language, () => {
      clearLocalGameNotice();
      setActionFeedback("");
    });

    const stopReplayPlayback = () => {
      if (replayPlaybackId !== null) {
        globalThis.clearInterval(replayPlaybackId);
        replayPlaybackId = null;
      }
      replayPlaying.value = false;
    };

    const isTopologyReplayDocument = (document) => document?.format === TOPOLOGY_REPLAY_FORMAT;
    const topologyReplaySettings = (document) => {
      const decoded = decodeTopologyState(document?.initialState?.topologyState);
      return normalizeAppGameSettings({
        playerCount: Object.keys(decoded.ruleState.startingVertices ?? {}).length,
        boardShape: "custom",
        rulesVersion: "surface-v1",
        topologyProtocolVersion: "board-topology-v1",
        boardDefinition: decoded.board.definition,
        boardHash: decoded.boardHash,
        startPlayer: decoded.ruleState.currentPlayer ?? "BLACK",
        initialPositions: decoded.ruleState.startingVertices,
      });
    };
    const toControllerReplayActions = (document) => {
      if (isTopologyReplayDocument(document)) {
        return document.actions.map((action) => ({
          type: action.type === "move" ? "player_move" : action.type === "skip" ? "player_skip" : "player_resign",
          ...(action.type === "move" ? { vertexId: action.vertexId, boardHash: document.boardHash } : {}),
          ...(action.type === "resign" ? { color: action.actor } : {}),
        }));
      }
      return document.actions.map((action) => ({
        type: action.type === "move" ? "player_move" : action.type === "skip" ? "player_skip" : action.type === "root_relocate" ? "player_root_relocate" : action.type === "root_add" ? "player_root_add" : "player_resign",
        ...(["move", "root_relocate", "root_add"].includes(action.type) ? { point: [...action.point] } : {}),
        ...(action.type === "resign" ? { color: action.actor } : {}),
      }));
    };

    const restoreReplayPrefix = (cursor = replayCursor.value) => {
      if (!controller.value || !replayDocument.value) {
        return false;
      }
      cancelAiComparison();
      aiComparison.value = null;
      aiComparisonError.value = "";
      replayInspectionPoint.value = null;
      const boundedCursor = Math.max(0, Math.min(Number(cursor) || 0, replayActions.value.length));
      replayRestoring.value = true;
      terminateAiWorker();
      try {
        const settings = isTopologyReplayDocument(replayDocument.value)
          ? topologyReplaySettings(replayDocument.value)
          : replayDocument.value.config;
        const restored = controller.value.restoreMatchState({
          settings,
          actions: replayActions.value.slice(0, boundedCursor),
        });
        if (!restored.success) {
          replayError.value = language.value === "zh"
            ? `复盘第 ${boundedCursor} 步失败：${restored.reason}`
            : `Could not load review step ${boundedCursor}: ${restored.reason}`;
          return false;
        }
        replayCursor.value = boundedCursor;
        gameState.value = restored.state;
        return true;
      } finally {
        replayRestoring.value = false;
      }
    };

    const handleExportReplay = async () => {
      if (roomStatus.value !== "solo" || tutorialActive.value || replayMode.value || localGameActions.value.length === 0) {
        replayError.value = language.value === "zh" ? "只有完成至少一步的本地对局可以导出棋谱。" : "Export is available after at least one local move.";
        return;
      }
      replayBusy.value = true;
      replayError.value = "";
      try {
        const settings = currentGameSettings();
        const document = isTopologyGameSettings(settings)
          ? await createTopologyReplayDocument(settings,
            topologyActionsForController(localGameActions.value, settings.boardHash))
          : await createReplayDocument(settings, localGameActions.value, {
            actors: localMatchActors(activeLocalPlayers.value, settings.playerCount, settings.gridSize, settings.boardShape),
          });
        downloadReplayDocument(document, isTopologyGameSettings(settings)
          ? "lifeline-topology-replay.json" : "lifeline-replay.json");
        setActionFeedback(language.value === "zh" ? "棋谱已导出。" : "Replay exported.", "success");
      } catch (error) {
        replayError.value = error?.message ?? String(error);
      } finally {
        replayBusy.value = false;
      }
    };

    const handleImportReplay = async (text) => {
      if (replayMode.value || roomStatus.value !== "solo" || tutorialActive.value) return;
      replayBusy.value = true;
      replayError.value = "";
      try {
        let parsed;
        try {
          parsed = JSON.parse(String(text));
        } catch {
          parsed = null;
        }
        const result = parsed?.format === TOPOLOGY_REPLAY_FORMAT
          ? await validateTopologyReplayDocument(parsed)
          : await parseAndValidateReplay(text);
        if (!result.success) {
          replayError.value = language.value === "zh"
            ? (result.eventSeq ? `棋谱校验失败（第 ${result.eventSeq} 步）：${result.reason}` : `棋谱校验失败：${result.reason}`)
            : (result.eventSeq ? `Replay verification failed at step ${result.eventSeq}: ${result.reason}` : `Replay verification failed: ${result.reason}`);
          return;
        }
        if (replayMode.value || roomStatus.value !== "solo" || tutorialActive.value) return;
        replayDocument.value = result.document;
        replaySource.value = "imported";
        replayActions.value = isTopologyReplayDocument(result.document)
          ? result.actions.map((action) => ({
            ...action,
            ...(action.type === "player_move" ? { boardHash: result.boardHash } : {}),
          }))
          : result.actions;
        replayCursor.value = 0;
        cancelAiComparison();
        aiComparison.value = null;
        aiComparisonError.value = "";
        replayInspectionPoint.value = null;
        const eventCount = result.eventCount ?? result.actions?.length ?? 0;
        setActionFeedback(language.value === "zh" ? `棋谱已验证，共 ${eventCount} 步。点击“复盘导入棋谱”查看。` : `Replay verified: ${eventCount} steps. Choose “Review imported replay” to inspect it.`, "success");
      } catch (error) {
        replayError.value = error?.message ?? String(error);
      } finally {
        replayBusy.value = false;
      }
    };

    const handleStartReplay = async (source = "current") => {
      if (replayMode.value || replayBusy.value || !controller.value || roomStatus.value !== "solo" || networkBusy.value || tutorialActive.value) return;
      if (source === "current" && localGameActions.value.length === 0) return;
      if (source === "imported" && (replaySource.value !== "imported" || !replayDocument.value)) return;

      replayBusy.value = true;
      // Freeze AI turns while the replay document is built; resume if review fails.
      terminateAiWorker();
      replayError.value = "";
      try {
        if (source === "current") {
          const sourceController = controller.value;
          const sourceEngine = sourceController.engine;
          const sourceRevision = gameState.value.positionRevision;
          const sourceSettings = currentGameSettings();
          const sourceActions = JSON.parse(JSON.stringify(localGameActions.value));
          const document = isTopologyGameSettings(sourceSettings)
            ? await createTopologyReplayDocument(sourceSettings,
              topologyActionsForController(sourceActions, sourceSettings.boardHash))
            : await createReplayDocument(sourceSettings, sourceActions, {
              actors: localMatchActors(activeLocalPlayers.value, sourceSettings.playerCount, sourceSettings.gridSize, sourceSettings.boardShape),
            });
          if (roomStatus.value !== "solo" || networkBusy.value || tutorialActive.value
            || sourceController !== controller.value || sourceEngine !== controller.value?.engine
            || sourceRevision !== gameState.value.positionRevision
            || JSON.stringify(sourceActions) !== JSON.stringify(localGameActions.value)
            || JSON.stringify(sourceSettings) !== JSON.stringify(currentGameSettings())) {
            throw new Error(language.value === "zh" ? "棋局刚刚发生变化，请再点一次复盘本局。" : "The match changed. Start review again.");
          }
          replayDocument.value = document;
          replayActions.value = toControllerReplayActions(document);
          replayCursor.value = replayActions.value.length;
          replaySource.value = "current";
        }
        liveReplayRestore = {
          settings: currentGameSettings(),
          actions: [...localGameActions.value],
          // A topology match needs its complete rule state, including roots,
          // Superko history and current player; local actions are not a
          // legacy coordinate replay and must not be coerced into one.
          ...(controller.value.engine?.isTopologyBoard ? {
            topologyState: controller.value.engine.encodeTopologyState(),
            lastAction: controller.value.lastAction ? cloneTopologyJson(controller.value.lastAction) : null,
          } : {}),
          hintRemainingCount: hintRemainingCount.value,
        };
        stopReplayPlayback();
        cancelHintRequest();
        clearActiveHint();
        replayInspectionPoint.value = null;
        replayInspectorOpen.value = false;
        cancelAiComparison();
        aiComparison.value = null;
        aiComparisonError.value = "";
        replayMode.value = true;
        controller.value.setReadOnlyMode(true);
        if (!restoreReplayPrefix(replayCursor.value)) {
          const restoreError = replayError.value;
          handleExitReplay();
          replayError.value = restoreError;
          return;
        }
        activeUtilityDeck.value = "";
      } catch (error) {
        const message = error?.message ?? String(error);
        if (replayMode.value) handleExitReplay();
        replayError.value = message;
      } finally {
        replayBusy.value = false;
        if (!replayMode.value) scheduleAiMove(gameState.value);
      }
    };

    const handleExitReplay = () => {
      if (!replayMode.value || !controller.value || !liveReplayRestore) return;
      stopReplayPlayback();
      cancelAiComparison();
      aiComparison.value = null;
      aiComparisonError.value = "";
      replayInspectionPoint.value = null;
      replayRestoring.value = true;
      try {
        const restored = liveReplayRestore.topologyState
          ? controller.value.restoreTopologyState(liveReplayRestore.topologyState, {
            startPlayer: liveReplayRestore.settings?.startPlayer,
            lastAction: liveReplayRestore.lastAction,
            actions: liveReplayRestore.actions,
          })
          : controller.value.restoreMatchState(liveReplayRestore);
        if (!restored.success) {
          replayError.value = language.value === "zh"
            ? `退出复盘时无法恢复当前对局：${restored.reason}`
            : `Could not restore the match: ${restored.reason}`;
          return;
        }
        gameState.value = restored.state;
        hintRemainingCount.value = liveReplayRestore.hintRemainingCount;
        liveReplayRestore = null;
        replayMode.value = false;
        replayInspectorOpen.value = false;
        controller.value.setReadOnlyMode(false);
        activeUtilityDeck.value = "";
        setActionFeedback(language.value === "zh" ? "已退出复盘，原对局可以继续。" : "Review closed. Continue the original match.", "success");
      } finally {
        replayRestoring.value = false;
      }
      scheduleAiMove(gameState.value);
    };

    const handleSeekReplay = (cursor) => {
      if (replayMode.value) {
        stopReplayPlayback();
        cancelAiComparison();
        aiComparison.value = null;
        aiComparisonError.value = "";
        replayInspectionPoint.value = null;
        restoreReplayPrefix(cursor);
      }
    };

    const handleToggleReplayPlayback = () => {
      if (!replayMode.value || !replayDocument.value) return;
      if (replayPlaying.value) {
        stopReplayPlayback();
        return;
      }
      if (replayCursor.value >= replayActions.value.length) return;
      replayPlaying.value = true;
      replayPlaybackId = globalThis.setInterval(() => {
        if (!replayMode.value || !restoreReplayPrefix(replayCursor.value + 1) || replayCursor.value >= replayActions.value.length) {
          stopReplayPlayback();
        }
      }, 900);
    };

    const runAiComparisonDepth = (sourceEngine, serializedState, aiPlayer, strategy, depth, searchOptions = {}) => new Promise((resolve) => {
      let settled = false;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      try {
        aiComparisonWorkerSession.start({
          engine: sourceEngine,
          getCurrentEngine: () => replayMode.value ? controller.value?.engine : null,
          message: {
            type: "COMPUTE",
            serializedState,
            aiPlayer,
            strategy,
            depth,
            ...searchOptions,
            topN: 3,
          },
          onResult: (message) => settle({ ok: true, message }),
          onError: (error) => settle({ ok: false, error }),
          onFinish: ({ status }) => {
            if (status === "cancelled" || status === "stale") {
              settle({ ok: false, cancelled: true });
            }
          },
        });
      } catch (error) {
        settle({ ok: false, error });
      }
    });

    const runAiComparison = async () => {
      if (aiComparisonBusy.value || !replayMode.value || !controller.value?.engine
        || (!controller.value.engine.isTopologyBoard && controller.value.engine.playerCount >= 4)) {
        return;
      }

      cancelAiComparison();
      aiComparisonBusy.value = true;
      aiComparisonError.value = "";
      aiComparison.value = null;
      const sourceEngine = controller.value.engine;
      const serializedState = serializeEngineState(sourceEngine);
      const aiPlayer = sourceEngine.currentPlayer;
      const runs = [];

      try {
        const configurations = sourceEngine.isTopologyBoard ? [
          { id: "topology-2", strategy: "topology-generic", label: language.value === "zh" ? "拓扑搜索 · 深度 2" : "Topology search · depth 2", depth: 2, timeLimitMs: 3000 },
          { id: "topology-3", strategy: "topology-generic", label: language.value === "zh" ? "拓扑搜索 · 深度 3" : "Topology search · depth 3", depth: 3, timeLimitMs: 3000 },
        ] : [
          { id: "greedy", strategy: "greedy", depth: 1 },
          { id: "mcts-64", strategy: "mcts", depth: 0, simulations: 64, rolloutDepth: 40 },
          { id: "minimax-2", strategy: "minimax", depth: 2 },
          { id: "minimax-3", strategy: "minimax", depth: 3 },
          { id: "minimax-4", strategy: "minimax", depth: 4 },
        ];
        const neuralUnsupported = sourceEngine.playerCount !== 2 || sourceEngine.boardShape !== "triangle" || sourceEngine.gridSize < 5 || sourceEngine.gridSize > 15
          ? "研究神经模型仅支持双人 5–15 边长三角形棋盘。"
          : "";
        if (!sourceEngine.isTopologyBoard) configurations.push(...[
          ...RESEARCH_FAMILIES.flatMap((family) => ["legacy", ...TRANSFER_SEEDS.map(String)].map((version) => {
            const profile = researchProfile(family, version);
            return { ...profile, id: profile.modelId, unavailableMessage: neuralUnsupported };
          })),
          { id: "dqn-all-sizes-e2000", strategy: "model-free", label: "DQN", modelId: "dqn-all-sizes-e2000", unavailableMessage: neuralUnsupported },
          { id: "ppo-all-sizes-e2000", strategy: "model-free", label: "PPO", modelId: "ppo-all-sizes-e2000", unavailableMessage: neuralUnsupported },
          { id: "sac-all-sizes-e2000", strategy: "model-free", label: "SAC", modelId: "sac-all-sizes-e2000", unavailableMessage: neuralUnsupported },
          { id: "gail-all-sizes", strategy: "model-free", label: "GAIL", modelId: "gail-all-sizes", unavailableMessage: neuralUnsupported },
          { id: "gan-all-sizes", strategy: "model-free", label: "GAN", modelId: "gan-all-sizes", unavailableMessage: neuralUnsupported },
        ]);
        for (const configuration of configurations) {
          if (!replayMode.value || controller.value?.engine !== sourceEngine) {
            return;
          }
          if (configuration.unavailableMessage) {
            runs.push({ ...configuration, elapsedMs: 0, moves: [] });
            aiComparison.value = {
              player: aiPlayer,
              positionRevision: sourceEngine.positionRevision,
              runs: [...runs],
            };
            continue;
          }
          const startedAt = globalThis.performance?.now?.() ?? Date.now();
          const result = await runAiComparisonDepth(
            sourceEngine,
            serializedState,
            aiPlayer,
            configuration.strategy,
            configuration.depth,
            configuration,
          );
          if (result.cancelled) {
            return;
          }
          if (!result.ok) {
            runs.push({
              ...configuration,
              elapsedMs: Math.max(0, Math.round((globalThis.performance?.now?.() ?? Date.now()) - startedAt)),
              moves: [],
              unavailableMessage: result.error?.message ?? String(result.error ?? "AI 候选比较失败。"),
            });
            aiComparison.value = {
              player: aiPlayer,
              positionRevision: sourceEngine.positionRevision,
              runs: [...runs],
            };
            continue;
          }
          const finishedAt = globalThis.performance?.now?.() ?? Date.now();
          runs.push({
            id: configuration.id,
            strategy: configuration.strategy,
            label: configuration.label ?? null,
            modelId: configuration.modelId ?? null,
            depth: configuration.depth,
            simulations: configuration.simulations ?? null,
            rolloutDepth: configuration.rolloutDepth ?? null,
            elapsedMs: Math.max(0, Math.round(finishedAt - startedAt)),
            moves: (result.message.moves ?? []).map((move) => ({
              point: typeof move.vertexId === "string" ? move.vertexId : typeof move.point === "string" ? move.point : Array.isArray(move.point) ? [...move.point] : null,
              type: move.type ?? "move",
              score: Number.isFinite(move.score) ? move.score : null,
              visits: Number.isInteger(move.visits) ? move.visits : null,
              meanValue: Number.isFinite(move.meanValue) ? move.meanValue : null,
              prior: Number.isFinite(move.prior) ? move.prior : null,
            })).filter((move) => typeof move.point === "string" || Array.isArray(move.point) || move.type === "pass"),
            searchInfo: result.message.searchInfo ?? null,
          });
          aiComparison.value = {
            player: aiPlayer,
            positionRevision: sourceEngine.positionRevision,
            runs: [...runs],
          };
        }
      } catch (error) {
        aiComparisonError.value = error?.message ?? String(error);
      } finally {
        aiComparisonBusy.value = false;
      }
    };

    const formatActionFeedback = (feedback) => {
      const zh = language.value === "zh";
      if (feedback?.success) {
        if (feedback.type === "skip") {
          return zh ? "已跳过本回合。" : "Turn skipped.";
        }
        if (feedback.type === "resign") {
          return zh ? "已认输，本局结束。" : "You resigned. The match is over.";
        }
        return "";
      }

      const messages = zh
        ? {
            MISS: "请点击棋盘上的节点。",
            INVALID_MOVE: "这里不能落子，请换一个合法节点。",
            SUPERKO_VIOLATION: "这个动作会重复历史局面，不能落子。",
            GAME_OVER: "本局已经结束，请重新开始。",
            NOT_YOUR_TURN: "现在还没轮到你。",
            NETWORK_UNAVAILABLE: "当前连接不可用，请稍后重试。",
            READ_ONLY_REPLAY: "当前正在复盘，棋盘为只读状态。",
          }
        : {
            MISS: "Click a node on the board.",
            INVALID_MOVE: "That point is not a legal move.",
            SUPERKO_VIOLATION: "That move repeats a previous position.",
            GAME_OVER: "This match is over. Start a new one to continue.",
            NOT_YOUR_TURN: "It is not your turn yet.",
            NETWORK_UNAVAILABLE: "The connection is unavailable. Try again.",
            READ_ONLY_REPLAY: "Replay mode is read-only. Exit review to play.",
          };
      return messages[feedback?.reason] ?? (zh ? "动作没有被接受。" : "The action was not accepted.");
    };

    const handleActionFeedback = (feedback) => {
      if (!feedback) {
        return;
      }

      if (tutorialActive.value && ["move", "skip"].includes(feedback.type)) {
        tutorialAttempts.value += 1;
        const level = currentTutorialLevel.value;
        if (isTutorialRestrictionAttempt(level, feedback)) {
          tutorialRestrictionObserved.value = true;
          setActionFeedback("", "neutral");
          return;
        }
        if (feedback.success && isTutorialTarget(level, feedback) && (!level.restriction || tutorialRestrictionObserved.value)) {
          tutorialResultSnapshot.value = controller.value.engine.getSnapshot();
          tutorialSuccess.value = true;
          controller.value.setReadOnlyMode(true);
          setActionFeedback(formatActionFeedback(feedback), "success");
          return;
        }

        if (feedback.success) {
          loadTutorialLevel(tutorialLevelIndex.value);
          setActionFeedback(
            level.restriction
              ? (language.value === "zh"
                ? `先点标出的空点 [${level.restriction.point.join(",")}] 体验三点限制，再切红线 [${level.objective.point.join(",")}]。`
                : `Try the marked empty point [${level.restriction.point.join(",")}] for the three-point limit, then cut Red’s line at [${level.objective.point.join(",")}].`)
              : language.value === "zh"
              ? "动作有效，但没有完成本关目标。请按高亮提示再试一次。"
              : "That action was legal, but it did not complete this lesson. Follow the highlighted prompt and try again.",
            "error",
          );
          return;
        }

        setActionFeedback(
          level.objective?.type === "skip"
            ? (language.value === "zh" ? "本关练习结算，请使用“跳过回合”。" : "This lesson practices settlement. Use “Skip Turn”.")
            : (language.value === "zh" ? "这一步没有完成本关目标，请按高亮提示再试一次。" : "That move did not complete the lesson. Follow the highlighted prompt and try again."),
          "error",
        );
        return;
      }

      setActionFeedback(formatActionFeedback(feedback), feedback.success ? "success" : "error");
    };

    const leaveTutorial = async (completed) => {
      if (!tutorialActive.value || !controller.value || localGameRestoring.value) return false;
      let restore = tutorialReturnSession;
      let restoredSettings = null;
      let restoredMatch = null;
      let restoredActions = [];
      let savedMatchUnavailable = false;
      localGameRestoring.value = true;
      try {
        controller.value.setReadOnlyMode(false);
        let restored;
        if (tutorialReturnTopologySession) {
          // A topology session is a full rules state, not a coordinate replay
          // prefix.  Do not send it through restoreMatchState: that legacy
          // route can discard Superko/history and may recreate a triangle
          // using a current player as an opening player.
          let decoded;
          try {
            decoded = decodeTopologyState(tutorialReturnTopologySession.topologyState);
            restoredSettings = topologySettingsFromState(decoded, tutorialReturnTopologySession);
          } catch (error) {
            savedMatchUnavailable = true;
            setActionFeedback(
              language.value === "zh"
                ? "原拓扑对局无法读取，存档已保留，请刷新后重试。"
                : "The previous topology match could not be read. Its save is intact; reload to retry.",
              "error",
            );
            return false;
          }
          restored = controller.value.restoreTopologyState(tutorialReturnTopologySession.topologyState, {
            startPlayer: tutorialReturnTopologySession.startPlayer,
            actions: tutorialReturnTopologySession.actions,
          });
          restoredMatch = tutorialReturnTopologySession.match;
          restoredActions = [...tutorialReturnTopologySession.actions];
          if (restored.success) {
            // Update setup controls without resetting the just-restored engine.
            applySettingsToController(restoredSettings, false, false);
            selectedTopologySource.value = inferSavedTopologyPreset(restoredSettings.boardDefinition)?.preset
              ?? (language.value === "zh" ? "已恢复的本地对局" : "restored local match");
            topologyDefinitionText.value = JSON.stringify(restoredSettings.boardDefinition, null, 2);
            topologyLocalSession = tutorialReturnTopologySession;
          }
        } else if (isTopologyGameSettings(normalGameSettings)) {
          if (!normalGameSettings.boardDefinition) {
            savedMatchUnavailable = true;
            setActionFeedback(
              language.value === "zh"
                ? "保存的拓扑棋盘草稿不完整，未替换当前教学棋局。"
                : "The saved topology-board draft is incomplete; the tutorial board was left unchanged.",
              "error",
            );
            return false;
          }
          // Preferences can retain a fully compiled topology draft before the
          // user has begun a match.  It must become a pending custom board,
          // rather than a fabricated legacy replay/session on tutorial exit.
          restoredSettings = normalGameSettings;
          restored = {
            success: true,
            state: controller.value.setGameConfig(restoredSettings, true),
          };
          selectedTopologySource.value = language.value === "zh" ? "已恢复的棋盘草稿" : "restored board draft";
          topologyDefinitionText.value = JSON.stringify(restoredSettings.boardDefinition, null, 2);
        } else {
          restored = controller.value.restoreMatchState(restore);
          if (!restored.success) {
            savedMatchUnavailable = true;
            restore = createLocalGameSession(normalGameSettings);
            restored = controller.value.restoreMatchState(restore);
          }
          restoredSettings = restore.settings;
          restoredMatch = restore.match;
          restoredActions = [...restore.actions];
        }
        if (!restored.success) {
          // A corrupted topology save must never be silently downgraded to a
          // fresh legacy board.  The candidate restore left the live tutorial
          // engine intact, and the persisted topology session remains intact.
          if (tutorialReturnTopologySession) {
            savedMatchUnavailable = true;
            setActionFeedback(
              language.value === "zh"
                ? "原拓扑对局无法恢复，存档已保留，请刷新后重试。"
                : "The previous topology match could not be restored. Its save is intact; reload to retry.",
              "error",
            );
            return false;
          }
          setActionFeedback(
            language.value === "zh"
              ? "原对局暂时无法恢复，存档已保留，请刷新后重试。"
              : "The previous match could not be restored. Your save is intact; reload to retry.",
            "error",
          );
          return false;
        }
        if (!tutorialReturnTopologySession) applySettingsToController(restoredSettings, false, false);
        activeLocalSettings.value = normalizeAppGameSettings(restoredSettings);
        activeLocalPlayers.value = normalizeLocalPlayers(restoredMatch?.players, restoredSettings.playerCount, restoredSettings.boardShape);
        selectedLocalPlayers.value = normalizeLocalPlayers(restoredMatch?.players ?? selectedLocalPlayers.value, restoredSettings.playerCount, restoredSettings.boardShape);
        localMatchStarted.value = restoredMatch?.started ?? Boolean(restoredActions.length);
        aiDuelPaused.value = restoredMatch?.paused ?? false;
        undoUsage.value = normalizeUndoUsage(restoredMatch?.undo);
        invalidateContributionTicket();
        gameState.value = restored.state;
        localGameActions.value = restoredActions;
        localGamePositionRevision.value = restored.state.positionRevision;
        // Flush lesson-setting watchers before allowing normal match changes again.
        await nextTick();
        tutorialActive.value = false;
        tutorialSuccess.value = false;
        tutorialLevelIndex.value = 0;
      } finally {
        localGameRestoring.value = false;
      }
      syncSession();
      resetHintUsage();
      hintRemainingCount.value = Math.min(hintRemainingCount.value, tutorialReturnHintCount);
      setActionFeedback(
        savedMatchUnavailable
          ? (language.value === "zh" ? "原对局无法恢复，存档已保留；已打开新棋局。" : "The previous match could not be restored. Its save was kept and a fresh board is ready.")
          : restoredActions.length > 0
            ? (language.value === "zh" ? "已回到原来的对局，可以继续下棋。" : "Your previous match is restored. Continue playing.")
            : completed
              ? (language.value === "zh" ? "教学完成，开始你的第一局。" : "Tutorial complete. Start your first match.")
              : (language.value === "zh" ? "教学已跳过，随时可点左下角“新手引导”重新学习。" : "Tutorial skipped. Reopen it anytime from the bottom-left Tutorial button."),
        savedMatchUnavailable ? "error" : completed ? "success" : "neutral",
      );
      if (pendingRoomReconnect) {
        pendingRoomReconnect = false;
        roomStatus.value = "offline";
        void attemptReconnect();
      } else {
        restartLocalAiWorker();
      }
      return true;
    };

    const finishTutorial = () => leaveTutorial(true);
    const skipTutorial = () => startupRestorePromise ?? leaveTutorial(false);

    const effectiveGameSettings = computed(() => (
      roomStatus.value === "solo"
        ? normalizeAppGameSettings(currentGameSettings())
        : normalizeAppGameSettings(roomInfo.value.settings)
    ));
    const turnTimerEnabled = computed(() => effectiveGameSettings.value.turnTimerEnabled);
    const turnTimeLimitSeconds = computed(() => effectiveGameSettings.value.turnTimeLimitSeconds);
    const hintEnabled = computed(() => Boolean(
      effectiveGameSettings.value.hintEnabled
      && (isTopologyGameSettings(effectiveGameSettings.value)
        || (effectiveGameSettings.value.playerCount <= 3
          && effectiveGameSettings.value.boardShape === "triangle")),
    ));
    const hintMaxCount = computed(() => effectiveGameSettings.value.hintMaxCount);
    const undoEnabled = computed(() => !tutorialActive.value && effectiveGameSettings.value.undoEnabled);
    const undoRemainingCount = computed(() => Math.max(0, effectiveGameSettings.value.undoMaxCount - (roomStatus.value === "solo" ? undoUsage.value.usedCount : roomInfo.value.undo?.usedCount ?? 0)));
    const onlineUndoPending = computed(() => Boolean(roomInfo.value.undo?.pending));
    const onlineUndoVoted = computed(() => (roomInfo.value.undo?.votes ?? []).includes(session.value.playerId));
    const getUndoTimeline = createLocalUndoTimeline();
    const undoTimeline = computed(() => undoEnabled.value ? getUndoTimeline(activeLocalSettings.value, localGameActions.value) : []);
    const undoPlan = computed(() => planLocalUndo({
      settings: activeLocalSettings.value, actions: localGameActions.value,
      players: activeLocalPlayers.value, currentPlayer: gameState.value.currentPlayer, usage: undoUsage.value,
      timeline: undoTimeline.value,
    }));
    const undoDisabled = computed(() => roomStatus.value !== "solo"
      ? !undoEnabled.value || undoRemainingCount.value <= 0 || !session.value.roomId || !networkManager.isConnected()
        || roomStatus.value !== "inProgress" || roomSnapshotRecoveryFailed || networkBusy.value
        || onlineUndoVoted.value || (!onlineUndoPending.value && gameState.value.positionRevision <= 0)
      : !controller.value || !undoEnabled.value || undoRemainingCount.value <= 0
        || !undoPlan.value || gameState.value.gameOver || networkBusy.value
        || replayMode.value || replayRestoring.value || replayBusy.value || localGameRestoring.value || localSetupPending.value);

    const requestUndo = () => {
      if (undoDisabled.value) return false;
      if (roomStatus.value !== "solo") {
        return networkManager.sendUndo(true).then(() => true).catch((error) => { handleNetworkError(error); return false; });
      }
      const plan = undoPlan.value;
      const actions = localGameActions.value.slice(0, plan.actionIndex);
      terminateAiWorker();
      cancelHintRequest();
      clearActiveHint();
      clearHintFeedback();
      clearTurnTimer();
      localGameRestoring.value = true;
      let success = false;
      try {
        // Older topology-session actions omit the per-action hash. Rebind them
        // to the already validated live board before isolated replay.
        let replayActions;
        try {
          replayActions = controller.value.engine?.isTopologyBoard
            ? topologyActionsForController(actions, controller.value.engine.boardHash) : actions;
        } catch (_) {
          setActionFeedback(getAppTexts(language.value, uiStyle.value).undoFailed, "error");
          return false;
        }
        // Restore validates on an isolated engine before replacing the live board.
        const restored = controller.value.restoreMatchState({ settings: currentGameSettings(), actions: replayActions });
        if (!restored.success) {
          setActionFeedback(getAppTexts(language.value, uiStyle.value).undoFailed, "error");
          return false;
        }
        undoUsage.value = consumeLocalUndo(undoUsage.value, plan);
        localGameActions.value = actions;
        gameState.value = restored.state;
        localGamePositionRevision.value = restored.state.positionRevision;
        overlayResult.value = null;
        resultModalDismissed.value = false;
        setActionFeedback(getAppTexts(language.value, uiStyle.value).undoSuccess, "success");
        success = true;
      } finally {
        localGameRestoring.value = false;
        restartTurnTimer();
        scheduleAiMove(gameState.value);
      }
      if (success) saveLocalMatch();
      return success;
    };
    const rejectUndo = async () => {
      if (roomStatus.value === "solo" || !onlineUndoPending.value || !networkManager.isConnected()) return;
      try { await networkManager.sendUndo(false); }
      catch (error) { handleNetworkError(error); }
    };

    const applySettingsToController = (settings, reset = true, commitToController = true, syncNetworkSession = true) => {
      cancelHintRequest();
      const normalized = normalizeAppGameSettings(settings);
      syncingRemoteSettings = true;
      try {
        selectedPlayerCount.value = normalized.playerCount;
        selectedBoardShape.value = normalized.boardShape;
        selectedGridSize.value = normalized.gridSize;
        selectedStartPlayer.value = normalized.startPlayer;
        selectedTurnOrder.value = resizeTurnOrder(normalized.turnOrder, normalized.playerCount, normalized.startPlayer);
        // A surface board owns canonical string IDs after its quotient has
        // been compiled.  The legacy starting-point helper only understands
        // triangle/hex coordinate pairs and would either throw on `cv:*` or,
        // worse, replace a negotiated map with a legacy opening.
        if (isTopologyGameSettings(normalized)) {
          selectedTopologyDefinition.value = normalized.boardDefinition ?? selectedTopologyDefinition.value;
          selectedTopologyGridSize.value = normalized.gridSize;
          selectedTopologyHash.value = normalized.boardHash ?? selectedTopologyHash.value;
          selectedStartingPoints.value = normalized.initialPositions
            ? { startingPointMode: "topology", initialPositions: { ...normalized.initialPositions } }
            : { startingPointMode: "topology" };
        } else {
          selectedStartingPoints.value = startingPointSettings(normalized);
        }
        startingPointPreviewFresh = false;
        selectedRulesVersion.value = normalized.rulesVersion;
        selectedTurnTimerEnabled.value = normalized.turnTimerEnabled;
        selectedTurnTimeLimitSeconds.value = normalized.turnTimeLimitSeconds;
        selectedUndoEnabled.value = normalized.undoEnabled;
        selectedUndoMaxCount.value = normalized.undoMaxCount;
        if (settings && Object.prototype.hasOwnProperty.call(settings, "hintEnabled")) {
          selectedHintEnabled.value = normalized.hintEnabled;
        }
        if (settings && Object.prototype.hasOwnProperty.call(settings, "hintMaxCount")) {
          selectedHintMaxCount.value = normalized.hintMaxCount;
        }
        if (syncNetworkSession) syncSession();

        if (!controller.value || !commitToController) {
          return normalized;
        }

        controller.value.setGameConfig(normalized, reset);
        return normalized;
      } finally {
        // Vue batches the settings watcher; keep remote/restore changes guarded
        // until that batch has observed the complete authoritative snapshot.
        nextTick(() => { syncingRemoteSettings = false; });
      }
    };

    const loadTutorialLevel = (index) => {
      terminateAiWorker();
      cancelAiComparison();
      clearTurnTimer();
      clearLocalGameNotice();
      const level = getTutorialLevel(index);
      const settings = getTutorialEngineSettings(level);
      const actions = level.prefix.map((action) => (
        action.type === "move"
          ? { type: "player_move", point: [...action.point] }
          : { type: "player_skip" }
      ));

      tutorialLevelIndex.value = index;
      tutorialSuccess.value = false;
      tutorialAttempts.value = 0;
      tutorialStartSnapshot.value = null;
      tutorialResultSnapshot.value = null;
      tutorialRestrictionObserved.value = false;
      setActionFeedback("", "neutral");
      localGameActions.value = [];
      localGamePositionRevision.value = -1;
      applySettingsToController(settings, false, false);

      if (!controller.value) {
        return false;
      }

      controller.value.setReadOnlyMode(false);
      localGameRestoring.value = true;
      const restored = controller.value.restoreMatchState({ settings, actions });
      localGameRestoring.value = false;
      if (!restored.success) {
        setActionFeedback(
          language.value === "zh"
            ? "教学场景与当前规则版本不兼容，请直接开始普通对局。"
            : "This tutorial scene is incompatible with the current rules. Start a normal match instead.",
          "error",
        );
        return false;
      }

      gameState.value = restored.state;
      tutorialStartSnapshot.value = controller.value.engine.getSnapshot();
      localGamePositionRevision.value = restored.state.positionRevision;
      return true;
    };

    const startTutorial = () => {
      if (!controller.value || localGameRestoring.value) return;
      if (roomStatus.value !== "solo" || networkBusy.value || gameState.value.multiplayerEnabled) {
        // Keep a live online match connected while teaching in a separate tab.
        const tutorialUrl = new URL(globalThis.location.href);
        tutorialUrl.searchParams.set("tutorial", "1");
        globalThis.open(tutorialUrl.href, "_blank", "noopener");
        return;
      }
      if (!tutorialActive.value) {
        tutorialReturnHintCount = hintRemainingCount.value;
        if (controller.value.engine?.isTopologyBoard) {
          try {
            tutorialReturnTopologySession = createTopologyLocalGameSession(
              controller.value.engine.encodeTopologyState(),
              topologyActionsForController(localGameActions.value, controller.value.engine.boardHash),
              topologySessionMetadata(),
            );
            tutorialReturnSession = null;
          } catch (error) {
            setActionFeedback(
              language.value === "zh"
                ? `无法安全保存当前拓扑对局：${error?.message ?? String(error)}`
                : `Could not safely save the current topology match: ${error?.message ?? String(error)}`,
              "error",
            );
            return;
          }
        } else {
          tutorialReturnTopologySession = null;
          tutorialReturnSession = replayMode.value && liveReplayRestore
            ? createLocalGameSession(liveReplayRestore.settings, liveReplayRestore.actions, currentLocalMatch())
            : createLocalGameSession(currentGameSettings(), localGameActions.value, currentLocalMatch());
        }
      }
      stopReplayPlayback();
      tutorialActive.value = true;
      replayMode.value = false;
      liveReplayRestore = null;
      replayInspectionPoint.value = null;
      aiComparison.value = null;
      aiComparisonBusy.value = false;
      activeUtilityDeck.value = "";
      activeGuideKey.value = "";
      overlayResult.value = null;
      loadTutorialLevel(0);
      resetHintUsage();
    };

    const advanceTutorial = () => {
      if (tutorialLevelIndex.value >= TUTORIAL_LEVELS.length - 1) {
        return finishTutorial();
      }
      loadTutorialLevel(tutorialLevelIndex.value + 1);
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

    const clearCountdownSnapshotRefresh = () => {
      if (countdownSnapshotRefreshTimerId !== null) {
        globalThis.clearTimeout(countdownSnapshotRefreshTimerId);
        countdownSnapshotRefreshTimerId = null;
      }
    };

    const scheduleCountdownSnapshotRefresh = () => {
      if (countdownSnapshotRefreshTimerId !== null) {
        return;
      }

      countdownSnapshotRefreshTimerId = globalThis.setTimeout(() => {
        countdownSnapshotRefreshTimerId = null;
        if (roomStatus.value === "countdown") {
          void refreshRoomSnapshot();
        }
      }, 1200);
    };

    const restartTurnCountdown = () => {
      clearTurnCountdown();
      clearCountdownSnapshotRefresh();
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
          if (turnCountdown.value === 0) {
            scheduleCountdownSnapshotRefresh();
          }
        }, 250);
        return;
      }

      turnCountdownTimerId = globalThis.setInterval(() => {
        if (turnCountdown.value > 0) {
          turnCountdown.value -= 1;
        }
      }, 1000);
    };

    const clearTurnTimer = (nextPhase = "paused") => {
      if (turnTimerId !== null) {
        globalThis.clearInterval(turnTimerId);
        turnTimerId = null;
      }
      turnTimerDeadline = 0;
      turnTimerRemaining.value = 0;
      turnTimerPhase.value = nextPhase;
    };

    const clearChatEmojiBursts = () => {
      for (const timeoutId of chatEmojiTimeoutIds) {
        globalThis.clearTimeout(timeoutId);
      }
      chatEmojiTimeoutIds.clear();
      chatEmojiBursts.value = [];
    };

    const isLocalAiTurn = () => (
      roomStatus.value === "solo"
      && selectedAiMode.value !== "none"
      && gameState.value.currentPlayer === getAiPlayer()
    );

    const shouldRunTurnTimer = () => {
      if (tutorialActive.value || replayMode.value || replayRestoring.value || !turnTimerEnabled.value || !controller.value) {
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
        return !localSetupPending.value && !isLocalAiTurn() && !aiThinking.value;
      }

      return roomStatus.value === "inProgress";
    };

    const shouldAutoSkipTimedTurn = () => {
      if (!shouldRunTurnTimer()) {
        return false;
      }

      if (roomStatus.value === "solo") {
        return true;
      }

      return gameState.value.isLocalTurn;
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
      clearTurnTimer("finished");
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
      turnTimerPhase.value = "running";
      updateTurnTimerRemaining();
      turnTimerId = globalThis.setInterval(() => {
        updateTurnTimerRemaining();
        if (turnTimerRemaining.value <= 0) {
          if (shouldAutoSkipTimedTurn()) {
            triggerTimedSkip();
          } else {
            clearTurnTimer("finished");
          }
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
        aiThinking.value,
        tutorialActive.value,
        replayMode.value,
        replayRestoring.value,
      ],
      () => {
        restartTurnTimer();
      },
      { immediate: true },
    );

    const handleNetworkError = (error) => {
      const code = error?.message ?? String(error);
      const sharedErrors = {
        ONLINE_NOT_CONFIGURED: ["服务器尚未启用微信互通。", "Shared play is not enabled on this server."],
        WEB_AUTH_NOT_CONFIGURED: ["服务器尚未启用网页账号互通。", "Web account integration is not configured."],
        WEB_PASSWORD_REQUIRED: ["请先验证网页账号密码。", "Verify your Web account password first."],
        EMOTE_RATE_LIMIT: ["发送表情太快，请稍后再试。", "Emotes are being sent too quickly. Try again shortly."],
        EMOTES_UNAVAILABLE: ["当前连接暂不能发送表情。", "Emotes are unavailable on this connection."],
        LEAVE_ROOM_FIRST: ["请先退出当前房间。", "Leave the current room first."],
      };
      networkError.value = sharedErrors[code]?.[language.value === "zh" ? 0 : 1]
        ?? localizeAppErrorMessage(code, language.value, uiStyle.value);
    };

    const applyRoomPayload = (payload) => {
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
          settings: normalizeReceivedGameSettings(payload?.settings ?? roomInfo.value.settings),
          countdownEndsAt: payload?.countdownEndsAt ?? null,
          matchPhase: normalizeMatchPhase(
            readPayloadMatchPhase(payload, roomInfo.value.matchPhase),
            nextStatusReset,
          ),
          undo: payload?.undo ?? roomInfo.value.undo,
          matchState: payload?.matchState ?? roomInfo.value.matchState,
        };
        resultModalDismissed.value = false;
        return true;
      }

      const incomingTs = payload?.serverTimestamp ?? 0;
      const nextStatus = normalizeRoomStatus(payload?.status ?? roomStatus.value);
      const nextPhase = normalizeMatchPhase(readPayloadMatchPhase(payload, roomInfo.value.matchPhase), nextStatus);
      const isRoomReadyTransition = payload?.type === ServerEvent.ROOM_READY
        && (nextStatus === "inProgress" || nextPhase === "PLAYING");
      const timestampRollbackMs = incomingTs > 0
        ? lastServerTimestamp - incomingTs
        : 0;
      const shouldAcceptRoomReadyRollback = isRoomReadyTransition && timestampRollbackMs > 0;

      if (timestampRollbackMs > 0 && !shouldAcceptRoomReadyRollback) {
        return false;
      }
      if (incomingTs > 0) {
        lastServerTimestamp = Math.max(lastServerTimestamp, incomingTs);
      }

      readyPending.value = false;

      roomStatus.value = nextStatus || roomStatus.value;
      roomInfo.value = {
        ...createEmptyRoomInfo(),
        status: nextStatus || roomInfo.value.status,
        hostPlayerId: payload?.hostPlayerId ?? roomInfo.value.hostPlayerId,
        players: Array.isArray(payload?.players) ? payload.players : roomInfo.value.players,
        settings: normalizeReceivedGameSettings(payload?.settings ?? roomInfo.value.settings),
        countdownEndsAt: payload?.countdownEndsAt ?? null,
        matchPhase: nextPhase,
        undo: payload?.undo ?? roomInfo.value.undo,
        matchState: payload?.matchState ?? roomInfo.value.matchState,
      };
      resultModalDismissed.value = false;
      return true;
    };

    const resetRoomContext = () => {
      cancelHintRequest();
      roomStatus.value = "solo";
      roomInfo.value = createEmptyRoomInfo();
      roomIdInput.value = "";
      overlayResult.value = null;
      resultModalDismissed.value = false;
      readyPending.value = false;
      lastServerTimestamp = 0;
      roomSnapshotRecoveryFailed = false;
      clearCountdownSnapshotRefresh();
      clearChatEmojiBursts();
    };

    const syncControllerState = (partial) => {
      if (!controller.value) {
        return;
      }
      gameState.value = controller.value.setMultiplayerState(partial);
    };

    const syncOnlineController = (payload = null, syncState = true) => {
      if (!controller.value) {
        return;
      }

      const normalizedSettings = normalizeReceivedGameSettings(payload?.settings ?? roomInfo.value.settings);
      const players = Array.isArray(payload?.players) ? payload.players : roomInfo.value.players;
      const normalizedStatus = normalizeRoomStatus(payload?.status ?? roomStatus.value);
      const normalizedPhase = normalizeMatchPhase(readPayloadMatchPhase(payload, roomInfo.value.matchPhase), normalizedStatus);
      const everyoneConnected = Array.isArray(players)
        && players.length >= normalizedSettings.playerCount
        && players.every((player) => player.connected);

      const nextState = controller.value.enableMultiplayer({
        networkManager,
        localPlayer: payload?.yourColor ?? session.value.color,
        roomReady: normalizedStatus === "inProgress" || normalizedPhase === "PLAYING",
        opponentConnected: everyoneConnected,
      }, syncState);
      if (nextState) {
        gameState.value = nextState;
      }
    };

    const applyRoomSnapshot = (payload, resetController = true) => {
      // Validate raw authority before committing it to roomInfo.  Normalizing
      // first would turn a malformed surface board into a legacy triangle and
      // make that downgrade look authoritative to reconnecting clients.
      const rawIncomingSettings = payload?.settings
        ?? payload?.matchState?.settings
        ?? currentGameSettings();
      const topologyPreflight = validateTopologyRoomSnapshot(
        payload,
        rawIncomingSettings,
        networkManager.topologyCapabilities,
      );
      if (!topologyPreflight.ok) {
        controller.value?.setAuthoritativeSnapshotValid?.(false);
        controller.value?.setMultiplayerState?.({
          roomReady: false,
          opponentConnected: false,
        }, false);
        roomSnapshotRecoveryFailed = true;
        networkError.value = topologyPreflight.code;
        return false;
      }
      if (!applyRoomPayload(payload)) {
        return false;
      }
      cancelHintRequest();
      roomIdInput.value = payload?.roomId ?? roomIdInput.value;
      syncSession();
      const incomingSettings = normalizeReceivedGameSettings(
        payload?.settings ?? payload?.matchState?.settings ?? currentGameSettings(),
      );
      const controllerResult = coordinateControllerRoomSnapshot({
        controller: controller.value,
        payload,
        incomingSettings,
        resetController,
        syncOnlineController,
        applySettingsToController,
        topologyCapabilities: networkManager.topologyCapabilities,
      });
      if (controllerResult.state) {
        gameState.value = controllerResult.state;
      }
      if (!controllerResult.success) {
        roomSnapshotRecoveryFailed = true;
        return false;
      }
      if (controllerResult.authoritativeSnapshotAccepted) {
        if (roomSnapshotRecoveryFailed) {
          networkError.value = "";
        }
        roomSnapshotRecoveryFailed = false;
      }
      syncSession();

      reconnectAttempt = 0;
      return true;
    };

    const refreshRoomSnapshot = async () => {
      if (!session.value.roomId || !session.value.playerId || !networkManager.isConnected()) {
        return;
      }

      try {
        // ROOM_JOINED is applied by the event listener below; this await is acknowledgement only.
        await networkManager.joinRoom(session.value.roomId, session.value.playerId);
      } catch (error) {
        handleNetworkError(error);
      }
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

        await networkManager.joinRoom(session.value.roomId, session.value.playerId);
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
      cancelSharedPassword();
      accountLinkGeneration += 1; accountLinkCode.value = ""; clearTimeout(accountLinkExpiry);
      authBusy.value = true;
      // Clear the local identity immediately, including its persisted copy.
      // A failed or delayed room leave must not keep an account logged in.
      clearAuthState();
      persistAppAuth(auth.value);
      networkManager.clearAuthToken();

      try {
        clearReconnectTimer();
        resetRoomContext();
        connectionState.value = "idle";
        try { await networkManager.leaveRoom(); } catch (_error) { /* Local logout still completes. */ }
        networkManager.disconnect(1000, "logout");
        networkManager.clearAuthToken();
        networkManager.url = null;
        networkManager.roomId = null;
        networkManager.playerId = null;
        networkManager.color = null;
        if (controller.value) {
          terminateAiWorker();
          controller.value.disableMultiplayer();
          clearSavedLocalGame();
          gameState.value = controller.value.resetGame({ force: true });
          resetHintUsage();
          scheduleAiMove(gameState.value);
        }
        persistAppSession(createAppEmptySession());
        syncSession();
      } finally {
        authBusy.value = false;
      }
    };

    const clearHintFeedback = () => {
      hintFeedback.value = "";
      if (hintFeedbackTimeoutId !== null) {
        globalThis.clearTimeout(hintFeedbackTimeoutId);
        hintFeedbackTimeoutId = null;
      }
    };

    const showHintNoMoves = () => {
      clearHintFeedback();
      hintFeedback.value = getAppTexts(language.value, uiStyle.value).hintNoMoves;
      hintFeedbackTimeoutId = globalThis.setTimeout(() => {
        hintFeedback.value = "";
        hintFeedbackTimeoutId = null;
      }, 1800);
    };

    const clearActiveHint = () => {
      if (hintClearTimeoutId !== null) {
        globalThis.clearTimeout(hintClearTimeoutId);
        hintClearTimeoutId = null;
      }
      controller.value?.renderer?.clearHintPoint();
    };

    const resetHintUsage = () => {
      cancelHintRequest();
      clearActiveHint();
      clearHintFeedback();
      hintRemainingCount.value = selectedHintEnabled.value ? selectedHintMaxCount.value : 0;
      hintThinking.value = false;
    };

    const handleControllerReady = (instance) => {
      controller.value = instance;
      controller.value.renderer?.setTopologyChart?.(topologyChart.value);
      controller.value.setNetworkErrorListener(handleNetworkError);
      controller.value.setActionFeedbackListener(handleActionFeedback);
      gameState.value = instance.setGameConfig(currentGameSettings(), true);
      localGamePositionRevision.value = gameState.value.positionRevision ?? 0;

      if (tutorialAutoRestoring.value) {
        startupRestorePromise = leaveTutorial(false).then((restored) => {
          if (!restored) {
            const restoreError = actionFeedback.value;
            loadTutorialLevel(0);
            resetHintUsage();
            setActionFeedback(restoreError, "error");
          }
          return restored;
        }).finally(() => {
          tutorialAutoRestoring.value = false;
          startupRestorePromise = null;
        });
        return startupRestorePromise;
      }
      loadTutorialLevel(0);
      resetHintUsage();
    };

    const handleStateChange = (nextState) => {
      cancelHintRequest();
      clearActiveHint();
      gameState.value = nextState;
      persistCurrentLocalGame(nextState);
      if (localGameRestoring.value || replayRestoring.value || replayMode.value) {
        return;
      }
      scheduleAiMove(nextState);
    };

    const getCurrentHintEngine = () => {
      const currentEngine = controller.value?.engine ?? null;
      const aiPlayer = getAiPlayer();
      const currentIsAiTurn = aiPlayer !== null
        && gameState.value.currentPlayer === aiPlayer;
      if (
        !currentEngine
        || replayMode.value
        || roomStatus.value !== "solo"
        || !hintEnabled.value
        || hintRemainingCount.value <= 0
        || gameState.value.gameOver
        || gameState.value.multiplayerEnabled
        || controller.value?.multiplayerEnabled
        || localSetupPending.value
        || currentIsAiTurn
      ) {
        return null;
      }
      return currentEngine;
    };

    const requestHint = () => {
      if (!controller.value || hintDisabled.value) {
        return;
      }
      cancelHintRequest();
      hintThinking.value = true;
      clearActiveHint();
      const sourceEngine = controller.value.engine;
      const currentPlayer = sourceEngine.currentPlayer;

      try {
        hintWorkerSession.start({
          engine: sourceEngine,
          getCurrentEngine: getCurrentHintEngine,
          message: {
            type: "COMPUTE",
            serializedState: serializeEngineState(sourceEngine),
            aiPlayer: currentPlayer,
            ...(sourceEngine.isTopologyBoard ? { strategy: "topology-generic" } : {}),
            depth: 2,
            topN: 1,
          },
          onResult: (message) => {
            try {
              const application = applyHintWorkerResult({
                moves: message.moves,
                legalMoves: gameState.value.legalMoves,
                remainingCount: hintRemainingCount.value,
                renderHint: (point) => controller.value.renderer.setHintPoint(point),
              });
              if (!application.applied) {
                if (application.reason === "NO_MOVE" || application.reason === "ILLEGAL_MOVE") {
                  showHintNoMoves();
                }
                return;
              }

              hintRemainingCount.value = application.nextRemainingCount;
              hintClearTimeoutId = globalThis.setTimeout(() => {
                controller.value?.renderer?.clearHintPoint();
                hintClearTimeoutId = null;
              }, 4000);
            } catch (error) {
              console.warn("Unable to display a hint.", error);
            }
          },
          onError: (error) => {
            console.warn("Unable to calculate a hint.", error);
          },
          onFinish: () => {
            hintThinking.value = false;
          },
        });
      } catch (error) {
        console.warn("Unable to calculate a hint.", error);
        hintThinking.value = false;
      }
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
          authOrigin: payload.authOrigin,
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
      if (!session.value.roomId && /^[A-Z2-9]{8}$/i.test(roomIdInput.value.trim())) return handleJoinRoom();
      networkBusy.value = true;
      networkError.value = "";
      overlayResult.value = null;
      clearReconnectTimer();

      try {
        await ensureConnected();
        if (networkManager.serverAuthoritative && session.value.roomId && !networkManager.isConnected()) {
          await networkManager.joinRoom(session.value.roomId, session.value.playerId);
        }
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
        networkManager.url = serverUrl.value.trim();
        networkManager.setAuthToken(auth.value.token);
        const settings = normalizeAppGameSettings(draftGameSettings());
        const requested = settings.boardShape === "custom" ? { ...settings, botCount: 0 }
          : roomSettingsFromBoard(settings, selectedLocalPlayers.value);
        await networkManager.createSharedRoom(requested);
        roomSetupOpen.value = false;
        activeUtilityDeck.value = "network";
      } catch (error) {
        handleNetworkError(error);
      } finally {
        networkBusy.value = false;
      }
    };

    const openRoomSetup = () => {
      if (networkBusy.value || (session.value.roomId && !isHost.value)) return;
      const source = session.value.roomId ? roomInfo.value.pendingSettings ?? roomInfo.value.settings : draftGameSettings();
      const draft = source.boardShape === "custom" ? source : roomSettingsFromBoard(source, session.value.roomId ? source.playerSetup : selectedLocalPlayers.value);
      applySettingsToController(draft, false, false, false);
      if (draft.boardShape !== "custom") selectedLocalPlayers.value = normalizeRoomPlayerSetup(draft);
      roomSetupOpen.value = true;
      activeUtilityDeck.value = "board";
    };
    const handleLinkWechat = async () => {
      accountLinkBusy.value = true; accountLinkError.value = ""; accountLinkCode.value = "";
      const token = auth.value.token, server = serverUrl.value, generation = ++accountLinkGeneration;
      const current = () => generation === accountLinkGeneration && token === auth.value.token && server === serverUrl.value;
      try {
        if (session.value.roomId) throw new Error("LEAVE_ROOM_FIRST");
        networkManager.url = serverUrl.value.trim();
        const result = await networkManager.issueLinkCode();
        if (!current()) return;
        accountLinkCode.value = result.code;
        clearTimeout(accountLinkExpiry);
        accountLinkExpiry = setTimeout(() => { accountLinkCode.value = ""; }, result.expiresIn * 1000);
      } catch (error) { if (current()) accountLinkError.value = localizeAppErrorMessage(error.message, language.value, uiStyle.value); }
      finally { accountLinkBusy.value = false; }
    };
    const handleCopyLinkCode = async () => {
      try { await navigator.clipboard.writeText(accountLinkCode.value); }
      catch (_) { accountLinkError.value = language.value === "zh" ? "请选中绑定码并复制。" : "Select and copy the code."; }
    };
    const saveRoomSettings = async () => {
      if (!session.value.roomId) return handleCreateRoom();
      if (!isHost.value || !session.value.shared || networkBusy.value) return;
      networkBusy.value = true;
      try {
        const draft = draftGameSettings();
        await networkManager.updateRoomSettings(draft.boardShape === "custom" ? { ...draft, botCount: 0 } : roomSettingsFromBoard(draft, selectedLocalPlayers.value));
        roomSetupOpen.value = false;
        activeUtilityDeck.value = "network";
      } catch (error) { handleNetworkError(error); }
      finally { networkBusy.value = false; }
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
        if (/^[A-Z2-9]{8}$/i.test(normalizedRoomId)) {
          networkManager.url = serverUrl.value.trim();
          networkManager.setAuthToken(auth.value.token);
        } else {
          networkManager.selectLegacy();
          await ensureConnected();
        }
        await networkManager.joinRoom(normalizedRoomId);
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
          terminateAiWorker();
          controller.value.disableMultiplayer();
          clearSavedLocalGame();
          gameState.value = controller.value.resetGame({ force: true });
          resetHintUsage();
          scheduleAiMove(gameState.value);
        }
        persistAppSession(createAppEmptySession());
      } catch (error) {
        handleNetworkError(error);
      } finally {
        networkBusy.value = false;
      }
    };

    const handleSkip = async () => {
      if (!controller.value || replayMode.value) {
        return;
      }

      if (roomStatus.value !== "solo" && (roomSnapshotRecoveryFailed || gameState.value.skipLocked)) {
        return;
      }

      cancelHintRequest();

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

    const handleRootAction = async (action) => {
      if (!controller.value || replayMode.value || !action?.type || !Array.isArray(action.point)) return;
      cancelHintRequest();
      const type = action.type === "root_relocate" ? "relocate" : "add";
      if (roomStatus.value === "solo") {
        const result = controller.value.playRootAction(type, action.point);
        gameState.value = result.state;
        if (!result.success) setActionFeedback(localizeErrorMessage(result.reason, language.value), "error");
        return;
      }
      setActionFeedback(language.value === "zh" ? "联机起点操作正在提交…" : "Submitting online root action…", "neutral");
      const result = await controller.value.requestRootAction?.(type, action.point);
      if (result) gameState.value = result.state;
    };

    const handleReset = async () => {
      if (!controller.value || replayMode.value) {
        return;
      }

      if (roomStatus.value !== "solo" && (roomSnapshotRecoveryFailed || gameState.value.resetLocked)) {
        return;
      }

      cancelHintRequest();

      if (roomStatus.value === "solo") {
        await startLocalMatch();
        return;
      }

      networkBusy.value = true;
      networkError.value = "";
      try {
        if (!gameState.value.gameOver) {
          const result = await controller.value.requestResign();
          gameState.value = result.state;
          return;
        }
        const reason = "normal_restart";
        if (session.value.roomId && networkManager.isConnected()) {
          await networkManager.sendReset(reason);
          gameState.value = controller.value.getGameState();
        } else {
          gameState.value = await controller.value.requestResetMatch({ reason });
        }
      } catch (error) {
        handleNetworkError(error);
      } finally {
        networkBusy.value = false;
      }
    };

    const handleToggleReady = async (ready) => {
      if (!session.value.roomId || roomSnapshotRecoveryFailed) {
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
        if (session.value.shared && session.value.roomId) syncControllerState({});
      }
    };

    const chatEmojiDisabled = computed(() => session.value.shared && session.value.roomId
      ? connectionState.value !== "connected" || !session.value.connected || !networkManager.canEmote() : false);

    const resolveChatEmojiColor = (sender, payloadColor = null) => {
      if (APP_ALL_PLAYERS.includes(payloadColor)) {
        return payloadColor;
      }
      const player = Array.isArray(roomInfo.value.players)
        ? roomInfo.value.players.find((candidate) => candidate.playerId === sender)
        : null;
      return player?.color ?? session.value.color ?? gameState.value.currentPlayer ?? Player.BLACK;
    };

    const getChatEmojiAnchor = (color) => {
      const settings = effectiveGameSettings.value;
      const roots = settings.initialPositions ?? resolveInitialPositions(settings.gridSize, settings.playerCount, null, settings.boardShape);
      const point = roots[color];
      if (!point) return { x: 50, y: 50 };
      const r = settings.gridSize - 1;
      const hex = settings.boardShape === "hexagon";
      const nx = point[0] + point[1] / 2;
      return {
        x: 14 + 72 * (nx - (hex ? r / 2 : 0)) / (hex ? 2 * r : r),
        y: 14 + 72 * point[1] / (hex ? 2 * r : r),
      };
    };

    const getChatEmojiColorClass = (color) => getPlayerAccentClass(color).replace("player-accent-", "") || "blue";

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
      const seed = String(metadata.seed ?? `${payload?.sender ?? "local"}-${content}`).slice(0, 64);
      return {
        sender: String(payload?.sender ?? ""),
        color: resolveChatEmojiColor(payload?.sender, payload?.color),
        content,
        seed,
        display: normalizeChatEmojiDisplay(metadata.display),
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
      const display = normalized.display ?? (() => {
        const anchor = getChatEmojiAnchor(normalized.color);
        const random = createChatEmojiRandom(normalized.seed);
        const jitterX = Math.round((random() - 0.5) * 10);
        const jitterY = Math.round((random() - 0.5) * 10);
        const moveSign = anchor.x > 50 ? -1 : 1;
        return {
          colorClass: getChatEmojiColorClass(normalized.color),
          x: anchor.x + jitterX,
          y: anchor.y + jitterY,
          dx: moveSign * (18 + Math.round(random() * 18)),
          mx: moveSign * (8 + Math.round(random() * 8)),
          dy: -(36 + Math.round(random() * 24)),
        };
      })();
      const burst = {
        id,
        sender: normalized.sender,
        content: normalized.content,
        animation: normalized.metadata.animation,
        duration: normalized.metadata.duration,
        colorClass: display.colorClass,
        x: display.x,
        y: display.y,
        dx: display.dx,
        mx: display.mx,
        dy: display.dy,
      };
      chatEmojiBursts.value = [...chatEmojiBursts.value.slice(-5), burst];

      const timeoutId = globalThis.setTimeout(() => {
        chatEmojiTimeoutIds.delete(timeoutId);
        chatEmojiBursts.value = chatEmojiBursts.value.filter((candidate) => candidate.id !== id);
      }, burst.duration + 180);
      chatEmojiTimeoutIds.add(timeoutId);
      return burst;
    };

    const handleChatEmoji = async (emoji) => {
      if (chatEmojiDisabled.value) {
        return;
      }

      networkError.value = "";
      if (session.value.shared && session.value.roomId) {
        try { await networkManager.sendChatEmoji(emoji?.content); }
        catch (error) { handleNetworkError(error); }
        return;
      }
      const seed = `${session.value.playerId ?? "local"}-${Date.now()}-${Math.round(Math.random() * 1000000)}`;
      const burst = pushChatEmojiBurst({
        sender: session.value.playerId ?? "local",
        color: session.value.color ?? gameState.value.currentPlayer,
        content: emoji?.content,
        metadata: {
          animation: emoji?.animation,
          duration: emoji?.duration,
          seed,
        },
      });
      optimisticChatEmoji.content = String(emoji?.content ?? "").trim();
      optimisticChatEmoji.sentAt = Date.now();

      if (!session.value.roomId || !networkManager.isConnected()) {
        return;
      }

      try {
        await networkManager.sendChatEmoji(emoji?.content, {
          animation: emoji?.animation,
          duration: emoji?.duration,
          seed,
          display: burst ? {
            x: burst.x,
            y: burst.y,
            dx: burst.dx,
            mx: burst.mx,
            dy: burst.dy,
            colorClass: burst.colorClass,
          } : null,
        });
      } catch (error) {
        handleNetworkError(error);
      }
    };

    const handleStartPlayerChange = (value) => {
      if (settingsLocked.value) return;
      selectedTurnOrder.value = resizeTurnOrder(selectedTurnOrder.value, selectedPlayerCount.value, value);
      selectedStartPlayer.value = value;
    };
    const handleTurnOrderChange = (order) => {
      if (settingsLocked.value || (roomStatus.value !== "solo" && !(roomSetupOpen.value && session.value.shared && isHost.value))) return;
      if (!Array.isArray(order) || order.length !== selectedPlayerCount.value || new Set(order).size !== order.length
        || !order.every(player => APP_ALL_PLAYERS.slice(0, selectedPlayerCount.value).includes(player))) return;
      selectedTurnOrder.value = [...order];
      selectedStartPlayer.value = order[0];
    };

    const handleClosePrompt = () => {
      if (overlayResult.value?.resetAfterClose && controller.value) {
        if (roomStatus.value === "solo") {
          terminateAiWorker();
          clearSavedLocalGame();
        }
        gameState.value = controller.value.resetGame();
        resetHintUsage();
        if (roomStatus.value === "solo") {
          scheduleAiMove(gameState.value);
        }
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

      if (roomStatus.value === "solo" && !tutorialActive.value && !replayMode.value && localSetupPending.value) {
        return texts.localSetupPrompt;
      }

      if (gameState.value.gameOver) {
        return language.value === "en"
          ? texts.finalStatus(
            formatGameWinner(gameState.value.winner, gameState.value.players, roomInfo.value.players, language.value, uiStyle.value),
            formatGameScoreLine(getDisplayScores(gameState.value), gameState.value.players, roomInfo.value.players, language.value, uiStyle.value),
          )
          : texts.finalStatus(
            formatGameWinner(gameState.value.winner, gameState.value.players, roomInfo.value.players, language.value, uiStyle.value),
            formatGameScoreLine(getDisplayScores(gameState.value), gameState.value.players, roomInfo.value.players, language.value, uiStyle.value),
          );
      }

      if (roomInfo.value.matchPhase === "PLAYING" || roomStatus.value === "inProgress") {
        const turnStatus = gameState.value.isLocalTurn
          ? texts.localTurnStatus(formatGamePlayerName(
            session.value.color,
            gameState.value.players,
            roomInfo.value.players,
            language.value,
            uiStyle.value,
          ))
          : texts.remoteTurnStatus;
        return `${texts.playingStatus} ${turnStatus}`;
      }

      if ((gameState.value.players?.length ?? effectiveGameSettings.value.playerCount) >= 3) {
        const currentName = formatGamePlayerName(
          gameState.value.currentPlayer,
          gameState.value.players,
          [],
          language.value,
          uiStyle.value,
        );
        return language.value === "en"
          ? `Solo mode: ${currentName} to move.`
          : `本地模式中，现在轮到${currentName}。`;
      }

      return gameState.value.currentPlayer === Player.BLACK
        ? texts.soloBlueStatus
        : gameState.value.currentPlayer === Player.WHITE
          ? texts.soloRedStatus
          : (texts.soloPurpleStatus ?? "Purple to move.");
    });

    const boardHint = computed(() => {
      const texts = getAppTexts(language.value, uiStyle.value);
      if (localGameResumeNotice.value) {
        return localGameResumeNotice.value;
      }
      if (hintFeedback.value && !gameState.value.multiplayerEnabled) {
        return hintFeedback.value;
      }
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

      if (gameState.value.interactionLockReason === "READ_ONLY_REPLAY") {
        return language.value === "zh" ? "正在复盘：拖动时间轴查看步骤，退出复盘后才能继续下棋。" : "Review mode: use the timeline to inspect steps, then exit review to play.";
      }

      if (gameState.value.interactionLockReason === "OPPONENT_OFFLINE") {
        return texts.opponentOfflineHint;
      }

      if (gameState.value.multiplayerEnabled) {
        return texts.multiplayerHint;
      }

      if (!tutorialActive.value && localSetupPending.value) return texts.localSetupPrompt;
      return texts.soloHint;
    });

    const skipDisabled = computed(() => {
      if (!controller.value || networkBusy.value || aiThinking.value) {
        return true;
      }

      if (replayMode.value) {
        return true;
      }

      if (tutorialActive.value && currentTutorialLevel.value.objective?.type !== "skip") {
        return true;
      }

      if (roomStatus.value === "solo") {
        return (!tutorialActive.value && localSetupPending.value) || gameState.value.gameOver || isLocalAiTurn();
      }

      return gameState.value.skipLocked;
    });

    const hintDisabled = computed(() => {
      const currentAiPlayer = getAiPlayer();
      const currentIsAiTurn = selectedAiMode.value !== "none"
        && gameState.value.currentPlayer === currentAiPlayer;
      return !controller.value
        || replayMode.value
        || tutorialActive.value
        || !hintEnabled.value
        || gameState.value.gameOver
        || gameState.value.multiplayerEnabled
        || roomStatus.value !== "solo"
        || hintRemainingCount.value <= 0
        || hintThinking.value
        || localSetupPending.value
        || currentIsAiTurn;
    });

    const resetDisabled = computed(() => {
      if (!controller.value || networkBusy.value) {
        return true;
      }

      if (replayMode.value) {
        return true;
      }

      if (tutorialActive.value) {
        return true;
      }

      if (gameState.value.resetLocked) {
        return true;
      }

      if (roomStatus.value === "solo") {
        return false;
      }
      if (roomStatus.value === "inProgress" || roomInfo.value.matchPhase === "PLAYING") {
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
    const showClosePrompt = computed(() => Boolean(
      !tutorialActive.value
      && !replayMode.value
      && (overlayResult.value || (gameState.value.gameOver && !resultModalDismissed.value))
    ));

    const resetLabel = computed(() => {
      const texts = getAppTexts(language.value, uiStyle.value);
      if (roomStatus.value === "solo") {
        return localSetupPending.value ? texts.localStart : gameState.value.gameOver ? texts.startNewSolo : texts.resetBoard;
      }

      return gameState.value.gameOver ? texts.startNextOnline : texts.concedeAction;
    });

    const settingsLocked = computed(() => {
      if (networkBusy.value || tutorialActive.value || replayMode.value) {
        return true;
      }
      if (roomSetupOpen.value && session.value.shared && isHost.value) return false;
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

    const handleOpenUtilityDeck = async (deckKey) => {
      if (deckKey === "network" && tutorialActive.value && !await skipTutorial()) return;
      activeUtilityDeck.value = deckKey;
    };

    const finishTutorialToGuide = async () => {
      if (await finishTutorial()) handleOpenUtilityDeck("guide");
    };

    const handleCloseUtilityDeck = () => {
      cancelSharedPassword();
      accountLinkGeneration += 1; accountLinkCode.value = ""; accountLinkError.value = "";
      clearTimeout(accountLinkExpiry);
      activeUtilityDeck.value = "";
      activeGuideKey.value = "";
    };

    const handleOpenGuideEntry = (entryKey) => {
      activeGuideKey.value = entryKey === "topology" ? "rules-math-topology" : entryKey;
    };

    const handleCloseGuideEntry = () => {
      activeGuideKey.value = "";
    };

    const handleResultAction = async () => {
      if (overlayResult.value) {
        if (overlayResult.value.resetAfterClose && controller.value) {
          if (roomStatus.value === "solo") {
            terminateAiWorker();
            clearSavedLocalGame();
          }
          gameState.value = controller.value.resetGame();
          resetHintUsage();
          if (roomStatus.value === "solo") {
            scheduleAiMove(gameState.value);
          }
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
        if (session.value.shared && session.value.roomId) syncControllerState({});
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

    unsubscribers.push(...registerRoomSnapshotResponseListeners({
      networkManager,
      roomCreatedEvent: ServerEvent.ROOM_CREATED,
      roomJoinedEvent: ServerEvent.ROOM_JOINED,
      applyRoomSnapshot,
      onApplied: () => {
        networkError.value = "";
      },
    }));

    unsubscribers.push(
      networkManager.on(ServerEvent.ROOM_STATE, (payload) => {
        applyRoomSnapshotWithPostCommit({
          payload,
          applyRoomSnapshot,
          onApplied: () => {
            if (payload?.reason === "settings_updated") {
              networkError.value = getAppTexts(language.value, uiStyle.value).roomSettingsChanged;
            }
          },
        });
      }),
    );

    unsubscribers.push(
      networkManager.on(ServerEvent.ROOM_COUNTDOWN, (payload) => {
        applyRoomSnapshot(payload, false);
      }),
    );

    unsubscribers.push(
      networkManager.on(ServerEvent.ROOM_READY, (payload) => {
        applyRoomSnapshotWithPostCommit({
          payload,
          applyRoomSnapshot,
          onApplied: () => {
            networkError.value = "";
          },
        });
      }),
    );

    unsubscribers.push(
      networkManager.on(ServerEvent.PLAYER_LEFT, () => {
        roomStatus.value = "waiting";
        if (!roomSnapshotRecoveryFailed) {
          networkError.value = getAppTexts(language.value, uiStyle.value).opponentLeft;
        }
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
        if (!roomSnapshotRecoveryFailed) {
          networkError.value = formatAppResetVoteMessage(
            payload.confirmedVotes ?? 0,
            payload.requiredVotes ?? 0,
              language.value,
              uiStyle.value,
          );
        }
      }),
    );

    unsubscribers.push(
      networkManager.on(ServerEvent.MATCH_RESET, (payload) => {
        applyRoomSnapshotWithPostCommit({
          payload,
          applyRoomSnapshot,
          onApplied: () => {
            networkError.value = "";
            resultModalDismissed.value = false;
            if (payload.reason === "consensus_restart" && payload.winnerColor) {
              overlayResult.value = {
                winner: payload.winnerColor,
                scoreLine: formatGameScoreLine(getDisplayScores(gameState.value), gameState.value.players, roomInfo.value.players, language.value, uiStyle.value),
              };
            } else if (payload.reason === "resign_restart" && payload.winnerColor && (payload.loserColor || payload.resetColor || payload.color)) {
              overlayResult.value = {
                winner: payload.winnerColor,
                loser: payload.loserColor ?? payload.resetColor ?? payload.color,
              };
            }
          },
        });
      }),
    );
    unsubscribers.push(networkManager.on(ServerEvent.UNDO_STATUS, (payload) => {
      if (payload?.roomId === session.value.roomId) roomInfo.value = { ...roomInfo.value, undo: payload.undo ?? roomInfo.value.undo };
    }));
    unsubscribers.push(networkManager.on(ServerEvent.ROOM_UNDO, (payload) => {
      if (payload?.roomId !== session.value.roomId) return;
      if (applyRoomSnapshot(payload)) {
        networkError.value = "";
        setActionFeedback(getAppTexts(language.value, uiStyle.value).onlineUndoSuccess, "success");
      }
    }));

    unsubscribers.push(
      networkManager.on(ServerEvent.CHAT_EMOJI, (payload) => {
        if (
          payload?.sender === session.value.playerId
          && String(payload?.content ?? "").trim() === optimisticChatEmoji.content
          && Date.now() - optimisticChatEmoji.sentAt < 900
        ) {
          return;
        }
        pushChatEmojiBurst(payload);
      }),
    );

    for (const event of [ServerEvent.OPPONENT_MOVE, ServerEvent.TURN_SKIPPED]) {
      unsubscribers.push(networkManager.on(event, (payload) => {
        if (payload?.aiFallback) setActionFeedback(language.value === "zh"
          ? "AI 模型暂时不可用，本回合已使用基础策略继续。"
          : "The AI model is unavailable. This turn used the basic fallback policy.", "neutral");
      }));
    }

    unsubscribers.push(
      networkManager.on(ServerEvent.ERROR, (payload) => {
        readyPending.value = false;
        if (payload?.code === "MATCH_IN_PROGRESS") {
          roomStatus.value = "inProgress";
          roomInfo.value = {
            ...createEmptyRoomInfo(),
            ...roomInfo.value,
            status: "inProgress",
            matchPhase: "PLAYING",
            countdownEndsAt: null,
          };
          syncOnlineController({
            status: "IN_PROGRESS",
            matchPhase: "PLAYING",
            players: roomInfo.value.players,
            settings: roomInfo.value.settings,
          });
          void refreshRoomSnapshot();
          networkError.value = getAppTexts(language.value, uiStyle.value).matchInProgress;
          return;
        }
        handleNetworkError(new Error(payload.message ?? payload.code ?? getAppTexts(language.value, uiStyle.value).unknownServer));
      }),
    );

    onBeforeUnmount(() => {
      cancelSharedPassword();
      accountLinkGeneration += 1; clearTimeout(accountLinkExpiry);
      contribution.dispose();
      globalThis.removeEventListener("online", retryContributions);
      terminateAiWorker();
      stopReplayPlayback();
      cancelHintRequest();
      cancelAiComparison();
      clearActiveHint();
      clearHintFeedback();
      clearReconnectTimer();
      clearTurnCountdown();
      clearCountdownSnapshotRefresh();
      clearTurnTimer();
      clearChatEmojiBursts();
      clearLocalGameNotice();
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
      globalThis.addEventListener("online", retryContributions);
      retryContributions();
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
      topologyChart,
      hasDoubleTopologyChart,
      topologyChartLatest,
      setTopologyChart,
      hintRemainingCount,
      undoEnabled,
      undoRemainingCount,
      undoDisabled,
      requestUndo,
      rejectUndo,
      onlineUndoPending,
      onlineUndoVoted,
      selectedUndoEnabled,
      selectedUndoMaxCount,
      hintThinking,
      hintFeedback,
      localGameResumeNotice,
      localGameActions,
      replayDocument,
      replaySource,
      replayCursor,
      replayMode,
      replayPlaying,
      replayInspectorOpen,
      replayBusy,
      replayError,
      currentReplayEvent,
      replayInspectionPoint,
      replayInspectionOverlay,
      aiComparison,
      aiComparisonBusy,
      aiComparisonError,
      actionFeedback,
      actionFeedbackTone,
      hintDisabled,
      getTexts: getAppTexts,
      activeUtilityDeck,
      sharedPasswordOpen, sharedPasswordUsername, sharedPassword, sharedPasswordBusy, sharedPasswordError,
      handleSharedPasswordSubmit, cancelSharedPassword,
      guideDockBadge,
      activeGuideEntry,
      ruleGuideEntry,
      topologyGuideEntry,
      whyGuideEntry,
      thanksGuideEntry,
      isAuthenticated,
      language,
      uiStyle,
      networkDockBadge,
      serverUrl,
      roomIdInput,
      selectedPlayerCount,
      selectedBoardShape,
      handleBoardShapeChange,
      selectedTopologyDefinition,
      selectedTopologyHash,
      selectedTopologySource,
      topologySetupMessage,
      topologyRandomSeed,
      topologyDraft,
      topologyDraftX,
      topologyDraftY,
      topologyDefinitionText,
      selectTopologyPreset,
      generateTopologyBoard,
      handleGridSizeChange,
      updateTopologyStarts,
      newTopologyDraftRing,
      deleteTopologyDraftRing,
      addTopologyDraftVertex,
      undoTopologyDraftVertex,
      closeTopologyDraft,
      resetTopologyDraft,
      addTopologyDraftSeam,
      loadTopologyDefinitionText,
      selectedRoomBotCount,
      roomSetupOpen,
      openRoomSetup,
      saveRoomSettings,
      handleCreateSharedRoom: handleCreateRoom,
      accountLinkCode, accountLinkError, accountLinkBusy, handleLinkWechat, handleCopyLinkCode,
      retryRoomBots: () => networkManager.retryBots().catch(handleNetworkError),
      selectedGridSize,
      selectedStartPlayer,
      selectedTurnOrder,
      handleTurnOrderChange,
      selectedStartingPoints,
      updateStartingPoints,
      selectedTurnTimerEnabled,
      selectedTurnTimeLimitSeconds,
      selectedHintEnabled,
      selectedHintMaxCount,
      selectedAiMode,
      selectedLocalPlayers,
      activeLocalPlayers,
      localMatchStarted,
      localSetupPending,
      localSettingsChanged,
      updateLocalPlayer,
      swapLocalPlayers,
      startLocalMatch,
      aiDuelPaused,
      toggleAiDuel,
      isLocalAiTurn,
      contributionState,
      toggleContributions,
      retryContributions,
      aiThinking,
      aiLoading,
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
      turnTimerPhase,
      turnTimerRemaining,
      hintEnabled,
      hintMaxCount,
      tutorialActive,
      tutorialAutoRestoring,
      tutorialSuccess,
      tutorialAttempts,
      tutorialRestrictionObserved,
      boardInspectionOverlay,
      currentTutorialLevel,
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
      requestHint,
      handleConnect,
      handleCreateRoom,
      handleJoinRoom,
      handleLeaveRoom,
      handleToggleReady,
      handleStartPlayerChange,
      handleSkip,
      handleRootAction,
      handleReset,
      handleChatEmoji,
      handleExportReplay,
      handleImportReplay,
      handleStartReplay,
      handleExitReplay,
      handleSeekReplay,
      handleToggleReplayPlayback,
      runAiComparison,
      handleClosePrompt,
      finishTutorial,
      advanceTutorial,
      skipTutorial,
      startTutorial,
      finishTutorialToGuide,
    };
  },
  template: `
    <main class="app-shell app-shell-focus">
      <section class="stage-layout" :class="{ 'is-replay': replayMode, 'has-replay-inspector': replayMode && replayInspectorOpen }">
        <section class="board-column" :class="{ 'has-tutorial': tutorialActive }">
          <header class="stage-heading">
            <h1 class="stage-title">{{ getTexts(language, uiStyle).heroTitle }}</h1>
          </header>

          <TutorialCard
            v-if="tutorialActive && !tutorialAutoRestoring"
            :language="language"
            :level="currentTutorialLevel"
            :success="tutorialSuccess"
            :restriction-observed="tutorialRestrictionObserved"
            :attempts="tutorialAttempts"
            @continue="advanceTutorial"
            @skip="skipTutorial"
            @guide="finishTutorialToGuide"
          />

          <BoardCanvas
            :player-count="gameState.playerCount"
            :board-shape="gameState.boardShape"
            :language="language"
            :ui-style="uiStyle"
            :hint-text="boardHint"
            :emoji-bursts="chatEmojiBursts"
            :ai-thinking="aiThinking"
            :inspection-overlay="boardInspectionOverlay"
            :input-locked="!tutorialActive && !replayMode && roomStatus === 'solo' && (localSetupPending || isLocalAiTurn())"
            @controller-ready="handleControllerReady"
            @state-change="handleStateChange"
          >
            <template #tools>
              <aside class="dock-column board-tools">
                <DockLauncher
                  variant="board"
                  :title="getTexts(language, uiStyle).boardDockTitle"
                  :compact-title="language === 'zh' ? '棋盘舱' : 'Board'"
                  :badge="boardDockBadge"
                  @open="handleOpenUtilityDeck('board')"
                />
                <DockLauncher
                  v-if="!replayMode"
                  variant="network"
                  :title="getTexts(language, uiStyle).networkDockTitle"
                  :compact-title="language === 'zh' ? '联机舱' : 'Lobby'"
                  :copy="getTexts(language, uiStyle).networkDockCopy"
                  :badge="networkDockBadge"
                  @open="handleOpenUtilityDeck('network')"
                />
                <DockLauncher
                  variant="guide"
                  :title="getTexts(language, uiStyle).guideDockTitle"
                  :compact-title="language === 'zh' ? '指南舱' : 'Guide'"
                  :copy="getTexts(language, uiStyle).guideDockCopy"
                  :badge="guideDockBadge"
                  @open="handleOpenUtilityDeck('guide')"
                />
                <DockLauncher
                  v-if="!replayMode"
                  variant="tutorial"
                  :title="language === 'zh' ? '新手引导' : 'Tutorial'"
                  :copy="language === 'zh' ? '随时从第一关开始学习' : 'Restart the five lessons anytime'"
                  @open="startTutorial"
                />
              </aside>
            </template>
          </BoardCanvas>

          <div v-if="hasDoubleTopologyChart" class="topology-chart-switch" role="group" :aria-label="language === 'zh' ? '展开图显示' : 'Atlas view'">
            <button v-for="chart in ['front', 'back', 'both']" :key="chart" type="button" class="language-button" :class="{ 'is-active': topologyChart === chart }" :aria-pressed="topologyChart === chart" @click="setTopologyChart(chart)">
              {{ chart === 'front' ? (language === 'zh' ? '正面' : 'Front') : chart === 'back' ? (language === 'zh' ? '反面' : 'Back') : (language === 'zh' ? '双面' : 'Both') }}<span v-if="chart !== 'both' && topologyChartLatest[chart]" :aria-label="language === 'zh' ? '包含最近落点' : 'Contains a recent move'"> ●</span>
            </button>
          </div>

          <TopologySurfaceExpandable v-if="gameState.isTopologyBoard" :snapshot="gameState.snapshot" :language="language" />

          <section v-if="!replayMode && gameState.legalRootActions?.length" class="panel panel-subtle root-action-panel" aria-live="polite">
            <strong>{{ language === 'zh' ? (gameState.rootMode === 'relocate' ? '迁移起点（占一回合）' : '增设起点（占一回合）') : (gameState.rootMode === 'relocate' ? 'Relocate root (uses the turn)' : 'Add root (uses the turn)') }}</strong>
            <p class="help-copy">{{ language === 'zh' ? '请选择一个高亮的己方存活节点；取消或非法操作不会消耗额度。' : 'Choose an eligible friendly live node. Cancelling or an illegal action does not consume the quota.' }}</p>
            <div class="root-action-targets">
              <button v-for="action in gameState.legalRootActions" :key="action.type + ':' + action.point.join(',')"
                type="button" class="action-button action-button-secondary" :disabled="gameState.interactionLocked || aiThinking"
                @click="handleRootAction(action)">
                {{ action.point[0] + 1 }}, {{ action.point[1] + 1 }} · {{ language === 'zh' ? '剩余' : 'left' }} {{ gameState.rootActionsRemaining?.[gameState.currentPlayer]?.[gameState.rootMode] ?? 0 }}
              </button>
            </div>
          </section>

          <ReplayControls
            v-if="replayMode && replayDocument"
            :language="language"
            :ui-style="uiStyle"
            :replay-document="replayDocument"
            :cursor="replayCursor"
            :event="currentReplayEvent"
            :playing="replayPlaying"
            :inspector-open="replayInspectorOpen"
            :error="replayError"
            @seek="handleSeekReplay"
            @toggle-play="handleToggleReplayPlayback"
            @toggle-inspector="replayInspectorOpen = !replayInspectorOpen"
            @exit-review="handleExitReplay"
          />

          <ControlPanel
            v-else
            :ai-duel="roomStatus === 'solo' && !tutorialActive && !localSetupPending && selectedAiMode !== 'none'"
            :ai-duel-paused="aiDuelPaused"
            :game-state="gameState"
            :language="language"
            :ui-style="uiStyle"
            :skip-disabled="skipDisabled"
            :tutorial-skip-target="tutorialActive && !tutorialSuccess && currentTutorialLevel.objective.type === 'skip'"
            :reset-disabled="resetDisabled"
            :reset-label="resetLabel"
            :session="session"
            :room-players="roomInfo.players"
            :turn-timer-enabled="turnTimerEnabled"
            :turn-timer-phase="turnTimerPhase"
            :turn-timer-remaining="turnTimerRemaining"
            :ai-thinking="aiThinking"
            :ai-loading="aiLoading"
            :multiplayer-enabled="gameState.multiplayerEnabled"
            :hint-enabled="hintEnabled"
            :undo-enabled="undoEnabled"
            :undo-remaining-count="undoRemainingCount"
            :undo-disabled="undoDisabled"
            :online-undo-pending="onlineUndoPending"
            :online-undo-voted="onlineUndoVoted"
            :online-undo-votes="roomInfo.undo?.votes?.length ?? 0"
            :online-undo-required-votes="roomInfo.undo?.requiredVotes ?? 0"
            :hint-remaining-count="hintRemainingCount"
            :hint-thinking="hintThinking"
            :hint-disabled="hintDisabled"
            :hint-feedback="hintFeedback"
            :resume-notice="localGameResumeNotice"
            :action-feedback="actionFeedback"
            :action-feedback-tone="actionFeedbackTone"
            :emoji-options="chatEmojiOptions"
            :emoji-disabled="chatEmojiDisabled"
            @skip="handleSkip"
            @hint="requestHint"
            @undo="requestUndo"
            @undo-reject="rejectUndo"
            @reset="handleReset"
            @emoji="handleChatEmoji"
            @toggle-ai-duel="toggleAiDuel"
          />
        </section>


        <details v-if="replayMode" class="replay-detail replay-details-fold" @toggle="replayInspectorOpen = $event.target.open">
          <summary>{{ language === 'zh' ? '着法与分析' : 'Moves and analysis' }}</summary>
          <ReplayInspectorPanel
            :language="language"
            :game-state="gameState"
            :event="currentReplayEvent"
            :cursor="replayCursor"
            :selected-point="replayInspectionPoint"
            :ai-comparison="aiComparison"
            :ai-comparison-busy="aiComparisonBusy"
            :ai-comparison-error="aiComparisonError"
            @inspect-point="replayInspectionPoint = $event"
            @compare-ai="runAiComparison"
          />
        </details>
      </section>

      <UtilityModal
        variant="board"
        :visible="activeUtilityDeck === 'board'"
        :eyebrow="getTexts(language, uiStyle).stageFocusEyebrow"
        :title="getTexts(language, uiStyle).boardDockTitle"
        :close-label="getTexts(language, uiStyle).closePanel"
        @close="handleCloseUtilityDeck"
      >
        <div class="utility-grid utility-grid-board">
          <SetupPanel
            :language="language"
            :ui-style="uiStyle"
            :player-count="selectedPlayerCount"
            :board-shape="selectedBoardShape"
            :grid-size="selectedGridSize"
            :turn-timer-enabled="selectedTurnTimerEnabled"
            :turn-time-limit-seconds="selectedTurnTimeLimitSeconds"
            :hint-enabled="selectedHintEnabled"
            :hint-max-count="selectedHintMaxCount"
            :undo-enabled="selectedUndoEnabled"
            :undo-max-count="selectedUndoMaxCount"
            :local-players="selectedLocalPlayers"
            :start-player="selectedStartPlayer"
            :turn-order="selectedTurnOrder"
            :local-pending="localSetupPending || localSettingsChanged"
            :local-started="localMatchStarted"
            :starting-points="selectedStartingPoints"
            :contribution-state="contributionState"
            :room-setup-open="roomSetupOpen"
            :ai-available="roomStatus === 'solo' && !tutorialActive"
            :online-available="roomStatus !== 'solo' && !tutorialActive"
            :settings-locked="settingsLocked"
            :busy="networkBusy"
            @update:language="language = $event"
            @update:ui-style="uiStyle = $event"
            @update:player-count="selectedPlayerCount = $event"
            @update:board-shape="handleBoardShapeChange"
            @update:grid-size="handleGridSizeChange"
            @update:turn-timer-enabled="selectedTurnTimerEnabled = $event"
            @update:turn-time-limit-seconds="selectedTurnTimeLimitSeconds = $event"
            @update:hint-enabled="selectedHintEnabled = $event"
            @update:hint-max-count="selectedHintMaxCount = $event"
            @update:undo-enabled="selectedUndoEnabled = $event"
            @update:undo-max-count="selectedUndoMaxCount = $event"
            @update-local-player="updateLocalPlayer"
            @select-lab-model="updateLocalPlayer({ ...$event, fromLab: true })"
            @save-room-settings="saveRoomSettings"
            @update:start-player="handleStartPlayerChange"
            @update:turn-order="handleTurnOrderChange"
            @swap-local-players="swapLocalPlayers"
            @start-local-match="startLocalMatch"
            @update-starting-points="updateStartingPoints"
            @open-topology-guide="handleOpenGuideEntry('topology')"
            @toggle-contributions="toggleContributions"
            @retry-contributions="retryContributions"
          >
            <template #topology-feedback>
              <p v-if="topologySetupMessage.startsWith('ERROR:')" class="error-copy" role="alert">{{ topologySetupMessage.slice(6).trimStart() }}</p>
            </template>
            <template #topology>
          <TopologySetupPanel v-if="selectedBoardShape === 'custom'"
            :language="language"
            :grid-size="selectedGridSize"
            :player-count="selectedPlayerCount"
            :definition="selectedTopologyDefinition"
            :board-hash="selectedTopologyHash"
            :source="selectedTopologySource"
            :message="topologySetupMessage"
            :seed="topologyRandomSeed"
            :draft="topologyDraft"
            :draft-x="topologyDraftX"
            :draft-y="topologyDraftY"
            :definition-text="topologyDefinitionText"
            :locked="settingsLocked"
            :busy="networkBusy"
            @select-preset="selectTopologyPreset"
            @generate-random="generateTopologyBoard"
            @update:seed="topologyRandomSeed = $event"
            @update:draft-x="topologyDraftX = $event"
            @update:draft-y="topologyDraftY = $event"
            @update:definition-text="topologyDefinitionText = $event"
            @draft-add="addTopologyDraftVertex"
            @draft-undo="undoTopologyDraftVertex"
            @draft-close="closeTopologyDraft"
            @draft-reset="resetTopologyDraft"
            @draft-add-seam="addTopologyDraftSeam"
            @draft-new-ring="newTopologyDraftRing"
            @draft-delete-ring="deleteTopologyDraftRing"
            @update-starts="updateTopologyStarts"
            @definition-load="loadTopologyDefinitionText"
          />
            </template>
          </SetupPanel>

          <div class="board-status-stack">
          <ScorePanel
            :game-state="gameState"
            :local-pending="roomStatus === 'solo' && !tutorialActive && localSetupPending"
            :session="session"
            :room-players="roomInfo.players"
            :language="language"
            :ui-style="uiStyle"
            :status-text="statusText"
          />
          <ReplayPanel
            :language="language"
            :action-count="localGameActions.length"
            :replay-document="replayDocument"
            :imported-ready="replaySource === 'imported' && !!replayDocument"
            :can-review="roomStatus === 'solo' && !tutorialActive && !networkBusy && !!controller"
            :replay-mode="replayMode"
            :busy="replayBusy"
            :error="replayError"
            @export="handleExportReplay"
            @import-file="handleImportReplay"
            @review-current="handleStartReplay('current')"
            @review-imported="handleStartReplay('imported')"
            @exit-review="handleExitReplay"
          />
          </div>
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

          <SharedLadderPanel :language="language" :auth="auth" />

          <section v-if="isAuthenticated" class="panel modal-panel">
            <h3>{{ language === 'zh' ? '关联微信账号' : 'Link WeChat account' }}</h3>
            <p>{{ language === 'zh' ? '可选：把网页账号与微信身份关联；同房对战不要求绑定。' : 'Optional: link your Web and WeChat identities. Linking is not required to play in the same room.' }}</p>
            <button class="action-button action-button-secondary" :disabled="accountLinkBusy || sharedPasswordOpen || networkBusy || !!session.roomId" @click="handleLinkWechat">{{ language === 'zh' ? '生成一次性绑定码' : 'Generate one-time code' }}</button>
            <template v-if="accountLinkCode">
              <p>{{ language === 'zh' ? '5 分钟有效，仅在自己的小游戏账号页面使用。' : 'Expires in 5 minutes. Use it only in your own Mini Game account panel.' }}</p>
              <input class="input-field" readonly :value="accountLinkCode" aria-label="Account link code" />
              <button class="action-button action-button-ghost" @click="handleCopyLinkCode">{{ language === 'zh' ? '复制绑定码' : 'Copy code' }}</button>
            </template>
            <p v-if="accountLinkError" class="error-copy" role="alert">{{ accountLinkError }}</p>
          </section>

          <section v-if="sharedPasswordOpen" class="panel modal-panel" aria-live="polite">
            <h3>{{ language === 'zh' ? '确认原网页账号' : 'Verify your Web account' }}</h3>
            <p>{{ language === 'zh' ? '进入互通对战前，请验证网页账号密码；密码不会保存。' : 'Verify your Web account before shared play. Your password is not stored.' }}</p>
            <form @submit.prevent="handleSharedPasswordSubmit">
              <label class="field-label" for="shared-password-username">{{ language === 'zh' ? '当前账号' : 'Current account' }}</label>
              <input id="shared-password-username" class="input-field" readonly :value="sharedPasswordUsername" autocomplete="off" />
              <label class="field-label" for="shared-password-input">{{ language === 'zh' ? '网页账号密码' : 'Web account password' }}</label>
              <input id="shared-password-input" class="input-field" type="password" autocomplete="off" v-model="sharedPassword" :disabled="sharedPasswordBusy" />
              <p v-if="sharedPasswordError" class="error-copy" role="alert">{{ sharedPasswordError }}</p>
              <div class="button-row">
                <button class="action-button action-button-primary" type="submit" :disabled="sharedPasswordBusy">{{ language === 'zh' ? '验证并继续' : 'Verify and continue' }}</button>
                <button class="action-button action-button-ghost" type="button" @click="cancelSharedPassword">{{ language === 'zh' ? '取消' : 'Cancel' }}</button>
              </div>
            </form>
          </section>

          <RoomPanel
            :player-count="selectedPlayerCount"
            :board-shape="selectedBoardShape"
            :bot-count="selectedRoomBotCount"
            :language="language"
            :ui-style="uiStyle"
            :room-id="roomIdInput"
            :connection-state="connectionState"
            :room-status="roomStatus"
            :session="session"
            :network-error="networkError"
            :authenticated="isAuthenticated"
            :busy="networkBusy || sharedPasswordOpen"
            :room-info="roomInfo"
            :is-host="isHost"
            :local-ready="localReady"
            :ready-disabled="readyDisabled"
            :starter-locked="starterLocked"
            :start-player="selectedStartPlayer"
            :starter-options="starterOptions"
            :show-close-prompt="showClosePrompt"
            @update:room-id="roomIdInput = $event"
            @update:bot-count="selectedRoomBotCount = $event"
            @retry-bots="retryRoomBots"
            @connect="handleConnect"
            @create-room="openRoomSetup"
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
          :topology-entry="topologyGuideEntry"
          :why-entry="whyGuideEntry"
          :thanks-entry="thanksGuideEntry"
          @open-entry="handleOpenGuideEntry"
        />
      </UtilityModal>

      <GuideReaderModal
        :entry="activeGuideEntry"
        :initial-key="activeGuideKey"
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
      <footer class="site-footer">
        <a href="https://beian.mps.gov.cn/#/query/webSearch?code=11011402056155" rel="noreferrer" target="_blank" class="footer-beian-link footer-gongan">
          <img src="./assets/beian.png" alt="公安备案图标" class="footer-gongan-icon" />
          京公网安备11011402056155号
        </a>
      </footer>
    </main>
  `,
};

export default App;
