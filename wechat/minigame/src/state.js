import { GameEngine, PLAYER_ORDER, serializeRuleState, resolveBoardShape, resolveInitialPositions,
  resolveInitialRoots, startingPointSettings, RootMode, RootRulesVersion, TopologyRulesVersion,
  compileBoard, decodeTopologyState, BOARD_TOPOLOGY_CONTRACT_VERSION } from './core.js';
import { checksum } from './integrity.js';
import { normalizePlayOptions } from './play-options.js';

export const RULES = 'territory-v3';
export const LEGACY_PROTECTION_RULE = 'symmetric-v1';
export const DEFAULT_PROTECTION_RULE = 'duel-first-unprotected-v1';
export const PROTECTION_RULES = Object.freeze([LEGACY_PROTECTION_RULE, DEFAULT_PROTECTION_RULE]);
export const SURFACE_RULES = TopologyRulesVersion.SURFACE_V1;
// This is the gameplay protocol carried with every surface-v1 settings
// envelope. It is distinct from the state codec's own schema version, but
// deliberately has the same frozen board-topology contract identity.
export const TOPOLOGY_PROTOCOL_VERSION = BOARD_TOPOLOGY_CONTRACT_VERSION;
export const MAX_ACTIONS = 3000;
export const MODES = ['human', 'ai-white', 'ai-black', 'ai-duel'];
export const TOPOLOGY_LOCAL_SESSION_FORMAT = 'lifeline-topology-local-session';
export const TOPOLOGY_LOCAL_SESSION_SCHEMA_VERSION = 1;
export const TOPOLOGY_REPLAY_FORMAT = 'lifeline-topology-replay';
export const TOPOLOGY_REPLAY_SCHEMA_VERSION = 1;

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));

function invalid(code) { throw new Error(code); }

function compileTopologyBoard(settings) {
  const hasDefinition = own(settings, 'boardDefinition');
  const hasCompiled = own(settings, 'compiledBoard');
  if (!hasDefinition && !hasCompiled) invalid('MISSING_BOARD_DEFINITION');
  const compile = definition => {
    let result;
    try { result = compileBoard(definition); } catch (_) { invalid('INVALID_BOARD_DEFINITION'); }
    if (!result?.ok) invalid('INVALID_BOARD_DEFINITION');
    return result.value;
  };
  let fromDefinition = null;
  if (hasDefinition) fromDefinition = compile(settings.boardDefinition);
  let fromCompiled = null;
  if (hasCompiled) {
    if (!record(settings.compiledBoard) || !record(settings.compiledBoard.definition)
      || typeof settings.compiledBoard.boardHash !== 'string') invalid('INVALID_COMPILED_BOARD');
    fromCompiled = compile(settings.compiledBoard.definition);
    if (fromCompiled.boardHash !== settings.compiledBoard.boardHash) invalid('BOARD_HASH_MISMATCH');
  }
  if (fromDefinition && fromCompiled && fromDefinition.boardHash !== fromCompiled.boardHash) invalid('BOARD_HASH_MISMATCH');
  return fromDefinition || fromCompiled;
}

function normalizeTopologyActions(actions, sampleIds) {
  if (!Array.isArray(actions) || actions.length > MAX_ACTIONS) invalid('INVALID_ACTIONS');
  return actions.map(action => {
    if (!record(action)) invalid('INVALID_ACTION');
    const type = { player_move: 'move', player_skip: 'skip', player_resign: 'resign' }[action.type] || action.type;
    const player = action.player ?? action.color;
    if (!['move', 'skip', 'resign'].includes(type)) invalid('INVALID_ACTION');
    if (type === 'move') {
      // Coordinate aliases are deliberately not a persistence identity: a
      // chart coordinate can represent multiple quotient vertices at a seam.
      if (own(action, 'point') || typeof action.vertexId !== 'string' || !sampleIds.has(action.vertexId)) invalid('INVALID_TOPOLOGY_VERTEX');
      return { type, ...(player ? { player } : {}), vertexId: action.vertexId };
    }
    if (type === 'resign' && typeof player !== 'string') invalid('INVALID_ACTION');
    return { type, ...(player ? { player } : {}) };
  });
}

