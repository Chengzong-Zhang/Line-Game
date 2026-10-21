import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { threePlayerCandidates } from "../web前端/ThreePlayerAI.js";
import { COLORS, createRng, engineFromActions, policyMoves, terminalOutcome } from "./three-player-posttraining-core.mjs";
import { policyProbabilities, samplePolicy } from "./linear-three-v3-core.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const parent = JSON.parse(await readFile(resolve(root, "web/web前端/assets/research-ai/three-player-policy-v2.json")));
const baseline = JSON.parse(await readFile(resolve(root, "web/web前端/assets/research-ai/three-player-policy-v1.json")));
const games = [];
for (const size of [5, 7, 9]) for (const start of COLORS) {
  const engine = engineFromActions({ size, start }), rng = createRng(size * 97001 + COLORS.indexOf(start) + 711);
  const started = performance.now();
  let plies = 0;
  while (!engine.gameOver && plies < 360) {
    const candidates = threePlayerCandidates(engine);
    if (!candidates.length) engine.skipTurn();
    else {
      const point = engine.currentPlayer === start
        ? candidates[samplePolicy(policyProbabilities(candidates.map((x) => x.features), parent.weights), () => rng.next())].point
        : policyMoves(engine, baseline.weights, candidates)[0].point;
      if (!engine.playMove(point).success) throw new Error("Illegal calibration move.");
    }
    plies++;
  }
  if (!engine.gameOver) throw new Error("Calibration did not terminate within budget.");
  games.push({ size, start, plies, milliseconds: performance.now() - started, outcome: terminalOutcome(engine) });
}
const output = resolve(root, "local_artifacts/three-player-v3-calibration");
await mkdir(output, { recursive: true });
const receipt = { status: "CALIBRATION-ONLY", games, source_sha256: createHash("sha256").update(await readFile(new URL("./linear-three-v3-core.mjs", import.meta.url))).digest("hex") };
await writeFile(resolve(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt, null, 2));
