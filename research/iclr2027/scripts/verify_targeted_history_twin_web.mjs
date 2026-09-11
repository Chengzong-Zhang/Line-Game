#!/usr/bin/env node
// Independently replay one Python search candidate through the Web rule engine.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";


const verifierPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(verifierPath), "..");
const repositoryRoot = path.resolve(projectRoot, "..", "..");
const enginePath = path.join(repositoryRoot, "web", "web前端", "GameEngine.js");


function assert(condition, message) {
  if (!condition) throw new Error(message);
}


function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex").toUpperCase();
}


function stableJson(value) {
  const canonical = (item) => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(
        Object.keys(item).sort().map((key) => [key, canonical(item[key])]),
      );
    }
    return item;
  };
  return JSON.stringify(canonical(value));
}


function strictPoint(raw, label) {
  assert(Array.isArray(raw) && raw.length === 2, `${label} must be a two-coordinate point`);
  assert(Number.isInteger(raw[0]) && Number.isInteger(raw[1]), `${label} coordinates must be integers`);
  return [raw[0], raw[1]];
}


function strictHistory(raw, label) {
  assert(Array.isArray(raw), `${label} must be an action array`);
  return raw.map((action, index) => (
    action === null ? null : strictPoint(action, `${label}[${index}]`)
  ));
}


function sortedLegalPoints(game) {
  return game.getLegalMoves()
    .map((move) => move.point)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}


function replay(GameEngine, history, label, gridSize) {
  const game = new GameEngine({ gridSize, playerCount: 2 });
  history.forEach((action, index) => {
    const result = action === null ? game.skipTurn() : game.playMove(action);
    assert(result.success, `${label} action ${index + 1} failed: ${result.reason}`);
  });
  return game;
}


function edgeIndices(game, player) {
  return [...game._getEdges(player)]
    .map((edge) => {
      const [aKey, bKey] = edge.split("|");
      const a = aKey.split(",").map(Number);
      const b = bKey.split(",").map(Number);
      const ai = game._pointToIndex(a);
      const bi = game._pointToIndex(b);
      return ai < bi ? [ai, bi] : [bi, ai];
    })
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}


function topologyPayload(game, Player) {
  return {
    grid_size: game.gridSize,
    board: game.validPositions.map((point) => game._getState(point)),
    current_player: game.currentPlayer,
    consecutive_skips: game.consecutiveSkips,
    game_over: game.gameOver,
    logical_edge_indices: {
      [Player.BLACK]: edgeIndices(game, Player.BLACK),
      [Player.WHITE]: edgeIndices(game, Player.WHITE),
    },
  };
}


function cloneGame(game) {
  const clone = Object.assign(Object.create(Object.getPrototypeOf(game)), game);
  clone.grid = new Map(game.grid);
  clone.edges = Object.fromEntries(
    game.activePlayers.map((player) => [player, new Set(game.edges[player])]),
  );
  clone.historyHashes = new Set(game.historyHashes);
  clone.resignedPlayers = new Set(game.resignedPlayers);
  clone.cachedTerritories = Object.fromEntries(
    game.activePlayers.map((player) => [player, { ...game.cachedTerritories[player] }]),
  );
  clone._bfsQueue = new Int32Array(game._bfsQueue.length);
  clone._bfsWall = new Int32Array(game._bfsWall.length);
  clone._bfsWater = new Int32Array(game._bfsWater.length);
  return clone;
}


function resultStateHash(game, candidate) {
  const probe = cloneGame(game);
  const actor = probe.currentPlayer;
  assert(probe._addNode(candidate), "candidate failed a non-Superko local placement rule");
  return probe._computeStateHash(probe._getNextPlayer(actor));
}


function difference(left, right) {
  const encodedRight = new Set(right.map((point) => JSON.stringify(point)));
  return left.filter((point) => !encodedRight.has(JSON.stringify(point)));
}


