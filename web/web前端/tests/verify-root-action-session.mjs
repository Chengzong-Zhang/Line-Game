import assert from "node:assert/strict";
import GameEngine, { RootMode, TerritoryRulesVersion } from "../GameEngine.js";
import { localUndoTimeline, planLocalUndo } from "../LocalUndo.js";

for (const rootMode of [RootMode.RELOCATE, RootMode.ADD]) {
  const settings = { gridSize: 9, playerCount: 2, startPlayer: "BLACK", rulesVersion: TerritoryRulesVersion.V3, rootMode };
  const actions = [
    { type: "player_move", point: [1, 0] },
    { type: "player_move", point: [7, 0] },
    { type: rootMode === RootMode.RELOCATE ? "player_root_relocate" : "player_root_add", point: [1, 0] },
  ];
  const timeline = localUndoTimeline(settings, actions);
  assert.deepEqual(timeline.map((entry) => entry.type), actions.map((action) => action.type));
  const plan = planLocalUndo({
    settings, actions, timeline, currentPlayer: "WHITE",
    players: { BLACK: { choice: "human" }, WHITE: { choice: "easy" } }, usage: { usedCount: 0 },
  });
  assert.equal(plan.actionIndex, 2, "the root action is the player's undo boundary");

  const engine = new GameEngine(settings);
  const initial = engine._captureReplayState();
  const result = engine.replayBatch((candidate) => {
    for (const action of actions) {
      const actionResult = action.type === "player_move" ? candidate.playMove(action.point)
        : candidate.playRootAction(rootMode, action.point);
      if (!actionResult.success) return actionResult;
    }
    return { success: true };
  });
  assert.equal(result.success, true);
  assert.deepEqual(engine._captureReplayState().roots.BLACK, result.snapshot.roots.BLACK);
  engine._restoreReplayState(initial);
  assert.deepEqual(engine.getRoots("BLACK"), [[0, 0]]);
  assert.equal(engine.rootActionsRemaining.BLACK[rootMode], 1);
}

console.log("verify-root-action-session: PASS (timeline boundary, batch restore, roots and quota)");
