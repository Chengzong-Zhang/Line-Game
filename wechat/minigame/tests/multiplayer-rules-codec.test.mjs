import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from '../tools/native-build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureBytes = await fs.readFile(new URL('./fixtures/multiplayer-r4-rules-v1.json', import.meta.url));
const fixture = JSON.parse(fixtureBytes);
const areaBytes = await fs.readFile(new URL('./fixtures/six-player-area-r4-v1.json', import.meta.url));
const areaFixture = JSON.parse(areaBytes);
const originalCases = [...fixture.cases, ...areaFixture.cases];
const correctedBytes = await fs.readFile(new URL('./fixtures/multiplayer-uploaded-0112-v1.json', import.meta.url));
const correctedFixture = JSON.parse(correctedBytes);
const correctedById = new Map(correctedFixture.cases.map(c => [c.id, c]));
const cases = originalCases.map(c => ({ ...c, expected: correctedById.get(c.id).expected }));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const plain = value => JSON.parse(JSON.stringify(value));
// This suite builds only the rules/codec interface in memory. It does not use
// mutable default dist, an AI algorithm, the application, or private fixtures.
const options = { stdin: { contents: "export * from './src/core.js'; export * from './src/state.js'; export * from './src/integrity.js';", resolveDir: root },
  bundle: true, write: false, platform: 'browser', target: 'es2018',
  plugins: [{ name: 'cache-query', setup(b) { b.onResolve({ filter: /\?v=/ }, a => ({ path: path.resolve(a.resolveDir, a.path.split('?')[0]) })); } }] };
const result = await build({ ...options, format: 'iife', globalName: 'RulesUnderTest' });
const sandbox = vm.createContext({});
vm.runInContext(result.outputFiles[0].text, sandbox, { timeout: 10000 });
const native = sandbox.RulesUnderTest;
// The large reference comparison uses the normal Node realm. Keep the native
// capability probe small; VM overhead is not a phone performance measurement.
const module = await build({ ...options, format: 'esm' });
const sut = await import(`data:text/javascript;base64,${Buffer.from(module.outputFiles[0].text).toString('base64')}`);
const colors = ['BLACK', 'WHITE', 'PURPLE', 'GREEN', 'ORANGE', 'CYAN'];
function checkpoint(engine) {
  const snapshot = engine.getSnapshot();
  // Resolved initial positions are additive in 0.11. Both independent fixtures
  // exclude this field; the 0.11.2 reconnection correction is pinned separately.
  delete snapshot.initialPositions;
  return plain({ stateHash: sut.checksum(sut.serializeRuleState(engine)), snapshotHash: sut.checksum(snapshot),
    currentPlayer: snapshot.currentPlayer, turnCount: snapshot.turnCount, gameOver: snapshot.gameOver,
    winner: snapshot.winner, area: Object.fromEntries(snapshot.players.map(p => [p, snapshot.territories[p].area])) });
}

test('portable reference pins the frozen r4 engine and the independently compared 0.9.2 baseline', async () => {
  assert.equal(fixture.schema, 'lifeline-r4-multiplayer-rules-reference');
  assert.equal(sha(fixtureBytes), '4b8f53b25fb971a97649b1f76eca69d142cf5cd41a44d7eeddce760741ccd490');
  assert.equal(fixture.cases.length, 41); assert.equal(fixture.cases.filter(c => c.legacy092Compared).length, 14);
  assert.equal(fixture.cases.reduce((n,c) => n + c.expected.states.length, 0), 294);
  assert.equal(sha(areaBytes), 'a9b650290d7d06c0370b77894af106b30886295e368b71128a15cadd13b3ff2b');
  assert.deepEqual(areaFixture.sourceSha256, fixture.provenance.frozenR4SourceSha256);
  assert.equal(fixture.provenance.frozenR4SourceSha256['GameEngine.js'], '625e8d8a92801647702f963f56148040248cf471228a6ce5c719e20e4414a555');
  assert.equal(fixture.provenance.legacy092SourceSha256['GameEngine.js'], '8db6b7a516dfb63efe4ca3abe7adaf35d563b48cfbc49130e71f03bcf0591b12');
  assert.equal(fixture.provenance.legacy092SourceSha256['ReplayCodec.js'], 'be0e6ac0a1f26f0c36eba41266bab931b9bf36c6eebb57ddd63513ea5573acf5');
  assert.equal(sha(await fs.readFile(new URL('./fixtures/generate-multiplayer-reference.mjs', import.meta.url))), fixture.provenance.generatorSha256);
  for (const name of ['window', 'document', 'wx', 'URL', 'fetch', 'TextEncoder', 'crypto', 'structuredClone', 'require']) {
    assert.equal(vm.runInContext(`typeof ${name}`, sandbox), 'undefined', name);
  }
});

