"""Cross-client ordered snapshots from actual isolated HTTP rooms and Node rules."""
from pathlib import Path
import importlib.util
import json
import subprocess
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('ordered_http_service', ROOT / 'web/web后端/wechat_online.py')
wx = importlib.util.module_from_spec(spec); spec.loader.exec_module(wx)


def test_real_http_shared_room_order_reaches_web_controller(tmp_path):
    async def exchange(code, *_): return 'ordered-web-fixture-' + code
    service = wx.WechatService(wx.WechatStore(tmp_path/'room.sqlite3'), 'app', 'secret', 'x'*40, exchange=exchange)
    app=FastAPI(); app.include_router(wx.create_router(service))
    setup_script = """import {createTopologySetup,useTopologyPreset} from './wechat/minigame/src/topology-setup.js';
      const r=useTopologyPreset(createTopologySetup(),'cylinder',{gridSize:5,playerCount:4});
      if(!r.ok) throw Error('fixture board failed'); console.log(JSON.stringify(r.setup.definition));"""
    board=json.loads(subprocess.check_output(['node','--input-type=module','-e',setup_script],cwd=ROOT,text=True))
    order=['PURPLE','BLACK','GREEN','WHITE']; fixtures=[]
    with TestClient(app) as client:
        for index,topology in enumerate((False,True)):
            auth={}
            for player in ['BLACK','WHITE','PURPLE','GREEN']:
                result=client.post('/api/wechat/login',json={'code':f'{index}-{player}'}); assert result.status_code==200
                auth[player]={'Authorization':'Bearer '+result.json()['token']}
            def post(path,player,body): return client.post('/api/wechat/'+path,headers=auth[player],json=body)
            settings={'gridSize':5,'playerCount':4,'startPlayer':'PURPLE','turnOrder':order,
                      'rulesVersion':'territory-v3','boardShape':'hexagon'}
            if topology:
                settings.update(rulesVersion='surface-v1',boardShape='custom',boardDefinition=board,
                                topologyProtocolVersion='board-topology-v1',topologyCapabilities=['board-topology-v1'])
            response=post('rooms','BLACK',settings); assert response.status_code==200,response.text
            room=response.json(); code=room['code']; match=room['matchId']
            for player in ['WHITE','PURPLE','GREEN']:
                response=post('rooms/join',player,{'code':code,'topologyCapabilities':['board-topology-v1']}); assert response.status_code==200,response.text
            for player in ['BLACK','WHITE','PURPLE','GREEN']:
                response=post(f'rooms/{code}/ready',player,{'matchId':match}); assert response.status_code==200,response.text
            room=response.json()
            for i,player in enumerate(order[:3]):
                response=post(f'rooms/{code}/actions',player,{'matchId':match,'expectedSeq':room['seq'],'beforeHash':room['stateHash'],
                    'clientActionId':f'ordered-http-test-{index}-{i:03d}','action':{'type':'skip'}})
                assert response.status_code==200,response.text; room=response.json()
            room=client.get(f'/api/wechat/rooms/{code}',headers=auth['BLACK']).json()
            assert room['currentPlayer']=='WHITE' and room['settings']['turnOrder']==order
            fixtures.append(room)
    checked=subprocess.run(['node',str(ROOT/'web/web前端/tests/verify-shared-turn-order.mjs'),'--stdin'],
        input=json.dumps(fixtures),text=True,capture_output=True,cwd=ROOT,timeout=30)
    assert checked.returncode==0,checked.stderr
    assert 'verify-shared-turn-order: PASS' in checked.stdout
