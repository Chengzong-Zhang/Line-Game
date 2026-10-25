// One supervised worker: completed source labels and parent updates are its
// durable units. A killed in-flight label is retried; completed units are read.
import { mkdir, readFile, readdir, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { passOpportunityDataMain } from "./pass-opportunity-data-v3.mjs";
import { passOpportunityTrainMain, WARMSTART_PARENTS } from "./train-pass-opportunity-v3.mjs";
import { passOpportunityVerifyMain } from "./verify-pass-opportunity-v3.mjs";
import { atomic, lease, readJson, root, sealed, sha, unseal } from "./neural-posttraining-data-v2.mjs";
import { validatePassOpportunityProtocol } from "./prepare-pass-opportunity-v3.mjs";

const check = (ok, message) => { if (!ok) throw new Error(message); };
export async function pipelineMain(args) {
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  check(option("--run-root", null), "Use --run-root PREPARED_DIRECTORY");
  const runRoot = resolve(option("--run-root")), dataRoot = resolve(runRoot, "data");
  const maxUnits = Number(option("--max-new-units", "1")), maxSeconds = Number(option("--max-seconds", "30"));
  check(Number.isInteger(maxUnits) && maxUnits >= 0 && Number.isFinite(maxSeconds) && maxSeconds > 0, "Invalid pipeline segment budget");
  await mkdir(runRoot, { recursive: true });
  const guard = await lease(resolve(runRoot, "pipeline-worker"));
  let identity = "initializing", cp, config;
  const save = async (status, extra = {}) => {
    if (cp) await atomic(resolve(runRoot, "checkpoint.json"), sealed(cp));
    await atomic(resolve(runRoot, "progress.json"), { identity, status, progress_units: cp?.units ?? 0,
      total_units: cp?.totalUnits ?? 0, completed_samples: cp?.completedSamples ?? 0,
      model_updates: cp?.modelUpdates ?? {}, verified_positions: cp?.verifiedPositions ?? {}, ...extra });
  };
  try {
    for (const name of await readdir(runRoot)) if (name.endsWith(".tmp"))
      await rename(resolve(runRoot, name), resolve(runRoot, `${name}.interrupted-${Date.now()}`));
    const configBytes = await readFile(resolve(runRoot, "protocol.json"));
    const inputBytes = await readFile(resolve(runRoot, "positions.json"));
    const frozen = await readJson(resolve(runRoot, "frozen-sources.json"));
    config = validatePassOpportunityProtocol(JSON.parse(configBytes));
    check(frozen.schema === "lifeline-pass-opportunity-frozen-v3", "Invalid frozen source identity");
    const checkSources = async () => {
      for (const [path, expected] of Object.entries(frozen.source_hashes))
        check(sha(await readFile(resolve(root, path))) === expected, `Frozen pipeline source/parent changed: ${path}`);
      check(sha(await readFile(resolve(runRoot, "protocol.json"))) === sha(configBytes)
        && sha(await readFile(resolve(runRoot, "positions.json"))) === sha(inputBytes), "Frozen pipeline configuration/input changed");
    };
    await checkSources();
    identity = sha(JSON.stringify({ sources: frozen.source_hashes, protocol: sha(configBytes), input: sha(inputBytes) }));
    const input = JSON.parse(inputBytes), verify = config.verification?.enabled !== false;
    const validationCounts = Object.fromEntries(config.parents.map(parent => [parent,
      input.filter(row => row.split === "validation" && WARMSTART_PARENTS[parent].counts.includes(row.state.playerCount)).length]));
    const totalUnits = input.length + config.parents.length * config.training.updates
      + (verify ? Object.values(validationCounts).reduce((sum, count) => sum + count, 0) : 0);
    const old = await readJson(resolve(runRoot, "checkpoint.json"), true);
    cp = old ? unseal(old) : { schema: "lifeline-pass-opportunity-pipeline-checkpoint-v3", identity,
      units: 0, completedSamples: 0, modelUpdates: {}, verifiedPositions: {}, totalUnits };
    check(cp.identity === identity && cp.totalUnits === totalUnits && Number.isInteger(cp.units) && cp.units >= 0,
      "Pipeline checkpoint identity/progress corruption");
    const refresh = async () => {
      const data = await readJson(resolve(dataRoot, "checkpoint.json"), true);
      let units = data ? unseal(data).units : 0;
      check(Number.isInteger(units) && units >= 0 && units <= input.length, "Data checkpoint counter corruption");
      cp.completedSamples = units;
      for (const parent of config.parents) {
        const raw = await readJson(resolve(runRoot, "models", parent, "checkpoint.json"), true);
        const step = raw ? unseal(raw).step : 0;
        check(Number.isInteger(step) && step >= 0 && step <= config.training.updates, "Warm-start update counter corruption");
        cp.modelUpdates[parent] = step; units += step;
        if (verify) {
          const verification = await readJson(resolve(runRoot, "verification", parent, "checkpoint.json"), true);
          const checked = verification ? unseal(verification).units : 0;
          check(Number.isInteger(checked) && checked >= 0 && checked <= validationCounts[parent], "Verification counter corruption");
          cp.verifiedPositions[parent] = checked; units += checked;
        }
      }
      check(units >= cp.units && units <= totalUnits, "Durable pipeline progress regressed");
      cp.units = units;
    };
    await refresh(); await save("RUNNING");
    const started = Date.now(), before = cp.units;
    const control = async () => {
      for (const [marker, status] of [["STOP", "STOPPED"], ["PAUSE", "PAUSED"]]) {
        try { await readFile(resolve(runRoot, marker)); await save(status); return 75; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      if (cp.units - before >= maxUnits || Date.now() - started >= maxSeconds * 1000) { await save("YIELDED"); return 75; }
      await checkSources(); return null;
    };
    // Re-enter even a completed child once: its canonical loader validates
    // all persisted source labels rather than trusting an index counter.
    while (true) {
      const halt = await control(); if (halt !== null) return halt;
      const code = await passOpportunityDataMain(["--input", resolve(runRoot, "positions.json"), "--run-root", dataRoot,
        "--max-new-units", String(maxUnits - (cp.units - before)), "--max-seconds", String(maxSeconds),
        "--max-nodes-per-label", String(config.labels.max_nodes_per_label), "--time-ms-per-label", String(config.labels.time_ms_per_label),
        ...(args.includes("--fault-after-sample-write") ? ["--fault-after-sample-write"] : [])]);
      await refresh(); await save("RUNNING");
      if (code === 79) return 79;
      if (code === 78) throw new Error("Defensive teacher rejected an incomplete label or corrupt evidence; depth is never reduced");
      if (code === 0) break;
      check(code === 75, `Unexpected data worker exit ${code}`);
      const state = await readJson(resolve(dataRoot, "progress.json"));
      if (["PAUSED", "STOPPED"].includes(state.status)) { await save(state.status); return 75; }
    }
    for (const parent of config.parents) while (true) {
      const halt = await control(); if (halt !== null) return halt;
      const code = await passOpportunityTrainMain(["--data-root", dataRoot, "--run-root", resolve(runRoot, "models", parent),
        "--parent", parent, "--updates", String(config.training.updates), "--learning-rate", String(config.training.learning_rate),
        "--max-new-units", String(maxUnits - (cp.units - before)), "--max-seconds", String(maxSeconds),
        ...(args.includes("--fault-after-checkpoint") ? ["--fault-after-checkpoint"] : [])]);
      await refresh(); await save("RUNNING");
      if (code === 79) return 79;
      check(code === 0 || code === 75, `Unexpected warm-start worker exit ${code}`);
      if (code === 0) break;
      const state = await readJson(resolve(runRoot, "models", parent, "progress.json"));
      if (["PAUSED", "STOPPED"].includes(state.status)) { await save(state.status); return 75; }
    }
    if (verify) for (const parent of config.parents) while (true) {
      const halt = await control(); if (halt !== null) return halt;
      const verifyRoot = resolve(runRoot, "verification", parent);
      const code = await passOpportunityVerifyMain(["--data-root", dataRoot,
        "--candidate", resolve(runRoot, "models", parent, "candidate.json"), "--run-root", verifyRoot,
        "--max-new-units", String(maxUnits - (cp.units - before)), "--max-seconds", String(maxSeconds)]);
      await refresh(); await save("RUNNING");
      check(code === 0 || code === 75, `Unexpected held-out verification exit ${code}`);
      if (code === 0) break;
      const state = await readJson(resolve(verifyRoot, "progress.json"));
      if (["PAUSED", "STOPPED"].includes(state.status)) { await save(state.status); return 75; }
    }
    await checkSources(); await refresh();
    check(cp.units === totalUnits, "Pipeline completed without every persisted unit");
    const candidates = Object.fromEntries(await Promise.all(config.parents.map(async parent => [parent,
      sha(await readFile(resolve(runRoot, "models", parent, "candidate.json")))])));
    const sourceCoverage = {};
    for (const row of input) {
      const key = `${row.state.playerCount}/${row.state.boardShape}/${row.state.gridSize}/${row.split}`;
      sourceCoverage[key] = (sourceCoverage[key] ?? 0) + 1;
    }
    await atomic(resolve(runRoot, "completion-receipt.json"), sealed({ schema: "lifeline-pass-opportunity-completion-v3",
      identity, status: "TRAINING_COMPLETE_STRENGTH_PENDING", completed_samples: cp.completedSamples,
      model_updates: cp.modelUpdates, heldout_positions_verified: cp.verifiedPositions, candidates, strength_verified: false, runtime_admitted: false,
      source_coverage_by_players_shape_size_split: sourceCoverage,
      neural_models_retrained: 0, source_hashes: frozen.source_hashes, protocol_sha256: sha(configBytes), input_sha256: sha(inputBytes) }));
    await save("COMPLETE"); return 0;
  } catch (error) {
    await save("FATAL", { error: error.message });
    throw error;
  } finally { await new Promise(done => guard.close(done)); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await pipelineMain(process.argv.slice(2)); }
  catch (error) { console.error(error.stack); process.exitCode = error.code === "EADDRINUSE" ? 76 : 78; }
}
