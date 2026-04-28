import asyncio
import hashlib
import logging
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Generator, Optional
from uuid import uuid4

import bcrypt
import jwt
from fastapi import Depends, FastAPI, HTTPException, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

try:
    from .database import SessionLocal, init_db  # type: ignore
except ImportError:
    from database import SessionLocal, init_db

try:
    from .models import User  # type: ignore
except ImportError:
    from models import User


# 这个服务负责账号、静态资源、房间、连接和动作同步，
# 但不负责棋盘几何规则判定；胜负与面积仍由浏览器端 GameEngine 计算。
ROOM_SIZE = 3
ROOM_CODE_LENGTH = 4
ROOM_TTL_SECONDS = 300
HEARTBEAT_TIMEOUT_SECONDS = 35
HEARTBEAT_SWEEP_SECONDS = 5
READY_COUNTDOWN_SECONDS = 3
MIN_GRID_SIZE = 5
MAX_GRID_SIZE = 15
TURN_TIMER_MIN_SECONDS = 15
TURN_TIMER_MAX_SECONDS = 200
DEFAULT_TURN_TIMER_SECONDS = 60
PLAYER_BLACK = "BLACK"
PLAYER_WHITE = "WHITE"
PLAYER_PURPLE = "PURPLE"
JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY", "replace-this-with-a-long-random-secret-key")
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_DAYS = 7
PASSWORD_HASH_PREFIX = "bcrypt_sha256$"


logger = logging.getLogger("uvicorn.error")


class RegisterRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=50)
    password: str = Field(..., min_length=1, max_length=128)


class LoginRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=50)
    password: str = Field(..., min_length=1, max_length=128)


class RegisterResponse(BaseModel):
    message: str
    username: str


class LoginResponse(BaseModel):
    token: str
    username: str
    token_type: str
    expires_in: int


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def hash_password(password: str) -> str:
    password_bytes = _derive_password_bytes(password)
    password_hash = bcrypt.hashpw(password_bytes, bcrypt.gensalt())
    return f"{PASSWORD_HASH_PREFIX}{password_hash.decode('utf-8')}"


def verify_password(password: str, password_hash: str) -> bool:
    try:
        if password_hash.startswith(PASSWORD_HASH_PREFIX):
            stored_hash = password_hash[len(PASSWORD_HASH_PREFIX) :].encode("utf-8")
            return bcrypt.checkpw(_derive_password_bytes(password), stored_hash)

        # Keep legacy bcrypt users working after removing passlib.
        return bcrypt.checkpw(password.encode("utf-8")[:72], password_hash.encode("utf-8"))
    except ValueError:
        return False


def _derive_password_bytes(password: str) -> bytes:
    return hashlib.sha256(password.encode("utf-8")).digest()


