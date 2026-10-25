import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { modelForProfile } from './model-catalog.js';

export function checkedModelBytes(entry, raw) {
  // Accept copied ArrayBuffers across JS realms; never depend on a prototype
  // surviving the native Worker message bridge.
  if (Object.prototype.toString.call(raw) !== '[object ArrayBuffer]' || raw.byteLength !== entry.bytes) {
    throw new Error('MODEL_INTEGRITY');
  }
  const bytes = new Uint8Array(raw);
  if (bytesToHex(sha256(bytes)) !== entry.spec.asset_sha256) throw new Error('MODEL_INTEGRITY');
  return bytes;
}

export class ModelAssets {
  constructor(platform) { this.platform = platform; this.cache = new Map(); }
  async load(profile, current = () => true, progress = () => {}) {
    const entry = modelForProfile(profile);
    if (!entry) throw new Error('INVALID_CONTROLLERS');
    const check = () => { if (!current()) throw new Error('CANCELLED'); };
    check();
    if (this.cache.has(entry.id)) {
      const data = this.cache.get(entry.id); this.cache.delete(entry.id); this.cache.set(entry.id, data);
      return { id: entry.id, raw: data };
    }
    if (!this.platform.loadSubpackage || !this.platform.readAsset) throw new Error('MODELS_UNAVAILABLE');
    const report = value => { if (current()) progress(Math.max(0, Math.min(100, Math.round(Number(value) || 0)))); };
    await this.platform.loadSubpackage(entry.packageName, report); check();
    const raw = await this.platform.readAsset(entry.assetPath); check();
    checkedModelBytes(entry, raw); check();
    // At most two complete raw models (about 6 MB). A restart drops the cache;
    // a corrupt/cancelled read is never retained. No local replay is uploaded.
    this.cache.set(entry.id, raw);
    while (this.cache.size > 2) this.cache.delete(this.cache.keys().next().value);
    return { id: entry.id, raw };
  }
  clear() { this.cache.clear(); }
}
