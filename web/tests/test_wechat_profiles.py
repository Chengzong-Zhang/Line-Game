"""Real FastAPI routes, isolated SQLite, and real PNG/JPEG decoding."""
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import io
import json
import threading

from PIL import Image, PngImagePlugin
import pytest

from test_wechat_accounts import wx, env, login, post, bearer, link, web_token


def picture(kind="PNG", size=(12, 9), metadata=False):
    image = Image.new("RGB", size, (20, 120, 80))
    options = {}
    if metadata and kind == "PNG":
        text = PngImagePlugin.PngInfo()
        text.add_text("Comment", "private-location-should-disappear")
        options["pnginfo"] = text
    elif metadata and kind == "JPEG":
        exif = Image.Exif()
        exif[270] = "private-location-should-disappear"
        options["exif"] = exif
    output = io.BytesIO()
    image.save(output, kind, **options)
    return output.getvalue()


def data_url(raw, mime="png"):
    return f"data:image/{mime};base64," + base64.b64encode(raw).decode("ascii")


def update(client, session, **changes):
    return post(client, "account/profile", session, changes)


def test_name_persists_without_changing_web_login_identity(env):
    client, service = env
    session = login(client, provider="web")
    assert session["account"]["avatarUrl"] is None
    saved = update(client, session, displayName="  蓝方😀  ")
    assert saved.status_code == 200, saved.text
    assert saved.json()["displayName"] == "蓝方😀"
    assert saved.json()["uid"] == session["account"]["uid"]
    assert login(client, provider="web")["account"]["displayName"] == "蓝方😀"
    reopened = wx.WechatStore(service.store.database)
    assert reopened.profile(session["account"]["uid"], "web") == saved.json()
    with reopened.connect() as db:
        assert db.execute("SELECT display_name FROM wx_web_accounts").fetchone()[0] == "alice"
        assert db.execute("PRAGMA user_version").fetchone()[0] == 6


@pytest.mark.parametrize("kind,mime", [("PNG", "png"), ("JPEG", "jpeg")])
def test_real_image_is_decoded_reencoded_and_served_separately(env, kind, mime):
    client, service = env
    session = login(client)
    original = picture(kind, metadata=True)
    saved = update(client, session, avatarDataUrl=data_url(original, mime))
    assert saved.status_code == 200, saved.text
    profile = saved.json()
    assert profile["displayName"] == "微信玩家"
    assert profile["avatarUrl"].startswith("/api/wechat/account/avatar/" + profile["uid"] + "/")
    assert "base64" not in saved.text and "private-location" not in saved.text
    response = client.get(profile["avatarUrl"])
    assert response.status_code == 200 and response.headers["content-type"] == "image/" + mime
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert b"private-location" not in response.content
    with Image.open(io.BytesIO(response.content)) as image:
        image.load()
        assert image.size == (12, 9) and image.format == kind
        assert not image.getexif()
    assert hashlib.sha256(response.content).hexdigest() == profile["avatarUrl"].rsplit("/", 1)[1]
    assert update(client, session, displayName="只改昵称").json()["avatarUrl"] == profile["avatarUrl"]
    with service.store.connect() as db:
        mime_db, blob = db.execute("SELECT avatar_mime,avatar_blob FROM wx_profiles").fetchone()
        assert mime_db == "image/" + mime and blob == response.content
    assert client.get(profile["avatarUrl"][:-1] + "Z").status_code == 404
    cleared = update(client, session, avatarDataUrl=None)
    assert cleared.status_code == 200 and cleared.json()["avatarUrl"] is None
    assert client.get(profile["avatarUrl"]).status_code == 404


@pytest.mark.parametrize("value", [None, True, 3, "", "   ", "😀" * 25, "名字\n", "a\x00b", "a\u202eb", "a\ud800", "a\u2028b"])
def test_invalid_name_has_no_partial_write(env, value):
    client, service = env
    session = login(client)
    # A lone escaped surrogate is legal JSON input even though HTTPX's normal
    # UTF-8 JSON serializer refuses to produce it. Exercise the server itself.
    response = client.post("/api/wechat/account/profile", headers=bearer(session["token"]),
                           content=json.dumps({"displayName": value}, ensure_ascii=True))
    assert response.status_code == 422 and response.json()["detail"] == "INVALID_DISPLAY_NAME"
    with service.store.connect() as db:
        assert db.execute("SELECT count(*) FROM wx_profiles").fetchone()[0] == 0


def test_name_counts_unicode_codepoints_and_trims_unicode_spaces(env):
    client, _ = env
    session = login(client)
    assert update(client, session, displayName="\u3000" + "😀" * 24 + "\u3000").json()["displayName"] == "😀" * 24


