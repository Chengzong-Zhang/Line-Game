import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { verifyCandidate } from '../minigame/tools/prepare-candidate.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const requireCondition = (value, code) => { if (!value) throw Object.assign(new Error(code), { code }); };
const digest = data => createHash('sha256').update(data).digest('hex');
const within = (parent, file) => {
  const relative = path.relative(parent, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
const safeCode = error => {
  const code = error?.errCode ?? error?.code;
  return (typeof code === 'number' && Number.isFinite(code)) ||
    (typeof code === 'string' && /^[A-Z0-9_-]{1,80}$/.test(code)) ? code : 'SDK_ERROR_DETAILS_OMITTED';
};
const writeReceipt = async (directory, receipt) => {
  const temporary = path.join(directory, 'receipt.pending.json');
  await fs.writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`);
  await fs.rename(temporary, path.join(directory, 'receipt.json'));
};

export async function planTransfer({ candidateDirectory, action = 'plan', robot = 1, online = false }) {
  requireCondition(['plan', 'preview', 'upload'].includes(action), 'INVALID_ACTION');
  requireCondition(Number.isInteger(robot) && robot >= 1 && robot <= 30, 'INVALID_ROBOT');
  requireCondition(typeof candidateDirectory === 'string' && candidateDirectory.length > 0, 'CANDIDATE_REQUIRED');
  const directory = path.resolve(candidateDirectory);
  const candidate = await verifyCandidate(directory);
  requireCondition(typeof online === 'boolean', 'INVALID_ONLINE_OPTION');
  requireCondition(/^\d+\.\d+\.\d+$/.test(candidate.version)
    && ['territory-v2', 'territory-v3'].includes(candidate.rulesVersion), 'INVALID_CANDIDATE');
  const profile = candidate.schemaVersion >= 4 ? candidate.profile : 'offline';
  // The candidate has already passed its frozen receipt and package checks.
  // Report the missing explicit transfer opt-in before rechecking the editor
  // project fields below, while still refusing any invalid candidate above.
  requireCondition(profile !== 'online' || online, 'ONLINE_TRANSFER_REQUIRES_EXPLICIT_FLAG');
  requireCondition(profile !== 'offline' || !online, 'ONLINE_FLAG_REQUIRES_ONLINE_CANDIDATE');
  const projectPath = path.join(directory, 'project');
  const project = JSON.parse(await fs.readFile(path.join(projectPath, 'project.config.json'), 'utf8'));
  requireCondition(project.compileType === 'game' && project.miniprogramRoot === 'dist/' &&
    project.isGameTourist === false && /^wx[0-9a-f]{16}$/.test(project.appid), 'INVALID_MINIGAME_PROJECT');
  requireCondition(project.setting?.urlCheck === true && project.libVersion === candidate.baseLibrary,
    'PROJECT_CONFIG_MISMATCH');
  requireCondition(typeof candidate.uploadDescription === 'string' && candidate.uploadDescription.length <= 200,
    'INVALID_VERSION_DESCRIPTION');
  return {
    status: 'PLAN_ONLY_NO_KEY_READ_NO_NETWORK', action, candidateDirectory: directory, projectPath,
    candidateId: candidate.candidateId, candidateReceiptSha256: digest(await fs.readFile(path.join(directory, 'candidate.json'))),
    appid: project.appid, type: 'miniGame', version: candidate.version,
    profile, apiBase: candidate.config.apiBase,
    serviceConnectivity: 'NOT_VERIFIED', actualWechatLogin: 'NOT_VERIFIED',
    description: candidate.uploadDescription, robot, baseLibrary: candidate.baseLibrary,
    packageBytes: candidate.packageBytes, files: candidate.files,
    prerequisites: ['Account code-upload key kept outside the repository',
      'Account IP allowlist permits this upload host', 'Explicit --execute for preview or upload'],
    afterUpload: 'Uploaded code is separate from selecting an experience version, adding testers, review and publication',
  };
}

export async function runTransfer(options, {
  loadSdk = () => import('miniprogram-ci'),
  outputBase = path.join(repo, 'local_artifacts/wechat-transfers'),
} = {}) {
  const plan = await planTransfer(options);
  // Planning does not inspect any key file or load the SDK, even if a key path
  // was provided. Network-capable code is only reachable with explicit execution.
  if (!options.execute || plan.action === 'plan') return plan;
  requireCondition(typeof options.privateKeyPath === 'string' && path.isAbsolute(options.privateKeyPath), 'ABSOLUTE_KEY_PATH_REQUIRED');
  const key = path.resolve(options.privateKeyPath);
  // WeChat's default download name identifies the account. Stop obvious account
  // mismatches before importing the SDK or making an external request.
  const namedAppId = /^private\.(wx[0-9a-f]{16})\.key$/i.exec(path.basename(key))?.[1]?.toLowerCase();
  requireCondition(!namedAppId || namedAppId === plan.appid, 'KEY_FILENAME_APPID_MISMATCH');
  const keyStat = await fs.lstat(key);
  requireCondition(keyStat.isFile() && !keyStat.isSymbolicLink(), 'KEY_MUST_BE_ORDINARY_FILE');
  const actualKey = await fs.realpath(key);
  requireCondition(!within(await fs.realpath(repo), actualKey) && !within(await fs.realpath(plan.candidateDirectory), actualKey),
    'KEEP_KEY_OUTSIDE_REPOSITORY_AND_CANDIDATE');
  requireCondition(keyStat.size > 0 && keyStat.size <= 65536, 'INVALID_KEY_FILE_SIZE');
  const module = await loadSdk();
  const ci = module.default || module;
  requireCondition(typeof ci.Project === 'function' && typeof ci[plan.action] === 'function', 'INVALID_CI_SDK');
  await fs.mkdir(outputBase, { recursive: true });
  const directory = await fs.mkdtemp(path.join(outputBase, `${plan.action}-${plan.version}-`));
  const projectPath = path.join(directory, 'project');
  // Upload from a fresh, hash-checked copy so SDK compiler files cannot alter the
  // candidate or accidentally pull in sources, keys, logs, or previous QR codes.
  for (const file of plan.files) {
    const data = await fs.readFile(path.join(plan.projectPath, file.path));
    requireCondition(data.length === file.bytes && digest(data) === file.sha256, 'CANDIDATE_CHANGED_BEFORE_TRANSFER');
    const target = path.join(projectPath, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data, { flag: 'wx' });
  }
  const receipt = {
    schemaVersion: 1, status: 'STARTING_EXTERNAL_REQUEST', action: plan.action,
    startedAt: new Date().toISOString(), candidateId: plan.candidateId,
    candidateReceiptSha256: plan.candidateReceiptSha256, version: plan.version, type: plan.type,
    robot: plan.robot, profile: plan.profile, apiBase: plan.apiBase,
    serviceConnectivity: 'NOT_VERIFIED', actualWechatLogin: 'NOT_VERIFIED',
    inputFiles: plan.files, sdkVersion: '2.1.31',
    experienceVersionConfigured: false, testersAdded: false, submittedForReview: false, published: false,
  };
  await writeReceipt(directory, receipt);
  try {
    const project = new ci.Project({ appid: plan.appid, type: 'miniGame', projectPath,
      privateKeyPath: key, ignores: ['node_modules/**/*', '**/*.key', '**/*.pem', '**/*.log'] });
    const settings = { es6: false, es7: false, minify: false, minifyJS: false, codeProtect: false, autoPrefixWXSS: false };
    const args = { project, desc: plan.description, robot: plan.robot, setting: settings, onProgressUpdate: () => {} };
    let result;
    if (plan.action === 'preview') {
      const qrPath = path.join(directory, 'preview-qr.jpg');
      result = await ci.preview({ ...args, qrcodeFormat: 'image', qrcodeOutputDest: qrPath });
      receipt.sdkResolved = true;
      const qr = await fs.readFile(qrPath);
      requireCondition(qr.length >= 8 && qr.length <= 2 * 1024 * 1024 &&
        (qr.subarray(0, 3).equals(Buffer.from([255, 216, 255])) || qr.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))),
        'PREVIEW_QR_MISSING_OR_INVALID');
      receipt.qr = { file: 'preview-qr.jpg', bytes: qr.length, sha256: digest(qr) };
      receipt.status = 'PREVIEW_GENERATED_NOT_DEVICE_VERIFIED';
    } else {
      result = await ci.upload({ ...args, version: plan.version, threads: 2 });
      receipt.sdkResolved = true;
      receipt.status = 'CODE_UPLOADED_EXPERIENCE_NOT_CONFIGURED';
    }
    receipt.packageInfo = Array.isArray(result?.subPackageInfo) ? result.subPackageInfo
      .filter(item => typeof item?.name === 'string' && /^[A-Za-z0-9_./-]{1,128}$/.test(item.name) &&
        Number.isSafeInteger(item.size) && item.size >= 0)
      .map(item => ({ name: item.name, size: item.size })) : [];
    receipt.finishedAt = new Date().toISOString();
    await writeReceipt(directory, receipt);
    return { ...receipt, directory };
  } catch (error) {
    receipt.status = receipt.sdkResolved ? 'SDK_COMPLETED_LOCAL_RESULT_INCOMPLETE' : 'TRANSFER_FAILED_OR_REMOTE_OUTCOME_UNCONFIRMED';
    receipt.errorCode = safeCode(error);
    receipt.finishedAt = new Date().toISOString();
    receipt.retryPolicy = 'No automatic retry; inspect the result and remote version state first';
    // Never serialize the SDK error/request object: it may contain credentials.
    await writeReceipt(directory, receipt);
    throw Object.assign(new Error('TRANSFER_NOT_CONFIRMED'), { code: receipt.errorCode, receiptDirectory: directory });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, strict: true,
      options: { candidate: { type: 'string' }, 'private-key': { type: 'string' },
        execute: { type: 'boolean', default: false }, online: { type: 'boolean', default: false },
        robot: { type: 'string', default: '1' } } });
    requireCondition(positionals.length <= 1, 'INVALID_ARGUMENTS');
    const result = await runTransfer({ action: positionals[0] || 'plan', candidateDirectory: values.candidate,
      privateKeyPath: values['private-key'], execute: values.execute, online: values.online, robot: Number(values.robot) });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: 'STOPPED_NO_AUTOMATIC_RETRY', errorCode: safeCode(error),
      ...(error.receiptDirectory ? { receiptDirectory: error.receiptDirectory } : {}) }, null, 2));
    process.exitCode = 1;
  }
}
