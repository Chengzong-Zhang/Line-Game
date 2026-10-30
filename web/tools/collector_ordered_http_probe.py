"""Exercise ordered v4 replays through an isolated HTTP collector and synthetic DB."""
import argparse, copy, json, os
from pathlib import Path
import socket, sqlite3, subprocess, sys, time, urllib.error, urllib.request


def verify(service, fixtures, data, python, node):
    data = data.resolve()
    if data.exists(): raise ValueError('Synthetic data directory must be new')
    if 'line-game-data' in data.parts: raise ValueError('Production data path forbidden')
    data.mkdir(mode=0o700)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    env = {'PATH':os.environ.get('PATH', '/usr/bin:/bin'), 'PYTHONDONTWRITEBYTECODE':'1',
           'LIFELINE_CONTRIBUTIONS_DIR':str(data), 'LIFELINE_NODE':node}
    for key in ('SYSTEMROOT', 'WINDIR'):
        if key in os.environ: env[key] = os.environ[key]
    server = subprocess.Popen([python,'-B','-m','uvicorn','contribution_asgi:app','--host','127.0.0.1',
                               '--port',str(port),'--log-level','error'],
                              cwd=service / 'web/backend', env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    origin = f'http://127.0.0.1:{port}'
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def get_status():
        with opener.open(origin+'/api/training/contributions/status',timeout=3) as r: return json.load(r)
    def post(payload):
        raw=json.dumps(payload,separators=(',',':')).encode()
        request=urllib.request.Request(origin+'/api/training/contributions',data=raw,
                    headers={'Content-Type':'application/json'},method='POST')
        try:
            with opener.open(request,timeout=30) as response: return response.status,json.load(response)
        except urllib.error.HTTPError as error: return error.code,json.load(error)
    try:
        for _ in range(100):
            if server.poll() is not None: raise RuntimeError('isolated collector exited before readiness')
            try: status=get_status(); break
            except (OSError,urllib.error.URLError): time.sleep(.1)
        else: raise RuntimeError('isolated collector did not start')
        assert status['enabled'] and status['supported_versions']==[1,2,3,4]
        results=[]
        for name in ('ordered_grid','ordered_topology'):
            payload=json.loads((fixtures / (name+'.json')).read_text(encoding='utf8'))
            assert payload['replay']['config']['turnOrder']==['PURPLE','BLACK','GREEN','WHITE']
            status,first=post(payload); assert status==200 and first['status']=='awaiting_review', (name,status,first)
            status,again=post(payload); assert status==200 and again['status']=='duplicate', (name,status,again)
            altered=copy.deepcopy(payload); altered['replay']['config']['turnOrder']=['PURPLE','WHITE','GREEN','BLACK']
            status,_=post(altered); assert status==422, (name,'tamper',status)
            no_consent=copy.deepcopy(payload); no_consent['consent']=False
            status,_=post(no_consent); assert status==422, (name,'consent',status)
            results.append({'kind':name,'accepted':200,'duplicate':200,'tamper':422,'noConsent':422})
        with sqlite3.connect(data/'contributions.sqlite3') as db:
            rows=db.execute('SELECT COUNT(*) FROM inbox_v4').fetchone()[0]
        assert rows==2
        return {'status':'PASS_ORDERED_V4_ISOLATED_HTTP','fixtures':results,'syntheticV4Rows':rows,
                'productionDatabaseCopied':False,'productionRequests':0,'scope':'loopback HTTP; synthetic data only'}
    finally:
        server.terminate()
        try: server.wait(timeout=5)
        except subprocess.TimeoutExpired: server.kill(); server.wait()

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for n in ('service','fixtures','data'): p.add_argument('--'+n,type=Path,required=True)
    p.add_argument('--python',required=True); p.add_argument('--node',required=True)
    a=p.parse_args(); print(json.dumps(verify(a.service.resolve(),a.fixtures.resolve(),a.data,a.python,a.node)))
