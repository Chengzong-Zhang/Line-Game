// Bounded CPU behavior cloning: existing two-player Minimax -> three-player MaxN.
// Raw examples/checkpoints remain in local_artifacts; only model + receipt ship.
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GameEngine } from "../web前端/GameEngine.js";
import { MinimaxAI, fastTerritoryBFS, restoreState, saveState } from "../web前端/AIEngine.js";
import { THREE_PLAYER_FEATURES, THREE_PLAYER_MODEL_ID, threePlayerCandidates } from "../web前端/ThreePlayerAI.js";
import { rejectRetiredTrainingEntry } from "./training-policy-v1.mjs";

rejectRetiredTrainingEntry("train-three-player-ai-v1");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const runRoot = resolve(root, option("--run-root", "local_artifacts/three-player-ai-v1"));
const output = resolve(root, option("--output", "web/web前端/assets/research-ai/three-player-policy-v1.json"));
const maximumSeconds = Number(option("--max-seconds", "240"));
const maxNewGames = Number(option("--max-new-games", "100"));
if (!Number.isFinite(maximumSeconds) || maximumSeconds <= 0 || maximumSeconds > 600
    || !Number.isInteger(maxNewGames) || maxNewGames < 0 || maxNewGames > 100) {
  throw new Error("Use --max-seconds 1..600 and --max-new-games 0..100 for this bounded bootstrap.");
}
const protocol = Object.freeze({
  version: 1, seed: 20261020, rulesVersion: "territory-v2",
  sizes: [5, 7, 9], dualGames: 12, tripleGames: 24, maxPlies: 18,
  dualTeacher: "existing MinimaxAI depth=2 (maximum 20 candidates)",
  tripleTeacher: "MaxN depth=2; each player maximizes own utility; top 8 heuristic candidates",
  teacherTemperature: 30, pretrainEpochs: 100, finetuneEpochs: 180, learningRate: 0.15,
  evidenceTier: "application-bootstrap; not a strength benchmark or formal research result",
});
const sha = (data) => createHash("sha256").update(data).digest("hex");
const sourcePaths = ["web/tools/train-three-player-ai.mjs", "web/web前端/ThreePlayerAI.js", "web/web前端/AIEngine.js", "web/web前端/GameEngine.js"];
const sources = Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => [path, sha(await readFile(resolve(root, path)))])));
const identity = sha(JSON.stringify({ protocol, sources }));
await mkdir(runRoot, { recursive: true });
const integrity = (value) => { const body = { ...value }; delete body.integrity; return sha(JSON.stringify(body)); };
const atomic = async (path, value) => {
  value.integrity = integrity(value);
  await writeFile(`${path}.tmp`, JSON.stringify(value));
  await rename(`${path}.tmp`, path);
};
const checkpointPath = resolve(runRoot, "checkpoint.json");
// A loopback lease is released by the OS even after a forced process exit.
// The deterministic port is local-only; collisions fail closed. The lock file
// is an informational receipt, never a stale lock requiring unsafe deletion.
const lease = createServer((socket) => socket.destroy());
const leasePort = 40000 + (parseInt(sha(runRoot.toLowerCase()).slice(0, 8), 16) % 20000);
await new Promise((accept, reject) => {
  lease.once("error", reject);
  lease.listen({ host: "127.0.0.1", port: leasePort, exclusive: true }, accept);
});
lease.unref();
const lockPath = resolve(runRoot, "run.lock");
await writeFile(lockPath, JSON.stringify({ pid: process.pid, identity, leasePort }));
let checkpoint = { identity, protocol, sources, completedGames: [], episodeSummaries: [], samples: [], trained: false };
const started = Date.now();

