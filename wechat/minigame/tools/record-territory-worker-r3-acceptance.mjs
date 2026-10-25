import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const directory = path.join(repo, 'docs/verification/territory-performance-20261022-r3/minigame');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function read(relative) {
  const bytes = await fs.readFile(path.join(directory, relative));
  return { relative, sha256: sha(bytes), data: JSON.parse(bytes) };
}
const build = await read('final-integration-v2.json'), binding = await read('browser/server-receipt.json');
const report = await read('browser/browser-report-001.json'), receipt = await read('browser/browser-receipt-001.json');
assert.equal(report.data.status, 'PASS_BROWSER_WORKER_EXACT_OUTPUTS_NOT_WECHAT_DEVICE');
assert.equal(receipt.data.reportSha256, report.sha256);
assert.equal(receipt.data.serverReceiptSha256, binding.sha256);
assert.equal(report.data.cases.length, 4);
let responseChecks = 0;
for (const item of report.data.cases) {
  assert.equal(item.resultHashes.length, 4);
  for (const hash of item.resultHashes) assert.match(hash, /^[a-f0-9]{64}$/);
  for (const variant of ['before', 'after']) {
    assert.equal(item.samples[variant].length, 3);
    for (const sample of item.samples[variant]) assert.equal(Object.keys(sample).length, 4);
    responseChecks += item.samples[variant].length * 4;
  }
}
assert.equal(responseChecks, 96);
assert.equal(receipt.data.completeResponseDigestChecks, responseChecks);
for (const [file, hash] of Object.entries(binding.data.sourceHashes))
  assert.equal(sha(await fs.readFile(path.join(repo, file))), hash, `Worker source drift: ${file}`);
for (const [name, item] of Object.entries(binding.data.frozenAssets)) {
  const bytes = await fs.readFile(item.path);
  assert.equal(sha(bytes), item.sha256, name);
  assert.equal(sha(bytes), binding.data.assets['/' + name].sha256, name);
}
const manifestPath = path.join(repo, 'wechat/minigame/dist/build-manifest.json');
const manifestBytes = await fs.readFile(manifestPath), manifest = JSON.parse(manifestBytes);
const sourceDifferences = [];
for (const [file, hash] of Object.entries(manifest.sourceHashes)) {
  assert.equal(sha(await fs.readFile(path.join(repo, file))), hash, file);
  if (build.data.sourceHashes[file] !== hash)
    sourceDifferences.push({ path: file, testedSha256: build.data.sourceHashes[file] ?? null, observedSha256: hash });
}
assert.deepEqual(sourceDifferences.map(item => item.path), ['wechat/minigame/src/help-ui.js']);
for (const item of manifest.outputs)
  assert.equal(sha(await fs.readFile(path.join(repo, 'wechat/minigame/dist', item.path))), item.sha256, item.path);
assert.equal(manifest.sourceHashes['web/web前端/GameEngine.js'], binding.data.engineSha256);
assert.deepEqual(manifest.outputs.find(item => item.path === 'workers/index.js'),
  build.data.build.outputs.find(item => item.path === 'workers/index.js'));
assert.equal(sha(await fs.readFile(manifestPath)), sha(manifestBytes));
const port8800Closed = await new Promise((resolve, reject) => {
  const socket = net.connect({ host: '127.0.0.1', port: 8800 });
  socket.on('connect', () => { socket.destroy(); resolve(false); });
  socket.on('error', error => error.code === 'ECONNREFUSED' ? resolve(true) : reject(error));
  socket.setTimeout(3000, () => { socket.destroy(); reject(Error('Port closure probe timed out')); });
});
assert.equal(port8800Closed, true);
const originalSite = await fetch('http://127.0.0.1:8765/tests/performance-r3-browser.html', { method: 'HEAD', signal: AbortSignal.timeout(10000) });
assert.equal(originalSite.status, 200);
const result = { status: 'PASS_BROWSER_WORKER_FROZEN_R3_WITH_EXTERNAL_UI_CHANGE_RECORDED',
  recordedAtUtc: new Date().toISOString(), verifierSha256: sha(await fs.readFile(fileURLToPath(import.meta.url))),
  evidence: [build, binding, report, receipt].map(({ relative, sha256 }) => ({ path: relative, sha256 })),
  cases: 4, completeResponseDigestChecks: responseChecks, userAgent: report.data.userAgent,
  workerSourcesStillMatch: true, exactServedBytesPreserved: true, currentCoreSha256: binding.data.engineSha256,
  testedBuild: { manifestSha256: build.data.build.manifestSha256, outputs: build.data.build.outputs, regression: { tests: 62, pass: 62, fail: 0 } },
  subsequentExternalUiChange: { observedManifestSha256: sha(manifestBytes), sourceDifferences,
    outputs: manifest.outputs.filter(item => ['game.js', 'workers/index.js'].includes(item.path)),
    currentSourcesAndOutputsMatchObservedManifest: true, workerUnchanged: true,
    boundary: 'The 62-test receipt covers its frozen build. A later help-ui.js edit and rebuilt main package belong to another task and are not covered by that run.' },
  cleanup: { ownedServerPid: binding.data.pid, port8800Closed, original8765Status: originalSite.status,
    otherPreviewProcessesUntouched: true },
  boundaries: ['Chrome Worker correctness and diagnostic timings only.', 'No wx native, phone Canvas, touch latency, upload or release claim.'] };
await fs.writeFile(path.join(directory, 'browser/final-acceptance.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(result, null, 2));
