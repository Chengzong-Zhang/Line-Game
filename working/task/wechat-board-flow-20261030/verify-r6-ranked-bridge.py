"""Run real r6-to-current ranked continuity against one isolated SQLite store.

Usage: python -X utf8 working/task/wechat-board-flow-20261030/verify-r6-ranked-bridge.py
Reads only the local, manifest-verified runtime snapshot and creates a temporary
fixture database. Never connects to a live server or reads production records.
"""
import argparse, asyncio, importlib.util, json, shutil, sys, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SNAPSHOT = ROOT / 'working/tmp/ranked-predecessor-r6-20261030-snapshot'
parser = argparse.ArgumentParser()
parser.add_argument('--candidate-root', type=Path, default=ROOT)
CANDIDATE_ROOT = parser.parse_args().candidate_root.resolve(strict=True)

def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    loaded = importlib.util.module_from_spec(spec); spec.loader.exec_module(loaded); return loaded

async def main():
    old = module('fixture_old_wechat', SNAPSHOT / 'service/web/web后端/wechat_online.py')
    new = module('fixture_new_wechat', CANDIDATE_ROOT / 'web/web后端/wechat_online.py')
    with tempfile.TemporaryDirectory(prefix='ranked-r6-continuity-') as temp:
        temp = Path(temp); fixture_root = temp / 'runtime'; fixture_root.mkdir()
        bundled_predecessor = CANDIDATE_ROOT / 'ranked-predecessor-r6'
        shutil.copytree(bundled_predecessor if bundled_predecessor.is_dir() else SNAPSHOT, fixture_root / 'ranked-predecessor-r6')
        new.ROOT = fixture_root
        assert new.ranked_predecessor_validator(new.RANKED_PREDECESSOR_R6_FINGERPRINT).is_file()
        database = temp / 'fixture.sqlite3'; store_old = old.WechatStore(database)
        before_service = old.WechatService(store_old, 'fixture', 'fixture', 'f' * 40)
        before_service.schedule_bot = before_service.schedule_timer
        uid = store_old.identity('old-fixture-user')
        old_room = await before_service.mutate(uid, 'create-ai', {'profile':'greedy'})
        original = store_old.room(old_room['code']); context = original['rankedContext']
        assert context['runtime'] == new.RANKED_PREDECESSOR_R6_FINGERPRINT and old_room['currentPlayer'] == 'BLACK'
        empty_root = temp / 'without-predecessor'; empty_root.mkdir(); new.ROOT = empty_root
        try: new.verify_rules(old_room['settings'], [], ai_profile='greedy', ai_runtime=context['runtime'])
        except new.HTTPException as error: assert error.detail == 'AI_VERSION_CHANGED' and error.status_code == 409
        else: raise AssertionError('Missing predecessor weakened the old fingerprint guard')
        new.ROOT = fixture_root
        store = new.WechatStore(database); service = new.WechatService(store, 'fixture', 'fixture', 'f' * 40)
        service.schedule_bot = service.schedule_timer
        calls = []; run = new.subprocess.run
        def capture(argv, **kwargs):
            calls.append(Path(argv[1])); return run(argv, **kwargs)
        new.subprocess.run = capture
        state = await service.mutate(uid, 'actions', {'matchId':old_room['matchId'],'expectedSeq':old_room['seq'],
            'beforeHash':old_room['stateHash'],'clientActionId':'old-fixture-skip-0000001','action':{'type':'skip'}},old_room['code'])
        assert state['seq'] >= 2 and state['actions'][0]['player'] == 'BLACK' and state['actions'][1]['player'] == 'WHITE'
        assert store.room(old_room['code'])['rankedContext'] == context
        old_validator = fixture_root / 'ranked-predecessor-r6/service/wechat/minigame/tools/validate-action.mjs'
        assert len(calls) >= 2 and all(path == old_validator for path in calls)
        if not state['gameOver']:
            state = await service.mutate(uid, 'actions', {'matchId':state['matchId'],'expectedSeq':state['seq'],
                'beforeHash':state['stateHash'],'clientActionId':'old-fixture-resign-000001','action':{'type':'resign'}},state['code'])
        assert state['status'] == 'finished' and state['ladderResult']['rated']
        assert all(path == old_validator for path in calls)
        calls.clear()
        second = store.identity('new-fixture-user'); order=['PURPLE','BLACK','GREEN','WHITE']
        request={'settings':{'gridSize':5,'playerCount':4,'boardShape':'triangle','startPlayer':'PURPLE',
            'turnOrder':order,'startingPointMode':'default','rulesVersion':'territory-v3'},
            'controllers':{'BLACK':'greedy','WHITE':'greedy','PURPLE':'human','GREEN':'greedy'}}
        new_room = await service.mutate(second, 'create-ai', request)
        current_context = store.room(new_room['code'])['rankedContext']
        assert new_room['settings']['turnOrder'] == order and current_context['turnOrder'] == order
        assert current_context['runtime'] != context['runtime'] and new_room['currentPlayer'] == 'PURPLE'
        assert calls and calls[0] == new.VALIDATOR
        try: new.verify_rules(new_room['settings'], [], {'type':'skip','player':'PURPLE'}, ai_runtime='0'*64)
        except new.HTTPException as error: assert error.detail == 'AI_VERSION_CHANGED' and error.status_code == 409
        else: raise AssertionError('Unknown fingerprint was accepted')
        validator=new.ranked_predecessor_validator(context['runtime']); validator.write_bytes(validator.read_bytes()+b'\n')
        try: new.ranked_predecessor_validator(context['runtime'])
        except new.HTTPException as error: assert error.detail == 'AI_VERSION_CHANGED'
        else: raise AssertionError('Altered predecessor was accepted')
        for svc in (before_service, service):
            tasks=list(svc.bot_tasks.values())+list(svc.timer_tasks.values())
            for task in tasks: task.cancel()
            await asyncio.gather(*tasks,return_exceptions=True)
    print(json.dumps({'status':'PASS_ISOLATED_R6_TO_CURRENT', 'checks':['missing-predecessor-guard','old-context-unchanged','old-human-and-ai-actions','old-rating-finish','new-order-new-fingerprint','unknown-fingerprint-rejected','tampered-predecessor-rejected']}))

asyncio.run(main())
