import { GameEngine, PLAYER_ORDER, serializeRuleState, resolveBoardShape, resolveInitialPositions, startingPointSettings } from './core.js';
import { checksum } from './integrity.js';
import { normalizePlayOptions } from './play-options.js';

export const RULES = 'territory-v3';
export const MAX_ACTIONS = 3000;
export const MODES = ['human', 'ai-white', 'ai-black', 'ai-duel'];

export function settingsFor(size = 7, playerCount = 2, startPlayer = 'BLACK') {
  return { gridSize: size, playerCount, startPlayer, rulesVersion: RULES,
    turnTimerEnabled: false, turnTimeLimitSeconds: 60, hintEnabled: true, hintMaxCount: 3 };
}

export function validateSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)
    || !['territory-v2', RULES].includes(settings.rulesVersion)
    || !Number.isInteger(settings.playerCount) || settings.playerCount < 2 || settings.playerCount > PLAYER_ORDER.length
    || !Number.isInteger(settings.gridSize) || settings.gridSize < 5 || settings.gridSize > 15
    || !PLAYER_ORDER.slice(0, settings.playerCount).includes(settings.startPlayer)) throw new Error('INVALID_SETTINGS');
  normalizePlayOptions(settings);
  if (settings.boardShape !== undefined && !['triangle', 'hexagon'].includes(settings.boardShape)) throw new Error('INVALID_BOARD_SHAPE');
  const shape = resolveBoardShape(settings.playerCount, settings.boardShape);
  startingPointSettings(settings);
  if (settings.initialPositions !== undefined) resolveInitialPositions(settings.gridSize, settings.playerCount, settings.initialPositions, shape);
  return settings;
}

export function applyAction(engine, action) {
  if (!action || typeof action !== 'object') throw new Error('INVALID_ACTION');
  const type = { player_move: 'move', player_skip: 'skip', player_resign: 'resign' }[action.type] || action.type;
  const actor = action.player || action.color;
  if (actor && actor !== engine.currentPlayer && type !== 'resign') throw new Error('WRONG_PLAYER');
  if (type === 'move') {
    if (!Array.isArray(action.point) || action.point.length !== 2 || !action.point.every(Number.isInteger)
      || !engine.isValidPosition(action.point)) throw new Error('INVALID_POINT');
    return engine.playMove(action.point);
  }
  if (type === 'skip') return engine.skipTurn();
  if (type === 'resign' && engine.activePlayers.includes(actor)) return engine.resignPlayer(actor);
  throw new Error('INVALID_ACTION');
}

export function restoreGame(settings, actions = []) {
  validateSettings(settings);
  if (!Array.isArray(actions) || actions.length > MAX_ACTIONS) throw new Error('INVALID_ACTIONS');
  const engine = new GameEngine({ ...settings, deferTerritoryUpdates: false });
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
  const state = serializeRuleState(engine);
  const snapshot = engine.getSnapshot();
  return { snapshot, ruleState: state, stateHash: checksum(state) };
}
