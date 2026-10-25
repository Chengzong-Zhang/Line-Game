// Backend-only entry. Uses exactly the same rules/state hash as the Mini Game.
import { executeTask } from '../src/worker-runtime.js';
let raw = '';
for await (const chunk of process.stdin) {
  raw += chunk;
  if (raw.length > 512000) throw new Error('INPUT_TOO_LARGE');
}
try {
  const payload = JSON.parse(raw);
  const { snapshot, stateHash } = executeTask({ kind: payload.action ? 'APPLY' : 'STATE', payload });
  process.stdout.write(JSON.stringify({ stateHash, currentPlayer: snapshot.currentPlayer,
    gameOver: snapshot.gameOver, winner: snapshot.winner,
    resignedPlayers: snapshot.resignedPlayers,
    scores: Object.fromEntries(snapshot.players.map(color => [color, snapshot.territories[color].area])) }));
} catch (_) { process.stderr.write('RULE_VALIDATION_FAILED'); process.exitCode = 1; }
