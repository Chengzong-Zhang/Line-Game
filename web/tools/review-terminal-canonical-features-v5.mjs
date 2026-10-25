// Additive review: preserves the frozen v4 training and prior reviewer bytes.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GameEngine } from "../web前端/GameEngine.js";
import { serializeEngineState } from "../web前端/AIStateProtocol.js";
import { fastPolicyCandidates } from "../web前端/MultiplayerSearch.js";
import { engineFromTrainingState } from "./pass-opportunity-data-v3.mjs";
import { reviewTerminalEvidence } from "./review-terminal-policy-evidence-v4.mjs";
import { root, readJson, unseal, sha, atomic } from "./neural-posttraining-data-v2.mjs";

const check = (ok, message) => { if (!ok) throw Error(message); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function canonicalTerminalActions(engine) {
  return [...fastPolicyCandidates(engine).map(move => ({ point: [...move.point], features: [...move.features, 0] })),
    { point: null, features: [...Array(16).fill(0), 1] }];
}
export async function reviewTerminalCanonicalV5(runRoot, options = {}) {
  runRoot = resolve(runRoot);
  const review = await reviewTerminalEvidence(runRoot, options), config = await readJson(resolve(runRoot, "protocol.json"));
  const cp = unseal(await readJson(resolve(runRoot, "checkpoint.json")));
  let games = 0, learnerRows = 0, featureValues = 0;
  for (const definition of config.parents) {
    const model = cp.models[definition.alias];
    for (const [index, record] of model.completed.entries()) {
      const ep = unseal(await readJson(resolve(runRoot, record.path))), cell = definition.cells[index % definition.cells.length];
      const initial = new GameEngine({ playerCount: cell.players, gridSize: cell.size, boardShape: cell.shape,
        rulesVersion: "territory-v3", deferTerritoryUpdates: true });
      initial._isReplayingBatch = true;
      const learner = initial.activePlayers[Math.floor(index / definition.cells.length) % initial.activePlayers.length];
      check(same(ep.cell, cell) && ep.learner === learner && same(ep.initialState, serializeEngineState(initial)),
        `${ep.id}: frozen configuration cell/initial state/learner mismatch`);
      const engine = engineFromTrainingState(ep.initialState);
      for (const step of ep.steps) {
        const row = unseal(await readJson(resolve(runRoot, step.path)));
        if (row.actor === ep.learner) {
          const canonical = canonicalTerminalActions(engine);
          check(same(row.actions, canonical), `${ep.id}/${row.ply}: noncanonical placement/PASS features or action order`);
          learnerRows++; featureValues += canonical.length * 17;
        }
        check((row.point === null ? engine.skipTurn() : engine.playMove(row.point)).success, "Canonical feature review replay failed");
      }
      games++;
    }
  }
  return { ...review, schema: "lifeline-terminal-canonical-feature-review-v5",
    canonical_feature_review_source_sha256: sha(await readFile(fileURLToPath(import.meta.url))),
    canonical_configuration_games: games, canonical_learner_rows: learnerRows, canonical_feature_values: featureValues,
    canonical_action_order_and_features_verified: true,
    checks: [...review.checks, "frozen-configuration-initial-state-and-seat", "canonical-fast-policy-features-and-PASS-action-order"] };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null;
  try {
    const report = await reviewTerminalCanonicalV5(option("--run-root"), { allowIncomplete: process.argv.includes("--allow-incomplete") });
    if (option("--output")) await atomic(resolve(option("--output")), report);
    console.log(JSON.stringify({ status: report.status, canonical_configuration_games: report.canonical_configuration_games,
      canonical_learner_rows: report.canonical_learner_rows, canonical_feature_values: report.canonical_feature_values }));
  } catch (e) { console.error(e.stack); process.exitCode = 78; }
}
