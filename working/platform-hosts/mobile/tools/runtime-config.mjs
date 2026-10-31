import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isIPv4 } from 'node:net';
import path from 'node:path';

export function validateRuntimeConfig(config, environment) {
  if (!['release', 'staging'].includes(environment)) throw new Error('Environment must be release or staging.');
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || Object.keys(config).sort().join(',') !== 'apiBaseUrl,environment,trainingContributionUrl,websocketUrl'
    || config.environment !== environment
    || ['apiBaseUrl', 'websocketUrl', 'trainingContributionUrl'].some((key) => typeof config[key] !== 'string')) {
    throw new Error('Runtime config must contain exactly the four typed fields and match the selected environment.');
  }
  const parse = (value, protocol, pathname) => {
    let url;
    try { url = new URL(value); } catch { throw new Error('Runtime endpoint is not a valid absolute URL.'); }
    const hostname = url.hostname.toLowerCase();
    const ipv4Mapped = hostname.match(/^\[::ffff:(?:(\d{1,3}(?:\.\d{1,3}){3})|([\da-f]{1,4}):([\da-f]{1,4}))\]$/);
    let mappedIpv4;
    if (ipv4Mapped) {
      if (ipv4Mapped[1]) mappedIpv4 = ipv4Mapped[1];
      else {
        const high = Number.parseInt(ipv4Mapped[2], 16);
        const low = Number.parseInt(ipv4Mapped[3], 16);
        mappedIpv4 = `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
      }
    }
    const mappedLoopbackOrUnspecified = mappedIpv4 && isIPv4(mappedIpv4)
      && (/^127\./.test(mappedIpv4) || /^0\./.test(mappedIpv4));
    if (value.includes('?') || value.includes('#')
      || url.protocol !== protocol || !hostname || url.username || url.password || url.search || url.hash
      || hostname === 'localhost' || hostname === 'localhost.' || hostname.endsWith('.localhost') || hostname.endsWith('.localhost.')
      || ['[::]', '[::1]', '::', '::1', '0.0.0.0'].includes(hostname)
      || /^127\./.test(hostname) || /^0\./.test(hostname) || mappedLoopbackOrUnspecified
      || (pathname !== undefined && url.pathname !== pathname)) {
      throw new Error(`Runtime endpoint must use ${protocol} and satisfy the backend path contract.`);
    }
    if (protocol === 'https:' && url.pathname !== '/' && pathname === undefined) throw new Error('API endpoint must be an origin without a path.');
    return url;
  };
  parse(config.apiBaseUrl, 'https:');
  parse(config.websocketUrl, 'wss:', '/ws');
  parse(config.trainingContributionUrl, 'https:', '/api/training/contributions');
  return config;
}

export function createMobileCsp(runtimeConfig, environment) {
  validateRuntimeConfig(runtimeConfig, environment);
  const endpointOrigins = [...new Set([
    runtimeConfig.apiBaseUrl,
    runtimeConfig.websocketUrl,
    runtimeConfig.trainingContributionUrl,
  ].map((endpoint) => new URL(endpoint).origin))];
  if (endpointOrigins.some((origin) => !/^(?:https|wss):\/\/[^;'"<>\s]+$/.test(origin))
    || !/^wss:\/\/[^;'"<>\s]+$/.test(new URL(runtimeConfig.websocketUrl).origin)) {
    throw new Error('Validated runtime endpoint origin is not safe for a CSP source list.');
  }
  return [
    "default-src 'self'",
    // The bundled Vue runtime compiler compiles existing component template strings.
    "script-src 'self' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data: blob:",
    "connect-src 'self' " + endpointOrigins.join(' '),
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
  ].join('; ');
}

export function parseRuntimeBuildArgs(args) {
  const result = { environment: 'release', runtimeConfig: null };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!['--environment', '--runtime-config'].includes(flag) || seen.has(flag) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Invalid or duplicate build argument: ${flag}`);
    seen.add(flag);
    if (flag === '--environment') result.environment = args[++i];
    else result.runtimeConfig = args[++i];
  }
  if (!['release', 'staging'].includes(result.environment)) throw new Error('Environment must be release or staging.');
  if (result.environment === 'staging' && !seen.has('--runtime-config')) throw new Error('Staging builds require --runtime-config.');
  if (result.environment === 'release' && result.runtimeConfig) throw new Error('Release builds always use config/runtime.release.json and do not accept a runtime config override.');
  if (result.runtimeConfig) {
    const normalized = result.runtimeConfig.replaceAll('\\', '/');
    if (path.posix.isAbsolute(normalized) || normalized.split('/').includes('..') || normalized.startsWith('./') || normalized.includes(':')) throw new Error('Runtime config path must remain inside mobile/.');
  }
  return result;
}

export function canonicalRuntimeConfig(config) {
  return JSON.stringify({ environment: config.environment, apiBaseUrl: config.apiBaseUrl, websocketUrl: config.websocketUrl, trainingContributionUrl: config.trainingContributionUrl });
}

export async function loadRuntimeConfig({ mobileRoot, args }) {
  const selection = parseRuntimeBuildArgs(args);
  const relative = selection.environment === 'release' ? 'config/runtime.release.json' : selection.runtimeConfig;
  const candidate = path.resolve(mobileRoot, relative);
  const root = await realpath(mobileRoot);
  const selected = await realpath(candidate);
  if (selected !== root && !selected.startsWith(`${root}${path.sep}`)) throw new Error('Runtime config must be inside mobile/.');
  const raw = await readFile(selected);
  const config = JSON.parse(raw.toString('utf8'));
  validateRuntimeConfig(config, selection.environment);
  return { ...selection, config, configPath: selected, configRelativePath: path.relative(root, selected).replaceAll('\\', '/'), rawSha256: createHash('sha256').update(raw).digest('hex'), canonicalSha256: createHash('sha256').update(canonicalRuntimeConfig(config)).digest('hex') };
}
