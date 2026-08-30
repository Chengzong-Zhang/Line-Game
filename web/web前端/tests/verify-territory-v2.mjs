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

const engineSource = await readFrontendSource("GameEngine.js");
const engineUrl = asDataUrl(engineSource);
const {
  GameEngine,
  Player,
  PointState,
  TerritoryRulesVersion,
} = await import(engineUrl);

async function moduleUrlWithEngine(name) {
  const source = await readFrontendSource(name);
  const rewritten = source.replace(
    /^import\s+([^;]+)\s+from\s+"\.\/GameEngine\.js(?:\?v=[^"]+)?";/m,
    `import $1 from "${engineUrl}";`,
  );
  assert.notEqual(rewritten, source, `${name}: GameEngine import was not rewritten`);
  return asDataUrl(rewritten);
}

const aiEngineUrl = await moduleUrlWithEngine("AIEngine.js");
const rendererUrl = await moduleUrlWithEngine("Renderer.js");
const onlineAppStateUrl = await moduleUrlWithEngine("OnlineAppState.js");
const { saveState, restoreState } = await import(aiEngineUrl);
const { Renderer } = await import(rendererUrl);
const { isWorkerResultCurrent, serializeEngineState } = await import(
  asDataUrl(await readFrontendSource("AIStateProtocol.js"))
);
const {
  DEFAULT_RULES_VERSION,
  getPrimaryScores,
  loadStoredSession,
  normalizeGameSettings,
} = await import(onlineAppStateUrl);

const networkStubUrl = asDataUrl(`
  export const ClientEvent = Object.freeze({});
  export const ServerEvent = Object.freeze({});
  export default class NetworkManager {}
`);
const controllerSource = await readFrontendSource("GameController.js");
const controllerUrl = asDataUrl(
  controllerSource
    .replace(
      /^import GameEngine, \{ Player, TerritoryRulesVersion \} from "\.\/GameEngine\.js\?v=[^"]+";/m,
      `import GameEngine, { Player, TerritoryRulesVersion } from "${engineUrl}";`,
    )
    .replace(
      /^import Renderer from "\.\/Renderer\.js\?v=[^"]+";/m,
      `import Renderer from "${rendererUrl}";`,
    )
    .replace(
      /^import \{ ServerEvent \} from "\.\/NetworkManager\.js\?v=[^"]+";/m,
      `import { ServerEvent } from "${networkStubUrl}";`,
    ),
);
const { GameController } = await import(controllerUrl);

const B = Player.BLACK;
const W = Player.WHITE;
const P = Player.PURPLE;

function areas(game) {
  return Object.fromEntries(
    game.activePlayers.map((player) => [player, game.cachedTerritories[player].area]),
  );
}

function canonicalPolygonKey(polygon) {
  if (!polygon?.length) return "";
  const lastPoint = polygon[polygon.length - 1];
  const openPolygon = polygon.length > 1
    && polygon[0][0] === lastPoint[0]
    && polygon[0][1] === lastPoint[1]
    ? polygon.slice(0, -1)
    : polygon;
  const representations = [];
  for (const oriented of [openPolygon, [...openPolygon].reverse()]) {
    for (let offset = 0; offset < oriented.length; offset += 1) {
      representations.push(
        [...oriented.slice(offset), ...oriented.slice(0, offset)]
          .map((point) => `${point[0]},${point[1]}`)
          .join("|"),
      );
    }
  }
  representations.sort();
  return representations[0] ?? "";
}

function playMoves(game, moves, label) {
  moves.forEach((point, index) => {
    const result = game.playMove(point);
    assert.equal(result.success, true, `${label}: move ${index + 1} ${point} failed: ${result.reason}`);
  });
}

const degenerateV1 = new GameEngine({ gridSize: 5, playerCount: 2 });
assert.equal(degenerateV1.rulesVersion, TerritoryRulesVersion.V1);
assert.throws(() => {
  degenerateV1.rulesVersion = TerritoryRulesVersion.V2;
}, TypeError);
assert.equal(degenerateV1.playMove([2, 0]).success, true);
assert.equal(degenerateV1.cachedTerritories[B].area, 3);
assert.equal(degenerateV1.cachedTerritories[B].displayArea, 0);

