import assert from "node:assert/strict";
import GameEngine, { Player, RootMode, TerritoryRulesVersion } from "../GameEngine.js";
import {
  captureWorkerRequest, getRootStateIdentity, isWorkerResultForRequest,
  restoreEngineRootState, serializeEngineState,
} from "../AIStateProtocol.js";

for (const rootMode of [RootMode.FIXED_DOUBLE, RootMode.RELOCATE, RootMode.ADD]) {
  const engine = new GameEngine({ gridSize: 9, playerCount: 2, rulesVersion: TerritoryRulesVersion.V3, rootMode });
  const serialized = serializeEngineState(engine);
  assert.deepEqual(serialized.initialRoots, engine.initialRoots);
  assert.deepEqual(serialized.roots.BLACK, engine.getRoots(Player.BLACK));
  assert.notEqual(serialized.roots.BLACK, engine.roots.BLACK);
  const restored = new GameEngine({
    gridSize: serialized.gridSize, playerCount: serialized.playerCount, boardShape: serialized.boardShape,
    startPlayer: serialized.startPlayer, rulesVersion: serialized.rulesVersion, rootMode: serialized.rootMode,
    rootRulesVersion: serialized.rootRulesVersion, initialRoots: serialized.initialRoots,
  });
  restoreEngineRootState(restored, serialized);
  assert.equal(getRootStateIdentity(restored), serialized.rootStateIdentity);

  const request = captureWorkerRequest(engine, 7);
  const reply = {
    requestId: 7, positionRevision: request.positionRevision, rulesVersion: request.rulesVersion,
    currentPlayer: request.currentPlayer, rootStateIdentity: request.rootStateIdentity,
  };
  assert.equal(isWorkerResultForRequest(engine, request, reply), true);
  engine.roots.BLACK = engine.roots.BLACK.map((point, index) => index ? point : [point[0], point[1] + 1]);
  assert.equal(isWorkerResultForRequest(engine, request, reply), false, "changed roots reject an old result even without a revision bump");
}

const classic = new GameEngine({ rulesVersion: TerritoryRulesVersion.V3 });
const legacyRequest = captureWorkerRequest(classic, 1);
assert.equal(isWorkerResultForRequest(classic, legacyRequest, {
  requestId: 1, positionRevision: 0, rulesVersion: TerritoryRulesVersion.V3, currentPlayer: Player.BLACK,
}), true, "legacy workers remain readable for classic games");

console.log("verify-multi-start-worker: PASS (deep snapshots, restore identity, stale rejection, legacy response)");
