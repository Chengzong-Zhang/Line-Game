"""Protocol checks with a deterministic stand-in verifier; not a rule-engine test."""
from pathlib import Path
import importlib.util
import sys
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE / 'tests'))
from test_topology_settings import _make_patch
spec = importlib.util.spec_from_file_location('wx_unified', HERE / 'web后端/wechat_online.py')
wx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wx)

@pytest.fixture(params=["mock", "node"])
def session(tmp_path, request):
    async def exchange(code, *_): return 'fake-only-' + code
    def verifier(settings, actions, action=None):
        n = len(actions) + (action is not None)
        return {'stateHash': f'fake:{n}', 'currentPlayer': ('BLACK' if n % 2 == 0 else 'WHITE'),
                'gameOver': False, 'winner': None, 'scores': {}, 'resigned': []}
    service = wx.WechatService(wx.WechatStore(tmp_path / 'test.sqlite3'), 'app', 'secret', 's' * 40,
                               exchange=exchange, verifier=verifier if request.param == 'mock' else wx.verify_rules)
    app = FastAPI(); app.include_router(wx.create_router(service))
    with TestClient(app) as client:
        auth = {}
        for name in ('blue','red','third'):
            token = client.post('/api/wechat/login', json={'code':name}).json()['token']
            auth[name] = {'Authorization': 'Bearer ' + token}
        yield client, auth


def test_topology_room_negotiation_and_recovery(session):
    client, auth = session
    cap = ['board-topology-v1']
    settings = {'gridSize': 7, 'playerCount': 2, 'startPlayer': 'BLACK', 'boardShape': 'custom',
                'rulesVersion': 'surface-v1', 'topologyProtocolVersion': cap[0],
                'boardDefinition': _make_patch()}
    post = lambda url, who, body: client.post('/api/wechat/' + url, headers=auth[who], json=body)
    denied = post('rooms', 'blue', settings)
    assert denied.status_code == 422 and denied.json()['detail'] == 'TOPOLOGY_CAPABILITY_REQUIRED'
    created = post('rooms', 'blue', {**settings, 'topologyCapabilities':cap})
    assert created.status_code == 200, created.text
    room = created.json(); code=room['code']; match=room['matchId']
    assert len(room['settings']['boardHash']) == 64
    denied = post('rooms/join', 'red', {'code':code})
    assert denied.status_code == 422 and denied.json()['detail'] == 'TOPOLOGY_CAPABILITY_REQUIRED'
    assert post('rooms/join', 'red', {'code':code, 'topologyCapabilities':cap}).status_code == 200
    assert post(f'rooms/{code}/ready', 'blue', {'matchId':match}).status_code == 200
    ready=post(f'rooms/{code}/ready', 'red', {'matchId':match}).json()
    action={'matchId':match,'expectedSeq':0,'beforeHash':ready['stateHash'],
            'clientActionId':'test-command-000000001','action':{'type':'move','vertexId':'cv:1'}}
    invalid=post(f'rooms/{code}/actions','blue',{**action,'action':{'type':'move','vertexId':'bad'}})
    assert invalid.status_code == 422
    played=post(f'rooms/{code}/actions','blue',action)
    assert played.status_code == 200, played.text
    recovered=client.get(f'/api/wechat/rooms/{code}',headers=auth['red']).json()
    assert recovered['seq'] == 1 and recovered['actions'] == [{'type':'move','vertexId':'cv:1','player':'BLACK'}]
    assert post(f'rooms/{code}/actions','blue',action).status_code == 200


def test_diamond_random_samples_complete_board(monkeypatch):
    import ast, types
    source=(HERE / 'web后端/server.py').read_text(encoding='utf-8-sig')
    definition = next(n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name == 'random_initial_positions')
    module = ast.fix_missing_locations(ast.Module(body=[definition], type_ignores=[]))
    namespace={'secrets':types.SimpleNamespace(randbelow=lambda n:n-1), 'PLAYER_COLORS':wx.PLAYER_COLORS}
    exec(compile(module, 'server.py', 'exec'), namespace)
    points = namespace['random_initial_positions'](5, 2, 'diamond', None)
    assert [4, 4] in points.values()

def test_root_v2_action_survives_room_reload(session):
    client, auth = session
    post = lambda url, who, body: client.post('/api/wechat/' + url, headers=auth[who], json=body)
    created = post('rooms','blue',{'gridSize':7,'playerCount':2,'boardShape':'triangle',
                                  'rulesVersion':'territory-v3','rootMode':'add','rootRulesVersion':'root-v2','rootProtocolVersion':2,'undoEnabled':True})
    assert created.status_code == 200, created.text
    room=created.json(); code=room['code']; match=room['matchId']
    assert post('rooms/join','red',{'code':code}).status_code == 422
    assert post('rooms/join','red',{'code':code,'rootProtocolVersion':2}).status_code == 200
    assert post(f'rooms/{code}/ready','blue',{'matchId':match}).status_code == 200
    ready=post(f'rooms/{code}/ready','red',{'matchId':match}).json()
    first={'matchId':match,'expectedSeq':0,'beforeHash':ready['stateHash'],'clientActionId':'root-action-command-00001',
           'action':{'type':'move','point':[1,0]}}
    moved=post(f'rooms/{code}/actions','blue',first); assert moved.status_code == 200, moved.text
    passed=post(f'rooms/{code}/actions','red',{'matchId':match,'expectedSeq':1,'beforeHash':moved.json()['stateHash'],
        'clientActionId':'root-action-command-00002','action':{'type':'skip'}}); assert passed.status_code == 200, passed.text
    body={'matchId':match,'expectedSeq':2,'beforeHash':passed.json()['stateHash'],'clientActionId':'root-action-command-00003',
          'action':{'type':'root_add','point':[1,0]}}
    result=post(f'rooms/{code}/actions','blue',body)
    assert result.status_code == 200, result.text
    restored=client.get(f'/api/wechat/rooms/{code}',headers=auth['red']).json()
    assert restored['seq']==3 and restored['settings']['rootRulesVersion']=='root-v2'
    assert restored['actions'][2]=={'type':'root_add','point':[1,0],'player':'BLACK'}
    vote={'matchId':match,'expectedSeq':3,'beforeHash':restored['stateHash'],'accept':True}
    assert post(f'rooms/{code}/undo','blue',vote).status_code==200
    undone=post(f'rooms/{code}/undo','red',vote)
    assert undone.status_code==200, undone.text
    assert undone.json()['seq']==2 and [a['type'] for a in undone.json()['actions']]==['move','skip']

