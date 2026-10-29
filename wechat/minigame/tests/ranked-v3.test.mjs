import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareRankedMatch, rankedReply } from '../tools/ranked-ai.mjs';
import { controllerChoices, playerIds } from '../src/controllers.js';
import { executeTask } from '../src/worker-runtime.js';
import { sut, until, memoryStorage, localScheduler } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';

const setup = (count = 3, shape = 'hexagon', human = 'PURPLE', profile = 'greedy') => ({
  settings: { gridSize: 5, playerCount: count, boardShape: shape, rulesVersion: 'territory-v3',
    startPlayer: 'BLACK', startingPointMode: 'default' },
  controllers: Object.fromEntries(playerIds(count).map(p => [p, p === human ? 'human' : profile])),
});
function view(prepared, actions = [], extra = {}) {
  const state = executeTask({ kind: 'STATE', payload: { settings: prepared.settings, actions } });
  return { protocol: 1, code: 'ABCDEFGH', matchId: 'a'.repeat(32), revision: actions.length + 1,
    settings: prepared.settings, seq: actions.length, actions, actionIds: actions.map((_, i) => `server_${i}`),
    stateHash: state.stateHash, currentPlayer: state.snapshot.currentPlayer, gameOver: state.snapshot.gameOver,
    winner: state.snapshot.winner, player: prepared.humanPlayer, humanPlayer: prepared.humanPlayer,
    aiControllers: prepared.controllers, rankedAI: 'configured', status: state.snapshot.gameOver ? 'finished' : 'playing',
    members: Object.fromEntries(playerIds(prepared.settings.playerCount).map(p => [p, true])),
    ready: {}, rematchVotes: {}, ...extra };
}

test('diamond ranked setups keep server-drawn starts and use only supported AI', async () => {
  const duel = await prepareRankedMatch(setup(2, 'diamond', 'BLACK', 'minimax-2'));
  const reply = await rankedReply(duel.settings, [{ type: 'skip', player: 'BLACK' }], 'minimax-2', duel.context.runtime);
  assert.equal(reply.aiAction.player, 'WHITE');
  const multi = setup(3, 'diamond', 'BLACK', 'greedy');
  await assert.rejects(prepareRankedMatch(multi), /INVALID_SETTINGS/);
  multi.settings.startingPointMode = 'random';
  const prepared = await prepareRankedMatch(multi);
  assert.equal(prepared.settings.boardShape, 'diamond');
  assert.equal(Object.keys(prepared.settings.initialPositions).length, 3);
  assert.equal(prepared.controllers.WHITE, 'greedy');
});

// Every selectable profile is exercised through the actual server AI entry,
// including binary-model loading and its existing checksum checks.
const cases = new Map();
for (const [count, shape] of [[2, 'triangle'], [3, 'triangle'], [4, 'hexagon']]) {
  const input = setup(count, shape, 'BLACK');
  for (const profile of controllerChoices(input.settings).filter(p => p !== 'human'))
    if (!cases.has(profile)) cases.set(profile, setup(count, shape, 'BLACK', profile));
}
for (const [profile, input] of cases) test(`authoritative ranked reply: ${profile}`, { timeout: 20000 }, async () => {
  const prepared = await prepareRankedMatch(input);
  const actions = [{ type: 'skip', player: 'BLACK' }];
  const reply = await rankedReply(prepared.settings, actions, profile, prepared.context.runtime);
  assert.equal(reply.aiAction.player, 'WHITE');
  assert.ok(['move', 'skip'].includes(reply.aiAction.type));
  const verified = executeTask({ kind: 'STATE', payload: { settings: prepared.settings, actions: [...actions, reply.aiAction] } });
  assert.equal(reply.stateHash, verified.stateHash);
});

test('runtime changes are rejected; random roots do not change the calibration context', async () => {
  const input = setup(); input.settings.startingPointMode = 'random';
  const first = await prepareRankedMatch(input), second = await prepareRankedMatch(input);
  assert.equal(first.context.key, second.context.key);
  assert.ok(first.settings.initialPositions);
  assert.ok(!('initialPositions' in first.context));
  await assert.rejects(rankedReply(first.settings, [], 'greedy', '0'.repeat(64)), /AI_VERSION_CHANGED/);
});

