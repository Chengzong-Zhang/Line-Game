import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PLAYER_ORDER } from "../GameEngine.js";
import {
  localMatchActors, localPlayerChoices, normalizeLocalPlayers,
} from "../LocalAIModes.js";
import {
  CONTRIBUTION_POLICY, normalizeContributionV3Context, supportsContributionActors,
} from "../TrainingContribution.js";
import {
  CONTRIBUTION_V3_POLICY, normalizeV3Context,
} from "../../tools/training_contribution_schema.mjs";

assert.equal(CONTRIBUTION_POLICY, CONTRIBUTION_V3_POLICY);
let supported = 0;
let rejectedUltimate = 0;
const observedProfiles = new Set();

for (let playerCount = 2; playerCount <= 15; playerCount += 1) {
  for (const boardShape of ["triangle", "hexagon"]) {
    const settings = {
      rulesVersion: "territory-v3", playerCount, boardShape, gridSize: 5,
      hintEnabled: false, undoEnabled: false, undoMaxCount: 3,
    };
    for (const choice of localPlayerChoices(playerCount, boardShape)) {
      const seats = Object.fromEntries(PLAYER_ORDER.slice(0, playerCount).map(color => [color, { choice: "human" }]));
      seats.WHITE = { choice, depth: 3, version: "2026092201" };
      const players = normalizeLocalPlayers(seats, playerCount, boardShape);
      const actors = localMatchActors(players, playerCount, settings.gridSize, boardShape);
      const context = { source: "local", actors, mixedProfiles: false,
        hintsEnabled: true, undo: { enabled: false, maxCount: 3, usedCount: 0 } };
      const normalized = normalizeContributionV3Context(settings, context);
      if (choice === "ai-ultimate") {
        assert.equal(normalized, null);
        assert.equal(supportsContributionActors(actors, settings), false);
        rejectedUltimate += 1;
        continue;
      }
      assert.ok(normalized, `${playerCount}/${boardShape}/${choice} should be representable`);
      assert.equal(normalized.hintsEnabled, false, "hint metadata is bound to replay settings");
      assert.deepEqual(normalizeV3Context(normalized, { ...settings, players: PLAYER_ORDER.slice(0, playerCount) }), normalized);
      assert.equal(supportsContributionActors(actors, settings), true);
      if (normalized.actors.WHITE.kind === "ai") observedProfiles.add(normalized.actors.WHITE.profile);
      supported += 1;
    }
  }
}

for (const required of [
  "minimax-3", "model:padded-cnn-transfer-v1-seed2026092201", "model:dqn-all-sizes-e2000",
  "multiplayer-easy-v1", "multiplayer-medium-v1", "multiplayer-hard-v1", "greedy",
]) assert.ok(observedProfiles.has(required), `missing actor mapping: ${required}`);

for (const [playerCount, boardShape, strategy, modelId] of [
  [3, "triangle", "three-player", "three-player-policy-v2"],
  [4, "hexagon", "hex-player", "hex-player-policy-v1"],
]) {
  const settings = { rulesVersion: "territory-v3", playerCount, boardShape, gridSize: 5,
    hintEnabled: false, undoEnabled: false, undoMaxCount: 3 };
  const actors = Object.fromEntries(PLAYER_ORDER.slice(0, playerCount).map(color => [color, { kind: "human" }]));
  actors.WHITE = { kind: "ai", strategy, modelId };
  const normalized = normalizeContributionV3Context(settings, { source: "local", actors,
    mixedProfiles: false, hintsEnabled: false, undo: { usedCount: 0 } });
  assert.equal(normalized.actors.WHITE.profile, modelId);
  assert.deepEqual(normalizeV3Context(normalized, { ...settings, players: PLAYER_ORDER.slice(0, playerCount) }), normalized);
  observedProfiles.add(modelId);
}

// 7-15 seats deliberately exclude medium and unqualified ultimate even if a
// forged caller bypasses the visible player selector.
const fifteen = { rulesVersion: "territory-v3", playerCount: 15, boardShape: "hexagon", gridSize: 15,
  hintEnabled: false, undoEnabled: true, undoMaxCount: 10 };
const actors15 = Object.fromEntries(PLAYER_ORDER.map(color => [color, { kind: "human" }]));
for (const modelId of ["multiplayer-medium-v1", "multiplayer-ultimate-v1"]) {
  actors15.WHITE = { kind: "ai", strategy: "multiplayer", modelId };
  assert.equal(normalizeContributionV3Context(fifteen, { source: "local", actors: actors15,
    mixedProfiles: false, hintsEnabled: false, undo: { usedCount: 0 } }), null);
}

const appSource = await readFile(new URL("../OnlineApp.js", import.meta.url), "utf8");
const armCalls = [...appSource.matchAll(/armContributionForFreshLocalMatch\(\);/g)];
assert.equal(armCalls.length, 1, "only an explicit fresh-match start may arm a contribution ticket");
assert.match(appSource,
  /const armContributionForFreshLocalMatch = \(\) => \{[\s\S]*?localGameActions\.value\.length !== 0[\s\S]*?const settings = currentGameSettings\(\);/,
  "a contribution ticket must be armed only while the new match still has zero actions");
assert.match(appSource,
  /const startLocalMatch = async \(\) => \{[\s\S]*?clearSavedLocalGame\(\);\s*armContributionForFreshLocalMatch\(\);\s*gameState\.value = controller\.value\.setGameConfig/,
  "fresh-match start must clear old state, arm at action zero, then initialize the engine");
const persistSource = appSource.slice(
  appSource.indexOf("const persistCurrentLocalGame = (nextState) =>"),
  appSource.indexOf("const setActionFeedback =", appSource.indexOf("const persistCurrentLocalGame = (nextState) =>")),
);
assert.doesNotMatch(persistSource, /armContributionForFreshLocalMatch|contributionContext\s*=\s*\{/,
  "restored or mid-match opt-in sessions must never mint a contribution ticket while persisting actions");
assert.match(persistSource,
  /replayRestoring\.value \|\| replayMode\.value \|\| tutorialActive\.value \|\| roomStatus\.value !== "solo"[\s\S]*?invalidateContributionTicket\(\);\s*return;/,
  "crossing into replay, tutorial, or online play must permanently invalidate the current ticket");
assert.match(appSource, /usedCount: undoUsage\.value\.usedCount/,
  "the terminal contribution context must carry actual undo usage");
assert.doesNotMatch(appSource, /contributionAssisted/,
  "undo and hint activity must not be folded into hintsEnabled");
assert.match(appSource, /<ContributionPanel v-if="aiAvailable && !onlineAvailable"/,
  "every supported local board configuration should expose the contribution control");
assert.doesNotMatch(appSource, /ContributionPanel[^\n]+playerCount <= 3/,
  "the old triangular three-seat UI gate must stay removed");

process.stdout.write(JSON.stringify({ status: "PASS_WEB_V3_CONTEXT_PARITY", supported,
  rejectedUltimate, profiles: [...observedProfiles].sort(), playerCounts: [2, 15] }) + "\n");
