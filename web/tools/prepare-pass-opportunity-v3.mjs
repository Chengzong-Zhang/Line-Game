// Source generation, bounded feasibility probes and immutable job preparation.
// Only the new full-depth native-area teacher may produce labels for this job.
import { readFile, mkdir, readdir, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GameEngine } from "../web前端/GameEngine.js";
import { serializeEngineState } from "../web前端/AIStateProtocol.js";
import { engineFromTrainingState } from "./pass-opportunity-data-v3.mjs";
import { passOpportunityTrainingLabel } from "../web前端/PassOpportunityTrainingTeacher.js";
import { atomic, lease, readJson, root, sealed, sha, unseal } from "./neural-posttraining-data-v2.mjs";

const check = (ok, message) => { if (!ok) throw new Error(message); };
export const PASS_V3_SOURCES = ["web/tools/prepare-pass-opportunity-v3.mjs", "web/tools/pass-opportunity-pipeline-v3.mjs",
  "web/tools/pass-opportunity-data-v3.mjs", "web/tools/train-pass-opportunity-v3.mjs", "web/tools/verify-pass-opportunity-v3.mjs",
  "web/web前端/PassOpportunityTrainingTeacher.js", "web/web前端/AIPassDiscipline.js", "web/web前端/GameEngine.js",
  "web/web前端/AIEngine.js", "web/web前端/AIStateProtocol.js", "web/web前端/MultiplayerSearch.js",
  "web/web前端/MultiplayerNativeGeometry.js", "web/web前端/MultiplayerHardValue.js", "web/web前端/HexPlayerAI.js",
  "web/tools/neural-posttraining-data-v2.mjs", "web/tools/supervise-three-player-job.mjs",
  "web/web前端/assets/research-ai/multiplayer-v1/manifest.json", "web/web前端/assets/research-ai/three-player-search-v4-round12.json",
  "web/web前端/assets/research-ai/three-player-policy-v1.json", "web/web前端/assets/research-ai/hex-player-policy-v1.json"];
