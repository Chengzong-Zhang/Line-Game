const DEFAULT_REQUEST_TIMEOUT = 10000;
const DEFAULT_CONNECT_TIMEOUT = 10000;
const DEFAULT_HEARTBEAT_INTERVAL = 4000;
const DEFAULT_HEARTBEAT_TIMEOUT = 12000;
export const TOPOLOGY_ROOM_CAPABILITY = "board-topology-v1";
const DEFAULT_PROTOCOL_TIMEOUT = 3000;

// NetworkManager 璐熻矗鎶娾€滆姹?鍝嶅簲鈥濆拰鈥滃箍鎾簨浠垛€濇贩鍚堝湪鍚屼竴鏉?WebSocket 涓婄鐞嗚捣鏉ャ€?// 涓婂眰鍙渶瑕佽闃呬簨浠舵垨璋冪敤 sendXxx锛屾棤闇€鐩存帴鎿嶄綔 socket銆?
const ServerEvent = Object.freeze({
  ROOM_CREATED: "ROOM_CREATED",
  ROOM_JOINED: "ROOM_JOINED",
  ROOM_STATE: "ROOM_STATE",
  ROOM_COUNTDOWN: "ROOM_COUNTDOWN",
  ROOM_READY: "ROOM_READY",
  OPPONENT_MOVE: "OPPONENT_MOVE",
  TURN_SKIPPED: "TURN_SKIPPED",
  ROOT_ACTION_APPLIED: "ROOT_ACTION_APPLIED",
  PLAYER_RESIGNED: "PLAYER_RESIGNED",
  RESET_STATUS: "RESET_STATUS",
  MATCH_RESET: "MATCH_RESET",
  UNDO_STATUS: "UNDO_STATUS",
  ROOM_UNDO: "ROOM_UNDO",
  PLAYER_LEFT: "PLAYER_LEFT",
  CHAT_EMOJI: "chat_emoji",
  PONG: "PONG",
  ERROR: "ERROR",
});

const ClientEvent = Object.freeze({
  OPEN: "OPEN",
  CLOSE: "CLOSE",
  CONNECTION_ERROR: "CONNECTION_ERROR",
});

function clonePoint(point) {
  return [point[0], point[1]];
}

function sanitizeSessionUrl(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = new URL(value, globalThis.location?.href ?? "http://localhost:8000/");
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return parsed.toString();
  } catch (_error) {
    return null;
  }
}

function isValidPoint(point) {
  return Array.isArray(point)
    && point.length === 2
    && Number.isInteger(point[0])
    && Number.isInteger(point[1]);
}

function isTopologyMove(move) {
  return Boolean(
    move
    && typeof move === "object"
    && !Array.isArray(move)
    && typeof move.vertexId === "string"
    && move.vertexId.length > 0
    && typeof move.boardHash === "string"
    && move.boardHash.length > 0,
  );
}

function resolveWebSocketUrl(locationLike = globalThis.location) {
  if (!locationLike || typeof locationLike !== "object") {
    return "ws://localhost:8000/ws";
  }

  const protocol = locationLike.protocol === "https:" ? "wss:" : "ws:";
  const host = locationLike.host;

  if (!host) {
    return "ws://localhost:8000/ws";
  }

  // A local server may use any free port; use the page's own backend first.
  // The application retains explicit 8000–8004 fallbacks for static previews.
  return `${protocol}//${host}/ws`;
}

