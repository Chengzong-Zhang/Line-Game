import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { device } from './transport-device.mjs';
import { uiHarness } from './ui-harness.mjs';
import { sut, until } from './helpers.mjs';
import { TEXT } from '../src/i18n.js';

const origin = process.argv[2];
assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
function uiDevice(name, language) {
  const transport = device(origin, name), gate = { holdState: false, release: null }, workers = [];
  const h = uiHarness({ language, storage: transport.storage, config: { onlineEnabled: true, apiBase: 'https://test.invalid' },
    platformOverrides: { ...transport.client.platform,
      createWorker() {
        const worker = new Worker(new URL('./worker-thread.mjs', import.meta.url));
        let terminated = false;
        const adapter = { onMessage: fn => worker.on('message', fn), onError: fn => worker.on('error', fn),
          postMessage(message) {
            if (gate.holdState && message.kind === 'STATE') {
              gate.holdState = false; gate.release = () => { if (!terminated) worker.postMessage(message); };
            } else worker.postMessage(message);
          }, terminate() { terminated = true; void worker.terminate(); },
        };
        workers.push(adapter); return adapter;
      },
    } });
  const local = h.app.session;
  return { ...h, local, gate, transport, client: h.app.online,
    get texts() { return h.texts; }, stop() { h.app.dispose(); transport.stop(); workers.forEach(w => w.terminate()); } };
}
const blue = uiDevice('blue', 'zh'), red = uiDevice('red', 'en'), peers = [blue, red];
const both = predicate => until(() => peers.every(d => predicate(d.client)), 20000);
async function move(d, point) {
  await until(() => d.client.canPlay()); await d.render();
  d.app.tap(...sut.toScreen(point, d.app.getLayout())); await d.render();
  await d.tap('confirm');
}
try {
  for (const d of peers) {
    await d.render(); await d.local.newGame(7, 'human'); await d.local.act({ type: 'move', point: [1, 0] }); d.local.pause();
  }
  const localHash = blue.local.stateHash;
  await blue.tap('cabin-battle'); await blue.scrollTo('friends'); await blue.tap('friends');
  blue.p.choose = async () => 0; await blue.scrollTo('controller-WHITE'); await blue.tap('controller-WHITE');
  await blue.scrollTo('room-submit'); await blue.tap('room-submit'); await until(() => blue.client.room);
  red.p.input = async () => blue.client.room.code;
  await red.tap('cabin-battle'); await red.scrollTo('join-room'); await red.tap('join-room');
  await both(c => c.connected); await both(c => !c.receiving);
  for (const d of peers) { await d.render(); await d.tap('room-ready'); }
  await both(c => c.room?.status === 'playing' && !c.receiving);
  await move(blue, [1, 0]); await both(c => c.room?.seq === 1 && !c.receiving);

  // Freeze the host's real Worker response while an opponent's move is arriving.
  blue.gate.holdState = true;
  await move(red, [5, 0]); await until(() => blue.gate.release && blue.app.session.busy);
  await blue.render(); await blue.tap('cabin-guide'); await blue.tap('guide-rules-essential');
  blue.gate.release();
  await until(() => blue.client.room?.seq === 2 && !blue.client.receiving, 3000);
  assert.equal(blue.client.error, null, 'Reading rules must not cancel room verification');
  assert.equal(blue.app.getScene(), 'reader');
  assert.equal(blue.client.game.stateHash, red.client.game.stateHash);
  await blue.tap('reader-back'); await blue.tap('cabin-close');
  await until(() => blue.client.canPlay());

  // The direct action should still work when the match and position remain current.
  await blue.tap('resign');
  await both(c => c.room?.status === 'finished' && !c.receiving);
  for (const d of peers) {
    await d.render(); await d.tap('result-detail');
    assert.equal(d.app.getButtons().find(b => b.id === 'result-save').disabled, true);
  }
  assert.ok(blue.texts.includes(`${TEXT.zh.white} ${TEXT.zh.wins}`));
  assert.ok(red.texts.includes(`${TEXT.en.white} ${TEXT.en.wins}`));
  await blue.tap('result-replay'); await until(() => blue.app.session.replayIndex === 0 && !blue.app.session.busy);
  await blue.render(); await blue.tap('exit-replay'); await until(() => blue.app.session.replayIndex === null);
  await blue.render(); await blue.tap('room-rematch');
  await until(() => blue.client.room?.rematchVotes.BLACK); await blue.render(); await blue.tap('result-detail');
  await red.tap('result-back'); await red.tap('room-rematch');
  await both(c => c.room?.status === 'waiting' && c.room.seq === 0 && !c.receiving);
  await until(() => blue.app.getScene() === 'game');
  assert.equal(blue.app.session.replayIndex, null);

  // Delete through the privacy reader entered from an actual friend room.
  await blue.render(); await blue.tap('cabin-battle'); await blue.scrollTo('account-privacy'); await blue.tap('account-privacy');
  await blue.tap('delete-account'); await until(() => blue.client.room === null && !blue.client.deleting);
  await until(() => red.client.error === 'ROOM_REMOVED');
  assert.equal(red.client.active, false); assert.equal(red.client.reconnectTimer, null);
  assert.equal(blue.app.session, blue.local); assert.equal(blue.local.stateHash, localHash);
  await blue.render(); await blue.tap('reader-back'); assert.equal(blue.app.getCabin(), 'battle'); await blue.tap('cabin-close');
  assert.equal(blue.app.getScene(), 'game');
  assert.equal(blue.app.session.stateHash, localHash); assert.equal(blue.app.session.actions.length, 1);
  assert.equal(new sut.SaveStore(blue.p.storage).read().payload.session.actions.length, 1);
  // A removed room has a direct return button; only then create a different room.
  await red.render(); await red.tap('room-closed'); await red.tap('cabin-battle');
  await red.scrollTo('friends'); await red.tap('friends');
  red.p.choose = async () => 0; await red.scrollTo('controller-WHITE'); await red.tap('controller-WHITE');
  await red.scrollTo('room-submit'); await red.tap('room-submit');
  await until(() => red.client.room && red.client.active);
  blue.p.callbacks.hide(); blue.p.callbacks.show({ query: { room: red.client.room.code } });
  await both(c => c.connected && !c.receiving);
  assert.equal(blue.client.room.code, red.client.room.code);
  assert.equal(blue.local.stateHash, localHash);
  console.log(JSON.stringify({ status: 'PASS_LOCAL_UI_HTTP_WS_WORKER_ONLY',
    scope: ['actual UI button geometry', 'loopback HTTP/WS', 'production Worker threads', 'reading during incoming move verification',
      'two-language result detail', 'online result cannot save local game', 'replay and rematch while result panel open',
      'privacy deletion inside room', 'local game preservation', 'peer stops reconnecting after room deletion', 'foreground share invitation after deletion'],
    actualWeChatLogin: false, deviceAcceptance: false, productionDeployment: false }));
} finally { peers.forEach(d => d.stop()); }
