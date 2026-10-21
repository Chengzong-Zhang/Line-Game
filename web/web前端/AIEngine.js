import { GameEngine, Player, PointState } from "./GameEngine.js?v=20261020-three1";

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
    edges: Object.fromEntries(
      engine.activePlayers.map((player) => [player, new Set(engine.edges[player] ?? [])]),
    ),
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
  engine.edges = Object.fromEntries(
    engine.activePlayers.map((player) => [player, new Set(snapshot.edges[player] ?? [])]),
  );
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

class GreedyAI {
  getLegalMoves(engine, player) {
    return engine.getLegalMoves(player).map((move) => move.point);
  }

  orderMoves(engine, moves, player) {
    return orderMoves(engine, moves, player);
  }

  getTopMoves(engine, aiPlayer, topN = 5) {
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
        const applied = applyMoveForAI(engine, point, true);
        if (applied) {
          scoredMoves.push({ point, score: evaluate(engine, aiPlayer) });
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

class MCTSAI {
  constructor({ simulations = 64, rolloutDepth = 40, exploration = Math.SQRT2, seed = 0x1f123bb5 } = {}) {
    this.simulations = simulations;
    this.rolloutDepth = rolloutDepth;
    this.exploration = exploration;
    this.seed = seed >>> 0;
  }

  getLegalMoves(engine, player) {
    return engine.getLegalMoves(player).map((move) => move.point);
  }

  nextRandom() {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 0x100000000;
  }

  selectChild(node, rootPlayer) {
    const logParent = Math.log(Math.max(1, node.visits));
    const actorSign = node.playerToAct === rootPlayer ? 1 : -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    let bestChildren = [];
    for (const child of node.children.values()) {
      const exploitation = actorSign * (child.valueSum / Math.max(1, child.visits));
      const exploration = this.exploration * Math.sqrt(logParent / child.visits);
      const score = exploitation + exploration;
      if (score > bestScore + 1e-12) {
        bestScore = score;
        bestChildren = [child];
      } else if (Math.abs(score - bestScore) <= 1e-12) {
        bestChildren.push(child);
      }
    }
    return bestChildren[Math.floor(this.nextRandom() * bestChildren.length)];
  }

  applyRandomMove(engine, point) {
    return applyMoveForAI(engine, point, false);
  }

  rollout(engine, rootPlayer) {
    for (let step = 0; step < this.rolloutDepth && !engine.gameOver; step += 1) {
      const legalMoves = this.getLegalMoves(engine, engine.currentPlayer);
      if (!legalMoves.length) {
        engine.skipTurn();
        continue;
      }
      const point = legalMoves[Math.floor(this.nextRandom() * legalMoves.length)];
      if (!this.applyRandomMove(engine, point)) {
        break;
      }
    }
    // MCTS needs a bounded value even for a non-terminal rollout.  The value
    // is intentionally called rollout value in the UI; it is not a win rate.
    return Math.tanh(evaluate(engine, rootPlayer) / 100);
  }

  getTopMoves(engine, aiPlayer, topN = 5) {
    const previousReplayFlag = engine._isReplayingBatch;
    engine._isReplayingBatch = true;
    try {
      const rootActions = this.getLegalMoves(engine, aiPlayer);
      if (!rootActions.length) return [];

      const rootSnapshot = saveState(engine);
      const root = {
        playerToAct: aiPlayer,
        parent: null,
        action: null,
        unexpandedActions: rootActions.map((point) => [...point]),
        children: new Map(),
        visits: 0,
        valueSum: 0,
      };

      try {
        for (let simulation = 0; simulation < this.simulations; simulation += 1) {
          restoreState(engine, rootSnapshot);
          let node = root;

          while (!engine.gameOver && !node.unexpandedActions.length && node.children.size) {
            node = this.selectChild(node, aiPlayer);
            if (!this.applyRandomMove(engine, node.action)) break;
          }

          if (!engine.gameOver && node.unexpandedActions.length) {
            const index = Math.floor(this.nextRandom() * node.unexpandedActions.length);
            const [action] = node.unexpandedActions.splice(index, 1);
            if (this.applyRandomMove(engine, action)) {
              const child = {
                playerToAct: engine.currentPlayer,
                parent: node,
                action,
                unexpandedActions: this.getLegalMoves(engine, engine.currentPlayer),
                children: new Map(),
                visits: 0,
                valueSum: 0,
              };
              node.children.set(pointKey(action), child);
              node = child;
            }
          }

          const value = this.rollout(engine, aiPlayer);
          for (let cursor = node; cursor; cursor = cursor.parent) {
            cursor.visits += 1;
            cursor.valueSum += value;
          }
        }
      } finally {
        restoreState(engine, rootSnapshot);
      }

      return rootActions
        .map((point) => {
          const child = root.children.get(pointKey(point));
          const visits = child?.visits ?? 0;
          const meanValue = visits ? child.valueSum / visits : 0;
          return { point, score: meanValue, visits, meanValue };
        })
        .sort((a, b) => b.visits - a.visits || b.meanValue - a.meanValue)
        .slice(0, topN);
    } finally {
      engine._isReplayingBatch = previousReplayFlag;
    }
  }
}

export { GreedyAI, MCTSAI, MinimaxAI, evaluate, fastTerritoryBFS, saveState, restoreState };
