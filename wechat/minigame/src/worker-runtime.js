import { canonicalTerminalWinningPass } from './worker-pass.js';
import { applyPassDiscipline } from '../../../web/web前端/AIPassDisciplineV4.js';
import { BudgetedMinimaxAI } from '../../../web/web前端/BudgetedMinimaxAI.js';
import { multiplayerClock } from '../../../web/web前端/MultiplayerClock.js';
import { searchTopologyMoves } from './topology/TopologySearchAI.js';
import { GreedyAI, MinimaxAI, createReplayDocument, validateReplayDocument, buildEventEffects,
  TOPOLOGY_AI_ROUTE, TOPOLOGY_AI_ADAPTER_VERSION, buildTopologyAIState,
  rankTopologyCandidates, validateTopologyAIRequest } from './core.js';
import { controllerChoices } from './controllers.js';
import { restoreGame, ruleView, applyAction, validateSettings, MAX_ACTIONS,
  createTopologyReplayDocument, validateTopologyReplayDocument, TOPOLOGY_REPLAY_FORMAT,
  TOPOLOGY_PROTOCOL_VERSION } from './state.js';
import { checksum } from './integrity.js';
import { modelForProfile, multiplayerModelForProfile } from './model-catalog.js';
import { checkedModelBytes } from './model-assets.js';
import { createResearchModel, NeuralPUCTAI } from '../../../web/web前端/ResearchAI.js';
import { createModelFreeModel, ModelFreeAI } from '../../../web/web前端/ModelFreeAI.js';
import { createEmbeddedThreePlayerAI } from './three-player-ai.js';
import { createEmbeddedHexPlayerAI } from './hex-player-ai.js';
import { createEmbeddedMultiplayerRuntime, isMultiplayerTierProfile } from './multiplayer-ai.js';

const TOPOLOGY_GENERIC_PROFILE = 'topology-generic';
const TOPOLOGY_AI_PASS = 'PASS';

function assertLiveTopologyContext(message, engine) {
  const context = message.context;
  if (!context || context.boardHash !== engine.boardHash) throw new Error('STALE_TOPOLOGY_BOARD');
  if (context.topologyProtocolVersion !== TOPOLOGY_PROTOCOL_VERSION) {
    throw new Error('STALE_TOPOLOGY_PROTOCOL');
  }
  if (!Number.isInteger(context.revision) || context.revision !== engine.positionRevision) {
    throw new Error('STALE_TOPOLOGY_REVISION');
  }
}

function topologyReplayEffects(before, after) {
  const players = before.players || [];
  return {
    addedEdgesByPlayer: Object.fromEntries(players.map(player => {
      const previous = new Set(before.edges?.[player] || []);
      return [player, (after.edges?.[player] || []).filter(edge => !previous.has(edge))];
    })),
    capturedPoints: Object.entries(before.boardStates || {})
      .filter(([id, state]) => Number.isInteger(state) && state > 0 && state <= 11 && state % 2 === 1 && after.boardStates?.[id] !== state)
      .map(([id]) => id),
    territoryDelta: Object.fromEntries(players.map(player => [player,
      Number(after.territories?.[player]?.area || 0) - Number(before.territories?.[player]?.area || 0)])),
    gameEnded: Boolean(after.gameOver && !before.gameOver),
  };
}

