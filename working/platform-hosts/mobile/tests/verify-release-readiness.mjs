import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateHarmonySigningOverlay, readHarmonySigningMaterial } from '../tools/harmony-release-signing.mjs';
import { evaluateReleasePreflight, parseAndroidSigningConfig, validateAndroidPackageFacts, validateHarmonyPackageFacts } from '../tools/release-readiness.mjs';
import { validateIdentity } from '../tools/release-identity-data.mjs';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(mobileRoot, '..');
const syncCheck = spawnSync(process.execPath, [path.join(mobileRoot, 'tools/release-identity.mjs'), '--check'], { cwd: repoRoot, encoding: 'utf8' });
assert.equal(syncCheck.status, 0, syncCheck.stderr || syncCheck.stdout);
const identity = JSON.parse(await readFile(path.join(mobileRoot, 'config/release-identity-candidate.json'), 'utf8'));
assert.equal(validateIdentity(identity), true);
assert.throws(() => validateIdentity({ ...identity, harmony: { ...identity.harmony, bundleName: 'cn.lifeline.' } }), /identifiers/);
assert.throws(() => validateIdentity({ ...identity, status: 'FROZEN_WITHOUT_APPROVAL' }), /status/);

assert.throws(() => validateAndroidPackageFacts({ debuggable: true, signatureVerified: true, certificateSubject: 'CN=Release' }), /debuggable/);
assert.throws(() => validateAndroidPackageFacts({ debuggable: false, signatureVerified: false, certificateSubject: 'CN=Release' }), /signature/);
assert.throws(() => validateAndroidPackageFacts({ debuggable: false, signatureVerified: true, certificateSubject: 'CN=Android Debug' }), /Android Debug/);
assert.equal(validateAndroidPackageFacts({ debuggable: false, signatureVerified: true, certificateSubject: 'CN=Release' }), true);
assert.equal(parseAndroidSigningConfig(JSON.stringify({
  storeFile: 'C:\\Release Artifacts\\LIFELINE key.jks',
  storePassword: 'fixture-store-password', keyAlias: 'fixture-alias', keyPassword: 'fixture-key-password',
})).ok, true, 'Windows absolute paths with spaces and backslashes must parse from JSON safely');
assert.deepEqual(parseAndroidSigningConfig(JSON.stringify({
  storeFile: 'relative path/key.jks', storePassword: 'x', keyAlias: 'x', keyPassword: 'x',
})).invalid, ['storeFile']);
assert.throws(() => validateHarmonyPackageFacts({ debug: true, signatureVerified: true }), /debug package/);
assert.throws(() => validateHarmonyPackageFacts({ debug: false, signatureVerified: false }), /unsigned/);
assert.equal(validateHarmonyPackageFacts({ debug: false, signatureVerified: true }), true);

