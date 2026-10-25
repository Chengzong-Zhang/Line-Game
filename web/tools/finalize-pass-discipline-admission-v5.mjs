// Preserve the complete frozen V4 admission gate, adding the explicit V4 failure lineage.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finalizePassDisciplineV4 } from './finalize-pass-discipline-admission-v4.mjs';
import { auditWrappedRuntimeEvaluationV5 } from './prepare-pass-runtime-evaluation-v5.mjs';
import { root, atomic, sealed, sha } from './neural-posttraining-data-v2.mjs';
const check = (ok, message) => { if (!ok) throw Error(message); };

export async function finalizePassDisciplineV5(options) {
  const job = JSON.parse(await readFile(resolve(options.campaignRoot, 'job.json')));
  const at = job.command.indexOf('--phase-protocol'); check(at >= 0, 'V5 requires its frozen phase descriptor');
  const phase = await auditWrappedRuntimeEvaluationV5(job.command[at + 1]), lineage = phase.priorRuntimeV4Lineage;
  check(resolve(phase.phaseRoot) === resolve(options.campaignRoot), 'V5 finalizer phase directory differs');
  const report = await finalizePassDisciplineV4(options);
  check(report.fresh_natural_games === 34 && report.independent_layout_blocks === 8
    && report.candidate_certified_bad_passes === 0 && report.runtime_scoped_admitted === true
    && report.previous_runtime_games_reused === false && report.new_operational_phase_budget_passed === true
    && report.verifier_sha256 === phase.frozenSources[resolve(root, 'web/tools/finalize-pass-discipline-admission-v4.mjs')],
  'Frozen V4 fresh-game/PASS/scenario gate was not passed');
  return { ...report, verifier_sha256: sha(await readFile(fileURLToPath(import.meta.url))),
    base_verifier_sha256: report.verifier_sha256,
    lineage_verifier_sha256: sha(await readFile(resolve(root, 'web/tools/prepare-pass-runtime-evaluation-v5.mjs'))),
    evaluation_runtime_revision: 5, evaluation_operational_revision: 5, runtime_campaign_engine_revision: 4,
    wrapped_runtime_revision: 5,
    campaign_budget: { ...report.campaign_budget, wrappedRuntimeRevision: 5,
      previousRuntimeV4LineageSha256: lineage.sha256 },
    previous_runtime_v4_failure: { status: lineage.status, phase_identity: lineage.previousPhaseIdentity,
      worker_identity: lineage.previousWorkerIdentity, lineage_identity: lineage.identity, lineage_sha256: lineage.sha256,
      fresh_natural_games: 34, candidate_certified_bad_passes: 0, shared_cases: 112, shared_failures: 3,
      failed_cases: lineage.failedCases, preserved_source_snapshot_files: 111, games_reused: false },
    operational_scope: 'Product runtime V5 wrapper with all 34 games newly played and the same unchanged 112 shared cases, policy protocol, area oracle and zero-certified-bad-PASS gate. Frozen V4 engine/supervisor implement the new immutable 1200-second phase. V4 FATAL, its 34 games/three shared failures/111 source snapshot and all earlier failures remain preserved; no previous game or action is reused.',
    limitations: report.limitations + ' The frozen independent opportunity oracle proves area retention, not the native winning-margin comparison for terminal PASS. Its old [4,1] witness is not product strict-margin evidence. Separate product terminal certificates and their regressions retain the stronger margin contract; this wrapper does not change or relabel the old oracle or rejected V4 evidence.' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  try {
    check(option('--campaign-root') && option('--protocol') && option('--output') && option('--composite-manifest'),
      'Use --campaign-root --protocol --composite-manifest --output');
    const report = await finalizePassDisciplineV5({ campaignRoot: resolve(option('--campaign-root')),
      protocolPath: resolve(option('--protocol')), compositeManifest: option('--composite-manifest'), sourceRoot: option('--source-root', root) });
    await atomic(resolve(option('--output')), sealed(report));
    console.log(JSON.stringify({ status: report.status, wrappedRuntimeRevision: 5, games: report.fresh_natural_games,
      scenarios: report.scenario_cases, priorRuntimeV4FailurePreserved: true, candidate_hashes: report.candidate_hashes }));
  } catch (error) { console.error(error.stack); process.exitCode = 78; }
}
