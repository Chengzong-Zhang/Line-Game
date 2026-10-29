import assert from "node:assert/strict";

import "../TopologyGameEngine.js";
import { GameEngine } from "../GameEngine.js";
import {
  TOPOLOGY_LOCAL_GAME_SESSION_STORAGE_KEY,
  appendTopologyLocalGameAction,
  createTopologyLocalGameSession,
  loadTopologyLocalGameSession,
  persistTopologyLocalGameSession,
  topologySessionMatchesBoard,
} from "../LocalGameSession.js";
import {
  createTopologyReplayDocument,
  validateTopologyReplayDocument,
} from "../ReplayCodec.js";
import { CONCAVE_GAP_DEFINITION } from "./fixtures/board-topology-v1-fixtures.mjs";

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

const engine = new GameEngine({ boardDefinition: CONCAVE_GAP_DEFINITION });
const firstMove = engine.getLegalMoves()[0].vertexId;
assert.equal(engine.playMove(firstMove).success, true);
const state = engine.encodeTopologyState();

const restored = new GameEngine({ boardDefinition: engine.boardDefinition });
assert.equal(restored.restoreTopologyState(state), true);
assert.deepEqual(restored.getSnapshot().boardStates, engine.getSnapshot().boardStates);
assert.deepEqual(restored.getSnapshot().topologyPaths, engine.getSnapshot().topologyPaths);
assert.equal(restored.boardHash, engine.boardHash);

const before = engine.getSnapshot();
const tampered = structuredClone(state);
tampered.boardHash = "0".repeat(64);
assert.throws(() => engine.restoreTopologyState(tampered),
  (error) => error?.code === "BOARD_HASH_MISMATCH");
assert.deepEqual(engine.getSnapshot(), before, "failed isolated decode cannot alter the active topology match");

// IDs that happen to belong to the same board are insufficient: each stored
// logical path must exactly reproduce a direction-aware compiled ray. This
// catches hostile saves/replays that otherwise manufacture connected nodes.
const forgedPathState = structuredClone(state);
const blackStart = engine.initialPositions.BLACK;
const forgedTarget = engine.getValidPositions().find((vertexId) =>
  vertexId !== blackStart && vertexId !== engine.initialPositions.WHITE);
forgedPathState.ruleState.vertexStateById[forgedTarget] = {
  owner: "BLACK", node: true, line: false,
};
forgedPathState.ruleState.logicPaths.push({
  pathId: "path:v1:forged",
  owner: "BLACK",
  startVertexId: blackStart,
  endVertexId: forgedTarget,
  vertices: [blackStart, forgedTarget],
  edgeOccurrences: [],
  seamCrossings: [],
  directionState: 0,
});
assert.throws(() => engine.restoreTopologyState(forgedPathState),
  (error) => error?.code === "INVALID_LOGIC_PATH");
assert.deepEqual(engine.getSnapshot(), before, "a forged geometry path cannot alter the active topology match");

const storage = memoryStorage();
const session = createTopologyLocalGameSession(state, [{ type: "move", vertexId: firstMove }]);
assert.equal(persistTopologyLocalGameSession(session, storage), true);
assert.notEqual(storage.getItem(TOPOLOGY_LOCAL_GAME_SESSION_STORAGE_KEY), null);
assert.deepEqual(loadTopologyLocalGameSession(storage), session);
assert.equal(topologySessionMatchesBoard(session, engine.boardHash), true);
assert.equal(topologySessionMatchesBoard(session, "wrong"), false);
const appended = appendTopologyLocalGameAction(session, { type: "skip" });
assert.deepEqual(appended.actions.map((action) => action.type), ["player_move", "player_skip"]);

const replay = await createTopologyReplayDocument(
  { boardDefinition: CONCAVE_GAP_DEFINITION },
  [{ type: "move", vertexId: firstMove }, { type: "skip" }, { type: "skip" }],
);
const replayResult = await validateTopologyReplayDocument(replay);
assert.equal(replayResult.success, true, replayResult.reason);
assert.equal(replayResult.actions.length, 3);
assert.equal(replayResult.terminal.status, "completed");
const malformedReplay = structuredClone(replay);
malformedReplay.actions[0].vertexId = "cv:not-on-board";
assert.equal((await validateTopologyReplayDocument(malformedReplay)).success, false);

console.log(JSON.stringify({
  status: "PASS",
  coverage: [
    "complete topology state save and isolated restore",
    "tampered import preserves active match",
    "forged logical paths must reproduce compiled rays",
    "separate topology local-session storage",
    "canonical vertex action replay and terminal verification",
  ],
}));
