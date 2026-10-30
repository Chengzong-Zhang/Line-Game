import { ALL_LOCAL_PLAYER_CHOICES, MULTIPLAYER_AI_CHOICES, normalizeLocalPlayers, usesGenericBoardAI } from "./LocalAIModes.js?v=20261029-unified-r1";
import { startingPointSettings } from "./StartingPoints.js?v=20261029-unified-r1";
import { PLAYER_ORDER, StartProtectionRule, resolveBoardShape } from "./GameEngine.js?v=20261029-unified-r1";
import { normalizeUndoUsage } from "./LocalUndo.js?v=20261029-unified-r1";
import { decodeTopologyState } from "./TopologyStateCodec.js?v=20261029-unified-r1";

const LOCAL_GAME_SESSION_FORMAT = "lifeline-local-session";
const PLAYER_COLORS = PLAYER_ORDER;
export const LOCAL_GAME_SESSION_SCHEMA_VERSION = 2;
export const LOCAL_GAME_SESSION_STORAGE_KEY = "lifeline-local-game-session-v1";
export const TOPOLOGY_LOCAL_GAME_SESSION_FORMAT = "lifeline-topology-local-session";
export const TOPOLOGY_LOCAL_GAME_SESSION_SCHEMA_VERSION = 1;
export const TOPOLOGY_LOCAL_GAME_SESSION_STORAGE_KEY = "lifeline-topology-local-game-session-v1";

const GAME_SETTING_KEYS = Object.freeze([
  "playerCount",
  "boardShape",
  "gridSize",
  "startPlayer",
  "turnOrder",
  "rulesVersion",
  "rootMode",
  "rootRulesVersion",
  "protectionRule",
  "turnTimerEnabled",
  "turnTimeLimitSeconds",
  "hintEnabled",
  "hintMaxCount",
  "undoEnabled",
  "undoMaxCount",
]);

