import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { buildGame } from './build.mjs';
import { CONFIG_KEYS, readClientConfig, validateClientConfig, requireProfile } from './client-config.mjs';
import { BASE_RUNTIME_FILES, RUNTIME_FILES, PACKAGE_FILES, PACKAGE_DIRECTORIES, MODEL_PACKAGES,
  LEGACY_MODEL_PACKAGE_FILES, LEGACY_MODEL_PACKAGE_DIRECTORIES,
  MAIN_BUDGET, SUBPACKAGE_BUDGET, TOTAL_BUDGET } from './model-packaging.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(projectRoot, '../..');
const runtimeFiles = RUNTIME_FILES;
const packageFiles = PACKAGE_FILES;
const configKeys = CONFIG_KEYS;
const digest = data => createHash('sha256').update(data).digest('hex');
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const slash = value => value.split(path.sep).join('/');
const requireCondition = (condition, message) => { if (!condition) throw new Error(message); };

async function regularFile(root, relative) {
  requireCondition(typeof relative === 'string' && relative.length > 0 &&
    !relative.includes('\\') && !path.isAbsolute(relative) &&
    relative.split('/').every(part => part && part !== '.' && part !== '..'), `Unsafe file path: ${relative}`);
  let current = root;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const stat = await fs.lstat(current);
    requireCondition(!stat.isSymbolicLink() && (i === parts.length - 1 ? stat.isFile() : stat.isDirectory()),
      `Expected ordinary file/directory without links: ${relative}`);
  }
  return fs.readFile(current);
}

async function inventory(directory, allowedFiles, allowedDirectories) {
  const found = [];
  async function walk(relative = '') {
    for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        requireCondition(allowedDirectories.includes(name), `Unexpected package directory: ${name}`);
        await walk(name);
      } else {
        requireCondition(entry.isFile() && allowedFiles.includes(name), `Unexpected package file or link: ${name}`);
        const data = await regularFile(directory, name);
        found.push({ path: name, bytes: data.length, sha256: digest(data) });
      }
    }
  }
  await walk();
  found.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  requireCondition(found.length === allowedFiles.length, 'Missing package file');
  return found;
}

// A build receipt alone is insufficient: compare its outputs and every recorded
// input to disk, then rebuild in a new directory before offering the candidate.
export async function inspectProject(root = projectRoot, repo = repoRoot, {
  dist = path.join(root, 'dist'), config: override, profile = 'offline',
} = {}) {
  const project = await json(path.join(root, 'project.config.json'));
  requireCondition(project.compileType === 'game' && project.miniprogramRoot === 'dist/' &&
    !Object.hasOwn(project, 'minigameRoot'), 'Project must select miniprogramRoot=dist/ and compileType=game');
  requireCondition(/^wx[0-9a-f]{16}$/.test(project.appid) && project.isGameTourist === false,
    'A configured non-tourist AppID is required; this does not prove account permissions');
  requireCondition(/^\d+\.\d+\.\d+$/.test(project.libVersion), 'Pin the previously verified base library version');
  requireCondition(project.setting?.urlCheck === true, 'Keep domain checking enabled');
  const { config, localConfig } = override === undefined ? await readClientConfig(root)
    : { config: validateClientConfig(override), localConfig: false };
  requireProfile(config, profile);
  const files = await inventory(dist, packageFiles, PACKAGE_DIRECTORIES);
  const manifest = await json(path.join(dist, 'build-manifest.json'));
  requireCondition(manifest.schemaVersion === 2 && manifest.rulesVersion === 'territory-v3', 'Unsupported build manifest');
  requireCondition(configKeys.every(key => manifest.config?.[key] === config[key]) &&
    Object.keys(manifest.config).length === configKeys.length, 'Build configuration is stale');
  requireCondition(Array.isArray(manifest.outputs) && manifest.outputs.length === runtimeFiles.length &&
    new Set(manifest.outputs.map(item => item.path)).size === runtimeFiles.length, 'Invalid output manifest');
  for (const entry of manifest.outputs) {
    const actual = files.find(item => item.path === entry.path);
    requireCondition(runtimeFiles.includes(entry.path) && actual?.sha256 === entry.sha256 && actual?.bytes === entry.bytes,
      `Stale or modified output: ${entry.path}`);
  }
  requireCondition(manifest.runtimeBytes === files.filter(item => item.path !== 'build-manifest.json').reduce((sum, item) => sum + item.bytes, 0) &&
    manifest.totalBytes === files.reduce((sum, item) => sum + item.bytes, 0) && manifest.totalBytes <= TOTAL_BUDGET &&
    manifest.mainPackageBytes === files.filter(item => !item.path.startsWith('models/')).reduce((sum, item) => sum + item.bytes, 0) &&
    manifest.mainPackageBytes <= MAIN_BUDGET,
  'Build size manifest mismatch or package budget exceeded');
  const subpackages = MODEL_PACKAGES.map(pack => ({ ...pack,
    bytes: files.filter(item => item.path.startsWith(`${pack.root}/`)).reduce((sum, item) => sum + item.bytes, 0) }));
  requireCondition(JSON.stringify(manifest.subpackages) === JSON.stringify(subpackages) &&
    subpackages.every(pack => pack.bytes <= SUBPACKAGE_BUDGET), 'Subpackage manifest mismatch or budget exceeded');
  const sources = manifest.sourceHashes;
  requireCondition(sources && Object.keys(sources).length > 0, 'Missing source hashes');
  const inputHashes = {};
  for (const [relative, expected] of Object.entries(sources)) {
    const actual = digest(await regularFile(repo, relative));
    requireCondition(actual === expected, `Stale source: ${relative}`);
    inputHashes[relative] = actual;
  }
  for (const name of ['game.json', 'THIRD_PARTY_NOTICES.txt']) {
    requireCondition(digest(await regularFile(root, name)) === files.find(item => item.path === name).sha256,
      `Stale copied input: ${name}`);
  }
  const game = await json(path.join(dist, 'game.json'));
  requireCondition(game.workers === 'workers', 'Worker directory must be workers');
  requireCondition(JSON.stringify(game.subpackages) === JSON.stringify(MODEL_PACKAGES), 'Model subpackage configuration mismatch');
  for (const name of ['game.json', 'project.config.json', 'config.example.json', 'package.json', 'package-lock.json',
    'tools/build.mjs', 'tools/client-config.mjs', 'tools/prepare-candidate.mjs', 'tools/model-packaging.mjs', 'tools/stage-models.mjs', ...(localConfig ? ['config.local.json'] : [])]) {
    const relative = slash(path.relative(repo, path.join(root, name)));
    inputHashes[relative] = digest(await regularFile(repo, relative));
  }
  const version = (await json(path.join(root, 'package.json'))).version;
  requireCondition(/^\d+\.\d+\.\d+$/.test(version), 'Expected a numeric package version');
  return { project, version, manifest, files, inputHashes };
}

