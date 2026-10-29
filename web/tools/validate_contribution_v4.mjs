import { createHash } from 'node:crypto';
import '../web前端/TopologyGameEngine.js';
import GameEngine, { PLAYER_ORDER } from '../web前端/GameEngine.js';
import { compileBoard } from '../web前端/BoardCompiler.js';
import { canonicalize, createReplayDocument, validateReplayDocument, createTopologyReplayDocument, validateTopologyReplayDocument } from '../web前端/ReplayCodec.js';
import { decodeTopologyState } from '../web前端/TopologyStateCodec.js';
import { CONTRIBUTION_V4_MAX_ACTIONS, normalizeV4Context } from './training_contribution_schema.mjs';

const same = (a, b) => canonicalize(a) === canonicalize(b);
const keysAre = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const hash = value => `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`;
const assert = (condition, message) => { if (!condition) throw new Error(message); };

// Generator metadata is gameplay provenance. Only defined fields are accepted;
// in particular arbitrary notes, account data and player names are not accepted.
function validateGenerator(generator) {
  if (generator === undefined) return;
  assert(generator && typeof generator === 'object' && !Array.isArray(generator), 'Invalid generator');
  const allowed = ['generatorVersion', 'options', 'seed', 'attempt', 'category', 'categoryWeights', 'eligibleCategories', 'excludedCategories', 'holeFaces', 'trimFaces'];
  assert(Object.keys(generator).every(key => allowed.includes(key)), 'Unexpected generator field');
  assert(['surface-preset-v1', 'random-board-v4'].includes(generator.generatorVersion), 'Unsupported generator version');
  const opts = generator.options;
  assert(opts && typeof opts === 'object' && !Array.isArray(opts)
    && Object.keys(opts).every(key => ['gridSize', 'playerCount', 'minStartDistance', 'maxAttempts'].includes(key))
    && Object.values(opts).every(Number.isInteger), 'Invalid generator options');
  if (generator.generatorVersion === 'random-board-v4') {
    const names = ['disk', 'annulus', 'planar-two-holes', 'cylinder', 'mobius', 'torus', 'klein', 'sphere', 'double-torus'];
    assert(typeof generator.seed === 'string' && generator.seed.length <= 256 && Number.isInteger(generator.attempt)
      && generator.attempt >= 1 && generator.attempt <= 256 && names.includes(generator.category), 'Invalid generator provenance');
    const weights = { annulus: 15, cylinder: 10, disk: 30, 'double-torus': 5, klein: 5, mobius: 8, 'planar-two-holes': 10, sphere: 5, torus: 12 };
    assert(same(generator.categoryWeights, weights) && Array.isArray(generator.eligibleCategories)
      && generator.eligibleCategories.every(name => names.includes(name)) && generator.excludedCategories
      && typeof generator.excludedCategories === 'object' && !Array.isArray(generator.excludedCategories)
      && Object.entries(generator.excludedCategories).every(([name, reason]) => names.includes(name)
        && reason === 'no validated opening or surface found within the bounded feasibility search'), 'Invalid generator categories');
  }
  for (const key of ['holeFaces', 'trimFaces']) if (generator[key] !== undefined) {
    assert(Array.isArray(generator[key]) && generator[key].length <= 4096
      && generator[key].every(id => typeof id === 'string' && /^[ud]:\d+,\d+$/.test(id)), 'Invalid generator face list');
  }
}

function verifyNativeTopology(doc) {
  assert(keysAre(doc, ['format', 'schemaVersion', 'engineFamily', 'rulesVersion', 'topologyProtocolVersion', 'config', 'actions', 'finalState'])
    && doc.schemaVersion === 1 && doc.rulesVersion === 'surface-v1' && doc.topologyProtocolVersion === 'board-topology-v1', 'Invalid native topology replay');
  const c = doc.config;
  assert(keysAre(c, ['gridSize', 'playerCount', 'startPlayer', 'rulesVersion', 'topologyProtocolVersion', 'boardShape', 'boardDefinition', 'boardHash',
    'rootMode', 'rootRulesVersion', 'turnTimerEnabled', 'turnTimeLimitSeconds', 'hintEnabled', 'hintMaxCount', 'undoEnabled', 'undoMaxCount'])
    && c.rulesVersion === 'surface-v1' && c.boardShape === 'custom' && c.topologyProtocolVersion === 'board-topology-v1'
    && c.rootMode === 'classic' && c.rootRulesVersion === 'root-v1', 'Invalid topology config');
  validateGenerator(c.boardDefinition?.generator);
  const compiled = compileBoard(c.boardDefinition);
  assert(compiled.ok && same(compiled.value.definition, c.boardDefinition) && compiled.value.boardHash === c.boardHash, 'Invalid board identity');
  const engine = new GameEngine({ ...c, compiledBoard: compiled.value, deferTerritoryUpdates: false });
  assert(engine.isTopologyBoard && engine.boardHash === c.boardHash, 'Topology runtime unavailable');
  const players = PLAYER_ORDER.slice(0, c.playerCount), samples = new Set(compiled.value.sampleIds);
  for (const action of doc.actions) {
    assert(!engine.gameOver && players.includes(action?.player), 'Invalid topology actor');
    assert(action.type === 'move' ? keysAre(action, ['type', 'player', 'vertexId']) && samples.has(action.vertexId)
      : ['skip', 'resign'].includes(action?.type) && keysAre(action, ['type', 'player']), 'Invalid topology action');
    assert(action.type === 'resign' ? engine.activePlayers.includes(action.player) : action.player === engine.currentPlayer, 'Topology actor out of turn');
    const result = action.type === 'move' ? engine.playMove(action.vertexId)
      : action.type === 'skip' ? engine.skipTurn() : engine.resignPlayer(action.player);
    assert(result.success, 'Illegal topology action');
  }
  const state = engine.encodeTopologyState();
  assert(engine.getSnapshot().gameOver && keysAre(doc.finalState, ['boardHash', 'stateHash', 'topologyState'])
    && doc.finalState.boardHash === engine.boardHash && doc.finalState.stateHash === hash(state)
    && same(doc.finalState.topologyState, state), 'Incomplete or mismatched topology replay');
  return c;
}

