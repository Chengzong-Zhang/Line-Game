import { compileBoard } from './BoardCompiler.js?v=20261029-unified-r1';
import { compareStableIdentifiers } from './BoardDefinition.js?v=20261029-unified-r1';

const PLAYERS = ['BLACK', 'WHITE', 'PURPLE', 'GREEN', 'ORANGE', 'CYAN'];
export const MAX_TOPOLOGY_ROOTS_PER_PLAYER = 6;
const array = (value) => Array.isArray(value) ? value : value == null ? [] : [value];
const fail = (code, detail = '') => { const error = new Error(`${code}${detail ? ': ' + detail : ''}`); error.code = code; throw error; };

// Call only when the user commits a new local match, never during restore,
// replay, undo, or draft preview. A fresh definition changes the rule/hash;
// the saved definition, roots, geometry and historical paths remain untouched.
export function prepareTopologyNewMatchSettings(settings) {
  const definition = settings?.boardDefinition;
  const strategy = definition?.topology?.movementStrategy ?? 'simple-rays-v1';
  if (!definition || !['simple-rays-v1', 'simple-rays-v2'].includes(strategy)) return settings;
  const candidate = JSON.parse(JSON.stringify(definition));
  candidate.topology = { ...candidate.topology, movementStrategy: 'simple-rays-v3' };
  const result = compileBoard(candidate);
  if (!result.ok) fail('INVALID_NEW_MATCH_TOPOLOGY', result.errors.map(error => `${error.code}@${error.location}`).join(', '));
  return { ...settings, boardDefinition: result.value.definition, boardHash: result.value.boardHash };
}

export function topologyStartingRoots(board) {
  return Object.fromEntries(Object.entries(board.startingRoots ?? board.startingVertices ?? {})
    .map(([player, value]) => [player, [...array(value)]]));
}

// Keep the old scalar wire shape for old boards; multi-root definitions carry
// every canonical root, including the one-element array form, without loss.
export function topologyStartingState(board) {
  return Object.fromEntries(Object.entries(topologyStartingRoots(board)).map(([player, roots]) => [
    player, Array.isArray(board.definition?.startingVertices?.[player]) ? roots : roots[0],
  ]));
}

export function normalizeTopologyRoots(board, players, requested = {}) {
  const samples = new Set(board.sampleIds);
  const aliases = new Map();
  for (const copy of board.atlas.pointCopies) {
    const key = copy.coordinate.join(',');
    aliases.set(key, aliases.has(key) && aliases.get(key) !== copy.canonicalVertexId ? null : copy.canonicalVertexId);
  }
  const resolve = (value) => typeof value === 'string'
    ? samples.has(value) ? value : board.rawVertexToCanonical[value]
    : Array.isArray(value) && value.length === 2 && value.every(Number.isInteger) ? aliases.get(value.join(',')) : null;
  const existing = topologyStartingRoots(board);
  const claimed = new Set();
  const result = {};
  for (const player of players) {
    const raw = requested[player] ?? existing[player];
    const values = Array.isArray(raw) && raw.length === 2 && raw.every(Number.isInteger) ? [raw] : array(raw);
    if (!values.length || values.length > MAX_TOPOLOGY_ROOTS_PER_PLAYER) fail('INVALID_START_ROOT_COUNT', player);
    result[player] = values.map((value) => {
      const vertex = resolve(value);
      if (!vertex) fail('UNKNOWN_START_VERTEX', player);
      if (claimed.has(vertex)) fail('DUPLICATE_START_VERTEX', player);
      claimed.add(vertex);
      return vertex;
    }).sort(compareStableIdentifiers);
  }
  return result;
}

function distances(board, source) {
  const result = new Map([[source, 0]]), queue = [source];
  for (let i = 0; i < queue.length; i += 1) {
    for (const next of board.sampleAdjacency[queue[i]] ?? []) {
      if (!result.has(next)) { result.set(next, result.get(queue[i]) + 1); queue.push(next); }
    }
  }
  return result;
}

