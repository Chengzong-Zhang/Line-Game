import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, memoryStorage, until } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';
import { avatarPlatform } from '../src/avatar-platform.js';

const uid = 'a'.repeat(32), otherUid = 'c'.repeat(32), origin = 'https://profile-local.invalid';
const localAvatar = 'data:image/jpeg;base64,AQID';
const rawAccount = (id = uid) => ({ uid: id, displayName: 'Before', avatarUrl: null });
const login = (account = rawAccount()) => ({ protocol: 1, token: 'fixture', expiresIn: 3600, account });
function client({ storage = memoryStorage(), apiBase = origin, request = async () => { throw Error('NETWORK_ERROR'); } } = {}) {
  const calls = [], platform = { storage, login: async () => 'code', request: options => { calls.push(options); return request(options); } };
  const online = new sut.OnlineClient(platform, { onlineEnabled: true, apiBase }, { cancel() {} });
  online.acceptIdentity(login()); return { online, platform, calls, storage };
}

test('offline photo/name edits are durable, merged and restored only for the same uid and service', async () => {
  const { online, storage } = client();
  await online.saveProfile({ avatarDataUrl: localAvatar }, { localFirst: true });
  await online.saveProfile({ displayName: '  本机棋手  ' }, { localFirst: true });
  assert.equal(online.account.displayName, '本机棋手');
  assert.equal(online.account.avatarUrl, localAvatar); assert.equal(online.account.profileSync, 'pending');
  const restored = client({ storage }).online;
  assert.equal(restored.account.avatarUrl, localAvatar); assert.equal(restored.account.displayName, '本机棋手');
  restored.acceptIdentity(login(rawAccount(otherUid)));
  assert.equal(restored.account.avatarUrl, null); assert.equal(restored.account.displayName, 'Before');
  assert.equal(client({ storage, apiBase: 'https://another-service.invalid' }).online.account.avatarUrl, null);
  assert.ok([...storage.map.values()].every(raw => !raw.includes('fixture')), 'no session token stored with profile drafts');
});

test('refresh retries the durable merged draft and only marks it synced after the cloud response', async () => {
  const { online, platform, storage } = client();
  await online.saveProfile({ displayName: 'Saved', avatarDataUrl: localAvatar }, { localFirst: true });
  const writes = [];
  platform.request = async options => {
    if (options.method === 'GET') return rawAccount();
    writes.push(options.data);
    return { uid, displayName: options.data.displayName, avatarUrl: `/api/wechat/account/avatar/${uid}/${'b'.repeat(64)}` };
  };
  await online.loadAccount();
  assert.deepEqual(writes, [{ displayName: 'Saved', avatarDataUrl: localAvatar }]);
  assert.equal(online.account.profileSync, 'synced'); assert.equal(online.localProfiles.read(uid), null);
  assert.ok(online.account.avatarUrl.startsWith(origin)); assert.ok([...storage.map.values()].every(raw => !raw));
});

for (const mode of ['throw', 'silent-drop']) test(`local storage ${mode} is never reported as saved or uploaded`, async () => {
  const { online, platform, calls } = client();
  platform.storage.set = () => { if (mode === 'throw') throw Error('quota exceeded'); };
  await assert.rejects(online.saveProfile({ displayName: 'Lost' }, { localFirst: true }), /PROFILE_LOCAL_SAVE_FAILED/);
  assert.equal(online.account.displayName, 'Before'); assert.equal(calls.length, 0);
});

test('an expired offline session still saves under its known identity without claiming cloud sync', async () => {
  const { online, platform } = client();
  online.expires = 0; platform.login = async () => { throw Error('LOGIN_FAILED'); };
  await online.saveProfile({ avatarDataUrl: localAvatar }, { localFirst: true });
  assert.equal(online.account.profileSync, 'pending'); assert.equal(online.localProfiles.read(uid).fields.avatarDataUrl, localAvatar);
});

