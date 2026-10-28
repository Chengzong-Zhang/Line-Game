import { PLAYER_ORDER } from "./GameEngine.js?v=20261027-topology-multistart-release1";
import { DEFAULT_RESEARCH_VERSION, RESEARCH_FAMILIES, TRANSFER_SEEDS, researchProfile } from "./ResearchAIOptions.js?v=20261026-allplatform1";
import { threePlayerModelIdForBoard } from "./ThreePlayerSearchOptions.js?v=20261026-allplatform1";

export const LOCAL_PLAYER_CHOICES = Object.freeze([
  "human", "minimax", ...RESEARCH_FAMILIES, "dqn", "ppo", "sac", "gail", "gan",
]);
// Keep the full list above for existing sessions and room actor identities.
// Ordinary setup offers only the AI difficulties supported by this board.
export const LOCAL_PLAYER_MENU_CHOICES = Object.freeze(["human", "minimax"]);
export const LOCAL_PLAYER_COLORS = PLAYER_ORDER;
export const MULTIPLAYER_AI_CHOICES = Object.freeze(["ai-easy", "ai-medium", "ai-hard", "ai-ultimate"]);
export const MULTIPLAYER_PLAYER_CHOICES = Object.freeze(["human", "ai-easy", "ai-medium", "ai-hard"]);
export const MULTIPLAYER_GENERIC_CHOICES = Object.freeze(["human", "ai-easy", "ai-hard"]);
// Enable only after the trained asset passes the runtime and promotion checks.
export const MULTIPLAYER_ULTIMATE_AVAILABLE = false;
export const HEX_PLAYER_CHOICES = MULTIPLAYER_PLAYER_CHOICES;
export const THREE_PLAYER_CHOICES = MULTIPLAYER_PLAYER_CHOICES;
export const GENERIC_PLAYER_CHOICES = Object.freeze(["human", "greedy"]);
// A topology board has canonical graph vertices rather than coordinate moves.
// Keep its one currently admitted route explicit so a fixed-shape model cannot
// be presented as a compatible difficulty tier.
export const TOPOLOGY_GENERIC_CHOICE = "topology-generic";
export const TOPOLOGY_GENERIC_CHOICES = Object.freeze(["human", TOPOLOGY_GENERIC_CHOICE]);
export const ALL_LOCAL_PLAYER_CHOICES = Object.freeze([
  ...LOCAL_PLAYER_CHOICES,
  ...MULTIPLAYER_AI_CHOICES,
  "three-player",
  "hex-player",
  "greedy",
  TOPOLOGY_GENERIC_CHOICE,
]);
export const LOCAL_LAB_MODELS = Object.freeze([
  ...RESEARCH_FAMILIES.flatMap((choice) => [
    ...TRANSFER_SEEDS.map((seed, index) => Object.freeze({
      id: `${choice}:${seed}`, choice, version: String(seed),
      label: `${choice} · S0${index + 1} (${seed})`,
      modelId: researchProfile(choice, String(seed)).modelId,
    })),
    Object.freeze({ id: `${choice}:legacy`, choice, version: "legacy",
      label: `${choice} · D14 (20260825)`, modelId: researchProfile(choice, "legacy").modelId }),
  ]),
  ...["dqn", "ppo", "sac", "gail", "gan"].map((choice) => Object.freeze({
    id: choice, choice, version: DEFAULT_RESEARCH_VERSION,
    label: choice.toUpperCase(),
    modelId: `${choice}-all-sizes${["dqn", "ppo", "sac"].includes(choice) ? "-e2000" : ""}`,
  })),
]);

export function isLocalLabPlayer(player) {
  return LOCAL_LAB_MODELS.some(({ choice, version }) => player?.choice === choice
    && (!RESEARCH_FAMILIES.includes(choice) || player?.version === version));
}

export function prepareLocalPlayersForNewMatch(players = {}, playerCount, boardShape, explicitLabColors = []) {
  const draft = normalizeLocalPlayerDraft(players, playerCount, boardShape);
  if (playerCount === 2 && boardShape === "triangle") {
    for (const color of explicitLabColors) {
      if (LOCAL_PLAYER_COLORS.slice(0, playerCount).includes(color) && isLocalLabPlayer(players?.[color])) {
        draft[color] = normalizeLocalPlayers(players, playerCount, boardShape)[color];
      }
    }
  }
  return draft;
}
export function localPlayerChoices(playerCount, boardShape) {
  if (boardShape === "custom") return TOPOLOGY_GENERIC_CHOICES;
  if (playerCount >= 3) return usesGenericBoardAI(playerCount, boardShape) ? MULTIPLAYER_GENERIC_CHOICES : MULTIPLAYER_PLAYER_CHOICES;
  if (playerCount === 2 && boardShape === "diamond") return LOCAL_PLAYER_MENU_CHOICES;
  return usesGenericBoardAI(playerCount, boardShape) ? GENERIC_PLAYER_CHOICES : LOCAL_PLAYER_MENU_CHOICES;
}
export function usesGenericBoardAI(playerCount, boardShape) {
  return playerCount > 6 || Boolean(boardShape && boardShape !== (playerCount >= 4 ? "hexagon" : "triangle"));
}