def test_512_pixel_limit_is_inclusive_and_animation_is_rejected(env):
    client, _ = env
    session = login(client)
    saved = update(client, session, avatarDataUrl=data_url(picture(size=(512, 512))))
    assert saved.status_code == 200
    with Image.open(io.BytesIO(client.get(saved.json()["avatarUrl"]).content)) as image:
        assert image.size == (512, 512)
    first, second = Image.new("RGB", (8, 8), "red"), Image.new("RGB", (8, 8), "blue")
    animated = io.BytesIO()
    first.save(animated, "PNG", save_all=True, append_images=[second], duration=50, loop=0)
    rejected = update(client, session, avatarDataUrl=data_url(animated.getvalue()))
    assert rejected.status_code == 422
    assert client.get("/api/wechat/account", headers=bearer(session["token"])).json()["avatarUrl"] == saved.json()["avatarUrl"]


@pytest.mark.parametrize("case", ["truncated", "crc", "mime", "gif", "svg", "large-side", "large-bytes", "truncated-jpeg", "base64-space", "base64-padding", "trailing", "boolean"])
def test_invalid_avatar_rejected_atomically(env, case):
    client, service = env
    session = login(client)
    raw = picture()
    choices = {
        "truncated": data_url(raw[:-12]),
        "crc": data_url(raw[:29] + bytes([raw[29] ^ 1]) + raw[30:]),
        "mime": data_url(raw, "jpeg"),
        "gif": data_url(picture("GIF")),
        "svg": data_url(b"<svg xmlns='http://www.w3.org/2000/svg'></svg>"),
        "large-side": data_url(picture(size=(513, 1))),
        "large-bytes": data_url(b"x" * (wx.MAX_AVATAR_BYTES + 1)),
        "truncated-jpeg": data_url(picture("JPEG")[:100] + b"\xff\xd9", "jpeg"),
        "base64-space": data_url(raw) + "\n",
        "base64-padding": data_url(raw) + "=",
        "trailing": data_url(raw + b"untrusted-extra-bytes"),
        "boolean": True,
    }
    response = update(client, session, displayName="不得保存", avatarDataUrl=choices[case])
    assert response.status_code in (413, 422), response.text
    assert "不得保存" not in client.get("/api/wechat/account", headers=bearer(session["token"])).text
    with service.store.connect() as db:
        assert db.execute("SELECT count(*) FROM wx_profiles").fetchone()[0] == 0


def test_auth_ownership_body_limit_and_rate_limit(env):
    client, service = env
    session, other = login(client), login(client, "bob")
    assert client.post("/api/wechat/account/profile", json={"displayName": "改名"}).status_code == 401
    assert client.post("/api/wechat/account/profile", headers=bearer(web_token()), json={"displayName": "改名"}).status_code == 401
    assert update(client, session, displayName="越权", uid=other["account"]["uid"]).status_code == 422
    assert update(client, session).status_code == 422
    too_large = client.post("/api/wechat/account/profile", headers=bearer(session["token"]),
                            content=b" " * (wx.MAX_AVATAR_DATA_URL + 1025))
    assert too_large.status_code == 413
    service.arrivals.clear()
    for i in range(6):
        assert update(client, session, displayName=f"玩家{i}").status_code == 200
    assert update(client, session, displayName="限流").status_code == 429
    assert client.get("/api/wechat/account", headers=bearer(other["token"])).json()["displayName"] == "微信玩家"


def test_link_retains_wechat_customization_and_unlink_separates_web(env):
    client, service = env
    wechat, web = login(client), login(client, provider="web")
    update(client, web, displayName="网页昵称", avatarDataUrl=data_url(picture("JPEG"), "jpeg"))
    web_old_url = client.get("/api/wechat/account", headers=bearer(web["token"])).json()["avatarUrl"]
    customized = update(client, wechat, displayName="微信昵称", avatarDataUrl=data_url(picture())).json()
    bound = link(client, wechat)
    assert bound["account"]["displayName"] == "微信昵称"
    assert bound["account"]["avatarUrl"] == customized["avatarUrl"]
    assert client.get(web_old_url).status_code == 404
    assert update(client, web, displayName="过期会话").status_code == 401
    shared = login(client, provider="web")
    assert shared["account"]["avatarUrl"] == customized["avatarUrl"]
    assert update(client, shared, displayName="共享昵称").status_code == 200
    assert login(client)["account"]["displayName"] == "共享昵称"
    assert post(client, "account/unlink", bound, {"code": "alice"}).status_code == 200
    separated = login(client, provider="web")
    assert separated["account"]["displayName"] == "alice" and separated["account"]["avatarUrl"] is None
    assert login(client)["account"]["avatarUrl"] == customized["avatarUrl"]


