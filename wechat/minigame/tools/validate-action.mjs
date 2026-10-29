// Backend-only entry. Uses exactly the same rules/state hash as the Mini Game.
import { executeTask } from '../src/worker-runtime.js';
import { restoreGame, TOPOLOGY_PROTOCOL_VERSION } from '../src/state.js';
import { rankedReply, prepareRankedMatch } from './ranked-ai.mjs';
let raw = '';
for await (const chunk of process.stdin) {
  raw += chunk;
  if (raw.length > 512000) throw new Error('INPUT_TOO_LARGE');
}
try {
  const payload = JSON.parse(raw);
  // Worker context is derived from a fresh authoritative replay, never from
  // untrusted request data. It is only required for surface APPLY tasks.
  const engine = payload.action && !payload.rankedSetup && !payload.aiProfile
    ? restoreGame(payload.settings, payload.actions) : null;
  const context = engine?.isTopologyBoard ? {
    boardHash: engine.boardHash, topologyProtocolVersion: TOPOLOGY_PROTOCOL_VERSION,
    revision: engine.positionRevision, player: engine.currentPlayer,
  } : undefined;
  const { snapshot, stateHash, aiAction, ...prepared } = payload.rankedSetup
    ? await prepareRankedMatch(payload.rankedSetup)
    : payload.aiProfile
    ? await rankedReply(payload.settings, payload.actions, payload.aiProfile, payload.aiRuntime)
    : executeTask({ kind: payload.action ? 'APPLY' : 'STATE', payload, context });
  process.stdout.write(JSON.stringify({ stateHash, currentPlayer: snapshot.currentPlayer,
    gameOver: snapshot.gameOver, winner: snapshot.winner, ...(aiAction ? { aiAction } : {}),
    scores: Object.fromEntries(snapshot.players.map(p => [p, snapshot.territories[p].area])),
    resigned: snapshot.resignedPlayers || [], resignedPlayers: snapshot.resignedPlayers || [], ...(payload.rankedSetup ? {
      settings: prepared.settings, controllers: prepared.controllers, humanPlayer: prepared.humanPlayer, context: prepared.context } : {}) }));
} catch (error) { process.stderr.write(error.message === 'AI_VERSION_CHANGED' ? 'AI_VERSION_CHANGED' : 'RULE_VALIDATION_FAILED'); process.exitCode = 1; }
