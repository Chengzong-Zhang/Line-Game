// Bounded, resumable CPU imitation training. Raw samples stay local.
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rename, unlink, access } from "node:fs/promises";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GameEngine, PLAYER_ORDER } from "../web前端/GameEngine.js";
import { MinimaxAI, fastTerritoryBFS, restoreState, saveState } from "../web前端/AIEngine.js";
import { HEX_PLAYER_FEATURES, HEX_PLAYER_MODEL_ID, hexPlayerCandidates } from "../web前端/HexPlayerAI.js";
import { rejectRetiredTrainingEntry } from "./training-policy-v1.mjs";

rejectRetiredTrainingEntry("train-hex-player-ai-v1");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const script = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
const profile = option("--profile", "release");
if (!["release", "calibration", "recovery"].includes(profile)) throw new Error("Unknown training profile.");
const runRoot = resolve(root, option("--run-root", "local_artifacts/hex-player-ai-v1"));
const defaultOutput = profile === "release"
  ? "web/web前端/assets/research-ai/hex-player-policy-v1.json"
  : resolve(runRoot, "model.json");
const output = resolve(root, option("--output", defaultOutput));
const maxSeconds = Number(option("--max-seconds", "120"));
const maxNewGames = Number(option("--max-new-games", "100"));
if (!Number.isFinite(maxSeconds) || maxSeconds <= 0 || maxSeconds > 600
  || !Number.isInteger(maxNewGames) || maxNewGames < 0 || maxNewGames > 100) throw new Error("Invalid bounded run budget.");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const protocol = {
  version: 1, profile, seed: 20261021, rulesVersion: "territory-v2",
  sizes: profile === "release" ? [5, 7, 9] : [5],
  dualEpisodes: profile === "release" ? 6 : 2,
  trainEpisodesPerCount: profile === "release" ? 6 : 1,
  heldoutEpisodesPerCount: profile === "release" ? 2 : 1,
  maxPlies: profile === "release" ? 8 : 4,
  pretrainEpochs: profile === "release" ? 80 : 8,
  finetuneEpochs: profile === "release" ? 140 : 12,
  learningRate: 0.25, l2: 0.0001, teacherTemperature: 24,
  dualTeacher: "existing MinimaxAI depth=1, up to20 candidates",
  hexTeacher: "own-relative one-step coverage/reach utility with next-seat greedy reply; top4 candidates",
  candidateDistribution: "all legal moves; teacher top4 (dual top20) soft targets, all unselected legal moves receive zero target; training and heldout normalize over the full legal action set",
  splitUnit: "whole generation episode, disjoint deterministic seed IDs",
  evidenceTier: "application-pilot; imitation evaluation, not a win-rate or strength claim",
};
const sourcePaths = [
  "web/tools/train-hex-player-ai.mjs", "web/web前端/HexPlayerAI.js",
  "web/web前端/GameEngine.js", "web/web前端/AIEngine.js",
];
const sources = Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => [path, sha(await readFile(resolve(root, path)))])));
const identity = sha(JSON.stringify({ protocol, sources }));
const integrity = (value) => { const body = { ...value }; delete body.integrity; return sha(JSON.stringify(body)); };
const atomic = async (path, value) => {
  const body = { ...value, integrity: integrity(value) };
  await writeFile(`${path}.tmp`, JSON.stringify(body));
  await rename(`${path}.tmp`, path);
};
const exists = async (path) => { try { await access(path); return true; } catch { return false; } };
await mkdir(runRoot, { recursive: true });
const control = async () => {
  for (const name of ["STOP", "PAUSE"]) {
    if (await exists(resolve(runRoot, name))) return name;
  }
  return null;
};

// This supervisor is a separately launched Node process (hidden on Windows),
// independent of the invoking terminal. It retries only unexpected exits and
// never retries identity/corruption, duplicate lease, STOP/PAUSE or budget exits.
if (args.includes("--supervise")) {
  const started = Date.now();
  const attempts = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const stopped = await control();
    if (stopped) {
      await atomic(resolve(runRoot, "supervisor.json"), { identity, status: stopped, attempts });
      process.exit(75);
    }
    const workerArgs = args.filter((value) => value !== "--supervise");
    const exitCode = await new Promise((accept, reject) => {
      const child = spawn(process.execPath, [script, ...workerArgs], { stdio: "inherit", windowsHide: true });
      child.once("error", reject);
      child.once("exit", (code, signal) => accept(code ?? (signal ? 77 : 1)));
    });
    let progress = 0;
    try { progress = JSON.parse(await readFile(resolve(runRoot, "checkpoint.json"), "utf8")).completedGames.length; } catch {}
    attempts.push({ attempt: attempt + 1, exitCode, completedEpisodes: progress, elapsedSeconds: (Date.now() - started) / 1000 });
    const done = [0, 73, 75, 78].includes(exitCode);
    await atomic(resolve(runRoot, "supervisor.json"), {
      identity, status: exitCode === 0 ? "COMPLETE" : done ? "STOPPED" : "RECOVERING", attempts,
    });
    if (done) process.exit(exitCode);
    if ((Date.now() - started) / 1000 >= maxSeconds
      || (attempts.length >= 3 && attempts.slice(-3).every((item) => item.completedEpisodes === progress))) break;
  }
  await atomic(resolve(runRoot, "supervisor.json"), { identity, status: "RETRY-LIMIT", attempts });
  process.exit(77);
}

