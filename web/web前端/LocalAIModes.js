import { DEFAULT_RESEARCH_VERSION, RESEARCH_FAMILIES, TRANSFER_SEEDS, researchProfile } from "./ResearchAIOptions.js?v=20261025-room1";
import { threePlayerModelIdForBoard } from "./ThreePlayerSearchOptions.js?v=20261025-room1";

export const LOCAL_PLAYER_CHOICES = Object.freeze([
  "human", "minimax", ...RESEARCH_FAMILIES, "dqn", "ppo", "sac", "gail", "gan",
]);
export const LOCAL_PLAYER_COLORS = Object.freeze(["BLACK", "WHITE", "PURPLE", "GREEN", "ORANGE", "CYAN"]);
export const MULTIPLAYER_AI_CHOICES = Object.freeze(["ai-easy", "ai-medium", "ai-hard", "ai-ultimate"]);
export const MULTIPLAYER_PLAYER_CHOICES = Object.freeze(["human", ...MULTIPLAYER_AI_CHOICES]);
export const MULTIPLAYER_GENERIC_CHOICES = Object.freeze(["human", "ai-easy", "ai-hard"]);
// Enable only after the trained asset passes the runtime and promotion checks.
export const MULTIPLAYER_ULTIMATE_AVAILABLE = false;
export const HEX_PLAYER_CHOICES = MULTIPLAYER_PLAYER_CHOICES;
export const THREE_PLAYER_CHOICES = MULTIPLAYER_PLAYER_CHOICES;
export const GENERIC_PLAYER_CHOICES = Object.freeze(["human", "greedy"]);
export const ALL_LOCAL_PLAYER_CHOICES = Object.freeze([...LOCAL_PLAYER_CHOICES, ...MULTIPLAYER_AI_CHOICES, "three-player", "hex-player", "greedy"]);
export function localPlayerChoices(playerCount, boardShape) {
  if (playerCount >= 3) return usesGenericBoardAI(playerCount, boardShape) ? MULTIPLAYER_GENERIC_CHOICES : MULTIPLAYER_PLAYER_CHOICES;
  return usesGenericBoardAI(playerCount, boardShape) ? GENERIC_PLAYER_CHOICES : LOCAL_PLAYER_CHOICES;
}
export function usesGenericBoardAI(playerCount, boardShape) {
  return Boolean(boardShape && boardShape !== (playerCount >= 4 ? "hexagon" : "triangle"));
}
export const LOCAL_MATCH_PREFERENCES_KEY = "lifeline-local-match-preferences-v1";

export function normalizeLocalPlayers(players = {}, playerCount, boardShape) {
  return Object.fromEntries(LOCAL_PLAYER_COLORS.map((color) => {
    const value = players?.[color];
    let choice = ALL_LOCAL_PLAYER_CHOICES.includes(value?.choice) ? value.choice : "human";
    if (playerCount >= 3 && MULTIPLAYER_AI_CHOICES.includes(choice)) {
      if (usesGenericBoardAI(playerCount, boardShape) && !MULTIPLAYER_GENERIC_CHOICES.includes(choice)) choice = "ai-hard";
    } else if (usesGenericBoardAI(playerCount, boardShape)) {
      if (choice !== "human") choice = "greedy";
    } else {
      if (playerCount === 2 && choice === "greedy") choice = "minimax";
      if (playerCount >= 4 && choice === "greedy") choice = "hex-player";
      if (playerCount === 3 && choice !== "human") choice = "three-player";
      if (playerCount === 2 && ["three-player", "hex-player", ...MULTIPLAYER_AI_CHOICES].includes(choice)) choice = "minimax";
      if (playerCount >= 4 && playerCount <= 6 && !["human", "hex-player"].includes(choice)) choice = "human";
    }
    return [color, {
      choice,
      depth: [2, 3, 4].includes(Number(value?.depth)) ? Number(value.depth) : 3,
      version: ["legacy", ...TRANSFER_SEEDS.map(String)].includes(value?.version) ? value.version : DEFAULT_RESEARCH_VERSION,
    }];
  }));
}

