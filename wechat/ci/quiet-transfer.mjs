// One explicitly requested transfer. Suppress raw SDK logs and print allowlisted
// result fields only; no automatic retry and no credential/error-object dumps.
import { parseArgs } from 'node:util';
import { runTransfer } from './transfer.mjs';

const output = process.stdout.write.bind(process.stdout);
const safeCode = error => {
  const code = error?.code;
  return (typeof code === 'number' && Number.isFinite(code)) ||
    (typeof code === 'string' && /^[A-Z0-9_-]{1,80}$/.test(code)) ? code : 'DETAILS_OMITTED';
};
const ips = new Set();
function inspect(text) {
  if (typeof text !== 'string' && !Buffer.isBuffer(text)) return;
  for (const m of String(text).matchAll(/invalid ip\s*[:=]?\s*((?:\d{1,3}\.){3}\d{1,3})(?!\d)/gi)) {
    if (m[1].split('.').every(n => +n <= 255)) ips.add(m[1]);
  }
}
const silence = (chunk, encoding, callback) => {
  inspect(chunk);
  const complete = typeof encoding === 'function' ? encoding : callback;
  if (complete) queueMicrotask(complete);
  return true;
};
process.stdout.write = silence; process.stderr.write = silence;
for (const name of ['log', 'info', 'warn', 'error', 'debug']) console[name] = (...items) => items.forEach(inspect);
try {
  const { values } = parseArgs({ options: {
    candidate: { type: 'string' }, 'private-key': { type: 'string' },
    action: { type: 'string', default: 'preview' }, online: { type: 'boolean', default: false },
    robot: { type: 'string', default: '1' },
    execute: { type: 'boolean', default: false },
  } });
  const result = await runTransfer({ action: values.action, candidateDirectory: values.candidate,
    privateKeyPath: values['private-key'], online: values.online, execute: values.execute,
    robot: Number(values.robot) });
  output(JSON.stringify({ status: result.status, version: result.version, directory: result.directory,
    candidateId: result.candidateId, packageInfo: result.packageInfo, qr: result.qr }) + '\n');
} catch (error) {
  output(JSON.stringify({ status: 'STOPPED_NO_AUTOMATIC_RETRY', errorCode: safeCode(error),
    receiptDirectory: error.receiptDirectory, rejectedIps: [...ips] }) + '\n');
  process.exitCode = 1;
}
