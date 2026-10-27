import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  ensureOnlineConsent, ONLINE_CONSENT_KEY, LEGACY_ONLINE_CONSENT_KEY, ONLINE_CONSENT_VERSION,
} from '../src/online-consent.js';
import { OnlineClient } from '../src/online.js';
import { memoryStorage, until } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';

// Exercise the actual account/friend buttons and deletion client. Only platform
// dialogs, storage and transport are fixtures; this is not real WeChat consent.
const origin = 'https://consent-fixture.invalid';
const config = () => ({ onlineEnabled: true, apiBase: origin });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const settle = async () => {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
};
const acceptedRecord = overrides => JSON.stringify({
  schema: 1, version: ONLINE_CONSENT_VERSION, origin, acceptedAt: Date.now() - 1000, ...overrides,
});
function consentFixture({ storage = memoryStorage(), apiBase = origin, enabled = true, answer = true } = {}) {
  const prompts = [];
  return {
    storage, prompts,
    options: {
      online: { enabled, config: { onlineEnabled: enabled, apiBase } },
      platform: { storage, confirm: async text => { prompts.push(text); return answer; } },
    },
  };
}
function appFixture({ storage = memoryStorage(), answer = true } = {}) {
  const calls = { login: 0, requests: [], prompts: [] };
  const account = { uid: 'a'.repeat(32), provider: 'wechat', displayName: 'Fixture', linkedWeb: false };
  const h = uiHarness({ storage, config: config(), platformOverrides: {
    login: async () => { calls.login++; return 'fixture-login-code'; },
    request: async request => {
      calls.requests.push(request);
      if (request.url.endsWith('/login')) return { protocol: 1, token: 'fixture-token', expiresIn: 3600, account };
      if (request.url.endsWith('/account')) return { account };
      throw new Error(`Unexpected fixture request: ${request.url}`);
    },
    confirm: async text => { calls.prompts.push(text); return answer; },
    choose: async () => { throw new Error('Direct friend entry must not open an action sheet'); },
    input: async () => null,
  } });
  return { ...h, calls, storage };
}
async function openEntry(h, entry) {
  await until(() => h.app.session.snapshot && !h.app.session.busy);
  if (h.app.getCabin() !== 'battle') await h.tap('cabin-battle');
  const id = entry === 'account' ? 'account' : 'join-room';
  await h.scrollTo(id); await h.tap(id);
  await settle();
}

test('disabled or already obsolete consent requests do not prompt or store acceptance', async () => {
  for (const kind of ['disabled', 'obsolete']) {
    const f = consentFixture({ enabled: kind !== 'disabled' });
    assert.equal(await ensureOnlineConsent({ ...f.options, isCurrent: () => kind !== 'obsolete' }), false);
    assert.equal(f.prompts.length, 0);
    assert.equal(f.storage.get(ONLINE_CONSENT_KEY), undefined);
  }
});

test('consent rejects non-HTTPS, malformed and credential-bearing service addresses before a prompt', async () => {
  for (const apiBase of ['', 'not a URL', 'http://consent-fixture.invalid', 'https://user:password@consent-fixture.invalid']) {
    const f = consentFixture({ apiBase });
    await assert.rejects(ensureOnlineConsent(f.options), /ONLINE_NOT_CONFIGURED/);
    assert.equal(f.prompts.length, 0, apiBase);
    assert.equal(f.storage.get(ONLINE_CONSENT_KEY), undefined);
  }
});

test('cancelling either real account or friend entry never calls login or the service', async () => {
  for (const entry of ['account', 'friends']) {
    const h = appFixture({ answer: false });
    try {
      await openEntry(h, entry);
      assert.equal(h.calls.prompts.length, 1, entry);
      assert.equal(h.calls.login, 0, entry);
      assert.deepEqual(h.calls.requests, [], entry);
      assert.equal(h.storage.get(ONLINE_CONSENT_KEY), undefined, entry);
    } finally { h.app.dispose(); }
  }
});

test('legacy unscoped yes does not skip the new prompt at either real entry', async () => {
  for (const entry of ['account', 'friends']) {
    const storage = memoryStorage();
    storage.set(LEGACY_ONLINE_CONSENT_KEY, 'yes');
    const h = appFixture({ storage, answer: false });
    try {
      await openEntry(h, entry);
      assert.equal(h.calls.prompts.length, 1, entry);
      assert.equal(h.calls.login, 0, entry);
      assert.deepEqual(h.calls.requests, [], entry);
      assert.equal(storage.get(ONLINE_CONSENT_KEY), undefined, entry);
    } finally { h.app.dispose(); }
  }
});

