// Synthetic engineering fixture: actual Web rules and trained AI, no human data.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import GameEngine from "../../GameEngine.js";
import { createReplayDocument } from "../../ReplayCodec.js";
import { localMatchActors, localPlayerProfile } from "../../LocalAIModes.js";
import { createSupportedThreePlayerModel, ThreePlayerAI } from "../../ThreePlayerModels.js";

export async function syntheticThreePlayerContribution(aiCount = 2, rulesVersion = "territory-v2") {
  const config = { gridSize: 5, playerCount: 3, startPlayer: "BLACK", rulesVersion, hintEnabled: false };
  const players = {
    BLACK: { choice: "human" },
    WHITE: { choice: "three-player" },
    PURPLE: { choice: aiCount === 2 ? "three-player" : "human" },
  };
  const engine = new GameEngine(config);
  const modelId = localPlayerProfile(players.WHITE, 3).modelId;
  const payload = JSON.parse(await readFile(new URL(`../../assets/research-ai/${modelId}.json`, import.meta.url)));
  const ai = new ThreePlayerAI(createSupportedThreePlayerModel(payload));
  const actions = [];
  for (let turn = 0; turn < 200 && !engine.gameOver; turn++) {
    const player = engine.currentPlayer;
    const usesAI = players[player].choice !== "human";
    // Legacy-rules fixture is used only to prove receiver rejection.
    const candidates = usesAI && rulesVersion === "territory-v2"
      ? ai.getTopMoves(engine, player, 1) : engine.getLegalMoves(player);
    const point = candidates[usesAI ? 0 : (turn * 7 + aiCount) % Math.max(1, candidates.length)]?.point;
    const action = { type: point ? "move" : "skip", player, ...(point ? { point } : {}) };
    const result = point ? engine.playMove(point) : engine.skipTurn();
    if (!result.success) throw new Error(result.reason);
    actions.push(action);
  }
  if (!engine.gameOver) throw new Error("Synthetic three-player fixture did not terminate");
  return {
    format: "lifeline-training-contribution", version: 1, consent: true,
    consent_policy: "anonymous-replay-training-v1",
    replay: await createReplayDocument(config, actions),
    context: { source: "local", actors: localMatchActors(players, 3), mixedProfiles: false, hintsEnabled: false },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(JSON.stringify(await syntheticThreePlayerContribution(Number(process.argv[2] ?? 2), process.argv[3] ?? "territory-v2")));
}
