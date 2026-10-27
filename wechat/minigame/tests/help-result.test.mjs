import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { sut, help, until, plain } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';
import { paginateHelp, readingLines } from '../src/help-ui.js';
import { TEXT } from '../src/i18n.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const noSpaces = text => text.replace(/\s/g, '');
const geometry = (app, width, height, top) => {
  const buttons = app.getButtons();
  for (const a of buttons) {
    assert.ok(a.x >= 0 && a.x + a.width <= width && a.y >= (a.id === 'account-avatar' ? top - 40 : top - 2) && a.y + a.height <= height - 24, `Outside safe area: ${a.id}`);
    for (const b of buttons) if (a.id !== b.id) assert.ok(
      a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y,
      `Overlapping actions: ${a.id}, ${b.id}`);
  }
};

test('mixed Chinese and Latin reader text keeps closing punctuation attached through word and long-token wrapping', () => {
  const ctx = { measureText: text => ({ width: [...text].length * 9 }) };
  for (const source of ['棋谱供 AI。三人 AI 用于三角形三人局，六边形 AI 用于六边形棋盘。',
    '棋谱 100）完整保存。', 'ABCDEFGHIJKLMN。接着阅读。', 'abcdefghijk!?继续。', '「ABCDEFGHIJKLMN」。规则']) {
    for (const width of [27, 45, 72, 126, 256]) {
      const lines = readingLines(ctx, source, width);
      assert.equal(noSpaces(lines.join('')), noSpaces(source), 'all original non-whitespace characters remain in order');
      for (const line of lines) {
        assert.ok(ctx.measureText(line).width <= width, `overflow: ${line}`);
        assert.ok(!/^[,.!?;:)\]}，。！？；：、）》」』】”’）…]/u.test(line), `closing punctuation starts a line: ${line}`);
      }
    }
  }
});

test('reader carries every paragraph to measured pages; credits match Web source order in both languages', async () => {
  const ctx = { measureText: text => ({ width: [...text].length * 9 }) };
  for (const language of ['zh', 'en']) {
    for (const width of [256, 326, 366]) for (const kind of ['rules', 'controls', 'privacy', 'credits']) {
      const sections = help.helpDocument(kind, language, true);
      const pages = paginateHelp(ctx, sections, width, 163);
      assert.ok(pages.length > 0);
      for (const page of pages) {
        assert.ok(page.lines.length <= 7);
        page.lines.forEach(line => {
          assert.ok(ctx.measureText(line).width <= width);
          assert.ok(!/^[，。！？；：、）》」』】”’）]/u.test(line), `Closing punctuation at line start: ${line}`);
        });
      }
      for (const section of sections) assert.equal(noSpaces(pages.filter(p => p.id === section.id).flatMap(p => p.lines).join('')),
        noSpaces(section.paragraphs.join('')), `${language}/${kind}/${section.id}: no omitted text`);
    }
    const source = await fs.readFile(new URL(`../../../web/web前端/guide/Thanks${language === 'en' ? '.en' : ''}.md`, import.meta.url), 'utf8');
    assert.deepEqual(help.helpDocument('credits', language).map(section => section.sourceLine), source.trim().split(/\r?\n/).filter(Boolean));
  }
  const practice = help.helpDocument('rules', 'zh').filter(s => Number.isInteger(s.lesson));
  assert.deepEqual(practice.map(s => s.lesson).sort(), [0, 1, 2, 3, 4]);
  for (const section of practice) assert.ok(sut.TUTORIAL_LEVELS[section.lesson]);
});

