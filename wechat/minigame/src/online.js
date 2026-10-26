import { TEXT } from './i18n.js';
import { GameSession } from './session.js';
import { validateSettings, MAX_ACTIONS, withNewGameProtectionRule } from './state.js';
import { ONLINE_CONSENT_KEY, LEGACY_ONLINE_CONSENT_KEY } from './online-consent.js';
import { profileCache, validateProfile } from './profile-cache.js';
import { playerIds } from './controllers.js';

const ROOM_KEY = 'lifeline-wx-room-v1', PENDING_KEY = 'lifeline-wx-command-v1';
const roomCode = (value) => typeof value === 'string' && /^[A-Z2-9]{8}$/.test(value);
export const ONLINE_EMOTES = Object.freeze(['👏', '😭', '😎', '🤝', '❓', '🤔', '💀', '👎', '😓', '😤']);
const EMOTE_CAPABILITY = 'emote-v1';
let sequence = 0;

export function validateRoom(room) {
  if (!room || room.protocol !== 1 || !roomCode(room.code) || !/^[0-9a-f]{32}$/.test(room.matchId)
    || !Number.isSafeInteger(room.revision) || room.revision < 1 || !Number.isSafeInteger(room.seq)
    || !['waiting', 'playing', 'finished', 'closed'].includes(room.status)
    || !Array.isArray(room.actions) || room.actions.length !== room.seq || room.seq > MAX_ACTIONS
    || !Array.isArray(room.actionIds) || room.actionIds.length !== room.seq
    || !/^sha256:[0-9a-f]{64}$/.test(room.stateHash)
    || !room.ready || !room.members || !room.rematchVotes) throw new Error('INVALID_ROOM');
  validateSettings(room.settings);
  const players = playerIds(room.settings.playerCount), bots = room.bots || [];
  if (!players.includes(room.player) || !players.includes(room.currentPlayer)
    || !Array.isArray(bots) || new Set(bots).size !== bots.length || bots.some(player => !players.includes(player))
    || bots.includes(room.player) || (room.hostPlayer !== undefined && !players.includes(room.hostPlayer))) throw new Error('INVALID_ROOM');
  if (room.pendingSettings != null) validateSettings(room.pendingSettings);
  if (room.undo !== undefined && (!room.undo || !Number.isInteger(room.undo.usedCount)
    || room.undo.usedCount < 0 || room.undo.usedCount > (room.settings.undoMaxCount ?? 3)
    || typeof room.undo.pending !== 'boolean' || !Array.isArray(room.undo.votes)
    || new Set(room.undo.votes).size !== room.undo.votes.length
    || room.undo.votes.some(player => !players.includes(player) || bots.includes(player)))) throw new Error('INVALID_ROOM');
  return room;
}

