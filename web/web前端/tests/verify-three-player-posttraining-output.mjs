import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const base = resolve(root, `local_artifacts/three-player-output-verifier-${Date.now()}`);
const clean = resolve(base, "clean");
const configPath = resolve(base, "config.json");
const trainer = resolve(root, "web/tools/finetune-three-player-ai.mjs");
const verifier = resolve(root, "web/tools/verify-three-player-posttraining.mjs");
await mkdir(base, { recursive: true });
const config = JSON.parse(await readFile(resolve(root, "web/tools/configs/three-player-policy-v2.json"), "utf8"));
config.sizes = [5]; config.starts = ["BLACK"]; config.trainingReplicates = 1; config.validationReplicates = 1;
config.maximumEpisodePlies = 8; config.optimizer.epochs = 3; config.candidateEpochs = [1, 3];
config.development.maximumGamePlies = 80;
await writeFile(configPath, JSON.stringify(config));
const read = async (path) => JSON.parse(await readFile(path, "utf8"));
const hash = (value) => createHash("sha256").update(value).digest("hex");
async function writeSealed(path, value) {
  const { integrity, ...body } = value;
  const result = { ...body, integrity: hash(JSON.stringify(body)) };
  await writeFile(path, JSON.stringify(result));
  return result;
}
function run(script, runRoot) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, ["--unhandled-rejections=strict", script, "--run-root", runRoot, "--config", configPath],
      { cwd: root, windowsHide: true });
    let output = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Output verification fixture exceeded 30 seconds.")); }, 30000);
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code) => { clearTimeout(timeout); accept({ code, output }); });
  });
}
const trained = await run(trainer, clean);
assert.equal(trained.code, 0, trained.output);
const verified = await run(verifier, clean);
assert.equal(verified.code, 0, verified.output);
const cases = [{ case: "complete-fixture-independent-replay", pass: true }];
for (const kind of ["feature", "candidate", "development"]) {
  const altered = resolve(base, kind);
  await cp(clean, altered, { recursive: true, errorOnExist: true });
  const checkpointPath = resolve(altered, "checkpoint.json");
  const checkpoint = await read(checkpointPath);
  if (kind === "feature") {
    const record = checkpoint.completedEpisodes[0], episodePath = resolve(altered, "episodes", `${record.id}.json`);
    const episode = await read(episodePath);
    episode.samples[0].features[0][0] += 0.01;
    record.integrity = (await writeSealed(episodePath, episode)).integrity;
  } else if (kind === "candidate") {
    const record = checkpoint.candidates[0], candidatePath = resolve(altered, "candidates", `epoch-${record.epoch}.json`);
    const candidate = await read(candidatePath);
    candidate.weights[0] += 0.01;
    record.integrity = (await writeSealed(candidatePath, candidate)).integrity;
  } else checkpoint.developmentResults[0].outcome.scores.BLACK++;
  // Reseal all modified evidence so these test semantic verification, not just
  // whether a byte checksum mismatch is detected.
  await writeSealed(checkpointPath, checkpoint);
  const rejected = await run(verifier, altered);
  assert.equal(rejected.code, 1, `${kind} corruption was not rejected: ${rejected.output}`);
  assert.match(rejected.output, kind === "feature" ? /features/ : kind === "candidate" ? /Candidate 1 weights/ : /Development outcome/);
  cases.push({ case: `resealed-${kind}-corruption-rejected`, pass: true });
}
const report = { status: "PASS_OUTPUT_VERIFIER_FIXTURES", cases, full_training_started_by_this_test: false,
  verifier_sha256: hash(await readFile(verifier)), test_sha256: hash(await readFile(fileURLToPath(import.meta.url))),
  scope: "A fresh two-episode fixture and independently resealed feature, optimizer-candidate and development-outcome corruption.",
  artifact_directory: base };
await writeFile(resolve(base, "verification-summary.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
