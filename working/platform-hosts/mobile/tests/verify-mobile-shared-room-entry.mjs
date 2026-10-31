import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import GameEngine from '../../web/web前端/GameEngine.js';
import { canonicalize, serializeRuleState } from '../../web/web前端/ReplayCodec.js';
import { sharedRoomCreateSettings } from '../../web/web前端/SharedRoomClient.js';
import CrossPlatformNetwork from '../../web/web前端/CrossPlatformNetwork.js';

globalThis.crypto ??= webcrypto;
globalThis.location = new URL('https://localhost/index.html');
const settings = sharedRoomCreateSettings({ playerCount: 2, gridSize: 9, startPlayer: 'BLACK', boardShape: 'triangle', botCount: 0 });
const engine = new GameEngine(settings), snapshot = engine.getSnapshot();
const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalize(serializeRuleState(engine))));
const room = {
  protocol: 1, code: 'ABCD2345', matchId: 'a'.repeat(32), revision: 1, seq: 0,
  actions: [], actionIds: [], player: 'BLACK', currentPlayer: snapshot.currentPlayer,
  status: 'waiting', ready: { BLACK: false, WHITE: false },
  members: { BLACK: true, WHITE: false }, rematchVotes: {}, hostPlayer: 'BLACK',
  settings, bots: [], scores: { BLACK: snapshot.territories.BLACK.area, WHITE: snapshot.territories.WHITE.area },
  gameOver: snapshot.gameOver, winner: snapshot.winner,
  stateHash: 'sha256:' + [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join(''),
};
const requests = [], sockets = [];
globalThis.fetch = async (url, options) => {
  requests.push({ url: String(url), auth: options.headers.Authorization ?? null });
  if (String(url).endsWith('/status')) return { ok: true, json: async () => ({ enabled: true, webLogin: true, webAuthMode: 'legacy-jwt' }) };
  if (String(url).endsWith('/login/web')) return { ok: true, json: async () => ({ protocol: 1, token: 'synthetic-shared-token', expiresIn: 600, account: { uid: 'fixture' } }) };
  if (String(url).endsWith('/rooms')) return { ok: true, json: async () => structuredClone(room) };
  throw new Error('Unexpected request: ' + url);
};
globalThis.WebSocket = class extends EventTarget {
  constructor(url) { super(); this.url = url; sockets.push(this); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
  send(value) {
    const message = JSON.parse(value);
    assert.equal(message.token, 'synthetic-shared-token');
    queueMicrotask(() => this.dispatchEvent(Object.assign(new Event('message'), {
      data: JSON.stringify({ type: 'room', room: structuredClone(room), capabilities: [] }),
    })));
  }
  close() {}
};
const manager = new CrossPlatformNetwork();
manager.url = 'wss://lifelinegame.cn/ws';
manager.setAuthToken('synthetic-web-token');
const result = await manager.createSharedRoom(settings);
assert.equal(result.roomId, 'ABCD2345');
assert.equal(manager.sharedActive, true);
assert.ok(requests.every(({ url }) => url.startsWith('https://lifelinegame.cn/api/wechat/')));
assert.equal(requests.find(({ url }) => url.endsWith('/login/web')).auth, 'Bearer synthetic-web-token');
assert.equal(requests.find(({ url }) => url.endsWith('/rooms')).auth, 'Bearer synthetic-shared-token');
assert.equal(sockets[0].url, 'wss://lifelinegame.cn/api/wechat/ws');
manager.disconnect();
console.log('verify-mobile-shared-room-entry: PASS (synthetic HTTPS exchange, room verification and socket)');