export async function validateV4Replay(doc, context) {
  assert(doc && Array.isArray(doc.actions) && doc.actions.length > 0 && doc.actions.length <= CONTRIBUTION_V4_MAX_ACTIONS, 'Invalid action count');
  let config;
  if (doc.format === 'lifeline-topology-replay' && doc.engineFamily === 'lifeline-topology-engine') {
    config = verifyNativeTopology(doc);
  } else if (doc.format === 'lifeline-topology-replay' && doc.engineFamily === 'web-game-engine') {
    const decoded = decodeTopologyState(doc.initialState?.topologyState);
    validateGenerator(decoded.board.definition.generator);
    const count = Object.keys(decoded.ruleState.startingVertices).length;
    assert(count >= 2 && count <= 6, 'Invalid topology player count');
    const verified = await validateTopologyReplayDocument(doc);
    assert(verified.success, 'Invalid web topology replay');
    const rebuilt = await createTopologyReplayDocument({ boardDefinition: decoded.board.definition,
      playerCount: count, startPlayer: decoded.ruleState.currentPlayer, rulesVersion: 'surface-v1' }, doc.actions);
    assert(rebuilt.terminal && same(doc, rebuilt), 'Incomplete or mismatched web topology replay');
    // The Web topology codec does not encode display size or hint settings.
    // They are not rule inputs for a surface; derive only a validation context.
    config = { rulesVersion: 'surface-v1', boardShape: 'custom', gridSize: 9, playerCount: count,
      startPlayer: decoded.ruleState.currentPlayer, hintEnabled: context?.hintsEnabled,
      hintMaxCount: context?.hintsEnabled ? 1 : 0, turnTimerEnabled: false, turnTimeLimitSeconds: 60 };
  } else if (doc.format === 'lifeline-replay' && doc.engineFamily === 'web-game-engine') {
    config = doc.config;
    assert(config?.rulesVersion === 'territory-v3' && doc.rulesVersion === 'territory-v3', 'Unsupported rules');
    const verified = await validateReplayDocument(doc);
    assert(verified.success, 'Invalid replay');
    const rebuilt = await createReplayDocument(config, doc.actions);
    assert(rebuilt.terminal && same(doc, rebuilt), 'Incomplete or mismatched replay');
  } else {
    // Web topology and native topology share a format/schema number but not
    // their fields. Never interpret either as a coordinate replay.
    throw new Error('Unsupported replay format or engine family');
  }
  assert(Number.isInteger(config?.gridSize) && config.gridSize >= 5 && config.gridSize <= 15
    && Number.isInteger(config.playerCount) && config.playerCount >= 2 && config.playerCount <= (config.rulesVersion === 'surface-v1' ? 6 : 15)
    && PLAYER_ORDER.slice(0, config.playerCount).includes(config.startPlayer)
    && typeof config.hintEnabled === 'boolean' && typeof config.turnTimerEnabled === 'boolean'
    && Number.isInteger(config.turnTimeLimitSeconds) && config.turnTimeLimitSeconds >= 15 && config.turnTimeLimitSeconds <= 200
    && Number.isInteger(config.hintMaxCount) && config.hintMaxCount >= (config.hintEnabled ? 1 : 0) && config.hintMaxCount <= 10, 'Invalid replay settings');
  const cleanContext = normalizeV4Context(context, config);
  if (doc.engineFamily === 'lifeline-topology-engine') assert(cleanContext.undo.enabled === config.undoEnabled && cleanContext.undo.maxCount === config.undoMaxCount, 'Undo mismatch');
  return { replay: doc, context: cleanContext, player_count: config.playerCount,
    game_id: createHash('sha256').update(canonicalize({ namespace: 'lifeline-training-game-v4', replay: doc })).digest('hex') };
}
