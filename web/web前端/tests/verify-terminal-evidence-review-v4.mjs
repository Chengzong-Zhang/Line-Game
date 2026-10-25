import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { reviewTerminalEvidence } from "../../tools/review-terminal-policy-evidence-v4.mjs";
import { terminalPolicyTrainMain } from "../../tools/train-terminal-policy-v4.mjs";
import { atomic, readJson, root, sealed, sha, unseal } from "../../tools/neural-posttraining-data-v2.mjs";

const base = await mkdtemp(resolve(root, "local_artifacts/terminal-v4-review-negative-"));
const source = resolve(base, "clean"); await mkdir(source);
const config = await readJson(resolve(root, "web/tools/configs/terminal-policy-v4-20261025.json"));
config.status = "INDEPENDENT_REVIEW_TINY_NEGATIVE_FIXTURE";
config.parents = [{ alias: "easy", cells: [{ players: 2, shape: "triangle", size: 5 }] }];
config.episodes_per_parent = 1; config.minimum_actual_updates_per_parent = 1;
config.analysis = { max_attempts_per_episode: 2, learner_turns: [0, 1], max_nodes: 30000, time_ms: 5000,
  action_mask: "lexicographic-defense-prefix-0-1-4" };
await atomic(resolve(source, "protocol.json"), config);
assert.equal(await terminalPolicyTrainMain(["--run-root", source, "--config", resolve(source, "protocol.json"),
  "--max-new-units", "200", "--max-seconds", "20"]), 0);
assert.equal((await reviewTerminalEvidence(source)).status, "PASS_COMPLETED_TERMINAL_TRAINING_EVIDENCE");
const cases = [];
for (const [name, expected] of [["wrong-terminal-reward", /native-area reward/], ["wrong-discount", /discount\/return/],
  ["wrong-gradient-update", /actual parameter update/], ["wrong-defensive-mask", /mask differs/]]) {
  const run = resolve(base, name); await cp(source, run, { recursive: true });
  const checkpoint = unseal(await readJson(resolve(run, "checkpoint.json")));
  const record = checkpoint.models.easy.completed[0], episode = unseal(await readJson(resolve(run, record.path)));
  if (name === "wrong-terminal-reward") episode.terminalReward += 0.1;
  if (name === "wrong-discount") episode.eligibleSamples[0].gamma = 0.9;
  if (name === "wrong-gradient-update") episode.updatedWeights[0] += 0.1;
  if (name === "wrong-defensive-mask") {
    const step = episode.steps[episode.eligibleSamples[0].ply], row = unseal(await readJson(resolve(run, step.path)));
    row.analysis.defenseMask.indices.pop(); await atomic(resolve(run, step.path), sealed(row));
    step.sha256 = sha(await readFile(resolve(run, step.path)));
  }
  // Update the outer integrity chain so rejection must come from semantic
  // reconstruction, rather than merely detecting a stale file hash.
  await atomic(resolve(run, record.path), sealed(episode)); record.sha256 = sha(await readFile(resolve(run, record.path)));
  await atomic(resolve(run, "checkpoint.json"), sealed(checkpoint));
  await assert.rejects(reviewTerminalEvidence(run), expected);
  cases.push({ case: name, valid_outer_hashes: true, rejected: true });
}
const receipt = { status: "PASS_TERMINAL_V4_INDEPENDENT_REVIEW_NEGATIVE_FIXTURES", base, cases,
  command: "node web/web前端/tests/verify-terminal-evidence-review-v4.mjs", formal_run_modified: false };
await atomic(resolve(base, "receipt.json"), receipt); console.log(JSON.stringify(receipt));
