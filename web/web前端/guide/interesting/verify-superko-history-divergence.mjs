import fs from "node:fs/promises";

const engineUrl = new URL("../../GameEngine.js", import.meta.url);
const source = await fs.readFile(engineUrl, "utf8");
const { GameEngine, Player } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);

const B = Player.BLACK;
const W = Player.WHITE;
const moves = [
  [0, 5], [3, 0], [1, 0], [4, 1], [0, 4], [0, 3], [1, 2],
  [0, 5], [0, 4], [1, 1], [3, 1], [1, 4], [3, 2],
];
const pairedHistories = {
  withoutKey: [[1, 0], [4, 1], [1, 2], [1, 4], [0, 4], [2, 3], [3, 2]],
  withKey: [
    [1, 0], [4, 1], [0, 4], [1, 1], [3, 1],
    [1, 4], [1, 2], [1, 3], [3, 2],
  ],
};
const naturalCycleActions = [
  [0, 1], [4, 0], [2, 0], [1, 4], [2, 3],
  [2, 2], [3, 1], [1, 4], null, [1, 1],
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function cloneTerritories(game) {
  return Object.fromEntries(game.activePlayers.map((player) => [
    player,
    {
      ...game.cachedTerritories[player],
      polygon: game.cachedTerritories[player].polygon?.map((point) => [...point]) ?? null,
    },
  ]));
}

function cloneGame(game, disableTerritoryUpdates = false) {
  const clone = Object.assign(Object.create(Object.getPrototypeOf(game)), game);
  clone.grid = new Map(game.grid);
  clone.edges = Object.fromEntries(game.activePlayers.map((player) => [player, new Set(game.edges[player])]));
  clone.resignedPlayers = new Set(game.resignedPlayers);
  clone.historyHashes = new Set(game.historyHashes);
  clone.cachedTerritories = cloneTerritories(game);
  clone._bfsQueue = new Int32Array(game._bfsQueue.length);
  clone._bfsWall = new Int32Array(game._bfsWall.length);
  clone._bfsWater = new Int32Array(game._bfsWater.length);
  if (disableTerritoryUpdates) clone._updateTerritories = () => {};
  return clone;
}

function area(game) {
  return Object.fromEntries(game.activePlayers.map((player) => [player, game.cachedTerritories[player].area]));
}

function ruleKernelKey(game) {
  return JSON.stringify([
    game._computeStateHash(game.currentPlayer),
    game.consecutiveSkips,
    game.gameOver,
  ]);
}

function replay(history, label) {
  const game = new GameEngine({ gridSize: 6, playerCount: 2 });
  history.forEach((point, index) => {
    const result = game.playMove(point);
    assert(result.success, `${label} move ${index + 1} ${point} failed: ${result.reason}`);
  });
  return game;
}

function replayActions(actions, label) {
  const game = new GameEngine({ gridSize: 6, playerCount: 2 });
  actions.forEach((point, index) => {
    const result = point === null ? game.skipTurn() : game.playMove(point);
    assert(result.success, `${label} action ${index + 1} ${point ?? "PASS"} failed: ${result.reason}`);
  });
  return game;
}

function sortedLegalPoints(game) {
  return game.getLegalMoves()
    .map((move) => move.point)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function freezeWinner(game) {
  const frozen = cloneGame(game);
  let guard = 0;
  while (!frozen.gameOver && guard < 4) {
    const result = frozen.skipTurn();
    if (!result.success) throw new Error(`freeze Pass failed: ${result.reason}`);
    guard += 1;
  }
  if (!frozen.gameOver) throw new Error("freeze did not terminate");
  return { winner: frozen.getWinner(), area: area(frozen), passes: guard };
}

function solveExactly(root, targetPlayer, nodeLimit = 500000) {
  const memo = new Map();
  let nodes = 0;

  function utility(game) {
    const scoringPlayers = game.activePlayers.filter((player) => !game.resignedPlayers.has(player));
    const candidatePlayers = scoringPlayers.length > 0 ? scoringPlayers : game.activePlayers;
    const exactAreas = Object.fromEntries(
      candidatePlayers.map((player) => [player, game._computeTerritory(player).area]),
    );
    const best = Math.max(...Object.values(exactAreas));
    const winners = candidatePlayers.filter((player) => exactAreas[player] === best);
    const winner = winners.length === 1 ? winners[0] : "DRAW";
    if (winner === "DRAW") return 0;
    return winner === targetPlayer ? 1 : -1;
  }

  function keyOf(game) {
    return JSON.stringify([
      game._computeStateHash(game.currentPlayer),
      game.consecutiveSkips,
      game.gameOver,
      [...game.historyHashes].sort(),
    ]);
  }

  function actionsOf(game) {
    const placements = game.getLegalMoves()
      .sort((a, b) => Number(b.isAttack) - Number(a.isAttack))
      .map((move) => ({ type: "place", point: move.point }));
    return [...placements, { type: "pass" }];
  }

  function apply(game, action) {
    const child = cloneGame(game, true);
    const result = action.type === "pass"
      ? child.skipTurn()
      : child.playMove(action.point);
    if (!result.success) throw new Error(`solver action failed: ${JSON.stringify(action)} ${result.reason}`);
    return child;
  }

  function visit(game) {
    nodes += 1;
    if (nodes > nodeLimit) throw new Error(`NODE_LIMIT:${nodeLimit}`);
    if (game.gameOver) return utility(game);
    const key = keyOf(game);
    if (memo.has(key)) return memo.get(key);

    const maximizing = game.currentPlayer === targetPlayer;
    let best = maximizing ? -1 : 1;
    for (const action of actionsOf(game)) {
      const value = visit(apply(game, action));
      if (maximizing) {
        if (value > best) best = value;
        if (best === 1) break;
      } else {
        if (value < best) best = value;
        if (best === -1) break;
      }
    }
    memo.set(key, best);
    return best;
  }

  const rootActions = actionsOf(root);
  const actionValues = [];
  for (const action of rootActions) {
    actionValues.push({ action, value: visit(apply(root, action)) });
  }
  const rootValue = root.currentPlayer === targetPlayer
    ? Math.max(...actionValues.map(({ value }) => value))
    : Math.min(...actionValues.map(({ value }) => value));
  return { targetPlayer, rootValue, actionValues, nodes, memoSize: memo.size };
}

const pairedWithoutKey = replay(pairedHistories.withoutKey, "paired history without key");
const pairedWithKey = replay(pairedHistories.withKey, "paired history with key");
assert(
  ruleKernelKey(pairedWithoutKey) === ruleKernelKey(pairedWithKey),
  "paired histories did not reach the same rules kernel",
);
assert(
  JSON.stringify(area(pairedWithoutKey)) === JSON.stringify({ [B]: 11, [W]: 0 })
    && JSON.stringify(area(pairedWithKey)) === JSON.stringify({ [B]: 11, [W]: 0 }),
  "paired histories have unexpected areas",
);
assert(
  pairedWithoutKey.historyHashes.size === 8 && pairedWithKey.historyHashes.size === 10,
  "paired histories have unexpected history sizes",
);

const pairedCandidate = [1, 1];
const withoutKeyEvaluation = pairedWithoutKey._evaluateMove(pairedCandidate);
const withKeyEvaluation = pairedWithKey._evaluateMove(pairedCandidate);
assert(withoutKeyEvaluation.legal, "paired candidate should be legal without the old key");
assert(
  !withKeyEvaluation.legal && withKeyEvaluation.reason === "SUPERKO_VIOLATION",
  "paired candidate should fail only by Superko with the old key",
);
const pairedProbe = cloneGame(pairedWithKey, true);
assert(pairedProbe._addNode(pairedCandidate), "paired candidate should pass all local rules");
const pairedCandidateHash = pairedProbe._computeStateHash(
  pairedProbe._getNextPlayer(pairedProbe.currentPlayer),
);
assert(!pairedWithoutKey.historyHashes.has(pairedCandidateHash), "old key unexpectedly occurs in H-");
assert(pairedWithKey.historyHashes.has(pairedCandidateHash), "old key should occur in H+");

const expectedWithoutKeyMoves = [[1, 1], [2, 0], [2, 1], [3, 0]];
const expectedWithKeyMoves = [[2, 0], [2, 1], [3, 0]];
assert(
  JSON.stringify(sortedLegalPoints(pairedWithoutKey)) === JSON.stringify(expectedWithoutKeyMoves),
  "unexpected legal Place set for H-",
);
assert(
  JSON.stringify(sortedLegalPoints(pairedWithKey)) === JSON.stringify(expectedWithKeyMoves),
  "unexpected legal Place set for H+",
);

let pairedExactSolveWithoutKey = null;
let pairedExactSolveWithKey = null;
if (process.argv.includes("--solve-paired")) {
  try {
    const pairedNodeLimit = Number(process.env.LIFELINE_PAIRED_NODE_LIMIT ?? 500000);
    pairedExactSolveWithoutKey = solveExactly(pairedWithoutKey, W, pairedNodeLimit);
    pairedExactSolveWithKey = solveExactly(pairedWithKey, W, pairedNodeLimit);
  } catch (error) {
    const failure = { error: error instanceof Error ? error.message : String(error) };
    if (pairedExactSolveWithoutKey === null) pairedExactSolveWithoutKey = failure;
    else pairedExactSolveWithKey = failure;
  }
}

let naturalCycleExact = null;
if (process.argv.includes("--solve-natural-cycle")) {
  try {
    const root = replayActions(naturalCycleActions, "natural cycle");
    const candidate = [2, 3];
    const evaluation = root._evaluateMove(candidate);
    assert(
      !evaluation.legal && evaluation.reason === "SUPERKO_VIOLATION",
      "natural cycle candidate should be rejected only by Superko",
    );
    const probe = cloneGame(root, true);
    const actor = probe.currentPlayer;
    assert(probe._addNode(candidate), "natural cycle candidate should pass all local rules");
    const repeatedKey = probe._computeStateHash(probe._getNextPlayer(actor));
    const withoutKey = cloneGame(root, true);
    assert(withoutKey.historyHashes.delete(repeatedKey), "natural cycle repeated key should exist");
    assert(withoutKey._evaluateMove(candidate).legal, "deleting the repeated key should restore the candidate");
    const nodeLimit = Number(process.env.LIFELINE_NATURAL_NODE_LIMIT ?? 500000);
    naturalCycleExact = {
      history: naturalCycleActions,
      candidate,
      withKey: solveExactly(root, actor, nodeLimit),
      withoutKey: solveExactly(withoutKey, actor, nodeLimit),
    };
  } catch (error) {
    naturalCycleExact = { error: error instanceof Error ? error.message : String(error) };
  }
}

const game = new GameEngine({ gridSize: 6, playerCount: 2 });
const hashTimeline = [{ ply: 0, player: null, point: null, hash: [...game.historyHashes][0] }];
const stateTimeline = [{ ply: 0, area: area(game) }];
const kernelTimeline = [{ ply: 0, key: ruleKernelKey(game) }];

moves.forEach((point, index) => {
  const player = game.currentPlayer;
  const beforeHashes = new Set(game.historyHashes);
  const result = game.playMove(point);
  if (!result.success) throw new Error(`move ${index + 1} ${player} ${point} failed: ${result.reason}`);
  const added = [...game.historyHashes].filter((hash) => !beforeHashes.has(hash));
  if (added.length !== 1) throw new Error(`move ${index + 1} did not add exactly one hash`);
  hashTimeline.push({ ply: index + 1, player, point, hash: added[0] });
  stateTimeline.push({ ply: index + 1, area: area(game) });
  kernelTimeline.push({ ply: index + 1, key: ruleKernelKey(game) });
});

const candidate = [0, 3];
const candidateEvaluation = game._evaluateMove(candidate);
if (candidateEvaluation.reason !== "SUPERKO_VIOLATION") {
  throw new Error(`expected Superko violation, got ${candidateEvaluation.reason}`);
}

const repeated = cloneGame(game);
const repeatedActor = repeated.currentPlayer;
if (!repeated._addNode(candidate)) throw new Error("candidate should pass all non-Superko rules");
const repeatedHash = repeated._computeStateHash(repeated._getNextPlayer(repeatedActor));
const repeatedAt = hashTimeline.find((entry) => entry.hash === repeatedHash);
if (!repeatedAt) throw new Error("candidate hash was not found in the legal history");
repeated.consecutiveSkips = 0;
repeated._switchPlayer();
repeated._checkAndAutoSkip();
repeated._updateTerritories();
assert(ruleKernelKey(repeated) === kernelTimeline[6].key, "counterfactual move did not close the X6-X13 cycle");

const legalMoves = game.getLegalMoves();
const legalMoveFreezes = legalMoves.map((move) => {
  const child = cloneGame(game);
  const result = child.playMove(move.point);
  if (!result.success) throw new Error(`legal move ${move.point} failed during replay`);
  return { point: move.point, immediateArea: area(child), freeze: freezeWinner(child) };
});

let exactSolve = null;
let exactSolveWithoutRepeatedKey = null;
if (process.argv.includes("--solve")) {
  try {
    exactSolve = solveExactly(game, W, Number(process.env.LIFELINE_NODE_LIMIT ?? 500000));
    const withoutRepeatedKey = cloneGame(game, true);
    if (!withoutRepeatedKey.historyHashes.delete(repeatedHash)) {
      throw new Error("expected repeated history key to be removable");
    }
    const restoredEvaluation = withoutRepeatedKey._evaluateMove(candidate);
    if (!restoredEvaluation.legal) {
      throw new Error(`candidate should become legal after deleting one key: ${restoredEvaluation.reason}`);
    }
    exactSolveWithoutRepeatedKey = solveExactly(
      withoutRepeatedKey,
      W,
      Number(process.env.LIFELINE_NODE_LIMIT ?? 500000),
    );
  } catch (error) {
    const failure = { error: error instanceof Error ? error.message : String(error) };
    if (exactSolve === null) exactSolve = failure;
    else exactSolveWithoutRepeatedKey = failure;
  }
}

function actionValueObject(solution) {
  return Object.fromEntries(solution.actionValues.map(({ action, value }) => [
    action.type === "pass" ? "pass" : `place:${action.point.join(",")}`,
    value,
  ]));
}

if (exactSolve && !exactSolve.error && exactSolveWithoutRepeatedKey && !exactSolveWithoutRepeatedKey.error) {
  assert(exactSolve.rootValue === 1, "H+ root should be a WHITE win");
  assert(exactSolveWithoutRepeatedKey.rootValue === 1, "H- root should be a WHITE win");
  assert(
    JSON.stringify(actionValueObject(exactSolve)) === JSON.stringify({
      "place:2,0": 1,
      "place:2,1": 1,
      "place:1,2": -1,
      pass: -1,
    }),
    "unexpected H+ exact action values",
  );
  assert(
    JSON.stringify(actionValueObject(exactSolveWithoutRepeatedKey)) === JSON.stringify({
      "place:0,3": 1,
      "place:2,0": 1,
      "place:2,1": 1,
      "place:1,2": -1,
      pass: -1,
    }),
    "unexpected H- exact action values",
  );
}

console.log(JSON.stringify({
  reachableHistoryPair: {
    withoutKeyHistory: pairedHistories.withoutKey,
    withKeyHistory: pairedHistories.withKey,
    sameRulesKernel: true,
    area: area(pairedWithoutKey),
    historyHashCounts: {
      withoutKey: pairedWithoutKey.historyHashes.size,
      withKey: pairedWithKey.historyHashes.size,
    },
    candidate: pairedCandidate,
    withoutKeyEvaluation,
    withKeyEvaluation,
    legalPlacements: {
      withoutKey: sortedLegalPoints(pairedWithoutKey),
      withKey: sortedLegalPoints(pairedWithKey),
    },
    exactSolveWithoutKey: pairedExactSolveWithoutKey,
    exactSolveWithKey: pairedExactSolveWithKey,
  },
  naturalCycleExact,
  current: {
    player: game.currentPlayer,
    area: area(game),
    consecutiveSkips: game.consecutiveSkips,
    historyHashCount: game.historyHashes.size,
    freeze: freezeWinner(game),
  },
  history: moves.map((point, index) => ({
    ply: index + 1,
    player: hashTimeline[index + 1].player,
    point,
    area: stateTimeline[index + 1].area,
  })),
  superkoMove: {
    player: game.currentPlayer,
    point: candidate,
    originalState: candidateEvaluation.state,
    isAttack: candidateEvaluation.isAttack,
    repeatsPly: repeatedAt.ply,
    repeatedPlyMove: { player: repeatedAt.player, point: repeatedAt.point },
    closesProjectedEightEdgeCycle: true,
    counterfactualAreaIfRepetitionAllowed: area(repeated),
    counterfactualFreezeIfRepetitionAllowed: freezeWinner(repeated),
  },
  legalMoveFreezes,
  exactSolve,
  exactSolveWithoutRepeatedKey,
}, null, 2));
