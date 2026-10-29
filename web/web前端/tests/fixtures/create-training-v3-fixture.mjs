import GameEngine, { PLAYER_ORDER } from '../../GameEngine.js';
import { createReplayDocument } from '../../ReplayCodec.js';
import { randomInitialPositions } from '../../StartingPoints.js';
import { pathToFileURL } from 'node:url';

// Engineering fixtures only. Never submit these synthetic records to production.
export async function syntheticV3Contribution({ playerCount = 2, boardShape = playerCount >= 4 ? 'hexagon' : 'triangle',
  gridSize = 5, startingPointMode = 'default', sample = 0.31, moves = 1, terminalMode = 'pass',
  undoUsedCount = 0, profile = null } = {}) {
  const config = { playerCount, boardShape, gridSize, startPlayer: 'BLACK', rulesVersion: 'territory-v3',
    hintEnabled: false, hintMaxCount: 0, turnTimerEnabled: false, turnTimeLimitSeconds: 60 };
  if (startingPointMode !== 'default') Object.assign(config, { startingPointMode,
    initialPositions: randomInitialPositions(gridSize, playerCount, () => sample, boardShape) });
  const engine = new GameEngine(config), actions = [];
  for (let index = 0; index < moves && !engine.gameOver; index++) {
    const point = engine.getLegalMoves(engine.currentPlayer)[0]?.point;
    const actor = engine.currentPlayer;
    const result = point ? engine.playMove(point) : engine.skipTurn();
    if (!result.success) throw new Error('Synthetic v3 action failed');
    actions.push({ type: point ? 'move' : 'skip', actor, ...(point ? { point } : {}) });
  }
  if (terminalMode === 'resign') {
    for (const actor of PLAYER_ORDER.slice(1, playerCount)) {
      if (engine.gameOver) break;
      const result = engine.resignPlayer(actor);
      if (!result.success) throw new Error('Synthetic v3 resignation failed');
      actions.push({ type: 'resign', actor });
    }
  } else if (terminalMode === 'pass') {
    for (let index = 0; index < playerCount + 1 && !engine.gameOver; index++) {
      const actor = engine.currentPlayer;
      const result = engine.skipTurn();
      if (!result.success) throw new Error('Synthetic v3 terminal skip failed');
      actions.push({ type: 'skip', actor });
    }
  } else {
    throw new Error('Unknown synthetic terminal mode');
  }
  if (!engine.gameOver) throw new Error('Synthetic v3 fixture did not terminate');
  const replay = await createReplayDocument(config, actions);
  return { format: 'lifeline-training-contribution', version: 3, consent: true, consent_policy: 'anonymous-replay-training-v3',
    replay, context: { source: 'local', actors: Object.fromEntries(replay.config.players.map((color, index) =>
      [color, index === 1 && profile ? { kind: 'ai', profile } : { kind: 'human' }])), mixedProfiles: false, hintsEnabled: false,
    undo: { enabled: undoUsedCount > 0, maxCount: 3, usedCount: undoUsedCount } } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = process.argv[2] ? JSON.parse(process.argv[2]) : {};
  process.stdout.write(JSON.stringify(await syntheticV3Contribution(options)));
}
