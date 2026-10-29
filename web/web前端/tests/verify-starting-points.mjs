import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import GameEngine, { PLAYER_ORDER, resolveInitialPositions } from "../GameEngine.js";
import GameController from "../GameController.js";
import { randomInitialPositions, startingPointSettings } from "../StartingPoints.js";
import { serializeEngineState } from "../AIStateProtocol.js";
import { serializeRuleState, createReplayDocument, validateReplayDocument } from "../ReplayCodec.js";
import { createLocalGameSession, persistLocalGameSession, loadLocalGameSession, sessionMatchesSettings } from "../LocalGameSession.js";
import { normalizeGameSettings } from "../OnlineAppState.js";
import { TrainingContribution } from "../TrainingContribution.js";
import { localPlayerProfile } from "../LocalAIModes.js";

const noop = () => {};
const storageMap = new Map();
const storage = { getItem: (key) => storageMap.get(key), setItem: (key, value) => storageMap.set(key, value) };
const controllerFor = (settings) => Object.assign(Object.create(GameController.prototype), {
  options: { engine: settings }, engine: new GameEngine(settings), _engineEpoch: 0,
  _cancelTerritoryRefresh: noop, _scheduleTerritoryRefresh: noop, _syncSnapshot: noop,
  canvas: { style: {}, setAttribute: noop },
  _updateLargeBoardClass: noop, renderer: { invalidate: noop }, multiplayerEnabled: false,
  lastAction: null, localPlayer: null,
});

let openings = 0, cutCases = 0, workerCases = 0;
for (const count of [2, 3, 4, 5, 6]) {
  for (const size of [5, 9, 15]) {
    for (const mode of ["random", "custom"]) {
      const initialPositions = randomInitialPositions(size, count, () => mode === "custom" ? .4 : .73);
      const settings = { gridSize: size, playerCount: count, startPlayer: PLAYER_ORDER[count - 1], rulesVersion: "territory-v2", startingPointMode: mode, initialPositions };
      const game = new GameEngine(settings);
      assert.deepEqual(game.initialPositions, initialPositions);
      assert.equal(new Set(Object.values(initialPositions).map(String)).size, count);
      assert.equal(game.grid.size, game.getValidPositions().length);
      assert.equal([...game.grid.values()].filter(Boolean).length, count);
      assert.deepEqual(normalizeGameSettings(settings).initialPositions, initialPositions);
      for (const player of game.activePlayers) assert.deepEqual(game._getPlayerNodes(player), [initialPositions[player]]);
      const session = createLocalGameSession(settings);
      assert.equal(persistLocalGameSession(session, storage), true);
      assert.deepEqual(loadLocalGameSession(storage).settings.initialPositions, initialPositions);
      assert.equal(sessionMatchesSettings(session, structuredClone(settings)), true);
      assert.equal(sessionMatchesSettings(session, { ...settings, initialPositions: undefined, startingPointMode: "default" }), false);
      assert.deepEqual(serializeEngineState(game).initialPositions, initialPositions);
      const snapshot = game.getSnapshot();
      snapshot.initialPositions.BLACK[0] += 99;
      assert.deepEqual(game.initialPositions, initialPositions, "snapshots must not mutate live roots");
      const input = structuredClone(initialPositions);
      const isolated = new GameEngine({ ...settings, initialPositions: input });
      input.BLACK[0] += 99;
      assert.deepEqual(isolated.initialPositions, initialPositions, "draft inputs must not mutate live roots");
      assert.ok(Object.isFrozen(isolated.initialPositions.BLACK));
      const controller = controllerFor(settings);
      const restore = controller.restoreMatchState(session);
      assert.equal(restore.success, true, restore.reason);
      assert.deepEqual(controller.engine.initialPositions, initialPositions);
      controller.setGameConfig({ gridSize: size, playerCount: count, rulesVersion: "territory-v2" });
      assert.deepEqual(controller.engine.initialPositions, resolveInitialPositions(size, count), "switching to default clears custom roots");
      openings++;
    }
  }
  // Two sides of the same cut: the retained side must depend on the chosen
  // root, including interior roots far from the old corner.
  for (const reverse of [false, true]) {
    const near = count < 4 ? [1, 1] : [6, 6];
    const far = count < 4 ? [5, 1] : [10, 6];
    const cut = count < 4 ? [3, 1] : [8, 6];
    const initialPositions = { ...resolveInitialPositions(9, count), BLACK: reverse ? far : near, WHITE: count < 4 ? [0, 4] : [5, 9] };
    const settings = { gridSize: 9, playerCount: count, startPlayer: "BLACK", rulesVersion: "territory-v2", startingPointMode: "custom", initialPositions };
    const engine = new GameEngine(settings);
    const actions = [{ type: "player_move", point: reverse ? near : far }, { type: "player_move", point: cut }];
    assert.equal(engine.playMove(actions[0].point).success, true);
    assert.equal(engine.playMove(cut).success, true);
    assert.deepEqual(engine._getPlayerNodes("BLACK"), [initialPositions.BLACK], "only the chosen root survives the severed edge");
    assert.deepEqual(engine._getPlayerLines("BLACK"), []);
    assert.equal(engine.edges.BLACK.size, 0);
    const controller = controllerFor(settings);
    assert.equal(controller.restoreMatchState({ settings, actions }).success, true);
    assert.deepEqual(serializeRuleState(controller.engine), serializeRuleState(engine), "batch replay preserves the connectivity roots");
    const replay = await createReplayDocument(settings, actions);
    assert.equal((await validateReplayDocument(replay)).success, true);
    assert.deepEqual(replay.config.initialPositions, initialPositions);
    const changed = structuredClone(replay);
    changed.config.initialPositions.BLACK = reverse ? near : far;
    assert.equal((await validateReplayDocument(changed)).success, false, "root changes must invalidate replay commitments");
    const invalid = structuredClone(replay);
    invalid.config.initialPositions.BLACK = invalid.config.initialPositions.WHITE;
    assert.equal((await validateReplayDocument(invalid)).success, false, "malformed roots fail without throwing");
    const current = serializeRuleState(controller.engine);
    controller.networkErrorListener = noop;
    assert.equal(controller.restoreMatchState({ settings: invalid.config, actions }).success, false);
    assert.deepEqual(serializeRuleState(controller.engine), current, "invalid restore preserves live state");
    cutCases++;
  }
  const duplicate = structuredClone(resolveInitialPositions(5, count));
  duplicate.BLACK = duplicate.WHITE;
  const outside = { ...resolveInitialPositions(5, count), BLACK: [99, 99] };
  const missing = { ...resolveInitialPositions(5, count) };
  delete missing.WHITE;
  for (const positions of [duplicate, outside, missing, []]) {
    assert.throws(() => new GameEngine({ gridSize: 5, playerCount: count, initialPositions: positions }));
    assert.throws(() => createLocalGameSession({ gridSize: 5, playerCount: count, startPlayer: "BLACK", rulesVersion: "territory-v2", initialPositions: positions }));
  }
}
assert.throws(() => startingPointSettings({ gridSize: 5, playerCount: 2, startingPointMode: "random" }));
assert.throws(() => randomInitialPositions(5, 2, () => 1));

