import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { _electron } from "playwright-core";

const root = fileURLToPath(new URL("../../", import.meta.url));
const executable = path.join(root, "desktop/release/win-unpacked/LIFELINE.exe");
const archive = path.join(path.dirname(executable), "resources/app.asar");
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const english = process.argv.includes("--english"), language = english ? "en" : "zh";
const label = (zh, en) => english ? en : zh;
fs.mkdirSync(path.join(root, "local_artifacts"), { recursive: true });
const evidence = fs.mkdtempSync(path.join(root, "local_artifacts/parent-achievements-"));
const profile = path.join(evidence, "profile");
const queue = path.join(profile, "achievements/pending.json");
const marketing = path.join(evidence, "screenshots");
fs.mkdirSync(marketing);
const receipt = { status: "RUNNING", language, evidence, packageSha256: hash(archive),
  milestones: [], captures: [], errors: [], consoleErrors: [], vueWarnings: [], requests: [], responses: [] };
let app, page, phase = "startup";
const launch = async () => {
  const env = { ...process.env, LIFELINE_TEST_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({ executablePath: executable, env, timeout: 60000 });
  page = await app.firstWindow();
  page.on("pageerror", error => receipt.errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") receipt.consoleErrors.push(message.text());
    if (/\[Vue warn\]/.test(message.text())) receipt.vueWarnings.push(message.text());
  });
  page.on("request", request => { if (/^(https?|wss?):/i.test(request.url())) receipt.requests.push(request.url()); });
  page.on("response", response => { if (response.status() >= 400) receipt.responses.push(response.url()); });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#app")?._vnode?.component?.proxy?.controller?.renderer?.layout);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1920, 1080));
};
const close = async () => { if (app) await app.close(); app = null; page = null; };
const settle = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
const state = () => page.evaluate(() => {
  const vm = document.querySelector("#app")._vnode.component.proxy;
  return { tutorial: vm.tutorialActive, challenge: vm.challengeActive, completed: [...vm.completedChallenges],
    actions: JSON.parse(JSON.stringify(vm.localGameActions)), revision: vm.gameState.positionRevision };
});
const capture = async name => {
  await settle();
  const view = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio }));
  // Windows fractional DPI may round the requested content size up by one
  // CSS pixel. Capture the specified viewport region without resizing pixels.
  assert.ok(view.width >= 1920 && view.height >= 1080, JSON.stringify(view));
  const file = path.join(marketing, `${name}-${language}.png`);
  await page.screenshot({ path: file, clip: { x:0, y:0, width:1920, height:1080 }, scale:"css" });
  const png=fs.readFileSync(file),width=png.readUInt32BE(16),height=png.readUInt32BE(20);
  assert.ok(width>=1920&&height>=1080&&width*9===height*16);
  receipt.captures.push({ name, path: file, sha256: hash(file), viewport:view, width,height, captureCssSize:[1920,1080], source: "actual packaged game; no compositing or DOM replacement" });
};
const clickPoint = async point => {
  const target = await page.evaluate(point => {
    const vm = document.querySelector("#app")._vnode.component.proxy;
    const r = vm.controller.renderer, pixel = r.getPointPixelCoordinates(point), rect = r.canvas.getBoundingClientRect();
    return { x: rect.left + pixel.x * rect.width / r.layout.cssWidth,
      y: rect.top + pixel.y * rect.height / r.layout.cssHeight, revision: vm.gameState.positionRevision };
  }, point);
  await page.mouse.click(target.x, target.y);
  await page.waitForFunction(revision => document.querySelector("#app")._vnode.component.proxy.gameState.positionRevision > revision, target.revision);
};
const menu = async open => {
  const node = page.locator(".player-menu");
  if ((await node.getAttribute("open") !== null) !== open) await node.locator(":scope > summary").click();
  await settle();
};
const achievements = async expected => {
  const before = await state();
  await menu(true);
  const details = page.locator(".achievement-menu");
  if (await details.getAttribute("open") !== null) await details.locator(":scope > summary").click();
  await details.locator(":scope > summary").click();
  await page.waitForFunction(() => !document.querySelector("#app")._vnode.component.proxy.achievementState.loading);
  await page.locator("[data-achievement-id]").first().waitFor();
  assert.equal(await page.locator("[data-achievement-id]").count(), 5);
  assert.equal(await page.locator("[data-achievement-id].is-unlocked").count(), expected);
  assert.match(await page.locator(".achievement-panel").innerText(), english ? /Steam achievements are not enabled/ : /Steam 成就尚未启用/);
  const geometry = await page.locator(".player-menu-panel").evaluate(node => {
    const b=node.getBoundingClientRect(), panel=node.querySelector(".achievement-panel");
    return { left:b.left, right:b.right, bottom:b.bottom, width:innerWidth, height:innerHeight,
      contentWidth:panel.scrollWidth, panelWidth:panel.clientWidth };
  });
  assert.ok(geometry.left >= 0 && geometry.right <= geometry.width && geometry.bottom <= geometry.height + 1, JSON.stringify(geometry));
  assert.ok(geometry.contentWidth <= geometry.panelWidth + 1, "achievement cards must not scroll horizontally");
  assert.deepEqual(await state(), before, "opening achievement panel cannot change game state");
  if (expected > 0) assert.equal(JSON.parse(fs.readFileSync(queue, "utf8")).payload.pendingIds.length, expected);
  receipt.milestones.push({ unlocked:expected, geometry });
  await menu(false);
};

