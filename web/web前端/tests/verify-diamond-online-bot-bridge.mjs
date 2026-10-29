import assert from "node:assert/strict";

import { processBotRequest } from "../../tools/online_bot_bridge.mjs";

const version = "2026092201";
const player = (choice, depth = 3) => ({ choice, depth, version });

const duelSettings = {
  gridSize: 5,
  playerCount: 2,
  boardShape: "diamond",
  startPlayer: "WHITE",
  rulesVersion: "territory-v3",
  protectionRule: "symmetric-v1",
  playerSetup: {
    BLACK: player("human"),
    WHITE: player("minimax", 4),
  },
};

let observedDuel = null;
const duel = await processBotRequest({ settings: duelSettings, actions: [] }, {
  chooseBotPoint(engine, profile) {
    observedDuel = { initialPositions: structuredClone(engine.initialPositions), profile };
    return engine.getLegalMoves()[0].point;
  },
});
assert.equal(duel.success, true);
assert.deepEqual(observedDuel.initialPositions, { BLACK: [0, 0], WHITE: [4, 4] });
assert.deepEqual(observedDuel.profile, { strategy: "minimax", depth: 4 });
assert.equal(duel.action.color, "WHITE");

const threeSettings = {
  gridSize: 5,
  playerCount: 3,
  boardShape: "diamond",
  startPlayer: "WHITE",
  initialPositions: { BLACK: [0, 0], WHITE: [4, 4], PURPLE: [0, 4] },
  startingPointMode: "custom",
  rulesVersion: "territory-v3",
  protectionRule: "symmetric-v1",
  playerSetup: {
    BLACK: player("human"),
    WHITE: player("ai-hard"),
    PURPLE: player("human"),
  },
};

let observedHard = null;
const hard = await processBotRequest({ settings: threeSettings, actions: [] }, {
  chooseBotPoint(engine, profile) {
    observedHard = { boardShape: engine.boardShape, profile };
    return engine.getLegalMoves()[0].point;
  },
});
assert.equal(hard.success, true);
assert.deepEqual(observedHard, {
  boardShape: "diamond",
  profile: { strategy: "multiplayer", modelId: "multiplayer-hard-v1" },
});

const easySettings = {
  ...threeSettings,
  playerSetup: { ...threeSettings.playerSetup, WHITE: player("ai-easy") },
};
let observedEasy = null;
const easy = await processBotRequest({ settings: easySettings, actions: [] }, {
  chooseBotPoint(engine, profile) {
    observedEasy = { boardShape: engine.boardShape, profile };
    return engine.getLegalMoves()[0].point;
  },
});
assert.equal(easy.success, true);
assert.deepEqual(observedEasy, { boardShape: "diamond", profile: { strategy: "greedy" } });

const realEasy = await processBotRequest({ settings: easySettings, actions: [] });
assert.equal(realEasy.success, true);
assert.equal(realEasy.fallback, false);
assert.deepEqual(realEasy.botProfile, { strategy: "greedy" });
assert.deepEqual(realEasy.modelInfo, {
  strategy: "greedy", runtime_policy: "generic-rule-greedy", trained_model: false,
});

// Exercise the real generic search route too.  It must not load a native
// three-player model or report a model-error legal-move fallback.
const realHard = await processBotRequest({ settings: threeSettings, actions: [] });
assert.equal(realHard.success, true);
assert.equal(realHard.action.color, "WHITE");
assert.equal(realHard.fallback, false);
assert.deepEqual(realHard.botProfile, { strategy: "multiplayer", modelId: "multiplayer-hard-v1" });
assert.equal(realHard.modelInfo.runtime_policy, "generic-multiplayer-minimax");
assert.equal(realHard.modelInfo.trained_model, false);
assert.equal(realHard.modelInfo.evidenceTier, "rule-search");

for (const choice of ["greedy", "ai-medium", "ai-ultimate", "three-player", "hex-player", "padded-cnn"]) {
  const invalid = await processBotRequest({
    settings: {
      ...threeSettings,
      playerSetup: { ...threeSettings.playerSetup, WHITE: player(choice) },
    },
    actions: [],
  }, { chooseBotPoint: () => { throw new Error("unsupported profile reached AI execution"); } });
  assert.deepEqual(invalid, { success: false, reason: "INVALID_CONFIGURATION" }, choice);
}

const invalidDuel = await processBotRequest({
  settings: {
    ...duelSettings,
    playerSetup: { ...duelSettings.playerSetup, WHITE: player("grid-gnn") },
  },
  actions: [],
});
assert.deepEqual(invalidDuel, { success: false, reason: "INVALID_CONFIGURATION" });

console.log(JSON.stringify({
  status: "PASS",
  coverage: ["acute duel roots", "duel Minimax", "multiplayer generic Greedy", "multiplayer generic hard", "real generic runtimes", "fail-closed model identity"],
}));
