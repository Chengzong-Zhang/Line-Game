import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { engineFor, policy, playersFor } from "../../tools/hex-posttrain-core.mjs";
import { saveState } from "../AIEngine.js";
import { readModel } from "../../tools/hex-posttrain-protocol.mjs";

const args = process.argv.slice(2);
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const modelPath = resolve(option("--model", "local_artifacts/hex-player-posttrain-v2/train-20261021-r1/hex-player-policy-v2.json"));
const candidate = await readModel(modelPath, "hex-player-policy-v2"), checks = [];
for (const players of [4, 5, 6]) for (const start of playersFor(players)) {
  const engine = engineFor({ size: 9, players, start }), before = saveState(engine);
  const choices = policy(engine, candidate.model.weights);
  assert.ok(choices.length > 0 && choices.every((c) => Number.isFinite(c.score) && c.features.every(Number.isFinite)));
  assert.deepEqual(saveState(engine), before);
  assert.ok(engine.playMove(choices[0].point).success);
  checks.push({ size: 9, players, start, legal: true, statePreserved: true, finite: true });
}
const report = { status: "PASS", candidateSha256: candidate.hash, checks,
  command: `node web/web前端/tests/verify-hex-posttraining-compatibility.mjs --model "${modelPath}"`,
  scope: "15 initial-position legal finite inference and state-preservation probes on size9; not complete games or strength evidence" };
if (option("--output", null)) await writeFile(resolve(option("--output")), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ status: "PASS", probes: checks.length, candidateSha256: candidate.hash }));
