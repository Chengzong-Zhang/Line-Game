// Composite provenance/export only. Never changes a training run or its identity.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { auditTerminalExtensionV5 } from "./terminal-policy-extension-v5.mjs";
import { loadPassOpportunityParent } from "./train-pass-opportunity-v3.mjs";
import { atomic, root, readJson, sealed, sha, unseal } from "./neural-posttraining-data-v2.mjs";

const check = (ok, message) => { if (!ok) throw Error(message); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const aliases = Object.freeze(["easy", "three-v4", "three-v1", "hex-v1"]);
async function source(runRoot, candidatePath, kind) {
  const raw = await readFile(resolve(runRoot, candidatePath)), candidate = unseal(JSON.parse(raw));
  return { run_root: resolve(runRoot), candidate_path: candidatePath, candidate_sha256: sha(raw),
    training_identity: candidate.identity, kind };
}

export async function composeTerminalV5({ extensionRoot, output, fixture = false }) {
  extensionRoot = resolve(extensionRoot); output = resolve(output);
  const proof = await auditTerminalExtensionV5(extensionRoot);
  const input = unseal(await readJson(resolve(extensionRoot, "extension-input.json")));
  check(input.fixture === fixture, "Composite fixture/formal boundary differs");
  if (!fixture) check(Object.keys(proof.original_run_review.models).length === 4 && proof.cumulative_hex.actual_updates >= 4
    && proof.original_run_review.models["hex-v1"].natural === 24 && proof.new_stage.natural_episodes === 1,
  "Composite requires the original 96 audited games plus one actual extension update");
  const references = {};
  for (const alias of fixture ? ["hex-v1"] : aliases) references[alias] = alias === "hex-v1"
    ? await source(extensionRoot, "extension-candidate.json", "explicit-v5-state-continuation")
    : await source(input.base_root, `models/${alias}/candidate.json`, "original-v4-candidate");
  const body = { schema: "lifeline-terminal-policy-composite-v5", status: "COMPOSITE_TRAINED_NOT_ADMITTED",
    original_run: { run_root: input.base_root, training_identity: input.parent_identity,
      checkpoint_sha256: input.parent_checkpoint_sha256, prior_candidates: input.prior_candidates,
      completion_status: "ORIGINAL_MIN4_HEX_FAILURE_PRESERVED" },
    extension_run: { run_root: extensionRoot, training_identity: input.identity,
      receipt_sha256: sha(await readFile(resolve(extensionRoot, "extension-receipt.json"))), stage_id: input.stage_id },
    references, totals: { original_natural_games: Object.values(proof.original_run_review.models).reduce((s, m) => s + m.natural, 0),
      new_natural_games: 1, cumulative_hex_natural_games: proof.cumulative_hex.natural_episodes,
      cumulative_hex_updates: proof.cumulative_hex.actual_updates, new_hex_updates: proof.new_stage.actual_updates },
    native_hex_prior_gradient_samples: proof.native_hex_prior_gradient_samples,
    fixture, strength_verified: false, runtime_admitted: false,
    provenance: "Per-model source identities remain distinct. No old candidate, counter, receipt or source is relabelled as this composite.",
    composer_source_sha256: sha(await readFile(fileURLToPath(import.meta.url))) };
  const manifest = { ...body, identity: sha(JSON.stringify(body)) };
  await atomic(output, sealed(manifest));
  await auditCompositeTerminalV5(output, { allowFixture: fixture });
  return { status: manifest.status, manifest: output, identity: manifest.identity, references, totals: manifest.totals, fixture };
}

export async function auditCompositeTerminalV5(path, { allowFixture = false } = {}) {
  const manifest = unseal(await readJson(resolve(path)));
  const { identity, ...body } = manifest;
  check(manifest.schema === "lifeline-terminal-policy-composite-v5" && sha(JSON.stringify(body)) === identity,
    "Composite manifest identity mismatch");
  check(!manifest.fixture || allowFixture, "A recovery fixture cannot qualify a product composite");
  check(manifest.strength_verified === false && manifest.runtime_admitted === false, "Training composite cannot self-admit");
  const proof = await auditTerminalExtensionV5(manifest.extension_run.run_root);
  const input = unseal(await readJson(resolve(manifest.extension_run.run_root, "extension-input.json")));
  const config = await readJson(resolve(manifest.extension_run.run_root, "protocol.json"));
  check(manifest.fixture === input.fixture && manifest.fixture === config.extension_v5.fixture
    && manifest.fixture === proof.fixture && manifest.extension_run.stage_id === input.stage_id,
  "Composite fixture flag/stage differs from frozen extension input/config");
  check(same(manifest.original_run.prior_candidates, input.prior_candidates), "Composite prior candidate byte snapshot differs");
  check(proof.identity === manifest.extension_run.training_identity && proof.base_identity === manifest.original_run.training_identity
    && resolve(proof.base_root) === resolve(manifest.original_run.run_root)
    && proof.parent_checkpoint_sha256 === manifest.original_run.checkpoint_sha256
    && sha(await readFile(resolve(manifest.original_run.run_root, "checkpoint.json"))) === manifest.original_run.checkpoint_sha256
    && sha(await readFile(resolve(manifest.extension_run.run_root, "extension-receipt.json"))) === manifest.extension_run.receipt_sha256,
  "Composite stage identities/hashes differ");
  const cp = unseal(await readJson(resolve(manifest.original_run.run_root, "checkpoint.json")));
  const models = {};
  check(same(Object.keys(manifest.references).sort(), (manifest.fixture ? ["hex-v1"] : [...aliases]).sort()), "Composite model set differs");
  for (const [alias, ref] of Object.entries(manifest.references)) {
    const bytes = await readFile(resolve(ref.run_root, ref.candidate_path));
    check(sha(bytes) === ref.candidate_sha256, `${alias}: referenced candidate changed`);
    const candidate = unseal(JSON.parse(bytes)), original = await loadPassOpportunityParent(alias);
    check(candidate.identity === ref.training_identity && Array.isArray(candidate.weights) && candidate.weights.length === 17
      && candidate.weights.every(Number.isFinite) && candidate.weights[16] === candidate.passBias,
    `${alias}: actual candidate identity/weights differ`);
    let natural, updates, samples;
    if (alias === "hex-v1") {
      check(resolve(ref.run_root) === resolve(manifest.extension_run.run_root) && ref.candidate_path === "extension-candidate.json", "Hex reference is not its declared extension artifact");
      const extensionCp = unseal(await readJson(resolve(manifest.extension_run.run_root, "checkpoint.json")));
      check(same(candidate.weights, extensionCp.models[alias].weights) && candidate.passBias === candidate.weights[16]
        && same(candidate.runtime_spec.weights, candidate.weights.slice(0, 16)) && candidate.runtime_spec.passBias === candidate.passBias,
      "Hex candidate/runtime weights differ from independently audited continuation SGD");
      check(candidate.schema === "lifeline-terminal-policy-extension-candidate-v5"
        && candidate.lineage.direct_parent_identity === manifest.original_run.training_identity
        && candidate.lineage.direct_parent_checkpoint_sha256 === manifest.original_run.checkpoint_sha256
        && same(candidate.lineage.direct_parent_weights, cp.models[alias].weights)
        && same(candidate.training.new_stage, proof.new_stage) && same(candidate.training.cumulative, proof.cumulative_hex),
      "Hex continuation/direct-parent/cumulative provenance differs");
      check(candidate.lineage.original_parent.parent_id === original.id
        && candidate.lineage.original_parent.parent_sha256 === original.sha256, "Hex original overlay ancestor differs");
      natural = proof.cumulative_hex.natural_episodes; updates = proof.cumulative_hex.actual_updates; samples = proof.cumulative_hex.eligible_samples;
    } else {
      check(resolve(ref.run_root) === resolve(manifest.original_run.run_root) && ref.candidate_path === `models/${alias}/candidate.json`, `${alias}: reference is not its original candidate`);
      const originalBytes = input.prior_candidates[alias];
      check(originalBytes && originalBytes.sha256 === ref.candidate_sha256 && originalBytes.identity === ref.training_identity,
        `${alias}: prior candidate frozen byte hash/identity differs`);
      const old = proof.original_run_review.models[alias];
      check(candidate.schema === "lifeline-terminal-policy-linear17-candidate-v4"
        && candidate.identity === manifest.original_run.training_identity && same(candidate.weights, cp.models[alias].weights)
        && candidate.lineage.parent_id === original.id && candidate.lineage.parent_sha256 === original.sha256
        && same(candidate.lineage.initial_weights, original.initialWeights)
        && old.natural_episode_target_met && old.minimum_updates_met, `${alias}: original trained ancestor differs`);
      natural = old.natural; updates = old.actual_updates; samples = old.eligible_samples;
    }
    const depths = [];
    for (const record of cp.models[alias].completed) {
      const episode = unseal(await readJson(resolve(manifest.original_run.run_root, record.path)));
      depths.push(...episode.eligibleSamples.map(s => s.analysisCompletedDepth));
    }
    if (alias === "hex-v1") {
      const extCp = unseal(await readJson(resolve(manifest.extension_run.run_root, "checkpoint.json")));
      for (const record of extCp.models[alias].completed) {
        const episode = unseal(await readJson(resolve(manifest.extension_run.run_root, record.path)));
        depths.push(...episode.eligibleSamples.map(s => s.analysisCompletedDepth));
      }
    }
    check(depths.length === samples && depths.length > 0 && Math.min(...depths) >= 3
      && natural >= updates && (manifest.fixture || updates >= 4), `${alias}: audited actual updates/depths differ`);
    models[alias] = { ...ref, naturally_completed_episodes: natural, actual_updates: updates,
      eligible_samples: samples, minimum_completed_depth: Math.min(...depths), original_parent_id: original.id,
      original_parent_sha256: original.sha256, native_hex_gradient_samples: alias === "hex-v1" ? proof.native_hex_prior_gradient_samples : undefined };
  }
  const originalNatural = Object.values(proof.original_run_review.models).reduce((s, m) => s + m.natural, 0);
  check(manifest.totals.original_natural_games === originalNatural && manifest.totals.new_natural_games === 1
    && manifest.totals.cumulative_hex_updates === proof.cumulative_hex.actual_updates,
  "Composite actual game/update totals differ");
  return { schema: "lifeline-terminal-policy-composite-review-v5", status: "PASS_EXPLICIT_COMPOSITE_TRAINING_EVIDENCE",
    identity, manifest_sha256: sha(await readFile(resolve(path))), models, totals: manifest.totals,
    original_failure_preserved: true, native_hex_prior_gradient_samples: proof.native_hex_prior_gradient_samples,
    fixture: manifest.fixture, strength_verified: false, runtime_admitted: false };
}

export async function exportCompositeTerminalV5({ manifestPath, output }) {
  const audit = await auditCompositeTerminalV5(manifestPath), manifest = unseal(await readJson(resolve(manifestPath))), models = {};
  check(!audit.fixture && audit.totals.original_natural_games === 96 && audit.totals.new_natural_games === 1, "Only the explicit 96+1 formal composite may export");
  let reward;
  for (const alias of aliases) {
    const ref = manifest.references[alias], candidate = unseal(await readJson(resolve(ref.run_root, ref.candidate_path)));
    const original = await loadPassOpportunityParent(alias), info = audit.models[alias];
    const actualReward = candidate.training.reward;
    check(actualReward.gamma === 1 && actualReward.nonterminal_reward === 0, "Composite reward/gamma mismatch");
    if (reward) check(same(reward, actualReward), "Per-model reward protocols differ"); else reward = actualReward;
    models[alias] = { id: candidate.runtime_spec.id, parent_id: original.id, parent_sha256: original.sha256,
      parent_weights: original.weights, parent_temperature: original.temperature,
      weights: candidate.weights, passBias: candidate.passBias, candidate_sha256: ref.candidate_sha256,
      training_identity: ref.training_identity, updates: info.actual_updates, training_samples: info.eligible_samples,
      naturally_completed_episodes: info.naturally_completed_episodes, truncated_episodes: 0,
      minimum_completed_depth: info.minimum_completed_depth,
      training_provenance: { composite_identity: manifest.identity, source_kind: ref.kind,
        source_run_identity: ref.training_identity, cumulative_counts: alias === "hex-v1", new_stage_updates: alias === "hex-v1" ? 1 : info.actual_updates,
        native_hex_gradient_samples: alias === "hex-v1" ? audit.native_hex_prior_gradient_samples : undefined } };
  }
  const data = { schema: "lifeline-terminal-trained-policies-v4", revision: "terminal-policy-explicit-extension-v5-20261025",
    activation: "EVALUATION_ONLY", reward, training_identity: manifest.identity,
    training_completion_sha256: audit.manifest_sha256, composite_schema: manifest.schema,
    per_model_identities: Object.fromEntries(aliases.map(a => [a, manifest.references[a].training_identity])), models };
  output = resolve(output); await mkdir(dirname(output), { recursive: true });
  await writeFile(output, "// Explicit v4+v5 composite; distinct model source identities and original failure are preserved.\n"
    + "export const PASS_TRAINED_POLICY_DATA = Object.freeze(" + JSON.stringify(data, null, 2) + ");\n");
  return { status: "EXPORTED_EXPLICIT_COMPOSITE_FOR_EVALUATION_ONLY", output: relative(root, output), sha256: sha(await readFile(output)),
    composite_identity: manifest.identity, candidate_hashes: Object.fromEntries(aliases.map(a => [a, models[a].candidate_sha256])) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(3), option = name => args.includes(name) ? args[args.indexOf(name) + 1] : null;
  try {
    if (process.argv[2] === "compose") console.log(JSON.stringify(await composeTerminalV5({ extensionRoot: option("--extension-root"), output: option("--output"), fixture: args.includes("--fixture") })));
    else if (process.argv[2] === "audit") console.log(JSON.stringify(await auditCompositeTerminalV5(option("--manifest"), { allowFixture: args.includes("--fixture") })));
    else if (process.argv[2] === "export") console.log(JSON.stringify(await exportCompositeTerminalV5({ manifestPath: option("--manifest"), output: option("--output") })));
    else throw Error("Use compose, audit or export with explicit artifact paths");
  } catch (error) { console.error(error.stack); process.exitCode = 78; }
}
