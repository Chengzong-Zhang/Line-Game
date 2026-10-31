import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedVersion = '8.5.3';
const expectedSourceSha256 = 'ff26656120e7613d0718f353f7be460790473d441b44550be847f1acb23fa606';
const original = 'const p = new Promise((resolve) => call.then(() => resolve({ remove })));';
const patched = 'const p = new Promise((resolve, reject) => call.then(() => resolve({ remove }), reject));';

export async function patchCapacitorCore(source, id) {
  const normalizedId = id.replaceAll('\\', '/');
  if (!normalizedId.endsWith('/node_modules/@capacitor/core/dist/index.js')) return null;

  const packageJson = JSON.parse(await readFile(path.join(mobileRoot, 'node_modules/@capacitor/core/package.json'), 'utf8'));
  if (packageJson.version !== expectedVersion) {
    throw new Error(`Unsupported @capacitor/core version ${packageJson.version}; expected ${expectedVersion}.`);
  }
  const actualHash = createHash('sha256').update(source, 'utf8').digest('hex');
  if (actualHash !== expectedSourceSha256) {
    throw new Error(`@capacitor/core source hash mismatch (${actualHash}); review the listener patch before building.`);
  }
  const occurrences = source.split(original).length - 1;
  if (occurrences !== 1) {
    throw new Error(`Expected exactly one Capacitor addListenerNative source fragment, found ${occurrences}.`);
  }
  return source.replace(original, patched);
}

export const capacitorListenerPatch = Object.freeze({
  package: '@capacitor/core',
  version: expectedVersion,
  sourceSha256: expectedSourceSha256,
  original,
  patched,
});