import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, until, memoryStorage } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';

const onlineConfig = { onlineEnabled: true, apiBase: 'https://test.invalid' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('late direct create/join/resume consent and join input never enter after leaving/backgrounding', async () => {
  for (const entry of ['friends', 'join-room', 'resume-room']) for (const boundary of entry === 'join-room' ? ['consent', 'input'] : ['consent'])
    for (const leave of ['home', 'hide', 'dispose']) {
    const storage = memoryStorage(); storage.set('lifeline-wx-room-v1', 'ABCDEFGH');
    const h = uiHarness({ config: onlineConfig, storage }), { app, p, tap, render, scrollTo } = h;
    let resolve, enters = 0;
    app.online.enter = async () => { enters++; return true; };
    p.choose = async () => { throw new Error('Direct room buttons must not open an action sheet'); };
    p.input = async () => 'ABCDEFGH';
    const pending = () => new Promise(done => { resolve = done; });
    if (boundary === 'consent') p.confirm = pending;
    if (boundary === 'input') p.input = pending;
    try {
      await until(() => app.session.snapshot && !app.session.busy);
      await tap('cabin-battle'); await scrollTo(entry);
      await tap(entry); await until(() => resolve);
      if (leave === 'home') await tap('cabin-board');
      if (leave === 'hide') { p.callbacks.hide(); p.callbacks.show(); }
      if (leave === 'dispose') app.dispose();
      resolve(boundary === 'consent' ? true : 'ABCDEFGH');
      await sleep(25);
      assert.equal(enters, 0, `${entry}/${boundary}/${leave}: stale dialog must not enter a room`);
      assert.notEqual(app.session, app.online.game);
    } finally { app.dispose(); }
  }
});

test('direct resign/leave confirmations remain bound to room, position and foreground lifecycle', async () => {
  for (const kind of ['resign-after-hide', 'resign-after-move', 'resign-after-room-change', 'leave-after-rematch', 'leave-after-cabin-change']) {
    const { app, p, tap, render, scrollTo } = uiHarness({ config: onlineConfig });
    let confirmation, sends = 0;
    p.choose = async () => { throw new Error('Direct room actions must not open an action sheet'); };
    app.online.enter = async () => {
      const client = app.online;
      await client.game.load(sut.settingsFor(7), [], { mode: 'human', paused: true, save: false });
      client.active = client.connected = true;
      client.room = { code: 'ABCDEFGH', matchId: 'a'.repeat(32), seq: 0, stateHash: client.game.stateHash,
        status: 'playing', player: 'BLACK', settings: client.game.settings, ready: {}, rematchVotes: {} };
      client.notify(); return true;
    };
    app.online.act = async () => { sends++; return true; };
    app.online.command = async () => { sends++; return true; };
    app.online.foreground = async () => { app.online.active = app.online.connected = true; app.online.game.show(); };
    try {
      await until(() => app.session.snapshot && !app.session.busy);
      await tap('cabin-battle'); await scrollTo('friends'); await tap('friends'); await until(() => app.online.room);
      await render();
      p.confirm = () => new Promise(done => { confirmation = done; });
      if (kind.startsWith('leave-')) { await tap('cabin-battle'); await scrollTo('battle-leave'); await tap('battle-leave'); }
      else await tap('resign');
      await until(() => confirmation);
      if (kind === 'resign-after-move') {
        await app.online.game.load(sut.settingsFor(7), [{ type: 'move', point: [1, 0] }], { mode: 'human', save: false, paused: true });
        app.online.room = { ...app.online.room, seq: 1, stateHash: app.online.game.stateHash, player: 'WHITE' };
      } else if (kind === 'resign-after-room-change') app.online.room = { ...app.online.room, code: 'BCDEFGHJ' };
      else if (kind === 'resign-after-hide') { p.callbacks.hide(); p.callbacks.show(); }
      else if (kind === 'leave-after-cabin-change') await tap('cabin-guide');
      else app.online.room = { ...app.online.room, matchId: 'b'.repeat(32) };
      confirmation(true);
      await sleep(25); assert.equal(sends, 0, kind);
    } finally { app.dispose(); }
  }
});

test('direct create/join/resume dispatch expected requests without a menu and normalize join codes', async () => {
  for (const [entry, kind, value] of [['friends', 'create', { rulesVersion: 'territory-v3', gridSize: 7, boardShape: 'triangle', startingPointMode: 'default', undoEnabled: false, undoMaxCount: 3 }], ['join-room', 'join', 'BCDEFGHJ'], ['resume-room', 'resume', 'ABCDEFGH']]) {
    const storage = memoryStorage(); storage.set('lifeline-wx-room-v1', 'ABCDEFGH');
    const h = uiHarness({ config: onlineConfig, storage });
    // A detached previous v2 room must not supply the next room's rule settings.
    h.app.online.room = { settings: { gridSize: 5, rulesVersion: 'territory-v2' } };
    const calls = []; h.app.online.enter = async (...args) => { calls.push(args); return true; };
    h.p.choose = async () => { throw new Error('Unexpected room action sheet'); };
    h.p.input = async () => '  bcdefghj  ';
    try {
      await until(() => h.app.session.snapshot && !h.app.session.busy);
      await h.tap('cabin-battle'); await h.scrollTo(entry); await h.tap(entry); await until(() => calls.length);
      assert.deepEqual(calls, [[kind, value]]);
      assert.equal(h.app.session, h.app.online.game);
      assert.equal(h.app.getCabin(), null);
    } finally { h.app.dispose(); }
  }
});

test('room host can change starting points and undo settings; guest votes on an undo', async () => {
  const h = uiHarness({ config: onlineConfig });
  const { app, tap, render, scrollTo } = h;
  const settings = { ...sut.settingsFor(7), boardShape: 'triangle', undoEnabled: true, undoMaxCount: 2 };
  const edits = [], votes = [];
  app.online.enter = async () => {
    await app.online.game.load(settings, [], { mode: 'human', paused: true, save: false });
    app.online.active = app.online.connected = true;
    app.online.room = { code: 'ABCDEFGH', matchId: 'a'.repeat(32), seq: 0, stateHash: app.online.game.stateHash,
      status: 'waiting', player: 'BLACK', settings, ready: { BLACK: false, WHITE: false }, rematchVotes: {},
      actions: [], undo: { usedCount: 0, pending: false, votes: [] } };
    app.online.notify(); return true;
  };
  app.online.updateSettings = async value => { edits.push(value); return true; };
  app.online.voteUndo = async value => { votes.push(value); return true; };
  try {
    await until(() => app.session.snapshot && !app.session.busy);
    await tap('cabin-battle'); await scrollTo('friends'); await tap('friends'); await until(() => app.online.room);
    await tap('cabin-board'); await scrollTo('starts-random'); await render();
    assert.equal(app.getButtons().find(button => button.id === 'starts-random').disabled, false);
    await tap('starts-random');
    assert.equal(edits.length, 1);
    assert.equal(edits[0].startingPointMode, 'random');
    assert.notDeepEqual(edits[0].initialPositions.BLACK, edits[0].initialPositions.WHITE);
    app.online.room = { ...app.online.room, player: 'WHITE' }; await render();
    assert.equal(app.getButtons().find(button => button.id === 'starts-random').disabled, true);
    await tap('cabin-close');
    await app.online.game.load(settings, [{ type: 'skip', player: 'BLACK' }], { mode: 'human', paused: true, save: false });
    app.online.room = { ...app.online.room, status: 'playing', seq: 1, actions: [{ type: 'skip', player: 'BLACK' }],
      stateHash: app.online.game.stateHash, undo: { usedCount: 0, pending: true, votes: ['BLACK'] } };
    await render();
    assert.ok(app.getButtons().find(button => button.id === 'undo-accept'));
    await tap('undo-accept'); assert.deepEqual(votes, [true]);
    await tap('undo-reject'); assert.deepEqual(votes, [true, false]);
  } finally { app.dispose(); }
});

test('direct skip rejects a stale touch; visible share/resign/leave actions dispatch only the current choice', async () => {
  const { app, p, tap, render, scrollTo } = uiHarness({ config: onlineConfig });
  const actions = [], commands = [], shares = [];
  p.choose = async () => { throw new Error('Direct actions must not open an action sheet'); };
  p.share = payload => shares.push(payload);
  app.online.enter = async () => {
    const client = app.online;
    await client.game.load(sut.settingsFor(7), [], { mode: 'human', paused: true, save: false });
    client.active = client.connected = true;
    client.room = { code: 'ABCDEFGH', matchId: 'a'.repeat(32), seq: 0, stateHash: client.game.stateHash,
      status: 'playing', player: 'BLACK', settings: client.game.settings, ready: {}, rematchVotes: {} };
    client.notify(); return true;
  };
  app.online.act = async action => { actions.push(action); return true; };
  app.online.command = async command => { commands.push(command); return true; };
  try {
    await until(() => app.session.snapshot && !app.session.busy);
    await tap('cabin-battle'); await scrollTo('friends'); await tap('friends'); await until(() => app.online.room);
    await tap('skip'); assert.deepEqual(actions, [{ type: 'skip' }]);
    await render();
    const button = app.getButtons().find(item => item.id === 'skip');
    const point = { clientX: button.x + button.width / 2, clientY: button.y + button.height / 2 };
    p.callbacks.start({ touches: [point] });
    await app.online.game.load(sut.settingsFor(7), [{ type: 'move', point: [1, 0] }], { mode: 'human', save: false, paused: true });
    app.online.room = { ...app.online.room, seq: 1, stateHash: app.online.game.stateHash };
    await render();
    assert.equal(app.getButtons().find(item => item.id === 'skip').disabled, true);
    p.callbacks.end({ changedTouches: [point], touches: [] }); await sleep(20);
    assert.deepEqual(actions, [{ type: 'skip' }], 'touch from the previous turn must not submit');
    await app.online.game.load(sut.settingsFor(7), [], { mode: 'human', save: false, paused: true });
    app.online.room = { ...app.online.room, seq: 0, stateHash: app.online.game.stateHash };
    p.confirm = async () => false;
    await tap('resign'); assert.equal(actions.length, 1);
    p.confirm = async () => true;
    await tap('resign'); assert.deepEqual(actions[1], { type: 'resign' });
    app.online.room = { ...app.online.room, code: 'BCDEFGHJ' };
    await tap('cabin-battle'); await scrollTo('share-room'); await tap('share-room');
    assert.equal(shares.length, 1); assert.equal(shares[0].query, 'room=BCDEFGHJ');
    await scrollTo('battle-leave'); p.confirm = async () => false;
    await tap('battle-leave'); assert.deepEqual(commands, []);
    p.confirm = async () => true;
    await tap('battle-leave'); await until(() => app.session !== app.online.game);
    assert.deepEqual(commands, ['leave']); assert.equal(app.getCabin(), null);
  } finally { app.dispose(); }
});

test('cold and foreground invitations still enter; a superseded invitation failure cannot eject the newer room', async () => {
  const { app, p, render } = uiHarness({ config: onlineConfig,
    platformOverrides: { launchOptions: () => ({ query: { room: 'ABCDEFGH' } }) } });
  const calls = []; let rejectFirst;
  app.online.enter = (kind, code) => {
    calls.push({ kind, code });
    return calls.length === 1 ? new Promise((_, reject) => { rejectFirst = reject; }) : Promise.resolve(true);
  };
  try {
    await until(() => calls.length === 1); assert.deepEqual(calls[0], { kind: 'join', code: 'ABCDEFGH' });
    p.callbacks.hide(); p.callbacks.show({ query: { room: 'BCDEFGHJ' } });
    await until(() => calls.length === 2); assert.deepEqual(calls[1], { kind: 'join', code: 'BCDEFGHJ' });
    rejectFirst(Error('ROOM_EXPIRED')); await sleep(20); await render();
    assert.equal(app.getScene(), 'game'); assert.equal(app.session, app.online.game); assert.deepEqual(p.messages, []);
  } finally { app.dispose(); }
});

test('invalid or cancelled room input stays in the battle cabin without an error dialog or network request', async () => {
  for (const [input, expectedError] of [['wrong', true], [null, false]]) {
    const h = uiHarness({ config: onlineConfig }); let enters = 0;
    h.app.online.enter = async () => { enters++; };
    h.p.input = async () => input;
    try {
      await until(() => h.app.session.snapshot && !h.app.session.busy);
      const local = h.app.session, hash = local.stateHash;
      await h.tap('cabin-battle'); await h.scrollTo('join-room'); await h.tap('join-room'); await h.render();
      assert.deepEqual(h.p.messages, []);
      assert.equal(h.app.getCabin(), 'battle'); assert.equal(h.app.session, local);
      assert.equal(local.stateHash, hash); assert.equal(enters, 0);
      assert.equal(h.texts.some(text => text.startsWith('房间码应为 8 位')), expectedError);
      assert.equal(h.app.getButtons().some(button => button.id === 'retry-room'), false);
    } finally { h.app.dispose(); }
  }
});

test('failed join returns to battle, preserves the local game and retries the same code without retyping', async () => {
  const h = uiHarness({ config: onlineConfig }); const calls = []; let inputs = 0;
  h.p.input = async () => { inputs++; return '  bcdefghj  '; };
  h.app.online.enter = async (kind, code) => {
    calls.push([kind, code]); if (calls.length === 1) throw Error('NETWORK_ERROR'); return true;
  };
  try {
    await until(() => h.app.session.snapshot && !h.app.session.busy);
    const local = h.app.session, hash = local.stateHash;
    await h.tap('cabin-battle'); await h.scrollTo('join-room'); await h.tap('join-room');
    await until(() => calls.length === 1 && h.app.session === local); await h.render();
    assert.equal(h.app.getScene(), 'game'); assert.equal(h.app.getCabin(), 'battle');
    assert.deepEqual(h.p.messages, []); assert.equal(local.stateHash, hash);
    await h.scrollTo('retry-room'); assert.ok(h.texts.some(text => text.includes('BCDEFGHJ')));
    await h.tap('retry-room'); await until(() => calls.length === 2);
    assert.deepEqual(calls, [['join', 'BCDEFGHJ'], ['join', 'BCDEFGHJ']]); assert.equal(inputs, 1);
    assert.equal(h.app.getCabin(), null); assert.equal(h.app.session, h.app.online.game);
  } finally { h.app.dispose(); }
});

test('a failed room code can be replaced, and cancelling replacement retains only the previous valid retry', async () => {
  const h = uiHarness({ config: onlineConfig }); const calls = []; let input = 'ABCDEFGH';
  h.p.input = async () => input;
  h.app.online.enter = async (kind, code) => { calls.push([kind, code]); throw Error('NETWORK_ERROR'); };
  try {
    await until(() => h.app.session.snapshot && !h.app.session.busy);
    await h.tap('cabin-battle'); await h.scrollTo('join-room'); await h.tap('join-room');
    await until(() => calls.length === 1 && h.app.getCabin() === 'battle');
    input = null; await h.scrollTo('join-room'); await h.tap('join-room');
    await h.scrollTo('retry-room'); assert.ok(h.app.getButtons().some(button => button.id === 'retry-room'));
    assert.equal(calls.length, 1); assert.deepEqual(h.p.messages, []);
    input = 'wrong'; await h.scrollTo('join-room'); await h.tap('join-room'); await h.render();
    assert.equal(h.app.getButtons().some(button => button.id === 'retry-room'), false);
    assert.equal(calls.length, 1);
    input = 'BCDEFGHJ'; await h.scrollTo('join-room'); await h.tap('join-room');
    await until(() => calls.length === 2 && h.app.getCabin() === 'battle');
    assert.deepEqual(calls[1], ['join', 'BCDEFGHJ']);
  } finally { h.app.dispose(); }
});

test('failed join feedback and retry remain visible and touchable on compact phones in both languages', async () => {
  for (const language of ['zh', 'en']) for (const [width, height, top] of [[320, 568, 64], [390, 844, 88]]) {
    const h = uiHarness({ config: onlineConfig, language, width, height, top }); let entered = false;
    h.p.input = async () => 'ABCDEFGH';
    h.app.online.enter = async () => { entered = true; throw Error('NETWORK_ERROR'); };
    try {
      await until(() => h.app.session.snapshot && !h.app.session.busy);
      await h.tap('cabin-battle'); await h.scrollTo('join-room'); await h.tap('join-room');
      await until(() => entered && h.app.getCabin() === 'battle'); await h.render(); await h.render();
      const buttons = h.app.getButtons(), retry = buttons.find(button => button.id === 'retry-room');
      assert.ok(retry && !retry.disabled, `${language}/${width}: retry is visible without another scroll`);
      for (const b of buttons) {
        assert.ok(b.x >= 0 && b.x + b.width <= width);
        assert.ok(b.y >= 0 && b.y + b.height <= height - 24);
      }
      for (const [i, a] of buttons.entries()) for (const b of buttons.slice(i + 1)) {
        assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y,
          `${language}/${width}: ${a.id} overlaps ${b.id}`);
      }
      assert.deepEqual(h.p.messages, []);
    } finally { h.app.dispose(); }
  }
});
