import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(mobileRoot, '..');
const dist = path.join(mobileRoot, 'dist');
const harmonyRawfileWeb = path.join(mobileRoot, 'harmony/entry/src/main/resources/rawfile/web');
const harmonyAssetManifest = path.join(mobileRoot, 'harmony/entry/src/main/ets/generated/AssetManifest.ets');
const receiptPath = path.join(mobileRoot, 'local_artifacts/mobile-web-build-receipt.json');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const walk = async (root, prefix = '') => {
  const rows = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = path.posix.join(prefix.replaceAll('\\', '/'), entry.name);
    if (entry.isDirectory()) rows.push(...await walk(root, relative));
    else rows.push({ path: relative, sha256: digest(await readFile(path.join(root, relative))) });
  }
  return rows;
};
const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
receipt.dist_files = (await walk(dist)).sort((a, b) => a.path.localeCompare(b.path, 'en'));
receipt.dist_file_count = receipt.dist_files.length;
receipt.dist_manifest_sha256 = digest(Buffer.from(JSON.stringify(receipt.dist_files), 'utf8'));
receipt.harmony_rawfile_files = (await walk(harmonyRawfileWeb))
  .filter(({ path: name }) => name !== '.lifeline-generated-assets')
  .sort((a, b) => a.path.localeCompare(b.path, 'en'));
if (JSON.stringify(receipt.harmony_rawfile_files) !== JSON.stringify(receipt.dist_files)) {
  throw new Error('Harmony rawfile resources do not exactly match the verified mobile dist output.');
}
receipt.harmony_rawfile_manifest_sha256 = digest(Buffer.from(JSON.stringify(receipt.harmony_rawfile_files), 'utf8'));
receipt.harmony_asset_manifest_ets_sha256 = digest(await readFile(harmonyAssetManifest));
const finalizer = path.join(repoRoot, 'mobile/tools/finalize-build-receipt.mjs');
const finalizerIndex = receipt.source_files.findIndex(({ path: name }) => name === 'mobile/tools/finalize-build-receipt.mjs');
if (finalizerIndex < 0) throw new Error('Build receipt does not bind the finalizer source.');
receipt.source_files[finalizerIndex].sha256 = digest(await readFile(finalizer));
await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ status: receipt.status, dist_file_count: receipt.dist_file_count, dist_manifest_sha256: receipt.dist_manifest_sha256 }));