export class OnlineClient {
  constructor(platform, config, scheduler, onChange = () => {}) {
    this.platform = platform; this.config = config; this.scheduler = scheduler; this.onChange = onChange;
    this.game = new GameSession(scheduler, { save: () => {}, read: () => ({ records: [], damaged: [] }) }, onChange, { timedTurns: false, allowUndo: false });
    this.token = null; this.expires = 0; this.room = null; this.socket = null;
    this.active = false; this.connected = false; this.sending = false; this.error = null;
    this.lifecycle = 0; this.syncId = 0; this.retries = 0; this.pending = null;
    this.connectionEpoch = 0; this.connecting = false; this.networkConnected = null;
    this.heartbeat = null; this.reconnectTimer = null; this.connectTimer = null;
    this.deleting = false; this.account = null; this.authenticating = null; this.authEpoch = 0;
    this.profileSequence = 0; this.profileMutation = null;
    this.localProfiles = profileCache(platform, config.apiBase);
    this.emotesSupported = false; this.lastEmote = null; this.emoteError = null;
    this.onEmote = () => {}; this.lastEmoteSentAt = 0;
  }
  notify() { this.onChange(); }
  get savedCode() {
    try { const code = this.platform.storage.get(ROOM_KEY); return roomCode(code) ? code : null; } catch (_) { return null; }
  }
  get enabled() { return this.config.onlineEnabled === true && /^https:\/\//.test(this.config.apiBase || ''); }
  async authenticate(force = false, { duringDeletion = false } = {}) {
    if (this.deleting && !duringDeletion) throw new Error('ACCOUNT_DELETION_PENDING');
    if (!this.enabled) throw new Error('ONLINE_NOT_CONFIGURED');
    if (!force && this.token && Date.now() < this.expires) return;
    if (!this.authenticating) {
      const epoch = this.authEpoch;
      const pending = (async () => {
        const code = await this.platform.login();
        if (epoch !== this.authEpoch) throw new Error('CANCELLED');
        const result = await this.platform.request({ url: `${this.config.apiBase}/api/wechat/login`, method: 'POST', data: { code } });
        this.acceptIdentity(result, epoch);
      })().finally(() => { if (this.authenticating === pending) this.authenticating = null; });
      this.authenticating = pending;
    }
    return this.authenticating;
  }
  acceptIdentity(result, epoch = this.authEpoch) {
    if (epoch !== this.authEpoch) throw new Error('CANCELLED');
    if (!result.token || result.protocol !== 1 || !Number.isFinite(result.expiresIn)) throw new Error('LOGIN_FAILED');
    this.token = result.token; this.expires = Date.now() + Math.max(0, result.expiresIn - 60) * 1000;
    if (this.account?.uid !== result.account?.uid) this.profileSequence++;
    this.account = this.normalizeAccount(result.account); this.notify();
  }
  normalizeAccount(account) {
    if (!account) return null;
    const base = this.config.apiBase.replace(/\/$/, ''), pending = this.localProfiles.read(account.uid);
    const avatarPath = typeof account.avatarUrl === 'string' && account.avatarUrl.startsWith(`${base}/`)
      ? account.avatarUrl.slice(base.length) : account.avatarUrl;
    const result = { ...account, avatarUrl: typeof avatarPath === 'string' && /^\/api\/wechat\/account\/avatar\/[0-9a-f]{32}\/[0-9a-f]{64}$/.test(avatarPath)
      ? base + avatarPath : null, profileSync: pending ? 'pending' : 'synced' };
    // Only our validated, account-scoped saved draft can supply a local data URL.
    if (pending?.fields.displayName !== undefined) result.displayName = pending.fields.displayName;
    if (pending?.fields.avatarDataUrl !== undefined) result.avatarUrl = pending.fields.avatarDataUrl;
    return result;
  }
  async loadAccount() {
    const epoch = this.authEpoch, requestedUid = this.account?.uid;
    await this.authenticate();
    // A refresh must observe every edit already queued, not invalidate its response.
    while (this.profileMutation) await this.profileMutation.catch(() => {});
    if (epoch !== this.authEpoch || this.deleting || (requestedUid && requestedUid !== this.account?.uid)) throw new Error('CANCELLED');
    const sequence = ++this.profileSequence, uid = this.account?.uid;
    const result = await this.request('account', undefined, { accountUid: uid });
    if (epoch !== this.authEpoch || this.deleting || sequence !== this.profileSequence || uid !== this.account?.uid) throw new Error('CANCELLED');
    this.account = this.normalizeAccount(result.account || result); this.notify();
    const pending = this.localProfiles.read(uid);
    if (pending) return this.saveProfile(pending.fields, { localFirst: true });
    return this.account;
  }
  async saveProfile(value, { localFirst = false } = {}) {
    const data = validateProfile(value);
    const epoch = this.authEpoch, requestedUid = this.account?.uid, previous = this.profileMutation;
    const current = () => epoch === this.authEpoch && !this.deleting && (!requestedUid || requestedUid === this.account?.uid);
    // Serialize the POSTs themselves; ignoring late responses alone cannot stop
    // the server from persisting an older edit after a newer one.
    const pending = (async () => {
      if (previous) await previous.catch(() => {});
      if (!current()) throw new Error('CANCELLED');
      let savedUid = this.account?.uid;
      // A known identity can save on this device even while its session is offline.
      // Unknown identities must complete login before an account-scoped save.
      if (!localFirst || !savedUid) await this.authenticate();
      if (!current()) throw new Error('CANCELLED');
      const uid = this.account?.uid, sequence = ++this.profileSequence;
      const changes = { ...(this.localProfiles.read(uid)?.fields || {}), ...data };
      if (localFirst) {
        this.localProfiles.write(uid, changes); savedUid = uid;
        this.account = this.normalizeAccount(this.account); this.notify();
      }
      let result;
      try { result = await this.request('account/profile', changes, { accountUid: uid }); }
      catch (error) {
        if (!current() || uid !== this.account?.uid || sequence !== this.profileSequence) throw new Error('CANCELLED');
        if (!localFirst || savedUid !== uid || /^(?:CANCELLED|ACCOUNT_DELETION|ACCOUNT_DELETED)/.test(error.message)) throw error;
        // The durable draft remains visible and the UI explicitly says cloud sync is pending.
        this.account = this.normalizeAccount(this.account); this.notify(); return this.account;
      }
      if (!current() || uid !== this.account?.uid || sequence !== this.profileSequence) throw new Error('CANCELLED');
      const account = result.account || result;
      if (account.uid !== uid) throw new Error('INVALID_PROFILE');
      if (localFirst || this.localProfiles.read(uid)) this.localProfiles.clear(uid);
      this.account = this.normalizeAccount(account); this.notify(); return this.account;
    })().finally(() => { if (this.profileMutation === pending) this.profileMutation = null; });
    this.profileMutation = pending;
    return pending;
  }
  async linkWebAccount(code) {
    const epoch = this.authEpoch;
    const normalized = String(code || '').replace(/\s/g, '').toUpperCase();
    if (!/^[A-Z2-9]{26}$/.test(normalized)) throw new Error('INVALID_LINK_CODE');
    const result = await this.request('account/link', { code: normalized });
    this.acceptIdentity(result, epoch); return this.account;
  }
  async unlinkWebAccount() {
    const epoch = this.authEpoch;
    await this.authenticate();
    const code = await this.platform.login();
    if (epoch !== this.authEpoch || this.deleting) throw new Error('CANCELLED');
    const result = await this.request('account/unlink', { code });
    this.acceptIdentity(result, epoch); return this.account;
  }
  async request(path, data, { accountUid } = {}) {
    const epoch = this.authEpoch, life = this.lifecycle, roomRequest = path.startsWith('rooms');
    const current = () => epoch === this.authEpoch && !this.deleting && (accountUid === undefined || accountUid === this.account?.uid)
      && (!roomRequest || (life === this.lifecycle && this.active));
    await this.authenticate();
    if (!current()) throw new Error('CANCELLED');
    const send = () => this.platform.request({ url: `${this.config.apiBase}/api/wechat/${path}`,
      method: data === undefined ? 'GET' : 'POST', data,
      header: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' } });
    try { return await send(); }
    catch (error) {
      if (!/UNAUTHORIZED|HTTP_401/.test(error.message)) throw error;
      if (!current()) throw new Error('CANCELLED');
      await this.authenticate(true);
      if (!current()) throw new Error('CANCELLED');
      return send();
    }
  }
  async enter(kind, value) {
    if (this.deleting) throw new Error('ACCOUNT_DELETION_PENDING');
    this.detach(); this.active = true; this.error = null; this.room = null; this.retries = 0;
    this.game.hidden = false; this.game.snapshot = null; this.game.actions = [];
    const life = this.lifecycle;
    try {
      await this.authenticate();
      if (!this.active || life !== this.lifecycle) return false;
      let pending;
      try {
        const raw = this.platform.storage.get(PENDING_KEY) || 'null';
        if (raw.length > 8192) throw new Error('INVALID_PENDING');
        pending = JSON.parse(raw);
      } catch (_) { pending = null; }
      this.pending = pending?.version === 2 && pending.apiBase === this.config.apiBase && pending.uid === this.account?.uid
        && typeof pending.uid === 'string' && roomCode(pending.code) && /^[a-zA-Z0-9_-]{16,80}$/.test(pending.body?.clientActionId)
        && /^[0-9a-f]{32}$/.test(pending.body?.matchId) && Number.isSafeInteger(pending.body?.expectedSeq)
        && ['move', 'skip', 'resign'].includes(pending.body?.action?.type) ? pending : null;
      const room = kind === 'create' ? await this.request('rooms', withNewGameProtectionRule(typeof value === 'object'
        ? { ...value, rulesVersion: value.rulesVersion || 'territory-v3' }
        : { gridSize: value, rulesVersion: 'territory-v3' }))
        : kind === 'join' ? await this.request('rooms/join', { code: value }) : await this.request(`rooms/${value}`);
      if (!this.active || life !== this.lifecycle) return false;
      if (!await this.receive(room)) throw new Error(this.error || 'STATE_MISMATCH');
      try { this.platform.storage.set(ROOM_KEY, room.code); } catch (_) { /* Online snapshot is durable on server. */ }
      void this.connect(); return true;
    } catch (error) {
      if (life !== this.lifecycle) return false;
      this.error = error.message; this.notify(); throw error;
    }
  }
  receive(room) {
    validateRoom(room);
    const existing = this.receiving;
    if (existing && existing.life === this.lifecycle && existing.code === room.code) {
      if (room.revision < existing.revision) return Promise.resolve(false);
      if (room.revision === existing.revision) {
        if (room.stateHash !== existing.stateHash) throw new Error('STATE_MISMATCH');
        return existing.promise;
      }
    }
    // HTTP acknowledgement and the socket broadcast commonly carry the same
    // revision. They must share verification, not cancel each other's Worker.
    const record = { life: this.lifecycle, code: room.code, revision: room.revision, stateHash: room.stateHash };
    this.receiving = record;
    record.promise = this.applyRoom(room).finally(() => { if (this.receiving === record) this.receiving = null; });
    return record.promise;
  }
  async applyRoom(room) {
    if (!this.active || (this.room && (room.code !== this.room.code || room.revision < this.room.revision))) return false;
    const id = ++this.syncId, life = this.lifecycle;
    // Metadata-only updates must not cancel an action verification in flight.
    if (this.room?.stateHash !== room.stateHash || JSON.stringify(this.room?.settings) !== JSON.stringify(room.settings)
      || this.game.replayIndex !== null) {
      const sameMatch = this.room?.matchId === room.matchId;
      const ok = await this.game.load(room.settings, room.actions, { mode: 'human', save: false, paused: true, expectedHash: room.stateHash,
        progress: { hintsUsed: sameMatch ? this.game.hintsUsed : 0, remainingMs: (room.settings.turnTimeLimitSeconds || 60) * 1000 } });
      if (!ok) { if (id === this.syncId) this.error = this.game.error || 'STATE_MISMATCH'; this.notify(); return false; }
    }
    if (!this.active || life !== this.lifecycle || id !== this.syncId) return false;
    this.game.replayIndex = null; this.game.replayView = null;
    const previousUndoCount = this.room?.undo?.usedCount || 0;
    if (this.room?.matchId !== room.matchId) this.lastEmote = null;
    this.room = room; this.error = null; this.game.error = null;
    if (this.pending?.code === room.code) {
      const body = this.pending.body;
      if (body.matchId !== room.matchId || room.actionIds.includes(body.clientActionId)
        || (room.undo?.usedCount || 0) > previousUndoCount) this.clearPending();
      else if (room.seq !== body.expectedSeq || room.stateHash !== body.beforeHash) { this.clearPending(); this.error = 'STALE_POSITION'; }
    }
    this.notify(); return true;
  }
  async connect() {
    if (!this.active || !this.room || this.room.status === 'closed' || this.game.hidden || this.deleting) return;
    this.closeSocket(); const life = this.lifecycle, attempt = this.connectionEpoch, code = this.room.code;
    this.connecting = true;
    const currentAttempt = () => this.active && !this.game.hidden && !this.deleting
      && life === this.lifecycle && attempt === this.connectionEpoch && this.room?.code === code;
    const mayCreateSocket = () => currentAttempt() && this.room.status !== 'closed';
    try {
      await this.authenticate();
      if (!mayCreateSocket()) return;
      const socket = this.platform.connectSocket(`${this.config.apiBase.replace(/^https:/, 'wss:')}/api/wechat/ws`);
      this.socket = socket; let lastSeen = Date.now();
      const current = () => currentAttempt() && this.socket === socket;
      this.connectTimer = setTimeout(() => { if (current() && !this.connected) this.lost(socket); }, 15000);
      socket.onOpen(() => { if (current()) socket.send({ data: JSON.stringify({ protocol: 1, token: this.token, code, capabilities: [EMOTE_CAPABILITY] }) }); });
      socket.onMessage(async (event) => {
        if (!current()) return;
        lastSeen = Date.now();
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'room') {
            if (Array.isArray(message.capabilities)) this.emotesSupported = message.capabilities.includes(EMOTE_CAPABILITY);
            if (await this.receive(message.room) && current()) {
              clearTimeout(this.connectTimer); this.connected = true; this.retries = 0; this.notify();
              if (this.pending?.code === this.room.code && !this.sending) void this.retryPending();
            }
          } else if (message.type === 'emote' && this.emotesSupported) this.receiveEmote(message.emote);
          else if (message.type === 'emote_error' && this.emotesSupported) {
            if (['EMOTE_RATE_LIMIT', 'INVALID_EMOTE', 'EMOTES_UNAVAILABLE'].includes(message.code)) {
              this.emoteError = message.code; this.notify();
            }
          } else if (message.type !== 'pong') throw new Error('INVALID_ROOM');
        } catch (error) { if (current()) { this.error = error.message; this.connected = false; this.notify(); } }
      });
      socket.onClose((event) => {
        if (!current()) return;
        if (event.code === 4009) { this.closeSocket(); this.error = 'OTHER_DEVICE'; this.notify(); return; }
        if (event.code === 4008 || event.code === 4010) {
          this.closeSocket(); this.active = false; this.clearPending();
          try { this.platform.storage.set(ROOM_KEY, ''); } catch (_) {}
          if (this.room) this.room = { ...this.room, status: 'closed' };
          if (event.code === 4008) { this.token = null; this.expires = 0; }
          this.error = event.code === 4008 ? 'ACCOUNT_DELETED' : 'ROOM_REMOVED'; this.notify(); return;
        }
        if (event.code === 4001) this.token = null;
        this.lost(socket);
      });
      socket.onError(() => current() && this.lost(socket));
      this.heartbeat = setInterval(() => {
        if (!current()) return;
        if (Date.now() - lastSeen > 40000) this.lost(socket);
        else socket.send({ data: '{"type":"ping"}', fail: () => current() && this.lost(socket) });
      }, 15000);
    } catch (error) { if (mayCreateSocket()) { this.error = error.message; this.notify(); } }
    finally { if (attempt === this.connectionEpoch) this.connecting = false; }
  }
  async networkChanged(status) {
    const isConnected = status?.isConnected;
    if (typeof isConnected !== 'boolean' || this.networkConnected === isConnected) return false;
    this.networkConnected = isConnected;
    // A network event may repair an existing transport, never join a room or
    // override an identity, ownership or invalid-state error.
    if (!this.enabled || !this.active || !this.room || this.room.status === 'closed' || this.game.hidden || this.deleting
      || (this.error && !['NETWORK_ERROR', 'RECONNECTING'].includes(this.error))) return false;
    if (!isConnected) {
      this.closeSocket(); this.error = 'NETWORK_ERROR'; this.notify(); return false;
    }
    if (this.connected || this.socket || this.connecting) return false;
    this.retries = 0; this.error = 'RECONNECTING'; this.notify();
    await this.connect(); return Boolean(this.socket);
  }
  lost(socket) {
    if (this.socket !== socket) return;
    this.closeSocket(); this.error = 'RECONNECTING'; this.notify();
    if (this.active && this.retries < 6) {
      const life = this.lifecycle, attempt = this.connectionEpoch;
      this.reconnectTimer = setTimeout(() => {
        if (life !== this.lifecycle || attempt !== this.connectionEpoch) return;
        this.reconnectTimer = null; void this.connect();
      }, Math.min(30000, 1000 * 2 ** this.retries++));
    } else { this.error = 'NETWORK_ERROR'; this.notify(); }
  }
  closeSocket() {
    this.connectionEpoch++; this.connecting = false;
    clearInterval(this.heartbeat); clearTimeout(this.connectTimer); clearTimeout(this.reconnectTimer);
    this.heartbeat = this.connectTimer = this.reconnectTimer = null;
    const socket = this.socket; this.socket = null; this.connected = false;
    this.emotesSupported = false; this.lastEmote = null;
    try { socket?.close({ code: 1000 }); } catch (_) { /* Already closed. */ }
  }
  detach() {
    this.active = false; this.lifecycle++; this.syncId++; this.closeSocket(); this.game.pause(); this.sending = false; this.networkConnected = null;
  }
  background() { this.detach(); this.game.hidden = true; }
  async foreground() {
    if (!this.room) return;
    this.active = true; this.game.hidden = false; this.retries = 0;
    const life = this.lifecycle, attempt = this.connectionEpoch;
    const current = () => life === this.lifecycle && attempt === this.connectionEpoch && this.active;
    try { await this.refresh(); if (current()) void this.connect(); }
    catch (error) { if (current()) { this.error = error.message; this.notify(); } }
  }
  async refresh() {
    const life = this.lifecycle, code = this.room?.code;
    if (!code) return false;
    const room = await this.request(`rooms/${code}`);
    return life === this.lifecycle && this.active ? this.receive(room) : false;
  }
  canPlay() {
    return this.active && this.connected && !this.sending && !this.pending && !this.game.busy && !this.error && this.game.replayIndex === null
      && this.room?.status === 'playing' && !this.room.undo?.pending && this.room.player === this.game.snapshot?.currentPlayer;
  }
  canEditSettings() {
    return this.active && this.room && this.room.player === (this.room.hostPlayer || 'BLACK')
      && ['waiting', 'playing', 'finished'].includes(this.room.status)
      && !this.sending && !this.game.busy;
  }
  async hint() {
    if (!this.canPlay() || !this.game.hintsRemaining) return false;
    const game = this.game;
    game.paused = false;
    try { return await game.hint(); }
    finally { game.paused = true; }
  }
  async updateSettings(settings) {
    if (!this.canEditSettings()) return false;
    const life = this.lifecycle, room = this.room; this.sending = true; this.notify();
    try {
      const next = await this.request(`rooms/${room.code}/settings`, { matchId: room.matchId, settings });
      if (life !== this.lifecycle) return false;
      return this.receive(next);
    } catch (error) { if (life === this.lifecycle) this.error = error.message; return false; }
    finally { if (life === this.lifecycle) { this.sending = false; this.notify(); } }
  }
  async voteUndo(accept) {
    if (!this.room || !this.active || this.sending || !this.room.settings.undoEnabled) return false;
    const life = this.lifecycle, room = this.room; this.sending = true; this.notify();
    try {
      const next = await this.request(`rooms/${room.code}/undo`, { matchId: room.matchId,
        expectedSeq: room.seq, beforeHash: room.stateHash, accept });
      if (life !== this.lifecycle) return false;
      return this.receive(next);
    } catch (error) { if (life === this.lifecycle) this.error = error.message; return false; }
    finally { if (life === this.lifecycle) { this.sending = false; this.notify(); } }
  }
  canEmote() {
    return Boolean(this.active && this.connected && this.emotesSupported && this.socket && !this.deleting
      && this.room && this.room.status !== 'closed');
  }
  receiveEmote(emote) {
    if (!this.emotesSupported || !emote || !/^[0-9a-f]{16}$/.test(emote.id)
      || !ONLINE_EMOTES.includes(emote.emoji) || !playerIds(this.room?.settings?.playerCount || 2).includes(emote.player)
      || emote.matchId !== this.room?.matchId || emote.id === this.lastEmote?.id) return false;
    this.lastEmote = { id: emote.id, emoji: emote.emoji, player: emote.player, matchId: emote.matchId };
    this.emoteError = null; this.onEmote(this.lastEmote); this.notify(); return true;
  }
  async sendEmote(emoji) {
    const reject = code => { this.emoteError = code; this.notify(); throw new Error(code); };
    if (!ONLINE_EMOTES.includes(emoji)) return reject('INVALID_EMOTE');
    if (!this.canEmote()) return reject('EMOTES_UNAVAILABLE');
    if (Date.now() - this.lastEmoteSentAt < 1000) return reject('EMOTE_RATE_LIMIT');
    const socket = this.socket, life = this.lifecycle;
    this.lastEmoteSentAt = Date.now(); this.emoteError = null;
    return new Promise((resolve, rejectSend) => {
      let settled = false;
      const finish = error => {
        if (settled) return; settled = true; clearTimeout(timer);
        if (socket !== this.socket || life !== this.lifecycle) { resolve(false); return; }
        if (error) { this.emoteError = 'NETWORK_ERROR'; this.notify(); rejectSend(new Error('NETWORK_ERROR')); }
        else resolve(true);
      };
      const timer = setTimeout(() => finish(true), 3000);
      try {
        socket.send({ data: JSON.stringify({ type: 'emote', emoji, matchId: this.room.matchId }),
          success: () => finish(false), fail: () => finish(true) });
      } catch (_) { finish(true); }
    });
  }
  async command(operation) {
    if (!this.room || this.sending) return false;
    const life = this.lifecycle; this.sending = true; this.notify();
    try {
      const room = await this.request(`rooms/${this.room.code}/${operation}`, { matchId: this.room.matchId });
      if (life !== this.lifecycle) return false;
      if (!await this.receive(room)) return false;
      if (operation === 'leave') { this.platform.storage.set(ROOM_KEY, ''); this.clearPending(); }
      return true;
    } catch (error) { if (life === this.lifecycle) this.error = error.message; return false; }
    finally { if (life === this.lifecycle) { this.sending = false; this.notify(); } }
  }
  async act(action) {
    if (!this.canPlay()) return false;
    const life = this.lifecycle, room = this.room; this.sending = true; this.notify();
    try {
      // Verify locally first, but keep the visible position unchanged until the server acknowledges.
      await this.scheduler.request('APPLY', { settings: room.settings, actions: room.actions,
        action: { ...action, player: room.player } }, this.game.context(), 0);
      if (!this.active || life !== this.lifecycle) return false;
      const pending = { version: 2, apiBase: this.config.apiBase, uid: this.account?.uid, code: room.code, body: { matchId: room.matchId, expectedSeq: room.seq, beforeHash: room.stateHash,
        clientActionId: `${Date.now().toString(36)}-${++sequence}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`, action } };
      const raw = JSON.stringify(pending);
      this.platform.storage.set(PENDING_KEY, raw);
      if (this.platform.storage.get(PENDING_KEY) !== raw) throw new Error('SAVE_WRITE_FAILED');
      this.pending = pending;
    } catch (error) { if (life === this.lifecycle) this.error = error.message; return false; }
    finally { if (life === this.lifecycle) { this.sending = false; this.notify(); } }
    return this.retryPending();
  }
  clearPending() {
    this.pending = null;
    try { this.platform.storage.set(PENDING_KEY, ''); return true; } catch (_) { return false; }
  }
  async retryPending() {
    if (!this.active || !this.pending || this.pending.code !== this.room?.code || this.sending) return false;
    const pending = this.pending, life = this.lifecycle; this.sending = true; this.error = null; this.notify();
    try {
      const room = await this.request(`rooms/${pending.code}/actions`, pending.body);
      if (life !== this.lifecycle) return false;
      await this.receive(room); return !this.pending;
    } catch (error) {
      if (life !== this.lifecycle) return false;
      this.error = error.message;
      if (/STALE_|NOT_YOUR_TURN|MATCH_NOT|COMMAND_ID|INVALID_ACTION|ROOM_CLOSED|ROOM_EXPIRED/.test(error.message)) {
        this.clearPending();
        try { await this.refresh(); } catch (_) { /* Keep the actionable error. */ }
      }
      return false;
    } finally { if (life === this.lifecycle) { this.sending = false; this.notify(); } }
  }
  sharePayload() { return this.room ? { title: TEXT.zh.title, query: `room=${this.room.code}` } : { title: TEXT.zh.title }; }
  async deleteAccount() {
    if (this.deleting) return false;
    this.deleting = true; this.authEpoch++; this.authenticating = null; this.detach(); this.error = null; this.notify();
    try {
      await this.authenticate(false, { duringDeletion: true });
      const code = await this.platform.login();
      const result = await this.platform.request({ url: `${this.config.apiBase}/api/wechat/account/delete`, method: 'POST',
        header: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, data: { code } });
      if (result.protocol !== 1 || result.deleted !== true) throw new Error('INVALID_ROOM');
      const deletedUid = this.account?.uid;
      this.token = null; this.expires = 0; this.room = null; this.account = null;
      try { this.localProfiles.clear(deletedUid); } catch (_) { this.error = 'DELETE_LOCAL_CLEANUP'; }
      if (!this.clearPending()) this.error = 'DELETE_LOCAL_CLEANUP';
      this.game.snapshot = null; this.game.actions = []; this.game.replayIndex = null; this.game.replayView = null;
      for (const key of [ROOM_KEY, ONLINE_CONSENT_KEY, LEGACY_ONLINE_CONSENT_KEY]) {
        try {
          this.platform.storage.set(key, '');
          if (this.platform.storage.get(key)) this.error = 'DELETE_LOCAL_CLEANUP';
        } catch (_) { this.error = 'DELETE_LOCAL_CLEANUP'; }
      }
      this.notify(); return true;
    } catch (error) { this.error = error.message; this.notify(); return false; }
    finally { this.authEpoch++; this.authenticating = null; this.deleting = false; this.notify(); }
  }
}
