import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { GameEngine } from "../GameEngine.js";
import { MinimaxAI, saveState } from "../AIEngine.js";
import { serializeEngineState } from "../AIStateProtocol.js";
import { isolatedSearchEngine } from "../MultiplayerSearch.js";

// A terminal-winning PASS remains a real policy action, but it must no longer
// bypass the policy before loading/READY or suppress certified safe growth.
const workerSource = await readFile(new URL("../AIWorker.js", import.meta.url), "utf8");
assert.doesNotMatch(workerSource, /canonicalTerminalWinningPass|canonical-terminal-unique-win/);
const originalFetch = globalThis.fetch, originalSelf = globalThis.self, messages = [];
globalThis.fetch = async input => {
  const url = input instanceof URL ? input : new URL(input);
  return url.protocol === "file:" ? new Response(await readFile(fileURLToPath(url))) : originalFetch(input);
};
globalThis.self = { postMessage: message => messages.push(structuredClone(message)) };
await import(`../AIWorker.js?verify-worker-terminal-policy=${Date.now()}`);

async function compute(source, options, expectedType = "RESULT") {
  const serializedState = serializeEngineState(source), before = structuredClone(serializedState), stateBefore = saveState(source);
  const requestId = options.requestId;
  messages.length = 0;
  await globalThis.self.onmessage({ data: { type: "COMPUTE", serializedState, aiPlayer: source.currentPlayer,
    topN: 1, ...options } });
  assert.deepEqual(serializedState, before); assert.deepEqual(saveState(source), stateBefore);
  const output = messages.find(m => m.type === expectedType);
  assert.ok(output, `${requestId}: ${JSON.stringify(messages)}`);
  assert.equal(output.requestId, requestId); assert.equal(output.positionRevision, source.positionRevision);
  assert.equal(output.currentPlayer, source.currentPlayer); assert.equal(output.rulesVersion, source.rulesVersion);
  return output;
}

function winningFixture(playerCount = 2) {
  const source = new GameEngine({ playerCount, gridSize: 5, rulesVersion: "territory-v3", deferTerritoryUpdates: true });
  const actor = source.currentPlayer;
  assert.equal(source.playMove([1, 0]).success, true);
  while (!source.gameOver && source.currentPlayer !== actor) assert.equal(source.skipTurn().success, true);
  const terminal = isolatedSearchEngine(source);
  assert.equal(terminal.skipTurn().success, true); assert.equal(terminal.gameOver, true);
  assert.equal(terminal.getWinner(), actor);
  return source;
}

const rows = [];
try {
  const winning = winningFixture();
  assert.equal(new MinimaxAI(1).getTopMoves(winning, winning.currentPlayer, 1)[0].point, null,
    "Fixture must exercise a genuine terminal-winning policy PASS");
  const result = await compute(winning, { strategy: "minimax", depth: 1, requestId: "minimax-winning-safe-growth" });
  assert.ok(Array.isArray(result.moves[0]?.point));
  assert.equal(result.searchStats.passDiscipline.status, "safe-profitable-expansion");
  assert.equal(result.searchStats.passDiscipline.witness.completeOpponentRound, true);
  assert.equal(result.searchStats.passDiscipline.witness.passWouldEnd, true);
  assert.ok(result.searchStats.passDiscipline.witness.minimumReplyMargin > 0);
  rows.push({ strategy: "minimax", raw: "terminal-winning-PASS", final: result.moves[0].point });

  for (const playerCount of [2, 3]) {
    const source = winningFixture(playerCount);
    const greedy = await compute(source, { strategy: "greedy", requestId: `greedy-winning-p${playerCount}` });
    assert.ok(Array.isArray(greedy.moves[0]?.point), "Winning state must retain the actual placement policy");
    assert.equal(greedy.searchStats.passDiscipline.status, "placement-policy-preserved");
    rows.push({ strategy: "greedy", playerCount, placementPreserved: true });
  }

  const ordinary = new GameEngine({ playerCount: 2, gridSize: 5, rulesVersion: "territory-v3" });
  assert.ok(Array.isArray((await compute(ordinary, { strategy: "greedy", requestId: "ordinary" })).moves[0].point));
  const zero = await compute(winning, { strategy: "greedy", topN: 0, requestId: "topn-zero" });
  assert.deepEqual(zero.moves, []);
  const terminal = isolatedSearchEngine(winning); terminal.skipTurn();
  assert.deepEqual((await compute(terminal, { strategy: "greedy", requestId: "already-terminal" })).moves, []);

  const blocked = winningFixture();
  for (const { point } of blocked.getLegalMoves()) {
    const trial = isolatedSearchEngine(blocked), previous = new Set(blocked.historyHashes);
    assert.equal(trial.playMove(point).success, true);
    for (const hash of trial.historyHashes) if (!previous.has(hash)) blocked.historyHashes.add(hash);
  }
  assert.equal(blocked.getLegalMoves().length, 0);
  const forced = await compute(blocked, { strategy: "greedy", requestId: "superko-forced-pass" });
  assert.equal(forced.moves[0].point, null); assert.equal(forced.searchStats.passDiscipline.status, "forced-pass");

  const multiplayer = winningFixture(3);
  const multi = await compute(multiplayer, { strategy: "multiplayer", modelId: "multiplayer-easy-v1", requestId: "multiplayer-policy-loaded" });
  assert.equal(multi.modelInfo.id, "multiplayer-easy-v1");
  assert.deepEqual(messages.filter(m => ["READY", "RESULT"].includes(m.type)).map(m => m.type), ["READY", "RESULT"]);
  for (const strategy of ["neural-puct", "model-free"]) {
    const error = await compute(multiplayer, { strategy, requestId: `incompatible-${strategy}` }, "ERROR");
    assert.match(error.message, strategy === "model-free" ? /仅支持双人/ : /不支持.*玩家数/);
    assert.equal(messages.some(m => m.type === "RESULT"), false);
  }
  console.log(JSON.stringify({ status: "PASS_WORKER_TERMINAL_POLICY", rows, forcedPass: true,
    multiplayerReadyBeforeDecision: true, incompatibleRoutesRejected: true, sourceStatePreserved: true }));
} finally {
  globalThis.fetch = originalFetch;
  if (originalSelf === undefined) delete globalThis.self; else globalThis.self = originalSelf;
}
