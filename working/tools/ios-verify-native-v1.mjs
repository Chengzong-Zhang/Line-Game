import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
const dir = process.argv[2];
if (!dir) throw new Error('Usage: node ios-verify-native-v1.mjs <candidate-directory>');
const receipt = JSON.parse(await readFile(path.join(dir,'ios-native-v1-receipt.json'),'utf8'));
assert.equal(receipt.status,'MAC-VERIFICATION-PENDING');
const root=path.join(dir,'App/App/public');
const entry=await readFile(path.join(root,'mobile-entry.js'),'utf8');
const trial=await readFile(path.join(root,'mobile-entry.ios-trial.js'),'utf8');
assert.match(trial,/import\("\.\/platform\/ios-bridge\.js"\)/);
assert.doesNotMatch(trial,/native-back-bootstrap|harmony-bridge|mobile-bridge\.js/);
if (receipt.native_trial) assert.equal(entry,trial);
else {
  for (const language of ['zh-CN','en-US']) {
    const body={replaceChildren(element){this.element=element;}};
    const document={body,createElement(tag){return {tag,setAttribute(){}};}};
    vm.runInNewContext(entry,{document,navigator:{language}});
    assert.equal(body.element.tag,'main');
    assert.match(body.element.textContent,language.startsWith('en') ? /verification is pending/ : /原生验证尚未完成/);
  }
}
console.log(`iOS ${receipt.native_trial ? 'trial entry' : 'default gate'}: PASS (static and DOM mock only)`);

const projectRoot=path.join(dir,'App');
const project=await readFile(path.join(projectRoot,'App.xcodeproj/project.pbxproj'),'utf8');
const storyboard=await readFile(path.join(projectRoot,'App/Base.lproj/Main.storyboard'),'utf8');
const scene=await readFile(path.join(projectRoot,'App/SceneDelegate.swift'),'utf8');
const view=await readFile(path.join(projectRoot,'App/LifelineBridgeViewController.swift'),'utf8');
const sources=['LifelineBridgeViewController.swift','LifelineStore.swift','LifelineStoragePlugin.swift','LifelinePlatformPlugins.swift','LifelineReplayPlugins.swift'];
for (const name of sources) {
  assert.equal((project.match(new RegExp(`${name.replaceAll('.', '\\.')} in Sources`, 'g')) ?? []).length,2,`${name} has one build file and one target entry`);
  await readFile(path.join(projectRoot, 'App', name==='LifelineBridgeViewController.swift' ? name : `Plugins/${name}`));
}
assert.match(storyboard,/customClass="LifelineBridgeViewController"/);
assert.match(scene,/rootViewController = LifelineBridgeViewController\(\)/);
for (const name of ['Storage','Capabilities','Network','Haptics','ReplayImport','TutorialHost','IOS']) assert.match(view,new RegExp(`registerPluginInstance\\(Lifeline${name}Plugin\\(\\)\\)`));
const packageSource=await readFile(path.join(dir,'Package.swift'),'utf8');
assert.match(packageSource,/testTarget\(name: "LifelineStoreTests"/);
assert.match(packageSource,/sources: \["LifelineStore.swift"\]/);
assert.match(await readFile(path.join(projectRoot,'AppTests/LifelineStoreTests.swift'),'utf8'),/import XCTest/);
assert.match(await readFile(path.join(projectRoot,'CapApp-SPM/Package.swift'),'utf8'),/exact: "8\.5\.3"/);
const adapter=await readFile(path.join(root,'platform/ios-bridge.js'),'utf8');
assert.doesNotMatch(adapter,/@capacitor\/(?:app|filesystem|share)/);
assert.doesNotMatch(adapter,/Lifeline(?:IOS|Network)\.addListener/);
assert.match(adapter,/registerPlugin\('LifelineIOS'\)/);
console.log('iOS project wiring: PASS (static references only; Xcode build unverified)');
const tutorialCode=await readFile(path.join(root,'platform/TutorialHost.js'),'utf8');
const tutorial=await import(`data:text/javascript;base64,${Buffer.from(tutorialCode).toString('base64')}`);
assert.equal(tutorial.createTutorialTarget('capacitor://localhost/index.html'), 'capacitor://localhost/index.html?tutorial=1');
assert.equal(tutorial.createTutorialTarget('https://example.org/index.html'), 'https://example.org/index.html?tutorial=1');
for (const value of ['capacitor://evil/index.html','capacitor://localhost:123/index.html','capacitor://user@localhost/index.html','capacitor://localhost/other.html']) assert.throws(()=>tutorial.createTutorialTarget(value));
let requested='';
await tutorial.openTutorialTarget({currentHref:'capacitor://localhost/index.html',platform:{isNative:true,openTutorial:async url=>{requested=url;return {status:'opened'};}}});
assert.equal(requested,'capacitor://localhost/index.html?tutorial=1');
console.log('iOS tutorial URL: PASS (strict URL and mocked native opener; WebView unverified)');
const modules=['platform/ios-bridge.js','platform/ios-session-recovery.js','platform/ios-document-lease.js','platform/ios-credential-recovery.js','platform/haptics-controller.js'];
const seen=new Set();
while (modules.length) {
  const relative=modules.pop(); if(seen.has(relative)) continue; seen.add(relative);
  const code=await readFile(path.join(root,relative),'utf8');
  for (const match of code.matchAll(/(?:\bfrom\s*|\bimport\s*\()\s*["']([^"']+)["']/g)) {
    const spec=match[1];
    assert.ok(spec.startsWith('.'), `Unresolved bare import ${spec} in ${relative}`);
    const dep=path.normalize(path.join(path.dirname(relative),spec.split('?')[0]));
    assert.ok(!dep.startsWith('..') && !path.isAbsolute(dep),`Import escapes public: ${spec}`);
    await readFile(path.join(root,dep));
    if(dep.startsWith(`platform${path.sep}`)) modules.push(dep);
  }
}
console.log(`iOS bridge import paths: PASS (${seen.size} platform modules; static references only)`);
