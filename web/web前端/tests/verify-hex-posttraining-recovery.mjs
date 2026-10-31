import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, checked, sha256 } from "../../tools/three-player-arena-lib.mjs";
import { arenaSpecs, arenaSummary } from "../../tools/hex-posttrain-protocol.mjs";
import { playersFor } from "../../tools/hex-posttrain-core.mjs";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const base = resolve(root, `local_artifacts/hex-posttrain-v2-recovery-${Date.now()}`);
await mkdir(base, { recursive: true });
const config = JSON.parse(await readFile(resolve(root, "web/tools/configs/hex-player-policy-v2-train.json"), "utf8"));
Object.assign(config, { mode: "RECOVERY", counts: [4], stages: 1, fixtureStarts: ["BLACK"] });
config.optimizer.updatesPerStage = 2;
const configPath = resolve(base, "config.json");
await writeFile(configPath, JSON.stringify(config));
const runner = resolve(root, "web/tools/run-hex-posttraining.mjs"), verifier = resolve(root, "web/tools/verify-hex-posttraining.mjs");
const invoke = (name, extra = []) => [runner, "--config", configPath, "--run-root", resolve(base, name), "--max-seconds", "120", ...extra];
const run = (name, code, extra = []) => {
  const result = spawnSync(process.execPath, invoke(name, extra), { encoding: "utf8", timeout: 150000 });
  assert.equal(result.status, code, `${name}: ${result.stdout}\n${result.stderr}`);
  return result;
};
const json = async (name, file) => JSON.parse(await readFile(resolve(base, name, file), "utf8"));
const semantic = (game) => { const { integrity, elapsedMs, ...body } = game; return body; };
run("clean", 0);
const clean = await json("clean", "checkpoint.json");
async function same(name) {
  const state = await json(name, "checkpoint.json");
  assert.equal(state.phase, "complete"); assert.deepEqual(state.optimizer, clean.optimizer);
  assert.deepEqual(state.behaviors, clean.behaviors); assert.equal(state.selectedStage, clean.selectedStage);
  assert.deepEqual(state.games.map((x) => x.id), clean.games.map((x) => x.id));
  for (const { id } of clean.games) assert.deepEqual(semantic(await json(name, `games/${id}.json`)), semantic(await json("clean", `games/${id}.json`)));
}
for (const [fault, code] of [["after-train-action", 91], ["before-game-commit", 92],
  ["after-game-commit", 93], ["after-update", 94], ["after-arena-action", 91]]) {
  run(fault, code, ["--fault", fault]);
  const prior = fault === "after-game-commit" ? sha256(await readFile(resolve(base, fault, "games", `${clean.games[0].id}.json`))) : null;
  run(fault, 0); await same(fault);
  if (prior) assert.equal(sha256(await readFile(resolve(base, fault, "games", `${clean.games[0].id}.json`))), prior);
  if (fault === "before-game-commit") assert.equal((await readdir(resolve(base, fault, "interrupted"))).length, 1);
}
const modelHash = sha256(await readFile(resolve(base, "clean/hex-player-policy-v2.json")));
run("clean", 0); assert.equal(sha256(await readFile(resolve(base, "clean/hex-player-policy-v2.json"))), modelHash);
run("controls", 75, ["--max-new-units", "0"]);
await writeFile(resolve(base, "controls/PAUSE"), "");
run("controls", 75); assert.equal((await json("controls", "progress.json")).status, "PAUSED");
await writeFile(resolve(base, "controls/STOP"), "");
run("controls", 75); assert.equal((await json("controls", "progress.json")).status, "STOPPED");

