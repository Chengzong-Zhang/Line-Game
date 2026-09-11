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

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function rounded(value) {
  return Number(value.toFixed(3));
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
assert.ok(fixture, "15×15 benchmark fixture is required");

function createFixtureEngine() {
  const engine = new GameEngine({
    gridSize: fixture.gridSize,
    playerCount: fixture.playerCount,
    rulesVersion: TerritoryRulesVersion.V2,
    deferTerritoryUpdates: true,
  });
  engine._updateTerritories = () => {};
  engine._isReplayingBatch = true;
  try {
    for (const point of fixture.moves) {
      const result = engine.playMove(point);
      assert.equal(result.success, true, `${fixture.name}: fixture setup failed`);
    }
  } finally {
    engine._isReplayingBatch = false;
  }
  return engine;
}

function instrument(engine, ai) {
  const counters = Object.fromEntries([
    "getLegalMoves",
    "_evaluateMove",
    "_computeStateHash",
    "playMove",
    "getSnapshot",
  ].map((name) => [name, 0]));
  const originals = {};
  for (const name of Object.keys(counters)) {
    originals[name] = engine[name];
    engine[name] = function instrumentedMethod(...args) {
      counters[name] += 1;
      return originals[name].apply(this, args);
    };
  }

  const originalMinimax = ai.minimax;
  ai.minimax = function instrumentedMinimax(...args) {
    counters.minimax = (counters.minimax ?? 0) + 1;
    return originalMinimax.apply(this, args);
  };

  return {
    counters,
    restore() {
      for (const name of Object.keys(originals)) {
        engine[name] = originals[name];
      }
      ai.minimax = originalMinimax;
    },
  };
}

function runSample() {
  const engine = createFixtureEngine();
  const ai = new MinimaxAI(2);
  const before = saveState(engine);
  const instrumentation = instrument(engine, ai);
  let moves;
  let elapsedMs;
  try {
    const started = performance.now();
    moves = ai.getTopMoves(engine, engine.currentPlayer, 5);
    elapsedMs = performance.now() - started;
  } finally {
    instrumentation.restore();
  }

  assert.deepEqual(saveState(engine), before, "benchmark search mutated the source engine");
  assert.equal(engine._isReplayingBatch, false, "benchmark search leaked the replay flag");
  assert.equal(
    instrumentation.counters.getSnapshot,
    0,
    "speculative search must not construct UI snapshots",
  );

  return { elapsedMs, moves, counters: instrumentation.counters };
}

const SAMPLES = 5;
const samples = Array.from({ length: SAMPLES }, runSample);
for (const sample of samples.slice(1)) {
  assert.deepEqual(sample.moves, samples[0].moves, "benchmark search must be deterministic");
}

const counterNames = Object.keys(samples[0].counters);
const operationCounts = Object.fromEntries(counterNames.map((name) => [name, {
  p50: rounded(percentile(samples.map((sample) => sample.counters[name]), 0.5)),
  p95: rounded(percentile(samples.map((sample) => sample.counters[name]), 0.95)),
}]));

console.log(JSON.stringify({
  measurementPolicy: "descriptive-only; no machine-dependent pass threshold",
  scenario: "two-player-15-midgame-depth-2-top-5",
  fixture: fixture.name,
  gridSize: fixture.gridSize,
  playerCount: fixture.playerCount,
  plies: fixture.moves.length,
  samples: SAMPLES,
  latencyMs: {
    p50: rounded(percentile(samples.map((sample) => sample.elapsedMs), 0.5)),
    p95: rounded(percentile(samples.map((sample) => sample.elapsedMs), 0.95)),
  },
  operationCounts,
  moves: samples[0].moves,
  sourceStatePreserved: true,
}, null, 2));
