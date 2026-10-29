import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import GameEngine, { RootMode, TerritoryRulesVersion } from "../GameEngine.js";
import { GreedyAI, MCTSAI, MinimaxAI, restoreState, saveState } from "../AIEngine.js";
import { serializeEngineState } from "../AIStateProtocol.js";
import { supportsRootModeAI } from "../LocalAIModes.js";

function putEdge(engine, player, from, to) {
  const states = engine._getPlayerStates(player);
  for (const point of engine.getLinePoints(from, to)) {
    engine._setState(point, point.join() === from.join() || point.join() === to.join() ? states.node : states.line);
  }
  engine.edges[player].add(engine._edgeKey(from, to));
}

for (const rootMode of [RootMode.RELOCATE, RootMode.ADD]) {
  const settings = { gridSize: 5, playerCount: 2, rulesVersion: TerritoryRulesVersion.V3, rootMode };
  for (const ai of [new GreedyAI(), new MinimaxAI(1), new MCTSAI({ simulations: 24, rolloutDepth: 4, seed: 23 })]) {
    const engine = new GameEngine(settings);
    putEdge(engine, "BLACK", engine.getRoots("BLACK")[0], [2, 0]);
    const before = saveState(engine);
    const moves = ai.getTopMoves(engine, "BLACK", 100);
    const rootAction = moves.find((move) => move.type === `root_${rootMode}` && move.point.join() === "2,0");
    assert.ok(rootAction, `${ai.constructor.name} must enumerate ${rootMode}`);
    assert.deepEqual(saveState(engine), before, `${ai.constructor.name} leaked speculative ${rootMode} state`);
    const isolated = new GameEngine(settings);
    restoreState(isolated, before);
    assert.equal(isolated.playRootAction(rootAction.type, rootAction.point).success, true);
  }
}

const rootOnly = new GameEngine({
  gridSize: 5,
  playerCount: 2,
  rulesVersion: TerritoryRulesVersion.V3,
  rootMode: RootMode.ADD,
});
putEdge(rootOnly, "BLACK", rootOnly.getRoots("BLACK")[0], [1, 0]);
rootOnly.getLegalMoves = () => [];
rootOnly._hasValidMoves = () => false;
for (const ai of [new GreedyAI(), new MinimaxAI(1), new MCTSAI({ simulations: 24, rolloutDepth: 4, seed: 29 })]) {
  const moves = ai.getTopMoves(rootOnly, "BLACK", 100);
  assert.ok(moves.some((move) => move.type === "root_add" && move.point.join() === "1,0"),
    `${ai.constructor.name} must not auto-pass when only a root action remains`);
}

assert.equal(supportsRootModeAI({ strategy: "minimax" }, RootMode.ADD), true);
assert.equal(supportsRootModeAI({ strategy: "neural-puct" }, RootMode.FIXED_DOUBLE), false);
assert.equal(supportsRootModeAI({ strategy: "multiplayer" }, RootMode.RELOCATE), false);
const workerSource = await readFile(new URL("../AIWorker.js", import.meta.url), "utf8");
assert.match(workerSource, /engine\.rootMode !== ["']classic["']/);
assert.match(workerSource, /\["greedy", "minimax", "mcts"\]/);
assert.match(workerSource, /_hasAnyNonPassAction\(player\)/,
  "the Worker PASS precheck must count dynamic root actions");

const workerEngine = new GameEngine({ gridSize: 5, playerCount: 2, rulesVersion: TerritoryRulesVersion.V3, rootMode: RootMode.ADD });
putEdge(workerEngine, "BLACK", workerEngine.getRoots("BLACK")[0], [2, 0]);
const serializedState = serializeEngineState(workerEngine);
const serializedBefore = structuredClone(serializedState);
const workerMessages = [];
globalThis.self = { postMessage: (message) => workerMessages.push(structuredClone(message)) };
await import("../AIWorker.js?verify-root-action-ai=1");
await globalThis.self.onmessage({ data: {
  type: "COMPUTE", requestId: "root-action-ai", serializedState,
  aiPlayer: "BLACK", strategy: "minimax", depth: 1, topN: 100,
} });
assert.deepEqual(serializedState, serializedBefore, "the Worker must not mutate its input snapshot");
assert.equal(workerMessages.length, 1);
assert.equal(workerMessages[0].type, "RESULT", workerMessages[0].message);
assert.ok(workerMessages[0].moves.some((move) => move.type === "root_add" && move.point.join() === "2,0"),
  "the actual Worker must return dynamic root actions");

console.log("verify-root-action-ai: PASS (generic searches and actual Worker enumerate dynamic actions; legacy models fail closed)");
