import assert from 'node:assert/strict';
import test from 'node:test';
import { createTorusBoardDefinition } from '../src/core.js';
import {
  topologySettingsFor, restoreGame, ruleView, applyAction, normalizeGameSettings,
  createTopologyLocalGameSession, validateTopologyLocalGameSession,
  createTopologyReplayDocument, validateTopologyReplayDocument, settingsFor, TOPOLOGY_PROTOCOL_VERSION,
} from '../src/state.js';
import { GameSession } from '../src/session.js';
import { SaveStore } from '../src/storage.js';
import { executeTask } from '../src/worker-runtime.js';

const sut = Object.freeze({
  createTorusBoardDefinition, topologySettingsFor, restoreGame, ruleView, applyAction, normalizeGameSettings,
  createTopologyLocalGameSession, validateTopologyLocalGameSession,
  createTopologyReplayDocument, validateTopologyReplayDocument, settingsFor, TOPOLOGY_PROTOCOL_VERSION,
  GameSession, SaveStore, executeTask,
});

function localScheduler() {
  return {
    cancel() {},
    request(kind, payload, context) { return Promise.resolve().then(() => executeTask({ kind, payload, context })); },
  };
}

function memoryStorage() {
  const map = new Map();
  return { map, get: key => map.get(key), set: (key, value) => map.set(key, value) };
}

function topologySettings() {
  return sut.topologySettingsFor(sut.createTorusBoardDefinition({ width: 4, height: 4 }));
}

function viewFor(settings, actions = []) {
  return sut.executeTask({ kind: 'STATE', payload: { settings, actions }, context: {
    epoch: 0, revision: 0, rulesVersion: settings.rulesVersion, player: settings.startPlayer, boardHash: settings.boardHash,
    topologyProtocolVersion: settings.topologyProtocolVersion,
  } });
}

function liveContext(view, epoch = 0) {
  return {
    epoch,
    revision: view.snapshot.positionRevision,
    rulesVersion: view.snapshot.rulesVersion,
    player: view.snapshot.currentPlayer,
    boardHash: view.boardHash,
    topologyProtocolVersion: view.topologyProtocolVersion,
  };
}

test('surface-v1 state uses a canonical topology board and rejects coordinate moves', () => {
  const settings = topologySettings();
  const engine = sut.restoreGame(settings);
  const view = sut.ruleView(engine);
  const move = view.snapshot.legalMoves[0];

  assert.equal(engine.isTopologyBoard, true);
  assert.equal(settings.rulesVersion, 'surface-v1');
  assert.equal(settings.topologyProtocolVersion, sut.TOPOLOGY_PROTOCOL_VERSION);
  assert.equal(settings.boardShape, 'custom');
  assert.equal(typeof settings.boardHash, 'string');
  assert.equal(sut.applyAction(engine, { type: 'move', player: 'BLACK', vertexId: move.vertexId }).success, true);
  assert.throws(() => sut.applyAction(sut.restoreGame(settings), { type: 'move', player: 'BLACK', point: move.point }),
    /INVALID_TOPOLOGY_VERTEX/);
});

test('surface-v1 normalization refuses a mismatched board hash and legacy roots', () => {
  const settings = topologySettings();
  const withoutProtocol = { ...settings };
  delete withoutProtocol.topologyProtocolVersion;
  assert.equal(sut.normalizeGameSettings(withoutProtocol).topologyProtocolVersion, sut.TOPOLOGY_PROTOCOL_VERSION);
  assert.throws(() => sut.normalizeGameSettings({ ...settings, topologyProtocolVersion: 'board-topology-v0' }),
    /INVALID_TOPOLOGY_PROTOCOL/);
  assert.throws(() => sut.normalizeGameSettings({ ...settings, boardHash: '0'.repeat(64) }), /BOARD_HASH_MISMATCH/);
  assert.throws(() => sut.normalizeGameSettings({ ...settings, rootMode: 'add' }), /TOPOLOGY_ROOT_MODE_UNSUPPORTED/);
  assert.throws(() => sut.normalizeGameSettings({ ...settings, initialPositions: { BLACK: [0, 0] } }),
    /TOPOLOGY_STARTS_MUST_BE_IN_BOARD_DEFINITION/);
});

