import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { root, readJson, atomic, sha, replay, teacherSample } from "../../tools/neural-posttraining-data.mjs";

const run = resolve(root, `local_artifacts/neural-data-recovery-${Date.now()}`);
await mkdir(run, { recursive: true });
const config = { ...await readJson(resolve(root, "web/tools/configs/neural-posttraining-data-20261021.json")),
  sizes: [5, 7], trainReplicates: 2, validationReplicates: 2, maximumPlies: 8 };
const configPath = resolve(run, "fixture.json");
await atomic(configPath, config);
const script = resolve(root, "web/tools/neural-posttraining-data.mjs");
function worker(dir, extra = []) {
  const child = spawn(process.execPath, [script, "--run-root", dir, "--config", configPath, ...extra],
    { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", (b) => output += b); child.stderr.on("data", (b) => output += b);
  return { child, done: new Promise((done) => child.on("exit", (code) => done({ code, output }))) };
}
async function waitFor(path, predicate) {
  for (let i = 0; i < 1500; i++) {
    const value = await readJson(path, true);
    if (value && predicate(value)) return value;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error(`Timed out: ${path}`);
}
const clean = resolve(run, "clean"), interrupted = resolve(run, "interrupted");
const first = worker(interrupted);
await waitFor(resolve(interrupted, "checkpoint.json"), (p) => p.units >= 2);
const duplicate = await worker(interrupted).done;
assert.equal(duplicate.code, 76, duplicate.output);
first.child.kill("SIGKILL");
await first.done;
await writeFile(resolve(interrupted, "interrupted-tail.tmp"), "{");
// A real external supervisor must recover an unexpected worker exit.
const job = { schema: "lifeline-supervised-job-v1", run_root: interrupted, cwd: root,
  command: [process.execPath, script, "--run-root", interrupted, "--config", configPath, "--max-seconds", "30"],
  identity_files: [script, configPath], max_wall_seconds: 120, worker_wall_seconds: 35,
  max_restarts: 3, max_no_progress_exits: 3 };
const jobPath = resolve(interrupted, "job.json");
await atomic(jobPath, job);
const sup = spawn(process.execPath, [resolve(root, "web/tools/supervise-three-player-job.mjs"), "--job", jobPath],
  { cwd: root, windowsHide: true, stdio: "ignore" });
const done = new Promise((accept) => sup.on("exit", accept));
const launch = await waitFor(resolve(interrupted, "worker-1.launch.json"), (v) => v.worker_pid);
await waitFor(resolve(interrupted, "progress.json"), (p) => p.progress_units >= 4);
process.kill(launch.worker_pid, "SIGKILL");
assert.equal(await done, 0);
const supState = await readJson(resolve(interrupted, "supervisor-state.json"));
assert.equal(supState.status, "COMPLETE");
assert.ok(supState.abnormal_exits >= 1);
const normal = await worker(clean).done;
assert.equal(normal.code, 0, normal.output);
const manifest = await readJson(resolve(clean, "manifest.json"));
assert.deepEqual(await readJson(resolve(interrupted, "manifest.json")), manifest);
for (const item of manifest.episodes) {
  assert.equal(sha(await readFile(resolve(clean, item.path))), sha(await readFile(resolve(interrupted, item.path))));
  const ep = await readJson(resolve(clean, item.path));
  for (const sample of ep.samples) {
    const engine = replay({ ...ep, actions: ep.actions.slice(0, sample.ply) });
    assert.deepEqual(teacherSample(engine, config, sample.ply), sample);
  }
}
assert.ok((await readdir(interrupted)).some((p) => p.startsWith("interrupted-tail.tmp.interrupted-")));
await writeFile(resolve(interrupted, "PAUSE"), "");
assert.equal((await worker(interrupted).done).code, 0); // Complete data stays complete.
const paused = resolve(run, "paused"); await mkdir(paused);
await writeFile(resolve(paused, "PAUSE"), "");
assert.equal((await worker(paused).done).code, 75);
assert.equal((await readJson(resolve(paused, "progress.json"))).status, "PAUSED");
await writeFile(resolve(interrupted, manifest.episodes[0].path), "{}");
assert.equal((await worker(interrupted).done).code, 78);
await atomic(resolve(run, "receipt.json"), { status: "PASS", realWorkerKill: true,
  supervisorUnexpectedExitRecovery: true, duplicateExcluded: true,
  recoveredEpisodesByteIdentical: true, allFixtureTeacherLabelsRecomputed: true,
  incompleteTailPreserved: true, pauseRespected: true, corruptionRejected: true,
  command: "node --unhandled-rejections=strict web/web前端/tests/verify-neural-posttraining-data.mjs" });
console.log(JSON.stringify({ status: "PASS", run, episodes: manifest.episodes.length }));
