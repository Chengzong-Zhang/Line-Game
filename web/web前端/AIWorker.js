import { GameEngine } from "./GameEngine.js?v=20261025-terminal-v4";
import { deserializeEngineEdges } from "./AIStateProtocol.js?v=20261025-terminal-v4";
import { GreedyAI, MCTSAI, MinimaxAI, restoreState } from "./AIEngine.js?v=20261025-terminal-v4";
import { applyPassDiscipline } from "./AIPassDisciplineV3.js?v=20261025-terminal-v4";

self.onmessage = async (event) => {
  if (event.data?.type === "WARMUP") {
    try {
      const { warmMultiplayerResources } = await import("./MultiplayerAIWarmup.js?v=20261025-terminal-v4");
      await warmMultiplayerResources(event.data);
    } catch (_) {
      // Resource failure is speculative, never a formal result or request error.
      self.postMessage({ type: "WARMUP_FAILED" });
    }
    return;
  }
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
      boardShape: serializedState.boardShape,
      startPlayer: serializedState.startPlayer,
      initialPositions: serializedState.initialPositions,
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
      // The compact worker protocol intentionally omits the display territory
      // cache.  Mark it stale so a terminal leaf reached only by PASS still
      // computes the exact native area instead of reading the fresh engine's
      // initial 0/1-point cache.
      territoryStateRevision: serializedState.territoryStateRevision
        ?? serializedState.positionRevision
        ?? 0,
      territoryCacheRevision: serializedState.territoryCacheRevision ?? -1,
      cachedTerritories: engine.cachedTerritories,
    });

    // Search implementations suppress display-only territory updates while
    // replaying speculative moves and use their fast heuristic at nonterminal
    // leaves.  Keep the native updater available: exact terminal evaluation,
    // including a voluntary PASS, must use the real area/winner.

    const nativeShape = engine.playerCount >= 4 ? "hexagon" : "triangle";
    if (engine.boardShape !== nativeShape && !["greedy", "minimax", "mcts", "multiplayer"].includes(strategy)) {
      throw new Error("当前模型不支持所选棋盘形状，请选择通用 AI。");
    }

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
      if (engine.playerCount !== 2) throw new Error("模型不支持此棋盘/规则/玩家数。");
      const { loadResearchModel, NeuralPUCTAI, supportsResearchInference } = await import("./ResearchAI.js?v=20261025-terminal-v4");
      const model = await loadResearchModel(event.data?.modelId);
      if (!supportsResearchInference(model.spec, engine)) throw new Error("模型不支持此棋盘/规则/玩家数。");
      modelInfo = { id: model.spec.id, seed: model.spec.seed ?? 20260825,
        trainedBoardSizes: model.spec.trained_board_sizes, evidenceTier: model.spec.evidence_tier ?? "legacy",
        compatibility: model.spec.compatibility ?? "territory-v2 trial", checkpoint: model.spec.checkpoint,
        simulations: event.data?.simulations ?? 16, cPuct: event.data?.cPuct ?? 1.5 };
      ai = new NeuralPUCTAI(model, {
        simulations: event.data?.simulations ?? 16,
        cPuct: event.data?.cPuct ?? 1.5,
      });
    } else if (strategy === "model-free") {
      if (engine.playerCount !== 2) throw new Error("model-free 网页模型仅支持双人局面。");
      const { loadModelFreeModel, ModelFreeAI } = await import("./ModelFreeAI.js?v=20261025-terminal-v4");
      const model = await loadModelFreeModel(event.data?.modelId);
      ai = new ModelFreeAI(model);
    } else if (strategy === "multiplayer") {
      const { loadMultiplayerRuntime } = await import("./MultiplayerRuntime.js?v=20261025-terminal-v4");
      const runtime = await loadMultiplayerRuntime(event.data?.modelId, engine);
      ai = runtime.ai;
      modelInfo = runtime.modelInfo;
      if (modelInfo?.id !== event.data?.modelId) throw new Error("多人 AI 模型身份校验失败。");
    } else if (strategy === "three-player") {
      const { loadThreePlayerRuntime } = await import("./ThreePlayerRuntime.js?v=20261025-terminal-v4");
      const runtime = await loadThreePlayerRuntime(event.data?.modelId, engine);
      ai = runtime.ai;
      modelInfo = runtime.modelInfo;
    } else if (strategy === "hex-player") {
      const { loadHexPlayerRuntime } = await import("./HexPlayerRuntime.js?v=20261025-terminal-v4");
      const runtime = await loadHexPlayerRuntime(event.data?.modelId, engine);
      ai = runtime.ai;
      modelInfo = runtime.modelInfo;
    }
    if (!ai) {
      throw new Error(`Unsupported AI strategy: ${strategy}`);
    }
    if (strategy === "multiplayer") {
      // Loading can include network requests. Start the caller's decision
      // watchdog only once this exact model is ready to compute this position.
      self.postMessage({ type: "READY", requestId, strategy,
        positionRevision: serializedState.positionRevision ?? 0,
        rulesVersion: serializedState.rulesVersion,
        currentPlayer: serializedState.currentPlayer, modelInfo });
    }
    const ranked = ai.getTopMoves(engine, aiPlayer, topN > 0 ? Math.max(5, topN) : topN,
      strategy === "multiplayer" ? { passDisciplinePrechecked: true } : undefined);
    const disciplined = applyPassDiscipline(engine, ranked, { player: aiPlayer, topN });
    const moves = disciplined.moves;
    self.postMessage({
      type: "RESULT",
      requestId,
      strategy,
      positionRevision: serializedState.positionRevision ?? 0,
      rulesVersion: serializedState.rulesVersion,
      currentPlayer: serializedState.currentPlayer,
      moves,
      modelInfo,
      searchStats: { ...(ai.lastSearch ?? {}), passDiscipline: disciplined.receipt },
    });
  } catch (error) {
    self.postMessage({
      type: "ERROR",
      requestId: event.data?.requestId ?? null,
      positionRevision: event.data?.serializedState?.positionRevision ?? 0,
      rulesVersion: event.data?.serializedState?.rulesVersion,
      currentPlayer: event.data?.serializedState?.currentPlayer,
      message: error instanceof Error ? error.message : String(error),
      ...(typeof error?.code === "string" && (error.code.startsWith("ULTIMATE_") || error.code === "AI_NO_RELIABLE_ACTION") ? { code: error.code } : {}),
      ...(error?.passDiscipline ? { passDiscipline: error.passDiscipline } : {}),
    });
  }
};