test('account and friend entries reuse the same scoped acceptance in both directions', async () => {
  for (const order of [['account', 'friends'], ['friends', 'account']]) {
    const h = appFixture();
    try {
      await openEntry(h, order[0]);
      if (order[0] === 'account') await until(() => h.calls.requests.some(r => r.url.endsWith('/account')));
      assert.equal(h.calls.prompts.length, 1, order.join(' → '));
      const first = h.storage.get(ONLINE_CONSENT_KEY);
      assert.equal(JSON.parse(first).origin, origin);
      await openEntry(h, order[1]);
      await until(() => h.calls.requests.some(r => r.url.endsWith('/account')));
      assert.equal(h.calls.prompts.length, 1, order.join(' → '));
      assert.equal(h.storage.get(ONLINE_CONSENT_KEY), first);
      assert.equal(h.calls.login, 1);
    } finally { h.app.dispose(); }
  }
});

test('an explicit grant stores the disclosure version and normalized HTTPS origin only', async () => {
  const f = consentFixture({ apiBase: 'https://CONSENT-FIXTURE.invalid:443/' });
  const before = Date.now();
  assert.equal(await ensureOnlineConsent(f.options), true);
  const record = JSON.parse(f.storage.get(ONLINE_CONSENT_KEY));
  assert.deepEqual(Object.keys(record).sort(), ['acceptedAt', 'origin', 'schema', 'version']);
  assert.equal(record.schema, 1);
  assert.equal(record.version, ONLINE_CONSENT_VERSION);
  assert.equal(record.origin, origin);
  assert.ok(Number.isSafeInteger(record.acceptedAt) && record.acceptedAt >= before && record.acceptedAt <= Date.now());
  f.options.online.config.apiBase = origin;
  assert.equal(await ensureOnlineConsent(f.options), true);
  assert.equal(f.prompts.length, 1, 'case, trailing slash and default TLS port must not create a new origin');
});

test('changing the service origin or disclosure version requires another affirmative answer', async () => {
  for (const overrides of [{ origin: 'https://other-fixture.invalid' }, { version: 'previous-disclosure' }]) {
    const storage = memoryStorage();
    storage.set(ONLINE_CONSENT_KEY, acceptedRecord(overrides));
    const original = storage.get(ONLINE_CONSENT_KEY);
    const f = consentFixture({ storage, answer: false });
    assert.equal(await ensureOnlineConsent(f.options), false);
    assert.equal(f.prompts.length, 1);
    assert.equal(storage.get(ONLINE_CONSENT_KEY), original, 'a refusal cannot install a fresh acceptance');
  }
});

test('a consent dialog that becomes obsolete before resolving cannot store acceptance', async () => {
  const gate = deferred(), f = consentFixture();
  let current = true;
  f.options.platform.confirm = () => gate.promise;
  const pending = ensureOnlineConsent({ ...f.options, isCurrent: () => current });
  current = false;
  gate.resolve(true);
  assert.equal(await pending, false);
  assert.equal(f.storage.get(ONLINE_CONSENT_KEY), undefined);
});

test('late account and friend dialogs stay obsolete after hide/show, navigation, closing the cabin or disposal', async () => {
  for (const entry of ['account', 'friends']) for (const boundary of ['hide-show', 'navigation', 'close-cabin', 'dispose']) {
    const gate = deferred(), h = appFixture();
    let prompted = false;
    h.p.confirm = () => { prompted = true; return gate.promise; };
    try {
      await openEntry(h, entry);
      await until(() => prompted);
      if (boundary === 'hide-show') { h.p.callbacks.hide(); h.p.callbacks.show(); }
      else if (boundary === 'navigation') await h.tap('cabin-guide');
      else if (boundary === 'close-cabin') await h.tap('cabin-close');
      else h.app.dispose();
      gate.resolve(true);
      await settle();
      assert.equal(h.storage.get(ONLINE_CONSENT_KEY), undefined, `${entry}/${boundary}`);
      assert.equal(h.calls.login, 0, `${entry}/${boundary}`);
      assert.deepEqual(h.calls.requests, [], `${entry}/${boundary}`);
    } finally { h.app.dispose(); }
  }
});

test('malformed, oversized, unsupported and impossible-time records are never accepted silently', async () => {
  const values = [
    '{', 'yes', 'null', [], {},
    acceptedRecord({ schema: 2 }), acceptedRecord({ acceptedAt: null }),
    acceptedRecord({ acceptedAt: -1 }), acceptedRecord({ acceptedAt: 0 }),
    acceptedRecord({ acceptedAt: 1.5 }), acceptedRecord({ acceptedAt: Date.now() + 3600000 }),
    acceptedRecord({ padding: 'x'.repeat(1024) }),
  ];
  for (const value of values) {
    const storage = memoryStorage();
    storage.set(ONLINE_CONSENT_KEY, value);
    const f = consentFixture({ storage, answer: false });
    assert.equal(await ensureOnlineConsent(f.options), false);
    assert.equal(f.prompts.length, 1);
  }
});

