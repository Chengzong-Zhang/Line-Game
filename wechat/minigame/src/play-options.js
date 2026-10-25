import { PLAYER_ORDER } from './core.js';

export const DEFAULT_PLAY_OPTIONS = Object.freeze({ turnTimerEnabled: false, turnTimeLimitSeconds: 60,
  hintEnabled: true, hintMaxCount: 3, undoEnabled: false, undoMaxCount: 3 });

// Match the Web options without importing its UI/state module into the game.
export function normalizePlayOptions(value = {}) {
  const result = { ...DEFAULT_PLAY_OPTIONS };
  for (const key of Object.keys(result)) if (value[key] !== undefined) result[key] = value[key];
  if (typeof result.turnTimerEnabled !== 'boolean' || typeof result.hintEnabled !== 'boolean'
    || typeof result.undoEnabled !== 'boolean' || !Number.isInteger(result.undoMaxCount) || result.undoMaxCount < 1 || result.undoMaxCount > 10
    || !Number.isInteger(result.turnTimeLimitSeconds) || result.turnTimeLimitSeconds < 15 || result.turnTimeLimitSeconds > 200
    // Existing friend rooms explicitly encode disabled hints with a zero budget.
    || !Number.isInteger(result.hintMaxCount) || result.hintMaxCount < (result.hintEnabled ? 1 : 0) || result.hintMaxCount > 10) {
    throw new Error('INVALID_PLAY_OPTIONS');
  }
  return result;
}

export function validateUndoUsage(value, settings) {
  if (value == null) return { usedCount: 0, blockedPlayers: [] };
  const players = PLAYER_ORDER.slice(0, settings.playerCount);
  if (typeof value !== 'object' || Array.isArray(value) || !Number.isInteger(value.usedCount)
    || value.usedCount < 0 || value.usedCount > normalizePlayOptions(settings).undoMaxCount
    || !Array.isArray(value.blockedPlayers) || new Set(value.blockedPlayers).size !== value.blockedPlayers.length
    || value.blockedPlayers.some(player => !players.includes(player))) throw new Error('INVALID_UNDO_USAGE');
  return { usedCount: value.usedCount, blockedPlayers: [...value.blockedPlayers] };
}

export function validatePlayProgress(value, settings) {
  const options = normalizePlayOptions(settings), full = options.turnTimeLimitSeconds * 1000;
  if (value == null) return { remainingMs: full, hintsUsed: 0 };
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2
    || !Number.isFinite(value.remainingMs) || value.remainingMs < 0 || value.remainingMs > full
    || !Number.isInteger(value.hintsUsed) || value.hintsUsed < 0 || value.hintsUsed > options.hintMaxCount) {
    throw new Error('INVALID_PLAY_PROGRESS');
  }
  return { remainingMs: value.remainingMs, hintsUsed: value.hintsUsed };
}
