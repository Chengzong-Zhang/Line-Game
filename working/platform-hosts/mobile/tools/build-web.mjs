import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateThirdPartyNotices } from './generate-third-party-notices.mjs';
import { createMobileCsp, loadRuntimeConfig } from './runtime-config.mjs';
import { auditCurrentWebSyncClosure } from './current-web-sync-closure.mjs';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(mobileRoot, '..');
const webRoot = path.join(repoRoot, 'web/web前端');
const dist = path.join(mobileRoot, 'dist');
const manifest = JSON.parse(await readFile(path.join(mobileRoot, 'config/aligned-release-baseline.json'), 'utf8'));
const textEquivalence = JSON.parse(await readFile(path.join(mobileRoot, 'config/text-line-ending-equivalence.json'), 'utf8'));
const runtimeSelection = await loadRuntimeConfig({ mobileRoot, args: process.argv.slice(2) });
const runtimeConfig = runtimeSelection.config;
const runtimeSourceManifest = JSON.parse(await readFile(path.join(mobileRoot, 'config/aligned-runtime-manifest.json'), 'utf8'));
const currentWebSyncManifestPath = path.join(mobileRoot, 'config/aligned-sync-manifest.json');
const currentWebSyncManifest = JSON.parse(await readFile(currentWebSyncManifestPath, 'utf8'));
const runtimeSourceFiles = runtimeSourceManifest.files;
const assetVersion = runtimeSourceManifest.runtime_asset_version;
if (runtimeSourceManifest.schema !== 'lifeline-mobile-runtime-source-manifest-v1'
  || !/^[A-Za-z0-9._-]+$/.test(assetVersion ?? '')
  || !Array.isArray(runtimeSourceFiles)
  || new Set(runtimeSourceFiles).size !== runtimeSourceFiles.length
  || runtimeSourceFiles.some((name) => path.isAbsolute(name) || name.split(/[\\/]/).includes('..')
    || !/^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._ -]+\.(?:js|mjs|json|md|f32)$/.test(name))) {
  throw new Error('Mobile runtime source manifest must contain unique safe relative JavaScript, module JavaScript, JSON, Markdown, or model paths.');
}

const hash = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
const hashNormalizedText = async (file) => createHash('sha256').update((await readFile(file, 'utf8')).replace(/\r\n?/g, '\n'), 'utf8').digest('hex');
const currentWebClosureAudit = await auditCurrentWebSyncClosure({
  sourceWebRoot: webRoot, syncManifest: currentWebSyncManifest, runtimeManifest: runtimeSourceManifest, mode: 'package',
});
const files = Object.keys(manifest.files ?? {}).sort();
if (files.length !== 74) throw new Error(`Expected 74 frozen web files, got ${files.length}`);
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await mkdir(path.join(dist, 'fonts'), { recursive: true });
for (const relative of files) {
  const source = path.join(webRoot, relative);
  const target = path.join(dist, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target);
}
for (const name of runtimeSourceFiles) {
  const source = path.join(webRoot, name);
  const target = path.join(dist, name);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target);
}