const lease = createServer((socket) => socket.destroy());
const leasePort = 40000 + (parseInt(sha(runRoot.toLowerCase()).slice(0, 8), 16) % 20000);
try {
  await new Promise((accept, reject) => {
    lease.once("error", reject);
    lease.listen({ host: "127.0.0.1", port: leasePort, exclusive: true }, accept);
  });
} catch (error) {
  console.error(`DUPLICATE-OR-LEASE-CONFLICT: ${error.code}`);
  process.exit(73);
}
lease.unref();
const lockPath = resolve(runRoot, "run.lock");
const checkpointPath = resolve(runRoot, "checkpoint.json");
await writeFile(lockPath, JSON.stringify({ pid: process.pid, identity, runRoot, leasePort }));
const started = Date.now();
let checkpoint = { identity, protocol, sources, completedGames: [], episodeSummaries: [], samples: [], phase: "pretrain", epoch: 0, weights: Array(16).fill(0), trained: false };
const randomGenerator = (seed) => {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
};
function probabilities(scores, temperature = 1) {
  const maximum = Math.max(...scores);
  const values = scores.map((score) => Math.exp((score - maximum) / temperature));
  const sum = values.reduce((total, value) => total + value, 0);
  return values.map((value) => value / sum);
}
function utility(engine, player) {
  const value = (p) => 25 * engine._getPlayerNodes(p).length
    + 8 * engine._getPlayerLines(p).length + 20 * fastTerritoryBFS(engine, p);
  return value(player) - Math.max(0, ...engine.activePlayers.filter((p) => p !== player && !engine.resignedPlayers.has(p)).map(value));
}
function hexTeacher(engine, depth = 2) {
  const state = saveState(engine);
  const flag = engine._isReplayingBatch;
  engine._isReplayingBatch = true;
  const player = engine.currentPlayer;
  try {
    const ranked = [];
    for (const move of engine.getLegalMoves()) {
      restoreState(engine, state);
      if (engine.playMove(move.point).success) ranked.push({ point: move.point, score: utility(engine, player) });
    }
    ranked.sort((a, b) => b.score - a.score);
    const selected = ranked.slice(0, 4);
    if (depth > 1) for (const candidate of selected) {
      restoreState(engine, state);
      engine.playMove(candidate.point);
      if (!engine.gameOver) {
        const reply = hexTeacher(engine, 1)[0];
        if (reply) engine.playMove(reply.point);
      }
      candidate.score = utility(engine, player);
    }
    return selected.sort((a, b) => b.score - a.score);
  } finally {
    restoreState(engine, state);
    engine._isReplayingBatch = flag;
  }
}
const dot = (features, weights) => features.reduce((sum, value, index) => sum + value * weights[index], 0);
function evaluation(samples, weights) {
  let crossEntropy = 0;
  let agreements = 0;
  for (const sample of samples) {
    const predictions = probabilities(sample.features.map((features) => dot(features, weights)));
    crossEntropy -= sample.targets.reduce((sum, target, index) => sum + target * Math.log(Math.max(1e-12, predictions[index])), 0);
    const predicted = predictions.indexOf(Math.max(...predictions));
    const teacherMaximum = Math.max(...sample.targets);
    agreements += Number(Math.abs(sample.targets[predicted] - teacherMaximum) < 1e-12);
  }
  return { samples: samples.length, cross_entropy: crossEntropy / Math.max(1, samples.length),
    teacher_top_choice_agreement: agreements / Math.max(1, samples.length) };
}
let paused = null;
async function boundary() {
  paused = await control() ?? ((Date.now() - started) / 1000 >= maxSeconds ? "BUDGET" : null);
  return paused;
}
try {
  try {
    checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    if (checkpoint.identity !== identity || checkpoint.integrity !== integrity(checkpoint)
      || !Array.isArray(checkpoint.completedGames) || !Array.isArray(checkpoint.samples)
      || new Set(checkpoint.completedGames).size !== checkpoint.completedGames.length) {
      throw new Error("Corrupt checkpoint or source/protocol mismatch; refusing resume.");
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (await exists(`${checkpointPath}.tmp`)) {
    await rename(`${checkpointPath}.tmp`, `${checkpointPath}.interrupted-${Date.now()}.json`);
  }
  if (args.includes("--fail-before-progress")) process.exit(77);
  const hold = Number(option("--hold-ms", "0"));
  if (hold > 0 && hold <= 10000) await new Promise((accept) => setTimeout(accept, hold));
  await boundary();
  const episodes = [];
  for (let index = 0; index < protocol.dualEpisodes; index += 1) {
    episodes.push({ id: `dual-${index}`, players: 2, size: protocol.sizes[index % protocol.sizes.length], heldout: false, seed: protocol.seed + index });
  }
  for (const players of [4, 5, 6]) {
    for (let index = 0; index < protocol.trainEpisodesPerCount + protocol.heldoutEpisodesPerCount; index += 1) {
      const heldout = index >= protocol.trainEpisodesPerCount;
      episodes.push({ id: `hex-${players}-${index}`, players, size: protocol.sizes[index % protocol.sizes.length],
        heldout, seed: protocol.seed + players * 100 + index });
    }
  }
  let newGames = 0;
  for (const episode of episodes) {
    if (checkpoint.completedGames.includes(episode.id)) continue;
    if (paused) break;
    if (await boundary() || newGames >= maxNewGames) { paused ??= "UNIT-LIMIT"; break; }
    const engine = new GameEngine({ gridSize: episode.size, playerCount: episode.players,
      rulesVersion: protocol.rulesVersion, startPlayer: PLAYER_ORDER[episode.seed % episode.players] });
    engine._isReplayingBatch = true;
    const random = randomGenerator(episode.seed);
    const samples = [];
    let ply = 0;
    for (; ply < protocol.maxPlies && !engine.gameOver; ply += 1) {
      const legal = engine.getLegalMoves();
      if (!legal.length) { engine.skipTurn(); continue; }
      const candidates = hexPlayerCandidates(engine);
      const teacher = episode.players === 2
        ? new MinimaxAI(1).getTopMoves(engine, engine.currentPlayer, 20)
        : hexTeacher(engine);
      const teacherProbabilities = probabilities(teacher.map((move) => move.score), protocol.teacherTemperature);
      const targetByPoint = new Map(teacher.map((move, index) => [move.point.join(","), teacherProbabilities[index]]));
      if (candidates.length > 1) samples.push({
        episode: episode.id, players: episode.players, size: episode.size, heldout: episode.heldout, ply,
        features: candidates.map((candidate) => candidate.features),
        targets: candidates.map((candidate) => targetByPoint.get(candidate.point.join(",")) ?? 0),
      });
      const point = random() < 0.35 ? legal[Math.floor(random() * legal.length)].point : teacher[0]?.point ?? legal[0].point;
      if (!engine.playMove(point).success) throw new Error(`Illegal teacher transition in ${episode.id}.`);
    }
    checkpoint.samples.push(...samples);
    checkpoint.completedGames.push(episode.id);
    checkpoint.episodeSummaries.push({ ...episode, plies: ply, terminal: engine.gameOver, samples: samples.length });
    await atomic(checkpointPath, checkpoint);
    newGames += 1;
    console.log(`${episode.id}: ${checkpoint.completedGames.length}/${episodes.length}, ${samples.length} samples`);
    const crashAfter = Number(option("--crash-after-games", "-1"));
    if (checkpoint.completedGames.length === crashAfter && !await exists(resolve(runRoot, "fault-injected"))) {
      await writeFile(resolve(runRoot, "fault-injected"), "one-shot controlled unexpected worker exit\n");
      process.exit(77);
    }
  }
  if (checkpoint.completedGames.length === episodes.length && !paused) {
    const dual = checkpoint.samples.filter((sample) => sample.players === 2);
    const hex = checkpoint.samples.filter((sample) => sample.players >= 4 && !sample.heldout);
    const heldout = checkpoint.samples.filter((sample) => sample.heldout);
    for (const [phase, dataset, epochs] of [
      ["pretrain", dual, protocol.pretrainEpochs], ["finetune", hex, protocol.finetuneEpochs],
    ]) {
      if (phase === "pretrain" && checkpoint.phase === "finetune") continue;
      if (checkpoint.phase !== phase) { checkpoint.phase = phase; checkpoint.epoch = 0; }
      for (; checkpoint.epoch < epochs; checkpoint.epoch += 1) {
        if (await boundary()) break;
        const gradient = Array(16).fill(0);
        for (const sample of dataset) {
          const predicted = probabilities(sample.features.map((features) => dot(features, checkpoint.weights)));
          sample.features.forEach((features, index) => features.forEach((value, feature) => {
            gradient[feature] += (predicted[index] - sample.targets[index]) * value;
          }));
        }
        checkpoint.weights = checkpoint.weights.map((weight, index) =>
          weight - protocol.learningRate * (gradient[index] / dataset.length + protocol.l2 * weight));
        // Store the next epoch, so a restored checkpoint never repeats an update.
        await atomic(checkpointPath, { ...checkpoint, epoch: checkpoint.epoch + 1 });
        if (phase === "finetune" && checkpoint.epoch + 1 === Number(option("--crash-after-epoch", "-1"))
          && !await exists(resolve(runRoot, "epoch-fault-injected"))) {
          await writeFile(resolve(runRoot, "epoch-fault-injected"), "one-shot exit after committed epoch\n");
          process.exit(77);
        }
      }
      if (paused) break;
    }
    if (!paused) {
      const training = {
        two_player_samples: dual.length, hex_samples_by_count: Object.fromEntries([4, 5, 6].map((count) => [count, hex.filter((sample) => sample.players === count).length])),
        heldout_samples_by_count: Object.fromEntries([4, 5, 6].map((count) => [count, heldout.filter((sample) => sample.players === count).length])),
        trained_board_sizes: protocol.sizes, completed_generation_episodes: episodes.length,
        terminal_episodes: checkpoint.episodeSummaries.filter((episode) => episode.terminal).length,
        truncated_episodes: checkpoint.episodeSummaries.filter((episode) => !episode.terminal).length,
        source_hashes: sources, protocol_sha256: sha(JSON.stringify(protocol)),
        initial_heldout: evaluation(heldout, Array(16).fill(0)),
        final_heldout: evaluation(heldout, checkpoint.weights),
        heldout_by_player_count: Object.fromEntries([4, 5, 6].map((count) => [
          count, evaluation(heldout.filter((sample) => sample.players === count), checkpoint.weights),
        ])),
        final_training: evaluation(hex, checkpoint.weights), evidence_tier: protocol.evidenceTier,
        evaluation_action_set: "full legal action set; same normalization as deployed policy",
        target_distribution: "soft distribution on teacher-selected top4 actions (dual pretrain top20), zero elsewhere",
      };
      const model = {
        schema: { name: "lifeline-hex-player-policy", version: 1 }, id: HEX_PLAYER_MODEL_ID,
        rules_version: protocol.rulesVersion, features: HEX_PLAYER_FEATURES, weights: checkpoint.weights,
        temperature: 1, browser_inference: { player_counts: [4, 5, 6], board_size_range: [5, 15] }, training,
      };
      model.integrity = { algorithm: "SHA-256", payload_sha256: sha(JSON.stringify(model)) };
      await mkdir(dirname(output), { recursive: true });
      const serialized = `${JSON.stringify(model, null, 2)}\n`;
      await writeFile(`${output}.tmp`, serialized);
      await rename(`${output}.tmp`, output);
      const receipt = {
        status: "TRAINING-COMPLETE", model: HEX_PLAYER_MODEL_ID, model_sha256: sha(serialized),
        identity, protocol, training, elapsed_seconds_this_invocation: (Date.now() - started) / 1000,
        resume: "Repeat same command/run-root. Source/config drift and corrupt checkpoints fail closed.",
        stop: "Create STOP or PAUSE in run-root; observed at each episode/epoch boundary. Remove explicitly before resuming.",
        limitation: "Short truncated trajectory imitation pilot, no game-strength claim. Sizes10–15 are inference compatibility, not trained-size evidence.",
      };
      checkpoint.trained = true;
      await atomic(checkpointPath, checkpoint);
      receipt.checkpoint_sha256 = sha(await readFile(checkpointPath));
      await writeFile(output.replace(/\.json$/, ".training-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
      console.log(JSON.stringify({ status: receipt.status, episodes: episodes.length,
        heldout: training.final_heldout, seconds: receipt.elapsed_seconds_this_invocation, model_sha256: receipt.model_sha256 }));
    }
  }
  if (paused || checkpoint.completedGames.length < episodes.length) {
    await atomic(resolve(runRoot, "status.json"), { identity, status: paused ?? "PAUSED", completedEpisodes: checkpoint.completedGames.length });
    process.exitCode = 75;
    console.log(`PAUSED: ${paused}, ${checkpoint.completedGames.length}/${episodes.length}; resume same command.`);
  }
} catch (error) {
  console.error(error.stack);
  process.exitCode = 78;
} finally {
  await unlink(lockPath).catch(() => {});
  await new Promise((accept) => lease.close(accept));
}
