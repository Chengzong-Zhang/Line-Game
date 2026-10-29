import assert from "node:assert/strict";
import GameEngine, { RootMode, TerritoryRulesVersion } from "../GameEngine.js";
import { TrainingContribution } from "../TrainingContribution.js";
import { defensiveTrainingLabel } from "../DefensiveTrainingTeacher.js";

for (const rootMode of [RootMode.FIXED_DOUBLE, RootMode.RELOCATE, RootMode.ADD]) {
  const engine = new GameEngine({ rulesVersion: TerritoryRulesVersion.V3, rootMode });
  assert.throws(() => defensiveTrainingLabel(engine, { depth: 4, maxNodes: 0, timeMs: 0 }), /rejects multi-root/);
  const contribution = new TrainingContribution({ fetcher: async () => ({ ok: true }) });
  const accepted = await contribution.enqueue(
    { playerCount: 2, rootMode, initialRoots: engine.initialRoots },
    [{ type: "skip" }, { type: "skip" }],
    { actors: {} },
  );
  assert.equal(accepted, false, `${rootMode} must not enter the legacy contribution contract`);
}
console.log("verify-multi-start-training-isolation: PASS (teacher and contribution reject all new root modes)");
