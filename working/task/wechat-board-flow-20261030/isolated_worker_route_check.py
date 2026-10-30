import hashlib,http.server,json,os,pathlib,socket,subprocess,sys,threading,time,urllib.request,zipfile
base=pathlib.Path('/home/ubuntu/line-game/.deploy-artifacts/worker-route-isolated-20261030-d').resolve()
archive=base/'candidate.zip'
assert hashlib.sha256(archive.read_bytes()).hexdigest()=='5e5956ea37e3f73e08ae9aada7fcd9d53d126b14abed55566e6d61f7e533b821'
root=base/'candidate'; root.mkdir(mode=0o700)
with zipfile.ZipFile(archive) as z:
 for info in z.infolist():
  assert not info.filename.startswith('/') and '..' not in pathlib.PurePosixPath(info.filename).parts
 z.extractall(root)
manifest=root/'release-manifest.json'; candidate=json.loads(manifest.read_text()); candidate_hash=hashlib.sha256(manifest.read_bytes()).hexdigest()
config=base/'before.conf'; config.write_bytes(pathlib.Path('/etc/nginx/conf.d/lifeline.conf').read_bytes())
assert hashlib.sha256(config.read_bytes()).hexdigest()=='c24743e9efdf0f0f1437ab3a9d414d6c39d8f7fb88d1743816acd360f4d50406'
args=['python3',str(base/'configure_legacy_worker_routing.py'),'--config',str(config),'--frontend',str(root),'--plan',str(base/'legacy-root-routing-plan.json'),'--plan-sha256','ef174067a1b8c30cef1f698ab34dda62e6e56c5ddd05b79b953fa435ae2dc0b7','--candidate-manifest',str(manifest),'--candidate-sha256',candidate_hash,'--expected-before-sha256','c24743e9efdf0f0f1437ab3a9d414d6c39d8f7fb88d1743816acd360f4d50406','--output-config',str(base/'proposed.conf')]
plan_run=subprocess.run(args,check=True,capture_output=True,text=True); plan_result=json.loads(plan_run.stdout)
proposed=(base/'proposed.conf').read_text(); maps=proposed[:proposed.index('server {')]
class Handler(http.server.SimpleHTTPRequestHandler):
 def __init__(self,*a,**kw): super().__init__(*a,directory=str(root),**kw)
 def do_GET(self):
  if self.path.startswith('/api/') or self.path.startswith('/ws/'):
   b=self.path.encode(); self.send_response(200); self.end_headers(); self.wfile.write(b); return
  super().do_GET()
 def end_headers(self):
  self.send_header('X-Test-Upstream-Uri',self.path); super().end_headers()
 def log_message(self,*a): pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler); threading.Thread(target=server.serve_forever,daemon=True).start()
with socket.socket() as s: s.bind(('127.0.0.1',0)); port=s.getsockname()[1]
conf=('pid '+str(base/'nginx.pid')+';\nerror_log '+str(base/'error.log')+';\nevents { worker_connections 512; }\nhttp {\n access_log off;\n'+maps+'server {\n listen 127.0.0.1:'+str(port)+';\n location ^~ /api/ { proxy_pass http://127.0.0.1:'+str(server.server_port)+'; }\n location /ws/ { proxy_pass http://127.0.0.1:'+str(server.server_port)+'; }\n location / {\n if ($lifeline_legacy_worker_target != "") { rewrite ^ $lifeline_legacy_worker_target last; }\n proxy_pass http://127.0.0.1:'+str(server.server_port)+';\n }\n}\n}\n')
nginx_conf=base/'isolated-nginx.conf'; nginx_conf.write_text(conf); subprocess.run(['nginx','-t','-p',str(base)+'/', '-c',str(nginx_conf)],check=True,capture_output=True)
process=subprocess.Popen(['nginx','-p',str(base)+'/', '-c',str(nginx_conf),'-g','daemon off;'],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
try:
 for i in range(50):
  try:
   with urllib.request.urlopen('http://127.0.0.1:'+str(port)+'/index.html',timeout=2): break
  except OSError: time.sleep(.1)
 else: raise RuntimeError('isolated nginx did not start')
 route=json.loads((base/'legacy-root-routing-plan.json').read_text()); total=0
 def get(path):
  with urllib.request.urlopen('http://127.0.0.1:'+str(port)+path,timeout=15) as r: return r.read(),r.headers['X-Test-Upstream-Uri']
 for name,old in route['root_module_sha256'].items():
  for token in route['match_query_v']:
   path='/'+name+'?v='+token+'&keep=1'; body,uri=get(path)
   assert hashlib.sha256(body).hexdigest()==old,(path,uri)
   assert uri=='/'+route['rewrite_prefix'].strip('/')+'/'+name+'?v='+token+'&keep=1',(path,uri); total+=1
  for token in (candidate['asset_version'],'unknown-test-v1'):
   path='/'+name+'?v='+token; body,uri=get(path)
   assert hashlib.sha256(body).hexdigest()==candidate['files'][name] and uri==path,(path,uri); total+=1
 for name,old in route['asset_sha256'].items():
  for prefix in ('/','/'+route['rewrite_prefix'].strip('/')+'/'):
   body,uri=get(prefix+name); assert hashlib.sha256(body).hexdigest()==old,(name,uri); total+=1
 for path in ('/api/wechat/test?v=20261029-unified-r1','/api/training/test?v=20261030-topology-fix-r2','/ws/test?v=20261029-unified-r1'):
  body,uri=get(path); assert body.decode()==path and uri==path; total+=1
 result={'status':'ISOLATED_HTTP_PASS','requests':total,'modules':len(route['root_module_sha256']),'old_tokens':route['match_query_v'],'assets':len(route['asset_sha256']),'candidate_manifest_sha256':candidate_hash,'plan':plan_result,'nginx_port':port,'production_nginx_changed':False}
 (base/'isolated-receipt.json').write_text(json.dumps(result,indent=2)); print(json.dumps(result))
finally:
 process.terminate()
 try: process.wait(timeout=5)
 except subprocess.TimeoutExpired: process.kill(); process.wait()
 server.shutdown()
