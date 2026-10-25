"""Loopback-only password E2E fixture for an explicitly supplied service release.

The release's standalone ASGI/password router is the subject under test. The
extra /api/login route only simulates the old Web login for scenario setup; it
does not import or test the legacy server. All accounts and credentials are
synthetic, and the platform exchange accepts only the two fixture login codes.
"""
from __future__ import annotations

import argparse
import asyncio
import builtins
from contextlib import closing
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys
import time


DEFAULT_WEB_SECRET = "replace-this-with-a-long-random-secret-key"
FIXTURE_APP_ID = "fixture-app"
FIXTURE_APP_SECRET = "fixture-placeholder-never-exchanged"
FIXTURE_USERNAME = "web-friend"
FIXTURE_PASSWORD = "test-only-password"


def validate_arguments(args):
    if os.environ.get("LIFELINE_COMPILED_PASSWORD_FIXTURE") != "1":
        raise ValueError("Explicit password fixture mode is required")
    if not args.stage.is_absolute() or not args.data_dir.is_absolute():
        raise ValueError("Fixture paths must be absolute")
    stage, data = args.stage.resolve(), args.data_dir.resolve()
    if not stage.is_dir() or not data.is_dir() or not 1 <= args.port <= 65535:
        raise ValueError("Existing release, isolated data directory and loopback port required")
    if stage == data or stage in data.parents or data in stage.parents:
        raise ValueError("Fixture data must be separate from the release")
    entry = stage / "wechat/tools/wechat_service_asgi_draft.py"
    backend = stage / "web/web后端/wechat_online.py"
    for source in (entry, backend):
        if not source.is_file() or not source.resolve().is_relative_to(stage):
            raise ValueError("Standalone service release files required")
    databases = {"LINE_GAME_DB_PATH": data / "web.sqlite3",
                 "WECHAT_DB_PATH": data / "wechat.sqlite3"}
    for field, expected in databases.items():
        configured = os.environ.get(field, "")
        if (not configured or not Path(configured).is_absolute()
                or Path(configured).resolve() != expected or os.path.lexists(expected)):
            raise ValueError("Explicit new isolated fixture databases required")
    required = {"WECHAT_WEB_AUTH_MODE": "password", "WECHAT_ONLINE_ENABLED": "1",
                "JWT_SECRET_KEY": DEFAULT_WEB_SECRET, "WECHAT_APP_ID": FIXTURE_APP_ID,
                "WECHAT_APP_SECRET": FIXTURE_APP_SECRET}
    if any(os.environ.get(key) != value for key, value in required.items()):
        raise ValueError("Only the fixed synthetic password fixture configuration is accepted")
    shared_secret = os.environ.get("WECHAT_JWT_SECRET", "")
    if (len(shared_secret) < 32 or shared_secret != shared_secret.strip()
            or shared_secret in (DEFAULT_WEB_SECRET, FIXTURE_APP_SECRET)):
        raise ValueError("An independent fixture signing key is required")
    return stage, entry, backend, databases


def install_import_and_network_guards():
    original_import = builtins.__import__

    def guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
        if ((level == 0 and name in {"server", "database", "models"})
                or name in {"web.web后端.server", "web.web后端.database", "web.web后端.models"}):
            raise RuntimeError("Legacy application imports are forbidden in this fixture")
        return original_import(name, globals, locals, fromlist, level)

    builtins.__import__ = guarded_import

    def loopback_only(event, arguments):
        if event == "socket.connect":
            address = arguments[1]
            if isinstance(address, tuple) and address[0] not in ("127.0.0.1", "::1", "localhost"):
                raise OSError("Fixture outbound destination is not loopback")
        elif event == "socket.getaddrinfo":
            if arguments[0] not in (None, "127.0.0.1", "::1", "localhost"):
                raise OSError("Fixture DNS destination is not loopback")

    sys.addaudithook(loopback_only)


def iter_routes(container):
    # FastAPI versions either flatten include_router or retain a wrapper.
    for route in container.routes:
        if hasattr(route, "original_router"):
            yield from iter_routes(route.original_router)
        else:
            yield route


