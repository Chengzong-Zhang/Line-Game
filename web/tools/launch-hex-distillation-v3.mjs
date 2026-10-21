import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readChecked, sha256, canonical, exists } from "./three-player-arena-lib.mjs";
import { TRAIN_SOURCES } from "./hex-distill-v3-core.mjs";
import { SOURCE_FILES } from "./hex-distill-v3-final-protocol.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), mode = process.argv[2];
const base = resolve(root, "local_artifacts/hex-player-distill-v3");
const documents = resolve(root, "docs/verification/hex-ai-distill-v3");
const roots = Object.fromEntries(["train", "train-verification", "final", "final-verification"].map((x) => [x, resolve(base, `${x}-20261021-r1`)]));
const candidate = resolve(roots.train, "hex-player-policy-v3.json");
const hash = async (p) => sha256(await readFile(p));
const self = fileURLToPath(import.meta.url), campaignPath = resolve(base, "campaign.json");
const paths = [...new Set([...TRAIN_SOURCES, ...SOURCE_FILES, "web/tools/verify-hex-distillation-v3.mjs", "web/tools/verify-hex-distillation-v3-final.mjs",
  "web/tools/launch-hex-distillation-v3.mjs", "web/tools/supervise-three-player-job.mjs", "web/tools/configs/hex-player-policy-v3-train.json",
  "web/tools/configs/hex-player-policy-v3-final.json", "web/web前端/tests/verify-hex-distillation-v3-recovery.mjs",
  "docs/verification/hex-ai-distill-v3/PROTOCOL.md"] )].map((x) => resolve(root, x));
