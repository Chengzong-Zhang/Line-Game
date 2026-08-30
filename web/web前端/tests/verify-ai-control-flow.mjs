import assert from "node:assert/strict";
import {
  GameEngine,
  Player,
  TerritoryRulesVersion,
} from "../GameEngine.js?v=20260830a";
import {
  MinimaxAI,
  evaluate,
  restoreState,
  saveState,
} from "../AIEngine.js?v=20260830a";

const CONTROL_SKIP_PREFIX = Object.freeze([
  Object.freeze({ player: Player.BLACK, point: Object.freeze([0, 4]) }),
  Object.freeze({ player: Player.WHITE, point: Object.freeze([1, 3]) }),
  Object.freeze({ player: Player.BLACK, point: Object.freeze([0, 3]) }),
  Object.freeze({ player: Player.WHITE, point: Object.freeze([1, 2]) }),
  Object.freeze({ player: Player.BLACK, point: Object.freeze([1, 0]) }),
]);

const CONTROL_SKIP_EXPECTED_SCORES = Object.freeze([
  Object.freeze(["0,2", 376]),
  Object.freeze(["2,0", 376]),
  Object.freeze(["3,0", 303]),
  Object.freeze(["3,1", 376]),
]);

const MIN_CONTROL_SKIP_PREFIX = Object.freeze([
  Object.freeze({ player: Player.BLACK, point: Object.freeze([2, 0]) }),
  Object.freeze({ player: Player.WHITE, point: Object.freeze([3, 0]) }),
  Object.freeze({ player: Player.BLACK, point: Object.freeze([2, 1]) }),
]);

const MIN_CONTROL_SKIP_EXPECTED_SCORES = Object.freeze([
  Object.freeze(["0,4", -289]),
  Object.freeze(["1,3", -289]),
  Object.freeze(["2,2", -4]),
]);

function pointKey(point) {
  return `${point[0]},${point[1]}`;
}

function captureEngineState(engine) {
  return {
    ruleState: saveState(engine),
    publicSnapshot: engine.getSnapshot(),
  };
}

function assertEngineStateUnchanged(engine, expected, label) {
  assert.deepEqual(saveState(engine), expected.ruleState, `${label}: mutable rule state drifted`);
  assert.deepEqual(engine.getSnapshot(), expected.publicSnapshot, `${label}: public snapshot drifted`);
}

function applyMoveOrThrow(engine, point, label) {
  const result = engine.playMove(point);
  assert.equal(result.success, true, `${label}: ${pointKey(point)} failed with ${result.reason}`);
}

function createEngineFromPrefix(prefix, label) {
  const engine = new GameEngine({
    gridSize: 5,
    playerCount: 2,
    rulesVersion: TerritoryRulesVersion.V2,
  });

  for (const [index, action] of prefix.entries()) {
    assert.equal(
      engine.currentPlayer,
      action.player,
      `${label} prefix ${index + 1}: unexpected player`,
    );
    applyMoveOrThrow(engine, action.point, `${label} prefix ${index + 1}`);
  }

  return engine;
}

