// Genuine terminal-only policy gradient. Minimax is eligibility analysis, never
// an environment reward. All nonterminal rewards are exactly zero; gamma=1.
import { mkdir, readFile, readdir, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GameEngine } from "../web前端/GameEngine.js";
import { serializeEngineState } from "../web前端/AIStateProtocol.js";
import { fastPolicyCandidates, isolatedSearchEngine } from "../web前端/MultiplayerSearch.js";
import { nativeDiscreteAreas, applyPassDiscipline } from "../web前端/AIPassDiscipline.js";
import { passOpportunityTrainingLabel, assertPassOpportunityLabel } from "../web前端/PassOpportunityTrainingTeacher.js";
import { engineFromTrainingState } from "./pass-opportunity-data-v3.mjs";
import { loadPassOpportunityParent, passOpportunityProbabilities } from "./train-pass-opportunity-v3.mjs";
import { atomic, lease, readJson, root, sealed, sha, unseal } from "./neural-posttraining-data-v2.mjs";

const check = (ok, message) => { if (!ok) throw new Error(message); };
const pointKey = p => p === null ? "PASS" : p.join(",");
const cellKey = cell => `${cell.players}p-${cell.shape}-${cell.size}`;
export const terminalLearnerSeatIndex = (episodeIndex, cellCount, playerCount) => Math.floor(episodeIndex / cellCount) % playerCount;
export const TERMINAL_REWARD = Object.freeze({ type: "terminal-outcome-native-margin-area-v1", gamma: 1,
  outcome: 1, margin: 0.1, own_area: 0.01, nonterminal_reward: 0,
  formula: "sign(A_i-maxOpponentArea)+0.1*(A_i-maxOpponentArea)/N+0.01*A_i/N" });
export const TERMINAL_V4_SOURCES = ["web/tools/train-terminal-policy-v4.mjs", "web/tools/train-pass-opportunity-v3.mjs",
  "web/tools/pass-opportunity-data-v3.mjs", "web/web前端/PassOpportunityTrainingTeacher.js", "web/web前端/AIPassDiscipline.js",
  "web/web前端/GameEngine.js", "web/web前端/AIStateProtocol.js", "web/web前端/AIEngine.js", "web/web前端/MultiplayerSearch.js",
  "web/web前端/MultiplayerNativeGeometry.js", "web/web前端/MultiplayerHardValue.js", "web/web前端/HexPlayerAI.js",
  "web/tools/neural-posttraining-data-v2.mjs"];
