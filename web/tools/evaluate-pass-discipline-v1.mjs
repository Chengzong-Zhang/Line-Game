// Task-scoped acceptance: actual Worker routing, independent reply certificates,
// fresh-layout paired games, and durable per-action recovery. No global ranking.
import { readFile, readdir, mkdir, rename, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GameEngine, PLAYER_ORDER } from '../web前端/GameEngine.js';
import { serializeEngineState } from '../web前端/AIStateProtocol.js';
import { saveState, restoreState } from '../web前端/AIEngine.js';
import { fastPolicyCandidates } from '../web前端/MultiplayerSearch.js';
import { ThreePlayerSearchAI } from '../web前端/ThreePlayerSearchAI.js';
import { FastMultiplayerPolicy } from '../web前端/MultiplayerRuntime.js';
import { engineFromTrainingState } from './defensive-training-data-v1.mjs';
import { passCompositeReferences } from './pass-discipline-composite-input-v5.mjs';
import { atomic, lease, readJson, root, sealed, unseal, sha } from './neural-posttraining-data-v2.mjs';

const check = (value, message) => { if (!value) throw Error(message); };
const pointKey = p => p === null ? 'PASS' : p.join(',');
const workerHandlers = new Map();
const profiles = { easy: { strategy: 'multiplayer', modelId: 'multiplayer-easy-v1' },
  'three-v4': { strategy: 'multiplayer', modelId: 'multiplayer-medium-v1' },
  'three-v1': { strategy: 'multiplayer', modelId: 'multiplayer-medium-v1' },
  'hex-v1': { strategy: 'multiplayer', modelId: 'multiplayer-medium-v1' } };
function nativeArea(engine, player) {
  if (engine.rulesVersion !== 'territory-v3') return GameEngine.prototype._computeTerritory.call(engine, player).area;
  const own = [...engine._getPlayerNodes(player), ...engine._getPlayerLines(player)];
  const enemies = engine._getOpponents(player).flatMap(other => [...engine._getPlayerNodes(other), ...engine._getPlayerLines(other)]);
  return GameEngine.prototype._computeOwnedWallArea.call(engine, own, enemies);
}
function pieces(engine, player) {
  return { nodes: new Set(engine._getPlayerNodes(player).map(pointKey)),
    coverage: new Set([...engine._getPlayerNodes(player), ...engine._getPlayerLines(player)].map(pointKey)) };
}
const contains = (reference, present) => [...reference].every(value => present.has(value));

// This is deliberately separate from AIPassDiscipline. It replays canonical
// transitions and recomputes exact discrete area on every actual next reply.
export function certifyIndependentExpansion(source, { points = null, maxRoots = 12,
  maxNodes = 30000, timeMs = 1000, fullOpponentRound = true, allowStructuralProof = true, now = () => performance.now() } = {}) {
  const player = source.currentPlayer, started = now(), engine = engineFromTrainingState(serializeEngineState(source));
  if (engine.gameOver) return { status: 'terminal', witness: null, complete: true, probes: 0 };
  const legal = engine.getLegalMoves(player), before = nativeArea(engine, player), original = pieces(engine, player);
  if (!legal.length) return { status: 'forced-pass', witness: null, complete: true, probes: 0 };
  const start = engine.initialPositions[player];
  const ordered = points ? points.map(point => legal.find(move => pointKey(move.point) === pointKey(point))).filter(Boolean)
    : [...legal].sort((a, b) => Math.abs(a.point[0] - start[0]) + Math.abs(a.point[1] - start[1])
      - Math.abs(b.point[0] - start[0]) - Math.abs(b.point[1] - start[1]) || a.point[1] - b.point[1] || a.point[0] - b.point[0]);
  const base = saveState(engine); let probes = 0, roots = 0;
  const budget = () => now() - started < timeMs && probes < maxNodes;
  for (const move of ordered.slice(0, maxRoots)) {
    if (!budget()) return { status: 'incomplete', witness: null, complete: false, probes, roots };
    restoreState(engine, base); roots++; probes++;
    check(engine.playMove(move.point).success, 'Independent oracle root became illegal');
    const afterRoot = nativeArea(engine, player), expanded = pieces(engine, player), responder = engine.currentPlayer;
    if (afterRoot <= before || !contains(original.nodes, expanded.nodes) || !contains(original.coverage, expanded.coverage)) continue;
    let minimum = afterRoot, checked = 0, counterexample = null, interrupted = false;
    const rootInitial = engine.initialPositions[player], protectedKeys = new Set(engine.getAdjacentPositions(rootInitial).map(pointKey));
    const structural = allowStructuralProof && [...expanded.coverage].filter(k => !expanded.nodes.has(k)).every(k => protectedKeys.has(k))
      && [...expanded.nodes].every(k => engine._getOpponentConnectedPieces(player).has(k))
      && expanded.coverage.size > before;
    const visit = (seen, path) => {
      if (!budget()) { interrupted = true; return false; }
      const current = pieces(engine, player), area = nativeArea(engine, player);
      minimum = Math.min(minimum, area);
      if (!contains(expanded.nodes, current.nodes) || !contains(expanded.coverage, current.coverage)
        || !engine._getOpponentConnectedPieces(player).has(pointKey(move.point)) || area <= before) {
        counterexample = { actions: path, area, retainedNodes: current.nodes.size }; return false;
      }
      if (engine.gameOver || engine.currentPlayer === player) return true;
      // Auto-skipping the actor cannot silently shorten the certified window.
      if (seen.has(engine.currentPlayer)) { interrupted = true; return false; }
      if (!fullOpponentRound && seen.size) return true;
      const actor = engine.currentPlayer, snapshot = saveState(engine), nextSeen = new Set([...seen, actor]);
      for (const reply of [...engine.getLegalMoves(actor).map(row => row.point), null]) {
        if (!budget()) { interrupted = true; return false; }
        restoreState(engine, snapshot); probes++; checked++;
        check((reply === null ? engine.skipTurn() : engine.playMove(reply)).success, 'Independent oracle response became illegal');
        if (!visit(nextSeen, [...path, { actor, point: reply }])) { restoreState(engine, snapshot); return false; }
      }
      restoreState(engine, snapshot); return true;
    };
    const safe = structural || visit(new Set(), []);
    if (interrupted) return { status: 'incomplete', witness: null, complete: false, probes, roots };
    if (safe) return { status: 'certified-profitable-expansion', complete: true, probes, roots,
      witness: { point: [...move.point], beforeArea: before, afterRootArea: afterRoot,
        minimumReplyArea: structural ? expanded.coverage.size : minimum, actualReplyPlayer: responder !== player ? responder : null,
        replyActionsCompleted: checked, includesPass: !structural && checked > 0,
        rootAndPreviousPiecesRetained: true, rootConnected: true,
        structuralProtectedRootProof: structural,
        scope: structural ? 'all own nodes connected; every own line cell protected by the initial-node adjacency rule; area lower bound exceeds before'
          : fullOpponentRound ? 'root + every legal/PASS continuation through one full actual opponent round' : 'root + next actual opponent only' } };
    if (points && ordered.length === 1) return { status: 'refuted-expansion', complete: true, witness: null, probes, roots, counterexample };
  }
  return { status: 'no-certified-expansion', witness: null, complete: ordered.length <= maxRoots, probes, roots };
}

