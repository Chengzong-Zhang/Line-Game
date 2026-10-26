"""Identity linking uses two proven sessions and real isolated SQLite stores."""
import asyncio
from contextlib import closing
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time

import jwt
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("wechat_accounts_test", ROOT / "web/web后端/wechat_online.py")
wx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wx)
WEB_SECRET = "independent-web-fixture-secret-32-characters"


async def exchange(code, _app, _secret):
    if code not in ("alice", "bob", "carol"):
        wx.fail("LOGIN_FAILED", 401)
    return f"fixture-openid-{code}"


def web_token(name="alice", **claims):
    return jwt.encode({"sub": name, "exp": int(time.time()) + 600, **claims}, WEB_SECRET, algorithm="HS256")


def web_authenticate(token):
    claims = jwt.decode(token, WEB_SECRET, algorithms=["HS256"], options={"require": ["sub", "exp"]})
    if claims["sub"] not in ("alice", "bob", "carol"):
        raise ValueError("No such fixture user")
    return {"subject": "fixture-user-id-" + claims["sub"], "displayName": claims["sub"]}


def bearer(token):
    return {"Authorization": "Bearer " + token}


@pytest.fixture
def env(tmp_path):
    store = wx.WechatStore(tmp_path / "dedicated.sqlite3")
    service = wx.WechatService(store, "fixture-app", "fixture-secret", "dedicated-jwt-secret-32-characters-long", exchange=exchange)
    app = FastAPI()
    app.include_router(wx.create_router(service, web_authenticate=web_authenticate))
    with TestClient(app) as client:
        yield client, service


def login(client, name="alice", provider="wechat"):
    if provider == "web":
        response = client.post("/api/wechat/login/web", headers=bearer(web_token(name)))
    else:
        response = client.post("/api/wechat/login", json={"code": name})
    assert response.status_code == 200, response.text
    return response.json()


def issue(client, name="alice"):
    response = client.post("/api/wechat/account/link-code", headers=bearer(web_token(name)))
    assert response.status_code == 200, response.text
    return response.json()["code"]


def post(client, path, session, body=None):
    return client.post("/api/wechat/" + path, headers=bearer(session["token"]), json=body or {})


def link(client, session, name="alice"):
    response = post(client, "account/link", session, {"code": issue(client, name)})
    assert response.status_code == 200, response.text
    return response.json()


def test_independent_accounts_and_expired_forged_or_missing_sessions(env):
    client, service = env
    web, wechat = login(client, provider="web"), login(client)
    assert web["account"]["uid"] != wechat["account"]["uid"]
    assert web["account"] == {**web["account"], "displayName": "alice", "provider": "web", "linkedWeb": True, "linkedWechat": False}
    assert wechat["account"]["displayName"] == "微信玩家"
    assert login(client)["account"]["uid"] == wechat["account"]["uid"]
    for token in (web_token(exp=int(time.time()) - 5), web_token("missing"), web_token() + "broken",
                  jwt.encode({"sub": "alice"}, WEB_SECRET, algorithm="HS256"), wechat["token"]):
        assert client.post("/api/wechat/login/web", headers=bearer(token)).status_code == 401
    assert client.post("/api/wechat/login/web").status_code == 401
    assert client.get("/api/wechat/account", headers=bearer(web_token())).status_code == 401
    assert service.store.web_uid("not-a-subject") is None
    assert client.get("/api/wechat/status").json()["accountLinking"] is True


def test_binding_consumes_codes_changes_web_uid_and_rejects_old_session(env):
    client, service = env
    web, wechat = login(client, provider="web"), login(client)
    code, second = issue(client), issue(client)
    assert len(code) == 26 and all(c in "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" for c in code)
    with service.store.connect() as db:
        assert code not in str(db.execute("SELECT * FROM wx_link_codes").fetchall())
    response = post(client, "account/link", wechat, {"code": code})
    assert response.status_code == 200
    bound = response.json()
    assert bound["account"]["uid"] == wechat["account"]["uid"]
    assert bound["account"]["linkedWeb"] is True
    assert bound["account"]["displayName"] == "alice"
    assert login(client, provider="web")["account"]["uid"] == bound["account"]["uid"]
    assert client.get("/api/wechat/account", headers=bearer(web["token"])).status_code == 401
    assert post(client, "rooms", web, {"gridSize": 5}).status_code == 401
    for used in (code, second):
        assert post(client, "account/link", wechat, {"code": used}).json()["detail"] == "LINK_CODE_INVALID"
    assert client.post("/api/wechat/account/link-code", headers=bearer(web_token())).json()["detail"] == "ACCOUNT_ALREADY_LINKED"


