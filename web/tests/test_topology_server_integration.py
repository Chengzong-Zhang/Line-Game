"""End-to-end websocket-message contracts for topology rooms.

These tests deliberately use ``ConnectionManager.handle_message`` rather than
private normalization helpers.  They therefore cover the same create, join,
move, room-snapshot and legacy compatibility boundaries as the WebSocket
protocol.
"""

from copy import deepcopy
import json
import subprocess
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "web后端"))
import server
from board_validation import canonicalize_board_definition


TOPOLOGY_CAPABILITY = "board-topology-v1"


class SocketProbe:
    def __init__(self, name):
        self.state = SimpleNamespace(username=name)
        self.messages = []

    async def send_json(self, payload):
        self.messages.append(deepcopy(payload))


def topology_definition():
    """A complete, small canonical map with two explicit starts."""

    return {
        "schemaVersion": 1,
        "coordinateSystem": "triangular-axial-v1",
        "topology": {
            "family": "planar",
            "movementStrategy": "simple-rays-v1",
            "territoryStrategy": "surface-discrete-v1",
            "specialVertexPolicy": "stop",
        },
        "vertices": [
            {"id": "v:0,0", "coordinate": [0, 0]},
            {"id": "v:1,0", "coordinate": [1, 0]},
            {"id": "v:0,1", "coordinate": [0, 1]},
        ],
        "faces": [{
            "id": "u:0,0",
            "vertices": ["v:0,0", "v:1,0", "v:0,1"],
        }],
        "seamPairs": [],
        "startingVertices": {"BLACK": "v:0,0", "WHITE": "v:1,0"},
        "scoring": {"strategy": "canonical-vertices-v1"},
    }


def topology_settings(*, board_hash=None):
    definition = topology_definition()
    canonical = canonicalize_board_definition(definition)
    assert canonical["ok"], canonical.get("errors")
    return {
        "playerCount": 2,
        "gridSize": 5,
        "startPlayer": "BLACK",
        "rulesVersion": "surface-v1",
        "boardShape": "custom",
        "boardDefinition": definition,
        "boardHash": canonical["boardHash"] if board_hash is None else board_hash,
        "botCount": 0,
    }


class TopologyServerIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.manager = server.ConnectionManager()

    async def asyncTearDown(self):
        await self.manager.stop()

    async def _create_topology_room(self, host):
        settings = topology_settings()
        await self.manager.handle_message(host, {
            "type": "create_room",
            "settings": settings,
            "topologyCapabilities": [TOPOLOGY_CAPABILITY],
        })
        payload = host.messages[-1]
        self.assertEqual(payload["type"], "ROOM_CREATED", payload)
        self.assertEqual(payload["settings"]["rulesVersion"], "surface-v1")
        self.assertEqual(payload["settings"]["boardShape"], "custom")
        self.assertEqual(payload["settings"]["boardDefinition"], canonicalize_board_definition(settings["boardDefinition"])["definition"])
        self.assertEqual(payload["settings"]["boardHash"], settings["boardHash"])
        self.assertEqual(payload["settings"]["topologyProtocolVersion"], TOPOLOGY_CAPABILITY)
        return payload["roomId"], settings["boardHash"]

    async def test_create_room_keeps_server_canonical_topology_map(self):
        host = SocketProbe("topology-host")
        await self._create_topology_room(host)

    async def test_complex_multi_root_map_survives_creation_join_and_reconnect(self):
        root = Path(__file__).resolve().parents[2]
        fixture = root / "web" / "web前端" / "tests" / "fixtures" / "board-topology-round2-cross-language.mjs"
        cases = json.loads(subprocess.check_output(["node", str(fixture)], cwd=root, text=True, encoding="utf-8"))
        for case in cases:
            host, guest, reconnect = SocketProbe("complex-host"), SocketProbe("complex-guest"), SocketProbe("complex-guest")
            settings = topology_settings()
            settings["boardDefinition"] = case["definition"]
            settings["boardHash"] = case["boardHash"]
            await self.manager.handle_message(host, {"type":"create_room", "settings":settings, "topologyCapabilities":[TOPOLOGY_CAPABILITY]})
            created = host.messages[-1]
            self.assertEqual(created["type"], "ROOM_CREATED", created)
            self.assertEqual(created["settings"]["boardDefinition"], case["definition"])
            room_id = created["roomId"]
            for peer in (guest, reconnect):
                await self.manager.handle_message(peer, {"type":"join_room", "roomId":room_id, "topologyCapabilities":[TOPOLOGY_CAPABILITY]})
                joined = peer.messages[-1]
                self.assertEqual(joined["type"], "ROOM_JOINED", joined)
                self.assertEqual(joined["settings"]["boardDefinition"], case["definition"])
                self.assertEqual(joined["settings"]["boardHash"], case["boardHash"])
            self.assertTrue(reconnect.messages[-1]["reconnected"])
            await self.manager.stop()
            self.manager = server.ConnectionManager()

    async def test_mismatched_client_hash_is_rejected_without_creating_a_room(self):
        host = SocketProbe("bad-topology-hash")
        await self.manager.handle_message(host, {
            "type": "create_room",
            "settings": topology_settings(board_hash="0" * 64),
            "topologyCapabilities": [TOPOLOGY_CAPABILITY],
        })
        self.assertEqual(host.messages[-1]["type"], "ERROR")
        self.assertEqual(host.messages[-1]["code"], "BOARD_HASH_MISMATCH")
        self.assertFalse(self.manager.rooms)

    async def test_join_without_capability_is_rejected_before_room_membership_changes(self):
        host = SocketProbe("topology-host")
        guest = SocketProbe("legacy-guest")
        room_id, _ = await self._create_topology_room(host)
        await self.manager.handle_message(guest, {
            "type": "join_room",
            "roomId": room_id,
            "topologyCapabilities": [],
        })
        self.assertEqual(guest.messages[-1]["type"], "ERROR")
        self.assertEqual(guest.messages[-1]["code"], "TOPOLOGY_CAPABILITY_REQUIRED")
        self.assertEqual(set(self.manager.rooms[room_id].players), {"topology-host"})

    async def test_topology_move_is_recorded_and_forwarded_by_vertex_and_hash(self):
        host = SocketProbe("topology-host")
        guest = SocketProbe("topology-guest")
        room_id, board_hash = await self._create_topology_room(host)
        await self.manager.handle_message(guest, {
            "type": "join_room",
            "roomId": room_id,
            "topologyCapabilities": [TOPOLOGY_CAPABILITY],
        })
        self.assertEqual(guest.messages[-1]["type"], "ROOM_JOINED")
        room = self.manager.rooms[room_id]
        room.match_started = True
        await self.manager.handle_message(host, {
            "type": "player_move",
            "vertexId": "cv:1",
            "boardHash": board_hash,
        })
        expected_action = {
            "type": "player_move",
            "vertexId": "cv:1",
            "boardHash": board_hash,
            "playerId": "topology-host",
            "color": "BLACK",
        }
        self.assertEqual(room.actions[-1], expected_action)
        forwarded = guest.messages[-1]
        self.assertEqual(forwarded["type"], "OPPONENT_MOVE")
        self.assertEqual(forwarded["vertexId"], "cv:1")
        self.assertEqual(forwarded["boardHash"], board_hash)
        self.assertNotIn("point", forwarded)
        self.assertEqual(room.actions, [expected_action])

    async def test_reconnect_receives_the_fixed_map_hash_and_vertex_action_log(self):
        host = SocketProbe("reconnect-host")
        guest = SocketProbe("reconnect-guest")
        reconnect = SocketProbe("reconnect-guest")
        room_id, board_hash = await self._create_topology_room(host)
        await self.manager.handle_message(guest, {
            "type": "join_room",
            "roomId": room_id,
            "topologyCapabilities": [TOPOLOGY_CAPABILITY],
        })
        room = self.manager.rooms[room_id]
        room.match_started = True
        await self.manager.handle_message(host, {
            "type": "player_move",
            "vertexId": "cv:1",
            "boardHash": board_hash,
        })

        await self.manager.handle_message(reconnect, {
            "type": "join_room",
            "roomId": room_id,
            "topologyCapabilities": [TOPOLOGY_CAPABILITY],
        })
        snapshot = reconnect.messages[-1]
        self.assertEqual(snapshot["type"], "ROOM_JOINED")
        self.assertTrue(snapshot["reconnected"])
        self.assertEqual(snapshot["settings"]["boardHash"], board_hash)
        self.assertEqual(snapshot["settings"]["boardDefinition"], canonicalize_board_definition(topology_definition())["definition"])
        self.assertEqual(snapshot["matchState"]["actions"], [{
            "type": "player_move",
            "vertexId": "cv:1",
            "boardHash": board_hash,
            "playerId": "reconnect-host",
            "color": "BLACK",
        }])

    async def test_legacy_coordinate_move_remains_unchanged(self):
        host = SocketProbe("legacy-host")
        guest = SocketProbe("legacy-guest")
        await self.manager.handle_message(host, {
            "type": "create_room",
            "settings": {"playerCount": 2, "gridSize": 5, "boardShape": "triangle"},
        })
        room_id = host.messages[-1]["roomId"]
        await self.manager.handle_message(guest, {"type": "join_room", "roomId": room_id})
        room = self.manager.rooms[room_id]
        room.match_started = True
        await self.manager.handle_message(host, {"type": "player_move", "point": [1, 0]})
        self.assertEqual(room.actions[-1], {
            "type": "player_move",
            "point": [1, 0],
            "playerId": "legacy-host",
            "color": "BLACK",
        })
        self.assertEqual(guest.messages[-1]["type"], "OPPONENT_MOVE")
        self.assertEqual(guest.messages[-1]["point"], [1, 0])
        self.assertNotIn("vertexId", guest.messages[-1])


if __name__ == "__main__":
    unittest.main()
