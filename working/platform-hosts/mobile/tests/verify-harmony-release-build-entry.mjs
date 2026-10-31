import assert from 'node:assert/strict';
import { copyFile, link, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  HARMONY_RELEASE_IDENTITY_SCHEMA, assertNoSigningMaterial, cleanupHarmonyReleaseBuild,
  invokeStaticVerifier, prepareHarmonyReleaseBuild, redactSecrets, validateArtifactDirectoryPath,
  validateHarmonyBuildMetadata, verifyHarmonyReleaseOutput, verifyHarmonyReleaseOverlay,
} from '../tools/harmony-release-build-entry.mjs';
import { readHarmonySigningMaterial } from '../tools/harmony-release-signing.mjs';
const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoot = path.join(mobileRoot, 'local_artifacts');
const fixtureRoot = await mkdtemp(path.join(artifactRoot, 'l27b-signing-entry-test-'));
const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'l27b-junction-target-'));
const candidateIdentity = JSON.parse(await readFile(path.join(mobileRoot, 'config/release-identity-candidate.json'), 'utf8'));
const frozenIdentity = {
  ...candidateIdentity,
  status: 'FROZEN',
  releaseCertificateFingerprints: { ...candidateIdentity.releaseCertificateFingerprints, harmonyCertChainSha256: 'a'.repeat(64) },
};
const identityPath = path.join(fixtureRoot, 'frozen-identity.json');
await writeFile(identityPath, JSON.stringify(frozenIdentity));
const signingConfigPath = path.join(fixtureRoot, 'signing.json');
const storeFile = path.join(fixtureRoot, 'synthetic.p12');
const profile = path.join(fixtureRoot, 'synthetic.p7b');
const certpath = path.join(fixtureRoot, 'synthetic.cer');
for (const file of [storeFile, profile, certpath]) await writeFile(file, 'synthetic fixture only');
const signingMaterial = {
  storeFile,
  storePassword: 'synthetic-store-password-never-log',
  keyAlias: 'synthetic-alias',
  keyPassword: 'synthetic-key-password-never-log',
  signAlg: 'SHA256withECDSA',
  profile,
  certpath,
};
await writeFile(signingConfigPath, JSON.stringify(signingMaterial));
const trackedProfilePath = path.join(mobileRoot, 'harmony/build-profile.json5');
const trackedProfileBefore = await readFile(trackedProfilePath);