function checkTopologyState(settings, actions, suppliedState, suppliedHash) {
  const engine = restoreGame(settings, actions);
  const view = ruleView(engine);
  if (suppliedState === undefined) return { engine, view };
  let decoded;
  try { decoded = decodeTopologyState(suppliedState); } catch (_) { invalid('INVALID_TOPOLOGY_STATE'); }
  if (decoded.contractVersion !== TOPOLOGY_PROTOCOL_VERSION) invalid('INVALID_TOPOLOGY_PROTOCOL');
  if (decoded.boardHash !== engine.boardHash || decoded.boardHash !== view.boardHash) invalid('BOARD_HASH_MISMATCH');
  try {
    const restored = restoreGame(settings, []);
    restored.restoreTopologyState(suppliedState);
    if (checksum(restored.encodeTopologyState()) !== view.stateHash) invalid('TOPOLOGY_STATE_MISMATCH');
  } catch (error) {
    if (error?.message === 'TOPOLOGY_STATE_MISMATCH') throw error;
    invalid('INVALID_TOPOLOGY_STATE');
  }
  if (checksum(suppliedState) !== view.stateHash || suppliedHash !== undefined && suppliedHash !== view.stateHash) {
    invalid('TOPOLOGY_STATE_MISMATCH');
  }
  return { engine, view };
}

const asymmetricProtectionApplies = settings => Boolean(settings) && (settings.playerCount ?? 2) === 2
  && (settings.boardShape ?? 'triangle') === 'triangle';
const cloneSettings = settings => Object.defineProperties({}, Object.getOwnPropertyDescriptors(settings));

export function withoutInactiveProtectionRule(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return settings;
  const normalized = cloneSettings(settings);
  if (!asymmetricProtectionApplies(normalized) && normalized.protectionRule === DEFAULT_PROTECTION_RULE) {
    delete normalized.protectionRule;
  }
  return normalized;
}

export function withNewGameProtectionRule(settings) {
  const normalized = withoutInactiveProtectionRule(settings);
  if (asymmetricProtectionApplies(normalized)) normalized.protectionRule ??= DEFAULT_PROTECTION_RULE;
  return normalized;
}

export function settingsFor(size = 7, playerCount = 2, startPlayer = 'BLACK', boardShape) {
  return withNewGameProtectionRule({ gridSize: size, playerCount, startPlayer, rulesVersion: RULES,
    ...(boardShape ? { boardShape } : {}), turnTimerEnabled: false, turnTimeLimitSeconds: 60,
    hintEnabled: true, hintMaxCount: 3 });
}

export function isTopologySettings(settings) {
  return record(settings) && (settings.rulesVersion === SURFACE_RULES
    || settings.boardShape === 'custom' || own(settings, 'boardDefinition') || own(settings, 'compiledBoard')
    || own(settings, 'boardHash')
    || own(settings, 'topologyProtocolVersion'));
}

/**
 * Topology settings have a deliberately small, canonical surface. A custom
 * board is never coerced through the legacy triangle/hexagon resolver, and
 * board identity is recomputed from the definition before it is persisted.
 */
