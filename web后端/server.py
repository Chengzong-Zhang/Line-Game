import asyncio
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Optional
from uuid import uuid4

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles


ROOM_SIZE = 3
ROOM_CODE_LENGTH = 4
ROOM_TTL_SECONDS = 300
HEARTBEAT_TIMEOUT_SECONDS = 35
HEARTBEAT_SWEEP_SECONDS = 5
PLAYER_BLACK = "BLACK"
PLAYER_WHITE = "WHITE"
PLAYER_PURPLE = "PURPLE"


logger = logging.getLogger("uvicorn.error")


@dataclass
class PlayerSession:
    player_id: str
    color: str
    websocket: Optional[WebSocket] = None
    connected: bool = False
    last_seen: float = field(default_factory=time.time)


@dataclass
class Room:
    room_id: str
    players: Dict[str, PlayerSession] = field(default_factory=dict)
    actions: list[Dict[str, Any]] = field(default_factory=list)
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    def connected_players(self) -> list[PlayerSession]:
        return [player for player in self.players.values() if player.connected and player.websocket is not None]

    def active_player_count(self) -> int:
        return len(self.players)

    def has_connected_player(self) -> bool:
        return any(player.connected for player in self.players.values())

    def available_color(self) -> str:
        used_colors = {player.color for player in self.players.values()}
        for color in (PLAYER_BLACK, PLAYER_WHITE, PLAYER_PURPLE):
            if color not in used_colors:
                return color
        raise ValueError("No available color remaining in this room.")


