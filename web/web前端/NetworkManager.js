const DEFAULT_REQUEST_TIMEOUT = 10000;
const DEFAULT_HEARTBEAT_INTERVAL = 4000;
const DEFAULT_HEARTBEAT_TIMEOUT = 12000;
const DEFAULT_CONNECT_TIMEOUT = 10000;

// NetworkManager 璐熻矗鎶娾€滆姹?鍝嶅簲鈥濆拰鈥滃箍鎾簨浠垛€濇贩鍚堝湪鍚屼竴鏉?WebSocket 涓婄鐞嗚捣鏉ャ€?// 涓婂眰鍙渶瑕佽闃呬簨浠舵垨璋冪敤 sendXxx锛屾棤闇€鐩存帴鎿嶄綔 socket銆?
const ServerEvent = Object.freeze({
  ROOM_CREATED: "ROOM_CREATED",
  ROOM_JOINED: "ROOM_JOINED",
  ROOM_STATE: "ROOM_STATE",
  ROOM_COUNTDOWN: "ROOM_COUNTDOWN",
  ROOM_READY: "ROOM_READY",
  OPPONENT_MOVE: "OPPONENT_MOVE",
  TURN_SKIPPED: "TURN_SKIPPED",
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

function isValidPoint(point) {
  return Array.isArray(point)
    && point.length === 2
    && Number.isInteger(point[0])
    && Number.isInteger(point[1]);
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

    this._listeners = new Map();
    this._pendingRequests = [];
    this._connectPromise = null;
    this._connectAttempt = null;
    this._socketAuthToken = null;
    this._heartbeatTimerId = null;
    this._heartbeatWatchdogId = null;
    this._lastPongAt = 0;

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
    if (this.socket && this.socket.readyState === WebSocket.OPEN
      && this.url === url && this._socketAuthToken === authToken) {
      return this;
    }
    if (this._connectAttempt?.url === url && this._connectAttempt.authToken === authToken
      && this.socket === this._connectAttempt.socket) {
      return this._connectPromise;
    }

    // An old socket cannot settle the replacement's requests or stop its heartbeat.
    this._closeCurrentConnection(1000, "connection_replaced",
      new Error("WebSocket connection was replaced."), false);
    this.authToken = authToken;
    this.url = url;
    let socket;
    try {
      socket = new WebSocket(appendTokenToWebSocketUrl(url, authToken));
    } catch (_) {
      // Browser exceptions can include the authenticated URL. Keep errors generic.
      throw new Error("Failed to connect to WebSocket server.");
    }
    this.socket = socket;
    this._socketAuthToken = authToken;
    let resolveConnection, rejectConnection, timer = null, settled = false;
    const promise = new Promise((resolve, reject) => {
      resolveConnection = resolve; rejectConnection = reject;
    });
    const attempt = {
      socket, url, authToken,
      finish: (error) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        if (this._connectAttempt === attempt) {
          this._connectAttempt = null; this._connectPromise = null;
        }
        if (error) rejectConnection(error);
        else resolveConnection(this);
      },
    };
    this._connectAttempt = attempt;
    this._connectPromise = promise;
    const current = () => this.socket === socket;
    const configuredTimeout = this.options.connectTimeout;
    const timeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout : DEFAULT_CONNECT_TIMEOUT;
    timer = globalThis.setTimeout(() => {
      const error = new Error("Failed to connect to WebSocket server: connection timed out.");
      if (current()) this._closeCurrentConnection(1000, "connect_timeout", error);
      else attempt.finish(error);
    }, timeout);

    socket.addEventListener("open", () => {
      if (!current()) return;
      attempt.finish();
      this._lastPongAt = Date.now();
      this._startHeartbeat();
      this._emit(ClientEvent.OPEN, { type: ClientEvent.OPEN, url: this.url });
    }, { once: true });
    socket.addEventListener("message", (event) => {
      if (current()) this._handleMessage(event);
    });
    socket.addEventListener("error", () => {
      if (!current()) return;
      this._closeCurrentConnection(1000, "connect_error",
        new Error("Failed to connect to WebSocket server."), false);
      this._emit(ClientEvent.CONNECTION_ERROR, { type: ClientEvent.CONNECTION_ERROR });
      // An error listener may already have started a replacement connection.
      if (!this.socket) this._emit(ClientEvent.CLOSE, {
        type: ClientEvent.CLOSE, code: 1000, reason: "connect_error", wasClean: false,
      });
    });
    socket.addEventListener("close", (event) => {
      if (!current()) return;
      this._closeCurrentConnection(event.code, event.reason,
        new Error(`WebSocket closed: ${event.code}`), true, event.wasClean);
    }, { once: true });
    return promise;
  }

  disconnect(code = 1000, reason = "client_disconnect") {
    this._closeCurrentConnection(code, reason, new Error(`WebSocket closed: ${code}`));
  }

  _closeCurrentConnection(code, reason, error, notify = true, wasClean = false) {
    const socket = this.socket;
    this.socket = null;
    this._socketAuthToken = null;
    this._stopHeartbeat();
    this._connectAttempt?.finish(error);
    this._rejectPendingRequests(error);
    if (!socket) return;
    try {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(code, reason);
    } catch (_) { /* Cleanup is complete even if the browser cannot close. */ }
    if (notify) {
      this._emit(ClientEvent.CLOSE, { type: ClientEvent.CLOSE, code, reason, wasClean });
    }
  }

  async createRoom(settings = null) {
    await this._ensureOpen();
    const payloadToSend = { type: "create_room" };
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
        ...(playerId ? { playerId } : {}),
      },
      [ServerEvent.ROOM_JOINED],
    );

    this.roomId = payload.roomId ?? normalizedRoomId;
    this.playerId = payload.playerId ?? playerId ?? null;
    this.color = payload.color ?? null;
    return payload;
  }

  async sendMove(point) {
    if (!isValidPoint(point)) {
      throw new Error("sendMove(point) requires [x, y] integer coordinates.");
    }

    await this._ensureOpen();
    this._send({
      type: "player_move",
      point: clonePoint(point),
    });

    return {
      roomId: this.roomId,
      playerId: this.playerId,
      point: clonePoint(point),
    };
  }

  async sendSkip() {
    await this._ensureOpen();
    return this._sendRequest(
      { type: "player_skip" },
      [ServerEvent.TURN_SKIPPED],
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
      url: this.url,
      roomId: this.roomId,
      playerId: this.playerId,
      color: this.color,
      connected: this.isConnected(),
    };
  }

  hydrateSession(sessionLike = {}) {
    this.url = sessionLike.url ?? this.url;
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
        raw: event.data,
      });
      return;
    }

    if (!payload || typeof payload !== "object") {
      this._emit(ServerEvent.ERROR, {
        type: ServerEvent.ERROR,
        code: "INVALID_PAYLOAD",
        message: "Received an unsupported payload from server.",
        raw: payload,
      });
      return;
    }

    if (payload.type === ServerEvent.ROOM_CREATED) {
      this.roomId = payload.roomId ?? this.roomId;
      this.playerId = payload.playerId ?? this.playerId;
      this.color = payload.color ?? this.color;
    } else if (payload.type === ServerEvent.ROOM_JOINED) {
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
      const message = payload.message ?? payload.code ?? "Unknown server error";
      request.reject(new Error(message));
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


