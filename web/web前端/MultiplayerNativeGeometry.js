// Private search optimization: only edge coordinates/keys survive a position.
// Occupancy, explicit edge membership and connectivity are read on every call.
import { GameEngine } from './GameEngine.js?v=20261025-defense15';

export function installNativeEdgeGeometry(engine, { maximumEntries = 2048 } = {}) {
  if (!Number.isInteger(maximumEntries) || maximumEntries < 1) throw new Error('Invalid edge geometry limit');
  const methods = ['_cleanupBrokenEdges', '_getOpponentConnectedPieces', '_getState',
    'getLinePoints', 'canConnect', 'isValidPosition'];
  for (const name of methods) {
    if (engine[name] !== GameEngine.prototype[name]) throw new Error(`Native edge geometry requires native ${name}`);
  }
  const shape = engine.boardShape, size = engine.gridSize, positions = engine.validPositions;
  const edges = new Map(), stats = { calls: 0, hits: 0, misses: 0, evictions: 0 };
  const guard = receiver => {
    if (receiver !== engine || engine.boardShape !== shape || engine.gridSize !== size
      || engine.validPositions !== positions || engine._getState !== GameEngine.prototype._getState
      || engine.getLinePoints !== GameEngine.prototype.getLinePoints
      || engine.canConnect !== GameEngine.prototype.canConnect
      || engine.isValidPosition !== GameEngine.prototype.isValidPosition)
      throw new Error('Native edge geometry contract changed');
  };
  const compile = edge => {
    stats.calls++;
    const cached = edges.get(edge);
    if (cached) { stats.hits++; return cached; }
    stats.misses++;
    const [a, b] = edge.split('|');
    const parse = key => key.split(',').map(Number);
    const keys = engine.getLinePoints(parse(a), parse(b)).map(p => `${p[0]},${p[1]}`);
    const compiled = { a, b, keys };
    if (edges.size >= maximumEntries) { edges.delete(edges.keys().next().value); stats.evictions++; }
    edges.set(edge, compiled);
    return compiled;
  };
  engine._cleanupBrokenEdges = function(player) {
    guard(this);
    const { node, line } = this._getPlayerStates(player), edgeSet = this._getEdges(player);
    for (const edge of [...edgeSet]) {
      if (!compile(edge).keys.every(key => {
        const state = this.grid.get(key);
        return state === node || state === line;
      })) edgeSet.delete(edge);
    }
  };
  engine._getOpponentConnectedPieces = function(opponent) {
    guard(this);
    const { node } = this._getPlayerStates(opponent), initial = this._getInitialPosition(opponent);
    if (this._getState(initial) !== node) return new Set();
    this._cleanupBrokenEdges(opponent);
    const edgeSet = this._getEdges(opponent), adjacency = new Map();
    for (const edge of edgeSet) {
      const { a, b } = compile(edge);
      if (!adjacency.has(a)) adjacency.set(a, []);
      if (!adjacency.has(b)) adjacency.set(b, []);
      adjacency.get(a).push(b); adjacency.get(b).push(a);
    }
    const initialKey = `${initial[0]},${initial[1]}`, aliveNodes = new Set([initialKey]), queue = [initialKey];
    for (let head = 0; head < queue.length; head++) {
      for (const next of adjacency.get(queue[head]) ?? []) {
        if (!aliveNodes.has(next)) { aliveNodes.add(next); queue.push(next); }
      }
    }
    const alive = new Set(aliveNodes);
    for (const edge of edgeSet) {
      const { a, b, keys } = compile(edge);
      if (aliveNodes.has(a) && aliveNodes.has(b)) for (const key of keys) alive.add(key);
    }
    return alive;
  };
  return { stats, get size() { return edges.size; } };
}
