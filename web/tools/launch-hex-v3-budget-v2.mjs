import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256, exists, readChecked } from "./three-player-arena-lib.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), mode = process.argv[2], self = fileURLToPath(import.meta.url);
const base = resolve(root, "local_artifacts/hex-player-distill-v3"), docs = resolve(root, "docs/verification/hex-ai-distill-v3");
const originalPath = resolve(base, "campaign.json"), extensionPath = resolve(base, "campaign-budget-v2.json");
const roots = Object.fromEntries(["train", "train-verification", "final", "final-verification"].map((x) => [x, resolve(base, `${x}-20261021-r1`)]));
const read = async (p) => JSON.parse(await readFile(p));
const originalBytes = await readFile(originalPath), original = JSON.parse(originalBytes);
const candidate = resolve(roots.train, "hex-player-policy-v3.json");
async function writeNew(path, value) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" }); }
for (const [file, hash] of Object.entries(original.sources)) assert.equal(sha256(await readFile(file)), hash);
if (mode === "extend") {
  assert.equal(await exists(resolve(roots.final, "checkpoint.json")), false, "Budget must be extended before new FINAL opens");
  const extension = { schema: "lifeline-hex-v3-budget-supplement-v2", authorizedAt: new Date().toISOString(),
    authorization: "Parent task authorized a pre-FINAL 900-second local CPU extension based on measured cost",
    rationale: "Previous FINAL cost approximately 2388 seconds, verification 796 seconds; new training/development adds approximately 900 seconds",
    originalCampaignSha256: sha256(originalBytes), startedEpochMs: original.startedEpochMs,
    originalDeadlineEpochMs: original.deadlineEpochMs, deadlineEpochMs: original.deadlineEpochMs + 900000,
    originalHardBudgetSeconds: 3600, hardBudgetSeconds: 4500, addedSeconds: 900, finalOpened: false,
    scientificInputsChanged: false, candidateSelectionChanged: false, thresholdsChanged: false };
  await writeNew(extensionPath, extension);
  await writeFile(resolve(docs, "campaign.original.json"), originalBytes, { flag: "wx" });
  await writeNew(resolve(docs, "BUDGET_SUPPLEMENT_V2.json"), extension);
  console.log(JSON.stringify(extension));
} else {
  const extension = await read(extensionPath); assert.equal(extension.originalCampaignSha256, sha256(originalBytes));
  assert.equal(extension.deadlineEpochMs, original.deadlineEpochMs + 900000); assert.equal(extension.startedEpochMs, original.startedEpochMs);
  if (mode === "collect") {
    for (const stage of Object.keys(roots)) for (const name of ["job.json", "supervisor-state.json", stage.endsWith("verification") ? "report.json" : "summary.json"]) {
      const path = resolve(roots[stage], name); if (await exists(path)) await copyFile(path, resolve(docs, `${stage}.${name}`), 1);
    }
    if (await exists(candidate)) await copyFile(candidate, resolve(docs, "hex-player-policy-v3.candidate.json"), 1);
    const final = await exists(resolve(roots.final, "summary.json")) ? await readChecked(resolve(roots.final, "summary.json")) : null;
    const verification = await exists(resolve(roots["final-verification"], "report.json")) ? await readChecked(resolve(roots["final-verification"], "report.json")) : null;
    await writeNew(resolve(docs, "delivery-receipt.json"), { status: verification?.status === "PASS" ? "COMPLETE_VERIFIED" : "INCOMPLETE",
      candidateSha256: await exists(candidate) ? sha256(await readFile(candidate)) : null, final, verification,
      hardBudgetSeconds: 4500, originalStartPreserved: true, defaultsChanged: false, deployed: false });
    console.log(JSON.stringify({ collected: true, verified: verification?.status === "PASS", promote: final?.promote ?? false }));
  } else {
    assert.ok(["train-verification", "final", "final-verification"].includes(mode));
    const remaining = Math.floor((extension.deadlineEpochMs - Date.now()) / 1000); assert.ok(remaining > 0, "Hard total deadline exhausted");
    assert.equal((await readChecked(resolve(roots.train, "checkpoint.json"))).phase, "complete");
    if (mode === "final") {
      assert.equal((await readChecked(resolve(roots["train-verification"], "report.json"))).status, "PASS");
      assert.equal((await read(resolve(docs, "FINAL_RECOVERY.json"))).status, "PASS");
    }
    if (mode === "final-verification") assert.equal((await readChecked(resolve(roots.final, "checkpoint.json"))).phase, "complete");
    const isVerify = mode.endsWith("verification"), isFinal = mode.startsWith("final"), source = roots[isFinal ? "final" : "train"];
    const worker = resolve(root, `web/tools/${isVerify ? "verify" : "run"}-hex-distillation-v3${isFinal ? "-final" : ""}.mjs`);
    const args = isVerify ? ["--run-root", source, "--output-root", roots[mode]]
      : ["--run-root", roots[mode], "--config", resolve(root, "web/tools/configs/hex-player-policy-v3-final.json"), "--candidate", candidate];
    const caps = { "train-verification": 250, final: 2400, "final-verification": 1000 };
    const job = { schema: "lifeline-supervised-job-v1", run_root: roots[mode], cwd: root,
      command: [process.execPath, "--unhandled-rejections=strict", worker, ...args, "--max-seconds", "120"],
      identity_files: [...Object.keys(original.sources), self, originalPath, extensionPath, candidate,
        ...(isVerify ? [resolve(source, "checkpoint.json"), resolve(source, "summary.json")] : [])],
      max_wall_seconds: Math.min(remaining, caps[mode]), worker_wall_seconds: 240, max_restarts: 3, max_no_progress_exits: 3,
      stop_grace_seconds: 3, poll_ms: 200 };
    const jobPath = resolve(roots[mode], "job.json"); await writeNew(jobPath, job);
    const child = spawn(process.execPath, [resolve(root, "web/tools/supervise-three-player-job.mjs"), "--job", jobPath],
      { cwd: root, detached: true, windowsHide: true, stdio: "ignore" }); child.unref();
    console.log(JSON.stringify({ launched: true, mode, supervisorPid: child.pid, hardBudgetSeconds: job.max_wall_seconds, totalRemainingSeconds: remaining }));
  }
}