async function main() {
  assert(process.argv.length === 3, "usage: verify_targeted_history_twin_web.mjs CANDIDATE.json");
  const candidatePath = path.resolve(process.argv[2]);
  const [candidateBytes, engineBytes, verifierBytes] = await Promise.all([
    fs.readFile(candidatePath),
    fs.readFile(enginePath),
    fs.readFile(verifierPath),
  ]);
  const candidate = JSON.parse(candidateBytes.toString("utf8"));
  assert(candidate.artifact_kind === "targeted_history_twin_search_candidate", "wrong candidate kind");
  assert(candidate.result?.status === "FOUND_CANDIDATE", "search did not find a candidate");
  const witness = candidate.result?.witness;
  assert(witness && typeof witness === "object", "candidate has no witness");
  const gridSize = candidate.target?.grid_size;
  assert(Number.isInteger(gridSize) && gridSize === 6, "target grid size must be 6");
  const referenceHistory = strictHistory(witness.reference_history, "reference_history");
  const twinHistory = strictHistory(witness.twin_history, "twin_history");
  const action = strictPoint(witness.candidate_action, "candidate_action");

  const source = engineBytes.toString("utf8");
  const engineModule = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  );
  const { GameEngine, Player } = engineModule;
  const reference = replay(GameEngine, referenceHistory, "reference_history", gridSize);
  const twin = replay(GameEngine, twinHistory, "twin_history", gridSize);
  const referenceTopology = topologyPayload(reference, Player);
  const twinTopology = topologyPayload(twin, Player);
  assert(
    stableJson(referenceTopology) === stableJson(twinTopology),
    "histories do not reach the same mask-free topology",
  );
  assert(
    stableJson(referenceTopology) === stableJson(witness.target_topology),
    "Web topology does not match the candidate target payload",
  );
  assert(
    stableJson(referenceTopology) === stableJson(candidate.target.target_topology),
    "Web topology does not match the top-level frozen target payload",
  );
  assert(
    JSON.stringify([...reference.historyHashes].sort())
      !== JSON.stringify([...twin.historyHashes].sort()),
    "histories have equal Superko sets",
  );

  const referenceEvaluation = reference._evaluateMove(action);
  const twinEvaluation = twin._evaluateMove(action);
  assert(
    referenceEvaluation.legal === false
      && referenceEvaluation.reason === "SUPERKO_VIOLATION",
    "reference candidate is not rejected exactly by Superko",
  );
  assert(
    twinEvaluation.legal === true && twinEvaluation.reason === null,
    "twin candidate is not legal",
  );
  const referenceResultHash = resultStateHash(reference, action);
  const twinResultHash = resultStateHash(twin, action);
  assert(referenceResultHash === twinResultHash, "candidate result hashes differ");
  assert(reference.historyHashes.has(referenceResultHash), "reference lacks repeated result hash");
  assert(!twin.historyHashes.has(twinResultHash), "twin unexpectedly contains result hash");

  const referenceLegal = sortedLegalPoints(reference);
  const twinLegal = sortedLegalPoints(twin);
  const onlyReference = difference(referenceLegal, twinLegal);
  const onlyTwin = difference(twinLegal, referenceLegal);
  assert(onlyReference.length === 0, "reference has an unexpected extra legal placement");
  assert(
    JSON.stringify(onlyTwin) === JSON.stringify([action]),
    "Web legal-set difference is not exactly the candidate",
  );

  const finalHashes = await Promise.all([
    fs.readFile(candidatePath).then(sha256),
    fs.readFile(enginePath).then(sha256),
    fs.readFile(verifierPath).then(sha256),
  ]);
  assert(finalHashes[0] === sha256(candidateBytes), "candidate changed during replay");
  assert(finalHashes[1] === sha256(engineBytes), "Web engine changed during replay");
  assert(finalHashes[2] === sha256(verifierBytes), "Web verifier changed during replay");

  process.stdout.write(`${JSON.stringify({
    schema_version: 1,
    artifact_kind: "web_targeted_history_twin_replay_receipt",
    status: "PASS",
    candidate_sha256: sha256(candidateBytes),
    web_engine_sha256: sha256(engineBytes),
    web_verifier_sha256: sha256(verifierBytes),
    same_mask_free_topology: true,
    different_superko_history_sets: true,
    candidate_action: action,
    reference_reason: referenceEvaluation.reason,
    twin_legal: true,
    legal_only_in_reference: onlyReference,
    legal_only_in_twin: onlyTwin,
    candidate_result_hash_sha256: sha256(Buffer.from(referenceResultHash, "utf8")),
    target_topology: referenceTopology,
    input_model: "Both Web and Python verifiers consume the same persisted candidate JSON.",
  }, null, 2)}\n`);
}


main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
