// Same fixed messages and full outputs, original stateless runtime vs prefix cache.
// Local Node computation only; do not interpret these timings as wx device input latency.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { sut } from '../tests/helpers.mjs';
Error.stackTraceLimit = 0;
const [baselineDirectory, fixtureFile, outputFile] = process.argv.slice(2);
if (!baselineDirectory || !fixtureFile || !outputFile) throw Error('Usage: baseline-directory fixed-fixtures.json output.json');
const baseline = await import(pathToFileURL(path.resolve(baselineDirectory, 'worker-runtime.mjs')));
const fixtureBytes = await fs.readFile(fixtureFile), fixtures = JSON.parse(fixtureBytes);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const median = values => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const records = [];
let compared = 0;
for (const fixture of fixtures) {
  const settings = fixture.settings, actions = fixture.actions;
  const reference = await baseline.executeTask({ kind:'STATE', payload:{settings,actions} });
  const player=reference.snapshot.currentPlayer, home=reference.snapshot.initialPositions[player];
  const distance = p=>Math.max(Math.abs(p[0]-home[0]),Math.abs(p[1]-home[1]),Math.abs(p[0]+p[1]-home[0]-home[1]));
  const legal=[...reference.snapshot.legalMoves].sort((a,b)=>distance(a.point)-distance(b.point));
  const action=legal.length ? {type:'move',player,point:legal[0].point} : {type:'skip',player};
  const tasks = [
    { name:'initialState',kind:'STATE',payload:{settings,actions} },
    { name:'repeatState',kind:'STATE',payload:{settings,actions} },
    { name:'applyNextMove',kind:'APPLY',payload:{settings,actions,action} },
    { name:'stateAfterMove',kind:'STATE',payload:{settings,actions:[...actions,action]} },
  ];
  const expected = [];
  for(const task of tasks) expected.push(await baseline.executeTask(structuredClone(task)));
  const samples={before:[],after:[]};
  for(let sample=-1;sample<9;sample++) {
    for(const variant of sample%2 ? ['after','before'] : ['before','after']) {
      const execute=variant==='before' ? baseline.executeTask : sut.createTaskRuntime(), measured={};
      for(let index=0;index<tasks.length;index++) {
        const task=structuredClone(tasks[index]), start=performance.now();
        const result=await execute(task);measured[task.name]=performance.now()-start;
        assert.deepEqual(result,expected[index],`${fixture.id}/${variant}/${sample}/${task.name}`); compared++;
      }
      if(sample>=0)samples[variant].push(measured);
    }
  }
  const timings=Object.fromEntries(tasks.map(task=>[task.name,{beforeMs:median(samples.before.map(x=>x[task.name])),afterMs:median(samples.after.map(x=>x[task.name]))}]));
  records.push({fixture:fixture.id,timings,resultHashes:expected.map(x=>sha(JSON.stringify(x))),samples});
  console.log(JSON.stringify({stage:'fixture-complete',fixture:fixture.id,timings}));
}
const sourceHashes={};
for(const name of ['worker-runtime','scheduler','session','board'])sourceHashes[`wechat/minigame/src/${name}.js`]=sha(await fs.readFile(new URL(`../src/${name}.js`,import.meta.url)));
const report={status:'PASS_EXACT_WORKER_RUNTIME_PREFIX_CACHE_NODE_ONLY',recordedAtUtc:new Date().toISOString(),node:process.version,sourceHashes,
  engineSha256:sha(await fs.readFile(new URL('../../../web/web前端/GameEngine.js',import.meta.url))),
  baselineRuntimeSha256:sha(await fs.readFile(path.resolve(baselineDirectory,'worker-runtime.mjs'))),fixtureSha256:sha(fixtureBytes),
  exactComparisons:compared,records,bounds:['Same complete settings, history, snapshots, polygons and output hash checked.','Node timings exclude native Worker transport, Canvas and WeChat device execution.','Initial-state construction is still exact and deliberately uncached.']};
await fs.mkdir(path.dirname(path.resolve(outputFile)),{recursive:true});await fs.writeFile(outputFile,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({status:report.status,exactComparisons:compared,output:path.resolve(outputFile)}));