export async function verifyCandidate(directory) {
  const receipt = await json(path.join(directory, 'candidate.json'));
  requireCondition([1, 2, 3, 4].includes(receipt.schemaVersion) && receipt.status === 'PREPARED_LOCAL_NOT_UPLOADED', 'Unsupported candidate receipt');
  const packaged = receipt.schemaVersion === 1 ? [...BASE_RUNTIME_FILES, 'build-manifest.json']
    : receipt.schemaVersion === 2 ? LEGACY_MODEL_PACKAGE_FILES : packageFiles;
  const directories = receipt.schemaVersion === 1 ? ['workers']
    : receipt.schemaVersion === 2 ? LEGACY_MODEL_PACKAGE_DIRECTORIES : PACKAGE_DIRECTORIES;
  const expectedPaths = ['project.config.json', ...packaged.map(name => `dist/${name}`)];
  const files = await inventory(path.join(directory, 'project'), expectedPaths, ['dist', ...directories.map(name => `dist/${name}`)]);
  requireCondition(JSON.stringify(files) === JSON.stringify(receipt.files), 'Candidate files differ from the frozen receipt');
  const manifest = await json(path.join(directory, 'project/dist/build-manifest.json'));
  requireCondition(configKeys.every(key => manifest.config?.[key] === receipt.config?.[key]) &&
    Object.keys(manifest.config || {}).length === configKeys.length, 'Candidate configuration differs from bundled build manifest');
  const project = await json(path.join(directory, 'project/project.config.json'));
  requireCondition(project.compileType === 'game' && project.miniprogramRoot === 'dist/' &&
    !Object.hasOwn(project, 'minigameRoot') && project.isGameTourist === false &&
    /^wx[0-9a-f]{16}$/.test(project.appid) && project.setting?.urlCheck === true &&
    /^\d+\.\d+\.\d+$/.test(project.libVersion) && project.libVersion === receipt.baseLibrary &&
    /^\d+\.\d+\.\d+$/.test(receipt.version), 'Candidate project configuration mismatch');
  // Old schemas only ever produced offline candidates. Changing their receipt
  // cannot opt an old offline bundle into an online transfer.
  if (receipt.schemaVersion < 4) {
    requireCondition(receipt.config?.onlineEnabled === false && receipt.config.apiBase === '', 'Legacy candidate must remain offline');
    return receipt;
  }
  const config = validateClientConfig(receipt.config);
  requireProfile(config, receipt.profile);
  requireCondition(configKeys.every(key => manifest.config?.[key] === config[key] && receipt.config[key] === config[key]) &&
    Object.keys(manifest.config).length === configKeys.length, 'Candidate configuration differs from bundled build manifest');
  const outputs = files.filter(item => item.path.startsWith('dist/') && item.path !== 'dist/build-manifest.json')
    .map(item => ({ ...item, path: item.path.slice(5) }));
  requireCondition(manifest.schemaVersion === 2 && manifest.rulesVersion === receipt.rulesVersion &&
    ['territory-v2', 'territory-v3'].includes(receipt.rulesVersion) && Array.isArray(manifest.outputs) &&
    manifest.outputs.length === outputs.length &&
    new Set(manifest.outputs.map(item => item.path)).size === outputs.length &&
    manifest.outputs.every(item => outputs.some(actual => item.path === actual.path &&
      item.sha256 === actual.sha256 && item.bytes === actual.bytes)), 'Candidate runtime manifest mismatch');
  const total = files.filter(item => item.path.startsWith('dist/')).reduce((sum, item) => sum + item.bytes, 0);
  const main = files.filter(item => item.path.startsWith('dist/') && !item.path.startsWith('dist/models/')).reduce((sum, item) => sum + item.bytes, 0);
  const runtime = outputs.reduce((sum, item) => sum + item.bytes, 0);
  const subpackages = MODEL_PACKAGES.map(pack => ({ ...pack,
    bytes: outputs.filter(item => item.path.startsWith(`${pack.root}/`)).reduce((sum, item) => sum + item.bytes, 0) }));
  requireCondition(receipt.packageBytes === total && manifest.totalBytes === total && total <= TOTAL_BUDGET &&
    receipt.mainPackageBytes === main && manifest.mainPackageBytes === main && main <= MAIN_BUDGET &&
    receipt.runtimeBytes === runtime && manifest.runtimeBytes === runtime &&
    JSON.stringify(receipt.subpackages) === JSON.stringify(subpackages) &&
    JSON.stringify(manifest.subpackages) === JSON.stringify(subpackages) &&
    subpackages.every(pack => pack.bytes <= SUBPACKAGE_BUDGET), 'Candidate package sizes mismatch');
  return receipt;
}

