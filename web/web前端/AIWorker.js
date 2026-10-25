import { GameEngine } from "./GameEngine.js?v=20261025-defense15";
import { deserializeEngineEdges } from "./AIStateProtocol.js?v=20261025-defense15";
import { GreedyAI, MCTSAI, MinimaxAI, restoreState, saveState } from "./AIEngine.js?v=20261025-defense15";

const TERMINAL_WINNING_PASS_WINDOW_MS = 60;

function canonicalTerminalWinningPass(engine, player, now = () => performance.now()) {
  try {
    const started = now();
    if (!Number.isFinite(started)) return null;
    const deadline = started + TERMINAL_WINNING_PASS_WINDOW_MS;
    if (engine.gameOver || engine.currentPlayer !== player) return null;
    const remaining = engine.activePlayers.filter((candidate) => !engine.resignedPlayers.has(candidate));
    if (remaining.length < 2 || engine.consecutiveSkips !== remaining.length - 1) return null;

    const isolated = new GameEngine({
      gridSize: engine.gridSize,
      playerCount: engine.playerCount,
      boardShape: engine.boardShape,
      startPlayer: engine.startPlayer,
      initialPositions: engine.initialPositions,
      rulesVersion: engine.rulesVersion,
      deferTerritoryUpdates: true,
    });
    restoreState(isolated, saveState(engine));
    isolated._isReplayingBatch = true;
    if (!isolated._hasValidMoves(player)) return null;
    if (now() >= deadline) return null;

    const result = isolated.skipTurn();
    if (!result.success || !isolated.gameOver) return null;
    if (now() >= deadline) return null;
    GameEngine.prototype._updateTerritories.call(isolated);
    if (now() >= deadline) return null;
    const bestArea = Math.max(...remaining.map((candidate) => isolated.cachedTerritories[candidate].area));
    const winners = remaining.filter((candidate) => isolated.cachedTerritories[candidate].area === bestArea);
    const winner = isolated.getWinner();
    if (now() >= deadline || winners.length !== 1 || winners[0] !== player || winner !== player) return null;
    return { point: null, type: "pass", score: 1_000_000 };
  } catch (_) {
    return null;
  }
}

self.onmessage = async (event) => {
  if (event.data?.type === "WARMUP") {
    try {
      const { warmMultiplayerResources } = await import("./MultiplayerAIWarmup.js?v=20261025-defense15");
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
      const { loadResearchModel, NeuralPUCTAI, supportsResearchInference } = await import("./ResearchAI.js?v=20261025-defense15");
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
      const { loadModelFreeModel, ModelFreeAI } = await import("./ModelFreeAI.js?v=20261025-defense15");
      const model = await loadModelFreeModel(event.data?.modelId);
      ai = new ModelFreeAI(model);
    } else if (strategy === "multiplayer") {
      const { loadMultiplayerRuntime } = await import("./MultiplayerRuntime.js?v=20261025-defense15");
      const runtime = await loadMultiplayerRuntime(event.data?.modelId, engine);
      ai = runtime.ai;
      modelInfo = runtime.modelInfo;
      if (modelInfo?.id !== event.data?.modelId) throw new Error("多人 AI 模型身份校验失败。");
    } else if (strategy === "three-player") {
      const { loadThreePlayerRuntime } = await import("./ThreePlayerRuntime.js?v=20261025-defense15");
      const runtime = await loadThreePlayerRuntime(event.data?.modelId, engine);
      ai = runtime.ai;
      modelInfo = runtime.modelInfo;
    } else if (strategy === "hex-player") {
      const { loadHexPlayerRuntime } = await import("./HexPlayerRuntime.js?v=20261025-defense15");
      const runtime = await loadHexPlayerRuntime(event.data?.modelId, engine);
      ai = runtime.ai;
      modelInfo = runtime.modelInfo;
    }
    if (!ai) {
      throw new Error(`Unsupported AI strategy: ${strategy}`);
    }
    // Resolve a certain terminal PASS before READY. Multiplayer callers start
    // their decision watchdog at READY, so exact legality/area work must remain
    // part of loading rather than silently consuming the model's move budget.
    const exactWinningPass = topN > 0 ? canonicalTerminalWinningPass(engine, aiPlayer) : null;
    if (strategy === "multiplayer") {
      // Loading can include network requests. Start the caller's decision
      // watchdog only once this exact model is ready to compute this position.
      self.postMessage({ type: "READY", requestId, strategy,
        positionRevision: serializedState.positionRevision ?? 0,
        rulesVersion: serializedState.rulesVersion,
        currentPlayer: serializedState.currentPlayer, modelInfo });
    }
    const moves = exactWinningPass ? [exactWinningPass]
      : ai.getTopMoves(engine, aiPlayer, topN,
        strategy === "multiplayer" ? { terminalWinningPassPrechecked: true } : undefined);
    self.postMessage({
      type: "RESULT",
      requestId,
      strategy,
      positionRevision: serializedState.positionRevision ?? 0,
      rulesVersion: serializedState.rulesVersion,
      currentPlayer: serializedState.currentPlayer,
      moves,
      modelInfo,
      ...(ai.lastSearch ? { searchStats: ai.lastSearch } : {}),
    });
  } catch (error) {
    self.postMessage({
      type: "ERROR",
      requestId: event.data?.requestId ?? null,
      positionRevision: event.data?.serializedState?.positionRevision ?? 0,
      rulesVersion: event.data?.serializedState?.rulesVersion,
      currentPlayer: event.data?.serializedState?.currentPlayer,
      message: error instanceof Error ? error.message : String(error),
      ...(typeof error?.code === "string" && error.code.startsWith("ULTIMATE_") ? { code: error.code } : {}),
    });
  }
};
