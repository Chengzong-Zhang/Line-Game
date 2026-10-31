// One explicitly authorized operational reallocation, within the original
// 3600-second absolute campaign deadline. No scientific input is changed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256, readChecked } from "./three-player-arena-lib.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const base = resolve(root, "local_artifacts/hex-player-distill-v3");
const run = resolve(base, "train-20261021-r1"), docs = resolve(root, "docs/verification/hex-ai-distill-v3");
const read = async (p) => JSON.parse(await readFile(p));
const campaign = await read(resolve(base, "campaign.json")), jobPath = resolve(run, "job.json"), job = await read(jobPath);
const bytes = await readFile(resolve(run, "supervisor-state.json")), state = JSON.parse(bytes);
assert.equal(state.status, "BUDGET_EXHAUSTED"); assert.equal(state.active_attempt, null);
const checkpoint = await readChecked(resolve(run, "checkpoint.json"));
assert.equal(checkpoint.phase, "development"); assert.ok(checkpoint.games.length < 105);
assert.equal(job.max_wall_seconds, 650);
assert.ok(campaign.deadlineEpochMs - Date.now() >= 650000, "Not enough original campaign budget for this reallocation");
for (const [file, hash] of Object.entries(campaign.sources)) assert.equal(sha256(await readFile(file)), hash);
await writeFile(resolve(docs, "training.first-budget.supervisor-state.json"), bytes, { flag: "wx" });
await writeFile(resolve(docs, "budget-reallocation.json"), `${JSON.stringify({ status: "AUTHORIZED_ONCE",
  reason: "Actual development games exceed the initial phase allocation; reallocate within unchanged global budget",
  authorization: "Parent task explicitly approved one resume within the existing 3600-second absolute deadline",
  campaignDeadlineEpochMs: campaign.deadlineEpochMs, resumedAtEpochMs: Date.now(), newPhaseMaximumSeconds: 650,
  completedGamesPreserved: checkpoint.games.length, currentActionsPreserved: checkpoint.current.actions.length,
  scientificIdentity: checkpoint.identity, scientificInputsChanged: false,
  originalSupervisorSha256: sha256(bytes), command: "node web/tools/resume-hex-v3-development.mjs"
}, null, 2)}\n`, { flag: "wx" });
const child = spawn(process.execPath, [resolve(root, "web/tools/supervise-three-player-job.mjs"), "--job", jobPath, "--resume"],
  { cwd: root, detached: true, windowsHide: true, stdio: "ignore" }); child.unref();
console.log(JSON.stringify({ resumed: true, supervisorPid: child.pid, preservedGames: checkpoint.games.length, campaignDeadlineUnchanged: true }));
