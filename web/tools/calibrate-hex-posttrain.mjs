import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { engineFor, policy, apply, outcome } from "./hex-posttrain-core.mjs";

const model = JSON.parse(await readFile("web/web前端/assets/research-ai/hex-player-policy-v1.json", "utf8"));
const results = [];
for (const size of [5, 7, 9]) {
  const engine = engineFor({ size, players: 6, start: "BLACK" });
  const start = performance.now();
  let actions = 0;
  while (!engine.gameOver && actions < 500 && performance.now() - start < 60000) {
    const point = policy(engine, model.weights)[0]?.point ?? null;
    apply(engine, { actor: engine.currentPlayer, point });
    actions += 1;
  }
  results.push({ size, players: 6, elapsedMs: performance.now() - start, actions,
    terminal: engine.gameOver, outcome: engine.gameOver ? outcome(engine) : null });
  console.log(JSON.stringify(results.at(-1)));
}
await mkdir("local_artifacts/hex-posttrain-v2-calibration", { recursive: true });
await writeFile(resolve("local_artifacts/hex-posttrain-v2-calibration/game-throughput.json"),
  `${JSON.stringify({ stage: "CALIBRATION_ONLY", results }, null, 2)}\n`);
