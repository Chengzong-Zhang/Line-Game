// Independent receipt replay and arithmetic. Does not import the arena's
// opening, outcome, metric or aggregation implementations and never plays new games.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GameEngine } from "../web前端/GameEngine.js";
import { serializeEngineState } from "../web前端/AIStateProtocol.js";
import { engineFromTrainingState } from "./defensive-training-data-v1.mjs";
import { fastPolicyCandidates } from "../web前端/MultiplayerSearch.js";
import { loadDefensiveDataset } from "./train-defensive-policy-v1.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SELF = fileURLToPath(import.meta.url), sha = value => createHash("sha256").update(value).digest("hex");
const read = async path => JSON.parse(await readFile(path, "utf8"));
function unseal(value) {
  const { integrity, ...body } = value; assert.equal(integrity, sha(JSON.stringify(body)), "Evidence seal mismatch"); return body;
}
const readSealed = async path => unseal(await read(path));
const pointKey = point => point === null ? "PASS" : point.join(",");
const snapshotHash = engine => sha(JSON.stringify(serializeEngineState(engine)));
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
function newOpening(config, seed) {
  const engine = new GameEngine({ gridSize: config.gridSize, playerCount: config.playerCount,
    boardShape: config.boardShape, rulesVersion: config.rulesVersion, deferTerritoryUpdates: true });
  engine._isReplayingBatch = true;
  let randomState = parseInt(sha(`${config.seedNamespace}/${seed}/${config.playerCount}/${config.gridSize}`).slice(0, 8), 16) >>> 0;
  const actions = [];
  for (let ply = 0; ply < config.openingPlies && !engine.gameOver; ply++) {
    const legal = engine.getLegalMoves(), actor = engine.currentPlayer;
    let point = null;
    if (legal.length) {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
      point = legal[Math.floor((randomState / 4294967296) * legal.length)].point;
    }
    assert.equal((point === null ? engine.skipTurn() : engine.playMove(point)).success, true);
    actions.push({ actor, point });
  }
  assert.equal(engine.gameOver, false);
  return { state: serializeEngineState(engine), actions };
}
function pieceSets(engine) {
  return Object.fromEntries(engine.activePlayers.map(player => {
    const states = engine._getPlayerStates(player), entries = [...engine.grid];
    return [player, { nodes: new Set(entries.filter(([, state]) => state === states.node).map(([point]) => point)),
      coverage: new Set(entries.filter(([, state]) => state === states.node || state === states.line).map(([point]) => point)) }];
  }));
}
function freshMetrics(players) {
  return Object.fromEntries(players.map(player => [player, {
    nodes_lost_on_opponent_actions: 0, coverage_lost_on_opponent_actions: 0, damaging_opponent_actions: 0,
    repeated_damage_by_same_opponent_beyond_first: 0, maximum_damage_streak_by_same_opponent: 0,
    opponent_damage_streaks: {}, enemy_nodes_captured: 0, attacking_nodes_ever: [], live_attacking_nodes: [],
    maximum_retained_root_connected_attacking_nodes: 0, final_retained_root_connected_attacking_nodes: 0,
    decisions: 0, voluntary_passes: 0, decision_elapsed_ms_sum: 0, decision_elapsed_ms_max: 0,
  }]));
}
function connectedNodes(engine, player) {
  // Independent BFS over intact explicit edges, checking every intervening
  // cell ourselves. Adjacency or a colored convex hull never grants connection.
  const own = engine._getPlayerStates(player), root = pointKey(engine.initialPositions[player]);
  if (engine.grid.get(root) !== own.node) return new Set();
  const graph = new Map();
  for (const edge of [...engine.edges[player]]) {
    const [a, b] = edge.split("|"), [x, y] = a.split(",").map(Number), [xx, yy] = b.split(",").map(Number);
    const dx = xx - x, dy = yy - y, steps = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dx + dy));
    assert.ok(steps > 0 && (dx === 0 || dy === 0 || dx === -dy));
    let intact = true;
    for (let i = 0; i <= steps; i++) {
      const state = engine.grid.get(`${x + dx * i / steps},${y + dy * i / steps}`);
      if (state !== own.node && state !== own.line) intact = false;
    }
    // The original metric reader canonicalizes broken edges. Mirror that
    // state maintenance independently before comparing the final full hash.
    if (!intact) { engine.edges[player].delete(edge); continue; }
    if (!graph.has(a)) graph.set(a, []); if (!graph.has(b)) graph.set(b, []);
    graph.get(a).push(b); graph.get(b).push(a);
  }
  const reached = new Set([root]), queue = [root];
  for (let i = 0; i < queue.length; i++) for (const next of graph.get(queue[i]) ?? [])
    if (!reached.has(next)) { reached.add(next); queue.push(next); }
  return reached;
}
function updateMetrics(engine, action, before, metrics, hadLegalPlacement) {
  const after = pieceSets(engine), actor = action.actor, row = metrics[actor];
  assert.ok(Number.isFinite(action.elapsed_ms) && action.elapsed_ms >= 0);
  row.decisions++; row.voluntary_passes += Number(action.point === null && hadLegalPlacement);
  row.decision_elapsed_ms_sum += action.elapsed_ms; row.decision_elapsed_ms_max = Math.max(row.decision_elapsed_ms_max, action.elapsed_ms);
  let captured = 0;
  for (const victim of engine.activePlayers) if (victim !== actor) {
    const lostNodes = [...before[victim].nodes].filter(point => !after[victim].nodes.has(point)).length;
    const lostCoverage = [...before[victim].coverage].filter(point => !after[victim].coverage.has(point)).length;
    const v = metrics[victim]; v.nodes_lost_on_opponent_actions += lostNodes; v.coverage_lost_on_opponent_actions += lostCoverage;
    v.damaging_opponent_actions += Number(lostNodes > 0); captured += lostNodes;
    const streak = lostNodes > 0 ? (v.opponent_damage_streaks[actor] ?? 0) + 1 : 0;
    v.opponent_damage_streaks[actor] = streak; v.repeated_damage_by_same_opponent_beyond_first += Number(streak >= 2);
    v.maximum_damage_streak_by_same_opponent = Math.max(v.maximum_damage_streak_by_same_opponent, streak);
  }
  row.enemy_nodes_captured += captured;
  if (captured > 0 && action.point !== null) {
    const key = pointKey(action.point);
    if (!row.attacking_nodes_ever.includes(key)) row.attacking_nodes_ever.push(key);
    if (!row.live_attacking_nodes.includes(key)) row.live_attacking_nodes.push(key);
  }
  for (const player of engine.activePlayers) {
    const connected = connectedNodes(engine, player), p = metrics[player], node = engine._getPlayerStates(player).node;
    p.live_attacking_nodes = p.live_attacking_nodes.filter(point => engine.grid.get(point) === node);
    p.final_retained_root_connected_attacking_nodes = p.live_attacking_nodes.filter(point => connected.has(point)).length;
    p.maximum_retained_root_connected_attacking_nodes = Math.max(p.maximum_retained_root_connected_attacking_nodes, p.final_retained_root_connected_attacking_nodes);
  }
}
function outcome(engine) {
  GameEngine.prototype._updateTerritories.call(engine);
  const scores = Object.fromEntries(engine.activePlayers.map(player => [player, engine.cachedTerritories[player].area]));
  assert.ok(Object.values(scores).every(value => Number.isInteger(value) && value >= 0));
  if (!engine.gameOver) return { terminal: false, scores, leaders: null, shares: null };
  const alive = engine.activePlayers.filter(player => !engine.resignedPlayers.has(player));
  const maximum = Math.max(...alive.map(player => scores[player])), leaders = alive.filter(player => scores[player] === maximum);
  return { terminal: true, scores, leaders, shares: Object.fromEntries(engine.activePlayers.map(player => [player, leaders.includes(player) ? 1 / leaders.length : 0])) };
}
function candidateAction(engine, weights) {
  const legal = engine.getLegalMoves().map(move => pointKey(move.point)).sort();
  const candidates = fastPolicyCandidates(engine);
  assert.deepEqual(candidates.map(move => pointKey(move.point)).sort(), legal);
  const actions = [...candidates.map(move => ({ point: move.point,
    logit: move.features.reduce((sum, feature, i) => sum + feature * weights[i], 0) })), { point: null, logit: weights[16] }];
  actions.sort((a, b) => b.logit - a.logit || (a.point === null ? b.point === null ? 0 : 1 : b.point === null ? -1 : a.point[1] - b.point[1] || a.point[0] - b.point[0]));
  return actions[0].point;
}
const metricFields = ["nodes_lost_on_opponent_actions", "coverage_lost_on_opponent_actions", "damaging_opponent_actions",
  "repeated_damage_by_same_opponent_beyond_first", "maximum_damage_streak_by_same_opponent", "enemy_nodes_captured",
  "maximum_retained_root_connected_attacking_nodes", "final_retained_root_connected_attacking_nodes", "voluntary_passes"];

