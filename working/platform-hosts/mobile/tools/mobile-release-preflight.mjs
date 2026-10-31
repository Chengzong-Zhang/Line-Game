import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateReleasePreflight, writePreflightReceipt } from './release-readiness.mjs';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const options = new Map();
for (let i = 0; i < args.length; i += 1) {
  if (['--receipt', '--android-apk', '--harmony-hap'].includes(args[i]) && args[i + 1]) options.set(args[i], args[++i]);
}
const report = await evaluateReleasePreflight({
  androidPackage: options.get('--android-apk') || null,
  harmonyPackage: options.get('--harmony-hap') || null,
});
if (options.has('--receipt')) await writePreflightReceipt(report, path.resolve(options.get('--receipt')));
console.log(`Release preflight: ${report.status} (${report.blockedCount} blocked checks).`);
for (const check of report.checks) console.log(`${check.status}: ${check.name} — ${check.detail}`);
if (report.status !== 'READY') process.exitCode = 1;
