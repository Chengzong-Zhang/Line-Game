import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { TERRITORY_V2_HOT_PATH_FIXTURES } from "./territory-v2-fixtures.mjs";

const frontendRoot = new URL("../", import.meta.url);

function asDataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

async function readFrontendSource(name) {
  return fs.readFile(new URL(name, frontendRoot), "utf8");
}

function sourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

const engineSource = await readFrontendSource("GameEngine.js");
const engineUrl = asDataUrl(engineSource);
const {
  GameEngine,
  Player,
  TerritoryRulesVersion,
} = await import(engineUrl);

const rendererStubUrl = asDataUrl(`
  export default class Renderer {}
`);
const networkStubUrl = asDataUrl(`
  export const ServerEvent = Object.freeze({
    OPPONENT_MOVE: "OPPONENT_MOVE",
    TURN_SKIPPED: "TURN_SKIPPED",
    PLAYER_RESIGNED: "PLAYER_RESIGNED",
  });
`);
const controllerSource = await readFrontendSource("GameController.js");
const rewrittenControllerSource = controllerSource
  .replace(
    /^import GameEngine, \{ Player, TerritoryRulesVersion \} from "\.\/GameEngine\.js\?v=[^"]+";/m,
    `import GameEngine, { Player, TerritoryRulesVersion } from "${engineUrl}";`,
  )
  .replace(
    /^import Renderer from "\.\/Renderer\.js\?v=[^"]+";/m,
    `import Renderer from "${rendererStubUrl}";`,
  )
  .replace(
    /^import \{ ServerEvent \} from "\.\/NetworkManager\.js\?v=[^"]+";/m,
    `import { ServerEvent } from "${networkStubUrl}";`,
  );
assert.notEqual(rewrittenControllerSource, controllerSource, "controller imports must be rewritten");
const { GameController } = await import(asDataUrl(rewrittenControllerSource));
const {
  applyRoomSnapshotWithPostCommit,
  coordinateControllerRoomSnapshot,
  registerRoomSnapshotResponseListeners,
} = await import(asDataUrl(await readFrontendSource("OnlineRoomSync.js")));

function createControllerProbe(engineOptions) {
  const metrics = {
    invalidations: 0,
    renders: 0,
    stateChanges: 0,
    errors: [],
    lastRenderedSnapshot: null,
    lastState: null,
  };
  const controller = Object.create(GameController.prototype);
  controller.canvas = {
    style: {},
    setAttribute() {},
  };
  controller.options = { engine: { ...engineOptions } };
  controller.engine = new GameEngine(engineOptions);
  controller._validGridPoints = controller.engine.getValidPositions();
  controller.renderer = {
    invalidate() {
      metrics.invalidations += 1;
    },
    render(snapshot) {
      metrics.renders += 1;
      metrics.lastRenderedSnapshot = snapshot;
    },
  };
  controller._engineEpoch = 4;
  controller.stateChangeListener = (state) => {
    metrics.stateChanges += 1;
    metrics.lastState = state;
  };
  controller.networkErrorListener = (error) => {
    metrics.errors.push(error);
  };
  controller.multiplayerEnabled = false;
  controller.localPlayer = null;
  controller.roomReady = false;
  controller.opponentConnected = false;
  controller.networkManager = null;
  controller.lastAction = null;
  controller._networkUnsubscribers = [];
  controller._authoritativeSnapshotValid = true;
  return { controller, metrics };
}

function snapshotWithoutRenderFields(snapshot) {
  const { renderEpoch, lastAction, ...rest } = snapshot;
  return rest;
}

for (const rulesVersion of Object.values(TerritoryRulesVersion)) {
  for (const playerCount of [2, 3]) {
    const fresh = new GameEngine({ gridSize: 9, playerCount, rulesVersion });
    for (const player of fresh.activePlayers) {
      assert.deepEqual(
        fresh.cachedTerritories[player],
        fresh._computeTerritory(player),
        `fresh ${rulesVersion}/${playerCount}-player territory cache must be exact`,
      );
    }
  }
}

