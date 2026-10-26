import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  passDisciplineRuleState,
  protectedRootInvariantHolds,
} from "../AIPassDisciplineV2.js";
import {
  captureWorkerRequest,
  isWorkerResultForRequest,
  serializeEngineState,
} from "../AIStateProtocol.js";
import {
  GameEngine,
  Player,
  StartProtectionRule,
  TerritoryRulesVersion,
} from "../GameEngine.js";
import { normalizeGameSettings } from "../OnlineAppState.js";
import { sharedRoomCreateSettings } from "../SharedRoomClient.js";
import {
  canonicalize,
  createReplayDocument,
  validateReplayDocument,
} from "../ReplayCodec.js";

const MODERN = StartProtectionRule.DUEL_FIRST_UNPROTECTED;
const LEGACY = StartProtectionRule.SYMMETRIC;

// New-game configuration selects the modern rule only for the requested scope.
assert.equal(normalizeGameSettings({ playerCount: 2, boardShape: "triangle" }).protectionRule, MODERN);
assert.equal(normalizeGameSettings({ playerCount: 2, boardShape: "hexagon" }).protectionRule, undefined);
assert.equal(normalizeGameSettings({ playerCount: 3, boardShape: "triangle" }).protectionRule, undefined);
assert.equal(normalizeGameSettings({ playerCount: 2, boardShape: "triangle", protectionRule: LEGACY }).protectionRule, LEGACY);
assert.equal(sharedRoomCreateSettings({ playerCount: 2, boardShape: "triangle" }).protectionRule, MODERN);
assert.equal(sharedRoomCreateSettings({ playerCount: 2, boardShape: "hexagon" }).protectionRule, undefined);
assert.equal(sharedRoomCreateSettings({ playerCount: 3, boardShape: "triangle" }).protectionRule, undefined);
assert.equal(sharedRoomCreateSettings({ playerCount: 2, boardShape: "triangle", protectionRule: LEGACY }).protectionRule, LEGACY);

function hasMove(engine, point, player = engine.currentPlayer) {
  const target = point.join(",");
  return engine.getLegalMoves(player).some((move) => move.point.join(",") === target);
}

function playerPieces(engine, player) {
  const nodes = new Set(engine._getPlayerNodes(player).map((point) => point.join(",")));
  const lines = engine._getPlayerLines(player);
  return {
    nodes,
    lines,
    coverage: new Set([...nodes, ...lines.map((point) => point.join(","))]),
  };
}

function assertDefaultDuel(startPlayer, firstMove, secondInvasion, firstInvasion) {
  const engine = new GameEngine({
    gridSize: 5,
    playerCount: 2,
    boardShape: "triangle",
    startPlayer,
    rulesVersion: TerritoryRulesVersion.V3,
    protectionRule: MODERN,
  });

  assert.equal(engine.currentPlayer, startPlayer);
  assert.equal(
    engine._isInProtectionZone(firstInvasion, startPlayer),
    true,
    `${startPlayer} must still respect the second player's protected start`,
  );
  assert.equal(hasMove(engine, firstInvasion), false);
  const rejected = engine.playMove(firstInvasion);
  assert.equal(rejected.success, false);
  assert.equal(rejected.reason, "INVALID_MOVE");

  assert.equal(engine.playMove(firstMove).success, true);
  assert.notEqual(engine.currentPlayer, startPlayer);
  assert.equal(
    engine._isInProtectionZone(secondInvasion, engine.currentPlayer),
    false,
    "the second player may enter the actual first player's former protected zone",
  );
  assert.equal(hasMove(engine, secondInvasion), true);
  assert.equal(engine.playMove(secondInvasion).success, true);
}

// The exemption follows the configured first player, never a fixed colour.
assertDefaultDuel(Player.BLACK, [0, 1], [1, 0], [3, 0]);
assertDefaultDuel(Player.WHITE, [3, 1], [3, 0], [1, 0]);

// Custom roots use their real coordinates and retain the same first/second asymmetry.
const custom = new GameEngine({
  gridSize: 5,
  playerCount: 2,
  boardShape: "triangle",
  startPlayer: Player.BLACK,
  initialPositions: { BLACK: [0, 2], WHITE: [2, 2] },
  rulesVersion: TerritoryRulesVersion.V3,
  protectionRule: MODERN,
});
assert.equal(custom._isInProtectionZone([1, 2], Player.BLACK), true);
assert.equal(hasMove(custom, [1, 2]), false, "first player cannot enter the custom second-player zone");
assert.equal(custom.playMove([0, 1]).success, true);
assert.equal(custom._isInProtectionZone([1, 2], Player.WHITE), false);
assert.equal(hasMove(custom, [1, 2]), true, "second player can enter the custom first-player zone");
assert.equal(custom.playMove([1, 2]).success, true);

