// Freeze a reproducible legal-prefix sampling plan before any teacher labels.
// Sampling actions are unlabelled source trajectories, never training targets.
import { readFile, mkdir, readdir, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { GameEngine } from "../web前端/GameEngine.js";
import { serializeEngineState } from "../web前端/AIStateProtocol.js";
import { atomic, lease, readJson, root, sealed, sha, unseal } from "./neural-posttraining-data-v2.mjs";
import { engineFromTrainingState } from "./defensive-training-data-v1.mjs";
import { defensiveTrainingLabel } from "../web前端/DefensiveTrainingTeacher.js";

const check = (ok, message) => { if (!ok) throw new Error(message); };
const integer = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;
export const WARMSTART_V2_SOURCES = [
  "web/tools/prepare-defensive-warmstart-v2.mjs", "web/tools/defensive-warmstart-pipeline-v2.mjs",
  "web/tools/train-defensive-warmstart-v2.mjs", "web/tools/train-defensive-policy-v1.mjs",
  "web/tools/verify-defensive-warmstart-v2.mjs",
  "web/tools/defensive-training-data-v1.mjs", "web/tools/neural-posttraining-data-v2.mjs",
  "web/tools/supervise-three-player-job.mjs", "web/web前端/DefensiveTrainingTeacher.js",
  "web/web前端/GameEngine.js", "web/web前端/AIEngine.js", "web/web前端/AIStateProtocol.js",
  "web/web前端/MultiplayerSearch.js", "web/web前端/MultiplayerNativeGeometry.js", "web/web前端/MultiplayerHardValue.js",
  "web/web前端/HexPlayerAI.js", "web/tools/launch-defensive-warmstart-v2.ps1", "web/tools/recover-defensive-warmstart-at-login-v2.ps1",
  "web/web前端/assets/research-ai/multiplayer-v1/manifest.json",
  "web/web前端/assets/research-ai/three-player-search-v4-round12.json",
  "web/web前端/assets/research-ai/three-player-policy-v1.json",
  "web/web前端/assets/research-ai/hex-player-policy-v1.json",
];
export function validateWarmstartProtocol(config) {
  const s = config?.sampling, l = config?.labels, t = config?.training, v = config?.supervision;
  check(config?.schema === "lifeline-defensive-warmstart-protocol-v2" && config.rules_version === "territory-v3"
    && Array.isArray(config.parents) && config.parents.length > 0 && new Set(config.parents).size === config.parents.length
    && config.parents.every(parent => ["easy", "three-v4", "three-v1", "hex-v1"].includes(parent)), "Invalid defensive warm-start protocol");
  check(s && Array.isArray(s.player_counts) && s.player_counts.length > 0
    && new Set(s.player_counts).size === s.player_counts.length && s.player_counts.every(x => integer(x, 2, 6))
    && Array.isArray(s.board_sizes) && s.board_sizes.length > 0 && new Set(s.board_sizes).size === s.board_sizes.length
    && s.board_sizes.every(x => integer(x, 5, 15)) && typeof s.seed_namespace === "string" && s.seed_namespace.length > 0
    && (s.board_shapes === undefined || Array.isArray(s.board_shapes) && s.board_shapes.length > 0
      && s.board_shapes.every(shape => ["native", "triangle", "hexagon"].includes(shape)))
    && integer(s.games_per_cell_per_split, 1, 20) && integer(s.samples_per_game, 1, 20)
    && (s.games_per_cell_per_split_by_player_count === undefined || Object.values(s.games_per_cell_per_split_by_player_count).every(x => integer(x, 1, 20)))
    && (s.samples_per_game_by_player_count === undefined || Object.values(s.samples_per_game_by_player_count).every(x => integer(x, 1, 20)))
    && integer(s.max_game_plies, 1, 1000) && integer(s.minimum_prefix_plies, 0, s.max_game_plies)
    && integer(s.maximum_legal_placements, 1, 1000)
    && Number.isFinite(s.attack_sampling_probability) && s.attack_sampling_probability >= 0 && s.attack_sampling_probability <= 1,
  "Invalid bounded legal-prefix sampling configuration");
  check(l && integer(l.max_nodes_per_label, 1, 1e9) && Number.isFinite(l.time_ms_per_label)
    && l.time_ms_per_label > 0 && l.time_ms_per_label <= 3600000
    && t && integer(t.updates, 1, 1000) && Number.isFinite(t.learning_rate) && t.learning_rate > 0 && t.learning_rate <= 1
    && v && Number.isFinite(v.max_wall_seconds) && v.max_wall_seconds > 0 && v.max_wall_seconds <= 86400
    && Number.isFinite(v.worker_wall_seconds) && v.worker_wall_seconds > 0 && v.worker_wall_seconds <= v.max_wall_seconds
    && integer(v.max_restarts, 0, 100) && integer(v.max_no_progress_exits, 1, 100)
    && (v.worker_units === undefined || integer(v.worker_units, 1, 1000)), "Invalid label, fitting or supervision budget");
  return config;
}
function random(seed) {
  let state = parseInt(sha(seed).slice(0, 8), 16) >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}
export function sampleWarmstartPositions(config) {
  validateWarmstartProtocol(config);
  const sampling = config.sampling, plans = [], episodes = [], fullStates = new Map();
  for (const playerCount of sampling.player_counts) for (const gridSize of sampling.board_sizes)
    for (const shape of [...new Set((sampling.board_shapes ?? ["native"]).map(shape => shape === "native"
      ? playerCount <= 3 ? "triangle" : "hexagon" : shape))])
    for (const split of ["train", "validation"]) for (let episode = 0; episode <
      (sampling.games_per_cell_per_split_by_player_count?.[playerCount] ?? sampling.games_per_cell_per_split); episode++) {
      const episodeId = `p${playerCount}-s${gridSize}-${shape}-${split}-g${episode}`;
      const next = random(`${sampling.seed_namespace}/${episodeId}`), candidates = [], cuts = [];
      const engine = new GameEngine({ gridSize, playerCount, boardShape: shape, rulesVersion: config.rules_version, deferTerritoryUpdates: true });
      engine._isReplayingBatch = true;
      const nodeCount = player => engine._getPlayerNodes(player).length;
      for (let ply = 0; ply < sampling.max_game_plies && !engine.gameOver; ply++) {
        const legal = engine.getLegalMoves(), actor = engine.currentPlayer;
        if (ply >= sampling.minimum_prefix_plies && legal.length > 0 && legal.length <= sampling.maximum_legal_placements) {
          const recent = cuts.filter(row => row.ply >= ply - 2 * playerCount && row.damaged.includes(actor));
          candidates.push({ ply, state: serializeEngineState(engine), legalPlacements: legal.length,
            recentDamagingReplies: recent.length, recentLostNodes: recent.reduce((sum, row) => sum + row.losses[actor], 0),
            legalAttacks: legal.filter(move => move.isAttack).length });
        }
        const before = Object.fromEntries(engine.activePlayers.map(player => [player, nodeCount(player)]));
        const attacks = legal.filter(move => move.isAttack);
        const choices = attacks.length && next() < sampling.attack_sampling_probability ? attacks : legal;
        const point = choices.length ? choices[Math.floor(next() * choices.length)].point : null;
        const result = point === null ? engine.skipTurn() : engine.playMove(point);
        check(result.success, `Sampler attempted an illegal native action in ${episodeId}`);
        const losses = Object.fromEntries(engine.activePlayers.map(player => [player, Math.max(0, before[player] - nodeCount(player))]));
        const damaged = engine.activePlayers.filter(player => player !== actor && losses[player] > 0);
        if (damaged.length) cuts.push({ ply, damaged, losses });
      }
      // A fixed ordering prefers recent repeated cuts, then a legal countercut,
      // then later crowded positions. No teacher target is inferred here.
      candidates.sort((a, b) => b.recentDamagingReplies - a.recentDamagingReplies || b.recentLostNodes - a.recentLostNodes
        || b.legalAttacks - a.legalAttacks || b.ply - a.ply);
      const chosen = [];
      for (const candidate of candidates) {
        const stateHash = sha(JSON.stringify(candidate.state));
        if (fullStates.has(stateHash)) continue;
        fullStates.set(stateHash, split); chosen.push(candidate);
        plans.push({ id: `${episodeId}-t${candidate.ply}`, split, state: candidate.state,
          metadata: { episodeId, prefixPlies: candidate.ply, legalPlacements: candidate.legalPlacements,
            recentDamagingReplies: candidate.recentDamagingReplies, recentLostNodes: candidate.recentLostNodes,
            legalAttacks: candidate.legalAttacks, source: "seeded-native-legal-game-prefix" } });
        if (chosen.length === (sampling.samples_per_game_by_player_count?.[playerCount] ?? sampling.samples_per_game)) break;
      }
      episodes.push({ episodeId, split, playerCount, gridSize, boardShape: shape, legalActionsPlayed: engine.turnCount,
        terminal: engine.gameOver, availablePositions: candidates.length, selectedPositions: chosen.length });
    }
  return { plans, receipt: { schema: "lifeline-defensive-prefix-sampling-v2", status: "SOURCE_POSITIONS_NOT_LABELS",
    episodes, source_positions: plans.length, split_unit: "entire independently seeded game", labels_generated: 0,
    limitations: "Crowded/tactical legal-prefix selection; no claim of uniform game-state coverage or strength." } };
}
export async function probeWarmstartPositions(plans, config, options = {}) {
  const runRoot = resolve(options.runRoot), maxUnits = options.maxUnits ?? 1, maxSeconds = options.maxSeconds ?? 30;
  const settings = { maxNodes: options.maxNodes ?? 20000, timeMs: options.timeMs ?? 1500 };
  check(Number.isInteger(maxUnits) && maxUnits >= 0 && Number.isFinite(maxSeconds) && maxSeconds > 0
    && maxSeconds <= 60 && integer(settings.maxNodes, 1, 1e9) && Number.isFinite(settings.timeMs)
    && settings.timeMs > 0 && settings.timeMs <= 60000, "Invalid bounded pilot prefilter budget");
  await mkdir(runRoot, { recursive: true }); const guard = await lease(runRoot);
  try {
    for (const name of await readdir(runRoot)) if (name.endsWith(".tmp"))
      await rename(resolve(runRoot, name), resolve(runRoot, `${name}.interrupted-${Date.now()}`));
    const sources = Object.fromEntries(await Promise.all(WARMSTART_V2_SOURCES.map(async path => [path, sha(await readFile(resolve(root, path)))])));
    const identity = sha(JSON.stringify({ sources, plans, config, settings }));
    const raw = await readJson(resolve(runRoot, "checkpoint.json"), true);
    const cp = raw ? unseal(raw) : { schema: "lifeline-defensive-pilot-prefilter-v2", identity, completed: [], units: 0 };
    check(cp.identity === identity && cp.units === cp.completed.length && cp.units <= plans.length, "Pilot identity or counter corruption");
    const save = async status => {
      await atomic(resolve(runRoot, "checkpoint.json"), sealed(cp));
      await atomic(resolve(runRoot, "progress.json"), { identity, status, progress_units: cp.units, total_units: plans.length,
        accepted: cp.completed.filter(row => row.accepted).length, rejected: cp.completed.filter(row => !row.accepted).length });
    };
    for (let index = 0; index < cp.completed.length; index++) {
      const row = cp.completed[index];
      check(row.id === plans[index].id && row.sourceStateHash === sha(JSON.stringify(plans[index].state)), "Pilot source order corruption");
      check(sha(await readFile(resolve(runRoot, row.path))) === row.sha256, "Pilot receipt corruption");
    }
    const started = Date.now(), before = cp.units;
    while (cp.units < plans.length) {
      for (const [marker, status] of [["STOP", "STOPPED"], ["PAUSE", "PAUSED"]]) {
        try { await readFile(resolve(runRoot, marker)); await save(status); return { status, code: 75 }; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      if (cp.units - before >= maxUnits || Date.now() - started >= maxSeconds * 1000) {
        await save("YIELDED"); return { status: "PROBE_YIELDED_NOT_PREPARED", code: 75, completed: cp.units, total: plans.length };
      }
      const plan = plans[cp.units], path = `receipts/${plan.id}.json`, stateHash = sha(JSON.stringify(plan.state));
      let receipt = await readJson(resolve(runRoot, path), true);
      if (receipt) {
        receipt = unseal(receipt);
        check(receipt.identity === identity && receipt.id === plan.id && receipt.sourceStateHash === stateHash,
          "Unindexed pilot receipt identity corruption");
      } else {
        const result = defensiveTrainingLabel(engineFromTrainingState(plan.state), settings);
        receipt = { identity, id: plan.id, sourceStateHash: stateHash, search: result.search,
          accepted: result.label !== null, status: result.label ? "COMPLETE_TEACHER_PROBE_NOT_DATA" : "REJECTED_INCOMPLETE_SEARCH",
          label_generated_for_formal_dataset: false, split: plan.split,
          scope: "Pilot cost/feasibility only. Formal source labels must be generated anew through defensive-training-data-v1.mjs." };
        await atomic(resolve(runRoot, path), sealed(receipt));
      }
      if (options.faultAfterReceipt) return { status: "FAULT_AFTER_PILOT_RECEIPT", code: 79 };
      cp.completed.push({ id: plan.id, sourceStateHash: stateHash, accepted: receipt.accepted, path,
        sha256: sha(await readFile(resolve(runRoot, path))) }); cp.units++;
      await save("RUNNING");
    }
    for (const [path, expected] of Object.entries(sources)) check(sha(await readFile(resolve(root, path))) === expected, "Pilot source drift");
    const accepted = plans.filter((_, index) => cp.completed[index].accepted);
    await atomic(resolve(runRoot, "accepted-positions.json"), accepted);
    await atomic(resolve(runRoot, "completion-receipt.json"), sealed({ identity, status: "PILOT_PREFILTER_COMPLETE_NOT_TRAINING_DATA",
      attempted_positions: plans.length, accepted_positions: accepted.length, rejected_positions: plans.length - accepted.length,
      accepted_positions_sha256: sha(await readFile(resolve(runRoot, "accepted-positions.json"))), settings, source_hashes: sources,
      coverage: [...new Set(accepted.map(row => `${row.state.playerCount}/${row.state.gridSize}/${row.state.boardShape}/${row.split}`))] }));
    await save("COMPLETE"); return { status: "PROBE_COMPLETE_NOT_TRAINING_DATA", code: 0, plans: accepted, completed: cp.units, total: plans.length };
  } finally { await new Promise(done => guard.close(done)); }
}
export async function prepareWarmstartMain(args) {
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  check(option("--run-root", null) && option("--protocol", null), "Use --run-root NEW_DIRECTORY --protocol FROZEN_PROTOCOL_JSON [--input FROZEN_POSITIONS]");
  const runRoot = resolve(option("--run-root")), config = validateWarmstartProtocol(JSON.parse(await readFile(resolve(option("--protocol")), "utf8")));
  let contents;
  try { contents = await readdir(runRoot); } catch (error) { if (error.code !== "ENOENT") throw error; contents = []; }
  check(contents.length === 0, "Preparation refuses to overwrite an existing run root");
  const supplied = option("--input", null);
  let sampled = supplied ? { plans: JSON.parse(await readFile(resolve(supplied), "utf8")),
    receipt: { schema: "lifeline-defensive-prefix-sampling-v2", status: "SUPPLIED_SOURCE_POSITIONS_NOT_LABELS", labels_generated: 0,
      input_sha256: sha(await readFile(resolve(supplied))) } } : sampleWarmstartPositions(config);
  check(Array.isArray(sampled.plans) && sampled.plans.length > 0, "Empty source plan");
  check(sampled.plans.every(row => row.state?.rulesVersion === config.rules_version), "Source position rules must match the frozen protocol");
  if (args.includes("--probe")) {
    const probed = await probeWarmstartPositions(sampled.plans, config, {
      runRoot: resolve(option("--probe-run-root", `${runRoot}-pilot-prefilter`)),
      maxUnits: Number(option("--probe-max-new-units", "1")), maxSeconds: Number(option("--probe-max-seconds", "30")),
      maxNodes: Number(option("--probe-max-nodes", "20000")), timeMs: Number(option("--probe-time-ms", "1500")),
    });
    if (probed.code !== 0) return probed;
    check(probed.plans.length > 0, "Pilot rejected every source position; no formal plan prepared");
    sampled = { plans: probed.plans, receipt: { ...sampled.receipt,
      pilot_attempted_positions: probed.total, pilot_accepted_positions: probed.plans.length,
      pilot_rejected_positions: probed.total - probed.plans.length,
      selection: "Exact-depth pilot feasibility prefilter; formal compiler reruns accepted source positions; late/tactical bias" } };
  }
  check(new Set(sampled.plans.map(row => row.id)).size === sampled.plans.length
    && sampled.plans.every(row => /^[-a-zA-Z0-9_]{1,100}$/.test(row.id) && ["train", "validation"].includes(row.split)), "Invalid or duplicate frozen source IDs/splits");
  const parentCounts = { easy: [2, 3, 4, 5, 6], "three-v4": [3], "three-v1": [3], "hex-v1": [4, 5, 6] };
  for (const parent of config.parents) for (const split of ["train", "validation"])
    check(sampled.plans.some(row => row.split === split && parentCounts[parent].includes(row.state.playerCount)),
      `No accepted ${split} positions for ${parent}; rejected pilot positions are not labels`);
  // Windows can reserve otherwise ordinary localhost ports. Test this exact
  // run root before freezing a long job, rather than discovering it at launch.
  const guards = [], leaseRoots = [resolve(runRoot, "pipeline-worker"), resolve(runRoot, "data"),
    ...config.parents.flatMap(parent => [resolve(runRoot, "models", parent), resolve(runRoot, "verification", parent)])];
  try {
    const canonical = process.platform === "win32" ? runRoot.toLowerCase() : runRoot;
    for (const role of ["supervisor", "worker-host"]) {
      const port = (role === "supervisor" ? 20000 : 40000) + parseInt(sha(`${role}:${canonical}`).slice(0, 8), 16) % 20000;
      const server = createServer(socket => socket.destroy());
      await new Promise((done, fail) => { server.once("error", fail); server.listen({ host: "127.0.0.1", port, exclusive: true }, done); });
      guards.push(server);
    }
    for (const path of leaseRoots) guards.push(await lease(path));
  } finally { for (const guard of guards) await new Promise(done => guard.close(done)); }
  const sources = Object.fromEntries(await Promise.all(WARMSTART_V2_SOURCES.map(async path => [path, sha(await readFile(resolve(root, path)))])));
  await mkdir(runRoot, { recursive: true });
  await atomic(resolve(runRoot, "protocol.json"), config);
  await atomic(resolve(runRoot, "positions.json"), sampled.plans);
  await atomic(resolve(runRoot, "sampling-receipt.json"), sampled.receipt);
  await atomic(resolve(runRoot, "frozen-sources.json"), { schema: "lifeline-defensive-warmstart-frozen-v2", source_hashes: sources });
  const job = { schema: "lifeline-supervised-job-v1", run_root: runRoot, cwd: root,
    command: [process.execPath, resolve(root, "web/tools/defensive-warmstart-pipeline-v2.mjs"), "--run-root", runRoot,
      "--max-new-units", String(config.supervision.worker_units ?? 8), "--max-seconds", String(Math.max(1, config.supervision.worker_wall_seconds - 5))],
    identity_files: [...WARMSTART_V2_SOURCES, resolve(runRoot, "protocol.json"), resolve(runRoot, "positions.json"),
      resolve(runRoot, "sampling-receipt.json"), resolve(runRoot, "frozen-sources.json")], ...config.supervision };
  await atomic(resolve(runRoot, "job.json"), job);
  return { status: "PREPARED_NOT_STARTED", runRoot, positions: sampled.plans.length, parents: config.parents, sources };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await prepareWarmstartMain(process.argv.slice(2)); console.log(JSON.stringify(result)); process.exitCode = result.code ?? 0; }
  catch (error) { console.error(error.stack); process.exitCode = 78; }
}
