// One reviewed 0.12.15 candidate, one expected allowlisted exit, no retries.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { planTransfer, runTransfer } from './transfer.mjs';
import route from './isolated-proxy-route.cjs';

export const LOCKED_CANDIDATE_ID = '0.12.15-fdf84a01320f-1CYu03';
export const LOCKED_IP = '142.249.36.28';
export const LOCKED_CANDIDATE_RECEIPT_SHA256 = '7c85f914fdfcb93c7cf1895a7a3fe5448e89204069eb7e5d70a1d1da5df62613';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const check = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }); };
export async function isolatedProxyTransfer(options, { plan = planTransfer, transfer = runTransfer,
  withRoute = route.withIsolatedWechatRoute, loadSdk = () => import('miniprogram-ci') } = {}) {
  const operation = { ...options, action: 'upload' }, verified = await plan(operation);
  check(verified.version === '0.12.15' && verified.candidateId === LOCKED_CANDIDATE_ID
    && verified.candidateReceiptSha256 === LOCKED_CANDIDATE_RECEIPT_SHA256, 'ONLY_REVIEWED_01215_CANDIDATE_ALLOWED');
  if (!options.execute) return { status: 'PLAN_ONLY_NO_PROXY_NO_KEY_NO_UPLOAD', version: verified.version,
    candidateId: verified.candidateId, candidateReceiptSha256: verified.candidateReceiptSha256,
    expectedExitIp: LOCKED_IP, requiredOperatorAssertion: '--allowlisted-ip 142.249.36.28' };
  check(options.allowlistedIp === LOCKED_IP, 'EXPLICIT_ALLOWLISTED_IP_CONFIRMATION_REQUIRED');
  return withRoute({ clashDataDirectory: 'C:/Users/zcz/Documents/Clash.for.Windows-0.20.16.3-ikuuu/Clash.for.Windows-0.20.16-ikuuu/data',
    corePath: 'C:/Users/zcz/Documents/Clash.for.Windows-0.20.16.3-ikuuu/Clash.for.Windows-0.20.16-ikuuu/resources/static/files/win/x64/clash-win64.exe',
    outputDirectory: path.join(repo, 'local_artifacts/wechat-isolated-uploads'), expectedIp: LOCKED_IP,
    expectedNode: '🇺🇲 美国S01 | IEPL | x1.5', expectedCoreSha256: 'a6a3cbf11aee1664deab7fb26870e32400cfb086e09d1caa653363a5e0adfadf' }, async context => {
    const current = await plan(operation);
    check(current.candidateId === verified.candidateId && current.candidateReceiptSha256 === verified.candidateReceiptSha256,
      'REVIEWED_CANDIDATE_CHANGED_DURING_PREFLIGHT');
    return transfer(operation, { loadSdk: async () => {
      const module = await loadSdk(), ci = module.default || module;
      check(typeof ci.proxy === 'function', 'OFFICIAL_SDK_PROXY_API_MISSING'); ci.proxy(context.proxyUrl); return module;
    } });
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.stdout.write.bind(process.stdout), rejectedIps = new Set();
  const inspect = value => {
    if (typeof value !== 'string' && !Buffer.isBuffer(value)) return;
    for (const match of String(value).matchAll(/invalid ip\s*[:=]?\s*((?:\d{1,3}\.){3}\d{1,3})(?!\d)/gi))
      if (match[1].split('.').every(part => +part <= 255)) rejectedIps.add(match[1]);
  };
  const silence = (chunk, encoding, callback) => { inspect(chunk); const done = typeof encoding === 'function' ? encoding : callback;
    if (done) queueMicrotask(done); return true; };
  process.stdout.write = silence; process.stderr.write = silence;
  for (const name of ['log', 'info', 'warn', 'error', 'debug']) console[name] = (...values) => values.forEach(inspect);
  try {
    const { values } = parseArgs({ options: { candidate: { type: 'string' }, 'private-key': { type: 'string' },
      online: { type: 'boolean', default: false }, execute: { type: 'boolean', default: false },
      robot: { type: 'string', default: '2' }, 'allowlisted-ip': { type: 'string' } } });
    const result = await isolatedProxyTransfer({ candidateDirectory: values.candidate, privateKeyPath: values['private-key'],
      online: values.online, execute: values.execute, robot: Number(values.robot), allowlistedIp: values['allowlisted-ip'] });
    output(JSON.stringify({ status: result.status, version: result.version, candidateId: result.candidateId,
      candidateReceiptSha256: result.candidateReceiptSha256, expectedExitIp: result.expectedExitIp,
      requiredOperatorAssertion: result.requiredOperatorAssertion, directory: result.directory, packageInfo: result.packageInfo,
      routeReceiptPath: result.routeReceiptPath, globalEvidence: result.globalEvidence,
      temporarySensitiveConfigDeleted: result.temporarySensitiveConfigDeleted, isolatedCoreStopped: result.isolatedCoreStopped }) + '\n');
  } catch (error) {
    const value = error?.code, safe = typeof value === 'number' || /^[A-Z0-9_-]{1,80}$/.test(value || '') ? value : 'DETAILS_OMITTED';
    output(JSON.stringify({ status: 'STOPPED_NO_AUTOMATIC_RETRY', errorCode: safe, receiptDirectory: error.receiptDirectory,
      routeReceiptPath: error.routeReceiptPath, rejectedIps: [...rejectedIps] }) + '\n'); process.exitCode = 1;
  }
}
