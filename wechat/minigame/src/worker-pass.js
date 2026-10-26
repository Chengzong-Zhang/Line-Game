import { GameEngine } from './core.js';
import { restoreState, saveState } from '../../../web/web前端/AIEngine.js';
import { multiplayerClock as performance } from '../../../web/web前端/MultiplayerClock.js';

const TERMINAL_WINNING_PASS_WINDOW_MS = 60;

export function canonicalTerminalWinningPass(engine, player, now = () => performance.now()) {
  try {
    const started = now();
    if (!Number.isFinite(started)) return null;
    const deadline = started + TERMINAL_WINNING_PASS_WINDOW_MS;
    if (engine.gameOver || engine.currentPlayer !== player) return null;
    const remaining = engine.activePlayers.filter((candidate) => !engine.resignedPlayers.has(candidate));
    if (remaining.length < 2 || engine.consecutiveSkips !== remaining.length - 1) return null;

    const isolated = new GameEngine({
      gridSize: engine.gridSize,
      playerCount: engine.playerCount,
      boardShape: engine.boardShape,
      startPlayer: engine.startPlayer,
      initialPositions: engine.initialPositions,
      rulesVersion: engine.rulesVersion,
      protectionRule: engine.protectionRule,
      deferTerritoryUpdates: true,
    });
    restoreState(isolated, saveState(engine));
    isolated._isReplayingBatch = true;
    if (!isolated._hasValidMoves(player)) return null;
    if (now() >= deadline) return null;

    const result = isolated.skipTurn();
    if (!result.success || !isolated.gameOver) return null;
    if (now() >= deadline) return null;
    GameEngine.prototype._updateTerritories.call(isolated);
    if (now() >= deadline) return null;
    const bestArea = Math.max(...remaining.map((candidate) => isolated.cachedTerritories[candidate].area));
    const winners = remaining.filter((candidate) => isolated.cachedTerritories[candidate].area === bestArea);
    const winner = isolated.getWinner();
    if (now() >= deadline || winners.length !== 1 || winners[0] !== player || winner !== player) return null;
    return { point: null, type: "pass", score: 1_000_000 };
  } catch (_) {
    return null;
  }
}