def test_link_without_wechat_customization_inherits_web_then_delete_cleans(env):
    client, service = env
    wechat, web, other = login(client), login(client, provider="web"), login(client, "bob")
    old = update(client, web, displayName="保留我的昵称", avatarDataUrl=data_url(picture())).json()
    other_profile = update(client, other, avatarDataUrl=data_url(picture("JPEG"), "jpeg")).json()
    bound = link(client, wechat)
    assert bound["account"]["displayName"] == old["displayName"]
    assert bound["account"]["avatarUrl"] != old["avatarUrl"]
    assert client.get(old["avatarUrl"]).status_code == 404
    assert client.get(bound["account"]["avatarUrl"]).status_code == 200
    assert post(client, "account/delete", bound, {"code": "alice"}).status_code == 200
    assert client.get(bound["account"]["avatarUrl"]).status_code == 404
    assert client.get(other_profile["avatarUrl"]).status_code == 200
    preserved = login(client, provider="web")["account"]
    assert preserved["displayName"] == "alice" and preserved["avatarUrl"] is None
    with service.store.connect() as db:
        assert db.execute("SELECT uid FROM wx_profiles").fetchall() == [(other["account"]["uid"],)]


def test_room_profile_broadcast_keeps_game_revision_and_bytes_out_of_room(env):
    client, service = env
    host, guest = login(client), login(client, "bob")
    room = post(client, "rooms", host, {"gridSize": 5}).json()
    joined = post(client, "rooms/join", guest, {"code": room["code"]}).json()
    assert joined["playerProfiles"]["BLACK"]["displayName"] == "微信玩家"
    with client.websocket_connect("/api/wechat/ws") as socket:
        socket.send_json({"protocol": 1, "token": guest["token"], "code": room["code"]})
        before = socket.receive_json()["room"]
        changed = update(client, host, displayName="蓝方同学", avatarDataUrl=data_url(picture())).json()
        after = socket.receive_json()["room"]
        assert after["playerProfiles"]["BLACK"] == {key: changed[key] for key in ("uid", "displayName", "avatarUrl")}
        for key in ("revision", "seq", "stateHash", "actions"):
            assert after[key] == before[key]
        assert "base64" not in json.dumps(after)
    with service.store.connect() as db:
        document = db.execute("SELECT document FROM wx_rooms").fetchone()[0]
        assert "蓝方同学" not in document and "avatar" not in document


def test_delete_during_avatar_decode_cannot_resurrect_profile(env, monkeypatch):
    client, service = env
    session = login(client)
    started, release = threading.Event(), threading.Event()
    original = wx.decode_avatar

    def delayed(value):
        started.set()
        assert release.wait(5)
        return original(value)

    monkeypatch.setattr(wx, "decode_avatar", delayed)
    with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(update, client, session, avatarDataUrl=data_url(picture()))
        assert started.wait(5)
        try:
            assert post(client, "account/delete", session, {"code": "alice"}).status_code == 200
        finally:
            release.set()
        assert pending.result(timeout=5).status_code == 401
    with service.store.connect() as db:
        assert db.execute("SELECT count(*) FROM wx_profiles").fetchone()[0] == 0


def test_unlink_during_avatar_decode_revokes_former_web_session(env, monkeypatch):
    client, service = env
    bound = link(client, login(client))
    shared = login(client, provider="web")
    started, release = threading.Event(), threading.Event()
    original = wx.decode_avatar

    def delayed(value):
        started.set()
        assert release.wait(5)
        return original(value)

    monkeypatch.setattr(wx, "decode_avatar", delayed)
    with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(update, client, shared, displayName="过期修改", avatarDataUrl=data_url(picture()))
        assert started.wait(5)
        try:
            assert post(client, "account/unlink", bound, {"code": "alice"}).status_code == 200
        finally:
            release.set()
        response = pending.result(timeout=5)
        assert response.status_code == 401 and response.json()["detail"] == "ACCOUNT_SESSION_CHANGED"
    with service.store.connect() as db:
        assert db.execute("SELECT count(*) FROM wx_profiles").fetchone()[0] == 0


def test_v2_migration_preserves_identity_and_rejects_partial_profile_schema(env, tmp_path):
    _, service = env
    uid = service.store.identity("v2-fixture-subject")
    with service.store.connect() as db:
        db.execute("DROP TABLE wx_profiles")
        for table in wx.ladder.TABLES:
            db.execute(f"DROP TABLE {table}")
        db.execute("PRAGMA user_version=2")
    migrated = wx.WechatStore(service.store.database)
    assert migrated.identity("v2-fixture-subject") == uid
    with migrated.connect() as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 6
        db.execute("DROP TABLE wx_profiles")
        db.execute("CREATE TABLE wx_profiles (uid TEXT PRIMARY KEY, unexpected TEXT)")
    before = service.store.database.read_bytes()
    with pytest.raises(ValueError):
        wx.WechatStore(service.store.database)
    assert service.store.database.read_bytes() == before
