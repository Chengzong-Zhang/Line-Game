const fixtures=await(await fetch('/fixtures.json')).json();
const button=document.querySelector('#run'),status=document.querySelector('#status'),output=document.querySelector('#report');
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)))),n=>n.toString(16).padStart(2,'0')).join('');
function channel(variant){
  const worker=new Worker(`/bridge-${variant}.js`);let sequence=0,active=null;
  worker.onmessage=({data})=>{if(!active||data.id!==active.id)return;const task=active;active=null;clearTimeout(task.timer);
    if(JSON.stringify(data.context)!==JSON.stringify(task.context))task.reject(Error('CONTEXT_CHANGED'));
    else data.ok?task.resolve(data.result):task.reject(Error(data.error));};
  worker.onerror=event=>{if(active){clearTimeout(active.timer);active.reject(Error(event.message));active=null;}};
  return {close:()=>worker.terminate(),send:payload=>new Promise((resolve,reject)=>{
    const id=++sequence,context={epoch:id,revision:payload.payload.actions?.length||0,rulesVersion:'territory-v2'};
    const timer=setTimeout(()=>{active=null;reject(Error('TIMEOUT'));worker.terminate();},20000);
    active={id,context,timer,resolve,reject};worker.postMessage({...payload,id,context});
  })};
}
button.onclick=async()=>{
  button.disabled=true;output.textContent='';
  const report={status:'RUNNING',userAgent:navigator.userAgent,cases:[],scope:'Round 3 core: browser Worker round trip; not WeChat Canvas or native wx.createWorker.'};
  try{
    for(const fixture of fixtures){
      const settings=fixture.settings,actions=fixture.actions,samples={before:[],after:[]};let expected=null,action=null;
      for(let sample=0;sample<3;sample++)for(const variant of sample%2?['after','before']:['before','after']){
        status.textContent=`${fixture.id} · ${variant} · ${sample+1}/3`;const worker=channel(variant),timings={},hashes=[];
        try{
          let started=performance.now();const initial=await worker.send({kind:'STATE',payload:{settings,actions}});timings.initialState=performance.now()-started;
          if(!action){const player=initial.snapshot.currentPlayer,home=initial.snapshot.initialPositions[player];
            const distance=p=>Math.max(Math.abs(p[0]-home[0]),Math.abs(p[1]-home[1]),Math.abs(p[0]+p[1]-home[0]-home[1]));
            const legal=[...initial.snapshot.legalMoves].sort((a,b)=>distance(a.point)-distance(b.point));
            action=legal.length?{type:'move',player,point:legal[0].point}:{type:'skip',player};}
          hashes.push(await digest(initial));
          for(const [name,task]of[['repeatState',{kind:'STATE',payload:{settings,actions}}],['applyNextMove',{kind:'APPLY',payload:{settings,actions,action}}],['stateAfterMove',{kind:'STATE',payload:{settings,actions:[...actions,action]}}]]){
            started=performance.now();const result=await worker.send(task);timings[name]=performance.now()-started;hashes.push(await digest(result));
          }
          if(!expected)expected=hashes;else if(JSON.stringify(hashes)!==JSON.stringify(expected))throw Error(`${fixture.id}/${variant}: full result mismatch`);
          samples[variant].push(timings);
        }finally{worker.close();}
      }
      report.cases.push({fixture:fixture.id,resultHashes:expected,samples,timings:Object.fromEntries(Object.keys(samples.before[0]).map(name=>[name,{beforeMs:median(samples.before.map(s=>s[name])),afterMs:median(samples.after.map(s=>s[name]))}]))});
      output.textContent=JSON.stringify(report,null,2);
    }
    report.status='PASS_BROWSER_WORKER_EXACT_OUTPUTS_NOT_WECHAT_DEVICE';status.textContent='检查通过';
  }catch(error){report.status='FAIL';report.error=String(error);status.textContent='检查失败';}
  finally{
    output.textContent=JSON.stringify(report,null,2);
    try {
      const response=await fetch('/report',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(report)});
      const saved=await response.json();if(!response.ok)throw Error(saved.error||'SAVE_FAILED');
      status.textContent+=`（报告已保存：${saved.report}）`;
    }catch(error){status.textContent+=`（报告保存失败：${error}）`;}
    button.disabled=false;
  }
};
