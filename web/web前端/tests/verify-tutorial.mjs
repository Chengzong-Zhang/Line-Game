import assert from "node:assert/strict";
import GameEngine from "../GameEngine.js";
import { TUTORIAL_LEVELS, getTutorialEngineSettings, getTutorialInspectionOverlay, isTutorialTarget, isTutorialRestrictionAttempt } from "../TutorialRunner.js";

assert.equal(TUTORIAL_LEVELS.length, 5);

for (const level of TUTORIAL_LEVELS) {
  const engine = new GameEngine(getTutorialEngineSettings(level));
  for (const action of level.prefix) {
    assert.equal(engine.getCurrentPlayer(), action.player);
    const result = action.type === "move" ? engine.playMove(action.point) : engine.skipTurn();
    assert.equal(result.success, true, `${level.id}: prefix is legal`);
  }
  const before = engine.getSnapshot();
  const frozenBefore = JSON.stringify(before);
  assert.equal(before.currentPlayer, level.objective.player);
  const preview = getTutorialInspectionOverlay(level, before);
  assert.equal(preview.tutorial, true);
  assert.equal(preview.addedEdges.length, level.focusEdges.length);
  if (level.objective.type === "move") {
    assert.deepEqual(preview.selectedPoint, level.restriction?.point ?? level.objective.point);
  } else {
    assert.equal(preview.selectedPoint, null);
  }
  if (level.restriction) {
    assert.equal(engine._checkThreePointLimitation(level.restriction.point, "BLACK"), false, "ordinary placement would make three connected nodes");
    assert.equal(engine._checkThreePointLimitation(level.objective.point, "BLACK"), false, "the cut would make the same forbidden chain without the attack exception");
    const target = engine.getLegalMoves("BLACK").find(({ point }) => point.join() === level.objective.point.join());
    assert.equal(target?.isAttack, true, "the exception applies only to a direct cut on Red's line");
    const rejected = engine.playMove(level.restriction.point);
    assert.equal(rejected.success, false);
    assert.equal(rejected.reason, "INVALID_MOVE");
    assert.equal(JSON.stringify(engine.getSnapshot()), frozenBefore, "a rejected attempt leaves the board, turn and history unchanged");
    const attempt = { type: "move", success: false, reason: "INVALID_MOVE", player: "BLACK", point: level.restriction.point };
    assert.equal(isTutorialRestrictionAttempt(level, attempt), true);
    assert.equal(isTutorialRestrictionAttempt(level, { ...attempt, point: [5, 0] }), false);
    assert.equal(isTutorialRestrictionAttempt(level, { ...attempt, success: true }), false);
    assert.equal(isTutorialRestrictionAttempt(level, { ...attempt, reason: "MISS" }), false);
    assert.equal(isTutorialRestrictionAttempt(level, { ...attempt, player: "WHITE" }), false);
    const allowedOverlay = getTutorialInspectionOverlay(level, before, before, false, true);
    assert.deepEqual(allowedOverlay.selectedPoint, level.objective.point);
    assert.deepEqual(allowedOverlay.blockedPoint, level.restriction.point);
    assert.deepEqual(allowedOverlay.addedEdges, level.allowedFocusEdges);
  }
  if (level.id === "L5-settle-score") {
    assert.equal(before.consecutiveSkips, 1, "Red is auto-passed before the final action");
    assert.equal(engine.getLegalMoves("WHITE").length, 0, "Red has no legal moves in the settlement scene");
    assert.ok(engine.getLegalMoves("BLACK").length > 0, "Blue's skip is a choice that finishes the match");
    for (const { player, edge } of level.focusEdges) {
      assert.ok(before.edges[player].includes(edge), "the settlement highlight must show a real edge");
    }
  }
  const result = level.objective.type === "move"
    ? engine.playMove(level.objective.point)
    : engine.skipTurn();
  assert.equal(result.success, true, `${level.id}: highlighted action is legal`);
  assert.equal(isTutorialTarget(level, level.objective), true);
  const after = engine.getSnapshot();
  const frozenAfter = JSON.stringify(after);
  const overlay = getTutorialInspectionOverlay(level, before, after, true, Boolean(level.restriction));
  assert.equal(JSON.stringify(before), frozenBefore, "overlay must preserve its source position");
  assert.equal(JSON.stringify(after), frozenAfter, "overlay must preserve its result position");
  if (level.id === "L1-connect") {
    assert.equal(level.prefix.length, 2, "both colors move before the player's extension");
    assert.deepEqual(new Set(overlay.addedEdges.map(({ edge }) => edge)), new Set(["0,0|3,0", "1,0|3,0"]));
    assert.equal(after.territories.BLACK.area, 0);
  }
  if (level.id === "L2-close-territory") {
    assert.equal(overlay.addedEdges.length, 2);
    assert.equal(after.edges.BLACK.length, 3);
    assert.equal(after.territories.BLACK.area, 10);
    const actualBoundary = new Set(after.edges.BLACK.map((edge) => edge.split("|").sort().join("|")));
    for (const { edge } of preview.addedEdges) assert.ok(actualBoundary.has(edge.split("|").sort().join("|")));
  }
  if (level.id === "L3-cut-and-clear") {
    assert.deepEqual(new Set(overlay.removedEdges.map(({ edge }) => edge)), new Set(["2,3|5,0", "1,4|5,0", "1,4|2,3"]));
    assert.deepEqual(new Set(overlay.capturedPoints.map(String)), new Set(["4,1", "2,3", "1,4"]));
    assert.equal(after.boardMatrix[3][2], 0, "the first node behind the cut is gone");
    assert.equal(after.boardMatrix[4][1], 0, "the farther node behind the cut is also gone");
    assert.equal(after.edges.WHITE.length, 0);
  }
  if (level.id === "L4-three-point-limit") {
    assert.equal(after.boardMatrix[1][2], 1, "the cut creates a third consecutive Blue node");
    assert.equal(overlay.blockedPoint, null);
    assert.deepEqual(new Set(overlay.addedEdges.map(({ edge }) => edge)), new Set(["1,2|2,1", "0,3|2,1"]));
    assert.deepEqual(overlay.removedEdges, [{ player: "WHITE", edge: "1,1|4,1" }]);
  }
  if (level.id === "L5-settle-score") {
    assert.equal(after.gameOver, true);
    assert.equal(after.winner, "BLACK");
    assert.equal(after.territories.BLACK.area, 7);
    assert.equal(after.territories.WHITE.area, 0);
  }
  assert.doesNotMatch(level.instructionZh + level.successZh, /黑方|白方|白色/);
  assert.doesNotMatch(level.instructionEn + level.successEn, /\bBlack\b|\bWhite\b/);
}
console.log("verify-tutorial: PASS (5 real lessons, full cut cleanup, direct-cut three-point exception, Red no-move settlement, target highlights, red/blue copy)");