const degenerateV2 = new GameEngine({
  gridSize: 5,
  playerCount: 2,
  rulesVersion: TerritoryRulesVersion.V2,
});
assert.equal(degenerateV2.playMove([2, 0]).success, true);
assert.deepEqual(areas(degenerateV2), { [B]: 0, [W]: 0 });

const symmetryMoves = [
  [1, 0], [5, 1], [4, 0], [2, 1], [0, 5],
  [2, 3], [1, 2], [1, 4], [0, 3], [0, 4],
];
const reflect = ([x, y], gridSize) => [gridSize - 1 - x - y, y];

const legacyOriginal = new GameEngine({ gridSize: 7, playerCount: 2, startPlayer: B });
const legacyMirrored = new GameEngine({ gridSize: 7, playerCount: 2, startPlayer: W });
playMoves(legacyOriginal, symmetryMoves, "legacy original");
playMoves(legacyMirrored, symmetryMoves.map((point) => reflect(point, 7)), "legacy mirror");
assert.deepEqual(areas(legacyOriginal), { [B]: 10, [W]: 10 });
assert.deepEqual(areas(legacyMirrored), { [B]: 11, [W]: 10 });

const v2Original = new GameEngine({
  gridSize: 7,
  playerCount: 2,
  startPlayer: B,
  rulesVersion: TerritoryRulesVersion.V2,
});
const v2Mirrored = new GameEngine({
  gridSize: 7,
  playerCount: 2,
  startPlayer: W,
  rulesVersion: TerritoryRulesVersion.V2,
});
playMoves(v2Original, symmetryMoves, "v2 original");
playMoves(v2Mirrored, symmetryMoves.map((point) => reflect(point, 7)), "v2 mirror");
assert.deepEqual(areas(v2Original), { [B]: 10, [W]: 11 });
assert.deepEqual(areas(v2Mirrored), { [B]: 11, [W]: 10 });
assert.equal(v2Original.skipTurn().success, true);
assert.equal(v2Original.skipTurn().success, true);
assert.equal(v2Original.getWinner(), W);
assert.equal(v2Mirrored.skipTurn().success, true);
assert.equal(v2Mirrored.skipTurn().success, true);
assert.equal(v2Mirrored.getWinner(), B);

for (const action of ["skip", "resign"]) {
  const game = new GameEngine({ rulesVersion: TerritoryRulesVersion.V2 });
  let territoryRefreshes = 0;
  game._updateTerritories = () => {
    territoryRefreshes += 1;
  };
  const result = action === "skip" ? game.skipTurn() : game.resignPlayer();
  assert.equal(result.success, true);
  assert.equal(territoryRefreshes, 0, `${action} must reuse the unchanged territory cache`);
  assert.equal(result.snapshot.positionRevision, 1);
}

assert.throws(
  () => new GameEngine({ rulesVersion: "territory-v999" }),
  /Unsupported territory rules version/,
);
assert.equal(degenerateV2._hasBoundaryCycle([[0, 0], [2, 0], [0, 2]]), false);

const publicScoreboard = v2Original.getScoreboard();
publicScoreboard[B].polygon[0][0] = 999;
assert.notEqual(v2Original.getScoreboard()[B].polygon[0][0], 999);

const pathEngine = new GameEngine({ gridSize: 5 });
const srcIdx = pathEngine._keyToIdx.get("0,0");
const tgtIdx = pathEngine._keyToIdx.get("2,2");
const bfs = pathEngine._bfsFromSource(srcIdx, new Set());
const expectedPaths = [
  [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2]],
  [[0, 0], [1, 0], [1, 1], [2, 1], [2, 2]],
  [[0, 0], [0, 1], [1, 1], [2, 1], [2, 2]],
  [[0, 0], [1, 0], [1, 1], [1, 2], [2, 2]],
  [[0, 0], [0, 1], [1, 1], [1, 2], [2, 2]],
  [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2]],
];
assert.deepEqual([...pathEngine._iterateReconstructedPaths(bfs, srcIdx, tgtIdx)], expectedPaths);
assert.deepEqual(pathEngine._reconstructPaths(bfs, srcIdx, tgtIdx), expectedPaths);
pathEngine._reconstructPaths = () => [];
assert.deepEqual([...pathEngine._iterateTerritoryPaths(bfs, srcIdx, tgtIdx)], []);

