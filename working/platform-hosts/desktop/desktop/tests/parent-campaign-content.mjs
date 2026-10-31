import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { extractFile, listPackage } from "@electron/asar";
import GameEngine from "../../web/web前端/GameEngine.js";
import { CHALLENGE_LEVELS, evaluateChallengeResult, snapshotChallengeMetrics } from "../../web/web前端/ChallengeCampaign.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const source = path.join(root, "web/web前端/ChallengeCampaign.js");
const digest = value => createHash("sha256").update(value).digest("hex");
fs.mkdirSync(path.join(root, "local_artifacts"), { recursive: true });
const evidence = fs.mkdtempSync(path.join(root, "local_artifacts/parent-campaign-content-"));
const receipt = { status: "RUNNING", evidence, sourceSha256: digest(fs.readFileSync(source)), levels: [], findings: [] };
const permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
const canonicalPosition = snapshot => {
  const size = snapshot.gridSize;
  const forms = permutations.map(permutation => {
    const point = ([x, y]) => {
      const coordinates = [x, y, size - 1 - x - y];
      return [coordinates[permutation[0]], coordinates[permutation[1]]];
    };
    const cells = [];
    for (let y = 0; y < size; y += 1) for (let x = 0; x < size - y; x += 1) {
      cells.push([...point([x, y]), snapshot.boardMatrix[y][x]]);
    }
    const edges = Object.fromEntries(Object.entries(snapshot.edges).map(([player, values]) => [player, values.map(edge =>
      edge.split("|").map(value => point(value.split(",").map(Number)).join(",")).sort().join("|")).sort()]));
    const legal = snapshot.legalMoves.map(move => point(move.point).join(",")).sort();
    return JSON.stringify({ size, cells: cells.sort((a, b) => a[0] - b[0] || a[1] - b[1]), edges, legal, player: snapshot.currentPlayer });
  });
  return forms.sort()[0];
};
const apply = (engine, action, context) => {
  assert.equal(engine.getCurrentPlayer(), action.player, `${context}: actor must have the turn`);
  const result = action.type === "skip" ? engine.skipTurn() : engine.playMove(action.point);
  assert.equal(result.success, true, `${context}: authored action must be legal`);
};
const atPrefix = level => {
  const engine = new GameEngine(level);
  for (const action of level.prefix) apply(engine, action, level.id);
  return engine;
};
const totals = () => Object.fromEntries(["addedEdges", "removedEdges", "removedNodes", "territoryGain", "territory"]
  .map(field => [field, { BLACK: 0, WHITE: 0, PURPLE: 0 }]));
const addDelta = (total, before, after) => {
  const delta = snapshotChallengeMetrics(before, after);
  for (const field of ["addedEdges", "removedEdges", "removedNodes", "territoryGain"]) {
    for (const player of Object.keys(total[field])) total[field][player] += delta[field][player];
  }
  total.territory = delta.territory;
};

try {
  if (process.argv.includes("--packaged")) {
    const archive = path.join(root, "desktop/release/win-unpacked/resources/app.asar");
    const entries = listPackage(archive);
    receipt.packageSha256 = digest(fs.readFileSync(archive));
    receipt.matchedSources = {};
    for (const name of ["GameEngine.js", "ChallengeCampaign.js"]) {
      const entry = entries.find(value => value.endsWith(name));
      assert.ok(entry, `${name} must be in the package`);
      const packaged = extractFile(archive, entry.replace(/^[\\/]/, ""));
      const sourceBytes = fs.readFileSync(path.join(root, "web/web前端", name));
      assert.deepEqual(packaged, sourceBytes, `source replay must use identical packaged ${name}`);
      receipt.matchedSources[name] = digest(packaged);
    }
  }
  const positions = new Map();
  const ids = new Set();
  for (const level of CHALLENGE_LEVELS) {
    assert.ok(!ids.has(level.id), `duplicate challenge id ${level.id}`);
    ids.add(level.id);
    const engine = atPrefix(level);
    const start = engine.getSnapshot();
    const startingNodes = start.boardMatrix.flatMap((row, y) => row.flatMap((value, x) => value === 1 ? [[x, y]] : []));
    const positionKey = digest(canonicalPosition(start));
    const peers = positions.get(positionKey) ?? [];
    peers.push(level.id); positions.set(positionKey, peers);
    const record = { id: level.id, title: level.titleEn, positionKey, goal: level.goal, maxPlayerMoves: level.maxPlayerMoves,
      intent: level.designIntentEn, reference: level.referenceSolution, legalChoices: start.legalMoves.length, winningAtActions: [] };
    let previous = start, afterReply = null, moves = 0, replies = 0;
    const metrics = totals();
    assert.equal(evaluateChallengeResult(level, { ...metrics, playerMoves: 0, opponentReplies: 0 }, startingNodes, null, start), false,
      `${level.id}: cannot be complete before a player decision`);
    for (const [index, action] of level.referenceSolution.entries()) {
      apply(engine, action, level.id);
      if (action.player === "BLACK") moves += 1; else replies += 1;
      const after = engine.getSnapshot();
      addDelta(metrics, previous, after);
      if (action.player === "WHITE") afterReply = after;
      if (evaluateChallengeResult(level, { ...metrics, playerMoves: moves, opponentReplies: replies }, startingNodes, afterReply, after)) {
        record.winningAtActions.push(index + 1);
      }
      previous = after;
    }
    assert.ok(record.winningAtActions.length > 0, `${level.id}: reference must actually achieve its objective`);
    if (record.winningAtActions[0] !== level.referenceSolution.length) {
      receipt.findings.push(`${level.id}: reference continues after its goal already succeeds at action ${record.winningAtActions[0]}.`);
    }
    record.metrics = metrics;
    receipt.levels.push(record);
  }
  receipt.levelCount = receipt.levels.length;
  receipt.uniquePositionsUpToSymmetry = positions.size;
  receipt.reusedPositionGroups = [...positions.values()].filter(ids => ids.length > 1);
  // Reuse is reported for editorial review: a different goal on one position
  // can be substantive, while changing a title or a redundant threshold is not.
  for (const group of receipt.reusedPositionGroups) {
    const rows = receipt.levels.filter(row => group.includes(row.id));
    for (let i = 0; i < rows.length; i += 1) for (let j = i + 1; j < rows.length; j += 1) {
      if (JSON.stringify(rows[i].reference) === JSON.stringify(rows[j].reference)) {
        receipt.findings.push(`${rows[i].id} / ${rows[j].id}: same board and exact solution; content distinction requires review.`);
      }
    }
  }
  assert.equal(digest(fs.readFileSync(source)), receipt.sourceSha256, "catalog changed during this audit");
  receipt.status = receipt.findings.length ? "CATALOG_REPLAY_PASS_REVIEW_REQUIRED" : "CATALOG_REPLAY_PASS";
} catch (error) {
  receipt.status = "FAIL"; receipt.error = String(error.stack ?? error); process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ ...receipt, levels: receipt.levels.map(({ id, positionKey, winningAtActions }) => ({ id, positionKey, winningAtActions })) }));
}
