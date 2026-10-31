"""Synthetic direct-room probe; the caller supplies an isolated source and DB."""
import argparse
import asyncio
from copy import deepcopy
import importlib
import json
from pathlib import Path
import sys
from types import SimpleNamespace


class Socket:
    def __init__(self, name):
        self.state = SimpleNamespace(username=name)
        self.messages = []

    async def send_json(self, message):
        self.messages.append(deepcopy(message))


async def verify(root):
    sys.path.insert(0, str(root / 'web/web后端'))
    server = importlib.import_module('server')
    bridge = importlib.import_module('online_bots')
    assert server.DEFAULT_RULES_VERSION == 'territory-v3'
    manager = server.ConnectionManager()
    try:
        host, guest = Socket('fixture-host'), Socket('fixture-guest')
        starts = {'BLACK': [0, 0], 'WHITE': [4, 0]}
        await manager.create_room(host, host.state.username, {
            'playerCount': 2, 'gridSize': 5, 'boardShape': 'triangle',
            'startingPointMode': 'custom', 'initialPositions': starts,
            'undoEnabled': True, 'undoMaxCount': 3,
        })
        code = manager.websocket_index[host][0]
        await manager.join_room(guest, code, guest.state.username)
        room = manager.rooms[code]
        assert room.settings['rulesVersion'] == 'territory-v3'
        assert room.settings['initialPositions'] == starts
        room.match_started = True
        room.actions = [{'type': 'player_move', 'point': [1, 0], 'color': 'BLACK'}]
        await manager.forward_undo(host, True)
        assert len(room.actions) == 1
        await manager.forward_undo(guest, True)
        assert room.actions == [] and room.undo_used_count == 1
        for version in ('territory-v2', 'territory-v3'):
            result = await bridge.evaluate_room({'playerCount': 3, 'gridSize': 5,
                'rulesVersion': version, 'startPlayer': 'BLACK'}, [], ['BLACK'])
            assert result['success'] is True and result['fallback'] is False
        return {'status': 'PASS_LEGACY_V3_SETTINGS_UNDO_PROBE', 'checks': 6,
                'scope': 'temporary SQLite path, synthetic sockets, real bounded Node model bridge'}
    finally:
        await manager.stop()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    print(json.dumps(asyncio.run(verify(parser.parse_args().root.resolve()))))