export function validatePassOpportunityProtocol(config) {
  check(config?.schema === "lifeline-pass-opportunity-protocol-v3" && config.rules_version === "territory-v3"
    && Array.isArray(config.parents) && config.parents.length > 0 && new Set(config.parents).size === config.parents.length
    && config.parents.every(p => ["easy", "three-v4", "three-v1", "hex-v1"].includes(p)), "Invalid pass-opportunity protocol");
  const s = config.sampling, l = config.labels, t = config.training, v = config.supervision;
  check(Array.isArray(s?.cells) && s.cells.length > 0 && s.cells.every(c => Number.isInteger(c.players) && c.players >= 2 && c.players <= 6
    && Number.isInteger(c.size) && c.size >= 5 && c.size <= 15 && ["triangle", "hexagon"].includes(c.shape))
    && Number.isInteger(s.games_per_cell_per_split) && s.games_per_cell_per_split > 0 && s.games_per_cell_per_split <= 10
    && Number.isInteger(s.max_game_plies) && s.max_game_plies >= 8 && s.max_game_plies <= 500
    && typeof s.seed_namespace === "string" && s.seed_namespace.length > 0, "Invalid phase-balanced legal-game sampler");
  check(l && Number.isInteger(l.max_nodes_per_label) && l.max_nodes_per_label > 0
    && Number.isFinite(l.time_ms_per_label) && l.time_ms_per_label > 0 && l.time_ms_per_label <= 60000
    && Number.isInteger(t?.updates) && t.updates >= 1 && t.updates <= 1000
    && Number.isFinite(t.learning_rate) && t.learning_rate > 0 && t.learning_rate <= 1
    && Number.isFinite(v?.max_wall_seconds) && v.max_wall_seconds > 0 && v.max_wall_seconds <= 86400
    && Number.isFinite(v.worker_wall_seconds) && v.worker_wall_seconds > 0 && v.worker_wall_seconds <= v.max_wall_seconds,
  "Invalid bounded label/update/supervisor budgets");
  return config;
}
const random = seed => {
  let state = parseInt(sha(seed).slice(0, 8), 16) >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
};
export function samplePassOpportunityPositions(config) {
  validatePassOpportunityProtocol(config);
  const plans = [], episodes = [], seen = new Set(), sampling = config.sampling;
  const add = (engine, episodeId, split, phase, ply, extra = {}) => {
    const state = serializeEngineState(engine), digest = sha(JSON.stringify(state));
    if (engine.gameOver || !engine.getLegalMoves().length || seen.has(digest)) return false;
    seen.add(digest); plans.push({ id: `${episodeId}-${phase}-t${ply}`, split, state,
      metadata: { episodeId, phase, prefixPlies: ply, legalPlacements: engine.getLegalMoves().length,
        source: "seeded-native-legal-game-prefix-v3", ...extra } }); return true;
  };
  for (const cell of sampling.cells) for (const split of ["train", "validation"])
    for (let game = 0; game < sampling.games_per_cell_per_split; game++) {
      const episodeId = `passv3-p${cell.players}-${cell.shape}-s${cell.size}-${split}-g${game}`;
      const next = random(`${sampling.seed_namespace}/${episodeId}`);
      const engine = new GameEngine({ playerCount: cell.players, gridSize: cell.size, boardShape: cell.shape,
        rulesVersion: "territory-v3", deferTerritoryUpdates: true });
      engine._isReplayingBatch = true;
      const snapshots = [];
      for (let ply = 0; ply < sampling.max_game_plies && !engine.gameOver; ply++) {
        const legal = engine.getLegalMoves();
        if (legal.length) snapshots.push({ ply, state: serializeEngineState(engine), legal: legal.length });
        const attacks = legal.filter(move => move.isAttack), choices = attacks.length && next() < 0.5 ? attacks : legal;
        const result = choices.length ? engine.playMove(choices[Math.floor(next() * choices.length)].point) : engine.skipTurn();
        check(result.success, "Sampler attempted an illegal canonical move");
      }
      const positionsBefore = plans.length;
      const choices = [
        ["opening", snapshots[Math.min(split === "train" ? 0 : 1 + game % Math.max(1, cell.players), Math.max(0, snapshots.length - 1))]],
        ["middle", snapshots[Math.floor(snapshots.length * 0.45)]],
        ["late", snapshots[Math.floor(snapshots.length * 0.75)]],
      ];
      for (const [phase, record] of choices) if (record) add(engineFromTrainingState(record.state), episodeId, split, phase, record.ply);
      // These are actual legal PASS actions appended to an actual prefix, not
      // a fabricated counter or actor. Keep the whole source game in one split.
      for (const record of snapshots.slice(0, Math.max(3, cell.players + 1))) {
        const expansion = engineFromTrainingState(record.state); let passes = 0;
        while (!expansion.gameOver && passes < cell.players - 1) {
          check(expansion.skipTurn().success, "Illegal source PASS prefix"); passes++;
        }
        if (!expansion.gameOver && add(expansion, episodeId, split, "expansion", record.ply,
          { appendedVoluntaryPasses: passes, originalPrefixStateHash: sha(JSON.stringify(record.state)) })) break;
      }
      episodes.push({ episodeId, split, ...cell, actualActions: engine.turnCount, terminal: engine.gameOver,
        availableSourcePositions: snapshots.length, selectedSourcePositions: plans.length - positionsBefore });
    }
  return { plans, receipt: { schema: "lifeline-pass-opportunity-source-plan-v3", episodes,
    source_positions: plans.length, labels_generated: 0, split_unit: "entire independent seeded game",
    scope: "Opening/middle/late plus actual PASS-prefix expansion situations; no teacher targets or game-strength claim." } };
}
export async function probePassOpportunityPositions(plans, config, options) {
  const runRoot = resolve(options.runRoot), maxUnits = options.maxUnits ?? 1, maxSeconds = options.maxSeconds ?? 25;
  const settings = { maxNodes: options.maxNodes ?? config.labels.max_nodes_per_label, timeMs: options.timeMs ?? config.labels.time_ms_per_label,
    annotatePassOpportunity: false };
  check(Number.isInteger(maxUnits) && maxUnits > 0 && maxSeconds > 0 && maxSeconds <= 60, "Invalid bounded pilot segment");
  await mkdir(runRoot, { recursive: true }); const guard = await lease(runRoot);
  try {
    for (const name of await readdir(runRoot)) if (name.endsWith(".tmp"))
      await rename(resolve(runRoot, name), resolve(runRoot, `${name}.interrupted-${Date.now()}`));
    const sourceHashes = Object.fromEntries(await Promise.all(PASS_V3_SOURCES.map(async p => [p, sha(await readFile(resolve(root, p)))])));
    const identity = sha(JSON.stringify({ plans, config, settings, sourceHashes }));
    const old = await readJson(resolve(runRoot, "checkpoint.json"), true), cp = old ? unseal(old) : { identity, units: 0, completed: [] };
    check(cp.identity === identity && cp.units === cp.completed.length && cp.units <= plans.length, "Pilot identity/progress corruption");
    for (let i = 0; i < cp.completed.length; i++) {
      const row = cp.completed[i]; check(row.id === plans[i].id && sha(await readFile(resolve(runRoot, row.path))) === row.sha256, "Pilot completed evidence changed");
    }
    const save = async status => { await atomic(resolve(runRoot, "checkpoint.json"), sealed(cp)); await atomic(resolve(runRoot, "progress.json"),
      { identity, status, progress_units: cp.units, total_units: plans.length, accepted: cp.completed.filter(r => r.accepted).length }); };
    const started = Date.now(), before = cp.units;
    while (cp.units < plans.length) {
      for (const [marker, status] of [["STOP", "STOPPED"], ["PAUSE", "PAUSED"]]) {
        try { await readFile(resolve(runRoot, marker)); await save(status); return { code: 75, status }; } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      if (cp.units - before >= maxUnits || Date.now() - started >= maxSeconds * 1000) { await save("YIELDED"); return { code: 75, status: "PILOT_YIELDED" }; }
      const plan = plans[cp.units], path = `receipts/${plan.id}.json`, prior = await readJson(resolve(runRoot, path), true);
      let receipt;
      if (prior) { receipt = unseal(prior); check(receipt.identity === identity && receipt.sourceStateHash === sha(JSON.stringify(plan.state)), "Unindexed pilot receipt identity corruption"); }
      else {
        const result = passOpportunityTrainingLabel(engineFromTrainingState(plan.state), settings);
        receipt = { identity, id: plan.id, split: plan.split, phase: plan.metadata.phase, sourceStateHash: sha(JSON.stringify(plan.state)),
          status: result.status, accepted: result.label !== null, search: result.search, formal_training_label: false };
        await atomic(resolve(runRoot, path), sealed(receipt));
      }
      if (options.faultAfterReceipt) return { code: 79, status: "FAULT_AFTER_PILOT_RECEIPT" };
      cp.completed.push({ id: plan.id, path, accepted: receipt.accepted, sha256: sha(await readFile(resolve(runRoot, path))) }); cp.units++;
      await save("RUNNING");
    }
    for (const [p, h] of Object.entries(sourceHashes)) check(sha(await readFile(resolve(root, p))) === h, "Pilot source drift");
    const accepted = plans.filter((_, i) => cp.completed[i].accepted);
    await atomic(resolve(runRoot, "accepted-positions.json"), accepted);
    await save("COMPLETE"); return { code: 0, status: "PILOT_COMPLETE_NOT_TRAINING_DATA", accepted: accepted.length, attempted: plans.length };
  } finally { await new Promise(done => guard.close(done)); }
}
export async function preparePassOpportunityMain(args) {
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  check(option("--run-root") && option("--protocol"), "Use --run-root NEW_DIRECTORY --protocol FROZEN_CONFIG [--input REVIEWED_SOURCE] [--source-only]");
  const runRoot = resolve(option("--run-root")), config = validatePassOpportunityProtocol(await readJson(resolve(option("--protocol"))));
  let names = []; try { names = await readdir(runRoot); } catch (e) { if (e.code !== "ENOENT") throw e; }
  check(names.length === 0, "Preparation refuses to overwrite an existing run");
  const inputPath = option("--input"), sampled = inputPath ? { plans: await readJson(resolve(inputPath)), receipt: { supplied_input_sha256: sha(await readFile(resolve(inputPath))), labels_generated: 0 } }
    : samplePassOpportunityPositions(config);
  check(Array.isArray(sampled.plans) && sampled.plans.length > 0, "No source positions");
  await mkdir(runRoot, { recursive: true }); await atomic(resolve(runRoot, "protocol.json"), config);
  await atomic(resolve(runRoot, "positions.json"), sampled.plans); await atomic(resolve(runRoot, "sampling-receipt.json"), sampled.receipt);
  if (args.includes("--source-only")) return { status: "SOURCE_ONLY_NOT_TRAINING_DATA", runRoot, positions: sampled.plans.length };
  const sourceHashes = Object.fromEntries(await Promise.all(PASS_V3_SOURCES.map(async p => [p, sha(await readFile(resolve(root, p)))])));
  await atomic(resolve(runRoot, "frozen-sources.json"), { schema: "lifeline-pass-opportunity-frozen-v3", source_hashes: sourceHashes });
  const job = { schema: "lifeline-supervised-job-v1", run_root: runRoot, cwd: root,
    command: [process.execPath, resolve(root, "web/tools/pass-opportunity-pipeline-v3.mjs"), "--run-root", runRoot,
      "--max-new-units", String(config.supervision.worker_units ?? 8), "--max-seconds", String(Math.max(1, config.supervision.worker_wall_seconds - 5))],
    identity_files: [...PASS_V3_SOURCES, resolve(runRoot, "protocol.json"), resolve(runRoot, "positions.json"), resolve(runRoot, "frozen-sources.json")], ...config.supervision };
  await atomic(resolve(runRoot, "job.json"), job); return { status: "PREPARED_NOT_STARTED", runRoot, positions: sampled.plans.length };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await preparePassOpportunityMain(process.argv.slice(2)); console.log(JSON.stringify(result)); process.exitCode = result.code ?? 0; }
  catch (error) { console.error(error.stack); process.exitCode = error.code === "EADDRINUSE" ? 76 : 78; }
}
