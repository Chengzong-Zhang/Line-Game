import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

// Bounded, source-level differential check. Both sides receive the same real
// rule positions; their candidate/feature/ranking outputs remain independent.
const root = fileURLToPath(new URL("../../", import.meta.url));
const baselineRoot = path.resolve(process.argv[2] ?? path.join(root, "local_artifacts/web-sync-20261023-r1/frontend"));
const currentRoot = path.resolve(process.argv[3] ?? path.join(root, "local_artifacts/web-sync-20261023-final-source-check/frontend"));
fs.mkdirSync(path.join(root, "local_artifacts"), { recursive: true });
const evidence = fs.mkdtempSync(path.join(root, "local_artifacts/parent-multiplayer-policy-sync-"));
const output = path.resolve(process.argv[4] ?? path.join(evidence, "receipt.json"));
const hash = value => createHash("sha256").update(value).digest("hex");
const names = ["GameEngine.js", "AIEngine.js", "AIStateProtocol.js", "MultiplayerSearch.js", "MultiplayerRollout.js", "MultiplayerRuntime.js"];
const sourceHashes = Object.fromEntries([baselineRoot, currentRoot].map((directory, index) => [index ? "current" : "baseline",
  Object.fromEntries(names.map(name => [name, hash(fs.readFileSync(path.join(directory, name)))]))]));
const receipt = { status: "RUNNING", schemaVersion: 1, sourceHashes, rows: [], superko: [], evidence,
  command: [process.execPath, ...process.argv.slice(1)],
  scope: "Small deterministic 3–6-seat native-board positions, real cuts, exact 16-feature and linear ranking equivalence, synthetic full-hash Superko bans; no latency, playing-strength or Steam-platform claim." };
const imported = (directory, name) => import(pathToFileURL(path.join(directory, name)).href);
const capture = engine => ({ entries: Object.entries(engine), values: Object.fromEntries(Object.entries(engine)
  .filter(([, value]) => typeof value !== "function").map(([key, value]) => [key, structuredClone(value)])) });
const unchanged = (engine, before) => {
  assert.deepEqual(Object.keys(engine), before.entries.map(([key]) => key), "candidate enumeration must not add/remove caller properties");
  for (const [key, value] of before.entries) assert.equal(engine[key], value, `caller reference changed: ${key}`);
  assert.deepEqual(capture(engine).values, before.values, "caller nested rule state, history or caches changed");
};

