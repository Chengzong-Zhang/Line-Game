"""Synthetic end-to-end checks for the proposed WeChat runtime; no live accounts."""
import argparse, asyncio, copy, importlib.util, json, os, subprocess, tempfile
from pathlib import Path

async def run(root):
    spec=importlib.util.spec_from_file_location('combined_wx',root/'web/web后端/wechat_online.py')
    wx=importlib.util.module_from_spec(spec); spec.loader.exec_module(wx)
    checks=[]
    with tempfile.TemporaryDirectory(prefix='lifeline-combined-probe-') as d:
        store=wx.WechatStore(Path(d)/'fixture.sqlite3')
        svc=wx.WechatService(store,'fixture-app','fixture-secret','fixture-signing-key-more-than-32-bytes')
        host=store.identity('probe-host'); guest=store.identity('probe-guest'); third=store.identity('probe-diamond'); ranked=store.identity('probe-ranked')
        old=await svc.mutate(host,'create',{'gridSize':5,'rulesVersion':'territory-v3','protectionRule':'duel-first-unprotected-v1','requireNew':True})
        assert old['settings']['protectionRule']=='duel-first-unprotected-v1'; checks.append('new-duel-protection')
        try: await svc.mutate(host,'create',{'gridSize':5,'requireNew':True})
        except wx.HTTPException as e: assert e.detail=='ALREADY_IN_ROOM'
        else: raise AssertionError('existing room must not silently replace new')
        checks.append('existing-room-protected')
        await svc.mutate(host,'leave',{'matchId':old['matchId']},old['code'])
        fresh=await svc.mutate(host,'create',{'gridSize':5,'requireNew':True})
        assert fresh['code']!=old['code']; checks.append('leave-and-create')
        await svc.mutate(guest,'join',{'code':fresh['code']},fresh['code'])
        for uid in (host,guest): fresh=await svc.mutate(uid,'ready',{'matchId':fresh['matchId']},fresh['code'])
        fresh=await svc.mutate(host,'actions',{'matchId':fresh['matchId'],'expectedSeq':0,'beforeHash':fresh['stateHash'],
            'clientActionId':'combined-probe-move-000001','action':{'type':'move','point':[1,0]}},fresh['code'])
        assert fresh['seq']==1 and store.room(fresh['code'])['state']['stateHash']==fresh['stateHash']; checks.append('human-room-action-persistence')
        diamond=await svc.mutate(third,'create',{'gridSize':5,'playerCount':3,'boardShape':'diamond',
            'startingPointMode':'random','rulesVersion':'territory-v3','requireNew':True})
        assert diamond['settings']['boardShape']=='diamond' and len(diamond['settings']['initialPositions'])==3
        assert store.room(diamond['code'])['settings']==diamond['settings']; checks.append('diamond-random-start-reconnect')
        for board in ('human','ai'):
            data=store.leaderboard(host,board,0)
            assert data['version']=='ladder-v3-conservative' and data['board']==board and 'me' in data
        checks.append('both-ladders')
        match=await svc.mutate(ranked,'create-ai',{'settings':{'gridSize':5,'playerCount':2,'boardShape':'diamond',
            'startPlayer':'BLACK','startingPointMode':'default','rulesVersion':'territory-v3','protectionRule':'symmetric-v1'},
            'controllers':{'BLACK':'human','WHITE':'minimax-2'},'requireNew':True})
        assert match['rankedAI'] and match['settings']['boardShape']=='diamond'
        match=await svc.mutate(ranked,'actions',{'matchId':match['matchId'],'expectedSeq':0,'beforeHash':match['stateHash'],
            'clientActionId':'combined-probe-ranked-001','action':{'type':'skip'}},match['code'])
        assert match['seq']>=2 and match['actions'][1]['player']=='WHITE'; checks.append('ranked-diamond-ai-action')
        paths={r.path for r in wx.create_router(svc).routes}
        assert '/api/wechat/rooms/current' in paths and '/api/wechat/ladder/{kind}' in paths; checks.append('new-api-routes')
        # Actual Node validator, complete settings, persisted action and idempotency.
        verts=[{'id':f'v:{x},{y}','coordinate':[x,y]} for y in range(4) for x in range(5)]
        faces=[]
        for y in range(3):
            for x in range(4):
                faces.extend([{'id':f'u:{x},{y}','vertices':[f'v:{x},{y}',f'v:{x+1},{y}',f'v:{x},{y+1}']},
                              {'id':f'd:{x},{y}','vertices':[f'v:{x+1},{y}',f'v:{x+1},{y+1}',f'v:{x},{y+1}']}])
        definition={'schemaVersion':1,'coordinateSystem':'triangular-axial-v1','topology':{'family':'planar',
                    'movementStrategy':'simple-rays-v1','territoryStrategy':'surface-discrete-v1','specialVertexPolicy':'stop'},
                    'vertices':verts,'faces':faces,'seamPairs':[],
                    'startingVertices':{'BLACK':'v:0,0','WHITE':'v:4,3'},'scoring':{'strategy':'canonical-vertices-v1'}}
        first=store.identity('probe-surface-host'); second=store.identity('probe-surface-guest')
        config={'gridSize':7,'playerCount':2,'startPlayer':'BLACK','rulesVersion':'surface-v1','boardShape':'custom',
                'boardDefinition':definition,'topologyProtocolVersion':'board-topology-v1',
                'topologyCapabilities':['board-topology-v1']}
        board=await svc.mutate(first,'create',config)
        await svc.mutate(second,'join',{'code':board['code'],'topologyCapabilities':['board-topology-v1']},board['code'])
        for uid in (first,second): board=await svc.mutate(uid,'ready',{'matchId':board['matchId']},board['code'])
        cmd={'matchId':board['matchId'],'expectedSeq':0,'beforeHash':board['stateHash'],
             'clientActionId':'surface-probe-action-0001','action':{'type':'move','vertexId':'cv:1'}}
        board=await svc.mutate(first,'actions',cmd,board['code'])
        repeated=await svc.mutate(first,'actions',cmd,board['code'])
        assert board['seq']==1 and repeated['seq']==1 and store.room(board['code'])['actions'][0]['vertexId']=='cv:1'
        checks.append('topology-node-persistence-dedup')
        multi=copy.deepcopy(definition)
        multi['startingVertices']={'BLACK':['v:0,0','v:1,0'],'WHITE':['v:3,3','v:4,3']}
        multi_settings=svc.room_settings({'gridSize':7,'playerCount':2,'boardShape':'custom','rulesVersion':'surface-v1',
                         'topologyProtocolVersion':'board-topology-v1','boardDefinition':multi})
        multi_state=await asyncio.to_thread(wx.verify_rules,multi_settings,[])
        assert multi_state['stateHash'].startswith('sha256:')
        checks.append('topology-multiple-starts-node')
        script="""import {generateBoard} from './web/web前端/RandomBoard.js';
          const r=generateBoard({gridSize:5,playerCount:2},'service-v4-probe');
          if(!r.ok) throw new Error('RANDOM_V4_UNAVAILABLE');
          process.stdout.write(JSON.stringify({definition:r.definition,boardHash:r.boardHash}));"""
        generated=subprocess.run([os.getenv('LIFELINE_NODE','node'),'--input-type=module','-e',script],cwd=root,
                                 capture_output=True,check=True,timeout=45)
        v4=json.loads(generated.stdout)
        v4_settings=svc.room_settings({'gridSize':5,'playerCount':2,'boardShape':'custom','rulesVersion':'surface-v1',
                         'topologyProtocolVersion':'board-topology-v1','boardDefinition':v4['definition'],'boardHash':v4['boardHash']})
        assert v4_settings['boardHash']==v4['boardHash'] and v4_settings['boardDefinition']['generator']['generatorVersion']=='random-board-v4'
        assert (await asyncio.to_thread(wx.verify_rules,v4_settings,[]))['stateHash'].startswith('sha256:')
        checks.append('random-v4-cross-language-node')
        root_host=store.identity('probe-root-host'); root_guest=store.identity('probe-root-guest')
        root=await svc.mutate(root_host,'create',{'gridSize':7,'playerCount':2,'boardShape':'triangle',
                   'rulesVersion':'territory-v3','rootMode':'add','rootRulesVersion':'root-v2','rootProtocolVersion':2})
        await svc.mutate(root_guest,'join',{'code':root['code'],'rootProtocolVersion':2},root['code'])
        for uid in (root_host,root_guest): root=await svc.mutate(uid,'ready',{'matchId':root['matchId']},root['code'])
        for uid, action in [(root_host,{'type':'move','point':[1,0]}),
                            (root_guest,{'type':'skip'}),(root_host,{'type':'root_add','point':[1,0]})]:
            root=await svc.mutate(uid,'actions',{'matchId':root['matchId'],'expectedSeq':root['seq'],'beforeHash':root['stateHash'],
                'clientActionId':'root-probe-action-%08d' % root['seq'],'action':action},root['code'])
        assert root['seq']==3 and store.room(root['code'])['actions'][-1]['type']=='root_add'
        checks.append('root-v2-action-persistence')
        tasks=list(svc.bot_tasks.values())+list(svc.timer_tasks.values())
        for task in tasks: task.cancel()
        await asyncio.gather(*tasks,return_exceptions=True)
    print(json.dumps({'status':'PASS_SERVICE_RELEASE_COMPATIBILITY','checks':checks}))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--service-root',required=True,type=Path); asyncio.run(run(p.parse_args().service_root))
