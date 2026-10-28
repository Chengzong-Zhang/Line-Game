const asEntries = (value) => value instanceof Map ? value.entries() : Object.entries(value ?? {});

function valuesForKey(source, key) {
  if (source instanceof Map) return source.get(key) ?? [];
  return source?.[key] ?? [];
}

function uniqueIds(value, label, allowed) {
  if (!Array.isArray(value) && !(value instanceof Set)) {
    throw new TypeError(label + " must be an array or Set.");
  }
  const result = [];
  const seen = new Set();
  for (const id of value) {
    if (typeof id !== "string") throw new TypeError(label + " contains a non-string sample ID.");
    if (!allowed.has(id)) throw new Error("UNKNOWN_SAMPLE:" + id);
    if (seen.has(id)) throw new Error("DUPLICATE_SAMPLE:" + id);
    seen.add(id);
    result.push(id);
  }
  return result;
}

function playerCoverage(position, playerId, allowed) {
  const direct = valuesForKey(position.ownedSampleIdsByPlayer, playerId);
  if (direct.length) return uniqueIds(direct, "ownedSampleIdsByPlayer." + playerId, allowed);
  const detail = valuesForKey(position.samplesByPlayer, playerId);
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const nodes = detail.nodeSampleIds ?? [];
    const lines = detail.lineSampleIds ?? [];
    return uniqueIds([...nodes, ...lines], "samplesByPlayer." + playerId, allowed);
  }
  return [];
}

function allEnemyCoverage(position, playerId, allowed) {
  const result = new Set();
  const direct = position.ownedSampleIdsByPlayer;
  if (direct) {
    for (const [owner, values] of asEntries(direct)) {
      if (owner === playerId) continue;
      for (const id of uniqueIds(values, "ownedSampleIdsByPlayer." + owner, allowed)) result.add(id);
    }
  }
  const detailed = position.samplesByPlayer;
  if (detailed) {
    for (const [owner, detail] of asEntries(detailed)) {
      if (owner === playerId || !detail || typeof detail !== "object") continue;
      for (const id of uniqueIds([...(detail.nodeSampleIds ?? []), ...(detail.lineSampleIds ?? [])],
        "samplesByPlayer." + owner, allowed)) result.add(id);
    }
  }
  return result;
}

function normalizeBoard(board) {
  if (!board || typeof board !== "object") throw new TypeError("board is required.");
  if (!Array.isArray(board.sampleIds) || board.sampleIds.length === 0) {
    throw new TypeError("board.sampleIds must be a non-empty array.");
  }
  const sampleIds = uniqueIds(board.sampleIds, "board.sampleIds", new Set(board.sampleIds));
  const samples = new Set(sampleIds);
  const adjacency = new Map();
  for (const id of sampleIds) {
    const neighbors = uniqueIds(valuesForKey(board.sampleAdjacency, id), "sampleAdjacency." + id, samples);
    adjacency.set(id, neighbors);
  }
  for (const [id, neighbors] of adjacency) {
    for (const neighbor of neighbors) {
      if (!adjacency.get(neighbor).includes(id)) {
        throw new Error("ASYMMETRIC_ADJACENCY:" + id + ":" + neighbor);
      }
    }
  }
  const realBoundary = new Set(uniqueIds(board.realBoundarySampleIds ?? [], "realBoundarySampleIds", samples));
  const weights = new Map();
  for (const id of sampleIds) {
    const rawWeight = board.sampleWeights instanceof Map
      ? board.sampleWeights.get(id)
      : board.sampleWeights?.[id];
    const weight = rawWeight === undefined ? 1 : rawWeight;
    if (!Number.isFinite(weight) || weight <= 0) throw new Error("INVALID_SAMPLE_WEIGHT:" + id);
    weights.set(id, weight);
  }
  return { sampleIds, samples, adjacency, realBoundary, weights };
}

/**
 * Compute the approved discrete territory rule for a compiled topology board.
 * The input is read-only and contains canonical sample IDs, never display copies.
 */
export function computeTerritory(board, position, playerId) {
  if (typeof playerId !== "string" || !playerId) throw new TypeError("playerId is required.");
  if (!position || typeof position !== "object") throw new TypeError("position is required.");
  const normalized = normalizeBoard(board);
  const ownedSampleIds = playerCoverage(position, playerId, normalized.samples);
  const owned = new Set(ownedSampleIds);
  const enemies = allEnemyCoverage(position, playerId, normalized.samples);
  for (const id of owned) {
    if (enemies.has(id)) throw new Error("POSITION_OVERLAP:" + id);
  }

  let area = 0;
  for (const id of owned) area += normalized.weights.get(id);
  const seen = new Set(owned);
  const enclosedSampleIds = [];
  const components = [];

  for (const root of normalized.sampleIds) {
    if (seen.has(root)) continue;
    const queue = [root];
    const sampleIds = [];
    let cursor = 0;
    let weight = 0;
    let touchesRealBoundary = false;
    let containsEnemy = false;
    seen.add(root);
    while (cursor < queue.length) {
      const id = queue[cursor++];
      sampleIds.push(id);
      weight += normalized.weights.get(id);
      touchesRealBoundary ||= normalized.realBoundary.has(id);
      containsEnemy ||= enemies.has(id);
      for (const neighbor of normalized.adjacency.get(id)) {
        if (seen.has(neighbor) || owned.has(neighbor)) continue;
        seen.add(neighbor);
        queue.push(neighbor);
      }
    }
    const counted = !touchesRealBoundary && !containsEnemy;
    if (counted) {
      area += weight;
      enclosedSampleIds.push(...sampleIds);
    }
    components.push({
      sampleIds,
      weight,
      touchesRealBoundary,
      containsEnemy,
      counted,
    });
  }

  return {
    area,
    ownedSampleIds,
    enclosedSampleIds,
    components,
  };
}
