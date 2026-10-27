import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { sut, plain, wireClone } from './helpers.mjs';
import {
  deserializeEngineEdges,
  serializeEngineState,
} from '../../../web/web前端/AIStateProtocol.js';

const playersFor = count => sut.PLAYER_ORDER.slice(0, count);

function customSettings(playerCount) {
  // Exercise both native and non-default board shapes. Rotating the default
  // roots makes every case explicitly custom while keeping the points valid.
  const boardShape = playerCount % 2 ? 'hexagon' : 'triangle';
  const players = playersFor(playerCount);
  const defaults = sut.resolveInitialPositions(7, playerCount, undefined, boardShape);
  const roots = players.map(player => defaults[player]);
  const initialPositions = Object.fromEntries(players.map((player, index) => [
    player,
    [...roots[(index + 1) % roots.length]],
  ]));
  return {
    ...sut.settingsFor(7, playerCount),
    boardShape,
    initialPositions,
  };
}

function assertV3Snapshot(snapshot, settings) {
  const players = playersFor(settings.playerCount);
  assert.equal(snapshot.playerCount, settings.playerCount);
  assert.equal(snapshot.boardShape, settings.boardShape);
  assert.deepEqual(plain(snapshot.initialPositions), settings.initialPositions);
  assert.deepEqual(plain(snapshot.players), players);
  for (const player of players) {
    const territory = snapshot.territories[player];
    assert.ok(territory, `missing ${player} territory`);
    assert.ok(Array.isArray(territory.renderPoints), `missing ${player} renderPoints`);
    assert.equal(territory.renderPoints.length, territory.area, `${player} paint/score mismatch`);
    assert.deepEqual(plain(territory.renderPoints), [settings.initialPositions[player]]);
    assert.ok(Array.isArray(snapshot.edges[player]), `missing ${player} edge set`);
  }
}

test('compiled Mini Worker snapshots retain V3 paint sets and complete 2-6 player configuration', async () => {
  const workerSource = await fs.readFile(new URL('../dist/workers/index.js', import.meta.url), 'utf8');
  let receive;
  const responses = [];
  const context = vm.createContext({ worker: {
    onMessage: callback => { receive = callback; },
    postMessage: message => { responses.push(wireClone(message)); },
  } });
  vm.runInContext(workerSource, context, { timeout: 2000 });
  assert.equal(typeof receive, 'function');

  for (let playerCount = 2; playerCount <= 6; playerCount++) {
    const settings = customSettings(playerCount);
    const id = `compiled-${playerCount}`;
    const result = receive(wireClone({ id, kind: 'STATE', payload: { settings, actions: [] } }));
    if (result?.then) await result;
    const response = responses.at(-1);
    assert.equal(response.id, id);
    assert.equal(response.ok, true, response.error);
    assertV3Snapshot(response.result.snapshot, settings);
  }
});

test('Web territory protocol retains shape, custom roots, every seat and renderPoints', async () => {
  const previousSelf = globalThis.self;
  const responses = [];
  const workerSelf = { postMessage: message => responses.push(wireClone(message)) };
  globalThis.self = workerSelf;
  try {
    await import(`../../../web/web前端/TerritoryWorker.js?territory-protocol-v3=${Date.now()}`);
    assert.equal(typeof workerSelf.onmessage, 'function');

    for (let playerCount = 2; playerCount <= 6; playerCount++) {
      const settings = customSettings(playerCount);
      const engine = new sut.GameEngine(settings);
      for (const player of engine.activePlayers) engine.edges[player].add(`edge-${player}`);
      const serializedState = serializeEngineState(engine);
      assert.equal(serializedState.playerCount, playerCount);
      assert.equal(serializedState.boardShape, settings.boardShape);
      assert.deepEqual(plain(serializedState.initialPositions), settings.initialPositions);
      assert.deepEqual(Object.keys(serializedState.edges), engine.activePlayers);
      const restoredEdges = deserializeEngineEdges(serializedState, engine.activePlayers);
      for (const player of engine.activePlayers) {
        assert.deepEqual([...restoredEdges[player]], [`edge-${player}`]);
      }

      const requestId = `source-${playerCount}`;
      workerSelf.onmessage({ data: {
        type: 'COMPUTE_TERRITORIES', requestId, serializedState,
        territoryStateRevision: engine.getTerritoryStateRevision(), gameOver: false,
      } });
      const response = responses.at(-1);
      assert.equal(response.type, 'RESULT', response.message);
      assert.equal(response.requestId, requestId);
      assert.deepEqual(Object.keys(response.territories).sort(), [...engine.activePlayers].sort());
      for (const player of engine.activePlayers) {
        const territory = response.territories[player];
        assert.ok(Array.isArray(territory.renderPoints));
        assert.equal(territory.renderPoints.length, territory.area);
        assert.deepEqual(plain(territory.renderPoints), [settings.initialPositions[player]]);
      }
    }

    const invalid = serializeEngineState(new sut.GameEngine(customSettings(4)));
    invalid.initialPositions.BLACK = [999, 999];
    workerSelf.onmessage({ data: {
      type: 'COMPUTE_TERRITORIES', requestId: 'invalid-custom-root', serializedState: invalid,
      territoryStateRevision: 0, gameOver: false,
    } });
    assert.equal(responses.at(-1).type, 'ERROR', 'Worker must consume and validate custom roots');
  } finally {
    globalThis.self = previousSelf;
  }
});
