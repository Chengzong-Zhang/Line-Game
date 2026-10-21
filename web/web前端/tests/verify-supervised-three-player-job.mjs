import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const supervisor = resolve(root, "web/tools/supervise-three-player-job.mjs");
const fixture = resolve(root, "web/web前端/tests/fixtures/supervised-job-worker.mjs");
const base = resolve(root, `local_artifacts/three-player-supervisor-recovery-${Date.now()}`);
const rows = [];
await mkdir(base, { recursive: true });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const readJSON = async (path) => JSON.parse(await readFile(path, "utf8"));
async function waitFor(read, predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const value = await read(); if (predicate(value)) return value; } catch (error) { if (error.code !== "ENOENT") throw error; }
    await sleep(25);
  }
  throw new Error(`Timeout: ${label}`);
}
async function setup(name, workerConfig, options = {}) {
  const runRoot = resolve(base, name);
  await mkdir(runRoot);
  const config = resolve(runRoot, "worker-config.json"), source = resolve(runRoot, "worker.mjs");
  await writeFile(config, JSON.stringify(workerConfig)); await copyFile(fixture, source);
  const job = {
    schema: "lifeline-supervised-job-v1", run_root: runRoot, cwd: root,
    command: [process.execPath, source, "--run-root", runRoot, "--config", config],
    identity_files: [source, config], max_wall_seconds: 20, worker_wall_seconds: 10,
    max_restarts: 2, max_no_progress_exits: 2, poll_ms: 40, stop_grace_seconds: 0.2, ...options,
  };
  const path = resolve(runRoot, "job.json"); await writeFile(path, JSON.stringify(job));
  return { runRoot, path, source, config, job };
}
function start(job, extra = []) {
  const child = spawn(process.execPath, [supervisor, "--job", job.path, ...extra], { cwd: root, windowsHide: true });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 25000);
  const result = new Promise((done, fail) => {
    child.once("error", fail);
    child.once("close", (code, signal) => { clearTimeout(timer); done({ code, signal, output }); });
  });
  return { child, result };
}
const state = (job) => readJSON(resolve(job.runRoot, "supervisor-state.json"));
const checkpoint = (job) => readJSON(resolve(job.runRoot, "checkpoint.json"));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };

const resumed = await setup("worker-kill", { units: 8, delay_ms: 90 });
let running = start(resumed);
await waitFor(() => checkpoint(resumed), (value) => value.units.length >= 2, "worker checkpoint");
let saved = await waitFor(() => state(resumed), (value) => value.worker_pid, "worker pid");
process.kill(saved.worker_pid, "SIGKILL");
let result = await running.result;
assert.equal(result.code, 0, result.output);
assert.equal((await state(resumed)).attempts, 2);
assert.deepEqual((await checkpoint(resumed)).units, Array.from({ length: 8 }, (_, i) => i));
rows.push({ case: "actual-worker-kill", pass: true, attempts: 2, no_completed_units_repeated: true });