def create_access_token(username: str) -> str:
    expires_at = datetime.now(timezone.utc) + timedelta(days=JWT_EXPIRE_DAYS)
    payload = {
        "sub": username,
        "username": username,
        "exp": expires_at,
    }
    return jwt.encode(payload, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> str:
    try:
        payload = jwt.decode(token, JWT_SECRET_KEY, algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError as exc:
        raise ValueError("Token has expired.") from exc
    except jwt.PyJWTError as exc:
        raise ValueError("Invalid token.") from exc

    username = str(payload.get("username") or payload.get("sub") or "").strip()
    if not username:
        raise ValueError("Token payload missing username.")

    return username


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
    settings: Dict[str, Any] = field(default_factory=dict)
    host_player_id: Optional[str] = None
    reset_votes: set[str] = field(default_factory=set)
    ready_players: set[str] = field(default_factory=set)
    match_started: bool = False
    countdown_started_at: Optional[float] = None
    countdown_task: Optional[asyncio.Task[Any]] = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    def connected_players(self) -> list[PlayerSession]:
        return [player for player in self.players.values() if player.connected and player.websocket is not None]

    def active_player_count(self) -> int:
        return len(self.players)

    def has_connected_player(self) -> bool:
        return any(player.connected for player in self.players.values())

    def player_capacity(self) -> int:
        return int(self.settings.get("playerCount", 2))

    def available_color(self) -> str:
        # Keep color assignment order stable so the frontend can map colors consistently.
        used_colors = {player.color for player in self.players.values()}
        allowed_colors = (PLAYER_BLACK, PLAYER_WHITE, PLAYER_PURPLE)[:self.player_capacity()]
        for color in allowed_colors:
            if color not in used_colors:
                return color
        raise ValueError("No available color remaining in this room.")


class ConnectionManager:
    def __init__(self) -> None:
        self.rooms: Dict[str, Room] = {}
        self.websocket_index: Dict[WebSocket, tuple[str, str]] = {}
        self.player_room_index: Dict[str, str] = {}
        self.lock = asyncio.Lock()
        self._heartbeat_task: Optional[asyncio.Task[Any]] = None

    async def connect(self, websocket: WebSocket, username: str) -> None:
        websocket.state.username = username
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
            await self.create_room(
                websocket,
                username=self._authenticated_username(websocket),
                settings=message.get("settings"),
            )
            return

        if message_type == "join_room":
            room_id = str(message.get("roomId", "")).strip()
            await self.join_room(
                websocket,
                room_id=room_id,
                username=self._authenticated_username(websocket),
            )
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

        if message_type == "player_ready":
            await self.set_player_ready(websocket, message.get("ready"))
            return

        if message_type == "update_room_settings":
            await self.update_room_settings(websocket, message.get("settings"))
            return

        if message_type == "update_start_player":
            await self.update_start_player(websocket, message.get("startPlayer"))
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

    async def create_room(
        self,
        websocket: WebSocket,
        username: str,
        settings: Optional[Dict[str, Any]] = None,
    ) -> None:
        normalized_settings = self._normalize_room_settings(settings)
        async with self.lock:
            current_room_id = self.player_room_index.get(username)
            if current_room_id:
                await self._detach_player(
                    current_room_id,
                    username,
                    notify_opponent=True,
                    leave_reason="switch_room",
                    remove_player=True,
                )

            room_id = self._generate_room_id()
            player = PlayerSession(
                player_id=username,
                color=PLAYER_BLACK,
                websocket=websocket,
                connected=True,
            )
            room = Room(
                room_id=room_id,
                players={username: player},
                settings=normalized_settings,
                host_player_id=username,
            )
            self.rooms[room_id] = room
            self.websocket_index[websocket] = (room_id, username)
            self.player_room_index[username] = room_id

        await self.send_json(websocket, self._room_payload("ROOM_CREATED", room, your_player_id=username))
        logger.info("room created room=%s player=%s color=%s", room_id, username, player.color)

    async def join_room(self, websocket: WebSocket, room_id: str, username: str) -> None:
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

            existing_room_id = self.player_room_index.get(username)
            if existing_room_id and existing_room_id != room_id:
                await self._detach_player(
                    existing_room_id,
                    username,
                    notify_opponent=True,
                    leave_reason="switch_room",
                    remove_player=True,
                )

            session: Optional[PlayerSession] = None
            if username in room.players:
                candidate = room.players[username]
                if candidate.connected and candidate.websocket is not websocket and candidate.websocket is not None:
                    self.websocket_index.pop(candidate.websocket, None)
                    try:
                        await candidate.websocket.close(code=4001, reason="session_replaced")
                    except Exception:
                        pass
                session = candidate
                reconnected = True

            if session is None:
                if room.active_player_count() >= room.player_capacity():
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
                    player_id=username,
                    color=assigned_color,
                    websocket=websocket,
                    connected=True,
                )
                room.players[session.player_id] = session

            session.websocket = websocket
            session.connected = True
            session.last_seen = time.time()
            room.updated_at = time.time()
            room.reset_votes.clear()
            self.websocket_index[websocket] = (room_id, session.player_id)
            self.player_room_index[session.player_id] = room_id
            direct_payload = self._room_payload("ROOM_JOINED", room, your_player_id=session.player_id)
            direct_payload["reconnected"] = reconnected
            broadcast_payloads = self._connected_room_payloads(
                room,
                self._room_payload("ROOM_STATE", room),
            )

        await self.send_json(websocket, direct_payload)
        logger.info(
            "room joined room=%s player=%s color=%s ready=%s reconnected=%s",
            room_id,
            session.player_id,
            session.color,
            room.active_player_count() == room.player_capacity(),
            reconnected,
        )
        for target_websocket, payload in broadcast_payloads:
            if target_websocket is websocket:
                continue
            await self.send_json(target_websocket, payload)

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
            room.reset_votes.clear()
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
                action["room"].reset_votes.clear()
                payloads = self._connected_room_payloads(action["room"], payload)
                error_payload = None

        if error_payload is not None:
            await self.send_json(websocket, error_payload)
            return

        for target_websocket, payload in payloads:
            await self.send_json(target_websocket, payload)

    async def forward_reset(self, websocket: WebSocket, reason: Any) -> None:
        async with self.lock:
            action = self._prepare_room_action_locked(websocket)
            if action["error"] is not None:
                error_payload = action["error"]
                payloads = []
            else:
                room = action["room"]
                restart_reason = "normal_restart" if reason == "normal_restart" else "resign_restart"

                if restart_reason == "normal_restart":
                    room.actions = []
                    room.match_started = False
                    room.ready_players.clear()
                    room.reset_votes.clear()
                    self._cancel_countdown_locked(room)
                    payload = self._room_payload("MATCH_RESET", room, reason="normal_restart")
                    payload["playerId"] = action["sender"].player_id
                    payload["color"] = action["sender"].color
                    payloads = self._connected_room_payloads(room, payload)
                else:
                    winner = next(
                        (player for player in self._find_other_players(room, action["sender"].player_id)),
                        None,
                    )
                    room.actions = []
                    room.match_started = False
                    room.ready_players.clear()
                    room.reset_votes.clear()
                    self._cancel_countdown_locked(room)
                    payload = self._room_payload("MATCH_RESET", room, reason="resign_restart")
                    payload["playerId"] = action["sender"].player_id
                    payload["color"] = action["sender"].color
                    if winner is not None:
                        payload["winnerColor"] = winner.color
                    payloads = self._connected_room_payloads(room, payload)
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

    async def set_player_ready(self, websocket: WebSocket, ready: Any) -> None:
        async with self.lock:
            action = self._prepare_room_member_locked(websocket)
            if action["error"] is not None:
                error_payload = action["error"]
                payloads = []
            else:
                room = action["room"]
                sender = action["sender"]
                if room.match_started:
                    error_payload = {
                        "type": "ERROR",
                        "code": "MATCH_IN_PROGRESS",
                        "message": "Match is already in progress.",
                    }
                    payloads = []
                    room.updated_at = time.time()
                else:
                    desired_ready = bool(ready)
                    if desired_ready:
                        room.ready_players.add(sender.player_id)
                    else:
                        room.ready_players.discard(sender.player_id)

                    room.updated_at = time.time()
                    payloads = []
                    error_payload = None

                    if room.active_player_count() < room.player_capacity():
                        self._cancel_countdown_locked(room)
                        payloads = self._connected_room_payloads(room, self._room_payload("ROOM_STATE", room))
                    elif len(room.ready_players) >= room.player_capacity():
                        if room.countdown_started_at is None and not room.match_started:
                            self._start_countdown_locked(room)
                        payloads = self._connected_room_payloads(room, self._room_payload("ROOM_COUNTDOWN", room))
                    else:
                        self._cancel_countdown_locked(room)
                        payloads = self._connected_room_payloads(room, self._room_payload("ROOM_STATE", room))

        if error_payload is not None:
            await self.send_json(websocket, error_payload)
            return

        for target_websocket, payload in payloads:
            await self.send_json(target_websocket, payload)

    async def update_room_settings(self, websocket: WebSocket, settings: Any) -> None:
        async with self.lock:
            action = self._prepare_room_member_locked(websocket)
            if action["error"] is not None:
                error_payload = action["error"]
                payloads = []
            else:
                room = action["room"]
                sender = action["sender"]
                if sender.player_id != room.host_player_id:
                    error_payload = {
                        "type": "ERROR",
                        "code": "HOST_ONLY_ACTION",
                        "message": "Only the host can update room settings.",
                    }
                    payloads = []
                else:
                    normalized_settings = self._normalize_room_settings(settings)
                    allowed_colors = (PLAYER_BLACK, PLAYER_WHITE, PLAYER_PURPLE)[: int(normalized_settings["playerCount"])]
                    if len(room.players) > int(normalized_settings["playerCount"]) or any(
                        player.color not in allowed_colors for player in room.players.values()
                    ):
                        error_payload = {
                            "type": "ERROR",
                            "code": "ROOM_CAPACITY_CONFLICT",
                            "message": "The new player count is smaller than the current room roster.",
                        }
                        payloads = []
                    else:
                        room.settings = normalized_settings
                        room.actions = []
                        room.match_started = False
                        room.ready_players.clear()
                        room.reset_votes.clear()
                        self._cancel_countdown_locked(room)
                        room.updated_at = time.time()
                        payloads = self._connected_room_payloads(
                            room,
                            self._room_payload("ROOM_STATE", room, reason="settings_updated"),
                        )
                        error_payload = None

        if error_payload is not None:
            await self.send_json(websocket, error_payload)
            return

        for target_websocket, payload in payloads:
            await self.send_json(target_websocket, payload)

    async def update_start_player(self, websocket: WebSocket, start_player: Any) -> None:
        async with self.lock:
            action = self._prepare_room_member_locked(websocket)
            if action["error"] is not None:
                error_payload = action["error"]
                payloads = []
            else:
                room = action["room"]
                sender = action["sender"]
                if sender.player_id != room.host_player_id:
                    error_payload = {
                        "type": "ERROR",
                        "code": "HOST_ONLY_ACTION",
                        "message": "Only the host can update room settings.",
                    }
                    payloads = []
                else:
                    normalized_settings = self._normalize_room_settings(
                        {
                            **room.settings,
                            "startPlayer": start_player,
                        }
                    )
                    room.settings = normalized_settings
                    room.ready_players.clear()
                    room.reset_votes.clear()
                    self._cancel_countdown_locked(room)
                    room.updated_at = time.time()
                    payloads = self._connected_room_payloads(
                        room,
                        self._room_payload("ROOM_STATE", room, reason="settings_updated"),
                    )
                    error_payload = None

        if error_payload is not None:
            await self.send_json(websocket, error_payload)
            return

        for target_websocket, payload in payloads:
            await self.send_json(target_websocket, payload)

    async def broadcast_room_ready(self, room_id: str) -> None:
        async with self.lock:
            room = self.rooms.get(room_id)
            if room is None:
                return

            room.updated_at = time.time()
            payloads = self._connected_room_payloads(room, self._room_payload("ROOM_READY", room))

        for websocket, payload in payloads:
            if websocket is not None:
                await self.send_json(websocket, payload)

    def _prepare_room_member_locked(self, websocket: WebSocket) -> Dict[str, Any]:
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
        return {
            "error": None,
            "room_id": room_id,
            "room": room,
            "sender": sender,
        }

    def _room_status(self, room: Room) -> str:
        if room.active_player_count() < room.player_capacity():
            return "WAITING"
        if room.countdown_started_at is not None and self._countdown_ends_at_ms(room) is not None:
            return "COUNTDOWN"
        if room.match_started:
            return "IN_PROGRESS"
        return "LOBBY"

    def _match_phase(self, room: Room) -> str:
        if room.match_started:
            return "PLAYING"
        if room.countdown_started_at is not None and self._countdown_ends_at_ms(room) is not None:
            return "READY_TO_START"
        if room.active_player_count() < room.player_capacity():
            return "WAITING_FOR_PLAYERS"
        return "LOBBY"

    def _countdown_ends_at_ms(self, room: Room) -> Optional[int]:
        if room.countdown_started_at is None:
            return None
        ends_at = room.countdown_started_at + READY_COUNTDOWN_SECONDS
        if ends_at <= time.time():
            return None
        return int(ends_at * 1000)

    def _room_payload(
        self,
        event_type: str,
        room: Room,
        your_player_id: Optional[str] = None,
        reason: Optional[str] = None,
    ) -> Dict[str, Any]:
        players = [
            {
                "playerId": player.player_id,
                "color": player.color,
                "connected": player.connected,
                "ready": player.player_id in room.ready_players,
                "isHost": player.player_id == room.host_player_id,
            }
            for player in room.players.values()
        ]
        payload = {
            "type": event_type,
            "roomId": room.room_id,
            "status": self._room_status(room),
            "matchPhase": self._match_phase(room),
            "hostPlayerId": room.host_player_id,
            "settings": dict(room.settings),
            "players": players,
            "matchState": self._match_state(room),
            "countdownEndsAt": self._countdown_ends_at_ms(room),
            "serverTimestamp": int(room.updated_at * 1000),
        }
        if reason:
            payload["reason"] = reason
        if your_player_id and your_player_id in room.players:
            payload["yourPlayerId"] = your_player_id
            payload["playerId"] = your_player_id
            payload["yourColor"] = room.players[your_player_id].color
            payload["color"] = room.players[your_player_id].color
        return payload

    def _cancel_countdown_locked(self, room: Room) -> None:
        if room.countdown_task is not None:
            room.countdown_task.cancel()
            room.countdown_task = None
        room.countdown_started_at = None

    def _start_countdown_locked(self, room: Room) -> None:
        self._cancel_countdown_locked(room)
        room.countdown_started_at = time.time()
        room.countdown_task = asyncio.create_task(self._run_countdown(room.room_id, room.countdown_started_at))

    async def _run_countdown(self, room_id: str, countdown_started_at: float) -> None:
        try:
            await asyncio.sleep(READY_COUNTDOWN_SECONDS)
            async with self.lock:
                room = self.rooms.get(room_id)
                if room is None:
                    return
                if room.countdown_started_at != countdown_started_at:
                    return
                if room.active_player_count() < room.player_capacity():
                    self._cancel_countdown_locked(room)
                    return
                if len(room.ready_players) < room.player_capacity():
                    self._cancel_countdown_locked(room)
                    return

                room.actions = []
                room.match_started = True
                room.reset_votes.clear()
                room.updated_at = time.time()
                room.countdown_started_at = None
                room.countdown_task = None
                # 为每位玩家单独构造含 yourPlayerId/yourColor 的 ROOM_READY，让前端能可靠识别自身颜色。
                payloads = [
                    (player.websocket, self._room_payload("ROOM_READY", room, your_player_id=player.player_id))
                    for player in room.connected_players()
                    if player.websocket is not None
                ]
        except asyncio.CancelledError:
            return

        for target_websocket, payload in payloads:
            await self.send_json(target_websocket, payload)

    async def send_json(self, websocket: WebSocket, payload: Dict[str, Any]) -> None:
        logger.info("outgoing payload=%s", payload)
        await websocket.send_json(payload)

    def _authenticated_username(self, websocket: WebSocket) -> str:
        username = str(getattr(websocket.state, "username", "")).strip()
        if not username:
            raise ValueError("WebSocket connection is not authenticated.")
        return username

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
        room.reset_votes.clear()
        room.ready_players.discard(player_id)
        # 永久离开时才重置 match_started；临时断线只取消倒计时，不回退已开始的对局。
        if remove_player:
            room.match_started = False
        self._cancel_countdown_locked(room)

        if remove_player:
            room.players.pop(player_id, None)
            if self.player_room_index.get(player_id) == room_id:
                self.player_room_index.pop(player_id, None)
            room.reset_votes.discard(player_id)
            room.ready_players.discard(player_id)
            room.reset_votes.clear()
            if room.host_player_id == player_id:
                room.host_player_id = next(iter(room.players.keys()), None)

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
                    await self.send_json(other_player.websocket, self._room_payload("ROOM_STATE", room))

        if not room.players:
            self.rooms.pop(room_id, None)
            return

        if remove_player and not room.has_connected_player():
            for remaining_player_id in list(room.players.keys()):
                if self.player_room_index.get(remaining_player_id) == room_id:
                    self.player_room_index.pop(remaining_player_id, None)
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
        if not room.match_started:
            return {
                "error": {
                    "type": "ERROR",
                    "code": "ROOM_NOT_READY",
                    "message": "The room is still in the lobby. Wait for everyone to get ready.",
                },
            }
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
            room = self.rooms.pop(room_id, None)
            if room is None:
                continue

            for player_id in room.players.keys():
                if self.player_room_index.get(player_id) == room_id:
                    self.player_room_index.pop(player_id, None)

    def _is_valid_point(self, point: Any) -> bool:
        if not isinstance(point, list) or len(point) != 2:
            return False
        return all(isinstance(value, int) for value in point)

    def _normalize_room_settings(self, settings: Any) -> Dict[str, Any]:
        # 服务端再次兜底校验，避免客户端绕过前端限制传入非法人数或棋盘尺寸。
        if not isinstance(settings, dict):
            settings = {}

        player_count = settings.get("playerCount", 2)
        grid_size = settings.get("gridSize", 9)
        start_player = settings.get("startPlayer", PLAYER_BLACK)
        turn_timer_enabled = bool(settings.get("turnTimerEnabled", False))
        turn_time_limit_seconds = settings.get("turnTimeLimitSeconds", DEFAULT_TURN_TIMER_SECONDS)

        if player_count not in (2, 3):
            player_count = 2
        if not isinstance(grid_size, int) or grid_size < MIN_GRID_SIZE or grid_size > MAX_GRID_SIZE:
            grid_size = 9
        if not isinstance(turn_time_limit_seconds, int):
            try:
                turn_time_limit_seconds = int(turn_time_limit_seconds)
            except (TypeError, ValueError):
                turn_time_limit_seconds = DEFAULT_TURN_TIMER_SECONDS
        turn_time_limit_seconds = max(
            TURN_TIMER_MIN_SECONDS,
            min(TURN_TIMER_MAX_SECONDS, turn_time_limit_seconds),
        )
        allowed_players = (PLAYER_BLACK, PLAYER_WHITE, PLAYER_PURPLE)[:player_count]
        if start_player not in allowed_players:
            start_player = allowed_players[0]

        return {
            "playerCount": player_count,
            "gridSize": grid_size,
            "startPlayer": start_player,
            "turnTimerEnabled": turn_timer_enabled,
            "turnTimeLimitSeconds": turn_time_limit_seconds,
        }

    def _room_snapshot(self, room: Room) -> Dict[str, Any]:
        return {
            "roomId": room.room_id,
            "settings": dict(room.settings),
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
        # 服务端只保存“设置 + 动作日志”，由前端回放恢复棋盘。
        return {
            "settings": dict(room.settings),
            "phase": self._match_phase(room),
            "actions": [dict(action) for action in room.actions],
        }


app = FastAPI(title="TriAxis Relay Server")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
manager = ConnectionManager()

BASE_DIR = Path(__file__).resolve().parent


def _resolve_frontend_dir() -> Path:
    if (BASE_DIR / "index.html").exists():
        return BASE_DIR

    sibling_dir = BASE_DIR.parent / "web鍓嶇"
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
    init_db()
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


@app.get("/api/health")
async def health_check() -> Dict[str, str]:
    return {"status": "ok"}


@app.post("/api/register", response_model=RegisterResponse, status_code=status.HTTP_201_CREATED)
def register_user(payload: RegisterRequest, db: Session = Depends(get_db)) -> RegisterResponse:
    username = payload.username.strip()
    if not username:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Username cannot be empty.",
        )

    existing_user = db.execute(select(User).where(User.username == username)).scalar_one_or_none()
    if existing_user is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Username already exists.",
        )

    user = User(
        username=username,
        password_hash=hash_password(payload.password),
    )
    db.add(user)

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Username already exists.",
        ) from None

    return RegisterResponse(
        message="User registered successfully.",
        username=user.username,
    )


@app.post("/api/login", response_model=LoginResponse)
def login_user(payload: LoginRequest, db: Session = Depends(get_db)) -> LoginResponse:
    username = payload.username.strip()
    if not username:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Username cannot be empty.",
        )

    user = db.execute(select(User).where(User.username == username)).scalar_one_or_none()
    if user is None or not verify_password(payload.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password.",
        )

    token = create_access_token(user.username)
    return LoginResponse(
        token=token,
        username=user.username,
        token_type="bearer",
        expires_in=JWT_EXPIRE_DAYS * 24 * 60 * 60,
    )


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    token = websocket.query_params.get("token")
    if not token:
        await websocket.close(code=4401, reason="missing_token")
        return

    try:
        username = decode_access_token(token)
    except ValueError as exc:
        logger.warning("websocket auth failed: %s", exc)
        await websocket.close(code=4401, reason="invalid_token")
        return

    await manager.connect(websocket, username=username)

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