export function createTopologyStartingDefinition(board, options = {}) {
  const playerCount = options.playerCount ?? Math.max(2, Object.keys(board.startingVertices ?? {}).length);
  const count = options.countPerPlayer ?? 1;
  const mode = options.mode ?? 'default';
  if (!Number.isInteger(playerCount) || playerCount < 2 || playerCount > 6) fail('INVALID_PLAYER_COUNT');
  if (!Number.isInteger(count) || count < 1 || count > MAX_TOPOLOGY_ROOTS_PER_PLAYER) fail('INVALID_START_ROOT_COUNT');
  if (!['default', 'random', 'custom', 'append-random'].includes(mode)) fail('INVALID_STARTING_POINT_MODE');
  const players = PLAYERS.slice(0, playerCount);
  let roots;
  if (mode === 'custom') {
    roots = normalizeTopologyRoots(board, players, options.roots ?? {});
  } else if (mode === 'append-random') {
    if (!players.includes(options.player)) fail('INVALID_START_PLAYER');
    roots = normalizeTopologyRoots(board, players);
    if (roots[options.player].length >= MAX_TOPOLOGY_ROOTS_PER_PLAYER) fail('START_ROOTS_FULL', options.player);
    const claimed = new Set(Object.values(roots).flat());
    const candidates = [...board.sampleIds].filter(id => !claimed.has(id)).sort(compareStableIdentifiers);
    if (!candidates.length) fail('INSUFFICIENT_START_VERTICES');
    const value = (options.random ?? Math.random)();
    if (!(value >= 0 && value < 1)) fail('INVALID_RANDOM_SAMPLE');
    roots[options.player].push(candidates[Math.floor(value * candidates.length)]);
    roots = normalizeTopologyRoots(board, players, roots);
  } else {
    if (playerCount * count > board.sampleIds.length) fail('INSUFFICIENT_START_VERTICES');
    const available = [...board.sampleIds].sort(compareStableIdentifiers);
    const existing = topologyStartingRoots(board), claimed = new Set(), distanceMaps = [];
    roots = Object.fromEntries(players.map(player => [player, []]));
    const claim = (player, vertex) => {
      roots[player].push(vertex); claimed.add(vertex); distanceMaps.push(distances(board, vertex));
    };
    if (mode === 'default') {
      for (const player of players) for (const vertex of (existing[player] ?? []).slice(0, count)) {
        if (!claimed.has(vertex)) claim(player, vertex);
      }
    }
    // Round-robin placement avoids filling one player's complete layout before
    // other seats receive a root. Random layouts are sampled once then frozen.
    for (let slot = 0; slot < count; slot += 1) for (const player of players) {
      if (roots[player].length > slot) continue;
      const candidates = available.filter(id => !claimed.has(id));
      let best = candidates[0];
      if (mode === 'random') {
        const value = (options.random ?? Math.random)();
        if (!(value >= 0 && value < 1)) fail('INVALID_RANDOM_SAMPLE');
        best = candidates[Math.floor(value * candidates.length)];
      } else {
        let bestDistance = -1;
        for (const candidate of candidates) {
          const distance = distanceMaps.length ? Math.min(...distanceMaps.map(map => map.get(candidate) ?? Infinity)) : 0;
          if (distance > bestDistance) { bestDistance = distance; best = candidate; }
        }
      }
      claim(player, best);
    }
    roots = normalizeTopologyRoots(board, players, roots);
  }
  const sources = new Map(board.canonicalVertices.map(vertex => [vertex.id, vertex.sourceVertexIds[0]]));
  const definition = JSON.parse(JSON.stringify(board.definition));
  definition.startingVertices = Object.fromEntries(players.map(player => {
    const raw = roots[player].map(id => sources.get(id));
    // New single-root choices retain the established scalar contract.
    return [player, raw.length === 1 ? raw[0] : raw];
  }));
  const result = compileBoard(definition);
  if (!result.ok) fail('INVALID_STARTING_LAYOUT', result.errors.map(error => `${error.code}@${error.location}`).join(', '));
  return result.value.definition;
}
