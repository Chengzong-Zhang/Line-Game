// Fresh-game application pilot against the actual parent runtime. Candidate17
// remains isolated. Natural terminal games, truncations and seed blocks differ.
import { mkdir, readFile, readdir, rename } from "node:fs/promises";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { GameEngine } from "../web前端/GameEngine.js";
import { serializeEngineState } from "../web前端/AIStateProtocol.js";
import { loadMultiplayerRuntime } from "../web前端/MultiplayerRuntime.js";
import { engineFromTrainingState } from "./defensive-training-data-v1.mjs";
import { loadDefensiveDataset } from "./train-defensive-policy-v1.mjs";
import { loadWarmstartParent } from "./train-defensive-warmstart-v2.mjs";
import { createDefensiveWarmstartPolicy } from "./verify-defensive-warmstart-v2.mjs";
import { atomic, lease, readJson, root, sealed, sha, unseal } from "./neural-posttraining-data-v2.mjs";

const check = (ok, message) => { if (!ok) throw new Error(message); };
const key = point => point === null ? "PASS" : point.join(",");
const THIS = fileURLToPath(import.meta.url);
const DEFAULTS = { easy: [3, 5], "three-v4": [3, 5], "three-v1": [3, 6], "hex-v1": [4, 5] };
export function validateArenaContext(parent, config) {
  const { playerCount: p, gridSize: size, boardShape: shape, rulesVersion } = config;
  check(Number.isInteger(size) && size >= 5 && size <= 15 && ["territory-v2", "territory-v3"].includes(rulesVersion), "Invalid arena board/rules");
  check(shape === (p === 3 ? "triangle" : "hexagon") && Number.isInteger(p) && p >= 3 && p <= 6,
    "This pilot covers native multiplayer contexts only");
  check(parent === "easy" || parent === "three-v4" && p === 3 && [5, 7, 9].includes(size)
    || parent === "three-v1" && p === 3 && ![5, 7, 9].includes(size)
    || parent === "hex-v1" && p >= 4,
  "Requested parent is not the actual product runtime route in this context");
}
export async function loadActualArenaParent(engine, parent) {
  validateArenaContext(parent.alias, engine);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = input instanceof URL ? input : new URL(input);
    check(url.protocol === "file:", "Arena only loads pinned local product assets");
    const path = fileURLToPath(url), assets = resolve(root, "web/web前端/assets/research-ai");
    const inside = relative(assets, path);
    check(inside && !inside.startsWith("..") && !isAbsolute(inside), "Product asset escaped the local asset tree");
    return new Response(await readFile(path));
  };
  try {
    const runtime = await loadMultiplayerRuntime(parent.alias === "easy" ? "multiplayer-easy-v1" : "multiplayer-medium-v1", engine);
    check(parent.alias === "easy" || runtime.modelInfo.lineage === parent.id, "Actual parent routing changed");
    return runtime;
  } finally { globalThis.fetch = originalFetch; }
}
function rng(seed) {
  let state = parseInt(sha(seed).slice(0, 8), 16) >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}
