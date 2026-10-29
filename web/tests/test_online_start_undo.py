"""Room settings and server-authoritative undo vote regression."""
from copy import deepcopy
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "web后端"))
import server


class SocketProbe:
    def __init__(self, name):
        self.state = SimpleNamespace(username=name)
        self.messages = []

    async def send_json(self, payload):
        self.messages.append(deepcopy(payload))


class OnlineStartUndoTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.manager = server.ConnectionManager()

    async def asyncTearDown(self):
        await self.manager.stop()

    def test_settings_validate_shape_starts_and_undo(self):
        starts = {"BLACK": [0, 0], "WHITE": [4, 0]}
        result = self.manager._normalize_room_settings({
            "playerCount": 2, "gridSize": 5, "boardShape": "triangle",
            "startingPointMode": "random", "initialPositions": starts,
            "undoEnabled": True, "undoMaxCount": 999,
        })
        self.assertEqual(result["initialPositions"], starts)
        self.assertEqual(result["startingPointMode"], "random")
        self.assertEqual(result["undoMaxCount"], 100)
        self.assertTrue(result["undoEnabled"])
        starts["BLACK"][0] = 3
        self.assertEqual(result["initialPositions"]["BLACK"], [0, 0])
        for invalid in ({"BLACK": [0, 0], "WHITE": [0, 0]},
                        {"BLACK": [0, 0], "WHITE": [5, 0]},
                        {"BLACK": [True, 0], "WHITE": [4, 0]}):
            self.assertNotIn("initialPositions", self.manager._normalize_room_settings({
                "playerCount": 2, "gridSize": 5, "startingPointMode": "custom",
                "initialPositions": invalid,
            }))
        hex_starts = {"BLACK": [4, 0], "WHITE": [0, 4], "PURPLE": [8, 4], "GREEN": [4, 8]}
        self.assertEqual(self.manager._normalize_room_settings({
            "playerCount": 4, "gridSize": 5, "boardShape": "hexagon",
            "startingPointMode": "custom", "initialPositions": hex_starts,
        })["initialPositions"], hex_starts)

    async def test_all_humans_vote_before_latest_action_is_removed(self):
        host, guest = SocketProbe("undo-host"), SocketProbe("undo-guest")
        starts = {"BLACK": [0, 0], "WHITE": [4, 0]}
        await self.manager.create_room(host, host.state.username, {
            "gridSize": 5, "startingPointMode": "custom", "initialPositions": starts,
            "undoEnabled": True, "undoMaxCount": 1,
        })
        room_id = host.messages[-1]["roomId"]
        await self.manager.join_room(guest, room_id, guest.state.username)
        room = self.manager.rooms[room_id]
        self.assertEqual(guest.messages[-1]["settings"]["initialPositions"], starts)
        room.match_started = True
        room.actions = [{"type": "player_move", "point": [1, 0], "color": "BLACK"}]
        await self.manager.forward_undo(host, True)
        self.assertEqual(room.actions[-1]["point"], [1, 0])
        self.assertEqual(guest.messages[-1]["type"], "UNDO_STATUS")
        self.assertEqual(guest.messages[-1]["undo"]["requiredVotes"], 2)
        await self.manager.forward_move(guest, [2, 0])
        self.assertEqual(guest.messages[-1]["code"], "UNDO_PENDING")
        await self.manager.forward_undo(guest, True)
        self.assertEqual(room.actions, [])
        self.assertEqual(room.undo_used_count, 1)
        self.assertEqual(host.messages[-1]["type"], "ROOM_UNDO")
        self.assertEqual(host.messages[-1]["matchState"]["actions"], [])
        room.actions = [{"type": "player_move", "point": [1, 0], "color": "BLACK"}]
        await self.manager.forward_undo(host, True)
        self.assertEqual(host.messages[-1]["code"], "UNDO_LIMIT")

    async def test_rejection_preserves_history(self):
        host, guest = SocketProbe("reject-host"), SocketProbe("reject-guest")
        await self.manager.create_room(host, host.state.username, {"undoEnabled": True})
        room_id = host.messages[-1]["roomId"]
        await self.manager.join_room(guest, room_id, guest.state.username)
        room = self.manager.rooms[room_id]
        room.match_started = True
        room.actions = [{"type": "player_move", "point": [1, 0], "color": "BLACK"},
                        {"type": "player_skip", "color": "WHITE"}]
        await self.manager.forward_undo(host, True)
        await self.manager.forward_undo(guest, False)
        self.assertFalse(room.undo_votes)
        self.assertIsNone(room.undo_target)
        self.assertEqual(len(room.actions), 2)
        self.assertEqual(host.messages[-1]["type"], "UNDO_STATUS")
        self.assertFalse(host.messages[-1]["undo"]["pending"])


    async def test_requester_latest_placement_and_replies_can_be_undone_repeatedly(self):
        host, guest = SocketProbe("repeat-host"), SocketProbe("repeat-guest")
        await self.manager.create_room(host, host.state.username, {"undoEnabled": True, "undoMaxCount": 100})
        room_id = host.messages[-1]["roomId"]
        await self.manager.join_room(guest, room_id, guest.state.username)
        room = self.manager.rooms[room_id]
        room.match_started = True
        first_round = [{"type": "player_move", "point": [1, 0], "color": "BLACK"},
                       {"type": "player_move", "point": [7, 0], "color": "WHITE"}]
        room.actions = deepcopy(first_round) + [
            {"type": "player_move", "point": [2, 0], "color": "BLACK"},
            {"type": "player_move", "point": [6, 0], "color": "WHITE"},
            {"type": "player_skip", "color": "BLACK"},
        ]
        await self.manager.forward_undo(host, True)
        self.assertEqual(room.undo_action_index, 2)
        self.assertEqual(len(room.actions), 5, "request alone must preserve every action")
        await self.manager.forward_undo(guest, True)
        self.assertEqual(room.actions, first_round, "the confirming player must not retarget the request")
        self.assertEqual(room.undo_used_count, 1)
        self.assertIsNone(room.undo_action_index)
        self.assertEqual(host.messages[-1]["matchState"]["actions"], first_round)
        await self.manager.forward_undo(host, True)
        await self.manager.forward_undo(guest, True)
        self.assertEqual(room.actions, [])
        self.assertEqual(room.undo_used_count, 2)

    async def test_no_own_placement_cannot_request_undo(self):
        host, guest = SocketProbe("no-move-host"), SocketProbe("no-move-guest")
        await self.manager.create_room(host, host.state.username, {"undoEnabled": True})
        room_id = host.messages[-1]["roomId"]
        await self.manager.join_room(guest, room_id, guest.state.username)
        room = self.manager.rooms[room_id]
        room.match_started = True
        room.actions = [{"type": "player_skip", "color": "BLACK"},
                        {"type": "player_move", "point": [7, 0], "color": "WHITE"}]
        await self.manager.forward_undo(host, True)
        self.assertEqual(host.messages[-1]["code"], "UNDO_UNAVAILABLE")
        self.assertIsNone(room.undo_target)
        self.assertIsNone(room.undo_action_index)
        self.assertEqual(room.undo_used_count, 0)

    async def test_stale_vote_preserves_history_and_quota(self):
        host, guest = SocketProbe("stale-host"), SocketProbe("stale-guest")
        await self.manager.create_room(host, host.state.username, {"undoEnabled": True})
        room_id = host.messages[-1]["roomId"]
        await self.manager.join_room(guest, room_id, guest.state.username)
        room = self.manager.rooms[room_id]
        room.match_started = True
        room.actions = [{"type": "player_move", "point": [1, 0], "color": "BLACK"}]
        await self.manager.forward_undo(host, True)
        room.actions.append({"type": "player_skip", "color": "WHITE"})
        await self.manager.forward_undo(guest, True)
        self.assertEqual(guest.messages[-1]["code"], "UNDO_STALE")
        self.assertEqual(len(room.actions), 2)
        self.assertEqual(room.undo_used_count, 0)
        self.assertIsNone(room.undo_action_index)

    async def test_all_bot_replies_are_removed_with_requester_placement(self):
        host = SocketProbe("bot-undo-host")
        await self.manager.create_room(host, host.state.username, {
            "playerCount": 3, "botCount": 2, "undoEnabled": True,
        })
        room = self.manager.rooms[host.messages[-1]["roomId"]]
        room.match_started = True
        self.manager._schedule_bots_locked = lambda room: None
        room.actions = [
            {"type": "player_move", "point": [1, 0], "color": "BLACK"},
            {"type": "player_move", "point": [7, 0], "color": "WHITE"},
            {"type": "player_skip", "color": "PURPLE"},
        ]
        await self.manager.forward_undo(host, True)
        self.assertEqual(room.actions, [])
        self.assertEqual(room.undo_used_count, 1)
        self.assertEqual(host.messages[-1]["type"], "ROOM_UNDO")

if __name__ == "__main__":
    unittest.main()
