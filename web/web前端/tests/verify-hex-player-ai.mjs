import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { GameEngine, PLAYER_ORDER } from "../GameEngine.js";
import { saveState } from "../AIEngine.js";
import { HexPlayerAI, createHexPlayerModel, hexPlayerCandidates } from "../HexPlayerAI.js";

const modelPath = process.argv[2]
  ? new URL(process.argv[2], `file://${process.cwd().replaceAll("\\", "/")}/`)
  : new URL("../assets/research-ai/hex-player-policy-v1.json", import.meta.url);
const payload = JSON.parse(await readFile(modelPath, "utf8"));
const model = await createHexPlayerModel(payload);
const ai = new HexPlayerAI(model);
const observations = [];
for (const count of [4, 5, 6]) {
  for (const size of [5, 9, 15]) {
    const game = new GameEngine({ playerCount: count, gridSize: size, rulesVersion: "territory-v2" });
    // Larger boards get three complete rounds before timing every seat.
    game._isReplayingBatch = true;
    for (let index = 0; index < count * (size === 5 ? 1 : 3); index += 1) {
      const legal = game.getLegalMoves();
      assert.equal(game.playMove(legal[Math.min(index, legal.length - 1)].point).success, true);
    }
    game._isReplayingBatch = false;
    for (const player of game.activePlayers) {
      game.currentPlayer = player;
      const state = saveState(game);
      const keys = Object.keys(game);
      const started = performance.now();
      const results = ai.getTopMoves(game, player, Infinity);
      const elapsed = performance.now() - started;
      assert.deepEqual(saveState(game), state);
      assert.deepEqual(Object.keys(game), keys, "speculation must not leave instance overrides");
      assert.ok(results.length);
      assert.ok(results.every((move) => Number.isFinite(move.score) && move.prior >= 0));
      assert.ok(Math.abs(results.reduce((sum, move) => sum + move.prior, 0) - 1) < 1e-12);
      const legal = new Set(game.getLegalMoves().map((move) => move.point.join(",")));
      assert.ok(results.every((move) => legal.has(move.point.join(","))));
      observations.push({ count, size, player, plies: game.turnCount, candidates: results.length, milliseconds: Math.round(elapsed * 10) / 10 });
    }
  }
}
const game = new GameEngine({ playerCount: 6, gridSize: 5, rulesVersion: "territory-v2" });
const source = saveState(game);
const originalPlay = game.playMove;
game.playMove = () => { throw new Error("injected candidate failure"); };
assert.throws(() => hexPlayerCandidates(game), /injected/);
game.playMove = originalPlay;
assert.deepEqual(saveState(game), source);
assert.throws(() => ai.getTopMoves(new GameEngine({ playerCount: 3 }), PLAYER_ORDER[0]), /4–6/);
assert.throws(() => ai.getTopMoves(game, PLAYER_ORDER[1]), /当前行动方/);
const candidates = hexPlayerCandidates(game);
assert.ok(candidates.every(({ features }) => features.length === 16
  && features.every(Number.isFinite) && features[12] >= 0 && features[12] <= 1
  && features[13] >= 0 && features[13] <= 1));
const badHash = structuredClone(payload);
badHash.weights[0] += 0.5;
await assert.rejects(createHexPlayerModel(badHash), /完整性/);
const badShape = structuredClone(payload);
badShape.weights[0] = null;
await assert.rejects(createHexPlayerModel(badShape), /格式/);
const unsupported = structuredClone(payload);
unsupported.browser_inference.player_counts = [4, 6];
await assert.rejects(createHexPlayerModel(unsupported), /格式/);