function appendTokenToWebSocketUrl(url, token) {
  if (!token) {
    return url;
  }

  try {
    const parsed = new URL(url, globalThis.location?.href ?? "http://localhost:8000/");
    parsed.searchParams.set("token", token);
    return parsed.toString();
  } catch (_e) {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}token=${encodeURIComponent(token)}`;
  }
}

export class NetworkManager {
  constructor(options = {}) {
    this.options = options;
    this.socket = null;
    this.url = null;
    this.authToken = null;
    this.roomId = null;
    this.playerId = null;
    this.color = null;
    const requestedCapabilities = Array.isArray(options.topologyCapabilities)
      ? options.topologyCapabilities
      : [TOPOLOGY_ROOM_CAPABILITY];
    this.topologyCapabilities = [...new Set(requestedCapabilities.filter(
      (capability) => capability === TOPOLOGY_ROOM_CAPABILITY,
    ))];
    this._actionSequence = 0;

    this._listeners = new Map();
    this._pendingRequests = [];
    this._connectPromise = null;
    this._connectReject = null;
    this._connectTimeoutId = null;
    this._heartbeatTimerId = null;
    this._heartbeatWatchdogId = null;
    this._lastPongAt = 0;
    this._connectionGeneration = 0;
    this._actionProtocol = "unknown";
    this._actionProtocolInfo = { status: "unknown", version: null, serverInstanceId: null };
    this._protocolNegotiation = null;
    this._syncRequests = new Map();
    this._nextSyncRequestId = 0;

    if (options.handlers && typeof options.handlers === "object") {
      for (const [eventName, handler] of Object.entries(options.handlers)) {
        if (typeof handler === "function") {
          this.on(eventName, handler);
        }
      }
    }
  }

  setAuthToken(token) {
    this.authToken = token || null;
  }

  clearAuthToken() {
    this.authToken = null;
  }

  async connect(url, authToken = this.authToken) {
    if (!url || typeof url !== "string") {
      throw new Error("connect(url) requires a valid WebSocket URL.");
    }

    if (!authToken || typeof authToken !== "string") {
      throw new Error("Authentication token is required. Please log in first.");
    }

    this.authToken = authToken;

    if (this.socket && this.socket.readyState === WebSocket.OPEN && this.url === url) {
      return this;
    }

    if (this._connectPromise) {
      return this._connectPromise;
    }

    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
      this.disconnect();
    }

    this.url = url;
    this._settleProtocolNegotiation({ status: "unknown", reason: "connection_replaced" }, this._connectionGeneration);
    const generation = ++this._connectionGeneration;
    this._actionProtocol = "unknown";
    this._actionProtocolInfo = { status: "unknown", version: null, serverInstanceId: null };
    this._protocolNegotiation = null;
    this._rejectSyncRequests(new Error("WebSocket connection replaced."));
    const socketUrl = appendTokenToWebSocketUrl(url, this.authToken);
    // Let constructor failures reject this call without leaving a cached rejected promise.
    let socket;
    try {
      socket = new WebSocket(socketUrl);
    } catch (_error) {
      throw new Error("Failed to connect to WebSocket endpoint.");
    }
    this._connectPromise = new Promise((resolve, reject) => {
      // 同一时刻只允许存在一个激活连接，避免旧 socket 残留事件污染当前房间状态。
      this.socket = socket;
      this._connectReject = reject;
      this._connectTimeoutId = globalThis.setTimeout(() => {
        if (this.socket !== socket) return;
        this._connectTimeoutId = null;
        this._connectPromise = null;
        this._connectReject = null;
        this.socket = null;
        socket.close(1000, "connect_timeout");
        reject(new Error(`WebSocket connection timed out after ${this.options.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT}ms`));
      }, this.options.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT);

      socket.addEventListener("open", () => {
        if (this.socket !== socket) {
          socket.close(1000, "stale_connection");
          return;
        }
        this._connectPromise = null;
        this._connectReject = null;
        if (this._connectTimeoutId !== null) globalThis.clearTimeout(this._connectTimeoutId);
        this._connectTimeoutId = null;
        this._lastPongAt = Date.now();
        this._startHeartbeat();
        this._emit(ClientEvent.OPEN, {
          type: ClientEvent.OPEN,
        });
        resolve(this);
      }, { once: true });

      socket.addEventListener("message", (event) => {
        if (this.socket !== socket) return;
        this._handleMessage(event);
      });

      socket.addEventListener("error", (event) => {
        if (this.socket !== socket) return;
        this._emit(ClientEvent.CONNECTION_ERROR, {
          type: ClientEvent.CONNECTION_ERROR,
        });
      });

      socket.addEventListener("close", (event) => {
        const wasCurrentSocket = this.socket === socket;

        if (wasCurrentSocket) {
          const rejectConnect = this._connectReject;
          this._connectPromise = null;
          this._connectReject = null;
          if (this._connectTimeoutId !== null) globalThis.clearTimeout(this._connectTimeoutId);
          this._connectTimeoutId = null;
          this._stopHeartbeat();
          this.socket = null;
          rejectConnect?.(new Error(`WebSocket closed: ${event.code}`));
          this._rejectPendingRequests(new Error(`WebSocket closed: ${event.code}`));
          this._rejectSyncRequests(new Error(`WebSocket closed: ${event.code}`));
          this._settleProtocolNegotiation({ status: "unknown", reason: "disconnected" }, generation);
          this._actionProtocol = "unknown";
          this._actionProtocolInfo = { status: "unknown", version: null, serverInstanceId: null };
          this._emit(ClientEvent.CLOSE, {
            type: ClientEvent.CLOSE,
            code: event.code,
            wasClean: event.wasClean,
          });
        }
      }, { once: true });

      socket.addEventListener("error", () => {
        if (this.socket !== socket || socket.readyState !== WebSocket.CONNECTING) return;
        this._connectPromise = null;
        this._connectReject = null;
        if (this._connectTimeoutId !== null) globalThis.clearTimeout(this._connectTimeoutId);
        this._connectTimeoutId = null;
        this.socket = null;
        socket.close(1000, "connect_error");
        reject(new Error("Failed to connect to WebSocket endpoint."));
      }, { once: true });
    });

    return this._connectPromise;
  }

  disconnect(code = 1000, reason = "client_disconnect") {
    this._stopHeartbeat();
    if (!this.socket) {
      return;
    }

    const socket = this.socket;
    this._settleProtocolNegotiation({ status: "unknown", reason: "disconnected" }, this._connectionGeneration);
    this._connectionGeneration += 1;
    this._actionProtocol = "unknown";
    this._actionProtocolInfo = { status: "unknown", version: null, serverInstanceId: null };
    this._rejectSyncRequests(new Error("WebSocket connection canceled."));
    const rejectConnect = this._connectReject;
    this.socket = null;
    this._connectPromise = null;
    this._connectReject = null;
    if (this._connectTimeoutId !== null) globalThis.clearTimeout(this._connectTimeoutId);
    this._connectTimeoutId = null;
    const disconnectError = new Error("WebSocket connection canceled.");
    rejectConnect?.(disconnectError);
    this._rejectPendingRequests(disconnectError);
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(code, reason);
    }
    if (reason === "heartbeat_timeout") {
      this._emit(ClientEvent.CLOSE, {
        type: ClientEvent.CLOSE,
        code,
        wasClean: false,
      });
    }
  }

  async createRoom(settings = null) {
    await this._ensureOpen();
    const payloadToSend = {
      type: "create_room",
      topologyCapabilities: [...this.topologyCapabilities],
    };
    if (settings && typeof settings === "object") {
      payloadToSend.settings = settings;
    }
    const payload = await this._sendRequest(
      payloadToSend,
      [ServerEvent.ROOM_CREATED],
    );

    this.roomId = payload.roomId ?? null;
    this.playerId = payload.playerId ?? null;
    this.color = payload.color ?? null;
    return payload;
  }

  async joinRoom(roomId, playerId = null) {
    const normalizedRoomId = String(roomId ?? "").trim();
    if (!normalizedRoomId) {
      throw new Error("joinRoom(roomId) requires a valid room ID.");
    }

    await this._ensureOpen();
    const payload = await this._sendRequest(
      {
        type: "join_room",
        roomId: normalizedRoomId,
        topologyCapabilities: [...this.topologyCapabilities],
        ...(playerId ? { playerId } : {}),
        rootProtocolVersion: 2,
      },
      [ServerEvent.ROOM_JOINED],
    );

    this.roomId = payload.roomId ?? normalizedRoomId;
    this.playerId = payload.playerId ?? playerId ?? null;
    this.color = payload.color ?? null;
    return payload;
  }

  async sendMove(point) {
    await this._ensureOpen();
    if (isTopologyMove(point)) {
      const move = {
        vertexId: point.vertexId,
        boardHash: point.boardHash,
      };
      this._send({ type: "player_move", ...move });
      return {
        roomId: this.roomId,
        playerId: this.playerId,
        ...move,
      };
    }
    if (!isValidPoint(point)) {
      throw new Error("sendMove(point) requires [x, y] integer coordinates or { vertexId, boardHash }.");
    }
    const legacyPoint = clonePoint(point);
    this._send({
      type: "player_move",
      point: legacyPoint,
      actionId: this._nextActionId(),
    });
    return {
      roomId: this.roomId,
      playerId: this.playerId,
      point: legacyPoint,
    };
  }

  async negotiateActionProtocol() {
    const { socket, generation } = this._captureConnection();
    if (this._actionProtocol !== "unknown") return { ...this._actionProtocolInfo };
    if (this._actionProtocolInfo.reason === "timeout" || this._actionProtocolInfo.reason === "protocol_error"
      || this._actionProtocolInfo.reason === "invalid_response" || this._actionProtocolInfo.reason === "send_failed") {
      return { ...this._actionProtocolInfo };
    }
    if (this._protocolNegotiation?.generation === generation) return this._protocolNegotiation.promise;
    let pending;
    const promise = new Promise((resolve) => {
      const timeoutId = globalThis.setTimeout(() => {
        this._settleProtocolNegotiation({ status: "unknown", reason: "timeout" }, generation);
      }, this.options.protocolTimeout ?? DEFAULT_PROTOCOL_TIMEOUT);
      pending = { generation, resolve, timeoutId, promise: null };
    });
    pending.promise = promise;
    this._protocolNegotiation = pending;
    try {
      this._sendOn(socket, { type: "action_protocol_hello", supportedVersions: [1] });
    } catch (error) {
      this._settleProtocolNegotiation({ status: "unknown", reason: "send_failed", error }, generation);
    }
    return promise;
  }

  async sendVersionedAction(action = {}) {
    const { socket, generation } = this._captureConnection();
    if (this._actionProtocol !== "selected") throw new Error("Action protocol v1 has not been negotiated.");
    const { roomInstanceId, matchEpoch, clientActionId, baseActionSeq, type } = action;
    if (typeof roomInstanceId !== "string" || !roomInstanceId || typeof matchEpoch !== "string" || !matchEpoch
      || typeof clientActionId !== "string" || !clientActionId || !Number.isInteger(baseActionSeq) || baseActionSeq < 0
      || !["player_move", "player_skip", "player_resign"].includes(type)) {
      throw new Error("sendVersionedAction requires roomInstanceId, matchEpoch, clientActionId, baseActionSeq, and a supported action type.");
    }
    if (type === "player_move" && !isValidPoint(action.point)) throw new Error("player_move requires [x, y] integer coordinates.");
    if (!this._isCurrentConnection(socket, generation)) throw new Error("Connection changed before action could be sent.");
    const payload = { type, roomInstanceId, matchEpoch, clientActionId, baseActionSeq, ...(type === "player_move" ? { point: clonePoint(action.point) } : {}) };
    this._sendOn(socket, payload);
    return { sent: true, payload };
  }

  async requestActionSync(options = {}) {
    const { socket, generation } = this._captureConnection();
    if (this._actionProtocol !== "selected") throw new Error("Action protocol v1 has not been negotiated.");
    if (typeof options.roomInstanceId !== "string" || !options.roomInstanceId
      || typeof options.matchEpoch !== "string" || !options.matchEpoch
      || !Array.isArray(options.pendingActionIds)
      || options.pendingActionIds.some(id => typeof id !== "string" || !id)) {
      throw new Error("requestActionSync requires roomInstanceId, matchEpoch, and string pendingActionIds.");
    }
    const syncRequestId = String(++this._nextSyncRequestId);
    const request = new Promise((resolve, reject) => {
      const timeoutId = globalThis.setTimeout(() => {
        this._syncRequests.delete(syncRequestId);
        reject(new Error("Timed out waiting for action sync state."));
      }, options.timeout ?? this.options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT);
      this._syncRequests.set(syncRequestId, { socket, generation, resolve, reject, timeoutId, scope: { ...options }, roomId: this.roomId });
    });
    try {
      this._sendOn(socket, {
        type: "sync_state",
        roomInstanceId: options.roomInstanceId,
        matchEpoch: options.matchEpoch,
        pendingActionIds: [...options.pendingActionIds],
        syncRequestId,
      });
    } catch (error) {
      const record = this._syncRequests.get(syncRequestId);
      if (record) {
        globalThis.clearTimeout(record.timeoutId);
        this._syncRequests.delete(syncRequestId);
        record.reject(error);
      }
    }
    return request;
  }

  async sendSkip() {
    await this._ensureOpen();
    return this._sendRequest(
      { type: "player_skip", actionId: this._nextActionId() },
      [ServerEvent.TURN_SKIPPED],
    );
  }

  async sendRootAction(type, point) {
    const normalizedType = String(type ?? "").replace(/^root_/, "");
    if (!["relocate", "add"].includes(normalizedType) || !isValidPoint(point)) {
      throw new Error("sendRootAction(type, point) requires relocate/add and [x, y] integers.");
    }
    await this._ensureOpen();
    return this._sendRequest(
      { type: `player_root_${normalizedType}`, point: clonePoint(point), actionId: this._nextActionId() },
      [ServerEvent.ROOT_ACTION_APPLIED],
    );
  }

  async sendResign() {
    await this._ensureOpen();
    return this._sendRequest(
      { type: "player_resign" },
      [ServerEvent.PLAYER_RESIGNED],
    );
  }

  async sendReset(reason = "resign_restart") {
    const normalizedReason = reason === "normal_restart" ? "normal_restart" : "resign_restart";
    await this._ensureOpen();
    return this._sendRequest(
      {
        type: "player_reset",
        reason: normalizedReason,
      },
      [ServerEvent.RESET_STATUS, ServerEvent.MATCH_RESET],
    );
  }

  async sendUndo(accept = true) {
    await this._ensureOpen();
    return this._sendRequest(
      { type: "player_undo", accept: Boolean(accept) },
      [ServerEvent.UNDO_STATUS, ServerEvent.ROOM_UNDO],
    );
  }

  async sendReady(ready) {
    await this._ensureOpen();
    this._send({
      type: "player_ready",
      ready: Boolean(ready),
    });
  }

  async updateRoomSettings(settings) {
    await this._ensureOpen();
    this._send({
      type: "update_room_settings",
      settings,
      topologyCapabilities: [...this.topologyCapabilities],
    });
  }

  async updateStartPlayer(startPlayer) {
    await this._ensureOpen();
    this._send({
      type: "update_start_player",
      startPlayer,
    });
  }

  async retryBots() {
    await this._ensureOpen();
    this._send({ type: "retry_bots" });
  }

  async sendChatEmoji(content, metadata = {}) {
    const normalizedContent = String(content ?? "").trim();
    if (!normalizedContent) {
      throw new Error("sendChatEmoji(content) requires a non-empty emoji or emote ID.");
    }

    await this._ensureOpen();
    const animation = ["bounce", "fade", "shake"].includes(metadata?.animation)
      ? metadata.animation
      : "bounce";
    const rawDuration = Number(metadata?.duration ?? 1200);
    const duration = Number.isFinite(rawDuration)
      ? Math.max(300, Math.min(3000, Math.round(rawDuration)))
      : 1200;
    const seed = String(metadata?.seed ?? "").trim();
    const display = metadata?.display && typeof metadata.display === "object"
      ? metadata.display
      : null;
    this._send({
      type: ServerEvent.CHAT_EMOJI,
      sender: this.playerId ?? "",
      content: normalizedContent,
      metadata: {
        animation,
        duration,
        ...(seed ? { seed } : {}),
        ...(display ? { display } : {}),
      },
    });
  }

  async leaveRoom() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this._clearSession();
      return;
    }

    this._send({ type: "player_leave" });
    this._clearSession();
  }

  on(eventName, listener) {
    if (typeof listener !== "function") {
      throw new Error("Event listener must be a function.");
    }

    const listeners = this._listeners.get(eventName) ?? new Set();
    listeners.add(listener);
    this._listeners.set(eventName, listeners);
    return () => this.off(eventName, listener);
  }

  off(eventName, listener) {
    const listeners = this._listeners.get(eventName);
    if (!listeners) {
      return;
    }

    listeners.delete(listener);
    if (listeners.size === 0) {
      this._listeners.delete(eventName);
    }
  }

  once(eventName, listener) {
    const unsubscribe = this.on(eventName, (payload, manager) => {
      unsubscribe();
      listener(payload, manager);
    });
    return unsubscribe;
  }

  isConnected() {
    return Boolean(this.socket && this.socket.readyState === WebSocket.OPEN);
  }

  getSession() {
    return {
      url: sanitizeSessionUrl(this.url),
      roomId: this.roomId,
      playerId: this.playerId,
      color: this.color,
      connected: this.isConnected(),
    };
  }

  hydrateSession(sessionLike = {}) {
    this.url = sanitizeSessionUrl(sessionLike.url) ?? this.url;
    this.roomId = sessionLike.roomId ?? this.roomId;
    this.playerId = sessionLike.playerId ?? this.playerId;
    this.color = sessionLike.color ?? this.color;
  }

  _handleMessage(event) {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch (error) {
      this._emit(ServerEvent.ERROR, {
        type: ServerEvent.ERROR,
        code: "INVALID_JSON",
        message: "Received invalid JSON from server.",
      });
      return;
    }

    if (!payload || typeof payload !== "object") {
      this._emit(ServerEvent.ERROR, {
        type: ServerEvent.ERROR,
        code: "INVALID_PAYLOAD",
        message: "Received an unsupported payload from server.",
      });
      return;
    }

    const isLegacyProtocolUnsupported = payload.type === ServerEvent.ERROR
      && payload.code === "UNKNOWN_MESSAGE_TYPE"
      && payload.message === "Unsupported message type: 'action_protocol_hello'";
    if (payload.type === ServerEvent.ERROR) {
      // Server-controlled text may echo a room id, endpoint, or credential.
      // Keep stable codes for localization, but never expose the raw message.
      payload = { ...payload, message: "The server could not complete the request." };
    }

    if (payload.type === "ACTION_PROTOCOL_SELECTED") {
      const pending = this._protocolNegotiation;
      if (!pending) return;
      if (payload.version === 1 && typeof payload.serverInstanceId === "string" && payload.serverInstanceId.length > 0) {
        this._settleProtocolNegotiation({ status: "selected", version: 1, serverInstanceId: payload.serverInstanceId }, pending.generation);
        this._emit(payload.type, payload);
      } else {
        this._settleProtocolNegotiation({ status: "unknown", reason: "invalid_response" }, pending.generation);
      }
      return;
    }
    if (payload.type === "SYNC_STATE") {
      const record = this._syncRequests.get(String(payload.syncRequestId ?? ""));
      if (record && this._isCurrentConnection(record.socket, record.generation)) {
        if (record.roomId !== this.roomId) {
          globalThis.clearTimeout(record.timeoutId);
          this._syncRequests.delete(String(payload.syncRequestId));
          record.reject(new Error("Room changed while action sync was pending."));
          return;
        }
        if (record.scope.roomInstanceId && payload.roomInstanceId !== record.scope.roomInstanceId) {
          globalThis.clearTimeout(record.timeoutId); this._syncRequests.delete(String(payload.syncRequestId));
          record.reject(new Error("Action sync response belongs to a different room instance."));
          return;
        }
        globalThis.clearTimeout(record.timeoutId); this._syncRequests.delete(String(payload.syncRequestId)); record.resolve(payload);
        this._emit(payload.type, payload);
      }
      return;
    }
    if (payload.type === "sync_state") {
      return;
    }
    if (payload.type === ServerEvent.ERROR && payload.syncRequestId != null) {
      const key = String(payload.syncRequestId);
      const record = this._syncRequests.get(key);
      if (record && this._isCurrentConnection(record.socket, record.generation)) {
        globalThis.clearTimeout(record.timeoutId);
        this._syncRequests.delete(key);
        const error = new Error("Action sync failed.");
        if (payload.code) error.code = payload.code;
        record.reject(error);
      }
      return;
    }
    if (isLegacyProtocolUnsupported && this._protocolNegotiation) {
      this._settleProtocolNegotiation({ status: "legacy" }, this._protocolNegotiation.generation);
      return;
    }

    if (payload.type === ServerEvent.ROOM_CREATED) {
      this._rejectSyncRequests(new Error("Room changed while action sync was pending."));
      this.roomId = payload.roomId ?? this.roomId;
      this.playerId = payload.playerId ?? this.playerId;
      this.color = payload.color ?? this.color;
    } else if (payload.type === ServerEvent.ROOM_JOINED) {
      this._rejectSyncRequests(new Error("Room changed while action sync was pending."));
      this.roomId = payload.roomId ?? this.roomId;
      this.playerId = payload.playerId ?? this.playerId;
      this.color = payload.color ?? this.color;
    } else if (payload.type === ServerEvent.ROOM_STATE || payload.type === ServerEvent.ROOM_COUNTDOWN) {
      this.roomId = payload.roomId ?? this.roomId;
      this.playerId = payload.yourPlayerId ?? payload.playerId ?? this.playerId;
      this.color = payload.yourColor ?? payload.color ?? this.color;
    } else if (payload.type === ServerEvent.ROOM_READY) {
      this.roomId = payload.roomId ?? this.roomId;
      this.playerId = payload.yourPlayerId ?? this.playerId;
      this.color = payload.yourColor ?? this.color;
    } else if (payload.type === ServerEvent.MATCH_RESET) {
      this.roomId = payload.roomId ?? this.roomId;
      this.playerId = payload.yourPlayerId ?? payload.playerId ?? this.playerId;
      this.color = payload.yourColor ?? payload.color ?? this.color;
    } else if (payload.type === ServerEvent.PONG) {
      this._lastPongAt = Date.now();
    } else if (payload.type === ServerEvent.PLAYER_LEFT) {
      if (payload.playerId && payload.playerId !== this.playerId) {
        // Preserve local session; only the opponent left.
      }
    }

    this._resolvePendingRequest(payload);
    this._emit(payload.type ?? ServerEvent.ERROR, payload);
  }

  _emit(eventName, payload) {
    const listeners = this._listeners.get(eventName);
    if (!listeners || listeners.size === 0) {
      return;
    }

    for (const listener of listeners) {
      listener(payload, this);
    }
  }

  async _ensureOpen() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not connected. Call connect(url) first.");
    }
  }

  _send(payload) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Cannot send WebSocket message before the connection is open.");
    }

    this.socket.send(JSON.stringify(payload));
  }

  _nextActionId() {
    this._actionSequence += 1;
    return `${this.playerId ?? "anonymous"}:${Date.now().toString(36)}:${this._actionSequence.toString(36)}`;
  }

  _captureConnection() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("WebSocket is not connected.");
    return { socket: this.socket, generation: this._connectionGeneration };
  }

  _isCurrentConnection(socket, generation) {
    return this.socket === socket
      && this._connectionGeneration === generation
      && socket.readyState === WebSocket.OPEN;
  }

  _sendOn(socket, payload) {
    if (!this._isCurrentConnection(socket, this._connectionGeneration)) {
      throw new Error("Connection changed before send.");
    }
    socket.send(JSON.stringify(payload));
  }

  _settleProtocolNegotiation(result, generation = this._connectionGeneration) {
    const pending = this._protocolNegotiation;
    if (!pending || pending.generation !== generation) {
      return;
    }
    globalThis.clearTimeout(pending.timeoutId);
    this._protocolNegotiation = null;
    this._actionProtocol = result.status === "selected" ? "selected" : result.status === "legacy" ? "legacy" : "unknown";
    this._actionProtocolInfo = { ...result };
    pending.resolve(result);
  }

  _rejectSyncRequests(error) {
    for (const [id, record] of this._syncRequests) {
      globalThis.clearTimeout(record.timeoutId);
      this._syncRequests.delete(id);
      record.reject(error);
    }
  }

  getActionProtocol() {
    return { ...this._actionProtocolInfo };
  }

  _sendRequest(payload, expectedTypes) {
    // Wait for a specific server event after sending a request.
    return new Promise((resolve, reject) => {
      const timeoutId = globalThis.setTimeout(() => {
        this._pendingRequests = this._pendingRequests.filter((request) => request !== requestRecord);
        reject(new Error(`Timed out waiting for ${expectedTypes.join(", ")}`));
      }, this.options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT);

      const requestRecord = {
        expectedTypes: new Set(expectedTypes),
        resolve,
        reject,
        timeoutId,
      };

      this._pendingRequests.push(requestRecord);

      try {
        this._send(payload);
      } catch (error) {
        globalThis.clearTimeout(timeoutId);
        this._pendingRequests = this._pendingRequests.filter((request) => request !== requestRecord);
        reject(error);
      }
    });
  }

  _resolvePendingRequest(payload) {
    if (!payload || typeof payload.type !== "string" || this._pendingRequests.length === 0) {
      return;
    }

    const request = this._pendingRequests.find((candidate) => {
      return candidate.expectedTypes.has(payload.type) || payload.type === ServerEvent.ERROR;
    });

    if (!request) {
      return;
    }

    globalThis.clearTimeout(request.timeoutId);
    this._pendingRequests = this._pendingRequests.filter((candidate) => candidate !== request);

    if (payload.type === ServerEvent.ERROR) {
      const error = new Error("Server request failed.");
      if (payload.code) error.code = payload.code;
      request.reject(error);
      return;
    }

    request.resolve(payload);
  }

  _rejectPendingRequests(error) {
    for (const request of this._pendingRequests) {
      globalThis.clearTimeout(request.timeoutId);
      request.reject(error);
    }
    this._pendingRequests = [];
  }

  _clearSession() {
    this._rejectSyncRequests(new Error("Room session ended while action sync was pending."));
    this.roomId = null;
    this.playerId = null;
    this.color = null;
  }

  _startHeartbeat() {
    this._stopHeartbeat();

    const interval = this.options.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL;
    const timeout = this.options.heartbeatTimeout ?? DEFAULT_HEARTBEAT_TIMEOUT;
    this._lastPongAt = Date.now();
    // Heartbeat sends ping on an interval and monitors pong timeouts.
    this._heartbeatTimerId = globalThis.setInterval(() => {
      if (!this.isConnected()) {
        return;
      }

      try {
        this._send({
          type: "ping",
          timestamp: Date.now(),
        });
      } catch (error) {
        this._emit(ServerEvent.ERROR, {
          type: ServerEvent.ERROR,
          code: "PING_FAILED",
          message: error?.message ?? "Ping failed.",
        });
      }
    }, interval);

    this._heartbeatWatchdogId = globalThis.setInterval(() => {
      if (!this.isConnected()) {
        return;
      }

      if (Date.now() - this._lastPongAt > timeout) {
        this.disconnect(4000, "heartbeat_timeout");
      }
    }, Math.max(1000, Math.floor(interval / 2)));
  }

  _stopHeartbeat() {
    if (this._heartbeatTimerId !== null) {
      globalThis.clearInterval(this._heartbeatTimerId);
      this._heartbeatTimerId = null;
    }

    if (this._heartbeatWatchdogId !== null) {
      globalThis.clearInterval(this._heartbeatWatchdogId);
      this._heartbeatWatchdogId = null;
    }
  }
}

export { ClientEvent, ServerEvent };
export { resolveWebSocketUrl };
export default NetworkManager;


