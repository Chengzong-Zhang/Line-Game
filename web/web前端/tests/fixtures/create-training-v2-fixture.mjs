import GameEngine from '../../GameEngine.js';
import { createReplayDocument } from '../../ReplayCodec.js';
import { randomInitialPositions } from '../../StartingPoints.js';
import { pathToFileURL } from 'node:url';

// Engineering fixtures only. Never submit these synthetic records to production.
export async function syntheticV2Contribution({ playerCount = 2, boardShape = playerCount >= 4 ? 'hexagon' : 'triangle',
  gridSize = 5, startingPointMode = 'default', sample = 0.17, moves = 2, undoUsedCount = 0, profile = null } = {}) {
  const config = { playerCount, boardShape, gridSize, startPlayer: 'BLACK', rulesVersion: 'territory-v2',
    hintEnabled: false, hintMaxCount: 0, turnTimerEnabled: false, turnTimeLimitSeconds: 60 };
  if (startingPointMode !== 'default') Object.assign(config, { startingPointMode,
    initialPositions: randomInitialPositions(gridSize, playerCount, () => sample, boardShape) });
  const engine = new GameEngine(config), actions = [];
  for (let index = 0; index < moves && !engine.gameOver; index++) {
    const point = engine.getLegalMoves(engine.currentPlayer)[0]?.point;
    const actor = engine.currentPlayer;
    const result = point ? engine.playMove(point) : engine.skipTurn();
    if (!result.success) throw new Error('Synthetic action failed');
    actions.push({ type: point ? 'move' : 'skip', actor, ...(point ? { point } : {}) });
  }
  for (let index = 0; index < playerCount + 1 && !engine.gameOver; index++) {
    actions.push({ type: 'skip', actor: engine.currentPlayer });
    if (!engine.skipTurn().success) throw new Error('Synthetic terminal skip failed');
  }
  if (!engine.gameOver) throw new Error('Synthetic fixture did not terminate');
  const replay = await createReplayDocument(config, actions);
  return { format: 'lifeline-training-contribution', version: 2, consent: true, consent_policy: 'anonymous-replay-training-v2',
    replay, context: { source: 'local', actors: Object.fromEntries(replay.config.players.map((color, index) =>
      [color, index === 1 && profile ? { kind: 'ai', profile } : { kind: 'human' }])), mixedProfiles: false, hintsEnabled: false,
    undo: { enabled: undoUsedCount > 0, maxCount: 3, usedCount: undoUsedCount } } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = process.argv[2] ? JSON.parse(process.argv[2]) : {};
  process.stdout.write(JSON.stringify(await syntheticV2Contribution(options)));
}
