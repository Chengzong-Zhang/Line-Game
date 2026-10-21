"""4–6-player AI rooms: Node model bridge, authentication and interrupted work."""
import asyncio
import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient

from test_online_bots import Socket, server, bridge


class HexOnlineBotTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.manager = server.ConnectionManager()
        self.countdown = patch.object(server, "READY_COUNTDOWN_SECONDS", 0.01)
        self.countdown.start()

    async def asyncTearDown(self):
        await self.manager.stop()
        self.countdown.stop()

    async def create(self, count, bots, start="BLACK"):
        host = Socket(f"Host-{count}-{bots}")
        await self.manager.create_room(host, host.state.username, {
            "playerCount": count, "botCount": bots, "gridSize": 5,
            "rulesVersion": "territory-v2", "startPlayer": start,
        })
        room = self.manager.rooms[self.manager.websocket_index[host][0]]
        humans = [host]
        for index in range(count - bots - 1):
            peer = Socket(f"Guest-{count}-{bots}-{index}")
            await self.manager.join_room(peer, room.room_id, peer.state.username)
            humans.append(peer)
        return room, humans

    async def start(self, room, humans):
        for socket in humans:
            await self.manager.set_player_ready(socket, True)
        await room.countdown_task
        self.assertTrue(room.match_started)

    async def settle(self, room):
        if room.bot_task:
            await asyncio.wait_for(asyncio.shield(room.bot_task), 30)

    async def test_one_and_multiple_trained_bots_for_all_hex_modes(self):
        for count in (4, 5, 6):
            for bot_count in (1, count - 1):
                with self.subTest(players=count, bots=bot_count):
                    room, humans = await self.create(count, bot_count, "WHITE")
                    self.assertEqual(sum(p.is_bot for p in room.players.values()), bot_count)
                    await self.start(room, humans)
                    await self.settle(room)
                    self.assertEqual([a["color"] for a in room.actions], list(server.PLAYER_COLORS[1:bot_count + 1]))
                    events = [m for m in humans[0].messages if m["type"] == "OPPONENT_MOVE"]
                    self.assertEqual(len(events), bot_count)
                    self.assertTrue(all(m["isBot"] and not m["aiFallback"] for m in events))
                    self.assertTrue((await bridge.evaluate_room(room.settings, room.actions, []))["success"])

    async def test_six_seat_identity_configuration_and_duplicate_worker_guards(self):
        room, humans = await self.create(6, 1)
        host, peer = humans[:2]
        bot_id = next(p.player_id for p in room.players.values() if p.is_bot)
        thief = Socket(bot_id)
        await self.manager.join_room(thief, room.room_id, bot_id)
        self.assertEqual(thief.messages[-1]["code"], "RESERVED_PLAYER_ID")
        await self.manager.update_room_settings(peer, {**room.settings, "botCount": 0})
        self.assertEqual(peer.messages[-1]["code"], "HOST_ONLY_ACTION")
        await self.manager.update_room_settings(host, {**room.settings, "botCount": 5})
        self.assertEqual(host.messages[-1]["code"], "ROOM_CAPACITY_CONFLICT")
        self.assertEqual(room.settings["botCount"], 1)
        await self.start(room, humans)
        await self.settle(room)
        await self.manager.handle_message(peer, {"type": "player_skip", "color": "BLACK", "playerId": host.state.username})
        self.assertEqual(peer.messages[-2]["code"], "ACTION_REJECTED")
        self.assertFalse(room.actions)
        await self.manager.handle_message(host, {"type": "player_skip", "color": "CYAN"})
        task = room.bot_task
        self.manager._schedule_bots_locked(room)
        self.assertIs(room.bot_task, task)
        await self.settle(room)
        self.assertEqual([a["color"] for a in room.actions], ["BLACK", "WHITE"])

    async def test_disconnect_cancels_six_seat_work_and_reconnect_preserves_history(self):
        room, humans = await self.create(6, 5)
        host = humans[0]
        await self.start(room, humans)
        await self.settle(room)
        entered = asyncio.Event()
        real_evaluate = server.evaluate_room

        async def delayed(*args):
            if args[-1] is None:
                entered.set()
                await asyncio.Event().wait()
            return await real_evaluate(*args)

        with patch.object(server, "evaluate_room", side_effect=delayed):
            await self.manager.handle_message(host, {"type": "player_skip"})
            await asyncio.wait_for(entered.wait(), 5)
            old_task = room.bot_task
            await self.manager.disconnect(host)
            await asyncio.gather(old_task, return_exceptions=True)
            self.assertTrue(old_task.cancelled())
            self.assertEqual([a["color"] for a in room.actions], ["BLACK"])
        replacement = Socket(host.state.username)
        await self.manager.join_room(replacement, room.room_id, replacement.state.username)
        joined = replacement.messages[0]
        self.assertTrue(joined["reconnected"])
        self.assertEqual(joined["yourColor"], "BLACK")
        self.assertEqual(joined["matchState"]["actions"], room.actions)
        await self.settle(room)
        self.assertEqual([a["color"] for a in room.actions], list(server.PLAYER_COLORS))

    async def test_reset_rejects_stale_work_and_rearms_all_five_bots(self):
        room, humans = await self.create(6, 5)
        host = humans[0]
        await self.start(room, humans)
        await self.settle(room)
        entered = asyncio.Event()
        real_evaluate = server.evaluate_room

        async def delayed(*args):
            if args[-1] is None:
                entered.set()
                await asyncio.Event().wait()
            return await real_evaluate(*args)

        with patch.object(server, "evaluate_room", side_effect=delayed):
            await self.manager.handle_message(host, {"type": "player_skip"})
            await asyncio.wait_for(entered.wait(), 5)
            old_task = room.bot_task
            await self.manager.forward_reset(host, "normal_restart")
            await asyncio.gather(old_task, return_exceptions=True)
        self.assertTrue(old_task.cancelled())
        self.assertFalse(room.actions)
        self.assertEqual(len(room.ready_players), 5)
        await self.manager.update_start_player(host, "CYAN")
        await self.start(room, humans)
        await self.settle(room)
        self.assertEqual([a["color"] for a in room.actions], ["CYAN"])

    async def test_replaced_human_socket_cannot_commit_inflight_action(self):
        room, humans = await self.create(4, 3)
        host = humans[0]
        await self.start(room, humans)
        await self.settle(room)
        entered, release = asyncio.Event(), asyncio.Event()
        real_evaluate = server.evaluate_room

        async def delayed(*args):
            if args[-1] is not None:
                entered.set()
                await release.wait()
            return await real_evaluate(*args)

        with patch.object(server, "evaluate_room", side_effect=delayed):
            request = asyncio.create_task(self.manager.handle_message(host, {"type": "player_skip"}))
            await asyncio.wait_for(entered.wait(), 5)
            replacement = Socket(host.state.username)
            await self.manager.join_room(replacement, room.room_id, replacement.state.username)
            self.assertTrue(host.closed)
            release.set()
            await request
            await self.settle(room)
        self.assertFalse(room.actions)
        self.assertNotIn(host, self.manager.websocket_index)

    def test_bot_count_leaves_a_human_and_forces_v2(self):
        for count in (3, 4, 5, 6):
            for bots in range(count):
                settings = self.manager._normalize_room_settings({
                    "playerCount": count, "botCount": bots, "rulesVersion": "territory-v1",
                })
                self.assertEqual(settings["botCount"], bots)
                self.assertEqual(settings["rulesVersion"], "territory-v2" if bots else "territory-v1")
            for invalid in (count, -1, True, 1.5):
                self.assertEqual(self.manager._normalize_room_settings({"playerCount": count, "botCount": invalid})["botCount"], 0)


