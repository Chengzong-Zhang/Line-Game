import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, memoryStorage } from './helpers.mjs';

const settings = rootMode => ({ ...sut.settingsFor(5), rootMode, rootRulesVersion: 'root-v2' });

function advanceUntilRootAction(engine, limit = 80) {
  const history = [];
  for (let turn = 0; turn < limit && !engine.gameOver; turn++) {
    const actions = engine.getLegalRootActions();
    if (actions.length) return { action: actions[0], history };
    const move = engine.getLegalMoves()[0];
    const actor = engine.currentPlayer;
    const result = move ? engine.playMove(move.point) : engine.skipTurn();
    assert.equal(result.success, true);
    history.push({ type: move ? 'move' : 'skip', ...(move ? { point: move.point } : {}), player: actor });
  }
  return null;
}

test('mini-game state exposes every root mode while legacy settings stay classic', () => {
  const classic = sut.restoreGame(sut.settingsFor(5));
  assert.equal(classic.rootMode, 'classic');
  assert.equal(classic.rootRulesVersion, 'root-v1');
  for (const mode of ['fixed-double', 'relocate', 'add']) {
    const engine = sut.restoreGame(settings(mode));
    assert.equal(engine.rootMode, mode);
    assert.equal(engine.rootRulesVersion, 'root-v2');
    assert.equal(engine.getRoots('BLACK').length, mode === 'fixed-double' ? 2 : 1);
  }
  assert.throws(() => sut.validateSettings({ ...settings('add'), playerCount: 3 }), /INVALID_ROOT_MODE/);
});

for (const mode of ['relocate', 'add']) test(`${mode} is an atomic full-turn action and survives save validation`, () => {
  const engine = sut.restoreGame(settings(mode));
  const prepared = advanceUntilRootAction(engine);
  assert.ok(prepared, `${mode} action becomes legal`);
  const { action, history } = prepared;
  const actor = engine.currentPlayer, beforeTurn = engine.turnCount;
  const beforeRoots = engine.getRoots(actor);
  const result = sut.applyAction(engine, { ...action, player: actor });
  assert.equal(result.success, true);
  assert.equal(engine.turnCount, beforeTurn + 1);
  assert.equal(engine.rootActionsRemaining[actor][mode], 0);
  assert.equal(engine.getRoots(actor).length, mode === 'add' ? 2 : 1);
  if (mode === 'relocate') assert.notDeepEqual(engine.getRoots(actor), beforeRoots);

  const actions = [...history, { ...action, player: actor }];
  const document = sut.createLocalGameSession(settings(mode), actions);
  assert.equal(document.schemaVersion, 2);
  const payload = { session: document, mode: 'human', difficulty: 'normal' };
  assert.doesNotThrow(() => sut.validateSave(payload));
  const store = new sut.SaveStore(memoryStorage());
  assert.equal(store.save(payload), 1);
  assert.equal(store.read().records.length, 1);
});

test('new modes fail closed for trained controllers and old contribution contracts', () => {
  for (const mode of ['fixed-double', 'relocate', 'add']) {
    assert.deepEqual(sut.controllerChoices({ ...settings(mode), boardShape: 'triangle' }), sut.BASIC_CONTROLLERS);
    assert.throws(() => sut.validateControllers({ BLACK: 'model:dqn-all-sizes-e2000', WHITE: 'human' }, settings(mode)), /INVALID_CONTROLLERS/);
  }
});

test('online snapshots and retry records preserve exact root actions', () => {
  const config = settings('add');
  const engine = sut.restoreGame(config);
  const state = sut.ruleView(engine);
  const room = { protocol: 1, code: 'ABCDEFGH', matchId: 'a'.repeat(32), revision: 1, seq: 0,
    status: 'playing', player: 'BLACK', currentPlayer: state.snapshot.currentPlayer, settings: config,
    actions: [], actionIds: [], stateHash: state.stateHash, ready: {}, members: {}, rematchVotes: {},
    undo: { usedCount: 0, pending: false, votes: [] } };
  assert.equal(sut.validateRoom(room), room);
  assert.equal(state.snapshot.rootMode, 'add');
  assert.equal(state.snapshot.rootActionsRemaining.BLACK.add, 1);
});
