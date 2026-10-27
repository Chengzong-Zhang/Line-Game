import * as before from '/before.mjs';
import * as after from '/after.mjs';
const fixtures = await (await fetch('/fixtures.json')).json();
const run = document.querySelector('#run'), report = document.querySelector('#report'), status = document.querySelector('#status');
const canvases = [document.querySelector('#before'), document.querySelector('#after')];
const display = { territories: true, legalMoves: true, lastMove: true, coordinates: false, highContrast: false };
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
const median = xs => [...xs].sort((a,b)=>a-b)[Math.floor(xs.length / 2)];
function draw(module, canvas, snapshot, layout, options, dpr) {
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#eee9dd'; ctx.fillRect(0, 0, 390, 844); module.drawBoard(ctx, snapshot, layout, options);
}
run.onclick = async () => {
  run.disabled = true; report.textContent = '';
  const result = { status: 'RUNNING', userAgent: navigator.userAgent, cases: [], timing: [], scope: 'Browser Canvas only; not wx.createWorker or WeChat device.' };
  try {
    for (const fixture of fixtures) {
      status.textContent = fixture.id; await frame();
      const snapshot = fixture.snapshot, rect = { x:30, y:300, width:330, height:410 };
      const full = after.boardLayout(snapshot.gridSize, rect, snapshot.players.length, snapshot.boardShape);
      const zoom = after.focusBoardLayout(snapshot.gridSize, rect, [3,4], 44, snapshot.players.length, snapshot.boardShape);
      for (const [view, layout] of [['full', full], ['zoom', zoom]]) for (const highContrast of [false, true]) for (const dpr of [1,2]) {
        const options = { display: { ...display, coordinates:true, highContrast }, selected:[3,4], hint:[4,4], target:[2,3], blocked:[1,2], lastMove:[2,3],
          effects: { addedEdgesByPlayer: snapshot.edges, capturedPoints:[[1,2]] } };
        canvases.forEach(canvas => { canvas.width=390*dpr; canvas.height=844*dpr; });
        draw(before, canvases[0], snapshot, layout, options, dpr); draw(after, canvases[1], snapshot, layout, options, dpr);
        const pixels = canvases.map(canvas => canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data);
        let different = 0; for (let i=0;i<pixels[0].length;i++) if (pixels[0][i]!==pixels[1][i]) different++;
        result.cases.push({ fixture:fixture.id, view, highContrast, dpr, differingChannels:different });
        if(different) throw Error(`${fixture.id}/${view}: ${different} differing RGBA channels`);
      }
      const samples = { before:[], after:[] };
      for(let sample=-2;sample<9;sample++) {
        for(const variant of sample%2 ? ['after','before'] : ['before','after']) {
          const module = variant==='before' ? before : after, canvas=canvases[variant==='before'?0:1];
          const start=performance.now(); for(let i=0;i<20;i++) draw(module,canvas,snapshot,full,{display},2);
          // Readback fences queued browser drawing. Reported timing includes it.
          canvas.getContext('2d').getImageData(0,0,1,1);
          if(sample>=0) samples[variant].push((performance.now()-start)/20);
        }
        await frame();
      }
      result.timing.push({ fixture:fixture.id, beforeMs:median(samples.before), afterMs:median(samples.after), samples });
    }
    result.status='PASS_BROWSER_CANVAS_NOT_WECHAT_DEVICE'; status.textContent='检查通过';
  } catch(error) { result.status='FAIL'; result.error=String(error); status.textContent='检查失败'; }
  finally { report.textContent=JSON.stringify(result,null,2); run.disabled=false; }
};
