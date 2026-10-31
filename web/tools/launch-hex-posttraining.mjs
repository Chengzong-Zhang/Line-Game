import { spawn } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCE_FILES } from "./hex-posttrain-protocol.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), args = process.argv.slice(2);
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const mode = option("--mode", "train"), runRoot = resolve(root, option("--run-root"));
if (!["train", "final", "verify"].includes(mode)) throw new Error("Use --mode train|final|verify.");
const configPath = resolve(root, `web/tools/configs/hex-player-policy-v2-${mode === "final" ? "final" : "train"}.json`);
const parent = resolve(root, "web/web前端/assets/research-ai/hex-player-policy-v1.json");
const candidate = option("--candidate", null) ? resolve(root, option("--candidate")) : null;
const sourceRun = option("--source-run", null) ? resolve(root, option("--source-run")) : null;
if (mode === "final" && !candidate) throw new Error("FINAL requires --candidate.");
if (mode === "verify" && !sourceRun) throw new Error("Verification requires --source-run.");
const command = mode === "verify"
  ? [process.execPath, "--unhandled-rejections=strict", resolve(root, "web/tools/verify-hex-posttraining.mjs"),
    "--run-root", sourceRun, "--output-root", runRoot, "--max-seconds", "120"]
  : [process.execPath, "--unhandled-rejections=strict", resolve(root, "web/tools/run-hex-posttraining.mjs"),
    "--run-root", runRoot, "--config", configPath, "--max-seconds", "120",
    ...(candidate ? ["--candidate", candidate] : [])];
const identityFiles = [...SOURCE_FILES.map((p) => resolve(root, p)), parent,
  resolve(root, "web/tools/verify-hex-posttraining.mjs"), resolve(root, "web/tools/launch-hex-posttraining.mjs"),
  ...(mode === "verify" ? [resolve(sourceRun, "checkpoint.json"), resolve(sourceRun, "summary.json")] : [configPath]),
  ...(candidate ? [candidate] : [])];
const job = { schema: "lifeline-supervised-job-v1", run_root: runRoot, cwd: root, command,
  identity_files: identityFiles, max_wall_seconds: 1800, worker_wall_seconds: 240,
  max_restarts: 3, max_no_progress_exits: 3, stop_grace_seconds: 3, poll_ms: 200 };
await mkdir(runRoot, { recursive: true });
const jobPath = resolve(runRoot, "job.json"), json = `${JSON.stringify(job, null, 2)}\n`;
try { const existing = await readFile(jobPath, "utf8"); if (existing !== json) throw new Error("Existing frozen job differs; use a new run root."); }
catch (error) { if (error.code !== "ENOENT") throw error; await writeFile(jobPath, json, { flag: "wx" }); }
const child = spawn(process.execPath, [resolve(root, "web/tools/supervise-three-player-job.mjs"), "--job", jobPath,
  ...(args.includes("--resume") ? ["--resume"] : [])], { cwd: root, detached: true, windowsHide: true, stdio: "ignore" });
child.unref();
console.log(JSON.stringify({ launched: true, supervisor_pid: child.pid, job: jobPath, hard_budget_seconds: 1800 }));
