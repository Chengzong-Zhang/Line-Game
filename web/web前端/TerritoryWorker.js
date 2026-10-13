import { GameEngine } from "./GameEngine.js?v=20261013-sync1";

function cloneTerritories(engine) {
  return Object.fromEntries(
    engine.activePlayers.map((player) => {
      const territory = engine.cachedTerritories[player];
      return [player, {
        polygon: territory.polygon ? territory.polygon.map((point) => [...point]) : null,
        area: territory.area,
        displayArea: territory.displayArea,
      }];
    }),
  );
}

function restoreSerializedState(engine, serializedState) {
  engine.grid = new Map(serializedState.gridEntries);
  engine.edges = {
    BLACK: new Set(serializedState.edgesBlack),
    WHITE: new Set(serializedState.edgesWhite),
    PURPLE: new Set(serializedState.edgesPurple),
  };
  engine.historyHashes = new Set(serializedState.historyHashes);
  engine.consecutiveSkips = serializedState.consecutiveSkips;
  engine.resignedPlayers = new Set(serializedState.resignedPlayers ?? []);
  engine.currentPlayer = serializedState.currentPlayer;
  engine.gameOver = serializedState.gameOver;
  engine.turnCount = serializedState.turnCount;
  engine.positionRevision = serializedState.positionRevision ?? 0;
}

self.onmessage = (event) => {
  if (event.data?.type !== "COMPUTE_TERRITORIES") {
    return;
  }

  const requestId = event.data?.requestId ?? null;
  const serializedState = event.data?.serializedState;
  const territoryStateRevision = event.data?.territoryStateRevision;
  const gameOver = Boolean(event.data?.gameOver);

  try {
    if (!serializedState || !Number.isInteger(territoryStateRevision)) {
      throw new Error("Territory worker received an invalid state payload.");
    }

    const engine = new GameEngine({
      gridSize: serializedState.gridSize,
      playerCount: serializedState.playerCount,
      startPlayer: serializedState.startPlayer,
      rulesVersion: serializedState.rulesVersion,
    });
    restoreSerializedState(engine, serializedState);
    engine._territoryStateRevision = territoryStateRevision;
    engine._updateTerritories();

    self.postMessage({
      type: "RESULT",
      requestId,
      positionRevision: serializedState.positionRevision ?? 0,
      rulesVersion: serializedState.rulesVersion,
      currentPlayer: serializedState.currentPlayer,
      territoryStateRevision,
      gameOver,
      territories: cloneTerritories(engine),
    });
  } catch (error) {
    self.postMessage({
      type: "ERROR",
      requestId,
      positionRevision: serializedState?.positionRevision ?? 0,
      rulesVersion: serializedState?.rulesVersion,
      currentPlayer: serializedState?.currentPlayer,
      territoryStateRevision,
      gameOver,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
