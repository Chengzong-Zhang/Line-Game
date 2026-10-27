// Explicit maintenance only. Never imported by tests or builds. The expected
// engine is the independently frozen, uploaded 0.11.2 source, not the worktree.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { build } from '../../node_modules/esbuild/lib/main.js';

const [r4Directory, uploadedEngine, codecDirectory, candidateFile, outputFile] = process.argv.slice(2);
if (!outputFile) throw Error('Usage: node generate-multiplayer-0112-reference.mjs <frozen-r4-dir> <uploaded-0112-engine> <pinned-codec-dir> <official-candidate.json> <new-output.json>');
const here = path.dirname(fileURLToPath(import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const plain = value => JSON.parse(JSON.stringify(value));
const pins = {
  r4: { 'GameEngine.js': '625e8d8a92801647702f963f56148040248cf471228a6ce5c719e20e4414a555',
    'ReplayCodec.js': '11c9d4dd13b46a9eed77e9230b29043d36737f8b05bee8e6f748c89b85f9aee5' },
  uploaded0112: { 'GameEngine.js': '9d88e2716134355b1388a98f9a36679e3f68f370c6cb00e4501d4cf8cdf3758e',
    'ReplayCodec.js': '76b5bdef75adb1b91a7e61c9e085c651f78cf5e825bbd429de99535a2124e923',
    'StartingPoints.js': '7b09547988a75cbccda06fbd554af8aaa18957f9b3029d772106894e4921894d' },
};
const candidateBytes = await fs.readFile(candidateFile), candidate = JSON.parse(candidateBytes);
assert.equal(sha(candidateBytes), 'c3bedc62529bc7ca67c8d0c12049fcc39f34feb539f67400dd1d55758eccc922');
assert.equal(candidate.version, '0.11.2');
for (const [name, hash] of Object.entries(pins.uploaded0112)) assert.equal(candidate.sourceHashes[`web/web前端/${name}`], hash);
globalThis.crypto ||= webcrypto;
try { await fs.access(outputFile); throw Error('Refusing to overwrite accepted reference evidence'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

async function load(version, directory, engineOverride) {
  const sources = {};
  for (const [name, hash] of Object.entries(pins[version])) {
    const file = name === 'GameEngine.js' && engineOverride ? engineOverride : path.join(directory, name);
    const source = await fs.readFile(file);
    assert.equal(sha(source), hash, `${version}/${name}: source is not the pinned independent reference`);
    sources[name] = source.toString('utf8');
  }
  const bundle = await build({ stdin: { contents: 'export * from "reference:GameEngine.js"; export * from "reference:ReplayCodec.js";' },
    bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{ name: 'frozen-reference-only', setup(b) {
      b.onResolve({ filter: /.*/ }, args => {
        const name = args.path.replace(/^reference:/, '').replace(/^\.\//, '').split('?')[0];
        if (!(name in sources)) throw Error(`Unexpected reference dependency: ${args.path}`);
        return { path: name, namespace: version };
      });
      b.onLoad({ filter: /.*/, namespace: version }, args => ({ contents: sources[args.path], loader: 'js' }));
    } }] });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
}
const old = await load('r4', r4Directory), corrected = await load('uploaded0112', codecDirectory, uploadedEngine);
const originalBytes = await fs.readFile(path.join(here, 'multiplayer-r4-rules-v1.json'));
const areaBytes = await fs.readFile(path.join(here, 'six-player-area-r4-v1.json'));
assert.equal(sha(originalBytes), '4b8f53b25fb971a97649b1f76eca69d142cf5cd41a44d7eeddce760741ccd490');
assert.equal(sha(areaBytes), 'a9b650290d7d06c0370b77894af106b30886295e368b71128a15cadd13b3ff2b');
const original = JSON.parse(originalBytes), area = JSON.parse(areaBytes), cases = [], documents = [], delta = [];
const digest = value => `sha256:${sha(old.canonicalize(value))}`;
function checkpoint(code, engine) {
  const snapshot = engine.getSnapshot();
  delete snapshot.initialPositions; // Additive 0.11 field is outside old snapshot commitments.
  return { stateHash: digest(code.serializeRuleState(engine)), snapshotHash: digest(snapshot),
    currentPlayer: snapshot.currentPlayer, turnCount: snapshot.turnCount, gameOver: snapshot.gameOver,
    winner: snapshot.winner, area: Object.fromEntries(snapshot.players.map(player => [player, snapshot.territories[player].area])) };
}
const apply = (engine, action) => action.type === 'move' ? engine.playMove(action.point)
  : action.type === 'skip' ? engine.skipTurn() : engine.resignPlayer(action.player);
for (const c of [...original.cases, ...area.cases]) {
  const expected = {};
  for (const [label, code] of [['r4', old], ['uploaded0112', corrected]]) {
    const engine = new code.GameEngine(c.settings), states = [checkpoint(code, engine)];
    const initial = { pointCount: engine.validPositions.length, positionsHash: digest(engine.validPositions),
      vertices: plain(engine.boardVertices), homes: plain(engine.initialPositions) };
    for (const [i, action] of c.actions.entries()) {
      assert.equal(apply(engine, action).success, true, `${label}/${c.id}/${i + 1}: original action remains legal`);
      states.push(checkpoint(code, engine));
    }
    const document = await code.createReplayDocument(c.settings, c.actions, digest);
    expected[label] = { initial, states, replayIntegrity: plain(document.integrity), terminal: plain(document.terminal) };
    if (label === 'r4') {
      assert.deepEqual(expected.r4, c.expected, `${c.id}: frozen r4 must still reproduce its original evidence`);
      const full = original.documents.find(item => item.id === c.id);
      if (full) assert.deepEqual(document, full.document, `${c.id}: original complete replay document`);
    } else if (original.documents.some(item => item.id === c.id)) documents.push({ id: c.id, document: plain(document) });
  }
  const changedCheckpoints = expected.r4.states.flatMap((previous, index) => {
    const fields = Object.keys(previous).filter(key => JSON.stringify(previous[key]) !== JSON.stringify(expected.uploaded0112.states[index][key]));
    return fields.length ? [{ index, fields }] : [];
  });
  const changedReplayFields = Object.keys(expected.r4.replayIntegrity).filter(key => expected.r4.replayIntegrity[key] !== expected.uploaded0112.replayIntegrity[key]);
  const terminalChanged = JSON.stringify(expected.r4.terminal) !== JSON.stringify(expected.uploaded0112.terminal);
  if (changedCheckpoints.length || changedReplayFields.length || terminalChanged) delta.push({ id: c.id, changedCheckpoints, changedReplayFields, terminalChanged });
  cases.push({ id: c.id, settingsActionsSha256: digest({ settings: c.settings, actions: c.actions }), expected: expected.uploaded0112 });
  console.log(JSON.stringify({ verified: c.id, changedCheckpoints: changedCheckpoints.length }));
}
const fixture = { schema: 'lifeline-uploaded-0112-multiplayer-rules-reference', version: 1,
  provenance: { sourceSha256: pins, candidateReceiptSha256: sha(candidateBytes),
    originalFixturesSha256: { 'multiplayer-r4-rules-v1.json': sha(originalBytes), 'six-player-area-r4-v1.json': sha(areaBytes) },
    generatorSha256: sha(await fs.readFile(fileURLToPath(import.meta.url))),
    oldSourceReexecuted: true, oldCheckpointsVerified: cases.reduce((n, c) => n + c.expected.states.length, 0),
    method: 'Original frozen r4 sources first reproduce every old expected checkpoint and complete document. The exact source pinned by official uploaded 0.11.2 then replays the same actions. Current engine and runtime are never imported. Only additive snapshot.initialPositions is excluded as in the historical comparison.' },
  cases, documents, delta };
await fs.writeFile(outputFile, `${JSON.stringify(fixture)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ output: path.resolve(outputFile), sha256: sha(await fs.readFile(outputFile)), cases: cases.length,
  checkpoints: fixture.provenance.oldCheckpointsVerified, delta }));
