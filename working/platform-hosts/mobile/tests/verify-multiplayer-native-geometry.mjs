import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GameEngine } from '../../web/web前端/GameEngine.js';
import { serializeEngineState } from '../../web/web前端/AIStateProtocol.js';
import { installNativeEdgeGeometry } from '../../web/web前端/MultiplayerNativeGeometry.js';
import { isolatedSearchEngine } from '../../web/web前端/MultiplayerSearch.js';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(mobileRoot, '..');
const runtimeManifest = JSON.parse(await readFile(path.join(mobileRoot, 'config/mobile-runtime-source-manifest.json'), 'utf8'));
const syncManifest = JSON.parse(await readFile(path.join(mobileRoot, 'config/current-web-sync-source-manifest.json'), 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceBytes = async (name) => readFile(path.join(repoRoot, 'web/web前端', name));

const geometryHash = sha256(await sourceBytes('MultiplayerNativeGeometry.js'));
const searchHash = sha256(await sourceBytes('MultiplayerSearch.js'));
assert.equal(geometryHash, 'fc0a65a9c935d6922731e5f5ca983520cf8290de0d9b831b9ca05cffa65b13fe',
  'mobile geometry is the accepted current Web module');
assert.equal(syncManifest.source_files['MultiplayerNativeGeometry.js'], geometryHash);
assert.equal(syncManifest.source_files['MultiplayerSearch.js'], searchHash,
  'mobile search matches the current frozen Web sync manifest');
assert.ok(runtimeManifest.files.includes('MultiplayerNativeGeometry.js'));
assert.match((await sourceBytes('MultiplayerSearch.js')).toString(),
  /installNativeEdgeGeometry\(engine\);\s*return engine;/,
  'private multiplayer search engines install the accepted geometry cache');

assert.throws(() => installNativeEdgeGeometry(new GameEngine(), { maximumEntries: 0 }), /Invalid edge geometry limit/);
const overridden = new GameEngine();
overridden._getState = overridden._getState.bind(overridden);
assert.throws(() => installNativeEdgeGeometry(overridden), /requires native _getState/,
  'geometry optimization fails closed when the engine contract is customized');

const canonicalMoves = (moves) => moves.map(({ point, state, isAttack }) => ({ point, state, isAttack }))
  .sort((left, right) => left.point[1] - right.point[1] || left.point[0] - right.point[0]);
const started = performance.now();
let cases = 0;
for (const playerCount of [2, 3, 4, 5, 6]) {
  for (const boardShape of ['triangle', 'hexagon']) {
    for (const gridSize of [5, 9, 15]) {
      assert.ok(performance.now() - started < 50_000, 'bounded geometry regression expired');
      const settings = { playerCount, boardShape, gridSize, rulesVersion: 'territory-v2', deferTerritoryUpdates: true };
      const opening = new GameEngine(settings);
      const native = new GameEngine({ ...settings, initialPositions: opening.initialPositions });
      native._isReplayingBatch = true;
      const optimized = isolatedSearchEngine(native);
      assert.equal(native._cleanupBrokenEdges, GameEngine.prototype._cleanupBrokenEdges,
        'optimization remains private to the isolated search copy');
      assert.notEqual(optimized._cleanupBrokenEdges, GameEngine.prototype._cleanupBrokenEdges);
      for (let ply = 0; ply < 5 && !native.gameOver; ply += 1) {
        const before = serializeEngineState(native);
        const legalMoves = native.getLegalMoves();
        assert.deepEqual(canonicalMoves(optimized.getLegalMoves()), canonicalMoves(legalMoves));
        for (const player of native.activePlayers) {
          assert.equal(optimized._hasValidMoves(player), native._hasValidMoves(player));
        }
        assert.deepEqual(serializeEngineState(optimized), before,
          'legal enumeration does not change board or history state');
        const point = legalMoves.length
          ? legalMoves[(playerCount + gridSize + ply * 7) % legalMoves.length].point
          : null;
        const nativeResult = point ? native.playMove(point) : native.skipTurn();
        const optimizedResult = point ? optimized.playMove(point) : optimized.skipTurn();
        assert.equal(nativeResult.success, true);
        assert.equal(optimizedResult.success, true);
        assert.deepEqual(serializeEngineState(optimized), serializeEngineState(native));
      }
      cases += 1;
    }
  }
}

assert.equal(cases, 30);
console.log(JSON.stringify({
  status: 'PASS_MOBILE_NATIVE_GEOMETRY_30_CONTEXT_TRANSITIONS',
  cases,
  geometry_sha256: geometryHash,
  search_sha256: searchHash,
  elapsed_ms: performance.now() - started,
}));
