const DEFAULT_REQUEST_TIMEOUT = 10000;

const ServerEvent = Object.freeze({
  ROOM_CREATED: "ROOM_CREATED",
  ROOM_JOINED: "ROOM_JOINED",
  ROOM_READY: "ROOM_READY",
  OPPONENT_MOVE: "OPPONENT_MOVE",
  TURN_SKIPPED: "TURN_SKIPPED",
  MATCH_RESET: "MATCH_RESET",
  PLAYER_LEFT: "PLAYER_LEFT",
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

  return `${protocol}//${host}/ws`;
}

export class NetworkManager {
  constructor(options = {}) {
    this.options = options;
    this.socket = null;
    this.url = null;
    this.roomId = null;
    this.playerId = null;
    this.color = null;

    this._listeners = new Map();
    this._pendingRequests = [];
    this._connectPromise = null;

    if (options.handlers && typeof options.handlers === "object") {
      for (const [eventName, handler] of Object.entries(options.handlers)) {
        if (typeof handler === "function") {
          this.on(eventName, handler);
        }
      }
    }
  }

  async connect(url) {
    if (!url || typeof url !== "string") {
      throw new Error("connect(url) requires a valid WebSocket URL.");
    }

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
    this._connectPromise = new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      this.socket = socket;

      socket.addEventListener("open", () => {
        this._connectPromise = null;
        this._emit(ClientEvent.OPEN, {
          type: ClientEvent.OPEN,
          url: this.url,
        });
        resolve(this);
      }, { once: true });

      socket.addEventListener("message", (event) => {
        this._handleMessage(event);
      });

      socket.addEventListener("error", (event) => {
        this._emit(ClientEvent.CONNECTION_ERROR, {
          type: ClientEvent.CONNECTION_ERROR,
          event,
        });
      });

      socket.addEventListener("close", (event) => {
        const wasCurrentSocket = this.socket === socket;
        this._connectPromise = null;

        if (wasCurrentSocket) {
          this.socket = null;
          this._rejectPendingRequests(new Error(`WebSocket closed: ${event.code} ${event.reason}`));
          this._emit(ClientEvent.CLOSE, {
            type: ClientEvent.CLOSE,
            code: event.code,
            reason: event.reason,
            wasClean: event.wasClean,
          });
        }
      }, { once: true });

      socket.addEventListener("error", () => {
        if (socket.readyState === WebSocket.CONNECTING) {
          this._connectPromise = null;
          reject(new Error(`Failed to connect to ${url}`));
        }
      }, { once: true });
    });

    return this._connectPromise;
  }

  disconnect(code = 1000, reason = "client_disconnect") {
    if (!this.socket) {
      return;
    }

    const socket = this.socket;
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(code, reason);
      return;
    }

    if (this.socket === socket) {
      this.socket = null;
    }
  }

  async createRoom() {
    await this._ensureOpen();
    const payload = await this._sendRequest(
      { type: "create_room" },
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

  async sendReset(reason = "resign_restart") {
    const normalizedReason = reason === "normal_restart" ? "normal_restart" : "resign_restart";
    await this._ensureOpen();
    return this._sendRequest(
      {
        type: "player_reset",
        reason: normalizedReason,
      },
      [ServerEvent.MATCH_RESET],
    );
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
}

export { ClientEvent, ServerEvent };
export { resolveWebSocketUrl };
export default NetworkManager;
