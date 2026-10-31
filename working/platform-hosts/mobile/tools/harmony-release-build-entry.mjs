import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, stat, lstat, realpath, writeFile, copyFile, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_HARMONY_SIGNING_FILE, readHarmonySigningMaterial } from './harmony-release-signing.mjs';
import { prepareHarmonyReleaseSigningOverlay } from './prepare-harmony-release-signing.mjs';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(mobileRoot, '..');
export const HARMONY_RELEASE_IDENTITY_SCHEMA = 'lifeline-mobile-release-identity-candidate-v1';
export const EXPECTED_HVIGOR_VERSION = '5.8.9';

function require(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function within(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function validateArtifactDirectoryPath(target, localArtifactsRoot) {
  const normalizedRoot = path.resolve(localArtifactsRoot);
  const normalizedTarget = path.resolve(target);
  require(within(normalizedTarget, normalizedRoot) && normalizedTarget !== normalizedRoot,
    'Harmony release build artifacts must be isolated under ignored mobile/local_artifacts.');
  const rootInfo = await lstat(normalizedRoot);
  require(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), 'mobile/local_artifacts must be a real directory, not a link.');
  const rootReal = await realpath(normalizedRoot);
  require(path.resolve(rootReal) === normalizedRoot, 'mobile/local_artifacts resolves outside its expected path.');
  let cursor = normalizedRoot;
  for (const part of path.relative(normalizedRoot, normalizedTarget).split(path.sep).filter(Boolean).slice(0, -1)) {
    cursor = path.join(cursor, part);
    const info = await lstat(cursor).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!info) break;
    require(info.isDirectory() && !info.isSymbolicLink(), 'Artifact path contains a symlink or reparse point.');
    const resolved = await realpath(cursor);
    require(within(path.resolve(resolved), rootReal), 'Artifact parent resolves outside ignored mobile/local_artifacts.');
  }
  return normalizedTarget;
}

export function assertNoSigningMaterial(text, material) {
  const content = String(text || '');
  for (const value of Object.values(material || {})) {
    if (typeof value === 'string' && value.length > 0) require(!content.includes(value), 'Signing material was found in a retained plan, log, or receipt.');
  }
}

function readJson(text, label) {
  try { return JSON.parse(text); } catch { throw new Error(`${label} must be valid JSON/JSON5 using the checked-in JSON-compatible subset.`); }
}

function validateFrozenIdentity(identity) {
  require(identity?.schema === HARMONY_RELEASE_IDENTITY_SCHEMA, 'Release identity schema is invalid.');
  require(identity.status === 'FROZEN', 'Harmony release build requires release identity status FROZEN.');
  require(typeof identity.harmony?.bundleName === 'string' && identity.harmony.bundleName.length > 0,
    'Frozen Harmony bundleName is missing.');
  require(Number.isInteger(identity.harmony?.versionCode) && identity.harmony.versionCode > 0,
    'Frozen Harmony versionCode is invalid.');
  require(typeof identity.harmony?.versionName === 'string' && identity.harmony.versionName.length > 0,
    'Frozen Harmony versionName is missing.');
  require(/^[0-9a-f]{64}$/.test(identity.releaseCertificateFingerprints?.harmonyCertChainSha256 || ''),
    'Frozen Harmony certificate-chain SHA-256 is missing or invalid.');
}

function validateHarmonyProfile(profile, material) {
  const products = profile?.app?.products;
  require(Array.isArray(products), 'Harmony profile app.products is missing.');
  const product = products.find((item) => item.name === 'default');
  require(product, 'Harmony profile default product is missing.');
  require(product.signingConfig === 'lifeline-release', 'Harmony profile default product does not consume lifeline-release.');
  const configs = profile.app.signingConfigs;
  require(Array.isArray(configs) && configs.length === 1, 'Harmony release profile must contain exactly one signing config.');
  const config = configs[0];
  require(config.name === 'lifeline-release' && config.type === 'HarmonyOS', 'Harmony signing config identity is invalid.');
  require(JSON.stringify(config.material) === JSON.stringify(material), 'Harmony release overlay material does not match the validated signing inputs.');
}

