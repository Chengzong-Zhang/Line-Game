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
    && engine.currentPlayer === message.currentPlayer
  );
}

export function captureWorkerRequest(engine, requestId) {
  if (!engine) {
    throw new Error("captureWorkerRequest requires a GameEngine instance.");
  }

  return Object.freeze({
    requestId,
    engine,
    positionRevision: engine.positionRevision,
    rulesVersion: engine.rulesVersion,
    currentPlayer: engine.currentPlayer,
  });
}

export function isWorkerResultForRequest(engine, request, message) {
  return Boolean(
    request
    && message
    && message.requestId === request.requestId
    && engine === request.engine
    && engine.positionRevision === request.positionRevision
    && engine.rulesVersion === request.rulesVersion
    && engine.currentPlayer === request.currentPlayer
    && message.positionRevision === request.positionRevision
    && message.rulesVersion === request.rulesVersion
    && message.currentPlayer === request.currentPlayer
  );
}
