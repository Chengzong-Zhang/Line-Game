import { Player } from "./GameEngine.js?v=20260420a";

export const LANGUAGE_STORAGE_KEY = "triaxis-language";
export const SESSION_STORAGE_KEY = "triaxis-online-session";
export const ALL_PLAYERS = Object.freeze([Player.BLACK, Player.WHITE, Player.PURPLE]);
export const PLAYER_COUNT_OPTIONS = Object.freeze([2, 3]);
export const GRID_SIZE_OPTIONS = Object.freeze(Array.from({ length: 11 }, (_, index) => index + 5));

export function normalizeGameSettings(settings = {}) {
  const playerCount = Number(settings?.playerCount);
  const gridSize = Number(settings?.gridSize);

  return {
    playerCount: PLAYER_COUNT_OPTIONS.includes(playerCount) ? playerCount : 2,
    gridSize: GRID_SIZE_OPTIONS.includes(gridSize) ? gridSize : 9,
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
    territories: {
      [Player.BLACK]: { area: 0, polygon: null },
      [Player.WHITE]: { area: 0, polygon: null },
      [Player.PURPLE]: { area: 0, polygon: null },
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
  } catch {
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
