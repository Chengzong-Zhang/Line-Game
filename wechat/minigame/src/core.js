// The frozen Web topology runtime is vendored below because Mini Game builds
// must not rely on an external browser deployment. It registers the factory
// consumed by GameEngine before any custom board is constructed.
import './topology/TopologyGameEngine.js';

export {
  GameEngine,
  PLAYER_ORDER,
  getBoardPositions,
  getBoardVertices,
  isBoardPoint,
  resolveBoardShape,
  resolveInitialPositions,
  resolveInitialRoots,
  RootMode,
  RootRulesVersion,
  TerritoryRulesVersion,
  TopologyRulesVersion,
  TOPOLOGY_ROOT_MODE_UNSUPPORTED,
} from '../../../web/web前端/GameEngine.js';
export {
  BOARD_TOPOLOGY_CONTRACT_VERSION,
  BOARD_DEFINITION_SCHEMA_VERSION,
  BOARD_HASH_SCHEMA_VERSION,
  validateBoardDefinition,
  canonicalizeBoard,
  createLegacyBoardDefinition,
  stableStringify,
} from './topology/BoardDefinition.js';
export { compileBoard, compileBoardOrThrow, compileLegacyBoard } from './topology/BoardCompiler.js';
export {
  createBoardDraft,
  addBoundaryVertex,
  undoBoundaryVertex,
  cancelBoardDraft,
  closeBoundaryDraft,
  addSeamPair,
  getBoundaryPath,
  BoardEditorError,
} from './topology/BoardEditor.js';
export {
  createSurfacePreset,
  createCylinderBoardDefinition,
  createMobiusBoardDefinition,
  createTorusBoardDefinition,
  createKleinBottleBoardDefinition,
  SURFACE_PRESET_NAMES,
} from './topology/BoardPresets.js';
export { generateBoard, RandomBoardGeneratorVersion } from './topology/RandomBoard.js';
export { projectBoard, hitTestBoard, projectPath } from './topology/BoardView.js';
export { computeTerritory } from './topology/SurfaceTerritory.js';
export { TopologyGameEngine, createTopologyGameEngine } from './topology/TopologyGameEngine.js';
export {
  encodeTopologyState,
  decodeTopologyState,
  TOPOLOGY_STATE_FORMAT,
  TOPOLOGY_STATE_SCHEMA_VERSION,
  TOPOLOGY_RULE_STATE_VERSION,
} from './topology/TopologyStateCodec.js';
export {
  TOPOLOGY_AI_ROUTE,
  TOPOLOGY_AI_ADAPTER_VERSION,
  buildTopologyAIState,
  rankTopologyCandidates,
  validateTopologyAIRequest,
} from './topology/TopologyAIAdapter.js';
export {
  TOPOLOGY_TUTORIAL_VERSION,
  TOPOLOGY_TUTORIAL_STEPS,
  topologyTutorialText,
  getTopologyTutorialStep,
} from './topology/TopologyTutorial.js';

// Existing Mini Game capabilities remain Web-source backed. The build pulls
// them into the package; custom board traffic uses the exports above instead.
export { GreedyAI, MinimaxAI } from '../../../web/web前端/AIEngine.js';
export { serializeRuleState, canonicalize, createReplayDocument, validateReplayDocument, buildEventEffects } from '../../../web/web前端/ReplayCodec.js';
export { createLocalGameSession } from '../../../web/web前端/LocalGameSession.js';
export { TUTORIAL_LEVELS, isTutorialRestrictionAttempt } from '../../../web/web前端/TutorialRunner.js';
export { randomInitialPositions, randomInitialRoots, requiresExplicitStartingPoints, startingPointSettings } from '../../../web/web前端/StartingPoints.js';
export {
  normalizeUndoUsage,
  recordUndoAction,
  consumeLocalUndo,
  planLocalUndo,
  createLocalUndoTimeline,
} from '../../../web/web前端/LocalUndo.js';