def build_fixture(stage, entry, backend, databases):
    import bcrypt
    from fastapi import HTTPException, Request
    import jwt

    # Exclusive creation prevents a race from repurposing an existing database.
    with databases["LINE_GAME_DB_PATH"].open("xb"):
        pass
    encoded = "bcrypt_sha256$" + bcrypt.hashpw(
        hashlib.sha256(FIXTURE_PASSWORD.encode("utf-8")).digest(),
        bcrypt.gensalt(rounds=4)).decode("ascii")
    with closing(sqlite3.connect(databases["LINE_GAME_DB_PATH"])) as db:
        db.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, username VARCHAR(50) UNIQUE NOT NULL, "
                   "password_hash VARCHAR(255) NOT NULL)")
        db.execute("INSERT INTO users VALUES (?,?,?)", (17, FIXTURE_USERNAME, encoded))
        db.commit()

    spec = importlib.util.spec_from_file_location("_password_fixture_standalone", entry)
    if spec is None or spec.loader is None:
        raise RuntimeError("Standalone fixture entry could not be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if module.ROOT.resolve() != stage or module.BACKEND.resolve() != backend.resolve():
        raise RuntimeError("Standalone entry resolved outside the requested release")
    app = module.app
    endpoint = next(route.endpoint for route in iter_routes(app)
                    if getattr(route, "path", None) == "/api/wechat/login")
    namespace = endpoint.__globals__
    if Path(namespace["__file__"]).resolve() != backend.resolve():
        raise RuntimeError("Unexpected router source")
    service_class = namespace["WechatService"]
    original_init = service_class.__init__

    async def exchange(code, app_id, app_secret):
        if app_id != FIXTURE_APP_ID or app_secret != FIXTURE_APP_SECRET:
            raise RuntimeError("Non-fixture platform credentials are forbidden")
        if code not in ("blue", "red"):
            namespace["fail"]("LOGIN_FAILED", 401)
        return "compiled-password-fixture-openid-" + code

    def initialize(service, *args, **kwargs):
        kwargs["exchange"] = exchange
        original_init(service, *args, **kwargs)

    service_class.__init__ = initialize

    def deny_https(*_args, **_kwargs):
        raise OSError("Real platform exchange is disabled in this fixture")

    namespace["http_client"].HTTPSConnection = deny_https
    if databases["WECHAT_DB_PATH"].exists():
        raise RuntimeError("Standalone import initialized the shared store unexpectedly")
    authenticate = module.password_authenticator(os.environ)
    if authenticate is None:
        raise RuntimeError("Fixture password account callback unavailable")

    # This route is intentionally not copied from or installed in the release.
    # Existing compiled scenarios only use it to simulate a legacy Web session.
    async def simulated_legacy_login(request):
        raw = await request.body()
        if len(raw) > 8192:
            raise HTTPException(413, detail="REQUEST_TOO_LARGE")
        try:
            data = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            raise HTTPException(422, detail="INVALID_REQUEST") from None
        if (not isinstance(data, dict) or set(data) != {"username", "password"}
                or not isinstance(data["username"], str) or not 1 <= len(data["username"]) <= 50
                or not isinstance(data["password"], str) or not 1 <= len(data["password"]) <= 128):
            raise HTTPException(422, detail="INVALID_REQUEST")
        try:
            account = await asyncio.to_thread(authenticate, data["username"].strip(), data["password"])
        except ValueError:
            raise HTTPException(401, detail="Invalid username or password.") from None
        username = account["displayName"]
        lifetime = 7 * 24 * 60 * 60
        token = jwt.encode({"sub": username, "username": username, "exp": int(time.time()) + lifetime},
                           DEFAULT_WEB_SECRET, algorithm="HS256")
        return {"token": token, "username": username, "token_type": "bearer", "expires_in": lifetime}

    # Resolve the locally imported Request type without relying on global names
    # when FastAPI evaluates annotations on this dynamically assembled route.
    simulated_legacy_login.__annotations__["request"] = Request
    app.add_api_route("/api/login", simulated_legacy_login, methods=["POST"])
    return app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", type=Path, required=True)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    stage, entry, backend, databases = validate_arguments(args)
    sys.dont_write_bytecode = True
    # Uvicorn itself has an unrelated relative .server module. Load framework
    # dependencies before installing the explicit legacy-application guard.
    import uvicorn
    install_import_and_network_guards()
    app = build_fixture(stage, entry, backend, databases)

    class ReadyServer(uvicorn.Server):
        async def startup(self, sockets=None):
            await super().startup(sockets=sockets)
            if self.started:
                print(json.dumps({"status": "READY_LOOPBACK_PASSWORD_FIXTURE",
                                  "host": "127.0.0.1", "port": args.port,
                                  "webAuthMode": "password", "realWechatExchange": False,
                                  "legacyLogin": "FIXTURE_SIMULATION_ONLY"}), flush=True)

    config = uvicorn.Config(app, host="127.0.0.1", port=args.port, workers=1,
                            log_level="warning", access_log=False, proxy_headers=False)
    server = ReadyServer(config)
    server.run()
    return 0 if server.started else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (Exception, KeyboardInterrupt) as error:
        # Only a failure type is emitted, never exception text or environment.
        print(json.dumps({"status": "FIXTURE_FAILED", "failureType": type(error).__name__}), file=sys.stderr)
        raise SystemExit(1) from None