def test_codes_expire_and_conflicting_bindings_require_no_active_rooms(env):
    client, service = env
    wechat, web = login(client), login(client, provider="web")
    code = issue(client)
    with service.store.connect() as db:
        db.execute("UPDATE wx_link_codes SET expires=0")
    assert post(client, "account/link", wechat, {"code": code}).json()["detail"] == "LINK_CODE_INVALID"
    code = issue(client)
    room = post(client, "rooms", web, {"gridSize": 5}).json()
    blocked = post(client, "account/link", wechat, {"code": code})
    assert blocked.status_code == 409 and blocked.json()["detail"] == "ACCOUNT_IN_ROOM"
    assert post(client, f"rooms/{room['code']}/leave", web, {"matchId": room["matchId"]}).status_code == 200
    assert post(client, "account/link", wechat, {"code": code}).status_code == 200
    # Closed-room data survived and its member now uses the proven merged uid.
    assert service.store.room(room["code"])["players"]["BLACK"] == wechat["account"]["uid"]
    conflict = post(client, "account/link", wechat, {"code": issue(client, "bob")})
    assert conflict.status_code == 409 and conflict.json()["detail"] == "ACCOUNT_LINK_CONFLICT"


def test_binding_code_preissued_before_other_identity_links_cannot_relink(env):
    client, _ = env
    code = issue(client)
    assert post(client, "account/link", login(client, "bob"), {"code": code}).status_code == 200
    assert post(client, "account/link", login(client), {"code": code}).status_code == 400
    # The Web session cannot claim to be a WeChat proof.
    assert post(client, "account/link", login(client, provider="web"), {"code": "A" * 26}).status_code == 403


def test_unlink_requires_fresh_same_identity_and_revokes_web_room_tokens(env):
    client, _ = env
    bound = link(client, login(client))
    web = login(client, provider="web")
    assert post(client, "account/unlink", web, {"code": "alice"}).status_code == 403
    assert post(client, "account/unlink", bound, {"code": "bob"}).status_code == 403
    room = post(client, "rooms", web, {"gridSize": 5}).json()
    assert post(client, "account/unlink", bound, {"code": "alice"}).json()["detail"] == "ACCOUNT_IN_ROOM"
    assert post(client, f"rooms/{room['code']}/leave", bound, {"matchId": room["matchId"]}).status_code == 200
    result = post(client, "account/unlink", bound, {"code": "alice"})
    assert result.status_code == 200 and result.json()["account"]["linkedWeb"] is False
    assert client.get("/api/wechat/account", headers=bearer(web["token"])).status_code == 401
    separate = login(client, provider="web")
    assert separate["account"]["uid"] != bound["account"]["uid"]
    assert separate["account"]["displayName"] == "alice"
    assert separate["account"]["linkedWechat"] is False
    assert login(client)["account"]["uid"] == bound["account"]["uid"]


def test_delete_linked_wechat_preserves_web_account_and_other_person(env):
    client, service = env
    bound = link(client, login(client))
    web, other = login(client, provider="web"), login(client, "bob")
    room = post(client, "rooms", bound, {"gridSize": 5}).json()
    assert post(client, "rooms/join", other, {"code": room["code"]}).status_code == 200
    assert post(client, "account/delete", web, {"code": "alice"}).status_code == 403
    assert post(client, "account/delete", bound, {"code": "bob"}).status_code == 403
    result = post(client, "account/delete", bound, {"code": "alice"})
    assert result.status_code == 200 and result.json()["roomsDeleted"] == 1
    assert post(client, "account/delete", bound, {"code": "alice"}).status_code == 200
    assert post(client, "account/delete", bound, {"code": "bob"}).status_code == 403
    assert service.store.subject(bound["account"]["uid"]) is None
    assert client.get("/api/wechat/account", headers=bearer(web["token"])).status_code == 401
    assert client.get("/api/wechat/account", headers=bearer(other["token"])).status_code == 200
    preserved = login(client, provider="web")
    assert preserved["account"]["displayName"] == "alice"
    assert preserved["account"]["uid"] != web["account"]["uid"]
    assert preserved["account"]["linkedWechat"] is False
    assert login(client)["account"]["uid"] != bound["account"]["uid"]


