"""Unactivated standalone WeChat ASGI draft; never imports server/database.

Keep this file under <reviewed release>/wechat/tools. Run a single ASGI worker
and route only /api/wechat/ to it. Legacy SQLite paths must match the existing
Web service. Password mode verifies existing hashes read-only and never accepts
a legacy JWT. No legacy schema initialization or writes.
Existing WeChat router behavior, including its own store initialization, stays
unchanged. This draft is not part of the frozen 185-file release manifest.
"""
from __future__ import annotations

from contextlib import closing
import hashlib
import importlib.util
import os
from pathlib import Path
import re
import sqlite3

import bcrypt
from fastapi import FastAPI, HTTPException
import jwt

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "web/web后端/wechat_online.py"
DEFAULT_WEB_SECRET = "replace-this-with-a-long-random-secret-key"
DUMMY_HASH = b"$2b$10$abcdefghijklmnopqrstuu2nNkooLTVbHhrjB/2gePtUHpO3.7RwG"


def legacy_database(environment):
    value = environment.get("LINE_GAME_DB_PATH", "")
    if not value or not Path(value).is_absolute():
        return None
    database = Path(value).resolve()
    shared = environment.get("WECHAT_DB_PATH", "")
    if shared:
        shared = Path(shared).resolve()
        if shared == database or (shared.exists() and database.exists() and os.path.samefile(shared, database)):
            return None
    return database


def read_legacy_account(database, username, *, password=False):
    try:
        # Runtime reads honor live WAL. mode=ro cannot create the legacy DB.
        with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=5)) as db:
            db.execute("PRAGMA query_only=ON")
            fields = "id, username, password_hash" if password else "id, username"
            return db.execute(f"SELECT {fields} FROM users WHERE username=?", (username,)).fetchone()
    except sqlite3.DatabaseError:
        raise HTTPException(503, detail="WEB_ACCOUNT_STORE_UNAVAILABLE") from None


def verify_legacy_password(password, encoded):
    """Match the deployed bcrypt_sha256 and older raw-bcrypt formats exactly."""
    try:
        if not isinstance(encoded, str):
            encoded = ""
        prehashed = encoded.startswith("bcrypt_sha256$")
        encoded = encoded[len("bcrypt_sha256$"):] if prehashed else encoded
        # Bound corrupted work factors before invoking bcrypt on a local row.
        valid = re.fullmatch(r"\$2[aby]\$(0[4-9]|1[0-6])\$[./A-Za-z0-9]{53}", encoded)
        raw = password.encode("utf-8")
        candidate = hashlib.sha256(raw).digest() if prehashed else raw[:72]
        matched = bcrypt.checkpw(candidate, encoded.encode("ascii") if valid else DUMMY_HASH)
        return bool(valid and matched)
    except (ValueError, TypeError, UnicodeError):
        return False


def password_authenticator(environment):
    database = legacy_database(environment)
    if database is None:
        return None

    def authenticate(username, password):
        row = read_legacy_account(database, username, password=True)
        valid = verify_legacy_password(password, row[2] if row else None)
        if row is None or not valid:
            raise ValueError("Invalid account credentials.")
        return {"subject": f"user:{row[0]}:{row[1]}", "displayName": row[1]}

    return authenticate


def legacy_authenticator(environment):
    """Read only the existing username/id; preserve the shared identity format."""
    secret = environment.get("JWT_SECRET_KEY", "")
    database = legacy_database(environment)
    if (len(secret) < 32 or secret == DEFAULT_WEB_SECRET or secret != secret.strip()
            or database is None):
        return None

    def authenticate(token):
        try:
            claims = jwt.decode(token, secret, algorithms=["HS256"],
                                options={"require": ["sub", "exp"]})
            username = claims["sub"]
            if (not isinstance(username, str) or not 1 <= len(username) <= 50
                    or claims.get("username", username) != username):
                raise ValueError("Invalid account session.")
        except jwt.PyJWTError as error:
            raise ValueError("Invalid account session.") from error
        row = read_legacy_account(database, username)
        if row is None:
            raise ValueError("Account no longer exists.")
        return {"subject": f"user:{row[0]}:{row[1]}", "displayName": row[1]}

    return authenticate


def create_app(environment=None):
    # Only callback configuration is injectable; the shared router deliberately
    # reads the service process environment on its first request.
    environment = os.environ if environment is None else environment
    mode = environment.get("WECHAT_WEB_AUTH_MODE", "legacy-jwt")
    if mode not in ("legacy-jwt", "password"):
        raise ValueError("Unsupported Web authentication mode")
    if environment.get("WECHAT_ONLINE_ENABLED") == "1":
        key = environment.get("WECHAT_JWT_SECRET", "")
        if (len(key) < 32 or key != key.strip() or key == DEFAULT_WEB_SECRET
                or key in (environment.get("JWT_SECRET_KEY"), environment.get("WECHAT_APP_SECRET"))):
            raise ValueError("An independent strong shared signing key is required")
    # Import the side-effect-free router module without importing old app code.
    spec = importlib.util.spec_from_file_location("_lifeline_standalone_wechat", BACKEND)
    if spec is None or spec.loader is None:
        raise RuntimeError("WeChat router module unavailable.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    app = FastAPI(title="LIFELINE shared rooms", docs_url=None, redoc_url=None, openapi_url=None)
    app.include_router(module.create_router(
        web_authenticate=legacy_authenticator(environment) if mode == "legacy-jwt" else None,
        web_password_authenticate=password_authenticator(environment) if mode == "password" else None,
        web_auth_mode=mode))
    return app


app = create_app()