test('independent uploaded 0.11.2 reference preserves r4 evidence and pins exactly four corrected checkpoints', async () => {
  assert.equal(sha(correctedBytes), '7211e98a59410bb40b0946f95cd27c0b2fb43ea369b6f2880515f6a49a5b7188');
  assert.equal(correctedFixture.schema, 'lifeline-uploaded-0112-multiplayer-rules-reference');
  assert.equal(correctedFixture.version, 1);
  const provenance = correctedFixture.provenance;
  assert.deepEqual(provenance.sourceSha256.r4, fixture.provenance.frozenR4SourceSha256);
  assert.deepEqual(provenance.sourceSha256.uploaded0112, {
    'GameEngine.js': '9d88e2716134355b1388a98f9a36679e3f68f370c6cb00e4501d4cf8cdf3758e',
    'ReplayCodec.js': '76b5bdef75adb1b91a7e61c9e085c651f78cf5e825bbd429de99535a2124e923',
    'StartingPoints.js': '7b09547988a75cbccda06fbd554af8aaa18957f9b3029d772106894e4921894d',
  });
  assert.equal(provenance.candidateReceiptSha256, 'c3bedc62529bc7ca67c8d0c12049fcc39f34feb539f67400dd1d55758eccc922');
  assert.deepEqual(provenance.originalFixturesSha256, {
    'multiplayer-r4-rules-v1.json': sha(fixtureBytes), 'six-player-area-r4-v1.json': sha(areaBytes),
  });
  assert.equal(provenance.oldSourceReexecuted, true);
  assert.equal(provenance.oldCheckpointsVerified, 302);
  assert.equal(sha(await fs.readFile(new URL('./fixtures/generate-multiplayer-0112-reference.mjs', import.meta.url))), provenance.generatorSha256);
  assert.deepEqual(correctedFixture.cases.map(c => c.id), originalCases.map(c => c.id));
  assert.deepEqual(correctedFixture.documents.map(c => c.id), fixture.documents.map(c => c.id));
  const delta = [];
  for (const original of originalCases) {
    const corrected = correctedById.get(original.id);
    assert.equal(sut.checksum({ settings: original.settings, actions: original.actions }), corrected.settingsActionsSha256, original.id);
    assert.deepEqual(corrected.expected.initial, original.expected.initial, `${original.id}: unchanged geometry and homes`);
    assert.equal(corrected.expected.states.length, original.expected.states.length);
    const changedCheckpoints = original.expected.states.flatMap((previous, index) => {
      const fields = Object.keys(previous).filter(key => JSON.stringify(previous[key]) !== JSON.stringify(corrected.expected.states[index][key]));
      return fields.length ? [{ index, fields }] : [];
    });
    const changedReplayFields = Object.keys(original.expected.replayIntegrity)
      .filter(key => original.expected.replayIntegrity[key] !== corrected.expected.replayIntegrity[key]);
    const terminalChanged = JSON.stringify(original.expected.terminal) !== JSON.stringify(corrected.expected.terminal);
    if (changedCheckpoints.length || changedReplayFields.length || terminalChanged) delta.push({ id: original.id, changedCheckpoints, changedReplayFields, terminalChanged });
  }
  const expectedDelta = [
    { id: '3p-5-black-moves', changedCheckpoints: [{ index: 6, fields: ['stateHash', 'snapshotHash'] }],
      changedReplayFields: ['finalEventHash', 'finalStateHash', 'canonicalDocumentHash'], terminalChanged: false },
    { id: '3p-5-black-resign', changedCheckpoints: [6, 7, 8].map(index => ({ index, fields: ['stateHash', 'snapshotHash'] })),
      changedReplayFields: ['finalEventHash', 'finalStateHash', 'canonicalDocumentHash'], terminalChanged: true },
  ];
  assert.deepEqual(delta, expectedDelta);
  assert.deepEqual(correctedFixture.delta, expectedDelta);
});