def test_link_issue_rate_limit_survives_service_restart(env):
    client, service = env
    for _ in range(5):
        issue(client)
    assert client.post("/api/wechat/account/link-code", headers=bearer(web_token())).status_code == 429
    # Simulate process limiter reset; durable SQLite issue timestamps still bind.
    service.arrivals.clear()
    assert client.post("/api/wechat/account/link-code", headers=bearer(web_token())).status_code == 429


def test_web_and_wechat_share_authoritative_room_and_member_permissions(env):
    client, _ = env
    web, wechat, outsider = login(client, provider="web"), login(client, "bob"), login(client, "carol")
    room = post(client, "rooms", web, {"gridSize": 5}).json()
    assert post(client, "rooms/join", wechat, {"code": room["code"]}).status_code == 200
    assert client.get(f"/api/wechat/rooms/{room['code']}", headers=bearer(outsider["token"])).status_code == 403
    for session in (web, wechat):
        room = post(client, f"rooms/{room['code']}/ready", session, {"matchId": room["matchId"]}).json()
    assert room["status"] == "playing"
    for index, session in enumerate((web, wechat)):
        response = post(client, f"rooms/{room['code']}/actions", session,
                        {"matchId": room["matchId"], "expectedSeq": room["seq"], "beforeHash": room["stateHash"],
                         "clientActionId": f"cross-platform-command-{index:04d}", "action": {"type": "skip"}})
        assert response.status_code == 200, response.text
        room = response.json()
    assert room["gameOver"] is True and room["status"] == "finished"
    for session in (web, wechat):
        current = client.get(f"/api/wechat/rooms/{room['code']}", headers=bearer(session["token"])).json()
        assert current["stateHash"] == room["stateHash"] and current["seq"] == 2


def test_queued_mutation_rechecks_revoked_web_token(env):
    client, service = env
    wechat, web = login(client), login(client, provider="web")
    link(client, wechat)
    with pytest.raises(wx.HTTPException) as error:
        asyncio.run(service.mutate(web["account"]["uid"], "create", {"gridSize": 5}, auth_token=web["token"]))
    assert error.value.status_code == 401


def make_v1(database):
    with closing(sqlite3.connect(database)) as db:
        db.executescript("""
            CREATE TABLE wx_users (subject TEXT PRIMARY KEY, uid TEXT UNIQUE NOT NULL);
            CREATE TABLE wx_rooms (code TEXT PRIMARY KEY, revision INTEGER NOT NULL, expires INTEGER NOT NULL, document TEXT NOT NULL);
            CREATE TABLE wx_commands (room TEXT NOT NULL, match_id TEXT NOT NULL, command_id TEXT NOT NULL, uid TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(room, match_id, command_id));
            INSERT INTO wx_users VALUES ('fixture-subject', '0123456789abcdef0123456789abcdef');
        """)


