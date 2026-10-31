// A new operational budget for the unchanged, previously interrupted FINAL.
// This adapter never modifies the original run or its scientific identity.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, readdir, mkdir, copyFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { readChecked, canonical, sha256 } from "./three-player-arena-lib.mjs";
import { SOURCE_FILES, validateProtocol } from "./hex-posttrain-protocol.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const self = fileURLToPath(import.meta.url);
const base = resolve(root, "local_artifacts/hex-player-posttrain-v2");
const source = resolve(base, "final-20261021-r1");
const destination = resolve(base, "final-continuation-20261021-r1");
const verification = resolve(base, "final-continuation-verification-20261021-r1");
const documents = resolve(root, "docs/verification/hex-ai-posttrain-v2-continuation");
const config = resolve(root, "web/tools/configs/hex-player-policy-v2-final.json");
const worker = resolve(root, "web/tools/run-hex-posttraining.mjs");
const verifier = resolve(root, "web/tools/verify-hex-posttraining.mjs");
const supervisor = resolve(root, "web/tools/supervise-three-player-job.mjs");
const identity = "cef118b61bf0540c1e9306ad87380950e9515dfb5f295ff72f9f161066a36246";
const fileHash = async (path) => sha256(await readFile(path));
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
async function writeNew(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}
async function snapshot(directory, prefix = "") {
  const output = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const key = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(output, await snapshot(resolve(directory, entry.name), key));
    else if (entry.isFile()) output[key] = await fileHash(resolve(directory, entry.name));
    else throw new Error(`Unsupported source entry: ${key}`);
  }
  return output;
}
async function validateSource() {
  const state = await readChecked(resolve(source, "checkpoint.json"));
  assert.equal(state.identity, identity); assert.equal(state.phase, "final");
  assert.equal(state.games.length, 77); assert.equal(state.current.id, "final-n7-p6-WHITE-s1-multi");
  assert.equal(state.current.actions.length, 61);
  assert.equal(sha256(canonical(state.identityData)), identity);
  assert.equal(await fileHash(config), state.identityData.config);
  assert.deepEqual(validateProtocol(await json(config)), state.config);
  for (const [path, hash] of Object.entries(state.identityData.sources)) assert.equal(await fileHash(resolve(root, path)), hash, path);
  assert.equal(await fileHash(state.parentPath), state.identityData.parent);
  assert.equal(await fileHash(state.candidatePath), state.identityData.candidate);
  for (const item of state.games) {
    const game = await readChecked(resolve(source, "games", `${item.id}.json`));
    assert.equal(game.identity, identity); assert.equal(game.integrity, item.integrity); assert.equal(game.terminal, true);
  }
  const operational = await json(resolve(source, "supervisor-state.json"));
  assert.equal(operational.status, "BUDGET_EXHAUSTED");
  return state;
}
async function clone(target, state) {
  await mkdir(target); // Must be a fresh directory; never merge existing evidence.
  await mkdir(resolve(target, "games")); await mkdir(resolve(target, "candidates"));
  for (const name of ["checkpoint.json", ...state.games.map((g) => `games/${g.id}.json`),
    ...state.candidates.map((c) => `candidates/stage-${c.stage}.json`)]) {
    await copyFile(resolve(source, name), resolve(target, name), constants.COPYFILE_EXCL);
    assert.equal(await fileHash(resolve(source, name)), await fileHash(resolve(target, name)));
  }
}
function run(arguments_) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [worker, ...arguments_], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (x) => { stdout += x; }); child.stderr.on("data", (x) => { stderr += x; });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 60000);
    child.once("error", reject);
    child.once("close", (code, signal) => { clearTimeout(timeout); accept({ code, signal, stdout, stderr }); });
  });
}
const workerArgs = (runRoot, state) => ["--run-root", runRoot, "--config", config,
  "--candidate", state.candidatePath, "--max-seconds", "30"];