test('all 302 rule and snapshot checkpoints match uploaded 0.11.2, including all six starters and precise terminal areas', () => {
  for (const c of cases) {
    const engine = sut.restoreGame(c.settings);
    assert.deepEqual(checkpoint(engine), c.expected.states[0], `${c.id}/initial`);
    assert.equal(engine.validPositions.length, c.expected.initial.pointCount);
    assert.equal(sut.checksum(engine.validPositions), c.expected.initial.positionsHash);
    assert.deepEqual(plain(engine.boardVertices), c.expected.initial.vertices);
    assert.deepEqual(plain(engine.initialPositions), c.expected.initial.homes);
    c.actions.forEach((action, index) => {
      assert.equal(sut.applyAction(engine, action).success, true, `${c.id}/${index}`);
      assert.deepEqual(checkpoint(engine), c.expected.states[index + 1], `${c.id}/${index + 1}`);
    });
    // Batch replay restores the same complete history and turn state.
    assert.deepEqual(checkpoint(sut.restoreGame(c.settings, c.actions)), c.expected.states.at(-1), `${c.id}/batch`);
  }
  const natural = fixture.cases.find(c => c.id === '3p-5-black-natural');
  assert.deepEqual(natural.expected.states.at(-1).area, { BLACK: 0, WHITE: 6, PURPLE: 4 });
  for (const count of [4,5,6]) assert.ok(cases.some(c => c.settings.playerCount === count && c.expected.states.some(s => Object.values(s.area).some(area => area > 0))), `${count}: nonzero territory witness`);
});

test('every replay preserves frozen hashes and imports through the canonical hash adapter', async () => {
  for (const c of cases) {
    const document = await sut.createReplayDocument(c.settings, c.actions, sut.checksum);
    assert.deepEqual(plain(document.integrity), c.expected.replayIntegrity, c.id);
    assert.deepEqual(plain(document.terminal), c.expected.terminal, c.id);
    const validated = await sut.validateReplayDocument(document, sut.checksum);
    assert.equal(validated.success, true, `${c.id}: ${validated.reason}`);
    assert.equal(validated.finalStateHash, c.expected.states.at(-1).stateHash);
    assert.equal(validated.eventCount, c.actions.length);
    assert.equal(sut.ruleView(sut.restoreGame(validated.settings, validated.actions)).stateHash, validated.finalStateHash);
    if (c.legacy092Compared) {
      assert.deepEqual(Object.keys(document.initialState.ruleState.edges), ['BLACK', 'WHITE', 'PURPLE']);
      for (const event of document.actions) assert.deepEqual(Object.keys(event.effects.territoryDelta), ['BLACK', 'WHITE', 'PURPLE']);
    }
  }
  for (const { id, document } of correctedFixture.documents) {
    const c = cases.find(item => item.id === id);
    assert.deepEqual(plain(await sut.createReplayDocument(c.settings, c.actions, sut.checksum)), document, `${id}: complete reference document`);
  }
});

test('native-like rules and six-player replay round-trip without DOM, TextEncoder or WebCrypto', async () => {
  const c = cases.find(item => item.id === '6p-5-black-pass');
  const document = await native.createReplayDocument(c.settings, c.actions, native.checksum);
  assert.deepEqual(plain(document.integrity), c.expected.replayIntegrity);
  const validated = await native.validateReplayDocument(document, native.checksum);
  assert.equal(validated.success, true);
  assert.equal(native.ruleView(native.restoreGame(validated.settings, validated.actions)).stateHash, c.expected.states.at(-1).stateHash);
});

test('strict settings and exported geometry reject unseated actors and triangular cutouts without mutating a hex board', () => {
  assert.deepEqual(plain(sut.PLAYER_ORDER.slice(0, colors.length)), colors, 'legacy seat identities keep their existing order');
  for (const count of [2,3,4,5,6]) {
    for (const startPlayer of colors.slice(0, count)) assert.equal(sut.validateSettings(sut.settingsFor(5, count, startPlayer)).startPlayer, startPlayer);
    for (const startPlayer of [...colors.slice(count), '', 'BLACK ', 'GREEN_NODE', 0, null]) assert.throws(() => sut.restoreGame(sut.settingsFor(5, count, startPlayer)), /INVALID_SETTINGS/);
    for (const size of [5,7,15]) {
      const positions = plain(sut.getBoardPositions(size, count)), vertices = plain(sut.getBoardVertices(size, count));
      assert.equal(positions.length, count >= 4 ? 3 * size * (size - 1) + 1 : size * (size + 1) / 2);
      assert.equal(vertices.length, count >= 4 ? 6 : 3);
      assert.ok([...positions, ...vertices].every(p => sut.isBoardPoint(p, size, count)));
      assert.equal(new Set(positions.map(p => p.join(','))).size, positions.length);
    }
  }
  for (const count of [0,1,16,2.5,'4',NaN,Infinity,null]) assert.throws(() => sut.restoreGame(sut.settingsFor(5, count)), /INVALID_SETTINGS/);
  for (const size of [4,16,5.5,'5',NaN]) assert.throws(() => sut.restoreGame(sut.settingsFor(size, 6)), /INVALID_SETTINGS/);
  for (const count of [4,5,6]) {
    const engine = sut.restoreGame(sut.settingsFor(5, count)), before = checkpoint(engine);
    for (const point of [[0,0],[8,8],[-1,4],[9,4],[4,0.5],[4]]) assert.throws(() => sut.applyAction(engine, { type: 'move', point }), /INVALID_POINT/);
    assert.throws(() => sut.applyAction(engine, { type: 'move', player: 'WHITE', point: engine.getLegalMoves()[0].point }), /WRONG_PLAYER/);
    assert.throws(() => sut.applyAction(engine, { type: 'resign', player: 'NOT_A_SEAT' }), /INVALID_ACTION/);
    assert.deepEqual(checkpoint(engine), before);
  }
});

