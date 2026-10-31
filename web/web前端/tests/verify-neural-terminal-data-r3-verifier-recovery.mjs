import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,readdir,stat} from 'node:fs/promises';
import {spawn,spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {root,sha} from '../../tools/neural-posttraining-data.mjs';
const i=process.argv.indexOf('--data-root');assert.ok(i>0);const data=resolve(process.argv[i+1]);
const base=resolve(root,`local_artifacts/terminal-data-r3-verifier-recovery-${Date.now()}`);await mkdir(base,{recursive:true});
const script=resolve(root,'web/tools/verify-neural-terminal-data-r3.mjs');
const argv=(name,extra=[])=>[script,'--run-root',data,'--verify-root',resolve(base,name),'--output',resolve(base,`${name}.json`),...extra];
const run=(name,code,extra=[])=>{const r=spawnSync(process.execPath,argv(name,extra),{encoding:'utf8',windowsHide:true,timeout:30000});assert.equal(r.status,code,r.stderr);};
run('clean',0);
const child=spawn(process.execPath,argv('kill',['--test-hold-ms','1000']),{stdio:'ignore',windowsHide:true}),done=new Promise(r=>child.once('exit',r));let ready=false;
try{for(let j=0;j<500;j++){try{const p=JSON.parse(await readFile(resolve(base,'kill/progress.json')));if(p.progress_units===1){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,10));}assert.ok(ready);run('kill',76);child.kill('SIGKILL');await done;}finally{child.kill('SIGKILL');}
const name=(await readdir(resolve(base,'kill/proofs')))[0],proof=resolve(base,'kill/proofs',name),bytes=await readFile(proof),mtime=(await stat(proof)).mtimeMs;
run('kill',0);assert.deepEqual(await readFile(proof),bytes);assert.equal((await stat(proof)).mtimeMs,mtime);
const clean=JSON.parse(await readFile(resolve(base,'clean.json'))),resumed=JSON.parse(await readFile(resolve(base,'kill.json')));
for(const key of ['identity','positions','rollouts','rolloutActions','manifest_sha256'])assert.deepEqual(clean[key],resumed[key]);
await writeFile(proof,Buffer.concat([bytes.subarray(0,bytes.length-4),Buffer.from('bad')]));run('kill',78);
const receipt={status:'PASS_TERMINAL_DATA_VERIFIER_R3_RECOVERY',base,cases:['real-kill-after-durable-proof','resume-preserves-proof-bytes-mtime','duplicate-worker','all-label-counts-match-clean','corrupt-proof-rejected'],verifier_sha256:sha(await readFile(script))};await writeFile(resolve(base,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
