// Dispatch the already authorized verification as soon as FINAL completes,
// avoiding a human polling gap while preserving the absolute hard deadline.
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), base = resolve(root, "local_artifacts/hex-player-distill-v3");
const read = async (p) => JSON.parse(await readFile(p));
const receipt = resolve(base, "queued-final-verification.receipt.json");
await writeFile(resolve(base, "queued-final-verification.claim.json"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx" });
const budget = await read(resolve(base, "campaign-budget-v2.json"));
let result;
while (!result) {
  if (Date.now() >= budget.deadlineEpochMs) { result = { status: "BUDGET_EXHAUSTED", launched: false }; break; }
  const state = await read(resolve(base, "final-20261021-r1/supervisor-state.json"));
  if (state.status === "COMPLETE") {
    const child = spawn(process.execPath, [resolve(root, "web/tools/launch-hex-v3-budget-v2.mjs"), "final-verification"],
      { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", (x) => { stdout += x; }); child.stderr.on("data", (x) => { stderr += x; });
    const code = await new Promise((done, fail) => { child.once("error", fail); child.once("close", done); });
    result = { status: code === 0 ? "DISPATCHED" : "LAUNCH_FAILED", code, stdout, stderr, dispatchedAt: new Date().toISOString() };
  } else if (["FATAL", "RETRY_EXHAUSTED", "BUDGET_EXHAUSTED", "PAUSED", "STOPPED", "INTERRUPTED"].includes(state.status)) {
    result = { status: state.status, launched: false };
  }
  if (!result) await new Promise((done) => setTimeout(done, 1000));
}
await writeFile(receipt, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
