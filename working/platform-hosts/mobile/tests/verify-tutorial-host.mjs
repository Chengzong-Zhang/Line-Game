import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openTutorialTarget } from '../../web/web前端/platform/TutorialHost.js';

const target = 'https://localhost/index.html?tutorial=1';
let nativeTarget = null;
const opened = await openTutorialTarget({
  platform: { isNative: true, openTutorial: async (url) => { nativeTarget = url; return { status: 'opened' }; } },
  currentHref: 'https://localhost/index.html?room=ROOM-1#active',
});
assert.equal(opened.status, 'opened');
assert.equal(nativeTarget, target, 'native success receives a same-origin tutorial URL');

await assert.rejects(openTutorialTarget({
  platform: { isNative: true, openTutorial: async () => { throw new Error('native rejected'); } },
  currentHref: 'https://localhost/index.html',
}), /native rejected/, 'native rejection remains observable to the caller');

const webTabs = [];
const webResult = await openTutorialTarget({
  platform: { isNative: false },
  currentHref: 'https://game.example/play?room=ROOM-2',
  open: (...args) => webTabs.push(args),
});
assert.equal(webResult.status, 'opened');
assert.equal(new URL(webTabs[0][0]).searchParams.get('tutorial'), '1');
assert.deepEqual(webTabs[0].slice(1), ['_blank', 'noopener']);

await assert.rejects(openTutorialTarget({
  platform: { isNative: true, openTutorial: async () => ({ status: 'opened' }) },
  currentHref: 'file:///tmp/index.html',
}), /invalid-tutorial-url/);

const onlineApp = await readFile(new URL('../../web/web前端/OnlineApp.js', import.meta.url), 'utf8');
assert.match(onlineApp, /openTutorialTarget\(/);
assert.match(onlineApp, /当前联机对局仍保持连接/);
assert.doesNotMatch(onlineApp, /location\.(?:assign|replace|reload)\(/,
  'opening a tutorial cannot navigate away from the online game');

const androidHost = await readFile(new URL('../android/app/src/main/java/cn/lifelinegame/mobile/LifelineTutorialHostPlugin.java', import.meta.url), 'utf8');
assert.match(androidHost, /new WebView\(activity\)/, 'Android dialog WebView uses the Activity context');
assert.match(androidHost, /WebViewAssetLoader/);
assert.match(androidHost, /uri\.getQueryParameters\("tutorial"\)\.size\(\) == 1/);
assert.match(androidHost, /getQueryParameterNames\(\)\.size\(\) == 1/);
assert.match(androidHost, /closeTutorial\(\)/);
assert.match(androidHost, /enum HostState \{ CLOSED, OPENING, OPEN, CLOSING \}/);
assert.match(androidHost, /hostState = HostState\.OPENING/);
assert.match(androidHost, /hostState == HostState\.OPENING/);
assert.match(androidHost, /hostState = HostState\.CLOSING/);
const androidOpenMethod = androidHost.slice(androidHost.indexOf('public void openTutorial'), androidHost.indexOf('private static boolean isAllowedTarget'));
assert.doesNotMatch(androidOpenMethod, /isShowing\(/, 'open reservation never reads Dialog state off the UI thread');
assert.match(androidHost, /activity\.runOnUiThread\(\(\) -> \{/);
assert.match(androidHost, /new Handler\(Looper\.getMainLooper\(\)\)\.post\(release\)/);
assert.match(androidHost, /webView\.getSettings\(\)\.setBlockNetworkLoads\(true\)/);
assert.match(androidHost, /connect-src 'none'/, 'Android tutorial document adds a restrictive CSP');
assert.match(androidHost, /if \(!rendererGone\) \{[\s\S]*?webView\.stopLoading\(\)[\s\S]*?webView\.loadUrl\("about:blank"\)/,
  'renderer-gone cleanup skips stopLoading and loadUrl');
assert.match(androidHost, /webView\.getParent\(\) instanceof ViewGroup[\s\S]*?removeView\(webView\)[\s\S]*?webView\.destroy\(\)/,
  'release detaches the view before destroying it');
assert.match(androidHost, /if \(session\.released\) return/,
  'a tutorial session can only be released once');

const harmonyHost = await readFile(new URL('../harmony/entry/src/main/ets/pages/Index.ets', import.meta.url), 'utf8');
assert.match(harmonyHost, /tutorialController/);
assert.match(harmonyHost, /Stack\(\)/, 'Harmony keeps the primary ArkWeb mounted under a tutorial overlay');
assert.doesNotMatch(harmonyHost, /tutorialUrl\.length === 0 \? Visibility\.Visible : Visibility\.Hidden/);
assert.doesNotMatch(harmonyHost, /tutorialUrl\.length === 0 \? '100%' : 0/);
assert.match(harmonyHost, /Close/);
assert.match(harmonyHost, /candidate\.searchParams\.getAll\('tutorial'\)\.length === 1/);
assert.match(harmonyHost, /this\.tutorialGeneration \+= 1/);
assert.match(harmonyHost, /this\.tutorialController = new webview\.WebviewController\(\)/);
assert.match(harmonyHost, /isCurrentTutorial\(tutorialGeneration, tutorialController\)/);
assert.match(harmonyHost, /return this\.createResponse\(403, 'Forbidden', 'text\/plain', 'Tutorial network access is disabled\.'/);
assert.match(harmonyHost, /interceptTutorialRequest\(event\.request\.getRequestUrl\(\)\)/);
assert.doesNotMatch(harmonyHost, /if \(!requestUrl\.startsWith\(`\$\{LOCAL_ORIGIN\}\/`\)\) return null/,
  'tutorial interception never uses null to allow non-local requests');

const mobileBuilder = await readFile(new URL('../tools/build-web.mjs', import.meta.url), 'utf8');
assert.match(mobileBuilder, /getAll\("tutorial"\)\.length === 1[\s\S]*?tutorialPolicy\.content = .*connect-src/,
  'standalone tutorial adds a stricter connect-src policy before application modules start');
assert.match(androidHost, /shouldInterceptRequest[\s\S]*?if \(!isTrustedOrigin\(uri\)\) return blockedResponse\(\)/,
  'Android rejects non-local WebView resource requests');
assert.ok(androidHost.includes('setBlockNetworkLoads(true)') && androidHost.includes("connect-src 'none'"),
  'Android network-load setting and tutorial CSP cover connection types outside shouldInterceptRequest, including WebSocket');

console.log('verify-tutorial-host: PASS (native success/rejection, browser fallback, URL constraints, online preservation, Android/Harmony host state, cleanup, network blocking, and generation guards; structural native-source evidence, not instrumentation)');
