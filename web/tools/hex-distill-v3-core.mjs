import assert from "node:assert/strict";
import { seedFor, canonical } from "./three-player-arena-lib.mjs";
import { saveState } from "../web前端/AIEngine.js";
import { playersFor, roundTeacher, softmax } from "./hex-posttrain-core.mjs";
export const TRAIN_SOURCES = ["web/tools/run-hex-distillation-v3.mjs", "web/tools/hex-distill-v3-core.mjs",
  "web/tools/hex-posttrain-core.mjs", "web/tools/hex-posttrain-protocol.mjs", "web/tools/linear-three-v3-core.mjs",
  "web/tools/three-player-arena-lib.mjs", "web/web前端/GameEngine.js", "web/web前端/AIEngine.js", "web/web前端/HexPlayerAI.js"];
export function validateTraining(c) {
  if (c.schema !== "lifeline-hex-round-distillation-v3" || c.modelId !== "hex-player-policy-v3"
      || canonical(c.sizes) !== "[5,7]" || canonical(c.counts) !== "[4,5,6]"
      || canonical(c.samplePlies) !== "[12,24,48]" || c.prefixMoves !== 8 || c.teacher.shortlist !== 3
      || c.teacher.temperature !== 200 || c.anchorKl !== 0.1 || canonical(c.checkpoints) !== "[8,24,60]"
      || c.maxActions !== 3000 || c.maxGameSeconds !== 90 || c.optimizer.learningRate !== 0.03
      || c.seedNamespace === c.developmentSeedNamespace) throw new Error("Invalid frozen v3 distillation protocol");
  return c;
}
export function trajectories(c) {
  return c.sizes.flatMap((size) => c.counts.flatMap((players) => playersFor(players).map((start) => {
    const id = `n${size}-p${players}-${start}`;
    return { id, size, players, start, seed: seedFor(`${c.seedNamespace}/${id}`) };
  })));
}
export function example(engine, spec, actions, weights, c) {
  const before = saveState(engine);
  const teacher = roundTeacher(engine, weights, c.teacher);
  assert.deepEqual(saveState(engine), before, "Teacher changed source state");
  const options = [...teacher.targets].sort((a, b) => a.point[1] - b.point[1] || a.point[0] - b.point[0]);
  const features = options.map((o) => o.features), scores = options.map((o) => o.score);
  return { id: `${spec.id}-ply${actions.length}`, ...spec, id: `${spec.id}-ply${actions.length}`,
    actor: engine.currentPlayer, actions: structuredClone(actions), points: options.map((o) => o.point), features, scores,
    targets: softmax(scores, c.teacher.temperature), anchor: softmax(features.map((f) => f.reduce((sum, x, i) => sum + x * weights[i], 0))) };
}
export function objective(samples, weights, anchorKl) {
  const gradient = Array(weights.length).fill(0), groups = new Map();
  for (const s of samples) groups.set(`${s.size}/${s.players}`, (groups.get(`${s.size}/${s.players}`) ?? 0) + 1);
  let loss = 0, kl = 0;
  for (const s of samples) {
    const p = softmax(s.features.map((f) => f.reduce((sum, x, i) => sum + x * weights[i], 0)));
    const scale = 1 / groups.size / groups.get(`${s.size}/${s.players}`);
    p.forEach((q, j) => {
      const safe = Math.max(1e-15, q), target = s.targets[j], anchor = s.anchor[j];
      loss -= scale * target * Math.log(safe);
      if (anchor > 0) kl += scale * anchor * Math.log(anchor / safe);
      s.features[j].forEach((x, i) => { gradient[i] += scale * ((q - target) + anchorKl * (q - anchor)) * x; });
    });
  }
  return { loss: loss + anchorKl * kl, crossEntropy: loss, anchorKl: kl, gradient };
}
