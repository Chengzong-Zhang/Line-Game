import { LOCAL_PLAYER_COLORS, normalizeLocalPlayers, localPlayerProfile, usesGenericBoardAI } from "./LocalAIModes.js?v=20261025-defense15";
import { DEFAULT_RESEARCH_VERSION, RESEARCH_FAMILIES } from "./ResearchAIOptions.js?v=20261025-defense15";

export const ROOM_PLAYER_COLORS = LOCAL_PLAYER_COLORS;
const THREE_MODELS = new Set(["three-player-policy-v1", "three-player-policy-v2", "three-player-search-v4-round12"]);
const HEX_MODELS = new Set(["hex-player-policy-v1", "hex-player-search-v5"]);
const activeColors = settings => ROOM_PLAYER_COLORS.slice(0, Number.isInteger(Number(settings?.playerCount)) && Number(settings.playerCount) >= 2 && Number(settings.playerCount) <= 15 ? Number(settings.playerCount) : 2);
const shapeFor = settings => settings?.boardShape ?? (Number(settings?.playerCount) >= 4 ? "hexagon" : "triangle");

function defaultBot(settings) {
  const count = activeColors(settings).length;
  const generic = usesGenericBoardAI(count, shapeFor(settings));
  return { choice: count >= 3 ? generic ? "ai-easy" : "ai-medium" : generic ? "greedy" : "minimax", depth: 3, version: DEFAULT_RESEARCH_VERSION };
}

/** Canonical seats are shared by Web, native Mini Game and the room service.
 * A missing setup is an old botCount room, with bots in its trailing seats.
 * Explicit setup always wins, including interleaved human/AI seats. */
export function normalizeRoomPlayerSetup(settings = {}, playerSetup = settings.playerSetup) {
  const colors = activeColors(settings), count = colors.length, shape = shapeFor(settings);
  let source = playerSetup;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    const botCount = Math.max(0, Math.min(count - 1, Number.isInteger(Number(settings.botCount)) ? Number(settings.botCount) : 0));
    source = Object.fromEntries(colors.map((color, index) => [color, index >= count - botCount ? defaultBot(settings) : { choice: "human" }]));
  }
  const normalized = normalizeLocalPlayers(source, count, shape);
  const result = Object.fromEntries(colors.map(color => {
    const input = source[color];
    let player = { ...normalized[color] };
    // Native local play also exposes Greedy on its native two-player board.
    if (count <= 6 && input?.choice === "greedy") player.choice = "greedy";
    // Historical native models are explicit choices; keep their identity when
    // sharing a Mini Game cabin instead of silently swapping model weights.
    if (count === 3 && shape === "triangle" && input?.choice === "three-player" && THREE_MODELS.has(input.version)) {
      player = { ...player, choice: "three-player", version: input.version };
    }
    if (count >= 4 && count <= 6 && shape === "hexagon" && input?.choice === "hex-player" && HEX_MODELS.has(input.version)) {
      player = { ...player, choice: "hex-player", version: input.version };
    }
    return [color, player];
  }));
  // An online room must have a host. Keep the remaining choices intact.
  if (!colors.some(color => result[color].choice === "human")) result[colors[0]].choice = "human";
  return result;
}

export function roomBotColors(settings = {}) {
  const players = normalizeRoomPlayerSetup(settings);
  return activeColors(settings).filter(color => players[color].choice !== "human");
}

export function roomHumanColors(settings = {}) {
  const players = normalizeRoomPlayerSetup(settings);
  return activeColors(settings).filter(color => players[color].choice === "human");
}

export function roomSettingsFromBoard(settings = {}, players = settings.playerSetup) {
  const playerSetup = normalizeRoomPlayerSetup(settings, players);
  const result = { ...settings, playerSetup };
  result.botCount = roomBotColors(result).length;
  return result;
}

export function roomPlayerProfile(player, settings = {}) {
  const count = activeColors(settings).length, shape = shapeFor(settings);
  if (player?.choice === "greedy") return { strategy: "greedy" };
  if (player?.choice === "three-player" && count === 3 && shape === "triangle" && THREE_MODELS.has(player.version)) {
    return { strategy: "three-player", modelId: player.version };
  }
  if (player?.choice === "hex-player" && count >= 4 && count <= 6 && shape === "hexagon" && HEX_MODELS.has(player.version)) {
    return { strategy: "hex-player", modelId: player.version };
  }
  return localPlayerProfile(player, count, settings.gridSize, shape);
}

export function roomPlayerFromController(controller = "human", settings = {}) {
  if (controller && typeof controller === "object") return { ...controller };
  const player = { choice: "human", depth: 3, version: DEFAULT_RESEARCH_VERSION };
  if (controller === "human" || controller === "greedy") return { ...player, choice: controller };
  if (/^minimax-[234]$/.test(controller)) return { ...player, choice: "minimax", depth: Number(controller.slice(-1)) };
  const tier = /^multiplayer-(easy|medium|hard|ultimate)-v1$/.exec(controller);
  if (tier) return { ...player, choice: `ai-${tier[1]}` };
  if (THREE_MODELS.has(controller)) return { ...player, choice: "three-player", version: controller };
  if (HEX_MODELS.has(controller)) return { ...player, choice: "hex-player", version: controller };
  const model = /^model:(.+)$/.exec(controller)?.[1];
  if (model) {
    for (const family of RESEARCH_FAMILIES) {
      const transferred = new RegExp(`^${family}-transfer-v1-seed(\\d+)$`).exec(model);
      if (transferred) return { ...player, choice: family, version: transferred[1] };
      if (model === `${family}-d14-s20260825-g200`) return { ...player, choice: family, version: "legacy" };
    }
    const family = /^(dqn|ppo|sac|gail|gan)-all-sizes(?:-e2000)?$/.exec(model)?.[1];
    if (family) return { ...player, choice: family };
  }
  return player;
}

export function roomControllerFromPlayer(player, settings = {}) {
  const profile = roomPlayerProfile(player, settings);
  if (!profile) return "human";
  if (profile.strategy === "greedy") return "greedy";
  if (profile.strategy === "minimax") return `minimax-${profile.depth}`;
  if (["multiplayer", "three-player", "hex-player"].includes(profile.strategy)) return profile.modelId;
  return `model:${profile.modelId}`;
}
