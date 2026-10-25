import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { prepareTerminalMain } from "../../tools/prepare-terminal-policy-v4.mjs";
import { terminalPolicyTrainMain } from "../../tools/train-terminal-policy-v4.mjs";
import { atomic, readJson, root, unseal } from "../../tools/neural-posttraining-data-v2.mjs";
const base = await mkdtemp(resolve(root, "local_artifacts/terminal-v4-supervisor-recovery-"));
const config = JSON.parse(await readFile(resolve(root, "web/tools/configs/terminal-policy-v4.draft.json"), "utf8"));
config.status = "REAL_SUPERVISOR_RECOVERY_FIXTURE"; config.parents = [{ alias: "easy", cells: [{ players: 2, shape: "triangle", size: 5 }] }];
config.episodes_per_parent = 1; config.maximum_game_plies = 80; config.minimum_actual_updates_per_parent = 1;
config.analysis = { max_attempts_per_episode: 2, learner_turns: [0, 1], max_nodes: 30000, time_ms: 5000, action_mask: "lexicographic-defense-prefix-0-1-4" };
config.supervision = { max_wall_seconds: 30, worker_wall_seconds: 10, worker_units: 1, max_restarts: 3, max_no_progress_exits: 3, poll_ms: 40, stop_grace_seconds: 0.2 };
const configPath = resolve(base, "protocol.json"); await writeFile(configPath, JSON.stringify(config));
const setup = async name => {
  const runRoot = resolve(base, name); await prepareTerminalMain(["--run-root", runRoot, "--config", configPath]);
  assert.equal(await terminalPolicyTrainMain(["--run-root", runRoot, "--config", resolve(runRoot, "protocol.json"), "--max-new-units", "2", "--max-seconds", "20"]), 75);
  return { runRoot, job: resolve(runRoot, "job.json") };
};
const start = job => {
  const child = spawn(process.execPath, [resolve(root, "web/tools/supervise-three-player-job.mjs"), "--job", job.job], { cwd: root, windowsHide: true });
  let output = ""; child.stdout.on("data", v => output += v); child.stderr.on("data", v => output += v);
  const timer = setTimeout(() => child.kill("SIGKILL"), 35000);
  const completion = new Promise((done, fail) => { child.once("error", fail); child.once("close", (code, signal) => { clearTimeout(timer); done({ code, signal, output }); }); });
  return { child, completion };
};
const sleep = ms => new Promise(done => setTimeout(done, ms));
const wait = async (read, predicate) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { try { const value = await read(); if (predicate(value)) return value; } catch (e) { if (e.code !== "ENOENT") throw e; } await sleep(15); }
  throw Error("Terminal supervisor fixture wait timeout");
};
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === "ESRCH") return false; throw e; } };
const checkpoint = async job => unseal(await readJson(resolve(job.runRoot, "checkpoint.json")));
const state = job => readJson(resolve(job.runRoot, "supervisor-state.json"));
const worker = await setup("worker-kill");
let running = start(worker), snapshot = await wait(() => state(worker), s => !!s.worker_pid && alive(s.worker_pid));
process.kill(snapshot.worker_pid, "SIGKILL");
let result = await running.completion; assert.equal(result.code, 0, result.output);
assert.ok((await state(worker)).abnormal_exits >= 1); assert.equal((await checkpoint(worker)).models.easy.actualUpdates, 1);
const expectedWeights = (await checkpoint(worker)).models.easy.weights;
const supervisor = await setup("supervisor-kill");
const firstStep = await readFile(resolve(supervisor.runRoot, "episodes/easy-seed0/steps/0.json"));
running = start(supervisor); snapshot = await wait(() => state(supervisor), s => !!s.worker_pid && alive(s.worker_pid));
const duplicate = await start(supervisor).completion; assert.equal(duplicate.code, 76, duplicate.output);
running.child.kill("SIGKILL"); await running.completion;
await wait(async () => alive(snapshot.worker_pid), value => !value);
result = await start(supervisor).completion; assert.equal(result.code, 0, result.output);
assert.deepEqual((await checkpoint(supervisor)).models.easy.weights, expectedWeights);
assert.deepEqual(await readFile(resolve(supervisor.runRoot, "episodes/easy-seed0/steps/0.json")), firstStep);
assert.equal((await state(supervisor)).deadline_epoch_ms, snapshot.deadline_epoch_ms);
const receipt = { status: "PASS_REAL_TERMINAL_V4_SUPERVISION_RECOVERY", fixtureRoot: base,
  command: "node web/web前端/tests/verify-terminal-policy-supervision-v4.mjs",
  checks: ["real-worker-kill-autorecovery", "real-supervisor-kill-reap-and-restart", "no-committed-step-repeated",
    "same-model-after-recovery", "duplicate-supervisor-rejected", "original-absolute-deadline-retained"],
  formal_training_started: false, runtime_admitted: false };
await atomic(resolve(base, "receipt.json"), receipt); console.log(JSON.stringify(receipt));
