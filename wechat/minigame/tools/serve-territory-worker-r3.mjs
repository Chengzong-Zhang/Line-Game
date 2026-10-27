import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {build,version as esbuildVersion} from 'esbuild';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),repo=path.resolve(root,'../..');
const [baselineArg,fixturesArg,expectedEngineHash,outputArg,portArg='8800']=process.argv.slice(2);
assert.ok(baselineArg&&fixturesArg&&outputArg,'Pass <baseline-dir> <fixtures.json> <expected-engine-sha256> <new-output-dir> [port]');
assert.match(expectedEngineHash||'',/^[a-f0-9]{64}$/);
const baseline=path.resolve(baselineArg),fixtures=path.resolve(fixturesArg),output=path.resolve(outputArg),port=Number(portArg);
assert.ok(Number.isInteger(port)&&port>=1024&&port<=65535);
const hash=data=>createHash('sha256').update(data).digest('hex');
const enginePath=path.join(repo,'web/web前端/GameEngine.js');
assert.equal(hash(await fs.readFile(enginePath)),expectedEngineHash,'Copy/verify the final core before starting this harness');
const oldReceiptBytes=await fs.readFile(path.join(baseline,'source-hashes.json')),oldReceipt=JSON.parse(oldReceiptBytes);
for(const file of oldReceipt.files)assert.equal(hash(await fs.readFile(path.join(baseline,file.snapshot))),file.sha256,file.snapshot);
const fixtureBytes=await fs.readFile(fixtures),fixtureData=JSON.parse(fixtureBytes);assert.equal(fixtureData.length,4);
const result=await build({entryPoints:[path.join(root,'src/workers/index.js')],absWorkingDir:repo,bundle:true,write:false,metafile:true,
  format:'iife',platform:'browser',target:'es2018',define:{'import.meta.url':'undefined'},
  plugins:[{name:'query',setup(b){b.onResolve({filter:/\?v=/},a=>({path:path.resolve(a.resolveDir,a.path.split('?')[0])}));}}]});
const sourceHashes={};
for(const file of Object.keys(result.metafile.inputs))if(!file.startsWith('<'))sourceHashes[file]=hash(await fs.readFile(path.resolve(repo,file)));
const beforeWorker=await fs.readFile(path.join(baseline,'worker.js')),afterWorker=result.outputFiles[0].contents;
// Retain the exact served bytes locally, independently of mutable dist.
const frozenBundleDirectory=path.join(repo,'local_artifacts/territory-performance-20261022-r3/browser-worker-'+expectedEngineHash.slice(0,12));
await fs.mkdir(frozenBundleDirectory,{recursive:true});
const frozenAssets={};
for(const [name,bytes]of [['before-worker.js',beforeWorker],['after-worker.js',afterWorker],['fixtures.json',fixtureBytes]]){
  const frozenFile=path.join(frozenBundleDirectory,name);
  await fs.writeFile(frozenFile,bytes,{flag:'wx'});
  frozenAssets[name]={path:frozenFile,sha256:hash(bytes),bytes:Buffer.byteLength(bytes)};
}
for(const [file,expected]of Object.entries(sourceHashes))assert.equal(hash(await fs.readFile(path.resolve(repo,file))),expected,'Source changed during bundling: '+file);
const html=await fs.readFile(path.join(root,'tests/territory-r3-worker-browser.html'));
const script=await fs.readFile(path.join(root,'tests/territory-r3-worker-browser.mjs'));
const bridge=variant=>`self.worker={onMessage:fn=>self.onmessage=event=>fn(event.data),postMessage:value=>self.postMessage(value)};importScripts('/${variant}-worker.js');`;
const data=new Map([['/',['text/html',html]],['/territory-r3-worker-browser.mjs',['text/javascript',script]],
  ['/before-worker.js',['text/javascript',beforeWorker]],['/after-worker.js',['text/javascript',afterWorker]],
  ['/bridge-before.js',['text/javascript',bridge('before')]],['/bridge-after.js',['text/javascript',bridge('after')]],
  ['/fixtures.json',['application/json',fixtureBytes]]]);
