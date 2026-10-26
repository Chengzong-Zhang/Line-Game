// Bounded runtime comparison only: no training, self-play campaign or promotion.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, rename, readdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

const here = fileURLToPath(import.meta.url);
export const DEFAULT_MINIMAX_SOURCE = resolve(dirname(here), "../web前端");
const sha = value => createHash("sha256").update(value).digest("hex");
const canonical = value => JSON.stringify(value, (_key, item) => item instanceof Map
  ? { map: [...item] } : item instanceof Set ? { set: [...item] } : item);
const AUTO = [[0, 4], [1, 3], [0, 3], [1, 2], [1, 0]];
const SETTLE = [[1, 0], [3, 1], [1, 2], [2, 0], [1, 3], [1, 1], [0, 2], [0, 4], [2, 2]];
const CHAIN = [[2, 0], [3, 1], [0, 1], [0, 4]];
const MIDGAME = [[1, 0], [2, 0], [1, 5], [2, 4], [1, 7], [5, 0], [1, 4], [5, 2], [4, 4], [5, 3],
  [4, 0], [4, 2], [0, 8], [6, 0], [3, 3], [2, 2], [0, 2], [3, 4], [1, 2], [1, 6]];

export const MINIMAX_DIFFERENTIAL_CASES = Object.freeze([
  { id: "opening-v3-d1-n1", depth: 1, topN: 1 },
  { id: "opening-v2-d2-n3", rulesVersion: "territory-v2", depth: 2, topN: 3 },
  { id: "opening-v3-d3-n5", depth: 3, topN: 5 },
  { id: "opening-v2-d4-n1", rulesVersion: "territory-v2", depth: 4, topN: 1 },
  { id: "three-v3-d2-n3", playerCount: 3, depth: 2, topN: 3 },
  { id: "three-v2-d3-n5", playerCount: 3, rulesVersion: "territory-v2", depth: 3, topN: 5 },
  { id: "three-v3-d4-n1", playerCount: 3, depth: 4, topN: 1 },
  { id: "autoskip-v2-d3-n20", rulesVersion: "territory-v2", prefix: AUTO, depth: 3, topN: 20 },
  { id: "autoskip-v3-d4-n1", prefix: AUTO, depth: 4, topN: 1 },
  { id: "settle-v2-d2-n5", rulesVersion: "territory-v2", prefix: SETTLE, pass: true, depth: 2, topN: 5 },
  { id: "settle-v3-d3-n3", prefix: SETTLE, pass: true, depth: 3, topN: 3 },
  { id: "chain-v3-d2-n5", prefix: CHAIN, depth: 2, topN: 5 },
  { id: "chain-v2-d3-n3", rulesVersion: "territory-v2", prefix: CHAIN, depth: 3, topN: 3 },
  { id: "history-v3-d3-n5", prefix: CHAIN, history: "block-one", depth: 3, topN: 5 },
  { id: "forced-pass-v3-d2-n1", prefix: CHAIN, history: "block-all", depth: 2, topN: 1 },
  { id: "ties-v3-d2-n1", gridSize: 7, flat: true, depth: 2, topN: 1 },
  { id: "ties-v2-d3-n5", rulesVersion: "territory-v2", flat: true, depth: 3, topN: 5 },
  { id: "ties-v3-d2-n20", gridSize: 7, flat: true, depth: 2, topN: 20 },
  { id: "opening-v3-d2-n0", depth: 2, topN: 0 },
  { id: "negative-risk-v3-d3-n1", prefix: CHAIN, constantScore: -13, depth: 3, topN: 1 },
]);
export const MINIMAX_BENCHMARK_CASES = Object.freeze([...MINIMAX_DIFFERENTIAL_CASES,
  { id: "native7-v3-d4-n5", gridSize: 7, depth: 4, topN: 5 },
  { id: "native9-v3-mid-d2-n5", gridSize: 9, prefix: MIDGAME, depth: 2, topN: 5 },
  { id: "native15-v3-mid-d2-n5", gridSize: 15, prefix: MIDGAME, depth: 2, topN: 5 },
  { id: "native5-v3-deepening-witness", gridSize: 5,
    prefix: [[0, 2], [1, 3], [0, 3], [3, 1]], depth: 4, topN: 5 },
]);

