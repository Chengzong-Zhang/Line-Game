import GameEngine from "./GameEngine.js?v=20261025-unified1";

// Ask the rule engine for actors: automatic skips can change the turn order.
const COLORS = ["BLACK", "WHITE", "PURPLE", "GREEN", "ORANGE", "CYAN"];
export const UNDO_MAX_COUNT_MIN = 1;
export const UNDO_MAX_COUNT_MAX = 10;
export const DEFAULT_UNDO_MAX_COUNT = 3;

export function normalizeUndoUsage(value = {}) {
  return {
    usedCount: Number.isInteger(value?.usedCount) && value.usedCount >= 0 ? value.usedCount : 0,
    blockedPlayers: COLORS.filter((color) => Array.isArray(value?.blockedPlayers) && value.blockedPlayers.includes(color)),
  };
}

export function recordUndoAction(usage, player) {
  const next = normalizeUndoUsage(usage);
  next.blockedPlayers = next.blockedPlayers.filter((color) => color !== player);
  return next;
}

export function localUndoTimeline(settings, actions) {
  return createLocalUndoTimeline()(settings, actions);
}

// One private recorder per UI. Nothing here mutates the controller's engine.
// An unchanged prefix is already validated; append only the new actions.
// Rewinds, edited history and settings changes rebuild from the initial state.
export function createLocalUndoTimeline() {
  let engine = null, settingsKey = null, actionKeys = [], timeline = [];
  return (settings, actions) => {
    const nextSettingsKey = JSON.stringify(settings);
    const nextActionKeys = actions.map(action => JSON.stringify(action));
    if (!engine || settingsKey !== nextSettingsKey || actionKeys.length > actions.length
      || actionKeys.some((key, index) => key !== nextActionKeys[index])) {
      engine = new GameEngine({ ...settings, deferTerritoryUpdates: true });
      settingsKey = nextSettingsKey;
      actionKeys = [];
      timeline = [];
    }
    // Only actor order is needed. Use the same play/skip/resign path and auto
    // skips as replayBatch, without its final territory or UI snapshot work.
    const candidate = engine;
    candidate._isReplayingBatch = true;
    try {
      for (let index = actionKeys.length; index < actions.length; index++) {
        const action = actions[index];
        const player = action.type === "player_resign" ? action.color : candidate.currentPlayer;
        const result = action.type === "player_move" ? candidate.playMove(action.point)
          : action.type === "player_skip" ? candidate.skipTurn()
            : action.type === "player_resign" ? candidate.resignPlayer(action.color) : null;
        if (!result?.success) { engine = null; return null; }
        timeline.push({ player, type: action.type });
      }
      actionKeys = nextActionKeys;
      return timeline.map(action => ({ ...action }));
    } catch (error) {
      engine = null;
      throw error;
    } finally { candidate._isReplayingBatch = false; }
  };
}

export function planLocalUndo({ settings, actions, players, currentPlayer, usage, timeline = localUndoTimeline(settings, actions) }) {
  const humans = COLORS.slice(0, settings.playerCount).filter((color) => players[color]?.choice === "human");
  if (!humans.length || !timeline) return null;
  // During an AI reply, the last human who acted can still take that move back.
  const player = humans.includes(currentPlayer) ? currentPlayer
    : [...timeline].reverse().find((action) => humans.includes(action.player))?.player;
  if (!player || normalizeUndoUsage(usage).blockedPlayers.includes(player)) return null;
  const index = timeline.findLastIndex((action) => action.player === player);
  if (index < 0 || timeline[index].type !== "player_move") return null;
  return { player, actionIndex: index, affectedPlayers: [...new Set(timeline.slice(index).map((action) => action.player))] };
}

export function consumeLocalUndo(usage, plan) {
  const next = normalizeUndoUsage(usage);
  return { usedCount: next.usedCount + 1, blockedPlayers: [...new Set([...next.blockedPlayers, ...plan.affectedPlayers])] };
}
