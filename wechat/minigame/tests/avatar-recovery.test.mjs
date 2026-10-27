import test from 'node:test';
import assert from 'node:assert/strict';
import { until } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';

const origin = 'https://avatar-fixture.invalid';
const accountFor = (uid = 'a'.repeat(32), digest = 'b'.repeat(64)) => ({
  uid, displayName: 'Avatar player', avatarUrl: `/api/wechat/account/avatar/${uid}/${digest}`,
});
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };

function harness(loadImage, request) {
  const account = accountFor(), images = [], loads = [], requests = [];
  const h = uiHarness({ config: { onlineEnabled: true, apiBase: origin }, platformOverrides: {
    loadImage: url => { loads.push(url); return loadImage(url, loads.length); },
    request: options => {
      requests.push(options); assert.equal(options.url, `${origin}/api/wechat/account`);
      return request ? request(options) : Promise.resolve(account);
    },
  } });
  h.p.canvas.getContext('2d').drawImage = image => images.push(image);
  h.app.online.token = 'fixture-token'; h.app.online.expires = Date.now() + 60000;
  h.app.online.account = h.app.online.normalizeAccount(account);
  return Object.assign(h, { images, loads, requests });
}

async function ready(h) {
  await until(() => h.app.session.snapshot && !h.app.session.busy);
  await h.render(); await until(() => h.loads.length === 1);
  await h.tap('cabin-battle');
}

async function refresh(h) { await h.scrollTo('account'); await h.tap('account'); await h.render(); }

test('explicit account refresh recovers a failed same-URL avatar without redraw request loops', async () => {
  const image = { width: 256, height: 256 };
  const h = harness(async (_url, count) => {
    if (count === 1) throw new Error('AVATAR_LOAD_FAILED');
    return image;
  });
  try {
    await ready(h);
    for (let i = 0; i < 8; i++) await h.render();
    await h.tap('cabin-close'); await h.tap('cabin-battle');
    assert.equal(h.loads.length, 1); assert.equal(h.images.includes(image), false);
    await refresh(h); await until(() => h.images.includes(image));
    assert.equal(h.requests.length, 1); assert.equal(h.loads.length, 2);
    assert.equal(h.loads[0], h.loads[1]);
    await refresh(h); await h.render();
    assert.equal(h.requests.length, 2); assert.equal(h.loads.length, 2, 'a loaded avatar stays cached');
  } finally { h.app.dispose(); }
});

test('failed refresh cannot retry an image and each successful refresh permits only one failed retry', async () => {
  let refreshFails = true;
  const h = harness(async () => { throw new Error('AVATAR_LOAD_FAILED'); }, async () => {
    if (refreshFails) throw new Error('NETWORK_ERROR');
    return accountFor();
  });
  try {
    await ready(h); await refresh(h);
    assert.equal(h.requests.length, 1); assert.equal(h.loads.length, 1);
    refreshFails = false; await refresh(h);
    assert.equal(h.loads.length, 2);
    for (let i = 0; i < 8; i++) await h.render();
    assert.equal(h.loads.length, 2, 'the second failure must not retry on redraw');
    await refresh(h); assert.equal(h.loads.length, 3);
  } finally { h.app.dispose(); }
});

for (const outcome of ['resolve', 'reject']) test(`avatar retry ${outcome} from a previous account cannot replace or invalidate the new avatar`, async () => {
  const old = deferred(), next = deferred();
  const oldImage = { width: 256, height: 256, owner: 'old' }, newImage = { width: 256, height: 256, owner: 'new' };
  const h = harness(async (_url, count) => {
    if (count === 1) throw new Error('AVATAR_LOAD_FAILED');
    return count === 2 ? old.promise : next.promise;
  });
  try {
    await ready(h); await refresh(h); await until(() => h.loads.length === 2);
    const account = accountFor('c'.repeat(32), 'd'.repeat(64));
    h.app.online.acceptIdentity({ token: 'second-fixture-token', protocol: 1, expiresIn: 3600, account });
    await h.render(); await until(() => h.loads.length === 3);
    next.resolve(newImage); await h.render(); await until(() => h.images.includes(newImage));
    old[outcome](outcome === 'resolve' ? oldImage : new Error('AVATAR_LOAD_FAILED'));
    await h.render(); await h.render();
    assert.equal(h.images.includes(oldImage), false); assert.equal(h.loads.length, 3);
    assert.equal(h.app.online.account.uid, account.uid);
  } finally { h.app.dispose(); }
});

test('leaving the account cabin before refresh completes cannot start a stale avatar retry', async () => {
  const response = deferred();
  const h = harness(async () => { throw new Error('AVATAR_LOAD_FAILED'); }, () => response.promise);
  try {
    await ready(h); await refresh(h); assert.equal(h.requests.length, 1);
    await h.tap('cabin-guide'); response.resolve(accountFor());
    await h.render(); await h.render();
    assert.equal(h.loads.length, 1);
    await h.tap('cabin-battle'); await h.render();
    assert.equal(h.loads.length, 1);
  } finally { h.app.dispose(); }
});
