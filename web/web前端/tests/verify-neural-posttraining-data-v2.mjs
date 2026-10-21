import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, cp as copyTree, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { atomic, readJson, root, sha, sealed, unseal } from "../../tools/neural-posttraining-data-v2.mjs";
import { verifyData } from "../../tools/verify-neural-posttraining-v2.mjs";

const base = resolve(root, `local_artifacts/neural-data-v2-recovery-${Date.now()}`);
await mkdir(base, { recursive: true });
const config = { ...await readJson(resolve(root, "web/tools/configs/neural-posttraining-data-20261021.json")),
  sizes: [5], trainReplicates: 1, validationReplicates: 1, maximumPlies: 8 };
const configPath = resolve(base, "fixture.json");
await atomic(configPath, config);
const script = resolve(root, "web/tools/neural-posttraining-data-v2.mjs");
function run(directory) {
  const child = spawn(process.execPath, [script, "--run-root", directory, "--config", configPath, "--max-seconds", "30"],
    { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (value) => output += value);
  child.stderr.on("data", (value) => output += value);
  return { child, done: new Promise((accept, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Fixture exceeded its 45-second limit")); }, 45000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code) => { clearTimeout(timeout); accept({ code, output }); });
  }) };
}
const clean = resolve(base, "clean"), resumed = resolve(base, "resumed");
const interrupted = run(resumed);
let killed = false;
for (let count = 0; count < 1000; count++) {
  const progress = await readJson(resolve(resumed, "progress.json"), true);
  if (progress?.progress_units >= 1 && progress.status !== "COMPLETE") {
    interrupted.child.kill("SIGKILL"); killed = true; break;
  }
  await new Promise((done) => setTimeout(done, 10));
}
assert.equal(killed, true, "Must interrupt a real in-progress worker.");
await interrupted.done;
let result = await run(resumed).done; assert.equal(result.code, 0, result.output);
result = await run(clean).done; assert.equal(result.code, 0, result.output);
const manifest = await readJson(resolve(clean, "manifest.json"));
assert.deepEqual(manifest, await readJson(resolve(resumed, "manifest.json")));
for (const ref of manifest.episodes) assert.deepEqual(await readFile(resolve(clean, ref.path)), await readFile(resolve(resumed, ref.path)));
assert.equal((await verifyData(clean, configPath)).episodes, 2);

async function orphanFixture(name) {
  const directory = resolve(base, name);
  await copyTree(clean, directory, { recursive: true });
  const checkpoint = unseal(await readJson(resolve(directory, "checkpoint.json")));
  const ref = checkpoint.completed.pop(), episode = await readJson(resolve(directory, ref.path));
  const { terminal, truncated, rulesVersion, datasetIdentity, ...pending } = episode;
  checkpoint.current = pending; checkpoint.units--;
  await atomic(resolve(directory, "checkpoint.json"), sealed(checkpoint));
  return { directory, path: resolve(directory, ref.path) };
}
const orphan = await orphanFixture("valid-orphan");
const originalBytes = await readFile(orphan.path), originalMtime = (await stat(orphan.path)).mtimeMs;
result = await run(orphan.directory).done; assert.equal(result.code, 0, result.output);
assert.deepEqual(await readFile(orphan.path), originalBytes);
assert.equal((await stat(orphan.path)).mtimeMs, originalMtime);
assert.deepEqual(await readJson(resolve(orphan.directory, "manifest.json")), manifest);

const corrupt = await orphanFixture("corrupt-orphan"), broken = Buffer.from('{"broken":');
await writeFile(corrupt.path, broken);
const beforeCheckpoint = await readFile(resolve(corrupt.directory, "checkpoint.json"));
result = await run(corrupt.directory).done;
assert.equal(result.code, 78, result.output);
assert.match(result.output, /Unindexed completed episode does not match checkpoint/);
assert.deepEqual(await readFile(corrupt.path), broken);
assert.deepEqual(await readFile(resolve(corrupt.directory, "checkpoint.json")), beforeCheckpoint);
const receipt = { status: "PASS", scope: "future data-v2 entry; bounded two-episode fixture only",
  realWorkerKill: true, resumedEpisodesByteIdentical: true,
  completeOrphanAdoptedWithoutRewrite: true, corruptOrphanPreservedAndRejected: true,
  independentFixtureReplay: true, productionDataRegenerated: false,
  source_sha256: sha(await readFile(script)),
  command: "node --unhandled-rejections=strict web/web前端/tests/verify-neural-posttraining-data-v2.mjs" };
await atomic(resolve(base, "receipt.json"), receipt);
console.log(JSON.stringify({ status: "PASS", run: base, episodes: manifest.episodes.length }));