const rollbackEngine = new GameEngine({
  gridSize: 9,
  playerCount: 2,
  rulesVersion: TerritoryRulesVersion.V2,
});
const rollbackSnapshot = rollbackEngine.getSnapshot();
const rollbackHistory = [...rollbackEngine.historyHashes];
const rejectedBatch = rollbackEngine.replayBatch((engine) => {
  const move = engine.playMove([1, 0]);
  assert.equal(move.success, true);
  assert.equal(move.snapshot, null);
  return { success: false, reason: "TEST_REJECTION" };
});
assert.equal(rejectedBatch.success, false);
assert.deepEqual(rollbackEngine.getSnapshot(), rollbackSnapshot);
assert.deepEqual([...rollbackEngine.historyHashes], rollbackHistory);
assert.throws(() => rollbackEngine.replayBatch((engine) => {
  assert.equal(engine.playMove([1, 0]).success, true);
  throw new Error("TEST_EXCEPTION");
}), /TEST_EXCEPTION/);
assert.deepEqual(rollbackEngine.getSnapshot(), rollbackSnapshot);
let asyncCallbackInvoked = false;
assert.throws(() => rollbackEngine.replayBatch(async () => {
  asyncCallbackInvoked = true;
  return { success: true };
}), /does not accept async callbacks/);
assert.equal(asyncCallbackInvoked, false);
assert.throws(() => rollbackEngine.replayBatch((engine) => {
  assert.equal(engine.playMove([1, 0]).success, true);
  return Promise.resolve({ success: true });
}), /does not accept Promise results/);
assert.deepEqual(rollbackEngine.getSnapshot(), rollbackSnapshot);
assert.throws(() => rollbackEngine.replayBatch((engine) => (
  Promise.resolve().then(() => engine.playMove([1, 0]))
)), /does not accept Promise results/);
await Promise.resolve();
await Promise.resolve();
assert.deepEqual(
  rollbackEngine.getSnapshot(),
  rollbackSnapshot,
  "queued Promise work must only mutate the discarded transaction engine",
);
assert.throws(() => rollbackEngine.replayBatch(() => (
  Promise.reject(new Error("TEST_ASYNC_REJECTION"))
)), /does not accept Promise results/);
await Promise.resolve();
await Promise.resolve();
assert.deepEqual(rollbackEngine.getSnapshot(), rollbackSnapshot);

for (const rulesVersion of Object.values(TerritoryRulesVersion)) {
  for (const playerCount of [2, 3]) {
    const options = { gridSize: 5, playerCount, rulesVersion };
    const reference = new GameEngine(options);
    const transactionTarget = new GameEngine(options);
    const prefixPoint = reference.getLegalMoves()[0]?.point;
    assert.ok(prefixPoint);
    assert.equal(reference.playMove(prefixPoint).success, true);
    assert.equal(transactionTarget.playMove(prefixPoint).success, true);

    const batchedPoints = [];
    for (let index = 0; index < 2 && !reference.gameOver; index += 1) {
      const point = reference.getLegalMoves()[0]?.point;
      if (!point) break;
      batchedPoints.push([...point]);
      assert.equal(reference.playMove(point).success, true);
    }
    const transactionResult = transactionTarget.replayBatch((engine) => {
      for (const point of batchedPoints) {
        const result = engine.playMove(point);
        if (!result.success) return result;
      }
      return { success: true, reason: null };
    });
    assert.equal(transactionResult.success, true);
    assert.deepEqual(
      transactionTarget.getSnapshot(),
      reference.getSnapshot(),
      `non-initial transaction mismatch for ${rulesVersion}/${playerCount}-player`,
    );
  }
}

const fixture = TERRITORY_V2_HOT_PATH_FIXTURES.find((candidate) => (
  candidate.name === "two-player-9-midgame"
));
assert.ok(fixture, "two-player recovery fixture is required");
const replayMoves = fixture.moves.slice(0, 8);
const replayActions = replayMoves.map((point) => ({
  type: "player_move",
  point: [...point],
}));
const restoredOptions = {
  gridSize: fixture.gridSize,
  playerCount: fixture.playerCount,
  startPlayer: Player.BLACK,
  rulesVersion: TerritoryRulesVersion.V2,
};

const referenceEngine = new GameEngine(restoredOptions);
let referenceLastAction = null;
for (const point of replayMoves) {
  const actingPlayer = referenceEngine.getCurrentPlayer();
  const result = referenceEngine.playMove(point);
  assert.equal(result.success, true, `reference replay failed at ${point}`);
  referenceLastAction = { type: "move", player: actingPlayer, point: [...point] };
}
const referenceSnapshot = referenceEngine.getSnapshot();

const successProbe = createControllerProbe({
  gridSize: 5,
  playerCount: 2,
  startPlayer: Player.WHITE,
  rulesVersion: TerritoryRulesVersion.V1,
});
assert.equal(successProbe.controller.engine.playMove([2, 0]).success, true);
const replacedEngine = successProbe.controller.engine;
const originalUpdateTerritories = GameEngine.prototype._updateTerritories;
const originalComputeTerritory = GameEngine.prototype._computeTerritory;
const originalGetSnapshot = GameEngine.prototype.getSnapshot;
const originalPlayMove = GameEngine.prototype.playMove;
let candidateTerritoryUpdates = 0;
let candidateTerritoryUpdatesDuringBatch = 0;
let candidateTerritoryComputationsDuringBatch = 0;
let candidateSnapshotReads = 0;
let candidateSnapshotReadsDuringBatch = 0;
let replacedEngineSnapshotReads = 0;
let engineStayedOldDuringReplay = true;