const sourceIndex = await readFile(path.join(dist, 'index.html'), 'utf8');
const inlineScripts = [...sourceIndex.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
const mathJaxConfigs = inlineScripts.filter(([, attributes, body]) => !/\bsrc\s*=/.test(attributes) && /\bwindow\.MathJax\s*=/.test(body));
if (mathJaxConfigs.length !== 1) throw new Error(`Expected exactly one inline MathJax configuration, found ${mathJaxConfigs.length}.`);
const mathJaxConfig = mathJaxConfigs[0][0];
const mathJaxConfigSource = mathJaxConfigs[0][2].trim();
const mathJaxCdnScript = '<script defer src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js"></script>';
if (sourceIndex.split(mathJaxCdnScript).length !== 2) throw new Error('Expected exactly one MathJax CDN script to replace.');
const csp = createMobileCsp(runtimeConfig, runtimeSelection.environment);
const mobileIndex = sourceIndex
  .replace(mathJaxConfig, '<script src="./mathjax-config.js"></script>')
  .replace(mathJaxCdnScript, '<script defer src="./vendor/mathjax/es5/tex-chtml.js"></script>')
  .replace(/\.\/styles\.css\?v=[^"]+/, `./styles.css?v=${assetVersion}`)
  .replace(/<script type="module" src="\.\/main\.js\?v=[^"]+"><\/script>/,
    '<script src="./vendor/vue.global.prod.js"></script>\n    <script src="./mobile-config.js"></script>\n    <script type="module" src="./mobile-entry.js"></script>');
const firstHeadResource = mobileIndex.search(/<(?:script|link)\b/i);
const headClose = mobileIndex.indexOf('</head>');
if (firstHeadResource < 0 || headClose < 0 || firstHeadResource > headClose
  || mobileIndex.indexOf('</head>', headClose + '</head>'.length) !== -1) {
  throw new Error('Expected one document head with a link or script resource before its closing tag.');
}
const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
const mobileIndexWithCsp = `${mobileIndex.slice(0, firstHeadResource)}${cspMeta}\n    ${mobileIndex.slice(firstHeadResource)}`;
if (mobileIndex === sourceIndex || mobileIndexWithCsp === mobileIndex || /https:\/\/cdn\.jsdelivr\.net\/npm\/mathjax/.test(mobileIndexWithCsp)) {
  throw new Error('Could not replace the MathJax CDN reference in the mobile document.');
}
await writeFile(path.join(dist, 'mathjax-config.js'), `${mathJaxConfigSource}\n`);
await writeFile(path.join(dist, 'index.html'), mobileIndexWithCsp);
await writeFile(path.join(dist, 'mobile-entry.js'), [
  'if (new URLSearchParams(globalThis.location?.search ?? "").getAll("tutorial").length === 1 && new URLSearchParams(globalThis.location?.search ?? "").get("tutorial") === "1") {',
  '  const tutorialPolicy = document.createElement("meta");',
  '  tutorialPolicy.httpEquiv = "Content-Security-Policy";',
  '  tutorialPolicy.content = "connect-src \'none\'";',
  '  document.head.appendChild(tutorialPolicy);',
  '}',
  'function showStartupFailure() {',
  '  const body = globalThis.document?.body;',
  '  if (!body) return;',
  '  const panel = document.createElement("main");',
  '  panel.setAttribute("role", "alert");',
  '  panel.setAttribute("aria-live", "assertive");',
  '  panel.style.cssText = "box-sizing:border-box;min-height:100vh;padding:24px;display:grid;align-content:center;justify-items:center;gap:16px;background:#101713;color:#f5f1e7;font:16px/1.6 system-ui,sans-serif;text-align:center";',
  '  const title = document.createElement("h1");',
  '  title.textContent = "启动未完成";',
  '  title.style.cssText = "margin:0;font-size:24px";',
  '  const message = document.createElement("p");',
  '  message.textContent = "保存状态待确认。现有存档可能尚未完成恢复，系统不会自动清除或重置。请检查设备存储后重试。";',
  '  message.style.cssText = "max-width:32em;margin:0";',
  '  const retry = document.createElement("button");',
  '  retry.type = "button";',
  '  retry.textContent = "重试启动";',
  '  retry.style.cssText = "min-height:48px;padding:0 24px;border:0;border-radius:999px;background:#d8bd78;color:#171a15;font:inherit;font-weight:700";',
  '  let retrying = false;',
  '  retry.addEventListener("click", () => {',
  '    if (retrying) return;',
  '    retrying = true;',
  '    retry.textContent = "正在重新启动…";',
  '    retry.disabled = true;',
  '    try { globalThis.location.reload(); }',
  '    catch (_error) { retrying = false; retry.disabled = false; retry.textContent = "重试启动"; }',
  '  });',
  '  panel.append(title, message, retry);',
  '  if (typeof body.replaceChildren === "function") body.replaceChildren(panel);',
  '  else { while (body.firstChild) body.removeChild(body.firstChild); body.appendChild(panel); }',
  '}',
  'async function startApplication() {',
  '  const challenge = new Uint32Array(8); globalThis.crypto.getRandomValues(challenge);',
  '  globalThis.__LIFELINE_DOCUMENT_CHALLENGE__ = [...challenge].map((word) => word.toString(16).padStart(8, "0")).join("");',
  '  await import("./platform/native-back-bootstrap.js");',
  '  const { installHarmonyNativeBridge } = await import("./platform/harmony-native-bridge.js");',
  '  const { selectMobilePlatform } = await import("./platform/platform-selection.js");',
  '  const { createMoveHapticsController } = await import("./platform/haptics-controller.js");',
  '  globalThis.__LIFELINE_CREATE_MOVE_HAPTICS_CONTROLLER__ = createMoveHapticsController;',
  '  installHarmonyNativeBridge();',
  '  const platform = selectMobilePlatform();',
  '  const module = await import(platform === "harmony" ? "./platform/harmony-bridge.js" : "./platform/mobile-bridge.js");',
  '  await module.initializePlatform();',
  `  await import("./main.js?v=${assetVersion}");`,
  '}',
  'try {',
  '  await startApplication();',
  '} catch (_error) {',
  '  showStartupFailure();',
  '}',
].join('\n'));
await cp(path.join(webRoot, 'platform/runtime.js'), path.join(dist, 'platform/runtime.js'));
await cp(path.join(mobileRoot, 'src/harmony-native-bridge.js'), path.join(dist, 'platform/harmony-native-bridge.js'));
await cp(path.join(mobileRoot, 'src/haptics-controller.js'), path.join(dist, 'platform/haptics-controller.js'));
await cp(path.join(mobileRoot, 'src/platform-selection.js'), path.join(dist, 'platform/platform-selection.js'));
for (const name of ['harmony-bridge.js', 'mobile-bridge.js', 'session-authority.js', 'credential-authority.js', 'capability-contract.js', 'replay-import-client.js']) {
  const source = (await readFile(path.join(mobileRoot, 'src', name), 'utf8'))
    .replace(/\.\.\/\.\.\/web\/web前端\/LocalGameSession\.js\?v=[A-Za-z0-9._-]+/g, `../LocalGameSession.js?v=${assetVersion}`);
  await writeFile(path.join(dist, 'platform', name), source);
}
await cp(path.join(mobileRoot, 'src/network-status.js'), path.join(dist, 'platform/network-status.js'));
for (const name of ['session-mirror.js', 'session-recovery.js', 'session-envelope.js']) {
  await cp(path.join(mobileRoot, 'src', name), path.join(dist, 'platform', name));
}

const stylesFile = path.join(dist, 'styles.css');
let styles = await readFile(stylesFile, 'utf8');
styles = styles.replace(/^@import url\("https:\/\/fonts\.googleapis\.com\/css2\?family=Cormorant\+Garamond[^\n]*\n/m, '');
const fontImports = [400, 500, 600, 700].map((weight) => `@import url("./fonts/manrope-${weight}.css");`)
  .concat([500, 600, 700].map((weight) => `@import url("./fonts/cormorant-${weight}.css");`)).join('\n');
await writeFile(stylesFile, `${fontImports}\n${styles}`);

const copyFontFace = async (packageName, cssName, targetName) => {
  const packageRoot = path.join(mobileRoot, 'node_modules', '@fontsource', packageName);
  const css = await readFile(path.join(packageRoot, cssName), 'utf8');
  const refs = [...css.matchAll(/url\((?:"|')?\.\/files\/([^)'"\s]+)(?:"|')?\)/g)].map((match) => match[1]);
  if (!refs.length) throw new Error(`No local font files referenced by ${packageName}/${cssName}`);
  await writeFile(path.join(dist, 'fonts', targetName), css);
  for (const name of refs) {
    const target = path.join(dist, 'fonts/files', name);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(packageRoot, 'files', name), target);
  }
};
for (const weight of [400, 500, 600, 700]) await copyFontFace('manrope', `latin-${weight}.css`, `manrope-${weight}.css`);
for (const weight of [500, 600, 700]) await copyFontFace('cormorant-garamond', `latin-${weight}.css`, `cormorant-${weight}.css`);

await mkdir(path.join(dist, 'vendor'), { recursive: true });
await cp(path.join(mobileRoot, 'node_modules/vue/dist/vue.global.prod.js'), path.join(dist, 'vendor/vue.global.prod.js'));
await cp(path.join(mobileRoot, 'node_modules/mathjax/es5'), path.join(dist, 'vendor/mathjax/es5'), { recursive: true });
await cp(path.join(mobileRoot, 'legal'), path.join(dist, 'legal'), { recursive: true });
await generateThirdPartyNotices({
  legalRoot: path.join(mobileRoot, 'legal'),
  outputPath: path.join(dist, 'legal/THIRD_PARTY_NOTICES.html'),
});
await writeFile(path.join(dist, 'mobile-config.js'), `globalThis.__LIFELINE_MOBILE_APP__ = true;\nglobalThis.__LIFELINE_RUNTIME_CONFIG__ = Object.freeze(${JSON.stringify(runtimeConfig)});\n`);

const binaryAssets = [...new Set([...files, ...runtimeSourceFiles])].filter((name) => /\.f32$/i.test(name));
// The frozen worker has its own asset tree. Verify its model bytes against
// the independently retained release baseline or the model's own manifest.
const historicalModelBaseline = JSON.parse(await readFile(path.join(mobileRoot, 'config/release-baseline-manifest.json'), 'utf8'));
const runtimeModelManifestPath = 'assets/research-ai/multiplayer-v1/manifest.json';
const runtimeModelManifest = runtimeSourceFiles.includes(runtimeModelManifestPath)
  ? JSON.parse(await readFile(path.join(dist, runtimeModelManifestPath), 'utf8'))
  : null;
const runtimeModelAsset = runtimeModelManifest?.models?.find((item) => item.asset === 'multiplayer-ultimate-v1.f32');
const assetHashes = [];
for (const relative of binaryAssets) {
  const actual = await hash(path.join(dist, relative));
  const canonical = relative.replace(/^frozen-workers\/[^/]+\//, '');
  const expected = historicalModelBaseline.files[canonical]
    ?? (canonical === `assets/research-ai/multiplayer-v1/${runtimeModelAsset?.asset}` ? runtimeModelAsset.asset_sha256 : null);
  if (!expected) throw new Error(`No frozen or model-manifest hash declared for binary asset: ${relative}`);
  if (actual !== expected) throw new Error(`Frozen model asset hash mismatch: ${relative}`);
  assetHashes.push({ path: relative, sha256: actual });
}
const sourceFiles = [...new Set([...files, ...runtimeSourceFiles, 'platform/runtime.js'])].map((name) => ({
  path: `web/web前端/${name}`,
  sha256: null,
}));
for (const entry of sourceFiles) {
  const source = path.join(repoRoot, entry.path);
  entry.sha256 = await hash(source);
  if (textEquivalence.files[entry.path]) entry.normalized_text_sha256 = await hashNormalizedText(source);
}
for (const relative of [
  'mobile/package.json', 'mobile/package-lock.json', 'mobile/capacitor.config.ts',
  'mobile/config/release-baseline-manifest.json', 'mobile/config/runtime.release.json', 'mobile/config/text-line-ending-equivalence.json',
  'mobile/config/mobile-runtime-source-manifest.json',
  'mobile/config/current-web-sync-source-manifest.json',
  'mobile/config/mobile-adaptation-baseline.json',
  'mobile/tools/build-web.mjs', 'mobile/tools/update-current-web-sync-manifests.mjs', 'mobile/tools/snapshot-release-baseline.mjs',
  'mobile/tools/current-web-sync-closure.mjs', 'mobile/tools/audit-current-web-sync-closure.mjs',
  'mobile/tools/runtime-config.mjs', 'mobile/tools/build-mobile.mjs', 'mobile/tests/verify-runtime-config.mjs', 'mobile/config/README.md',
  'mobile/tools/sync-harmony-web.mjs', 'mobile/tools/generate-third-party-notices.mjs',
  'mobile/tools/generate-harmony-placeholder-assets.mjs',
  'mobile/legal/THIRD_PARTY_NOTICES.md', 'mobile/legal/license-manifest.json',
  'mobile/src/mobile-bridge.js', 'mobile/src/network-status.js', 'mobile/src/session-mirror.js', 'mobile/src/capability-contract.js', 'mobile/src/credential-authority.js', 'mobile/src/replay-import-client.js', 'mobile/vite.config.mjs',
  'mobile/src/haptics-controller.js',
  'mobile/src/native-back-bootstrap.js', 'mobile/vite-back-bootstrap.config.mjs',
  'mobile/tools/patch-capacitor-core.mjs',
  'mobile/src/session-recovery.js', 'mobile/src/session-envelope.js', 'mobile/src/session-authority.js', 'mobile/src/harmony-bridge.js',
  'mobile/src/harmony-native-bridge.js',
  'mobile/src/platform-selection.js',
  'mobile/src/native-session-storage.js',
  'mobile/tests/verify-mobile-build.mjs', 'mobile/tests/verify-native-platform-flush.mjs',
  'mobile/tests/verify-current-web-sync-closure.mjs', 'mobile/tests/verify-local-ai-worker-route.mjs',
  'mobile/tools/audit-live-web-runtime-delta-r16.mjs',
  'mobile/tests/verify-live-web-runtime-delta-r16.mjs',
  'mobile/config/live-web-runtime-delta-baseline-r16.json',
  'docs/verification/mobile-harmony-session-presence-l35-b-20261024.json',
  'mobile/tests/verify-l27f-ultimate-admission.mjs',
  'mobile/tools/verify-l27f-package-policy.py',
  'mobile/tools/verify-l28a-package-policy.py',
  'mobile/tools/verify-l29f-package-policy.py',
  'mobile/tools/verify-l30a-package-policy.py',
  'mobile/tools/verify-l32a-package-policy.py',
  'mobile/tools/verify-l28b-package-policy.py',
  'mobile/tests/verify-multiplayer-native-geometry.mjs',
  'mobile/tests/verify-tutorial-host.mjs',
  'mobile/tests/verify-harmony-tutorial-native.mjs',
  'mobile/tests/verify-toolchain-dependencies.mjs',
  'mobile/tests/verify-network-status.mjs',
  'mobile/tests/verify-harmony-network-monitor.mjs',
  'mobile/tests/verify-capability-contract.mjs',
  'mobile/tests/verify-replay-import-client.mjs',
  'mobile/tests/verify-android-capabilities.py',
  'mobile/tests/verify-android-credential-store.py',
  'mobile/tests/verify-android-network-status.py',
  'mobile/tests/verify-android-haptics.py',
  'mobile/tests/verify-android-session-store.py',
  'mobile/tests/verify-android-main-page-recovery.py',
  'mobile/tests/verify-android-replay-import.py',
  'mobile/tests/verify-android-replay-share.py',
  'mobile/tests/verify-android-tutorial-host.py',
  'mobile/tests/verify-android-app-host.py',
  'mobile/tools/verify-android-host.mjs',
  'mobile/tools/verify-android-replay-import.mjs',
  'mobile/tests/verify-credential-authority.mjs',
  'mobile/tests/verify-mobile-credential-app.mjs',
  'mobile/tests/verify-harmony-credential-store.mjs',
  'mobile/tools/verify-l31a-storage-package-policy.py',
  'mobile/config/release-identity-candidate.json',
  'mobile/tools/release-identity.mjs',
  'mobile/tools/release-identity-data.mjs',
  'mobile/tools/verify-l26-android-apk.py',
  'mobile/tools/verify-l26-harmony-hap.py',
  'mobile/android/app/build.gradle',
  'mobile/android/app/src/main/java/cn/lifelinegame/mobile/LifelineStoragePlugin.java',
  'mobile/android/app/src/main/java/cn/lifelinegame/mobile/MainRendererRecoveryCoordinator.java',
  'mobile/android/app/src/main/java/cn/lifelinegame/mobile/MainPageRecoveryWebViewClient.java',
  'mobile/android/app/src/test/java/cn/lifelinegame/mobile/MainRendererRecoveryCoordinatorTest.java',
  'mobile/tests/verify-move-haptics.mjs',
  'mobile/tests/verify-harmony-native-bridge.mjs',
  'mobile/tests/verify-harmony-host-lifecycle.mjs',
  'mobile/tests/verify-harmony-host-recovery.mjs',
  'mobile/tests/verify-harmony-external-navigation.mjs',
  'mobile/tests/verify-mobile-back-integration.mjs',
  'mobile/tests/verify-mobile-entry-routing.mjs',
  'mobile/tests/verify-session-integration.mjs',
  'docs/verification/multiplayer-20261022/hard-dual-rules-browser-r6.json',
  'web/web前端/tests/verify-online-bot-ui.mjs',
  'web/web前端/tests/verify-local-runtime-loaders.mjs',
  'web/web前端/tests/verify-territory-v3.mjs',
  'web/web前端/tests/verify-guide-content.mjs',
  'web/web前端/tests/verify-territory-pool.mjs',
  'web/web前端/tests/verify-replay-codec.mjs',
  'web/web前端/tests/fixtures/minimax-defense.json',
  'web/web前端/tests/verify-ai-control-flow.mjs',
  'web/web前端/tests/verify-ai-search-15.mjs',
  'web/web前端/tests/verify-minimax-defense.mjs',
  'web/web前端/tests/verify-minimax-defense-invariants.mjs',
  'mobile/harmony/README.md', 'mobile/harmony/AppScope/app.json5', 'mobile/harmony/build-profile.json5',
  'mobile/harmony/hvigorfile.ts', 'mobile/harmony/oh-package.json5',
  'mobile/harmony/entry/build-profile.json5', 'mobile/harmony/entry/oh-package.json5',
  'mobile/harmony/entry/hvigorfile.ts', 'mobile/harmony/hvigor/hvigor-config.json5',
  'mobile/harmony/entry/src/main/module.json5', 'mobile/harmony/entry/src/main/resources/base/profile/main_pages.json',
  'mobile/harmony/AppScope/resources/base/element/string.json',
  'mobile/harmony/AppScope/resources/base/media/app_icon.png',
  'mobile/harmony/entry/src/main/resources/base/element/string.json',
  'mobile/harmony/entry/src/main/resources/base/element/color.json',
  'mobile/harmony/entry/src/main/resources/base/media/app_icon.png',
  'mobile/harmony/entry/src/main/resources/base/media/startIcon.png',
  'mobile/harmony/entry/src/main/ets/entryability/EntryAbility.ets',
  'mobile/harmony/entry/src/main/ets/bridge/LifelineNativeProxy.ets',
  'mobile/harmony/entry/src/main/ets/bridge/NetworkStatusMonitor.ets',
  'mobile/harmony/entry/src/main/ets/bridge/WebControllerRegistry.ets',
  'mobile/android/app/src/main/java/cn/lifelinegame/mobile/LifelineHapticsPlugin.java',
  'mobile/android/app/src/main/java/cn/lifelinegame/mobile/LifelineReplayImportPlugin.java',
  'mobile/android/app/src/main/java/cn/lifelinegame/mobile/LifelineTutorialHostPlugin.java',
  'mobile/harmony/entry/src/main/ets/bridge/HostContentRecovery.ets',
  'mobile/harmony/entry/src/main/ets/bridge/MainWebRecoveryPolicy.ets',
  'mobile/harmony/entry/src/main/ets/pages/Index.ets',
  'mobile/harmony/entry/src/main/ets/pages/HostRecovery.ets',
  'mobile/android/app/src/androidTest/java/cn/lifelinegame/mobile/LifelineApplicationIdentityTest.java',
  'mobile/android/app/src/main/AndroidManifest.xml',
  'mobile/android/app/src/main/java/cn/lifelinegame/mobile/LifelineCapabilitiesPlugin.java',
  'mobile/android/app/src/main/java/cn/lifelinegame/mobile/LifelineNetworkPlugin.java',
  'mobile/android/app/src/main/java/cn/lifelinegame/mobile/MainActivity.java',
]) sourceFiles.push({ path: relative, sha256: await hash(path.join(repoRoot, relative)) });
if (!sourceFiles.some(({ path: name }) => name === `mobile/${runtimeSelection.configRelativePath}`)) sourceFiles.push({ path: `mobile/${runtimeSelection.configRelativePath}`, sha256: runtimeSelection.rawSha256 });
const licenseManifest = JSON.parse(await readFile(path.join(mobileRoot, 'legal/license-manifest.json'), 'utf8'));
for (const license of licenseManifest.packages) {
  const relative = `mobile/legal/${license.path}`;
  sourceFiles.push({ path: relative, sha256: await hash(path.join(repoRoot, relative)) });
}
sourceFiles.push({ path: 'mobile/tools/finalize-build-receipt.mjs', sha256: await hash(path.join(repoRoot, 'mobile/tools/finalize-build-receipt.mjs')) });
const receipt = {
  schema: 'lifeline-mobile-web-build-v1',
  // This projection has not passed the native session, lifecycle and device
  // admission gates. Never promote the diagnostic build receipt to a release.
  status: 'DIAGNOSTIC-UNVERIFIED',
  release_id: manifest.release_id,
  asset_version: manifest.asset_version,
  runtime_asset_version: assetVersion,
  current_web_sync_release_id: currentWebSyncManifest.release_id,
  current_web_sync_source_manifest_sha256: await hash(currentWebSyncManifestPath),
  current_web_runtime_closure: {
    status: currentWebClosureAudit.status,
    mode: currentWebClosureAudit.mode,
    runtime_entry: currentWebClosureAudit.runtimeEntry,
    source_files: currentWebClosureAudit.runtimeReachableSourceFiles,
  },
  excluded_predecessor_files: runtimeSourceManifest.excluded_predecessor_files ?? [],
  source_declared_commit: manifest.commit,
  frozen_file_count: files.length,
  source_files: sourceFiles,
  model_asset_count: binaryAssets.length,
  model_assets: assetHashes,
  runtime_config_sha256: runtimeSelection.canonicalSha256,
  runtime_environment: runtimeSelection.environment,
  runtime_config_path: `mobile/${runtimeSelection.configRelativePath}`,
  runtime_config_file_sha256: runtimeSelection.rawSha256,
  csp_sha256: createHash('sha256').update(csp).digest('hex'),
  mathjax_config_sha256: await hash(path.join(dist, 'mathjax-config.js')),
  vue_runtime_compiler_csp_exception: 'unsafe-eval required by bundled Vue runtime compiler for current component template strings',
  dist_file_count: (await (async function count(root) {
    let total = 0;
    for (const entry of await readdir(root, { withFileTypes: true })) total += entry.isDirectory() ? await count(path.join(root, entry.name)) : 1;
    return total;
  })(dist)),
};
await writeFile(path.join(mobileRoot, 'local_artifacts/mobile-web-build-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ status: receipt.status, frozen_file_count: receipt.frozen_file_count, model_asset_count: receipt.model_asset_count, dist_file_count: receipt.dist_file_count }));
