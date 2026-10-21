// Read-only independent reconstruction of reward posttraining. This verifier
// shares only the hash-bound rules/features, not the trainer's PPO/Adam code.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const self = fileURLToPath(import.meta.url), root = resolve(dirname(self), "../..");
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const runRoot = resolve(root, option("--run-root", "local_artifacts/three-player-ai-posttrain-v3-20261021"));
const configPath = resolve(root, option("--config", "web/tools/configs/three-player-policy-v3.json"));
const parentPath = resolve(root, option("--parent-model", "web/web前端/assets/research-ai/three-player-policy-v2.json"));
const baselinePath = resolve(root, option("--baseline-model", "web/web前端/assets/research-ai/three-player-policy-v1.json"));
const modelPath = resolve(root, option("--model", resolve(runRoot, "three-player-policy-v3.json")));
const reportPath = resolve(root, option("--output", resolve(runRoot, "training-independent-verification.json")));
const COLORS = ["BLACK", "WHITE", "PURPLE"];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const jsonHash = (value) => hash(JSON.stringify(value));
const seed = (text) => parseInt(hash(text).slice(0, 8), 16) >>> 0;
async function sealed(path) {
  const value = JSON.parse(await readFile(path, "utf8"));
  const { integrity, ...body } = value;
  assert.equal(integrity, jsonHash(body), `Invalid integrity: ${path}`);
  return value;
}
function close(actual, expected, label) {
  assert.ok(Number.isFinite(actual) && Number.isFinite(expected)
    && Math.abs(actual - expected) <= 2e-11 * Math.max(1, Math.abs(expected)), `${label}: ${actual} != ${expected}`);
}
function vectorClose(a, b, label) {
  assert.equal(a.length, b.length, `${label} length`);
  a.forEach((value, i) => close(value, b[i], `${label}/${i}`));
}
function probabilities(features, weights, temperature) {
  const logits = features.map((x) => x.reduce((sum, value, i) => sum + value * weights[i], 0) / temperature);
  const largest = Math.max(...logits), exponentials = logits.map((x) => Math.exp(x - largest));
  const total = exponentials.reduce((sum, x) => sum + x, 0);
  return exponentials.map((x) => x / total);
}
function rngFrom(initial) {
  let state = initial >>> 0;
  return { next() { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; },
    get state() { return state; } };
}
function policyChoice(candidates, weights) {
  return candidates.map((x) => ({ ...x, score: x.features.reduce((sum, value, i) => sum + value * weights[i], 0) }))
    .sort((a, b) => b.score - a.score || a.point[1] - b.point[1] || a.point[0] - b.point[0])[0].point;
}
function objective(samples, weights, cfg) {
  const gradient = weights.map(() => 0);
  const normalizer = samples.reduce((sum, x) => sum + x.weight, 0);
  let loss = 0, surrogate = 0, anchorKl = 0, clippedFraction = 0;
  for (const sample of samples) {
    const p = probabilities(sample.features, weights, cfg.temperature);
    const ratio = p[sample.action] / sample.oldProb, scaledWeight = sample.weight / normalizer;
    const capped = Math.max(1 - cfg.clip, Math.min(1 + cfg.clip, ratio));
    const rewardTerm = Math.min(ratio * sample.advantage, capped * sample.advantage);
    const clipped = (sample.advantage > 0 && ratio > 1 + cfg.clip)
      || (sample.advantage < 0 && ratio < 1 - cfg.clip);
    let divergence = 0;
    for (let a = 0; a < p.length; a++) if (sample.anchor[a] > 0)
      divergence += sample.anchor[a] * Math.log(sample.anchor[a] / Math.max(p[a], 1e-15));
    loss += scaledWeight * (cfg.anchorKl * divergence - rewardTerm);
    surrogate += scaledWeight * rewardTerm; anchorKl += scaledWeight * divergence;
    if (clipped) clippedFraction += scaledWeight;
    for (let i = 0; i < weights.length; i++) {
      let mean = 0, klGradient = 0;
      for (let a = 0; a < p.length; a++) {
        mean += p[a] * sample.features[a][i];
        klGradient += (p[a] - sample.anchor[a]) * sample.features[a][i];
      }
      gradient[i] += scaledWeight / cfg.temperature * (cfg.anchorKl * klGradient
        - (clipped ? 0 : sample.advantage * ratio * (sample.features[sample.action][i] - mean)));
    }
  }
  return { loss, gradient, surrogate, anchorKl, clippedFraction };
}
function updateAdam(state, gradient, cfg) {
  const multiplier = Math.min(1, cfg.maximumGradientNorm / Math.hypot(...gradient));
  state.step++;
  for (let i = 0; i < state.weights.length; i++) {
    const g = gradient[i] * multiplier;
    state.m[i] = cfg.beta1 * state.m[i] + (1 - cfg.beta1) * g;
    state.v[i] = cfg.beta2 * state.v[i] + (1 - cfg.beta2) * g * g;
    const correctedM = state.m[i] / (1 - cfg.beta1 ** state.step);
    const correctedV = state.v[i] / (1 - cfg.beta2 ** state.step);
    state.weights[i] -= cfg.learningRate * correctedM / (Math.sqrt(correctedV) + cfg.epsilon);
  }
}
function apply(engine, action) {
  assert.equal(engine.gameOver, false); assert.equal(action.player, engine.currentPlayer);
  if (action.point === null) {
    assert.equal(engine.getLegalMoves(engine.currentPlayer).length, 0); engine.skipTurn();
  } else assert.equal(engine.playMove(action.point).success, true);
}
function outcome(engine) {
  assert.equal(engine.gameOver, true);
  engine._isReplayingBatch = false;
  engine._updateTerritories();
  const scores = Object.fromEntries(COLORS.map((player) => [player, engine.cachedTerritories[player].area]));
  const survivors = COLORS.filter((player) => !engine.resignedPlayers.has(player));
  const maximum = Math.max(...survivors.map((player) => scores[player]));
  const leaders = survivors.filter((player) => scores[player] === maximum);
  return { scores, leaders, shares: Object.fromEntries(COLORS.map((p) => [p, leaders.includes(p) ? 1 / leaders.length : 0])) };
}

