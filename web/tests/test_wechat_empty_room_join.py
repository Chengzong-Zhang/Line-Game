"""Room switching with real SQLite and the selected backend's Node rule verifier.

Set LIFELINE_JOIN_API_PATH to run against an isolated frozen service source.
No WeChat credentials, remote account, or production database is involved.
"""
import asyncio
import argparse
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[2]
PROBE_OPTIONS = None
if __name__ == "__main__" and "--service-root" in sys.argv:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--service-root", type=Path, required=True)
    parser.add_argument("--fake-verifier", action="store_true", default=True)
    parser.add_argument("--real-verifier", action="store_false", dest="fake_verifier")
    PROBE_OPTIONS = parser.parse_args()
    os.environ["LIFELINE_JOIN_API_PATH"] = str(PROBE_OPTIONS.service_root.resolve() / "web/web后端/wechat_online.py")
SOURCE = Path(os.getenv("LIFELINE_JOIN_API_PATH", ROOT / "web/web后端/wechat_online.py"))
spec = importlib.util.spec_from_file_location("wechat_empty_room_join", SOURCE)
wx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wx)
if os.getenv("LIFELINE_JOIN_VALIDATOR_PATH"):
    wx.VALIDATOR = Path(os.environ["LIFELINE_JOIN_VALIDATOR_PATH"]).resolve()


class Socket:
    def __init__(self):
        self.messages = []

    async def send_json(self, message):
        self.messages.append(message)


class EmptyRoomJoinTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="lifeline-empty-room-join-")
        self.store = wx.WechatStore(Path(self.tmp.name) / "rooms.sqlite3")
        self.service = wx.WechatService(self.store, "fixture-app", "fixture-secret",
                                       "fixture-signing-key-at-least-32-characters")
        if PROBE_OPTIONS and PROBE_OPTIONS.fake_verifier:
            # This probe isolates durable room logic. Root runs the real compiled
            # rule/HTTP/WebSocket integration separately before deployment.
            self.service.verifier = lambda settings, actions: {
                "stateHash": "synthetic-empty-position", "currentPlayer": "BLACK",
                "gameOver": False, "winner": None, "scores": {"BLACK": 0, "WHITE": 0}}
        self.serial = 0

    async def asyncTearDown(self):
        self.tmp.cleanup()

    async def pair(self):
        self.serial += 1
        host = self.store.identity(f"fixture-host-{self.serial}")
        guest = self.store.identity(f"fixture-guest-{self.serial}")
        target = await self.service.mutate(host, "create", {"gridSize": 7})
        previous = await self.service.mutate(guest, "create", {"gridSize": 7})
        return host, guest, target, previous

    async def join(self, uid, room):
        return await self.service.mutate(uid, "join", {"code": room["code"]}, room["code"])

    def rewrite(self, code, modify):
        room = self.store.room(code)
        previous = room["revision"]
        modify(room)
        room["revision"] += 1
        self.store.commit(room, previous)
        return room

    async def assert_rejected_without_changes(self, uid, target, previous, detail):
        before_target = self.store.room(target["code"])
        before_previous = self.store.room(previous["code"])
        with self.assertRaises(wx.HTTPException) as result:
            await self.join(uid, target)
        self.assertEqual(result.exception.detail, detail)
        self.assertEqual(self.store.room(target["code"]), before_target)
        self.assertEqual(self.store.room(previous["code"]), before_previous)

    async def test_join_replaces_own_empty_waiting_room_and_survives_store_restart(self):
        host, guest, target, previous = await self.pair()
        old_before = self.store.room(previous["code"])
        target_before = self.store.room(target["code"])
        joined = await self.join(guest, target)
        self.assertEqual(joined["code"], target["code"])
        self.assertEqual(joined["player"], "WHITE")
        self.assertEqual(joined["members"], {"BLACK": True, "WHITE": True})
        restarted = wx.WechatStore(self.store.database)
        old_expected = {**old_before, "status": "closed", "revision": old_before["revision"] + 1}
        self.assertEqual(restarted.room(previous["code"]), old_expected)
        target_after = restarted.room(target["code"])
        self.assertEqual(target_after["players"], {"BLACK": host, "WHITE": guest})
        for key in ("matchId", "settings", "state", "seq", "actions", "actionIds", "ready", "rematchVotes"):
            self.assertEqual(target_after[key], target_before[key])
        self.assertEqual(restarted.active_room(guest)["code"], target["code"])

    async def test_old_socket_gets_closed_room_without_target_room_details(self):
        host, guest, target, previous = await self.pair()
        old_socket, host_socket = Socket(), Socket()
        self.service.connections[previous["code"]] = {guest: old_socket}
        self.service.connections[target["code"]] = {host: host_socket}
        await self.join(guest, target)
        self.assertEqual(len(old_socket.messages), 1)
        self.assertEqual(old_socket.messages[0]["room"]["code"], previous["code"])
        self.assertEqual(old_socket.messages[0]["room"]["status"], "closed")
        self.assertNotIn(target["code"], str(old_socket.messages))
        self.assertEqual(host_socket.messages[0]["room"]["members"], {"BLACK": True, "WHITE": True})

    async def test_failed_old_socket_does_not_turn_committed_join_into_failure(self):
        _, guest, target, previous = await self.pair()

        class FailedSocket:
            async def send_json(self, message):
                raise ConnectionError("fixture old socket disconnected")

            async def close(self, code):
                pass

        self.service.connections[previous["code"]] = {guest: FailedSocket()}
        joined = await self.join(guest, target)
        self.assertEqual(joined["code"], target["code"])
        self.assertEqual(self.store.room(previous["code"])["status"], "closed")
        self.assertNotIn(previous["code"], self.service.connections)

    async def test_rejoin_same_room_is_idempotent(self):
        _, guest, _, previous = await self.pair()
        before = self.store.room(previous["code"])
        joined = await self.join(guest, previous)
        self.assertEqual(joined["player"], "BLACK")
        self.assertEqual(self.store.room(previous["code"]), before)

    async def test_owner_ready_empty_room_can_switch_without_inheriting_its_ready_vote(self):
        host, guest, target, previous = await self.pair()
        for uid, room in ((host, target), (guest, previous)):
            await self.service.mutate(uid, "ready", {"matchId": room["matchId"]}, room["code"])
        before = self.store.room(previous["code"])
        self.assertTrue(before["ready"]["BLACK"])
        joined = await self.join(guest, target)
        self.assertEqual(joined["code"], target["code"])
        self.assertEqual(joined["status"], "waiting")
        self.assertEqual(joined["ready"], {"BLACK": True, "WHITE": False})
        self.assertEqual(self.store.room(previous["code"]),
                         {**before, "status": "closed", "revision": before["revision"] + 1})
        started = await self.service.mutate(guest, "ready", {"matchId": joined["matchId"]}, joined["code"])
        self.assertEqual(started["status"], "playing")

    async def test_ready_history_and_started_rooms_are_never_abandoned(self):
        cases = {
            "other_ready": lambda r: r["ready"].update(WHITE=True),
            "rematch_vote": lambda r: r["rematchVotes"].update(BLACK=True),
            "seq": lambda r: r.update(seq=1),
            "actions": lambda r: r["actions"].append({"type": "skip", "player": "BLACK"}),
            "action_ids": lambda r: r["actionIds"].append("fixture-action-id-0001"),
            "playing": lambda r: r.update(status="playing"),
            "finished": lambda r: r.update(status="finished"),
        }
        for name, modify in cases.items():
            with self.subTest(name=name):
                _, guest, target, previous = await self.pair()
                self.rewrite(previous["code"], modify)
                await self.assert_rejected_without_changes(guest, target, previous, "ALREADY_IN_ROOM")

    async def test_previous_room_with_another_player_is_never_abandoned(self):
        _, guest, target, previous = await self.pair()
        other = self.store.identity("fixture-third-player")
        await self.join(other, previous)
        await self.assert_rejected_without_changes(guest, target, previous, "ALREADY_IN_ROOM")

    async def test_full_or_closed_target_does_not_close_previous_room(self):
        for full in (True, False):
            with self.subTest(full=full):
                _, guest, target, previous = await self.pair()
                if full:
                    other = self.store.identity(f"fixture-target-third-{self.serial}")
                    await self.join(other, target)
                else:
                    self.rewrite(target["code"], lambda r: r.update(status="closed"))
                await self.assert_rejected_without_changes(guest, target, previous, "ROOM_FULL" if full else "ROOM_CLOSED")

    async def test_missing_or_expired_target_does_not_close_previous_room(self):
        for expired in (False, True):
            with self.subTest(expired=expired):
                _, guest, target, previous = await self.pair()
                before = self.store.room(previous["code"])
                if expired:
                    with self.store.connect() as db:
                        db.execute("UPDATE wx_rooms SET expires=? WHERE code=?", (int(time.time()) - 1, target["code"]))
                else:
                    target = {"code": "ZZZZZZZZ"}
                with self.assertRaises(wx.HTTPException) as result:
                    await self.join(guest, target)
                self.assertEqual(result.exception.detail, "ROOM_EXPIRED" if expired else "ROOM_NOT_FOUND")
                self.assertEqual(self.store.room(previous["code"]), before)

    async def test_second_database_write_failure_rolls_back_both_rooms(self):
        _, guest, target, previous = await self.pair()
        before_target, before_old = self.store.room(target["code"]), self.store.room(previous["code"])
        with self.store.connect() as db:
            db.execute("CREATE TRIGGER fixture_reject_join BEFORE UPDATE ON wx_rooms WHEN OLD.code='" +
                       target["code"] + "' BEGIN SELECT RAISE(ABORT,'fixture target write failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            await self.join(guest, target)
        self.assertEqual(self.store.room(target["code"]), before_target)
        self.assertEqual(self.store.room(previous["code"]), before_old)
        self.assertEqual(self.store.active_room(guest)["code"], previous["code"])

    async def test_second_compare_and_swap_failure_rolls_back_first_room_write(self):
        _, guest, target, previous = await self.pair()
        old, destination = self.store.room(previous["code"]), self.store.room(target["code"])
        old_expected, target_expected = copy.deepcopy(old), copy.deepcopy(destination)
        old.update(status="closed", revision=old["revision"] + 1)
        destination["players"]["WHITE"] = guest
        destination["revision"] += 1
        with self.assertRaises(wx.HTTPException) as result:
            self.store.commit_room_switch(old, old_expected["revision"], destination, target_expected["revision"] - 1)
        self.assertEqual(result.exception.detail, "STALE_ROOM")
        self.assertEqual(self.store.room(previous["code"]), old_expected)
        self.assertEqual(self.store.room(target["code"]), target_expected)

    async def test_simultaneous_joiners_keep_losing_joiners_previous_room(self):
        _, first, target, first_previous = await self.pair()
        second = self.store.identity("fixture-second-joiner")
        second_previous = await self.service.mutate(second, "create", {"gridSize": 7})
        outcomes = await asyncio.gather(self.join(first, target), self.join(second, target), return_exceptions=True)
        self.assertIsInstance(outcomes[0], dict)
        self.assertIsInstance(outcomes[1], wx.HTTPException)
        self.assertEqual(outcomes[1].detail, "ROOM_FULL")
        self.assertEqual(self.store.room(first_previous["code"])["status"], "closed")
        self.assertEqual(self.store.room(second_previous["code"])["status"], "waiting")
        self.assertEqual(self.store.room(target["code"])["players"]["WHITE"], first)


if __name__ == "__main__":
    if PROBE_OPTIONS:
        report = io.StringIO()
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(EmptyRoomJoinTests)
        result = unittest.TextTestRunner(stream=report).run(suite)
        receipt = {"status": "PASS_JOIN_FIX_SYNTHETIC" if result.wasSuccessful() else "FAIL_JOIN_FIX_SYNTHETIC",
                   "tests": result.testsRun, "failures": len(result.failures), "errors": len(result.errors),
                   "skipped": len(result.skipped), "fakeVerifier": PROBE_OPTIONS.fake_verifier,
                   "sourceSha256": __import__("hashlib").sha256(SOURCE.read_bytes()).hexdigest()}
        if not result.wasSuccessful():
            receipt["details"] = report.getvalue()
        print(json.dumps(receipt, sort_keys=True))
        raise SystemExit(0 if result.wasSuccessful() else 1)
    unittest.main()