const pathHookWitnessMoves = [[4, 0], [2, 4], [2, 0], [2, 1]];
const pathHookBaseline = new GameEngine({ gridSize: 7, rulesVersion: TerritoryRulesVersion.V1 });
playMoves(pathHookBaseline, pathHookWitnessMoves, "path hook baseline");
assert.equal(pathHookBaseline.cachedTerritories[W].area, 11);
const pathHookOverride = new GameEngine({ gridSize: 7, rulesVersion: TerritoryRulesVersion.V1 });
let reconstructHookCalls = 0;
pathHookOverride._reconstructPaths = () => {
  reconstructHookCalls += 1;
  return [];
};
playMoves(pathHookOverride, pathHookWitnessMoves, "path hook override");
assert.ok(reconstructHookCalls > 0, "territory scoring must route through the compatibility hook");
assert.equal(pathHookOverride.cachedTerritories[W].area, 8);

const compactWallKeyEngine = new GameEngine({ gridSize: 15 });
for (const point of compactWallKeyEngine.validPositions) {
  assert.equal(
    compactWallKeyEngine._pointToIndex(point),
    compactWallKeyEngine._keyToIdx.get(`${point[0]},${point[1]}`),
  );
}
assert.equal(compactWallKeyEngine._pointToIndex([-1, 0]), -1);
assert.equal(compactWallKeyEngine._pointToIndex([15, 0]), -1);
assert.equal(compactWallKeyEngine._pointToIndex([0, 15]), -1);
assert.equal(compactWallKeyEngine._pointToIndex([0.5, 0]), -1);
assert.equal(compactWallKeyEngine._pointToIndex(null), -1);
assert.equal(compactWallKeyEngine._getWallSetKey([[15, 0]]), null);
const wallKeyPoints = [0, 31, 32, 63, 64, 95, 96, 119]
  .map((index) => compactWallKeyEngine.validPositions[index]);
assert.equal(
  compactWallKeyEngine._getWallSetKey(wallKeyPoints),
  compactWallKeyEngine._getWallSetKey([...wallKeyPoints].reverse().concat([wallKeyPoints[0]])),
  "compact wall keys must ignore order and duplicate vertices",
);
assert.notEqual(
  compactWallKeyEngine._getWallSetKey(wallKeyPoints),
  compactWallKeyEngine._getWallSetKey([...wallKeyPoints.slice(0, -1), compactWallKeyEngine.validPositions[118]]),
  "different wall sets must not share a compact key",
);

function legacyBoundaryCycle(engine, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  const equal = (left, right) => left[0] === right[0] && left[1] === right[1];
  const points = equal(polygon[0], polygon[polygon.length - 1])
    ? polygon.slice(0, -1)
    : polygon;
  if (points.length < 3) return false;
  const vertices = new Set();
  const edges = new Set();
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    if (equal(start, end)) continue;
    const startKey = `${start[0]},${start[1]}`;
    const endKey = `${end[0]},${end[1]}`;
    const startIndex = engine._keyToIdx.get(startKey);
    const endIndex = engine._keyToIdx.get(endKey);
    if (
      startIndex === undefined
      || endIndex === undefined
      || !engine._adjIdxList[startIndex].includes(endIndex)
    ) {
      return false;
    }
    vertices.add(startKey);
    vertices.add(endKey);
    edges.add(startKey < endKey ? `${startKey}|${endKey}` : `${endKey}|${startKey}`);
  }
  return vertices.size >= 3 && edges.size >= vertices.size;
}

