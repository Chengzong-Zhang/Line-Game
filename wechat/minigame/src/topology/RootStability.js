/**
 * A sufficient certificate for nodes that cannot be detached by legal play.
 * The board, roots and rule version are fixed. Undo/import/reset are outside
 * this statement. This reads explicit logical paths, never visual adjacency.
 *
 * Induction: roots survive. If one endpoint and every interior point of an
 * intact path are already permanent friendly nodes, nobody can play on them.
 * The other endpoint is a friendly node, so it cannot be played on either;
 * the intact path keeps it root-connected. Certify it and repeat.
 * Failure to certify a node says nothing about whether it can be captured.
 */
export const ROOT_STABILITY_VERSION = 'root-stability-v1';

export function stabilityPointKey(point) {
  if (Array.isArray(point)) return `${point[0]},${point[1]}`;
  if (point && typeof point === 'object') return String(point.vertexId ?? point.id);
  return String(point);
}

function explicitPaths(engine, player) {
  const topologyPaths = engine.topologyPaths?.[player];
  if (topologyPaths instanceof Map) {
    return [...topologyPaths.values()].map(path => ({
      id: path.pathId,
      from: path.startVertexId,
      to: path.endVertexId,
      vertices: path.vertices,
    }));
  }
  const paths = [];
  for (const id of engine._getEdges?.(player) ?? engine.edges?.[player] ?? []) {
    if (typeof id !== 'string') continue;
    const ends = id.split('|');
    if (ends.length !== 2) continue;
    const from = ends[0].split(',').map(Number), to = ends[1].split(',').map(Number);
    if (from.length !== 2 || to.length !== 2 || ![...from, ...to].every(Number.isFinite)) continue;
    paths.push({ id, from, to, vertices: engine.getLinePoints(from, to) });
  }
  return paths;
}

/** Pure, O(total explicit path length + node count) dependency closure. */
export function computeRootStability(engine, player = engine.currentPlayer) {
  const friendly = new Set((engine._getPlayerNodes?.(player) ?? []).map(stabilityPointKey));
  const roots = engine.initialRoots?.[player]
    ?? engine.compiledBoard?.startingRoots?.[player]
    ?? (engine.initialPositions?.[player] ? [engine.initialPositions[player]] : []);
  const rootKeys = [...new Set(roots.map(stabilityPointKey))].filter(key => friendly.has(key));
  const certified = new Set(rootKeys), queue = [...rootKeys];
  const dependencies = new Map(), rules = [], certifiedPaths = new Set();
  for (const path of explicitPaths(engine, player)) {
    const from = stabilityPointKey(path.from), to = stabilityPointKey(path.to);
    const vertices = (path.vertices ?? []).map(stabilityPointKey);
    if (from === to || vertices.length < 2 || !friendly.has(from) || !friendly.has(to)) continue;
    if (vertices[0] !== from || vertices[vertices.length - 1] !== to) {
      if (vertices[0] !== to || vertices[vertices.length - 1] !== from) continue;
      vertices.reverse();
    }
    const interior = vertices.slice(1, -1);
    // A line point may become attackable later even if no opponent can reach
    // it now; only already certified NODEs can discharge this dependency.
    if (!interior.every(key => friendly.has(key))) continue;
    for (const [source, target] of [[from, to], [to, from]]) {
      const required = new Set([source, ...interior]);
      if (required.has(target)) continue;
      const rule = { target, pathId: path.id, remaining: required.size };
      rules.push(rule);
      for (const key of required) {
        if (!dependencies.has(key)) dependencies.set(key, []);
        dependencies.get(key).push(rule);
      }
    }
  }
  for (let i = 0; i < queue.length; i += 1) {
    for (const rule of dependencies.get(queue[i]) ?? []) {
      rule.remaining -= 1;
      if (rule.remaining !== 0) continue;
      certifiedPaths.add(rule.pathId);
      if (!certified.has(rule.target)) {
        certified.add(rule.target);
        queue.push(rule.target);
      }
    }
  }
  return {
    version: ROOT_STABILITY_VERSION,
    kind: 'sufficient-only',
    complete: true,
    player,
    rootKeys,
    nodeKeys: [...certified],
    nodeCount: certified.size,
    certifiedPathIds: [...certifiedPaths],
  };
}
