import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { GameEngine } from "../GameEngine.js";
import { serializeEngineState } from "../AIStateProtocol.js";
import { preparePassOpportunityMain, probePassOpportunityPositions, samplePassOpportunityPositions } from "../../tools/prepare-pass-opportunity-v3.mjs";
import { pipelineMain } from "../../tools/pass-opportunity-pipeline-v3.mjs";
import { atomic, lease, readJson, root, sealed, sha, unseal } from "../../tools/neural-posttraining-data-v2.mjs";

const base = await mkdtemp(resolve(root, "local_artifacts/pass-opportunity-pipeline-recovery-")), rows = [];
const supervisor = resolve(root, "web/tools/supervise-three-player-job.mjs");
const sleep = ms => new Promise(done => setTimeout(done, ms));
const read = path => readJson(path);
const fixture = prefix => {
  const engine = new GameEngine({ gridSize: 5, playerCount: 2, rulesVersion: "territory-v3", deferTerritoryUpdates: true });
  engine._isReplayingBatch = true;
  for (const point of prefix) assert.equal(engine.playMove(point).success, true);
  return serializeEngineState(engine);
};
const prefix = [[2, 0], [3, 1], [0, 1], [0, 4]];
const plans = [{ id: "recovery-train", split: "train", state: fixture(prefix), metadata:{episodeId:"recovery-train-game",phase:"middle"} },
  { id: "recovery-validation", split: "validation", state: fixture([...prefix, [2, 1]]), metadata:{episodeId:"recovery-validation-game",phase:"middle"} }];
const input = resolve(base, "input.json"); await writeFile(input, JSON.stringify(plans));
const config = JSON.parse(await readFile(resolve(root, "web/tools/configs/pass-opportunity-v3.draft.json"), "utf8"));
config.status = "RECOVERY_FIXTURE_NOT_FORMAL_TRAINING"; config.parents = ["easy"];
config.sampling.cells = [{players:2,shape:"triangle",size:5}];
config.labels = { max_nodes_per_label: 20000, time_ms_per_label: 5000 };
config.training.updates = 3;
config.supervision = { max_wall_seconds: 30, worker_wall_seconds: 10, max_restarts: 3,
  max_no_progress_exits: 3, poll_ms: 40, stop_grace_seconds: 0.2, worker_units: 1 };
const protocol = resolve(base, "protocol.json"); await writeFile(protocol, JSON.stringify(config));
const create = async (name, custom = config) => {
  const path = resolve(base, `${name}-protocol.json`); await writeFile(path, JSON.stringify(custom));
  const runRoot = resolve(base, name);
  await preparePassOpportunityMain(["--run-root", runRoot, "--protocol", path, "--input", input]);
  return { runRoot, job: resolve(runRoot, "job.json") };
};
const start = job => {
  const child = spawn(process.execPath, [supervisor, "--job", job.job], { cwd: root, windowsHide: true });
  let output = ""; child.stdout.on("data", value => { output += value; }); child.stderr.on("data", value => { output += value; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 35000);
  const completion = new Promise((done, fail) => { child.once("error", fail); child.once("close", (code, signal) => {
    clearTimeout(timer); done({ code, signal, output });
  }); });
  return { child, completion };
};
const waitFor = async (get, predicate, label) => {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { const value = await get(); if (predicate(value)) return value; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await sleep(30);
  }
  throw new Error(`Timeout: ${label}`);
};
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };

const sampled = samplePassOpportunityPositions(config);
assert.ok(sampled.plans.length > 0);
assert.deepEqual(samplePassOpportunityPositions(config), sampled, "Source sampling must be seed deterministic");
assert.equal(sampled.receipt.labels_generated, 0);
assert.ok(sampled.plans.every(plan => plan.metadata.source === "seeded-native-legal-game-prefix-v3"));
rows.push({ case: "seeded-real-legal-prefix-sampling", positions: sampled.plans.length, pass: true });

const pilot = resolve(base, "pilot");
assert.equal((await probePassOpportunityPositions(plans, config, { runRoot: pilot, maxUnits: 10, maxSeconds: 30,
  maxNodes: 20000, timeMs: 5000, faultAfterReceipt: true })).code, 79);
