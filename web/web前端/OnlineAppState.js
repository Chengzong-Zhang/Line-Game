import { Player, PLAYER_ORDER, BOARD_SHAPES, RootMode, StartProtectionRule, TerritoryRulesVersion, resolveBoardShape } from "./GameEngine.js?v=20261029-unified-r1";
import { startingPointSettings, requiresExplicitStartingPoints, randomInitialPositions } from "./StartingPoints.js?v=20261029-unified-r1";
import { DEFAULT_UNDO_MAX_COUNT, UNDO_MAX_COUNT_MIN, UNDO_MAX_COUNT_MAX } from "./LocalUndo.js?v=20261029-unified-r1";

// 杩欎釜鏂囦欢涓撻棬瀛樻斁鈥滃彲澶嶇敤鐨勫墠绔姸鎬佸伐鍏封€濓紝
// 閬垮厤 OnlineApp.js 鍐嶆鑶ㄨ儉鎴愪竴涓秴澶у伐鍏风鏂囦欢銆?
export const LANGUAGE_STORAGE_KEY = "triaxis-language";
export const SESSION_STORAGE_KEY = "triaxis-online-session";
export const AUTH_STORAGE_KEY = "triaxis-auth";
export const ALL_PLAYERS = PLAYER_ORDER;
export const PLAYER_COUNT_OPTIONS = Object.freeze(Array.from({ length: 14 }, (_, index) => index + 2));
export const GRID_SIZE_OPTIONS = Object.freeze(Array.from({ length: 11 }, (_, index) => index + 5));
export const TURN_TIMER_MIN_SECONDS = 15;
export const TURN_TIMER_MAX_SECONDS = 200;
export const DEFAULT_TURN_TIMER_SECONDS = 60;
export const HINT_MAX_COUNT_MIN = 1;
export const HINT_MAX_COUNT_MAX = 10;
export const DEFAULT_HINT_MAX_COUNT = 3;
export const DEFAULT_RULES_VERSION = TerritoryRulesVersion.V3;
export const RULES_VERSION_OPTIONS = Object.freeze(Object.values(TerritoryRulesVersion));
export const DEFAULT_PROTECTION_RULE = StartProtectionRule.DUEL_FIRST_UNPROTECTED;
export const PROTECTION_RULE_OPTIONS = Object.freeze(Object.values(StartProtectionRule));
export const TOPOLOGY_RULES_VERSION = "surface-v1";
export const TOPOLOGY_BOARD_SHAPE = "custom";
export const TOPOLOGY_PROTOCOL_VERSION = "board-topology-v1";

/**
 * This deliberately recognizes incomplete topology settings too.  Callers
 * that receive authority from the network must reject an incomplete map,
 * rather than normalize it into a playable legacy triangle.
 */
export function isTopologyGameSettings(settings = {}) {
  return Boolean(settings && typeof settings === "object" && !Array.isArray(settings)
    && (settings.rulesVersion === TOPOLOGY_RULES_VERSION
      || settings.boardShape === TOPOLOGY_BOARD_SHAPE
      || Object.hasOwn(settings, "boardDefinition")
      || Object.hasOwn(settings, "boardHash")
      || Object.hasOwn(settings, "topologyProtocolVersion")));
}

