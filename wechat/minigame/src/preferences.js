import { CONTROLLER_CHOICES, THREE_PLAYER_CONTROLLERS, HEX_PLAYER_CONTROLLERS, playerIds } from './controllers.js';
import { normalizePlayOptions } from './play-options.js';
import { resolveInitialPositions } from './core.js';

export const PLAY_MODES = ['ai-white', 'ai-black', 'human', 'three-human', 'ai-duel'];
const KEY = 'lifeline-wx-preferences-v1';
const defaults = () => ({ size: 7, mode: 'ai-white', difficulty: 'normal' });
function readDraftControllers(value, count) {
  if (value == null) return null;
  const known = new Set(count > 6 ? ['human', 'greedy', 'multiplayer-hard-v1'] : count === 2 ? CONTROLLER_CHOICES : ['greedy', ...(count === 3 ? THREE_PLAYER_CONTROLLERS : HEX_PLAYER_CONTROLLERS)]);
  const players = playerIds(count);
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== players.length
    || !players.every(player => known.has(value[player]))) throw new Error('INVALID_CONTROLLERS');
  // The per-count catalogs include legacy policies and the new Web difficulty
  // profiles. A shape/size edit (for example Medium on a non-native shape) may
  // leave seats awaiting explicit reselection. Preserve that draft on restart;
  // live games still enforce full compatibility without substituting a profile.
  return Object.fromEntries(players.map(player => [player, value[player]]));
}
function readBoardDraft(value, count, size) {
  const out = {};
  if (value.boardShape != null) {
    if (!['triangle', 'hexagon'].includes(value.boardShape)) throw new Error('INVALID_BOARD_SHAPE');
    out.boardShape = value.boardShape;
  }
  if (value.startingPointMode != null) {
    if (!['default', 'random', 'custom'].includes(value.startingPointMode)) throw new Error('INVALID_STARTS');
    out.startingPointMode = value.startingPointMode;
  }
  if (value.initialPositions != null) out.initialPositions = resolveInitialPositions(size, count, value.initialPositions, out.boardShape);
  if (count > 6 && (!out.startingPointMode || out.startingPointMode === 'default')) out.startingPointMode = 'random';
  if (out.startingPointMode === 'custom' && !out.initialPositions) throw new Error('INVALID_STARTS');
  return out;
}
function readPlayerDrafts(value, size) {
  const drafts = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return drafts;
  for (const count of Array.from({ length: 14 }, (_, index) => index + 2)) {
    try {
      const draft = value[count];
      if (!draft || typeof draft !== 'object' || Array.isArray(draft) || !PLAY_MODES.includes(draft.mode)
        || (draft.mode === 'three-human') !== (count === 3) || count >= 4 && draft.mode !== 'human') continue;
      const board = readBoardDraft(draft, count, size);
      const controllers = readDraftControllers(draft.controllers, count);
      if (!playerIds(count).includes(draft.startPlayer)) continue;
      drafts[count] = { mode: draft.mode, startPlayer: draft.startPlayer, controllers, ...board };
    } catch (_) { /* A damaged inactive draft must not discard the active preferences. */ }
  }
  return drafts;
}
export function readPreferences(storage) {
  try {
    const value = JSON.parse(storage.get(KEY) || '{}');
    if (Number.isInteger(value.size) && value.size >= 5 && value.size <= 15
      && PLAY_MODES.includes(value.mode) && ['easy', 'normal'].includes(value.difficulty)) {
      const players = value.playerCount ?? (value.mode === 'three-human' ? 3 : 2);
      if (!Number.isInteger(players) || players < 2 || players > 15 || (value.mode === 'three-human') !== (players === 3)
        || players >= 4 && value.mode !== 'human') return defaults();
      const startPlayer = playerIds(players).includes(value.startPlayer) ? value.startPlayer : 'BLACK';
      const board = readBoardDraft(value, players, value.size);
      const controllers = readDraftControllers(value.controllers, players);
      const playerDrafts = readPlayerDrafts(value.playerDrafts, value.size);
      return { size: value.size, mode: value.mode, difficulty: value.difficulty, ...board,
        ...(value.playerCount != null ? { playerCount: players } : {}),
        ...(startPlayer !== 'BLACK' ? { startPlayer } : {}), ...(controllers ? { controllers } : {}),
        ...(Object.keys(playerDrafts).length ? { playerDrafts } : {}),
        ...(value.terminology === 'war' ? { terminology: 'war' } : {}),
        ...(value.playOptions ? { playOptions: normalizePlayOptions(value.playOptions) } : {}) };
    }
  } catch (_) { /* Invalid preferences never prevent opening the game. */ }
  return defaults();
}
export function savePreferences(storage, value) { storage.set(KEY, JSON.stringify(value)); }
