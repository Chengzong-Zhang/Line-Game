import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, mkdir, cp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { atomic, readChecked, exists } from "../../tools/three-player-arena-lib.mjs";
import { objective, trajectories } from "../../tools/hex-distill-v3-core.mjs";
const root = process.cwd(), base = resolve(root, `local_artifacts/hex-player-distill-v3/recovery-${Date.now()}`);
const worker = resolve(root, "web/tools/run-hex-distillation-v3.mjs");
await mkdir(base, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function start(directory, args = []) {
  const child = spawn(process.execPath, [worker, "--run-root", directory, "--max-seconds", "40", ...args], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; child.stdout.resume(); child.stderr.on("data", (x) => { stderr += x; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
  const done = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stderr }); }); });
  return { child, done };
}
async function run(directory, args, code) { const result = await start(directory, args).done; assert.equal(result.code, code, result.stderr); return result; }
function scientific(value) { const result = structuredClone(value); delete result.integrity; return result; }

const interrupted = resolve(base, "action-interrupted"), clean = resolve(base, "action-clean");
await run(interrupted, ["--fault", "after-action"], 91);
await run(interrupted, ["--max-new-units", "1"], 75); await run(clean, ["--max-new-units", "2"], 75);
assert.deepEqual(scientific(await readChecked(resolve(interrupted, "checkpoint.json"))), scientific(await readChecked(resolve(clean, "checkpoint.json"))));

const orphan = resolve(base, "sample-orphan"), sampleClean = resolve(base, "sample-clean");
await run(orphan, ["--fault", "after-sample-commit"], 92);
assert.equal((await readChecked(resolve(orphan, "checkpoint.json"))).samples.length, 0);
await run(orphan, ["--max-new-units", "2"], 75); await run(sampleClean, ["--max-new-units", "14"], 75);
assert.deepEqual(scientific(await readChecked(resolve(orphan, "checkpoint.json"))), scientific(await readChecked(resolve(sampleClean, "checkpoint.json"))));
const checkpoint = await readChecked(resolve(orphan, "checkpoint.json"));
const samples = await Promise.all(checkpoint.samples.map((x) => readChecked(resolve(orphan, "samples", `${x.id}.json`))));
const weights = [...checkpoint.optimizer.weights], result = objective(samples, weights, checkpoint.config.anchorKl), epsilon = 1e-5;
for (let i = 0; i < weights.length; i++) {
  const plus = [...weights], minus = [...weights]; plus[i] += epsilon; minus[i] -= epsilon;
  const finite = (objective(samples, plus, checkpoint.config.anchorKl).loss - objective(samples, minus, checkpoint.config.anchorKl).loss) / (2 * epsilon);
  assert.ok(Math.abs(result.gradient[i] - finite) < 1e-7, `Gradient ${i}`);
}

// Synthetic bookkeeping bypasses data collection only for a two-update
// optimizer persistence test. These roots cannot pass the scientific verifier.
const optimizerFixture = resolve(base, "optimizer-fixture"); await cp(orphan, optimizerFixture, { recursive: true });
await mkdir(resolve(optimizerFixture, "trajectories"), { recursive: true });
checkpoint.trajectories = []; checkpoint.current = null; checkpoint.recoveryFixture = true;
for (const spec of trajectories(checkpoint.config)) {
  const path = resolve(optimizerFixture, "trajectories", `${spec.id}.json`);
  await atomic(path, { identity: checkpoint.identity, ...spec, actions: [], rngState: spec.seed, terminal: false });
  checkpoint.trajectories.push({ id: spec.id, integrity: (await readChecked(path)).integrity });
}
await atomic(resolve(optimizerFixture, "checkpoint.json"), checkpoint);
const optimizerClean = resolve(base, "optimizer-clean"); await cp(optimizerFixture, optimizerClean, { recursive: true });
await run(optimizerFixture, ["--fault", "after-update"], 91); await run(optimizerFixture, ["--max-new-units", "1"], 75);
await run(optimizerClean, ["--max-new-units", "2"], 75);
assert.deepEqual(scientific(await readChecked(resolve(optimizerFixture, "checkpoint.json"))), scientific(await readChecked(resolve(optimizerClean, "checkpoint.json"))));
assert.equal((await readChecked(resolve(optimizerFixture, "checkpoint.json"))).optimizer.step, 2);

const paused = resolve(base, "pause-stop"); await mkdir(paused); await writeFile(resolve(paused, "PAUSE"), "requested");
await run(paused, [], 75); assert.equal((await readChecked(resolve(paused, "progress.json"))).status, "PAUSED");
await writeFile(resolve(paused, "STOP"), "requested"); await run(paused, [], 75);
assert.equal((await readChecked(resolve(paused, "progress.json"))).status, "STOPPED");

const duplicate = resolve(base, "duplicate"), first = start(duplicate, ["--test-hold-ms", "1200", "--max-new-units", "1"]);
for (let i = 0; i < 100 && !(await exists(resolve(duplicate, "worker.json"))); i++) await sleep(20);
await run(duplicate, ["--max-new-units", "1"], 78); assert.equal((await first.done).code, 75);

const corrupt = resolve(base, "corrupt"); await cp(clean, corrupt, { recursive: true });
const bad = JSON.parse(await readFile(resolve(corrupt, "checkpoint.json"))); bad.optimizer.weights[0] += 1;
await writeFile(resolve(corrupt, "checkpoint.json"), JSON.stringify(bad)); await run(corrupt, [], 78);
const report = { status: "PASS", root: base, actionResume: true, orphanSampleAdoption: true, gradientFiniteDifference: true,
  adamResume: true, pauseStop: true, duplicateRejected: true, corruptCheckpointRejected: true,
  fixtureBoundary: "Optimizer test alone uses synthetic trajectory bookkeeping; no training or strength result is claimed",
  command: "node web/web前端/tests/verify-hex-distillation-v3-recovery.mjs" };
await atomic(resolve(base, "report.json"), report); console.log(JSON.stringify(report));
