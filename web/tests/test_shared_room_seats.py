"""Durable mixed human/AI rooms, next-match settings and authoritative clocks.

Uses temporary SQLite and the actual Mini Game/Web rule verifier. No remote
account, credentials, production database or network service is involved.
"""
import asyncio
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("shared_room_seats", ROOT / "web/web后端/wechat_online.py")
wx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wx)


def settings(count=3, humans=("BLACK", "PURPLE"), **extra):
    return {"gridSize": 5, "playerCount": count, "rulesVersion": "territory-v3",
            "playerSetup": {color: {"choice": "human" if color in humans else "greedy",
                                      "depth": 3, "version": "2026092201"}
                            for color in wx.PLAYER_COLORS[:count]}, **extra}


async def skip_bot(config, actions):
    state = await asyncio.to_thread(wx.verify_rules, config, actions)
    return {"success": True, "action": {"type": "player_skip", "color": state["currentPlayer"]}}


class SharedRoomSeatTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="lifeline-room-seats-")
        self.store = wx.WechatStore(Path(self.tmp.name) / "rooms.sqlite3")
        self.service = wx.WechatService(self.store, "fixture-app", "fixture-secret",
                                       "fixture-signing-key-at-least-32-characters")
        # Drive AI completion explicitly in tests so humans never race a subprocess.
        self.service.schedule_bot = self.service.schedule_timer
        self.host = self.store.identity("host")
        self.peer = self.store.identity("peer")
        self.third = self.store.identity("third")

    async def asyncTearDown(self):
        tasks = list(self.service.bot_tasks.values()) + list(self.service.timer_tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.tmp.cleanup()

    async def create(self, config=None):
        return await self.service.mutate(self.host, "create", config or settings())

    async def command(self, uid, room, operation, **body):
        return await self.service.mutate(uid, operation, {"matchId": room["matchId"], **body}, room["code"])

    async def join(self, uid, room):
        return await self.service.mutate(uid, "join", {}, room["code"])

    async def start_pair(self, config=None):
        room = await self.create(config)
        await self.join(self.peer, room)
        await self.command(self.host, room, "ready")
        return await self.command(self.peer, room, "ready")

    async def action(self, uid, room, action):
        return await self.command(uid, room, "actions", expectedSeq=room["seq"], beforeHash=room["stateHash"],
                                  clientActionId="test-action-" + wx.secrets.token_hex(10), action=action)

    def rewrite(self, room, change):
        stored = self.store.room(room["code"])
        revision = stored["revision"]
        change(stored)
        stored["revision"] += 1
        self.store.commit(stored, revision)
        return stored

    async def test_six_seats_wait_for_each_invited_human_and_expose_every_score(self):
        room = await self.create(settings(6, ("BLACK", "PURPLE", "CYAN")))
        self.assertEqual(room["bots"], ["WHITE", "GREEN", "ORANGE"])
        self.assertEqual(room["settings"]["botCount"], 3)
        self.assertEqual(set(room["scores"]), set(wx.PLAYER_COLORS))
        self.assertEqual(room["members"], {"BLACK": True, "WHITE": True, "PURPLE": False,
                                           "GREEN": True, "ORANGE": True, "CYAN": False})
        self.assertEqual((await self.join(self.peer, room))["player"], "PURPLE")
        await self.command(self.host, room, "ready")
        waiting = await self.command(self.peer, room, "ready")
        self.assertEqual(waiting["status"], "waiting")
        self.assertEqual((await self.join(self.third, room))["player"], "CYAN")
        playing = await self.command(self.third, room, "ready")
        self.assertEqual(playing["status"], "playing")
        self.assertTrue(all(playing["ready"].values()))
        self.assertEqual(playing["playerProfiles"]["ORANGE"]["uid"], "@AI:ORANGE")

    async def test_host_can_occupy_first_human_after_ai_black(self):
        room = await self.create(settings(3, ("WHITE", "PURPLE"), startPlayer="BLACK"))
        self.assertEqual(room["player"], "WHITE")
        self.assertEqual(room["hostPlayer"], "WHITE")
        self.assertEqual(room["bots"], ["BLACK"])
        updated = await self.command(self.host, room, "settings", settings={**room["settings"], "gridSize": 7})
        self.assertEqual(updated["settings"]["gridSize"], 7)
        await self.join(self.peer, room)
        with self.assertRaises(wx.HTTPException) as denied:
            await self.command(self.peer, room, "settings", settings=room["settings"])
        self.assertEqual(denied.exception.detail, "SETTINGS_LOCKED")

    async def test_waiting_edits_reset_ready_and_protect_occupied_human_seats(self):
        room = await self.create()
        await self.join(self.peer, room)
        await self.command(self.host, room, "ready")
        updated = await self.command(self.host, room, "settings", settings=settings(6, ("BLACK", "PURPLE", "CYAN")))
        self.assertEqual(updated["ready"], {"BLACK": False, "WHITE": True, "PURPLE": False,
                                           "GREEN": True, "ORANGE": True, "CYAN": False})
        before = self.store.room(room["code"])
        for invalid in (settings(3, ("BLACK",)), settings(2, ("BLACK", "WHITE"))):
            with self.assertRaises(wx.HTTPException) as denied:
                await self.command(self.host, room, "settings", settings=invalid)
            self.assertEqual(denied.exception.detail, "ROOM_FULL")
            self.assertEqual(self.store.room(room["code"]), before)

    async def test_pending_settings_preserve_match_and_apply_after_all_human_rematch_votes(self):
        room = await self.start_pair()
        original = self.store.room(room["code"])
        next_config = settings(6, ("BLACK", "PURPLE", "CYAN"), gridSize=7, startingPointMode="random",
                               hintEnabled=True, hintMaxCount=5, undoEnabled=True, undoMaxCount=4,
                               turnTimerEnabled=True, turnTimeLimitSeconds=30)
        staged = await self.command(self.host, room, "settings", settings=next_config)
        for key in ("matchId", "settings", "state", "seq", "actions", "actionIds", "players", "ready"):
            self.assertEqual(self.store.room(room["code"])[key], original[key])
        self.assertEqual(staged["pendingSettings"]["playerCount"], 6)
        # Complete the original three-seat match with three consecutive passes.
        moved = await self.action(self.host, staged, {"type": "skip"})
        with patch.object(wx, "evaluate_shared_bot", skip_bot):
            await self.service.run_bot(room["code"])
        after_bot = self.service.view(self.store.room(room["code"]), self.peer)
        finished = await self.action(self.peer, after_bot, {"type": "skip"})
        self.assertEqual(finished["status"], "finished")
        first_vote = await self.command(self.host, finished, "rematch")
        self.assertEqual(first_vote["matchId"], room["matchId"])
        rematch = await self.command(self.peer, finished, "rematch")
        self.assertNotEqual(rematch["matchId"], room["matchId"])
        self.assertEqual(rematch["status"], "waiting")
        self.assertIsNone(rematch["pendingSettings"])
        self.assertEqual(rematch["settings"]["playerCount"], 6)
        self.assertEqual(rematch["settings"]["hintMaxCount"], 5)
        self.assertTrue(rematch["settings"]["turnTimerEnabled"])
        self.assertFalse(rematch["members"]["CYAN"])
        self.assertEqual(len(rematch["settings"]["initialPositions"]), 6)
        self.assertNotEqual(rematch["settings"]["initialPositions"], staged["pendingSettings"]["initialPositions"])
        restarted = wx.WechatService(wx.WechatStore(self.store.database), "fixture-app", "fixture-secret",
                                     "fixture-signing-key-at-least-32-characters")
        self.assertEqual(restarted.view(restarted.store.room(room["code"]), self.host)["settings"], rematch["settings"])

    async def test_undo_requires_all_actual_humans_and_ignores_bot_votes(self):
        room = await self.start_pair(settings(3, ("BLACK", "PURPLE"), undoEnabled=True))
        moved = await self.action(self.host, room, {"type": "skip"})
        with patch.object(wx, "evaluate_shared_bot", skip_bot):
            await self.service.run_bot(room["code"])
        after_bot = self.service.view(self.store.room(room["code"]), self.host)
        vote = {"expectedSeq": after_bot["seq"], "beforeHash": after_bot["stateHash"], "accept": True}
        pending = await self.command(self.host, after_bot, "undo", **vote)
        self.assertTrue(pending["undo"]["pending"])
        self.assertEqual(pending["undo"]["votes"], ["BLACK"])
        self.assertEqual(pending["seq"], 2)
        undone = await self.command(self.peer, after_bot, "undo", **vote)
        self.assertEqual(undone["seq"], 1)
        self.assertEqual(undone["currentPlayer"], "WHITE")
        self.assertEqual(undone["undo"]["usedCount"], 1)
        self.assertFalse(undone["undo"]["pending"])

    async def test_ai_result_from_before_settings_revision_cannot_enter_history(self):
        room = await self.start_pair(settings(3, ("BLACK", "PURPLE"), startPlayer="WHITE"))
        started, release = asyncio.Event(), asyncio.Event()

        async def delayed(config, actions):
            started.set()
            await release.wait()
            return {"success": True, "action": {"type": "player_skip", "color": "WHITE"}}

        with patch.object(wx, "evaluate_shared_bot", delayed):
            task = asyncio.create_task(self.service.run_bot(room["code"]))
            await started.wait()
            staged = await self.command(self.host, room, "settings", settings={**room["settings"], "gridSize": 7})
            release.set()
            await task
        self.assertEqual(self.store.room(room["code"])["seq"], 0)
        self.assertEqual(staged["pendingSettings"]["gridSize"], 7)

    async def test_six_seat_real_ai_bridge_commits_current_bot_only(self):
        config = settings(6, ("BLACK", "CYAN"), startPlayer="WHITE")
        for setup in config["playerSetup"].values():
            if setup["choice"] != "human":
                setup["choice"] = "ai-easy"
        room = await self.start_pair(config)
        await self.service.run_bot(room["code"])
        after = self.store.room(room["code"])
        self.assertEqual(after["seq"], 1)
        self.assertEqual(after["actions"][0]["player"], "WHITE")
        self.assertEqual(after["state"]["currentPlayer"], "PURPLE")
        self.assertEqual(set(after["state"]["scores"]), set(wx.PLAYER_COLORS))

    async def test_ai_failure_stops_retry_loop_and_fallback_is_visible_after_explicit_retry(self):
        room = await self.start_pair(settings(startPlayer="WHITE"))
        calls = []

        async def decisions(config, actions):
            calls.append(len(actions))
            if len(calls) == 1:
                return {"success": False, "reason": "ULTIMATE_NOT_ADMITTED", "botProfile": {"strategy": "multiplayer"}}
            return {"success": True, "action": {"type": "player_skip", "color": "WHITE"},
                    "fallback": True, "fallbackReason": "fixture model missing",
                    "botProfile": {"strategy": "greedy"}, "modelInfo": {"id": "fixture-model"}}

        self.service.schedule_bot = wx.WechatService.schedule_bot.__get__(self.service)
        with patch.object(wx, "evaluate_shared_bot", decisions):
            self.service.schedule_bot(self.store.room(room["code"]))
            await asyncio.gather(*list(self.service.bot_tasks.values()))
            await asyncio.sleep(0)
            failed = self.service.view(self.store.room(room["code"]), self.host)
            self.assertEqual(len(calls), 1)
            self.assertEqual(failed["seq"], 0)
            self.assertEqual(failed["lastBotResult"]["reason"], "ULTIMATE_NOT_ADMITTED")
            self.service.schedule_bot(self.store.room(room["code"]))
            await asyncio.gather(*list(self.service.bot_tasks.values()))
            await asyncio.sleep(0)
        accepted = self.service.view(self.store.room(room["code"]), self.host)
        self.assertEqual(len(calls), 2)
        self.assertEqual(accepted["seq"], 1)
        self.assertTrue(accepted["lastBotResult"]["fallback"])
        self.assertEqual(accepted["lastBotResult"]["fallbackReason"], "fixture model missing")
        self.assertEqual(accepted["lastBotResult"]["modelInfo"], {"id": "fixture-model"})

    async def test_authoritative_timeout_and_stale_deadline(self):
        room = await self.start_pair(settings(3, ("BLACK", "PURPLE"), turnTimerEnabled=True,
                                              turnTimeLimitSeconds=15))
        self.assertGreater(room["turnDeadline"], time.time())
        expired = self.rewrite(room, lambda r: r.update(turnDeadline=time.time() - 1))
        key = (expired["matchId"], expired["seq"], expired["state"]["stateHash"], expired["turnDeadline"])
        with self.assertRaises(wx.HTTPException) as denied:
            await self.action(self.host, self.service.view(expired, self.host), {"type": "skip"})
        self.assertEqual(denied.exception.detail, "TURN_EXPIRED")
        await self.service.run_timer(room["code"], key)
        latest = self.store.room(room["code"])
        self.assertEqual(latest["seq"], 1)
        self.assertEqual(latest["actions"], [{"type": "skip", "player": "BLACK"}])
        self.assertTrue(latest["actionIds"][0].startswith("timeout-"))
        await self.service.run_timer(room["code"], key)
        self.assertEqual(self.store.room(room["code"])["seq"], 1)

    async def test_waiting_host_leave_transfers_host_and_frees_human_seat(self):
        room = await self.create()
        await self.join(self.peer, room)
        left = await self.command(self.host, room, "leave")
        self.assertEqual(left["status"], "waiting")
        self.assertEqual(left["hostPlayer"], "PURPLE")
        self.assertIsNone(self.store.active_room(self.host))
        joined = await self.join(self.third, room)
        self.assertEqual(joined["player"], "BLACK")
        self.assertEqual(joined["hostPlayer"], "PURPLE")

    async def test_live_host_leave_resigns_seat_and_preserves_other_humans_room(self):
        room = await self.start_pair(settings(undoEnabled=True))
        left = await self.command(self.host, room, "leave")
        self.assertEqual(left["hostPlayer"], "PURPLE")
        self.assertEqual(left["status"], "playing")
        self.assertIn("BLACK", left["resignedPlayers"])
        self.assertEqual(left["seq"], 1)
        self.assertIsNone(self.store.active_room(self.host))
        self.assertEqual(self.store.active_room(self.peer)["code"], room["code"])
        with self.assertRaises(wx.HTTPException) as denied:
            await self.command(self.peer, left, "undo", expectedSeq=left["seq"], beforeHash=left["stateHash"], accept=True)
        self.assertEqual(denied.exception.detail, "UNDO_UNAVAILABLE")

    async def test_strict_settings_and_native_model_versions(self):
        for invalid in ({"playerCount": True}, {"playerCount": 7}, {"playerCount": 1},
                        {"playerCount": 3, "startPlayer": "CYAN"}, {"turnTimerEnabled": 1},
                        settings(3, ()), settings(3, ("BLACK",), playerSetup={"BLACK": {"choice": "human"}})):
            with self.subTest(invalid=invalid), self.assertRaises(wx.HTTPException):
                wx.WechatService.room_settings(invalid)
        base = settings()
        for mutation in ({"choice": "unknown"}, {"depth": True}, {"depth": 5}, {"version": "unknown"}):
            invalid = copy.deepcopy(base)
            invalid["playerSetup"]["WHITE"].update(mutation)
            with self.subTest(mutation=mutation), self.assertRaises(wx.HTTPException):
                wx.WechatService.room_settings(invalid)
        native = settings()
        native["playerSetup"]["WHITE"].update(choice="three-player", version="three-player-policy-v2")
        self.assertEqual(wx.WechatService.room_settings(native)["playerSetup"]["WHITE"]["version"], "three-player-policy-v2")

    async def test_real_service_views_reconstruct_in_both_web_and_mini_clients(self):
        config = settings(6, ("WHITE", "GREEN", "CYAN"), startPlayer="BLACK", undoEnabled=True)
        for setup in config["playerSetup"].values():
            if setup["choice"] != "human":
                setup["choice"] = "ai-easy"
        room = await self.create(config)
        stages = []

        def capture(name):
            current = self.store.room(room["code"])
            stages.append({"name": name, "room": self.service.view(current, self.host)})

        capture("created-six-interleaved-seats")
        await self.join(self.peer, room)
        await self.join(self.third, room)
        capture("invited-human-seats-filled")
        await self.command(self.host, room, "ready")
        await self.command(self.peer, room, "ready")
        await self.command(self.third, room, "ready")
        capture("all-three-humans-ready")
        # Execute real selected AI profiles, then real human commands. These
        # service documents include actual action hashes, not synthetic rooms.
        for name, uid in (("black-ai-then-white-human", self.host), ("purple-ai-then-green-human", self.peer),
                          ("orange-ai-then-cyan-human", self.third)):
            await self.service.run_bot(room["code"])
            current = self.service.view(self.store.room(room["code"]), uid)
            self.assertEqual(current["currentPlayer"], current["player"])
            capture(name + "-ai-move")
            await self.action(uid, current, {"type": "skip"})
            capture(name + "-human-pass")
        self.assertTrue(any(action["type"] == "move" for action in self.store.room(room["code"])["actions"]))
        # Reducing six seats cannot remove an occupied human. The departing
        # third human resigns; WHITE/GREEN remain in the room for the next game.
        await self.command(self.third, room, "leave")
        capture("cyan-left-host-still-white")
        next_config = settings(4, ("WHITE", "GREEN"), boardShape="triangle", gridSize=7,
                               startPlayer="BLACK", startingPointMode="random", undoEnabled=True)
        for setup in next_config["playerSetup"].values():
            if setup["choice"] != "human":
                setup["choice"] = "ai-easy"
        await self.command(self.host, room, "settings", settings=next_config)
        capture("pending-four-seat-triangle-current-six-seat-hexagon")
        # Close the original match through valid turns; the bot decisions here
        # are fixed passes so this is a bounded protocol regression.
        with patch.object(wx, "evaluate_shared_bot", skip_bot):
            for _ in range(12):
                current = self.store.room(room["code"])
                if current["status"] == "finished":
                    break
                if current["state"]["currentPlayer"] in self.service.bot_colors(current):
                    await self.service.run_bot(room["code"])
                else:
                    uid = current["players"][current["state"]["currentPlayer"]]
                    await self.action(uid, self.service.view(current, uid), {"type": "skip"})
        self.assertEqual(self.store.room(room["code"])["status"], "finished")
        capture("finished-original-six-seat-match")
        await self.command(self.host, room, "rematch")
        capture("only-first-actual-human-rematch-vote")
        await self.command(self.peer, room, "rematch")
        capture("new-four-seat-triangle-match")
        rematch = self.service.view(self.store.room(room["code"]), self.host)
        await self.command(self.host, rematch, "ready")
        await self.command(self.peer, rematch, "ready")
        await self.service.run_bot(room["code"])
        capture("new-triangle-ai-turn-verified")
        fixture = {"source": "temporary-sqlite-real-rules-and-ai-bridge", "stages": stages}
        process = await asyncio.to_thread(subprocess.run, ["node", str(ROOT / "web/web前端/tests/verify-shared-room-service-fixture.mjs")],
                                          input=json.dumps(fixture).encode(), capture_output=True, timeout=60, check=False,
                                          creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        self.assertEqual(process.returncode, 0, process.stderr.decode(errors="replace"))
        receipt = json.loads(process.stdout)
        self.assertEqual(receipt["status"], "PASS_SHARED_SERVICE_BOTH_CLIENTS")
        self.assertEqual(receipt["snapshots"], len(stages))
        self.assertTrue(receipt["countAndShapeRematch"])


if __name__ == "__main__":
    unittest.main()
