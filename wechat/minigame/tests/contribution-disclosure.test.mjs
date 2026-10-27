import test from 'node:test';
import assert from 'node:assert/strict';
import { until, memoryStorage, help } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';

const contributionKey = 'lifeline-wx-training-contribution-v1';

for (const language of ['zh', 'en']) test(`${language}: V3 exclusion is clear and online consent remains separate`, async () => {
  const storage = memoryStorage(), prompts = [];
  storage.set('lifeline-wx-preferences-v1', JSON.stringify({ size: 5, mode: 'human', difficulty: 'normal' }));
  let logins = 0, contributions = 0;
  const account = { uid: 'a'.repeat(32), provider: 'wechat', displayName: 'Fixture', linkedWeb: false };
  const h = uiHarness({ language, storage, config: { onlineEnabled: true, apiBase: 'https://consent-fixture.invalid' }, platformOverrides: {
    confirm: async text => { prompts.push(text); return true; },
    login: async () => { logins++; return 'fixture-login-code'; },
    request: async request => {
      if (request.url.endsWith('/login')) return { protocol: 1, token: 'fixture-token', expiresIn: 3600, account };
      if (request.url.endsWith('/account')) return { account };
      throw new Error('Unexpected authenticated request');
    },
    contributionRequest: () => { contributions++; throw new Error('No contribution should start before a new complete game'); },
  } });
  const enabled = () => JSON.parse(storage.get(contributionKey) || '{"enabled":false}').enabled;
  try {
    await until(() => h.app.session.snapshot && !h.app.session.busy);
    await h.tap('cabin-battle'); await h.scrollTo('account'); await h.tap('account');
    await until(() => logins === 1);
    assert.equal(enabled(), false, 'Accepting online disclosure does not grant replay contribution');
    assert.match(prompts[0], language === 'en' ? /separate, optional opt-in/ : /需要另外主动开启/);
    await h.tap('cabin-board'); await h.scrollTo('training-contribution');
    const toggle = h.app.getButtons().find(button => button.id === 'training-contribution');
    assert.equal(toggle.disabled, true, 'the default V3 game cannot start a V2-only contribution opt-in');
    assert.equal(prompts.length, 1, 'no misleading contribution consent prompt is shown');
    assert.equal(enabled(), false);
    const privacy = help.helpDocument('privacy', language, true).flatMap(section => section.paragraphs).join(' ');
    assert.match(privacy, language === 'en' ? /territory-v2 games only/ : /仅接受 territory-v2 对局/);
    assert.match(privacy, language === 'en' ? /territory-v3 games are not uploaded/ : /territory-v3 新局不会上传/);
    assert.equal(logins, 1); assert.equal(contributions, 0);
    if (language === 'en') assert.doesNotMatch(privacy, /[\u3400-\u9fff]/);
  } finally { h.app.dispose(); }
});
