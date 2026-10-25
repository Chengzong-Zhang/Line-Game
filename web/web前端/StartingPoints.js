import { getBoardPositions, PLAYER_ORDER, resolveInitialPositions } from "./GameEngine.js?v=20261025-ai1";

export const STARTING_POINT_MODES = Object.freeze(["default", "random", "custom"]);

export function startingPointSettings(settings) {
  const mode = settings.startingPointMode ?? (settings.initialPositions ? "custom" : "default");
  if (!STARTING_POINT_MODES.includes(mode)) throw new Error("Unknown starting point mode.");
  if (mode === "default" && settings.initialPositions == null) return {};
  if (settings.initialPositions == null) throw new Error("Starting points have not been selected.");
  return {
    startingPointMode: mode === "default" ? "custom" : mode,
    initialPositions: resolveInitialPositions(settings.gridSize, settings.playerCount, settings.initialPositions, settings.boardShape),
  };
}

// Keep random openings spread across the board. The resolved points are saved;
// replay/refresh never calls the random generator again.
export function randomInitialPositions(gridSize, playerCount, random = Math.random, boardShape = null) {
  const points = getBoardPositions(gridSize, playerCount, boardShape);
  const positions = {};
  const chosen = [];
  for (const player of PLAYER_ORDER.slice(0, playerCount)) {
    const distance = ([x, y], [a, b]) => Math.max(Math.abs(x - a), Math.abs(y - b), Math.abs(x + y - a - b));
    const best = chosen.length ? Math.max(...points.map(point => Math.min(...chosen.map(other => distance(point, other))))) : 0;
    const candidates = chosen.length
      ? points.filter(point => Math.min(...chosen.map(other => distance(point, other))) >= best * 0.75)
      : points;
    const sample = random();
    if (!(sample >= 0 && sample < 1)) throw new Error("Invalid random sample.");
    const point = candidates[Math.floor(sample * candidates.length)];
    positions[player] = point;
    chosen.push(point);
    points.splice(points.indexOf(point), 1);
  }
  return resolveInitialPositions(gridSize, playerCount, positions, boardShape);
}
