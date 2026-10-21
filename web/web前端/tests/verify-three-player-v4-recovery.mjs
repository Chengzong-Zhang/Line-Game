import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, sha256, checked } from "../../tools/three-player-arena-lib.mjs";
import { GameEngine } from "../GameEngine.js";
import { saveState } from "../AIEngine.js";
import { ThreePlayerSearchAI } from "../ThreePlayerSearchAI.js";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const base = resolve(root, `local_artifacts/three-player-v4-recovery-${Date.now()}`);
await mkdir(base, { recursive: true });
const config = { schema: "lifeline-three-player-arena", version: 1, stage: "RECOVERY_TEST", sizes: [5],
  starters: ["BLACK"], prefixesPerCell: 1, prefixMoves: 4, seedNamespace: "three-player-v4/recovery/20261021",
  lineups: "paired", maxActions: 200, maxGameSeconds: 30, totalBudgetSeconds: 120 };
const configPath = resolve(base, "config.json");
await writeFile(configPath, JSON.stringify(config));
const candidatePath = resolve(root, "local_artifacts/three-player-v4-20261021/diagnostics/three-player-search-v4-round6.json");
const runner = resolve(root, "web/tools/evaluate-three-player-v4.mjs");
const verifier = resolve(root, "web/tools/verify-three-player-v4-arena.mjs");
const argv = (name, extra = []) => [runner, "--candidate", candidatePath, "--config", configPath,
  "--run-root", resolve(base, name), "--max-seconds", "30", ...extra];
const run = (name, expected, extra = []) => {
  const result = spawnSync(process.execPath, argv(name, extra), { encoding: "utf8", timeout: 45000, windowsHide: true });
  assert.equal(result.status, expected, `${name}: ${result.stdout}\n${result.stderr}`); return result;
};
const read = async (path) => JSON.parse(await readFile(path));
const games = async (name) => Promise.all((await readdir(resolve(base, name, "games")))
  .filter((file) => file.endsWith(".json")).sort().map(async (file) => read(resolve(base, name, "games", file))));