class ConnectionManager:
    def __init__(self) -> None:
        self.rooms: Dict[str, Room] = {}
        self.websocket_index: Dict[WebSocket, tuple[str, str]] = {}
        self.lock = asyncio.Lock()
        self._heartbeat_task: Optional[asyncio.Task[Any]] = None

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()

    async def start(self) -> None:
        if self._heartbeat_task is None or self._heartbeat_task.done():
            self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())

    async def stop(self) -> None:
        if self._heartbeat_task is None:
            return

        self._heartbeat_task.cancel()
        try:
            await self._heartbeat_task
        except asyncio.CancelledError:
            pass
        self._heartbeat_task = None

    async def handle_message(self, websocket: WebSocket, message: Dict[str, Any]) -> None:
        message_type = message.get("type")
        room_id, player_id = self.websocket_index.get(websocket, (None, None))
        logger.info(
            "incoming message type=%s room=%s player=%s payload=%s",
            message_type,
            room_id,
            player_id,
            message,
        )

        if message_type == "create_room":
            await self.create_room(websocket)
            return

        if message_type == "join_room":
            room_id = str(message.get("roomId", "")).strip()
            player_id = message.get("playerId")
            await self.join_room(websocket, room_id=room_id, player_id=player_id)
            return

        if message_type == "player_move":
            point = message.get("point")
            await self.forward_move(websocket, point)
            return

        if message_type == "player_skip":
            await self.forward_skip(websocket)
            return

        if message_type == "player_reset":
            await self.forward_reset(websocket, message.get("reason"))
            return

        if message_type == "player_leave":
            await self.player_leave(websocket, reason="player_leave")
            return

        if message_type == "ping":
            await self.handle_ping(websocket, message.get("timestamp"))
            return

        await self.send_json(
            websocket,
            {
                "type": "ERROR",
                "code": "UNKNOWN_MESSAGE_TYPE",
                "message": f"Unsupported message type: {message_type!r}",
            },
        )

    async def create_room(self, websocket: WebSocket) -> None:
        async with self.lock:
            current_room_id, current_player_id = self.websocket_index.get(websocket, (None, None))
            if current_room_id and current_player_id:
                await self._detach_player(
                    current_room_id,
                    current_player_id,
                    notify_opponent=True,
                    leave_reason="switch_room",
                    remove_player=True,
                )

            room_id = self._generate_room_id()
            player_id = self._new_player_id()
            player = PlayerSession(
                player_id=player_id,
                color=PLAYER_BLACK,
                websocket=websocket,
                connected=True,
            )
            room = Room(room_id=room_id, players={player_id: player})
            self.rooms[room_id] = room
            self.websocket_index[websocket] = (room_id, player_id)

        await self.send_json(
            websocket,
            {
                "type": "ROOM_CREATED",
                "roomId": room_id,
                "playerId": player_id,
                "color": player.color,
                "status": "WAITING",
                "matchState": self._match_state(room),
            },
        )
        logger.info("room created room=%s player=%s color=%s", room_id, player_id, player.color)

    async def join_room(self, websocket: WebSocket, room_id: str, player_id: Optional[str] = None) -> None:
        if not room_id:
            await self.send_json(
                websocket,
                {
                    "type": "ERROR",
                    "code": "ROOM_ID_REQUIRED",
                    "message": "roomId is required.",
                },
            )
            return

        reconnected = False
        async with self.lock:
            self._cleanup_stale_rooms_locked()
            room = self.rooms.get(room_id)

            if room is None:
                await self.send_json(
                    websocket,
                    {
                        "type": "ERROR",
                        "code": "ROOM_NOT_FOUND",
                        "message": f"Room {room_id} does not exist.",
                    },
                )
                return

            existing_room_id, existing_player_id = self.websocket_index.get(websocket, (None, None))
            if existing_room_id and existing_player_id and existing_room_id != room_id:
                await self._detach_player(
                    existing_room_id,
                    existing_player_id,
                    notify_opponent=True,
                    leave_reason="switch_room",
                    remove_player=True,
                )

            session: Optional[PlayerSession] = None
            if player_id and player_id in room.players:
                candidate = room.players[player_id]
                if candidate.connected and candidate.websocket is not websocket and candidate.websocket is not None:
                    self.websocket_index.pop(candidate.websocket, None)
                    try:
                        await candidate.websocket.close(code=4001, reason="session_replaced")
                    except Exception:
                        pass
                session = candidate
                reconnected = True

            if session is None:
                if room.active_player_count() >= ROOM_SIZE:
                    await self.send_json(
                        websocket,
                        {
                            "type": "ERROR",
                            "code": "ROOM_FULL",
                            "message": f"Room {room_id} is full.",
                        },
                    )
                    return

                assigned_color = room.available_color()
                session = PlayerSession(
                    player_id=self._new_player_id(),
                    color=assigned_color,
                    websocket=websocket,
                    connected=True,
                )
                room.players[session.player_id] = session

            session.websocket = websocket
            session.connected = True
            session.last_seen = time.time()
            room.updated_at = time.time()
            self.websocket_index[websocket] = (room_id, session.player_id)
            room_snapshot = self._room_snapshot(room)

        await self.send_json(
            websocket,
            {
                "type": "ROOM_JOINED",
                "roomId": room_id,
                "playerId": session.player_id,
                "color": session.color,
                "status": "READY" if len(room_snapshot["players"]) == ROOM_SIZE else "WAITING",
                "reconnected": reconnected,
                "matchState": self._match_state(room),
            },
        )
        logger.info(
            "room joined room=%s player=%s color=%s ready=%s reconnected=%s",
            room_id,
            session.player_id,
            session.color,
            len(room_snapshot["players"]) == ROOM_SIZE,
            reconnected,
        )

        if len(room_snapshot["players"]) == ROOM_SIZE:
            await self.broadcast_room_ready(room_id, reconnected_player_id=session.player_id if reconnected else None)

    async def handle_ping(self, websocket: WebSocket, timestamp: Any) -> None:
        async with self.lock:
            room_and_player = self.websocket_index.get(websocket)
            if room_and_player is not None:
                room_id, player_id = room_and_player
                room = self.rooms.get(room_id)
                if room is not None and player_id in room.players:
                    room.players[player_id].last_seen = time.time()
                    room.updated_at = time.time()

        await self.send_json(
            websocket,
            {
                "type": "PONG",
                "timestamp": timestamp,
            },
        )

    async def forward_move(self, websocket: WebSocket, point: Any) -> None:
        if not self._is_valid_point(point):
            await self.send_json(
                websocket,
                {
                    "type": "ERROR",
                    "code": "INVALID_POINT",
                    "message": "point must be a two-item integer array like [x, y].",
                },
            )
            return

        room_and_player = self.websocket_index.get(websocket)
        if room_and_player is None:
            await self.send_json(
                websocket,
                {
                    "type": "ERROR",
                    "code": "NOT_IN_ROOM",
                    "message": "Join or create a room before sending moves.",
                },
            )
            return

        room_id, sender_id = room_and_player
        async with self.lock:
            room = self.rooms.get(room_id)
            if room is None or sender_id not in room.players:
                await self.send_json(
                    websocket,
                    {
                        "type": "ERROR",
                        "code": "ROOM_NOT_FOUND",
                        "message": "The room no longer exists.",
                    },
                )
                return

            sender = room.players[sender_id]
            sender.last_seen = time.time()
            room.updated_at = time.time()
            room.actions.append(
                {
                    "type": "player_move",
                    "point": [int(point[0]), int(point[1])],
                    "playerId": sender.player_id,
                    "color": sender.color,
                }
            )
            recipients = [
                other_player
                for other_player in self._find_other_players(room, sender_id)
                if other_player.websocket is not None and other_player.connected
            ]

        if not recipients:
            await self.send_json(
                websocket,
                {
                    "type": "ERROR",
                    "code": "OPPONENT_OFFLINE",
                    "message": "No other player is connected.",
                },
            )
            return

        payload = {
            "type": "OPPONENT_MOVE",
            "roomId": room_id,
            "point": [int(point[0]), int(point[1])],
            "playerId": sender.player_id,
            "color": sender.color,
        }
        for recipient in recipients:
            await self.send_json(recipient.websocket, dict(payload))

    async def forward_skip(self, websocket: WebSocket) -> None:
        async with self.lock:
            action = self._prepare_room_action_locked(websocket)
            if action["error"] is not None:
                error_payload = action["error"]
                payloads = []
            else:
                payload = {
                    "type": "TURN_SKIPPED",
                    "roomId": action["room_id"],
                    "playerId": action["sender"].player_id,
                    "color": action["sender"].color,
                }
                action["room"].actions.append(
                    {
                        "type": "player_skip",
                        "playerId": action["sender"].player_id,
                        "color": action["sender"].color,
                    }
                )
                payloads = self._connected_room_payloads(action["room"], payload)
                error_payload = None

        if error_payload is not None:
            await self.send_json(websocket, error_payload)
            return

        for target_websocket, payload in payloads:
            await self.send_json(target_websocket, payload)

    async def forward_reset(self, websocket: WebSocket, reason: Any) -> None:
        normalized_reason = reason if reason == "normal_restart" else "resign_restart"

        async with self.lock:
            action = self._prepare_room_action_locked(websocket)
            if action["error"] is not None:
                error_payload = action["error"]
                payloads = []
            else:
                action["room"].actions = []
                payload = {
                    "type": "MATCH_RESET",
                    "roomId": action["room_id"],
                    "playerId": action["sender"].player_id,
                    "color": action["sender"].color,
                    "reason": normalized_reason,
                    "winnerColor": None if normalized_reason == "normal_restart" else None,
                }
                payloads = self._connected_room_payloads(action["room"], payload)
                error_payload = None

        if error_payload is not None:
            await self.send_json(websocket, error_payload)
            return

        for target_websocket, payload in payloads:
            await self.send_json(target_websocket, payload)

    async def player_leave(self, websocket: WebSocket, reason: str = "player_leave") -> None:
        async with self.lock:
            room_and_player = self.websocket_index.get(websocket)
            if room_and_player is None:
                return

            room_id, player_id = room_and_player
            await self._detach_player(room_id, player_id, notify_opponent=True, leave_reason=reason, remove_player=True)

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self.lock:
            room_and_player = self.websocket_index.get(websocket)
            if room_and_player is None:
                return

            room_id, player_id = room_and_player
            await self._detach_player(room_id, player_id, notify_opponent=True, leave_reason="disconnect", remove_player=False)

    async def broadcast_room_ready(self, room_id: str, reconnected_player_id: Optional[str] = None) -> None:
        async with self.lock:
            room = self.rooms.get(room_id)
            if room is None:
                return

            room.updated_at = time.time()
            payloads = []
            players = [
                {
                    "playerId": player.player_id,
                    "color": player.color,
                    "connected": player.connected,
                }
                for player in room.players.values()
            ]

            for player in room.connected_players():
                payloads.append(
                    (
                        player.websocket,
                        {
                            "type": "ROOM_READY",
                            "roomId": room_id,
                            "yourPlayerId": player.player_id,
                            "yourColor": player.color,
                            "players": players,
                            "reconnectedPlayerId": reconnected_player_id,
                            "matchState": self._match_state(room),
                        },
                    )
                )

        for websocket, payload in payloads:
            if websocket is not None:
                await self.send_json(websocket, payload)

    async def send_json(self, websocket: WebSocket, payload: Dict[str, Any]) -> None:
        logger.info("outgoing payload=%s", payload)
        await websocket.send_json(payload)

    async def _heartbeat_loop(self) -> None:
        while True:
            await asyncio.sleep(HEARTBEAT_SWEEP_SECONDS)
            stale_connections: list[WebSocket] = []

            async with self.lock:
                now = time.time()
                for websocket, room_and_player in list(self.websocket_index.items()):
                    room_id, player_id = room_and_player
                    room = self.rooms.get(room_id)
                    if room is None:
                        continue

                    player = room.players.get(player_id)
                    if player is None or not player.connected:
                        continue

                    if now - player.last_seen <= HEARTBEAT_TIMEOUT_SECONDS:
                        continue

                    logger.info("heartbeat timeout room=%s player=%s", room_id, player_id)
                    await self._detach_player(
                        room_id,
                        player_id,
                        notify_opponent=True,
                        leave_reason="heartbeat_timeout",
                        remove_player=False,
                    )
                    stale_connections.append(websocket)

            for websocket in stale_connections:
                try:
                    await websocket.close(code=4000, reason="heartbeat_timeout")
                except Exception:
                    pass

    async def _detach_player(
        self,
        room_id: str,
        player_id: str,
        notify_opponent: bool,
        leave_reason: str = "leave",
        remove_player: bool = False,
    ) -> None:
        room = self.rooms.get(room_id)
        if room is None:
            return

        player = room.players.get(player_id)
        if player is None:
            return

        websocket = player.websocket
        other_players = self._find_other_players(room, player_id)

        if websocket in self.websocket_index:
            self.websocket_index.pop(websocket, None)

        player.websocket = None
        player.connected = False
        player.last_seen = time.time()
        room.updated_at = time.time()

        if remove_player:
            room.players.pop(player_id, None)

        if notify_opponent:
            for other_player in other_players:
                if other_player.connected and other_player.websocket is not None:
                    await self.send_json(
                        other_player.websocket,
                        {
                            "type": "PLAYER_LEFT",
                            "roomId": room_id,
                            "playerId": player_id,
                            "reason": leave_reason,
                            "canReconnect": not remove_player,
                        },
                    )

        if not room.players:
            self.rooms.pop(room_id, None)
            return

        if remove_player and not room.has_connected_player():
            self.rooms.pop(room_id, None)
            return

        self._cleanup_stale_rooms_locked()

    def _find_other_players(self, room: Room, player_id: str) -> list[PlayerSession]:
        return [other_player for other_id, other_player in room.players.items() if other_id != player_id]

    def _prepare_room_action_locked(self, websocket: WebSocket) -> Dict[str, Any]:
        room_and_player = self.websocket_index.get(websocket)
        if room_and_player is None:
            return {
                "error": {
                    "type": "ERROR",
                    "code": "NOT_IN_ROOM",
                    "message": "Join or create a room before sending room actions.",
                },
            }

        room_id, sender_id = room_and_player
        room = self.rooms.get(room_id)
        if room is None or sender_id not in room.players:
            return {
                "error": {
                    "type": "ERROR",
                    "code": "ROOM_NOT_FOUND",
                    "message": "The room no longer exists.",
                },
            }

        sender = room.players[sender_id]
        sender.last_seen = time.time()
        room.updated_at = time.time()
        opponents = [
            player
            for player in self._find_other_players(room, sender_id)
            if player.websocket is not None and player.connected
        ]
        if not opponents:
            return {
                "error": {
                    "type": "ERROR",
                    "code": "OPPONENT_OFFLINE",
                    "message": "No other player is connected.",
                },
            }

        return {
            "error": None,
            "room_id": room_id,
            "room": room,
            "sender": sender,
            "opponents": opponents,
        }

    def _connected_room_payloads(self, room: Room, payload: Dict[str, Any]) -> list[tuple[WebSocket, Dict[str, Any]]]:
        payloads = []
        for player in room.connected_players():
            if player.websocket is not None:
                payloads.append((player.websocket, dict(payload)))
        return payloads

    def _generate_room_id(self) -> str:
        while True:
            room_id = f"{uuid4().int % 10000:0{ROOM_CODE_LENGTH}d}"
            if room_id not in self.rooms:
                return room_id

    def _new_player_id(self) -> str:
        return uuid4().hex

    def _cleanup_stale_rooms_locked(self) -> None:
        now = time.time()
        expired_room_ids = []

        for room_id, room in self.rooms.items():
            if room.has_connected_player():
                continue
            if now - room.updated_at > ROOM_TTL_SECONDS:
                expired_room_ids.append(room_id)

        for room_id in expired_room_ids:
            self.rooms.pop(room_id, None)

    def _is_valid_point(self, point: Any) -> bool:
        if not isinstance(point, list) or len(point) != 2:
            return False
        return all(isinstance(value, int) for value in point)

    def _room_snapshot(self, room: Room) -> Dict[str, Any]:
        return {
            "roomId": room.room_id,
            "players": [
                {
                    "playerId": player.player_id,
                    "color": player.color,
                    "connected": player.connected,
                }
                for player in room.players.values()
            ],
        }

    def _match_state(self, room: Room) -> Dict[str, Any]:
        return {
            "actions": [dict(action) for action in room.actions],
        }


