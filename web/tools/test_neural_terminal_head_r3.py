"""Small real-process transaction/recovery fixture; no strength evaluation."""
from __future__ import annotations
import argparse,json,subprocess,sys,time,socket
from pathlib import Path
import torch
from neural_posttraining_core import ROOT,file_hash,sha
from verify_neural_terminal_head_r3 import same
p=argparse.ArgumentParser();p.add_argument("--data-root",required=True,type=Path);a=p.parse_args()
base=ROOT/"local_artifacts"/f"terminal-head-r3-recovery-{time.time_ns()}";base.mkdir(parents=True)
config=json.loads((ROOT/"web/tools/configs/neural-terminal-headonly-r3-20261021.json").read_text(encoding="utf-8"))
config.update(stage_updates=[1,2,3],batch_size=2,sizes=[5],recoveryTest=True,test_delay_ms=150)
cfg=base/"config.json";cfg.write_text(json.dumps(config),encoding="utf-8")
script=ROOT/"web/tools/train_neural_terminal_head_r3.py";verifier=ROOT/"web/tools/verify_neural_terminal_head_r3.py"
def args(name,extra=()):return [sys.executable,"-B",str(script),"--run-root",str(base/name),"--data-root",str(a.data_root),"--config",str(cfg),"--max-seconds","60",*extra]
def run(name,code,extra=()):
 r=subprocess.run(args(name,extra),cwd=ROOT,capture_output=True,text=True,timeout=80);assert r.returncode==code,r.stdout+r.stderr
def read(p):return json.loads(p.read_text(encoding="utf-8"))
run("clean",0)
for name,fault,code in [("orphan","after-state",91),("boundary","after-checkpoint",92)]:run(name,code,("--fault",fault));run(name,0)
child=subprocess.Popen(args("killed"),cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
try:
 ready=False
 for _ in range(1000):
  try:
   cp=read(base/"killed/checkpoint.json")
   if cp["units"]>=1:ready=True;break
  except (OSError,ValueError):pass
  time.sleep(.01)
 assert ready and child.poll() is None;child.kill();child.communicate(timeout=10)
finally:
 if child.poll() is None:child.kill();child.communicate(timeout=10)
run("killed",0)
clean=read(base/"clean/checkpoint.json")
for name in ["orphan","boundary","killed"]:
 cp=read(base/name/"checkpoint.json");assert cp["units"]==clean["units"]==6
 for x,y in zip(cp["stages"],clean["stages"]):
  assert (base/name/x["asset"]).read_bytes()==(base/"clean"/y["asset"]).read_bytes()
  same(torch.load(base/name/x["state"],weights_only=False),torch.load(base/"clean"/y["state"],weights_only=False))
before=[(base/"killed"/s["asset"]).stat().st_mtime_ns for s in clean["stages"]];run("killed",0);assert before==[(base/"killed"/s["asset"]).stat().st_mtime_ns for s in clean["stages"]]
control=base/"controls";control.mkdir()
for marker,status in [("PAUSE","PAUSED"),("STOP","STOPPED")]:
 (control/marker).write_text("");run("controls",75);assert read(control/"progress.json")["status"]==status;(control/marker).unlink()
run("controls",75,("--max-new-units","0"))
guard=socket.socket()
if hasattr(socket,"SO_EXCLUSIVEADDRUSE"):guard.setsockopt(socket.SOL_SOCKET,socket.SO_EXCLUSIVEADDRUSE,1)
port=40000+int(sha(("terminal-head:"+str(control.resolve()).lower()).encode())[:8],16)%20000;guard.bind(("127.0.0.1",port));guard.listen(1)
try:run("controls",76)
finally:guard.close()
target=base/"clean"/clean["stages"][0]["asset"];original=target.read_bytes();target.write_bytes(original+b"x");run("clean",78);target.write_bytes(original)
cfg.write_text(json.dumps({**config,"parent_kl":.3}));run("killed",78);cfg.write_text(json.dumps(config))
report_path=base/"independent.json";r=subprocess.run([sys.executable,"-B",str(verifier),"--run-root",str(base/"clean"),"--data-root",str(a.data_root),"--output",str(report_path)],cwd=ROOT,capture_output=True,text=True,timeout=90);assert r.returncode==0,r.stdout+r.stderr
report={"status":"PASS_TERMINAL_HEAD_R3_RECOVERY","base":str(base),"cases":["actual-kill-resume","orphan-state-adoption","stage-checkpoint-before-export-recovery","all-stage-exact-model-Adam-RNG-equality","completed-stages-not-rewritten","pause-stop-yield","duplicate-worker","asset-corruption-and-config-drift-rejected","independent-full-update-and-Web-parity"],"sources":{str(x.relative_to(ROOT)):file_hash(x) for x in [script,verifier,Path(__file__)]},"independent":read(report_path)}
(base/"receipt.json").write_text(json.dumps(report,indent=2),encoding="utf-8");print(json.dumps(report))
