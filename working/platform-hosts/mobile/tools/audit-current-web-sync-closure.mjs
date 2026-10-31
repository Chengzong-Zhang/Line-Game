import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditCurrentWebSyncClosure } from './current-web-sync-closure.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (!key.startsWith('--') || index + 1 >= process.argv.length) {
    throw new Error('Usage: node tools/audit-current-web-sync-closure.mjs --source-web-root PATH [--mode live|package] [--output PATH]');
  }
  args.set(key, process.argv[++index]);
}
const sourceWebRoot = args.get('--source-web-root') ?? process.env.LIFELINE_CURRENT_WEB_ROOT;
if (!sourceWebRoot) throw new Error('A live Web source root is required for closure auditing.');
const mode = args.get('--mode') ?? 'live';
if (!['live', 'package'].includes(mode)) throw new Error(`Unsupported Web closure audit mode: ${mode}`);

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const syncManifestPath = path.join(mobileRoot, 'config/current-web-sync-source-manifest.json');
const runtimeManifestPath = path.join(mobileRoot, 'config/mobile-runtime-source-manifest.json');
const syncManifestBytes = await readFile(syncManifestPath);
const runtimeManifestBytes = await readFile(runtimeManifestPath);
const syncManifest = JSON.parse(syncManifestBytes);
const runtimeManifest = JSON.parse(runtimeManifestBytes);
const result = await auditCurrentWebSyncClosure({ sourceWebRoot, syncManifest, runtimeManifest, mode });
const evidence = {
  ...result,
  releaseId: syncManifest.release_id,
  assetVersion: syncManifest.asset_version,
  runtimeAssetVersion: runtimeManifest.runtime_asset_version,
  currentWebSyncManifestSha256: createHash('sha256').update(syncManifestBytes).digest('hex'),
  runtimeManifestSha256: createHash('sha256').update(runtimeManifestBytes).digest('hex'),
};
const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
const output = args.get('--output');
if (output) await writeFile(path.resolve(output), serialized);
process.stdout.write(serialized);
