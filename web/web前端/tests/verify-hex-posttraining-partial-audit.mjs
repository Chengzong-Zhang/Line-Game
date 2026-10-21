import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomic, canonical, sha256, readChecked } from "../../tools/three-player-arena-lib.mjs";
import { engineFor, apply, policy, outcome, rng } from "../../tools/hex-posttrain-core.mjs";
import { SOURCE_FILES, readModel, arenaSpecs } from "../../tools/hex-posttrain-protocol.mjs";
const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const base = resolve(root, `local_artifacts/hex-partial-audit-fixture-${Date.now()}`), source = resolve(base, "source");
await mkdir(source, { recursive: true });
const configPath = resolve(root, "web/tools/configs/hex-player-policy-v2-final.json"), configBytes = await readFile(configPath), config = JSON.parse(configBytes);
const parentPath = resolve(root, "web/web前端/assets/research-ai/hex-player-policy-v1.json");
const candidatePath = resolve(root, "docs/verification/hex-ai-posttrain-v2/hex-player-policy-v2.candidate.json");
const parent = await readModel(parentPath, "hex-player-policy-v1"), candidate = await readModel(candidatePath, "hex-player-policy-v2");
const sources = Object.fromEntries(await Promise.all(SOURCE_FILES.map(async (p) => [p, sha256(await readFile(resolve(root, p)))])));
const identityData = { schema: "lifeline-hex-posttraining-identity-v1", config: sha256(configBytes), sources, parent: parent.hash, candidate: candidate.hash };
const identity = sha256(canonical(identityData)), specs = arenaSpecs(config), games = [];
let current;
for (const [index, spec] of specs.slice(0, 3).entries()) {
  const engine = engineFor(spec), random = rng(spec.seed), actions = [];
  while (!engine.gameOver && (index < 2 || actions.length < 8)) {
    const actor = engine.currentPlayer, legal = engine.getLegalMoves();
    const point = !legal.length ? null : actions.length < config.prefixMoves ? legal[Math.floor(random.next() * legal.length)].point
      : policy(engine, spec.seats.includes(actor) ? candidate.model.weights : parent.model.weights)[0].point;
    const action = { actor, point }; apply(engine, action); actions.push(action);
    assert.ok(actions.length < config.maxActions);
  }
  if (index < 2) {
    assert.equal(engine.gameOver, true);
    await atomic(resolve(source, "games", `${spec.id}.json`), { identity, ...spec, actions, samples: [], rngState: random.state,
      elapsedMs: 0, terminal: true, outcome: outcome(engine) });
    games.push({ id: spec.id, integrity: (await readChecked(resolve(source, "games", `${spec.id}.json`))).integrity });
  } else current = { id: spec.id, actions, samples: [], rngState: random.state, elapsedMs: 0 };
}
const checkpoint = { identity, identityData, config, parentPath, candidatePath, phase: "final", games, current };
await atomic(resolve(source, "checkpoint.json"), checkpoint);
await writeFile(resolve(source, "supervisor-state.json"), JSON.stringify({ status: "BUDGET_EXHAUSTED", worker_pid: null, fixture: true }));
const verifier = resolve(root, "web/tools/verify-hex-posttraining-partial.mjs");
const run = (name, code, seconds = "120") => {
  const result = spawnSync(process.execPath, [verifier, "--run-root", source, "--output-root", resolve(base, name), "--max-seconds", seconds],
    { encoding: "utf8", timeout: 150000 });
  assert.equal(result.status, code, result.stderr); return result;
};
run("clean", 0);
const report = await readChecked(resolve(base, "clean/report.json"));
assert.equal(report.status, "PASS_COMPLETED_PREFIX_ONLY"); assert.equal(report.indexedCompletedGames, 2);
assert.equal(report.terminalGames, 2); assert.equal(report.remainingGames, 88);
assert.equal(report.inFlight.actions, 8); assert.equal(report.promote, false); assert.equal(report.meanDelta, null); assert.equal(report.bootstrap95, null);
run("resumed", 75, "0.001"); run("resumed", 0);
assert.deepEqual(await readChecked(resolve(base, "resumed/report.json")), report);
await mkdir(resolve(base, "paused"), { recursive: true }); await writeFile(resolve(base, "paused/PAUSE"), "");
run("paused", 75);
assert.equal((await readChecked(resolve(base, "paused/progress.json"))).status, "PAUSED");
await writeFile(resolve(source, "supervisor-state.json"), JSON.stringify({ status: "RUNNING", worker_pid: 1, fixture: true }));
run("active-rejected", 78);
console.log(JSON.stringify({ status: "PASS", evidenceRoot: base, checks: [
  "halted-prefix-replay", "in-flight-full-history-check", "no-partial-strength-statistics",
  "incremental-resume", "PAUSE", "active-source-refusal",
] }));
