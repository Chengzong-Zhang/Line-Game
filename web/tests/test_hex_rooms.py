"""Local relay protocol coverage; this does not claim server-side rule adjudication."""
from copy import deepcopy
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

BACKEND = Path(__file__).resolve().parents[1] / "web后端"
sys.path.insert(0, str(BACKEND))
import server


class SocketProbe:
    def __init__(self, username):
        self.state = SimpleNamespace(username=username)
        self.messages = []
        self.closed = False

    async def send_json(self, payload):
        self.messages.append(deepcopy(payload))

    async def close(self, **_kwargs):
        self.closed = True


class HexRoomTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.manager = server.ConnectionManager()

    async def asyncTearDown(self):
        await self.manager.stop()

    async def populated_room(self, count):
        sockets = [SocketProbe(f"hex-{count}-{i}") for i in range(count)]
        await self.manager.create_room(sockets[0], sockets[0].state.username, {
            "playerCount": count, "gridSize": 7, "startPlayer": server.PLAYER_COLORS[count - 1],
        })
        room_id = sockets[0].messages[-1]["roomId"]
        for socket in sockets[1:]:
            await self.manager.join_room(socket, room_id, socket.state.username)
        return self.manager.rooms[room_id], sockets

    async def test_four_five_six_seats_countdown_and_reset(self):
        for count in (4, 5, 6):
            with self.subTest(player_count=count):
                room, sockets = await self.populated_room(count)
                self.assertEqual(room.player_capacity(), count)
                self.assertEqual(room.settings["startPlayer"], server.PLAYER_COLORS[count - 1])
                self.assertEqual([p.color for p in room.players.values()], list(server.PLAYER_COLORS[:count]))
                excess = SocketProbe(f"excess-{count}")
                await self.manager.join_room(excess, room.room_id, excess.state.username)
                self.assertEqual(excess.messages[-1]["code"], "ROOM_FULL")

                with patch.object(server, "READY_COUNTDOWN_SECONDS", 0):
                    for socket in sockets:
                        await self.manager.set_player_ready(socket, True)
                    await room.countdown_task
                self.assertTrue(room.match_started)
                for i, socket in enumerate(sockets):
                    ready = [message for message in socket.messages if message["type"] == "ROOM_READY"][-1]
                    self.assertEqual(ready["yourColor"], server.PLAYER_COLORS[i])
                    self.assertEqual(len(ready["players"]), count)

                # Coordinates larger than side length are valid on the hexagonal
                # lattice and must survive relay, logging and reconnect unchanged.
                await self.manager.forward_move(sockets[-1], [0, 11])
                self.assertEqual(room.actions[-1]["point"], [0, 11])
                await self.manager.forward_skip(sockets[0])
                await self.manager.forward_resign(sockets[-1])
                await self.manager.forward_resign(sockets[-1])
                self.assertEqual(len([a for a in room.actions if a["type"] == "player_resign"]), 1)
                saved_actions = deepcopy(room.actions)
                await self.manager.disconnect(sockets[-1])
                replacement = SocketProbe(sockets[-1].state.username)
                await self.manager.join_room(replacement, room.room_id, replacement.state.username)
                joined = next(m for m in replacement.messages if m["type"] == "ROOM_JOINED")
                self.assertTrue(joined["reconnected"])
                self.assertEqual(joined["yourColor"], server.PLAYER_COLORS[count - 1])
                self.assertEqual(joined["matchState"]["actions"], saved_actions)

                sockets[-1] = replacement
                await self.manager.forward_reset(sockets[0], "normal_restart")
                self.assertFalse(room.match_started)
                self.assertEqual(room.actions, [])
                for socket in sockets:
                    reset = socket.messages[-1]
                    self.assertEqual(reset["type"], "MATCH_RESET")
                    self.assertEqual(len(reset["players"]), count)
                    self.assertEqual(reset["settings"]["playerCount"], count)

    async def test_occupied_extra_seats_prevent_shrink(self):
        room, sockets = await self.populated_room(6)
        await self.manager.update_room_settings(sockets[0], {**room.settings, "playerCount": 4})
        self.assertEqual(sockets[0].messages[-1]["type"], "ERROR")
        self.assertEqual(room.player_capacity(), 6)

    def test_configuration_preserves_legacy_and_rejects_unknown_counts(self):
        for count in (2, 3, 4, 5, 6):
            normalized = self.manager._normalize_room_settings({
                "playerCount": count, "gridSize": 15, "startPlayer": server.PLAYER_COLORS[count - 1],
                "botCount": 2,
            })
            self.assertEqual(normalized["playerCount"], count)
            self.assertEqual(normalized["gridSize"], 15)
            self.assertEqual(normalized["startPlayer"], server.PLAYER_COLORS[count - 1])
            if count >= 4:
                self.assertEqual(normalized.get("botCount", 0), 2)
        for count in (1, 7, True, 4.5):
            self.assertEqual(self.manager._normalize_room_settings({"playerCount": count})["playerCount"], 2)


if __name__ == "__main__":
    unittest.main()
