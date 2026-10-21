import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { atomic, exists, readChecked, canonical, sha256, seedFor } from "./three-player-arena-lib.mjs";
import { engineFor, apply, policy, outcome, rng } from "./hex-posttrain-core.mjs";
import { readModel, arenaSpecs, pairedRows } from "./hex-posttrain-protocol.mjs";
import { adamStep } from "./linear-three-v3-core.mjs";
import { validateTraining, trajectories, example, objective } from "./hex-distill-v3-core.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const source = resolve(root, option("--run-root")), output = resolve(root, option("--output-root"));
const maxSeconds = Number(option("--max-seconds", "120")), started = Date.now();
let state, identity, lease, owns = false;
async function save(status, message = null) {
  await atomic(resolve(output, "checkpoint.json"), state);
  await atomic(resolve(output, "progress.json"), { identity, status, progress_units: state.checked.length, message });
}
async function control() {
  if (await exists(resolve(output, "STOP"))) return "STOPPED";
  if (await exists(resolve(output, "PAUSE"))) return "PAUSED";
  return Date.now() - started > maxSeconds * 1000 ? "YIELDED" : null;
}
try {
  const checkpoint = await readChecked(resolve(source, "checkpoint.json")); assert.equal(checkpoint.phase, "complete");
  const config = validateTraining(checkpoint.config), parent = await readModel(checkpoint.parentPath, "hex-player-policy-v1");
  assert.equal(parent.hash, checkpoint.identityData.parent);
  for (const [file, hash] of Object.entries(checkpoint.identityData.sources)) assert.equal(sha256(await readFile(resolve(root, file))), hash);
  identity = sha256(canonical({ training: checkpoint.identity, verifier: sha256(await readFile(fileURLToPath(import.meta.url))) }));
  await mkdir(output, { recursive: true }); lease = createServer((socket) => socket.destroy());
  await new Promise((done, fail) => { lease.once("error", fail); lease.listen({ host: "127.0.0.1", port: 40000 + seedFor(output.toLowerCase()) % 20000, exclusive: true }, done); });
  owns = true; lease.unref(); state = { identity, checked: [] };
  if (await exists(resolve(output, "checkpoint.json"))) state = await readChecked(resolve(output, "checkpoint.json"));
  assert.equal(state.identity, identity); assert.equal(new Set(state.checked.map((x) => x.id)).size, state.checked.length);
  const specs = trajectories(config), devSpecs = arenaSpecs({ ...config, sizes: [5], stages: config.checkpoints.length }, true);
  assert.deepEqual(checkpoint.trajectories.map((x) => x.id), specs.map((x) => x.id));
  assert.deepEqual(checkpoint.games.map((x) => x.id), devSpecs.map((x) => x.id));
  const samples = [], models = new Map(), games = new Map(), paths = new Map();
  for (const [entries, folder, sink] of [[checkpoint.trajectories, "trajectories", paths], [checkpoint.samples, "samples", samples],
    [checkpoint.candidates, "candidates", models], [checkpoint.games, "games", games]]) {
    assert.equal(new Set(entries.map((x) => x.id)).size, entries.length);
    for (const entry of entries) {
      const record = await readChecked(resolve(source, folder, `${entry.id}.json`));
      assert.equal(record.identity, checkpoint.identity); assert.equal(record.integrity, entry.integrity);
      if (Array.isArray(sink)) sink.push(record); else sink.set(entry.id, record);
    }
  }
  const tasks = [...specs.map((spec) => ({ type: "trajectory", spec, record: paths.get(spec.id) })),
    ...samples.map((record) => ({ type: "sample", spec: record, record })),
    ...devSpecs.map((spec) => ({ type: "game", spec, record: games.get(spec.id) }))];
  let status = "COMPLETE";
  for (const task of tasks) {
    const { spec, record, type } = task, id = `${type}/${record.id}`;
    const prior = state.checked.find((x) => x.id === id);
    if (prior) { assert.equal(prior.recordIntegrity, record.integrity); continue; }
    const requested = await control(); if (requested) { status = requested; break; }
    let decisions = 0;
    if (type === "sample") {
      const trajectory = paths.get(`n${spec.size}-p${spec.players}-${spec.start}`);
      assert.deepEqual(record.actions, trajectory.actions.slice(0, record.actions.length));
      assert.ok(config.samplePlies.includes(record.actions.length));
      const sourceSpec = specs.find((x) => x.id === trajectory.id), engine = engineFor(sourceSpec, record.actions);
      const expected = example(engine, sourceSpec, record.actions, parent.model.weights, config);
      for (const [key, value] of Object.entries(expected)) assert.deepEqual(record[key], value, `Teacher ${key}`);
    } else {
      const engine = engineFor(spec), random = rng(spec.seed), prefix = type === "trajectory" ? config.prefixMoves : 4;
      for (let ply = 0; ply < record.actions.length; ply++) {
        const action = record.actions[ply], legal = engine.getLegalMoves();
        assert.equal(action.actor, engine.currentPlayer);
        const weights = type === "trajectory" || !spec.seats.includes(engine.currentPlayer) ? parent.model.weights : models.get(`stage-${spec.stage}`).weights;
        const point = ply < prefix ? legal[Math.floor(random.next() * legal.length)]?.point ?? null : policy(engine, weights)[0]?.point ?? null;
        assert.deepEqual(action.point, point); apply(engine, action); if (ply >= prefix && legal.length) decisions++;
      }
      assert.equal(record.rngState, random.state); assert.equal(record.terminal, engine.gameOver);
      if (type === "game") { assert.equal(engine.gameOver, true); assert.deepEqual(record.outcome, outcome(engine)); }
      else {
        assert.ok(record.terminal || record.actions.length === Math.max(...config.samplePlies));
        for (const ply of config.samplePlies) {
          const stateAtPly = ply <= record.actions.length ? engineFor(spec, record.actions.slice(0, ply)) : null;
          const expected = stateAtPly && !stateAtPly.gameOver;
          assert.equal(samples.some((s) => s.id === `${spec.id}-ply${ply}`), Boolean(expected));
        }
      }
    }
    state.checked.push({ id, recordIntegrity: record.integrity, actions: type === "sample" ? 0 : record.actions.length, policyDecisions: decisions });
    await save("RUNNING");
  }
  if (status !== "COMPLETE") { await save(status); process.exitCode = 75; }
  else {
    const optimizer = { step: 0, weights: [...parent.model.weights], m: Array(16).fill(0), v: Array(16).fill(0) };
    for (const [index, step] of config.checkpoints.entries()) {
      while (optimizer.step < step) adamStep(optimizer, objective(samples, optimizer.weights, config.anchorKl).gradient, config.optimizer);
      const model = models.get(`stage-${index + 1}`); assert.deepEqual(model.weights, optimizer.weights);
      assert.deepEqual(model.objective, objective(samples, optimizer.weights, config.anchorKl));
    }
    assert.deepEqual(optimizer, checkpoint.optimizer);
    const scores = [...models.values()].map((m) => {
      const rows = pairedRows([...games.values()], m.stage);
      return { stage: m.stage, meanDelta: rows.reduce((s, r) => s + r.delta, 0) / rows.length, anchorKl: m.objective.anchorKl };
    }).sort((a, b) => b.meanDelta - a.meanDelta || a.anchorKl - b.anchorKl || a.stage - b.stage);
    const summary = await readChecked(resolve(source, "summary.json")); assert.equal(summary.integrity, checkpoint.summaryIntegrity);
    assert.deepEqual(summary.scores, scores); assert.equal(scores[0].stage, checkpoint.selectedStage);
    const exported = await readModel(resolve(source, "hex-player-policy-v3.json"), "hex-player-policy-v3");
    assert.equal(exported.hash, checkpoint.outputHash); assert.deepEqual(exported.model.weights, models.get(`stage-${checkpoint.selectedStage}`).weights);
    assert.equal(exported.model.lineage.training_identity, checkpoint.identity);
    const report = { status: "PASS", identity, sourceIdentity: checkpoint.identity, trajectories: paths.size, samples: samples.length,
      developmentGames: games.size, terminalDevelopmentGames: games.size, optimizerSteps: optimizer.step,
      actions: state.checked.reduce((s, x) => s + x.actions, 0), policyDecisions: state.checked.reduce((s, x) => s + x.policyDecisions, 0),
      scope: "Full-history source trajectories, every one-round teacher label, KL gradient/Adam replay, deterministic development policy, true area, selection/export" };
    await atomic(resolve(output, "report.json"), report); await save("COMPLETE"); console.log(JSON.stringify(report)); process.exitCode = 0;
  }
} catch (error) {
  console.error(error.stack ?? error); if (owns && state) await save("FATAL", error.message); process.exitCode = 78;
} finally { if (lease?.listening) await new Promise((done) => lease.close(done)); }
