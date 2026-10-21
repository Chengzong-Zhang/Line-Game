import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rename, unlink, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { THREE_PLAYER_FEATURES, createThreePlayerModel, threePlayerCandidates } from "../web前端/ThreePlayerAI.js";
import {
  COLORS, createRng, engineFromActions, policyMoves, terminalOutcome,
} from "./three-player-posttraining-core.mjs";
import { policyProbabilities, samplePolicy, ppoLossAndGradient, adamStep } from "./linear-three-v3-core.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
const runRoot = resolve(root, option("--run-root", "local_artifacts/three-player-ai-posttrain-v3-20261021"));
const configPath = resolve(root, option("--config", "web/tools/configs/three-player-policy-v3.json"));
const parentPath = resolve(root, option("--parent-model", "web/web前端/assets/research-ai/three-player-policy-v2.json"));
const baselinePath = resolve(root, option("--baseline-model", "web/web前端/assets/research-ai/three-player-policy-v1.json"));
const outputPath = resolve(root, option("--output", resolve(runRoot, "three-player-policy-v3.json")));
const maximumSeconds = Number(option("--max-seconds", "600"));
const maximumNewUnits = Number(option("--max-new-units", "100000"));
const checkpointEvents = args.includes("--checkpoint-events");
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
      // Windows readers/antivirus can briefly hold the destination open.
      // Retry for at most 1.206 seconds without deleting valid evidence.
      if (!["EPERM", "EBUSY", "EACCES"].includes(error.code) || attempt >= 12) throw error;
      await new Promise((accept) => setTimeout(accept, 29 + attempt * 13));
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
  if (config.schema !== "lifeline-three-player-reward-posttraining-v1" || config.modelId !== "three-player-policy-v3"
      || config.rulesVersion !== "territory-v2" || !config.sizes?.length || !config.sizes.every((n) => [5, 7, 9].includes(n))
      || !config.starts?.length || !config.starts.every((color) => COLORS.includes(color))
      || !Number.isInteger(config.stages) || config.stages < 1 || config.stages > 3
      || !Number.isInteger(config.maximumEpisodePlies) || config.maximumEpisodePlies < 2
      || !Number.isInteger(config.optimizer?.updatesPerStage) || config.optimizer.updatesPerStage < 1
      || !(config.optimizer.learningRate > 0) || !(config.optimizer.maximumGradientNorm > 0)
      || !(config.optimizer.beta1 > 0 && config.optimizer.beta1 < 1)
      || !(config.optimizer.beta2 > 0 && config.optimizer.beta2 < 1) || !(config.optimizer.epsilon > 0)
      || !(config.ppo?.clip > 0 && config.ppo.clip < 1) || !(config.ppo.anchorKl >= 0) || !(config.ppo.temperature > 0)
      || config.development?.finalArenaAccess !== false || !config.seedNamespace || !config.development.seedNamespace
      || config.seedNamespace === config.development.seedNamespace
      || !Number.isInteger(config.development.prefixReplicates) || config.development.prefixReplicates < 1
      || !Number.isInteger(config.development.maximumGamePlies) || config.development.maximumGamePlies < 2) {
    throw new FatalError("Invalid posttraining protocol.");
  }
}

