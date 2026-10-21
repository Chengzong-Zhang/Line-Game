"""Three-player room integration tests using the real Web rules/AI Node bridge."""
import asyncio
import importlib
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "web/web后端"))
os.environ.setdefault("LINE_GAME_DB_PATH", str(Path(tempfile.gettempdir()) / "lifeline-bot-tests" / "accounts.db"))
server = importlib.import_module("server")
bridge = importlib.import_module("online_bots")


class Socket:
    def __init__(self, name):
        self.state = SimpleNamespace(username=name)
        self.messages = []
        self.closed = False

    async def accept(self):
        pass

    async def send_json(self, payload):
        self.messages.append(payload)

    async def close(self, **_):
        self.closed = True


class OnlineBotTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.manager = server.ConnectionManager()
        self.host = Socket("Host")
        self.peer = Socket("Guest")
        self.countdown = patch.object(server, "READY_COUNTDOWN_SECONDS", 0.01)
        self.countdown.start()

    async def asyncTearDown(self):
        await self.manager.stop()
        self.countdown.stop()

    async def create(self, count=2, start="BLACK"):
        await self.manager.create_room(self.host, "Host", {
            "playerCount": 3, "botCount": count, "gridSize": 5,
            "rulesVersion": "territory-v2", "startPlayer": start,
        })
        return self.manager.rooms[self.manager.websocket_index[self.host][0]]

    async def start(self, room):
        await self.manager.set_player_ready(self.host, True)
        if "Guest" in room.players:
            await self.manager.set_player_ready(self.peer, True)
        countdown = room.countdown_task
        if countdown:
            await countdown
        self.assertTrue(room.match_started)

    async def settle(self, room):
        task = room.bot_task
        if task:
            await asyncio.wait_for(asyncio.shield(task), 20)

    async def action(self, socket, kind="player_move", point=None, **extras):
        await self.manager.handle_message(socket, {
            "type": kind, **({"point": point} if point is not None else {}), **extras,
        })

    async def test_two_bots_ready_and_play_server_moves(self):
        room = await self.create()
        self.assertEqual(len(room.players), 3)
        self.assertEqual(sum(p.is_bot for p in room.players.values()), 2)
        self.assertEqual(len(room.ready_players), 2)
        self.assertTrue(all(p["ready"] for p in self.host.messages[-1]["players"] if p["isBot"]))
        await self.start(room)
        await self.settle(room)
        await self.action(self.host, point=[0, 1])
        await self.settle(room)
        self.assertGreaterEqual(len(room.actions), 3)
        self.assertEqual([a["color"] for a in room.actions[:3]], ["BLACK", "WHITE", "PURPLE"])
        self.assertEqual(sum(m["type"] == "OPPONENT_MOVE" for m in self.host.messages), 2)
        self.assertFalse(any(m.get("aiFallback") for m in self.host.messages))
        verification = await bridge.evaluate_room(room.settings, room.actions, [])
        self.assertTrue(verification["success"])

    async def test_one_bot_two_humans_and_turn_spoof_rejected(self):
        room = await self.create(1)
        await self.manager.join_room(self.peer, room.room_id, "Guest")
        self.assertEqual(room.players["Guest"].color, "PURPLE")
        await self.start(room)
        await self.settle(room)
        await self.action(self.peer, point=[3, 0], color="BLACK", playerId="Host")
        self.assertFalse(room.actions)
        self.assertEqual(self.peer.messages[-2]["code"], "ACTION_REJECTED")
        self.assertEqual(self.peer.messages[-1]["type"], "ROOM_STATE")
        await self.action(self.host, point=[0, 1])
        await self.settle(room)
        self.assertEqual(len(room.actions), 2)
        self.assertEqual(room.actions[1]["color"], "WHITE")
        self.assertTrue(any(m["type"] == "OPPONENT_MOVE" and not m["isBot"] for m in self.peer.messages))

    async def test_bot_can_start_and_user_cannot_claim_bot(self):
        room = await self.create(2, "WHITE")
        bot_id = next(p.player_id for p in room.players.values() if p.is_bot)
        thief = Socket(bot_id)
        await self.manager.join_room(thief, room.room_id, bot_id)
        self.assertEqual(thief.messages[-1]["code"], "RESERVED_PLAYER_ID")
        self.assertNotIn(thief, self.manager.websocket_index)
        await self.start(room)
        await self.settle(room)
        self.assertEqual([a["color"] for a in room.actions], ["WHITE", "PURPLE"])

    async def test_configuration_changes_preserve_humans_and_block_overfill(self):
        room = await self.create(1)
        await self.manager.join_room(self.peer, room.room_id, "Guest")
        await self.manager.update_room_settings(self.host, {**room.settings, "botCount": 2})
        self.assertEqual(self.host.messages[-1]["code"], "ROOM_CAPACITY_CONFLICT")
        self.assertEqual(room.settings["botCount"], 1)
        await self.manager.update_room_settings(self.peer, {**room.settings, "botCount": 0})
        self.assertEqual(self.peer.messages[-1]["code"], "HOST_ONLY_ACTION")
        await self.manager.update_room_settings(self.host, {**room.settings, "botCount": 0})
        self.assertEqual(set(room.players), {"Host", "Guest"})
        self.assertFalse(room.has_bots())

    async def test_disconnect_cancels_inflight_bot_and_reconnect_recovers_history(self):
        room = await self.create()
        await self.start(room)
        await self.settle(room)
        entered, release = asyncio.Event(), asyncio.Event()
        real_evaluate = server.evaluate_room

        async def delayed(*args):
            if args[-1] is None:
                entered.set()
                await release.wait()
            return await real_evaluate(*args)

        with patch.object(server, "evaluate_room", side_effect=delayed):
            await self.action(self.host, point=[0, 1])
            await asyncio.wait_for(entered.wait(), 5)
            await self.manager.disconnect(self.host)
            self.assertEqual(len(room.actions), 1)
            replacement = Socket("Host")
            await self.manager.join_room(replacement, room.room_id, "Host")
            release.set()
            await self.settle(room)
        self.assertEqual(len(room.actions), 3)
        self.assertEqual(replacement.messages[0]["matchState"]["actions"][0]["point"], [0, 1])
        self.assertTrue(replacement.messages[0]["reconnected"])

    async def test_host_leaving_transfers_to_human_and_bot_only_room_is_removed(self):
        room = await self.create(1)
        await self.manager.join_room(self.peer, room.room_id, "Guest")
        await self.start(room)
        await self.settle(room)
        await self.manager.player_leave(self.host)
        self.assertEqual(room.host_player_id, "Guest")
        self.assertFalse(room.match_started)
        self.assertEqual(len(room.players), 2)
        await self.manager.player_leave(self.peer)
        self.assertNotIn(room.room_id, self.manager.rooms)

    async def test_reset_rearms_bot_readiness_and_drops_old_result(self):
        room = await self.create()
        await self.start(room)
        await self.settle(room)
        await self.action(self.host, point=[0, 1])
        await self.manager.forward_reset(self.host, "normal_restart")
        self.assertFalse(room.match_started)
        self.assertFalse(room.actions)
        self.assertEqual(len(room.ready_players), 2)
        await self.start(room)
        await self.settle(room)
        self.assertFalse(room.actions)

    async def test_reset_during_blocked_bot_releases_new_ai_start(self):
        room = await self.create()
        await self.start(room)
        await self.settle(room)
        entered = asyncio.Event()
        real_evaluate = server.evaluate_room

        async def delayed(*args):
            if args[-1] is None:
                entered.set()
                await asyncio.Event().wait()
            return await real_evaluate(*args)

        with patch.object(server, "evaluate_room", side_effect=delayed):
            await self.action(self.host, point=[0, 1])
            await asyncio.wait_for(entered.wait(), 5)
            old_task = room.bot_task
            await self.manager.forward_reset(self.host, "normal_restart")
            await asyncio.gather(old_task, return_exceptions=True)
        self.assertTrue(old_task.cancelled())
        await self.manager.update_start_player(self.host, "WHITE")
        self.assertEqual(len(room.ready_players), 2)
        await self.start(room)
        await self.settle(room)
        self.assertEqual([a["color"] for a in room.actions], ["WHITE", "PURPLE"])

    async def test_worker_exit_recovers_once_and_corrupt_history_never_retries(self):
        room = await self.create()
        snapshot = self.manager._bot_snapshot_locked(room)
        action = {"type": "player_move", "color": "BLACK", "point": [0, 1]}
        success = await server.evaluate_room(snapshot["settings"], [], snapshot["bot_colors"], action)
        flaky = AsyncMock(side_effect=[bridge.BotBridgeUnavailable("exit"), success])
        with patch.object(server, "evaluate_room", flaky):
            result = await self.manager._evaluate_bot_snapshot(snapshot, action)
        self.assertTrue(result["success"])
        self.assertEqual(flaky.await_count, 2)
        corrupt = AsyncMock(return_value={"success": False, "reason": "INVALID_REPLAY:OUT_OF_TURN"})
        with patch.object(server, "evaluate_room", corrupt):
            result = await self.manager._evaluate_bot_snapshot(snapshot)
        self.assertFalse(result["success"])
        self.assertEqual(corrupt.await_count, 1)

    async def test_killed_node_worker_recovers_from_accepted_history(self):
        room = await self.create()
        snapshot = self.manager._bot_snapshot_locked(room)
        action = {"type": "player_move", "color": "BLACK", "point": [0, 1]}
        real_spawn = asyncio.create_subprocess_exec
        processes = []

        async def spawn(*args, **kwargs):
            process = await real_spawn(*args, **kwargs)
            processes.append(process)
            if len(processes) == 1:
                process.kill()
            return process

        with patch.object(bridge.asyncio, "create_subprocess_exec", side_effect=spawn):
            result = await self.manager._evaluate_bot_snapshot(snapshot, action)
        self.assertTrue(result["success"])
        self.assertEqual(len(processes), 2)
        self.assertNotEqual(processes[0].returncode, 0)
        self.assertEqual(processes[1].returncode, 0)
        self.assertFalse(room.actions, "validation must not mutate the live room before commit")

    async def test_illegal_move_and_before_start_are_not_recorded(self):
        room = await self.create()
        await self.action(self.host, point=[0, 1])
        self.assertFalse(room.actions)
        await self.start(room)
        await self.settle(room)
        await self.action(self.host, point=[0, 0])
        self.assertFalse(room.actions)
        await self.action(self.host, point=[True, 1])
        self.assertFalse(room.actions)

    async def test_bot_count_does_not_enable_bots_in_two_player_mode(self):
        await self.manager.create_room(self.host, "Host", {"playerCount": 2, "botCount": 2})
        room = self.manager.rooms[self.manager.websocket_index[self.host][0]]
        self.assertEqual(room.settings["botCount"], 0)
        self.assertEqual(len(room.players), 1)
        self.assertFalse(room.has_bots())