export async function actualWorkerDecision(engine, profile, sourceRoot) {
  const previousSelf = globalThis.self, previousFetch = globalThis.fetch, messages = [], surface = { postMessage: value => messages.push(value) };
  sourceRoot = resolve(sourceRoot); const assetRoot = resolve(sourceRoot, 'web/web前端/assets/research-ai');
  globalThis.self = surface;
  globalThis.fetch = async input => {
    const url = input instanceof URL ? input : new URL(input);
    const path = fileURLToPath(url), inside = relative(assetRoot, path);
    check(url.protocol === 'file:' && inside && !inside.startsWith('..') && !isAbsolute(inside), 'Evaluation fetch must stay in this source asset tree');
    return new Response(await readFile(path));
  };
  try {
    if (!workerHandlers.has(sourceRoot)) {
      await import(pathToFileURL(resolve(sourceRoot, 'web/web前端/AIWorker.js')).href);
      check(typeof surface.onmessage === 'function', 'Actual Worker handler unavailable');
      workerHandlers.set(sourceRoot, surface.onmessage);
    }
    const requestId = `accept-${sha(JSON.stringify(serializeEngineState(engine))).slice(0, 12)}`;
    const started = performance.now();
    await workerHandlers.get(sourceRoot)({ data: { type: 'COMPUTE', ...profile, requestId,
      serializedState: serializeEngineState(engine), aiPlayer: engine.currentPlayer, topN: 1 } });
    const result = messages.findLast(row => row.type === 'RESULT' || row.type === 'ERROR');
    check(result?.type === 'RESULT', `Actual Worker failed: ${result?.message ?? 'NO_RESULT'}`);
    const move = result.moves?.[0] ?? (!engine.gameOver && !engine.getLegalMoves().length ? { point: null, type: 'pass' } : null);
    check(move && (move.point === null && move.type === 'pass' || Array.isArray(move.point)), 'Worker did not emit an explicit action');
    return { point: move.point === null ? null : [...move.point], type: move.point === null ? 'pass' : 'move',
      elapsedMs: performance.now() - started, modelInfo: result.modelInfo, searchStats: result.searchStats ?? null };
  } finally { globalThis.self = previousSelf; globalThis.fetch = previousFetch; }
}

