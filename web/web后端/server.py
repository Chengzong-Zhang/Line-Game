import asyncio
import hashlib
import logging
import os
import secrets
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Generator, Optional
from uuid import uuid4

import bcrypt
import jwt
from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect, status
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic_core import PydanticCustomError
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

try:
    from .sensitive_filter import SensitiveFilter, UIStyle  # type: ignore
except ImportError:
    from sensitive_filter import SensitiveFilter, UIStyle

try:
    from .online_bots import BotBridgeUnavailable, evaluate_room
except ImportError:
    from online_bots import BotBridgeUnavailable, evaluate_room

def random_initial_positions(grid_size, player_count, board_shape, previous):
    radius = grid_size - 1
    extent = 2 * radius if board_shape == "hexagon" else radius
    points = [[x, y] for y in range(extent + 1) for x in range(extent + 1)
              if (board_shape == "hexagon" and radius <= x + y <= 3 * radius)
              or (board_shape != "hexagon" and x + y <= radius)]
    def distance(point, other):
        dx, dy = point[0] - other[0], point[1] - other[1]
        return max(abs(dx), abs(dy), abs(dx + dy))
    def draw():
        available, chosen, result = points.copy(), [], {}
        for color in PLAYER_COLORS[:player_count]:
            if chosen:
                scores = [min(distance(point, other) for other in chosen) for point in available]
                best = max(scores)
                candidates = [point for point, score in zip(available, scores) if 4 * score >= 3 * best]
            else:
                candidates = available
            point = candidates[secrets.randbelow(len(candidates))]
            result[color] = point
            chosen.append(point)
            available.remove(point)
        return result
    result = draw()
    for _ in range(8):
        if result != previous:
            break
        result = draw()
    if result == previous:
        result["BLACK"], result["WHITE"] = result["WHITE"], result["BLACK"]
    return result


# 这个服务负责账号、静态资源、房间、连接和动作同步，
# 普通真人房间仍采用转发协议；含 AI 的房间复用 Web GameEngine 校验完整动作历史。
ROOM_SIZE = 15
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
TERRITORY_RULE_V1 = "territory-v1"
TERRITORY_RULE_V2 = "territory-v2"
TERRITORY_RULE_V3 = "territory-v3"
DEFAULT_RULES_VERSION = TERRITORY_RULE_V3
ALLOWED_RULES_VERSIONS = {TERRITORY_RULE_V1, TERRITORY_RULE_V2, TERRITORY_RULE_V3}
CHAT_EMOJI_MAX_CONTENT_LENGTH = 32
CHAT_EMOJI_MIN_DURATION_MS = 300
CHAT_EMOJI_MAX_DURATION_MS = 3000
CHAT_EMOJI_DEFAULT_DURATION_MS = 1200
CHAT_EMOJI_ALLOWED_ANIMATIONS = {"bounce", "fade", "shake"}
PLAYER_BLACK = "BLACK"
PLAYER_WHITE = "WHITE"
PLAYER_PURPLE = "PURPLE"
PLAYER_GREEN = "GREEN"
PLAYER_ORANGE = "ORANGE"
PLAYER_CYAN = "CYAN"
PLAYER_COLORS = ('BLACK', 'WHITE', 'PURPLE', 'GREEN', 'ORANGE', 'CYAN', 'PINK', 'BROWN', 'LIME', 'NAVY', 'GOLD', 'TEAL', 'MAGENTA', 'SLATE', 'CORAL')
JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY", "replace-this-with-a-long-random-secret-key")
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_DAYS = 7
PASSWORD_HASH_PREFIX = "bcrypt_sha256$"
SENSITIVE_FILTER_VERSION = "v2"


def _resolve_bcrypt_rounds() -> int:
    try:
        rounds = int(os.getenv("BCRYPT_ROUNDS", "10"))
    except ValueError:
        rounds = 10
    return max(10, min(14, rounds))


BCRYPT_ROUNDS = _resolve_bcrypt_rounds()


def nickname_block_payload(result) -> Dict[str, str]:
    return {
        "error": result.error,
        "message": result.message,
        "ui_style": result.ui_style.value,
        "offending_word": result.masked_word,
        "suggestion": result.replacement or SensitiveFilter.replacement_name(result.ui_style),
    }


def require_sensitive_filter_ready() -> None:
    if sensitive_filter.word_count > 0:
        return
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail={
            "error": "SENSITIVE_FILTER_NOT_READY",
            "message": "Sensitive nickname filter is not loaded; registration is temporarily disabled.",
            "word_file": str(SENSITIVE_WORDS_FILE),
        },
    )


logger = logging.getLogger("uvicorn.error")
sensitive_filter = SensitiveFilter()


class NicknameValidatedRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    username: str = Field(..., min_length=1, max_length=50)
    ui_style: UIStyle = Field(default=UIStyle.CASUAL)
    auto_correct_username: bool = Field(default=False)
    original_username: Optional[str] = Field(default=None, exclude=True)
    username_corrected: bool = Field(default=False, exclude=True)
    offending_word: Optional[str] = Field(default=None, exclude=True)
    masked_word: Optional[str] = Field(default=None, exclude=True)
    validation_error: Optional[str] = Field(default=None, exclude=True)
    validation_message: Optional[str] = Field(default=None, exclude=True)

    @model_validator(mode="before")
    @classmethod
    def validate_username(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data

        raw_username = str(data.get("username", ""))
        ui_style = data.get("ui_style", UIStyle.CASUAL)
        auto_correct = bool(data.get("auto_correct_username", data.get("auto_correct", False)))
        result = sensitive_filter.validate(raw_username, ui_style=ui_style, auto_correct=auto_correct)

        clean_data = dict(data)
        if result.allowed:
            clean_data["username"] = raw_username.strip()
            clean_data["ui_style"] = result.ui_style
            clean_data["auto_correct_username"] = auto_correct
            clean_data["username_corrected"] = False
            clean_data["original_username"] = None
            clean_data["offending_word"] = None
            clean_data["masked_word"] = None
            clean_data["validation_error"] = None
            clean_data["validation_message"] = None
            return clean_data

        if auto_correct and result.replacement:
            clean_data["username"] = result.replacement
            clean_data["ui_style"] = result.ui_style
            clean_data["auto_correct_username"] = True
            clean_data["username_corrected"] = True
            clean_data["original_username"] = raw_username
            clean_data["offending_word"] = result.offending_word
            clean_data["masked_word"] = result.masked_word
            clean_data["validation_error"] = result.error
            clean_data["validation_message"] = result.corrected_message
            return clean_data

        raise PydanticCustomError("nickname_blocked", result.message, result.error_context())


class RegisterRequest(NicknameValidatedRequest):
    password: str = Field(..., min_length=1, max_length=128)


class NicknameValidationRequest(NicknameValidatedRequest):
    pass


class LoginRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=50)
    password: str = Field(..., min_length=1, max_length=128)


class RegisterResponse(BaseModel):
    message: str
    username: str
    username_corrected: bool = False
    original_username: Optional[str] = None
    validation_error: Optional[str] = None
    validation_message: Optional[str] = None
    offending_word: Optional[str] = None
    suggestion: Optional[str] = None


class NicknameValidationResponse(BaseModel):
    valid: bool
    username: str
    username_corrected: bool = False
    original_username: Optional[str] = None
    error: Optional[str] = None
    message: str
    offending_word: Optional[str] = None
    suggestion: Optional[str] = None


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
    password_hash = bcrypt.hashpw(password_bytes, bcrypt.gensalt(rounds=BCRYPT_ROUNDS))
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
    is_bot: bool = False