const temporary = await mkdtemp(path.join(os.tmpdir(), 'lifeline-release-readiness-'));
try {
  const storeFile = path.join(temporary, 'synthetic.p12');
  const profile = path.join(temporary, 'synthetic.p7b');
  const certpath = path.join(temporary, 'synthetic.cer');
  for (const file of [storeFile, profile, certpath]) await writeFile(file, 'synthetic fixture only');
  const configPath = path.join(temporary, 'harmony-signing.json');
  await writeFile(configPath, JSON.stringify({
    storeFile,
    storePassword: 'fixture-store-password',
    keyAlias: 'fixture-alias',
    keyPassword: 'fixture-key-password',
    signAlg: 'SHA256withECDSA',
    profile,
    certpath,
  }));
  const missing = await readHarmonySigningMaterial({ configPath: path.join(temporary, 'absent.json'), env: {} });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ['storeFile', 'storePassword', 'keyAlias', 'keyPassword', 'signAlg', 'profile', 'certpath']);
  const outputPath = path.join(temporary, 'generated', 'build-profile.json5');
  const generated = await generateHarmonySigningOverlay({ configPath, outputPath });
  assert.equal(generated.ok, true);
  const overlay = JSON.parse(await readFile(outputPath, 'utf8'));
  assert.equal(overlay.app.products.find((item) => item.name === 'default').signingConfig, 'lifeline-release');
  assert.equal(overlay.app.signingConfigs[0].material.signAlg, 'SHA256withECDSA');
  assert.equal(overlay.app.signingConfigs[0].material.storePassword, 'fixture-store-password');
  assert.equal((await readFile(path.join(mobileRoot, 'harmony/build-profile.json5'), 'utf8')).includes('signingConfig'), false,
    'tracked Harmony profile must not be rewritten with secret material');
  await assert.rejects(() => generateHarmonySigningOverlay({
    configPath,
    outputPath: path.join(mobileRoot, 'harmony/release-build-profile.json5'),
  }), /must stay under ignored mobile\/local_artifacts/);
  const invalidConfigPath = path.join(temporary, 'invalid.json');
  await writeFile(invalidConfigPath, JSON.stringify({ storeFile, storePassword: 'x', keyAlias: 'x', keyPassword: 'x', signAlg: 'SHA256', profile, certpath }));
  assert.deepEqual((await readHarmonySigningMaterial({ configPath: invalidConfigPath, env: {} })).invalid, ['signAlg']);
  const relativeConfigPath = path.join(temporary, 'relative.json');
  await writeFile(relativeConfigPath, JSON.stringify({
    storeFile: 'relative/store.p12', storePassword: 'x', keyAlias: 'x', keyPassword: 'x',
    signAlg: 'SHA256withECDSA', profile, certpath,
  }));
  assert.deepEqual((await readHarmonySigningMaterial({ configPath: relativeConfigPath, env: {} })).invalid, ['storeFile']);
  const androidConfigPath = path.join(temporary, 'android-signing.json');
  await writeFile(androidConfigPath, JSON.stringify({
    storeFile, storePassword: 'fixture-store-password', keyAlias: 'fixture-alias', keyPassword: 'fixture-key-password',
  }));
  const readyAndroidOnly = await evaluateReleasePreflight({
    androidSigningFile: androidConfigPath,
    harmonySigningFile: path.join(temporary, 'missing-harmony.json'),
    env: {},
  });
  assert.equal(readyAndroidOnly.checks.find(({ name }) => name === 'android-release-signing-material').status, 'READY');
  const report = await evaluateReleasePreflight({
    androidSigningFile: path.join(temporary, 'missing-android.properties'),
    harmonySigningFile: path.join(temporary, 'missing-harmony.json'),
    androidPackage: path.join(temporary, 'candidate-debug.apk'),
    env: {},
  });
  assert.equal(report.checks.find(({ name }) => name === 'harmony-release-build-entry').status, 'READY', 'isolated Harmony build entry is connected while identity/signing/release evidence gates remain blocked');
  assert.equal(report.status, 'BLOCKED');
  assert.equal(report.blockedCount, report.checks.length - 1, 'the connected build entry is the only READY release-preflight check');
  assert.ok(Date.parse(report.checkedAt), 'preflight receipt includes an ISO check time');
  assert.match(report.identitySha256, /^[0-9a-f]{64}$/);
  assert.match(report.sourceManifestSha256, /^[0-9a-f]{64}$/);
  assert.match(report.webBuildReceiptSha256, /^[0-9a-f]{64}$/);
  assert.equal(report.artifactVerification.status, 'BLOCKED');
  assert.equal(report.artifactVerification.android.status, 'BLOCKED');
  assert.equal(typeof report.artifactVerification.reason, 'string');
  assert.equal(JSON.stringify(report).includes('fixture-store-password'), false, 'preflight must never receipt-bind passwords');
  assert.equal(JSON.stringify(report).includes('fixture-key-password'), false, 'preflight must never receipt-bind passwords');

  const artifactVerifier = path.join(mobileRoot, 'tools/verify-release-artifacts.py');
  const currentCandidate = spawnSync('python', [artifactVerifier, '--root', repoRoot], { encoding: 'utf8' });
  assert.equal(currentCandidate.status, 1);
  assert.match(currentCandidate.stderr, /identity must be FROZEN/i);

  const temporaryRoot = path.join(temporary, 'mismatched-receipt-root');
  await mkdir(path.join(temporaryRoot, 'mobile/config'), { recursive: true });
  await mkdir(path.join(temporaryRoot, 'mobile/local_artifacts'), { recursive: true });
  const frozenIdentity = { ...identity, status: 'FROZEN' };
  await writeFile(path.join(temporaryRoot, 'mobile/config/release-identity-candidate.json'), JSON.stringify(frozenIdentity));
  await copyFile(path.join(mobileRoot, 'config/current-web-sync-source-manifest.json'), path.join(temporaryRoot, 'mobile/config/current-web-sync-source-manifest.json'));
  const currentReceipt = JSON.parse(await readFile(path.join(mobileRoot, 'local_artifacts/mobile-web-build-receipt.json'), 'utf8'));
  currentReceipt.current_web_sync_source_manifest_sha256 = '0'.repeat(64);
  await writeFile(path.join(temporaryRoot, 'mobile/local_artifacts/mobile-web-build-receipt.json'), JSON.stringify(currentReceipt));
  const mismatchedReceipt = spawnSync('python', [artifactVerifier, '--root', temporaryRoot], { encoding: 'utf8' });
  assert.equal(mismatchedReceipt.status, 1);
  assert.match(mismatchedReceipt.stderr, /does not match the tracked source manifest/i);

  const androidVerifierArgs = ['--apk', 'fixture.apk', '--run-dir', 'fixture-run'];
  const missingAndroidReceipt = spawnSync('python', [path.join(mobileRoot, 'tools/verify-l26-android-apk.py'), ...androidVerifierArgs], { encoding: 'utf8' });
  assert.equal(missingAndroidReceipt.status, 2);
  assert.match(missingAndroidReceipt.stderr, /--receipt/i);
  const missingHarmonyReceipt = spawnSync('python', [path.join(mobileRoot, 'tools/verify-l26-harmony-hap.py'), '--hap', 'fixture.hap', '--build-log', 'fixture.log', '--run-dir', 'fixture-run'], { encoding: 'utf8' });
  assert.equal(missingHarmonyReceipt.status, 2);
  assert.match(missingHarmonyReceipt.stderr, /--receipt/i);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
const buildEntryCheck = spawnSync(process.execPath, [path.join(mobileRoot, 'tests/verify-harmony-release-build-entry.mjs')], { cwd: repoRoot, encoding: 'utf8' });
assert.equal(buildEntryCheck.status, 0, buildEntryCheck.stderr || buildEntryCheck.stdout);
assert.match(buildEntryCheck.stdout, /verify-harmony-release-build-entry: PASS/);
console.log('Release readiness checks passed (synthetic signing fixtures only; no signing performed).');
