import NetworkManager, { ClientEvent, ServerEvent } from "./NetworkManager.js?v=20261024-online-settings2";
import { SharedRoomClient, sharedApiOrigin } from "./SharedRoomClient.js";

// Preserve existing four-digit Web rooms; eight-character rooms share the
// authoritative Mini Game service. Callers still use the Web UI/controller API.
export default class CrossPlatformNetwork extends NetworkManager {
  constructor(options = {}) {
    super(options);
    this.sharedActive = false;
    this.shared = new SharedRoomClient({ ...options,
      onRoom: (payload, room) => {
        if (!this.sharedActive) return;
        const prior = this.sharedSnapshot;
        const undoApplied = prior?.code === room.code && prior.matchId === room.matchId && room.seq < prior.seq;
        this.sharedSnapshot = { code: room.code, matchId: room.matchId, seq: room.seq };
        this.roomId = room.code; this.playerId = payload.playerId; this.color = room.player;
        this._emit(undoApplied ? ServerEvent.ROOM_UNDO : payload.type,
          undoApplied ? { ...payload, type: ServerEvent.ROOM_UNDO } : payload);
        if (room.status === "closed") this._emit(ServerEvent.PLAYER_LEFT, payload);
        if (room.status === "finished" && Object.values(room.rematchVotes).some(Boolean)) {
          this._emit(ServerEvent.RESET_STATUS, { confirmedVotes: Object.values(room.rematchVotes).filter(Boolean).length, requiredVotes: 2 });
        }
      },
      onConnection: (connected, event) => {
        if (this.sharedActive) this._emit(connected ? ClientEvent.OPEN : ClientEvent.CLOSE,
          { type: connected ? ClientEvent.OPEN : ClientEvent.CLOSE, url: this.url, ...event });
      },
      onError: error => this._emit(ServerEvent.ERROR, { code: error.message, message: error.message }),
      onEmote: emote => {
        if (this.sharedActive) this._emit(ServerEvent.CHAT_EMOJI, {
          type: ServerEvent.CHAT_EMOJI, sender: `${this.roomId}:${emote.player}`, color: emote.player,
          content: emote.emoji, metadata: { seed: emote.id, animation: "bounce", duration: 1200 },
        });
      },
      onEmoteError: error => this._emit(ServerEvent.ERROR, { code: error.message, message: error.message }),
    });
  }
  get serverAuthoritative() { return this.sharedActive; }
  canAct() { return !this.sharedActive || this.shared.canAct(); }
  canEmote() { return this.sharedActive ? this.shared.canEmote() : this.isConnected(); }
  _handleMessage(event) { if (!this.sharedActive) super._handleMessage(event); }
  hydrateSession(value) { super.hydrateSession(value); this.sharedActive = /^[A-Z2-9]{8}$/.test(value?.roomId || ""); }
  getSession() { return { ...super.getSession(), shared: this.sharedActive }; }
  isConnected() { return this.sharedActive ? this.shared.connected : super.isConnected(); }
  setAuthToken(token) {
    if (this.authToken && this.authToken !== token && this.shared) {
      this.shared.stop(); this.shared.token = null; this.shared.webToken = null; this.shared.room = null;
    }
    super.setAuthToken(token);
  }
  clearAuthToken() { this.setAuthToken(null); }
  async connect(url, token = this.authToken) {
    if (!this.sharedActive) return super.connect(url, token);
    this.url = url; this.authToken = token;
    await this.shared.open(sharedApiOrigin(url), token);
    return this;
  }
  disconnect(...args) {
    this.shared?.stop();
    if (!this.sharedActive) return super.disconnect(...args);
  }
  async activateShared() {
    if (this.roomId && !this.sharedActive) throw new Error("LEAVE_ROOM_FIRST");
    await this.shared.open(sharedApiOrigin(this.url), this.authToken);
    if (!this.sharedActive) {
      this._closeCurrentConnection(1000, "switch_to_shared",
        new Error("WebSocket connection was replaced."), false);
      this.sharedActive = true;
    }
  }
  selectLegacy() {
    if (!this.sharedActive) return;
    if (this.roomId) throw new Error("LEAVE_ROOM_FIRST");
    this.shared.stop(); this.sharedActive = false;
  }
  async createSharedRoom(settings = {}) {
    await this.activateShared();
    return this.shared.enter("create", this.sharedSettings(settings));
  }
  sharedSettings(settings = {}) {
    const mode = settings.playerCount && settings.playerCount !== 2 ? "default"
      : settings.startingPointMode || (settings.initialPositions ? "custom" : "default");
    return { gridSize: settings.gridSize || 7, boardShape: settings.boardShape || "triangle",
      rulesVersion: settings.rulesVersion || "territory-v3", startingPointMode: mode,
      ...(mode === "default" ? {} : { initialPositions: settings.initialPositions }),
      undoEnabled: settings.undoEnabled === true, undoMaxCount: settings.undoMaxCount || 3 };
  }
  async createRoom(settings) {
    if (this.sharedActive) {
      if (this.roomId) throw new Error("LEAVE_ROOM_FIRST");
      this.shared.stop(); this.sharedActive = false;
      await super.connect(this.url, this.authToken);
    }
    return super.createRoom(settings);
  }
  async joinRoom(code, playerId) {
    const normalized = String(code).trim().toUpperCase();
    if (/^[A-Z2-9]{8}$/.test(normalized)) {
      if (this.roomId && this.sharedActive && this.roomId !== normalized) throw new Error("LEAVE_ROOM_FIRST");
      await this.activateShared();
      return this.shared.enter(playerId ? "resume" : "join", normalized);
    }
    if (this.sharedActive) {
      if (this.roomId) throw new Error("LEAVE_ROOM_FIRST");
      this.shared.stop(); this.sharedActive = false; await super.connect(this.url, this.authToken);
    }
    return super.joinRoom(code, playerId);
  }
  async sendMove(point) { return this.sharedActive ? this.shared.act({ type: "move", point }) : super.sendMove(point); }
  async sendSkip() { return this.sharedActive ? this.shared.act({ type: "skip" }) : super.sendSkip(); }
  async sendResign() { return this.sharedActive ? this.shared.act({ type: "resign" }) : super.sendResign(); }
  async sendReady(ready) {
    if (!this.sharedActive) return super.sendReady(ready);
    if (ready) return this.shared.command("ready");
  }
  async sendReset(reason) {
    if (!this.sharedActive) return super.sendReset(reason);
    if (this.shared.room?.status !== "finished") throw new Error("MATCH_NOT_FINISHED");
    return this.shared.command("rematch");
  }
  async updateRoomSettings(settings) {
    if (!this.sharedActive) return super.updateRoomSettings(settings);
    const room = this.shared.room;
    if (!room) throw new Error("ROOM_NOT_FOUND");
    const updated = await this.shared.request(`rooms/${room.code}/settings`,
      { matchId: room.matchId, settings: this.sharedSettings(settings) });
    await this.shared.receive(updated);
    return updated;
  }
  async sendUndo(accept = true) {
    if (!this.sharedActive) return super.sendUndo(accept);
    const room = this.shared.room;
    if (!room) throw new Error("ROOM_NOT_FOUND");
    const updated = await this.shared.request(`rooms/${room.code}/undo`,
      { matchId: room.matchId, expectedSeq: room.seq, beforeHash: room.stateHash, accept: Boolean(accept) });
    await this.shared.receive(updated);
    return updated;
  }
  async updateStartPlayer(player) { if (!this.sharedActive) return super.updateStartPlayer(player); }
  async sendChatEmoji(...args) {
    if (this.sharedActive) return this.shared.sendEmote(args[0]);
    return super.sendChatEmoji(...args);
  }
  async leaveRoom({ bestEffort = false } = {}) {
    if (!this.sharedActive) return super.leaveRoom();
    if (this.shared.room && this.shared.room.status !== "closed") {
      if (bestEffort) {
        if (this.shared.token) await this.shared.json(`rooms/${this.shared.room.code}/leave`, { matchId: this.shared.room.matchId });
      } else await this.shared.command("leave");
    }
    this.shared.stop(); this.shared.clearPending(); this.shared.room = null;
    this.roomId = this.playerId = this.color = null;
  }
  async issueLinkCode() {
    await this.shared.open(sharedApiOrigin(this.url), this.authToken);
    const generation = this.shared.generation, origin = this.shared.origin, token = this.authToken;
    const result = this.shared.webAuthMode === "password"
      ? await this.shared.request("account/link-code", {})
      : await this.shared.json("account/link-code", {}, token);
    if (generation !== this.shared.generation || token !== this.authToken || origin !== this.shared.origin
      || origin !== sharedApiOrigin(this.url)) throw new Error("CANCELLED");
    return result;
  }
}
