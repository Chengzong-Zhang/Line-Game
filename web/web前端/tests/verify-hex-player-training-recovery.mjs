import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, readdir, access } from "node:fs/promises";
import { resolve } from "node:path";

const base = resolve("local_artifacts");
await mkdir(base, { recursive: true });
const root = await mkdtemp(resolve(base, "hex-ai-recovery-"));
const script = resolve("web/tools/train-hex-player-ai.mjs");
const exists = async (path) => { try { await access(path); return true; } catch { return false; } };
function launch(name, extra = []) {
  const runRoot = resolve(root, name);
  // Omit --output deliberately: a nonrelease run must default to its own folder.
  const child = spawn(process.execPath, [script, "--profile", "recovery", "--run-root", runRoot,
    "--max-seconds", "30", ...extra], { windowsHide: true });
  let output = "";
  child.stdout.on("data", (value) => { output += value; });
  child.stderr.on("data", (value) => { output += value; });
  const finished = new Promise((accept, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => accept({ code, output }));
  });
  return { child, finished, runRoot };
}
async function run(name, extra = [], expected = 0) {
  const result = await launch(name, extra).finished;
  assert.equal(result.code, expected, result.output);
  return result;
}
const read = async (name, file) => JSON.parse(await readFile(resolve(root, name, file), "utf8"));
await run("clean");
await run("resume", ["--max-new-games", "1"], 75);
const partial = await read("resume", "checkpoint.json");
assert.equal(partial.completedGames.length, 1);
await writeFile(resolve(root, "resume", "checkpoint.json.tmp"), '{"incomplete":');
await run("resume", ["--supervise", "--crash-after-games", "3", "--crash-after-epoch", "2"]);
const clean = await read("clean", "checkpoint.json");
const restored = await read("resume", "checkpoint.json");
assert.deepEqual(restored.completedGames, clean.completedGames);
assert.deepEqual(restored.samples, clean.samples);
assert.deepEqual(restored.weights, clean.weights);
assert.equal(restored.trained, true);
assert.deepEqual(await read("resume", "model.json"), await read("clean", "model.json"));
assert.ok((await readdir(resolve(root, "resume"))).some((name) => name.includes(".interrupted-")));
const supervisor = await read("resume", "supervisor.json");
assert.deepEqual(supervisor.attempts.map((attempt) => attempt.exitCode), [77, 77, 0]);
assert.equal(supervisor.status, "COMPLETE");

for (const marker of ["STOP", "PAUSE"]) {
  const name = marker.toLowerCase();
  await mkdir(resolve(root, name));
  await writeFile(resolve(root, name, marker), "owner control\n");
  await run(name, ["--supervise"], 75);
  assert.equal(await exists(resolve(root, name, "checkpoint.json")), false);
  assert.equal((await read(name, "supervisor.json")).status, marker);
}
// Existing completed output also respects an explicit later stop request.
await writeFile(resolve(root, "clean", "STOP"), "stop before repeat export\n");
await run("clean", [], 75);

const first = launch("duplicate", ["--hold-ms", "1000", "--max-new-games", "0"]);
for (let index = 0; index < 100 && !await exists(resolve(first.runRoot, "run.lock")); index += 1) {
  await new Promise((accept) => setTimeout(accept, 20));
}
assert.equal(await exists(resolve(first.runRoot, "run.lock")), true);
await run("duplicate", [], 73);
assert.equal((await first.finished).code, 75);

await run("corrupt", ["--max-new-games", "1"], 75);
const damaged = await read("corrupt", "checkpoint.json");
damaged.weights[0] = 999;
await writeFile(resolve(root, "corrupt", "checkpoint.json"), JSON.stringify(damaged));
await run("corrupt", ["--supervise"], 78);
assert.equal((await read("corrupt", "supervisor.json")).attempts.length, 1);
await run("mismatch", ["--max-new-games", "1"], 75);
const drift = await read("mismatch", "checkpoint.json");
drift.identity = "changed-source";
await writeFile(resolve(root, "mismatch", "checkpoint.json"), JSON.stringify(drift));
await run("mismatch", [], 78);
await run("retry-limit", ["--supervise", "--fail-before-progress"], 77);
const retryLimit = await read("retry-limit", "supervisor.json");
assert.equal(retryLimit.status, "RETRY-LIMIT");
assert.equal(retryLimit.attempts.length, 3);
console.log(JSON.stringify({
  status: "PASS", runRoot: root, recoveredEpisodes: restored.completedGames.length,
  checks: ["generation checkpoint resume", "partial-write quarantine", "unexpected worker restart",
    "epoch checkpoint resume", "bit-identical model", "duplicate lease", "STOP", "PAUSE",
    "corruption rejection", "source identity rejection", "bounded supervisor retries", "nonrelease output isolation"],
}));
