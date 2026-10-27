import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { device } from './transport-device.mjs';
import { sut, web, plain, until } from './helpers.mjs';

const origin = process.argv[2];
const blue = device(origin, 'blue', undefined, { paced: true });
const red = device(origin, 'red', undefined, { paced: true });
const peers = [blue, red], games = [], began = performance.now();
const configurations = [
  ...[5, 5, 6, 6].map((size, i) => ({ size, seed: i + 1, ending: 'natural' })),
  ...Array.from({ length: 8 }, (_, i) => ({ size: 5 + i, seed: 21 + i, ending: 'pass' })),
  ...Array.from({ length: 8 }, (_, i) => ({ size: 8 + i, seed: 41 + i, ending: 'resign' })),
];
const faultNames = ['socket-interruption', 'lost-acknowledgement', 'background', 'duplicate-and-old-message', 'expired-token'];

function expireFixtureToken(token) {
  const [header, raw] = token.split('.');
  const claims = JSON.parse(Buffer.from(raw, 'base64url').toString());
  const body = Buffer.from(JSON.stringify({ ...claims, exp: 1 })).toString('base64url');
  const signed = `${header}.${body}`;
  // Public fixture key; only this loopback test service accepts these tokens.
  return `${signed}.${createHmac('sha256', 'fixture-signing-secret-32-characters-long').update(signed).digest('base64url')}`;
}

async function synchronized(seq, oracle, chain) {
  await until(() => peers.every(({ client: c }) => c.room?.seq === seq && !c.game.busy && !c.receiving && !c.sending && !c.pending && !c.error), 20000);
  const expected = plain(sut.serializeRuleState(oracle));
  const snapshot = plain(oracle.getSnapshot()), hash = sut.checksum(expected);
  for (const { client: c } of peers) {
    assert.equal(c.room.stateHash, hash);
    assert.equal(c.game.stateHash, hash);
    assert.deepEqual(plain(c.game.snapshot), snapshot, `snapshot at step ${seq}`);
    assert.deepEqual(c.room.scores, { BLACK: snapshot.territories.BLACK.area, WHITE: snapshot.territories.WHITE.area });
    assert.equal(c.room.currentPlayer, snapshot.currentPlayer);
    assert.equal(c.room.gameOver, snapshot.gameOver);
    assert.equal(c.room.winner, snapshot.winner);
    assert.equal(new Set(c.room.actionIds).size, seq, 'accepted command IDs must be unique');
  }
  chain.update(`${seq}:${hash}\n`);
}

