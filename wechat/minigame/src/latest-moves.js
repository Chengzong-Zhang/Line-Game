import { GameEngine, PLAYER_ORDER } from './core.js';
import { applyAction } from './state.js';

const nodeState = player => PLAYER_ORDER.indexOf(player) * 2 + 1;
const actionType = action => ({ player_move: 'move', player_skip: 'skip', player_resign: 'resign' }[action?.type] || action?.type);

// Saved/reconnected logs may omit actors, and no-legal-move passes are implicit.
// Replay privately through the rules, incrementally, to recover both exactly.
// Rewinds and replaced logs rebuild this cache; no live engine is ever changed.
export function createLatestMoveTracker() {
  let engine = null, settingsKey = null, actionKeys = [], latest = {}, previousActions = null;
  let checkedSnapshot = null, snapshotMatches = false;
  return (settings, actions, snapshot, cursor = actions?.length) => {
    if (!settings || !Array.isArray(actions) || !snapshot || !Number.isInteger(cursor)) return {};
    const length = Math.max(0, Math.min(actions.length, cursor));
    const nextSettingsKey = JSON.stringify(settings);
    // GameSession replaces its action array on every accepted mutation. Timer,
    // pan and overlay redraws reuse it, so they need no log serialization.
    const nextActionKeys = engine && settingsKey === nextSettingsKey && previousActions === actions && actionKeys.length === length
      ? actionKeys : actions.slice(0, length).map(action => JSON.stringify(action));
    try {
      if (!engine || settingsKey !== nextSettingsKey || actionKeys.length > length
        || actionKeys.some((key, index) => key !== nextActionKeys[index])) {
        engine = new GameEngine({ ...settings, deferTerritoryUpdates: true });
        settingsKey = nextSettingsKey; actionKeys = []; latest = {}; checkedSnapshot = null;
        const hasValidMoves = engine._hasValidMoves;
        engine._hasValidMoves = function (player) {
          const available = hasValidMoves.call(this, player);
          if (!available) delete latest[player];
          return available;
        };
      }
      engine._isReplayingBatch = true;
      for (let index = actionKeys.length; index < length; index++) {
        checkedSnapshot = null;
        const action = actions[index], type = actionType(action);
        const player = type === 'resign' ? action.player || action.color : engine.currentPlayer;
        if (type === 'move') latest[player] = engine.isTopologyBoard ? action.vertexId : [...action.point];
        else delete latest[player];
        if (!applyAction(engine, action)?.success) throw new Error('INVALID_ACTION');
        // Once a marked node is cut away, never recover an older surviving node
        // or revive the marker merely because that coordinate is occupied later.
        for (const [owner, point] of Object.entries(latest)) {
          if (engine.resignedPlayers.has(owner) || engine.getStateAt(point) !== nodeState(owner)) delete latest[owner];
        }
      }
      actionKeys = nextActionKeys;
      previousActions = actions;
      const resigned = snapshot.resignedPlayers || [];
      if (engine.isTopologyBoard) {
        // A partial/old log must not manufacture markers for a different state.
        const board = snapshot.boardStates;
        // Session snapshots are immutable and shared across redraws. Validate a
        // new snapshot once, not on every animation frame.
        if (checkedSnapshot !== snapshot) {
          const replay = engine.getSnapshot();
          snapshotMatches = Boolean(board) && snapshot.positionRevision === replay.positionRevision
            && Object.keys(board).length === Object.keys(replay.boardStates).length
            && !Object.entries(replay.boardStates).some(([id, state]) => board[id] !== state)
            && snapshot.currentPlayer === replay.currentPlayer
            && JSON.stringify(resigned) === JSON.stringify(replay.resignedPlayers);
          checkedSnapshot = snapshot;
        }
        if (!snapshotMatches) return {};
        return Object.fromEntries(Object.entries(latest).filter(([player, id]) => snapshot.players.includes(player)
          && !resigned.includes(player) && board[id] === nodeState(player)));
      }
      return Object.fromEntries(Object.entries(latest).filter(([player, [x, y]]) => snapshot.players.includes(player)
        && !resigned.includes(player) && snapshot.boardMatrix[y]?.[x] === nodeState(player))
        .map(([player, point]) => [player, [...point]]));
    } catch (_) {
      engine = null; actionKeys = []; latest = {}; previousActions = null; checkedSnapshot = null;
      return {};
    } finally { if (engine) engine._isReplayingBatch = false; }
  };
}
