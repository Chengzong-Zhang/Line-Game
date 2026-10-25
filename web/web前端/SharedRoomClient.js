import GameEngine from "./GameEngine.js?v=20261025-room1";
import { canonicalize, serializeRuleState } from "./ReplayCodec.js?v=20261025-room1";
import { ROOM_PLAYER_COLORS, roomBotColors } from "./OnlineRoomSettings.js?v=20261025-room1";

const CODE = /^[A-Z2-9]{8}$/;
const PENDING = "lifeline-shared-command-v1";
const COLORS = ROOM_PLAYER_COLORS;
export const SHARED_EMOTES = Object.freeze(["👏", "😭", "😎", "🤝", "❓", "🤔", "💀", "👎", "😓", "😤"]);
const EMOTE_CAPABILITY = "emote-v1";

export function sharedApiOrigin(socketUrl) {
  const url = new URL(socketUrl, globalThis.location?.href);
  if (url.username || url.password || !["wss:", "ws:", "https:", "http:"].includes(url.protocol)) throw new Error("INVALID_SERVER");
  url.protocol = ["wss:", "https:"].includes(url.protocol) ? "https:" : "http:";
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("HTTPS_REQUIRED");
  return url.origin;
}

export async function verifySharedRoom(room) {
  const count = room?.settings?.playerCount;
  const colors = COLORS.slice(0, count);
  if (!room || room.protocol !== 1 || !CODE.test(room.code) || !/^[0-9a-f]{32}$/.test(room.matchId)
    || !Number.isSafeInteger(room.revision) || room.revision < 1 || !Number.isSafeInteger(room.seq) || room.seq < 0 || room.seq > 3000
    || !Array.isArray(room.actions) || room.actions.length !== room.seq
    || !Array.isArray(room.actionIds) || room.actionIds.length !== room.seq || new Set(room.actionIds).size !== room.seq
    || !colors.includes(room.player) || !colors.includes(room.currentPlayer)
    || !["waiting", "playing", "finished", "closed"].includes(room.status)
    || !room.ready || !room.members || !room.rematchVotes
    || !["territory-v2", "territory-v3"].includes(room.settings?.rulesVersion) || ![2, 3, 4, 5, 6].includes(count)
    || !colors.includes(room.settings.startPlayer) || !Number.isInteger(room.settings.botCount ?? 0)
    || (room.settings.botCount ?? 0) < 0 || (room.settings.botCount ?? 0) >= count
    || !Number.isInteger(room.settings.gridSize)
    || room.settings.gridSize < 5 || room.settings.gridSize > 15
    || colors.some(color => typeof room.members[color] !== "boolean" || typeof room.ready[color] !== "boolean")
    || (room.hostPlayer !== undefined && !colors.includes(room.hostPlayer))) throw new Error("INVALID_ROOM");
  if (room.settings.playerSetup && JSON.stringify(roomBotColors(room.settings)) !== JSON.stringify(room.bots ?? [])) throw new Error("INVALID_ROOM");
  const engine = new GameEngine({ ...room.settings, deferTerritoryUpdates: false });
  engine.replayBatch(game => {
    for (const action of room.actions) {
      if (!colors.includes(action.player) || (action.type !== "resign" && action.player !== game.currentPlayer)) throw new Error("INVALID_ROOM_ACTION");
      let result;
      if (action.type === "move" && Array.isArray(action.point) && action.point.length === 2 && action.point.every(Number.isInteger)) result = game.playMove(action.point);
      else if (action.type === "skip") result = game.skipTurn();
      else if (action.type === "resign") result = game.resignPlayer(action.player);
      if (!result?.success) throw new Error("INVALID_ROOM_ACTION");
    }
    return { success: true };
  });
  if (!globalThis.crypto?.subtle) throw new Error("HTTPS_REQUIRED");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalize(serializeRuleState(engine))));
  const hash = `sha256:${Array.from(new Uint8Array(digest), v => v.toString(16).padStart(2, "0")).join("")}`;
  const snapshot = engine.getSnapshot();
  if (hash !== room.stateHash || snapshot.currentPlayer !== room.currentPlayer || snapshot.gameOver !== room.gameOver
    || snapshot.winner !== room.winner || colors.some(p => snapshot.territories[p].area !== room.scores?.[p])) throw new Error("STATE_MISMATCH");
  if ((room.status === "finished" && !snapshot.gameOver) || (room.status === "playing" && snapshot.gameOver)) throw new Error("INVALID_ROOM");
  return engine;
}