try {
  const [oldSearch, newSearch, oldRuntime, newRuntime, { GameEngine }, { saveState, restoreState }] = await Promise.all([
    imported(baselineRoot, "MultiplayerSearch.js"), imported(currentRoot, "MultiplayerSearch.js"),
    imported(baselineRoot, "MultiplayerRuntime.js"), imported(currentRoot, "MultiplayerRuntime.js"),
    imported(currentRoot, "GameEngine.js"), imported(currentRoot, "AIEngine.js"),
  ]);
  const policies = [{ weights: [1, 4, .1, 0, 1, 0, 3, 2, 1, 3, 5, -1, 1, .3, .2, 0], temperature: 1 },
    { weights: Array(16).fill(0), temperature: 1 }];
  const cloneEngine = source => {
    const engine = new GameEngine({ gridSize: source.gridSize, playerCount: source.playerCount,
      boardShape: source.boardShape, initialPositions: source.initialPositions, startPlayer: source.startPlayer,
      rulesVersion: source.rulesVersion, deferTerritoryUpdates: true });
    restoreState(engine, saveState(source)); engine._isReplayingBatch = true;
    return engine;
  };
  let featureScalars = 0, attackCandidates = 0, rankingComparisons = 0;
  const compare = (source, label) => {
    // Populate the canonical legality view before taking the no-mutation guard.
    const legal = source.getLegalMoves();
    const before = capture(source);
    const expected = oldSearch.fastPolicyCandidates(source);
    const diagnostics = {}, actual = newSearch.fastPolicyCandidates(source, source.currentPlayer, { diagnostics });
    assert.deepEqual(actual, expected, `${label}: every ordered point and feature scalar must be bit-identical`);
    assert.deepEqual(actual.map(move => move.point.join(",")).sort(), legal.map(move => move.point.join(",")).sort(), `${label}: candidate set must match canonical legality`);
    assert.equal(diagnostics.legalCandidates, actual.length);
    for (const policy of policies) {
      const older = new oldRuntime.FastMultiplayerPolicy(policy), newer = new newRuntime.FastMultiplayerPolicy(policy);
      for (const topN of [1, 5, Infinity]) {
        assert.deepEqual(newer.getTopMoves(source, source.currentPlayer, topN), older.getTopMoves(source, source.currentPlayer, topN),
          `${label}: exact score, rank, tie order and softmax priors must match`);
        rankingComparisons++;
      }
    }
    unchanged(source, before);
    featureScalars += actual.length * 16;
    const attacks = legal.filter(move => move.isAttack).length;
    attackCandidates += attacks;
    receipt.rows.push({ playerCount: source.playerCount, boardShape: source.boardShape, turn: source.turnCount,
      label, legalCandidates: actual.length, attackCandidates: attacks,
      candidateDigest: hash(JSON.stringify(actual)), sourceUnchanged: true, diagnostics });
    return legal;
  };
  for (const playerCount of [3, 4, 5, 6]) {
    const source = new GameEngine({ playerCount, gridSize: 5, rulesVersion: "territory-v2", deferTerritoryUpdates: true });
    source._isReplayingBatch = true;
    let sawAttack = false, sawSuperko = false;
    for (let turn = 0; turn <= 24 && !source.gameOver; turn++) {
      const legal = source.getLegalMoves(), attacks = legal.filter(move => move.isAttack);
      if ([0, 4, 8, 12, 20, 24].includes(turn) || attacks.length && !sawAttack) {
        compare(source, `${playerCount}-seat/ply-${turn}`);
        sawAttack ||= attacks.length > 0;
        if (legal.length && !sawSuperko) {
          const chosen = attacks[0] ?? legal[0], post = cloneEngine(source), banned = cloneEngine(source);
          post._checkAndAutoSkip = () => {};
          assert.equal(post.playMove(chosen.point).success, true);
          const forbiddenHash = post._computeStateHash(post.currentPlayer);
          banned.historyHashes.add(forbiddenHash);
          assert.equal(banned._evaluateMove(chosen.point).reason, "SUPERKO_VIOLATION");
          compare(banned, `${playerCount}-seat/superko-ply-${turn}`);
          assert.ok(newSearch.fastPolicyCandidates(banned).every(move => move.point.join(",") !== chosen.point.join(",")));
          receipt.superko.push({ playerCount, turn, forbiddenPoint: chosen.point, fullHashSha256: hash(forbiddenHash), rejected: true });
          sawSuperko = true;
        }
      }
      if (turn === 24) break;
      const candidates = attacks.length ? attacks : legal;
      const selected = candidates[(playerCount + turn * 7) % Math.max(1, candidates.length)]?.point;
      assert.equal(selected ? source.playMove(selected).success : source.skipTurn().success, true);
    }
    assert.ok(sawSuperko, `${playerCount} seats need a real full-hash repetition rejection`);
  }
  assert.ok(attackCandidates > 0, "the differential must include actual cut candidates");
  assert.ok(receipt.rows.some(row => row.turn >= 8), "the differential must include noninitial positions");
  for (const [directory, expected] of [[baselineRoot, sourceHashes.baseline], [currentRoot, sourceHashes.current]]) {
    for (const [name, digest] of Object.entries(expected)) assert.equal(hash(fs.readFileSync(path.join(directory, name))), digest, "source changed during verification");
  }
  receipt.totals = { positions: receipt.rows.length, featureScalars, attackCandidates, rankingComparisons, superkoCases: receipt.superko.length };
  receipt.status = "PASS_R1_FINAL_MULTIPLAYER_CANDIDATE_FEATURE_RANKING_EQUIVALENCE";
} catch (error) {
  receipt.status = "FAIL"; receipt.error = String(error.stack ?? error); process.exitCode = 1;
} finally {
  fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify({ status: receipt.status, output, totals: receipt.totals, error: receipt.error }));
}
