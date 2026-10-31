import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const hash = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
const PACKAGE_GENERATED_TOP_LEVEL_JAVASCRIPT = new Set([
  'mathjax-config.js',
  'mobile-config.js',
  'mobile-entry.js',
]);
const PACKAGE_TRANSFORMED_SOURCE_FILES = new Set(['index.html', 'styles.css']);
const PACKAGE_BOOTSTRAP_RUNTIME_FILES = new Set([
  'main.js',
  'mobile-entry.js',
  'platform/haptics-controller.js',
  'platform/harmony-bridge.js',
  'platform/harmony-native-bridge.js',
  'platform/mobile-bridge.js',
  'platform/native-back-bootstrap.js',
  'platform/platform-selection.js',
]);
const PACKAGE_GENERATED_PLATFORM_FILES = new Set([
  'platform/runtime.js',
  'platform/native-back-bootstrap.js',
  'platform/harmony-native-bridge.js',
  'platform/haptics-controller.js',
  'platform/platform-selection.js',
  'platform/harmony-bridge.js',
  'platform/mobile-bridge.js',
  'platform/session-authority.js',
  'platform/credential-authority.js',
  'platform/capability-contract.js',
  'platform/replay-import-client.js',
  'platform/network-status.js',
  'platform/session-mirror.js',
  'platform/session-recovery.js',
  'platform/session-envelope.js',
]);

async function listTopLevelJavaScript(sourceWebRoot) {
  const entries = await readdir(sourceWebRoot, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && /\.(?:js|mjs)$/.test(entry.name))
    .map((entry) => entry.name).sort();
}

async function listJavaScriptRecursively(root) {
  const found = [];
  const visit = async (directory, relativeDirectory = '') => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative);
      else if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) found.push(relative);
    }
  };
  await visit(root);
  return found.sort();
}

