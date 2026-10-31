import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const script = fileURLToPath(new URL("../scripts/Test-LifelineCandidate.ps1", import.meta.url));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
// Synthetic fixtures exercise the reject-before-launch contract only. They
// are intentionally not valid executable files and never establish runtime QA.
test("standalone PowerShell accepts intact metadata and fails closed before launch on tampering", {skip:process.platform!=="win32"}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lifeline-standalone-contract-"));
  const bytes = Buffer.from("synthetic fixture, never run"), name="LIFELINE-0.0.0-x64-portable.exe";
  const manifest = {format:"lifeline-release-candidate",schemaVersion:1,status:"SNAPSHOT_COMPLETE",id:"fixture-only",package:{version:"0.0.0",appAsarSha256:digest("fake archive")},portable:{path:name,bytes:bytes.length,sha256:digest(bytes)}};
  const cases = [
    ["valid",true,value=>value,false],
    ["tampered",false,value=>value,true],
    ["traversal",false,value=>({...value,portable:{...value.portable,path:"../"+name}}),false],
    ["future",false,value=>({...value,schemaVersion:99}),false],
    ["incomplete",false,value=>({...value,status:"SNAPSHOT_INCOMPLETE"}),false],
    ["missing-package",false,value=>({...value,package:undefined}),false],
  ];
  try {
    for (const [id,pass,change,tamper] of cases) {
      const directory=path.join(root,id),output=path.join(root,"results-"+id);
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory,name),tamper?Buffer.alloc(bytes.length,65):bytes);
      fs.writeFileSync(path.join(directory,"candidate.json"),JSON.stringify(change(manifest)));
      const child=spawnSync(path.join(process.env.WINDIR,"System32/WindowsPowerShell/v1.0/powershell.exe"),["-NoProfile","-ExecutionPolicy","Bypass","-File",script,"-CandidateDirectory",directory,"-OutputRoot",output,"-IntegrityOnly"],{encoding:"utf8",timeout:30000,windowsHide:true});
      assert.equal(child.error,undefined,id);
      const receipt=JSON.parse(fs.readFileSync(path.join(output,fs.readdirSync(output)[0],"result.json"),"utf8").replace(/^\uFEFF/,""));
      assert.equal(child.status,pass?0:1,id+": "+JSON.stringify(receipt)+child.stderr);
      assert.equal(receipt.status,pass?"INTEGRITY_ONLY_PASS":"FAIL",id);
      assert.equal(receipt.environmentAttested,false,"Caller-supplied environment labels cannot attest Sandbox execution");
      assert.equal(receipt.checks.length,pass?1:0,id);
      assert.equal(fs.existsSync(path.join(output,fs.readdirSync(output)[0],"isolated-profile")),false,"Integrity-only must not launch/create profile");
    }
  } finally {
    const resolved=path.resolve(root),tempRoot=path.resolve(os.tmpdir())+path.sep;
    assert.ok(resolved.toLowerCase().startsWith(tempRoot.toLowerCase())&&path.basename(resolved).startsWith("lifeline-standalone-contract-"));
    fs.rmSync(resolved,{recursive:true,force:true});
  }
});
