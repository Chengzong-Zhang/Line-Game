import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_HARMONY_SIGNING_FILE = path.join(mobileRoot, 'local_artifacts/release-signing/harmony-signing.json');
export const DEFAULT_HARMONY_OVERLAY_FILE = path.join(mobileRoot, 'local_artifacts/release-signing/harmony-build-profile.generated.json5');
export const HARMONY_SIGNING_FIELDS = Object.freeze([
  'storeFile', 'storePassword', 'keyAlias', 'keyPassword', 'signAlg', 'profile', 'certpath',
]);

function fromEnvironment(env) {
  const map = {
    storeFile: 'LIFELINE_HARMONY_STORE_FILE',
    storePassword: 'LIFELINE_HARMONY_STORE_PASSWORD',
    keyAlias: 'LIFELINE_HARMONY_KEY_ALIAS',
    keyPassword: 'LIFELINE_HARMONY_KEY_PASSWORD',
    signAlg: 'LIFELINE_HARMONY_SIGN_ALG',
    profile: 'LIFELINE_HARMONY_PROFILE',
    certpath: 'LIFELINE_HARMONY_CERTPATH',
  };
  return Object.fromEntries(Object.entries(map).filter(([, key]) => env[key] !== undefined).map(([field, key]) => [field, env[key]]));
}

export async function readHarmonySigningMaterial({ configPath = DEFAULT_HARMONY_SIGNING_FILE, env = process.env } = {}) {
  const envMaterial = fromEnvironment(env);
  let fileMaterial = {};
  try {
    fileMaterial = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Harmony signing configuration is unreadable or invalid JSON.');
  }
  const selected = { ...fileMaterial, ...envMaterial };
  const material = Object.fromEntries(HARMONY_SIGNING_FIELDS.map((field) => [field, selected[field]]));
  const missing = HARMONY_SIGNING_FIELDS.filter((field) => typeof material[field] !== 'string' || material[field].trim() === '');
  if (missing.length) return { ok: false, missing };
  if (material.signAlg !== 'SHA256withECDSA') return { ok: false, missing: [], invalid: ['signAlg'] };
  for (const field of ['storeFile', 'profile', 'certpath']) {
    if (!path.isAbsolute(material[field])) return { ok: false, missing: [], invalid: [field] };
    const resolved = path.resolve(material[field]);
    try { if (!(await stat(resolved)).isFile()) return { ok: false, missing: [], invalid: [field] }; }
    catch { return { ok: false, missing: [], invalid: [field] }; }
    material[field] = resolved;
  }
  return { ok: true, material };
}

export async function generateHarmonySigningOverlay({
  configPath = DEFAULT_HARMONY_SIGNING_FILE,
  outputPath = DEFAULT_HARMONY_OVERLAY_FILE,
  baseProfilePath = path.join(mobileRoot, 'harmony/build-profile.json5'),
  env = process.env,
} = {}) {
  const loaded = await readHarmonySigningMaterial({ configPath, env });
  if (!loaded.ok) return loaded;
  const repositoryRoot = path.resolve(mobileRoot, '..');
  const normalizedOutput = path.resolve(outputPath);
  const localArtifactsRoot = path.join(mobileRoot, 'local_artifacts');
  const comparePath = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  const normalizedComparable = comparePath(normalizedOutput);
  const repositoryComparable = comparePath(repositoryRoot);
  const artifactsComparable = comparePath(localArtifactsRoot);
  const insideRepository = normalizedComparable === repositoryComparable || normalizedComparable.startsWith(`${repositoryComparable}${path.sep}`);
  const insideIgnoredArtifacts = normalizedComparable === artifactsComparable || normalizedComparable.startsWith(`${artifactsComparable}${path.sep}`);
  if (insideRepository && !insideIgnoredArtifacts) throw new Error('Harmony signing overlay output must stay under ignored mobile/local_artifacts.');
  let base;
  try { base = JSON.parse(await readFile(baseProfilePath, 'utf8')); } catch { throw new Error('Tracked Harmony build profile is not valid JSON.'); }
  const app = base.app;
  if (!app || !Array.isArray(app.products)) throw new Error('Harmony app/products configuration is missing.');
  const product = app.products.find((item) => item.name === 'default');
  if (!product) throw new Error('Harmony default product is missing.');
  const material = loaded.material;
  app.signingConfigs = [{ name: 'lifeline-release', type: 'HarmonyOS', material }];
  product.signingConfig = 'lifeline-release';
  await mkdir(path.dirname(outputPath), { recursive: true });
  try {
    await writeFile(normalizedOutput, `${JSON.stringify(base, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Harmony signing overlay already exists under ignored local artifacts; remove that generated file before regenerating.');
    throw error;
  }
  return { ok: true, outputPath: normalizedOutput };
}