function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}
function utility(engine, player) {
  if (engine.resignedPlayers.has(player)) return -10000;
  const own = (p) => 25 * engine._getPlayerNodes(p).length
    + 8 * engine._getPlayerLines(p).length + 20 * fastTerritoryBFS(engine, p);
  const rivals = engine.activePlayers.filter((p) => p !== player && !engine.resignedPlayers.has(p));
  return own(player) - Math.max(0, ...rivals.map(own));
}
function tripleTeacher(engine, depth = 2) {
  const snapshot = saveState(engine), flag = engine._isReplayingBatch;
  engine._isReplayingBatch = true;
  const player = engine.currentPlayer;
  try {
    const candidates = [];
    for (const move of engine.getLegalMoves(player)) {
      restoreState(engine, snapshot);
      if (engine.playMove(move.point).success) candidates.push({ point: move.point, score: utility(engine, player) });
    }
    candidates.sort((a, b) => b.score - a.score);
    const ranked = candidates.slice(0, 8);
    for (const candidate of ranked) {
      restoreState(engine, snapshot);
      engine.playMove(candidate.point);
      if (depth > 1 && !engine.gameOver) {
        const response = tripleTeacher(engine, depth - 1)[0];
        if (response) engine.playMove(response.point);
      }
      candidate.score = utility(engine, player);
    }
    return ranked.sort((a, b) => b.score - a.score);
  } finally { restoreState(engine, snapshot); engine._isReplayingBatch = flag; }
}
function probabilities(scores, temperature = 1) {
  const maximum = Math.max(...scores);
  const values = scores.map((score) => Math.exp((score - maximum) / temperature));
  const total = values.reduce((sum, value) => sum + value, 0);
  return values.map((value) => value / total);
}
function loss(samples, weights) {
  let total = 0;
  for (const sample of samples) {
    const probs = probabilities(sample.features.map((features) => features.reduce((sum, x, i) => sum + x * weights[i], 0)));
    total -= sample.targets.reduce((sum, target, i) => sum + target * Math.log(Math.max(1e-12, probs[i])), 0);
  }
  return total / Math.max(1, samples.length);
}

