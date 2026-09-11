import { GameEngine, Player, PointState } from "./GameEngine.js?v=20260910d";

function pointKey(point) {
  return `${point[0]},${point[1]}`;
}

function getOpponents(engine, player) {
  return engine._getOpponents
    ? engine._getOpponents(player)
    : engine.activePlayers.filter((candidate) => candidate !== player);
}

function cloneCachedTerritories(engine) {
  return Object.fromEntries(
    engine.activePlayers.map((player) => {
      const territory = engine.cachedTerritories[player];
      return [
        player,
        {
          ...territory,
          polygon: territory.polygon
            ? territory.polygon.map((point) => [...point])
            : null,
        },
      ];
    }),
  );
}

function saveState(engine) {
  return {
    grid: new Map(engine.grid),
    edges: {
      BLACK: new Set(engine.edges.BLACK ?? []),
      WHITE: new Set(engine.edges.WHITE ?? []),
      PURPLE: new Set(engine.edges.PURPLE ?? []),
    },
    historyHashes: new Set(engine.historyHashes),
    consecutiveSkips: engine.consecutiveSkips,
    resignedPlayers: new Set(engine.resignedPlayers ?? []),
    currentPlayer: engine.currentPlayer,
    gameOver: engine.gameOver,
    turnCount: engine.turnCount,
    positionRevision: engine.positionRevision ?? 0,
    territoryStateRevision: engine._territoryStateRevision ?? engine.positionRevision ?? 0,
    territoryCacheRevision: engine._territoryCacheRevision
      ?? engine._territoryStateRevision
      ?? engine.positionRevision
      ?? 0,
    cachedTerritories: cloneCachedTerritories(engine),
  };
}

function restoreState(engine, snapshot) {
  engine.grid = new Map(snapshot.grid);
  engine.edges = {
    BLACK: new Set(snapshot.edges.BLACK),
    WHITE: new Set(snapshot.edges.WHITE),
    PURPLE: new Set(snapshot.edges.PURPLE),
  };
  engine.historyHashes = new Set(snapshot.historyHashes);
  engine.consecutiveSkips = snapshot.consecutiveSkips;
  engine.resignedPlayers = new Set(snapshot.resignedPlayers ?? []);
  engine.currentPlayer = snapshot.currentPlayer;
  engine.gameOver = snapshot.gameOver;
  engine.turnCount = snapshot.turnCount;
  engine.positionRevision = snapshot.positionRevision ?? engine.positionRevision ?? 0;
  engine._territoryStateRevision = snapshot.territoryStateRevision
    ?? engine.positionRevision;
  engine._territoryCacheRevision = snapshot.territoryCacheRevision
    ?? engine._territoryStateRevision;
  engine.cachedTerritories = snapshot.cachedTerritories;
}

function applyMoveForAI(engine, point, skipLeafAutoSkip = false) {
  // At a heuristic leaf, automatic-skip normalization only changes turn
  // bookkeeping.  evaluate() reads the board, edges, Superko history, and
  // resignations, none of which depend on that normalization.  Avoid the
  // expensive "does the next player have any move?" full-board probe there.
  // Non-leaf transitions still run the canonical normalization because their
  // currentPlayer/gameOver state determines subsequent Minimax branches.
  const originalAutoSkip = skipLeafAutoSkip ? engine._checkAndAutoSkip : null;
  if (skipLeafAutoSkip) {
    engine._checkAndAutoSkip = () => {};
  }

  try {
    const result = engine.playMove(point);
    return result.success;
  } finally {
    if (skipLeafAutoSkip) {
      engine._checkAndAutoSkip = originalAutoSkip;
    }
  }
}

function fastTerritoryBFS(engine, player) {
  const myStates = engine._getPlayerStates(player);
  const opponentStates = new Set();
  for (const opponent of getOpponents(engine, player)) {
    const states = engine._getPlayerStates(opponent);
    opponentStates.add(states.node);
    opponentStates.add(states.line);
  }

  const frontier = [];
  const visited = new Set();
  for (const point of engine.validPositions) {
    const state = engine._getState(point);
    if (state === myStates.node || state === myStates.line) {
      const key = pointKey(point);
      visited.add(key);
      frontier.push(point);
    }
  }

  for (let index = 0; index < frontier.length; index += 1) {
    for (const adjacent of engine.getAdjacentPositions(frontier[index])) {
      const key = pointKey(adjacent);
      if (!visited.has(key) && !opponentStates.has(engine._getState(adjacent))) {
        visited.add(key);
        frontier.push(adjacent);
      }
    }
  }

  return visited.size;
}

