import {
  getBoardPositions, PLAYER_ORDER, resolveInitialPositions, resolveInitialRoots, RootMode, RootRulesVersion,
} from "./GameEngine.js?v=20261021-boardshapes1";

export const STARTING_POINT_MODES = Object.freeze(["default", "random", "custom"]);

export function startingPointSettings(settings) {
  const mode = settings.startingPointMode ?? (settings.initialPositions ? "custom" : "default");
  if (!STARTING_POINT_MODES.includes(mode)) throw new Error("Unknown starting point mode.");
  const rootMode = settings.rootMode ?? RootMode.CLASSIC;
  if (rootMode !== RootMode.CLASSIC) {
    const initialRoots = resolveInitialRoots(
      settings.gridSize, settings.playerCount, settings.initialRoots, settings.boardShape, rootMode, settings.initialPositions,
    );
    return {
      rootMode,
      rootRulesVersion: RootRulesVersion.V2,
      startingPointMode: mode,
      initialRoots,
    };
  }
  if (mode === "default" && settings.initialPositions == null) return {};
  if (settings.initialPositions == null) throw new Error("Starting points have not been selected.");
  return {
    startingPointMode: mode === "default" ? "custom" : mode,
    initialPositions: resolveInitialPositions(settings.gridSize, settings.playerCount, settings.initialPositions, settings.boardShape),
  };
}

export function randomInitialRoots(gridSize, playerCount, rootMode, random = Math.random, boardShape = null) {
  if (rootMode === RootMode.CLASSIC) {
    const positions = randomInitialPositions(gridSize, playerCount, random, boardShape);
    return resolveInitialRoots(gridSize, playerCount, null, boardShape, rootMode, positions);
  }
  const count = rootMode === RootMode.FIXED_DOUBLE ? 2 : 1;
  const players = PLAYER_ORDER.slice(0, playerCount);
  for (let attempt = 0; attempt < 256; attempt += 1) {
    const available = getBoardPositions(gridSize, playerCount, boardShape);
    const candidate = {};
    for (const player of players) {
      candidate[player] = [];
      for (let index = 0; index < count; index += 1) {
        const sample = random();
        if (!(sample >= 0 && sample < 1)) throw new Error("Invalid random sample.");
        candidate[player].push(available.splice(Math.floor(sample * available.length), 1)[0]);
      }
    }
    try {
      return resolveInitialRoots(gridSize, playerCount, candidate, boardShape, rootMode);
    } catch (_error) {
      // Bounded retry: invalid protection/collinearity layouts are discarded.
    }
  }
  throw new Error("No valid random root layout was found. Try a larger board or fewer players.");
}

// Sample lattice positions without replacement. The resolved points are saved;
// replay/refresh never calls the random generator again.
export function randomInitialPositions(gridSize, playerCount, random = Math.random, boardShape = null) {
  const points = getBoardPositions(gridSize, playerCount, boardShape);
  const positions = {};
  for (const player of PLAYER_ORDER.slice(0, playerCount)) {
    const sample = random();
    if (!(sample >= 0 && sample < 1)) throw new Error("Invalid random sample.");
    const index = Math.floor(sample * points.length);
    positions[player] = points.splice(index, 1)[0];
  }
  return resolveInitialPositions(gridSize, playerCount, positions, boardShape);
}
