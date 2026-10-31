import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const SHA256 = /^[0-9a-f]{64}$/;
const BASELINE_SCHEMA = 'lifeline-mobile-live-runtime-delta-baseline-v1';
const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const normalizePath = (value) => value.replaceAll('\\', '/');
const staticStringLiterals = (source) => [...source.matchAll(/(["'`])((?:\\.|.)*?)\1/g)]
  .filter((match) => match[1] !== '`' || !match[2].includes('${'));

async function listTree(root) {
  const files = new Map();
  const visit = async (directory, relativeDirectory = '') => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(full, relative);
      else if (entry.isFile()) {
        const bytes = await readFile(full);
        files.set(normalizePath(relative), { sha256: sha256(bytes), bytes: bytes.length });
      }
    }
  };
  await visit(path.resolve(root));
  return files;
}

function treeSummary(files) {
  const rows = [...files.entries()].sort(([left], [right]) => left.localeCompare(right));
  const inventory = rows.map(([name, value]) => `${name}\0${value.sha256}\0${value.bytes}\n`).join('');
  return {
    fileCount: rows.length,
    byteCount: rows.reduce((sum, [, value]) => sum + value.bytes, 0),
    inventorySha256: sha256(inventory),
  };
}

function dynamicImportSpecifiers(source) {
  const found = [];
  for (const match of source.matchAll(/\bimport\s*\(/g)) {
    let index = match.index + match[0].length;
    const expressionStart = index;
    let depth = 1;
    let quote = null;
    let escaped = false;
    for (; index < source.length && depth > 0; index += 1) {
      const character = source[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === quote) quote = null;
      } else if (character === '"' || character === "'" || character === '`') quote = character;
      else if (character === '(') depth += 1;
      else if (character === ')') depth -= 1;
    }
    if (depth !== 0) continue;
    const expression = source.slice(expressionStart, index - 1);
    for (const literal of staticStringLiterals(expression)) {
      if (/^(?:\.|\/)/.test(literal[2]) && /\.(?:js|mjs|json)(?:[?#].*)?$/.test(literal[2])) found.push(literal[2]);
    }
  }
  return found;
}

function fetchSpecifiers(source) {
  const found = [];
  for (const match of source.matchAll(/\bfetch\s*\(\s*(["'`])((?:\\.|.)*?)\1/g)) {
    if (match[1] === '`' && match[2].includes('${')) continue;
    const specifier = match[2];
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(specifier)) continue;
    found.push(specifier);
  }
  return found;
}

function assetUrlSpecifiers(source) {
  const found = [];
  const pattern = /\bnew\s+URL\(\s*(["'`])((?:\\.|.)*?)\1\s*,\s*import\.meta\.url\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    if (match[1] === '`' && match[2].includes('${')) continue;
    if (!/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(match[2])) found.push(match[2]);
  }
  return found;
}

function moduleSpecifiers(source) {
  const found = new Set();
  const patterns = [
    /\b(?:import|export)\s+(?:[^'"`]*?\s+from\s*)?["']([^"']+)["']/g,
    /\bnew\s+(?:Shared)?Worker\s*\(\s*new\s+URL\(\s*["']([^"']+)["']/g,
    /\bnew\s+(?:Shared)?Worker\s*\(\s*(["'`])((?:\\.|.)*?)\1/g,
    /\bfetch\s*\(\s*["'](\.{1,2}\/[^"']+)["']/g,
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) {
    const specifier = match[2] ?? match[1];
    if (match[1] === '`' && specifier.includes('${')) continue;
    if (/\.(?:m?js|json)(?:[?#].*)?$/.test(specifier)) found.add(specifier);
  }
  for (const specifier of dynamicImportSpecifiers(source)) found.add(specifier);
  return [...found];
}

function resolveModule(importer, specifier) {
  const rootRelative = specifier.startsWith('/');
  if (!rootRelative && !specifier.startsWith('.')) return null;
  const withoutQuery = specifier.split(/[?#]/, 1)[0];
  if (!/\.(?:js|mjs|json)$/.test(withoutQuery)) return null;
  const resolved = path.posix.normalize(rootRelative
    ? withoutQuery.replace(/^\/+/, '')
    : path.posix.join(path.posix.dirname(importer), withoutQuery));
  if (resolved === '..' || resolved.startsWith('../') || path.posix.isAbsolute(resolved)) return null;
  return resolved;
}

async function collectRuntimeClosure(root) {
  const visited = new Set();
  const errors = [];
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const moduleScript = html.match(/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']\.\/?([^"']+)["']/i)
    ?? html.match(/<script\b[^>]*\bsrc=["']\.\/?([^"']+)["'][^>]*\btype=["']module["']/i);
  const entry = moduleScript?.[1]?.split(/[?#]/, 1)[0] ?? 'main.js';
  const visit = async (relative) => {
    if (visited.has(relative)) return;
    visited.add(relative);
    let source;
    try { source = await readFile(path.join(root, ...relative.split('/')), 'utf8'); }
    catch (error) {
      errors.push({ path: relative, error: error.message });
      return;
    }
    for (const specifier of moduleSpecifiers(source)) {
      const dependency = resolveModule(relative, specifier);
      if (dependency) await visit(dependency);
    }
    for (const specifier of [...fetchSpecifiers(source), ...assetUrlSpecifiers(source)]) {
      const dependency = resolveModule(relative, specifier.startsWith('/') || specifier.startsWith('.') ? specifier : `./${specifier}`);
      if (dependency) await visit(dependency);
    }
  };
  await visit(entry);
  return { entry, files: visited, errors };
}

async function gitContext(root) {
  try {
    const run = async (...args) => (await execFileAsync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
    const [branch, head, status] = await Promise.all([
      run('branch', '--show-current'),
      run('rev-parse', 'HEAD'),
      run('status', '--porcelain=v1'),
    ]);
    const rows = status ? status.split(/\r?\n/) : [];
    return {
      branch,
      head,
      workspaceDirty: rows.length > 0,
      trackedChangeCount: rows.filter((row) => !row.startsWith('??')).length,
      untrackedCount: rows.filter((row) => row.startsWith('??')).length,
    };
  } catch (error) {
    return { unavailable: true, error: String(error?.message ?? error) };
  }
}

function validateHash(value, label) {
  if (!SHA256.test(value ?? '')) throw new Error(`${label} must be a lowercase SHA-256 digest.`);
}

function validateBaseline(baseline) {
  if (baseline?.schema !== BASELINE_SCHEMA) throw new Error(`Unsupported live delta baseline schema: ${baseline?.schema ?? 'missing'}`);
  for (const field of ['accepted_checkpoint', 'sync_release_id', 'runtime_asset_version']) {
    if (typeof baseline[field] !== 'string' || !baseline[field]) throw new Error(`Baseline ${field} is required.`);
  }
  validateHash(baseline.post_r13_audit?.sha256, 'Baseline post-R13 audit hash');
  validateHash(baseline.sync_manifest_sha256, 'Baseline sync manifest hash');
  validateHash(baseline.runtime_manifest_sha256, 'Baseline runtime manifest hash');
  const unique = new Set();
  for (const group of ['reviewed_runtime_differences', 'mobile_only_runtime', 'excluded_hard', 'reviewed_mobile_only_tests']) {
    if (!Array.isArray(baseline[group])) throw new Error(`Baseline ${group} must be an array.`);
    for (const item of baseline[group]) {
      if (typeof item.path !== 'string' || !item.path || unique.has(item.path)) throw new Error(`Baseline path is missing or duplicated: ${item.path ?? 'missing'}`);
      unique.add(item.path);
      if (group === 'reviewed_runtime_differences') {
        validateHash(item.source_sha256, `${item.path} source hash`);
        validateHash(item.mobile_sha256, `${item.path} mobile hash`);
        if (!['cache_query_only', 'reviewed_semantic_adaptation'].includes(item.classification)) throw new Error(`Unsupported reviewed difference classification: ${item.path}`);
      } else {
        validateHash(item.sha256, `${item.path} hash`);
        if (typeof item.reason !== 'string' || !item.reason.trim()) throw new Error(`Baseline reason is required: ${item.path}`);
      }
    }
  }
  if (!Array.isArray(baseline.reviewed_mobile_only_tests)) throw new Error('Baseline reviewed_mobile_only_tests must be an array.');
  const rules = baseline.classification_rules ?? {};
  for (const field of ['temporary_prefixes', 'test_prefixes', 'exact_test_paths', 'research_receipt_suffixes']) {
    if (!Array.isArray(rules[field]) || rules[field].some((value) => typeof value !== 'string' || !value)) {
      throw new Error(`Baseline classification rule ${field} must be a non-empty string array.`);
    }
  }
}

function differenceRecord(name, source, mobile, extra = {}) {
  return {
    path: name,
    difference: source && mobile ? 'content_changed' : source ? 'source_only' : 'mobile_only',
    sourceSha256: source?.sha256 ?? null,
    mobileSha256: mobile?.sha256 ?? null,
    ...extra,
  };
}

export async function auditLiveWebRuntimeDelta({
  sourceWebRoot,
  mobileWebRoot = path.join(mobileRoot, '..', 'web', 'web前端'),
  baselinePath = path.join(mobileRoot, 'config', 'post-r13-live-delta-baseline.json'),
  syncManifestPath = path.join(mobileRoot, 'config', 'current-web-sync-source-manifest.json'),
  runtimeManifestPath = path.join(mobileRoot, 'config', 'mobile-runtime-source-manifest.json'),
  includeGit = true,
} = {}) {
  if (!sourceWebRoot) throw new Error('A live Web source root is required.');
  const [baselineBytes, syncBytes, runtimeBytes] = await Promise.all([
    readFile(path.resolve(baselinePath)),
    readFile(path.resolve(syncManifestPath)),
    readFile(path.resolve(runtimeManifestPath)),
  ]);
  const baseline = JSON.parse(baselineBytes);
  const syncManifest = JSON.parse(syncBytes);
  const runtimeManifest = JSON.parse(runtimeBytes);
  validateBaseline(baseline);
  if (sha256(syncBytes) !== baseline.sync_manifest_sha256) throw new Error('Current Web sync manifest SHA-256 differs from the frozen L30-A checkpoint.');
  if (sha256(runtimeBytes) !== baseline.runtime_manifest_sha256) throw new Error('Runtime manifest SHA-256 differs from the frozen L30-A checkpoint.');
  if (syncManifest.release_id !== baseline.sync_release_id) throw new Error('Baseline and current Web sync manifest release IDs differ.');
  if (runtimeManifest.runtime_asset_version !== baseline.runtime_asset_version) throw new Error('Baseline and runtime manifest asset versions differ.');

  const auditPath = path.resolve(mobileRoot, '..', baseline.post_r13_audit.path);
  const auditBytes = await readFile(auditPath);
  if (sha256(auditBytes) !== baseline.post_r13_audit.sha256) throw new Error('The reviewed post-R13 audit hash changed.');

  const sourceRoot = path.resolve(sourceWebRoot);
  const mobileRootResolved = path.resolve(mobileWebRoot);
  const [sourceTree, mobileTree, runtime, sourceGit, mobileGit] = await Promise.all([
    listTree(sourceRoot),
    listTree(mobileRootResolved),
    collectRuntimeClosure(sourceRoot),
    includeGit ? gitContext(sourceRoot) : Promise.resolve(null),
    includeGit ? gitContext(mobileRootResolved) : Promise.resolve(null),
  ]);

  const reviewed = new Map(baseline.reviewed_runtime_differences.map((item) => [item.path, item]));
  const mobileOnly = new Map(baseline.mobile_only_runtime.map((item) => [item.path, item]));
  const hard = new Map(baseline.excluded_hard.map((item) => [item.path, item]));
  const rules = baseline.classification_rules;
  const differencePaths = [...new Set([...sourceTree.keys(), ...mobileTree.keys()])]
    .filter((name) => sourceTree.get(name)?.sha256 !== mobileTree.get(name)?.sha256)
    .sort((left, right) => left.localeCompare(right));
  const categories = {
    generatedTestScratch: [],
    testsAndBenchmarks: [],
    researchReceipts: [],
    excludedHard: [],
    mobileOnlyRuntime: [],
    reviewedRuntimeDifferences: [],
    adaptationChanges: [],
    runtimeCandidates: [],
    hardPolicyViolations: [],
  };
  const classified = new Set();
  const add = (category, name, extra = {}) => {
    if (classified.has(name)) throw new Error(`Delta path was classified more than once: ${name}`);
    classified.add(name);
    categories[category].push(differenceRecord(name, sourceTree.get(name), mobileTree.get(name), extra));
  };

  for (const name of differencePaths) {
    const source = sourceTree.get(name);
    const mobile = mobileTree.get(name);
    const hardRecord = hard.get(name);
    if (hardRecord) {
      if (mobile) add('hardPolicyViolations', name, { runtimeReachable: runtime.files.has(name),
        reason: 'An explicitly excluded Hard artifact entered the mobile Web tree.' });
      else if (runtime.files.has(name) && source?.sha256 !== hardRecord.sha256) {
        add('hardPolicyViolations', name, { runtimeReachable: true,
          reason: 'A reachable excluded Hard artifact changed from its frozen reviewed hash.' });
      } else add('excludedHard', name, { baselineChanged: source?.sha256 !== hardRecord.sha256, reason: hardRecord.reason,
        runtimeReachable: runtime.files.has(name) });
      continue;
    }
    if (/(?:^|\/)\w*Hard\w*\.(?:js|mjs|json)$/i.test(name)) {
      if (mobile) add('hardPolicyViolations', name, { reason: 'A Hard-named runtime artifact is not admitted by the frozen mobile package policy.' });
      else add('runtimeCandidates', name, { runtimeReachable: runtime.files.has(name),
        reason: 'An unlisted Hard-named runtime artifact requires explicit policy review.' });
      continue;
    }
    const mobileRecord = mobileOnly.get(name);
    if (mobileRecord) {
      if (!source && mobile?.sha256 === mobileRecord.sha256) add('mobileOnlyRuntime', name, { reason: mobileRecord.reason });
      else add('adaptationChanges', name, { reason: 'A reviewed mobile-only runtime path changed or appeared in the Web source.' });
      continue;
    }
    const reviewedRecord = reviewed.get(name);
    if (reviewedRecord) {
      if (source?.sha256 === reviewedRecord.source_sha256 && mobile?.sha256 === reviewedRecord.mobile_sha256) {
        add('reviewedRuntimeDifferences', name, { classification: reviewedRecord.classification });
      } else add('adaptationChanges', name, { classification: reviewedRecord.classification,
        reason: 'A reviewed source/mobile adaptation pair changed after the post-R13 audit.' });
      continue;
    }
    if (runtime.files.has(name)) {
      add('runtimeCandidates', name, { runtimeReachable: true,
        reason: 'Changed path is reachable from the live Web module entry.' });
      continue;
    }
    if (rules.temporary_prefixes.some((prefix) => name.startsWith(prefix))) {
      add('generatedTestScratch', name);
      continue;
    }
    if (rules.test_prefixes.some((prefix) => name.startsWith(prefix))) {
      if (!source && mobile) {
        const reviewedTest = baseline.reviewed_mobile_only_tests.find((item) => item.path === name);
        if (reviewedTest?.sha256 === mobile.sha256) add('testsAndBenchmarks', name, { classification: 'reviewed_mobile_only_test' });
        else add('runtimeCandidates', name, { runtimeReachable: false,
          reason: reviewedTest ? 'A reviewed mobile-only test changed from its frozen hash.' : 'A mobile-only test path is outside the accepted baseline and requires review.' });
        continue;
      }
      add('testsAndBenchmarks', name);
      continue;
    }
    if (rules.research_receipt_suffixes.some((suffix) => name.endsWith(suffix))
      && !runtime.files.has(name) && !mobile) {
      add('researchReceipts', name);
      continue;
    }
    add('runtimeCandidates', name, { runtimeReachable: false,
      reason: 'Changed product path is not in a frozen non-runtime category.' });
  }

  if (classified.size !== differencePaths.length) throw new Error('Delta classification did not cover every differing path exactly once.');

  const baselineChanges = [];
  const baselinePolicyViolations = [];
  const reviewClassifiedPaths = new Set([
    ...categories.adaptationChanges,
    ...categories.runtimeCandidates,
    ...categories.hardPolicyViolations,
  ].map((item) => item.path));
  for (const [name, item] of hard) {
    if (mobileTree.has(name) && !categories.hardPolicyViolations.some((record) => record.path === name)) {
      baselinePolicyViolations.push({ path: name, policy: 'excluded_hard_absent_from_mobile',
        mobileSha256: mobileTree.get(name).sha256, reason: item.reason });
    }
  }
  for (const [name, item] of mobileOnly) {
    const source = sourceTree.get(name);
    const mobile = mobileTree.get(name);
    if (source && !reviewClassifiedPaths.has(name)) {
      baselinePolicyViolations.push({ path: name, policy: 'mobile_only_absent_from_live_web',
        sourceSha256: source.sha256, reason: item.reason });
    }
    if ((!mobile || mobile.sha256 !== item.sha256) && !reviewClassifiedPaths.has(name)) {
      baselineChanges.push({ path: name, sourceSha256: source?.sha256 ?? null, mobileSha256: mobile?.sha256 ?? null,
        reason: 'A reviewed mobile-only runtime path is missing or changed.' });
    }
  }
  for (const [name, item] of reviewed) {
    const source = sourceTree.get(name);
    const mobile = mobileTree.get(name);
    if ((source?.sha256 !== item.source_sha256 || mobile?.sha256 !== item.mobile_sha256)
      && !reviewClassifiedPaths.has(name)) {
      baselineChanges.push({ path: name, sourceSha256: source?.sha256 ?? null, mobileSha256: mobile?.sha256 ?? null,
        reason: 'A reviewed source/mobile adaptation pair no longer matches its frozen hashes.' });
    }
  }
  for (const item of baseline.reviewed_mobile_only_tests) {
    const source = sourceTree.get(item.path);
    const mobile = mobileTree.get(item.path);
    if (source && !reviewClassifiedPaths.has(item.path)) {
      baselinePolicyViolations.push({ path: item.path, policy: 'reviewed_mobile_only_test_absent_from_live_web',
        sourceSha256: source.sha256, reason: 'A reviewed mobile-only test path appeared in the live Web tree.' });
    }
    if ((!mobile || mobile.sha256 !== item.sha256) && !reviewClassifiedPaths.has(item.path)) {
      baselineChanges.push({ path: item.path, sourceSha256: source?.sha256 ?? null, mobileSha256: mobile?.sha256 ?? null,
        reason: 'A reviewed mobile-only test is missing or differs from its frozen hash.' });
    }
  }
  const expectedMobileHashes = new Map(Object.entries(syncManifest.source_files ?? {}));
  for (const item of syncManifest.mobile_adaptations ?? []) expectedMobileHashes.set(item.path, item.mobile_sha256 ?? expectedMobileHashes.get(item.path));
  for (const item of runtimeManifest.mobile_adaptations ?? []) expectedMobileHashes.set(item.path, item.mobile_sha256 ?? expectedMobileHashes.get(item.path));
  for (const [name, expected] of expectedMobileHashes) {
    if (reviewed.has(name) || mobileOnly.has(name) || hard.has(name)) continue;
    const source = sourceTree.get(name);
    const mobile = mobileTree.get(name);
    if (reviewClassifiedPaths.has(name)) continue;
    if (!source && !mobile) {
      baselineChanges.push({ path: name, sourceSha256: null, mobileSha256: null,
        reason: 'A shared accepted R13 manifest path is missing from both trees.' });
      continue;
    }
    if (!source || !mobile || source.sha256 !== mobile.sha256) continue;
    if (mobile.sha256 !== expected) baselineChanges.push({ path: name, sourceSha256: source.sha256, mobileSha256: mobile.sha256,
      reason: 'Source and mobile match each other but differ from the accepted R13 manifest hash.' });
  }
  const knownProductPaths = new Set([
    ...expectedMobileHashes.keys(),
    ...(runtimeManifest.files ?? []),
    ...reviewed.keys(),
    ...mobileOnly.keys(),
    ...hard.keys(),
  ]);
  for (const [name, source] of sourceTree) {
    const mobile = mobileTree.get(name);
    if (!mobile || source.sha256 !== mobile.sha256 || knownProductPaths.has(name)) continue;
    if (runtime.files.has(name)) {
      baselineChanges.push({ path: name, sourceSha256: source.sha256, mobileSha256: mobile.sha256,
        reason: 'An identical unmanifested path is reachable from the live Web module entry.' });
      continue;
    }
    if (rules.temporary_prefixes.some((prefix) => name.startsWith(prefix))
      || rules.test_prefixes.some((prefix) => name.startsWith(prefix))
      || rules.exact_test_paths.includes(name)) continue;
    baselineChanges.push({ path: name, sourceSha256: source.sha256, mobileSha256: mobile.sha256,
      reason: 'An identical path exists in both trees but is absent from the accepted manifests and reviewed baseline.' });
  }

  for (const category of Object.values(categories)) category.sort((left, right) => left.path.localeCompare(right.path));
  baselineChanges.sort((left, right) => left.path.localeCompare(right.path));
  baselinePolicyViolations.sort((left, right) => left.path.localeCompare(right.path));
  const reviewCategories = ['adaptationChanges', 'runtimeCandidates', 'hardPolicyViolations'];
  const reviewRequiredCount = reviewCategories.reduce((sum, name) => sum + categories[name].length, 0)
    + baselineChanges.length + baselinePolicyViolations.length + runtime.errors.length;
  const status = reviewRequiredCount
    ? 'REVIEW_REQUIRED_LIVE_WEB_RUNTIME_DELTA'
    : 'PASS_NO_NEW_LIVE_WEB_RUNTIME_DELTA';
  const classifiedCount = Object.values(categories).reduce((sum, rows) => sum + rows.length, 0);
  return {
    schema: 'lifeline-mobile-live-runtime-delta-report-v1',
    status,
    acceptedCheckpoint: baseline.accepted_checkpoint,
    syncReleaseId: baseline.sync_release_id,
    runtimeAssetVersion: baseline.runtime_asset_version,
    writesPerformed: false,
    source: { root: sourceRoot, ...treeSummary(sourceTree), git: sourceGit },
    mobile: { root: mobileRootResolved, ...treeSummary(mobileTree), git: mobileGit },
    manifests: {
      currentWebSyncSha256: sha256(syncBytes),
      runtimeSha256: sha256(runtimeBytes),
      postR13AuditSha256: baseline.post_r13_audit.sha256,
    },
    runtimeClosure: {
      entry: runtime.entry,
      fileCount: runtime.files.size,
      files: [...runtime.files].sort(),
      resolutionErrors: runtime.errors,
    },
    differencePathCount: differencePaths.length,
    classifiedDifferencePathCount: classifiedCount,
    classificationCounts: Object.fromEntries(Object.entries(categories).map(([name, rows]) => [name, rows.length])),
    classifications: categories,
    baselineChanges,
    baselinePolicyViolations,
    reviewRequiredCount,
  };
}

function parseArguments(argv) {
  const allowed = new Set(['--source-web-root', '--mobile-web-root', '--baseline']);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!allowed.has(key) || index + 1 >= argv.length) {
      throw new Error('Usage: node tools/audit-live-web-runtime-delta.mjs --source-web-root PATH [--mobile-web-root PATH] [--baseline PATH]');
    }
    values.set(key, argv[++index]);
  }
  return values;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const result = await auditLiveWebRuntimeDelta({
    sourceWebRoot: args.get('--source-web-root') ?? process.env.LIFELINE_CURRENT_WEB_ROOT,
    mobileWebRoot: args.get('--mobile-web-root'),
    baselinePath: args.get('--baseline'),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.reviewRequiredCount) process.exitCode = 2;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: 'ERROR_LIVE_WEB_RUNTIME_DELTA_GATE', error: String(error?.message ?? error), writesPerformed: false }, null, 2)}\n`);
    process.exitCode = 1;
  });
}
