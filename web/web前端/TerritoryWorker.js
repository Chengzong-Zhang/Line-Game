import { GameEngine } from "./GameEngine.js?v=20261026-start-protection-v1";
import { deserializeEngineEdges } from "./AIStateProtocol.js?v=20261026-start-protection-v1";

function cloneTerritories(engine, players = engine.activePlayers) {
  return Object.fromEntries(
    players.map((player) => {
      const territory = engine.cachedTerritories[player];
      return [player, {
        polygon: territory.polygon ? territory.polygon.map((point) => [...point]) : null,
        area: territory.area,
        displayArea: territory.displayArea,
      }];
    }),
  );
}

function restoreSerializedState(engine, serializedState) {
  engine.grid = new Map(serializedState.gridEntries);
  engine.edges = deserializeEngineEdges(serializedState, engine.activePlayers);
  engine.historyHashes = new Set(serializedState.historyHashes);
  engine.consecutiveSkips = serializedState.consecutiveSkips;
  engine.resignedPlayers = new Set(serializedState.resignedPlayers ?? []);
  engine.currentPlayer = serializedState.currentPlayer;
  engine.gameOver = serializedState.gameOver;
  engine.turnCount = serializedState.turnCount;
  engine.positionRevision = serializedState.positionRevision ?? 0;
}

// Keep topology buffers and the module/JIT warm between exact calculations.
// Rule code and candidate order remain entirely inside GameEngine.
let reusableEngine = null;
let reusableConfig = "";

self.onmessage = (event) => {
  if (event.data?.type !== "COMPUTE_TERRITORIES") {
    return;
  }

  const requestId = event.data?.requestId ?? null;
  const serializedState = event.data?.serializedState;
  const territoryStateRevision = event.data?.territoryStateRevision;
  const gameOver = Boolean(event.data?.gameOver);

  try {
    if (!serializedState || !Number.isInteger(territoryStateRevision)) {
      throw new Error("Territory worker received an invalid state payload.");
    }

    const options = {
      gridSize: serializedState.gridSize,
      playerCount: serializedState.playerCount,
      boardShape: serializedState.boardShape,
      startPlayer: serializedState.startPlayer,
      initialPositions: serializedState.initialPositions,
      rulesVersion: serializedState.rulesVersion,
      protectionRule: serializedState.protectionRule,
    };
    const config = JSON.stringify(options);
    if (!reusableEngine || config !== reusableConfig) {
      reusableEngine = new GameEngine(options);
      reusableConfig = config;
    }
    const engine = reusableEngine;
    restoreSerializedState(engine, serializedState);
    engine._territoryStateRevision = territoryStateRevision;
    const players = event.data.players ?? engine.activePlayers;
    if (!Array.isArray(players) || !players.length || players.some(player => !engine.activePlayers.includes(player))) {
      throw new Error("Territory worker received invalid players.");
    }
    const started = performance.now();
    for (const player of players) engine.cachedTerritories[player] = engine._computeTerritory(player);

    self.postMessage({
      type: "RESULT",
      requestId,
      positionRevision: serializedState.positionRevision ?? 0,
      rulesVersion: serializedState.rulesVersion,
      protectionRule: serializedState.protectionRule,
      currentPlayer: serializedState.currentPlayer,
      territoryStateRevision,
      gameOver,
      territories: cloneTerritories(engine, players),
      computeMs: performance.now() - started,
    });
  } catch (error) {
    self.postMessage({
      type: "ERROR",
      requestId,
      positionRevision: serializedState?.positionRevision ?? 0,
      rulesVersion: serializedState?.rulesVersion,
      protectionRule: serializedState?.protectionRule,
      currentPlayer: serializedState?.currentPlayer,
      territoryStateRevision,
      gameOver,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