export function normalizeGameSettings(settings = {}) {
  const playerCount = Number(settings?.playerCount);
  const gridSize = Number(settings?.gridSize);
  const turnTimeLimitSeconds = Number(settings?.turnTimeLimitSeconds);
  const hintMaxCount = Number(settings?.hintMaxCount);
  const undoMaxCount = Number(settings?.undoMaxCount);
  const rulesVersion = RULES_VERSION_OPTIONS.includes(settings?.rulesVersion)
    ? settings.rulesVersion
    : DEFAULT_RULES_VERSION;
  const nextPlayerCount = PLAYER_COUNT_OPTIONS.includes(playerCount) ? playerCount : 2;
  const allowedPlayers = ALL_PLAYERS.slice(0, nextPlayerCount);
  const startPlayer = allowedPlayers.includes(settings?.startPlayer) ? settings.startPlayer : allowedPlayers[0];
  const normalizedTurnTimeLimitSeconds = Number.isFinite(turnTimeLimitSeconds)
    ? Math.max(TURN_TIMER_MIN_SECONDS, Math.min(TURN_TIMER_MAX_SECONDS, Math.round(turnTimeLimitSeconds)))
    : DEFAULT_TURN_TIMER_SECONDS;
  const normalizedHintMaxCount = Number.isFinite(hintMaxCount)
    ? Math.max(HINT_MAX_COUNT_MIN, Math.min(HINT_MAX_COUNT_MAX, Math.round(hintMaxCount)))
    : DEFAULT_HINT_MAX_COUNT;
  const nextGridSize = GRID_SIZE_OPTIONS.includes(gridSize) ? gridSize : 9;
  if (isTopologyGameSettings(settings)) {
    // A surface board owns its canonical starts inside boardDefinition.  In
    // particular, do not run legacy resolveBoardShape/startingPointSettings:
    // both operate on coordinate matrices and would silently replace the
    // negotiated custom board with a triangle/hexagon.
    return {
      playerCount: nextPlayerCount,
      boardShape: TOPOLOGY_BOARD_SHAPE,
      botCount: 0,
      gridSize: nextGridSize,
      startPlayer,
      rulesVersion: TOPOLOGY_RULES_VERSION,
      topologyProtocolVersion: typeof settings?.topologyProtocolVersion === "string"
        ? settings.topologyProtocolVersion
        : TOPOLOGY_PROTOCOL_VERSION,
      ...(Object.hasOwn(settings, "boardDefinition")
        ? { boardDefinition: settings.boardDefinition }
        : {}),
      ...(Object.hasOwn(settings, "boardHash") ? { boardHash: settings.boardHash } : {}),
      ...(settings?.initialPositions && typeof settings.initialPositions === "object"
        ? { initialPositions: settings.initialPositions }
        : {}),
      turnTimerEnabled: Boolean(settings?.turnTimerEnabled),
      turnTimeLimitSeconds: normalizedTurnTimeLimitSeconds,
      hintEnabled: Boolean(settings?.hintEnabled),
      hintMaxCount: normalizedHintMaxCount,
      undoEnabled: Boolean(settings?.undoEnabled),
      undoMaxCount: Number.isFinite(undoMaxCount)
        ? Math.max(UNDO_MAX_COUNT_MIN, Math.min(UNDO_MAX_COUNT_MAX, Math.round(undoMaxCount)))
        : DEFAULT_UNDO_MAX_COUNT,
    };
  }
  const boardShape = resolveBoardShape(nextPlayerCount, BOARD_SHAPES.includes(settings?.boardShape) ? settings.boardShape : null);
  const hasProtectionRule = PROTECTION_RULE_OPTIONS.includes(settings?.protectionRule);
  const protectionRule = hasProtectionRule ? settings.protectionRule
    : (nextPlayerCount === 2 && boardShape === "triangle"
      ? DEFAULT_PROTECTION_RULE : StartProtectionRule.SYMMETRIC);
  let starts = {};
  try {
    starts = startingPointSettings({ ...settings, gridSize: nextGridSize, playerCount: nextPlayerCount, boardShape });
  } catch (_) {
    if (requiresExplicitStartingPoints(nextPlayerCount, boardShape)) {
      starts = { startingPointMode: "random", initialPositions: randomInitialPositions(nextGridSize, nextPlayerCount, Math.random, boardShape) };
    }
  }

  const normalizedRulesVersion = starts.rootMode && starts.rootMode !== RootMode.CLASSIC
    ? TerritoryRulesVersion.V3
    : rulesVersion;

  return {
    playerCount: nextPlayerCount,
    boardShape,
    botCount: nextPlayerCount >= 3 ? Math.max(0, Math.min(nextPlayerCount - 1, Math.trunc(Number(settings?.botCount) || 0))) : 0,
    gridSize: GRID_SIZE_OPTIONS.includes(gridSize) ? gridSize : 9,
    startPlayer,
    rulesVersion: normalizedRulesVersion,
    ...(protectionRule !== StartProtectionRule.SYMMETRIC || hasProtectionRule ? { protectionRule } : {}),
    turnTimerEnabled: Boolean(settings?.turnTimerEnabled),
    turnTimeLimitSeconds: normalizedTurnTimeLimitSeconds,
    hintEnabled: Boolean(settings?.hintEnabled),
    hintMaxCount: normalizedHintMaxCount,
    undoEnabled: Boolean(settings?.undoEnabled),
    undoMaxCount: Number.isFinite(undoMaxCount)
      ? Math.max(UNDO_MAX_COUNT_MIN, Math.min(UNDO_MAX_COUNT_MAX, Math.round(undoMaxCount)))
      : DEFAULT_UNDO_MAX_COUNT,
    ...starts,
  };
}

