// Frozen Mini main + Worker, drawn UI touches, real loopback service and Web peer.
// No Mini source modules or application internals are imported by this scenario.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { build } from '../tools/native-build.mjs';
import { createCompiledOnlineHarness } from './compiled-online-harness.mjs';

const { values: args } = parseArgs({ options: Object.fromEntries(
  ['origin', 'candidate', 'stage', 'output', 'auth-mode', 'expected-version', 'service-version', 'web-version', 'profile-checks', 'expected-notice-version'].map(key => [key, { type: 'string' }])) });
for (const key of ['origin', 'candidate', 'stage', 'output', 'expected-version']) assert.ok(args[key], `--${key} required`);
assert.match(args.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
const frozenMetadata = JSON.parse(await fs.readFile(path.join(args.candidate, 'candidate.json'), 'utf8'));
assert.equal(frozenMetadata.version, args['expected-version'], 'Frozen candidate version must match explicit expectation');
const authMode = args['auth-mode'] || 'legacy-jwt';
assert.ok(['legacy-jwt', 'password'].includes(authMode));
const passwordMode = authMode === 'password';
const report = { status: 'RUNNING', versions: { mini: args['expected-version'], web: args['web-version'] || 'r4', service: args['service-version'] || 'r4' }, scope: 'COMPILED_UI_LOCAL_HTTP_WS_ONLY',
  checks: [], webSnapshots: [], deviceVerified: false, realWechatExchange: false,
  productionDeployed: false, uploaded: false, authMode,
  browserPasswordFormVerified: false,
  passwordInputDriver: passwordMode ? 'TEST_CALLBACK' : null,
  legacyLoginEndpoint: passwordMode ? 'SYNTHETIC_LEGACY_PASSWORD_FIXTURE' : 'CAPTURED_LEGACY_SERVER_ROUTE' };
const webTrace = { requests: [], sockets: [], errors: [], emotes: [] };
let mini, network, cleanup, failure, legacyToken = null, passwordPrompts = 0;
const check = (name, condition = true) => { assert.ok(condition, name); report.checks.push(name); };
const hash = value => createHash('sha256').update(value).digest('hex');
const webFetch = async (url, options = {}) => {
  const target = new URL(String(url));
  assert.equal(target.origin, args.origin, 'Web requests stay on exact loopback origin');
  assert.ok(target.pathname === '/api/login' || target.pathname.startsWith('/api/wechat/'));
  const authorization = options.headers?.Authorization || options.headers?.authorization;
  const item = { path: target.pathname, method: options.method || 'GET', settled: false,
    authentication: !authorization ? 'none' : legacyToken && authorization === `Bearer ${legacyToken}` ? 'legacy-web' : 'shared-or-other' };
  webTrace.requests.push(item);
  try {
    const response = await fetch(url, { ...options, redirect: 'error' });
    item.status = response.status; return response;
  } finally { item.settled = true; }
};
class LoopbackSocket extends WebSocket {
  constructor(url) {
    assert.equal(String(url), args.origin.replace('http:', 'ws:') + '/api/wechat/ws');
    super(url);
    const item = { closed: false, events: [], messages: [] };
    webTrace.sockets.push(item);
    for (const type of ['open', 'message', 'error', 'close']) this.addEventListener(type, event => {
      item.events.push(type);
      if (type === 'message') { const packet = JSON.parse(event.data); item.messages.push({ type: packet.type, ...(packet.type === 'emote' ? { emote: packet.emote } : {}) }); }
      if (type === 'close') { item.closed = true; item.closeCode = event.code; }
      if (type === 'error') webTrace.errors.push('socket error');
    });
  }
}
const webDir = path.join(args.stage, 'web/web前端');
const bundle = await build({
  stdin: { contents: `export {default as Network} from './CrossPlatformNetwork.js';
    export {ServerEvent} from './NetworkManager.js';
    export {default as Controller} from './GameController.js';
    export {default as WebEngine} from './GameEngine.js';
    export {canonicalize, serializeRuleState} from './ReplayCodec.js';`, resolveDir: webDir },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent', metafile: true,
  plugins: [{ name: 'captured-web-query-imports', setup(builder) {
    builder.onResolve({ filter: /\?v=/ }, item => ({ path: path.resolve(item.resolveDir, item.path.split('?')[0]) }));
  } }],
});
report.webInputs = Object.keys(bundle.metafile.inputs).filter(name => name !== '<stdin>').map(name => {
  const filename = path.resolve(name);
  const relative = path.relative(webDir, filename);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Every Web dependency is inside supplied frozen frontend');
  return relative.split(path.sep).join('/');
});
// Keep failures readable without printing the entire data URL bundle.
Error.prepareStackTrace = (error, frames) => `${error.name}: ${error.message}\n${frames.slice(0, 10).map(frame =>
  `  at ${frame.getFunctionName() || '<anonymous>'} (${String(frame.getFileName()).startsWith('data:') ? '<captured Web bundle>' : frame.getFileName()}:${frame.getLineNumber()})`).join('\n')}`;
const { Network, Controller, WebEngine, canonicalize, serializeRuleState, ServerEvent } =
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const stateHash = engine => 'sha256:' + hash(canonicalize(serializeRuleState(engine)));
const webData = new Map();
const controller = Object.create(Controller.prototype);
Object.assign(controller, {
  canvas: { style: {}, setAttribute() {} },
  options: { engine: { gridSize: 7, rulesVersion: 'territory-v2', playerCount: 2, startPlayer: 'BLACK' } },
  engine: new WebEngine({ gridSize: 7, rulesVersion: 'territory-v2', playerCount: 2, startPlayer: 'BLACK' }),
  renderer: { invalidate() {}, render() {} }, _validGridPoints: [], _engineEpoch: 1,
  _networkUnsubscribers: [], _authoritativeSnapshotValid: true, multiplayerEnabled: true,
  localPlayer: 'WHITE', roomReady: false, opponentConnected: false, lastAction: null,
  networkErrorListener: error => webTrace.errors.push(String(error?.message || error)), stateChangeListener() {},
});
network = new Network({ fetch: webFetch, WebSocket: LoopbackSocket, storage: {
  getItem: key => webData.get(key), setItem: (key, value) => webData.set(key, value),
  removeItem: key => webData.delete(key),
}, ...(passwordMode ? { requestPasswordSession: async ({ signal, login }) => {
  passwordPrompts++;
  assert.equal(signal.aborted, false);
  if (passwordPrompts === 1) {
    await assert.rejects(login({ username: 'web-friend', password: 'incorrect-fixture-password' }),
      error => error.message === 'UNAUTHORIZED');
    check('deployed Web password callback receives real 401 for incorrect password');
  }
  return login({ username: 'web-friend', password: 'test-only-password' });
} } : {}) });
for (const event of ['ROOM_CREATED', 'ROOM_JOINED', 'ROOM_STATE']) network.on(event, payload => {
  try {
    controller.enableMultiplayer({ networkManager: network, localPlayer: payload.color,
      roomReady: payload.status === 'IN_PROGRESS', opponentConnected: payload.players.length === 2 }, false);
    assert.equal(controller.restoreMatchState(payload.matchState).success, true);
    report.webSnapshots.push({ actions: payload.matchState.actions.length, hash: stateHash(controller.engine) });
  } catch (error) { webTrace.errors.push(error.stack); }
});
network.on(ServerEvent.CHAT_EMOJI, event => webTrace.emotes.push(event));
try {
  mini = await createCompiledOnlineHarness({
    candidateDir: args.candidate, loopbackOrigin: args.origin, loginCode: 'red',
  });
  report.candidateHashes = mini.hashes;
  const wait = (predicate, label) => mini.waitFor(predicate, { timeoutMs: 10000, label });
  const tap = async text => {
    // Observe the actual drawn enabled colour; a label can remain visible while
    // its action is disabled during Worker processing or room readiness.
    const enabled = (value, item) => value === text && item.align === 'center' && item.color !== '#9b9183';
    await mini.waitText(enabled); mini.tapText(enabled);
  };
  const modal = async pattern => {
    await wait(() => mini.modal.pending.length, `modal ${pattern}`);
    const current = mini.modal.pending[0];
    assert.match(String(current.content || current.title), pattern);
    return current;
  };
  const sheet = async label => {
    await wait(() => mini.actionSheet.pending.length, `action sheet ${label}`);
    assert.ok(mini.actionSheet.pending[0].itemList.includes(label));
  };
  const latestRoom = () => {
    const messages = mini.trace.sockets.flatMap(socket => socket.events)
      .filter(event => event.type === 'message').map(event => {
        try { return JSON.parse(event.data); } catch { return {}; }
      }).filter(event => event.type === 'room');
    return messages.at(-1)?.room;
  };
  const workerResponse = () => mini.trace.workerMessages.filter(message =>
    message.direction === 'worker-to-main' && message.ok && message.result?.stateHash).at(-1);
  const synchronized = async (seq, label, restoredResponse = null) => {
    await wait(() => {
      const room = network.shared.room, message = restoredResponse || workerResponse();
      if (room?.seq !== seq || latestRoom()?.seq !== seq || latestRoom()?.matchId !== room.matchId
        || !message?.delivered || message.result.stateHash !== room.stateHash
        || stateHash(controller.engine) !== room.stateHash
        || (mini.trace.frames.at(-1)?.id || 0) <= message.frameIdAtEmission) return false;
      const texts = mini.texts.map(item => item.text);
      const side = { BLACK: '蓝方', WHITE: '红方' };
      if (room.status === 'finished') {
        if (!texts.includes(room.winner === 'DRAW' ? '平局' : `${side[room.winner]} 获胜`)
          || !texts.includes('结算详情') || !texts.includes('再来一局')) return false;
      } else if (!texts.includes(`${room.code} · ${side[room.currentPlayer]}`)) return false;
      const last = room.actions.at(-1);
      if (last && !texts.includes(`上一步 · ${{ move: '落子', skip: '跳过', resign: '认输' }[last.type]}`)) return false;
      return true;
    }, label);
    report.uiStates ||= [];
    report.uiStates.push({ seq, matchId: network.shared.room.matchId,
      status: network.shared.room.status, hash: network.shared.room.stateHash,
      workerDelivered: (restoredResponse || workerResponse()).delivered, frameId: mini.trace.frames.at(-1).id,
      texts: mini.texts.map(item => item.text) });
    check(label);
  };
  const accountResult = suffix => mini.trace.requests.filter(item =>
    new URL(item.url).pathname.endsWith(suffix) && item.settled && item.statusCode === 200).at(-1)?.responseData;

  await mini.waitText('确认落子');
  await wait(() => mini.arcs.some(arc => arc.radius === 2.4), 'initial legal dots');
  check('cold launch immediately draws playable board', mini.trace.logins.length === 0 && mini.trace.requests.length === 0);
  await tap('对战舱'); await tap('微信登录');
  await modal(/联机服务：https:\/\/lifelinegame\.cn/);
  const denial = await mini.modal.respond({ confirm: false });
  assert.equal(denial.delivered, true);
  await wait(() => mini.modal.pending.length === 0, 'consent rejected');
  check('declining account consent sends no login or network', mini.trace.logins.length === 0 && mini.trace.requests.length === 0);
  await tap('微信登录'); await modal(/联机服务：https:\/\/lifelinegame\.cn/);
  await mini.modal.respond({ confirm: true });
  await mini.waitText('已登录 · 尚未关联网页账号');
  await wait(() => accountResult('/account'), 'account refresh response settles');
  check('explicit consent reaches real fixture login and account endpoint',
    mini.trace.logins.length === 1 && Boolean(accountResult('/account')));
  const consent = JSON.parse(mini.storage.get('lifeline-wx-online-consent-v2'));
  // 0.11 adds optional nickname/avatar processing to the account notice.
  // Keep the expectation independent of Mini source and preserve older runs.
  const expectedNoticeVersion = args['expected-notice-version'] || (args['expected-version'] === '0.11.0'
    ? '2026-10-22.1' : '2026-10-21.1');
  check('consent persists the packaged HTTPS origin and notice version',
    consent.origin === 'https://lifelinegame.cn' && consent.version === expectedNoticeVersion);
  if (args['profile-checks'] === 'nickname') {
    await tap('修改昵称'); await modal(/游戏昵称/);
    await mini.modal.respond({ confirm: true, content: '跨端测试玩家' });
    await mini.waitText('游戏资料已保存。');
    check('compiled nickname editor saves through the staged profile endpoint',
      accountResult('/account/profile')?.displayName === '跨端测试玩家');
    const previousRefreshes = mini.trace.requests.filter(r => new URL(r.url).pathname.endsWith('/account')).length;
    await tap('刷新账号');
    await wait(() => mini.trace.requests.filter(r => new URL(r.url).pathname.endsWith('/account') && r.settled).length > previousRefreshes, 'profile reload');
    await mini.waitText('跨端测试玩家');
    check('compiled account refresh reloads the persisted public nickname',
      accountResult('/account')?.displayName === '跨端测试玩家');
  }
  await tap('创建房间');
  await mini.waitText('我准备好了');
  await wait(() => latestRoom()?.status === 'waiting', 'created room socket snapshot');
  check('friend entry reuses explicit account consent', mini.modal.pending.length === 0 && mini.trace.logins.length === 1);
  const code = latestRoom().code;
  check('drawn friend button creates eight character shared room', /^[A-Z2-9]{8}$/.test(code));
  check('room creator is Mini BLACK', latestRoom().player === 'BLACK');

  const loginResponse = await webFetch(args.origin + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'web-friend', password: 'test-only-password' }),
  });
  assert.equal(loginResponse.status, 200);
  const login = await loginResponse.json();
  legacyToken = login.token;
  if (passwordMode) {
    const denied = await webFetch(args.origin + '/api/wechat/login/web', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${legacyToken}` }, body: '{}',
    });
    check('standalone password mode refuses a correctly signed default-key legacy JWT',
      denied.status === 503 && (await denied.json()).detail === 'WEB_LOGIN_NOT_CONFIGURED');
  }
  network.url = args.origin.replace('http:', 'ws:') + '/ws'; network.setAuthToken(login.token);
  await network.joinRoom(code);
  check(passwordMode ? 'synthetic legacy account joins Mini room through standalone password verifier'
    : 'real legacy Web password account joins Mini room', network.shared.account.provider === 'web');
  if (args['profile-checks'] === 'nickname') check('frozen Web peer receives the saved Mini public nickname',
    network.shared.room.playerProfiles?.BLACK?.displayName === '跨端测试玩家');
  if (passwordMode) check('frozen Web adapter selects password mode and exchanges credentials without old JWT',
    network.shared.webAuthMode === 'password' && passwordPrompts === 1
      && webTrace.requests.filter(item => item.path.endsWith('/login/password-session')).every(item => item.authentication === 'none'));
  await wait(() => latestRoom()?.members.WHITE, 'Mini sees Web friend');
  await tap('我准备好了'); await network.sendReady(true);
  await wait(() => latestRoom()?.status === 'playing', 'both ready');
  await mini.waitText('确认落子');
  await wait(() => mini.arcs.some(arc => arc.radius === 2.4), 'online legal dots');
  mini.tap(mini.arcs.find(arc => arc.radius === 2.4));
  await mini.waitText('落点已选好，确认后落子');
  await tap('确认落子');
  await synchronized(1, 'Mini visible point and confirmation reach Web with matching state hash');
  await wait(() => network.canAct(), 'Web turn');
  const point = controller.engine.getSnapshot().legalMoves[0].point;
  controller._getCanvasRelativePosition = () => ({ x: 0, y: 0 });
  controller._findNearestGridPoint = () => point;
  const beforePointer = stateHash(controller.engine);
  assert.equal(controller._processPointer(0, 0).pending, true);
  assert.equal(stateHash(controller.engine), beforePointer, 'Web waits for authoritative commit');
  await synchronized(2, 'real Web controller move reaches compiled Mini Worker with matching state hash');

  // Both reactions traverse the supplied service socket server. They are transient,
  // never game actions; UI buttons and public Web adapter are the only drivers.
  const emotePackets = () => mini.trace.sockets.flatMap(socket => socket.events)
    .filter(event => event.type === 'message').map(event => JSON.parse(event.data))
    .filter(packet => packet.type === 'emote');
  const bubble = item => /^(蓝方|红方) [👏😭😎🤝❓🤔💀👎😓😤]/u.test(item.text);
  await wait(() => network.canEmote(), 'frozen Web advertises emote capability');
  const emoteState = { seq: network.shared.room.seq, hash: network.shared.room.stateHash, matchId: network.shared.room.matchId };
  await tap('👏');
  await mini.waitText('蓝方 👏');
  await wait(() => webTrace.emotes.some(event => event.content === '👏' && event.color === 'BLACK'), 'Mini emote reaches Web event adapter');
  check('Mini fixed reaction is echoed by supplied server and delivered through Web CHAT_EMOJI',
    emotePackets().some(packet => packet.emote.emoji === '👏' && packet.emote.player === 'BLACK'));
  await network.sendChatEmoji('🤝');
  await mini.waitText('红方 🤝');
  await wait(() => webTrace.emotes.some(event => event.content === '🤝' && event.color === 'WHITE'), 'Web emote echo');
  const webReactionAcknowledgedAt = performance.now();
  check('Web fixed reaction is echoed and visibly drawn in compiled Mini',
    emotePackets().some(packet => packet.emote.emoji === '🤝' && packet.emote.player === 'WHITE'));
  assert.deepEqual({ seq: network.shared.room.seq, hash: network.shared.room.stateHash, matchId: network.shared.room.matchId }, emoteState);
  await synchronized(2, 'bidirectional reactions preserve rule state and action sequence');
  report.emotes = { beforeReconnect: emotePackets().map(packet => packet.emote),
    webBeforeReconnect: webTrace.emotes.length };

  // Native lifecycle events close/reopen actual loopback sockets and preserve state.
  const socketCount = mini.trace.sockets.length, preservedHash = network.shared.room.stateHash;
  mini.lifecycle.hide();
  await wait(() => mini.trace.sockets.every(socket => socket.closed), 'Mini background closes socket');
  mini.lifecycle.show();
  await wait(() => mini.trace.sockets.length > socketCount
    && mini.trace.sockets.at(-1).events.some(event => event.type === 'message'), 'foreground rejoins');
  await synchronized(2, 'foreground restores the same authoritative position');
  assert.equal(network.shared.room.stateHash, preservedHash);
  const resumedSocket = mini.trace.sockets.at(-1);
  check('Mini reconnect receives no historical emotes and clears old bubble',
    resumedSocket.events.filter(event => event.type === 'message').every(event => JSON.parse(event.data).type !== 'emote')
    && !mini.texts.some(bubble));
  const webEmoteCount = webTrace.emotes.length;
  const webSocketCount = webTrace.sockets.length;
  network.disconnect();
  await wait(() => webTrace.sockets.every(socket => socket.closed), 'Web disconnect closes sockets');
  await network.shared.connect();
  await synchronized(2, 'Web reconnect restores identical authoritative position');
  check('Web reconnect receives no historical emotes and clears adapter transient state',
    webTrace.sockets.length === webSocketCount + 1 && webTrace.emotes.length === webEmoteCount
    && network.shared.lastEmote === null && webTrace.sockets.at(-1).messages.every(packet => packet.type !== 'emote'));
  // Confirm the newly established transports can deliver a fresh reaction.
  // Reconnecting resets the client's transient send clock, while the server's
  // per-user cooldown persists. Wait from an acknowledged delivery instead.
  await wait(() => performance.now() - webReactionAcknowledgedAt >= 1100, 'server reaction rate window after last acknowledged delivery');
  await network.sendChatEmoji('😎'); await mini.waitText('红方 😎');
  await wait(() => webTrace.emotes.length === webEmoteCount + 1, 'fresh reaction echoes on replacement socket');
  check('fresh reaction crosses both replacement transports without replaying old ones',
    resumedSocket.events.filter(event => event.type === 'message').map(event => JSON.parse(event.data))
      .filter(packet => packet.type === 'emote').length === 1);
  report.emotes.afterReconnect = emotePackets().map(packet => packet.emote);
  await tap('跳过');
  await synchronized(3, 'visible skip button sends authoritative pass');
  await wait(() => network.canAct(), 'Web can pass');
  await network.sendSkip();
  await synchronized(4, 'consecutive passes settle identically in both clients');
  assert.equal(network.shared.room.status, 'finished');
  await tap('再来一局'); await network.sendReset('normal_restart');
  await wait(() => network.shared.room?.status === 'waiting' && latestRoom()?.status === 'waiting', 'rematch accepted');
  await tap('我准备好了'); await network.sendReady(true);
  await wait(() => latestRoom()?.status === 'playing', 'rematch ready');
  await synchronized(0, 'visible rematch resets both clients after both votes');
  await tap('认输'); await modal(/确认认输/); await mini.modal.respond({ confirm: true });
  await synchronized(1, 'visible resign with confirmation settles both clients');
  assert.equal(network.shared.room.winner, 'WHITE');
  await tap('对战舱'); await tap('结束房间'); await modal(/结束房间/);
  await mini.modal.respond({ confirm: true });
  await wait(() => network.shared.room?.status === 'closed', 'room closed for Web');
  await wait(() => mini.trace.sockets.every(socket => socket.closed), 'leaving detaches Mini socket');
  await network.leaveRoom();
  check('visible leave closes room and detaches transport');
  await mini.waitText('确认落子');

  check('password adapter never automatically exchanges the old weak JWT',
    webTrace.requests.filter(item => item.path.endsWith('/login/web')).length === 1);
  check('shared client storage contains neither fixture password nor authentication tokens',
    [...webData.values()].every(value => !String(value).includes('test-only-password')
      && !String(value).includes(legacyToken) && !String(value).includes(network.shared.token)));
  report.passwordPrompts = passwordPrompts;
  check('all Mini requests mapped to loopback', mini.trace.requests.every(item =>
    item.mappedUrl?.startsWith(args.origin + '/api/wechat/')));
  check('no hidden runtime or Web peer errors', mini.trace.errors.length === 0 && webTrace.errors.length === 0);
  check('no attempted external transport', mini.trace.blocked.length === 0);
  report.status = 'PASS_COMPILED_UI_LOCAL_HTTP_WS';
} catch (error) {
  failure = error;
  report.status = 'FAIL'; report.error = error.stack;
  report.lastTexts = mini?.texts?.map(item => item.text);
  report.pendingModal = mini?.modal.pending;
  report.pendingSheet = mini?.actionSheet.pending;
} finally {
  network?.disconnect();
  if (mini) {
    // Persist compact observations, never the fixture tokens or one-time code.
    report.transport = { miniLogins: mini.trace.logins.length,
      miniRequests: mini.trace.requests.map(item => ({ path: new URL(item.url).pathname,
        method: item.method, status: item.statusCode, settled: item.settled })),
      miniSockets: mini.trace.sockets.map(item => ({ closed: item.closed, events: item.events.map(event => event.type) })),
      workerResponses: mini.trace.workerMessages.filter(item => item.direction === 'worker-to-main').length,
      errors: mini.trace.errors.map(item => String(item?.message || item)), blocked: mini.trace.blocked.length,
      web: webTrace };
    cleanup = await mini.dispose(); report.cleanup = cleanup;
    const closeDeadline = Date.now() + 3000;
    while (webTrace.sockets.some(socket => !socket.closed) && Date.now() < closeDeadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (webTrace.sockets.some(socket => !socket.closed)
      || Object.values(cleanup.remaining).some(count => count !== 0)
      || mini.trace.errors.length || mini.trace.blocked.length || webTrace.errors.length) {
      failure ||= new Error('Unclean transport shutdown or runtime errors'); report.status = 'FAIL';
      report.error ||= failure.stack;
    }
  }
  report.webBundleSha256 = hash(bundle.outputFiles[0].text);
  await fs.writeFile(args.output, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ status: report.status, checks: report.checks.length,
  webSnapshots: report.webSnapshots.length, output: args.output, cleanup }));
if (failure) throw failure;
