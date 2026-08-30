import { GameEngine } from "./GameEngine.js?v=20260830a";
import { MinimaxAI, restoreState } from "./AIEngine.js?v=20260830a";

self.onmessage = (event) => {
  if (event.data?.type !== "COMPUTE") {
    return;
  }

  try {
    const {
      serializedState,
      aiPlayer,
      depth = 3,
      topN = 5,
      requestId = null,
    } = event.data;
    const engine = new GameEngine({
      gridSize: serializedState.gridSize,
      playerCount: serializedState.playerCount,
      startPlayer: serializedState.startPlayer,
      rulesVersion: serializedState.rulesVersion,
    });

    restoreState(engine, {
      grid: new Map(serializedState.gridEntries),
      edges: {
        BLACK: new Set(serializedState.edgesBlack),
        WHITE: new Set(serializedState.edgesWhite),
        PURPLE: new Set(serializedState.edgesPurple),
      },
      historyHashes: new Set(serializedState.historyHashes),
      consecutiveSkips: serializedState.consecutiveSkips,
      resignedPlayers: new Set(serializedState.resignedPlayers ?? []),
      currentPlayer: serializedState.currentPlayer,
      gameOver: serializedState.gameOver,
      turnCount: serializedState.turnCount,
      positionRevision: serializedState.positionRevision ?? 0,
      cachedTerritories: engine.cachedTerritories,
    });

    // 搜索期间跳过昂贵的领土计算（评估函数用 fastTerritoryBFS 代替）
    engine._updateTerritories = () => {};

    const moves = new MinimaxAI(depth).getTopMoves(engine, aiPlayer, topN);
    self.postMessage({
      type: "RESULT",
      requestId,
      positionRevision: serializedState.positionRevision ?? 0,
      rulesVersion: serializedState.rulesVersion,
      moves,
    });
  } catch (error) {
    self.postMessage({
      type: "ERROR",
      requestId: event.data?.requestId ?? null,
      positionRevision: event.data?.serializedState?.positionRevision ?? 0,
      rulesVersion: event.data?.serializedState?.rulesVersion,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