try {
  await launch();
  const welcome=page.locator(".welcome-overlay");
  if(await welcome.isVisible()) await welcome.getByRole("button",{name:english?"English":"简体中文",exact:true}).click();
  phase="complete real tutorial";
  for(const id of ["L1-connect","L2-close-territory","L3-cut-and-clear","L4-three-point-limit","L5-settle-score"]){
    const level=await page.evaluate(()=>document.querySelector("#app")._vnode.component.proxy.currentTutorialLevel);
    assert.equal(level.id,id);
    if(id==="L1-connect"||id==="L2-close-territory"||id==="L3-cut-and-clear")await capture(id);
    if(level.restriction){
      const target=await page.evaluate(point=>{const r=document.querySelector("#app")._vnode.component.proxy.controller.renderer;const p=r.getPointPixelCoordinates(point),b=r.canvas.getBoundingClientRect();return{x:b.left+p.x*b.width/r.layout.cssWidth,y:b.top+p.y*b.height/r.layout.cssHeight};},level.restriction.point);
      await page.mouse.click(target.x,target.y);
      await page.waitForFunction(()=>document.querySelector("#app")._vnode.component.proxy.tutorialRestrictionObserved);
    }
    if(level.objective.type==="skip")await page.getByRole("button",{name:label("跳过回合","Skip Turn"),exact:true}).click();
    else await clickPoint(level.objective.point);
    await page.waitForFunction(()=>document.querySelector("#app")._vnode.component.proxy.tutorialSuccess);
    await page.getByRole("button",{name:id==="L5-settle-score"?label("进入实战","Continue to a real match"):label("下一关","Next lesson"),exact:true}).click();
  }
  await page.waitForFunction(()=>!document.querySelector("#app")._vnode.component.proxy.tutorialActive);
  await achievements(1);
  const levels=await page.evaluate(()=>JSON.parse(JSON.stringify(document.querySelector("#app")._vnode.component.proxy.challengeLevels)));
  for(const [index,level] of levels.entries()){
    phase=`complete real challenge ${index+1}`;
    await page.locator(".dock-launcher-campaign").click();
    await page.locator(".campaign-level-card").nth(index).click();
    await page.locator(".utility-overlay-campaign").waitFor({state:"detached"});
    await page.waitForFunction(index=>document.querySelector("#app")._vnode.component.proxy.activeChallengeIndex===index,index);
    if(index===5||index===18)await capture(`challenge-${index+1}`);
    for(const action of level.referenceSolution){
      if(action.player!=="BLACK")continue;
      await page.waitForFunction(()=>document.querySelector("#app")._vnode.component.proxy.gameState.currentPlayer==="BLACK");
      await clickPoint(action.point);
    }
    await page.waitForFunction(()=>document.querySelector("#app")._vnode.component.proxy.challengeStatus==="won");
    if([0,5,11,23].includes(index))await achievements(index===0?2:index===5?3:index===11?4:5);
  }
  await page.getByRole("button",{name:label("返回关卡","Back to levels"),exact:true}).click();
  await page.locator(".utility-overlay-campaign .utility-close").click();
  await page.locator(".utility-overlay-campaign").waitFor({state:"detached"});
  const durable=fs.readFileSync(queue,"utf8");
  phase="compact scale and restart";
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1280,720));
  for (const scale of ["0.9", "1", "1.1"]) {
    await page.locator(".player-preferences > summary").click();
    await page.locator(".player-preferences select").nth(1).selectOption(scale);
    await page.locator(".player-preferences > summary").click();
    await achievements(5);
    await menu(true);
    const lastAward=page.locator("[data-achievement-id]").last();
    await lastAward.scrollIntoViewIfNeeded();
    const reachable=await lastAward.evaluate(node=>{
      const b=node.getBoundingClientRect();
      return {bottom:b.bottom,height:innerHeight,hit:node.contains(document.elementFromPoint(b.left+b.width/2,b.top+b.height/2))};
    });
    assert.ok(reachable.hit&&reachable.bottom<=reachable.height+1,JSON.stringify(reachable));
    const exit=page.getByRole("button",{name:label("退出游戏","Exit game"),exact:true});
    await exit.click({trial:true});
    await page.screenshot({path:path.join(evidence,`compact-achievements-${scale}.png`)});
    receipt.milestones.push({compactScale:Number(scale),lastAchievementReachable:reachable,exitButtonActionable:true});
    await menu(false);
  }
  await close();await launch();await achievements(5);
  assert.equal(fs.readFileSync(queue,"utf8"),durable,"reopening cannot duplicate pending awards");
  phase="actual queue backup recovery";
  await close();
  fs.writeFileSync(queue,"{broken-test-fixture");
  await launch();await achievements(5);
  assert.ok(fs.readdirSync(path.dirname(queue)).some(name=>name.includes(".corrupt-")));
  phase="future queue preservation";
  await close();
  const recovered=fs.readFileSync(queue,"utf8");
  const future=JSON.stringify({format:"lifeline-achievement-envelope",schemaVersion:99,payload:{schemaVersion:99}});
  fs.writeFileSync(queue,future);
  await launch();await menu(true);await page.locator(".achievement-menu > summary").click();
  await page.locator(".achievement-error").waitFor();
  await page.locator(".achievement-error button").click();
  await settle();assert.equal(fs.readFileSync(queue,"utf8"),future);
  receipt.milestones.push("synthetic damaged/future queue in isolated real app profile: recovery / fail-closed preservation passed");
  await close();fs.writeFileSync(queue,recovered);
  assert.deepEqual(receipt.errors,[]);assert.deepEqual(receipt.consoleErrors,[]);assert.deepEqual(receipt.vueWarnings,[]);
  assert.deepEqual(receipt.requests,[]);assert.deepEqual(receipt.responses,[]);
  assert.equal(hash(archive),receipt.packageSha256);
  receipt.status="ACHIEVEMENTS_AND_CAPTURE_UI_PASS";
}catch(error){
  receipt.status="FAIL";receipt.phase=phase;receipt.error=String(error.stack??error);process.exitCode=1;
  if(page)await page.screenshot({path:path.join(evidence,"failure.png")}).catch(()=>{});
}finally{
  await close().catch(error=>{receipt.closeError=String(error);process.exitCode=1;receipt.status="FAIL";});
  fs.writeFileSync(path.join(evidence,"receipt.json"),JSON.stringify(receipt,null,2));
  console.log(JSON.stringify(receipt));
}