app = FastAPI(title="TriAxis Relay Server")
manager = ConnectionManager()

BASE_DIR = Path(__file__).resolve().parent


def _resolve_frontend_dir() -> Path:
    if (BASE_DIR / "index.html").exists():
        return BASE_DIR

    sibling_dir = BASE_DIR.parent / "web前端"
    if (sibling_dir / "index.html").exists():
        return sibling_dir

    for candidate in BASE_DIR.parent.iterdir():
        if candidate.is_dir() and (candidate / "index.html").exists():
            return candidate

    raise FileNotFoundError("Could not locate the frontend directory with index.html.")


FRONTEND_DIR = _resolve_frontend_dir()
INDEX_FILE = FRONTEND_DIR / "index.html"


@app.on_event("startup")
async def on_startup() -> None:
    await manager.start()


@app.on_event("shutdown")
async def on_shutdown() -> None:
    await manager.stop()


@app.middleware("http")
async def add_no_cache_headers(request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.endswith((".js", ".css", ".html")):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


@app.get("/")
async def serve_index() -> Response:
    response = FileResponse(INDEX_FILE)
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await manager.connect(websocket)

    try:
        while True:
            message = await websocket.receive_json()
            if not isinstance(message, dict):
                await manager.send_json(
                    websocket,
                    {
                        "type": "ERROR",
                        "code": "INVALID_MESSAGE",
                        "message": "WebSocket payload must be a JSON object.",
                    },
                )
                continue

            await manager.handle_message(websocket, message)
    except WebSocketDisconnect:
        await manager.disconnect(websocket)
    except Exception as exc:
        try:
            await manager.send_json(
                websocket,
                {
                    "type": "ERROR",
                    "code": "SERVER_ERROR",
                    "message": str(exc),
                },
            )
        except Exception:
            pass
        await manager.disconnect(websocket)


app.mount("/", StaticFiles(directory=FRONTEND_DIR), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000, reload=False)