const binding={status:'READY_NOT_YET_BROWSER_EXECUTED',createdAtUtc:new Date().toISOString(),node:process.version,pid:process.pid,esbuild:esbuildVersion,
  command:process.argv.slice(1).join(' '),sourceHashes,engineSha256:expectedEngineHash,frozenAssets,
  baseline:{directory:baseline,receiptSha256:hash(oldReceiptBytes),files:oldReceipt.files},
  fixtures:{path:fixtures,sha256:hash(fixtureBytes)},
  assets:Object.fromEntries([...data].map(([route,[mime,bytes]])=>[route,{mime,sha256:hash(bytes),bytes:Buffer.byteLength(bytes)}])),
  serverSha256:hash(await fs.readFile(fileURLToPath(import.meta.url))),
  bounds:['Single browser Worker at a time; four cases, three rounds per variant, four responses per round.',
    'Current Worker bundled only in memory; dist is not written.',
    'Browser diagnostic only, not wx native, phone, Canvas or release acceptance.']};
await fs.mkdir(output,{recursive:true});
await fs.writeFile(path.join(output,'server-receipt.json'),JSON.stringify(binding,null,2)+'\n',{flag:'wx'});
let reports=0;
const server=http.createServer(async(request,response)=>{
  const json=(status,value)=>{response.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});response.end(JSON.stringify(value));};
  if(!['127.0.0.1','localhost'].includes((request.headers.host||'').split(':')[0])){json(403,{error:'LOCAL_ONLY'});return;}
  const pathname=new URL(request.url,`http://127.0.0.1:${port}`).pathname;
  if(pathname==='/report'&&request.method==='POST'){
    try{
      const chunks=[];let length=0;
      for await(const chunk of request){length+=chunk.length;if(length>256*1024)throw Error('REPORT_TOO_LARGE');chunks.push(chunk);}
      const report=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.ok(['PASS_BROWSER_WORKER_EXACT_OUTPUTS_NOT_WECHAT_DEVICE','FAIL'].includes(report.status));
      if(report.status.startsWith('PASS')){
        assert.equal(report.cases.length,4);
        for(const item of report.cases){assert.equal(item.resultHashes.length,4);assert.equal(item.samples.before.length,3);assert.equal(item.samples.after.length,3);}
      }
      const id=String(++reports).padStart(3,'0'),reportName=`browser-report-${id}.json`,receiptName=`browser-receipt-${id}.json`;
      const reportBytes=JSON.stringify(report,null,2)+'\n';
      await fs.writeFile(path.join(output,reportName),reportBytes,{flag:'wx'});
      await fs.writeFile(path.join(output,receiptName),JSON.stringify({status:report.status,recordedAtUtc:new Date().toISOString(),
        report:reportName,reportSha256:hash(reportBytes),serverReceipt:'server-receipt.json',
        serverReceiptSha256:hash(JSON.stringify(binding,null,2)+'\n'),completeResponseDigestChecks:report.status.startsWith('PASS')?96:null,
        userAgent:report.userAgent,timingClassification:'Three samples per variant, browser Worker round-trip diagnosis only; no wx-device claim.'},null,2)+'\n',{flag:'wx'});
      json(200,{report:path.join(output,reportName),receipt:path.join(output,receiptName)});
    }catch(error){json(400,{error:String(error)});}return;
  }
  if(!['GET','HEAD'].includes(request.method)){json(405,{error:'METHOD'});return;}
  const item=data.get(pathname);if(!item){json(404,{error:'NOT_FOUND'});return;}
  response.writeHead(200,{'content-type':item[0],'cache-control':'no-store','x-content-type-options':'nosniff'});
  response.end(request.method==='HEAD'?undefined:item[1]);
});
server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({status:'R3_LOCAL_WORKER_HARNESS_READY',pid:process.pid,url:`http://127.0.0.1:${port}/`,output,
  beforeWorkerSha256:hash(beforeWorker),afterWorkerSha256:hash(afterWorker)})));
process.on('SIGINT',()=>server.close());process.on('SIGTERM',()=>server.close());