export function normalizeGameSettings(settings) {
  if (!record(settings)) invalid('INVALID_SETTINGS');
  if (isTopologySettings(settings)) {
    if (settings.rulesVersion !== SURFACE_RULES) invalid('INVALID_TOPOLOGY_RULES');
    const topologyProtocolVersion = settings.topologyProtocolVersion ?? TOPOLOGY_PROTOCOL_VERSION;
    if (topologyProtocolVersion !== TOPOLOGY_PROTOCOL_VERSION) invalid('INVALID_TOPOLOGY_PROTOCOL');
    if (settings.boardShape !== undefined && settings.boardShape !== 'custom') invalid('INVALID_BOARD_SHAPE');
    if (own(settings, 'initialRoots') || settings.rootMode !== undefined && settings.rootMode !== RootMode.CLASSIC
      || settings.rootRulesVersion !== undefined && settings.rootRulesVersion !== RootRulesVersion.V1) {
      invalid('TOPOLOGY_ROOT_MODE_UNSUPPORTED');
    }
    if (own(settings, 'initialPositions')) invalid('TOPOLOGY_STARTS_MUST_BE_IN_BOARD_DEFINITION');
    if (settings.startingPointMode !== undefined && settings.startingPointMode !== 'default') invalid('INVALID_STARTING_POINT_MODE');
    if (!Number.isInteger(settings.playerCount) || settings.playerCount < 2 || settings.playerCount > 6
      || !PLAYER_ORDER.slice(0, settings.playerCount).includes(settings.startPlayer)) invalid('INVALID_SETTINGS');
    const compiled = compileTopologyBoard(settings);
    if (settings.boardHash !== undefined && settings.boardHash !== compiled.boardHash) invalid('BOARD_HASH_MISMATCH');
    const gridSize = Number.isInteger(settings.gridSize) && settings.gridSize > 0
      ? settings.gridSize : Math.max(1, compiled.sampleIds.length);
    return {
      gridSize,
      playerCount: settings.playerCount,
      startPlayer: settings.startPlayer,
      rulesVersion: SURFACE_RULES,
      topologyProtocolVersion,
      boardShape: 'custom',
      boardDefinition: clone(compiled.definition),
      boardHash: compiled.boardHash,
      rootMode: RootMode.CLASSIC,
      rootRulesVersion: RootRulesVersion.V1,
      ...normalizePlayOptions(settings),
    };
  }
  return validateLegacySettings(settings);
}

function validateLegacySettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)
    || !['territory-v2', RULES].includes(settings.rulesVersion)
    || settings.protectionRule !== undefined && !PROTECTION_RULES.includes(settings.protectionRule)
    || !Number.isInteger(settings.playerCount) || settings.playerCount < 2 || settings.playerCount > PLAYER_ORDER.length
    || !Number.isInteger(settings.gridSize) || settings.gridSize < 5 || settings.gridSize > 15
    || !PLAYER_ORDER.slice(0, settings.playerCount).includes(settings.startPlayer)) throw new Error('INVALID_SETTINGS');
  normalizePlayOptions(settings);
  if (settings.boardShape !== undefined && !['triangle', 'diamond', 'hexagon'].includes(settings.boardShape)) throw new Error('INVALID_BOARD_SHAPE');
  const shape = resolveBoardShape(settings.playerCount, settings.boardShape);
  startingPointSettings(settings);
  if (settings.initialPositions !== undefined) resolveInitialPositions(settings.gridSize, settings.playerCount, settings.initialPositions, shape);
  const rootMode = settings.rootMode ?? RootMode.CLASSIC;
  if (!Object.values(RootMode).includes(rootMode)) throw new Error('INVALID_ROOT_MODE');
  const rootRulesVersion = settings.rootRulesVersion ?? (rootMode === RootMode.CLASSIC ? RootRulesVersion.V1 : RootRulesVersion.V2);
  if ((rootMode === RootMode.CLASSIC) !== (rootRulesVersion === RootRulesVersion.V1)) throw new Error('INVALID_ROOT_RULES');
  if (rootMode !== RootMode.CLASSIC && (settings.playerCount !== 2 || settings.rulesVersion !== RULES)) throw new Error('INVALID_ROOT_MODE');
  if (settings.initialRoots !== undefined || rootMode !== RootMode.CLASSIC) {
    resolveInitialRoots(settings.gridSize, settings.playerCount, settings.initialRoots, shape, rootMode, settings.initialPositions);
  }
  return settings;
}

// Preserve the legacy reference-equality contract while returning the
// canonical topology settings that must replace an untrusted envelope.
export function validateSettings(settings) { return normalizeGameSettings(settings); }

