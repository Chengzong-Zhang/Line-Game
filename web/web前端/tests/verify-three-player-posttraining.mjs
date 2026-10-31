import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, stat, readdir, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { saveState, restoreState } from "../AIEngine.js";
import { serializeEngineState } from "../AIStateProtocol.js";
import { engineFromActions, maxNTeacher, policyMoves, terminalOutcome, utilityVector } from "../../tools/three-player-posttraining-core.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const base = resolve(root, `local_artifacts/three-player-posttraining-recovery-${Date.now()}`);
const configPath = resolve(base, "fixture-config.json");
await mkdir(base, { recursive: true });
const config = JSON.parse(await readFile(resolve(root, "web/tools/configs/three-player-policy-v2.json"), "utf8"));
config.sizes = [5]; config.starts = ["BLACK"]; config.trainingReplicates = 1; config.validationReplicates = 1;
config.maximumEpisodePlies = 8; config.optimizer.epochs = 3; config.candidateEpochs = [1, 3];
config.development.maximumGamePlies = 80;
await writeFile(configPath, JSON.stringify(config));
const script = resolve(root, "web/tools/finetune-three-player-ai.mjs");
function run(directory, { extra = [], killInFlight = false, killAtCandidate = false, killInDevelopment = false } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [script, "--run-root", directory, "--config", configPath, "--max-seconds", "30", ...extra],
      { cwd: root, windowsHide: true });
    let output = "", interrupted = false;
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Posttraining recovery fixture exceeded 30 seconds.")); }, 30000);
    const timer = killInFlight || killInDevelopment ? setInterval(async () => {
      try {
        const cp = JSON.parse(await readFile(resolve(directory, "checkpoint.json"), "utf8"));
        if (!interrupted && ((killInFlight && cp.currentEpisode?.actions.length >= 1 && cp.completedEpisodes.length === 0)
            || (killInDevelopment && cp.currentDevelopmentGame?.actions.length >= 1))) {
          interrupted = true; child.kill();
        }
      } catch (_) { /* Atomic checkpoint not committed yet. */ }
    }, 5) : null;
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (!interrupted && killAtCandidate && output.includes("CANDIDATE epoch=1")) { interrupted = true; child.kill(); }
    });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const done = () => { clearTimeout(timeout); if (timer) clearInterval(timer); };
    child.once("error", (error) => { done(); reject(error); });
    child.once("close", (code) => { done(); accept({ code, output, interrupted }); });
  });
}
const resumedRoot = resolve(base, "resumed"), cleanRoot = resolve(base, "clean");
const interrupted = await run(resumedRoot, { killInFlight: true });
assert.equal(interrupted.interrupted, true, `Must kill a real worker during an in-flight game: ${interrupted.output}`);
const interruptedCheckpoint = JSON.parse(await readFile(resolve(resumedRoot, "checkpoint.json"), "utf8"));
assert.equal(interruptedCheckpoint.completedEpisodes.length, 0);
assert.ok(interruptedCheckpoint.currentEpisode.actions.length > 0);
await writeFile(resolve(resumedRoot, "checkpoint.json.tmp"), '{"partial":');
const interruptedOptimizer = await run(resumedRoot, { killAtCandidate: true });
assert.equal(interruptedOptimizer.interrupted, true, interruptedOptimizer.output);
const interruptedDevelopment = await run(resumedRoot, { killInDevelopment: true });
assert.equal(interruptedDevelopment.interrupted, true, interruptedDevelopment.output);
const resumed = await run(resumedRoot);
assert.equal(resumed.code, 0, resumed.output);
const clean = await run(cleanRoot);
assert.equal(clean.code, 0, clean.output);
const finalCheckpoint = JSON.parse(await readFile(resolve(resumedRoot, "checkpoint.json"), "utf8"));
const cleanCheckpoint = JSON.parse(await readFile(resolve(cleanRoot, "checkpoint.json"), "utf8"));
assert.deepEqual(finalCheckpoint, cleanCheckpoint, "Actions, RNG, samples, Adam state, candidates and development results must resume exactly.");
const modelPath = resolve(resumedRoot, "three-player-policy-v2.json");
const modelBytes = await readFile(modelPath);
assert.deepEqual(modelBytes, await readFile(resolve(cleanRoot, "three-player-policy-v2.json")));
assert.ok((await readdir(resumedRoot)).some((name) => name.includes(".interrupted-")));
assert.equal(finalCheckpoint.completedEpisodes.length, 2);
assert.equal(finalCheckpoint.optimizer.epoch, 3);
assert.equal(finalCheckpoint.developmentResults.length, 13);
const episodeStats = await Promise.all(finalCheckpoint.completedEpisodes.map((entry) => stat(resolve(resumedRoot, "episodes", `${entry.id}.json`))));
const repeat = await run(resumedRoot);
assert.equal(repeat.code, 0, repeat.output);
assert.deepEqual(await readFile(modelPath), modelBytes);
const repeatedStats = await Promise.all(finalCheckpoint.completedEpisodes.map((entry) => stat(resolve(resumedRoot, "episodes", `${entry.id}.json`))));
assert.deepEqual(repeatedStats.map((x) => x.mtimeMs), episodeStats.map((x) => x.mtimeMs), "Completed units must not be regenerated.");

