"""ASGI WebSocket transport contracts for topology rooms.

``test_topology_server_integration.py`` already verifies the manager directly.
This separate test drives the public ``/ws`` endpoint's token, accept, receive,
dispatch, and send loop with scripted in-process WebSocket doubles.  It does
not claim real-browser, network, or rules-adjudication coverage.
"""

from copy import deepcopy
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import WebSocketDisconnect


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "web后端"))
import server
from board_validation import canonicalize_board_definition


class ScriptedWebSocket:
    """A finite fake WebSocket accepted by the actual ``/ws`` endpoint."""

    def __init__(self, username, incoming):
        self.query_params = {"token": server.create_access_token(username)}
        self.state = SimpleNamespace()
        self._incoming = list(incoming)
        self.accepted = 0
        self.closed = []
        self.outbox = []

    async def accept(self):
        self.accepted += 1

    async def receive_json(self):
        if self._incoming:
            return self._incoming.pop(0)
        raise WebSocketDisconnect(code=1000)

    async def send_json(self, payload):
        self.outbox.append(deepcopy(payload))

    async def close(self, **kwargs):
        self.closed.append(kwargs)

    def latest(self, message_type):
        matches = [message for message in self.outbox if message["type"] == message_type]
        if not matches:
            raise AssertionError(f"Missing {message_type!r}: {self.outbox!r}")
        return matches[-1]


