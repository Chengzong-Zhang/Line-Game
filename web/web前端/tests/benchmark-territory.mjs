import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";

const engineSource = await fs.readFile(new URL("../GameEngine.js", import.meta.url), "utf8");
const { GameEngine, TerritoryRulesVersion } = await import(
  `data:text/javascript;base64,${Buffer.from(engineSource).toString("base64")}`
);

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function benchmark(gridSize, rulesVersion, samples = 5) {
  const constructorMs = [];
  const firstMoveMs = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let started = performance.now();
    const game = new GameEngine({ gridSize, playerCount: 2, rulesVersion });
    constructorMs.push(performance.now() - started);

    started = performance.now();
    const result = game.playMove([2, 0]);
    if (!result.success) throw new Error(`grid ${gridSize}: deterministic first move failed`);
    firstMoveMs.push(performance.now() - started);
  }
  return {
    scenario: "constructor-and-first-move-smoke",
    gridSize,
    rulesVersion,
    samples,
    constructorMedianMs: Number(median(constructorMs).toFixed(3)),
    firstMoveMedianMs: Number(median(firstMoveMs).toFixed(3)),
  };
}

const results = [];
for (const gridSize of [5, 9, 15]) {
  for (const rulesVersion of [TerritoryRulesVersion.V1, TerritoryRulesVersion.V2]) {
    results.push(benchmark(gridSize, rulesVersion));
  }
}
console.log(JSON.stringify(results, null, 2));
