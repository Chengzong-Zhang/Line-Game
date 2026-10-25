// Real compiler/source-closure attacks on disposable copies of one local bundle.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyValidatorInputsV2 } from '../../tools/build-server-validator-v2.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2), i = args.indexOf('--bundle');
assert.ok(i >= 0 && args[i + 1], 'Use --bundle PATH/validate-action.mjs');
const bundle = path.resolve(args[i + 1]), original = path.dirname(bundle);
const hash = raw => createHash('sha256').update(raw).digest('hex');
const bundleBytes = await fs.readFile(bundle), manifestBytes = await fs.readFile(path.join(original, 'manifest.json'));
const source = JSON.parse(manifestBytes), output = await fs.mkdtemp(path.join(root, 'local_artifacts/validator-v2-input-tests-'));
const cases = [];
await verifyValidatorInputsV2(original);
cases.push({ case: 'original-recompiles-to-exact-bundle-and-complete-input-graph', pass: true });
const attacks = [
  ['empty-source-inventory', m => { m.sourceHashes = {}; }, /required validator source hashes/],
  ['empty-compiler-inventory', m => { m.compilerHashes = {}; }, /required compiler hashes/],
  ['only-minimum-source-set-retained', m => { m.sourceHashes = Object.fromEntries(Object.entries(m.sourceHashes).filter(([name]) =>
    ['wechat/minigame/tools/validate-action.mjs', 'wechat/minigame/src/state.js', 'web/web前端/GameEngine.js',
      'web/tools/build-server-validator-v2.mjs', 'wechat/minigame/tools/web-compat.mjs', 'wechat/minigame/compat/web/manifest.json'].includes(name))); }, /source graph/],
  ['all-native-compatibility-records-deleted', m => { m.nativeCompatibility = {}; }, /native compatibility graph/],
  ['one-native-compatibility-record-deleted', m => { delete m.nativeCompatibility[Object.keys(m.nativeCompatibility)[0]]; }, /native compatibility graph/],
  ['compiler-path-cannot-be-retargeted-to-env-file', m => { m.compilerHashes.package.path = path.join(output, '.env'); }, /esbuild\/package.json/],
  ['source-path-cannot-read-an-env-file', m => { m.sourceHashes['web/web前端/../../.env'] = 'a'.repeat(64); }, /Unexpected validator hash path/],
  ['compiler-version-changed', m => { m.compiler = '0.25.11'; }, /0.25.12/],
];
for (const [name, mutate, expected] of attacks) {
  const directory = path.join(output, name); await fs.mkdir(directory);
  const manifest = structuredClone(source); mutate(manifest);
  await fs.writeFile(path.join(directory, 'validate-action.mjs'), bundleBytes, { flag: 'wx' });
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  await assert.rejects(() => verifyValidatorInputsV2(directory), expected);
  cases.push({ case: name, pass: true });
}
assert.equal(hash(await fs.readFile(bundle)), hash(bundleBytes));
assert.equal(hash(await fs.readFile(path.join(original, 'manifest.json'))), hash(manifestBytes));
cases.push({ case: 'original-bundle-and-manifest-byte-identical', pass: true });
const report = { schema: 'lifeline-native-validator-input-negative-tests-v2', status: 'PASS_REAL_REBUILD_AND_INPUT_BINDING',
  bundle: path.relative(root, bundle).replaceAll('\\', '/'), bundleSha256: hash(bundleBytes),
  manifestSha256: hash(manifestBytes), cases, sourceCount: Object.keys(source.sourceHashes).length,
  nativeCompatibilityCount: Object.keys(source.nativeCompatibility).length,
  scope: 'Local input/closure integrity only; no model training, product admission, device or release claim.' };
await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: report.status, cases: cases.length, receipt: path.join(output, 'receipt.json') }));