async function writeNew(path, value) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" }); }
async function loadCampaign() {
  const campaign = JSON.parse(await readFile(campaignPath));
  for (const [p, h] of Object.entries(campaign.sources)) assert.equal(await hash(p), h, `Campaign source drift: ${p}`);
  return campaign;
}
async function testFinal() {
  const campaign = await loadCampaign(); assert.ok(campaign.deadlineEpochMs > Date.now());
  const input = await readChecked(resolve(roots.train, "checkpoint.json")); assert.equal(input.phase, "complete");
  const common = [resolve(root, "web/tools/run-hex-distillation-v3-final.mjs"), "--config", resolve(root, "web/tools/configs/hex-player-policy-v3-final.json"),
    "--candidate", candidate, "--max-seconds", "30"];
  async function run(name, extra, expected) {
    const dir = resolve(base, `final-recovery-${name}-20261021-r1`);
    const child = spawn(process.execPath, [...common, "--run-root", dir, ...extra], { cwd: root, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let errors = ""; child.stderr.on("data", (x) => { errors += x; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
    const code = await new Promise((r, j) => { child.once("error", j); child.once("close", r); }); clearTimeout(timer);
    assert.equal(code, expected, errors); return readChecked(resolve(dir, "checkpoint.json"));
  }
  await run("interrupted", ["--fault", "after-arena-action"], 91);
  const actual = await run("interrupted", ["--max-new-units", "6"], 75), clean = await run("clean", ["--max-new-units", "7"], 75);
  for (const state of [actual, clean]) { delete state.integrity; delete state.current.elapsedMs; }
  assert.deepEqual(actual, clean); assert.equal(actual.current.actions.length, 7);
  await writeNew(resolve(documents, "FINAL_RECOVERY.json"), { status: "PASS", frozenCandidate: await hash(candidate), actions: 7,
    trueProcessExit: 91, continuedExit: 75, sameScientificState: true, elapsedTimeExcluded: true });
  console.log(JSON.stringify({ status: "PASS", test: "v3-final-recovery" }));
}
async function launch() {
  assert.ok(Object.hasOwn(roots, mode), "Use train|train-verification|final|final-verification|test-final|collect");
  await mkdir(base, { recursive: true });
  if (mode === "train" && !(await exists(campaignPath))) {
    assert.equal((await readChecked(resolve(documents, "RECOVERY.json"))).status, "PASS");
    const sources = Object.fromEntries(await Promise.all(paths.map(async (p) => [p, await hash(p)])));
    await writeNew(campaignPath, { schema: "lifeline-hex-v3-campaign-v1", startedEpochMs: Date.now(), deadlineEpochMs: Date.now() + 3600 * 1000,
      hardBudgetSeconds: 3600, sources, authorization: "Continue improving AI; local 3600 second v3 campaign; no deployment" });
  }
  const campaign = await loadCampaign(), remaining = Math.floor((campaign.deadlineEpochMs - Date.now()) / 1000);
  assert.ok(remaining > 0, "Campaign hard budget exhausted");
  const runRoot = roots[mode], isVerify = mode.endsWith("verification"), isFinal = mode.startsWith("final");
  if (mode !== "train") assert.equal((await readChecked(resolve(roots.train, "checkpoint.json"))).phase, "complete");
  if (mode === "final") {
    assert.equal((await readChecked(resolve(roots["train-verification"], "report.json"))).status, "PASS");
    assert.equal(JSON.parse(await readFile(resolve(documents, "FINAL_RECOVERY.json"))).status, "PASS");
  }
  if (mode === "final-verification") assert.equal((await readChecked(resolve(roots.final, "checkpoint.json"))).phase, "complete");
  const worker = resolve(root, `web/tools/${isVerify ? "verify" : "run"}-hex-distillation-v3${isFinal ? "-final" : ""}.mjs`);
  const args = isVerify ? ["--run-root", roots[isFinal ? "final" : "train"], "--output-root", runRoot]
    : ["--run-root", runRoot, ...(isFinal ? ["--config", resolve(root, "web/tools/configs/hex-player-policy-v3-final.json"), "--candidate", candidate] : [])];
  const caps = { train: 650, "train-verification": 250, final: 2200, "final-verification": 1000 };
  const job = { schema: "lifeline-supervised-job-v1", run_root: runRoot, cwd: root,
    command: [process.execPath, "--unhandled-rejections=strict", worker, ...args, "--max-seconds", "120"],
    identity_files: [...paths, campaignPath, ...(mode === "train" ? [] : [candidate]),
      ...(isVerify ? [resolve(roots[isFinal ? "final" : "train"], "checkpoint.json"), resolve(roots[isFinal ? "final" : "train"], "summary.json")] : [])],
    max_wall_seconds: Math.min(remaining, caps[mode]), worker_wall_seconds: 240, max_restarts: 3, max_no_progress_exits: 3,
    stop_grace_seconds: 3, poll_ms: 200 };
  const jobPath = resolve(runRoot, "job.json"); await writeNew(jobPath, job);
  const child = spawn(process.execPath, [resolve(root, "web/tools/supervise-three-player-job.mjs"), "--job", jobPath],
    { cwd: root, detached: true, windowsHide: true, stdio: "ignore" }); child.unref();
  console.log(JSON.stringify({ launched: true, mode, supervisorPid: child.pid, hardBudgetSeconds: job.max_wall_seconds, campaignRemainingSeconds: remaining }));
}
async function collect() {
  const campaign = await loadCampaign();
  for (const mode of Object.keys(roots)) for (const name of ["job.json", "supervisor-state.json", mode.endsWith("verification") ? "report.json" : "summary.json"]) {
    const path = resolve(roots[mode], name); if (await exists(path)) await copyFile(path, resolve(documents, `${mode}.${name}`), 1);
  }
  await copyFile(campaignPath, resolve(documents, "campaign.json"), 1);
  if (await exists(candidate)) await copyFile(candidate, resolve(documents, "hex-player-policy-v3.candidate.json"), 1);
  const final = await exists(resolve(roots.final, "summary.json")) ? await readChecked(resolve(roots.final, "summary.json")) : null;
  const verification = await exists(resolve(roots["final-verification"], "report.json")) ? await readChecked(resolve(roots["final-verification"], "report.json")) : null;
  await writeNew(resolve(documents, "delivery-receipt.json"), { status: verification?.status === "PASS" ? "COMPLETE_VERIFIED" : "INCOMPLETE",
    candidateSha256: await exists(candidate) ? await hash(candidate) : null, final, verification, hardBudgetSeconds: campaign.hardBudgetSeconds,
    defaultsChanged: false, deployed: false });
  console.log(JSON.stringify({ collected: true, complete: verification?.status === "PASS", promote: final?.promote ?? false }));
}
if (mode === "test-final") await testFinal(); else if (mode === "collect") await collect(); else await launch();