function evaluate(engine, player) {
  const opponents = getOpponents(engine, player);
  const myNodes = engine._getPlayerNodes(player);
  const myLines = engine._getPlayerLines(player);

  let opponentNodeCount = 0;
  let opponentLineCount = 0;
  const opponentLines = [];
  let mainOpponent = null;
  let mainOpponentNodeCount = -1;

  for (const opponent of opponents) {
    const nodes = engine._getPlayerNodes(opponent);
    const lines = engine._getPlayerLines(opponent);
    opponentNodeCount += nodes.length;
    opponentLineCount += lines.length;
    opponentLines.push(...lines);

    if (nodes.length > mainOpponentNodeCount) {
      mainOpponent = opponent;
      mainOpponentNodeCount = nodes.length;
    }
  }

  const nodeAdvantage = myNodes.length - opponentNodeCount;
  const coverageAdvantage =
    myNodes.length + myLines.length - opponentNodeCount - opponentLineCount;
  const territoryAdvantage =
    fastTerritoryBFS(engine, player) -
    (mainOpponent === null ? 0 : fastTerritoryBFS(engine, mainOpponent));

  // We only need to know whether an opponent line can be attacked.  Calling
  // getLegalMoves(player) here used to validate every board point at every
  // leaf.  Probe just the relevant line points through the canonical rule
  // evaluator instead: this preserves Superko and all placement rules exactly.
  const attackThreats = opponentLines.reduce(
    (count, point) => count + (engine._evaluateMove(point, player).legal ? 1 : 0),
    0,
  );
  const connectionQuality = myNodes.reduce(
    (score, node) => score + (engine._isConnectedToInitial(node, player) ? 1 : -1),
    0,
  );

  return (
    15 * nodeAdvantage +
    8 * coverageAdvantage +
    20 * territoryAdvantage +
    12 * attackThreats +
    10 * connectionQuality
  );
}

function orderMoves(engine, moves, player) {
  const ownLine = engine._getPlayerStates(player).line;
  const opponentLines = new Set(
    getOpponents(engine, player).map(
      (opponent) => engine._getPlayerStates(opponent).line,
    ),
  );
  const tiers = [[], [], []];

  for (const point of moves) {
    if (opponentLines.has(engine._getState(point))) {
      tiers[0].push(point);
    } else if (
      engine
        .getAdjacentPositions(point)
        .some((adjacent) => engine._getState(adjacent) === ownLine)
    ) {
      tiers[1].push(point);
    } else {
      tiers[2].push(point);
    }
  }

  return [...tiers[0], ...tiers[1], ...tiers[2]].slice(0, 20);
}

class MinimaxAI {
  constructor(depth = 3) {
    this.depth = depth;
  }

  getLegalMoves(engine, player) {
    return engine.getLegalMoves(player).map((move) => move.point);
  }

  orderMoves(engine, moves, player) {
    return orderMoves(engine, moves, player);
  }

  minimax(engine, depth, alpha, beta, aiPlayer) {
    if (engine.gameOver || depth === 0) {
      return evaluate(engine, aiPlayer);
    }

    const legalMoves = this.getLegalMoves(engine, engine.currentPlayer);
    if (legalMoves.length === 0) {
      const snapshot = saveState(engine);
      engine.consecutiveSkips += 1;
      if (engine.consecutiveSkips >= engine.activePlayers.length) {
        engine.gameOver = true;
      } else {
        engine._switchPlayer();
      }
      const score = this.minimax(
        engine,
        depth - 1,
        alpha,
        beta,
        aiPlayer,
      );
      restoreState(engine, snapshot);
      return score;
    }

    const ordered = this.orderMoves(engine, legalMoves, engine.currentPlayer);
    // Automatic skip normalization can leave the same player in control.
    // Derive MAX/MIN from the engine state instead of recursion depth parity.
    const maximizingPlayer = engine.currentPlayer === aiPlayer;
    if (maximizingPlayer) {
      let bestValue = Number.NEGATIVE_INFINITY;
      for (const point of ordered) {
        const snapshot = saveState(engine);
        const applied = applyMoveForAI(engine, point, depth === 1);
        if (applied) {
          const value = this.minimax(engine, depth - 1, alpha, beta, aiPlayer);
          bestValue = Math.max(bestValue, value);
          alpha = Math.max(alpha, bestValue);
        }
        restoreState(engine, snapshot);
        if (beta <= alpha) {
          break;
        }
      }
      return bestValue;
    }

    let bestValue = Number.POSITIVE_INFINITY;
    for (const point of ordered) {
      const snapshot = saveState(engine);
      const applied = applyMoveForAI(engine, point, depth === 1);
      if (applied) {
        const value = this.minimax(engine, depth - 1, alpha, beta, aiPlayer);
        bestValue = Math.min(bestValue, value);
        beta = Math.min(beta, bestValue);
      }
      restoreState(engine, snapshot);
      if (beta <= alpha) {
        break;
      }
    }
    return bestValue;
  }

  getTopMoves(engine, aiPlayer, topN = 5) {
    // Search transitions only need success/failure, never the UI snapshot that
    // GameEngine.playMove normally creates.  Reuse its replay flag while all
    // speculative branches are bracketed, then restore the caller's value.
    // This also suppresses display-only territory work during simulation.
    const previousReplayFlag = engine._isReplayingBatch;
    engine._isReplayingBatch = true;
    try {
      const legalMoves = this.getLegalMoves(engine, aiPlayer);
      if (legalMoves.length === 0) {
        return [];
      }

      const ordered = this.orderMoves(engine, legalMoves, aiPlayer);
      const scoredMoves = [];
      for (const point of ordered) {
        const snapshot = saveState(engine);
        const applied = applyMoveForAI(engine, point, this.depth <= 1);
        if (applied) {
          const score = this.minimax(
            engine,
            this.depth - 1,
            Number.NEGATIVE_INFINITY,
            Number.POSITIVE_INFINITY,
            aiPlayer,
          );
          scoredMoves.push({ point, score });
        }
        restoreState(engine, snapshot);
      }

      scoredMoves.sort((a, b) => b.score - a.score);
      return scoredMoves.slice(0, topN);
    } finally {
      engine._isReplayingBatch = previousReplayFlag;
    }
  }
}

export { MinimaxAI, evaluate, fastTerritoryBFS, saveState, restoreState };
