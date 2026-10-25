"""Exercise durable shared AI rooms with the real Node rules and bot bridge."""
import asyncio
import importlib.util
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("shared_online_ai", ROOT / "web/web后端/wechat_online.py")
wx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wx)


class SharedOnlineAiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="lifeline-shared-ai-")
        self.store = wx.WechatStore(Path(self.temp.name) / "rooms.sqlite3")
        self.service = wx.WechatService(
            self.store, "fixture-app", "fixture-secret", "fixture-signing-key-at-least-32-characters")
        self.host = self.store.identity("host")

    async def asyncTearDown(self):
        for task in self.service.bot_tasks.values():
            task.cancel()
        await asyncio.gather(*self.service.bot_tasks.values(), return_exceptions=True)
        self.temp.cleanup()

    async def wait_for_seq(self, code, seq):
        for _ in range(200):
            room = self.store.room(code)
            if room["seq"] >= seq:
                return room
            await asyncio.sleep(0.05)
        self.fail(f"AI turn did not reach action {seq}")

    async def test_bot_seat_random_opening_move_undo_and_rematch(self):
        starts = {"BLACK": [0, 0], "WHITE": [4, 0]}
        created = await self.service.mutate(self.host, "create", {
            "gridSize": 5, "rulesVersion": "territory-v3", "botCount": 1,
            "startPlayer": "WHITE", "startingPointMode": "random",
            "initialPositions": starts, "undoEnabled": True})
        code, match = created["code"], created["matchId"]
        self.assertEqual(created["settings"]["initialPositions"], starts)
        self.assertEqual(created["bots"], ["WHITE"])
        self.assertEqual(created["ready"], {"BLACK": False, "WHITE": True})
        self.assertEqual(created["playerProfiles"]["WHITE"]["displayName"], "AI")
        without_bot = await self.service.mutate(self.host, "settings", {
            "matchId": match, "settings": {**created["settings"], "botCount": 0}}, code)
        self.assertEqual(without_bot["ready"], {"BLACK": False, "WHITE": False})
        self.assertEqual(without_bot["bots"], [])
        restored = await self.service.mutate(self.host, "settings", {
            "matchId": match, "settings": {**created["settings"], "botCount": 1}}, code)
        self.assertEqual(restored["ready"], {"BLACK": False, "WHITE": True})
        self.assertEqual(restored["bots"], ["WHITE"])
        with self.assertRaises(wx.HTTPException) as denied:
            await self.service.mutate(self.store.identity("guest"), "join", {"code": code}, code)
        self.assertEqual(denied.exception.detail, "ROOM_FULL")

        await self.service.mutate(self.host, "ready", {"matchId": match}, code)
        after_bot = await self.wait_for_seq(code, 1)
        self.assertEqual(after_bot["actions"][0]["player"], "WHITE")
        self.assertEqual(after_bot["state"]["currentPlayer"], "BLACK")
        restarted = wx.WechatService(wx.WechatStore(self.store.database), "fixture-app",
                                     "fixture-secret", "fixture-signing-key-at-least-32-characters")
        resumed = restarted.view(restarted.store.room(code), self.host)
        self.assertEqual(resumed["settings"]["initialPositions"], starts)
        self.assertEqual(resumed["bots"], ["WHITE"])
        self.assertEqual(resumed["seq"], 1)

        await self.service.mutate(self.host, "actions", {
            "matchId": match, "expectedSeq": 1, "beforeHash": after_bot["state"]["stateHash"],
            "clientActionId": "test-human-command-00001",
            "action": {"type": "move", "point": [1, 0]}}, code)
        after_reply = await self.wait_for_seq(code, 3)
        self.assertEqual([a["player"] for a in after_reply["actions"]], ["WHITE", "BLACK", "WHITE"])
        undone = await self.service.mutate(self.host, "undo", {
            "matchId": match, "expectedSeq": 3, "beforeHash": after_reply["state"]["stateHash"],
            "accept": True}, code)
        self.assertEqual(undone["seq"], 1)
        self.assertEqual(undone["undo"]["usedCount"], 1)
        self.assertEqual(undone["currentPlayer"], "BLACK")
        self.assertEqual(undone["settings"]["initialPositions"], starts)

        finished = await self.service.mutate(self.host, "actions", {
            "matchId": match, "expectedSeq": 1, "beforeHash": undone["stateHash"],
            "clientActionId": "test-human-command-00002",
            "action": {"type": "resign"}}, code)
        self.assertEqual(finished["status"], "finished")
        replay = await self.service.mutate(self.host, "rematch", {"matchId": match}, code)
        self.assertEqual(replay["status"], "waiting")
        self.assertEqual(replay["ready"], {"BLACK": False, "WHITE": True})
        self.assertNotEqual(replay["settings"]["initialPositions"], starts)
        self.assertEqual(len({tuple(point) for point in replay["settings"]["initialPositions"].values()}), 2)


if __name__ == "__main__":
    unittest.main()
