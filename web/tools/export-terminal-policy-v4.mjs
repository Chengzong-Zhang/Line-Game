// Export four continued policies without rewriting any parent model asset.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPassOpportunityParent } from "./train-pass-opportunity-v3.mjs";
import { root, sha, unseal } from "./neural-posttraining-data-v2.mjs";

const check = (ok, message) => { if (!ok) throw Error(message); };
const aliases = ["easy", "three-v4", "three-v1", "hex-v1"];
export async function exportTerminalPolicies(args) {
  const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : null;
  check(option("--run-root"), "Use --run-root COMPLETED_TERMINAL_RUN [--output FILE]");
  const run = resolve(option("--run-root"));
  const output = resolve(option("--output") ?? resolve(root, "web/web前端/PassTrainedPolicyData.js"));
  const completionBytes = await readFile(resolve(run, "completion-receipt.json"));
  const completion = unseal(JSON.parse(completionBytes));
  check(completion.schema === "lifeline-terminal-policy-completion-v4"
    && completion.status === "TERMINAL_TRAINING_COMPLETE_NOT_ADMITTED"
    && completion.gamma === 1 && completion.reward.nonterminal_reward === 0,
  "Only completed terminal-only gamma=1 training can be exported");
  const models = {};
  for (const alias of aliases) {
    const raw = await readFile(resolve(run, "models", alias, "candidate.json"));
    const candidate = unseal(JSON.parse(raw)), parent = await loadPassOpportunityParent(alias);
    check(sha(raw) === completion.models[alias]?.candidate_sha256
      && candidate.schema === "lifeline-terminal-policy-linear17-candidate-v4"
      && candidate.identity === completion.identity && candidate.parent_alias === alias
      && candidate.lineage.parent_id === parent.id && candidate.lineage.parent_sha256 === parent.sha256
      && JSON.stringify(candidate.lineage.initial_weights) === JSON.stringify(parent.initialWeights)
      && candidate.training.gamma === 1 && candidate.training.reward.nonterminal_reward === 0
      && candidate.training.actual_parameter_updates >= candidate.training.recipe.minimum_actual_updates_per_parent
      && candidate.weights.length === 17 && candidate.weights.every(Number.isFinite)
      && candidate.weights.some((w, i) => w !== parent.initialWeights[i]),
    `Invalid completed continuation or unchanged weights: ${alias}`);
    const cp = unseal(JSON.parse(await readFile(resolve(run, "checkpoint.json"))));
    const depths = [];
    for (const record of cp.models[alias].completed) {
      const bytes = await readFile(resolve(run, record.path));
      check(sha(bytes) === record.sha256, "Episode receipt changed before export");
      const episode = unseal(JSON.parse(bytes));
      check(episode.gamma === 1 && episode.nonterminalRewardSum === 0
        && (!episode.truncated || !episode.modelUpdated && !episode.optimizerStepApplied), "Invalid episode reward/update contract");
      for (const sample of episode.eligibleSamples) depths.push(sample.analysisCompletedDepth);
    }
    check(depths.length === candidate.training.eligible_minimax_samples && depths.length > 0
      && Math.min(...depths) >= 3, "No complete deep-search gradient samples");
    models[alias] = { id: candidate.runtime_spec.id, parent_id: parent.id, parent_sha256: parent.sha256,
      parent_weights: parent.weights, parent_temperature: parent.temperature,
      weights: candidate.weights, passBias: candidate.passBias, candidate_sha256: sha(raw),
      training_identity: candidate.identity, updates: candidate.training.actual_parameter_updates,
      training_samples: depths.length, naturally_completed_episodes: candidate.training.naturally_completed_episodes,
      truncated_episodes: candidate.training.truncated_episodes, minimum_completed_depth: Math.min(...depths) };
  }
  const data = { schema: "lifeline-terminal-trained-policies-v4", revision: "terminal-policy-v4-20261025",
    activation: "EVALUATION_ONLY", reward: completion.reward, training_identity: completion.identity,
    training_completion_sha256: sha(completionBytes), models };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, "// Generated from completed terminal-only training; parent assets remain unchanged.\n"
    + "export const PASS_TRAINED_POLICY_DATA = Object.freeze(" + JSON.stringify(data, null, 2) + ");\n");
  return { status: "EXPORTED_FOR_ISOLATED_EVALUATION_ONLY", output: relative(root, output),
    sha256: sha(await readFile(output)), candidates: Object.fromEntries(aliases.map(alias => [alias, models[alias].candidate_sha256])) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await exportTerminalPolicies(process.argv.slice(2)))); }
  catch (error) { console.error(error.stack); process.exitCode = 78; }
}