def test_v1_migration_preserves_identity_and_rolls_back_on_failure(tmp_path, monkeypatch):
    database = tmp_path / "v1.sqlite3"
    make_v1(database)
    migrate = wx.WechatStore.migrate_accounts

    def fail_migration(db):
        migrate(db)
        raise RuntimeError("fixture interrupted migration")

    with monkeypatch.context() as patch:
        patch.setattr(wx.WechatStore, "migrate_accounts", staticmethod(fail_migration))
        with pytest.raises(RuntimeError):
            wx.WechatStore(database)
    with closing(sqlite3.connect(database)) as db:
        assert {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")} == set(wx.STORE_COLUMNS)
        assert db.execute("PRAGMA user_version").fetchone()[0] == 0
    store = wx.WechatStore(database)
    assert store.identity("fixture-subject") == "0123456789abcdef0123456789abcdef"
    with store.connect() as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 4
        assert db.execute("SELECT count(*) FROM wx_web_accounts").fetchone()[0] == 0


@pytest.mark.parametrize("kind", ["partial-table", "version-only"])
def test_schema_with_partial_account_tables_is_rejected_without_mutation(tmp_path, kind):
    database = tmp_path / "partial.sqlite3"
    make_v1(database)
    with closing(sqlite3.connect(database)) as db:
        if kind == "partial-table":
            db.execute("CREATE TABLE wx_web_accounts (subject TEXT PRIMARY KEY, uid TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL)")
        else:
            db.execute("PRAGMA user_version=2")
        db.commit()
    before = database.read_bytes()
    with pytest.raises(ValueError):
        wx.WechatStore(database)
    assert database.read_bytes() == before


def test_backup_restore_preserves_latest_binding_and_cannot_replay_code(env, tmp_path):
    client, service = env
    module_spec = importlib.util.spec_from_file_location("wechat_accounts_maintenance_test", ROOT / "wechat/tools/maintain_store.py")
    maintenance = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(maintenance)
    wechat = login(client)
    code = issue(client)
    original = tmp_path / "unlinked-backup.sqlite3"
    receipt = maintenance.copy_store(service.store.database, original)
    assert post(client, "account/link", wechat, {"code": code}).status_code == 200
    bound = login(client, provider="web")
    restored = tmp_path / "restored-current-link.sqlite3"
    maintenance.copy_store(original, restored, expected_sha256=receipt["sha256"], current_store=service.store.database)
    store = wx.WechatStore(restored)
    assert store.web_uid(service.authenticate(bound["token"])["identity"]) == wechat["account"]["uid"]
    with store.connect() as db:
        assert db.execute("SELECT count(*) FROM wx_link_codes").fetchone()[0] == 0
    linked_backup = tmp_path / "linked-backup.sqlite3"
    linked_receipt = maintenance.copy_store(service.store.database, linked_backup)
    assert post(client, "account/unlink", wechat, {"code": "alice"}).status_code == 200
    current = login(client, provider="web")
    unlinked_restore = tmp_path / "restored-current-unlink.sqlite3"
    maintenance.copy_store(linked_backup, unlinked_restore, expected_sha256=linked_receipt["sha256"], current_store=service.store.database)
    assert wx.WechatStore(unlinked_restore).web_uid(service.authenticate(current["token"])["identity"]) == current["account"]["uid"]
    assert current["account"]["uid"] != bound["account"]["uid"]


def test_actual_legacy_login_bridges_only_existing_unexpired_web_accounts(tmp_path):
    """Import the real server only in an isolated child with fixture DB paths."""
    environment = {**os.environ, "LINE_GAME_DB_PATH": str(tmp_path / "legacy.sqlite3"),
                   "WECHAT_DB_PATH": str(tmp_path / "wechat.sqlite3"), "WECHAT_ONLINE_ENABLED": "1",
                   "WECHAT_APP_ID": "fixture-app", "WECHAT_APP_SECRET": "fixture-secret",
                   "WECHAT_JWT_SECRET": "fixture-wechat-signing-secret-32-characters",
                   "JWT_SECRET_KEY": WEB_SECRET}
    source = """
from fastapi.testclient import TestClient
import jwt
import server
with TestClient(server.app) as client:
    with server.SessionLocal() as db:
        db.add(server.User(username='existing-web-player', password_hash=server.hash_password('fixture-password')))
        db.commit()
    response = client.post('/api/login', json={'username':'existing-web-player','password':'fixture-password'})
    assert response.status_code == 200, response.text
    token = response.json()['token']
    auth = {'Authorization':'Bearer '+token}
    bridged = client.post('/api/wechat/login/web', headers=auth)
    assert bridged.status_code == 200, bridged.text
    assert bridged.json()['account']['displayName'] == 'existing-web-player'
    assert bridged.json()['account']['provider'] == 'web'
    assert client.get('/api/wechat/status').json()['webLogin'] is True
    with server.SessionLocal() as db:
        user = db.scalar(server.select(server.User).where(server.User.username == 'existing-web-player'))
        assert server.verify_password('fixture-password', user.password_hash)
    for claims in ({'sub':'existing-web-player'}, {'sub':'existing-web-player','username':'someone-else','exp':9999999999},
                   {'sub':'missing-user','exp':9999999999}, {'sub':'existing-web-player','exp':1}):
        invalid = jwt.encode(claims, server.JWT_SECRET_KEY, algorithm='HS256')
        assert client.post('/api/wechat/login/web', headers={'Authorization':'Bearer '+invalid}).status_code == 401
    assert client.post('/api/login', json={'username':'existing-web-player','password':'fixture-password'}).status_code == 200
"""
    process = subprocess.run([sys.executable, "-c", source], cwd=ROOT / "web/web后端", env=environment,
                             capture_output=True, text=True, timeout=25, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    assert process.returncode == 0, process.stdout + process.stderr