async function verifyInstalledSchema({ sourceProjectRoot, toolRoot }) {
  const projectPackage = readJson(await readFile(path.join(sourceProjectRoot, 'oh-package.json5'), 'utf8'), 'Harmony project package');
  const hvigorConfig = readJson(await readFile(path.join(sourceProjectRoot, 'hvigor/hvigor-config.json5'), 'utf8'), 'Hvigor config');
  for (const dependency of ['@ohos/hvigor', '@ohos/hvigor-ohos-plugin']) {
    require(projectPackage.devDependencies?.[dependency] === EXPECTED_HVIGOR_VERSION,
      `Harmony project ${dependency} must be ${EXPECTED_HVIGOR_VERSION}.`);
    require(hvigorConfig.dependencies?.[dependency] === EXPECTED_HVIGOR_VERSION,
      `Harmony hvigor config ${dependency} must be ${EXPECTED_HVIGOR_VERSION}.`);
  }
  const hvigorRoot = path.join(toolRoot, 'hvigor/hvigor');
  const pluginRoot = path.join(toolRoot, 'hvigor/hvigor-ohos-plugin');
  const hvigorPackage = readJson(await readFile(path.join(hvigorRoot, 'package.json'), 'utf8'), 'Installed Hvigor package');
  const pluginPackage = readJson(await readFile(path.join(pluginRoot, 'package.json'), 'utf8'), 'Installed Hvigor plugin package');
  require(hvigorPackage.version === EXPECTED_HVIGOR_VERSION && pluginPackage.version === EXPECTED_HVIGOR_VERSION,
    `Installed Hvigor and plugin must both be ${EXPECTED_HVIGOR_VERSION}.`);
  const declarationPath = path.join(pluginRoot, 'src/options/build/project-build-profile.d.ts');
  const declarations = await readFile(declarationPath, 'utf8');
  for (const field of [
    'interface MaterialBuildOpt', 'storeFile: string', 'storePassword: string', 'keyAlias: string',
    'keyPassword: string', 'signAlg: string', 'profile: string', 'certpath: string',
    'interface SigningConfigBuildOpt', 'interface ProductBuildOpt', 'signingConfig?: string',
  ]) require(declarations.includes(field), `Installed Hvigor 5.8.9 profile schema is missing ${field}.`);
  return { hvigorVersion: hvigorPackage.version, pluginVersion: pluginPackage.version, schemaPath: declarationPath };
}