def test_random_root_v2_redraw_valid_and_changes():
    initial={'BLACK':[[0,0]],'WHITE':[[6,0]]}
    settings={'gridSize':7,'playerCount':2,'startPlayer':'BLACK','boardShape':'triangle',
              'rulesVersion':'territory-v3','rootMode':'add','rootRulesVersion':'root-v2',
              'startingPointMode':'random','initialRoots':initial}
    roots=wx.random_initial_roots(settings)
    assert roots != initial
    normalized=wx.WechatService.room_settings({**settings,'initialRoots':roots})
    assert wx.verify_rules(normalized,[])['currentPlayer']=='BLACK'

def test_root_switch_waits_for_existing_players_to_advertise(session):
    client, auth = session
    post = lambda url, who, body: client.post('/api/wechat/' + url, headers=auth[who], json=body)
    room=post('rooms','blue',{'gridSize':7,'rulesVersion':'territory-v3','rootProtocolVersion':2}).json()
    code,match=room['code'],room['matchId']
    assert post('rooms/join','red',{'code':code}).status_code==200
    desired={'gridSize':7,'playerCount':2,'rulesVersion':'territory-v3','rootMode':'add','rootRulesVersion':'root-v2'}
    denied=post(f'rooms/{code}/settings','blue',{'matchId':match,'settings':desired})
    assert denied.status_code==422 and denied.json()['detail']=='ROOT_PROTOCOL_REQUIRED'
    assert post('rooms/join','red',{'code':code,'rootProtocolVersion':2}).status_code==200
    accepted=post(f'rooms/{code}/settings','blue',{'matchId':match,'settings':desired})
    assert accepted.status_code==200, accepted.text
    assert accepted.json()['settings']['rootRulesVersion']=='root-v2'


def test_three_player_surface_join_and_ready(session):
    client, auth=session
    post=lambda u,w,b: client.post('/api/wechat/'+u,headers=auth[w],json=b)
    board=_make_patch(); board['startingVertices']['PURPLE']='v:0,3'
    cap=['board-topology-v1']
    created=post('rooms','blue',{'gridSize':7,'playerCount':3,'startPlayer':'BLACK','boardShape':'custom',
       'rulesVersion':'surface-v1','topologyProtocolVersion':cap[0],'topologyCapabilities':cap,'boardDefinition':board})
    assert created.status_code==200, created.text
    room=created.json();code=room['code'];match=room['matchId']
    for who in ('red','third'):
        joined=post('rooms/join',who,{'code':code,'topologyCapabilities':cap});assert joined.status_code==200, joined.text
    for who in ('blue','red','third'):
        ready=post(f'rooms/{code}/ready',who,{'matchId':match});assert ready.status_code==200, ready.text
    assert ready.json()['status']=='playing' and ready.json()['members']=={'BLACK':True,'WHITE':True,'PURPLE':True}

def test_random_board_v4_cross_language_and_authoritative_state():
    import json, subprocess
    script="""import {generateBoard} from './web/web前端/RandomBoard.js';
      const out=generateBoard({gridSize:5,playerCount:2},'service-v4-probe');
      if(!out.ok) throw new Error(JSON.stringify(out.errors));
      process.stdout.write(JSON.stringify({definition:out.definition,boardHash:out.boardHash}));"""
    raw=subprocess.check_output(['node','--input-type=module','-e',script],cwd=HERE.parent,timeout=120)
    result=json.loads(raw)
    config={'gridSize':5,'playerCount':2,'boardShape':'custom','rulesVersion':'surface-v1',
            'topologyProtocolVersion':'board-topology-v1','boardDefinition':result['definition'],'boardHash':result['boardHash']}
    fixed=wx.WechatService.room_settings(config)
    assert fixed['boardHash']==result['boardHash']
    assert fixed['boardDefinition']['generator']['generatorVersion']=='random-board-v4'
    assert wx.verify_rules(fixed,[])['stateHash'].startswith('sha256:')

def test_surface_multiple_roots_survive_canonicalization_and_real_replay():
    board=_make_patch()
    board['startingVertices']={'BLACK':['v:0,0','v:1,0'],'WHITE':['v:3,3','v:4,3']}
    config={'gridSize':7,'playerCount':2,'boardShape':'custom','rulesVersion':'surface-v1',
            'topologyProtocolVersion':'board-topology-v1','boardDefinition':board}
    fixed=wx.WechatService.room_settings(config)
    assert len(fixed['boardDefinition']['startingVertices']['BLACK'])==2
    assert len(fixed['boardDefinition']['startingVertices']['WHITE'])==2
    first=wx.verify_rules(fixed,[])
    replay=wx.verify_rules(fixed,[{'type':'skip','player':'BLACK'}])
    assert first['stateHash'].startswith('sha256:') and replay['currentPlayer']=='WHITE'