test('unreadable consent storage asks again instead of treating an I/O error as approval', async () => {
  const f = consentFixture({ answer: false });
  f.options.platform.storage = { get() { throw new Error('fixture-read-failure'); }, set() { throw new Error('Unexpected write'); } };
  assert.equal(await ensureOnlineConsent(f.options), false);
  assert.equal(await ensureOnlineConsent(f.options), false);
  assert.equal(f.prompts.length, 2);
});

test('throwing or silently dropped acceptance writes permit only the explicit current grant and re-prompt next time', async () => {
  for (const mode of ['throw', 'drop']) {
    const saved = memoryStorage(), f = consentFixture({ storage: saved });
    f.options.platform.storage = {
      get: key => saved.get(key),
      set() { if (mode === 'throw') throw new Error('fixture-write-failure'); },
    };
    assert.equal(await ensureOnlineConsent(f.options), true, mode);
    assert.equal(saved.get(ONLINE_CONSENT_KEY), undefined, mode);
    f.options.platform.confirm = async text => { f.prompts.push(text); return false; };
    assert.equal(await ensureOnlineConsent(f.options), false, mode);
    assert.equal(f.prompts.length, 2, mode);
  }
});

test('successful account deletion clears both consent generations and leaves local saves intact', async () => {
  const storage = memoryStorage(), localKey = 'lifeline-wechat-session-v1-0';
  storage.set(ONLINE_CONSENT_KEY, acceptedRecord());
  storage.set(LEGACY_ONLINE_CONSENT_KEY, 'yes');
  storage.set(localKey, 'fixture-local-save');
  let loginCalls = 0;
  const client = new OnlineClient({
    storage, login: async () => { loginCalls++; return 'fixture-delete-code'; },
    request: async request => {
      assert.ok(request.url.endsWith('/account/delete'));
      return { protocol: 1, deleted: true };
    },
  }, config(), { cancel() {} });
  client.acceptIdentity({ protocol: 1, token: 'fixture-token', expiresIn: 3600, account: { uid: 'a'.repeat(32) } });
  try {
    assert.equal(await client.deleteAccount(), true);
    assert.equal(client.error, null);
    assert.ok(!storage.get(ONLINE_CONSENT_KEY));
    assert.ok(!storage.get(LEGACY_ONLINE_CONSENT_KEY));
    assert.equal(storage.get(localKey), 'fixture-local-save');
    assert.equal(loginCalls, 1, 'deletion keeps its own fresh identity verification');
    const f = consentFixture({ storage, answer: false });
    assert.equal(await ensureOnlineConsent(f.options), false);
    assert.equal(f.prompts.length, 1, 'deletion must not leave reusable consent for the next identity');
  } finally { client.detach(); }
});

test('deletion reports failed consent cleanup and still attempts to clear the other generation', async () => {
  for (const mode of ['throw', 'drop']) for (const failedKey of [ONLINE_CONSENT_KEY, LEGACY_ONLINE_CONSENT_KEY]) {
    const saved = memoryStorage();
    saved.set(ONLINE_CONSENT_KEY, acceptedRecord());
    saved.set(LEGACY_ONLINE_CONSENT_KEY, 'yes');
    const attempted = [];
    const client = new OnlineClient({
      storage: {
        get: key => saved.get(key),
        set: (key, value) => {
          attempted.push(key);
          if (key === failedKey) {
            if (mode === 'throw') throw new Error('fixture-cleanup-failure');
            return;
          }
          saved.set(key, value);
        },
      },
      login: async () => 'fixture-delete-code',
      request: async () => ({ protocol: 1, deleted: true }),
    }, config(), { cancel() {} });
    client.acceptIdentity({ protocol: 1, token: 'fixture-token', expiresIn: 3600, account: { uid: 'a'.repeat(32) } });
    try {
      assert.equal(await client.deleteAccount(), true);
      assert.equal(client.error, 'DELETE_LOCAL_CLEANUP', `${mode}/${failedKey}`);
      assert.ok(attempted.includes(ONLINE_CONSENT_KEY));
      assert.ok(attempted.includes(LEGACY_ONLINE_CONSENT_KEY));
      const otherKey = failedKey === ONLINE_CONSENT_KEY ? LEGACY_ONLINE_CONSENT_KEY : ONLINE_CONSENT_KEY;
      assert.ok(!saved.get(otherKey), `${mode}/${failedKey}`);
    } finally { client.detach(); }
  }
});