GameEngine.prototype._updateTerritories = function countCandidateTerritories(...args) {
  if (this !== replacedEngine) {
    candidateTerritoryUpdates += 1;
    if (this._isReplayingBatch) {
      candidateTerritoryUpdatesDuringBatch += 1;
    }
    if (successProbe.controller.engine !== replacedEngine) {
      engineStayedOldDuringReplay = false;
    }
  }
  return originalUpdateTerritories.apply(this, args);
};
GameEngine.prototype._computeTerritory = function countCandidateTerritoryComputations(...args) {
  if (this !== replacedEngine && this._isReplayingBatch) {
    candidateTerritoryComputationsDuringBatch += 1;
  }
  return originalComputeTerritory.apply(this, args);
};
GameEngine.prototype.getSnapshot = function countCandidateSnapshots(...args) {
  if (this === replacedEngine) {
    replacedEngineSnapshotReads += 1;
  } else {
    candidateSnapshotReads += 1;
    if (this._isReplayingBatch) {
      candidateSnapshotReadsDuringBatch += 1;
    }
    if (successProbe.controller.engine !== replacedEngine) {
      engineStayedOldDuringReplay = false;
    }
  }
  return originalGetSnapshot.apply(this, args);
};
GameEngine.prototype.playMove = function observeAtomicReplay(...args) {
  if (this !== replacedEngine && successProbe.controller.engine !== replacedEngine) {
    engineStayedOldDuringReplay = false;
  }
  const result = originalPlayMove.apply(this, args);
  if (this !== replacedEngine) {
    assert.equal(result.snapshot, null, "batched action must not create a snapshot");
  }
  return result;
};

let successResult;
try {
  successResult = successProbe.controller.restoreMatchState({
    settings: restoredOptions,
    actions: replayActions,
  });
} finally {
  GameEngine.prototype._updateTerritories = originalUpdateTerritories;
  GameEngine.prototype._computeTerritory = originalComputeTerritory;
  GameEngine.prototype.getSnapshot = originalGetSnapshot;
  GameEngine.prototype.playMove = originalPlayMove;
}

assert.equal(successResult.success, true);
assert.equal(successResult.reason, null);
assert.equal(engineStayedOldDuringReplay, true, "current engine changed before replay completed");
assert.notEqual(successProbe.controller.engine, replacedEngine);
assert.equal(candidateTerritoryUpdates, 1, "recovery must settle territory exactly once");
assert.equal(candidateTerritoryUpdatesDuringBatch, 0);
assert.equal(candidateTerritoryComputationsDuringBatch, 0);
assert.equal(candidateSnapshotReads, 1, "recovery must create exactly one candidate snapshot");
assert.equal(candidateSnapshotReadsDuringBatch, 0);
assert.equal(replacedEngineSnapshotReads, 0, "successful recovery must not snapshot the replaced engine");
assert.equal(successProbe.metrics.invalidations, 1);
assert.equal(successProbe.metrics.renders, 1);
assert.equal(successProbe.metrics.stateChanges, 1);
assert.equal(successProbe.metrics.errors.length, 0);
assert.equal(successProbe.controller._engineEpoch, 5);
assert.deepEqual(successProbe.controller.options.engine, restoredOptions);
assert.deepEqual(successProbe.controller.lastAction, referenceLastAction);
assert.deepEqual(successResult.state.snapshot, referenceSnapshot);
assert.deepEqual(
  snapshotWithoutRenderFields(successProbe.metrics.lastRenderedSnapshot),
  referenceSnapshot,
);
assert.deepEqual(
  [...successProbe.controller.engine.historyHashes].sort(),
  [...referenceEngine.historyHashes].sort(),
);

