import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const args = process.argv.slice(2);
const opt = (name) => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
assert.ok(opt("--arena-root") && opt("--candidates"), "Supply a completed small arena and its candidate manifest.");
const arena = resolve(root, opt("--arena-root")), candidates = resolve(root, opt("--candidates"));
const fixture = resolve(root, opt("--run-root") ?? `local_artifacts/neural-verifier-adapter-recovery-${Date.now()}`);
const run = resolve(fixture, "verification"), adapter = resolve(root, "web/tools/run-neural-arena-verification.mjs");
const supervisor = resolve(root, "web/tools/supervise-three-player-job.mjs");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const active = new Set();
function execute(argv) {
  const child = spawn(process.execPath, ["--unhandled-rejections=strict", ...argv], { cwd: root, windowsHide: true });
  active.add(child);
  let output = "";
  child.stdout.on("data", (bytes) => { output += bytes; });
  child.stderr.on("data", (bytes) => { output += bytes; });
  const done = new Promise((finish, fail) => {
    child.once("error", fail);
    child.once("close", (code, signal) => { active.delete(child); finish({ code, signal, output }); });
  });
  return { child, done };
}
const adapterArgs = (target) => [adapter, "--run-root", target, "--arena-root", arena, "--candidates", candidates];
const proofFiles = ["identity.json", "checkpoint.json", "progress.json", "summary.json"];
const proofHashes = async () => Object.fromEntries(await Promise.all(proofFiles.map(async (name) =>
  [name, sha(await readFile(resolve(arena, name)))])));

await mkdir(run, { recursive: true });
const arenaBefore = await proofHashes();
const jobPath = resolve(fixture, "job.json");
await writeFile(jobPath, JSON.stringify({
  schema: "lifeline-supervised-job-v1", run_root: run, cwd: root,
  command: [process.execPath, "--unhandled-rejections=strict", ...adapterArgs(run)],
  identity_files: [adapter, resolve(root, "web/tools/verify-neural-posttraining-v2.mjs"),
    resolve(root, "web/tools/neural-posttraining-arena-v2.mjs"), resolve(arena, "identity.json"),
    resolve(arena, "summary.json"), candidates],
  max_wall_seconds: 90, worker_wall_seconds: 60, max_restarts: 1, max_no_progress_exits: 2, poll_ms: 20,
}, null, 2));
try {
  const first = await execute([supervisor, "--job", jobPath]).done;
  assert.equal(first.code, 0, first.output);
  assert.equal((await json(resolve(run, "checkpoint.json"))).progress_units, 1);
  const resumed = execute([supervisor, "--job", jobPath, "--resume"]);
  let killed = false;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && !killed && resumed.child.exitCode === null) {
    const progress = await json(resolve(run, "progress.json"));
    if (progress.status === "RUNNING" && progress.progress_units === 1) {
      const launch = await json(resolve(run, "worker-2.launch.json"));
      process.kill(launch.worker_pid, "SIGKILL");
      killed = true;
      break;
    }
    await sleep(5);
  }
  assert.equal(killed, true, "Reverification must be interrupted while its durable progress is one.");
  const recovery = await resumed.done;
  assert.equal(recovery.code, 0, recovery.output);
  const supervisorState = await json(resolve(run, "supervisor-state.json"));
  assert.equal(supervisorState.status, "COMPLETE");
  assert.equal(supervisorState.abnormal_exits, 1);
  assert.equal(supervisorState.attempts, 3);
  assert.equal(supervisorState.progress_units, 1);
  const verifierReceipt = await json(resolve(run, "verification-execution.json"));
  assert.equal(verifierReceipt.verifier_exit_code, 0);

  const checkpointPath = resolve(run, "checkpoint.json"), progressPath = resolve(run, "progress.json");
  const originalCheckpoint = await readFile(checkpointPath), originalProgress = await readFile(progressPath);
  await writeFile(checkpointPath, JSON.stringify({ ...JSON.parse(originalCheckpoint), identity: "unrelated-existing-run" }));
  const conflictingCheckpoint = await readFile(checkpointPath);
  const rejected = await execute(adapterArgs(run)).done;
  assert.equal(rejected.code, 78);
  assert.match(rejected.output, /identity drift/);
  assert.deepEqual(await readFile(checkpointPath), conflictingCheckpoint);
  assert.deepEqual(await readFile(progressPath), originalProgress);
  await writeFile(checkpointPath, originalCheckpoint);

  const alias = resolve(fixture, "arena-alias");
  await symlink(arena, alias, process.platform === "win32" ? "junction" : "dir");
  const aliasRejected = await execute(adapterArgs(alias)).done;
  assert.equal(aliasRejected.code, 78);
  assert.match(aliasRejected.output, /directories must differ/);
  if (process.platform === "win32") {
    const caseRejected = await execute(adapterArgs(arena.toUpperCase())).done;
    assert.equal(caseRejected.code, 78);
    assert.match(caseRejected.output, /directories must differ/);
  }
  assert.deepEqual(await proofHashes(), arenaBefore);
  const report = {
    status: "PASS_VERIFIER_ADAPTER_RECOVERY", fixture, arena,
    adapter_sha256: sha(await readFile(adapter)),
    verifier_sha256: verifierReceipt.verifier_sha256,
    command: [process.execPath, fileURLToPath(import.meta.url), ...args],
    initialSupervisorExit: first.code, recoverySupervisorExit: recovery.code,
    verifierExit: verifierReceipt.verifier_exit_code, abnormalExits: supervisorState.abnormal_exits,
    attempts: supervisorState.attempts, progressUnits: supervisorState.progress_units,
    realWorkerKillRecovery: true, conflictingIdentityPreserved: true,
    directoryAliasRejected: true, windowsCaseAliasRejected: process.platform === "win32",
    arenaProofFilesPreserved: true,
  };
  await writeFile(resolve(fixture, "receipt.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  for (const child of active) child.kill("SIGKILL");
}