// The new rule is deliberately scoped: two-player hex and multiplayer triangle stay symmetric.
const hex = new GameEngine({
  gridSize: 5,
  playerCount: 2,
  boardShape: "hexagon",
  startPlayer: Player.BLACK,
  rulesVersion: TerritoryRulesVersion.V3,
  protectionRule: MODERN,
});
const hexBlackNeighbor = hex.getAdjacentPositions(hex.initialPositions.BLACK)[0];
assert.equal(hex._isInProtectionZone(hexBlackNeighbor, Player.WHITE), true);

const three = new GameEngine({
  gridSize: 5,
  playerCount: 3,
  boardShape: "triangle",
  startPlayer: Player.BLACK,
  rulesVersion: TerritoryRulesVersion.V3,
  protectionRule: MODERN,
});
const threeBlackNeighbor = three.getAdjacentPositions(three.initialPositions.BLACK)[0];
assert.equal(three._isInProtectionZone(threeBlackNeighbor, Player.WHITE), true);

// Bare/old engines do not silently acquire the new rule.
const legacy = new GameEngine({
  gridSize: 5,
  playerCount: 2,
  boardShape: "triangle",
  startPlayer: Player.BLACK,
  rulesVersion: TerritoryRulesVersion.V3,
});
assert.equal(legacy.protectionRule, LEGACY);
assert.equal(legacy.playMove([0, 1]).success, true);
assert.equal(legacy._isInProtectionZone([1, 0], Player.WHITE), true);
assert.equal(hasMove(legacy, [1, 0]), false);
assert.equal(legacy.playMove([1, 0]).success, false);
assert.equal(
  "protectionRule" in serializeEngineState(legacy),
  false,
  "legacy compact worker bytes stay stable by omitting the symmetric default",
);
assert.throws(
  () => new GameEngine({ protectionRule: "unknown-protection-rule" }),
  /Unsupported start protection rule/,
);

// PASS-discipline certificates must not claim that the modern first player's
// birth-root neighborhood is protected. The same structural premise remains
// valid for the modern second player and for a legacy symmetric first player.
const modernFirstCertificate = new GameEngine({
  gridSize: 5,
  playerCount: 2,
  boardShape: "triangle",
  startPlayer: Player.BLACK,
  rulesVersion: TerritoryRulesVersion.V3,
  protectionRule: MODERN,
});
const modernFirstBefore = playerPieces(modernFirstCertificate, Player.BLACK);
assert.equal(modernFirstCertificate.playMove([0, 1]).success, true);
assert.equal(
  protectedRootInvariantHolds(modernFirstCertificate, Player.BLACK, modernFirstBefore, 1),
  false,
  "the unprotected first-player root cannot certify an immutable protected-root invariant",
);
assert.equal(passDisciplineRuleState(modernFirstCertificate).protectionRule, MODERN);

const modernSecondBefore = playerPieces(modernFirstCertificate, Player.WHITE);
assert.equal(modernFirstCertificate.playMove([3, 1]).success, true);
assert.equal(
  protectedRootInvariantHolds(modernFirstCertificate, Player.WHITE, modernSecondBefore, 1),
  true,
  "the protected second-player root remains eligible for the existing certificate",
);

const legacyCertificate = new GameEngine({
  gridSize: 5,
  playerCount: 2,
  boardShape: "triangle",
  startPlayer: Player.BLACK,
  rulesVersion: TerritoryRulesVersion.V3,
  protectionRule: LEGACY,
});
const legacyFirstBefore = playerPieces(legacyCertificate, Player.BLACK);
assert.equal(legacyCertificate.playMove([0, 1]).success, true);
assert.equal(
  protectedRootInvariantHolds(legacyCertificate, Player.BLACK, legacyFirstBefore, 1),
  true,
  "legacy symmetric first-player certificates must remain valid",
);
assert.equal("protectionRule" in passDisciplineRuleState(legacyCertificate), false);

