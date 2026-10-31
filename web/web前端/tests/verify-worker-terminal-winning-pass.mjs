import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { GameEngine } from "../GameEngine.js?v=20261025-room1";
import { serializeEngineState } from "../AIStateProtocol.js?v=20261025-room1";

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

function copyEngine(source) {
  const copy = new GameEngine({
    gridSize: source.gridSize,
    playerCount: source.playerCount,
    boardShape: source.boardShape,
    startPlayer: source.startPlayer,
    initialPositions: source.initialPositions,
    rulesVersion: source.rulesVersion,
    deferTerritoryUpdates: true,
  });
  copy._restoreReplayState(source._captureReplayState());
  copy._isReplayingBatch = true;
  return copy;
}

function exactAreas(engine) {
  GameEngine.prototype._updateTerritories.call(engine);
  return Object.fromEntries(engine.activePlayers.map((player) => [player, engine.cachedTerritories[player].area]));
}

function bestAreaMove(engine, player) {
  let best = null;
  for (const move of engine.getLegalMoves(player)) {
    const trial = copyEngine(engine);
    assert.equal(trial.playMove(move.point).success, true);
    const area = exactAreas(trial)[player];
    if (!best || area > best.area || area === best.area
        && (move.point[1] < best.point[1]
          || move.point[1] === best.point[1] && move.point[0] < best.point[0])) {
      best = { point: move.point, area };
    }
  }
  assert.ok(best, "Winning PASS fixture needs a legal placement");
  return best.point;
}

function winningFixture(rulesVersion, playerCount = 2) {
  const engine = new GameEngine({ playerCount, gridSize: 5, rulesVersion, deferTerritoryUpdates: true });
  engine._isReplayingBatch = true;
  const actor = engine.currentPlayer;
  for (let round = 0; round < 4; round += 1) {
    assert.equal(engine.currentPlayer, actor);
    assert.equal(engine.playMove(bestAreaMove(engine, actor)).success, true);
    while (!engine.gameOver && engine.currentPlayer !== actor) assert.equal(engine.skipTurn().success, true);
    assert.equal(engine.consecutiveSkips, playerCount - 1);
    const terminal = copyEngine(engine);
    assert.equal(terminal.skipTurn().success, true);
    assert.equal(terminal.gameOver, true);
    exactAreas(terminal);
    if (terminal.getWinner() === actor) return engine;
  }
  assert.fail("Could not build a unique terminal PASS winner");
}

function drawFixture(rulesVersion) {
  const engine = new GameEngine({ playerCount: 2, gridSize: 5, startPlayer: "WHITE",
    rulesVersion, deferTerritoryUpdates: true });
  engine._isReplayingBatch = true;
  assert.equal(engine.skipTurn().success, true);
  assert.equal(engine.currentPlayer, "BLACK");
  assert.equal(engine.consecutiveSkips, 1);
  const terminal = copyEngine(engine);
  assert.equal(terminal.skipTurn().success, true);
  exactAreas(terminal);
  assert.equal(terminal.getWinner(), "DRAW");
  return engine;
}

function losingFixture() {
  const engine = new GameEngine({ playerCount: 2, gridSize: 5, startPlayer: "WHITE",
    rulesVersion: "territory-v3", deferTerritoryUpdates: true });
  engine._isReplayingBatch = true;
  assert.equal(engine.playMove([2, 0]).success, true);
  assert.equal(engine.playMove([1, 0]).success, true);
  assert.equal(engine.currentPlayer, "WHITE");
  assert.equal(engine.skipTurn().success, true);
  assert.equal(engine.currentPlayer, "BLACK");
  assert.equal(engine.consecutiveSkips, 1);
  assert.equal(engine._hasValidMoves("BLACK"), true);
  const terminal = copyEngine(engine);
  assert.equal(terminal.skipTurn().success, true);
  exactAreas(terminal);
  assert.equal(terminal.getWinner(), "WHITE");
  return engine;
}

function superkoBlockedFixture(rulesVersion) {
  const engine = winningFixture(rulesVersion);
  const player = engine.currentPlayer;
  const legal = engine.getLegalMoves(player).map(({ point }) => [...point]);
  assert.ok(legal.length > 0);
  for (const point of legal) {
    const trial = copyEngine(engine);
    const before = new Set(engine.historyHashes);
    assert.equal(trial.playMove(point).success, true);
    const generated = [...trial.historyHashes].filter((hash) => !before.has(hash));
    assert.equal(generated.length, 1);
    engine.historyHashes.add(generated[0]);
  }
  assert.equal(engine.getLegalMoves(player).length, 0);
  return engine;
}

const originalFetch = globalThis.fetch;
const originalSelf = globalThis.self;
const messages = [];
globalThis.fetch = async (input) => {
  const url = input instanceof URL ? input : new URL(input);
  if (url.protocol !== "file:") return originalFetch(input);
  return new Response(await readFile(fileURLToPath(url)), { status: 200 });
};
globalThis.self = { postMessage: (message) => messages.push(structuredClone(message)) };
await import(`../AIWorker.js?verify-worker-terminal-winning-pass=${Date.now()}`);