test('changing the origin or disabling online mode while the prompt waits cannot store a late grant', async () => {
  for (const change of ['origin', 'disabled']) {
    const gate = deferred(), f = consentFixture();
    f.options.platform.confirm = () => gate.promise;
    const pending = ensureOnlineConsent(f.options);
    if (change === 'origin') f.options.online.config.apiBase = 'https://other-fixture.invalid';
    else f.options.online.enabled = false;
    gate.resolve(true);
    assert.equal(await pending, false, change);
    assert.equal(f.storage.get(ONLINE_CONSENT_KEY), undefined, change);
  }
});

test('consent works in a standard-JavaScript VM without URL, DOM or Node globals', async () => {
  const source = await readFile(new URL('../src/online-consent.js', import.meta.url), 'utf8');
  const context = vm.createContext({});
  // This fixture removes ESM export declarations only; helper code is unchanged.
  // Platform storage/dialog callbacks are injected just as in a Mini Game.
  const native = vm.runInContext(`${source.replace(/^export\s+/gm, '')}
    ({ ensureOnlineConsent, ONLINE_CONSENT_KEY, ONLINE_CONSENT_VERSION })`, context);
  for (const globalName of ['URL', 'window', 'document', 'fetch', 'TextEncoder', 'process', 'require']) {
    assert.equal(vm.runInContext(`typeof ${globalName}`, context), 'undefined', globalName);
  }
  const f = consentFixture({ apiBase: 'https://CONSENT-FIXTURE.invalid:443/' });
  assert.equal(await native.ensureOnlineConsent(f.options), true);
  const record = JSON.parse(f.storage.get(native.ONLINE_CONSENT_KEY));
  assert.equal(record.origin, origin);
  assert.equal(record.version, native.ONLINE_CONSENT_VERSION);
  assert.ok(Number.isSafeInteger(record.acceptedAt) && record.acceptedAt > 0);
  f.options.online.config.apiBase = origin;
  assert.equal(await native.ensureOnlineConsent(f.options), true);
  assert.equal(f.prompts.length, 1);
});

test('both language notices name the service and stored identity data without claiming anonymity', async () => {
  for (const language of ['zh', 'en']) {
    const f = consentFixture({ answer: false });
    assert.equal(await ensureOnlineConsent({ ...f.options, language }), false);
    const [message] = f.prompts;
    assert.ok(message.includes(origin), language);
    const identityStatement = message.split(language === 'zh' ? /[。！？]/ : /[.!?]/)
      .find(sentence => language === 'zh' ? /微信登录/.test(sentence) : /WeChat sign-in/i.test(sentence));
    assert.ok(identityStatement, language);
    assert.doesNotMatch(identityStatement, /匿名|anonym(?:ous|ized|ity)/i);
    assert.match(message, language === 'zh' ? /匿名棋谱贡献需要另外主动开启/ : /Anonymous replay contributions require a separate, optional opt-in/);
    assert.match(message, language === 'zh' ? /微信登录/ : /WeChat sign-in/i);
    assert.match(message, language === 'zh' ? /联机动作/ : /online moves/i);
    assert.match(message, language === 'zh' ? /账号名称/ : /account name/i);
    assert.match(message, language === 'zh' ? /可选择关联/ : /Linking.*optional/i);
  }
});

test('leaving the battle cabin invalidates direct room-code input after valid consent', async () => {
  for (const boundary of ['close', 'navigation', 'hide-show', 'dispose']) {
    const gate = deferred(), h = appFixture();
    let pending = false;
    h.p.input = () => { pending = true; return gate.promise; };
    try {
      await openEntry(h, 'friends');
      await until(() => pending);
      assert.ok(h.storage.get(ONLINE_CONSENT_KEY), 'the earlier foreground acceptance remains valid');
      if (boundary === 'close') await h.tap('cabin-close');
      if (boundary === 'navigation') await h.tap('cabin-guide');
      if (boundary === 'hide-show') { h.p.callbacks.hide(); h.p.callbacks.show(); }
      if (boundary === 'dispose') h.app.dispose();
      gate.resolve('ABCDEFGH');
      await settle();
      if (boundary === 'close') assert.equal(h.app.getCabin(), null, boundary);
      assert.notEqual(h.app.session, h.app.online.game, boundary);
      assert.equal(h.calls.login, 0, boundary);
      assert.deepEqual(h.calls.requests, [], boundary);
    } finally { h.app.dispose(); }
  }
});