const mixedOptions = {
  gridSize: 5,
  playerCount: 3,
  startPlayer: Player.BLACK,
  rulesVersion: TerritoryRulesVersion.V1,
};
const mixedReference = new GameEngine(mixedOptions);
const mixedActions = [];
const firstMixedPoint = mixedReference.getLegalMoves()[0].point;
assert.equal(mixedReference.playMove(firstMixedPoint).success, true);
mixedActions.push({ type: "player_move", point: [...firstMixedPoint] });
assert.equal(mixedReference.skipTurn().success, true);
mixedActions.push({ type: "player_skip" });
const resignedPlayer = mixedReference.getCurrentPlayer();
assert.equal(mixedReference.resignPlayer(resignedPlayer).success, true);
mixedActions.push({ type: "player_resign", color: resignedPlayer });
if (!mixedReference.gameOver) {
  const finalMixedPoint = mixedReference.getLegalMoves()[0]?.point;
  assert.ok(finalMixedPoint, "mixed replay requires a final legal move");
  assert.equal(mixedReference.playMove(finalMixedPoint).success, true);
  mixedActions.push({ type: "player_move", point: [...finalMixedPoint] });
}
const mixedProbe = createControllerProbe({
  gridSize: 9,
  playerCount: 2,
  rulesVersion: TerritoryRulesVersion.V2,
});
const mixedResult = mixedProbe.controller.restoreMatchState({
  settings: mixedOptions,
  actions: mixedActions,
});
assert.equal(mixedResult.success, true);
assert.deepEqual(mixedResult.state.snapshot, mixedReference.getSnapshot());
assert.deepEqual(
  [...mixedProbe.controller.engine.historyHashes].sort(),
  [...mixedReference.historyHashes].sort(),
);

const failureProbe = createControllerProbe({
  gridSize: 5,
  playerCount: 2,
  startPlayer: Player.BLACK,
  rulesVersion: TerritoryRulesVersion.V2,
});
assert.equal(failureProbe.controller.engine.playMove([2, 0]).success, true);
failureProbe.controller._setLastAction({
  type: "move",
  player: Player.BLACK,
  point: [2, 0],
});
failureProbe.controller.multiplayerEnabled = true;
failureProbe.controller.localPlayer = Player.BLACK;
failureProbe.controller.roomReady = true;
failureProbe.controller.opponentConnected = true;
failureProbe.controller.networkManager = {
  sendMove() {},
  sendReset() {},
  isConnected: () => true,
};
const preservedEngine = failureProbe.controller.engine;
const preservedOptions = structuredClone(failureProbe.controller.options.engine);
const preservedLastAction = structuredClone(failureProbe.controller.lastAction);
const preservedPoints = failureProbe.controller._validGridPoints;
const preservedEpoch = failureProbe.controller._engineEpoch;
const preservedSnapshot = preservedEngine.getSnapshot();
let failedCandidateTerritoryUpdates = 0;
let failedCandidateSnapshotReads = 0;

GameEngine.prototype._updateTerritories = function countFailedCandidateTerritories(...args) {
  if (this !== preservedEngine) {
    failedCandidateTerritoryUpdates += 1;
  }
  return originalUpdateTerritories.apply(this, args);
};
GameEngine.prototype.getSnapshot = function countFailedCandidateSnapshots(...args) {
  if (this !== preservedEngine) {
    failedCandidateSnapshotReads += 1;
  }
  return originalGetSnapshot.apply(this, args);
};

let failureResult;
try {
  failureResult = failureProbe.controller.restoreMatchState({
    settings: restoredOptions,
    actions: [replayActions[0], replayActions[0]],
  });
} finally {
  GameEngine.prototype._updateTerritories = originalUpdateTerritories;
  GameEngine.prototype.getSnapshot = originalGetSnapshot;
}

