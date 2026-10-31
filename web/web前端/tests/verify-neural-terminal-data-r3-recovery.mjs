import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,stat,readdir} from 'node:fs/promises';
import {spawn,spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {root,sha} from '../../tools/neural-posttraining-data.mjs';
const base=resolve(root,`local_artifacts/terminal-r3-data-recovery-${Date.now()}`);await mkdir(base,{recursive:true});
const config=JSON.parse(await readFile(resolve(root,'web/tools/configs/neural-terminal-headonly-r3-20261021.json')));
Object.assign(config,{sizes:[5],trainPositionsPerSize:1,validationPositionsPerSize:1,recoveryTest:true,test_delay_ms:1000,seedNamespace:'terminal-r3-recovery-only'});
const configPath=resolve(base,'config.json');await writeFile(configPath,JSON.stringify(config));
const script=resolve(root,'web/tools/neural-terminal-rollout-data-r3.mjs'),verifier=resolve(root,'web/tools/verify-neural-terminal-data-r3.mjs');
const argv=(name,extra=[])=>[script,'--run-root',resolve(base,name),'--config',configPath,'--max-seconds','30',...extra];
const run=(name,code,extra=[])=>{const r=spawnSync(process.execPath,argv(name,extra),{encoding:'utf8',windowsHide:true,timeout:40000});assert.equal(r.status,code,r.stderr);};
const read=async p=>JSON.parse(await readFile(p));
run('clean',0);const clean=await read(resolve(base,'clean/manifest.json'));
run('committed',92,['--fault','after-position']);const committed=resolve(base,'committed/episodes/n5-train-0.json'),bytes=await readFile(committed),mtime=(await stat(committed)).mtimeMs;
run('committed',0);assert.deepEqual(await readFile(committed),bytes);assert.equal((await stat(committed)).mtimeMs,mtime);
const child=spawn(process.execPath,argv('kill'),{stdio:'ignore',windowsHide:true}),done=new Promise(r=>child.once('exit',r));
let ready=false;try{for(let i=0;i<1000;i++){try{const cp=await read(resolve(base,'kill/checkpoint.json'));if(cp.units>=1){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,10));}assert.ok(ready);run('kill',76);assert.equal(child.exitCode,null,'The supervised worker must still be running before interruption');child.kill('SIGKILL');await done;run('kill',0);}finally{child.kill('SIGKILL');}
for(const name of ['committed','kill']){const m=await read(resolve(base,name,'manifest.json'));assert.deepEqual(m,clean);for(const ref of m.episodes)assert.deepEqual(await readFile(resolve(base,name,ref.path)),await readFile(resolve(base,'clean',ref.path)));}
run('controls',75,['--max-new-units','0']);for(const marker of ['PAUSE','STOP']){await writeFile(resolve(base,'controls',marker),'');run('controls',75);assert.equal((await read(resolve(base,'controls/progress.json'))).status,marker==='PAUSE'?'PAUSED':'STOPPED');}
const interrupted=resolve(base,'kill/interrupted'),preserved=await readdir(interrupted).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
await writeFile(resolve(base,'kill/episodes/partial.99.tmp'),'{');run('kill',0);assert.equal((await readdir(interrupted)).length,preserved.length+1);
const verified=spawnSync(process.execPath,[verifier,'--run-root',resolve(base,'clean'),'--output',resolve(base,'verification.json')],{encoding:'utf8',windowsHide:true,timeout:40000});assert.equal(verified.status,0,verified.stderr);
const file=resolve(base,'clean',clean.episodes[0].path),original=await readFile(file);await writeFile(file,Buffer.concat([original,Buffer.from(' ')]));run('clean',78);await writeFile(file,original);
const report={status:'PASS_TERMINAL_DATA_R3_RECOVERY',cases:['actual-kill-rollout-resume','orphan-position-adoption','completed-bytes-mtime-preserved','pause-stop','partial-isolation','corrupt-position-rejected','full-independent-label-replay'],base,
 source_hashes:Object.fromEntries(await Promise.all([script,verifier].map(async p=>[p,sha(await readFile(p))])))};await writeFile(resolve(base,'receipt.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