test('a late local-first save cannot apply or upload the old identity draft to a new account', async () => {
  const { online, platform } = client(); let finish;
  platform.request = () => new Promise(resolve => { finish = resolve; });
  const pending = assert.rejects(online.saveProfile({ displayName: 'Old draft' }, { localFirst: true }), /CANCELLED/);
  await until(() => finish);
  online.acceptIdentity(login(rawAccount(otherUid))); finish({ uid, displayName: 'Old draft' }); await pending;
  assert.equal(online.account.uid, otherUid); assert.equal(online.account.displayName, 'Before');
  assert.equal(online.localProfiles.read(uid).fields.displayName, 'Old draft');
  assert.equal(online.localProfiles.read(otherUid), null);
});

test('successful account deletion clears that identity draft and keeps another account separate', async () => {
  const { online, platform } = client();
  online.localProfiles.write(otherUid, { displayName: 'Other draft' });
  await online.saveProfile({ displayName: 'Deleted draft' }, { localFirst: true });
  platform.request = async () => ({ protocol: 1, deleted: true });
  assert.equal(await online.deleteAccount(), true);
  assert.equal(online.localProfiles.read(uid), null); assert.equal(online.account, null);
  assert.equal(online.localProfiles.read(otherUid).fields.displayName, 'Other draft');
});

function avatarAPI(overrides = {}) {
  return {
    chooseImage: options => options.success({ tempFilePaths: ['wxfile://photo'] }),
    createImage: () => ({ width: 800, height: 600, set src(_) { queueMicrotask(() => this.onload()); } }),
    createOffscreenCanvas: () => ({ getContext: () => ({ fillRect() {}, drawImage() {} }),
      toDataURL: type => { assert.equal(type, 'image/jpeg'); return localAvatar; } }), ...overrides,
  };
}

test('unsupported chooseMedia falls back to chooseImage and native dataURL export needs no filesystem', async () => {
  let fallbacks = 0;
  const platform = avatarPlatform(avatarAPI({
    chooseMedia: options => options.fail({ errMsg: 'chooseMedia:fail not supported' }),
    chooseImage: options => { fallbacks++; options.success({ tempFilePaths: ['wxfile://photo'] }); },
  }));
  assert.equal((await platform.pickAvatar()).dataUrl, localAvatar); assert.equal(fallbacks, 1);
});

test('cancel or privacy refusal never launches a second photo picker', async () => {
  let fallback = 0;
  for (const [message, error] of [['chooseMedia:fail cancel', null], ['chooseMedia:fail privacy 112', /WECHAT_PRIVACY_REQUIRED/]]) {
    const platform = avatarPlatform(avatarAPI({ chooseMedia: options => options.fail({ errMsg: message }), chooseImage: () => { fallback++; } }));
    if (error) await assert.rejects(platform.pickAvatar(), error); else assert.equal(await platform.pickAvatar(), null);
  }
  assert.equal(fallback, 0);
});

for (const method of ['chooseMedia', 'chooseImage']) test(`a person may spend over two minutes in ${method} without losing the selection`, async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let picker, settled = false;
  const p = avatarPlatform(avatarAPI({ [method]: options => { picker = options; } }));
  const selected = p.pickAvatar().finally(() => { settled = true; });
  context.mock.timers.tick(121000);
  await Promise.resolve(); assert.equal(settled, false);
  picker.success({ tempFilePaths: ['wxfile://photo'] });
  assert.equal((await selected).dataUrl, localAvatar);
});

test('only fixed WeChat avatar hosts are decoded, with HTTP upgraded and no arbitrary remote requests', async () => {
  const images = [];
  const p = avatarPlatform(avatarAPI({ createImage: () => ({ width: 100, height: 100,
    set src(url) { images.push(url); queueMicrotask(() => this.onload()); } }) }));
  assert.equal((await p.importAvatar('http://thirdwx.qlogo.cn/mmopen/photo/132')).dataUrl, localAvatar);
  for (const url of ['https://attacker.invalid/pixel', 'https://wx.qlogo.cn.attacker.invalid/a', 'https://wx.qlogo.cn@attacker.invalid/a', 'wxfile://private']) {
    await assert.rejects(p.importAvatar(url), /INVALID_AVATAR/);
  }
  assert.deepEqual(images, ['https://thirdwx.qlogo.cn/mmopen/photo/132']);
});

