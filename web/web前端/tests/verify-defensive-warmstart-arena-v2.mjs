import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { GameEngine } from "../GameEngine.js";
import { serializeEngineState } from "../AIStateProtocol.js";
import { defensiveDataMain } from "../../tools/defensive-training-data-v1.mjs";
import { defensiveWarmstartMain, loadWarmstartParent } from "../../tools/train-defensive-warmstart-v2.mjs";
import { arenaPolicyDecision, defensiveArenaMain, loadActualArenaParent, nativeArenaOutcome,
  validateArenaContext } from "../../tools/arena-defensive-warmstart-v2.mjs";
import { atomic, readJson, sealed, unseal, lease } from "../../tools/neural-posttraining-data-v2.mjs";

const testRoot = await mkdtemp(resolve(tmpdir(), "lifeline-warmstart-arena-"));
const data = resolve(testRoot, "data"), input = resolve(testRoot, "input.json"), model = resolve(testRoot, "model");
function trainingState(rulesVersion) {
  const engine = new GameEngine({ playerCount: 2, gridSize: 5, rulesVersion, deferTerritoryUpdates: true });
  engine._isReplayingBatch = true;
  for (const point of [[2, 0], [3, 1], [0, 1], [0, 4]]) assert.equal(engine.playMove(point).success, true);
  return serializeEngineState(engine);
}
await writeFile(input, JSON.stringify([{ id: "train", split: "train", state: trainingState("territory-v3") },
  { id: "validation", split: "validation", state: trainingState("territory-v2") }]));
assert.equal(await defensiveDataMain(["--input", input, "--run-root", data, "--max-new-units", "10",
  "--time-ms-per-label", "5000", "--max-nodes-per-label", "10000"]), 0);
assert.equal(await defensiveWarmstartMain(["--data-root", data, "--run-root", model, "--parent", "easy",
  "--updates", "2", "--max-new-units", "10"]), 0);

// Every parent adapter resolves the same actual product route as the UI.
const routes = [];
for (const [alias, players, size] of [["easy", 3, 5], ["three-v4", 3, 5], ["three-v1", 3, 6], ["hex-v1", 4, 5]]) {
  const parent = await loadWarmstartParent(alias);
  const engine = new GameEngine({ playerCount: players, gridSize: size, rulesVersion: "territory-v3", deferTerritoryUpdates: true });
  const runtime = await loadActualArenaParent(engine, parent);
  assert.equal(runtime.modelInfo.id, alias === "easy" ? "multiplayer-easy-v1" : "multiplayer-medium-v1");
  if (alias !== "easy") assert.equal(runtime.modelInfo.lineage, parent.id);
  routes.push({ alias, players, size, runtime: runtime.modelInfo.id, lineage: parent.id });
}
assert.throws(() => validateArenaContext("three-v4", { playerCount: 3, gridSize: 6, boardShape: "triangle", rulesVersion: "territory-v3" }), /actual product runtime route/);
assert.throws(() => validateArenaContext("hex-v1", { playerCount: 4, gridSize: 5, boardShape: "triangle", rulesVersion: "territory-v3" }), /native multiplayer/);

// Real runtime voluntary PASS ends this isolated legal game naturally. Native
// area, rather than geometric displayArea, decides its terminal result.
const winner = new GameEngine({ playerCount: 3, gridSize: 5, rulesVersion: "territory-v3", deferTerritoryUpdates: true });
winner._isReplayingBatch = true;
assert.equal(winner.playMove([2, 0]).success, true);
assert.equal(winner.skipTurn().success, true); assert.equal(winner.skipTurn().success, true);
assert.equal(winner.currentPlayer, "BLACK"); assert.ok(winner.getLegalMoves().length > 0);
const winningRuntime = await loadActualArenaParent(winner, await loadWarmstartParent("easy"));
const terminalDecision = arenaPolicyDecision(winner, winningRuntime.ai);
assert.equal(terminalDecision.point, null); assert.equal(terminalDecision.voluntaryPass, true);
const outcome = nativeArenaOutcome(winner);
assert.equal(outcome.terminal, true); assert.deepEqual(outcome.leaders, ["BLACK"]); assert.equal(outcome.shares.BLACK, 1);
assert.ok(Object.values(outcome.scores).every(Number.isInteger));

