import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, cp as copyTree, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { atomic, readJson, root, sha, sealed, unseal } from "../../tools/neural-posttraining-data.mjs";
import { verifyArena } from "../../tools/verify-neural-posttraining-v2.mjs";
const base = resolve(root, `local_artifacts/neural-arena-v2-recovery-${Date.now()}`);
await mkdir(base, { recursive: true });
const assetRoot = resolve(root, "web/web前端/assets/research-ai");
// Never mutate parent manifests/weights used by the concurrent frozen run.
const fixtureParents = resolve(base, "parent-manifests");
for (const name of ["manifest.json", "transfer-v1/manifest.json", "model-free-manifest.json"]) {
  const target = resolve(fixtureParents, name);
  await mkdir(resolve(target, ".."), { recursive: true });
  await writeFile(target, await readFile(resolve(assetRoot, name)));
}
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
  const child = spawn(process.execPath, [resolve(root, "web/tools/neural-posttraining-arena-v2.mjs"),
    "--run-root", dir, "--config", configPath, "--candidates", manifestPath,
    "--parent-manifests-root", fixtureParents, ...extra],
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
assert.equal(verified.summaryFieldsVerified, "all");

// Every parent manifest's original bytes participate in resume identity.
const checkpointBeforeDrift = await readFile(resolve(clean, "checkpoint.json"));
for (const name of ["manifest.json", "transfer-v1/manifest.json", "model-free-manifest.json"]) {
  const path = resolve(fixtureParents, name), bytes = await readFile(path);
  try {
    await writeFile(path, Buffer.concat([bytes, Buffer.from("\n")]));
    const rejected = await run(clean).done;
    assert.equal(rejected.code, 78, rejected.output);
    assert.match(rejected.output, /source\/model\/config drift/);
    assert.deepEqual(await readFile(resolve(clean, "checkpoint.json")), checkpointBeforeDrift);
  } finally { await writeFile(path, bytes); }
}

// Reconstruct the exact crash boundary: final game bytes committed, index not
// yet committed. Restore its already-saved terminal in-flight state.
async function orphanFixture(name) {
  const directory = resolve(base, name);
  await copyTree(clean, directory, { recursive: true });
  const checkpoint = unseal(await readJson(resolve(directory, "checkpoint.json")));
  const ref = checkpoint.completed.pop(), final = await readJson(resolve(directory, ref.path));
  const { terminal, truncated, outcome, ...pending } = final;
  checkpoint.current = pending; checkpoint.units--;
  await atomic(resolve(directory, "checkpoint.json"), sealed(checkpoint));
  return { directory, path: resolve(directory, ref.path) };
}
const orphan = await orphanFixture("valid-orphan");
const orphanBytes = await readFile(orphan.path), orphanMtime = (await stat(orphan.path)).mtimeMs;
result = await run(orphan.directory).done; assert.equal(result.code, 0, result.output);
assert.deepEqual(await readFile(orphan.path), orphanBytes);
assert.equal((await stat(orphan.path)).mtimeMs, orphanMtime, "A complete orphan must be adopted without rewriting.");
assert.deepEqual(await readJson(resolve(orphan.directory, "summary.json")), await readJson(resolve(clean, "summary.json")));
const corrupted = await orphanFixture("corrupt-orphan");
const broken = Buffer.from('{"broken":');
await writeFile(corrupted.path, broken);
const corruptCp = await readFile(resolve(corrupted.directory, "checkpoint.json"));
result = await run(corrupted.directory).done; assert.equal(result.code, 78, result.output);
assert.match(result.output, /Unindexed completed game does not match checkpoint/);
assert.deepEqual(await readFile(corrupted.path), broken, "Corrupt orphan bytes must remain available.");
assert.deepEqual(await readFile(resolve(corrupted.directory, "checkpoint.json")), corruptCp);

// Summary corruption must not hide behind valid total mean/terminal count.
const summaryPath = resolve(clean, "summary.json"), originalSummary = await readFile(summaryPath);
const mutations = [
  (s) => { s.models[0].wins++; },
  (s) => { s.models[0].draws++; },
  (s) => { s.models[0].losses++; },
  (s) => { s.models[0].perSize["5"] += 0.1; },
  (s) => { s.models[0].plannedGames++; },
  (s) => { s.models[0].truncatedGames++; },
  (s) => { s.models[0].parent_model_id = "wrong-parent"; },
  (s) => { s.decision = "auto promote"; },
];
for (const mutate of mutations) {
  try {
    const summary = JSON.parse(originalSummary); mutate(summary); await atomic(summaryPath, summary);
    await assert.rejects(verifyArena(clean, manifestPath), /Screen summary differs from independent reconstruction/);
  } finally { await writeFile(summaryPath, originalSummary); }
}
const first = resolve(resumed, cp.completed[0].path), game = await readJson(first);
game.outcome.candidateScore += 0.1; await atomic(first, game);
const tamperedCp = unseal(await readJson(resolve(resumed, "checkpoint.json")));
tamperedCp.completed[0].sha256 = sha(await readFile(first));
await atomic(resolve(resumed, "checkpoint.json"), sealed(tamperedCp));
await assert.rejects(verifyArena(resumed, manifestPath));
await atomic(resolve(base, "receipt.json"), { status: "PASS", realWorkerKill: true, resumedHistoryIdentical: true,
  boundedYield: true, completedGamesPreserved: true, semanticTamperRejected: true, models: 2,
  allThreeParentManifestDriftsRejected: true, productionParentAssetsReadOnly: true,
  completeOrphanAdoptedWithoutRewrite: true, corruptOrphanPreservedAndRejected: true,
  allSummaryFieldsVerified: true, corruptedSummaryColumnsRejected: mutations.length,
  inference: "Shipped PUCT-16 and ModelFreeAI", command: "node --unhandled-rejections=strict web/web前端/tests/verify-neural-posttraining-arena-v2.mjs" });
console.log(JSON.stringify({ status: "PASS", run: base }));
