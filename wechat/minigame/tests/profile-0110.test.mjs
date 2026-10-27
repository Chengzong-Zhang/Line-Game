import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, memoryStorage, until } from './helpers.mjs';
import { avatarPlatform } from '../src/avatar-platform.js';
const uid = 'a'.repeat(32), avatarPath = `/api/wechat/account/avatar/${uid}/${'b'.repeat(64)}`;
function client() {
  const calls = [], platform = { storage: memoryStorage(), login: async () => 'fixture', request: async options => {
    calls.push(options);
    if (options.url.endsWith('/login')) return { protocol: 1, token: 'fixture-token', expiresIn: 3600, account: { uid, displayName: 'Before' } };
    if (options.url.endsWith('/account/profile')) return { uid, displayName: options.data.displayName || 'Before', avatarUrl: avatarPath };
    return { uid, displayName: 'Before' };
  } };
  const online = new sut.OnlineClient(platform, { onlineEnabled: true, apiBase: 'https://profile-fixture.invalid' }, { cancel() {} });
  return { online, platform, calls };
}
test('profile saves trim Unicode names, use authenticated service and normalize only same-site avatar paths', async () => {
  const { online, calls } = client();
  await online.saveProfile({ displayName: '  小棋手😀  ' });
  assert.equal(online.account.displayName, '小棋手😀');
  assert.equal(online.account.avatarUrl, `https://profile-fixture.invalid${avatarPath}`);
  assert.equal(calls[1].header.Authorization, 'Bearer fixture-token');
  for (const url of ['https://third-party.invalid/pixel', '//third-party.invalid/avatar', '/api/wechat/account/avatar/../../secret']) {
    assert.equal(online.normalizeAccount({ uid, avatarUrl: url }).avatarUrl, null);
  }
});
test('invalid profile input never causes login or uploads', async () => {
  const { online, calls } = client();
  for (const data of [{}, { unexpected: 1 }, { displayName: ' ' }, { displayName: 'a\nb' }, { displayName: 'name\n' },
    { displayName: 'a\u2028b' }, { displayName: '\u2029name' }, { displayName: 'a\u200bb' },
    { displayName: 'a\u2066b' }, { displayName: 'a\ud800b' },
    { displayName: `a${String.fromCodePoint(0xe0001)}b` }, { displayName: 'a'.repeat(25) },
    { avatarDataUrl: 'https://arbitrary.invalid/a' }, { avatarDataUrl: 'data:text/html;base64,QQ==' }]) {
    await assert.rejects(online.saveProfile(data), /INVALID_/);
  }
  assert.equal(calls.length, 0);
});
test('late profile responses cannot overwrite another identity or a newer edit', async () => {
  const { online, platform } = client(); await online.authenticate();
  let resolve;
  platform.request = () => new Promise(done => { resolve = done; });
  const edit = online.saveProfile({ displayName: 'Late' });
  await until(() => Boolean(resolve));
  online.acceptIdentity({ protocol: 1, token: 'other', expiresIn: 3600, account: { uid: 'c'.repeat(32), displayName: 'Other' } });
  resolve({ uid, displayName: 'Late' }); await assert.rejects(edit, /CANCELLED/);
  assert.equal(online.account.displayName, 'Other');
});
test('network failure preserves the current account and choosing an avatar can be canceled', async () => {
  const { online, platform } = client(); await online.authenticate();
  platform.request = async () => { throw new Error('NETWORK_ERROR'); };
  await assert.rejects(online.saveProfile({ displayName: 'Draft' }), /NETWORK_ERROR/);
  assert.equal(online.account.displayName, 'Before');
  const p = avatarPlatform({ chooseMedia: options => options.fail({ errMsg: 'chooseMedia:fail cancel' }) });
  assert.equal(await p.pickAvatar(), null);
});

