// Preserve the old frozen EXPECTED_TOP_MOVES test. Compare real old/new behavior
// independently on its exact fixture and display-updater stub instead.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TERRITORY_V2_HOT_PATH_FIXTURES } from "./territory-v2-fixtures.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const args = process.argv.slice(2), at = args.indexOf("--baseline-source");
assert.ok(at >= 0 && args[at + 1], "Use --baseline-source DELIVERED_FRONTEND_DIRECTORY");
const candidateDir = new URL("../", import.meta.url), baselineDir = pathToFileURL(`${resolve(args[at + 1]).replaceAll("\\", "/")}/`);
async function load(directory) {
  const paths = Object.fromEntries(["AIEngine.js", "GameEngine.js"].map(name => [name, new URL(name, directory)]));
  const hashes = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([name, url]) => [name, sha(await readFile(url))])));
  const engine = await import(`${paths["GameEngine.js"].href}?legacy-v2-audit=${hashes["GameEngine.js"]}`);
  const ai = await import(`${paths["AIEngine.js"].href}?legacy-v2-audit=${hashes["AIEngine.js"]}`);
  return { ...engine, ...ai, paths, hashes };
}
const candidate = await load(candidateDir), baseline = await load(baselineDir);
assert.equal(baseline.hashes["AIEngine.js"], "792b8225aea9b4c68990a47a1658fed2a13bd2e4e52186113c9a25efdd5c2694",
  "This independent regression requires the actual delivered 65fa1ff baseline AI bytes");
const fixture = TERRITORY_V2_HOT_PATH_FIXTURES.find(row => row.name === "two-player-15-midgame");
assert.ok(fixture);
function capture(module, engine) {
  const publicSnapshot = engine.getSnapshot();
  return { publicSnapshot, ruleState: module.saveState(engine), replayState: engine._captureReplayState(),
    replayFlag: engine._isReplayingBatch, updater: engine._updateTerritories,
    initialPositions: structuredClone(engine.initialPositions), activePlayers: [...engine.activePlayers] };
}
function run(module, rootPruning, moveOrdering) {
  const engine = new module.GameEngine({ gridSize: fixture.gridSize, playerCount: fixture.playerCount,
    rulesVersion: module.TerritoryRulesVersion.V2, deferTerritoryUpdates: true });
  // EXACTLY the original verify-ai-search-15.mjs fixture setup contract.
  engine._updateTerritories = () => {};
  engine._isReplayingBatch = true;
  try { for (const point of fixture.moves) assert.equal(engine.playMove(point).success, true); }
  finally { engine._isReplayingBatch = false; }
  const before = capture(module, engine), legal = new Set(engine.getLegalMoves().map(move => move.point.join(",")));
  const ai = new module.MinimaxAI(2, { rootPruning, moveOrdering, iterativeDeepening: false });
  let snapshotCalls = 0;
  const originalSnapshot = engine.getSnapshot;
  engine.getSnapshot = function (...values) { snapshotCalls++; return originalSnapshot.apply(this, values); };
  let moves;
  try { moves = ai.getTopMoves(engine, engine.currentPlayer, 5); }
  finally { engine.getSnapshot = originalSnapshot; }
  assert.equal(snapshotCalls, 0, "Speculative search must not construct any UI snapshot");
  assert.deepEqual(capture(module, engine), before, "Full rule/replay/public/cache state changed");
  for (const move of moves) assert.ok(move.point === null || legal.has(move.point.join(",")), "Illegal selected root");
  return { moves, snapshotCalls, ruleReplayPublicStatePreserved: true, search: ai.lastSearch ?? null };
}
const optimized = run(candidate, true, true), fullWindow = run(candidate, false, false), delivered = run(baseline, false, false);
assert.deepEqual(optimized.moves, fullWindow.moves, "Optimized and current full-window exact rankings/scores differ");
assert.deepEqual(optimized.moves, delivered.moves, "Optimized and delivered baseline exact rankings/scores differ");
for (const module of [candidate, baseline]) for (const [name, url] of Object.entries(module.paths))
  assert.equal(sha(await readFile(url)), module.hashes[name], "Source changed while regression was running");
console.log(JSON.stringify({ status: "PASS_LEGACY_V2_CURRENT_AND_DELIVERED_EXACT_PARITY", fixture: fixture.name,
  gridSize: fixture.gridSize, players: fixture.playerCount, plies: fixture.moves.length, depth: 2, topN: 5,
  rulesVersion: "territory-v2", updater: "same no-op as original verify-ai-search-15.mjs", optimized, fullWindow, delivered,
  sourceHashes: { candidate: candidate.hashes, delivered: baseline.hashes },
  knownInheritedFailure: "Original verify-ai-search-15.mjs frozen EXPECTED_TOP_MOVES assertion is retained unchanged; it fails with identical actual values under both delivered and optimized sources.",
  scope: "One fixed legacy v2 search equivalence fixture and zero speculative UI snapshots. No rewrite of old evidence/expected values, speed claim, training, browser or phone verification." }));