// This adapter feeds the real Web GameController its existing snapshot contract.
// Room state, turns, pass/resign and rematches are always decided by the same
// service as the Mini Game. No opponent action is applied optimistically.
export function sharedRoomPayload(room, type = "ROOM_STATE") {
  const colors = COLORS.slice(0, room.settings.playerCount);
  const playing = room.status === "playing" || room.status === "finished";
  const full = colors.every(p => room.members[p]);
  const playerId = `${room.code}:${room.player}`;
  return {
    type, shared: true, roomId: room.code, matchId: room.matchId, playerId, yourPlayerId: playerId,
    color: room.player, yourColor: room.player, hostPlayerId: `${room.code}:${room.hostPlayer ?? "BLACK"}`,
    status: playing ? "IN_PROGRESS" : full ? "LOBBY" : "WAITING",
    matchPhase: playing ? "PLAYING" : full ? "LOBBY" : "WAITING_FOR_PLAYERS",
    settings: room.settings, pendingSettings: room.pendingSettings ?? null, lastBotResult: room.lastBotResult ?? null,
    turnDeadline: room.turnDeadline ?? null, countdownEndsAt: null, serverTimestamp: room.revision,
    undo: room.undo ? { ...room.undo, requiredVotes: colors.filter(p => room.members[p] && !room.bots?.includes(p)).length,
      votes: (room.undo.votes ?? []).map(color => `${room.code}:${color}`) } : undefined,
    players: colors.map(p => ({
      playerId: `${room.code}:${p}`, color: p, connected: Boolean(room.members[p]) && room.status !== "closed",
      empty: !room.members[p], ready: room.ready[p], isHost: p === (room.hostPlayer ?? "BLACK"), isBot: room.bots?.includes(p) ?? false,
      username: room.playerProfiles?.[p]?.displayName,
    })),
    matchState: { settings: room.settings, actions: room.actions.map(action => ({
      type: { move: "player_move", skip: "player_skip", resign: "player_resign" }[action.type],
      ...(action.point ? { point: [...action.point] } : {}), color: action.player,
    })) },
  };
}