export async function loadMinimaxSource(sourceDir = DEFAULT_MINIMAX_SOURCE) {
  const directory = resolve(sourceDir);
  const hashes = Object.fromEntries(await Promise.all(["GameEngine.js", "AIEngine.js"].map(async name =>
    [resolve(directory, name), sha(await readFile(resolve(directory, name)))])));
  const engine = await import(pathToFileURL(resolve(directory, "GameEngine.js")).href);
  const ai = await import(pathToFileURL(resolve(directory, "AIEngine.js")).href);
  return { ...engine, ...ai, directory, hashes };
}

export function minimaxFixture(module, spec) {
  const engine = new module.GameEngine({ gridSize: spec.gridSize ?? 5,
    playerCount: spec.playerCount ?? 2, rulesVersion: spec.rulesVersion ?? "territory-v3",
    deferTerritoryUpdates: true });
  engine._isReplayingBatch = true;
  for (const point of spec.prefix ?? []) assert.equal(engine.playMove(point).success, true, `${spec.id}: prefix`);
  if (spec.pass) assert.equal(engine.skipTurn().success, true, `${spec.id}: PASS setup`);
  if (spec.history) {
    const legal = engine.getLegalMoves();
    const blocked = spec.history === "block-all" ? legal : legal.slice(0, 1);
    for (const { point } of blocked) {
      const trial = new module.GameEngine({ gridSize: engine.gridSize, playerCount: engine.playerCount,
        rulesVersion: engine.rulesVersion, deferTerritoryUpdates: true });
      trial._restoreReplayState(engine._captureReplayState()); trial._isReplayingBatch = true;
      const previous = new Set(engine.historyHashes);
      assert.equal(trial.playMove(point).success, true, `${spec.id}: history probe`);
      for (const hash of trial.historyHashes) if (!previous.has(hash)) engine.historyHashes.add(hash);
    }
    if (spec.history === "block-all") assert.equal(engine.getLegalMoves().length, 0);
  }
  engine._isReplayingBatch = false;
  return engine;
}

export function captureMinimaxState(module, engine) {
  // Query the public snapshot first so both captures contain a refreshed cache.
  const publicSnapshot = engine.getSnapshot();
  return { publicSnapshot, ruleState: module.saveState(engine), replayState: engine._captureReplayState(),
    replayFlag: engine._isReplayingBatch, initialPositions: structuredClone(engine.initialPositions),
    activePlayers: [...engine.activePlayers], rulesVersion: engine.rulesVersion,
    playMove: engine.playMove, autoSkip: engine._checkAndAutoSkip };
}

function instrument(engine, ai) {
  const counters = {}, originals = [];
  for (const [target, names] of [[engine, ["getLegalMoves", "_evaluateMove", "_computeStateHash", "playMove", "skipTurn"]],
    [ai, ["minimax", "evaluate"]]]) {
    for (const name of names) {
      const original = target[name]; originals.push([target, name, original]); counters[name] = 0;
      target[name] = function (...args) { counters[name]++; return original.apply(this, args); };
    }
  }
  return { counters, restore: () => { for (const [target, name, original] of originals) target[name] = original; } };
}

export function runMinimaxSample(module, spec, rootPruning, options = {}) {
  const engine = minimaxFixture(module, spec), before = captureMinimaxState(module, engine);
  const ai = new module.MinimaxAI(spec.depth, { rootPruning, moveOrdering: rootPruning, ...options });
  if (spec.flat) ai.evaluate = () => 0;
  if (Number.isFinite(spec.constantScore)) ai.evaluate = () => spec.constantScore;
  const instrumentation = instrument(engine, ai), start = performance.now();
  let moves;
  try { moves = ai.getTopMoves(engine, engine.currentPlayer, spec.topN); }
  finally { instrumentation.restore(); }
  const elapsedMs = performance.now() - start;
  assert.deepEqual(captureMinimaxState(module, engine), before, `${spec.id}: search changed full source state`);
  const legal = new Set(engine.getLegalMoves().map(move => move.point.join(",")));
  for (const move of moves) assert.ok(move.point === null || legal.has(move.point.join(",")), `${spec.id}: illegal result`);
  return { moves, elapsedMs, counters: instrumentation.counters, search: ai.lastSearch ?? null,
    fullStateSha256: sha(canonical(before)), sourceStatePreserved: true };
}

