// Synthetic replay for an isolated collector preflight; never production data.
import { createTopologySetup, useTopologyPreset } from '../../wechat/minigame/src/topology-setup.js';
import { createTopologyReplayDocument, restoreGame } from '../../wechat/minigame/src/state.js';
import { contributionContext } from '../../wechat/minigame/src/training-contribution.js';

const board = useTopologyPreset(createTopologySetup(), 'double-torus', { gridSize: 9, playerCount: 2 }).setup;
const settings = { gridSize: 9, playerCount: 2, startPlayer: 'BLACK', rulesVersion: 'surface-v1', boardShape: 'custom',
  boardDefinition: board.definition, boardHash: board.boardHash, topologyProtocolVersion: 'board-topology-v1',
  rootMode: 'classic', rootRulesVersion: 'root-v1', hintEnabled: false, hintMaxCount: 3,
  turnTimerEnabled: false, turnTimeLimitSeconds: 60, undoEnabled: false, undoMaxCount: 3 };
const vertexId = restoreGame(settings).getSnapshot().legalMoves[0].vertexId;
const actions = [{ type: 'move', player: 'BLACK', vertexId }, { type: 'skip', player: 'WHITE' }, { type: 'skip', player: 'BLACK' }];
const replay = createTopologyReplayDocument(settings, actions);
const context = contributionContext({ settings, controllerFor: () => 'human', undoUsage: { usedCount: 0 } }, 4);
if (!context) throw new Error('fixture context unavailable');
process.stdout.write(JSON.stringify({ format: 'lifeline-training-contribution', version: 4, consent: true,
  consent_policy: 'anonymous-replay-training-v4', replay, context }));