try {
  const started = Date.now();
  const [configBytes, parentBytes, baselineBytes, modelBytes, cp, receipt, progress] = await Promise.all([
    readFile(configPath), readFile(parentPath), readFile(baselinePath), readFile(modelPath),
    sealed(resolve(runRoot, "checkpoint.json")), sealed(resolve(runRoot, "training-receipt.json")),
    sealed(resolve(runRoot, "progress.json")),
  ]);
  const config = JSON.parse(configBytes), parent = JSON.parse(parentBytes), baseline = JSON.parse(baselineBytes);
  const model = JSON.parse(modelBytes);
  assert.equal(config.schema, "lifeline-three-player-reward-posttraining-v1");
  assert.equal(config.development.finalArenaAccess, false);
  assert.notEqual(config.seedNamespace, config.development.seedNamespace);
  assert.equal(progress.status, "COMPLETE"); assert.equal(cp.stage, "complete");
  assert.equal(cp.currentEpisode, null); assert.equal(cp.currentDevelopmentGame, null);
  assert.equal(cp.configHash, hash(configBytes)); assert.equal(cp.parentHash, hash(parentBytes));
  assert.equal(cp.baselineHash, hash(baselineBytes)); assert.equal(cp.outputSha256, hash(modelBytes));
  const sourcePaths = ["web/tools/finetune-three-player-v3.mjs", "web/tools/linear-three-v3-core.mjs",
    "web/tools/three-player-posttraining-core.mjs", "web/web前端/GameEngine.js", "web/web前端/AIEngine.js", "web/web前端/ThreePlayerAI.js"];
  assert.deepEqual(Object.keys(cp.sources), sourcePaths);
  for (const [path, digest] of Object.entries(cp.sources))
    assert.equal(hash(await readFile(resolve(root, path))), digest, `Source drift: ${path}`);
  const identity = jsonHash({ sources: cp.sources, configHash: hash(configBytes), parentHash: hash(parentBytes), baselineHash: hash(baselineBytes) });
  for (const object of [cp, receipt, progress]) assert.equal(object.identity, identity);
  assert.equal(receipt.status, "TRAINING-AND-DEVELOPMENT-COMPLETE");
  assert.equal(receipt.model_sha256, hash(modelBytes)); assert.deepEqual(receipt.training, model.training);
  assert.equal(receipt.config_sha256, hash(configBytes));
  assert.equal(receipt.parent_sha256, hash(parentBytes)); assert.equal(receipt.production_sha256, hash(baselineBytes));
  assert.deepEqual(receipt.source_hashes, cp.sources);
  assert.equal(receipt.independent_final_arena, "NOT-RUN");
  assert.deepEqual(model.schema, { name: "lifeline-three-player-policy", version: 1 });
  assert.equal(model.id, config.modelId); assert.equal(model.rules_version, "territory-v2");
  assert.deepEqual(model.lineage, { type: "weights-only-warm-start", parent_id: parent.id, parent_sha256: hash(parentBytes) });
  assert.equal(model.training.parent_model_sha256, hash(parentBytes));
  assert.equal(model.training.production_model_sha256, hash(baselineBytes));
  assert.equal(model.training.protocol_sha256, hash(configBytes));
  assert.deepEqual(model.training.source_hashes, cp.sources);
  const { GameEngine } = await import(pathToFileURL(resolve(root, "web/web前端/GameEngine.js")).href);
  const { threePlayerCandidates, THREE_PLAYER_FEATURES } = await import(pathToFileURL(resolve(root, "web/web前端/ThreePlayerAI.js")).href);
  assert.deepEqual(model.features, THREE_PLAYER_FEATURES);
  const engineFor = (spec) => {
    const engine = new GameEngine({ gridSize: spec.size, playerCount: 3, startPlayer: spec.start, rulesVersion: "territory-v2" });
    engine._isReplayingBatch = true; return engine;
  };
  const lineups = [...COLORS.map((color) => [color]), ...COLORS.map((color) => COLORS.filter((p) => p !== color))];
  const specs = [];
  for (let stage = 1; stage <= config.stages; stage++) for (const size of config.sizes) for (const start of config.starts) {
    const assignments = [...lineups, lineups[(stage - 1) % 3], lineups[3 + (stage - 1) % 3]];
    for (let index = 0; index < assignments.length; index++) {
      const id = `stage-${stage}-${size}-${start}-${index}`;
      specs.push({ id, stage, size, start, seats: assignments[index], ordinal: specs.length, seed: seed(`${config.seedNamespace}${id}`) });
    }
  }
  assert.deepEqual(cp.completedEpisodes.map((x) => x.id), specs.map((x) => x.id));
  assert.deepEqual(cp.candidates.map((x) => x.stage), Array.from({ length: config.stages }, (_, i) => i + 1));
  assert.deepEqual(cp.behaviorModels.map((x) => x.stage), cp.candidates.map((x) => x.stage));
  const optimizer = { step: 0, weights: [...parent.weights], m: parent.weights.map(() => 0), v: parent.weights.map(() => 0) };
  const candidates = new Map(), manifests = [], stageReports = [];
  let trainingActions = 0, allSampleCount = 0, featureRows = 0;
  for (let stage = 1; stage <= config.stages; stage++) {
    const behavior = cp.behaviorModels.find((x) => x.stage === stage);
    vectorClose(behavior.weights, optimizer.weights, `Stage ${stage} initial weights`);
    const training = [];
    for (const spec of specs.filter((x) => x.stage === stage)) {
      const unit = await sealed(resolve(runRoot, "episodes", `${spec.id}.json`));
      assert.equal(unit.integrity, cp.completedEpisodes[spec.ordinal].integrity);
      assert.equal(unit.identity, identity);
      for (const [key, value] of Object.entries(spec)) assert.deepEqual(unit[key], value);
      assert.equal(unit.terminal, true); assert.ok(unit.actions.length <= config.maximumEpisodePlies);
      const engine = engineFor(spec), rng = rngFrom(spec.seed);
      let sampleIndex = 0;
      for (const action of unit.actions) {
        const moves = threePlayerCandidates(engine), actor = engine.currentPlayer;
        if (!moves.length) assert.equal(action.point, null);
        else if (spec.seats.includes(actor)) {
          const sample = unit.samples[sampleIndex++];
          assert.ok(sample); assert.equal(sample.game, spec.id); assert.equal(sample.player, actor);
          for (const key of ["stage", "size", "start"]) assert.equal(sample[key], spec[key]);
          assert.equal(sample.features.length, moves.length);
          sample.features.forEach((features, index) => { vectorClose(features, moves[index].features, `${spec.id}/features`); featureRows++; });
          const p = probabilities(moves.map((x) => x.features), behavior.weights, config.ppo.temperature);
          vectorClose(sample.anchor, probabilities(moves.map((x) => x.features), parent.weights, config.ppo.temperature), "Parent anchor");
          const threshold = rng.next(); let cumulative = 0, selected = p.length - 1;
          for (let i = 0; i < p.length; i++) { cumulative += p[i]; if (threshold < cumulative) { selected = i; break; } }
          assert.equal(sample.action, selected); close(sample.oldProb, p[selected], "Behavior likelihood");
          assert.deepEqual(action.point, moves[selected].point);
        } else {
          const opponent = (spec.ordinal + COLORS.indexOf(actor)) % 2 === 0 ? baseline : parent;
          assert.deepEqual(action.point, policyChoice(moves, opponent.weights));
        }
        apply(engine, action);
      }
      assert.equal(sampleIndex, unit.samples.length); assert.equal(rng.state, unit.rngState);
      assert.deepEqual(unit.outcome, outcome(engine));
      for (const sample of unit.samples) training.push({ ...sample, advantage: unit.outcome.shares[sample.player] - 1 / 3,
        weight: 1 / unit.samples.filter((x) => x.player === sample.player).length });
      allSampleCount += unit.samples.length; trainingActions += unit.actions.length;
      manifests.push({ id: spec.id, integrity: unit.integrity, actions_sha256: jsonHash(unit.actions) });
    }
    for (let step = 0; step < config.optimizer.updatesPerStage; step++) updateAdam(optimizer, objective(training, optimizer.weights, config.ppo).gradient, config.optimizer);
    const candidate = await sealed(resolve(runRoot, "candidates", `stage-${stage}.json`));
    assert.equal(candidate.identity, identity); assert.equal(candidate.stage, stage);
    assert.equal(candidate.integrity, cp.candidates[stage - 1].integrity);
    assert.equal(candidate.samples, training.length);
    vectorClose(candidate.weights, optimizer.weights, `Candidate ${stage} weights`);
    const computed = objective(training, optimizer.weights, config.ppo);
    vectorClose(candidate.objective.gradient, computed.gradient, `Candidate ${stage} gradient`);
    for (const key of ["loss", "surrogate", "anchorKl", "clippedFraction"]) close(candidate.objective[key], computed[key], `Candidate ${stage}/${key}`);
    close(cp.candidates[stage - 1].anchorKl, computed.anchorKl, "Indexed KL");
    candidates.set(stage, candidate);
    stageReports.push({ stage, samples: training.length, objective: computed });
    console.log(`VERIFIED stage=${stage} cumulative_episodes=${manifests.length} optimizer_updates=${optimizer.step}`);
  }
  assert.equal(cp.optimizer.step, optimizer.step);
  for (const key of ["weights", "m", "v"]) vectorClose(cp.optimizer[key], optimizer[key], `Final Adam ${key}`);
  const devSpecs = [];
  for (const size of config.sizes) for (const start of config.starts) for (let replicate = 0; replicate < config.development.prefixReplicates; replicate++) {
    const prefixId = `${size}-${start}-${replicate}`, prefixSeed = seed(`${config.development.seedNamespace}${prefixId}`);
    devSpecs.push({ id: `baseline-${prefixId}`, size, start, prefixId, prefixSeed, stage: 0, seats: [] });
    for (let stage = 1; stage <= config.stages; stage++) for (const seats of lineups)
      devSpecs.push({ id: `${stage}-${prefixId}-${seats.join("-")}`, size, start, prefixId, prefixSeed, stage, seats });
  }
  assert.deepEqual(cp.developmentResults.map((x) => x.id), devSpecs.map((x) => x.id));
  let devActions = 0;
  for (const [index, spec] of devSpecs.entries()) {
    const saved = cp.developmentResults[index], engine = engineFor(spec), rng = rngFrom(spec.prefixSeed);
    for (const [key, value] of Object.entries(spec)) assert.deepEqual(saved[key], value);
    assert.ok(saved.actions.length <= config.development.maximumGamePlies);
    for (const [ply, action] of saved.actions.entries()) {
      const legal = engine.getLegalMoves(engine.currentPlayer);
      const point = !legal.length ? null : ply < config.development.prefixPlies
        ? legal[Math.floor(rng.next() * legal.length)].point
        : policyChoice(threePlayerCandidates(engine), spec.seats.includes(engine.currentPlayer) ? candidates.get(spec.stage).weights : baseline.weights);
      assert.deepEqual(action.point, point, `Development policy mismatch ${spec.id}/${ply}`);
      apply(engine, action);
    }
    assert.equal(saved.plies, saved.actions.length); assert.deepEqual(saved.outcome, outcome(engine));
    devActions += saved.actions.length;
    if ((index + 1) % 60 === 0) console.log(`VERIFIED development=${index + 1}/${devSpecs.length}`);
  }
  const mean = (values) => values.reduce((sum, x) => sum + x.delta, 0) / values.length;
  const summaries = [...candidates].map(([stage, candidate]) => {
    const games = cp.developmentResults.filter((x) => x.stage === stage);
    const deltas = games.map((game) => {
      const control = cp.developmentResults.find((x) => x.stage === 0 && x.prefixId === game.prefixId);
      return { size: game.size, seats: game.seats.length,
        delta: game.seats.reduce((sum, seat) => sum + game.outcome.shares[seat] - control.outcome.shares[seat], 0) / game.seats.length };
    });
    return { stage, games: games.length, meanWinShareDelta: mean(deltas), singleAiDelta: mean(deltas.filter((x) => x.seats === 1)),
      dualAiDelta: mean(deltas.filter((x) => x.seats === 2)), anchorKl: candidate.objective.anchorKl,
      perSize: Object.fromEntries(config.sizes.map((size) => [size, mean(deltas.filter((x) => x.size === size))])) };
  }).sort((a, b) => b.meanWinShareDelta - a.meanWinShareDelta || a.anchorKl - b.anchorKl || a.stage - b.stage);
  assert.deepEqual(model.training.development_summaries, summaries);
  assert.equal(cp.selectedStage, summaries[0].stage); assert.equal(model.training.selected_stage, cp.selectedStage);
  assert.equal(receipt.selected_stage, cp.selectedStage);
  assert.deepEqual(model.weights, candidates.get(cp.selectedStage).weights);
  assert.equal(model.training.posttraining_samples, allSampleCount);
  assert.equal(model.training.optimizer_updates, optimizer.step);
  assert.equal(model.training.completed_generation_episodes, specs.length);
  assert.equal(model.training.terminal_episodes, specs.length); assert.equal(model.training.truncated_episodes, 0);
  assert.equal(model.training.completed_development_games, devSpecs.length);
  for (const key of ["two_player_samples", "three_player_samples"]) assert.equal(model.training[key], parent.training[key]);
  const report = { status: "PASS-CURRENT", scope: "independent PPO/Adam reconstruction; all training and development policy actions and canonical terminal areas; selection; provenance",
    identity, model_sha256: hash(modelBytes), parent_sha256: hash(parentBytes), production_sha256: hash(baselineBytes),
    config_sha256: hash(configBytes), source_hashes: cp.sources, verifier_sha256: hash(await readFile(self)),
    command: [process.execPath, ...process.argv.slice(1)], exit_code: 0,
    episodes: specs.length, training_actions: trainingActions, samples: allSampleCount, feature_rows: featureRows,
    optimizer_updates: optimizer.step, development_games: devSpecs.length, development_actions: devActions,
    selected_stage: cp.selectedStage, stage_reports: stageReports, development_summaries: summaries,
    episode_manifest_sha256: jsonHash(manifests), elapsed_ms: Date.now() - started,
    limitations: "Shares canonical rule/feature source after hash checks; no claim of independent implementation of the game. Development selection is not final strength evidence." };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ status: report.status, episodes: specs.length, development_games: devSpecs.length, report: reportPath }));
} catch (error) {
  console.error(`VERIFICATION FAILED: ${error.stack ?? error.message}`);
  process.exitCode = 1;
}
