import { DEFAULT_RESEARCH_VERSION, RESEARCH_FAMILIES, TRANSFER_SEEDS, researchProfile } from "./ResearchAIOptions.js?v=20261013-sync1";

export const LOCAL_PLAYER_CHOICES = Object.freeze([
  "human", "minimax", ...RESEARCH_FAMILIES, "dqn", "ppo", "sac", "gail", "gan",
]);
export const LOCAL_MATCH_PREFERENCES_KEY = "lifeline-local-match-preferences-v1";

export function normalizeLocalPlayers(players = {}) {
  return Object.fromEntries(["BLACK", "WHITE"].map((color) => {
    const value = players?.[color];
    return [color, {
      choice: LOCAL_PLAYER_CHOICES.includes(value?.choice) ? value.choice : "human",
      depth: [2, 3, 4].includes(Number(value?.depth)) ? Number(value.depth) : 3,
      version: ["legacy", ...TRANSFER_SEEDS.map(String)].includes(value?.version) ? value.version : DEFAULT_RESEARCH_VERSION,
    }];
  }));
}

export function localPlayerProfile(player) {
  const config = normalizeLocalPlayers({ BLACK: player }).BLACK;
  if (config.choice === "human") return null;
  if (config.choice === "minimax") return { strategy: "minimax", depth: config.depth };
  if (RESEARCH_FAMILIES.includes(config.choice)) return researchProfile(config.choice, config.version);
  return { strategy: "model-free", modelId: `${config.choice}-all-sizes${["dqn", "ppo", "sac"].includes(config.choice) ? "-e2000" : ""}` };
}

export function localMatchMode(players, playerCount = 2) {
  if (playerCount !== 2) return "none";
  const normalized = normalizeLocalPlayers(players);
  const blueAI = normalized.BLACK.choice !== "human";
  const redAI = normalized.WHITE.choice !== "human";
  return blueAI && redAI ? "ai_duel" : blueAI ? "ai_black" : redAI ? "ai_white" : "none";
}

export function localMatchActors(players, playerCount = 2) {
  return Object.fromEntries(["BLACK", "WHITE", ...(playerCount === 3 ? ["PURPLE"] : [])].map((color) => {
    const profile = playerCount === 2 ? localPlayerProfile(players?.[color]) : null;
    const actor = { kind: profile ? "ai" : "human" };
    for (const key of ["strategy", "modelId", "seed", "simulations", "cPuct", "depth"]) {
      if (profile?.[key] !== undefined) actor[key] = profile[key];
    }
    return [color, actor];
  }));
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
  const colors = ["BLACK", "WHITE", ...(playerCount === 3 ? ["PURPLE"] : [])];
  return Object.fromEntries(colors.map((player) => [player,
    playerCount === 2 && (mode === "ai_duel" || resolveAIPlayer(mode, player) === player)
      ? { ...aiActor } : { kind: "human" }]));
}