class OnlineBotWebSocketTests(unittest.TestCase):
    def receive_type(self, websocket, expected):
        for _ in range(12):
            payload = websocket.receive_json()
            self.assertNotEqual(payload["type"], "ERROR", payload)
            if payload["type"] == expected:
                return payload
        self.fail(f"Missing WebSocket event {expected}")

    def test_authenticated_websocket_two_bot_match(self):
        manager = server.ConnectionManager()
        client = TestClient(server.app)
        token = server.create_access_token("SocketHost")
        with patch.object(server, "manager", manager), patch.object(server, "READY_COUNTDOWN_SECONDS", 0.01):
            with client.websocket_connect(f"/ws?token={token}") as websocket:
                websocket.send_json({"type": "create_room", "settings": {
                    "playerCount": 3, "botCount": 2, "gridSize": 5, "rulesVersion": "territory-v2",
                }})
                created = self.receive_type(websocket, "ROOM_CREATED")
                self.assertEqual(sum(p["isBot"] for p in created["players"]), 2)
                websocket.send_json({"type": "player_ready", "ready": True})
                self.receive_type(websocket, "ROOM_READY")
                websocket.send_json({"type": "player_move", "point": [0, 1], "color": "PURPLE"})
                first = self.receive_type(websocket, "OPPONENT_MOVE")
                second = self.receive_type(websocket, "OPPONENT_MOVE")
                self.assertEqual([first["color"], second["color"]], ["WHITE", "PURPLE"])
                self.assertTrue(first["isBot"] and second["isBot"])
                room = manager.rooms[created["roomId"]]
                self.assertEqual(room.actions[0]["color"], "BLACK", "actor comes from the authenticated seat")
                websocket.send_json({"type": "player_leave"})


if __name__ == "__main__":
    unittest.main()
