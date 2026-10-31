import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { atomic, exists, readChecked, canonical, sha256, seedFor } from "./three-player-arena-lib.mjs";
import { engineFor, apply, outcome, policy, rng } from "./hex-posttrain-core.mjs";
import { policyProbabilities, samplePolicy, ppoLossAndGradient, adamStep } from "./linear-three-v3-core.mjs";
import { readModel, validateProtocol, trainingSpecs, arenaSpecs, pairedRows, arenaSummary } from "./hex-distill-v3-final-protocol.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), args = process.argv.slice(2);
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const source = resolve(root, option("--run-root")), output = resolve(root, option("--output-root", resolve(source, "verification")));
const maxSeconds = Number(option("--max-seconds", "120")), started = Date.now();
const close = (a, b, label) => assert.ok(Math.abs(a - b) <= 1e-10, label);
let identity = null, state = null, lease = null, owns = false;
async function save(status, message = null) {
  await atomic(resolve(output, "checkpoint.json"), state);
  await atomic(resolve(output, "progress.json"), { identity, status, progress_units: state.checked.length, message });
}
try {
  const checkpoint = await readChecked(resolve(source, "checkpoint.json"));
  assert.equal(checkpoint.phase, "complete");
  const config = validateProtocol(checkpoint.config), parent = await readModel(checkpoint.parentPath, "hex-player-policy-v1");
  assert.equal(parent.hash, checkpoint.identityData.parent);
  for (const [file, hash] of Object.entries(checkpoint.identityData.sources)) assert.equal(sha256(await readFile(resolve(root, file))), hash, `Source drift: ${file}`);
  identity = sha256(canonical({ training: checkpoint.identity, verifier: sha256(await readFile(fileURLToPath(import.meta.url))) }));
  await mkdir(output, { recursive: true });
  lease = createServer((socket) => socket.destroy());
  await new Promise((accept, reject) => { lease.once("error", reject); lease.listen({ host: "127.0.0.1", port: 40000 + seedFor(output.toLowerCase()) % 20000, exclusive: true }, accept); });
  owns = true; lease.unref();
  state = { identity, checked: [] };
  if (await exists(resolve(output, "checkpoint.json"))) {
    state = await readChecked(resolve(output, "checkpoint.json"));
    assert.equal(state.identity, identity);
  }
  const isFinal = config.mode === "FINAL";
  const specs = isFinal ? arenaSpecs(config) : [...trainingSpecs(config), ...arenaSpecs(config, true)];
  assert.deepEqual(checkpoint.games.map((g) => g.id).sort(), specs.map((s) => s.id).sort());
  assert.equal(new Set(state.checked.map((x) => x.id)).size, state.checked.length);
  const models = new Map(), games = new Map();
  for (const entry of checkpoint.candidates) {
    const model = await readChecked(resolve(source, "candidates", `stage-${entry.stage}.json`));
    assert.equal(model.integrity, entry.integrity); models.set(entry.stage, model);
  }
  const candidate = isFinal ? await readModel(checkpoint.candidatePath, "hex-player-policy-v3") : null;
  if (candidate) assert.equal(candidate.hash, checkpoint.identityData.candidate);
  let status = "COMPLETE";
  for (const spec of specs) {
    const game = await readChecked(resolve(source, "games", `${spec.id}.json`));
    assert.equal(game.identity, checkpoint.identity);
    assert.equal(game.integrity, checkpoint.games.find((g) => g.id === spec.id).integrity);
    games.set(spec.id, game);
    const prior = state.checked.find((x) => x.id === spec.id);
    if (prior) { assert.equal(prior.gameIntegrity, game.integrity); continue; }
    if (await exists(resolve(output, "STOP"))) { status = "STOPPED"; break; }
    if (await exists(resolve(output, "PAUSE"))) { status = "PAUSED"; break; }
    if (Date.now() - started > maxSeconds * 1000) { status = "YIELDED"; break; }
    const engine = engineFor(spec), random = rng(spec.seed);
    const weights = spec.kind === "train" ? checkpoint.behaviors.find((b) => b.stage === spec.stage).weights
      : isFinal ? candidate.model.weights : models.get(spec.stage)?.weights ?? parent.model.weights;
    let sampleIndex = 0, policyDecisions = 0;
    for (let ply = 0; ply < game.actions.length; ply++) {
      const action = game.actions[ply], actor = engine.currentPlayer, legal = engine.getLegalMoves();
      let point = null;
      assert.equal(action.actor, actor);
      if (legal.length) {
        if (ply < config.prefixMoves) point = legal[Math.floor(random.next() * legal.length)].point;
        else if (spec.kind === "train" && spec.seats.includes(actor)) {
          const choices = policy(engine, weights).sort((a, b) => a.point[1] - b.point[1] || a.point[0] - b.point[0]);
          const features = choices.map((c) => c.features), probs = policyProbabilities(features, weights, config.ppo.temperature);
          const index = samplePolicy(probs, () => random.next()), sample = game.samples[sampleIndex++];
          assert.equal(sample.ply, ply); assert.equal(sample.actor, actor); assert.equal(sample.action, index);
          assert.deepEqual(sample.features, features);
          close(sample.oldProb, probs[index], "Old policy probability");
          const anchor = policyProbabilities(features, parent.model.weights, config.ppo.temperature);
          anchor.forEach((x, i) => close(x, sample.anchor[i], "Fixed anchor probability"));
          point = choices[index].point; policyDecisions++;
        } else {
          point = policy(engine, spec.seats.includes(actor) ? weights : parent.model.weights)[0].point;
          policyDecisions++;
        }
      }
      assert.deepEqual(action.point, point);
      apply(engine, action);
    }
    assert.equal(sampleIndex, game.samples.length);
    assert.equal(random.state, game.rngState);
    assert.equal(engine.gameOver, game.terminal);
    if (game.terminal) assert.deepEqual(outcome(engine), game.outcome, "Fresh discrete terminal area");
    else { assert.equal(game.outcome, null); assert.ok(game.actions.length >= config.maxActions || game.elapsedMs >= config.maxGameSeconds * 1000); }
    state.checked.push({ id: spec.id, gameIntegrity: game.integrity, actions: game.actions.length, policyDecisions, terminal: game.terminal });
    await save("RUNNING");
  }
  if (status !== "COMPLETE") { await save(status); process.exitCode = 75; }
  else {
    const summary = await readChecked(resolve(source, "summary.json"));
    assert.equal(summary.integrity, checkpoint.summaryIntegrity);
    if (isFinal) {
      const expected = arenaSummary(specs.map((s) => games.get(s.id)), config);
      for (const [key, value] of Object.entries(expected)) assert.deepEqual(summary[key], value, key);
    } else {
      const optimizer = { step: 0, weights: [...parent.model.weights], m: Array(16).fill(0), v: Array(16).fill(0) };
      for (let stage = 1; stage <= config.stages; stage++) {
        assert.deepEqual(optimizer.weights, checkpoint.behaviors.find((b) => b.stage === stage).weights);
        const training = trainingSpecs(config).filter((s) => s.stage === stage).flatMap((s) => {
          const game = games.get(s.id); assert.equal(game.terminal, true);
          return game.samples.map((sample) => ({ ...sample, advantage: game.outcome.shares[sample.actor] - 1 / s.players,
            weight: 1 / game.samples.filter((x) => x.actor === sample.actor).length }));
        });
        for (let i = 0; i < config.optimizer.updatesPerStage; i++) {
          const objective = ppoLossAndGradient(training, optimizer.weights, config.ppo);
          adamStep(optimizer, objective.gradient, config.optimizer);
        }
        assert.deepEqual(optimizer.weights, models.get(stage).weights, "PPO/Adam reproducibility");
      }
      assert.deepEqual(optimizer, checkpoint.optimizer);
      const dev = arenaSpecs(config, true).map((s) => games.get(s.id));
      assert.ok(dev.every((g) => g.terminal));
      const scores = [...models.values()].map((m) => {
        const rows = pairedRows(dev, m.stage);
        return { stage: m.stage, meanDelta: rows.reduce((sum, r) => sum + r.delta, 0) / rows.length, anchorKl: m.objective.anchorKl };
      }).sort((a, b) => b.meanDelta - a.meanDelta || a.anchorKl - b.anchorKl || a.stage - b.stage);
      assert.deepEqual(scores, summary.scores); assert.equal(scores[0].stage, checkpoint.selectedStage);
      const exported = await readModel(resolve(source, "hex-player-policy-v3.json"), "hex-player-policy-v3");
      assert.equal(exported.hash, checkpoint.outputHash);
      assert.deepEqual(exported.model.weights, models.get(checkpoint.selectedStage).weights);
      assert.equal(exported.model.lineage.training_identity, checkpoint.identity);
    }
    const report = { status: "PASS", identity, sourceIdentity: checkpoint.identity, games: state.checked.length,
      actions: state.checked.reduce((sum, r) => sum + r.actions, 0),
      policyDecisions: state.checked.reduce((sum, r) => sum + r.policyDecisions, 0),
      terminal: state.checked.filter((r) => r.terminal).length,
      scope: "full-history replay; legal deterministic and seeded actions; terminal discrete area; PPO/Adam replay; immutable model; paired summary" };
    await atomic(resolve(output, "report.json"), report); await save("COMPLETE");
    console.log(JSON.stringify(report)); process.exitCode = 0;
  }
} catch (error) {
  console.error(error.stack ?? error);
  if (owns && state) await save("FATAL", error.message);
  process.exitCode = 78;
} finally { if (lease?.listening) await new Promise((done) => lease.close(done)); }
