// Isolated source bundle + actual headless Edge Canvas / browser Worker.
// No production dist writes, platform login, network service or device claims.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), repo = path.resolve(root, '../..');
const output = await fs.mkdtemp(path.join(repo, 'local_artifacts/wechat-ui-0110-browser-'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex'), inputs = {};
const bundle = async (entry, globalName) => {
  const result = await build({ absWorkingDir: root, entryPoints: [entry], bundle: true, write: false, metafile: true,
    format: 'iife', globalName, platform: 'browser', target: 'es2018', loader: { '.md': 'text' },
    define: { 'import.meta.url': 'undefined' }, plugins: [{ name: 'cache-query', setup(b) {
      b.onResolve({ filter: /\?v=/ }, a => ({ path: path.resolve(a.resolveDir, a.path.split('?')[0]) }));
    } }] });
  for (const file of Object.keys(result.metafile.inputs)) inputs[path.relative(repo, path.resolve(root, file)).replaceAll('\\', '/')] = sha(await fs.readFile(path.resolve(root, file)));
  return result.outputFiles[0].text;
};
const main = await bundle('src/app.js', 'Lifeline'), worker = await bundle('src/workers/index.js');
const host = `
const q=new URLSearchParams(location.search), width=+q.get('w'),height=+q.get('h'),safeTop=+q.get('top');
const canvas=document.querySelector('canvas');canvas.style.width=width+'px';canvas.style.height=height+'px';
localStorage.setItem('lifeline-wx-language',q.get('lang'));const callbacks={};window.fixture={input:'',messages:[],saves:[]};
const platform={canvas,metrics:()=>({width,height,top:safeTop,bottom:24,dpr:devicePixelRatio}),
storage:{get:k=>localStorage.getItem(k),set:(k,v)=>localStorage.setItem(k,v)},frame:fn=>requestAnimationFrame(fn),
createWorker:()=>{const w=new Worker('/worker.js');return{postMessage:m=>w.postMessage(m),onMessage:fn=>w.onmessage=e=>fn(e.data),onError:fn=>w.onerror=fn,terminate:()=>w.terminate()};},
touchStart:f=>callbacks.start=f,touchMove:f=>callbacks.move=f,touchEnd:f=>callbacks.end=f,touchCancel:f=>callbacks.cancel=f,
onHide(){},onShow(){},onResize(){},setupShare(){},launchOptions:()=>({}),confirm:async()=>true,
message:async s=>fixture.messages.push(s),input:async()=>fixture.input,choose:async()=>0,pickAvatar:async()=>null,
createImage:()=>new Image(),loadImage:url=>new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=reject;i.src=url;})};
let pressed=false;const p=e=>({clientX:e.offsetX,clientY:e.offsetY});
canvas.onpointerdown=e=>{pressed=true;canvas.setPointerCapture(e.pointerId);callbacks.start?.({touches:[p(e)]});};
canvas.onpointermove=e=>{if(pressed)callbacks.move?.({touches:[p(e)]});};
canvas.onpointerup=e=>{pressed=false;callbacks.end?.({touches:[],changedTouches:[p(e)]});};
canvas.onpointercancel=()=>{pressed=false;callbacks.cancel?.({});};
window.app=Lifeline.createApp(platform,{onlineEnabled:true,apiBase:'https://test.invalid'});
app.online.account={displayName:q.get('lang')==='en'?'LIFELINE player':'生命线玩家',avatarUrl:''};
app.online.saveProfile=async v=>{fixture.saves.push(v);app.online.account={...app.online.account,...v};};
`;
const server = createServer((req, res) => {
  const route = new URL(req.url, 'http://localhost').pathname;
  const files = { '/': ['text/html', '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;background:#f4ede1}canvas{display:block;touch-action:none}</style><canvas></canvas><script src="/app.js"></script><script src="/host.js"></script>'],
    '/app.js': ['text/javascript', main], '/host.js': ['text/javascript', host],
    '/worker.js': ['text/javascript', `self.worker={onMessage:fn=>self.onmessage=e=>fn(e.data),postMessage:data=>self.postMessage(data)};\n${worker}`] };
  const item = files[route]; if (!item) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': `${item[0]}; charset=utf-8` }); res.end(item[1]);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [], errors = [], requests = [];
try {
  for (const [lang,w,h,top] of [['zh',320,568,64],['en',390,844,88],['zh',430,932,88]]) {
    const context = await browser.newContext({ viewport:{width:w,height:h}, deviceScaleFactor:1 });
    const page = await context.newPage(); page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>{if(!route.request().url().startsWith(origin)){requests.push(route.request().url());return route.abort();}return route.continue();});
    await page.goto(`${origin}/?lang=${lang}&w=${w}&h=${h}&top=${top}`);
    await page.waitForFunction(()=>app.session.snapshot&&!app.session.busy);
    const settle = ()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    const click = async id => { await settle(); const b=await page.evaluate(id=>app.getButtons().find(x=>x.id===id),id);assert.ok(b&&!b.disabled,id);await page.mouse.click(b.x+b.width/2,b.y+b.height/2);await settle(); };
    const drag = async (from,to)=>{await page.mouse.move(w-34,from);await page.mouse.down();await page.mouse.move(w-34,to,{steps:8});await page.mouse.up();await settle();};
    const scroll = async id => {for(let i=0;i<24;i++){if(await page.evaluate(id=>app.getButtons().some(b=>b.id===id),id))return;await drag(h-92,top+158);}throw Error('Cannot scroll to '+id);};
    const capture = async name => {await settle(); await page.screenshot({path:path.join(output,`${lang}-${w}-${name}.png`)});};
    await capture('board'); await click('cabin-battle');
    assert.equal(await page.evaluate(()=>app.online.account.displayName),lang==='en'?'LIFELINE player':'生命线玩家');
    await capture('account');
    await scroll('profile-name'); await page.evaluate(()=>fixture.input='LIFELINE 011'); await click('profile-name');
    await page.waitForFunction(()=>app.online.account.displayName==='LIFELINE 011');
    await click('cabin-guide'); assert.equal(await page.evaluate(()=>app.getButtons().some(b=>b.id==='guide-contents')),false);
    await scroll('guide-credits'); await click('guide-credits'); await capture('credits'); await click('reader-next'); await capture('credits-group');
    await click('home'); await page.evaluate(async()=>{await app.session.newGame(5,'human');await app.session.act({type:'move',point:[1,0]});await app.session.replay(1);});await settle();
    await capture('replay'); for(const key of ['analyzeReplay','inspectReplay','branchReplay']) assert.ok(await page.evaluate(id=>app.getButtons().some(b=>b.id===id),'replay-'+key));
    await click('replay-inspectReplay'); await page.waitForFunction(()=>fixture.messages.length>0); await capture('inspection');
    await click('replay-analyzeReplay'); await page.waitForFunction(()=>!app.session.busy); await capture('analysis');await click('analysis-back');
    await click('replay-branchReplay');await capture('branch');await click('branch-back');await click('exit-replay');
    await click('cabin-board');await scroll('shape-hexagon');await click('shape-hexagon');await scroll('starts-custom');await click('starts-custom');await capture('custom-roots');
    await click('starts-cancel'); await click('cabin-close');
    results.push({lang,width:w,height:h,checks:['actual Canvas and Worker','inline nickname save fixture','guide has no extra hub','grouped credits','direct replay inspection/analysis/branch','hex custom-root picker'],screenshots:9});
    await page.evaluate(()=>app.dispose());await context.close();
  }
  assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
  const changed=[];for(const [name,hash] of Object.entries(inputs)) if(sha(await fs.readFile(path.join(repo,name)))!==hash)changed.push(name);
  const receipt={status:'PASS_SOURCE_BROWSER_UI_NOT_PHONE_OR_PRODUCTION',results,errors,externalRequests:requests,sourceHashes:inputs,changedSinceBundle:changed,
    scope:'Actual headless Edge renders and browser Worker; nickname service is an explicit local fixture. No deployed account, phone, WeChat native runtime or public release claim.'};
  await fs.writeFile(path.join(output,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({output,status:receipt.status,viewports:results.length,changedSinceBundle:changed}));
}catch(error){await fs.writeFile(path.join(output,'failure.json'),JSON.stringify({message:error.message,results,errors,externalRequests:requests,sourceHashes:inputs},null,2));throw error;}
finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
