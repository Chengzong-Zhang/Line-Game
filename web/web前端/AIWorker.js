import { GameEngine } from "./GameEngine.js";
import { MinimaxAI, restoreState } from "./AIEngine.js";

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
    } = event.data;
    const engine = new GameEngine({
      gridSize: serializedState.gridSize,
      playerCount: serializedState.playerCount,
      startPlayer: serializedState.startPlayer,
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
      currentPlayer: serializedState.currentPlayer,
      gameOver: serializedState.gameOver,
      turnCount: engine.turnCount,
      cachedTerritories: engine.cachedTerritories,
    });

    const moves = new MinimaxAI(depth).getTopMoves(engine, aiPlayer, topN);
    self.postMessage({ type: "RESULT", moves });
  } catch (error) {
    self.postMessage({
      type: "ERROR",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
