import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { sut, help, until, plain, memoryStorage } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';
import { paginateHelp } from '../src/help-ui.js';

const ready = async h => { await until(() => h.app.session.snapshot && !h.app.session.busy); await h.render(); };
const allVisible = h => {
  const { width, height, bottom } = h.p.metrics(), buttons = h.app.getButtons();
  for (const b of buttons) assert.ok(b.x >= 0 && b.x + b.width <= width && b.y >= 0 && b.y + b.height <= height - bottom, b.id);
  for (let i = 0; i < buttons.length; i++) for (const b of buttons.slice(i + 1)) {
    const a = buttons[i]; assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, `${a.id}/${b.id}`);
  }
  assert.equal(h.texts.includes('undefined'), false);
};

test('four-cabin guide has no additional help page; credits preserve all Web contributor lines in readable groups', async () => {
  for (const language of ['zh', 'en']) {
    const h = uiHarness({ language, width: 320, height: 568, top: 64 });
    try {
      await ready(h); const hash = h.app.session.stateHash;
      await h.tap('cabin-guide'); assert.equal(h.app.getButtons().some(b => b.id === 'guide-contents'), false);
      await h.tap('guide-rules-essential'); assert.equal(h.app.getScene(), 'reader'); allVisible(h);
      await h.tap('reader-back'); assert.equal(h.app.getCabin(), 'guide');
      await h.scrollTo('guide-credits'); await h.tap('guide-credits'); allVisible(h);
      const groups = help.helpDocument('credits', language);
      const source = await fs.readFile(new URL(`../../../web/web前端/guide/Thanks${language === 'en' ? '.en' : ''}.md`, import.meta.url), 'utf8');
      assert.deepEqual(groups.map(s => s.sourceLine), source.trim().split(/\r?\n/).filter(Boolean));
      assert.ok(groups.length > 10); assert.ok(groups.every(s => s.title && s.paragraphs.length));
      const pages = paginateHelp({ measureText: value => ({ width: String(value).length * 9 }) }, groups, 256, 160, 17, 26);
      for (const group of groups) assert.equal(pages.filter(p => p.id === group.id).flatMap(p => p.lines).join('').replace(/\s/g, ''), group.paragraphs.join('').replace(/\s/g, ''));
      await h.tap('reader-back'); await h.tap('cabin-close'); assert.equal(h.app.session.stateHash, hash);
    } finally { h.app.dispose(); }
  }
});

test('replay suggestions, inspection and branch are visible without a secondary menu at compact and large sizes', async () => {
  for (const language of ['zh', 'en']) for (const [width, height, top] of [[320, 568, 64], [390, 844, 88]]) {
    const h = uiHarness({ language, width, height, top });
    try {
      await ready(h); await h.app.session.newGame(5, 'human'); await h.app.session.act({ type: 'move', point: [1, 0] });
      const hash = h.app.session.stateHash; await h.app.session.replay(1); await h.render(); allVisible(h);
      for (const name of ['analyzeReplay', 'inspectReplay', 'branchReplay']) assert.ok(h.app.getButtons().some(b => b.id === `replay-${name}`));
      await h.tap('replay-inspectReplay'); await until(() => h.p.messages.length > 0); assert.equal(h.app.session.stateHash, hash);
      await h.tap('replay-analyzeReplay'); await until(() => !h.app.session.busy); assert.equal(h.app.getScene(), 'analysis');
      await h.tap('analysis-back'); await h.tap('replay-branchReplay'); assert.equal(h.app.getScene(), 'branch'); allVisible(h);
      await h.tap('branch-back'); await h.tap('replay-options'); assert.equal(h.app.getButtons().some(b => b.id === 'tool-analyzeReplay'), false);
      await h.tap('tools-back'); await h.tap('exit-replay'); assert.equal(h.app.session.stateHash, hash);
    } finally { h.app.dispose(); }
  }
});