function topologyAI(engine, message, payload, kind, before, requestStarted) {
  const profile = payload.profile ?? TOPOLOGY_GENERIC_PROFILE;
  if (profile !== TOPOLOGY_GENERIC_PROFILE) throw new Error('TOPOLOGY_FIXED_SHAPE_PROFILE_UNSUPPORTED');
  if (payload.model != null) throw new Error('TOPOLOGY_MODEL_UNSUPPORTED');
  if ([payload.player, message.context?.player].some(player => player != null && player !== engine.currentPlayer)) {
    throw new Error('WRONG_PLAYER');
  }
  const legalMoveIds = engine.getLegalMoves(engine.currentPlayer).map(move => move.vertexId);
  const coverageByPlayer = engine._coverageByPlayer();
  const logicalPathsByPlayer = Object.fromEntries(engine.activePlayers.map(player => [player,
    [...engine.topologyPaths[player].values()].map(path => ({ ...path })),
  ]));
  const state = buildTopologyAIState(engine.compiledBoard, {
    rulesVersion: engine.rulesVersion,
    positionRevision: engine.positionRevision,
    currentPlayer: engine.currentPlayer,
    legalMoveIds: [...legalMoveIds, TOPOLOGY_AI_PASS],
    coverageByPlayer,
    logicalPathsByPlayer,
    historyHashes: [...engine.historyHashes],
  });
  const request = {
    contractVersion: TOPOLOGY_AI_ADAPTER_VERSION,
    boardHash: engine.boardHash,
    rulesVersion: engine.rulesVersion,
    positionRevision: engine.positionRevision,
    currentPlayer: engine.currentPlayer,
    modelRoute: TOPOLOGY_AI_ROUTE,
    legalMoveIds: state.legalMoveIds,
    state,
  };
  const validation = validateTopologyAIRequest(engine.compiledBoard, request, {
    rulesVersion: engine.rulesVersion,
    positionRevision: engine.positionRevision,
    currentPlayer: engine.currentPlayer,
  });
  if (!validation.ok) throw new Error(`INVALID_TOPOLOGY_AI_REQUEST:${validation.errors.map(error => error.code).join(',')}`);
  const timeLimitMs = Math.max(25, Math.min(5000, Number(payload.timeLimitMs) || 3000));
  const { moves: searchedMoves, searchInfo } = searchTopologyMoves(engine, {
    aiPlayer: engine.currentPlayer, topN: kind === 'ANALYZE' ? 3 : 1,
    maxDepth: payload.depth ?? Math.max(3, 2 * engine._getRemainingPlayers().length),
    timeLimitMs, deadline: requestStarted + timeLimitMs,
  });
  const moves = searchedMoves.map(move => move.type === 'pass'
    ? { type: 'skip', score: move.score }
    : { type: 'move', vertexId: move.vertexId, score: move.score });
  if (ruleView(engine).stateHash !== before.stateHash) throw new Error('SEARCH_MUTATED_STATE');
  return {
    moves,
    stateHash: before.stateHash,
    player: engine.currentPlayer,
    profile,
    ...(kind === 'ANALYZE' ? { metric: 'topology-generic' } : {}),
    boardHash: engine.boardHash,
    positionRevision: engine.positionRevision,
    topologyProtocolVersion: TOPOLOGY_PROTOCOL_VERSION,
    searchInfo,
    modelInfo: { id: TOPOLOGY_AI_ROUTE, route: TOPOLOGY_AI_ROUTE, strengthVerified: false },
  };
}