async function compute(engine, options) {
  const serializedState = serializeEngineState(engine);
  const serializedBefore = structuredClone(serializedState);
  const sourceBefore = structuredClone(engine._captureReplayState());
  messages.length = 0;
  await globalThis.self.onmessage({ data: {
    type: "COMPUTE",
    requestId: options.requestId,
    serializedState,
    aiPlayer: engine.currentPlayer,
    topN: options.topN ?? 5,
    ...options,
  } });
  assert.deepEqual(serializedState, serializedBefore, `${options.requestId}: serialized input changed`);
  assert.deepEqual(engine._captureReplayState(), sourceBefore, `${options.requestId}: source engine changed`);
  const result = messages.find((message) => message.type === "RESULT");
  assert.ok(result, `${options.requestId}: ${JSON.stringify(messages)}`);
  assert.equal(result.requestId, options.requestId);
  assert.equal(result.positionRevision, serializedState.positionRevision);
  assert.equal(result.rulesVersion, serializedState.rulesVersion);
  assert.equal(result.currentPlayer, serializedState.currentPlayer);
  return result;
}

async function computeError(engine, options, pattern) {
  const serializedState = serializeEngineState(engine);
  const serializedBefore = structuredClone(serializedState);
  const sourceBefore = structuredClone(engine._captureReplayState());
  messages.length = 0;
  await globalThis.self.onmessage({ data: {
    type: "COMPUTE",
    requestId: options.requestId,
    serializedState,
    aiPlayer: engine.currentPlayer,
    topN: options.topN ?? 5,
    ...options,
  } });
  assert.deepEqual(serializedState, serializedBefore, `${options.requestId}: serialized input changed`);
  assert.deepEqual(engine._captureReplayState(), sourceBefore, `${options.requestId}: source engine changed`);
  assert.equal(messages.some((message) => message.type === "RESULT"), false,
    `${options.requestId}: an incompatible route must not short-circuit to PASS`);
  const error = messages.find((message) => message.type === "ERROR");
  assert.ok(error, `${options.requestId}: ${JSON.stringify(messages)}`);
  assert.equal(error.requestId, options.requestId);
  assert.match(error.message, pattern);
  return error;
}