test('board cabin supports explicit shapes, custom starting-node selection, saved settings and a new playable game', async () => {
  const storage = memoryStorage(), h = uiHarness({ storage, width: 320, height: 568, top: 64 });
  try {
    await ready(h); const before = h.app.session.stateHash;
    await h.tap('cabin-board'); await h.slide('player-count', 4, 2, 6);
    await h.scrollTo('shape-triangle'); await h.tap('shape-triangle');
    await h.scrollTo('starts-custom'); await h.tap('starts-custom'); assert.equal(h.app.getScene(), 'starts'); allVisible(h);
    assert.equal(h.app.getLayout().boardShape, 'triangle');
    await h.tap('start-zoom'); await h.render();
    h.app.tap(...sut.toScreen([1, 0], h.app.getLayout())); await h.render();
    await h.tap('start-point-confirm'); await h.tap('starts-save');
    assert.equal(h.app.getCabin(), 'board'); assert.equal(h.app.session.stateHash, before);
    const saved = sut.readPreferences(storage); assert.equal(saved.boardShape, 'triangle'); assert.equal(saved.startingPointMode, 'custom');
    assert.deepEqual(plain(saved.initialPositions.BLACK), [1, 0]);
    await h.tap('cabin-close'); await h.tap('new-game'); await until(() => !h.app.session.busy); await h.render();
    assert.equal(h.app.session.settings.playerCount, 4); assert.equal(h.app.session.settings.boardShape, 'triangle');
    assert.deepEqual(plain(h.app.session.settings.initialPositions.BLACK), [1, 0]); assert.equal(h.app.session.canPlay(), true);
  } finally { h.app.dispose(); }
});

test('undo remains directly accessible while an AI reply is pending and persists the remaining quota', async () => {
  const h = uiHarness();
  try {
    await ready(h); await h.app.session.newGame(5, 'ai-white', 'normal', 2, { playOptions: { undoEnabled: true, undoMaxCount: 2 } });
    h.p.workerDelay = 150; await h.app.session.act({ type: 'move', point: [1, 0] }); await h.render();
    await until(() => h.app.session.undoAvailable); assert.ok(h.app.session.busy || h.app.session.actions.length >= 1);
    await h.tap('undo'); await until(() => !h.app.session.busy); await h.render();
    assert.equal(h.app.session.actions.length, 0); assert.equal(h.app.session.undoRemaining, 1);
    const stored = new sut.SaveStore(h.p.storage).read(); assert.equal(stored.payload.undoUsage.usedCount, 1);
  } finally { h.app.dispose(); }
});

test('inline profile editing persists only explicit valid input and discards stale picker completion', async () => {
  const h = uiHarness({ config: { onlineEnabled: true, apiBase: 'https://test.invalid' },
    platformOverrides: { input: async () => '新昵称', pickAvatar: async () => null } });
  const saved = []; h.app.online.account = { displayName: '原昵称', avatarUrl: '' };
  h.app.online.saveProfile = async data => { saved.push(plain(data)); h.app.online.account = { ...h.app.online.account, ...data }; };
  try {
    await ready(h); await h.tap('cabin-battle'); await h.scrollTo('profile-name'); await h.tap('profile-name');
    await until(() => saved.length === 1); await h.render(); assert.equal(h.app.getCabin(), 'battle'); assert.ok(h.texts.includes('新昵称'));
    await h.scrollTo('profile-avatar'); await h.tap('profile-avatar'); assert.equal(saved.length, 1);
    let resolve; h.p.pickAvatar = () => new Promise(done => { resolve = done; });
    await h.tap('profile-avatar'); await until(() => resolve); await h.tap('cabin-guide');
    resolve({ dataUrl: 'data:image/png;base64,AAAA', mimeType: 'image/png', bytes: 3 }); await new Promise(done => setTimeout(done, 20));
    assert.equal(saved.length, 1);
    await h.tap('cabin-battle'); h.p.input = async () => 'x'.repeat(25); await h.scrollTo('profile-name'); await h.tap('profile-name');
    assert.equal(saved.length, 1); assert.equal(h.app.online.account.displayName, '新昵称');
  } finally { h.app.dispose(); }
});
