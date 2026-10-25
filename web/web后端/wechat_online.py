"""Opt-in WeChat identity and durable two-player rooms, separate from legacy /ws.

Run one ASGI worker: room broadcasts are process-local; SQLite still uses CAS to
protect acknowledged actions. No AppSecret, session_key or openid reaches clients.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
from collections import defaultdict, deque
from contextlib import closing, contextmanager
import hashlib
import http.client as http_client
import json
import io
import os
from pathlib import Path
import re
import secrets
import sqlite3
import struct
import subprocess
import time
import unicodedata
import warnings
from typing import Callable
from urllib.parse import urlencode

import jwt
from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import Response

ROOT = Path(__file__).resolve().parents[2]
VALIDATOR = ROOT / "wechat/minigame/tools/validate-action.mjs"
AUDIENCE = "lifeline-wechat-v1"
PROTOCOL = 1
ROOM_TTL = 24 * 60 * 60
TOKEN_TTL = 2 * 60 * 60
LINK_TTL = 5 * 60
MAX_ACTIONS = 3000
MAX_AVATAR_BYTES = 256 * 1024
MAX_AVATAR_SIDE = 512
MAX_AVATAR_DATA_URL = 4 * ((MAX_AVATAR_BYTES + 2) // 3) + 32
SOCKET_IO_TIMEOUT = 2
EMOTE_CAPABILITY = "emote-v1"
FIXED_EMOTES = frozenset(("👏", "😭", "😎", "🤝", "❓", "🤔", "💀", "👎", "😓", "😤"))
STORE_COLUMNS = {
    "wx_users": ["subject", "uid"],
    "wx_rooms": ["code", "revision", "expires", "document"],
    "wx_commands": ["room", "match_id", "command_id", "uid", "hash"],
}
ACCOUNT_COLUMNS = {
    "wx_web_accounts": ["subject", "uid", "display_name"],
    "wx_link_codes": ["digest", "web_subject", "expires", "created"],
}
PROFILE_COLUMNS = {
    "wx_profiles": ["uid", "display_name", "avatar_mime", "avatar_blob", "avatar_hash", "updated"],
}


def fail(code: str, status: int = 400):
    raise HTTPException(status, detail=code)


def canonical(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def validate_display_name(value):
    if not isinstance(value, str):
        fail("INVALID_DISPLAY_NAME", 422)
    # Reject before trimming so invisible controls are not silently accepted.
    if any(unicodedata.category(character) in ("Cc", "Cf", "Cs", "Zl", "Zp") for character in value):
        fail("INVALID_DISPLAY_NAME", 422)
    value = value.strip()
    if not 1 <= len(value) <= 24:
        fail("INVALID_DISPLAY_NAME", 422)
    return value


def decode_avatar(value):
    """Validate pixels and store a fresh metadata-free PNG/JPEG, never raw input."""
    if value is None:
        return None, None, None
    if not isinstance(value, str) or len(value) > MAX_AVATAR_DATA_URL:
        fail("INVALID_AVATAR", 422)
    match = re.fullmatch(r"data:image/(png|jpeg);base64,([A-Za-z0-9+/]*={0,2})", value)
    if not match:
        fail("INVALID_AVATAR", 422)
    try:
        raw = base64.b64decode(match[2], validate=True)
    except (binascii.Error, ValueError):
        fail("INVALID_AVATAR", 422)
    if not raw or len(raw) > MAX_AVATAR_BYTES or base64.b64encode(raw).decode("ascii") != match[2]:
        fail("INVALID_AVATAR", 422)
    expected = "PNG" if match[1] == "png" else "JPEG"
    if (expected == "PNG" and (not raw.startswith(b"\x89PNG\r\n\x1a\n") or not raw.endswith(b"\x00\x00\x00\x00IEND\xaeB`\x82"))
            or expected == "JPEG" and (not raw.startswith(b"\xff\xd8") or not raw.endswith(b"\xff\xd9"))):
        fail("INVALID_AVATAR", 422)
    try:
        from PIL import Image, ImageOps, UnidentifiedImageError
    except ImportError:
        fail("AVATAR_SERVICE_UNAVAILABLE", 503)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as image:
                if (image.format != expected or getattr(image, "n_frames", 1) != 1
                        or not all(1 <= side <= MAX_AVATAR_SIDE for side in image.size)):
                    fail("INVALID_AVATAR", 422)
                image.verify()
            with Image.open(io.BytesIO(raw)) as image:
                image.load()  # verify() alone does not decode JPEG entropy data.
                pixels = ImageOps.exif_transpose(image).convert("RGBA" if expected == "PNG" else "RGB")
                clean = Image.frombytes(pixels.mode, pixels.size, pixels.tobytes())
                output = io.BytesIO()
                clean.save(output, format=expected, **({"quality": 90} if expected == "JPEG" else {}))
                normalized = output.getvalue()
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError, TypeError, IndexError,
            OverflowError, struct.error, Image.DecompressionBombError, Image.DecompressionBombWarning):
        fail("INVALID_AVATAR", 422)
    if len(normalized) > MAX_AVATAR_BYTES:
        fail("INVALID_AVATAR", 422)
    return "image/" + match[1], normalized, hashlib.sha256(normalized).hexdigest()


async def close_socket(socket, code):
    # A stalled transport must not hold an acknowledged action or a reconnect.
    try:
        await asyncio.wait_for(socket.close(code=code), SOCKET_IO_TIMEOUT)
    except Exception:
        pass


async def send_socket(socket, message):
    await asyncio.wait_for(socket.send_json(message), SOCKET_IO_TIMEOUT)


class WechatStore:
    def __init__(self, database):
        self.database = Path(database).resolve()
        if self.database.exists():
            # Reject other applications' databases before changing journal mode
            # or creating tables. Existing empty/corrupt files are not new stores.
            if not self.database.is_file():
                raise ValueError("Expected a dedicated WeChat database file")
            with closing(sqlite3.connect(self.database.as_uri() + "?mode=ro", uri=True, timeout=5)) as db:
                self.validate_schema(db)
        self.database.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            # Recheck before writes if another initializer created the database.
            if db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchone():
                self.validate_schema(db)
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("CREATE TABLE IF NOT EXISTS wx_users (subject TEXT PRIMARY KEY, uid TEXT UNIQUE NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS wx_rooms (code TEXT PRIMARY KEY, revision INTEGER NOT NULL, expires INTEGER NOT NULL, document TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS wx_commands (room TEXT NOT NULL, match_id TEXT NOT NULL, command_id TEXT NOT NULL, uid TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(room, match_id, command_id))")
            # Additive, transactional v1/v2 -> v3 migration. Legacy identity/room
            # rows are never rewritten by startup; failed DDL rolls back.
            db.execute("BEGIN IMMEDIATE")
            self.migrate_accounts(db)

    @staticmethod
    def migrate_accounts(db):
        db.execute("CREATE TABLE IF NOT EXISTS wx_web_accounts (subject TEXT PRIMARY KEY, uid TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL)")
        db.execute("CREATE TABLE IF NOT EXISTS wx_link_codes (digest TEXT PRIMARY KEY, web_subject TEXT NOT NULL, expires INTEGER NOT NULL, created INTEGER NOT NULL)")
        db.execute("CREATE TABLE IF NOT EXISTS wx_profiles (uid TEXT PRIMARY KEY, display_name TEXT, avatar_mime TEXT, avatar_blob BLOB, avatar_hash TEXT, updated INTEGER NOT NULL)")
        db.execute("PRAGMA user_version=3")

    @staticmethod
    def validate_schema(db):
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        base, accounts = set(STORE_COLUMNS), set(STORE_COLUMNS) | set(ACCOUNT_COLUMNS)
        if tables not in (base, accounts, accounts | set(PROFILE_COLUMNS)):
            raise ValueError("Expected the dedicated WeChat database schema")
        version = db.execute("PRAGMA user_version").fetchone()[0]
        if (version not in (0, 1, 2, 3) or (version >= 2) != ("wx_web_accounts" in tables)
                or (version == 3) != ("wx_profiles" in tables)):
            raise ValueError("Unsupported WeChat database version")
        for table, columns in {**STORE_COLUMNS, **ACCOUNT_COLUMNS, **PROFILE_COLUMNS}.items():
            if table not in tables:
                continue
            if [row[1] for row in db.execute(f"PRAGMA table_info({table})")] != columns:
                raise ValueError("Unsupported WeChat database schema")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.database, timeout=5)
        try:
            with db:
                yield db
        finally:
            db.close()

    def identity(self, subject):
        with self.connect() as db:
            db.execute("INSERT OR IGNORE INTO wx_users VALUES (?,?)", (subject, secrets.token_hex(16)))
            return db.execute("SELECT uid FROM wx_users WHERE subject=?", (subject,)).fetchone()[0]

    def subject(self, uid):
        with self.connect() as db:
            row = db.execute("SELECT subject FROM wx_users WHERE uid=?", (uid,)).fetchone()
        return row[0] if row else None

    def exists(self, uid):
        with self.connect() as db:
            return db.execute("SELECT 1 FROM wx_users WHERE uid=? UNION ALL SELECT 1 FROM wx_web_accounts WHERE uid=?", (uid, uid)).fetchone() is not None

    def web_identity(self, subject, display_name):
        with self.connect() as db:
            db.execute("INSERT INTO wx_web_accounts VALUES (?,?,?) ON CONFLICT(subject) DO UPDATE SET display_name=excluded.display_name",
                       (subject, secrets.token_hex(16), display_name))
            return db.execute("SELECT uid FROM wx_web_accounts WHERE subject=?", (subject,)).fetchone()[0]

    def web_uid(self, subject):
        with self.connect() as db:
            row = db.execute("SELECT uid FROM wx_web_accounts WHERE subject=?", (subject,)).fetchone()
        return row[0] if row else None

    def profile(self, uid, provider):
        with self.connect() as db:
            web = db.execute("SELECT display_name FROM wx_web_accounts WHERE uid=?", (uid,)).fetchone()
            wechat = db.execute("SELECT 1 FROM wx_users WHERE uid=?", (uid,)).fetchone()
            custom = db.execute("SELECT display_name,avatar_hash FROM wx_profiles WHERE uid=?", (uid,)).fetchone()
        if not web and not wechat:
            fail("ACCOUNT_DELETED", 401)
        return {"uid": uid, "displayName": custom[0] if custom and custom[0] is not None else web[0] if web else "微信玩家",
                "avatarUrl": f"/api/wechat/account/avatar/{uid}/{custom[1]}" if custom and custom[1] else None, "provider": provider,
                "linkedWeb": bool(web), "linkedWechat": bool(wechat)}

    def update_profile(self, uid, changes, avatar):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute("SELECT 1 FROM wx_users WHERE uid=? UNION ALL SELECT 1 FROM wx_web_accounts WHERE uid=?", (uid, uid)).fetchone():
                fail("ACCOUNT_DELETED", 401)
            old = db.execute("SELECT display_name,avatar_mime,avatar_blob,avatar_hash FROM wx_profiles WHERE uid=?", (uid,)).fetchone()
            name, mime, blob, digest = old or (None, None, None, None)
            if "displayName" in changes:
                name = changes["displayName"]
            if "avatarDataUrl" in changes:
                mime, blob, digest = avatar
            db.execute("INSERT INTO wx_profiles VALUES (?,?,?,?,?,?) ON CONFLICT(uid) DO UPDATE SET display_name=excluded.display_name,avatar_mime=excluded.avatar_mime,avatar_blob=excluded.avatar_blob,avatar_hash=excluded.avatar_hash,updated=excluded.updated",
                       (uid, name, mime, blob, digest, int(time.time())))

    def avatar(self, uid, digest):
        if not re.fullmatch(r"[0-9a-f]{32}", uid) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            fail("AVATAR_NOT_FOUND", 404)
        with self.connect() as db:
            row = db.execute("SELECT avatar_mime,avatar_blob FROM wx_profiles WHERE uid=? AND avatar_hash=?", (uid, digest)).fetchone()
        if not row or row[0] not in ("image/png", "image/jpeg") or not row[1]:
            fail("AVATAR_NOT_FOUND", 404)
        return row

    def issue_link_code(self, web_subject):
        now = int(time.time())
        code = "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(26))
        digest = hashlib.sha256(code.encode()).hexdigest()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM wx_link_codes WHERE expires<=?", (now,))
            if db.execute("SELECT count(*) FROM wx_link_codes WHERE web_subject=? AND created>?", (web_subject, now - 60)).fetchone()[0] >= 5:
                fail("TOO_MANY_REQUESTS", 429)
            if db.execute("SELECT count(*) FROM wx_link_codes").fetchone()[0] >= 5000:
                fail("LINK_CAPACITY", 503)
            db.execute("INSERT INTO wx_link_codes VALUES (?,?,?,?)", (digest, web_subject, now + LINK_TTL, now))
        return {"code": code, "expiresIn": LINK_TTL}

    @staticmethod
    def require_no_active_rooms(db, *uids):
        for (raw,) in db.execute("SELECT document FROM wx_rooms WHERE expires>?", (int(time.time()),)):
            room = json.loads(raw)
            if room["status"] != "closed" and any(uid in room["players"].values() for uid in uids):
                fail("ACCOUNT_IN_ROOM", 409)

    def link(self, uid, code):
        digest = hashlib.sha256(code.encode()).hexdigest()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT web_subject,expires FROM wx_link_codes WHERE digest=?", (digest,)).fetchone()
            if not row or row[1] <= time.time():
                fail("LINK_CODE_INVALID", 400)
            subject = row[0]
            web = db.execute("SELECT uid FROM wx_web_accounts WHERE subject=?", (subject,)).fetchone()
            if not web or not db.execute("SELECT 1 FROM wx_users WHERE uid=?", (uid,)).fetchone():
                fail("ACCOUNT_DELETED", 401)
            old_uid = web[0]
            if old_uid == uid:
                fail("ACCOUNT_ALREADY_LINKED", 409)
            if db.execute("SELECT 1 FROM wx_web_accounts WHERE uid=?", (uid,)).fetchone() or db.execute("SELECT 1 FROM wx_users WHERE uid=?", (old_uid,)).fetchone():
                fail("ACCOUNT_LINK_CONFLICT", 409)
            self.require_no_active_rooms(db, uid, old_uid)
            db.execute("UPDATE wx_web_accounts SET uid=? WHERE subject=?", (uid, subject))
            # The explicitly customized WeChat profile wins as a whole. If it
            # has never been customized, carry the prior Web profile forward.
            db.execute("INSERT OR IGNORE INTO wx_profiles SELECT ?,display_name,avatar_mime,avatar_blob,avatar_hash,updated FROM wx_profiles WHERE uid=?", (uid, old_uid))
            db.execute("DELETE FROM wx_profiles WHERE uid=?", (old_uid,))
            # Retain completed/closed match history and command ownership when
            # the two identities explicitly merge. No moves/hashes are changed.
            for room_code, raw in db.execute("SELECT code,document FROM wx_rooms").fetchall():
                room = json.loads(raw)
                if old_uid in room["players"].values():
                    room["players"] = {player: uid if member == old_uid else member for player, member in room["players"].items()}
                    db.execute("UPDATE wx_rooms SET document=? WHERE code=?", (canonical(room), room_code))
            db.execute("UPDATE wx_commands SET uid=? WHERE uid=?", (uid, old_uid))
            db.execute("DELETE FROM wx_link_codes WHERE web_subject=?", (subject,))
        return old_uid

    def unlink(self, uid):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            self.require_no_active_rooms(db, uid)
            row = db.execute("SELECT subject FROM wx_web_accounts WHERE uid=?", (uid,)).fetchone()
            if not row:
                fail("ACCOUNT_NOT_LINKED", 409)
            db.execute("UPDATE wx_web_accounts SET uid=? WHERE uid=?", (secrets.token_hex(16), uid))
            db.execute("DELETE FROM wx_link_codes WHERE web_subject=?", (row[0],))

    def delete_account(self, uid):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            codes = [code for code, raw in db.execute("SELECT code,document FROM wx_rooms")
                     if uid in json.loads(raw)["players"].values()]
            for code in codes:
                db.execute("DELETE FROM wx_commands WHERE room=?", (code,))
                db.execute("DELETE FROM wx_rooms WHERE code=?", (code,))
            db.execute("DELETE FROM wx_commands WHERE uid=?", (uid,))
            # WeChat deletion never deletes a preexisting password account.
            # Separate it and revoke its old shared-room sessions.
            web = db.execute("SELECT subject FROM wx_web_accounts WHERE uid=?", (uid,)).fetchone()
            if web:
                db.execute("DELETE FROM wx_link_codes WHERE web_subject=?", (web[0],))
                db.execute("UPDATE wx_web_accounts SET uid=? WHERE uid=?", (secrets.token_hex(16), uid))
            db.execute("DELETE FROM wx_users WHERE uid=?", (uid,))
            db.execute("DELETE FROM wx_profiles WHERE uid=?", (uid,))
        return codes

    def room(self, code):
        if not isinstance(code, str) or not re.fullmatch(r"[A-Z2-9]{8}", code):
            fail("ROOM_NOT_FOUND", 404)
        with self.connect() as db:
            row = db.execute("SELECT document,expires FROM wx_rooms WHERE code=?", (code,)).fetchone()
        if not row:
            fail("ROOM_NOT_FOUND", 404)
        if row[1] <= time.time():
            fail("ROOM_EXPIRED", 410)
        return json.loads(row[0])

    def active_room(self, uid):
        with self.connect() as db:
            # The bounded table is deliberately simple; no production account DB migration.
            rows = db.execute("SELECT document FROM wx_rooms WHERE expires>?", (int(time.time()),)).fetchall()
        for (raw,) in rows:
            room = json.loads(raw)
            if uid in room["players"].values() and room["status"] != "closed":
                return room
        return None

    def create(self, room):
        now = int(time.time())
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM wx_commands WHERE room IN (SELECT code FROM wx_rooms WHERE expires<=?)", (now,))
            db.execute("DELETE FROM wx_rooms WHERE expires<=?", (now,))
            if db.execute("SELECT count(*) FROM wx_rooms").fetchone()[0] >= 1000:
                fail("ROOM_CAPACITY", 503)
            db.execute("INSERT INTO wx_rooms VALUES (?,?,?,?)", (room["code"], room["revision"], room["expiresAt"], canonical(room)))

    def command(self, room, match_id, command_id):
        with self.connect() as db:
            return db.execute("SELECT uid,hash FROM wx_commands WHERE room=? AND match_id=? AND command_id=?", (room, match_id, command_id)).fetchone()

    def commit(self, room, previous_revision, command=None):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            changed = db.execute("UPDATE wx_rooms SET revision=?,expires=?,document=? WHERE code=? AND revision=?",
                                 (room["revision"], room["expiresAt"], canonical(room), room["code"], previous_revision)).rowcount
            if changed != 1:
                fail("STALE_ROOM", 409)
            if command:
                db.execute("INSERT INTO wx_commands VALUES (?,?,?,?,?)", command)


    def commit_room_switch(self, previous, previous_revision, destination, destination_revision):
        # Closing the unused room and accepting its owner into the destination
        # must commit together. A stale CAS or failed second write rolls back both.
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            for room, revision in ((previous, previous_revision), (destination, destination_revision)):
                changed = db.execute("UPDATE wx_rooms SET revision=?,expires=?,document=? WHERE code=? AND revision=?",
                                     (room["revision"], room["expiresAt"], canonical(room), room["code"], revision)).rowcount
                if changed != 1:
                    fail("STALE_ROOM", 409)


async def exchange_wechat(code, app_id, secret):
    # A fixed TLS destination with no redirects and no URL logging. Generic
    # HTTP request logs must never contain the AppSecret or one-time code.
    def fetch():
        connection = http_client.HTTPSConnection("api.weixin.qq.com", timeout=8)
        try:
            query = urlencode({"appid": app_id, "secret": secret, "js_code": code, "grant_type": "authorization_code"})
            connection.request("GET", "/sns/jscode2session?" + query)
            response = connection.getresponse()
            raw = response.read(8193)
            if response.status != 200 or len(raw) > 8192:
                raise ValueError("Bad upstream response")
            return json.loads(raw)
        finally:
            connection.close()
    try:
        data = await asyncio.to_thread(fetch)
    except (OSError, http_client.HTTPException, ValueError):
        fail("WECHAT_UNAVAILABLE", 503)
    if not isinstance(data, dict) or data.get("errcode") or not isinstance(data.get("openid"), str) or not 1 <= len(data["openid"]) <= 128:
        fail("LOGIN_FAILED", 401)
    return data["openid"]  # Intentionally discard session_key/unionid.


def verify_rules(settings, actions, action=None):
    payload = {"settings": settings, "actions": actions}
    if action is not None:
        payload["action"] = action
    try:
        process = subprocess.run([os.getenv("LIFELINE_NODE", "node"), str(VALIDATOR)],
                                 input=canonical(payload).encode(), capture_output=True, timeout=15, check=False,
                                 creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.TimeoutExpired):
        fail("RULE_SERVICE_UNAVAILABLE", 503)
    if process.returncode:
        fail("INVALID_ACTION", 422)
    try:
        return json.loads(process.stdout)
    except ValueError:
        fail("RULE_SERVICE_UNAVAILABLE", 503)


class WechatService:
    def __init__(self, store, app_id, app_secret, token_secret, *, exchange: Callable = exchange_wechat, verifier=verify_rules):
        if not app_id or not app_secret or len(token_secret) < 32:
            raise ValueError("WeChat credentials and a dedicated 32+ character JWT secret are required")
        self.store = store
        self.app_id, self.app_secret, self.token_secret = app_id, app_secret, token_secret
        self.exchange, self.verifier = exchange, verifier
        self.connections = defaultdict(dict)
        self.emote_sockets = set()
        self.mutation_lock = asyncio.Lock()
        self.arrivals = {}

    def rate(self, key, limit=90):
        now = time.monotonic()
        if len(self.arrivals) >= 4096:
            self.arrivals = {k: q for k, q in self.arrivals.items() if q and q[-1] > now - 60}
            if len(self.arrivals) >= 4096 and key not in self.arrivals:
                fail("TOO_MANY_REQUESTS", 429)
        q = self.arrivals.setdefault(key, deque())
        while q and q[0] <= now - 60:
            q.popleft()
        if len(q) >= limit:
            fail("TOO_MANY_REQUESTS", 429)
        q.append(now)

    async def login(self, code):
        if not isinstance(code, str) or not 1 <= len(code) <= 256:
            fail("INVALID_CODE", 422)
        openid = await self.exchange(code, self.app_id, self.app_secret)
        # OpenIDs have platform-assigned entropy; hash them before persistence.
        # Keep identity stable when the signing secret is rotated.
        subject = hashlib.sha256(f"{self.app_id}:{openid}".encode()).hexdigest()
        uid = self.store.identity(subject)
        return self.session(uid, "wechat", subject)

    def session(self, uid, provider, identity):
        now = int(time.time())
        token = jwt.encode({"sub": uid, "provider": provider, "identity": identity, "aud": AUDIENCE, "iss": self.app_id,
                            "iat": now, "exp": now + TOKEN_TTL}, self.token_secret, algorithm="HS256")
        return {"token": token, "expiresIn": TOKEN_TTL, "protocol": PROTOCOL, "account": self.store.profile(uid, provider)}

    def web_login(self, account):
        subject = hashlib.sha256(f"web:{account['subject']}".encode()).hexdigest()
        uid = self.store.web_identity(subject, account["displayName"])
        return self.session(uid, "web", subject)

    def authenticate(self, token, *, allow_deleted=False):
        try:
            claims = jwt.decode(token, self.token_secret, algorithms=["HS256"], audience=AUDIENCE, issuer=self.app_id,
                                options={"require": ["sub", "aud", "iss", "iat", "exp"]})
            if not isinstance(claims["sub"], str) or not re.fullmatch(r"[0-9a-f]{32}", claims["sub"]):
                raise ValueError()
        except (jwt.PyJWTError, ValueError, TypeError):
            fail("UNAUTHORIZED", 401)
        provider = claims.get("provider", "wechat")  # v1 tokens remain valid until expiry.
        if provider not in ("wechat", "web"):
            fail("UNAUTHORIZED", 401)
        if ("identity" in claims and (not isinstance(claims["identity"], str)
                                     or not re.fullmatch(r"[0-9a-f]{64}", claims["identity"]))):
            fail("UNAUTHORIZED", 401)
        if provider == "web":
            if self.store.web_uid(claims.get("identity")) != claims["sub"]:
                fail("ACCOUNT_SESSION_CHANGED", 401)
        elif not allow_deleted:
            subject = self.store.subject(claims["sub"])
            if subject is None:
                fail("ACCOUNT_DELETED", 401)
            if claims.get("identity", subject) != subject:
                fail("UNAUTHORIZED", 401)
        claims["provider"] = provider
        return claims

    async def close_identity_connections(self, uid):
        for room_code, members in list(self.connections.items()):
            socket = members.pop(uid, None)
            if socket is not None:
                await close_socket(socket, 4008)
            if not members:
                self.connections.pop(room_code, None)

    async def link_account(self, token, code):
        claims = self.authenticate(token)
        if claims["provider"] != "wechat":
            fail("WECHAT_IDENTITY_REQUIRED", 403)
        self.rate(f"link:{claims['sub']}", 10)
        if not isinstance(code, str) or not re.fullmatch(r"[A-HJ-NP-Z2-9]{26}", code):
            fail("LINK_CODE_INVALID", 400)
        async with self.mutation_lock:
            claims = self.authenticate(token)
            old_uid = self.store.link(claims["sub"], code)
            result = self.session(claims["sub"], "wechat", self.store.subject(claims["sub"]))
        await self.close_identity_connections(old_uid)
        return result

    async def unlink_account(self, token, code):
        claims = self.authenticate(token)
        if claims["provider"] != "wechat":
            fail("WECHAT_IDENTITY_REQUIRED", 403)
        self.rate(f"unlink:{claims['sub']}", 5)
        if not isinstance(code, str) or not 1 <= len(code) <= 256:
            fail("INVALID_CODE", 422)
        openid = await self.exchange(code, self.app_id, self.app_secret)
        subject = hashlib.sha256(f"{self.app_id}:{openid}".encode()).hexdigest()
        async with self.mutation_lock:
            claims = self.authenticate(token)
            if subject != self.store.subject(claims["sub"]):
                fail("IDENTITY_MISMATCH", 403)
            self.store.unlink(claims["sub"])
            result = self.session(claims["sub"], "wechat", subject)
        # Account state may have been displayed through a former Web session.
        await self.close_identity_connections(claims["sub"])
        return result

    async def delete_account(self, uid, code, expected_subject=None):
        self.rate(f"deletion:{uid}", 5)
        if not isinstance(code, str) or not 1 <= len(code) <= 256:
            fail("INVALID_CODE", 422)
        # A fresh login code binds the destructive operation to the same person.
        openid = await self.exchange(code, self.app_id, self.app_secret)
        subject = hashlib.sha256(f"{self.app_id}:{openid}".encode()).hexdigest()
        if expected_subject is not None and expected_subject != subject:
            fail("IDENTITY_MISMATCH", 403)
        async with self.mutation_lock:
            existing = self.store.subject(uid)
            if existing is not None and existing != subject:
                fail("IDENTITY_MISMATCH", 403)
            codes = self.store.delete_account(uid)
        # All room members lose the removed room, while the other account remains.
        affected_codes = set(codes) | {room_code for room_code, members in self.connections.items() if uid in members}
        for room_code in affected_codes:
            connections = self.connections.pop(room_code, {})
            for member, socket in connections.items():
                await close_socket(socket, 4008 if member == uid else 4010)
        return {"protocol": PROTOCOL, "deleted": True, "roomsDeleted": len(codes)}

    @staticmethod
    def player(room, uid):
        for player, member in room["players"].items():
            if member == uid:
                return player
        fail("NOT_ROOM_MEMBER", 403)

    def view(self, room, uid):
        color = self.player(room, uid)
        profiles = {}
        for player, member in room["players"].items():
            if member is None:
                profiles[player] = None
            else:
                profile = self.store.profile(member, "wechat")
                profiles[player] = {key: profile[key] for key in ("uid", "displayName", "avatarUrl")}
        return {**{k: room[k] for k in ("code", "matchId", "revision", "seq", "status", "settings", "actions", "actionIds", "ready", "rematchVotes", "expiresAt")},
                **room["state"], "protocol": PROTOCOL, "player": color,
                "undo": room.get("undo", {"usedCount": 0, "pending": False, "votes": []}),
                "playerProfiles": profiles,
                "members": {p: member is not None for p, member in room["players"].items()}}

    @staticmethod
    def room_settings(body, *, rules_default="territory-v2"):
        if not isinstance(body, dict) or set(body) - {"gridSize", "boardShape", "startingPointMode", "initialPositions", "undoEnabled", "undoMaxCount", "rulesVersion", "playerCount", "startPlayer", "botCount", "turnTimerEnabled", "turnTimeLimitSeconds", "hintEnabled", "hintMaxCount"}:
            fail("INVALID_SETTINGS", 422)
        size = body.get("gridSize", 7)
        shape = body.get("boardShape", "triangle")
        mode = body.get("startingPointMode", "default")
        enabled = body.get("undoEnabled", False)
        count = body.get("undoMaxCount", 3)
        rules = body.get("rulesVersion", rules_default)
        first = body.get("startPlayer", "BLACK")
        hint = body.get("hintEnabled", False)
        hints = body.get("hintMaxCount", 3 if hint else 0)
        seconds = body.get("turnTimeLimitSeconds", 60)
        if (type(size) is not int or not 5 <= size <= 15 or shape not in ("triangle", "hexagon")
                or mode not in ("default", "random", "custom") or type(enabled) is not bool
                or type(count) is not int or not 1 <= count <= 10
                or rules not in ("territory-v2", "territory-v3") or first not in ("BLACK", "WHITE")
                or type(body.get("playerCount", 2)) is not int or body.get("playerCount", 2) != 2
                or type(body.get("botCount", 0)) is not int or body.get("botCount", 0) != 0
                or body.get("turnTimerEnabled", False) is not False
                or type(seconds) is not int or not 15 <= seconds <= 200
                or type(hint) is not bool or type(hints) is not int or not (1 if hint else 0) <= hints <= 10):
            fail("INVALID_SETTINGS", 422)
        positions = body.get("initialPositions")
        if (mode == "default" and positions is not None) or (mode != "default" and not isinstance(positions, dict)):
            fail("INVALID_SETTINGS", 422)
        settings = {"gridSize": size, "playerCount": 2, "startPlayer": first, "rulesVersion": rules,
                    "turnTimerEnabled": False, "turnTimeLimitSeconds": seconds, "hintEnabled": hint, "hintMaxCount": hints,
                    "boardShape": shape, "undoEnabled": enabled, "undoMaxCount": count}
        if mode != "default":
            settings.update(startingPointMode=mode, initialPositions=positions)
        return settings

    async def broadcast(self, room):
        async def send(uid, socket):
            try:
                await send_socket(socket, {"type": "room", "room": self.view(room, uid)})
            except Exception:
                members = self.connections.get(room["code"], {})
                if members.get(uid) is socket:
                    members.pop(uid, None)
                    if not members:
                        self.connections.pop(room["code"], None)
                await close_socket(socket, 1011)
        await asyncio.gather(*(send(uid, ws) for uid, ws in list(self.connections.get(room["code"], {}).items())))

    async def emote(self, uid, code, socket, message):
        # Transient social signals never mutate room documents or action hashes.
        if socket not in self.emote_sockets or self.connections.get(code, {}).get(uid) is not socket:
            fail("EMOTES_UNAVAILABLE", 409)
        self.rate(f"emote-packet:{uid}", 30)
        if (not isinstance(message, dict) or set(message) != {"type", "emoji", "matchId"}
                or message.get("type") != "emote" or not isinstance(message.get("emoji"), str)
                or message["emoji"] not in FIXED_EMOTES):
            fail("INVALID_EMOTE", 422)
        room = self.store.room(code)
        player = self.player(room, uid)
        if room["status"] == "closed" or message.get("matchId") != room["matchId"]:
            fail("EMOTES_UNAVAILABLE", 409)
        recent = self.arrivals.get(f"emote:{uid}")
        if recent and time.monotonic() - recent[-1] < 1:
            fail("EMOTE_RATE_LIMIT", 429)
        self.rate(f"emote:{uid}", 20)
        payload = {"type": "emote", "emote": {"id": secrets.token_hex(8), "emoji": message["emoji"],
                   "player": player, "matchId": room["matchId"]}}

        async def send(member, peer):
            try:
                await send_socket(peer, payload)
            except Exception:
                members = self.connections.get(code, {})
                if members.get(member) is peer:
                    members.pop(member, None)
                    if not members:
                        self.connections.pop(code, None)
                self.emote_sockets.discard(peer)
                await close_socket(peer, 1011)
        await asyncio.gather(*(send(member, peer) for member, peer in list(self.connections.get(code, {}).items())
                               if peer in self.emote_sockets and member in room["players"].values()))

    async def mutate(self, uid, operation, body, code=None, *, auth_token=None):
        self.rate(f"mutation:{uid}", 90)
        try:
            await asyncio.wait_for(self.mutation_lock.acquire(), 3)
        except asyncio.TimeoutError:
            fail("ROOM_BUSY", 503)
        try:
            if auth_token is not None and self.authenticate(auth_token)["sub"] != uid:
                fail("UNAUTHORIZED", 401)
            replaced_rooms = []
            result = await self._mutate(uid, operation, body, code, replaced_rooms=replaced_rooms)
        finally:
            self.mutation_lock.release()
        for previous in replaced_rooms:
            await self.broadcast(previous)
        await self.broadcast(result)
        return self.view(result, uid)

    async def _mutate(self, uid, operation, body, code, *, replaced_rooms=None):
        # An HTTP request may have authenticated before a queued deletion acquired
        # the mutation lock. Never let it recreate a room for a removed identity.
        if not self.store.exists(uid):
            fail("ACCOUNT_DELETED", 401)
        if operation == "create":
            current = self.store.active_room(uid)
            if current:
                return current
            settings = self.room_settings(body)
            state = await asyncio.to_thread(self.verifier, settings, [])
            room = {"code": "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(8)),
                    "matchId": secrets.token_hex(16), "revision": 1, "seq": 0, "settings": settings,
                    "status": "waiting", "players": {"BLACK": uid, "WHITE": None}, "actions": [], "actionIds": [],
                    "ready": {"BLACK": False, "WHITE": False}, "rematchVotes": {"BLACK": False, "WHITE": False},
                    "undo": {"usedCount": 0, "pending": False, "votes": []},
                    "state": state, "expiresAt": int(time.time()) + ROOM_TTL}
            self.store.create(room)
            return room
        room = self.store.room(code)
        revision = room["revision"]
        if room["status"] == "closed":
            fail("ROOM_CLOSED", 410)
        command = None
        abandoned = None
        if operation == "join":
            if uid in room["players"].values():
                return room
            if room["players"]["WHITE"] is not None or room["status"] != "waiting":
                fail("ROOM_FULL", 409)
            current = self.store.active_room(uid)
            if current:
                # A prior "create room" tap must not trap its sole owner.
                # Preserve every room that has another player or progress.
                if not (current["status"] == "waiting"
                        and [member for member in current["players"].values() if member is not None] == [uid]
                        and current["seq"] == 0 and not current["actions"] and not current["actionIds"]
                        and all(value is False for player, value in current["ready"].items()
                                if current["players"].get(player) != uid)
                        and all(value is False for value in current["rematchVotes"].values())):
                    fail("ALREADY_IN_ROOM", 409)
                abandoned = (current, current["revision"])
                current["status"] = "closed"
                current["revision"] += 1
            room["players"]["WHITE"] = uid
        else:
            player = self.player(room, uid)
            if body.get("matchId") != room["matchId"]:
                fail("STALE_MATCH", 409)
            if operation == "ready":
                if room["status"] != "waiting":
                    return room
                room["ready"][player] = True
                if all(room["ready"].values()) and all(room["players"].values()):
                    room["status"] = "playing"
            elif operation == "settings":
                if player != "BLACK" or room["status"] != "waiting" or room["seq"] or any(room["ready"].values()):
                    fail("SETTINGS_LOCKED", 409)
                settings = self.room_settings(body.get("settings"), rules_default=room["settings"]["rulesVersion"])
                if settings["rulesVersion"] != room["settings"]["rulesVersion"]:
                    fail("RULES_CHANGE_REQUIRES_NEW_ROOM", 409)
                room["state"] = await asyncio.to_thread(self.verifier, settings, [])
                room["settings"] = settings
            elif operation == "rematch":
                if room["status"] != "finished":
                    fail("MATCH_NOT_FINISHED", 409)
                room["rematchVotes"][player] = True
                if all(room["rematchVotes"].values()):
                    room.update(matchId=secrets.token_hex(16), seq=0, actions=[], actionIds=[], status="waiting",
                                ready={"BLACK": False, "WHITE": False}, rematchVotes={"BLACK": False, "WHITE": False},
                                undo={"usedCount": 0, "pending": False, "votes": []},
                                state=await asyncio.to_thread(self.verifier, room["settings"], []))
            elif operation == "undo":
                undo = room.setdefault("undo", {"usedCount": 0, "pending": False, "votes": []})
                if (not room["settings"].get("undoEnabled") or room["status"] not in ("playing", "finished")
                        or not room["actions"] or undo["usedCount"] >= room["settings"].get("undoMaxCount", 3)):
                    fail("UNDO_UNAVAILABLE", 409)
                if (type(body.get("accept")) is not bool or type(body.get("expectedSeq")) is not int
                        or body["expectedSeq"] != room["seq"] or body.get("beforeHash") != room["state"]["stateHash"]):
                    fail("STALE_POSITION", 409)
                if body["accept"] is False:
                    if not undo["pending"]:
                        fail("UNDO_NOT_PENDING", 409)
                    undo.update(pending=False, votes=[])
                else:
                    undo["pending"] = True
                    if player not in undo["votes"]:
                        undo["votes"].append(player)
                    if all(seat in undo["votes"] for seat in ("BLACK", "WHITE")):
                        remaining = room["actions"][:-1]
                        state = await asyncio.to_thread(self.verifier, room["settings"], remaining)
                        room["actions"] = remaining
                        room["actionIds"].pop()
                        room["seq"] -= 1
                        room["state"] = state
                        room["status"] = "playing"
                        undo.update(usedCount=undo["usedCount"] + 1, pending=False, votes=[])
            elif operation == "leave":
                room["status"] = "closed"
            elif operation == "actions":
                command_id = body.get("clientActionId")
                if not isinstance(command_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{16,80}", command_id):
                    fail("INVALID_COMMAND_ID", 422)
                digest = hashlib.sha256(canonical(body).encode()).hexdigest()
                old = self.store.command(code, room["matchId"], command_id)
                if old:
                    if old != (uid, digest):
                        fail("COMMAND_ID_REUSED", 409)
                    return room
                if room["status"] != "playing" or room["state"]["gameOver"]:
                    fail("MATCH_NOT_PLAYING", 409)
                if room.get("undo", {}).get("pending"):
                    fail("UNDO_PENDING", 409)
                if type(body.get("expectedSeq")) is not int or body["expectedSeq"] != room["seq"] or body.get("beforeHash") != room["state"]["stateHash"]:
                    fail("STALE_POSITION", 409)
                if room["state"]["currentPlayer"] != player:
                    fail("NOT_YOUR_TURN", 409)
                action = body.get("action")
                if not isinstance(action, dict) or action.get("type") not in ("move", "skip", "resign") or set(action) - {"type", "point"}:
                    fail("INVALID_ACTION", 422)
                if action["type"] == "move":
                    point = action.get("point")
                    if not isinstance(point, list) or len(point) != 2 or any(type(p) is not int for p in point):
                        fail("INVALID_ACTION", 422)
                elif "point" in action:
                    fail("INVALID_ACTION", 422)
                if len(room["actions"]) >= MAX_ACTIONS:
                    fail("MATCH_LIMIT", 409)
                normalized = {**action, "player": player}
                state = await asyncio.to_thread(self.verifier, room["settings"], room["actions"], normalized)
                room["actions"].append(normalized)
                room["actionIds"].append(command_id)
                room["seq"] += 1
                room["state"] = state
                if state["gameOver"]:
                    room["status"] = "finished"
                command = (code, room["matchId"], command_id, uid, digest)
            else:
                fail("UNKNOWN_OPERATION", 404)
        room["revision"] += 1
        room["expiresAt"] = int(time.time()) + ROOM_TTL
        if abandoned:
            previous, previous_revision = abandoned
            self.store.commit_room_switch(previous, previous_revision, room, revision)
            if replaced_rooms is not None:
                replaced_rooms.append(previous)
        else:
            self.store.commit(room, revision, command)
        return room


def create_router(service=None, *, web_authenticate=None, web_password_authenticate=None,
                  web_auth_mode="legacy-jwt"):
    if web_auth_mode not in ("legacy-jwt", "password"):
        raise ValueError("Unsupported Web authentication mode")
    if web_auth_mode == "password":
        # A public/default legacy signing key is never a proof of identity.
        web_authenticate = None
    else:
        web_password_authenticate = None
    router = APIRouter(prefix="/api/wechat")
    password_slots = asyncio.Semaphore(4)
    profile_slots = asyncio.Semaphore(4)

    def get_service():
        nonlocal service
        if service is None:
            settings = [os.getenv(k, "").strip() for k in ("WECHAT_APP_ID", "WECHAT_APP_SECRET", "WECHAT_JWT_SECRET", "WECHAT_DB_PATH")]
            if (os.getenv("WECHAT_ONLINE_ENABLED") != "1" or not all(settings) or len(settings[2]) < 32
                    or not Path(settings[3]).is_absolute()):
                fail("ONLINE_NOT_CONFIGURED", 503)
            try:
                store = WechatStore(settings[3])
            except (OSError, ValueError, sqlite3.DatabaseError):
                # Public status/login must not expose operator paths or database
                # details, and invalid configuration must never initialize them.
                fail("ONLINE_NOT_CONFIGURED", 503)
            service = WechatService(store, *settings[:3])
        return service

    async def body(request, limit=8192):
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > limit:
                fail("REQUEST_TOO_LARGE", 413)
        try:
            def invalid_constant(value):
                raise ValueError(value)
            data = json.loads(raw, parse_constant=invalid_constant)
        except (ValueError, UnicodeDecodeError):
            fail("INVALID_JSON", 422)
        if not isinstance(data, dict):
            fail("INVALID_JSON", 422)
        return data

    def bearer(request):
        auth = request.headers.get("authorization", "")
        if not auth.startswith("Bearer ") or not 1 <= len(auth[7:]) <= 4096:
            fail("UNAUTHORIZED", 401)
        return auth[7:]

    def identity(request, svc):
        uid = svc.authenticate(bearer(request))["sub"]
        svc.rate(f"http:{uid}", 180)
        return uid

    async def web_account(request, svc):
        svc.rate(f"web-login:{request.client.host if request.client else 'unknown'}", 20)
        if web_authenticate is None:
            fail("WEB_LOGIN_NOT_CONFIGURED", 503)
        try:
            account = await asyncio.to_thread(web_authenticate, bearer(request))
        except (ValueError, jwt.PyJWTError):
            fail("UNAUTHORIZED", 401)
        return valid_web_account(account)

    def valid_web_account(account):
        if (not isinstance(account, dict) or not isinstance(account.get("subject"), str)
                or not 1 <= len(account["subject"]) <= 128 or not isinstance(account.get("displayName"), str)
                or not 1 <= len(account["displayName"]) <= 50):
            fail("UNAUTHORIZED", 401)
        return account

    @router.get("/status")
    async def status():
        try:
            get_service()
            return {"enabled": True, "protocol": PROTOCOL, "rulesVersion": "territory-v3",
                    "supportedRulesVersions": ["territory-v2", "territory-v3"],
                    "roomSettings": True, "undoVoting": True,
                    "accounts": True, "webLogin": web_authenticate is not None or web_password_authenticate is not None,
                    "accountProfile": True,
                    "accountLinking": web_authenticate is not None or web_password_authenticate is not None,
                    "webAuthMode": web_auth_mode,
                    "passwordLogin": web_auth_mode == "password" and web_password_authenticate is not None}
        except HTTPException:
            return {"enabled": False, "protocol": PROTOCOL}

    @router.post("/login")
    async def login(request: Request):
        svc = get_service()
        svc.rate(f"login:{request.client.host if request.client else 'unknown'}", 20)
        return await svc.login((await body(request)).get("code"))

    @router.post("/login/web")
    async def login_web(request: Request):
        svc = get_service()
        return svc.web_login(await web_account(request, svc))

    @router.post("/login/password-session")
    async def password_session(request: Request):
        if web_auth_mode != "password" or web_password_authenticate is None:
            fail("WEB_LOGIN_NOT_CONFIGURED", 503)
        svc = get_service()
        svc.rate("password-global", 60)
        svc.rate(f"password-ip:{request.client.host if request.client else 'unknown'}", 10)
        data = await body(request)
        if (set(data) != {"username", "password"} or not isinstance(data["username"], str)
                or not 1 <= len(data["username"]) <= 50 or not data["username"].strip()
                or not isinstance(data["password"], str) or not 1 <= len(data["password"]) <= 128):
            fail("INVALID_REQUEST", 422)
        username = data["username"].strip()
        try:
            username_key = hashlib.sha256(username.encode("utf-8")).hexdigest()
            data["password"].encode("utf-8")
        except UnicodeError:
            fail("INVALID_REQUEST", 422)
        svc.rate(f"password-account:{username_key}", 10)
        if password_slots.locked():
            fail("TOO_MANY_REQUESTS", 429)
        await password_slots.acquire()
        verification = asyncio.create_task(asyncio.to_thread(web_password_authenticate, username, data["password"]))

        def release_slot(task):
            password_slots.release()
            if not task.cancelled():
                task.exception()  # Also retrieve errors if the HTTP waiter left.

        verification.add_done_callback(release_slot)
        try:
            # Disconnect/cancellation cannot free a slot while bcrypt still runs.
            account = await asyncio.shield(verification)
        except ValueError:
            fail("UNAUTHORIZED", 401)
        return svc.web_login(valid_web_account(account))

    @router.get("/account")
    async def account(request: Request):
        svc = get_service()
        claims = svc.authenticate(bearer(request))
        svc.rate(f"http:{claims['sub']}", 180)
        return svc.store.profile(claims["sub"], claims["provider"])

    @router.post("/account/profile")
    async def update_profile(request: Request):
        svc = get_service()
        token = bearer(request)
        claims = svc.authenticate(token)
        svc.rate("profile-global", 60)
        svc.rate(f"profile-ip:{request.client.host if request.client else 'unknown'}", 30)
        svc.rate(f"profile:{claims['sub']}", 6)
        data = await body(request, MAX_AVATAR_DATA_URL + 1024)
        if not data or set(data) - {"displayName", "avatarDataUrl"}:
            fail("INVALID_PROFILE", 422)
        if "displayName" in data:
            data["displayName"] = validate_display_name(data["displayName"])
        avatar = None
        if "avatarDataUrl" in data:
            if profile_slots.locked():
                fail("TOO_MANY_REQUESTS", 429)
            await profile_slots.acquire()
            decoding = asyncio.create_task(asyncio.to_thread(decode_avatar, data["avatarDataUrl"]))

            def release_profile_slot(task):
                profile_slots.release()
                if not task.cancelled():
                    task.exception()

            decoding.add_done_callback(release_profile_slot)
            avatar = await asyncio.shield(decoding)
        async with svc.mutation_lock:
            # Decoding yields; a concurrent unlink/deletion may invalidate this
            # session. Never save under an obsolete uid after that transition.
            claims = svc.authenticate(token)
            svc.store.update_profile(claims["sub"], data, avatar)
            result = svc.store.profile(claims["sub"], claims["provider"])
            room = svc.store.active_room(claims["sub"])
        if room is not None:
            await svc.broadcast(room)
        return result

    @router.get("/account/avatar/{uid}/{digest}")
    async def avatar(uid: str, digest: str, request: Request):
        svc = get_service()
        svc.rate(f"avatar:{request.client.host if request.client else 'unknown'}", 180)
        mime, content = svc.store.avatar(uid, digest)
        # Opaque, content-versioned URLs work with image loaders that cannot
        # send Bearer headers. Never expose original metadata or identity IDs.
        return Response(content, media_type=mime, headers={"Cache-Control": "no-store",
                        "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'"})

    @router.post("/account/link-code")
    async def link_code(request: Request):
        svc = get_service()
        if web_auth_mode == "password":
            claims = svc.authenticate(bearer(request))
            if claims["provider"] != "web":
                fail("WEB_IDENTITY_REQUIRED", 403)
            profile = svc.store.profile(claims["sub"], "web")
        else:
            account = await web_account(request, svc)
            session = svc.web_login(account)
            claims = svc.authenticate(session["token"])
            profile = session["account"]
        svc.rate(f"issue-link:{claims['identity']}", 5)
        if profile["linkedWechat"]:
            fail("ACCOUNT_ALREADY_LINKED", 409)
        return svc.store.issue_link_code(claims["identity"])

    @router.post("/account/link")
    async def link(request: Request):
        svc = get_service()
        data = await body(request)
        if set(data) != {"code"}:
            fail("INVALID_REQUEST", 422)
        return await svc.link_account(bearer(request), data["code"])

    @router.post("/account/unlink")
    async def unlink(request: Request):
        svc = get_service()
        data = await body(request)
        if set(data) != {"code"}:
            fail("INVALID_REQUEST", 422)
        return await svc.unlink_account(bearer(request), data["code"])

    @router.post("/rooms")
    async def create(request: Request):
        svc = get_service()
        return await svc.mutate(identity(request, svc), "create", await body(request), auth_token=bearer(request))

    @router.post("/account/delete")
    async def delete_account(request: Request):
        svc = get_service()
        # A repeated request with the original valid token can acknowledge an
        # already deleted account after a lost response, without recreating it.
        claims = svc.authenticate(bearer(request), allow_deleted=True)
        if claims["provider"] != "wechat":
            fail("WECHAT_IDENTITY_REQUIRED", 403)
        data = await body(request)
        if set(data) != {"code"}:
            fail("INVALID_REQUEST", 422)
        return await svc.delete_account(claims["sub"], data["code"], claims.get("identity"))

    @router.post("/rooms/join")
    async def join(request: Request):
        svc = get_service()
        data = await body(request)
        return await svc.mutate(identity(request, svc), "join", data, data.get("code"), auth_token=bearer(request))

    @router.get("/rooms/{code}")
    async def state(code: str, request: Request):
        svc = get_service()
        return svc.view(svc.store.room(code), identity(request, svc))

    @router.post("/rooms/{code}/{operation}")
    async def mutate(code: str, operation: str, request: Request):
        if operation not in ("ready", "rematch", "leave", "actions", "settings", "undo"):
            fail("UNKNOWN_OPERATION", 404)
        svc = get_service()
        return await svc.mutate(identity(request, svc), operation, await body(request), code, auth_token=bearer(request))

    @router.websocket("/ws")
    async def socket(ws: WebSocket):
        svc, uid, code = None, None, None
        await ws.accept()
        try:
            svc = get_service()
            hello = await asyncio.wait_for(ws.receive_text(), 8)
            if len(hello) > 4096:
                fail("REQUEST_TOO_LARGE", 413)
            data = json.loads(hello)
            if not isinstance(data, dict) or data.get("protocol") != PROTOCOL:
                fail("PROTOCOL_MISMATCH", 400)
            capabilities = data.get("capabilities", [])
            if (not isinstance(capabilities, list) or len(capabilities) > 8
                    or any(not isinstance(item, str) or len(item) > 32 for item in capabilities)):
                fail("PROTOCOL_MISMATCH", 400)
            claims = svc.authenticate(data.get("token"))
            uid, code = claims["sub"], data.get("code")
            svc.rate(f"socket:{uid}", 30)
            room = svc.store.room(code)
            svc.player(room, uid)
            old = svc.connections[code].get(uid)
            svc.connections[code][uid] = ws
            if old and old is not ws:
                await close_socket(old, 4009)
            # Cleanup may have yielded while a newer connection took ownership
            # or the account/room was deleted. Do not send an obsolete snapshot.
            claims = svc.authenticate(data.get("token"))
            if svc.connections.get(code, {}).get(uid) is not ws:
                await close_socket(ws, 4009)
                return
            room = svc.store.room(code)
            initial = {"type": "room", "room": svc.view(room, uid)}
            if EMOTE_CAPABILITY in capabilities:
                initial["capabilities"] = [EMOTE_CAPABILITY]
            await send_socket(ws, initial)
            if EMOTE_CAPABILITY in capabilities:
                svc.emote_sockets.add(ws)
            while True:
                message = await asyncio.wait_for(ws.receive_text(), 45)
                # Binding/unbinding revokes the former Web identity even while
                # a transport is already connected.
                claims = svc.authenticate(data.get("token"))
                if len(message) > 256 or claims["exp"] <= time.time():
                    await close_socket(ws, 4001)
                    break
                if svc.connections.get(code, {}).get(uid) is not ws:
                    await close_socket(ws, 4009)
                    break
                if message == '{"type":"ping"}':
                    svc.rate(f"ping:{uid}", 12)
                    await send_socket(ws, {"type": "pong"})
                elif message == '{"type":"sync"}':
                    svc.rate(f"ping:{uid}", 12)
                    await send_socket(ws, {"type": "room", "room": svc.view(svc.store.room(code), uid)})
                elif ws in svc.emote_sockets:
                    decoded = json.loads(message)
                    if not isinstance(decoded, dict) or decoded.get("type") != "emote":
                        fail("UNKNOWN_MESSAGE", 400)
                    try:
                        await svc.emote(uid, code, ws, decoded)
                    except HTTPException as error:
                        if error.detail not in {"INVALID_EMOTE", "EMOTE_RATE_LIMIT", "TOO_MANY_REQUESTS", "EMOTES_UNAVAILABLE"}:
                            raise
                        # Only opted-in clients receive this new frame. Rejected
                        # emotes must not disconnect or block an ongoing game.
                        await send_socket(ws, {"type": "emote_error", "code":
                            "EMOTE_RATE_LIMIT" if error.detail == "TOO_MANY_REQUESTS" else error.detail})
                else:
                    fail("UNKNOWN_MESSAGE", 400)
        except WebSocketDisconnect:
            pass
        except (HTTPException, asyncio.TimeoutError, ValueError, TypeError, OSError, RuntimeError) as error:
            await close_socket(ws, 4008 if isinstance(error, HTTPException) and error.detail == "ACCOUNT_DELETED" else 4001)
        finally:
            if svc is not None:
                svc.emote_sockets.discard(ws)
            if svc is not None and code in svc.connections and svc.connections[code].get(uid) is ws:
                svc.connections[code].pop(uid, None)
                if not svc.connections[code]:
                    svc.connections.pop(code, None)
    return router