function dynamicImportSpecifiers(source) {
  const found = [];
  const importStart = /\bimport\s*\(/g;
  for (const match of source.matchAll(importStart)) {
    let index = match.index + match[0].length;
    const expressionStart = index;
    let depth = 1;
    let quote = null;
    let escaped = false;
    for (; index < source.length && depth > 0; index += 1) {
      const char = source[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) quote = null;
      } else if (char === '"' || char === "'" || char === '`') quote = char;
      else if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
    }
    if (depth !== 0) continue;
    const expression = source.slice(expressionStart, index - 1);
    for (const literal of expression.matchAll(/(["'])([^"']+)\1/g)) {
      if (/^(?:\.|\/)/.test(literal[2]) && /\.(?:js|mjs|json)(?:[?#].*)?$/.test(literal[2])) found.push(literal[2]);
    }
  }
  return found;
}

function moduleSpecifiers(source) {
  const found = new Set();
  const patterns = [
    /\b(?:import|export)\s+(?:[^'"`]*?\s+from\s*)?["']([^"']+)["']/g,
    /\bnew\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g,
    /\bnew\s+(?:Shared)?Worker\s*\(\s*new\s+URL\(\s*["']([^"']+)["']/g,
    /\bnew\s+(?:Shared)?Worker\s*\(\s*["']([^"']+\.js(?:\?[^"']*)?)["']/g,
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) found.add(match[1]);
  for (const specifier of dynamicImportSpecifiers(source)) found.add(specifier);
  return [...found];
}

function resolveModule(importer, specifier) {
  if (!specifier.startsWith('.')) return null;
  const pathWithoutQuery = specifier.split(/[?#]/, 1)[0];
  if (!/\.(?:js|mjs|json)$/.test(pathWithoutQuery)) return null;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(importer), pathWithoutQuery));
  if (resolved === '..' || resolved.startsWith('../') || path.posix.isAbsolute(resolved)) {
    throw new Error(`Import escapes the Web source root: ${importer} -> ${specifier}`);
  }
  return resolved;
}

async function importClosure(sourceWebRoot, entry, opaqueModules = new Set()) {
  const visited = new Set();
  const visit = async (relative) => {
    if (visited.has(relative)) return;
    visited.add(relative);
    if (opaqueModules.has(relative)) return;
    const full = path.join(sourceWebRoot, ...relative.split('/'));
    let source;
    try { source = await readFile(full, 'utf8'); }
    catch (error) { throw new Error(`Missing imported Web module ${relative}: ${error.message}`); }
    for (const specifier of moduleSpecifiers(source)) {
      const dependency = resolveModule(relative, specifier);
      if (dependency) await visit(dependency);
    }
  };
  await visit(entry);
  return [...visited].sort();
}

export async function auditCurrentWebSyncClosure({ sourceWebRoot, syncManifest, runtimeManifest, validateSourceHashes = true, mode = 'live' }) {
  if (!['live', 'package'].includes(mode)) throw new Error(`Unsupported Web closure audit mode: ${mode}`);
  const sourceRoot = path.resolve(sourceWebRoot);
  const sourceTopLevelJs = await listTopLevelJavaScript(sourceRoot);
  const sourceJavaScript = mode === 'package' ? await listJavaScriptRecursively(sourceRoot) : sourceTopLevelJs;
  const syncFiles = new Set(Object.keys(syncManifest.source_files ?? {}));
  const runtimeFiles = new Set(runtimeManifest.files ?? []);
  const requiredRuntimeClosure = syncManifest.required_runtime_closure ?? [];
  const runtimeRequiredClosure = runtimeManifest.required_runtime_closure ?? [];
  const additionalFiles = new Set(runtimeManifest.packaged_additional_files ?? []);
  const extras = new Set(syncManifest.mobile_only_extras ?? []);
  const adaptations = new Map();
  for (const adaptation of [...(runtimeManifest.mobile_adaptations ?? []), ...(syncManifest.mobile_adaptations ?? [])]) {
    adaptations.set(adaptation.path, { ...(adaptations.get(adaptation.path) ?? {}), ...adaptation });
  }
  const exclusions = syncManifest.excluded_live_unwired_experiments ?? [];
  const runtimeExclusions = runtimeManifest.excluded_live_unwired_experiments ?? [];
  const wiredExclusions = syncManifest.excluded_live_wired_unqualified_experiments ?? [];
  const runtimeWiredExclusions = runtimeManifest.excluded_live_wired_unqualified_experiments ?? [];
  const bundleInternalSources = syncManifest.bundle_internal_sources ?? [];
  const runtimeBundleInternalSources = runtimeManifest.bundle_internal_sources ?? [];
  const excludedByPath = new Map(exclusions.map((item) => [item.path, item]));
  const runtimeExcludedByPath = new Map(runtimeExclusions.map((item) => [item.path, item]));
  const wiredExcludedByPath = new Map(wiredExclusions.map((item) => [item.path, item]));
  const runtimeWiredExcludedByPath = new Map(runtimeWiredExclusions.map((item) => [item.path, item]));
  const bundleInternalByPath = new Map(bundleInternalSources.map((item) => [item.path, item]));
  const runtimeBundleInternalByPath = new Map(runtimeBundleInternalSources.map((item) => [item.path, item]));
  const opaqueBundles = new Set(bundleInternalSources.map((item) => item.bundle));
  const errors = [];
  const packagedTopLevelJs = new Set([...syncFiles, ...runtimeFiles].filter((name) => !name.includes('/') && /\.(?:js|mjs)$/.test(name)));
  const accounted = new Set([...packagedTopLevelJs, ...extras, ...excludedByPath.keys(), ...wiredExcludedByPath.keys(), ...bundleInternalByPath.keys()]);
  const generatedPackageTopLevelJavaScript = mode === 'package'
    ? sourceTopLevelJs.filter((name) => PACKAGE_GENERATED_TOP_LEVEL_JAVASCRIPT.has(name))
    : [];
  const builtPackageAudit = mode === 'package' && generatedPackageTopLevelJavaScript.length > 0;
  const unclassified = sourceTopLevelJs.filter((name) => !accounted.has(name)
    && !(mode === 'package' && PACKAGE_GENERATED_TOP_LEVEL_JAVASCRIPT.has(name)));
  if (unclassified.length) errors.push(`Unclassified top-level Web JavaScript: ${unclassified.join(', ')}`);

  const liveExtraPaths = new Set(sourceTopLevelJs);
  const missingPackaged = [...packagedTopLevelJs].filter((name) => !liveExtraPaths.has(name) && !(mode === 'live' && extras.has(name)));
  if (missingPackaged.length) errors.push(`Manifest JavaScript files are missing from the live Web root: ${missingPackaged.join(', ')}`);
  const extrasNowInWeb = [...extras].filter((name) => liveExtraPaths.has(name));
  if (mode === 'live' && extrasNowInWeb.length) errors.push(`Files declared mobile-only now exist in the live Web root and must be reclassified: ${extrasNowInWeb.join(', ')}`);

  const excludedPaths = [...excludedByPath.keys()].sort();
  if (JSON.stringify(excludedPaths) !== JSON.stringify([...runtimeExcludedByPath.keys()].sort())) {
    errors.push('Runtime and current Web sync manifests disagree on live un-wired experiment exclusions.');
  }
  const wiredExcludedPaths = [...wiredExcludedByPath.keys()].sort();
  if (JSON.stringify(wiredExcludedPaths) !== JSON.stringify([...runtimeWiredExcludedByPath.keys()].sort())) {
    errors.push('Runtime and current Web sync manifests disagree on wired unqualified runtime exclusions.');
  }
  const bundleInternalPaths = [...bundleInternalByPath.keys()].sort();
  if (bundleInternalByPath.size !== bundleInternalSources.length
      || runtimeBundleInternalByPath.size !== runtimeBundleInternalSources.length) {
    errors.push('Bundle-internal source paths must be unique in both manifests.');
  }
  if (JSON.stringify(bundleInternalPaths) !== JSON.stringify([...runtimeBundleInternalByPath.keys()].sort())) {
    errors.push('Runtime and current Web sync manifests disagree on bundle-internal sources.');
  }
  const allExcludedPaths = new Set([...excludedPaths, ...wiredExcludedPaths]);
  const entryHtml = await readFile(path.join(sourceRoot, 'index.html'), 'utf8');
  const moduleScript = entryHtml.match(/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']\.\/?([^"']+)["']/i)
    ?? entryHtml.match(/<script\b[^>]*\bsrc=["']\.\/?([^"']+)["'][^>]*\btype=["']module["']/i);
  const documentRuntimeEntry = moduleScript?.[1]?.split(/[?#]/, 1)[0] ?? 'main.js';
  const entry = builtPackageAudit && documentRuntimeEntry === 'mobile-entry.js' ? 'main.js' : documentRuntimeEntry;
  let generatedPackageRuntimeFiles = [];
  let generatedPackagePlatformFiles = [];
  let generatedPackageVendorFiles = [];
  let packagedManifestJavaScriptFiles = [];
  let unclassifiedNestedJavaScript = [];
  if (builtPackageAudit) {
    if (documentRuntimeEntry !== 'mobile-entry.js') errors.push(`Packaged document entry is not mobile-entry.js: ${documentRuntimeEntry}`);
    if (JSON.stringify(generatedPackageTopLevelJavaScript) !== JSON.stringify([...PACKAGE_GENERATED_TOP_LEVEL_JAVASCRIPT].sort())) {
      errors.push(`Generated package bootstrap scripts differ: ${generatedPackageTopLevelJavaScript.join(', ')}`);
    }
    try {
      const [bootstrapClosure, mainClosure] = await Promise.all([
        importClosure(sourceRoot, 'mobile-entry.js'),
        importClosure(sourceRoot, 'main.js', opaqueBundles),
      ]);
      const packageEntryClosure = new Set([...bootstrapClosure, ...mainClosure]);
      generatedPackagePlatformFiles = [...packageEntryClosure]
        .filter((name) => name.startsWith('platform/'))
        .sort();
      generatedPackageRuntimeFiles = [...new Set([
        'mobile-entry.js', 'main.js', ...generatedPackagePlatformFiles,
      ])].sort();
      const missingBootstrapFiles = [...PACKAGE_BOOTSTRAP_RUNTIME_FILES]
        .filter((name) => !packageEntryClosure.has(name));
      if (missingBootstrapFiles.length) errors.push(`Generated package runtime imports differ: ${missingBootstrapFiles.join(', ')}`);
      for (const name of PACKAGE_BOOTSTRAP_RUNTIME_FILES) await readFile(path.join(sourceRoot, ...name.split('/')));
      generatedPackagePlatformFiles = [...PACKAGE_GENERATED_PLATFORM_FILES].filter((name) => sourceJavaScript.includes(name)).sort();
      const missingGeneratedPlatformFiles = [...PACKAGE_GENERATED_PLATFORM_FILES].filter((name) => !sourceJavaScript.includes(name));
      if (missingGeneratedPlatformFiles.length) errors.push(`Generated package platform files are missing: ${missingGeneratedPlatformFiles.join(', ')}`);
      generatedPackageVendorFiles = sourceJavaScript.filter((name) => name.startsWith('vendor/'));
      packagedManifestJavaScriptFiles = [...new Set([...syncFiles, ...runtimeFiles, ...additionalFiles, ...extras]
        .filter((name) => /\.(?:js|mjs)$/.test(name)))].sort();
      const classifiedPackageJavaScript = new Set([
        ...packagedManifestJavaScriptFiles,
        ...generatedPackageTopLevelJavaScript,
        ...PACKAGE_GENERATED_PLATFORM_FILES,
        ...generatedPackageVendorFiles,
      ]);
      unclassifiedNestedJavaScript = sourceJavaScript.filter((name) => name.includes('/') && !classifiedPackageJavaScript.has(name));
      if (unclassifiedNestedJavaScript.length) errors.push(`Unclassified nested package JavaScript: ${unclassifiedNestedJavaScript.join(', ')}`);
    } catch (error) {
      errors.push(`Generated package runtime bootstrap is incomplete: ${error.message}`);
    }
  }
  if (!/\.(?:js|mjs)$/.test(entry)) errors.push(`The Web module entry is not a JavaScript file: ${entry}`);
  let runtimeClosure = [];
  try { runtimeClosure = await importClosure(sourceRoot, entry, opaqueBundles); }
  catch (error) { errors.push(error.message); }
  if (JSON.stringify(requiredRuntimeClosure) !== JSON.stringify(runtimeRequiredClosure)) errors.push('Runtime and current Web sync manifests disagree on required runtime closure entries.');
  const missingRequiredRuntime = requiredRuntimeClosure.filter((name) => !runtimeClosure.includes(name));
  if (missingRequiredRuntime.length) errors.push(`Required runtime modules are missing from the Web closure: ${missingRequiredRuntime.join(', ')}`);
  const reachableExcluded = runtimeClosure.filter((name) => allExcludedPaths.has(name));
  const reachableUnwired = reachableExcluded.filter((name) => excludedByPath.has(name));
  if (reachableUnwired.length) errors.push(`Un-wired experiment was reached from the Web module entry: ${reachableUnwired.join(', ')}`);
  const packagedRuntimeSources = new Set([...syncFiles, ...runtimeFiles, ...extras, ...additionalFiles]);
  const reachableUnpackaged = runtimeClosure.filter((name) => !packagedRuntimeSources.has(name)
    && !allExcludedPaths.has(name) && !bundleInternalByPath.has(name));
  if (reachableUnpackaged.length) errors.push(`Runtime-reachable Web modules are missing from the app package manifests: ${reachableUnpackaged.join(', ')}`);
  if (mode === 'package') for (const name of additionalFiles) {
    try { await readFile(path.join(sourceRoot, ...name.split('/'))); }
    catch { errors.push(`Additional packaged runtime file is missing: ${name}`); }
  }

  const bundleInternalRecords = [];
  for (const item of bundleInternalSources) {
    const runtimeItem = runtimeBundleInternalByPath.get(item.path);
    const sourceExists = sourceTopLevelJs.includes(item.path);
    if (!runtimeItem || !isDeepStrictEqual(runtimeItem, item)) errors.push(`Runtime and sync bundle-internal record differs: ${item.path}`);
    if (item.classification !== 'bundle_internal_source' || item.packaged !== false
        || typeof item.bundle !== 'string' || !/\.(?:js|mjs)$/.test(item.bundle) || !item.reason?.trim()) {
      errors.push(`Bundle-internal source classification mismatch: ${item.path}`);
    }
    if (!/^[a-f0-9]{64}$/.test(item.source_sha256 ?? '')) errors.push(`Invalid bundle-internal source SHA-256: ${item.path}`);
    if (syncFiles.has(item.path) || runtimeFiles.has(item.path)) errors.push(`Bundle-internal source is included as a standalone package resource: ${item.path}`);
    if (!syncFiles.has(item.bundle) || !runtimeFiles.has(item.bundle)) errors.push(`Bundle-internal source names an unshipped bundle: ${item.path}`);
    if (mode === 'live' && !sourceExists) errors.push(`Bundle-internal source is missing from the live Web root: ${item.path}`);
    if (mode === 'package' && sourceExists) errors.push(`Bundle-internal source was copied into the app package: ${item.path}`);
    let actualHash = null;
    if (sourceExists) {
      actualHash = await hash(path.join(sourceRoot, item.path));
      if (validateSourceHashes && actualHash !== item.source_sha256) errors.push(`Bundle-internal source SHA-256 mismatch: ${item.path}`);
    }
    bundleInternalRecords.push({ path: item.path, sourceSha256: actualHash ?? item.source_sha256,
      bundle: item.bundle, packaged: false });
  }

  if (validateSourceHashes) for (const [name, packagedHash] of Object.entries(syncManifest.source_files ?? {})) {
    const sourcePath = path.join(sourceRoot, ...name.split('/'));
    let liveHash;
    try { liveHash = await hash(sourcePath); }
    catch (error) {
      if (!(mode === 'live' && extras.has(name))) errors.push(`Packaged source is missing from ${mode === 'live' ? 'live Web root' : 'app package'}: ${name}`);
      continue;
    }
    if (builtPackageAudit && PACKAGE_TRANSFORMED_SOURCE_FILES.has(name)) continue;
    const adaptation = adaptations.get(name);
    const expectedLiveHash = mode === 'package'
      ? (adaptation?.mobile_sha256 ?? packagedHash)
      : (adaptation?.source_sha256 ?? packagedHash);
    if (liveHash !== expectedLiveHash) errors.push(`Live Web source SHA-256 mismatch: ${name}`);
  }

  const experimentRecords = [];
  const exclusionGroups = [
    { records: exclusions, runtimeByPath: runtimeExcludedByPath,
      classification: 'unwired_unqualified_experiment', runtimeReachable: false },
    { records: wiredExclusions, runtimeByPath: runtimeWiredExcludedByPath,
      classification: 'wired_unqualified_runtime_path', runtimeReachable: true },
  ];
  for (const group of exclusionGroups) for (const item of group.records) {
    const runtimeItem = group.runtimeByPath.get(item.path);
    const exclusionExists = sourceTopLevelJs.includes(item.path);
    if (mode === 'live' && !exclusionExists) errors.push(`Excluded live experiment is missing from the Web root: ${item.path}`);
    if (mode === 'package' && exclusionExists) errors.push(`Excluded live experiment was copied into the app package: ${item.path}`);
    if (!runtimeItem || !isDeepStrictEqual(runtimeItem, item)) errors.push(`Runtime and sync exclusion record differs: ${item.path}`);
    if (item.classification !== group.classification || item.runtime_reachable !== group.runtimeReachable || item.packaged !== false) {
      errors.push(`Live-source exclusion classification mismatch: ${item.path}`);
    }
    if (syncFiles.has(item.path) || runtimeFiles.has(item.path)) errors.push(`Excluded unqualified source is included in the app package manifest: ${item.path}`);
    if (!item.reason?.trim()) errors.push(`Missing exclusion reason: ${item.path}`);
    if (mode === 'package' && !exclusionExists) continue;
    const actuallyReachable = runtimeClosure.includes(item.path);
    if (actuallyReachable !== group.runtimeReachable) errors.push(`Live-source exclusion reachability changed: ${item.path}`);
    const actualHash = await hash(path.join(sourceRoot, item.path));
    if (actualHash !== item.source_sha256) errors.push(`Excluded experiment SHA-256 mismatch: ${item.path}`);
    const directImports = moduleSpecifiers(await readFile(path.join(sourceRoot, item.path), 'utf8'))
      .map((specifier) => resolveModule(item.path, specifier)).filter(Boolean).sort();
    const expectedImports = [...(item.direct_imports ?? [])].sort();
    if (JSON.stringify(directImports) !== JSON.stringify(expectedImports)) errors.push(`Excluded experiment import list changed: ${item.path}`);
    const closure = await importClosure(sourceRoot, item.path);
    const unshippedDependencies = closure.filter((dependency) => !allExcludedPaths.has(dependency)
      && !syncFiles.has(dependency) && !runtimeFiles.has(dependency));
    if (unshippedDependencies.length) errors.push(`Experimental dependency closure contains unclassified/unpackaged source: ${item.path}: ${unshippedDependencies.join(', ')}`);
    experimentRecords.push({ path: item.path, classification: item.classification,
      sourceSha256: actualHash, runtimeReachable: actuallyReachable,
      packaged: false, directImports, dependencyClosure: closure });
  }

  if (errors.length) throw new Error(errors.join('\n'));
  return {
    status: 'PASS_CURRENT_WEB_RUNTIME_CLOSURE',
    mode,
    packageAuditKind: mode === 'package' ? (builtPackageAudit ? 'built-package' : 'source-projection') : null,
    sourceRoot,
    runtimeEntry: entry,
    documentRuntimeEntry,
    topLevelJavaScriptCount: sourceTopLevelJs.length - generatedPackageTopLevelJavaScript.length,
    packageJavaScriptCount: mode === 'package' ? sourceJavaScript.length : null,
    generatedPackageTopLevelJavaScript,
    generatedPackageRuntimeFiles,
    generatedPackagePlatformFiles,
    generatedPackageVendorFiles,
    packagedManifestJavaScriptFiles,
    transformedPackageSourceFiles: builtPackageAudit
      ? [...PACKAGE_TRANSFORMED_SOURCE_FILES].filter((name) => syncFiles.has(name)).sort()
      : [],
    packagedWebSourceCount: syncFiles.size,
    packagedRuntimeSourceCount: runtimeFiles.size,
    mobileOnlyExtraCount: extras.size,
    unclassifiedTopLevelJavaScript: [],
    unclassifiedNestedJavaScript,
    runtimeReachableSourceCount: runtimeClosure.length,
    runtimeReachableSourceFiles: runtimeClosure,
    unqualifiedUnwiredExperiments: experimentRecords.filter((item) => !item.runtimeReachable),
    unqualifiedWiredRuntimePaths: experimentRecords.filter((item) => item.runtimeReachable),
    bundleInternalSources: bundleInternalRecords,
  };
}
