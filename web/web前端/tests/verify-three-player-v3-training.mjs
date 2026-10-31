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
import { policyProbabilities, ppoLossAndGradient, adamStep } from "../../tools/linear-three-v3-core.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const base = resolve(root, `local_artifacts/three-player-v3-recovery-${Date.now()}`);
const configPath = resolve(base, "fixture-config.json");
await mkdir(base, { recursive: true });
const config = JSON.parse(await readFile(resolve(root, "web/tools/configs/three-player-policy-v3.json"), "utf8"));
config.sizes = [5]; config.starts = ["BLACK"]; config.stages = 2; config.optimizer.updatesPerStage = 2;
config.development.maximumGamePlies = 80; config.development.prefixReplicates = 1;
await writeFile(configPath, JSON.stringify(config));
const script = resolve(root, "web/tools/finetune-three-player-v3.mjs");
function run(directory, { extra = [], killInFlight = false, killAtCandidate = false, killInDevelopment = false } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [script, "--run-root", directory, "--config", configPath, "--max-seconds", "30",
      ...((killInFlight || killInDevelopment) ? ["--checkpoint-events"] : []), ...extra],
      { cwd: root, windowsHide: true });
    let output = "", interrupted = false;
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Posttraining recovery fixture exceeded 30 seconds.")); }, 30000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (!interrupted && ((killAtCandidate && output.includes("CANDIDATE stage=1"))
          || (killInFlight && /CHECKPOINT generation episodes=0 episode_actions=[1-9]/.test(output))
          || (killInDevelopment && /CHECKPOINT development episodes=\d+ episode_actions=0 game_actions=[1-9]/.test(output)))) {
        interrupted = true; child.kill();
      }
    });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const done = () => { clearTimeout(timeout); };
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
const modelPath = resolve(resumedRoot, "three-player-policy-v3.json");
const modelBytes = await readFile(modelPath);
assert.deepEqual(modelBytes, await readFile(resolve(cleanRoot, "three-player-policy-v3.json")));
assert.ok((await readdir(resumedRoot)).some((name) => name.includes(".interrupted-")));
assert.equal(finalCheckpoint.completedEpisodes.length, 16);
assert.equal(finalCheckpoint.optimizer.step, 4);
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

// Numerical differentiation checks the implemented clipped policy objective,
// including its parent KL term; these samples avoid nondifferentiable edges.
const features = [[0.8, -0.4], [-0.2, 0.7], [0.1, 0.2]];
const weights = [0.2, -0.1], options = { clip: 0.2, anchorKl: 0.03, temperature: 0.9 };
const probabilities = policyProbabilities(features, weights, options.temperature);
const samples = [
  { features, action: 0, oldProb: probabilities[0], advantage: 0.6, weight: 0.5, anchor: [0.3, 0.4, 0.3] },
  { features, action: 1, oldProb: probabilities[1], advantage: -0.2, weight: 0.25, anchor: [0.3, 0.4, 0.3] },
];
const objective = ppoLossAndGradient(samples, weights, options);
for (let i = 0; i < weights.length; i++) {
  const plus = [...weights], minus = [...weights]; plus[i] += 1e-5; minus[i] -= 1e-5;
  const derivative = (ppoLossAndGradient(samples, plus, options).loss - ppoLossAndGradient(samples, minus, options).loss) / 2e-5;
  assert.ok(Math.abs(derivative - objective.gradient[i]) < 1e-8, "PPO analytical gradient must match finite differences.");
}
for (const [probability, advantage] of [[0.8, 1], [0.2, -1]]) {
  const result = ppoLossAndGradient([{ features: [[1], [0]], action: 0, oldProb: 0.5, advantage, weight: 1, anchor: [probability, 1 - probability] }],
    [Math.log(probability / (1 - probability))], { clip: 0.2, anchorKl: 0, temperature: 1 });
  assert.ok(Math.abs(result.gradient[0]) < 1e-12, "Clipped improving ratios must have zero policy gradient.");
}
const adam = { step: 0, weights: [...weights], m: [0, 0], v: [0, 0] };
adamStep(adam, objective.gradient, { learningRate: 0.001, beta1: 0.9, beta2: 0.999, epsilon: 1e-8, maximumGradientNorm: 0.5 });
assert.ok(ppoLossAndGradient(samples, adam.weights, options).loss < objective.loss);

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
console.log(JSON.stringify({ status: "PASS", scope: "PPO-finite-difference-and-clipping/generation-optimizer-development-forced-exit/exact-resume/RNG-and-Adam-state/development-game-deduplication/completion-idempotence/PAUSE-STOP-budget/duplicate-exclusion/corruption-and-config-drift/terminal-area",
  completedFixtureEpisodes: 16, completedFixtureUpdates: 4, completedDevelopmentGames: 13, runRoot: base }, null, 2));