assert.equal(compactWallKeyEngine._hasBoundaryCycle([[0, 0], [1, 0], [0, 1]]), true);
let boundaryCycleSeed = 0xc0ffee;
const boundaryCycleRandom = () => (
  (boundaryCycleSeed = (Math.imul(boundaryCycleSeed, 1664525) + 1013904223) >>> 0)
  / 4294967296
);
const boundaryCyclePointPool = [
  ...compactWallKeyEngine.validPositions,
  [-1, 0], [15, 0], [0, 15], [0.5, 0],
];
for (let sample = 0; sample < 5000; sample += 1) {
  const length = Math.floor(boundaryCycleRandom() * 12);
  const polygon = Array.from({ length }, () => (
    boundaryCyclePointPool[Math.floor(boundaryCycleRandom() * boundaryCyclePointPool.length)]
  ));
  if (polygon.length && boundaryCycleRandom() < 0.25) polygon.push([...polygon[0]]);
  assert.equal(
    compactWallKeyEngine._hasBoundaryCycle(polygon),
    legacyBoundaryCycle(compactWallKeyEngine, polygon),
    `numeric boundary cycle drift at sample ${sample}`,
  );
}

const permutations = [
  [0, 1, 2], [1, 0, 2], [0, 2, 1],
  [2, 1, 0], [1, 2, 0], [2, 0, 1],
];
const playerStates = {
  [B]: { node: PointState.BLACK_NODE, line: PointState.BLACK_LINE },
  [W]: { node: PointState.WHITE_NODE, line: PointState.WHITE_LINE },
  [P]: { node: PointState.PURPLE_NODE, line: PointState.PURPLE_LINE },
};
const stateDescriptor = new Map(
  Object.entries(playerStates).flatMap(([player, states]) => [
    [states.node, { player, kind: "node" }],
    [states.line, { player, kind: "line" }],
  ]),
);

function transformPoint(point, gridSize, permutation) {
  const barycentric = [point[0], point[1], gridSize - 1 - point[0] - point[1]];
  return [barycentric[permutation[0]], barycentric[permutation[1]]];
}

function samePoint(left, right) {
  return left[0] === right[0] && left[1] === right[1];
}

function makeD3Witness() {
  const game = new GameEngine({
    gridSize: 5,
    playerCount: 3,
    rulesVersion: TerritoryRulesVersion.V2,
  });
  playMoves(game, [
    [1, 0], [0, 2], [3, 1], [1, 2],
    [1, 3], [2, 0], [2, 1], [1, 1],
  ], "three-player D3 witness");
  assert.deepEqual(areas(game), { [B]: 0, [W]: 6, [P]: 4 });
  return game;
}

function transformStaticState(source, permutation) {
  const transformed = new GameEngine({
    gridSize: source.gridSize,
    playerCount: source.playerCount,
    rulesVersion: TerritoryRulesVersion.V2,
  });
  for (const key of transformed.grid.keys()) transformed.grid.set(key, PointState.EMPTY);
  for (const player of transformed.activePlayers) transformed.edges[player].clear();

  const playerMap = new Map();
  for (const sourcePlayer of source.activePlayers) {
    const transformedBase = transformPoint(source.initialPositions[sourcePlayer], source.gridSize, permutation);
    const targetPlayer = transformed.activePlayers.find(
      (candidate) => samePoint(transformed.initialPositions[candidate], transformedBase),
    );
    assert.ok(targetPlayer, `no player base at transformed corner ${transformedBase}`);
    playerMap.set(sourcePlayer, targetPlayer);
  }

  for (const [key, state] of source.grid) {
    if (state === PointState.EMPTY) continue;
    const descriptor = stateDescriptor.get(state);
    assert.ok(descriptor, `unknown point state ${state}`);
    const point = key.split(",").map(Number);
    const transformedPoint = transformPoint(point, source.gridSize, permutation);
    const targetPlayer = playerMap.get(descriptor.player);
    transformed._setState(transformedPoint, playerStates[targetPlayer][descriptor.kind]);
  }

  for (const sourcePlayer of source.activePlayers) {
    const targetPlayer = playerMap.get(sourcePlayer);
    for (const edgeKey of source.edges[sourcePlayer]) {
      const [left, right] = edgeKey.split("|").map((key) => key.split(",").map(Number));
      transformed.edges[targetPlayer].add(transformed._edgeKey(
        transformPoint(left, source.gridSize, permutation),
        transformPoint(right, source.gridSize, permutation),
      ));
    }
  }
  transformed._updateTerritories();
  return { transformed, playerMap };
}