export function validateTerminalProtocol(config) {
  const validTurns = turns => Array.isArray(turns) && turns.length > 0
    && turns.length <= config.analysis.max_attempts_per_episode
    && turns.every((turn, i) => Number.isInteger(turn) && turn >= 0 && (i === 0 || turn > turns[i - 1]));
  check(config?.schema === "lifeline-terminal-policy-protocol-v4" && config.rules_version === "territory-v3"
    && Object.entries(TERMINAL_REWARD).every(([key, value]) => config.reward?.[key] === value), "Frozen terminal-only reward/gamma protocol mismatch");
  check(Array.isArray(config.parents) && config.parents.length > 0 && new Set(config.parents.map(p => p.alias)).size === config.parents.length
    && config.parents.every(p => ["easy", "three-v4", "three-v1", "hex-v1"].includes(p.alias) && Array.isArray(p.cells) && p.cells.length > 0
      && p.cells.every(c => Number.isInteger(c.players) && c.players >= 2 && c.players <= 6 && Number.isInteger(c.size)
        && c.size >= 5 && c.size <= 15 && ["triangle", "hexagon"].includes(c.shape))), "Invalid terminal model/cell protocol");
  check(Number.isInteger(config.episodes_per_parent) && config.episodes_per_parent > 0 && config.episodes_per_parent <= 1000
    && Number.isInteger(config.maximum_game_plies) && config.maximum_game_plies >= 8 && config.maximum_game_plies <= 2000
    && Number.isFinite(config.learning_rate) && config.learning_rate > 0 && config.learning_rate <= 1
    && Number.isFinite(config.gradient_clip) && config.gradient_clip > 0
    && Number.isInteger(config.minimum_actual_updates_per_parent) && config.minimum_actual_updates_per_parent >= 1
    && Number.isInteger(config.analysis?.max_attempts_per_episode) && config.analysis.max_attempts_per_episode > 0
    && config.analysis.action_mask === "lexicographic-defense-prefix-0-1-4"
    && validTurns(config.analysis.learner_turns)
    && Object.entries(config.analysis.learner_turns_by_cell ?? {}).every(([key, turns]) => /^\d+p-(triangle|hexagon)-\d+$/.test(key) && validTurns(turns))
    && Number.isInteger(config.analysis.max_nodes) && config.analysis.max_nodes > 0
    && Number.isFinite(config.analysis.time_ms) && config.analysis.time_ms > 0 && config.analysis.time_ms <= 30000,
  "Invalid terminal episode, optimizer or exact-analysis budget");
  return config;
}
export function terminalRewards(engine) {
  check(engine.gameOver, "Terminal reward requested before native game termination");
  const areas = nativeDiscreteAreas(engine), alive = engine.activePlayers.filter(p => !engine.resignedPlayers.has(p)), N = engine.validPositions.length;
  const details = Object.fromEntries(engine.activePlayers.map(player => {
    const maximumOpponent = Math.max(0, ...alive.filter(p => p !== player).map(p => areas[p]));
    const margin = areas[player] - maximumOpponent, outcome = engine.resignedPlayers.has(player) ? -1 : Math.sign(margin);
    return [player, { area: areas[player], maximumOpponentArea: maximumOpponent, margin, outcome,
      reward: outcome + 0.1 * margin / N + 0.01 * areas[player] / N }];
  }));
  return { N, areas, details, formula: TERMINAL_REWARD };
}
export async function terminalTrainingCoverage(runRoot, records) {
  const cells = {}, phaseCounts = { opening: 0, middle: 0, late: 0 }, samples = [];
  for (const record of records) {
    const episode = unseal(await readJson(resolve(runRoot, record.path)));
    const key = cellKey(episode.cell);
    const cell = cells[key] ??= { episodes: 0, natural_episodes: 0, truncated_episodes: 0,
      actual_updates: 0, analysis_attempts: 0, complete_analyses: 0, eligible_samples: 0,
      singleton_masks: 0, incomplete_analyses: 0, learners: {}, phases: { opening: 0, middle: 0, late: 0 } };
    cell.episodes++; cell.natural_episodes += Number(episode.naturalTerminal);
    cell.learners[episode.learner] = (cell.learners[episode.learner] ?? 0) + 1;
    cell.truncated_episodes += Number(episode.truncated); cell.actual_updates += Number(episode.modelUpdated);
    for (const step of episode.steps) {
      const row = unseal(await readJson(resolve(runRoot, step.path)));
      if (!row.analysis) continue;
      cell.analysis_attempts++; cell.complete_analyses += Number(!!row.analysis.label);
      cell.incomplete_analyses += Number(!row.analysis.label);
      cell.singleton_masks += Number(row.analysis.defenseMask?.indices.length === 1);
      if (!episode.naturalTerminal || !row.eligibleForPolicyGradient) continue;
      const fraction = row.ply / Math.max(1, episode.steps.length - 1);
      const phase = fraction < 1 / 3 ? "opening" : fraction < 2 / 3 ? "middle" : "late";
      cell.eligible_samples++; cell.phases[phase]++; phaseCounts[phase]++;
      samples.push({ episode: episode.id, cell: key, ply: row.ply,
        learner_turn: row.executionAfter.learnerTurns - 1, phase,
        completed_depth: row.analysis.search.completedDepth, actual_max_depth: row.analysis.search.maxReachedPly,
        mask_size: row.analysis.defenseMask.indices.length });
    }
  }
  return { phase_definition: "Realized native-game ply fraction: opening <1/3, middle <2/3, late remainder; does not imply strategic phase.",
    cells, eligible_phase_counts: phaseCounts, eligible_samples: samples,
    limitation: "Only completed selected-state analyses with non-singleton defensive masks contribute gradients; no claim of uniform state/configuration coverage." };
}
function actions(engine) {
  return [...fastPolicyCandidates(engine).map(move => ({ point: [...move.point], features: [...move.features, 0] })),
    { point: null, features: [...Array(16).fill(0), 1] }];
}
function rngNext(rng) { rng.state = (Math.imul(rng.state, 1664525) + 1013904223) >>> 0; return rng.state / 4294967296; }
const opponentAlias = cell => cell.players === 3 ? [5, 7, 9].includes(cell.size) ? "three-v4" : "three-v1"
  : cell.players >= 4 ? "hex-v1" : "easy";