export function topologySettingsFor(boardDefinition, options = {}) {
  const source = {
    gridSize: options.gridSize,
    playerCount: options.playerCount ?? 2,
    startPlayer: options.startPlayer ?? 'BLACK',
    rulesVersion: SURFACE_RULES,
    boardShape: 'custom',
    ...(options.topologyProtocolVersion !== undefined ? { topologyProtocolVersion: options.topologyProtocolVersion } : {}),
    ...(boardDefinition !== undefined ? { boardDefinition } : {}),
    ...(options.boardHash !== undefined ? { boardHash: options.boardHash } : {}),
    ...(options.compiledBoard !== undefined ? { compiledBoard: options.compiledBoard } : {}),
    ...normalizePlayOptions(options),
  };
  return normalizeGameSettings(source);
}

export function applyAction(engine, action) {
  if (!action || typeof action !== 'object') throw new Error('INVALID_ACTION');
  const type = { player_move: 'move', player_skip: 'skip', player_resign: 'resign' }[action.type] || action.type;
  const actor = action.player || action.color;
  if (actor && actor !== engine.currentPlayer && type !== 'resign') throw new Error('WRONG_PLAYER');
  if (engine.isTopologyBoard) {
    if (type === 'move') {
      if (own(action, 'point') || typeof action.vertexId !== 'string' || !action.vertexId) throw new Error('INVALID_TOPOLOGY_VERTEX');
      return engine.playMove(action.vertexId);
    }
    if (type === 'skip') return engine.skipTurn();
    if (type === 'resign' && engine.activePlayers.includes(actor)) return engine.resignPlayer(actor);
    if (type === 'root_relocate' || type === 'root_add') throw new Error('TOPOLOGY_ROOT_ACTION_UNSUPPORTED');
    throw new Error('INVALID_ACTION');
  }
  if (type === 'move') {
    if (!Array.isArray(action.point) || action.point.length !== 2 || !action.point.every(Number.isInteger)
      || !engine.isValidPosition(action.point)) throw new Error('INVALID_POINT');
    return engine.playMove(action.point);
  }
  if (type === 'root_relocate' || type === 'root_add') {
    if (!Array.isArray(action.point) || action.point.length !== 2 || !action.point.every(Number.isInteger)
      || !engine.isValidPosition(action.point)) throw new Error('INVALID_POINT');
    return engine.playRootAction(type === 'root_relocate' ? 'relocate' : 'add', action.point);
  }
  if (type === 'skip') return engine.skipTurn();
  if (type === 'resign' && engine.activePlayers.includes(actor)) return engine.resignPlayer(actor);
  throw new Error('INVALID_ACTION');
}

export function restoreGame(settings, actions = []) {
  const normalized = validateSettings(withoutInactiveProtectionRule(settings));
  if (!Array.isArray(actions) || actions.length > MAX_ACTIONS) throw new Error('INVALID_ACTIONS');
  const engine = new GameEngine({ ...normalized, deferTerritoryUpdates: false });
  if (actions.length) {
    const result = engine.replayBatch((transaction) => {
      for (let i = 0; i < actions.length; i++) {
        const step = applyAction(transaction, actions[i]);
        if (!step.success) throw new Error(`${step.reason}:${i + 1}`);
      }
      return { success: true };
    });
    if (!result.success) throw new Error(result.reason);
  }
  return engine;
}

export function ruleView(engine) {
  if (engine.isTopologyBoard) {
    const topologyState = engine.encodeTopologyState();
    const snapshot = engine.getSnapshot();
    return { snapshot, ruleState: topologyState, topologyState, boardHash: engine.boardHash,
      topologyProtocolVersion: TOPOLOGY_PROTOCOL_VERSION, stateHash: checksum(topologyState) };
  }
  const state = serializeRuleState(engine);
  const snapshot = engine.getSnapshot();
  return { snapshot, ruleState: state, stateHash: checksum(state) };
}

