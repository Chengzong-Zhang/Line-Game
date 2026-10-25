// Explicit regeneration tool. Default tests read the committed portable fixture,
// never this source directory or any local_artifacts path.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const args = process.argv.slice(2);
assert.equal(args.length, 4, 'Usage: --source FROZEN_FRONTEND_DIRECTORY --output NEW_FIXTURE_JSON');
assert.equal(args[0], '--source'); assert.equal(args[2], '--output');
const source = path.resolve(args[1]), output = path.resolve(args[3]);
const sha = data => createHash('sha256').update(data).digest('hex');
const pins = {
  'GameEngine.js': '625e8d8a92801647702f963f56148040248cf471228a6ce5c719e20e4414a555',
  'AIEngine.js': '6738fe3a98a616dfd6c060636f5d2684fd49ebc561c95a96247db28c7170ccc3',
  'HexPlayerAI.js': '62340c349b53a13e20d47171187228a2359c5d8dcbf12344a4bf6a0017b9f673',
  'assets/research-ai/hex-player-policy-v1.json': '74aa7f945c3ea7ff5ca3edc9e7bdc431dc0ec5ad56d2563ce6d6d24c0494162b',
};
for (const [file, hash] of Object.entries(pins)) assert.equal(sha(await fs.readFile(path.join(source, file))), hash, file);
const bundled = await build({ stdin: { contents: 'export * from "./GameEngine.js"; export * from "./HexPlayerAI.js";', resolveDir: source },
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent',
  define: { 'import.meta.url': JSON.stringify(pathToFileURL(path.join(source, 'HexPlayerAI.js')).href) },
  plugins: [{ name: 'frozen-cache-query', setup(ctx) {
    ctx.onResolve({ filter: /\?v=/ }, args => ({ path: path.resolve(args.resolveDir, args.path.split('?')[0]) }));
  } }] });
const frozen = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const payload = JSON.parse(await fs.readFile(path.join(source, 'assets/research-ai/hex-player-policy-v1.json'), 'utf8'));
const model = await frozen.createHexPlayerModel(payload), ai = new frozen.HexPlayerAI(model);
const canonical = value => value && typeof value === 'object' ? Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const body = { ...payload }; delete body.integrity;
const positions = [];
for (const count of [4, 5, 6]) for (const gridSize of [5, 7, 15]) for (const startPlayer of frozen.PLAYER_ORDER.slice(0, count)) {
  const settings = { gridSize, playerCount: count, startPlayer, rulesVersion: 'territory-v2',
    turnTimerEnabled: false, turnTimeLimitSeconds: 60, hintEnabled: true, hintMaxCount: 3 };
  const engine = new frozen.GameEngine(settings), actions = [];
  for (let index = 0; index < count * 3; index++) {
    const legal = engine.getLegalMoves(); assert.ok(legal.length);
    const point = legal[(index * 7 + gridSize + count) % legal.length].point;
    const action = { type: 'move', player: engine.currentPlayer, point: [...point] };
    assert.equal(engine.playMove(point).success, true); actions.push(action);
    if (actions.length >= count && engine.currentPlayer === startPlayer && !engine.gameOver) break;
  }
  assert.equal(engine.currentPlayer, startPlayer); assert.equal(engine.gameOver, false);
  const expected = ai.getTopMoves(engine, startPlayer, 10000);
  assert.ok(expected.length); assert.equal(expected.length, engine.getLegalMoves().length);
  positions.push({ id: `players-${count}-size-${gridSize}-${startPlayer.toLowerCase()}`, settings, actions,
    player: startPlayer, edgeCounts: Object.fromEntries(engine.activePlayers.map(p => [p, engine.edges[p].size])), expected });
}
assert.equal(positions.length, 45);
for (const [file, hash] of Object.entries(pins)) assert.equal(sha(await fs.readFile(path.join(source, file))), hash, `Source changed: ${file}`);
const result = { schema: 'lifeline-hex-player-r4-reference', version: 1,
  provenance: { source: 'frozen deployed r4 frontend', sourceSha256: pins, recordedAtUtc: new Date().toISOString(),
    modelCanonicalSha256: `sha256:${sha(canonical(payload))}`, modelInnerPayloadSha256: sha(JSON.stringify(body)),
    algorithmNormalizedLfSha256: sha((await fs.readFile(path.join(source, 'HexPlayerAI.js'), 'utf8')).replace(/\r\n/g, '\n')),
    generation: 'Frozen GameEngine and HexPlayerAI only. Every seat of 4/5/6 players at sizes 5/7/15. Deterministic legal prefix index (turn*7+size+count)%legal.length until one full round returns to startPlayer; complete frozen v1 ranking. No current game/policy code or training.' }, positions };
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, JSON.stringify(result) + '\n', { encoding: 'utf8', flag: 'wx' });
console.log(JSON.stringify({ output, positions: positions.length, bytes: (await fs.stat(output)).size, sha256: sha(await fs.readFile(output)) }));