assert.equal(failureResult.success, false);
assert.match(failureResult.reason, /Replay move 2 failed: INVALID_MOVE/);
assert.equal(failureProbe.controller.engine, preservedEngine);
assert.deepEqual(failureProbe.controller.options.engine, preservedOptions);
assert.deepEqual(failureProbe.controller.lastAction, preservedLastAction);
assert.equal(failureProbe.controller._validGridPoints, preservedPoints);
assert.equal(failureProbe.controller._engineEpoch, preservedEpoch);
assert.equal(failureProbe.controller.roomReady, false, "failed recovery must lock the preserved board");
assert.equal(failureProbe.controller.opponentConnected, false);
assert.equal(failureProbe.controller._authoritativeSnapshotValid, false);
assert.equal(failureResult.state.interactionLocked, true);
assert.equal(failureResult.state.interactionLockReason, "AUTHORITATIVE_SNAPSHOT_INVALID");
assert.deepEqual(preservedEngine.getSnapshot(), preservedSnapshot);
assert.deepEqual(failureResult.state.snapshot, preservedSnapshot);
assert.equal(failedCandidateTerritoryUpdates, 0, "failed replay must not settle candidate territory");
assert.equal(failedCandidateSnapshotReads, 0, "failed replay must not snapshot the candidate");
assert.equal(failureProbe.metrics.invalidations, 0);
assert.equal(failureProbe.metrics.renders, 0);
assert.equal(failureProbe.metrics.stateChanges, 0);
assert.equal(failureProbe.metrics.errors.length, 1);
failureProbe.controller.setMultiplayerState({
  roomReady: true,
  opponentConnected: true,
}, false);
const relockedMetadataState = failureProbe.controller.getGameState();
assert.equal(relockedMetadataState.interactionLocked, true);
assert.equal(relockedMetadataState.interactionLockReason, "AUTHORITATIVE_SNAPSHOT_INVALID");
const metadataOnlyAfterFailure = coordinateControllerRoomSnapshot({
  controller: failureProbe.controller,
  payload: {},
  incomingSettings: failureProbe.controller.options.engine,
  resetController: false,
  syncOnlineController(_payload, syncState) {
    return failureProbe.controller.enableMultiplayer({
      networkManager: failureProbe.controller.networkManager,
      localPlayer: Player.BLACK,
      roomReady: true,
      opponentConnected: true,
    }, syncState);
  },
  applySettingsToController(settings, reset, commitToController) {
    assert.equal(commitToController, true);
    return failureProbe.controller.setGameConfig(settings, reset);
  },
});
assert.equal(metadataOnlyAfterFailure.success, true);
assert.equal(metadataOnlyAfterFailure.authoritativeSnapshotAccepted, false);
assert.equal(failureProbe.controller.engine, preservedEngine);
assert.equal(failureProbe.controller._authoritativeSnapshotValid, false);
assert.equal(failureProbe.metrics.lastState.interactionLockReason, "AUTHORITATIVE_SNAPSHOT_INVALID");
const blockedRemoteSnapshot = preservedEngine.getSnapshot();
const blockedRemotePoint = preservedEngine.getLegalMoves()[0]?.point;
assert.ok(blockedRemotePoint, "preserved engine requires a legal remote-move probe");
const blockedRemoteMove = failureProbe.controller.applyRemoteMove(blockedRemotePoint);
const blockedRemoteSkip = failureProbe.controller.applyRemoteSkip();
const blockedRemoteResign = failureProbe.controller.applyRemoteResign(Player.WHITE);
for (const blockedResult of [blockedRemoteMove, blockedRemoteSkip, blockedRemoteResign]) {
  assert.equal(blockedResult.success, false);
  assert.equal(blockedResult.reason, "AUTHORITATIVE_SNAPSHOT_INVALID");
}
assert.deepEqual(
  preservedEngine.getSnapshot(),
  blockedRemoteSnapshot,
  "incremental room events must not mutate a board preserved after recovery failure",
);

const authoritativeResetAfterFailure = coordinateControllerRoomSnapshot({
  controller: failureProbe.controller,
  payload: {},
  incomingSettings: restoredOptions,
  resetController: true,
  syncOnlineController(_payload, syncState) {
    return failureProbe.controller.enableMultiplayer({
      networkManager: failureProbe.controller.networkManager,
      localPlayer: Player.BLACK,
      roomReady: true,
      opponentConnected: true,
    }, syncState);
  },
  applySettingsToController(settings, reset, commitToController) {
    assert.equal(commitToController, true);
    return failureProbe.controller.setGameConfig(settings, reset);
  },
});
assert.equal(authoritativeResetAfterFailure.success, true);
assert.equal(authoritativeResetAfterFailure.authoritativeSnapshotAccepted, true);
assert.notEqual(failureProbe.controller.engine, preservedEngine);
assert.equal(failureProbe.controller._authoritativeSnapshotValid, true);
assert.equal(failureProbe.metrics.lastState.interactionLocked, false);
assert.equal(failureProbe.controller.canvas.style.cursor, "pointer");

