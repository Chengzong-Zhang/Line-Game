"""15-seat rooms through both existing Python services and the real JS rules."""
import asyncio
from copy import deepcopy
import importlib.util
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "web/web后端"
sys.path.insert(0, str(BACKEND))
import server

spec = importlib.util.spec_from_file_location("fifteen_wechat", BACKEND / "wechat_online.py")
wx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wx)


class Socket:
    def __init__(self, name):
        self.state = SimpleNamespace(username=name)
        self.messages = []

    async def send_json(self, value):
        self.messages.append(deepcopy(value))

    async def close(self, **_):
        pass


class FifteenPlayerRooms(unittest.IsolatedAsyncioTestCase):
    async def test_legacy_fifteen_seats_reconnect_and_new_opening(self):
        manager = server.ConnectionManager()
        try:
            sockets = [Socket(f"fifteen-{index}") for index in range(15)]
            await manager.create_room(sockets[0], sockets[0].state.username,
                                      {"playerCount": 15, "gridSize": 7, "startPlayer": "CORAL"})
            room = manager.rooms[sockets[0].messages[-1]["roomId"]]
            for socket in sockets[1:]:
                await manager.join_room(socket, room.room_id, socket.state.username)
            self.assertEqual([player.color for player in room.players.values()], list(server.PLAYER_COLORS))
            self.assertEqual(room.settings["startingPointMode"], "random")
            starts = deepcopy(room.settings["initialPositions"])
            self.assertEqual(len({tuple(point) for point in starts.values()}), 15)
            extra = Socket("overflow")
            await manager.join_room(extra, room.room_id, extra.state.username)
            self.assertEqual(extra.messages[-1]["code"], "ROOM_FULL")
            with patch.object(server, "READY_COUNTDOWN_SECONDS", 0):
                for socket in sockets:
                    await manager.set_player_ready(socket, True)
                await room.countdown_task
            self.assertTrue(room.match_started)
            await manager.forward_skip(sockets[-1])
            await manager.disconnect(sockets[-1])
            replacement = Socket(sockets[-1].state.username)
            await manager.join_room(replacement, room.room_id, replacement.state.username)
            joined = next(message for message in replacement.messages if message["type"] == "ROOM_JOINED")
            self.assertEqual(joined["yourColor"], "CORAL")
            self.assertEqual(joined["settings"]["initialPositions"], starts)
            self.assertEqual(joined["matchState"]["actions"], room.actions)
            await manager.update_room_settings(sockets[0], {**room.settings, "playerCount": 6})
            self.assertEqual(sockets[0].messages[-1]["type"], "ERROR")
            await manager.forward_reset(sockets[0], "normal_restart")
            self.assertEqual(room.settings["playerCount"], 15)
            self.assertNotEqual(room.settings["initialPositions"], starts)
        finally:
            await manager.stop()

    async def test_shared_fifteen_humans_start_act_and_restore(self):
        with tempfile.TemporaryDirectory(prefix="lifeline-fifteen-") as folder:
            store = wx.WechatStore(Path(folder) / "rooms.sqlite3")
            service = wx.WechatService(store, "fixture-app", "fixture-secret", "fixture-signing-key-at-least-32-characters")
            try:
                users = [store.identity(f"fifteen-{index}") for index in range(15)]
                config = {"playerCount": 15, "gridSize": 7, "rulesVersion": "territory-v3",
                          "startPlayer": "CORAL", "startingPointMode": "random"}
                room = await service.mutate(users[0], "create", config)
                starts = deepcopy(room["settings"]["initialPositions"])
                for user in users[1:]:
                    room = await service.mutate(user, "join", {}, room["code"])
                self.assertEqual(set(room["scores"]), set(wx.PLAYER_COLORS))
                self.assertTrue(all(room["members"].values()))
                self.assertEqual(room["settings"]["initialPositions"], starts)
                for user in users:
                    room = await service.mutate(user, "ready", {"matchId": room["matchId"]}, room["code"])
                self.assertEqual(room["status"], "playing")
                room = await service.mutate(users[-1], "actions", {
                    "matchId": room["matchId"], "expectedSeq": room["seq"], "beforeHash": room["stateHash"],
                    "clientActionId": "fifteen-player-skip", "action": {"type": "skip"},
                }, room["code"])
                self.assertEqual(room["actions"][0]["player"], "CORAL")
                persisted = store.room(room["code"])
                verified = await asyncio.to_thread(wx.verify_rules, persisted["settings"], persisted["actions"])
                self.assertEqual(verified["stateHash"], room["stateHash"])
                reloaded = wx.WechatStore(Path(folder) / "rooms.sqlite3").room(room["code"])
                self.assertEqual(reloaded["settings"]["initialPositions"], starts)
                self.assertEqual(len(reloaded["players"]), 15)
                self.assertEqual(reloaded["state"]["stateHash"], room["stateHash"])
            finally:
                tasks = list(service.bot_tasks.values()) + list(service.timer_tasks.values())
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)

    def test_strict_seven_to_fifteen_modes_and_model_scope(self):
        for count in range(7, 16):
            for shape in ("triangle", "hexagon"):
                with self.subTest(players=count, board=shape):
                    with self.assertRaises(wx.HTTPException):
                        wx.WechatService.room_settings({"playerCount": count, "boardShape": shape})
                    settings = wx.WechatService.room_settings({"playerCount": count, "gridSize": 5,
                                                               "boardShape": shape, "startingPointMode": "random"})
                    starts = settings["initialPositions"]
                    self.assertEqual(len({tuple(point) for point in starts.values()}), count)
                    settings["startingPointMode"] = "custom"
                    self.assertEqual(wx.WechatService.room_settings(settings)["initialPositions"], starts)
                    settings["playerSetup"] = {color: {"choice": "human"} for color in wx.PLAYER_COLORS[:count]}
                    settings["playerSetup"]["WHITE"] = {"choice": "ai-medium"}
                    with self.assertRaises(wx.HTTPException):
                        wx.WechatService.room_settings(settings)
        for count in (1, 16, True, 7.5):
            self.assertEqual(server.ConnectionManager()._normalize_room_settings({"playerCount": count})["playerCount"], 2)


if __name__ == "__main__":
    unittest.main()