const child = spawn(process.execPath, invoke("killed", ["--test-events"]), { stdio: ["ignore", "pipe", "pipe"] });
await new Promise((accept, reject) => {
  let buffer = "", handled = false;
  const timeout = setTimeout(() => { child.kill(); reject(new Error("Kill fixture timed out.")); }, 30000);
  child.once("error", reject);
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    for (const line of buffer.split("\n").slice(0, -1)) {
      if (!line.startsWith("CHECKPOINT ")) continue;
      const event = JSON.parse(line.slice(11));
      if (!handled && event.actions >= 5) {
        handled = true;
        const duplicate = run("killed", 75);
        assert.match(duplicate.stderr, /DUPLICATE_WORKER/);
        child.kill();
      }
    }
    buffer = buffer.split("\n").at(-1);
  });
  child.once("exit", () => { clearTimeout(timeout); handled ? accept() : reject(new Error("No durable action before kill.")); });
});
run("killed", 0); await same("killed");
const verify = spawnSync(process.execPath, [verifier, "--run-root", resolve(base, "clean")], { encoding: "utf8", timeout: 120000 });
assert.equal(verify.status, 0, verify.stderr);

const firstGamePath = resolve(base, "clean/games", `${clean.games[0].id}.json`), firstGameBytes = await readFile(firstGamePath);
await writeFile(firstGamePath, firstGameBytes.toString().replace('"terminal": true', '"terminal": false'));
run("clean", 78);
await writeFile(firstGamePath, firstGameBytes);
const changedConfig = resolve(base, "changed-config.json");
await writeFile(changedConfig, JSON.stringify({ ...config, prefixMoves: 3 }));
const drift = spawnSync(process.execPath, [runner, "--config", changedConfig, "--run-root", resolve(base, "clean")], { encoding: "utf8", timeout: 30000 });
assert.equal(drift.status, 78, drift.stderr);
// Verify a forged terminal area even after the fixture's local receipt seals are rebuilt.
const forged = JSON.parse(firstGameBytes); forged.outcome.areas.BLACK += 1;
const forgedChecked = checked(forged), checkpointPath = resolve(base, "clean/checkpoint.json"), originalCheckpoint = await readFile(checkpointPath);
const changedCheckpoint = JSON.parse(originalCheckpoint);
changedCheckpoint.games.find((g) => g.id === forged.id).integrity = forgedChecked.integrity;
await writeFile(firstGamePath, JSON.stringify(forgedChecked));
await writeFile(checkpointPath, JSON.stringify(checked(changedCheckpoint)));
const reject = spawnSync(process.execPath, [verifier, "--run-root", resolve(base, "clean"), "--output-root", resolve(base, "forged-verification")], { encoding: "utf8", timeout: 120000 });
assert.equal(reject.status, 78); assert.match(reject.stderr, /Fresh discrete terminal area/);
await writeFile(firstGamePath, firstGameBytes); await writeFile(checkpointPath, originalCheckpoint);

const finalConfig = JSON.parse(await readFile(resolve(root, "web/tools/configs/hex-player-policy-v2-final.json"), "utf8"));
const fake = arenaSpecs(finalConfig).map((spec) => ({ ...spec, terminal: true,
  outcome: { shares: Object.fromEntries(playersFor(spec.players).map((p) => [p, 1 / spec.players])) } }));
assert.equal(fake.length, 90); assert.equal(new Set(fake.map((g) => g.cluster)).size, 30);
const summary = arenaSummary(fake, finalConfig);
assert.equal(summary.promote, false); assert.equal(summary.meanDelta, 0);
fake[0].terminal = false; fake[0].outcome = null;
assert.equal(arenaSummary(fake, finalConfig).reason, "TRUNCATED");
console.log(JSON.stringify({ status: "PASS", evidenceRoot: base, fixtureGames: 4, fixtureUpdates: 2,
  checks: ["real-terminal-PPO", "full-RNG-Adam-resume", "atomic-orphan-adoption", "partial-write-isolation",
    "generation-optimization-arena-interruption", "actual-process-kill", "duplicate-exclusion", "PAUSE-STOP-budget",
    "immutable-output", "corruption-config-drift-rejection", "independent-policy-area-optimizer-replay", "FINAL-90-games-30-clusters"] }));
