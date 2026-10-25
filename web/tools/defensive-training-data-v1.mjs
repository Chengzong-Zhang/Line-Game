// Versioned, incremental offline label compiler. Input is a frozen array of
// {id, split: train|validation, state: serializeEngineState(engine)} records.
import { readFile, mkdir, rename, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GameEngine } from "../web前端/GameEngine.js";
import { deserializeEngineEdges } from "../web前端/AIStateProtocol.js";
import { fastPolicyCandidates } from "../web前端/MultiplayerSearch.js";
import { DEFENSIVE_TRAINING_CONTRACT, defensiveTrainingLabel, assertCompletedTrainingLabel } from "../web前端/DefensiveTrainingTeacher.js";
import { atomic, lease, readJson, root, sealed, sha, unseal } from "./neural-posttraining-data-v2.mjs";

const SOURCES = ["web/tools/defensive-training-data-v1.mjs", "web/web前端/DefensiveTrainingTeacher.js",
  "web/web前端/GameEngine.js", "web/web前端/AIEngine.js", "web/web前端/AIStateProtocol.js",
  "web/web前端/MultiplayerSearch.js", "web/web前端/MultiplayerNativeGeometry.js",
  "web/web前端/MultiplayerHardValue.js", "web/tools/neural-posttraining-data-v2.mjs"];
