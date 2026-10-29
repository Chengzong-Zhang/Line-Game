import { stabilityPointKey as key } from "./RootStability.js?v=20261029-topology-round5";

// Structural pressure is not area or proof of a forced capture. Consider only
// components separated from a real boundary, or on a closed surface a strictly
// smaller component when at least two components exist. Count legal actions of
// the actual next actor, including those outside the component and PASS.
export function computeEncirclementFeatures(engine, owner, check = () => {}) {
  const actor = engine.currentPlayer;
  if (engine.gameOver || actor === owner || engine.resignedPlayers.has(actor)) {
    return { pressure: 0, components: 0, enemyNodes: 0, legalMoves: 0, insideMoves: 0 };
  }
  const enemyNodes = new Set(engine._getPlayerNodes(actor).map(key));
  let components;
  if (engine.isTopologyBoard) {
    if (engine.hasPendingTerritoryUpdate()) engine._updateTerritories();
    check();
    const all = engine.cachedTerritories[owner]?.components ?? [];
    const closed = (engine.compiledBoard.realBoundarySampleIds ?? []).length === 0;
    const maxSize = Math.max(0, ...all.map(c => c.sampleIds.length));
    components = all.filter(c => !c.touchesRealBoundary && c.containsEnemy
      && (!closed || (all.length > 1 && c.sampleIds.length < maxSize)))
      .map(c => new Set(c.sampleIds));
  } else {
    const positions = engine.validPositions, index = new Map(positions.map((point, i) => [key(point), i]));
    const wall = new Set([...engine._getPlayerNodes(owner), ...engine._getPlayerLines(owner)].map(key));
    const boundary = new Set(engine._boundaryIdxs), seen = new Set(), found = [];
    for (let i = 0; i < positions.length; i++) {
      check();
      const id = key(positions[i]);
      if (wall.has(id) || seen.has(id)) continue;
      const queue = [positions[i]], part = new Set([id]); seen.add(id);
      let touches = boundary.has(i), contains = enemyNodes.has(id);
      for (let cursor = 0; cursor < queue.length; cursor++) {
        check();
        for (const next of engine.getAdjacentPositions(queue[cursor])) {
          const nextKey = key(next);
          if (wall.has(nextKey) || seen.has(nextKey)) continue;
          seen.add(nextKey); part.add(nextKey); queue.push(next);
          touches ||= boundary.has(index.get(nextKey));
          contains ||= enemyNodes.has(nextKey);
        }
      }
      if (!touches && contains) found.push(part);
    }
    components = found;
  }
  const inside = new Set(components.flatMap(part => [...part]));
  const enclosedNodes = [...enemyNodes].filter(id => inside.has(id)).length;
  if (!enclosedNodes) return { pressure: 0, components: 0, enemyNodes: 0, legalMoves: 0, insideMoves: 0 };
  let legalMoves = 0, insideMoves = 0;
  for (const point of engine.validPositions) {
    check();
    if (!engine._evaluateMove(point, actor).legal) continue;
    legalMoves++;
    if (inside.has(key(point))) insideMoves++;
  }
  check();
  // PASS is available, including when there are no legal placements.
  const freedom = 1 + legalMoves;
  return { pressure: enclosedNodes * (1 + insideMoves) / (freedom * freedom),
    components: components.length, enemyNodes: enclosedNodes, legalMoves, insideMoves };
}
