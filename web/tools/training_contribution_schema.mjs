// Versioned anonymous collection contract. Keep this module browser/Worker safe.
// Actor roles and undo usage are client declarations, not proof of human play.
export const CONTRIBUTION_V2_POLICY = 'anonymous-replay-training-v2';
export const CONTRIBUTION_V2_MAX_ACTIONS = 3000;
export const CONTRIBUTION_V3_POLICY = 'anonymous-replay-training-v3';
export const CONTRIBUTION_V3_MAX_ACTIONS = 3000;
const COLORS = ['BLACK', 'WHITE', 'PURPLE', 'GREEN', 'ORANGE', 'CYAN'];
const V3_COLORS = [...COLORS, 'PINK', 'BROWN', 'LIME', 'NAVY', 'GOLD', 'TEAL', 'MAGENTA', 'SLATE', 'CORAL'];
const ALL_SIZES = Array.from({ length: 11 }, (_, index) => index + 5);
const TWO_PLAYER_MODELS = [
  ...['padded-cnn', 'grid-gnn', 'topology-gnn'].flatMap(name => [
    ...['2026092201', '2026092202', '2026092203'].map(seed => `model:${name}-transfer-v1-seed${seed}`),
    `model:${name}-d14-s20260825-g200`,
  ]),
  ...['dqn', 'ppo', 'sac'].map(name => `model:${name}-all-sizes-e2000`),
  ...['gail', 'gan'].map(name => `model:${name}-all-sizes`),
];
const MULTIPLAYER_MODELS = [
  { profile: 'three-player-policy-v1', counts: [3], sizes: ALL_SIZES },
  { profile: 'three-player-policy-v2', counts: [3], sizes: ALL_SIZES },
  { profile: 'three-player-search-v4-round12', counts: [3], sizes: [5, 7, 9] },
  { profile: 'hex-player-policy-v1', counts: [4, 5, 6], sizes: ALL_SIZES },
  { profile: 'hex-player-search-v5', counts: [4, 5, 6], sizes: [5, 7] },
];

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value, keys) {
  return record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

export function contributionProfileChoices(config) {
  const { playerCount, gridSize, rulesVersion } = config ?? {};
  const defaultShape = playerCount >= 4 ? 'hexagon' : 'triangle';
  const boardShape = config?.boardShape ?? defaultShape;
  if (!Number.isInteger(playerCount) || playerCount < 2 || playerCount > 6
    || !Number.isInteger(gridSize) || gridSize < 5 || gridSize > 15
    || rulesVersion !== 'territory-v2' || !['triangle', 'hexagon'].includes(boardShape)) return [];
  const nativeShape = boardShape === defaultShape;
  if (playerCount === 2) return nativeShape
    ? ['human', 'greedy', 'minimax-2', 'minimax-3', 'minimax-4', ...TWO_PLAYER_MODELS] : ['human', 'greedy'];
  // Keep the legacy profile matrix intact. The new easy/hard tiers also run on
  // nonstandard shapes; medium retains the Web runtime's native-shape gate.
  const levels = ['multiplayer-easy-v1', ...(nativeShape ? ['multiplayer-medium-v1'] : []), 'multiplayer-hard-v1'];
  if (!nativeShape) return ['human', 'greedy', ...levels];
  return ['human', ...MULTIPLAYER_MODELS.filter(item => item.counts.includes(playerCount) && item.sizes.includes(gridSize)).map(item => item.profile), ...levels];
}

// Protocol v3 is a separate consent and storage contract. Keep the frozen v2
// selector above byte-for-byte in behavior instead of broadening it to v3.
export function contributionV3ProfileChoices(config) {
  const { playerCount, gridSize, rulesVersion } = config ?? {};
  const defaultShape = playerCount >= 4 ? 'hexagon' : 'triangle';
  const boardShape = config?.boardShape ?? defaultShape;
  if (!Number.isInteger(playerCount) || playerCount < 2 || playerCount > 15
    || !Number.isInteger(gridSize) || gridSize < 5 || gridSize > 15
    || rulesVersion !== 'territory-v3' || !['triangle', 'hexagon'].includes(boardShape)) return [];
  const nativeShape = boardShape === defaultShape;
  if (playerCount > 6) return ['human', 'greedy', 'multiplayer-easy-v1', 'multiplayer-hard-v1'];
  if (playerCount === 2) return nativeShape
    ? ['human', 'greedy', 'minimax-2', 'minimax-3', 'minimax-4', ...TWO_PLAYER_MODELS] : ['human', 'greedy'];
  const levels = ['multiplayer-easy-v1', ...(nativeShape ? ['multiplayer-medium-v1'] : []), 'multiplayer-hard-v1'];
  if (!nativeShape) return ['human', 'greedy', ...levels];
  return ['human', ...MULTIPLAYER_MODELS.filter(item => item.counts.includes(playerCount) && item.sizes.includes(gridSize)).map(item => item.profile), ...levels];
}

export function normalizeV2Context(context, config) {
  if (!exactKeys(context, ['source', 'actors', 'mixedProfiles', 'hintsEnabled', 'undo'])
    || context.source !== 'local' || typeof context.mixedProfiles !== 'boolean'
    || typeof context.hintsEnabled !== 'boolean' || context.hintsEnabled !== config?.hintEnabled) {
    throw new Error('Invalid v2 anonymous context');
  }
  const choices = contributionProfileChoices(config);
  const colors = COLORS.slice(0, config?.playerCount);
  if (!choices.length || !exactKeys(context.actors, colors)) throw new Error('Invalid v2 actor seats');
  const actors = Object.fromEntries(colors.map(color => {
    const actor = context.actors[color];
    if (exactKeys(actor, ['kind']) && actor.kind === 'human') return [color, { kind: 'human' }];
    if (exactKeys(actor, ['kind', 'profile']) && actor.kind === 'ai'
      && actor.profile !== 'human' && choices.includes(actor.profile)) return [color, { kind: 'ai', profile: actor.profile }];
    throw new Error('Invalid or unsupported v2 actor profile');
  }));
  const undo = context.undo;
  if (!exactKeys(undo, ['enabled', 'maxCount', 'usedCount']) || typeof undo.enabled !== 'boolean'
    || !Number.isInteger(undo.maxCount) || undo.maxCount < 1 || undo.maxCount > 10
    || !Number.isInteger(undo.usedCount) || undo.usedCount < 0 || undo.usedCount > undo.maxCount
    || (!undo.enabled && undo.usedCount !== 0)) throw new Error('Invalid v2 undo declaration');
  return { source: 'local', actors, mixedProfiles: context.mixedProfiles, hintsEnabled: context.hintsEnabled,
    undo: { enabled: undo.enabled, maxCount: undo.maxCount, usedCount: undo.usedCount } };
}

export function normalizeV3Context(context, config) {
  if (!exactKeys(context, ['source', 'actors', 'mixedProfiles', 'hintsEnabled', 'undo'])
    || context.source !== 'local' || typeof context.mixedProfiles !== 'boolean'
    || typeof context.hintsEnabled !== 'boolean' || context.hintsEnabled !== config?.hintEnabled) {
    throw new Error('Invalid v3 anonymous context');
  }
  const choices = contributionV3ProfileChoices(config);
  const colors = V3_COLORS.slice(0, config?.playerCount);
  if (!choices.length || !exactKeys(context.actors, colors)) throw new Error('Invalid v3 actor seats');
  const actors = Object.fromEntries(colors.map(color => {
    const actor = context.actors[color];
    if (exactKeys(actor, ['kind']) && actor.kind === 'human') return [color, { kind: 'human' }];
    if (exactKeys(actor, ['kind', 'profile']) && actor.kind === 'ai'
      && actor.profile !== 'human' && choices.includes(actor.profile)) return [color, { kind: 'ai', profile: actor.profile }];
    throw new Error('Invalid or unsupported v3 actor profile');
  }));
  const undo = context.undo;
  if (!exactKeys(undo, ['enabled', 'maxCount', 'usedCount']) || typeof undo.enabled !== 'boolean'
    || !Number.isInteger(undo.maxCount) || undo.maxCount < 1 || undo.maxCount > 10
    || !Number.isInteger(undo.usedCount) || undo.usedCount < 0 || undo.usedCount > undo.maxCount
    || (!undo.enabled && undo.usedCount !== 0)) throw new Error('Invalid v3 undo declaration');
  return { source: 'local', actors, mixedProfiles: context.mixedProfiles, hintsEnabled: context.hintsEnabled,
    undo: { enabled: undo.enabled, maxCount: undo.maxCount, usedCount: undo.usedCount } };
}