export class SharedRoomClient {
  constructor({ fetch: fetcher = globalThis.fetch?.bind(globalThis), WebSocket: Socket = globalThis.WebSocket,
    storage = globalThis.localStorage, onRoom = () => {}, onConnection = () => {}, onError = () => {},
    requestPasswordSession = null, onEmote = () => {}, onEmoteError = () => {} } = {}) {
    Object.assign(this, { fetcher, Socket, storage, onRoom, onConnection, onError, requestPasswordSession, onEmote, onEmoteError });
    this.room = null; this.engine = null; this.token = null; this.expires = 0;
    this.generation = 0; this.connected = false; this.pending = null; this.busy = false;
    this.queue = Promise.resolve(); this.socket = null; this.lastSeen = 0;
    this.emotesSupported = false; this.lastEmote = null; this.emoteError = null; this.lastEmoteSentAt = 0;
  }
  async open(origin, webToken) {
    if (origin !== this.origin || webToken !== this.webToken) {
      this.stop(); this.room = null; this.engine = null; this.token = null; this.expires = 0; this.pending = null;
      this.webAuthMode = null;
    }
    this.origin = origin; this.webToken = webToken;
    await this.authenticate();
    return this;
  }
  async json(path, data, token = this.token) {
    const response = await this.fetcher(`${this.origin}/api/wechat/${path}`, {
      method: data === undefined ? "GET" : "POST",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(12000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result.detail === "string" ? result.detail : `HTTP_${response.status}`);
    return result;
  }
  async authenticate(force = false) {
    if (!this.webToken) throw new Error("UNAUTHORIZED");
    if (!force && this.token && this.expires > Date.now()) return;
    if (!this.authenticating) {
      const generation = this.generation, webToken = this.webToken, origin = this.origin;
      const abort = new AbortController();
      this.authAbort = abort;
      this.token = null; this.expires = 0;
      const assertCurrent = () => {
        if (abort.signal.aborted || generation !== this.generation || webToken !== this.webToken || origin !== this.origin) throw new Error("CANCELLED");
      };
      const exchange = async () => {
        const status = await this.json("status", undefined, null);
        assertCurrent();
        if (!status?.enabled) throw new Error("ONLINE_NOT_CONFIGURED");
        if (!status.webLogin) throw new Error("WEB_AUTH_NOT_CONFIGURED");
        this.webAuthMode = status.webAuthMode || "legacy-jwt";
        if (this.webAuthMode === "legacy-jwt") return this.json("login/web", {}, webToken);
        if (this.webAuthMode !== "password" || !status.passwordLogin) throw new Error("WEB_AUTH_NOT_CONFIGURED");
        if (!this.requestPasswordSession) throw new Error("WEB_PASSWORD_REQUIRED");
        // The password exists only inside the form submission and POST body.
        // Neither the old Web JWT nor a stored password can renew this session.
        return this.requestPasswordSession({ signal: abort.signal, login: async ({ username, password }) => {
          assertCurrent();
          const result = await this.json("login/password-session", { username, password }, null);
          assertCurrent();
          return result;
        } });
      };
      const pending = exchange().then(result => {
        assertCurrent();
        if (!result.token || result.protocol !== 1 || !Number.isFinite(result.expiresIn)) throw new Error("LOGIN_FAILED");
        if (this.account?.uid && result.account?.uid !== this.account.uid) {
          // Binding changes room identity. Never replay commands belonging to
          // the previous identity merely because the Web login is unchanged.
          this.generation++; this.closeSocket(); this.clearPending(); this.room = null; this.engine = null; this.busy = false;
        }
        this.token = result.token; this.account = result.account; this.expires = Date.now() + (result.expiresIn - 60) * 1000;
      }).finally(() => {
        if (this.authenticating === pending) this.authenticating = null;
        if (this.authAbort === abort) this.authAbort = null;
      });
      this.authenticating = pending;
    }
    return this.authenticating;
  }
  async request(path, data) {
    const generation = this.generation, webToken = this.webToken, origin = this.origin;
    await this.authenticate();
    const current = () => generation === this.generation && webToken === this.webToken && origin === this.origin;
    if (!current()) throw new Error("ACCOUNT_SESSION_CHANGED");
    try { return await this.json(path, data, this.token); }
    catch (error) {
      if (!current()) throw new Error("CANCELLED");
      if (!/^(UNAUTHORIZED|HTTP_401|ACCOUNT_SESSION_CHANGED)$/.test(error.message)) throw error;
      await this.authenticate(true);
      if (!current()) throw new Error("ACCOUNT_SESSION_CHANGED");
      return this.json(path, data, this.token);
    }
  }
  receive(room, type = "ROOM_STATE") {
    const generation = this.generation;
    const run = async () => {
      if (generation !== this.generation) return false;
      if (this.room && (this.room.code !== room.code || room.revision < this.room.revision)) return false;
      if (this.room?.revision === room.revision && this.room.stateHash !== room.stateHash) throw new Error("STATE_MISMATCH");
      const engine = await verifySharedRoom(room);
      if (generation !== this.generation) return false;
      if (this.pending?.code === room.code && (this.pending.body.matchId !== room.matchId
        || room.actionIds.includes(this.pending.body.clientActionId))) this.clearPending();
      if (this.pending?.code === room.code && (this.pending.body.expectedSeq !== room.seq || this.pending.body.beforeHash !== room.stateHash)) {
        this.clearPending(); this.onError(new Error("STALE_POSITION"));
      }
      if (this.room?.matchId !== room.matchId) this.lastEmote = null;
      this.room = room; this.engine = engine;
      this.onRoom(sharedRoomPayload(room, type), room);
      return true;
    };
    const result = this.queue.catch(() => {}).then(run);
    this.queue = result;
    return result;
  }
  async enter(kind, value) {
    this.stop(); const generation = this.generation; this.room = null; this.pending = null;
    const room = kind === "create" ? await this.request("rooms", {
      ...(typeof value === "object" ? value : { gridSize: value || 7 }), rulesVersion: "territory-v3",
    })
      : kind === "resume" ? await this.request(`rooms/${value}`) : await this.request("rooms/join", { code: value });
    if (generation !== this.generation) throw new Error("CANCELLED");
    try {
      const raw = this.storage?.getItem(PENDING);
      if (raw && raw.length < 8192) {
        const pending = JSON.parse(raw);
        if (pending.origin === this.origin && pending.uid === this.account?.uid && pending.code === room.code
          && /^[a-zA-Z0-9_-]{16,80}$/.test(pending.body?.clientActionId)) this.pending = pending;
      }
    } catch (_) { /* Malformed/foreign pending commands are never replayed. */ }
    await this.receive(room, kind === "create" ? "ROOM_CREATED" : "ROOM_JOINED");
    if (generation !== this.generation) throw new Error("CANCELLED");
    await this.connect();
    return sharedRoomPayload(this.room);
  }
  async connect() {
    this.closeSocket();
    const generation = this.generation, code = this.room?.code;
    await this.authenticate();
    if (generation !== this.generation || code !== this.room?.code) throw new Error("CANCELLED");
    if (!code) throw new Error("ROOM_NOT_FOUND");
    const socket = new this.Socket(`${this.origin.replace(/^http/, "ws")}/api/wechat/ws`);
    this.socket = socket;
    const current = () => this.socket === socket && generation === this.generation;
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = error => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(); };
      const timer = setTimeout(() => { finish(new Error("NETWORK_ERROR")); if (current()) socket.close(); }, 12000);
      socket.addEventListener("open", () => { if (current()) socket.send(JSON.stringify({ protocol: 1, code, token: this.token, capabilities: [EMOTE_CAPABILITY] })); });
      socket.addEventListener("message", async event => {
        if (!current()) return;
        try {
          const data = JSON.parse(event.data); this.lastSeen = Date.now();
          if (data.type === "room") {
            if (Array.isArray(data.capabilities)) this.emotesSupported = data.capabilities.includes(EMOTE_CAPABILITY);
            await this.receive(data.room);
            if (!current()) return;
            this.connected = true; this.onConnection(true); finish();
            if (this.pending && !this.busy) void this.retryPending().catch(error => this.onError(error));
          } else if (data.type === "emote" && this.emotesSupported) this.receiveEmote(data.emote);
          else if (data.type === "emote_error" && this.emotesSupported) {
            if (["EMOTE_RATE_LIMIT", "INVALID_EMOTE", "EMOTES_UNAVAILABLE"].includes(data.code)) {
              this.emoteError = data.code; this.onEmoteError(new Error(data.code));
            }
          } else if (data.type !== "pong") throw new Error("INVALID_ROOM");
        } catch (error) {
          if (current()) { finish(error); this.onError(error); socket.close(); }
        }
      });
      socket.addEventListener("error", () => finish(new Error("NETWORK_ERROR")));
      socket.addEventListener("close", event => {
        finish(new Error("NETWORK_ERROR"));
        if (!current()) return;
        this.closeSocket();
        if (event.code === 4001) this.token = null;
        if ([4008, 4009, 4010].includes(event.code)) {
          this.generation++; this.clearPending(); this.room = null; this.engine = null;
          if (event.code === 4008) { this.token = null; this.account = null; }
        }
        this.onConnection(false, event);
      });
      this.lastSeen = Date.now();
      this.heartbeat = setInterval(() => {
        if (!current()) return;
        if (Date.now() - this.lastSeen > 40000) socket.close();
        else if (socket.readyState === 1) socket.send('{"type":"ping"}');
      }, 15000);
    });
  }
  canAct() {
    return Boolean(this.connected && !this.busy && !this.pending && !this.room?.undo?.pending && this.room?.status === "playing" && this.room.player === this.room.currentPlayer);
  }
  canEmote() {
    return Boolean(this.connected && this.emotesSupported && this.socket?.readyState === 1
      && this.room && this.room.status !== "closed");
  }
  receiveEmote(emote) {
    if (!this.emotesSupported || !emote || !/^[0-9a-f]{16}$/.test(emote.id)
      || !SHARED_EMOTES.includes(emote.emoji) || !COLORS.slice(0, this.room?.settings?.playerCount ?? 2).includes(emote.player)
      || emote.matchId !== this.room?.matchId || emote.id === this.lastEmote?.id) return false;
    this.lastEmote = { id: emote.id, emoji: emote.emoji, player: emote.player, matchId: emote.matchId };
    this.emoteError = null; this.onEmote(this.lastEmote); return true;
  }
  async sendEmote(emoji) {
    if (!SHARED_EMOTES.includes(emoji)) throw new Error("INVALID_EMOTE");
    if (!this.canEmote()) throw new Error("EMOTES_UNAVAILABLE");
    if (Date.now() - this.lastEmoteSentAt < 1000) throw new Error("EMOTE_RATE_LIMIT");
    this.lastEmoteSentAt = Date.now(); this.emoteError = null;
    try { this.socket.send(JSON.stringify({ type: "emote", emoji, matchId: this.room.matchId })); }
    catch (_) { this.emoteError = "NETWORK_ERROR"; throw new Error("NETWORK_ERROR"); }
    return true;
  }
  async act(action) {
    if (!this.canAct()) throw new Error("NOT_YOUR_TURN");
    const room = this.room, body = {
      matchId: room.matchId, expectedSeq: room.seq, beforeHash: room.stateHash,
      clientActionId: crypto.randomUUID(), action,
    };
    const pending = { origin: this.origin, uid: this.account?.uid, code: room.code, body };
    const raw = JSON.stringify(pending);
    if (!this.storage?.setItem) throw new Error("SAVE_WRITE_FAILED");
    this.storage.setItem(PENDING, raw);
    if (this.storage.getItem(PENDING) !== raw) throw new Error("SAVE_WRITE_FAILED");
    this.pending = pending;
    return this.retryPending();
  }
  async retryPending() {
    if (!this.pending || this.busy || !this.room) return;
    const pending = this.pending, generation = this.generation; this.busy = true;
    try {
      const room = await this.request(`rooms/${pending.code}/actions`, pending.body);
      if (generation === this.generation) await this.receive(room);
    } catch (error) {
      if (generation === this.generation && /STALE_|NOT_YOUR_TURN|MATCH_NOT|COMMAND_ID|INVALID_ACTION|ROOM_CLOSED|ROOM_EXPIRED/.test(error.message)) this.clearPending();
      if (generation === this.generation) {
        // Never leave an optimistic state behind. A reconnect resolves lost ACKs.
        this.closeSocket(); this.onConnection(false, { code: 1006, reason: error.message });
      }
      throw error;
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        if (this.connected) this.onConnection(true);
      }
    }
  }
  async updateSettings(settings) {
    return this.command("settings", { settings });
  }
  async undo(accept = true) {
    const room = this.room;
    if (!room) throw new Error("ROOM_NOT_FOUND");
    return this.command("undo", { expectedSeq: room.seq, beforeHash: room.stateHash, accept });
  }
  async command(operation, body = {}) {
    if (!this.room || this.busy) throw new Error("ROOM_BUSY");
    const generation = this.generation, room = this.room; this.busy = true;
    try {
      const result = await this.request(`rooms/${room.code}/${operation}`, { ...body, matchId: room.matchId });
      if (generation === this.generation) await this.receive(result);
      return result;
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        if (this.connected) this.onConnection(true);
      }
    }
  }
  clearPending() { this.pending = null; try { this.storage?.removeItem(PENDING); } catch (_) {} }
  closeSocket() {
    clearInterval(this.heartbeat); this.heartbeat = null;
    const socket = this.socket; this.socket = null; this.connected = false;
    this.emotesSupported = false; this.lastEmote = null;
    try { socket?.close(); } catch (_) {}
  }
  cancelAuthentication() {
    const abort = this.authAbort;
    this.authAbort = null; this.authenticating = null;
    abort?.abort();
  }
  stop() { this.generation++; this.cancelAuthentication(); this.busy = false; this.closeSocket(); }
}
