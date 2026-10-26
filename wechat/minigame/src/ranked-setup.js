import { playerIds, validateControllers } from './controllers.js';

// Shared input contract. Random roots are drawn by the server, never the client.
export function rankedSetupInput(settings, controllers) {
  const value = { gridSize: settings.gridSize, playerCount: settings.playerCount,
    boardShape: settings.boardShape || (settings.playerCount >= 4 ? 'hexagon' : 'triangle'),
    startPlayer: settings.startPlayer || 'BLACK', startingPointMode: settings.startingPointMode || 'default',
    rulesVersion: 'territory-v3' };
  if (!Number.isInteger(value.gridSize) || value.gridSize < 5 || value.gridSize > 15
    || !playerIds(value.playerCount).includes(value.startPlayer)
    || !['default', 'random', 'custom'].includes(value.startingPointMode)) throw Error('INVALID_SETTINGS');
  if (value.startingPointMode === 'custom') value.initialPositions = settings.initialPositions;
  const seats = validateControllers(controllers, value);
  if (!seats || Object.values(seats).filter(profile => profile === 'human').length !== 1) throw Error('RANKED_ONE_HUMAN');
  return { settings: value, controllers: seats };
}