const rows = [];
try {
  for (const rulesVersion of ["territory-v2", "territory-v3"]) {
    const winning = winningFixture(rulesVersion);
    assert.ok(winning.getLegalMoves(winning.currentPlayer).length > 0);
    const winResult = await compute(winning, { strategy: "greedy", requestId: `greedy-win-${rulesVersion}` });
    assert.deepEqual(winResult.moves, [{ point: null, type: "pass", score: 1_000_000 }]);

    const draw = drawFixture(rulesVersion);
    assert.ok(draw.getLegalMoves(draw.currentPlayer).length > 0);
    const drawResult = await compute(draw, { strategy: "greedy", requestId: `greedy-draw-${rulesVersion}` });
    assert.ok(Array.isArray(drawResult.moves[0]?.point), "A terminal draw must keep the original Greedy decision");
    assert.equal(drawResult.moves[0]?.type, undefined);

    const ordinary = new GameEngine({ playerCount: 2, gridSize: 5, rulesVersion, deferTerritoryUpdates: true });
    assert.equal(ordinary.consecutiveSkips, 0);
    const ordinaryResult = await compute(ordinary, { strategy: "greedy", requestId: `greedy-ordinary-${rulesVersion}` });
    assert.ok(Array.isArray(ordinaryResult.moves[0]?.point), "An ordinary position must keep the original Greedy decision");
    assert.equal(ordinaryResult.moves[0]?.type, undefined);
    rows.push({ rulesVersion, winningPass: true, drawPreserved: true, ordinaryPreserved: true });
  }

  const losing = losingFixture();
  const losingResult = await compute(losing, { strategy: "greedy", requestId: "greedy-losing-pass" });
  assert.ok(Array.isArray(losingResult.moves[0]?.point), "A losing terminal PASS must keep the original decision");

  const alreadyTerminal = copyEngine(winningFixture("territory-v2"));
  assert.equal(alreadyTerminal.skipTurn().success, true);
  assert.equal(alreadyTerminal.gameOver, true);
  const terminalResult = await compute(alreadyTerminal, { strategy: "greedy", requestId: "greedy-terminal-state" });
  assert.deepEqual(terminalResult.moves, []);

  const topNZero = winningFixture("territory-v2");
  const originalHasValidForZero = GameEngine.prototype._hasValidMoves;
  GameEngine.prototype._hasValidMoves = function forbiddenTopNZeroProbe(player) {
    if (this.consecutiveSkips === 1 && this.currentPlayer === player) {
      throw new Error("topN=0 must not probe terminal PASS");
    }
    return originalHasValidForZero.call(this, player);
  };
  try {
    const zeroResult = await compute(topNZero, { strategy: "greedy", topN: 0, requestId: "greedy-topn-zero" });
    assert.deepEqual(zeroResult.moves, []);
  } finally {
    GameEngine.prototype._hasValidMoves = originalHasValidForZero;
  }

  const blocked = superkoBlockedFixture("territory-v2");
  const blockedResult = await compute(blocked, { strategy: "greedy", requestId: "greedy-superko-no-placement" });
  assert.deepEqual(blockedResult.moves, []);

  for (const mode of ["exception", "deadline"]) {
    const fallback = winningFixture("territory-v2");
    const originalHasValid = GameEngine.prototype._hasValidMoves;
    GameEngine.prototype._hasValidMoves = function guardedPassProbe(player) {
      if (this.consecutiveSkips === 1 && this.currentPlayer === player) {
        if (mode === "exception") throw new Error("Injected terminal PASS probe failure");
        const valid = originalHasValid.call(this, player);
        const end = performance.now() + 65;
        while (performance.now() < end) { /* bounded test-only delay */ }
        return valid;
      }
      return originalHasValid.call(this, player);
    };
    try {
      const fallbackResult = await compute(fallback, { strategy: "greedy", requestId: `greedy-pass-${mode}-fallback` });
      assert.ok(Array.isArray(fallbackResult.moves[0]?.point), `${mode}: original policy must survive PASS probe failure`);
    } finally {
      GameEngine.prototype._hasValidMoves = originalHasValid;
    }
  }

  const mctsWinning = winningFixture("territory-v2");
  const mctsResult = await compute(mctsWinning, { strategy: "mcts", simulations: 1, rolloutDepth: 1,
    requestId: "mcts-winning-pass" });
  assert.equal(mctsResult.moves[0]?.type, "pass");
  assert.equal(mctsResult.moves[0]?.point, null);

  const legacyWinning = winningFixture("territory-v2");
  const legacyResult = await compute(legacyWinning, { strategy: "neural-puct",
    modelId: "padded-cnn-d14-s20260825-g200", simulations: 1, requestId: "legacy-puct-winning-pass" });
  assert.equal(legacyResult.modelInfo.id, "padded-cnn-d14-s20260825-g200");
  assert.equal(legacyResult.moves[0]?.type, "pass");
  assert.equal(legacyResult.moves[0]?.point, null);

  const multiplayerWinners = [3, 4, 5, 6].map((playerCount) => ({
    playerCount, engine: winningFixture("territory-v2", playerCount),
  }));
  const originalHasValidMoves = GameEngine.prototype._hasValidMoves;
  let multiplayerPassProbes = 0;
  let readySeenDuringPassProbe = false;
  GameEngine.prototype._hasValidMoves = function guardedHasValidMoves(player) {
    if (this.playerCount >= 3 && this.playerCount <= 6
        && this.consecutiveSkips === this.playerCount - 1 && this.currentPlayer === player) {
      multiplayerPassProbes += 1;
      readySeenDuringPassProbe ||= messages.some((message) => message.type === "READY");
    }
    return originalHasValidMoves.call(this, player);
  };
  try {
    for (const { playerCount, engine } of multiplayerWinners) {
      const probesBefore = multiplayerPassProbes;
      const multiplayerResult = await compute(engine, { strategy: "multiplayer",
        modelId: "multiplayer-easy-v1", requestId: `multiplayer-winning-pass-p${playerCount}` });
      assert.equal(multiplayerResult.moves[0]?.type, "pass");
      assert.equal(multiplayerResult.moves[0]?.point, null);
      assert.equal(multiplayerPassProbes, probesBefore + 1,
        `P${playerCount}: Worker and runtime must not duplicate the terminal PASS probe`);
      assert.deepEqual(messages.filter((message) => ["READY", "RESULT"].includes(message.type))
        .map((message) => message.type), ["READY", "RESULT"]);
    }
  } finally {
    GameEngine.prototype._hasValidMoves = originalHasValidMoves;
  }
  assert.equal(multiplayerPassProbes, 4, "Every 3–6 player Worker route must probe exactly once");
  assert.equal(readySeenDuringPassProbe, false, "Terminal PASS probe must finish before multiplayer READY");

  const multiplayerWinning = multiplayerWinners[0].engine;
  await computeError(multiplayerWinning, { strategy: "neural-puct",
    modelId: "padded-cnn-d14-s20260825-g200", simulations: 1,
    requestId: "invalid-multiplayer-puct-pass" }, /不支持.*玩家数/);
  await computeError(multiplayerWinning, { strategy: "model-free",
    modelId: "supervised-d1-s20260901-g120",
    requestId: "invalid-multiplayer-model-free-pass" }, /仅支持双人/);

  console.log(JSON.stringify({ status: "PASS_WORKER_TERMINAL_WINNING_PASS", rows,
    routes: ["greedy", "mcts", "legacy-neural-puct", "multiplayer-easy-p3-p6"],
    incompatibleRoutesRejectedBeforePass: ["neural-puct", "model-free"],
    multiplayerPassProbes, readySeenDuringPassProbe, sourceStatePreserved: true }));
} finally {
  globalThis.fetch = originalFetch;
  if (originalSelf === undefined) delete globalThis.self;
  else globalThis.self = originalSelf;
}
