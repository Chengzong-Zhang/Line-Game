import test from 'node:test';
import assert from 'node:assert/strict';
import { userInfoPlatform } from '../src/user-info-platform.js';

const bounds = { x: 20, y: 120, width: 280, height: 42 };
const userInfo = { nickName: '  微信棋手😀  ', avatarUrl: 'https://thirdwx.qlogo.cn/mmopen/fixture/132',
  gender: 1, city: 'private-city', country: 'private-country' };
const expected = { displayName: '微信棋手😀', avatarUrl: userInfo.avatarUrl };
const resultFor = source => ({ userInfo: source, errMsg: 'getUserInfo:ok', encryptedData: 'private-encrypted', signature: 'private-signature' });

function nativeHarness() {
  const calls = [], results = [];
  let tap, options;
  const button = {
    onTap(callback) { tap = callback; calls.push('listen'); },
    offTap(callback) { assert.equal(callback, tap); calls.push('unlisten'); },
    show() { calls.push('show'); }, hide() { calls.push('hide'); }, destroy() { calls.push('destroy'); },
  };
  const api = { createUserInfoButton(value) { options = value; return button; } };
  const platform = userInfoPlatform(api);
  const control = platform.createUserInfoControl({ bounds, onResult: (profile, error) => results.push({ profile, error: error?.message }) });
  return { api, button, calls, results, control, platform, tap: value => tap(value), options: () => options };
}

test('automatic import only reads an already authorized WeChat profile and strips unrelated data', async () => {
  const calls = [];
  const api = {
    getSetting(options) { calls.push('setting'); options.success({ authSetting: { 'scope.userInfo': true } }); },
    getUserInfo(options) { calls.push('profile'); assert.equal(options.withCredentials, false); options.success(resultFor(userInfo)); },
  };
  assert.deepEqual(await userInfoPlatform(api).getAuthorizedUserInfo(), expected);
  assert.deepEqual(calls, ['setting', 'profile']);
  for (const authorized of [false, undefined, 'true']) {
    api.getSetting = options => options.success({ authSetting: { 'scope.userInfo': authorized } });
    calls.length = 0;
    assert.equal(await userInfoPlatform(api).getAuthorizedUserInfo(), null);
    assert.deepEqual(calls, [], 'an unauthorized startup never requests or prompts for user information');
  }
});

test('unsupported, rejected, throwing and malformed optional APIs safely return null', async () => {
  const authorized = options => options.success({ authSetting: { 'scope.userInfo': true } });
  for (const api of [undefined, {}, { getSetting() { throw new Error('unavailable'); } },
    { getSetting(options) { options.fail({ errMsg: 'denied' }); } }, { getSetting: authorized },
    { getSetting: authorized, getUserInfo() { throw new Error('unavailable'); } },
    { getSetting: authorized, getUserInfo(options) { options.fail({ errMsg: 'denied' }); } },
    { getSetting: authorized, getUserInfo(options) { options.success(null); } },
    { get getSetting() { throw new Error('unavailable'); } }]) {
    assert.equal(await userInfoPlatform(api).getAuthorizedUserInfo(), null);
  }
});

test('an optional API timeout settles once and ignores a late success', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let callback, reads = 0;
  const platform = userInfoPlatform({ getSetting(options) { callback = options.success; }, getUserInfo() { reads++; } });
  const pending = platform.getAuthorizedUserInfo();
  t.mock.timers.tick(10000);
  assert.equal(await pending, null);
  callback({ authSetting: { 'scope.userInfo': true } });
  await Promise.resolve();
  assert.equal(reads, 0);
});

test('default anonymous, demoted, invalid and arbitrary-origin information never replaces a player profile', async () => {
  const invalid = [
    { ...userInfo, nickName: '微信用户' }, { ...userInfo, nickName: 'WeChat User' },
    { ...userInfo, nickName: '匿名用户' }, { ...userInfo, nickName: '\n\u0000' },
    { ...userInfo, is_demote: true }, { ...userInfo, is_demote: 1 },
    { ...userInfo, avatarUrl: '' }, { ...userInfo, avatarUrl: 'http://wx.qlogo.cn/mmopen/avatar/132' },
    { ...userInfo, avatarUrl: 'https://wx.qlogo.cn.evil.invalid/avatar' },
    { ...userInfo, avatarUrl: 'https://wx.qlogo.cn@evil.invalid/avatar' },
    { ...userInfo, avatarUrl: 'https://thirdqq.qlogo.cn/avatar' },
    { ...userInfo, avatarUrl: 'https://thirdwx.qlogo.cn\\@evil.invalid/avatar' },
    { ...userInfo, avatarUrl: 'https://thirdwx.qlogo.cn:8443/avatar' },
    { ...userInfo, avatarUrl: 'https://thirdwx.qlogo.cn/avatar\nheader' },
  ];
  for (const source of invalid) {
    const h = nativeHarness(); h.tap(resultFor(source));
    assert.equal(h.results.length, 1);
    assert.equal(h.results[0].profile, null);
    h.control.destroy();
  }
  const h = nativeHarness();
  h.tap(resultFor({ ...userInfo, nickName: '\u202e' + '😀'.repeat(40), avatarUrl: 'https://wx.qlogo.cn:443/mmopen/avatar/0' }));
  assert.equal(Array.from(h.results[0].profile.displayName).length, 24);
  assert.equal(h.results[0].profile.avatarUrl, 'https://wx.qlogo.cn:443/mmopen/avatar/0');
  h.control.destroy();
});