export function rawCandidateDecision(candidate, engine) {
  check(['lifeline-pass-opportunity-linear17-candidate-v3', 'lifeline-terminal-policy-linear17-candidate-v4',
    'lifeline-terminal-policy-extension-candidate-v5'].includes(candidate.schema)
    && candidate.runtime_spec?.weights?.length === 16 && candidate.runtime_spec.weights.every(Number.isFinite)
    && Number.isFinite(candidate.runtime_spec.passBias), 'Only the new trained pass-opportunity candidate is accepted');
  const spec = candidate.runtime_spec;
  const rows = fastPolicyCandidates(engine).map(move => ({ point: move.point,
    score: move.features.reduce((sum, feature, i) => sum + feature * spec.weights[i], 0) / (spec.temperature ?? 1) }));
  rows.push({ point: null, score: spec.passBias / (spec.temperature ?? 1) });
  rows.sort((a, b) => b.score - a.score || (a.point === null ? 1 : b.point === null ? -1 : a.point[1] - b.point[1] || a.point[0] - b.point[0]));
  return rows[0];
}

// The v4 product keeps its existing placement-only search. Its unused 17th
// auxiliary head is audited separately and must never be reported as deployed.
export async function rawProductDecision(candidate, source, sourceRoot = root) {
  const raw17 = rawCandidateDecision(candidate, source), spec = candidate.runtime_spec;
  const parameters = { weights: spec.weights, passBias: spec.passBias, temperature: spec.temperature, rules_version: 'territory-v3' };
  if (candidate.parent_alias !== 'three-v4') return { ...raw17, policy: 'raw-linear17',
    runtimeParametersSha256: sha(JSON.stringify(parameters)), auxiliaryRaw17Point: raw17.point };
  const bytes = await readFile(resolve(sourceRoot, candidate.lineage.parent_path));
  check(sha(bytes) === candidate.lineage.parent_sha256, 'Unguarded v4 raw search parent hash mismatch');
  const parent = JSON.parse(bytes), payload = { ...parent, weights: [...spec.weights], temperature: spec.temperature, passBias: spec.passBias };
  check(payload.id === candidate.lineage.parent_id && payload.temperature === 1
    && JSON.stringify(payload.search) === JSON.stringify(parent.search), 'Unguarded v4 search configuration changed');
  const engine = engineFromTrainingState(serializeEngineState(source)), ai = new ThreePlayerSearchAI(payload);
  ai.base = new FastMultiplayerPolicy(ai.spec, { includePass: false });
  ai.responses = ai.spec.search.opponents.map(opponent => new FastMultiplayerPolicy(opponent, { includePass: false }));
  const move = ai.getTopMoves(engine, engine.currentPlayer, 1)[0];
  check(move && Array.isArray(move.point), 'Unguarded v4 product search did not return a placement');
  return { point: [...move.point], score: move.score, policy: 'unguarded-v4-search-trained-placement',
    runtimeParametersSha256: sha(JSON.stringify(parameters)), auxiliaryRaw17Point: raw17.point,
    learnedPassUsed: false, parentSha256: sha(bytes), preservedSearchSha256: sha(JSON.stringify(parent.search)), searchStats: ai.lastSearch };
}

function random(seed) { let state = parseInt(sha(seed).slice(0, 8), 16) >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; }; }
export function freshEvaluationOpening(context, seed) {
  const settings = { playerCount: context.player_count, gridSize: context.grid_size,
    boardShape: context.player_count <= 3 ? 'triangle' : 'hexagon', rulesVersion: 'territory-v3' };
  const initial = new GameEngine({ ...settings, playerCount: Math.min(6, context.player_count) }), next = random(`pass-discipline-fresh-layout-v1/${context.parent}/${seed}/${context.grid_size}`);
  const players = PLAYER_ORDER.slice(0, context.player_count);
  for (let attempt = 0; attempt < 200; attempt++) {
    const bag = [...initial.validPositions], chosen = [];
    while (bag.length && chosen.length < context.player_count) {
      const point = bag.splice(Math.floor(next() * bag.length), 1)[0];
      if (chosen.every(other => (Math.abs(point[0] - other[0]) + Math.abs(point[1] - other[1])
          + Math.abs(point[0] + point[1] - other[0] - other[1])) / 2 >= 3)) chosen.push(point);
    }
    if (chosen.length !== context.player_count) continue;
    const engine = new GameEngine({ ...settings, initialPositions: Object.fromEntries(players.map((p, i) => [p, chosen[i]])),
      startingPointMode: 'custom', startPlayer: players[attempt % context.player_count], deferTerritoryUpdates: true });
    engine._isReplayingBatch = true;
    if (engine.activePlayers.every(player => engine.getLegalMoves(player).length >= 2)) return serializeEngineState(engine);
  }
  throw Error('Cannot construct a nondegenerate fresh-layout opening from the frozen seed');
}

export function terminalExpansionFixture(settings) {
  const engine = new GameEngine({ ...settings, deferTerritoryUpdates: true }); engine._isReplayingBatch = true;
  const first = engine.currentPlayer, start = engine.initialPositions[first];
  const moves = engine.getLegalMoves();
  const move = moves.find(row => Math.abs(row.point[0] - start[0]) + Math.abs(row.point[1] - start[1]) === 2)
    ?? moves[0];
  check(move && engine.playMove(move.point).success, 'Missing leading expansion fixture move');
  for (let i = 0; engine.currentPlayer !== first && !engine.gameOver && i < engine.activePlayers.length; i++) check(engine.skipTurn().success, 'Fixture opponent PASS failed');
  check(!engine.gameOver && engine.currentPlayer === first, 'Fixture did not return to the leader');
  return engine;
}