export function getPrimaryScores(gameState = null) {
  // The UI and terminal winner share the discrete flood-fill score. The
  // geometric display score is retained only for old snapshots/diagnostics.
  return gameState?.scores ?? gameState?.displayScores ?? {};
}

export function createDefaultGameState() {
  return {
    rulesVersion: DEFAULT_RULES_VERSION,
    protectionRule: DEFAULT_PROTECTION_RULE,
    positionRevision: 0,
    currentPlayer: Player.BLACK,
    gameOver: false,
    winner: null,
    turnCount: 0,
    consecutiveSkips: 0,
    scores: Object.fromEntries(ALL_PLAYERS.map((player) => [player, 0])),
    displayScores: Object.fromEntries(ALL_PLAYERS.map((player) => [player, 0])),
    territories: Object.fromEntries(ALL_PLAYERS.map((player) => [player, { area: 0, polygon: null }])),
    legalMoves: [],
    snapshot: null,
    lastAction: null,
    resignedPlayers: [],
    players: [Player.BLACK, Player.WHITE],
    playerCount: 2,
    boardShape: "triangle",
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

export function createEmptySession() {
  return {
    url: null,
    roomId: null,
    playerId: null,
    color: null,
    connected: false,
    settings: normalizeGameSettings(),
  };
}

export function createEmptyAuth() {
  return {
    token: null,
    username: null,
    authOrigin: null,
  };
}

export function loadStoredSession() {
  try {
    const raw = globalThis.localStorage?.getItem(SESSION_STORAGE_KEY);
    if (!raw) {
      return createEmptySession();
    }

    const parsed = JSON.parse(raw);
    return {
      ...createEmptySession(),
      ...parsed,
      connected: false,
      settings: normalizeGameSettings({
        ...parsed?.settings,
        protectionRule: parsed?.settings?.protectionRule ?? StartProtectionRule.SYMMETRIC,
      }),
    };
  } catch (_e) {
    return createEmptySession();
  }
}

export function persistSession(session) {
  const normalized = {
    url: session?.url ?? null,
    roomId: session?.roomId ?? null,
    playerId: session?.playerId ?? null,
    color: session?.color ?? null,
    settings: normalizeGameSettings(session?.settings),
  };

  const hasRoomContext = normalized.url || normalized.roomId || normalized.playerId || normalized.color;
  if (!hasRoomContext) {
    globalThis.localStorage?.removeItem(SESSION_STORAGE_KEY);
    return;
  }

  globalThis.localStorage?.setItem(SESSION_STORAGE_KEY, JSON.stringify(normalized));
}

export function loadStoredAuth() {
  try {
    const raw = globalThis.localStorage?.getItem(AUTH_STORAGE_KEY);
    if (!raw) {
      return createEmptyAuth();
    }

    const parsed = JSON.parse(raw);
    return {
      ...createEmptyAuth(),
      ...parsed,
    };
  } catch (_e) {
    return createEmptyAuth();
  }
}

export function persistAuth(auth) {
  const normalized = {
    token: auth?.token ?? null,
    username: auth?.username ?? null,
    authOrigin: auth?.authOrigin ?? null,
  };

  if (!normalized.token || !normalized.username) {
    globalThis.localStorage?.removeItem(AUTH_STORAGE_KEY);
    return;
  }

  globalThis.localStorage?.setItem(AUTH_STORAGE_KEY, JSON.stringify(normalized));
}
