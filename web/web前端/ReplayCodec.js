import GameEngine from "./GameEngine.js?v=20261013-sync1";
import { Player } from "./GameEngine.js?v=20261013-sync1";

export const REPLAY_FORMAT = "lifeline-replay";
export const REPLAY_SCHEMA_VERSION = 1;
export const REPLAY_ENGINE_FAMILY = "web-game-engine";
const GENESIS_EVENT_HASH = "GENESIS";
const SUPPORTED_RULES = new Set(["territory-v1", "territory-v2"]);
const PLAYERS = [Player.BLACK, Player.WHITE, Player.PURPLE];

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Replay canonical JSON does not support non-finite numbers.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  throw new Error("Replay canonical JSON received an unsupported value.");
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(canonicalize(value));
  if (!globalThis.crypto?.subtle) {
    throw new Error("SHA-256 is unavailable in this browser.");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function clonePoint(point) {
  return Array.isArray(point) ? [point[0], point[1]] : null;
}

function comparePoints(a, b) {
  return a[1] - b[1] || a[0] - b[0];
}

function normalizeEdge(edge) {
  const [left, right] = String(edge).split("|");
  const leftPoint = left.split(",").map(Number);
  const rightPoint = right.split(",").map(Number);
  if (leftPoint.length !== 2 || rightPoint.length !== 2 || leftPoint.some((n) => !Number.isInteger(n)) || rightPoint.some((n) => !Number.isInteger(n))) {
    return String(edge);
  }
  const ordered = [leftPoint, rightPoint].sort(comparePoints);
  return `${ordered[0].join(",")}|${ordered[1].join(",")}`;
}

export function serializeRuleState(engine) {
  const gridEntries = [...engine.grid.entries()]
    .map(([key, state]) => ({ point: key.split(",").map(Number), state }))
    .filter(({ state }) => state !== 0)
    .sort((a, b) => comparePoints(a.point, b.point))
    .map(({ point, state }) => [...point, state]);
  const edges = Object.fromEntries(
    PLAYERS.map((player) => [
      player,
      [...(engine.edges?.[player] ?? [])].map(normalizeEdge).sort(),
    ]),
  );
  return {
    stateVersion: 1,
    gridSize: engine.gridSize,
    playerCount: engine.playerCount,
    startPlayer: engine.startPlayer,
    rulesVersion: engine.rulesVersion,
    gridEntries,
    edges,
    historyHashes: [...(engine.historyHashes ?? [])].sort(),
    currentPlayer: engine.currentPlayer,
    gameOver: Boolean(engine.gameOver),
    consecutiveSkips: engine.consecutiveSkips,
    resignedPlayers: [...(engine.resignedPlayers ?? [])].sort((a, b) => PLAYERS.indexOf(a) - PLAYERS.indexOf(b)),
    turnCount: engine.turnCount,
  };
}

async function hashRuleState(engine) {
  return sha256(serializeRuleState(engine));
}

function normalizeSettings(settings = {}) {
  const playerCount = Number(settings.playerCount ?? 2);
  const players = Array.isArray(settings.players)
    ? [...settings.players]
    : PLAYERS.slice(0, playerCount);
  return {
    playerCount,
    gridSize: Number(settings.gridSize ?? 9),
    players,
    startPlayer: settings.startPlayer ?? players[0],
    rulesVersion: settings.rulesVersion ?? "territory-v2",
    superko: "enforce",
    turnTimerEnabled: Boolean(settings.turnTimerEnabled),
    turnTimeLimitSeconds: Number(settings.turnTimeLimitSeconds ?? 60),
    hintEnabled: Boolean(settings.hintEnabled),
    hintMaxCount: Number(settings.hintMaxCount ?? 0),
  };
}

function engineOptionsFromSettings(settings) {
  return {
    gridSize: settings.gridSize,
    playerCount: settings.playerCount,
    startPlayer: settings.startPlayer,
    rulesVersion: settings.rulesVersion,
    deferTerritoryUpdates: false,
  };
}

function normalizeAction(action) {
  if (!isPlainObject(action)) return null;
  const type = action.type === "player_move" ? "move" : action.type === "player_skip" ? "skip" : action.type === "player_resign" ? "resign" : action.type;
  const player = action.player ?? action.color ?? action.actor;
  if (!["move", "skip", "resign"].includes(type)) return null;
  if (type === "resign" && !PLAYERS.includes(player)) return null;
  if (type === "move") {
    if (!Array.isArray(action.point) || action.point.length !== 2 || !action.point.every(Number.isInteger)) return null;
    return { type, player: player ?? null, point: clonePoint(action.point) };
  }
  return { type, player: player ?? null, point: null };
}

function applyAction(engine, action) {
  if (action.type === "move") return engine.playMove(action.point);
  if (action.type === "skip") return engine.skipTurn();
  return engine.resignPlayer(action.player);
}

function buildEventEffects(beforeState, beforeSnapshot, afterState, afterSnapshot) {
  const beforeGrid = new Map(beforeState.gridEntries.map(([x, y, state]) => [`${x},${y}`, state]));
  const afterGrid = new Map(afterState.gridEntries.map(([x, y, state]) => [`${x},${y}`, state]));
  const capturedPoints = [];
  for (const [key, state] of beforeGrid.entries()) {
    if (state !== 0 && !afterGrid.has(key)) {
      capturedPoints.push(key.split(",").map(Number));
    }
  }
  const addedEdgesByPlayer = {};
  for (const player of PLAYERS) {
    const beforeEdges = new Set(beforeState.edges[player] ?? []);
    addedEdgesByPlayer[player] = (afterState.edges[player] ?? []).filter((edge) => !beforeEdges.has(edge));
  }
  const territoryDelta = Object.fromEntries(
    PLAYERS.map((player) => [
      player,
      Number(afterSnapshot.territories?.[player]?.area ?? 0) - Number(beforeSnapshot.territories?.[player]?.area ?? 0),
    ]),
  );
  return {
    capturedPoints,
    addedEdgesByPlayer,
    territoryDelta,
    gameEnded: Boolean(afterSnapshot.gameOver && !beforeSnapshot.gameOver),
  };
}

function toControllerAction(action) {
  if (action.type === "move") return { type: "player_move", point: clonePoint(action.point) };
  if (action.type === "skip") return { type: "player_skip" };
  return { type: "player_resign", color: action.player };
}

function buildTerminalSummary(engine, finalStateHash, eventCount) {
  const snapshot = engine.getSnapshot();
  return snapshot.gameOver
    ? {
        status: "completed",
        reason: snapshot.resignedPlayers?.length ? "resignation" : "all_remaining_players_skipped",
        lastEventSeq: eventCount,
        winner: snapshot.winner ?? null,
        scores: cloneJson(snapshot.territories ?? {}),
        resignedPlayers: [...(snapshot.resignedPlayers ?? [])],
        finalStateHash,
        turnCount: engine.turnCount,
        verified: false,
      }
    : null;
}

export async function createReplayDocument(settings, actions = []) {
  const config = normalizeSettings(settings);
  if (!SUPPORTED_RULES.has(config.rulesVersion) || ![2, 3].includes(config.playerCount)) {
    throw new Error("当前规则或玩家配置不支持导出棋谱。");
  }
  const engine = new GameEngine(engineOptionsFromSettings(config));
  const initialRuleState = serializeRuleState(engine);
  const initialStateHash = await sha256(initialRuleState);
  const events = [];
  let previousEventHash = GENESIS_EVENT_HASH;

  for (let index = 0; index < actions.length; index += 1) {
    const action = normalizeAction(actions[index]);
    if (!action) throw new Error(`第 ${index + 1} 个动作格式无效。`);
    const actor = action.player ?? engine.currentPlayer;
    if (engine.currentPlayer !== actor && action.type !== "resign") {
      throw new Error(`第 ${index + 1} 个动作不是当前玩家的动作。`);
    }
    const preStateHash = await hashRuleState(engine);
    const preState = serializeRuleState(engine);
    const preSnapshot = engine.getSnapshot();
    const preTurnCount = engine.turnCount;
    const result = applyAction(engine, action);
    if (!result.success && !(action.type === "resign" && result.reason === "PLAYER_ALREADY_RESIGNED")) {
      throw new Error(`第 ${index + 1} 个动作无法回放：${result.reason ?? "UNKNOWN"}。`);
    }
    const postState = serializeRuleState(engine);
    const postSnapshot = engine.getSnapshot();
    const normalizedEvent = {
      seq: index + 1,
      type: action.type,
      actor,
      ...(action.type === "move" ? { point: clonePoint(action.point) } : {}),
      preStateHash,
      postStateHash: await hashRuleState(engine),
      preTurnCount,
      postTurnCount: engine.turnCount,
      prevEventHash: previousEventHash,
      effects: buildEventEffects(preState, preSnapshot, postState, postSnapshot),
    };
    const eventHash = await sha256(normalizedEvent);
    events.push({ ...normalizedEvent, eventHash });
    previousEventHash = eventHash;
  }

  const finalRuleState = serializeRuleState(engine);
  const finalStateHash = await sha256(finalRuleState);
  const terminal = buildTerminalSummary(engine, finalStateHash, events.length);
  const document = {
    format: REPLAY_FORMAT,
    schemaVersion: REPLAY_SCHEMA_VERSION,
    engineFamily: REPLAY_ENGINE_FAMILY,
    rulesVersion: config.rulesVersion,
    engineBuild: { id: "lifeline-web-runtime-v1", sourceHash: "unavailable" },
    config,
    initialState: { stateVersion: 1, ruleState: initialRuleState, stateHash: initialStateHash },
    actions: events,
    checkpoints: [],
    terminal,
    integrity: {
      eventCount: events.length,
      finalEventHash: previousEventHash === GENESIS_EVENT_HASH ? null : previousEventHash,
      finalStateHash,
      canonicalDocumentHash: null,
    },
    extensions: {},
  };
  document.integrity.canonicalDocumentHash = await sha256({ ...document, integrity: { ...document.integrity, canonicalDocumentHash: null } });
  return document;
}

export async function validateReplayDocument(document) {
  const fail = (reason, eventSeq = null) => ({ success: false, reason, eventSeq });
  if (!isPlainObject(document)) return fail("棋谱不是 JSON 对象。");
  if (document.format !== REPLAY_FORMAT || document.schemaVersion !== REPLAY_SCHEMA_VERSION) return fail("棋谱版本不受支持。");
  if (document.engineFamily !== REPLAY_ENGINE_FAMILY || !SUPPORTED_RULES.has(document.rulesVersion)) return fail("棋谱规则版本或引擎版本不兼容。");
  if (!isPlainObject(document.config) || !Array.isArray(document.actions) || !isPlainObject(document.initialState)) return fail("棋谱缺少必要字段。");
  const config = normalizeSettings(document.config);
  if (config.rulesVersion !== document.rulesVersion || ![2, 3].includes(config.playerCount)) return fail("棋谱配置无效。");
  const engine = new GameEngine(engineOptionsFromSettings(config));
  const initialHash = await hashRuleState(engine);
  if (document.initialState.stateHash !== initialHash
    || canonicalize(document.initialState.ruleState) !== canonicalize(serializeRuleState(engine))) return fail("初始局面校验失败。");
  let previousEventHash = GENESIS_EVENT_HASH;
  const actions = [];
  for (const event of document.actions) {
    const seq = event?.seq;
    if (!isPlainObject(event) || seq !== actions.length + 1 || event.prevEventHash !== previousEventHash) return fail("事件顺序或链式哈希校验失败。", seq ?? null);
    const action = normalizeAction(event);
    if (!action || event.actor !== action.player) return fail("事件动作格式无效。", seq);
    if (action.type !== "resign" && event.actor !== engine.currentPlayer) return fail("事件行动方与当前回合不一致。", seq);
    const expectedPre = await hashRuleState(engine);
    if (event.preStateHash !== expectedPre || event.preTurnCount !== engine.turnCount) return fail("动作前状态承诺不匹配。", seq);
    const preState = serializeRuleState(engine);
    const preSnapshot = engine.getSnapshot();
    const result = applyAction(engine, action);
    if (!result.success && !(action.type === "resign" && result.reason === "PLAYER_ALREADY_RESIGNED")) return fail(`第 ${seq} 步无法执行：${result.reason ?? "UNKNOWN"}。`, seq);
    const expectedPost = await hashRuleState(engine);
    if (event.postStateHash !== expectedPost || event.postTurnCount !== engine.turnCount) return fail("动作后状态承诺不匹配。", seq);
    const effects = buildEventEffects(preState, preSnapshot, serializeRuleState(engine), engine.getSnapshot());
    if (canonicalize(event.effects) !== canonicalize(effects)) return fail("事件效果与规则重放不一致。", seq);
    const eventWithoutHash = { ...event };
    delete eventWithoutHash.eventHash;
    const expectedEventHash = await sha256(eventWithoutHash);
    if (event.eventHash !== expectedEventHash) return fail("事件哈希校验失败。", seq);
    previousEventHash = event.eventHash;
    actions.push(toControllerAction(action));
  }
  const finalStateHash = await hashRuleState(engine);
  if (document.integrity?.eventCount !== actions.length || document.integrity?.finalStateHash !== finalStateHash) return fail("棋谱终局完整性校验失败。", actions.length);
  if (document.integrity?.finalEventHash !== (actions.length ? previousEventHash : null)) return fail("棋谱最终事件哈希不匹配。", actions.length);
  if (canonicalize(document.terminal) !== canonicalize(buildTerminalSummary(engine, finalStateHash, actions.length))) return fail("棋谱终局摘要与回放结果不一致。", actions.length);
  if (document.integrity?.canonicalDocumentHash) {
    const expectedDocumentHash = await sha256({
      ...document,
      integrity: { ...document.integrity, canonicalDocumentHash: null },
    });
    if (document.integrity.canonicalDocumentHash !== expectedDocumentHash) return fail("棋谱文档哈希校验失败。", actions.length);
  }
  return {
    success: true,
    reason: null,
    settings: config,
    actions,
    document: cloneJson(document),
    finalStateHash,
    eventCount: actions.length,
    terminal: document.terminal ?? null,
  };
}

export async function parseAndValidateReplay(text) {
  let document;
  try {
    document = JSON.parse(String(text));
  } catch {
    return { success: false, reason: "棋谱文件不是有效 JSON。", eventSeq: null };
  }
  return validateReplayDocument(document);
}

export function downloadReplayDocument(replayDocument, filename = "lifeline-replay.json") {
  const blob = new Blob([JSON.stringify(replayDocument, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = globalThis.document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
}
