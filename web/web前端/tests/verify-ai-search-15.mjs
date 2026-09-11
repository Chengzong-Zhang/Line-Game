import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { TERRITORY_V2_HOT_PATH_FIXTURES } from "./territory-v2-fixtures.mjs";

const frontendRoot = new URL("../", import.meta.url);

function asDataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

async function readFrontendSource(name) {
  return fs.readFile(new URL(name, frontendRoot), "utf8");
}

const engineUrl = asDataUrl(await readFrontendSource("GameEngine.js"));
const aiSource = await readFrontendSource("AIEngine.js");
const aiModuleSource = aiSource.replace(
  /^import\s+([^;]+)\s+from\s+"\.\/GameEngine\.js(?:\?v=[^"]+)?";/m,
  `import $1 from "${engineUrl}";`,
);
assert.notEqual(aiModuleSource, aiSource, "AIEngine must import GameEngine through a cache-busted URL");

const { GameEngine, TerritoryRulesVersion } = await import(engineUrl);
const { MinimaxAI, saveState } = await import(asDataUrl(aiModuleSource));

const fixture = TERRITORY_V2_HOT_PATH_FIXTURES.find(
  (candidate) => candidate.name === "two-player-15-midgame",
);
assert.ok(fixture, "15×15 regression fixture is required");

const EXPECTED_TOP_MOVES = Object.freeze([
  Object.freeze({ point: Object.freeze([2, 5]), score: 164 }),
  Object.freeze({ point: Object.freeze([4, 3]), score: 156 }),
  Object.freeze({ point: Object.freeze([3, 2]), score: -1502 }),
  Object.freeze({ point: Object.freeze([3, 1]), score: -1605 }),
  Object.freeze({ point: Object.freeze([4, 1]), score: -1605 }),
]);

function pointKey(point) {
  return `${point[0]},${point[1]}`;
}

function createFixtureEngine() {
  const engine = new GameEngine({
    gridSize: fixture.gridSize,
    playerCount: fixture.playerCount,
    rulesVersion: TerritoryRulesVersion.V2,
    deferTerritoryUpdates: true,
  });
  engine._updateTerritories = () => {};

  // Fixture setup is not the thing under test. Avoid constructing 20 UI
  // snapshots while retaining the canonical placement/skip/Superko path.
  engine._isReplayingBatch = true;
  try {
    for (const [index, point] of fixture.moves.entries()) {
      const result = engine.playMove(point);
      assert.equal(
        result.success,
        true,
        `${fixture.name}: setup move ${index + 1} ${pointKey(point)} failed: ${result.reason}`,
      );
    }
  } finally {
    engine._isReplayingBatch = false;
  }
  return engine;
}

const engine = createFixtureEngine();
const aiPlayer = engine.currentPlayer;
const legalKeys = new Set(engine.getLegalMoves(aiPlayer).map((move) => pointKey(move.point)));
const beforeRuleState = saveState(engine);
const beforeReplayState = engine._captureReplayState();
const beforePublicSnapshot = engine.getSnapshot();

let snapshotCalls = 0;
let legalMoveScans = 0;
const originalGetSnapshot = engine.getSnapshot;
const originalGetLegalMoves = engine.getLegalMoves;
engine.getSnapshot = function instrumentedGetSnapshot(...args) {
  snapshotCalls += 1;
  return originalGetSnapshot.apply(this, args);
};
engine.getLegalMoves = function instrumentedGetLegalMoves(...args) {
  legalMoveScans += 1;
  return originalGetLegalMoves.apply(this, args);
};

let moves;
let elapsedMs;
try {
  const started = performance.now();
  moves = new MinimaxAI(2).getTopMoves(engine, aiPlayer, 5);
  elapsedMs = performance.now() - started;
} finally {
  engine.getSnapshot = originalGetSnapshot;
  engine.getLegalMoves = originalGetLegalMoves;
}

assert.deepEqual(moves, EXPECTED_TOP_MOVES, "15×15 depth-2 ranking/score drifted");
for (const move of moves) {
  assert.equal(legalKeys.has(pointKey(move.point)), true, "AI returned an illegal root move");
}
assert.equal(
  snapshotCalls,
  0,
  "speculative AI moves must not build UI snapshots",
);
assert.equal(
  legalMoveScans,
  21,
  "depth-2 20-candidate search must scan legal moves once at root and once per non-leaf branch",
);
assert.equal(engine._isReplayingBatch, false, "AI search leaked the replay flag");
assert.deepEqual(saveState(engine), beforeRuleState, "AI search changed the rule state");
assert.deepEqual(
  engine._captureReplayState(),
  beforeReplayState,
  "AI search changed replay-visible state, including territory revisions",
);
assert.deepEqual(
  engine.getSnapshot(),
  beforePublicSnapshot,
  "AI search changed the public game snapshot",
);

const errorEngine = createFixtureEngine();
const originalOrderMoves = MinimaxAI.prototype.orderMoves;
MinimaxAI.prototype.orderMoves = () => {
  throw new Error("intentional ordering failure");
};
try {
  assert.throws(
    () => new MinimaxAI(2).getTopMoves(errorEngine, errorEngine.currentPlayer, 5),
    /intentional ordering failure/,
  );
} finally {
  MinimaxAI.prototype.orderMoves = originalOrderMoves;
}
assert.equal(
  errorEngine._isReplayingBatch,
  false,
  "failed AI search must restore the replay flag",
);

console.log(JSON.stringify({
  fixture: fixture.name,
  gridSize: fixture.gridSize,
  depth: 2,
  topN: 5,
  elapsedMs: Number(elapsedMs.toFixed(3)),
  legalMoveScans,
  speculativeSnapshotCalls: snapshotCalls,
  moves,
  ruleStatePreserved: true,
  replayStatePreserved: true,
  replayFlagRestoredAfterFailure: true,
}, null, 2));
