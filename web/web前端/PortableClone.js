// Clone game protocol and model data on runtimes without structuredClone.
// Plain records, collections and binary model buffers retain their value types.
export function portableClone(value) {
  if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value);
  const seen = new Map();
  const clone = source => {
    if (source === null || typeof source !== 'object') {
      if (typeof source === 'function' || typeof source === 'symbol') throw new TypeError('Unsupported clone value');
      return source;
    }
    if (seen.has(source)) return seen.get(source);
    if (source instanceof ArrayBuffer) { const result = source.slice(0); seen.set(source, result); return result; }
    if (ArrayBuffer.isView(source)) {
      const buffer = clone(source.buffer);
      const result = source instanceof DataView ? new DataView(buffer, source.byteOffset, source.byteLength)
        : new source.constructor(buffer, source.byteOffset, source.length);
      seen.set(source, result); return result;
    }
    if (source instanceof Date) { const result = new Date(source.getTime()); seen.set(source, result); return result; }
    if (source instanceof Map) {
      const result = new Map(); seen.set(source, result);
      for (const [key, item] of source) result.set(clone(key), clone(item)); return result;
    }
    if (source instanceof Set) {
      const result = new Set(); seen.set(source, result);
      for (const item of source) result.add(clone(item)); return result;
    }
    const result = Array.isArray(source) ? [] : {};
    seen.set(source, result);
    for (const key of Object.keys(source)) Object.defineProperty(result, key,
      { value: clone(source[key]), enumerable: true, writable: true, configurable: true });
    return result;
  };
  return clone(value);
}