const parent = await setup("supervisor-kill", { units: 8, delay_ms: 100 });
running = start(parent);
await waitFor(() => checkpoint(parent), (value) => value.units.length >= 2, "supervisor checkpoint");
saved = await waitFor(() => state(parent), (value) => value.worker_pid, "orphan worker pid");
running.child.kill("SIGKILL"); await running.result;
// Windows may terminate the process tree before the host can write a receipt.
// Either way the exact spawned worker must be gone before a replacement starts.
await waitFor(async () => alive(saved.worker_pid), (value) => value === false, "orphan worker gone");
let orphan = null;
try { orphan = await readJSON(resolve(parent.runRoot, "worker-1.exit.json")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
if (orphan) assert.equal(orphan.worker_pid, saved.worker_pid);
result = await start(parent).result;
assert.equal(result.code, 0, result.output);
assert.deepEqual((await checkpoint(parent)).units, Array.from({ length: 8 }, (_, i) => i));
rows.push({ case: "actual-supervisor-kill-and-restart", pass: true, orphan_worker_alive: false,
  orphan_exit_receipt: orphan?.cancelled ?? "not-written-before-process-tree-exit" });

const duplicate = await setup("duplicate", { units: 8, delay_ms: 100 });
running = start(duplicate);
await waitFor(() => state(duplicate), (value) => value.worker_pid, "lease owner");
result = await start(duplicate).result;
assert.equal(result.code, 76, result.output);
assert.equal((await running.result).code, 0);
assert.equal((await state(duplicate)).attempts, 1);
rows.push({ case: "duplicate-supervisor-rejected", pass: true });

for (const marker of ["PAUSE", "STOP"]) {
  const job = await setup(marker.toLowerCase(), { units: 8, delay_ms: 90 });
  running = start(job);
  await waitFor(() => checkpoint(job), (value) => value.units.length >= 2, marker);
  await writeFile(resolve(job.runRoot, marker), "");
  assert.equal((await running.result).code, 75);
  const before = await checkpoint(job), attempts = (await state(job)).attempts;
  assert.equal((await start(job).result).code, 75, "markers require explicit resume");
  assert.equal((await state(job)).attempts, attempts);
  assert.deepEqual(await checkpoint(job), before);
  assert.equal((await start(job, ["--resume"]).result).code, 0);
  rows.push({ case: `${marker}-explicit-resume`, pass: true, preserved_units: before.units.length });
}
const yielded = await setup("yielded", { units: 6, delay_ms: 20, units_per_launch: 2 });
assert.equal((await start(yielded).result).code, 0);
assert.equal((await state(yielded)).attempts, 3);
assert.equal((await state(yielded)).abnormal_exits, 0);
rows.push({ case: "incremental-budget-yields", pass: true });

for (const mode of ["corrupt", "drift", "semantic-corrupt"]) {
  const job = await setup(mode, { units: 6, delay_ms: 60 });
  running = start(job);
  await waitFor(() => checkpoint(job), (value) => value.units.length >= 1, mode);
  await writeFile(resolve(job.runRoot, "PAUSE"), "");
  assert.equal((await running.result).code, 75);
  const before = (await state(job)).attempts;
  if (mode === "drift") await writeFile(job.source, `${await readFile(job.source, "utf8")}\n// source drift\n`);
  else if (mode === "corrupt") await writeFile(resolve(job.runRoot, "checkpoint.json"), '{"broken":');
  else {
    const value = await checkpoint(job); value.sum = -1;
    await writeFile(resolve(job.runRoot, "checkpoint.json"), JSON.stringify(value));
  }
  result = await start(job, ["--resume"]).result;
  assert.equal(result.code, 78, result.output);
  assert.ok((await state(job)).attempts <= before + (mode === "semantic-corrupt" ? 1 : 0));
  rows.push({ case: `${mode}-fatal-without-retry`, pass: true });
}
const bounded = await setup("bounded-retry", { units: 8, always_fail: true });
assert.equal((await start(bounded).result).code, 1);
assert.equal((await state(bounded)).status, "RETRY_EXHAUSTED");
assert.equal((await state(bounded)).attempts, 2);
rows.push({ case: "no-progress-bounded-retry", pass: true, attempts: 2 });
const budget = await setup("hard-budget", { units: 8, hang: true }, { max_wall_seconds: 0.7 });
const budgetStart = Date.now();
assert.equal((await start(budget).result).code, 75);
assert.equal((await state(budget)).status, "BUDGET_EXHAUSTED");
assert.ok(Date.now() - budgetStart < 3000);
rows.push({ case: "hard-wall-budget", pass: true });
const clean = await setup("clean", { units: 8, delay_ms: 1 });
assert.equal((await start(clean).result).code, 0);
assert.deepEqual((await checkpoint(clean)).units, (await checkpoint(resumed)).units);
assert.equal((await checkpoint(clean)).sum, (await checkpoint(resumed)).sum);
rows.push({ case: "clean-versus-resumed-equivalence", pass: true });
const completeCheckpoint = await checkpoint(clean);
assert.equal((await start(clean).result).code, 0);
assert.deepEqual(await checkpoint(clean), completeCheckpoint, "completed units must not rerun during verification");
await writeFile(resolve(clean.runRoot, "checkpoint.json"), JSON.stringify({ ...completeCheckpoint, sum: -1 }));
assert.equal((await start(clean).result).code, 78, "completed checkpoint corruption must be revalidated by the worker");
assert.deepEqual((await checkpoint(clean)).units, completeCheckpoint.units);
rows.push({ case: "completed-checkpoint-revalidated-without-rerun", pass: true });

const evidence = { status: "PASS_CURRENT_RECOVERY_FIXTURES", real_training_started: false,
  cases: rows, operating_system: process.platform, node: process.version,
  files: Object.fromEntries(await Promise.all([supervisor, fixture, fileURLToPath(import.meta.url)].map(async (path) =>
    [path.slice(root.length + 1).replaceAll("\\", "/"), createHash("sha256").update(await readFile(path)).digest("hex")]))),
  scope: "OS leases, killed worker/supervisor, atomic deterministic fixture recovery, explicit pause/stop, corruption/source drift, retry and wall bounds; not real trainer/arena recovery.",
  artifact_directory: base };
await writeFile(resolve(base, "recovery-summary.json"), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
