import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rename, unlink, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { THREE_PLAYER_FEATURES, createThreePlayerModel, threePlayerCandidates } from "../web前端/ThreePlayerAI.js";
import {
  COLORS, createRng, engineFromActions, policyMoves, maxNTeacher, softmax,
  crossEntropy, adamEpoch, terminalOutcome,
} from "./three-player-posttraining-core.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
const runRoot = resolve(root, option("--run-root", "local_artifacts/three-player-ai-posttrain-v2-20261021"));
const configPath = resolve(root, option("--config", "web/tools/configs/three-player-policy-v2.json"));
const parentPath = resolve(root, option("--parent-model", "web/web前端/assets/research-ai/three-player-policy-v1.json"));
const outputPath = resolve(root, option("--output", resolve(runRoot, "three-player-policy-v2.json")));
const maximumSeconds = Number(option("--max-seconds", "600"));
const maximumNewUnits = Number(option("--max-new-units", "100000"));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const seed = (text) => parseInt(sha(text).slice(0, 8), 16) >>> 0;
const exists = async (path) => { try { await stat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };
class FatalError extends Error {}
class ControlledExit extends Error { constructor(status) { super(status); this.status = status; } }
const integrity = (value) => { const copy = { ...value }; delete copy.integrity; return sha(JSON.stringify(copy)); };
async function replace(source, destination) {
  for (let attempt = 0; ; attempt++) {
    try { await rename(source, destination); return; }
    catch (error) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(error.code) || attempt >= 7) throw error;
      await new Promise((accept) => setTimeout(accept, (attempt + 1) * 15));
    }
  }
}
async function atomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const payload = { ...value, integrity: integrity(value) };
  await writeFile(`${path}.tmp`, `${JSON.stringify(payload)}\n`);
  await replace(`${path}.tmp`, path);
}
async function sealed(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (value.integrity !== integrity(value)) throw new Error("Integrity mismatch.");
    return value;
  } catch (error) { throw new FatalError(`Invalid durable evidence ${path}: ${error.message}`); }
}
async function quarantine(path) {
  try { await replace(`${path}.tmp`, `${path}.interrupted-${Date.now()}.json`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
function validateConfig(config) {
  if (config.schema !== "lifeline-three-player-posttraining-v1" || config.modelId !== "three-player-policy-v2"
      || config.rulesVersion !== "territory-v2" || !config.sizes?.length || !config.sizes.every((n) => [5, 7, 9].includes(n))
      || !config.starts?.length || !config.starts.every((color) => COLORS.includes(color))
      || !Number.isInteger(config.trainingReplicates) || config.trainingReplicates < 1
      || !Number.isInteger(config.validationReplicates) || config.validationReplicates < 1
      || !Number.isInteger(config.maximumEpisodePlies) || config.maximumEpisodePlies < 2
      || config.teacher?.depth !== 3 || !Number.isInteger(config.teacher.replyWidth) || config.teacher.replyWidth < 1
      || !(config.teacher.temperature > 0) || config.candidateEpochs?.length < 1
      || !config.candidateEpochs.every((n, i) => Number.isInteger(n) && n > 0 && n <= config.optimizer.epochs
        && (i === 0 || n > config.candidateEpochs[i - 1]))
      || !(config.optimizer.learningRate > 0) || !(config.optimizer.anchorPenalty >= 0)
      || !(config.optimizer.beta1 > 0 && config.optimizer.beta1 < 1)
      || !(config.optimizer.beta2 > 0 && config.optimizer.beta2 < 1) || !(config.optimizer.epsilon > 0)
      || Math.abs(config.behavior.parentProbability + config.behavior.teacherProbability + config.behavior.randomProbability - 1) > 1e-9
      || !Object.values(config.behavior).every((n) => n >= 0 && n <= 1)
      || config.development?.finalArenaAccess !== false || !config.seedNamespace || !config.development.seedNamespace
      || config.seedNamespace === config.development.seedNamespace
      || !Number.isInteger(config.development.maximumGamePlies) || config.development.maximumGamePlies < 2) {
    throw new FatalError("Invalid posttraining protocol.");
  }
}

let lease = null, checkpoint = null, identity = null, config = null, sources = null, parent = null, parentHash = null, configHash = null;
let newUnits = 0, started = Date.now();
const checkpointPath = resolve(runRoot, "checkpoint.json");
const progressPath = resolve(runRoot, "progress.json");
let episodes = [], devGames = [];
function progress(status, message = null) {
  return { status, identity, progress_units: (checkpoint?.completedEpisodes.length ?? 0)
      + (checkpoint?.optimizer.epoch ?? 0) + (checkpoint?.developmentResults.length ?? 0),
    completed_episodes: checkpoint?.completedEpisodes.length ?? 0, total_episodes: episodes.length,
    completed_epochs: checkpoint?.optimizer.epoch ?? 0, total_epochs: config?.optimizer.epochs ?? 0,
    completed_development_games: checkpoint?.developmentResults.length ?? 0, total_development_games: devGames.length,
    stage: checkpoint?.stage ?? "initializing", message };
}
async function save(status = "RUNNING") {
  await atomic(checkpointPath, checkpoint);
  await atomic(progressPath, progress(status));
}
async function checkControl() {
  if (await exists(resolve(runRoot, "STOP"))) throw new ControlledExit("STOPPED");
  if (await exists(resolve(runRoot, "PAUSE"))) throw new ControlledExit("PAUSED");
  if ((Date.now() - started) / 1000 >= maximumSeconds || newUnits >= maximumNewUnits) throw new ControlledExit("YIELDED");
}
const episodePath = (id) => resolve(runRoot, "episodes", `${id}.json`);
const candidatePath = (epoch) => resolve(runRoot, "candidates", `epoch-${epoch}.json`);

try {
  if (!Number.isFinite(maximumSeconds) || maximumSeconds <= 0 || maximumSeconds > 3600
      || !Number.isInteger(maximumNewUnits) || maximumNewUnits < 0) throw new FatalError("Invalid invocation budget.");
  if (outputPath === parentPath || outputPath.endsWith("three-player-policy-v1.json")) throw new FatalError("Never overwrite the v1 parent.");
  const [configBytes, parentBytes] = await Promise.all([readFile(configPath), readFile(parentPath)]);
  try { config = JSON.parse(configBytes); parent = JSON.parse(parentBytes); validateConfig(config); createThreePlayerModel(parent); }
  catch (error) { throw new FatalError(error.message); }
  parentHash = sha(parentBytes); configHash = sha(configBytes);
  const sourcePaths = ["web/tools/finetune-three-player-ai.mjs", "web/tools/three-player-posttraining-core.mjs",
    "web/web前端/GameEngine.js", "web/web前端/AIEngine.js", "web/web前端/ThreePlayerAI.js"];
  sources = Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => [path, sha(await readFile(resolve(root, path)))])));
  identity = sha(JSON.stringify({ sources, configHash, parentHash }));
  await mkdir(runRoot, { recursive: true });
  lease = createServer((socket) => socket.destroy());
  const leasePort = 40000 + (seed(runRoot.toLowerCase()) % 20000);
  try { await new Promise((accept, reject) => { lease.once("error", reject); lease.listen({ host: "127.0.0.1", port: leasePort, exclusive: true }, accept); }); }
  catch (error) { lease = null; throw new FatalError(`Duplicate worker or unavailable exclusive lease: ${error.message}`); }
  lease.unref();
  await atomic(resolve(runRoot, "worker.json"), { pid: process.pid, identity, leasePort, output: outputPath });
  for (const size of config.sizes) for (const start of config.starts) {
    for (const split of ["train", "validation"]) {
      const repetitions = split === "train" ? config.trainingReplicates : config.validationReplicates;
      for (let replicate = 0; replicate < repetitions; replicate++) {
        const id = `${size}-${start}-${split}-${replicate}`;
        episodes.push({ id, size, start, split, seed: seed(`${config.seedNamespace}${id}`) });
      }
    }
  }
  const lineups = [[], ...COLORS.map((color) => [color]), ...COLORS.map((color) => COLORS.filter((p) => p !== color))];
  for (const size of config.sizes) for (const start of config.starts) {
    const prefixId = `${size}-${start}`, prefixSeed = seed(`${config.development.seedNamespace}${prefixId}`);
    devGames.push({ id: `baseline-${prefixId}`, size, start, prefixId, prefixSeed, epoch: 0, seats: [] });
    for (const epoch of config.candidateEpochs) for (const seats of lineups.slice(1)) {
      devGames.push({ id: `${epoch}-${prefixId}-${seats.join("-")}`, size, start, prefixId, prefixSeed, epoch, seats });
    }
  }
  checkpoint = { schema: "lifeline-posttraining-checkpoint-v1", identity, sources, configHash, parentHash,
    stage: "generation", completedEpisodes: [], currentEpisode: null,
    optimizer: { epoch: 0, weights: [...parent.weights], m: Array(parent.weights.length).fill(0), v: Array(parent.weights.length).fill(0) },
    candidates: [], developmentResults: [], currentDevelopmentGame: null, selectedEpoch: null };
  if (await exists(checkpointPath)) {
    checkpoint = await sealed(checkpointPath);
    if (checkpoint.identity !== identity) throw new FatalError("Source/config/parent identity mismatch; use a new run root.");
    if (new Set(checkpoint.completedEpisodes.map((entry) => entry.id)).size !== checkpoint.completedEpisodes.length
        || new Set(checkpoint.developmentResults.map((entry) => entry.id)).size !== checkpoint.developmentResults.length) {
      throw new FatalError("Duplicate durable units in checkpoint.");
    }
  }
  await quarantine(checkpointPath);
  await quarantine(progressPath);
  // Validate every durable unit before claiming any progress or resuming work.
  const episodeData = new Map();
  for (const record of checkpoint.completedEpisodes) {
    const unit = await sealed(episodePath(record.id));
    if (unit.identity !== identity || unit.integrity !== record.integrity) throw new FatalError("Episode/source identity mismatch.");
    episodeData.set(record.id, unit);
  }
  for (const record of checkpoint.candidates) {
    const unit = await sealed(candidatePath(record.epoch));
    if (unit.identity !== identity || unit.integrity !== record.integrity) throw new FatalError("Candidate/source identity mismatch.");
  }
  await checkControl();
  await save();
  for (const spec of episodes) {
    if (episodeData.has(spec.id)) continue;
    await checkControl();
    if (checkpoint.currentEpisode && checkpoint.currentEpisode.id !== spec.id) throw new FatalError("In-flight episode order mismatch.");
    checkpoint.currentEpisode ??= { id: spec.id, actions: [], samples: [], rngState: spec.seed };
    const current = checkpoint.currentEpisode;
    const engine = engineFromActions(spec, current.actions);
    const rng = createRng(current.rngState);
    // A completed unit may precede its index commit by one atomic write. Adopt
    // the validated receipt instead of regenerating a completed episode.
    if (!(await exists(episodePath(spec.id)))) {
      while (!engine.gameOver && current.actions.length < config.maximumEpisodePlies) {
        await checkControl();
        const player = engine.currentPlayer;
        const candidates = threePlayerCandidates(engine);
        if (!candidates.length) {
          engine.skipTurn(); current.actions.push({ player, point: null });
        } else {
          const teacher = maxNTeacher(engine, config.teacher);
          const scores = new Map(teacher.moves.map((move) => [move.point.join(","), move.score]));
          if (scores.size !== candidates.length) throw new FatalError("Teacher failed to label every legal action.");
          if (candidates.length > 1) current.samples.push({
            game: spec.id, split: spec.split, size: spec.size, start: spec.start, ply: current.actions.length,
            features: candidates.map((candidate) => candidate.features),
            targets: softmax(candidates.map((candidate) => scores.get(candidate.point.join(","))), config.teacher.temperature),
          });
          const choice = rng.next();
          const move = choice < config.behavior.parentProbability ? policyMoves(engine, parent.weights, candidates)[0].point
            : choice < config.behavior.parentProbability + config.behavior.teacherProbability ? teacher.moves[0].point
              : candidates[Math.floor(rng.next() * candidates.length)].point;
          if (!engine.playMove(move).success) throw new FatalError("Behavior policy emitted an illegal move.");
          current.actions.push({ player, point: [...move] });
        }
        current.rngState = rng.state;
        await save();
      }
      await quarantine(episodePath(spec.id));
      await atomic(episodePath(spec.id), { identity, ...spec, ...current, terminal: engine.gameOver,
        outcome: engine.gameOver ? terminalOutcome(engine) : null });
    }
    const unit = await sealed(episodePath(spec.id));
    if (unit.identity !== identity || JSON.stringify(unit.actions) !== JSON.stringify(current.actions)
        || JSON.stringify(unit.samples) !== JSON.stringify(current.samples) || unit.rngState !== current.rngState) {
      throw new FatalError("Unindexed episode receipt does not match in-flight checkpoint.");
    }
    checkpoint.completedEpisodes.push({ id: spec.id, integrity: unit.integrity });
    episodeData.set(spec.id, unit);
    checkpoint.currentEpisode = null;
    newUnits++;
    await save();
    console.log(`EPISODE ${checkpoint.completedEpisodes.length}/${episodes.length} ${spec.id} ${unit.actions.length} plies ${unit.terminal ? "terminal" : "truncated"}`);
  }
  checkpoint.stage = "optimization";
  const samples = [...episodeData.values()].flatMap((episode) => episode.samples);
  const training = samples.filter((sample) => sample.split === "train");
  const validation = samples.filter((sample) => sample.split === "validation");
  if (!training.length || !validation.length) throw new FatalError("An entire training or validation split is empty.");
  const initialValidationLoss = crossEntropy(validation, parent.weights);
  const saveCandidate = async () => {
    const epoch = checkpoint.optimizer.epoch;
    if (!config.candidateEpochs.includes(epoch) || checkpoint.candidates.some((item) => item.epoch === epoch)) return;
    const candidate = { identity, epoch, weights: [...checkpoint.optimizer.weights],
      trainingLoss: crossEntropy(training, checkpoint.optimizer.weights), validationLoss: crossEntropy(validation, checkpoint.optimizer.weights) };
    await quarantine(candidatePath(epoch));
    if (await exists(candidatePath(epoch))) {
      const orphan = await sealed(candidatePath(epoch));
      if (orphan.integrity !== integrity(candidate)) throw new FatalError("Unindexed candidate does not match the optimizer checkpoint.");
    } else await atomic(candidatePath(epoch), candidate);
    const stored = await sealed(candidatePath(epoch));
    checkpoint.candidates.push({ epoch, integrity: stored.integrity, validationLoss: candidate.validationLoss });
    await save();
    console.log(`CANDIDATE epoch=${epoch} validation_loss=${candidate.validationLoss.toFixed(6)}`);
  };
  await saveCandidate();
  while (checkpoint.optimizer.epoch < config.optimizer.epochs) {
    await checkControl();
    adamEpoch(training, checkpoint.optimizer, config.optimizer, parent.weights);
    newUnits++;
    await save();
    await saveCandidate();
  }
  checkpoint.stage = "development";
  const candidateModels = new Map(await Promise.all(config.candidateEpochs.map(async (epoch) => [epoch, await sealed(candidatePath(epoch))])));
  for (const game of devGames) {
    if (checkpoint.developmentResults.some((result) => result.id === game.id)) continue;
    await checkControl();
    if (checkpoint.currentDevelopmentGame && checkpoint.currentDevelopmentGame.id !== game.id) throw new FatalError("Development game order mismatch.");
    checkpoint.currentDevelopmentGame ??= { id: game.id, actions: [], rngState: game.prefixSeed };
    const current = checkpoint.currentDevelopmentGame, engine = engineFromActions(game, current.actions), rng = createRng(current.rngState);
    while (!engine.gameOver && current.actions.length < config.development.maximumGamePlies) {
      await checkControl();
      const player = engine.currentPlayer, legal = engine.getLegalMoves(player);
      let point = null;
      if (!legal.length) engine.skipTurn();
      else {
        point = current.actions.length < config.development.prefixPlies
          ? legal[Math.floor(rng.next() * legal.length)].point
          : policyMoves(engine, game.seats.includes(player) ? candidateModels.get(game.epoch).weights : parent.weights)[0].point;
        if (!engine.playMove(point).success) throw new FatalError("Development policy emitted an illegal move.");
      }
      current.actions.push({ player, point: point ? [...point] : null }); current.rngState = rng.state;
      await save();
    }
    if (!engine.gameOver) throw new FatalError("Development game reached its bound; no truncated outcome may select a candidate.");
    checkpoint.developmentResults.push({ ...game, plies: current.actions.length, outcome: terminalOutcome(engine) });
    checkpoint.currentDevelopmentGame = null; newUnits++;
    await save();
    if (checkpoint.developmentResults.length % 9 === 0) console.log(`DEVELOPMENT ${checkpoint.developmentResults.length}/${devGames.length}`);
  }
  const summaries = config.candidateEpochs.map((epoch) => {
    const games = checkpoint.developmentResults.filter((game) => game.epoch === epoch);
    const deltas = games.map((game) => {
      const baseline = checkpoint.developmentResults.find((other) => other.epoch === 0 && other.prefixId === game.prefixId);
      return { seats: game.seats.length, size: game.size, delta: game.seats.reduce((sum, seat) => sum + game.outcome.shares[seat] - baseline.outcome.shares[seat], 0) / game.seats.length };
    });
    const mean = (values) => values.reduce((sum, value) => sum + value.delta, 0) / values.length;
    return { epoch, games: games.length, meanWinShareDelta: mean(deltas), singleAiDelta: mean(deltas.filter((x) => x.seats === 1)),
      dualAiDelta: mean(deltas.filter((x) => x.seats === 2)), validationLoss: candidateModels.get(epoch).validationLoss,
      perSize: Object.fromEntries(config.sizes.map((size) => [size, mean(deltas.filter((x) => x.size === size))])) };
  }).sort((a, b) => b.meanWinShareDelta - a.meanWinShareDelta || a.validationLoss - b.validationLoss || a.epoch - b.epoch);
  checkpoint.selectedEpoch = summaries[0].epoch;
  const selected = candidateModels.get(checkpoint.selectedEpoch);
  for (const [path, hash] of Object.entries(sources)) {
    if (sha(await readFile(resolve(root, path))) !== hash) throw new FatalError(`Source changed during the run: ${path}`);
  }
  const model = {
    schema: { name: "lifeline-three-player-policy", version: 1 }, id: config.modelId,
    rules_version: "territory-v2", features: THREE_PLAYER_FEATURES, weights: selected.weights, temperature: 1,
    browser_inference: { player_count: 3, board_size_range: [5, 15] },
    lineage: { type: "weights-only-warm-start", parent_id: parent.id, parent_sha256: parentHash },
    training: {
      two_player_samples: parent.training.two_player_samples, three_player_samples: parent.training.three_player_samples,
      posttraining_samples: training.length, validation_samples: validation.length,
      trained_board_sizes: config.sizes, parent_model_id: parent.id, parent_model_sha256: parentHash,
      source_hashes: sources, protocol_sha256: configHash, selected_epoch: selected.epoch,
      initial_validation_cross_entropy: initialValidationLoss, final_validation_cross_entropy: selected.validationLoss,
      selection_basis: config.development.selection, development_summaries: summaries,
      completed_generation_episodes: episodes.length,
      terminal_episodes: [...episodeData.values()].filter((episode) => episode.terminal).length,
      truncated_episodes: [...episodeData.values()].filter((episode) => !episode.terminal).length,
      completed_development_games: checkpoint.developmentResults.length,
      evidence_tier: "application-posttraining; independent final arena pending",
    },
  };
  const modelBytes = `${JSON.stringify(model, null, 2)}\n`;
  await mkdir(dirname(outputPath), { recursive: true });
  if (await exists(outputPath)) {
    if (sha(await readFile(outputPath)) !== sha(modelBytes)) throw new FatalError("Output is already frozen with different contents.");
  } else {
    await writeFile(`${outputPath}.tmp`, modelBytes); await replace(`${outputPath}.tmp`, outputPath);
  }
  const receipt = { status: "TRAINING-AND-DEVELOPMENT-COMPLETE", identity, parent_sha256: parentHash,
    config_sha256: configHash, source_hashes: sources, model_sha256: sha(modelBytes), selected_epoch: selected.epoch,
    training: model.training, independent_final_arena: "NOT-RUN",
    boundaries: "Development selection is not an independent strength result. Inherited v1 counts are provenance, not new posttraining samples." };
  await atomic(resolve(runRoot, "training-receipt.json"), receipt);
  checkpoint.stage = "complete"; checkpoint.outputSha256 = sha(modelBytes);
  await save("COMPLETE");
  console.log(JSON.stringify(receipt, null, 2));
} catch (error) {
  const status = error instanceof ControlledExit ? error.status : error instanceof FatalError ? "FATAL" : "FAILED";
  // Duplicate lease contenders must never overwrite the owner's evidence.
  if (lease) {
    if (checkpoint && error instanceof ControlledExit) await save(status);
    else await atomic(progressPath, progress(status, error.message));
  }
  console.error(`${status}: ${error.message}`);
  process.exitCode = error instanceof ControlledExit ? 75 : error instanceof FatalError ? 78 : 1;
} finally {
  if (lease) {
    try { await unlink(resolve(runRoot, "worker.json")); } catch (error) { if (error.code !== "ENOENT") console.error(error.message); }
    await new Promise((accept) => lease.close(accept));
  }
}
