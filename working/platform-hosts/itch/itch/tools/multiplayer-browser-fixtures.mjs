import { GameEngine } from "../../web/web前端/GameEngine.js";
import { serializeEngineState } from "../../web/web前端/AIStateProtocol.js";
import { isolatedSearchEngine } from "../../web/web前端/MultiplayerSearch.js";

const SNAPSHOT_PLIES = new Set([31, 95, 127]);

export function generateMultiplayerBrowserFixtures() {
  const fixtures = [];
  let seed = 202610223;

  for (const playerCount of [3, 4, 5, 6]) {
    const engine = isolatedSearchEngine(new GameEngine({
      gridSize: 15,
      playerCount,
      rulesVersion: "territory-v2",
    }));
    const actions = [];

    for (let ply = 0; ply < 128 && !engine.gameOver; ply += 1) {
      const legal = engine.getLegalMoves();
      if (legal.length === 0) {
        engine.skipTurn();
        actions.push(null);
      } else {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const point = legal[seed % legal.length].point;
        const result = engine.playMove(point);
        if (!result.success) throw new Error("Failed to generate a legal multiplayer browser fixture");
        actions.push(point);
      }

      if (SNAPSHOT_PLIES.has(ply) && !engine.gameOver) {
        fixtures.push({
          state: serializeEngineState(engine),
          actions: [...actions],
        });
      }
    }
  }

  return fixtures;
}
