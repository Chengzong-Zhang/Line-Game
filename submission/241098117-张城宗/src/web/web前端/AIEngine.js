import { GameEngine, Player, PointState } from "./GameEngine.js";

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
    currentPlayer: engine.currentPlayer,
    gameOver: engine.gameOver,
    turnCount: engine.turnCount,
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
  engine.currentPlayer = snapshot.currentPlayer;
  engine.gameOver = snapshot.gameOver;
  engine.turnCount = snapshot.turnCount;
  engine.cachedTerritories = snapshot.cachedTerritories;
}

function applyMoveForAI(engine, point) {
  const result = engine.playMove(point);
  if (!result.success) {
    const reason = String(result.reason ?? "").toUpperCase();
    if (reason.includes("SUPERKO") || reason.includes("REPEAT")) {
      return false;
    }
    return false;
  }
  return true;
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

  const legalMoveKeys = new Set(
    engine.getLegalMoves(player).map((move) => pointKey(move.point)),
  );
  const attackThreats = opponentLines.reduce(
    (count, point) => count + (legalMoveKeys.has(pointKey(point)) ? 1 : 0),
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

  minimax(engine, depth, alpha, beta, maximizingPlayer, aiPlayer) {
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
        !maximizingPlayer,
        aiPlayer,
      );
      restoreState(engine, snapshot);
      return score;
    }

    const ordered = this.orderMoves(engine, legalMoves, engine.currentPlayer);
    if (maximizingPlayer) {
      let bestValue = Number.NEGATIVE_INFINITY;
      for (const point of ordered) {
        const snapshot = saveState(engine);
        const applied = applyMoveForAI(engine, point);
        if (applied) {
          const value = this.minimax(engine, depth - 1, alpha, beta, false, aiPlayer);
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
      const applied = applyMoveForAI(engine, point);
      if (applied) {
        const value = this.minimax(engine, depth - 1, alpha, beta, true, aiPlayer);
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
    const legalMoves = this.getLegalMoves(engine, aiPlayer);
    if (legalMoves.length === 0) {
      return [];
    }

    const ordered = this.orderMoves(engine, legalMoves, aiPlayer);
    const scoredMoves = [];
    for (const point of ordered) {
      const snapshot = saveState(engine);
      const applied = applyMoveForAI(engine, point);
      if (applied) {
        const score = this.minimax(
          engine,
          this.depth - 1,
          Number.NEGATIVE_INFINITY,
          Number.POSITIVE_INFINITY,
          false,
          aiPlayer,
        );
        scoredMoves.push({ point, score });
      }
      restoreState(engine, snapshot);
    }

    scoredMoves.sort((a, b) => b.score - a.score);
    return scoredMoves.slice(0, topN);
  }
}

export { MinimaxAI, evaluate, fastTerritoryBFS, saveState, restoreState };
