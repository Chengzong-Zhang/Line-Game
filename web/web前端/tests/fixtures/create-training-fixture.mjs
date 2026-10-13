import GameEngine from "../../GameEngine.js";
import { createReplayDocument } from "../../ReplayCodec.js";
import { pathToFileURL } from "node:url";

// Synthetic games for engineering tests only, never human training evidence.
export async function syntheticContribution(seed = 1, size = 5) {
  const config = { gridSize: size, playerCount: 2, startPlayer: seed % 2 ? "BLACK" : "WHITE", rulesVersion: "territory-v2", hintEnabled: false };
  const engine = new GameEngine(config); const actions = [];
  let random = seed;
  for (let turn = 0; turn < 12 && !engine.gameOver; turn++) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const legal = engine.getLegalMoves(engine.currentPlayer);
    const point = legal.length ? legal[random % legal.length].point : null;
    const action = { type: point ? "move" : "skip", player: engine.currentPlayer, ...(point ? { point } : {}) };
    const result = point ? engine.playMove(point) : engine.skipTurn();
    if (!result.success) throw new Error(result.reason); actions.push(action);
  }
  for (let tries = 0; tries < 3 && !engine.gameOver; tries++) { actions.push({ type: "skip", player: engine.currentPlayer }); engine.skipTurn(); }
  if (!engine.gameOver) throw new Error("Synthetic fixture did not terminate");
  return { format: "lifeline-training-contribution", version: 1, consent: true, consent_policy: "anonymous-replay-training-v1",
    replay: await createReplayDocument(config, actions), context: { source: "local", actors: { BLACK: { kind: "human" }, WHITE: { kind: "ai", strategy: "minimax", depth: 1 } }, mixedProfiles: false, hintsEnabled: false } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.stdout.write(JSON.stringify(await syntheticContribution(Number(process.argv[2] ?? 1))));