try {
  const junction = path.join(fixtureRoot, 'junction-outside-artifacts');
  await symlink(outsideRoot, junction, 'junction');
  await assert.rejects(() => validateArtifactDirectoryPath(path.join(junction, 'release-output'), artifactRoot), /symlink or reparse point/);

  const blockedDefaultDir = path.join(fixtureRoot, 'not-frozen-output');
  await assert.rejects(() => prepareHarmonyReleaseBuild({
    artifactDirectory: blockedDefaultDir,
    identityPath: path.join(mobileRoot, 'config/release-identity-candidate.json'),
    signingConfigPath,
  }), /status FROZEN/);
  assert.equal(await exists(blockedDefaultDir), false, 'non-FROZEN identity must fail before creating output or invoking Hvigor');

  const invalidFingerprintIdentity = path.join(fixtureRoot, 'invalid-fingerprint-identity.json');
  await writeFile(invalidFingerprintIdentity, JSON.stringify({ ...frozenIdentity, releaseCertificateFingerprints: { ...frozenIdentity.releaseCertificateFingerprints, harmonyCertChainSha256: 'bad' } }));
  await assert.rejects(() => prepareHarmonyReleaseBuild({ artifactDirectory: path.join(fixtureRoot, 'invalid-fingerprint-output'), identityPath: invalidFingerprintIdentity, signingConfigPath }), /certificate-chain SHA-256/);

  const missingDir = path.join(fixtureRoot, 'missing-material-output');
  await assert.rejects(() => prepareHarmonyReleaseBuild({
    artifactDirectory: missingDir, identityPath, signingConfigPath: path.join(fixtureRoot, 'missing.json'),
  }), /missing/);
  assert.equal(await exists(missingDir), false, 'missing material fails before output creation');

  const relativeConfig = path.join(fixtureRoot, 'relative-signing.json');
  await writeFile(relativeConfig, JSON.stringify({ ...signingMaterial, storeFile: 'relative/store.p12' }));
  const relative = await readHarmonySigningMaterial({ configPath: relativeConfig, env: {} });
  assert.equal(relative.ok, false);
  assert.deepEqual(relative.invalid, ['storeFile']);
  const relativeDir = path.join(fixtureRoot, 'relative-material-output');
  await assert.rejects(() => prepareHarmonyReleaseBuild({ artifactDirectory: relativeDir, identityPath, signingConfigPath: relativeConfig }), /invalid: storeFile/);
  assert.equal(await exists(relativeDir), false);

  const invalidProject = path.join(fixtureRoot, 'invalid-project');
  await mkdir(path.join(invalidProject, 'AppScope'), { recursive: true });
  await copyFile(path.join(mobileRoot, 'harmony/AppScope/app.json5'), path.join(invalidProject, 'AppScope/app.json5'));
  await copyFile(path.join(mobileRoot, 'harmony/oh-package.json5'), path.join(invalidProject, 'oh-package.json5'));
  await mkdir(path.join(invalidProject, 'hvigor'), { recursive: true });
  await copyFile(path.join(mobileRoot, 'harmony/hvigor/hvigor-config.json5'), path.join(invalidProject, 'hvigor/hvigor-config.json5'));
  await writeFile(path.join(invalidProject, 'build-profile.json5'), '{ malformed profile');
  const cleanupDir = path.join(fixtureRoot, 'cleanup-after-error');
  await assert.rejects(() => prepareHarmonyReleaseBuild({ artifactDirectory: cleanupDir, sourceProjectRoot: invalidProject, identityPath, signingConfigPath }), /not valid JSON/);
  assert.equal(await exists(cleanupDir), false, 'failed staging must clean the new isolated artifact directory');
  const artifactDirectory = path.join(fixtureRoot, 'successful-assembly');
  const prepared = await prepareHarmonyReleaseBuild({ artifactDirectory, identityPath, signingConfigPath, env: {} });
  assert.equal(frozenIdentity.schema, HARMONY_RELEASE_IDENTITY_SCHEMA);
  assert.equal(prepared.plan.status, 'READY_TO_RUN_SIGNED_RELEASE_BUILD');
  assert.ok(prepared.plan.command.args.includes('--no-incremental'));
  assert.equal(Object.keys(prepared.environment).some((key) => key.startsWith('LIFELINE_HARMONY_')), false);
  assert.equal(prepared.plan.trackedProfileUnchanged, true);
  assert.equal(await readFile(trackedProfilePath, 'utf8'), trackedProfileBefore.toString('utf8'));
  const stagedProfile = await readFile(path.join(prepared.plan.stagedProjectRoot, 'build-profile.json5'));
  assert.equal(stagedProfile.toString('utf8'), await readFile(path.join(artifactDirectory, 'harmony-build-profile.generated.json5'), 'utf8'));
  assert.equal(Object.hasOwn(prepared.plan, 'stagedProfileSha256'), false);
  assert.equal(Object.hasOwn(prepared.plan, 'overlaySha256'), false);
  const planText = await readFile(path.join(artifactDirectory, 'release-build-plan.json'), 'utf8');
  assert.equal(planText.includes(signingMaterial.storePassword), false);
  assert.equal(planText.includes(signingMaterial.keyPassword), false);
  assert.doesNotThrow(() => assertNoSigningMaterial(planText, signingMaterial));
  const fullOverlayText = await readFile(path.join(artifactDirectory, 'harmony-build-profile.generated.json5'), 'utf8');
  assert.throws(() => assertNoSigningMaterial(fullOverlayText, signingMaterial), /Signing material was found/);
  const staleOverlayPath = path.join(fixtureRoot, 'stale-overlay.json');
  const staleOverlay = JSON.parse(await readFile(path.join(artifactDirectory, 'harmony-build-profile.generated.json5'), 'utf8'));
  staleOverlay.app.signingConfigs[0].material.keyAlias = 'stale-alias';
  await writeFile(staleOverlayPath, JSON.stringify(staleOverlay));
  const { verifyHarmonyReleaseOverlay } = await import('../tools/harmony-release-build-entry.mjs');
  await assert.rejects(() => verifyHarmonyReleaseOverlay({ overlayPath: staleOverlayPath, signingConfigPath, env: {} }), /does not match/);
  assert.equal(validateHarmonyBuildMetadata({ modules: [{ hapName: 'entry-default-signed.hap', isSigned: true }] }, ['entry-default-signed.hap']), 'entry-default-signed.hap');
  assert.throws(() => validateHarmonyBuildMetadata({ modules: [{ hapName: 'entry-default-unsigned.hap', isSigned: false }] }, ['entry-default-unsigned.hap']), /unsigned HAP/);
  assert.throws(() => validateHarmonyBuildMetadata({ modules: [{ hapName: 'entry-default-unsigned.hap', isSigned: true }] }, ['entry-default-unsigned.hap']), /unsigned HAP/);
  assert.throws(() => validateHarmonyBuildMetadata({ modules: [{ hapName: 'entry-default-signed.hap', isSigned: false }] }, ['entry-default-signed.hap']), /exactly one HAP record/);
  assert.throws(() => validateHarmonyBuildMetadata({ modules: [{ hapName: 'other-signed.hap', isSigned: true }] }, ['entry-default-signed.hap']), /does not exactly match/);
  assert.throws(() => validateHarmonyBuildMetadata({ modules: [
    { hapName: 'entry-default-signed.hap', isSigned: true }, { hapName: 'other-signed.hap', isSigned: true },
  ] }, ['entry-default-signed.hap', 'other-signed.hap']), /exactly one/);

  const outputRoot = path.join(fixtureRoot, 'staged', 'entry/build/default/outputs/default');
  const metadataPath = path.join(fixtureRoot, 'staged', 'entry/build/default/intermediates/hap_metadata/default/output_metadata.json');
  await mkdir(outputRoot, { recursive: true });
  await mkdir(path.dirname(metadataPath), { recursive: true });
  await writeFile(path.join(outputRoot, 'entry-default-signed.hap'), 'synthetic signed HAP fixture');
  await writeFile(path.join(outputRoot, 'entry-default-unsigned.hap'), 'synthetic unsigned intermediate fixture');
  await writeFile(metadataPath, JSON.stringify({ modules: [{ hapName: 'entry-default-signed.hap', isSigned: true }] }));
  const verification = await verifyHarmonyReleaseOutput({
    outputRoot, metadataPath, identity: frozenIdentity, javaExe: 'synthetic-java', hapSignTool: 'synthetic-tool',
    verifier: () => ({ status: 'PASS_SIGNED_RELEASE_HAP_STATIC', certificateChainSha256: 'a'.repeat(64) }),
  });
  assert.equal(path.basename(verification.hapPath), 'entry-default-signed.hap');
  await assert.rejects(() => verifyHarmonyReleaseOutput({
    outputRoot, metadataPath, identity: frozenIdentity, verifier: () => ({ status: 'BLOCKED', certificateChainSha256: 'a'.repeat(64) }),
  }), /did not return PASS_SIGNED_RELEASE_HAP_STATIC/);
  await assert.rejects(() => verifyHarmonyReleaseOutput({
    outputRoot, metadataPath, identity: frozenIdentity, verifier: () => ({ status: 'PASS_SIGNED_RELEASE_HAP_STATIC', certificateChainSha256: 'b'.repeat(64) }),
  }), /fingerprint differs/);

  let invoked = false;
  assert.throws(() => invokeStaticVerifier({
    hapPath: 'fixture-signed.hap', javaExe: 'synthetic-java', hapSignTool: 'synthetic-tool',
    run: (command, args) => {
      invoked = true;
      assert.equal(command, 'python');
      assert.ok(args.includes('--harmony-hap'));
      assert.ok(args.includes('--hap-sign-tool'));
      return { status: 1, stdout: '', stderr: '{"reason":"synthetic verifier rejection"}' };
    },
  }), /did not return PASS_SIGNED_RELEASE_HAP_STATIC/);
  assert.equal(invoked, true, 'nonzero official verifier result must block release acceptance');

  const sanitizedLog = redactSecrets(`build ${signingMaterial.storePassword} ${signingMaterial.keyPassword}`, signingMaterial);
  assert.equal(sanitizedLog.includes(signingMaterial.storePassword), false);
  assert.equal(sanitizedLog.includes(signingMaterial.keyPassword), false);
  assert.doesNotThrow(() => assertNoSigningMaterial(sanitizedLog, signingMaterial));
  assert.equal(sanitizedLog.includes(fullOverlayText), false, 'retained logs cannot contain the complete signing overlay');
  assert.throws(() => assertNoSigningMaterial(JSON.stringify(signingMaterial), signingMaterial), /Signing material was found/);
  const receipt = { status: 'PASS_LOCAL_SIGNED_HAP_BUILD', identitySha256: '0'.repeat(64), staticVerification: { status: 'PASS_SIGNED_RELEASE_HAP_STATIC' } };
  assert.equal(JSON.stringify(receipt).includes(signingMaterial.storePassword), false);
  assert.equal(JSON.stringify(receipt).includes(signingMaterial.keyPassword), false);
  assert.doesNotThrow(() => assertNoSigningMaterial(JSON.stringify(receipt), signingMaterial));
  assert.equal(await readFile(trackedProfilePath, 'utf8'), trackedProfileBefore.toString('utf8'), 'tracked profile remains byte-identical after success and failure cases');
  const overlayPath = prepared.plan.signingOverlayPath;
  const stagedPath = prepared.plan.stagedProjectRoot;
  const userHomePath = path.join(artifactDirectory, 'isolated-user-home');
  const hvigorHomePath = path.join(artifactDirectory, 'isolated-hvigor-home');
  await cleanupHarmonyReleaseBuild(prepared);
  for (const target of [overlayPath, stagedPath, userHomePath, hvigorHomePath]) {
    assert.equal(await exists(target), false, `cleanup removes temporary signing path ${path.basename(target)}`);
  }

  const cliArtifactDirectory = path.join(fixtureRoot, 'prepare-only-cli');
  const cli = spawnSync(process.execPath, [
    path.join(mobileRoot, 'tools/harmony-release-build-entry.mjs'),
    '--artifact-directory', cliArtifactDirectory,
    '--identity-config', identityPath,
    '--signing-config', signingConfigPath,
    '--prepare-only',
  ], { cwd: path.resolve(mobileRoot, '..'), encoding: 'utf8', timeout: 60000 });
  assert.equal(cli.status, 0, cli.stderr || cli.stdout);
  const cliResult = JSON.parse(cli.stdout);
  assert.equal(cliResult.status, 'PREFLIGHT_PASSED_CLEANED');
  const cliPlanText = await readFile(cliResult.planPath, 'utf8');
  const cliPlan = JSON.parse(cliPlanText);
  assert.equal(cliPlan.status, 'PREFLIGHT_PASSED_CLEANED');
  assert.equal(cliPlan.command, null);
  assert.equal(cliPlan.stagedProjectRoot, null);
  assert.equal(cliPlan.signingOverlayPath, null);
  assert.equal(await exists(path.join(cliArtifactDirectory, 'harmony-build-profile.generated.json5')), false);
  assert.equal(await exists(path.join(cliArtifactDirectory, 'isolated-project')), false);
  assert.equal(await exists(path.join(cliArtifactDirectory, 'harmony-release-build-receipt.json')), false);
  assert.doesNotThrow(() => assertNoSigningMaterial(cliPlanText, signingMaterial));
  assert.equal(await readFile(trackedProfilePath, 'utf8'), trackedProfileBefore.toString('utf8'), 'prepare-only CLI preserves the tracked profile');

  const realToolRoot = path.join(mobileRoot, 'local_artifacts/harmony-native-20261022-01/tools/command-line-tools');
  const realJavaHome = path.join(mobileRoot, 'local_artifacts/native-build-20261022-parent01/temurin21/jdk-21.0.12.1+1');
  const syntheticToolRoot = path.join(fixtureRoot, 'synthetic-toolchain');
  const syntheticJavaHome = path.join(fixtureRoot, 'synthetic-java-home');
  const syntheticHvigorRoot = path.join(syntheticToolRoot, 'hvigor/hvigor');
  const syntheticPluginRoot = path.join(syntheticToolRoot, 'hvigor/hvigor-ohos-plugin');
  const syntheticNodeRoot = path.join(syntheticToolRoot, 'tool/node');
  const syntheticSdkRoot = path.join(syntheticToolRoot, 'sdk');
  await Promise.all([
    mkdir(path.join(syntheticHvigorRoot, 'bin'), { recursive: true }),
    mkdir(path.join(syntheticPluginRoot, 'src/options/build'), { recursive: true }),
    mkdir(syntheticNodeRoot, { recursive: true }),
    mkdir(syntheticSdkRoot, { recursive: true }),
    mkdir(path.join(syntheticJavaHome, 'bin'), { recursive: true }),
  ]);
  await Promise.all([
    link(path.join(realToolRoot, 'tool/node/node.exe'), path.join(syntheticNodeRoot, 'node.exe')),
    copyFile(path.join(realToolRoot, 'hvigor/hvigor/package.json'), path.join(syntheticHvigorRoot, 'package.json')),
    copyFile(path.join(realToolRoot, 'hvigor/hvigor-ohos-plugin/package.json'), path.join(syntheticPluginRoot, 'package.json')),
    copyFile(path.join(realToolRoot, 'hvigor/hvigor-ohos-plugin/src/options/build/project-build-profile.d.ts'), path.join(syntheticPluginRoot, 'src/options/build/project-build-profile.d.ts')),
    copyFile(path.join(realJavaHome, 'bin/java.exe'), path.join(syntheticJavaHome, 'bin/java.exe')),
    copyFile(path.join(realJavaHome, 'release'), path.join(syntheticJavaHome, 'release')),
  ]);
  await writeFile(path.join(syntheticHvigorRoot, 'bin/hvigor.js'), [
    `console.log(${JSON.stringify(`synthetic build output ${signingMaterial.storePassword}`)});`,
    `console.error(${JSON.stringify(`synthetic failure ${signingMaterial.keyPassword}`)});`,
    'process.exitCode = 23;',
  ].join('\n'));
  const failedBuildDirectory = path.join(fixtureRoot, 'failed-hvigor-cli');
  const failedCli = spawnSync(process.execPath, [
    path.join(mobileRoot, 'tools/harmony-release-build-entry.mjs'),
    '--artifact-directory', failedBuildDirectory,
    '--identity-config', identityPath,
    '--signing-config', signingConfigPath,
    '--tool-root', syntheticToolRoot,
    '--java-home', syntheticJavaHome,
  ], { cwd: path.resolve(mobileRoot, '..'), encoding: 'utf8', timeout: 60000 });
  assert.equal(failedCli.status, 1, failedCli.stdout || 'synthetic Hvigor failure must block acceptance');
  assert.match(failedCli.stderr, /Harmony release build BLOCKED: Harmony release Hvigor build failed/);
  const failedLogPath = path.join(failedBuildDirectory, 'harmony-release-build.log');
  const failedLog = await readFile(failedLogPath, 'utf8');
  assert.ok(failedLog.includes('[REDACTED]'), 'failed build log records redaction markers');
  assert.doesNotThrow(() => assertNoSigningMaterial(failedLog, signingMaterial));
  assert.equal(failedLog.includes(signingMaterial.storePassword), false);
  assert.equal(failedLog.includes(signingMaterial.keyPassword), false);
  assert.equal(await exists(path.join(failedBuildDirectory, 'harmony-release-build-receipt.json')), false, 'failed Hvigor build cannot write a PASS receipt');
  assert.equal(await exists(path.join(failedBuildDirectory, 'harmony-build-profile.generated.json5')), false, 'failed Hvigor build cleans its signing overlay');
  assert.equal(await exists(path.join(failedBuildDirectory, 'isolated-project')), false, 'failed Hvigor build cleans its staged project');
  assert.equal(await exists(path.join(failedBuildDirectory, 'isolated-user-home')), false, 'failed Hvigor build cleans its isolated user home');
  assert.equal(await exists(path.join(failedBuildDirectory, 'isolated-hvigor-home')), false, 'failed Hvigor build cleans its isolated Hvigor home');
  const failedPlan = JSON.parse(await readFile(path.join(failedBuildDirectory, 'release-build-plan.json'), 'utf8'));
  assert.equal(failedPlan.status, 'BUILD_NOT_ACCEPTED_CLEANED');
  assert.equal(failedPlan.command, null);
  assert.equal(failedPlan.stagedProjectRoot, null);
  assert.equal(failedPlan.signingOverlayPath, null);
  assert.equal(await readFile(trackedProfilePath, 'utf8'), trackedProfileBefore.toString('utf8'), 'failed Hvigor CLI preserves the tracked profile');
  console.log('verify-harmony-release-build-entry: PASS (frozen gate, synthetic isolated signing overlay, metadata/name gates, static verifier gate, secret redaction, failed Hvigor cleanup; no real signing or release build)');
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
  await rm(outsideRoot, { recursive: true, force: true });
}

async function exists(target) {
  try { await stat(target); return true; } catch { return false; }
}