export async function verifyArenaResults(base, protocolPath) {
  const protocolBytes = await readFile(protocolPath), protocol = JSON.parse(protocolBytes);
  assert.equal(protocol.schema, "lifeline-defensive-actual-parent-arena-protocol-v2");
  const dataRoot = resolve(base, "application-train-r1/data"), data = await loadDefensiveDataset(dataRoot);
  const trainingStates = new Set(data.samples.filter(row => row.split === "train").map(row => row.sourceStateHash));
  const validationStates = new Set(data.samples.filter(row => row.split === "validation").map(row => row.sourceStateHash));
  const contexts = [], globalSources = {}, globalOpeningHashes = new Set();
  let totalActions = 0, totalCandidateChecks = 0, totalNatural = 0, totalGames = 0;
  for (const preset of protocol.parents) {
    const alias = preset.parent, run = resolve(base, `arena-${alias}-r1`), identity = await readSealed(resolve(run, "identity.json"));
    const checkpoint = await readSealed(resolve(run, "checkpoint.json")), report = await readSealed(resolve(run, "report.json"));
    const progress = await read(resolve(run, "progress.json")), supervisor = await readSealed(resolve(run, "supervisor-state.json"));
    const config = identity.config, id = sha(JSON.stringify(identity));
    assert.equal(config.parent, alias); assert.equal(config.playerCount, preset.player_count); assert.equal(config.gridSize, preset.grid_size);
    assert.equal(config.rulesVersion, protocol.rules_version); assert.equal(config.openingPlies, protocol.opening_plies);
    assert.equal(config.maxGamePlies, protocol.max_game_plies); assert.equal(config.seedNamespace, protocol.seed_namespace);
    assert.deepEqual(config.seeds, protocol.seeds); assert.equal(identity.protocol_sha256, sha(protocolBytes));
    for (const body of [checkpoint, progress, report]) assert.equal(body.identity, id);
    assert.equal(progress.status, "COMPLETE"); assert.equal(supervisor.status, "COMPLETE");
    assert.equal(supervisor.worker_identity, id); assert.equal(supervisor.progress_units, checkpoint.units);
    assert.equal(checkpoint.active, null); assert.equal(checkpoint.completed.length, preset.planned_games);
    assert.equal(checkpoint.units, checkpoint.committed_plies + checkpoint.completed.length);
    for (const [path, expected] of Object.entries(identity.source_hashes)) {
      assert.equal(sha(await readFile(resolve(ROOT, path))), expected, `Frozen arena source changed: ${path}`);
      if (globalSources[path]) assert.equal(globalSources[path], expected); globalSources[path] = expected;
    }
    assert.deepEqual(report.source_hashes, identity.source_hashes);
    const jobPath = resolve(run, "job.json"), jobBytes = await readFile(jobPath), job = JSON.parse(jobBytes);
    const jobHashes = {};
    for (const path of [resolve(ROOT, "web/tools/supervise-three-player-job.mjs"), ...job.identity_files.map(path => resolve(job.cwd, path))])
      jobHashes[path] = sha(await readFile(path));
    assert.equal(supervisor.identity, sha(JSON.stringify({ raw_job_sha256: sha(jobBytes), identity_files: jobHashes })));
    const arg = flag => job.command[job.command.indexOf(flag) + 1];
    assert.equal(resolve(arg("--protocol")), resolve(protocolPath));
    assert.equal(resolve(arg("--data-root")), dataRoot); assert.equal(resolve(arg("--run-root")), run);
    assert.equal(resolve(job.command[1]), resolve(ROOT, "web/tools/arena-defensive-warmstart-v2.mjs"));
    const candidatePath = resolve(base, "application-train-r1/models", alias, "candidate.json"), candidateBytes = await readFile(candidatePath);
    assert.equal(resolve(arg("--candidate")), candidatePath); assert.equal(sha(candidateBytes), identity.candidate_sha256);
    const candidate = unseal(JSON.parse(candidateBytes));
    assert.equal(candidate.training.updates, protocol.candidate_updates); assert.equal(candidate.passBias, candidate.weights[16]);
    assert.equal(candidate.training.dataset_manifest_sha256, data.manifestHash); assert.equal(identity.dataset_manifest_sha256, data.manifestHash);
    assert.equal(candidate.strength_verified, false); assert.equal(candidate.runtime_admitted, false);
    assert.equal(candidate.lineage.parent_id, identity.parent_id); assert.equal(candidate.lineage.parent_sha256, identity.parent_sha256);
    const parentBytes = await readFile(resolve(ROOT, candidate.lineage.parent_path)); assert.equal(sha(parentBytes), identity.parent_sha256);
    const parentFile = JSON.parse(parentBytes), parent = alias === "easy" ? parentFile.models.find(row => row.id === identity.parent_id) : parentFile;
    assert.equal(parent.id, identity.parent_id); assert.deepEqual(parent.weights, candidate.lineage.parent_weights);
    assert.deepEqual([...parent.weights.map(value => value / parent.temperature), 0], candidate.lineage.initial_weights);
    assert.deepEqual(report.candidate_initialization, candidate.lineage);
    assert.equal(report.candidate_sha256, identity.candidate_sha256); assert.equal(report.parent_id, identity.parent_id);
    assert.equal(report.parent_alias, alias); assert.equal(report.strength_verified, false); assert.equal(report.runtime_admitted, false);
    const openings = new Map(), openingDiagnostics = [], expectedPlans = [];
    for (const seed of config.seeds) {
      const opening = newOpening(config, seed), engine = engineFromTrainingState(opening.state), hash = snapshotHash(engine);
      openings.set(seed, opening); globalOpeningHashes.add(hash);
      assert.equal(trainingStates.has(hash) || validationStates.has(hash), false, "Arena started on a known training/validation source state");
      openingDiagnostics.push({ seed, actor: engine.currentPlayer, legal_placements_for_current_actor: engine.getLegalMoves().length,
        nodes: Object.fromEntries(engine.activePlayers.map(player => [player, pieceSets(engine)[player].nodes.size])),
        empty_cells: [...engine.grid.values()].filter(state => state === 0).length, point_count: engine.validPositions.length,
        opening_sha256: hash });
      expectedPlans.push({ id: `seed-${seed}-baseline`, seed, arm: "parent", focal: null, opening_hash: hash });
      for (const player of engine.activePlayers) expectedPlans.push({ id: `seed-${seed}-seat-${player}`, seed, arm: "candidate", focal: player, opening_hash: hash });
    }
    assert.deepEqual(identity.plan, expectedPlans);
    const receipts = [], pathMatches = [], lengths = [], matchingTraining = new Set(), matchingValidation = new Set();
    let actionCount = 0, candidateChecks = 0;
    for (const [index, record] of checkpoint.completed.entries()) {
      const plan = expectedPlans[index]; assert.equal(record.id, plan.id); assert.equal(record.path, `games/${plan.id}.json`);
      const bytes = await readFile(resolve(run, record.path)); assert.equal(sha(bytes), record.sha256);
      const receipt = unseal(JSON.parse(bytes)); assert.equal(receipt.id, plan.id); assert.equal(receipt.identity, id);
      assert.equal(receipt.seed, plan.seed); assert.equal(receipt.arm, plan.arm); assert.equal(receipt.focal_player, plan.focal);
      assert.equal(receipt.initial_state_sha256, plan.opening_hash); assert.deepEqual(receipt.opening_actions, openings.get(plan.seed).actions);
      const engine = engineFromTrainingState(openings.get(plan.seed).state), metrics = freshMetrics(engine.activePlayers);
      for (const action of receipt.actions) {
        assert.equal(engine.gameOver, false, "Receipt continued after a natural terminal");
        assert.equal(action.actor, engine.currentPlayer, "Receipt assigned a turn to the wrong player");
        const stateHash = snapshotHash(engine);
        if (trainingStates.has(stateHash)) matchingTraining.add(stateHash);
        if (validationStates.has(stateHash)) matchingValidation.add(stateHash);
        const before = pieceSets(engine), legal = engine.getLegalMoves(), hadLegalPlacement = legal.length > 0;
        assert.ok(action.point === null || legal.some(move => pointKey(move.point) === pointKey(action.point)));
        if (plan.arm === "candidate" && action.actor === plan.focal) {
          assert.deepEqual(action.point, candidateAction(engine, candidate.weights), "Recorded focal candidate action differs from its preserved linear17/PASS policy"); candidateChecks++;
        }
        assert.equal((action.point === null ? engine.skipTurn() : engine.playMove(action.point)).success, true);
        updateMetrics(engine, action, before, metrics, hadLegalPlacement); actionCount++;
      }
      const nativeOutcome = outcome(engine);
      assert.deepEqual(nativeOutcome, receipt.outcome, "Recorded final area/winner differs from canonical discrete scoring");
      assert.deepEqual(metrics, receipt.metrics, "Recorded cuts, losses, connected attacks or counters differ from independent per-action calculation");
      assert.equal(snapshotHash(engine), receipt.final_state_sha256, "Final full-state/history/edge hash differs");
      assert.equal(receipt.status, nativeOutcome.terminal ? "COMPLETE_NATURAL_TERMINAL" : "TRUNCATED_NOT_COUNTED_AS_WIN_LOSS");
      assert.ok(nativeOutcome.terminal || receipt.actions.length === config.maxGamePlies);
      assert.ok(receipt.actions.length <= config.maxGamePlies); receipts.push(receipt); lengths.push(receipt.actions.length);
    }
    assert.equal(actionCount, checkpoint.committed_plies); assert.equal(progress.committed_plies, actionCount);
    const pairs = [];
    for (const receipt of receipts) if (receipt.arm === "candidate") {
      const baseline = receipts.find(row => row.seed === receipt.seed && row.arm === "parent");
      pathMatches.push({ seed: receipt.seed, focal: receipt.focal_player,
        same_actions_as_control: JSON.stringify(receipt.actions.map(({ actor, point }) => ({ actor, point }))) === JSON.stringify(baseline.actions.map(({ actor, point }) => ({ actor, point }))) });
      if (receipt.outcome.terminal && baseline.outcome.terminal) pairs.push({ seed: receipt.seed, focal: receipt.focal_player,
        candidate_share: receipt.outcome.shares[receipt.focal_player], parent_share: baseline.outcome.shares[receipt.focal_player],
        candidate_metrics: receipt.metrics[receipt.focal_player], parent_metrics: baseline.metrics[receipt.focal_player] });
    }
    const natural = receipts.filter(row => row.outcome.terminal).length, truncated = receipts.length - natural;
    const candidateMean = mean(pairs.map(row => row.candidate_share)), parentMean = mean(pairs.map(row => row.parent_share));
    const delta = mean(pairs.map(row => row.candidate_share - row.parent_share));
    assert.equal(report.complete_game_receipts, receipts.length); assert.equal(report.planned_game_receipts, preset.planned_games);
    assert.equal(report.natural_terminal_games, natural); assert.equal(report.truncated_games, truncated);
    assert.equal(report.matched_focal_comparisons, pairs.length); assert.equal(report.mean_candidate_win_share, candidateMean);
    assert.equal(report.mean_parent_win_share, parentMean); assert.equal(report.mean_win_share_delta, delta);
    const metricMean = name => Object.fromEntries(metricFields.map(field => [field, mean(pairs.map(row => row[name][field]))]));
    const candidateMetricMean = metricMean("candidate_metrics"), parentMetricMean = metricMean("parent_metrics");
    assert.deepEqual(report.candidate_defense_attack_metrics, candidateMetricMean); assert.deepEqual(report.parent_defense_attack_metrics, parentMetricMean);
    for (const player of openings.values().next().value.state.activePlayers) {
      const rows = pairs.filter(row => row.focal === player);
      assert.equal(report.by_focal_seat[player].matched_seed_blocks, rows.length);
      assert.equal(report.by_focal_seat[player].mean_win_share_delta, mean(rows.map(row => row.candidate_share - row.parent_share)));
    }
    const completedBlocks = config.seeds.filter(seed => receipts.filter(row => row.seed === seed).length === config.playerCount + 1).length;
    const naturalBlocks = config.seeds.filter(seed => receipts.filter(row => row.seed === seed && row.outcome.terminal).length === config.playerCount + 1).length;
    assert.equal(report.completed_seed_blocks, completedBlocks); assert.equal(report.completed_natural_seed_blocks, naturalBlocks);
    const perSeed = config.seeds.map(seed => {
      const rows = pairs.filter(row => row.seed === seed);
      return { seed, matched_seats: rows.length, mean_win_share_delta: mean(rows.map(row => row.candidate_share - row.parent_share)) };
    });
    contexts.push({ parent: alias, context: report.context, run_identity: id, candidate_sha256: identity.candidate_sha256,
      parent_id: identity.parent_id, parent_sha256: identity.parent_sha256, report_sha256: sha(await readFile(resolve(run, "report.json"))),
      game_index_sha256: sha(JSON.stringify(checkpoint.completed)), natural_games: natural, truncated_games: truncated,
      independent_seed_blocks: config.seeds.length, matched_focal_comparisons: pairs.length, candidate_policy_decisions_recomputed: candidateChecks,
      mean_candidate_win_share: candidateMean, mean_parent_win_share: parentMean, mean_win_share_delta: delta, per_seed: perSeed,
      candidate_metrics: candidateMetricMean, parent_metrics: parentMetricMean,
      evaluated_plies: { total: actionCount, minimum_per_game: Math.min(...lengths), maximum_per_game: Math.max(...lengths), mean_per_game: mean(lengths) },
      identical_candidate_control_trajectories: pathMatches.filter(row => row.same_actions_as_control).length,
      opening_diagnostics: openingDiagnostics, known_train_states_encountered: matchingTraining.size, known_validation_states_encountered: matchingValidation.size,
      training_context_source_positions: Object.fromEntries(["train", "validation"].map(split => [split,
        data.samples.filter(row => row.split === split && row.sourceState.playerCount === config.playerCount
          && row.sourceState.boardShape === config.boardShape && row.sourceState.gridSize === config.gridSize).length])),
      supervisor: { attempts: supervisor.attempts, abnormal_exits: supervisor.abnormal_exits, no_progress_exits: supervisor.no_progress_exits, status: supervisor.status },
      strength_verified: false, runtime_admitted: false });
    totalActions += actionCount; totalGames += receipts.length; totalNatural += natural; totalCandidateChecks += candidateChecks;
  }
  assert.equal(totalGames, protocol.planned_games_total);
  return { schema: "lifeline-defensive-warmstart-arena-independent-verification-v2", status: "PASS_REPLAY_METRICS_AND_AGGREGATES_ONLY",
    protocol_sha256: sha(protocolBytes), verifier_sha256: sha(await readFile(SELF)), source_hashes: globalSources,
    dataset_manifest_sha256: data.manifestHash, planned_games: protocol.planned_games_total, verified_game_receipts: totalGames,
    natural_terminal_games: totalNatural, truncated_games: totalGames - totalNatural, replayed_evaluated_actions: totalActions,
    replayed_opening_actions: totalGames * protocol.opening_plies, recomputed_candidate_decisions: totalCandidateChecks,
    distinct_opening_full_states_across_contexts: globalOpeningHashes.size, contexts,
    parent_policy_decisions_rerun: false,
    verified_scope: ["source/protocol/candidate/parent/supervisor identities", "all seats and shared controls",
      "canonical full-state action replay", "native discrete area and natural terminal", "candidate17/PASS action choices",
      "independent edge-BFS/cut-loss/connection metric arithmetic", "aggregate denominators and paired means"],
    limitations: ["Only two seed blocks per context; shared controls and seat rotations are correlated, not independent games.",
      "Easy and three-v4 share the same two opening states. No broad statistical strength or promotion result.",
      "Four random opening actions leave the small three-player boards close to natural termination; diagnostic lengths are reported.",
      "Timed parent runtime decisions were not rerun; their route and complete frozen source/model identities were checked. Parent decision timing is recorded evidence, not an independently reproduced latency test.",
      "Hex four-player size-5 training/validation coverage is absent in the parent continuation dataset; this arena is an extrapolation trial.",
      "Hex win-share improvement in this tiny pilot coexists with higher average node and coverage loss; repeated-cut protection did not improve.",
      "Hard, Ultimate, multiple candidate seats, five/six-player arenas, other sizes, browser/phone acceptance and model publication remain outside scope."],
    strength_verified: false, runtime_admitted: false };
}
if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  const args = process.argv.slice(2), opt = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  try {
    const base = resolve(opt("--base-root", "local_artifacts/defensive-warmstart-v2"));
    const protocol = resolve(opt("--protocol", "web/tools/configs/defensive-actual-parent-arena-v2-20261025.json"));
    const result = await verifyArenaResults(base, protocol), output = opt("--output", null);
    if (output) { await mkdir(dirname(resolve(output)), { recursive: true }); await writeFile(resolve(output), `${JSON.stringify(result, null, 2)}\n`); }
    console.log(JSON.stringify({ status: result.status, games: result.verified_game_receipts, actions: result.replayed_evaluated_actions,
      candidate_decisions: result.recomputed_candidate_decisions, contexts: result.contexts.map(row => ({ parent: row.parent, natural: row.natural_games, delta: row.mean_win_share_delta })) }));
  } catch (error) { console.error(error.stack); process.exitCode = 78; }
}
