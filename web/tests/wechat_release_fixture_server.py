"""Loopback transport fixture bound to an explicit frozen shared-service tree.

Only authentication is synthetic. HTTP, WebSocket, SQLite, rules and state
hashes use the selected package; no production credentials are loaded.
"""
import argparse
import importlib.util
from pathlib import Path

import uvicorn
from fastapi import FastAPI

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--service-root", type=Path, required=True)
parser.add_argument("--port", type=int, required=True)
parser.add_argument("--database", type=Path, required=True)
args = parser.parse_args()
assert 1024 < args.port < 65536 and not args.database.exists()
source = args.service_root.resolve() / "web/web后端/wechat_online.py"
spec = importlib.util.spec_from_file_location("frozen_release_api", source)
wx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wx)


async def exchange(code, _app, _secret):
    if code not in ("blue", "red", "outsider"):
        wx.fail("LOGIN_FAILED", 401)
    return "synthetic-transport-" + code


def password(username, value):
    if username != "web-friend" or value != "test-only-password":
        raise ValueError("Synthetic login rejected")
    return {"subject": "synthetic-web-friend", "displayName": "Web fixture"}


service = wx.WechatService(wx.WechatStore(args.database), "synthetic-app", "synthetic-secret",
                          "synthetic-transport-signing-secret-over-32-characters", exchange=exchange)
app = FastAPI()
app.include_router(wx.create_router(service, web_password_authenticate=password, web_auth_mode="password"))
uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning", access_log=False)
