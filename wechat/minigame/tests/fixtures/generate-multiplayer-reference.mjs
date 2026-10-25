// Explicit maintenance command, never imported by the test suite. Run before
// replacing the legacy core; every module is bundled in memory without AI.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { build } from '../../node_modules/esbuild/lib/main.js';

const [referenceDirectory, legacyDirectory, outputFile] = process.argv.slice(2);
if (!referenceDirectory || !legacyDirectory || !outputFile) throw new Error('Usage: node generate-multiplayer-reference.mjs <frozen-r4-web-dir> <pre-migration-0.9.2-web-dir> <new-output.json>');
const output = path.resolve(outputFile);
try { await fs.access(output); throw new Error('Refusing to overwrite reference evidence'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
globalThis.crypto ||= webcrypto;
const hash = value => createHash('sha256').update(value).digest('hex');
const plain = value => JSON.parse(JSON.stringify(value));
async function load(directory) {
  const root = path.resolve(directory);
  const sourceSha256 = {};
  for (const name of ['GameEngine.js', 'ReplayCodec.js']) sourceSha256[name] = hash(await fs.readFile(path.join(root, name)));
  const result = await build({ stdin: { contents: `export * from './GameEngine.js'; export * from './ReplayCodec.js';`, resolveDir: root },
    bundle: true, platform: 'node', format: 'esm', write: false, plugins: [{ name: 'query', setup(b) {
      b.onResolve({ filter: /\?v=/ }, a => ({ path: path.resolve(a.resolveDir, a.path.split('?')[0]) }));
    } }] });
  return { sourceSha256, code: await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`) };
}
const reference = await load(referenceDirectory), legacy = await load(legacyDirectory);
assert.equal(reference.sourceSha256['GameEngine.js'], '625e8d8a92801647702f963f56148040248cf471228a6ce5c719e20e4414a555');
assert.equal(reference.sourceSha256['ReplayCodec.js'], '11c9d4dd13b46a9eed77e9230b29043d36737f8b05bee8e6f748c89b85f9aee5');
assert.equal(legacy.sourceSha256['GameEngine.js'], '8db6b7a516dfb63efe4ca3abe7adaf35d563b48cfbc49130e71f03bcf0591b12');
assert.equal(legacy.sourceSha256['ReplayCodec.js'], 'be0e6ac0a1f26f0c36eba41266bab931b9bf36c6eebb57ddd63513ea5573acf5');
const r = reference.code, colors = ['BLACK', 'WHITE', 'PURPLE', 'GREEN', 'ORANGE', 'CYAN'];
const digest = value => `sha256:${hash(r.canonicalize(value))}`;
const settingsFor = (gridSize, playerCount, startPlayer = 'BLACK') => ({ gridSize, playerCount, startPlayer, rulesVersion: 'territory-v2', turnTimerEnabled: false, turnTimeLimitSeconds: 60, hintEnabled: true, hintMaxCount: 3 });
const apply = (engine, action) => action.type === 'move' ? engine.playMove(action.point) : action.type === 'skip' ? engine.skipTurn() : engine.resignPlayer(action.player);
function checkpoint(engine) {
  const snapshot = engine.getSnapshot();
  return { stateHash: digest(r.serializeRuleState(engine)), snapshotHash: digest(snapshot),
    currentPlayer: snapshot.currentPlayer, turnCount: snapshot.turnCount, gameOver: snapshot.gameOver,
    winner: snapshot.winner, area: Object.fromEntries(snapshot.players.map(p => [p, snapshot.territories[p].area])) };
}
const cases = [], documents = [];
async function record(settings, kind = 'moves') {
  const engine = new r.GameEngine(settings), actions = [], states = [checkpoint(engine)];
  const initial = { pointCount: engine.validPositions.length, positionsHash: digest(engine.validPositions),
    vertices: engine.boardVertices, homes: engine.initialPositions };
  const push = action => { assert.equal(apply(engine, action).success, true); actions.push(action); states.push(checkpoint(engine)); };
  if (kind === 'natural') for (const point of [[1,0],[0,2],[3,1],[1,2],[1,3],[2,0],[2,1],[1,1]]) push({ type: 'move', player: engine.currentPlayer, point });
  else if (kind === 'pass') {
    for (let i = 0; i < settings.playerCount && !engine.gameOver; i++) push({ type: 'skip', player: engine.currentPlayer });
    assert.equal(engine.gameOver, true);
  } else {
    for (let i = 0; i < 6 && !engine.gameOver; i++) {
      const legal = engine.getLegalMoves();
      const point = legal[(i * 17 + settings.gridSize + settings.playerCount) % legal.length]?.point;
      push({ type: point ? 'move' : 'skip', player: engine.currentPlayer, ...(point ? { point: [...point] } : {}) });
    }
    if (kind === 'resign') {
      for (const player of colors.slice(0, settings.playerCount - 1)) if (!engine.gameOver) push({ type: 'resign', player });
      assert.equal(engine.gameOver, true);
    }
  }
  const document = await r.createReplayDocument(settings, actions);
  const id = `${settings.playerCount}p-${settings.gridSize}-${settings.startPlayer.toLowerCase()}-${kind}`;
  const expected = { initial, states, replayIntegrity: document.integrity, terminal: document.terminal };
  if (settings.playerCount <= 3) {
    const old = new legacy.code.GameEngine(settings);
    assert.equal(digest(legacy.code.serializeRuleState(old)), states[0].stateHash, id);
    actions.forEach((action, index) => { assert.equal(apply(old, action).success, true); assert.equal(digest(legacy.code.serializeRuleState(old)), states[index + 1].stateHash, `${id}/${index}`); });
    assert.deepEqual(await legacy.code.createReplayDocument(settings, actions), document, `${id}: complete legacy replay`);
  }
  cases.push({ id, settings, actions, expected, legacy092Compared: settings.playerCount <= 3 });
  if (kind === 'resign') documents.push({ id, document });
  console.log(`reference ${id}`);
}
for (const count of [2,3,4,5,6]) {
  for (const size of [5,7,15]) await record(settingsFor(size, count));
  for (const player of colors.slice(1, count)) await record(settingsFor(5, count, player));
  await record(settingsFor(5, count), 'pass');
  await record(settingsFor(5, count), 'resign');
}
await record(settingsFor(5,3), 'natural');
const fixture = { schema: 'lifeline-r4-multiplayer-rules-reference', version: 1,
  provenance: { frozenR4SourceSha256: reference.sourceSha256, legacy092SourceSha256: legacy.sourceSha256,
    generatorSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))),
    method: 'Frozen r4 only; six legal moves selected by (step*17+size+count)%legal.length; every prefix hashed. All starters at size 5, BLACK at sizes 7/15; pass/resign terminals and legacy three-player area witness. Complete legacy 0.9.2 replay documents and every rule-state hash compared before migration. No AI, training or production bundle.' }, cases, documents };
await fs.writeFile(output, JSON.stringify(fixture) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, bytes: (await fs.stat(output)).size, cases: cases.length, documents: documents.length,
  checkpoints: cases.reduce((n,c) => n+c.expected.states.length,0), legacyCases: cases.filter(c=>c.legacy092Compared).length, sha256: hash(await fs.readFile(output)) }));
