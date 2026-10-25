// Read-only loopback harness. No gameplay, storage, authentication or wx calls.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseline = path.resolve(process.argv[2] || ''), port = Number(process.argv[3] || 8798);
if (!process.argv[2] || !Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Baseline directory and valid loopback port required');
const output = await build({ entryPoints:[path.join(root,'src/board.js')], bundle:true, write:false, format:'esm', platform:'browser' });
const bodies = new Map([
  ['/', ['text/html', await fs.readFile(path.join(root,'tests/render-perf-browser.html'))]],
  ['/render-perf-browser.mjs', ['text/javascript', await fs.readFile(path.join(root,'tests/render-perf-browser.mjs'))]],
  ['/before.mjs', ['text/javascript', await fs.readFile(path.join(baseline,'board.mjs'))]],
  ['/after.mjs', ['text/javascript', output.outputFiles[0].contents]],
  ['/fixtures.json', ['application/json', await fs.readFile(path.join(baseline,'../fixtures.json'))]],
]);
const server=http.createServer((request,response)=>{
  const hostname=(request.headers.host||'').split(':')[0];
  if (!['127.0.0.1','localhost'].includes(hostname) || !['GET','HEAD'].includes(request.method)) { response.writeHead(403);response.end();return; }
  const entry=bodies.get(new URL(request.url,`http://127.0.0.1:${port}`).pathname);
  if(!entry){response.writeHead(404);response.end();return;}
  response.writeHead(200,{'content-type':entry[0], 'cache-control':'no-store', 'x-content-type-options':'nosniff'});
  response.end(request.method==='HEAD'?undefined:entry[1]);
});
server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({status:'LOCAL_CANVAS_HARNESS_READY',url:`http://127.0.0.1:${port}/`})));
process.on('SIGINT',()=>server.close()); process.on('SIGTERM',()=>server.close());