test('native user-info button imports minimal data, uses logical-pixel bounds and does not request credentials', () => {
  const h = nativeHarness(), options = h.options();
  assert.equal(options.type, 'text'); assert.equal(options.withCredentials, false); assert.equal(options.lang, 'zh_CN');
  assert.equal(options.text, '导入微信昵称头像');
  assert.equal(options.style.left, 20); assert.equal(options.style.top, 120);
  assert.equal(options.style.width, 280); assert.equal(options.style.height, 42);
  h.tap(resultFor(userInfo));
  assert.deepEqual(h.results, [{ profile: expected, error: undefined }]);
  assert.equal(h.control.update({ bounds: { left: 12, top: 40, width: 200, height: 36 }, language: 'en' }), true);
  assert.equal(h.button.style.left, 12); assert.equal(h.button.style.top, 40);
  assert.equal(h.button.text, 'Use WeChat profile');
  h.control.destroy();
});

test('native refusal and unconfigured privacy return actionable errors without importing data', () => {
  const h = nativeHarness();
  for (const [result, expectedError] of [
    [{ errMsg: 'getUserInfo:fail auth deny' }, 'WECHAT_PROFILE_DENIED'],
    [{ errCode: 112, errMsg: 'getUserInfo:fail' }, 'WECHAT_PRIVACY_UNCONFIGURED'],
    [{ errno: 1025 }, 'WECHAT_PRIVACY_UNCONFIGURED'],
    [{ errno: 1026 }, 'WECHAT_PRIVACY_UNCONFIGURED'],
    [{ errno: 104, userInfo }, 'WECHAT_PROFILE_DENIED'],
    [{ errMsg: 'getUserInfo:fail unknown', userInfo }, 'WECHAT_PROFILE_UNAVAILABLE'],
    [null, 'WECHAT_PROFILE_UNAVAILABLE'],
  ]) {
    h.tap(result); assert.deepEqual(h.results.at(-1), { profile: null, error: expectedError });
  }
  h.control.destroy();
});

test('hidden and destroyed native controls suppress late callbacks, and destruction is idempotent', () => {
  const h = nativeHarness();
  h.control.hide(); h.tap(resultFor(userInfo)); assert.equal(h.results.length, 0);
  assert.equal(h.control.show(), true); h.tap(resultFor(userInfo)); assert.equal(h.results.length, 1);
  assert.equal(h.control.update({ bounds: { ...bounds, width: 0 } }), false);
  assert.equal(h.control.show(), false, 'an invalid layout cannot resurrect a stale native hit area');
  h.tap(resultFor(userInfo)); assert.equal(h.results.length, 1);
  h.control.destroy(); h.control.destroy();
  h.tap(resultFor(userInfo));
  assert.equal(h.results.length, 1); assert.equal(h.calls.filter(call => call === 'destroy').length, 1);
  assert.equal(h.control.show(), false); assert.equal(h.control.update({ bounds }), false);
});

test('missing, throwing and broken native controls safely degrade without blocking the game', () => {
  for (const api of [{}, { createUserInfoButton() { throw new Error('unavailable'); } },
    { createUserInfoButton() { return {}; } }, { get createUserInfoButton() { throw new Error('unavailable'); } }]) {
    const results = [];
    assert.equal(userInfoPlatform(api).createUserInfoControl({ bounds, onResult: (profile, error) => results.push([profile, error?.message]) }), null);
    assert.deepEqual(results, [[null, 'WECHAT_PROFILE_UNAVAILABLE']]);
  }
  assert.doesNotThrow(() => userInfoPlatform({}).createUserInfoControl({ bounds, onResult() { throw new Error('UI disposed'); } }));
  const h = nativeHarness();
  Object.defineProperty(h.button, 'style', { set() { throw new Error('native unavailable'); } });
  assert.equal(h.control.update({ bounds }), false);
  h.tap(resultFor(userInfo));
  assert.equal(h.results.length, 1); assert.equal(h.results[0].profile, null);
  h.control.destroy();
});

function privacyHarness(language = 'zh') {
  let handler, removed;
  const sheets = [], contracts = [];
  const api = { onNeedPrivacyAuthorization(callback) { handler = callback; },
    offNeedPrivacyAuthorization(callback) { removed = callback; }, showActionSheet(options) { sheets.push(options); },
    openPrivacyContract(options) { contracts.push(options); } };
  const dispose = userInfoPlatform(api).installPrivacyAuthorization({ language });
  return { api, sheets, contracts, dispose, request() { const events = []; handler(event => events.push(event.event)); return events; },
    removed: () => removed === handler };
}