export function createTopologyLocalGameSession(settings, actions = [], topologyState, stateHash) {
  const normalized = normalizeGameSettings(settings);
  if (!isTopologySettings(normalized)) invalid('INVALID_TOPOLOGY_SESSION');
  const compiled = compileTopologyBoard(normalized);
  const canonicalActions = normalizeTopologyActions(actions, new Set(compiled.sampleIds));
  const { view } = checkTopologyState(normalized, canonicalActions, topologyState, stateHash);
  return {
    format: TOPOLOGY_LOCAL_SESSION_FORMAT,
    schemaVersion: TOPOLOGY_LOCAL_SESSION_SCHEMA_VERSION,
    topologyProtocolVersion: normalized.topologyProtocolVersion,
    settings: normalized,
    actions: canonicalActions,
    boardHash: view.boardHash,
    topologyState: clone(view.topologyState),
    stateHash: view.stateHash,
  };
}

export function validateTopologyLocalGameSession(session) {
  if (!record(session) || session.format !== TOPOLOGY_LOCAL_SESSION_FORMAT
    || session.schemaVersion !== TOPOLOGY_LOCAL_SESSION_SCHEMA_VERSION) invalid('INVALID_TOPOLOGY_SESSION');
  const normalized = normalizeGameSettings(session.settings);
  if (!isTopologySettings(normalized)) invalid('INVALID_TOPOLOGY_SESSION');
  if (session.topologyProtocolVersion !== undefined
    && session.topologyProtocolVersion !== normalized.topologyProtocolVersion) invalid('INVALID_TOPOLOGY_PROTOCOL');
  const compiled = compileTopologyBoard(normalized);
  const actions = normalizeTopologyActions(session.actions, new Set(compiled.sampleIds));
  if (session.boardHash !== normalized.boardHash) invalid('BOARD_HASH_MISMATCH');
  const { view } = checkTopologyState(normalized, actions, session.topologyState, session.stateHash);
  return {
    format: TOPOLOGY_LOCAL_SESSION_FORMAT,
    schemaVersion: TOPOLOGY_LOCAL_SESSION_SCHEMA_VERSION,
    topologyProtocolVersion: normalized.topologyProtocolVersion,
    settings: normalized,
    actions,
    boardHash: view.boardHash,
    topologyState: clone(view.topologyState),
    stateHash: view.stateHash,
  };
}

export function createTopologyReplayDocument(settings, actions = []) {
  const session = createTopologyLocalGameSession(settings, actions);
  return {
    format: TOPOLOGY_REPLAY_FORMAT,
    schemaVersion: TOPOLOGY_REPLAY_SCHEMA_VERSION,
    engineFamily: 'lifeline-topology-engine',
    rulesVersion: SURFACE_RULES,
    topologyProtocolVersion: session.topologyProtocolVersion,
    config: session.settings,
    actions: session.actions,
    finalState: {
      boardHash: session.boardHash,
      stateHash: session.stateHash,
      topologyState: session.topologyState,
    },
  };
}

export function validateTopologyReplayDocument(document) {
  if (!record(document) || document.format !== TOPOLOGY_REPLAY_FORMAT
    || document.schemaVersion !== TOPOLOGY_REPLAY_SCHEMA_VERSION
    || document.engineFamily !== 'lifeline-topology-engine'
    || document.rulesVersion !== SURFACE_RULES || !record(document.finalState)) invalid('REPLAY_INVALID');
  if (document.topologyProtocolVersion !== undefined
    && document.topologyProtocolVersion !== TOPOLOGY_PROTOCOL_VERSION) invalid('REPLAY_INVALID');
  const session = createTopologyLocalGameSession(document.config, document.actions,
    document.finalState.topologyState, document.finalState.stateHash);
  if (document.finalState.boardHash !== session.boardHash) invalid('BOARD_HASH_MISMATCH');
  return { topologyProtocolVersion: session.topologyProtocolVersion,
    settings: session.settings, actions: session.actions, ...ruleView(restoreGame(session.settings, session.actions)) };
}
