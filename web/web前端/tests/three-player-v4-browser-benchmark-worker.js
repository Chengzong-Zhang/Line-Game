import { GameEngine } from "../GameEngine.js";
import { ThreePlayerSearchAI } from "../ThreePlayerSearchAI.js";

self.onmessage = async ({ data }) => {
  try {
    const policy = new ThreePlayerSearchAI(data.candidate), rows = [];
    for (const position of data.positions.positions) {
      const engine = new GameEngine({ gridSize: position.size, playerCount: 3,
        rulesVersion: "territory-v2", startPlayer: position.startPlayer });
      engine._isReplayingBatch = true;
      // Match the existing production worker's search-time updater override.
      engine._updateTerritories = () => {};
      for (const action of position.actions) {
        if (!(action.type === "move" ? engine.playMove(action.point) : engine.skipTurn()).success) throw new Error("Invalid benchmark prefix");
      }
      const before = engine._computeStateHash(engine.currentPlayer), history = [...engine.historyHashes].join("\n");
      const timings = [];
      let selected = null;
      for (let iteration = 0; iteration < 3; iteration++) {
        const start = performance.now();
        const choice = policy.getTopMoves(engine, engine.currentPlayer, 1)[0]?.point ?? null;
        timings.push(performance.now() - start);
        if (iteration && JSON.stringify(choice) !== JSON.stringify(selected)) throw new Error("Nondeterministic browser choice");
        selected = choice;
        if (engine._computeStateHash(engine.currentPlayer) !== before || [...engine.historyHashes].join("\n") !== history) throw new Error("Browser state mutation");
      }
      rows.push({ id: position.id, size: position.size, timingsMs: timings, point: selected, simulatedActions: policy.lastSearch.simulatedActions });
      self.postMessage({ status: "RUNNING", completed: rows.length, planned: data.positions.positions.length });
    }
    self.postMessage({ status: "PASS_BROWSER_WORKER_LATENCY_AND_STATE", modelId: data.candidate.id,
      userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, rows,
      scope: "Fixed local calibration positions, native module Worker, production instance updater suppression; no human-play or production deployment claim." });
  } catch (error) { self.postMessage({ status: "FAIL", error: error.stack ?? String(error) }); }
};