// replayBatch must construct its isolated transaction with the same protection rule.
const batched = new GameEngine({
  gridSize: 5,
  playerCount: 2,
  boardShape: "triangle",
  startPlayer: Player.BLACK,
  rulesVersion: TerritoryRulesVersion.V3,
  protectionRule: MODERN,
});
assert.equal(batched.playMove([0, 1]).success, true);
const batchResult = batched.replayBatch((transaction) => {
  assert.equal(transaction.protectionRule, MODERN);
  assert.equal(transaction.currentPlayer, Player.WHITE);
  assert.equal(hasMove(transaction, [1, 0]), true);
  return transaction.playMove([1, 0]);
});
assert.equal(batchResult.success, true);
assert.equal(batched.turnCount, 2);
assert.equal(batched._getState([1, 0]), batched._getPlayerStates(Player.WHITE).node);

// Worker state carries the rule explicitly, including custom starts and the actual starter.
const serialized = serializeEngineState(custom);
assert.equal(serialized.protectionRule, MODERN);
assert.equal(serialized.startPlayer, Player.BLACK);
assert.deepEqual(serialized.initialPositions, { BLACK: [0, 2], WHITE: [2, 2] });

// A missing field in an old Worker reply means symmetric, but must never be
// accepted for a modern request whose legality semantics differ.
const legacyWorkerRequest = captureWorkerRequest(legacy, "legacy-worker");
const legacyWorkerReply = {
  requestId: "legacy-worker",
  positionRevision: legacy.positionRevision,
  rulesVersion: legacy.rulesVersion,
  currentPlayer: legacy.currentPlayer,
};
assert.equal(isWorkerResultForRequest(legacy, legacyWorkerRequest, legacyWorkerReply), true);
const modernWorkerRequest = captureWorkerRequest(custom, "modern-worker");
const modernWorkerReply = {
  requestId: "modern-worker",
  positionRevision: custom.positionRevision,
  rulesVersion: custom.rulesVersion,
  currentPlayer: custom.currentPlayer,
};
assert.equal(isWorkerResultForRequest(custom, modernWorkerRequest, modernWorkerReply), false);
assert.equal(
  isWorkerResultForRequest(
    custom,
    modernWorkerRequest,
    { ...modernWorkerReply, protectionRule: MODERN },
  ),
  true,
);

const replaySettings = {
  gridSize: 5,
  playerCount: 2,
  boardShape: "triangle",
  startPlayer: Player.BLACK,
  rulesVersion: TerritoryRulesVersion.V3,
  protectionRule: MODERN,
  turnTimerEnabled: false,
  turnTimeLimitSeconds: 60,
  hintEnabled: false,
  hintMaxCount: 0,
};
const modernReplay = await createReplayDocument(replaySettings, [
  { type: "move", player: Player.BLACK, point: [0, 1] },
  { type: "move", player: Player.WHITE, point: [1, 0] },
]);
assert.equal(modernReplay.protectionRule, MODERN);
assert.equal(modernReplay.config.protectionRule, MODERN);
assert.equal(modernReplay.initialState.ruleState.protectionRule, MODERN);
const modernReplayResult = await validateReplayDocument(modernReplay);
assert.equal(modernReplayResult.success, true);
assert.equal(modernReplayResult.settings.protectionRule, MODERN);
assert.deepEqual(modernReplayResult.actions.map((action) => action.type), ["player_move", "player_move"]);

// Simulate a pre-field replay: missing protectionRule must mean symmetric-v1.
const oldReplay = await createReplayDocument(
  { ...replaySettings, protectionRule: LEGACY },
  [
    { type: "move", player: Player.BLACK, point: [0, 1] },
    { type: "skip", player: Player.WHITE },
  ],
);
delete oldReplay.protectionRule;
delete oldReplay.config.protectionRule;
oldReplay.integrity.canonicalDocumentHash = `sha256:${createHash("sha256")
  .update(canonicalize({
    ...oldReplay,
    integrity: { ...oldReplay.integrity, canonicalDocumentHash: null },
  }))
  .digest("hex")}`;
const oldReplayResult = await validateReplayDocument(oldReplay);
assert.equal(oldReplayResult.success, true);
assert.equal(oldReplayResult.settings.protectionRule ?? LEGACY, LEGACY);
assert.equal(oldReplayResult.document.protectionRule, undefined);

console.log(JSON.stringify({
  status: "PASS",
  rule: MODERN,
  coverage: [
    "actual BLACK/WHITE starter reversal",
    "default and custom starts",
    "two-player hex and three-player symmetric scope",
    "legacy engine default",
    "getLegalMoves/playMove/replayBatch",
    "AI state serialization",
    "new replay round-trip and old replay fallback",
  ],
}));
