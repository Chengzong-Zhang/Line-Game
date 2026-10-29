import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { createHash } from "node:crypto";
import { verifyTerminalReleaseAdmission, assertTerminalAdmissionSummary } from "../../tools/verify-terminal-release-admission-v4.mjs";

const sha = value => createHash("sha256").update(value).digest("hex"), aliases = ["easy", "three-v4", "three-v1", "hex-v1"];
const directory = await mkdtemp(join(tmpdir(), "lifeline-terminal-admission-test-"));
const dataPath = join(directory, "data.mjs"), admissionPath = join(directory, "admission.json");
const candidateHashes = Object.fromEntries(aliases.map(alias => [alias, sha(alias)]));
const base = { schema: "lifeline-terminal-trained-policies-v4", activation: "PASS_DISCIPLINE_SCOPED",
  reward: { gamma: 1, nonterminal_reward: 0, type: "terminal-outcome-native-margin-area-v1" },
  models: Object.fromEntries(aliases.map(alias => [alias, { candidate_sha256: candidateHashes[alias], weights: Array(17).fill(0), passBias: 0 }])) };
const report = { schema: "lifeline-pass-discipline-combined-admission-v1", status: "PASS_DISCIPLINE_SCOPED",
  task_admission: "PASS_DISCIPLINE_SCOPED", runtime_scoped_admitted: true, global_runtime_admission: false,
  candidate_hashes: candidateHashes, scope: "Synthetic four-parent identity test only", fresh_natural_games: 34,
  training_models: Object.fromEntries(aliases.map(alias => [alias, { runtime_parameters_sha256: sha(JSON.stringify({
    weights: Array(16).fill(0), passBias: 0, temperature: 1, rules_version: "territory-v3",
  })) }])),
  independent_layout_blocks: 8, scenario_cases: 1 };
const seal = body => ({ ...body, integrity: sha(JSON.stringify(body)) });
async function persist(data, evidence = seal(report)) {
  const bytes = JSON.stringify(evidence) + "\n";
  await writeFile(admissionPath, bytes);
  await writeFile(dataPath, `export const PASS_TRAINED_POLICY_DATA=${JSON.stringify({ ...data, admission_report_sha256: sha(bytes) })};\n`);
}
try {
  await persist({ ...base, models: {} });
  assert.equal((await verifyTerminalReleaseAdmission({ dataPath })).status, "NO_TRAINED_MODELS");
  await persist({ ...base, activation: "EVALUATION_ONLY" });
  await assert.rejects(verifyTerminalReleaseAdmission({ dataPath, admissionPath }), /evaluation-only/);
  await persist(base);
  await assert.rejects(verifyTerminalReleaseAdmission({ dataPath }), /--terminal-admission/);
  const accepted = await verifyTerminalReleaseAdmission({ dataPath, admissionPath });
  assert.equal(accepted.status, "PASS_TERMINAL_RELEASE_ADMISSION_V4");
  assert.equal(accepted.scope, report.scope); assert.deepEqual(accepted.candidate_hashes, candidateHashes);
  assertTerminalAdmissionSummary(accepted, accepted.policy_data_sha256);
  assert.throws(() => assertTerminalAdmissionSummary({ ...accepted, scope: "changed" }, accepted.policy_data_sha256), /summary/);
  assert.throws(() => assertTerminalAdmissionSummary(accepted, sha("different-policy-data")), /summary/);
  await writeFile(admissionPath, JSON.stringify(seal({ ...report, scope: "changed-after-policy-binding" })));
  await assert.rejects(verifyTerminalReleaseAdmission({ dataPath, admissionPath }), /SHA256/);
  await persist(base, { ...seal(report), scope: "corrupt-seal" });
  await assert.rejects(verifyTerminalReleaseAdmission({ dataPath, admissionPath }), /seal/);
  await persist(base, seal({ ...report, status: "NOT_ADMITTED" }));
  await assert.rejects(verifyTerminalReleaseAdmission({ dataPath, admissionPath }), /completed combined/);
  await persist(base, seal({ ...report, candidate_hashes: { ...candidateHashes, easy: sha("other-candidate") } }));
  await assert.rejects(verifyTerminalReleaseAdmission({ dataPath, admissionPath }), /candidates differ/);
  await persist({ ...base, models: { ...base.models, easy: { ...base.models.easy, weights: [1, ...Array(16).fill(0)] } } });
  await assert.rejects(verifyTerminalReleaseAdmission({ dataPath, admissionPath }), /runtime parameters differ/);
  await persist({ ...base, models: { ...base.models, extra: { candidate_sha256: sha("extra") } } });
  await assert.rejects(verifyTerminalReleaseAdmission({ dataPath, admissionPath }), /all four/);
  console.log(JSON.stringify({ status: "PASS_TERMINAL_RELEASE_ADMISSION_GATE_V4", rejectsEvaluationOnly: true,
    requiresRealSealedReport: true, bindsAllFourCandidates: true, summaryHashBoundToPolicyBytes: true, oldEmptyOverlayAllowed: true }));
} finally {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith("lifeline-terminal-admission-test-"));
  await rm(directory, { recursive: true, force: true });
}
