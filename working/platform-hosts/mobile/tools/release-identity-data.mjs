export function validateIdentity(identity) {
  if (identity.schema !== 'lifeline-mobile-release-identity-candidate-v1'
      || !['DEVELOPMENT_CANDIDATE_NOT_FROZEN', 'FROZEN'].includes(identity.status)) {
    throw new Error('Unexpected release identity status.');
  }
  if (!identity.displayName || identity.android.versionName !== identity.harmony.versionName
      || identity.android.versionCode !== identity.harmony.versionCode) {
    throw new Error('Android and Harmony release display/version values must match.');
  }
  if (!Number.isSafeInteger(identity.android.versionCode) || identity.android.versionCode < 1) {
    throw new Error('versionCode must be a positive safe integer.');
  }
  if (!identity.releaseCertificateFingerprints
      || !['androidSha256', 'harmonyCertChainSha256'].every((key) => identity.releaseCertificateFingerprints[key] === null
        || /^[0-9a-f]{64}$/.test(identity.releaseCertificateFingerprints[key]))) {
    throw new Error('Release certificate fingerprint fields must be null or lowercase SHA-256 hex.');
  }
  const validPackageId = (value) => typeof value === 'string' && value.split('.').length >= 2
    && value.split('.').every((part) => /^[A-Za-z][A-Za-z0-9_]*$/.test(part));
  if (!validPackageId(identity.android.applicationId) || !validPackageId(identity.android.namespace)
      || !validPackageId(identity.android.capacitorAppId) || !validPackageId(identity.android.urlScheme)
      || !validPackageId(identity.harmony.bundleName)
      || identity.android.namespace !== identity.android.applicationId
      || identity.android.capacitorAppId !== identity.android.applicationId
      || identity.android.urlScheme !== identity.android.applicationId) {
    throw new Error('Candidate package identifiers are invalid.');
  }
  return true;
}