@dataclass
class Room:
    room_id: str
    players: Dict[str, PlayerSession] = field(default_factory=dict)
    actions: list[Dict[str, Any]] = field(default_factory=list)
    settings: Dict[str, Any] = field(default_factory=dict)
    host_player_id: Optional[str] = None
    reset_votes: set[str] = field(default_factory=set)
    undo_votes: set[str] = field(default_factory=set)
    undo_target: Optional[int] = None
    undo_used_count: int = 0
    ready_players: set[str] = field(default_factory=set)
    match_started: bool = False
    countdown_started_at: Optional[float] = None
    countdown_task: Optional[asyncio.Task[Any]] = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    action_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    bot_task: Optional[asyncio.Task[Any]] = None
    generation: int = 0
    game_over: bool = False
    bot_error: Optional[str] = None

    def connected_players(self) -> list[PlayerSession]:
        return [player for player in self.players.values() if player.connected and player.websocket is not None]

    def active_player_count(self) -> int:
        return len(self.players)

    def has_connected_player(self) -> bool:
        return any(player.connected and not player.is_bot for player in self.players.values())

    def has_bots(self) -> bool:
        return any(player.is_bot for player in self.players.values())

    def all_humans_connected(self) -> bool:
        humans = [player for player in self.players.values() if not player.is_bot]
        return bool(humans) and all(player.connected and player.websocket is not None for player in humans)

    def player_capacity(self) -> int:
        return int(self.settings.get("playerCount", 2))

    def available_color(self) -> str:
        # Keep color assignment order stable so the frontend can map colors consistently.
        used_colors = {player.color for player in self.players.values()}
        allowed_colors = PLAYER_COLORS[:self.player_capacity()]
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
        pending = []
        for room in self.rooms.values():
            self._cancel_countdown_locked(room)
            if room.bot_task and not room.bot_task.done():
                room.bot_task.cancel()
                pending.append(room.bot_task)
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
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
            if not await self._route_bot_room_action(websocket, "player_move", point):
                await self.forward_move(websocket, point)
            return

        if message_type == "player_skip":
            if not await self._route_bot_room_action(websocket, "player_skip"):
                await self.forward_skip(websocket)
            return

        if message_type == "player_resign":
            if not await self._route_bot_room_action(websocket, "player_resign"):
                await self.forward_resign(websocket)
            return

        if message_type == "retry_bots":
            async with self.lock:
                action = self._prepare_room_member_locked(websocket)
                if action["error"] is None:
                    self._schedule_bots_locked(action["room"])
            return

        if message_type == "player_reset":
            await self.forward_reset(websocket, message.get("reason"))
            return

        if message_type == "player_undo":
            await self.forward_undo(websocket, message.get("accept", True))
            return

        if message_type == "player_ready":
            await self.set_player_ready(websocket, message.get("ready"))
            return

        if message_type == "chat_emoji":
            await self.forward_chat_emoji(websocket, message.get("content"), message.get("metadata"))
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
            self._configure_bots_locked(room)
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
                if candidate.is_bot:
                    await self.send_json(websocket, {
                        "type": "ERROR", "code": "RESERVED_PLAYER_ID",
                        "message": "AI seats cannot be claimed by a user.",
                    })
                    return
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

            # 重连后若全员在线且全员已准备但倒计时被中断，重启倒计时。
            # 必须在构造 direct_payload 之前执行，让重连玩家拿到最新的倒计时状态。
            if (
                reconnected
                and not room.match_started
                and room.active_player_count() >= room.player_capacity()
                and len(room.ready_players) >= room.player_capacity()
                and room.all_humans_connected()
                and room.countdown_started_at is None
            ):
                self._start_countdown_locked(room)

            direct_payload = self._room_payload("ROOM_JOINED", room, your_player_id=session.player_id)
            direct_payload["reconnected"] = reconnected

            broadcast_event = "ROOM_COUNTDOWN" if room.countdown_started_at is not None else "ROOM_STATE"
            broadcast_payloads = self._connected_room_payloads(
                room,
                self._room_payload(broadcast_event, room),
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
        async with self.lock:
            self._schedule_bots_locked(room)

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

    def _configure_bots_locked(self, room: Room) -> None:
        room.players = {key: player for key, player in room.players.items() if not player.is_bot}
        room.ready_players.intersection_update(room.players)
        for index in range(int(room.settings.get("botCount", 0))):
            color = room.available_color()
            player_id = f"@AI:{uuid4().hex}"
            room.players[player_id] = PlayerSession(
                player_id=player_id, color=color, connected=True, is_bot=True,
            )
            room.ready_players.add(player_id)

    def _reset_bot_state_locked(self, room: Room) -> None:
        self._cancel_bot_task_locked(room)
        room.generation += 1
        room.game_over = False
        room.bot_error = None
        room.undo_votes.clear()
        room.undo_target = None
        room.ready_players.update(player.player_id for player in room.players.values() if player.is_bot)

    def _cancel_bot_task_locked(self, room: Room) -> None:
        if room.bot_task is not None and room.bot_task is not asyncio.current_task():
            room.bot_task.cancel()
            room.bot_task = None

    def _schedule_bots_locked(self, room: Room) -> None:
        if not room.has_bots() or not room.match_started or room.game_over or room.undo_target is not None or not room.all_humans_connected():
            return
        if room.bot_task is None or room.bot_task.done():
            room.bot_task = asyncio.create_task(self._run_bot_turns(room))

    def _bot_snapshot_locked(self, room: Room) -> Dict[str, Any]:
        return {
            "settings": dict(room.settings),
            "actions": [dict(action) for action in room.actions],
            "bot_colors": [player.color for player in room.players.values() if player.is_bot],
            "generation": room.generation,
        }

    def _bot_snapshot_current_locked(self, room: Room, snapshot: Dict[str, Any]) -> bool:
        return (
            self.rooms.get(room.room_id) is room
            and room.generation == snapshot["generation"]
            and len(room.actions) == len(snapshot["actions"])
            and room.match_started
            and room.undo_target is None
            and room.all_humans_connected()
        )

    async def _evaluate_bot_snapshot(self, snapshot, action=None):
        # A fresh process always reconstructs accepted history. Retry only worker
        # exits/timeouts, never an invalid configuration or corrupt replay.
        for attempt in range(3):
            try:
                return await evaluate_room(
                    snapshot["settings"], snapshot["actions"], snapshot["bot_colors"], action,
                )
            except (BotBridgeUnavailable, asyncio.TimeoutError):
                if attempt == 2:
                    raise
                await asyncio.sleep(0.2 * (attempt + 1))

    def _commit_bot_action_locked(self, room: Room, action, result, sender_websocket=None):
        actor = next(player for player in room.players.values() if player.color == action["color"])
        recorded = {
            "type": action["type"], "playerId": actor.player_id, "color": actor.color,
        }
        if action["type"] == "player_move":
            recorded["point"] = list(action["point"])
        room.actions.append(recorded)
        room.reset_votes.clear()
        room.updated_at = time.time()
        room.game_over = bool(result["gameOver"])
        room.bot_error = None
        event_type = {
            "player_move": "OPPONENT_MOVE",
            "player_skip": "TURN_SKIPPED",
            "player_resign": "PLAYER_RESIGNED",
        }[action["type"]]
        payload = {
            **recorded, "type": event_type, "roomId": room.room_id,
            "actionIndex": len(room.actions), "isBot": actor.is_bot,
            "aiFallback": bool(result.get("fallback")),
        }
        return [
            (target, payload)
            for target, payload in self._connected_room_payloads(room, payload)
            if action["type"] != "player_move" or target is not sender_websocket
        ]

    async def _reject_bot_action(self, websocket, room, code, message):
        await self.send_json(websocket, {"type": "ERROR", "code": code, "message": message})
        identity = self.websocket_index.get(websocket)
        if self.rooms.get(room.room_id) is room and identity and identity[0] == room.room_id:
            await self.send_json(websocket, self._room_payload("ROOM_STATE", room, your_player_id=identity[1]))

    async def _route_bot_room_action(self, websocket, action_type, point=None) -> bool:
        identity = self.websocket_index.get(websocket)
        room = self.rooms.get(identity[0]) if identity else None
        if room is None or not room.has_bots():
            return False
        async with room.action_lock:
            async with self.lock:
                prepared = self._prepare_room_action_locked(websocket)
                if prepared["error"] is not None:
                    error = prepared["error"]
                    snapshot = None
                elif not room.all_humans_connected():
                    error = {"code": "OPPONENT_OFFLINE", "message": "Waiting for the other human player to reconnect."}
                    snapshot = None
                elif room.undo_target is not None:
                    error = {"code": "UNDO_PENDING", "message": "Resolve the undo vote before playing."}
                    snapshot = None
                else:
                    sender = prepared["sender"]
                    action = {"type": action_type, "color": sender.color}
                    if action_type == "player_move":
                        action["point"] = point
                    snapshot = self._bot_snapshot_locked(room)
                    error = None
            if error:
                await self._reject_bot_action(websocket, room, error["code"], error["message"])
                return True
            try:
                result = await self._evaluate_bot_snapshot(snapshot, action)
            except (BotBridgeUnavailable, asyncio.TimeoutError) as exc:
                await self._reject_bot_action(
                    websocket, room, "AI_UNAVAILABLE",
                    "AI service is temporarily unavailable. Reconnect to retry; the accepted game history is preserved.",
                )
                logger.warning("bot validation unavailable room=%s error=%s", room.room_id, exc)
                return True
            async with self.lock:
                valid = (
                    self._bot_snapshot_current_locked(room, snapshot)
                    and room.undo_target is None
                    and self.websocket_index.get(websocket) == identity
                )
                if valid and result.get("success"):
                    payloads = self._commit_bot_action_locked(room, action, result, websocket)
                else:
                    payloads = None
            if payloads is None:
                await self._reject_bot_action(
                    websocket, room, "ACTION_REJECTED",
                    result.get("reason", "The room changed while the action was being checked."),
                )
                return True
            for target, payload in payloads:
                await self.send_json(target, payload)
        async with self.lock:
            self._schedule_bots_locked(room)
        return True

    async def _run_bot_turns(self, room: Room) -> None:
        try:
            while True:
                async with room.action_lock:
                    async with self.lock:
                        if (
                            self.rooms.get(room.room_id) is not room or not room.match_started
                            or room.game_over or not room.all_humans_connected()
                        ):
                            return
                        snapshot = self._bot_snapshot_locked(room)
                    result = await self._evaluate_bot_snapshot(snapshot)
                    async with self.lock:
                        if not self._bot_snapshot_current_locked(room, snapshot):
                            return
                        if not result.get("success"):
                            room.bot_error = result.get("reason", "AI_INVALID_STATE")
                            payloads = self._connected_room_payloads(room, {
                                "type": "ERROR", "code": "AI_INVALID_STATE",
                                "message": "The AI game history could not be verified. Restart this match.",
                            })
                            finished = True
                        else:
                            room.game_over = bool(result["gameOver"])
                            action = result.get("action")
                            if action is None:
                                return
                            payloads = self._commit_bot_action_locked(room, action, result)
                            finished = room.game_over
                    for target, payload in payloads:
                        await self.send_json(target, payload)
                    if finished:
                        return
                await asyncio.sleep(0.15)
        except (BotBridgeUnavailable, asyncio.TimeoutError) as exc:
            async with self.lock:
                if not self._bot_snapshot_current_locked(room, snapshot):
                    return
                room.bot_error = "AI_UNAVAILABLE"
                payloads = self._connected_room_payloads(room, {
                    "type": "ERROR", "code": "AI_UNAVAILABLE",
                    "message": "AI service is temporarily unavailable. Reconnect to retry; the accepted game history is preserved.",
                })
            logger.warning("bot worker unavailable room=%s error=%s", room.room_id, exc)
            for target, payload in payloads:
                await self.send_json(target, payload)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("bot room task failed room=%s", room.room_id)
        finally:
            if room.bot_task is asyncio.current_task():
                room.bot_task = None

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

            if room.undo_target is not None:
                await self.send_json(websocket, {"type": "ERROR", "code": "UNDO_PENDING", "message": "Resolve the undo vote before playing."})
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

    async def forward_resign(self, websocket: WebSocket) -> None:
        async with self.lock:
            action = self._prepare_room_action_locked(websocket)
            if action["error"] is not None:
                error_payload = action["error"]
                payloads = []
            else:
                room = action["room"]
                sender = action["sender"]
                already_resigned = any(
                    logged_action.get("type") == "player_resign"
                    and logged_action.get("playerId") == sender.player_id
                    for logged_action in room.actions
                )
                if not already_resigned:
                    room.actions.append(
                        {
                            "type": "player_resign",
                            "playerId": sender.player_id,
                            "color": sender.color,
                        }
                    )
                room.reset_votes.clear()
                room.updated_at = time.time()
                payload = {
                    "type": "PLAYER_RESIGNED",
                    "roomId": action["room_id"],
                    "playerId": sender.player_id,
                    "color": sender.color,
                    "serverTimestamp": int(room.updated_at * 1000),
                }
                payloads = self._connected_room_payloads(room, payload)
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
                    if room.settings.get("startingPointMode") == "random":
                        room.settings["initialPositions"] = random_initial_positions(
                            room.settings["gridSize"], room.settings["playerCount"], room.settings["boardShape"],
                            room.settings["initialPositions"])
                    room.actions = []
                    room.undo_used_count = 0
                    room.match_started = False
                    room.ready_players.clear()
                    self._reset_bot_state_locked(room)
                    room.reset_votes.clear()
                    self._cancel_countdown_locked(room)
                    payloads = self._connected_room_payloads_with_identity(
                        room,
                        "MATCH_RESET",
                        reason="normal_restart",
                        extra={
                            "resetPlayerId": action["sender"].player_id,
                            "resetColor": action["sender"].color,
                        },
                    )
                else:
                    if room.settings.get("startingPointMode") == "random":
                        room.settings["initialPositions"] = random_initial_positions(
                            room.settings["gridSize"], room.settings["playerCount"], room.settings["boardShape"],
                            room.settings["initialPositions"])
                    winner = next(
                        (player for player in self._find_other_players(room, action["sender"].player_id)),
                        None,
                    )
                    room.actions = []
                    room.undo_used_count = 0
                    room.match_started = False
                    room.ready_players.clear()
                    self._reset_bot_state_locked(room)
                    room.reset_votes.clear()
                    self._cancel_countdown_locked(room)
                    extra = {
                        "resetPlayerId": action["sender"].player_id,
                        "resetColor": action["sender"].color,
                        "loserPlayerId": action["sender"].player_id,
                        "loserColor": action["sender"].color,
                    }
                    if winner is not None:
                        extra["winnerPlayerId"] = winner.player_id
                        extra["winnerColor"] = winner.color
                    payloads = self._connected_room_payloads_with_identity(
                        room,
                        "MATCH_RESET",
                        reason="resign_restart",
                        extra=extra,
                    )
                error_payload = None

        if error_payload is not None:
            await self.send_json(websocket, error_payload)
            return

        for target_websocket, payload in payloads:
            await self.send_json(target_websocket, payload)

    async def forward_undo(self, websocket: WebSocket, accept: Any) -> None:
        async with self.lock:
            action = self._prepare_room_member_locked(websocket)
            if action["error"] is not None:
                error_payload = action["error"]
                payloads = []
            else:
                room = action["room"]
                sender = action["sender"]
                humans = {player.player_id for player in room.players.values() if not player.is_bot}
                if not room.match_started or not room.settings.get("undoEnabled") or not room.actions:
                    error_payload = {"type": "ERROR", "code": "UNDO_UNAVAILABLE", "message": "Undo is unavailable for this match."}
                    payloads = []
                elif room.undo_used_count >= room.settings.get("undoMaxCount", 3):
                    error_payload = {"type": "ERROR", "code": "UNDO_LIMIT", "message": "The undo limit has been reached."}
                    payloads = []
                elif not room.all_humans_connected():
                    error_payload = {"type": "ERROR", "code": "OPPONENT_OFFLINE", "message": "Wait for every player to reconnect before undoing."}
                    payloads = []
                elif accept is not True and accept is not False:
                    error_payload = {"type": "ERROR", "code": "INVALID_UNDO_VOTE", "message": "Invalid undo vote."}
                    payloads = []
                elif accept is False and room.undo_target is None:
                    error_payload = {"type": "ERROR", "code": "UNDO_NOT_PENDING", "message": "There is no undo request."}
                    payloads = []
                else:
                    error_payload = None
                    if accept is False:
                        room.undo_votes.clear()
                        room.undo_target = None
                        event_type = "UNDO_STATUS"
                    else:
                        if room.undo_target is None:
                            room.undo_target = len(room.actions)
                            self._cancel_bot_task_locked(room)
                            room.generation += 1
                        if room.undo_target != len(room.actions):
                            room.undo_votes.clear()
                            room.undo_target = None
                            error_payload = {"type": "ERROR", "code": "UNDO_STALE", "message": "The match changed. Request undo again."}
                            payloads = []
                        else:
                            room.undo_votes.add(sender.player_id)
                            if humans <= room.undo_votes:
                                room.actions.pop()
                                room.undo_used_count += 1
                                room.undo_votes.clear()
                                room.undo_target = None
                                self._reset_bot_state_locked(room)
                                event_type = "ROOM_UNDO"
                            else:
                                event_type = "UNDO_STATUS"
                    if error_payload is None:
                        room.updated_at = time.time()
                        payloads = self._connected_room_payloads_with_identity(room, event_type)

        if error_payload is not None:
            await self.send_json(websocket, error_payload)
            return
        for target_websocket, payload in payloads:
            await self.send_json(target_websocket, payload)
        if event_type == "ROOM_UNDO" or accept is False:
            async with self.lock:
                self._schedule_bots_locked(room)

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
                    elif len(room.ready_players) >= room.player_capacity() and room.all_humans_connected():
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
                elif room.match_started or room.countdown_started_at is not None:
                    error_payload = {
                        "type": "ERROR",
                        "code": "MATCH_LOCKED",
                        "message": "Room settings cannot be changed after countdown starts.",
                    }
                    payloads = []
                else:
                    normalized_settings = self._normalize_room_settings(settings)
                    allowed_colors = PLAYER_COLORS[: int(normalized_settings["playerCount"])]
                    humans = [player for player in room.players.values() if not player.is_bot]
                    if len(humans) + normalized_settings["botCount"] > int(normalized_settings["playerCount"]) or any(
                        player.color not in allowed_colors for player in humans
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
                        room.undo_used_count = 0
                        room.match_started = False
                        room.ready_players.clear()
                        self._configure_bots_locked(room)
                        self._reset_bot_state_locked(room)
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

    async def forward_chat_emoji(self, websocket: WebSocket, content: Any, metadata: Any) -> None:
        normalized_content = self._normalize_chat_emoji_content(content)
        if normalized_content is None:
            await self.send_json(
                websocket,
                {
                    "type": "ERROR",
                    "code": "INVALID_CHAT_EMOJI",
                    "message": "content must be a non-empty string no longer than 32 characters.",
                },
            )
            return

        normalized_metadata = self._normalize_chat_emoji_metadata(metadata)
        async with self.lock:
            action = self._prepare_room_member_locked(websocket)
            if action["error"] is not None:
                error_payload = action["error"]
                payloads = []
            else:
                payload = {
                    "type": "chat_emoji",
                    "sender": action["sender"].player_id,
                    "content": normalized_content,
                    "color": action["sender"].color,
                    "metadata": normalized_metadata,
                }
                payloads = self._connected_room_payloads(action["room"], payload)
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
                elif room.match_started or room.countdown_started_at is not None:
                    error_payload = {
                        "type": "ERROR",
                        "code": "MATCH_LOCKED",
                        "message": "Start player cannot be changed after countdown starts.",
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
                    self._reset_bot_state_locked(room)
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
                "isBot": player.is_bot,
                "displayName": f"AI {player.color}" if player.is_bot else player.player_id,
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
            "botError": room.bot_error,
            "undo": {
                "usedCount": room.undo_used_count,
                "pending": room.undo_target is not None,
                "votes": list(room.undo_votes),
                "requiredVotes": len([player for player in room.players.values() if not player.is_bot]),
            },
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
        room.updated_at = room.countdown_started_at
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
                if not room.all_humans_connected():
                    self._cancel_countdown_locked(room)
                    return

                room.actions = []
                room.undo_used_count = 0
                self._reset_bot_state_locked(room)
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
        async with self.lock:
            self._schedule_bots_locked(room)

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
        room.generation += 1
        self._cancel_bot_task_locked(room)
        room.updated_at = time.time()
        room.reset_votes.clear()
        room.undo_votes.clear()
        room.undo_target = None
        # 永久离开时才重置 match_started 和 ready 状态；临时断线只取消倒计时。
        if remove_player:
            room.ready_players.discard(player_id)
            room.match_started = False
            self._reset_bot_state_locked(room)
        self._cancel_countdown_locked(room)

        if remove_player:
            room.players.pop(player_id, None)
            if self.player_room_index.get(player_id) == room_id:
                self.player_room_index.pop(player_id, None)
            room.reset_votes.discard(player_id)
            room.reset_votes.clear()
            if room.host_player_id == player_id:
                room.host_player_id = next(
                    (candidate.player_id for candidate in room.players.values() if not candidate.is_bot), None,
                )

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

        if not any(not candidate.is_bot for candidate in room.players.values()):
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
        if room.undo_target is not None:
            return {"error": {"type": "ERROR", "code": "UNDO_PENDING", "message": "Resolve the undo vote before playing."}}
        opponents = [
            player
            for player in self._find_other_players(room, sender_id)
            if player.connected and (player.websocket is not None or player.is_bot)
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

    def _connected_room_payloads_with_identity(
        self,
        room: Room,
        event_type: str,
        reason: Optional[str] = None,
        extra: Optional[Dict[str, Any]] = None,
    ) -> list[tuple[WebSocket, Dict[str, Any]]]:
        payloads = []
        for player in room.connected_players():
            if player.websocket is None:
                continue
            payload = self._room_payload(event_type, room, your_player_id=player.player_id, reason=reason)
            if extra:
                payload.update(extra)
            payloads.append((player.websocket, payload))
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

    def _normalize_chat_emoji_content(self, content: Any) -> Optional[str]:
        if not isinstance(content, str):
            return None
        normalized = content.strip()
        if not normalized or len(normalized) > CHAT_EMOJI_MAX_CONTENT_LENGTH:
            return None
        return normalized

    def _normalize_chat_emoji_metadata(self, metadata: Any) -> Dict[str, Any]:
        if not isinstance(metadata, dict):
            metadata = {}

        animation = metadata.get("animation")
        if animation not in CHAT_EMOJI_ALLOWED_ANIMATIONS:
            animation = "bounce"

        duration = metadata.get("duration", CHAT_EMOJI_DEFAULT_DURATION_MS)
        if not isinstance(duration, (int, float)):
            try:
                duration = int(duration)
            except (TypeError, ValueError):
                duration = CHAT_EMOJI_DEFAULT_DURATION_MS
        duration = int(max(CHAT_EMOJI_MIN_DURATION_MS, min(CHAT_EMOJI_MAX_DURATION_MS, duration)))

        return {
            "animation": animation,
            "duration": duration,
            **self._normalize_chat_emoji_seed(metadata),
            **self._normalize_chat_emoji_display(metadata),
        }

    def _normalize_chat_emoji_seed(self, metadata: Dict[str, Any]) -> Dict[str, str]:
        seed = metadata.get("seed")
        if seed is None:
            return {}
        normalized = str(seed).strip()
        if not normalized:
            return {}
        return {"seed": normalized[:64]}

    def _normalize_chat_emoji_display(self, metadata: Dict[str, Any]) -> Dict[str, Any]:
        display = metadata.get("display")
        if not isinstance(display, dict):
            return {}

        numeric_fields: Dict[str, int] = {}
        limits = {
            "x": (-20, 120),
            "y": (-20, 120),
            "dx": (-120, 120),
            "mx": (-80, 80),
            "dy": (-160, 80),
        }
        for field, (minimum, maximum) in limits.items():
            value = display.get(field)
            if not isinstance(value, (int, float)):
                try:
                    value = int(value)
                except (TypeError, ValueError):
                    return {}
            numeric_fields[field] = int(max(minimum, min(maximum, value)))

        color_class = str(display.get("colorClass", "")).strip()
        if color_class not in {'gold', 'navy', 'pink', 'lime', 'purple', 'brown', 'teal', 'green', 'magenta', 'slate', 'coral', 'red', 'cyan', 'orange', 'blue'}:
            color_class = "blue"

        return {
            "display": {
                **numeric_fields,
                "colorClass": color_class,
            }
        }

    def _normalize_room_settings(self, settings: Any) -> Dict[str, Any]:
        # 服务端再次兜底校验，避免客户端绕过前端限制传入非法人数或棋盘尺寸。
        if not isinstance(settings, dict):
            settings = {}

        player_count = settings.get("playerCount", 2)
        grid_size = settings.get("gridSize", 9)
        start_player = settings.get("startPlayer", PLAYER_BLACK)
        rules_version = settings.get("rulesVersion", DEFAULT_RULES_VERSION)
        bot_count = settings.get("botCount", 0)
        board_shape = settings.get("boardShape")
        starting_mode = settings.get("startingPointMode", "default")
        initial_positions = settings.get("initialPositions")
        undo_enabled = settings.get("undoEnabled") is True
        undo_max_count = settings.get("undoMaxCount", 3)
        turn_timer_enabled = bool(settings.get("turnTimerEnabled", False))
        turn_time_limit_seconds = settings.get("turnTimeLimitSeconds", DEFAULT_TURN_TIMER_SECONDS)

        if type(player_count) is not int or not 2 <= player_count <= 15:
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
        allowed_players = PLAYER_COLORS[:player_count]
        if start_player not in allowed_players:
            start_player = allowed_players[0]
        if not isinstance(rules_version, str) or rules_version not in ALLOWED_RULES_VERSIONS:
            rules_version = DEFAULT_RULES_VERSION
        if type(bot_count) is not int or not 0 <= bot_count < player_count:
            bot_count = 0
        if board_shape not in ("triangle", "hexagon"):
            board_shape = "hexagon" if player_count >= 4 else "triangle"
        if type(undo_max_count) is not int:
            undo_max_count = 3
        undo_max_count = max(1, min(10, undo_max_count))
        starts = {}
        if starting_mode in ("random", "custom") and isinstance(initial_positions, dict):
            radius = grid_size - 1
            used = set()
            valid = set(initial_positions) == set(allowed_players)
            for color in allowed_players:
                point = initial_positions.get(color)
                if not isinstance(point, list) or len(point) != 2 or any(type(axis) is not int for axis in point):
                    valid = False
                    break
                x, y = point
                on_board = (0 <= x <= 2 * radius and 0 <= y <= 2 * radius and radius <= x + y <= 3 * radius) if board_shape == "hexagon" else (x >= 0 and y >= 0 and x + y <= radius)
                if not on_board or (x, y) in used:
                    valid = False
                    break
                used.add((x, y))
            if valid:
                starts = {"startingPointMode": starting_mode, "initialPositions": {color: list(initial_positions[color]) for color in allowed_players}}
        if player_count > 6 and not starts:
            starts = {"startingPointMode": "random", "initialPositions": random_initial_positions(grid_size, player_count, board_shape, None)}
        if bot_count:
            if rules_version == TERRITORY_RULE_V1:
                rules_version = DEFAULT_RULES_VERSION

        return {
            "playerCount": player_count,
            "boardShape": board_shape,
            "gridSize": grid_size,
            "startPlayer": start_player,
            "rulesVersion": rules_version,
            "turnTimerEnabled": turn_timer_enabled,
            "turnTimeLimitSeconds": turn_time_limit_seconds,
            "botCount": bot_count,
            "undoEnabled": undo_enabled,
            "undoMaxCount": undo_max_count,
            **starts,
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
                    "isBot": player.is_bot,
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
try:
    from .training_contributions import create_router as create_training_router
except ImportError:
    from training_contributions import create_router as create_training_router
app.include_router(create_training_router())
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
SENSITIVE_WORDS_FILE = BASE_DIR / "sensitive_words.txt"


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    for error in exc.errors():
        context = error.get("ctx") or {}
        if context.get("sensitive_filter") == "true":
            style = SensitiveFilter.resolve_style(context.get("ui_style", UIStyle.CASUAL.value))
            return JSONResponse(
                status_code=status.HTTP_400_BAD_REQUEST,
                content={
                    "error": context.get("error", "NICKNAME_BLOCKED"),
                    "message": context.get("message", "昵称包含敏感词汇：[***]，换一个试试吧！"),
                    "ui_style": style.value,
                    "offending_word": context.get("masked_word", ""),
                    "suggestion": context.get("suggestion", SensitiveFilter.replacement_name(style)),
                },
            )

    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={"detail": jsonable_encoder(exc.errors())},
    )


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    if isinstance(exc.detail, dict) and "error" in exc.detail and "message" in exc.detail:
        return JSONResponse(status_code=exc.status_code, content=exc.detail, headers=exc.headers)
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail}, headers=exc.headers)


@app.on_event("startup")
async def on_startup() -> None:
    init_db()
    await sensitive_filter.load_from_file(SENSITIVE_WORDS_FILE)
    logger.info("loaded %s sensitive nickname tokens", sensitive_filter.word_count)
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
async def health_check() -> Dict[str, Any]:
    return {
        "status": "ok",
        "sensitiveFilterVersion": SENSITIVE_FILTER_VERSION,
        "sensitiveWordCount": sensitive_filter.word_count,
        "sensitiveFilterReady": sensitive_filter.word_count > 0,
        "sensitiveWordsFile": str(SENSITIVE_WORDS_FILE),
        "sensitiveWordsFileExists": SENSITIVE_WORDS_FILE.exists(),
        "sensitiveWordsMasked": sensitive_filter.masked_words(),
        "bcryptRounds": BCRYPT_ROUNDS,
    }


@app.post("/api/nickname/validate", response_model=NicknameValidationResponse)
def validate_nickname(payload: NicknameValidationRequest) -> NicknameValidationResponse:
    require_sensitive_filter_ready()
    style = SensitiveFilter.resolve_style(payload.ui_style)
    accepted_message = (
        "Identifier accepted."
        if style == UIStyle.ACADEMIC
        else "Nickname accepted."
    )
    return NicknameValidationResponse(
        valid=True,
        username=payload.username,
        username_corrected=payload.username_corrected,
        original_username=payload.original_username,
        error=payload.validation_error,
        message=payload.validation_message or accepted_message,
        offending_word=payload.masked_word,
        suggestion=payload.username if payload.username_corrected else None,
    )


@app.post("/api/register", response_model=RegisterResponse, status_code=status.HTTP_201_CREATED)
def register_user(payload: RegisterRequest, db: Session = Depends(get_db)) -> RegisterResponse:
    require_sensitive_filter_ready()
    username = payload.username.strip()
    if not username:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Username cannot be empty.",
        )

    route_filter_result = sensitive_filter.validate(username, ui_style=payload.ui_style)
    if not route_filter_result.allowed and not payload.username_corrected:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=nickname_block_payload(route_filter_result),
        )

    existing_user = db.execute(select(User).where(User.username == username)).scalar_one_or_none()
    if existing_user is not None:
        if payload.username_corrected:
            for _ in range(10):
                candidate = SensitiveFilter.replacement_name(payload.ui_style)
                existing_candidate = db.execute(select(User).where(User.username == candidate)).scalar_one_or_none()
                if existing_candidate is None:
                    username = candidate
                    break
            else:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Auto-corrected username already exists.",
                )
        else:
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
        message=(
            payload.validation_message or "User registered successfully with an auto-corrected nickname."
            if payload.username_corrected
            else "User registered successfully."
        ),
        username=user.username,
        username_corrected=payload.username_corrected,
        original_username=payload.original_username,
        validation_error=payload.validation_error,
        validation_message=payload.validation_message,
        offending_word=payload.masked_word,
        suggestion=user.username if payload.username_corrected else None,
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
