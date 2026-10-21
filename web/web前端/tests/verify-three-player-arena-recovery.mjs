import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonical, sha256, checked, buildUnits, summarize, loadRuntime,
  newEngine, applyAction, createPrefix, terminalMetrics,
} from "../../tools/three-player-arena-lib.mjs";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const base = resolve(root, `local_artifacts/three-player-ai-v2-arena/recovery-${Date.now()}`);
await mkdir(base, { recursive: true });
const config = {
  schema: "lifeline-three-player-arena", version: 1, stage: "RECOVERY_TEST", sizes: [5],
  starters: ["BLACK"], prefixesPerCell: 1, prefixMoves: 3,
  seedNamespace: "lifeline-three-player-v2/recovery-test", lineups: "control",
  maxActions: 200, maxGameSeconds: 30, totalBudgetSeconds: 120,
};
const configPath = resolve(base, "config.json");
await writeFile(configPath, JSON.stringify(config));
const modelPath = resolve(root, "web/web前端/assets/research-ai/three-player-policy-v1.json");
const runner = resolve(root, "web/tools/evaluate-three-player-ai.mjs");
const verifier = resolve(root, "web/tools/verify-three-player-arena.mjs");
const runArgs = (name, extra = []) => [
  runner, "--candidate", modelPath, "--config", configPath, "--run-root", resolve(base, name),
  "--max-seconds", "30", ...extra,
];
const run = (name, expected, extra = []) => {
  const result = spawnSync(process.execPath, runArgs(name, extra), { encoding: "utf8", timeout: 45000 });
  assert.equal(result.status, expected, `${name}: ${result.stdout}\n${result.stderr}`);
  return result;
};
const onlyGame = async (name) => {
  const directory = resolve(base, name, "games");
  const files = (await readdir(directory)).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 1);
  return JSON.parse(await readFile(resolve(directory, files[0]), "utf8"));
};
const state = async (name) => JSON.parse(await readFile(resolve(base, name, "progress.json"), "utf8"));
const semantic = ({ elapsedMs, integrity, identity, ...game }) => game;
run("clean", 0);
const clean = await onlyGame("clean");
for (const [name, fault, exit] of [
  ["after-action", "after-action", 91],
  ["before-game", "before-game-commit", 92],
  ["after-game", "after-game-commit", 93],
]) {
  run(name, exit, ["--fault", fault]);
  let committedHash;
  if (name === "after-game") committedHash = sha256(await readFile(resolve(base, name, "games", `${clean.unit.id}.json`)));
  run(name, 0);
  assert.deepEqual(semantic(await onlyGame(name)), semantic(clean), `${name}: resume must match clean game`);
  if (committedHash) assert.equal(sha256(await readFile(resolve(base, name, "games", `${clean.unit.id}.json`))), committedHash,
    "already committed game must never be rewritten or replayed");
  if (name === "before-game") assert.equal((await readdir(resolve(base, name, "interrupted"))).length, 1);
}
run("paused", 75, ["--max-new-games", "0"]);
await writeFile(resolve(base, "paused", "PAUSE"), "");
run("paused", 75); assert.equal((await state("paused")).status, "PAUSED");
await writeFile(resolve(base, "paused", "STOP"), "");
run("paused", 75); assert.equal((await state("paused")).status, "STOPPED");

const child = spawn(process.execPath, runArgs("duplicate", ["--test-hold-ms", "4000"]), { stdio: "ignore" });
try {
  for (let i = 0; i < 50; i += 1) {
    try { if ((await state("duplicate")).status === "RUNNING") break; } catch {}
    await new Promise((accept) => setTimeout(accept, 40));
  }
  const result = run("duplicate", 75);
  assert.match(result.stderr, /DUPLICATE_WORKER/);
  child.kill();
  await new Promise((accept) => child.once("exit", accept));
  run("duplicate", 0);
  assert.deepEqual(semantic(await onlyGame("duplicate")), semantic(clean));
} finally { child.kill(); }

const verify = spawnSync(process.execPath, [verifier, "--run-root", resolve(base, "clean")], { encoding: "utf8", timeout: 30000 });
assert.equal(verify.status, 0, verify.stderr);
const gamePath = resolve(base, "clean", "games", `${clean.unit.id}.json`);
const before = await readFile(gamePath, "utf8");
await writeFile(gamePath, before.replace('"terminal": true', '"terminal": false'));
run("clean", 78);
await writeFile(gamePath, before);
const tampered = JSON.parse(before);
tampered.metrics.areas.BLACK += 1;
await writeFile(gamePath, JSON.stringify(checked(tampered)));
const rejectForgedArea = spawnSync(process.execPath, [verifier, "--run-root", resolve(base, "clean")], { encoding: "utf8", timeout: 30000 });
assert.equal(rejectForgedArea.status, 78);
assert.match(rejectForgedArea.stderr, /discrete area/);

// Terminal metrics must refresh an intentionally stale territory cache.
const runtime = await loadRuntime(resolve(root, "web/web前端"));
const engine = newEngine(runtime, clean.unit);
for (const action of clean.actions) applyAction(engine, action);
engine.cachedTerritories = Object.fromEntries(["BLACK", "WHITE", "PURPLE"].map((p) => [p, { area: 999, displayArea: 999, polygon: [] }]));
engine._territoryCacheRevision = -1;
assert.deepEqual(terminalMetrics(engine), clean.metrics);
assert.ok(new Set(Object.values(clean.metrics.areas)).size > 1, "non-draw fixture must exercise fresh scoring");

// The cluster bootstrap must be invariant to normal, filename and resumed order.
const pairedConfig = { ...config, sizes: [5, 7, 9], starters: ["BLACK", "WHITE", "PURPLE"], prefixesPerCell: 2, lineups: "paired",
  promotion: { minimumMeanDelta: 0.04, minimumSizeDelta: -0.05, bootstrapReplicates: 1000 } };
const fakeRecords = buildUnits(pairedConfig).map((unit, i) => ({
  unit, terminal: true, metrics: {
    sharedWin: { BLACK: i % 3 === 0 ? 1 : 0, WHITE: i % 3 === 1 ? 1 : 0, PURPLE: i % 3 === 2 ? 1 : 0 },
    pairwise: { BLACK: (i % 3) / 2, WHITE: ((i + 1) % 3) / 2, PURPLE: ((i + 2) % 3) / 2 },
  },
}));
assert.equal(canonical(summarize(fakeRecords, pairedConfig)), canonical(summarize([...fakeRecords].reverse(), pairedConfig)));
console.log(JSON.stringify({
  status: "PASS", checks: [
    "clean-resume-equality", "action-checkpoint-recovery", "partial-write-isolation", "committed-game-no-rerun",
    "pause-stop", "duplicate-worker-exclusion", "killed-process-resume", "corrupt-record-refusal",
    "forged-area-independent-verification", "fresh-terminal-area", "cluster-order-invariance",
  ], evidenceRoot: base,
}));
