// Optional 17th linear-policy coefficient. Placement-only search consumers
// retain their original full-ranking contract; only action policies add PASS.
export function rankWithLearnedPass(placements, spec) {
  if (!Number.isFinite(spec?.passBias)) return placements;
  const moves = placements.map(move => {
    const copy = { ...move };
    if (move.features) Object.defineProperty(copy, "features", { value: move.features, enumerable: false });
    return copy;
  });
  moves.push({ type: "pass", point: null, score: spec.passBias / (spec.temperature ?? 1), visits: 1 });
  moves.sort((a, b) => b.score - a.score || (a.point === null ? (b.point === null ? 0 : 1)
    : b.point === null ? -1 : a.point[1] - b.point[1] || a.point[0] - b.point[0]));
  const maximum = moves[0].score, total = moves.reduce((sum, move) => sum + Math.exp(move.score - maximum), 0);
  moves.forEach(move => { move.prior = Math.exp(move.score - maximum) / total; });
  return moves;
}

export function withLearnedPass(policy, spec = policy?.model?.spec) {
  if (!Number.isFinite(spec?.passBias)) return policy;
  // Preserve .model/.spec and the native runtime interface used when preparing
  // Hard resources. This wrapper changes neither candidate features nor scores.
  const wrapped = Object.create(policy);
  wrapped.getTopMoves = function(source, player = source.currentPlayer, topN = 5) {
    if (source.gameOver || topN <= 0) return [];
    const placements = policy.getTopMoves(source, player, source.validPositions.length + 1);
    const moves = rankWithLearnedPass(placements, spec);
    this.lastSearch = { ...(policy.lastSearch ?? {}), includesLearnedPass: true, passBias: spec.passBias,
      ...(spec.passDisciplineTraining ? { passDisciplineTraining: spec.passDisciplineTraining } : {}) };
    return moves.slice(0, Math.max(0, Math.floor(topN)));
  };
  return wrapped;
}
