import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { engineFor, apply, rng, roundTeacher, policy } from "./hex-posttrain-core.mjs";
const parent = JSON.parse(await readFile(new URL("../web前端/assets/research-ai/hex-player-policy-v1.json", import.meta.url)));
const results = [], started = performance.now();
for (const size of [5, 7]) for (const players of [4, 5, 6]) {
  const engine = engineFor({ size, players, start: "BLACK" }), random = rng(873113 + 100 * size + players);
  for (let ply = 0; ply < 30 && !engine.gameOver; ply++) {
    const legal = engine.getLegalMoves();
    const point = ply < 8 ? legal[Math.floor(random.next() * legal.length)]?.point ?? null : policy(engine, parent.weights)[0]?.point ?? null;
    apply(engine, { actor: engine.currentPlayer, point });
  }
  const before = performance.now(), teacher = roundTeacher(engine, parent.weights, { shortlist: 3 });
  results.push({ size, players, legal: teacher.candidates.length, teacherSeconds: (performance.now() - before) / 1000,
    scoreRange: Math.max(...teacher.targets.map((x) => x.score)) - Math.min(...teacher.targets.map((x) => x.score)) });
}
console.log(JSON.stringify({ status: "CALIBRATION_ONLY", cases: results, wallSeconds: (performance.now() - started) / 1000 }, null, 2));