const commitFailureProbe = createControllerProbe({
  gridSize: 5,
  playerCount: 2,
  startPlayer: Player.WHITE,
  rulesVersion: TerritoryRulesVersion.V1,
});
assert.equal(commitFailureProbe.controller.engine.playMove([2, 0]).success, true);
commitFailureProbe.controller._setLastAction({
  type: "move",
  player: Player.WHITE,
  point: [2, 0],
});
const commitFailureEngine = commitFailureProbe.controller.engine;
const commitFailureOptions = commitFailureProbe.controller.options.engine;
const commitFailurePoints = commitFailureProbe.controller._validGridPoints;
const commitFailureEpoch = commitFailureProbe.controller._engineEpoch;
const commitFailureLastAction = structuredClone(commitFailureProbe.controller.lastAction);
const commitFailureSnapshot = commitFailureEngine.getSnapshot();
const normalInvalidate = commitFailureProbe.controller.renderer.invalidate;
let rejectNextInvalidate = true;
commitFailureProbe.controller.renderer.invalidate = () => {
  if (rejectNextInvalidate) {
    rejectNextInvalidate = false;
    throw new Error("TEST_RENDERER_INVALIDATE");
  }
  normalInvalidate();
};
const commitFailureResult = commitFailureProbe.controller.restoreMatchState({
  settings: restoredOptions,
  actions: replayActions,
});
assert.equal(commitFailureResult.success, false);
assert.match(commitFailureResult.reason, /TEST_RENDERER_INVALIDATE/);
assert.equal(commitFailureProbe.controller.engine, commitFailureEngine);
assert.equal(commitFailureProbe.controller.options.engine, commitFailureOptions);
assert.equal(commitFailureProbe.controller._validGridPoints, commitFailurePoints);
assert.equal(commitFailureProbe.controller._engineEpoch, commitFailureEpoch);
assert.deepEqual(commitFailureProbe.controller.lastAction, commitFailureLastAction);
assert.deepEqual(commitFailureProbe.controller.engine.getSnapshot(), commitFailureSnapshot);
assert.deepEqual(commitFailureResult.state.snapshot, commitFailureSnapshot);
assert.equal(commitFailureProbe.metrics.errors.length, 1);

const listenerProbe = createControllerProbe(restoredOptions);
const subscribedEvents = [];
listenerProbe.controller.setNetworkManager({
  on(eventName) {
    subscribedEvents.push(eventName);
    return () => {};
  },
});
assert.deepEqual(subscribedEvents, [
  "OPPONENT_MOVE",
  "TURN_SKIPPED",
  "PLAYER_RESIGNED",
]);
let silentMetadataSnapshotReads = 0;
const listenerProbeGetSnapshot = listenerProbe.controller.engine.getSnapshot.bind(listenerProbe.controller.engine);
listenerProbe.controller.engine.getSnapshot = (...args) => {
  silentMetadataSnapshotReads += 1;
  return listenerProbeGetSnapshot(...args);
};
assert.equal(listenerProbe.controller.enableMultiplayer({
  networkManager: listenerProbe.controller.networkManager,
  localPlayer: Player.BLACK,
  roomReady: true,
  opponentConnected: true,
}, false), null);
assert.equal(silentMetadataSnapshotReads, 0, "room metadata must not snapshot before atomic recovery");
assert.equal(listenerProbe.controller.localPlayer, Player.BLACK);
assert.equal(listenerProbe.controller.roomReady, true);
assert.equal(listenerProbe.controller.opponentConnected, true);

