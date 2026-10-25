import fs from 'node:fs/promises';
import path from 'node:path';
import { isIP } from 'node:net';

export const CONFIG_KEYS = ['apiBase', 'onlineEnabled', 'workerTimeoutMs'];

// Values are deliberately omitted from errors: accidental client secrets must
// not be repeated in console output or transfer receipts.
export function validateClientConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    Object.keys(input).length !== CONFIG_KEYS.length ||
    Object.keys(input).some(key => !CONFIG_KEYS.includes(key))) {
    throw new Error('Unknown or missing client config field; never put secrets here');
  }
  if (typeof input.apiBase !== 'string' || typeof input.onlineEnabled !== 'boolean' ||
    !Number.isInteger(input.workerTimeoutMs) || input.workerTimeoutMs < 1000 || input.workerTimeoutMs > 60000) {
    throw new Error('Invalid client config');
  }
  const config = { ...input };
  if (config.apiBase) {
    let endpoint;
    try { endpoint = new URL(config.apiBase); } catch { throw new Error('Invalid apiBase'); }
    if (config.apiBase !== config.apiBase.trim() || /[\\\s]/.test(config.apiBase) ||
      endpoint.protocol !== 'https:' || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || endpoint.pathname !== '/' || endpoint.port ||
      isIP(endpoint.hostname) || !endpoint.hostname.includes('.') || endpoint.hostname.length > 253 ||
      /\.(?:localhost|local|invalid|test|example)$/.test(endpoint.hostname) ||
      !endpoint.hostname.split('.').every(part => part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))) {
      throw new Error('apiBase must be a public HTTPS origin without credentials, path, non-default port, query or fragment');
    }
    config.apiBase = endpoint.origin;
  }
  if (config.onlineEnabled && !config.apiBase) throw new Error('Online requires a configured backend');
  return config;
}

export async function readClientConfig(root) {
  let config = JSON.parse(await fs.readFile(path.join(root, 'config.example.json'), 'utf8'));
  let localConfig = false;
  try {
    config = { ...config, ...JSON.parse(await fs.readFile(path.join(root, 'config.local.json'), 'utf8')) };
    localConfig = true;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { config: validateClientConfig(config), localConfig };
}

export function requireProfile(config, profile) {
  if (!['offline', 'online'].includes(profile)) throw new Error('Invalid candidate profile');
  if (profile === 'offline' && (config.onlineEnabled || config.apiBase !== '')) {
    throw new Error('This candidate is restricted to the offline core configuration; use the explicit online entry');
  }
  if (profile === 'online' && (!config.onlineEnabled || !config.apiBase)) {
    throw new Error('Online candidate requires an enabled HTTPS service origin');
  }
}