try {
  try {
    checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    if (checkpoint.identity !== identity) throw new Error("Checkpoint source/protocol mismatch; use a new run directory.");
    if (checkpoint.integrity !== integrity(checkpoint)
        || !Array.isArray(checkpoint.completedGames) || !Array.isArray(checkpoint.samples)
        || new Set(checkpoint.completedGames).size !== checkpoint.completedGames.length) {
      throw new Error("Corrupt training checkpoint; refusing to resume.");
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  try { await rename(`${checkpointPath}.tmp`, `${checkpointPath}.interrupted-${Date.now()}.json`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const games = Array.from({ length: protocol.dualGames + protocol.tripleGames }, (_, index) => ({
    id: index, players: index < protocol.dualGames ? 2 : 3,
    size: protocol.sizes[index % protocol.sizes.length],
  }));
  let newGames = 0;
  for (const game of games) {
    if (checkpoint.completedGames.includes(game.id)) continue;
    if ((Date.now() - started) / 1000 >= maximumSeconds || newGames >= maxNewGames) break;
    const engine = new GameEngine({ gridSize: game.size, playerCount: game.players, rulesVersion: protocol.rulesVersion,
      startPlayer: ["BLACK", "WHITE", "PURPLE"][game.id % game.players] });
    engine._isReplayingBatch = true;
    const random = randomGenerator(protocol.seed + game.id);
    const examples = [];
    let ply = 0;
    for (; ply < protocol.maxPlies && !engine.gameOver; ply++) {
      const legal = engine.getLegalMoves(engine.currentPlayer);
      if (!legal.length) { engine.skipTurn(); continue; }
      const all = threePlayerCandidates(engine);
      const teacher = game.players === 2
        ? new MinimaxAI(2).getTopMoves(engine, engine.currentPlayer, 20)
        : tripleTeacher(engine);
      const teacherByPoint = new Map(teacher.map((move) => [move.point.join(","), move.score]));
      const candidates = all.filter((candidate) => teacherByPoint.has(candidate.point.join(",")));
      if (candidates.length > 1) examples.push({
        game: game.id, players: game.players, size: game.size, ply,
        features: candidates.map((candidate) => candidate.features),
        targets: probabilities(candidates.map((candidate) => teacherByPoint.get(candidate.point.join(","))), protocol.teacherTemperature),
      });
      const move = random() < 0.3 ? legal[Math.floor(random() * legal.length)].point : teacher[0]?.point ?? legal[0].point;
      if (!engine.playMove(move).success) throw new Error(`Teacher emitted illegal move in game ${game.id}.`);
    }
    checkpoint.samples.push(...examples);
    checkpoint.completedGames.push(game.id);
    checkpoint.episodeSummaries.push({ game: game.id, player_count: game.players, board_size: game.size,
      plies: ply, terminal: engine.gameOver });
    await atomic(checkpointPath, checkpoint);
    newGames++;
    console.log(`game ${game.id + 1}/${games.length}: ${game.players} players, size ${game.size}, ${examples.length} samples`);
  }
  if (checkpoint.completedGames.length !== games.length) {
    console.log(`PAUSED: ${checkpoint.completedGames.length}/${games.length} games. Resume with the same command; no completed game will repeat.`);
  } else {
    const dual = checkpoint.samples.filter((s) => s.players === 2 && s.game % 6 !== 5);
    const triple = checkpoint.samples.filter((s) => s.players === 3 && s.game % 6 !== 5);
    const heldout = checkpoint.samples.filter((s) => s.players === 3 && s.game % 6 === 5);
    let weights = checkpoint.weights ?? Array(THREE_PLAYER_FEATURES.length).fill(0);
    const initialLoss = loss(heldout, Array(weights.length).fill(0));
    for (const [phase, dataset, epochs] of [["pretrain", dual, protocol.pretrainEpochs], ["finetune", triple, protocol.finetuneEpochs]]) {
      const startEpoch = checkpoint.phase === phase ? checkpoint.epoch ?? 0 : checkpoint.phase === "finetune" && phase === "pretrain" ? epochs : 0;
      for (let epoch = startEpoch; epoch < epochs; epoch++) {
        const gradient = Array(weights.length).fill(0);
        for (const sample of dataset) {
          const predicted = probabilities(sample.features.map((features) => features.reduce((sum, x, i) => sum + x * weights[i], 0)));
          sample.features.forEach((features, index) => features.forEach((x, feature) => { gradient[feature] += (predicted[index] - sample.targets[index]) * x; }));
        }
        weights = weights.map((w, i) => w - protocol.learningRate * (gradient[i] / dataset.length + 0.0001 * w));
        checkpoint.weights = weights; checkpoint.phase = phase; checkpoint.epoch = epoch + 1;
        await atomic(checkpointPath, checkpoint);
      }
    }
    const training = {
      two_player_samples: dual.length, three_player_samples: triple.length, heldout_three_player_samples: heldout.length,
      completed_generation_episodes: checkpoint.completedGames.length, generated_samples: checkpoint.samples.length,
      terminal_episodes: checkpoint.episodeSummaries.filter((episode) => episode.terminal).length,
      truncated_episodes: checkpoint.episodeSummaries.filter((episode) => !episode.terminal).length,
      pretraining_teacher: protocol.dualTeacher, finetuning_teacher: protocol.tripleTeacher,
      trained_board_sizes: protocol.sizes, source_hashes: sources, protocol_sha256: sha(JSON.stringify(protocol)),
      initial_heldout_cross_entropy: initialLoss, final_heldout_cross_entropy: loss(heldout, weights),
      final_training_cross_entropy: loss(triple, weights), evidence_tier: protocol.evidenceTier,
    };
    const model = {
      schema: { name: "lifeline-three-player-policy", version: 1 }, id: THREE_PLAYER_MODEL_ID,
      rules_version: protocol.rulesVersion, features: THREE_PLAYER_FEATURES, weights, temperature: 1,
      browser_inference: { player_count: 3, board_size_range: [5, 15] }, training,
    };
    await mkdir(dirname(output), { recursive: true });
    const serialized = `${JSON.stringify(model, null, 2)}\n`;
    await writeFile(output, serialized);
    const receipt = { status: "TRAINING-COMPLETE", model: THREE_PLAYER_MODEL_ID, model_sha256: sha(serialized),
      protocol, training, elapsed_seconds_this_invocation: (Date.now() - started) / 1000,
      resume: "Rerun identical command with same --run-root; source/config drift is rejected.",
      limitation: "Lightweight imitation bootstrap; held-out imitation loss is not game strength. Sizes 10–15 are feature-based inference compatibility, not trained-size strength evidence." };
    await writeFile(output.replace(/\.json$/, ".training-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    checkpoint.trained = true;
    await atomic(checkpointPath, checkpoint);
    console.log(JSON.stringify(receipt, null, 2));
  }
} finally {
  await unlink(lockPath);
  await new Promise((accept) => lease.close(accept));
}