test('profile writes are serialized and account refresh waits for all queued edits', async () => {
  const { online, platform } = client(); await online.authenticate();
  let stored = { uid, displayName: 'Before' }; const writes = [], reads = [];
  platform.request = options => {
    if (options.url.endsWith('/account/profile')) return new Promise(resolve => {
      writes.push({ data: options.data, finish() { stored = { ...stored, ...options.data }; resolve(stored); } });
    });
    reads.push(options.url); return Promise.resolve({ ...stored });
  };
  const first = online.saveProfile({ displayName: 'First' });
  await until(() => writes.length === 1);
  const refresh = online.loadAccount(), second = online.saveProfile({ displayName: 'Second' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(writes.length, 1, 'later POST must wait so backend cannot commit edits in reverse order');
  assert.equal(reads.length, 0, 'refresh must not read the previous profile while a save is pending');
  writes[0].finish(); await first; await until(() => writes.length === 2);
  assert.equal(reads.length, 0, 'refresh also waits for the next edit queued during the first save');
  writes[1].finish(); await second; await refresh;
  assert.equal(stored.displayName, 'Second'); assert.equal(online.account.displayName, 'Second');
  assert.equal(reads.length, 1);
});

test('a failed edit does not block the next queued edit', async () => {
  const { online, platform } = client(); await online.authenticate();
  let rejectFirst; const names = [];
  platform.request = options => {
    names.push(options.data.displayName);
    if (names.length === 1) return new Promise((_, reject) => { rejectFirst = reject; });
    return Promise.resolve({ uid, displayName: options.data.displayName });
  };
  const first = assert.rejects(online.saveProfile({ displayName: 'Failed' }), /NETWORK_ERROR/);
  await until(() => rejectFirst);
  const second = online.saveProfile({ displayName: 'Retried' });
  rejectFirst(Error('NETWORK_ERROR')); await first; await second;
  assert.deepEqual(names, ['Failed', 'Retried']); assert.equal(online.account.displayName, 'Retried');
});

test('queued edits are canceled when the account changes before they can be sent', async () => {
  const { online, platform } = client(); await online.authenticate();
  let finish; const names = [];
  platform.request = options => {
    names.push(options.data.displayName); return new Promise(resolve => { finish = resolve; });
  };
  const first = assert.rejects(online.saveProfile({ displayName: 'First' }), /CANCELLED/);
  await until(() => finish);
  const second = assert.rejects(online.saveProfile({ displayName: 'Queued' }), /CANCELLED/);
  online.acceptIdentity({ protocol: 1, token: 'other', expiresIn: 3600, account: { uid: 'c'.repeat(32), displayName: 'Other' } });
  finish({ uid, displayName: 'First' }); await first; await second;
  assert.deepEqual(names, ['First']); assert.equal(online.account.displayName, 'Other');
});

test('expired profile authentication cannot retry an edit under a different account', async () => {
  const { online, platform } = client(); await online.authenticate();
  let posts = 0;
  platform.request = async options => {
    if (options.url.endsWith('/login')) return { protocol: 1, token: 'other', expiresIn: 3600,
      account: { uid: 'c'.repeat(32), displayName: 'Other' } };
    posts++; throw Error('UNAUTHORIZED');
  };
  await assert.rejects(online.saveProfile({ displayName: 'Old draft' }), /CANCELLED/);
  assert.equal(posts, 1); assert.equal(online.account.displayName, 'Other');
});
test('chosen image is square-cropped to 256px and only the re-encoded avatar is read/uploadable', async () => {
  const draws = [], reads = [], removed = [];
  const canvas = { getContext: () => ({ fillRect() {}, drawImage: (...args) => draws.push(args) }),
    toTempFilePath: options => { assert.equal(options.fileType, 'jpg'); options.success({ tempFilePath: 'wxfile://generated.jpg' }); } };
  const api = { chooseImage: options => options.success({ tempFiles: [{ path: 'wxfile://chosen.png', size: 900000 }] }),
    createImage: () => ({ width: 1200, height: 800, set src(value) { assert.equal(value, 'wxfile://chosen.png'); queueMicrotask(() => this.onload()); } }),
    createOffscreenCanvas: () => canvas,
    getFileSystemManager: () => ({ readFile: options => { reads.push(options.filePath); options.success({ data: 'AQID' }); },
      unlink: options => { removed.push(options.filePath); options.success({}); } }) };
  assert.deepEqual(await avatarPlatform(api).pickAvatar(), { dataUrl: 'data:image/jpeg;base64,AQID', mimeType: 'image/jpeg', bytes: 3 });
  assert.deepEqual(draws[0].slice(1), [200, 0, 800, 800, 0, 0, 256, 256]);
  assert.deepEqual(reads, ['wxfile://generated.jpg']); assert.deepEqual(removed, reads);
});

test('an offscreen canvas without a file exporter falls back to an exportable WeChat canvas', async () => {
  const draws = []; let fallbackCreated = 0;
  const api = { chooseMedia: options => options.success({ tempFiles: [{ tempFilePath: 'wxfile://chosen.png', size: 4000 }] }),
    createImage: () => ({ width: 800, height: 1200, set src(_) { queueMicrotask(() => this.onload()); } }),
    createOffscreenCanvas: () => ({ getContext() { throw Error('must choose the exportable canvas before drawing'); } }),
    createCanvas: () => { fallbackCreated++; return { getContext: () => ({ fillRect() {}, drawImage: (...args) => draws.push(args) }),
      toTempFilePath: options => options.success({ tempFilePath: 'wxfile://cropped.jpg' }) }; },
    getFileSystemManager: () => ({ readFile: options => options.success({ data: 'AQID' }), unlink: options => options.success({}) }) };
  assert.equal((await avatarPlatform(api).pickAvatar()).dataUrl, 'data:image/jpeg;base64,AQID');
  assert.equal(fallbackCreated, 1); assert.deepEqual(draws[0].slice(1), [0, 200, 800, 800, 0, 0, 256, 256]);
});
test('avatar display uses configured request transport and deletes the temporary image after decode', async () => {
  const files = [], removed = [];
  const p = avatarPlatform({ env: { USER_DATA_PATH: 'wxfile://local' },
    request: options => options.success({ statusCode: 200, data: new Uint8Array([1, 2, 3]).buffer }),
    getFileSystemManager: () => ({ writeFile: options => { files.push(options.filePath); options.success({}); },
      unlink: options => { removed.push(options.filePath); options.success({}); } }),
    createImage: () => ({ set src(value) { assert.equal(value, files[0]); queueMicrotask(() => this.onload()); } }) });
  assert.ok(await p.loadImage(`https://profile-fixture.invalid${avatarPath}`)); assert.deepEqual(removed, files);
  await assert.rejects(p.loadImage('https://third-party.invalid/pixel'), /INVALID_AVATAR/);
});
