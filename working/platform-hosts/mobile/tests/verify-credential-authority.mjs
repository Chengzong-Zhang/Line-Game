import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sourcePath = path.join(root, 'mobile/src/credential-authority.js');
const output = process.argv[2];
// Optional receipt is written exclusively; old evidence is never overwritten.
const source = await readFile(sourcePath, 'utf8');
const digest = value => createHash('sha256').update(value).digest('hex');
const credential = Object.freeze({ token: 'synthetic-parent-credential', username: 'parent_fixture' });
const key = 'triaxis-auth';
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
const drain = async () => { for (let i=0;i<60;i++) await Promise.resolve(); };
const copy = value => JSON.parse(JSON.stringify(value));

async function fixture({ legacy = null, record = {state:'missing'}, hooks = {}, failRemove = false, failWrite = false, noProvider = false, noStorage = false, initialValues = [] } = {}) {
  const values = new Map(legacy === null ? [] : [[key, legacy]]);
  for(const [name,value] of initialValues)values.set(name,value);
  const calls = [], statuses = [], timers = new Map(), logs = [];
  let timerId=0, owner=0, page=1;
  const durable = { record: copy(record) };
  const storage = {
    getItem(name) { if(hooks.getItem) return hooks.getItem(name, values); return values.get(name)??null; },
    setItem(name,value) { if(failWrite) throw Error('Synthetic local write failure'); values.set(name,String(value)); calls.push({op:'local-write',key:name,value:String(value)}); },
    removeItem(name) { calls.push({op:'local-remove',key:name}); if(failRemove) throw Error('Synthetic local delete failure'); values.delete(name); },
  };
  const valid = lease => { if(lease?.ownerGeneration!==owner || lease?.pageEpoch!==page) throw Error('Synthetic expired lease'); };
  const provider = {
    async claim(input) {
      calls.push({op:'claim'});
      await hooks.claim?.(input);
      if(input.expectedOwnerGeneration!==-1 && input.expectedOwnerGeneration!==owner) throw Error('Synthetic superseded owner');
      return {pageEpoch:page,ownerGeneration:++owner};
    },
    async load(lease) { valid(lease); calls.push({op:'load'}); const result=await hooks.load?.(lease,durable); valid(lease); return copy(result??durable.record); },
    async save(lease,value) { valid(lease); calls.push({op:'save'}); const result=await hooks.save?.(lease,value,durable); valid(lease); if(result?.skipWrite!==true) durable.record={state:'present',credential:copy(value)}; return result?.ack??{durable:true}; },
    async clear(lease) { valid(lease); calls.push({op:'clear'}); await hooks.clear?.(lease,durable); valid(lease); durable.record={state:'cleared'}; return {durable:true}; },
  };
  const context = vm.createContext({
    setTimeout(fn,delay) { const id=++timerId;timers.set(id,{fn,delay});return id; }, clearTimeout(id) { timers.delete(id); },
    console:{log:(...args)=>logs.push(args),warn:(...args)=>logs.push(args),error:(...args)=>logs.push(args)},
  });
  const module = new vm.SourceTextModule(source, {context,identifier:sourcePath});
  await module.link(()=>{throw Error('Unexpected dependency in source under test');});
  await module.evaluate();
  const authority = module.namespace.createCredentialAuthority({provider:noProvider?null:provider,storage:noStorage?undefined:storage,onStatus:s=>statuses.push(copy(s))});
  return {authority,values,calls,statuses,timers,context,durable,logs,
    replacePage(){page++;owner++;},
    timeout(){const entry=[...timers.entries()].find(([,t])=>t.delay>=15000);assert.ok(entry,'an actual operation timeout is pending');timers.delete(entry[0]);entry[1].fn();},
    get restored(){return context.__LIFELINE_AUTH_BOOTSTRAP__??null;},
  };
}

const checks=[];
async function check(name,run) {
  try { await run(); checks.push({name,pass:true}); }
  catch(error) { checks.push({name,pass:false,error:String(error?.message??error).replaceAll(credential.token,'[synthetic]').slice(0,800)}); }
}
const absent = fixture => assert.ok(!fixture.restored?.token, 'unconfirmed credentials must never be published');