export async function sourceInventory(directory) {
  const output = {}, frontend = resolve(directory, 'web/web前端');
  const visit = async folder => {
    for (const item of await readdir(folder, { withFileTypes: true })) {
      const path = resolve(folder, item.name);
      if (item.isDirectory()) await visit(path);
      else if (/\.(json|f32)$/.test(item.name)) output[path] = sha(await readFile(path));
    }
  };
  for (const item of await readdir(frontend, { withFileTypes: true })) if (item.isFile() && /\.(js|mjs|json)$/.test(item.name)) {
    const path = resolve(frontend, item.name); output[path] = sha(await readFile(path));
  }
  await visit(resolve(frontend, 'assets/research-ai'));
  return output;
}
const legalAction = (engine, point) => point === null || engine.getLegalMoves().some(move => pointKey(move.point) === pointKey(point));
function terminalOutcome(engine) {
  const scores = Object.fromEntries(engine.activePlayers.map(player => [player, nativeArea(engine, player)]));
  if (!engine.gameOver) return { terminal: false, scores, shares: null };
  const survivors = engine.activePlayers.filter(player => !engine.resignedPlayers.has(player));
  const maximum = Math.max(0, ...survivors.map(player => scores[player])), winners = survivors.filter(player => scores[player] === maximum);
  return { terminal: true, scores, shares: Object.fromEntries(engine.activePlayers.map(player => [player, winners.includes(player) ? 1 / winners.length : 0])) };
}
export function terminalOnlyRewardAudit(engine, actions) {
  const outcome = terminalOutcome(engine), count = engine.validPositions.length;
  if (!outcome.terminal) return { gamma: 1, rewardType: 'terminal-outcome-native-margin-area-v1',
    trainingEligible: false, reason: 'truncated episodes have no terminal reward or policy update',
    rewards: actions.map(() => Object.fromEntries(engine.activePlayers.map(p => [p, 0]))), terminalReturns: null };
  const alive = engine.activePlayers.filter(player => !engine.resignedPlayers.has(player));
  const terminalReturns = Object.fromEntries(engine.activePlayers.map(player => {
    const enemy = alive.filter(other => other !== player), margin = outcome.scores[player] - Math.max(0, ...enemy.map(other => outcome.scores[other]));
    const result = engine.resignedPlayers.has(player) ? -1 : Math.sign(margin);
    return [player, result + 0.1 * margin / count + 0.01 * outcome.scores[player] / count];
  }));
  const rewards = actions.map((_, index) => Object.fromEntries(engine.activePlayers.map(player => [player,
    index === actions.length - 1 ? terminalReturns[player] : 0])));
  check(actions.length > 0, 'Natural training episode must contain at least one recorded action');
  const undiscountedReturns = actions.map((_, index) => Object.fromEntries(engine.activePlayers.map(player => [player,
    rewards.slice(index).reduce((sum, row) => sum + row[player], 0)])));
  check(undiscountedReturns.every(row => engine.activePlayers.every(player => row[player] === terminalReturns[player])),
    'Undiscounted terminal return audit failed');
  return { gamma: 1, rewardType: 'terminal-outcome-native-margin-area-v1', trainingEligible: true,
    allIntermediateRewardsZero: true, rewards, terminalReturns, undiscountedReturns,
    formula: 'sign(A_i-maxOpponentA)+0.1*(A_i-maxOpponentA)/N+0.01*A_i/N; natural terminal only' };
}
function verifyBinding(decision, candidateHash) {
  const metadata = decision.modelInfo?.passDisciplineTraining ?? decision.searchStats?.passDisciplineTraining;
  check(metadata?.candidate_sha256 === candidateHash, 'Actual candidate runtime is not bound to this trained model hash');
}

