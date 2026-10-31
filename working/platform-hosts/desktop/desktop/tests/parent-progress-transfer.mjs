import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { _electron } from "playwright-core";

const root=fileURLToPath(new URL("../../",import.meta.url));
const executable=path.join(root,"desktop/release/win-unpacked/LIFELINE.exe");
const archive=path.join(path.dirname(executable),"resources/app.asar");
const hash=file=>createHash("sha256").update(fs.readFileSync(file)).digest("hex");
fs.mkdirSync(path.join(root,"local_artifacts"),{recursive:true});
const evidence=fs.mkdtempSync(path.join(root,"local_artifacts/parent-progress-transfer-"));
const transfer=path.join(evidence,"real-progress.json");
const receipt={status:"RUNNING",packageSha256:hash(archive),evidence,checks:[],geometry:[],errors:[],requests:[],consoleErrors:[],
  boundary:"Actual packaged UI, IPC, filesystem and pointer gameplay; OS file chooser responses are injected to choose isolated fixtures. Native chooser interaction, second device and Steam services are not claimed."};
let app,page,profile,phase="startup";
const settle=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
const launch=async name=>{
  profile=path.join(evidence,name);
  const env={...process.env,LIFELINE_TEST_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
  app=await _electron.launch({executablePath:executable,env,timeout:60000});page=await app.firstWindow();
  page.on("pageerror",e=>receipt.errors.push(e.message));
  page.on("request",r=>{if(/^(https?|wss?):/i.test(r.url()))receipt.requests.push(r.url());});
  page.on("console",m=>{if(m.type()==="error"||/\[Vue warn\]/.test(m.text()))receipt.consoleErrors.push(m.text());});
  await page.reload({waitUntil:"domcontentloaded"});
  await page.waitForFunction(()=>document.querySelector("#app")?._vnode?.component?.proxy?.controller?.renderer?.layout);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1280,720));
};
const close=async()=>{if(app)await app.close();app=null;page=null;};
const prefs=async open=>{
  const menu=page.locator(".player-preferences");
  if((await menu.getAttribute("open")!==null)!==open)await menu.locator(":scope > summary").click();
  await settle();
};
const clickPoint=async point=>{
  const target=await page.evaluate(point=>{const v=document.querySelector("#app")._vnode.component.proxy,r=v.controller.renderer,p=r.getPointPixelCoordinates(point),b=r.canvas.getBoundingClientRect();return{x:b.left+p.x*b.width/r.layout.cssWidth,y:b.top+p.y*b.height/r.layout.cssHeight,revision:v.gameState.positionRevision};},point);
  await page.mouse.click(target.x,target.y);
  await page.waitForFunction(rev=>document.querySelector("#app")._vnode.component.proxy.gameState.positionRevision>rev,target.revision);
};
const completeTutorial=async()=>{
  for(const id of ["L1-connect","L2-close-territory","L3-cut-and-clear","L4-three-point-limit","L5-settle-score"]){
    const level=await page.evaluate(()=>document.querySelector("#app")._vnode.component.proxy.currentTutorialLevel);assert.equal(level.id,id);
    if(level.restriction){
      const target=await page.evaluate(point=>{const r=document.querySelector("#app")._vnode.component.proxy.controller.renderer,p=r.getPointPixelCoordinates(point),b=r.canvas.getBoundingClientRect();return{x:b.left+p.x*b.width/r.layout.cssWidth,y:b.top+p.y*b.height/r.layout.cssHeight};},level.restriction.point);
      await page.mouse.click(target.x,target.y);await page.waitForFunction(()=>document.querySelector("#app")._vnode.component.proxy.tutorialRestrictionObserved);
    }
    if(level.objective.type==="skip")await page.locator(".action-button.tutorial-action-target").click();else await clickPoint(level.objective.point);
    await page.waitForFunction(()=>document.querySelector("#app")._vnode.component.proxy.tutorialSuccess);
    await page.locator(".tutorial-card-actions > .action-button-primary").click();
  }
  await page.waitForFunction(()=>!document.querySelector("#app")._vnode.component.proxy.tutorialActive);
};
const completeChallenge=async index=>{
  await page.locator(".dock-launcher-campaign").click();await page.locator(".campaign-level-card").nth(index).click();
  await page.locator(".utility-overlay-campaign").waitFor({state:"detached"});
  await page.waitForFunction(index=>document.querySelector("#app")._vnode.component.proxy.activeChallengeIndex===index,index);
  await settle();
  const level=await page.evaluate(()=>document.querySelector("#app")._vnode.component.proxy.challengeLevels[document.querySelector("#app")._vnode.component.proxy.activeChallengeIndex]);
  for(const action of level.referenceSolution){if(action.player!=="BLACK")continue;await page.waitForFunction(()=>document.querySelector("#app")._vnode.component.proxy.gameState.currentPlayer==="BLACK");await clickPoint(action.point);}
  await page.waitForFunction(()=>document.querySelector("#app")._vnode.component.proxy.challengeStatus==="won");
  await page.getByRole("button",{name:/^(返回关卡|Back to levels)$/}).click();await page.locator(".utility-overlay-campaign .utility-close").click();
  await settle();return level.id;
};
const choose=async(kind,result)=>app.evaluate(({dialog},{kind,result})=>{
  // Replace only the OS chooser result; retain the actual IPC handler and store.
  dialog[kind==="export"?"showSaveDialog":"showOpenDialog"]=async()=>result;
},{kind,result});
const transferClick=async kind=>{await prefs(true);await page.locator(".profile-progress-transfer button").nth(kind==="export"?0:1).click();await page.waitForFunction(()=>!document.querySelector("#app")._vnode.component.proxy.progressBackupBusy);await settle();};
const progressFile=()=>path.join(profile,"profile/progress/profile.json");
const settingsFile=()=>path.join(profile,"profile/settings/preferences.json");
const progress=()=>JSON.parse(fs.readFileSync(progressFile(),"utf8")).payload;
const snapshot=()=>page.evaluate(()=>{
  const v=document.querySelector("#app")._vnode.component.proxy,e=v.controller.engine,s=e.getSnapshot();
  return{actions:JSON.parse(JSON.stringify(v.localGameActions)),board:s.boardMatrix,edges:s.edges,territories:s.territories,currentPlayer:s.currentPlayer,history:[...e.historyHashes].sort(),language:v.language,audioEnabled:v.audioEnabled,audioVolume:v.audioVolume};
});
try{
  phase="actual donor progress and export";await launch("donor");await page.getByRole("button",{name:"简体中文",exact:true}).click();
  await completeTutorial();const first=await completeChallenge(0);
  await choose("export",{canceled:false,filePath:transfer});await transferClick("export");
  assert.match(await page.locator(".profile-progress-transfer").innerText(),/备份已导出/);
  const exported=JSON.parse(fs.readFileSync(transfer,"utf8"));
  assert.deepEqual(Object.keys(exported).sort(),["format","payload","schemaVersion","sha256"]);
  assert.deepEqual(exported.payload,{tutorialComplete:true,completedChallenges:[first]});
  await page.screenshot({path:path.join(evidence,"export-zh.png")});await close();
  phase="recipient merge preserves current match and preferences";await launch("recipient");await page.getByRole("button",{name:"English",exact:true}).click();
  await page.getByRole("button",{name:"Skip tutorial",exact:true}).click();const second=await completeChallenge(1);assert.notEqual(first,second);
  await page.getByRole("button",{name:"Start match",exact:true}).click();await settle();
  const point=await page.evaluate(()=>document.querySelector("#app")._vnode.component.proxy.controller.engine.getSnapshot().legalMoves[0].point);await clickPoint(point);
  const before=await snapshot(),settingsBefore=fs.readFileSync(settingsFile()),saveFile=path.join(profile,"saves/current.json"),saveBefore=fs.readFileSync(saveFile);
  await choose("import",{canceled:false,filePaths:[transfer]});await transferClick("import");
  assert.match(await page.locator(".profile-progress-transfer").innerText(),/progress merged/);
  assert.deepEqual(progress().completedChallenges,[second,first]);assert.equal(progress().tutorialComplete,true);
  assert.deepEqual(await snapshot(),before);assert.deepEqual(fs.readFileSync(settingsFile()),settingsBefore);assert.deepEqual(fs.readFileSync(saveFile),saveBefore);
  const awards=await page.evaluate(()=>document.querySelector("#app")._vnode.component.proxy.achievementState);
  assert.equal(awards.achievements.filter(x=>x.unlocked).length,2);assert.equal(awards.steam.available,false);
  receipt.checks.push("Actual five tutorials + C01 exported; independent C02 union retained; real current match and preferences unchanged; two local awards refreshed");
  phase="invalid and cancelled imports";
  const stable=fs.readFileSync(progressFile());
  await choose("import",{canceled:true,filePaths:[]});await transferClick("import");assert.deepEqual(fs.readFileSync(progressFile()),stable);
  await choose("export",{canceled:true});await transferClick("export");assert.deepEqual(fs.readFileSync(progressFile()),stable);
  const bad=path.join(evidence,"tampered.json");fs.writeFileSync(bad,JSON.stringify({...exported,sha256:"0".repeat(64)}));
  await choose("import",{canceled:false,filePaths:[bad]});await transferClick("import");assert.match(await page.locator(".profile-progress-transfer").innerText(),/nothing was imported/);assert.deepEqual(fs.readFileSync(progressFile()),stable);
  await choose("import",{canceled:false,filePaths:[transfer]});await transferClick("import");assert.match(await page.locator(".profile-progress-transfer").innerText(),/already included/);assert.deepEqual(fs.readFileSync(progressFile()),stable);
  receipt.checks.push("Cancellation, checksum failure and repeated import leave progress bytes unchanged");
  phase="compact settings reachability";
  for(const language of ["en","zh"]){
    await page.locator(".player-preferences select").first().selectOption(language);
    await settle();
    assert.match(await page.locator(".profile-progress-transfer [role=status]").innerText(),language==="zh"?/已包含在本机档案/:/already included/);
    for(const scale of ["0.9","1","1.1"]){
      await page.locator(".player-preferences select").nth(1).selectOption(scale);await settle();
      for(const selector of [".profile-progress-transfer button:last-child",".player-preferences-panel > button:last-of-type",".player-preferences-panel .shortcut-help"]){
        const button=page.locator(selector);await button.scrollIntoViewIfNeeded();await button.click({trial:true});
        const bounds=await button.evaluate(n=>{const b=n.getBoundingClientRect(),p=n.closest(".player-preferences-panel").getBoundingClientRect();return{left:b.left,right:b.right,bottom:b.bottom,top:b.top,height:innerHeight,width:innerWidth,panelBottom:p.bottom,hit:n.contains(document.elementFromPoint(b.left+b.width/2,b.top+b.height/2))};});
        assert.ok(bounds.hit&&bounds.bottom<=bounds.height+1&&bounds.top>=0&&bounds.left>=0&&bounds.right<=bounds.width+1&&bounds.panelBottom<=bounds.height+1,JSON.stringify(bounds));receipt.geometry.push({language,scale,selector,...bounds});
      }
      const documentSize=await page.evaluate(()=>({scrollHeight:document.documentElement.scrollHeight,height:innerHeight,scrollY,scale:getComputedStyle(document.body).zoom}));
      assert.ok(documentSize.scrollHeight<=documentSize.height+2,"Settings must scroll internally: "+JSON.stringify(documentSize));
    }
  }
  await page.screenshot({path:path.join(evidence,"compact-settings-zh.png")});await prefs(false);
  await close();await launch("recipient");assert.deepEqual(progress().completedChallenges,[second,first]);
  const reopened=await snapshot();assert.deepEqual(reopened.actions,before.actions);assert.deepEqual(reopened.board,before.board);assert.deepEqual(reopened.history,before.history);
  receipt.checks.push("Both languages and 90/100/110% compact settings remain reachable; subsequent preferences and restart retain imported progress and match");
  phase="future and quarantined profile rejection";await close();
  const future=JSON.stringify({format:"lifeline-profile-envelope",schemaVersion:99,payload:{schemaVersion:99}});fs.writeFileSync(progressFile(),future);
  await launch("recipient");await choose("import",{canceled:false,filePaths:[transfer]});await transferClick("import");assert.match(await page.locator(".profile-progress-transfer").innerText(),/不健康|unhealthy/);assert.equal(fs.readFileSync(progressFile(),"utf8"),future);await close();
  fs.writeFileSync(progressFile(),"{damaged-current-fixture");fs.writeFileSync(progressFile()+".bak","{damaged-backup-fixture");
  await launch("recipient");await choose("import",{canceled:false,filePaths:[transfer]});await transferClick("import");assert.match(await page.locator(".profile-progress-transfer").innerText(),/不健康|unhealthy/);await close();
  await launch("recipient");await choose("import",{canceled:false,filePaths:[transfer]});await transferClick("import");assert.match(await page.locator(".profile-progress-transfer").innerText(),/不健康|unhealthy/);
  receipt.checks.push("Synthetic future profile bytes preserved; corrupt profile quarantined and import still rejected after restart");
  assert.deepEqual(receipt.errors,[]);assert.deepEqual(receipt.requests,[]);assert.deepEqual(receipt.consoleErrors,[]);assert.equal(hash(archive),receipt.packageSha256);
  receipt.status="PACKAGED_PROGRESS_TRANSFER_PASS";
}catch(error){receipt.status="FAIL";receipt.phase=phase;receipt.error=String(error.stack??error);if(page)await page.screenshot({path:path.join(evidence,"failure.png")}).catch(()=>{});process.exitCode=1;}
finally{try{await close();}catch(error){receipt.status="FAIL";receipt.closeError=String(error);process.exitCode=1;}fs.writeFileSync(path.join(evidence,"receipt.json"),JSON.stringify(receipt,null,2)+"\n");console.log(JSON.stringify({status:receipt.status,phase:receipt.phase,error:receipt.error,receipt:path.join(evidence,"receipt.json")}));}