await check('unavailable native provider cannot restore legacy auth',async()=>{
  const legacy=JSON.stringify(credential);const f=await fixture({legacy,noProvider:true});await f.authority.bootstrap();absent(f);assert.equal(f.values.get(key),legacy);assert.notEqual(f.authority.getState(),'ready');
});
await check('migration reads back before deleting original plaintext',async()=>{
  const f=await fixture({legacy:JSON.stringify(credential)});await f.authority.bootstrap();assert.deepEqual(copy(f.restored),credential);assert.equal(f.values.has(key),false);
  const save=f.calls.findIndex(c=>c.op==='save'),verify=f.calls.findIndex((c,i)=>i>save&&c.op==='load'),remove=f.calls.findIndex(c=>c.op==='local-remove'&&c.key===key);assert.ok(save>=0&&verify>save&&remove>verify);
});
await check('migration mismatch keeps exact legacy bytes and returns no auth',async()=>{
  let loads=0;const legacy='  '+JSON.stringify(credential)+'\n';
  const f=await fixture({legacy,hooks:{load:()=>++loads===1?{state:'missing'}:{state:'present',credential:{...credential,username:'different'}}}});
  await f.authority.bootstrap();absent(f);assert.equal(f.values.get(key),legacy);assert.notEqual(f.authority.getState(),'ready');
});
await check('failed legacy removal is not a successful protected migration',async()=>{
  const legacy=JSON.stringify(credential);const f=await fixture({legacy,failRemove:true});await f.authority.bootstrap();absent(f);assert.equal(f.values.get(key),legacy);assert.notEqual(f.authority.getState(),'ready');
});
await check('malformed legacy is explicit failure and is preserved',async()=>{
  const f=await fixture({legacy:'{invalid-parent-fixture'});await f.authority.bootstrap();absent(f);assert.notEqual(f.authority.getState(),'ready');assert.equal(f.values.get(key),'{invalid-parent-fixture');
});
await check('legacy read failure is not classified as missing',async()=>{
  const f=await fixture({hooks:{getItem(){throw Error('Synthetic legacy read failure');}}});await f.authority.bootstrap();absent(f);assert.notEqual(f.authority.getState(),'ready');
});
await check('native cleared tombstone blocks stale legacy import',async()=>{
  const f=await fixture({legacy:JSON.stringify(credential),record:{state:'cleared'}});await f.authority.bootstrap();absent(f);assert.equal(f.calls.some(c=>c.op==='save'),false);
});
await check('extra fields in restored record fail closed',async()=>{
  const f=await fixture({record:{state:'present',credential:{...credential,password:'synthetic-extra-field'}}});await f.authority.bootstrap();absent(f);assert.notEqual(f.authority.getState(),'ready');
});
await check('invalid new credential cannot reach native save',async()=>{
  const f=await fixture();await f.authority.bootstrap();for(const value of [{...credential,extra:'field'},{token:9,username:'x'},{token:'x',username:'x'.repeat(51)},{token:'x'.repeat(16385),username:'x'}])assert.equal(await f.authority.save(value),false);assert.equal(f.calls.some(c=>c.op==='save'),false);
});
await check('successful login persistence requires matching readback',async()=>{
  let loads=0;const f=await fixture({hooks:{load:()=>++loads===1?{state:'missing'}:{state:'missing'}}});await f.authority.bootstrap();assert.equal(await f.authority.save(credential),false);
});
await check('explicit non-durable acknowledgment cannot be successful',async()=>{
  const f=await fixture({hooks:{save:()=>({ack:{durable:false}})}});await f.authority.bootstrap();assert.equal(await f.authority.save(credential),false);
});
await check('clear blocks a delayed bootstrap from publishing restored auth',async()=>{
  const held=deferred();let first=true;
  const f=await fixture({record:{state:'present',credential},hooks:{load:async()=>{if(first){first=false;await held.promise;}return {state:'present',credential};}}});
  const boot=f.authority.bootstrap();await drain();const clear=f.authority.clear();await drain();absent(f);held.resolve();await Promise.all([boot,clear]);absent(f);assert.equal(f.durable.record.state,'cleared');
});
await check('logout records a nonsecret durable barrier before native clear resolves',async()=>{
  const held=deferred();const f=await fixture({record:{state:'present',credential},hooks:{clear:()=>held.promise}});await f.authority.bootstrap();const clearing=f.authority.clear();await drain();
  assert.ok([...f.values.entries()].some(([name,value])=>name!==key&&!value.includes(credential.token)), 'no local no-restore barrier was persisted');held.resolve();assert.equal(await clearing,true);
});
await check('timeout retains native tail; late save cannot beat logout',async()=>{
  const held=deferred();const f=await fixture({hooks:{save:()=>held.promise}});await f.authority.bootstrap();const saving=f.authority.save(credential);await drain();f.timeout();assert.equal(await saving,false);
  const clearing=f.authority.clear();await drain();absent(f);
  held.resolve();await clearing;await drain();absent(f);assert.equal(f.durable.record.state,'cleared');assert.equal(f.authority.getState(),'ready','late failure must not replace the completed clear state');
});
await check('local barrier write failure cannot claim fully durable clear',async()=>{
  const f=await fixture({record:{state:'present',credential},failWrite:true});await f.authority.bootstrap();let answer;try{answer=await f.authority.clear();}catch{}absent(f);assert.notEqual(answer,true);
});
await check('provider failure text never becomes public auth status',async()=>{
  const f=await fixture({hooks:{claim(){throw Error(credential.token);}}});await f.authority.bootstrap();assert.equal(JSON.stringify(f.statuses).includes(credential.token),false);assert.equal(JSON.stringify(f.logs).includes(credential.token),false);
});


