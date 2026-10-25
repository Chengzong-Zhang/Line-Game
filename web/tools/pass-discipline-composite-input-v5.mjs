// Evaluation adapter only: a composite has distinct per-model training identities.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditCompositeTerminalV5 } from './compose-terminal-policy-v5.mjs';
import { root, unseal, sha } from './neural-posttraining-data-v2.mjs';

const check = (ok, message) => { if (!ok) throw Error(message); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const passParentAliases = Object.freeze(['easy', 'three-v4', 'three-v1', 'hex-v1']);
export const PASS_COMPOSITE_PROTOCOL_SHA256 = '6af123a320867571df97e73c65d82a758d97e5b34d53b8aab74305c52a599531';
export function assertPassCompositeProtocol(bytes) {
  check(sha(bytes) === PASS_COMPOSITE_PROTOCOL_SHA256,
    'Explicit v5 composite requires the unchanged revision-2 34-game/8-layout/1500-second protocol');
}
export async function passCompositeReferences(manifestPath) {
  manifestPath = resolve(manifestPath);
  const manifestBytes = await readFile(manifestPath), manifest = unseal(JSON.parse(manifestBytes));
  const { identity, ...body } = manifest;
  check(manifest.schema === 'lifeline-terminal-policy-composite-v5' && sha(JSON.stringify(body)) === identity
    && manifest.fixture === false && manifest.strength_verified === false && manifest.runtime_admitted === false,
  'Evaluation requires an explicit formal, unadmitted v5 composite');
  check(same(Object.keys(manifest.references ?? {}).sort(), [...passParentAliases].sort()), 'Composite must reference exactly four parents');
  const paths = {}, hashes = {}, models = {};
  for (const alias of passParentAliases) {
    const ref = manifest.references[alias];
    const path = resolve(ref.run_root, ref.candidate_path), bytes = await readFile(path), candidate = unseal(JSON.parse(bytes));
    check(sha(bytes) === ref.candidate_sha256 && candidate.identity === ref.training_identity
      && (alias === 'hex-v1' || candidate.parent_alias === alias)
      && candidate.schema === (alias === 'hex-v1' ? 'lifeline-terminal-policy-extension-candidate-v5' : 'lifeline-terminal-policy-linear17-candidate-v4')
      && candidate.weights?.length === 17 && candidate.weights.every(Number.isFinite)
      && same(candidate.runtime_spec?.weights, candidate.weights.slice(0, 16)) && candidate.passBias === candidate.weights[16]
      && candidate.runtime_spec.passBias === candidate.weights[16] && candidate.runtime_spec.temperature === 1,
    `${alias}: audited candidate bytes/actual runtime parameters differ`);
    paths[alias] = path; hashes[alias] = sha(bytes);
    models[alias] = { ...ref, runtime_parameters_sha256: sha(JSON.stringify({ weights: candidate.weights.slice(0, 16),
      passBias: candidate.weights[16], temperature: 1, rules_version: 'territory-v3' })) };
  }
  const evidencePaths = [manifestPath, ...Object.values(paths),
    resolve(manifest.original_run.run_root, 'checkpoint.json'),
    ...['extension-receipt.json', 'checkpoint.json', 'extension-input.json', 'protocol.json', 'frozen-sources.json']
      .map(name => resolve(manifest.extension_run.run_root, name)),
    fileURLToPath(import.meta.url), ...['compose-terminal-policy-v5.mjs', 'terminal-policy-extension-v5.mjs',
      'review-terminal-canonical-features-v5.mjs', 'review-terminal-policy-evidence-v4.mjs']
      .map(name => resolve(root, 'web/tools', name))];
  const evidenceHashes = {};
  for (const path of evidencePaths) evidenceHashes[path] = sha(await readFile(path));
  return { kind: 'explicit-v5-composite', manifestPath, manifest, manifestSha256: sha(manifestBytes), identity,
    paths, hashes, models, evidenceHashes };
}

export async function passCompositeInput(manifestPath, { audit = auditCompositeTerminalV5 } = {}) {
  const input = await passCompositeReferences(manifestPath), proof = await audit(input.manifestPath);
  check(proof.status === 'PASS_EXPLICIT_COMPOSITE_TRAINING_EVIDENCE' && proof.identity === input.identity
    && proof.manifest_sha256 === input.manifestSha256 && proof.fixture === false && proof.original_failure_preserved === true
    && proof.totals.original_natural_games === 96 && proof.totals.new_natural_games === 1
    && proof.totals.cumulative_hex_updates >= 4
    && same(Object.keys(proof.models).sort(), [...passParentAliases].sort()),
  'All four independently audited v4+v5 composite parents are required');
  for (const alias of passParentAliases) {
    const info = proof.models[alias], ref = input.models[alias];
    check(info.training_identity === ref.training_identity && info.candidate_sha256 === ref.candidate_sha256,
      `${alias}: composite model source differs from audit`);
    input.models[alias] = { ...info, runtime_parameters_sha256: ref.runtime_parameters_sha256 };
  }
  return { ...input, proof: { ...proof, models: input.models } };
}

export function verifyCompositeOverlay(overlay, input) {
  check(overlay.composite_schema === input.manifest.schema && overlay.training_identity === input.identity
    && overlay.training_completion_sha256 === input.manifestSha256
    && same(overlay.per_model_identities, Object.fromEntries(passParentAliases.map(alias => [alias, input.models[alias].training_identity]))),
  'Evaluation overlay composite/per-model source identities differ');
  for (const alias of passParentAliases) {
    const model = overlay.models[alias], source = input.models[alias];
    check(model.training_identity === source.training_identity
      && model.training_provenance?.composite_identity === input.identity
      && model.training_provenance.source_run_identity === source.training_identity
      && model.training_provenance.source_kind === source.kind,
    `${alias}: overlay replaced its distinct training provenance`);
  }
}