const d3Witness = makeD3Witness();
for (const permutation of permutations) {
  const { transformed, playerMap } = transformStaticState(d3Witness, permutation);
  for (const sourcePlayer of d3Witness.activePlayers) {
    assert.equal(
      transformed.cachedTerritories[playerMap.get(sourcePlayer)].area,
      d3Witness.cachedTerritories[sourcePlayer].area,
      `D3 area mismatch for ${sourcePlayer} under ${permutation}`,
    );
  }
}

for (const fixture of TERRITORY_V2_HOT_PATH_FIXTURES) {
  const game = new GameEngine({
    gridSize: fixture.gridSize,
    playerCount: fixture.playerCount,
    rulesVersion: TerritoryRulesVersion.V2,
  });
  playMoves(game, fixture.moves, fixture.name);
  assert.deepEqual(areas(game), fixture.expectedAreas, `${fixture.name}: area drift`);
  assert.deepEqual(
    Object.fromEntries(game.activePlayers.map((player) => [
      player,
      canonicalPolygonKey(game.cachedTerritories[player].polygon),
    ])),
    fixture.expectedPolygonKeys,
    `${fixture.name}: canonical polygon drift`,
  );
}

const stateRoundTripSource = new GameEngine({ rulesVersion: TerritoryRulesVersion.V2 });
assert.equal(stateRoundTripSource.skipTurn().success, true);
assert.equal(stateRoundTripSource.resignPlayer(W).success, true);
const serialized = serializeEngineState(stateRoundTripSource);
assert.equal(serialized.rulesVersion, TerritoryRulesVersion.V2);
assert.equal(serialized.positionRevision, stateRoundTripSource.positionRevision);
assert.deepEqual(serialized.resignedPlayers, [W]);
assert.equal(isWorkerResultCurrent(stateRoundTripSource, serialized), true);
assert.equal(
  isWorkerResultCurrent(stateRoundTripSource, { ...serialized, positionRevision: serialized.positionRevision - 1 }),
  false,
);
const saved = saveState(stateRoundTripSource);
const stateRoundTripTarget = new GameEngine({ rulesVersion: TerritoryRulesVersion.V2 });
restoreState(stateRoundTripTarget, saved);
assert.deepEqual([...stateRoundTripTarget.resignedPlayers], [W]);
assert.equal(stateRoundTripTarget.positionRevision, stateRoundTripSource.positionRevision);

const previousSelf = globalThis.self;
const workerMessages = [];
const workerSelf = { postMessage: (message) => workerMessages.push(message) };
globalThis.self = workerSelf;
const workerSource = await readFrontendSource("AIWorker.js");
const workerUrl = asDataUrl(
  workerSource
    .replace(
      /^import \{ GameEngine \} from "\.\/GameEngine\.js\?v=[^"]+";/m,
      `import { GameEngine } from "${engineUrl}";`,
    )
    .replace(
      /^import \{ MinimaxAI, restoreState \} from "\.\/AIEngine\.js\?v=[^"]+";/m,
      `import { MinimaxAI, restoreState } from "${aiEngineUrl}";`,
    ),
);
await import(workerUrl);
workerSelf.onmessage({
  data: {
    type: "COMPUTE",
    requestId: "worker-round-trip",
    serializedState: serializeEngineState(new GameEngine({
      gridSize: 5,
      rulesVersion: TerritoryRulesVersion.V2,
    })),
    aiPlayer: B,
    depth: 1,
    topN: 1,
  },
});
assert.equal(workerMessages.at(-1).type, "RESULT");
assert.equal(workerMessages.at(-1).requestId, "worker-round-trip");
assert.equal(workerMessages.at(-1).positionRevision, 0);
assert.equal(workerMessages.at(-1).rulesVersion, TerritoryRulesVersion.V2);