await check('restart with pending logout never loads an old credential',async()=>{
  const f=await fixture({legacy:JSON.stringify(credential),record:{state:'present',credential},initialValues:[['lifeline-auth-clear-pending-v1','pending']]});await f.authority.bootstrap();absent(f);assert.equal(f.calls.some(c=>c.op==='load'),false);assert.equal(f.durable.record.state,'cleared');assert.equal(f.values.has(key),false);
});
await check('restart with failed native clear keeps suppression marker and no auth',async()=>{
  const f=await fixture({record:{state:'present',credential},initialValues:[['lifeline-auth-clear-pending-v1','pending']],hooks:{clear(){throw Error('Synthetic key/store failure');}}});await f.authority.bootstrap();absent(f);assert.equal(f.values.get('lifeline-auth-clear-pending-v1'),'pending');assert.equal(f.calls.some(c=>c.op==='load'),false);assert.notEqual(f.authority.getState(),'ready');
});
await check('missing local storage cannot claim persisted logout suppression',async()=>{
  const f=await fixture({record:{state:'present',credential},noStorage:true});await f.authority.bootstrap();assert.equal(await f.authority.clear(),false);absent(f);
});
await check('old failed bootstrap cannot replace a newer successful clear status',async()=>{
  const held=deferred();const f=await fixture({record:{state:'present',credential},hooks:{load:()=>held.promise}});const boot=f.authority.bootstrap();await drain();assert.equal(await f.authority.clear(),true);held.reject(Error('Synthetic old read failure'));await boot;assert.equal(f.authority.getState(),'ready');absent(f);
});
await check('migration readback rejects unexpected credential fields',async()=>{
  let loads=0;const legacy=JSON.stringify(credential);const f=await fixture({legacy,hooks:{load:()=>++loads===1?{state:'missing'}:{state:'present',credential:{...credential,unexpected:'field'}}}});await f.authority.bootstrap();absent(f);assert.equal(f.values.get(key),legacy);assert.notEqual(f.authority.getState(),'ready');
});
await check('new save readback rejects unexpected credential fields',async()=>{
  let loads=0;const f=await fixture({hooks:{load:()=>++loads===1?{state:'missing'}:{state:'present',credential:{...credential,unexpected:'field'}}}});await f.authority.bootstrap();assert.equal(await f.authority.save(credential),false);
});


await check('explicit retry recovers a failed save without plaintext fallback',async()=>{
  let saves=0;const f=await fixture({hooks:{save(){if(++saves===1)throw Error('Synthetic transient save failure');}}});await f.authority.bootstrap();assert.equal(await f.authority.save(credential),false);assert.equal((await f.authority.retry()).state,'ready');const attempt=f.authority.beginAttempt();assert.equal(f.authority.isAttemptCurrent(attempt),true);assert.equal(await f.authority.save(credential),true);assert.equal(f.values.has(key),false);
});
await check('explicit retry honors a pending logout barrier',async()=>{
  let failed=true;const f=await fixture({record:{state:'present',credential},hooks:{clear(){if(failed)throw Error('Synthetic transient clear failure');}}});await f.authority.bootstrap();assert.equal(await f.authority.clear(),false);failed=false;assert.equal((await f.authority.retry()).state,'ready');absent(f);assert.equal(f.durable.record.state,'cleared');
});

const after=await readFile(sourcePath,'utf8');
const result={scope:'Actual shared credential authority in Node VM with controlled API/storage failures; native cryptography/device not exercised',source:sourcePath,sha256:digest(source),sourceStable:source===after,checks,passed:checks.filter(c=>c.pass).length,total:checks.length};
if (output) await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({passed:result.passed,total:result.total,sourceStable:result.sourceStable,failures:checks.filter(c=>!c.pass)}));
if(!result.sourceStable||result.passed!==result.total)process.exitCode=1;