export async function runMinimaxDifferentialCase(spec, { candidate, baseline = null, productHard = false } = {}) {
  const module = candidate ?? await loadMinimaxSource();
  // Alternate order between cases to avoid attributing every first-run cost to one side.
  const pruningFirst = (spec.id.length & 1) === 0;
  const pruned = pruningFirst ? runMinimaxSample(module, spec, true) : null;
  const full = runMinimaxSample(module, spec, false);
  const optimized = pruned ?? runMinimaxSample(module, spec, true);
  assert.deepEqual(optimized.moves, full.moves, `${spec.id}: exact rank/score/stable-tie mismatch`);
  assert.equal(optimized.fullStateSha256, full.fullStateSha256, `${spec.id}: source fixtures differ`);
  const original = baseline ? runMinimaxSample(baseline, spec, false) : null;
  if (original) assert.deepEqual(optimized.moves, original.moves, `${spec.id}: delivered baseline differs`);
  const hard = productHard && spec.depth >= 4
    ? runMinimaxSample(module, spec, true, { iterativeDeepening: true }) : null;
  return { id: spec.id, spec, status: "PASS_EXACT_RANKING_AND_FULL_STATE", optimized, fullWindow: full,
    deliveredBaseline: original, productHard: hard,
    sourceHashes: { ...module.hashes, ...(baseline?.hashes ?? {}) },
    evaluationKind: "bounded-runtime-differential-not-training-or-strength" };
}

export function verifyMinimaxExceptionRestore(module, rootPruning) {
  const spec = { id: `exception-${rootPruning}`, depth: 3, topN: 5 };
  const engine = minimaxFixture(module, spec), before = captureMinimaxState(module, engine);
  const ai = new module.MinimaxAI(3, { rootPruning, moveOrdering: rootPruning }), original = ai.minimax; let calls = 0;
  ai.minimax = function (...args) { if (++calls === 2) throw Error("MINIMAX_PRUNING_INJECTED_FAILURE"); return original.apply(this, args); };
  assert.throws(() => ai.getTopMoves(engine, engine.currentPlayer, 5), /MINIMAX_PRUNING_INJECTED_FAILURE/);
  assert.deepEqual(captureMinimaxState(module, engine), before, "Exception leaked complete rule/replay/public state");
  return { rootPruning, reachedMutation: calls >= 2, sourceStatePreserved: true };
}

const BENCHMARK_IDS = ["native7-v3-d4-n5", "native9-v3-mid-d2-n5", "native15-v3-mid-d2-n5",
  "three-v3-d4-n1", "autoskip-v3-d4-n1", "chain-v3-d2-n5", "native5-v3-deepening-witness"];
async function atomic(path, value) {
  const temp = `${path}.pending`; await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx" }); await rename(temp, path);
}
function childCase(spec, baselineDir, timeoutMs, productHard) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [here, "--case-worker", spec.id,
      ...(productHard ? ["--product-hard"] : []), ...(baselineDir ? ["--baseline-source", baselineDir] : [])],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return accept({ id: spec.id, status: "INCOMPLETE_CASE_TIMEOUT", timeoutMs, code, signal });
      if (code !== 0) return reject(Error(`${spec.id}: worker exit ${code}/${signal}: ${stderr.slice(0, 1500)}`));
      try { accept(JSON.parse(stdout)); } catch (error) { reject(Error(`${spec.id}: invalid worker result: ${error.message}`)); }
    });
  });
}

