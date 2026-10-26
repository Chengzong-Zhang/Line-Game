// Offline labels only. A budget fallback is never a training label.
import { GameEngine } from "./GameEngine.js?v=20261026-start-protection-v1";
import { isolatedSearchEngine } from "./MultiplayerSearch.js?v=20261026-start-protection-v1";
import { saveState, restoreState } from "./AIEngine.js?v=20261026-start-protection-v1";

export const DEFENSIVE_TRAINING_CONTRACT = Object.freeze({
  schema: "lifeline-defensive-minimax-training-v1",
  minimumCompletedDepth: 3,
  horizon: "max(3, 2 * surviving seats): root action, two actual opponent rounds; canonical auto-skips",
  actions: "all legal placements and voluntary PASS; no candidate shortlist",
  backup: "paranoid minimax: root maximizes, every other actual actor minimizes root utility",
  valueOrder: ["native terminal outcome", "retained root nodes", "avoid repeated damaging replies",
    "retained root coverage", "root connectivity", "persistent root-connected cut chain",
    "retained enemy losses", "own nodes", "own coverage"],
  labels: "equal mass on exact best vectors; incomplete search emits no label",
  scope: "offline application data; no trained weights, strength or permanent forced-chain guarantee",
});
const key = point => point === null ? "PASS" : point.join(",");
const check = (condition, message) => { if (!condition) throw new Error(message); };
const TIMEOUT = Symbol("defensive teacher budget");
export function compareDefensiveValues(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
export function requiredTrainingDepth(engine) {
  return Math.max(DEFENSIVE_TRAINING_CONTRACT.minimumCompletedDepth,
    2 * engine.activePlayers.filter(player => !engine.resignedPlayers.has(player)).length);
}
function pieces(engine, player) {
  const nodes = new Set(engine._getPlayerNodes(player).map(key));
  return { nodes, coverage: new Set([...nodes, ...engine._getPlayerLines(player).map(key)]) };
}
const missing = (reference, present) => [...reference].filter(point => !present.has(point)).length;

// Connectivity uses complete logical edges and surviving line cells, not the
// convex hull, colored area, Euclidean closeness, or a fabricated next actor.
export function rootConnectedAttackChain(engine, player, attackPoints) {
  const connected = engine._getOpponentConnectedPieces(player);
  const ownNode = engine._getPlayerStates(player).node;
  const present = attackPoints.filter(point => connected.has(key(point))
    && engine._getState(point) === ownNode);
  return { connectedCuts: present.length, uninterrupted: present.length === attackPoints.length };
}

export function assertCompletedTrainingLabel(label) {
  const receipt = label?.search;
  check(JSON.stringify(label?.contract) === JSON.stringify(DEFENSIVE_TRAINING_CONTRACT)
    && ["territory-v2", "territory-v3"].includes(label.rulesVersion)
    && Number.isInteger(label.playerCount) && label.playerCount >= 2 && label.playerCount <= 15
    && Array.isArray(label.activePlayers) && label.activePlayers.length === label.playerCount
    && new Set(label.activePlayers).size === label.playerCount
    && label.activePlayers.every(player => typeof player === "string" && player.length > 0)
    && Array.isArray(label.survivingPlayers) && label.survivingPlayers.length >= 2
    && new Set(label.survivingPlayers).size === label.survivingPlayers.length
    && label.survivingPlayers.every(player => label.activePlayers.includes(player))
    && label.survivingPlayers.includes(label.actor)
    && receipt?.complete === true && receipt.timedOut === false
    && Number.isInteger(receipt.completedDepth) && receipt.completedDepth >= 3
    && receipt.completedDepth === receipt.requestedDepth && receipt.completedDepth >= receipt.requiredDepth
    && Number.isInteger(receipt.requiredDepth)
    && receipt.requiredDepth >= Math.max(3, 2 * label.survivingPlayers.length) && receipt.candidateCap === null
    && receipt.allRootScoresExact === true && receipt.includesPass === true,
  "Training label rejected: a complete defensive minimax depth >=3 and full reply horizon are mandatory");
  check(Array.isArray(label.moves) && label.moves.length > 0
    && receipt.rootActionsCompleted === label.moves.length
    && label.moves.some(move => move.point === null)
    && new Set(label.moves.map(move => key(move.point))).size === label.moves.length
    && Array.isArray(label.legalActionKeys) && label.legalActionKeys.length === label.moves.length
    && new Set(label.legalActionKeys).size === label.moves.length
    && label.moves.every(move => label.legalActionKeys.includes(key(move.point)))
    && label.moves.every(move => Array.isArray(move.value) && move.value.length === 9
      && (move.point === null || Array.isArray(move.point) && move.point.length === 2 && move.point.every(Number.isInteger))
      && move.value.every(Number.isFinite) && Number.isFinite(move.target) && move.target >= 0 && move.target <= 1)
    && Math.abs(label.moves.reduce((sum, move) => sum + move.target, 0) - 1) < 1e-10,
  "Training label rejected: invalid exact action distribution");
  const best = label.moves.reduce((current, move) => compareDefensiveValues(move.value, current) > 0 ? move.value : current,
    label.moves[0].value);
  const bestCount = label.moves.filter(move => compareDefensiveValues(move.value, best) === 0).length;
  check(label.moves.every(move => Math.abs(move.target
    - (compareDefensiveValues(move.value, best) === 0 ? 1 / bestCount : 0)) < 1e-12),
  "Training label rejected: targets must assign equal mass only to exact best defensive vectors");
  return label;
}

export function defensiveTrainingLabel(source, { depth = requiredTrainingDepth(source),
  maxNodes = 100000, timeMs = 10000, now = () => performance.now(), pruning = true } = {}) {
  const requiredDepth = requiredTrainingDepth(source);
  check(!source.gameOver && ["territory-v2", "territory-v3"].includes(source.rulesVersion)
    && Number.isInteger(depth) && depth >= requiredDepth && depth <= 64,
  `Training teacher requires completed depth >= ${requiredDepth} (minimum 3; two actual opponent rounds)`);
  check(Number.isInteger(maxNodes) && maxNodes >= 0 && Number.isFinite(timeMs) && timeMs >= 0,
    "Invalid defensive training budget");
  const engine = isolatedSearchEngine(source), actor = source.currentPlayer;
  const initial = pieces(engine, actor), enemies = engine._getOpponents(actor);
  const initialEnemies = Object.fromEntries(enemies.map(player => [player, pieces(engine, player)]));
  const started = now(), deadline = started + timeMs;
  const search = { complete: false, timedOut: false, completedDepth: 0, requestedDepth: depth,
    requiredDepth, nodes: 0, cutoffs: 0, maxReachedPly: 0, rootActionsCompleted: 0,
    candidateCap: null, includesPass: true, allRootScoresExact: false,
    algorithm: "defensive-full-action-paranoid-minimax", elapsedMs: 0 };
  const budget = () => {
    if (search.nodes >= maxNodes || now() >= deadline) throw TIMEOUT;
  };
  const actions = () => {
    budget();
    const result = engine.getLegalMoves(engine.currentPlayer).map(move => [...move.point]);
    budget(); return [...result, null];
  };
  const measure = trace => {
    budget();
    const own = pieces(engine, actor), chain = rootConnectedAttackChain(engine, actor, trace.attackPoints);
    const connected = engine._getOpponentConnectedPieces(actor);
    let outcome = 0;
    if (engine.gameOver) {
      // Native discrete area is authoritative at terminal leaves.
      GameEngine.prototype._updateTerritories.call(engine);
      const alive = engine.activePlayers.filter(player => !engine.resignedPlayers.has(player));
      const maximum = Math.max(...alive.map(player => engine.cachedTerritories[player].area));
      outcome = engine.resignedPlayers.has(actor) || engine.cachedTerritories[actor].area < maximum ? -1
        : alive.filter(player => engine.cachedTerritories[player].area === maximum).length === 1 ? 1 : 0;
    }
    const captured = enemies.reduce((sum, player) => sum + missing(initialEnemies[player].nodes, pieces(engine, player).nodes), 0);
    const value = [outcome, -missing(initial.nodes, own.nodes), -Math.max(0, trace.damagingReplies - 1),
      -missing(initial.coverage, own.coverage), -[...own.nodes].filter(point => !connected.has(point)).length,
      chain.uninterrupted ? chain.connectedCuts : 0, captured, own.nodes.size, own.coverage.size];
    budget(); return value;
  };
  const transition = (point, trace) => {
    budget();
    const current = engine.currentPlayer, ownBefore = pieces(engine, actor);
    const enemyBefore = current === actor ? enemies.reduce((sum, player) => sum + pieces(engine, player).nodes.size, 0) : 0;
    const outcome = point === null ? engine.skipTurn() : engine.playMove(point);
    check(outcome.success, `Defensive teacher legal transition failed: ${outcome.reason}`);
    const ownAfter = pieces(engine, actor);
    const damaged = current !== actor && missing(ownBefore.nodes, ownAfter.nodes) > 0;
    const enemyAfter = current === actor ? enemies.reduce((sum, player) => sum + pieces(engine, player).nodes.size, 0) : 0;
    const attackPoints = current === actor && point !== null && enemyAfter < enemyBefore
      ? [...trace.attackPoints, [...point]] : trace.attackPoints;
    budget(); return { damagingReplies: trace.damagingReplies + Number(damaged), attackPoints };
  };
  const visit = (remaining, alpha, beta, trace, ply) => {
    budget(); search.nodes++; search.maxReachedPly = Math.max(search.maxReachedPly, ply);
    if (!remaining || engine.gameOver) return measure(trace);
    const maximizing = engine.currentPlayer === actor;
    let best = null;
    for (const point of actions()) {
      const state = saveState(engine);
      try {
        const value = visit(remaining - 1, alpha, beta, transition(point, trace), ply + 1);
        if (best === null || (maximizing ? compareDefensiveValues(value, best) > 0 : compareDefensiveValues(value, best) < 0)) best = value;
        if (maximizing && (alpha === null || compareDefensiveValues(best, alpha) > 0)) alpha = best;
        if (!maximizing && (beta === null || compareDefensiveValues(best, beta) < 0)) beta = best;
      } finally { restoreState(engine, state); }
      if (pruning && alpha !== null && beta !== null && compareDefensiveValues(alpha, beta) >= 0) {
        search.cutoffs++; break;
      }
    }
    return best;
  };
  const moves = [];
  let legalActionKeys;
  try {
    const rootActions = actions();
    legalActionKeys = rootActions.map(key);
    for (const point of rootActions) {
      const state = saveState(engine);
      try {
        // Each root starts with a fresh alpha/beta window. A pruned upper
        // bound can never become a soft target for an allegedly exact root.
        const trace = transition(point, { damagingReplies: 0, attackPoints: [] });
        const value = visit(depth - 1, null, null, trace, 1);
        moves.push({ point, value }); search.rootActionsCompleted++;
      } finally { restoreState(engine, state); }
    }
    moves.sort((a, b) => -compareDefensiveValues(a.value, b.value)
      || (a.point === null ? 1 : b.point === null ? -1 : a.point[1] - b.point[1] || a.point[0] - b.point[0]));
    const winners = moves.filter(move => compareDefensiveValues(move.value, moves[0].value) === 0).length;
    moves.forEach(move => { move.target = compareDefensiveValues(move.value, moves[0].value) === 0 ? 1 / winners : 0; });
    Object.assign(search, { complete: true, completedDepth: depth, allRootScoresExact: true });
  } catch (error) {
    if (error !== TIMEOUT) throw error;
    search.timedOut = true;
  } finally { search.elapsedMs = now() - started; }
  if (!search.complete) return { status: "NO_LABEL_INCOMPLETE_SEARCH", search, label: null };
  const label = assertCompletedTrainingLabel({ contract: DEFENSIVE_TRAINING_CONTRACT,
    rulesVersion: source.rulesVersion, playerCount: source.playerCount, actor,
    activePlayers: [...source.activePlayers], legalActionKeys,
    survivingPlayers: source.activePlayers.filter(player => !source.resignedPlayers.has(player)), moves, search });
  return { status: "COMPLETE_LABEL", search, label };
}
