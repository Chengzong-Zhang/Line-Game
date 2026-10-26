// Read-only evidence verification. Does not replay games or execute Minimax.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../../..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const report = JSON.parse(await fs.readFile(path.join(directory, 'independent-core-benchmark-v1.json')));
assert.equal(report.schema, 'lifeline-budgeted-hard-independent-core-compact-v1');
assert.equal(report.status, 'PASS_BOUNDED_CORE_DEVELOPMENT_PROBES_NO_PRODUCT_ADMISSION');
assert.equal(report.localArtifacts.receipt.sha256, '64e7c52613ce153d2356541d1565b63a5e89368369d488e6fd3c174351a04068');
assert.equal(report.localArtifacts.inputs.sha256, 'b9bda560110df223c96e28c881c263746bf7c4306fa0fb31eb1a25525eeaa10b');
for (const item of Object.values(report.localArtifacts))
  assert.equal(sha(await fs.readFile(path.join(root, item.path))), item.sha256, item.path);
for (const [name, hash] of Object.entries(report.source_hashes))
  assert.equal(sha(await fs.readFile(path.join(root, 'web/web前端', name))), hash, name);
const receipt = JSON.parse(await fs.readFile(path.join(root, report.localArtifacts.receipt.path)));
const inputs = JSON.parse(await fs.readFile(path.join(root, report.localArtifacts.inputs.path)));
assert.deepEqual(report.source_hashes, receipt.source_hashes);
assert.deepEqual(report.environment, Object.fromEntries(Object.entries(receipt.environment).filter(([key]) => !key.startsWith('knownArena'))));
for (const [key, value] of Object.entries(receipt.timing)) assert.deepEqual(report.protocol[key], value, key);
assert.equal(report.protocol.actualTimingCallsPerCase, 1);
assert.equal(report.protocol.includesPassGuard, false);
assert.equal(report.protocol.includesWorkerIpcRenderingPhone, false);
assert.equal(report.trainingUseForbidden, true);
assert.equal(report.oldHardRerun, false);
assert.equal(inputs.notTrainingData, true);
assert.equal(inputs.feedbackIntoOldH16TrainingForbidden, true);
assert.equal(inputs.sourceArenaManifestSha256, report.frozenArenaProtection.manifestSha256);
assert.equal(report.inputProvenance.purpose, inputs.purpose);
assert.equal(report.inputProvenance.casesArePostEvaluationDevelopmentOnly, true);
assert.equal(report.inputProvenance.casesExcludedFromOldH16Training, true);
assert.equal(report.inputProvenance.exclusionMeansNoFeedbackNotVerifiedStateDisjointness, true);
assert.equal(report.inputProvenance.heldOutStrengthSet, false);
assert.equal(report.cases.length, 5);
assert.equal(receipt.cases.length, 5);
assert.equal(inputs.cases.length, 5);
for (const [index, row] of report.cases.entries()) {
  const raw = receipt.cases[index], input = inputs.cases[index];
  assert.equal(row.id, raw.id);
  assert.equal(row.id, input.id);
  assert.equal(input.developmentOnlyAfterEvaluation, true);
  assert.equal(input.excludedFromOldH16Training, true);
  assert.equal(input.reference.oldHardWasNotRerun, true);
  assert.equal(row.gridSize, raw.gridSize);
  assert.equal(row.actor, raw.actor);
  assert.equal(row.sourceStateSha256, raw.sourceStateSha256);
  assert.equal(row.sourceStateSha256, input.stateSha256);
  assert.equal(row.coreElapsedMs, raw.outerCoreElapsedMs);
  assert.deepEqual(row.selectedPoint, raw.ranking[0].point);
  for (const key of ['completedDepth', 'maxReachedPly', 'maxMinimaxPly', 'partialDiscarded',
    'shallowQualityTradeoff', 'terminalTreeSolved', 'terminalSolvedScope', 'rootPlacementCap',
    'fullLegalTeacher', 'preparationMs']) assert.deepEqual(row[key], raw.search[key], `${row.id}:${key}`);
  const iterations = raw.search.iterations.map(({ depth, nodes, rootActions, complete, terminalTreeSolved }) =>
    ({ depth, nodes, rootActions, complete, ...(terminalTreeSolved !== undefined ? { terminalTreeSolved } : {}) }));
  assert.deepEqual(row.iterations, iterations);
  assert.equal(row.softSearchDeadlineOverrunMs, raw.search.softOverrunMs);
  assert.equal(row.totalDeadlineOverrunMs, raw.search.totalOverrunMs);
  assert.equal(row.remainingTotalBudgetForFutureGuardMs, raw.remainingTotalBudgetForFutureGuardMs);
  for (const key of ['sourceAllOwnPropertiesRestored', 'sourceRuleStateRestored', 'selectedActionCanonicallyLegal']) {
    assert.equal(row[key], true, `${row.id}:${key}`);
    assert.equal(row[key], raw[key]);
  }
  assert.equal(row.error, null);
  assert.equal(row.passGuardApplied, false);
  assert.equal(raw.passGuardApplied, false);
  if (input.reference.gamePath) {
    assert.equal(row.reference.gamePath, input.reference.gamePath);
    assert.equal(row.reference.gameSha256, input.reference.gameSha256);
    assert.equal(row.reference.actionIndex, input.reference.index);
    for (const key of ['oldRecordedAppliedElapsedMs', 'oldRecordedSelectionElapsedMs', 'oldRecordedFinalPoint'])
      assert.deepEqual(row.reference[key], raw[key]);
  } else {
    assert.equal(row.reference.witnessFile, input.reference.witnessFile);
    assert.equal(row.reference.witnessSourceSha256, input.reference.witnessSourceSha256);
    for (const key of ['expectedUniqueNaturalWinningPoint', 'uniqueNativeWinningPointSelected', 'knownNativeOracleValueOfSelection'])
      assert.deepEqual(row.reference[key], raw[key]);
  }
}
assert.deepEqual(report.cases.slice(0, 3).map(row => row.completedDepth), [2, 2, 2]);
assert.ok(report.cases.slice(0, 3).every(row => row.partialDiscarded && row.shallowQualityTradeoff));
assert.deepEqual(report.clockRecoveryFixtures, receipt.clockRecoveryFixtures);
assert.equal(report.clockRecoveryFixtures.length, 4);
assert.ok(report.clockRecoveryFixtures.every(row => row.sourceAllOwnPropertiesRestored && row.depthAndTemporaryDeadlineRestored));
assert.equal(report.clockRecoveryFixtures.at(-1).completedDepth, 0);
assert.equal(report.clockRecoveryFixtures.at(-1).fallback, 'legal-placement');
assert.deepEqual(report.frozenArenaProtection.knownArenaActivityBefore, receipt.environment.knownArenaActivityBefore);
assert.deepEqual(report.frozenArenaProtection.knownArenaActivityAfter, receipt.environment.knownArenaActivityAfter);
const frozen = process.env.LIFELINE_FROZEN_ULTIMATE_ROOT || report.frozenArenaProtection.worktree;
const manifestBytes = await fs.readFile(path.join(frozen, report.frozenArenaProtection.manifestPath));
assert.equal(sha(manifestBytes), report.frozenArenaProtection.manifestSha256);
const manifest = JSON.parse(manifestBytes);
assert.equal(Object.keys(manifest.source_hashes).length, 17);
assert.equal(report.frozenArenaProtection.sourceCount, 17);
assert.equal(sha(JSON.stringify(manifest.source_hashes)), report.frozenArenaProtection.sourcesHashMapSha256);
for (const [name, hash] of Object.entries(manifest.source_hashes))
  assert.equal(sha(await fs.readFile(path.join(frozen, name))), hash, `frozen:${name}`);
console.log(JSON.stringify({ status: 'PASS_READ_ONLY_CORE_EVIDENCE_BINDINGS', cases: 5, clockFixtures: 4,
  frozenSources: 17, reranMinimax: false, replayedGames: false, provesIntegratedProductAdmission: false }));