test('configured multiplayer room automatically resumes bots and stops at a nonblack human', async () => {
  const prepared = await prepareRankedMatch(setup()), room = view(prepared);
  const actions = [{ type: 'skip', player: 'BLACK' }, { type: 'skip', player: 'WHITE' }];
  const next = view(prepared, actions), scheduler = localScheduler(); let calls = 0;
  const client = new sut.OnlineClient({ storage: memoryStorage() }, {}, scheduler);
  client.active = true; client.connected = true;
  client.request = async (path, data) => {
    assert.equal(path, 'rooms/ABCDEFGH/advance-ai'); assert.equal(data.matchId, room.matchId);
    calls++; return next;
  };
  try {
    await client.receive(room);
    await until(() => client.room?.currentPlayer === 'PURPLE' && !client.botBusy);
    await new Promise(r => setTimeout(r, 150));
    assert.equal(calls, 1); assert.equal(client.game.snapshot.players.length, 3);
    assert.equal(client.canPlay(), true);
  } finally { client.detach(); scheduler.cancel(); }
});

test('replay, background and failed requests stop automatic AI work; stale replies cannot replace the room', async () => {
  const prepared = await prepareRankedMatch(setup());
  for (const boundary of ['replay', 'background', 'error', 'late-reply']) {
    const scheduler = localScheduler(); let calls = 0, release;
    const client = new sut.OnlineClient({ storage: memoryStorage() }, {}, scheduler);
    client.active = true;
    client.request = async () => {
      calls++;
      if (boundary === 'error') throw Error('NETWORK_ERROR');
      return new Promise(resolve => { release = resolve; });
    };
    try {
      await client.receive(view(prepared));
      if (boundary === 'replay') client.game.replayIndex = 0;
      if (boundary === 'background') client.background();
      if (boundary === 'late-reply') {
        await until(() => release); client.detach();
        release(view(prepared, [{ type: 'skip', player: 'BLACK' }]));
      }
      if (boundary === 'error') await until(() => client.error === 'NETWORK_ERROR');
      await new Promise(r => setTimeout(r, 250));
      assert.equal(calls, ['error', 'late-reply'].includes(boundary) ? 1 : 0, boundary);
      assert.equal(client.room.seq, 0, boundary);
    } finally { client.detach(); scheduler.cancel(); }
  }
});

test('multiplayer forfeit UI shows settlement, hides live controls and preserves the real unfinished engine', async () => {
  const prepared = await prepareRankedMatch(setup());
  const actions = [{ type: 'skip', player: 'BLACK' }, { type: 'skip', player: 'WHITE' }, { type: 'resign', player: 'PURPLE' }];
  const room = view(prepared, actions, { rankedForfeit: true, status: 'finished',
    ladderResult: { version: 'ladder-v3-conservative', board: 'ai', rated: true,
      players: { PURPLE: { points: 757, delta: -43, provisional: true } } } });
  assert.equal(room.gameOver, false);
  const h = uiHarness({ config: { onlineEnabled: true, apiBase: 'https://fixture.invalid' },
    platformOverrides: { input: async () => 'ABCDEFGH' } });
  h.app.online.enter = async () => {
    h.app.online.active = true; h.app.online.connected = true;
    return h.app.online.receive(room);
  };
  try {
    await until(() => h.app.session.snapshot && !h.app.session.busy);
    await h.tap('cabin-battle'); await h.scrollTo('join-room'); await h.tap('join-room'); await until(() => h.app.online.room); await h.render();
    assert.ok(h.texts.includes('AI 挑战已认输结算'));
    const buttons = h.app.getButtons();
    assert.ok(buttons.some(b => b.id === 'room-rematch'));
    assert.ok(!buttons.some(b => ['skip', 'hint', 'resign', 'confirm'].includes(b.id)));
    await h.tap('result-detail');
    assert.ok(h.texts.some(s => s.includes('保守分')));
    assert.ok(!h.texts.some(s => s.includes('undefined')));
  } finally { h.app.dispose(); }
});