function originalParentMove(engine, parent) {
  const legal = fastPolicyCandidates(engine), score = move => move.features.reduce((sum, x, i) => sum + x * parent.weights[i], 0) / parent.temperature;
  const ranked = legal.map(move => ({ point: move.point, type: "move", score: score(move) })).sort((a, b) => b.score - a.score || a.point[1] - b.point[1] || a.point[0] - b.point[0]);
  const alive = engine.activePlayers.filter(p => !engine.resignedPlayers.has(p));
  if (engine.consecutiveSkips === alive.length - 1 && ranked.length) {
    const trial = isolatedSearchEngine(engine); trial.skipTurn();
    if (trial.gameOver) {
      const r = terminalRewards(trial);
      if (r.details[engine.currentPlayer].outcome === 1) return applyPassDiscipline(engine,
        [{ point: null, type: "pass", score: 1 }], { timeMs: 200, maxNodes: 10000, topN: 1 }).moves[0]?.point ?? null;
    }
  }
  return ranked[0]?.point ?? null;
}
export function createTerminalPolicy(candidate) {
  check(candidate?.schema === "lifeline-terminal-policy-linear17-candidate-v4" && candidate.weights?.length === 17, "Invalid terminal candidate");
  return { getTopMoves(engine, player = engine.currentPlayer, topN = 5) {
    check(player === engine.currentPlayer, "Wrong candidate actor"); if (engine.gameOver) return [];
    const list = actions(engine), probabilities = passOpportunityProbabilities(list, candidate.weights);
    return list.map((a, i) => ({ point: a.point, type: a.point === null ? "pass" : "move", prior: probabilities[i],
      score: a.features.reduce((s, x, j) => s + x * candidate.weights[j], 0), visits: 1 })).sort((a, b) => b.score - a.score
        || (a.point === null ? b.point === null ? 0 : 1 : b.point === null ? -1 : a.point[1] - b.point[1] || a.point[0] - b.point[0])).slice(0, topN);
  } };
}
export async function terminalPolicyTrainMain(args) {
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  check(option("--run-root") && option("--config"), "Use --run-root DIRECTORY --config FROZEN_TERMINAL_CONFIG");
  const runRoot = resolve(option("--run-root")), configPath = resolve(option("--config"));
  const configBytes = await readFile(configPath), config = validateTerminalProtocol(JSON.parse(configBytes));
  const maxUnits = Number(option("--max-new-units", "8")), maxSeconds = Number(option("--max-seconds", "30"));
  check(Number.isInteger(maxUnits) && maxUnits >= 0 && Number.isFinite(maxSeconds) && maxSeconds > 0, "Invalid worker segment");
  const aliases = [...new Set([...config.parents.map(p => p.alias), ...config.parents.flatMap(p => p.cells.map(opponentAlias))])];
  const parents = Object.fromEntries(await Promise.all(aliases.map(async alias => [alias, await loadPassOpportunityParent(alias)])));
  const sources = Object.fromEntries(await Promise.all(TERMINAL_V4_SOURCES.map(async p => [p, sha(await readFile(resolve(root, p)))])));
  const identity = sha(JSON.stringify({ config: sha(configBytes), sources, parents, reward: TERMINAL_REWARD }));
  await mkdir(runRoot, { recursive: true }); const guard = await lease(runRoot); let cp, checkpointValidated = false;
  const save = async (status, extra = {}) => {
    if (checkpointValidated) await atomic(resolve(runRoot, "checkpoint.json"), sealed(cp));
    const prior = checkpointValidated ? null : await readJson(resolve(runRoot, "progress.json"), true);
    await atomic(resolve(runRoot, "progress.json"), { identity: checkpointValidated ? identity : prior?.identity ?? identity,
      status, progress_units: checkpointValidated ? cp.units : prior?.progress_units ?? 0,
      completed_episodes: checkpointValidated ? Object.values(cp.models).reduce((sum, m) => sum + m.completed.length, 0) : prior?.completed_episodes ?? 0,
      planned_episodes: config.parents.length * config.episodes_per_parent,
      model_updates: checkpointValidated ? Object.fromEntries(Object.entries(cp.models).map(([k, m]) => [k, m.actualUpdates])) : prior?.model_updates ?? {},
      active_episode: checkpointValidated ? cp.active?.id ?? null : prior?.active_episode ?? null,
      active_plies: checkpointValidated ? cp.active?.steps.length ?? 0 : prior?.active_plies ?? 0, ...extra });
  };
  try {
    // The supervisor writes its own atomic state in this directory concurrently.
    // Quarantine only abandoned files owned by this exclusive training worker.
    for (const name of await readdir(runRoot)) if (/^(checkpoint|progress)\.json\.\d+\.tmp$/.test(name)) {
      await rename(resolve(runRoot, name), resolve(runRoot, `${name}.interrupted-${Date.now()}`));
    }
    const old = await readJson(resolve(runRoot, "checkpoint.json"), true);
    cp = old ? unseal(old) : { schema: "lifeline-terminal-policy-checkpoint-v4", identity, units: 0, active: null,
      models: Object.fromEntries(config.parents.map(({ alias }) => [alias, { weights: [...parents[alias].initialWeights], baseline: 0,
        baselineCount: 0, actualUpdates: 0, optimizerSteps: 0, eligibleSamples: 0, completed: [] }])) };
    check(cp.schema === "lifeline-terminal-policy-checkpoint-v4" && cp.identity === identity, "Terminal checkpoint source/config/parent corruption");
    checkpointValidated = true;
    const checkInputs = async () => {
      check(sha(await readFile(configPath)) === sha(configBytes), "Terminal config drift");
      for (const [p, h] of Object.entries(sources)) check(sha(await readFile(resolve(root, p))) === h, `Terminal source drift ${p}`);
      for (const parent of Object.values(parents)) check(sha(await readFile(resolve(root, parent.path))) === parent.sha256, "Terminal parent drift");
    };
    await checkInputs();
    for (const model of Object.values(cp.models)) {
      check(model.weights?.length === 17 && model.weights.every(Number.isFinite) && model.completed.length <= config.episodes_per_parent, "Corrupt terminal model state");
      for (const record of model.completed) check(sha(await readFile(resolve(runRoot, record.path))) === record.sha256, "Completed terminal episode changed");
    }
    if (cp.active) for (const record of cp.active.steps) check(sha(await readFile(resolve(runRoot, record.path))) === record.sha256, "In-flight step receipt changed");
    const started = Date.now(), before = cp.units;
    const control = async () => {
      for (const [marker, status] of [["STOP", "STOPPED"], ["PAUSE", "PAUSED"]]) {
        try { await readFile(resolve(runRoot, marker)); await save(status); return true; } catch (e) { if (e.code !== "ENOENT") throw e; }
      }
      if (cp.units - before >= maxUnits || Date.now() - started >= maxSeconds * 1000) { await save("YIELDED"); return true; }
      await checkInputs(); return false;
    };
    for (const definition of config.parents) {
      const alias = definition.alias, model = cp.models[alias], parent = parents[alias];
      while (model.completed.length < config.episodes_per_parent) {
        if (await control()) return 75;
        if (!cp.active) {
          const index = model.completed.length, cell = definition.cells[index % definition.cells.length];
          const engine = new GameEngine({ playerCount: cell.players, gridSize: cell.size, boardShape: cell.shape, rulesVersion: "territory-v3", deferTerritoryUpdates: true });
          engine._isReplayingBatch = true;
          const learner = engine.activePlayers[terminalLearnerSeatIndex(index, definition.cells.length, engine.activePlayers.length)], id = `${alias}-seed${index}`;
          cp.active = { alias, id, index, cell, learner, initialState: serializeEngineState(engine), state: serializeEngineState(engine),
            rng: { state: parseInt(sha(`${config.seed_namespace}/${alias}/${index}`).slice(0, 8), 16) >>> 0 },
            steps: [], learnerTurns: 0, analysisAttempts: 0, eligibleSteps: [], modelWeights: [...model.weights] };
          await save("RUNNING");
        }
        const active = cp.active; check(active.alias === alias && JSON.stringify(active.modelWeights) === JSON.stringify(model.weights), "Active episode/model identity mismatch");
        const engine = engineFromTrainingState(active.state);
        while (!engine.gameOver && active.steps.length < config.maximum_game_plies) {
          if (await control()) return 75;
          const actor = engine.currentPlayer, list = actions(engine), sourceState = serializeEngineState(engine);
          const ply = active.steps.length, path = `episodes/${active.id}/steps/${ply}.json`;
          const unindexed = await readJson(resolve(runRoot, path), true);
          if (unindexed) {
            const row = unseal(unindexed);
            check(row.identity === identity && row.episodeId === active.id && row.ply === ply && row.actor === actor
              && row.beforeStateHash === sha(JSON.stringify(sourceState)) && row.executionAfter, "Unindexed step source identity corruption");
            if (row.eligibleForPolicyGradient) assertPassOpportunityLabel(row.analysis.label);
            const outcome = row.point === null ? engine.skipTurn() : engine.playMove(row.point);
            check(outcome.success && row.afterStateHash === sha(JSON.stringify(serializeEngineState(engine))), "Unindexed step transition corruption");
            active.rng = row.executionAfter.rng; active.learnerTurns = row.executionAfter.learnerTurns;
            active.analysisAttempts = row.executionAfter.analysisAttempts;
            active.steps.push({ path, sha256: sha(await readFile(resolve(runRoot, path))) });
            if (row.eligibleForPolicyGradient) active.eligibleSteps.push(ply);
            active.state = serializeEngineState(engine); cp.units++; await save("RUNNING");
            continue;
          }
          let selected, eligible = false, analysis = null, probs = null;
          if (actor === active.learner) {
            let maskIndices = list.map((_, i) => i);
            if (active.analysisAttempts < config.analysis.max_attempts_per_episode
              && (config.analysis.learner_turns_by_cell?.[cellKey(active.cell)] ?? config.analysis.learner_turns).includes(active.learnerTurns)) {
              active.analysisAttempts++;
              const result = passOpportunityTrainingLabel(engine, { maxNodes: config.analysis.max_nodes,
                timeMs: config.analysis.time_ms, annotatePassOpportunity: false });
              analysis = { status: result.status, search: result.search, sourceState, sourceStateHash: sha(JSON.stringify(sourceState)),
                label: result.label, usage: "Eligibility/context only. No leaf value or target is an environment reward." };
              if (result.label) {
                assertPassOpportunityLabel(result.label);
                const prefix = move => [move.value[0], move.value[1], move.value[4]];
                const compare = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
                const best = result.label.moves.reduce((current, move) => compare(prefix(move), current) > 0 ? prefix(move) : current,
                  prefix(result.label.moves[0]));
                const allowed = new Set(result.label.moves.filter(move => compare(prefix(move), best) === 0).map(move => pointKey(move.point)));
                maskIndices = list.map((move, i) => allowed.has(pointKey(move.point)) ? i : -1).filter(i => i >= 0);
                check(maskIndices.length > 0, "Full minimax defensive prefix produced an empty action mask");
                analysis.defenseMask = { rule: config.analysis.action_mask, bestPrefix: best, indices: maskIndices,
                  actionKeys: maskIndices.map(i => pointKey(list[i].point)), dependsOnWeights: false,
                  usesNativeAreaOrMargin: false, allLegalRootValuesRetained: true };
                eligible = maskIndices.length >= 2;
              }
            }
            const masked = passOpportunityProbabilities(maskIndices.map(i => list[i]), model.weights);
            probs = Array(list.length).fill(0); maskIndices.forEach((index, i) => { probs[index] = masked[i]; });
            const u = rngNext(active.rng); let cumulative = 0;
            selected = probs.findIndex(p => { cumulative += p; return u < cumulative; });
            if (selected < 0) selected = maskIndices.at(-1);
            active.learnerTurns++;
          } else {
            const point = originalParentMove(engine, parents[opponentAlias(active.cell)]);
            selected = list.findIndex(move => pointKey(move.point) === pointKey(point)); check(selected >= 0, "Opponent returned an illegal action");
          }
          const row = { schema: "lifeline-terminal-policy-step-v4", identity, episodeId: active.id, ply, actor,
            learner: active.learner, point: list[selected].point, beforeStateHash: sha(JSON.stringify(sourceState)),
            nonterminalReward: 0, reward: 0, eligibleForPolicyGradient: eligible,
            selectedIndex: selected, probabilities: probs, actions: actor === active.learner ? list : null, analysis,
            executionAfter: { rng: { ...active.rng }, learnerTurns: active.learnerTurns, analysisAttempts: active.analysisAttempts } };
          const result = row.point === null ? engine.skipTurn() : engine.playMove(row.point); check(result.success, "Illegal terminal training transition");
          row.naturalTerminalAfterAction = engine.gameOver;
          if (engine.gameOver) row.reward = terminalRewards(engine).details[active.learner].reward;
          row.rewardType = engine.gameOver ? TERMINAL_REWARD.type : "zero-nonterminal";
          row.afterStateHash = sha(JSON.stringify(serializeEngineState(engine)));
          const prior = await readJson(resolve(runRoot, path), true);
          if (prior) check(JSON.stringify(unseal(prior)) === JSON.stringify(row), "Unindexed step evidence disagrees with exact resume");
          else await atomic(resolve(runRoot, path), sealed(row));
          if (args.includes("--fault-after-step-write")) return 79;
          active.steps.push({ path, sha256: sha(await readFile(resolve(runRoot, path))) });
          if (eligible) active.eligibleSteps.push(ply);
          active.state = serializeEngineState(engine); cp.units++; await save("RUNNING");
          if (args.includes("--fault-after-step")) return 79;
        }
        const natural = engine.gameOver, terminal = natural ? terminalRewards(engine) : null;
        const reward = natural ? terminal.details[active.learner].reward : null, gradient = Array(17).fill(0);
        const eligibleRows = [];
        if (natural) for (const ply of active.eligibleSteps) {
          const row = unseal(await readJson(resolve(runRoot, active.steps[ply].path)));
          assertPassOpportunityLabel(row.analysis.label);
          const baseline = model.baseline, advantage = reward - baseline;
          const expected = Array(17).fill(0); row.actions.forEach((a, i) => a.features.forEach((x, j) => { expected[j] += row.probabilities[i] * x; }));
          row.actions[row.selectedIndex].features.forEach((x, j) => { gradient[j] += advantage * (x - expected[j]) / active.eligibleSteps.length; });
          eligibleRows.push({ ply, return: reward, gamma: 1, analysisCompletedDepth: row.analysis.search.completedDepth,
            analysisActualMaxDepth: row.analysis.search.maxReachedPly });
        }
        const previousWeights = [...model.weights], norm = Math.hypot(...gradient), scale = Math.min(1, config.gradient_clip / Math.max(1e-30, norm));
        let changed = false;
        if (natural && eligibleRows.length) {
          model.weights = model.weights.map((w, i) => w + config.learning_rate * gradient[i] * scale);
          check(model.weights.every(Number.isFinite), "Nonfinite terminal policy update");
          changed = model.weights.some((w, i) => w !== previousWeights[i]); model.actualUpdates += Number(changed); model.optimizerSteps++;
          model.eligibleSamples += eligibleRows.length; model.baseline += (reward - model.baseline) / (model.baselineCount + 1); model.baselineCount++;
        }
        const episodePath = `episodes/${active.id}/episode.json`;
        const episode = { schema: "lifeline-terminal-policy-episode-v4", identity, id: active.id, alias, cell: active.cell, learner: active.learner,
          initialState: active.initialState, finalState: active.state, steps: active.steps, naturalTerminal: natural, truncated: !natural,
          terminal, terminalReward: reward, gamma: 1, nonterminalRewardSum: 0,
          reward_sequence: active.steps.map((_, i) => natural && i === active.steps.length - 1 ? reward : 0),
          eligibleSamples: eligibleRows, contextOnlySteps: active.steps.length - eligibleRows.length,
          modelUpdated: changed, optimizerStepApplied: natural && eligibleRows.length > 0, gradientNorm: norm,
          baselineBefore: natural && eligibleRows.length ? (model.baselineCount === 1 ? 0 : (model.baseline * model.baselineCount - reward) / (model.baselineCount - 1)) : model.baseline,
          previousWeights, updatedWeights: model.weights, optimizer: { type: "SGD-REINFORCE", step: model.optimizerSteps,
            learningRate: config.learning_rate, gradientClip: config.gradient_clip },
          stateSelectionBias: "Only newly completed full-depth state analyses are gradient samples; other behavior steps are context only.",
          noIntermediateAreaReward: true, noDurationReward: true };
        const oldEpisode = await readJson(resolve(runRoot, episodePath), true);
        if (oldEpisode) check(JSON.stringify(unseal(oldEpisode)) === JSON.stringify(episode), "Unindexed terminal episode/update evidence corruption");
        else await atomic(resolve(runRoot, episodePath), sealed(episode));
        if (args.includes("--fault-after-episode-write")) return 79;
        model.completed.push({ id: active.id, path: episodePath, sha256: sha(await readFile(resolve(runRoot, episodePath))),
          naturalTerminal: natural, modelUpdated: changed, eligibleSamples: eligibleRows.length });
        cp.active = null; cp.units++; await save("RUNNING");
        if (args.includes("--fault-after-episode")) return 79;
      }
      check(model.actualUpdates >= config.minimum_actual_updates_per_parent, `No sufficient actual parameter updates for ${alias}; do not call context-only games trained`);
      check(model.completed.every(record => record.naturalTerminal), `Truncated games for ${alias}; required natural-game training is incomplete`);
      const runtimeSpec = { schema: { name: "lifeline-pass-opportunity-policy", version: 3 }, id: `terminal-policy-${alias}-v4`,
        parent_id: parent.id, parent_sha256: parent.sha256, features: parent.features.slice(0, 16), weights: model.weights.slice(0, 16),
        passBias: model.weights[16], temperature: 1, rules_version: "territory-v3" };
      const coverage = await terminalTrainingCoverage(runRoot, model.completed);
      await atomic(resolve(runRoot, "models", alias, "candidate.json"), sealed({ schema: "lifeline-terminal-policy-linear17-candidate-v4", identity,
        parent_alias: alias, weights: model.weights, passBias: model.weights[16], temperature: 1, runtime_spec: runtimeSpec,
        lineage: { type: "weights-only-warm-start", parent_id: parent.id, parent_path: parent.path, parent_sha256: parent.sha256,
          initial_weights: parent.initialWeights, optimizer_reset: true },
        training: { recipe: config, reward: TERMINAL_REWARD, episodes: model.completed.length, naturally_completed_episodes: model.completed.filter(e => e.naturalTerminal).length,
          truncated_episodes: model.completed.filter(e => !e.naturalTerminal).length, actual_parameter_updates: model.actualUpdates,
          optimizer_steps: model.optimizerSteps, eligible_minimax_samples: model.eligibleSamples, gamma: 1,
          source_hashes: sources, config_sha256: sha(configBytes), state_selection_bias: true, coverage },
        status: "TERMINAL_POLICY_TRAINED_NOT_ADMITTED", strength_verified: false, runtime_admitted: false }));
    }
    await checkInputs();
    await atomic(resolve(runRoot, "completion-receipt.json"), sealed({ schema: "lifeline-terminal-policy-completion-v4", identity,
      status: "TERMINAL_TRAINING_COMPLETE_NOT_ADMITTED", gamma: 1, reward: TERMINAL_REWARD,
      models: Object.fromEntries(await Promise.all(config.parents.map(async ({ alias }) => [alias, {
        candidate_sha256: sha(await readFile(resolve(runRoot, "models", alias, "candidate.json"))),
        episodes: cp.models[alias].completed.length, actual_parameter_updates: cp.models[alias].actualUpdates,
        eligible_minimax_samples: cp.models[alias].eligibleSamples,
        coverage: await terminalTrainingCoverage(runRoot, cp.models[alias].completed) }]))),
      source_hashes: sources, config_sha256: sha(configBytes), strength_verified: false, runtime_admitted: false }));
    await save("COMPLETE"); return 0;
  } catch (error) { await save("FATAL", { error: error.message }); throw error; }
  finally { await new Promise(done => guard.close(done)); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await terminalPolicyTrainMain(process.argv.slice(2)); }
  catch (error) { console.error(error.stack); process.exitCode = error.code === "EADDRINUSE" ? 76 : 78; }
}
