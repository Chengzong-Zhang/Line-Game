import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const enginePath = path.resolve(here, "../../../web/web前端/GameEngine.js");
const engineSource = await readFile(enginePath, "utf8");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(engineSource).toString("base64")}`;
const { GameEngine, Player } = await import(moduleUrl);

let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input || "{}");
const engine = new GameEngine({ gridSize: request.grid_size ?? 5, playerCount: 2 });
// Territory does not affect move legality or transitions. Match the training
// engine by suppressing intermediate recomputation and restoring it at terminal.
const updateTerritories = engine._updateTerritories.bind(engine);
engine._updateTerritories = () => {};

function normalizeEdges(edgeSet) {
  return [...edgeSet].sort();
}

function traceState(result = { success: true, reason: null }) {
  const scores = engine.getScoreboard();
  return {
    result: { success: result.success, reason: result.reason ?? null },
    board: engine.getValidPositions().map((point) => engine.getStateAt(point)),
    current_player: engine.currentPlayer,
    game_over: engine.gameOver,
    consecutive_skips: engine.consecutiveSkips,
    turn_count: engine.turnCount,
    edges: {
      BLACK: normalizeEdges(engine.edges[Player.BLACK]),
      WHITE: normalizeEdges(engine.edges[Player.WHITE]),
    },
    legal_moves: engine.getLegalMoves(engine.currentPlayer).map(({ point }) => point),
    territories: {
      BLACK: { area: scores.BLACK.area, display_area: scores.BLACK.displayArea },
      WHITE: { area: scores.WHITE.area, display_area: scores.WHITE.displayArea },
    },
    winner: engine.getWinner(),
  };
}

const trace = [traceState()];
for (const action of request.actions ?? []) {
  const result = action === null ? engine.skipTurn() : engine.playMove(action);
  if (engine.gameOver) updateTerritories();
  trace.push(traceState(result));
}
process.stdout.write(JSON.stringify(trace));