// A topology state owns its board identity, starts and rules, but it does not
// encode local-only controls such as undo allowance or hint/timer preferences.
// Keep exactly those primitive controls in the session envelope; never trust
// the envelope to replace the canonical topology definition.
const TOPOLOGY_SESSION_SETTING_KEYS = Object.freeze([
  "gridSize",
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
  if (normalized.turnOrder !== undefined) {
    const players = PLAYER_COLORS.slice(0, normalized.playerCount), order = normalized.turnOrder;
    if (!Array.isArray(order) || order.length !== players.length || new Set(order).size !== players.length
      || !order.every(player => players.includes(player)) || order[0] !== normalized.startPlayer) return null;
    normalized.turnOrder = [...order];
  }
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

  if (["root_relocate", "player_root_relocate", "root_add", "player_root_add"].includes(action.type)) {
    const point = normalizePoint(action.point);
    if (!point) return null;
    const type = action.type.includes("relocate") ? "player_root_relocate" : "player_root_add";
    return { type, point };
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
  if (value.format !== LOCAL_GAME_SESSION_FORMAT || ![1, LOCAL_GAME_SESSION_SCHEMA_VERSION].includes(value.schemaVersion)) {
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

  return GAME_SETTING_KEYS.every((key) => key === "turnOrder"
    ? JSON.stringify(normalizedSession.settings[key]) === JSON.stringify(normalizedSettings[key])
    : normalizedSession.settings[key] === normalizedSettings[key])
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

function normalizeTopologySessionAction(action, sampleIds) {
  if (!action || typeof action !== "object") return null;
  const type = action.type === "player_move" || action.type === "move" ? "player_move"
    : action.type === "player_skip" || action.type === "skip" ? "player_skip"
      : action.type === "player_resign" || action.type === "resign" ? "player_resign" : null;
  if (!type) return null;
  if (type === "player_move") {
    const vertexId = action.vertexId ?? action.point;
    return typeof vertexId === "string" && sampleIds.has(vertexId)
      ? { type, vertexId } : null;
  }
  if (type === "player_resign") {
    const color = action.color ?? action.player;
    return typeof color === "string" ? { type, color } : null;
  }
  return { type };
}

function normalizeTopologySessionMetadata(value, decoded, actions) {
  const playerCount = Object.keys(decoded.ruleState.startingVertices ?? {}).length;
  const activePlayers = PLAYER_COLORS.slice(0, playerCount);
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const matchSource = source.match && typeof source.match === "object" && !Array.isArray(source.match)
    ? source.match : {};
  const playersSource = matchSource.players && typeof matchSource.players === "object"
    && !Array.isArray(matchSource.players) ? matchSource.players : {};
  const players = {};
  for (const color of activePlayers) {
    const entry = playersSource[color];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const normalized = {};
    if (typeof entry.choice === "string") normalized.choice = entry.choice;
    if (Number.isInteger(entry.depth)) normalized.depth = entry.depth;
    if (typeof entry.version === "string") normalized.version = entry.version;
    if (Object.keys(normalized).length) players[color] = normalized;
  }
  const settingsSource = source.settings && typeof source.settings === "object"
    && !Array.isArray(source.settings) ? source.settings : {};
  const settings = {};
  for (const key of TOPOLOGY_SESSION_SETTING_KEYS) {
    const current = settingsSource[key];
    if ((key === "gridSize" && Number.isInteger(current) && current >= 5 && current <= 15)
      || (key.endsWith("Enabled") && typeof current === "boolean")
      || (key !== "gridSize" && !key.endsWith("Enabled") && Number.isFinite(current))) {
      settings[key] = current;
    }
  }
  return {
    // Old topology session v1 files did not retain this metadata. Their
    // historical default was BLACK; retain that safe interpretation instead
    // of guessing from a later currentPlayer value.
    startPlayer: activePlayers.includes(source.startPlayer) ? source.startPlayer : activePlayers[0],
    settings,
    match: {
      players,
      started: typeof matchSource.started === "boolean" ? matchSource.started : actions.length > 0,
      paused: Boolean(matchSource.paused),
      undo: normalizeUndoUsage(matchSource.undo),
    },
  };
}

function normalizeTopologySession(value) {
  if (!value || typeof value !== "object"
    || value.format !== TOPOLOGY_LOCAL_GAME_SESSION_FORMAT
    || value.schemaVersion !== TOPOLOGY_LOCAL_GAME_SESSION_SCHEMA_VERSION) {
    return null;
  }
  let decoded;
  try {
    decoded = decodeTopologyState(value.topologyState);
  } catch (_) {
    return null;
  }
  if (value.boardHash !== decoded.boardHash || !Array.isArray(value.actions)) return null;
  const sampleIds = new Set(decoded.board.sampleIds);
  const actions = value.actions.map((action) => normalizeTopologySessionAction(action, sampleIds));
  if (actions.some((action) => !action)) return null;
  const metadata = normalizeTopologySessionMetadata(value, decoded, actions);
  return {
    format: TOPOLOGY_LOCAL_GAME_SESSION_FORMAT,
    schemaVersion: TOPOLOGY_LOCAL_GAME_SESSION_SCHEMA_VERSION,
    savedAt: Number.isFinite(Number(value.savedAt)) ? Number(value.savedAt) : 0,
    boardHash: decoded.boardHash,
    topologyState: cloneJson(value.topologyState),
    actions,
    ...metadata,
  };
}

/**
 * Persisted topology sessions contain a complete, independently validated
 * topology state. They intentionally use a separate key/schema so an older
 * coordinate-only local session remains untouched.
 */
export function createTopologyLocalGameSession(topologyState, actions = [], metadata = {}) {
  let decoded;
  try {
    decoded = decodeTopologyState(topologyState);
  } catch (error) {
    throw new Error("Cannot create topology local session: " + (error.code ?? error.message));
  }
  const sampleIds = new Set(decoded.board.sampleIds);
  const normalizedActions = actions.map((action) => normalizeTopologySessionAction(action, sampleIds));
  if (normalizedActions.some((action) => !action)) {
    throw new Error("Cannot create topology local session with an invalid action.");
  }
  const normalizedMetadata = normalizeTopologySessionMetadata(metadata, decoded, normalizedActions);
  return {
    format: TOPOLOGY_LOCAL_GAME_SESSION_FORMAT,
    schemaVersion: TOPOLOGY_LOCAL_GAME_SESSION_SCHEMA_VERSION,
    savedAt: Date.now(),
    boardHash: decoded.boardHash,
    topologyState: cloneJson(topologyState),
    actions: normalizedActions,
    ...normalizedMetadata,
  };
}

export function appendTopologyLocalGameAction(session, action, topologyState = session?.topologyState, metadata = session) {
  const current = normalizeTopologySession(session);
  if (!current) return null;
  let decoded;
  try {
    decoded = decodeTopologyState(topologyState);
  } catch (_) {
    return null;
  }
  if (decoded.boardHash !== current.boardHash) return null;
  const nextAction = normalizeTopologySessionAction(action, new Set(decoded.board.sampleIds));
  if (!nextAction) return null;
  return createTopologyLocalGameSession(topologyState, [...current.actions, nextAction], metadata);
}

export function loadTopologyLocalGameSession(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem?.(TOPOLOGY_LOCAL_GAME_SESSION_STORAGE_KEY);
    return raw ? normalizeTopologySession(JSON.parse(raw)) : null;
  } catch (_) {
    return null;
  }
}

export function persistTopologyLocalGameSession(session, storage = globalThis.localStorage) {
  const normalized = normalizeTopologySession(session);
  if (!normalized || !storage?.setItem) return false;
  try {
    storage.setItem(TOPOLOGY_LOCAL_GAME_SESSION_STORAGE_KEY, JSON.stringify(normalized));
    return true;
  } catch (_) {
    return false;
  }
}

export function clearTopologyLocalGameSession(storage = globalThis.localStorage) {
  try {
    storage?.removeItem?.(TOPOLOGY_LOCAL_GAME_SESSION_STORAGE_KEY);
    return true;
  } catch (_) {
    return false;
  }
}

export function topologySessionMatchesBoard(session, boardHash) {
  const normalized = normalizeTopologySession(session);
  return Boolean(normalized && typeof boardHash === "string" && normalized.boardHash === boardHash);
}
