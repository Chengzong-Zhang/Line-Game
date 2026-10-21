import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { engineFromActions, maxNTeacher, policyMoves } from "./three-player-posttraining-core.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const parent = JSON.parse(await readFile(resolve(root, "web/web前端/assets/research-ai/three-player-policy-v1.json"), "utf8"));
const measurements = [];
for (const size of [5, 7, 9]) {
  const engine = engineFromActions({ size, start: "BLACK" });
  for (let ply = 0; ply < 9 && !engine.gameOver; ply++) {
    if ([0, 4, 8].includes(ply)) {
      const started = performance.now();
      const result = maxNTeacher(engine, { depth: 3, replyWidth: 4 });
      measurements.push({ size, ply, milliseconds: performance.now() - started, legalRootActions: result.moves.length, nodes: result.nodes });
    }
    const move = policyMoves(engine, parent.weights)[0];
    if (move) engine.playMove(move.point); else engine.skipTurn();
  }
}
const directory = resolve(root, "local_artifacts/three-player-v2-calibration");
await mkdir(directory, { recursive: true });
const receipt = { status: "CALIBRATION-ONLY", measurements,
  source_sha256: createHash("sha256").update(await readFile(new URL("./three-player-posttraining-core.mjs", import.meta.url))).digest("hex") };
await writeFile(resolve(directory, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt, null, 2));