const pilotFirst = await readFile(resolve(pilot, "receipts/recovery-train.json"));
assert.equal((await probePassOpportunityPositions(plans, config, { runRoot: pilot, maxUnits: 10, maxSeconds: 30,
  maxNodes: 20000, timeMs: 5000 })).code, 0);
assert.deepEqual(await readFile(resolve(pilot, "receipts/recovery-train.json")), pilotFirst);
rows.push({ case: "pilot-unindexed-receipt-adopted-without-reprobe", pass: true });

const resumed = await create("resumed"), clean = await create("clean");
const args = job => ["--run-root", job.runRoot, "--max-new-units", "100", "--max-seconds", "30"];
assert.equal(await pipelineMain([...args(resumed), "--fault-after-sample-write"]), 79);
const firstLabel = await readFile(resolve(resumed.runRoot, "data/samples/recovery-train.json"));
assert.equal(await pipelineMain([...args(resumed), "--fault-after-checkpoint"]), 79);
assert.equal(await pipelineMain(args(resumed)), 0);
assert.equal(await pipelineMain(args(clean)), 0);
assert.deepEqual(await readFile(resolve(resumed.runRoot, "data/samples/recovery-train.json")), firstLabel);
const resumedWeights = unseal(await read(resolve(resumed.runRoot, "models/easy/checkpoint.json"))).weights;
assert.deepEqual(resumedWeights, unseal(await read(resolve(clean.runRoot, "models/easy/checkpoint.json"))).weights);
const before = await readFile(resolve(resumed.runRoot, "models/easy/checkpoint.json"));
assert.equal(await pipelineMain(args(resumed)), 0);
assert.deepEqual(await readFile(resolve(resumed.runRoot, "models/easy/checkpoint.json")), before);
rows.push({ case: "sample-and-update-fault-resume-clean-parity", completedUnits: 6, pass: true });

const paused = await create("paused"); await writeFile(resolve(paused.runRoot, "PAUSE"), "fixture");
assert.equal(await pipelineMain(args(paused)), 75);
assert.equal((await read(resolve(paused.runRoot, "progress.json"))).status, "PAUSED");
assert.equal((await start(paused).completion).code, 75);
rows.push({ case: "pause-preserved-by-worker-and-supervisor", pass: true });

const stop = await create("stopped"); await writeFile(resolve(stop.runRoot, "STOP"), "fixture");
assert.equal(await pipelineMain(args(stop)), 75);
assert.equal((await read(resolve(stop.runRoot, "progress.json"))).status, "STOPPED");
rows.push({ case: "stop-preserved", pass: true });

const guard = await lease(resolve(clean.runRoot, "pipeline-worker"));
try { await assert.rejects(pipelineMain(args(clean)), { code: "EADDRINUSE" }); }
finally { await new Promise(done => guard.close(done)); }
rows.push({ case: "duplicate-pipeline-lease", pass: true });

const corrupt = await create("corrupt");
await atomic(resolve(corrupt.runRoot, "checkpoint.json"), { integrity: "invalid" });
await assert.rejects(pipelineMain(args(corrupt)), /Corrupt evidence integrity/);
assert.equal((await read(resolve(corrupt.runRoot, "progress.json"))).status, "FATAL");
rows.push({ case: "corrupt-evidence-fail-closed", pass: true });

const rejectedConfig = structuredClone(config); rejectedConfig.labels.max_nodes_per_label = 1;
const rejected = await create("rejected-budget", rejectedConfig);
const rejectedResult = await start(rejected).completion;
assert.equal(rejectedResult.code, 78, rejectedResult.output);
assert.equal((await read(resolve(rejected.runRoot, "supervisor-state.json"))).status, "FATAL");
assert.equal((await read(resolve(rejected.runRoot, "data/progress.json"))).status, "FATAL");
rows.push({ case: "teacher-budget-rejection-stops-supervisor-without-fallback", pass: true });

