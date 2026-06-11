import { Player } from "./GameEngine.js?v=20260430d";

// 杩欎釜鏂囦欢涓撻棬瀛樻斁鈥滃彲澶嶇敤鐨勫墠绔姸鎬佸伐鍏封€濓紝
// 閬垮厤 OnlineApp.js 鍐嶆鑶ㄨ儉鎴愪竴涓秴澶у伐鍏风鏂囦欢銆?
export const LANGUAGE_STORAGE_KEY = "triaxis-language";
export const SESSION_STORAGE_KEY = "triaxis-online-session";
export const AUTH_STORAGE_KEY = "triaxis-auth";
export const ALL_PLAYERS = Object.freeze([Player.BLACK, Player.WHITE, Player.PURPLE]);
export const PLAYER_COUNT_OPTIONS = Object.freeze([2, 3]);
export const GRID_SIZE_OPTIONS = Object.freeze(Array.from({ length: 10 }, (_, index) => index + 6));
export const TURN_TIMER_MIN_SECONDS = 15;
export const TURN_TIMER_MAX_SECONDS = 200;
export const DEFAULT_TURN_TIMER_SECONDS = 60;

export function normalizeGameSettings(settings = {}) {
  const playerCount = Number(settings?.playerCount);
  const gridSize = Number(settings?.gridSize);
  const turnTimeLimitSeconds = Number(settings?.turnTimeLimitSeconds);
  const nextPlayerCount = PLAYER_COUNT_OPTIONS.includes(playerCount) ? playerCount : 2;
  const allowedPlayers = ALL_PLAYERS.slice(0, nextPlayerCount);
  const startPlayer = allowedPlayers.includes(settings?.startPlayer) ? settings.startPlayer : allowedPlayers[0];
  const normalizedTurnTimeLimitSeconds = Number.isFinite(turnTimeLimitSeconds)
    ? Math.max(TURN_TIMER_MIN_SECONDS, Math.min(TURN_TIMER_MAX_SECONDS, Math.round(turnTimeLimitSeconds)))
    : DEFAULT_TURN_TIMER_SECONDS;

  return {
    playerCount: nextPlayerCount,
    gridSize: GRID_SIZE_OPTIONS.includes(gridSize) ? gridSize : 9,
    startPlayer,
    turnTimerEnabled: Boolean(settings?.turnTimerEnabled),
    turnTimeLimitSeconds: normalizedTurnTimeLimitSeconds,
  };
}

export function createDefaultGameState() {
  return {
    currentPlayer: Player.BLACK,
    gameOver: false,
    winner: null,
    turnCount: 0,
    consecutiveSkips: 0,
    scores: {
      [Player.BLACK]: 0,
      [Player.WHITE]: 0,
      [Player.PURPLE]: 0,
    },
    displayScores: {
      [Player.BLACK]: 0,
      [Player.WHITE]: 0,
      [Player.PURPLE]: 0,
    },
    territories: {
      [Player.BLACK]: { area: 0, polygon: null },
      [Player.WHITE]: { area: 0, polygon: null },
      [Player.PURPLE]: { area: 0, polygon: null },
    },
    legalMoves: [],
    snapshot: null,
    lastAction: null,
    resignedPlayers: [],
    players: [Player.BLACK, Player.WHITE],
    playerCount: 2,
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
  };

  if (!normalized.token || !normalized.username) {
    globalThis.localStorage?.removeItem(AUTH_STORAGE_KEY);
    return;
  }

  globalThis.localStorage?.setItem(AUTH_STORAGE_KEY, JSON.stringify(normalized));
}
