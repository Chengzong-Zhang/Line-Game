import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const sourceValue = args.get('--source');
const sourceRoot = sourceValue ? path.resolve(sourceValue) : null;
const mode = args.get('--mode') ?? 'verify';
const allowReplace = process.argv.includes('--replace-mismatches');
if (!sourceRoot || !['copy', 'verify'].includes(mode)) {
  console.error('Usage: node mobile/tools/snapshot-release-baseline.mjs --source <release web frontend> [--mode copy|verify] [--replace-mismatches]');
  process.exit(2);
}

const manifestPath = path.join(repoRoot, 'mobile/config/release-baseline-manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest.commit !== '09b64f11e08126a4fb523ed4813b6fbde6ef4238' || manifest.asset_version !== '20261013-full-features1') {
  throw new Error('Unexpected source release identity');
}
const entries = Object.entries(manifest.files ?? {}).sort(([a], [b]) => a.localeCompare(b));
if (entries.length !== 74) throw new Error(`Expected 74 release files, found ${entries.length}`);
const hashFile = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
const safeFile = (root, relative) => {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error(`Unsafe manifest path: ${relative}`);
  return path.join(root, relative);
};

const errors = [];
for (const [relative, expected] of entries) {
  const src = safeFile(sourceRoot, relative);
  const actual = await hashFile(src).catch(() => null);
  if (actual !== expected) errors.push({ relative, expected, source: actual });
}
if (errors.length) {
  console.error(JSON.stringify({ source_mismatches: errors }, null, 2));
  process.exit(1);
}

const targetRoot = path.join(repoRoot, 'web/web前端');
const differences = [];
for (const [relative, expected] of entries) {
  const target = safeFile(targetRoot, relative);
  const actual = await hashFile(target).catch(() => null);
  if (actual !== expected) differences.push({ relative, target: actual, expected });
}
if (mode === 'copy') {
  if (differences.length && !allowReplace) {
    console.error(JSON.stringify({ target_mismatches: differences, hint: 'Use --replace-mismatches only for the pristine 09b64f1 mobile baseline.' }, null, 2));
    process.exit(1);
  }
  for (const [relative] of entries) {
    const target = safeFile(targetRoot, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(safeFile(sourceRoot, relative), target);
  }
}

const verified = [];
for (const [relative, expected] of entries) {
  const actual = await hashFile(safeFile(targetRoot, relative)).catch(() => null);
  if (actual !== expected) throw new Error(`Target verification failed: ${relative}`);
  verified.push({ path: relative, sha256: actual });
}
const sourceCommit = await (async () => {
  const { execFileSync } = await import('node:child_process');
  return execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
})().catch(() => 'unknown');
const receipt = {
  schema: 'lifeline-mobile-baseline-receipt-v1',
  status: 'PASS-CURRENT',
  source_release_id: manifest.release_id,
  source_asset_version: manifest.asset_version,
  source_declared_commit: manifest.commit,
  source_checkout_commit: sourceCommit,
  source_manifest_sha256: await hashFile(manifestPath),
  file_count: verified.length,
  copied: mode === 'copy',
  files: verified,
};
let receiptLabel = null;
if (mode === 'copy' || args.has('--receipt')) {
  const receiptPath = path.resolve(repoRoot, args.get('--receipt') ?? 'docs/verification/mobile-baseline-20261013/baseline-receipt.json');
  await mkdir(path.dirname(receiptPath), { recursive: true });
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  receiptLabel = path.relative(repoRoot, receiptPath);
}
console.log(JSON.stringify({ status: receipt.status, file_count: receipt.file_count, copied: receipt.copied, source_checkout_commit: sourceCommit, receipt: receiptLabel }));
