export const CAPABILITY_SCHEMA_VERSION = 1;
export const CAPABILITY_QUERY_TIMEOUT_MS = 5_000;

export const CAPABILITY_NAMES = Object.freeze([
  'sessionStorage',
  'credentialStorage',
  'replayShare',
  'replayImport',
  'tutorialHost',
  'appInfo',
  'background',
  'backEvents',
  'appLifecycle',
  'systemNetwork',
  'haptics',
  'channelLogin',
  'realName',
]);

const SUPPORT_VALUES = new Set(['implemented', 'not-implemented', 'unknown']);
const IMPLEMENTATION_VALUES = new Set(['native', 'browser', 'none', 'unknown']);
const FAILURE_REASONS = new Set([
  'missing-bridge',
  'timeout',
  'native-error',
  'unsupported-version',
  'invalid-response',
]);

function unknownCapability(reason) {
  return { support: 'unknown', implementation: 'unknown', reason };
}

export function createCapabilities({ platform, source, implementations = {} }) {
  const capabilities = {};
  for (const name of CAPABILITY_NAMES) {
    const implementation = implementations[name];
    capabilities[name] = implementation === 'native' || implementation === 'browser'
      ? { support: 'implemented', implementation }
      : { support: 'not-implemented', implementation: 'none' };
  }
  return { schemaVersion: CAPABILITY_SCHEMA_VERSION, platform, source, capabilities };
}

export function createUnknownCapabilities(platform, source, reason) {
  const failureReason = FAILURE_REASONS.has(reason) ? reason : 'native-error';
  const capabilities = {};
  for (const name of CAPABILITY_NAMES) capabilities[name] = unknownCapability(failureReason);
  return { schemaVersion: CAPABILITY_SCHEMA_VERSION, platform, source, capabilities };
}

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCapability(value) {
  if (!isPlainRecord(value)) return unknownCapability('invalid-response');
  const { support, implementation, reason } = value;
  if (Object.keys(value).some((key) => !['support', 'implementation', 'reason'].includes(key))) {
    return unknownCapability('invalid-response');
  }
  if (!SUPPORT_VALUES.has(support) || !IMPLEMENTATION_VALUES.has(implementation)) {
    return unknownCapability('invalid-response');
  }
  if (support === 'implemented' && !['native', 'browser'].includes(implementation)) {
    return unknownCapability('invalid-response');
  }
  if (support === 'not-implemented' && implementation !== 'none') {
    return unknownCapability('invalid-response');
  }
  if (support === 'unknown') {
    return implementation === 'unknown' && FAILURE_REASONS.has(reason)
      ? unknownCapability(reason)
      : unknownCapability('invalid-response');
  }
  if (Object.hasOwn(value, 'reason')) return unknownCapability('invalid-response');
  return { support, implementation };
}

export function normalizeCapabilities(value, { platform, source }) {
  if (!isPlainRecord(value)
    || value.schemaVersion !== CAPABILITY_SCHEMA_VERSION
    || value.platform !== platform
    || value.source !== source
    || !isPlainRecord(value.capabilities)
    || Object.keys(value).some((key) => !['schemaVersion', 'platform', 'source', 'capabilities'].includes(key))
    || Object.keys(value.capabilities).some((key) => !CAPABILITY_NAMES.includes(key))) {
    const reason = isPlainRecord(value) && value.schemaVersion !== CAPABILITY_SCHEMA_VERSION
      ? 'unsupported-version'
      : 'invalid-response';
    return createUnknownCapabilities(platform, source, reason);
  }

  const capabilities = {};
  for (const name of CAPABILITY_NAMES) {
    capabilities[name] = normalizeCapability(value.capabilities[name]);
  }
  return { schemaVersion: CAPABILITY_SCHEMA_VERSION, platform, source, capabilities };
}

export async function queryCapabilities({ read, platform, source }) {
  if (typeof read !== 'function') return createUnknownCapabilities(platform, source, 'missing-bridge');
  let timeoutId = null;
  let timedOut = false;
  const timeout = new Promise((resolve) => {
    timeoutId = globalThis.setTimeout(() => {
      timedOut = true;
      resolve(createUnknownCapabilities(platform, source, 'timeout'));
    }, CAPABILITY_QUERY_TIMEOUT_MS);
  });
  const result = Promise.resolve().then(read).then(
    (value) => normalizeCapabilities(value, { platform, source }),
    (error) => createUnknownCapabilities(
      platform,
      source,
      error?.code === 'timeout' ? 'timeout' : 'native-error',
    ),
  );
  try {
    return await Promise.race([result, timeout]);
  } catch (_error) {
    return createUnknownCapabilities(platform, source, timedOut ? 'timeout' : 'native-error');
  } finally {
    if (timeoutId !== null) globalThis.clearTimeout(timeoutId);
  }
}