let lease = null, checkpoint = null, identity = null, config = null, sources = null, parent = null, baseline = null, parentHash = null, baselineHash = null, configHash = null;
let newUnits = 0, started = Date.now();
const checkpointPath = resolve(runRoot, "checkpoint.json");
const progressPath = resolve(runRoot, "progress.json");
let episodes = [], devGames = [];
function progress(status, message = null) {
  return { status, identity, progress_units: (checkpoint?.completedEpisodes.length ?? 0)
      + (checkpoint?.optimizer.step ?? 0) + (checkpoint?.developmentResults.length ?? 0),
    completed_episodes: checkpoint?.completedEpisodes.length ?? 0, total_episodes: episodes.length,
    completed_epochs: checkpoint?.optimizer.step ?? 0, total_epochs: (config?.optimizer.updatesPerStage ?? 0) * (config?.stages ?? 0),
    completed_development_games: checkpoint?.developmentResults.length ?? 0, total_development_games: devGames.length,
    stage: checkpoint?.stage ?? "initializing", message };
}
async function save(status = "RUNNING") {
  await atomic(checkpointPath, checkpoint);
  await atomic(progressPath, progress(status));
  // Optional test observability: emit only after both durable writes complete.
  if (checkpointEvents) console.log(`CHECKPOINT ${checkpoint.stage} episodes=${checkpoint.completedEpisodes.length} episode_actions=${checkpoint.currentEpisode?.actions.length ?? 0} game_actions=${checkpoint.currentDevelopmentGame?.actions.length ?? 0}`);
}
async function checkControl() {
  if (await exists(resolve(runRoot, "STOP"))) throw new ControlledExit("STOPPED");
  if (await exists(resolve(runRoot, "PAUSE"))) throw new ControlledExit("PAUSED");
  if ((Date.now() - started) / 1000 >= maximumSeconds || newUnits >= maximumNewUnits) throw new ControlledExit("YIELDED");
}
const episodePath = (id) => resolve(runRoot, "episodes", `${id}.json`);
const candidatePath = (stage) => resolve(runRoot, "candidates", `stage-${stage}.json`);

