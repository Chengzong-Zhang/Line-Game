// Deterministic real game positions; generation is outside timed sections.
export function renderPerfFixtures(sut) {
  const fixed = {
    2: [[1,0],[2,0],[1,5],[2,4],[1,7],[5,0],[1,4],[5,2],[4,4],[5,3],[4,0],[4,2],[0,8],[6,0],[3,3],[2,2],[0,2],[3,4],[1,2],[1,6]],
    3: [[4,0],[2,12],[13,0],[0,5],[2,6],[9,5],[1,5],[1,12],[8,5],[2,0],[2,8],[11,2],[4,3],[1,9],[9,3]],
  };
  return [[15, 2, 20], [15, 3, 15], [9, 6, 72], [15, 6, 72]].map(([gridSize, playerCount, steps]) => {
    const settings = sut.settingsFor(gridSize, playerCount);
    const engine = new sut.GameEngine({ ...settings, deferTerritoryUpdates: true }), actions = [];
    let seed = 0x51a7;
    const result = engine.replayBatch(transaction => {
      for (let turn = 0; turn < steps && !transaction.gameOver; turn++) {
        const player = transaction.currentPlayer, home = transaction.initialPositions[player];
        const distance = p => Math.max(Math.abs(p[0] - home[0]), Math.abs(p[1] - home[1]), Math.abs(p[0] + p[1] - home[0] - home[1]));
        const legal = fixed[playerCount] ? [] : transaction.getLegalMoves(player).sort((a, b) => distance(a.point) - distance(b.point));
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const point = fixed[playerCount]?.[turn] || (legal.length ? legal[seed % Math.min(8, legal.length)].point : null);
        const action = point ? { type: 'move', player, point } : { type: 'skip', player };
        const step = sut.applyAction(transaction, action);
        if (!step.success) throw Error(`Invalid fixture action ${turn}: ${step.reason}`);
        actions.push(action);
      }
      return { success: true };
    });
    if (!result.success) throw Error(result.reason);
    return { id: `${playerCount}p-size${gridSize}-${actions.length}moves`, settings, actions, snapshot: engine.getSnapshot() };
  });
}
