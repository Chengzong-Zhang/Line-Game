import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditCurrentWebSyncClosure } from '../tools/current-web-sync-closure.mjs';

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'lifeline-web-closure-'));
const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(path.join(mobileRoot, 'package.json'), 'utf8'));
assert.match(packageJson.scripts['sync:web-manifests'], /--runtime-version 20261024-l34a1 --sync-release-id web-current-sync-20261024-r16 --sync-asset-version 20261024-current16$/,
  'manifest sync command stays pinned to the reviewed L32-A/R14 identifiers');
const sourceRoot = path.join(tempRoot, 'web');
await mkdir(sourceRoot);
const put = async (name, source) => writeFile(path.join(sourceRoot, name), source);
const digest = (source) => createHash('sha256').update(source).digest('hex');

try {
  await put('index.html', '<script type="module" src="./main.js?v=test"></script>');
  await put('main.js', 'import "./Core.js";');
  await put('Core.js', 'export const ready = true;');
  await put('data.json', '{"ready":true}');
  await put('Candidate.js', 'import "./Core.js";');
  await put('BundledInternal.js', 'export const internal = true;');
  const candidateSource = await readFile(path.join(sourceRoot, 'Candidate.js'));
  const exclusion = {
    path: 'Candidate.js', source_sha256: createHash('sha256').update(candidateSource).digest('hex'),
    classification: 'unwired_unqualified_experiment', runtime_reachable: false, packaged: false,
    direct_imports: ['Core.js'], reason: 'Fixture experiment remains isolated and unqualified.',
  };
  const requiredRuntime = ['main.js'];
  const bundleInternal = {
    path: 'BundledInternal.js', source_sha256: digest('export const internal = true;'),
    classification: 'bundle_internal_source', bundle: 'Core.js', packaged: false,
    reason: 'Fixture source is represented by the admitted bundle.',
  };
  const runtimeManifest = { files: ['main.js', 'Core.js', 'data.json'], required_runtime_closure: requiredRuntime,
    excluded_live_unwired_experiments: [exclusion], bundle_internal_sources: [bundleInternal] };
  const syncManifest = {
    source_files: {
      'main.js': digest('import "./Core.js";'),
      'Core.js': digest('export const ready = true;'),
      'data.json': digest('{"ready":true}'),
    },
    mobile_only_extras: [], required_runtime_closure: requiredRuntime, excluded_live_unwired_experiments: [exclusion],
    bundle_internal_sources: [bundleInternal],
  };

  const result = await auditCurrentWebSyncClosure({ sourceWebRoot: sourceRoot, syncManifest, runtimeManifest });
  assert.equal(result.status, 'PASS_CURRENT_WEB_RUNTIME_CLOSURE');
  assert.deepEqual(result.runtimeReachableSourceFiles, ['Core.js', 'main.js']);
  assert.deepEqual(result.unqualifiedUnwiredExperiments[0].dependencyClosure, ['Candidate.js', 'Core.js']);
  assert.equal(result.unqualifiedUnwiredExperiments[0].runtimeReachable, false);
  assert.equal(result.unqualifiedUnwiredExperiments[0].packaged, false);
  assert.deepEqual(result.bundleInternalSources, [{ path: 'BundledInternal.js',
    sourceSha256: bundleInternal.source_sha256, bundle: 'Core.js', packaged: false }]);

  const staleInternal = { ...bundleInternal, source_sha256: '0'.repeat(64) };
  await assert.rejects(auditCurrentWebSyncClosure({ sourceWebRoot: sourceRoot,
    syncManifest: { ...syncManifest, bundle_internal_sources: [staleInternal] },
    runtimeManifest: { ...runtimeManifest, bundle_internal_sources: [staleInternal] } }),
  /Bundle-internal source SHA-256 mismatch: BundledInternal\.js/);
  assert.equal((await auditCurrentWebSyncClosure({ sourceWebRoot: sourceRoot,
    syncManifest: { ...syncManifest, bundle_internal_sources: [staleInternal] },
    runtimeManifest: { ...runtimeManifest, bundle_internal_sources: [staleInternal] },
    validateSourceHashes: false })).status, 'PASS_CURRENT_WEB_RUNTIME_CLOSURE');

  await put('Wired.js', 'export const candidate = true;');
  await put('HardWorker.bundle.mjs', 'import "./Core.js"; export const data = new URL("./data.json", import.meta.url);');
  await put('Wired.js', 'export const worker = new Worker(new URL("./HardWorker.bundle.mjs?v=test", import.meta.url), { type: "module" });');
  await put('main.js', 'import "./Core.js"; import "./Wired.js";');
  const wiredSource = await readFile(path.join(sourceRoot, 'Wired.js'));
  const wiredExclusion = {
    path: 'Wired.js', source_sha256: createHash('sha256').update(wiredSource).digest('hex'),
    classification: 'wired_unqualified_runtime_path', runtime_reachable: true, packaged: false,
    direct_imports: ['HardWorker.bundle.mjs'], reason: 'Fixture runtime path is visible on Web but has no mobile product admission.',
  };
  const bundleSource = await readFile(path.join(sourceRoot, 'HardWorker.bundle.mjs'));
  const bundleExclusion = {
    path: 'HardWorker.bundle.mjs', source_sha256: createHash('sha256').update(bundleSource).digest('hex'),
    classification: 'wired_unqualified_runtime_path', runtime_reachable: true, packaged: false,
    direct_imports: ['Core.js', 'data.json'], reason: 'Fixture worker bundle is reached through a wired but unqualified worker factory.',
  };
  const wiredSyncManifest = {
    ...syncManifest,
    source_files: { ...syncManifest.source_files, 'main.js': digest('import "./Core.js"; import "./Wired.js";') },
    excluded_live_wired_unqualified_experiments: [bundleExclusion, wiredExclusion],
  };
  const wiredRuntimeManifest = { ...runtimeManifest, excluded_live_wired_unqualified_experiments: [bundleExclusion, wiredExclusion] };
  const wiredResult = await auditCurrentWebSyncClosure({
    sourceWebRoot: sourceRoot, syncManifest: wiredSyncManifest, runtimeManifest: wiredRuntimeManifest,
  });
  assert.deepEqual(wiredResult.unqualifiedWiredRuntimePaths.map((item) => item.path), ['HardWorker.bundle.mjs', 'Wired.js']);
  assert.deepEqual(wiredResult.unqualifiedWiredRuntimePaths[0].directImports, ['Core.js', 'data.json']);
  await put('main.js', 'import "./Core.js";');
  await rm(path.join(sourceRoot, 'Wired.js'));
  await rm(path.join(sourceRoot, 'HardWorker.bundle.mjs'));

  const packageRoot = path.join(tempRoot, 'package');
  await mkdir(packageRoot);
  await writeFile(path.join(packageRoot, 'index.html'), '<script src="./mobile-config.js"></script><script src="./mathjax-config.js"></script><script type="module" src="./mobile-entry.js"></script>');
  await mkdir(path.join(packageRoot, 'platform'));
  await writeFile(path.join(packageRoot, 'mobile-entry.js'), [
    'import "./platform/native-back-bootstrap.js";',
    'import "./platform/harmony-native-bridge.js";',
    'import "./platform/platform-selection.js";',
    'import "./platform/haptics-controller.js";',
    'const platform = "android";',
    'await import(platform === "harmony" ? "./platform/harmony-bridge.js" : "./platform/mobile-bridge.js");',
    'await import("./main.js?v=test");',
  ].join('\n'));
  for (const name of [
    'haptics-controller.js', 'harmony-bridge.js', 'harmony-native-bridge.js',
    'mobile-bridge.js', 'native-back-bootstrap.js', 'platform-selection.js',
    'runtime.js', 'session-authority.js', 'credential-authority.js', 'capability-contract.js',
    'replay-import-client.js', 'network-status.js', 'session-mirror.js', 'session-recovery.js',
    'session-envelope.js',
  ]) await writeFile(path.join(packageRoot, 'platform', name), 'export const ready = true;');
  await writeFile(path.join(packageRoot, 'platform/harmony-bridge.js'), 'import "./session-authority.js"; export const ready = true;');
  await writeFile(path.join(packageRoot, 'platform/mobile-bridge.js'), 'import "./capability-contract.js"; export const ready = true;');
  await writeFile(path.join(packageRoot, 'platform/session-authority.js'), 'import "./session-mirror.js"; export const ready = true;');
  await writeFile(path.join(packageRoot, 'platform/session-mirror.js'), 'import "./session-recovery.js"; export const ready = true;');
  await writeFile(path.join(packageRoot, 'platform/session-recovery.js'), 'import "./session-envelope.js"; export const ready = true;');
  await writeFile(path.join(packageRoot, 'platform/capability-contract.js'), 'import "./network-status.js"; export const ready = true;');
  await writeFile(path.join(packageRoot, 'platform/network-status.js'), 'import "./credential-authority.js"; export const ready = true;');
  await writeFile(path.join(packageRoot, 'platform/credential-authority.js'), 'import "./replay-import-client.js"; export const ready = true;');
  await writeFile(path.join(packageRoot, 'mobile-config.js'), 'globalThis.__MOBILE__ = true;');
  await writeFile(path.join(packageRoot, 'mathjax-config.js'), 'globalThis.MathJax = {};');
  await writeFile(path.join(packageRoot, 'main.js'), 'import "./Core.js";');
  await writeFile(path.join(packageRoot, 'Core.js'), 'export const ready = true;');
  await writeFile(path.join(packageRoot, 'data.json'), '{"ready":true}');
  const packageAudit = await auditCurrentWebSyncClosure({ sourceWebRoot: packageRoot, syncManifest, runtimeManifest, mode: 'package' });
  assert.equal(packageAudit.mode, 'package');
  assert.equal(packageAudit.packageAuditKind, 'built-package');
  assert.equal(packageAudit.documentRuntimeEntry, 'mobile-entry.js');
  assert.equal(packageAudit.runtimeEntry, 'main.js');
  assert.deepEqual(packageAudit.generatedPackageTopLevelJavaScript, ['mathjax-config.js', 'mobile-config.js', 'mobile-entry.js']);
  assert.deepEqual(packageAudit.generatedPackageRuntimeFiles, [
    'main.js', 'mobile-entry.js', 'platform/capability-contract.js', 'platform/credential-authority.js',
    'platform/haptics-controller.js', 'platform/harmony-bridge.js', 'platform/harmony-native-bridge.js',
    'platform/mobile-bridge.js', 'platform/native-back-bootstrap.js', 'platform/network-status.js',
    'platform/platform-selection.js', 'platform/replay-import-client.js', 'platform/session-authority.js',
    'platform/session-envelope.js', 'platform/session-mirror.js', 'platform/session-recovery.js',
  ]);
  assert.deepEqual(packageAudit.generatedPackagePlatformFiles, [
    'platform/capability-contract.js', 'platform/credential-authority.js', 'platform/haptics-controller.js',
    'platform/harmony-bridge.js', 'platform/harmony-native-bridge.js', 'platform/mobile-bridge.js',
    'platform/native-back-bootstrap.js', 'platform/network-status.js', 'platform/platform-selection.js',
    'platform/replay-import-client.js', 'platform/runtime.js', 'platform/session-authority.js',
    'platform/session-envelope.js', 'platform/session-mirror.js', 'platform/session-recovery.js',
  ]);
  assert.equal(packageAudit.topLevelJavaScriptCount, 2, 'package source count excludes generated mobile bootstrap scripts');
  assert.equal(packageAudit.packageJavaScriptCount, 20, 'package JavaScript count includes nested platform scripts');
  assert.deepEqual(packageAudit.unqualifiedUnwiredExperiments, [], 'package audit allows excluded experiments to be absent');
  assert.equal(packageAudit.bundleInternalSources.length, 1, 'package audit retains the hash-bound internal inventory');
  const mismatchedPackageManifest = {
    ...runtimeManifest,
    excluded_live_unwired_experiments: [{ ...exclusion, reason: 'A mismatched record must fail even when its file is absent.' }],
  };
  await assert.rejects(
    auditCurrentWebSyncClosure({ sourceWebRoot: packageRoot, syncManifest, runtimeManifest: mismatchedPackageManifest, mode: 'package' }),
    /Runtime and sync exclusion record differs: Candidate\.js/,
    'package audit validates both manifest records even when the excluded source is absent',
  );
  await writeFile(path.join(packageRoot, 'Candidate.js'), candidateSource);
  await assert.rejects(auditCurrentWebSyncClosure({ sourceWebRoot: packageRoot, syncManifest, runtimeManifest, mode: 'package' }),
    /Excluded live experiment was copied into the app package: Candidate\.js/);
  await rm(path.join(packageRoot, 'Candidate.js'));
  const mismatchedInternalManifest = {
    ...runtimeManifest,
    bundle_internal_sources: [{ ...bundleInternal, reason: 'Mismatched fixture record.' }],
  };
  await assert.rejects(
    auditCurrentWebSyncClosure({ sourceWebRoot: packageRoot, syncManifest, runtimeManifest: mismatchedInternalManifest, mode: 'package' }),
    /Runtime and sync bundle-internal record differs: BundledInternal\.js/,
  );
  await writeFile(path.join(packageRoot, 'BundledInternal.js'), 'export const internal = true;');
  await assert.rejects(
    auditCurrentWebSyncClosure({ sourceWebRoot: packageRoot, syncManifest, runtimeManifest, mode: 'package' }),
    /Bundle-internal source was copied into the app package: BundledInternal\.js/,
  );
  await rm(path.join(packageRoot, 'BundledInternal.js'));
  await writeFile(path.join(packageRoot, 'platform/Unexpected.js'), 'export const unexpected = true;');
  await assert.rejects(
    auditCurrentWebSyncClosure({ sourceWebRoot: packageRoot, syncManifest, runtimeManifest, mode: 'package' }),
    /Unclassified nested package JavaScript: platform\/Unexpected\.js/,
    'unexpected nested package JavaScript must fail closure classification',
  );
  await rm(path.join(packageRoot, 'platform/Unexpected.js'));
  const packageWithMobileExtra = {
    ...syncManifest,
    source_files: { ...syncManifest.source_files, 'OnlineActionSync.js': digest('export const sync = true;') },
    mobile_only_extras: ['OnlineActionSync.js'],
  };
  await assert.rejects(auditCurrentWebSyncClosure({ sourceWebRoot: packageRoot, syncManifest: packageWithMobileExtra, runtimeManifest, mode: 'package' }),
    /Packaged source is missing from app package: OnlineActionSync\.js/);

  const staleSyncManifest = { ...syncManifest, source_files: { ...syncManifest.source_files, 'Core.js': '0'.repeat(64) } };
  await assert.rejects(auditCurrentWebSyncClosure({ sourceWebRoot: sourceRoot, syncManifest: staleSyncManifest, runtimeManifest }),
    /Live Web source SHA-256 mismatch: Core\.js/);
  assert.equal((await auditCurrentWebSyncClosure({ sourceWebRoot: sourceRoot, syncManifest: staleSyncManifest, runtimeManifest, validateSourceHashes: false })).status,
    'PASS_CURRENT_WEB_RUNTIME_CLOSURE', 'preflight can discover closure before refreshing direct-source hashes');
  staleSyncManifest.source_files['Core.js'] = digest('export const ready = true;');
  assert.equal((await auditCurrentWebSyncClosure({ sourceWebRoot: sourceRoot, syncManifest: staleSyncManifest, runtimeManifest })).status,
    'PASS_CURRENT_WEB_RUNTIME_CLOSURE', 'refreshed direct-source hash passes strict audit');

  await put('Unclassified.js', 'export const unexpected = true;');
  await assert.rejects(auditCurrentWebSyncClosure({ sourceWebRoot: sourceRoot, syncManifest, runtimeManifest }),
    /Unclassified top-level Web JavaScript: Unclassified\.js/);
  await rm(path.join(sourceRoot, 'Unclassified.js'));

  await put('main.js', 'import "./Candidate.js"; import "./Core.js";');
  syncManifest.source_files['main.js'] = digest(await readFile(path.join(sourceRoot, 'main.js')));
  await assert.rejects(auditCurrentWebSyncClosure({ sourceWebRoot: sourceRoot, syncManifest, runtimeManifest }),
    /Un-wired experiment was reached from the Web module entry: Candidate\.js/);

  await put('main.js', 'const worker = new Worker(new URL("./nested/New.js", import.meta.url), { type: "module" });');
  syncManifest.source_files['main.js'] = digest(await readFile(path.join(sourceRoot, 'main.js')));
  await mkdir(path.join(sourceRoot, 'nested'));
  await put('nested/New.js', 'export const loaded = true;');
  await assert.rejects(auditCurrentWebSyncClosure({ sourceWebRoot: sourceRoot, syncManifest, runtimeManifest }),
    /Runtime-reachable Web modules are missing from the app package manifests: nested\/New\.js/);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

console.log('Current Web closure audit detects unknown modules, verifies un-wired experiment closure, and rejects runtime reachability.');
