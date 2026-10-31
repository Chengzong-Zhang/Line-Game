import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditCurrentWebSyncClosure } from './current-web-sync-closure.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (!key.startsWith('--') || index + 1 >= process.argv.length) {
    throw new Error('Usage: update-current-web-sync-manifests.mjs --runtime-version VERSION --sync-release-id ID --sync-asset-version VERSION');
  }
  args.set(key, process.argv[++index]);
}

const runtimeVersion = args.get('--runtime-version');
const releaseId = args.get('--sync-release-id');
const syncAssetVersion = args.get('--sync-asset-version');
const sourceWebRootArg = args.get('--source-web-root');
const environmentSourceWebRoot = process.env.LIFELINE_CURRENT_WEB_ROOT;
const hasExplicitSourceWebRoot = Boolean(sourceWebRootArg || environmentSourceWebRoot);
if (![runtimeVersion, releaseId, syncAssetVersion].every((value) => /^[A-Za-z0-9._-]+$/.test(value ?? ''))) {
  throw new Error('Runtime, release, and sync asset versions must use only letters, digits, dots, underscores, and hyphens.');
}

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(mobileRoot, '..');
const webRoot = path.join(repoRoot, 'web/web前端');
const sourceWebRoot = hasExplicitSourceWebRoot
  ? path.resolve(sourceWebRootArg ?? environmentSourceWebRoot)
  : null;
const runtimePath = path.join(mobileRoot, 'config/mobile-runtime-source-manifest.json');
const syncPath = path.join(mobileRoot, 'config/current-web-sync-source-manifest.json');
const adaptationBaselinePath = path.join(mobileRoot, 'config/mobile-adaptation-baseline.json');
const runtime = JSON.parse(await readFile(runtimePath, 'utf8'));
const sync = JSON.parse(await readFile(syncPath, 'utf8'));
const adaptationBaseline = JSON.parse(await readFile(adaptationBaselinePath, 'utf8'));
let liveSourceClosureAudit = null;
const hash = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
if (hasExplicitSourceWebRoot) {
  liveSourceClosureAudit = await auditCurrentWebSyncClosure({ sourceWebRoot, syncManifest: sync, runtimeManifest: runtime, validateSourceHashes: false });
}
const sourcePath = (name) => {
  if (path.isAbsolute(name) || name.split(/[\\/]/).includes('..')) throw new Error(`Unsafe source path: ${name}`);
  return path.join(webRoot, name);
};
const adaptationBaselineByPath = new Map((adaptationBaseline.files ?? []).map((entry) => [entry.path, entry]));
const adaptationByPath = new Map();
for (const adaptation of [...(runtime.mobile_adaptations ?? []), ...(sync.mobile_adaptations ?? [])]) {
  adaptationByPath.set(adaptation.path, { ...(adaptationByPath.get(adaptation.path) ?? {}), ...adaptation });
}
const adaptations = [];
for (const [name, adaptation] of [...adaptationByPath].sort(([left], [right]) => left.localeCompare(right))) {
  const sourceFile = sourcePath(name);
  const baselineEntry = adaptationBaselineByPath.get(name);
  if (hasExplicitSourceWebRoot) {
    const liveSourceHash = await hash(path.join(sourceWebRoot, name));
    if (!baselineEntry) {
      adaptation.source_sha256 = liveSourceHash;
      adaptation.source_snapshot = 'snapshot supplement; file absent from frozen source table';
    } else if (baselineEntry.source_sha256 !== liveSourceHash) {
      adaptation.source_sha256 = liveSourceHash;
      adaptation.source_snapshot = 'post-snapshot live source supplement; frozen adaptation baseline entry retained';
    } else {
      adaptation.source_sha256 = baselineEntry.source_sha256;
      if (adaptation.source_snapshot?.includes('post-snapshot live source supplement')) delete adaptation.source_snapshot;
    }
  } else if (baselineEntry && !adaptation.source_snapshot?.includes('post-snapshot live source supplement')) {
    adaptation.source_sha256 = baselineEntry.source_sha256;
  }
  adaptation.mobile_sha256 = await hash(sourceFile);
  if (name === 'ModelFreeAI.js') {
    adaptation.reason = 'Fails closed when crypto.subtle is unavailable and requires SHA-256 verification for model integrity.';
  } else if (name === 'OnlineApp.js') {
    adaptation.reason = 'Connects shared gameplay to native auth, durable session recovery, app lifecycle, native network recovery, replay sharing ownership, localized online AI labels, 4–6 player entry, and host bot retry.';
  }
  adaptations.push(adaptation);
}

runtime.runtime_asset_version = runtimeVersion;
sync.release_id = releaseId;
sync.asset_version = syncAssetVersion;
const bundleInternalByPath = new Map();
for (const item of [...(runtime.bundle_internal_sources ?? []), ...(sync.bundle_internal_sources ?? [])]) {
  bundleInternalByPath.set(item.path, { ...(bundleInternalByPath.get(item.path) ?? {}), ...item });
}
const bundleInternalSources = [];
for (const [name, item] of [...bundleInternalByPath].sort(([left], [right]) => left.localeCompare(right))) {
  if (hasExplicitSourceWebRoot) item.source_sha256 = await hash(path.join(sourceWebRoot, ...name.split('/')));
  bundleInternalSources.push(item);
}
const mobileOnlyExtras = new Set(sync.mobile_only_extras ?? []);
for (const name of Object.keys(sync.source_files)) {
  const sourceFile = hasExplicitSourceWebRoot && !mobileOnlyExtras.has(name)
    ? path.join(sourceWebRoot, ...name.split('/'))
    : sourcePath(name);
  sync.source_files[name] = await hash(sourceFile);
}
runtime.mobile_adaptations = adaptations;
sync.mobile_adaptations = adaptations;
runtime.bundle_internal_sources = bundleInternalSources;
sync.bundle_internal_sources = bundleInternalSources;
if (hasExplicitSourceWebRoot) {
  liveSourceClosureAudit = await auditCurrentWebSyncClosure({ sourceWebRoot, syncManifest: sync, runtimeManifest: runtime, validateSourceHashes: true });
}

await writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
await writeFile(syncPath, `${JSON.stringify(sync, null, 2)}\n`);
console.log(JSON.stringify({
  status: 'MANIFESTS_UPDATED',
  runtime_asset_version: runtime.runtime_asset_version,
  current_web_sync_release_id: sync.release_id,
  current_web_sync_asset_version: sync.asset_version,
  source_file_count: Object.keys(sync.source_files).length,
  live_source_closure_status: liveSourceClosureAudit?.status ?? 'NOT_RUN_NO_LIVE_SOURCE_ROOT',
  live_source_top_level_js_count: liveSourceClosureAudit?.topLevelJavaScriptCount ?? null,
  classified_unwired_experiment_count: liveSourceClosureAudit?.unqualifiedUnwiredExperiments.length ?? null,
  classified_wired_unqualified_runtime_count: liveSourceClosureAudit?.unqualifiedWiredRuntimePaths.length ?? null,
  bundle_internal_source_count: liveSourceClosureAudit?.bundleInternalSources.length ?? bundleInternalSources.length,
  online_app_sha256: sync.source_files['OnlineApp.js'],
}));
