import { playerIds, validateControllers } from './controllers.js';
import { validateTurnOrder } from './state.js';

// Shared input contract. Random roots are drawn by the server, never the client.
export function rankedSetupInput(settings, controllers) {
  const value = { gridSize: settings.gridSize, playerCount: settings.playerCount,
    boardShape: settings.boardShape || (settings.playerCount >= 4 ? 'hexagon' : 'triangle'),
    startPlayer: settings.startPlayer || 'BLACK', startingPointMode: settings.startingPointMode || 'default',
    rulesVersion: 'territory-v3', protectionRule: settings.protectionRule || 'duel-first-unprotected-v1',
    ...(settings.turnOrder !== undefined ? { turnOrder: validateTurnOrder(settings.turnOrder, settings.playerCount, settings.startPlayer || 'BLACK') } : {}) };
  if (!Number.isInteger(value.playerCount) || value.playerCount < 2 || value.playerCount > 6
    || !['symmetric-v1', 'duel-first-unprotected-v1'].includes(value.protectionRule)
    || !Number.isInteger(value.gridSize) || value.gridSize < 5 || value.gridSize > 15
    || !playerIds(value.playerCount).includes(value.startPlayer)
    || !['default', 'random', 'custom'].includes(value.startingPointMode)
    || (value.boardShape === 'diamond' && value.playerCount >= 3 && value.startingPointMode === 'default')) throw Error('INVALID_SETTINGS');
  if (value.startingPointMode === 'custom') value.initialPositions = settings.initialPositions;
  const seats = validateControllers(controllers, value);
  if (!seats || Object.values(seats).filter(profile => profile === 'human').length !== 1) throw Error('RANKED_ONE_HUMAN');
  return { settings: value, controllers: seats };
}