async function originalsUnchanged(expected) { assert.deepEqual(await snapshot(source), expected, "Original run evidence changed"); }
async function completedUnchanged(target, original) {
  for (const game of original.games) assert.equal(await fileHash(resolve(target, "games", `${game.id}.json`)),
    await fileHash(resolve(source, "games", `${game.id}.json`)), `Completed game changed: ${game.id}`);
}
async function test() {
  const state = await validateSource(), before = await snapshot(source);
  const interrupted = resolve(base, "continuation-recovery-interrupted-20261021-r1");
  const clean = resolve(base, "continuation-recovery-clean-20261021-r1");
  await clone(interrupted, state); await clone(clean, state);
  const crashed = await run([...workerArgs(interrupted, state), "--fault", "after-arena-action"]);
  assert.equal(crashed.code, 91, crashed.stderr);
  const afterCrash = await readChecked(resolve(interrupted, "checkpoint.json"));
  assert.equal(afterCrash.current.actions.length, 62); assert.deepEqual(afterCrash.games, state.games);
  assert.deepEqual(afterCrash.current.actions.slice(0, 61), state.current.actions);
  const resumed = await run([...workerArgs(interrupted, state), "--max-new-units", "1"]);
  assert.equal(resumed.code, 75, resumed.stderr);
  const uninterrupted = await run([...workerArgs(clean, state), "--max-new-units", "2"]);
  assert.equal(uninterrupted.code, 75, uninterrupted.stderr);
  const actual = await readChecked(resolve(interrupted, "checkpoint.json"));
  const expected = await readChecked(resolve(clean, "checkpoint.json"));
  for (const value of [actual, expected]) {
    assert.equal(value.identity, identity); assert.equal(value.current.actions.length, 63);
    delete value.integrity; delete value.current.elapsedMs;
  }
  assert.deepEqual(actual, expected, "Two continued decisions must match clean continuation exactly");
  await completedUnchanged(interrupted, state); await completedUnchanged(clean, state); await originalsUnchanged(before);
  const report = { status: "PASS", scope: "Real frozen in-flight checkpoint; crash after durable action; deterministic resume vs clean continuation",
    originalIdentity: identity, originalCompletedGames: 77, originalCurrentActions: 61,
    crashExit: crashed.code, resumedExit: resumed.code, cleanExit: uninterrupted.code,
    resumedActions: 63, originalFilesUnchanged: true, completedGamesByteIdentical: true,
    comparisonExclusion: "Only execution elapsedMs and its enclosing integrity differ; all scientific state compared",
    command: "node web/tools/continue-hex-posttraining-v2.mjs test" };
  await writeNew(resolve(documents, "RECOVERY.json"), report); console.log(JSON.stringify(report));
}
async function prepare() {
  const recovery = await json(resolve(documents, "RECOVERY.json")); assert.equal(recovery.status, "PASS");
  const state = await validateSource(), before = await snapshot(source);
  await clone(destination, state); await originalsUnchanged(before);
  const report = { schema: "lifeline-hex-final-continuation-v1", source: relative(root, source), destination: relative(root, destination),
    originalIdentity: identity, originalCheckpointSha256: before["checkpoint.json"], initialCompletedGames: 77,
    initialCurrentGame: state.current.id, initialCurrentActions: 61, remainingGames: 13,
    originalFiles: before, copiedFiles: await snapshot(destination),
    excludedOperationalState: "Old supervisor state/job/logs and interrupted temporary checkpoint stay untouched in original root",
    budget: { remainingFinalSeconds: 1800, independentVerificationSeconds: 3600 },
    authorization: "User continuation request: 继续改进这些AI的能力; same frozen FINAL, new operational budget only",
    scientificProtocolChanged: false, newHoldout: false };
  await writeNew(resolve(documents, "COPY_MANIFEST.json"), report); console.log(JSON.stringify({ prepared: true, destination, remainingGames: 13 }));
}
async function launch(mode) {
  const manifest = await json(resolve(documents, "COPY_MANIFEST.json"));
  await originalsUnchanged(manifest.originalFiles);
  const state = await readChecked(resolve(destination, "checkpoint.json")); assert.equal(state.identity, identity);
  await completedUnchanged(destination, await validateSource());
  const isVerify = mode === "verify", runRoot = isVerify ? verification : destination;
  if (isVerify) assert.equal(state.phase, "complete");
  else assert.equal(state.current.actions.length, 61);
  await mkdir(runRoot, { recursive: true });
  const command = isVerify ? [process.execPath, "--unhandled-rejections=strict", verifier, "--run-root", destination,
    "--output-root", runRoot, "--max-seconds", "120"]
    : [process.execPath, "--unhandled-rejections=strict", worker, "--run-root", destination, "--config", config,
      "--candidate", state.candidatePath, "--max-seconds", "120"];
  const job = { schema: "lifeline-supervised-job-v1", run_root: runRoot, cwd: root, command,
    identity_files: [...SOURCE_FILES.map((p) => resolve(root, p)), self, verifier, config, state.parentPath, state.candidatePath,
      resolve(documents, "COPY_MANIFEST.json"), resolve(documents, "BUDGET_EXTENSION.md"),
      ...(isVerify ? [resolve(destination, "checkpoint.json"), resolve(destination, "summary.json")] : [])],
    max_wall_seconds: isVerify ? 3600 : 1800, worker_wall_seconds: 240, max_restarts: 3,
    max_no_progress_exits: 3, stop_grace_seconds: 3, poll_ms: 200 };
  const jobPath = resolve(runRoot, "job.json"); await writeNew(jobPath, job);
  const child = spawn(process.execPath, [supervisor, "--job", jobPath], { cwd: root, detached: true, windowsHide: true, stdio: "ignore" });
  child.unref(); console.log(JSON.stringify({ launched: true, mode, supervisorPid: child.pid, jobPath, hardBudgetSeconds: job.max_wall_seconds }));
}
async function collect() {
  const manifest = await json(resolve(documents, "COPY_MANIFEST.json")); await originalsUnchanged(manifest.originalFiles);
  const state = await readChecked(resolve(destination, "checkpoint.json")); assert.equal(state.phase, "complete");
  const report = await readChecked(resolve(verification, "report.json")); assert.equal(report.status, "PASS");
  assert.equal(report.games, 90); assert.equal(report.sourceIdentity, identity);
  await completedUnchanged(destination, await validateSource());
  for (const [directory, prefix, names] of [[destination, "final", ["summary.json", "supervisor-state.json", "job.json"]],
    [verification, "verification", ["report.json", "supervisor-state.json", "job.json"]]]) {
    for (const name of names) await copyFile(resolve(directory, name), resolve(documents, `${prefix}.${name}`), constants.COPYFILE_EXCL);
  }
  const summary = await readChecked(resolve(destination, "summary.json"));
  const receipt = { status: "COMPLETE_VERIFIED", originalIdentity: identity, evaluatedGames: 90, reusedCompletedGames: 77,
    newlyCompletedGames: 13, originalCurrentActionsPreserved: 61, originalFilesUnchanged: true,
    originalCompletedGamesByteIdentical: true, policyVerification: report,
    summarySha256: await fileHash(resolve(destination, "summary.json")), candidateSha256: state.identityData.candidate,
    promotion: summary.promotion, defaultsChanged: false, deployment: "NOT_RUN" };
  await writeNew(resolve(documents, "delivery-receipt.json"), receipt); console.log(JSON.stringify(receipt));
}
const mode = process.argv[2];
if (mode === "test") await test();
else if (mode === "prepare") await prepare();
else if (mode === "launch-final") await launch("final");
else if (mode === "launch-verify") await launch("verify");
else if (mode === "collect") await collect();
else throw new Error("Use test|prepare|launch-final|launch-verify|collect");
