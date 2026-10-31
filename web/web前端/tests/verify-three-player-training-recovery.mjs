import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const base = resolve(root, `local_artifacts/three-player-recovery-${Date.now()}`);
const resumedRoot = resolve(base, "resumed"), cleanRoot = resolve(base, "clean");
await mkdir(base, { recursive: true });
const trainer = resolve(root, "web/tools/train-three-player-ai.mjs");
function run(runRoot, extra = [], killAfterGame = false) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [trainer, "--run-root", runRoot, "--max-seconds", "30",
      "--output", resolve(base, "unused-model.json"), ...extra], { cwd: root, windowsHide: true });
    let text = "", stopped = false;
    const timer = setTimeout(() => { child.kill(); reject(new Error("Recovery fixture exceeded 30 seconds.")); }, 30000);
    child.stdout.on("data", (chunk) => {
      text += chunk;
      if (killAfterGame && !stopped && text.includes("game 1/36:")) { stopped = true; child.kill(); }
    });
    child.stderr.on("data", (chunk) => { text += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); accept({ code, text, stopped }); });
  });
}
const killed = await run(resumedRoot, [], true);
assert.equal(killed.stopped, true, "fixture must actually interrupt a live worker");
const checkpointPath = resolve(resumedRoot, "checkpoint.json");
const saved = JSON.parse(await readFile(checkpointPath, "utf8"));
assert.deepEqual(saved.completedGames, [0]);
await writeFile(`${checkpointPath}.tmp`, '{"incomplete":');
const resumed = await run(resumedRoot, ["--max-new-games", "1"]);
assert.equal(resumed.code, 0, resumed.text);
assert.match(resumed.text, /game 2\/36:/);
assert.doesNotMatch(resumed.text, /game 1\/36:/);
const clean = await run(cleanRoot, ["--max-new-games", "2"]);
assert.equal(clean.code, 0, clean.text);
const final = JSON.parse(await readFile(checkpointPath, "utf8"));
const reference = JSON.parse(await readFile(resolve(cleanRoot, "checkpoint.json"), "utf8"));
assert.deepEqual(final, reference, "interrupted/resumed data and checkpoint must equal a clean run");
assert.ok((await readdir(resumedRoot)).some((name) => name.includes(".interrupted-")));

const leasePort = 40000 + (parseInt(createHash("sha256").update(resumedRoot.toLowerCase()).digest("hex").slice(0, 8), 16) % 20000);
const lease = createServer();
await new Promise((accept, reject) => { lease.once("error", reject); lease.listen({ host: "127.0.0.1", port: leasePort, exclusive: true }, accept); });
try {
  const duplicate = await run(resumedRoot, ["--max-new-games", "0"]);
  assert.notEqual(duplicate.code, 0);
  assert.match(duplicate.text, /EADDRINUSE/);
} finally { await new Promise((accept) => lease.close(accept)); }

await writeFile(checkpointPath, JSON.stringify({ ...final, samples: [] }));
const corrupt = await run(resumedRoot, ["--max-new-games", "0"]);
assert.notEqual(corrupt.code, 0);
assert.match(corrupt.text, /Corrupt training checkpoint/);
await writeFile(checkpointPath, JSON.stringify({ ...final, identity: "wrong-source" }));
const drift = await run(resumedRoot, ["--max-new-games", "0"]);
assert.notEqual(drift.code, 0);
assert.match(drift.text, /source\/protocol mismatch/);
console.log(JSON.stringify({ status: "PASS", scope: "forced-exit-resume/exact-game-deduplication/partial-write-quarantine/duplicate-worker-exclusion/corruption-and-source-drift-rejection", completedGames: final.completedGames.length, samples: final.samples.length }, null, 2));
