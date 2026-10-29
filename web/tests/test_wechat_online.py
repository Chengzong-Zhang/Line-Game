"""Real SQLite + Node rule validator; only WeChat code exchange is substituted."""
import importlib.util
from contextlib import closing
import asyncio
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import jwt

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("wechat_online", ROOT / "web/web后端/wechat_online.py")
wx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wx)

async def exchange(code, _app, _secret):
    if code not in ("blue", "red", "outsider"):
        wx.fail("LOGIN_FAILED", 401)
    return f"test-only-openid-{code}"


class WechatTests(unittest.TestCase):
    def test_current_room_metadata_allows_explicit_exit_and_new_room(self):
        current = self.client.get('/api/wechat/rooms/current', headers=self.auth['blue'])
        self.assertEqual(current.json(), {'room': None})
        room = self.post('rooms', payload={'gridSize': 7, 'rulesVersion': 'territory-v3',
                                          'protectionRule': 'duel-first-unprotected-v1', 'requireNew': True})
        metadata = self.client.get('/api/wechat/rooms/current', headers=self.auth['blue']).json()['room']
        self.assertEqual(metadata, {'code': room['code'], 'matchId': room['matchId'], 'status': 'waiting', 'rankedAI': False})
        self.assertEqual(self.client.get('/api/wechat/rooms/current', headers=self.auth['red']).json(), {'room': None})
        self.post('rooms', payload={'gridSize': 7, 'requireNew': True}, expected=409)
        self.post(f"rooms/{room['code']}/leave", payload={'matchId': room['matchId']})
        next_room = self.post('rooms', payload={'gridSize': 7, 'rulesVersion': 'territory-v3',
                                               'protectionRule': 'duel-first-unprotected-v1', 'requireNew': True})
        self.assertNotEqual(next_room['code'], room['code'])
        self.assertEqual(next_room['settings']['protectionRule'], 'duel-first-unprotected-v1')

    def test_legacy_room_rule_default_and_explicit_new_client_version(self):
        self.assertEqual(wx.WechatService.room_settings({"gridSize": 7})["rulesVersion"], "territory-v2")
        self.assertEqual(wx.WechatService.room_settings({"gridSize": 7, "rulesVersion": "territory-v3"})["rulesVersion"], "territory-v3")
        with self.assertRaises(HTTPException) as rejected:
            wx.WechatService.room_settings({"gridSize": 7, "rulesVersion": "territory-v1"})
        self.assertEqual(rejected.exception.status_code, 422)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / "wechat.sqlite3"
        self.service = wx.WechatService(wx.WechatStore(self.db), "test-app", "test-only-secret", "test-only-signing-key-32-characters-long", exchange=exchange)
        self.app = FastAPI()
        self.app.include_router(wx.create_router(self.service))
        self.client = TestClient(self.app)
        self.auth = {}
        for name in ("blue", "red", "outsider"):
            result = self.client.post("/api/wechat/login", json={"code": name})
            self.assertEqual(result.status_code, 200)
            self.auth[name] = {"Authorization": "Bearer " + result.json()["token"]}

    def tearDown(self):
        self.client.close()
        self.tmp.cleanup()

    def post(self, path, name="blue", payload=None, expected=200):
        r = self.client.post("/api/wechat/" + path, headers=self.auth[name], json=payload or {})
        self.assertEqual(r.status_code, expected, r.text)
        return r.json()

    def room(self):
        room = self.post("rooms", payload={"gridSize": 7})
        code = room["code"]
        self.post("rooms/join", "red", {"code": code})
        self.post(f"rooms/{code}/ready", payload={"matchId": room["matchId"]})
        return self.post(f"rooms/{code}/ready", "red", {"matchId": room["matchId"]})

    def action(self, room, name, kind, point=None, key="test-command-id-00000001"):
        payload = {"matchId": room["matchId"], "expectedSeq": room["seq"], "beforeHash": room["stateHash"],
                   "clientActionId": key, "action": {"type": kind}}
        if point is not None:
            payload["action"]["point"] = point
        return payload

    def test_identity_private_stable_and_fail_closed(self):
        token = self.auth["blue"]["Authorization"][7:]
        uid = self.service.authenticate(token)["sub"]
        second = self.client.post("/api/wechat/login", json={"code": "blue"}).json()["token"]
        self.assertEqual(self.service.authenticate(second)["sub"], uid)
        with closing(sqlite3.connect(self.db)) as db:
            raw = str(db.execute("SELECT * FROM wx_users").fetchall())
            self.assertNotIn("openid", raw)
        bad = self.client.post("/api/wechat/login", json={"code": "invalid"})
        self.assertEqual(bad.status_code, 401)
        self.assertEqual(self.client.post("/api/wechat/rooms", json={}).status_code, 401)
        app = FastAPI()
        app.include_router(wx.create_router())
        with patch.dict(wx.os.environ, {}, clear=True), TestClient(app) as client:
            self.assertFalse(client.get("/api/wechat/status").json()["enabled"])
            self.assertEqual(client.post("/api/wechat/login", json={"code": "a"}).status_code, 503)

    def test_rules_idempotency_stale_turn_and_restart(self):
        room = self.room()
        self.assertEqual(room["status"], "playing")
        payload = self.action(room, "blue", "move", [1, 0])
        endpoint = f"rooms/{room['code']}/actions"
        self.post(endpoint, "red", payload, 409)
        after = self.post(endpoint, payload=payload)
        self.assertEqual(after["seq"], 1)
        self.assertEqual(after["currentPlayer"], "WHITE")
        duplicate = self.post(endpoint, payload=payload)
        self.assertEqual(duplicate["stateHash"], after["stateHash"])
        self.assertEqual(duplicate["seq"], 1)
        self.post(endpoint, payload={**payload, "action": {"type": "skip"}}, expected=409)
        self.post(endpoint, payload={**payload, "clientActionId": "different-command-0001"}, expected=409)
        restored = wx.WechatStore(self.db).room(room["code"])
        self.assertEqual(restored["state"]["stateHash"], after["stateHash"])
        self.assertEqual(len(restored["actions"]), 1)

    def test_reject_illegal_move_without_mutation(self):
        room = self.room()
        payload = self.action(room, "blue", "move", [0, 0])
        self.post(f"rooms/{room['code']}/actions", payload=payload, expected=422)
        fresh = self.client.get(f"/api/wechat/rooms/{room['code']}", headers=self.auth["blue"]).json()
        self.assertEqual(fresh["stateHash"], room["stateHash"])
        self.assertEqual(fresh["seq"], 0)

    def test_online_board_settings_and_mutual_undo_survive_reload(self):
        settings = {"gridSize": 7, "boardShape": "hexagon", "startingPointMode": "custom",
                    "initialPositions": {"BLACK": [6, 1], "WHITE": [6, 11]},
                    "undoEnabled": True, "undoMaxCount": 2}
        room = self.post("rooms", payload=settings)
        code, match = room["code"], room["matchId"]
        self.assertEqual(room["settings"]["boardShape"], "hexagon")
        self.assertEqual(room["settings"]["initialPositions"], settings["initialPositions"])
        self.post(f"rooms/{code}/settings", "red", {"matchId": match, "settings": settings}, 403)
        changed = self.post(f"rooms/{code}/settings", payload={"matchId": match, "settings":
            {"gridSize": 7, "boardShape": "triangle", "undoEnabled": True, "undoMaxCount": 2}})
        self.assertEqual(changed["settings"]["boardShape"], "triangle")
        self.post("rooms/join", "red", {"code": code})
        self.post(f"rooms/{code}/ready", payload={"matchId": match})
        room = self.post(f"rooms/{code}/ready", "red", {"matchId": match})
        next_match = self.post(f"rooms/{code}/settings", payload={"matchId": match, "settings": settings})
        self.assertEqual(next_match["settings"]["boardShape"], "triangle")
        self.assertEqual(next_match["pendingSettings"]["boardShape"], "hexagon")
        room = self.post(f"rooms/{code}/actions", payload=self.action(room, "blue", "move", [1, 0]))
        vote = {"matchId": match, "expectedSeq": room["seq"], "beforeHash": room["stateHash"], "accept": True}
        pending = self.post(f"rooms/{code}/undo", payload=vote)
        self.assertEqual(pending["undo"]["votes"], ["BLACK"])
        self.post(f"rooms/{code}/actions", "red", self.action(room, "red", "skip", key="pending-action-00000001"), 409)
        restored = self.client.get(f"/api/wechat/rooms/{code}", headers=self.auth["red"]).json()
        self.assertTrue(restored["undo"]["pending"])
        rejected = self.post(f"rooms/{code}/undo", "red", {**vote, "accept": False})
        self.assertFalse(rejected["undo"]["pending"])
        self.post(f"rooms/{code}/undo", payload=vote)
        undone = self.post(f"rooms/{code}/undo", "red", vote)
        self.assertEqual(undone["seq"], 0)
        self.assertEqual(undone["undo"]["usedCount"], 1)
        self.assertEqual(undone["currentPlayer"], "BLACK")
        persisted = wx.WechatStore(self.db).room(code)
        self.assertEqual(persisted["undo"]["usedCount"], 1)
        self.assertEqual(persisted["state"]["stateHash"], undone["stateHash"])

    def test_undo_limit_accepts_100_and_rejects_outside_range(self):
        self.assertEqual(wx.WechatService.room_settings({"undoMaxCount": 100})["undoMaxCount"], 100)
        for count in (0, 101, True, 1.5):
            with self.assertRaises(HTTPException) as rejected:
                wx.WechatService.room_settings({"undoMaxCount": count})
            self.assertEqual(rejected.exception.status_code, 422)

    def test_requester_undo_rewinds_own_move_and_replies_repeatedly_after_restart(self):
        room = self.post("rooms", payload={"gridSize": 7, "undoEnabled": True, "undoMaxCount": 100})
        code, match = room["code"], room["matchId"]
        self.post("rooms/join", "red", {"code": code})
        self.post(f"rooms/{code}/ready", payload={"matchId": match})
        room = self.post(f"rooms/{code}/ready", "red", {"matchId": match})
        positions = [room]
        for index, point in enumerate(([1, 0], [2, 0], [0, 2], [3, 0], [1, 2], [5, 0])):
            player = "blue" if index % 2 == 0 else "red"
            room = self.post(f"rooms/{code}/actions", player, self.action(room, player, "move", point,
                key=f"undo-target-command-{index:04d}"))
            positions.append(room)
        for used, retained in enumerate((4, 2, 0), 1):
            vote = {"matchId": match, "expectedSeq": room["seq"], "beforeHash": room["stateHash"], "accept": True}
            pending = self.post(f"rooms/{code}/undo", payload=vote)
            self.assertEqual(pending["undo"]["requester"], "BLACK")
            self.assertEqual(pending["undo"]["actionIndex"], retained)
            # Reopen the durable store between request and confirmation.
            self.service.store = wx.WechatStore(self.db)
            room = self.post(f"rooms/{code}/undo", "red", vote)
            self.assertEqual(room["seq"], retained)
            self.assertEqual(room["actions"], positions[retained]["actions"])
            self.assertEqual(room["actionIds"], positions[retained]["actionIds"])
            self.assertEqual(room["stateHash"], positions[retained]["stateHash"])
            self.assertEqual(room["currentPlayer"], "BLACK")
            self.assertEqual(room["undo"], {"usedCount": used, "pending": False, "votes": []})

    def test_white_request_ignores_later_pass_and_cannot_target_an_unplayed_move(self):
        room = self.post("rooms", payload={"gridSize": 7, "undoEnabled": True})
        code, match = room["code"], room["matchId"]
        self.post("rooms/join", "red", {"code": code})
        self.post(f"rooms/{code}/ready", payload={"matchId": match})
        room = self.post(f"rooms/{code}/ready", "red", {"matchId": match})
        room = self.post(f"rooms/{code}/actions", payload=self.action(room, "blue", "move", [0, 1]))
        retained = room
        vote = {"matchId": match, "expectedSeq": room["seq"], "beforeHash": room["stateHash"], "accept": True}
        self.post(f"rooms/{code}/undo", "red", vote, expected=409)
        room = self.post(f"rooms/{code}/actions", "red", self.action(room, "red", "move", [5, 0], key="white-undo-move-00001"))
        room = self.post(f"rooms/{code}/actions", payload=self.action(room, "blue", "skip", key="black-pass-after-0001"))
        vote = {"matchId": match, "expectedSeq": room["seq"], "beforeHash": room["stateHash"], "accept": True}
        pending = self.post(f"rooms/{code}/undo", "red", vote)
        self.assertEqual(pending["undo"]["requester"], "WHITE")
        # Duplicated initiator approval retains its original target.
        self.post(f"rooms/{code}/undo", "red", vote)
        room = self.post(f"rooms/{code}/undo", payload=vote)
        self.assertEqual(room["stateHash"], retained["stateHash"])
        self.assertEqual(room["seq"], 1)
        self.assertEqual(room["currentPlayer"], "WHITE")

    def test_pass_settlement_two_votes_rematch_and_old_request_rejection(self):
        room = self.room()
        endpoint = f"rooms/{room['code']}/actions"
        room = self.post(endpoint, payload=self.action(room, "blue", "skip"))
        room = self.post(endpoint, "red", self.action(room, "red", "skip", key="test-command-id-00000002"))
        self.assertTrue(room["gameOver"])
        self.assertEqual(room["winner"], "DRAW")
        old = room["matchId"]
        rematch = f"rooms/{room['code']}/rematch"
        room = self.post(rematch, payload={"matchId": old})
        self.assertEqual(room["status"], "finished")
        room = self.post(rematch, "red", {"matchId": old})
        self.assertNotEqual(room["matchId"], old)
        self.assertEqual(room["seq"], 0)
        self.assertEqual(room["status"], "waiting")
        self.post(endpoint, payload={"matchId": old}, expected=409)

    def test_member_access_and_expiry(self):
        room = self.room()
        code = room["code"]
        self.assertEqual(self.client.get(f"/api/wechat/rooms/{code}", headers=self.auth["outsider"]).status_code, 403)
        self.post("rooms/join", "outsider", {"code": code}, 409)
        with self.service.store.connect() as db:
            db.execute("UPDATE wx_rooms SET expires=? WHERE code=?", (int(time.time()) - 1, code))
        self.assertEqual(self.client.get(f"/api/wechat/rooms/{code}", headers=self.auth["blue"]).status_code, 410)

    def test_socket_sync_broadcast_and_reconnect_after_missed_action(self):
        room = self.room()
        code = room["code"]
        hello = {"protocol": 1, "code": code, "token": self.auth["blue"]["Authorization"][7:]}
        with self.client.websocket_connect("/api/wechat/ws") as socket:
            socket.send_json(hello)
            self.assertEqual(socket.receive_json()["room"]["seq"], 0)
            socket.send_text('{"type":"ping"}')
            self.assertEqual(socket.receive_json(), {"type": "pong"})
            updated = self.post(f"rooms/{code}/actions", payload=self.action(room, "blue", "move", [1, 0]))
            self.assertEqual(socket.receive_json()["room"]["stateHash"], updated["stateHash"])
        after = self.post(f"rooms/{code}/actions", "red", self.action(updated, "red", "skip", key="test-command-id-00000002"))
        with self.client.websocket_connect("/api/wechat/ws") as socket:
            socket.send_json(hello)
            sync = socket.receive_json()["room"]
            self.assertEqual(sync["seq"], 2)
            self.assertEqual(sync["stateHash"], after["stateHash"])

    def test_expired_and_wrong_audience_tokens(self):
        for claims in [{"exp": 1}, {"aud": "web-account"}]:
            base = self.service.authenticate(self.auth["blue"]["Authorization"][7:])
            token = jwt.encode({**base, **claims}, self.service.token_secret, algorithm="HS256")
            self.assertEqual(self.client.post("/api/wechat/rooms", headers={"Authorization": "Bearer " + token}, json={}).status_code, 401)

    def test_payload_limits_and_closed_room(self):
        self.assertEqual(self.client.post("/api/wechat/login", content=b"x" * 9000).status_code, 413)
        self.assertEqual(self.client.post("/api/wechat/login", content=b'{"code":NaN}').status_code, 422)
        room = self.post("rooms")
        closed = self.post(f"rooms/{room['code']}/leave", payload={"matchId": room["matchId"]})
        self.assertEqual(closed["status"], "closed")
        self.post(f"rooms/{room['code']}/ready", payload={"matchId": room["matchId"]}, expected=410)

    def test_sqlite_compare_and_swap_preserves_accepted_state(self):
        room = self.service.store.room(self.room()["code"])
        revision = room["revision"]
        room["revision"] += 1
        self.service.store.commit(room, revision)
        with self.assertRaises(wx.HTTPException):
            self.service.store.commit(room, revision)

    def test_account_deletion_requires_same_fresh_identity_and_revokes_old_tokens(self):
        room = self.room()
        uid = self.service.authenticate(self.auth["blue"]["Authorization"][7:])["sub"]
        self.post("account/delete", payload={"code": "red"}, expected=403)
        self.assertIsNotNone(self.service.store.subject(uid))
        self.assertEqual(self.service.store.room(room["code"])["seq"], 0)
        self.post(f"rooms/{room['code']}/actions", payload=self.action(room, "blue", "move", [1, 0]))
        deleted = self.post("account/delete", payload={"code": "blue"})
        self.assertTrue(deleted["deleted"])
        self.assertEqual(deleted["roomsDeleted"], 1)
        with self.service.store.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM wx_rooms").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT count(*) FROM wx_commands").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT count(*) FROM wx_users").fetchone()[0], 2)
        rejected = self.client.post("/api/wechat/rooms", headers=self.auth["blue"], json={})
        self.assertEqual(rejected.status_code, 401)
        self.assertEqual(rejected.json()["detail"], "ACCOUNT_DELETED")
        # Lost deletion replies are safe to retry with the original token.
        self.assertTrue(self.post("account/delete", payload={"code": "blue"})["deleted"])
        self.assertIsNotNone(self.service.store.subject(self.service.authenticate(self.auth["red"]["Authorization"][7:])["sub"]))
        with self.assertRaises(wx.HTTPException) as queued:
            asyncio.run(self.service._mutate(uid, "create", {"gridSize": 7}, None))
        self.assertEqual(queued.exception.detail, "ACCOUNT_DELETED")
        fresh = self.client.post("/api/wechat/login", json={"code": "blue"}).json()["token"]
        self.assertNotEqual(self.service.authenticate(fresh)["sub"], uid)

    def test_account_deletion_closes_both_sockets_without_revoking_the_other_account(self):
        room = self.room()
        with self.client.websocket_connect("/api/wechat/ws") as blue, self.client.websocket_connect("/api/wechat/ws") as red:
            for socket, name in [(blue, "blue"), (red, "red")]:
                socket.send_json({"protocol": 1, "code": room["code"], "token": self.auth[name]["Authorization"][7:]})
                socket.receive_json()
            self.post("account/delete", payload={"code": "blue"})
            self.assertEqual(blue.receive()["code"], 4008)
            self.assertEqual(red.receive()["code"], 4010)
        self.assertEqual(self.client.get(f"/api/wechat/rooms/{room['code']}", headers=self.auth["red"]).status_code, 404)
        self.assertEqual(self.post("rooms", "red", {"gridSize": 7})["status"], "waiting")

    def test_deletion_closes_a_socket_whose_expired_room_was_already_pruned(self):
        room = self.room()
        with self.client.websocket_connect("/api/wechat/ws") as socket:
            socket.send_json({"protocol": 1, "code": room["code"], "token": self.auth["blue"]["Authorization"][7:]})
            socket.receive_json()
            # Simulate the existing expired-room cleanup while an idle socket still exists.
            with self.service.store.connect() as db:
                db.execute("DELETE FROM wx_rooms WHERE code=?", (room["code"],))
            self.assertEqual(self.post("account/delete", payload={"code": "blue"})["roomsDeleted"], 0)
            self.assertEqual(socket.receive()["code"], 4008)

    def test_code_exchange_has_fixed_tls_destination_no_redirect_and_discards_session_key(self):
        class Response:
            status = 200
            def read(self, limit):
                return b'{"openid":"test-openid", "session_key":"test-only-private"}'
        class Connection:
            def __init__(self, host, timeout):
                self.assertions = (host, timeout)
                assert host == "api.weixin.qq.com" and timeout == 8
            def request(self, method, path):
                assert method == "GET" and path.startswith("/sns/jscode2session?")
            def getresponse(self):
                return Response()
            def close(self):
                pass
        with patch.object(wx.http_client, "HTTPSConnection", Connection):
            self.assertEqual(asyncio.run(wx.exchange_wechat("one-time", "app", "secret")), "test-openid")
            Response.status = 302
            with self.assertRaises(wx.HTTPException) as failure:
                asyncio.run(wx.exchange_wechat("one-time", "app", "secret"))
            self.assertEqual(failure.exception.status_code, 503)

if __name__ == "__main__":
    unittest.main()