test('help pauses local clock, preserves live game and lesson practice restores original with hint budget', async () => {
  const { app, p, tap, render } = uiHarness();
  try {
    await until(() => app.session.snapshot && !app.session.busy); await render();
    const settings = { ...sut.settingsFor(7), turnTimerEnabled: true, turnTimeLimitSeconds: 60 };
    await app.session.load(settings, [{ type: 'player_move', point: [1, 0] }],
      { mode: 'human', paused: true, progress: { remainingMs: 43000, hintsUsed: 2 } });
    app.session.resume(); await render();
    const hash = app.session.stateHash, actions = plain(app.session.actions), snapshot = plain(app.session.snapshot);
    await tap('cabin-guide'); await tap('guide-rules-essential');
    const remaining = app.session.clock.remaining();
    assert.ok(remaining <= 43000 && remaining > 40000); assert.equal(app.session.clock.running, false);
    await sleep(80); assert.equal(app.session.clock.remaining(), remaining);
    await tap('reader-next'); await tap('reader-prev');
    assert.deepEqual(app.session.actions, actions); assert.deepEqual(app.session.snapshot, snapshot); assert.equal(app.session.stateHash, hash);
    assert.equal(app.session.hintsUsed, 2);
    for (let page = 0; page < 20 && !app.getButtons().some(b => b.id === 'reader-practice'); page++) await tap('reader-next');
    await tap('reader-practice'); await until(() => app.session.tutorial && !app.session.busy);
    assert.equal(app.session.savedGame.stateHash, hash);
    await render();
    await tap('lesson-exit'); await until(() => !app.session.tutorial);
    assert.equal(app.getScene(), 'game'); assert.equal(app.session.paused, true);
    assert.equal(app.session.stateHash, hash); assert.deepEqual(app.session.actions, actions);
    assert.equal(app.session.clock.remaining(), remaining); assert.equal(app.session.hintsUsed, 2);
    assert.equal(new sut.SaveStore(p.storage).read().payload.session.actions.length, 1);
  } finally { app.dispose(); }
});

test('opening help cancels AI and preserves replay cursor; it does not silently resume on return or foreground', async () => {
  const { app, p, tap, render } = uiHarness();
  try {
    await until(() => app.session.snapshot && !app.session.busy); await render();
    await app.session.load(sut.settingsFor(5), [{ type: 'move', point: [1, 0] }], { mode: 'ai-white', paused: true });
    p.workerDelay = 60; app.session.resume(); await render();
    assert.equal(app.session.busy, true); const hash = app.session.stateHash;
    await tap('cabin-guide'); await tap('guide-rules-essential');
    await sleep(100); assert.equal(app.session.actions.length, 1); assert.equal(app.session.stateHash, hash);
    p.callbacks.hide(); p.callbacks.show(); assert.equal(app.session.paused, true);
    await tap('home');
    assert.equal(app.getScene(), 'game'); assert.equal(app.session.paused, true);
    p.workerDelay = 1; await app.session.replay(0); await render();
    await tap('cabin-guide'); await tap('guide-rules-essential');
    assert.equal(app.getButtons().some(b => b.id === 'reader-practice'), false);
    await tap('home');
    assert.equal(app.getScene(), 'game'); assert.equal(app.session.paused, true);
    assert.equal(app.session.replayIndex, 0); assert.equal(app.session.actions.length, 1); assert.equal(app.session.stateHash, hash);
  } finally { app.dispose(); }
});

test('stale delete confirmation cannot log in after leaving privacy, backgrounding or disposal', async () => {
  for (const leave of ['contents', 'home', 'hide', 'dispose']) {
    const { app, p, tap, render, scrollTo } = uiHarness({ config: { onlineEnabled: true, apiBase: 'https://test.invalid' } });
    let confirm, logins = 0;
    p.confirm = () => new Promise(resolve => { confirm = resolve; });
    p.login = async () => { logins++; throw Error('Unexpected login'); };
    try {
      await until(() => app.session.snapshot && !app.session.busy); await render();
      await tap('cabin-battle'); await scrollTo('account-privacy'); await tap('account-privacy'); await tap('delete-account');
      assert.ok(confirm);
      if (leave === 'contents') await tap('reader-back');
      if (leave === 'home') await tap('home');
      if (leave === 'hide') { p.callbacks.hide(); p.callbacks.show(); }
      if (leave === 'dispose') app.dispose();
      confirm(true); await sleep(20); assert.equal(logins, 0); assert.equal(app.online.deleting, false);
    } finally { app.dispose(); }
  }
});

