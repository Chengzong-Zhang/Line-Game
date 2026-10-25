import { GameEngine, Player, PointState } from "./GameEngine.js?v=20261025-terminal-v4";

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

function applyMinimaxAction(engine, point, skipLeafAutoSkip = false) {
  // PASS is legal in every non-terminal position, even when placements remain.
  // Use the canonical transition so consecutive skips, automatic skips and the
  // terminal boundary stay identical to a real game. The leaf shortcut above
  // is safe only for placements because a pass changes turn bookkeeping.
  return point === null
    ? engine.skipTurn().success
    : applyMoveForAI(engine, point, skipLeafAutoSkip);
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

// Minimax's reachable-space estimate is not the game's scored territory.
// Keep the legacy evaluator above for Greedy/MCTS and existing model tooling.
const MINIMAX_WEIGHTS = Object.freeze({
  nodes: 30,
  coverage: 4,
  reachableSpace: 4,
  attackOpportunity: 4,
  // Potential loss is discounted relative to material already lost. A cut
  // must never become attractive merely because it clears a risk penalty.
  lostNodes: 24,
  lostCoverage: 3,
  // Extra preference for avoiding an uncompensated cut on the next turn.
  // This is a conservative root choice, in addition to the searched value.
  rootRiskAversion: 1.5,
});

function materialKeys(engine, player) {
  const nodes = new Set(engine._getPlayerNodes(player).map(pointKey));
  const coverage = new Set(nodes);
  for (const line of engine._getPlayerLines(player)) coverage.add(pointKey(line));
  return { nodes, coverage };
}

function lostKeys(before, after) {
  return new Set([...before].filter((key) => !after.has(key)));
}

function weightedLoss(nodes, coverage) {
  return MINIMAX_WEIGHTS.lostNodes * nodes.size
    + MINIMAX_WEIGHTS.lostCoverage * coverage.size;
}

function cutAnalysis(engine, defender) {
  const before = materialKeys(engine, defender);
  const lines = engine._getPlayerLines(defender);
  const threats = new Map();
  for (const attacker of getOpponents(engine, defender)) {
    const sourceNodes = engine._getPlayerNodes(attacker);
    for (const point of lines) {
      // Use the real placement/Superko check before measuring the cut. The
      // second probe only measures material; it must not advance the game.
      if (!engine._evaluateMove(point, attacker, sourceNodes).legal) continue;
      const snapshot = saveState(engine);
      try {
        engine.currentPlayer = attacker;
        if (!engine._addNode(point, sourceNodes)) continue;
        const after = materialKeys(engine, defender);
        const lostNodes = lostKeys(before.nodes, after.nodes);
        const lostCoverage = lostKeys(before.coverage, after.coverage);
        const loss = weightedLoss(lostNodes, lostCoverage);
        const key = pointKey(point);
        const previous = threats.get(key);
        if (!previous || loss > previous.loss) {
          threats.set(key, {
            attacker,
            point: [...point],
            loss,
            lostNodes,
            lostCoverage,
          });
        }
      } finally {
        restoreState(engine, snapshot);
      }
    }
  }

  const damaging = [...threats.values()].filter(({ loss }) => loss > 0);
  const primary = damaging.reduce((best, threat) =>
    (!best || threat.loss > best.loss ? threat : best), null);
  const immediate = primary?.loss ?? 0;
  return { threats, immediate };
}

function cutThreats(engine, defender) {
  return new Map([...cutAnalysis(engine, defender).threats]
    .map(([key, threat]) => [key, threat.loss]));
}

const ROOT_CUT_CHAIN_LIMITS = Object.freeze({
  rankingWidth: 4,
  maxFirstCuts: 4,
  maxPotentialResponses: 40,
  maxResponsesPerCut: 24,
  maxTransitions: 512,
});
const ROOT_CUT_CHAIN_LIMIT_REACHED = Symbol("ROOT_CUT_CHAIN_LIMIT_REACHED");

function materialCounts(engine, player) {
  const material = materialKeys(engine, player);
  return { nodes: material.nodes.size, coverage: material.coverage.size };
}

function materialLoss(engine, player, reference) {
  const remaining = materialCounts(engine, player);
  return {
    nodes: Math.max(0, reference.nodes - remaining.nodes),
    coverage: Math.max(0, reference.coverage - remaining.coverage),
  };
}

function survivingPlayers(engine) {
  return engine.activePlayers.filter((player) => !engine.resignedPlayers.has(player));
}

function comparePersistentLoss(left, right) {
  return left.nodes - right.nodes || left.coverage - right.coverage;
}

function boundedRootCutChainRisk(engine, defender) {
  const remainingPlayers = survivingPlayers(engine);
  if (remainingPlayers.length !== 2 || !remainingPlayers.includes(defender)) return null;
  if (engine.gameOver || engine.currentPlayer === defender) {
    return { nodes: 0, coverage: 0, firstCuts: 0, responses: 0, transitions: 0 };
  }
  const reference = materialCounts(engine, defender);

  const origin = saveState(engine);
  const budget = { firstCuts: 0, responses: 0, transitions: 0 };
  const spendTransition = () => {
    budget.transitions += 1;
    if (budget.transitions > ROOT_CUT_CHAIN_LIMITS.maxTransitions) {
      throw ROOT_CUT_CHAIN_LIMIT_REACHED;
    }
  };
  let worstFirst = { nodes: 0, coverage: 0 };

  try {
    // A damaging cut can only be placed on a current defender line. Each
    // branch still goes through canonical playMove, including Superko and
    // automatic skips; this list merely avoids scanning unrelated empties.
    const firstPoints = engine._getPlayerLines(defender).map((point) => [...point]);
    for (const firstPoint of firstPoints) {
      const beforeFirst = saveState(engine);
      try {
        spendTransition();
        if (!engine.playMove(firstPoint).success) continue;
        const firstLoss = materialLoss(engine, defender, reference);
        if (firstLoss.nodes === 0 && firstLoss.coverage === 0) continue;
        budget.firstCuts += 1;
        if (budget.firstCuts > ROOT_CUT_CHAIN_LIMITS.maxFirstCuts) {
          throw ROOT_CUT_CHAIN_LIMIT_REACHED;
        }

        let responses;
        if (engine.gameOver || engine.currentPlayer !== defender) {
          responses = [null];
        } else {
          const sourceNodes = engine._getPlayerNodes(defender);
          const potentialResponses = engine.validPositions.reduce((count, point) =>
            count + (sourceNodes.some((node) =>
              engine.canConnectWithBlocking(point, node, defender)) ? 1 : 0), 0);
          if (potentialResponses > ROOT_CUT_CHAIN_LIMITS.maxPotentialResponses) {
            throw ROOT_CUT_CHAIN_LIMIT_REACHED;
          }
          const legal = engine.getLegalMoves(defender).map(({ point }) => [...point]);
          responses = [...legal, "PASS"];
          if (responses.length > ROOT_CUT_CHAIN_LIMITS.maxResponsesPerCut) {
            throw ROOT_CUT_CHAIN_LIMIT_REACHED;
          }
        }
        budget.responses += responses.length;

        let bestResponse = null;
        for (const response of responses) {
          const beforeResponse = saveState(engine);
          try {
            if (response === "PASS") {
              spendTransition();
              if (!engine.skipTurn().success) continue;
            } else if (response !== null) {
              spendTransition();
              if (!engine.playMove(response).success) continue;
            }

            let worstSecond = materialLoss(engine, defender, reference);
            if (!engine.gameOver && engine.currentPlayer !== defender) {
              const secondPoints = engine._getPlayerLines(defender)
                .map((point) => [...point]);
              for (const secondPoint of secondPoints) {
                const beforeSecond = saveState(engine);
                try {
                  spendTransition();
                  if (!engine.playMove(secondPoint).success) continue;
                  const secondLoss = materialLoss(engine, defender, reference);
                  if (comparePersistentLoss(secondLoss, worstSecond) > 0) {
                    worstSecond = secondLoss;
                  }
                } finally {
                  restoreState(engine, beforeSecond);
                }
              }
            }

            if (bestResponse === null
              || comparePersistentLoss(worstSecond, bestResponse) < 0) {
              bestResponse = worstSecond;
            }
          } finally {
            restoreState(engine, beforeResponse);
          }
        }

        if (bestResponse !== null
          && comparePersistentLoss(bestResponse, worstFirst) > 0) {
          worstFirst = bestResponse;
        }
      } finally {
        restoreState(engine, beforeFirst);
      }
    }
    return { ...worstFirst, ...budget };
  } catch (error) {
    if (error === ROOT_CUT_CHAIN_LIMIT_REACHED) return null;
    throw error;
  } finally {
    restoreState(engine, origin);
  }
}

function boundedRootCutChainAttack(engine, attacker, defenderReference) {
  const remainingPlayers = survivingPlayers(engine);
  if (remainingPlayers.length !== 2 || !remainingPlayers.includes(attacker)) return null;
  const defender = remainingPlayers.find((player) => player !== attacker);
  if (!defender || !defenderReference) return null;

  const origin = saveState(engine);
  const budget = { responses: 0, secondCuts: 0, transitions: 0 };
  const spendTransition = () => {
    budget.transitions += 1;
    if (budget.transitions > ROOT_CUT_CHAIN_LIMITS.maxTransitions) {
      throw ROOT_CUT_CHAIN_LIMIT_REACHED;
    }
  };

  try {
    if (engine.gameOver) {
      return { ...materialLoss(engine, defender, defenderReference), ...budget };
    }

    let responses;
    if (engine.currentPlayer === attacker) {
      // The defender was canonically auto-skipped after the root action. The
      // attacker already owns the continuation, so there is no fabricated
      // defensive move between the first and second cuts.
      responses = [null];
    } else if (engine.currentPlayer === defender) {
      // Avoid a full legal-move scan on large open boards where this bounded
      // tactical overlay cannot cover every reply anyway. The connectivity
      // count is a cheap upper screen; canonical legality still decides every
      // branch once the position is inside the bound.
      const sourceNodes = engine._getPlayerNodes(defender);
      const potentialResponses = engine.validPositions.reduce((count, point) =>
        count + (sourceNodes.some((node) =>
          engine.canConnectWithBlocking(point, node, defender)) ? 1 : 0), 0);
      if (potentialResponses > ROOT_CUT_CHAIN_LIMITS.maxPotentialResponses) {
        throw ROOT_CUT_CHAIN_LIMIT_REACHED;
      }
      const legal = engine.getLegalMoves(defender).map(({ point }) => [...point]);
      responses = [...legal, "PASS"];
      if (responses.length > ROOT_CUT_CHAIN_LIMITS.maxResponsesPerCut) {
        throw ROOT_CUT_CHAIN_LIMIT_REACHED;
      }
    } else {
      return null;
    }
    budget.responses += responses.length;

    let forcedLoss = null;
    for (const response of responses) {
      const beforeResponse = saveState(engine);
      try {
        if (response === "PASS") {
          spendTransition();
          if (!engine.skipTurn().success) continue;
        } else if (response !== null) {
          spendTransition();
          if (!engine.playMove(response).success) continue;
        }

        let bestContinuation = materialLoss(engine, defender, defenderReference);
        if (!engine.gameOver && engine.currentPlayer === attacker) {
          // A damaging continuation must occupy a current defender line. Run
          // each candidate through the canonical transition so Superko,
          // clearing and automatic skips match the real game.
          const secondPoints = engine._getPlayerLines(defender)
            .map((point) => [...point]);
          for (const secondPoint of secondPoints) {
            const beforeSecond = saveState(engine);
            try {
              spendTransition();
              if (!engine.playMove(secondPoint).success) continue;
              const secondLoss = materialLoss(engine, defender, defenderReference);
              if (comparePersistentLoss(secondLoss, bestContinuation) > 0) {
                bestContinuation = secondLoss;
              }
              budget.secondCuts += 1;
            } finally {
              restoreState(engine, beforeSecond);
            }
          }
        }

        // The defender chooses the reply that leaves the least persistent
        // damage after the attacker's strongest legal second cut.
        if (forcedLoss === null
          || comparePersistentLoss(bestContinuation, forcedLoss) < 0) {
          forcedLoss = bestContinuation;
        }
      } finally {
        restoreState(engine, beforeResponse);
      }
    }

    return forcedLoss === null ? null : { ...forcedLoss, ...budget };
  } catch (error) {
    if (error === ROOT_CUT_CHAIN_LIMIT_REACHED) return null;
    throw error;
  } finally {
    restoreState(engine, origin);
  }
}

function applyRootCutChainPreference(engine, player, scoredMoves, eligibleKeys) {
  const remainingPlayers = survivingPlayers(engine);
  if (remainingPlayers.length !== 2 || !remainingPlayers.includes(player)) return scoredMoves;
  // A deliberate PASS has no placement key and cannot be compared by the
  // placement-only cut-chain oracle. If ordinary Minimax ranks PASS first,
  // preserve that decision instead of letting the defense overlay replace it.
  if (!scoredMoves.length || scoredMoves[0].point === null) return scoredMoves;
  // PASS must not consume one of the bounded placement comparison slots.
  const window = scoredMoves
    .filter(({ point }) => point !== null && eligibleKeys.has(pointKey(point)))
    .slice(0, ROOT_CUT_CHAIN_LIMITS.rankingWidth);
  if (!window.length || pointKey(window[0].point) !== pointKey(scoredMoves[0].point)) {
    return scoredMoves;
  }

  const opponent = remainingPlayers.find((candidate) => candidate !== player);
  const opponentReference = materialCounts(engine, opponent);
  const comparisons = new Map();
  for (const move of window) {
    const snapshot = saveState(engine);
    try {
      if (!engine.playMove(move.point).success) return scoredMoves;
      // There is no opponent-defense / second-cut sequence after a terminal
      // move or an automatic skip back to the AI. Leave the ordinary search
      // value untouched and avoid material probes on that guarded transition.
      if (engine.gameOver || engine.currentPlayer === player) continue;
      const risk = boundedRootCutChainRisk(engine, player);
      if (risk === null) continue;
      const attack = boundedRootCutChainAttack(engine, player, opponentReference);
      if (attack === null) continue;
      comparisons.set(pointKey(move.point), {
        risk,
        attack,
        netNodeGain: attack.nodes - risk.nodes,
      });
    } finally {
      restoreState(engine, snapshot);
    }
  }

  const topKey = pointKey(scoredMoves[0].point);
  const top = comparisons.get(topKey);
  if (!top) return scoredMoves;

  // This is a dominance rule, not another evaluation term. The ordinary
  // Minimax score already includes leaf material and the one-cut root risk.
  // A root action may replace the original top move when it either preserves
  // net node gain while reducing our forced loss, or forces more enemy loss
  // without increasing our own. Keep every score intact so the bounded
  // comparison cannot manufacture value by double-counting.
  const dominant = window.filter((move) => {
    const comparison = comparisons.get(pointKey(move.point));
    if (!comparison) return false;
    const riskComparison = comparePersistentLoss(comparison.risk, top.risk);
    const attackComparison = comparePersistentLoss(comparison.attack, top.attack);
    const defensiveDominance = comparison.netNodeGain >= top.netNodeGain
      && riskComparison < 0;
    const offensiveDominance = riskComparison <= 0 && attackComparison > 0;
    return defensiveDominance || offensiveDominance;
  });
  if (!dominant.length) return scoredMoves;
  dominant.sort((left, right) => {
    const leftComparison = comparisons.get(pointKey(left.point));
    const rightComparison = comparisons.get(pointKey(right.point));
    return rightComparison.netNodeGain - leftComparison.netNodeGain
      || comparePersistentLoss(rightComparison.attack, leftComparison.attack)
      || comparePersistentLoss(leftComparison.risk, rightComparison.risk)
      || window.indexOf(left) - window.indexOf(right);
  });
  const preferred = dominant[0];
  const preferredIndex = scoredMoves.indexOf(preferred);
  scoredMoves.splice(preferredIndex, 1);
  scoredMoves.unshift(preferred);
  return scoredMoves;
}

function opponentRiskMaterial(engine, player) {
  return getOpponents(engine, player).reduce((total, opponent) => {
    const nodes = engine._getPlayerNodes(opponent).length;
    const coverage = nodes + engine._getPlayerLines(opponent).length;
    return total + MINIMAX_WEIGHTS.lostNodes * nodes
      + MINIMAX_WEIGHTS.lostCoverage * coverage;
  }, 0);
}

function immediateRiskPenalty(engine, player, previousOpponentMaterial) {
  if (engine.gameOver || engine.currentPlayer === player) return 0;
  // A profitable immediate exchange can justify a counter-cut. Credit only
  // material actually captured, using the same units as the potential loss.
  const capturedMaterial = Math.max(0,
    previousOpponentMaterial - opponentRiskMaterial(engine, player));
  const pressure = cutAnalysis(engine, player).immediate;
  return Math.max(0, pressure - capturedMaterial);
}

function evaluateMinimax(engine, player) {
  const opponents = getOpponents(engine, player);
  const myNodes = engine._getPlayerNodes(player);
  const myLines = engine._getPlayerLines(player);
  let opponentNodes = 0;
  let opponentCoverage = 0;
  let mainOpponent = null;
  let mainOpponentNodes = -1;
  let attacks = 0;
  for (const opponent of opponents) {
    const nodes = engine._getPlayerNodes(opponent);
    const lines = engine._getPlayerLines(opponent);
    opponentNodes += nodes.length;
    opponentCoverage += nodes.length + lines.length;
    if (nodes.length > mainOpponentNodes) {
      mainOpponent = opponent;
      mainOpponentNodes = nodes.length;
    }
    for (const point of lines) {
      if (engine._evaluateMove(point, player, myNodes).legal) attacks += 1;
    }
  }
  const reach = fastTerritoryBFS(engine, player)
    - (mainOpponent === null ? 0 : fastTerritoryBFS(engine, mainOpponent));
  // A player makes one cut per turn: summing every possible cut would count
  // the same endangered branch repeatedly and discourage harmless contact.
  const defensivePressure = cutAnalysis(engine, player).immediate;
  return MINIMAX_WEIGHTS.nodes * (myNodes.length - opponentNodes)
    + MINIMAX_WEIGHTS.coverage * (myNodes.length + myLines.length - opponentCoverage)
    + MINIMAX_WEIGHTS.reachableSpace * reach
    + MINIMAX_WEIGHTS.attackOpportunity * attacks
    - defensivePressure;
}

function orderMinimaxMoves(engine, moves, player) {
  const threats = cutThreats(engine, player);
  const ownLine = engine._getPlayerStates(player).line;
  const enemyLines = new Set(getOpponents(engine, player)
    .map((opponent) => engine._getPlayerStates(opponent).line));
  return moves.map((point, index) => {
    const defense = threats.get(pointKey(point)) ?? 0;
    // Protect a threatened branch before the candidate cap, without making
    // every harmless one-line cut outrank a profitable counterattack.
    const tier = defense >= MINIMAX_WEIGHTS.lostNodes ? 0 : enemyLines.has(engine._getState(point)) ? 1
      : engine.getAdjacentPositions(point).some((adjacent) => engine._getState(adjacent) === ownLine) ? 2 : 3;
    return { point, index, defense, tier };
  }).sort((left, right) => left.tier - right.tier || right.defense - left.defense || left.index - right.index)
    .slice(0, 20).map(({ point }) => point);
}

class MinimaxAI {
  constructor(depth = 3) {
    this.depth = depth;
  }

  getLegalMoves(engine, player) {
    return engine.getLegalMoves(player).map((move) => move.point);
  }

  orderMoves(engine, moves, player) {
    return orderMinimaxMoves(engine, moves, player);
  }

  evaluate(engine, player) {
    if (engine.gameOver) {
      // A voluntary PASS can end the game while placements still exist.  Once
      // that happens, compare the canonical rule result instead of letting a
      // nonterminal reach/coverage heuristic decide whether ending was good.
      // getWinner() refreshes exact terminal territory when the display cache
      // is pending; the enclosing search snapshot restores that cache.
      const winner = engine.getWinner();
      if (winner === "DRAW") return 0;
      return winner === player ? 1_000_000 : -1_000_000;
    }
    return evaluateMinimax(engine, player);
  }

  minimax(engine, depth, alpha, beta, aiPlayer) {
    if (engine.gameOver || depth === 0) {
      return this.evaluate(engine, aiPlayer);
    }

    const legalMoves = this.getLegalMoves(engine, engine.currentPlayer);
    const ordered = this.orderMoves(engine, legalMoves, engine.currentPlayer);
    const actions = [...ordered, null];
    // Automatic skip normalization can leave the same player in control.
    // Derive MAX/MIN from the engine state instead of recursion depth parity.
    const maximizingPlayer = engine.currentPlayer === aiPlayer;
    if (maximizingPlayer) {
      let bestValue = Number.NEGATIVE_INFINITY;
      for (const point of actions) {
        const snapshot = saveState(engine);
        try {
          const applied = applyMinimaxAction(engine, point, depth === 1);
          if (applied) {
            const value = this.minimax(engine, depth - 1, alpha, beta, aiPlayer);
            bestValue = Math.max(bestValue, value);
            alpha = Math.max(alpha, bestValue);
          }
        } finally {
          restoreState(engine, snapshot);
        }
        if (beta <= alpha) {
          break;
        }
      }
      return bestValue;
    }

    let bestValue = Number.POSITIVE_INFINITY;
    for (const point of actions) {
      const snapshot = saveState(engine);
      try {
        const applied = applyMinimaxAction(engine, point, depth === 1);
        if (applied) {
          const value = this.minimax(engine, depth - 1, alpha, beta, aiPlayer);
          bestValue = Math.min(bestValue, value);
          beta = Math.min(beta, bestValue);
        }
      } finally {
        restoreState(engine, snapshot);
      }
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
      const ordered = this.orderMoves(engine, legalMoves, aiPlayer);
      // The first move of an unavoidable two-cut sequence can be a reinforcing
      // placement on an empty point, so compare the bounded leading window,
      // rather than only moves that already occupy a line.
      const rootCutChainEligible = new Set(ordered.map(pointKey));
      const previousOpponentMaterial = this.depth > 1
        ? opponentRiskMaterial(engine, aiPlayer) : 0;
      const scoredMoves = [];
      for (const point of [...ordered, null]) {
        const snapshot = saveState(engine);
        try {
          const applied = applyMinimaxAction(engine, point, this.depth <= 1);
          if (applied) {
            // At depth 1 the leaf already prices this exact exposure. Deeper
            // searches also get a conservative preference at the real choice;
            // a speculative later recovery should not erase an imminent cut.
            const immediateRisk = this.depth > 1
              ? immediateRiskPenalty(engine, aiPlayer, previousOpponentMaterial) : 0;
            const score = this.minimax(
              engine,
              this.depth - 1,
              Number.NEGATIVE_INFINITY,
              Number.POSITIVE_INFINITY,
              aiPlayer,
            );
            scoredMoves.push({
              point,
              ...(point === null ? { type: "pass" } : {}),
              score: score - MINIMAX_WEIGHTS.rootRiskAversion * immediateRisk,
            });
          }
        } finally {
          restoreState(engine, snapshot);
        }
      }

      scoredMoves.sort((a, b) => b.score - a.score);
      if (this.depth > 1) {
        applyRootCutChainPreference(engine, aiPlayer, scoredMoves, rootCutChainEligible);
      }
      // Existing placement callers use topN as a list of alternative points.
      // PASS only needs to leave the search when it is the selected action;
      // omitting a lower-ranked pass keeps those alternatives and their frozen
      // ordering stable while still making PASS a real root candidate.
      const selectedPass = scoredMoves[0]?.point === null ? scoredMoves[0] : null;
      const placementMoves = scoredMoves.filter(({ point }) => point !== null);
      return (selectedPass ? [selectedPass, ...placementMoves] : placementMoves).slice(0, topN);
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

export { GreedyAI, MCTSAI, MinimaxAI, MINIMAX_WEIGHTS, boundedRootCutChainAttack, boundedRootCutChainRisk, cutAnalysis, evaluate, evaluateMinimax, fastTerritoryBFS, saveState, restoreState };
