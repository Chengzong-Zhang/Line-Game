"""Independent optimizer replay and Web export checks. Never mutates training."""
from __future__ import annotations
import argparse, copy, json, random, subprocess, sys
from pathlib import Path
import torch
from neural_posttraining_core import ROOT, build_model, digest, file_hash, load_asset_state, load_dataset, make_batch, sha

def read(p): return json.loads(Path(p).read_text(encoding="utf-8"))
def sealed(p):
    obj=read(p); body={k:v for k,v in obj.items() if k!="integrity"}; assert obj["integrity"]==digest(body); return body
def log_probs(model,batch):
    features,adjacency,node_mask,legal,target,*_=batch
    logits,value=model(features,adjacency,node_mask,legal)
    return torch.log_softmax(torch.where(legal,logits,torch.full_like(logits,torch.finfo(logits.dtype).min)),dim=1),target,value
def same(a,b):
    if isinstance(a,torch.Tensor): assert torch.equal(a,b)
    elif isinstance(a,dict):
        assert a.keys()==b.keys()
        for key in a: same(a[key],b[key])
    elif isinstance(a,(list,tuple)):
        assert len(a)==len(b)
        for x,y in zip(a,b): same(x,y)
    else: assert a==b

def main():
    p=argparse.ArgumentParser();p.add_argument("--run-root",required=True,type=Path);p.add_argument("--data-root",required=True,type=Path);p.add_argument("--output",required=True,type=Path);args=p.parse_args()
    torch.set_num_threads(1);torch.set_num_interop_threads(1);torch.use_deterministic_algorithms(True)
    run=args.run_root.resolve();assert not args.output.resolve().is_relative_to(run)
    identity=sealed(run/"identity.json");c=identity["config"];tid=digest(identity)
    cp=sealed(run/"checkpoint.json");receipt=sealed(run/"training-receipt.json");manifest=sealed(run/"candidate-manifest.json");progress=sealed(run/"progress.json")
    assert all(o["identity"]==tid for o in [cp,receipt,manifest,progress]);assert progress["status"]=="COMPLETE" and cp["active"] is None
    assert receipt["candidate_manifest_sha256"]==file_hash(run/"candidate-manifest.json")
    for path,h in identity["bindings"].items(): assert file_hash(Path(path))==h,path
    data,samples,_,_=load_dataset(args.data_root);assert data["identity"]==identity["dataset_identity"]
    dv=read(args.data_root/"verification.json");assert dv["status"]=="PASS_TERMINAL_ROLLOUT_DATA_R3" and dv["manifest_sha256"]==file_hash(args.data_root/"manifest.json")
    training=[s for s in samples if s["split"]=="train"];validation=[s for s in samples if s["split"]=="validation"]
    warm_path=ROOT/c["warmstart_manifest"];assert file_hash(warm_path)==c["warmstart_manifest_sha256"]
    warm=read(warm_path)["models"];probes=[];stage_reports=[];checked_updates=0
    assert cp["units"]==receipt["updates"]==len(c["model_ids"])*c["stage_updates"][-1]
    assert cp["completed"]==c["model_ids"] and len(cp["stages"])==len(c["model_ids"])*3
    for wid in c["model_ids"]:
        spec=copy.deepcopy(next(m for m in warm if m["id"]==wid));spec["asset"]=str((warm_path.parent/spec["asset"]).resolve());assert file_hash(Path(spec["asset"]))==spec["asset_sha256"]
        seed=c["seed"]^int(sha(wid.encode())[:8],16);torch.manual_seed(seed);rng=random.Random(seed)
        model=build_model(spec);anchor=build_model(spec).eval()
        for name,parameter in model.named_parameters(): parameter.requires_grad_(name.startswith("point_policy."))
        for parameter in anchor.parameters(): parameter.requires_grad_(False)
        optimizer=torch.optim.Adam([p for p in model.parameters() if p.requires_grad],lr=c["learning_rates"][0])
        for step in range(1,c["stage_updates"][-1]+1):
            index=next(i for i,end in enumerate(c["stage_updates"]) if step<=end)
            for group in optimizer.param_groups: group["lr"]=c["learning_rates"][index]
            model.train();batch=make_batch([training[rng.randrange(len(training))] for _ in range(c["batch_size"])],"cpu")
            lp,target,_=log_probs(model,batch)
            with torch.no_grad(): ap,_,_=log_probs(anchor,batch)
            ce=torch.sum(target*lp,dim=1).neg().mean();kl=torch.sum(torch.exp(ap)*(ap-lp),dim=1).mean()
            objective=ce+c["parent_kl"]*kl;optimizer.zero_grad(set_to_none=True);objective.backward();torch.nn.utils.clip_grad_norm_([p for p in model.parameters() if p.requires_grad],c["gradient_clip"]);optimizer.step();checked_updates+=1
            if step not in c["stage_updates"]: continue
            item=next(x for x in cp["stages"] if x["warmstart_id"]==wid and x["step"]==step)
            for key in ("asset","spec","state"): assert file_hash(run/item[key])==item[key+"_sha256"]
            saved=torch.load(run/item["state"],map_location="cpu",weights_only=False);assert saved["identity"]==tid and saved["id"]==wid and saved["step"]==step
            same(model.state_dict(),saved["model"]);same(optimizer.state_dict(),saved["optimizer"]);same(rng.getstate(),saved["rng"]);same(torch.get_rng_state(),saved["torch_rng"])
            for name,tensor in saved["model"].items():
                if not name.startswith("point_policy."):assert torch.equal(tensor,anchor.state_dict()[name])
            candidate=read(run/item["spec"]);assert candidate["parent_model_id"]==spec["parent_model_id"] and candidate["posttraining"]["warmstart_model_id"]==wid
            actual_state=load_asset_state(candidate,run/item["asset"]);same(actual_state,saved["model"])
            model.eval();total_ce=0;value_checks=0
            with torch.no_grad():
                for start in range(0,len(validation),16):
                    batch=make_batch(validation[start:start+16],"cpu");lp,target,value=log_probs(model,batch);_,_,avalue=log_probs(anchor,batch);assert torch.equal(value,avalue);total_ce+=float(torch.sum(-target*lp));value_checks+=len(value)
                    # Raw independent PASS head output is unaffected by point_policy.
                    features,adjacency,node_mask,legal,*_=batch
                    with_pass=legal.clone();with_pass[:,-1]=True
                    logits,_=model(features,adjacency,node_mask,with_pass);base_logits,_=anchor(features,adjacency,node_mask,with_pass);assert torch.equal(logits[:,-1],base_logits[:,-1])
            assert abs(total_ce/len(validation)-candidate["posttraining"]["final_validation_ce"])<2e-6
            for size in c["sizes"]:
                sample=next(s for s in validation if s["size"]==size);episode=read(args.data_root/next(x["path"] for x in data["episodes"] if x["id"]==sample["episode_id"]))
                with torch.no_grad():lp,_,_=log_probs(model,make_batch([sample],"cpu"))
                ps=copy.deepcopy(candidate);ps["asset"]=Path(candidate["asset"]).name
                probes.append({"spec":ps,"asset_path":str(run/item["asset"]),"size":size,"start":episode["start"],"actions":episode["actions"][:sample["ply"]],"legal":sample["legal"],"model_free_state":sample["modelFreeState"].tolist(),"probabilities":[float(lp[0,i].exp()) for i in sample["legal"]]})
            stage_reports.append({"id":candidate["id"],"updates":step,"frozen_tensor_count":sum(not n.startswith("point_policy.") for n in actual_state),"value_checks":value_checks,"validation_ce":total_ce/len(validation),"optimizer_rng_replay":"exact"})
    assert [s["id"] for s in cp["stages"]]==[m["id"] for m in manifest["models"]]
    args.output.parent.mkdir(parents=True,exist_ok=True);probe_path=args.output.with_name("web-parity-probes.json");probe_path.write_text(json.dumps(probes),encoding="utf-8")
    parity=subprocess.run(["node",str(ROOT/"web/web前端/tests/fixtures/neural-posttraining-fixture.mjs"),"--parity",str(probe_path)],cwd=ROOT,capture_output=True,text=True,timeout=90);assert parity.returncode==0,parity.stdout+parity.stderr
    for path,h in identity["bindings"].items():assert file_hash(Path(path))==h
    report={"status":"PASS_TERMINAL_HEAD_R3_INDEPENDENT_REPLAY","identity":tid,"replayed_updates":checked_updates,"stages":stage_reports,"parity":json.loads(parity.stdout),"verifier_sha256":file_hash(Path(__file__)),"manifest_sha256":file_hash(run/"candidate-manifest.json"),"scope":"Independent all-update model/Adam/RNG replay, frozen tensors and value/PASS predictions, F32 exactness, validation CE and actual Web probabilities; no playing-strength claim."}
    args.output.write_text(json.dumps(report,indent=2)+"\n",encoding="utf-8");print(json.dumps(report))
if __name__=="__main__":main()
