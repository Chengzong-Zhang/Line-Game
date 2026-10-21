// One isolated, bounded request. Python owns room identity/order; this process
// replays the complete rule history before accepting any human or AI action.
import { readFile } from "node:fs/promises";
import { createHash, webcrypto } from "node:crypto";
import { pathToFileURL } from "node:url";

// Node 18 exposes this API even when its browser-style global is disabled.
// Preserve the model's SHA-256 validation in both runtime configurations.
if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

const frontend = new URL("../web前端/", import.meta.url);
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const engineUrl = moduleUrl(await readFile(new URL("GameEngine.js", frontend), "utf8"));
const { GameEngine, PLAYER_ORDER } = await import(engineUrl);

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

async function chooseBotPointFromModel(engine) {
  const aiSource = (await readFile(new URL("AIEngine.js", frontend), "utf8"))
    .replace(/(["'])\.\/GameEngine\.js(?:\?[^"']*)?\1/g, JSON.stringify(engineUrl));
  const aiUrl = moduleUrl(aiSource);
  const hexagonal = engine.playerCount >= 4;
  const moduleName = hexagonal ? "HexPlayerAI.js" : "ThreePlayerAI.js";
  const source = (await readFile(new URL(moduleName, frontend), "utf8"))
    .replace(/(["'])\.\/AIEngine\.js(?:\?[^"']*)?\1/g, JSON.stringify(aiUrl))
    .replace(/(["'])\.\/GameEngine\.js(?:\?[^"']*)?\1/g, JSON.stringify(engineUrl))
    .replaceAll("import.meta.url", JSON.stringify(new URL(moduleName, frontend).href));
  const policyUrl = moduleUrl(source);
  const loaded = await import(policyUrl);
  const AI = hexagonal ? loaded.HexPlayerAI : loaded.ThreePlayerAI;
  let createModel = hexagonal ? loaded.createHexPlayerModel : loaded.createThreePlayerModel;
  let modelId = hexagonal ? "hex-player-policy-v1" : "three-player-policy-v1";
  let expectedHash = null;
  if (!hexagonal) {
    const registrySource = (await readFile(new URL("ThreePlayerModels.js", frontend), "utf8"))
      .replace(/(["'])\.\/ThreePlayerAI\.js(?:\?[^"']*)?\1/g, JSON.stringify(policyUrl))
      .replaceAll("import.meta.url", JSON.stringify(new URL("ThreePlayerModels.js", frontend).href));
    const registry = await import(moduleUrl(registrySource));
    modelId = registry.DEFAULT_THREE_PLAYER_MODEL_ID;
    createModel = registry.createSupportedThreePlayerModel;
    expectedHash = registry.THREE_PLAYER_MODEL_HASHES[modelId];
  }
  const bytes = await readFile(new URL(`assets/research-ai/${modelId}.json`, frontend));
  if (expectedHash && createHash("sha256").update(bytes).digest("hex") !== expectedHash) {
    throw new Error("Three-player model integrity mismatch");
  }
  const payload = JSON.parse(bytes);
  const moves = new AI(await createModel(payload)).getTopMoves(engine, engine.currentPlayer, 1);
  return moves[0]?.point ?? null;
}

export async function processBotRequest(request, { chooseBotPoint = chooseBotPointFromModel } = {}) {
  const settings = request?.settings;
  const playerCount = settings?.playerCount;
  const colors = PLAYER_ORDER.slice(0, playerCount);
  if (![3, 4, 5, 6].includes(playerCount) || settings.rulesVersion !== "territory-v2"
    || !Number.isInteger(settings.gridSize) || settings.gridSize < 5 || settings.gridSize > 15
    || !colors.includes(settings.startPlayer ?? "BLACK")
    || !Array.isArray(request.actions) || request.actions.length > 4096
    || !Array.isArray(request.botColors)
    || request.botColors.length >= playerCount
    || new Set(request.botColors).size !== request.botColors.length
    || request.botColors.some((color) => !colors.includes(color))) {
    return { success: false, reason: "INVALID_CONFIGURATION" };
  }
  const engine = new GameEngine(settings);
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
  if (action && request.botColors.includes(action.color)) {
    return { success: false, reason: "BOT_ACTOR_FORBIDDEN" };
  }
  if (!action && !engine.gameOver && request.botColors.includes(engine.currentPlayer)) {
    let point;
    try {
      point = await chooseBotPoint(engine);
    } catch (error) {
      // Model availability must not strand a match. Use a canonical legal move
      // and explicitly return the degradation to the server.
      fallback = true;
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