// Root-v2 changes both legal actions and the state identity.  Only the
// generic search paths below have a validated complete-state contract; model
// routes remain unavailable rather than being silently used as classic AI.
export function supportsRootModeAI(profile, rootMode = "classic") {
  if (rootMode === "classic" || !profile) return true;
  return ["greedy", "minimax", "mcts"].includes(profile.strategy);
}
export const LOCAL_MATCH_PREFERENCES_KEY = "lifeline-local-match-preferences-v1";

export function normalizeLocalPlayers(players = {}, playerCount, boardShape) {
  return Object.fromEntries(LOCAL_PLAYER_COLORS.map((color) => {
    const value = players?.[color];
    let choice = ALL_LOCAL_PLAYER_CHOICES.includes(value?.choice) ? value.choice : "human";
    if (boardShape === "custom") {
      // Migrate old generic/multiplayer choices to the graph-aware route. The
      // choice intentionally carries no strength claim; it only means the
      // Worker can return a legal canonical vertex or explicit PASS.
      if (choice !== "human") choice = TOPOLOGY_GENERIC_CHOICE;
    } else if (playerCount > 6) {
      if (choice === "greedy") choice = "ai-easy";
      else if (choice !== "human" && !MULTIPLAYER_GENERIC_CHOICES.includes(choice)) choice = "ai-hard";
    } else if (playerCount >= 3 && MULTIPLAYER_AI_CHOICES.includes(choice)) {
      if (usesGenericBoardAI(playerCount, boardShape) && !MULTIPLAYER_GENERIC_CHOICES.includes(choice)) choice = "ai-hard";
    } else if (usesGenericBoardAI(playerCount, boardShape)) {
      if (choice !== "human") choice = playerCount === 2 && boardShape === "diamond" ? "minimax" : "greedy";
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

// A board/count change creates a new-match draft. Preserve old saved matches
// through normalizeLocalPlayers, but choose an available tier for this draft.
export function normalizeLocalPlayerDraft(players = {}, playerCount, boardShape) {
  const normalized = normalizeLocalPlayers(players, playerCount, boardShape);
  const available = localPlayerChoices(playerCount, boardShape);
  const generic = usesGenericBoardAI(playerCount, boardShape);
  return Object.fromEntries(LOCAL_PLAYER_COLORS.map((color, index) => {
    const current = normalized[color];
    if (index >= playerCount || players?.[color]?.choice === "human") return [color, current];
    const original = players?.[color];
    if (!ALL_LOCAL_PLAYER_CHOICES.includes(original?.choice)) return [color, current];
    if (boardShape === "custom") {
      return [color, current.choice === "human"
        ? current
        : { ...current, choice: TOPOLOGY_GENERIC_CHOICE }];
    }
    if (playerCount === 2) {
      if (generic) return [color, { ...current, choice: boardShape === "diamond" ? "minimax" : "greedy" }];
      const depth = original.choice === "ai-easy" || original.choice === "greedy" ? 2
        : original.choice === "ai-hard" ? 4 : current.depth;
      return [color, { ...current, choice: "minimax", depth }];
    }
    if (current.choice !== "human" && available.includes(current.choice)) return [color, current];
    let choice = playerCount > 6 ? "ai-hard" : available.includes("ai-medium") ? "ai-medium" : "ai-easy";
    if (original.choice === "minimax") {
      if (original.depth === 2) choice = "ai-easy";
      if (original.depth === 4) choice = "ai-hard";
    } else if (original.choice === "greedy") choice = "ai-easy";
    if (!available.includes(choice)) choice = available.includes("ai-hard") ? "ai-hard" : "ai-easy";
    return [color, { ...current, choice }];
  }));
}

export function localPlayerProfile(player, playerCount, gridSize, boardShape) {
  const config = normalizeLocalPlayers({ BLACK: player }, playerCount, boardShape).BLACK;
  if (config.choice === "human") return null;
  if (config.choice === TOPOLOGY_GENERIC_CHOICE) return { strategy: TOPOLOGY_GENERIC_CHOICE };
  // The easy multiplayer weights were trained and admitted only on the
  // triangle/hexagon product boards. Keep the visible Easy tier on a diamond,
  // but execute the untrained, shape-aware rule baseline instead of relabeling
  // those weights as a diamond model. The same generic route is used for the
  // 7–15 player Easy tier.
  if (config.choice === "ai-easy" && (playerCount > 6 || boardShape === "diamond")) return { strategy: "greedy" };
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