test('topology session and replay round trips commit board, state and actions together', async () => {
  const settings = topologySettings();
  const store = new sut.SaveStore(memoryStorage());
  const session = new sut.GameSession(localScheduler(), store);
  assert.equal(await session.newTopologyGame(settings, 'human', 'normal'), true);
  const move = session.snapshot.legalMoves[0];
  assert.equal(await session.act({ type: 'move', vertexId: move.vertexId }), true);
  const captured = session.capture();
  const validated = sut.validateTopologyLocalGameSession(captured.session);

  assert.equal(validated.boardHash, session.snapshot.boardHash);
  assert.equal(validated.topologyProtocolVersion, sut.TOPOLOGY_PROTOCOL_VERSION);
  assert.equal(validated.settings.topologyProtocolVersion, sut.TOPOLOGY_PROTOCOL_VERSION);
  assert.equal(validated.stateHash, session.stateHash);
  assert.deepEqual(validated.topologyState, session.topologyState);
  assert.deepEqual(validated.actions, session.actions);

  const replay = sut.createTopologyReplayDocument(session.settings, session.actions);
  const imported = sut.validateTopologyReplayDocument(replay);
  assert.equal(replay.topologyProtocolVersion, sut.TOPOLOGY_PROTOCOL_VERSION);
  assert.equal(imported.topologyProtocolVersion, sut.TOPOLOGY_PROTOCOL_VERSION);
  assert.equal(imported.boardHash, session.snapshot.boardHash);
  assert.equal(imported.stateHash, session.stateHash);

  const restored = new sut.GameSession(localScheduler(), store);
  assert.equal(await restored.restore(), true);
  assert.equal(restored.stateHash, session.stateHash);
  assert.equal(restored.snapshot.boardHash, session.snapshot.boardHash);
  assert.deepEqual(restored.actions, session.actions);
});

test('topology Worker AI uses only the generic graph route and returns vertexId actions', async () => {
  const settings = topologySettings();
  const view = await viewFor(settings);
  const response = await sut.executeTask({
    kind: 'AI', payload: { settings, actions: [], profile: 'topology-generic' }, context: liveContext(view),
  });
  assert.equal(response.profile, 'topology-generic');
  assert.equal(response.moves[0].type, 'move');
  assert.equal(typeof response.moves[0].vertexId, 'string');
  assert.equal(Object.hasOwn(response.moves[0], 'point'), false);

  assert.throws(() => sut.executeTask({
    kind: 'AI', payload: { settings, actions: [], profile: 'minimax-2' }, context: liveContext(view),
  }), /TOPOLOGY_FIXED_SHAPE_PROFILE_UNSUPPORTED/);
  assert.throws(() => sut.executeTask({
    kind: 'AI', payload: { settings, actions: [], profile: 'topology-generic', model: { id: 'legacy' } }, context: liveContext(view),
  }), /TOPOLOGY_MODEL_UNSUPPORTED/);
});

test('topology live Worker tasks fail closed on stale board identity or revision', () => {
  const settings = topologySettings();
  const view = viewFor(settings);
  const action = { type: 'move', vertexId: view.snapshot.legalMoves[0].vertexId };
  assert.throws(() => sut.executeTask({
    kind: 'APPLY', payload: { settings, actions: [], action }, context: { ...liveContext(view), boardHash: 'stale' },
  }), /STALE_TOPOLOGY_BOARD/);
  assert.throws(() => sut.executeTask({
    kind: 'TERRITORY', payload: { settings, actions: [] }, context: { ...liveContext(view), revision: 1 },
  }), /STALE_TOPOLOGY_REVISION/);
  assert.throws(() => sut.executeTask({
    kind: 'AI', payload: { settings, actions: [], profile: 'topology-generic' },
    context: { ...liveContext(view), topologyProtocolVersion: 'board-topology-v0' },
  }), /STALE_TOPOLOGY_PROTOCOL/);
});

test('legacy territory-v3 state and coordinate actions remain valid', () => {
  const settings = sut.settingsFor(5);
  const view = viewFor(settings);
  const point = view.snapshot.legalMoves[0].point;
  const updated = sut.executeTask({
    kind: 'APPLY', payload: { settings, actions: [], action: { type: 'move', point } }, context: liveContext(view),
  });
  assert.equal(updated.snapshot.rulesVersion, 'territory-v3');
  assert.equal(updated.snapshot.turnCount, 1);
});