test('saved local dataURL avatars decode from bounded temporary files and are cleaned up', async () => {
  const files = [], removed = [];
  const p = avatarPlatform({ env: { USER_DATA_PATH: 'wxfile://data' },
    getFileSystemManager: () => ({ writeFile: options => { files.push(options); options.success({}); },
      unlink: options => { removed.push(options.filePath); options.success({}); } }),
    createImage: () => ({ set src(_) { queueMicrotask(() => this.onload()); } }),
  });
  assert.ok(await p.loadImage(localAvatar)); assert.equal(files[0].data, 'AQID'); assert.equal(files[0].encoding, 'base64');
  assert.deepEqual(removed, [files[0].filePath]);
});

function profileHarness(overrides = {}) {
  const posts = [], controls = [];
  const h = uiHarness({ config: { onlineEnabled: true, apiBase: origin }, platformOverrides: {
    request: async options => { if (!options.data) return rawAccount(); posts.push(options.data); return { ...rawAccount(), ...options.data }; },
    createUserInfoControl: options => {
      const item = { options, destroyed: false, updates: [], update(value) { this.updates.push(value); }, destroy() { this.destroyed = true; } };
      controls.push(item); return item;
    }, loadImage: async () => ({ width: 256, height: 256 }), importAvatar: async () => ({ dataUrl: localAvatar }),
    ...overrides,
  } });
  h.app.online.acceptIdentity(login()); return Object.assign(h, { posts, controls });
}
async function ready(h, button = 'profile-avatar') {
  await until(() => h.app.session.snapshot && !h.app.session.busy); await h.tap('cabin-battle'); await h.scrollTo(button);
}

test('a chosen album photo survives the native hide/show lifecycle and saves with its original account', async () => {
  let select;
  const h = profileHarness({ pickAvatar: () => new Promise(resolve => { select = resolve; }) });
  try {
    await ready(h); await h.tap('profile-avatar'); await until(() => select);
    h.p.callbacks.hide(); h.p.callbacks.show({}); select({ dataUrl: localAvatar });
    await until(() => h.posts.length === 1); assert.deepEqual(h.posts, [{ avatarDataUrl: localAvatar }]);
  } finally { h.app.dispose(); }
});

test('a photo selected after navigating away and back is discarded rather than saved in the new account context', async () => {
  let select;
  const h = profileHarness({ pickAvatar: () => new Promise(resolve => { select = resolve; }) });
  try {
    await ready(h); await h.tap('profile-avatar'); await until(() => select);
    h.p.callbacks.hide(); h.p.callbacks.show({}); await h.tap('cabin-guide'); await h.tap('cabin-battle');
    select({ dataUrl: localAvatar }); await h.render(); await h.render(); assert.equal(h.posts.length, 0);
  } finally { h.app.dispose(); }
});

test('native WeChat import stays inside the visible account row and ignores callbacks after leaving or hiding', async () => {
  const h = profileHarness();
  try {
    await ready(h, 'profile-wechat'); await until(() => h.controls.length > 0);
    const first = h.controls.at(-1), target = h.app.getButtons().find(item => item.id === 'profile-wechat');
    assert.deepEqual(first.options.bounds, { x: target.x, y: target.y, width: target.width, height: target.height });
    await h.tap('cabin-guide'); assert.equal(first.destroyed, true);
    first.options.onResult({ displayName: 'Stale', avatarUrl: 'https://wx.qlogo.cn/mmopen/a/132' });
    await h.render(); assert.equal(h.posts.length, 0);
    await h.tap('cabin-battle'); await h.scrollTo('profile-wechat'); const second = h.controls.at(-1);
    h.p.callbacks.hide(); assert.equal(second.destroyed, true);
    second.options.onResult({ displayName: 'Hidden', avatarUrl: 'https://wx.qlogo.cn/mmopen/a/132' });
    await h.render(); assert.equal(h.posts.length, 0);
  } finally { h.app.dispose(); }
});

