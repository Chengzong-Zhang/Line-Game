import assert from "node:assert/strict";
import { GameEngine, Player, RootMode, TerritoryRulesVersion } from "../GameEngine.js";

const MODES = [RootMode.CLASSIC, RootMode.FIXED_DOUBLE, RootMode.RELOCATE, RootMode.ADD];
const STARTERS = [Player.BLACK, Player.WHITE];

function nodeSets(engine) {
  return Object.fromEntries(engine.activePlayers.map((player) => [
    player,
    new Set(engine._getPlayerNodes(player).map((point) => point.join(","))),
  ]));
}

function countCleared(before, after) {
  let cleared = 0;
  for (const player of Object.keys(before)) {
    for (const point of before[player]) if (!after[player].has(point)) cleared += 1;
  }
  return cleared;
}

function run(mode, startPlayer) {
  const engine = new GameEngine({
    gridSize: 5,
    playerCount: 2,
    boardShape: "triangle",
    rulesVersion: TerritoryRulesVersion.V3,
    rootMode: mode,
    startPlayer,
  });
  const actions = [];
  const usedRootAction = { BLACK: false, WHITE: false };
  let clearedNodes = 0;

  for (let step = 0; step < 256 && !engine.gameOver; step += 1) {
    const actor = engine.currentPlayer;
    const before = nodeSets(engine);
    const rootAction = !usedRootAction[actor] ? engine.getLegalRootActions(actor)[0] : null;
    let result;
    let action;
    if (rootAction) {
      result = engine.playRootAction(rootAction.type, rootAction.point);
      action = { actor, type: rootAction.type, point: rootAction.point };
      usedRootAction[actor] = result.success;
    } else {
      const move = engine.getLegalMoves(actor)[0];
      if (move) {
        result = engine.playMove(move.point);
        action = { actor, type: "move", point: move.point };
      } else {
        result = engine.skipTurn();
        action = { actor, type: "pass" };
      }
    }
    assert.equal(result.success, true, `${mode}/${startPlayer} rejected ${JSON.stringify(action)}: ${result.reason}`);
    clearedNodes += countCleared(before, nodeSets(engine));
    actions.push(action);
  }

  assert.equal(engine.gameOver, true, `${mode}/${startPlayer} did not terminate within the bound`);
  const snapshot = engine.getSnapshot();
  const scores = Object.fromEntries(engine.activePlayers.map((player) => [player, snapshot.territories[player].area]));
  assert.ok(Object.values(scores).every(Number.isInteger), "territory-v3 area must be integral");
  assert.ok(actions.some((action) => action.type === "pass") || snapshot.consecutiveSkips > 0,
    "the terminal trace must include PASS semantics");
  if (mode === RootMode.RELOCATE || mode === RootMode.ADD) {
    assert.ok(Object.values(usedRootAction).some(Boolean), `${mode} bounded play must exercise a root action`);
  }
  return {
    mode,
    startPlayer,
    turns: actions.length,
    actionCounts: Object.fromEntries([...new Set(actions.map((action) => action.type))]
      .map((type) => [type, actions.filter((action) => action.type === type).length])),
    rootActionUsed: usedRootAction,
    clearedNodes,
    consecutivePasses: snapshot.consecutiveSkips,
    scores,
    winner: snapshot.winner,
  };
}

const results = MODES.flatMap((mode) => STARTERS.map((starter) => run(mode, starter)));
console.log(JSON.stringify({
  verification: "multi-start-bounded-play-v1",
  rulesVersion: TerritoryRulesVersion.V3,
  gridSize: 5,
  deterministicPolicy: "first legal root action once per seat, otherwise first legal placement, otherwise PASS",
  limitations: "Eight deterministic product-rule games are a bounded regression sample, not an AI strength claim.",
  results,
}, null, 2));
