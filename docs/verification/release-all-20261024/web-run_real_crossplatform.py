from pathlib import Path
import subprocess,socket,time,json,urllib.request,os
ROOT=Path(__file__).resolve().parent;WT=ROOT.parents[1]
sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];sock.close()
database=ROOT/'real-crossplatform.sqlite3';assert not database.exists()
command=[str(WT/'.venv/Scripts/python.exe'),'-B',str(WT/'web/tests/wechat_release_fixture_server.py'),
 '--service-root',str(WT/'local_artifacts/wechat-service-all-20261024-r2/package/service'),
 '--port',str(port),'--database',str(database)]
env={**os.environ,'PYTHONIOENCODING':'utf-8'}
out=(ROOT/'real-crossplatform-server.stdout.txt').open('wb');err=(ROOT/'real-crossplatform-server.stderr.txt').open('wb')
server=subprocess.Popen(command,cwd=WT,env=env,stdout=out,stderr=err)
try:
 origin=f'http://127.0.0.1:{port}';ready=False
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
 for _ in range(100):
  if server.poll() is not None:break
  try:
   with opener.open(origin+'/api/wechat/status',timeout=1) as response:ready=response.status==200
   if ready:break
  except Exception:time.sleep(.1)
 assert ready,(ROOT/'real-crossplatform-server.stderr.txt').read_text(encoding='utf8')
 cmd=['node',str(ROOT/'real-crossplatform.mjs'),origin]
 start=time.monotonic();result=subprocess.run(cmd,cwd=WT,env=env,capture_output=True,timeout=75)
 (ROOT/'real-crossplatform.stdout.txt').write_bytes(result.stdout);(ROOT/'real-crossplatform.stderr.txt').write_bytes(result.stderr)
 (ROOT/'real-crossplatform-execution.json').write_text(json.dumps({'command':cmd,'exitCode':result.returncode,'elapsedSec':time.monotonic()-start,'fixtureCommand':command},indent=2),encoding='utf8')
 print(result.stdout.decode('utf8',errors='replace'));print(result.stderr.decode('utf8',errors='replace'));raise SystemExit(result.returncode)
finally:
 server.terminate()
 try:server.wait(timeout=10)
 except subprocess.TimeoutExpired:server.kill();server.wait(timeout=5)
 out.close();err.close()