test('privacy authorization waits for a real confirmation, merges concurrent requests and strips duplicate answers', () => {
  const h = privacyHarness(), first = h.request(), second = h.request();
  assert.deepEqual(first, ['exposureAuthorization']); assert.deepEqual(second, ['exposureAuthorization']);
  assert.equal(h.sheets.length, 1); assert.match(h.sheets[0].alertText, /微信昵称和头像/);
  assert.deepEqual(h.sheets[0].itemList, ['阅读隐私指引', '同意并继续', '拒绝']);
  h.sheets[0].success({ tapIndex: 1 });
  assert.deepEqual(first, ['exposureAuthorization', 'agree']); assert.deepEqual(second, ['exposureAuthorization', 'agree']);
  const third = h.request(); assert.equal(h.sheets.length, 2);
  h.sheets[0].success({ tapIndex: 1 }); h.sheets[0].fail();
  assert.deepEqual(third, ['exposureAuthorization'], 'a prior native callback cannot authorize a later request');
  h.sheets[1].success({ tapIndex: 2 });
  assert.deepEqual(third, ['exposureAuthorization', 'disagree']);
  h.dispose(); assert.equal(h.removed(), true);
});

test('privacy language is read at prompt time and disposal rejects all late authorization', () => {
  let language = 'zh';
  const h = privacyHarness(() => language);
  const first = h.request(); assert.equal(h.sheets[0].itemList[1], '同意并继续');
  h.sheets[0].fail(); assert.equal(first.at(-1), 'disagree');
  language = 'en';
  const second = h.request(); assert.equal(h.sheets[1].itemList[1], 'Agree and continue');
  h.dispose(); h.dispose();
  assert.deepEqual(second, ['exposureAuthorization', 'disagree']);
  h.sheets[1].success({ tapIndex: 1 });
  assert.deepEqual(second, ['exposureAuthorization', 'disagree']);
  assert.deepEqual(h.request(), ['disagree']);
});

test('privacy unsupported APIs, thrown sheet and callback exceptions never imply consent or block the game', () => {
  assert.doesNotThrow(() => userInfoPlatform(undefined).installPrivacyAuthorization()());
  for (const options of [{}, { showActionSheet() { throw new Error('unavailable'); }, openPrivacyContract() {} },
    { showActionSheet() {} }]) {
    let handler;
    const dispose = userInfoPlatform({ onNeedPrivacyAuthorization(callback) { handler = callback; }, ...options }).installPrivacyAuthorization();
    const events = []; handler(event => events.push(event.event));
    assert.deepEqual(events, ['exposureAuthorization', 'disagree']);
    assert.doesNotThrow(() => handler(() => { throw new Error('aborted'); }));
    dispose();
  }
});

test('reading the official privacy guide keeps consent pending and returns to explicit agree or decline choices', async () => {
  const h = privacyHarness(), events = h.request();
  h.sheets[0].success({ tapIndex: 0 });
  assert.equal(h.contracts.length, 1);
  assert.deepEqual(events, ['exposureAuthorization'], 'opening the privacy guide does not grant consent');
  h.contracts[0].success({ errMsg: 'openPrivacyContract:ok' });
  await Promise.resolve();
  assert.equal(h.sheets.length, 2);
  h.sheets[0].success({ tapIndex: 1 });
  assert.deepEqual(events, ['exposureAuthorization'], 'a delayed earlier sheet cannot agree after reading');
  h.sheets[1].success({ tapIndex: 1 });
  assert.deepEqual(events, ['exposureAuthorization', 'agree']);
  h.dispose();
});

test('failed or late privacy-guide callbacks never grant consent or reopen a disposed prompt', async () => {
  for (const disposeEarly of [false, true]) {
    const h = privacyHarness(), events = h.request();
    h.sheets[0].success({ tapIndex: 0 });
    if (disposeEarly) h.dispose();
    h.contracts[0].fail();
    await Promise.resolve();
    assert.deepEqual(events, ['exposureAuthorization', 'disagree']);
    h.contracts[0].success({ errMsg: 'openPrivacyContract:ok' });
    await Promise.resolve();
    assert.equal(h.sheets.length, 1);
    h.dispose();
  }
});

test('opening WeChat privacy contract is optional and failure returns false', async () => {
  for (const api of [{}, { openPrivacyContract() { throw new Error('unavailable'); } },
    { openPrivacyContract(options) { options.fail(); } }, { get openPrivacyContract() { throw new Error('unavailable'); } }]) {
    assert.equal(await userInfoPlatform(api).openPrivacyContract(), false);
  }
  assert.equal(await userInfoPlatform({ openPrivacyContract(options) { options.success({ errMsg: 'openPrivacyContract:ok' }); } }).openPrivacyContract(), true);
});
