// Server-selected profiles only. Same rules and algorithms as local practice.
import { executeTask } from '../src/worker-runtime.js';

export async function rankedReply(settings, actions, profile) {
  if (!['greedy', 'minimax-2', 'minimax-3', 'minimax-4'].includes(profile)
    || settings.playerCount !== 2 || settings.gridSize !== 7 || settings.rulesVersion !== 'territory-v3'
    || settings.boardShape !== 'triangle') throw Error('INVALID_RANKED_AI');
  const result = await executeTask({ kind: 'AI', payload: { settings, actions, profile } });
  if (result.player !== 'WHITE' || !Array.isArray(result.moves)) throw Error('INVALID_AI_REPLY');
  const aiAction = result.moves[0]?.point ? { type: 'move', point: result.moves[0].point, player: 'WHITE' }
    : { type: 'skip', player: 'WHITE' };
  return { ...executeTask({ kind: 'APPLY', payload: { settings, actions, action: aiAction } }), aiAction };
}