try {
  if (!Number.isFinite(maximumSeconds) || maximumSeconds <= 0 || maximumSeconds > 3600
      || !Number.isInteger(maximumNewUnits) || maximumNewUnits < 0) throw new FatalError("Invalid invocation budget.");
  if ([parentPath, baselinePath].includes(outputPath) || /three-player-policy-v[12]\.json$/.test(outputPath)) throw new FatalError("Never overwrite a frozen parent or production model.");
  const [configBytes, parentBytes, baselineBytes] = await Promise.all([readFile(configPath), readFile(parentPath), readFile(baselinePath)]);
  try {
    config = JSON.parse(configBytes); parent = JSON.parse(parentBytes); baseline = JSON.parse(baselineBytes);
    validateConfig(config); createThreePlayerModel(baseline);
    if (parent.id !== "three-player-policy-v2" || JSON.stringify(parent.features) !== JSON.stringify(THREE_PLAYER_FEATURES)
        || !parent.weights?.every(Number.isFinite) || parent.weights.length !== 16
        || parent.lineage?.parent_id !== baseline.id || parent.lineage.parent_sha256 !== sha(baselineBytes)) {
      throw new Error("Invalid frozen v2 warm-start parent.");
    }
  }
  catch (error) { throw new FatalError(error.message); }
  parentHash = sha(parentBytes); baselineHash = sha(baselineBytes); configHash = sha(configBytes);
  const sourcePaths = ["web/tools/finetune-three-player-v3.mjs", "web/tools/linear-three-v3-core.mjs", "web/tools/three-player-posttraining-core.mjs",
    "web/web前端/GameEngine.js", "web/web前端/AIEngine.js", "web/web前端/ThreePlayerAI.js"];
  sources = Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => [path, sha(await readFile(resolve(root, path)))])));
  identity = sha(JSON.stringify({ sources, configHash, parentHash, baselineHash }));
  await mkdir(runRoot, { recursive: true });
  lease = createServer((socket) => socket.destroy());
  const leasePort = 40000 + (seed(runRoot.toLowerCase()) % 20000);
  try { await new Promise((accept, reject) => { lease.once("error", reject); lease.listen({ host: "127.0.0.1", port: leasePort, exclusive: true }, accept); }); }
  catch (error) { lease = null; throw new FatalError(`Duplicate worker or unavailable exclusive lease: ${error.message}`); }
  lease.unref();
  await atomic(resolve(runRoot, "worker.json"), { pid: process.pid, identity, leasePort, output: outputPath });
  const lineups = [...COLORS.map((color) => [color]), ...COLORS.map((color) => COLORS.filter((p) => p !== color))];
  // 8 games/cell/stage = all six lineups plus one single/one dual. Rotating
  // extras yields exactly equal seat/lineup counts across three stages (216).
  for (let stage = 1; stage <= config.stages; stage++) for (const size of config.sizes) for (const start of config.starts) {
    const seats = [...lineups, lineups[(stage - 1) % 3], lineups[3 + (stage - 1) % 3]];
    for (let index = 0; index < seats.length; index++) {
      const id = `stage-${stage}-${size}-${start}-${index}`;
      episodes.push({ id, stage, size, start, seats: seats[index], ordinal: episodes.length, seed: seed(`${config.seedNamespace}${id}`) });
    }
  }
  for (const size of config.sizes) for (const start of config.starts) {
    for (let replicate = 0; replicate < config.development.prefixReplicates; replicate++) {
      const prefixId = `${size}-${start}-${replicate}`, prefixSeed = seed(`${config.development.seedNamespace}${prefixId}`);
      devGames.push({ id: `baseline-${prefixId}`, size, start, prefixId, prefixSeed, stage: 0, seats: [] });
      for (let stage = 1; stage <= config.stages; stage++) for (const seats of lineups) {
        devGames.push({ id: `${stage}-${prefixId}-${seats.join("-")}`, size, start, prefixId, prefixSeed, stage, seats });
      }
    }
  }
  checkpoint = { schema: "lifeline-reward-posttraining-checkpoint-v1", identity, sources, configHash, parentHash, baselineHash,
    stage: "generation", completedEpisodes: [], currentEpisode: null,
    optimizer: { step: 0, weights: [...parent.weights], m: Array(parent.weights.length).fill(0), v: Array(parent.weights.length).fill(0) },
    behaviorModels: [], candidates: [], developmentResults: [], currentDevelopmentGame: null, selectedStage: null };
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
    const unit = await sealed(candidatePath(record.stage));
    if (unit.identity !== identity || unit.integrity !== record.integrity) throw new FatalError("Candidate/source identity mismatch.");
  }
  await checkControl();
  await save();
  for (let stage = 1; stage <= config.stages; stage++) {
  checkpoint.stage = "generation";
  if (!checkpoint.behaviorModels.some((model) => model.stage === stage)) {
    checkpoint.behaviorModels.push({ stage, weights: [...checkpoint.optimizer.weights] });
    await save();
  }
  const behaviorWeights = checkpoint.behaviorModels.find((model) => model.stage === stage).weights;
  for (const spec of episodes.filter((episode) => episode.stage === stage)) {
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
          let move;
          if (spec.seats.includes(player)) {
            const features = candidates.map((candidate) => candidate.features);
            const probabilities = policyProbabilities(features, behaviorWeights, config.ppo.temperature);
            const action = samplePolicy(probabilities, () => rng.next());
            current.samples.push({ game: spec.id, stage, size: spec.size, start: spec.start, player,
              features, action, oldProb: probabilities[action],
              anchor: policyProbabilities(features, parent.weights, config.ppo.temperature) });
            move = candidates[action].point;
          } else {
            const opponent = (spec.ordinal + COLORS.indexOf(player)) % 2 === 0 ? baseline : parent;
            move = policyMoves(engine, opponent.weights, candidates)[0].point;
          }
          if (!engine.playMove(move).success) throw new FatalError("Behavior policy emitted an illegal move.");
          current.actions.push({ player, point: [...move] });
        }
        current.rngState = rng.state;
        await save();
      }
      if (!engine.gameOver) throw new FatalError("Training episode reached its bound; truncated games cannot provide PPO rewards.");
      await quarantine(episodePath(spec.id));
      await atomic(episodePath(spec.id), { identity, ...spec, ...current, terminal: true, outcome: terminalOutcome(engine) });
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
  const training = [...episodeData.values()].filter((episode) => episode.stage === stage).flatMap((episode) =>
    episode.samples.map((sample) => ({ ...sample, advantage: episode.outcome.shares[sample.player] - 1 / 3,
      weight: 1 / episode.samples.filter((other) => other.player === sample.player).length })));
  if (!training.length) throw new FatalError("Empty PPO stage.");
  while (checkpoint.optimizer.step < stage * config.optimizer.updatesPerStage) {
    await checkControl();
    const objective = ppoLossAndGradient(training, checkpoint.optimizer.weights, config.ppo);
    adamStep(checkpoint.optimizer, objective.gradient, config.optimizer);
    newUnits++;
    await save();
  }
  if (!checkpoint.candidates.some((item) => item.stage === stage)) {
    const objective = ppoLossAndGradient(training, checkpoint.optimizer.weights, config.ppo);
    const candidate = { identity, stage, weights: [...checkpoint.optimizer.weights], samples: training.length, objective };
    await quarantine(candidatePath(stage));
    if (await exists(candidatePath(stage))) {
      if ((await sealed(candidatePath(stage))).integrity !== integrity(candidate)) throw new FatalError("Unindexed candidate mismatch.");
    } else await atomic(candidatePath(stage), candidate);
    const stored = await sealed(candidatePath(stage));
    checkpoint.candidates.push({ stage, integrity: stored.integrity, anchorKl: objective.anchorKl });
    await save();
    console.log(`CANDIDATE stage=${stage} ppo_loss=${objective.loss.toFixed(6)} anchor_kl=${objective.anchorKl.toFixed(6)}`);
  }
  }
  checkpoint.stage = "development";
  const candidateModels = new Map(await Promise.all(checkpoint.candidates.map(async ({ stage }) => [stage, await sealed(candidatePath(stage))])));
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
          : policyMoves(engine, game.seats.includes(player) ? candidateModels.get(game.stage).weights : baseline.weights)[0].point;
        if (!engine.playMove(point).success) throw new FatalError("Development policy emitted an illegal move.");
      }
      current.actions.push({ player, point: point ? [...point] : null }); current.rngState = rng.state;
      await save();
    }
    if (!engine.gameOver) throw new FatalError("Development game reached its bound; no truncated outcome may select a candidate.");
    checkpoint.developmentResults.push({ ...game, plies: current.actions.length, actions: current.actions, outcome: terminalOutcome(engine) });
    checkpoint.currentDevelopmentGame = null; newUnits++;
    await save();
    if (checkpoint.developmentResults.length % 9 === 0) console.log(`DEVELOPMENT ${checkpoint.developmentResults.length}/${devGames.length}`);
  }
  const summaries = checkpoint.candidates.map(({ stage }) => {
    const games = checkpoint.developmentResults.filter((game) => game.stage === stage);
    const deltas = games.map((game) => {
      const baseline = checkpoint.developmentResults.find((other) => other.stage === 0 && other.prefixId === game.prefixId);
      return { seats: game.seats.length, size: game.size, delta: game.seats.reduce((sum, seat) => sum + game.outcome.shares[seat] - baseline.outcome.shares[seat], 0) / game.seats.length };
    });
    const mean = (values) => values.reduce((sum, value) => sum + value.delta, 0) / values.length;
    return { stage, games: games.length, meanWinShareDelta: mean(deltas), singleAiDelta: mean(deltas.filter((x) => x.seats === 1)),
      dualAiDelta: mean(deltas.filter((x) => x.seats === 2)), anchorKl: candidateModels.get(stage).objective.anchorKl,
      perSize: Object.fromEntries(config.sizes.map((size) => [size, mean(deltas.filter((x) => x.size === size))])) };
  }).sort((a, b) => b.meanWinShareDelta - a.meanWinShareDelta || a.anchorKl - b.anchorKl || a.stage - b.stage);
  checkpoint.selectedStage = summaries[0].stage;
  const selected = candidateModels.get(checkpoint.selectedStage);
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
      posttraining_samples: [...episodeData.values()].reduce((sum, episode) => sum + episode.samples.length, 0),
      posttraining_algorithm: "terminal-reward clipped PPO with fixed-parent KL anchor",
      optimizer_updates: checkpoint.optimizer.step, parent_posttraining_samples: parent.training.posttraining_samples,
      trained_board_sizes: config.sizes, parent_model_id: parent.id, parent_model_sha256: parentHash,
      production_model_id: baseline.id, production_model_sha256: baselineHash,
      source_hashes: sources, protocol_sha256: configHash, selected_stage: selected.stage,
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
    production_sha256: baselineHash, config_sha256: configHash, source_hashes: sources, model_sha256: sha(modelBytes), selected_stage: selected.stage,
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
