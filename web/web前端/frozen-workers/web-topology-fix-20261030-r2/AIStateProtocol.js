const cloneValue = (value) => JSON.parse(JSON.stringify(value));

export function serializeEngineState(engine) {
  if (!engine) {
    throw new Error("serializeEngineState requires a GameEngine instance.");
  }
  if (engine.isTopologyBoard) {
    return {
      isTopologyBoard: true,
      boardHash: engine.boardHash,
      topologyState: engine.encodeTopologyState(),
      playerCount: engine.playerCount,
      rulesVersion: engine.rulesVersion,
      positionRevision: engine.positionRevision,
      currentPlayer: engine.currentPlayer,
    };
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
    ...(engine.protectionRule !== "symmetric-v1" ? { protectionRule: engine.protectionRule } : {}),
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
  // Topology roots are already included in topologyState/board identity; the
  // classic root-v2 coordinate representation does not exist on that engine.
  if (!engine || engine.isTopologyBoard) return null;
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
    && (engine.protectionRule ?? "symmetric-v1") === (message.protectionRule ?? "symmetric-v1")
    && engine.currentPlayer === message.currentPlayer
    && (!engine.isTopologyBoard || engine.boardHash === message.boardHash)
    && (((engine.rootRulesVersion == null || engine.rootRulesVersion === "root-v1") && message.rootStateIdentity == null)
      || getRootStateIdentity(engine) === message.rootStateIdentity)
  );
}

const workerHistorySignature = (engine) => JSON.stringify([...(engine?.historyHashes ?? [])].sort());

export function captureWorkerRequest(engine, requestId) {
  if (!engine) {
    throw new Error("captureWorkerRequest requires a GameEngine instance.");
  }

  return Object.freeze({
    requestId,
    engine,
    positionRevision: engine.positionRevision,
    rulesVersion: engine.rulesVersion,
    protectionRule: engine.protectionRule ?? "symmetric-v1",
    currentPlayer: engine.currentPlayer,
    historySignature: workerHistorySignature(engine),
    ...(engine.isTopologyBoard ? { boardHash: engine.boardHash } : {}),
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
    && (engine.protectionRule ?? "symmetric-v1") === (request.protectionRule ?? "symmetric-v1")
    && engine.currentPlayer === request.currentPlayer
    && workerHistorySignature(engine) === request.historySignature
    && getRootStateIdentity(engine) === request.rootStateIdentity
    && message.positionRevision === request.positionRevision
    && message.rulesVersion === request.rulesVersion
    && (message.protectionRule ?? "symmetric-v1") === (request.protectionRule ?? "symmetric-v1")
    && message.currentPlayer === request.currentPlayer
    && (!request.boardHash || (
      engine.isTopologyBoard
      && engine.boardHash === request.boardHash
      && message.boardHash === request.boardHash
    ))
    && (((engine.rootRulesVersion == null || engine.rootRulesVersion === "root-v1") && message.rootStateIdentity == null)
      || message.rootStateIdentity === request.rootStateIdentity)
  );
}
