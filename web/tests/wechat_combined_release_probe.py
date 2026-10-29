"""Synthetic end-to-end checks for the proposed WeChat runtime; no live accounts."""
import argparse, asyncio, importlib.util, json, tempfile
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
        tasks=list(svc.bot_tasks.values())+list(svc.timer_tasks.values())
        for task in tasks: task.cancel()
        await asyncio.gather(*tasks,return_exceptions=True)
    print(json.dumps({'status':'PASS_SERVICE_RELEASE_COMPATIBILITY','checks':checks}))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--service-root',required=True,type=Path); asyncio.run(run(p.parse_args().service_root))