test('result reads actual engine winner and discrete scores for ties, territory wins and multiplayer resignations', () => {
  const results = [];
  for (const count of [2, 3]) {
    const engine = sut.restoreGame(sut.settingsFor(6, count));
    assert.equal(help.summarizeResult(engine.getSnapshot()), null);
    while (!engine.gameOver) engine.skipTurn();
    results.push([engine.getSnapshot(), 'DRAW', 'territory']);
  }
  const level = sut.TUTORIAL_LEVELS[1];
  const grown = [...level.prefix, level.objective];
  for (const count of [2, 3]) {
    const engine = sut.restoreGame(sut.settingsFor(6, count));
    assert.equal(engine.playMove([3, 0]).success, true);
    while (engine.currentPlayer !== 'BLACK') engine.skipTurn();
    assert.equal(engine.playMove([0, 3]).success, true);
    assert.ok(engine.getSnapshot().territories.BLACK.area > 0);
    if (count === 3) { engine.resignPlayer('BLACK'); assert.equal(engine.gameOver, false); }
    while (!engine.gameOver) engine.skipTurn();
    results.push([engine.getSnapshot(), count === 2 ? 'BLACK' : 'DRAW', 'territory']);
  }
  const resigned = sut.restoreGame(sut.settingsFor(6), grown);
  resigned.resignPlayer('BLACK');
  results.push([resigned.getSnapshot(), 'WHITE', 'resignation']);
  const three = sut.restoreGame(sut.settingsFor(6, 3));
  three.resignPlayer('WHITE'); assert.equal(three.gameOver, false);
  three.resignPlayer('BLACK'); results.push([three.getSnapshot(), 'PURPLE', 'resignation']);
  for (const [snapshot, winner, reason] of results) {
    Object.values(snapshot.territories).forEach(t => { t.displayArea = 123456; });
    const result = help.summarizeResult(snapshot);
    assert.equal(result.winner, winner); assert.equal(result.reason, reason);
    result.rows.forEach(row => { assert.equal(row.area, snapshot.territories[row.player].area); assert.notEqual(row.area, 123456); });
    if (winner !== 'DRAW') assert.equal(result.rows.find(row => row.winner).resigned, false);
  }
});

test('help and result UI fit compact and large screens in both languages; save and replay preserve the finished game', async () => {
  for (const language of ['zh', 'en']) for (const [width, height, top] of [[320, 568, 64], [390, 844, 88], [430, 932, 88]]) {
    const { app, p, tap, render, scrollTo } = uiHarness({ width, height, top, language });
    try {
      await until(() => app.session.snapshot && !app.session.busy); await render();
      for (const kind of ['rules-essential', 'credits', 'privacy']) {
        await tap(kind === 'privacy' ? 'cabin-battle' : 'cabin-guide');
        const entry = kind === 'privacy' ? 'account-privacy' : `guide-${kind}`;
        await scrollTo(entry); await tap(entry); let pages = 0;
        while (true) {
          // Wait for the requested frame instead of relying on tap's brief delay
          // when this suite shares the process scheduler with other test files.
          await render();
          assert.equal(app.getScene(), 'reader', `${language}/${width}/${kind}`);
          geometry(app, width, height, top); assert.ok(++pages < 100);
          const nextPage = app.getButtons().find(b => b.id === 'reader-next');
          assert.ok(nextPage, `${language}/${width}/${kind}: rendered page navigation`);
          if (nextPage.disabled) break;
          await tap('reader-next');
        }
        assert.equal(app.getButtons().some(b => b.id === 'delete-account'), false);
        await tap('home');
      } assert.equal(app.getScene(), 'game'); assert.equal(app.session.paused, true);
      await app.session.load(sut.settingsFor(6, 3), [{ type: 'resign', player: 'WHITE' }, { type: 'resign', player: 'BLACK' }], { mode: 'human', paused: true });
      const hash = app.session.stateHash; await render(); await tap('result-detail'); geometry(app, width, height, top);
      await tap('result-save'); assert.equal(new sut.ReplayLibrary(p.storage).read().entries.length, 1);
      assert.ok(p.messages.includes(TEXT[language].replaySaved));
      await tap('result-replay'); await until(() => app.session.replayIndex === 0 && !app.session.busy);
      await render(); await tap('exit-replay'); await until(() => app.session.replayIndex === null);
      assert.equal(app.session.stateHash, hash); assert.equal(app.session.snapshot.winner, 'PURPLE');
      await render(); await tap('result-detail'); await tap('result-back');
      assert.equal(app.getScene(), 'game'); assert.equal(app.session.snapshot.winner, 'PURPLE');
    } finally { app.dispose(); }
  }
});
