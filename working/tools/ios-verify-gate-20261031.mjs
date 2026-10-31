import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const code=await readFile(fileURLToPath(new URL('../../local_artifacts/alignment-20261031/mobile/mobile/ios/App/App/public/mobile-entry.js',import.meta.url)),'utf8');
for (const language of ['zh-CN','en-US']) {
  const app={replaceChildren(node){this.node=node;}};
  const document={getElementById(id){assert.equal(id,'app');return app;}, createElement(tag){return {tag,setAttribute(){},style:{},append(...items){this.children=items;}};}};
  vm.runInNewContext(code,{document,navigator:{language}});
  assert.equal(app.node.tag,'main');
  assert.match(app.node.children[0].textContent,language.startsWith('en') ? /preparation/ : /准备中/);
}
console.log('iOS capability gate: PASS (two languages, isolated DOM)');
