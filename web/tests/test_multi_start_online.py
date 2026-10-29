"""Authoritative multi-root room protocol, deduplication and recovery."""
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


class MultiStartOnlineTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.manager = server.ConnectionManager()

    async def asyncTearDown(self):
        await self.manager.stop()

    def test_settings_are_versioned_and_strict(self):
        normalized = self.manager._normalize_room_settings({
            "playerCount": 2, "gridSize": 5, "boardShape": "triangle",
            "rulesVersion": "territory-v3", "rootMode": "fixed-double", "rootRulesVersion": "root-v2",
        })
        self.assertEqual(normalized["rootMode"], "fixed-double")
        self.assertEqual(normalized["rootRulesVersion"], "root-v2")
        for invalid in (
            {"playerCount": 3, "rulesVersion": "territory-v3", "rootMode": "fixed-double"},
            {"playerCount": 2, "rulesVersion": "territory-v2", "rootMode": "add"},
            {"playerCount": 2, "rulesVersion": "territory-v3", "rootMode": "unknown"},
        ):
            with self.assertRaises(ValueError):
                self.manager._normalize_room_settings(invalid)

    async def test_protocol_rejection_rule_validation_dedup_and_reconnect(self):
        host, old_guest, guest = SocketProbe("root-host"), SocketProbe("root-old"), SocketProbe("root-guest")
        await self.manager.create_room(host, host.state.username, {
            "playerCount": 2, "gridSize": 5, "boardShape": "triangle",
            "rulesVersion": "territory-v3", "rootMode": "add", "rootRulesVersion": "root-v2",
            "undoEnabled": True,
        }, root_protocol_version=2)
        room_id = host.messages[-1]["roomId"]
        await self.manager.join_room(old_guest, room_id, old_guest.state.username)
        self.assertEqual(old_guest.messages[-1]["code"], "ROOT_PROTOCOL_REQUIRED")
        await self.manager.join_room(guest, room_id, guest.state.username, root_protocol_version=2)
        room = self.manager.rooms[room_id]
        room.match_started = True

        self.assertTrue(await self.manager._route_bot_room_action(host, "player_move", [1, 0], action_id="a1"))
        self.assertTrue(await self.manager._route_bot_room_action(guest, "player_move", [3, 0], action_id="a2"))
        self.assertTrue(await self.manager._route_bot_room_action(host, "player_root_add", [1, 0], action_id="a3", require_versioned_room=True))
        self.assertEqual([item["type"] for item in room.actions], ["player_move", "player_move", "player_root_add"])
        self.assertEqual([item["actionIndex"] for item in room.actions], [1, 2, 3])
        self.assertEqual(room.actions[-1]["actionId"], "a3")
        before = deepcopy(room.actions)
        await self.manager._route_bot_room_action(host, "player_root_add", [1, 0], action_id="a3", require_versioned_room=True)
        self.assertEqual(room.actions, before)
        self.assertEqual(host.messages[-2]["code"], "DUPLICATE_ACTION")
        self.assertEqual(host.messages[-1]["type"], "ROOM_STATE")

        room.players[guest.state.username].connected = False
        room.players[guest.state.username].websocket = None
        self.manager.websocket_index.pop(guest, None)
        reconnect = SocketProbe("root-guest")
        await self.manager.join_room(reconnect, room_id, reconnect.state.username, root_protocol_version=2)
        snapshot = reconnect.messages[0]
        self.assertTrue(snapshot["reconnected"])
        self.assertEqual(snapshot["rootProtocolVersion"], 2)
        self.assertEqual(snapshot["matchState"]["actions"], room.actions)

        room.undo_target = None
        room.undo_votes.clear()
        await self.manager.forward_undo(host, True)
        await self.manager.forward_undo(reconnect, True)
        self.assertEqual([item["type"] for item in room.actions], ["player_move", "player_move"])
        self.assertEqual(room.action_ids, {"a1", "a2"})


if __name__ == "__main__":
    unittest.main()