class HexBotWebSocketTests(unittest.TestCase):
    def receive_type(self, websocket, expected):
        for _ in range(20):
            payload = websocket.receive_json()
            self.assertNotEqual(payload["type"], "ERROR", payload)
            if payload["type"] == expected:
                return payload
        self.fail(f"Missing event {expected}")

    def test_authenticated_websocket_human_against_five_bots(self):
        manager = server.ConnectionManager()
        client = TestClient(server.app)
        token = server.create_access_token("HexSocketHost")
        with patch.object(server, "manager", manager), patch.object(server, "READY_COUNTDOWN_SECONDS", 0.01):
            with client.websocket_connect(f"/ws?token={token}") as websocket:
                websocket.send_json({"type": "create_room", "settings": {
                    "playerCount": 6, "botCount": 5, "gridSize": 5, "rulesVersion": "territory-v2",
                }})
                created = self.receive_type(websocket, "ROOM_CREATED")
                self.assertEqual(sum(p["isBot"] for p in created["players"]), 5)
                websocket.send_json({"type": "player_ready", "ready": True})
                self.receive_type(websocket, "ROOM_READY")
                websocket.send_json({"type": "player_skip", "color": "CYAN"})
                skipped = self.receive_type(websocket, "TURN_SKIPPED")
                self.assertEqual(skipped["color"], "BLACK")
                events = [self.receive_type(websocket, "OPPONENT_MOVE") for _ in range(5)]
                self.assertEqual([e["color"] for e in events], list(server.PLAYER_COLORS[1:]))
                self.assertTrue(all(e["isBot"] and not e["aiFallback"] for e in events))
                self.assertEqual(len(manager.rooms[created["roomId"]].actions), 6)
                websocket.send_json({"type": "player_leave"})


if __name__ == "__main__":
    unittest.main()