async function verifyToolchain({ toolRoot, javaHome }) {
  const nodeHome = path.join(toolRoot, 'tool/node');
  const nodeExe = path.join(nodeHome, 'node.exe');
  const hvigorJs = path.join(toolRoot, 'hvigor/hvigor/bin/hvigor.js');
  const sdkHome = path.join(toolRoot, 'sdk');
  const javaExe = path.join(javaHome, 'bin/java.exe');
  for (const [file, label] of [[nodeExe, 'Bundled Harmony Node'], [hvigorJs, 'Hvigor CLI'], [javaExe, 'JDK Java']]) {
    require((await stat(file).catch(() => null))?.isFile(), `${label} is missing.`);
  }
  require((await stat(sdkHome).catch(() => null))?.isDirectory(), 'Harmony SDK directory is missing.');
  const nodeVersion = spawnSync(nodeExe, ['--version'], { encoding: 'utf8', timeout: 10000 });
  require(nodeVersion.status === 0 && /^v18\./.test(nodeVersion.stdout.trim()), 'Bundled Harmony Node must be version 18.');
  const javaRelease = await readFile(path.join(javaHome, 'release'), 'utf8');
  require(/JAVA_VERSION="21\./.test(javaRelease), 'Harmony release JDK must be version 21.');
  return { nodeExe, hvigorJs, sdkHome, nodeHome, javaExe, nodeVersion: nodeVersion.stdout.trim() };
}

async function stageProject({ sourceProjectRoot, stagedProjectRoot, overlayPath, toolRoot }) {
  await cp(sourceProjectRoot, stagedProjectRoot, {
    recursive: true,
    filter: (source) => !path.relative(sourceProjectRoot, source).split(path.sep)
      .some((part) => ['node_modules', '.hvigor', 'build'].includes(part)),
  });
  await copyFile(overlayPath, path.join(stagedProjectRoot, 'build-profile.json5'));
  const ohosRoot = path.join(stagedProjectRoot, 'node_modules/@ohos');
  await mkdir(ohosRoot, { recursive: true });
  const { symlink } = await import('node:fs/promises');
  await Promise.all([
    symlink(path.join(toolRoot, 'hvigor/hvigor'), path.join(ohosRoot, 'hvigor'), 'junction'),
    symlink(path.join(toolRoot, 'hvigor/hvigor-ohos-plugin'), path.join(ohosRoot, 'hvigor-ohos-plugin'), 'junction'),
  ]);
}

export function validateHarmonyBuildMetadata(metadata, outputNames) {
  const records = [];
  const visit = (value) => {
    if (Array.isArray(value)) { for (const entry of value) visit(entry); return; }
    if (!value || typeof value !== 'object') return;
    if (Object.hasOwn(value, 'hapName') || Object.hasOwn(value, 'isSigned')) records.push(value);
    for (const nested of Object.values(value)) visit(nested);
  };
  visit(metadata);
  const hapRecords = records.filter((record) => typeof record.hapName === 'string');
  const signed = hapRecords.filter((record) => record.isSigned === true);
  const unsignedMetadataCandidates = hapRecords.filter((record) => /-unsigned\.hap$/i.test(record.hapName));
  require(unsignedMetadataCandidates.length === 0, 'output_metadata.json marks an unsigned HAP as a candidate; refusing release acceptance.');
  const signedNames = outputNames.filter((name) => /-signed\.hap$/i.test(name));
  require(signedNames.length === 1, 'Release build must produce exactly one *-signed.hap and no ambiguous signed outputs.');
  require(records.length === 1 && hapRecords.length === 1 && signed.length === 1,
    'output_metadata.json must contain exactly one HAP record and it must declare isSigned: true.');
  require(hapRecords[0].hapName === signedNames[0], 'Signed HAP filename does not exactly match output_metadata.json.');
  return signedNames[0];
}

export function invokeStaticVerifier({ hapPath, javaExe, hapSignTool, root = repositoryRoot, verifierPath = path.join(mobileRoot, 'tools/verify-release-artifacts.py'), run = spawnSync }) {
  const result = run('python', [verifierPath, '--root', root, '--harmony-hap', hapPath, '--java', javaExe, '--hap-sign-tool', hapSignTool], {
    cwd: root, encoding: 'utf8', timeout: 180000,
  });
  let report;
  try { report = JSON.parse(result.stdout || '{}'); } catch { report = null; }
  const artifact = report?.artifacts?.harmony;
  require(result.status === 0 && artifact?.status === 'PASS_SIGNED_RELEASE_HAP_STATIC',
    'Official release artifact verification did not return PASS_SIGNED_RELEASE_HAP_STATIC.');
  return artifact;
}

export async function prepareHarmonyReleaseBuild({
  artifactDirectory,
  sourceProjectRoot = path.join(mobileRoot, 'harmony'),
  identityPath = path.join(mobileRoot, 'config/release-identity-candidate.json'),
  signingConfigPath = DEFAULT_HARMONY_SIGNING_FILE,
  overlayPath,
  toolRoot = path.join(mobileRoot, 'local_artifacts/harmony-native-20261022-01/tools/command-line-tools'),
  javaHome = path.join(mobileRoot, 'local_artifacts/native-build-20261022-parent01/temurin21/jdk-21.0.12.1+1'),
  env = process.env,
} = {}) {
  require(typeof artifactDirectory === 'string' && path.isAbsolute(artifactDirectory), 'Artifact directory must be an absolute path.');
  const localArtifacts = path.join(mobileRoot, 'local_artifacts');
  const normalizedArtifacts = await validateArtifactDirectoryPath(artifactDirectory, localArtifacts);
  require(!(await stat(normalizedArtifacts).catch(() => null)), 'Harmony release artifact directory already exists.');

  const identityBytes = await readFile(identityPath);
  const identity = readJson(identityBytes.toString('utf8'), 'Release identity');
  validateFrozenIdentity(identity);
  const appConfig = readJson(await readFile(path.join(sourceProjectRoot, 'AppScope/app.json5'), 'utf8'), 'Harmony AppScope app config');
  require(appConfig.app?.bundleName === identity.harmony.bundleName
    && appConfig.app?.versionCode === identity.harmony.versionCode
    && appConfig.app?.versionName === identity.harmony.versionName,
  'Frozen Harmony identity differs from AppScope/app.json5.');

  const tool = await verifyToolchain({ toolRoot, javaHome });
  const schema = await verifyInstalledSchema({ sourceProjectRoot, toolRoot });
  const loaded = await readHarmonySigningMaterial({ configPath: signingConfigPath, env });
  require(loaded.ok, loaded.missing?.length
    ? `Harmony signing material is missing: ${loaded.missing.join(', ')}.`
    : `Harmony signing material is invalid: ${loaded.invalid?.join(', ') || 'configuration'}.`);

  const outputProfile = overlayPath ? path.resolve(overlayPath) : path.join(normalizedArtifacts, 'harmony-build-profile.generated.json5');
  require(within(outputProfile, normalizedArtifacts), 'Harmony overlay must be generated inside the new isolated artifact directory.');
  await mkdir(normalizedArtifacts);
  try {
    const overlay = await prepareHarmonyReleaseSigningOverlay({
      configPath: signingConfigPath, outputPath: outputProfile,
      baseProfilePath: path.join(sourceProjectRoot, 'build-profile.json5'), env,
    });
    require(overlay.ok, overlay.missing?.length
      ? `Harmony signing material is missing: ${overlay.missing.join(', ')}.`
      : `Harmony signing material is invalid: ${overlay.invalid?.join(', ') || 'configuration'}.`);
    const overlayBytes = await readFile(overlay.outputPath);
    const overlayProfile = readJson(overlayBytes.toString('utf8'), 'Generated Harmony signing overlay');
    validateHarmonyProfile(overlayProfile, loaded.material);

    const stagedProjectRoot = path.join(normalizedArtifacts, 'isolated-project');
    await stageProject({ sourceProjectRoot, stagedProjectRoot, overlayPath: overlay.outputPath, toolRoot });
    const stagedProfileBytes = await readFile(path.join(stagedProjectRoot, 'build-profile.json5'));
    require(sha256(stagedProfileBytes) === sha256(overlayBytes), 'Isolated Hvigor project did not consume the generated release overlay.');
    const trackedProfileBytes = await readFile(path.join(sourceProjectRoot, 'build-profile.json5'));

    const args = [tool.hvigorJs, 'assembleHap', '--mode', 'module', '-p', 'module=entry@default', '-p', 'buildMode=release', '--no-incremental', '--no-daemon'];
    const home = path.join(normalizedArtifacts, 'isolated-user-home');
    const hvigorHome = path.join(normalizedArtifacts, 'isolated-hvigor-home');
    await mkdir(home);
    await mkdir(hvigorHome);
    const environment = {
      ...Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('LIFELINE_HARMONY_'))),
      DEVECO_NODE_HOME: tool.nodeHome,
      NODE_HOME: tool.nodeHome,
      DEVECO_SDK_HOME: tool.sdkHome,
      JAVA_HOME: javaHome,
      NODE_PATH: path.join(path.dirname(path.dirname(toolRoot)), 'node_modules'),
      HOME: home,
      USERPROFILE: home,
      HVIGOR_USER_HOME: hvigorHome,
      npm_config_userconfig: path.join(home, '.npmrc'),
      npm_config_offline: 'true',
      PATH: [path.join(javaHome, 'bin'), tool.nodeHome, env.PATH || ''].join(path.delimiter),
    };
    const plan = {
      schema: 'lifeline-harmony-release-build-plan-v1', status: 'READY_TO_RUN_SIGNED_RELEASE_BUILD',
      identitySha256: sha256(identityBytes),
      sourceProfileSha256: sha256(trackedProfileBytes), overlayPrepared: true,
      schemaToolchain: schema, stagedProjectRoot, outputDirectory: normalizedArtifacts, signingOverlayPath: outputProfile,
      command: { executable: tool.nodeExe, args, cwd: stagedProjectRoot },
      trackedProfileUnchanged: sha256(trackedProfileBytes) === sha256(await readFile(path.join(sourceProjectRoot, 'build-profile.json5'))),
    };
    require(plan.trackedProfileUnchanged, 'Tracked Harmony build profile changed while staging the release project.');
    await writeFile(path.join(normalizedArtifacts, 'release-build-plan.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
    return { plan, environment, identity, identityBytes, signingMaterial: loaded.material, tool };
  } catch (error) {
    await rm(normalizedArtifacts, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyHarmonyReleaseOverlay({ overlayPath, signingConfigPath, env = process.env } = {}) {
  const loaded = await readHarmonySigningMaterial({ configPath: signingConfigPath, env });
  require(loaded.ok, loaded.missing?.length
    ? `Harmony signing material is missing: ${loaded.missing.join(', ')}.`
    : `Harmony signing material is invalid: ${loaded.invalid?.join(', ') || 'configuration'}.`);
  const overlay = readJson(await readFile(overlayPath, 'utf8'), 'Generated Harmony signing overlay');
  validateHarmonyProfile(overlay, loaded.material);
  return true;
}

export async function verifyHarmonyReleaseOutput({ outputRoot, metadataPath = path.join(outputRoot, 'output_metadata.json'), identity, javaExe, hapSignTool, verifier } = {}) {
  const metadata = readJson(await readFile(metadataPath, 'utf8'), 'Hvigor output_metadata.json');
  const outputs = (await readdir(outputRoot, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name);
  const signedName = validateHarmonyBuildMetadata(metadata, outputs);
  const hapPath = path.join(outputRoot, signedName);
  require((await stat(hapPath).catch(() => null))?.isFile(), 'Hvigor metadata signed HAP is missing.');
  const artifact = verifier
    ? verifier(hapPath, { identity, javaExe, hapSignTool })
    : invokeStaticVerifier({ hapPath, javaExe, hapSignTool });
  require(artifact?.status === 'PASS_SIGNED_RELEASE_HAP_STATIC',
    'Official release artifact verification did not return PASS_SIGNED_RELEASE_HAP_STATIC.');
  require(artifact.certificateChainSha256 === identity.releaseCertificateFingerprints.harmonyCertChainSha256,
    'Verified Harmony certificate-chain fingerprint differs from frozen release identity.');
  return { hapPath, artifact };
}

export function redactSecrets(text, material) {
  let safe = String(text || '');
  for (const value of Object.values(material)) {
    if (value) safe = safe.split(value).join('[REDACTED]');
  }
  return safe;
}

export async function cleanupHarmonyReleaseBuild(prepared) {
  if (!prepared?.plan) return;
  const paths = [
    prepared.plan.signingOverlayPath,
    prepared.plan.stagedProjectRoot,
    path.join(prepared.plan.outputDirectory, 'isolated-user-home'),
    path.join(prepared.plan.outputDirectory, 'isolated-hvigor-home'),
  ];
  const results = await Promise.allSettled(paths.map((target, index) => rm(target, { recursive: index !== 0, force: true })));
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length) throw new Error(`Unable to remove ${failures.length} Harmony signing temporary path(s).`);
}

function parseArgs(args) {
  const options = new Map();
  let prepareOnly = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--prepare-only') { prepareOnly = true; continue; }
    if (!['--artifact-directory', '--identity-config', '--signing-config', '--tool-root', '--java-home'].includes(arg) || !args[index + 1]) {
      throw new Error('Usage: build-harmony-release.mjs --artifact-directory ABSOLUTE_PATH [--prepare-only] [--identity-config PATH] [--signing-config PATH] [--tool-root PATH] [--java-home PATH]');
    }
    options.set(arg, args[++index]);
  }
  return { options, prepareOnly };
}

async function main() {
  const { options, prepareOnly } = parseArgs(process.argv.slice(2));
  const trackedProfileBefore = await readFile(path.join(mobileRoot, 'harmony/build-profile.json5'));
  let prepared;
  let receipt = null;
  try {
    prepared = await prepareHarmonyReleaseBuild({
      artifactDirectory: options.get('--artifact-directory'),
      identityPath: options.get('--identity-config') || path.join(mobileRoot, 'config/release-identity-candidate.json'),
      signingConfigPath: options.get('--signing-config') || DEFAULT_HARMONY_SIGNING_FILE,
      toolRoot: options.get('--tool-root') || path.join(mobileRoot, 'local_artifacts/harmony-native-20261022-01/tools/command-line-tools'),
      javaHome: options.get('--java-home') || path.join(mobileRoot, 'local_artifacts/native-build-20261022-parent01/temurin21/jdk-21.0.12.1+1'),
    });
    if (!prepareOnly) {
      const buildLog = path.join(prepared.plan.outputDirectory, 'harmony-release-build.log');
      const result = spawnSync(prepared.plan.command.executable, prepared.plan.command.args, {
        cwd: prepared.plan.command.cwd, env: prepared.environment, encoding: 'utf8', timeout: 30 * 60 * 1000,
      });
      const log = redactSecrets(`${result.stdout || ''}${result.stderr || ''}`, prepared.signingMaterial);
      assertNoSigningMaterial(log, prepared.signingMaterial);
      await writeFile(buildLog, log, { encoding: 'utf8', flag: 'wx' });
      require(result.status === 0 && log.includes('BUILD SUCCESSFUL'), `Harmony release Hvigor build failed; inspect ${buildLog}.`);
      const outputRoot = path.join(prepared.plan.stagedProjectRoot, 'entry/build/default/outputs/default');
      const metadataPath = path.join(prepared.plan.stagedProjectRoot, 'entry/build/default/intermediates/hap_metadata/default/output_metadata.json');
      const trackedIdentityBytes = await readFile(path.join(repositoryRoot, 'mobile/config/release-identity-candidate.json'));
      require(sha256(trackedIdentityBytes) === prepared.plan.identitySha256, 'Verifier root release identity differs from the frozen build identity.');
      const { hapPath: builtHap, artifact: verified } = await verifyHarmonyReleaseOutput({
        outputRoot, metadataPath, identity: prepared.identity, javaExe: prepared.tool.javaExe,
        hapSignTool: path.join(prepared.tool.sdkHome, 'default/openharmony/toolchains/lib/hap-sign-tool.jar'),
      });
      const finalHap = path.join(prepared.plan.outputDirectory, path.basename(builtHap));
      require(!(await stat(finalHap).catch(() => null)), 'Refusing to overwrite an existing release HAP.');
      await copyFile(builtHap, finalHap, fsConstants.COPYFILE_EXCL);
      const hapBytes = await readFile(finalHap);
      const copiedHash = sha256(hapBytes);
      require(copiedHash === verified.sha256, 'Copied signed HAP hash differs from the independently verified build output.');
      receipt = {
        schema: 'lifeline-harmony-release-build-receipt-v1', status: 'PASS_LOCAL_SIGNED_HAP_BUILD',
        identitySha256: prepared.plan.identitySha256,
        buildLog: path.basename(buildLog), signedHap: { path: path.basename(finalHap), bytes: hapBytes.length, sha256: copiedHash },
        staticVerification: { status: verified.status, certificateChainSha256: verified.certificateChainSha256 },
        deviceAcceptance: false, storeAcceptance: false,
      };
    }
  } finally {
    try {
      if (prepared) {
        await cleanupHarmonyReleaseBuild(prepared);
        prepared.plan.status = prepareOnly ? 'PREFLIGHT_PASSED_CLEANED' : (receipt ? 'BUILD_VERIFIED_AND_CLEANED' : 'BUILD_NOT_ACCEPTED_CLEANED');
        prepared.plan.command = null;
        prepared.plan.stagedProjectRoot = null;
        prepared.plan.signingOverlayPath = null;
        const planText = `${JSON.stringify(prepared.plan, null, 2)}\n`;
        assertNoSigningMaterial(planText, prepared.signingMaterial);
        await writeFile(path.join(prepared.plan.outputDirectory, 'release-build-plan.json'), planText, { encoding: 'utf8', flag: 'w' });
      }
    } finally {
      const trackedProfileAfter = await readFile(path.join(mobileRoot, 'harmony/build-profile.json5'));
      require(sha256(trackedProfileAfter) === sha256(trackedProfileBefore), 'Tracked Harmony build profile changed during the release-build entry.');
    }
  }
  if (prepareOnly) {
    console.log(JSON.stringify({ status: 'PREFLIGHT_PASSED_CLEANED', planPath: path.join(prepared.plan.outputDirectory, 'release-build-plan.json') }));
    return;
  }
  const receiptText = `${JSON.stringify(receipt, null, 2)}\n`;
  assertNoSigningMaterial(receiptText, prepared.signingMaterial);
  await writeFile(path.join(prepared.plan.outputDirectory, 'harmony-release-build-receipt.json'), receiptText, { encoding: 'utf8', flag: 'wx' });
  console.log(JSON.stringify({ status: receipt.status, hap: receipt.signedHap }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Harmony release build BLOCKED: ${error.message}`);
    process.exitCode = 1;
  });
}