export function localPlayerProfile(player, playerCount, gridSize, boardShape) {
  const config = normalizeLocalPlayers({ BLACK: player }, playerCount, boardShape).BLACK;
  if (config.choice === "human") return null;
  if (MULTIPLAYER_AI_CHOICES.includes(config.choice)) return { strategy: "multiplayer", modelId: `multiplayer-${config.choice.slice(3)}-v1` };
  if (config.choice === "greedy") return { strategy: "greedy" };
  if (config.choice === "three-player") return { strategy: "three-player", modelId: threePlayerModelIdForBoard(gridSize) };
  if (config.choice === "hex-player") return { strategy: "hex-player", modelId: "hex-player-policy-v1" };
  if (config.choice === "minimax") return { strategy: "minimax", depth: config.depth };
  if (RESEARCH_FAMILIES.includes(config.choice)) return researchProfile(config.choice, config.version);
  return { strategy: "model-free", modelId: `${config.choice}-all-sizes${["dqn", "ppo", "sac"].includes(config.choice) ? "-e2000" : ""}` };
}

export function localMatchMode(players, playerCount = 2, boardShape) {
  const normalized = normalizeLocalPlayers(players, playerCount, boardShape);
  if (playerCount >= 3) {
    const count = LOCAL_PLAYER_COLORS.slice(0, playerCount).filter((color) => normalized[color].choice !== "human").length;
    return count === playerCount ? "ai_duel" : count ? "mixed" : "none";
  }
  const blueAI = normalized.BLACK.choice !== "human";
  const redAI = normalized.WHITE.choice !== "human";
  return blueAI && redAI ? "ai_duel" : blueAI ? "ai_black" : redAI ? "ai_white" : "none";
}

export function localMatchActors(players, playerCount = 2, gridSize, boardShape) {
  return Object.fromEntries(LOCAL_PLAYER_COLORS.slice(0, playerCount).map((color) => {
    const profile = localPlayerProfile(players?.[color], playerCount, gridSize, boardShape);
    const actor = { kind: profile ? "ai" : "human" };
    for (const key of ["strategy", "modelId", "seed", "simulations", "cPuct", "depth"]) {
      if (profile?.[key] !== undefined) actor[key] = profile[key];
    }
    return [color, actor];
  }));
}

export function localAIPlayer(players, playerCount, currentPlayer, gridSize, boardShape) {
  if (!LOCAL_PLAYER_COLORS.slice(0, playerCount).includes(currentPlayer)) return null;
  return localPlayerProfile(players?.[currentPlayer], playerCount, gridSize, boardShape) ? currentPlayer : null;
}

export function loadLocalMatchPreferences(storage = globalThis.localStorage) {
  try {
    const value = JSON.parse(storage?.getItem(LOCAL_MATCH_PREFERENCES_KEY) ?? "null");
    return value ? { players: normalizeLocalPlayers(value.players), settings: value.settings } : null;
  } catch (_) { return null; }
}

export function persistLocalMatchPreferences(players, settings, storage = globalThis.localStorage) {
  try { storage?.setItem(LOCAL_MATCH_PREFERENCES_KEY, JSON.stringify({ players: normalizeLocalPlayers(players), settings })); }
  catch (_) { /* The visible selection still works without storage. */ }
}

// Retain the legacy mode adapter for older integrations.
export const LOCAL_AI_MODES = Object.freeze(["none", "ai_black", "ai_white", "ai_duel"]);

export function resolveAIPlayer(mode, currentPlayer) {
  if (mode === "ai_duel") return currentPlayer;
  if (mode === "ai_black") return "BLACK";
  if (mode === "ai_white") return "WHITE";
  return null;
}

export function localAIActors(mode, profile, playerCount = 2) {
  const aiActor = { kind: "ai" };
  for (const key of ["strategy", "modelId", "seed", "simulations", "cPuct", "depth"]) {
    if (profile[key] !== undefined) aiActor[key] = profile[key];
  }
  const colors = LOCAL_PLAYER_COLORS.slice(0, playerCount);
  return Object.fromEntries(colors.map((player) => [player,
    playerCount === 2 && (mode === "ai_duel" || resolveAIPlayer(mode, player) === player)
      ? { ...aiActor } : { kind: "human" }]));
}