const run = resolve(testRoot, "resumed"), clean = resolve(testRoot, "clean");
const args = ["--candidate", resolve(model, "candidate.json"), "--data-root", data, "--seeds", "tiny-independent-1",
  "--max-game-plies", "1", "--opening-plies", "4", "--max-new-units", "100", "--max-seconds", "30"];
assert.equal(await defensiveArenaMain([...args, "--run-root", run, "--fault-after-ply-checkpoint"]), 79);
const first = unseal(await readJson(resolve(run, "checkpoint.json")));
assert.equal(first.committed_plies, 1); assert.equal(first.active.actions.length, 1); assert.equal(first.completed.length, 0);
assert.equal(await defensiveArenaMain([...args, "--run-root", run, "--fault-after-game-write"]), 79);
const orphanPath = resolve(run, "games/seed-tiny-independent-1-baseline.json"), orphan = await readFile(orphanPath);
assert.equal(await defensiveArenaMain([...args, "--run-root", run]), 0);
assert.deepEqual(await readFile(orphanPath), orphan, "Completed unindexed game receipt was overwritten");
const completed = unseal(await readJson(resolve(run, "checkpoint.json")));
assert.equal(completed.committed_plies, 4, "Resumed completed decisions were repeated");
assert.equal(completed.completed.length, 4, "One shared baseline plus all three candidate seats are required");
assert.equal(await defensiveArenaMain([...args, "--run-root", clean]), 0);
const report = unseal(await readJson(resolve(run, "report.json")));
assert.deepEqual(report, unseal(await readJson(resolve(clean, "report.json"))));
assert.equal(report.truncated_games, 4); assert.equal(report.natural_terminal_games, 0);
assert.equal(report.matched_focal_comparisons, 0); assert.equal(report.mean_win_share_delta, null);
assert.equal(report.training_source_positions_used_as_arena_starts, 0);
assert.equal(report.strength_verified, false); assert.equal(report.runtime_admitted, false);
const cpBytes = await readFile(resolve(run, "checkpoint.json"));
assert.equal(await defensiveArenaMain([...args, "--run-root", run]), 0);
assert.deepEqual(await readFile(resolve(run, "checkpoint.json")), cpBytes);
const paused = resolve(testRoot, "paused"); await mkdir(paused); await writeFile(resolve(paused, "PAUSE"), "fixture");
assert.equal(await defensiveArenaMain([...args, "--run-root", paused]), 75);
assert.equal((await readJson(resolve(paused, "progress.json"))).status, "PAUSED");
const guard = await lease(paused);
try { await assert.rejects(defensiveArenaMain([...args, "--run-root", paused]), { code: "EADDRINUSE" }); }
finally { await new Promise(done => guard.close(done)); }
await atomic(resolve(run, "checkpoint.json"), { ...sealed(completed), integrity: "corrupt" });
await assert.rejects(defensiveArenaMain([...args, "--run-root", run]), /Corrupt evidence integrity/);
console.log(JSON.stringify({ status: "PASS_TINY_ACTUAL_PARENT_ARENA_RECOVERY_ONLY", routes,
  tests: ["actual-runtime-routing", "unsupported-route-rejected", "actual-terminal-winning-PASS", "native-area-terminal",
    "midgame-committed-ply-resume", "game-orphan-adoption", "all-seats-shared-control", "truncations-excluded",
    "completed-idempotent", "pause", "duplicate-worker", "corruption-rejected"], fixtureRoot: testRoot,
  productionArenaPlayed: false, strengthVerified: false, runtimeAdmitted: false }));
