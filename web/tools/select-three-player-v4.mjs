// One frozen development selection, made only after every arena replay passes.
import assert from "node:assert/strict";
import { readFile, writeFile, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readChecked, sha256, atomic } from "./three-player-v4-arena-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const base = resolve(root, "local_artifacts/three-player-v4-20261021");
const docs = resolve(root, "docs/verification/three-player-ai-v4");
const verifierSha256 = "5eed127324e4e14a0e618926f241bb60a0ed39af9ef157616386fd2628d34fb7";
const destination = resolve(docs, "selection.json");
try { await access(destination); throw new Error("Selection already frozen; refusing to replace it."); }
catch (error) { if (error.code !== "ENOENT") throw error; }
assert.equal(sha256(await readFile(resolve(root, "web/tools/verify-three-player-v4-arena-v2.mjs"))), verifierSha256);
const entries = [];
for (const depth of [3, 6, 12]) {
  const arena = resolve(base, `dev-round${depth}`), verification = `${arena}-verification-v2`;
  const summary = await readChecked(resolve(arena, "summary.json"));
  const report = await readChecked(resolve(verification, "verification.json"));
  const exit = JSON.parse(await readFile(resolve(verification, "supervisor-exit.json")));
  const arenaExit = JSON.parse(await readFile(resolve(arena, "supervisor-exit.json")));
  const specification = resolve(root, `web/tools/configs/three-player-search-v4-round${depth}.json`);
  const candidateBytes = await readFile(specification), configBytes = await readFile(resolve(arena, "config.json"));
  assert.equal(sha256(candidateBytes), sha256(await readFile(resolve(arena, "candidate.json"))));
  assert.equal(sha256(configBytes), sha256(await readFile(resolve(docs, "development.config.json"))));
  assert.equal(summary.stage, "DEVELOPMENT");
  assert.equal(summary.plannedGames, 63); assert.equal(summary.completedGames, 63);
  assert.equal(summary.complete, true); assert.equal(summary.terminalGames, 63); assert.equal(summary.truncatedGames, 0);
  assert.equal(report.status, "PASS_APPLICATION_EVALUATION"); assert.equal(report.identity, summary.identity);
  assert.equal(report.verifiedGames, 63); assert.equal(report.summaryFieldsVerified, "all");
  assert.equal(report.verifierSha256, verifierSha256); assert.equal(exit.exit_code, 0); assert.equal(arenaExit.exit_code, 0);
  assert.ok(Number.isFinite(summary.meanDelta));
  entries.push({ depth, id: JSON.parse(candidateBytes).id, specification, candidateSha256: sha256(candidateBytes),
    arenaIdentity: summary.identity, meanDelta: summary.meanDelta,
    summarySha256: sha256(await readFile(resolve(arena, "summary.json"))),
    verificationSha256: sha256(await readFile(resolve(verification, "verification.json"))),
    verificationIdentity: report.verificationIdentity, arenaSupervisorExit: arenaExit.exit_code, verificationSupervisorExit: exit.exit_code });
}
const chosen = [...entries].sort((a, b) => b.meanDelta - a.meanDelta || a.depth - b.depth)[0];
const selectedBytes = await readFile(chosen.specification);
assert.equal(sha256(selectedBytes), chosen.candidateSha256, "Selected specification changed after validation");
const finalConfigs = {};
for (const name of ["final-vs-v1.config.json", "final-vs-v2.config.json"]) finalConfigs[name] = sha256(await readFile(resolve(docs, name)));
// A process exit between copies must not force deletion of frozen evidence.
// Existing exact copies may be adopted; any different bytes stop selection.
async function copyOnce(path) {
  try { await writeFile(path, selectedBytes, { flag: "wx" }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    assert.equal(sha256(await readFile(path)), chosen.candidateSha256, `Conflicting candidate copy: ${path}`);
  }
}
await copyOnce(resolve(docs, "selected-candidate.json"));
await copyOnce(resolve(root, "web/web前端/tests/fixtures/three-player-v4-browser-candidate.json"));
await atomic(destination, { schema: "lifeline-three-player-v4-development-selection-v1", selectedAt: new Date().toISOString(),
  status: "SELECTED_FOR_INDEPENDENT_FINAL", rule: "All three development arenas complete and independently verified; maximum meanDelta, ties choose fewer rollout plies.",
  candidates: entries, chosen, finalConfigs, newGradientUpdates: 0,
  selectionToolSha256: sha256(await readFile(fileURLToPath(import.meta.url))), verifierSha256,
  productionPromotion: "Not decided by development data; requires frozen independent FINAL vs v1 and separate application verification." });
console.log(JSON.stringify({ status: "SELECTED_FOR_INDEPENDENT_FINAL", id: chosen.id, meanDelta: chosen.meanDelta,
  candidateSha256: chosen.candidateSha256, receipt: destination }));