async function cli() {
  const started = performance.now();
  const args = process.argv.slice(2), option = (name, fallback = null) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const baselineDir = option("--baseline-source"), candidate = await loadMinimaxSource();
  if (option("--case-worker")) {
    const spec = MINIMAX_BENCHMARK_CASES.find(row => row.id === option("--case-worker")); assert.ok(spec, "Unknown case");
    const baseline = baselineDir ? await loadMinimaxSource(baselineDir) : null;
    console.log(JSON.stringify(await runMinimaxDifferentialCase(spec,
      { candidate, baseline, productHard: args.includes("--product-hard") }))); return;
  }
  assert.ok(option("--output"), "Use --output NEW_DIRECTORY [--resume] [--baseline-source FRONTEND] [--cases id,id] [--max-wall-ms 25000]");
  const output = resolve(option("--output")), maxWallMs = Number(option("--max-wall-ms", 25000)), caseTimeout = Number(option("--case-timeout-ms", 6000));
  assert.ok(Number.isFinite(maxWallMs) && maxWallMs > 0 && maxWallMs <= 30000 && Number.isFinite(caseTimeout) && caseTimeout > 0);
  const ids = option("--cases")?.split(",") ?? BENCHMARK_IDS;
  assert.equal(new Set(ids).size, ids.length, "Duplicate case id");
  const specs = ids.map(id => { const spec = MINIMAX_BENCHMARK_CASES.find(row => row.id === id); assert.ok(spec, `Unknown case ${id}`); return spec; });
  const baseline = baselineDir ? await loadMinimaxSource(baselineDir) : null;
  const protocol = { schema: "lifeline-minimax-runtime-benchmark-v1", cases: specs,
    sourceHashes: { ...candidate.hashes, ...(baseline?.hashes ?? {}), [here]: sha(await readFile(here)) },
    maxWallMs, caseTimeoutMs: caseTimeout, productHard: args.includes("--product-hard"),
    baselineSource: baselineDir ? resolve(baselineDir) : null,
    scope: "Fixed finite snapshots, exact rankings/scores/full-state checks. Descriptive Node timing only; no browser/phone/win-rate claim." };
  const identity = sha(JSON.stringify(protocol));
  if (args.includes("--resume")) {
    const old = JSON.parse(await readFile(resolve(output, "protocol.json")));
    assert.equal(old.identity, identity, "Source/protocol changed; use a new output directory");
  } else { await mkdir(output, { recursive: false }); await atomic(resolve(output, "protocol.json"), { ...protocol, identity }); }
  await mkdir(resolve(output, "cases"), { recursive: true });
  const completed = [], incomplete = [];
  const entries = new Set(await readdir(resolve(output, "cases")));
  for (const spec of specs) {
    const path = resolve(output, "cases", `${spec.id}.json`);
    if (entries.has(`${spec.id}.json`)) {
      const row = JSON.parse(await readFile(path)); assert.equal(row.identity, identity); assert.equal(row.result.id, spec.id);
      assert.equal(sha(JSON.stringify(row.result)), row.resultSha256); completed.push(row.result); continue;
    }
    const remaining = maxWallMs - (performance.now() - started); if (remaining < 100) { incomplete.push(spec.id); break; }
    const result = await childCase(spec, baselineDir, Math.min(caseTimeout, remaining), protocol.productHard);
    if (result.status !== "PASS_EXACT_RANKING_AND_FULL_STATE") { incomplete.push(spec.id); await atomic(resolve(output, `incomplete-${spec.id}-${Date.now()}.json`), result); break; }
    assert.deepEqual(result.sourceHashes, { ...candidate.hashes, ...(baseline?.hashes ?? {}) }, "Source changed between parent and case worker");
    for (const [path, hash] of Object.entries(protocol.sourceHashes)) assert.equal(sha(await readFile(path)), hash, "Source changed during bounded benchmark");
    await atomic(path, { identity, resultSha256: sha(JSON.stringify(result)), result }); completed.push(result);
  }
  const completedIds = new Set(completed.map(row => row.id));
  const pending = specs.filter(row => !completedIds.has(row.id)).map(row => row.id);
  const report = { schema: protocol.schema, identity, status: pending.length ? "INCOMPLETE_NOT_PASSED" : "PASS_BOUNDED_EXACT_RUNTIME_COMPARISON",
    completedCases: completed.length, requiredCases: specs.length, pending, thisInvocationMs: performance.now() - started,
    caseReceipts: completed.map(row => ({ id: row.id, optimizedMs: row.optimized.elapsedMs, fullWindowMs: row.fullWindow.elapsedMs,
      deliveredBaselineMs: row.deliveredBaseline?.elapsedMs ?? null, optimizedSearch: row.optimized.search,
      productHardMs: row.productHard?.elapsedMs ?? null, productHardSearch: row.productHard?.search ?? null,
      fullWindowSearch: row.fullWindow.search, identicalMoves: true, fullStatePreserved: true })), protocol };
  // Append a new aggregate receipt on resume; successful case units are never rewritten.
  const reportPath = resolve(output, `report-${Date.now()}.json`); await atomic(reportPath, report);
  console.log(JSON.stringify({ status: report.status, completed: completed.length, required: specs.length, pending, reportPath }));
  if (pending.length) process.exitCode = 75;
}
if (process.argv[1] && resolve(process.argv[1]) === here) cli().catch(error => { console.error(error.stack); process.exitCode = 1; });