const workerStateProbeAiUrl = asDataUrl(`
  import { restoreState as realRestoreState } from "${aiEngineUrl}";
  export { realRestoreState as restoreState };
  export class MinimaxAI {
    getTopMoves(engine, aiPlayer, topN) {
      return [{
        point: null,
        score: 0,
        observedAiPlayer: aiPlayer,
        observedTopN: topN,
        observedPositionRevision: engine.positionRevision,
        observedResignedPlayers: [...engine.resignedPlayers].sort(),
      }];
    }
  }
`);
const workerStateProbeUrl = asDataUrl(
  workerSource
    .replace(
      /^import \{ GameEngine \} from "\.\/GameEngine\.js\?v=[^"]+";/m,
      `import { GameEngine } from "${engineUrl}";`,
    )
    .replace(
      /^import \{ MinimaxAI, restoreState \} from "\.\/AIEngine\.js\?v=[^"]+";/m,
      `import { MinimaxAI, restoreState } from "${workerStateProbeAiUrl}";`,
    ),
);
await import(workerStateProbeUrl);
const workerStateProbeGame = new GameEngine({
  gridSize: 5,
  playerCount: 3,
  rulesVersion: TerritoryRulesVersion.V2,
});
assert.equal(workerStateProbeGame.playMove([1, 0]).success, true);
assert.equal(workerStateProbeGame.resignPlayer(W).success, true);
const workerProbeState = serializeEngineState(workerStateProbeGame);
workerSelf.onmessage({
  data: {
    type: "COMPUTE",
    requestId: "worker-state-probe",
    serializedState: workerProbeState,
    aiPlayer: P,
    depth: 1,
    topN: 2,
  },
});
assert.equal(workerMessages.at(-1).type, "RESULT");
assert.equal(workerMessages.at(-1).requestId, "worker-state-probe");
assert.equal(
  workerMessages.at(-1).moves[0].observedPositionRevision,
  workerProbeState.positionRevision,
);
assert.deepEqual(workerMessages.at(-1).moves[0].observedResignedPlayers, [W]);
assert.equal(workerMessages.at(-1).moves[0].observedAiPlayer, P);
assert.equal(workerMessages.at(-1).moves[0].observedTopN, 2);

const invalidWorkerState = serializeEngineState(new GameEngine({ gridSize: 5 }));
invalidWorkerState.rulesVersion = "territory-invalid";
workerSelf.onmessage({
  data: {
    type: "COMPUTE",
    requestId: "worker-invalid-rule",
    serializedState: invalidWorkerState,
    aiPlayer: B,
  },
});
assert.equal(workerMessages.at(-1).type, "ERROR");
assert.equal(workerMessages.at(-1).requestId, "worker-invalid-rule");
globalThis.self = previousSelf;

assert.equal(DEFAULT_RULES_VERSION, TerritoryRulesVersion.V2);
assert.equal(normalizeGameSettings({}).rulesVersion, TerritoryRulesVersion.V2);
assert.equal(
  normalizeGameSettings({ rulesVersion: TerritoryRulesVersion.V1 }).rulesVersion,
  TerritoryRulesVersion.V1,
);
assert.deepEqual(
  getPrimaryScores({ scores: { [B]: 3 }, displayScores: { [B]: 99 } }),
  { [B]: 3 },
);

const previousLocalStorage = globalThis.localStorage;
globalThis.localStorage = {
  getItem: () => JSON.stringify({ roomId: "1234", settings: { gridSize: 7 } }),
};
assert.equal(loadStoredSession().settings.rulesVersion, TerritoryRulesVersion.V2);
globalThis.localStorage = previousLocalStorage;