const controlsRoot = resolve(base, "controls");
await mkdir(controlsRoot);
for (const control of ["PAUSE", "STOP"]) {
  await writeFile(resolve(controlsRoot, control), "fixture");
  const result = await run(controlsRoot);
  assert.equal(result.code, 75, result.output);
  assert.equal(JSON.parse(await readFile(resolve(controlsRoot, "progress.json"), "utf8")).status, control === "PAUSE" ? "PAUSED" : "STOPPED");
  await unlink(resolve(controlsRoot, control));
}
const budget = await run(controlsRoot, { extra: ["--max-new-units", "0"] });
assert.equal(budget.code, 75);
assert.equal(JSON.parse(await readFile(resolve(controlsRoot, "progress.json"), "utf8")).status, "YIELDED");
const leasePort = 40000 + (parseInt(createHash("sha256").update(controlsRoot.toLowerCase()).digest("hex").slice(0, 8), 16) % 20000);
const lease = createServer();
await new Promise((accept, reject) => { lease.once("error", reject); lease.listen({ host: "127.0.0.1", port: leasePort, exclusive: true }, accept); });
const progressBefore = await readFile(resolve(controlsRoot, "progress.json"));
try {
  const duplicate = await run(controlsRoot);
  assert.equal(duplicate.code, 78);
  assert.deepEqual(await readFile(resolve(controlsRoot, "progress.json")), progressBefore);
} finally { await new Promise((accept) => lease.close(accept)); }
await writeFile(configPath, JSON.stringify({ ...config, optimizer: { ...config.optimizer, learningRate: 0.031 } }));
assert.equal((await run(resumedRoot)).code, 78, "Config drift must stop, not retry.");
await writeFile(configPath, JSON.stringify(config));
await writeFile(resolve(resumedRoot, "checkpoint.json"), JSON.stringify({ ...finalCheckpoint, stage: "corrupted" }));
assert.equal((await run(resumedRoot)).code, 78, "Even completed checkpoints must reject corruption.");

// MaxN uses every root legal action and preserves actual history/turn state.
const engine = engineFromActions({ size: 5, start: "PURPLE" });
const before = JSON.stringify(serializeEngineState(engine));
const teacher = maxNTeacher(engine, { depth: 3, replyWidth: 99 });
assert.equal(teacher.moves.length, engine.getLegalMoves(engine.currentPlayer).length);
assert.ok(teacher.moves.every((move) => move.vector.length === 3 && move.vector.every(Number.isFinite)
  && move.score === move.vector[2]));
assert.equal(JSON.stringify(serializeEngineState(engine)), before);
const saved = saveState(engine), originalPlayMove = engine.playMove;
engine.playMove = () => { engine.turnCount++; throw new Error("injected teacher failure"); };
assert.throws(() => maxNTeacher(engine), /injected teacher failure/);
engine.playMove = originalPlayMove;
assert.deepEqual(saveState(engine), saved);
const parent = JSON.parse(await readFile(resolve(root, "web/web前端/assets/research-ai/three-player-policy-v1.json"), "utf8"));
while (!engine.gameOver) {
  const move = policyMoves(engine, parent.weights)[0];
  if (move) engine.playMove(move.point); else engine.skipTurn();
}
const outcome = terminalOutcome(engine);
assert.ok(Math.abs(Object.values(outcome.shares).reduce((a, b) => a + b, 0) - 1) < 1e-12);
const values = utilityVector(engine);
for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
  if (outcome.shares[["BLACK", "WHITE", "PURPLE"][i]] > outcome.shares[["BLACK", "WHITE", "PURPLE"][j]]) assert.ok(values[i] > values[j]);
}
console.log(JSON.stringify({ status: "PASS", scope: "generation-optimizer-development-forced-exit/exact-resume/RNG-and-Adam-state/development-game-deduplication/completion-idempotence/PAUSE-STOP-budget/duplicate-exclusion/corruption-and-config-drift/MaxN-history-and-terminal-area",
  completedFixtureEpisodes: 2, completedFixtureEpochs: 3, completedDevelopmentGames: 13, runRoot: base }, null, 2));
