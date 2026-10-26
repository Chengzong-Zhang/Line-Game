import { ALL_LOCAL_PLAYER_CHOICES, MULTIPLAYER_AI_CHOICES, normalizeLocalPlayers, usesGenericBoardAI } from "./LocalAIModes.js?v=20261022-multiplayer1";
import { startingPointSettings } from "./StartingPoints.js?v=20261021-boardshapes1";
import { PLAYER_ORDER, StartProtectionRule, resolveBoardShape } from "./GameEngine.js?v=20261021-boardshapes1";
import { normalizeUndoUsage } from "./LocalUndo.js?v=20261021-undo1";

const LOCAL_GAME_SESSION_FORMAT = "lifeline-local-session";
const PLAYER_COLORS = PLAYER_ORDER;
export const LOCAL_GAME_SESSION_SCHEMA_VERSION = 1;
export const LOCAL_GAME_SESSION_STORAGE_KEY = "lifeline-local-game-session-v1";

const GAME_SETTING_KEYS = Object.freeze([
  "playerCount",
  "boardShape",
  "gridSize",
  "startPlayer",
  "rulesVersion",
  "protectionRule",
  "turnTimerEnabled",
  "turnTimeLimitSeconds",
  "hintEnabled",
  "hintMaxCount",
  "undoEnabled",
  "undoMaxCount",
]);

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeSettings(settings) {
  if (!settings || typeof settings !== "object") {
    return null;
  }

  const normalized = {};
  for (const key of GAME_SETTING_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(settings, key)) {
      continue;
    }
    normalized[key] = settings[key];
  }
  const protectionRule = normalized.protectionRule ?? StartProtectionRule.SYMMETRIC;

  if (!Number.isInteger(normalized.playerCount) || !Number.isInteger(normalized.gridSize)) {
    return null;
  }
  if (normalized.playerCount < 2 || normalized.playerCount > 15 || normalized.gridSize < 5 || normalized.gridSize > 15) {
    return null;
  }
  if (typeof normalized.startPlayer !== "string" || typeof normalized.rulesVersion !== "string") {
    return null;
  }
  if (!Object.values(StartProtectionRule).includes(protectionRule)) return null;
  normalized.protectionRule = protectionRule;
  if (!PLAYER_COLORS.slice(0, normalized.playerCount).includes(normalized.startPlayer)) return null;
  try {
    normalized.boardShape = resolveBoardShape(normalized.playerCount, settings.boardShape);
    Object.assign(normalized, startingPointSettings({ ...settings, ...normalized }));
  } catch (_) { return null; }

  return normalized;
}

function normalizePoint(point) {
  if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isInteger)) {
    return null;
  }
  return [point[0], point[1]];
}

function normalizeAction(action) {
  if (!action || typeof action !== "object") {
    return null;
  }

  if (action.type === "player_move" || action.type === "move") {
    const point = normalizePoint(action.point);
    return point ? { type: "player_move", point } : null;
  }

  if (action.type === "player_skip" || action.type === "skip") {
    return { type: "player_skip" };
  }

  if (action.type === "player_resign" || action.type === "resign") {
    const color = action.color ?? action.player;
    return typeof color === "string" ? { type: "player_resign", color } : null;
  }

  return null;
}