function runTask(message, restore = restoreGame, recordAction = () => {}) {
  const { kind, payload } = message;
  const requestStarted = ['AI', 'HINT', 'ANALYZE'].includes(kind) && payload.settings?.rulesVersion === 'surface-v1'
    ? (globalThis.performance?.now?.() ?? Date.now()) : null;
  if (kind === 'REPLAY_STEP') {
    const { settings, actions, cursor } = payload;
    if (!Array.isArray(actions) || actions.length > MAX_ACTIONS || !Number.isInteger(cursor)
      || cursor < 0 || cursor > actions.length) throw new Error('REPLAY_INVALID');
    const engine = restore(settings, actions.slice(0, Math.max(0, cursor - 1))), before = ruleView(engine);
    const action = cursor ? actions[cursor - 1] : null;
    const actor = action?.player || action?.color || (action ? engine.currentPlayer : null);
    if (action) {
      const result = applyAction(engine, action);
      if (!result.success) throw new Error(result.reason);
      recordAction(action);
    }
    const after = ruleView(engine);
    return { cursor, actor, action, stateHash: after.stateHash, snapshot: after.snapshot,
      ...(after.topologyState ? { topologyState: after.topologyState, boardHash: after.boardHash,
        topologyProtocolVersion: after.topologyProtocolVersion } : {}),
      effects: engine.isTopologyBoard ? topologyReplayEffects(before.snapshot, after.snapshot)
        : buildEventEffects(before.ruleState, before.snapshot, after.ruleState, after.snapshot) };
  }
  if (kind === 'IMPORT_REPLAY') {
    if (typeof payload.text !== 'string' || payload.text.length > 2 * 1024 * 1024) throw new Error('REPLAY_INVALID');
    let document;
    try { document = JSON.parse(payload.text); } catch (_) { throw new Error('REPLAY_INVALID'); }
    if (document?.format === TOPOLOGY_REPLAY_FORMAT) return validateTopologyReplayDocument(document);
    validateSettings(document?.config);
    if (!Array.isArray(document.actions) || document.actions.length > MAX_ACTIONS) throw new Error('REPLAY_INVALID');
    return validateReplayDocument(document, checksum).then(result => {
      if (!result.success) throw new Error('REPLAY_INVALID');
      const engine = restoreGame(result.settings, result.actions);
      return { settings: result.settings, actions: result.actions, ...ruleView(engine) };
    });
  }
  const hardStartedAt = ['AI', 'HINT', 'ANALYZE'].includes(kind) && payload.profile === 'minimax-4'
    && payload.settings?.boardShape !== 'diamond'
    ? multiplayerClock.now() : null;
  const hardDeadline = hardStartedAt === null ? null : hardStartedAt + 3000;
  const engine = restore(payload.settings, payload.actions);
  if (kind === 'EXPORT_REPLAY') return engine.isTopologyBoard
    ? createTopologyReplayDocument(payload.settings, payload.actions)
    : createReplayDocument(payload.settings, payload.actions, checksum);
  if (kind === 'STATE') return ruleView(engine);
  if (kind === 'TERRITORY') {
    if (engine.isTopologyBoard) assertLiveTopologyContext(message, engine);
    return ruleView(engine);
  }
  if (kind === 'APPLY') {
    if (engine.isTopologyBoard) assertLiveTopologyContext(message, engine);
    const result = applyAction(engine, payload.action);
    if (!result.success) throw new Error(result.reason);
    recordAction(payload.action);
    return ruleView(engine);
  }
  if (kind === 'AI' || kind === 'HINT' || kind === 'ANALYZE') {
    if (engine.gameOver) throw new Error('GAME_OVER');
    const before = ruleView(engine);
    if (engine.isTopologyBoard) {
      assertLiveTopologyContext(message, engine);
      return topologyAI(engine, message, payload, kind, before, requestStarted);
    }
    const profile = payload.profile || ({ easy: 'greedy', normal: 'minimax-2', simple: 'minimax-2',
      medium: 'minimax-3', hard: 'minimax-4' })[payload.difficulty] || 'minimax-2';
    if (!controllerChoices(engine).includes(profile) || profile === 'human') throw new Error('INVALID_CONTROLLERS');
    const tier = isMultiplayerTierProfile(profile);
    const embedded = multiplayerModelForProfile(profile), threePlayer = embedded?.playerCounts.includes(3), hexPlayer = embedded?.playerCounts.includes(4);
    if ([payload.player, message.context?.player].some(player => player != null && player !== engine.currentPlayer)) {
      throw new Error('WRONG_PLAYER');
    }
    const entry = modelForProfile(profile);
    if (!entry && payload.model != null) throw new Error('MODEL_INTEGRITY');
    const rank = (algorithm, modelInfo = null) => {
      // Preserve the released v2 terminal-win contract; v3 uses its scoped
      // safe-growth discipline below. Model validation has already completed.
      const legacyPass = engine.rulesVersion === 'territory-v2' ? canonicalTerminalWinningPass(engine, engine.currentPlayer) : null;
      if (legacyPass) return { moves: [legacyPass], stateHash: before.stateHash, player: engine.currentPlayer,
        ...(kind === 'ANALYZE' ? { profile, metric: 'heuristic' } : {}) };
      const requested = kind === 'ANALYZE' ? 3 : 1;
      const ranked = algorithm.getTopMoves(engine, engine.currentPlayer, Math.max(5, requested),
        hardStartedAt !== null ? { startedAt: hardStartedAt, deadline: hardDeadline }
          : tier ? { passDisciplinePrechecked: true } : undefined);
      if (ruleView(engine).stateHash !== before.stateHash) throw new Error('SEARCH_MUTATED_STATE');
      const disciplined = applyPassDiscipline(engine, ranked, { player: engine.currentPlayer, topN: requested,
        ...(hardStartedAt === null ? {} : { timeMs: Math.max(0, hardDeadline - multiplayerClock.now()), now: multiplayerClock.now }) });
      const moves = disciplined.moves;
      if (ruleView(engine).stateHash !== before.stateHash) throw new Error('SEARCH_MUTATED_STATE');
      const metric = tier && algorithm.lastSearch?.algorithm === 'trained-linear-policy' ? 'policy-score'
        : embedded ? embedded.metric : entry ? entry.research ? 'puct' : 'prior' : 'heuristic';
      const hardElapsedMs = hardStartedAt === null ? null : multiplayerClock.now() - hardStartedAt;
      return { moves, stateHash: before.stateHash, player: engine.currentPlayer,
        passDiscipline: disciplined.receipt,
        ...(modelInfo ? { modelInfo } : {}),
        ...(tier || profile.startsWith('minimax-')
          ? { profile, ...(tier ? { modelInfo } : {}),
            search: { ...(algorithm.lastSearch || {}), passDiscipline: disciplined.receipt,
              ...(hardElapsedMs === null ? {} : { totalElapsedMs: hardElapsedMs,
                totalOverrunMs: Math.max(0, hardElapsedMs - 3000), trainingLabel: false }) } } : {}),
        ...(kind === 'ANALYZE' ? { profile, metric } : {}) };
    };
    // The new tiers include several player counts, so route them before the
    // legacy three/hex catalog branches. Preserve all historical profiles.
    if (tier) return createEmbeddedMultiplayerRuntime(profile, engine).then(runtime => rank(runtime.ai, runtime.modelInfo));
    // Hex model validation is asynchronous, including on the Web. Existing 2/3
    // player tasks retain their synchronous response path and ranking semantics.
    if (hexPlayer) return createEmbeddedHexPlayerAI(profile, engine.rulesVersion).then(rank);
    let algorithm;
    if (threePlayer) {
      algorithm = createEmbeddedThreePlayerAI(profile, engine.rulesVersion);
    } else if (entry) {
      if (payload.model?.id !== entry.id) throw new Error('MODEL_INTEGRITY');
      const bytes = checkedModelBytes(entry, payload.model.raw);
      // A fresh realm-owned buffer for the shared Web model constructors.
      const raw = new Uint8Array(bytes).buffer;
      algorithm = entry.research ? new NeuralPUCTAI(createResearchModel(entry.spec, raw), { simulations: 16, cPuct: 1.5 })
        : new ModelFreeAI(createModelFreeModel(entry.spec, raw));
    } else algorithm = profile === 'greedy' ? new GreedyAI()
      : profile === 'minimax-4' && engine.boardShape !== 'diamond'
        ? new BudgetedMinimaxAI({ timeMs: 3000, reserveMs: 200, maxDepth: 8, now: multiplayerClock.now })
        : new MinimaxAI(Number(profile.slice(-1)), { iterativeDeepening: profile === 'minimax-4' });
    return rank(algorithm, profile === 'greedy'
      ? { strategy: 'greedy', runtime_policy: 'generic-rule-greedy', trained_model: false } : null);
  }
  throw new Error('UNKNOWN_TASK');
}

