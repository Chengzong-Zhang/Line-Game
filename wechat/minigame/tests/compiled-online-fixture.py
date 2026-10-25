"""Explicit loopback fixture: stage Web auth with fake WeChat exchange only."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", type=Path, required=True)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    if os.environ.get("LIFELINE_COMPILED_ONLINE_FIXTURE") != "1":
        raise RuntimeError("Start this fixture through compiled-online-runner.py.")
    if not args.stage.is_absolute() or not args.data_dir.is_absolute():
        raise ValueError("Fixture paths must be absolute.")
    stage, data = args.stage.resolve(), args.data_dir.resolve()
    backend = stage / "web/web后端"
    if not (backend / "server.py").is_file() or not data.is_dir():
        raise ValueError("Expected an existing stage and isolated data directory.")
    if not 1 <= args.port <= 65535:
        raise ValueError("Invalid loopback port.")
    databases = {"LINE_GAME_DB_PATH": data / "web.sqlite3",
                 "WECHAT_DB_PATH": data / "wechat.sqlite3"}
    for field, expected in databases.items():
        if Path(os.environ.get(field, "")).resolve() != expected or expected.exists():
            raise ValueError("Fixture database must be a new, explicitly isolated file.")
    web_secret = os.environ.get("JWT_SECRET_KEY", "")
    room_secret = os.environ.get("WECHAT_JWT_SECRET", "")
    if min(len(web_secret), len(room_secret)) < 32 or web_secret == room_secret:
        raise ValueError("Independent fixture signing keys are required.")
    if os.environ.get("WECHAT_ONLINE_ENABLED") != "0":
        raise ValueError("Environment-driven WeChat exchange must remain disabled.")

    # Import only after the runner's isolated paths and keys have been checked.
    sys.path.insert(0, str(backend))
    import server
    import uvicorn
    from fastapi import FastAPI
    from wechat_online import WechatService, WechatStore, create_router, fail

    if Path(server.__file__).resolve() != backend / "server.py":
        raise RuntimeError("Unexpected backend import.")

    async def exchange(code, _app, _secret):
        if code not in ("red", "blue"):
            fail("LOGIN_FAILED", 401)
        return f"compiled-fixture-openid-{code}"

    server.init_db()
    with server.SessionLocal() as db:
        db.add(server.User(username="web-friend",
                           password_hash=server.hash_password("test-only-password")))
        db.commit()
    service = WechatService(
        WechatStore(databases["WECHAT_DB_PATH"]), "fixture-app",
        "fixture-placeholder-never-exchanged", room_secret, exchange=exchange)
    app = FastAPI(title="Isolated compiled online fixture")
    login_routes = [route for route in server.app.router.routes
                    if getattr(route, "path", "") == "/api/login"]
    if len(login_routes) != 1:
        raise RuntimeError("Expected the stage's single Web login route.")
    app.router.routes.extend(login_routes)
    app.include_router(create_router(
        service, web_authenticate=server.authenticate_wechat_web_account))
    uvicorn.run(app, host="127.0.0.1", port=args.port,
                log_level="warning", access_log=False, workers=1)


if __name__ == "__main__":
    main()
