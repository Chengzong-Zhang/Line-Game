import assert from "node:assert/strict";
import { readFile, mkdir, readdir, rename } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { atomic, exists, readChecked, canonical, sha256, seedFor } from "./three-player-arena-lib.mjs";
import { engineFor, apply, policy, outcome, rng } from "./hex-posttrain-core.mjs";
import { readModel, rawAtomic, sealModel, modelBody, arenaSpecs, pairedRows } from "./hex-posttrain-protocol.mjs";
import { adamStep } from "./linear-three-v3-core.mjs";
import { TRAIN_SOURCES, validateTraining, trajectories, example, objective } from "./hex-distill-v3-core.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const runRoot = resolve(root, option("--run-root", "local_artifacts/hex-player-distill-v3/train-20261021-r1"));
const configPath = resolve(root, "web/tools/configs/hex-player-policy-v3-train.json");
const parentPath = resolve(root, "web/web前端/assets/research-ai/hex-player-policy-v1.json");
const maxSeconds = Number(option("--max-seconds", "120")), maxUnits = Number(option("--max-new-units", "1000000"));
const fault = option("--fault", ""), started = Date.now();
let state, identity, lease, owns = false, units = 0;
class Controlled extends Error { constructor(status) { super(status); this.status = status; } }
async function progress(status, message = null) {
  await atomic(resolve(runRoot, "progress.json"), { identity, status, progress_units: state?.progressUnits ?? 0,
    phase: state?.phase ?? "initializing", samples: state?.samples.length ?? 0, trajectories: state?.trajectories.length ?? 0,
    updates: state?.optimizer.step ?? 0, games: state?.games.length ?? 0, current_actions: state?.current?.actions.length ?? 0, message });
}
async function save(status = "RUNNING") { await atomic(resolve(runRoot, "checkpoint.json"), state); await progress(status); }
async function control() {
  if (await exists(resolve(runRoot, "STOP"))) throw new Controlled("STOPPED");
  if (await exists(resolve(runRoot, "PAUSE"))) throw new Controlled("PAUSED");
  if (Date.now() - started >= maxSeconds * 1000 || units >= maxUnits) throw new Controlled("YIELDED");
}
async function advance(kind) { state.progressUnits++; units++; await save(); if (fault === `after-${kind}`) process.exit(91); }
async function frozen(path, value, commitFault = "") {
  if (await exists(path)) {
    const { integrity, ...stored } = await readChecked(path);
    assert.deepEqual(stored, value, `Orphan mismatch: ${path}`);
  } else await atomic(path, value);
  if (fault === commitFault) process.exit(92);
  return readChecked(path);
}
async function quarantine(directory) {
  for (const name of await readdir(directory)) if (/\.tmp-\d+$/.test(name)) {
    await mkdir(resolve(runRoot, "interrupted"), { recursive: true });
    await rename(resolve(directory, name), resolve(runRoot, "interrupted", `${Date.now()}-${name}`));
  }
}
try {
  if (!(maxSeconds > 0 && maxSeconds <= 1800 && maxUnits >= 0 && Number.isInteger(maxUnits))) throw new Error("Invalid budget");
  const configBytes = await readFile(configPath), config = validateTraining(JSON.parse(configBytes));
  const parent = await readModel(parentPath, "hex-player-policy-v1");
  const sources = Object.fromEntries(await Promise.all(TRAIN_SOURCES.map(async (path) => [path, sha256(await readFile(resolve(root, path)))])));
  const identityData = { schema: "lifeline-hex-distillation-v3-identity", config: sha256(configBytes), sources, parent: parent.hash };
  identity = sha256(canonical(identityData));
  await mkdir(runRoot, { recursive: true });
  for (const folder of ["samples", "candidates", "games", "trajectories"]) await mkdir(resolve(runRoot, folder), { recursive: true });
  lease = createServer((socket) => socket.destroy());
  const port = 40000 + seedFor(runRoot.toLowerCase()) % 20000;
  await new Promise((accept, reject) => { lease.once("error", reject); lease.listen({ host: "127.0.0.1", port, exclusive: true }, accept); });
  owns = true; lease.unref();
  await atomic(resolve(runRoot, "worker.json"), { identity, pid: process.pid, port });
  for (const folder of ["", "samples", "candidates", "games", "trajectories"]) await quarantine(resolve(runRoot, folder));
  state = { schema: "lifeline-hex-distillation-v3-checkpoint", identity, identityData, config, parentPath,
    phase: "dataset", progressUnits: 0, samples: [], trajectories: [], candidates: [], games: [], current: null,
    optimizer: { step: 0, weights: [...parent.model.weights], m: Array(16).fill(0), v: Array(16).fill(0) } };
  if (await exists(resolve(runRoot, "checkpoint.json"))) state = await readChecked(resolve(runRoot, "checkpoint.json"));
  assert.equal(state.identity, identity, "Source/config/parent drift");
  if (option("--test-hold-ms", null)) await new Promise((done) => setTimeout(done, Math.min(10000, Number(option("--test-hold-ms")))));
  const samples = [], models = new Map(), games = new Map(), paths = new Map();
  for (const [entries, directory, sink] of [[state.samples, "samples", samples], [state.candidates, "candidates", models], [state.games, "games", games], [state.trajectories, "trajectories", paths]]) {
    assert.equal(new Set(entries.map((x) => x.id)).size, entries.length);
    for (const entry of entries) {
      const value = await readChecked(resolve(runRoot, directory, `${entry.id}.json`));
      assert.equal(value.identity, identity); assert.equal(value.integrity, entry.integrity);
      if (Array.isArray(sink)) sink.push(value); else sink.set(entry.id, value);
    }
  }
  if (state.phase === "complete") {
    assert.equal((await readChecked(resolve(runRoot, "summary.json"))).integrity, state.summaryIntegrity);
    assert.equal(sha256(await readFile(resolve(runRoot, "hex-player-policy-v3.json"))), state.outputHash);
    await progress("COMPLETE"); process.exitCode = 0;
  } else {
    for (const spec of trajectories(config)) {
      if (paths.has(spec.id)) continue;
      await control();
      if (state.current && state.current.id !== spec.id) throw new Error("Trajectory order mismatch");
      state.current ??= { id: spec.id, actions: [], rngState: spec.seed }; await save();
      const current = state.current, engine = engineFor(spec, current.actions), random = rng(current.rngState);
      while (true) {
        await control();
        const sampleId = `${spec.id}-ply${current.actions.length}`;
        if (config.samplePlies.includes(current.actions.length) && !state.samples.some((s) => s.id === sampleId) && !engine.gameOver) {
          const value = { identity, ...example(engine, spec, current.actions, parent.model.weights, config) };
          const stored = await frozen(resolve(runRoot, "samples", `${sampleId}.json`), value, "after-sample-commit");
          samples.push(stored); state.samples.push({ id: sampleId, integrity: stored.integrity }); await advance("sample");
        }
        if (engine.gameOver || current.actions.length >= Math.max(...config.samplePlies)) break;
        const legal = engine.getLegalMoves();
        const point = current.actions.length < config.prefixMoves ? legal[Math.floor(random.next() * legal.length)]?.point ?? null
          : policy(engine, parent.model.weights)[0]?.point ?? null;
        const action = { actor: engine.currentPlayer, point };
        apply(engine, action); current.actions.push(action); current.rngState = random.state; await advance("action");
      }
      const trajectory = await frozen(resolve(runRoot, "trajectories", `${spec.id}.json`),
        { identity, ...spec, ...current, terminal: engine.gameOver }, "after-trajectory-commit");
      paths.set(spec.id, trajectory); state.trajectories.push({ id: spec.id, integrity: trajectory.integrity });
      state.current = null; await advance("trajectory");
    }
    state.phase = "optimization";
    for (const [index, checkpoint] of config.checkpoints.entries()) {
      while (state.optimizer.step < checkpoint) {
        await control(); adamStep(state.optimizer, objective(samples, state.optimizer.weights, config.anchorKl).gradient, config.optimizer); await advance("update");
      }
      const id = `stage-${index + 1}`;
      if (!models.has(id)) {
        const value = { identity, id, stage: index + 1, step: state.optimizer.step, weights: [...state.optimizer.weights],
          objective: objective(samples, state.optimizer.weights, config.anchorKl), samples: samples.length };
        const stored = await frozen(resolve(runRoot, "candidates", `${id}.json`), value, "after-candidate-commit");
        models.set(id, stored); state.candidates.push({ id, integrity: stored.integrity }); await advance("candidate");
      }
    }
    state.phase = "development";
    const devConfig = { ...config, sizes: [5], stages: config.checkpoints.length, prefixMoves: 4 };
    const specs = arenaSpecs(devConfig, true);
    for (const spec of specs) {
      if (games.has(spec.id)) continue;
      await control();
      if (state.current && state.current.id !== spec.id) throw new Error("Development order mismatch");
      state.current ??= { id: spec.id, actions: [], rngState: spec.seed, elapsedMs: 0 }; await save();
      const current = state.current, engine = engineFor(spec, current.actions), random = rng(current.rngState);
      const resumedAt = Date.now(), elapsed = current.elapsedMs;
      const path = resolve(runRoot, "games", `${spec.id}.json`);
      if (!(await exists(path))) {
        while (!engine.gameOver && current.actions.length < config.maxActions && current.elapsedMs < config.maxGameSeconds * 1000) {
          await control(); const legal = engine.getLegalMoves();
          const weights = spec.seats.includes(engine.currentPlayer) ? models.get(`stage-${spec.stage}`).weights : parent.model.weights;
          const point = current.actions.length < 4 ? legal[Math.floor(random.next() * legal.length)]?.point ?? null : policy(engine, weights)[0]?.point ?? null;
          const action = { actor: engine.currentPlayer, point }; apply(engine, action);
          current.actions.push(action); current.rngState = random.state; current.elapsedMs = elapsed + Date.now() - resumedAt; await advance("dev-action");
        }
      }
      if (!engine.gameOver) throw new Error("Development did not reach a true terminal state");
      const value = { identity, ...spec, ...current, terminal: true, outcome: outcome(engine) };
      const stored = await frozen(path, value, "after-game-commit");
      games.set(spec.id, stored); state.games.push({ id: spec.id, integrity: stored.integrity }); state.current = null; await advance("game");
    }
    const scores = [...models.values()].map((model) => {
      const rows = pairedRows([...games.values()], model.stage);
      return { stage: model.stage, meanDelta: rows.reduce((sum, r) => sum + r.delta, 0) / rows.length, anchorKl: model.objective.anchorKl };
    }).sort((a, b) => b.meanDelta - a.meanDelta || a.anchorKl - b.anchorKl || a.stage - b.stage);
    state.selectedStage = scores[0].stage;
    const output = sealModel({ ...modelBody(parent.model), id: config.modelId, weights: models.get(`stage-${state.selectedStage}`).weights,
      lineage: { parent_id: parent.model.id, parent_sha256: parent.hash, training_identity: identity },
      training: { method: "one-round real-response teacher distillation; fixed-v1 KL anchor", source_trajectories: state.trajectories.length,
        samples: samples.length, sizes: config.sizes, player_counts: config.counts, optimizer_steps: state.optimizer.step,
        selected_stage: state.selectedStage, development_games: games.size, independent_final_required: true },
      release: { status: "CANDIDATE_NOT_PROMOTED", default: false } });
    const outputPath = resolve(runRoot, "hex-player-policy-v3.json");
    if (await exists(outputPath)) assert.deepEqual(JSON.parse(await readFile(outputPath)), output); else await rawAtomic(outputPath, output);
    state.outputHash = sha256(await readFile(outputPath));
    await atomic(resolve(runRoot, "summary.json"), { identity, status: "COMPLETE", samples: samples.length, trajectories: state.trajectories.length,
      developmentGames: games.size, optimizerSteps: state.optimizer.step, scores, selectedStage: state.selectedStage,
      outputSha256: state.outputHash, promotion: "REQUIRES_INDEPENDENT_FINAL" });
    state.summaryIntegrity = (await readChecked(resolve(runRoot, "summary.json"))).integrity;
    state.phase = "complete"; await save("COMPLETE"); process.exitCode = 0;
  }
} catch (error) {
  if (error instanceof Controlled) { if (owns && state) await save(error.status); process.exitCode = 75; }
  else { console.error(error.stack ?? error); if (owns && identity) await progress("FATAL", error.message); process.exitCode = 78; }
} finally { if (lease?.listening) await new Promise((done) => lease.close(done)); }
