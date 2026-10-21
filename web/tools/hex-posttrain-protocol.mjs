import { readFile, open, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { canonical, sha256, seedFor } from "./three-player-arena-lib.mjs";
import { playersFor, rng } from "./hex-posttrain-core.mjs";

export const SOURCE_FILES = [
  "web/tools/run-hex-posttraining.mjs", "web/tools/hex-posttrain-core.mjs",
  "web/tools/hex-posttrain-protocol.mjs", "web/tools/linear-three-v3-core.mjs",
  "web/tools/three-player-arena-lib.mjs",
  "web/web前端/GameEngine.js", "web/web前端/AIEngine.js", "web/web前端/HexPlayerAI.js",
];
export async function rawAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`, handle = await open(temp, "w");
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  for (let i = 0; ; i++) {
    try { await rename(temp, path); return; }
    catch (error) {
      if (i >= 7 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
      await new Promise((done) => setTimeout(done, 10 * (i + 1)));
    }
  }
}
export function modelBody(model) { const { integrity, ...body } = model; return body; }
export function sealModel(body) {
  return { ...body, integrity: { algorithm: "SHA-256", payload_sha256: sha256(JSON.stringify(body)) } };
}
export async function readModel(path, expectedId) {
  const bytes = await readFile(path), model = JSON.parse(bytes);
  if (model.id !== expectedId || model.rules_version !== "territory-v2"
      || model.schema?.name !== "lifeline-hex-player-policy" || model.schema.version !== 1
      || model.weights?.length !== 16 || !model.weights.every(Number.isFinite)
      || model.integrity?.algorithm !== "SHA-256"
      || model.integrity.payload_sha256 !== sha256(JSON.stringify(modelBody(model)))) throw new Error("Invalid frozen model.");
  return { model, hash: sha256(bytes) };
}
export function validateProtocol(c) {
  if (c.schema !== "lifeline-hex-terminal-posttraining-v1" || !["TRAIN", "FINAL", "RECOVERY"].includes(c.mode)
      || c.rulesVersion !== "territory-v2" || c.modelId !== "hex-player-policy-v2"
      || !c.counts?.length || c.counts.some((p) => ![4, 5, 6].includes(p))
      || !c.sizes?.length || c.sizes.some((n) => ![5, 7].includes(n))
      || !Number.isInteger(c.maxActions) || c.maxActions < 1 || c.maxActions > 3000
      || !(c.maxGameSeconds > 0 && c.maxGameSeconds <= 90)
      || !Number.isInteger(c.prefixMoves) || c.prefixMoves < 0 || c.prefixMoves > 10 || !c.seedNamespace) throw new Error("Invalid hex protocol.");
  if (c.mode === "FINAL") {
    if (canonical(c.sizes) !== "[5,7]" || canonical(c.counts) !== "[4,5,6]" || c.prefixMoves !== 4
        || c.maxActions !== 3000 || c.maxGameSeconds !== 90
        || c.promotion?.minimumMeanDelta !== 0.04 || c.promotion.minimumGroupDelta !== -0.05
        || c.promotion.bootstrapReplicates !== 10000 || c.promotion.bootstrapSeed !== 2167653
        || !c.promotion.requirePositiveLower95 || !c.promotion.requireNonnegativeEachLineup
        || !c.promotion.requireAllTerminal) throw new Error("Changed FINAL gate requires new protocol version.");
  } else if (canonical(c.sizes) !== "[5]" || !Number.isInteger(c.stages) || c.stages < 1 || c.stages > 3
      || c.reward !== "terminal-shared-win-minus-one-over-player-count"
      || !c.developmentSeedNamespace || c.seedNamespace === c.developmentSeedNamespace
      || !(c.ppo?.clip > 0 && c.ppo.clip < 1) || !(c.ppo.temperature > 0) || !(c.ppo.anchorKl >= 0)
      || !Number.isInteger(c.optimizer?.updatesPerStage) || c.optimizer.updatesPerStage < 1
      || !(c.optimizer.learningRate > 0) || !(c.optimizer.maximumGradientNorm > 0)
      || !(c.optimizer.beta1 > 0 && c.optimizer.beta1 < 1) || !(c.optimizer.beta2 > 0 && c.optimizer.beta2 < 1)
      || !(c.optimizer.epsilon > 0)) throw new Error("Invalid TRAIN protocol.");
  return c;
}
export function trainingSpecs(c) {
  const result = [];
  for (let stage = 1; stage <= c.stages; stage++) for (const size of c.sizes) for (const players of c.counts) {
    for (const start of (c.fixtureStarts ?? playersFor(players))) {
      const id = `train-s${stage}-n${size}-p${players}-${start}`;
      result.push({ id, kind: "train", stage, size, players, start, seats: [start], seed: seedFor(`${c.seedNamespace}/${id}`) });
    }
  }
  return result;
}
export function arenaSpecs(c, development = false) {
  const result = [], stages = development ? Array.from({ length: c.stages }, (_, i) => i + 1) : [1];
  for (const size of c.sizes) for (const players of c.counts) for (const start of (c.fixtureStarts ?? playersFor(players))) {
    const cluster = `n${size}-p${players}-${start}`;
    const base = { kind: development ? "dev" : "final", cluster, size, players, start,
      seed: seedFor(`${development ? c.developmentSeedNamespace : c.seedNamespace}/${cluster}`) };
    result.push({ ...base, id: `${base.kind}-${cluster}-control`, stage: 0, lineup: "control", seats: [] });
    for (const stage of stages) for (const lineup of ["single", "multi"]) {
      const seats = lineup === "single" ? [start] : playersFor(players).filter((p) => p !== start);
      result.push({ ...base, id: `${base.kind}-${cluster}-s${stage}-${lineup}`, stage, lineup, seats });
    }
  }
  return result;
}
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
export function pairedRows(games, stage = 1) {
  const controls = new Map(games.filter((g) => g.lineup === "control").map((g) => [g.cluster, g]));
  return games.filter((g) => g.stage === stage && g.lineup !== "control").map((g) => {
    const baseline = controls.get(g.cluster);
    if (!g.terminal || !baseline?.terminal) return { ...g, delta: null };
    return { cluster: g.cluster, size: g.size, players: g.players, lineup: g.lineup,
      delta: mean(g.seats.map((seat) => g.outcome.shares[seat] - baseline.outcome.shares[seat])) };
  });
}
export function arenaSummary(games, c) {
  const rows = pairedRows(games), terminal = games.filter((g) => g.terminal).length;
  if (rows.some((r) => r.delta === null)) return { status: "COMPLETE", games: games.length,
    terminal, truncated: games.length - terminal, promote: false, reason: "TRUNCATED", meanDelta: null };
  const groups = (field, keys) => Object.fromEntries(keys.map((key) => [key, mean(rows.filter((r) => r[field] === key).map((r) => r.delta))]));
  const clusters = [...new Set(rows.map((r) => r.cluster))].map((cluster) => mean(rows.filter((r) => r.cluster === cluster).map((r) => r.delta)));
  const random = rng(c.promotion.bootstrapSeed), bootstrap = [];
  for (let i = 0; i < c.promotion.bootstrapReplicates; i++) {
    bootstrap.push(mean(clusters.map(() => clusters[Math.floor(random.next() * clusters.length)])));
  }
  bootstrap.sort((a, b) => a - b);
  const interval = [bootstrap[Math.floor(0.025 * bootstrap.length)], bootstrap[Math.floor(0.975 * bootstrap.length)]];
  const delta = mean(clusters), bySize = groups("size", c.sizes), byCount = groups("players", c.counts), byLineup = groups("lineup", ["single", "multi"]);
  const checks = { meanDelta: delta >= c.promotion.minimumMeanDelta, positiveLower95: interval[0] > 0,
    sizeNoRegression: Object.values(bySize).every((x) => x >= c.promotion.minimumGroupDelta),
    countNoRegression: Object.values(byCount).every((x) => x >= c.promotion.minimumGroupDelta),
    eachLineupNonnegative: Object.values(byLineup).every((x) => x >= 0),
    allTerminal: terminal === games.length };
  return { status: "COMPLETE", games: games.length, terminal, truncated: games.length - terminal,
    clusters: clusters.length, meanDelta: delta, bootstrap95: interval, bySize, byCount, byLineup, checks,
    promote: Object.values(checks).every(Boolean), statisticalUnit: "paired random-prefix cluster; single/multi share the control" };
}