export function arenaOpening(config, seed) {
  const engine = new GameEngine({ gridSize: config.gridSize, playerCount: config.playerCount,
    boardShape: config.boardShape, rulesVersion: config.rulesVersion, deferTerritoryUpdates: true });
  engine._isReplayingBatch = true;
  const next = rng(`${config.seedNamespace}/${seed}/${config.playerCount}/${config.gridSize}`), actions = [];
  for (let i = 0; i < config.openingPlies && !engine.gameOver; i++) {
    const legal = engine.getLegalMoves(), actor = engine.currentPlayer;
    const point = legal.length ? legal[Math.floor(next() * legal.length)].point : null;
    check((point === null ? engine.skipTurn() : engine.playMove(point)).success, "Fresh arena opening generated an illegal move");
    actions.push({ actor, point });
  }
  check(!engine.gameOver, "Fresh arena opening ended before the evaluated game; choose another frozen seed/opening budget");
  return { state: serializeEngineState(engine), actions };
}
export function nativeArenaOutcome(engine) {
  // Only naturally finished native games contribute winners and win shares.
  GameEngine.prototype._updateTerritories.call(engine);
  const scores = Object.fromEntries(engine.activePlayers.map(player => [player, engine.cachedTerritories[player].area]));
  check(Object.values(scores).every(value => Number.isInteger(value) && value >= 0), "Arena scores must be native discrete area");
  if (!engine.gameOver) return { terminal: false, scores, leaders: null, shares: null };
  const alive = engine.activePlayers.filter(player => !engine.resignedPlayers.has(player));
  const maximum = Math.max(...alive.map(player => scores[player])), leaders = alive.filter(player => scores[player] === maximum);
  return { terminal: true, scores, leaders, shares: Object.fromEntries(engine.activePlayers.map(player => [player,
    leaders.includes(player) ? 1 / leaders.length : 0])) };
}
function pieces(engine) {
  return Object.fromEntries(engine.activePlayers.map(player => [player, {
    nodes: new Set(engine._getPlayerNodes(player).map(key)),
    coverage: new Set([...engine._getPlayerNodes(player), ...engine._getPlayerLines(player)].map(key)),
  }]));
}
function initialMetrics(engine) {
  return Object.fromEntries(engine.activePlayers.map(player => [player, {
    nodes_lost_on_opponent_actions: 0, coverage_lost_on_opponent_actions: 0,
    damaging_opponent_actions: 0, repeated_damage_by_same_opponent_beyond_first: 0,
    maximum_damage_streak_by_same_opponent: 0, opponent_damage_streaks: {},
    enemy_nodes_captured: 0, attacking_nodes_ever: [], live_attacking_nodes: [], maximum_retained_root_connected_attacking_nodes: 0,
    final_retained_root_connected_attacking_nodes: 0, decisions: 0, voluntary_passes: 0,
    decision_elapsed_ms_sum: 0, decision_elapsed_ms_max: 0,
  }]));
}
export function recordArenaTransition(engine, actor, point, before, metrics, elapsedMs) {
  const after = pieces(engine), lost = (a, b) => [...a].filter(value => !b.has(value)).length;
  const own = metrics[actor]; own.decisions++; own.decision_elapsed_ms_sum += elapsedMs;
  own.decision_elapsed_ms_max = Math.max(own.decision_elapsed_ms_max, elapsedMs);
  let captured = 0;
  for (const player of engine.activePlayers) {
    if (player === actor) continue;
    const count = lost(before[player].nodes, after[player].nodes), coverage = lost(before[player].coverage, after[player].coverage);
    captured += count;
    const row = metrics[player]; row.nodes_lost_on_opponent_actions += count; row.coverage_lost_on_opponent_actions += coverage;
    row.damaging_opponent_actions += Number(count > 0);
    const streak = count > 0 ? (row.opponent_damage_streaks[actor] ?? 0) + 1 : 0;
    row.opponent_damage_streaks[actor] = streak;
    row.repeated_damage_by_same_opponent_beyond_first += Number(streak > 1);
    row.maximum_damage_streak_by_same_opponent = Math.max(row.maximum_damage_streak_by_same_opponent, streak);
  }
  own.enemy_nodes_captured += captured;
  if (captured > 0 && point !== null) {
    if (!own.attacking_nodes_ever.includes(key(point))) own.attacking_nodes_ever.push(key(point));
    if (!own.live_attacking_nodes.includes(key(point))) own.live_attacking_nodes.push(key(point));
  }
  for (const player of engine.activePlayers) {
    const connected = engine._getOpponentConnectedPieces(player), state = engine._getPlayerStates(player).node;
    metrics[player].live_attacking_nodes = metrics[player].live_attacking_nodes.filter(point => engine.grid.get(point) === state);
    const retained = metrics[player].live_attacking_nodes.filter(point => connected.has(point)).length;
    metrics[player].final_retained_root_connected_attacking_nodes = retained;
    metrics[player].maximum_retained_root_connected_attacking_nodes = Math.max(metrics[player].maximum_retained_root_connected_attacking_nodes, retained);
  }
}
export function arenaPolicyDecision(engine, policy) {
  const actor = engine.currentPlayer, beforeState = serializeEngineState(engine), beforePieces = pieces(engine);
  const legal = engine.getLegalMoves(), started = performance.now();
  const action = policy.getTopMoves(engine, actor, 1)[0], elapsedMs = performance.now() - started;
  check(JSON.stringify(serializeEngineState(engine)) === JSON.stringify(beforeState), "Arena policy changed the current full source state while deciding");
  check(action && (action.point === null || Array.isArray(action.point)), "Actual policy produced no explicit legal action");
  check(action.point === null || legal.some(move => key(move.point) === key(action.point)), "Arena policy returned an illegal placement");
  const point = action.point === null ? null : [...action.point];
  const result = point === null ? engine.skipTurn() : engine.playMove(point);
  check(result.success, "Canonical arena transition rejected the selected legal placement/PASS");
  return { actor, point, elapsedMs, beforePieces, voluntaryPass: point === null && legal.length > 0 };
}
async function sourceHashes(entries) {
  const paths = new Set();
  const visit = async path => {
    path = resolve(path); if (paths.has(path)) return; paths.add(path);
    const text = await readFile(path, "utf8"), imports = [...text.matchAll(/\b(?:from\s*|import\s*\(\s*|import\s*)["']([^"']+)["']/g)];
    for (const match of imports) if (match[1].startsWith(".")) await visit(resolve(dirname(path), match[1].split("?")[0]));
  };
  for (const entry of entries) await visit(entry);
  return Object.fromEntries(await Promise.all([...paths].sort().map(async path => [relative(root, path).replaceAll("\\", "/"), sha(await readFile(path))])));
}
function aggregateArena(config, receipts, parent) {
  const byId = new Map(receipts.map(row => [row.id, row])), pairs = [];
  for (const row of receipts) if (row.arm === "candidate") {
    const baseline = byId.get(`seed-${row.seed}-baseline`);
    if (!row.outcome.terminal || !baseline?.outcome.terminal) continue;
    const focal = row.focal_player;
    pairs.push({ seed: row.seed, focal_player: focal, candidate_win_share: row.outcome.shares[focal],
      parent_win_share: baseline.outcome.shares[focal], win_share_delta: row.outcome.shares[focal] - baseline.outcome.shares[focal],
      candidate_area: row.outcome.scores[focal], parent_area: baseline.outcome.scores[focal],
      candidate_metrics: row.metrics[focal], parent_metrics: baseline.metrics[focal] });
  }
  const mean = (rows, field) => rows.length ? rows.reduce((sum, row) => sum + row[field], 0) / rows.length : null;
  const metricMeans = name => {
    const fields = ["nodes_lost_on_opponent_actions", "coverage_lost_on_opponent_actions", "damaging_opponent_actions",
      "repeated_damage_by_same_opponent_beyond_first", "maximum_damage_streak_by_same_opponent", "enemy_nodes_captured",
      "maximum_retained_root_connected_attacking_nodes", "final_retained_root_connected_attacking_nodes", "voluntary_passes"];
    return Object.fromEntries(fields.map(field => [field, pairs.length ? pairs.reduce((sum, row) => sum + row[name][field], 0) / pairs.length : null]));
  };
  return { schema: "lifeline-defensive-warmstart-actual-parent-arena-report-v2", status: "BOUNDED_APPLICATION_ARENA_NOT_PRODUCT_ADMISSION",
    context: { player_count: config.playerCount, board_shape: config.boardShape, grid_size: config.gridSize, rules_version: config.rulesVersion },
    parent_id: parent.id, parent_alias: parent.alias, planned_seed_blocks: config.seeds.length,
    completed_seed_blocks: config.seeds.filter(seed => receipts.filter(row => row.seed === seed).length === config.playerCount + 1).length,
    completed_natural_seed_blocks: config.seeds.filter(seed => receipts.filter(row => row.seed === seed && row.outcome.terminal).length === config.playerCount + 1).length,
    complete_game_receipts: receipts.length, natural_terminal_games: receipts.filter(row => row.outcome.terminal).length,
    truncated_games: receipts.filter(row => !row.outcome.terminal).length, matched_focal_comparisons: pairs.length,
    mean_candidate_win_share: mean(pairs, "candidate_win_share"), mean_parent_win_share: mean(pairs, "parent_win_share"),
    mean_win_share_delta: mean(pairs, "win_share_delta"), candidate_defense_attack_metrics: metricMeans("candidate_metrics"),
    parent_defense_attack_metrics: metricMeans("parent_metrics"),
    by_focal_seat: Object.fromEntries([...new Set(pairs.map(row => row.focal_player))].map(player => {
      const selected = pairs.filter(row => row.focal_player === player);
      return [player, { matched_seed_blocks: selected.length, mean_win_share_delta: mean(selected, "win_share_delta") }];
    })),
    statistical_unit: "independently seeded fresh opening block; all focal seats share one all-parent control game",
    matched_denominator: "Only naturally terminal candidate games with a naturally terminal same-seed parent control; truncations never receive win/loss values",
    candidate_algorithm: "isolated standalone learned linear17, full legal placements plus trained voluntary PASS coefficient",
    parent_algorithm: parent.alias === "three-v4" ? "actual multiplayer-medium runtime: v4 12-ply ensemble rollout, terminal-winning PASS and standard defense gate"
      : `actual multiplayer-${parent.alias === "easy" ? "easy" : "medium"} runtime: inherited placement policy, terminal-winning PASS and standard defense gate`,
    excluded: ["Hard search wrapper", "Ultimate", "multiple candidate seats", "other board sizes/shapes/player counts", "browser/phone latency", "global strength or automatic admission"],
    repeated_cut_definition: "For each victim/opponent pair, count repeated node-damaging actions on that opponent's successive actual turns; own and third-party turns do not reset it, a nondamaging action by that opponent does.",
    attack_metric_definition: "Distinct attacking placement cells currently retained as own nodes on an intact logical-edge path to the initial node; no forced-chain guarantee.",
    strength_verified: false, runtime_admitted: false, limitations: "Small application pilot, shared controls, finite game cap and no promotion threshold/statistical power contract. Truncation can bias the complete-case estimate." };
}

export async function defensiveArenaMain(args) {
  const option = (name, fallback) => {
    if (!args.includes(name)) return fallback;
    const value = args[args.indexOf(name) + 1]; check(value && !value.startsWith("--"), `Missing ${name}`); return value;
  };
  check(option("--candidate", null) && option("--data-root", null) && option("--run-root", null), "Use --candidate --data-root --run-root");
  const candidatePath = resolve(option("--candidate")), dataRoot = resolve(option("--data-root")), runRoot = resolve(option("--run-root"));
  const candidateBytes = await readFile(candidatePath), candidate = unseal(JSON.parse(candidateBytes));
  const candidatePolicy = createDefensiveWarmstartPolicy(candidate), parent = await loadWarmstartParent(candidate.lineage.parent_id);
  check(parent.sha256 === candidate.lineage.parent_sha256, "Arena parent differs from candidate provenance");
  const [defaultPlayers, defaultSize] = DEFAULTS[parent.alias];
  const protocolPath = option("--protocol", null) ? resolve(option("--protocol")) : null;
  const protocolBytes = protocolPath ? await readFile(protocolPath) : null;
  const protocol = protocolBytes ? JSON.parse(protocolBytes) : null;
  let preset;
  if (protocol) {
    check(protocol.schema === "lifeline-defensive-actual-parent-arena-protocol-v2"
      && Array.isArray(protocol.parents) && protocol.parents.filter(row => row.parent === parent.alias).length === 1,
    "Invalid fixed arena protocol or missing/duplicate selected parent");
    for (const name of ["--players", "--size", "--rules-version", "--seed-namespace", "--seeds", "--opening-plies", "--max-game-plies"])
      check(!args.includes(name), "A fixed --protocol cannot be overridden by scientific CLI options");
    preset = protocol.parents.find(row => row.parent === parent.alias);
    check(protocol.candidate_updates === undefined || candidate.training.updates === protocol.candidate_updates,
      "Candidate does not have the fixed protocol's preselected update count");
  }
  const config = { schema: "lifeline-defensive-warmstart-actual-parent-arena-v2", parent: parent.alias,
    playerCount: preset?.player_count ?? Number(option("--players", String(defaultPlayers))),
    gridSize: preset?.grid_size ?? Number(option("--size", String(defaultSize))),
    rulesVersion: protocol?.rules_version ?? option("--rules-version", "territory-v3"),
    seedNamespace: protocol?.seed_namespace ?? option("--seed-namespace", "defensive-actual-parent-arena-v2-fresh-20261025"),
    seeds: protocol?.seeds ?? option("--seeds", "2026102501,2026102502").split(","),
    openingPlies: protocol?.opening_plies ?? Number(option("--opening-plies", "4")),
    maxGamePlies: protocol?.max_game_plies ?? Number(option("--max-game-plies", "200")) };
  config.boardShape = config.playerCount === 3 ? "triangle" : "hexagon";
  validateArenaContext(parent.alias, config);
  check(config.seeds.length > 0 && config.seeds.length <= 20 && new Set(config.seeds).size === config.seeds.length
    && config.seeds.every(seed => /^[-a-zA-Z0-9_]{1,50}$/.test(seed))
    && Number.isInteger(config.openingPlies) && config.openingPlies >= 0 && config.openingPlies <= 20
    && Number.isInteger(config.maxGamePlies) && config.maxGamePlies >= 1 && config.maxGamePlies <= 1000,
  "Invalid bounded arena seed/opening/game cap configuration");
  check(preset?.planned_games === undefined || preset.planned_games === config.seeds.length * (config.playerCount + 1),
    "Fixed per-parent game denominator differs from its seeds/all-seat plan");
  const maxUnits = Number(option("--max-new-units", "1")), maxSeconds = Number(option("--max-seconds", "25"));
  check(Number.isInteger(maxUnits) && maxUnits >= 0 && Number.isFinite(maxSeconds) && maxSeconds > 0 && maxSeconds <= 60,
    "Arena segment must have a bounded unit budget and at most 60 seconds between recovery boundaries");
  const dataset = await loadDefensiveDataset(dataRoot);
  check(dataset.manifestHash === candidate.training.dataset_manifest_sha256, "Arena dataset differs from candidate training source");
  const forbiddenStarts = new Set(dataset.samples.map(row => row.sourceStateHash)), plans = [];
  for (const seed of config.seeds) {
    const opening = arenaOpening(config, seed), stateHash = sha(JSON.stringify(opening.state));
    check(!forbiddenStarts.has(stateHash), "Arena opening duplicates a training/validation source position");
    plans.push({ id: `seed-${seed}-baseline`, seed, arm: "parent", focal: null, opening });
    for (const player of opening.state.activePlayers) plans.push({ id: `seed-${seed}-seat-${player}`, seed, arm: "candidate", focal: player, opening });
  }
  const sources = await sourceHashes([THIS]); sources[parent.path] = parent.sha256;
  const identityBody = { config, candidate_sha256: sha(candidateBytes), dataset_manifest_sha256: dataset.manifestHash,
    protocol_sha256: protocolBytes ? sha(protocolBytes) : null,
    parent_id: parent.id, parent_sha256: parent.sha256, source_hashes: sources,
    plan: plans.map(plan => ({ id: plan.id, seed: plan.seed, arm: plan.arm, focal: plan.focal, opening_hash: sha(JSON.stringify(plan.opening.state)) })) };
  const identity = sha(JSON.stringify(identityBody));
  const checkInputs = async () => {
    check(sha(await readFile(candidatePath)) === identityBody.candidate_sha256, "Arena candidate changed");
    if (protocolPath) check(sha(await readFile(protocolPath)) === identityBody.protocol_sha256, "Arena fixed protocol changed");
    check(sha(await readFile(resolve(dataRoot, "manifest.json"))) === dataset.manifestHash, "Arena source dataset changed");
    for (const [path, expected] of Object.entries(sources)) check(sha(await readFile(resolve(root, path))) === expected, `Arena source/model drift: ${path}`);
  };
  await mkdir(runRoot, { recursive: true }); const guard = await lease(runRoot);
  let cp;
  try {
    for (const name of await readdir(runRoot)) if (name.endsWith(".tmp"))
      await rename(resolve(runRoot, name), resolve(runRoot, `${name}.interrupted-${Date.now()}`));
    const raw = await readJson(resolve(runRoot, "checkpoint.json"), true);
    cp = raw ? unseal(raw) : { schema: "lifeline-defensive-warmstart-actual-parent-arena-checkpoint-v2", identity,
      units: 0, committed_plies: 0, completed: [], active: null };
    check(cp.schema === "lifeline-defensive-warmstart-actual-parent-arena-checkpoint-v2" && cp.identity === identity
      && cp.units === cp.committed_plies + cp.completed.length && Number.isInteger(cp.units) && cp.units >= 0
      && cp.completed.length <= plans.length, "Arena checkpoint identity/counter corruption");
    const receipts = [];
    for (const [index, record] of cp.completed.entries()) {
      check(record.id === plans[index].id && record.path === `games/${record.id}.json`, "Arena completed game order corruption");
      const bytes = await readFile(resolve(runRoot, record.path)); check(sha(bytes) === record.sha256, "Arena game receipt changed");
      const receipt = unseal(JSON.parse(bytes)); check(receipt.identity === identity && receipt.id === record.id, "Arena game identity corruption");
      receipts.push(receipt);
    }
    check(cp.committed_plies === receipts.reduce((sum, receipt) => sum + receipt.actions.length, 0) + (cp.active?.actions.length ?? 0),
      "Arena completed/in-flight ply counters disagree");
    if (cp.active) {
      const plan = plans[cp.completed.length]; check(plan && cp.active.id === plan.id, "Arena active game order corruption");
      const restored = engineFromTrainingState(plan.opening.state);
      for (const action of cp.active.actions) {
        check(!restored.gameOver && action.actor === restored.currentPlayer
          && (action.point === null ? restored.skipTurn() : restored.playMove(action.point)).success,
        "Arena in-flight action history no longer replays legally");
      }
      check(JSON.stringify(serializeEngineState(restored)) === JSON.stringify(cp.active.state), "Arena in-flight full state differs from its committed legal actions");
    }
    await atomic(resolve(runRoot, "identity.json"), sealed(identityBody));
    const save = async (status, error) => {
      await atomic(resolve(runRoot, "checkpoint.json"), sealed(cp));
      await atomic(resolve(runRoot, "progress.json"), { identity, status, progress_units: cp.units,
        committed_plies: cp.committed_plies, completed_games: cp.completed.length, total_games: plans.length,
        active_game: cp.active?.id ?? null, active_plies: cp.active?.actions.length ?? 0, ...(error ? { error } : {}) });
    };
    const started = Date.now(), initialUnits = cp.units;
    const control = async () => {
      for (const [file, status] of [["STOP", "STOPPED"], ["PAUSE", "PAUSED"]]) {
        try { await readFile(resolve(runRoot, file)); await save(status); return true; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      if (cp.units - initialUnits >= maxUnits || Date.now() - started >= maxSeconds * 1000) { await save("YIELDED"); return true; }
      return false;
    };
    try {
      await checkInputs();
      while (cp.completed.length < plans.length) {
        if (await control()) return 75;
        await checkInputs();
        const plan = plans[cp.completed.length];
        if (!cp.active) {
          const engine = engineFromTrainingState(plan.opening.state);
          cp.active = { id: plan.id, state: serializeEngineState(engine), actions: [], metrics: initialMetrics(engine) };
          await save("RUNNING");
        }
        check(cp.active.id === plan.id && cp.active.actions.length <= config.maxGamePlies, "Arena in-flight game identity corruption");
        const engine = engineFromTrainingState(cp.active.state);
        if (engine.gameOver || cp.active.actions.length === config.maxGamePlies) {
          const path = `games/${plan.id}.json`, outcome = nativeArenaOutcome(engine);
          const receipt = { schema: "lifeline-defensive-warmstart-actual-parent-game-v2", identity, id: plan.id,
            seed: plan.seed, arm: plan.arm, focal_player: plan.focal, initial_state_sha256: sha(JSON.stringify(plan.opening.state)),
            final_state_sha256: sha(JSON.stringify(serializeEngineState(engine))), opening_actions: plan.opening.actions,
            actions: cp.active.actions, outcome, metrics: cp.active.metrics,
            status: outcome.terminal ? "COMPLETE_NATURAL_TERMINAL" : "TRUNCATED_NOT_COUNTED_AS_WIN_LOSS" };
          const prior = await readJson(resolve(runRoot, path), true);
          if (prior) check(JSON.stringify(unseal(prior)) === JSON.stringify(receipt), "Unindexed game receipt corruption");
          else await atomic(resolve(runRoot, path), sealed(receipt));
          if (args.includes("--fault-after-game-write")) return 79;
          const bytes = await readFile(resolve(runRoot, path));
          cp.completed.push({ id: plan.id, path, sha256: sha(bytes) }); cp.active = null; cp.units++; receipts.push(receipt); await save("RUNNING");
          continue;
        }
        const runtime = await loadActualArenaParent(engine, parent);
        const policy = plan.arm === "candidate" && engine.currentPlayer === plan.focal ? candidatePolicy : runtime.ai;
        const decision = arenaPolicyDecision(engine, policy);
        recordArenaTransition(engine, decision.actor, decision.point, decision.beforePieces, cp.active.metrics, decision.elapsedMs);
        cp.active.metrics[decision.actor].voluntary_passes += Number(decision.voluntaryPass);
        cp.active.actions.push({ actor: decision.actor, point: decision.point, elapsed_ms: decision.elapsedMs });
        cp.active.state = serializeEngineState(engine); cp.committed_plies++; cp.units++; await save("RUNNING");
        if (args.includes("--fault-after-ply-checkpoint")) return 79;
      }
      await checkInputs();
      const finalData = await loadDefensiveDataset(dataRoot); check(finalData.manifestHash === dataset.manifestHash, "Arena source evidence drift");
      await atomic(resolve(runRoot, "report.json"), sealed({ ...aggregateArena(config, receipts, parent), identity,
        candidate_sha256: identityBody.candidate_sha256, dataset_manifest_sha256: dataset.manifestHash,
        source_hashes: sources, candidate_initialization: candidate.lineage,
        training_source_positions_used_as_arena_starts: 0, planned_game_receipts: plans.length }));
      await save("COMPLETE"); return 0;
    } catch (error) { await save("FATAL", error.message); throw error; }
  } finally { await new Promise(done => guard.close(done)); }
}
if (process.argv[1] && resolve(process.argv[1]) === THIS) {
  try { process.exitCode = await defensiveArenaMain(process.argv.slice(2)); }
  catch (error) { console.error(error.stack); process.exitCode = error.code === "EADDRINUSE" ? 76 : 78; }
}