try {
  for (const [index, configuration] of configurations.entries()) {
    const { size, seed, ending } = configuration, start = performance.now();
    const fault = faultNames[index % faultNames.length], recoveryMs = [];
    assert.equal(await blue.client.enter('create', size), true);
    assert.equal(await red.client.enter('join', blue.client.room.code), true);
    await until(() => peers.every(p => p.client.connected));
    assert.equal(await blue.client.command('ready'), true);
    assert.equal(await red.client.command('ready'), true);
    await until(() => blue.client.canPlay());
    const oracle = new web.GameEngine(blue.client.room.settings), chain = createHash('sha256');
    let rng = seed, count = 0, injected = false, explicitPasses = 0, resignations = 0;
    await synchronized(0, oracle, chain);
    while (!oracle.gameOver && count < 120) {
      const actor = oracle.currentPlayer === 'BLACK' ? blue : red;
      const other = actor === blue ? red : blue;
      await until(() => actor.client.canPlay());
      let action;
      if (ending !== 'natural' && count >= 4) {
        action = { type: ending === 'pass' ? 'skip' : 'resign', player: oracle.currentPlayer };
      } else {
        const legal = oracle.getLegalMoves();
        assert.ok(legal.length, 'engine must automatically pass unavailable turns');
        rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
        action = { type: 'move', player: oracle.currentPlayer, point: legal[rng % legal.length].point };
      }
      const inject = count === 2;
      let hidden = null, lost = false, recoveryStart = null;
      if (inject) {
        injected = true;
        if (fault === 'socket-interruption') {
          recoveryStart = performance.now();
          other.disconnect();
          await until(() => !other.client.connected);
          await until(() => other.client.connected && !other.client.error, 10000);
          recoveryMs.push(Math.round(performance.now() - recoveryStart));
        } else if (fault === 'lost-acknowledgement') {
          actor.faults.dropMessages = actor.faults.dropReply = true; lost = true;
        } else if (fault === 'background') {
          hidden = other; hidden.client.background();
        } else if (fault === 'duplicate-and-old-message') {
          const before = other.client.game.stateHash, seq = other.client.room.seq;
          await other.replayFrames();
          assert.equal(other.client.game.stateHash, before); assert.equal(other.client.room.seq, seq);
        } else {
          const logins = actor.metrics.logins;
          actor.client.token = expireFixtureToken(actor.client.token);
          actor.client.expires = Date.now() + 60000;
          assert.equal(await actor.client.refresh(), true);
          assert.equal(actor.metrics.logins, logins + 1, '401 must trigger a fresh login and one retry');
        }
      }
      assert.equal(sut.applyAction(oracle, action).success, true);
      const beforeAction = { canPlay: actor.client.canPlay(), status: actor.client.room.status,
        revision: actor.client.room.revision, seq: actor.client.room.seq, replay: actor.client.game.replayIndex,
        player: actor.client.room.player, turn: actor.client.game.snapshot.currentPlayer };
      const { player: _actor, ...command } = action; // The server derives the actor from the authenticated account.
      const accepted = await actor.client.act(command);
      count++;
      if (action.type === 'skip') explicitPasses++;
      if (action.type === 'resign') resignations++;
      if (lost) {
        assert.equal(accepted, false); assert.ok(actor.client.pending);
        await until(() => other.client.room.seq === count && !other.client.game.busy);
        actor.client.background(); actor.faults.dropMessages = false;
        recoveryStart = performance.now(); await actor.client.foreground();
        await until(() => actor.client.connected && !actor.client.pending && !actor.client.error, 20000);
        recoveryMs.push(Math.round(performance.now() - recoveryStart));
      } else assert.equal(accepted, true, JSON.stringify({ game: index + 1, step: count, fault, beforeAction,
        error: actor.client.error, active: actor.client.active, connected: actor.client.connected,
        busy: actor.client.game.busy, sending: actor.client.sending, pending: Boolean(actor.client.pending),
        seq: actor.client.room.seq, player: actor.client.room.player, turn: actor.client.game.snapshot.currentPlayer }));
      if (hidden) {
        assert.ok(hidden.client.room.seq < count);
        recoveryStart = performance.now(); await hidden.client.foreground();
        await until(() => hidden.client.connected && !hidden.client.error, 20000);
        recoveryMs.push(Math.round(performance.now() - recoveryStart));
      }
      await synchronized(count, oracle, chain);
    }
    assert.ok(oracle.gameOver, 'bounded game must reach a terminal state');
    assert.ok(injected);
    if (ending === 'natural') assert.equal(explicitPasses + resignations, 0);
    if (ending === 'pass') assert.ok(explicitPasses > 0);
    if (ending === 'resign') assert.equal(resignations, 1);
    const final = oracle.getSnapshot();
    assert.ok(peers.every(p => p.client.room.status === 'finished'));
    games.push({ game: index + 1, size, seed, ending, actions: count, explicitPasses, resignations,
      winner: final.winner, scores: { BLACK: final.territories.BLACK.area, WHITE: final.territories.WHITE.area },
      fault, recoveryMs, stateChainSha256: chain.digest('hex'), finalStateHash: blue.client.game.stateHash,
      elapsedMs: Math.round(performance.now() - start) });
    assert.equal(await blue.client.command('leave'), true);
    await until(() => red.client.room.status === 'closed');
    blue.client.detach(); red.client.detach();
    console.error(`Complete game ${games.length}/20: size ${size}, ${ending}, ${count} actions, ${fault}`);
  }
  assert.equal(games.length, 20);
  console.log(JSON.stringify({ schemaVersion: 1, status: 'PASS_20_GAMES_LOCAL_HTTP_WS_ONLY', games,
    completedGames: games.length, verifiedActions: games.reduce((n, g) => n + g.actions, 0),
    elapsedMs: Math.round(performance.now() - began),
    notVerified: ['real WeChat login', 'HTTPS/WSS and domain allowlist', 'mobile network switching', 'device lifecycle', 'public service load'] }));
} catch (error) {
  console.log(JSON.stringify({ schemaVersion: 1, status: 'FAILED_LOCAL_SERIES', completedGames: games.length, games, error: error.message }));
  throw error;
} finally { for (const peer of peers) peer.stop(); }
