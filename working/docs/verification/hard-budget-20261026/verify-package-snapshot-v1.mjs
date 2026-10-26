// Static packaging/source binding only. No rebuild, upload or promotion.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const directory = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(directory, '../../../..');
const mini = path.join(repo, 'wechat/minigame');
const candidateId = '0.12.16-36fc9ff53923-zIqb9H';
const candidateDirectory = path.join(repo, 'local_artifacts/wechat-candidates', candidateId);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = relative => fs.readFile(path.join(repo, relative));
const json = async filename => JSON.parse(await fs.readFile(filename));
const { verifyCandidate } = await import(pathToFileURL(path.join(mini, 'tools/prepare-candidate.mjs')).href);
const { MODEL_CATALOG } = await import(pathToFileURL(path.join(mini, 'tools/model-packaging.mjs')).href);
const receipt = await verifyCandidate(candidateDirectory);
const manifest = await json(path.join(candidateDirectory, 'project/dist/build-manifest.json'));
assert.equal(receipt.version, '0.12.16');
assert.equal(receipt.status, 'PREPARED_LOCAL_NOT_UPLOADED');
assert.equal(receipt.config.onlineEnabled, true);
assert.equal(receipt.config.apiBase, 'https://lifelinegame.cn');
assert.equal(receipt.hardSearchBudget.timeMs, 3000);
assert.equal(receipt.hardSearchBudget.guardReserveMs, 200);
assert.equal(receipt.hardSearchBudget.maxDepth, 8);
assert.equal(receipt.hardSearchBudget.trainingLabels, false);
for (const [relative, expected] of Object.entries(receipt.sourceHashes)) {
  assert.equal(sha(await read(relative)), expected, `Frozen candidate source changed: ${relative}`);
}
const sourcePaths = ['web/web前端/BudgetedMinimaxAI.js', 'web/web前端/AIWorker.js',
  'web/tools/online_bot_runtime.mjs', 'web/tools/online_bot_bridge.mjs',
  'wechat/minigame/src/worker-runtime.js', 'web/web前端/AIEngine.js',
  'wechat/minigame/compat/web/AIEngine.js', 'wechat/minigame/compat/web/manifest.json',
  'web/web前端/MultiplayerHardAIWorker.bundle.mjs',
  'web/web前端/MultiplayerHardAIWorker.bundle.manifest.json',
  'wechat/minigame/package.json', 'wechat/minigame/package-lock.json',
  'wechat/minigame/tools/prepare-candidate.mjs',
  'web/web前端/PassTrainedPolicyData.js',
  'web/tools/verify-terminal-release-admission-v4.mjs'];
const sourceHashes = {};
for (const relative of sourcePaths) sourceHashes[relative] = sha(await read(relative));
assert.equal(sourceHashes['web/web前端/BudgetedMinimaxAI.js'],
  '6083b9a3516c16fb835bf33f1c4cfb31f668444f57491f00a3bd7a3ee0305ccf');
assert.equal(sourceHashes['web/web前端/AIEngine.js'],
  '695c8ddf1db6e8d897929da7660dc8dc9f7e66e219b80e6dfab4c38067e4a082');
assert.equal(sourceHashes['wechat/minigame/compat/web/AIEngine.js'],
  'f5dc5b498ae9b684c1d7f4152b5f853e45d884894553894e9bbdbbe284280a95');
const worker = await fs.readFile(path.join(candidateDirectory, 'project/dist/workers/index.js'));
assert.equal(sha(worker), sha(await fs.readFile(path.join(mini, 'dist/workers/index.js'))));
assert.equal(sha(worker), '5d2e5b8ed99254529c6d2d124faff59f12ff4676c43ee50616d73c7ad9158a40');
assert.equal(MODEL_CATALOG.length, 17);
const modelAssets = [];
for (const model of MODEL_CATALOG) {
  const bytes = await fs.readFile(path.join(candidateDirectory, 'project/dist', model.assetPath));
  assert.equal(bytes.length, model.bytes, model.id);
  assert.equal(sha(bytes), model.spec.asset_sha256, model.id);
  modelAssets.push({ id: model.id, path: model.assetPath, bytes: bytes.length, sha256: sha(bytes) });
}
assert.equal(receipt.terminalAdmission.global_runtime_admission, false);
assert.equal(receipt.terminalAdmission.strength_verified, false);
const oldAdmission = 'docs/verification/pass-discipline-20261025/combined-admission-v5-r2.json';
assert.equal(sha(await read(oldAdmission)), receipt.terminalAdmission.admission_report_sha256);
const report = { schema: 'lifeline-budgeted-hard-package-source-snapshot-v1',
  status: 'PASS_STATIC_PACKAGE_SOURCE_BINDING_NOT_NEW_HARD_ADMISSION',
  command: 'node working/docs/verification/hard-budget-20261026/verify-package-snapshot-v1.mjs',
  verifier_sha256: sha(await fs.readFile(fileURLToPath(import.meta.url))), candidateId,
  candidateStatus: receipt.status, version: receipt.version, config: receipt.config,
  files: receipt.files.length, packageBytes: receipt.packageBytes,
  mainPackageBytes: receipt.mainPackageBytes,
  workerSha256: sha(worker), workerEqualsOfflineDist: true,
  candidateJsonSha256: sha(await fs.readFile(path.join(candidateDirectory, 'candidate.json'))),
  buildManifestSha256: sha(await fs.readFile(path.join(candidateDirectory, 'project/dist/build-manifest.json'))),
  frozenCandidateSourceCount: Object.keys(receipt.sourceHashes).length,
  buildSourceCount: Object.keys(manifest.sourceHashes).length,
  allFrozenCandidateSourcesMatchCurrentBytes: true, sourceHashes,
  nativeCompatibility: manifest.nativeCompatibility, modelAssets,
  hardSearchBudget: receipt.hardSearchBudget,
  historicalTerminalAdmission: { status: receipt.terminalAdmission.status,
    report_sha256: receipt.terminalAdmission.admission_report_sha256,
    policy_data_sha256: receipt.terminalAdmission.policy_data_sha256,
    global_runtime_admission: false, strength_verified: false,
    scope: 'Unchanged four-policy identity/parameters and historical narrow-policy evidence only; does not admit the new Budgeted Hard or changed runtime entry points.' },
  fullNativeSuite: { tests: 522, passed: 514, failed: 8, exitCode: 1,
    attribution: 'working/docs/verification/hard-budget-20261026/inherited-native-failures-v1.json' },
  scope: 'Static source/package identity, byte-for-byte isolated rebuild previously verified by prepare-candidate, unchanged 17 packaged model identities, and candidate inventory. Separate integration/pipeline evidence is required for new Hard behavior. No browser/device performance, strength, upload, review, deployment or public-release claim.',
};
const output = path.join(directory, 'integration-package-v1.json');
await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ status: report.status, output, sha256: sha(await fs.readFile(output)),
  candidateId, workerSha256: report.workerSha256, models: modelAssets.length,
  frozenCandidateSources: report.frozenCandidateSourceCount }));
