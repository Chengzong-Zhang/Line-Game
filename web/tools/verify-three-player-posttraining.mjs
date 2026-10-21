// Read-only verification of frozen posttraining evidence. Arithmetic and
// selection are recomputed here; the canonical rules/features are hash-checked.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const self = fileURLToPath(import.meta.url);
const root = resolve(dirname(self), "../..");
const args = process.argv.slice(2);
const option = (key, fallback) => {
  const index = args.indexOf(key);
  return index < 0 ? fallback : args[index + 1];
};
const runRoot = resolve(root, option("--run-root", "local_artifacts/three-player-ai-posttrain-v2-20261021"));
const configPath = resolve(root, option("--config", "web/tools/configs/three-player-policy-v2.json"));
const parentPath = resolve(root, option("--parent-model", "web/web前端/assets/research-ai/three-player-policy-v1.json"));
const modelPath = resolve(root, option("--model", resolve(runRoot, "three-player-policy-v2.json")));
const reportPath = resolve(root, option("--output", resolve(runRoot, "training-independent-verification.json")));
const COLORS = ["BLACK", "WHITE", "PURPLE"];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const seed = (text) => parseInt(hash(text).slice(0, 8), 16) >>> 0;
const jsonHash = (value) => hash(JSON.stringify(value));
const load = async (path) => JSON.parse(await readFile(path, "utf8"));
async function sealed(path) {
  const value = await load(path);
  const { integrity, ...body } = value;
  assert.equal(integrity, jsonHash(body), `Integrity mismatch: ${path}`);
  return value;
}
function close(actual, expected, label, tolerance = 2e-12) {
  assert.ok(Number.isFinite(actual) && Number.isFinite(expected)
    && Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
  `${label}: ${actual} differs from ${expected}`);
}
function vectorClose(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label} length`);
  actual.forEach((value, i) => close(value, expected[i], `${label}[${i}]`));
}
function probabilities(values, temperature = 1) {
  const maximum = Math.max(...values);
  const valuesExp = values.map((value) => Math.exp((value - maximum) / temperature));
  const sum = valuesExp.reduce((total, value) => total + value, 0);
  return valuesExp.map((value) => value / sum);
}
function rngFrom(initial) {
  let state = initial >>> 0;
  return {
    next() { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; },
    get state() { return state; },
  };
}
const pointOrder = (a, b) => a.point[1] - b.point[1] || a.point[0] - b.point[0];
function policyChoice(candidates, weights) {
  return candidates.map((move) => ({ ...move, score: move.features.reduce((sum, x, i) => sum + x * weights[i], 0) }))
    .sort((a, b) => b.score - a.score || pointOrder(a, b))[0].point;
}
function loss(samples, weights) {
  let total = 0;
  for (const sample of samples) {
    const p = probabilities(sample.features.map((x) => x.reduce((sum, value, i) => sum + value * weights[i], 0)));
    total -= sample.targets.reduce((sum, target, i) => sum + target * Math.log(Math.max(1e-12, p[i])), 0);
  }
  return total / samples.length;
}
function optimizerStep(samples, state, config, parentWeights) {
  const gradient = Array(state.weights.length).fill(0);
  for (const sample of samples) {
    const p = probabilities(sample.features.map((x) => x.reduce((sum, value, i) => sum + value * state.weights[i], 0)));
    for (let action = 0; action < sample.features.length; action++) {
      for (let i = 0; i < gradient.length; i++) {
        gradient[i] += (p[action] - sample.targets[action]) * sample.features[action][i] / samples.length;
      }
    }
  }
  state.epoch++;
  for (let i = 0; i < gradient.length; i++) {
    const g = gradient[i] + config.anchorPenalty * (state.weights[i] - parentWeights[i]);
    state.m[i] = config.beta1 * state.m[i] + (1 - config.beta1) * g;
    state.v[i] = config.beta2 * state.v[i] + (1 - config.beta2) * g * g;
    state.weights[i] -= config.learningRate * (state.m[i] / (1 - config.beta1 ** state.epoch))
      / (Math.sqrt(state.v[i] / (1 - config.beta2 ** state.epoch)) + config.epsilon);
  }
}
function canonicalOutcome(engine) {
  assert.equal(engine.gameOver, true, "Nonterminal result cannot be scored.");
  engine.getWinner();
  const scores = Object.fromEntries(COLORS.map((player) => [player, engine.cachedTerritories[player].area]));
  for (const score of Object.values(scores)) assert.ok(Number.isInteger(score) && score >= 0);
  const active = COLORS.filter((player) => !engine.resignedPlayers.has(player));
  const maximum = Math.max(...active.map((player) => scores[player]));
  const leaders = active.filter((player) => scores[player] === maximum);
  assert.ok(leaders.length > 0);
  return { scores, leaders, shares: Object.fromEntries(COLORS.map((player) => [player, leaders.includes(player) ? 1 / leaders.length : 0])) };
}
function apply(engine, action) {
  assert.equal(engine.gameOver, false, "Action follows terminal state.");
  assert.equal(action.player, engine.currentPlayer, "Wrong actor in action prefix.");
  if (action.point === null) {
    assert.equal(engine.getLegalMoves(engine.currentPlayer).length, 0, "Voluntary pass in saved episode.");
    engine.skipTurn();
  } else assert.equal(engine.playMove(action.point).success, true, "Illegal saved move.");
}

try {
  const started = Date.now();
  const [configBytes, parentBytes, modelBytes, checkpoint, receipt, progress] = await Promise.all([
    readFile(configPath), readFile(parentPath), readFile(modelPath),
    sealed(resolve(runRoot, "checkpoint.json")), sealed(resolve(runRoot, "training-receipt.json")),
    sealed(resolve(runRoot, "progress.json")),
  ]);
  const config = JSON.parse(configBytes), parent = JSON.parse(parentBytes), model = JSON.parse(modelBytes);
  assert.equal(config.schema, "lifeline-three-player-posttraining-v1");
  assert.equal(config.rulesVersion, "territory-v2");
  assert.equal(config.development.finalArenaAccess, false);
  assert.notEqual(config.seedNamespace, config.development.seedNamespace);
  assert.equal(progress.status, "COMPLETE");
  assert.equal(checkpoint.stage, "complete");
  assert.equal(checkpoint.currentEpisode, null);
  assert.equal(checkpoint.currentDevelopmentGame, null);
  assert.equal(checkpoint.configHash, hash(configBytes));
  assert.equal(checkpoint.parentHash, hash(parentBytes));
  assert.equal(checkpoint.outputSha256, hash(modelBytes));
  const expectedSources = ["web/tools/finetune-three-player-ai.mjs", "web/tools/three-player-posttraining-core.mjs",
    "web/web前端/GameEngine.js", "web/web前端/AIEngine.js", "web/web前端/ThreePlayerAI.js"];
  assert.deepEqual(Object.keys(checkpoint.sources), expectedSources, "Frozen source manifest changed.");
  for (const [path, digest] of Object.entries(checkpoint.sources)) {
    assert.equal(hash(await readFile(resolve(root, path))), digest, `Frozen source changed: ${path}`);
  }
  const identity = jsonHash({ sources: checkpoint.sources, configHash: hash(configBytes), parentHash: hash(parentBytes) });
  for (const object of [checkpoint, progress, receipt]) assert.equal(object.identity, identity);
  assert.equal(receipt.status, "TRAINING-AND-DEVELOPMENT-COMPLETE");
  assert.equal(receipt.parent_sha256, hash(parentBytes));
  assert.equal(receipt.config_sha256, hash(configBytes));
  assert.equal(receipt.model_sha256, hash(modelBytes));
  assert.deepEqual(receipt.source_hashes, checkpoint.sources);
  assert.equal(receipt.independent_final_arena, "NOT-RUN");
  assert.deepEqual(receipt.training, model.training);
  assert.deepEqual(model.schema, { name: "lifeline-three-player-policy", version: 1 });
  assert.equal(model.id, config.modelId);
  assert.equal(model.rules_version, config.rulesVersion);
  assert.deepEqual(model.lineage, { type: "weights-only-warm-start", parent_id: parent.id, parent_sha256: hash(parentBytes) });
  assert.equal(model.training.parent_model_id, parent.id);
  assert.equal(model.training.parent_model_sha256, hash(parentBytes));
  assert.equal(model.training.protocol_sha256, hash(configBytes));
  assert.deepEqual(model.training.source_hashes, checkpoint.sources);
  assert.equal(model.training.two_player_samples, parent.training.two_player_samples);
  assert.equal(model.training.three_player_samples, parent.training.three_player_samples);
  assert.deepEqual(model.training.trained_board_sizes, config.sizes);
  assert.equal(model.training.selection_basis, config.development.selection);

  // Import only after exact source identity has been checked.
  const { GameEngine } = await import(pathToFileURL(resolve(root, "web/web前端/GameEngine.js")).href);
  const { threePlayerCandidates, THREE_PLAYER_FEATURES } = await import(pathToFileURL(resolve(root, "web/web前端/ThreePlayerAI.js")).href);
  const { maxNTeacher } = await import(pathToFileURL(resolve(root, "web/tools/three-player-posttraining-core.mjs")).href);
  assert.deepEqual(model.features, THREE_PLAYER_FEATURES);
  assert.deepEqual(parent.features, THREE_PLAYER_FEATURES);
  const engineFor = (spec) => {
    const engine = new GameEngine({ gridSize: spec.size, playerCount: 3, startPlayer: spec.start, rulesVersion: "territory-v2" });
    engine._isReplayingBatch = true;
    return engine;
  };
  const episodeSpecs = [];
  for (const size of config.sizes) for (const start of config.starts) for (const split of ["train", "validation"]) {
    const count = split === "train" ? config.trainingReplicates : config.validationReplicates;
    for (let replicate = 0; replicate < count; replicate++) {
      const id = `${size}-${start}-${split}-${replicate}`;
      episodeSpecs.push({ id, size, start, split, seed: seed(`${config.seedNamespace}${id}`) });
    }
  }
  assert.deepEqual(checkpoint.completedEpisodes.map((x) => x.id), episodeSpecs.map((x) => x.id));
  const allSamples = [], episodeManifest = [], splitBalance = {}, teacherChecks = [];
  let terminalEpisodes = 0, episodeActions = 0, featuresChecked = 0;
  for (const [index, spec] of episodeSpecs.entries()) {
    const unit = await sealed(resolve(runRoot, "episodes", `${spec.id}.json`));
    assert.equal(unit.integrity, checkpoint.completedEpisodes[index].integrity);
    assert.equal(unit.identity, identity);
    for (const [key, value] of Object.entries(spec)) assert.equal(unit[key], value, `Episode ${spec.id}: ${key}`);
    assert.ok(unit.actions.length <= config.maximumEpisodePlies);
    assert.equal(new Set(unit.samples.map((sample) => sample.ply)).size, unit.samples.length);
    const byPly = new Map(unit.samples.map((sample) => [sample.ply, sample]));
    const engine = engineFor(spec), rng = rngFrom(spec.seed);
    const sampledTeacher = spec.split === "train" && spec.id.endsWith("-0")
      ? unit.samples[Math.floor(unit.samples.length / 2)] : null;
    let samplesSeen = 0;
    for (let ply = 0; ply < unit.actions.length; ply++) {
      const action = unit.actions[ply], candidates = threePlayerCandidates(engine), sample = byPly.get(ply);
      if (candidates.length > 1) {
        assert.ok(sample, `Missing multi-action target: ${spec.id}/${ply}`);
        for (const key of ["size", "start", "split"]) assert.equal(sample[key], spec[key]);
        assert.equal(sample.game, spec.id);
        assert.equal(sample.features.length, candidates.length);
        assert.equal(sample.targets.length, candidates.length);
        sample.features.forEach((features, i) => {
          assert.equal(features.length, parent.weights.length);
          vectorClose(features, candidates[i].features, `${spec.id}/${ply}/features/${i}`);
          featuresChecked++;
        });
        assert.ok(sample.targets.every((value) => Number.isFinite(value) && value >= 0 && value <= 1));
        close(sample.targets.reduce((a, b) => a + b, 0), 1, "Target normalization");
        samplesSeen++;
        if (sample === sampledTeacher) {
          const labels = maxNTeacher(engine, config.teacher);
          const scores = new Map(labels.moves.map((move) => [move.point.join(","), move.score]));
          assert.equal(scores.size, candidates.length);
          const targets = probabilities(candidates.map((move) => scores.get(move.point.join(","))), config.teacher.temperature);
          vectorClose(sample.targets, targets, `Teacher recomputation ${spec.id}/${ply}`);
          teacherChecks.push({ episode: spec.id, ply, actor: engine.currentPlayer, legal_actions: candidates.length,
            action_prefix: unit.actions.slice(0, ply), targets_sha256: jsonHash(sample.targets) });
        }
      } else assert.equal(sample, undefined, "Unexpected zero/one-action training target.");
      if (candidates.length) {
        const choice = rng.next();
        let expected;
        if (choice < config.behavior.parentProbability) expected = policyChoice(candidates, parent.weights);
        else if (choice < config.behavior.parentProbability + config.behavior.teacherProbability) {
          expected = candidates.length === 1 ? candidates[0].point
            : candidates.map((move, i) => ({ ...move, target: sample.targets[i] }))
              .sort((a, b) => b.target - a.target || pointOrder(a, b))[0].point;
        } else expected = candidates[Math.floor(rng.next() * candidates.length)].point;
        assert.deepEqual(action.point, expected, `Behavior mixture or RNG mismatch: ${spec.id}/${ply}`);
      } else assert.equal(action.point, null);
      apply(engine, action);
    }
    assert.equal(samplesSeen, unit.samples.length);
    assert.equal(rng.state, unit.rngState);
    assert.equal(unit.terminal, engine.gameOver);
    if (engine.gameOver) { terminalEpisodes++; assert.deepEqual(unit.outcome, canonicalOutcome(engine)); }
    else { assert.equal(unit.actions.length, config.maximumEpisodePlies); assert.equal(unit.outcome, null); }
    const key = `${spec.size}/${spec.start}/${spec.split}`;
    splitBalance[key] = (splitBalance[key] ?? 0) + 1;
    allSamples.push(...unit.samples);
    episodeActions += unit.actions.length;
    episodeManifest.push({ id: unit.id, integrity: unit.integrity, action_sha256: jsonHash(unit.actions), terminal: unit.terminal });
  }
  assert.equal(teacherChecks.length, config.sizes.length * config.starts.length);
  const training = allSamples.filter((sample) => sample.split === "train");
  const validation = allSamples.filter((sample) => sample.split === "validation");
  assert.ok(training.length > 0 && validation.length > 0);
  assert.equal(model.training.posttraining_samples, training.length);
  assert.equal(model.training.validation_samples, validation.length);
  assert.equal(model.training.completed_generation_episodes, episodeSpecs.length);
  assert.equal(model.training.terminal_episodes, terminalEpisodes);
  assert.equal(model.training.truncated_episodes, episodeSpecs.length - terminalEpisodes);
  close(model.training.initial_validation_cross_entropy, loss(validation, parent.weights), "Initial validation loss");
  console.log(`VERIFIED episodes=${episodeSpecs.length} actions=${episodeActions} teacher_samples=${teacherChecks.length}`);

  const candidates = new Map();
  assert.deepEqual(checkpoint.candidates.map((x) => x.epoch), config.candidateEpochs);
  for (const record of checkpoint.candidates) {
    const candidate = await sealed(resolve(runRoot, "candidates", `epoch-${record.epoch}.json`));
    assert.equal(candidate.identity, identity);
    assert.equal(candidate.integrity, record.integrity);
    assert.equal(candidate.epoch, record.epoch);
    close(record.validationLoss, candidate.validationLoss, "Candidate index validation loss");
    candidates.set(record.epoch, candidate);
  }
  const optimizer = { epoch: 0, weights: [...parent.weights], m: parent.weights.map(() => 0), v: parent.weights.map(() => 0) };
  for (let epoch = 1; epoch <= config.optimizer.epochs; epoch++) {
    optimizerStep(training, optimizer, config.optimizer, parent.weights);
    const candidate = candidates.get(epoch);
    if (candidate) {
      vectorClose(candidate.weights, optimizer.weights, `Candidate ${epoch} weights`);
      close(candidate.trainingLoss, loss(training, optimizer.weights), `Candidate ${epoch} training loss`);
      close(candidate.validationLoss, loss(validation, optimizer.weights), `Candidate ${epoch} validation loss`);
    }
  }
  assert.equal(checkpoint.optimizer.epoch, optimizer.epoch);
  for (const key of ["weights", "m", "v"]) vectorClose(checkpoint.optimizer[key], optimizer[key], `Final Adam ${key}`);
  console.log(`VERIFIED Adam epochs=${optimizer.epoch} candidates=${candidates.size}`);

  const devSpecs = [];
  const mixedSeats = [...COLORS.map((color) => [color]), ...COLORS.map((color) => COLORS.filter((p) => p !== color))];
  for (const size of config.sizes) for (const start of config.starts) {
    const prefixId = `${size}-${start}`, prefixSeed = seed(`${config.development.seedNamespace}${prefixId}`);
    devSpecs.push({ id: `baseline-${prefixId}`, size, start, prefixId, prefixSeed, epoch: 0, seats: [] });
    for (const epoch of config.candidateEpochs) for (const seats of mixedSeats) {
      devSpecs.push({ id: `${epoch}-${prefixId}-${seats.join("-")}`, size, start, prefixId, prefixSeed, epoch, seats });
    }
  }
  assert.deepEqual(checkpoint.developmentResults.map((x) => x.id), devSpecs.map((x) => x.id));
  const verifiedDevelopment = [];
  for (const [index, spec] of devSpecs.entries()) {
    const saved = checkpoint.developmentResults[index], engine = engineFor(spec), rng = rngFrom(spec.prefixSeed);
    for (const [key, value] of Object.entries(spec)) assert.deepEqual(saved[key], value);
    const actions = [];
    while (!engine.gameOver && actions.length < config.development.maximumGamePlies) {
      const player = engine.currentPlayer, legal = engine.getLegalMoves(player);
      let point = null;
      if (legal.length) point = actions.length < config.development.prefixPlies
        ? legal[Math.floor(rng.next() * legal.length)].point
        : policyChoice(threePlayerCandidates(engine), spec.seats.includes(player) ? candidates.get(spec.epoch).weights : parent.weights);
      const action = { player, point };
      apply(engine, action); actions.push(action);
    }
    assert.equal(engine.gameOver, true, `Truncated development game: ${spec.id}`);
    assert.equal(saved.plies, actions.length);
    assert.deepEqual(saved.outcome, canonicalOutcome(engine), `Development outcome: ${spec.id}`);
    verifiedDevelopment.push({ id: spec.id, plies: actions.length, actions_sha256: jsonHash(actions), outcome: saved.outcome });
    if ((index + 1) % 30 === 0) console.log(`VERIFIED development=${index + 1}/${devSpecs.length}`);
  }
  const summaries = config.candidateEpochs.map((epoch) => {
    const games = checkpoint.developmentResults.filter((game) => game.epoch === epoch);
    const deltas = games.map((game) => {
      const control = checkpoint.developmentResults.find((other) => other.epoch === 0 && other.prefixId === game.prefixId);
      return { size: game.size, seats: game.seats.length,
        delta: game.seats.reduce((sum, seat) => sum + game.outcome.shares[seat] - control.outcome.shares[seat], 0) / game.seats.length };
    });
    const mean = (items) => items.reduce((total, item) => total + item.delta, 0) / items.length;
    return { epoch, games: games.length, meanWinShareDelta: mean(deltas),
      singleAiDelta: mean(deltas.filter((x) => x.seats === 1)), dualAiDelta: mean(deltas.filter((x) => x.seats === 2)),
      validationLoss: candidates.get(epoch).validationLoss,
      perSize: Object.fromEntries(config.sizes.map((size) => [size, mean(deltas.filter((x) => x.size === size))])) };
  }).sort((a, b) => b.meanWinShareDelta - a.meanWinShareDelta || a.validationLoss - b.validationLoss || a.epoch - b.epoch);
  assert.deepEqual(model.training.development_summaries, summaries);
  const selected = candidates.get(summaries[0].epoch);
  for (const object of [checkpoint, model.training, receipt]) {
    assert.equal(object.selectedEpoch ?? object.selected_epoch, selected.epoch);
  }
  vectorClose(model.weights, selected.weights, "Delivered model weights");
  close(model.training.final_validation_cross_entropy, selected.validationLoss, "Selected validation loss");
  assert.equal(model.training.completed_development_games, devSpecs.length);
  assert.equal(progress.progress_units, episodeSpecs.length + config.optimizer.epochs + devSpecs.length);
  for (const [path, digest] of Object.entries(checkpoint.sources)) {
    assert.equal(hash(await readFile(resolve(root, path))), digest, `Source drift during verification: ${path}`);
  }
  assert.equal(hash(await readFile(modelPath)), hash(modelBytes), "Model drift during verification.");
  const report = {
    status: "PASS_INDEPENDENT_POSTTRAINING_REPLAY_AND_OPTIMIZER",
    identity, source_hashes: checkpoint.sources, config_sha256: hash(configBytes), parent_sha256: hash(parentBytes),
    model_sha256: hash(modelBytes), verifier_sha256: hash(await readFile(self)),
    episode_count: episodeSpecs.length, terminal_episodes: terminalEpisodes,
    truncated_generation_episodes: episodeSpecs.length - terminalEpisodes,
    replayed_episode_actions: episodeActions, feature_vectors_recomputed: featuresChecked,
    training_samples: training.length, validation_samples: validation.length, split_balance: splitBalance,
    episode_manifest_sha256: jsonHash(episodeManifest), optimizer_epochs_recomputed: optimizer.epoch,
    candidate_epochs_verified: config.candidateEpochs, selected_epoch_verified: selected.epoch,
    development_games_reconstructed: verifiedDevelopment.length,
    development_replay_manifest_sha256: jsonHash(verifiedDevelopment), development_summaries: summaries,
    teacher_recomputations: teacherChecks, elapsed_seconds: (Date.now() - started) / 1000,
    limits: [
      "All episode actions, legal masks, feature vectors, RNG/behavior choices, split balance and terminal discrete areas were replayed.",
      "Adam, cross-entropy, development policy replay, shared-win scoring and selection were recomputed independently of trainer helpers.",
      "Canonical GameEngine and feature extraction are shared, hash-checked application sources.",
      "Teacher targets were fully recomputed for one deterministic middle sample per size/start stratum; other stored labels were shape/normalization checked, not fully regenerated.",
      "Development verification does not establish independent playing strength; no final arena inputs were read.",
    ],
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, report: reportPath, model_sha256: report.model_sha256,
    episodes: report.episode_count, development_games: report.development_games_reconstructed,
    optimizer_epochs: report.optimizer_epochs_recomputed, elapsed_seconds: report.elapsed_seconds }, null, 2));
} catch (error) {
  console.error(`VERIFICATION_FAILED: ${error.stack ?? error.message}`);
  process.exitCode = 1;
}
