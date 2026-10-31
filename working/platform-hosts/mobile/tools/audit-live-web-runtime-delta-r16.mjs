import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditCurrentWebSyncClosure } from './current-web-sync-closure.mjs';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(mobileRoot, '..');
const SHA256 = /^[a-f0-9]{64}$/;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function inventory(root) {
  const files = {};
  const visit = async (directory, relative = '') => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(full, name);
      else if (entry.isFile()) files[name.replaceAll('\\', '/')] = sha256(await readFile(full));
    }
  };
  await visit(path.resolve(root));
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

function inventoryDigest(files) {
  return sha256(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))
    .map(([name, hash]) => `${name}\0${hash}\n`).join(''));
}

function adaptationsDigest(syncManifest, runtimeManifest) {
  return sha256(JSON.stringify({
    sync: syncManifest.mobile_adaptations ?? [],
    runtime: runtimeManifest.mobile_adaptations ?? [],
    mobileOnlyExtras: syncManifest.mobile_only_extras ?? [],
  }));
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function captureR16BaselineSnapshot({
  sourceWebRoot,
  mobileWebRoot,
  syncManifest,
  runtimeManifest,
  syncManifestBytes,
  runtimeManifestBytes,
  l35bReceiptPath,
  l35bReceipt,
  l35bReceiptBytes,
}) {
  const sourceInventory = await inventory(sourceWebRoot);
  const mobileInventory = await inventory(mobileWebRoot);
  const closure = await auditCurrentWebSyncClosure({ sourceWebRoot, syncManifest, runtimeManifest, mode: 'live' });
  if (closure.status !== 'PASS_CURRENT_WEB_RUNTIME_CLOSURE') {
    throw new Error(`Cannot freeze R16 baseline from an invalid live closure: ${closure.errors?.join('; ') ?? closure.status}`);
  }
  if (closure.unqualifiedWiredRuntimePaths.length) throw new Error('Cannot freeze R16 baseline with an unqualified wired runtime path.');
  if (closure.bundleInternalSources.some((item) => item.packaged !== false)) throw new Error('Bundle-internal sources must remain excluded from packages.');
  const ultimatePolicy = sourceInventory['MultiplayerUltimateAdmission.js'];
  if (!ultimatePolicy) throw new Error('The live Ultimate admission policy is missing.');
  const ultimateText = await readFile(path.join(sourceWebRoot, 'MultiplayerUltimateAdmission.js'), 'utf8');
  if (!/ACCEPTED_ULTIMATE_RELEASES\s*=\s*Object\.freeze\(\[\s*\]\)/.test(ultimateText)) {
    throw new Error('Cannot freeze R16 baseline while Ultimate has an accepted product release.');
  }
  for (const item of [...(syncManifest.mobile_adaptations ?? []), ...(runtimeManifest.mobile_adaptations ?? [])]) {
    if (item.mobile_sha256 && mobileInventory[item.path] !== item.mobile_sha256) {
      throw new Error(`Cannot freeze R16 baseline with mobile adaptation drift: ${item.path}`);
    }
  }
  const runtimeFiles = Object.fromEntries(closure.runtimeReachableSourceFiles
    .map((name) => [name, sourceInventory[name]]).sort(([a], [b]) => a.localeCompare(b)));
  const l35ReceiptHash = sha256(l35bReceiptBytes);
  if (l35bReceipt.status !== 'PASS_SCOPED_R16_HARMONY_SESSION_PRESENCE_PACKAGES'
    || l35bReceipt.source?.postR16WebDelta !== 'NO_POST_R16_WEB_DELTA') throw new Error('L35-B receipt does not assert the accepted R16 Web boundary.');
  if (!SHA256.test(l35bReceipt.webBuildReceipt?.sha256 ?? '')
    || typeof l35bReceipt.webBuildReceipt?.path !== 'string' || !l35bReceipt.webBuildReceipt.path) {
    throw new Error('L35-B receipt does not contain a valid historical Web build receipt identity.');
  }
  return {
    schema: 'lifeline-mobile-live-web-runtime-delta-baseline-r16-v1',
    accepted_checkpoint: 'R16/L35-B',
    captured_at: '2026-10-24',
    sync_release_id: syncManifest.release_id,
    sync_asset_version: syncManifest.asset_version,
    runtime_asset_version: runtimeManifest.runtime_asset_version,
    bindings: {
      sync_manifest_sha256: sha256(syncManifestBytes),
      runtime_manifest_sha256: sha256(runtimeManifestBytes),
      mobile_adaptations_sha256: adaptationsDigest(syncManifest, runtimeManifest),
      l35b_receipt: { path: l35bReceiptPath, sha256: l35ReceiptHash },
      historical_web_build_receipt: {
        path: l35bReceipt.webBuildReceipt.path,
        sha256: l35bReceipt.webBuildReceipt.sha256,
      },
      web_runtime_closure_sha256: inventoryDigest(runtimeFiles),
    },
    source_snapshot: {
      file_count: Object.keys(sourceInventory).length,
      inventory_sha256: inventoryDigest(sourceInventory),
      files: sourceInventory,
    },
    mobile_snapshot: {
      file_count: Object.keys(mobileInventory).length,
      inventory_sha256: inventoryDigest(mobileInventory),
      files: mobileInventory,
    },
    runtime_closure: {
      entry: closure.runtimeEntry,
      file_count: Object.keys(runtimeFiles).length,
      files: runtimeFiles,
    },
    bundle_internal_sources: closure.bundleInternalSources,
    mobile_adaptation_count: (syncManifest.mobile_adaptations ?? []).length,
    source_mobile_difference_count: [...new Set([...Object.keys(sourceInventory), ...Object.keys(mobileInventory)])]
      .filter((name) => sourceInventory[name] !== mobileInventory[name]).length,
  };
}

function evidenceKind(name, rules) {
  if ((rules.temporary_prefixes ?? []).some((prefix) => name.startsWith(prefix))) return 'generatedTestScratch';
  if ((rules.test_prefixes ?? []).some((prefix) => name.startsWith(prefix))
    || /(?:^|\/)verify-[^/]+\.(?:mjs|js|py)$/.test(name)) return 'testsAndBenchmarks';
  if (/\.(?:md|mdx|tex|txt|rst|png|jpe?g|gif|webp|svg)$/i.test(name)) return 'documentationAndGuides';
  if (/(?:receipt|training|checkpoint|trajectory|evaluation|result|metrics?)/i.test(name)
    && /\.(?:json|jsonl|csv|txt|f32|pt|pth|bin)$/i.test(name)) return 'trainingAndResearchEvidence';
  return null;
}

function result(status, details = {}) {
  return { schema: 'lifeline-mobile-live-web-runtime-delta-report-r16-v1', status, writesPerformed: false, ...details };
}

export async function auditR16LiveWebRuntimeDelta({
  sourceWebRoot,
  mobileWebRoot,
  baseline,
  syncManifest,
  runtimeManifest,
  syncManifestBytes,
  runtimeManifestBytes,
  l35bReceiptPath,
  l35bReceiptBytes,
}) {
  const mismatch = [];
  if (baseline?.schema !== 'lifeline-mobile-live-web-runtime-delta-baseline-r16-v1') {
    return result('FAIL_CLOSED_INVALID_R16_BASELINE', { reason: 'Unsupported R16 baseline schema.' });
  }
  const binding = baseline.bindings ?? {};
  if (sha256(syncManifestBytes) !== binding.sync_manifest_sha256) mismatch.push('current-web-sync-manifest');
  if (sha256(runtimeManifestBytes) !== binding.runtime_manifest_sha256) mismatch.push('mobile-runtime-manifest');
  if (adaptationsDigest(syncManifest, runtimeManifest) !== binding.mobile_adaptations_sha256) mismatch.push('mobile-adaptations');
  if (l35bReceiptPath !== binding.l35b_receipt?.path || sha256(l35bReceiptBytes) !== binding.l35b_receipt?.sha256) mismatch.push('L35-B receipt');
  if (mismatch.length) return result('FAIL_CLOSED_BASELINE_BINDING_DRIFT', { changedBindings: mismatch });
  if (!SHA256.test(binding.web_runtime_closure_sha256 ?? '')) return result('FAIL_CLOSED_INVALID_R16_BASELINE', { reason: 'Missing baseline runtime closure digest.' });

  const l35Receipt = JSON.parse(l35bReceiptBytes);
  if (l35Receipt.status !== 'PASS_SCOPED_R16_HARMONY_SESSION_PRESENCE_PACKAGES'
    || l35Receipt.source?.postR16WebDelta !== 'NO_POST_R16_WEB_DELTA'
    || l35Receipt.webBuildReceipt?.path !== binding.historical_web_build_receipt?.path
    || l35Receipt.webBuildReceipt?.sha256 !== binding.historical_web_build_receipt?.sha256
    || !SHA256.test(binding.historical_web_build_receipt?.sha256 ?? '')) {
    return result('FAIL_CLOSED_L35B_RECEIPT_BINDING');
  }
  // Keep structural/import-policy checks current while allowing a source hash drift to be
  // reported as a runtime candidate below. The R16 manifest bytes themselves remain pinned.
  const closure = await auditCurrentWebSyncClosure({ sourceWebRoot, syncManifest, runtimeManifest,
    mode: 'live', validateSourceHashes: false });
  if (closure.status !== 'PASS_CURRENT_WEB_RUNTIME_CLOSURE') {
    return result('FAIL_CLOSED_CURRENT_WEB_CLOSURE', { closureStatus: closure.status, errors: closure.errors ?? [] });
  }
  if (closure.unqualifiedWiredRuntimePaths.length) {
    return result('FAIL_CLOSED_UNQUALIFIED_RUNTIME', { unqualifiedWiredRuntimePaths: closure.unqualifiedWiredRuntimePaths });
  }
  if (closure.bundleInternalSources.some((item) => item.packaged !== false)) {
    return result('FAIL_CLOSED_BUNDLE_INTERNAL_POLICY', { bundleInternalSources: closure.bundleInternalSources });
  }
  const ultimatePath = path.join(sourceWebRoot, 'MultiplayerUltimateAdmission.js');
  let ultimateText;
  try { ultimateText = await readFile(ultimatePath, 'utf8'); }
  catch { return result('FAIL_CLOSED_ULTIMATE_POLICY_MISSING'); }
  if (!/ACCEPTED_ULTIMATE_RELEASES\s*=\s*Object\.freeze\(\[\s*\]\)/.test(ultimateText)) {
    return result('FAIL_CLOSED_ULTIMATE_NOT_ADMITTED');
  }

  const sourceNow = await inventory(sourceWebRoot);
  const mobileNow = await inventory(mobileWebRoot);
  const mobileAdaptationDrift = [...(syncManifest.mobile_adaptations ?? []), ...(runtimeManifest.mobile_adaptations ?? [])]
    .filter((item) => item.mobile_sha256 && mobileNow[item.path] !== item.mobile_sha256)
    .map((item) => item.path);
  if (mobileAdaptationDrift.length) {
    return result('FAIL_CLOSED_MOBILE_ADAPTATION_DRIFT', { paths: [...new Set(mobileAdaptationDrift)].sort() });
  }
  const baselineSource = baseline.source_snapshot?.files ?? {};
  const baselineRuntime = baseline.runtime_closure?.files ?? {};
  if (inventoryDigest(baselineSource) !== baseline.source_snapshot?.inventory_sha256
    || inventoryDigest(baseline.mobile_snapshot?.files ?? {}) !== baseline.mobile_snapshot?.inventory_sha256
    || inventoryDigest(baselineRuntime) !== binding.web_runtime_closure_sha256) {
    return result('FAIL_CLOSED_BASELINE_SNAPSHOT_CORRUPT');
  }
  const runtimeNow = Object.fromEntries(closure.runtimeReachableSourceFiles
    .map((name) => [name, sourceNow[name]]).sort(([a], [b]) => a.localeCompare(b)));
  const changed = [...new Set([...Object.keys(baselineSource), ...Object.keys(sourceNow)])]
    .filter((name) => baselineSource[name] !== sourceNow[name]).sort((a, b) => a.localeCompare(b));
  const runtimeSet = new Set([...Object.keys(baselineRuntime), ...Object.keys(runtimeNow)]);
  const bundleInternals = new Map((baseline.bundle_internal_sources ?? []).map((item) => [item.path, item]));
  const categories = { runtimeCandidates: [], testsAndBenchmarks: [], documentationAndGuides: [], trainingAndResearchEvidence: [], bundleInternalSources: [], otherNonRuntime: [] };
  const unclassified = [];
  for (const name of changed) {
    const currentBundle = closure.bundleInternalSources.find((item) => item.path === name && item.packaged === false);
    const oldBundle = bundleInternals.get(name);
    if ((currentBundle || oldBundle) && !runtimeSet.has(name)) {
      categories.bundleInternalSources.push({ path: name, reason: 'Source is represented by a separately admitted bundle and is not a runtime module.' });
      continue;
    }
    if (runtimeSet.has(name)) {
      categories.runtimeCandidates.push({ path: name, baselineSha256: baselineSource[name] ?? null,
        currentSha256: sourceNow[name] ?? null, runtimeReachableNow: Boolean(runtimeNow[name]),
        reason: 'A live runtime module changed or entered/left the accepted runtime closure.' });
      continue;
    }
    const kind = evidenceKind(name, syncManifest.classification_rules ?? runtimeManifest.classification_rules ?? {});
    if (kind) categories[kind].push({ path: name, baselineSha256: baselineSource[name] ?? null, currentSha256: sourceNow[name] ?? null });
    else if (/\.(?:js|mjs|cjs|json|wasm|f32|bin)$/i.test(name)) unclassified.push(name);
    else categories.otherNonRuntime.push({ path: name, baselineSha256: baselineSource[name] ?? null, currentSha256: sourceNow[name] ?? null });
  }
  if (unclassified.length) return result('FAIL_CLOSED_UNCLASSIFIED_SOURCE_DELTA', { unclassified, categories });
  const status = categories.runtimeCandidates.length ? 'REVIEW_REQUIRED_LIVE_WEB_RUNTIME_DELTA' : 'NO_NEW_RUNTIME_DELTA';
  return result(status, {
    acceptedCheckpoint: baseline.accepted_checkpoint,
    syncReleaseId: syncManifest.release_id,
    runtimeAssetVersion: runtimeManifest.runtime_asset_version,
    sourceFileCount: Object.keys(sourceNow).length,
    sourceInventorySha256: inventoryDigest(sourceNow),
    runtimeReachableSourceCount: Object.keys(runtimeNow).length,
    runtimeClosureSha256: inventoryDigest(runtimeNow),
    runtimeCandidates: categories.runtimeCandidates,
    classifiedNonRuntimeChanges: {
      testsAndBenchmarks: categories.testsAndBenchmarks,
      documentationAndGuides: categories.documentationAndGuides,
      trainingAndResearchEvidence: categories.trainingAndResearchEvidence,
      bundleInternalSources: categories.bundleInternalSources,
      otherNonRuntime: categories.otherNonRuntime,
    },
    unqualifiedWiredRuntimePaths: closure.unqualifiedWiredRuntimePaths,
    unqualifiedUnwiredExperiments: closure.unqualifiedUnwiredExperiments,
  });
}

async function main() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 1) {
    const key = process.argv[index];
    if (!key.startsWith('--') || index + 1 >= process.argv.length) throw new Error('Usage: node tools/audit-live-web-runtime-delta-r16.mjs --source-web-root PATH [--mobile-web-root PATH]');
    args.set(key, process.argv[++index]);
  }
  const sourceWebRoot = args.get('--source-web-root') ?? process.env.LIFELINE_CURRENT_WEB_ROOT;
  if (!sourceWebRoot) throw new Error('A live Web source root is required.');
  const mobileWebRoot = args.get('--mobile-web-root') ?? path.resolve(repositoryRoot, 'web/web前端');
  const baseline = await readJson(path.join(mobileRoot, 'config/live-web-runtime-delta-baseline-r16.json'));
  const syncPath = path.join(mobileRoot, 'config/current-web-sync-source-manifest.json');
  const runtimePath = path.join(mobileRoot, 'config/mobile-runtime-source-manifest.json');
  const syncManifestBytes = await readFile(syncPath);
  const runtimeManifestBytes = await readFile(runtimePath);
  const syncManifest = JSON.parse(syncManifestBytes);
  const runtimeManifest = JSON.parse(runtimeManifestBytes);
  const l35bReceiptPath = 'docs/verification/mobile-harmony-session-presence-l35-b-20261024.json';
  const l35bReceiptBytes = await readFile(path.resolve(repositoryRoot, l35bReceiptPath));
  const report = await auditR16LiveWebRuntimeDelta({ sourceWebRoot, mobileWebRoot, baseline, syncManifest,
    runtimeManifest, syncManifestBytes, runtimeManifestBytes, l35bReceiptPath, l35bReceiptBytes,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== 'NO_NEW_RUNTIME_DELTA') process.exitCode = 2;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: 'FAIL_CLOSED_R16_LIVE_DELTA_AUDIT', error: String(error?.message ?? error), writesPerformed: false }, null, 2)}\n`);
    process.exitCode = 1;
  });
}
