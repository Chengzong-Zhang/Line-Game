// Shared release gate. Evaluation builds may use isolated candidates, but a
// prepared release must bind the actual four policies to a sealed admission.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const check = (ok, message) => { if (!ok) throw new Error(message); };
const sha = value => createHash("sha256").update(value).digest("hex");
const hash = value => /^[a-f0-9]{64}$/.test(value ?? "");
const aliases = ["easy", "three-v4", "three-v1", "hex-v1"];
const sameAliases = object => object && JSON.stringify(Object.keys(object).sort()) === JSON.stringify([...aliases].sort());

export function assertTerminalAdmissionSummary(summary, policyHash) {
  const { summary_sha256, ...body } = summary ?? {};
  check(summary?.schema === "lifeline-terminal-release-admission-v4"
    && summary.status === "PASS_TERMINAL_RELEASE_ADMISSION_V4"
    && summary.policy_data_sha256 === policyHash && hash(policyHash)
    && hash(summary.admission_report_sha256) && sameAliases(summary.candidate_hashes)
    && hash(summary.verifier_sha256)
    && aliases.every(alias => hash(summary.candidate_hashes[alias]))
    && sameAliases(summary.runtime_parameters_sha256) && aliases.every(alias => hash(summary.runtime_parameters_sha256[alias]))
    && typeof summary.scope === "string" && summary.scope.length > 0
    && sha(JSON.stringify(body)) === summary_sha256,
  "Terminal release admission summary is missing, changed or bound to different policy data");
  return summary;
}

export async function verifyTerminalReleaseAdmission({ dataPath, admissionPath = null }) {
  check(typeof dataPath === "string" && dataPath.length > 0, "Terminal policy data path is required");
  const bytes = await readFile(resolve(dataPath)), policyHash = sha(bytes);
  const module = await import(`${pathToFileURL(resolve(dataPath)).href}?release-admission=${policyHash}`);
  const data = module.PASS_TRAINED_POLICY_DATA;
  check(data?.schema === "lifeline-terminal-trained-policies-v4" && data.models && typeof data.models === "object"
    && !Array.isArray(data.models), "Invalid terminal policy overlay schema/models");
  if (!Object.keys(data.models).length) return { status: "NO_TRAINED_MODELS", policy_data_sha256: policyHash,
    scope: "No terminal-trained model overlay is present; existing parent policies remain in use." };
  check(data.activation === "PASS_DISCIPLINE_SCOPED" && hash(data.admission_report_sha256),
    "Terminal policies are evaluation-only; a scoped admission receipt is required before release preparation");
  check(sameAliases(data.models) && aliases.every(alias => hash(data.models[alias]?.candidate_sha256)
    && data.models[alias].weights?.length === 17 && data.models[alias].weights.every(Number.isFinite)
    && data.models[alias].passBias === data.models[alias].weights[16]),
    "Terminal release requires all four trained parent identities");
  check(data.reward?.gamma === 1 && data.reward?.nonterminal_reward === 0
    && data.reward?.type === "terminal-outcome-native-margin-area-v1", "Terminal release reward contract mismatch");
  check(typeof admissionPath === "string" && admissionPath.length > 0,
    "Use --terminal-admission with the sealed combined scoped admission report");
  const reportBytes = await readFile(resolve(admissionPath));
  check(sha(reportBytes) === data.admission_report_sha256, "Terminal admission report SHA256 differs from the policy overlay");
  const { integrity, ...report } = JSON.parse(reportBytes);
  check(hash(integrity) && sha(JSON.stringify(report)) === integrity, "Terminal admission report seal is corrupt");
  check(report.schema === "lifeline-pass-discipline-combined-admission-v1"
    && report.status === "PASS_DISCIPLINE_SCOPED" && report.task_admission === "PASS_DISCIPLINE_SCOPED"
    && report.runtime_scoped_admitted === true && report.global_runtime_admission === false,
  "Terminal release requires the completed combined scoped admission report");
  check(sameAliases(report.candidate_hashes) && aliases.every(alias =>
    report.candidate_hashes[alias] === data.models[alias].candidate_sha256),
  "Terminal admission candidates differ from the four exported policies");
  const parameterHashes = Object.fromEntries(aliases.map(alias => [alias, sha(JSON.stringify({
    weights: data.models[alias].weights.slice(0, 16), passBias: data.models[alias].passBias,
    temperature: 1, rules_version: "territory-v3",
  }))]));
  check(aliases.every(alias => hash(report.training_models?.[alias]?.runtime_parameters_sha256)
    && report.training_models[alias].runtime_parameters_sha256 === parameterHashes[alias]),
  "Terminal overlay runtime parameters differ from the independently reconstructed trained policy");
  check(typeof report.scope === "string" && report.scope.length > 0, "Terminal admission must retain its verification scope");
  const summary = { schema: "lifeline-terminal-release-admission-v4", status: "PASS_TERMINAL_RELEASE_ADMISSION_V4",
    verifier_sha256: sha(await readFile(fileURLToPath(import.meta.url))),
    policy_data_sha256: policyHash, admission_report_sha256: sha(reportBytes), candidate_hashes: report.candidate_hashes,
    runtime_parameters_sha256: parameterHashes,
    training_identity: data.training_identity ?? null, training_completion_sha256: data.training_completion_sha256 ?? null,
    fresh_natural_games: report.fresh_natural_games, independent_layout_blocks: report.independent_layout_blocks,
    scenario_cases: report.scenario_cases, strength_verified: false, global_runtime_admission: false, scope: report.scope };
  return { ...summary, summary_sha256: sha(JSON.stringify(summary)) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), option = name => args.includes(name) ? args[args.indexOf(name) + 1] : null;
    check(option("--data"), "Use --data POLICY_DATA_MODULE [--admission SEALED_COMBINED_REPORT]");
    console.log(JSON.stringify(await verifyTerminalReleaseAdmission({ dataPath: option("--data"), admissionPath: option("--admission") })));
  } catch (error) { console.error(error.stack); process.exitCode = 78; }
}