const longGame = new GameEngine({ playerCount: 6, gridSize: 15, rulesVersion: "territory-v2" });
longGame._isReplayingBatch = true;
for (let ply = 0; ply < 24; ply += 1) {
  assert.equal(longGame.gameOver, false);
  const legal = longGame.getLegalMoves();
  assert.ok(legal.length);
  assert.equal(longGame.playMove(legal[(ply * 11 + 3) % legal.length].point).success, true);
}
longGame._isReplayingBatch = false;
for (const player of [PLAYER_ORDER[0], PLAYER_ORDER[3], PLAYER_ORDER[5]]) {
  longGame.currentPlayer = player;
  const before = saveState(longGame);
  const started = performance.now();
  const moves = ai.getTopMoves(longGame, player, 1);
  assert.ok(moves.length);
  assert.deepEqual(saveState(longGame), before);
  observations.push({ count: 6, size: 15, player, plies: longGame.turnCount,
    candidates: longGame.getLegalMoves().length, milliseconds: Math.round((performance.now() - started) * 10) / 10 });
}

const completedGames = [];
for (const count of [4, 5, 6]) {
  const match = new GameEngine({ playerCount: count, gridSize: 5, rulesVersion: "territory-v2",
    deferTerritoryUpdates: true });
  // The finite board can still revisit shapes under different turn/history
  // contexts. Bound this product probe and end with legal consecutive skips if
  // the move cap is reached, recording that distinction explicitly.
  let steps = 0;
  for (; steps < 80 && !match.gameOver; steps += 1) {
    const move = ai.getTopMoves(match, match.currentPlayer, 1)[0];
    assert.equal((move ? match.playMove(move.point) : match.skipTurn()).success, true);
  }
  const naturalTermination = match.gameOver;
  if (!match.gameOver) for (let index = 0; index < count && !match.gameOver; index += 1) match.skipTurn();
  assert.equal(match.gameOver, true);
  assert.ok(match.getWinner() === "DRAW" || PLAYER_ORDER.slice(0, count).includes(match.getWinner()));
  assert.deepEqual(ai.getTopMoves(match, match.currentPlayer, 1), []);
  completedGames.push({ count, steps, naturalTermination, winner: match.getWinner() });
  const resigned = new GameEngine({ playerCount: count, gridSize: 5, rulesVersion: "territory-v2" });
  for (const player of resigned.activePlayers.slice(0, -1)) assert.equal(resigned.resignPlayer(player).success, true);
  assert.equal(resigned.getWinner(), resigned.activePlayers.at(-1));
  assert.deepEqual(ai.getTopMoves(resigned, resigned.currentPlayer, 1), []);
}

// Verify the independently reproducible heldout loss from the stored local
// checkpoint when explicitly supplied. This evaluates heldout episodes only.
if (process.argv[3]) {
  const checkpoint = JSON.parse(await readFile(process.argv[3], "utf8"));
  assert.ok(new Set(checkpoint.completedGames).size === checkpoint.completedGames.length);
  const heldout = checkpoint.samples.filter((sample) => sample.heldout);
  assert.ok(heldout.length);
  for (const count of [4, 5, 6]) {
    const samples = heldout.filter((sample) => sample.players === count);
    let crossEntropy = 0;
    for (const sample of samples) {
      const scores = sample.features.map((features) => model.score(features));
      const max = Math.max(...scores);
      const weights = scores.map((score) => Math.exp(score - max));
      const total = weights.reduce((sum, value) => sum + value, 0);
      crossEntropy -= sample.targets.reduce((sum, target, index) =>
        sum + target * Math.log(Math.max(1e-12, weights[index] / total)), 0);
    }
    assert.equal(samples.length, payload.training.heldout_by_player_count[count].samples);
    assert.ok(Math.abs(crossEntropy / samples.length
      - payload.training.heldout_by_player_count[count].cross_entropy) < 1e-12);
  }
  for (const [path, hash] of Object.entries(payload.training.source_hashes)) {
    const actual = createHash("sha256").update(await readFile(path)).digest("hex");
    assert.equal(actual, hash, `${path}: trained source hash changed`);
  }
}
console.log(JSON.stringify({
  status: "PASS", model: payload.id, probes: observations.length,
  maxMilliseconds: Math.max(...observations.map((item) => item.milliseconds)), observations, completedGames,
}, null, 2));
