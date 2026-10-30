from pathlib import Path
import importlib.util
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('turn_order_service', ROOT / 'web/web后端/wechat_online.py')
wx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wx)


def test_shared_room_non_rotational_order_and_rejects_invalid(tmp_path):
    async def exchange(code, *_): return 'turn-order-' + code
    service = wx.WechatService(wx.WechatStore(tmp_path / 'rooms.sqlite3'), 'app', 'secret', 'x' * 40, exchange=exchange)
    app = FastAPI(); app.include_router(wx.create_router(service))
    with TestClient(app) as client:
        auth = {}
        for name in ['black', 'white', 'purple', 'green']:
            token = client.post('/api/wechat/login', json={'code': name}).json()['token']
            auth[name.upper()] = {'Authorization': 'Bearer ' + token}
        def post(path, player, body):
            return client.post('/api/wechat/' + path, headers=auth[player], json=body)
        order = ['PURPLE', 'BLACK', 'GREEN', 'WHITE']
        config = {'gridSize': 5, 'playerCount': 4, 'startPlayer': 'PURPLE', 'turnOrder': order,
                  'rulesVersion': 'territory-v3', 'boardShape': 'hexagon'}
        for bad in [['PURPLE', 'BLACK', 'BLACK', 'WHITE'], ['BLACK', 'PURPLE', 'GREEN', 'WHITE'], ['PURPLE']]:
            assert post('rooms', 'BLACK', {**config, 'turnOrder': bad}).status_code == 422
        created = post('rooms', 'BLACK', config); assert created.status_code == 200, created.text
        room = created.json(); code = room['code']; match = room['matchId']
        assert room['settings']['turnOrder'] == order
        for player in ['WHITE', 'PURPLE', 'GREEN']:
            response = post('rooms/join', player, {'code': code}); assert response.status_code == 200, response.text
            assert response.json()['player'] == player
        for player in ['BLACK', 'WHITE', 'PURPLE', 'GREEN']:
            response = post(f'rooms/{code}/ready', player, {'matchId': match}); assert response.status_code == 200, response.text
        room = response.json(); assert room['currentPlayer'] == 'PURPLE'
        for i, player in enumerate(order):
            response = post(f'rooms/{code}/actions', player, {'matchId': match, 'expectedSeq': room['seq'],
                'beforeHash': room['stateHash'], 'clientActionId': f'turn-order-test-{i:04d}', 'action': {'type': 'skip'}})
            assert response.status_code == 200, response.text
            room = response.json()
            if i < 3: assert room['currentPlayer'] == order[i + 1]
        assert room['status'] == 'finished'
        restored = client.get(f'/api/wechat/rooms/{code}', headers=auth['BLACK']).json()
        assert restored['settings']['turnOrder'] == order
        assert [a['player'] for a in restored['actions']] == order
