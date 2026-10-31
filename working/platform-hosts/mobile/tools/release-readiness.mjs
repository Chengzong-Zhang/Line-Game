import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_HARMONY_SIGNING_FILE, readHarmonySigningMaterial } from './harmony-release-signing.mjs';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_ANDROID_SIGNING_FILE = path.join(mobileRoot, 'local_artifacts/release-signing/android-signing.json');

export function parseAndroidSigningConfig(text) {
  const parsed = JSON.parse(text);
  const required = ['storeFile', 'storePassword', 'keyAlias', 'keyPassword'];
  const missing = required.filter((key) => typeof parsed[key] !== 'string' || !parsed[key].trim());
  if (missing.length) return { ok: false, missing };
  if (!path.isAbsolute(parsed.storeFile)) return { ok: false, invalid: ['storeFile'] };
  return { ok: true, material: parsed };
}

export function validateAndroidPackageFacts({ debuggable, signatureVerified, certificateSubject }) {
  if (debuggable !== false) throw new Error('Android release package is debuggable or its manifest status is unknown.');
  if (signatureVerified !== true) throw new Error('Android release package signature is absent or invalid.');
  if (typeof certificateSubject !== 'string' || /Android Debug/i.test(certificateSubject)) {
    throw new Error('Android release package uses the Android Debug certificate or has no certificate subject.');
  }
  return true;
}

export function validateHarmonyPackageFacts({ debug, signatureVerified }) {
  if (debug !== false) throw new Error('Harmony release HAP is a debug package or its debug status is unknown.');
  if (signatureVerified !== true) throw new Error('Harmony release HAP is unsigned or its signature is invalid.');
  return true;
}

async function readAndroidMaterial(configPath, env) {
  const envKeys = {
    storeFile: 'LIFELINE_ANDROID_STORE_FILE',
    storePassword: 'LIFELINE_ANDROID_STORE_PASSWORD',
    keyAlias: 'LIFELINE_ANDROID_KEY_ALIAS',
    keyPassword: 'LIFELINE_ANDROID_KEY_PASSWORD',
  };
  let local = {};
  try {
    const contents = await readFile(configPath, 'utf8');
    local = JSON.parse(contents);
    if (!local || typeof local !== 'object' || Array.isArray(local)) return { ok: false, reason: 'invalid configuration' };
  } catch (error) {
    if (error.code !== 'ENOENT') return { ok: false, reason: 'unreadable' };
  }
  const material = Object.fromEntries(Object.entries(envKeys).map(([field, key]) => [field, env[key] || local[field]]));
  const missing = Object.keys(envKeys).filter((field) => typeof material[field] !== 'string' || !material[field].trim());
  if (missing.length) return { ok: false, missing };
  if (!path.isAbsolute(material.storeFile)) return { ok: false, invalid: ['storeFile'] };
  try { if (!(await stat(path.resolve(material.storeFile))).isFile()) return { ok: false, invalid: ['storeFile'] }; }
  catch { return { ok: false, invalid: ['storeFile'] }; }
  return { ok: true };
}