const check = (condition, message) => { if (!condition) throw new Error(message); };
const key = point => point === null ? "PASS" : point.join(",");
export function engineFromTrainingState(state) {
  check(state && Array.isArray(state.gridEntries) && Array.isArray(state.historyHashes)
    && state.historyHashes.length > 0 && Array.isArray(state.activePlayers)
    && Array.isArray(state.resignedPlayers) && state.edges && typeof state.edges === "object",
  "Training source must contain full grid, logical edges, actors and Superko history");
  const engine = new GameEngine({ ...state, deferTerritoryUpdates: true });
  const pointStates = new Set([0, ...engine.activePlayers.flatMap(player => Object.values(engine._getPlayerStates(player)))]);
  check(JSON.stringify(engine.activePlayers) === JSON.stringify(state.activePlayers)
    && engine.activePlayers.includes(state.currentPlayer)
    && state.activePlayers.every(player => Array.isArray(state.edges[player]))
    && state.gridEntries.length === engine.validPositions.length
    && new Set(state.gridEntries.map(([point]) => point)).size === engine.validPositions.length
    && state.gridEntries.every(([point, value]) => engine._keyToIdx.has(point) && pointStates.has(value))
    && Number.isInteger(state.consecutiveSkips) && state.consecutiveSkips >= 0
    && Number.isInteger(state.turnCount) && state.turnCount >= 0
    && Number.isInteger(state.positionRevision) && state.positionRevision >= 0
    && typeof state.gameOver === "boolean"
    && state.historyHashes.every(hash => typeof hash === "string" && hash.length > 0)
    && state.resignedPlayers.every(player => state.activePlayers.includes(player)), "Invalid complete training state");
  engine.grid = new Map(state.gridEntries);
  engine.edges = deserializeEngineEdges(state, engine.activePlayers);
  engine.historyHashes = new Set(state.historyHashes);
  engine.currentPlayer = state.currentPlayer;
  engine.resignedPlayers = new Set(state.resignedPlayers);
  engine.consecutiveSkips = state.consecutiveSkips;
  engine.gameOver = state.gameOver;
  engine.turnCount = state.turnCount;
  engine.positionRevision = state.positionRevision;
  engine._territoryStateRevision = state.positionRevision;
  engine._territoryCacheRevision = -1;
  engine._isReplayingBatch = true;
  return engine;
}
export function assertSourceBoundDefensiveSample(value) {
  assertCompletedTrainingLabel(value.label);
  check(value.sourceStateHash === sha(JSON.stringify(value.sourceState)), "Defensive label source state hash mismatch");
  const engine = engineFromTrainingState(value.sourceState);
  check(!engine.gameOver && value.label.actor === engine.currentPlayer && value.label.rulesVersion === engine.rulesVersion
    && value.label.playerCount === engine.playerCount
    && JSON.stringify(value.label.activePlayers) === JSON.stringify(engine.activePlayers)
    && JSON.stringify(value.label.survivingPlayers) === JSON.stringify(engine.activePlayers.filter(player => !engine.resignedPlayers.has(player))),
  "Defensive label actor/rules/seats disagree with its source state");
  const legal = [...engine.getLegalMoves().map(move => key(move.point)), "PASS"].sort();
  check(JSON.stringify([...value.label.legalActionKeys].sort()) === JSON.stringify(legal), "Defensive label actions disagree with canonical legality");
  return value;
}
export async function defensiveDataMain(args) {
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  check(option("--input", null), "Use --input frozen-position-array.json");
  const input = resolve(option("--input")), runRoot = resolve(option("--run-root", "local_artifacts/defensive-training-v1/data"));
  const maxUnits = Number(option("--max-new-units", "1")), maxSeconds = Number(option("--max-seconds", "30"));
  const settings = { maxNodes: Number(option("--max-nodes-per-label", "100000")),
    timeMs: Number(option("--time-ms-per-label", "10000")) };
  check(Number.isInteger(maxUnits) && maxUnits >= 0 && Number.isFinite(maxSeconds) && maxSeconds > 0
    && Number.isInteger(settings.maxNodes) && settings.maxNodes >= 0
    && Number.isFinite(settings.timeMs) && settings.timeMs >= 0, "Invalid bounded data budget");
  const inputBytes = await readFile(input), plans = JSON.parse(inputBytes);
  check(Array.isArray(plans) && plans.length > 0 && new Set(plans.map(row => row.id)).size === plans.length
    && plans.every(row => /^[-a-zA-Z0-9_]{1,100}$/.test(row.id) && ["train", "validation"].includes(row.split)), "Invalid data plan IDs or splits");
  const splitHashes = new Map();
  for (const plan of plans) {
    const digest = sha(JSON.stringify(plan.state));
    check(!splitHashes.has(digest) || splitHashes.get(digest) === plan.split, "The same full position cannot enter both train and validation");
    splitHashes.set(digest, plan.split);
  }
  const source_hashes = Object.fromEntries(await Promise.all(SOURCES.map(async path => [path, sha(await readFile(resolve(root, path)))])));
  const identity = sha(JSON.stringify({ source_hashes, input_sha256: sha(inputBytes), settings,
    contract: DEFENSIVE_TRAINING_CONTRACT }));
  await mkdir(runRoot, { recursive: true });
  const guard = await lease(runRoot);
  try {
    for (const name of await readdir(runRoot)) if (name.endsWith(".tmp"))
      await rename(resolve(runRoot, name), resolve(runRoot, `${name}.interrupted-${Date.now()}`));
    const old = await readJson(resolve(runRoot, "checkpoint.json"), true);
    const cp = old ? unseal(old) : { identity, completed: [], units: 0 };
    check(cp.identity === identity && cp.units === cp.completed.length && cp.completed.length <= plans.length, "Data identity or progress corruption");
    const save = async status => {
      await atomic(resolve(runRoot, "checkpoint.json"), sealed(cp));
      await atomic(resolve(runRoot, "progress.json"), { identity, status, progress_units: cp.units,
        completed_samples: cp.completed.length, total_samples: plans.length });
    };
    for (const [index, record] of cp.completed.entries()) {
      check(record.id === plans[index].id && record.path === `samples/${record.id}.json`, "Completed unit order corruption");
      const bytes = await readFile(resolve(runRoot, record.path));
      check(sha(bytes) === record.sha256, "Completed label changed");
      assertSourceBoundDefensiveSample(unseal(JSON.parse(bytes)));
    }
    const started = Date.now(); let units = 0;
    while (cp.completed.length < plans.length) {
      for (const [file, status] of [["STOP", "STOPPED"], ["PAUSE", "PAUSED"]]) {
        try { await readFile(resolve(runRoot, file)); await save(status); return 75; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      if (units >= maxUnits || Date.now() - started >= maxSeconds * 1000) { await save("YIELDED"); return 75; }
      const plan = plans[cp.completed.length], path = `samples/${plan.id}.json`;
      const prior = await readJson(resolve(runRoot, path), true);
      let bytes;
      if (prior) {
        const value = unseal(prior);
        check(value.identity === identity && value.sourceStateHash === sha(JSON.stringify(plan.state))
          && value.id === plan.id && value.split === plan.split, "Unindexed sample identity corruption");
        assertSourceBoundDefensiveSample(value);
        bytes = await readFile(resolve(runRoot, path));
      } else {
        const engine = engineFromTrainingState(plan.state), result = defensiveTrainingLabel(engine, settings);
        if (!result.label) {
          await atomic(resolve(runRoot, "incomplete-search.json"), { identity, sampleId: plan.id, ...result });
          await save("NO_LABEL_INCOMPLETE_SEARCH"); return 78;
        }
        const features = new Map(fastPolicyCandidates(engine).map(move => [key(move.point), move.features]));
        result.label.moves.forEach(move => { move.features = [...(move.point === null ? Array(16).fill(0) : features.get(key(move.point))), Number(move.point === null)]; });
        const value = sealed(assertSourceBoundDefensiveSample({ id: plan.id, split: plan.split, identity,
          sourceState: plan.state, sourceStateHash: sha(JSON.stringify(plan.state)), label: result.label }));
        await atomic(resolve(runRoot, path), value);
        bytes = await readFile(resolve(runRoot, path));
        if (args.includes("--fault-after-sample-write")) return 79;
      }
      cp.completed.push({ id: plan.id, split: plan.split, path, sha256: sha(bytes) }); cp.units++; units++;
      await save("RUNNING");
    }
    // Do not certify sources that changed during the compilation.
    for (const [path, hash] of Object.entries(source_hashes)) check(sha(await readFile(resolve(root, path))) === hash, "Training source drift");
    check(sha(await readFile(input)) === sha(inputBytes), "Training input drift");
    await atomic(resolve(runRoot, "manifest.json"), { schema: "lifeline-defensive-training-dataset-v1",
      identity, contract: DEFENSIVE_TRAINING_CONTRACT, source_hashes, input_sha256: sha(inputBytes),
      samples: cp.completed, status: "COMPLETE_DATA_NOT_TRAINED", minimumCompletedDepth: 3,
      limitations: "Paranoid opponent model; finite search horizon; full-label fitting is not strength or admission evidence." });
    await save("COMPLETE"); return 0;
  } finally { await new Promise(done => guard.close(done)); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await defensiveDataMain(process.argv.slice(2)); }
  catch (error) { console.error(error.stack); process.exitCode = error.code === "EADDRINUSE" ? 76 : 78; }
}