function referenceMinimax(ai, engine, depth, alpha, beta, aiPlayer) {
  if (engine.gameOver || depth === 0) {
    return evaluate(engine, aiPlayer);
  }

  const legalMoves = ai.getLegalMoves(engine, engine.currentPlayer);
  if (legalMoves.length === 0) {
    const snapshot = saveState(engine);
    try {
      engine.consecutiveSkips += 1;
      if (engine.consecutiveSkips >= engine.activePlayers.length) {
        engine.gameOver = true;
      } else {
        engine._switchPlayer();
      }
      return referenceMinimax(ai, engine, depth - 1, alpha, beta, aiPlayer);
    } finally {
      restoreState(engine, snapshot);
    }
  }

  const maximizingPlayer = engine.currentPlayer === aiPlayer;
  const orderedMoves = ai.orderMoves(engine, legalMoves, engine.currentPlayer);
  let bestValue = maximizingPlayer
    ? Number.NEGATIVE_INFINITY
    : Number.POSITIVE_INFINITY;

  for (const point of orderedMoves) {
    const snapshot = saveState(engine);
    try {
      applyMoveOrThrow(engine, point, "reference search");
      const value = referenceMinimax(ai, engine, depth - 1, alpha, beta, aiPlayer);
      if (maximizingPlayer) {
        bestValue = Math.max(bestValue, value);
        alpha = Math.max(alpha, bestValue);
      } else {
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

function referenceTopMoves(ai, engine, aiPlayer) {
  const legalMoves = ai.getLegalMoves(engine, aiPlayer);
  const orderedMoves = ai.orderMoves(engine, legalMoves, aiPlayer);
  const scoredMoves = [];

  for (const point of orderedMoves) {
    const snapshot = saveState(engine);
    try {
      applyMoveOrThrow(engine, point, "reference root");
      scoredMoves.push({
        point: [...point],
        score: referenceMinimax(
          ai,
          engine,
          ai.depth - 1,
          Number.NEGATIVE_INFINITY,
          Number.POSITIVE_INFINITY,
          aiPlayer,
        ),
      });
    } finally {
      restoreState(engine, snapshot);
    }
  }

  scoredMoves.sort((left, right) => right.score - left.score);
  return scoredMoves;
}

function sortedScoreEntries(moves) {
  return moves
    .map(({ point, score }) => [pointKey(point), score])
    .sort(([left], [right]) => left.localeCompare(right));
}

const engine = createEngineFromPrefix(CONTROL_SKIP_PREFIX, "CONTROL-SKIP MAX");

assert.equal(engine.currentPlayer, Player.WHITE, "CONTROL-SKIP root must belong to WHITE");
assert.equal(engine.gameOver, false, "CONTROL-SKIP root must be non-terminal");

const ai = new MinimaxAI(3);
const rootPlayer = engine.currentPlayer;
const rootMoves = ai.getLegalMoves(engine, rootPlayer);
assert.equal(rootMoves.length, 4, "CONTROL-SKIP witness must retain four legal root moves");

const baseline = captureEngineState(engine);
for (const point of rootMoves) {
  const snapshot = saveState(engine);
  try {
    applyMoveOrThrow(engine, point, "CONTROL-SKIP transition");
    assert.equal(engine.gameOver, false, `${pointKey(point)} must remain non-terminal`);
    assert.equal(
      engine.currentPlayer,
      rootPlayer,
      `${pointKey(point)} must return control to WHITE after BLACK auto-skips`,
    );
    assert.equal(
      engine.consecutiveSkips,
      1,
      `${pointKey(point)} must record exactly one automatic skip`,
    );
  } finally {
    restoreState(engine, snapshot);
  }
}
assertEngineStateUnchanged(engine, baseline, "CONTROL-SKIP transition probe");

const productionMoves = ai.getTopMoves(engine, rootPlayer, 20);
assertEngineStateUnchanged(engine, baseline, "production Minimax");

assert.deepEqual(
  sortedScoreEntries(productionMoves),
  CONTROL_SKIP_EXPECTED_SCORES,
  "CONTROL-SKIP frozen witness scores drifted",
);

const referenceMoves = referenceTopMoves(ai, engine, rootPlayer);
assertEngineStateUnchanged(engine, baseline, "reference Minimax");

assert.deepEqual(
  sortedScoreEntries(productionMoves),
  sortedScoreEntries(referenceMoves),
  "Minimax must derive MAX/MIN from the actual currentPlayer after automatic skip normalization",
);

const minControlEngine = createEngineFromPrefix(
  MIN_CONTROL_SKIP_PREFIX,
  "CONTROL-SKIP MIN",
);
assert.equal(
  minControlEngine.currentPlayer,
  Player.WHITE,
  "CONTROL-SKIP MIN root must belong to WHITE",
);
assert.equal(minControlEngine.gameOver, false, "CONTROL-SKIP MIN root must be non-terminal");

const minControlAI = new MinimaxAI(3);
const minControlRootPlayer = minControlEngine.currentPlayer;
const minControlRootMoves = minControlAI.getLegalMoves(
  minControlEngine,
  minControlRootPlayer,
);
assert.deepEqual(
  minControlRootMoves.map(pointKey).sort(),
  ["0,4", "1,3", "2,2"],
  "CONTROL-SKIP MIN witness root moves drifted",
);

const minControlBaseline = captureEngineState(minControlEngine);
const minTransitionSnapshot = saveState(minControlEngine);
try {
  applyMoveOrThrow(minControlEngine, [1, 3], "CONTROL-SKIP MIN root transition");
  assert.equal(
    minControlEngine.currentPlayer,
    Player.BLACK,
    "BLACK must receive control after WHITE plays 1,3",
  );
  applyMoveOrThrow(minControlEngine, [2, 2], "CONTROL-SKIP MIN continuation");
  assert.equal(
    minControlEngine.currentPlayer,
    Player.BLACK,
    "BLACK must retain control after WHITE auto-skips",
  );
  assert.equal(
    minControlEngine.consecutiveSkips,
    1,
    "CONTROL-SKIP MIN must record exactly one automatic skip",
  );
  assert.deepEqual(
    minControlAI
      .getLegalMoves(minControlEngine, minControlEngine.currentPlayer)
      .map(pointKey)
      .sort(),
    ["0,1", "0,2", "0,3", "0,4"],
    "CONTROL-SKIP MIN continuation moves drifted",
  );
} finally {
  restoreState(minControlEngine, minTransitionSnapshot);
}
assertEngineStateUnchanged(minControlEngine, minControlBaseline, "CONTROL-SKIP MIN probe");

const minControlProductionMoves = minControlAI.getTopMoves(
  minControlEngine,
  minControlRootPlayer,
  20,
);
assertEngineStateUnchanged(
  minControlEngine,
  minControlBaseline,
  "CONTROL-SKIP MIN production Minimax",
);
assert.deepEqual(
  sortedScoreEntries(minControlProductionMoves),
  MIN_CONTROL_SKIP_EXPECTED_SCORES,
  "CONTROL-SKIP MIN frozen root scores drifted",
);

const minControlReferenceMoves = referenceTopMoves(
  minControlAI,
  minControlEngine,
  minControlRootPlayer,
);
assertEngineStateUnchanged(
  minControlEngine,
  minControlBaseline,
  "CONTROL-SKIP MIN reference Minimax",
);
assert.deepEqual(
  sortedScoreEntries(minControlProductionMoves),
  sortedScoreEntries(minControlReferenceMoves),
  "the opponent must keep minimizing when automatic skip leaves it in control",
);

console.log(JSON.stringify({
  witness: "CONTROL-SKIP",
  maxContinuation: {
    rootPlayer,
    rootMoves,
    scores: sortedScoreEntries(productionMoves),
  },
  minContinuation: {
    rootPlayer: minControlRootPlayer,
    rootMoves: minControlRootMoves,
    scores: sortedScoreEntries(minControlProductionMoves),
  },
  engineStatePreserved: true,
}, null, 2));
