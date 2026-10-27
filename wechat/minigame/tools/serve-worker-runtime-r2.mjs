// Isolated loopback-only browser Worker harness; never changes default dist.
import http from 'node:http';import fs from 'node:fs/promises';import path from 'node:path';
import {fileURLToPath}from'node:url';import{build}from'esbuild';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const baseline=path.resolve(process.argv[2]||''),fixtures=path.resolve(process.argv[3]||''),port=Number(process.argv[4]||8799);
if(!process.argv[2]||!process.argv[3]||!Number.isInteger(port)||port<1024||port>65535)throw Error('baseline fixtures port required');
const result=await build({entryPoints:[path.join(root,'src/workers/index.js')],bundle:true,write:false,format:'iife',platform:'browser',target:'es2018',define:{'import.meta.url':'undefined'},
  plugins:[{name:'query',setup(b){b.onResolve({filter:/\?v=/},a=>({path:path.resolve(a.resolveDir,a.path.split('?')[0])}));}}]});
const bridge=variant=>`self.worker={onMessage:fn=>self.onmessage=event=>fn(event.data),postMessage:value=>self.postMessage(value)};importScripts('/${variant}-worker.js');`;
const data=new Map([
  ['/', ['text/html',await fs.readFile(path.join(root,'tests/worker-runtime-r2-browser.html'))]],
  ['/worker-runtime-r2-browser.mjs',['text/javascript',await fs.readFile(path.join(root,'tests/worker-runtime-r2-browser.mjs'))]],
  ['/before-worker.js',['text/javascript',await fs.readFile(path.join(baseline,'worker.js'))]],
  ['/after-worker.js',['text/javascript',result.outputFiles[0].contents]],
  ['/bridge-before.js',['text/javascript',bridge('before')]],['/bridge-after.js',['text/javascript',bridge('after')]],
  ['/fixtures.json',['application/json',await fs.readFile(fixtures)]],
]);
const server=http.createServer((request,response)=>{
  if(!['127.0.0.1','localhost'].includes((request.headers.host||'').split(':')[0])||!['GET','HEAD'].includes(request.method)){response.writeHead(403);response.end();return;}
  const item=data.get(new URL(request.url,`http://127.0.0.1:${port}`).pathname);if(!item){response.writeHead(404);response.end();return;}
  response.writeHead(200,{'content-type':item[0],'cache-control':'no-store','x-content-type-options':'nosniff'});response.end(request.method==='HEAD'?undefined:item[1]);
});
server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({status:'LOCAL_WORKER_HARNESS_READY',url:`http://127.0.0.1:${port}/`})));
process.on('SIGINT',()=>server.close());process.on('SIGTERM',()=>server.close());