export async function evaluateReleasePreflight({
  root = path.resolve(mobileRoot, '..'),
  androidSigningFile = DEFAULT_ANDROID_SIGNING_FILE,
  harmonySigningFile = DEFAULT_HARMONY_SIGNING_FILE,
  env = process.env,
  androidPackage = null,
  harmonyPackage = null,
} = {}) {
  const identity = JSON.parse(await readFile(path.join(mobileRoot, 'config/release-identity-candidate.json'), 'utf8'));
  const identityBytes = await readFile(path.join(mobileRoot, 'config/release-identity-candidate.json'));
  const evidencePath = path.join(mobileRoot, 'config/release-evidence-candidate.json');
  const evidenceBytes = await readFile(evidencePath);
  const evidence = JSON.parse(evidenceBytes);
  const checks = [];
  const identityCheck = spawnSync(process.execPath, [path.join(mobileRoot, 'tools/release-identity.mjs'), '--check'], { cwd: root, encoding: 'utf8' });
  const identitySynced = identityCheck.status === 0;
  checks.push({
    name: 'identity-freeze',
    status: identity.status === 'FROZEN' && identitySynced ? 'READY' : 'BLOCKED',
    detail: identitySynced ? identity.status : 'identity source drift detected',
  });
  const fingerprints = identity.releaseCertificateFingerprints || {};
  const certificatesFrozen = /^[0-9a-f]{64}$/.test(fingerprints.androidSha256 || '')
    && /^[0-9a-f]{64}$/.test(fingerprints.harmonyCertChainSha256 || '');
  checks.push({ name: 'release-certificate-fingerprints', status: certificatesFrozen ? 'READY' : 'BLOCKED', detail: certificatesFrozen ? 'Android certificate and Harmony exported certificate-chain SHA-256 values frozen' : 'Android certificate and Harmony exported certificate-chain SHA-256 values are not frozen' });
  const androidSigning = await readAndroidMaterial(androidSigningFile, env);
  checks.push({ name: 'android-release-signing-material', status: androidSigning.ok ? 'READY' : 'BLOCKED', detail: androidSigning.ok ? 'material present' : 'required signing inputs unavailable' });
  const harmonySigning = await readHarmonySigningMaterial({ configPath: harmonySigningFile, env });
  checks.push({ name: 'harmony-release-signing-material', status: harmonySigning.ok ? 'READY' : 'BLOCKED', detail: harmonySigning.ok ? 'material present' : 'required signing inputs unavailable' });
  const harmonyBuildEntryFilesReady = await Promise.all([
    path.join(mobileRoot, 'tools/harmony-release-build-entry.mjs'),
    path.join(mobileRoot, 'tools/prepare-harmony-release-signing.mjs'),
    path.join(mobileRoot, 'tests/verify-harmony-release-build-entry.mjs'),
  ].map(async (file) => Boolean(await stat(file).catch(() => null)))).then((items) => items.every(Boolean));
  const harmonyBuildEntryReady = evidence.harmonySigningBuildEntryConnected === true && harmonyBuildEntryFilesReady;
  checks.push({ name: 'harmony-release-build-entry', status: harmonyBuildEntryReady ? 'READY' : 'BLOCKED', detail: harmonyBuildEntryReady ? 'isolated Hvigor release entry, prepare overlay, and synthetic gate test are connected' : 'isolated signing-aware release build entry and tests are incomplete' });
  let packageVerification = null;
  const artifactArgs = [];
  if (androidPackage) artifactArgs.push('--android-apk', path.resolve(androidPackage));
  if (harmonyPackage) artifactArgs.push('--harmony-hap', path.resolve(harmonyPackage));
  if (artifactArgs.length) {
    const verifier = spawnSync('python', [
      path.join(mobileRoot, 'tools/verify-release-artifacts.py'), '--root', root, ...artifactArgs,
    ], { cwd: root, encoding: 'utf8', timeout: 180000 });
    try {
      packageVerification = verifier.status === 0
        ? JSON.parse(verifier.stdout)
        : { status: 'BLOCKED', reason: JSON.parse(verifier.stderr).reason };
    } catch {
      packageVerification = { status: 'BLOCKED', reason: 'artifact verifier returned no parseable result' };
    }
  }
  const artifactVerification = artifactArgs.length ? {
    status: packageVerification?.status || 'BLOCKED',
    ...(packageVerification?.reason ? { reason: String(packageVerification.reason) } : {}),
    ...(androidPackage ? {
      android: packageVerification?.artifacts?.android
        ? {
          status: packageVerification.artifacts.android.status,
          sha256: packageVerification.artifacts.android.sha256 || null,
          certificateSha256: packageVerification.artifacts.android.certificateSha256 || null,
        }
        : { status: 'BLOCKED', reason: String(packageVerification?.reason || 'artifact verification failed') },
    } : {}),
    ...(harmonyPackage ? {
      harmony: packageVerification?.artifacts?.harmony
        ? {
          status: packageVerification.artifacts.harmony.status,
          sha256: packageVerification.artifacts.harmony.sha256 || null,
          certificateChainSha256: packageVerification.artifacts.harmony.certificateChainSha256 || null,
        }
        : { status: 'BLOCKED', reason: String(packageVerification?.reason || 'artifact verification failed') },
    } : {}),
  } : null;
  const artifactResults = packageVerification?.artifacts || {};
  const androidPackageReady = androidPackage && artifactResults.android?.status === 'PASS_SIGNED_RELEASE_APK_STATIC';
  const harmonyPackageReady = harmonyPackage && artifactResults.harmony?.status === 'PASS_SIGNED_RELEASE_HAP_STATIC';
  checks.push({ name: 'android-release-package', status: androidPackageReady ? 'READY' : 'BLOCKED', detail: androidPackage ? (androidPackageReady ? 'static APK signature/identity checks passed' : 'static APK checks failed or not verified') : 'no release APK supplied' });
  checks.push({ name: 'harmony-release-package', status: harmonyPackageReady ? 'READY' : 'BLOCKED', detail: harmonyPackage ? (harmonyPackageReady ? 'static HAP signature/identity checks passed' : 'static HAP checks failed or not verified') : 'no signed release HAP supplied' });
  const validPrivacyUrl = typeof evidence.privacyPolicyUrl === 'string'
    && /^https:\/\//i.test(evidence.privacyPolicyUrl)
    && !/example|placeholder/i.test(evidence.privacyPolicyUrl);
  checks.push({ name: 'privacy-policy-url', status: validPrivacyUrl ? 'READY' : 'BLOCKED', detail: validPrivacyUrl ? 'HTTPS policy URL provided' : 'verified release evidence not provided' });
  for (const [name, value] of [
    ['responsible-party', evidence.responsibleParty],
    ['customer-service-details', evidence.customerService],
    ['app-filing', evidence.appFilingNumber],
  ]) {
    const ready = typeof value === 'string' && value.trim().length > 0;
    checks.push({ name, status: ready ? 'READY' : 'BLOCKED', detail: ready ? 'release evidence provided' : 'verified release evidence not provided' });
  }
  const channelMaterialsReady = Array.isArray(evidence.channelMaterials) && evidence.channelMaterials.length > 0
    && evidence.channelMaterials.every((item) => typeof item === 'string' && item.trim());
  checks.push({ name: 'channel-materials', status: channelMaterialsReady ? 'READY' : 'BLOCKED', detail: channelMaterialsReady ? 'channel material index provided' : 'verified release evidence not provided' });
  const blocked = checks.filter((check) => check.status === 'BLOCKED');
  const webReceiptPath = path.join(mobileRoot, 'local_artifacts/mobile-web-build-receipt.json');
  const sourceManifestPath = path.join(mobileRoot, 'config/current-web-sync-source-manifest.json');
  let webReceiptSha256 = null;
  let sourceManifestSha256 = null;
  try { webReceiptSha256 = createHash('sha256').update(await readFile(webReceiptPath)).digest('hex'); } catch {}
  try { sourceManifestSha256 = createHash('sha256').update(await readFile(sourceManifestPath)).digest('hex'); } catch {}
  return {
    schema: 'lifeline-mobile-release-preflight-v1',
    checkedAt: new Date().toISOString(),
    status: blocked.length ? 'BLOCKED' : 'READY',
    identityStatus: identity.status,
    identitySha256: createHash('sha256').update(identityBytes).digest('hex'),
    webBuildReceiptSha256: webReceiptSha256,
    sourceManifestSha256,
    releaseEvidenceSha256: createHash('sha256').update(evidenceBytes).digest('hex'),
    artifactVerification,
    checks,
    blockedCount: blocked.length,
  };
}

export async function writePreflightReceipt(report, outputPath) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}