function normalizeSession(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (value.format !== LOCAL_GAME_SESSION_FORMAT || value.schemaVersion !== LOCAL_GAME_SESSION_SCHEMA_VERSION) {
    return null;
  }

  const settings = normalizeSettings(value.settings);
  const actions = Array.isArray(value.actions)
    ? value.actions.map(normalizeAction)
    : null;
  if (!settings || !actions || actions.some((action) => !action)) {
    return null;
  }

  const match = value.match;
  if (match !== undefined && (!match || typeof match.started !== "boolean" || typeof match.paused !== "boolean"
    || ["BLACK", "WHITE"].some((color) => !ALL_LOCAL_PLAYER_CHOICES.includes(match.players?.[color]?.choice))
    || PLAYER_COLORS.slice(2).some((color) => match.players?.[color] && !ALL_LOCAL_PLAYER_CHOICES.includes(match.players[color].choice))
    || (settings.playerCount >= 4 && PLAYER_COLORS.slice(0, settings.playerCount).some((color) => !ALL_LOCAL_PLAYER_CHOICES.includes(match.players?.[color]?.choice))))) return null;
  if (match && !usesGenericBoardAI(settings.playerCount, settings.boardShape) && settings.playerCount >= 4
    && PLAYER_COLORS.slice(0, settings.playerCount).some((color) => !["human", "hex-player", ...MULTIPLAYER_AI_CHOICES].includes(match.players[color].choice))) return null;
  if (match && settings.playerCount >= 4 && !["territory-v2", "territory-v3"].includes(settings.rulesVersion)
    && PLAYER_COLORS.slice(0, settings.playerCount).some((color) => match.players[color].choice === "hex-player")) return null;
  if (match && !["territory-v2", "territory-v3"].includes(settings.rulesVersion)
    && PLAYER_COLORS.slice(0, settings.playerCount).some((color) => MULTIPLAYER_AI_CHOICES.includes(match.players[color]?.choice))) return null;

  return {
    format: LOCAL_GAME_SESSION_FORMAT,
    schemaVersion: LOCAL_GAME_SESSION_SCHEMA_VERSION,
    savedAt: Number.isFinite(Number(value.savedAt)) ? Number(value.savedAt) : 0,
    settings,
    actions,
    ...(match ? { match: { players: normalizeLocalPlayers(match.players, settings.playerCount, settings.boardShape), started: match.started, paused: match.paused,
      ...(match.undo ? { undo: normalizeUndoUsage(match.undo) } : {}),
    } } : {}),
  };
}

export function createLocalGameSession(settings, actions = [], match) {
  const normalizedSettings = normalizeSettings(settings);
  if (!normalizedSettings) {
    throw new Error("Cannot create a local game session without valid settings.");
  }

  const normalizedActions = actions.map(normalizeAction);
  if (normalizedActions.some((action) => !action)) {
    throw new Error("Cannot create a local game session with an invalid action.");
  }

  return {
    format: LOCAL_GAME_SESSION_FORMAT,
    schemaVersion: LOCAL_GAME_SESSION_SCHEMA_VERSION,
    savedAt: Date.now(),
    settings: normalizedSettings,
    actions: normalizedActions,
    ...(match ? { match: { players: normalizeLocalPlayers(match.players, normalizedSettings.playerCount, normalizedSettings.boardShape), started: Boolean(match.started), paused: Boolean(match.paused),
      ...(match.undo ? { undo: normalizeUndoUsage(match.undo) } : {}),
    } } : {}),
  };
}

export function appendLocalGameAction(session, action) {
  const current = normalizeSession(session);
  const nextAction = normalizeAction(action);
  if (!current || !nextAction) {
    return null;
  }

  return createLocalGameSession(current.settings, [...current.actions, nextAction], current.match);
}

export function sessionMatchesSettings(session, settings) {
  const normalizedSession = normalizeSession(session);
  const normalizedSettings = normalizeSettings(settings);
  if (!normalizedSession || !normalizedSettings) {
    return false;
  }

  return GAME_SETTING_KEYS.every((key) => normalizedSession.settings[key] === normalizedSettings[key])
    && JSON.stringify(startingPointSettings(normalizedSession.settings)) === JSON.stringify(startingPointSettings(normalizedSettings));
}

export function loadLocalGameSession(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem?.(LOCAL_GAME_SESSION_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    return normalizeSession(JSON.parse(raw));
  } catch (_error) {
    return null;
  }
}

export function persistLocalGameSession(session, storage = globalThis.localStorage) {
  const normalized = normalizeSession(session);
  if (!normalized || !storage?.setItem) {
    return false;
  }

  try {
    storage.setItem(LOCAL_GAME_SESSION_STORAGE_KEY, JSON.stringify(normalized));
    return true;
  } catch (_error) {
    return false;
  }
}

export function clearLocalGameSession(storage = globalThis.localStorage) {
  try {
    storage?.removeItem?.(LOCAL_GAME_SESSION_STORAGE_KEY);
    return true;
  } catch (_error) {
    return false;
  }
}

export function cloneLocalGameSession(session) {
  const normalized = normalizeSession(session);
  return normalized ? cloneJson(normalized) : null;
}