function plainJsonKey(value) {
  // Native messages are plain copied data. Non-JSON/custom direct callers still
  // use the original restore path; never cache two inputs through lossy JSON.
  const seen = new Set();
  const check = item => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item) && !Object.is(item, -0)) return;
    if (!item || typeof item !== 'object' || seen.has(item)) throw Error('UNCACHEABLE');
    const proto = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && proto !== Object.prototype && proto !== null) throw Error('UNCACHEABLE');
    seen.add(item);
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (descriptor.get || descriptor.set) throw Error('UNCACHEABLE');
      if (!descriptor.enumerable && !(Array.isArray(item) && name === 'length')) throw Error('UNCACHEABLE');
      if (descriptor.enumerable) check(descriptor.value);
    }
    if (Array.isArray(item)) for (let i = 0; i < item.length; i++) if (!Object.prototype.hasOwnProperty.call(item, i)) throw Error('UNCACHEABLE');
    if (Object.getOwnPropertySymbols(item).length) throw Error('UNCACHEABLE');
    seen.delete(item);
  };
  try { check(value); return JSON.stringify(value); } catch (_) { return null; }
}

export function createTaskRuntime() {
  // One bounded cache belongs to this Worker realm. It contains full Superko
  // history and only reuses an engine after comparing every action in its prefix.
  let cached = null, sequence = 0;
  return function execute(message) {
    const ticket = ++sequence, previous = cached;
    cached = null;
    let pending = null;
    const restore = (settings, actions = []) => {
      validateSettings(settings);
      if (!Array.isArray(actions) || actions.length > MAX_ACTIONS) throw Error('INVALID_ACTIONS');
      const settingsKey = plainJsonKey(settings), actionKeys = actions.map(plainJsonKey);
      const cacheable = settingsKey !== null && actionKeys.every(key => key !== null);
      let engine;
      if (cacheable && previous && previous.settingsKey === settingsKey && previous.actionKeys.length <= actionKeys.length
        && previous.actionKeys.every((key, index) => key === actionKeys[index])) {
        engine = previous.engine;
        if (previous.actionKeys.length < actionKeys.length) {
          const result = engine.replayBatch(transaction => {
            for (let i = previous.actionKeys.length; i < actions.length; i++) {
              const step = applyAction(transaction, actions[i]);
              if (!step.success) throw Error(`${step.reason}:${i + 1}`);
            }
            return { success: true };
          });
          if (!result.success) throw Error(result.reason);
        }
      } else engine = restoreGame(settings, actions);
      if (cacheable) pending = { engine, settingsKey, actionKeys };
      return engine;
    };
    const recordAction = action => {
      if (!pending) return;
      const key = plainJsonKey(action);
      if (key === null) pending = null;
      else pending.actionKeys.push(key);
    };
    const complete = result => {
      // Async model loading owns its leased engine. A later request must never
      // mutate it or allow an old completion to replace the newer cache.
      if (ticket === sequence) cached = pending;
      return result;
    };
    const result = runTask(message, restore, recordAction);
    return result?.then ? result.then(complete) : complete(result);
  };
}

const taskRuntime = createTaskRuntime();
let cloneLeaseDepth = 0, installedClone = false;
function withNativeClone(task) {
  if (typeof globalThis.structuredClone !== 'function') {
    globalThis.structuredClone = value => JSON.parse(JSON.stringify(value));
    installedClone = true;
  }
  cloneLeaseDepth++;
  const release = () => {
    cloneLeaseDepth--;
    if (!cloneLeaseDepth && installedClone) {
      delete globalThis.structuredClone;
      installedClone = false;
    }
  };
  try {
    const result = task();
    if (result?.then) return result.finally(release);
    release(); return result;
  } catch (error) { release(); throw error; }
}

export function executeTask(message) {
  return withNativeClone(() => taskRuntime(message));
}

export function handleWorkerMessage(message) {
  const success = result => ({ id: message.id, context: message.context, ok: true, result });
  const failure = error => ({ id: message.id, context: message.context, ok: false, error: error.message || 'COMPUTE_FAILED' });
  try {
    const result = executeTask(message);
    return result?.then ? result.then(success, failure) : success(result);
  } catch (error) { return failure(error); }
}
