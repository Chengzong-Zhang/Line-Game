import { GameEngine } from "./GameEngine.js?v=20261020-three1";
import { deserializeEngineEdges } from "./AIStateProtocol.js?v=20261020-three1";
import { GreedyAI, MCTSAI, MinimaxAI, restoreState } from "./AIEngine.js?v=20261020-three1";
import { loadResearchModel, NeuralPUCTAI } from "./ResearchAI.js?v=20261020-three1";
import { loadModelFreeModel, ModelFreeAI } from "./ModelFreeAI.js?v=20261020-three1";
import { loadThreePlayerModel, ThreePlayerAI } from "./ThreePlayerModels.js?v=20261021-three2";
import { loadHexPlayerModel, HexPlayerAI } from "./HexPlayerAI.js?v=20261021-hexai1";

self.onmessage = async (event) => {
  if (event.data?.type !== "COMPUTE") {
    return;
  }

  try {
    const {
      serializedState,
      aiPlayer,
      depth = 3,
      topN = 5,
      strategy = "minimax",
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
      edges: deserializeEngineEdges(serializedState, engine.activePlayers),
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

    let ai = null;
    let modelInfo = null;
    if (strategy === "greedy") {
      ai = new GreedyAI();
    } else if (strategy === "minimax") {
      ai = new MinimaxAI(depth);
    } else if (strategy === "mcts") {
      ai = new MCTSAI({
        simulations: event.data?.simulations ?? 64,
        rolloutDepth: event.data?.rolloutDepth ?? 40,
        seed: event.data?.seed ?? 0x1f123bb5,
      });
    } else if (strategy === "neural-puct") {
      const model = await loadResearchModel(event.data?.modelId);
      modelInfo = { id: model.spec.id, seed: model.spec.seed ?? 20260825,
        trainedBoardSizes: model.spec.trained_board_sizes, evidenceTier: model.spec.evidence_tier ?? "legacy",
        compatibility: model.spec.compatibility ?? "territory-v2 trial", checkpoint: model.spec.checkpoint,
        simulations: event.data?.simulations ?? 16, cPuct: event.data?.cPuct ?? 1.5 };
      ai = new NeuralPUCTAI(model, {
        simulations: event.data?.simulations ?? 16,
        cPuct: event.data?.cPuct ?? 1.5,
      });
    } else if (strategy === "model-free") {
      const model = await loadModelFreeModel(event.data?.modelId);
      ai = new ModelFreeAI(model);
    } else if (strategy === "three-player") {
      const model = await loadThreePlayerModel(event.data?.modelId);
      ai = new ThreePlayerAI(model);
      modelInfo = { id: model.spec.id, evidenceTier: model.spec.training.evidence_tier,
        trainedBoardSizes: model.spec.training.trained_board_sizes, compatibility: "territory-v2 three-player" };
    } else if (strategy === "hex-player") {
      const model = await loadHexPlayerModel(event.data?.modelId);
      ai = new HexPlayerAI(model);
      modelInfo = {
        id: model.spec.id,
        evidenceTier: model.spec.training.evidence_tier,
        trainedBoardSizes: model.spec.training.trained_board_sizes,
        compatibility: "territory-v2 hexagon 4–6 players",
      };
    }
    if (!ai) {
      throw new Error(`Unsupported AI strategy: ${strategy}`);
    }
    const moves = ai.getTopMoves(engine, aiPlayer, topN);
    self.postMessage({
      type: "RESULT",
      requestId,
      strategy,
      positionRevision: serializedState.positionRevision ?? 0,
      rulesVersion: serializedState.rulesVersion,
      currentPlayer: serializedState.currentPlayer,
      moves,
      modelInfo,
    });
  } catch (error) {
    self.postMessage({
      type: "ERROR",
      requestId: event.data?.requestId ?? null,
      positionRevision: event.data?.serializedState?.positionRevision ?? 0,
      rulesVersion: event.data?.serializedState?.rulesVersion,
      currentPlayer: event.data?.serializedState?.currentPlayer,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
