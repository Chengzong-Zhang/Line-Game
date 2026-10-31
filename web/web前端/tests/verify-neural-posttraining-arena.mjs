import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { atomic, readJson, root, sha, sealed, unseal } from "../../tools/neural-posttraining-data.mjs";
import { verifyArena } from "../../tools/verify-neural-posttraining.mjs";
const base = resolve(root, `local_artifacts/neural-arena-recovery-${Date.now()}`);
await mkdir(base, { recursive: true });
const assetRoot = resolve(root, "web/web前端/assets/research-ai");
const parentSpecs = [
  (await readJson(resolve(assetRoot, "manifest.json"))).models.find((m) => m.model_kind === "grid_gnn"),
  (await readJson(resolve(assetRoot, "model-free-manifest.json"))).models[0],
];
const models = parentSpecs.map((m) => ({ ...m, id: `${m.id}-recovery-fixture`, parent_model_id: m.id,
  asset: resolve(assetRoot, m.asset) }));
const manifestPath = resolve(base, "candidate-manifest.json");
await atomic(manifestPath, { models });
const config = { ...await readJson(resolve(root, "web/tools/configs/neural-posttraining-arena-20261021.json")),
  sizes: [5], prefixesPerSize: 1 };
const configPath = resolve(base, "config.json"); await atomic(configPath, config);
function run(dir, extra = []) {
  const child = spawn(process.execPath, [resolve(root, "web/tools/neural-posttraining-arena.mjs"),
    "--run-root", dir, "--config", configPath, "--candidates", manifestPath, ...extra],
  { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", (v) => output += v); child.stderr.on("data", (v) => output += v);
  return { child, done: new Promise((accept) => child.on("exit", (code) => accept({ code, output }))) };
}
const resumed = resolve(base, "resumed"), clean = resolve(base, "clean");
const killed = run(resumed);
for (let i = 0; i < 1000; i++) {
  const p = await readJson(resolve(resumed, "progress.json"), true);
  if (p?.progress_units >= 2) break;
  assert.ok(i < 999); await new Promise((done) => setTimeout(done, 10));
}
killed.child.kill("SIGKILL"); await killed.done;
let result = await run(resumed, ["--max-new-units", "2"]).done; assert.equal(result.code, 75, result.output);
result = await run(resumed).done; assert.equal(result.code, 0, result.output);
result = await run(clean).done; assert.equal(result.code, 0, result.output);
assert.deepEqual(await readJson(resolve(resumed, "summary.json")), await readJson(resolve(clean, "summary.json")));
const cp = await readJson(resolve(clean, "checkpoint.json"));
for (const ref of cp.completed) {
  const a = await readJson(resolve(clean, ref.path)), b = await readJson(resolve(resumed, ref.path));
  delete a.activityMs; delete b.activityMs; assert.deepEqual(a, b);
}
const verified = await verifyArena(resumed, manifestPath);
assert.equal(verified.games, 4);
const first = resolve(resumed, cp.completed[0].path), game = await readJson(first);
game.outcome.candidateScore += 0.1; await atomic(first, game);
const tamperedCp = unseal(await readJson(resolve(resumed, "checkpoint.json")));
tamperedCp.completed[0].sha256 = sha(await readFile(first));
await atomic(resolve(resumed, "checkpoint.json"), sealed(tamperedCp));
await assert.rejects(verifyArena(resumed, manifestPath));
await atomic(resolve(base, "receipt.json"), { status: "PASS", realWorkerKill: true, resumedHistoryIdentical: true,
  boundedYield: true, completedGamesPreserved: true, semanticTamperRejected: true, models: 2,
  inference: "Shipped PUCT-16 and ModelFreeAI", command: "node --unhandled-rejections=strict web/web前端/tests/verify-neural-posttraining-arena.mjs" });
console.log(JSON.stringify({ status: "PASS", run: base }));
