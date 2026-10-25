import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, until } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';

const config = { onlineEnabled: true, apiBase: 'https://test.invalid' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

for (const outcome of ['declined', 'invalid', 'expired']) {
  test(`return from invitation preserves and reveals the local game: ${outcome}`, async () => {
    const h = uiHarness({ config }), { app, p } = h;
    let entries = 0;
    try {
      await until(() => app.session.snapshot && !app.session.busy);
      await app.session.load(sut.settingsFor(7), [{ type: 'move', point: [1, 0] }], { mode: 'human', paused: true });
      const original = app.session, hash = original.stateHash, actions = JSON.stringify(original.actions);
      app.online.enter = async () => { entries++; throw Error('ROOM_EXPIRED'); };
      p.confirm = async () => outcome !== 'declined';
      p.callbacks.hide();
      assert.equal(original.hidden, true);
      p.callbacks.show({ query: { room: outcome === 'invalid' ? 'not-a-code' : 'ABCDEFGH' } });
      await until(() => !app.session.hidden, 1200);
      assert.equal(app.session, original);
      assert.equal(original.stateHash, hash);
      assert.equal(JSON.stringify(original.actions), actions);
      assert.equal(original.paused, true, 'returning must not restart AI or the clock');
      assert.equal(entries, outcome === 'expired' ? 1 : 0);
      await h.tap('cabin-guide');
      assert.equal(app.getCabin(), 'guide', 'the visible game must accept cabin touches again');
    } finally { app.dispose(); }
  });
}

for (const outcome of ['declined', 'invalid']) {
  test(`return from an unused invitation reconnects the existing online room: ${outcome}`, async () => {
    const h = uiHarness({ config }), { app, p } = h;
    let refreshes = 0, connects = 0;
    app.online.enter = async () => {
      const client = app.online;
      await client.game.load(sut.settingsFor(7), [{ type: 'move', point: [1, 0] }], { mode: 'human', paused: true, save: false });
      client.active = client.connected = true;
      client.room = { code: 'ABCDEFGH', matchId: 'a'.repeat(32), seq: 1, stateHash: client.game.stateHash,
        status: 'playing', player: 'WHITE', settings: client.game.settings, ready: {}, rematchVotes: {} };
      client.notify(); return true;
    };
    try {
      await until(() => app.session.snapshot && !app.session.busy);
      await h.tap('friends'); await h.tap('room-submit'); await until(() => app.online.room);
      const room = app.online.room, hash = app.session.stateHash;
      app.online.refresh = async () => { refreshes++; return true; };
      app.online.connect = async () => { connects++; app.online.connected = true; };
      app.online.enter = async () => { throw Error('Unexpected entry for a declined/invalid invitation'); };
      p.storage.set('lifeline-wx-online-consent-v2', '');
      p.confirm = async () => outcome !== 'declined';
      p.callbacks.hide();
      p.callbacks.show({ query: { room: outcome === 'invalid' ? 'invalid' : 'BCDEFGHJ' } });
      await until(() => !app.session.hidden && app.online.active && connects === 1, 1200);
      assert.equal(app.session, app.online.game);
      assert.equal(app.online.room, room);
      assert.equal(app.session.stateHash, hash);
      assert.equal(refreshes, 1);
      await h.tap('cabin-guide');
      assert.equal(app.getCabin(), 'guide');
    } finally { app.dispose(); }
  });
}

test('late invitation cancellation cannot reveal a hidden or disposed game', async () => {
  for (const boundary of ['hide', 'dispose']) {
    const h = uiHarness({ config }), { app, p } = h;
    let answer;
    try {
      await until(() => app.session.snapshot && !app.session.busy);
      p.confirm = () => new Promise(resolve => { answer = resolve; });
      p.callbacks.hide(); p.callbacks.show({ query: { room: 'ABCDEFGH' } });
      await until(() => answer);
      if (boundary === 'hide') p.callbacks.hide(); else app.dispose();
      answer(false); await delay(30);
      assert.equal(app.session.hidden, true, boundary);
      assert.equal(app.online.active, false, boundary);
    } finally { app.dispose(); }
  }
});
