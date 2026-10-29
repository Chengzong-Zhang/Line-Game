"""Diamond-board room settings stay authoritative across both online services."""

import asyncio
from copy import deepcopy
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "web/web后端"
sys.path.insert(0, str(BACKEND))
import server

spec = importlib.util.spec_from_file_location("diamond_wechat", BACKEND / "wechat_online.py")
wx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wx)


class DiamondRoomSettingsTests(unittest.IsolatedAsyncioTestCase):
    def test_legacy_relay_normalizes_diamond_geometry_and_explicit_roots(self):
        manager = server.ConnectionManager()
        duel = manager._normalize_room_settings({
            "playerCount": 2, "gridSize": 5, "boardShape": "diamond",
        })
        self.assertEqual(duel["boardShape"], "diamond")
        self.assertNotIn("startingPointMode", duel)

        multiplayer = manager._normalize_room_settings({
            "playerCount": 3, "gridSize": 5, "boardShape": "diamond",
        })
        self.assertEqual(multiplayer["startingPointMode"], "random")
        self.assertEqual(set(multiplayer["initialPositions"]), set(server.PLAYER_COLORS[:3]))
        self.assertEqual(len({tuple(point) for point in multiplayer["initialPositions"].values()}), 3)
        self.assertTrue(all(0 <= axis <= 4 for point in multiplayer["initialPositions"].values()
                            for axis in point))

        custom = {"BLACK": [0, 0], "WHITE": [4, 4], "PURPLE": [4, 1]}
        normalized = manager._normalize_room_settings({
            "playerCount": 3, "gridSize": 5, "boardShape": "diamond",
            "startingPointMode": "custom", "initialPositions": custom,
        })
        self.assertEqual(normalized["startingPointMode"], "custom")
        self.assertEqual(normalized["initialPositions"], custom)
        self.assertGreater(sum(normalized["initialPositions"]["WHITE"]), 4)

        invalid = manager._normalize_room_settings({
            "playerCount": 3, "gridSize": 5, "boardShape": "diamond",
            "startingPointMode": "custom",
            "initialPositions": {**custom, "WHITE": [5, 0]},
        })
        self.assertEqual(invalid["startingPointMode"], "random")
        self.assertNotEqual(invalid["initialPositions"], custom)

    def test_random_diamond_positions_use_the_whole_square_domain(self):
        starts = server.random_initial_positions(5, 15, "diamond", None)
        self.assertEqual(len(starts), 15)
        self.assertEqual(len({tuple(point) for point in starts.values()}), 15)
        self.assertTrue(all(0 <= axis <= 4 for point in starts.values() for axis in point))
        # Fifteen spread-out roots cannot all fit in the 5-side triangle's 15
        # points without using its far diagonal; this also guards the old
        # "every non-hex shape is triangular" branch.
        self.assertTrue(any(x + y > 4 for x, y in starts.values()))

    def test_wechat_settings_accept_diamond_custom_and_reject_out_of_bounds(self):
        duel = wx.WechatService.room_settings({
            "playerCount": 2, "gridSize": 5, "boardShape": "diamond",
        })
        self.assertEqual(duel["boardShape"], "diamond")
        self.assertNotIn("startingPointMode", duel)

        automatic = wx.WechatService.room_settings({
            "playerCount": 3, "gridSize": 5, "boardShape": "diamond",
        })
        self.assertEqual(automatic["startingPointMode"], "random")
        self.assertEqual(len({tuple(point) for point in automatic["initialPositions"].values()}), 3)

        custom = {"BLACK": [0, 0], "WHITE": [4, 4], "PURPLE": [4, 1]}
        normalized = wx.WechatService.room_settings({
            "playerCount": 3, "gridSize": 5, "boardShape": "diamond",
            "rulesVersion": "territory-v3",
            "startingPointMode": "custom", "initialPositions": custom,
        })
        self.assertEqual(normalized["initialPositions"], custom)
        validated = wx.verify_rules(normalized, [])
        self.assertEqual(validated["currentPlayer"], "BLACK")
        self.assertEqual(set(validated["scores"]), set(wx.PLAYER_COLORS[:3]))

        with self.assertRaises(wx.HTTPException):
            wx.WechatService.room_settings({
                "playerCount": 3, "gridSize": 5, "boardShape": "diamond",
                "startingPointMode": "custom",
                "initialPositions": {**custom, "WHITE": [5, 0]},
            })

        for size in (5, 15):
            crowded = wx.WechatService.room_settings({
                "playerCount": 15, "gridSize": size, "boardShape": "diamond",
            })
            self.assertEqual(crowded["startingPointMode"], "random")
            self.assertEqual(len(crowded["initialPositions"]), 15)
            self.assertEqual(len({tuple(point) for point in crowded["initialPositions"].values()}), 15)
            self.assertTrue(all(0 <= axis < size for point in crowded["initialPositions"].values()
                                for axis in point))
            validated = wx.verify_rules(crowded, [])
            self.assertEqual(set(validated["scores"]), set(wx.PLAYER_COLORS[:15]))

    def test_wechat_diamond_ai_profiles_are_explicit_and_fail_closed(self):
        version = "2026092201"
        player = lambda choice, depth=3: {"choice": choice, "depth": depth, "version": version}
        duel = wx.WechatService.room_settings({
            "playerCount": 2, "gridSize": 5, "boardShape": "diamond",
            "playerSetup": {"BLACK": player("human"), "WHITE": player("minimax", 4)},
        })
        self.assertEqual(duel["playerSetup"]["WHITE"]["choice"], "minimax")

        multiplayer = wx.WechatService.room_settings({
            "playerCount": 3, "gridSize": 5, "boardShape": "diamond",
            "playerSetup": {
                "BLACK": player("human"), "WHITE": player("ai-easy"),
                "PURPLE": player("ai-hard"),
            },
        })
        self.assertEqual([multiplayer["playerSetup"][color]["choice"]
                          for color in ("BLACK", "WHITE", "PURPLE")],
                         ["human", "ai-easy", "ai-hard"])

        for players, choice in ((2, "grid-gnn"), (3, "greedy"), (3, "ai-medium"),
                                (3, "ai-ultimate"), (3, "three-player"), (3, "hex-player")):
            colors = wx.PLAYER_COLORS[:players]
            setup = {color: player("human") for color in colors}
            setup[colors[-1]] = player(choice)
            with self.subTest(players=players, choice=choice), self.assertRaises(wx.HTTPException) as denied:
                wx.WechatService.room_settings({
                    "playerCount": players, "gridSize": 5, "boardShape": "diamond",
                    "playerSetup": setup,
                })
            self.assertEqual(denied.exception.detail, "INVALID_SETTINGS")

    async def test_wechat_authoritative_random_roots_survive_join_and_reload(self):
        with tempfile.TemporaryDirectory(prefix="lifeline-diamond-room-") as folder:
            database = Path(folder) / "rooms.sqlite3"
            store = wx.WechatStore(database)
            service = wx.WechatService(
                store, "fixture-app", "fixture-secret",
                "fixture-signing-key-at-least-32-characters",
                verifier=lambda *_: {
                    "stateHash": "diamond-settings-fixture", "currentPlayer": "BLACK",
                    "gameOver": False, "winner": None, "scores": {},
                },
            )
            users = [store.identity(f"diamond-{index}") for index in range(3)]
            try:
                room = await service.mutate(users[0], "create", {
                    "playerCount": 3, "gridSize": 5, "boardShape": "diamond",
                    "rulesVersion": "territory-v3",
                })
                starts = deepcopy(room["settings"]["initialPositions"])
                self.assertEqual(room["settings"]["startingPointMode"], "random")
                for user in users[1:]:
                    joined = await service.mutate(user, "join", {}, room["code"])
                    self.assertEqual(joined["settings"]["initialPositions"], starts)

                reloaded = wx.WechatStore(database).room(room["code"])
                self.assertEqual(reloaded["settings"]["initialPositions"], starts)
                self.assertEqual(reloaded["settings"]["boardShape"], "diamond")
            finally:
                tasks = list(service.bot_tasks.values()) + list(service.timer_tasks.values())
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)

    async def test_wechat_random_diamond_roots_redraw_only_after_unanimous_rematch(self):
        with tempfile.TemporaryDirectory(prefix="lifeline-diamond-rematch-") as folder:
            store = wx.WechatStore(Path(folder) / "rooms.sqlite3")
            service = wx.WechatService(
                store, "fixture-app", "fixture-secret",
                "fixture-signing-key-at-least-32-characters",
                verifier=lambda *_: {
                    "stateHash": "diamond-rematch-fixture", "currentPlayer": "BLACK",
                    "gameOver": False, "winner": None, "scores": {},
                },
            )
            users = [store.identity(f"diamond-rematch-{index}") for index in range(3)]
            try:
                room = await service.mutate(users[0], "create", {
                    "playerCount": 3, "gridSize": 5, "boardShape": "diamond",
                    "rulesVersion": "territory-v3",
                })
                for user in users[1:]:
                    room = await service.mutate(user, "join", {}, room["code"])
                starts = deepcopy(room["settings"]["initialPositions"])

                document = store.room(room["code"])
                revision = document["revision"]
                document["status"] = "finished"
                document["revision"] += 1
                store.commit(document, revision)

                for user in users[:-1]:
                    vote = await service.mutate(user, "rematch", {"matchId": room["matchId"]}, room["code"])
                    self.assertEqual(vote["settings"]["initialPositions"], starts)
                    self.assertEqual(vote["matchId"], room["matchId"])
                rematch = await service.mutate(users[-1], "rematch", {"matchId": room["matchId"]}, room["code"])
                self.assertNotEqual(rematch["matchId"], room["matchId"])
                self.assertNotEqual(rematch["settings"]["initialPositions"], starts)
                self.assertEqual(rematch["settings"]["boardShape"], "diamond")
                self.assertEqual(rematch["settings"]["startingPointMode"], "random")

                reloaded = wx.WechatStore(store.database).room(room["code"])
                self.assertEqual(reloaded["settings"], rematch["settings"])
            finally:
                tasks = list(service.bot_tasks.values()) + list(service.timer_tasks.values())
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)

    async def test_real_validator_and_undo_preserve_default_diamond_room(self):
        with tempfile.TemporaryDirectory(prefix="lifeline-diamond-undo-") as folder:
            store = wx.WechatStore(Path(folder) / "rooms.sqlite3")
            service = wx.WechatService(
                store, "fixture-app", "fixture-secret",
                "fixture-signing-key-at-least-32-characters",
            )
            host = store.identity("diamond-undo-host")
            guest = store.identity("diamond-undo-guest")
            try:
                room = await service.mutate(host, "create", {
                    "playerCount": 2, "gridSize": 5, "boardShape": "diamond",
                    "rulesVersion": "territory-v3", "undoEnabled": True,
                })
                joined = await service.mutate(guest, "join", {}, room["code"])
                waiting = await service.mutate(host, "ready", {"matchId": room["matchId"]}, room["code"])
                self.assertEqual(waiting["status"], "waiting")
                playing = await service.mutate(guest, "ready", {"matchId": room["matchId"]}, room["code"])
                self.assertEqual(playing["status"], "playing")

                moved = await service.mutate(host, "actions", {
                    "matchId": room["matchId"], "expectedSeq": 0,
                    "beforeHash": playing["stateHash"],
                    "clientActionId": "diamond-undo-move-0001",
                    "action": {"type": "move", "point": [1, 0]},
                }, room["code"])
                self.assertEqual(moved["seq"], 1)
                self.assertEqual(moved["settings"]["boardShape"], "diamond")
                self.assertNotIn("initialPositions", moved["settings"])

                vote = {"matchId": room["matchId"], "expectedSeq": 1,
                        "beforeHash": moved["stateHash"], "accept": True}
                pending = await service.mutate(host, "undo", vote, room["code"])
                self.assertTrue(pending["undo"]["pending"])
                undone = await service.mutate(guest, "undo", vote, room["code"])
                self.assertEqual(undone["seq"], 0)
                self.assertEqual(undone["settings"]["boardShape"], "diamond")
                self.assertEqual(undone["undo"]["usedCount"], 1)
                self.assertEqual(wx.WechatStore(store.database).room(room["code"])["settings"],
                                 undone["settings"])
            finally:
                tasks = list(service.bot_tasks.values()) + list(service.timer_tasks.values())
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)


if __name__ == "__main__":
    unittest.main()
