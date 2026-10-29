import { PLAYER_ORDER } from './core.js';
import { MODEL_CATALOG, MULTIPLAYER_AI_CATALOG } from './model-catalog.js';
export const BASIC_CONTROLLERS = ['human', 'greedy', 'minimax-2', 'minimax-3', 'minimax-4'];
export const CONTROLLER_CHOICES = [...BASIC_CONTROLLERS, ...MODEL_CATALOG.map(model => model.profile)];
export const THREE_PLAYER_PROFILE = 'three-player-policy-v1';
export const THREE_PLAYER_CONTROLLERS = ['human', ...MULTIPLAYER_AI_CATALOG.filter(item => item.playerCounts.includes(3)).map(item => item.profile)];
export const HEX_PLAYER_PROFILE = 'hex-player-policy-v1';
export const HEX_PLAYER_CONTROLLERS = ['human', ...MULTIPLAYER_AI_CATALOG.filter(item => item.playerCounts.includes(4)).map(item => item.profile)];
export function playerIds(playerCount = 2) {
  return Number.isInteger(playerCount) && playerCount >= 2 && playerCount <= PLAYER_ORDER.length ? PLAYER_ORDER.slice(0, playerCount) : [];
}
function contextFor(countOrSettings = 2, options = {}) {
  const settings = typeof countOrSettings === 'object' && countOrSettings !== null ? { ...countOrSettings, ...options }
    : { playerCount: countOrSettings, ...options };
  const playerCount = settings.playerCount ?? 2;
  return { playerCount, gridSize: settings.gridSize ?? 9, rootMode: settings.rootMode ?? 'classic',
    boardShape: settings.boardShape ?? (playerCount >= 4 ? 'hexagon' : 'triangle'), rulesVersion: settings.rulesVersion ?? 'territory-v3' };
}
export function controllerChoices(countOrSettings = 2, options = {}) {
  const { playerCount, boardShape, gridSize, rulesVersion, rootMode } = contextFor(countOrSettings, options);
  if (!playerIds(playerCount).length || !['triangle', 'diamond', 'hexagon'].includes(boardShape)
    || !Number.isInteger(gridSize) || gridSize < 5 || gridSize > 15 || !['territory-v2', 'territory-v3'].includes(rulesVersion)) return [];
  if (rootMode !== 'classic') return playerCount === 2 && rulesVersion === 'territory-v3' ? BASIC_CONTROLLERS : [];
  if (boardShape === 'diamond') return playerCount === 2
    ? ['human', 'minimax-2', 'minimax-3', 'minimax-4']
    : ['human', 'greedy', 'multiplayer-hard-v1'];
  if (playerCount > 6) return ['human', 'greedy', 'multiplayer-hard-v1'];
  const nativeShape = boardShape === (playerCount >= 4 ? 'hexagon' : 'triangle');
  if (playerCount === 2 && !nativeShape) return ['human', 'greedy'];
  if (playerCount === 2) return CONTROLLER_CHOICES.filter(profile => {
    const model = MODEL_CATALOG.find(item => item.profile === profile);
    const range = model?.spec.browser_inference?.board_size_range ?? [5, 15];
    return !model || gridSize >= range[0] && gridSize <= range[1];
  });
  return ['human', ...(!nativeShape ? ['greedy'] : []), ...MULTIPLAYER_AI_CATALOG.filter(item => item.playerCounts.includes(playerCount)
    && item.sizes.includes(gridSize) && (item.boardShapes
      ? item.boardShapes.includes(boardShape) && (!item.nativeShapeOnly || nativeShape)
      : item.boardShape === boardShape)).map(item => item.profile)];
}
// Product choices are intentionally narrower than accepted controller IDs.
// Saves, replays, Worker requests and the experiment picker still use controllerChoices.
export function normalControllerChoices(countOrSettings = 2, options = {}) {
  const { playerCount, boardShape } = contextFor(countOrSettings, options);
  const available = controllerChoices(countOrSettings, options);
  if (playerCount === 2) return available.filter(profile =>
    profile === 'human' || (['triangle', 'diamond'].includes(boardShape) ? /^minimax-[234]$/.test(profile) : profile === 'greedy'));
  if (boardShape === 'diamond') return available.filter(profile =>
    ['human', 'greedy', 'multiplayer-hard-v1'].includes(profile));
  return available.filter(profile => profile === 'human' ||
    (playerCount > 6 ? ['greedy', 'multiplayer-hard-v1'].includes(profile)
      : ['multiplayer-easy-v1', 'multiplayer-medium-v1', 'multiplayer-hard-v1'].includes(profile)));
}

export function experimentControllerChoices(countOrSettings = 2, options = {}) {
  const normal = new Set(normalControllerChoices(countOrSettings, options));
  return controllerChoices(countOrSettings, options).filter(profile => profile !== 'human' && profile !== 'greedy' && !normal.has(profile));
}
export function defaultAIProfile(countOrSettings = 2, options = {}) {
  const settings = contextFor(countOrSettings, options), choices = controllerChoices(settings);
  if (!choices.length) throw new Error('INVALID_CONTROLLERS');
  if (settings.boardShape === 'diamond') {
    if (settings.playerCount === 2) return 'minimax-2';
    if (settings.playerCount > 6) return 'multiplayer-hard-v1';
    if (choices.includes('greedy')) return 'greedy';
  }
  if (choices.includes('greedy') && settings.boardShape !== (settings.playerCount >= 4 ? 'hexagon' : 'triangle')) return 'greedy';
  if (settings.playerCount > 6) return 'multiplayer-hard-v1';
  if (settings.playerCount === 2) return 'minimax-2';
  if (settings.playerCount === 3) return choices.includes('three-player-search-v4-round12') ? 'three-player-search-v4-round12' : THREE_PLAYER_PROFILE;
  return HEX_PLAYER_PROFILE;
}
export function presetControllers(mode = 'ai-white', difficulty = 'simple', countOrSettings = 2, options = {}) {
  const settings = contextFor(countOrSettings, options), { playerCount } = settings;
  // Legacy multiplayer saves without explicit controllers always remain human.
  if (playerCount > 2) return Object.fromEntries(playerIds(playerCount).map(player => [player, 'human']));
  // easy/normal are preserved for existing saves without explicit controllers.
  const ai = ({ easy: 'greedy', normal: 'minimax-2', simple: 'minimax-2', medium: 'minimax-3', hard: 'minimax-4' })[difficulty]
    || defaultAIProfile(settings);
  const supportedAI = controllerChoices(settings).includes(ai) ? ai : defaultAIProfile(settings);
  return { BLACK: ['ai-black', 'ai-duel'].includes(mode) ? supportedAI : 'human',
    WHITE: ['ai-white', 'ai-duel'].includes(mode) ? supportedAI : 'human' };
}
export function validateControllers(value, countOrSettings = 2, options = {}) {
  if (value == null) return null;
  const { playerCount } = contextFor(countOrSettings, options);
  const players = playerIds(playerCount);
  const choices = controllerChoices(countOrSettings, options);
  if (!players.length || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== players.length || !players.every(player => choices.includes(value[player]))) {
    throw new Error('INVALID_CONTROLLERS');
  }
  return Object.fromEntries(players.map(player => [player, value[player]]));
}
export function controllersMode(value) {
  // Preserve the existing save-mode vocabulary; explicit seats decide multiplayer turns.
  if (Object.prototype.hasOwnProperty.call(value, 'PURPLE')) return 'human';
  const blue = value.BLACK !== 'human', red = value.WHITE !== 'human';
  return blue && red ? 'ai-duel' : blue ? 'ai-black' : red ? 'ai-white' : 'human';
}