export async function evaluatePassMain(args, { decide = actualWorkerDecision, oracle = certifyIndependentExpansion } = {}) {
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  check(option('--run-root') && option('--protocol') && option('--baseline-root'), 'Use --run-root --protocol --baseline-root');
  const mode = option('--mode', 'games'), alias = option('--parent', 'easy'), sourceRoot = resolve(option('--candidate-root', root));
  const baselineRoot = resolve(option('--baseline-root')), runRoot = resolve(option('--run-root'));
  const protocolBytes = await readFile(resolve(option('--protocol'))), protocol = JSON.parse(protocolBytes);
  check(['lifeline-pass-discipline-acceptance-v1', 'lifeline-pass-discipline-acceptance-v2'].includes(protocol.schema)
    && ['games', 'cost-pilot', 'scenarios', 'shared-scenarios'].includes(mode), 'Invalid task acceptance protocol/mode');
  check(Number.isInteger(protocol.max_game_plies) && protocol.max_game_plies >= 1 && protocol.max_game_plies <= 600
    && Array.isArray(protocol.contexts) && protocol.contexts.length > 0
    && Number.isInteger(protocol.oracle?.maxNodes) && protocol.oracle.maxNodes >= 1
    && Number.isFinite(protocol.oracle?.timeMs) && protocol.oracle.timeMs > 0 && protocol.oracle.timeMs <= 10000
    && protocol.oracle.fullOpponentRound === true, 'Invalid bounded full-round/reward acceptance contract');
  const context = protocol.contexts.find(row => row.parent === alias); check(context && profiles[alias], 'Unknown acceptance parent/context');
  const composite = option('--composite-manifest') ? await passCompositeReferences(option('--composite-manifest')) : null;
  const candidatePath = option('--candidate') ?? (composite && !['cost-pilot', 'shared-scenarios'].includes(mode) ? composite.paths[alias] : null);
  if (composite && candidatePath) check(resolve(candidatePath) === composite.paths[alias], 'Candidate path differs from explicit composite source');
  const candidateBytes = candidatePath ? await readFile(resolve(candidatePath)) : null;
  check(['cost-pilot', 'shared-scenarios'].includes(mode) || candidateBytes, 'A trained candidate is mandatory for learned-model acceptance');
  const candidate = candidateBytes ? unseal(JSON.parse(candidateBytes)) : null, candidateHash = candidateBytes ? sha(candidateBytes) : null;
  const isExtension = candidate?.schema === 'lifeline-terminal-policy-extension-candidate-v5';
  check(['cost-pilot', 'shared-scenarios'].includes(mode) || candidate.schema === 'lifeline-terminal-policy-linear17-candidate-v4'
    || isExtension && composite && alias === 'hex-v1', 'Final acceptance requires a terminal-only candidate; v5 continuation requires its explicit composite');
  if (candidate) check((candidate.parent_alias === alias || isExtension && composite && alias === 'hex-v1') && candidate.weights?.length === 17
    && candidate.weights.every(Number.isFinite) && candidate.runtime_spec?.weights?.every((value, i) => value === candidate.weights[i])
    && candidate.runtime_spec.passBias === candidate.weights[16], 'Candidate alias/runtime parameter binding mismatch');
  const sources = { ...await sourceInventory(baselineRoot), ...(mode === 'cost-pilot' ? {} : await sourceInventory(sourceRoot)),
    ...(composite?.evidenceHashes ?? {}),
    [fileURLToPath(import.meta.url)]: sha(await readFile(fileURLToPath(import.meta.url))) };
  const trainingComposite = composite ? { identity: composite.identity, manifestSha256: composite.manifestSha256,
    perModelIdentities: Object.fromEntries(Object.entries(composite.models).map(([parent, model]) => [parent, model.training_identity])) } : null;
  const identity = sha(JSON.stringify({ mode, alias, context, protocol: sha(protocolBytes), candidateHash, baselineRoot, sourceRoot, sources, trainingComposite }));
  const maxUnits = Number(option('--max-new-units', '8')), maxSeconds = Number(option('--max-seconds', '25'));
  check(Number.isInteger(maxUnits) && maxUnits >= 0 && Number.isFinite(maxSeconds) && maxSeconds > 0 && maxSeconds <= 60, 'Invalid bounded evaluation segment');
  const plans = [];
  if (mode === 'shared-scenarios') {
    for (const [index, item] of protocol.shared_worker_profiles.entries()) for (const size of item.sizes) {
      const settings = { playerCount: item.player_count, gridSize: size,
        boardShape: item.player_count <= 3 ? 'triangle' : 'hexagon', rulesVersion: 'territory-v3' };
      const opening = item.player_count > 6 ? engineFromTrainingState(freshEvaluationOpening({ parent: 'shared', player_count: item.player_count, grid_size: size }, `shared-${index}`)) : new GameEngine(settings);
      plans.push({ id: `shared-${index}-s${size}-opening`, profile: item.profile, state: serializeEngineState(opening), kind: 'opening' });
      if (item.player_count <= 6) plans.push({ id: `shared-${index}-s${size}-terminal-expansion`, profile: item.profile,
        state: serializeEngineState(terminalExpansionFixture(settings)), kind: 'winning-terminal-pass-with-expansion' });
    }
    const points = [...new GameEngine({ gridSize: 5, playerCount: 2, rulesVersion: 'territory-v3' }).validPositions];
    const forced = new GameEngine({ gridSize: 5, playerCount: 15, boardShape: 'triangle', rulesVersion: 'territory-v3',
      initialPositions: Object.fromEntries(PLAYER_ORDER.map((player, index) => [player, points[index]])) });
    plans.push({ id: 'shared-forced-pass-15-full-triangle', profile: { strategy: 'greedy' }, state: serializeEngineState(forced), kind: 'forced-pass' });
  } else if (mode === 'scenarios') {
    for (const size of context.scenario_sizes) for (const kind of ['opening', 'winning-terminal-pass-with-expansion']) {
      const settings = { playerCount: context.player_count, gridSize: size,
        boardShape: context.player_count <= 3 ? 'triangle' : 'hexagon', rulesVersion: 'territory-v3' };
      const engine = kind === 'opening' ? new GameEngine(settings) : terminalExpansionFixture(settings);
      plans.push({ id: `${alias}-s${size}-${kind}`, state: serializeEngineState(engine), kind });
    }
    if (context.player_count === 3) {
      // Keep the fallback parent's actual runtime route while testing the same
      // later-seat cut. Native v4 is selected only at sizes 5/7/9.
      const trapSize = alias === 'three-v1' ? 6 : 7;
      const trap = new GameEngine({ gridSize: trapSize, playerCount: 3, boardShape: 'triangle', rulesVersion: 'territory-v3',
        initialPositions: { BLACK: [0, 0], WHITE: [trapSize - 1, 0], PURPLE: [trapSize - 4, 3] } });
      plans.push({ id: `${alias}-third-seat-cut-trap`, state: serializeEngineState(trap), kind: 'third-seat-cut-trap', badPoint: [0, 4] });
    }
  } else for (const seed of (mode === 'cost-pilot' ? context.seeds.slice(0, 1) : context.seeds)) {
    const state = freshEvaluationOpening(context, seed);
    plans.push({ id: `seed-${seed}-baseline`, seed, focal: null, state });
    if (mode !== 'cost-pilot') for (const player of state.activePlayers) plans.push({ id: `seed-${seed}-seat-${player}`, seed, focal: player, state });
  }
  await mkdir(runRoot, { recursive: true }); const guard = await lease(runRoot);
  try {
    // The independent supervisor writes its own atomic state concurrently.
    // Quarantine only abandoned files owned by this exclusive evaluator.
    for (const name of await readdir(runRoot)) if (/^(checkpoint|progress|report)\.json\.\d+\.tmp$/.test(name))
      await rename(resolve(runRoot, name), resolve(runRoot, `${name}.interrupted-${Date.now()}`));
    try { for (const name of await readdir(resolve(runRoot, 'units'))) if (/\.json\.\d+\.tmp$/.test(name))
      await rename(resolve(runRoot, 'units', name), resolve(runRoot, 'units', `${name}.interrupted-${Date.now()}`));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const prior = await readJson(resolve(runRoot, 'checkpoint.json'), true);
    const cp = prior ? unseal(prior) : { schema: 'lifeline-pass-discipline-evaluation-checkpoint-v1', identity,
      units: 0, committedPlies: 0, completed: [], active: null };
    check(cp.identity === identity && cp.units === cp.committedPlies + cp.completed.length && cp.completed.length <= plans.length, 'Evaluation identity/counter corruption');
    const records = [];
    for (const [i, record] of cp.completed.entries()) {
      check(record.id === plans[i].id && record.path === `units/${record.id}.json`, 'Completed evaluation order corruption');
      const raw = await readFile(resolve(runRoot, record.path)); check(sha(raw) === record.sha256, 'Evaluation receipt changed');
      records.push(unseal(JSON.parse(raw)));
    }
    check(cp.committedPlies === records.reduce((sum, record) => sum + (record.actions?.length ?? 0), 0)
      + (cp.active?.actions.length ?? 0), 'Committed action count disagrees with receipts');
    if (cp.active) {
      const plan = plans[cp.completed.length]; check(plan?.id === cp.active.id, 'Active game plan mismatch');
      const restored = engineFromTrainingState(plan.state);
      for (const action of cp.active.actions) check(!restored.gameOver && restored.currentPlayer === action.actor
        && (action.point === null ? restored.skipTurn() : restored.playMove(action.point)).success, 'In-flight action history is not canonical');
      check(JSON.stringify(serializeEngineState(restored)) === JSON.stringify(cp.active.state), 'In-flight state differs from its persisted action history');
    }
    const initialUnits = cp.units, started = performance.now();
    const save = async status => {
      await atomic(resolve(runRoot, 'checkpoint.json'), sealed(cp));
      await atomic(resolve(runRoot, 'progress.json'), { identity, status, progress_units: cp.units,
        completed_games_or_cases: cp.completed.length, total_games_or_cases: plans.length,
        active_game: cp.active?.id ?? null, active_plies: cp.active?.actions.length ?? 0 });
    };
    const inputs = new Map(await Promise.all(Object.keys(sources).map(async path => { const s = await stat(path); return [path, `${s.size}/${s.mtimeMs}`]; })));
    const checkInputs = async () => {
      check(sha(await readFile(resolve(option('--protocol')))) === sha(protocolBytes)
        && (!candidatePath || sha(await readFile(resolve(candidatePath))) === candidateHash), 'Frozen evaluation protocol/model changed');
      for (const [path, signature] of inputs) { const s = await stat(path); check(`${s.size}/${s.mtimeMs}` === signature, 'Evaluation source changed'); }
    };
    const halt = async () => {
      for (const [file, status] of [['STOP', 'STOPPED'], ['PAUSE', 'PAUSED']]) {
        try { await readFile(resolve(runRoot, file)); await save(status); return true; }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
      if (cp.units - initialUnits >= maxUnits || performance.now() - started >= maxSeconds * 1000) { await save('YIELDED'); return true; }
      await checkInputs(); return false;
    };
    const commit = async (plan, value) => {
      const path = `units/${plan.id}.json`, prior = await readJson(resolve(runRoot, path), true);
      if (prior) check(JSON.stringify(unseal(prior)) === JSON.stringify(value), 'Unindexed evaluation receipt corruption');
      else await atomic(resolve(runRoot, path), sealed(value));
      if (args.includes('--fault-after-unit-write')) return 79;
      cp.completed.push({ id: plan.id, path, sha256: sha(await readFile(resolve(runRoot, path))) }); cp.units++;
      cp.active = null; records.push(value); await save('RUNNING'); return null;
    };
    try {
      while (cp.completed.length < plans.length) {
        if (await halt()) return 75;
        const plan = plans[cp.completed.length];
        const unindexed = await readJson(resolve(runRoot, `units/${plan.id}.json`), true);
        if (unindexed) {
          const value = unseal(unindexed);
          check(value.identity === identity && value.id === plan.id, 'Unindexed completed receipt identity mismatch');
          if (['scenarios', 'shared-scenarios'].includes(mode)) check(value.scenarioStateHash === sha(JSON.stringify(plan.state)) && value.candidateSha256 === candidateHash,
            'Unindexed scenario source mismatch');
          else check(cp.active && value.finalStateHash === sha(JSON.stringify(cp.active.state))
            && JSON.stringify(value.actions) === JSON.stringify(cp.active.actions), 'Unindexed game differs from durable final state');
          const code = await commit(plan, value); if (code) return code;
          continue;
        }
        if (['scenarios', 'shared-scenarios'].includes(mode)) {
          const engine = engineFromTrainingState(plan.state), certificate = oracle(engine, protocol.oracle);
          check(plan.kind === 'forced-pass' ? certificate.status === 'forced-pass' : certificate.witness,
            'Fixed acceptance case has no independent safe profitable witness');
          const selectedProfile = plan.profile ?? profiles[alias];
          const baseline = await decide(engine, selectedProfile, baselineRoot), actual = await decide(engine, selectedProfile, sourceRoot);
          check(legalAction(engine, actual.point) && legalAction(engine, baseline.point), 'Scenario policy returned illegal action');
          if (mode === 'scenarios') verifyBinding(actual, candidateHash);
          const raw = mode === 'scenarios' ? protocol.schema === 'lifeline-pass-discipline-acceptance-v2'
            ? await rawProductDecision(candidate, engine, sourceRoot) : rawCandidateDecision(candidate, engine) : null;
          if (mode === 'scenarios' && protocol.schema === 'lifeline-pass-discipline-acceptance-v2') check(raw.policy === protocol.raw_product_contracts[alias], 'Raw product verification object differs from the frozen deployment contract');
          const trapProof = plan.badPoint ? oracle(engine, { ...protocol.oracle, points: [plan.badPoint], maxRoots: 1 }) : null;
          if (plan.badPoint) check(trapProof.status === 'refuted-expansion', 'Third-seat trap was not independently refuted');
          const passed = plan.kind === 'forced-pass' ? actual.point === null
            : actual.point !== null && (!raw || raw.point !== null)
              && (!plan.badPoint || pointKey(actual.point) !== pointKey(plan.badPoint) && pointKey(raw.point) !== pointKey(plan.badPoint));
          const receipt = { identity, id: plan.id, kind: plan.kind,
            scenarioStateHash: sha(JSON.stringify(plan.state)), independentCertificate: certificate,
            rawPoint: raw?.point, rawProductPolicy: raw?.policy ?? null, rawProductParametersSha256: raw?.runtimeParametersSha256 ?? null,
            auxiliaryRaw17Point: raw?.auxiliaryRaw17Point, rawProductReceipt: raw, baseline, candidate: actual, candidateSha256: candidateHash,
            thirdSeatTrapProof: trapProof, passed };
          const code = await commit(plan, receipt); if (code) return code;
          continue;
        }
        if (!cp.active) { cp.active = { id: plan.id, state: plan.state, actions: [], badPasses: 0, unknownPasses: 0,
          firstRoundBadPasses: 0, expansionActions: 0 }; await save('RUNNING'); }
        check(cp.active.id === plan.id, 'In-flight evaluation game order mismatch');
        const engine = engineFromTrainingState(cp.active.state);
        if (engine.gameOver || cp.active.actions.length >= protocol.max_game_plies) {
          const receipt = { identity, id: plan.id, seed: plan.seed, focal: plan.focal, openingState: plan.state,
            finalStateHash: sha(JSON.stringify(cp.active.state)), actions: cp.active.actions,
            outcome: terminalOutcome(engine), badPasses: cp.active.badPasses, unknownPasses: cp.active.unknownPasses,
            firstRoundBadPasses: cp.active.firstRoundBadPasses, expansionActions: cp.active.expansionActions,
            rewardAudit: terminalOnlyRewardAudit(engine, cp.active.actions),
            scoreChangesAreDiagnosticsNotRewards: true };
          const code = await commit(plan, receipt); if (code) return code;
          continue;
        }
        const candidateTurn = mode !== 'cost-pilot' && plan.focal === engine.currentPlayer;
        const decision = await decide(engine, profiles[alias], candidateTurn ? sourceRoot : baselineRoot);
        check(legalAction(engine, decision.point), 'Actual Worker emitted an illegal game action');
        if (candidateTurn) verifyBinding(decision, candidateHash);
        const actor = engine.currentPlayer, beforeArea = nativeArea(engine, actor);
        let certificate = null;
        if (decision.point === null && engine.getLegalMoves().length) {
          certificate = oracle(engine, protocol.oracle);
          if (certificate.witness) { cp.active.badPasses++; if (cp.active.actions.length < engine.playerCount * 2) cp.active.firstRoundBadPasses++; }
          else if (!certificate.complete) cp.active.unknownPasses++;
        }
        check((decision.point === null ? engine.skipTurn() : engine.playMove(decision.point)).success, 'Canonical rule rejected evaluated action');
        const afterArea = nativeArea(engine, actor); if (decision.point !== null && afterArea > beforeArea) cp.active.expansionActions++;
        cp.active.actions.push({ actor, point: decision.point, candidateTurn, beforeArea, afterArea,
          elapsedMs: decision.elapsedMs, modelInfo: decision.modelInfo, searchStats: decision.searchStats ?? null,
          independentPassCertificate: certificate });
        cp.active.state = serializeEngineState(engine); cp.committedPlies++; cp.units++; await save('RUNNING');
        if (args.includes('--fault-after-ply-checkpoint')) return 79;
      }
      await checkInputs();
      const gameRows = records.filter(row => row.outcome), candidates = gameRows.filter(row => row.focal !== null);
      const controls = new Map(gameRows.filter(row => row.focal === null).map(row => [row.seed, row]));
      const paired = candidates.filter(row => row.outcome.terminal && controls.get(row.seed)?.outcome.terminal);
      const candidateBadPasses = candidates.reduce((sum, game) => sum + game.actions.filter(action => action.candidateTurn && action.independentPassCertificate?.witness).length, 0);
      const report = { schema: 'lifeline-pass-discipline-evaluation-report-v1', identity, mode, parent: alias,
        candidateSha256: candidateHash, protocolSha256: sha(protocolBytes), sourceHashes: sources, trainingComposite,
        status: mode === 'cost-pilot' ? 'COST_PILOT_ONLY' : 'TASK_SCOPED_EVIDENCE', completedUnits: cp.units,
        completeCases: records.length, scenarioFailures: records.filter(row => row.passed === false).length,
        games: gameRows.length, naturalGames: gameRows.filter(row => row.outcome.terminal).length,
        truncatedGames: gameRows.filter(row => !row.outcome.terminal).length, pairedNaturalGames: paired.length,
        independentLayoutBlocks: controls.size, candidateCertifiedBadPasses: candidateBadPasses,
        rewardAudit: { gamma: 1, rewardType: 'terminal-outcome-native-margin-area-v1',
          naturallyCompleteAuditedEpisodes: gameRows.filter(game => game.rewardAudit.trainingEligible).length,
          truncatedExcludedFromTraining: gameRows.filter(game => !game.rewardAudit.trainingEligible).length,
          intermediateAreaRewards: false, allEligibleTimeReturnsEqualTerminalReward: true },
        candidateExpansionActions: candidates.reduce((sum, game) => sum + game.actions.filter(a => a.candidateTurn && a.point !== null && a.afterArea > a.beforeArea).length, 0),
        maximumDecisionMs: gameRows.length ? Math.max(...gameRows.flatMap(game => game.actions.map(a => a.elapsedMs))) : null,
        pairedMeanWinShareDelta: paired.length ? paired.reduce((sum, game) => sum + game.outcome.shares[game.focal] - controls.get(game.seed).outcome.shares[game.focal], 0) / paired.length : null,
        task_admission: mode === 'cost-pilot' ? 'NOT_APPLICABLE' : 'PENDING_COMBINED_SCENARIOS_AND_GAMES',
        strength_verified: false, runtime_admitted: false,
        limitations: 'Task-specific safe-opportunity/PASS tests and paired fresh-layout games; no universal safety/global strength, browser/device or other-context claim.' };
      await atomic(resolve(runRoot, 'report.json'), sealed(report)); await save('COMPLETE'); return 0;
    } catch (error) { await save('FATAL'); throw error; }
  } finally { await new Promise(done => guard.close(done)); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await evaluatePassMain(process.argv.slice(2)); }
  catch (error) { console.error(error.stack); process.exitCode = error.code === 'EADDRINUSE' ? 76 : 78; }
}