const fingerprint = Renderer.prototype._getBoardFingerprint;
const twoPlayerSnapshot = new GameEngine({
  gridSize: 9,
  playerCount: 2,
  rulesVersion: TerritoryRulesVersion.V2,
}).getSnapshot();
const threePlayerSnapshot = new GameEngine({
  gridSize: 9,
  playerCount: 3,
  rulesVersion: TerritoryRulesVersion.V2,
}).getSnapshot();
assert.notEqual(
  fingerprint.call({}, { ...twoPlayerSnapshot, renderEpoch: 1 }),
  fingerprint.call({}, { ...threePlayerSnapshot, renderEpoch: 1 }),
  "same-size 2-player and 3-player boards must not share a render fingerprint",
);
assert.notEqual(
  fingerprint.call({}, { ...twoPlayerSnapshot, renderEpoch: 1 }),
  fingerprint.call({}, { ...twoPlayerSnapshot, renderEpoch: 2 }),
  "engine replacement must invalidate the render fingerprint",
);
const invalidationProbe = { _lastRenderFingerprint: "board", _staticLayerKey: "layout" };
Renderer.prototype.invalidate.call(invalidationProbe);
assert.deepEqual(invalidationProbe, { _lastRenderFingerprint: "", _staticLayerKey: "" });

const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
globalThis.requestAnimationFrame = () => 42;
let hintLayerFrames = 0;
let fullBoardFrames = 0;
const hintAnimationProbe = {
  _animationFrameId: 1,
  hintPoint: [1, 0],
  lastSnapshot: twoPlayerSnapshot,
  _lastHintTimestamp: 0,
  _hintPulsePhase: 0,
  _hintCtx: {},
  _renderHintLayer: () => { hintLayerFrames += 1; },
  _doRender: () => { fullBoardFrames += 1; },
};
Renderer.prototype._renderHintAnimation.call(hintAnimationProbe, 1000);
assert.equal(hintLayerFrames, 1);
assert.equal(fullBoardFrames, 0);
globalThis.requestAnimationFrame = previousRequestAnimationFrame;

let snapshotReads = 0;
let pointerActingPlayer = null;
const pointerSnapshot = { currentPlayer: B };
const pointerProbe = {
  engine: {
    gridSize: 5,
    getSnapshot() {
      snapshotReads += 1;
      return pointerSnapshot;
    },
  },
  _validGridPoints: [[1, 0]],
  renderer: {
    getPointPixelCoordinates: () => ({ x: 10, y: 20 }),
    getHitRadius: () => 5,
  },
  _getInteractionLockReason: () => null,
  _getCanvasRelativePosition: () => ({ x: 10, y: 20 }),
  _findNearestGridPoint: GameController.prototype._findNearestGridPoint,
  _applyMove(point, actingPlayer) {
    pointerActingPlayer = actingPlayer;
    return { success: false, reason: "TEST", point, state: {} };
  },
  _buildGameState: () => ({}),
};
GameController.prototype._processPointer.call(pointerProbe, 10, 20);
assert.equal(snapshotReads, 1, "one pointer action should take one pre-move snapshot");
assert.equal(pointerActingPlayer, B);

let invalidations = 0;
const replacementProbe = {
  options: { engine: { gridSize: 5, playerCount: 2, rulesVersion: TerritoryRulesVersion.V2 } },
  renderer: { invalidate: () => { invalidations += 1; } },
  _engineEpoch: 7,
};
GameController.prototype._replaceEngine.call(replacementProbe, replacementProbe.options.engine);
assert.equal(replacementProbe._engineEpoch, 8);
assert.equal(replacementProbe._validGridPoints.length, 15);
assert.equal(invalidations, 1);

console.log(JSON.stringify({
  legacyContract: {
    degenerateLineArea: 3,
    mirrorAreas: [areas(legacyOriginal), areas(legacyMirrored)],
  },
  territoryV2: {
    degenerateLineArea: 0,
    mirrorAreas: [{ [B]: 10, [W]: 11 }, { [B]: 11, [W]: 10 }],
    d3PermutationsVerified: permutations.length,
    hotPathFixturesVerified: TERRITORY_V2_HOT_PATH_FIXTURES.length,
  },
  pageContract: {
    discreteScorePreferred: true,
    engineReplacementFingerprintVerified: true,
    isolatedHintLayerVerified: true,
    controllerSingleSnapshotVerified: true,
    workerRoundTripVerified: true,
    staleStateFieldsRoundTripped: true,
  },
}, null, 2));