const onlineAppSource = await readFrontendSource("OnlineApp.js");
for (const [startMarker, endMarker] of [
  ["const refreshRoomSnapshot = async () =>", "const attemptReconnect = async () =>"],
  ["const attemptReconnect = async () =>", "const scheduleReconnect = () =>"],
  ["const handleCreateRoom = async () =>", "const handleJoinRoom = async () =>"],
  ["const handleJoinRoom = async () =>", "const handleLeaveRoom = async () =>"],
]) {
  const section = sourceSection(onlineAppSource, startMarker, endMarker);
  assert.doesNotMatch(
    section,
    /applyRoomSnapshot\s*\(/,
    `${startMarker} must leave snapshot application to the room event listener`,
  );
}
const applySnapshotSection = sourceSection(
  onlineAppSource,
  "const applyRoomSnapshot = (payload, resetController = true) =>",
  "const refreshRoomSnapshot = async () =>",
);
assert.match(applySnapshotSection, /coordinateControllerRoomSnapshot\s*\(/);
assert.doesNotMatch(
  applySnapshotSection,
  /restoreMatchState|setGameConfig|_replaceEngine|resetGame/,
  "OnlineApp must delegate controller recovery to the tested coordinator",
);
const handleSkipSection = sourceSection(
  onlineAppSource,
  "const handleSkip = async () =>",
  "const handleReset = async () =>",
);
assert.match(handleSkipSection, /roomSnapshotRecoveryFailed\s*\|\|\s*gameState\.value\.skipLocked/);
const handleResetSection = sourceSection(
  onlineAppSource,
  "const handleReset = async () =>",
  "const handleToggleReady = async \(ready\) =>",
);
assert.match(handleResetSection, /roomSnapshotRecoveryFailed\s*\|\|\s*gameState\.value\.resetLocked/);
const resetDisabledSection = sourceSection(
  onlineAppSource,
  "const resetDisabled = computed(() =>",
  "const readyDisabled = computed(() =>",
);
assert.match(resetDisabledSection, /if \(gameState\.value\.resetLocked\) \{\s*return true;/);

const coordinationCalls = [];
const coordinationState = { marker: "restored" };
const coordinationPayload = {
  matchState: { actions: replayActions },
};
const coordinationSettings = { ...restoredOptions };
const coordinated = coordinateControllerRoomSnapshot({
  controller: {
    restoreMatchState(matchState) {
      coordinationCalls.push(["restore", matchState]);
      return { success: true, reason: null, state: coordinationState };
    },
    setAuthoritativeSnapshotValid(isValid) {
      coordinationCalls.push(["valid", isValid]);
    },
  },
  payload: coordinationPayload,
  incomingSettings: coordinationSettings,
  resetController: true,
  syncOnlineController(payload, syncState) {
    coordinationCalls.push(["metadata", payload, syncState]);
  },
  applySettingsToController(settings, reset, commitToController) {
    coordinationCalls.push(["settings", settings, reset, commitToController]);
  },
});
assert.equal(coordinated.success, true);
assert.equal(coordinated.state, coordinationState);
assert.equal(coordinated.authoritativeSnapshotAccepted, true);
assert.deepEqual(coordinationCalls.map((call) => call[0]), ["metadata", "restore", "valid", "settings"]);
assert.equal(coordinationCalls[0][2], false, "match metadata must sync without a pre-replay snapshot");
assert.deepEqual(coordinationCalls[1][1], {
  ...coordinationPayload.matchState,
  settings: coordinationSettings,
});
assert.deepEqual(coordinationCalls[2], ["valid", true]);
assert.deepEqual(coordinationCalls[3], ["settings", coordinationSettings, false, false]);

const failedCoordinationCalls = [];
const coordinatedFailure = coordinateControllerRoomSnapshot({
  controller: {
    restoreMatchState() {
      failedCoordinationCalls.push("restore");
      return { success: false, reason: "INVALID_LOG", state: { interactionLocked: true } };
    },
    setMultiplayerState(partial, syncState) {
      failedCoordinationCalls.push(["lock", partial, syncState]);
    },
    setAuthoritativeSnapshotValid(isValid) {
      failedCoordinationCalls.push(["valid", isValid]);
    },
  },
  payload: coordinationPayload,
  incomingSettings: coordinationSettings,
  syncOnlineController(_payload, syncState) {
    failedCoordinationCalls.push(`metadata:${syncState}`);
  },
  applySettingsToController() {
    failedCoordinationCalls.push("settings");
  },
});
assert.equal(coordinatedFailure.success, false);
assert.equal(coordinatedFailure.authoritativeSnapshotAccepted, false);
assert.deepEqual(failedCoordinationCalls, [
  "metadata:false",
  "restore",
  ["valid", false],
  ["lock", { roomReady: false, opponentConnected: false }, false],
]);

const resetCoordinationCalls = [];
const coordinatedWithoutMatch = coordinateControllerRoomSnapshot({
  controller: {
    setAuthoritativeSnapshotValid(isValid) {
      resetCoordinationCalls.push(["valid", isValid]);
    },
  },
  payload: {},
  incomingSettings: coordinationSettings,
  resetController: true,
  syncOnlineController(_payload, syncState) {
    resetCoordinationCalls.push(["metadata", syncState]);
  },
  applySettingsToController(_settings, reset, commitToController) {
    resetCoordinationCalls.push(["settings", reset, commitToController]);
  },
});
assert.equal(coordinatedWithoutMatch.success, true);
assert.equal(coordinatedWithoutMatch.authoritativeSnapshotAccepted, true);
assert.deepEqual(resetCoordinationCalls, [
  ["metadata", false],
  ["valid", true],
  ["settings", true, true],
]);

const nonAuthoritativeCoordinationCalls = [];
const coordinatedMetadataOnly = coordinateControllerRoomSnapshot({
  controller: {
    setAuthoritativeSnapshotValid(isValid) {
      nonAuthoritativeCoordinationCalls.push(["valid", isValid]);
    },
  },
  payload: {},
  incomingSettings: coordinationSettings,
  resetController: false,
  syncOnlineController(_payload, syncState) {
    nonAuthoritativeCoordinationCalls.push(["metadata", syncState]);
  },
  applySettingsToController(_settings, reset, commitToController) {
    nonAuthoritativeCoordinationCalls.push(["settings", reset, commitToController]);
  },
});
assert.equal(coordinatedMetadataOnly.success, true);
assert.equal(coordinatedMetadataOnly.authoritativeSnapshotAccepted, false);
assert.deepEqual(nonAuthoritativeCoordinationCalls, [
  ["metadata", false],
  ["settings", false, true],
  ["metadata", true],
]);

let rejectedPostCommitCalls = 0;
assert.equal(applyRoomSnapshotWithPostCommit({
  payload: { type: "ROOM_STATE" },
  applyRoomSnapshot: () => false,
  onApplied: () => {
    rejectedPostCommitCalls += 1;
  },
}), false);
assert.equal(rejectedPostCommitCalls, 0, "rejected snapshots must not run page post-commit effects");
assert.equal(applyRoomSnapshotWithPostCommit({
  payload: { type: "ROOM_STATE" },
  applyRoomSnapshot: () => true,
  onApplied: () => {
    rejectedPostCommitCalls += 1;
  },
}), true);
assert.equal(rejectedPostCommitCalls, 1);

const registeredRoomHandlers = new Map();
let registeredResponseApplications = 0;
let registeredAppliedCallbacks = 0;
const registeredUnsubscribers = registerRoomSnapshotResponseListeners({
  networkManager: {
    on(eventName, handler) {
      assert.equal(registeredRoomHandlers.has(eventName), false, `duplicate listener for ${eventName}`);
      registeredRoomHandlers.set(eventName, handler);
      return () => registeredRoomHandlers.delete(eventName);
    },
  },
  roomCreatedEvent: "ROOM_CREATED",
  roomJoinedEvent: "ROOM_JOINED",
  applyRoomSnapshot(payload, resetController) {
    registeredResponseApplications += 1;
    assert.equal(resetController, true);
    assert.ok(payload.type === "ROOM_CREATED" || payload.type === "ROOM_JOINED");
    return true;
  },
  onApplied() {
    registeredAppliedCallbacks += 1;
  },
});
assert.equal(registeredUnsubscribers.length, 2);
assert.deepEqual([...registeredRoomHandlers.keys()], ["ROOM_CREATED", "ROOM_JOINED"]);
registeredRoomHandlers.get("ROOM_CREATED")({ type: "ROOM_CREATED" });
registeredRoomHandlers.get("ROOM_JOINED")({ type: "ROOM_JOINED" });
assert.equal(registeredResponseApplications, 2);
assert.equal(registeredAppliedCallbacks, 2);

const networkSource = await readFrontendSource("NetworkManager.js");
const { NetworkManager, ServerEvent } = await import(asDataUrl(networkSource));
const previousWebSocket = globalThis.WebSocket;
let verifiedRequestResponseApplications = 0;
globalThis.WebSocket = { OPEN: 1 };
try {
  const manager = new NetworkManager({ requestTimeout: 1000 });
  manager.socket = { readyState: 1, send() {} };
  const deliveryOrder = [];
  registerRoomSnapshotResponseListeners({
    networkManager: manager,
    roomCreatedEvent: ServerEvent.ROOM_CREATED,
    roomJoinedEvent: ServerEvent.ROOM_JOINED,
    applyRoomSnapshot(payload) {
      verifiedRequestResponseApplications += 1;
      deliveryOrder.push(`event:${payload.type}`);
      return true;
    },
  });
  const created = manager.createRoom({ gridSize: 9 }).then((payload) => {
    deliveryOrder.push("await:create");
    return payload;
  });
  await Promise.resolve();
  await Promise.resolve();
  manager._handleMessage({
    data: JSON.stringify({
      type: ServerEvent.ROOM_CREATED,
      roomId: "1234",
      playerId: "player-1",
      color: Player.BLACK,
    }),
  });
  assert.equal((await created).roomId, "1234");
  const joined = manager.joinRoom("1234").then((payload) => {
    deliveryOrder.push("await:join");
    return payload;
  });
  await Promise.resolve();
  manager._handleMessage({
    data: JSON.stringify({
      type: ServerEvent.ROOM_JOINED,
      roomId: "1234",
      playerId: "player-1",
      color: Player.BLACK,
    }),
  });
  const joinedPayload = await joined;
  assert.equal(joinedPayload.roomId, "1234");
  assert.equal(verifiedRequestResponseApplications, 2);
  assert.deepEqual(deliveryOrder, [
    "event:ROOM_CREATED",
    "await:create",
    "event:ROOM_JOINED",
    "await:join",
  ]);
} finally {
  globalThis.WebSocket = previousWebSocket;
}

console.log(JSON.stringify({
  atomicRecovery: {
    replayedActions: replayActions.length,
    territoryUpdates: candidateTerritoryUpdates,
    candidateSnapshots: candidateSnapshotReads,
    renderCommits: successProbe.metrics.renders,
    failedReplayPreservedEngine: true,
  },
  responseOwnership: {
    registeredResponseEvents: registeredRoomHandlers.size,
    requestResponseApplications: verifiedRequestResponseApplications,
  },
}, null, 2));
