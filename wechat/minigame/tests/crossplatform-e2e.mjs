import assert from 'node:assert/strict';
import { build } from '../tools/native-build.mjs';
import path from 'node:path';
import { root, until, sut } from './helpers.mjs';
import { device } from './transport-device.mjs';
Error.prepareStackTrace = (error, frames) => `${error.name}: ${error.message}\n${frames.slice(0, 8).map(frame =>
  `  at ${frame.getFunctionName() || '<anonymous>'} (${String(frame.getFileName()).startsWith('data:') ? '<Web bundle>' : frame.getFileName()}:${frame.getLineNumber()})`).join('\n')}`;

const origin = process.argv[2];
assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
const bundle = await build({
  stdin: { contents: `export { default as Network } from './CrossPlatformNetwork.js'; export { default as Controller } from './GameController.js'; export * from './SharedRoomClient.js';`, resolveDir: path.resolve(root, '../../web/web前端') },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
  plugins: [{ name: 'queries', setup(b) {
    b.onResolve({ filter: /\?v=/ }, args => ({ path: path.resolve(args.resolveDir, args.path.split('?')[0]) }));
  } }],
});
const { Network, Controller, verifySharedRoom } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const data = new Map(), storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
let dropAck = false;
const network = new Network({ storage, fetch: async (...args) => {
  const response = await fetch(...args);
  if (dropAck && args[0].endsWith('/actions')) { dropAck = false; throw new Error('NETWORK_ERROR'); }
  return response;
} });
const mini = device(origin, 'red');
const controller = Object.create(Controller.prototype);
Object.assign(controller, {
  canvas: { style: {}, setAttribute() {} }, options: { engine: sut.settingsFor(7) },
  engine: new sut.GameEngine(sut.settingsFor(7)), renderer: { invalidate() {}, render() {} },
  _validGridPoints: [], _engineEpoch: 1, _networkUnsubscribers: [], _authoritativeSnapshotValid: true,
  multiplayerEnabled: true, localPlayer: 'BLACK', roomReady: false, opponentConnected: false, lastAction: null,
  networkErrorListener: error => { throw error; }, stateChangeListener() {},
});
const received = [];
const apply = payload => {
  controller.enableMultiplayer({ networkManager: network, localPlayer: payload.color,
    roomReady: payload.status === 'IN_PROGRESS', opponentConnected: payload.players.length === 2 }, false);
  const restored = controller.restoreMatchState(payload.matchState);
  assert.equal(restored.success, true);
  received.push(payload.matchState.actions.length);
};
for (const name of ['ROOM_CREATED', 'ROOM_JOINED', 'ROOM_STATE']) network.on(name, apply);
try {
  // Existing Web password login, not a synthetic WeChat identity on both ends.
  const response = await fetch(origin + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'web-friend', password: 'test-only-password' }) });
  assert.equal(response.status, 200);
  const login = await response.json();
  network.url = origin.replace('http:', 'ws:') + '/ws'; network.setAuthToken(login.token);
  await network.createSharedRoom({ gridSize: 7 });
  assert.equal(network.shared.account.provider, 'web');
  const code = network.roomId;
  assert.equal(await mini.client.enter('join', code), true);
  await until(() => network.shared.room.members.WHITE && mini.client.connected);
  await network.sendReady(true); await mini.client.command('ready');
  await until(() => network.canAct());
  assert.equal(network.serverAuthoritative, true);
  // Drive the production Web pointer handler, stubbing geometry only.
  controller._getCanvasRelativePosition = () => ({ x: 0, y: 0 });
  controller._findNearestGridPoint = () => [1, 0];
  const beforeClick = sut.ruleView(controller.engine).stateHash;
  assert.equal(controller._processPointer(0, 0).pending, true);
  assert.equal(sut.ruleView(controller.engine).stateHash, beforeClick, 'Web click waits for server commit');
  await until(() => mini.client.room.seq === 1 && mini.client.canPlay());
  await until(() => network.shared.room.seq === 1);
  assert.equal(controller.engine.turnCount, mini.client.game.snapshot.turnCount);
  assert.equal(sut.ruleView(controller.engine).stateHash, mini.client.game.stateHash);
  const first = mini.client.game.snapshot.legalMoves[0].point;
  assert.equal(await mini.client.act({ type: 'move', point: first }), true, mini.client.error);
  await until(() => network.shared.room.seq === 2 && network.canAct());
  assert.equal(sut.ruleView(controller.engine).stateHash, mini.client.game.stateHash);

  // Old and tampered snapshots must not replace the authoritative board.
  const old = structuredClone(network.shared.room);
  await network.sendSkip(); await until(() => mini.client.room.seq === 3 && mini.client.canPlay());
  await network.shared.receive(old);
  assert.equal(network.shared.room.seq, 3);
  const validHash = sut.ruleView(controller.engine).stateHash;
  await assert.rejects(verifySharedRoom({ ...network.shared.room, stateHash: 'sha256:' + '0'.repeat(64) }), /STATE_MISMATCH/);
  assert.equal(sut.ruleView(controller.engine).stateHash, validHash);
  assert.equal(await mini.client.act({ type: 'skip' }), true);
  await until(() => network.shared.room.status === 'finished');
  assert.equal(controller.engine.gameOver, true);
  assert.equal(controller.getGameState().winner, mini.client.game.snapshot.winner);

  await network.sendReset('normal_restart'); await mini.client.command('rematch');
  await until(() => network.shared.room.status === 'waiting' && network.shared.room.seq === 0);
  await network.sendReady(true); await mini.client.command('ready'); await until(() => network.canAct());
  // Lose HTTP acknowledgement after the real server commits. Rejoin and dedupe.
  dropAck = true;
  await assert.rejects(network.sendMove([1, 0]), /NETWORK_ERROR/);
  await network.joinRoom(code, network.playerId);
  await until(() => network.isConnected() && !network.shared.pending && mini.client.room.seq === 1);
  assert.equal(network.shared.room.seq, 1);
  assert.equal(sut.ruleView(controller.engine).stateHash, mini.client.game.stateHash);
  assert.equal(await mini.client.act({ type: 'resign' }), true);
  await until(() => network.shared.room.status === 'finished');
  assert.equal(controller.getGameState().winner, 'BLACK');
  await network.leaveRoom();
  await until(() => mini.client.room.status === 'closed');

  // Real Web session issues a code; WeChat identity consumes it, then both
  // login methods recover the same durable profile without sharing passwords.
  const link = await network.issueLinkCode();
  assert.equal(link.code.length, 26);
  await mini.client.loadAccount();
  await mini.client.linkWebAccount(link.code);
  assert.ok(mini.client.account.linkedWeb);
  await network.shared.authenticate(true);
  assert.equal(network.shared.account.uid, mini.client.account.uid);
  assert.equal(network.shared.account.displayName, 'web-friend');
  await assert.rejects(mini.client.linkWebAccount(link.code), /LINK_CODE_INVALID|ACCOUNT_ALREADY_LINKED/);
  await mini.client.unlinkWebAccount();
  assert.equal(Boolean(mini.client.account.linkedWeb), false);
  await network.shared.authenticate(true);
  assert.notEqual(network.shared.account.uid, mini.client.account.uid);

  console.log(JSON.stringify({ status: 'PASS_LOCAL_WEB_MINIGAME_HTTP_WS',
    boundaries: ['real Web password login with isolated user DB', 'fixture wx.login exchange', 'real HTTP/WS', 'real Web GameController restore',
      'production Mini Game Worker', 'moves both directions', 'skip ending', 'resign ending', 'rematch', 'lost ACK recovery',
      'old/tampered state isolation', 'one-time identity binding and unlink'],
    webSnapshots: received.length, deviceVerified: false, productionDeployed: false }));
} finally { network.disconnect(); mini.stop(); }
