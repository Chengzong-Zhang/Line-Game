import test from 'node:test';
import assert from 'node:assert/strict';
import { LadderClient, drawLadder } from '../src/ladder.js';
import { uiHarness } from './ui-harness.mjs';
import { sut, until, memoryStorage, localScheduler } from './helpers.mjs';

const entry = { displayName: '测试玩家', isMe: true, points: 1058, games: 12, wins: 8, draws: 1, winRate: 2 / 3, ratedGames: 9, rank: 2 };
const result = (board, offset = 0) => ({ version: 'ladder-v1', board, entries: [entry], me: entry, offset, hasMore: offset === 0, total: 21 });

test('late board responses and changed identities never replace current standings', async () => {
  const pending = [], online = { authEpoch: 0, account: { uid: 'one' }, authenticate: async () => {}, request: path => new Promise(resolve => pending.push({ path, resolve })) };
  const ladder = new LadderClient(online, () => {});
  const first = ladder.load('ai'); await until(() => pending.length === 1);
  const second = ladder.load('human'); await until(() => pending.length === 2);
  pending[1].resolve(result('human')); await second;
  pending[0].resolve(result('ai')); await first;
  assert.equal(ladder.view().data.board, 'human');
  online.account = { uid: 'two' };
  assert.equal(ladder.view().data, null);
  const third = ladder.load('human'); await until(() => pending.length === 3);
  online.authEpoch++; online.account = null; pending[2].resolve(result('human')); await third;
  assert.equal(ladder.view().data, null);
  assert.equal(ladder.loading, false);
});

test('a failed board read offers a retry without fabricated standings', async () => {
  const online = { authEpoch: 0, account: { uid: 'one' }, authenticate: async () => {}, request: async () => { throw Error('NETWORK_ERROR'); } };
  const ladder = new LadderClient(online, () => {});
  await ladder.load('ai'); assert.equal(ladder.error, 'NETWORK_ERROR'); assert.equal(ladder.data, null);
  online.request = async () => result('ai'); await ladder.load('ai');
  assert.equal(ladder.error, ''); assert.equal(ladder.data.me.points, 1058);
});

test('a result receipt stays on its own board and names the scoring board', () => {
  const texts = [], ui = { language: 'zh', text: s => texts.push(s), button() {}, wrap: s => { texts.push(s); return 20; } };
  const state = { enabled: true, player: 'BLACK', result: { board: 'ai', rated: true, players: { BLACK: { points: 2, delta: 2 } } } };
  drawLadder(ui, { x: 0, y: 0, width: 300 }, { ...state, kind: 'human' }, {});
  assert.ok(!texts.some(s => s.includes('当前 2 分')));
  texts.length = 0;
  drawLadder(ui, { x: 0, y: 0, width: 300 }, { ...state, kind: 'ai' }, {});
  assert.ok(texts.some(s => s.includes('AI 榜积分 +2 · 当前 2 分')));
});

test('returning to Battle refreshes the selected board after a new result', async () => {
  let reads = 0;
  const h = uiHarness({ config: { onlineEnabled: true, apiBase: 'https://test.invalid' },
    platformOverrides: { login: async () => 'test-only-code', request: async ({ url }) => {
      if (url.endsWith('/login')) return { protocol: 1, token: 'test-token', expiresIn: 7200, account: { uid: 'one', displayName: 'Player' } };
      reads++;
      return { ...result('human'), me: { ...entry, points: reads === 1 ? 1058 : 1068 } };
    } } });
  try {
    await until(() => h.app.session.snapshot && !h.app.session.busy);
    await h.tap('cabin-battle'); await h.tap('ladder-human');
    await until(() => reads === 1); await h.render();
    assert.ok(h.texts.some(s => s.includes('我的积分 1058')));
    await h.tap('cabin-close'); await h.tap('cabin-battle');
    await until(() => reads === 2); await h.render();
    assert.ok(h.texts.some(s => s.includes('我的积分 1068')));
  } finally { h.app.dispose(); }
});

test('a detached ranked AI entry never sends a delayed room creation request', async () => {
  let release, requests = 0;
  const scheduler = localScheduler();
  const online = new sut.OnlineClient({ storage: memoryStorage(), request: async () => { requests++; } }, { onlineEnabled: true, apiBase: 'https://test.invalid' }, scheduler);
  online.active = true;
  online.authenticate = () => new Promise(resolve => { release = resolve; });
  const request = online.request('ranked-ai', { profile: 'greedy' });
  await until(() => release); online.detach(); release();
  await assert.rejects(request, /CANCELLED/); assert.equal(requests, 0); scheduler.cancel();
});

for (const language of ['zh', 'en']) test(`battle ladder, rules, own score and pagination work in ${language}`, async () => {
  const requests = [];
  const h = uiHarness({ language, width: 320, height: 640, top: 64,
    config: { onlineEnabled: true, apiBase: 'https://test.invalid' },
    platformOverrides: {
      login: async () => 'test-only-code',
      request: async ({ url }) => {
        requests.push(url);
        if (url.endsWith('/login')) return { protocol: 1, token: 'test-token', expiresIn: 7200, account: { uid: 'one', displayName: 'Player' } };
        const kind = url.includes('/ladder/ai') ? 'ai' : 'human';
        return result(kind, url.includes('offset=20') ? 20 : 0);
      },
    } });
  try {
    await until(() => h.app.session.snapshot && !h.app.session.busy);
    const hash = h.app.session.stateHash;
    await h.tap('cabin-battle');
    assert.equal(requests.length, 0, 'opening cabin does not silently sign in');
    await h.tap('ladder-rules'); assert.equal(h.app.getScene(), 'reader');
    await h.tap('reader-next'); await h.tap('reader-back');
    await h.tap('ladder-ai'); await until(() => requests.some(x => x.includes('/ladder/ai'))); await h.render();
    assert.ok(h.texts.some(x => x.includes('1058')));
    await h.scrollTo('ladder-next'); await h.tap('ladder-next');
    await until(() => requests.some(x => x.includes('offset=20')));
    await h.scrollTo('ladder-human'); await h.tap('ladder-human');
    await until(() => requests.some(x => x.includes('/ladder/human')));
    await h.tap('cabin-close');
    assert.equal(h.app.session.stateHash, hash);
  } finally { h.app.dispose(); }
});

test('ranked AI uses the chosen server difficulty and stale selection cannot start a match', async () => {
  const h = uiHarness({ config: { onlineEnabled: true, apiBase: 'https://test.invalid' } });
  let selected, entered;
  h.p.choose = () => new Promise(resolve => { selected = resolve; });
  h.app.online.enter = async (kind, profile) => { entered = { kind, profile }; return true; };
  try {
    await until(() => h.app.session.snapshot && !h.app.session.busy);
    await h.tap('cabin-battle'); await h.tap('ladder-start-ai'); await until(() => selected);
    await h.tap('cabin-close'); selected(2); await h.render(); assert.equal(entered, undefined);
    h.p.choose = async () => 2;
    await h.tap('cabin-battle'); await h.tap('ladder-start-ai'); await until(() => entered);
    assert.deepEqual(entered, { kind: 'ai', profile: 'minimax-3' });
  } finally { h.app.dispose(); }
});