def topology_definition():
    """A deliberately noncanonical-order, complete two-player board draft."""

    return {
        "schemaVersion": 1,
        "coordinateSystem": "triangular-axial-v1",
        "topology": {
            "family": "planar",
            "movementStrategy": "simple-rays-v1",
            "territoryStrategy": "surface-discrete-v1",
            "specialVertexPolicy": "stop",
        },
        # The reversed declaration checks that clients receive the server's
        # canonical payload rather than merely an echoed draft.
        "vertices": [
            {"id": "v:1,0", "coordinate": [1, 0]},
            {"id": "v:0,1", "coordinate": [0, 1]},
            {"id": "v:0,0", "coordinate": [0, 0]},
        ],
        "faces": [{
            "id": "u:0,0",
            "vertices": ["v:0,0", "v:1,0", "v:0,1"],
        }],
        "seamPairs": [],
        "startingVertices": {"WHITE": "v:1,0", "BLACK": "v:0,0"},
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


class TopologyWebSocketProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.manager = server.ConnectionManager()
        self.manager_patch = patch.object(server, "manager", self.manager)
        self.manager_patch.start()

    async def asyncTearDown(self):
        self.manager_patch.stop()
        await self.manager.stop()

    async def run_endpoint(self, websocket):
        await server.websocket_endpoint(websocket)
        self.assertEqual(websocket.accepted, 1)
        return websocket

    async def create_topology_room(self):
        settings = topology_settings()
        canonical = canonicalize_board_definition(settings["boardDefinition"])
        self.assertTrue(canonical["ok"], canonical.get("errors"))
        rejected_host = ScriptedWebSocket("topology-wire-host", [
            {"type": "create_room", "settings": settings, "topologyCapabilities": []},
        ])
        await self.run_endpoint(rejected_host)
        self.assertEqual(rejected_host.latest("ERROR")["code"], "TOPOLOGY_CAPABILITY_REQUIRED")
        self.assertFalse(self.manager.rooms)

        host = ScriptedWebSocket("topology-wire-host", [
            {
                "type": "create_room",
                "settings": settings,
                "topologyCapabilities": [server.TOPOLOGY_ROOM_PROTOCOL_VERSION],
            },
        ])
        await self.run_endpoint(host)
        created = host.latest("ROOM_CREATED")
        self.assertEqual(created["settings"]["boardDefinition"], canonical["definition"])
        self.assertEqual(created["settings"]["boardHash"], canonical["boardHash"])
        self.assertEqual(
            created["settings"]["topologyProtocolVersion"],
            server.TOPOLOGY_ROOM_PROTOCOL_VERSION,
        )
        return created["roomId"], canonical, host

    async def test_topology_endpoint_gates_clients_and_relays_vertex_move(self):
        room_id, canonical, _ = await self.create_topology_room()
        board_hash = canonical["boardHash"]
        self.assertEqual(set(self.manager.rooms[room_id].players), {"topology-wire-host"})

        unsupported = ScriptedWebSocket("topology-wire-legacy", [{
            "type": "join_room", "roomId": room_id,
        }])
        await self.run_endpoint(unsupported)
        self.assertEqual(unsupported.latest("ERROR")["code"], "TOPOLOGY_CAPABILITY_REQUIRED")
        self.assertEqual(set(self.manager.rooms[room_id].players), {"topology-wire-host"})

        # First drive the joining client's own endpoint loop; its scripted
        # disconnect is deliberate.  A replacement socket below remains
        # connected to make the later relay observable without timers.
        guest_initial = ScriptedWebSocket("topology-wire-guest", [{
            "type": "join_room",
            "roomId": room_id,
            "topologyCapabilities": [server.TOPOLOGY_ROOM_PROTOCOL_VERSION],
        }])
        await self.run_endpoint(guest_initial)
        joined = guest_initial.latest("ROOM_JOINED")
        self.assertEqual(joined["settings"]["boardDefinition"], canonical["definition"])
        self.assertEqual(joined["settings"]["boardHash"], board_hash)

        persistent_guest = ScriptedWebSocket("topology-wire-guest", [])
        await self.manager.connect(persistent_guest, "topology-wire-guest")
        await self.manager.join_room(
            persistent_guest,
            room_id,
            "topology-wire-guest",
            topology_capabilities=[server.TOPOLOGY_ROOM_PROTOCOL_VERSION],
        )
        self.assertTrue(persistent_guest.latest("ROOM_JOINED")["reconnected"])

        # The reconnecting host reaches the public endpoint for join and both
        # move payloads.  This three-vertex definition compiles to exactly
        # ``cv:0``, ``cv:1`` and ``cv:2``; Canvas hit testing sends that
        # canonical identity, never a raw ``v:x,y`` source identifier.  The
        # peer's delivery is observed through the same manager transport used
        # by the endpoint.
        host_reconnect = ScriptedWebSocket("topology-wire-host", [
            {
                "type": "join_room",
                "roomId": room_id,
                "topologyCapabilities": [server.TOPOLOGY_ROOM_PROTOCOL_VERSION],
            },
            {
                "type": "player_move",
                "vertexId": "cv:1",
                "boardHash": "0" * 64,
            },
            {
                "type": "player_move",
                # A valid source identifier is still not a wire identity:
                # accepting it would reintroduce cross-runtime aliasing.
                "vertexId": "v:0,1",
                "boardHash": board_hash,
            },
            {
                "type": "player_move",
                "vertexId": "cv:99",
                "boardHash": board_hash,
            },
            {
                "type": "player_move",
                # The protocol uses the exact canonical spelling, not a
                # numeric parser that silently accepts leading zeroes.
                "vertexId": "cv:01",
                "boardHash": board_hash,
            },
            {
                "type": "player_move",
                "vertexId": "cv:1",
                "boardHash": board_hash,
            },
        ])
        room = self.manager.rooms[room_id]
        room.match_started = True
        await self.run_endpoint(host_reconnect)
        self.assertEqual(
            [message["code"] for message in host_reconnect.outbox if message["type"] == "ERROR"],
            [
                "BOARD_HASH_MISMATCH",
                "UNKNOWN_TOPOLOGY_VERTEX_ID",
                "UNKNOWN_TOPOLOGY_VERTEX_ID",
                "UNKNOWN_TOPOLOGY_VERTEX_ID",
            ],
        )
        self.assertEqual(room.actions, [{
            "type": "player_move",
            "vertexId": "cv:1",
            "boardHash": board_hash,
            "playerId": "topology-wire-host",
            "color": "BLACK",
        }])
        relayed = persistent_guest.latest("OPPONENT_MOVE")
        self.assertEqual(relayed["vertexId"], "cv:1")
        self.assertEqual(relayed["boardHash"], board_hash)
        self.assertNotIn("point", relayed)

    async def test_legacy_endpoint_protocol_still_uses_coordinate_point(self):
        host = ScriptedWebSocket("legacy-wire-host", [{
            "type": "create_room",
            "settings": {"playerCount": 2, "gridSize": 5, "boardShape": "triangle"},
        }])
        await self.run_endpoint(host)
        room_id = host.latest("ROOM_CREATED")["roomId"]

        guest_initial = ScriptedWebSocket("legacy-wire-guest", [{
            "type": "join_room", "roomId": room_id,
        }])
        await self.run_endpoint(guest_initial)
        self.assertEqual(guest_initial.latest("ROOM_JOINED")["settings"]["boardShape"], "triangle")

        persistent_guest = ScriptedWebSocket("legacy-wire-guest", [])
        await self.manager.connect(persistent_guest, "legacy-wire-guest")
        await self.manager.join_room(persistent_guest, room_id, "legacy-wire-guest")
        self.assertTrue(persistent_guest.latest("ROOM_JOINED")["reconnected"])

        host_reconnect = ScriptedWebSocket("legacy-wire-host", [
            {"type": "join_room", "roomId": room_id},
            {"type": "player_move", "point": [1, 0]},
        ])
        self.manager.rooms[room_id].match_started = True
        await self.run_endpoint(host_reconnect)
        relayed = persistent_guest.latest("OPPONENT_MOVE")
        self.assertEqual(relayed["point"], [1, 0])
        self.assertNotIn("vertexId", relayed)
        self.assertNotIn("boardHash", relayed)


if __name__ == "__main__":
    unittest.main()
