import { DEFAULT_RESEARCH_VERSION, RESEARCH_FAMILIES, TRANSFER_SEEDS, researchProfile } from "./ResearchAIOptions.js?v=20261020-three1";

export const LOCAL_PLAYER_CHOICES = Object.freeze([
  "human", "minimax", ...RESEARCH_FAMILIES, "dqn", "ppo", "sac", "gail", "gan",
]);
export const LOCAL_PLAYER_COLORS = Object.freeze(["BLACK", "WHITE", "PURPLE", "GREEN", "ORANGE", "CYAN"]);
export const HEX_PLAYER_CHOICES = Object.freeze(["human", "hex-player"]);
export const THREE_PLAYER_CHOICES = Object.freeze(["human", "three-player"]);
export const ALL_LOCAL_PLAYER_CHOICES = Object.freeze([...LOCAL_PLAYER_CHOICES, "three-player", "hex-player"]);
export const LOCAL_MATCH_PREFERENCES_KEY = "lifeline-local-match-preferences-v1";

export function normalizeLocalPlayers(players = {}, playerCount) {
  return Object.fromEntries(LOCAL_PLAYER_COLORS.map((color) => {
    const value = players?.[color];
    let choice = ALL_LOCAL_PLAYER_CHOICES.includes(value?.choice) ? value.choice : "human";
    if (playerCount === 3 && choice !== "human") choice = "three-player";
    if (playerCount === 2 && ["three-player", "hex-player"].includes(choice)) choice = "minimax";
    if (playerCount >= 4 && playerCount <= 6 && !HEX_PLAYER_CHOICES.includes(choice)) choice = "human";
    return [color, {
      choice,
      depth: [2, 3, 4].includes(Number(value?.depth)) ? Number(value.depth) : 3,
      version: ["legacy", ...TRANSFER_SEEDS.map(String)].includes(value?.version) ? value.version : DEFAULT_RESEARCH_VERSION,
    }];
  }));
}

export function localPlayerProfile(player, playerCount) {
  const config = normalizeLocalPlayers({ BLACK: player }, playerCount).BLACK;
  if (config.choice === "human") return null;
  if (config.choice === "three-player") return { strategy: "three-player", modelId: "three-player-policy-v1" };
  if (config.choice === "hex-player") return { strategy: "hex-player", modelId: "hex-player-policy-v1" };
  if (config.choice === "minimax") return { strategy: "minimax", depth: config.depth };
  if (RESEARCH_FAMILIES.includes(config.choice)) return researchProfile(config.choice, config.version);
  return { strategy: "model-free", modelId: `${config.choice}-all-sizes${["dqn", "ppo", "sac"].includes(config.choice) ? "-e2000" : ""}` };
}

export function localMatchMode(players, playerCount = 2) {
  const normalized = normalizeLocalPlayers(players, playerCount);
  if (playerCount >= 3) {
    const count = LOCAL_PLAYER_COLORS.slice(0, playerCount).filter((color) => normalized[color].choice !== "human").length;
    return count === playerCount ? "ai_duel" : count ? "mixed" : "none";
  }
  const blueAI = normalized.BLACK.choice !== "human";
  const redAI = normalized.WHITE.choice !== "human";
  return blueAI && redAI ? "ai_duel" : blueAI ? "ai_black" : redAI ? "ai_white" : "none";
}

export function localMatchActors(players, playerCount = 2) {
  return Object.fromEntries(LOCAL_PLAYER_COLORS.slice(0, playerCount).map((color) => {
    const profile = localPlayerProfile(players?.[color], playerCount);
    const actor = { kind: profile ? "ai" : "human" };
    for (const key of ["strategy", "modelId", "seed", "simulations", "cPuct", "depth"]) {
      if (profile?.[key] !== undefined) actor[key] = profile[key];
    }
    return [color, actor];
  }));
}

export function localAIPlayer(players, playerCount, currentPlayer) {
  if (!LOCAL_PLAYER_COLORS.slice(0, playerCount).includes(currentPlayer)) return null;
  return localPlayerProfile(players?.[currentPlayer], playerCount) ? currentPlayer : null;
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
