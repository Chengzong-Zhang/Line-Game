// One isolated, bounded request. Python owns room identity/order; this process
// replays the complete rule history before accepting any human or AI action.
import { GameEngine, PLAYER_ORDER } from "../web前端/GameEngine.js?v=20261025-room1";
import { normalizeRoomPlayerSetup, roomBotColors, roomPlayerProfile } from "../web前端/OnlineRoomSettings.js";
import { ALL_LOCAL_PLAYER_CHOICES } from "../web前端/LocalAIModes.js?v=20261025-room1";
import { chooseRoomBotMove } from "./online_bot_runtime.mjs";
import { webcrypto } from "node:crypto";
import { pathToFileURL } from "node:url";

// Node 18 exposes this API even when its browser-style global is disabled.
// Preserve the model's SHA-256 validation in both runtime configurations.
if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;


function applyAction(engine, action) {
  if (!action || !engine.activePlayers.includes(action.color)) {
    return { success: false, reason: "INVALID_ACTOR" };
  }
  if (action.type === "player_resign") return engine.resignPlayer(action.color);
  if (action.color !== engine.currentPlayer) return { success: false, reason: "OUT_OF_TURN" };
  if (action.type === "player_skip") return engine.skipTurn();
  if (action.type === "player_move") {
    if (!Array.isArray(action.point) || action.point.length !== 2 || !action.point.every(Number.isInteger)) {
      return { success: false, reason: "INVALID_POINT" };
    }
    return engine.playMove(action.point);
  }
  return { success: false, reason: "INVALID_ACTION" };
}

export async function processBotRequest(request, { chooseBotPoint = chooseRoomBotMove } = {}) {
  const settings = request?.settings;
  const playerCount = settings?.playerCount;
  const colors = PLAYER_ORDER.slice(0, playerCount);
  if (![2, 3, 4, 5, 6].includes(playerCount) || !["territory-v2", "territory-v3"].includes(settings.rulesVersion)
    || !Number.isInteger(settings.gridSize) || settings.gridSize < 5 || settings.gridSize > 15
    || !colors.includes(settings.startPlayer ?? "BLACK")
    || !Array.isArray(request.actions) || request.actions.length > 4096
    || request.botColors !== undefined && (!Array.isArray(request.botColors)
      || request.botColors.length >= playerCount
      || new Set(request.botColors).size !== request.botColors.length
      || request.botColors.some((color) => !colors.includes(color)))) {
    return { success: false, reason: "INVALID_CONFIGURATION" };
  }
  if (settings.playerSetup !== undefined) {
    const setup = settings.playerSetup;
    const versions = new Set(["legacy", "2026092201", "2026092202", "2026092203", "three-player-policy-v1", "three-player-policy-v2", "three-player-search-v4-round12", "hex-player-policy-v1", "hex-player-search-v5"]);
    if (!setup || typeof setup !== "object" || Array.isArray(setup)
      || Object.entries(setup).some(([color, player]) => !PLAYER_ORDER.includes(color) || !player || typeof player !== "object" || Array.isArray(player)
        || !ALL_LOCAL_PLAYER_CHOICES.includes(player.choice)
        || player.depth !== undefined && ![2, 3, 4].includes(player.depth)
        || player.version !== undefined && !versions.has(player.version))
      || colors.every(color => setup[color] && setup[color].choice !== "human")) {
      return { success: false, reason: "INVALID_CONFIGURATION" };
    }
  }
  // For older callers only botColors identifies the configured seats. New
  // rooms carry complete profiles and cannot override them with botColors.
  const playerSetup = normalizeRoomPlayerSetup(settings);
  const explicitSetup = settings.playerSetup && typeof settings.playerSetup === "object" && !Array.isArray(settings.playerSetup);
  let botColors = roomBotColors({ ...settings, playerSetup });
  if (explicitSetup && request.botColors !== undefined
    && (request.botColors.length !== botColors.length || request.botColors.some(color => !botColors.includes(color)))) {
    return { success: false, reason: "INVALID_CONFIGURATION" };
  }
  if (!explicitSetup && request.botColors !== undefined) {
    botColors = request.botColors;
    const defaults = normalizeRoomPlayerSetup({ ...settings, botCount: playerCount - 1 });
    const defaultBot = Object.values(defaults).find(player => player.choice !== "human");
    for (const color of colors) playerSetup[color] = botColors.includes(color) ? { ...defaultBot } : { ...playerSetup[color], choice: "human" };
  }
  let engine;
  try { engine = new GameEngine(settings); }
  catch (_) { return { success: false, reason: "INVALID_CONFIGURATION" }; }
  const replay = engine.replayBatch((branch) => {
    for (const action of request.actions) {
      const result = applyAction(branch, action);
      if (!result.success) return { success: false, reason: `INVALID_REPLAY:${result.reason}` };
    }
    return { success: true };
  });
  if (!replay.success) return { success: false, reason: replay.reason };

  let action = request.action ?? null;
  let fallback = false;
  let fallbackReason = null, modelInfo = null, botProfile = null;
  if (action && botColors.includes(action.color)) {
    return { success: false, reason: "BOT_ACTOR_FORBIDDEN" };
  }
  if (!action && !engine.gameOver && botColors.includes(engine.currentPlayer)) {
    let point;
    botProfile = roomPlayerProfile(playerSetup[engine.currentPlayer], settings);
    try {
      const selected = await chooseBotPoint(engine, botProfile);
      if (selected && !Array.isArray(selected) && typeof selected === "object") {
        point = selected.point;
        modelInfo = selected.modelInfo ?? null;
      } else point = selected;
      if (point !== null && (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isInteger))) {
        throw new Error("AI_RETURNED_INVALID_DECISION");
      }
    } catch (error) {
      // Product admission never becomes a legal-move fallback under a more
      // impressive label. Keep the game intact until the host changes it.
      if (error?.code?.startsWith("ULTIMATE_")) return { success: false, reason: error.code, message: error.message, botProfile };
      // Model availability must not strand a match. Use a canonical legal move
      // and explicitly return the degradation to the server.
      fallback = true;
      fallbackReason = String(error?.message ?? error);
      point = engine.getLegalMoves()[0]?.point ?? null;
    }
    action = point
      ? { type: "player_move", color: engine.currentPlayer, point }
      : { type: "player_skip", color: engine.currentPlayer };
  }
  if (action) {
    const result = applyAction(engine, action);
    if (!result.success) return { success: false, reason: result.reason };
  }
  return {
    success: true,
    action,
    currentPlayer: engine.currentPlayer,
    gameOver: engine.gameOver,
    fallback,
    ...(botProfile ? { botProfile, modelInfo } : {}),
    ...(fallbackReason ? { fallbackReason } : {}),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 1024 * 1024) throw new Error("INPUT_TOO_LARGE");
    }
    process.stdout.write(JSON.stringify(await processBotRequest(JSON.parse(input))));
  } catch (error) {
    process.stderr.write(String(error?.message ?? error));
    process.exitCode = 1;
  }
}
