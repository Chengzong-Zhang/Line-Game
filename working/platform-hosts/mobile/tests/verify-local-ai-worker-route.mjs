import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalAIWorker, localAIWorkerRoute } from '../../web/web前端/LocalAIWorkerFactory.js';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(mobileRoot, '..');
const webRoot = path.join(repoRoot, 'web', 'web前端');
const hard = { strategy: 'multiplayer', modelId: 'multiplayer-hard-v1' };
const medium = { strategy: 'multiplayer', modelId: 'multiplayer-medium-v1' };
const minimax = { strategy: 'minimax', depth: 3 };
const base = { playerCount: 4, gridSize: 15, boardShape: 'hexagon', rulesVersion: 'territory-v2' };

for (const rulesVersion of ['territory-v2', 'territory-v3']) {
  for (const playerCount of [3, 4, 5, 6]) for (const gridSize of [5, 7, 9, 11, 15]) {
    const context = { ...base, rulesVersion, playerCount, gridSize,
      boardShape: playerCount === 3 ? 'triangle' : 'hexagon' };
    const hardRoute = localAIWorkerRoute(context, [minimax, medium, hard, null]);
    assert.equal(hardRoute.kind, 'native-hard-bundle');
    assert.match(hardRoute.url.pathname, /MultiplayerHardAIWorker\.bundle\.mjs$/);
    assert.equal(hardRoute.url.search, '?v=20261024-v3-pocket1');
    const ordinaryRoute = localAIWorkerRoute(context, [minimax, medium, medium, null]);
    assert.equal(ordinaryRoute.kind, 'ordinary');
    assert.match(ordinaryRoute.url.pathname, /AIWorker\.js$/);
    assert.equal(ordinaryRoute.url.search, '?v=20261024-l34a1');
  }
}

for (const context of [
  null,
  { ...base, playerCount: 2 },
  { ...base, gridSize: 16 },
  { ...base, gridSize: 5.5 },
  { ...base, rulesVersion: 'territory-v1' },
  { ...base, boardShape: 'triangle' },
]) assert.equal(localAIWorkerRoute(context, [hard]).kind, 'ordinary');

const threePlayer = { ...base, playerCount: 3, boardShape: 'triangle' };
assert.equal(localAIWorkerRoute(threePlayer, [medium, medium, medium, hard]).kind, 'ordinary',
  'profiles outside the active match cannot select the Hard Worker');
const stable = localAIWorkerRoute(base, [minimax, medium, hard, null]);
assert.equal(stable.identity, localAIWorkerRoute({ ...base }, [minimax, medium, hard, null]).identity);
assert.notEqual(stable.identity, localAIWorkerRoute({ ...base, gridSize: 9 }, [minimax, medium, hard, null]).identity);
assert.notEqual(stable.identity, localAIWorkerRoute(base, [minimax, hard, medium, null]).identity);

class FakeWorker {
  constructor(url, options) { this.url = url; this.options = options; }
}
const worker = createLocalAIWorker(base, [minimax, medium, hard, null], FakeWorker);
assert.equal(worker.url.href, stable.url.href);
assert.deepEqual(worker.options, { type: 'module' });
assert.throws(() => createLocalAIWorker(base, [hard], null), /Web Workers are unavailable/);

const onlineApp = await readFile(path.join(webRoot, 'OnlineApp.js'), 'utf8');
assert.match(onlineApp,
  /import \{ createLocalAIWorker \} from "\.\/LocalAIWorkerFactory\.js\?v=20261024-l34a1";/,
  'mobile OnlineApp imports the admitted route factory');
const ensureStart = onlineApp.indexOf('    const ensureAiWorker = () => {');
const ensureEnd = onlineApp.indexOf('    const scheduleAiMove =', ensureStart);
assert.ok(ensureStart >= 0 && ensureEnd > ensureStart, 'mobile AI worker creation block is present');
const ensureBlock = onlineApp.slice(ensureStart, ensureEnd);
assert.match(ensureBlock,
  /if \(!appDisposed && \(!isMobileShell\(\) \|\| mobileAppActive\) && !aiWorker && canRunLocalAI\(\)\)/,
  'worker creation stays behind the mobile active/disposed gate');
assert.match(ensureBlock,
  /createLocalAIWorker\(controller\.value\?\.engine,\s*APP_ALL_PLAYERS\.slice\(0, activeSoloSettings\.value\.playerCount\)\.map\(player => selectedAiProfile\(player\)\)\)/,
  'factory receives the active engine and one snapshot of active-seat profiles');
assert.doesNotMatch(ensureBlock, /new Worker\(/,
  'the persistent local-match Worker is selected only through the route factory');
assert.match(ensureBlock,
  /if \(appDisposed \|\| aiWorker !== worker \|\| \(isMobileShell\(\) && !mobileAppActive\)\) return;/,
  'late Worker messages retain the mobile lifecycle guard');
assert.match(onlineApp, /const terminateAiWorker = \(\) => \{[\s\S]{0,1400}?aiWorker\.terminate\(\);/,
  'existing cancellation path still terminates the owned Worker');
assert.match(onlineApp, /appDisposed = true;[\s\S]{0,1800}?terminateAiWorker\(\);/,
  'unmount still disposes the app and cancels the Worker');

const bundle = await readFile(path.join(webRoot, 'MultiplayerHardAIWorker.bundle.mjs'));
const bundleManifestBytes = await readFile(path.join(webRoot, 'MultiplayerHardAIWorker.bundle.manifest.json'));
const bundleManifest = JSON.parse(bundleManifestBytes);
const sha256 = value => createHash('sha256').update(value).digest('hex');
assert.equal(sha256(bundle), 'bea2a7c9587a8697e71a981a4e5f3cb92ff7bd92d8ad107b845ba6ba004e6911');
assert.equal(bundleManifest.bundleSha256, sha256(bundle));
assert.equal(bundleManifest.publicModelId, 'multiplayer-hard-v1');
assert.equal(bundleManifest.implementationId, 'multiplayer-hard-heuristic-deadline-v2');
assert.equal(bundleManifest.verified, false, 'bundle manifest build field is not promoted into a verification claim');

console.log(JSON.stringify({
  status: 'PASS_MOBILE_LOCAL_AI_WORKER_ROUTE',
  nativeContexts: 40,
  browserEvidenceBoundSeparately: true,
  deviceRun: false,
  strengthPreservationClaim: false,
}));