export async function prepareCandidate({
  outputBase = path.join(repoRoot, 'local_artifacts/wechat-candidates'), online = false, apiBase,
} = {}) {
  requireCondition(typeof online === 'boolean' && (online || apiBase === undefined),
    'apiBase requires the explicit online entry');
  const profile = online ? 'online' : 'offline';
  let options = {};
  if (online) {
    // An explicit origin is required even if a developer has a local config.
    // The online recipe never overwrites that config or the tested offline dist.
    const config = validateClientConfig({
      ...(await json(path.join(projectRoot, 'config.example.json'))), onlineEnabled: true, apiBase,
    });
    requireProfile(config, profile);
    await fs.mkdir(outputBase, { recursive: true });
    const firstBuild = await fs.mkdtemp(path.join(outputBase, 'online-rebuild-'));
    const dist = path.join(firstBuild, 'dist');
    await buildGame(dist, { config });
    options = { dist, config, profile };
  }
  const before = await inspectProject(projectRoot, repoRoot, options);
  await fs.mkdir(outputBase, { recursive: true });
  const id = before.files.find(item => item.path === 'build-manifest.json').sha256.slice(0, 12);
  const directory = await fs.mkdtemp(path.join(outputBase, `${before.version}-${id}-`));
  const importDirectory = path.join(directory, 'project');
  // Rebuild into the fresh candidate only. Never replace the owner's existing dist.
  await buildGame(path.join(importDirectory, 'dist'), { config: before.manifest.config });
  const rebuilt = await inventory(path.join(importDirectory, 'dist'), packageFiles, PACKAGE_DIRECTORIES);
  requireCondition(JSON.stringify(rebuilt) === JSON.stringify(before.files),
    `Fresh build differs from existing dist; candidate is incomplete: ${directory}`);
  const after = await inspectProject(projectRoot, repoRoot, options);
  requireCondition(JSON.stringify(before) === JSON.stringify(after), 'Inputs changed while preparing the candidate');
  // Only public, relevant project settings enter the import directory. Tool-local
  // editor settings and project.private.config.json are deliberately not copied.
  const project = {
    description: 'LIFELINE 核心体验候选', projectname: 'lifeline-wechat', compileType: 'game', miniprogramRoot: 'dist/',
    appid: before.project.appid, libVersion: before.project.libVersion,
    setting: { es6: false, minified: false, urlCheck: true, postcss: false, enhance: false },
    packOptions: { ignore: [], include: [] }, isGameTourist: false,
  };
  await fs.writeFile(path.join(importDirectory, 'project.config.json'), `${JSON.stringify(project, null, 2)}\n`, { flag: 'wx' });
  const files = await inventory(importDirectory, ['project.config.json', ...packageFiles.map(name => `dist/${name}`)], ['dist', ...PACKAGE_DIRECTORIES.map(name => `dist/${name}`)]);
  const receipt = {
    schemaVersion: 4, profile, status: 'PREPARED_LOCAL_NOT_UPLOADED', createdAt: new Date().toISOString(),
    candidateId: path.basename(directory), version: before.version, rulesVersion: before.manifest.rulesVersion,
    baseLibrary: project.libVersion, config: before.manifest.config,
    runtimeBytes: before.manifest.runtimeBytes, packageBytes: before.manifest.totalBytes,
    mainPackageBytes: before.manifest.mainPackageBytes, subpackages: before.manifest.subpackages,
    importDirectory: 'project', files, sourceHashes: before.inputHashes,
    reproducibility: 'Fresh isolated rebuild matches every existing dist file, including 17 verified model assets, byte for byte; test evidence is bound separately',
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    uploadDescription: online
      ? '同步最新防守、主动切断和PASS修复；原生Worker新增唯一终局获胜跳过预检。保留V3领土、四舱、头像、起点标记、悔棋复盘和好友联机；未做本版真机验收。'
      : '新版领土将未闭合的己方节点和线点计分；加强各玩家初始点标记，保留四舱、29项兼容AI、悔棋、复盘和100份棋谱。本包关闭联机，可免登录体验；未做本版真机验收。',
    acceptance: { nativeCandidateImport: 'NOT_RUN', physicalDevice: 'NOT_RUN',
      accountPermissions: 'NOT_VERIFIED', serviceConnectivity: 'NOT_VERIFIED',
      actualWechatLogin: 'NOT_RUN', crossPlatformDeviceMatch: 'NOT_RUN',
      upload: 'NOT_RUN', publication: 'NOT_RUN' },
  };
  await fs.writeFile(path.join(directory, 'candidate.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  await fs.writeFile(path.join(directory, '导入说明.txt'),
    `LIFELINE 核心体验候选 ${receipt.version}\n\n微信开发者工具选择“小游戏”，导入本文件旁的 project 文件夹。\n` +
    `工程已配置现有 AppID 和基础库 ${receipt.baseLibrary}；AppSecret 只能在服务器配置，不能放入小游戏包。\n` +
    (online ? `联机服务地址：${receipt.config.apiBase}。请配置对应的 request/socket 合法域名；生成候选没有验证服务或微信登录。\n`
      : '当前为离线候选，不需要配置联机服务即可玩本地对局。\n') +
    `版本号：${receipt.version}\n版本说明：${receipt.uploadDescription}\n\n` +
    '当前只生成本地候选，未上传、提审或发布；账号上传/体验权限仍需核对。\n' +
    '包内文件已与生成时的工程输出逐字节核对；测试依据见项目验收记录。这个独立目录尚未在微信工具或手机上重新验证。\n' +
    '请勿把本地存档、账号材料或密钥放入 project/dist。\n', { flag: 'wx' });
  await verifyCandidate(directory);
  return { directory, importDirectory, receipt };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ strict: true, options: {
      verify: { type: 'string' }, online: { type: 'boolean', default: false }, 'api-base': { type: 'string' },
    } });
    if (values.verify !== undefined) {
      requireCondition(values.verify.trim().length > 0, 'Verify requires a non-empty candidate directory');
      requireCondition(!values.online && values['api-base'] === undefined, 'Verify cannot be combined with build options');
      const receipt = await verifyCandidate(path.resolve(values.verify));
      console.log(JSON.stringify({ status: 'PASS_CANDIDATE_FILES', candidateId: receipt.candidateId, files: receipt.files.length }, null, 2));
    } else {
      const result = await prepareCandidate({ online: values.online, apiBase: values['api-base'] });
      console.log(JSON.stringify({ status: result.receipt.status, version: result.receipt.version,
        directory: result.directory, importDirectory: result.importDirectory,
        packageBytes: result.receipt.packageBytes, files: result.receipt.files.length }, null, 2));
    }
  } catch (error) {
    console.error(`Candidate preparation stopped: ${error.message}`);
    process.exitCode = 1;
  }
}
