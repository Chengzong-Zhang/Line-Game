import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GameEngine } from "../web前端/GameEngine.js";
import { ThreePlayerAI } from "../web前端/ThreePlayerAI.js";
import { ThreePlayerSearchAI } from "../web前端/ThreePlayerSearchAI.js";
import { sha256, policyModel, canonical } from "./three-player-arena-lib.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const directory = resolve(root, "local_artifacts/three-player-v4-20261021/diagnostics");
const oldArena = resolve(root, "local_artifacts/three-player-v3-final-vs-v2-20261021");
await mkdir(directory, { recursive: true });
const parents = [];
for (const version of [1, 2]) {
  const path = resolve(root, `web/web前端/assets/research-ai/three-player-policy-v${version}.json`);
  const bytes = await readFile(path), model = JSON.parse(bytes);
  parents.push({ model, path, sha256: sha256(bytes) });
}
const specs = [
  { id: "round3", rootWidth: 3, rolloutPlies: 3, minimumImprovement: 0.02 },
  { id: "round6", rootWidth: 3, rolloutPlies: 6, minimumImprovement: 0.02 },
  { id: "round12", rootWidth: 3, rolloutPlies: 12, minimumImprovement: 0.02 },
].map((search) => ({
  schema: { name: "lifeline-three-player-search", version: 4 }, id: `three-player-search-v4-${search.id}`,
  rules_version: "territory-v2", features: parents[1].model.features,
  weights: parents[1].model.weights, temperature: parents[1].model.temperature,
  lineage: parents.map(({ model, path, sha256 }) => ({ id: model.id, path, sha256 })),
  training: { newGradientUpdates: 0, method: "Inherited frozen v2 linear weights plus bounded ensemble rollout policy improvement." },
  search: { ...search, coverageWeight: 0.3, reachWeight: 0.05, valueTemperature: 0.12,
    opponents: parents.map(({ model }) => ({ id: model.id, weights: model.weights, temperature: model.temperature })) },
}));
for (const spec of specs) {
  const path = resolve(directory, `${spec.id}.json`);
  const content = `${JSON.stringify(spec, null, 2)}\n`;
  try { await writeFile(path, content, { flag: "wx" }); }
  catch (error) { if (error.code !== "EEXIST" || await readFile(path, "utf8") !== content) throw error; }
}
const findings = [];
for (const size of [5, 7, 9]) {
  const files = (await readdir(resolve(oldArena, "games"))).filter((name) => name.startsWith(`n${size}-`) && name.includes("-single-")).sort();
  let record, source;
  for (const file of files) {
    const path = resolve(oldArena, "games", file), value = JSON.parse(await readFile(path));
    if (value.terminal && value.metrics.sharedWin[value.unit.candidateSeats[0]] === 0
      && value.actions.some((action, i) => i >= value.prefixLength && action.actor === value.unit.candidateSeats[0])) {
      record = value; source = path; break;
    }
  }
  if (!record) continue;
  const focal = record.unit.candidateSeats[0], positions = record.actions.map((action, i) => ({ action, i }))
    .filter(({ action, i }) => action.actor === focal && i >= record.prefixLength);
  const ply = positions[Math.floor(positions.length / 3)].i;
  const engine = new GameEngine({ gridSize: size, playerCount: 3, rulesVersion: "territory-v2", startPlayer: record.unit.startPlayer });
  engine._isReplayingBatch = true;
  for (const action of record.actions.slice(0, ply)) {
    if (!(action.type === "move" ? engine.playMove(action.point) : engine.skipTurn()).success) throw new Error("Invalid historical diagnostic.");
  }
  const before = engine._computeStateHash(engine.currentPlayer), history = canonical([...engine.historyHashes]);
  const baseline = new ThreePlayerAI(policyModel(parents[1].model, parents[1].model.features));
  const begin = Date.now(), choice = baseline.getTopMoves(engine, focal, 1)[0];
  const row = { size, source, source_sha256: sha256(await readFile(source)), ply, focal,
    oldFinalUsedOnlyAsDiagnostic: true, basePoint: choice?.point, baseMs: Date.now() - begin, candidates: [] };
  for (const spec of specs) {
    const candidate = new ThreePlayerSearchAI(spec), move = candidate.getTopMoves(engine, focal, 1)[0];
    if (engine._computeStateHash(engine.currentPlayer) !== before || canonical([...engine.historyHashes]) !== history) throw new Error("Search corrupted live state.");
    row.candidates.push({ id: spec.id, point: move?.point, ...candidate.lastSearch });
  }
  findings.push(row);
}
const report = { status: "DIAGNOSTIC_AND_COST_CALIBRATION_ONLY", parents: parents.map(({ path, sha256 }) => ({ path, sha256 })),
  hypotheses: ["The inherited policy ranks only immediate post-move features and never checks both opponent replies.",
    "The v3 PPO update preserved that one-step architecture and did not meet the prior independent gate."],
  findings, selectionOrFinalEvidence: false };
await writeFile(resolve(directory, "diagnostic-calibration.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ status: report.status, directory, timings: findings.map((r) => ({ size: r.size, baseMs: r.baseMs,
  candidates: r.candidates.map((c) => ({ id: c.id, elapsedMs: c.elapsedMs, actions: c.simulatedActions, point: c.point, base: r.basePoint })) })) }));