test('six-seat settings round-trip through the existing local-session schema without adding Web role data', () => {
  for (const c of cases) {
    const local = sut.createLocalGameSession(c.settings, c.actions);
    assert.equal(local.schemaVersion, 1); assert.equal(local.format, 'lifeline-local-session');
    assert.deepEqual(plain(local.settings), { ...c.settings,
      protectionRule: c.settings.protectionRule ?? 'symmetric-v1',
      boardShape: c.settings.playerCount >= 4 ? 'hexagon' : 'triangle' });
    assert.equal(local.match, undefined);
    assert.equal(sut.ruleView(sut.restoreGame(local.settings, local.actions)).stateHash, c.expected.states.at(-1).stateHash);
  }
  for (const patch of [{ playerCount: 16 }, { playerCount: 1 }, { playerCount: '4' }, { playerCount: 4, startPlayer: 'CYAN' }, { gridSize: 16 }]) {
    assert.throws(() => sut.createLocalGameSession({ ...sut.settingsFor(5,4), ...patch }), /valid settings/);
  }
});

test('hex Superko rejects a repeated state and preserves complete history, edges and exact snapshot', () => {
  for (const count of [4,5,6]) {
    const settings = sut.settingsFor(5, count, colors[count - 1]);
    const engine = sut.restoreGame(settings), point = [...engine.getLegalMoves()[0].point];
    const probe = sut.restoreGame(settings, [{ type: 'move', player: engine.currentPlayer, point }]);
    engine.historyHashes.add(probe._computeStateHash(probe.currentPlayer));
    const before = checkpoint(engine), history = [...engine.historyHashes];
    assert.equal(engine.playMove(point).reason, 'SUPERKO_VIOLATION');
    assert.deepEqual(checkpoint(engine), before); assert.deepEqual([...engine.historyHashes], history);
    const untouched = sut.restoreGame(settings), original = checkpoint(untouched);
    assert.throws(() => untouched.replayBatch(transaction => { transaction.playMove(point); throw new Error('abort'); }), /abort/);
    assert.deepEqual(checkpoint(untouched), original);
  }
});

function reseal(document) {
  let previous = 'GENESIS';
  for (const event of document.actions) {
    event.prevEventHash = previous;
    const body = { ...event }; delete body.eventHash;
    previous = event.eventHash = sut.checksum(body);
  }
  document.integrity.finalEventHash = document.actions.length ? previous : null;
  document.integrity.canonicalDocumentHash = null;
  document.integrity.canonicalDocumentHash = sut.checksum(document);
  return document;
}
test('semantic replay tampering is rejected even after attacker recomputes all document and event hashes', async () => {
  const original = correctedFixture.documents.find(item => item.id.startsWith('6p-')).document;
  const before = JSON.stringify(original);
  for (const mutate of [
    d => { d.config.players[5] = 'GREEN'; },
    d => { d.initialState.ruleState.gridEntries[0][2] = 11; },
    d => { d.actions[0].actor = 'CYAN'; },
    d => { d.actions[0].effects.territoryDelta.CYAN += 1; },
    d => { d.terminal.winner = 'BLACK'; },
    d => { d.terminal = null; },
  ]) {
    const changed = plain(original); mutate(changed); reseal(changed);
    const answer = await sut.validateReplayDocument(changed, sut.checksum);
    assert.equal(answer.success, false, 'forged replay must be rejected');
  }
  const validated = await sut.validateReplayDocument(original, sut.checksum);
  assert.equal(validated.success, true); assert.equal(JSON.stringify(original), before);
});
