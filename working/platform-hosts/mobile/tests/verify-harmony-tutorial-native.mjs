import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from '../node_modules/typescript/lib/typescript.js';
import { installHarmonyNativeBridge } from '../src/harmony-native-bridge.js';
import { openTutorialTarget } from '../../web/web前端/platform/TutorialHost.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridgeGlobalNames = [
  'LifelineBridge',
  'LifelineArkTS',
  '__lifelineNativeComplete',
  '__lifelineNetworkStatusEvent',
];
const originalBridgeGlobalDescriptors = new Map(bridgeGlobalNames.map((name) => [
  name,
  Object.getOwnPropertyDescriptor(globalThis, name),
]));
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const pendingTimers = new Map();
let nextTimer = 0;
globalThis.setTimeout = (callback) => { const id = ++nextTimer; pendingTimers.set(id, callback); return id; };
globalThis.clearTimeout = (id) => pendingTimers.delete(id);

try {
  const nativeSource = await readFile(path.join(root, 'harmony/entry/src/main/ets/bridge/LifelineNativeProxy.ets'), 'utf8');
  const nativeJavaScript = ts.transpileModule(
    nativeSource.split(/\r?\n/).filter((line) => !line.startsWith('import ')).join('\n'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
  ).outputText;
  const nativeExports = {};
  new Function('exports', 'url', 'WebControllerRegistry', 'console', 'setTimeout', 'clearTimeout', nativeJavaScript)(
    nativeExports,
    { URL },
    {
      isForeground: () => true,
      isCurrentGeneration: (_controller, generation) => generation === 0,
      currentGeneration: () => 0,
    },
    console,
    globalThis.setTimeout,
    globalThis.clearTimeout,
  );

  const pageSource = await readFile(path.join(root, 'harmony/entry/src/main/ets/pages/Index.ets'), 'utf8');
  const pageCut = pageSource.indexOf('  private createResponse(');
  assert.ok(pageCut > 0, 'Index tutorial opener is included in the executable host slice');
  const pageJavaScript = ts.transpileModule(
    pageSource.slice(0, pageCut)
      .replace(/^import .*;\r?\n/gm, '')
      .replace(/^@(Entry|Component)\s*$/gm, '')
      .replace(/@State\s+/g, '')
      .replace('struct Index', 'class Index') + '}\nglobalThis.TutorialPage = Index;',
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
  ).outputText;

  class MockWebviewController {
    getUrl() { return 'https://lifeline.appassets.invalid/index.html'; }
    getLastJavascriptProxyCallingFrameUrl() { return 'https://lifeline.appassets.invalid/index.html'; }
    runJavaScript(script) {
      (0, eval)(script);
      return Promise.resolve('');
    }
  }
  const registry = {
    currentGeneration: () => 0,
    isCurrentGeneration: (_controller, generation) => generation === 0,
    isForeground: () => true,
  };
  const context = vm.createContext({
    webview: { WebviewController: MockWebviewController },
    WebControllerRegistry: registry,
    MainWebRecoveryPolicy: class { generation() { return 0; } },
    preferences: {},
    common: {},
    PACKAGED_WEB_FILES: [],
    url: { URL },
    console,
  });
  vm.runInContext(pageJavaScript, context);
  const page = new context.TutorialPage();
  page.active = true;
  page.ready = true;

  const controller = page.controller;
  const nativeProxy = new nativeExports.LifelineNativeProxy(
    {}, controller, {}, () => 0,
    (targetUrl) => page.openTutorialOverlay(targetUrl),
  );
  globalThis.LifelineArkTS = {
    callNative: (requestId, operation, key, value) => nativeProxy.callNative(requestId, operation, key, value),
  };
  assert.equal(installHarmonyNativeBridge(), true);

  const currentHref = 'https://lifeline.appassets.invalid/index.html?room=ROOM-7#active';
  const result = await openTutorialTarget({
    platform: {
      isNative: true,
      openTutorial: (targetUrl) => globalThis.LifelineBridge.openTutorial(targetUrl),
    },
    currentHref,
  });
  assert.equal(result.status, 'opened');
  assert.equal(result.target, 'https://lifeline.appassets.invalid/index.html?tutorial=1');
  assert.equal(page.tutorialUrl, result.target, 'the actual ArkTS proxy callback opens the Index tutorial overlay');
  assert.equal(page.tutorialOwnerGeneration, 1);
  assert.ok(page.tutorialController instanceof MockWebviewController);

  const duplicate = await globalThis.LifelineBridge.openTutorial(result.target);
  assert.deepEqual(duplicate, { status: 'opened' }, 'reopening the same tutorial target is idempotent');
  await assert.rejects(globalThis.LifelineBridge.openTutorial(`${result.target}&room=ROOM-7`), /not allowed/i);
  assert.equal(page.tutorialUrl, result.target, 'a rejected target leaves the open overlay unchanged');

  assert.equal(page.onBackPress(), true, 'native back is consumed while the tutorial is open');
  assert.equal(page.tutorialUrl, '', 'native back closes the overlay through the actual Index handler');
  assert.equal(page.tutorialOwnerGeneration, -1);
  assert.equal(pendingTimers.size, 0, 'successful and rejected native calls leave no bridge timeout scheduled');
  console.log('verify-harmony-tutorial-native: PASS (Web tutorial host -> Harmony JS bridge -> transpiled ArkTS proxy -> Index overlay state and back close; mocked host APIs, not ArkUI SDK compilation or device rendering)');
} finally {
  for (const [name, descriptor] of originalBridgeGlobalDescriptors) {
    if (descriptor === undefined) delete globalThis[name];
    else Object.defineProperty(globalThis, name, descriptor);
  }
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
}
