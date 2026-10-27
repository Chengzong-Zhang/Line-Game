// Import the released Web source directly. The build strips cache query strings.
export { GameEngine, PLAYER_ORDER, getBoardPositions, getBoardVertices, isBoardPoint,
  resolveBoardShape, resolveInitialPositions } from '../../../web/web前端/GameEngine.js';
export { GreedyAI, MinimaxAI } from '../../../web/web前端/AIEngine.js';
export { serializeRuleState, canonicalize, createReplayDocument, validateReplayDocument, buildEventEffects } from '../../../web/web前端/ReplayCodec.js';
export { createLocalGameSession } from '../../../web/web前端/LocalGameSession.js';
export { TUTORIAL_LEVELS, isTutorialRestrictionAttempt } from '../../../web/web前端/TutorialRunner.js';
export { randomInitialPositions, startingPointSettings } from '../../../web/web前端/StartingPoints.js';
export { normalizeUndoUsage, recordUndoAction, consumeLocalUndo, planLocalUndo,
  createLocalUndoTimeline } from '../../../web/web前端/LocalUndo.js';
