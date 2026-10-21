import { createHash } from "node:crypto";
import { readFile, open, rename, mkdir, access } from "node:fs/promises";
import { resolve, dirname } from "node:path";

export const PLAYERS = ["BLACK", "WHITE", "PURPLE"];
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
export const canonical = (value) => JSON.stringify(value, (_, item) => (
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item
));
export function checked(value) {
  const { integrity: _, ...body } = value;
  return { ...body, integrity: sha256(canonical(body)) };
}
export function validateChecked(value, label = "record") {
  if (!value || value.integrity !== checked(value).integrity) throw new Error(`CORRUPT ${label}`);
  return value;
}
export async function atomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  const file = await open(temporary, "w");
  try {
    await file.writeFile(`${JSON.stringify(checked(value), null, 2)}\n`);
    await file.sync();
  } finally { await file.close(); }
  for (let attempt = 0; ; attempt += 1) {
    try { await rename(temporary, path); break; }
    catch (error) {
      if (attempt >= 7 || !["EPERM", "EBUSY", "EACCES"].includes(error.code)) throw error;
      await new Promise((accept) => setTimeout(accept, 10 * (attempt + 1)));
    }
  }
}
export async function exists(path) {
  try { await access(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
export async function readChecked(path) {
  return validateChecked(JSON.parse(await readFile(path, "utf8")), path);
}
export function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}
export function seedFor(text) { return Number.parseInt(sha256(text).slice(0, 8), 16); }
export function validateConfig(config) {
  if (config.schema !== "lifeline-three-player-arena" || config.version !== 1
    || !["CALIBRATION", "FINAL", "RECOVERY_TEST"].includes(config.stage)
    || !Array.isArray(config.sizes) || !config.sizes.length || config.sizes.some((size) => ![5, 7, 9].includes(size))
    || new Set(config.sizes).size !== config.sizes.length
    || !Array.isArray(config.starters) || !config.starters.length || config.starters.some((p) => !PLAYERS.includes(p))
    || !Number.isInteger(config.prefixesPerCell) || config.prefixesPerCell < 1 || config.prefixesPerCell > 10
    || !Number.isInteger(config.prefixMoves) || config.prefixMoves < 0 || config.prefixMoves > 12
    || !Number.isInteger(config.maxActions) || config.maxActions < 1 || config.maxActions > 1000
    || !Number.isFinite(config.maxGameSeconds) || config.maxGameSeconds <= 0
    || !Number.isFinite(config.totalBudgetSeconds) || config.totalBudgetSeconds <= 0
    || !["control", "paired"].includes(config.lineups)
    || typeof config.seedNamespace !== "string" || !config.seedNamespace) throw new Error("INVALID arena config");
  if (config.stage === "FINAL" && (
    canonical(config.sizes) !== "[5,7,9]" || canonical(config.starters) !== canonical(PLAYERS)
    || config.prefixesPerCell !== 2 || config.lineups !== "paired"
    || config.promotion?.minimumMeanDelta !== 0.04 || config.promotion?.minimumSizeDelta !== -0.05
    || config.promotion?.bootstrapReplicates !== 10000
  )) throw new Error("INVALID preregistered FINAL design");
  return config;
}
export function buildUnits(config) {
  const units = [];
  for (const size of config.sizes) for (const startPlayer of config.starters) {
    for (let repetition = 0; repetition < config.prefixesPerCell; repetition += 1) {
      const cluster = `n${size}-${startPlayer.toLowerCase()}-p${repetition}`;
      const seed = seedFor(`${config.seedNamespace}/${cluster}`);
      const base = { cluster, size, startPlayer, repetition, seed };
      units.push({ ...base, id: `${cluster}-control`, lineup: "control", candidateSeats: [] });
      if (config.lineups === "paired") for (const seat of PLAYERS) {
        units.push({ ...base, id: `${cluster}-single-${seat.toLowerCase()}`, lineup: "single", focalSeat: seat, candidateSeats: [seat] });
        units.push({ ...base, id: `${cluster}-double-${seat.toLowerCase()}`, lineup: "double", focalSeat: seat, candidateSeats: PLAYERS.filter((p) => p !== seat) });
      }
    }
  }
  return units;
}
export async function loadRuntime(sourceDirectory) {
  const asModule = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  const engineUrl = asModule(await readFile(resolve(sourceDirectory, "GameEngine.js"), "utf8"));
  const aiUrl = asModule((await readFile(resolve(sourceDirectory, "AIEngine.js"), "utf8"))
    .replace(/(["'])\.\/GameEngine\.js(?:\?[^"']*)?\1/g, JSON.stringify(engineUrl)));
  const policyUrl = asModule((await readFile(resolve(sourceDirectory, "ThreePlayerAI.js"), "utf8"))
    .replace(/(["'])\.\/AIEngine\.js(?:\?[^"']*)?\1/g, JSON.stringify(aiUrl))
    .replaceAll("import.meta.url", JSON.stringify("file:///frozen-three-player-ai/ThreePlayerAI.js")));
  return { ...(await import(engineUrl)), ...(await import(policyUrl)) };
}
export function policyModel(payload, features) {
  if (!Array.isArray(payload.features) || canonical(payload.features) !== canonical(features)
    || !Array.isArray(payload.weights) || payload.weights.length !== 16
    || !payload.weights.every((x) => Number.isFinite(x) && Math.abs(x) < 10000)
    || !Number.isFinite(payload.temperature) || payload.temperature <= 0
    || payload.rules_version !== "territory-v2") throw new Error("INVALID candidate weights/features/rules");
  // Identical feature extraction, legal set, score arithmetic and tie-breaking
  // are delegated to the existing production ThreePlayerAI implementation.
  return { score: (values) => values.reduce((sum, x, i) => sum + x * payload.weights[i], 0) / payload.temperature };
}
export function newEngine(runtime, unit) {
  const engine = new runtime.GameEngine({
    gridSize: unit.size, playerCount: 3, boardShape: "triangle",
    rulesVersion: "territory-v2", startPlayer: unit.startPlayer,
  });
  engine._isReplayingBatch = true;
  return engine;
}
export function applyAction(engine, action) {
  if (action.actor !== engine.currentPlayer || engine.gameOver) throw new Error("INVALID action actor/terminal");
  const result = action.type === "move" ? engine.playMove(action.point)
    : action.type === "skip" ? engine.skipTurn() : { success: false };
  if (!result.success) throw new Error(`INVALID action: ${result.reason ?? action.type}`);
}
export function createPrefix(runtime, unit, config) {
  const engine = newEngine(runtime, unit), random = randomGenerator(unit.seed), actions = [];
  for (let index = 0; index < config.prefixMoves && !engine.gameOver; index += 1) {
    const legal = engine.getLegalMoves();
    const point = legal.length ? legal[Math.floor(random() * legal.length)].point : null;
    const action = { actor: engine.currentPlayer, type: point ? "move" : "skip", ...(point ? { point: [...point] } : {}) };
    applyAction(engine, action); actions.push(action);
  }
  return actions;
}
export function terminalMetrics(engine) {
  if (!engine.gameOver) return null;
  engine._isReplayingBatch = false;
  engine.getWinner(); // Force the current terminal discrete-area cache.
  const board = engine.getScoreboard();
  const areas = Object.fromEntries(PLAYERS.map((p) => [p, board[p].area]));
  const maximum = Math.max(...Object.values(areas));
  const winners = PLAYERS.filter((p) => areas[p] === maximum);
  return {
    areas,
    sharedWin: Object.fromEntries(PLAYERS.map((p) => [p, winners.includes(p) ? 1 / winners.length : 0])),
    pairwise: Object.fromEntries(PLAYERS.map((p) => [p,
      PLAYERS.filter((q) => q !== p).reduce((sum, q) => sum + (areas[p] > areas[q] ? 1 : areas[p] === areas[q] ? 0.5 : 0), 0) / 2,
    ])),
    winners,
  };
}
const mean = (values) => values.reduce((sum, x) => sum + x, 0) / (values.length || 1);
export function summarize(records, config) {
  records = [...records].sort((a, b) => a.unit.id.localeCompare(b.unit.id, "en"));
  const controls = new Map(records.filter((r) => r.unit.lineup === "control").map((r) => [r.unit.cluster, r]));
  const mixed = records.filter((r) => r.unit.lineup !== "control" && r.terminal && controls.get(r.unit.cluster)?.terminal);
  const rows = mixed.map((record) => {
    const control = controls.get(record.unit.cluster);
    const seats = record.unit.candidateSeats;
    return {
      cluster: record.unit.cluster, size: record.unit.size, lineup: record.unit.lineup,
      focalSeat: record.unit.focalSeat, startPlayer: record.unit.startPlayer,
      sharedWin: mean(seats.map((p) => record.metrics.sharedWin[p])),
      delta: mean(seats.map((p) => record.metrics.sharedWin[p] - control.metrics.sharedWin[p])),
      pairwiseDelta: mean(seats.map((p) => record.metrics.pairwise[p] - control.metrics.pairwise[p])),
    };
  });
  const clusterNames = [...new Set(rows.map((r) => r.cluster))];
  const clusters = clusterNames.map((cluster) => {
    const group = rows.filter((r) => r.cluster === cluster);
    return { cluster, size: group[0].size, meanDelta: mean(group.map((r) => r.delta)), games: group.length };
  });
  const delta = mean(clusters.map((c) => c.meanDelta));
  const intervals = [];
  const random = randomGenerator(seedFor(`${config.seedNamespace}/cluster-bootstrap`));
  for (let b = 0; b < (config.promotion?.bootstrapReplicates ?? 1000) && clusters.length; b += 1) {
    // Stratified cluster bootstrap preserves the three-size balance and keeps
    // all seat/lineup results from each random prefix together.
    const sampled = [];
    for (const size of config.sizes) {
      const group = clusters.filter((c) => c.size === size);
      for (let i = 0; i < group.length; i += 1) sampled.push(group[Math.floor(random() * group.length)].meanDelta);
    }
    intervals.push(mean(sampled));
  }
  intervals.sort((a, b) => a - b);
  const ci = intervals.length ? [intervals[Math.floor(intervals.length * 0.025)], intervals[Math.min(intervals.length - 1, Math.floor(intervals.length * 0.975))]] : null;
  const grouping = (field) => Object.fromEntries([...new Set(rows.map((r) => String(r[field])))].map((key) => {
    const group = rows.filter((r) => String(r[field]) === key);
    return [key, { games: group.length, meanDelta: mean(group.map((r) => r.delta)), sharedWin: mean(group.map((r) => r.sharedWin)), pairwiseDelta: mean(group.map((r) => r.pairwiseDelta)) }];
  }));
  const bySize = grouping("size"), byLineup = grouping("lineup");
  const planned = buildUnits(config).length;
  const complete = records.length === planned && records.every((r) => r.terminal);
  const promotion = config.stage === "FINAL" && complete && clusters.length === 18
    && clusters.every((c) => c.games === 6)
    && delta >= config.promotion.minimumMeanDelta && ci?.[0] > 0
    && Object.values(bySize).every((r) => r.meanDelta >= config.promotion.minimumSizeDelta)
    && Object.values(byLineup).every((r) => r.meanDelta >= 0);
  return {
    evidenceTier: "application-evaluation; bounded to frozen models, seeds and sizes",
    stage: config.stage, plannedGames: planned, completedGames: records.length,
    terminalGames: records.filter((r) => r.terminal).length,
    truncatedGames: records.filter((r) => !r.terminal).length,
    clusters: clusters.length, clusterResults: clusters, meanDelta: delta, clusterBootstrap95: ci,
    bySize, byLineup, byFocalSeat: grouping("focalSeat"), byStartPlayer: grouping("startPlayer"),
    promotionPass: Boolean(promotion), complete,
  };
}
