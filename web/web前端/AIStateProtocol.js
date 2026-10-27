const cloneValue = (value) => JSON.parse(JSON.stringify(value));

export function serializeEngineState(engine) {
  if (!engine) {
    throw new Error("serializeEngineState requires a GameEngine instance.");
  }
  return {
    gridSize: engine.gridSize,
    playerCount: engine.playerCount,
    boardShape: engine.boardShape,
    startPlayer: engine.startPlayer,
    ...(engine.hasCustomInitialPositions ? { initialPositions: cloneValue(engine.initialPositions) } : {}),
    initialRoots: cloneValue(engine.initialRoots),
    roots: Object.fromEntries(engine.activePlayers.map((player) => [player, engine.getRoots(player)])),
    rootMode: engine.rootMode,
    rootRulesVersion: engine.rootRulesVersion,
    rootActionsRemaining: cloneValue(engine.rootActionsRemaining),
    rootStateIdentity: getRootStateIdentity(engine),
    rulesVersion: engine.rulesVersion,
    positionRevision: engine.positionRevision,
    activePlayers: [...engine.activePlayers],
    gridEntries: [...engine.grid.entries()],
    edges: Object.fromEntries(engine.activePlayers.map((player) => [player, [...(engine.edges[player] ?? [])]])),
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

export function getRootStateIdentity(engine) {
  if (!engine) return null;
  return JSON.stringify({
    rootRulesVersion: engine.rootRulesVersion,
    rootMode: engine.rootMode,
    roots: Object.fromEntries((engine.activePlayers ?? []).map((player) => [
      player, (engine.getRoots?.(player) ?? engine.roots?.[player] ?? []).map((point) => point.join(",")).sort(),
    ])),
    remaining: Object.fromEntries((engine.activePlayers ?? []).map((player) => [
      player, {
        relocate: engine.rootActionsRemaining?.[player]?.relocate ?? 0,
        add: engine.rootActionsRemaining?.[player]?.add ?? 0,
      },
    ])),
  });
}

export function restoreEngineRootState(engine, serializedState) {
  engine.roots = Object.fromEntries(engine.activePlayers.map((player) => [
    player, cloneValue(serializedState.roots?.[player] ?? engine.initialRoots[player]),
  ]));
  engine.rootActionsRemaining = cloneValue(serializedState.rootActionsRemaining ?? engine.rootActionsRemaining);
  return engine;
}

// Keep legacy fields readable for existing callers while carrying every seat.
export function deserializeEngineEdges(serializedState, players) {
  const legacy = {
    BLACK: serializedState.edgesBlack,
    WHITE: serializedState.edgesWhite,
    PURPLE: serializedState.edgesPurple,
  };
  return Object.fromEntries(players.map((player) => [
    player, new Set(serializedState.edges?.[player] ?? legacy[player] ?? []),
  ]));
}

export function isWorkerResultCurrent(engine, message) {
  return Boolean(
    engine
    && message
    && engine.positionRevision === message.positionRevision
    && engine.rulesVersion === message.rulesVersion
    && engine.currentPlayer === message.currentPlayer
    && (((engine.rootRulesVersion == null || engine.rootRulesVersion === "root-v1") && message.rootStateIdentity == null)
      || getRootStateIdentity(engine) === message.rootStateIdentity)
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
    rootStateIdentity: getRootStateIdentity(engine),
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
    && getRootStateIdentity(engine) === request.rootStateIdentity
    && message.positionRevision === request.positionRevision
    && message.rulesVersion === request.rulesVersion
    && message.currentPlayer === request.currentPlayer
    && (((engine.rootRulesVersion == null || engine.rootRulesVersion === "root-v1") && message.rootStateIdentity == null)
      || message.rootStateIdentity === request.rootStateIdentity)
  );
}
