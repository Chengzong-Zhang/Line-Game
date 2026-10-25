import assert from "node:assert/strict";
import { GameEngine } from "../GameEngine.js";
import { saveState } from "../AIEngine.js";
import { defensiveTrainingLabel } from "../DefensiveTrainingTeacher.js";
import { passOpportunityTrainingLabel, assertPassOpportunityLabel, requiredPassTrainingDepth } from "../PassOpportunityTrainingTeacher.js";
import { nativeDiscreteAreas } from "../AIPassDiscipline.js";

const position = () => {
  const e = new GameEngine({ gridSize: 5, playerCount: 2, rulesVersion: "territory-v3", deferTerritoryUpdates: true });
  e._isReplayingBatch = true; return e;
};
const e = position(); assert.equal(e.playMove([2, 0]).success, true); assert.equal(e.skipTurn().success, true);
const before = saveState(e), old = defensiveTrainingLabel(e, { maxNodes: 20000, timeMs: 5000 });
assert.equal(old.label.moves.find(move => move.point === null).target, 1,
  "Frozen teacher fixture must reproduce binary-terminal-win PASS bias");
const result = passOpportunityTrainingLabel(e, { maxNodes: 30000, timeMs: 5000, annotatePassOpportunity: false });
assert.equal(result.status, "COMPLETE_LABEL"); assert.equal(result.search.completedDepth, 4); assert.equal(result.search.maxReachedPly, 4);
assert.equal(result.label.moves.find(move => move.point === null).target, 0);
assert.deepEqual(result.label.moves.filter(move => move.target > 0).map(move => move.point), [[2, 2]]);
assert.ok(result.label.moves[0].value[2] > 0, "Full-horizon protected expansion must earn actual native-area gain");
assert.deepEqual(saveState(e), before, "Teacher changed caller history, actor, edges or board");
const exhaustive = passOpportunityTrainingLabel(e, { maxNodes: 100000, timeMs: 10000, pruning: false, annotatePassOpportunity: false });
assert.deepEqual(exhaustive.label.moves, result.label.moves, "All exact root vectors must match unpruned minimax");
const annotated = passOpportunityTrainingLabel(e, { maxNodes: 30000, timeMs: 5000 });
assert.deepEqual(annotated.label.moves, result.label.moves, "One-reply annotation must not mask or alter deep minimax targets");
for (const depth of [1, 2, 3]) assert.throws(() => passOpportunityTrainingLabel(e, { depth }), /completed depth/);
for (const fields of [{ maxReachedPly: 2 }, { allRootScoresExact: false }, { completedDepth: 2 }, { candidateCap: 2 }]) {
  const copy = structuredClone(result.label); Object.assign(copy.search, fields); assert.throws(() => assertPassOpportunityLabel(copy));
}
const timed = passOpportunityTrainingLabel(e, { maxNodes: 1, timeMs: 5000, annotatePassOpportunity: false });
assert.equal(timed.label, null); assert.equal(timed.search.complete, false);
const receipts = [];
for (const players of [2, 3, 4]) {
  const opening = new GameEngine({ gridSize: 5, boardShape: "triangle", playerCount: players, rulesVersion: "territory-v3", deferTerritoryUpdates: true });
  opening._isReplayingBatch = true;
  const label = passOpportunityTrainingLabel(opening, { maxNodes: 50000, timeMs: 8000, annotatePassOpportunity: false });
  assert.equal(label.status, "COMPLETE_LABEL"); assert.equal(label.search.maxReachedPly, 2 * players);
  assert.equal(label.label.moves.find(move => move.point === null).target, 0);
  assert.equal(requiredPassTrainingDepth(opening), 2 * players);
  const actual = nativeDiscreteAreas(opening); GameEngine.prototype._updateTerritories.call(opening);
  for (const player of opening.activePlayers) assert.equal(actual[player], opening.cachedTerritories[player].area);
  receipts.push({ players, completedDepth: label.search.completedDepth, roots: label.search.rootActionsCompleted, nodes: label.search.nodes });
}
console.log(JSON.stringify({ status: "PASS_NATIVE_AREA_OPPORTUNITY_TEACHER_V3", receipts,
  tests: ["old-binary-terminal-PASS-reproduced", "new-full-depth-area-expansion", "unpruned-all-root-parity", "annotation-does-not-mask-label", "source-unchanged", "incomplete-no-label", "actual-depth-floor", "opening-2-3-4"], strength_verified: false }));