test('explicit native import saves only nickname and re-encoded image, never raw WeChat credentials', async () => {
  const h = profileHarness();
  try {
    await ready(h, 'profile-wechat'); const control = h.controls.at(-1);
    control.options.onResult({ displayName: '微信棋手', avatarUrl: 'https://wx.qlogo.cn/mmopen/a/132' });
    await until(() => h.posts.length === 1);
    assert.deepEqual(h.posts, [{ displayName: '微信棋手', avatarDataUrl: localAvatar }]);
  } finally { h.app.dispose(); }
});

test('failed WeChat avatar import preserves the existing picture while still saving its nickname', async () => {
  const h = profileHarness({ importAvatar: async () => { throw Error('AVATAR_LOAD_FAILED'); } });
  try {
    await ready(h, 'profile-wechat'); h.controls.at(-1).options.onResult({ displayName: '微信棋手', avatarUrl: 'https://wx.qlogo.cn/mmopen/a/132' });
    await until(() => h.posts.length === 1); await h.render();
    assert.deepEqual(h.posts, [{ displayName: '微信棋手' }]);
    await h.scrollTo('account'); assert.ok(h.texts.some(text => text.includes('头像暂未读到')));
  } finally { h.app.dispose(); }
});

test('first login reuses an already-authorized real WeChat profile without replacing a custom game profile', async () => {
  for (const fresh of [true, false]) {
    let reads = 0;
    const h = profileHarness({
      request: async options => {
        if (options.data) { h.posts.push(options.data); return { ...rawAccount(), ...options.data }; }
        return { ...rawAccount(), displayName: fresh ? '微信玩家' : 'Custom player' };
      },
      getAuthorizedUserInfo: async () => { reads++; return { displayName: 'WeChat player', avatarUrl: 'https://wx.qlogo.cn/mmopen/a/132' }; },
    });
    try {
      await ready(h, 'account'); await h.tap('account'); await until(() => h.app.online.account.displayName !== 'Before');
      await h.render();
      if (fresh) { await until(() => h.posts.length === 1); assert.equal(reads, 1); assert.equal(h.posts[0].displayName, 'WeChat player'); }
      else { assert.equal(reads, 0); assert.equal(h.posts.length, 0); assert.equal(h.app.online.account.displayName, 'Custom player'); }
    } finally { h.app.dispose(); }
  }
});

test('an unavailable native button is attempted once per account view and never creates a redraw/login loop', async () => {
  let attempts = 0;
  const h = profileHarness({ createUserInfoControl: options => {
    attempts++; options.onResult(null, Error('WECHAT_PROFILE_UNAVAILABLE')); return null;
  }, getAuthorizedUserInfo: async () => null });
  try {
    await ready(h, 'profile-wechat');
    for (let i = 0; i < 12; i++) await h.render();
    assert.equal(attempts, 1); assert.equal(h.posts.length, 0);
    await h.tap('profile-wechat'); await h.render();
    assert.equal(attempts, 1); assert.equal(h.posts.length, 0);
  } finally { h.app.dispose(); }
});

test('a cloud validation rejection leaves an explicitly local draft instead of falsely saying the photo was lost', async () => {
  const { online } = client({ request: async () => { throw Error('INVALID_AVATAR'); } });
  await online.saveProfile({ avatarDataUrl: localAvatar }, { localFirst: true });
  assert.equal(online.account.avatarUrl, localAvatar); assert.equal(online.account.profileSync, 'pending');
});

test('a present but broken offscreen exporter falls back to the secondary canvas', async () => {
  let secondary = 0;
  const p = avatarPlatform(avatarAPI({
    createOffscreenCanvas: () => ({ getContext: () => ({ fillRect() {}, drawImage() {} }), toDataURL() { throw Error('unsupported'); } }),
    createCanvas: () => { secondary++; return { getContext: () => ({ fillRect() {}, drawImage() {} }), toDataURL: () => localAvatar }; },
  }));
  assert.equal((await p.pickAvatar()).dataUrl, localAvatar); assert.equal(secondary, 1);
});
