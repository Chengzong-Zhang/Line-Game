import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(mobileRoot, 'harmony/entry/src/main/ets/pages/Index.ets'), 'utf8');
const builderMarker = 'private mainPageWeb(controller: webview.WebviewController, generation: number, proxy: LifelineNativeProxy)';
const marker = '.onOverrideUrlLoading((event) => {';
const builderStart = source.indexOf(builderMarker);
assert.notEqual(builderStart, -1, 'Index.ets contains the main-page Web builder');
const builderEnd = source.indexOf('\n  build() {', builderStart);
assert.notEqual(builderEnd, -1, 'Index.ets contains the main ArkUI build method after mainPageWeb');
const start = source.indexOf(marker, builderStart);
assert.ok(start !== -1 && start < builderEnd, 'mainPageWeb contains the override callback');
const bodyStart = source.indexOf('{', start + marker.indexOf('{'));
let depth = 0;
let bodyEnd = -1;
for (let index = bodyStart; index < source.length; index += 1) {
  if (source[index] === '{') depth += 1;
  else if (source[index] === '}' && --depth === 0) { bodyEnd = index; break; }
}
assert.notEqual(bodyEnd, -1, 'override callback body is balanced');
assert.ok(bodyEnd < builderEnd, 'override callback remains inside mainPageWeb');
const callbackSource = `((event) => {${source.slice(bodyStart + 1, bodyEnd)}})`;
const callbackJs = ts.transpile(callbackSource, { target: ts.ScriptTarget.ES2022 });
const createCallback = new Function('url', 'WebControllerRegistry', 'LOCAL_ORIGIN', 'controller', 'generation', `return ${callbackJs}`);

function fixture() {
  const state = { generation: 12, foreground: true, wants: [], startError: null };
  const registry = {
    currentGeneration: () => state.generation,
    isForeground: () => state.foreground,
  };
  const context = {
    startAbility(want) {
      if (state.startError) throw state.startError;
      state.wants.push(want);
      return Promise.resolve();
    },
  };
  const host = {
    active: true,
    ready: true,
    hostContext: context,
    controller: { getUrl: () => 'https://lifeline.appassets.invalid/index.html' },
    attemptGeneration: 4,
    externalOpenPending: false,
    externalOpenSequence: 0,
    externalNavigationError: '',
    isCurrentAttempt(generation) { return this.active && generation === this.attemptGeneration; },
    isCurrentMainWeb(controller, generation) {
      return this.active && this.ready && this.controller === controller
        && state.generation === generation && state.foreground;
    },
  };
  const UrlApi = { URL };
  return { state, registry, host, callback: createCallback.call(
    host, UrlApi, registry, 'https://lifeline.appassets.invalid', host.controller, state.generation,
  ) };
}

function event(requestUrl, { method = 'GET', mainFrame = true, gesture = true } = {}) {
  return {
    getRequestUrl: () => requestUrl,
    getRequestMethod: () => method,
    isMainFrame: () => mainFrame,
    isRequestGesture: () => gesture,
  };
}

const expectedWant = (uri) => ({ action: 'ohos.want.action.viewData', entities: ['entity.system.browsable'], uri });

{
  const { host, state, callback } = fixture();
  assert.equal(callback.call(host, event('https://lifeline.appassets.invalid/legal/THIRD_PARTY_NOTICES.html')), false);
  assert.equal(state.wants.length, 0, 'trusted local navigation remains in WebView');
}

for (const target of ['https://example.org/page?q=1', 'http://example.org/page']) {
  const { host, state, callback } = fixture();
  assert.equal(callback.call(host, event(target)), true, 'external URL is blocked in WebView');
  assert.equal(host.externalOpenPending, true, `eligible handoff starts exactly one system request (${host.externalOpenSequence}, ${state.generation})`);
  await Promise.resolve();
  assert.deepEqual(state.wants, [expectedWant(target)], 'eligible URL is sent to system link resolution');
  assert.equal(host.externalOpenPending, false);
}

for (const brokenMetadata of ['getRequestMethod', 'isMainFrame', 'isRequestGesture']) {
  const { host, state, callback } = fixture();
  const request = event('https://example.org');
  request[brokenMetadata] = () => { throw new Error('metadata unavailable'); };
  assert.equal(callback.call(host, request), true, `${brokenMetadata} failure conservatively blocks navigation`);
  assert.equal(state.wants.length, 0, `${brokenMetadata} failure makes no system request`);
}

for (const [target, options] of [
  ['https://example.org', { gesture: false }],
  ['https://example.org', { mainFrame: false }],
  ['https://example.org', { method: 'POST' }],
  ['file:///tmp/page', {}],
  ['javascript:alert(1)', {}],
  ['https://user:pass@example.org', {}],
  ['not a url', {}],
]) {
  const { host, state, callback } = fixture();
  assert.equal(callback.call(host, event(target, options)), true, `${target} is blocked`);
  assert.equal(state.wants.length, 0, `${target} is not handed to system`);
}

for (const alter of [
  ({ host }) => { host.active = false; },
  ({ host }) => { host.ready = false; },
  ({ state }) => { state.generation = -1; },
  ({ state }) => { state.foreground = false; },
  ({ host }) => { host.controller.getUrl = () => 'https://other.example/page'; },
  ({ host }) => { host.controller.getUrl = () => { throw new Error('unavailable'); }; },
]) {
  const fixtureState = fixture();
  alter(fixtureState);
  assert.equal(fixtureState.callback.call(fixtureState.host, event('https://example.org')), true);
  assert.equal(fixtureState.state.wants.length, 0, 'inactive or untrusted host cannot hand off');
}

{
  const { host, state, callback } = fixture();
  assert.equal(callback.call(host, event('https://first.example')), true);
  assert.equal(callback.call(host, event('https://second.example')), true);
  await Promise.resolve();
  assert.deepEqual(state.wants, [expectedWant('https://first.example')], 'duplicate pending handoffs are suppressed');
}

{
  const { host, state, callback } = fixture();
  state.startError = new Error('private failure details');
  assert.equal(callback.call(host, event('https://example.org')), true);
  assert.match(host.externalNavigationError, /Unable to open/);
  assert.doesNotMatch(host.externalNavigationError, /private failure details/);
}

{
  const { host, state, callback } = fixture();
  let rejectOpen;
  host.hostContext.startAbility = () => new Promise((_resolve, reject) => { rejectOpen = reject; });
  callback.call(host, event('https://example.org'));
  rejectOpen(new Error('private rejection details'));
  await Promise.resolve();
  await Promise.resolve();
  assert.match(host.externalNavigationError, /Unable to open/);
  assert.doesNotMatch(host.externalNavigationError, /private rejection details/);
  assert.equal(host.externalOpenPending, false);
}

{
  const { host, state, callback } = fixture();
  let resolveOpen;
  host.hostContext.startAbility = () => new Promise((resolve) => { resolveOpen = resolve; });
  callback.call(host, event('https://example.org'));
  state.generation += 1;
  resolveOpen();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(host.externalOpenPending, true, 'stale completion cannot change newer page state');
}

// API 12 may omit POST, HTTP(S) iframe, and programmatic loadUrl flows from this callback; mocks do not prove their delivery or browser launch.
console.log('Harmony external-navigation callback tests passed; mocks do not prove ArkWeb delivery for excluded flows or actual browser launch.');