const semantic = ({ elapsedMs, candidateTimingsMs, integrity, identity, ...game }) => game;
const state = (name) => read(resolve(base, name, "progress.json"));
run("clean", 0); const clean = await games("clean"); assert.equal(clean.length, 7);
assert.ok(clean.every((game) => game.terminal));
for (const [name, fault, exit] of [["action", "after-action", 91], ["partial", "before-game-commit", 92], ["committed", "after-game-commit", 93]]) {
  run(name, exit, ["--fault", fault]);
  const committed = (await games(name))[0];
  const oldBytes = committed && await readFile(resolve(base, name, "games", `${committed.unit.id}.json`));
  const oldMtime = committed && (await stat(resolve(base, name, "games", `${committed.unit.id}.json`))).mtimeMs;
  run(name, 0);
  assert.deepEqual((await games(name)).map(semantic), clean.map(semantic));
  if (committed) {
    const path = resolve(base, name, "games", `${committed.unit.id}.json`);
    assert.deepEqual(await readFile(path), oldBytes); assert.equal((await stat(path)).mtimeMs, oldMtime);
  }
  if (name === "partial") assert.equal((await readdir(resolve(base, name, "interrupted"))).length, 1);
}
run("controls", 75, ["--max-new-games", "0"]);
await writeFile(resolve(base, "controls", "PAUSE"), ""); run("controls", 75); assert.equal((await state("controls")).status, "PAUSED");
await writeFile(resolve(base, "controls", "STOP"), ""); run("controls", 75); assert.equal((await state("controls")).status, "STOPPED");
const worker = spawn(process.execPath, argv("kill", ["--test-hold-ms", "1500"]), { stdio: "ignore", windowsHide: true });
const exited = new Promise((done) => worker.once("exit", done));
try {
  for (let i = 0; i < 100; i++) { try { if ((await state("kill")).status === "RUNNING") break; } catch {} await new Promise((done) => setTimeout(done, 20)); }
  assert.match(run("kill", 75).stderr, /DUPLICATE_WORKER/);
  let ready = false;
  for (let i = 0; i < 150; i++) {
    try { const active = await read(resolve(base, "kill", "active-game.json")); if (active.actions.length > 4) { ready = true; break; } } catch {}
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.equal(ready, true); worker.kill("SIGKILL"); await exited;
  run("kill", 0); assert.deepEqual((await games("kill")).map(semantic), clean.map(semantic));
} finally { worker.kill("SIGKILL"); }

const payload = JSON.parse(await readFile(candidatePath)), policy = new ThreePlayerSearchAI(payload);
const engine = new GameEngine({ gridSize: 5, playerCount: 3, rulesVersion: "territory-v2" });
const serial = () => JSON.stringify(saveState(engine), (_, value) => value instanceof Set ? [...value] : value instanceof Map ? [...value] : value);
const initial = serial(), flag = engine._isReplayingBatch;
const first = policy.getTopMoves(engine, engine.currentPlayer, 3);
assert.equal(serial(), initial); assert.equal(engine._isReplayingBatch, flag);
assert.deepEqual(policy.getTopMoves(engine, engine.currentPlayer, 3), first);
const originalUpdater = engine._updateTerritories;
engine._updateTerritories = () => {};
assert.deepEqual(policy.getTopMoves(engine, engine.currentPlayer, 3), first, "Worker updater suppression must not change canonical search scoring");
assert.equal(serial(), initial);
engine._updateTerritories = originalUpdater;
const old = engine._computeTerritory; engine._computeTerritory = () => { throw new Error("injected-leaf-error"); };
assert.throws(() => policy.getTopMoves(engine, engine.currentPlayer, 3), /injected-leaf-error/);
engine._computeTerritory = old; assert.equal(serial(), initial); assert.equal(engine._isReplayingBatch, flag);
const originalLegalMoves = engine.getLegalMoves;
engine.getLegalMoves = () => [];
assert.deepEqual(policy.getTopMoves(engine, engine.currentPlayer, 3), []);
assert.equal(policy.lastSearch.simulatedActions, 0);
engine.getLegalMoves = originalLegalMoves;
engine.gameOver = true;
assert.deepEqual(policy.getTopMoves(engine, engine.currentPlayer, 3), []);
assert.equal(policy.lastSearch.simulatedActions, 0);
engine.gameOver = false;
const verified = spawnSync(process.execPath, [verifier, "--run-root", resolve(base, "clean")], { encoding: "utf8", timeout: 45000, windowsHide: true });
assert.equal(verified.status, 0, verified.stderr);
const gamePath = resolve(base, "clean", "games", `${clean[0].unit.id}.json`), original = await readFile(gamePath);
const forged = JSON.parse(original); forged.metrics.areas.BLACK += 1;
await writeFile(gamePath, JSON.stringify(checked(forged)));
const reject = spawnSync(process.execPath, [verifier, "--run-root", resolve(base, "clean")], { encoding: "utf8", timeout: 45000, windowsHide: true });
assert.equal(reject.status, 78); assert.match(reject.stderr, /discrete area/);
await writeFile(gamePath, original);
const report = { status: "PASS_V4_RUNTIME_AND_RECOVERY", fixture: base, games: 7,
  checks: ["one-and-two-AI", "actual-kill-resume", "action-resume", "partial-isolation", "completed-game-byte-and-mtime-preservation",
    "pause-stop", "duplicate-exclusion", "deterministic-search", "complete-state-and-cache-restoration", "exception-restoration", "worker-suppressed-updater-parity", "full-policy-replay", "forged-score-rejection"],
  sources: Object.fromEntries(await Promise.all([runner, verifier, resolve(root, "web/web前端/ThreePlayerSearchAI.js"), fileURLToPath(import.meta.url)]
    .map(async (path) => [path, sha256(await readFile(path))]))) };
await writeFile(resolve(base, "receipt.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