const killed = await create("supervisor-kill");
let running = start(killed);
let state = await waitFor(() => read(resolve(killed.runRoot, "supervisor-state.json")), value => !!value.worker_pid, "worker launch");
const duplicate = await start(killed).completion;
assert.equal(duplicate.code, 76, duplicate.output);
await waitFor(() => read(resolve(killed.runRoot, "checkpoint.json")), value => unseal(value).units >= 1, "durable checkpoint before supervisor death");
const durableLabel = await readFile(resolve(killed.runRoot, "data/samples/recovery-train.json"));
running.child.kill("SIGKILL"); await running.completion;
await waitFor(async () => alive(state.worker_pid), value => !value, "orphan worker reaped");
const priorCheckpoint = await readJson(resolve(killed.runRoot, "checkpoint.json"), true);
running = start(killed); const result = await running.completion;
assert.equal(result.code, 0, result.output);
state = await read(resolve(killed.runRoot, "supervisor-state.json"));
assert.equal(state.status, "COMPLETE");
assert.ok(unseal(await read(resolve(killed.runRoot, "checkpoint.json"))).units >= (priorCheckpoint ? unseal(priorCheckpoint).units : 0));
assert.deepEqual(unseal(await read(resolve(killed.runRoot, "models/easy/checkpoint.json"))).weights, resumedWeights);
assert.deepEqual(await readFile(resolve(killed.runRoot, "data/samples/recovery-train.json")), durableLabel);
rows.push({ case: "actual-supervisor-kill-reap-restart-and-duplicate", attempts: state.attempts, pass: true });

const workerKilled = await create("worker-kill"); running = start(workerKilled);
state = await waitFor(() => read(resolve(workerKilled.runRoot, "supervisor-state.json")), value => !!value.worker_pid, "worker to interrupt");
if (alive(state.worker_pid)) process.kill(state.worker_pid, "SIGKILL");
const workerResult = await running.completion;
assert.equal(workerResult.code, 0, workerResult.output);
assert.deepEqual(unseal(await read(resolve(workerKilled.runRoot, "models/easy/checkpoint.json"))).weights, resumedWeights);
assert.ok((await read(resolve(workerKilled.runRoot, "supervisor-state.json"))).abnormal_exits >= 1);
rows.push({ case: "actual-worker-kill-automatic-recovery", pass: true });

const wrapper = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
  resolve(root, "web/tools/launch-defensive-warmstart-v2.ps1"), "-JobPath", clean.job, "-CheckOnly"],
{ cwd: root, windowsHide: true });
let wrapperOutput = "", wrapperError = "";
wrapper.stdout.on("data", value => { wrapperOutput += value; }); wrapper.stderr.on("data", value => { wrapperError += value; });
assert.equal(await new Promise(done => wrapper.once("close", done)), 0, wrapperError);
assert.equal(JSON.parse(wrapperOutput.trim()).started, false);
const recovery = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
  resolve(root, "web/tools/recover-defensive-warmstart-at-login-v2.ps1"), "-JobPath", workerKilled.job, "-CheckOnly"],
{ cwd: root, windowsHide: true });
let recoveryOutput = "", recoveryError = "";
recovery.stdout.on("data", value => { recoveryOutput += value; }); recovery.stderr.on("data", value => { recoveryError += value; });
assert.equal(await new Promise(done => recovery.once("close", done)), 0, recoveryError);
assert.equal(JSON.parse(recoveryOutput.trim()).recoverable, false, "Completed jobs must not be launched again at login");
rows.push({ case: "hidden-launcher-checkonly-and-login-complete-refusal", pass: true });

const receipt = { status: "PASS_PASS_OPPORTUNITY_PIPELINE_RECOVERY_FIXTURES", rows, fixtureRoot: base,
  command: "node web/web前端/tests/verify-pass-opportunity-pipeline-v3.mjs", formalTrainingStarted: false,
  strengthVerified: false, scope: "Tiny recovery fixtures and reproducible sampling only; no candidate admitted." };
await atomic(resolve(base, "receipt.json"), receipt); console.log(JSON.stringify(receipt));