// Run the actual Worker handlers and model loaders with local, integrity-checked
// model assets; validate the returned moves against the live custom-root game.
const originalSelf = globalThis.self, originalFetch = globalThis.fetch;
let response;
globalThis.self = { postMessage: (value) => { response = value; } };
globalThis.fetch = async (input) => {
  const url = new URL(String(input), new URL("../", import.meta.url));
  assert.equal(url.protocol, "file:");
  return { ok: true, json: async () => JSON.parse(await readFile(url, "utf8")),
    arrayBuffer: async () => { const data = await readFile(url); return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength); } };
};
try {
  await import("../AIWorker.js");
  const aiHandler = self.onmessage;
  await import("../TerritoryWorker.js");
  const territoryHandler = self.onmessage;
  for (const count of [2, 3, 4, 5, 6]) {
    const initialPositions = randomInitialPositions(5, count, () => .5);
    const settings = { gridSize: 5, playerCount: count, rulesVersion: "territory-v2", startingPointMode: "custom", initialPositions };
    const engine = new GameEngine(settings);
    const before = serializeRuleState(engine);
    await aiHandler({ data: { type: "COMPUTE", requestId: `custom-${count}`, serializedState: serializeEngineState(engine),
      aiPlayer: engine.currentPlayer, depth: 1, topN: 1,
      strategy: count === 2 ? "minimax" : count === 3 ? "three-player" : "hex-player",
      ...(count === 3 ? { modelId: localPlayerProfile({ choice: "three-player" }, 3, 5).modelId } : {}),
    } });
    assert.equal(response.type, "RESULT", response.message);
    assert.deepEqual(serializeRuleState(engine), before);
    if (response.moves[0]?.point) assert.equal(engine.playMove(response.moves[0].point).success, true);
    else assert.equal(engine.getLegalMoves().length, 0);
    territoryHandler({ data: { type: "COMPUTE_TERRITORIES", requestId: `score-${count}`,
      serializedState: serializeEngineState(engine), territoryStateRevision: engine.getTerritoryStateRevision(), gameOver: engine.gameOver } });
    assert.equal(response.type, "RESULT", response.message);
    engine._updateTerritories();
    assert.deepEqual(response.territories, engine.cachedTerritories);
    const contribution = new TrainingContribution({ storage });
    assert.equal(await contribution.enqueue(settings, [], { source: "local" }), false, "custom starts stay out of fixed-opening training data");
    workerCases++;
  }
} finally {
  globalThis.fetch = originalFetch;
  if (originalSelf === undefined) delete globalThis.self; else globalThis.self = originalSelf;
}
console.log(JSON.stringify({ status: "PASS", openings, cutCases, workerCases,
  coverage: ["2–6 players", "sizes 5/9/15", "unique in-board roots", "both sides of cuts", "save/refresh", "batch replay", "tamper rejection", "default reset", "AI and territory Workers", "training isolation"] }));
