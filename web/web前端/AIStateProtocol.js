export function serializeEngineState(engine) {
  if (!engine) {
    throw new Error("serializeEngineState requires a GameEngine instance.");
  }
  return {
    gridSize: engine.gridSize,
    playerCount: engine.playerCount,
    startPlayer: engine.startPlayer,
    rulesVersion: engine.rulesVersion,
    positionRevision: engine.positionRevision,
    activePlayers: [...engine.activePlayers],
    gridEntries: [...engine.grid.entries()],
    edgesBlack: [...(engine.edges.BLACK ?? [])],
    edgesWhite: [...(engine.edges.WHITE ?? [])],
    edgesPurple: [...(engine.edges.PURPLE ?? [])],
    historyHashes: [...engine.historyHashes],
    consecutiveSkips: engine.consecutiveSkips,
    resignedPlayers: [...engine.resignedPlayers],
    currentPlayer: engine.currentPlayer,
    gameOver: engine.gameOver,
    turnCount: engine.turnCount,
  };
}

export function isWorkerResultCurrent(engine, message) {
  return Boolean(
    engine
    && message
    && engine.positionRevision === message.positionRevision
    && engine.rulesVersion === message.rulesVersion
  );
}
